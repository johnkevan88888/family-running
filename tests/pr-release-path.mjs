import assert from 'node:assert/strict';

import {
    assessReleasePath,
    hasNetlifySkipMarker,
    parseChangedCsvHeaders
} from '../scripts/validate-pr-release-path.mjs';

const unchangedCsv = {
    existsAtBase: true,
    existsAtHead: true,
    baseHeader: 'Name,Time,ExportBundleID',
    headHeader: 'Name,Time,ExportBundleID'
};

assert.equal(hasNetlifySkipMarker('[skip netlify] Refresh race times'), true);
assert.equal(hasNetlifySkipMarker('[SKIP NETLIFY] Refresh race times'), true);
assert.equal(hasNetlifySkipMarker('Refresh race times'), false);

assert.deepEqual(
    assessReleasePath({
        title: 'Add a new page',
        changedFiles: ['index.html'],
        csvMetadata: new Map()
    }),
    { pathway: 'full-preview', errors: [] }
);

const eligible = assessReleasePath({
    title: '[skip netlify] Refresh race times',
    changedFiles: [
        'data/athlete_results.csv',
        'data/family/5km-current-all-family.csv',
        'docs/active-work.md'
    ],
    csvMetadata: new Map([
        ['data/athlete_results.csv', unchangedCsv],
        ['data/family/5km-current-all-family.csv', unchangedCsv]
    ]),
    expectedDataCsvFiles: [
        'data/athlete_results.csv',
        'data/family/5km-current-all-family.csv'
    ]
});
assert.deepEqual(eligible, {
    pathway: 'lightweight-data-refresh',
    errors: []
});

const codeChange = assessReleasePath({
    title: '[skip netlify] Refresh race times',
    changedFiles: ['data/athlete_results.csv', 'leaderboard.js'],
    csvMetadata: new Map([['data/athlete_results.csv', unchangedCsv]])
});
assert.match(codeChange.errors.join('\n'), /leaderboard\.js/);

const customDomain = assessReleasePath({
    title: '[skip netlify] Configure custom domain',
    changedFiles: [
        'CNAME',
        'analytics.js',
        'tests/analytics-config.mjs',
        'docs/decision-log.md'
    ],
    cnameContents: 'www.aceofrace.com\n'
});
assert.deepEqual(customDomain, {
    pathway: 'custom-domain-configuration',
    errors: []
});

const invalidCustomDomain = assessReleasePath({
    title: '[skip netlify] Configure custom domain',
    changedFiles: ['CNAME'],
    cnameContents: 'https://www.aceofrace.com/path'
});
assert.match(invalidCustomDomain.errors.join('\n'), /valid hostname/);

// A syntax check alone let any valid hostname take the preview-skipping route
// and self-approve it. Audit finding P2-02.
const unapprovedCustomDomain = assessReleasePath({
    title: '[skip netlify] Configure custom domain',
    changedFiles: ['CNAME'],
    cnameContents: 'championships.example.com\n'
});
assert.match(unapprovedCustomDomain.errors.join('\n'), /must be exactly www\.aceofrace\.com/);

const apexCustomDomain = assessReleasePath({
    title: '[skip netlify] Configure custom domain',
    changedFiles: ['CNAME'],
    cnameContents: 'aceofrace.com\n'
});
assert.match(apexCustomDomain.errors.join('\n'), /must be exactly www\.aceofrace\.com/);

// Hostnames are case-insensitive, so only a genuinely different host is rejected.
const mixedCaseCustomDomain = assessReleasePath({
    title: '[skip netlify] Configure custom domain',
    changedFiles: ['CNAME'],
    cnameContents: 'WWW.AceOfRace.com\n'
});
assert.deepEqual(mixedCaseCustomDomain, {
    pathway: 'custom-domain-configuration',
    errors: []
});

const broadCustomDomainChange = assessReleasePath({
    title: '[skip netlify] Configure custom domain',
    changedFiles: ['CNAME', 'leaderboard.js'],
    cnameContents: 'www.aceofrace.com'
});
assert.match(broadCustomDomainChange.errors.join('\n'), /leaderboard\.js/);

const schemaChange = assessReleasePath({
    title: '[skip netlify] Refresh race times',
    changedFiles: ['data/athlete_results.csv'],
    csvMetadata: new Map([['data/athlete_results.csv', {
        ...unchangedCsv,
        headHeader: 'Name,Time,NewColumn,ExportBundleID'
    }]])
});
assert.match(schemaChange.errors.join('\n'), /header\/schema/);

