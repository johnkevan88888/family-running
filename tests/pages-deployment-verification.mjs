import assert from 'node:assert/strict';
import {
    createPagesRunListArguments,
    createPagesRunViewArguments,
    parsePagesRunListOutput,
    parsePagesRunOutput,
    verifyPagesDeploymentRun,
    waitForPagesRunCompletion,
    waitForPagesRunRegistration
} from '../scripts/pages-deployment-verification.mjs';

const mergeCommitSha = 'a'.repeat(40);
const otherCommitSha = 'b'.repeat(40);
const runId = 33035787966;
const runUrl = `https://github.com/johnkevan88888/family-running/actions/runs/${runId}`;
const jsonFields = 'databaseId,conclusion,event,headBranch,headSha,status,url,workflowName';

assert.deepEqual(createPagesRunListArguments(mergeCommitSha.toUpperCase()), [
    'run',
    'list',
    '--repo',
    'johnkevan88888/family-running',
    '--workflow',
    'deploy-pages.yml',
    '--branch',
    'main',
    '--commit',
    mergeCommitSha,
    '--event',
    'push',
    '--limit',
    '10',
    '--json',
    jsonFields
]);
assert.deepEqual(createPagesRunViewArguments(runId), [
    'run',
    'view',
    String(runId),
    '--repo',
    'johnkevan88888/family-running',
    '--json',
    jsonFields
]);
assert.throws(() => createPagesRunListArguments('not-a-sha'), /SHA is invalid/);
assert.throws(() => createPagesRunListArguments(1), /SHA is invalid/);
assert.throws(() => createPagesRunViewArguments(0), /run ID is invalid/);
assert.throws(() => createPagesRunViewArguments('1'), /run ID is invalid/);

const queuedRun = createRun();
const inProgressRun = createRun({ status: 'in_progress' });
const successfulRun = createRun({ status: 'completed', conclusion: 'success' });

assert.equal(parsePagesRunListOutput('[]', mergeCommitSha), null);
assert.deepEqual(
    parsePagesRunListOutput(JSON.stringify([queuedRun]), mergeCommitSha),
    { ...queuedRun, conclusion: null }
);
assert.deepEqual(
    parsePagesRunOutput(JSON.stringify(successfulRun), { mergeCommitSha, runId }),
    successfulRun
);
assert.throws(
    () => parsePagesRunListOutput('{"workflow_runs":[]}', mergeCommitSha),
    /JSON array/
);
assert.throws(
    () => parsePagesRunListOutput('not-json', mergeCommitSha),
    /invalid JSON/
);
assert.throws(
    () => parsePagesRunListOutput(
        JSON.stringify([queuedRun, { ...queuedRun, databaseId: runId + 1 }]),
        mergeCommitSha
    ),
    /ambiguous deployment/
);

for (const [overrides, pattern] of [
    [{ databaseId: 0 }, /run ID is missing or invalid/],
    [{ headSha: otherCommitSha }, /exact merge commit/],
    [{ headBranch: 'feature' }, /does not target main/],
    [{ event: 'workflow_dispatch' }, /merge push/],
    [{ workflowName: 'Another workflow' }, /workflow identity/],
    [{ url: 'https://example.com/' }, /URL does not match/],
    [{ status: 'unknown' }, /unsupported status/],
    [{ status: 'completed', conclusion: null }, /no valid conclusion/],
    [{ conclusion: 'failure' }, /terminal conclusion/]
]) {
    assert.throws(
        () => parsePagesRunListOutput(
            JSON.stringify([{ ...queuedRun, ...overrides }]),
            mergeCommitSha
        ),
        pattern
    );
}

assert.throws(
    () => parsePagesRunOutput(
        JSON.stringify({ ...queuedRun, databaseId: runId + 1 }),
        { mergeCommitSha, runId }
    ),
    /run ID changed/
);
assert.deepEqual(
    parsePagesRunListOutput(
        JSON.stringify([{ ...queuedRun, conclusion: '' }]),
        mergeCommitSha
    ),
    { ...queuedRun, conclusion: null }
);
for (const status of ['queued', 'in_progress', 'requested', 'waiting', 'pending']) {
    assert.equal(
        parsePagesRunListOutput(
            JSON.stringify([{ ...queuedRun, status }]),
            mergeCommitSha
        ).status,
        status
    );
}

{
    const clock = createFakeClock();
    const calls = [];
    const outputs = [
        '[]',
        '[]',
        JSON.stringify([queuedRun])
    ];
    const registeredRun = await waitForPagesRunRegistration({
        mergeCommitSha,
        runGh: async (argumentsList, options) => {
            calls.push({ argumentsList, options });
            return { stdout: outputs.shift() };
        },
        timeoutMs: 11_000,
        pollIntervalMs: 5_000,
        commandTimeoutMs: 30_000,
        now: clock.now,
        sleep: clock.sleep
    });

    assert.equal(registeredRun.databaseId, runId);
    assert.deepEqual(clock.sleeps, [5_000, 5_000]);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0].argumentsList, createPagesRunListArguments(mergeCommitSha));
    assert.deepEqual(calls.map(call => call.options.timeoutMs), [11_000, 6_000, 1_000]);
}

