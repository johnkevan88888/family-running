import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import {
    listPublicCsvFiles,
    repoRoot,
    resolveStagedRoot
} from './export-bundle-tools.mjs';

const STATE_VERSION = 1;
const REPOSITORY = 'johnkevan88888/family-running';
const BASE_BRANCH = 'main';
const REQUIRED_CHECK = 'Test static site';
const stateDirectory = path.join(repoRoot, 'test-artifacts', 'simple-data-update');
const statePath = path.join(stateDirectory, 'latest.json');
const promotionDirectory = path.join(
    repoRoot,
    'test-artifacts',
    'workbook-export-promotion'
);
const acceptedPhases = new Set([
    'prepared',
    'promoted',
    'tested',
    'committed',
    'published',
    // The Pull Request exists and its required check has passed, but nobody has
    // confirmed the merge yet. This phase is the review checkpoint: PUBLISH is
    // given before the Pull Request exists, so it cannot be approval of a diff
    // and screenshots that were not yet produced. Audit finding P2-04.
    'checked',
    'merged',
    'no-changes'
]);

export function parseUpdateArguments(argv) {
    const options = {
        resume: false,
        prepareOnly: false,
        approvePromote: false,
        approvePublish: false,
        approveMerge: false,
        workbookPath: null,
        help: false
    };

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];

        if (argument === '--') {
            continue;
        }
        if (argument === '--resume') {
            options.resume = true;
        } else if (argument === '--prepare-only') {
            options.prepareOnly = true;
        } else if (argument === '--approve-promote') {
            options.approvePromote = true;
        } else if (argument === '--approve-publish') {
            options.approvePublish = true;
        } else if (argument === '--approve-merge') {
            options.approveMerge = true;
        } else if (argument === '--help' || argument === '-h') {
            options.help = true;
        } else if (argument === '--workbook') {
            const value = argv[index + 1];

            if (!value || value.startsWith('--')) {
                throw new Error('--workbook requires a path.');
            }
            options.workbookPath = value;
            index += 1;
        } else {
            throw new Error(`Unknown option: ${argument}`);
        }
    }

    if (options.resume && options.workbookPath) {
        throw new Error('--workbook cannot be combined with --resume.');
    }

    return options;
}

export function createDataBranchName(date = new Date()) {
    const stamp = date.toISOString()
        .replace(/[-:]/g, '')
        .replace('T', '-')
        .replace(/\.\d{3}Z$/, '');

    return `data/refresh-${stamp}`;
}

export function createDataPullRequestTitle(date = new Date()) {
    return `[skip netlify] Refresh website data ${date.toISOString().slice(0, 10)}`;
}

export function formatComparisonSummary(comparison) {
    const differences = comparison?.meaningfulDifferences || [];

    if (differences.length === 0) {
        return 'No meaningful public-data differences were found.';
    }

    const lines = [
        `${differences.length} public CSV file(s) contain meaningful changes:`
    ];

    for (const result of differences) {
        const rowCounts = `rows ${result.trackedRows ?? '-'} -> ${result.stagedRows ?? '-'}`;
        const changes = result.orderOnly
            ? 'ordering only'
            : `removed ${result.removedRows ?? 0}, added ${result.addedRows ?? 0}`;
        lines.push(`- ${result.relativePath} (${rowCounts}; ${changes})`);
    }

    return lines.join('\n');
}

export function preparationRestoreArguments({ branch, commit }) {
    if (branch) {
        return ['switch', branch];
    }
    if (!/^[0-9a-f]{40}$/i.test(commit || '')) {
        throw new Error('The original detached-HEAD commit is invalid.');
    }

    return ['switch', '--detach', commit];
}

export function mayDeleteFailedPreparationBranch({ temporaryHead, baseHead }) {
    return (
        /^[0-9a-f]{40}$/i.test(temporaryHead || '') &&
        /^[0-9a-f]{40}$/i.test(baseHead || '') &&
        temporaryHead === baseHead
    );
}

export function formatPreparationFailure({ errorMessage, cleanupMessages, stagedRoot }) {
    const lines = [
        errorMessage,
        '',
        'No resumable data update was saved.'
    ];

    lines.push(...(cleanupMessages || []));
    if (stagedRoot) {
        lines.push(`Diagnostic staged export retained at: ${stagedRoot}`);
    }
    lines.push('Resolve the reported problem, then start a fresh data update without --resume.');

    return lines.join('\n');
}

export function createPreparationFailureAfterCleanup({ error, cleanup, stagedRoot }) {
    const primaryError = error instanceof Error ? error : new Error(String(error));
    let cleanupMessages;

    try {
        cleanupMessages = cleanup();
    } catch (cleanupError) {
        const detail = cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError);
        cleanupMessages = [
            `Automatic failed-preparation cleanup could not be completed: ${detail}`
        ];
    }

    return new Error(formatPreparationFailure({
        errorMessage: primaryError.message,
        cleanupMessages,
        stagedRoot
    }), { cause: primaryError });
}

export function mayRestorePreparationStartingBranch({ recordedHead, currentHead }) {
    return (
        /^[0-9a-f]{40}$/i.test(recordedHead || '') &&
        /^[0-9a-f]{40}$/i.test(currentHead || '') &&
        recordedHead === currentHead
    );
}

export function workbookContractSignature(contractDefinition) {
    const contractId = String(contractDefinition?.contractId || '');
    const fingerprint = String(contractDefinition?.schemaFingerprintSha256 || '');

    if (
        !contractId ||
        contractId.trim() !== contractId ||
        /[\r\n]/.test(contractId) ||
        !/^[A-F0-9]{64}$/.test(fingerprint)
    ) {
        throw new Error('The repository workbook-export contract definition is invalid.');
    }

    return `${contractId}:schema-sha256=${fingerprint}`;
}

