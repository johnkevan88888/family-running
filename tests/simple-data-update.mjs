import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    assessDataPullRequestIdentity,
    assessPublishableDataChange,
    assessRequiredDataChecks,
    checkedOutWorktreesForBranch,
    createPreparationFailureAfterCleanup,
    createWorkbookExportArguments,
    createDataBranchName,
    createDataPullRequestTitle,
    findGit,
    formatComparisonSummary,
    formatPreparationFailure,
    mayDeleteFailedPreparationBranch,
    mayRestorePreparationStartingBranch,
    parseUpdateArguments,
    preparationBranchDeletionArguments,
    preparationRestoreArguments,
    readExportBundleId,
    remoteBranchDeletionArguments,
    requireWorkbookExportCapability,
    resolvePromotionRoot,
    validateUpdateState,
    waitForRecordedPagesDeployment,
    workbookContractSignature
} from '../scripts/simple-data-update.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureGit = findGit();
const launcher = await fs.readFile(path.join(repoRoot, 'update-website-data.cmd'), 'utf8');
const updater = await fs.readFile(path.join(repoRoot, 'scripts', 'simple-data-update.mjs'), 'utf8');
const promoter = await fs.readFile(path.join(repoRoot, 'scripts', 'promote-staged-export.mjs'), 'utf8');
const workbookRunner = await fs.readFile(
    path.join(repoRoot, 'scripts', 'run-workbook-staged-export.ps1'),
    'utf8'
);
const contractDefinition = JSON.parse(await fs.readFile(
    path.join(repoRoot, 'scripts', 'workbook-export-contract.json'),
    'utf8'
));

assert.doesNotMatch(launcher, /call pnpm run data:update/i);
assert.match(launcher, /where node\.exe/i);
assert.match(launcher, /codex-primary-runtime\\dependencies\\node\\bin\\node\.exe/i);
assert.match(launcher, /"%node_exe%" "%~dp0scripts\\simple-data-update\.mjs" %\*/i);
assert.match(launcher, /if not defined node_exe \([\s\S]*set "update_exit_code=1"/i);
assert.match(launcher, /rerun this launcher with --resume/i);
assert.match(updater, /'pr',\s*'checks'[\s\S]*'--required'[\s\S]*'--watch'[\s\S]*'--fail-fast'/i);
assert.match(updater, /'pr',\s*'merge'[\s\S]*'--merge'[\s\S]*'--match-head-commit'[\s\S]*state\.commitSha/i);
assert.match(updater, /\['branch', '--delete', state\.branch\]/i);
assert.match(updater, /fs\.rmSync\(resolveStagedRoot\(state\.stagedRoot\), \{ recursive: true \}\)/i);
assert.match(promoter, /PROMOTION_ARTIFACT_ROOT=/i);

// Audit finding P2-04. PUBLISH is given before the Pull Request exists, so it
// cannot be approval of a diff and screenshots that have not been produced yet.
// Waiting for checks and merging must therefore be separate steps, with a
// second confirmation and a fresh re-verification between them.
function functionSource(source, signature) {
    const start = source.indexOf(signature);
    assert.notEqual(start, -1, `Could not find ${signature}`);

    // Tracked files use CRLF, so match the closing brace at column zero
    // regardless of line ending.
    const end = /\r?\n\}\r?\n/.exec(source.slice(start));
    assert.notEqual(end, null, `Could not find the end of ${signature}`);

    return source.slice(start, start + end.index);
}

const expectedWorkbookSignature = workbookContractSignature(contractDefinition);
const csvFiles = (await listCsvFiles(path.join(repoRoot, 'data')))
    .sort((first, second) => first < second ? -1 : first > second ? 1 : 0);
const descriptorParts = [`${contractDefinition.schemaDescriptorPrefix}\n`];

for (const file of csvFiles) {
    const relativePath = path.relative(repoRoot, file).split(path.sep).join('/');
    const text = (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '');
    const header = text.split(/\r\n|\n|\r/, 1)[0];
    descriptorParts.push(`${relativePath}\n${header}\n`);
}

const descriptor = descriptorParts.join('');
const schemaFingerprint = createHash('sha256')
    .update(descriptor, 'utf8')
    .digest('hex')
    .toUpperCase();

