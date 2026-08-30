import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

import sharp from 'sharp';

import { handleAdminRequest } from '../gallery-admin/src/admin-worker.js';
import { handleProcessingRequest } from '../gallery-admin/src/processing-worker.js';
import { cleanupPhotoPromotion } from '../gallery-admin/src/promotion-cleanup-service.js';
import { promotePhotoDraft } from '../gallery-admin/src/promotion-service.js';
import { buildV1StagingDerivativeKey } from '../gallery-admin/src/storage-keys.js';
import { processSyntheticGalleryPhoto } from '../scripts/gallery-media/processor.mjs';

const adminOrigin = 'https://synthetic-owner-admin.example';
const processingOrigin = 'https://synthetic-processing.example';
const processorSubject = '0123456789abcdef0123456789abcdef.access';
const fixedNow = Date.UTC(2026, 7, 28, 15, 0, 0);
const sessionSecret = 'synthetic-phase-d-session-secret-0123456789abcdef';
const manifestUrls = [
    new URL('../gallery-data/family.json', import.meta.url),
    new URL('../gallery-data/everyone.json', import.meta.url),
    new URL('../gallery-data/hidden-athlete-ids.json', import.meta.url)
];
const manifestBaselines = await Promise.all(manifestUrls.map(url => readFile(url)));

const migrationSources = await Promise.all([
    '0001_private_gallery.sql',
    '0002_private_uploads.sql',
    '0003_private_original_v1_keys.sql',
    '0004_private_processing_staging.sql',
    '0005_private_processing_cleanup.sql',
    '0006_transition_receipt_state_version.sql',
    '0007_photo_promotion.sql',
    '0008_photo_promotion_cleanup.sql'
].map(fileName => readFile(
    new URL(`../gallery-admin/migrations/${fileName}`, import.meta.url),
    'utf8'
)));
const sqlite = new DatabaseSync(':memory:');
for (const migrationSource of migrationSources) {
    sqlite.exec(migrationSource);
}
const d1 = createSqliteD1(sqlite);
const originals = createPrivateOriginalsBucket();
const staging = createStagingBucket();
const approved = createStagingBucket();
const adminEnv = {
    ADMIN_ORIGIN: adminOrigin,
    OWNER_IDENTITIES: 'subject:synthetic-owner',
    AUTOMATION_IDENTITIES: 'subject:synthetic-automation',
    SESSION_SECRET: sessionSecret,
    DB: d1,
    PRIVATE_ORIGINALS: originals
};
const processingEnv = {
    PROCESSING_ORIGIN: processingOrigin,
    PROCESSOR_IDENTITIES: `subject:${processorSubject}`,
    DB: d1,
    PRIVATE_ORIGINALS: originals,
    DERIVATIVE_STAGING: staging
};
let currentNow = fixedNow;
let ownerSession;

const sessionResponse = await ownerRequest('/api/browser/session', { authenticated: true });
assert.equal(sessionResponse.status, 200);
const sessionBody = await sessionResponse.json();
ownerSession = {
    cookie: sessionResponse.headers.get('Set-Cookie').split(';', 1)[0],
    csrfToken: sessionBody.csrfToken
};

const catalogResponse = await ownerRequest('/api/browser/catalog', {
    authenticated: true,
    session: true
});
assert.equal(catalogResponse.status, 200);
const catalog = await catalogResponse.json();
const familyCatalog = catalog.sites.family;
const selectedResult = familyCatalog.results.find(result =>
    familyCatalog.races.some(race => sameRace(race, result)) &&
    familyCatalog.roster.some(entry => entry.athleteId === result.athleteId)
);
assert.ok(selectedResult);

const draftCreate = await ownerRequest('/api/browser/drafts', {
    method: 'POST',
    authenticated: true,
    session: true,
    json: {
        itemInput: {
            id: 'synthetic-phase-d-bridge-photo',
            type: 'photo',
            title: 'Synthetic Phase D bridge photo',
            caption: 'Synthetic bytes used only for the private processing bridge rehearsal.',
            alt: 'A generated block of colour used to test private media processing.',
            raceDate: selectedResult.raceDate,
            raceEvent: selectedResult.raceEvent,
            raceDistance: selectedResult.raceDistance,
            featured: true,
            athleteIds: [selectedResult.athleteId]
        },
        consent: {
            publicUseConfirmed: true,
            containsMinors: true,
            guardianApprovalConfirmed: true,
            privateEvidenceReference: 'synthetic-private-consent-evidence-sentinel'
        }
    }
});
assert.equal(draftCreate.status, 201, await draftCreate.clone().text());
let draft = (await draftCreate.json()).draft;

const sourceBytes = new Uint8Array(await sharp({
    create: {
        width: 1800,
        height: 1200,
        channels: 3,
        background: { r: 18, g: 91, b: 147 }
    }
}).jpeg({ quality: 91, chromaSubsampling: '4:4:4' }).toBuffer());
assert.ok(sourceBytes.byteLength > 0 && sourceBytes.byteLength < 5 * 1024 * 1024);

const uploadStart = await ownerRequest(`/api/browser/drafts/${draft.draftId}/upload`, {
    method: 'POST',
    authenticated: true,
    session: true,
    json: {
        expectedStateVersion: draft.stateVersion,
        fileName: 'synthetic-phase-d-bridge.jpg',
        declaredMimeType: 'image/jpeg',
        byteLength: sourceBytes.byteLength,
        idempotencyKey: 'phase-d-upload-start-0001',
        syntheticOnlyConfirmed: true
    }
});
assert.equal(uploadStart.status, 201, await uploadStart.clone().text());

const uploadPart = await ownerRequest(
    `/api/browser/drafts/${draft.draftId}/upload-parts/1`,
    {
        method: 'PUT',
        authenticated: true,
        session: true,
        rawBody: sourceBytes,
        headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(sourceBytes.byteLength),
            'X-Chunk-SHA256': sha256(sourceBytes)
        }
    }
);
assert.equal(uploadPart.status, 201, await uploadPart.clone().text());

const uploadComplete = await ownerRequest(
    `/api/browser/drafts/${draft.draftId}/upload-completion`,
    {
        method: 'POST',
        authenticated: true,
        session: true,
        json: {
            expectedStateVersion: draft.stateVersion + 1,
            idempotencyKey: 'phase-d-upload-complete-01'
        }
    }
);
assert.equal(uploadComplete.status, 201, await uploadComplete.clone().text());
draft = (await uploadComplete.json()).draft;
assert.equal(draft.state, 'private-review');
assert.equal(draft.originalSha256, sha256(sourceBytes));

const approval = await ownerRequest(`/api/browser/drafts/${draft.draftId}/transitions`, {
    method: 'POST',
    authenticated: true,
    session: true,
    json: {
        toState: 'approved-for-processing',
        expectedStateVersion: draft.stateVersion,
        idempotencyKey: 'phase-d-owner-approval-0001'
    }
});
assert.equal(approval.status, 200, await approval.clone().text());
draft = (await approval.json()).draft;
assert.equal(draft.state, 'approved-for-processing');

// Authentication, route grammar, and binding failures happen before any
// private storage call. Browser sessions have no standing on this Worker.
const callsBeforeAuthorizationMatrix = originals.calls.length + staging.calls.length;
assert.equal((await processorRequest(
    `/api/service/drafts/${draft.draftId}/processing-runs`,
    { method: 'POST', json: startInput(draft) }
)).status, 403);
assert.equal((await processorRequest(
    `/api/service/drafts/${draft.draftId}/processing-runs`,
    { method: 'POST', identity: { type: 'browser', subject: 'synthetic-owner' }, json: startInput(draft) }
)).status, 403);
assert.equal((await processorRequest(
    `/api/service/drafts/${draft.draftId}/processing-runs?site=everyone`,
    { method: 'POST', identity: processorIdentity(), json: startInput(draft) }
)).status, 404);
assert.equal((await processorRequest(
    `/api/service/drafts/${draft.draftId}/processing-runs`,
    {
        method: 'POST',
        identity: processorIdentity(),
        env: { ...processingEnv, DERIVATIVE_STAGING: undefined },
        json: startInput(draft)
    }
)).status, 503);
assert.equal(originals.calls.length + staging.calls.length, callsBeforeAuthorizationMatrix);

// The request cannot choose a destination, key, run ID, race, person, or any
// other editorial fact. An extra site field makes the whole body invalid.
assert.equal((await processorRequest(
    `/api/service/drafts/${draft.draftId}/processing-runs`,
    {
        method: 'POST',
        identity: processorIdentity(),
        json: { ...startInput(draft), site: 'everyone' }
    }
)).status, 400);

const runStart = await processorRequest(
    `/api/service/drafts/${draft.draftId}/processing-runs`,
    { method: 'POST', identity: processorIdentity(), json: startInput(draft) }
);
assert.equal(
    runStart.status,
    201,
    `${await runStart.clone().text()} ${d1.lastError?.message || ''}`
);
const run = await runStart.json();
assert.equal(run.site, 'family');
assert.equal(run.mediaType, 'photo');
assert.equal(run.state, 'processing');
assert.deepEqual(run.requiredRoles, ['photo-display', 'photo-thumbnail']);
assert.match(run.processingRunId, /^run_[a-f0-9]{32}$/);
assert.equal(JSON.stringify(run).includes('private-originals/'), false);
assert.equal(JSON.stringify(run).includes('provider-'), false);
assert.equal(JSON.stringify(run).includes('synthetic-private-consent'), false);

// Database callers cannot create a parallel terminal run directly. The newer
// cleanup guard rejects the replacement before its forged terminal state can
// bypass the original active-run insertion contract.
const activeRunRow = { ...sqlite.prepare(
    'SELECT * FROM draft_processing_runs WHERE processing_run_id = ?'
).get(run.processingRunId) };
const forgedTerminalRun = {
    ...activeRunRow,
    processing_run_id: 'run_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa',
    start_idempotency_key: 'phase-d-forged-terminal-start',
    status: 'failed',
    result_idempotency_key: 'phase-d-forged-terminal-result',
    result_payload_fingerprint: 'e'.repeat(64),
    result_transition_key: `failure_${'f'.repeat(64)}`,
    result_toolchain_json: null,
    failure_code: 'processing-failed',
    updated_at: new Date(currentNow + 60_000).toISOString(),
    completed_at: new Date(currentNow + 60_000).toISOString()
};
assert.match(forgedTerminalRun.processing_run_id, /^run_[a-f0-9]{32}$/);
const forgedRunColumns = Object.keys(forgedTerminalRun);
assert.throws(
    () => sqlite.prepare(
        `INSERT INTO draft_processing_runs (${forgedRunColumns.join(', ')}) VALUES (` +
        forgedRunColumns.map(() => '?').join(', ') + ')'
    ).run(...forgedRunColumns.map(column => forgedTerminalRun[column])),
    /every prior processing run requires completed cleanup.*before replacement/i
);

const startReplay = await processorRequest(
    `/api/service/drafts/${draft.draftId}/processing-runs`,
    { method: 'POST', identity: processorIdentity(), json: startInput(draft) }
);
assert.equal(startReplay.status, 200);
assert.equal((await startReplay.json()).processingRunId, run.processingRunId);

assert.equal((await processorRequest(run.source.downloadPath, {
    method: 'GET',
    identity: processorIdentity(),
    headers: { Range: 'bytes=0-9' }
})).status, 400);

// Revocation that lands while the private body is being read must win before
// any bytes are returned to the processor.
originals.afterGet = () => {
    insertPendingExclusion(sqlite, selectedResult.athleteId, catalog.suppressionRevision);
};
const revokedDuringOriginalRead = await processorRequest(run.source.downloadPath, {
    method: 'GET',
    identity: processorIdentity()
});
assert.equal(revokedDuringOriginalRead.status, 404);
resolvePendingExclusion(sqlite, selectedResult.athleteId, catalog.suppressionRevision);
sqlite.prepare('DELETE FROM pending_athlete_exclusions WHERE athlete_id = ?')
    .run(selectedResult.athleteId);
const originalDownload = await processorRequest(run.source.downloadPath, {
    method: 'GET',
    identity: processorIdentity()
});
assert.equal(originalDownload.status, 200);
assert.equal(originalDownload.headers.get('Cache-Control'), 'no-store');
assert.equal(originalDownload.headers.get('Content-Type'), 'image/jpeg');
assert.equal(originalDownload.headers.get('Content-Length'), String(sourceBytes.byteLength));
assert.equal(originalDownload.headers.get('X-Gallery-Content-SHA256'), sha256(sourceBytes));
assert.equal(originalDownload.headers.has('ETag'), false);
assert.deepEqual(new Uint8Array(await originalDownload.arrayBuffer()), sourceBytes);

const processed = await processSyntheticGalleryPhoto({
    syntheticOnly: true,
    sourceBytes: Buffer.from(sourceBytes),
    fileName: run.source.syntheticFileName,
    declaredMimeType: run.source.declaredMimeType,
    draftBinding: {
        site: run.site,
        draftId: draft.draftId,
        processingRunId: run.processingRunId
    }
});
assert.deepEqual(
    processed.derivatives.map(derivative => derivative.storageRole),
    ['photo-display', 'photo-thumbnail']
);

const derivativeByRole = new Map(processed.derivatives.map(derivative => [
    derivative.storageRole,
    derivative
]));
const display = derivativeByRole.get('photo-display');
const thumbnail = derivativeByRole.get('photo-thumbnail');
const displayBytes = new Uint8Array(await display.payload.arrayBuffer());
const thumbnailBytes = new Uint8Array(await thumbnail.payload.arrayBuffer());

// Output rows must begin as a reservation, and the database mirrors the
// service's smaller five-MiB thumbnail limit.
const forgedOutputTimestamp = new Date(currentNow + 1_000).toISOString();
assert.throws(
    () => sqlite.prepare(`
        INSERT INTO draft_processing_outputs (
            processing_run_id, role, upload_idempotency_key,
            upload_payload_fingerprint, staging_object_key, sha256, byte_count,
            content_type, width, height, status, staging_object_version,
            staging_etag, metadata_scan_json, scanner_version, created_at,
            stored_at, verified_at
        ) VALUES (?, 'photo-display', ?, ?, ?, ?, ?, 'image/webp', ?, ?,
            'verified', 'forged-version', 'forged-etag', ?, '13.40', ?, ?, ?)
    `).run(
        run.processingRunId,
        'phase-d-forged-verified-output',
        'd'.repeat(64),
        display.stagingKey,
        display.sha256,
        display.byteLength,
        display.width,
        display.height,
        '{"schemaVersion":"1.0","scannerName":"exiftool","scannerVersion":"13.40","metadataEntryCount":0,"findingCategories":[]}',
        forgedOutputTimestamp,
        forgedOutputTimestamp,
        forgedOutputTimestamp
    ),
    /processing output lacks an active current run/i
);
const oversizedThumbnailHash = '1'.repeat(64);
assert.throws(
    () => sqlite.prepare(`
        INSERT INTO draft_processing_outputs (
            processing_run_id, role, upload_idempotency_key,
            upload_payload_fingerprint, staging_object_key, sha256, byte_count,
            content_type, width, height, status, created_at
        ) VALUES (?, 'photo-thumbnail', ?, ?, ?, ?, ?, 'image/webp', 480, 320,
            'reserved', ?)
    `).run(
        run.processingRunId,
        'phase-d-oversized-thumbnail',
        'c'.repeat(64),
        `derivative-staging/v1/family/${draft.draftId}/${run.processingRunId}/` +
            `${oversizedThumbnailHash}/thumbnail.webp`,
        oversizedThumbnailHash,
        5 * 1024 * 1024 + 1,
        forgedOutputTimestamp
    ),
    /check constraint failed/i
);

// Simulate the non-atomic R2/D1 boundary: the one-part multipart upload is
// completed, then the first D1 provider-evidence update fails. The exact retry
// adopts only that object; it never performs a direct staging put or a second
// multipart completion.
d1.failNextRunContaining = "SET status = 'stored'";
const interruptedDisplay = await uploadDerivative(run.processingRunId, display, displayBytes);
assert.equal(interruptedDisplay.status, 503);
assert.equal(staging.objects.size, 1);
const completionCountAfterInterruption = staging.calls
    .filter(call => call.operation === 'complete').length;
const displayRetry = await uploadDerivative(run.processingRunId, display, displayBytes);
assert.equal(displayRetry.status, 201, await displayRetry.clone().text());
assert.equal(
    staging.calls.filter(call => call.operation === 'complete').length,
    completionCountAfterInterruption
);
assert.equal(staging.calls.filter(call => call.operation === 'put').length, 0);
assert.equal(JSON.stringify(await displayRetry.clone().json()).includes('derivative-staging/'), false);

const displayReplay = await uploadDerivative(run.processingRunId, display, displayBytes);
assert.equal(displayReplay.status, 200);
assert.equal((await displayReplay.json()).replayed, true);

// A valid but different WebP cannot take over the already reserved display
// role, even with a different idempotency key.
const conflictingDisplay = await uploadDerivative(
    run.processingRunId,
    { ...thumbnail, storageRole: 'photo-display' },
    thumbnailBytes,
    'phase-d-output-conflict-01'
);
assert.equal(conflictingDisplay.status, 409);

// An exclusion that lands after R2 succeeds but immediately before the D1
// stored transition is caught by the database guard. The exact private object
// remains reserved and recoverable; a different caller cannot overwrite it.
d1.beforeRunContaining = {
    needle: "SET status = 'stored'",
    callback: () => {
        insertPendingExclusion(sqlite, selectedResult.athleteId, catalog.suppressionRevision);
    }
};
const racedThumbnail = await uploadDerivative(run.processingRunId, thumbnail, thumbnailBytes);
assert.equal(racedThumbnail.status, 503);
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM pending_athlete_exclusions ' +
    'WHERE athlete_id = ? AND resolved_at IS NULL'
).get(selectedResult.athleteId).count, 1);
assert.equal(sqlite.prepare(
    'SELECT status FROM draft_processing_outputs WHERE processing_run_id = ? AND role = ?'
).get(run.processingRunId, 'photo-thumbnail').status, 'reserved');
const completionCountAfterRevocationRace = staging.calls
    .filter(call => call.operation === 'complete').length;
const blockedThumbnail = await uploadDerivative(run.processingRunId, thumbnail, thumbnailBytes);
assert.equal(blockedThumbnail.status, 409);
resolvePendingExclusion(sqlite, selectedResult.athleteId, catalog.suppressionRevision);
const thumbnailStored = await uploadDerivative(run.processingRunId, thumbnail, thumbnailBytes);
assert.equal(thumbnailStored.status, 201, await thumbnailStored.clone().text());
assert.equal(
    staging.calls.filter(call => call.operation === 'complete').length,
    completionCountAfterRevocationRace
);
const thumbnailReplay = await uploadDerivative(run.processingRunId, thumbnail, thumbnailBytes);
assert.equal(thumbnailReplay.status, 200, await thumbnailReplay.clone().text());
sqlite.prepare('DELETE FROM pending_athlete_exclusions WHERE athlete_id = ?')
    .run(selectedResult.athleteId);

// Direct mutation cannot detach the active run from the revisions, consent,
// source, or site that were approved.
assert.throws(
    () => sqlite.prepare(
        'UPDATE gallery_drafts SET source_revision = ? WHERE draft_id = ?'
    ).run('forged-source-revision', draft.draftId),
    /processing evidence must be resolved/i
);
assert.throws(
    () => sqlite.prepare(
        "UPDATE gallery_drafts SET state = 'candidate-public', state_version = state_version + 1 " +
        'WHERE draft_id = ?'
    ).run(draft.draftId),
    /candidate publication lacks exact photo promotion evidence/i
);

const stagedResultInput = {
    outcome: 'staged',
    expectedStateVersion: run.stateVersion,
    idempotencyKey: 'phase-d-result-staged-0001',
    source: {
        sha256: processed.source.sha256,
        byteLength: processed.source.byteLength,
        detectedFormat: processed.source.detectedFormat
    },
    toolchain: { ...processed.toolchain },
    derivatives: processed.derivatives.map(derivative => ({
        role: derivative.storageRole,
        sha256: derivative.sha256,
        byteLength: derivative.byteLength,
        width: derivative.width,
        height: derivative.height,
        durationMilliseconds: null,
        metadataEntryCount: derivative.metadataEntryCount,
        metadataFindingCategories: []
    }))
};
// If a stale failure request and a valid staged result race, exactly one
// terminal result wins. The losing failure cannot move the draft, append a
// receipt, or record a false audit after the run has staged.
let stagedWinner;
d1.beforeNextBatch = async () => {
    const winnerResponse = await processorRequest(
        `/api/service/processing-runs/${run.processingRunId}/result`,
        { method: 'POST', identity: processorIdentity(), json: stagedResultInput }
    );
    assert.equal(winnerResponse.status, 200, await winnerResponse.clone().text());
    stagedWinner = await winnerResponse.json();
};
const staleFailureResponse = await processorRequest(
    `/api/service/processing-runs/${run.processingRunId}/result`,
    {
        method: 'POST',
        identity: processorIdentity(),
        json: {
            outcome: 'failed',
            expectedStateVersion: run.stateVersion,
            idempotencyKey: 'phase-d-result-stale-failure',
            errorCode: 'processing-failed'
        }
    }
);
assert.equal(staleFailureResponse.status, 409);
assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM draft_transition_receipts " +
    "WHERE draft_id = ? AND to_state = 'processing-failed'"
).get(draft.draftId).count, 0);
assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM gallery_audit_events WHERE event_type = 'processing-failed'"
).get().count, 0);
const result = stagedWinner;
assert.equal(result.status, 'staged');
assert.equal(result.state, 'processing');
assert.equal(result.stateVersion, run.stateVersion);
assert.deepEqual(result.roles, ['photo-display', 'photo-thumbnail']);
assert.equal(result.replayed, false);

const resultReplayResponse = await processorRequest(
    `/api/service/processing-runs/${run.processingRunId}/result`,
    { method: 'POST', identity: processorIdentity(), json: stagedResultInput }
);
assert.equal(resultReplayResponse.status, 200);
assert.equal((await resultReplayResponse.json()).replayed, true);
const reorderedResultReplay = await processorRequest(
    `/api/service/processing-runs/${run.processingRunId}/result`,
    {
        method: 'POST',
        identity: processorIdentity(),
        json: {
            derivatives: [...stagedResultInput.derivatives].reverse(),
            toolchain: {
                videoEnabled: false,
                exiftool: stagedResultInput.toolchain.exiftool,
                png: stagedResultInput.toolchain.png,
                webp: stagedResultInput.toolchain.webp,
                libvips: stagedResultInput.toolchain.libvips,
                sharp: stagedResultInput.toolchain.sharp
            },
            source: {
                detectedFormat: stagedResultInput.source.detectedFormat,
                byteLength: stagedResultInput.source.byteLength,
                sha256: stagedResultInput.source.sha256
            },
            idempotencyKey: stagedResultInput.idempotencyKey,
            expectedStateVersion: stagedResultInput.expectedStateVersion,
            outcome: 'staged'
        }
    }
);
assert.equal(reorderedResultReplay.status, 200);
assert.equal((await reorderedResultReplay.json()).replayed, true);

assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM draft_processing_runs WHERE status = ?'
).get('staged').count, 1);
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM draft_processing_outputs WHERE status = ?'
).get('verified').count, 2);
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM draft_derivatives WHERE draft_id = ? ' +
    'AND staging_object_key IS NOT NULL AND approved_object_key IS NULL'
).get(draft.draftId).count, 2);
assert.equal(sqlite.prepare(
    'SELECT state FROM gallery_drafts WHERE draft_id = ?'
).get(draft.draftId).state, 'processing');
assert.throws(
    () => sqlite.prepare(
        "UPDATE gallery_drafts SET state = 'candidate-public', state_version = state_version + 1 " +
        'WHERE draft_id = ?'
    ).run(draft.draftId),
    /candidate publication lacks exact photo promotion evidence/i
);
assert.throws(
    () => sqlite.prepare(
        'UPDATE draft_derivatives SET sha256 = ? WHERE draft_id = ? AND role = ?'
    ).run('0'.repeat(64), draft.draftId, 'photo-display'),
    /verified processing derivative evidence is immutable/i
);
assert.throws(
    () => sqlite.prepare(
        'DELETE FROM draft_derivatives WHERE draft_id = ? AND role = ?'
    ).run(draft.draftId, 'photo-display'),
    /processing derivative deletion lacks verified staging absence/i
);
assert.equal(staging.objects.size, 2);
assert.equal(staging.overwriteAttempts, 0);

for (const row of sqlite.prepare(
    'SELECT role, staging_object_key AS stagingObjectKey, sha256, byte_count AS byteCount, ' +
    'staging_object_version AS objectVersion, staging_etag AS etag ' +
    'FROM draft_processing_outputs ORDER BY role'
).all()) {
    assert.match(
        row.stagingObjectKey,
        new RegExp(`^derivative-staging/v1/family/${escapeRegex(draft.draftId)}/`)
    );
    const object = staging.objects.get(row.stagingObjectKey);
    assert.ok(object);
    assert.equal(object.bytes.byteLength, row.byteCount);
    assert.equal(sha256(object.bytes), row.sha256);
    assert.equal(object.version, row.objectVersion);
    assert.equal(object.etag, row.etag);
    assert.equal(object.httpMetadata.contentType, 'image/webp');
    assert.equal(object.customMetadata.role, row.role);
}

// Sanitized processor failure is the only other result shape. It atomically
// records the fixed code and moves only that draft to processing-failed; no
// arbitrary message, path, or staging deletion authority is accepted.
const failedDraft = await createApprovedSyntheticPhotoDraft('synthetic-phase-d-failure', 'failure');
const failedRunStart = await processorRequest(
    `/api/service/drafts/${failedDraft.draftId}/processing-runs`,
    {
        method: 'POST',
        identity: processorIdentity(),
        json: {
            expectedStateVersion: failedDraft.stateVersion,
            idempotencyKey: 'phase-d-failure-run-start-01'
        }
    }
);
assert.equal(failedRunStart.status, 201, await failedRunStart.clone().text());
const failedRun = await failedRunStart.json();
const stagedObjectCountBeforeFailure = staging.objects.size;
const failedResultInput = {
    outcome: 'failed',
    expectedStateVersion: failedRun.stateVersion,
    idempotencyKey: 'phase-d-failure-result-0001',
    errorCode: 'derivative-rejected'
};
const losingFailureInput = {
    ...failedResultInput,
    idempotencyKey: 'phase-d-failure-result-loser',
    errorCode: 'processing-failed'
};
let failedResult;
d1.beforeNextBatch = async () => {
    const winnerResponse = await processorRequest(
        `/api/service/processing-runs/${failedRun.processingRunId}/result`,
        { method: 'POST', identity: processorIdentity(), json: failedResultInput }
    );
    assert.equal(winnerResponse.status, 200, await winnerResponse.clone().text());
    failedResult = await winnerResponse.json();
};
const losingFailureResponse = await processorRequest(
    `/api/service/processing-runs/${failedRun.processingRunId}/result`,
    { method: 'POST', identity: processorIdentity(), json: losingFailureInput }
);
assert.equal(losingFailureResponse.status, 409);
assert.equal(failedResult.status, 'failed');
assert.equal(failedResult.state, 'processing-failed');
assert.equal(failedResult.stateVersion, failedRun.stateVersion + 1);
assert.equal(staging.objects.size, stagedObjectCountBeforeFailure);
assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM draft_transition_receipts " +
    "WHERE draft_id = ? AND to_state = 'processing-failed'"
).get(failedDraft.draftId).count, 1);
assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM gallery_audit_events WHERE event_type = 'processing-failed'"
).get().count, 1);
const failedResultReplay = await processorRequest(
    `/api/service/processing-runs/${failedRun.processingRunId}/result`,
    { method: 'POST', identity: processorIdentity(), json: failedResultInput }
);
assert.equal(failedResultReplay.status, 200);
assert.equal((await failedResultReplay.json()).replayed, true);
assert.equal((await processorRequest(
    `/api/service/processing-runs/${failedRun.processingRunId}/result`,
    {
        method: 'POST',
        identity: processorIdentity(),
        json: { ...failedResultInput, errorCode: 'processing-failed' }
    }
)).status, 409);
assert.equal(sqlite.prepare(
    'SELECT processing_diagnostics_json AS diagnostics FROM gallery_drafts WHERE draft_id = ?'
).get(failedDraft.draftId).diagnostics, JSON.stringify({
    schemaVersion: '1.0',
    code: 'derivative-rejected'
}));

// A completed staging run can be closed only for a database-derived safety
// reason. A pending athlete-wide exclusion wins here: both exact derivative
// keys disappear, while the caller cannot choose a reason or storage key.
const stagedOutputRows = sqlite.prepare(`
    SELECT output.role, output.staging_object_key AS stagingObjectKey,
           upload.provider_upload_id AS providerUploadId
    FROM draft_processing_outputs AS output
    JOIN draft_processing_multipart_uploads AS upload
      ON upload.processing_run_id = output.processing_run_id
     AND upload.role = output.role
    WHERE output.processing_run_id = ?
    ORDER BY output.role
`).all(run.processingRunId);
assert.equal(stagedOutputRows.length, 2);
insertPendingExclusion(sqlite, selectedResult.athleteId, catalog.suppressionRevision);
const stagedCallsBeforeInvalidCleanup = staging.calls.length;
assert.equal((await cleanupRun(
    run.processingRunId,
    run.stateVersion,
    'short'
)).status, 400);
assert.equal((await processorRequest(
    `/api/service/processing-runs/${run.processingRunId}/cleanup`,
    {
        method: 'POST',
        json: {
            expectedStateVersion: run.stateVersion,
            idempotencyKey: 'phase-d-cleanup-no-identity'
        }
    }
)).status, 403);
assert.equal((await processorRequest(
    `/api/service/processing-runs/${run.processingRunId}/cleanup?reason=withdrawal`,
    {
        method: 'POST',
        identity: processorIdentity(),
        json: {
            expectedStateVersion: run.stateVersion,
            idempotencyKey: 'phase-d-cleanup-query-reject'
        }
    }
)).status, 404);
assert.equal((await processorRequest(
    `/api/service/processing-runs/${run.processingRunId}/cleanup`,
    {
        method: 'POST',
        identity: processorIdentity(),
        env: { ...processingEnv, DERIVATIVE_STAGING: undefined },
        json: {
            expectedStateVersion: run.stateVersion,
            idempotencyKey: 'phase-d-cleanup-missing-binding'
        }
    }
)).status, 503);
assert.equal((await processorRequest(
    `/api/service/processing-runs/${run.processingRunId}/cleanup`,
    {
        method: 'POST',
        identity: processorIdentity(),
        env: { ...processingEnv, UNEXPECTED_STORAGE_CAPABILITY: {} },
        json: {
            expectedStateVersion: run.stateVersion,
            idempotencyKey: 'phase-d-cleanup-extra-binding'
        }
    }
)).status, 503);
assert.equal((await processorRequest(
    `/api/service/processing-runs/${run.processingRunId}/cleanup`,
    {
        method: 'POST',
        identity: processorIdentity(),
        json: {
            expectedStateVersion: run.stateVersion,
            idempotencyKey: 'phase-d-staged-cleanup-invalid',
            reason: 'withdrawal'
        }
    }
)).status, 400);
assert.equal(staging.calls.length, stagedCallsBeforeInvalidCleanup);
const stagedCleanupResponse = await cleanupRun(
    run.processingRunId,
    run.stateVersion,
    'phase-d-staged-exclusion-cleanup'
);
assert.equal(stagedCleanupResponse.status, 201, await stagedCleanupResponse.clone().text());
assert.deepEqual(await stagedCleanupResponse.json(), {
    processingRunId: run.processingRunId,
    cleanupReason: 'athlete-exclusion',
    status: 'cleaned',
    replayed: false
});
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM draft_processing_outputs WHERE processing_run_id = ?'
).get(run.processingRunId).count, 0);
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM draft_processing_multipart_uploads WHERE processing_run_id = ?'
).get(run.processingRunId).count, 0);
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM draft_derivatives WHERE draft_id = ?'
).get(draft.draftId).count, 0);
assert.equal(sqlite.prepare(
    'SELECT status FROM draft_processing_cleanups WHERE processing_run_id = ?'
).get(run.processingRunId).status, 'cleaned');
assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM draft_processing_cleanup_objects AS object
    JOIN draft_processing_cleanups AS cleanup ON cleanup.cleanup_id = object.cleanup_id
    WHERE cleanup.processing_run_id = ?
      AND object.status = 'absent'
      AND object.staging_object_key IS NULL
