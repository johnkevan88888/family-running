import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    boundaryDivergenceThresholdMs,
    boundaryPolicies,
    boundaryPolicy,
    buildPowerEventQuery,
    createBoundaryWatch,
    formatBoundaryVerdict,
    parsePowerEvents,
    suspendedRunMessage,
    suspendedStepMessage,
    suspensionEventIds,
    suspensionProviders
} from '../scripts/suspension-boundary.mjs';

// -- The query ---------------------------------------------------------------

const query = buildPowerEventQuery(600000);

assert.equal(query[0], 'qe');
assert.equal(query[1], 'System');
assert.ok(query.includes('/f:xml'));
assert.ok(query.includes('/rd:true'), 'newest events first, so a bounded count still sees the recent ones');

const filter = query.find(argument => argument.startsWith('/q:'));

for (const id of suspensionEventIds) {
    assert.match(filter, new RegExp(`EventID=${id}\\b`), `the query must select event ${id}`);
}
for (const provider of suspensionProviders) {
    assert.ok(filter.includes(provider), `the query must select provider ${provider}`);
}
assert.match(filter, /timediff\(@SystemTime\) <= 600000/, 'the window is relative, so no date formatting can go wrong');
assert.match(buildPowerEventQuery(0).find(a => a.startsWith('/q:')), /<= 1/, 'a zero window must stay a valid query');

// -- Parsing -----------------------------------------------------------------

const xml = [
    '<Events>',
    '<Event xmlns="http://schemas.microsoft.com/win/2004/08/events/event"><System>',
    '<Provider Name="Microsoft-Windows-Kernel-Power"/><EventID>506</EventID>',
    '<TimeCreated SystemTime="2026-11-06T19:52:14.1234567Z"/></System></Event>',
    '<Event><System><Provider Name="Microsoft-Windows-Kernel-Power"/><EventID>507</EventID>',
    '<TimeCreated SystemTime="2026-11-06T20:52:15.7654321Z"/></System></Event>',
    '</Events>'
].join('');
const parsed = parsePowerEvents(xml);

assert.equal(parsed.length, 2);
assert.deepEqual(parsed.map(event => event.id), [506, 507]);
assert.equal(parsed[0].systemTime, '2026-11-06T19:52:14.1234567Z');

assert.deepEqual(parsePowerEvents('<Events></Events>'), [], 'an empty result is not a suspension');
assert.deepEqual(parsePowerEvents(''), []);
assert.deepEqual(parsePowerEvents(undefined), []);
// `EventID` with qualifiers must still parse, and unrelated ids are ignored.
assert.deepEqual(
    parsePowerEvents('<Event><System><EventID Qualifiers="16384">42</EventID></System></Event>'),
    [{ id: 42, systemTime: null }]
);
assert.deepEqual(
    parsePowerEvents('<Event><System><EventID>566</EventID></System></Event>'),
    [],
    'a session-transition event is not one of the four we act on'
);

// -- Positive evidence stops the run ----------------------------------------

const steadyClocks = () => ({ wall: 1_000_000, mono: 1_000_000 });
const suspended = createBoundaryWatch({
    platform: 'win32',
    clocks: steadyClocks,
    runQuery: () => xml
}).assess('before merge');

assert.equal(suspended.state, 'suspended');
assert.deepEqual(suspended.events.map(event => event.id), [506, 507]);

const stopLine = formatBoundaryVerdict(suspended);

assert.match(stopLine, /^INVALID: /);
assert.match(stopLine, /suspended during "before merge"/);
assert.match(stopLine, /power events 506, 507/);
assert.ok(stopLine.includes(suspendedRunMessage));

// -- A clean log is clean ----------------------------------------------------

const clean = createBoundaryWatch({
    platform: 'win32',
    clocks: steadyClocks,
    runQuery: () => '<Events></Events>'
}).assess('before promote');

assert.equal(clean.state, 'clear');

// -- An unreadable log warns and never refuses ------------------------------
//
// A routine refresh must not be blocked because a diagnostic was unavailable.

for (const thrown of [
    new Error('wevtutil.exe ENOENT'),
    new Error('Access is denied.'),
    new Error('spawnSync wevtutil.exe ETIMEDOUT')
]) {
    const unverified = createBoundaryWatch({
        platform: 'win32',
        clocks: steadyClocks,
        runQuery: () => { throw thrown; }
    }).assess('before publish');

    assert.equal(unverified.state, 'unverified', `"${thrown.message}" must not refuse the run`);
    assert.notEqual(unverified.state, 'suspended');

    const line = formatBoundaryVerdict(unverified);

    assert.match(line, /^Warning: /, 'an unreadable log is a warning, not a verdict');
    assert.match(line, /Continuing/);
    assert.doesNotMatch(line, /INVALID/);
}

// -- The non-Windows fallback is warn-only ----------------------------------

let elsewhere = { wall: 0, mono: 0 };
const fallback = createBoundaryWatch({
    platform: 'linux',
    clocks: () => ({ ...elsewhere }),
    runQuery: () => { throw new Error('wevtutil is not a thing here'); }
});

elsewhere = { wall: 60_000, mono: 60_000 };
assert.equal(fallback.assess('phase one').state, 'clear', 'matching clocks are clear');