assert.equal(contractDefinition.version, 1);
assert.equal(csvFiles.length, contractDefinition.publicCsvCount);
assert.equal(Buffer.byteLength(descriptor, 'utf8'), 14901);
assert.equal(schemaFingerprint, contractDefinition.schemaFingerprintSha256);
assert.equal(
    expectedWorkbookSignature,
    `${contractDefinition.contractId}:schema-sha256=${schemaFingerprint}`
);

const manifestLines = (await fs.readFile(
    path.join(repoRoot, 'data', 'export_manifest.csv'),
    'utf8'
)).trim().split(/\r\n|\n|\r/);
assert.equal(manifestLines.length - 1, contractDefinition.manifestEntryCount);

for (const scope of ['family', 'everyone']) {
    const header = (await fs.readFile(
        path.join(repoRoot, 'data', scope, 'official_result_news.csv'),
        'utf8'
    )).split(/\r\n|\n|\r/, 1)[0];
    assert.equal(
        header.split(',').length,
        contractDefinition.officialResultNewsColumnCount
    );
}

assert.equal(
    requireWorkbookExportCapability(
        `Workbook: C:\\Private\\source.xlsm\r\nWORKBOOK_EXPORT_CAPABILITY=${expectedWorkbookSignature}\r\n`,
        expectedWorkbookSignature
    ),
    expectedWorkbookSignature
);
assert.throws(
    () => requireWorkbookExportCapability('', expectedWorkbookSignature),
    /exactly one capability marker/
);
assert.throws(
    () => requireWorkbookExportCapability(
        'WORKBOOK_EXPORT_CAPABILITY=\r\n',
        expectedWorkbookSignature
    ),
    /mismatch/
);
assert.throws(
    () => requireWorkbookExportCapability(
        `WORKBOOK_EXPORT_CAPABILITY=${expectedWorkbookSignature}\n` +
        `WORKBOOK_EXPORT_CAPABILITY=${expectedWorkbookSignature}\n`,
        expectedWorkbookSignature
    ),
    /exactly one capability marker/
);
assert.throws(
    () => requireWorkbookExportCapability(
        'WORKBOOK_EXPORT_CAPABILITY=website-data/70;official-result-news/0\n',
        expectedWorkbookSignature
    ),
    /mismatch/
);

const overrideWorkbook = 'C:\\Private\\source.xlsm';
const preflightArguments = createWorkbookExportArguments({
    workbookPath: overrideWorkbook,
    preflightOnly: true,
    expectedContractSignature: expectedWorkbookSignature
});
const exportArguments = createWorkbookExportArguments({
    workbookPath: overrideWorkbook,
    expectedContractSignature: expectedWorkbookSignature
});

assert(preflightArguments.includes('-PreflightOnly'));
assert(!exportArguments.includes('-PreflightOnly'));
assert(preflightArguments.includes(path.resolve(overrideWorkbook)));
assert(exportArguments.includes(path.resolve(overrideWorkbook)));
assert(preflightArguments.includes(expectedWorkbookSignature));
assert(exportArguments.includes(expectedWorkbookSignature));

assert.deepEqual(
    preparationRestoreArguments({ branch: 'main', commit: 'a'.repeat(40) }),
    ['switch', 'main']
);
assert.deepEqual(
    preparationRestoreArguments({ branch: '', commit: 'a'.repeat(40) }),
    ['switch', '--detach', 'a'.repeat(40)]
);
assert.throws(
    () => preparationRestoreArguments({ branch: '', commit: 'not-a-commit' }),
    /detached-HEAD commit is invalid/
);
assert.deepEqual(
    preparationBranchDeletionArguments({
        branch: 'data/refresh-cleanup-test',
        baseCommit: 'a'.repeat(40)
    }),
    [
        'update-ref',
        '-d',
        'refs/heads/data/refresh-cleanup-test',
        'a'.repeat(40)
    ]
);
assert.deepEqual(
    remoteBranchDeletionArguments({
        branch: 'data/refresh-cleanup-test',
        expectedCommit: 'a'.repeat(40)
    }),
    [
        'push',
        `--force-with-lease=refs/heads/data/refresh-cleanup-test:${'a'.repeat(40)}`,
        'origin',
        ':refs/heads/data/refresh-cleanup-test'
    ]
);
assert.equal(mayDeleteFailedPreparationBranch({
    temporaryHead: 'a'.repeat(40),
    baseHead: 'a'.repeat(40)
}), true);
assert.equal(mayDeleteFailedPreparationBranch({
    temporaryHead: 'a'.repeat(40),
    baseHead: 'b'.repeat(40)
}), false);
assert.equal(mayDeleteFailedPreparationBranch({
    temporaryHead: 'not-a-commit',
    baseHead: 'not-a-commit'
}), false);