`).get(run.processingRunId).count, 2);
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM gallery_processing_cleanup_tombstones ' +
    'WHERE processing_run_id_hash = ?'
).get(sha256Text(run.processingRunId)).count, 1);
for (const outputRow of stagedOutputRows) {
    assert.equal(staging.objects.has(outputRow.stagingObjectKey), false);
    assert.throws(
        () => staging.resumeMultipartUpload(
            outputRow.stagingObjectKey,
            outputRow.providerUploadId
        ),
        error => error?.name === 'NoSuchUpload' && error?.code === 10024
    );
}
const stagedCleanupReplay = await cleanupRun(
    run.processingRunId,
    run.stateVersion,
    'phase-d-staged-exclusion-cleanup'
);
assert.equal(stagedCleanupReplay.status, 200);
assert.equal((await stagedCleanupReplay.json()).replayed, true);
assert.equal((await cleanupRun(
    run.processingRunId,
    run.stateVersion,
    'phase-d-staged-exclusion-conflict'
)).status, 409);
assert.equal((await uploadDerivative(
    run.processingRunId,
    display,
    displayBytes,
    'phase-d-closed-staged-output'
)).status, 409);
assert.equal((await processorRequest(
    `/api/service/processing-runs/${run.processingRunId}/result`,
    { method: 'POST', identity: processorIdentity(), json: stagedResultInput }
)).status, 409);
assert.throws(
    () => sqlite.prepare(
        "UPDATE gallery_drafts SET state = 'candidate-public', state_version = state_version + 1 " +
        'WHERE draft_id = ?'
    ).run(draft.draftId),
    /candidate publication lacks exact photo promotion evidence/i
);
resolvePendingExclusion(sqlite, selectedResult.athleteId, catalog.suppressionRevision);
sqlite.prepare('DELETE FROM pending_athlete_exclusions WHERE athlete_id = ?')
    .run(selectedResult.athleteId);

// A cleaned+tombstoned staged run is still the current run. SQLite's REPLACE
// conflict algorithm must not evict it (and cascade its cleanup) merely because
// its safety reason has since resolved. Both an active and a staged crafted
// replacement use different IDs and idempotency keys to bypass same-key guards.
const protectedStagedRun = { ...sqlite.prepare(
    'SELECT * FROM draft_processing_runs WHERE processing_run_id = ?'
).get(run.processingRunId) };
const protectedStagedCleanup = { ...sqlite.prepare(
    'SELECT * FROM draft_processing_cleanups WHERE processing_run_id = ?'
).get(run.processingRunId) };
const protectedStagedTombstone = { ...sqlite.prepare(
    'SELECT * FROM gallery_processing_cleanup_tombstones ' +
    'WHERE processing_run_id_hash = ?'
).get(sha256Text(run.processingRunId)) };
assert.equal(protectedStagedRun.status, 'staged');
assert.equal(protectedStagedCleanup.status, 'cleaned');
assert.ok(protectedStagedTombstone.evidence_hash);

const replacementTimestamp = new Date(currentNow += 1).toISOString();
const replacementCandidates = [
    {
        ...protectedStagedRun,
        processing_run_id: 'run_bbbbbbbbbbbb4bbb8bbbbbbbbbbbbbbb',
        start_idempotency_key: 'phase-d-or-replace-active-start',
        start_payload_fingerprint: '1'.repeat(64),
        status: 'active',
        result_idempotency_key: null,
        result_payload_fingerprint: null,
        result_transition_key: null,
        result_toolchain_json: null,
        failure_code: null,
        created_at: replacementTimestamp,
        updated_at: replacementTimestamp,
        completed_at: null
    },
    {
        ...protectedStagedRun,
        processing_run_id: 'run_cccccccccccc4ccc8ccccccccccccccc',
        start_idempotency_key: 'phase-d-or-replace-staged-start',
        start_payload_fingerprint: '2'.repeat(64),
        result_idempotency_key: 'phase-d-or-replace-staged-result',
        result_payload_fingerprint: '3'.repeat(64),
        created_at: replacementTimestamp,
        updated_at: replacementTimestamp,
        completed_at: replacementTimestamp
    }
];
for (const replacement of replacementCandidates) {
    const columns = Object.keys(replacement);
    assert.throws(
        () => sqlite.prepare(
            `INSERT OR REPLACE INTO draft_processing_runs (${columns.join(', ')}) VALUES (` +
            columns.map(() => '?').join(', ') + ')'
        ).run(...columns.map(column => replacement[column])),
        /processing run|replacement|current.*run/i
    );
    assert.deepEqual({ ...sqlite.prepare(
        'SELECT * FROM draft_processing_runs WHERE processing_run_id = ?'
    ).get(run.processingRunId) }, protectedStagedRun);
    assert.deepEqual({ ...sqlite.prepare(
        'SELECT * FROM draft_processing_cleanups WHERE processing_run_id = ?'
    ).get(run.processingRunId) }, protectedStagedCleanup);
    assert.deepEqual({ ...sqlite.prepare(
        'SELECT * FROM gallery_processing_cleanup_tombstones ' +
        'WHERE processing_run_id_hash = ?'
    ).get(sha256Text(run.processingRunId)) }, protectedStagedTombstone);
    assert.equal(sqlite.prepare(
        'SELECT COUNT(*) AS count FROM draft_processing_runs WHERE draft_id = ?'
    ).get(draft.draftId).count, 1);
}

// A failed run with no output still gets a durable cleanup closure. Repeating
// a presumed-lost successful response returns the same safe public result and
// does not make another storage call.
const failedRetryPath =
    `/api/service/processing-runs/${failedRun.processingRunId}/retry`;
assert.equal((await processorRequest(failedRetryPath, {
    method: 'POST',
    json: {
        expectedStateVersion: failedResult.stateVersion,
        idempotencyKey: 'phase-d-failed-retry-no-identity'
    }
})).status, 403);
assert.equal((await processorRequest(failedRetryPath, {
    method: 'GET',
    identity: processorIdentity()
})).status, 405);
assert.equal((await processorRequest(`${failedRetryPath}?run=forged`, {
    method: 'POST',
    identity: processorIdentity(),
    json: {
        expectedStateVersion: failedResult.stateVersion,
        idempotencyKey: 'phase-d-failed-retry-query'
    }
})).status, 404);
assert.equal((await processorRequest(failedRetryPath, {
    method: 'POST',
    identity: processorIdentity(),
    json: {
        expectedStateVersion: failedResult.stateVersion,
        idempotencyKey: 'phase-d-failed-retry-extra-field',
        site: 'everyone'
    }
})).status, 400);
assert.equal((await retryRun(
    failedRun.processingRunId,
    failedResult.stateVersion,
    'phase-d-failed-retry-before-cleanup'
)).status, 409);
assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM draft_transition_receipts " +
    "WHERE draft_id = ? AND from_state = 'processing-failed' " +
    "AND to_state = 'approved-for-processing'"
).get(failedDraft.draftId).count, 0);

// A cleanup row without its terminal tombstone is still in progress. The
// retry route must not treat a nearly finished cleanup as proof that the old
// run can be requeued.
d1.failNextRunContaining = 'INSERT INTO gallery_processing_cleanup_tombstones';
const failedCleanupInterrupted = await cleanupRun(
    failedRun.processingRunId,
    failedResult.stateVersion,
    'phase-d-failed-no-output-cleanup'
);
assert.equal(failedCleanupInterrupted.status, 503);
assert.equal(sqlite.prepare(
    'SELECT status FROM draft_processing_cleanups WHERE processing_run_id = ?'
).get(failedRun.processingRunId).status, 'deleting');
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM gallery_processing_cleanup_tombstones ' +
    'WHERE processing_run_id_hash = ?'
).get(sha256Text(failedRun.processingRunId)).count, 0);
assert.equal((await retryRun(
    failedRun.processingRunId,
    failedResult.stateVersion,
    'phase-d-failed-retry-before-tombstone'
)).status, 409);

const failedCleanupResponse = await cleanupRun(
    failedRun.processingRunId,
    failedResult.stateVersion,
    'phase-d-failed-no-output-cleanup'
);
assert.equal(failedCleanupResponse.status, 200, await failedCleanupResponse.clone().text());
assert.deepEqual(await failedCleanupResponse.json(), {
    processingRunId: failedRun.processingRunId,
    cleanupReason: 'processing-failed',
    status: 'cleaned',
    replayed: true
});
const callsAfterFailedCleanup = staging.calls.length;
const failedCleanupReplay = await cleanupRun(
    failedRun.processingRunId,
    failedResult.stateVersion,
    'phase-d-failed-no-output-cleanup'
);
assert.equal(failedCleanupReplay.status, 200);
assert.equal((await failedCleanupReplay.json()).replayed, true);
assert.equal(staging.calls.length, callsAfterFailedCleanup);

assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM draft_processing_outputs WHERE processing_run_id = ?'
).get(failedRun.processingRunId).count, 0);
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM draft_processing_multipart_uploads ' +
    'WHERE processing_run_id = ?'
).get(failedRun.processingRunId).count, 0);
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM draft_processing_cleanup_objects AS object ' +
    'JOIN draft_processing_cleanups AS cleanup ON cleanup.cleanup_id = object.cleanup_id ' +
    "WHERE cleanup.processing_run_id = ? AND object.status <> 'absent'"
).get(failedRun.processingRunId).count, 0);

// The application independently joins the tombstone back to every cleanup
// hash. This deliberately corrupts that one append-only row only for the
// duration of the probe, then restores its trigger and exact value.
const tombstoneNoUpdateTrigger = sqlite.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' " +
    "AND name = 'gallery_processing_cleanup_tombstones_no_update'"
).get().sql;
const exactCleanupEvidenceHash = sqlite.prepare(
    'SELECT cleanup_evidence_hash AS evidenceHash ' +
    'FROM draft_processing_cleanups WHERE processing_run_id = ?'
).get(failedRun.processingRunId).evidenceHash;
const mismatchedCleanupEvidenceHash = exactCleanupEvidenceHash === '0'.repeat(64)
    ? '1'.repeat(64)
    : '0'.repeat(64);
sqlite.exec('DROP TRIGGER gallery_processing_cleanup_tombstones_no_update');
try {
    sqlite.prepare(
        'UPDATE gallery_processing_cleanup_tombstones SET evidence_hash = ? ' +
        'WHERE processing_run_id_hash = ?'
    ).run(mismatchedCleanupEvidenceHash, sha256Text(failedRun.processingRunId));
    assert.equal((await retryRun(
        failedRun.processingRunId,
        failedResult.stateVersion,
        'phase-d-failed-retry-mismatched-tombstone'
    )).status, 409);
    assert.equal(sqlite.prepare(
        "SELECT state FROM gallery_drafts WHERE draft_id = ?"
    ).get(failedDraft.draftId).state, 'processing-failed');
} finally {
    sqlite.prepare(
        'UPDATE gallery_processing_cleanup_tombstones SET evidence_hash = ? ' +
        'WHERE processing_run_id_hash = ?'
    ).run(exactCleanupEvidenceHash, sha256Text(failedRun.processingRunId));
    sqlite.exec(tombstoneNoUpdateTrigger);
}

assert.equal((await retryRun(
    failedRun.processingRunId,
    failedResult.stateVersion + 1,
    'phase-d-failed-retry-stale-version'
)).status, 409);

// Consent withdrawal, original deletion, a changed diagnostic, and a newly
// pending tagged-athlete exclusion can all land after the service's read
// checks but before its transactional CAS. The draft guards recheck the live
// consent, upload, and exclusion facts. The receipt result guard also makes a
// zero-row diagnostic CAS abort the whole batch, so none of these races leaves
// a false retry receipt or audit event.
const consentRace = await createFailedCleanedProcessingRun('retry-consent-race');
d1.beforeNextBatch = async () => {
    transitionDraftDirect(sqlite, consentRace.draft.draftId, 'withdrawal-pending');
    markPrivateOriginalDeleted(sqlite, consentRace.draft.draftId);
    insertDeletionPublication(sqlite, consentRace.draft.draftId);
    withdrawActiveConsent(sqlite, consentRace.draft.draftId);
};
assert.equal((await retryRun(
    consentRace.run.processingRunId,
    consentRace.failed.stateVersion,
    'phase-d-retry-consent-race'
)).status, 409);
assert.equal(sqlite.prepare(
    'SELECT state, active_consent_revision AS consentRevision ' +
    'FROM gallery_drafts WHERE draft_id = ?'
).get(consentRace.draft.draftId).consentRevision, null);

const originalDeletionRace = await createFailedCleanedProcessingRun(
    'retry-original-deletion-race'
);
d1.beforeNextBatch = async () => {
    markPrivateOriginalDeleted(sqlite, originalDeletionRace.draft.draftId);
};
assert.equal((await retryRun(
    originalDeletionRace.run.processingRunId,
    originalDeletionRace.failed.stateVersion,
    'phase-d-retry-original-deletion-race'
)).status, 409);
assert.equal(sqlite.prepare(
    'SELECT state FROM gallery_drafts WHERE draft_id = ?'
).get(originalDeletionRace.draft.draftId).state, 'processing-failed');

const diagnosticRace = await createFailedCleanedProcessingRun('retry-diagnostic-race');
d1.beforeNextBatch = async () => {
    sqlite.prepare(
        'UPDATE gallery_drafts SET processing_diagnostics_json = ? WHERE draft_id = ?'
    ).run(
        '{"schemaVersion":"1.0","code":"toolchain-unavailable"}',
        diagnosticRace.draft.draftId
    );
};
assert.equal((await retryRun(
    diagnosticRace.run.processingRunId,
    diagnosticRace.failed.stateVersion,
    'phase-d-retry-diagnostic-race'
)).status, 409);
assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM draft_transition_receipts " +
    "WHERE draft_id = ? AND from_state = 'processing-failed'"
).get(diagnosticRace.draft.draftId).count, 0);

const exclusionRace = await createFailedCleanedProcessingRun('retry-exclusion-race');
d1.beforeNextBatch = async () => {
    insertPendingExclusion(sqlite, selectedResult.athleteId, catalog.suppressionRevision);
};
assert.equal((await retryRun(
    exclusionRace.run.processingRunId,
    exclusionRace.failed.stateVersion,
    'phase-d-retry-exclusion-race'
)).status, 409);
assert.equal(sqlite.prepare(
    "SELECT state FROM gallery_drafts WHERE draft_id = ?"
).get(exclusionRace.draft.draftId).state, 'processing-failed');
resolveAndRemoveSyntheticExclusion();
assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM gallery_audit_events " +
    "WHERE event_type = 'processing-retry-approved'"
).get().count, 0);

// The replacement guard is narrow: it blocks eviction of a still-current
// active/staged run, but a genuinely failed run with completed cleanup and its
// tombstone remains eligible for an authenticated service requeue and then a
// new processor run. The requeue clears only private failure diagnostics and
// records its receipt plus audit event in the same D1 batch.
const failedRetryInput = {
    expectedStateVersion: failedResult.stateVersion,
    idempotencyKey: 'phase-d-failed-cleaned-retry'
};
const failedRetryResponse = await retryRun(
    failedRun.processingRunId,
    failedRetryInput.expectedStateVersion,
    failedRetryInput.idempotencyKey
);
assert.equal(failedRetryResponse.status, 200, await failedRetryResponse.clone().text());
const failedRetry = await failedRetryResponse.json();
assert.deepEqual(failedRetry, {
    schemaVersion: '1.0',
    processingRunId: failedRun.processingRunId,
    state: 'approved-for-processing',
    stateVersion: failedResult.stateVersion + 1,
    replayed: false
});
const failedRetryFingerprint = sha256Text(JSON.stringify({
    operation: 'processing-retry',
    processingRunId: failedRun.processingRunId,
    ...failedRetryInput
}));
assert.deepEqual({ ...sqlite.prepare(`
    SELECT payload_fingerprint AS payloadFingerprint,
           from_state AS fromState, to_state AS toState,
           expected_state_version AS expectedStateVersion,
           result_state_version AS resultStateVersion
    FROM draft_transition_receipts
    WHERE draft_id = ? AND idempotency_key = ?
`).get(failedDraft.draftId, failedRetryInput.idempotencyKey) }, {
    payloadFingerprint: failedRetryFingerprint,
    fromState: 'processing-failed',
    toState: 'approved-for-processing',
    expectedStateVersion: failedRetryInput.expectedStateVersion,
    resultStateVersion: failedRetry.stateVersion
});
assert.equal(sqlite.prepare(
    'SELECT processing_diagnostics_json AS diagnostics FROM gallery_drafts ' +
    'WHERE draft_id = ?'
).get(failedDraft.draftId).diagnostics, null);
assert.deepEqual({ ...sqlite.prepare(`
    SELECT event_type AS eventType,
           subject_reference_hash AS subjectReferenceHash,
           actor_identity_hash AS actorIdentityHash,
           state_version AS stateVersion, payload_hash AS payloadHash
    FROM gallery_audit_events
    WHERE event_type = 'processing-retry-approved'
      AND subject_reference_hash = ?
`).get(sha256Text(`draft:${failedDraft.draftId}`)) }, {
    eventType: 'processing-retry-approved',
    subjectReferenceHash: sha256Text(`draft:${failedDraft.draftId}`),
    actorIdentityHash: sha256Text(`subject:${processorSubject}`),
    stateVersion: failedRetry.stateVersion,
    payloadHash: failedRetryFingerprint
});

const retryReceiptCount = sqlite.prepare(
    "SELECT COUNT(*) AS count FROM draft_transition_receipts " +
    "WHERE draft_id = ? AND from_state = 'processing-failed' " +
    "AND to_state = 'approved-for-processing'"
).get(failedDraft.draftId).count;
const retryAuditCount = sqlite.prepare(
    "SELECT COUNT(*) AS count FROM gallery_audit_events " +
    "WHERE event_type = 'processing-retry-approved'"
).get().count;
const failedRetryReplayResponse = await retryRun(
    failedRun.processingRunId,
    failedRetryInput.expectedStateVersion,
    failedRetryInput.idempotencyKey
);
assert.equal(failedRetryReplayResponse.status, 200);
assert.deepEqual(await failedRetryReplayResponse.json(), {
    ...failedRetry,
    replayed: true
});
const rotatedProcessorSubject = 'fedcba9876543210fedcba9876543210.access';
const rotatedIdentityReplayResponse = await processorRequest(
    `/api/service/processing-runs/${failedRun.processingRunId}/retry`,
    {
        method: 'POST',
        identity: { type: 'service', subject: rotatedProcessorSubject },
        env: {
            ...processingEnv,
            PROCESSOR_IDENTITIES: `subject:${rotatedProcessorSubject}`
        },
        json: failedRetryInput
    }
);
assert.equal(rotatedIdentityReplayResponse.status, 200);
assert.deepEqual(await rotatedIdentityReplayResponse.json(), {
    ...failedRetry,
    replayed: true
});
assert.equal((await retryRun(
    failedRun.processingRunId,
    failedRetryInput.expectedStateVersion + 1,
    failedRetryInput.idempotencyKey
)).status, 409);
assert.equal((await retryRun(
    failedRun.processingRunId,
    failedRetryInput.expectedStateVersion,
    'phase-d-failed-retry-different-key'
)).status, 409);
assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM draft_transition_receipts " +
    "WHERE draft_id = ? AND from_state = 'processing-failed' " +
    "AND to_state = 'approved-for-processing'"
).get(failedDraft.draftId).count, retryReceiptCount);
assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM gallery_audit_events " +
    "WHERE event_type = 'processing-retry-approved'"
).get().count, retryAuditCount);

const concurrentRetry = await createFailedCleanedProcessingRun('retry-cas-race');
let concurrentRetryWinner;
d1.beforeNextBatch = async () => {
    const response = await retryRun(
        concurrentRetry.run.processingRunId,
        concurrentRetry.failed.stateVersion,
        'phase-d-retry-cas-race-winner'
    );
    assert.equal(response.status, 200, await response.clone().text());
    concurrentRetryWinner = await response.json();
};
const concurrentRetryLoser = await retryRun(
    concurrentRetry.run.processingRunId,
    concurrentRetry.failed.stateVersion,
    'phase-d-retry-cas-race-loser'
);
assert.equal(concurrentRetryLoser.status, 409);
assert.equal(concurrentRetryWinner.replayed, false);
assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM draft_transition_receipts " +
    "WHERE draft_id = ? AND from_state = 'processing-failed' " +
    "AND to_state = 'approved-for-processing'"
).get(concurrentRetry.draft.draftId).count, 1);
assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM gallery_audit_events " +
    "WHERE event_type = 'processing-retry-approved' " +
    "AND subject_reference_hash = ?"
).get(sha256Text(`draft:${concurrentRetry.draft.draftId}`)).count, 1);
assert.equal(sqlite.prepare(
    'SELECT processing_diagnostics_json AS diagnostics FROM gallery_drafts ' +
    'WHERE draft_id = ?'
).get(concurrentRetry.draft.draftId).diagnostics, null);

// Receipt and audit insertion are part of the same transaction as the draft
// CAS. Either evidence write failing rolls back the state and diagnostics too.
const receiptFailureRetry = await createFailedCleanedProcessingRun(
    'retry-receipt-failure'
);
d1.failNextRunContaining = 'INSERT INTO draft_transition_receipts';
assert.equal((await retryRun(
    receiptFailureRetry.run.processingRunId,
    receiptFailureRetry.failed.stateVersion,
    'phase-d-retry-receipt-failure'
)).status, 503);
assert.equal(sqlite.prepare(
    'SELECT state FROM gallery_drafts WHERE draft_id = ?'
).get(receiptFailureRetry.draft.draftId).state, 'processing-failed');
assert.notEqual(sqlite.prepare(
    'SELECT processing_diagnostics_json AS diagnostics FROM gallery_drafts ' +
    'WHERE draft_id = ?'
).get(receiptFailureRetry.draft.draftId).diagnostics, null);
assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM draft_transition_receipts " +
    "WHERE draft_id = ? AND from_state = 'processing-failed'"
).get(receiptFailureRetry.draft.draftId).count, 0);
assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM gallery_audit_events " +
    "WHERE event_type = 'processing-retry-approved' " +
    'AND subject_reference_hash = ?'
).get(sha256Text(`draft:${receiptFailureRetry.draft.draftId}`)).count, 0);

const auditFailureRetry = await createFailedCleanedProcessingRun(
    'retry-audit-failure'
);
d1.failNextRunContaining = 'INSERT INTO gallery_audit_events';
assert.equal((await retryRun(
    auditFailureRetry.run.processingRunId,
    auditFailureRetry.failed.stateVersion,
    'phase-d-retry-audit-failure'
)).status, 503);
assert.equal(sqlite.prepare(
    'SELECT state FROM gallery_drafts WHERE draft_id = ?'
).get(auditFailureRetry.draft.draftId).state, 'processing-failed');
assert.notEqual(sqlite.prepare(
    'SELECT processing_diagnostics_json AS diagnostics FROM gallery_drafts ' +
    'WHERE draft_id = ?'
).get(auditFailureRetry.draft.draftId).diagnostics, null);
assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM draft_transition_receipts " +
    "WHERE draft_id = ? AND from_state = 'processing-failed'"
).get(auditFailureRetry.draft.draftId).count, 0);
assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM gallery_audit_events " +
    "WHERE event_type = 'processing-retry-approved' " +
    'AND subject_reference_hash = ?'
).get(sha256Text(`draft:${auditFailureRetry.draft.draftId}`)).count, 0);

// Cloudflare's result metadata is observability data, not transition proof.
// The durable receipt and exact audit tuple remain authoritative when a
// provider reports cumulative-looking changes or omits that optional field.
for (const batchMetaMode of ['cumulative', 'omitted']) {
    const metadataRetry = await createFailedCleanedProcessingRun(
        `retry-${batchMetaMode}-metadata`
    );
    d1.batchMetaMode = batchMetaMode;
    let metadataRetryResponse;
    try {
        metadataRetryResponse = await retryRun(
            metadataRetry.run.processingRunId,
            metadataRetry.failed.stateVersion,
            `phase-d-retry-${batchMetaMode}-metadata`
        );
    } finally {
        d1.batchMetaMode = 'statement';
    }
    assert.equal(
        metadataRetryResponse.status,
        200,
        await metadataRetryResponse.clone().text()
    );
    assert.equal((await metadataRetryResponse.json()).replayed, false);
    assert.equal(sqlite.prepare(
        "SELECT COUNT(*) AS count FROM draft_transition_receipts " +
        "WHERE draft_id = ? AND expected_state_version = ?"
    ).get(
        metadataRetry.draft.draftId,
        metadataRetry.failed.stateVersion
    ).count, 1);
}

// If D1 commits the complete batch but its response is lost, the immutable
// receipt and exact audit tuple are the operation result. Recovery must report
// an exact replay rather than claiming the committed transition failed.
const lostResponseRetry = await createFailedCleanedProcessingRun(
    'retry-lost-batch-response'
);
d1.failAfterNextBatch = true;
const lostResponseRetryResult = await retryRun(
    lostResponseRetry.run.processingRunId,
    lostResponseRetry.failed.stateVersion,
    'phase-d-retry-lost-response'
);
assert.equal(lostResponseRetryResult.status, 200);
assert.deepEqual(await lostResponseRetryResult.json(), {
    schemaVersion: '1.0',
    processingRunId: lostResponseRetry.run.processingRunId,
    state: 'approved-for-processing',
    stateVersion: lostResponseRetry.failed.stateVersion + 1,
    replayed: true
});
assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM draft_transition_receipts " +
    "WHERE draft_id = ? AND from_state = 'processing-failed'"
).get(lostResponseRetry.draft.draftId).count, 1);
assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM gallery_audit_events " +
    "WHERE event_type = 'processing-retry-approved' " +
    'AND subject_reference_hash = ?'
).get(sha256Text(`draft:${lostResponseRetry.draft.draftId}`)).count, 1);

// The current caller is authenticated before the service runs, but an exact
// replay proves the historical operation from its immutable receipt and audit
// tuple. Ambiguous duplicate historical audit evidence must fail closed.
const duplicateAuditRetry = await createFailedCleanedProcessingRun(
    'retry-duplicate-audit-proof'
);
const duplicateAuditInput = {
    expectedStateVersion: duplicateAuditRetry.failed.stateVersion,
    idempotencyKey: 'phase-d-retry-duplicate-audit-proof'
};
const duplicateAuditFirst = await retryRun(
    duplicateAuditRetry.run.processingRunId,
    duplicateAuditInput.expectedStateVersion,
    duplicateAuditInput.idempotencyKey
);
assert.equal(duplicateAuditFirst.status, 200);
const duplicateAuditSubjectHash = sha256Text(
    `draft:${duplicateAuditRetry.draft.draftId}`
);
const duplicateAuditRow = sqlite.prepare(`
    SELECT subject_reference_hash, event_type, state_version,
           actor_identity_hash, payload_hash, occurred_at
    FROM gallery_audit_events
    WHERE event_type = 'processing-retry-approved'
      AND subject_reference_hash = ?
`).get(duplicateAuditSubjectHash);
sqlite.prepare(`
    INSERT INTO gallery_audit_events (
        audit_event_id, subject_reference_hash, event_type, state_version,
        actor_identity_hash, payload_hash, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(
    'audit_duplicate_retry_proof',
    duplicateAuditRow.subject_reference_hash,
    duplicateAuditRow.event_type,
    duplicateAuditRow.state_version,
    duplicateAuditRow.actor_identity_hash,
    duplicateAuditRow.payload_hash,
    duplicateAuditRow.occurred_at
);
const ambiguousAuditReplay = await retryRun(
    duplicateAuditRetry.run.processingRunId,
    duplicateAuditInput.expectedStateVersion,
    duplicateAuditInput.idempotencyKey
);
assert.equal(ambiguousAuditReplay.status, 503);

const failedRetryRunResponse = await processorRequest(
    `/api/service/drafts/${failedDraft.draftId}/processing-runs`,
    {
        method: 'POST',
        identity: processorIdentity(),
        json: {
            expectedStateVersion: failedRetry.stateVersion,
            idempotencyKey: 'phase-d-failed-cleaned-retry-start'
        }
    }
);
assert.equal(failedRetryRunResponse.status, 201, await failedRetryRunResponse.clone().text());
const failedRetryRun = await failedRetryRunResponse.json();
assert.notEqual(failedRetryRun.processingRunId, failedRun.processingRunId);
const replayAfterReplacementStart = await retryRun(
    failedRun.processingRunId,
    failedRetryInput.expectedStateVersion,
    failedRetryInput.idempotencyKey
);
assert.equal(replayAfterReplacementStart.status, 200);
assert.deepEqual(await replayAfterReplacementStart.json(), {
    ...failedRetry,
    replayed: true
});
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM draft_processing_runs WHERE draft_id = ?'
).get(failedDraft.draftId).count, 2);
assert.equal(sqlite.prepare(
    'SELECT status FROM draft_processing_runs WHERE processing_run_id = ?'
).get(failedRun.processingRunId).status, 'failed');
assert.equal(sqlite.prepare(
    'SELECT status FROM draft_processing_cleanups WHERE processing_run_id = ?'
).get(failedRun.processingRunId).status, 'cleaned');
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM gallery_processing_cleanup_tombstones ' +
    'WHERE processing_run_id_hash = ?'
).get(sha256Text(failedRun.processingRunId)).count, 1);
insertPendingExclusion(sqlite, selectedResult.athleteId, catalog.suppressionRevision);
const replayAfterLaterExclusion = await retryRun(
    failedRun.processingRunId,
    failedRetryInput.expectedStateVersion,
    failedRetryInput.idempotencyKey
);
assert.equal(replayAfterLaterExclusion.status, 200);
assert.deepEqual(await replayAfterLaterExclusion.json(), {
    ...failedRetry,
    replayed: true
});
const failedRetryCleanupResponse = await cleanupRun(
    failedRetryRun.processingRunId,
    failedRetryRun.stateVersion,
    'phase-d-failed-retry-exclusion-cleanup'
);
assert.equal(
    failedRetryCleanupResponse.status,
    201,
    await failedRetryCleanupResponse.clone().text()
);
assert.equal((await failedRetryCleanupResponse.json()).cleanupReason, 'athlete-exclusion');
resolveAndRemoveSyntheticExclusion();

