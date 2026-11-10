// The change-tier classifier's contract.
//
// The classifier decides regression scope. It is advisory: the full suite stays
// the required check, and a narrowed run is evidence, not a gate. So the thing
// this check must establish is not "the classifier is useful" but "the
// classifier is never quietly wrong" -- every case it cannot narrow falls to
// `full` with a reviewed reason, and the one case it exists for, the routine
// data refresh, is pinned to diffs that actually happened.
//
// Properties, not samples, wherever a property is available. Monotonicity and
// the union rule catch a whole class of predicate bug that example tests walk
// straight past: a classifier that selects FEWER checks for a bigger change.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    assessChangeTier,
    readRegisteredCheckCommands,
    readRegisteredChecks
} from '../scripts/classify-change-tier.mjs';
import {
    checksForTier,
    dataSurfaceExceptions,
    dataTierChecks,
    floorChecks,
    fullTierReasons,
    maximumNarrowedFileCount,
    tierNames
} from '../scripts/change-tiers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registeredChecks = readRegisteredChecks(repoRoot);

assert.ok(registeredChecks.length >= 100, `expected the full check list, parsed ${registeredChecks.length}`);

// Changed entries for a complete refresh, from the recorded real diffs.
const recorded = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'real-data-refreshes.json'), 'utf8'));

assert.equal(recorded.refreshes.length, 3, 'three real refreshes are recorded');

function modified(files) {
    return files.map(file => ({ status: 'M', path: file }));
}

/**
 * The metadata a complete refresh presents: every CSV already existed at both
 * commits with an unchanged header. Recorded rather than invented -- the real
 * release-path validator accepted all three of these diffs as complete
 * refreshes, which is exactly that assertion.
 */
function unchangedHeaders(files) {
    return new Map(files
        .filter(file => /^data\/.*\.csv$/i.test(file))
        .map(file => [file, { existsAtBase: true, existsAtHead: true, baseHeader: 'h', headHeader: 'h' }]));
}

function classify(files, overrides = {}) {
    const csvFiles = files.filter(file => /^data\/.*\.csv$/i.test(file));

    return assessChangeTier({
        changedEntries: overrides.changedEntries ?? modified(files),
        csvMetadata: overrides.csvMetadata ?? unchangedHeaders(files),
        expectedDataCsvFiles: overrides.expectedDataCsvFiles ?? csvFiles,
        registeredChecks
    });
}

// -- 1. The case it exists for: the three real refreshes -------------------

for (const refresh of recorded.refreshes) {
    const verdict = classify(refresh.files);

    assert.deepEqual(
        verdict,
        { tier: 'data', reason: null },
        `the real refresh in Pull Request #${refresh.pullRequest} must classify as the data tier, not ${verdict.tier}` +
        `${verdict.reason ? ` (${verdict.reason})` : ''}`
    );
    assert.equal(
        refresh.files.filter(file => /^data\/.*\.csv$/i.test(file)).length,
        72,
        `#${refresh.pullRequest} must carry the complete 72-CSV bundle`
    );
    assert.ok(
        refresh.files.includes('gallery-admin/generated/catalog-snapshot.js'),
        `#${refresh.pullRequest} must carry the regenerated catalogue`
    );
}

// The handoff note may travel with a refresh, and must not change the tier.
const withNote = classify([...recorded.refreshes[0].files, 'docs/active-work.md']);

assert.deepEqual(withNote, { tier: 'data', reason: null }, 'docs/active-work.md may travel with a refresh');

// -- 2. The catalogue: alone versus inside a bundle ------------------------
//
// This distinction is the whole reason the data tier is a bundle predicate
// rather than a union over paths. The catalogue lives under `gallery-admin/`,
// so a union rule reads a refresh as a gallery-admin change and runs the
// private media pipeline -- ten minutes of Cloudflare D1 parity -- on a CSV
// refresh. It did, in the first version of this design.

const catalogueAlone = classify(['gallery-admin/generated/catalog-snapshot.js']);

assert.deepEqual(
    catalogueAlone,
    { tier: 'full', reason: 'unmatched' },
    'the catalogue on its own is not a data refresh, and there is no gallery-admin tier to fall into'
);

const catalogueInBundle = classify(recorded.refreshes[0].files);

assert.equal(catalogueInBundle.tier, 'data', 'the same file inside a complete bundle is a data refresh');

// -- 3. Every fail-closed case, with its exact reason ----------------------

