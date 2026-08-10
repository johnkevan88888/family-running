import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const NETLIFY_SKIP_MARKER = /\[skip netlify\]/i;
const ACTIVE_WORK_PATH = 'docs/active-work.md';
const DATA_CSV_PATH = /^data\/(?:[^/]+\/)*[^/]+\.csv$/i;
const CUSTOM_DOMAIN_PATH = 'CNAME';
const CUSTOM_DOMAIN_ALLOWED_PATHS = new Set([
    '.github/pull_request_template.md',
    '.github/workflows/pr-preview-review-links.yml',
    'CNAME',
    'README.md',
    'analytics.js',
    'docs/decision-log.md',
    'docs/github-pr-checks-and-preview-deployments.md',
    'docs/testing-and-release-protocol.md',
    'scripts/validate-pr-release-path.mjs',
    'tests/analytics-config.mjs',
    'tests/pr-release-path.mjs'
]);
const DOMAIN_NAME = /^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function assessReleasePath({
    title,
    changedFiles,
    csvMetadata = new Map(),
    expectedDataCsvFiles = null,
    cnameContents = null
}) {
    if (!NETLIFY_SKIP_MARKER.test(title || '')) {
        return {
            pathway: 'full-preview',
            errors: []
        };
    }

    const normalizedFiles = [...new Set(changedFiles.map(normalizePath))].sort();
    if (normalizedFiles.includes(CUSTOM_DOMAIN_PATH)) {
        const errors = [];
        const disallowedFiles = normalizedFiles.filter(
            file => !CUSTOM_DOMAIN_ALLOWED_PATHS.has(file)
        );
        const domain = String(cnameContents || '').trim();

        if (!DOMAIN_NAME.test(domain)) {
            errors.push('CNAME must contain one valid hostname without a protocol or path.');
        }

        if (disallowedFiles.length > 0) {
            errors.push(
                `The custom-domain pathway cannot include these files: ${disallowedFiles.join(', ')}`
            );
        }

        return {
            pathway: 'custom-domain-configuration',
            errors
        };
    }

    const dataCsvFiles = normalizedFiles.filter(file => DATA_CSV_PATH.test(file));
    const disallowedFiles = normalizedFiles.filter(
        file => file !== ACTIVE_WORK_PATH && !DATA_CSV_PATH.test(file)
    );
    const errors = [];

    if (dataCsvFiles.length === 0) {
        errors.push('The lightweight pathway requires at least one changed CSV under data/.');
    }

    if (expectedDataCsvFiles) {
        const changedSet = new Set(dataCsvFiles);
        const missingBundleFiles = expectedDataCsvFiles
            .map(normalizePath)
            .filter(file => !changedSet.has(file))
            .sort();

        if (missingBundleFiles.length > 0) {
            errors.push(
                `The lightweight pathway requires a complete public CSV bundle; unchanged files: ${missingBundleFiles.join(', ')}`
            );
        }
    }

    if (disallowedFiles.length > 0) {
        errors.push(
            `The lightweight pathway cannot include these files: ${disallowedFiles.join(', ')}`
        );
    }

    for (const file of dataCsvFiles) {
        const metadata = csvMetadata.get(file);

        if (!metadata?.existsAtBase || !metadata?.existsAtHead) {
            errors.push(`${file} must already exist at both the base and head commits.`);
            continue;
        }

        if (metadata.baseHeader !== metadata.headHeader) {
            errors.push(`${file} changes its CSV header/schema.`);
        }
    }

    return {
        pathway: 'lightweight-data-refresh',
        errors
    };
}

export function hasNetlifySkipMarker(title) {
    return NETLIFY_SKIP_MARKER.test(title || '');
}

function normalizePath(file) {
    return String(file).replaceAll('\\', '/');
}

function readCsvMetadata(baseSha, headSha, files) {
    const csvFiles = files.filter(file => DATA_CSV_PATH.test(file));
    const addedFiles = diffFileSet(baseSha, headSha, 'A');
    const deletedFiles = diffFileSet(baseSha, headSha, 'D');
    const changedHeaders = findChangedCsvHeaders(baseSha, headSha, csvFiles);

    return new Map(csvFiles.map(file => [file, {
        existsAtBase: !addedFiles.has(file),
        existsAtHead: !deletedFiles.has(file),
        baseHeader: changedHeaders.has(file) ? 'base-header' : 'unchanged-header',
        headHeader: changedHeaders.has(file) ? 'head-header' : 'unchanged-header'
    }]));
}

