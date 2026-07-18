import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const stagingParent = path.join(
    repoRoot,
    'test-artifacts',
    'workbook-export-staging'
);

const validatorPath = path.join(repoRoot, 'scripts', 'validate-csv.mjs');

export function parseCliArguments(argv) {
    const options = new Map();

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];

        if (argument === '--') {
            continue;
        }
        if (!argument.startsWith('--')) {
            throw new Error(`Unexpected argument "${argument}".`);
        }

        const name = argument.slice(2);
        const next = argv[index + 1];

        if (next && !next.startsWith('--')) {
            options.set(name, next);
            index += 1;
        } else {
            options.set(name, true);
        }
    }

    return options;
}

export function normalizePnpmPathArgument(value) {
    if (
        process.platform !== 'win32' ||
        !process.env.npm_lifecycle_event ||
        typeof value !== 'string'
    ) {
        return value;
    }

    const unmatchedSeparators = value.replace(/\\\\/g, '');

    if (unmatchedSeparators.includes('\\')) {
        return value;
    }

    return value.replace(/\\\\/g, '\\');
}

export function resolveStagedRoot(value) {
    if (!value || value === true) {
        throw new Error('A staged export root is required via --staged <path>.');
    }

    const stagedRoot = resolveCanonicalAbsolutePath(
        String(value),
        'staged export root'
    );
    const trackedDataRoot = path.join(repoRoot, 'data');

    if (samePath(stagedRoot, repoRoot)) {
        throw new Error('The repository root cannot be used as a staged export root.');
    }
    if (sameOrDescendantPath(stagedRoot, trackedDataRoot)) {
        throw new Error(
            'Tracked data and its descendants cannot be used as staged export roots.'
        );
    }
    if (!samePath(path.dirname(stagedRoot), stagingParent)) {
        throw new Error(
            `Staged exports must be fresh immediate child folders of ${stagingParent}.`
        );
    }

    const dataRoot = path.join(stagedRoot, 'data');
    const manifestPath = path.join(dataRoot, 'export_manifest.csv');

    if (!fs.existsSync(dataRoot) || !fs.statSync(dataRoot).isDirectory()) {
        throw new Error(`Staged data directory is missing: ${dataRoot}`);
    }
    if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
        throw new Error(`Staged export manifest is missing: ${manifestPath}`);
    }

    return stagedRoot;
}