// Consent withdrawal with no admitted output remains possible. Cleanup proves
// that the service-derived run prefix is empty before leaving its durable
// closure; exact host/private deletion evidence is still a separate step.
const noOutputDraft = await createApprovedSyntheticPhotoDraft(
    'synthetic-phase-d-no-output-withdrawal',
    'no-output-withdrawal'
);
const noOutputRunStart = await processorRequest(
    `/api/service/drafts/${noOutputDraft.draftId}/processing-runs`,
    {
        method: 'POST',
        identity: processorIdentity(),
        json: {
            expectedStateVersion: noOutputDraft.stateVersion,
            idempotencyKey: 'phase-d-no-output-run-start'
        }
    }
);
assert.equal(noOutputRunStart.status, 201, await noOutputRunStart.clone().text());
const noOutputRun = await noOutputRunStart.json();
const noOutputWithdrawalVersion = transitionDraftDirect(
    sqlite,
    noOutputDraft.draftId,
    'withdrawal-pending'
);
const noOutputCleanupResponse = await cleanupRun(
    noOutputRun.processingRunId,
    noOutputWithdrawalVersion,
    'phase-d-no-output-withdrawal-cleanup'
);
assert.equal(noOutputCleanupResponse.status, 201, await noOutputCleanupResponse.clone().text());
assert.equal((await noOutputCleanupResponse.json()).cleanupReason, 'withdrawal');
assert.equal(
    staging.calls.some(call =>
        call.operation === 'list' &&
        call.prefix.includes(`/${noOutputRun.processingRunId}/`)
    ),
    true
);
markPrivateOriginalDeleted(sqlite, noOutputDraft.draftId);
insertDeletionPublication(sqlite, noOutputDraft.draftId);
withdrawActiveConsent(sqlite, noOutputDraft.draftId);
assert.equal(sqlite.prepare(
    'SELECT active_consent_revision AS revision FROM gallery_drafts WHERE draft_id = ?'
).get(noOutputDraft.draftId).revision, null);
transitionDraftDirect(sqlite, noOutputDraft.draftId, 'withdrawn');
insertConsentRetentionTombstone(sqlite, noOutputDraft.draftId);
sqlite.prepare('DELETE FROM gallery_drafts WHERE draft_id = ?').run(noOutputDraft.draftId);
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM draft_processing_runs WHERE processing_run_id = ?'
).get(noOutputRun.processingRunId).count, 0);
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM gallery_processing_cleanup_tombstones ' +
    'WHERE processing_run_id_hash = ?'
).get(sha256Text(noOutputRun.processingRunId)).count, 1);

// Prefix absence also catches an object unknown to D1. The service does not
// guess ownership, delete it, or report success; the closure blocks later
// writes until an operator can reconcile the unexpected private object.
const unknownPrefixDraft = await createApprovedSyntheticPhotoDraft(
    'synthetic-phase-d-unknown-prefix-object',
    'unknown-prefix-object'
);
const unknownPrefixRunResponse = await processorRequest(
    `/api/service/drafts/${unknownPrefixDraft.draftId}/processing-runs`,
    {
        method: 'POST',
        identity: processorIdentity(),
        json: {
            expectedStateVersion: unknownPrefixDraft.stateVersion,
            idempotencyKey: 'phase-d-unknown-prefix-start'
        }
    }
);
assert.equal(
    unknownPrefixRunResponse.status,
    201,
    await unknownPrefixRunResponse.clone().text()
);
const unknownPrefixRun = await unknownPrefixRunResponse.json();
const unknownPrefixVersion = transitionDraftDirect(
    sqlite,
    unknownPrefixDraft.draftId,
    'withdrawal-pending'
);
const unrecordedRunPrefixKey =
    `derivative-staging/v1/family/${unknownPrefixDraft.draftId}/` +
    `${unknownPrefixRun.processingRunId}/${'f'.repeat(64)}/display.webp`;
const unrecordedRunPrefixBytes = thumbnailBytes.slice();
staging.seedObject(unrecordedRunPrefixKey, unrecordedRunPrefixBytes, {
    customMetadata: {
        contract: 'gallery-private-staging-v1',
        role: 'photo-display'
    }
});
const unknownPrefixCleanup = await cleanupRun(
    unknownPrefixRun.processingRunId,
    unknownPrefixVersion,
    'phase-d-unknown-prefix-cleanup'
);
assert.equal(unknownPrefixCleanup.status, 503);
assert.deepEqual(staging.objects.get(unrecordedRunPrefixKey).bytes, unrecordedRunPrefixBytes);
assert.equal((await uploadDerivative(
    unknownPrefixRun.processingRunId,
    display,
    displayBytes,
    'phase-d-unknown-prefix-after-closure'
)).status, 409);

// Prefix absence is proved across a bounded, well-formed pagination chain.
// One empty truncated page is not enough; a distinct cursor and a final
// non-truncated empty page are both required.
const validPagination = await createWithdrawalCleanupCase('valid-empty-pagination');
staging.scriptedListResponses = [
    { objects: [], truncated: true, cursor: 'valid-cursor-1' },
    { objects: [], truncated: false }
];
const validPaginationCallsBefore = staging.calls.length;
const validPaginationCleanup = await cleanupRun(
    validPagination.run.processingRunId,
    validPagination.withdrawalStateVersion,
    'phase-d-valid-empty-pagination-cleanup'
);
assert.equal(validPaginationCleanup.status, 201, await validPaginationCleanup.clone().text());
assert.deepEqual(
    staging.calls.slice(validPaginationCallsBefore)
        .filter(call => call.operation === 'list')
        .map(call => call.cursor),
    [null, 'valid-cursor-1']
);

await assertPrefixListingFailsClosed(
    'missing-prefix-cursor',
    [{ objects: [], truncated: true }]
);
await assertPrefixListingFailsClosed(
    'invalid-prefix-cursor',
    [{ objects: [], truncated: true, cursor: 42 }]
);
await assertPrefixListingFailsClosed(
    'malformed-prefix-page',
    [
        { objects: [], truncated: true, cursor: 'malformed-next-page' },
        { objects: 'not-an-array', truncated: false }
    ]
);
await assertPrefixListingFailsClosed(
    'repeated-prefix-cursor',
    [
        { objects: [], truncated: true, cursor: 'repeated-cursor' },
        { objects: [], truncated: true, cursor: 'repeated-cursor' }
    ]
);
await assertPrefixListingFailsClosed(
    'excessive-prefix-pages',
    Array.from({ length: 257 }, (_, index) => ({
        objects: [],
        truncated: true,
        cursor: `excessive-cursor-${index}`
    }))
);

// Partial failed processing proves retryable deletion. The first delete takes
// effect but its synthetic provider response is lost. D1 remains closed; the
// exact retry proves absence, then the separate consent workflow can continue.
const partialDraft = await createApprovedSyntheticPhotoDraft(
    'synthetic-phase-d-partial-output',
    'partial-output'
);
const partialRunStart = await processorRequest(
    `/api/service/drafts/${partialDraft.draftId}/processing-runs`,
    {
        method: 'POST',
        identity: processorIdentity(),
        json: {
            expectedStateVersion: partialDraft.stateVersion,
            idempotencyKey: 'phase-d-partial-run-start'
        }
    }
);
assert.equal(partialRunStart.status, 201, await partialRunStart.clone().text());
const partialRun = await partialRunStart.json();
const partialDisplay = await uploadDerivative(
    partialRun.processingRunId,
    display,
    displayBytes,
    'phase-d-partial-display-output'
);
assert.equal(partialDisplay.status, 201, await partialDisplay.clone().text());
const partialFailure = await processorRequest(
    `/api/service/processing-runs/${partialRun.processingRunId}/result`,
    {
        method: 'POST',
        identity: processorIdentity(),
        json: {
            outcome: 'failed',
            expectedStateVersion: partialRun.stateVersion,
            idempotencyKey: 'phase-d-partial-result-failed',
            errorCode: 'processing-failed'
        }
    }
);
assert.equal(partialFailure.status, 200, await partialFailure.clone().text());
const partialFailedBody = await partialFailure.json();
staging.failAfterNextDelete = true;
const partialCleanupInterrupted = await cleanupRun(
    partialRun.processingRunId,
    partialFailedBody.stateVersion,
    'phase-d-partial-output-cleanup'
);
assert.equal(partialCleanupInterrupted.status, 503);
const partialStagingKey = buildV1StagingDerivativeKey({
    site: 'family',
    draftId: partialDraft.draftId,
    processingRunId: partialRun.processingRunId,
    sha256: display.sha256,
    role: 'photo-display'
});
assert.equal(staging.objects.has(partialStagingKey), false);
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM draft_processing_outputs ' +
    'WHERE processing_run_id = ?'
).get(partialRun.processingRunId).count, 1);
assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM draft_processing_cleanup_objects AS object
    JOIN draft_processing_cleanups AS cleanup ON cleanup.cleanup_id = object.cleanup_id
    WHERE cleanup.processing_run_id = ?
      AND object.status = 'pending'
      AND object.staging_object_key IS NOT NULL
`).get(partialRun.processingRunId).count, 1);
const partialRetryBeforeCleanup = await retryRun(
    partialRun.processingRunId,
    partialFailedBody.stateVersion,
    'phase-d-partial-retry-before-cleanup'
);
assert.equal(partialRetryBeforeCleanup.status, 409);
assert.equal(sqlite.prepare(
    'SELECT state FROM gallery_drafts WHERE draft_id = ?'
).get(partialDraft.draftId).state, 'processing-failed');
assert.notEqual(sqlite.prepare(
    'SELECT processing_diagnostics_json AS diagnostics FROM gallery_drafts ' +
    'WHERE draft_id = ?'
).get(partialDraft.draftId).diagnostics, null);
assert.equal((await uploadDerivative(
    partialRun.processingRunId,
    display,
    displayBytes,
    'phase-d-partial-after-closure'
)).status, 409);
const partialCleanupResponse = await cleanupRun(
    partialRun.processingRunId,
    partialFailedBody.stateVersion,
    'phase-d-partial-output-cleanup'
);
assert.equal(partialCleanupResponse.status, 200, await partialCleanupResponse.clone().text());
assert.deepEqual(await partialCleanupResponse.json(), {
    processingRunId: partialRun.processingRunId,
    cleanupReason: 'processing-failed',
    status: 'cleaned',
    replayed: true
});
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM draft_processing_outputs WHERE processing_run_id = ?'
).get(partialRun.processingRunId).count, 0);
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM draft_processing_multipart_uploads WHERE processing_run_id = ?'
).get(partialRun.processingRunId).count, 0);
transitionDraftDirect(sqlite, partialDraft.draftId, 'withdrawal-pending');
markPrivateOriginalDeleted(sqlite, partialDraft.draftId);
insertDeletionPublication(sqlite, partialDraft.draftId);
withdrawActiveConsent(sqlite, partialDraft.draftId);
assert.equal(sqlite.prepare(
    'SELECT active_consent_revision AS revision FROM gallery_drafts WHERE draft_id = ?'
).get(partialDraft.draftId).revision, null);
transitionDraftDirect(sqlite, partialDraft.draftId, 'withdrawn');
insertConsentRetentionTombstone(sqlite, partialDraft.draftId);
sqlite.prepare('DELETE FROM gallery_drafts WHERE draft_id = ?').run(partialDraft.draftId);
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM draft_processing_runs WHERE processing_run_id = ?'
).get(partialRun.processingRunId).count, 0);

// Cleanup can land after R2 creates a multipart handle but before D1 admits
// that handle. The losing upload is still empty, receives no part, is aborted
// by the original request, and cannot later complete or create an object.
const createAdmissionRace = await createSyntheticProcessingRun('create-admission-race');
let createAdmissionCleanup;
staging.afterNextCreate = async () => {
    insertPendingExclusion(sqlite, selectedResult.athleteId, catalog.suppressionRevision);
    createAdmissionCleanup = await cleanupRun(
        createAdmissionRace.run.processingRunId,
        createAdmissionRace.run.stateVersion,
        'phase-d-create-admission-cleanup'
    );
};
const createAdmissionUpload = await uploadDerivative(
    createAdmissionRace.run.processingRunId,
    display,
    displayBytes,
    'phase-d-create-admission-output'
);
assert.ok([409, 503].includes(createAdmissionUpload.status));
assert.equal(createAdmissionCleanup.status, 201, await createAdmissionCleanup.clone().text());
assert.equal((await createAdmissionCleanup.json()).cleanupReason, 'athlete-exclusion');
const createAdmissionCall = staging.calls.find(call =>
    call.operation === 'createMultipartUpload' &&
    call.key.includes(`/${createAdmissionRace.run.processingRunId}/`)
);
assert.ok(createAdmissionCall);
assert.equal(staging.calls.some(call =>
    call.operation === 'uploadPart' && call.uploadId === createAdmissionCall.uploadId
), false);
assert.equal(staging.calls.some(call =>
    call.operation === 'abort' && call.uploadId === createAdmissionCall.uploadId
), true);
assert.equal(staging.uploads.has(createAdmissionCall.uploadId), false);
assert.equal(staging.objects.has(createAdmissionCall.key), false);
assert.throws(
    () => staging.resumeMultipartUpload(
        createAdmissionCall.key,
        createAdmissionCall.uploadId
    ),
    error => error?.name === 'NoSuchUpload' && error?.code === 10024
);
await assert.rejects(
    () => staging.handles.get(createAdmissionCall.uploadId)
        .uploadPart(1, displayBytes),
    error => error?.name === 'NoSuchUpload' && error?.code === 10024
);
assert.equal(await staging.head(createAdmissionCall.key), null);
resolveAndRemoveSyntheticExclusion();

// Cleanup can also close an already-admitted open handle immediately before
// the first part call. Abort wins, so no media bytes reach the provider and no
// stale upload call can later write them.
const beforePartRace = await createSyntheticProcessingRun('before-part-race');
let beforePartCleanup;
staging.beforeNextUploadPart = async () => {
    insertPendingExclusion(sqlite, selectedResult.athleteId, catalog.suppressionRevision);
    beforePartCleanup = await cleanupRun(
        beforePartRace.run.processingRunId,
        beforePartRace.run.stateVersion,
        'phase-d-before-part-cleanup'
    );
};
const beforePartUpload = await uploadDerivative(
    beforePartRace.run.processingRunId,
    display,
    displayBytes,
    'phase-d-before-part-output'
);
assert.ok([409, 503].includes(beforePartUpload.status));
assert.equal(beforePartCleanup.status, 201, await beforePartCleanup.clone().text());
const beforePartCreate = staging.calls.find(call =>
    call.operation === 'createMultipartUpload' &&
    call.key.includes(`/${beforePartRace.run.processingRunId}/`)
);
assert.ok(beforePartCreate);
assert.equal(staging.calls.some(call =>
    call.operation === 'uploadPart' && call.uploadId === beforePartCreate.uploadId
), false);
assert.equal(staging.objects.has(beforePartCreate.key), false);
assert.equal(await staging.head(beforePartCreate.key), null);
resolveAndRemoveSyntheticExclusion();

// If the part operation takes effect just before cleanup but D1 has not yet
// recorded its ETag, abort is still terminal. Exactly one part call occurred,
// no completion occurred, and the bytes never become an R2 object.
const afterPartRace = await createSyntheticProcessingRun('after-part-race');
let afterPartCleanup;
staging.afterNextUploadPart = async () => {
    insertPendingExclusion(sqlite, selectedResult.athleteId, catalog.suppressionRevision);
    afterPartCleanup = await cleanupRun(
        afterPartRace.run.processingRunId,
        afterPartRace.run.stateVersion,
        'phase-d-after-part-cleanup'
    );
};
const afterPartUpload = await uploadDerivative(
    afterPartRace.run.processingRunId,
    display,
    displayBytes,
    'phase-d-after-part-output'
);
assert.ok([409, 503].includes(afterPartUpload.status));
assert.equal(afterPartCleanup.status, 201, await afterPartCleanup.clone().text());
const afterPartCreate = staging.calls.find(call =>
    call.operation === 'createMultipartUpload' &&
    call.key.includes(`/${afterPartRace.run.processingRunId}/`)
);
assert.ok(afterPartCreate);
assert.equal(staging.calls.filter(call =>
    call.operation === 'uploadPart' && call.uploadId === afterPartCreate.uploadId
).length, 1);
assert.equal(staging.calls.some(call =>
    call.operation === 'complete' && call.uploadId === afterPartCreate.uploadId
), false);
assert.equal(staging.objects.has(afterPartCreate.key), false);
assert.equal(await staging.head(afterPartCreate.key), null);
resolveAndRemoveSyntheticExclusion();

// A lost uploadPart response is an exact retry, not a new handle or overwrite.
// The same persisted ID receives the same part number and digest twice, then
// completes once; cleanup later removes that exact object normally.
const lostPartRace = await createSyntheticProcessingRun('lost-part-response');
staging.failAfterNextUploadPart = true;
const lostPartFirst = await uploadDerivative(
    lostPartRace.run.processingRunId,
    display,
    displayBytes,
    'phase-d-lost-part-output'
);
assert.equal(lostPartFirst.status, 503);
const lostPartCreate = staging.calls.find(call =>
    call.operation === 'createMultipartUpload' &&
    call.key.includes(`/${lostPartRace.run.processingRunId}/`)
);
assert.ok(lostPartCreate);
assert.equal(staging.calls.filter(call =>
    call.operation === 'uploadPart' && call.uploadId === lostPartCreate.uploadId
).length, 1);
const lostPartRetry = await uploadDerivative(
    lostPartRace.run.processingRunId,
    display,
    displayBytes,
    'phase-d-lost-part-output'
);
assert.equal(lostPartRetry.status, 201, await lostPartRetry.clone().text());
assert.equal(staging.calls.filter(call =>
    call.operation === 'createMultipartUpload' &&
    call.key.includes(`/${lostPartRace.run.processingRunId}/`)
).length, 1);
const lostPartCalls = staging.calls.filter(call =>
    call.operation === 'uploadPart' && call.uploadId === lostPartCreate.uploadId
);
assert.equal(lostPartCalls.length, 2);
assert.match(lostPartCalls[0].etag, /^staging-part-/);
assert.deepEqual(
    lostPartCalls.map(call => ({ partNumber: call.partNumber, etag: call.etag })),
    [
        { partNumber: 1, etag: lostPartCalls[0].etag },
        { partNumber: 1, etag: lostPartCalls[0].etag }
    ]
);
assert.equal(staging.calls.filter(call =>
    call.operation === 'complete' && call.uploadId === lostPartCreate.uploadId
).length, 1);
assert.equal(staging.overwriteAttempts, 0);
const lostPartFailure = await failSyntheticProcessingRun(
    lostPartRace.run,
    'lost-part-response'
);
const lostPartCleanup = await cleanupRun(
    lostPartRace.run.processingRunId,
    lostPartFailure.stateVersion,
    'phase-d-lost-part-cleanup'
);
assert.equal(lostPartCleanup.status, 201, await lostPartCleanup.clone().text());
assert.equal(staging.objects.has(lostPartCreate.key), false);

// If the final D1 transaction fails after R2 absence is already durable, the
// object stays absent while D1 retains the deleting ledger. The exact retry
// creates one tombstone and one audit event—never duplicates either.
const finalBatchRace = await createSyntheticProcessingRun('final-cleanup-batch');
const finalBatchUpload = await uploadDerivative(
    finalBatchRace.run.processingRunId,
    display,
    displayBytes,
    'phase-d-final-cleanup-batch-output'
);
assert.equal(finalBatchUpload.status, 201, await finalBatchUpload.clone().text());
const finalBatchFailure = await failSyntheticProcessingRun(
    finalBatchRace.run,
    'final-cleanup-batch'
);
const finalBatchKey = buildV1StagingDerivativeKey({
    site: 'family',
    draftId: finalBatchRace.draft.draftId,
    processingRunId: finalBatchRace.run.processingRunId,
    sha256: display.sha256,
    role: 'photo-display'
});
const cleanupAuditCountBeforeFinalBatch = sqlite.prepare(
    "SELECT COUNT(*) AS count FROM gallery_audit_events " +
    "WHERE event_type = 'processing-staging-cleaned'"
).get().count;
staging.scriptedListResponses = [() => {
    d1.failNextRunContaining = 'INSERT INTO gallery_processing_cleanup_tombstones';
    return { objects: [], truncated: false };
}];
const finalBatchCleanupFirst = await cleanupRun(
    finalBatchRace.run.processingRunId,
    finalBatchFailure.stateVersion,
    'phase-d-final-cleanup-batch-cleanup'
);
assert.equal(finalBatchCleanupFirst.status, 503);
assert.equal(staging.objects.has(finalBatchKey), false);
assert.equal(sqlite.prepare(
    'SELECT status FROM draft_processing_cleanups WHERE processing_run_id = ?'
).get(finalBatchRace.run.processingRunId).status, 'deleting');
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM draft_processing_outputs WHERE processing_run_id = ?'
).get(finalBatchRace.run.processingRunId).count, 1);
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM gallery_processing_cleanup_tombstones ' +
    'WHERE processing_run_id_hash = ?'
).get(sha256Text(finalBatchRace.run.processingRunId)).count, 0);
assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM gallery_audit_events " +
    "WHERE event_type = 'processing-staging-cleaned'"
).get().count, cleanupAuditCountBeforeFinalBatch);
const finalBatchCleanupRetry = await cleanupRun(
    finalBatchRace.run.processingRunId,
    finalBatchFailure.stateVersion,
    'phase-d-final-cleanup-batch-cleanup'
);
assert.equal(finalBatchCleanupRetry.status, 200, await finalBatchCleanupRetry.clone().text());
assert.equal((await finalBatchCleanupRetry.json()).replayed, true);
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM draft_processing_outputs WHERE processing_run_id = ?'
).get(finalBatchRace.run.processingRunId).count, 0);
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM gallery_processing_cleanup_tombstones ' +
    'WHERE processing_run_id_hash = ?'
).get(sha256Text(finalBatchRace.run.processingRunId)).count, 1);
assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM gallery_audit_events " +
    "WHERE event_type = 'processing-staging-cleaned'"
).get().count, cleanupAuditCountBeforeFinalBatch + 1);
const finalBatchCleanupReplay = await cleanupRun(
    finalBatchRace.run.processingRunId,
    finalBatchFailure.stateVersion,
    'phase-d-final-cleanup-batch-cleanup'
);
assert.equal(finalBatchCleanupReplay.status, 200);
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM gallery_processing_cleanup_tombstones ' +
    'WHERE processing_run_id_hash = ?'
).get(sha256Text(finalBatchRace.run.processingRunId)).count, 1);
assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM gallery_audit_events " +
    "WHERE event_type = 'processing-staging-cleaned'"
).get().count, cleanupAuditCountBeforeFinalBatch + 1);

// The complementary lost-response window happens after the final D1 batch has
// committed. The service reads the committed cleaned state in the same call;
// an exact external retry is then a 200 replay with no duplicate evidence.
const committedBatchRace = await createSyntheticProcessingRun('committed-cleanup-response');
const committedBatchUpload = await uploadDerivative(
    committedBatchRace.run.processingRunId,
    display,
    displayBytes,
    'phase-d-committed-cleanup-output'
);
assert.equal(committedBatchUpload.status, 201, await committedBatchUpload.clone().text());
const committedBatchFailure = await failSyntheticProcessingRun(
    committedBatchRace.run,
    'committed-cleanup-response'
);
const committedBatchKey = buildV1StagingDerivativeKey({
    site: 'family',
    draftId: committedBatchRace.draft.draftId,
    processingRunId: committedBatchRace.run.processingRunId,
    sha256: display.sha256,
    role: 'photo-display'
});
const cleanupAuditCountBeforeCommittedBatch = sqlite.prepare(
    "SELECT COUNT(*) AS count FROM gallery_audit_events " +
    "WHERE event_type = 'processing-staging-cleaned'"
).get().count;
staging.scriptedListResponses = [() => {
    d1.failAfterNextBatch = true;
    return { objects: [], truncated: false };
}];
const committedBatchCleanup = await cleanupRun(
    committedBatchRace.run.processingRunId,
    committedBatchFailure.stateVersion,
    'phase-d-committed-cleanup-response'
);
assert.equal(committedBatchCleanup.status, 201, await committedBatchCleanup.clone().text());
assert.deepEqual(await committedBatchCleanup.json(), {
    processingRunId: committedBatchRace.run.processingRunId,
    cleanupReason: 'processing-failed',
    status: 'cleaned',
    replayed: false
});
assert.equal(staging.objects.has(committedBatchKey), false);
assert.equal(sqlite.prepare(
    'SELECT status FROM draft_processing_cleanups WHERE processing_run_id = ?'
).get(committedBatchRace.run.processingRunId).status, 'cleaned');
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM gallery_processing_cleanup_tombstones ' +
    'WHERE processing_run_id_hash = ?'
).get(sha256Text(committedBatchRace.run.processingRunId)).count, 1);
assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM gallery_audit_events " +
    "WHERE event_type = 'processing-staging-cleaned'"
).get().count, cleanupAuditCountBeforeCommittedBatch + 1);
const committedBatchReplay = await cleanupRun(
    committedBatchRace.run.processingRunId,
    committedBatchFailure.stateVersion,
    'phase-d-committed-cleanup-response'
);
assert.equal(committedBatchReplay.status, 200, await committedBatchReplay.clone().text());
assert.equal((await committedBatchReplay.json()).replayed, true);
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM gallery_processing_cleanup_tombstones ' +
    'WHERE processing_run_id_hash = ?'
).get(sha256Text(committedBatchRace.run.processingRunId)).count, 1);
assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM gallery_audit_events " +
    "WHERE event_type = 'processing-staging-cleaned'"
).get().count, cleanupAuditCountBeforeCommittedBatch + 1);

// Abort wins: exclusion arrives after part admission but before completion.
// Cleanup aborts the one exact persisted upload ID; the stale completion can
// never recreate the object after cleanup has reported success.
const abortWinsDraft = await createApprovedSyntheticPhotoDraft(
    'synthetic-phase-d-abort-wins',
    'abort-wins'
);
const abortWinsRunResponse = await processorRequest(
    `/api/service/drafts/${abortWinsDraft.draftId}/processing-runs`,
    {
        method: 'POST',
        identity: processorIdentity(),
        json: {
            expectedStateVersion: abortWinsDraft.stateVersion,
            idempotencyKey: 'phase-d-abort-wins-start'
        }
    }
);
assert.equal(abortWinsRunResponse.status, 201, await abortWinsRunResponse.clone().text());
const abortWinsRun = await abortWinsRunResponse.json();
let abortWinsCleanupResponse;
staging.beforeNextComplete = async () => {
    insertPendingExclusion(sqlite, selectedResult.athleteId, catalog.suppressionRevision);
    abortWinsCleanupResponse = await cleanupRun(
        abortWinsRun.processingRunId,
        abortWinsRun.stateVersion,
        'phase-d-abort-wins-cleanup'
    );
};
const abortWinsUpload = await uploadDerivative(
    abortWinsRun.processingRunId,
    display,
    displayBytes,
    'phase-d-abort-wins-output'
);
assert.ok([409, 503].includes(abortWinsUpload.status));
const abortWinsDiagnostic = {
    cleanup: sqlite.prepare(
        'SELECT status, cleanup_reason FROM draft_processing_cleanups WHERE processing_run_id = ?'
    ).get(abortWinsRun.processingRunId),
    outputs: sqlite.prepare(
        'SELECT role, status FROM draft_processing_outputs WHERE processing_run_id = ?'
    ).all(abortWinsRun.processingRunId),
    multiparts: sqlite.prepare(
        'SELECT role, status, terminal_kind FROM draft_processing_multipart_uploads ' +
        'WHERE processing_run_id = ?'
    ).all(abortWinsRun.processingRunId),
    cleanupObjects: sqlite.prepare(`
        SELECT object.role, object.status, object.provider_terminal_kind
        FROM draft_processing_cleanup_objects AS object
        JOIN draft_processing_cleanups AS cleanup ON cleanup.cleanup_id = object.cleanup_id
        WHERE cleanup.processing_run_id = ?
    `).all(abortWinsRun.processingRunId),
    calls: staging.calls.filter(call => call.key?.includes(`/${abortWinsRun.processingRunId}/`))
};
assert.equal(
    abortWinsCleanupResponse.status,
    201,
    `${await abortWinsCleanupResponse.clone().text()} ${JSON.stringify(abortWinsDiagnostic)}`
);
assert.equal((await abortWinsCleanupResponse.json()).cleanupReason, 'athlete-exclusion');
const abortWinsCreate = staging.calls.find(call =>
    call.operation === 'createMultipartUpload' &&
    call.key.includes(`/${abortWinsRun.processingRunId}/`)
);
assert.ok(abortWinsCreate);
assert.equal(staging.objects.has(abortWinsCreate.key), false);
assert.throws(
    () => staging.resumeMultipartUpload(abortWinsCreate.key, abortWinsCreate.uploadId),
    error => error?.name === 'NoSuchUpload' && error?.code === 10024
);
assert.equal(await staging.head(abortWinsCreate.key), null);
resolvePendingExclusion(sqlite, selectedResult.athleteId, catalog.suppressionRevision);
sqlite.prepare('DELETE FROM pending_athlete_exclusions WHERE athlete_id = ?')
    .run(selectedResult.athleteId);

// Complete wins: exclusion lands just after R2's terminal completion but
// before D1 can record it. The fake deliberately mirrors R2's observed edge
// case where resume+abort can still resolve after the object is already
// complete. Cleanup HEADs after that abort, recognizes the exact completed
// object, deletes it, verifies HEAD-null, and the old request cannot resurrect
// it.
const completeWinsDraft = await createApprovedSyntheticPhotoDraft(
    'synthetic-phase-d-complete-wins',
    'complete-wins'
);
const completeWinsRunResponse = await processorRequest(
    `/api/service/drafts/${completeWinsDraft.draftId}/processing-runs`,
    {
        method: 'POST',
        identity: processorIdentity(),
        json: {
            expectedStateVersion: completeWinsDraft.stateVersion,
            idempotencyKey: 'phase-d-complete-wins-start'
        }
    }
);
assert.equal(completeWinsRunResponse.status, 201, await completeWinsRunResponse.clone().text());
const completeWinsRun = await completeWinsRunResponse.json();
let completeWinsCleanupResponse;
staging.afterNextComplete = async ({ record, uploadId }) => {
    record.terminal = null;
    staging.uploads.set(uploadId, record);
    insertPendingExclusion(sqlite, selectedResult.athleteId, catalog.suppressionRevision);
    completeWinsCleanupResponse = await cleanupRun(
        completeWinsRun.processingRunId,
        completeWinsRun.stateVersion,
        'phase-d-complete-wins-cleanup'
    );
};
const completeWinsUpload = await uploadDerivative(
    completeWinsRun.processingRunId,
    display,
    displayBytes,
    'phase-d-complete-wins-output'
);
assert.ok([409, 503].includes(completeWinsUpload.status));
const completeWinsDiagnostic = {
    cleanup: sqlite.prepare(
        'SELECT status, cleanup_reason FROM draft_processing_cleanups WHERE processing_run_id = ?'
    ).get(completeWinsRun.processingRunId),
    outputs: sqlite.prepare(
        'SELECT role, status, staging_object_version, staging_etag ' +
        'FROM draft_processing_outputs WHERE processing_run_id = ?'
    ).all(completeWinsRun.processingRunId),
    multiparts: sqlite.prepare(
        'SELECT role, status, terminal_kind FROM draft_processing_multipart_uploads ' +
        'WHERE processing_run_id = ?'
    ).all(completeWinsRun.processingRunId),
    cleanupObjects: sqlite.prepare(`
        SELECT object.role, object.status, object.provider_terminal_kind,
               object.expected_object_version_hash, object.expected_etag_hash,
               object.observed_object_version_hash, object.observed_etag_hash,
               object.deleted_at, object.absence_verified_at
        FROM draft_processing_cleanup_objects AS object
        JOIN draft_processing_cleanups AS cleanup ON cleanup.cleanup_id = object.cleanup_id
        WHERE cleanup.processing_run_id = ?
    `).all(completeWinsRun.processingRunId),
    calls: staging.calls.filter(call =>
        call.key?.includes(`/${completeWinsRun.processingRunId}/`)
    )
};
assert.equal(
    completeWinsCleanupResponse.status,
    201,
    `${await completeWinsCleanupResponse.clone().text()} ${JSON.stringify(completeWinsDiagnostic)}`
);
assert.equal(completeWinsDiagnostic.cleanupObjects.length, 1);
assert.equal(completeWinsDiagnostic.cleanupObjects[0].status, 'absent');
assert.equal(completeWinsDiagnostic.cleanupObjects[0].provider_terminal_kind, 'completed');
assert.equal(typeof completeWinsDiagnostic.cleanupObjects[0].observed_object_version_hash, 'string');
assert.equal(typeof completeWinsDiagnostic.cleanupObjects[0].observed_etag_hash, 'string');
assert.equal(typeof completeWinsDiagnostic.cleanupObjects[0].deleted_at, 'string');
assert.equal(typeof completeWinsDiagnostic.cleanupObjects[0].absence_verified_at, 'string');
const completeWinsCreate = staging.calls.find(call =>
    call.operation === 'createMultipartUpload' &&
    call.key.includes(`/${completeWinsRun.processingRunId}/`)
);
assert.ok(completeWinsCreate);
assert.equal(staging.objects.has(completeWinsCreate.key), false);
assert.equal(await staging.head(completeWinsCreate.key), null);
assert.throws(
    () => staging.resumeMultipartUpload(
        completeWinsCreate.key,
        completeWinsCreate.uploadId
    ),
    error => error?.name === 'NoSuchUpload' && error?.code === 10024
);
resolvePendingExclusion(sqlite, selectedResult.athleteId, catalog.suppressionRevision);
sqlite.prepare('DELETE FROM pending_athlete_exclusions WHERE athlete_id = ?')
    .run(selectedResult.athleteId);

// A lost abort response is retryable. The provider has already made the upload
// terminal; the second cleanup learns NoSuchUpload by structured name/code,
// proves object absence, and converges on the same cleanup record.
const lostAbortDraft = await createApprovedSyntheticPhotoDraft(
    'synthetic-phase-d-lost-abort',
    'lost-abort'
);
const lostAbortRunResponse = await processorRequest(
    `/api/service/drafts/${lostAbortDraft.draftId}/processing-runs`,
    {
        method: 'POST',
        identity: processorIdentity(),
        json: {
            expectedStateVersion: lostAbortDraft.stateVersion,
            idempotencyKey: 'phase-d-lost-abort-start'
        }
    }
);
assert.equal(lostAbortRunResponse.status, 201, await lostAbortRunResponse.clone().text());
const lostAbortRun = await lostAbortRunResponse.json();
staging.beforeNextComplete = () => {
    throw providerError('SyntheticCompletionUnavailable', 19996);
};
const interruptedBeforeComplete = await uploadDerivative(
    lostAbortRun.processingRunId,
    display,
    displayBytes,
    'phase-d-lost-abort-output'
);
assert.equal(interruptedBeforeComplete.status, 503);
const lostAbortCreate = staging.calls.find(call =>
    call.operation === 'createMultipartUpload' &&
    call.key.includes(`/${lostAbortRun.processingRunId}/`)
);
assert.ok(lostAbortCreate);
assert.equal(staging.objects.has(lostAbortCreate.key), false);
insertPendingExclusion(sqlite, selectedResult.athleteId, catalog.suppressionRevision);
staging.failAfterNextAbort = true;
const lostAbortCleanupFirst = await cleanupRun(
    lostAbortRun.processingRunId,
    lostAbortRun.stateVersion,
    'phase-d-lost-abort-cleanup'
);
assert.equal(lostAbortCleanupFirst.status, 503);
const lostAbortCleanupRetry = await cleanupRun(
    lostAbortRun.processingRunId,
    lostAbortRun.stateVersion,
    'phase-d-lost-abort-cleanup'
);
assert.equal(lostAbortCleanupRetry.status, 200, await lostAbortCleanupRetry.clone().text());
const lostAbortCleanupBody = await lostAbortCleanupRetry.json();
assert.equal(lostAbortCleanupBody.cleanupReason, 'athlete-exclusion');
assert.equal(lostAbortCleanupBody.replayed, true);
assert.equal(staging.objects.has(lostAbortCreate.key), false);
resolvePendingExclusion(sqlite, selectedResult.athleteId, catalog.suppressionRevision);
sqlite.prepare('DELETE FROM pending_athlete_exclusions WHERE athlete_id = ?')
    .run(selectedResult.athleteId);

// Only Cloudflare's structured NoSuchUpload signal is terminal evidence.
// Message text alone, the right code with the wrong name, and the right name
// with the wrong code all fail closed; the exact retry still aborts safely.
await assertMalformedNoSuchUploadFailsClosed(
    'message-only-no-such-upload',
    new Error('NoSuchUpload')
);
await assertMalformedNoSuchUploadFailsClosed(
    'wrong-name-no-such-upload',
    providerError('ProviderFailure', 10024)
);
await assertMalformedNoSuchUploadFailsClosed(
    'wrong-code-no-such-upload',
    providerError('NoSuchUpload', 10023)
);

// If the create response itself is lost, no part has been admitted or sent.
// The exact retry creates and records a fresh ID; the unreachable provider ID
// contains zero media bytes and cannot complete without an uploaded part.
const lostCreateDraft = await createApprovedSyntheticPhotoDraft(
    'synthetic-phase-d-lost-create',
    'lost-create'
);
const lostCreateRunResponse = await processorRequest(
    `/api/service/drafts/${lostCreateDraft.draftId}/processing-runs`,
    {
        method: 'POST',
        identity: processorIdentity(),
        json: {
            expectedStateVersion: lostCreateDraft.stateVersion,
            idempotencyKey: 'phase-d-lost-create-start'
        }
    }
);
assert.equal(lostCreateRunResponse.status, 201, await lostCreateRunResponse.clone().text());
const lostCreateRun = await lostCreateRunResponse.json();
staging.failAfterNextCreate = true;
const lostCreateUploadFirst = await uploadDerivative(
    lostCreateRun.processingRunId,
    display,
    displayBytes,
    'phase-d-lost-create-output'
);
assert.equal(lostCreateUploadFirst.status, 503);
const lostCreateFirstCall = staging.calls.find(call =>
    call.operation === 'createMultipartUpload' &&
    call.key.includes(`/${lostCreateRun.processingRunId}/`)
);
assert.ok(lostCreateFirstCall);
assert.equal(staging.uploads.get(lostCreateFirstCall.uploadId)?.parts.size, 0);
assert.equal(staging.objects.has(lostCreateFirstCall.key), false);
const lostCreateUploadRetry = await uploadDerivative(
    lostCreateRun.processingRunId,
    display,
    displayBytes,
    'phase-d-lost-create-output'
);
assert.equal(lostCreateUploadRetry.status, 201, await lostCreateUploadRetry.clone().text());
assert.equal(staging.calls.filter(call =>
    call.operation === 'createMultipartUpload' &&
    call.key.includes(`/${lostCreateRun.processingRunId}/`)
).length, 2);
assert.equal(staging.uploads.get(lostCreateFirstCall.uploadId)?.parts.size, 0);
const lostCreateFailure = await processorRequest(
    `/api/service/processing-runs/${lostCreateRun.processingRunId}/result`,
    {
        method: 'POST',
        identity: processorIdentity(),
        json: {
            outcome: 'failed',
            expectedStateVersion: lostCreateRun.stateVersion,
            idempotencyKey: 'phase-d-lost-create-failure',
            errorCode: 'processing-failed'
        }
    }
);
assert.equal(lostCreateFailure.status, 200, await lostCreateFailure.clone().text());
const lostCreateFailureBody = await lostCreateFailure.json();
const lostCreateCleanup = await cleanupRun(
    lostCreateRun.processingRunId,
    lostCreateFailureBody.stateVersion,
    'phase-d-lost-create-cleanup'
);
assert.equal(lostCreateCleanup.status, 201, await lostCreateCleanup.clone().text());
assert.equal(staging.uploads.get(lostCreateFirstCall.uploadId)?.parts.size, 0);

// A lost completion response is recovered from the exact content, dimensions,
// provider metadata, and digest. The retry never creates a second upload.
const lostCompleteDraft = await createApprovedSyntheticPhotoDraft(
    'synthetic-phase-d-lost-complete',
    'lost-complete'
);
const lostCompleteRunResponse = await processorRequest(
    `/api/service/drafts/${lostCompleteDraft.draftId}/processing-runs`,
    {
        method: 'POST',
        identity: processorIdentity(),
        json: {
            expectedStateVersion: lostCompleteDraft.stateVersion,
            idempotencyKey: 'phase-d-lost-complete-start'
        }
    }
);
assert.equal(lostCompleteRunResponse.status, 201, await lostCompleteRunResponse.clone().text());
const lostCompleteRun = await lostCompleteRunResponse.json();
staging.failAfterNextComplete = true;
const lostCompleteUpload = await uploadDerivative(
    lostCompleteRun.processingRunId,
    display,
    displayBytes,
    'phase-d-lost-complete-output'
);
assert.equal(lostCompleteUpload.status, 201, await lostCompleteUpload.clone().text());
const lostCompleteCreationCount = staging.calls.filter(call =>
    call.operation === 'createMultipartUpload' &&
    call.key.includes(`/${lostCompleteRun.processingRunId}/`)
).length;
const lostCompleteReplay = await uploadDerivative(
    lostCompleteRun.processingRunId,
    display,
    displayBytes,
    'phase-d-lost-complete-output'
);
assert.equal(lostCompleteReplay.status, 200, await lostCompleteReplay.clone().text());
assert.equal(staging.calls.filter(call =>
    call.operation === 'createMultipartUpload' &&
    call.key.includes(`/${lostCompleteRun.processingRunId}/`)
).length, lostCompleteCreationCount);
const lostCompleteFailure = await processorRequest(
    `/api/service/processing-runs/${lostCompleteRun.processingRunId}/result`,
    {
        method: 'POST',
        identity: processorIdentity(),
        json: {
            outcome: 'failed',
            expectedStateVersion: lostCompleteRun.stateVersion,
            idempotencyKey: 'phase-d-lost-complete-failure',
            errorCode: 'processing-failed'
        }
    }
);
assert.equal(lostCompleteFailure.status, 200, await lostCompleteFailure.clone().text());
const lostCompleteFailureBody = await lostCompleteFailure.json();
const lostCompleteCleanup = await cleanupRun(
    lostCompleteRun.processingRunId,
    lostCompleteFailureBody.stateVersion,
    'phase-d-lost-complete-cleanup'
);
assert.equal(lostCompleteCleanup.status, 201, await lostCompleteCleanup.clone().text());

// A conflicting pre-existing object is never overwritten or deleted. Exact
// cleanup fails closed because those bytes cannot be attributed to the run;
// the closure still blocks every later upload/result attempt.
const conflictDraft = await createApprovedSyntheticPhotoDraft(
    'synthetic-phase-d-conflicting-object',
    'conflicting-object'
);
const conflictRunResponse = await processorRequest(
    `/api/service/drafts/${conflictDraft.draftId}/processing-runs`,
    {
        method: 'POST',
        identity: processorIdentity(),
        json: {
            expectedStateVersion: conflictDraft.stateVersion,
            idempotencyKey: 'phase-d-conflict-start'
        }
    }
);
assert.equal(conflictRunResponse.status, 201, await conflictRunResponse.clone().text());
const conflictRun = await conflictRunResponse.json();
const conflictKey = buildV1StagingDerivativeKey({
    site: 'family',
    draftId: conflictDraft.draftId,
    processingRunId: conflictRun.processingRunId,
    sha256: display.sha256,
    role: 'photo-display'
});
const conflictBytes = thumbnailBytes.slice();
const conflictingSeed = staging.seedObject(conflictKey, conflictBytes, {
    etag: 'foreign-conflict-etag',
    version: 'foreign-conflict-version',
    customMetadata: {
        contract: 'gallery-private-staging-v1',
        role: 'photo-display'
    }
});
const overwriteAttemptsBeforeConflict = staging.overwriteAttempts;
const conflictUpload = await uploadDerivative(
    conflictRun.processingRunId,
    display,
    displayBytes,
    'phase-d-conflicting-object-output'
);
assert.equal(conflictUpload.status, 503);
assert.equal(staging.overwriteAttempts, overwriteAttemptsBeforeConflict);
assert.deepEqual(staging.objects.get(conflictKey).bytes, conflictingSeed.bytes);
insertPendingExclusion(sqlite, selectedResult.athleteId, catalog.suppressionRevision);
const conflictCleanup = await cleanupRun(
    conflictRun.processingRunId,
    conflictRun.stateVersion,
    'phase-d-conflicting-object-cleanup'
);
assert.equal(conflictCleanup.status, 503);
assert.deepEqual(staging.objects.get(conflictKey).bytes, conflictingSeed.bytes);
assert.equal((await uploadDerivative(
    conflictRun.processingRunId,
    display,
    displayBytes,
    'phase-d-conflict-after-closure'
)).status, 409);
resolvePendingExclusion(sqlite, selectedResult.athleteId, catalog.suppressionRevision);
sqlite.prepare('DELETE FROM pending_athlete_exclusions WHERE athlete_id = ?')
    .run(selectedResult.athleteId);

// The first live complete-wins rehearsal recorded the provider's resolved
// abort before checking the already-completed object. That multipart terminal
// fact is immutable. An exact replay must therefore keep `aborted` as the
// historical provider result while separately proving and deleting the exact
// object that completion had made visible.
const legacyAbortedExact = await createLegacyAbortedCleanupFixture(
    'legacy-aborted-exact-object',
    displayBytes
);
const legacyAbortedExactCleanup = await cleanupRun(
    legacyAbortedExact.run.processingRunId,
    legacyAbortedExact.failed.stateVersion,
    'phase-d-legacy-aborted-exact-object-cleanup'
);
assert.equal(
    legacyAbortedExactCleanup.status,
    200,
    await legacyAbortedExactCleanup.clone().text()
);
assert.deepEqual(await legacyAbortedExactCleanup.json(), {
    processingRunId: legacyAbortedExact.run.processingRunId,
    cleanupReason: 'processing-failed',
    status: 'cleaned',
    replayed: true
});
assert.equal(staging.objects.has(legacyAbortedExact.creation.key), false);
const legacyAbortedExactEvidence = sqlite.prepare(`
    SELECT object.status, object.provider_terminal_kind,
           object.observed_object_version_hash, object.observed_etag_hash,
           object.deleted_at, object.absence_verified_at
    FROM draft_processing_cleanup_objects AS object
    JOIN draft_processing_cleanups AS cleanup ON cleanup.cleanup_id = object.cleanup_id
    WHERE cleanup.processing_run_id = ? AND object.role = 'photo-display'
