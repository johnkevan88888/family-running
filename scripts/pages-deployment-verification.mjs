import { performance } from 'node:perf_hooks';

const REPOSITORY = 'johnkevan88888/family-running';
const BASE_BRANCH = 'main';
const PAGES_WORKFLOW_FILE = 'deploy-pages.yml';
const PAGES_WORKFLOW_NAME = 'Deploy to GitHub Pages';
const RUN_JSON_FIELDS = [
    'databaseId',
    'conclusion',
    'event',
    'headBranch',
    'headSha',
    'status',
    'url',
    'workflowName'
].join(',');
const PENDING_RUN_STATUSES = new Set([
    'queued',
    'in_progress',
    'requested',
    'waiting',
    'pending'
]);
const COMPLETED_RUN_CONCLUSIONS = new Set([
    'action_required',
    'cancelled',
    'failure',
    'neutral',
    'skipped',
    'stale',
    'startup_failure',
    'success',
    'timed_out'
]);

export const DEFAULT_PAGES_REGISTRATION_TIMEOUT_MS = 2 * 60 * 1000;
export const DEFAULT_PAGES_COMPLETION_TIMEOUT_MS = 20 * 60 * 1000;
export const DEFAULT_PAGES_POLL_INTERVAL_MS = 5 * 1000;
export const DEFAULT_GH_COMMAND_TIMEOUT_MS = 30 * 1000;

export function createPagesRunListArguments(mergeCommitSha) {
    const normalizedSha = normalizeCommitSha(mergeCommitSha);

    return [
        'run',
        'list',
        '--repo',
        REPOSITORY,
        '--workflow',
        PAGES_WORKFLOW_FILE,
        '--branch',
        BASE_BRANCH,
        '--commit',
        normalizedSha,
        '--event',
        'push',
        '--limit',
        '10',
        '--json',
        RUN_JSON_FIELDS
    ];
}

export function createPagesRunViewArguments(runId) {
    const normalizedRunId = normalizeRunId(runId);

    return [
        'run',
        'view',
        String(normalizedRunId),
        '--repo',
        REPOSITORY,
        '--json',
        RUN_JSON_FIELDS
    ];
}

export function parsePagesRunListOutput(stdout, mergeCommitSha) {
    const normalizedSha = normalizeCommitSha(mergeCommitSha);
    const runs = parseJson(stdout, 'GitHub Pages workflow run list');

    if (!Array.isArray(runs)) {
        throw new Error('GitHub Pages workflow run list did not return a JSON array.');
    }
    if (runs.length === 0) {
        return null;
    }
    if (runs.length !== 1) {
        throw new Error(
            `GitHub returned ${runs.length} Pages workflow runs for exact merge commit ${normalizedSha}; refusing an ambiguous deployment.`
        );
    }

    return requirePagesRunIdentity(runs[0], { mergeCommitSha: normalizedSha });
}

export function parsePagesRunOutput(stdout, { mergeCommitSha, runId }) {
    const normalizedSha = normalizeCommitSha(mergeCommitSha);
    const normalizedRunId = normalizeRunId(runId);
    const run = parseJson(stdout, 'GitHub Pages workflow run');

    return requirePagesRunIdentity(run, {
        mergeCommitSha: normalizedSha,
        runId: normalizedRunId
    });
}

export async function waitForPagesRunRegistration({
    mergeCommitSha,
    runGh,
    timeoutMs = DEFAULT_PAGES_REGISTRATION_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_PAGES_POLL_INTERVAL_MS,
    commandTimeoutMs = DEFAULT_GH_COMMAND_TIMEOUT_MS,
    now = monotonicNow,
    sleep = defaultSleep
}) {
    const normalizedSha = normalizeCommitSha(mergeCommitSha);
    const polling = requirePollingDependencies({
        runGh,
        timeoutMs,
        pollIntervalMs,
        commandTimeoutMs,
        now,
        sleep
    });
    const deadline = readNow(polling.now) + polling.timeoutMs;

    while (true) {
        const remainingBeforeCommand = remainingTime(deadline, polling.now);

        if (remainingBeforeCommand <= 0) {
            throw registrationTimeoutError(normalizedSha, polling.timeoutMs);
        }

        const result = await polling.runGh(
            createPagesRunListArguments(normalizedSha),
            {
                label: 'GitHub Pages workflow registration check',
                timeoutMs: boundedCommandTimeout(
                    polling.commandTimeoutMs,
                    remainingBeforeCommand
                )
            }
        );
        const run = parsePagesRunListOutput(
            commandStdout(result, 'GitHub Pages workflow registration check'),
            normalizedSha
        );

        if (run) {
            return run;
        }

        const remainingBeforeSleep = remainingTime(deadline, polling.now);

        if (remainingBeforeSleep <= 0) {
            throw registrationTimeoutError(normalizedSha, polling.timeoutMs);
        }

        await polling.sleep(Math.min(polling.pollIntervalMs, remainingBeforeSleep));
    }
}

