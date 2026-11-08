import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    assessSuspension,
    createSuspensionWatch,
    defaultSampleIntervalMs,
    defaultThresholdMs,
    formatSuspensionVerdict,
    readClocks,
    suspensionExitCode
} from '../scripts/suspension-watch.mjs';

const intervalMs = defaultSampleIntervalMs;

// Builds samples `intervalMs` apart, optionally inserting a gap. `wallExtra`
// and `monoExtra` are added to that one step so each clock can be moved
// independently -- which is the whole point, since whether the monotonic clock
// accrues across a suspension is platform behaviour this must not depend on.
function samples(steps, { atStep = -1, wallExtra = 0, monoExtra = 0, label = null } = {}) {
    const built = [{ wall: 1_000_000, mono: 500, label: null }];

    for (let step = 1; step <= steps; step += 1) {
        const previous = built[step - 1];
        const applies = step === atStep;

        built.push({
            wall: previous.wall + intervalMs + (applies ? wallExtra : 0),
            mono: previous.mono + intervalMs + (applies ? monoExtra : 0),
            label: step === atStep ? label : null
        });
        if (applies) {
            built[step - 1].label = label;
        }
    }

    return built;
}

// -- A normal run says nothing ---------------------------------------------

assert.equal(assessSuspension(samples(20)), null, 'an unsuspended run must not be flagged');
assert.equal(assessSuspension([]), null, 'no samples cannot be a suspension');
assert.equal(assessSuspension([{ wall: 0, mono: 0 }]), null, 'one sample cannot show a gap');

// Ordinary jitter stays silent. A 29 s gap is under the 30 s threshold.
assert.equal(
    assessSuspension(samples(10, { atStep: 5, wallExtra: 29_000, monoExtra: 29_000 })),
    null,
    'a gap under the threshold must not be flagged'
);

// -- Wall clock late only: the suspension case on a platform whose -----------
// -- monotonic clock stops while suspended ---------------------------------

const wallOnly = assessSuspension(
    samples(20, { atStep: 7, wallExtra: 3_600_000, label: 'Gallery protected batch review refresh' })
);

assert.ok(wallOnly, 'a 60-minute wall-clock gap must be flagged');
assert.equal(wallOnly.clocks.join(','), 'wall');
assert.equal(Math.round(wallOnly.lateMs / 1000), 3600);
assert.equal(wallOnly.duringLabel, 'Gallery protected batch review refresh');

// -- Both clocks late: the case that would have been missed ----------------
//
// If `process.hrtime` accrues across Modern Standby, a detector keyed on the
// DIVERGENCE between the two clocks sees ~0 and stays silent on exactly the
// condition it exists to catch. Flagging when EITHER clock is late catches it.

const bothLate = assessSuspension(
    samples(20, { atStep: 7, wallExtra: 3_600_000, monoExtra: 3_600_000, label: 'Browser smoke tests' })
);

assert.ok(bothLate, 'a suspension must be flagged even when the monotonic clock continued through it');
assert.equal(bothLate.clocks.join(','), 'wall,monotonic');
assert.equal(Math.round(bothLate.lateMs / 1000), 3600);
assert.equal(bothLate.duringLabel, 'Browser smoke tests');

// -- Monotonic late only -----------------------------------------------------

const monoOnly = assessSuspension(samples(10, { atStep: 3, monoExtra: 120_000 }));

assert.ok(monoOnly, 'a monotonic-only gap must still be flagged');
assert.equal(monoOnly.clocks.join(','), 'monotonic');

// -- An NTP step is not a suspension ---------------------------------------
//
// A clock correction moves the wall clock without freezing the loop. Real
// corrections are sub-second; even a generous 500 ms is far under the
// threshold, so the simpler "either clock" rule costs nothing here.

assert.equal(
    assessSuspension(samples(10, { atStep: 4, wallExtra: 500 })),
    null,
    'an NTP-sized wall-clock step must not be reported as a suspension'
);

// -- The worst gap wins, and carries its own label -------------------------

const twoGaps = [
    { wall: 0, mono: 0, label: 'first check' },
    { wall: intervalMs + 60_000, mono: intervalMs, label: 'second check' },
    { wall: 2 * intervalMs + 60_000 + 600_000, mono: 2 * intervalMs, label: null }
];
const worst = assessSuspension(twoGaps);

assert.equal(Math.round(worst.lateMs / 1000), 600, 'the largest gap is reported');
assert.equal(worst.duringLabel, 'second check', 'the gap is attributed to what was running when it opened');

