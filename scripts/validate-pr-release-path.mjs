import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { galleryAdminCatalogOutputRelativePath } from './build-gallery-admin-catalog.mjs';
import { isPublishedPath, isPublishingControlPath } from './published-site-entries.mjs';

const NETLIFY_SKIP_MARKER = /\[skip netlify\]/i;
const ACTIVE_WORK_PATH = 'docs/active-work.md';
const DATA_CSV_PATH = /^data\/(?:[^/]+\/)*[^/]+\.csv$/i;
const ROUTINE_DERIVED_DATA_PATHS = new Set([
    galleryAdminCatalogOutputRelativePath
]);
const CUSTOM_DOMAIN_PATH = 'CNAME';
const CUSTOM_DOMAIN_ALLOWED_PATHS = new Set([
    '.github/pull_request_template.md',
    'CNAME',
    'README.md',
    'analytics.js',
    'docs/decision-log.md',
    'docs/github-pr-checks-and-preview-deployments.md',
    'docs/testing-and-release-protocol.md',
    'tests/analytics-config.mjs',
    'tests/pr-release-path.mjs'
]);
const NO_VISUAL_SAFE_PATHS = new Set([
    '.github/pull_request_template.md',
    '.gitignore',
    'AGENTS.md',
    'README.md',
    'gallery-media-policy.js',
    'gallery-upload-contract.js',
    'preview-local.cmd',
    // These are current local validation, release, and workbook tools. Keep
    // this explicit: a future script is unclassified until its relationship to
    // the publication build has been reviewed.
    'scripts/browser-runtime.mjs',
    'scripts/build-gallery-admin-catalog.mjs',
    'scripts/compare-export-bundle.mjs',
    'scripts/export-bundle-validation.mjs',
    'scripts/pages-deployment-verification.mjs',
    'scripts/promote-staged-export.mjs',
    'scripts/reconcile-personal-bests.mjs',
    'scripts/run-all-tests.mjs',
    'scripts/run-workbook-staged-export.ps1',
    'scripts/serve-site.mjs',
    'scripts/simple-data-update.mjs',
    'scripts/sync-vendor.mjs',
    'scripts/validate-csv.mjs',
    'scripts/validate-gallery.mjs',
    'scripts/validate-repository-safety.mjs',
    'scripts/verify-production-data.mjs',
    'scripts/workbook-export-contract.json',
    'update-website-data.cmd'
]);
const NO_VISUAL_SAFE_PREFIXES = [
    'docs/',
    'gallery-admin/',
    'tests/'
];
const DOMAIN_NAME = /^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
// The one approved production hostname. The custom-domain pathway lets a change
// skip the Netlify preview, so a syntax check alone would let a Pull Request
// point the site at any valid hostname and self-approve that route. A genuine
// domain migration should change this constant, its tests, the documentation,
// and the DNS plan together, through the standard preview pathway. Audit
// finding P2-02.
const CUSTOM_DOMAIN_CANONICAL_HOST = 'www.aceofrace.com';

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
        } else if (domain.toLowerCase() !== CUSTOM_DOMAIN_CANONICAL_HOST) {
            // Hostnames are case-insensitive, so only a genuinely different host
            // is rejected here.
            errors.push(
                `CNAME must be exactly ${CUSTOM_DOMAIN_CANONICAL_HOST}; "${domain}" is a different host and needs a standard Deploy Preview or a separately approved domain migration.`
            );
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

    // No exported data changed, so this is not a data refresh. It may still skip
    // the preview, but only if nothing changed can alter what a preview would
    // show. "Published" is taken from the artifact definition itself, so adding
    // a page automatically makes it preview-relevant.
    if (dataCsvFiles.length === 0) {
        const errors = [];
        const publishedFiles = normalizedFiles.filter(isPublishedPath);
        const publishingControlFiles = normalizedFiles.filter(isPublishingControlPath);
        const unclassifiedFiles = normalizedFiles.filter(file => (
            !isPublishedPath(file) &&
            !isPublishingControlPath(file) &&
            !isKnownNoVisualPath(file)
        ));

        if (normalizedFiles.length === 0) {
            errors.push('The no-visual-change pathway requires at least one changed file.');
        }

        if (publishedFiles.length > 0) {
            errors.push(
                `The no-visual-change pathway cannot include files published to the site: ${publishedFiles.join(', ')}`
            );
        }

        if (publishingControlFiles.length > 0) {
            errors.push(
                `The no-visual-change pathway cannot include files that decide what is published or how it is deployed: ${publishingControlFiles.join(', ')}`
            );
        }

        if (unclassifiedFiles.length > 0) {
            errors.push(
                `The no-visual-change pathway cannot prove these files are outside the published site and its build controls: ${unclassifiedFiles.join(', ')}`
            );
        }

        return {
            pathway: 'no-visual-change',
            errors
        };
    }

    const disallowedFiles = normalizedFiles.filter(
        file => file !== ACTIVE_WORK_PATH &&
            !DATA_CSV_PATH.test(file) &&
            !ROUTINE_DERIVED_DATA_PATHS.has(file)
    );
    const errors = [];
    const missingDerivedDataFiles = [...ROUTINE_DERIVED_DATA_PATHS]
        .filter(file => !normalizedFiles.includes(file));

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
    if (missingDerivedDataFiles.length > 0) {
        errors.push(
            `The lightweight pathway requires refreshed deterministic data artifacts: ${missingDerivedDataFiles.join(', ')}`
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

function isKnownNoVisualPath(file) {
    return NO_VISUAL_SAFE_PATHS.has(file) ||
        NO_VISUAL_SAFE_PREFIXES.some(prefix => file.startsWith(prefix));
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
