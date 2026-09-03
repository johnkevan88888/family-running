import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import withdrawalFinalizerWorker, {
    handleWithdrawalFinalizerRequest
} from '../gallery-admin/src/withdrawal-finalizer-worker.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const finalizerOrigin = 'https://synthetic-gallery-withdrawal-finalizer.example';
const finalizerSubject = '0123456789abcdef0123456789abcdef.access';
const draftId = 'draft_11111111-1111-4111-8111-111111111111';
const route = `/api/service/drafts/${draftId}/withdrawal-finalizations`;
const withdrawalDigest = createHash('sha256')
    .update(`gallery-withdrawal:${draftId}`)
    .digest('hex');
const validInput = Object.freeze({
    idempotencyKey: `gallery-withdrawal-${withdrawalDigest.slice(0, 32)}`
});
const retentionEligibleAt = '2026-10-03T18:00:00.000Z';

assert.equal(typeof withdrawalFinalizerWorker.fetch, 'function');

const configPath = path.join(
    repositoryRoot,
    'gallery-admin',
    'wrangler.withdrawal-finalizer.example.jsonc'
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
assert.equal(config.account_id, 'REPLACE_ONLY_IN_IGNORED_LOCAL_CONFIG');
assert.equal(config.name, 'family-running-gallery-withdrawal-finalizer-dev');
assert.equal(config.main, 'src/withdrawal-finalizer-worker.js');
assert.equal(config.compatibility_date, '2026-09-03');
assert.equal(config.workers_dev, true);
assert.equal(config.preview_urls, false);
assert.deepEqual(config.observability, { enabled: false });
assert.deepEqual(config.d1_databases, [{
    binding: 'DB',
    database_name: 'family-running-gallery-dev',
    database_id: 'REPLACE_ONLY_IN_IGNORED_LOCAL_CONFIG'
}]);
assert.deepEqual(config.r2_buckets, [{
    binding: 'PRIVATE_ORIGINALS',
    bucket_name: 'family-running-gallery-originals-dev'
}]);

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
    'route',
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
    /APPROVED_MEDIA|DERIVATIVE_STAGING|PUBLIC_MANIFESTS|GITHUB_TOKEN|GITHUB_REPOSITORY/
);
assert.doesNotMatch(configText, /FINALIZER_IDENTITY|FINALIZER_ORIGIN/);

await assertWranglerDryRun(configPath);

const capabilityCalls = [];
const environment = createEnvironment(capabilityCalls);
const serviceCalls = [];
const validDependencies = {
    verifyAccessIdentity: async () => ({
        type: 'service',
        subject: finalizerSubject
    }),
    async finalizeGalleryWithdrawal(...args) {
        serviceCalls.push(args);
        return {
            ok: true,
            status: 201,
            code: 'withdrawn',
            replayed: false,
            privateOriginalKey: 'must-not-cross-worker-boundary',
            withdrawalKind: 'must-not-cross-worker-boundary',
            finalReceiptHash: 'a'.repeat(64)
        };
    }
};

// The default entry point accepts only a Cloudflare Access service identity.
// A GET proves the identity and route handling without entering the finalizer.
const defaultResponse = await withdrawalFinalizerWorker.fetch(
    new Request(`${finalizerOrigin}${route}`, { method: 'GET' }),
    environment,
    accessContext()
);
assert.equal(defaultResponse.status, 405);
assert.equal(defaultResponse.headers.get('Allow'), 'POST');
assert.equal((await withdrawalFinalizerWorker.fetch(
    new Request(`${finalizerOrigin}${route}`, { method: 'GET' }),
    environment,
    {}
)).status, 403);

const validResponse = await finalizerRequest(
    {},
    environment,
    validDependencies
);
assert.equal(validResponse.status, 201);
assert.deepEqual(await validResponse.json(), {
    status: 'withdrawn',
    replayed: false
});
assertSafeResponseHeaders(validResponse);
assert.equal(serviceCalls.length, 1);
assert.equal(serviceCalls[0][0], environment);
assert.deepEqual(serviceCalls[0][1], {
    type: 'service',
    subject: finalizerSubject
});
assert.equal(serviceCalls[0][2], draftId);
assert.deepEqual(serviceCalls[0][3], validInput);
assert.equal(serviceCalls[0].length, 4);
assert.deepEqual(capabilityCalls, []);