const bundle = recorded.refreshes[0].files;
const csvBundle = bundle.filter(file => /^data\/.*\.csv$/i.test(file));
const cases = [
    ['empty-diff', () => classify([], { changedEntries: [] })],
    ['diff-inputs', () => classify([], { changedEntries: 'not an array' })],
    ['diff-inputs', () => classify([], { changedEntries: [{ status: 'M' }] })],
    ['diff-too-large', () => classify([], {
        changedEntries: Array.from({ length: maximumNarrowedFileCount + 1 },
            (unused, index) => ({ status: 'M', path: `data/family/file-${index}.csv` }))
    })],
    ['malformed-path', () => classify([], { changedEntries: [{ status: 'M', path: '../outside.csv' }] })],
    ['malformed-path', () => classify([], { changedEntries: [{ status: 'M', path: '/etc/passwd' }] })],
    ['malformed-path', () => classify([], { changedEntries: [{ status: 'M', path: 'C:/windows' }] })],
    ['rename', () => classify([], { changedEntries: [{ status: 'R100', path: 'data/family/x.csv' }] })],
    ['deletion', () => classify([], { changedEntries: [{ status: 'D', path: 'data/family/x.csv' }] })],
    ['unsupported-status', () => classify([], { changedEntries: [{ status: 'U', path: 'data/family/x.csv' }] })],
    ['publishing-control', () => classify(['package.json'])],
    ['publishing-control', () => classify(['scripts/published-site-entries.mjs'])],
    ['decides-what-runs', () => classify(['scripts/run-all-tests.mjs'])],
    ['decides-what-runs', () => classify(['tests/browser-smoke.mjs'])],
    // A workflow file is BOTH; the classifier reports publishing-control
    // because it checks that first, and that is the stronger statement.
    ['publishing-control', () => classify(['.github/workflows/pr-checks.yml'])],
    ['decides-what-runs', () => classify(['.github/pull_request_template.md'])],
    // A partial bundle: one CSV changed where the head commit has 72.
    ['incomplete-bundle', () => classify([csvBundle[0]], { expectedDataCsvFiles: csvBundle })],
    // Complete list of paths, but one CSV is new rather than modified.
    ['incomplete-bundle', () => classify(bundle, {
        csvMetadata: new Map([...unchangedHeaders(bundle)].map(([file, meta], index) =>
            [file, index === 0 ? { ...meta, existsAtBase: false } : meta]))
    })],
    // Complete list of paths, but one header changed.
    ['incomplete-bundle', () => classify(bundle, {
        csvMetadata: new Map([...unchangedHeaders(bundle)].map(([file, meta], index) =>
            [file, index === 0 ? { ...meta, headHeader: 'different' } : meta]))
    })],
    // A refresh plus something that is not part of one.
    ['incomplete-bundle', () => classify([...bundle, 'index.html'])],
    ['unmatched', () => classify(['docs/active-work.md'])],
    ['unmatched', () => classify(['AGENTS.md'])],
    ['unmatched', () => classify(['index.html', 'gallery-admin/src/app.js'])],
    ['unmatched', () => classify(['gallery-admin/src/app.js'])],
    // Only the data tier is offered. A gallery-editorial tier and a runtime
    // tier were declared and then found unsafe by the read audit -- 9 and 55
    // holes -- so these fall to the full suite until they are audited and
    // mutation-tested as the data tier has been.
    ['unmatched', () => classify(['gallery-data/family.json'])],
    ['unmatched', () => classify(['index.html'])],
    ['unmatched', () => classify(['leaderboard.js'])],
    ['unmatched', () => classify(['vendor/chart.umd.min.js'])]
];

for (const [reason, run] of cases) {
    const verdict = run();

    assert.equal(verdict.tier, 'full', `expected full for ${reason}, got ${verdict.tier}`);
    assert.equal(verdict.reason, reason, `expected reason ${reason}, got ${verdict.reason}`);
}

// Every reason the classifier can give is in the bounded list, and every entry
// in that list is reachable -- an unreachable reason is a claim about a case
// that no longer exists.
const exercised = new Set(cases.map(([reason]) => reason));

for (const reason of exercised) {
    assert.ok(fullTierReasons.includes(reason), `${reason} must be a declared reason`);
}
for (const reason of fullTierReasons) {
    assert.ok(
        exercised.has(reason) || reason === 'no-saving',
        `${reason} is declared but no case reaches it; remove it or cover it`
    );
}