// -- The verdict line -------------------------------------------------------

const verdict = formatSuspensionVerdict(bothLate, { completed: 51, total: 109 });

assert.match(verdict, /^INVALID: /, 'the verdict must start with INVALID so a wrapper can parse it');
assert.match(verdict, /machine suspended for 3600 s/);
assert.match(verdict, /during "Browser smoke tests"/);
assert.match(verdict, /both clocks late/);
assert.match(verdict, /51 of 109 checks complete/);
assert.match(verdict, /neither a pass nor a failure/);
assert.match(formatSuspensionVerdict(wallOnly), /the wall clock late/);
assert.doesNotMatch(formatSuspensionVerdict(wallOnly), /checks complete/, 'progress is optional');

assert.equal(suspensionExitCode, 75, 'a suspended run must be distinguishable from a test failure');
assert.notEqual(suspensionExitCode, 1);
assert.equal(defaultThresholdMs, 30000);

// -- readClocks ------------------------------------------------------------

const read = readClocks(() => 1234, () => 5_000_000n);

assert.deepEqual(read, { wall: 1234, mono: 5 }, 'monotonic nanoseconds convert to milliseconds');

const live = readClocks();

assert.ok(Number.isFinite(live.wall) && live.wall > 0);
assert.ok(Number.isFinite(live.mono));

// -- The watch, driven without real timers ---------------------------------

let fire = null;
let cleared = false;
let clock = { wall: 0, mono: 0 };
const watch = createSuspensionWatch({
    intervalMs,
    clocks: () => ({ ...clock }),
    setIntervalImpl: callback => { fire = callback; return { unref() {} }; },
    clearIntervalImpl: () => { cleared = true; }
});

const advance = (wall, mono = wall) => { clock = { wall: clock.wall + wall, mono: clock.mono + mono }; fire(); };

watch.setLabel('Repository safety validation');
advance(intervalMs);
advance(intervalMs);
assert.equal(watch.assess(), null, 'a healthy watch reports nothing');

watch.setLabel('CSV validation');
advance(intervalMs + 3_600_000, intervalMs + 3_600_000);

const watched = watch.assess();

assert.ok(watched, 'the watch must detect a frozen interval');
assert.equal(watched.duringLabel, 'CSV validation', 'the label at the time of the gap is reported');
assert.equal(watched.clocks.join(','), 'wall,monotonic');

watch.stop();
assert.equal(cleared, true, 'stopping the watch clears its timer');
assert.ok(watch.samples.length > 4);

// -- Integration: the real runner, a failing check, a frozen clock ----------
//
// The unit tests above prove the assessment. This proves the wiring, on the one
// path that matters most and was wrong until it was tested: a check that FAILS
// during a suspension. Before this, suspension was assessed only after a check
// succeeded, so a rejection went straight out of the loop and exited 1 -- the
// exact shape of the two suite runs that were investigated for hours as code
// flakes.
//
// It drives `scripts/run-all-tests.mjs` itself through its `--self-test` seam,
// which replaces the check list and the watch's clock, so the runner's own
// failure path is what is under test and not a copy of it.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(repoRoot, 'test-artifacts');
const workspace = path.join(artifacts, `suspension-runner-${process.pid}`);

// A run killed part-way leaves its tree behind, so sweep before creating ours.
if (fs.existsSync(artifacts)) {
    for (const entry of fs.readdirSync(artifacts)) {
        if (entry.startsWith('suspension-runner-')) {
            fs.rmSync(path.join(artifacts, entry), { recursive: true, force: true });
        }
    }
}

fs.mkdirSync(workspace, { recursive: true });

