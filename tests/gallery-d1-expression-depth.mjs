import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const wranglerPackageRoot = path.dirname(require.resolve('wrangler/package.json'));
const wranglerPath = path.join(
    wranglerPackageRoot,
    'bin',
    'wrangler.js'
);
const workerConfigPath = path.join(
    repositoryRoot,
    'gallery-admin',
    'wrangler.withdrawal-finalizer.example.jsonc'
);
const databaseName = 'family-running-gallery-dev';
const temporaryPrefix = 'gallery-d1-expression-depth-';
const temporaryParent = await fs.realpath(os.tmpdir());
const temporaryRoot = await fs.mkdtemp(
    path.join(temporaryParent, temporaryPrefix)
);

assert.equal(path.dirname(temporaryRoot), temporaryParent);
assert.match(path.basename(temporaryRoot), /^gallery-d1-expression-depth-/);

try {
    const stateRoot = path.join(temporaryRoot, 'state');
    const configRoot = path.join(temporaryRoot, 'wrangler-config');
    await fs.mkdir(stateRoot);
    await fs.mkdir(configRoot);

    const environment = localOnlyEnvironment(configRoot);
    const commonArguments = [
        databaseName,
        '--local',
        '--config',
        workerConfigPath,
        '--persist-to',
        stateRoot
    ];

    // Prove that this pinned Wrangler/workerd runtime enforces the same
    // expression-depth boundary that production D1 enforces. Without this
    // calibration, a more permissive generic SQLite build could let the
    // migration test pass while the deployed query still fails.
    const depthBoundaryProbe = runWrangler([
        'd1',
        'execute',
        ...commonArguments,
        '--command',
        `EXPLAIN SELECT ${Array(101).fill('1').join(' AND ')}`,
        '--json'
    ], environment);
    assert.notEqual(
        depthBoundaryProbe.status,
        0,
        'The local D1 parity probe unexpectedly accepted an expression deeper than 100.'
    );
    assert.match(
        combinedOutput(depthBoundaryProbe),
        /Expression tree is too large \(maximum depth 100\): SQLITE_ERROR/,
        diagnostic(depthBoundaryProbe)
    );

    const migrations = runWrangler([
        'd1',
        'migrations',
        'apply',
        ...commonArguments
    ], environment, 120_000);
    assert.equal(migrations.error, undefined, diagnostic(migrations));
    assert.equal(migrations.status, 0, diagnostic(migrations));

    // EXPLAIN compiles the INSERT and all table triggers into bytecode but does
    // not execute them. DEFAULT VALUES deliberately avoids fixture data: this
    // test is about whether D1 can compile the receipt guard, not whether a
    // fabricated receipt can satisfy the evidence contract.
    const compile = runWrangler([
        'd1',
        'execute',
        ...commonArguments,
        '--command',
        'EXPLAIN INSERT INTO gallery_withdrawal_completion_receipts DEFAULT VALUES',
        '--json'
    ], environment);
    assert.equal(compile.error, undefined, diagnostic(compile));
    assert.equal(compile.status, 0, diagnostic(compile));

    const compileResult = parseWranglerJson(compile);
    assert.equal(Array.isArray(compileResult), true, diagnostic(compile));
    assert.equal(compileResult.length, 1, diagnostic(compile));
    assert.equal(compileResult[0].success, true, diagnostic(compile));
    assert.ok(compileResult[0].results.length > 0, diagnostic(compile));

    // Keep a direct non-mutation assertion beside the compile check. Even if a
    // future Wrangler release changes its EXPLAIN output, this test must never
    // create a synthetic permanent receipt as a side effect.
    const receiptCount = runWrangler([
        'd1',
        'execute',
        ...commonArguments,
        '--command',
        'SELECT COUNT(*) AS receiptCount FROM gallery_withdrawal_completion_receipts',
        '--json'
    ], environment);
    assert.equal(receiptCount.error, undefined, diagnostic(receiptCount));
    assert.equal(receiptCount.status, 0, diagnostic(receiptCount));

    const countResult = parseWranglerJson(receiptCount);
    assert.equal(countResult[0].success, true, diagnostic(receiptCount));
    assert.equal(countResult[0].results[0].receiptCount, 0);

    console.log('Gallery D1 expression-depth parity tests passed.');
} finally {
    const resolvedTemporaryRoot = await fs.realpath(temporaryRoot);
    assert.equal(path.dirname(resolvedTemporaryRoot), temporaryParent);
    assert.match(path.basename(resolvedTemporaryRoot), /^gallery-d1-expression-depth-/);
    await fs.rm(resolvedTemporaryRoot, { recursive: true, force: true });
}

function runWrangler(arguments_, environment, timeout = 60_000) {
    return spawnSync(process.execPath, [wranglerPath, ...arguments_], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: environment,
        maxBuffer: 16 * 1024 * 1024,
        timeout,
        windowsHide: true
    });
}

function localOnlyEnvironment(configRoot) {
    const environment = {
        ...process.env,
        CI: '1',
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        NO_D1_WARNING: 'true',
        WRANGLER_SEND_METRICS: 'false',
        XDG_CONFIG_HOME: configRoot
    };
    const credentialNames = /^(?:CF|CLOUDFLARE)_(?:ACCOUNT_ID|API_KEY|API_TOKEN|EMAIL)$/i;
    for (const name of Object.keys(environment)) {
        if (credentialNames.test(name)) delete environment[name];
    }
    return environment;
}

function parseWranglerJson(result) {
    try {
        return JSON.parse(result.stdout);
    } catch (error) {
        assert.fail(`${diagnostic(result)}\nJSON parse failed: ${error.message}`);
    }
}

function combinedOutput(result) {
    return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function diagnostic(result) {
    return `Wrangler exited ${result.status}:\n${combinedOutput(result)}`;
}
