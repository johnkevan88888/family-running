// Chromium discovery and launching shared by every Node script that drives the
// site in a real browser. It lives here rather than inside one test file
// because a second copy would drift: the two callers would disagree about which
// browser they launched long before anyone noticed, and a reconciliation that
// reads the page has to launch exactly the browser the test suite does or its
// result means nothing.
//
// `scripts/vendored-library-files.mjs` is the existing precedent for a single
// shared list that more than one entry point reads.
//
// Playwright's pinned Chromium is the default everywhere, local runs included,
// and CI is required to use it.
//
// It was previously meant to be the default whenever `CI` was set, but that
// branch was dead on GitHub's runners. The `ubuntu-latest` image pre-sets
// `CHROME_BIN=/usr/bin/google-chrome`, and `CHROME_BIN` was consulted first, so
// every Pull Request check actually ran against the runner's Google Chrome --
// 156.0.8078.79 when this was found -- while the workflow dutifully downloaded
// a pinned Chromium it then never launched. Local runs meanwhile used whichever
// Chrome or Edge happened to be installed. Neither side was running the browser
// the code claimed, and the comment that used to sit here asserted otherwise.
//
// `CHROME_BIN` is therefore no longer consulted at all: it is an ambient
// variable set by third-party images, not a deliberate request from anyone
// here. The only ways off the pinned build are
// `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`, which names a browser explicitly, and
// `FAMILY_RUNNING_USE_INSTALLED_BROWSER=1` for local reproduction. Under `CI`
// anything but the pinned build is a hard failure, so a release can never again
// be proved against a browser nobody chose.

import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

// Set to `1` to drive an installed Chrome/Edge instead of the pinned build.
// Useful for reproducing a browser-specific report, never for proving a change.
export const installedBrowserOptInVariable = 'FAMILY_RUNNING_USE_INSTALLED_BROWSER';

export function loadPlaywright() {
    const explicitPackagePath = process.env.PLAYWRIGHT_PACKAGE_PATH;

    if (explicitPackagePath) {
        return require(explicitPackagePath);
    }

    try {
        return require('playwright');
    } catch (error) {
        console.error('Playwright is not installed. Run `pnpm install` first, or set PLAYWRIGHT_PACKAGE_PATH for a local bundled Playwright package.');
        throw error;
    }
}

export function installedChromiumCandidates(platform = process.platform) {
    if (platform === 'win32') {
        return [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
        ];
    }

    if (platform === 'darwin') {
        return [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
        ];
    }

    return [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/microsoft-edge'
    ];
}

/**
 * Returns the executable to launch, or `undefined` to use Playwright's pinned
 * Chromium. `undefined` is the default: an explicit path or the opt-in variable
 * is required before an installed browser is used.
 */
export function findChromiumExecutable({ env = process.env, platform = process.platform, exists = fileExists } = {}) {
    // Only this repository's own variable counts as deliberate. `CHROME_BIN` is
    // set by CI images and is explicitly NOT consulted; honouring it is what
    // silently pointed every Pull Request check at the runner's Chrome.
    if (env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
        return env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    }

    if (env[installedBrowserOptInVariable] !== '1') {
        return undefined;
    }

    return installedChromiumCandidates(platform).find(candidate => exists(candidate));
}

export function describeChromiumChoice(executablePath, { env = process.env } = {}) {
    if (!executablePath) {
        return "Playwright's pinned Chromium";
    }

    if (env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
        return `explicitly configured browser at ${executablePath}`;
    }

    return `installed browser at ${executablePath} (opt-in via ${installedBrowserOptInVariable}=1)`;
}

/**
 * Launches Chromium and reports which binary and version actually ran, so a
 * surprising browser-specific failure names its own cause instead of looking
 * like a fault in the code under test. Every browser-driving entry point should
 * use this rather than calling `chromium.launch` itself.
 */
export const pinnedChromiumMissingMessage =
    "Playwright's pinned Chromium is not installed. Run `pnpm exec playwright install chromium`. " +
    `To drive an installed Chrome or Edge instead, set ${installedBrowserOptInVariable}=1.`;

// Asking for an installed browser and silently getting the pinned one is the
// same class of problem this module exists to remove: the run would report a
// browser nobody chose. Refuse instead of falling back.
export const installedBrowserMissingMessage =
    `${installedBrowserOptInVariable}=1 asks for an installed Chrome or Edge, but none was found. ` +
    'Install one, point PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH at a browser, or unset ' +
    `${installedBrowserOptInVariable} to use Playwright's pinned Chromium.`;

/**
 * Returns a problem string when this run would need Playwright's pinned
 * Chromium and it is not installed, or null otherwise. It resolves and stats
 * the executable without launching anything, so it is cheap enough to run as a
 * preflight before irreversible work starts — the guided data updater drives a
 * real browser for live verification only *after* it has merged and deployed,
 * so a missing browser has to be caught before Excel opens, not afterwards.
 *
 * This is a preflight proxy, not the authority: Playwright may launch the
 * headless shell rather than the executable reported here, so `launchChromium`
 * remains the thing that actually proves a browser runs.
 */