const formattedPreparationFailure = formatPreparationFailure({
    errorMessage: 'Staged validation failed.',
    cleanupMessages: ['Restored main.', 'Removed empty temporary branch data/refresh-test.'],
    stagedRoot: path.join(repoRoot, 'test-artifacts', 'workbook-export-staging', 'run-test')
});
assert.match(formattedPreparationFailure, /No resumable data update was saved/);
assert.match(formattedPreparationFailure, /Diagnostic staged export retained at/);
assert.match(formattedPreparationFailure, /without --resume/);

const primaryPreparationError = new Error('Staged validation failed.');
const cleanupInspectionFailure = createPreparationFailureAfterCleanup({
    error: primaryPreparationError,
    stagedRoot: null,
    cleanup: () => {
        throw new Error('git status could not run');
    }
});
assert.match(cleanupInspectionFailure.message, /^Staged validation failed\./);
assert.match(
    cleanupInspectionFailure.message,
    /Automatic failed-preparation cleanup could not be completed: git status could not run/
);
assert.equal(cleanupInspectionFailure.cause, primaryPreparationError);

assert.equal(mayRestorePreparationStartingBranch({
    recordedHead: 'a'.repeat(40),
    currentHead: 'a'.repeat(40)
}), true);
assert.equal(mayRestorePreparationStartingBranch({
    recordedHead: 'a'.repeat(40),
    currentHead: 'b'.repeat(40)
}), false);
assert.equal(mayRestorePreparationStartingBranch({
    recordedHead: 'not-a-commit',
    currentHead: 'not-a-commit'
}), false);

assert.match(workbookRunner, /\[switch\]\$PreflightOnly/);
assert.match(
    workbookRunner,
    /Workbooks\.Open\(\$WorkbookPath, 0, \[bool\]\$PreflightOnly\)/
);
const contractQueryIndex = workbookRunner.indexOf('GetWebsiteExportContractForAutomation');
const preflightReturnIndex = workbookRunner.indexOf('if ($PreflightOnly)');
const disableEventsIndex = workbookRunner.indexOf('$excel.EnableEvents = $false');
const workbookOpenIndex = workbookRunner.indexOf('$excel.Workbooks.Open');
const exportMacroIndex = workbookRunner.indexOf(
    'ExportWebsiteDataIncludingAthleteComparisonForAutomation'
);
const workbookSaveIndex = workbookRunner.indexOf('$workbook.Save()');
assert(contractQueryIndex >= 0 && contractQueryIndex < preflightReturnIndex);
assert(disableEventsIndex >= 0 && disableEventsIndex < workbookOpenIndex);
assert(preflightReturnIndex < exportMacroIndex);
assert(exportMacroIndex < workbookSaveIndex);

const prepareBody = functionSource(updater, 'function prepareUpdate');
const preflightIndex = prepareBody.indexOf("label: 'Workbook contract preflight'");
const baseCommitIndex = prepareBody.indexOf("['rev-parse', 'origin/main']");
const pinnedContractIndex = prepareBody.indexOf(
    "['show', `${baseCommit}:scripts/workbook-export-contract.json`]"
);
const branchCreationIndex = prepareBody.indexOf("['switch', '--create'");
const fullExportIndex = prepareBody.indexOf("label: 'Workbook export'");
assert(baseCommitIndex >= 0 && baseCommitIndex < pinnedContractIndex);
assert(pinnedContractIndex < preflightIndex);
assert(preflightIndex >= 0 && preflightIndex < branchCreationIndex);
assert(branchCreationIndex < fullExportIndex);
assert.match(prepareBody, /\['switch', '--create', branch, baseCommit\]/);
assert.doesNotMatch(prepareBody, /origin\/main:scripts\/workbook-export-contract\.json/);
assert.doesNotMatch(prepareBody, /\['switch', '--create', branch, 'origin\/main'\]/);
assert.match(
    prepareBody,
    /expectedExportBundleId:[\s\S]*stagedRoot[\s\S]*data[\s\S]*export_manifest\.csv/
);

const commitBody = functionSource(updater, 'function commitUpdate');
const bundleRecheckIndex = commitBody.indexOf('const workingBundleId');
const stageDataIndex = commitBody.indexOf("['add', '--', 'data']");
assert(bundleRecheckIndex >= 0 && stageDataIndex > bundleRecheckIndex);
assert.match(commitBody, /promoted export bundle changed after staged validation/);

