import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import processingWorker, {
    handleProcessingRequest,
    PROCESSING_REHEARSAL_HEADER
} from '../gallery-admin/src/processing-worker.js';
import processingRehearsalWorker from
    '../gallery-admin/src/processing-rehearsal-worker.js';
import {
    createProcessingRehearsalFault,
    prepareProcessingRehearsalRequest,
    PROCESSING_REHEARSAL_FIXTURE,
    PROCESSING_REHEARSAL_MODES,
    PROCESSING_REHEARSAL_PUBLIC_ITEM_ID
} from '../gallery-admin/src/processing-rehearsal-faults.js';
import { publishedSiteEntries } from '../scripts/published-site-entries.mjs';
import catalogSnapshot from '../gallery-admin/generated/catalog-snapshot.js';

const processingOrigin = 'https://synthetic-processing-rehearsal.example';
const serviceClientId = `${'a'.repeat(32)}.access`;
const processorIdentity = `subject:${serviceClientId}`;
const runId = `run_${'1'.repeat(12)}4${'2'.repeat(3)}8${'3'.repeat(15)}`;
const draftId = 'draft_11111111-1111-4111-8111-111111111111';
const derivativePath =
    `/api/service/processing-runs/${runId}/derivatives/photo-display`;
const cleanupPath = `/api/service/processing-runs/${runId}/cleanup`;
const syntheticEvidence = Object.freeze({
    syntheticOnlyConfirmed: 1,
    ...PROCESSING_REHEARSAL_FIXTURE,
    draftMediaType: 'photo',
    runMediaType: 'photo'
});

assert.deepEqual(PROCESSING_REHEARSAL_MODES, [
    'after-upload-part',
    'after-complete',
    'after-abort',
    'after-delete'
]);

// The ordinary deployed entrypoint never accepts the rehearsal capability.
const productionBoundary = createBoundary();
const productionHeaderResponse = await processingWorker.fetch(
    derivativeRequest('after-upload-part'),
    productionBoundary.env,
    accessContext()
);
assert.equal(productionHeaderResponse.status, 403);
assert.deepEqual(await productionHeaderResponse.json(), { error: 'forbidden' });
assert.equal(productionBoundary.database.calls.length, 0);
assert.equal(productionBoundary.bucket.calls.length, 0);

const directProductionResponse = await handleProcessingRequest(
    derivativeRequest('after-complete'),
    productionBoundary.env,
    {
        verifyAccessIdentity: async () => ({
            type: 'service',
            subject: serviceClientId
        })
    }
);
assert.equal(directProductionResponse.status, 403);

// Without the special header, the rehearsal entrypoint is the ordinary Worker.
const noFaultBoundary = createBoundary();
const noFaultResponse = await processingRehearsalWorker.fetch(
    new Request(
        `${processingOrigin}/api/service/drafts/${draftId}/processing-runs`,
        { method: 'GET' }
    ),
    noFaultBoundary.env,
    accessContext()
);
assert.equal(noFaultResponse.status, 405);
assert.equal(noFaultResponse.headers.get('Allow'), 'POST');
assert.equal(noFaultBoundary.database.calls.length, 0);

const wrongIdentityBoundary = createBoundary({ evidence: syntheticEvidence });
const wrongIdentityResponse = await processingRehearsalWorker.fetch(
    derivativeRequest('after-upload-part'),
    wrongIdentityBoundary.env,
    {
        access: {
            async getIdentity() {
                return {
                    service_token_status: true,
                    service_token_id: `${'b'.repeat(32)}.access`
                };
            }
        }
    }
);
assert.equal(wrongIdentityResponse.status, 403);
assert.equal(wrongIdentityBoundary.database.calls.length, 0);
assert.equal(wrongIdentityBoundary.bucket.calls.length, 0);

const wrongOriginBoundary = createBoundary({ evidence: syntheticEvidence });
const wrongOriginRequest = derivativeRequest('after-upload-part');
const wrongOriginResponse = await processingRehearsalWorker.fetch(
    new Request(wrongOriginRequest.url.replace(
        processingOrigin,
        'https://wrong-processing-origin.example'
    ), wrongOriginRequest),
    wrongOriginBoundary.env,
    accessContext()
);
assert.equal(wrongOriginResponse.status, 403);
assert.equal(wrongOriginBoundary.database.calls.length, 0);
assert.equal(wrongOriginBoundary.bucket.calls.length, 0);