`).get(legacyAbortedExact.run.processingRunId);
assert.equal(legacyAbortedExactEvidence.status, 'absent');
assert.equal(legacyAbortedExactEvidence.provider_terminal_kind, 'aborted');
assert.equal(
    legacyAbortedExactEvidence.observed_object_version_hash,
    sha256Text(`object-version:${legacyAbortedExact.seeded.version}`)
);
assert.equal(
    legacyAbortedExactEvidence.observed_etag_hash,
    sha256Text(`etag:${legacyAbortedExact.seeded.etag}`)
);
assert.equal(typeof legacyAbortedExactEvidence.deleted_at, 'string');
assert.equal(typeof legacyAbortedExactEvidence.absence_verified_at, 'string');
assert.ok(
    legacyAbortedExactEvidence.absence_verified_at >=
        legacyAbortedExactEvidence.deleted_at
);
assert.equal(sqlite.prepare(
    'SELECT status FROM draft_processing_cleanups WHERE processing_run_id = ?'
).get(legacyAbortedExact.run.processingRunId).status, 'cleaned');
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM gallery_processing_cleanup_tombstones ' +
    'WHERE processing_run_id_hash = ?'
).get(sha256Text(legacyAbortedExact.run.processingRunId)).count, 1);

// The compatibility path does not turn an immutable `aborted` row into broad
// deletion authority. A same-key object with different bytes remains intact,
// the cleanup stays incomplete, and no terminal tombstone can be written.
const legacyAbortedMismatch = await createLegacyAbortedCleanupFixture(
    'legacy-aborted-mismatching-object',
    thumbnailBytes
);
const mismatchDeleteCountBefore = staging.calls.filter(call =>
    call.operation === 'delete' && call.key === legacyAbortedMismatch.creation.key
).length;
const legacyAbortedMismatchCleanup = await cleanupRun(
    legacyAbortedMismatch.run.processingRunId,
    legacyAbortedMismatch.failed.stateVersion,
    'phase-d-legacy-aborted-mismatching-object-cleanup'
);
assert.equal(legacyAbortedMismatchCleanup.status, 503);
assert.deepEqual(
    staging.objects.get(legacyAbortedMismatch.creation.key).bytes,
    thumbnailBytes
);
assert.equal(staging.calls.filter(call =>
    call.operation === 'delete' && call.key === legacyAbortedMismatch.creation.key
).length, mismatchDeleteCountBefore);
assert.deepEqual({ ...sqlite.prepare(`
    SELECT cleanup.status AS cleanup_status, object.status AS object_status,
           object.provider_terminal_kind,
           object.observed_object_version_hash, object.observed_etag_hash,
           object.deleted_at, object.absence_verified_at
    FROM draft_processing_cleanups AS cleanup
    JOIN draft_processing_cleanup_objects AS object ON object.cleanup_id = cleanup.cleanup_id
    WHERE cleanup.processing_run_id = ? AND object.role = 'photo-display'
`).get(legacyAbortedMismatch.run.processingRunId) }, {
    cleanup_status: 'deleting',
    object_status: 'pending',
    provider_terminal_kind: null,
    observed_object_version_hash: null,
    observed_etag_hash: null,
    deleted_at: null,
    absence_verified_at: null
});
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM gallery_processing_cleanup_tombstones ' +
    'WHERE processing_run_id_hash = ?'
).get(sha256Text(legacyAbortedMismatch.run.processingRunId)).count, 0);

// A fresh staged photograph can cross the new, separate promotion boundary.
// The caller supplies only the opaque draft ID, current state version, and an
// idempotency key: its inherited Family area, race, athlete tags, storage keys,
// and public URLs are all derived from already-approved evidence.
const promotionFixture = await stageSyntheticProcessingRun('photo-promotion');
const promotionInput = {
    expectedStateVersion: promotionFixture.run.stateVersion,
    idempotencyKey: 'phase-e-photo-promotion-0001'
};
const promotionIdentity = {
    type: 'service',
    subject: 'abcdef0123456789abcdef0123456789.access'
};
const approvedOrigin = 'https://synthetic-approved-media.example';
const promotionEnv = {
    DB: d1,
    DERIVATIVE_STAGING: staging,
    APPROVED_MEDIA: approved
};
// Promotion accepts no caller-selected editorial or storage facts. Prove the
// production service itself (not only its HTTP route) rejects every such field
// before it can create D1 evidence or make an approved-media call.
for (const callerSelectedPromotionField of [
    { site: 'everyone' },
    { siteMode: 'everyone' },
    { destination: 'everyone' },
    { raceDate: selectedResult.raceDate },
    { raceEvent: selectedResult.raceEvent },
    { athleteIds: [selectedResult.athleteId] },
    { role: 'photo-display' },
    { approvedObjectKey: 'media/v1/caller-selected/display.webp' },
    { url: 'https://caller-selected.example/media.webp' },
    { manifestTarget: 'gallery-data/everyone.json' },
    { cleanupReason: 'athlete-exclusion' }
]) {
    const approvedCallsBeforeInvalidPromotion = approved.calls.length;
    assert.deepEqual(await promotePhotoDraft(
        promotionEnv,
        promotionIdentity,
        promotionFixture.draft.draftId,
        { ...promotionInput, ...callerSelectedPromotionField },
        approvedOrigin,
        currentNow += 1
    ), { ok: false, status: 400, code: 'invalid-request' });
    assert.equal(approved.calls.length, approvedCallsBeforeInvalidPromotion);
    assert.equal(sqlite.prepare(
        'SELECT COUNT(*) AS count FROM draft_photo_promotions WHERE draft_id = ?'
    ).get(promotionFixture.draft.draftId).count, 0);
}
// The SQL state machine refuses a direct jump to verified object evidence.
// Keep the adversarial row inside a savepoint so the real promotion starts
// from the same clean staged fixture.
const forgedPromotionAt = new Date(currentNow += 1).toISOString();
const forgedPromotionId = 'promotion_11111111111141118111111111111111';
const forgedPromotionEvidence = sqlite.prepare(`
    SELECT draft.item_revision AS itemRevision,
           draft.active_consent_revision AS consentRevision,
           draft.export_bundle_id AS exportBundleId,
           draft.source_revision AS sourceRevision,
           draft.suppression_revision AS suppressionRevision,
           output.role, output.staging_object_key AS stagingObjectKey,
           output.staging_object_version AS stagingObjectVersion,
           output.staging_etag AS stagingEtag, output.sha256,
           output.byte_count AS byteCount, output.content_type AS contentType,
           output.width, output.height
    FROM gallery_drafts AS draft
    JOIN draft_processing_runs AS run ON run.draft_id = draft.draft_id
    JOIN draft_processing_outputs AS output
      ON output.processing_run_id = run.processing_run_id
     AND output.role = 'photo-display'
    WHERE draft.draft_id = ? AND run.processing_run_id = ?