const failedCleanupBody = functionSource(updater, 'function cleanupFailedPreparation');
assert.match(failedCleanupBody, /fs\.existsSync\(statePath\)/);
assert.match(failedCleanupBody, /currentBranch !== branch/);
assert.match(failedCleanupBody, /status\.trim\(\)/);
assert.match(failedCleanupBody, /refs\/heads\/\$\{startingPoint\.branch\}/);
assert.match(failedCleanupBody, /mayRestorePreparationStartingBranch/);
assert.match(failedCleanupBody, /preparationRestoreArguments\(startingPoint\)/);
assert.match(failedCleanupBody, /preparationBranchDeletionArguments\(\{ branch, baseCommit \}\)/);
assert(
    failedCleanupBody.indexOf('refuseCheckedOutBranch(git, branch)') <
    failedCleanupBody.indexOf('preparationBranchDeletionArguments({ branch, baseCommit })')
);
assert.doesNotMatch(failedCleanupBody, /--delete/);
assert.doesNotMatch(failedCleanupBody, /['"]push['"]|refs\/remotes|origin\//);

await verifyPreparationBranchDeletionCommand();
await verifyRemoteBranchDeletionCommand();

const waitBody = functionSource(updater, 'async function waitForRequiredChecks');
assert.doesNotMatch(
    waitBody,
    /'merge'/,
    'Waiting for the required check must not merge; merging needs its own confirmation.'
);
assert.match(waitBody, /state\.phase = 'checked'/);

// The split is only worth anything if the main flow actually routes through the
// confirmation, so assert that it does and that it cannot merge directly.
const mainBody = functionSource(updater, 'async function main()');
assert.match(mainBody, /state = await waitForRequiredChecks\(state, tools\)/);
assert.match(mainBody, /state = await confirmReviewedMerge\(state, tools, options\)/);
assert.doesNotMatch(
    mainBody,
    /mergeReviewedPullRequest/,
    'The main flow must reach a merge only through confirmReviewedMerge.'
);
assert.match(
    mainBody,
    /if \(state\.phase !== 'merged'\) \{[\s\S]*?printResumeInstructions\(state\)[\s\S]*?return;/,
    'A declined merge must leave the Pull Request open and explain how to resume.'
);
assert.equal(
    (mainBody.match(/await finishMergedUpdate\(state, tools\)/g) || []).length,
    2,
    'Fresh and resumed merged updates must use the same production-verification gate.'
);

const finishMergedBody = functionSource(updater, 'async function finishMergedUpdate');
const verifyProductionIndex = finishMergedBody.indexOf('verifyMergedUpdateInProduction');
const cleanupMergedIndex = finishMergedBody.indexOf(
    'cleanupCompletedUpdate(state, tools.git, { merged: true })'
);
assert(verifyProductionIndex >= 0 && cleanupMergedIndex > verifyProductionIndex);
assert.match(finishMergedBody, /state\.phase === 'merged'/);
assert.match(finishMergedBody, /state\.phase !== 'production-verified'/);
assert.match(finishMergedBody, /retry verification without merging again/);

const verifyMergedBody = functionSource(
    updater,
    'async function verifyMergedUpdateInProduction'
);
assert.match(verifyMergedBody, /state\.commitSha}:data\/export_manifest\.csv/);
assert.match(verifyMergedBody, /waitForRecordedPagesDeployment/);
assert.match(verifyMergedBody, /verifyProductionData/);
assert.match(verifyMergedBody, /state\.phase = 'production-verified'/);
assert.match(verifyMergedBody, /readExpectedFile:[\s\S]*git[\s\S]*show/);

const recordedPagesBody = functionSource(
    updater,
    'export async function waitForRecordedPagesDeployment'
);
assert.match(recordedPagesBody, /waitForRegistration/);
assert.match(recordedPagesBody, /waitForCompletion/);
assert.match(recordedPagesBody, /persistState\(state\)/);
assert.match(recordedPagesBody, /state\.mergeCommitSha/);

const completedCleanupBody = functionSource(updater, 'function cleanupCompletedUpdate');
assert.match(
    completedCleanupBody,
    /merged && state\.phase !== 'production-verified'/
);
assert.match(completedCleanupBody, /LIVE VERIFICATION PASSED/);
assert.match(completedCleanupBody, /\?site=family/);
assert.match(completedCleanupBody, /\?site=everyone/);
assert.match(completedCleanupBody, /preparationBranchDeletionArguments/);
assert(
    completedCleanupBody.indexOf('refuseCheckedOutBranch(git, state.branch)') <
    completedCleanupBody.indexOf('preparationBranchDeletionArguments')
);

assert.deepEqual(
    checkedOutWorktreesForBranch(
        [
            'worktree C:/GitHub/family-running',
            `HEAD ${'a'.repeat(40)}`,
            'branch refs/heads/main',
            '',
            'worktree C:/GitHub/family-running/test-artifacts/worktrees/data refresh',
            `HEAD ${'b'.repeat(40)}`,
            'branch refs/heads/data/refresh-test',
            '',
            'worktree C:/detached',
            `HEAD ${'c'.repeat(40)}`,
            'detached',
            '',
            ''
        ].join('\0'),
        'data/refresh-test'
    ),
    ['C:/GitHub/family-running/test-artifacts/worktrees/data refresh']
);

const remoteCleanupBody = functionSource(updater, 'function deleteRemoteBranchIfPresent');
assert.match(remoteCleanupBody, /fields\[0\][\s\S]*state\.commitSha/);
assert.match(remoteCleanupBody, /remoteBranchDeletionArguments/);
assert.match(remoteCleanupBody, /force-with-lease|Delete exact merged remote data branch/);

const confirmBody = functionSource(updater, 'async function confirmReviewedMerge');
assert.match(confirmBody, /confirmExactWord\(\s*'MERGE'/);
assert.match(confirmBody, /options\.approveMerge/);
assert.match(confirmBody, /printReviewCheckpoint\(state\)/);

const mergeReviewedBody = functionSource(updater, 'function mergeReviewedPullRequest');
assert.doesNotMatch(
    mergeReviewedBody,
    /--delete-branch/,
    'The verified data branch must remain until post-MERGE production proof passes.'
);

// The re-verification must happen after the human pause, not before it, so a
// push during review is refused rather than merged.
const approvalIndex = confirmBody.indexOf('const approved');
const firstReloadIndex = confirmBody.indexOf('loadPullRequest(state, tools.gh)');
const secondReloadIndex = confirmBody.indexOf(
    'loadPullRequest(state, tools.gh)',
    approvalIndex
);
const firstIdentityIndex = confirmBody.indexOf('requireDataPullRequestIdentity');
const secondIdentityIndex = confirmBody.indexOf(
    'requireDataPullRequestIdentity',
    approvalIndex
);
const firstChecksIndex = confirmBody.indexOf('assessRequiredDataChecks');
const secondChecksIndex = confirmBody.indexOf('assessRequiredDataChecks', approvalIndex);

assert.ok(firstReloadIndex >= 0 && firstReloadIndex < approvalIndex);
assert.ok(firstIdentityIndex > firstReloadIndex && firstIdentityIndex < approvalIndex);
assert.ok(firstChecksIndex > firstReloadIndex && firstChecksIndex < approvalIndex);
assert.ok(secondReloadIndex > approvalIndex, 'The Pull Request must be re-read after MERGE.');
assert.ok(secondIdentityIndex > approvalIndex, 'Identity must be re-verified after MERGE.');
assert.ok(secondChecksIndex > approvalIndex, 'Required checks must be re-verified after MERGE.');
assert.ok(
    confirmBody.indexOf("pullRequest.state === 'MERGED'") < approvalIndex,
    'A merge completed before state was saved must resume without another MERGE prompt.'
);

// The PUBLISH prompt must no longer promise a merge it does not perform.
assert.match(updater, /'PUBLISH',\s*\n?\s*'[^']*does not merge/i);
assert.doesNotMatch(updater, /'PUBLISH',\s*\n?\s*'[^']*merge it to production/i);

// A paused, reviewed update must be resumable and must say nothing was merged.
assert.match(updater, /'published',[\s\S]*'checked',[\s\S]*'merged',[\s\S]*'production-verified',[\s\S]*'no-changes'/);
assert.match(updater, /Nothing has been merged\. Resume and type MERGE/);

assert.equal(validateUpdateState({
    version: 1,
    phase: 'checked',
    branch: 'data/refresh-20260808-213045',
    stagedRoot: path.resolve('test-artifacts', 'workbook-export-staging', 'run-1'),
    promotionRoot: path.resolve('test-artifacts', 'workbook-export-promotion', 'run-1'),
    commitSha: 'a'.repeat(40)
}).phase, 'checked');

const validBundleId = '20990101T010203004Z-A1B2C3D4';
const validManifest = [
    'ExportBundleID,ExportedAtUTC,SchemaVersion,Scope,RelativePath,DataRowCount',
    `${validBundleId},2099-01-01T01:02:03.004Z,1.0,shared,data/athlete_results.csv,1`,
    `${validBundleId},2099-01-01T01:02:03.004Z,1.0,family,data/family/siteinfo.csv,4`
].join('\r\n');

assert.equal(readExportBundleId(validManifest), validBundleId);
assert.throws(
    () => readExportBundleId(validManifest.replace('ExportBundleID,', 'Other,')),
    /exactly one ExportBundleID/
);
assert.throws(
    () => readExportBundleId(validManifest.replace(
        'ExportBundleID,ExportedAtUTC',
        'ExportBundleID,ExportBundleID,ExportedAtUTC'
    )),
    /exactly one ExportBundleID/
);
assert.throws(
    () => readExportBundleId(validManifest.split('\r\n', 1)[0]),
    /no public-data entries/
);
assert.throws(
    () => readExportBundleId(validManifest.replace(validBundleId, 'INVALID')),
    /invalid ExportBundleID/
);
assert.throws(
    () => readExportBundleId(validManifest.replace(
        new RegExp(validBundleId.replaceAll('-', '\\-'), 'g'),
        (value, offset) => offset === validManifest.lastIndexOf(validBundleId)
            ? '20990101T010203004Z-B1B2C3D4'
            : value
    )),
    /mixed ExportBundleID/
);

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
    approveMerge: false,
    workbookPath: null,
    help: false
});
assert.equal(parseUpdateArguments(['--approve-merge']).approveMerge, true);
assert.equal(parseUpdateArguments(['--approve-publish']).approveMerge, false);
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
    promotionRoot: path.resolve('test-artifacts', 'workbook-export-promotion', 'run-1'),
    commitSha: 'a'.repeat(40),
    mergeCommitSha: 'b'.repeat(40)
}).phase, 'merged');