export function requireWorkbookExportCapability(stdout, expectedSignature) {
    const marker = 'WORKBOOK_EXPORT_CAPABILITY=';
    const matches = String(stdout || '')
        .split(/\r?\n/)
        .filter(line => line.startsWith(marker));

    if (matches.length !== 1) {
        throw new Error(
            'Workbook contract preflight did not report exactly one capability marker.'
        );
    }

    const actualSignature = matches[0].slice(marker.length);

    if (!actualSignature || actualSignature !== expectedSignature) {
        throw new Error(
            `Workbook contract preflight mismatch. Expected ${expectedSignature}; reported ${actualSignature || '(blank)'}.`
        );
    }

    return actualSignature;
}

export function createWorkbookExportArguments({
    workbookPath,
    preflightOnly = false,
    expectedContractSignature = null
}) {
    const argumentsList = [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(repoRoot, 'scripts', 'run-workbook-staged-export.ps1')
    ];

    if (preflightOnly) {
        argumentsList.push('-PreflightOnly');
    }
    if (expectedContractSignature) {
        argumentsList.push('-ExpectedContractSignature', expectedContractSignature);
    }
    if (workbookPath) {
        argumentsList.push('-WorkbookPath', path.resolve(workbookPath));
    }

    return argumentsList;
}

export function assessPublishableDataChange({ changedFiles, expectedDataFiles }) {
    const normalizedChanged = [...new Set(changedFiles.map(normalizePath))].sort();
    const normalizedExpected = [...new Set(expectedDataFiles.map(normalizePath))].sort();
    const expectedSet = new Set(normalizedExpected);
    const changedSet = new Set(normalizedChanged);
    const unexpected = normalizedChanged.filter(file => !expectedSet.has(file));
    const missing = normalizedExpected.filter(file => !changedSet.has(file));
    const errors = [];

    if (normalizedChanged.length === 0) {
        errors.push('There are no public data changes to publish.');
    }
    if (unexpected.length > 0) {
        errors.push(`Unexpected changed files: ${unexpected.join(', ')}`);
    }
    if (missing.length > 0) {
        errors.push(`The complete public CSV bundle was not refreshed: ${missing.join(', ')}`);
    }

    return errors;
}

export function validateUpdateState(state) {
    if (!state || state.version !== STATE_VERSION) {
        throw new Error('The saved data-update state is missing or incompatible.');
    }
    if (!acceptedPhases.has(state.phase)) {
        throw new Error(`The saved data-update phase is invalid: ${state.phase}`);
    }
    if (!/^data\/refresh-[0-9]{8}-[0-9]{6}$/.test(state.branch || '')) {
        throw new Error('The saved data-update branch is invalid.');
    }
    if (!state.stagedRoot || !path.isAbsolute(state.stagedRoot)) {
        throw new Error('The saved staged-export path is invalid.');
    }
    if (state.promotionRoot && !path.isAbsolute(state.promotionRoot)) {
        throw new Error('The saved promotion-artifact path is invalid.');
    }

    return state;
}

export function assessDataPullRequestIdentity(pullRequest, state) {
    const errors = [];

    if (!pullRequest || typeof pullRequest !== 'object') {
        return ['GitHub did not return Pull Request metadata.'];
    }
    if (pullRequest.url !== state.pullRequestUrl) {
        errors.push('The Pull Request URL does not match the saved update.');
    }
    if (pullRequest.baseRefName !== BASE_BRANCH) {
        errors.push(`The Pull Request does not target ${BASE_BRANCH}.`);
    }
    if (pullRequest.headRefName !== state.branch) {
        errors.push('The Pull Request head branch does not match the saved update.');
    }
    if (pullRequest.headRefOid !== state.commitSha) {
        errors.push('The Pull Request head commit does not match the validated data commit.');
    }
    if (pullRequest.title !== state.pullRequestTitle) {
        errors.push('The Pull Request title changed after local validation.');
    }
    if (!/\[skip netlify\]/i.test(pullRequest.title || '')) {
        errors.push('The Pull Request is missing the lightweight data-refresh marker.');
    }

    return errors;
}

export function assessRequiredDataChecks(pullRequest) {
    const checks = Array.isArray(pullRequest?.statusCheckRollup)
        ? pullRequest.statusCheckRollup
        : [];
    const requiredCheck = checks.find(check => check?.name === REQUIRED_CHECK);

    if (!requiredCheck) {
        return [`GitHub did not report the required ${REQUIRED_CHECK} check.`];
    }
    if (requiredCheck.conclusion !== 'SUCCESS') {
        return [
            `${REQUIRED_CHECK} did not succeed (reported ${requiredCheck.conclusion || requiredCheck.status || 'unknown'}).`
        ];
    }

    return [];
}

