import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

import {
    MEDIA_BINDING_WITNESS_CONTENT_TYPE,
    MEDIA_BINDING_WITNESS_KEY,
    MEDIA_BINDING_WITNESS_PATH,
    MEDIA_BINDING_WITNESS_SHA256,
    MEDIA_BINDING_WITNESS_SIZE,
    MEDIA_DELIVERY_CONTRACT_HEADER,
    MEDIA_DELIVERY_CONTRACT_VALUE,
    MEDIA_DELIVERY_VERSION_HEADER
} from '../gallery-admin/src/media-delivery-contract.js';
import { handleMediaRequest } from '../gallery-admin/src/media-worker.js';

const origin = 'https://synthetic-approved-media.example';
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const versionId = '12345678-1234-5678-9abc-1234567890ab';
const ordinaryHash = 'a'.repeat(64);
const ordinaryKey = `media/v1/${ordinaryHash}/video.mp4`;
const ordinaryBody = new TextEncoder().encode('0123456789');
const witnessBody = await sharp(
    Buffer.from([0, 0, 0, 0]),
    { raw: { width: 1, height: 1, channels: 4 } }
).webp({
    lossless: true,
    quality: 100,
    effort: 6,
    alphaQuality: 100,
    smartSubsample: false
}).toBuffer();

assert.match(MEDIA_BINDING_WITNESS_SHA256, /^[a-f0-9]{64}$/);
assert.equal(
    createHash('sha256').update(witnessBody).digest('hex'),
    MEDIA_BINDING_WITNESS_SHA256
);
assert.equal(
    MEDIA_BINDING_WITNESS_KEY,
    `media/v1/${MEDIA_BINDING_WITNESS_SHA256}/display.webp`
);
assert.equal(MEDIA_BINDING_WITNESS_PATH, `/${MEDIA_BINDING_WITNESS_KEY}`);
assert.equal(MEDIA_BINDING_WITNESS_SIZE, 28);
assert.equal(witnessBody.byteLength, MEDIA_BINDING_WITNESS_SIZE);
assert.equal(MEDIA_BINDING_WITNESS_CONTENT_TYPE, 'image/webp');

const mediaConfigPath = path.join(
    repositoryRoot,
    'gallery-admin',
    'wrangler.media.example.jsonc'
);
const mediaConfig = JSON.parse(await fs.readFile(mediaConfigPath, 'utf8'));
assert.deepEqual(mediaConfig.version_metadata, { binding: 'MEDIA_VERSION' });

await assertWranglerDryRun({
    configPath: mediaConfigPath,
    temporaryPrefix: 'gallery-media-delivery-',
    requiredBundlePatterns: [/APPROVED_MEDIA/, /MEDIA_VERSION/]
});

const bucket = createBucket(new Map([
    [MEDIA_BINDING_WITNESS_KEY, witnessBody],
    [ordinaryKey, ordinaryBody]
]));
const env = validEnv(bucket);

const witnessGet = await request(MEDIA_BINDING_WITNESS_PATH, {}, env);
assert.equal(witnessGet.status, 200);
assertProof(witnessGet);
assert.equal(witnessGet.headers.get('Cache-Control'), 'no-store');
assert.equal(witnessGet.headers.get('Content-Type'), MEDIA_BINDING_WITNESS_CONTENT_TYPE);
assert.equal(witnessGet.headers.get('Content-Length'), String(MEDIA_BINDING_WITNESS_SIZE));
assert.deepEqual(
    new Uint8Array(await witnessGet.arrayBuffer()),
    new Uint8Array(witnessBody)
);
assert.deepEqual(bucket.calls.at(-1), {
    operation: 'get',
    key: MEDIA_BINDING_WITNESS_KEY,
    options: undefined
});

const callsBeforeWitnessHead = bucket.calls.length;
const witnessHead = await request(MEDIA_BINDING_WITNESS_PATH, { method: 'HEAD' }, env);
assert.equal(witnessHead.status, 200);
assertProof(witnessHead);
assert.equal(witnessHead.headers.get('Cache-Control'), 'no-store');
assert.equal(witnessHead.headers.get('Content-Length'), String(MEDIA_BINDING_WITNESS_SIZE));
assert.equal(await witnessHead.text(), '');
assert.deepEqual(bucket.calls.slice(callsBeforeWitnessHead), [{
    operation: 'head',
    key: MEDIA_BINDING_WITNESS_KEY
}]);

const missingWitnessBucket = createBucket(new Map());
for (const method of ['GET', 'HEAD']) {
    const response = await request(
        MEDIA_BINDING_WITNESS_PATH,
        { method },
        validEnv(missingWitnessBucket)
    );
    assert.equal(response.status, 404, method);
    assertProof(response);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(await response.text(), '');
}

