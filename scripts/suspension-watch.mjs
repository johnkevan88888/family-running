// Detects a machine suspension during a long run, and reports it as something
// other than a test failure.
//
// Why this exists: two full-suite runs failed and were investigated as code
// flakes before the Windows System event log showed the machine had entered
// Modern Standby mid-run. One run began 17 minutes before the standby entry
// and failed in the check that straddled it; another ran entirely inside a
// 43-minute standby window. Both surfaced through waits that had expired, so
// they presented as content faults -- "progression chart did not fit its
// available width", `expected 'unmerged-review'` -- and cost hours of
// investigation that the first line of a log could have ended.
//
// A suspended run is not evidence either way. It is neither a pass nor a
// failure, so it exits 75 (EX_TEMPFAIL) with an `INVALID:` line rather than 1.
//
// The report names every check in flight when the gap opened. Under a parallel
// runner several are, and which of them straddled the freeze is not knowable
// from here, so all of them are named rather than one of them guessed.
//
// The signal is the event loop. A 5-second interval that next fires 3,600
// wall-seconds later proves the process was frozen, because the loop cannot run
// while the machine is suspended. Lateness is checked on BOTH clocks and either
// one exceeding the threshold is enough: whether `process.hrtime` accrues
// across Modern Standby is platform behaviour this must not depend on. If it
// does accrue, both clocks are late and the check still fires; if it does not,
// only the wall clock is late and the check still fires. NTP step corrections
// move the wall clock without freezing the loop, and are sub-second against a
// 30-second threshold.

export const suspensionExitCode = 75;
export const defaultSampleIntervalMs = 5000;
export const defaultThresholdMs = 30000;

/**
 * Reads both clocks at once. Wall is epoch milliseconds, which advances across
 * a suspension; monotonic is `process.hrtime.bigint()` in milliseconds, which
 * may or may not, depending on the platform.
 */
export function readClocks(now = Date.now, monotonic = process.hrtime.bigint) {
    return { wall: now(), mono: Number(monotonic() / 1000000n) };
}

/**
 * Given consecutive samples taken `intervalMs` apart, returns the largest gap
 * on either clock beyond what the interval accounts for, or null when nothing
 * exceeded the threshold.
 *
 * `labels` carries everything that was running when the gap opened, so the
 * report names the checks that straddled the suspension rather than the one
 * that happened to fail afterwards. With a parallel runner that is a set, not
 * a single check.
 */
export function assessSuspension(samples, { intervalMs = defaultSampleIntervalMs, thresholdMs = defaultThresholdMs } = {}) {
    let worst = null;

    for (let index = 1; index < samples.length; index += 1) {
        const previous = samples[index - 1];
        const current = samples[index];
        const wallLateMs = current.wall - previous.wall - intervalMs;
        const monoLateMs = current.mono - previous.mono - intervalMs;
        const lateMs = Math.max(wallLateMs, monoLateMs);

        if (lateMs <= thresholdMs) {
            continue;
        }
        if (!worst || lateMs > worst.lateMs) {
            worst = {
                lateMs,
                wallLateMs,
                monoLateMs,
                // Which clocks saw it, so a report distinguishes "the wall
                // clock jumped" from "the whole process was frozen".
                clocks: [
                    ...(wallLateMs > thresholdMs ? ['wall'] : []),
                    ...(monoLateMs > thresholdMs ? ['monotonic'] : [])
                ],
                duringLabels: previous.labels ?? [],
                fromWall: previous.wall,
                toWall: current.wall
            };
        }
    }

    return worst;
}

/** The single `INVALID:` line a suspended run ends with. */
export function formatSuspensionVerdict(assessment, { completed = null, total = null } = {}) {
    const seconds = Math.round(assessment.lateMs / 1000);
    const labels = assessment.duringLabels ?? [];
    // Name every check that was in flight. One of them straddled the gap and
    // nothing here can say which, so reporting one of several would be a
    // guess presented as a fact.
    const during = labels.length === 0
        ? ''
        : labels.length === 1
            ? ` during "${labels[0]}"`
            : ` during ${labels.length} checks in flight (${labels.map(label => `"${label}"`).join(', ')})`;
    const clocks = assessment.clocks.length === 2
        ? 'both clocks'
        : `the ${assessment.clocks[0]} clock`;
    const progress = completed !== null && total !== null
        ? `; ${completed} of ${total} checks complete`
        : '';

    return `INVALID: machine suspended for ${seconds} s${during} ` +
        `(${clocks} late; event loop frozen${progress}). ` +
        'This run is neither a pass nor a failure. Keep the machine awake and run it again.';
}

/**
 * Samples both clocks on an interval and lets the caller label what is running.
 * Safe to use from an entry point whose work is spawned asynchronously; it is
 * useless where work is synchronous, because the loop cannot fire at all.
 */
export function createSuspensionWatch({
    intervalMs = defaultSampleIntervalMs,
    thresholdMs = defaultThresholdMs,
    clocks = readClocks,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval
} = {}) {
    const samples = [{ ...clocks(), labels: [] }];
    const inFlight = new Set();
    const snapshot = () => [...inFlight].sort();
    const timer = setIntervalImpl(() => {
        samples.push({ ...clocks(), labels: snapshot() });
    }, intervalMs);

    timer.unref?.();

    return {
        /**
         * Records that a check has started, and samples the clocks.
         *
         * The boundary sample carries the set INCLUDING the new check, because
         * `assessSuspension` attributes a gap to the earlier sample of the
         * pair: the interval between this boundary and the next sample is
         * spent inside the checks named here, not the one that just finished.
         */
        startLabel(label) {
            inFlight.add(label);
            samples.push({ ...clocks(), labels: snapshot() });
        },
        /**
         * Records that a check has finished. Deliberately silent: a sample
         * here would carry the set MINUS that check, and a gap opening right
         * after it would then be attributed to whatever else happened to be
         * running rather than to the check that had just been running.
         */
        endLabel(label) {
            inFlight.delete(label);
        },
        stop() {
            clearIntervalImpl(timer);
            samples.push({ ...clocks(), labels: snapshot() });
        },
        get samples() {
            return samples;
        },
        assess() {
            return assessSuspension(samples, { intervalMs, thresholdMs });
        }
    };
}