function resolveCanonicalAbsolutePath(value, description) {
    if (!value || value !== value.trim() || !path.isAbsolute(value)) {
        throw new Error(
            `The ${description} must be a nonblank absolute path without surrounding whitespace.`
        );
    }
    if (value.includes('\0')) {
        throw new Error(`The ${description} contains a control character.`);
    }
    if (
        process.platform === 'win32' &&
        (
            value.includes('/') ||
            /["<>|?*%~]/.test(value) ||
            value.slice(2).includes(':')
        )
    ) {
        throw new Error(
            `The ${description} contains invalid or ambiguous path characters.`
        );
    }

    const root = path.parse(value).root;
    const tail = value.slice(root.length);
    const segments = tail.split(path.sep);

    for (const [index, segment] of segments.entries()) {
        if (!segment) {
            if (index !== segments.length - 1) {
                throw new Error(
                    `The ${description} contains an empty path segment.`
                );
            }
        } else if (
            segment === '.' ||
            segment === '..' ||
            segment.endsWith('.') ||
            segment.endsWith(' ')
        ) {
            throw new Error(
                `The ${description} contains an ambiguous path segment.`
            );
        }
    }

    const resolved = path.resolve(value);
    const comparableInput = stripTrailingSeparators(value);
    const comparableResolved = stripTrailingSeparators(resolved);

    if (!samePath(comparableInput, comparableResolved)) {
        throw new Error(`The ${description} is not in canonical form.`);
    }

    return resolved;
}

function stripTrailingSeparators(value) {
    const root = path.parse(value).root;
    let stripped = value;

    while (stripped.length > root.length && stripped.endsWith(path.sep)) {
        stripped = stripped.slice(0, -1);
    }

    return stripped;
}

function samePath(left, right) {
    const leftValue = path.resolve(left);
    const rightValue = path.resolve(right);

    return process.platform === 'win32'
        ? leftValue.toLowerCase() === rightValue.toLowerCase()
        : leftValue === rightValue;
}

function sameOrDescendantPath(candidate, parent) {
    if (samePath(candidate, parent)) {
        return true;
    }

    const relative = path.relative(parent, candidate);
    return (
        relative !== '' &&
        !relative.startsWith('..') &&
        !path.isAbsolute(relative)
    );
}

export function runCsvValidator(validationRoot, options = {}) {
    const result = spawnSync(process.execPath, [validatorPath], {
        cwd: repoRoot,
        env: {
            ...process.env,
            CSV_VALIDATION_ROOT: validationRoot
        },
        encoding: 'utf8',
        stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe']
    });

    if (result.error) {
        throw result.error;
    }

    return result;
}

export function assertExactTrackedCsvSet(stagedRoot) {
    return assertTrackedCsvSet(stagedRoot);
}

export function assertTrackedCsvSet(stagedRoot, options = {}) {
    const stagedFiles = listPublicCsvFiles(path.join(stagedRoot, 'data'));
    const trackedFiles = listPublicCsvFiles(path.join(repoRoot, 'data'));
    const stagedSet = new Set(stagedFiles.map(toPosix));
    const trackedSet = new Set(trackedFiles.map(toPosix));
    const approvedNewFiles = new Set(
        (options.approvedNewFiles || []).map(normalizeApprovedNewCsvFile)
    );
    const missing = trackedFiles.filter(file => !stagedSet.has(toPosix(file)));
    const unexpected = stagedFiles.filter(file => !trackedSet.has(toPosix(file)));
    const unapprovedUnexpected = unexpected.filter(
        file => !approvedNewFiles.has(toPosix(file))
    );
    const approvedButNotNew = [...approvedNewFiles].filter(
        file => !unexpected.some(unexpectedFile => toPosix(unexpectedFile) === file)
    );

    if (missing.length || unapprovedUnexpected.length || approvedButNotNew.length) {
        const details = [
            ...missing.map(file => `missing staged file: data/${file}`),
            ...unapprovedUnexpected.map(file => `unexpected staged file: data/${file}`),
            ...approvedButNotNew.map(file => `approved new file is not staged as new: data/${file}`)
        ];
        throw new Error(
            `Staged public CSV set does not match the tracked contract:\n${details.join('\n')}`
        );
    }

    return stagedFiles;
}

function normalizeApprovedNewCsvFile(value) {
    let normalized = String(value || '').trim().replace(/\\/g, '/');

    if (normalized.startsWith('data/')) {
        normalized = normalized.slice('data/'.length);
    }

    const segments = normalized.split('/');
    const invalid =
        !normalized ||
        normalized.startsWith('/') ||
        normalized.includes('//') ||
        !normalized.toLowerCase().endsWith('.csv') ||
        segments.some(segment => !segment || segment === '.' || segment === '..');

    if (invalid) {
        throw new Error(`Approved new CSV path is invalid: "${value}".`);
    }

    return normalized;
}

export function compareBundles(stagedRoot, comparisonRoot = repoRoot) {
    const trackedDataRoot = path.join(comparisonRoot, 'data');
    const stagedDataRoot = path.join(stagedRoot, 'data');
    const trackedFiles = listPublicCsvFiles(trackedDataRoot);
    const stagedFiles = listPublicCsvFiles(stagedDataRoot);
    const allFiles = [...new Set([...trackedFiles, ...stagedFiles])].sort();
    const results = [];

    for (const relativePath of allFiles) {
        const trackedPath = path.join(trackedDataRoot, relativePath);
        const stagedPath = path.join(stagedDataRoot, relativePath);

        if (!fs.existsSync(trackedPath)) {
            results.push({
                relativePath: `data/${toPosix(relativePath)}`,
                status: 'added',
                trackedRows: null,
                stagedRows: countDataRows(stagedPath)
            });
            continue;
        }
        if (!fs.existsSync(stagedPath)) {
            results.push({
                relativePath: `data/${toPosix(relativePath)}`,
                status: 'missing',
                trackedRows: countDataRows(trackedPath),
                stagedRows: null
            });
            continue;
        }

        const trackedRows = normalizedRows(relativePath, trackedPath);
        const stagedRows = normalizedRows(relativePath, stagedPath);
        const trackedDataRows = Math.max(0, trackedRows.length - 1);
        const stagedDataRows = Math.max(0, stagedRows.length - 1);
        const firstDifference = firstDifferentRow(trackedRows, stagedRows);
        const same = firstDifference === null;
        const counts = multisetDifference(trackedRows.slice(1), stagedRows.slice(1));

        results.push({
            relativePath: `data/${toPosix(relativePath)}`,
            status: same ? 'unchanged' : 'changed',
            trackedRows: trackedDataRows,
            stagedRows: stagedDataRows,
            firstDifferentCsvRow: firstDifference,
            removedRows: counts.removed,
            addedRows: counts.added,
            orderOnly: !same && counts.removed === 0 && counts.added === 0
        });
    }

    return {
        stagedRoot,
        comparedWith: comparisonRoot,
        volatileMetadataIgnored: [
            'ExportBundleID in every public data CSV',
            'ExportBundleID and ExportedAtUTC in data/export_manifest.csv',
            'LastUpdatedUTC value in each siteinfo.csv'
        ],
        files: results,
        meaningfulDifferences: results.filter(result => result.status !== 'unchanged')
    };
}

export function listPublicCsvFiles(dataRoot) {
    const files = [];
    visit(dataRoot, '');
    return files.sort();

    function visit(directory, relativeDirectory) {
        if (!fs.existsSync(directory)) {
            return;
        }

        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const absolutePath = path.join(directory, entry.name);
            const relativePath = path.join(relativeDirectory, entry.name);

            if (entry.isDirectory()) {
                visit(absolutePath, relativePath);
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.csv')) {
                files.push(relativePath);
            }
        }
    }
}

