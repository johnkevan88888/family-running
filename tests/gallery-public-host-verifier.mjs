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
    MEDIA_BINDING_WITNESS_SHA256,
    MEDIA_BINDING_WITNESS_SIZE,
    MEDIA_DELIVERY_CONTRACT_HEADER,
    MEDIA_DELIVERY_CONTRACT_VALUE,
    MEDIA_DELIVERY_VERSION_HEADER
} from '../gallery-admin/src/media-delivery-contract.js';
import {
    PUBLIC_HOST_VERIFIER_SQL,
    verifyPublicHostAbsence
} from '../gallery-admin/src/public-host-verifier-service.js';
import publicHostVerifierWorker, {
    handlePublicHostVerifierRequest
} from '../gallery-admin/src/public-host-verifier-worker.js';

const verifierOrigin = 'https://synthetic-gallery-host-verifier.example';
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const mediaOrigin = 'https://synthetic-approved-media.example';
const verifierSubject = '0123456789abcdef0123456789abcdef.access';
const draftId = 'draft_11111111-1111-4111-8111-111111111111';
const route = `/api/service/drafts/${draftId}/public-host-absence-verifications`;
const versionId = '12345678-1234-5678-9abc-1234567890ab';
const fixedNow = Date.UTC(2026, 7, 30, 17, 0, 0);
const validInput = Object.freeze({
    expectedStateVersion: 23,
    idempotencyKey: 'public-host-verifier-0001'
});
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

assert.equal(
    createHash('sha256').update(witnessBody).digest('hex'),
    MEDIA_BINDING_WITNESS_SHA256
);
assert.equal(witnessBody.byteLength, MEDIA_BINDING_WITNESS_SIZE);
assert.equal(typeof publicHostVerifierWorker.fetch, 'function');

const verifierConfigPath = path.join(
    repositoryRoot,
    'gallery-admin',
    'wrangler.public-host-verifier.example.jsonc'
);
const config = JSON.parse(await fs.readFile(verifierConfigPath, 'utf8'));
assert.equal(config.main, 'src/public-host-verifier-worker.js');
assert.deepEqual(config.compatibility_flags, ['global_fetch_strictly_public']);
assert.deepEqual(
    config.d1_databases.map(binding => binding.binding),
    ['DB']
);
assert.equal(config.r2_buckets, undefined);
assert.equal(config.services, undefined);
assert.equal(config.vars.MEDIA_CONTRACT, MEDIA_DELIVERY_CONTRACT_VALUE);
assert.equal(config.vars.MEDIA_WITNESS_KEY, MEDIA_BINDING_WITNESS_KEY);
assert.equal(config.vars.MEDIA_WITNESS_SHA256, MEDIA_BINDING_WITNESS_SHA256);
assert.equal(
    config.vars.MEDIA_WITNESS_BYTE_COUNT,
    String(MEDIA_BINDING_WITNESS_SIZE)
);
assert.equal(
    config.vars.MEDIA_WITNESS_CONTENT_TYPE,
    MEDIA_BINDING_WITNESS_CONTENT_TYPE
);

await assertWranglerDryRun(verifierConfigPath);

// The boundary is service-token-only, has one fixed origin and route, and has
// no way for a caller to supply a host, key, generation, role, or status.
const boundaryDatabase = createNoCallDatabase();
const boundaryEnvironment = validEnvironment(boundaryDatabase);
const defaultMethodResponse = await publicHostVerifierWorker.fetch(
    new Request(`${verifierOrigin}${route}`, { method: 'GET' }),
    boundaryEnvironment,
    accessContext()
);
assert.equal(defaultMethodResponse.status, 405);
assert.equal(defaultMethodResponse.headers.get('Allow'), 'POST');
assert.equal(boundaryDatabase.calls.length, 0);