async function main() {
    const options = parseUpdateArguments(process.argv.slice(2));

    if (options.help) {
        printHelp();
        return;
    }
    if (process.platform !== 'win32') {
        throw new Error('The guided workbook update currently requires Windows and Microsoft Excel.');
    }

    const tools = {
        git: findGit(),
        gh: findGitHubCli()
    };
    let state;

    verifyGitHubLogin(tools.gh);

    if (options.resume) {
        state = loadState();
        if (!['published', 'checked', 'merged', 'no-changes'].includes(state.phase)) {
            ensureCurrentBranch(tools.git, state.branch);
            console.log(`Resuming data update on ${state.branch}.`);
        } else {
            console.log(`Resuming published data update ${state.branch}.`);
        }
    } else {
        refuseUnfinishedUpdate(tools.gh);
        state = prepareUpdate(options, tools);
    }

    if (state.phase === 'no-changes') {
        console.log('Nothing needs to be promoted or published. Cleaning up the unused update branch.');
        cleanupCompletedUpdate(state, tools.git, { merged: false });
        return;
    }
    if (state.phase === 'merged') {
        cleanupCompletedUpdate(state, tools.git, { merged: true });
        return;
    }
    if (options.prepareOnly && state.phase === 'prepared') {
        printResumeInstructions(state);
        return;
    }

    if (state.phase === 'prepared') {
        console.log('');
        console.log(formatComparisonSummary(state.comparison));
        console.log(`Full reconciliation report: ${state.reportPath}`);

        const approved = options.approvePromote || await confirmExactWord(
            'PROMOTE',
            'Review the listed workbook-owned changes. Promote only when every difference is expected.'
        );

        if (!approved) {
            printResumeInstructions(state);
            return;
        }

        state = promoteAndTest(state, tools.git);
    } else if (state.phase === 'promoted') {
        state = runFullTests(state, tools.git);
    }

    if (
        state.phase === 'tested' &&
        state.testedDataFingerprint !== captureDataFingerprint(tools.git)
    ) {
        console.log('The saved update predates the tested-data fingerprint or its CSV diff changed. Running the full tests again...');
        delete state.productionApprovedAt;
        state = runFullTests(state, tools.git);
    }

    if (state.phase === 'tested') {
        showWorkingTreeSummary(tools.git);
    }

    if (
        ['tested', 'committed', 'published'].includes(state.phase) &&
        !state.productionApprovedAt
    ) {
        const approved = options.approvePublish || await confirmExactWord(
            'PUBLISH',
            'Publish will commit and push the validated CSV bundle, open a lightweight Pull Request, and wait for GitHub checks and screenshots. It does not merge: the run stops afterwards so you can review the exact diff and screenshots, and merging needs a separate MERGE confirmation.'
        );

        if (!approved) {
            printResumeInstructions(state);
            return;
        }

        state.productionApprovedAt = new Date().toISOString();
        saveState(state);
    }

    if (state.phase === 'tested') {
        state = commitUpdate(state, tools.git);
    }

    if (state.phase === 'committed') {
        state = pushAndOpenPullRequest(state, tools);
    }

    if (state.phase === 'published') {
        state = await waitForRequiredChecks(state, tools);
    }

    if (state.phase === 'checked') {
        state = await confirmReviewedMerge(state, tools, options);

        if (state.phase !== 'merged') {
            printResumeInstructions(state);
            return;
        }
    }

    if (state.phase === 'merged') {
        cleanupCompletedUpdate(state, tools.git, { merged: true });
    }
}

function prepareUpdate(options, tools) {
    requireCleanWorkingTree(tools.git);
    const startingPoint = {
        branch: captureGit(tools.git, ['branch', '--show-current']).trim(),
        commit: captureGit(tools.git, ['rev-parse', 'HEAD']).trim()
    };

    console.log('Refreshing the latest production branch...');
    runCommand(tools.git, ['fetch', 'origin', 'main', '--prune'], {
        label: 'GitHub refresh'
    });

    const baseCommit = captureGit(tools.git, ['rev-parse', 'origin/main']).trim();

    const contractDefinition = JSON.parse(captureGit(
        tools.git,
        ['show', `${baseCommit}:scripts/workbook-export-contract.json`]
    ));
    const expectedContractSignature = workbookContractSignature(contractDefinition);

    console.log('Checking the private workbook export contract...');
    const preflight = runCommand('powershell.exe', createWorkbookExportArguments({
        workbookPath: options.workbookPath,
        preflightOnly: true,
        expectedContractSignature
    }), {
        label: 'Workbook contract preflight'
    });
    requireWorkbookExportCapability(preflight.stdout, expectedContractSignature);

    const now = new Date();
    const branch = createDataBranchName(now);
    let branchCreated = false;
    let stagedRoot = null;

    try {
        runCommand(tools.git, ['switch', '--create', branch, baseCommit], {
            label: 'Data branch creation'
        });
        branchCreated = true;

        console.log('Exporting the complete website-data bundle from the private workbook...');
        const exportArguments = createWorkbookExportArguments({
            workbookPath: options.workbookPath,
            expectedContractSignature
        });

        const exported = runCommand('powershell.exe', exportArguments, {
            label: 'Workbook export'
        });
        const rootMatch = /(?:^|\r?\n)STAGED_EXPORT_ROOT=([^\r\n]+)/.exec(exported.stdout);

        if (!rootMatch) {
            throw new Error('The workbook export completed without reporting its staged path.');
        }

        stagedRoot = resolveStagedRoot(rootMatch[1].trim());
        console.log('Validating the staged bundle...');
        runNodeScript('scripts/export-bundle-validation.mjs', ['--staged', stagedRoot]);

        console.log('Comparing the staged bundle with production data...');
        runNodeScript('scripts/compare-export-bundle.mjs', ['--staged', stagedRoot], {
            acceptedStatuses: [0, 2]
        });

        const reportPath = path.join(stagedRoot, 'reconciliation.json');
        const comparison = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        const phase = comparison.meaningfulDifferences.length > 0
            ? 'prepared'
            : 'no-changes';
        const state = {
            version: STATE_VERSION,
            phase,
            branch,
            stagedRoot,
            reportPath,
            pullRequestTitle: createDataPullRequestTitle(now),
            comparison,
            createdAt: now.toISOString()
        };

        saveState(state);
        console.log('');
        console.log(formatComparisonSummary(comparison));
        return state;
    } catch (error) {
        if (!branchCreated) {
            throw error;
        }

        throw createPreparationFailureAfterCleanup({
            error,
            stagedRoot,
            cleanup: () => cleanupFailedPreparation({
                branch,
                baseCommit,
                startingPoint
            }, tools.git)
        });
    }
}