// The injected preparation step admits only a server-parsed run, a fixed mode,
// and current D1 evidence for both the synthetic upload and synthetic item.
const preparationBoundary = createBoundary({ evidence: syntheticEvidence });
const originalRequest = derivativeRequest('after-complete', {
    'X-Rehearsal-Unrelated-Probe': 'preserved'
});
const prepared = await prepareProcessingRehearsalRequest({
    env: preparationBoundary.env,
    request: originalRequest,
    route: {
        kind: 'derivative',
        processingRunId: runId,
        role: 'photo-display'
    }
});
assert.equal(prepared.ok, true);
assert.equal(prepared.request.headers.has(PROCESSING_REHEARSAL_HEADER), false);
assert.equal(
    prepared.request.headers.get('X-Rehearsal-Unrelated-Probe'),
    'preserved'
);
assert.equal(originalRequest.headers.get(PROCESSING_REHEARSAL_HEADER), 'after-complete');
assert.deepEqual(Object.keys(prepared.env).sort(), [
    'DB',
    'DERIVATIVE_STAGING',
    'PRIVATE_ORIGINALS',
    'PROCESSING_ORIGIN',
    'PROCESSOR_IDENTITIES'
]);
assert.equal(prepared.env.DB, preparationBoundary.env.DB);
assert.equal(prepared.env.PRIVATE_ORIGINALS, preparationBoundary.env.PRIVATE_ORIGINALS);
assert.notEqual(
    prepared.env.DERIVATIVE_STAGING,
    preparationBoundary.env.DERIVATIVE_STAGING
);
assert.equal(prepared.env.PROCESSOR_IDENTITIES, processorIdentity);
assert.equal(prepared.env.PROCESSING_ORIGIN, processingOrigin);
assert.equal(prepared.env.APPROVED_MEDIA, undefined);
assert.equal(prepared.env.PUBLIC_MANIFESTS, undefined);
assert.equal(prepared.env.GITHUB_TOKEN, undefined);
assert.equal(preparationBoundary.database.calls.length, 1);
assert.deepEqual(preparationBoundary.database.calls[0].bindings, [runId]);
assert.match(
    preparationBoundary.database.calls[0].sql,
    /upload\.synthetic_only_confirmed AS syntheticOnlyConfirmed/
);
assert.match(
    preparationBoundary.database.calls[0].sql,
    /draft\.public_item_id AS publicItemId/
);
assert.match(
    preparationBoundary.database.calls[0].sql,
    /draft\.site_modes_json AS siteModesJson/
);
assert.match(preparationBoundary.database.calls[0].sql, /draft\.race_date AS raceDate/);
assert.match(preparationBoundary.database.calls[0].sql, /draft\.race_event AS raceEvent/);
assert.match(
    preparationBoundary.database.calls[0].sql,
    /draft\.race_distance AS raceDistance/
);
assert.match(
    preparationBoundary.database.calls[0].sql,
    /draft\.athlete_ids_json AS athleteIdsJson/
);
assert.match(
    preparationBoundary.database.calls[0].sql,
    /draft\.original_sha256 AS originalSha256/
);
assert.equal(
    preparationBoundary.database.calls[0].sql.includes(
        PROCESSING_REHEARSAL_PUBLIC_ITEM_ID
    ),
    false
);

for (const invalidMode of [
    '',
    'after-put',
    'after-delete,after-complete',
    'AFTER-COMPLETE'
]) {
    const boundary = createBoundary({ evidence: syntheticEvidence });
    const result = await prepareProcessingRehearsalRequest({
        env: boundary.env,
        request: derivativeRequest(invalidMode),
        route: { kind: 'derivative', processingRunId: runId }
    });
    assert.deepEqual(result, { ok: false, status: 403 });
    assert.equal(boundary.database.calls.length, 0);
}

const wrongRouteBoundary = createBoundary({ evidence: syntheticEvidence });
assert.deepEqual(await prepareProcessingRehearsalRequest({
    env: wrongRouteBoundary.env,
    request: cleanupRequest('after-delete'),
    route: { kind: 'derivative', processingRunId: runId, role: 'photo-display' }
}), { ok: false, status: 403 });
assert.equal(wrongRouteBoundary.database.calls.length, 0);

