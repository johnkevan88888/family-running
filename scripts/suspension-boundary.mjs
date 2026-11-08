// Suspension detection for the guided data updater.
//
// The updater cannot use the interval watch in `scripts/suspension-watch.mjs`:
// every command it runs goes through `spawnSync`, so its event loop is dead for
// the whole of the workbook export, the test suite and each check wait --
// exactly when detection matters most. An interval would simply never fire.
//
// So the updater asks the operating system instead. At each phase boundary it
// queries the Windows System log for the power events that mark a suspension,
// over the window since the previous boundary. That is the same evidence that
// diagnosed the two suspended suite runs, and it needs no elevation.
//
// Failure policy, deliberately asymmetric:
//
//   query unavailable  -> warn and continue, at every boundary. A routine
//                         refresh must never be refused because a log could not
//                         be read; that would turn a diagnostic into an outage.
//   positive evidence  -> stop at one boundary only, and warn at the rest. See
//                         `boundaryPolicies` below for why.
//
// The wall-versus-monotonic comparison is the non-Windows fallback. It is
// deliberately warn-only: at a boundary there is no interval to be late, so the
// only available signal is divergence between the clocks, and divergence
// vanishes if the monotonic clock accrues across a suspension. It can say
// "something looks wrong"; it cannot establish that nothing happened.

import { execFileSync } from 'node:child_process';
import { readClocks } from './suspension-watch.mjs';

export const suspensionEventIds = Object.freeze([42, 107, 506, 507]);
export const suspensionProviders = Object.freeze([
    'Microsoft-Windows-Kernel-Power',
    'Microsoft-Windows-Power-Troubleshooter'
]);
export const boundaryDivergenceThresholdMs = 30000;
export const suspendedRunMessage =
    'This run was suspended; start a fresh run. Its observations may be stale, ' +
    'so it must not continue to the next irreversible step.';
export const suspendedStepMessage =
    'Nothing is refused here: the step after this one re-checks what this run ' +
    'observed. Continuing. If its result looks wrong, re-run with --resume.';

// Which boundaries a suspension actually invalidates.
//
// Only the first one costs anything to repeat, and only the first one has no
// later re-check behind it. Everything after promotion is already re-verified
// by the step that follows:
//
//   the workbook export and staged validation -> STOP. A suspension here can
//       have straddled the export itself, and nothing later re-reads the
//       staged bundle. Repeating it costs one export.
//   promotion and the full test suite -> warn. `scripts/run-all-tests.mjs`
//       detects its own suspension and exits 75, so a suspended suite is
//       already reported as "did not complete" rather than as a pass.
//   the wait for GitHub checks -> warn. The checks run on GitHub, not here, and
//       the pre-merge re-read of PR identity plus `--match-head-commit` already
//       refuses a stale head. A laptop asleep while CI runs, or while John is
//       away from the prompt, must not cost a fresh export.
//   the merge -> warn, never stop. Live production verification follows, and it
//       is the authoritative re-check. Refusing here would abandon a completed
//       merge unverified, which is strictly worse than continuing.
export const boundaryPolicies = Object.freeze({
    'the workbook export and staged validation': 'stop',
    'promotion and the full test suite': 'warn',
    'the wait for GitHub checks': 'warn',
    'the merge': 'warn'
});

/**
 * An unlisted boundary stops, so adding a call site without deciding its policy
 * fails closed rather than silently warning. `tests/suspension-boundary.mjs`
 * asserts the updater's call sites and this table are the same set, so a typo
 * is a test failure rather than a refused refresh.
 */
export function boundaryPolicy(boundary) {
    return boundaryPolicies[boundary] === 'warn' ? 'warn' : 'stop';
}

/**
 * `wevtutil` arguments selecting the suspension events of the last
 * `windowMs` milliseconds. `timediff` is used rather than an absolute
 * timestamp so no date formatting can go wrong between locales.
 */
