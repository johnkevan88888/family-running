import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    assessCiBrowser,
    assessPinnedChromium,
    describeChromiumChoice,
    findChromiumExecutable,
    installedBrowserMissingMessage,
    installedBrowserOptInVariable,
    installedChromiumCandidates,
    pinnedChromiumMissingMessage
} from '../scripts/browser-runtime.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// -- Playwright's pinned Chromium is the default everywhere ----------------
//
// This used to depend on `CI`, so a local run and a CI run drove different
// browsers. That is not a tidiness problem: Chromium 149 rejects
// `HTMLImageElement.decode()` for a vector source scaled by a device pixel
// ratio, so a check could pass on an installed Chrome 156 and fail in CI for a
// reason unrelated to the change under test. "It passes locally" must mean the
// same thing as "it passes in CI".

assert.equal(findChromiumExecutable({ env: {} }), undefined, 'the default must be the pinned Chromium');
assert.equal(
    findChromiumExecutable({ env: { CI: 'true' } }),
    undefined,
    'CI must no longer be what selects the pinned Chromium'
);
assert.equal(
    findChromiumExecutable({ env: { CI: '' } }),
    undefined,
    'an empty CI value must still select the pinned Chromium'
);

// An installed browser is an explicit opt-in, and only the exact value opts in,
// so a stray truthy string cannot quietly change which browser proves a change.
for (const value of ['0', '', 'true', 'yes', 'TRUE', '2']) {
    assert.equal(
        findChromiumExecutable({ env: { [installedBrowserOptInVariable]: value }, platform: 'win32', exists: () => true }),
        undefined,
        `${installedBrowserOptInVariable}=${JSON.stringify(value)} must not opt in`
    );
}

assert.equal(
    findChromiumExecutable({
        env: { [installedBrowserOptInVariable]: '1' },
        platform: 'win32',
        exists: () => true
    }),
    installedChromiumCandidates('win32')[0],
    'the opt-in must select the first installed candidate present'
);
assert.equal(
    findChromiumExecutable({
        env: { [installedBrowserOptInVariable]: '1' },
        platform: 'linux',
        exists: () => false
    }),
    undefined,
    'the opt-in must fall back to the pinned Chromium when no browser is installed'
);