// Every narrowed tier must actually narrow, or it is the full suite under
// another name -- which is precisely why the gallery-admin tier was dropped
// after it measured 109 checks against the suite's 115.
for (const tier of tierNames) {
    const checks = checksForTier(tier, registeredChecks);

    if (checks) {
        assert.ok(
            checks.length < registeredChecks.length,
            `the ${tier} tier runs ${checks.length} of ${registeredChecks.length} checks, so it saves nothing`
        );
    }
}
assert.equal(checksForTier('gallery-admin', registeredChecks), null, 'there is no gallery-admin tier');

// -- 4. The declarations are about real checks ----------------------------

for (const tier of tierNames) {
    const checks = checksForTier(tier, registeredChecks);

    if (!checks) {
        continue;
    }
    for (const check of checks) {
        assert.ok(
            registeredChecks.includes(check),
            `${tier} names ${check}, which is not a registered check`
        );
    }
    assert.equal(new Set(checks).size, checks.length, `${tier} lists a check twice`);
}

// A tier names scripts, but a tier RUN must use the arguments the suite
// registers. Three checks verify rather than rewrite only because of a
// `--check` flag, so a runner that spawned the bare path would turn them into
// silent rewrites of the working tree. This pins that any such check appearing
// in a tier is one whose registered command carries its flags.
const commands = new Map(readRegisteredCheckCommands(repoRoot).map(command => [command.script, command.args]));

for (const tier of tierNames) {
    for (const check of checksForTier(tier, registeredChecks) || []) {
        const args = commands.get(check);

        assert.ok(args && args[0] === check, `${check} in ${tier} has no registered command`);

        if (/^scripts\/(?:sync-vendor|sync-private-face-detector|build-gallery-admin-catalog)\.mjs$/.test(check)) {
            assert.ok(
                args.includes('--check'),
                `${check} must be registered with --check, or running it verifies nothing and rewrites the tree`
            );
        }
    }
}

// -- 5. The floor ---------------------------------------------------------

assert.deepEqual(
    floorChecks,
    ['scripts/validate-repository-safety.mjs', 'tests/node-engine.mjs', 'tests/browser-runtime.mjs'],
    'the floor is three checks whose verdict any change can alter; the suite contracts belong to the scripts tier'
);
for (const tier of tierNames) {
    const checks = checksForTier(tier, registeredChecks);

    if (!checks) {
        continue;
    }
    for (const check of floorChecks) {
        assert.ok(checks.includes(check), `${tier} must include the floor check ${check}`);
    }
}

// -- 6. The data tier's membership is pinned ------------------------------
//
// So a change that silently widens or narrows the routine case shows up here as
// a diff to be reviewed, rather than as a quieter suite nobody noticed.

assert.deepEqual([...dataTierChecks].sort(), [
    'scripts/build-gallery-admin-catalog.mjs',
    'scripts/build-preview-artifact.mjs',
    'scripts/validate-csv.mjs',
    'scripts/validate-gallery.mjs',
    'tests/age-grade-contract.mjs',
    'tests/browser-smoke.mjs',
    'tests/export-bundle-validation.mjs',
    'tests/gallery-age-export.mjs',
    'tests/gallery-contract.mjs',
    'tests/gallery-photo-details.mjs',
    'tests/gallery-photo-review-browser.mjs',
    'tests/gallery-podium-framing-browser.mjs',
    'tests/gallery-thumbnail-layout.mjs',
    'tests/preview-artifact-safety.mjs',
    'tests/published-site-browser-root.mjs',
    'tests/staged-export-workflow.mjs',
    'tests/verify-production-data.mjs'
], 'the data tier changed; review why');

// The checks whose verdict a promoted bundle cannot alter must NOT be in it.
// These were in an earlier draft and are the clearest cases of the membership
// rule: each exercises a validator or the updater against fixtures it builds
// itself, so new CSVs cannot change its answer.
for (const check of [
    'tests/pages-deployment-verification.mjs',
    'tests/data-update-workspace.mjs',
    'tests/gallery-d1-expression-depth.mjs',
    ...dataSurfaceExceptions
]) {
    assert.equal(
        dataTierChecks.includes(check),
        false,
        `${check} is in the data tier, but a promoted bundle cannot change its verdict`
    );
}