// Wall advanced an hour while the monotonic clock did not: the classic shape
// of a suspension on a platform whose monotonic clock stops.
elsewhere = { wall: 60_000 + 3_600_000, mono: 60_000 + 1_000 };

const diverged = fallback.assess('phase two');

assert.equal(diverged.state, 'diverged');
assert.ok(diverged.divergenceMs > boundaryDivergenceThresholdMs);
assert.match(formatBoundaryVerdict(diverged), /^Warning: /);
assert.doesNotMatch(
    formatBoundaryVerdict(diverged),
    /INVALID/,
    'divergence alone cannot establish a suspension, so it must not stop a refresh'
);

// -- Windows: the log outranks divergence -----------------------------------
//
// If the log is readable and clean, a divergence is reported but not acted on.

let windows = { wall: 0, mono: 0 };
const windowsWatch = createBoundaryWatch({
    platform: 'win32',
    clocks: () => ({ ...windows }),
    runQuery: () => '<Events></Events>'
});

windows = { wall: 3_600_000, mono: 1_000 };

const corroborated = windowsWatch.assess('before verification');

assert.equal(corroborated.state, 'diverged', 'a clean log downgrades divergence to a warning');
assert.notEqual(corroborated.state, 'suspended');

// -- The window is measured from the previous boundary ----------------------

const windows2 = [{ wall: 0, mono: 0 }, { wall: 125_000, mono: 125_000 }, { wall: 200_000, mono: 200_000 }];
let index = 0;
const observedWindows = [];
const windowed = createBoundaryWatch({
    platform: 'win32',
    clocks: () => windows2[Math.min(index++, windows2.length - 1)],
    runQuery: args => {
        observedWindows.push(Number(/<= (\d+)/.exec(args.find(a => a.startsWith('/q:')))[1]));
        return '<Events></Events>';
    }
});

windowed.assess('first');
windowed.assess('second');
assert.deepEqual(observedWindows, [125_000, 75_000], 'each window covers only since the previous boundary');

// -- The per-boundary stop/warn split ---------------------------------------
//
// Only the first boundary stops. Every later one is followed by its own
// re-check -- the suite's own exit 75, the pre-merge re-read of PR identity
// with --match-head-commit, live production verification -- so a sleep while CI
// runs, or while nobody is at the prompt, must not cost a fresh export. Nor may
// a suspension abandon a completed merge before it has been verified live.

assert.equal(boundaryPolicy('the workbook export and staged validation'), 'stop');
assert.equal(boundaryPolicy('promotion and the full test suite'), 'warn');
assert.equal(boundaryPolicy('the wait for GitHub checks'), 'warn');
assert.equal(boundaryPolicy('the merge'), 'warn');
assert.equal(
    boundaryPolicy('a boundary nobody has decided a policy for'),
    'stop',
    'an unlisted boundary must fail closed rather than silently warn'
);

const stopVerdict = formatBoundaryVerdict({ ...suspended, boundary: 'the workbook export and staged validation' });

assert.ok(stopVerdict.startsWith('INVALID: '), 'the one stopping boundary still reports INVALID');
assert.ok(stopVerdict.includes(suspendedRunMessage));
assert.ok(stopVerdict.includes('start a fresh run'), 'repeating the export is the whole cost here');

for (const boundary of ['promotion and the full test suite', 'the wait for GitHub checks', 'the merge']) {
    const warnVerdict = formatBoundaryVerdict({ ...suspended, boundary });

    assert.ok(warnVerdict.startsWith('Warning: '), `${boundary} must warn, not refuse`);
    assert.ok(!warnVerdict.includes('INVALID'), `${boundary} must not be reported as INVALID`);
    assert.ok(
        !warnVerdict.includes('start a fresh run'),
        `${boundary} is past the export, so a fresh run must never be demanded`
    );
    assert.ok(warnVerdict.includes('--resume'), 'the most it may ask for is a resume');
    assert.ok(warnVerdict.includes(suspendedStepMessage));
    assert.ok(warnVerdict.includes('power events 506, 507'), 'the evidence is still reported');
    assert.ok(warnVerdict.includes(`during "${boundary}"`));
}

// An explicit policy overrides the table, which is how the updater passes the
// decision it has already made rather than re-deriving it from a string.
assert.ok(
    formatBoundaryVerdict({ ...suspended, boundary: 'the merge' }, { policy: 'stop' }).startsWith('INVALID: ')
);

// -- The table and the updater's call sites are the same set ----------------
//
// So a renamed or mistyped boundary is a test failure here, rather than an
// unlisted boundary quietly failing closed and refusing a routine refresh.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const updater = fs.readFileSync(path.join(repoRoot, 'scripts', 'simple-data-update.mjs'), 'utf8');
const callSites = updater
    .split("requireNoSuspension('")
    .slice(1)
    .map(fragment => fragment.slice(0, fragment.indexOf("'")));

assert.ok(callSites.length >= 4, `expected the updater's four phase boundaries, found ${callSites.length}`);
assert.deepEqual(
    [...new Set(callSites)].sort(),
    Object.keys(boundaryPolicies).sort(),
    'every boundary the updater checks must have a decided policy, and the table must list no boundary that no longer exists'
);

console.log('Suspension boundary contract passed: export stops, later boundaries warn, unreadable log warns, divergence never refuses.');