export function buildPowerEventQuery(windowMs) {
    const providers = suspensionProviders.map(name => `@Name='${name}'`).join(' or ');
    const ids = suspensionEventIds.map(id => `EventID=${id}`).join(' or ');
    const since = Math.max(1, Math.ceil(windowMs));

    return [
        'qe', 'System',
        `/q:*[System[Provider[${providers}] and (${ids}) and TimeCreated[timediff(@SystemTime) <= ${since}]]]`,
        '/f:xml',
        '/e:Events',
        '/c:50',
        '/rd:true'
    ];
}

/** Pulls `{ id, systemTime }` out of a `wevtutil /f:xml` document. */
export function parsePowerEvents(xml) {
    const events = [];
    const text = String(xml || '');
    const eventPattern = /<Event\b[\s\S]*?<\/Event>/g;
    let match;

    while ((match = eventPattern.exec(text)) !== null) {
        const block = match[0];
        const id = /<EventID[^>]*>(\d+)<\/EventID>/.exec(block);
        const time = /<TimeCreated[^>]*SystemTime=['"]([^'"]+)['"]/.exec(block);

        if (id && suspensionEventIds.includes(Number(id[1]))) {
            events.push({ id: Number(id[1]), systemTime: time ? time[1] : null });
        }
    }

    return events;
}

export function formatBoundaryVerdict(assessment, { policy = boundaryPolicy(assessment.boundary) } = {}) {
    if (assessment.state === 'suspended') {
        const ids = [...new Set(assessment.events.map(event => event.id))].sort((a, b) => a - b);
        const first = assessment.events.at(-1)?.systemTime || 'unknown time';
        const evidence = `the machine was suspended during "${assessment.boundary}" ` +
            `(System log power events ${ids.join(', ')}, earliest ${first}).`;

        return policy === 'warn'
            ? `Warning: ${evidence} ${suspendedStepMessage}`
            : `INVALID: ${evidence} ${suspendedRunMessage}`;
    }

    if (assessment.state === 'unverified') {
        return `Warning: could not read the System log to rule out a suspension during ` +
            `"${assessment.boundary}" (${assessment.detail}). Continuing; ` +
            `clock divergence was ${Math.round(assessment.divergenceMs / 1000)} s.`;
    }

    return `Warning: clocks diverged by ${Math.round(assessment.divergenceMs / 1000)} s during ` +
        `"${assessment.boundary}", which can indicate a suspension the System log did not report. Continuing.`;
}

/**
 * Creates a boundary checker. `assess(name)` reports on the window since the
 * previous call, then starts a new window.
 */
export function createBoundaryWatch({
    platform = process.platform,
    clocks = readClocks,
    runQuery = defaultRunQuery,
    divergenceThresholdMs = boundaryDivergenceThresholdMs
} = {}) {
    let previous = clocks();

    return {
        assess(boundary) {
            const now = clocks();
            const windowMs = Math.max(0, now.wall - previous.wall);
            const divergenceMs = Math.abs((now.wall - previous.wall) - (now.mono - previous.mono));

            previous = now;

            if (platform !== 'win32') {
                return divergenceMs > divergenceThresholdMs
                    ? { state: 'diverged', boundary, divergenceMs, windowMs }
                    : { state: 'clear', boundary, divergenceMs, windowMs };
            }

            let events;

            try {
                events = parsePowerEvents(runQuery(buildPowerEventQuery(windowMs)));
            } catch (error) {
                return {
                    state: 'unverified',
                    boundary,
                    divergenceMs,
                    windowMs,
                    detail: String(error?.message || error).split(String.fromCharCode(10))[0].trim()
                };
            }

            if (events.length > 0) {
                return { state: 'suspended', boundary, divergenceMs, windowMs, events };
            }

            // The log is authoritative here, so a divergence it does not
            // corroborate is reported but not acted on.
            return divergenceMs > divergenceThresholdMs
                ? { state: 'diverged', boundary, divergenceMs, windowMs }
                : { state: 'clear', boundary, divergenceMs, windowMs };
        }
    };
}

function defaultRunQuery(args) {
    return execFileSync('wevtutil.exe', args, {
        encoding: 'utf8',
        timeout: 20000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });
}
