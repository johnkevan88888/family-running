import { spawnSync } from 'node:child_process';
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
const stateDirectory = path.join(repoRoot, 'test-artifacts', 'simple-data-update');
const statePath = path.join(stateDirectory, 'latest.json');
const acceptedPhases = new Set([
    'prepared',
    'promoted',
    'tested',
    'committed',
    'published',
    'no-changes'
]);

export function parseUpdateArguments(argv) {
    const options = {
        resume: false,
        prepareOnly: false,
        approvePromote: false,
        approvePublish: false,
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

    return state;
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
        ensureCurrentBranch(tools.git, state.branch);
        console.log(`Resuming data update on ${state.branch}.`);
    } else {
        refuseUnfinishedUpdate(tools.gh);
        state = prepareUpdate(options, tools);
    }

    if (state.phase === 'no-changes') {
        console.log('Nothing needs to be promoted or published.');
        return;
    }
    if (state.phase === 'published') {
        console.log(`Pull Request already created: ${state.pullRequestUrl}`);
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

        state = promoteAndTest(state);
    } else if (state.phase === 'promoted') {
        state = runFullTests(state);
    }

    if (state.phase === 'tested') {
        showWorkingTreeSummary(tools.git);
        const approved = options.approvePublish || await confirmExactWord(
            'PUBLISH',
            'Publish will commit the complete CSV bundle, push the data branch, and open a lightweight Pull Request. It will not merge or deploy.'
        );

        if (!approved) {
            printResumeInstructions(state);
            return;
        }

        state = commitUpdate(state, tools.git);
    }

    if (state.phase === 'committed') {
        state = pushAndOpenPullRequest(state, tools);
    }

    console.log('');
    console.log(`Lightweight data Pull Request: ${state.pullRequestUrl}`);
    console.log('Netlify will be skipped. GitHub tests and responsive screenshots still run.');
    console.log('The Pull Request remains unmerged until John explicitly approves production.');
}

function prepareUpdate(options, tools) {
    requireCleanWorkingTree(tools.git);
    console.log('Refreshing the latest production branch...');
    runCommand(tools.git, ['fetch', 'origin', 'main', '--prune'], {
        label: 'GitHub refresh'
    });

    const now = new Date();
    const branch = createDataBranchName(now);
    runCommand(tools.git, ['switch', '--create', branch, 'origin/main'], {
        label: 'Data branch creation'
    });

    console.log('Exporting the complete website-data bundle from the private workbook...');
    const exportArguments = [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(repoRoot, 'scripts', 'run-workbook-staged-export.ps1')
    ];

    if (options.workbookPath) {
        exportArguments.push('-WorkbookPath', path.resolve(options.workbookPath));
    }

    const exported = runCommand('powershell.exe', exportArguments, {
        label: 'Workbook export'
    });
    const rootMatch = /(?:^|\r?\n)STAGED_EXPORT_ROOT=([^\r\n]+)/.exec(exported.stdout);

    if (!rootMatch) {
        throw new Error('The workbook export completed without reporting its staged path.');
    }

    const stagedRoot = resolveStagedRoot(rootMatch[1].trim());
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
}

function promoteAndTest(state) {
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
    runNodeScript('scripts/promote-staged-export.mjs', argumentsList);
    state.phase = 'promoted';
    saveState(state);
    return runFullTests(state);
}

function runFullTests(state) {
    console.log('Running the complete repository test and screenshot suite...');
    runNodeScript('scripts/run-all-tests.mjs');
    state.phase = 'tested';
    state.testedAt = new Date().toISOString();
    saveState(state);
    return state;
}

function commitUpdate(state, git) {
    ensureCurrentBranch(git, state.branch);
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
            'johnkevan88888/family-running',
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
                'johnkevan88888/family-running',
                '--base',
                'main',
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
        '- Review the exact CSV diff and the Family/Everyone screenshot artifacts.',
        '- Merge only after John explicitly approves production.'
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

    if (!['published', 'no-changes'].includes(state.phase)) {
        throw new Error(
            `An unfinished data update already exists on ${state.branch}. Run "pnpm run data:update -- --resume".`
        );
    }
    if (state.phase === 'published') {
        const result = runCommand(
            gh,
            [
                'pr',
                'view',
                state.pullRequestUrl,
                '--repo',
                'johnkevan88888/family-running',
                '--json',
                'state'
            ],
            { label: 'Previous data Pull Request check', quiet: true }
        );
        const pullRequestState = JSON.parse(result.stdout).state;

        if (pullRequestState === 'OPEN') {
            throw new Error(
                `The previous data update is still open: ${state.pullRequestUrl}. Merge or close it before starting another.`
            );
        }
    }
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
    console.log(`Prepared update retained on ${state.branch}.`);
    console.log('Resume later with: pnpm run data:update -- --resume');
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
  pnpm run data:update
  pnpm run data:update -- --resume
  pnpm run data:update -- --prepare-only
  pnpm run data:update -- --workbook "C:\\path\\source.xlsm"

The guided command creates a data branch, exports and validates the workbook,
requires confirmation before promotion, runs all tests, and requires a second
confirmation before pushing and opening a [skip netlify] Pull Request.
It never merges or deploys.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => {
        console.error(`Simple data update stopped: ${error.message}`);
        process.exitCode = 1;
    });
}