`).get(promotionFixture.draft.draftId, promotionFixture.run.processingRunId);
assert.ok(forgedPromotionEvidence);
sqlite.exec('SAVEPOINT forged_verified_promotion');
try {
    sqlite.prepare(`
        INSERT INTO draft_photo_promotions (
            promotion_id, processing_run_id, draft_id, site_mode,
            item_revision, consent_revision, export_bundle_id,
            source_revision, suppression_revision, expected_state_version,
            result_state_version, idempotency_key, idempotency_key_hash,
            payload_fingerprint,
            service_actor_identity_hash, created_at, updated_at
        ) VALUES (?, ?, ?, 'family', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        forgedPromotionId,
        promotionFixture.run.processingRunId,
        promotionFixture.draft.draftId,
        forgedPromotionEvidence.itemRevision,
        forgedPromotionEvidence.consentRevision,
        forgedPromotionEvidence.exportBundleId,
        forgedPromotionEvidence.sourceRevision,
        forgedPromotionEvidence.suppressionRevision,
        promotionFixture.run.stateVersion,
        promotionFixture.run.stateVersion + 1,
        'phase-e-forged-promotion',
        sha256Text('promotion-idempotency-key:phase-e-forged-promotion'),
        '4'.repeat(64),
        '5'.repeat(64),
        forgedPromotionAt,
        forgedPromotionAt
    );
    assert.throws(
        () => sqlite.prepare(`
            INSERT INTO draft_photo_promotion_objects (
                promotion_id, role, staging_object_key,
                staging_object_version, staging_etag, approved_object_key,
                sha256, byte_count, content_type, width, height, status,
                provider_upload_id, provider_upload_id_hash, provider_part_etag,
                approved_object_version, approved_etag,
                created_at, updated_at, verified_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            forgedPromotionId,
            forgedPromotionEvidence.role,
            forgedPromotionEvidence.stagingObjectKey,
            forgedPromotionEvidence.stagingObjectVersion,
            forgedPromotionEvidence.stagingEtag,
            `media/v1/${forgedPromotionEvidence.sha256}/display.webp`,
            forgedPromotionEvidence.sha256,
            forgedPromotionEvidence.byteCount,
            forgedPromotionEvidence.contentType,
            forgedPromotionEvidence.width,
            forgedPromotionEvidence.height,
            'forged-provider-upload',
            '6'.repeat(64),
            'forged-provider-part-etag',
            'forged-approved-version',
            'forged-approved-etag',
            forgedPromotionAt,
            forgedPromotionAt,
            forgedPromotionAt
        ),
        /not derived from verified staging evidence/i
    );
} finally {
    sqlite.exec('ROLLBACK TO forged_verified_promotion');
    sqlite.exec('RELEASE forged_verified_promotion');
}
// SQLite's REPLACE conflict handler must not be able to delete the row that
// already owns an admission token or provider upload identity. Exercise each
// collision while the first real provider create is suspended, then roll the
// adversarial state back before promotion continues normally.
sqlite.exec('PRAGMA recursive_triggers = OFF');
let providerIdentityProbeError = null;
let providerIdentityProbeCompleted = false;
approved.afterNextCreate = async ({ uploadId }) => {
    try {
    const livePromotionId = promotionIdForDraft(promotionFixture.draft.draftId);
    const rowsBefore = sqlite.prepare(`
        SELECT * FROM draft_photo_promotion_objects
        WHERE promotion_id = ? ORDER BY role
    `).all(livePromotionId).map(row => ({ ...row }));
    const display = rowsBefore.find(row => row.role === 'photo-display');
    const thumbnail = rowsBefore.find(row => row.role === 'photo-thumbnail');
    assert.equal(display.status, 'admitting');
    assert.match(display.provider_admission_token_hash, /^[a-f0-9]{64}$/);
    assert.equal(thumbnail.status, 'reserved');
    const displayUploadHash = sha256Text(`approved-upload:${uploadId}`);
    const secondAdmissionHash = display.provider_admission_token_hash === 'b'.repeat(64)
        ? 'c'.repeat(64)
        : 'b'.repeat(64);
    const distinctUploadHash = displayUploadHash === 'd'.repeat(64)
        ? 'e'.repeat(64)
        : 'd'.repeat(64);
    const admissionAt = new Date(currentNow + 100).toISOString();
    const uploadOpenAt = new Date(currentNow + 101).toISOString();

    sqlite.exec('SAVEPOINT provider_identity_replace_probes');
    try {
        assert.throws(
            () => sqlite.prepare(`
                UPDATE draft_photo_promotion_objects
                SET status = 'upload-open', provider_admission_token_hash = ?,
                    provider_upload_id = 'direct-jump-upload',
                    provider_upload_id_hash = ?, updated_at = ?
                WHERE promotion_id = ? AND role = 'photo-thumbnail'
            `).run(
                secondAdmissionHash,
                distinctUploadHash,
                uploadOpenAt,
                livePromotionId
            ),
            /invalid photo promotion object transition/i
        );
        assert.throws(
            () => sqlite.prepare(`
                UPDATE OR REPLACE draft_photo_promotion_objects
                SET status = 'admitting', provider_admission_token_hash = ?,
                    updated_at = ?
                WHERE promotion_id = ? AND role = 'photo-thumbnail'
            `).run(
                display.provider_admission_token_hash,
                admissionAt,
                livePromotionId
            ),
            /provider identity replacement is forbidden/i
        );
        sqlite.prepare(`
            UPDATE draft_photo_promotion_objects
            SET status = 'admitting', provider_admission_token_hash = ?,
                updated_at = ?
            WHERE promotion_id = ? AND role = 'photo-thumbnail'
        `).run(secondAdmissionHash, admissionAt, livePromotionId);
        sqlite.prepare(`
            UPDATE draft_photo_promotion_objects
            SET status = 'upload-open', provider_upload_id = ?,
                provider_upload_id_hash = ?, updated_at = ?
            WHERE promotion_id = ? AND role = 'photo-display'
        `).run(uploadId, displayUploadHash, uploadOpenAt, livePromotionId);
        assert.throws(
            () => sqlite.prepare(`
                UPDATE OR REPLACE draft_photo_promotion_objects
                SET status = 'upload-open', provider_upload_id = ?,
                    provider_upload_id_hash = ?, updated_at = ?
                WHERE promotion_id = ? AND role = 'photo-thumbnail'
            `).run(uploadId, distinctUploadHash, uploadOpenAt, livePromotionId),
            /provider identity replacement is forbidden/i
        );
        assert.throws(
            () => sqlite.prepare(`
                UPDATE OR REPLACE draft_photo_promotion_objects
                SET status = 'upload-open', provider_upload_id = ?,
                    provider_upload_id_hash = ?, updated_at = ?
                WHERE promotion_id = ? AND role = 'photo-thumbnail'
            `).run(
                'distinct-adversarial-upload-id',
                displayUploadHash,
                uploadOpenAt,
                livePromotionId
            ),
            /provider identity replacement is forbidden/i
        );
    } finally {
        sqlite.exec('ROLLBACK TO provider_identity_replace_probes');
        sqlite.exec('RELEASE provider_identity_replace_probes');
    }
    assert.deepEqual(sqlite.prepare(`
        SELECT * FROM draft_photo_promotion_objects
        WHERE promotion_id = ? ORDER BY role
    `).all(livePromotionId).map(row => ({ ...row })), rowsBefore);
    providerIdentityProbeCompleted = true;
    } catch (error) {
        providerIdentityProbeError = error;
        throw error;
    }
};
// The first multipart completion succeeds in R2 but its response is lost. The
// exact retry adopts those bytes; it does not create another key or overwrite.
approved.failAfterNextComplete = true;
const interruptedPromotion = await promotePhotoDraft(
    promotionEnv,
    promotionIdentity,
    promotionFixture.draft.draftId,
    promotionInput,
    approvedOrigin,
    currentNow += 1
);
assert.deepEqual(interruptedPromotion, {
    ok: false,
    status: 503,
    code: 'service-unavailable'
});
assert.equal(
    providerIdentityProbeCompleted,
    true,
    providerIdentityProbeError?.stack || providerIdentityProbeError?.message
);
const promoted = await promotePhotoDraft(
    promotionEnv,
    promotionIdentity,
    promotionFixture.draft.draftId,
    promotionInput,
    approvedOrigin,
    currentNow += 1
);
assert.equal(promoted.ok, true, JSON.stringify(promoted));
assert.equal(promoted.status, 201);
assert.equal(promoted.replayed, true);
assert.equal(promoted.candidate.draft.state, 'candidate-public');
assert.deepEqual(promoted.candidate.draft.siteModes, ['family']);
assert.equal(promoted.candidate.draft.itemInput.id, 'synthetic-phase-d-photo-promotion');
assert.equal(promoted.candidate.draft.itemInput.raceDate, selectedResult.raceDate);
assert.deepEqual(promoted.candidate.draft.itemInput.athleteIds, [selectedResult.athleteId]);
assert.match(
    promoted.candidate.draft.manifestItem.sourceUrl,
    /^https:\/\/synthetic-approved-media\.example\/media\/v1\/[a-f0-9]{64}\/display\.webp$/
);
assert.match(
    promoted.candidate.draft.manifestItem.thumbnailUrl,
    /^https:\/\/synthetic-approved-media\.example\/media\/v1\/[a-f0-9]{64}\/thumbnail\.webp$/
);
assert.equal(promoted.candidate.context.pendingHiddenAthleteIds.length, 0);
assert.doesNotMatch(
    JSON.stringify(promoted.candidate),
    /private-originals|derivative-staging|provider-|synthetic-private-consent/i
);
assert.deepEqual(
    { ...sqlite.prepare(
        'SELECT state, state_version AS stateVersion FROM gallery_drafts WHERE draft_id = ?'
    ).get(promotionFixture.draft.draftId) },
    { state: 'candidate-public', stateVersion: promotionFixture.run.stateVersion + 1 }
);
assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM draft_photo_promotion_objects WHERE status = 'verified'"
).get().count, 2);
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM draft_derivatives ' +
    'WHERE draft_id = ? AND approved_object_key IS NOT NULL'
).get(promotionFixture.draft.draftId).count, 2);
assert.equal(approved.objects.size, 2);
assert.equal(approved.calls.filter(call => call.operation === 'complete').length, 2);
assert.equal(approved.calls.filter(call => call.operation === 'put').length, 0);
assert.equal(approved.calls.filter(call => call.operation === 'delete').length, 0);
assert.equal(approved.calls.filter(call => call.operation === 'list').length, 0);

const promotedReplay = await promotePhotoDraft(
    promotionEnv,
    promotionIdentity,
    promotionFixture.draft.draftId,
    promotionInput,
    approvedOrigin,
    currentNow += 1
);
assert.equal(promotedReplay.ok, true, JSON.stringify(promotedReplay));
assert.equal(promotedReplay.status, 200);
assert.equal(promotedReplay.replayed, true);
assert.deepEqual(promotedReplay.candidate, promoted.candidate);
assert.equal(approved.calls.filter(call => call.operation === 'complete').length, 2);

// A consent/exclusion change can arrive while the two approved objects are
// being read. The candidate builder must re-read D1 after both provider reads,
// not rely on the eligibility snapshot it took before them.
let candidateReplayGetCount = 0;
const excludeAfterCandidateReadsBegin = async () => {
    candidateReplayGetCount += 1;
    if (candidateReplayGetCount === 1) {
        approved.afterNextGet = excludeAfterCandidateReadsBegin;
        return;
    }
    insertPendingExclusion(sqlite, selectedResult.athleteId, catalog.suppressionRevision);
};
approved.afterNextGet = excludeAfterCandidateReadsBegin;
const exclusionDuringCandidateReplay = await promotePhotoDraft(
    promotionEnv,
    promotionIdentity,
    promotionFixture.draft.draftId,
    promotionInput,
    approvedOrigin,
    currentNow += 1
);
assert.deepEqual(exclusionDuringCandidateReplay, {
    ok: false,
    status: 409,
    code: 'promotion-not-eligible'
});
assert.equal(candidateReplayGetCount, 2);
resolvePendingExclusion(sqlite, selectedResult.athleteId, catalog.suppressionRevision);
sqlite.prepare('DELETE FROM pending_athlete_exclusions WHERE athlete_id = ?')
    .run(selectedResult.athleteId);

assert.deepEqual(
    { ...sqlite.prepare(`
        SELECT
            (SELECT COUNT(*) FROM draft_photo_promotions WHERE draft_id = ?) AS promotions,
            (SELECT COUNT(*) FROM draft_transition_receipts
                WHERE draft_id = ? AND to_state = 'candidate-public') AS receipts,
            (SELECT COUNT(*) FROM gallery_audit_events
                WHERE event_type = 'photo-promotion-candidate') AS candidateAudits
    `).get(promotionFixture.draft.draftId, promotionFixture.draft.draftId) },
    { promotions: 1, receipts: 1, candidateAudits: 1 }
);
assert.throws(
    () => sqlite.prepare(
        'DELETE FROM draft_photo_promotion_objects WHERE promotion_id = ?'
    ).run(promoted.candidate.operationId),
    /promotion object deletion lacks approved cleanup evidence/i
);
assert.throws(
    () => sqlite.prepare(
        'DELETE FROM draft_photo_promotions WHERE promotion_id = ?'
    ).run(promoted.candidate.operationId),
    /promotion deletion lacks completed object cleanup/i
);
assert.throws(
    () => sqlite.prepare(
        "UPDATE gallery_drafts SET state = 'pr-open', state_version = state_version + 1 " +
        'WHERE draft_id = ?'
    ).run(promotionFixture.draft.draftId),
    /pull request state is unavailable before immutable review evidence/i
);
assert.throws(
    () => sqlite.prepare(
        'UPDATE draft_derivatives SET approved_object_key = NULL ' +
        'WHERE draft_id = ? AND role = ?'
    ).run(promotionFixture.draft.draftId, 'photo-display'),
    /verified processing derivative evidence is immutable/i
);

// Candidate retries never trust the database alone. If an approved object is
// changed or missing, no manifest package is returned even though D1 still
// says candidate.
const changedApprovedKey = new URL(
    promoted.candidate.draft.manifestItem.sourceUrl
).pathname.slice(1);
const exactApprovedObject = approved.objects.get(changedApprovedKey);
approved.objects.set(changedApprovedKey, {
    ...exactApprovedObject,
    bytes: thumbnailBytes.slice(),
    etag: 'synthetic-changed-approved-etag',
    version: 'synthetic-changed-approved-version'
});
const changedApprovedReplay = await promotePhotoDraft(
    promotionEnv,
    promotionIdentity,
    promotionFixture.draft.draftId,
    promotionInput,
    approvedOrigin,
    currentNow += 1
);
assert.deepEqual(changedApprovedReplay, {
    ok: false,
    status: 409,
    code: 'promotion-not-eligible'
});
approved.objects.set(changedApprovedKey, exactApprovedObject);

const missingApprovedKey = new URL(
    promoted.candidate.draft.manifestItem.thumbnailUrl
).pathname.slice(1);
const exactMissingApprovedObject = approved.objects.get(missingApprovedKey);
assert.ok(exactMissingApprovedObject);
approved.objects.delete(missingApprovedKey);
const missingApprovedReplay = await promotePhotoDraft(
    promotionEnv,
    promotionIdentity,
    promotionFixture.draft.draftId,
    promotionInput,
    approvedOrigin,
    currentNow += 1
);
assert.deepEqual(missingApprovedReplay, {
    ok: false,
    status: 409,
    code: 'promotion-not-eligible'
});
approved.objects.set(missingApprovedKey, exactMissingApprovedObject);

// Approved cleanup is host-first and whole-item. The pending tagged-athlete
// exclusion is current D1 evidence; the request cannot choose the reason,
// role, area, URL, or storage key. Both approved roles are removed before the
// private-staging cleanup is allowed to continue.
insertPendingExclusion(sqlite, selectedResult.athleteId, catalog.suppressionRevision);
const promotionWithdrawalStateVersion = transitionDraftDirect(
    sqlite,
    promotionFixture.draft.draftId,
    'withdrawal-pending'
);
const promotionCleanupInput = {
    expectedStateVersion: promotionWithdrawalStateVersion,
    idempotencyKey: 'phase-e-photo-promotion-cleanup-0001'
};
const promotionId = promoted.candidate.operationId;
const approvedCleanup = await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    promotionId,
    promotionCleanupInput,
    currentNow += 1
);
assert.deepEqual(approvedCleanup, {
    ok: true,
    status: 201,
    promotionId,
    cleanupReason: 'athlete-exclusion',
    promotionStatus: 'cleaned',
    replayed: false
});
assert.equal(approved.objects.size, 0);
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM draft_photo_promotions WHERE promotion_id = ?'
).get(promotionId).count, 0);
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM draft_photo_promotion_objects WHERE promotion_id = ?'
).get(promotionId).count, 0);
assert.deepEqual({ ...sqlite.prepare(`
    SELECT cleanup.status, cleanup.cleanup_reason AS cleanupReason,
           cleanup.withdrawal_kind AS withdrawalKind,
           (SELECT COUNT(*) FROM draft_photo_promotion_cleanup_objects AS object
            WHERE object.cleanup_id = cleanup.cleanup_id
              AND object.status = 'absent') AS absentObjects,
           (SELECT COUNT(*) FROM gallery_photo_promotion_cleanup_tombstones AS tombstone
            WHERE tombstone.promotion_id_hash = cleanup.promotion_id_hash) AS tombstones
    FROM draft_photo_promotion_cleanups AS cleanup
    WHERE cleanup.promotion_id = ?
`).get(promotionId) }, {
    status: 'cleaned',
    cleanupReason: 'athlete-exclusion',
    withdrawalKind: 'athlete-exclusion',
    absentObjects: 2,
    tombstones: 1
});
const approvedCleanupChronology = sqlite.prepare(`
    SELECT cleanup.completed_at AS completedAt,
           MAX(object.absence_verified_at) AS latestAbsenceAt
    FROM draft_photo_promotion_cleanups AS cleanup
    JOIN draft_photo_promotion_cleanup_objects AS object
      ON object.cleanup_id = cleanup.cleanup_id
    WHERE cleanup.promotion_id = ?
    GROUP BY cleanup.cleanup_id
`).get(promotionId);
assert.ok(Date.parse(approvedCleanupChronology.completedAt) >
    Date.parse(approvedCleanupChronology.latestAbsenceAt));
const cleanupTombstoneColumns = sqlite.prepare(
    'PRAGMA table_info(gallery_photo_promotion_cleanup_tombstones)'
).all().map(column => column.name);
assert.equal(cleanupTombstoneColumns.includes('source_promotion_idempotency_key'), false);
assert.equal(cleanupTombstoneColumns.includes('cleanup_idempotency_key'), false);
assert.equal(cleanupTombstoneColumns.includes('cleanup_expected_state_version'), false);
assert.equal(cleanupTombstoneColumns.includes('source_promotion_idempotency_key_hash'), true);
assert.equal(cleanupTombstoneColumns.includes('cleanup_idempotency_key_hash'), true);
assert.doesNotMatch(JSON.stringify(sqlite.prepare(`
    SELECT tombstone.*
    FROM gallery_photo_promotion_cleanup_tombstones AS tombstone
    JOIN draft_photo_promotion_cleanups AS cleanup
      ON cleanup.promotion_id_hash = tombstone.promotion_id_hash
    WHERE cleanup.promotion_id = ?
`).get(promotionId)), /phase-e-photo-promotion/i);
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM draft_publication_references WHERE draft_id = ?'
).get(promotionFixture.draft.draftId).count, 0);
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM draft_derivatives ' +
    'WHERE draft_id = ? AND approved_object_key IS NOT NULL'
).get(promotionFixture.draft.draftId).count, 0);
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM draft_derivatives ' +
    'WHERE draft_id = ? AND host_deleted_at IS NOT NULL'
).get(promotionFixture.draft.draftId).count, 0);
const approvedCleanupReplay = await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    promotionId,
    promotionCleanupInput,
    currentNow += 1
);
assert.equal(approvedCleanupReplay.ok, true);
assert.equal(approvedCleanupReplay.status, 200);
assert.equal(approvedCleanupReplay.replayed, true);
assert.deepEqual(await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    promotionId,
    { ...promotionCleanupInput, idempotencyKey: 'phase-e-cleanup-conflict-0002' },
    currentNow += 1
), {
    ok: false,
    status: 409,
    code: 'conflict'
});
assert.throws(
    () => sqlite.prepare(
        'DELETE FROM draft_photo_promotion_cleanups WHERE promotion_id = ?'
    ).run(promotionId),
    /cleanup direct deletion is forbidden/i
);
const immutableApprovedCleanup = sqlite.prepare(`
    SELECT cleanup_id AS cleanupId, cleanup_id_hash AS cleanupIdHash,
           promotion_id_hash AS promotionIdHash
    FROM draft_photo_promotion_cleanups WHERE promotion_id = ?
`).get(promotionId);
assert.ok(immutableApprovedCleanup);
assert.throws(
    () => sqlite.prepare(
        "UPDATE draft_photo_promotion_cleanups SET cleanup_reason = 'withdrawal' " +
        'WHERE cleanup_id = ?'
    ).run(immutableApprovedCleanup.cleanupId),
    /cleanup (identity|evidence) is immutable/i
);
assert.throws(
    () => sqlite.prepare(
        "UPDATE draft_photo_promotion_cleanups SET updated_at = updated_at || 'Z' " +
        'WHERE cleanup_id = ?'
    ).run(immutableApprovedCleanup.cleanupId),
    /completed photo promotion cleanup evidence is immutable/i
);
assert.throws(
    () => sqlite.prepare(
        'INSERT OR REPLACE INTO draft_photo_promotion_cleanups ' +
        'SELECT * FROM draft_photo_promotion_cleanups WHERE cleanup_id = ?'
    ).run(immutableApprovedCleanup.cleanupId),
    /cleanup (replacement is forbidden|lacks a current derived reason)/i
);
assert.throws(
    () => sqlite.prepare(
        'UPDATE draft_photo_promotion_cleanup_objects ' +
        'SET absence_verified_at = absence_verified_at || \'Z\' ' +
        'WHERE cleanup_id = ? AND role = \'photo-display\''
    ).run(immutableApprovedCleanup.cleanupId),
    /verified approved-object absence is immutable/i
);
assert.throws(
    () => sqlite.prepare(
        'DELETE FROM draft_photo_promotion_cleanup_objects ' +
        'WHERE cleanup_id = ? AND role = \'photo-display\''
    ).run(immutableApprovedCleanup.cleanupId),
    /cleanup object deletion is forbidden/i
);
assert.throws(
    () => sqlite.prepare(
        'INSERT OR REPLACE INTO draft_photo_promotion_cleanup_objects ' +
        'SELECT * FROM draft_photo_promotion_cleanup_objects ' +
        'WHERE cleanup_id = ? AND role = \'photo-display\''
    ).run(immutableApprovedCleanup.cleanupId),
    /cleanup object (replacement is forbidden|lacks exact source evidence)/i
);
assert.throws(
    () => sqlite.prepare(
        'UPDATE gallery_photo_promotion_cleanup_tombstones ' +
        'SET completed_at = completed_at || \'Z\' WHERE cleanup_id_hash = ?'
    ).run(immutableApprovedCleanup.cleanupIdHash),
    /tombstones are append-only/i
);
assert.throws(
    () => sqlite.prepare(
        'DELETE FROM gallery_photo_promotion_cleanup_tombstones ' +
        'WHERE cleanup_id_hash = ?'
    ).run(immutableApprovedCleanup.cleanupIdHash),
    /tombstones are append-only/i
);
assert.throws(
    () => sqlite.prepare(
        'INSERT OR REPLACE INTO gallery_photo_promotion_cleanup_tombstones ' +
        'SELECT * FROM gallery_photo_promotion_cleanup_tombstones ' +
        'WHERE cleanup_id_hash = ?'
    ).run(immutableApprovedCleanup.cleanupIdHash),
    /tombstone replacement is forbidden/i
);
// The receipt also has a composite replay identity. INSERT OR REPLACE must not
// evict the older receipt by supplying fresh primary/promotion/evidence hashes
// while colliding only on (draft hash, source-promotion idempotency hash).
const cleanupReceiptBeforeCompositeCollision = {
    ...sqlite.prepare(`
        SELECT * FROM gallery_photo_promotion_cleanup_tombstones
        WHERE cleanup_id_hash = ?
    `).get(immutableApprovedCleanup.cleanupIdHash)
};
assert.throws(
    () => sqlite.prepare(`
        INSERT OR REPLACE INTO gallery_photo_promotion_cleanup_tombstones (
            cleanup_id_hash, promotion_id_hash, processing_run_id_hash,
            draft_id_hash, source_promotion_idempotency_key_hash,
            source_promotion_payload_fingerprint,
            cleanup_idempotency_key_hash, cleanup_payload_fingerprint,
            cleanup_reason, withdrawal_kind, evidence_hash, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        sha256Text('composite-collision-cleanup-id'),
        sha256Text('composite-collision-promotion-id'),
        sha256Text('composite-collision-processing-run-id'),
        cleanupReceiptBeforeCompositeCollision.draft_id_hash,
        cleanupReceiptBeforeCompositeCollision.source_promotion_idempotency_key_hash,
        sha256Text('composite-collision-source-payload'),
        sha256Text('composite-collision-cleanup-idempotency'),
        sha256Text('composite-collision-cleanup-payload'),
        cleanupReceiptBeforeCompositeCollision.cleanup_reason,
        cleanupReceiptBeforeCompositeCollision.withdrawal_kind,
        sha256Text('composite-collision-evidence'),
        cleanupReceiptBeforeCompositeCollision.completed_at
    ),
    /photo promotion cleanup tombstone replacement is forbidden/i
);
assert.deepEqual({
    ...sqlite.prepare(`
        SELECT * FROM gallery_photo_promotion_cleanup_tombstones
        WHERE draft_id_hash = ? AND source_promotion_idempotency_key_hash = ?
    `).get(
        cleanupReceiptBeforeCompositeCollision.draft_id_hash,
        cleanupReceiptBeforeCompositeCollision.source_promotion_idempotency_key_hash
    )
}, cleanupReceiptBeforeCompositeCollision);
const downstreamStagingCleanup = await cleanupRun(
    promotionFixture.run.processingRunId,
    promotionWithdrawalStateVersion,
    'phase-e-post-approved-staging-cleanup'
);
assert.equal(downstreamStagingCleanup.status, 201, await downstreamStagingCleanup.clone().text());
assert.equal((await downstreamStagingCleanup.json()).cleanupReason, 'athlete-exclusion');
resolvePendingExclusion(sqlite, selectedResult.athleteId, catalog.suppressionRevision);
sqlite.prepare('DELETE FROM pending_athlete_exclusions WHERE athlete_id = ?')
    .run(selectedResult.athleteId);

// The approved cleanup itself deliberately did not claim public-host absence.
// Model a later independent host check, private retention expiry, and approved
// draft purge to prove that the no-foreign-key receipt still answers exact
// promotion and cleanup retries after every operational row has gone.
const externalHostProofAt = new Date(currentNow += 1).toISOString();
sqlite.prepare(`
    INSERT INTO draft_publication_references (
        draft_id, host_deletion_confirmed,
        private_original_deletion_confirmed,
        withdrawal_kind, updated_at
    ) VALUES (?, 1, 0, 'athlete-exclusion', ?)
`).run(promotionFixture.draft.draftId, externalHostProofAt);
transitionDraftDirect(sqlite, promotionFixture.draft.draftId, 'withdrawn');
markPrivateOriginalDeleted(sqlite, promotionFixture.draft.draftId);
sqlite.prepare(`
    UPDATE draft_publication_references
    SET private_original_deletion_confirmed = 1, updated_at = ?
    WHERE draft_id = ? AND host_deletion_confirmed = 1
`).run(new Date(currentNow += 1).toISOString(), promotionFixture.draft.draftId);
const promotionRetentionAt = new Date(currentNow += 1).toISOString();
sqlite.prepare(`
    INSERT INTO gallery_retention_tombstones (
        draft_id, purge_kind, eligible_at, approved_at,
        approved_by_identity_hash, evidence_hash
    ) VALUES (?, 'retention-expiry', ?, ?, ?, ?)
`).run(
    promotionFixture.draft.draftId,
    promotionRetentionAt,
    promotionRetentionAt,
    '8'.repeat(64),
    '9'.repeat(64)
);
sqlite.prepare('DELETE FROM gallery_drafts WHERE draft_id = ?')
    .run(promotionFixture.draft.draftId);
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM draft_photo_promotion_cleanups WHERE promotion_id = ?'
).get(promotionId).count, 0);
assert.deepEqual(await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    promotionId,
    promotionCleanupInput,
    currentNow += 1
), {
    ok: true,
    status: 200,
    promotionId,
    cleanupReason: 'athlete-exclusion',
    promotionStatus: 'cleaned',
    replayed: true
});
assert.deepEqual(await promotePhotoDraft(
    promotionEnv,
    promotionIdentity,
    promotionFixture.draft.draftId,
    promotionInput,
    approvedOrigin,
    currentNow += 1
), {
    ok: false,
    status: 409,
    code: 'promotion-cleaned'
});

// The one permitted provider create is admitted in D1 first. Suspend the
// provider immediately before creation, prove the hashed admission is already
// durable, and run an exact concurrent replay. The replay sees `admitting`,
// returns without calling R2, and the original invocation remains the only
// creator for that role.
const admissionOrderFixture = await stageSyntheticProcessingRun(
    'approved-admission-order'
);
const admissionOrderInput = promotionInputFor(
    admissionOrderFixture,
    'approved-promotion-admission-order'
);
const admissionOrderCallsStart = approved.calls.length;
let admissionBeforeCreateObserved = false;
let admissionConcurrentReplay;
approved.beforeNextCreate = async ({ key }) => {
    const livePromotionId = promotionIdForDraft(admissionOrderFixture.draft.draftId);
    const admitted = sqlite.prepare(`
        SELECT status, provider_admission_token_hash AS admissionHash,
               provider_upload_id AS uploadId
        FROM draft_photo_promotion_objects
        WHERE promotion_id = ? AND approved_object_key = ?
    `).get(livePromotionId, key);
    assert.equal(admitted.status, 'admitting');
    assert.match(admitted.admissionHash, /^[a-f0-9]{64}$/);
    assert.equal(admitted.uploadId, null);
    assert.equal(approved.calls.slice(admissionOrderCallsStart).filter(call =>
        call.operation === 'createMultipartUpload' && call.key === key
    ).length, 0);

    admissionConcurrentReplay = await promotePhotoDraft(
        promotionEnv,
        promotionIdentity,
        admissionOrderFixture.draft.draftId,
        admissionOrderInput,
        approvedOrigin,
        currentNow += 1
    );
    assert.deepEqual(admissionConcurrentReplay, {
        ok: false,
        status: 503,
        code: 'service-unavailable'
    });
    assert.equal(approved.calls.slice(admissionOrderCallsStart).filter(call =>
        call.operation === 'createMultipartUpload' && call.key === key
    ).length, 0);
    admissionBeforeCreateObserved = true;
};
const admissionOrderPromotion = await promotePhotoDraft(
    promotionEnv,
    promotionIdentity,
    admissionOrderFixture.draft.draftId,
    admissionOrderInput,
    approvedOrigin,
    currentNow += 1
);
assert.equal(admissionOrderPromotion.ok, true, JSON.stringify(admissionOrderPromotion));
assert.equal(admissionOrderPromotion.status, 201);
assert.equal(admissionBeforeCreateObserved, true);
const admissionOrderDisplayKey = new URL(
    admissionOrderPromotion.candidate.draft.manifestItem.sourceUrl
).pathname.slice(1);
assert.equal(approved.calls.slice(admissionOrderCallsStart).filter(call =>
    call.operation === 'createMultipartUpload' && call.key === admissionOrderDisplayKey
).length, 1);
const admissionOrderWithdrawalVersion = transitionDraftDirect(
    sqlite,
    admissionOrderFixture.draft.draftId,
    'withdrawal-pending'
);
const admissionOrderCleanup = await cleanupActivePromotion(
    admissionOrderFixture,
    'approved-cleanup-admission-order'
);
assert.equal(admissionOrderCleanup.ok, true, JSON.stringify(admissionOrderCleanup));
const admissionOrderStagingCleanup = await cleanupRun(
    admissionOrderFixture.run.processingRunId,
    admissionOrderWithdrawalVersion,
    'approved-staging-cleanup-admission-order'
);
assert.equal(
    admissionOrderStagingCleanup.status,
    201,
    await admissionOrderStagingCleanup.clone().text()
);

// A part may be durably stored while its provider response is lost. D1 still
// says `upload-open`; the exact retry must reuse that upload ID, resend only
// part 1, and finish without creating a second multipart handle.
const lostApprovedPartFixture = await stageSyntheticProcessingRun(
    'approved-lost-part-response'
);
const lostApprovedPartInput = promotionInputFor(
    lostApprovedPartFixture,
    'approved-promotion-lost-part-response'
);
const lostApprovedPartCallsStart = approved.calls.length;
approved.failAfterNextUploadPart = true;
assert.deepEqual(await promotePhotoDraft(
    promotionEnv,
    promotionIdentity,
    lostApprovedPartFixture.draft.draftId,
    lostApprovedPartInput,
    approvedOrigin,
    currentNow += 1
), {
    ok: false,
    status: 503,
    code: 'service-unavailable'
});
const lostApprovedPartPromotionId = promotionIdForDraft(
    lostApprovedPartFixture.draft.draftId
);
const lostApprovedPartObject = sqlite.prepare(`
    SELECT approved_object_key AS approvedObjectKey, status,
           provider_upload_id AS uploadId,
           provider_admission_token_hash AS admissionHash
    FROM draft_photo_promotion_objects
    WHERE promotion_id = ? AND role = 'photo-display'
`).get(lostApprovedPartPromotionId);
assert.equal(lostApprovedPartObject.status, 'upload-open');
assert.match(lostApprovedPartObject.admissionHash, /^[a-f0-9]{64}$/);
assert.equal(typeof lostApprovedPartObject.uploadId, 'string');
assert.equal(approved.uploads.get(lostApprovedPartObject.uploadId)?.parts.has(1), true);
const lostApprovedPartRetry = await promotePhotoDraft(
    promotionEnv,
    promotionIdentity,
    lostApprovedPartFixture.draft.draftId,
    lostApprovedPartInput,
    approvedOrigin,
    currentNow += 1
);
assert.equal(lostApprovedPartRetry.ok, true, JSON.stringify(lostApprovedPartRetry));
assert.equal(lostApprovedPartRetry.status, 201);
assert.equal(lostApprovedPartRetry.replayed, true);
const lostApprovedPartCalls = approved.calls.slice(lostApprovedPartCallsStart);
assert.equal(lostApprovedPartCalls.filter(call =>
    call.operation === 'createMultipartUpload' &&
    call.key === lostApprovedPartObject.approvedObjectKey
).length, 1);
assert.equal(lostApprovedPartCalls.filter(call =>
    call.operation === 'uploadPart' &&
    call.key === lostApprovedPartObject.approvedObjectKey
).length, 2);
assert.equal(lostApprovedPartCalls.filter(call =>
    call.operation === 'complete' &&
    call.key === lostApprovedPartObject.approvedObjectKey
).length, 1);
const lostApprovedPartWithdrawalVersion = transitionDraftDirect(
    sqlite,
    lostApprovedPartFixture.draft.draftId,
    'withdrawal-pending'
);
const lostApprovedPartCleanup = await cleanupActivePromotion(
    lostApprovedPartFixture,
    'approved-cleanup-lost-part-response'
);
assert.equal(lostApprovedPartCleanup.ok, true, JSON.stringify(lostApprovedPartCleanup));
const lostApprovedPartStagingCleanup = await cleanupRun(
    lostApprovedPartFixture.run.processingRunId,
    lostApprovedPartWithdrawalVersion,
    'approved-staging-cleanup-lost-part-response'
);
assert.equal(
    lostApprovedPartStagingCleanup.status,
    201,
    await lostApprovedPartStagingCleanup.clone().text()
);

// Cleanup can begin while create is in flight. Lose the D1 response after the
// atomic source+cleanup upload-ID handoff commits: both rows must retain the
// same exact provider identity, promotion sends no part, and cleanup adopts the
// committed handoff on retry.
const lostAdmissionHandoffFixture = await stageSyntheticProcessingRun(
    'approved-lost-admission-handoff'
);
const lostAdmissionHandoffInput = promotionInputFor(
    lostAdmissionHandoffFixture,
    'approved-promotion-lost-admission-handoff'
);
const lostAdmissionHandoffCallsStart = approved.calls.length;
let lostAdmissionHandoffCleanup;
approved.afterNextCreate = async () => {
    lostAdmissionHandoffCleanup = await cleanupActivePromotion(
        lostAdmissionHandoffFixture,
        'approved-cleanup-lost-admission-handoff'
    );
};
d1.beforeRunContaining = {
    needle: "SET original_object_status = 'upload-open'",
    callback: () => {
        d1.failAfterNextBatch = true;
    }
};
const lostAdmissionHandoffPromotion = await promotePhotoDraft(
    promotionEnv,
    promotionIdentity,
    lostAdmissionHandoffFixture.draft.draftId,
    lostAdmissionHandoffInput,
    approvedOrigin,
    currentNow += 1
);
assert.deepEqual(lostAdmissionHandoffCleanup, {
    ok: false,
    status: 503,
    code: 'service-unavailable'
});
assert.deepEqual(lostAdmissionHandoffPromotion, {
    ok: false,
    status: 409,
    code: 'promotion-not-eligible'
});
const lostAdmissionHandoffPromotionId = promotionIdForDraft(
    lostAdmissionHandoffFixture.draft.draftId
);
assert.deepEqual({ ...sqlite.prepare(`
    SELECT source.status AS sourceStatus,
           source.provider_upload_id AS sourceUploadId,
           source.provider_upload_id_hash AS sourceUploadHash,
           object.original_object_status AS cleanupOriginalStatus,
           object.provider_upload_id AS cleanupUploadId,
           object.provider_upload_id_hash AS cleanupUploadHash,
           object.status AS cleanupObjectStatus
    FROM draft_photo_promotion_objects AS source
    JOIN draft_photo_promotion_cleanups AS cleanup
      ON cleanup.promotion_id = source.promotion_id
    JOIN draft_photo_promotion_cleanup_objects AS object
      ON object.cleanup_id = cleanup.cleanup_id AND object.role = source.role
    WHERE source.promotion_id = ? AND source.role = 'photo-display'
`).get(lostAdmissionHandoffPromotionId) }, {
    sourceStatus: 'upload-open',
    sourceUploadId: sqlite.prepare(`
        SELECT provider_upload_id FROM draft_photo_promotion_objects
        WHERE promotion_id = ? AND role = 'photo-display'
    `).get(lostAdmissionHandoffPromotionId).provider_upload_id,
    sourceUploadHash: sqlite.prepare(`
        SELECT provider_upload_id_hash FROM draft_photo_promotion_objects
        WHERE promotion_id = ? AND role = 'photo-display'
    `).get(lostAdmissionHandoffPromotionId).provider_upload_id_hash,
    cleanupOriginalStatus: 'upload-open',
    cleanupUploadId: sqlite.prepare(`
        SELECT provider_upload_id FROM draft_photo_promotion_objects
        WHERE promotion_id = ? AND role = 'photo-display'
    `).get(lostAdmissionHandoffPromotionId).provider_upload_id,
    cleanupUploadHash: sqlite.prepare(`
        SELECT provider_upload_id_hash FROM draft_photo_promotion_objects
        WHERE promotion_id = ? AND role = 'photo-display'
    `).get(lostAdmissionHandoffPromotionId).provider_upload_id_hash,
    cleanupObjectStatus: 'pending'
});
const lostAdmissionHandoffCalls = approved.calls.slice(lostAdmissionHandoffCallsStart);
assert.equal(lostAdmissionHandoffCalls.filter(call => call.operation === 'uploadPart').length, 0);
assert.equal(lostAdmissionHandoffCalls.filter(call => call.operation === 'complete').length, 0);
assert.equal(lostAdmissionHandoffCalls.filter(call => call.operation === 'abort').length, 1);
const lostAdmissionHandoffRetry = await cleanupActivePromotion(
    lostAdmissionHandoffFixture,
    'approved-cleanup-lost-admission-handoff'
);
assert.equal(
    lostAdmissionHandoffRetry.ok,
    true,
    JSON.stringify(lostAdmissionHandoffRetry)
);