function cleanupFailedPreparation({ branch, baseCommit, startingPoint }, git) {
    const messages = [];
    const currentBranch = captureGit(git, ['branch', '--show-current']).trim();
    const currentHead = captureGit(git, ['rev-parse', 'HEAD']).trim();
    const status = captureGit(git, ['status', '--porcelain']);

    if (fs.existsSync(statePath)) {
        messages.push(
            `The temporary branch ${branch} was retained because updater state now exists.`
        );
        return messages;
    }
    if (
        currentBranch !== branch ||
        !mayDeleteFailedPreparationBranch({ temporaryHead: currentHead, baseHead: baseCommit })
    ) {
        messages.push(
            `The temporary branch ${branch} was retained because its checked-out identity or commit changed.`
        );
        return messages;
    }
    if (status.trim()) {
        messages.push(
            `The temporary branch ${branch} was retained because preparation created local changes.`
        );
        return messages;
    }

    if (startingPoint.branch) {
        let startingBranchHead;

        try {
            startingBranchHead = captureGit(git, [
                'rev-parse',
                '--verify',
                `refs/heads/${startingPoint.branch}`
            ]).trim();
        } catch (error) {
            messages.push(
                `The temporary branch ${branch} was retained because the original branch ` +
                `${startingPoint.branch} could not be verified: ${error.message}`
            );
            return messages;
        }

        if (!mayRestorePreparationStartingBranch({
            recordedHead: startingPoint.commit,
            currentHead: startingBranchHead
        })) {
            messages.push(
                `The temporary branch ${branch} was retained because the original branch ` +
                `${startingPoint.branch} no longer points to its recorded commit.`
            );
            return messages;
        }
    }

    try {
        runCommand(git, preparationRestoreArguments(startingPoint), {
            label: 'Failed preparation branch restore'
        });
        messages.push(
            `Restored ${startingPoint.branch || `detached HEAD at ${startingPoint.commit}`}.`
        );
    } catch (error) {
        messages.push(`Could not restore the original Git position: ${error.message}`);
        return messages;
    }

    try {
        runCommand(git, [
            'update-ref',
            '--delete',
            `refs/heads/${branch}`,
            baseCommit
        ], {
            label: 'Failed preparation branch cleanup'
        });
        messages.push(`Removed empty temporary branch ${branch}.`);
    } catch (error) {
        messages.push(`Could not remove temporary branch ${branch}: ${error.message}`);
    }

    return messages;
}

function promoteAndTest(state, git) {
    resolveStagedRoot(state.stagedRoot);
    const argumentsList = [
        '--staged',
        state.stagedRoot,
        '--approve'
    ];

    if (state.comparison.meaningfulDifferences.length > 0) {
        argumentsList.push('--approve-differences');
    }

    console.log('Promoting the reviewed complete bundle into tracked public data...');
    const promoted = runNodeScript('scripts/promote-staged-export.mjs', argumentsList);
    const promotionMatch = /(?:^|\r?\n)PROMOTION_ARTIFACT_ROOT=([^\r\n]+)/.exec(
        promoted.stdout
    );

    if (!promotionMatch) {
        throw new Error('Promotion completed without reporting its cleanup path.');
    }

    state.promotionRoot = resolvePromotionRoot(promotionMatch[1].trim());
    state.phase = 'promoted';
    saveState(state);
    return runFullTests(state, git);
}

function runFullTests(state, git) {
    console.log('Running the complete repository test and screenshot suite...');
    runNodeScript('scripts/run-all-tests.mjs');
    state.phase = 'tested';
    state.testedAt = new Date().toISOString();
    state.testedDataFingerprint = captureDataFingerprint(git);
    saveState(state);
    return state;
}

function commitUpdate(state, git) {
    ensureCurrentBranch(git, state.branch);

    if (
        !state.testedDataFingerprint ||
        captureDataFingerprint(git) !== state.testedDataFingerprint
    ) {
        throw new Error(
            'The public-data diff changed after the full test suite passed. Resume from a freshly tested update.'
        );
    }

    const changedFiles = splitNullTerminated(runCommand(
        git,
        ['diff', '--name-only', '-z'],
        { label: 'Changed-file inspection', quiet: true }
    ).stdout);
    const expectedDataFiles = listPublicCsvFiles(path.join(repoRoot, 'data'))
        .map(file => `data/${normalizePath(file)}`);
    const errors = assessPublishableDataChange({ changedFiles, expectedDataFiles });

    if (errors.length > 0) {
        throw new Error(`This update is not eligible for the lightweight path:\n- ${errors.join('\n- ')}`);
    }

    assertUnchangedCsvHeaders(git, expectedDataFiles);
    runCommand(git, ['add', '--', 'data'], { label: 'Stage public data' });

    const stagedFiles = splitNullTerminated(runCommand(
        git,
        ['diff', '--cached', '--name-only', '-z'],
        { label: 'Staged-file inspection', quiet: true }
    ).stdout);
    const stagedErrors = assessPublishableDataChange({
        changedFiles: stagedFiles,
        expectedDataFiles
    });

    if (stagedErrors.length > 0) {
        throw new Error(`The staged update is incomplete:\n- ${stagedErrors.join('\n- ')}`);
    }

    runCommand(git, ['commit', '-m', state.pullRequestTitle], {
        label: 'Commit data refresh'
    });

    const headSha = captureGit(git, ['rev-parse', 'HEAD']).trim();

    state.phase = 'committed';
    state.commitSha = headSha;
    saveState(state);
    return state;
}