export function assessPinnedChromium({
    env = process.env,
    platform = process.platform,
    exists = fileExists,
    resolvePinnedExecutable = defaultPinnedExecutable
} = {}) {
    // An explicit executable is the run's own choice, so the pinned build is
    // irrelevant and its absence is not a problem. `CHROME_BIN` is deliberately
    // not accepted here either.
    if (env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
        return null;
    }

    // The opt-in only excuses the pinned build when an installed browser is
    // actually there to use instead. Otherwise the run asked for one browser
    // and would quietly get another, so say so rather than skipping.
    if (env[installedBrowserOptInVariable] === '1') {
        return findChromiumExecutable({ env, platform, exists }) ? null : installedBrowserMissingMessage;
    }

    let executablePath;

    try {
        executablePath = resolvePinnedExecutable();
    } catch {
        return pinnedChromiumMissingMessage;
    }

    return executablePath && exists(executablePath) ? null : pinnedChromiumMissingMessage;
}

/**
 * Returns a problem string when a CI run would launch anything other than
 * Playwright's pinned Chromium without having been told to, or null otherwise.
 * `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` is the deliberate escape hatch; the
 * local opt-in is not one, because a release must not depend on whatever
 * browser a runner image happens to ship.
 */
export function assessCiBrowser(executablePath, { env = process.env } = {}) {
    if (!env.CI || !executablePath) {
        return null;
    }
    if (env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
        return null;
    }

    return `CI must use Playwright's pinned Chromium, but this run resolved ${executablePath}. ` +
        `Unset ${installedBrowserOptInVariable}, or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ` +
        'if another browser is genuinely intended.';
}

export async function launchChromium(options = {}, { log = console.log } = {}) {
    const { chromium } = loadPlaywright();
    const { args = [], ...rest } = options;
    const executablePath = findChromiumExecutable();

    // Honour the opt-in or fail: launching the pinned build after being asked
    // for an installed one would report a browser nobody chose.
    if (!executablePath
        && process.env[installedBrowserOptInVariable] === '1'
        && !process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
        throw new Error(installedBrowserMissingMessage);
    }

    // CI must prove a release against the pinned build. Failing closed here is
    // the regression gate for the defect this replaced: a pre-set `CHROME_BIN`
    // pointed every check at the runner's Chrome while the logs and the code
    // comment both claimed otherwise.
    const ciProblem = assessCiBrowser(executablePath);

    if (ciProblem) {
        throw new Error(ciProblem);
    }

    const launchArgs = [...new Set(['--disable-dev-shm-usage', ...args])];
    let browser;

    try {
        browser = await chromium.launch({ headless: true, ...rest, args: launchArgs, executablePath });
    } catch (error) {
        if (!executablePath && /executable doesn'?t exist|playwright install/i.test(error.message)) {
            throw new Error(pinnedChromiumMissingMessage);
        }

        throw error;
    }

    log(`Browser: ${describeChromiumChoice(executablePath)} — Chromium ${browser.version()}`);
    return browser;
}

/**
 * Waits for an `<img>` to be loaded with known intrinsic dimensions, and fails
 * with the image's own source if it never loads.
 *
 * `HTMLImageElement.decode()` is a rasterisation request, not a load check.
 * Chromium rejects it with `EncodingError` for a vector source scaled up by a
 * device pixel ratio even when the image has loaded and paints correctly, so
 * the mobile cases (`deviceScaleFactor: 2`) failed on the pinned build while
 * passing on a newer installed Chrome. Geometry and screenshot assertions only
 * need the image loaded and laid out; the screenshot that follows is what
 * actually proves it painted.
 */
export async function waitForLoadedImage(locator, label) {
    await locator.scrollIntoViewIfNeeded();
    await locator.evaluate(image => (image.complete && image.naturalWidth > 0
        ? null
        : new Promise((resolve, reject) => {
            image.addEventListener('load', () => resolve(null), { once: true });
            image.addEventListener('error', () => reject(new Error('the image failed to load')), { once: true });
        })));

    const loaded = await locator.evaluate(image => ({
        complete: image.complete,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        source: image.currentSrc || image.getAttribute('src') || ''
    }));

    if (!loaded.complete || loaded.naturalWidth <= 0) {
        throw new Error(`${label}: image did not load (${loaded.source || 'no source'}).`);
    }

    return loaded;
}

function defaultPinnedExecutable() {
    return loadPlaywright().chromium.executablePath();
}

function fileExists(candidate) {
    try {
        return Boolean(candidate && fs.existsSync(candidate));
    } catch {
        return false;
    }
}