const thumbnailFaultBoundary = createBoundary({ evidence: syntheticEvidence });
const thumbnailFaultRequest = new Request(
    derivativeRequest('after-upload-part').url.replace(
        '/photo-display',
        '/photo-thumbnail'
    ),
    derivativeRequest('after-upload-part')
);
assert.deepEqual(await prepareProcessingRehearsalRequest({
    env: thumbnailFaultBoundary.env,
    request: thumbnailFaultRequest,
    route: {
        kind: 'derivative',
        processingRunId: runId,
        role: 'photo-thumbnail'
    }
}), { ok: false, status: 403 });
assert.equal(thumbnailFaultBoundary.database.calls.length, 0);

for (const evidence of [
    { ...syntheticEvidence, syntheticOnlyConfirmed: 0 },
    { ...syntheticEvidence, publicItemId: 'family-real-photo' },
    { ...syntheticEvidence, publicItemId: 'synthetic-phase-d-other-rehearsal' },
    { ...syntheticEvidence, publicItemId: 'synthetic-../private-object' },
    { ...syntheticEvidence, siteModesJson: '["everyone"]' },
    { ...syntheticEvidence, siteModesJson: '["family","everyone"]' },
    { ...syntheticEvidence, raceDate: '2026-08-23' },
    { ...syntheticEvidence, raceEvent: 'Different synthetic event' },
    { ...syntheticEvidence, raceDistance: '10 km' },
    { ...syntheticEvidence, athleteIdsJson: '["another-athlete"]' },
    { ...syntheticEvidence, athleteIdsJson: '["john-kevan","another-athlete"]' },
    { ...syntheticEvidence, originalSha256: '0'.repeat(64) },
    { ...syntheticEvidence, draftMediaType: 'video' },
    { ...syntheticEvidence, runMediaType: 'video' },
    null
]) {
    const boundary = createBoundary({ evidence });
    const result = await prepareProcessingRehearsalRequest({
        env: boundary.env,
        request: derivativeRequest('after-upload-part'),
        route: { kind: 'derivative', processingRunId: runId, role: 'photo-display' }
    });
    assert.deepEqual(result, { ok: false, status: 403 });
    assert.equal(boundary.bucket.calls.length, 0);
}

const failedD1Boundary = createBoundary({ databaseFailure: true });
assert.deepEqual(await prepareProcessingRehearsalRequest({
    env: failedD1Boundary.env,
    request: cleanupRequest('after-abort'),
    route: { kind: 'cleanup', processingRunId: runId }
}), { ok: false, status: 503 });
assert.equal(failedD1Boundary.bucket.calls.length, 0);

const extraBindingBoundary = createBoundary({ evidence: syntheticEvidence });
const extraBindingResponse = await processingRehearsalWorker.fetch(
    derivativeRequest('after-complete'),
    { ...extraBindingBoundary.env, APPROVED_MEDIA: {} },
    accessContext()
);
assert.equal(extraBindingResponse.status, 503);
assert.equal(extraBindingBoundary.database.calls.length, 0);

// A valid rehearsal request passes the real authentication/origin/route gate,
// performs the synthetic D1 proof, then enters the unchanged processing service.
// This fake intentionally has no run row for that second service query.
const integratedBoundary = createBoundary({ evidence: syntheticEvidence });
const integratedResponse = await processingRehearsalWorker.fetch(
    derivativeRequest('after-upload-part'),
    integratedBoundary.env,
    accessContext()
);
assert.equal(integratedResponse.status, 409);
assert.deepEqual(await integratedResponse.json(), {
    error: 'processing-not-eligible'
});
assert.equal(integratedBoundary.database.calls.length, 2);
assert.equal(integratedBoundary.bucket.calls.length, 0);

// The complete-response rehearsal goes through the real processing service.
// The provider commits the object, but the tagged response loss interrupts the
// service's same-request adoption path. D1 therefore remains part-uploaded and
// cleanup can exercise its real NoSuchUpload -> head -> delete complete-wins path.
const completeLoss = createCompleteLossIntegrationBoundary();
const completeLossResponse = await processingRehearsalWorker.fetch(
    derivativeRequestWithBytes('after-complete', completeLoss.webpBytes),
    completeLoss.env,
    accessContext()
);
assert.equal(
    completeLossResponse.status,
    503,
    JSON.stringify(completeLoss.model.calls, null, 2)
);
assert.deepEqual(await completeLossResponse.json(), {
    error: 'service-unavailable'
});
assert.equal(completeLoss.model.output.status, 'reserved');
assert.equal(completeLoss.model.multipart.status, 'part-uploaded');
assert.equal(completeLoss.model.multipart.providerPartEtag, 'provider-part-etag');
assert.equal(completeLoss.provider.completeSuccesses, 1);
assert.equal(
    completeLoss.provider.objects.has(completeLoss.model.output.stagingObjectKey),
    true
);

