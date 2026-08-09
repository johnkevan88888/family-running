import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    assessDataPullRequestIdentity,
    assessPublishableDataChange,
    assessRequiredDataChecks,
    createDataBranchName,
    createDataPullRequestTitle,
    formatComparisonSummary,
    parseUpdateArguments,
    resolvePromotionRoot,
    validateUpdateState
} from '../scripts/simple-data-update.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcher = await fs.readFile(path.join(repoRoot, 'update-website-data.cmd'), 'utf8');
const updater = await fs.readFile(path.join(repoRoot, 'scripts', 'simple-data-update.mjs'), 'utf8');
const promoter = await fs.readFile(path.join(repoRoot, 'scripts', 'promote-staged-export.mjs'), 'utf8');

assert.doesNotMatch(launcher, /call pnpm run data:update/i);
assert.match(launcher, /where node\.exe/i);
assert.match(launcher, /codex-primary-runtime\\dependencies\\node\\bin\\node\.exe/i);
assert.match(launcher, /"%node_exe%" "%~dp0scripts\\simple-data-update\.mjs" %\*/i);
assert.match(launcher, /if not defined node_exe \([\s\S]*set "update_exit_code=1"/i);
assert.match(launcher, /rerun this launcher with --resume/i);
assert.match(updater, /'pr',\s*'checks'[\s\S]*'--required'[\s\S]*'--watch'[\s\S]*'--fail-fast'/i);
assert.match(updater, /'pr',\s*'merge'[\s\S]*'--merge'[\s\S]*'--match-head-commit'[\s\S]*state\.commitSha[\s\S]*'--delete-branch'/i);
assert.match(updater, /\['branch', '--delete', state\.branch\]/i);
assert.match(updater, /fs\.rmSync\(resolveStagedRoot\(state\.stagedRoot\), \{ recursive: true \}\)/i);
assert.match(promoter, /PROMOTION_ARTIFACT_ROOT=/i);

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

assert.equal(validateUpdateState({
    version: 1,
    phase: 'merged',
    branch: 'data/refresh-20260808-213045',
    stagedRoot: path.resolve('test-artifacts', 'workbook-export-staging', 'run-1'),
    promotionRoot: path.resolve('test-artifacts', 'workbook-export-promotion', 'run-1')
}).phase, 'merged');

const mergeState = {
    branch: 'data/refresh-20260808-213045',
    commitSha: 'a'.repeat(40),
    pullRequestTitle: '[skip netlify] Refresh website data 2026-08-08',
    pullRequestUrl: 'https://github.com/johnkevan88888/family-running/pull/31'
};
const mergePullRequest = {
    url: mergeState.pullRequestUrl,
    state: 'OPEN',
    title: mergeState.pullRequestTitle,
    baseRefName: 'main',
    headRefName: mergeState.branch,
    headRefOid: mergeState.commitSha,
    statusCheckRollup: [
        { name: 'Test static site', conclusion: 'SUCCESS', status: 'COMPLETED' }
    ]
};

assert.deepEqual(assessDataPullRequestIdentity(mergePullRequest, mergeState), []);
assert.match(
    assessDataPullRequestIdentity(
        { ...mergePullRequest, headRefOid: 'b'.repeat(40) },
        mergeState
    ).join('\n'),
    /head commit/
);
assert.match(
    assessDataPullRequestIdentity(
        { ...mergePullRequest, title: 'Ordinary Pull Request' },
        mergeState
    ).join('\n'),
    /title changed|marker/
);
assert.deepEqual(assessRequiredDataChecks(mergePullRequest), []);
assert.match(
    assessRequiredDataChecks({
        ...mergePullRequest,
        statusCheckRollup: [
            { name: 'Test static site', conclusion: 'FAILURE', status: 'COMPLETED' }
        ]
    }).join('\n'),
    /did not succeed/
);
assert.match(
    assessRequiredDataChecks({ ...mergePullRequest, statusCheckRollup: [] }).join('\n'),
    /did not report/
);

const promotionParent = path.join(
    repoRoot,
    'test-artifacts',
    'workbook-export-promotion'
);
await fs.mkdir(promotionParent, { recursive: true });
const promotionFixture = await fs.mkdtemp(path.join(promotionParent, 'cleanup-test-'));

try {
    assert.equal(
        path.dirname(resolvePromotionRoot(promotionFixture)),
        await fs.realpath(promotionParent)
    );
    assert.throws(
        () => resolvePromotionRoot(repoRoot),
        /immediate child/
    );
} finally {
    await fs.rm(promotionFixture, { recursive: true, force: true });
}

console.log('Simple data-update workflow tests passed.');