// Provider creation is admitted in D1 before R2 is called. If cleanup starts
// while that create is in flight, it must stay in `closing`: the handle may
// exist, so recording `not-created` would be false. The create owner then
// hands the exact upload ID to the cleanup snapshot, sends no part, and stops.
const reservedCleanupFixture = await stageSyntheticProcessingRun('approved-cleanup-reserved');
const reservedPromotionCallsStart = approved.calls.length;
let reservedCleanupResult;
approved.afterNextCreate = async () => {
    reservedCleanupResult = await cleanupActivePromotion(
        reservedCleanupFixture,
        'approved-cleanup-reserved-0001'
    );
};
const reservedPromotion = await promotePhotoDraft(
    promotionEnv,
    promotionIdentity,
    reservedCleanupFixture.draft.draftId,
    promotionInputFor(reservedCleanupFixture, 'approved-promotion-reserved-01'),
    approvedOrigin,
    currentNow += 1
);
assert.equal(reservedPromotion.ok, false);
assert.deepEqual(reservedCleanupResult, {
    ok: false,
    status: 503,
    code: 'service-unavailable'
});
const reservedPromotionId = promotionIdForDraft(reservedCleanupFixture.draft.draftId);
assert.deepEqual({ ...sqlite.prepare(`
    SELECT status,
           (SELECT COUNT(*)
              FROM gallery_photo_promotion_cleanup_tombstones AS tombstone
             WHERE tombstone.promotion_id_hash = cleanup.promotion_id_hash) AS tombstones
    FROM draft_photo_promotion_cleanups AS cleanup
    WHERE promotion_id = ?
`).get(reservedPromotionId) }, { status: 'closing', tombstones: 0 });
const reservedPromotionCalls = approved.calls.slice(reservedPromotionCallsStart);
assert.equal(reservedPromotionCalls.filter(call => call.operation === 'uploadPart').length, 0);
assert.equal(reservedPromotionCalls.filter(call => call.operation === 'complete').length, 0);
assert.equal(reservedPromotionCalls.filter(call => call.operation === 'abort').length, 1);
assert.equal(approved.uploads.size, 0);
assert.deepEqual(sqlite.prepare(`
    SELECT original_object_status AS originalStatus,
           provider_terminal_kind AS terminalKind, status, COUNT(*) AS count
    FROM draft_photo_promotion_cleanup_objects
    WHERE cleanup_id = (
        SELECT cleanup_id FROM draft_photo_promotion_cleanups WHERE draft_id = ?
    ) GROUP BY original_object_status, provider_terminal_kind, status
    ORDER BY original_object_status
`).all(reservedCleanupFixture.draft.draftId).map(row => ({ ...row })), [
    {
        originalStatus: 'reserved',
        terminalKind: 'not-created',
        status: 'terminal',
        count: 1
    },
    {
        originalStatus: 'upload-open',
        terminalKind: null,
        status: 'pending',
        count: 1
    }
]);
assert.throws(
    () => sqlite.prepare(`
        UPDATE draft_photo_promotion_objects
        SET status = 'admitting', provider_admission_token_hash = ?,
            updated_at = ?
        WHERE promotion_id = ? AND role = 'photo-thumbnail'
    `).run(
        'f'.repeat(64),
        new Date(currentNow + 100).toISOString(),
        reservedPromotionId
    ),
    /cleanup has closed object mutation/i
);
const reservedCleanupId = sqlite.prepare(`
    SELECT cleanup_id AS cleanupId
    FROM draft_photo_promotion_cleanups WHERE promotion_id = ?
`).get(reservedPromotionId).cleanupId;
assert.throws(
    () => sqlite.prepare(`
        INSERT OR REPLACE INTO draft_photo_promotion_cleanups
        SELECT * FROM draft_photo_promotion_cleanups WHERE cleanup_id = ?
    `).run(reservedCleanupId),
    /photo promotion cleanup replacement is forbidden/i
);
assert.throws(
    () => sqlite.prepare(`
        INSERT OR REPLACE INTO draft_photo_promotion_cleanup_objects
        SELECT * FROM draft_photo_promotion_cleanup_objects
        WHERE cleanup_id = ? AND role = 'photo-display'
    `).run(reservedCleanupId),
    /photo promotion cleanup object replacement is forbidden/i
);
const reservedCleanupRetry = await cleanupActivePromotion(
    reservedCleanupFixture,
    'approved-cleanup-reserved-0001'
);
assert.deepEqual(reservedCleanupRetry, {
    ok: true,
    status: 200,
    promotionId: reservedPromotionId,
    cleanupReason: 'promotion-cancelled',
    promotionStatus: 'cleaned',
    replayed: true
});
assert.deepEqual(sqlite.prepare(`
    SELECT original_object_status AS originalStatus,
           provider_terminal_kind AS terminalKind, COUNT(*) AS count
    FROM draft_photo_promotion_cleanup_objects
    WHERE cleanup_id = (
        SELECT cleanup_id FROM draft_photo_promotion_cleanups WHERE draft_id = ?
    ) GROUP BY original_object_status, provider_terminal_kind
    ORDER BY original_object_status
`).all(reservedCleanupFixture.draft.draftId).map(row => ({ ...row })), [
    {
        originalStatus: 'reserved',
        terminalKind: 'not-created',
        count: 1
    },
    {
        originalStatus: 'upload-open',
        terminalKind: 'not-found',
        count: 1
    }
]);
const reservedReplayCalls = approved.calls.length;
const reservedOldReplay = await promotePhotoDraft(
    promotionEnv,
    promotionIdentity,
    reservedCleanupFixture.draft.draftId,
    promotionInputFor(reservedCleanupFixture, 'approved-promotion-reserved-01'),
    approvedOrigin,
    currentNow += 1
);
assert.deepEqual(reservedOldReplay, {
    ok: false,
    status: 409,
    code: 'promotion-cleaned'
});
assert.equal(approved.calls.length, reservedReplayCalls);

// If the upload ID reaches D1 first, cleanup owns and aborts that exact handle.
// The suspended part write then loses with NoSuchUpload and cannot create bytes.
const openCleanupFixture = await stageSyntheticProcessingRun('approved-cleanup-open');
let openCleanupResult;
approved.beforeNextUploadPart = async () => {
    openCleanupResult = await cleanupActivePromotion(
        openCleanupFixture,
        'approved-cleanup-open-0001'
    );
};
const openPromotion = await promotePhotoDraft(
    promotionEnv,
    promotionIdentity,
    openCleanupFixture.draft.draftId,
    promotionInputFor(openCleanupFixture, 'approved-promotion-open-0001'),
    approvedOrigin,
    currentNow += 1
);
assert.equal(openPromotion.ok, false);
assert.equal(openCleanupResult.ok, true, JSON.stringify(openCleanupResult));
assert.equal(approved.objects.size, 0);
assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM draft_photo_promotion_cleanup_objects
    WHERE cleanup_id = (
        SELECT cleanup_id FROM draft_photo_promotion_cleanups WHERE draft_id = ?
    ) AND original_object_status = 'upload-open'
      AND provider_terminal_kind = 'aborted'
`).get(openCleanupFixture.draft.draftId).count, 1);

// Abort wins after the part and its ETag are durable but before completion.
const partCleanupFixture = await stageSyntheticProcessingRun('approved-cleanup-part');
let partCleanupResult;
approved.beforeNextComplete = async () => {
    partCleanupResult = await cleanupActivePromotion(
        partCleanupFixture,
        'approved-cleanup-part-0001'
    );
};
const partPromotion = await promotePhotoDraft(
    promotionEnv,
    promotionIdentity,
    partCleanupFixture.draft.draftId,
    promotionInputFor(partCleanupFixture, 'approved-promotion-part-0001'),
    approvedOrigin,
    currentNow += 1
);
assert.equal(partPromotion.ok, false);
assert.equal(partCleanupResult.ok, true, JSON.stringify(partCleanupResult));
assert.equal(approved.objects.size, 0);
assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM draft_photo_promotion_cleanup_objects
    WHERE cleanup_id = (
        SELECT cleanup_id FROM draft_photo_promotion_cleanups WHERE draft_id = ?
    ) AND original_object_status = 'part-uploaded'
      AND provider_terminal_kind = 'aborted'
      AND provider_part_etag_hash IS NOT NULL
`).get(partCleanupFixture.draft.draftId).count, 1);

// Completion can win the provider race before D1 records verified state.
// Cleanup still re-reads and verifies the exact WebP, then deletes it and the
// other reserved role as one whole item; no candidate transition is admitted.
const completeWinsFixture = await stageSyntheticProcessingRun('approved-cleanup-complete');
let completeWinsCleanupResult;
approved.afterNextComplete = async () => {
    completeWinsCleanupResult = await cleanupActivePromotion(
        completeWinsFixture,
        'approved-cleanup-complete-0001'
    );
};
const completeWinsPromotion = await promotePhotoDraft(
    promotionEnv,
    promotionIdentity,
    completeWinsFixture.draft.draftId,
    promotionInputFor(completeWinsFixture, 'approved-promotion-complete-01'),
    approvedOrigin,
    currentNow += 1
);
assert.equal(completeWinsPromotion.ok, false);
assert.equal(completeWinsCleanupResult.ok, true, JSON.stringify(completeWinsCleanupResult));
assert.equal(approved.objects.size, 0);
assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM draft_photo_promotion_cleanup_objects
    WHERE cleanup_id = (
        SELECT cleanup_id FROM draft_photo_promotion_cleanups WHERE draft_id = ?
    ) AND original_object_status = 'part-uploaded'
      AND provider_terminal_kind = 'completed'
      AND observed_object_version_hash IS NOT NULL
      AND observed_etag_hash IS NOT NULL
      AND status = 'absent'
`).get(completeWinsFixture.draft.draftId).count, 1);
assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM draft_transition_receipts " +
    "WHERE draft_id = ? AND to_state = 'candidate-public'"
).get(completeWinsFixture.draft.draftId).count, 0);

// A lost abort response is retryable. The first call leaves the durable D1
// closure in place; the exact retry sees NoSuchUpload, proves absence, and
// writes one tombstone.
const lostAbortFixture = await stageSyntheticProcessingRun('approved-cleanup-lost-abort');
approved.beforeNextComplete = () => {
    throw providerError('SyntheticApprovedCompletionPaused', 29991);
};
const pausedLostAbortPromotion = await promotePhotoDraft(
    promotionEnv,
    promotionIdentity,
    lostAbortFixture.draft.draftId,
    promotionInputFor(lostAbortFixture, 'approved-promotion-lost-abort'),
    approvedOrigin,
    currentNow += 1
);
assert.equal(pausedLostAbortPromotion.ok, false);
const lostAbortPromotionId = promotionIdForDraft(lostAbortFixture.draft.draftId);
const lostAbortInput = cleanupInputFor(
    lostAbortFixture,
    'approved-cleanup-lost-abort-01'
);
approved.failAfterNextAbort = true;
const lostAbortFirst = await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    lostAbortPromotionId,
    lostAbortInput,
    currentNow += 1
);
assert.deepEqual(lostAbortFirst, { ok: false, status: 503, code: 'service-unavailable' });
assert.equal(sqlite.prepare(
    'SELECT status FROM draft_photo_promotion_cleanups WHERE promotion_id = ?'
).get(lostAbortPromotionId).status, 'closing');
const lostAbortRetry = await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    lostAbortPromotionId,
    lostAbortInput,
    currentNow += 1
);
assert.equal(lostAbortRetry.ok, true, JSON.stringify(lostAbortRetry));
assert.equal(lostAbortRetry.status, 200);
assert.equal(lostAbortRetry.replayed, true);

// A completed candidate exercises the destructive response-loss boundary.
// The exact object and its version/ETag hashes are authorized in D1 before the
// delete. If the provider response is lost, retry observes absence without
// inventing a successful deletion timestamp.
const lostDeleteFixture = await stageSyntheticProcessingRun('approved-cleanup-lost-delete');
const lostDeletePromoted = await promoteStagedFixture(
    lostDeleteFixture,
    'approved-promotion-lost-delete'
);
const lostDeleteStateVersion = transitionDraftDirect(
    sqlite,
    lostDeleteFixture.draft.draftId,
    'withdrawal-pending'
);
const lostDeleteInput = {
    expectedStateVersion: lostDeleteStateVersion,
    idempotencyKey: 'approved-cleanup-lost-delete-01'
};
approved.failAfterNextDelete = true;
const lostDeleteFirst = await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    lostDeletePromoted.candidate.operationId,
    lostDeleteInput,
    currentNow += 1
);
assert.deepEqual(lostDeleteFirst, { ok: false, status: 503, code: 'service-unavailable' });
assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM draft_photo_promotion_cleanup_objects
    WHERE cleanup_id = (
        SELECT cleanup_id FROM draft_photo_promotion_cleanups WHERE promotion_id = ?
    ) AND status = 'delete-ready'
      AND observed_object_version_hash IS NOT NULL
      AND delete_authorized_at IS NOT NULL
`).get(lostDeletePromoted.candidate.operationId).count, 1);
const lostDeleteRetry = await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    lostDeletePromoted.candidate.operationId,
    lostDeleteInput,
    currentNow += 1
);
assert.equal(lostDeleteRetry.ok, true, JSON.stringify(lostDeleteRetry));
assert.equal(lostDeleteRetry.replayed, true);
assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM draft_photo_promotion_cleanup_objects
    WHERE cleanup_id = (
        SELECT cleanup_id FROM draft_photo_promotion_cleanups WHERE promotion_id = ?
    ) AND status = 'absent'
      AND observed_object_version_hash IS NOT NULL
      AND delete_authorized_at IS NOT NULL
      AND deleted_at IS NULL
`).get(lostDeletePromoted.candidate.operationId).count, 1);
const lostDeleteStagingCleanup = await cleanupRun(
    lostDeleteFixture.run.processingRunId,
    lostDeleteStateVersion,
    'approved-post-lost-delete-staging-cleanup'
);
assert.equal(lostDeleteStagingCleanup.status, 201, await lostDeleteStagingCleanup.clone().text());

// Cleanup never deletes an object that no longer matches the exact version,
// ETag, bytes, dimensions, or metadata promoted by this draft. A caller also
// cannot add a role, destination, reason, key, or URL to narrow that whole-item
// cleanup request.
const changedCleanupFixture = await stageSyntheticProcessingRun('approved-cleanup-changed');
const changedCleanupPromoted = await promoteStagedFixture(
    changedCleanupFixture,
    'approved-promotion-changed-object'
);
const changedCleanupStateVersion = transitionDraftDirect(
    sqlite,
    changedCleanupFixture.draft.draftId,
    'withdrawal-pending'
);
const changedCleanupInput = {
    expectedStateVersion: changedCleanupStateVersion,
    idempotencyKey: 'approved-cleanup-changed-object'
};
for (const callerSelectedField of [
    { role: 'photo-display' },
    { site: 'everyone' },
    { siteMode: 'everyone' },
    { destination: 'everyone' },
    { cleanupReason: 'athlete-exclusion' },
    { withdrawalKind: 'consent-withdrawal' },
    { approvedObjectKey: 'media/v1/caller-selected/display.webp' },
    { url: 'https://caller-selected.example/media.webp' }
]) {
    const callsBeforeInvalidCleanup = approved.calls.length;
    assert.deepEqual(await cleanupPhotoPromotion(
        promotionEnv,
        promotionIdentity,
        changedCleanupPromoted.candidate.operationId,
        { ...changedCleanupInput, ...callerSelectedField },
        currentNow += 1
    ), { ok: false, status: 400, code: 'invalid-request' });
    assert.equal(approved.calls.length, callsBeforeInvalidCleanup);
}
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM draft_photo_promotion_cleanups WHERE promotion_id = ?'
).get(changedCleanupPromoted.candidate.operationId).count, 0);
const changedCleanupKey = new URL(
    changedCleanupPromoted.candidate.draft.manifestItem.sourceUrl
).pathname.slice(1);
const originalChangedCleanupObject = approved.objects.get(changedCleanupKey);
assert.ok(originalChangedCleanupObject);
const replacementChangedCleanupObject = {
    ...originalChangedCleanupObject,
    bytes: thumbnailBytes.slice(),
    etag: 'approved-foreign-replacement-etag',
    version: 'approved-foreign-replacement-version'
};
approved.objects.set(changedCleanupKey, replacementChangedCleanupObject);
const changedCleanupDeleteCount = approved.calls.filter(call =>
    call.operation === 'delete' && call.key === changedCleanupKey
).length;
const changedCleanupFirst = await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    changedCleanupPromoted.candidate.operationId,
    changedCleanupInput,
    currentNow += 1
);
assert.deepEqual(changedCleanupFirst, {
    ok: false,
    status: 409,
    code: 'approved-object-conflict'
});
assert.equal(approved.objects.get(changedCleanupKey), replacementChangedCleanupObject);
assert.equal(approved.calls.filter(call =>
    call.operation === 'delete' && call.key === changedCleanupKey
).length, changedCleanupDeleteCount);
approved.objects.set(changedCleanupKey, originalChangedCleanupObject);
const changedCleanupRetry = await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    changedCleanupPromoted.candidate.operationId,
    changedCleanupInput,
    currentNow += 1
);
assert.equal(changedCleanupRetry.ok, true, JSON.stringify(changedCleanupRetry));
assert.equal(changedCleanupRetry.status, 200);
assert.equal(changedCleanupRetry.replayed, true);

// A D1 batch can commit successfully even when its acknowledgement is lost.
// Creation replay must adopt that exact closure instead of starting a second
// cleanup or repeating any provider deletion.
const lostCleanupCreationFixture = await stageSyntheticProcessingRun(
    'approved-cleanup-lost-creation'
);
const lostCleanupCreationPromoted = await promoteStagedFixture(
    lostCleanupCreationFixture,
    'approved-promotion-lost-creation'
);
const lostCleanupCreationStateVersion = transitionDraftDirect(
    sqlite,
    lostCleanupCreationFixture.draft.draftId,
    'withdrawal-pending'
);
d1.failAfterNextBatch = true;
const lostCleanupCreationResult = await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    lostCleanupCreationPromoted.candidate.operationId,
    {
        expectedStateVersion: lostCleanupCreationStateVersion,
        idempotencyKey: 'approved-cleanup-lost-creation'
    },
    currentNow += 1
);
assert.equal(lostCleanupCreationResult.ok, true, JSON.stringify(lostCleanupCreationResult));
assert.equal(lostCleanupCreationResult.status, 200);
assert.equal(lostCleanupCreationResult.replayed, true);
assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM gallery_photo_promotion_cleanup_tombstones
    WHERE promotion_id_hash = (
        SELECT promotion_id_hash FROM draft_photo_promotion_cleanups
        WHERE promotion_id = ?
    )
`).get(lostCleanupCreationPromoted.candidate.operationId).count, 1);

// The same recovery rule applies to a terminal multipart update. The provider
// abort/NoSuchUpload fact is committed once; a lost D1 response leaves the
// closure retryable and cannot reopen candidate generation.
const lostTerminalFixture = await stageSyntheticProcessingRun('approved-cleanup-lost-terminal');
const lostTerminalPromoted = await promoteStagedFixture(
    lostTerminalFixture,
    'approved-promotion-lost-terminal'
);
const lostTerminalStateVersion = transitionDraftDirect(
    sqlite,
    lostTerminalFixture.draft.draftId,
    'withdrawal-pending'
);
d1.beforeRunContaining = {
    needle: "SET status = 'terminal', provider_terminal_kind",
    callback: () => {
        d1.failAfterNextBatch = true;
    }
};
const lostTerminalInput = {
    expectedStateVersion: lostTerminalStateVersion,
    idempotencyKey: 'approved-cleanup-lost-terminal'
};
const lostTerminalFirst = await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    lostTerminalPromoted.candidate.operationId,
    lostTerminalInput,
    currentNow += 1
);
assert.deepEqual(lostTerminalFirst, {
    ok: false,
    status: 503,
    code: 'service-unavailable'
});
assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM draft_photo_promotion_cleanup_objects
    WHERE cleanup_id = (
        SELECT cleanup_id FROM draft_photo_promotion_cleanups WHERE promotion_id = ?
    ) AND status = 'terminal'
`).get(lostTerminalPromoted.candidate.operationId).count, 1);
const lostTerminalRetry = await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    lostTerminalPromoted.candidate.operationId,
    lostTerminalInput,
    currentNow += 1
);
assert.equal(lostTerminalRetry.ok, true, JSON.stringify(lostTerminalRetry));
assert.equal(lostTerminalRetry.status, 200);
assert.equal(lostTerminalRetry.replayed, true);

// Finalization is one transactional D1 batch. If its response is lost after
// commit, replay observes exactly one cleaned row and tombstone rather than
// trying to recreate operational promotion evidence.
const lostFinalFixture = await stageSyntheticProcessingRun('approved-cleanup-lost-final');
const lostFinalPromoted = await promoteStagedFixture(
    lostFinalFixture,
    'approved-promotion-lost-final'
);
const lostFinalStateVersion = transitionDraftDirect(
    sqlite,
    lostFinalFixture.draft.draftId,
    'withdrawal-pending'
);
d1.beforeRunContaining = {
    needle: "SET status = 'cleaned', cleanup_evidence_hash",
    callback: () => {
        d1.failAfterNextBatch = true;
    }
};
const lostFinalResult = await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    lostFinalPromoted.candidate.operationId,
    {
        expectedStateVersion: lostFinalStateVersion,
        idempotencyKey: 'approved-cleanup-lost-final'
    },
    currentNow += 1
);
assert.equal(lostFinalResult.ok, true, JSON.stringify(lostFinalResult));
assert.equal(lostFinalResult.status, 201);
assert.equal(lostFinalResult.replayed, false);
assert.deepEqual({ ...sqlite.prepare(`
    SELECT cleanup.status,
           (SELECT COUNT(*) FROM gallery_photo_promotion_cleanup_tombstones AS tombstone
            WHERE tombstone.promotion_id_hash = cleanup.promotion_id_hash) AS tombstones
    FROM draft_photo_promotion_cleanups AS cleanup
    WHERE cleanup.promotion_id = ?
`).get(lostFinalPromoted.candidate.operationId) }, {
    status: 'cleaned',
    tombstones: 1
});

// Absence proof uses the exact full object key as the R2 list prefix and must
// read every page. An object discovered on a later page is a foreign-object
// conflict: cleanup leaves it untouched and succeeds only after a clean retry.
const lateListedFixture = await stageSyntheticProcessingRun('approved-cleanup-late-list');
const lateListedPromoted = await promoteStagedFixture(
    lateListedFixture,
    'approved-promotion-late-list'
);
const lateListedStateVersion = transitionDraftDirect(
    sqlite,
    lateListedFixture.draft.draftId,
    'withdrawal-pending'
);
const lateListedKey = new URL(
    lateListedPromoted.candidate.draft.manifestItem.sourceUrl
).pathname.slice(1);
approved.scriptedListResponses = [
    {
        objects: [],
        delimitedPrefixes: [],
        truncated: true,
        cursor: 'approved-late-list-page-2'
    },
    {
        objects: [{ key: `${lateListedKey}-foreign` }],
        delimitedPrefixes: [],
        truncated: false
    }
];
const lateListedCallsStart = approved.calls.length;
const lateListedInput = {
    expectedStateVersion: lateListedStateVersion,
    idempotencyKey: 'approved-cleanup-late-list'
};
const lateListedFirst = await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    lateListedPromoted.candidate.operationId,
    lateListedInput,
    currentNow += 1
);
assert.deepEqual(lateListedFirst, {
    ok: false,
    status: 409,
    code: 'approved-object-conflict'
});
assert.deepEqual(approved.calls.slice(lateListedCallsStart).filter(call =>
    call.operation === 'list'
).map(call => ({ prefix: call.prefix, cursor: call.cursor })), [
    { prefix: lateListedKey, cursor: null },
    { prefix: lateListedKey, cursor: 'approved-late-list-page-2' }
]);
assert.equal(approved.calls.slice(lateListedCallsStart).filter(call =>
    call.operation === 'delete' && call.key === `${lateListedKey}-foreign`
).length, 0);
approved.scriptedListResponses = [];
const lateListedRetry = await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    lateListedPromoted.candidate.operationId,
    lateListedInput,
    currentNow += 1
);
assert.equal(lateListedRetry.ok, true, JSON.stringify(lateListedRetry));
assert.equal(lateListedRetry.status, 200);

// A malformed or repeating provider cursor is not evidence of a foreign
// object and is not evidence of absence. It is a retryable provider failure.
const malformedListFixture = await stageSyntheticProcessingRun(
    'approved-cleanup-malformed-list'
);
const malformedListPromoted = await promoteStagedFixture(
    malformedListFixture,
    'approved-promotion-malformed-list'
);
const malformedListStateVersion = transitionDraftDirect(
    sqlite,
    malformedListFixture.draft.draftId,
    'withdrawal-pending'
);
approved.scriptedListResponses = [
    {
        objects: [],
        delimitedPrefixes: [],
        truncated: true,
        cursor: 'approved-repeated-cursor'
    },
    {
        objects: [],
        delimitedPrefixes: [],
        truncated: true,
        cursor: 'approved-repeated-cursor'
    }
];
const malformedListInput = {
    expectedStateVersion: malformedListStateVersion,
    idempotencyKey: 'approved-cleanup-malformed-list'
};
const malformedListFirst = await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    malformedListPromoted.candidate.operationId,
    malformedListInput,
    currentNow += 1
);
assert.deepEqual(malformedListFirst, {
    ok: false,
    status: 503,
    code: 'service-unavailable'
});
for (const malformedListing of [
    null,
    { delimitedPrefixes: [], truncated: false },
    { objects: [], delimitedPrefixes: null, truncated: false },
    { objects: [], delimitedPrefixes: [], truncated: 'false' }
]) {
    approved.scriptedListResponses = [malformedListing];
    assert.deepEqual(await cleanupPhotoPromotion(
        promotionEnv,
        promotionIdentity,
        malformedListPromoted.candidate.operationId,
        malformedListInput,
        currentNow += 1
    ), {
        ok: false,
        status: 503,
        code: 'service-unavailable'
    });
}
approved.scriptedListResponses = [{
    objects: [],
    delimitedPrefixes: ['media/v1/foreign-prefix/'],
    truncated: false
}];
assert.deepEqual(await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    malformedListPromoted.candidate.operationId,
    malformedListInput,
    currentNow += 1
), {
    ok: false,
    status: 409,
    code: 'approved-object-conflict'
});
approved.scriptedListResponses = Array.from({ length: 256 }, (_, index) => ({
    objects: [],
    delimitedPrefixes: [],
    truncated: true,
    cursor: `approved-page-cap-${index + 1}`
}));
assert.deepEqual(await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    malformedListPromoted.candidate.operationId,
    malformedListInput,
    currentNow += 1
), {
    ok: false,
    status: 503,
    code: 'service-unavailable'
});
approved.scriptedListResponses = [];
const malformedListRetry = await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    malformedListPromoted.candidate.operationId,
    malformedListInput,
    currentNow += 1
);
assert.equal(malformedListRetry.ok, true, JSON.stringify(malformedListRetry));
assert.equal(malformedListRetry.status, 200);

// Response loss at the closing -> deleting checkpoint cannot reopen either
// multipart handle. The committed deleting state is adopted on exact retry.
const lostDeletingFixture = await stageSyntheticProcessingRun(
    'approved-cleanup-lost-deleting'
);
const lostDeletingPromoted = await promoteStagedFixture(
    lostDeletingFixture,
    'approved-promotion-lost-deleting'
);
const lostDeletingStateVersion = transitionDraftDirect(
    sqlite,
    lostDeletingFixture.draft.draftId,
    'withdrawal-pending'
);
d1.beforeRunContaining = {
    needle: "SET status = 'deleting', updated_at",
    callback: () => {
        d1.failAfterNextBatch = true;
    }
};
const lostDeletingInput = {
    expectedStateVersion: lostDeletingStateVersion,
    idempotencyKey: 'approved-cleanup-lost-deleting'
};
const lostDeletingFirst = await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    lostDeletingPromoted.candidate.operationId,
    lostDeletingInput,
    currentNow += 1
);
assert.deepEqual(lostDeletingFirst, {
    ok: false,
    status: 503,
    code: 'service-unavailable'
});
assert.equal(sqlite.prepare(
    'SELECT status FROM draft_photo_promotion_cleanups WHERE promotion_id = ?'
).get(lostDeletingPromoted.candidate.operationId).status, 'deleting');
const lostDeletingRetry = await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    lostDeletingPromoted.candidate.operationId,
    lostDeletingInput,
    currentNow += 1
);
assert.equal(lostDeletingRetry.ok, true, JSON.stringify(lostDeletingRetry));
assert.equal(lostDeletingRetry.status, 200);

// Delete authorization is durable before R2 deletion. If that D1 response is
// lost, a replacement object appearing before retry is re-read and refused;
// it is never deleted under the old authorization.
const lostAuthorizationFixture = await stageSyntheticProcessingRun(
    'approved-cleanup-lost-authorization'
);
const lostAuthorizationPromoted = await promoteStagedFixture(
    lostAuthorizationFixture,
    'approved-promotion-lost-authorization'
);
const lostAuthorizationStateVersion = transitionDraftDirect(
    sqlite,
    lostAuthorizationFixture.draft.draftId,
    'withdrawal-pending'
);
d1.beforeRunContaining = {
    needle: "SET status = 'delete-ready', observed_object_version_hash",
    callback: () => {
        d1.failAfterNextBatch = true;
    }
};
const lostAuthorizationInput = {
    expectedStateVersion: lostAuthorizationStateVersion,
    idempotencyKey: 'approved-cleanup-lost-authorization'
};
const lostAuthorizationFirst = await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    lostAuthorizationPromoted.candidate.operationId,
    lostAuthorizationInput,
    currentNow += 1
);
assert.deepEqual(lostAuthorizationFirst, {
    ok: false,
    status: 503,
    code: 'service-unavailable'
});
const lostAuthorizationKey = new URL(
    lostAuthorizationPromoted.candidate.draft.manifestItem.sourceUrl
).pathname.slice(1);
const exactAuthorizedObject = approved.objects.get(lostAuthorizationKey);
assert.ok(exactAuthorizedObject);
const foreignAfterAuthorization = {
    ...exactAuthorizedObject,
    etag: 'approved-after-authorization-etag',
    version: 'approved-after-authorization-version'
};
approved.objects.set(lostAuthorizationKey, foreignAfterAuthorization);
const lostAuthorizationDeleteCount = approved.calls.filter(call =>
    call.operation === 'delete' && call.key === lostAuthorizationKey
).length;
const changedAfterAuthorization = await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    lostAuthorizationPromoted.candidate.operationId,
    lostAuthorizationInput,
    currentNow += 1
);
assert.deepEqual(changedAfterAuthorization, {
    ok: false,
    status: 409,
    code: 'approved-object-conflict'
});
assert.equal(approved.objects.get(lostAuthorizationKey), foreignAfterAuthorization);
assert.equal(approved.calls.filter(call =>
    call.operation === 'delete' && call.key === lostAuthorizationKey
).length, lostAuthorizationDeleteCount);
approved.objects.set(lostAuthorizationKey, exactAuthorizedObject);
const lostAuthorizationRetry = await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    lostAuthorizationPromoted.candidate.operationId,
    lostAuthorizationInput,
    currentNow += 1
);
assert.equal(lostAuthorizationRetry.ok, true, JSON.stringify(lostAuthorizationRetry));
assert.equal(lostAuthorizationRetry.status, 200);

// If the provider delete and the following D1 absence update both commit but
// the D1 acknowledgement is lost, retry keeps the first role absent and
// completes the other role without inventing another deletion.
const lostAbsenceFixture = await stageSyntheticProcessingRun('approved-cleanup-lost-absence');
const lostAbsencePromoted = await promoteStagedFixture(
    lostAbsenceFixture,
    'approved-promotion-lost-absence'
);
const lostAbsenceStateVersion = transitionDraftDirect(
    sqlite,
    lostAbsenceFixture.draft.draftId,
    'withdrawal-pending'
);
d1.beforeRunContaining = {
    needle: 'SET approved_object_key = NULL, provider_upload_id = NULL',
    callback: () => {
        d1.failAfterNextBatch = true;
    }
};
const lostAbsenceInput = {
    expectedStateVersion: lostAbsenceStateVersion,
    idempotencyKey: 'approved-cleanup-lost-absence'
};
const lostAbsenceFirst = await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    lostAbsencePromoted.candidate.operationId,
    lostAbsenceInput,
    currentNow += 1
);
assert.deepEqual(lostAbsenceFirst, {
    ok: false,
    status: 503,
    code: 'service-unavailable'
});
assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM draft_photo_promotion_cleanup_objects
    WHERE cleanup_id = (
        SELECT cleanup_id FROM draft_photo_promotion_cleanups WHERE promotion_id = ?
    ) AND status = 'absent'
`).get(lostAbsencePromoted.candidate.operationId).count, 1);
const lostAbsenceRetry = await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    lostAbsencePromoted.candidate.operationId,
    lostAbsenceInput,
    currentNow += 1
);
assert.equal(lostAbsenceRetry.ok, true, JSON.stringify(lostAbsenceRetry));
assert.equal(lostAbsenceRetry.status, 200);