// Every non-target provider method is a transparent call-through with its
// receiver, arguments, return value, and provider-owned IDs unchanged.
const passThroughProvider = createProviderBucket();
const passThroughFault = createProcessingRehearsalFault(
    passThroughProvider.bucket,
    'after-abort'
);
assert.deepEqual(await passThroughFault.bucket.head('key-a'), { key: 'key-a' });
assert.deepEqual(await passThroughFault.bucket.get('key-b', { onlyIf: 'v1' }), {
    key: 'key-b',
    options: { onlyIf: 'v1' }
});
assert.deepEqual(await passThroughFault.bucket.list({ prefix: 'prefix-a/' }), {
    objects: [],
    truncated: false
});
assert.deepEqual(await passThroughFault.bucket.createMultipartUpload(
    'key-c',
    { httpMetadata: { contentType: 'image/webp' } }
), { key: 'key-c', uploadId: 'provider-upload-id', abort: passThroughProvider.createdAbort });
const passThroughMultipart = passThroughFault.bucket.resumeMultipartUpload(
    'key-c',
    'provider-upload-id'
);
assert.equal(passThroughMultipart.key, 'key-c');
assert.equal(passThroughMultipart.uploadId, 'provider-upload-id');
assert.deepEqual(await passThroughMultipart.uploadPart(1, new Uint8Array([1, 2])), {
    partNumber: 1,
    etag: 'provider-part-etag'
});
assert.deepEqual(await passThroughMultipart.complete([
    { partNumber: 1, etag: 'provider-part-etag' }
]), { key: 'key-c', version: 'provider-version' });

// Each allowlisted mode loses exactly one response, and only after the real
// provider side effect has succeeded. A later call through the same wrapper is
// ordinary, which makes the injection one-shot rather than a permanent outage.
for (const mode of PROCESSING_REHEARSAL_MODES) {
    const provider = createProviderBucket();
    const fault = createProcessingRehearsalFault(provider.bucket, mode);
    const multipart = fault.bucket.resumeMultipartUpload(
        'server-derived-key',
        'server-derived-upload-id'
    );
    let caught;
    try {
        await invokeTarget(mode, fault.bucket, multipart);
        assert.fail(`${mode} did not lose its first successful response.`);
    } catch (error) {
        caught = error;
    }
    assert.equal(caught.name, 'ProcessingRehearsalResponseLost');
    assert.equal(provider.successes[targetOperation(mode)], 1);
    assert.equal(provider.sideEffects[targetOperation(mode)], true);
    assert.equal(
        fault.shouldInterruptProviderRecovery(caught, 'complete'),
        mode === 'after-complete'
    );
    assert.equal(
        fault.shouldInterruptProviderRecovery(new Error('unrelated'), 'complete'),
        false
    );
    await invokeTarget(mode, fault.bucket, multipart);
    assert.equal(provider.successes[targetOperation(mode)], 2);
}

// A real provider failure is passed through and does not consume the one-shot
// rehearsal fault. The next successful operation is the one whose response is lost.
const providerFailure = new Error('provider-failed-before-success');
const safeFailureProvider = createProviderBucket({
    failOnce: { operation: 'upload-part', error: providerFailure }
});
const safeFailureFault = createProcessingRehearsalFault(
    safeFailureProvider.bucket,
    'after-upload-part'
);
const safeFailureMultipart = safeFailureFault.bucket.resumeMultipartUpload(
    'server-derived-key',
    'server-derived-upload-id'
);
await assert.rejects(
    safeFailureMultipart.uploadPart(1, new Uint8Array([1])),
    error => error === providerFailure
);
assert.equal(safeFailureProvider.successes['upload-part'], 0);
await assert.rejects(
    safeFailureMultipart.uploadPart(1, new Uint8Array([1])),
    error => error.name === 'ProcessingRehearsalResponseLost'
);
assert.equal(safeFailureProvider.successes['upload-part'], 1);