function pushAndOpenPullRequest(state, tools) {
    ensureCurrentBranch(tools.git, state.branch);
    requireCleanWorkingTree(tools.git);
    validateCommittedReleasePath(state, tools.git);
    runCommand(tools.git, ['push', '--set-upstream', 'origin', state.branch], {
        label: 'Push data branch'
    });

    const existing = runCommand(
        tools.gh,
        [
            'pr',
            'view',
            state.branch,
            '--repo',
            REPOSITORY,
            '--json',
            'url,state'
        ],
        {
            label: 'Existing Pull Request check',
            acceptedStatuses: [0, 1],
            quiet: true
        }
    );
    let pullRequestUrl = '';

    if (existing.status === 0) {
        pullRequestUrl = JSON.parse(existing.stdout).url;
    } else {
        const body = createPullRequestBody(state);
        const created = runCommand(
            tools.gh,
            [
                'pr',
                'create',
                '--repo',
                REPOSITORY,
                '--base',
                BASE_BRANCH,
                '--head',
                state.branch,
                '--title',
                state.pullRequestTitle,
                '--body',
                body
            ],
            { label: 'Create lightweight Pull Request' }
        );
        pullRequestUrl = created.stdout.trim().split(/\r?\n/).at(-1);
    }

    state.phase = 'published';
    state.pullRequestUrl = pullRequestUrl;
    state.publishedAt = new Date().toISOString();
    saveState(state);
    return state;
}

// Waits for the required check and stops there. Merging is a separate step
// behind its own confirmation, because the artifacts a reviewer is supposed to
// inspect -- the committed diff and the uploaded responsive screenshots -- do
// not exist until this has finished. Audit finding P2-04.
async function waitForRequiredChecks(state, tools) {
    let pullRequest = await waitForRequiredCheckRegistration(state, tools.gh);

    requireDataPullRequestIdentity(pullRequest, state);

    if (pullRequest.state === 'MERGED') {
        return recordMergedPullRequest(state, pullRequest);
    }
    if (pullRequest.state !== 'OPEN') {
        throw new Error(
            `The data Pull Request is ${pullRequest.state || 'in an unknown state'} and cannot be merged automatically.`
        );
    }

    console.log('');
    console.log(`Lightweight data Pull Request: ${state.pullRequestUrl}`);
    console.log('Waiting for GitHub checks and responsive screenshot generation...');
    runCommand(
        tools.gh,
        [
            'pr',
            'checks',
            state.pullRequestUrl,
            '--repo',
            REPOSITORY,
            '--required',
            '--watch',
            '--fail-fast'
        ],
        { label: 'GitHub Pull Request checks' }
    );

    pullRequest = loadPullRequest(state, tools.gh);
    requireDataPullRequestIdentity(pullRequest, state);

    if (pullRequest.state === 'MERGED') {
        return recordMergedPullRequest(state, pullRequest);
    }

    const checkErrors = assessRequiredDataChecks(pullRequest);

    if (checkErrors.length > 0) {
        throw new Error(`Automatic merge refused:\n- ${checkErrors.join('\n- ')}`);
    }

    state.phase = 'checked';
    state.checkedAt = new Date().toISOString();
    state.checkRunUrl = requiredCheckDetailsUrl(pullRequest);
    saveState(state);
    return state;
}

async function confirmReviewedMerge(state, tools, options) {
    printReviewCheckpoint(state);

    const approved = options.approveMerge || await confirmExactWord(
        'MERGE',
        'Review the exact Pull Request diff and the uploaded Family and Everyone screenshots above. MERGE publishes this data to production.'
    );

    if (!approved) {
        return state;
    }

    // Re-read GitHub after the human pause rather than trusting what was true
    // before it. Identity pins the head commit to the validated one, so a push
    // during review is refused rather than merged.
    const pullRequest = loadPullRequest(state, tools.gh);

    requireDataPullRequestIdentity(pullRequest, state);

    if (pullRequest.state === 'MERGED') {
        return recordMergedPullRequest(state, pullRequest);
    }
    if (pullRequest.state !== 'OPEN') {
        throw new Error(
            `The data Pull Request is ${pullRequest.state || 'in an unknown state'} and cannot be merged automatically.`
        );
    }

    const checkErrors = assessRequiredDataChecks(pullRequest);

    if (checkErrors.length > 0) {
        throw new Error(`Automatic merge refused:\n- ${checkErrors.join('\n- ')}`);
    }

    return mergeReviewedPullRequest(state, tools);
}

function mergeReviewedPullRequest(state, tools) {
    console.log('Merging the reviewed data Pull Request...');
    runCommand(
        tools.gh,
        [
            'pr',
            'merge',
            state.pullRequestUrl,
            '--repo',
            REPOSITORY,
            '--merge',
            '--match-head-commit',
            state.commitSha,
            '--delete-branch'
        ],
        { label: 'Merge data Pull Request' }
    );

    const pullRequest = loadPullRequest(state, tools.gh);

    requireDataPullRequestIdentity(pullRequest, state);

    if (pullRequest.state !== 'MERGED') {
        throw new Error(
            'GitHub accepted the merge request but has not completed it. Run the launcher with --resume after GitHub finishes.'
        );
    }

    return recordMergedPullRequest(state, pullRequest);
}

