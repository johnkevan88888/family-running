import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserResource, dataUpdateResource, resourceCapacity } from '../scripts/check-lanes.mjs';

// Drives `scripts/run-all-tests.mjs` itself through its `--self-test` seam with
// fake checks that record when they start and stop. What matters about a
// parallel runner is not that it is faster: it is that each check still runs
// exactly once, that checks which must not overlap do not, and that a failure
// is still reported where a human will see it.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = path.join(repoRoot, 'scripts', 'run-all-tests.mjs');
const artifacts = path.join(repoRoot, 'test-artifacts');
const workspace = path.join(artifacts, `parallel-runner-${process.pid}`);

// A run killed part-way leaves its tree behind, so sweep before creating ours.
if (fs.existsSync(artifacts)) {
    for (const entry of fs.readdirSync(artifacts)) {
        if (entry.startsWith('parallel-runner-')) {
            fs.rmSync(path.join(artifacts, entry), { recursive: true, force: true });
        }
    }
}

fs.mkdirSync(workspace, { recursive: true });

try {
    // Records its own start and end around a fixed sleep, so overlap is
    // observable from the outside without trusting the runner's own report.
    const fakeCheck = path.join(workspace, 'fake-check.mjs');

    fs.writeFileSync(fakeCheck, [
        "import fs from 'node:fs';",
        'const [, , log, label, sleepMs, exitCode] = process.argv;',
        "fs.appendFileSync(log, `start|${label}|${Date.now()}\\n`);",
        'await new Promise(resolve => setTimeout(resolve, Number(sleepMs)));',
        "fs.appendFileSync(log, `end|${label}|${Date.now()}\\n`);",
        'console.log(`fake check ${label} ran`);',
        'process.exit(Number(exitCode));'
    ].join('\n'), 'utf8');

    let runCounter = 0;

    const run = ({ plan, jobs, env = {} }) => {
        const log = path.join(workspace, `events-${runCounter}.log`);
        const planPath = path.join(workspace, `plan-${runCounter}.json`);

        runCounter += 1;
        fs.writeFileSync(log, '', 'utf8');
        fs.writeFileSync(planPath, JSON.stringify({
            checks: plan.map(entry => [
                entry.label,
                [fakeCheck, log, entry.label, String(entry.sleepMs ?? 200), String(entry.exitCode ?? 0)],
                ...(entry.resources ? [entry.resources] : [])
            ])
        }), 'utf8');

        const environment = { ...process.env, ...env };

        delete environment.CI;
        if (!('FAMILY_RUNNING_TEST_JOBS' in env)) {
            delete environment.FAMILY_RUNNING_TEST_JOBS;
        }

        const result = spawnSync(
            process.execPath,
            [runner, '--self-test', planPath, ...(jobs === undefined ? [] : [`--jobs=${jobs}`])],
            { cwd: repoRoot, encoding: 'utf8', env: environment, windowsHide: true }
        );

        assert.equal(result.error, undefined, 'the runner must start');

        const events = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
            .map(line => {
                // Pipe-delimited: real check labels contain spaces.
                const [kind, label, at] = line.split('|');

                return { kind, label, at: Number(at) };
            });

        return { ...result, output: `${result.stdout || ''}${result.stderr || ''}`, events };
    };

    const spans = events => {
        const open = new Map();
        const built = [];

        for (const event of events) {
            if (event.kind === 'start') {
                open.set(event.label, event.at);
            } else {
                built.push({ label: event.label, from: open.get(event.label), to: event.at });
                open.delete(event.label);
            }
        }

        return built;
    };
    const overlaps = (first, second) => first.from < second.to && second.from < first.to;
    // True simultaneity, by sweeping the timeline. Counting how many spans each
    // span touches measures something else entirely: A overlapping B and B
    // overlapping C gives three, while only ever two ran at once.
    //
    // Ends are processed before starts at an equal timestamp, because
    // `Date.now()` is millisecond-granular and one check finishing as another
    // begins is not two checks running.
    const peak = list => {
        const edges = list
            .flatMap(span => [{ at: span.from, change: 1 }, { at: span.to, change: -1 }])
            .sort((first, second) => first.at - second.at || first.change - second.change);
        let running = 0;
        let most = 0;

        for (const edge of edges) {
            running += edge.change;
            most = Math.max(most, running);
        }

        return most;
    };

    const eight = Array.from({ length: 8 }, (unused, index) => ({ label: `check ${index + 1}` }));

    // -- Each check runs exactly once. No retries, anywhere. --------------

    const parallel = run({ plan: eight, jobs: 4 });

    assert.equal(parallel.status, 70, `a completed self-test exits 70; got ${parallel.status}`);
    assert.equal(parallel.events.filter(event => event.kind === 'start').length, 8);

    for (const check of eight) {
        assert.equal(
            parallel.events.filter(event => event.kind === 'start' && event.label === check.label).length,
            1,
            `${check.label} must be started exactly once; a retry would start it again`
        );
    }

    // -- Checks really do overlap ----------------------------------------

    const parallelSpans = spans(parallel.events);

    assert.equal(parallelSpans.length, 8);
    assert.ok(
        peak(parallelSpans) > 1,
        `--jobs=4 must actually overlap checks; peak concurrency was ${peak(parallelSpans)}`
    );
    assert.ok(
        peak(parallelSpans) <= 4,
        `--jobs=4 must never exceed four at once; peak concurrency was ${peak(parallelSpans)}`
    );

    // -- Buffered output, one block per check ----------------------------

    for (const check of eight) {
        assert.ok(parallel.output.includes(`== ${check.label} ==`), `${check.label} must get its header`);
        assert.ok(parallel.output.includes(`fake check ${check.label} ran`), `${check.label} output must be kept`);
    }

    // The block is contiguous: the check's own output follows its header with
    // nothing from another check in between.
    for (const check of eight) {
        const headerText = `== ${check.label} ==`;
        const header = parallel.output.indexOf(headerText);
        const body = parallel.output.indexOf(`fake check ${check.label} ran`, header);
        // From AFTER the header: the header itself contains "== check ".
        const between = parallel.output.slice(header + headerText.length, body);

        assert.ok(body > header, `${check.label} output must follow its own header`);
        assert.equal(
            between.includes('== check '),
            false,
            `${check.label} block must not be interleaved with another check`
        );
    }

    // -- A mutex resource is respected -----------------------------------

    const exclusive = run({
        jobs: 4,
        plan: [
            { label: 'shared one', resources: [dataUpdateResource] },
            { label: 'shared two', resources: [dataUpdateResource] },
            { label: 'shared three', resources: [dataUpdateResource] },
            { label: 'free one' },
            { label: 'free two' },
            { label: 'free three' }
        ]
    });

    assert.equal(exclusive.status, 70);

    const exclusiveSpans = spans(exclusive.events).filter(span => span.label.startsWith('shared'));

    assert.equal(exclusiveSpans.length, 3);
    assert.equal(resourceCapacity[dataUpdateResource], 1);

    for (const first of exclusiveSpans) {
        for (const second of exclusiveSpans) {
            if (first !== second) {
                assert.equal(
                    overlaps(first, second),
                    false,
                    `${first.label} and ${second.label} share a fixed path and must never overlap`
                );
            }
        }
    }

    // The run as a whole still overlapped, so exclusion is doing something
    // narrower than serialising everything.
    assert.ok(peak(spans(exclusive.events)) > 1, 'only the exclusive checks are serialised');

    // -- A capped resource is capped, not serialised ----------------------

    const capped = run({
        jobs: 4,
        plan: Array.from({ length: 6 }, (unused, index) => ({
            label: `browser ${index + 1}`,
            resources: [browserResource]
        }))
    });

    assert.equal(capped.status, 70);
    assert.equal(
        peak(spans(capped.events)) <= resourceCapacity[browserResource],
        true,
        `at most ${resourceCapacity[browserResource]} browser checks may run at once`
    );

    // -- Failures are re-printed together, in registration order ----------
    //
    // The later check finishes FIRST, so completion order and registration
    // order disagree and the report has to choose.

    const failing = run({
        jobs: 4,
        plan: [
            { label: 'passes first', sleepMs: 50 },
            { label: 'fails second', sleepMs: 400, exitCode: 1 },
            { label: 'passes third', sleepMs: 50 },
            { label: 'fails fourth', sleepMs: 50, exitCode: 1 }
        ]
    });

    assert.equal(failing.status, 1, 'a failing parallel run exits 1');
    assert.ok(!failing.output.includes('All checks passed.'));
    assert.ok(!failing.output.includes('SELF-TEST COMPLETE'), 'a run with failures completed nothing');
    assert.match(failing.output, /2 checks failed, in registration order:/);

    const report = failing.output.slice(failing.output.indexOf('2 checks failed, in registration order:'));

    assert.ok(
        report.indexOf('== fails second ==') < report.indexOf('== fails fourth =='),
        'the earlier registered failure must be printed first, whatever order they completed in'
    );
    assert.ok(
        report.includes('failed with exit code 1'),
        'the re-printed block must still say how the check failed'
    );
    assert.ok(
        report.includes('fake check fails second ran'),
        'the re-printed block must carry the failing check output, not just its name'
    );

    // Nothing is retried after a failure either.
    for (const label of ['fails second', 'fails fourth']) {
        assert.ok(
            failing.events.filter(event => event.kind === 'start' && event.label === label).length <= 1,
            `${label} must not be retried`
        );
    }

    // -- --jobs=1 is the revert: registration order, nothing buffered -----

    const serial = run({ plan: eight, jobs: 1 });

    assert.equal(serial.status, 70);
    assert.deepEqual(
        spans(serial.events).map(span => span.label),
        eight.map(check => check.label),
        '--jobs=1 must run the checks in registration order'
    );
    assert.equal(peak(spans(serial.events)), 1, '--jobs=1 must never overlap two checks');
    assert.equal(
        serial.output.includes('Output is buffered per check'),
        false,
        '--jobs=1 must not announce a parallel plan'
    );

    // No --jobs at all must behave exactly like --jobs=1, because that is what
    // every existing caller passes.
    const defaulted = run({ plan: eight });

    assert.equal(defaulted.status, 70);
    assert.equal(peak(spans(defaulted.events)), 1, 'the default must stay one check at a time');
    assert.deepEqual(spans(defaulted.events).map(span => span.label), eight.map(check => check.label));

    // -- FAMILY_RUNNING_TEST_JOBS, for callers that pass no arguments -----

    const fromEnvironment = run({ plan: eight, env: { FAMILY_RUNNING_TEST_JOBS: '4' } });

    assert.equal(fromEnvironment.status, 70);
    assert.ok(
        peak(spans(fromEnvironment.events)) > 1,
        'FAMILY_RUNNING_TEST_JOBS must widen a run that passes no flag'
    );

    // An explicit flag wins over the environment, so a command line is never
    // overridden by something ambient.
    const flagWins = run({ plan: eight, jobs: 1, env: { FAMILY_RUNNING_TEST_JOBS: '4' } });

    assert.equal(peak(spans(flagWins.events)), 1, '--jobs=1 must win over the environment');

    // -- A nonsense width is refused, not guessed -------------------------

    for (const bad of ['0', '-2', '2.5', 'four', '']) {
        const refused = run({ plan: eight, jobs: bad });

        assert.equal(refused.status, 1, `--jobs=${bad} must be refused`);
        assert.equal(refused.events.length, 0, `--jobs=${bad} must refuse before running anything`);
        assert.ok(
            refused.output.includes('--jobs must be a whole number of 1 or more'),
            `--jobs=${bad} must say what is wrong`
        );
    }
} finally {
    fs.rmSync(workspace, { recursive: true, force: true });
}

console.log('Parallel runner contract passed: every check runs once, real overlap, mutex and cap respected, ' +
    'buffered blocks kept whole, failures re-printed in registration order, and --jobs=1 unchanged.');