// The rehearsal implementation is repository-only and cannot enter the static
// GitHub Pages artifact.
assert.equal(
    publishedSiteEntries.some(entry =>
        entry === 'gallery-admin' || entry.startsWith('gallery-admin/')
    ),
    false
);

console.log('Gallery processing remote-rehearsal Worker tests passed.');

function accessContext() {
    return {
        access: {
            async getIdentity() {
                return {
                    service_token_status: true,
                    service_token_id: serviceClientId
                };
            }
        }
    };
}

function derivativeRequest(mode, additionalHeaders = {}) {
    return new Request(`${processingOrigin}${derivativePath}`, {
        method: 'PUT',
        headers: {
            'Content-Length': '1',
            'Content-Type': 'image/webp',
            'Idempotency-Key': 'rehearsal-upload-0001',
            'X-Gallery-Content-SHA256': '1'.repeat(64),
            [PROCESSING_REHEARSAL_HEADER]: mode,
            ...additionalHeaders
        },
        body: new Uint8Array([1])
    });
}

function derivativeRequestWithBytes(mode, bytes) {
    return new Request(`${processingOrigin}${derivativePath}`, {
        method: 'PUT',
        headers: {
            'Content-Length': String(bytes.byteLength),
            'Content-Type': 'image/webp',
            'Idempotency-Key': 'rehearsal-upload-0001',
            'X-Gallery-Content-SHA256': sha256(bytes),
            [PROCESSING_REHEARSAL_HEADER]: mode
        },
        body: bytes
    });
}

function cleanupRequest(mode) {
    const body = JSON.stringify({
        expectedStateVersion: 3,
        idempotencyKey: 'rehearsal-cleanup-0001'
    });
    return new Request(`${processingOrigin}${cleanupPath}`, {
        method: 'POST',
        headers: {
            'Content-Length': String(Buffer.byteLength(body)),
            'Content-Type': 'application/json',
            [PROCESSING_REHEARSAL_HEADER]: mode
        },
        body
    });
}

function createBoundary({ evidence = null, databaseFailure = false } = {}) {
    const database = {
        calls: [],
        prepare(sql) {
            return {
                bind: (...bindings) => ({
                    first: async () => {
                        database.calls.push({ sql, bindings });
                        if (databaseFailure) {
                            throw new Error('private-d1-failure');
                        }
                        return sql.includes(
                            'upload.synthetic_only_confirmed AS syntheticOnlyConfirmed'
                        ) && !sql.includes(
                            'run.processing_run_id AS processingRunId'
                        ) ? evidence : null;
                    },
                    all: async () => {
                        database.calls.push({ sql, bindings });
                        if (databaseFailure) {
                            throw new Error('private-d1-failure');
                        }
                        return { results: [] };
                    },
                    run: async () => {
                        database.calls.push({ sql, bindings });
                        return { success: true, meta: { changes: 0 } };
                    }
                })
            };
        },
        async batch() {
            throw new Error('Unexpected D1 write in rehearsal boundary test.');
        }
    };
    const provider = createProviderBucket();
    return {
        database,
        bucket: provider,
        env: {
            DB: database,
            PRIVATE_ORIGINALS: {
                async head() { return null; },
                async get() { return null; }
            },
            DERIVATIVE_STAGING: provider.bucket,
            PROCESSOR_IDENTITIES: processorIdentity,
            PROCESSING_ORIGIN: processingOrigin
        }
    };
}