const productionVerifiedState = {
    version: 1,
    phase: 'production-verified',
    branch: 'data/refresh-20260808-213045',
    stagedRoot: path.resolve('test-artifacts', 'workbook-export-staging', 'run-1'),
    promotionRoot: path.resolve('test-artifacts', 'workbook-export-promotion', 'run-1'),
    commitSha: 'a'.repeat(40),
    mergeCommitSha: 'b'.repeat(40),
    expectedExportBundleId: validBundleId,
    pagesDeploymentRunId: 123456,
    pagesDeploymentRunUrl:
        'https://github.com/johnkevan88888/family-running/actions/runs/123456',
    productionVerifiedAt: '2026-08-27T04:05:06.000Z'
};

assert.equal(validateUpdateState(productionVerifiedState).phase, 'production-verified');
assert.throws(
    () => validateUpdateState({ ...productionVerifiedState, expectedExportBundleId: '' }),
    /missing its expected export bundle ID/
);
assert.throws(
    () => validateUpdateState({ ...productionVerifiedState, pagesDeploymentRunUrl: 'https://example.com/run' }),
    /run URL is invalid/
);
assert.throws(
    () => validateUpdateState({ ...productionVerifiedState, productionVerifiedAt: 'not-a-time' }),
    /verification time is invalid/
);