// An explicit path always wins, so a one-off reproduction needs no opt-in.
assert.equal(
    findChromiumExecutable({ env: { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/tmp/chromium' } }),
    '/tmp/chromium'
);
// -- An ambient CHROME_BIN is ignored -------------------------------------
//
// This is the regression test for the defect that made CI meaningless.
// GitHub's ubuntu-latest image pre-sets CHROME_BIN=/usr/bin/google-chrome, and
// this module used to consult it before anything else, so every Pull Request
// check ran against the runner's Chrome 156 while the workflow downloaded a
// pinned Chromium it never launched. CHROME_BIN is set by third-party images,
// not by anyone here, so it must never select a browser.
assert.equal(
    findChromiumExecutable({ env: { CHROME_BIN: '/usr/bin/google-chrome' } }),
    undefined,
    'an ambient CHROME_BIN must not select a browser'
);
assert.equal(
    findChromiumExecutable({ env: { CI: 'true', CHROME_BIN: '/usr/bin/google-chrome' } }),
    undefined,
    'the exact GitHub-runner environment must still resolve to the pinned Chromium'
);
assert.equal(
    findChromiumExecutable({
        env: { CI: 'true', CHROME_BIN: '/usr/bin/google-chrome', [installedBrowserOptInVariable]: '1' },
        platform: 'linux',
        exists: () => true
    }),
    '/usr/bin/google-chrome',
    'the opt-in may still find an installed browser; assessCiBrowser is what refuses it under CI'
);

for (const platform of ['win32', 'darwin', 'linux']) {
    const candidates = installedChromiumCandidates(platform);

    assert.ok(candidates.length > 0, `${platform} must list installed browser candidates`);
    for (const candidate of candidates) {
        assert.ok(
            candidate.startsWith('/') || /^[A-Za-z]:\\/.test(candidate),
            `${platform} candidate "${candidate}" must be an absolute path`
        );
    }
}

// -- The run must say which browser it used --------------------------------

assert.match(describeChromiumChoice(undefined, { env: {} }), /pinned Chromium/);
assert.match(
    describeChromiumChoice('/tmp/chrome', { env: { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/tmp/chrome' } }),
    /explicitly configured browser at \/tmp\/chrome/
);
assert.match(
    describeChromiumChoice('/tmp/chrome', { env: { [installedBrowserOptInVariable]: '1' } }),
    new RegExp(`installed browser at /tmp/chrome .*${installedBrowserOptInVariable}=1`)
);

// -- The pinned browser is checked before irreversible work ----------------
//
// `scripts/verify-production-data.mjs` drives a real browser and runs after the
// merge and the Pages deploy, so a missing pinned Chromium discovered there
// would leave production changed and unverified.

const presentExecutable = { resolvePinnedExecutable: () => '/pinned/chrome', exists: () => true };
const missingExecutable = { resolvePinnedExecutable: () => '/pinned/chrome', exists: () => false };

assert.equal(assessPinnedChromium({ env: {}, ...presentExecutable }), null);
assert.equal(
    assessPinnedChromium({ env: {}, ...missingExecutable }),
    pinnedChromiumMissingMessage,
    'a missing pinned Chromium must be refused'
);
assert.match(pinnedChromiumMissingMessage, /pnpm exec playwright install chromium/);
assert.match(pinnedChromiumMissingMessage, new RegExp(`${installedBrowserOptInVariable}=1`));

// A Playwright that cannot even report a path is refused, not treated as fine.
assert.equal(
    assessPinnedChromium({
        env: {},
        exists: () => true,
        resolvePinnedExecutable: () => { throw new Error('playwright is not installed'); }
    }),
    pinnedChromiumMissingMessage
);
// An empty path is no more usable than a missing file.
assert.equal(
    assessPinnedChromium({ env: {}, exists: () => true, resolvePinnedExecutable: () => '' }),
    pinnedChromiumMissingMessage
);

// The opt-in excuses the pinned build only when an installed browser is
// actually there. Otherwise the run asked for one browser and would quietly be
// given another, so it is refused with its own message rather than skipped.
assert.equal(
    assessPinnedChromium({
        env: { [installedBrowserOptInVariable]: '1' },
        platform: 'win32',
        exists: candidate => candidate === installedChromiumCandidates('win32')[0],
        resolvePinnedExecutable: () => '/pinned/chrome'
    }),
    null,
    `${installedBrowserOptInVariable}=1 with an installed browser present must pass`
);
assert.equal(
    assessPinnedChromium({
        env: { [installedBrowserOptInVariable]: '1' },
        platform: 'win32',
        exists: () => false,
        resolvePinnedExecutable: () => '/pinned/chrome'
    }),
    installedBrowserMissingMessage,
    `${installedBrowserOptInVariable}=1 with no installed browser must be refused, not skipped`
);
assert.match(installedBrowserMissingMessage, new RegExp(`${installedBrowserOptInVariable}=1`));
assert.match(installedBrowserMissingMessage, /PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH/);
assert.notEqual(
    installedBrowserMissingMessage,
    pinnedChromiumMissingMessage,
    'the two refusals must not be confusable; they need different fixes'
);
// The opt-in plus an explicit path is the explicit path's business.
assert.equal(
    assessPinnedChromium({
        env: { [installedBrowserOptInVariable]: '1', PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/tmp/chrome' },
        platform: 'win32',
        exists: () => false,
        resolvePinnedExecutable: () => '/pinned/chrome'
    }),
    null,
    'an explicit executable overrides the opt-in check'
);

// -- CI may only ever run the pinned Chromium -----------------------------

assert.equal(assessCiBrowser(undefined, { env: { CI: 'true' } }), null,
    'the pinned Chromium is what CI must use');
assert.equal(assessCiBrowser('/usr/bin/google-chrome', { env: {} }), null,
    'outside CI any browser is allowed');

const ciRefusal = assessCiBrowser('/usr/bin/google-chrome', {
    env: { CI: 'true', CHROME_BIN: '/usr/bin/google-chrome' }
});

assert.equal(typeof ciRefusal, 'string', 'CI must refuse a browser it was not told to use');
assert.match(ciRefusal, /pinned Chromium/);
assert.match(ciRefusal, /\/usr\/bin\/google-chrome/, 'the refusal must name the browser it found');
assert.equal(
    typeof assessCiBrowser('/usr/bin/google-chrome', {
        env: { CI: 'true', [installedBrowserOptInVariable]: '1' }
    }),
    'string',
    'the local opt-in is not an escape hatch under CI'
);
assert.equal(
    assessCiBrowser('/tmp/chrome', { env: { CI: 'true', PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/tmp/chrome' } }),
    null,
    'a deliberately named executable is allowed under CI'
);
assert.equal(
    assessPinnedChromium({ env: { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/tmp/chromium' }, ...missingExecutable }),
    null,
    'an explicit PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH must skip the check'
);
assert.equal(
    assessPinnedChromium({ env: { CHROME_BIN: '/tmp/chrome' }, ...missingExecutable }),
    pinnedChromiumMissingMessage,
    'an ambient CHROME_BIN must not excuse a missing pinned Chromium'
);
// Only the exact opt-in value skips it, matching findChromiumExecutable.
for (const value of ['0', '', 'true', 'TRUE']) {
    assert.equal(
        assessPinnedChromium({ env: { [installedBrowserOptInVariable]: value }, ...missingExecutable }),
        pinnedChromiumMissingMessage,
        `${installedBrowserOptInVariable}=${JSON.stringify(value)} must not skip the check`
    );
}

// `assessUpdateEnvironment` composes this into the updater's preflight; that
// wiring is asserted in tests/data-update-workspace.mjs, beside the rest of the
// launcher's behaviour.

// -- One launch point, so the report cannot be skipped ---------------------
//
// `launchChromium` is what prints the browser and version. A second
// `chromium.launch` call site would silently stop reporting, and would also be
// free to pick its own executable, which is exactly the divergence this
// replaced.
// The runtime module defines the launch point, and this file is its test, so
// both legitimately name `findChromiumExecutable`. Nothing else may.
const exemptModules = new Set(['scripts/browser-runtime.mjs', 'tests/browser-runtime.mjs']);
const scanned = [];

for (const directory of ['tests', 'scripts']) {
    for (const entry of await fs.readdir(path.join(repoRoot, directory))) {
        if (!entry.endsWith('.mjs') && !entry.endsWith('.js')) {
            continue;
        }

        const relativePath = `${directory}/${entry}`;

        if (exemptModules.has(relativePath)) {
            continue;
        }

        scanned.push(relativePath);

        const source = await fs.readFile(path.join(repoRoot, relativePath), 'utf8');

        assert.doesNotMatch(
            source,
            /chromium\s*\.\s*launch\s*\(/,
            `${relativePath} must launch through launchChromium() so the browser and version are reported`
        );
        assert.doesNotMatch(
            source,
            /\bfindChromiumExecutable\b/,
            `${relativePath} must not resolve its own browser executable; use launchChromium()`
        );
    }
}

assert.ok(scanned.length > 50, `the launch-point scan must cover the repository (saw ${scanned.length} files)`);

console.log(`Browser runtime contract passed: pinned Chromium by default, one launch point, ${scanned.length} files scanned.`);