// Service-token requests normally carry no browser cookie. If the Access
// runtime supplies its assertion cookie, that cookie must be exact and alone.
const assertionCookieResponse = await finalizerRequest({
    headers: {
        'Cf-Access-Jwt-Assertion': 'synthetic.assertion.value',
        Cookie: 'CF_Authorization=synthetic.assertion.value'
    }
}, environment, validDependencies);
assert.equal(assertionCookieResponse.status, 201);

for (const testCase of [
    {
        label: 'missing identity',
        dependencies: {
            ...validDependencies,
            verifyAccessIdentity: async () => null
        }
    },
    {
        label: 'browser identity',
        dependencies: {
            ...validDependencies,
            verifyAccessIdentity: async () => ({
                type: 'browser',
                subject: 'owner',
                email: 'owner@example.test'
            })
        }
    },
    {
        label: 'wrong service identity',
        dependencies: {
            ...validDependencies,
            verifyAccessIdentity: async () => ({
                type: 'service',
                subject: 'fedcba9876543210fedcba9876543210.access'
            })
        }
    },
    {
        label: 'malformed service identity',
        dependencies: {
            ...validDependencies,
            verifyAccessIdentity: async () => ({
                type: 'service',
                subject: 'not-an-access-service-id'
            })
        }
    },
    {
        label: 'identity verifier failure',
        dependencies: {
            ...validDependencies,
            verifyAccessIdentity: async () => {
                throw new Error('private-access-error');
            }
        }
    },
    {
        label: 'wrong request origin',
        url: `https://wrong-finalizer.example${route}`
    },
    {
        label: 'non-canonical configured origin',
        env: {
            ...environment,
            FINALIZER_ORIGIN: `${finalizerOrigin}/`
        }
    },
    {
        label: 'HTTP configured origin',
        env: {
            ...environment,
            FINALIZER_ORIGIN: 'http://synthetic-gallery-withdrawal-finalizer.example'
        },
        url: `http://synthetic-gallery-withdrawal-finalizer.example${route}`
    },
    {
        label: 'plural configured identity',
        env: {
            ...environment,
            FINALIZER_IDENTITY:
                `subject:${finalizerSubject},subject:${finalizerSubject}`
        }
    },
    {
        label: 'browser cookie',
        headers: { Cookie: 'session=forbidden' }
    },
    {
        label: 'assertion cookie without assertion header',
        headers: { Cookie: 'CF_Authorization=synthetic.assertion.value' }
    },
    {
        label: 'mismatched assertion cookie',
        headers: {
            'Cf-Access-Jwt-Assertion': 'synthetic.assertion.value',
            Cookie: 'CF_Authorization=different.assertion'
        }
    },
    {
        label: 'assertion cookie plus another cookie',
        headers: {
            'Cf-Access-Jwt-Assertion': 'synthetic.assertion.value',
            Cookie: 'CF_Authorization=synthetic.assertion.value; session=forbidden'
        }
    },
    {
        label: 'browser CSRF header',
        headers: { 'X-CSRF-Token': 'forbidden' }
    }
]) {
    const before = serviceCalls.length;
    const testEnvironment = testCase.env || environment;
    const response = await finalizerRequest(
        testCase,
        testEnvironment,
        testCase.dependencies || validDependencies
    );
    assert.equal(response.status, 403, testCase.label);
    assert.deepEqual(await response.json(), { error: 'forbidden' }, testCase.label);
    assert.equal(serviceCalls.length, before, `${testCase.label} reached service.`);
}