function createProviderBucket({ failOnce = null } = {}) {
    const calls = [];
    const successes = {
        'upload-part': 0,
        complete: 0,
        abort: 0,
        delete: 0
    };
    const sideEffects = {
        'upload-part': false,
        complete: false,
        abort: false,
        delete: false
    };

    function maybeFail(operation) {
        if (failOnce?.operation === operation) {
            const error = failOnce.error;
            failOnce = null;
            throw error;
        }
    }

    const multipart = {
        key: 'key-c',
        uploadId: 'provider-upload-id',
        async uploadPart(partNumber, bytes) {
            assert.equal(this, multipart);
            calls.push({ operation: 'upload-part', partNumber, bytes });
            maybeFail('upload-part');
            successes['upload-part'] += 1;
            sideEffects['upload-part'] = true;
            return { partNumber, etag: 'provider-part-etag' };
        },
        async complete(parts) {
            assert.equal(this, multipart);
            calls.push({ operation: 'complete', parts });
            maybeFail('complete');
            successes.complete += 1;
            sideEffects.complete = true;
            return { key: multipart.key, version: 'provider-version' };
        },
        async abort() {
            assert.equal(this, multipart);
            calls.push({ operation: 'abort' });
            maybeFail('abort');
            successes.abort += 1;
            sideEffects.abort = true;
        }
    };
    const createdAbort = async () => undefined;
    const bucket = {
        async head(key) {
            assert.equal(this, bucket);
            calls.push({ operation: 'head', key });
            return { key };
        },
        async get(key, options) {
            assert.equal(this, bucket);
            calls.push({ operation: 'get', key, options });
            return { key, options };
        },
        async delete(key) {
            assert.equal(this, bucket);
            calls.push({ operation: 'delete', key });
            maybeFail('delete');
            successes.delete += 1;
            sideEffects.delete = true;
        },
        async list(options) {
            assert.equal(this, bucket);
            calls.push({ operation: 'list', options });
            return { objects: [], truncated: false };
        },
        async createMultipartUpload(key, options) {
            assert.equal(this, bucket);
            calls.push({ operation: 'create-multipart', key, options });
            return { key, uploadId: 'provider-upload-id', abort: createdAbort };
        },
        resumeMultipartUpload(key, uploadId) {
            assert.equal(this, bucket);
            calls.push({ operation: 'resume-multipart', key, uploadId });
            multipart.key = key;
            multipart.uploadId = uploadId;
            return multipart;
        }
    };
    return { bucket, calls, successes, sideEffects, createdAbort };
}

function createCompleteLossIntegrationBoundary() {
    const webpBytes = syntheticWebp(1, 1);
    const uploadId = `upload_${'4'.repeat(12)}4${'5'.repeat(3)}8${'6'.repeat(15)}`;
    const originalObjectKey =
        `private-originals/phase-c/${draftId}/` +
        '44444444-4444-4444-8444-444444444444.png';
    const race = catalogSnapshot.sites.family.catalog.races[0];
    const itemRevision = 'item_11111111-1111-4111-8111-111111111111';
    const consentRevision = 'consent_11111111-1111-4111-8111-111111111111';
    const originalSha256 = '0'.repeat(64);
    const uploadedAt = '2026-08-28T10:00:00.000Z';
    const runRecord = {
        processingRunId: runId,
        draftId,
        runSiteMode: 'family',
        runMediaType: 'photo',
        runItemRevision: itemRevision,
        runConsentRevision: consentRevision,
        runExportBundleId: catalogSnapshot.exportBundleId,
        runSourceRevision: catalogSnapshot.sourceRevision,
        runSuppressionRevision: catalogSnapshot.suppressionRevision,
        runUploadSessionId: uploadId,
        runOriginalObjectKey: originalObjectKey,
        runOriginalDetectedType: 'png',
        runOriginalDeclaredContentType: 'image/png',
        runOriginalByteCount: 128,
        runOriginalSha256: originalSha256,
        runOriginalObjectVersion: 'private-original-version',
        runOriginalEtag: 'private-original-etag',
        startExpectedStateVersion: 2,
        processingStateVersion: 3,
        startIdempotencyKey: 'rehearsal-start-0001',
        startPayloadFingerprint: '1'.repeat(64),
        runStatus: 'active',
        resultIdempotencyKey: null,
        resultPayloadFingerprint: null,
        resultToolchainJson: null,
        failureCode: null,
        runCreatedAt: uploadedAt,
        runUpdatedAt: uploadedAt,
        runCompletedAt: null,
        publicItemId: syntheticEvidence.publicItemId,
        state: 'processing',
        stateVersion: 3,
        siteModesJson: '["family"]',
        exportBundleId: catalogSnapshot.exportBundleId,
        sourceRevision: catalogSnapshot.sourceRevision,
        suppressionRevision: catalogSnapshot.suppressionRevision,
        itemRevision,
        activeConsentRevision: consentRevision,
        mediaType: 'photo',
        raceDate: race.raceDate,
        raceEvent: race.raceEvent,
        raceDistance: race.raceDistance,
        athleteIdsJson: '[]',
        title: 'Synthetic Phase D remote rehearsal',
        caption: 'Synthetic bytes only.',
        altText: 'Synthetic test pattern with no real people.',
        featured: 0,
        uploadComplete: 1,
        originalObjectKey,
        originalDetectedType: 'png',
        originalByteCount: 128,
        originalSha256,
        consentRevision,
        publicUseConfirmed: 1,
        containsMinors: 0,
        guardianApprovalConfirmed: 0,
        consentWithdrawnAt: null,
        uploadSessionId: uploadId,
        uploadItemRevision: itemRevision,
        uploadConsentRevision: consentRevision,
        uploadExportBundleId: catalogSnapshot.exportBundleId,
        uploadSourceRevision: catalogSnapshot.sourceRevision,
        uploadSuppressionRevision: catalogSnapshot.suppressionRevision,
        uploadObjectKey: originalObjectKey,
        uploadFileExtension: 'png',
        originalDeclaredContentType: 'image/png',
        uploadByteCount: 128,
        uploadDetectedFormat: 'png',
        uploadStatus: 'complete',
        originalObjectVersion: 'private-original-version',
        originalEtag: 'private-original-etag',
        uploadSha256: originalSha256,
        uploadDeclaredSha256: originalSha256,
        realPhotoIntakeConfirmed: 1,
        syntheticOnlyConfirmed: 1,
        uploadedAt,
        existingDerivativeCount: 0
    };
    const model = { output: null, multipart: null, calls: [] };
    const database = createProcessingModelD1(model, runRecord);
    const provider = createCompletingProviderBucket();
    return {
        webpBytes,
        model,
        provider,
        env: {
            DB: database,
            PRIVATE_ORIGINALS: {
                async head() { return null; },
                async get() { return null; }
            },
            DERIVATIVE_STAGING: provider.bucket,
            PROCESSOR_IDENTITIES: processorIdentity,
            PROCESSING_ORIGIN: processingOrigin
        }
    };
}