{
    const observedTimeouts = [];
    const run = await waitForPagesRunRegistration({
        mergeCommitSha,
        runGh: async (argumentsList, options) => {
            observedTimeouts.push(options.timeoutMs);
            return JSON.stringify([queuedRun]);
        },
        timeoutMs: 1_000.75,
        commandTimeoutMs: 30_000,
        now: () => 0.25,
        sleep: async () => {
            throw new Error('A registered run must not sleep.');
        }
    });

    assert.equal(run.databaseId, runId);
    assert.deepEqual(observedTimeouts, [1_000]);
    assert(Number.isInteger(observedTimeouts[0]));
}

{
    const clock = createFakeClock();
    let calls = 0;

    await assert.rejects(
        waitForPagesRunRegistration({
            mergeCommitSha,
            runGh: async () => {
                calls += 1;
                return '[]';
            },
            timeoutMs: 12_000,
            pollIntervalMs: 5_000,
            now: clock.now,
            sleep: clock.sleep
        }),
        new RegExp(`${mergeCommitSha}.*12 seconds`)
    );
    assert.equal(calls, 3);
    assert.deepEqual(clock.sleeps, [5_000, 5_000, 2_000]);
    assert.equal(clock.value(), 12_000);
}

{
    const clock = createFakeClock();
    const outputs = [queuedRun, inProgressRun, successfulRun].map(JSON.stringify);
    const completedRun = await waitForPagesRunCompletion({
        mergeCommitSha,
        runId,
        runGh: async argumentsList => {
            assert.deepEqual(argumentsList, createPagesRunViewArguments(runId));
            return { stdout: outputs.shift() };
        },
        timeoutMs: 20_000,
        pollIntervalMs: 5_000,
        now: clock.now,
        sleep: clock.sleep
    });

    assert.equal(completedRun.conclusion, 'success');
    assert.deepEqual(clock.sleeps, [5_000, 5_000]);
}

for (const conclusion of ['failure', 'cancelled', 'timed_out']) {
    const clock = createFakeClock();

    await assert.rejects(
        waitForPagesRunCompletion({
            mergeCommitSha,
            runId,
            runGh: async () => JSON.stringify(createRun({
                status: 'completed',
                conclusion
            })),
            timeoutMs: 20_000,
            now: clock.now,
            sleep: clock.sleep
        }),
        new RegExp(`${conclusion}.*${runId}`)
    );
    assert.deepEqual(clock.sleeps, []);
}

{
    const clock = createFakeClock();
    let calls = 0;

    await assert.rejects(
        waitForPagesRunCompletion({
            mergeCommitSha,
            runId,
            runGh: async () => {
                calls += 1;
                return JSON.stringify(queuedRun);
            },
            timeoutMs: 12_000,
            pollIntervalMs: 5_000,
            now: clock.now,
            sleep: clock.sleep
        }),
        /12 seconds.*last status: queued.*33035787966/
    );
    assert.equal(calls, 3);
    assert.deepEqual(clock.sleeps, [5_000, 5_000, 2_000]);
}

{
    const clock = createFakeClock();
    const calls = [];
    const completedRun = await verifyPagesDeploymentRun({
        mergeCommitSha,
        runGh: async (argumentsList, options) => {
            calls.push({ argumentsList, options });

            if (argumentsList[1] === 'list') {
                return JSON.stringify([queuedRun]);
            }

            return { stdout: JSON.stringify(successfulRun) };
        },
        registrationTimeoutMs: 10_000,
        completionTimeoutMs: 10_000,
        pollIntervalMs: 1_000,
        commandTimeoutMs: 3_000,
        now: clock.now,
        sleep: clock.sleep
    });

    assert.equal(completedRun.databaseId, runId);
    assert.equal(completedRun.conclusion, 'success');
    assert.deepEqual(calls.map(call => call.argumentsList), [
        createPagesRunListArguments(mergeCommitSha),
        createPagesRunViewArguments(runId)
    ]);
    assert.deepEqual(calls.map(call => call.options.timeoutMs), [3_000, 3_000]);
    assert.deepEqual(clock.sleeps, []);
}

await assert.rejects(
    waitForPagesRunRegistration({
        mergeCommitSha,
        runGh: async () => ({}),
        timeoutMs: 1_000,
        now: () => 0,
        sleep: async () => {}
    }),
    /did not return stdout/
);
await assert.rejects(
    waitForPagesRunRegistration({
        mergeCommitSha,
        runGh: null,
        timeoutMs: 1_000,
        now: () => 0,
        sleep: async () => {}
    }),
    /gh-command function/
);
await assert.rejects(
    waitForPagesRunRegistration({
        mergeCommitSha,
        runGh: async () => '[]',
        timeoutMs: 0,
        now: () => 0,
        sleep: async () => {}
    }),
    /timeout must be a positive number/
);

console.log('Pages deployment verification tests passed.');

function createRun(overrides = {}) {
    return {
        databaseId: runId,
        conclusion: null,
        event: 'push',
        headBranch: 'main',
        headSha: mergeCommitSha,
        status: 'queued',
        url: runUrl,
        workflowName: 'Deploy to GitHub Pages',
        ...overrides
    };
}

function createFakeClock() {
    let current = 0;
    const sleeps = [];

    return {
        sleeps,
        now: () => current,
        sleep: async milliseconds => {
            sleeps.push(milliseconds);
            current += milliseconds;
        },
        value: () => current
    };
}