export async function waitForPagesRunCompletion({
    mergeCommitSha,
    runId,
    runGh,
    timeoutMs = DEFAULT_PAGES_COMPLETION_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_PAGES_POLL_INTERVAL_MS,
    commandTimeoutMs = DEFAULT_GH_COMMAND_TIMEOUT_MS,
    now = monotonicNow,
    sleep = defaultSleep
}) {
    const normalizedSha = normalizeCommitSha(mergeCommitSha);
    const normalizedRunId = normalizeRunId(runId);
    const polling = requirePollingDependencies({
        runGh,
        timeoutMs,
        pollIntervalMs,
        commandTimeoutMs,
        now,
        sleep
    });
    const deadline = readNow(polling.now) + polling.timeoutMs;
    let lastRun = null;

    while (true) {
        const remainingBeforeCommand = remainingTime(deadline, polling.now);

        if (remainingBeforeCommand <= 0) {
            throw completionTimeoutError({
                mergeCommitSha: normalizedSha,
                runId: normalizedRunId,
                timeoutMs: polling.timeoutMs,
                lastRun
            });
        }

        const result = await polling.runGh(
            createPagesRunViewArguments(normalizedRunId),
            {
                label: 'GitHub Pages workflow status check',
                timeoutMs: boundedCommandTimeout(
                    polling.commandTimeoutMs,
                    remainingBeforeCommand
                )
            }
        );
        const run = parsePagesRunOutput(
            commandStdout(result, 'GitHub Pages workflow status check'),
            { mergeCommitSha: normalizedSha, runId: normalizedRunId }
        );
        lastRun = run;

        if (run.status === 'completed') {
            if (run.conclusion !== 'success') {
                throw new Error(
                    `GitHub Pages workflow concluded ${run.conclusion} for merge commit ${normalizedSha}: ${run.url}`
                );
            }

            return run;
        }

        const remainingBeforeSleep = remainingTime(deadline, polling.now);

        if (remainingBeforeSleep <= 0) {
            throw completionTimeoutError({
                mergeCommitSha: normalizedSha,
                runId: normalizedRunId,
                timeoutMs: polling.timeoutMs,
                lastRun
            });
        }

        await polling.sleep(Math.min(polling.pollIntervalMs, remainingBeforeSleep));
    }
}

export async function verifyPagesDeploymentRun({
    mergeCommitSha,
    runGh,
    registrationTimeoutMs = DEFAULT_PAGES_REGISTRATION_TIMEOUT_MS,
    completionTimeoutMs = DEFAULT_PAGES_COMPLETION_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_PAGES_POLL_INTERVAL_MS,
    commandTimeoutMs = DEFAULT_GH_COMMAND_TIMEOUT_MS,
    now = monotonicNow,
    sleep = defaultSleep
}) {
    const registeredRun = await waitForPagesRunRegistration({
        mergeCommitSha,
        runGh,
        timeoutMs: registrationTimeoutMs,
        pollIntervalMs,
        commandTimeoutMs,
        now,
        sleep
    });

    return waitForPagesRunCompletion({
        mergeCommitSha,
        runId: registeredRun.databaseId,
        runGh,
        timeoutMs: completionTimeoutMs,
        pollIntervalMs,
        commandTimeoutMs,
        now,
        sleep
    });
}