// The exceptions are checks that DO read `data/`, which is the only reason they
// need declaring: without them the read audit would report four holes that are
// not holes. Each must be a registered check, or the declaration is stale.
for (const check of dataSurfaceExceptions) {
    assert.ok(registeredChecks.includes(check), `${check} is a declared data-surface exception but is not registered`);
}

// -- 7. Monotonicity and union -------------------------------------------
//
// A classifier that selects fewer checks for a bigger change is broken. Example
// tests cannot see that; these can.

const samples = [
    ['gallery-data/family.json'],
    ['gallery-data/family.json', 'gallery-data/everyone.json'],
    ['index.html'],
    ['index.html', 'site.css'],
    ['gallery-admin/src/app.js'],
    ['vendor/chart.umd.min.js'],
    ['index.html', 'gallery-data/family.json'],
    ['AGENTS.md']
];

function sizeOf(files) {
    const verdict = classify(files);
    const checks = checksForTier(verdict.tier, registeredChecks);

    return checks ? checks.length : registeredChecks.length;
}

for (const left of samples) {
    for (const right of samples) {
        const union = [...new Set([...left, ...right])];

        assert.ok(
            sizeOf(union) >= Math.max(sizeOf(left), sizeOf(right)),
            `adding files shrank the run: ${left.join(',')} + ${right.join(',')}`
        );
    }
}

// Widening the recorded refresh by anything outside a refresh must never give a
// smaller run than the refresh itself.
const refreshSize = sizeOf(recorded.refreshes[0].files);

for (const sample of samples) {
    assert.ok(
        sizeOf([...recorded.refreshes[0].files, ...sample]) >= refreshSize,
        `adding ${sample.join(',')} to a refresh shrank the run`
    );
}

// -- 8. The trace audit --------------------------------------------------
//
// The table above is a reviewed claim. This is the claim checked against what
// the checks demonstrably do: `scripts/trace-check-reads.mjs` runs every check
// once under an `fs` hook and records the repository files it opened, and a
// check that reads a tier's files while sitting outside that tier is a hole.
//
// One direction only. A check inside a tier that never opened one of its files
// is NOT a fault -- it may be responsible for a path it does not read, by
// asserting the file is absent or by asserting on output built from it.
// Tracing sees reads, never responsibility, which is why it audits the table
// rather than generating it.

const tracePath = path.join(repoRoot, 'tests', 'fixtures', 'check-read-surfaces.json');

assert.ok(
    fs.existsSync(tracePath),
    'tests/fixtures/check-read-surfaces.json is missing; run "node scripts/trace-check-reads.mjs"'
);

const trace = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
const tracedChecks = Object.keys(trace.surfaces);

for (const check of registeredChecks) {
    assert.ok(
        tracedChecks.includes(check),
        `${check} has no recorded read surface; re-run "node scripts/trace-check-reads.mjs"`
    );
}

// What counts as "a tier's files", for audit purposes only. Narrower than the
// classifier's predicates on purpose: these are the paths whose CONTENT a
// change alters, so a check reading them can have its verdict changed.
// Only the data surface, because only the data tier is offered. Auditing a
// tier that does not exist would report holes in nothing. The matchers for the
// editorial and runtime surfaces found 9 and 55 holes respectively, which is
// why those tiers were withdrawn rather than shipped.
const auditedTierPaths = {
    data: file => /^data\//.test(file)
};
const holes = [];

const auditExceptions = { data: new Set(dataSurfaceExceptions) };

for (const [tier, matches] of Object.entries(auditedTierPaths)) {
    const inTier = new Set(checksForTier(tier, registeredChecks));
    const excepted = auditExceptions[tier] || new Set();

    for (const check of registeredChecks) {
        if (inTier.has(check) || excepted.has(check)) {
            continue;
        }

        const offending = (trace.surfaces[check] || []).filter(matches);

        if (offending.length > 0) {
            holes.push(`${tier}: ${check} reads ${offending.slice(0, 3).join(', ')}` +
                `${offending.length > 3 ? ` and ${offending.length - 3} more` : ''}`);
        }
    }
}

assert.deepEqual(holes, [], `checks read a tier's files but are not in that tier: ${holes.join('; ')}`);

console.log(`Change-tier contract passed: ${recorded.refreshes.length} real refreshes classify as the data tier ` +
    `(${checksForTier('data').length} checks of ${registeredChecks.length}), ` +
    `${cases.length} fail-closed cases land in full with their declared reason, ` +
    `and the catalogue alone falls to full while the same file inside a complete bundle is data.`);
