import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    buildV1ApprovedDerivativeKey,
    DERIVATIVE_KEY_SPECS
} from '../gallery-admin/src/storage-keys.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const requirementPath = path.join(
    repositoryRoot,
    'gallery-admin',
    'approved-media-lifecycle.required.json'
);
const requirementText = await fs.readFile(requirementPath, 'utf8');
const requirement = JSON.parse(requirementText);

assert.deepEqual(Object.keys(requirement), [
    'schemaVersion',
    'bucketName',
    'evidenceBoundary',
    'requiredRule'
]);
assert.equal(requirement.schemaVersion, '1.0');
assert.equal(requirement.bucketName, 'family-running-gallery-approved-dev');
assert.deepEqual(requirement.evidenceBoundary, {
    purpose: 'orphan-multipart-containment-only',
    synchronousCleanupProof: false,
    permitsTombstoneOrPurge: false
});
assert.deepEqual(requirement.requiredRule, {
    id: 'gallery-approved-v1-abort-incomplete-1d',
    enabled: true,
    conditions: { prefix: 'media/v1/' },
    abortMultipartUploadsTransition: {
        condition: { type: 'Age', maxAge: 86_400 }
    }
});

// This is a requirement fragment, not a complete policy suitable for the
// destructive lifecycle `set` operation.
assert.equal(Object.hasOwn(requirement, 'rules'), false);
assert.doesNotMatch(
    requirementText,
    /deleteObjectsTransition|storageClassTransitions|expire|expiration/i
);

for (const role of Object.keys(DERIVATIVE_KEY_SPECS)) {
    const key = buildV1ApprovedDerivativeKey({ sha256: 'a'.repeat(64), role });
    assert.equal(key.startsWith(requirement.requiredRule.conditions.prefix), true, role);
}

const wranglerPath = path.join(
    repositoryRoot,
    'node_modules',
    'wrangler',
    'bin',
    'wrangler.js'
);
const temporaryArtifactRoot = path.join(repositoryRoot, 'test-artifacts');
await fs.mkdir(temporaryArtifactRoot, { recursive: true });
const temporaryConfigRoot = await fs.mkdtemp(path.join(temporaryArtifactRoot, 'wrangler-help-'));
try {
    const help = spawnSync(process.execPath, [
        wranglerPath,
        'r2',
        'bucket',
        'lifecycle',
        'add',
        '--help'
    ], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
            ...process.env,
            CI: '1',
            WRANGLER_SEND_METRICS: 'false',
            XDG_CONFIG_HOME: temporaryConfigRoot
        },
        timeout: 30_000
    });
    assert.equal(help.status, 0, `${help.stdout || ''}\n${help.stderr || ''}`);
    const output = `${help.stdout || ''}\n${help.stderr || ''}`;
    assert.match(output, /--abort-multipart-days/);
    assert.match(output, /--force[\s\S]*default: false/);
} finally {
    await fs.rm(temporaryConfigRoot, { recursive: true, force: true });
}

const ignoreText = await fs.readFile(
    path.join(repositoryRoot, 'gallery-admin', '.gitignore'),
    'utf8'
);
assert.match(ignoreText, /^wrangler\.promotion\.local\.jsonc$/m);

console.log('Gallery approved-media lifecycle requirement tests passed.');
