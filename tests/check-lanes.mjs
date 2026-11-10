import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    artifactScripts,
    browserResource,
    browserScripts,
    capacityFor,
    dataUpdateResource,
    dataUpdateScripts,
    gateScripts,
    phaseOf,
    publishedSiteScripts,
    resourceCapacity,
    resourcesFor
} from '../scripts/check-lanes.mjs';

// The scheduler in `scripts/run-all-tests.mjs` trusts these declarations. A
// check in the wrong group runs beside something it conflicts with and fails
// in a way that looks like a code fault, so both groups are DERIVED from the
// test sources here and compared with what is declared. A new browser check,
// or a new user of the shared data-update paths, fails this check rather than
// the suite it would have corrupted.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

// -- The registry --------------------------------------------------------

const runner = read('scripts/run-all-tests.mjs');
const listing = runner.slice(
    runner.indexOf('const repositoryChecks = ['),
    runner.indexOf(String.fromCharCode(10) + '];')
);
const registered = [];

for (const fragment of listing.split("    ['").slice(1)) {
    const label = fragment.slice(0, fragment.indexOf("'"));
    const after = fragment.slice(fragment.indexOf("', ["));
    // Up to the first quote, so a check with extra arguments -- for instance
    // ['scripts/sync-vendor.mjs', '--check'] -- yields the script alone.
    const start = after.indexOf("['") + 2;
    const script = after.slice(start, after.indexOf("'", start));

    registered.push({ label, script });
}

assert.ok(registered.length >= 100, `expected the full check list, parsed ${registered.length}`);
assert.equal(
    new Set(registered.map(check => check.label)).size,
    registered.length,
    'two checks share a label, so a buffered block could not be attributed'
);

// -- Every registered check has a phase, and every declaration is used ----

for (const { label, script } of registered) {
    assert.ok(['gate', 'artifact', 'pool'].includes(phaseOf(script)), `${label} has no phase`);
}

for (const [name, declared] of [['gate', gateScripts], ['artifact', artifactScripts]]) {
    for (const script of declared) {
        assert.ok(
            registered.some(check => check.script === script),
            `${script} is declared in the ${name} phase but is not a registered check`
        );
    }
}
for (const declared of [browserScripts, dataUpdateScripts]) {
    for (const script of declared) {
        assert.ok(
            registered.some(check => check.script === script),
            `${script} is declared as holding a resource but is not a registered check`
        );
    }
}

// The artifact phase must stay in this order: the build deletes and recreates
// `test-artifacts/preview-site`, and it runs before the browser lane.
assert.deepEqual(artifactScripts, [
    'tests/preview-artifact-safety.mjs',
    'scripts/build-preview-artifact.mjs'
]);
assert.ok(
    registered.findIndex(check => check.script === 'tests/preview-artifact-safety.mjs') <
    registered.findIndex(check => check.script === 'scripts/build-preview-artifact.mjs'),
    'registration order must already put the artifact checks in their phase order'
);

// Every check served from the published artifact must be registered AFTER the
// build. At --jobs=1 the runner follows registration order rather than the
// phases, so one registered above the build renders last run's artifact or is
// refused a document root -- neither of which is the site under test.
const buildAt = registered.findIndex(check => check.script === 'scripts/build-preview-artifact.mjs');

for (const script of publishedSiteScripts) {
    const at = registered.findIndex(check => check.script === script);

    assert.ok(at > buildAt, `${script} renders the published artifact, so it must be registered after the build`);
}

// -- The browser group, derived -------------------------------------------
//
// A check belongs to it when it IMPORTS `launchChromium`, or when it SPAWNS a
// check that does. Naming the function in a comment or a string does not count:
// `tests/browser-runtime.mjs` is the contract test and quotes it throughout
// without ever launching anything.
//
// The spawn case is not a technicality. A check that runs another check in a
// child process consumes a Chromium just as surely as one that launches it
// directly, and scheduling it as an ordinary check would let it start beside a
// full browser lane -- which is the contention this resource exists to cap.

const launchers = fs.readdirSync(path.join(repoRoot, 'tests'))
    .filter(name => name.endsWith('.mjs'))
    .filter(name => {
        const source = read(path.posix.join('tests', name));
        const at = source.indexOf("from '../scripts/browser-runtime.mjs'");

        if (at === -1) {
            return false;
        }

        // Back to the `import` that owns this specifier, so a multi-line
        // import block is read whole. A real import statement contains no
        // semicolon before its specifier, which is what rules out a match
        // inside prose: `import.meta.url` also contains "import", and the
        // span from it to a later mention would otherwise sweep up any
        // comment in between -- as it did for this very file.
        const block = source.slice(source.lastIndexOf('import', at), at);

        return !block.includes(';') && block.includes('launchChromium');
    })
    .map(name => path.posix.join('tests', name))
    .sort();