function printReviewCheckpoint(state) {
    console.log('');
    console.log('All required checks passed. Nothing has been merged yet.');
    console.log('');
    console.log('Review before merging:');
    console.log(`- Pull Request:      ${state.pullRequestUrl}`);
    console.log(`- Exact CSV diff:    gh pr diff ${state.pullRequestUrl}`);

    if (state.checkRunUrl) {
        console.log(`- Screenshots:       ${state.checkRunUrl}`);
        console.log('                     download the responsive-screenshots artifact from that run');
    } else {
        console.log('- Screenshots:       open the Test static site check on the Pull Request and');
        console.log('                     download its responsive-screenshots artifact');
    }

    console.log('- Confirm Family and Everyone both render correctly at desktop and mobile sizes.');
}

function requiredCheckDetailsUrl(pullRequest) {
    const checks = Array.isArray(pullRequest?.statusCheckRollup)
        ? pullRequest.statusCheckRollup
        : [];

    return checks.find(check => check?.name === REQUIRED_CHECK)?.detailsUrl || '';
}

async function waitForRequiredCheckRegistration(state, gh) {
    const deadline = Date.now() + 2 * 60 * 1000;
    let announcedWait = false;

    while (true) {
        const pullRequest = loadPullRequest(state, gh);

        requireDataPullRequestIdentity(pullRequest, state);

        if (pullRequest.state !== 'OPEN') {
            return pullRequest;
        }
        if (
            pullRequest.statusCheckRollup?.some(
                check => check?.name === REQUIRED_CHECK
            )
        ) {
            return pullRequest;
        }
        if (Date.now() >= deadline) {
            throw new Error(
                `GitHub did not register the required ${REQUIRED_CHECK} check within two minutes. Run the launcher with --resume to try again.`
            );
        }
        if (!announcedWait) {
            console.log(`Waiting for GitHub to register the required ${REQUIRED_CHECK} check...`);
            announcedWait = true;
        }

        await new Promise(resolve => setTimeout(resolve, 5000));
    }
}

function loadPullRequest(state, gh) {
    const result = runCommand(
        gh,
        [
            'pr',
            'view',
            state.pullRequestUrl,
            '--repo',
            REPOSITORY,
            '--json',
            'url,state,title,baseRefName,headRefName,headRefOid,mergeCommit,mergedAt,statusCheckRollup'
        ],
        { label: 'Data Pull Request inspection', quiet: true }
    );

    return JSON.parse(result.stdout);
}

function requireDataPullRequestIdentity(pullRequest, state) {
    const errors = assessDataPullRequestIdentity(pullRequest, state);

    if (errors.length > 0) {
        throw new Error(`Automatic merge refused:\n- ${errors.join('\n- ')}`);
    }
}

function recordMergedPullRequest(state, pullRequest) {
    const mergeCommitSha = pullRequest.mergeCommit?.oid;

    if (!/^[0-9a-f]{40}$/i.test(mergeCommitSha || '')) {
        throw new Error('GitHub did not report the completed merge commit.');
    }

    state.phase = 'merged';
    state.mergeCommitSha = mergeCommitSha;
    state.mergedAt = pullRequest.mergedAt || new Date().toISOString();
    saveState(state);
    return state;
}

function cleanupCompletedUpdate(state, git, { merged }) {
    const currentBranch = captureGit(git, ['branch', '--show-current']).trim();

    if (![state.branch, BASE_BRANCH].includes(currentBranch)) {
        throw new Error(
            `Cleanup expected ${state.branch} or ${BASE_BRANCH}, but the current branch is ${currentBranch || 'detached HEAD'}.`
        );
    }

    requireCleanWorkingTree(git);
    console.log('Refreshing local main and removing the completed data branch...');
    runCommand(git, ['fetch', 'origin', BASE_BRANCH, '--prune'], {
        label: 'Post-update GitHub refresh'
    });

    if (currentBranch !== BASE_BRANCH) {
        runCommand(git, ['switch', BASE_BRANCH], { label: 'Return to main' });
    }

    runCommand(git, ['merge', '--ff-only', `origin/${BASE_BRANCH}`], {
        label: 'Fast-forward local main'
    });

    const localDataBranch = captureGit(
        git,
        ['branch', '--list', state.branch, '--format=%(refname:short)']
    ).trim();

    if (localDataBranch) {
        const branchHead = captureGit(git, ['rev-parse', state.branch]).trim();

        if (merged && branchHead !== state.commitSha) {
            throw new Error('The local data branch no longer matches the merged Pull Request head.');
        }

        runCommand(git, ['branch', '--delete', state.branch], {
            label: merged
                ? 'Delete merged local data branch'
                : 'Delete unused local data branch'
        });
    }

    if (merged) {
        deleteRemoteBranchIfPresent(state, git);
    }

    cleanupUpdateArtifacts(state);
    console.log('');
    console.log(
        merged
            ? `Data update merged at ${state.mergeCommitSha}. Local main is current and update artifacts were removed.`
            : 'No-change update cleaned up. Local main is current and no update branch remains.'
    );
}