for (const testCase of [
    { label: 'query', url: `${finalizerOrigin}${route}?key=caller-selected` },
    { label: 'fragment', url: `${finalizerOrigin}${route}#caller-selected` },
    {
        label: 'wrong draft version',
        url: `${finalizerOrigin}/api/service/drafts/` +
            'draft_11111111-1111-5111-8111-111111111111/withdrawal-finalizations'
    },
    {
        label: 'uppercase draft id',
        url: `${finalizerOrigin}${route.replace('draft_', 'DRAFT_')}`
    },
    { label: 'wrong route', url: `${finalizerOrigin}/api/service/withdrawals` },
    { label: 'trailing slash', url: `${finalizerOrigin}${route}/` },
    { label: 'caller-selected action', url: `${finalizerOrigin}${route}/purge` }
]) {
    const before = serviceCalls.length;
    const response = await finalizerRequest(
        testCase,
        environment,
        validDependencies
    );
    assert.equal(response.status, 404, testCase.label);
    assert.deepEqual(await response.json(), { error: 'not-found' }, testCase.label);
    assert.equal(serviceCalls.length, before, `${testCase.label} reached service.`);
}

for (const [label, invalidEnvironment] of [
    ['extra approved-media binding', { ...environment, APPROVED_MEDIA: {} }],
    ['extra staging binding', { ...environment, DERIVATIVE_STAGING: {} }],
    ['extra public-manifest binding', { ...environment, PUBLIC_MANIFESTS: {} }],
    ['extra GitHub token', { ...environment, GITHUB_TOKEN: 'forbidden' }],
    ['extra GitHub repository', {
        ...environment,
        GITHUB_REPOSITORY: 'forbidden/repository'
    }],
    ['missing D1 binding', withoutKey(environment, 'DB')],
    ['missing private-original binding', withoutKey(environment, 'PRIVATE_ORIGINALS')],
    ['invalid D1 binding', { ...environment, DB: { prepare() {} } }],
    ['private-original binding with no get', {
        ...environment,
        PRIVATE_ORIGINALS: withoutKey(environment.PRIVATE_ORIGINALS, 'get')
    }],
    ['private-original binding with no delete', {
        ...environment,
        PRIVATE_ORIGINALS: withoutKey(environment.PRIVATE_ORIGINALS, 'delete')
    }],
    ['private-original binding with no list', {
        ...environment,
        PRIVATE_ORIGINALS: withoutKey(environment.PRIVATE_ORIGINALS, 'list')
    }]
]) {
    const before = serviceCalls.length;
    const response = await finalizerRequest(
        {},
        invalidEnvironment,
        validDependencies
    );
    assert.equal(response.status, 503, label);
    assert.deepEqual(
        await response.json(),
        { error: 'service-unavailable' },
        label
    );
    assert.equal(serviceCalls.length, before, `${label} reached service.`);
}

for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
    const before = serviceCalls.length;
    const response = await finalizerRequest(
        { method, body: undefined },
        environment,
        validDependencies
    );
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get('Allow'), 'POST', method);
    assert.equal(serviceCalls.length, before, `${method} reached service.`);
}

for (const testCase of [
    { label: 'wrong content type', contentType: 'text/plain' },
    {
        label: 'content type with charset',
        contentType: 'application/json; charset=utf-8'
    },
    { label: 'content encoding', headers: { 'Content-Encoding': 'gzip' } },
    { label: 'missing body', body: null },
    { label: 'missing declared length', skipDeclaredLength: true },
    { label: 'zero declared length', declaredLength: '0' },
    { label: 'leading-zero declared length', declaredLength: '01' },
    { label: 'non-numeric declared length', declaredLength: 'one' },
    { label: 'declared length mismatch', declaredLength: '1' },
    { label: 'malformed JSON', body: '{not-json}' }
]) {
    const before = serviceCalls.length;
    const response = await finalizerRequest(
        testCase,
        environment,
        validDependencies
    );
    assert.equal(response.status, 400, testCase.label);
    assert.deepEqual(
        await response.json(),
        { error: 'invalid-request' },
        testCase.label
    );
    assert.equal(serviceCalls.length, before, `${testCase.label} reached service.`);
}

const oversizedBody = JSON.stringify({ value: 'x'.repeat(33 * 1024) });
for (const testCase of [
    {
        label: 'declared body over limit',
        body: '{}',
        declaredLength: String((32 * 1024) + 1)
    },
    { label: 'actual body over limit', body: oversizedBody }
]) {
    const before = serviceCalls.length;
    const response = await finalizerRequest(
        testCase,
        environment,
        validDependencies
    );
    assert.equal(response.status, 413, testCase.label);
    assert.deepEqual(
        await response.json(),
        { error: 'request-too-large' },
        testCase.label
    );
    assert.equal(serviceCalls.length, before, `${testCase.label} reached service.`);
}