// If a tagged-athlete exclusion and actual consent withdrawal are both
// current when storage cleanup is claimed, consent remains the stronger
// classification. This classification never weakens the independent private-
// original deletion guard.
const consentPriorityFixture = await stageSyntheticProcessingRun(
    'approved-cleanup-consent-priority'
);
const consentPriorityPromoted = await promoteStagedFixture(
    consentPriorityFixture,
    'approved-promotion-consent-priority'
);
const consentPriorityStateVersion = transitionDraftDirect(
    sqlite,
    consentPriorityFixture.draft.draftId,
    'withdrawal-pending'
);
sqlite.prepare(`
    INSERT INTO draft_publication_references (
        draft_id, withdrawal_kind, updated_at
    ) VALUES (?, 'consent-withdrawal', ?)
`).run(
    consentPriorityFixture.draft.draftId,
    new Date(currentNow += 1).toISOString()
);
insertPendingExclusion(sqlite, selectedResult.athleteId, catalog.suppressionRevision);
const consentPriorityCleanup = await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    consentPriorityPromoted.candidate.operationId,
    {
        expectedStateVersion: consentPriorityStateVersion,
        idempotencyKey: 'approved-cleanup-consent-priority'
    },
    currentNow += 1
);
assert.equal(consentPriorityCleanup.ok, true, JSON.stringify({
    consentPriorityCleanup,
    lastD1Error: d1.lastError?.message
}));
assert.equal(consentPriorityCleanup.cleanupReason, 'withdrawal');
assert.deepEqual({ ...sqlite.prepare(`
    SELECT cleanup_reason AS cleanupReason, withdrawal_kind AS withdrawalKind
    FROM draft_photo_promotion_cleanups WHERE promotion_id = ?
`).get(consentPriorityPromoted.candidate.operationId) }, {
    cleanupReason: 'withdrawal',
    withdrawalKind: 'consent-withdrawal'
});
assert.deepEqual({ ...sqlite.prepare(`
    SELECT publication.host_deletion_confirmed AS hostDeleted,
           publication.private_original_deletion_confirmed AS originalDeleted,
           upload.status AS originalStatus
    FROM draft_publication_references AS publication
    JOIN draft_upload_sessions AS upload ON upload.draft_id = publication.draft_id
    WHERE publication.draft_id = ?
`).get(consentPriorityFixture.draft.draftId) }, {
    hostDeleted: 0,
    originalDeleted: 0,
    originalStatus: 'complete'
});
assert.throws(
    () => sqlite.prepare(`
        UPDATE draft_publication_references
        SET withdrawal_kind = 'athlete-exclusion'
        WHERE draft_id = ?
    `).run(consentPriorityFixture.draft.draftId),
    /withdrawal intent cannot be cleared or downgraded/i
);
resolvePendingExclusion(sqlite, selectedResult.athleteId, catalog.suppressionRevision);
sqlite.prepare('DELETE FROM pending_athlete_exclusions WHERE athlete_id = ?')
    .run(selectedResult.athleteId);

// Consent intent can also arrive after an exclusion cleanup has already been
// claimed. The cleanup's historical reason stays immutable, while the current
// publication intent escalates one-way and continues to require private-
// original deletion plus separate public-host proof.
const consentEscalationFixture = await stageSyntheticProcessingRun(
    'approved-cleanup-consent-escalation'
);
const consentEscalationPromoted = await promoteStagedFixture(
    consentEscalationFixture,
    'approved-promotion-consent-escalation'
);
const consentEscalationStateVersion = transitionDraftDirect(
    sqlite,
    consentEscalationFixture.draft.draftId,
    'withdrawal-pending'
);
sqlite.prepare(`
    INSERT INTO draft_publication_references (
        draft_id, withdrawal_kind, updated_at
    ) VALUES (?, 'athlete-exclusion', ?)
`).run(
    consentEscalationFixture.draft.draftId,
    new Date(currentNow += 1).toISOString()
);
insertPendingExclusion(sqlite, selectedResult.athleteId, catalog.suppressionRevision);
d1.beforeRunContaining = {
    needle: "SET status = 'terminal', provider_terminal_kind",
    callback: () => {
        sqlite.prepare(`
            UPDATE draft_publication_references
            SET withdrawal_kind = 'consent-withdrawal', updated_at = ?
            WHERE draft_id = ? AND withdrawal_kind = 'athlete-exclusion'
        `).run(
            new Date(currentNow += 1).toISOString(),
            consentEscalationFixture.draft.draftId
        );
    }
};
const consentEscalationCleanup = await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    consentEscalationPromoted.candidate.operationId,
    {
        expectedStateVersion: consentEscalationStateVersion,
        idempotencyKey: 'approved-cleanup-consent-escalation'
    },
    currentNow += 1
);
assert.equal(consentEscalationCleanup.ok, true, JSON.stringify(consentEscalationCleanup));
assert.equal(consentEscalationCleanup.cleanupReason, 'athlete-exclusion');
assert.deepEqual({ ...sqlite.prepare(`
    SELECT publication.withdrawal_kind AS withdrawalKind,
           publication.host_deletion_confirmed AS hostDeleted,
           publication.private_original_deletion_confirmed AS originalDeleted,
           upload.status AS originalStatus
    FROM draft_publication_references AS publication
    JOIN draft_upload_sessions AS upload ON upload.draft_id = publication.draft_id
    WHERE publication.draft_id = ?
`).get(consentEscalationFixture.draft.draftId) }, {
    withdrawalKind: 'consent-withdrawal',
    hostDeleted: 0,
    originalDeleted: 0,
    originalStatus: 'complete'
});
assert.throws(
    () => sqlite.prepare(`
        UPDATE gallery_drafts
        SET state = 'withdrawn', state_version = state_version + 1,
            updated_at = ?
        WHERE draft_id = ? AND state = 'withdrawal-pending'
    `).run(
        new Date(currentNow += 1).toISOString(),
        consentEscalationFixture.draft.draftId
    ),
    /current verified withdrawal evidence is required/i
);
resolvePendingExclusion(sqlite, selectedResult.athleteId, catalog.suppressionRevision);
sqlite.prepare('DELETE FROM pending_athlete_exclusions WHERE athlete_id = ?')
    .run(selectedResult.athleteId);

// Isolate the strongest consent-withdrawal condition. With approved and staged
// media already absent, genuine withdrawn consent, the correct withdrawal kind,
// and independent public-host proof, the draft must still remain pending while
// its private original is complete. Only exact original-deletion evidence may
// unlock the final transition.
const privateOriginalGuardFixture = await stageSyntheticProcessingRun(
    'approved-cleanup-private-original-guard'
);
const privateOriginalGuardPromoted = await promoteStagedFixture(
    privateOriginalGuardFixture,
    'approved-promotion-private-original-guard'
);
const privateOriginalGuardStateVersion = transitionDraftDirect(
    sqlite,
    privateOriginalGuardFixture.draft.draftId,
    'withdrawal-pending'
);
sqlite.prepare(`
    INSERT INTO draft_publication_references (
        draft_id, host_deletion_confirmed,
        private_original_deletion_confirmed,
        withdrawal_kind, updated_at
    ) VALUES (?, 0, 0, 'consent-withdrawal', ?)
`).run(
    privateOriginalGuardFixture.draft.draftId,
    new Date(currentNow += 1).toISOString()
);
const privateOriginalGuardApprovedCleanup = await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    privateOriginalGuardPromoted.candidate.operationId,
    {
        expectedStateVersion: privateOriginalGuardStateVersion,
        idempotencyKey: 'approved-cleanup-private-original-guard'
    },
    currentNow += 1
);
assert.equal(
    privateOriginalGuardApprovedCleanup.ok,
    true,
    JSON.stringify(privateOriginalGuardApprovedCleanup)
);
const privateOriginalGuardStagingCleanup = await cleanupRun(
    privateOriginalGuardFixture.run.processingRunId,
    privateOriginalGuardStateVersion,
    'approved-staging-cleanup-private-original-guard'
);
assert.equal(
    privateOriginalGuardStagingCleanup.status,
    201,
    await privateOriginalGuardStagingCleanup.clone().text()
);
sqlite.prepare(`
    UPDATE draft_publication_references
    SET host_deletion_confirmed = 1, updated_at = ?
    WHERE draft_id = ? AND withdrawal_kind = 'consent-withdrawal'
`).run(
    new Date(currentNow += 1).toISOString(),
    privateOriginalGuardFixture.draft.draftId
);
// The ordinary consent-update guard already rejects this invalid ordering. Use
// a rolled-back fault probe to bypass only that earlier guard and prove the
// final draft-state guard independently rejects the same missing evidence.
sqlite.exec('SAVEPOINT private_original_withdrawal_guard_probe');
try {
    sqlite.exec('DROP TRIGGER draft_consent_withdrawal_evidence_guard');
    sqlite.exec('DROP TRIGGER gallery_drafts_processing_revision_change_guard');
    withdrawActiveConsent(sqlite, privateOriginalGuardFixture.draft.draftId);
    assert.deepEqual({ ...sqlite.prepare(`
        SELECT draft.state, draft.state_version AS stateVersion,
               publication.host_deletion_confirmed AS hostDeleted,
               publication.private_original_deletion_confirmed AS originalDeleted,
               upload.status AS originalStatus,
               (SELECT COUNT(*) FROM draft_derivatives AS derivative
                 WHERE derivative.draft_id = draft.draft_id
                   AND derivative.approved_object_key IS NOT NULL) AS approvedReferences
        FROM gallery_drafts AS draft
        JOIN draft_publication_references AS publication
          ON publication.draft_id = draft.draft_id
        JOIN draft_upload_sessions AS upload ON upload.draft_id = draft.draft_id
        WHERE draft.draft_id = ?
    `).get(privateOriginalGuardFixture.draft.draftId) }, {
        state: 'withdrawal-pending',
        stateVersion: privateOriginalGuardStateVersion,
        hostDeleted: 1,
        originalDeleted: 0,
        originalStatus: 'complete',
        approvedReferences: 0
    });
    assert.throws(
        () => sqlite.prepare(`
            UPDATE gallery_drafts
            SET state = 'withdrawn', state_version = state_version + 1,
                updated_at = ?
            WHERE draft_id = ? AND state = 'withdrawal-pending'
        `).run(
            new Date(currentNow += 1).toISOString(),
            privateOriginalGuardFixture.draft.draftId
        ),
        /current verified withdrawal evidence is required/i
    );
} finally {
    sqlite.exec('ROLLBACK TO private_original_withdrawal_guard_probe');
    sqlite.exec('RELEASE private_original_withdrawal_guard_probe');
}
assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type = 'trigger' AND name IN (
        'draft_consent_withdrawal_evidence_guard',
        'gallery_drafts_processing_revision_change_guard'
    )
`).get().count, 2);
markPrivateOriginalDeleted(sqlite, privateOriginalGuardFixture.draft.draftId);
sqlite.prepare(`
    UPDATE draft_publication_references
    SET private_original_deletion_confirmed = 1, updated_at = ?
    WHERE draft_id = ? AND host_deletion_confirmed = 1
      AND withdrawal_kind = 'consent-withdrawal'
`).run(
    new Date(currentNow += 1).toISOString(),
    privateOriginalGuardFixture.draft.draftId
);
withdrawActiveConsent(sqlite, privateOriginalGuardFixture.draft.draftId);
transitionDraftDirect(sqlite, privateOriginalGuardFixture.draft.draftId, 'withdrawn');
assert.equal(sqlite.prepare(
    'SELECT state FROM gallery_drafts WHERE draft_id = ?'
).get(privateOriginalGuardFixture.draft.draftId).state, 'withdrawn');

// Completion must be strictly later than every per-object absence proof. Stop
// one cleanup just before its final transaction, recreate all other required
// final state inside a savepoint, and prove an equal timestamp is rejected.
const equalChronologyFixture = await stageSyntheticProcessingRun(
    'approved-cleanup-equal-chronology'
);
const equalChronologyPromoted = await promoteStagedFixture(
    equalChronologyFixture,
    'approved-promotion-equal-time'
);
const equalChronologyStateVersion = transitionDraftDirect(
    sqlite,
    equalChronologyFixture.draft.draftId,
    'withdrawal-pending'
);
const equalChronologyInput = {
    expectedStateVersion: equalChronologyStateVersion,
    idempotencyKey: 'approved-cleanup-equal-time'
};
d1.failNextRunContaining = 'INSERT INTO gallery_photo_promotion_cleanup_tombstones';
assert.deepEqual(await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    equalChronologyPromoted.candidate.operationId,
    equalChronologyInput,
    currentNow += 1
), {
    ok: false,
    status: 503,
    code: 'service-unavailable'
});
const equalChronologyCleanup = sqlite.prepare(`
    SELECT cleanup_id AS cleanupId, updated_at AS updatedAt,
           (SELECT MAX(absence_verified_at)
              FROM draft_photo_promotion_cleanup_objects AS object
             WHERE object.cleanup_id = cleanup.cleanup_id) AS latestAbsenceAt
    FROM draft_photo_promotion_cleanups AS cleanup
    WHERE promotion_id = ? AND status = 'deleting'
`).get(equalChronologyPromoted.candidate.operationId);
assert.ok(equalChronologyCleanup);
assert.ok(Date.parse(equalChronologyCleanup.latestAbsenceAt) >
    Date.parse(equalChronologyCleanup.updatedAt));
sqlite.exec('SAVEPOINT equal_cleanup_completion_probe');
try {
    sqlite.prepare(`
        UPDATE draft_derivatives SET approved_object_key = NULL
        WHERE draft_id = ? AND approved_object_key IS NOT NULL
    `).run(equalChronologyFixture.draft.draftId);
    sqlite.prepare(
        'DELETE FROM draft_photo_promotion_objects WHERE promotion_id = ?'
    ).run(equalChronologyPromoted.candidate.operationId);
    sqlite.prepare(
        'DELETE FROM draft_photo_promotions WHERE promotion_id = ?'
    ).run(equalChronologyPromoted.candidate.operationId);
    assert.throws(
        () => sqlite.prepare(`
            UPDATE draft_photo_promotion_cleanups
            SET status = 'cleaned', cleanup_evidence_hash = ?,
                updated_at = ?, completed_at = ?
            WHERE cleanup_id = ? AND status = 'deleting'
        `).run(
            'e'.repeat(64),
            equalChronologyCleanup.latestAbsenceAt,
            equalChronologyCleanup.latestAbsenceAt,
            equalChronologyCleanup.cleanupId
        ),
        /invalid photo promotion cleanup transition/i
    );
} finally {
    sqlite.exec('ROLLBACK TO equal_cleanup_completion_probe');
    sqlite.exec('RELEASE equal_cleanup_completion_probe');
}
const equalChronologyRetry = await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    equalChronologyPromoted.candidate.operationId,
    equalChronologyInput,
    currentNow += 1
);
assert.equal(equalChronologyRetry.ok, true, JSON.stringify(equalChronologyRetry));
assert.equal(equalChronologyRetry.status, 200);

// Finalization can be interrupted after both cleanup-object rows already say
// `absent`. Every resume must nevertheless re-prove current R2 absence. A valid
// exact object or any object under that exact-key prefix is a 409 ownership
// conflict and remains untouched; a malformed listing is a retryable 503.
const finalResumeFixture = await stageSyntheticProcessingRun(
    'approved-cleanup-final-resume'
);
const finalResumePromoted = await promoteStagedFixture(
    finalResumeFixture,
    'approved-promotion-final-resume'
);
const finalResumeStateVersion = transitionDraftDirect(
    sqlite,
    finalResumeFixture.draft.draftId,
    'withdrawal-pending'
);
const finalResumeInput = {
    expectedStateVersion: finalResumeStateVersion,
    idempotencyKey: 'approved-cleanup-final-resume'
};
d1.failNextRunContaining = 'INSERT INTO gallery_photo_promotion_cleanup_tombstones';
assert.deepEqual(await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    finalResumePromoted.candidate.operationId,
    finalResumeInput,
    currentNow += 1
), {
    ok: false,
    status: 503,
    code: 'service-unavailable'
});
assert.deepEqual({ ...sqlite.prepare(`
    SELECT cleanup.status,
           (SELECT COUNT(*) FROM draft_photo_promotion_cleanup_objects AS object
             WHERE object.cleanup_id = cleanup.cleanup_id
               AND object.status = 'absent') AS absentObjects,
           (SELECT COUNT(*) FROM gallery_photo_promotion_cleanup_tombstones AS tombstone
             WHERE tombstone.promotion_id_hash = cleanup.promotion_id_hash) AS tombstones
    FROM draft_photo_promotion_cleanups AS cleanup
    WHERE cleanup.promotion_id = ?
`).get(finalResumePromoted.candidate.operationId) }, {
    status: 'deleting',
    absentObjects: 2,
    tombstones: 0
});
const finalResumeKey = new URL(
    finalResumePromoted.candidate.draft.manifestItem.sourceUrl
).pathname.slice(1);
const finalResumeExactObject = approved.seedObject(finalResumeKey, displayBytes, {
    httpMetadata: { contentType: 'image/webp' },
    customMetadata: {
        contract: 'gallery-approved-media-v1',
        role: 'photo-display'
    }
});
const finalResumeDeleteCalls = approved.calls.filter(call =>
    call.operation === 'delete' && call.key === finalResumeKey
).length;
assert.deepEqual(await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    finalResumePromoted.candidate.operationId,
    finalResumeInput,
    currentNow += 1
), {
    ok: false,
    status: 409,
    code: 'approved-object-conflict'
});
assert.equal(approved.objects.get(finalResumeKey), finalResumeExactObject);
assert.equal(approved.calls.filter(call =>
    call.operation === 'delete' && call.key === finalResumeKey
).length, finalResumeDeleteCalls);
approved.objects.delete(finalResumeKey);

const finalResumePrefixKey = `${finalResumeKey}-reappeared`;
const finalResumePrefixObject = approved.seedObject(finalResumePrefixKey, displayBytes, {
    httpMetadata: { contentType: 'image/webp' },
    customMetadata: {
        contract: 'gallery-approved-media-v1',
        role: 'photo-display'
    }
});
assert.deepEqual(await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    finalResumePromoted.candidate.operationId,
    finalResumeInput,
    currentNow += 1
), {
    ok: false,
    status: 409,
    code: 'approved-object-conflict'
});
assert.equal(approved.objects.get(finalResumePrefixKey), finalResumePrefixObject);
assert.equal(approved.calls.some(call =>
    call.operation === 'delete' && call.key === finalResumePrefixKey
), false);
approved.objects.delete(finalResumePrefixKey);

approved.scriptedListResponses = [{
    objects: [],
    delimitedPrefixes: [],
    truncated: true
}];
assert.deepEqual(await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    finalResumePromoted.candidate.operationId,
    finalResumeInput,
    currentNow += 1
), {
    ok: false,
    status: 503,
    code: 'service-unavailable'
});
assert.deepEqual({ ...sqlite.prepare(`
    SELECT cleanup.status,
           (SELECT COUNT(*) FROM gallery_photo_promotion_cleanup_tombstones AS tombstone
             WHERE tombstone.promotion_id_hash = cleanup.promotion_id_hash) AS tombstones
    FROM draft_photo_promotion_cleanups AS cleanup
    WHERE cleanup.promotion_id = ?
`).get(finalResumePromoted.candidate.operationId) }, {
    status: 'deleting',
    tombstones: 0
});
approved.scriptedListResponses = [];
const finalResumeRetry = await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    finalResumePromoted.candidate.operationId,
    finalResumeInput,
    currentNow += 1
);
assert.equal(finalResumeRetry.ok, true, JSON.stringify(finalResumeRetry));
assert.equal(finalResumeRetry.status, 200);
assert.equal(finalResumeRetry.replayed, true);
const finalResumeStagingCleanup = await cleanupRun(
    finalResumeFixture.run.processingRunId,
    finalResumeStateVersion,
    'approved-staging-cleanup-final-resume'
);
assert.equal(
    finalResumeStagingCleanup.status,
    201,
    await finalResumeStagingCleanup.clone().text()
);

// A provider may create the handle but lose its response before the upload ID
// can be persisted. D1 deliberately remains `admitting`; neither elapsed time
// nor the lifecycle rule's eventual orphan removal can fabricate synchronous
// terminal evidence. This intentionally unresolved fixture runs last because
// its content-addressed keys must remain exclusively reserved.
const lostCreateFixture = await stageSyntheticProcessingRun('approved-lost-create');
const lostCreateInput = promotionInputFor(
    lostCreateFixture,
    'approved-promotion-lost-create'
);
const lostCreateCallsStart = approved.calls.length;
approved.failAfterNextCreate = true;
assert.deepEqual(await promotePhotoDraft(
    promotionEnv,
    promotionIdentity,
    lostCreateFixture.draft.draftId,
    lostCreateInput,
    approvedOrigin,
    currentNow += 1
), {
    ok: false,
    status: 503,
    code: 'service-unavailable'
});
const lostCreatePromotionId = promotionIdForDraft(lostCreateFixture.draft.draftId);
const lostCreateObject = sqlite.prepare(`
    SELECT status, provider_admission_token_hash AS admissionHash,
           provider_upload_id AS uploadId
    FROM draft_photo_promotion_objects
    WHERE promotion_id = ? AND role = 'photo-display'
`).get(lostCreatePromotionId);
assert.equal(lostCreateObject.status, 'admitting');
assert.match(lostCreateObject.admissionHash, /^[a-f0-9]{64}$/);
assert.equal(lostCreateObject.uploadId, null);
assert.equal(approved.uploads.size, 1);
assert.deepEqual(await cleanupActivePromotion(
    lostCreateFixture,
    'approved-cleanup-lost-create'
), {
    ok: false,
    status: 503,
    code: 'service-unavailable'
});
assert.deepEqual({ ...sqlite.prepare(`
    SELECT status,
           (SELECT COUNT(*)
              FROM gallery_photo_promotion_cleanup_tombstones AS tombstone
             WHERE tombstone.promotion_id_hash = cleanup.promotion_id_hash) AS tombstones
    FROM draft_photo_promotion_cleanups AS cleanup
    WHERE promotion_id = ?
`).get(lostCreatePromotionId) }, { status: 'closing', tombstones: 0 });

// Simulate the separate one-day R2 lifecycle removing the orphaned handle.
// The Workers API exposes no trusted multipart inventory proof here, so the
// unresolved D1 admission remains closed rather than being guessed away.
approved.uploads.clear();
assert.deepEqual(await cleanupPhotoPromotion(
    promotionEnv,
    promotionIdentity,
    lostCreatePromotionId,
    cleanupInputFor(lostCreateFixture, 'approved-cleanup-lost-create'),
    currentNow + 86_400_001
), {
    ok: false,
    status: 503,
    code: 'service-unavailable'
});
const lostCreateCallsBeforeReplay = approved.calls.length;
assert.deepEqual(await promotePhotoDraft(
    promotionEnv,
    promotionIdentity,
    lostCreateFixture.draft.draftId,
    lostCreateInput,
    approvedOrigin,
    currentNow += 1
), {
    ok: false,
    status: 409,
    code: 'promotion-not-eligible'
});
assert.equal(approved.calls.length, lostCreateCallsBeforeReplay);
assert.equal(
    approved.calls.slice(lostCreateCallsStart)
        .filter(call => call.operation === 'createMultipartUpload').length,
    1
);
assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM gallery_photo_promotion_cleanup_tombstones AS tombstone
    JOIN draft_photo_promotion_cleanups AS cleanup
      ON cleanup.promotion_id_hash = tombstone.promotion_id_hash
    WHERE cleanup.promotion_id = ?
`).get(lostCreatePromotionId).count, 0);

// The separate Worker has no approved bucket, manifest, GitHub, branch, or PR
// capability. Its complete rehearsal leaves every public Gallery contract byte
// for byte unchanged.
assert.equal(Object.hasOwn(processingEnv, 'APPROVED_MEDIA'), false);
assert.equal(staging.calls.filter(call => call.operation === 'put').length, 0);
assert.deepEqual(staging.objects.get(unrecordedRunPrefixKey).bytes, unrecordedRunPrefixBytes);
assert.deepEqual(staging.objects.get(conflictKey).bytes, conflictingSeed.bytes);
assert.equal(
    [...staging.objects.keys()].every(key => key.startsWith('derivative-staging/v1/')),
    true
);
for (let index = 0; index < manifestUrls.length; index += 1) {
    assert.deepEqual(await readFile(manifestUrls[index]), manifestBaselines[index]);
}
assert.doesNotMatch(
    JSON.stringify({ run, result }),
    /private-originals|derivative-staging|provider-|synthetic-private-consent/i
);

assert.equal(sqlite.prepare('PRAGMA foreign_key_check').all().length, 0);
console.log('Gallery private processing bridge tests passed.');

function startInput(currentDraft) {
    return {
        expectedStateVersion: currentDraft.stateVersion,
        idempotencyKey: 'phase-d-processing-start-01'
    };
}

function processorIdentity() {
    return { type: 'service', subject: processorSubject };
}

async function ownerRequest(path, {
    method = 'GET',
    authenticated = false,
    session = false,
    json,
    rawBody,
    headers = {}
} = {}) {
    currentNow += 1;
    const requestHeaders = new Headers(headers);
    if (authenticated) {
        requestHeaders.set('X-Synthetic-Identity', 'owner');
    }
    if (session) {
        requestHeaders.set('Cookie', ownerSession.cookie);
        if (!['GET', 'HEAD'].includes(method)) {
            requestHeaders.set('Origin', adminOrigin);
            requestHeaders.set('Sec-Fetch-Site', 'same-origin');
            requestHeaders.set('X-CSRF-Token', ownerSession.csrfToken);
        }
    }
    let body = rawBody;
    if (json !== undefined) {
        body = JSON.stringify(json);
        requestHeaders.set('Content-Type', 'application/json');
        requestHeaders.set('Content-Length', String(Buffer.byteLength(body)));
    }
    const suffix = path.includes('?') ? path : `${path}?site=family`;
    return handleAdminRequest(
        new Request(`${adminOrigin}${suffix}`, { method, headers: requestHeaders, body }),
        adminEnv,
        {
            verifyAccessIdentity: async request =>
                request.headers.get('X-Synthetic-Identity') === 'owner'
                    ? { type: 'browser', subject: 'synthetic-owner' }
                    : null,
            now: () => currentNow,
            digestReadable: nodeDigestReadable
        }
    );
}

async function processorRequest(path, {
    method = 'GET',
    identity = null,
    env = processingEnv,
    json,
    rawBody,
    headers = {}
} = {}) {
    currentNow += 1;
    const requestHeaders = new Headers(headers);
    let body = rawBody;
    if (json !== undefined) {
        body = JSON.stringify(json);
        requestHeaders.set('Content-Type', 'application/json');
        requestHeaders.set('Content-Length', String(Buffer.byteLength(body)));
    }
    return handleProcessingRequest(
        new Request(`${processingOrigin}${path}`, { method, headers: requestHeaders, body }),
        env,
        {
            verifyAccessIdentity: async () => identity,
            now: () => currentNow
        }
    );
}

async function uploadDerivative(runId, derivative, bytes, idempotencyKey = undefined) {
    return processorRequest(
        `/api/service/processing-runs/${runId}/derivatives/${derivative.storageRole}`,
        {
            method: 'PUT',
            identity: processorIdentity(),
            rawBody: bytes,
            headers: {
                'Content-Type': 'image/webp',
                'Content-Length': String(bytes.byteLength),
                'X-Gallery-Content-SHA256': sha256(bytes),
                'Idempotency-Key': idempotencyKey || `phase-d-${derivative.storageRole}-0001`
            }
        }
    );
}

async function cleanupRun(runId, expectedStateVersion, idempotencyKey) {
    return processorRequest(
        `/api/service/processing-runs/${runId}/cleanup`,
        {
            method: 'POST',
            identity: processorIdentity(),
            json: { expectedStateVersion, idempotencyKey }
        }
    );
}

async function retryRun(runId, expectedStateVersion, idempotencyKey) {
    return processorRequest(
        `/api/service/processing-runs/${runId}/retry`,
        {
            method: 'POST',
            identity: processorIdentity(),
            json: { expectedStateVersion, idempotencyKey }
        }
    );
}

async function createSyntheticProcessingRun(caseId) {
    const caseDraft = await createApprovedSyntheticPhotoDraft(
        `synthetic-phase-d-${caseId}`,
        caseId
    );
    const response = await processorRequest(
        `/api/service/drafts/${caseDraft.draftId}/processing-runs`,
        {
            method: 'POST',
            identity: processorIdentity(),
            json: {
                expectedStateVersion: caseDraft.stateVersion,
                idempotencyKey: `phase-d-${caseId}-start`
            }
        }
    );
    assert.equal(response.status, 201, await response.clone().text());
    return { draft: caseDraft, run: await response.json() };
}

async function stageSyntheticProcessingRun(caseId) {
    const current = await createSyntheticProcessingRun(caseId);
    const displayResponse = await uploadDerivative(
        current.run.processingRunId,
        display,
        displayBytes,
        `phase-e-${caseId}-display`
    );
    assert.equal(displayResponse.status, 201, await displayResponse.clone().text());
    const thumbnailResponse = await uploadDerivative(
        current.run.processingRunId,
        thumbnail,
        thumbnailBytes,
        `phase-e-${caseId}-thumbnail`
    );
    assert.equal(thumbnailResponse.status, 201, await thumbnailResponse.clone().text());
    const resultResponse = await processorRequest(
        `/api/service/processing-runs/${current.run.processingRunId}/result`,
        {
            method: 'POST',
            identity: processorIdentity(),
            json: {
                outcome: 'staged',
                expectedStateVersion: current.run.stateVersion,
                idempotencyKey: `phase-e-${caseId}-result`,
                source: {
                    sha256: processed.source.sha256,
                    byteLength: processed.source.byteLength,
                    detectedFormat: processed.source.detectedFormat
                },
                toolchain: { ...processed.toolchain },
                derivatives: processed.derivatives.map(derivative => ({
                    role: derivative.storageRole,
                    sha256: derivative.sha256,
                    byteLength: derivative.byteLength,
                    width: derivative.width,
                    height: derivative.height,
                    durationMilliseconds: null,
                    metadataEntryCount: derivative.metadataEntryCount,
                    metadataFindingCategories: []
                }))
            }
        }
    );
    assert.equal(resultResponse.status, 200, await resultResponse.clone().text());
    const stagedRun = await resultResponse.json();
    assert.equal(stagedRun.status, 'staged');
    assert.equal(stagedRun.state, 'processing');
    return { ...current, run: stagedRun };
}

