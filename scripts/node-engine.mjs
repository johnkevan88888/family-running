// Single source of truth for the Node version this repository supports.
//
// `scripts/run-all-tests.mjs` and `scripts/data-update.mjs` both refuse to
// start on another major, `package.json` declares the same range to pnpm, and
// `.nvmrc` selects it for the tools that read it. `tests/node-engine.mjs`
// fails if those four ever disagree, so there is no second place to update.
// Note that nvm-windows does not read `.nvmrc`, so it is a declaration rather
// than something a Windows refusal can tell someone to rely on.
//
// The requirement is real, not tidiness. `tests/gallery-photo-review-bridge.mjs`
// uses `await using`, which Node 22 cannot parse. It is check 59 of 108, so a
// Node 22 suite ran for roughly ten minutes before dying of a syntax error in
// an unrelated-looking file. The desktop launcher makes this worse:
// `update-website-data.cmd` invokes `node scripts/data-update.mjs` directly
// rather than through pnpm, so pnpm's own `engines` enforcement never sees a
// double-click update.
export const supportedNodeMajor = 24;
export const supportedNodeRange = `>=${supportedNodeMajor} <${supportedNodeMajor + 1}`;

// The refusal has to be actionable on Windows, which is where the guided
// updater runs. Two traps make a shorter message wrong here: nvm-windows does
// not read `.nvmrc`, so "nvm use" alone picks nothing up, and the nodejs.org
// front page now offers a newer LTS than this repository accepts, so following
// it produces another refusal. Name an exact 24.x download and the two
// nvm-windows commands instead.
export const nodeInstallInstructions =
    `Install Node ${supportedNodeMajor} LTS from ` +
    `https://nodejs.org/dist/latest-v${supportedNodeMajor}.x/ ` +
    `(on Windows the x64 .msi), or run "nvm install ${supportedNodeMajor}" then ` +
    `"nvm use ${supportedNodeMajor}". Then run the command again.`;

/**
 * Returns a one-line problem description, or null when this Node may run the
 * repository's tooling. Callers report it in their own idiom rather than
 * exiting here, so the guided updater can fail through its normal handler.
 */
export function assessNodeVersion(version = process.versions.node) {
    // `process.versions.node` has no prefix but `process.version` does, and a
    // caller reaching for the wrong one should not be refused for the `v`.
    const major = Number(String(version).replace(/^v/, '').split('.')[0]);

    if (!Number.isSafeInteger(major) || major < 1) {
        return `Could not establish the running Node version ("${version}"). This repository requires Node ${supportedNodeMajor}.x. ${nodeInstallInstructions}`;
    }

    if (major !== supportedNodeMajor) {
        return `This repository requires Node ${supportedNodeMajor}.x and this is Node ${version}. ${nodeInstallInstructions}`;
    }

    return null;
}