function deleteRemoteBranchIfPresent(state, git) {
    const remoteBranch = runCommand(
        git,
        ['ls-remote', '--exit-code', '--heads', 'origin', state.branch],
        {
            label: 'Remote data branch check',
            acceptedStatuses: [0, 2],
            quiet: true
        }
    );

    if (remoteBranch.status === 0) {
        runCommand(git, ['push', 'origin', '--delete', state.branch], {
            label: 'Delete merged remote data branch'
        });
    }
}

function cleanupUpdateArtifacts(state) {
    console.log('Removing staged export and saved update state...');

    if (fs.existsSync(state.stagedRoot)) {
        fs.rmSync(resolveStagedRoot(state.stagedRoot), { recursive: true });
    }

    if (state.promotionRoot && fs.existsSync(state.promotionRoot)) {
        fs.rmSync(resolvePromotionRoot(state.promotionRoot), { recursive: true });
    }

    fs.rmSync(statePath, { force: true });

    if (fs.existsSync(stateDirectory) && fs.readdirSync(stateDirectory).length === 0) {
        fs.rmdirSync(stateDirectory);
    }
}

export function resolvePromotionRoot(candidate) {
    if (!candidate || !path.isAbsolute(candidate)) {
        throw new Error('The promotion cleanup path must be absolute.');
    }

    const resolvedParent = fs.realpathSync(promotionDirectory);
    const resolvedCandidate = fs.realpathSync(candidate);

    if (path.dirname(resolvedCandidate) !== resolvedParent) {
        throw new Error(
            'The promotion cleanup path must be an immediate child of the managed promotion-artifact directory.'
        );
    }

    return resolvedCandidate;
}

function validateCommittedReleasePath(state, git) {
    const baseSha = captureGit(git, ['rev-parse', 'origin/main']).trim();
    const headSha = captureGit(git, ['rev-parse', 'HEAD']).trim();

    if (state.commitSha && state.commitSha !== headSha) {
        throw new Error(
            'The prepared data commit changed after validation. Start a fresh routine data update.'
        );
    }

    const gitPath = `${path.dirname(git)}${path.delimiter}${process.env.PATH || ''}`;

    runNodeScript('scripts/validate-pr-release-path.mjs', [], {
        env: {
            ...process.env,
            PATH: gitPath,
            PR_TITLE: state.pullRequestTitle,
            PR_BASE_SHA: baseSha,
            PR_HEAD_SHA: headSha
        }
    });
}

function createPullRequestBody(state) {
    const changedCount = state.comparison.meaningfulDifferences.length;

    return [
        '## Summary',
        '',
        '- Refresh the complete workbook-generated public CSV bundle.',
        `- Update ${changedCount} CSV file(s) with meaningful data differences.`,
        '- Use the validated lightweight data-refresh pathway; Netlify preview is intentionally skipped.',
        '',
        '## Validation',
        '',
        '- Staged export-bundle validation passed.',
        '- Reconciliation completed before promotion.',
        '- Complete `pnpm test` suite and responsive screenshots passed.',
        '- Local lightweight-path eligibility validation passed.',
        '',
        '## Review',
        '',
        '- The local PUBLISH confirmation explicitly approved this routine data refresh for production.',
        '- The guided updater will merge only after the required GitHub check succeeds.'
    ].join('\n');
}

function assertUnchangedCsvHeaders(git, files) {
    const changedHeaders = [];

    for (const file of files) {
        const baseText = captureGit(git, ['show', `origin/main:${file}`]);
        const localText = fs.readFileSync(path.join(repoRoot, ...file.split('/')), 'utf8');

        if (firstLine(baseText) !== firstLine(localText)) {
            changedHeaders.push(file);
        }
    }

    if (changedHeaders.length > 0) {
        throw new Error(
            `CSV header changes require the standard Netlify preview path: ${changedHeaders.join(', ')}`
        );
    }
}

function firstLine(text) {
    return String(text).replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0];
}

function requireCleanWorkingTree(git) {
    const status = captureGit(git, ['status', '--porcelain']);

    if (status.trim()) {
        throw new Error(
            'The repository has local changes. Finish or set them aside before starting a simple data update.'
        );
    }
}

function ensureCurrentBranch(git, expectedBranch) {
    const currentBranch = captureGit(git, ['branch', '--show-current']).trim();

    if (currentBranch === expectedBranch) {
        return;
    }

    const status = captureGit(git, ['status', '--porcelain']);

    if (status.trim()) {
        throw new Error(
            `Resume requires branch ${expectedBranch}, but ${currentBranch || 'detached HEAD'} has local changes.`
        );
    }

    runCommand(git, ['switch', expectedBranch], { label: 'Resume data branch' });
}

function showWorkingTreeSummary(git) {
    console.log('');
    console.log('Validated public-data change summary:');
    const result = runCommand(git, ['diff', '--stat', '--', 'data'], {
        label: 'Git difference summary',
        quiet: true
    });
    process.stdout.write(result.stdout || 'No tracked data changes found.\n');
}

async function confirmExactWord(word, message) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.log(`${message}\nInteractive confirmation is unavailable.`);
        return false;
    }

    const prompt = createInterface({ input: process.stdin, output: process.stdout });

    try {
        const answer = await prompt.question(`${message}\nType ${word} to continue, or press Enter to stop: `);
        return answer.trim() === word;
    } finally {
        prompt.close();
    }
}