function listDataCsvFiles(commitSha) {
    return execFileSync(
        'git',
        ['ls-tree', '-r', '--name-only', '-z', commitSha, '--', 'data'],
        { encoding: 'utf8' }
    )
        .split('\0')
        .filter(file => DATA_CSV_PATH.test(file))
        .map(normalizePath);
}

function diffFileSet(baseSha, headSha, filter) {
    return new Set(execFileSync(
        'git',
        [
            'diff',
            '--no-renames',
            `--diff-filter=${filter}`,
            '--name-only',
            '-z',
            `${baseSha}...${headSha}`
        ],
        { encoding: 'utf8' }
    )
        .split('\0')
        .filter(Boolean)
        .map(normalizePath));
}

function findChangedCsvHeaders(baseSha, headSha, files) {
    if (files.length === 0) {
        return new Set();
    }

    const diff = execFileSync(
        'git',
        [
            'diff',
            '--no-renames',
            '--unified=0',
            '--no-color',
            `${baseSha}...${headSha}`,
            '--',
            ...files
        ],
        {
            encoding: 'utf8',
            maxBuffer: 50 * 1024 * 1024
        }
    );
    return parseChangedCsvHeaders(diff);
}

export function parseChangedCsvHeaders(diff) {
    const changedHeaders = new Set();
    let currentFile = null;

    for (const line of diff.split(/\r?\n/)) {
        if (line.startsWith('+++ ')) {
            const file = normalizePath(line.slice(4));
            currentFile = file === '/dev/null'
                ? null
                : file.replace(/^b\//, '');
            continue;
        }

        const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (!currentFile || !hunk) {
            continue;
        }

        const oldStart = Number(hunk[1]);
        const oldCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
        const newStart = Number(hunk[3]);
        const newCount = hunk[4] === undefined ? 1 : Number(hunk[4]);
        const removesHeader = oldCount > 0 && oldStart === 1;
        const addsHeader = newCount > 0 && newStart === 1;

        if (removesHeader || addsHeader) {
            changedHeaders.add(currentFile);
        }
    }

    return changedHeaders;
}

function requireCommitSha(name, value) {
    if (!/^[0-9a-f]{40}$/i.test(value || '')) {
        console.error(`${name} must be a 40-character Git commit SHA.`);
        process.exit(1);
    }
}

function runCli() {
    const title = process.env.PR_TITLE || '';
    const baseSha = process.env.PR_BASE_SHA;
    const headSha = process.env.PR_HEAD_SHA;

    if (!hasNetlifySkipMarker(title)) {
        console.log('Release pathway: full Netlify Deploy Preview.');
        return;
    }

    requireCommitSha('PR_BASE_SHA', baseSha);
    requireCommitSha('PR_HEAD_SHA', headSha);

    const changedFiles = execFileSync(
        'git',
        ['diff', '--no-renames', '--name-only', '-z', `${baseSha}...${headSha}`],
        { encoding: 'utf8' }
    )
        .split('\0')
        .filter(Boolean)
        .map(normalizePath);
    const assessment = assessReleasePath({
        title,
        changedFiles,
        csvMetadata: readCsvMetadata(baseSha, headSha, changedFiles),
        expectedDataCsvFiles: listDataCsvFiles(headSha),
        cnameContents: changedFiles.includes(CUSTOM_DOMAIN_PATH)
            ? execFileSync('git', ['show', `${headSha}:${CUSTOM_DOMAIN_PATH}`], { encoding: 'utf8' })
            : null
    });

    if (assessment.errors.length > 0) {
        console.error(`The [skip netlify] ${assessment.pathway} pathway is not eligible:`);
        for (const error of assessment.errors) {
            console.error(`- ${error}`);
        }
        console.error('Remove [skip netlify] from the Pull Request title to use a full preview.');
        process.exit(1);
    }

    console.log(`Release pathway: validated ${assessment.pathway}; Netlify preview is intentionally skipped.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runCli();
}
