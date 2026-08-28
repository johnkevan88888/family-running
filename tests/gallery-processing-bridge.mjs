import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

import sharp from 'sharp';

import { handleAdminRequest } from '../gallery-admin/src/admin-worker.js';
import { handleProcessingRequest } from '../gallery-admin/src/processing-worker.js';
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
    '0005_private_processing_cleanup.sql'
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
    /unavailable before approved promotion evidence/i
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
    /unavailable before approved promotion evidence/i
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
    /unavailable before approved promotion evidence/i
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
const failedCleanupResponse = await cleanupRun(
    failedRun.processingRunId,
    failedResult.stateVersion,
    'phase-d-failed-no-output-cleanup'
);
assert.equal(failedCleanupResponse.status, 201, await failedCleanupResponse.clone().text());
assert.deepEqual(await failedCleanupResponse.json(), {
    processingRunId: failedRun.processingRunId,
    cleanupReason: 'processing-failed',
    status: 'cleaned',
    replayed: false
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

// The replacement guard is narrow: it blocks eviction of a still-current
// active/staged run, but a genuinely failed run with completed cleanup and its
// tombstone remains eligible for a new processor run. The Phase C browser
// route intentionally covers only first moderation, so this harness advances
// the broader contract-allowed retry state directly, then exercises the real
// processing-start service and database guards.
const failedRetryApprovedStateVersion = transitionDraftDirect(
    sqlite,
    failedDraft.draftId,
    'approved-for-processing'
);
const failedRetryRunResponse = await processorRequest(
    `/api/service/drafts/${failedDraft.draftId}/processing-runs`,
    {
        method: 'POST',
        identity: processorIdentity(),
        json: {
            expectedStateVersion: failedRetryApprovedStateVersion,
            idempotencyKey: 'phase-d-failed-cleaned-retry-start'
        }
    }
);
assert.equal(failedRetryRunResponse.status, 201, await failedRetryRunResponse.clone().text());
const failedRetryRun = await failedRetryRunResponse.json();
assert.notEqual(failedRetryRun.processingRunId, failedRun.processingRunId);
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
// before D1 can record it. Cleanup recognizes the exact completed object,
// deletes it, verifies HEAD-null, and the old request cannot resurrect it.
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
staging.afterNextComplete = async () => {
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
               object.expected_object_version_hash, object.expected_etag_hash
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
            bucket.calls.push({ operation: 'head', key });
            const object = bucket.objects.get(key);
            return object ? stagedMetadata(object) : null;
        },
        async get(key, options = {}) {
            bucket.calls.push({ operation: 'get', key });
            const object = bucket.objects.get(key);
            if (!object) {
                return null;
            }
            if (options.onlyIf?.etagMatches !== undefined &&
                options.onlyIf.etagMatches !== object.etag) {
                return stagedMetadata(object);
            }
            return { ...stagedMetadata(object), body: bytesToStream(object.bytes.slice()) };
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
                    object
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