function refuseUnfinishedUpdate(gh) {
    if (!fs.existsSync(statePath)) {
        return;
    }

    const state = loadState();

    if (state.phase !== 'published') {
        throw new Error(
            `A data update already exists on ${state.branch}. Run "update-website-data.cmd --resume" to continue or finish its cleanup.`
        );
    }

    const result = runCommand(
        gh,
        [
            'pr',
            'view',
            state.pullRequestUrl,
            '--repo',
            REPOSITORY,
            '--json',
            'state'
        ],
        { label: 'Previous data Pull Request check', quiet: true }
    );
    const pullRequestState = JSON.parse(result.stdout).state;

    throw new Error(
        `The previous data Pull Request is ${pullRequestState}: ${state.pullRequestUrl}. Run "update-website-data.cmd --resume" to finish its merge or cleanup.`
    );
}

function verifyGitHubLogin(gh) {
    try {
        runCommand(gh, ['auth', 'status'], {
            label: 'GitHub login check',
            quiet: true
        });
    } catch {
        throw new Error(
            'GitHub CLI is not logged in. Run "gh auth login" in this terminal, then start the data update again.'
        );
    }
}

function loadState() {
    if (!fs.existsSync(statePath)) {
        throw new Error('No prepared data update was found to resume.');
    }

    return validateUpdateState(JSON.parse(fs.readFileSync(statePath, 'utf8')));
}

function saveState(state) {
    fs.mkdirSync(stateDirectory, { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function printResumeInstructions(state) {
    console.log('');

    if (state.phase === 'checked') {
        console.log(`Reviewed data Pull Request left open: ${state.pullRequestUrl}`);
        console.log('Nothing has been merged. Resume and type MERGE with: update-website-data.cmd --resume');
        return;
    }

    console.log(`Prepared update retained on ${state.branch}.`);
    console.log('Resume later with: update-website-data.cmd --resume');
}

function runNodeScript(relativeScript, argumentsList = [], options = {}) {
    return runCommand(
        process.execPath,
        [path.join(repoRoot, relativeScript), ...argumentsList],
        {
            label: relativeScript,
            acceptedStatuses: options.acceptedStatuses,
            env: options.env
        }
    );
}

function captureGit(git, argumentsList) {
    return runCommand(git, argumentsList, {
        label: `git ${argumentsList[0]}`,
        quiet: true
    }).stdout;
}

function runCommand(command, argumentsList, options = {}) {
    const acceptedStatuses = options.acceptedStatuses || [0];
    const result = spawnSync(command, argumentsList, {
        cwd: repoRoot,
        env: options.env || process.env,
        encoding: 'utf8',
        stdio: ['inherit', 'pipe', 'pipe'],
        maxBuffer: 100 * 1024 * 1024
    });

    if (!options.quiet) {
        process.stdout.write(result.stdout || '');
        process.stderr.write(result.stderr || '');
    }
    if (result.error) {
        throw new Error(`${options.label || command} could not start: ${result.error.message}`);
    }
    if (!acceptedStatuses.includes(result.status)) {
        const detail = (result.stderr || result.stdout || '').trim();
        throw new Error(
            `${options.label || command} failed with exit code ${result.status}${detail ? `: ${detail}` : '.'}`
        );
    }

    return result;
}

function findGit() {
    const runtimeGit = process.env.USERPROFILE
        ? path.join(
            process.env.USERPROFILE,
            '.cache',
            'codex-runtimes',
            'codex-primary-runtime',
            'dependencies',
            'native',
            'git',
            'cmd',
            'git.exe'
        )
        : '';

    return findExecutable(
        [
            process.env.GIT_BIN,
            'git',
            'C:\\Program Files\\Git\\cmd\\git.exe',
            runtimeGit
        ],
        ['--version'],
        'Git'
    );
}

function findGitHubCli() {
    return findExecutable(
        [
            process.env.GH_BIN,
            'gh',
            'C:\\Program Files\\GitHub CLI\\gh.exe'
        ],
        ['--version'],
        'GitHub CLI'
    );
}

function findExecutable(candidates, versionArguments, description) {
    for (const candidate of candidates.filter(Boolean)) {
        const result = spawnSync(candidate, versionArguments, {
            cwd: repoRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        });

        if (!result.error && result.status === 0) {
            return candidate;
        }
    }

    throw new Error(`${description} is required for the guided data update.`);
}

function splitNullTerminated(value) {
    return String(value || '')
        .split('\0')
        .filter(Boolean)
        .map(normalizePath);
}

function normalizePath(value) {
    return String(value).replaceAll('\\', '/');
}

function printHelp() {
    console.log(`Simple Family Running data update

Usage:
  update-website-data.cmd
  update-website-data.cmd --resume
  pnpm run data:update
  pnpm run data:update -- --resume
  pnpm run data:update -- --prepare-only
  pnpm run data:update -- --workbook "C:\\path\\source.xlsm"

The guided command creates a data branch, exports and validates the workbook,
requires PROMOTE confirmation before promotion, runs all tests, and requires
PUBLISH confirmation before opening a [skip netlify] Pull Request and waiting
for GitHub checks and screenshots.

It then stops. Merging to production needs a separate MERGE confirmation after
you have reviewed the exact Pull Request diff and the uploaded Family and
Everyone screenshots, which do not exist until PUBLISH has finished. Resume the
paused update with --resume; the merge re-verifies the Pull Request identity,
head commit, and required check before publishing, then deletes the data branch
and removes only the saved artifacts for that update.`);
}

function captureDataFingerprint(git) {
    const dataDiff = captureGit(git, ['diff', '--binary', '--', 'data']);

    return createHash('sha256').update(dataDiff, 'utf8').digest('hex');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => {
        console.error(`Simple data update stopped: ${error.message}`);
        process.exitCode = 1;
    });
}