const invalidUtf8Body = new ReadableStream({
    start(controller) {
        controller.enqueue(new Uint8Array([0xc3, 0x28]));
        controller.close();
    }
});
const invalidUtf8Response = await handleWithdrawalFinalizerRequest(
    streamedRequest(invalidUtf8Body, '2'),
    environment,
    validDependencies
);
assert.equal(invalidUtf8Response.status, 400);

let stalledBodyCancelCalls = 0;
const stalledBody = new ReadableStream({
    start() {},
    cancel() {
        stalledBodyCancelCalls += 1;
        return new Promise(() => {});
    }
});
const callsBeforeTimeout = serviceCalls.length;
const timeoutStartedAt = Date.now();
const timeoutResponse = await handleWithdrawalFinalizerRequest(
    streamedRequest(stalledBody, '1'),
    environment,
    { ...validDependencies, bodyTimeoutMilliseconds: 20 }
);
assert.equal(timeoutResponse.status, 400);
assert.deepEqual(await timeoutResponse.json(), { error: 'invalid-request' });
assert.ok(Date.now() - timeoutStartedAt < 1_000);
assert.equal(stalledBodyCancelCalls, 1);
assert.equal(serviceCalls.length, callsBeforeTimeout);

let oversizedStreamCancelCalls = 0;
const oversizedStream = new ReadableStream({
    start(controller) {
        controller.enqueue(new Uint8Array((32 * 1024) + 1));
    },
    cancel() {
        oversizedStreamCancelCalls += 1;
        return new Promise(() => {});
    }
});
const oversizedStreamStartedAt = Date.now();
const oversizedStreamResponse = await handleWithdrawalFinalizerRequest(
    streamedRequest(oversizedStream, String(32 * 1024)),
    environment,
    { ...validDependencies, bodyTimeoutMilliseconds: 2_000 }
);
assert.equal(oversizedStreamResponse.status, 413);
assert.ok(Date.now() - oversizedStreamStartedAt < 1_000);
assert.equal(oversizedStreamCancelCalls, 1);

// Exact business-body keys are validated by the real finalizer before either
// D1 or R2 can be touched. The Worker maps that result to one safe error.
for (const invalidBody of [
    {},
    { ...validInput, expectedStateVersion: 1 },
    { ...validInput, targetUrl: 'https://caller-selected.example/photo.webp' },
    { ...validInput, privateOriginalKey: 'caller-selected' },
    { idempotencyKey: 'too-short' },
    { idempotencyKey: 'A'.repeat(129) },
    [],
    null,
    'caller-selected'
]) {
    const invalidCapabilityCalls = [];
    const invalidEnvironment = createEnvironment(invalidCapabilityCalls);
    const response = await finalizerRequest(
        { body: JSON.stringify(invalidBody) },
        invalidEnvironment,
        {
            verifyAccessIdentity: validDependencies.verifyAccessIdentity
        }
    );
    assert.equal(response.status, 400, JSON.stringify(invalidBody));
    assert.deepEqual(await response.json(), { error: 'invalid-request' });
    assert.deepEqual(
        invalidCapabilityCalls,
        [],
        `${JSON.stringify(invalidBody)} reached a destructive capability.`
    );
}

