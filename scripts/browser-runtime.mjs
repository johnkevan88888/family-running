// Chromium discovery shared by every Node script that drives the site in a real
// browser. It lives here rather than inside one test file because a second copy
// would drift: the two callers would disagree about which browser they launched
// long before anyone noticed, and a reconciliation that reads the page has to
// launch exactly the browser the test suite does or its result means nothing.
//
// `scripts/vendored-library-files.mjs` is the existing precedent for a single
// shared list that more than one entry point reads.

import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

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

export function findChromiumExecutable() {
    const explicitPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.CHROME_BIN;

    if (explicitPath) {
        return explicitPath;
    }

    // CI installs Playwright's pinned Chromium. Returning undefined makes
    // Playwright use it, instead of silently falling back to whatever browser
    // version the runner image happens to ship.
    if (process.env.CI) {
        return undefined;
    }

    const candidates = process.platform === 'win32'
        ? [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
        ]
        : process.platform === 'darwin'
            ? [
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
            ]
            : [
                '/usr/bin/google-chrome',
                '/usr/bin/google-chrome-stable',
                '/usr/bin/chromium',
                '/usr/bin/chromium-browser',
                '/usr/bin/microsoft-edge'
            ];

    return candidates.find(candidate => fileExists(candidate));
}

function fileExists(candidate) {
    try {
        return Boolean(candidate && fs.existsSync(candidate));
    } catch {
        return false;
    }
}
