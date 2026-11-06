import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    assessNodeVersion,
    supportedNodeMajor,
    supportedNodeRange
} from '../scripts/node-engine.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The declaration has four readers: pnpm (package.json), nvm (.nvmrc), the test
// runner and the guided updater (both via scripts/node-engine.mjs). A drift
// between any two of them is the failure this test exists to prevent, because a
// wrong Node does not announce itself -- it fails ten minutes later inside an
// unrelated test file.
const packageDefinition = JSON.parse(
    await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8')
);

assert.equal(
    packageDefinition.engines?.node,
    supportedNodeRange,
    'package.json engines.node must match scripts/node-engine.mjs'
);

const nvmrc = await fs.readFile(path.join(repoRoot, '.nvmrc'), 'utf8');

assert.equal(
    nvmrc.trim(),
    String(supportedNodeMajor),
    '.nvmrc must select the supported Node major'
);

// CI and Netlify pin the same major in their own syntax, and neither reads
// package.json or .nvmrc. Assert against the real files so a bump cannot land
// in the repository while the runners stay behind.
for (const [relativePath, pattern] of [
    ['.github/workflows/pr-checks.yml', new RegExp(`node-version:\\s*${supportedNodeMajor}\\b`)],
    ['.github/workflows/deploy-pages.yml', new RegExp(`node-version:\\s*${supportedNodeMajor}\\b`)],
    ['netlify.toml', new RegExp(`NODE_VERSION\\s*=\\s*"${supportedNodeMajor}"`)]
]) {
    const contents = await fs.readFile(path.join(repoRoot, relativePath), 'utf8');

    assert.match(
        contents,
        pattern,
        `${relativePath} must pin Node ${supportedNodeMajor}`
    );
}

// The supported major passes, and passes for any patch release of it.
assert.equal(assessNodeVersion(`${supportedNodeMajor}.0.0`), null);
assert.equal(assessNodeVersion(`${supportedNodeMajor}.18.0`), null);
assert.equal(assessNodeVersion(`${supportedNodeMajor}.99.99`), null);

// `process.version` carries a leading "v" where `process.versions.node` does
// not. Accept both so a caller reaching for the wrong one is not refused.
assert.equal(assessNodeVersion(`v${supportedNodeMajor}.18.0`), null);

// Everything else is refused, including a newer major: an untested Node is not
// an approved Node, so this fails closed rather than assuming forward
// compatibility.
for (const refused of [
    '22.11.0',
    '22.0.0',
    `${supportedNodeMajor - 1}.0.0`,
    `${supportedNodeMajor + 1}.0.0`,
    '18.20.4'
]) {
    const problem = assessNodeVersion(refused);

    assert.equal(typeof problem, 'string', `Node ${refused} must be refused`);

    // The refusal must be actionable on Windows, where the guided updater
    // runs. Pointing at `.nvmrc` is not enough: nvm-windows ignores it, and
    // the nodejs.org front-page LTS is now a major this repository refuses, so
    // "install the LTS" would send someone round the same loop.
    assert.match(
        problem,
        new RegExp(`Node ${supportedNodeMajor}\\.x`),
        'the refusal must name Node 24.x explicitly'
    );
    assert.match(
        problem,
        new RegExp(`nodejs\\.org/dist/latest-v${supportedNodeMajor}\\.x`),
        'the refusal must give the exact 24.x download path, not the front-page LTS'
    );
    assert.match(
        problem,
        new RegExp(`nvm install ${supportedNodeMajor}\\b`),
        'the refusal must give the nvm-windows install command'
    );
    assert.match(
        problem,
        new RegExp(`nvm use ${supportedNodeMajor}\\b`),
        'the refusal must give the nvm-windows use command'
    );
    assert.match(
        problem,
        /run the command again/,
        'the refusal must tell the reader to re-run'
    );
    assert.doesNotMatch(
        problem,
        /nvm use"|nvm use\s*$/,
        'the refusal must not tell Windows readers to run a bare "nvm use"'
    );
}

// The range stays pinned to one major in this stage; widening it is a separate
// decision, so assert the declared range rather than trusting the template.
assert.equal(supportedNodeRange, '>=24 <25', 'the supported range must stay pinned to Node 24');

// A version string that cannot be read is refused rather than treated as the
// supported major. `undefined` is deliberately absent: it selects the default
// parameter, which is the running process.
for (const unreadable of ['', 'not-a-version', 'v', null, '0.0.0', '  ']) {
    assert.equal(
        typeof assessNodeVersion(unreadable),
        'string',
        `an unreadable version (${JSON.stringify(unreadable)}) must be refused`
    );
}

// The running process is the one case that matters in practice.
assert.equal(
    assessNodeVersion(),
    null,
    `the suite must be running on Node ${supportedNodeMajor}.x`
);

console.log(`Node engine declaration consistent (Node ${supportedNodeMajor}.x, range "${supportedNodeRange}").`);