const safeResultCases = [
    {
        result: {
            ok: true,
            status: 202,
            code: 'host-verification-required',
            expectedStateVersion: 17,
            verifierIdempotencyKey: 'public-host-verifier-0001',
            replayed: false,
            privateOriginalKey: 'must-not-cross-worker-boundary'
        },
        expectedStatus: 202,
        expectedBody: {
            status: 'host-verification-required',
            expectedStateVersion: 17,
            verifierIdempotencyKey: 'public-host-verifier-0001',
            replayed: false
        }
    },
    {
        result: {
            ok: true,
            status: 200,
            code: 'withdrawn',
            replayed: true,
            finalReceiptHash: 'a'.repeat(64)
        },
        expectedStatus: 200,
        expectedBody: { status: 'withdrawn', replayed: true }
    },
    {
        result: {
            ok: true,
            status: 202,
            code: 'retention-pending',
            eligibleAt: retentionEligibleAt,
            replayed: false,
            withdrawalKind: 'editorial-removal'
        },
        expectedStatus: 202,
        expectedBody: {
            status: 'retention-pending',
            eligibleAt: retentionEligibleAt,
            replayed: false
        }
    },
    {
        result: {
            ok: true,
            status: 201,
            code: 'purged',
            replayed: false,
            deletedPrivateOriginal: true
        },
        expectedStatus: 201,
        expectedBody: { status: 'purged', replayed: false }
    },
    {
        result: {
            ok: false,
            status: 400,
            code: 'invalid-request',
            privateReason: 'must-not-cross-worker-boundary'
        },
        expectedStatus: 400,
        expectedBody: { error: 'invalid-request' }
    },
    {
        result: { ok: false, status: 404, code: 'not-found' },
        expectedStatus: 404,
        expectedBody: { error: 'not-found' }
    },
    {
        result: { ok: false, status: 409, code: 'conflict' },
        expectedStatus: 409,
        expectedBody: { error: 'conflict' }
    },
    {
        result: { ok: false, status: 503, code: 'finalization-unavailable' },
        expectedStatus: 503,
        expectedBody: { error: 'finalization-unavailable' }
    }
];

for (const testCase of safeResultCases) {
    const response = await requestWithServiceResult(testCase.result);
    assert.equal(response.status, testCase.expectedStatus);
    assert.deepEqual(await response.json(), testCase.expectedBody);
    assertSafeResponseHeaders(response);
}

for (const badResult of [
    null,
    'not-an-object',
    {},
    { ok: false, code: 'invalid-request' },
    { status: 400, code: 'invalid-request' },
    { ok: 'false', status: 400, code: 'invalid-request' },
    { ok: true, status: 202, code: 'unknown', replayed: false },
    {
        ok: true,
        status: 202,
        code: 'host-verification-required',
        expectedStateVersion: -1,
        verifierIdempotencyKey: 'public-host-verifier-0001',
        replayed: false
    },
    {
        ok: true,
        status: 202,
        code: 'host-verification-required',
        expectedStateVersion: 17,
        verifierIdempotencyKey: 'short',
        replayed: false
    },
    { ok: true, status: 202, code: 'withdrawn', replayed: false },
    {
        ok: true,
        status: 202,
        code: 'retention-pending',
        eligibleAt: 'not-a-timestamp',
        replayed: false
    },
    { ok: true, status: 202, code: 'purged', replayed: false },
    { ok: false, status: 418, code: 'conflict' },
    { ok: false, status: 503, code: 'private-provider-error' }
]) {
    const response = await requestWithServiceResult(badResult);
    assert.equal(response.status, 503, JSON.stringify(badResult));
    assert.deepEqual(
        await response.json(),
        { error: 'finalization-unavailable' },
        JSON.stringify(badResult)
    );
}

const thrownServiceResponse = await finalizerRequest({}, environment, {
    ...validDependencies,
    async finalizeGalleryWithdrawal() {
        throw new Error('private-provider-error');
    }
});
assert.equal(thrownServiceResponse.status, 503);
assert.deepEqual(await thrownServiceResponse.json(), {
    error: 'finalization-unavailable'
});

console.log('Gallery withdrawal finalizer Worker and config tests passed.');

function createEnvironment(calls) {
    return {
        DB: {
            prepare(sql) {
                calls.push({ capability: 'DB.prepare', sql });
                throw new Error('D1 must not be reached by this boundary test.');
            },
            async batch() {
                calls.push({ capability: 'DB.batch' });
                throw new Error('D1 must not be reached by this boundary test.');
            }
        },
        FINALIZER_IDENTITY: `subject:${finalizerSubject}`,
        FINALIZER_ORIGIN: finalizerOrigin,
        PRIVATE_ORIGINALS: {
            async head(key) {
                calls.push({ capability: 'PRIVATE_ORIGINALS.head', key });
                throw new Error('R2 must not be reached by this boundary test.');
            },
            async get(key) {
                calls.push({ capability: 'PRIVATE_ORIGINALS.get', key });
                throw new Error('R2 must not be reached by this boundary test.');
            },
            async delete(key) {
                calls.push({ capability: 'PRIVATE_ORIGINALS.delete', key });
                throw new Error('R2 must not be reached by this boundary test.');
            },
            async list(options) {
                calls.push({ capability: 'PRIVATE_ORIGINALS.list', options });
                throw new Error('R2 must not be reached by this boundary test.');
            }
        }
    };
}