const serviceCalls = [];
const validDependencies = {
    verifyAccessIdentity: async () => ({
        type: 'service',
        subject: verifierSubject
    }),
    now: () => fixedNow,
    fetch: async () => {
        throw new Error('Injected service must own outbound fetch.');
    },
    async verifyPublicHostAbsence(...args) {
        serviceCalls.push(args);
        return {
            ok: true,
            status: 201,
            verificationId: `hostverify_${'a'.repeat(32)}`,
            hostDeletionConfirmed: true,
            replayed: false,
            approvedObjectKey: 'must-not-cross-worker-boundary',
            publicUrl: 'must-not-cross-worker-boundary'
        };
    }
};
const validBoundaryResponse = await boundaryRequest(
    {},
    boundaryEnvironment,
    validDependencies
);
assert.equal(validBoundaryResponse.status, 201);
assert.deepEqual(await validBoundaryResponse.json(), {
    verificationId: `hostverify_${'a'.repeat(32)}`,
    hostDeletionConfirmed: true,
    replayed: false
});
assert.equal(validBoundaryResponse.headers.get('Cache-Control'), 'no-store');
assert.equal(serviceCalls.length, 1);
assert.equal(serviceCalls[0][0], boundaryEnvironment);
assert.deepEqual(serviceCalls[0][1], {
    type: 'service',
    subject: verifierSubject
});
assert.equal(serviceCalls[0][2], draftId);
assert.deepEqual(serviceCalls[0][3], validInput);
assert.equal(serviceCalls[0][4], fixedNow);
assert.equal(serviceCalls[0][5].fetch, validDependencies.fetch);
assert.equal(boundaryDatabase.calls.length, 0);

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
            verifyAccessIdentity: async () => ({ type: 'browser', subject: 'owner' })
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
        label: 'wrong origin',
        url: `https://wrong-verifier.example${route}`
    },
    { label: 'browser cookie', headers: { Cookie: 'session=forbidden' } },
    {
        label: 'mismatched assertion cookie',
        headers: {
            'Cf-Access-Jwt-Assertion': 'synthetic.assertion.value',
            Cookie: 'CF_Authorization=different.assertion'
        }
    },
    { label: 'browser CSRF header', headers: { 'X-CSRF-Token': 'forbidden' } },
    {
        label: 'plural identity configuration',
        env: {
            ...boundaryEnvironment,
            PUBLIC_HOST_VERIFIER_IDENTITY:
                `subject:${verifierSubject},subject:${verifierSubject}`
        }
    }
]) {
    const before = serviceCalls.length;
    const response = await boundaryRequest(
        testCase,
        testCase.env || boundaryEnvironment,
        testCase.dependencies || validDependencies
    );
    assert.equal(response.status, 403, testCase.label);
    assert.equal(serviceCalls.length, before, `${testCase.label} reached service.`);
    assert.equal(boundaryDatabase.calls.length, 0, `${testCase.label} reached D1.`);
}

for (const testCase of [
    { label: 'query', url: `${verifierOrigin}${route}?target=caller-selected` },
    { label: 'fragment', url: `${verifierOrigin}${route}#target` },
    { label: 'wrong route', url: `${verifierOrigin}/api/service/public-host-absence` },
    { label: 'caller destination', url: `${verifierOrigin}${route}/everyone` }
]) {
    const before = serviceCalls.length;
    const response = await boundaryRequest(
        testCase,
        boundaryEnvironment,
        validDependencies
    );
    assert.equal(response.status, 404, testCase.label);
    assert.equal(serviceCalls.length, before, `${testCase.label} reached service.`);
}

for (const [label, invalidEnvironment] of [
    ['extra R2 binding', { ...boundaryEnvironment, APPROVED_MEDIA: {} }],
    ['extra GitHub token', { ...boundaryEnvironment, GITHUB_TOKEN: 'forbidden' }],
    ['missing D1', { ...boundaryEnvironment, DB: undefined }],
    ['wrong media contract', {
        ...boundaryEnvironment,
        MEDIA_CONTRACT: 'caller-media-v1'
    }],
    ['wrong witness', {
        ...boundaryEnvironment,
        MEDIA_WITNESS_KEY: `media/v1/${'f'.repeat(64)}/display.webp`
    }],
    ['non-canonical media version', {
        ...boundaryEnvironment,
        EXPECTED_MEDIA_VERSION: versionId.toUpperCase()
    }],
    ['same verifier and media origin', {
        ...boundaryEnvironment,
        APPROVED_MEDIA_ORIGIN: verifierOrigin
    }]
]) {
    const before = serviceCalls.length;
    const response = await boundaryRequest(
        { env: invalidEnvironment },
        invalidEnvironment,
        validDependencies
    );
    assert.equal(response.status, 503, label);
    assert.equal(serviceCalls.length, before, `${label} reached service.`);
}

const assertionCookieResponse = await boundaryRequest({
    headers: {
        'Cf-Access-Jwt-Assertion': 'synthetic.assertion.value',
        Cookie: 'CF_Authorization=synthetic.assertion.value'
    }
}, boundaryEnvironment, validDependencies);
assert.equal(assertionCookieResponse.status, 201);

const methodResponse = await boundaryRequest(
    { method: 'GET', body: undefined },
    boundaryEnvironment,
    validDependencies
);
assert.equal(methodResponse.status, 405);
assert.equal(methodResponse.headers.get('Allow'), 'POST');

for (const testCase of [
    { label: 'wrong content type', contentType: 'text/plain' },
    { label: 'content encoding', headers: { 'Content-Encoding': 'gzip' } },
    { label: 'missing body', body: null },
    { label: 'declared length mismatch', declaredLength: 1 },
    { label: 'malformed JSON', body: '{not-json}' }
]) {
    const before = serviceCalls.length;
    const response = await boundaryRequest(
        testCase,
        boundaryEnvironment,
        validDependencies
    );
    assert.equal(response.status, 400, testCase.label);
    assert.equal(serviceCalls.length, before, `${testCase.label} reached service.`);
}

