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

    // EXPLAIN compiles each INSERT and all table triggers into bytecode but does
    // not execute them. DEFAULT VALUES deliberately avoids fixture data: these
    // tests are about whether D1 can compile both sides of the finalization
    // boundary, not whether fabricated evidence can satisfy either contract.
    const operationCompile = runWrangler([
        'd1',
        'execute',
        ...commonArguments,
        '--command',
        'EXPLAIN INSERT INTO draft_withdrawal_finalization_operations DEFAULT VALUES',
        '--json'
    ], environment);
    assert.equal(operationCompile.error, undefined, diagnostic(operationCompile));
    assert.equal(operationCompile.status, 0, diagnostic(operationCompile));

    const operationCompileResult = parseWranglerJson(operationCompile);
    assert.equal(
        Array.isArray(operationCompileResult),
        true,
        diagnostic(operationCompile)
    );
    assert.equal(operationCompileResult.length, 1, diagnostic(operationCompile));
    assert.equal(operationCompileResult[0].success, true, diagnostic(operationCompile));
    assert.ok(
        operationCompileResult[0].results.length > 0,
        diagnostic(operationCompile)
    );

    const receiptCompile = runWrangler([
        'd1',
        'execute',
        ...commonArguments,
        '--command',
        'EXPLAIN INSERT INTO gallery_withdrawal_completion_receipts DEFAULT VALUES',
        '--json'
    ], environment);
    assert.equal(receiptCompile.error, undefined, diagnostic(receiptCompile));
    assert.equal(receiptCompile.status, 0, diagnostic(receiptCompile));

    const receiptCompileResult = parseWranglerJson(receiptCompile);
    assert.equal(Array.isArray(receiptCompileResult), true, diagnostic(receiptCompile));
    assert.equal(receiptCompileResult.length, 1, diagnostic(receiptCompile));
    assert.equal(receiptCompileResult[0].success, true, diagnostic(receiptCompile));
    assert.ok(receiptCompileResult[0].results.length > 0, diagnostic(receiptCompile));

    // Keep a direct non-mutation assertion beside the compile check. Even if a
    // future Wrangler release changes its EXPLAIN output, this test must never
    // create a synthetic permanent receipt as a side effect.
    const finalizationCounts = runWrangler([
        'd1',
        'execute',
        ...commonArguments,
        '--command',
        'SELECT ' +
            '(SELECT COUNT(*) FROM draft_withdrawal_finalization_operations) ' +
                'AS operationCount, ' +
            '(SELECT COUNT(*) FROM gallery_withdrawal_completion_receipts) ' +
                'AS receiptCount',
        '--json'
    ], environment);
    assert.equal(finalizationCounts.error, undefined, diagnostic(finalizationCounts));
    assert.equal(finalizationCounts.status, 0, diagnostic(finalizationCounts));

    const countResult = parseWranglerJson(finalizationCounts);
    assert.equal(countResult[0].success, true, diagnostic(finalizationCounts));
    assert.equal(countResult[0].results[0].operationCount, 0);
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