// A check that spawns one of those launchers holds the resource through its
// child. Matched on an actual child-process launch -- `spawn` with this Node
// binary -- together with the launcher's own path, so quoting a script name in
// prose is not enough.
//
// This file is excluded from its own scan. It is the deriver: it names every
// browser check and both needles, so it matches itself and launches nothing.
// The same trap caught the launcher derivation above, for the same reason.
const spawnNeedle = 'spawn(process.execPath';
const spawners = fs.readdirSync(path.join(repoRoot, 'tests'))
    .filter(name => name.endsWith('.mjs'))
    .map(name => path.posix.join('tests', name))
    .filter(script => script !== 'tests/check-lanes.mjs' && !launchers.includes(script))
    .filter(script => {
        const source = read(script);

        return source.includes(spawnNeedle) &&
            launchers.some(launcher => source.includes(`'${launcher}'`));
    })
    .sort();

assert.deepEqual(
    [...browserScripts].sort(),
    [...launchers, ...spawners].sort(),
    'every check that launches or spawns a Chromium must hold the browser resource, and nothing else may'
);
assert.deepEqual(
    spawners,
    ['tests/published-site-browser-root.mjs'],
    'the spawn case is one check; a second one means re-reading why it needs a child browser at all'
);
assert.equal(
    browserScripts.includes('tests/browser-runtime.mjs'),
    false,
    'the browser contract test names launchChromium but never launches it'
);

// -- The data-update group, derived ---------------------------------------
//
// A check belongs to it when it uses one of the fixed paths under
// `test-artifacts/` rather than a directory of its own.

const sharedPaths = ['worktrees', 'simple-data-update', 'workbook-export-staging'];
const sharers = fs.readdirSync(path.join(repoRoot, 'tests'))
    .filter(name => name.endsWith('.mjs'))
    .filter(name => {
        const source = read(path.posix.join('tests', name));

        return sharedPaths.some(shared =>
            source.includes(`'test-artifacts', '${shared}'`) ||
            source.includes(`test-artifacts/${shared}`));
    })
    .map(name => path.posix.join('tests', name))
    .sort();

assert.deepEqual(
    [...dataUpdateScripts].sort(),
    sharers,
    'every check using a fixed shared path under test-artifacts/ must hold the data-update resource'
);

// -- Resources and capacities --------------------------------------------

assert.deepEqual(resourcesFor('tests/browser-smoke.mjs'), [browserResource]);
assert.deepEqual(resourcesFor('tests/simple-data-update.mjs'), [dataUpdateResource]);
assert.deepEqual(resourcesFor('tests/analytics-config.mjs'), [], 'an ordinary check holds nothing');
assert.deepEqual(resourcesFor('tests/browser-runtime.mjs'), []);
assert.deepEqual(resourcesFor('tests/data-update-workspace.mjs'), [dataUpdateResource]);

assert.equal(resourceCapacity[dataUpdateResource], 1, 'the shared fixed paths admit one check at a time');
assert.ok(resourceCapacity[browserResource] >= 1);

// At --jobs=1 nothing may be allowed more concurrency than the run itself, so
// the resources stop mattering and the revert is total.
for (const resource of [browserResource, dataUpdateResource]) {
    assert.equal(capacityFor(resource, 1), 1, `${resource} must be serial at --jobs=1`);
    assert.ok(capacityFor(resource, 8) <= resourceCapacity[resource]);
    assert.ok(capacityFor(resource, 8) >= 1);
}
assert.equal(capacityFor(browserResource, 2), 2);
assert.equal(capacityFor(dataUpdateResource, 8), 1, 'more jobs never widens a mutex');
assert.equal(capacityFor('a resource nobody declared', 4), 4, 'an unknown resource falls back to the run width');

console.log(`Check lane contract passed: ${registered.length} registered checks, ` +
    `${gateScripts.length} gates, ${browserScripts.length} browser checks ` +
    `(${launchers.length} launching, ${spawners.length} spawning) and ` +
    `${dataUpdateScripts.length} sharing fixed paths, all derived from source.`);