await verifyRecordedPagesResumeBehavior();

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

async function listCsvFiles(directory) {
    const files = [];

    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            files.push(...await listCsvFiles(entryPath));
        } else if (entry.isFile() && entry.name.endsWith('.csv')) {
            files.push(entryPath);
        }
    }

    return files;
}

async function verifyPreparationBranchDeletionCommand() {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'family-running-cleanup-'));
    const linkedWorktree = path.join(
        os.tmpdir(),
        `family-running-cleanup-worktree-${path.basename(fixtureRoot)}`
    );
    const temporaryBranch = 'data/refresh-cleanup-test';
    const temporaryRef = `refs/heads/${temporaryBranch}`;

    try {
        runFixtureGit(fixtureRoot, ['init', '--quiet']);
        runFixtureGit(fixtureRoot, ['config', 'user.name', 'Family Running Tests']);
        runFixtureGit(fixtureRoot, ['config', 'user.email', 'tests@example.invalid']);
        runFixtureGit(fixtureRoot, ['config', 'commit.gpgSign', 'false']);
        runFixtureGit(fixtureRoot, ['config', 'core.hooksPath', '.git/no-hooks']);
        await fs.writeFile(path.join(fixtureRoot, 'fixture.txt'), 'first\n', 'utf8');
        runFixtureGit(fixtureRoot, ['add', 'fixture.txt']);
        runFixtureGit(fixtureRoot, ['commit', '--quiet', '-m', 'First fixture commit']);

        const baseCommit = runFixtureGit(fixtureRoot, ['rev-parse', 'HEAD']).stdout.trim();
        runFixtureGit(fixtureRoot, ['branch', temporaryBranch, baseCommit]);

        runFixtureGit(fixtureRoot, ['worktree', 'add', '--quiet', linkedWorktree, temporaryBranch]);
        assert.deepEqual(
            checkedOutWorktreesForBranch(
                runFixtureGit(
                    fixtureRoot,
                    ['worktree', 'list', '--porcelain', '-z']
                ).stdout,
                temporaryBranch
            ),
            [linkedWorktree.replaceAll('\\', '/')],
            'A linked worktree must be detected before compare-and-swap branch deletion.'
        );
        runFixtureGit(fixtureRoot, ['worktree', 'remove', '--force', linkedWorktree]);

        runFixtureGit(
            fixtureRoot,
            preparationBranchDeletionArguments({ branch: temporaryBranch, baseCommit })
        );
        runFixtureGit(fixtureRoot, ['show-ref', '--verify', '--quiet', temporaryRef], {
            expectFailure: true
        });

        runFixtureGit(fixtureRoot, ['branch', temporaryBranch, baseCommit]);
        await fs.writeFile(path.join(fixtureRoot, 'fixture.txt'), 'second\n', 'utf8');
        runFixtureGit(fixtureRoot, ['add', 'fixture.txt']);
        runFixtureGit(fixtureRoot, ['commit', '--quiet', '-m', 'Second fixture commit']);
        const movedCommit = runFixtureGit(fixtureRoot, ['rev-parse', 'HEAD']).stdout.trim();
        runFixtureGit(fixtureRoot, ['branch', '--force', temporaryBranch, movedCommit]);

        runFixtureGit(
            fixtureRoot,
            preparationBranchDeletionArguments({ branch: temporaryBranch, baseCommit }),
            { expectFailure: true }
        );
        assert.equal(
            runFixtureGit(fixtureRoot, ['rev-parse', temporaryRef]).stdout.trim(),
            movedCommit,
            'The compare-and-swap delete must retain a moved temporary ref.'
        );
    } finally {
        await fs.rm(linkedWorktree, { recursive: true, force: true });
        await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
}