function createProcessingModelD1(model, runRecord) {
    const database = {
        prepare(sql) {
            return {
                bind(...bindings) {
                    return {
                        first: async () => readFirst(sql),
                        all: async () => readAll(sql),
                        run: async () => run(sql, bindings)
                    };
                }
            };
        },
        async batch() {
            throw new Error('The complete-loss request must stop before a D1 batch.');
        }
    };

    function readFirst(sql) {
        model.calls.push(`first:${compactSql(sql)}`);
        if (sql.includes('evidence.*') && sql.includes('FROM draft_processing_runs AS run')) {
            return runRecord;
        }
        if (sql.includes('upload.synthetic_only_confirmed AS syntheticOnlyConfirmed')) {
            return syntheticEvidence;
        }
        if (sql.includes('FROM draft_processing_cleanups')) {
            return null;
        }
        if (sql.includes('FROM draft_processing_outputs WHERE')) {
            return model.output;
        }
        if (sql.includes('FROM draft_processing_multipart_uploads')) {
            return model.multipart;
        }
        throw new Error(`Unexpected rehearsal D1 read: ${compactSql(sql)}`);
    }

    function readAll(sql) {
        model.calls.push(`all:${compactSql(sql)}`);
        if (sql.includes('FROM pending_athlete_exclusions')) {
            return { results: [] };
        }
        throw new Error(`Unexpected rehearsal D1 row read: ${compactSql(sql)}`);
    }

    function run(sql, bindings) {
        model.calls.push(`run:${compactSql(sql)}`);
        if (sql.includes('INSERT INTO draft_processing_outputs')) {
            model.output = {
                processingRunId: bindings[0],
                role: bindings[1],
                uploadIdempotencyKey: bindings[2],
                uploadPayloadFingerprint: bindings[3],
                stagingObjectKey: bindings[4],
                sha256: bindings[5],
                byteCount: bindings[6],
                contentType: 'image/webp',
                width: bindings[7],
                height: bindings[8],
                status: 'reserved',
                stagingObjectVersion: null,
                stagingEtag: null,
                metadataScanJson: null,
                scannerVersion: null,
                createdAt: bindings[9],
                storedAt: null,
                verifiedAt: null
            };
            return d1Success();
        }
        if (sql.includes('INSERT INTO draft_processing_multipart_uploads')) {
            model.multipart = {
                processingRunId: bindings[0],
                role: bindings[1],
                stagingObjectKey: bindings[2],
                uploadPayloadFingerprint: bindings[3],
                providerUploadId: bindings[4],
                providerUploadIdHash: bindings[5],
                status: 'open',
                providerPartEtag: null,
                terminalKind: null,
                createdAt: bindings[6],
                updatedAt: bindings[6],
                partUploadedAt: null,
                terminalAt: null
            };
            return d1Success();
        }
        if (
            sql.includes('UPDATE draft_processing_multipart_uploads') &&
            sql.includes("SET status = 'part-uploaded'")
        ) {
            model.multipart.status = 'part-uploaded';
            model.multipart.providerPartEtag = bindings[0];
            model.multipart.updatedAt = bindings[1];
            model.multipart.partUploadedAt = bindings[1];
            return d1Success();
        }
        throw new Error(`Unexpected rehearsal D1 write: ${compactSql(sql)}`);
    }

    return database;
}