function accessContext() {
    return {
        access: {
            async getIdentity() {
                return {
                    service_token_status: true,
                    service_token_id: finalizerSubject
                };
            }
        }
    };
}

async function finalizerRequest(
    options = {},
    env = environment,
    dependencies = validDependencies
) {
    const method = options.method || 'POST';
    const url = options.url || `${finalizerOrigin}${route}`;
    const headers = new Headers(options.headers || {});
    let body = Object.hasOwn(options, 'body')
        ? options.body
        : JSON.stringify(validInput);
    if (body !== null && body !== undefined && method !== 'GET' && method !== 'HEAD') {
        if (!headers.has('Content-Type')) {
            headers.set('Content-Type', options.contentType || 'application/json');
        }
        if (!options.skipDeclaredLength && !headers.has('Content-Length')) {
            headers.set(
                'Content-Length',
                String(options.declaredLength ?? new TextEncoder().encode(body).byteLength)
            );
        }
    } else {
        body = undefined;
    }
    return handleWithdrawalFinalizerRequest(
        new Request(url, { method, headers, body }),
        env,
        dependencies
    );
}

function streamedRequest(body, declaredLength) {
    return new Request(`${finalizerOrigin}${route}`, {
        method: 'POST',
        headers: {
            'Content-Length': declaredLength,
            'Content-Type': 'application/json'
        },
        body,
        duplex: 'half'
    });
}

async function requestWithServiceResult(result) {
    return finalizerRequest({}, environment, {
        ...validDependencies,
        async finalizeGalleryWithdrawal() {
            return result;
        }
    });
}

function withoutKey(value, key) {
    return Object.fromEntries(
        Object.entries(value).filter(([candidate]) => candidate !== key)
    );
}

function assertSafeResponseHeaders(response) {
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(
        response.headers.get('Content-Type'),
        'application/json; charset=utf-8'
    );
    assert.equal(
        response.headers.get('X-Robots-Tag'),
        'noindex, nofollow, noarchive'
    );
}

async function assertWranglerDryRun(workerConfigPath) {
    const temporaryRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), 'gallery-withdrawal-finalizer-config-')
    );
    assert.equal(path.dirname(temporaryRoot), os.tmpdir());
    try {
        const outdir = path.join(temporaryRoot, 'dry-run');
        const wranglerConfigRoot = path.join(temporaryRoot, 'wrangler-config');
        await fs.mkdir(wranglerConfigRoot);
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
            workerConfigPath,
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
        assert.match(output, /env\.PRIVATE_ORIGINALS/);
        assert.doesNotMatch(
            output,
            /APPROVED_MEDIA|DERIVATIVE_STAGING|PUBLIC_MANIFESTS|GITHUB_TOKEN|GITHUB_REPOSITORY/
        );
        const bundle = await readJavaScriptOutput(outdir);
        assert.match(bundle, /withdrawal-finalizations/);
        assert.match(bundle, /PRIVATE_ORIGINALS/);
        assert.doesNotMatch(
            bundle,
            /APPROVED_MEDIA|DERIVATIVE_STAGING|PUBLIC_MANIFESTS|GITHUB_TOKEN|GITHUB_REPOSITORY/
        );
    } finally {
        assert.equal(path.dirname(temporaryRoot), os.tmpdir());
        await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
}

function diagnostic(result) {
    return `Wrangler exited ${result.status}:\n` +
        `${result.stdout || ''}\n${result.stderr || ''}`;
}

async function readJavaScriptOutput(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files = entries
        .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
        .map(entry => path.join(directory, entry.name));
    assert.ok(files.length >= 1, 'Wrangler dry-run must emit JavaScript.');
    return (await Promise.all(
        files.map(file => fs.readFile(file, 'utf8'))
    )).join('\n');
}
