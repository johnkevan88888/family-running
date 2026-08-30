import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const configPath = path.join(
    repositoryRoot,
    'gallery-admin',
    'wrangler.promotion.example.jsonc'
);
const configText = await fs.readFile(configPath, 'utf8');
const config = JSON.parse(configText);

assert.deepEqual(Object.keys(config), [
    '$schema',
    'account_id',
    'name',
    'main',
    'compatibility_date',
    'workers_dev',
    'preview_urls',
    'observability',
    'd1_databases',
    'r2_buckets'
]);
assert.equal(config.$schema, '../node_modules/wrangler/config-schema.json');
assert.equal(config.name, 'family-running-gallery-promotion-dev');
assert.equal(config.main, 'src/promotion-worker.js');
assert.equal(config.compatibility_date, '2026-08-29');
assert.equal(config.workers_dev, true);
assert.equal(config.preview_urls, false);
assert.deepEqual(config.observability, { enabled: false });
assert.deepEqual(config.d1_databases, [{
    binding: 'DB',
    database_name: 'family-running-gallery-dev',
    database_id: 'REPLACE_ONLY_IN_IGNORED_LOCAL_CONFIG'
}]);
assert.deepEqual(config.r2_buckets, [
    {
        binding: 'DERIVATIVE_STAGING',
        bucket_name: 'family-running-gallery-staging-dev'
    },
    {
        binding: 'APPROVED_MEDIA',
        bucket_name: 'family-running-gallery-approved-dev'
    }
]);

for (const forbiddenKey of [
    'ai',
    'analytics_engine_datasets',
    'assets',
    'browser',
    'durable_objects',
    'hyperdrive',
    'kv_namespaces',
    'migrations',
    'queues',
    'routes',
    'services',
    'triggers',
    'vars',
    'vectorize',
    'workflows'
]) {
    assert.equal(Object.hasOwn(config, forbiddenKey), false, forbiddenKey);
}

assert.doesNotMatch(
    configText,
    /PRIVATE_ORIGINALS|PUBLIC_MANIFESTS|GITHUB_TOKEN|GITHUB_REPOSITORY/
);

const [workerSource, serviceSource, cleanupSource] = await Promise.all([
    fs.readFile(path.join(repositoryRoot, 'gallery-admin', 'src', 'promotion-worker.js'), 'utf8'),
    fs.readFile(path.join(repositoryRoot, 'gallery-admin', 'src', 'promotion-service.js'), 'utf8'),
    fs.readFile(
        path.join(repositoryRoot, 'gallery-admin', 'src', 'promotion-cleanup-service.js'),
        'utf8'
    )
]);
for (const [label, source] of [
    ['promotion Worker', workerSource],
    ['promotion service', serviceSource]
]) {
    assert.doesNotMatch(source, /\.(?:delete|list)\s*\(/, `${label} has deletion or listing capability.`);
    assert.doesNotMatch(
        source,
        /PRIVATE_ORIGINALS|PUBLIC_MANIFESTS|GITHUB_TOKEN|GITHUB_REPOSITORY/,
        `${label} names a forbidden capability.`
    );
}
assert.match(cleanupSource, /APPROVED_MEDIA\.delete\s*\(/);
assert.match(cleanupSource, /bucket\.list\s*\(/);
assert.doesNotMatch(cleanupSource, /APPROVED_MEDIA\.put\s*\(/);
assert.doesNotMatch(
    cleanupSource,
    /PRIVATE_ORIGINALS|PUBLIC_MANIFESTS|GITHUB_TOKEN|GITHUB_REPOSITORY/
);

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gallery-promotion-config-'));
assert.equal(path.dirname(temporaryRoot), os.tmpdir());
try {
    const outdir = path.join(temporaryRoot, 'dry-run');
    const wranglerConfigRoot = path.join(temporaryRoot, 'wrangler-config');
    await fs.mkdir(wranglerConfigRoot);
    const wranglerPath = path.join(repositoryRoot, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
    const dryRun = spawnSync(process.execPath, [
        wranglerPath,
        'deploy',
        '--dry-run',
        '--config',
        configPath,
        '--outdir',
        outdir,
        '--strict',
        '--autoconfig=false',
        '--experimental-auto-create=false'
    ], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
            ...process.env,
            CI: '1',
            WRANGLER_SEND_METRICS: 'false',
            XDG_CONFIG_HOME: wranglerConfigRoot
        },
        timeout: 30_000
    });
    assert.equal(dryRun.status, 0, diagnostic(dryRun));
    const output = `${dryRun.stdout || ''}\n${dryRun.stderr || ''}`;
    assert.match(output, /env\.DB/);
    assert.match(output, /env\.DERIVATIVE_STAGING/);
    assert.match(output, /env\.APPROVED_MEDIA/);
    assert.match(output, /family-running-gallery-staging-dev/);
    assert.match(output, /family-running-gallery-approved-dev/);
    assert.doesNotMatch(
        output,
        /PRIVATE_ORIGINALS|PUBLIC_MANIFESTS|GITHUB_TOKEN|GITHUB_REPOSITORY/
    );

    const bundle = await readJavaScriptOutput(outdir);
    assert.match(bundle, /photo-promotions/);
    assert.match(bundle, /photo-promotions\/.+\/cleanup/);
    assert.match(bundle, /APPROVED_MEDIA/);
    assert.match(bundle, /DERIVATIVE_STAGING/);
    assert.doesNotMatch(
        bundle,
        /PRIVATE_ORIGINALS|PUBLIC_MANIFESTS|GITHUB_TOKEN|GITHUB_REPOSITORY/
    );
} finally {
    assert.equal(path.dirname(temporaryRoot), os.tmpdir());
    await fs.rm(temporaryRoot, { recursive: true, force: true });
}

console.log('Gallery photo promotion Wrangler config tests passed.');

function diagnostic(result) {
    return `Wrangler exited ${result.status}:\n${result.stdout || ''}\n${result.stderr || ''}`;
}

async function readJavaScriptOutput(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files = entries
        .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
        .map(entry => path.join(directory, entry.name));
    assert.ok(files.length >= 1, 'Wrangler dry-run must emit JavaScript.');
    return (await Promise.all(files.map(file => fs.readFile(file, 'utf8')))).join('\n');
}