function createCompletingProviderBucket() {
    const uploads = new Map();
    const objects = new Map();
    let completeSuccesses = 0;
    const bucket = {
        async head(key) {
            return objectHead(objects.get(key));
        },
        async get(key) {
            const object = objects.get(key);
            return object ? { ...objectHead(object), body: object.bytes.slice() } : null;
        },
        async delete(key) {
            objects.delete(key);
        },
        async list() {
            return { objects: [], truncated: false };
        },
        async createMultipartUpload(key, options) {
            const uploadId = 'provider-complete-loss-upload';
            uploads.set(uploadId, {
                key,
                options,
                part: null
            });
            return {
                key,
                uploadId,
                async abort() {
                    uploads.delete(uploadId);
                }
            };
        },
        resumeMultipartUpload(key, uploadId) {
            const upload = uploads.get(uploadId);
            if (!upload || upload.key !== key) {
                throw noSuchUpload();
            }
            return {
                key,
                uploadId,
                async uploadPart(partNumber, bytes) {
                    upload.part = bytes.slice();
                    return { partNumber, etag: 'provider-part-etag' };
                },
                async complete(parts) {
                    assert.deepEqual(parts, [{
                        partNumber: 1,
                        etag: 'provider-part-etag'
                    }]);
                    objects.set(key, {
                        bytes: upload.part.slice(),
                        version: 'provider-completed-version',
                        etag: 'provider-completed-etag',
                        httpMetadata: { ...upload.options.httpMetadata },
                        customMetadata: { ...upload.options.customMetadata }
                    });
                    uploads.delete(uploadId);
                    completeSuccesses += 1;
                    return { key };
                },
                async abort() {
                    uploads.delete(uploadId);
                }
            };
        }
    };
    return {
        bucket,
        objects,
        get completeSuccesses() { return completeSuccesses; }
    };
}

function objectHead(object) {
    return object ? {
        size: object.bytes.byteLength,
        version: object.version,
        etag: object.etag,
        httpMetadata: { ...object.httpMetadata },
        customMetadata: { ...object.customMetadata }
    } : null;
}

function syntheticWebp(width, height) {
    const bytes = new Uint8Array(26);
    writeAscii(bytes, 0, 'RIFF');
    new DataView(bytes.buffer).setUint32(4, bytes.byteLength - 8, true);
    writeAscii(bytes, 8, 'WEBP');
    writeAscii(bytes, 12, 'VP8L');
    new DataView(bytes.buffer).setUint32(16, 5, true);
    bytes[20] = 0x2f;
    const packed = (width - 1) | ((height - 1) << 14);
    new DataView(bytes.buffer).setUint32(21, packed, true);
    return bytes;
}

function writeAscii(bytes, offset, value) {
    for (let index = 0; index < value.length; index += 1) {
        bytes[offset + index] = value.charCodeAt(index);
    }
}

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

function compactSql(sql) {
    return sql.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function d1Success() {
    return { success: true, meta: { changes: 1 } };
}

function noSuchUpload() {
    const error = new Error('No such upload.');
    error.name = 'NoSuchUpload';
    return error;
}

async function invokeTarget(mode, bucket, multipart) {
    switch (mode) {
    case 'after-upload-part':
        return multipart.uploadPart(1, new Uint8Array([1]));
    case 'after-complete':
        return multipart.complete([{ partNumber: 1, etag: 'provider-part-etag' }]);
    case 'after-abort':
        return multipart.abort();
    case 'after-delete':
        return bucket.delete('server-derived-key');
    default:
        throw new Error('Unsupported test mode.');
    }
}

function targetOperation(mode) {
    return mode.slice('after-'.length);
}