async function verifyRemoteBranchDeletionCommand() {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'family-running-remote-cleanup-'));
    const workingRoot = path.join(fixtureRoot, 'working');
    const remoteRoot = path.join(fixtureRoot, 'remote.git');
    const temporaryBranch = 'data/refresh-remote-cleanup-test';
    const temporaryRef = `refs/heads/${temporaryBranch}`;

    try {
        await fs.mkdir(workingRoot);
        runFixtureGit(fixtureRoot, ['init', '--bare', '--quiet', remoteRoot]);
        runFixtureGit(workingRoot, ['init', '--quiet']);
        runFixtureGit(workingRoot, ['config', 'user.name', 'Family Running Tests']);
        runFixtureGit(workingRoot, ['config', 'user.email', 'tests@example.invalid']);
        runFixtureGit(workingRoot, ['config', 'commit.gpgSign', 'false']);
        runFixtureGit(workingRoot, ['config', 'core.hooksPath', '.git/no-hooks']);
        runFixtureGit(workingRoot, ['remote', 'add', 'origin', remoteRoot]);
        await fs.writeFile(path.join(workingRoot, 'fixture.txt'), 'first\n', 'utf8');
        runFixtureGit(workingRoot, ['add', 'fixture.txt']);
        runFixtureGit(workingRoot, ['commit', '--quiet', '-m', 'First fixture commit']);

        const baseCommit = runFixtureGit(workingRoot, ['rev-parse', 'HEAD']).stdout.trim();
        runFixtureGit(workingRoot, ['push', 'origin', `${baseCommit}:${temporaryRef}`]);
        runFixtureGit(workingRoot, remoteBranchDeletionArguments({
            branch: temporaryBranch,
            expectedCommit: baseCommit
        }));
        runFixtureGit(remoteRoot, ['show-ref', '--verify', '--quiet', temporaryRef], {
            expectFailure: true
        });

        runFixtureGit(workingRoot, ['push', 'origin', `${baseCommit}:${temporaryRef}`]);
        await fs.writeFile(path.join(workingRoot, 'fixture.txt'), 'second\n', 'utf8');
        runFixtureGit(workingRoot, ['add', 'fixture.txt']);
        runFixtureGit(workingRoot, ['commit', '--quiet', '-m', 'Second fixture commit']);
        const movedCommit = runFixtureGit(workingRoot, ['rev-parse', 'HEAD']).stdout.trim();
        runFixtureGit(workingRoot, ['push', 'origin', `${movedCommit}:${temporaryRef}`]);

        runFixtureGit(workingRoot, remoteBranchDeletionArguments({
            branch: temporaryBranch,
            expectedCommit: baseCommit
        }), { expectFailure: true });
        assert.equal(
            runFixtureGit(remoteRoot, ['rev-parse', temporaryRef]).stdout.trim(),
            movedCommit,
            'The force-with-lease delete must retain a moved remote ref.'
        );
    } finally {
        await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
}