let stalledBodyCancelCalls = 0;
const stalledBodyStream = new ReadableStream({
    start() {},
    cancel() {
        stalledBodyCancelCalls += 1;
        return new Promise(() => {});
    }
});
const callsBeforeStalledBody = serviceCalls.length;
const stalledBodyStartedAt = Date.now();
const stalledInboundResponse = await handlePublicHostVerifierRequest(
    new Request(`${verifierOrigin}${route}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': '1'
        },
        body: stalledBodyStream,
        duplex: 'half'
    }),
    boundaryEnvironment,
    {
        ...validDependencies,
        bodyTimeoutMilliseconds: 20
    }
);
assert.equal(stalledInboundResponse.status, 400);
assert.deepEqual(await stalledInboundResponse.json(), {
    error: 'invalid-request'
});
assert.ok(Date.now() - stalledBodyStartedAt < 1_000);
assert.equal(stalledBodyCancelCalls, 1);
assert.equal(serviceCalls.length, callsBeforeStalledBody);
assert.equal(boundaryDatabase.calls.length, 0);

// Service-level proof: D1 supplies every URL/key, reservations precede fetch,
// two witness probes bracket HEAD+GET checks, and a final target HEAD pass
// precedes the generation/state re-read and one atomic receipt transaction.
const happyDatabase = await createVerifierDatabase();
const happyEnvironment = validEnvironment(happyDatabase);
const happyFetch = createMediaFetch({ database: happyDatabase });
const happyResult = await verifyPublicHostAbsence(
    happyEnvironment,
    serviceIdentity(),
    draftId,
    validInput,
    fixedNow,
    { fetch: happyFetch }
);
assert.equal(happyResult.ok, true);
assert.equal(happyResult.status, 201);
assert.equal(happyResult.replayed, false);
assert.match(happyResult.verificationId, /^hostverify_[a-f0-9]{32}$/);
assert.equal(happyDatabase.evidence.hostDeletionConfirmed, 1);
assert.equal(happyDatabase.receipts.size, 1);
assert.equal(happyDatabase.reservations.size, 2);
assert.equal(happyDatabase.targetProofs.length, 2);
assert.equal(happyDatabase.witnessProofs.length, 1);
const storedAttempt = [...happyDatabase.verifications.values()][0];
const storedReceipt = [...happyDatabase.receipts.values()][0];
assert.ok(Date.parse(happyDatabase.targetProofs[0].verifiedAt) >
    Date.parse(storedAttempt.createdAt));
assert.ok(Date.parse(happyDatabase.witnessProofs[0].verifiedAt) >
    Date.parse(storedAttempt.createdAt));
assert.ok(Date.parse(storedReceipt.verifiedAt) >
    Date.parse(happyDatabase.targetProofs[0].verifiedAt));
assert.deepEqual(
    happyFetch.calls.map(call => `${call.kind}:${call.method}`),
    [
        'witness:HEAD',
        'witness:GET',
        'target:HEAD',
        'target:GET',
        'target:HEAD',
        'target:GET',
        'witness:HEAD',
        'witness:GET',
        'target:HEAD',
        'target:HEAD'
    ]
);
for (const call of happyFetch.calls) {
    assert.equal(call.redirect, 'manual');
    assert.equal(call.cache, 'no-store');
    assert.equal(call.credentials, 'omit');
    assert.equal(call.authorization, null);
    assert.equal(call.cookie, null);
    assert.equal(call.accessAssertion, null);
    assert.equal(call.cacheControl, 'no-cache, no-store');
    assert.equal(call.pragma, 'no-cache');
}
assert.equal(
    happyFetch.calls.some(call => call.url.includes('caller-selected')),
    false
);
assert.ok(
    happyDatabase.events.indexOf('batch:insert-verification') <
        happyDatabase.events.indexOf('batch:reserve-key')
);
assert.ok(
    happyDatabase.events.indexOf('batch:reserve-key') <
        happyDatabase.events.indexOf('fetch:witness:HEAD')
);
assert.ok(
    happyDatabase.events.lastIndexOf('read:targets') <
        happyDatabase.events.indexOf('batch:insert-receipt')
);

const fetchesBeforeReplay = happyFetch.calls.length;
const readsBeforeReplay = happyDatabase.events.length;
const replayResult = await verifyPublicHostAbsence(
    happyEnvironment,
    serviceIdentity(),
    draftId,
    validInput,
    fixedNow + 1_000,
    { fetch: happyFetch }
);
assert.equal(replayResult.status, 200);
assert.equal(replayResult.replayed, true);
assert.equal(happyFetch.calls.length, fetchesBeforeReplay);
assert.deepEqual(
    happyDatabase.events.slice(readsBeforeReplay),
    ['read:current-epoch', 'read:current-receipt']
);

// Lost response from the final D1 transaction is an exact 200 replay, because
// D1 committed the receipt and scalar mirror atomically before the throw.
const lostResponseDatabase = await createVerifierDatabase({
    throwAfterFinalCommit: true
});
const lostResponseFetch = createMediaFetch({ database: lostResponseDatabase });
const lostResponseResult = await verifyPublicHostAbsence(
    validEnvironment(lostResponseDatabase),
    serviceIdentity(),
    draftId,
    validInput,
    fixedNow,
    { fetch: lostResponseFetch }
);
assert.equal(lostResponseResult.status, 200);
assert.equal(lostResponseResult.replayed, true);
assert.equal(lostResponseDatabase.receipts.size, 1);

// A live target is a conflict, while redirects, generic 404s, wrong contract
// headers, witness failures, and network errors are not accepted as absence.
for (const testCase of [
    { label: 'live target', mode: 'live-target', status: 409, code: 'public-host-object-present' },
    { label: 'redirect', mode: 'redirect-target', status: 503, code: 'public-host-unverifiable' },
    { label: 'generic 404', mode: 'generic-404', status: 503, code: 'public-host-unverifiable' },
    { label: 'wrong contract', mode: 'wrong-contract', status: 503, code: 'public-host-unverifiable' },
    { label: 'wrong witness bytes', mode: 'wrong-witness', status: 503, code: 'public-host-unverifiable' },
    { label: 'network error', mode: 'network-error', status: 503, code: 'public-host-unverifiable' },
    { label: 'final reappearance', mode: 'final-reappearance', status: 409, code: 'public-host-object-present' }
]) {
    const database = await createVerifierDatabase();
    const fetcher = createMediaFetch({ mode: testCase.mode, database });
    const result = await verifyPublicHostAbsence(
        validEnvironment(database),
        serviceIdentity(),
        draftId,
        validInput,
        fixedNow,
        { fetch: fetcher }
    );
    assert.equal(result.status, testCase.status, testCase.label);
    assert.equal(result.code, testCase.code, testCase.label);
    assert.equal(database.receipts.size, 0, `${testCase.label} wrote receipt.`);
    assert.equal(database.evidence.hostDeletionConfirmed, 0, `${testCase.label} set scalar.`);
}

const stalledBodyDatabase = await createVerifierDatabase();
const stalledBodyFetch = createMediaFetch({
    mode: 'stalled-witness-body',
    database: stalledBodyDatabase
});
const stalledStartedAt = Date.now();
const stalledBodyResult = await verifyPublicHostAbsence(
    validEnvironment(stalledBodyDatabase),
    serviceIdentity(),
    draftId,
    validInput,
    fixedNow,
    { fetch: stalledBodyFetch, fetchTimeoutMilliseconds: 20 }
);
assert.equal(stalledBodyResult.status, 503);
assert.equal(stalledBodyResult.code, 'public-host-unverifiable');
assert.ok(Date.now() - stalledStartedAt < 1_000);
assert.equal(stalledBodyDatabase.receipts.size, 0);

// D1 drift after the network sequence prevents the receipt even though every
// response was otherwise a valid fixed-origin absence response.
const driftDatabase = await createVerifierDatabase();
const driftFetch = createMediaFetch({
    database: driftDatabase,
    onCall(callCount) {
        if (callCount === 6) driftDatabase.evidence.stateVersion += 1;
    }
});
const driftResult = await verifyPublicHostAbsence(
    validEnvironment(driftDatabase),
    serviceIdentity(),
    draftId,
    validInput,
    fixedNow,
    { fetch: driftFetch }
);
assert.deepEqual(driftResult, {
    ok: false,
    status: 409,
    code: 'state-or-generation-drift'
});
assert.equal(driftDatabase.receipts.size, 0);

// A globally reserved content-addressed key cannot be verified by another
// operation and the conflict is detected before any public fetch.
const reservationDatabase = await createVerifierDatabase();
const firstTarget = reservationDatabase.targets[0];
reservationDatabase.reservations.set(firstTarget.approvedObjectKeyHash, {
    approvedObjectKeyHash: firstTarget.approvedObjectKeyHash,
    verificationIdHash: 'f'.repeat(64),
    promotionIdHash: firstTarget.promotionIdHash,
    draftIdHash: 'e'.repeat(64),
    withdrawalCycleHash: 'd'.repeat(64),
    reservationIdempotencyKeyHash: 'c'.repeat(64),
    reservedByIdentityHash: 'b'.repeat(64),
    reservedAt: '2026-08-30T16:45:00.000Z'
});
const reservationFetch = createMediaFetch({ database: reservationDatabase });
const reservationResult = await verifyPublicHostAbsence(
    validEnvironment(reservationDatabase),
    serviceIdentity(),
    draftId,
    validInput,
    fixedNow,
    { fetch: reservationFetch }
);
assert.equal(reservationResult.status, 409);
assert.equal(reservationResult.code, 'state-or-generation-drift');
assert.equal(reservationFetch.calls.length, 0);

// A never-published withdrawal has no historical target generation. It still
// proves the fixed delivery binding with two witness passes and writes an empty
// generation-bound receipt; it never invents a target URL.
const zeroGenerationDatabase = await createVerifierDatabase({ noGenerations: true });
const zeroGenerationFetch = createMediaFetch({ database: zeroGenerationDatabase });
const zeroGenerationResult = await verifyPublicHostAbsence(
    validEnvironment(zeroGenerationDatabase),
    serviceIdentity(),
    draftId,
    validInput,
    fixedNow,
    { fetch: zeroGenerationFetch }
);
assert.equal(zeroGenerationResult.status, 201);
assert.deepEqual(
    zeroGenerationFetch.calls.map(call => `${call.kind}:${call.method}`),
    ['witness:HEAD', 'witness:GET', 'witness:HEAD', 'witness:GET']
);
assert.equal(zeroGenerationDatabase.reservations.size, 0);

const withdrawnRefreshDatabase = await createVerifierDatabase();
const withdrawnRefreshInput = {
    expectedStateVersion: 24,
    idempotencyKey: 'public-host-verifier-epoch-refresh'
};
withdrawnRefreshDatabase.evidence.state = 'withdrawn';
withdrawnRefreshDatabase.evidence.stateVersion = 24;
withdrawnRefreshDatabase.evidence.priorWithdrawalCycleHash = '9'.repeat(64);
const withdrawnRefreshResult = await verifyPublicHostAbsence(
    validEnvironment(withdrawnRefreshDatabase),
    serviceIdentity(),
    draftId,
    withdrawnRefreshInput,
    fixedNow,
    { fetch: createMediaFetch({ database: withdrawnRefreshDatabase }) }
);
assert.equal(withdrawnRefreshResult.status, 201);
assert.equal(
    [...withdrawnRefreshDatabase.verifications.values()][0].withdrawalCycleHash,
    '9'.repeat(64)
);

// Exact body shape is rejected by the service before D1 or public fetch, even
// if the Worker parser successfully produced JSON.
for (const invalidInput of [
    { ...validInput, targetUrl: `${mediaOrigin}/caller-selected` },
    { ...validInput, approvedObjectKey: 'caller-selected' },
    { ...validInput, role: 'photo-display' },
    { ...validInput, generationId: 'caller-selected' },
    { ...validInput, mediaOrigin },
    { expectedStateVersion: 23 },
    { ...validInput, expectedStateVersion: -1 }
]) {
    const database = createNoCallDatabase();
    const fetcher = createMediaFetch();
    const result = await verifyPublicHostAbsence(
        validEnvironment(database),
        serviceIdentity(),
        draftId,
        invalidInput,
        fixedNow,
        { fetch: fetcher }
    );
    assert.equal(result.status, 400);
    assert.equal(database.calls.length, 0);
    assert.equal(fetcher.calls.length, 0);
}

for (const [name, sql] of Object.entries(PUBLIC_HOST_VERIFIER_SQL)) {
    assert.equal(typeof sql, 'string', name);
    assert.match(sql, /public-host-verifier:/, name);
    assert.equal(
        /DERIVATIVE_STAGING|PRIVATE_ORIGINALS|GITHUB_TOKEN/i.test(sql),
        false,
        name
    );
}
assert.match(PUBLIC_HOST_VERIFIER_SQL.readGenerations, /draft_photo_public_generations/);
assert.match(PUBLIC_HOST_VERIFIER_SQL.readTargets, /draft_photo_public_generation_targets/);
assert.match(PUBLIC_HOST_VERIFIER_SQL.insertReceipt, /gallery_public_host_absence_receipts/);
assert.match(
    PUBLIC_HOST_VERIFIER_SQL.reserveKey,
    /gallery_approved_media_key_retirement_reservations/
);
assert.match(
    PUBLIC_HOST_VERIFIER_SQL.readCurrentReceipt,
    /gallery_current_public_host_absence_receipts/
);

console.log('Gallery public-host verifier tests passed.');

function validEnvironment(database) {
    return {
        APPROVED_MEDIA_ORIGIN: mediaOrigin,
        DB: database,
        EXPECTED_MEDIA_VERSION: versionId,
        MEDIA_CONTRACT: MEDIA_DELIVERY_CONTRACT_VALUE,
        MEDIA_WITNESS_BYTE_COUNT: String(MEDIA_BINDING_WITNESS_SIZE),
        MEDIA_WITNESS_CONTENT_TYPE: MEDIA_BINDING_WITNESS_CONTENT_TYPE,
        MEDIA_WITNESS_KEY: MEDIA_BINDING_WITNESS_KEY,
        MEDIA_WITNESS_SHA256: MEDIA_BINDING_WITNESS_SHA256,
        PUBLIC_HOST_VERIFIER_IDENTITY: `subject:${verifierSubject}`,
        PUBLIC_HOST_VERIFIER_ORIGIN: verifierOrigin
    };
}

function serviceIdentity() {
    return { type: 'service', subject: verifierSubject };
}

function accessContext() {
    return {
        access: {
            async getIdentity() {
                return {
                    service_token_status: true,
                    service_token_id: verifierSubject
                };
            }
        }
    };
}

async function boundaryRequest(
    options = {},
    environment = boundaryEnvironment,
    dependencies = validDependencies
) {
    const body = options.body === undefined && options.method !== 'GET'
        ? JSON.stringify(validInput)
        : options.body;
    const headers = new Headers(options.headers || {});
    if (body !== undefined) {
        headers.set('Content-Type', options.contentType || 'application/json');
        headers.set(
            'Content-Length',
            String(options.declaredLength ?? new TextEncoder().encode(body).byteLength)
        );
    }
    return handlePublicHostVerifierRequest(new Request(
        options.url || `${verifierOrigin}${route}`,
        {
            method: options.method || 'POST',
            headers,
            body
        }
    ), environment, dependencies);
}

function createNoCallDatabase() {
    const calls = [];
    return {
        calls,
        prepare(sql) {
            calls.push({ operation: 'prepare', sql });
            throw new Error('D1 must not be reached.');
        },
        async batch() {
            calls.push({ operation: 'batch' });
            throw new Error('D1 must not be reached.');
        }
    };
}

async function createVerifierDatabase(options = {}) {
    const displaySha = 'a'.repeat(64);
    const thumbnailSha = 'b'.repeat(64);
    const approvedOriginHash = sha256(`approved-media-origin:${mediaOrigin}`);
    const generationId = `promotion_${'1'.repeat(32)}`;
    const promotionIdHash = 'c'.repeat(64);
    const targets = options.noGenerations ? [] : [
        targetRow(generationId, promotionIdHash, 'photo-display',
            `media/v1/${displaySha}/display.webp`, displaySha),
        targetRow(generationId, promotionIdHash, 'photo-thumbnail',
            `media/v1/${thumbnailSha}/thumbnail.webp`, thumbnailSha)
    ];
    const generationTargetSetHash = hashSetSync(
        targets.map(targetRecordForTest)
    );
    for (const target of targets) {
        target.generationTargetSetHash = generationTargetSetHash;
    }
    const generations = options.noGenerations ? [] : [{
        generationId,
        promotionIdHash,
        approvedOrigin: mediaOrigin,
        approvedOriginHash,
        candidateStateVersion: 22,
        generationFingerprint: 'd'.repeat(64),
        targetSetHash: generationTargetSetHash,
        createdAt: '2026-08-30T16:00:00.000Z'
    }];
    const database = {
        epoch: {
            epochIdHash: sha256('media-delivery-epoch:synthetic-v1'),
            epochSequence: 1,
            approvedOrigin: mediaOrigin,
            approvedOriginHash,
            deliveryContractHash: sha256(
                `approved-media-contract:${MEDIA_DELIVERY_CONTRACT_VALUE}`
            ),
            deliveryVersionHash: sha256(
                `approved-media-version:${versionId}`
            ),
            witnessObjectKeyHash: sha256(
                `approved-object-key:${MEDIA_BINDING_WITNESS_KEY}`
            ),
            witnessSha256: MEDIA_BINDING_WITNESS_SHA256,
            witnessByteCount: MEDIA_BINDING_WITNESS_SIZE,
            witnessContentType: MEDIA_BINDING_WITNESS_CONTENT_TYPE,
            activatedAt: '2026-08-30T15:00:00.000Z'
        },
        evidence: {
            draftId,
            state: 'withdrawal-pending',
            stateVersion: validInput.expectedStateVersion,
            withdrawalKind: 'athlete-exclusion',
            hostDeletionConfirmed: 0,
            approvedReferenceCount: 0,
            activePromotionCount: 0,
            incompleteCleanupCount: 0
        },
        cleanupEvidence: options.noGenerations ? [] : [{
            promotionIdHash,
            cleanupEvidenceHash: 'f'.repeat(64),
            completedAt: '2026-08-30T16:30:00.000Z'
        }],
        generations,
        targets,
        verifications: new Map(),
        receipts: new Map(),
        reservations: new Map(),
        targetProofs: [],
        witnessProofs: [],
        events: [],
        throwAfterFinalCommit: options.throwAfterFinalCommit === true,
        prepare(sql) {
            return statement(database, sql);
        },
        async batch(statements) {
            return runMockBatch(database, statements);
        }
    };
    return database;
}

function targetRow(
    generationId,
    promotionIdHash,
    role,
    approvedObjectKey,
    sha256Value
) {
    return {
        generationId,
        promotionIdHash,
        role,
        approvedObjectKey,
        approvedObjectKeyHash: sha256(`approved-object-key:${approvedObjectKey}`),
        publicUrlHash: sha256(
            `public-media-url:${mediaOrigin}/${approvedObjectKey}`
        ),
        expectedSha256: sha256Value,
        createdAt: '2026-08-30T16:00:00.000Z'
    };
}

function targetRecordForTest(target) {
    return `target:${target.promotionIdHash}:${target.role}:` +
        `${target.approvedObjectKeyHash}:${target.publicUrlHash}:` +
        `${target.expectedSha256}`;
}

function statement(database, sql) {
    const tag = sqlTag(sql);
    return {
        sql,
        tag,
        bindings: [],
        bind(...bindings) {
            this.bindings = bindings;
            return this;
        },
        async first() {
            database.events.push(`read:${tag.replace('read-', '')}`);
            switch (tag) {
            case 'read-current-epoch':
                return { ...database.epoch };
            case 'read-current-receipt': {
                const verification = [...database.verifications.values()].find(row =>
                    row.draftId === this.bindings[0] &&
                    row.idempotencyKey === this.bindings[1]
                );
                const receipt = verification &&
                    database.receipts.get(verification.verificationIdHash);
                return receipt && database.evidence.hostDeletionConfirmed === 1
                    ? { ...verification, ...receipt }
                    : null;
            }
            case 'read-verification':
                return [...database.verifications.values()].find(row =>
                    row.draftId === this.bindings[0] &&
                    row.idempotencyKey === this.bindings[1]
                ) || null;
            case 'read-evidence':
                return database.evidence?.draftId === this.bindings[0]
                    ? { ...database.evidence }
                    : null;
            case 'read-reservation':
                return database.reservations.get(this.bindings[0]) || null;
            default:
                throw new Error(`Unexpected first() SQL tag: ${tag}`);
            }
        },
        async all() {
            database.events.push(`read:${tag.replace('read-', '')}`);
            switch (tag) {
            case 'read-cleanup-evidence':
                return { results: database.cleanupEvidence.map(row => ({ ...row })) };
            case 'read-generations':
                return { results: database.generations.map(row => ({ ...row })) };
            case 'read-targets':
                return { results: database.targets.map(row => ({ ...row })) };
            default:
                throw new Error(`Unexpected all() SQL tag: ${tag}`);
            }
        }
    };
}

async function runMockBatch(database, statements) {
    const tags = statements.map(item => item.tag);
    for (const tag of tags) database.events.push(`batch:${tag}`);
    const reservations = new Map(
        [...database.reservations].map(([key, value]) => [key, { ...value }])
    );
    const receipts = new Map(
        [...database.receipts].map(([key, value]) => [key, { ...value }])
    );
    const verifications = new Map(
        [...database.verifications].map(([key, value]) => [key, { ...value }])
    );
    const targetProofs = database.targetProofs.map(row => ({ ...row }));
    const witnessProofs = database.witnessProofs.map(row => ({ ...row }));
    const evidence = { ...database.evidence };

    for (const item of statements) {
        const values = item.bindings;
        switch (item.tag) {
        case 'insert-verification': {
            const row = verificationRow(values);
            if ([...verifications.values()].some(existing =>
                existing.idempotencyKeyHash === row.idempotencyKeyHash ||
                (existing.draftId === row.draftId &&
                    existing.idempotencyKey === row.idempotencyKey)
            )) throw new Error('Synthetic verification collision.');
            verifications.set(row.verificationIdHash, row);
            break;
        }
        case 'reserve-key': {
            if (reservations.has(values[0])) {
                throw new Error('Synthetic reservation collision.');
            }
            reservations.set(values[0], {
                approvedObjectKeyHash: values[0],
                verificationIdHash: values[1],
                promotionIdHash: values[2],
                draftIdHash: values[3],
                withdrawalCycleHash: values[4],
                reservationIdempotencyKeyHash: values[5],
                reservedByIdentityHash: values[6],
                reservedAt: values[7]
            });
            break;
        }
        case 'insert-target-proof':
            targetProofs.push({ values: [...values], verifiedAt: values[10] });
            break;
        case 'insert-witness-proof':
            witnessProofs.push({ values: [...values], verifiedAt: values[11] });
            break;
        case 'insert-receipt': {
            const row = receiptRow(values);
            if (receipts.has(row.verificationIdHash)) {
                throw new Error('Synthetic receipt collision.');
            }
            receipts.set(row.verificationIdHash, row);
            break;
        }
        case 'confirm-host-deletion':
            if (
                evidence.draftId !== values[0] ||
                !['withdrawal-pending', 'withdrawn'].includes(evidence.state) ||
                evidence.stateVersion !== values[1] ||
                evidence.hostDeletionConfirmed !== 0
            ) throw new Error('Synthetic scalar confirmation mismatch.');
            evidence.hostDeletionConfirmed = 1;
            break;
        default:
            throw new Error(`Unexpected batch SQL tag: ${item.tag}`);
        }
    }

    database.reservations = reservations;
    database.receipts = receipts;
    database.verifications = verifications;
    database.targetProofs = targetProofs;
    database.witnessProofs = witnessProofs;
    database.evidence = evidence;
    const finalBatch = tags.includes('insert-receipt');
    if (finalBatch && database.throwAfterFinalCommit) {
        database.throwAfterFinalCommit = false;
        throw new Error('Synthetic lost D1 response after commit.');
    }
    return statements.map(() => ({ success: true }));
}

function verificationRow(values) {
    const names = [
        'verificationId', 'verificationIdHash', 'draftId', 'draftIdHash',
        'expectedStateVersion', 'withdrawalKind', 'withdrawalCycleHash',
        'promotionSetHash', 'cleanupEvidenceSetHash', 'approvedOriginHash',
        'targetSetHash', 'generationCount', 'generationTargetRowCount',
        'targetCount', 'mediaDeliveryEpochIdHash', 'deliveryContractHash',
        'deliveryVersionHash', 'idempotencyKey', 'idempotencyKeyHash',
        'payloadFingerprint', 'serviceActorIdentityHash', 'createdAt'
    ];
    return Object.fromEntries(names.map((name, index) => [name, values[index]]));
}

function receiptRow(values) {
    const names = [
        'finalReceiptHash',
        'verificationIdHash',
        'draftIdHash',
        'promotionSetHash',
        'cleanupEvidenceSetHash',
        'withdrawalCycleHash',
        'approvedOriginHash',
        'targetSetHash',
        'generationCount',
        'targetCount',
        'verifiedStateVersion',
        'mediaDeliveryEpochIdHash',
        'deliveryContractHash',
        'deliveryVersionHash',
        'idempotencyKeyHash',
        'payloadFingerprint',
        'verifiedAt'
    ];
    return Object.fromEntries(names.map((name, index) => [name, values[index]]));
}

function createMediaFetch(options = {}) {
    const calls = [];
    const fetcher = async request => {
        const url = new URL(request.url);
        const kind = url.pathname === `/${MEDIA_BINDING_WITNESS_KEY}`
            ? 'witness'
            : 'target';
        const call = {
            kind,
            method: request.method,
            url: request.url,
            redirect: request.redirect,
            cache: request.cache,
            credentials: request.credentials,
            authorization: request.headers.get('Authorization'),
            cookie: request.headers.get('Cookie'),
            accessAssertion: request.headers.get('Cf-Access-Jwt-Assertion'),
            cacheControl: request.headers.get('Cache-Control'),
            pragma: request.headers.get('Pragma')
        };
        calls.push(call);
        options.database?.events.push(`fetch:${kind}:${request.method}`);
        options.onCall?.(calls.length, call);

        if (options.mode === 'network-error') {
            throw new Error('Synthetic public network error.');
        }
        if (kind === 'witness') {
            if (options.mode === 'stalled-witness-body' && request.method === 'GET') {
                return proofResponse(request.url, {
                    status: 200,
                    method: request.method,
                    body: new ReadableStream({ start() {} }),
                    headers: {
                        'Content-Type': MEDIA_BINDING_WITNESS_CONTENT_TYPE,
                        'Content-Length': String(MEDIA_BINDING_WITNESS_SIZE)
                    }
                });
            }
            const body = options.mode === 'wrong-witness'
                ? new Uint8Array(MEDIA_BINDING_WITNESS_SIZE)
                : witnessBody;
            return proofResponse(request.url, {
                status: 200,
                method: request.method,
                body,
                headers: {
                    'Content-Type': MEDIA_BINDING_WITNESS_CONTENT_TYPE,
                    'Content-Length': String(MEDIA_BINDING_WITNESS_SIZE)
                }
            });
        }

        const targetCallCount = calls.filter(item => item.kind === 'target').length;
        if (options.mode === 'live-target' && targetCallCount === 1) {
            return proofResponse(request.url, {
                status: 200,
                method: request.method,
                body: new Uint8Array([1]),
                headers: { 'Content-Type': 'image/webp', 'Content-Length': '1' }
            });
        }
        if (options.mode === 'final-reappearance' && targetCallCount === 5) {
            return proofResponse(request.url, {
                status: 200,
                method: request.method,
                body: new Uint8Array([1]),
                headers: { 'Content-Type': 'image/webp', 'Content-Length': '1' }
            });
        }
        if (options.mode === 'redirect-target') {
            return responseWithUrl(null, {
                status: 302,
                headers: {
                    Location: `${mediaOrigin}/redirected`,
                    'Cache-Control': 'no-store'
                }
            }, request.url);
        }
        if (options.mode === 'generic-404') {
            return responseWithUrl(null, {
                status: 404,
                headers: { 'Cache-Control': 'no-store' }
            }, request.url);
        }
        const extraHeaders = options.mode === 'wrong-contract'
            ? { [MEDIA_DELIVERY_CONTRACT_HEADER]: 'wrong-media-v1' }
            : {};
        return proofResponse(request.url, {
            status: 404,
            method: request.method,
            body: new Uint8Array(0),
            headers: extraHeaders
        });
    };
    fetcher.calls = calls;
    return fetcher;
}

function proofResponse(url, { status, method, body, headers = {} }) {
    const responseHeaders = new Headers({
        'Cache-Control': 'no-store',
        [MEDIA_DELIVERY_CONTRACT_HEADER]: MEDIA_DELIVERY_CONTRACT_VALUE,
        [MEDIA_DELIVERY_VERSION_HEADER]: versionId,
        ...headers
    });
    return responseWithUrl(
        method === 'HEAD' ? null : body,
        { status, headers: responseHeaders },
        url
    );
}

function responseWithUrl(body, init, url) {
    const response = new Response(body, init);
    Object.defineProperty(response, 'url', { value: url });
    Object.defineProperty(response, 'redirected', { value: false });
    return response;
}

function sqlTag(sql) {
    const match = /public-host-verifier:([a-z-]+)/.exec(sql);
    if (!match) throw new Error('SQL lacks verifier tag.');
    return match[1];
}

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function hashSetSync(records) {
    return sha256([...records].sort().join('\n'));
}

async function assertWranglerDryRun(configPath) {
    const temporaryRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), 'gallery-public-host-verifier-')
    );
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
        assert.match(bundle, /public-host-absence-verifications/);
        assert.match(bundle, /global_fetch_strictly_public|redirect:\s*["']manual["']/);
        assert.doesNotMatch(
            bundle,
            /PRIVATE_ORIGINALS|DERIVATIVE_STAGING|GITHUB_TOKEN|GITHUB_REPOSITORY/
        );
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