const wrongSizeBucket = createBucket(new Map([
    [MEDIA_BINDING_WITNESS_KEY, new Uint8Array(MEDIA_BINDING_WITNESS_SIZE + 1)]
]));
for (const method of ['GET', 'HEAD']) {
    const response = await request(
        MEDIA_BINDING_WITNESS_PATH,
        { method },
        validEnv(wrongSizeBucket)
    );
    assert.equal(response.status, 503, method);
    assertProof(response);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(await response.text(), '');
}

const missingObject = await request(
    `/media/v1/${'b'.repeat(64)}/thumbnail.webp`,
    {},
    env
);
assert.equal(missingObject.status, 404);
assertProof(missingObject);
assert.equal(missingObject.headers.get('Cache-Control'), 'no-store');

const bodylessObject = await request(
    `/media/v1/${'c'.repeat(64)}/display.webp`,
    {},
    validEnv({
        async head() {
            return null;
        },
        async get() {
            return { ...metadata(10), body: null };
        }
    })
);
assert.equal(bodylessObject.status, 503);
assertProof(bodylessObject);
assert.equal(bodylessObject.headers.get('Cache-Control'), 'no-store');

const ordinaryGet = await request(`/${ordinaryKey}`, {}, env);
assert.equal(ordinaryGet.status, 200);
assertProof(ordinaryGet);
assert.equal(ordinaryGet.headers.get('Cache-Control'), 'public, max-age=60, must-revalidate');
assert.deepEqual(new Uint8Array(await ordinaryGet.arrayBuffer()), ordinaryBody);

const callsBeforeRange = bucket.calls.length;
const ordinaryRange = await request(`/${ordinaryKey}`, {
    headers: { Range: 'bytes=2-5' }
}, env);
assert.equal(ordinaryRange.status, 206);
assertProof(ordinaryRange);
assert.equal(ordinaryRange.headers.get('Cache-Control'), 'public, max-age=60, must-revalidate');
assert.equal(ordinaryRange.headers.get('Content-Range'), 'bytes 2-5/10');
assert.equal(ordinaryRange.headers.get('Content-Length'), '4');
assert.equal(await ordinaryRange.text(), '2345');
assert.deepEqual(
    bucket.calls.slice(callsBeforeRange).map(call => call.operation),
    ['head', 'get']
);

const witnessRange = await request(MEDIA_BINDING_WITNESS_PATH, {
    headers: { Range: 'bytes=0-3' }
}, env);
assert.equal(witnessRange.status, 206);
assertProof(witnessRange);
assert.equal(witnessRange.headers.get('Cache-Control'), 'no-store');
assert.equal(witnessRange.headers.get('Content-Range'), `bytes 0-3/${MEDIA_BINDING_WITNESS_SIZE}`);

const invalidRange = await request(`/${ordinaryKey}`, {
    headers: { Range: 'bytes=99-100' }
}, env);
assert.equal(invalidRange.status, 416);
assertProof(invalidRange);
assert.equal(invalidRange.headers.get('Cache-Control'), 'no-store');

const rejectedMethod = await request(`/${ordinaryKey}`, { method: 'POST' }, env);
assert.equal(rejectedMethod.status, 405);
assert.equal(rejectedMethod.headers.get('Allow'), 'GET, HEAD');
assertProof(rejectedMethod);

let invalidConfigR2Calls = 0;
const guardedBucket = {
    async head() {
        invalidConfigR2Calls += 1;
        return null;
    },
    async get() {
        invalidConfigR2Calls += 1;
        return null;
    }
};
for (const [label, invalidEnv] of [
    ['missing environment', undefined],
    ['missing R2 binding', { MEDIA_VERSION: { id: versionId } }],
    ['missing R2 head', { APPROVED_MEDIA: { get() {} }, MEDIA_VERSION: { id: versionId } }],
    ['missing version binding', { APPROVED_MEDIA: guardedBucket }],
    ['non-object version binding', { APPROVED_MEDIA: guardedBucket, MEDIA_VERSION: versionId }],
    ['uppercase version id', {
        APPROVED_MEDIA: guardedBucket,
        MEDIA_VERSION: { id: versionId.toUpperCase() }
    }],
    ['non-canonical version id', {
        APPROVED_MEDIA: guardedBucket,
        MEDIA_VERSION: { id: '12345678123456789abc1234567890ab' }
    }],
    ['nil version id', {
        APPROVED_MEDIA: guardedBucket,
        MEDIA_VERSION: { id: '00000000-0000-0000-0000-000000000000' }
    }],
    ['unexpected extra binding', {
        APPROVED_MEDIA: guardedBucket,
        MEDIA_VERSION: { id: versionId },
        PRIVATE_ORIGINALS: guardedBucket
    }],
    ['wrong UUID variant', {
        APPROVED_MEDIA: guardedBucket,
        MEDIA_VERSION: { id: '12345678-1234-5678-7abc-1234567890ab' }
    }],
    ['throwing R2 getter', Object.defineProperty({
        MEDIA_VERSION: { id: versionId }
    }, 'APPROVED_MEDIA', {
        get() {
            throw new Error('synthetic malformed binding');
        }
    })],
    ['throwing version getter', Object.defineProperty({
        APPROVED_MEDIA: guardedBucket
    }, 'MEDIA_VERSION', {
        get() {
            throw new Error('synthetic malformed binding');
        }
    })]
]) {
    const response = await request(`/${ordinaryKey}`, {}, invalidEnv);
    assert.equal(response.status, 503, label);
    assertNoProof(response, label);
    assert.equal(response.headers.get('Cache-Control'), 'no-store', label);
}
assert.equal(invalidConfigR2Calls, 0);