const addedCsv = assessReleasePath({
    title: '[skip netlify] Add a new export',
    changedFiles: ['data/family/new_export.csv'],
    csvMetadata: new Map([['data/family/new_export.csv', {
        ...unchangedCsv,
        existsAtBase: false
    }]])
});
assert.match(addedCsv.errors.join('\n'), /both the base and head commits/);

// Documentation and tooling cannot change what a preview would show, so the
// marker is allowed. This replaced an earlier rule that rejected it purely for
// lacking a CSV, which forced pointless preview builds on docs-only changes.
const documentationOnly = assessReleasePath({
    title: '[skip netlify] Update notes',
    changedFiles: ['docs/active-work.md'],
    csvMetadata: new Map()
});
assert.deepEqual(documentationOnly, {
    pathway: 'no-visual-change',
    errors: []
});

const documentationAndTooling = assessReleasePath({
    title: '[skip netlify] Correct the staging root contract',
    changedFiles: [
        'AGENTS.md',
        'docs/decision-log.md',
        'docs/workbook-export-workflow.md',
        'scripts/run-workbook-staged-export.ps1',
        'tests/pr-release-path.mjs'
    ],
    csvMetadata: new Map()
});
assert.deepEqual(documentationAndTooling, {
    pathway: 'no-visual-change',
    errors: []
});

// A published file is preview-relevant by definition, marker or not.
const publishedFileChange = assessReleasePath({
    title: '[skip netlify] Tweak a heading',
    changedFiles: ['docs/decision-log.md', 'index.html'],
    csvMetadata: new Map()
});
assert.equal(publishedFileChange.pathway, 'no-visual-change');
assert.match(publishedFileChange.errors.join('\n'), /published to the site: index\.html/);

const vendoredLibraryChange = assessReleasePath({
    title: '[skip netlify] Bump chart library',
    changedFiles: ['vendor/chart.umd.min.js'],
    csvMetadata: new Map()
});
assert.match(vendoredLibraryChange.errors.join('\n'), /published to the site: vendor\/chart\.umd\.min\.js/);

// Not published, but decides what is published or how it is deployed.
const buildDefinitionChange = assessReleasePath({
    title: '[skip netlify] Adjust the build',
    changedFiles: ['scripts/build-preview-artifact.mjs'],
    csvMetadata: new Map()
});
assert.match(
    buildDefinitionChange.errors.join('\n'),
    /decide what is published or how it is deployed: scripts\/build-preview-artifact\.mjs/
);

const deployWorkflowChange = assessReleasePath({
    title: '[skip netlify] Adjust deployment',
    changedFiles: ['.github/workflows/deploy-pages.yml'],
    csvMetadata: new Map()
});
assert.match(
    deployWorkflowChange.errors.join('\n'),
    /decide what is published or how it is deployed/
);

// Without the marker nothing changes: a full preview is still required.
const documentationWithoutMarker = assessReleasePath({
    title: 'Correct the staging root contract',
    changedFiles: ['docs/decision-log.md'],
    csvMetadata: new Map()
});
assert.deepEqual(documentationWithoutMarker, {
    pathway: 'full-preview',
    errors: []
});

const incompleteBundle = assessReleasePath({
    title: '[skip netlify] Refresh one export only',
    changedFiles: ['data/athlete_results.csv'],
    csvMetadata: new Map([['data/athlete_results.csv', unchangedCsv]]),
    expectedDataCsvFiles: [
        'data/athlete_results.csv',
        'data/export_manifest.csv'
    ]
});
assert.match(incompleteBundle.errors.join('\n'), /complete public CSV bundle/);

const parsedHeaders = parseChangedCsvHeaders([
    'diff --git a/data/family/results.csv b/data/family/results.csv',
    '--- a/data/family/results.csv',
    '+++ b/data/family/results.csv',
    '@@ -1 +1 @@',
    '-Name,Time',
    '+Name,Time,ExportBundleID',
    'diff --git a/data/everyone/results.csv b/data/everyone/results.csv',
    '--- a/data/everyone/results.csv',
    '+++ b/data/everyone/results.csv',
    '@@ -1,0 +2 @@',
    '+John,20:00',
].join('\n'));
assert.deepEqual([...parsedHeaders], ['data/family/results.csv']);

console.log('PR release-path tests passed.');