async function verifyRecordedPagesResumeBehavior() {
    const runId = 33035787966;
    const mergeCommitSha = 'b'.repeat(40);
    const runUrl =
        `https://github.com/johnkevan88888/family-running/actions/runs/${runId}`;
    const completedRun = { databaseId: runId, url: runUrl };
    const resumedState = {
        phase: 'merged',
        mergeCommitSha,
        pagesDeploymentRunId: runId,
        pagesDeploymentRunUrl: runUrl
    };
    let registrationCalls = 0;
    let persistedCalls = 0;
    let completionRequest;

    const result = await waitForRecordedPagesDeployment(resumedState, {
        runGh: async () => {
            throw new Error('The injected completion check does not invoke gh.');
        },
        waitForRegistration: async () => {
            registrationCalls += 1;
            throw new Error('Registration must be skipped for a recorded run.');
        },
        waitForCompletion: async request => {
            completionRequest = request;
            return completedRun;
        },
        persistState: () => {
            persistedCalls += 1;
        },
        logger: () => {}
    });

    assert.deepEqual(result, completedRun);
    assert.equal(registrationCalls, 0);
    assert.equal(persistedCalls, 0);
    assert.equal(completionRequest.mergeCommitSha, mergeCommitSha);
    assert.equal(completionRequest.runId, runId);

    const retainedState = { ...resumedState };
    await assert.rejects(
        waitForRecordedPagesDeployment(retainedState, {
            runGh: async () => '',
            waitForRegistration: async () => {
                throw new Error('Registration must remain skipped.');
            },
            waitForCompletion: async () => {
                throw new Error('Pages run concluded failure');
            },
            persistState: () => {
                throw new Error('A recorded failed run must not rewrite state.');
            },
            logger: () => {}
        }),
        /concluded failure/
    );
    assert.deepEqual(retainedState, resumedState);

    const freshState = { phase: 'merged', mergeCommitSha };
    const order = [];
    await waitForRecordedPagesDeployment(freshState, {
        runGh: async () => '',
        waitForRegistration: async request => {
            order.push('register');
            assert.equal(request.mergeCommitSha, mergeCommitSha);
            return completedRun;
        },
        waitForCompletion: async request => {
            order.push('complete');
            assert.equal(request.runId, runId);
            return completedRun;
        },
        persistState: state => {
            order.push('persist');
            assert.equal(state.pagesDeploymentRunId, runId);
            assert.equal(state.pagesDeploymentRunUrl, runUrl);
        },
        logger: () => {}
    });
    assert.deepEqual(order, ['register', 'persist', 'complete']);
}

function runFixtureGit(cwd, argumentsList, { expectFailure = false } = {}) {
    const result = spawnSync(fixtureGit, argumentsList, {
        cwd,
        encoding: 'utf8',
        windowsHide: true
    });

    assert.equal(result.error, undefined, result.error?.message);
    if (expectFailure) {
        assert.notEqual(
            result.status,
            0,
            `git ${argumentsList.join(' ')} unexpectedly succeeded.`
        );
    } else {
        assert.equal(
            result.status,
            0,
            `git ${argumentsList.join(' ')} exited ${result.status}: ${result.stderr}`
        );
    }

    return result;
}