function promotionInputFor(fixture, idempotencyKey) {
    return {
        expectedStateVersion: fixture.run.stateVersion,
        idempotencyKey
    };
}

function promotionIdForDraft(draftId) {
    const promotion = sqlite.prepare(
        'SELECT promotion_id AS promotionId FROM draft_photo_promotions ' +
        'WHERE draft_id = ?'
    ).get(draftId);
    assert.equal(typeof promotion?.promotionId, 'string');
    return promotion.promotionId;
}

function cleanupInputFor(fixture, idempotencyKey) {
    const draft = sqlite.prepare(
        'SELECT state_version AS stateVersion FROM gallery_drafts WHERE draft_id = ?'
    ).get(fixture.draft.draftId);
    assert.equal(Number.isSafeInteger(draft?.stateVersion), true);
    return {
        expectedStateVersion: draft.stateVersion,
        idempotencyKey
    };
}

async function cleanupActivePromotion(fixture, idempotencyKey) {
    return cleanupPhotoPromotion(
        promotionEnv,
        promotionIdentity,
        promotionIdForDraft(fixture.draft.draftId),
        cleanupInputFor(fixture, idempotencyKey),
        currentNow += 1
    );
}

async function promoteStagedFixture(fixture, idempotencyKey) {
    const result = await promotePhotoDraft(
        promotionEnv,
        promotionIdentity,
        fixture.draft.draftId,
        promotionInputFor(fixture, idempotencyKey),
        approvedOrigin,
        currentNow += 1
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status, 201);
    assert.equal(result.candidate.draft.state, 'candidate-public');
    return result;
}

async function failSyntheticProcessingRun(caseRun, caseId) {
    const response = await processorRequest(
        `/api/service/processing-runs/${caseRun.processingRunId}/result`,
        {
            method: 'POST',
            identity: processorIdentity(),
            json: {
                outcome: 'failed',
                expectedStateVersion: caseRun.stateVersion,
                idempotencyKey: `phase-d-${caseId}-failure`,
                errorCode: 'processing-failed'
            }
        }
    );
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
}

async function createFailedCleanedProcessingRun(caseId) {
    const current = await createSyntheticProcessingRun(caseId);
    const failed = await failSyntheticProcessingRun(current.run, caseId);
    const cleanup = await cleanupRun(
        current.run.processingRunId,
        failed.stateVersion,
        `phase-d-${caseId}-cleanup`
    );
    assert.equal(cleanup.status, 201, await cleanup.clone().text());
    assert.equal((await cleanup.json()).status, 'cleaned');
    return { ...current, failed };
}

async function createPausedPartUploadedRun(caseId) {
    const current = await createSyntheticProcessingRun(caseId);
    staging.beforeNextComplete = () => {
        throw providerError('SyntheticCompletionPaused', 19997);
    };
    const response = await uploadDerivative(
        current.run.processingRunId,
        display,
        displayBytes,
        `phase-d-${caseId}-output`
    );
    assert.equal(response.status, 503);
    const creation = staging.calls.find(call =>
        call.operation === 'createMultipartUpload' &&
        call.key.includes(`/${current.run.processingRunId}/`)
    );
    assert.ok(creation);
    assert.equal(sqlite.prepare(
        'SELECT status FROM draft_processing_multipart_uploads ' +
        'WHERE processing_run_id = ? AND role = ?'
    ).get(current.run.processingRunId, 'photo-display').status, 'part-uploaded');
    return { ...current, creation };
}

async function createLegacyAbortedCleanupFixture(caseId, objectBytes) {
    const current = await createPausedPartUploadedRun(caseId);
    const seeded = staging.seedObject(current.creation.key, objectBytes, {
        customMetadata: {
            contract: 'gallery-private-staging-v1',
            role: 'photo-display'
        }
    });
    const failed = await failSyntheticProcessingRun(current.run, caseId);

    // Let the service atomically establish the cleanup closure and object
    // snapshot, but pause before the provider abort so the historical terminal
    // outcome can be reproduced without bypassing those D1 admission guards.
    staging.beforeNextAbort = () => {
        throw providerError('SyntheticLegacyAbortSnapshotPaused', 19998);
    };
    const firstCleanup = await cleanupRun(
        current.run.processingRunId,
        failed.stateVersion,
        `phase-d-${caseId}-cleanup`
    );
    assert.equal(firstCleanup.status, 503);
    assert.equal(sqlite.prepare(
        'SELECT status FROM draft_processing_cleanups WHERE processing_run_id = ?'
    ).get(current.run.processingRunId).status, 'closing');

    // This is the observed provider edge: abort resolves even though an object
    // from the already-winning completion remains. The old Worker then durably
    // recorded `aborted`; current migrations correctly make that fact immutable.
    await staging.resumeMultipartUpload(
        current.creation.key,
        current.creation.uploadId
    ).abort();
    const terminalAt = new Date(currentNow += 1).toISOString();
    const terminalUpdate = sqlite.prepare(`
        UPDATE draft_processing_multipart_uploads
        SET status = 'terminal', terminal_kind = 'aborted',
            updated_at = ?, terminal_at = ?
        WHERE processing_run_id = ? AND role = 'photo-display'
          AND status = 'part-uploaded' AND provider_upload_id = ?
    `).run(
        terminalAt,
        terminalAt,
        current.run.processingRunId,
        current.creation.uploadId
    );
    assert.equal(Number(terminalUpdate.changes), 1);
    assert.deepEqual({ ...sqlite.prepare(
        'SELECT status, terminal_kind FROM draft_processing_multipart_uploads ' +
        "WHERE processing_run_id = ? AND role = 'photo-display'"
    ).get(current.run.processingRunId) }, {
        status: 'terminal',
        terminal_kind: 'aborted'
    });
    assert.equal(staging.objects.has(current.creation.key), true);

    return { ...current, failed, seeded };
}

async function assertMalformedNoSuchUploadFailsClosed(caseId, providerFailure) {
    const current = await createPausedPartUploadedRun(caseId);
    const failed = await failSyntheticProcessingRun(current.run, caseId);
    staging.nextResumeError = providerFailure;
    const firstCleanup = await cleanupRun(
        current.run.processingRunId,
        failed.stateVersion,
        `phase-d-${caseId}-cleanup`
    );
    assert.equal(firstCleanup.status, 503);
    assert.equal(sqlite.prepare(
        'SELECT status FROM draft_processing_cleanups WHERE processing_run_id = ?'
    ).get(current.run.processingRunId).status, 'closing');
    assert.equal(staging.uploads.has(current.creation.uploadId), true);
    assert.equal(staging.objects.has(current.creation.key), false);
    const retry = await cleanupRun(
        current.run.processingRunId,
        failed.stateVersion,
        `phase-d-${caseId}-cleanup`
    );
    assert.equal(retry.status, 200, await retry.clone().text());
    assert.equal((await retry.json()).replayed, true);
    assert.equal(staging.uploads.has(current.creation.uploadId), false);
    assert.equal(staging.objects.has(current.creation.key), false);
}

async function createWithdrawalCleanupCase(caseId) {
    const current = await createSyntheticProcessingRun(caseId);
    return {
        ...current,
        withdrawalStateVersion: transitionDraftDirect(
            sqlite,
            current.draft.draftId,
            'withdrawal-pending'
        )
    };
}

async function assertPrefixListingFailsClosed(caseId, scriptedResponses) {
    const current = await createWithdrawalCleanupCase(caseId);
    const idempotencyKey = `phase-d-${caseId}-cleanup`;
    staging.scriptedListResponses = [...scriptedResponses];
    const first = await cleanupRun(
        current.run.processingRunId,
        current.withdrawalStateVersion,
        idempotencyKey
    );
    assert.equal(first.status, 503);
    assert.equal(sqlite.prepare(
        'SELECT status FROM draft_processing_cleanups WHERE processing_run_id = ?'
    ).get(current.run.processingRunId).status, 'deleting');
    assert.equal(sqlite.prepare(
        'SELECT COUNT(*) AS count FROM gallery_processing_cleanup_tombstones ' +
        'WHERE processing_run_id_hash = ?'
    ).get(sha256Text(current.run.processingRunId)).count, 0);
    staging.scriptedListResponses = [];
    const retry = await cleanupRun(
        current.run.processingRunId,
        current.withdrawalStateVersion,
        idempotencyKey
    );
    assert.equal(retry.status, 200, await retry.clone().text());
    assert.equal((await retry.json()).replayed, true);
    assert.equal(sqlite.prepare(
        'SELECT COUNT(*) AS count FROM gallery_processing_cleanup_tombstones ' +
        'WHERE processing_run_id_hash = ?'
    ).get(sha256Text(current.run.processingRunId)).count, 1);
}

function resolveAndRemoveSyntheticExclusion() {
    resolvePendingExclusion(sqlite, selectedResult.athleteId, catalog.suppressionRevision);
    sqlite.prepare('DELETE FROM pending_athlete_exclusions WHERE athlete_id = ?')
        .run(selectedResult.athleteId);
}

async function createApprovedSyntheticPhotoDraft(publicItemId, keySuffix) {
    const created = await ownerRequest('/api/browser/drafts', {
        method: 'POST',
        authenticated: true,
        session: true,
        json: {
            itemInput: {
                id: publicItemId,
                type: 'photo',
                title: `Synthetic Phase D ${keySuffix} photo`,
                caption: 'Synthetic private failure-path media.',
                alt: 'A generated image used for a private failure-path test.',
                raceDate: selectedResult.raceDate,
                raceEvent: selectedResult.raceEvent,
                raceDistance: selectedResult.raceDistance,
                featured: false,
                athleteIds: [selectedResult.athleteId]
            },
            consent: {
                publicUseConfirmed: true,
                containsMinors: false,
                guardianApprovalConfirmed: false,
                privateEvidenceReference: null
            }
        }
    });
    assert.equal(created.status, 201, await created.clone().text());
    let currentDraft = (await created.json()).draft;
    const begun = await ownerRequest(`/api/browser/drafts/${currentDraft.draftId}/upload`, {
        method: 'POST',
        authenticated: true,
        session: true,
        json: {
            expectedStateVersion: currentDraft.stateVersion,
            fileName: `synthetic-${keySuffix}.jpg`,
            declaredMimeType: 'image/jpeg',
            byteLength: sourceBytes.byteLength,
            idempotencyKey: `phase-d-${keySuffix}-upload-start`,
            syntheticOnlyConfirmed: true
        }
    });
    assert.equal(begun.status, 201, await begun.clone().text());
    const part = await ownerRequest(
        `/api/browser/drafts/${currentDraft.draftId}/upload-parts/1`,
        {
            method: 'PUT',
            authenticated: true,
            session: true,
            rawBody: sourceBytes,
            headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(sourceBytes.byteLength),
                'X-Chunk-SHA256': sha256(sourceBytes)
            }
        }
    );
    assert.equal(part.status, 201, await part.clone().text());
    const completed = await ownerRequest(
        `/api/browser/drafts/${currentDraft.draftId}/upload-completion`,
        {
            method: 'POST',
            authenticated: true,
            session: true,
            json: {
                expectedStateVersion: currentDraft.stateVersion + 1,
                idempotencyKey: `phase-d-${keySuffix}-complete-01`
            }
        }
    );
    assert.equal(completed.status, 201, await completed.clone().text());
    currentDraft = (await completed.json()).draft;
    const approved = await ownerRequest(
        `/api/browser/drafts/${currentDraft.draftId}/transitions`,
        {
            method: 'POST',
            authenticated: true,
            session: true,
            json: {
                toState: 'approved-for-processing',
                expectedStateVersion: currentDraft.stateVersion,
                idempotencyKey: `phase-d-${keySuffix}-approve-0001`
            }
        }
    );
    assert.equal(approved.status, 200, await approved.clone().text());
    return (await approved.json()).draft;
}

function sameRace(left, right) {
    return left.raceDate === right.raceDate &&
        left.raceEvent === right.raceEvent &&
        left.raceDistance === right.raceDistance;
}

function insertPendingExclusion(database, athleteId, suppressionRevision) {
    const timestamp = new Date(currentNow += 1).toISOString();
    database.prepare(`
        INSERT INTO pending_athlete_exclusions (
            athlete_id, exclusion_revision, expected_suppression_revision,
            request_audit_hash, actor_identity_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        athleteId,
        'phase-d-pending-exclusion-v1',
        suppressionRevision,
        'a'.repeat(64),
        'b'.repeat(64),
        timestamp,
        timestamp
    );
}

function resolvePendingExclusion(database, athleteId, suppressionRevision) {
    const timestamp = new Date(currentNow += 1).toISOString();
    database.prepare(`
        UPDATE pending_athlete_exclusions
        SET resolved_suppression_revision = ?, resolution_audit_hash = ?,
            resolved_at = ?, updated_at = ?
        WHERE athlete_id = ? AND resolved_at IS NULL
    `).run(suppressionRevision, 'c'.repeat(64), timestamp, timestamp, athleteId);
}

function transitionDraftDirect(database, draftId, toState) {
    const current = database.prepare(
        'SELECT state, state_version AS stateVersion FROM gallery_drafts WHERE draft_id = ?'
    ).get(draftId);
    assert.ok(current);
    const timestamp = new Date(currentNow += 1).toISOString();
    const changed = database.prepare(
        'UPDATE gallery_drafts SET state = ?, state_version = state_version + 1, ' +
        'updated_at = ? WHERE draft_id = ? AND state = ? AND state_version = ?'
    ).run(toState, timestamp, draftId, current.state, current.stateVersion);
    assert.equal(Number(changed.changes), 1);
    return current.stateVersion + 1;
}

function insertDeletionPublication(database, draftId) {
    const timestamp = new Date(currentNow += 1).toISOString();
    database.prepare(`
        INSERT INTO draft_publication_references (
            draft_id, host_deletion_confirmed,
            private_original_deletion_confirmed, withdrawal_kind, updated_at
        ) VALUES (?, 1, 1, 'consent-withdrawal', ?)
    `).run(draftId, timestamp);
}

function withdrawActiveConsent(database, draftId) {
    const consentRevision = database.prepare(
        'SELECT active_consent_revision AS consentRevision FROM gallery_drafts WHERE draft_id = ?'
    ).get(draftId)?.consentRevision;
    assert.equal(typeof consentRevision, 'string');
    const timestamp = new Date(currentNow += 1).toISOString();
    database.prepare(
        'UPDATE draft_consent_attestations SET withdrawn_at = ? ' +
        'WHERE draft_id = ? AND consent_revision = ?'
    ).run(timestamp, draftId, consentRevision);
}

function markPrivateOriginalDeleted(database, draftId) {
    const uploadSession = database.prepare(
        "SELECT upload_session_id AS uploadSessionId FROM draft_upload_sessions " +
        "WHERE draft_id = ? AND status = 'complete'"
    ).get(draftId);
    assert.equal(typeof uploadSession?.uploadSessionId, 'string');
    const timestamp = new Date(currentNow += 1).toISOString();
    const changed = database.prepare(
        "UPDATE draft_upload_sessions SET status = 'deleted', " +
        'object_deleted_at = ?, updated_at = ? ' +
        "WHERE upload_session_id = ? AND status = 'complete'"
    ).run(timestamp, timestamp, uploadSession.uploadSessionId);
    assert.equal(Number(changed.changes), 1);
}

function insertConsentRetentionTombstone(database, draftId) {
    const timestamp = new Date(currentNow += 1).toISOString();
    database.prepare(`
        INSERT INTO gallery_retention_tombstones (
            draft_id, purge_kind, eligible_at, approved_at,
            approved_by_identity_hash, evidence_hash
        ) VALUES (?, 'consent-withdrawal', ?, ?, ?, ?)
    `).run(draftId, timestamp, timestamp, '6'.repeat(64), '7'.repeat(64));
}

function createSqliteD1(database) {
    class Statement {
        constructor(sql, bindings = []) {
            this.sql = sql;
            this.bindings = bindings;
        }

        bind(...bindings) {
            return new Statement(this.sql, bindings);
        }

        async run() {
            await runBeforeStatementHook(this.sql);
            if (consumeStatementFailure(this.sql)) {
                throw new Error('private-provider-evidence-sentinel');
            }
            return this.runSynchronously();
        }

        async first(columnName) {
            const row = database.prepare(this.sql).get(...this.bindings) ?? null;
            return columnName === undefined || row === null ? row : row[columnName];
        }

        async all() {
            return { success: true, results: database.prepare(this.sql).all(...this.bindings) };
        }

        runSynchronously() {
            const result = database.prepare(this.sql).run(...this.bindings);
            return {
                success: true,
                meta: {
                    changes: Number(result.changes),
                    last_row_id: Number(result.lastInsertRowid)
                }
            };
        }
    }

    const api = {
        beforeRunContaining: null,
        beforeNextBatch: null,
        failNextRunContaining: null,
        failAfterNextBatch: false,
        batchMetaMode: 'statement',
        lastError: null,
        prepare(sql) {
            return new Statement(sql);
        },
        async batch(statements) {
            if (api.beforeNextBatch) {
                const callback = api.beforeNextBatch;
                api.beforeNextBatch = null;
                await callback();
            }
            api.lastError = null;
            for (const statement of statements) {
                await runBeforeStatementHook(statement.sql);
            }
            let committed = false;
            database.exec('BEGIN IMMEDIATE');
            try {
                const results = statements.map(statement => {
                    if (consumeStatementFailure(statement.sql)) {
                        throw new Error('private-provider-evidence-sentinel');
                    }
                    return statement.runSynchronously();
                });
                if (api.batchMetaMode === 'cumulative') {
                    let cumulativeChanges = 0;
                    for (const result of results) {
                        cumulativeChanges += Number(result.meta.changes);
                        result.meta.changes = cumulativeChanges;
                    }
                } else if (api.batchMetaMode === 'omitted') {
                    for (const result of results) {
                        delete result.meta.changes;
                    }
                }
                database.exec('COMMIT');
                committed = true;
                if (api.failAfterNextBatch) {
                    api.failAfterNextBatch = false;
                    throw new Error('synthetic-lost-d1-batch-response');
                }
                return results;
            } catch (error) {
                if (!committed) {
                    database.exec('ROLLBACK');
                }
                api.lastError = error;
                throw error;
            }
        }
    };

    async function runBeforeStatementHook(sql) {
        if (api.beforeRunContaining && sql.includes(api.beforeRunContaining.needle)) {
            const callback = api.beforeRunContaining.callback;
            api.beforeRunContaining = null;
            await callback();
        }
    }

    function consumeStatementFailure(sql) {
        if (api.failNextRunContaining && sql.includes(api.failNextRunContaining)) {
            api.failNextRunContaining = null;
            return true;
        }
        return false;
    }
    return api;
}

function createPrivateOriginalsBucket() {
    const uploads = new Map();
    const objects = new Map();
    let uploadCounter = 0;
    let versionCounter = 0;
    const bucket = {
        calls: [],
        afterGet: null,
        async createMultipartUpload(key, options = {}) {
            const uploadId = `provider-upload-${++uploadCounter}`;
            const record = { key, uploadId, options, parts: new Map(), completed: false };
            uploads.set(uploadId, record);
            bucket.calls.push({ operation: 'createMultipartUpload', key });
            return multipart(record);
        },
        resumeMultipartUpload(key, uploadId) {
            const record = uploads.get(uploadId);
            if (!record || record.key !== key) {
                throw new Error('NoSuchUpload');
            }
            bucket.calls.push({ operation: 'resumeMultipartUpload', key });
            return multipart(record);
        },
        async head(key) {
            bucket.calls.push({ operation: 'head', key });
            const object = objects.get(key);
            return object ? objectMetadata(object) : null;
        },
        async get(key, options = {}) {
            bucket.calls.push({ operation: 'get', key });
            const object = objects.get(key);
            if (!object) {
                return null;
            }
            if (options.onlyIf?.etagMatches !== undefined &&
                options.onlyIf.etagMatches !== object.etag) {
                return objectMetadata(object);
            }
            const response = {
                ...objectMetadata(object),
                body: bytesToStream(object.bytes.slice())
            };
            if (bucket.afterGet) {
                const afterGet = bucket.afterGet;
                bucket.afterGet = null;
                await afterGet(key);
            }
            return response;
        },
        async delete(key) {
            bucket.calls.push({ operation: 'delete', key });
            objects.delete(key);
        }
    };

    function multipart(record) {
        return {
            key: record.key,
            uploadId: record.uploadId,
            async uploadPart(partNumber, body) {
                const bytes = Uint8Array.from(body);
                const etag = `part-${partNumber}-${sha256(bytes).slice(0, 20)}`;
                record.parts.set(partNumber, { bytes, etag });
                bucket.calls.push({ operation: 'uploadPart', key: record.key, partNumber });
                return { partNumber, etag };
            },
            async complete(parts) {
                const bytes = concatenateBytes(parts.map(part => {
                    const stored = record.parts.get(part.partNumber);
                    assert.equal(stored?.etag, part.etag);
                    return stored.bytes;
                }));
                const object = {
                    bytes,
                    etag: `original-etag-${sha256(bytes).slice(0, 24)}`,
                    version: `original-version-${++versionCounter}`
                };
                objects.set(record.key, object);
                record.completed = true;
                bucket.calls.push({ operation: 'complete', key: record.key });
                return objectMetadata(object);
            },
            async abort() {
                uploads.delete(record.uploadId);
                bucket.calls.push({ operation: 'abort', key: record.key });
            }
        };
    }
    return bucket;
}

function createStagingBucket() {
    const uploads = new Map();
    const handles = new Map();
    let uploadCounter = 0;
    let versionCounter = 0;
    const bucket = {
        objects: new Map(),
        uploads,
        handles,
        calls: [],
        overwriteAttempts: 0,
        beforeNextCreate: null,
        afterNextCreate: null,
        beforeNextHead: null,
        afterNextHead: null,
        beforeNextGet: null,
        afterNextGet: null,
        beforeNextUploadPart: null,
        afterNextUploadPart: null,
        beforeNextComplete: null,
        afterNextComplete: null,
        beforeNextAbort: null,
        afterNextAbort: null,
        beforeNextDelete: null,
        afterNextDelete: null,
        failAfterNextCreate: false,
        failAfterNextUploadPart: false,
        failAfterNextComplete: false,
        failAfterNextAbort: false,
        failAfterNextDelete: false,
        nextResumeError: null,
        scriptedListResponses: [],
        seedObject(key, bytes, {
            etag = `seed-etag-${sha256(bytes).slice(0, 24)}`,
            version = `seed-version-${++versionCounter}`,
            httpMetadata = { contentType: 'image/webp' },
            customMetadata = {
                contract: 'gallery-private-staging-v1',
                role: 'photo-display'
            }
        } = {}) {
            const object = {
                bytes: Uint8Array.from(bytes),
                etag,
                version,
                httpMetadata: { ...httpMetadata },
                customMetadata: { ...customMetadata }
            };
            bucket.objects.set(key, object);
            return object;
        },
        async createMultipartUpload(key, options = {}) {
            await consumeHook(bucket, 'beforeNextCreate', { key, options });
            const uploadId = `staging-upload-${++uploadCounter}`;
            const record = {
                key,
                uploadId,
                options: cloneStagingOptions(options),
                parts: new Map(),
                terminal: null
            };
            uploads.set(uploadId, record);
            bucket.calls.push({ operation: 'createMultipartUpload', key, uploadId });
            await consumeHook(bucket, 'afterNextCreate', { key, uploadId, record });
            if (consumeFailure(bucket, 'failAfterNextCreate')) {
                throw providerError('SyntheticLostCreateResponse', 19991);
            }
            const handle = multipart(record);
            handles.set(uploadId, handle);
            return handle;
        },
        resumeMultipartUpload(key, uploadId) {
            bucket.calls.push({ operation: 'resumeMultipartUpload', key, uploadId });
            if (bucket.nextResumeError) {
                const error = bucket.nextResumeError;
                bucket.nextResumeError = null;
                throw error;
            }
            const record = uploads.get(uploadId);
            if (!record || record.key !== key || record.terminal !== null) {
                throw providerError('NoSuchUpload', 10024);
            }
            return multipart(record);
        },
        async head(key) {
            await consumeHook(bucket, 'beforeNextHead', { key });
            bucket.calls.push({ operation: 'head', key });
            const object = bucket.objects.get(key);
            const result = object ? stagedMetadata(object) : null;
            await consumeHook(bucket, 'afterNextHead', { key, object, result });
            return result;
        },
        async get(key, options = {}) {
            await consumeHook(bucket, 'beforeNextGet', { key, options });
            bucket.calls.push({ operation: 'get', key });
            const object = bucket.objects.get(key);
            if (!object) {
                await consumeHook(bucket, 'afterNextGet', { key, options, object: null, result: null });
                return null;
            }
            if (options.onlyIf?.etagMatches !== undefined &&
                options.onlyIf.etagMatches !== object.etag) {
                const mismatch = stagedMetadata(object);
                await consumeHook(bucket, 'afterNextGet', { key, options, object, result: mismatch });
                return mismatch;
            }
            const result = { ...stagedMetadata(object), body: bytesToStream(object.bytes.slice()) };
            await consumeHook(bucket, 'afterNextGet', { key, options, object, result });
            return result;
        },
        async list({ prefix = '', limit = 1000, cursor } = {}) {
            bucket.calls.push({ operation: 'list', prefix, limit, cursor: cursor || null });
            if (bucket.scriptedListResponses.length > 0) {
                const response = bucket.scriptedListResponses.shift();
                return typeof response === 'function'
                    ? await response({ prefix, limit, cursor })
                    : response;
            }
            const keys = [...bucket.objects.keys()]
                .filter(key => key.startsWith(prefix))
                .sort();
            const offset = cursor ? Number(String(cursor).replace(/^cursor-/, '')) : 0;
            const pageSize = Math.max(1, Math.min(Number(limit) || 1000, 1000));
            const pageKeys = keys.slice(offset, offset + pageSize);
            const nextOffset = offset + pageKeys.length;
            return {
                objects: pageKeys.map(key => ({
                    key,
                    ...stagedMetadata(bucket.objects.get(key))
                })),
                delimitedPrefixes: [],
                truncated: nextOffset < keys.length,
                ...(nextOffset < keys.length ? { cursor: `cursor-${nextOffset}` } : {})
            };
        },
        async put(key) {
            bucket.calls.push({ operation: 'put', key });
            throw new Error('direct staging put is forbidden by the cleanup protocol');
        },
        async delete(key) {
            await consumeHook(bucket, 'beforeNextDelete', { key });
            bucket.calls.push({ operation: 'delete', key });
            bucket.objects.delete(key);
            await consumeHook(bucket, 'afterNextDelete', { key });
            if (consumeFailure(bucket, 'failAfterNextDelete')) {
                throw providerError('SyntheticLostDeleteResponse', 19995);
            }
        }
    };

    function multipart(record) {
        return {
            key: record.key,
            uploadId: record.uploadId,
            async uploadPart(partNumber, body) {
                await consumeHook(bucket, 'beforeNextUploadPart', {
                    key: record.key,
                    uploadId: record.uploadId,
                    partNumber
                });
                assert.equal(partNumber, 1);
                requireOpenUpload(record);
                const bytes = Uint8Array.from(body);
                const expected = Buffer.from(record.options.sha256 || new Uint8Array())
                    .toString('hex');
                if (expected && expected !== sha256(bytes)) {
                    throw providerError('ChecksumMismatch', 10037);
                }
                const etag = `staging-part-${sha256(bytes).slice(0, 24)}`;
                record.parts.set(partNumber, { bytes, etag });
                bucket.calls.push({
                    operation: 'uploadPart',
                    key: record.key,
                    uploadId: record.uploadId,
                    partNumber,
                    etag
                });
                await consumeHook(bucket, 'afterNextUploadPart', {
                    key: record.key,
                    uploadId: record.uploadId,
                    partNumber,
                    etag
                });
                if (consumeFailure(bucket, 'failAfterNextUploadPart')) {
                    throw providerError('SyntheticLostPartResponse', 19992);
                }
                return { partNumber, etag };
            },
            async complete(parts) {
                await consumeHook(bucket, 'beforeNextComplete', {
                    key: record.key,
                    uploadId: record.uploadId,
                    parts
                });
                requireOpenUpload(record);
                assert.deepEqual(parts.map(part => part.partNumber), [1]);
                const storedPart = record.parts.get(1);
                if (!storedPart || storedPart.etag !== parts[0].etag) {
                    throw providerError('InvalidPart', 10025);
                }
                if (bucket.objects.has(record.key)) {
                    bucket.overwriteAttempts += 1;
                }
                const object = {
                    bytes: storedPart.bytes.slice(),
                    etag: `staging-etag-${sha256(storedPart.bytes).slice(0, 24)}`,
                    version: `staging-version-${++versionCounter}`,
                    httpMetadata: { ...record.options.httpMetadata },
                    customMetadata: { ...record.options.customMetadata }
                };
                bucket.objects.set(record.key, object);
                record.terminal = 'completed';
                uploads.delete(record.uploadId);
                bucket.calls.push({
                    operation: 'complete',
                    key: record.key,
                    uploadId: record.uploadId
                });
                await consumeHook(bucket, 'afterNextComplete', {
                    key: record.key,
                    uploadId: record.uploadId,
                    object,
                    record
                });
                if (consumeFailure(bucket, 'failAfterNextComplete')) {
                    throw providerError('SyntheticLostCompleteResponse', 19993);
                }
                return stagedMetadata(object);
            },
            async abort() {
                await consumeHook(bucket, 'beforeNextAbort', {
                    key: record.key,
                    uploadId: record.uploadId
                });
                requireOpenUpload(record);
                record.terminal = 'aborted';
                uploads.delete(record.uploadId);
                bucket.calls.push({
                    operation: 'abort',
                    key: record.key,
                    uploadId: record.uploadId
                });
                await consumeHook(bucket, 'afterNextAbort', {
                    key: record.key,
                    uploadId: record.uploadId
                });
                if (consumeFailure(bucket, 'failAfterNextAbort')) {
                    throw providerError('SyntheticLostAbortResponse', 19994);
                }
            }
        };
    }

    function requireOpenUpload(record) {
        if (!uploads.has(record.uploadId) || record.terminal !== null) {
            throw providerError('NoSuchUpload', 10024);
        }
    }

    return bucket;
}

async function consumeHook(target, property, context) {
    const callback = target[property];
    target[property] = null;
    if (callback) {
        await callback(context);
    }
}

function consumeFailure(target, property) {
    const fail = target[property];
    target[property] = false;
    return fail;
}

function cloneStagingOptions(options) {
    return {
        ...options,
        sha256: options.sha256 instanceof ArrayBuffer
            ? options.sha256.slice(0)
            : options.sha256,
        httpMetadata: { ...options.httpMetadata },
        customMetadata: { ...options.customMetadata }
    };
}

function providerError(name, code) {
    const error = new Error(name);
    error.name = name;
    error.code = code;
    return error;
}

function objectMetadata(object) {
    return {
        size: object.bytes.byteLength,
        etag: object.etag,
        version: object.version
    };
}

function stagedMetadata(object) {
    return {
        ...objectMetadata(object),
        httpMetadata: { ...object.httpMetadata },
        customMetadata: { ...object.customMetadata }
    };
}

async function nodeDigestReadable(stream) {
    const digest = createHash('sha256');
    const reader = stream.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            digest.update(value);
        }
    } finally {
        reader.releaseLock();
    }
    return digest.digest('hex');
}

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

function sha256Text(value) {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}


function concatenateBytes(chunks) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

function bytesToStream(bytes) {
    return new ReadableStream({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        }
    });
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