export function formatComparisonLine(result) {
    const rowSummary = `tracked=${result.trackedRows ?? '-'}, staged=${result.stagedRows ?? '-'}`;

    if (result.status === 'unchanged') {
        return `UNCHANGED ${result.relativePath} (${rowSummary})`;
    }
    if (result.status === 'added' || result.status === 'missing') {
        return `${result.status.toUpperCase()} ${result.relativePath} (${rowSummary})`;
    }

    const changeSummary = result.orderOnly
        ? 'row ordering changed'
        : `removed=${result.removedRows}, added=${result.addedRows}`;

    return `CHANGED ${result.relativePath} (${rowSummary}; first CSV row=${result.firstDifferentCsvRow}; ${changeSummary})`;
}

function normalizedRows(relativePath, filePath) {
    const rows = parseCsv(fs.readFileSync(filePath, 'utf8'));

    if (relativePath.replace(/\\/g, '/') === 'export_manifest.csv') {
        return removeColumns(rows, ['ExportBundleID', 'ExportedAtUTC']);
    }

    const normalized = removeColumns(rows, ['ExportBundleID']);
    const pathKey = relativePath.replace(/\\/g, '/').toLowerCase();

    if (pathKey.endsWith('/siteinfo.csv') && normalized.length > 1) {
        const headers = normalized[0];
        const labelIndex = headers.indexOf('Label');
        const valueIndex = headers.indexOf('Value');

        if (labelIndex >= 0 && valueIndex >= 0) {
            for (const row of normalized.slice(1)) {
                if (row[labelIndex] === 'LastUpdatedUTC') {
                    row[valueIndex] = '<volatile LastUpdatedUTC>';
                }
            }
        }
    }

    return normalized;
}

function removeColumns(rows, columnNames) {
    if (rows.length === 0) {
        return [];
    }

    const removeIndexes = rows[0]
        .map((header, index) => columnNames.includes(header) ? index : -1)
        .filter(index => index >= 0)
        .sort((left, right) => right - left);

    return rows.map(row => {
        const copy = [...row];

        for (const index of removeIndexes) {
            copy.splice(index, 1);
        }

        return copy;
    });
}

function firstDifferentRow(leftRows, rightRows) {
    const rowCount = Math.max(leftRows.length, rightRows.length);

    for (let index = 0; index < rowCount; index += 1) {
        if (JSON.stringify(leftRows[index]) !== JSON.stringify(rightRows[index])) {
            return index + 1;
        }
    }

    return null;
}

function multisetDifference(leftRows, rightRows) {
    const left = countRows(leftRows);
    const right = countRows(rightRows);
    let removed = 0;
    let added = 0;

    for (const [row, count] of left) {
        removed += Math.max(0, count - (right.get(row) || 0));
    }
    for (const [row, count] of right) {
        added += Math.max(0, count - (left.get(row) || 0));
    }

    return { removed, added };
}

function countRows(rows) {
    const counts = new Map();

    for (const row of rows) {
        const key = JSON.stringify(row);
        counts.set(key, (counts.get(key) || 0) + 1);
    }

    return counts;
}

function countDataRows(filePath) {
    return Math.max(0, parseCsv(fs.readFileSync(filePath, 'utf8')).length - 1);
}

function parseCsv(text) {
    const rows = [];
    let row = [];
    let value = '';
    let insideQuotes = false;

    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        const next = text[index + 1];

        if (character === '"') {
            if (insideQuotes && next === '"') {
                value += '"';
                index += 1;
            } else {
                insideQuotes = !insideQuotes;
            }
        } else if (character === ',' && !insideQuotes) {
            row.push(value);
            value = '';
        } else if ((character === '\r' || character === '\n') && !insideQuotes) {
            row.push(value);
            rows.push(row);
            row = [];
            value = '';

            if (character === '\r' && next === '\n') {
                index += 1;
            }
        } else {
            value += character;
        }
    }

    if (insideQuotes) {
        throw new Error('CSV contains an unclosed quoted field.');
    }
    if (value.length || row.length) {
        row.push(value);
        rows.push(row);
    }

    return rows.filter((candidate, index) =>
        !(index === rows.length - 1 && candidate.length === 1 && candidate[0] === '')
    );
}

function toPosix(value) {
    return value.replace(/\\/g, '/');
}