try {
    const passingCheck = path.join(workspace, 'passing-check.mjs');
    const failingCheck = path.join(workspace, 'failing-check.mjs');

    fs.writeFileSync(passingCheck, 'console.log("fake check: ok");', 'utf8');
    fs.writeFileSync(
        failingCheck,
        'console.error("fake check: deliberate failure"); process.exit(1);',
        'utf8'
    );

    // The seam is refused when `CI` is set, so every arm states its own `CI`
    // rather than inheriting whatever the surrounding run has. That keeps this
    // test the same test locally and on GitHub Actions.
    const runSelfTest = (clockSteps, { ci = false, checks } = {}) => {
        const plan = path.join(workspace, 'plan.json');
        const environment = { ...process.env };

        delete environment.CI;

        if (ci) {
            environment.CI = 'true';
        }

        fs.writeFileSync(plan, JSON.stringify({
            checks: checks || [
                ['fake check that passes', [passingCheck]],
                ['fake check that fails', [failingCheck]]
            ],
            clockSteps
        }), 'utf8');

        const result = spawnSync(
            process.execPath,
            [path.join(repoRoot, 'scripts', 'run-all-tests.mjs'), '--self-test', plan],
            { cwd: repoRoot, encoding: 'utf8', env: environment, windowsHide: true }
        );

        assert.equal(result.error, undefined, 'the runner must start');

        return { ...result, output: `${result.stdout || ''}${result.stderr || ''}` };
    };

    // An hour of frozen clock opens between the two boundary samples, then the
    // second check fails.
    const suspendedRun = runSelfTest([
        { wall: 0, mono: 0 },
        { wall: 2_000, mono: 2_000 },
        { wall: 3_604_000, mono: 3_604_000 }
    ]);

    assert.ok(
        suspendedRun.output.includes('SELF-TEST:'),
        'the seam must announce itself, so its output can never be mistaken for a real run'
    );
    assert.ok(
        suspendedRun.output.includes('fake check: deliberate failure'),
        'the check really did run and really did fail'
    );
    assert.equal(
        suspendedRun.status,
        suspensionExitCode,
        `a check failing during a suspension must exit ${suspensionExitCode}, not 1; got ${suspendedRun.status}`
    );
    assert.ok(
        suspendedRun.output.includes('INVALID: machine suspended for 3597 s'),
        `the verdict must be printed on the failure path. Output was: ${suspendedRun.output}`
    );
    assert.ok(
        suspendedRun.output.includes('1 of 2 checks complete'),
        'the failing check must not be counted as complete'
    );
    assert.ok(
        !suspendedRun.output.includes('failed with exit code 1'),
        'the suspension verdict replaces the failure report; reporting both invites the wrong conclusion'
    );

    // Control: the same failing check with healthy clocks must stay an ordinary
    // test failure. Otherwise the detector would be hiding real breakage.
    const failedRun = runSelfTest([
        { wall: 0, mono: 0 },
        { wall: 2_000, mono: 2_000 },
        { wall: 4_000, mono: 4_000 }
    ]);

    assert.equal(failedRun.status, 1, 'a failing check on an awake machine is a failure, not INVALID');
    assert.ok(
        failedRun.output.includes('failed with exit code 1'),
        'the real failure must still be reported'
    );
    assert.ok(!failedRun.output.includes('INVALID'), 'nothing was suspended, so nothing is INVALID');

    // A self-test run must never exit 0, whatever the injected checks do, and
    // must never print the line that means the repository passed. Otherwise an
    // accidental `--self-test` -- or a copied command line -- could be read as
    // a clean suite.
    const passingRun = runSelfTest(
        [{ wall: 0, mono: 0 }, { wall: 2_000, mono: 2_000 }, { wall: 4_000, mono: 4_000 }],
        { checks: [['fake check that passes', [passingCheck]]] }
    );

    assert.notEqual(passingRun.status, 0, 'a self-test run must never exit 0');
    assert.equal(passingRun.status, 70, `a completed self-test exits 70; got ${passingRun.status}`);
    assert.ok(
        !passingRun.output.includes('All checks passed.'),
        'the line that means this repository passed must not appear in a self-test run'
    );
    assert.equal(
        passingRun.stdout.trim().split(String.fromCharCode(10)).at(-1).trim(),
        'SELF-TEST COMPLETE: the injected check list passed. This is not a result for this repository.',
        'the last thing a self-test prints must say what it was'
    );

    // Refused in CI outright. The seam exists to prove this runner's own
    // failure path on a developer machine; in CI the only meaningful run is
    // the real suite.
    const refusedRun = runSelfTest([{ wall: 0, mono: 0 }], { ci: true });

    assert.equal(refusedRun.status, 1, 'CI must refuse the seam');
    assert.ok(refusedRun.output.includes('--self-test'), 'the refusal must name what was refused');
    assert.ok(
        refusedRun.output.includes('the only meaningful run is the real suite'),
        `the refusal must say why. Output was: ${refusedRun.output}`
    );
    assert.ok(
        !refusedRun.output.includes('fake check'),
        'the injected checks must not run at all when CI is set'
    );
    assert.ok(!refusedRun.output.includes('SELF-TEST COMPLETE'), 'a refused run completed nothing');
} finally {
    fs.rmSync(workspace, { recursive: true, force: true });
}

console.log('Suspension watch contract passed: either-clock lateness, label attribution, NTP immunity, exit 75 on the failure path, self-test seam refused in CI and never exiting 0.');