function requirePagesRunIdentity(run, { mergeCommitSha, runId = null }) {
    if (!run || typeof run !== 'object' || Array.isArray(run)) {
        throw new Error('GitHub Pages workflow run metadata is missing or malformed.');
    }
    if (!Number.isSafeInteger(run.databaseId) || run.databaseId <= 0) {
        throw new Error('GitHub Pages workflow run ID is missing or invalid.');
    }
    if (runId !== null && run.databaseId !== runId) {
        throw new Error(
            `GitHub Pages workflow run ID changed: expected ${runId}, reported ${run.databaseId}.`
        );
    }
    if (run.headSha !== mergeCommitSha) {
        throw new Error('GitHub Pages workflow run does not match the exact merge commit.');
    }
    if (run.headBranch !== BASE_BRANCH) {
        throw new Error(`GitHub Pages workflow run does not target ${BASE_BRANCH}.`);
    }
    if (run.event !== 'push') {
        throw new Error('GitHub Pages workflow run was not triggered by the merge push.');
    }
    if (run.workflowName !== PAGES_WORKFLOW_NAME) {
        throw new Error('GitHub Pages workflow run has an unexpected workflow identity.');
    }

    const expectedUrl = `https://github.com/${REPOSITORY}/actions/runs/${run.databaseId}`;

    if (run.url !== expectedUrl) {
        throw new Error('GitHub Pages workflow run URL does not match its repository and run ID.');
    }

    const conclusion = run.conclusion === null || run.conclusion === undefined
        ? ''
        : run.conclusion;

    if (typeof conclusion !== 'string') {
        throw new Error('GitHub Pages workflow run conclusion is malformed.');
    }
    if (run.status === 'completed') {
        if (!COMPLETED_RUN_CONCLUSIONS.has(conclusion)) {
            throw new Error('Completed GitHub Pages workflow run has no valid conclusion.');
        }
    } else {
        if (!PENDING_RUN_STATUSES.has(run.status)) {
            throw new Error(`GitHub Pages workflow run has unsupported status ${run.status || '(blank)'}.`);
        }
        if (conclusion) {
            throw new Error('Incomplete GitHub Pages workflow run reported a terminal conclusion.');
        }
    }

    return {
        databaseId: run.databaseId,
        conclusion: conclusion || null,
        event: run.event,
        headBranch: run.headBranch,
        headSha: run.headSha,
        status: run.status,
        url: run.url,
        workflowName: run.workflowName
    };
}

function normalizeCommitSha(value) {
    if (typeof value !== 'string' || !/^[0-9a-f]{40}$/i.test(value)) {
        throw new Error('The Pages deployment merge commit SHA is invalid.');
    }

    return value.toLowerCase();
}

function normalizeRunId(value) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error('The Pages deployment workflow run ID is invalid.');
    }

    return value;
}

function parseJson(stdout, label) {
    try {
        return JSON.parse(String(stdout));
    } catch {
        throw new Error(`${label} returned invalid JSON.`);
    }
}

function commandStdout(result, label) {
    if (typeof result === 'string') {
        return result;
    }
    if (result && typeof result.stdout === 'string') {
        return result.stdout;
    }

    throw new Error(`${label} did not return stdout.`);
}

function requirePollingDependencies({
    runGh,
    timeoutMs,
    pollIntervalMs,
    commandTimeoutMs,
    now,
    sleep
}) {
    if (typeof runGh !== 'function') {
        throw new Error('GitHub Pages verification requires a gh-command function.');
    }
    if (typeof now !== 'function' || typeof sleep !== 'function') {
        throw new Error('GitHub Pages verification clock dependencies are invalid.');
    }

    for (const [label, value] of [
        ['timeout', timeoutMs],
        ['poll interval', pollIntervalMs],
        ['command timeout', commandTimeoutMs]
    ]) {
        if (!Number.isFinite(value) || value <= 0) {
            throw new Error(`GitHub Pages verification ${label} must be a positive number.`);
        }
    }

    return { runGh, timeoutMs, pollIntervalMs, commandTimeoutMs, now, sleep };
}

function readNow(now) {
    const value = now();

    if (!Number.isFinite(value)) {
        throw new Error('GitHub Pages verification clock returned an invalid time.');
    }

    return value;
}

function remainingTime(deadline, now) {
    return Math.max(0, deadline - readNow(now));
}

function boundedCommandTimeout(commandTimeoutMs, remainingMs) {
    return Math.max(1, Math.floor(Math.min(commandTimeoutMs, remainingMs)));
}

function registrationTimeoutError(mergeCommitSha, timeoutMs) {
    return new Error(
        `GitHub did not register the exact Pages push workflow for merge commit ${mergeCommitSha} within ${formatSeconds(timeoutMs)} seconds.`
    );
}

function completionTimeoutError({ mergeCommitSha, runId, timeoutMs, lastRun }) {
    const url = lastRun?.url || `https://github.com/${REPOSITORY}/actions/runs/${runId}`;
    const status = lastRun?.status || 'not observed';

    return new Error(
        `GitHub Pages workflow did not complete within ${formatSeconds(timeoutMs)} seconds for merge commit ${mergeCommitSha} (last status: ${status}): ${url}`
    );
}

function formatSeconds(milliseconds) {
    return Number((milliseconds / 1000).toFixed(3));
}

function defaultSleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function monotonicNow() {
    return performance.now();
}