const invalidPathCallsBefore = bucket.calls.length;
for (const path of [
    '/',
    `/${ordinaryKey}?download=1`,
    `/media/v1/${ordinaryHash.toUpperCase()}/video.mp4`,
    `/media/v1/${ordinaryHash}/original.jpg`
]) {
    const response = await request(path, {}, env);
    assert.equal(response.status, 404, path);
    assertNoProof(response, path);
}
assert.equal(bucket.calls.length, invalidPathCallsBefore);

const failingBucket = {
    async head() {
        throw new Error('synthetic R2 failure');
    },
    async get() {
        throw new Error('synthetic R2 failure');
    }
};
const providerFailure = await request(`/${ordinaryKey}`, {}, validEnv(failingBucket));
assert.equal(providerFailure.status, 503);
assertProof(providerFailure);
assert.equal(providerFailure.headers.get('Cache-Control'), 'no-store');
assert.equal(await providerFailure.text(), '');

console.log('Gallery media delivery contract tests passed.');

function request(path, init, requestEnv) {
    return handleMediaRequest(new Request(`${origin}${path}`, init), requestEnv);
}

function validEnv(approvedMedia) {
    return {
        APPROVED_MEDIA: approvedMedia,
        MEDIA_VERSION: {
            id: versionId,
            tag: 'synthetic-test',
            timestamp: '2026-08-30T00:00:00.000Z'
        }
    };
}

function assertProof(response, label = String(response.status)) {
    assert.equal(
        response.headers.get(MEDIA_DELIVERY_CONTRACT_HEADER),
        MEDIA_DELIVERY_CONTRACT_VALUE,
        label
    );
    assert.equal(response.headers.get(MEDIA_DELIVERY_VERSION_HEADER), versionId, label);
}

function assertNoProof(response, label) {
    assert.equal(response.headers.get(MEDIA_DELIVERY_CONTRACT_HEADER), null, label);
    assert.equal(response.headers.get(MEDIA_DELIVERY_VERSION_HEADER), null, label);
}

function createBucket(objects) {
    const calls = [];
    return {
        calls,
        async head(key) {
            calls.push({ operation: 'head', key });
            const body = objects.get(key);
            return body === undefined ? null : metadata(body.byteLength);
        },
        async get(key, options) {
            calls.push({ operation: 'get', key, options });
            const body = objects.get(key);
            if (body === undefined) {
                return null;
            }
            if (options?.range) {
                const { offset, length } = options.range;
                return {
                    ...metadata(body.byteLength),
                    range: { offset, length },
                    body: body.subarray(offset, offset + length)
                };
            }
            return { ...metadata(body.byteLength), body };
        }
    };
}

function metadata(size) {
    return {
        size,
        etag: 'synthetic-etag',
        httpEtag: '"synthetic-etag"'
    };
}

async function assertWranglerDryRun({
    configPath,
    temporaryPrefix,
    requiredBundlePatterns
}) {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), temporaryPrefix));
    assert.equal(path.dirname(temporaryRoot), os.tmpdir());
    try {
        const outdir = path.join(temporaryRoot, 'dry-run');
        const configRoot = path.join(temporaryRoot, 'wrangler-config');
        await fs.mkdir(configRoot);
        const wranglerPath = path.join(
            repositoryRoot,
            'node_modules',
            'wrangler',
            'bin',
            'wrangler.js'
        );
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
                XDG_CONFIG_HOME: configRoot
            },
            timeout: 30_000
        });
        assert.equal(
            dryRun.status,
            0,
            `Wrangler exited ${dryRun.status}:\n${dryRun.stdout || ''}\n${dryRun.stderr || ''}`
        );
        const bundle = await readJavaScriptOutput(outdir);
        for (const pattern of requiredBundlePatterns) assert.match(bundle, pattern);
    } finally {
        assert.equal(path.dirname(temporaryRoot), os.tmpdir());
        await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
}

async function readJavaScriptOutput(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files = entries
        .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
        .map(entry => path.join(directory, entry.name));
    assert.ok(files.length >= 1, 'Wrangler dry-run must emit JavaScript.');
    return (await Promise.all(files.map(file => fs.readFile(file, 'utf8')))).join('\n');
}
