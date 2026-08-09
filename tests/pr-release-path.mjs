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

const documentationOnly = assessReleasePath({
    title: '[skip netlify] Update notes',
    changedFiles: ['docs/active-work.md'],
    csvMetadata: new Map()
});
assert.match(documentationOnly.errors.join('\n'), /at least one changed CSV/);

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
