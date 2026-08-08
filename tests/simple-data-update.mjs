import assert from 'node:assert/strict';
import path from 'node:path';
import {
    assessPublishableDataChange,
    createDataBranchName,
    createDataPullRequestTitle,
    formatComparisonSummary,
    parseUpdateArguments,
    validateUpdateState
} from '../scripts/simple-data-update.mjs';

const date = new Date('2026-08-08T21:30:45.123Z');

assert.equal(createDataBranchName(date), 'data/refresh-20260808-213045');
assert.equal(
    createDataPullRequestTitle(date),
    '[skip netlify] Refresh website data 2026-08-08'
);

assert.deepEqual(parseUpdateArguments(['--resume', '--approve-publish']), {
    resume: true,
    prepareOnly: false,
    approvePromote: false,
    approvePublish: true,
    workbookPath: null,
    help: false
});
assert.equal(
    parseUpdateArguments(['--workbook', 'C:\\Private\\source.xlsm']).workbookPath,
    'C:\\Private\\source.xlsm'
);
assert.throws(
    () => parseUpdateArguments(['--resume', '--workbook', 'C:\\Private\\source.xlsm']),
    /cannot be combined/
);
assert.throws(() => parseUpdateArguments(['--unknown']), /Unknown option/);

const comparison = {
    meaningfulDifferences: [
        {
            relativePath: 'data/athlete_results.csv',
            trackedRows: 100,
            stagedRows: 102,
            removedRows: 0,
            addedRows: 2,
            orderOnly: false
        }
    ]
};
const summary = formatComparisonSummary(comparison);

assert.match(summary, /1 public CSV file/);
assert.match(summary, /data\/athlete_results\.csv/);
assert.match(summary, /rows 100 -> 102/);
assert.match(summary, /removed 0, added 2/);
assert.equal(
    formatComparisonSummary({ meaningfulDifferences: [] }),
    'No meaningful public-data differences were found.'
);

assert.deepEqual(assessPublishableDataChange({
    changedFiles: ['data/family/a.csv', 'data/everyone/b.csv'],
    expectedDataFiles: ['data/family/a.csv', 'data/everyone/b.csv']
}), []);
assert.match(
    assessPublishableDataChange({
        changedFiles: ['data/family/a.csv', 'scripts/site.js'],
        expectedDataFiles: ['data/family/a.csv', 'data/everyone/b.csv']
    }).join('\n'),
    /Unexpected changed files: scripts\/site\.js/
);
assert.match(
    assessPublishableDataChange({
        changedFiles: ['data/family/a.csv'],
        expectedDataFiles: ['data/family/a.csv', 'data/everyone/b.csv']
    }).join('\n'),
    /complete public CSV bundle/
);

assert.equal(validateUpdateState({
    version: 1,
    phase: 'prepared',
    branch: 'data/refresh-20260808-213045',
    stagedRoot: path.resolve('test-artifacts', 'workbook-export-staging', 'run-1')
}).phase, 'prepared');
assert.throws(
    () => validateUpdateState({
        version: 1,
        phase: 'prepared',
        branch: 'feature/not-data',
        stagedRoot: path.resolve('staged')
    }),
    /branch is invalid/
);

console.log('Simple data-update workflow tests passed.');
