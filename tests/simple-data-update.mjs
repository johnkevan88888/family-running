import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    assessDataPullRequestIdentity,
    assessPublishableDataChange,
    assessRequiredDataChecks,
    createPreparationFailureAfterCleanup,
    createWorkbookExportArguments,
    createDataBranchName,
    createDataPullRequestTitle,
    formatComparisonSummary,
    formatPreparationFailure,
    mayDeleteFailedPreparationBranch,
    mayRestorePreparationStartingBranch,
    parseUpdateArguments,
    preparationRestoreArguments,
    requireWorkbookExportCapability,
    resolvePromotionRoot,
    validateUpdateState,
    workbookContractSignature
} from '../scripts/simple-data-update.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
assert.match(updater, /'pr',\s*'merge'[\s\S]*'--merge'[\s\S]*'--match-head-commit'[\s\S]*state\.commitSha[\s\S]*'--delete-branch'/i);
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

const failedCleanupBody = functionSource(updater, 'function cleanupFailedPreparation');
assert.match(failedCleanupBody, /fs\.existsSync\(statePath\)/);
assert.match(failedCleanupBody, /currentBranch !== branch/);
assert.match(failedCleanupBody, /status\.trim\(\)/);
assert.match(failedCleanupBody, /refs\/heads\/\$\{startingPoint\.branch\}/);
assert.match(failedCleanupBody, /mayRestorePreparationStartingBranch/);
assert.match(failedCleanupBody, /preparationRestoreArguments\(startingPoint\)/);
assert.match(failedCleanupBody, /'update-ref',[\s\S]*'--delete'/);
assert.match(failedCleanupBody, /`refs\/heads\/\$\{branch\}`/);
assert.doesNotMatch(failedCleanupBody, /['"]push['"]|refs\/remotes|origin\//);

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

const confirmBody = functionSource(updater, 'async function confirmReviewedMerge');
assert.match(confirmBody, /confirmExactWord\(\s*'MERGE'/);
assert.match(confirmBody, /options\.approveMerge/);
assert.match(confirmBody, /printReviewCheckpoint\(state\)/);

// The re-verification must happen after the human pause, not before it, so a
// push during review is refused rather than merged.
const approvalIndex = confirmBody.indexOf('const approved');
const reloadIndex = confirmBody.indexOf('loadPullRequest(state, tools.gh)');
const identityIndex = confirmBody.indexOf('requireDataPullRequestIdentity');
const checksIndex = confirmBody.indexOf('assessRequiredDataChecks');

assert.ok(approvalIndex >= 0 && reloadIndex > approvalIndex, 'The Pull Request must be re-read after MERGE.');
assert.ok(identityIndex > approvalIndex, 'Identity must be re-verified after MERGE.');
assert.ok(checksIndex > approvalIndex, 'Required checks must be re-verified after MERGE.');

// The PUBLISH prompt must no longer promise a merge it does not perform.
assert.match(updater, /'PUBLISH',\s*\n?\s*'[^']*does not merge/i);
assert.doesNotMatch(updater, /'PUBLISH',\s*\n?\s*'[^']*merge it to production/i);

// A paused, reviewed update must be resumable and must say nothing was merged.
assert.match(updater, /\['published', 'checked', 'merged', 'no-changes'\]/);
assert.match(updater, /Nothing has been merged\. Resume and type MERGE/);

assert.equal(validateUpdateState({
    version: 1,
    phase: 'checked',
    branch: 'data/refresh-20260808-213045',
    stagedRoot: path.resolve('test-artifacts', 'workbook-export-staging', 'run-1'),
    promotionRoot: path.resolve('test-artifacts', 'workbook-export-promotion', 'run-1')
}).phase, 'checked');

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
