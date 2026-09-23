import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
    abandonPhotoReviewCandidate,
    readPhotoReviewInvalidation
} from
    '../gallery-admin/src/photo-review-service.js';
import { cleanupPhotoPromotion } from
    '../gallery-admin/src/promotion-cleanup-service.js';
import {
    cleanupProcessingRun,
    readPhotoProcessingEligibility
} from
    '../gallery-admin/src/processing-service.js';
import { finalizeGalleryWithdrawal, withdrawalFinalizerTestHooks } from
    '../gallery-admin/src/withdrawal-finalizer-service.js';
import { initiateDraftWithdrawal } from
    '../gallery-admin/src/withdrawal-service.js';

const migrationNames = [
    '0001_private_gallery.sql',
    '0002_private_uploads.sql',
    '0003_private_original_v1_keys.sql',
    '0004_private_processing_staging.sql',
    '0005_private_processing_cleanup.sql',
    '0006_transition_receipt_state_version.sql',
    '0007_photo_promotion.sql',
    '0008_photo_promotion_cleanup.sql',
    '0009_public_host_verification.sql',
    '0010_photo_intake_review_bridge.sql',
    '0011_photo_review_invalidation.sql',
    '0012_owner_withdrawal_exclusion_receipts.sql',
    '0013_withdrawal_finalization.sql',
    '0014_pre_candidate_promotion_abandonment.sql',
    '0015_withdrawal_finalization_operation_depth.sql',
    '0016_transition_receipt_replacement_guard.sql'
];
const legacyIntake = process.argv.includes('--legacy-intake');
const sqlite = new DatabaseSync(':memory:');
let legacyProcessingOnly;
for (const migrationName of migrationNames) {
    if (legacyIntake && migrationName.startsWith('0010_')) {
        // Seed under the actual old schema, then migrate normally. Never rewrite
        // the immutable intake marker/digest to manufacture a legacy upload.
        const historicalTriggers = sqlite.prepare(
            "SELECT name, sql FROM sqlite_schema WHERE type = 'trigger'"
        ).all();
        for (const trigger of historicalTriggers) {
            sqlite.exec(`DROP TRIGGER ${trigger.name}`);
        }
        legacyProcessingOnly = seedPreCandidate('processing-only', 4, {
            includePromotion: false,
            legacyUpload: true,
            processingVersion: 19,
            ownerActorHash: hash('subject:owner@example.test')
        });
        for (const trigger of historicalTriggers) sqlite.exec(trigger.sql);
    }
    sqlite.exec(await readFile(
        new URL(`../gallery-admin/migrations/${migrationName}`, import.meta.url),
        'utf8'
    ));
}

// The production services separately prove the multi-step writes that create
// uploads and verified processing output. These three insertion guards are
// disabled only to seed a historical, already-staged record directly. All
// current promotion lineage guards, state-update guards, and migration 0014
// remain active.
for (const trigger of [
    'gallery_drafts_initial_state_guard',
    'draft_upload_sessions_insert_guard',
    'draft_processing_runs_insert_guard',
    'draft_processing_outputs_insert_guard',
    'draft_derivatives_processing_output_guard',
    'draft_photo_public_generations_insert_guard',
    'draft_photo_public_generation_targets_insert_guard'
]) sqlite.exec(`DROP TRIGGER ${trigger}`);

const d1 = createSqliteD1(sqlite);
const storageCalls = [];
const unavailableStorage = {
    async head(key) {
        storageCalls.push(['head', key]);
        throw new Error('Stale D1 evidence must not be promoted by reading R2.');
    },
    async get(key) {
        storageCalls.push(['get', key]);
        throw new Error('Stale D1 evidence must not be promoted by reading R2.');
    },
    async delete() {},
    async list() { return { objects: [], truncated: false }; },
    async createMultipartUpload() { throw new Error('not available'); },
    resumeMultipartUpload() { throw new Error('not available'); }
};
const processingEnv = {
    DB: d1,
    PRIVATE_ORIGINALS: unavailableStorage,
    DERIVATIVE_STAGING: unavailableStorage
};
const reviewEnv = {
    DB: d1,
    APPROVED_MEDIA: unavailableStorage
};
const emptyStorage = {
    async head() { return null; },
    async get() { return null; },
    async delete() {},
    async list() {
        return { objects: [], delimitedPrefixes: [], truncated: false };
    },
    async createMultipartUpload() { throw new Error('not available'); },
    resumeMultipartUpload() { throw new Error('not available'); }
};
const identity = {
    type: 'service',
    subject: '0123456789abcdef0123456789abcdef.access'
};
const fixedNow = Date.UTC(2026, 8, 11, 2, 0, 0);
const ownerIdentity = { type: 'browser', subject: 'owner@example.test' };

const stranded = seedPreCandidate('stranded', 1);
const inexact = seedPreCandidate('inexact', 2, { mismatchTarget: true });
const ownerRace = seedPreCandidate('owner-race', 3);
const processingOnly = legacyProcessingOnly || seedPreCandidate('processing-only', 4, {
    includePromotion: false,
    processingVersion: 19,
    ownerActorHash: hash(`subject:${ownerIdentity.subject}`)
});
const processingOnlyWrongOwner = seedPreCandidate(
    'processing-only-wrong-owner',
    5,
    { includePromotion: false }
);

const originalUpload = sqlite.prepare(
    'SELECT * FROM draft_upload_sessions WHERE draft_id = ?'
).get(processingOnly.draftId);
assert.equal(originalUpload.synthetic_only_confirmed, 1);
assert.equal(originalUpload.real_photo_intake_confirmed, legacyIntake ? 0 : 1);
assert.equal(originalUpload.declared_sha256,
    legacyIntake ? null : originalUpload.completed_sha256);
assert.throws(() => sqlite.prepare(`
    UPDATE draft_upload_sessions SET real_photo_intake_confirmed = ?
    WHERE draft_id = ?
`).run(legacyIntake ? 1 : 0, processingOnly.draftId), /commitment is immutable/);
assert.throws(() => sqlite.prepare(`
    UPDATE draft_upload_sessions SET declared_sha256 = ? WHERE draft_id = ?
`).run(hash('different-commitment'), processingOnly.draftId), /commitment is immutable/);
assert.throws(() => sqlite.prepare(`
    INSERT INTO draft_upload_sessions (
        object_key, real_photo_intake_confirmed, declared_sha256,
        file_extension, declared_content_type
    ) VALUES (?, 0, NULL, 'jpg', 'image/jpeg')
`).run(originalUpload.object_key), /requires an exact photo intake commitment/);

const eligibility = await readPhotoProcessingEligibility(
    processingEnv,
    identity,
    stranded.draftId
);
assert.deepEqual(eligibility, {
    ok: true,
    status: 200,
    schemaVersion: '1.0',
    scope: 'photo-processing-abandonment-v1',
    draftId: stranded.draftId,
    processingRunId: stranded.processingRunId,
    mediaType: 'photo',
    state: 'processing',
    stateVersion: 4,
    runStatus: 'staged'
});
assert.deepEqual(storageCalls, [], 'The abandonment-only route must not read stale bytes.');

const deniedEligibility = await readPhotoProcessingEligibility(
    processingEnv,
    identity,
    inexact.draftId
);
assert.deepEqual(deniedEligibility, {
    ok: false,
    status: 409,
    code: 'processing-not-eligible'
});
assert.deepEqual(storageCalls, []);

const abandonmentInput = {
    expectedStateVersion: 4,
    failureEvidenceHash: hash('stale-pre-candidate'),
    idempotencyKey: 'review-abandon-stale-0001'
};
const abandoned = await abandonPhotoReviewCandidate(
    reviewEnv,
    identity,
    stranded.draftId,
    abandonmentInput,
    fixedNow
);
assert.equal(abandoned.ok, true, JSON.stringify(abandoned));
assert.equal(abandoned.status, 201);
assert.equal(abandoned.abandonment.promotionId, stranded.promotionId);
assert.equal(abandoned.abandonment.processingRunId, stranded.processingRunId);
assert.equal(abandoned.abandonment.expectedStateVersion, 4);
assert.equal(abandoned.abandonment.resultStateVersion, 5);
assert.equal(abandoned.abandonment.status, 'withdrawal-pending');
assert.equal(abandoned.cleanup.expectedStateVersion, 5);
assert.equal(abandoned.processingCleanup.expectedStateVersion, 5);
assert.deepEqual({ ...sqlite.prepare(`
    SELECT draft.state, draft.state_version AS stateVersion,
           transition.from_state AS fromState,
           transition.to_state AS toState,
           publication.withdrawal_kind AS withdrawalKind
    FROM gallery_drafts AS draft
    JOIN draft_transition_receipts AS transition
      ON transition.draft_id = draft.draft_id
     AND transition.idempotency_key = ?
    JOIN draft_publication_references AS publication
      ON publication.draft_id = draft.draft_id
    WHERE draft.draft_id = ?
`).get(abandonmentInput.idempotencyKey, stranded.draftId) }, {
    state: 'withdrawal-pending',
    stateVersion: 5,
    fromState: 'processing',
    toState: 'withdrawal-pending',
    withdrawalKind: 'editorial-removal'
});
assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM gallery_terminal_photo_review_withdrawal_transitions
    WHERE draft_id = ? AND expected_state_version = 4
      AND result_state_version = 5
`).get(stranded.draftId).count, 1);
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM draft_photo_review_receipts WHERE draft_id = ?'
).get(stranded.draftId).count, 0);

const replay = await abandonPhotoReviewCandidate(
    reviewEnv,
    identity,
    stranded.draftId,
    abandonmentInput,
    fixedNow + 1000
);
assert.equal(replay.ok, true);
assert.equal(replay.status, 200);
assert.equal(replay.replayed, true);
assert.deepEqual(replay.cleanup, abandoned.cleanup);
assert.deepEqual(replay.processingCleanup, abandoned.processingCleanup);

const receiptRecovery = await readPhotoProcessingEligibility(
    processingEnv,
    identity,
    stranded.draftId
);
assert.deepEqual(receiptRecovery, eligibility,
    'A committed abandonment receipt must keep its unfinished cleanup recoverable.');

const approvedCleanup = await cleanupPhotoPromotion(
    { DB: d1, APPROVED_MEDIA: emptyStorage },
    identity,
    stranded.promotionId,
    {
        expectedStateVersion: abandoned.cleanup.expectedStateVersion,
        idempotencyKey: abandoned.cleanup.idempotencyKey
    },
    fixedNow + 2000
);
assert.deepEqual(approvedCleanup, {
    ok: true,
    status: 201,
    promotionId: stranded.promotionId,
    cleanupReason: 'withdrawal',
    promotionStatus: 'cleaned',
    replayed: false
});
const promotionCleanupRecovery = await readPhotoProcessingEligibility(
    processingEnv,
    identity,
    stranded.draftId
);
assert.deepEqual(promotionCleanupRecovery, eligibility,
    'Deleting the promotion must not strand the still-staged processing cleanup.');
const processingCleanupResult = await cleanupProcessingRun(
    {
        DB: d1,
        PRIVATE_ORIGINALS: emptyStorage,
        DERIVATIVE_STAGING: emptyStorage
    },
    identity,
    stranded.processingRunId,
    {
        expectedStateVersion: abandoned.processingCleanup.expectedStateVersion,
        idempotencyKey: abandoned.processingCleanup.idempotencyKey
    },
    fixedNow + 3000
);
assert.deepEqual(processingCleanupResult, {
    ok: true,
    status: 201,
    processingRunId: stranded.processingRunId,
    cleanupReason: 'withdrawal',
    processingStatus: 'cleaned',
    replayed: false
});
assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM gallery_complete_photo_review_invalidation_cleanups
    WHERE draft_id = ? AND promotion_id = ? AND processing_run_id = ?
      AND cleanup_state_version = 5 AND withdrawal_kind = 'editorial-removal'
`).get(
    stranded.draftId,
    stranded.promotionId,
    stranded.processingRunId
).count, 1, 'Migration 0013 finalizer evidence must accept both exact cleanups.');
assert.deepEqual(await readPhotoProcessingEligibility(
    processingEnv,
    identity,
    stranded.draftId
), {
    ok: false,
    status: 409,
    code: 'processing-not-eligible'
}, 'Completed exact cleanup must not remain eligible as new abandonment work.');

const ownerWithdrawal = await initiateDraftWithdrawal(
    { DB: d1 },
    ownerIdentity,
    'family',
    ownerRace.draftId,
    'editorial-removal',
    {
        expectedStateVersion: 4,
        idempotencyKey: 'owner-race-withdrawal-0001'
    },
    fixedNow + 4000
);
assert.equal(ownerWithdrawal.ok, true, JSON.stringify(ownerWithdrawal));
assert.deepEqual(await readPhotoReviewInvalidation(
    reviewEnv,
    identity,
    ownerRace.draftId
), {
    ok: false,
    status: 404,
    code: 'not-found'
}, 'A real promotion cannot masquerade as processing-only recovery.');
assert.deepEqual(await readPhotoProcessingEligibility(
    processingEnv,
    identity,
    ownerRace.draftId
), {
    ...eligibility,
    draftId: ownerRace.draftId,
    processingRunId: ownerRace.processingRunId
});
const ownerRaceAbandonment = await abandonPhotoReviewCandidate(
    reviewEnv,
    identity,
    ownerRace.draftId,
    {
        expectedStateVersion: 4,
        failureEvidenceHash: hash('owner-race-stale-pre-candidate'),
        idempotencyKey: 'review-abandon-owner-race-0001'
    },
    fixedNow + 5000
);
assert.equal(ownerRaceAbandonment.ok, true, JSON.stringify(ownerRaceAbandonment));
assert.equal(ownerRaceAbandonment.abandonment.resultStateVersion, 5);
assert.deepEqual({ ...sqlite.prepare(`
    SELECT state, state_version AS stateVersion
    FROM gallery_drafts WHERE draft_id = ?
`).get(ownerRace.draftId) }, { state: 'withdrawal-pending', stateVersion: 5 });
assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count FROM draft_transition_receipts
    WHERE draft_id = ? AND from_state = 'processing'
      AND to_state = 'withdrawal-pending'
      AND expected_state_version = 4 AND result_state_version = 5
`).get(ownerRace.draftId).count, 1,
'Abandonment must reuse, not duplicate, the owner transition that won the race.');

const deniedAbandonment = await abandonPhotoReviewCandidate(
    reviewEnv,
    identity,
    inexact.draftId,
    {
        expectedStateVersion: 4,
        failureEvidenceHash: hash('inexact-stale-pre-candidate'),
        idempotencyKey: 'review-abandon-inexact-0002'
    },
    fixedNow + 6000
);
assert.equal(deniedAbandonment.ok, false);
assert.ok([404, 409].includes(deniedAbandonment.status));
assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM draft_photo_review_abandonment_receipts
    WHERE draft_id = ?
`).get(inexact.draftId).count, 0);
assert.deepEqual({ ...sqlite.prepare(`
    SELECT state, state_version AS stateVersion
    FROM gallery_drafts WHERE draft_id = ?
`).get(inexact.draftId) }, { state: 'processing', stateVersion: 4 });

assert.deepEqual(await readPhotoReviewInvalidation(
    reviewEnv,
    identity,
    processingOnly.draftId
), {
    ok: false,
    status: 404,
    code: 'not-found'
}, 'Processing-only staging is not recoverable before explicit owner withdrawal.');
const wrongOwnerWithdrawal = await initiateDraftWithdrawal(
    { DB: d1 },
    ownerIdentity,
    'family',
    processingOnlyWrongOwner.draftId,
    'editorial-removal',
    {
        expectedStateVersion: 4,
        idempotencyKey: 'processing-only-wrong-owner-0001'
    },
    fixedNow + 6500
);
assert.equal(wrongOwnerWithdrawal.ok, true);
assert.deepEqual(await readPhotoReviewInvalidation(
    reviewEnv,
    identity,
    processingOnlyWrongOwner.draftId
), {
    ok: false,
    status: 404,
    code: 'not-found'
}, 'A withdrawal audit from a different verified owner must fail closed.');
const processingOnlyWithdrawal = await initiateDraftWithdrawal(
    { DB: d1 },
    ownerIdentity,
    'family',
    processingOnly.draftId,
    'editorial-removal',
    {
        expectedStateVersion: 19,
        idempotencyKey: 'processing-only-withdrawal-0001'
    },
    fixedNow + 7000
);
assert.equal(processingOnlyWithdrawal.ok, true, JSON.stringify(processingOnlyWithdrawal));
const processingOnlyReceipt = await readPhotoReviewInvalidation(
    reviewEnv,
    identity,
    processingOnly.draftId
);
assert.equal(processingOnlyReceipt.ok, true, JSON.stringify(processingOnlyReceipt));
assert.equal(processingOnlyReceipt.receiptKind, 'processing-only');
assert.equal(
    processingOnlyReceipt.recovery.processingRunId,
    processingOnly.processingRunId
);
assert.equal(processingOnlyReceipt.recovery.expectedStateVersion, 19);
assert.equal(processingOnlyReceipt.recovery.cleanupStateVersion, 20);
assert.deepEqual(Object.keys(processingOnlyReceipt).sort(), [
    'ok', 'processingCleanup', 'receiptKind', 'recovery', 'replayed', 'status'
]);
const deliveryEpoch = insertCurrentDeliveryEpoch();
const zeroGenerationHost = insertZeroGenerationWithdrawalHostReceipt(
    processingOnly,
    deliveryEpoch,
    20
);
sqlite.prepare(`
    UPDATE draft_publication_references
       SET host_deletion_confirmed = 1,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE draft_id = ?
`).run(processingOnly.draftId);
const withdrawalKeyDigest = hash(
    `gallery-withdrawal:${processingOnly.draftId}`
);
const withdrawalRequest = {
    idempotencyKey:
        `gallery-withdrawal-${withdrawalKeyDigest.slice(0, 32)}`
};
const incompleteCleanupFinalization = await finalizeGalleryWithdrawal(
    {
        DB: d1,
        PRIVATE_ORIGINALS: unavailableStorage
    },
    identity,
    processingOnly.draftId,
    withdrawalRequest
);
assert.equal(incompleteCleanupFinalization.ok, false);
assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM draft_withdrawal_finalization_operations
    WHERE draft_id = ?
`).get(processingOnly.draftId).count, 0,
'A current zero-generation host receipt cannot bypass incomplete staging cleanup.');
assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM gallery_withdrawal_completion_receipts
    WHERE draft_id_hash = ?
`).get(hash(`draft-id:${processingOnly.draftId}`)).count, 0);
const processingOnlyCleanupResult = await cleanupProcessingRun(
    {
        DB: d1,
        PRIVATE_ORIGINALS: emptyStorage,
        DERIVATIVE_STAGING: emptyStorage
    },
    identity,
    processingOnly.processingRunId,
    {
        expectedStateVersion:
            processingOnlyReceipt.processingCleanup.expectedStateVersion,
        idempotencyKey: processingOnlyReceipt.processingCleanup.idempotencyKey
    },
    fixedNow + 8000
);
assert.equal(processingOnlyCleanupResult.ok, true);
assert.equal(processingOnlyCleanupResult.processingStatus, 'cleaned');
const processingOnlyReplay = await readPhotoReviewInvalidation(
    reviewEnv,
    identity,
    processingOnly.draftId
);
assert.deepEqual(
    processingOnlyReplay.processingCleanup,
    processingOnlyReceipt.processingCleanup,
    'Completed processing-only cleanup must retain the exact replay package.'
);
assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM gallery_complete_photo_withdrawal_cleanups
    WHERE draft_id = ? AND processing_run_id = ?
      AND promotion_id IS NULL AND cleanup_state_version = 20
      AND withdrawal_kind = 'editorial-removal'
`).get(processingOnly.draftId, processingOnly.processingRunId).count, 1);

const completedEvidenceBefore = readPreservedEvidence();
const finalizerStorageCalls = [];
const forbiddenOriginals = Object.fromEntries(['head', 'get', 'delete', 'list'].map(
    method => [method, async () => {
        finalizerStorageCalls.push(method);
        throw new Error('Retained withdrawal must not touch private originals.');
    }]
));
const contextFaults = legacyIntake ? [
    { syntheticOnlyConfirmed: 0 }, { syntheticOnlyConfirmed: null },
    { syntheticOnlyConfirmed: '1' }, { realPhotoIntakeConfirmed: null },
    { realPhotoIntakeConfirmed: '0' }, { realPhotoIntakeConfirmed: 2 },
    { declaredSha256: hash('not-a-legacy-null') }, { declaredSha256: undefined },
    { uploadSessionId: 'upload_' + '0'.repeat(32) },
    { stateVersion: 19 }, { draftId: stranded.draftId },
    { originalSha256: hash('mismatched-original') },
    { activeConsentRevision: 'different-consent' },
    { consentWithdrawnAt: '2026-09-11T02:00:00.000Z' },
    { mediaDeliveryEpochIdHash: hash('stale-epoch') },
    { hostExpectedStateVersion: 19 },
    { generationCount: 1, targetCount: 2 },
    { generationCount: 0, targetCount: 1 },
    { withdrawalKind: 'consent-withdrawal' },
    { withdrawalKind: 'athlete-exclusion' }
] : [{ realPhotoIntakeConfirmed: 0 }];
for (const fault of contextFaults) {
    const denied = await finalizeGalleryWithdrawal({
        DB: createSqliteD1(sqlite, (sql, row) =>
            sql.includes('AS realPhotoIntakeConfirmed') && row
                ? { ...row, ...fault } : row),
        PRIVATE_ORIGINALS: forbiddenOriginals
    }, identity, processingOnly.draftId, withdrawalRequest);
    assert.deepEqual(denied, { ok: false, status: 409, code: 'conflict' },
        JSON.stringify(fault));
}
if (legacyIntake) {
    const query = withdrawalFinalizerTestHooks.legacyProcessingOnlyCleanupSelect;
    for (const bindings of [
        [stranded.draftId, 20, originalUpload.upload_session_id],
        [processingOnly.draftId, 19, originalUpload.upload_session_id],
        [processingOnly.draftId, 20, 'upload_' + '0'.repeat(32)]
    ]) assert.equal(sqlite.prepare(query).get(...bindings).cleanupCount, 0);
    for (const cleanupCount of [0, 2, null, '1', undefined]) {
        const denied = await finalizeGalleryWithdrawal({
            DB: createSqliteD1(sqlite, (sql, row) =>
                sql === query ? { cleanupCount } : row),
            PRIVATE_ORIGINALS: forbiddenOriginals
        }, identity, processingOnly.draftId, withdrawalRequest);
        assert.deepEqual(denied, { ok: false, status: 409, code: 'conflict' });
    }
}
assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count FROM draft_withdrawal_finalization_operations
    WHERE draft_id = ?
`).get(processingOnly.draftId).count, 0);
assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count FROM gallery_withdrawal_completion_receipts
    WHERE draft_id_hash = ?
`).get(hash(`draft-id:${processingOnly.draftId}`)).count, 0);
assert.deepEqual(readPreservedEvidence(), completedEvidenceBefore);
assert.deepEqual(finalizerStorageCalls, []);

const finalizationResult = await finalizeGalleryWithdrawal(
    {
        DB: d1,
        PRIVATE_ORIGINALS: forbiddenOriginals
    },
    identity,
    processingOnly.draftId,
    withdrawalRequest
);
assert.deepEqual(finalizationResult, {
    ok: true,
    status: 201,
    code: 'withdrawn',
    replayed: false
});
assert.deepEqual({ ...sqlite.prepare(`
    SELECT draft.state, draft.state_version AS stateVersion,
           upload.status AS uploadStatus,
           publication.private_original_deletion_confirmed AS privateDeleted,
           receipt.generation_count AS generationCount,
           receipt.target_count AS targetCount,
           receipt.public_host_final_receipt_hash AS finalReceiptHash
    FROM gallery_drafts AS draft
    JOIN draft_upload_sessions AS upload ON upload.draft_id = draft.draft_id
    JOIN draft_publication_references AS publication
      ON publication.draft_id = draft.draft_id
    JOIN gallery_withdrawal_completion_receipts AS receipt
      ON receipt.draft_id_hash = ?
    WHERE draft.draft_id = ?
`).get(
    hash(`draft-id:${processingOnly.draftId}`),
    processingOnly.draftId
) }, {
    state: 'withdrawn',
    stateVersion: 21,
    uploadStatus: 'complete',
    privateDeleted: 0,
    generationCount: 0,
    targetCount: 0,
    finalReceiptHash: zeroGenerationHost.finalReceiptHash
});

assert.deepEqual(readPreservedEvidence(), completedEvidenceBefore,
    'Attestations, completed cleanup and host proof must not be rewritten.');
assert.deepEqual(await finalizeGalleryWithdrawal({
    DB: d1, PRIVATE_ORIGINALS: forbiddenOriginals
}, identity, processingOnly.draftId, withdrawalRequest), {
    ok: true, status: 200, code: 'withdrawn', replayed: true
});
const retained = sqlite.prepare(`
    SELECT withdrawn_at, retention_eligible_at FROM gallery_withdrawal_completion_receipts
    WHERE draft_id_hash = ?
`).get(hash(`draft-id:${processingOnly.draftId}`));
assert.equal(Date.parse(retained.retention_eligible_at) - Date.parse(retained.withdrawn_at),
    30 * 24 * 60 * 60 * 1000);
assert.deepEqual(await finalizeGalleryWithdrawal({
    DB: d1, PRIVATE_ORIGINALS: forbiddenOriginals
}, identity, processingOnly.draftId, {
    idempotencyKey: `gallery-purge-${hash(`gallery-purge:${processingOnly.draftId}`).slice(0, 32)}`
}), {
    ok: true, status: 202, code: 'retention-pending',
    eligibleAt: retained.retention_eligible_at, replayed: false
});
assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count FROM draft_withdrawal_finalization_operations
    WHERE draft_id = ? AND action = 'purge'
`).get(processingOnly.draftId).count, 0);
assert.deepEqual(finalizerStorageCalls, []);

assert.equal(sqlite.prepare('PRAGMA foreign_key_check').all().length, 0);
assert.equal(sqlite.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
sqlite.close();

console.log(
    'Gallery pre-candidate abandonment: exact stale D1 lineage, no stale-byte ' +
    'read, receipt and partial-cleanup recovery, owner-withdrawal race handling, ' +
    'truthful processing transition reuse, processing-only owner recovery, ' +
    `zero-generation finalization (${legacyIntake ? 'pre-0010 synthetic' : 'current intake'}), ` +
    'immutable attestations, preserved evidence, retention and fail-closed behavior passed.'
);
if (!legacyIntake) {
    const legacy = spawnSync(process.execPath, [
        fileURLToPath(import.meta.url), '--legacy-intake'
    ], { encoding: 'utf8', windowsHide: true });
    assert.equal(legacy.status, 0, legacy.stdout + legacy.stderr);
    console.log(legacy.stdout.trim());
}

function seedPreCandidate(label, ordinal, {
    mismatchTarget = false,
    includePromotion = true,
    legacyUpload = false,
    processingVersion = 4,
    ownerActorHash = null
} = {}) {
    const draftId = `draft_${uuid(`draft:${label}`)}`;
    const uploadSessionId = `upload_${identifierHex(`upload:${label}`)}`;
    const processingRunId = `run_${identifierHex(`run:${label}`)}`;
    const promotionId = `promotion_${identifierHex(`promotion:${label}`)}`;
    const consentRevision = `consent-pre-candidate-${label}`;
    const timestamp = `2026-09-0${ordinal}T00:00:00.000Z`;
    const actorHash = ownerActorHash || hash(`actor:${label}`);
    const originalSha256 = hash(`original:${label}`);
    const originalObjectKey =
        `private-originals/v1/family/2026/09/${draftId}/${uploadSessionId}/original.jpg`;
    const metadataScanJson =
        '{"schemaVersion":"1.0","scannerName":"exiftool","scannerVersion":' +
        '"13.40","metadataEntryCount":0,"findingCategories":[]}';
    const promotionIdempotencyKey = `promotion-start-${label}-0001`;

    sqlite.prepare(`
        INSERT INTO gallery_drafts (
            draft_id, public_item_id, state, state_version, site_modes_json,
            export_bundle_id, source_revision, suppression_revision,
            item_revision, media_type, race_date, race_event, race_distance,
            athlete_ids_json, title, caption, alt_text, featured,
            original_object_key, original_detected_type, original_byte_count,
            original_sha256, upload_complete, verified_owner_identity_hash,
            created_at, updated_at
        ) VALUES (?, ?, 'processing', ${processingVersion}, '["family"]', ?, ?, ?, ?, 'photo',
            '2026-09-01', 'Historical synthetic race', '5 km', '[]',
            'Historical synthetic photo', 'Generated test data only.',
            'Generated test image.', 0, ?, 'jpeg', 1024, ?, 1, ?, ?, ?)
    `).run(
        draftId,
        `pre-candidate-${label}`,
        `stale-bundle-${label}`,
        `stale-source-${label}`,
        `stale-suppression-${label}`,
        `item-pre-candidate-${label}`,
        originalObjectKey,
        originalSha256,
        actorHash,
        timestamp,
        timestamp
    );
    sqlite.prepare(`
        INSERT INTO draft_consent_attestations (
            draft_id, consent_revision, public_use_confirmed, contains_minors,
            guardian_approval_confirmed, verified_owner_identity_hash, attested_at
        ) VALUES (?, ?, 1, 0, 0, ?, ?)
    `).run(draftId, consentRevision, actorHash, timestamp);
    sqlite.prepare(`
        UPDATE gallery_drafts SET active_consent_revision = ? WHERE draft_id = ?
    `).run(consentRevision, draftId);
    sqlite.prepare(`
        INSERT INTO draft_upload_sessions (
            upload_session_id, draft_id, item_revision, consent_revision,
            export_bundle_id, source_revision, suppression_revision,
            provider_upload_id, object_key, file_extension,
            declared_content_type, declared_byte_count, part_size, part_count,
            next_part_number, uploaded_byte_count, detected_format, status,
            completed_object_version, completed_etag, completed_sha256,
            synthetic_only_confirmed, verified_owner_identity_hash,
            initiation_idempotency_key, initiation_payload_fingerprint,
            completion_idempotency_key, completion_payload_fingerprint,
            completion_started_at, created_at, updated_at, expires_at,
            completed_at${legacyUpload ? '' : ', declared_sha256, real_photo_intake_confirmed'}
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'jpg', 'image/jpeg', 1024,
            5242880, 1, 2, 1024, 'jpeg', 'complete', ?, ?, ?, 1, ?, ?, ?, ?,
            ?, ?, ?, ?, '2026-10-01T00:00:00.000Z', ?${legacyUpload ? '' : ', ?, 1'})
    `).run(
        uploadSessionId,
        draftId,
        `item-pre-candidate-${label}`,
        consentRevision,
        `stale-bundle-${label}`,
        `stale-source-${label}`,
        `stale-suppression-${label}`,
        `provider-upload-${label}`,
        originalObjectKey,
        `original-version-${label}`,
        `original-etag-${label}`,
        originalSha256,
        actorHash,
        `upload-init-${label}-0001`,
        hash(`upload-init:${label}`),
        `upload-complete-${label}-0001`,
        hash(`upload-complete:${label}`),
        timestamp,
        timestamp,
        timestamp,
        timestamp,
        ...(legacyUpload ? [] : [originalSha256])
    );
    sqlite.prepare(`
        INSERT INTO draft_processing_runs (
            processing_run_id, draft_id, site_mode, media_type, item_revision,
            consent_revision, export_bundle_id, source_revision,
            suppression_revision, upload_session_id, original_object_key,
            original_detected_type, original_declared_content_type,
            original_byte_count, original_sha256, original_object_version,
            original_etag, start_expected_state_version,
            processing_state_version, start_idempotency_key,
            start_payload_fingerprint, service_actor_identity_hash, status,
            result_idempotency_key, result_payload_fingerprint,
            result_toolchain_json, created_at, updated_at, completed_at
        ) VALUES (?, ?, 'family', 'photo', ?, ?, ?, ?, ?, ?, ?, 'jpeg',
            'image/jpeg', 1024, ?, ?, ?, ${processingVersion - 1}, ${processingVersion}, ?, ?, ?, 'staged', ?, ?,
            '{"sharp":"0.35.2","libvips":"8.18.3","webp":"1.6.0",' ||
            '"png":"1.6.58","exiftool":"13.40","videoEnabled":false}',
            ?, ?, ?)
    `).run(
        processingRunId,
        draftId,
        `item-pre-candidate-${label}`,
        consentRevision,
        `stale-bundle-${label}`,
        `stale-source-${label}`,
        `stale-suppression-${label}`,
        uploadSessionId,
        originalObjectKey,
        originalSha256,
        `original-version-${label}`,
        `original-etag-${label}`,
        `processing-start-${label}-0001`,
        hash(`processing-start:${label}`),
        actorHash,
        `processing-result-${label}-0001`,
        hash(`processing-result:${label}`),
        timestamp,
        timestamp,
        timestamp
    );
    sqlite.prepare(`
        INSERT INTO gallery_audit_events (
            audit_event_id, subject_reference_hash, event_type, state_version,
            actor_identity_hash, payload_hash, occurred_at
        ) VALUES (?, ?, 'processing-staged', ${processingVersion}, ?, ?, ?)
    `).run(
        `audit_processing_staged_${identifierHex(label)}`,
        hash(`draft:${draftId}`),
        actorHash,
        hash(`processing-result:${label}`),
        timestamp
    );

    const rows = [];
    for (const [role, fileName, width, height] of [
        ['photo-display', 'display.webp', 1600, 1000],
        ['photo-thumbnail', 'thumbnail.webp', 480, 300]
    ]) {
        const sha256 = hash(`${label}:${role}:bytes`);
        const stagingObjectKey =
            `derivative-staging/v1/family/${draftId}/${processingRunId}/` +
            `${sha256}/${fileName}`;
        const approvedObjectKey = `media/v1/${sha256}/${fileName}`;
        rows.push({ role, sha256, stagingObjectKey, approvedObjectKey, width, height });
        sqlite.prepare(`
            INSERT INTO draft_processing_outputs (
                processing_run_id, role, upload_idempotency_key,
                upload_payload_fingerprint, staging_object_key, sha256,
                byte_count, content_type, width, height, status,
                staging_object_version, staging_etag, metadata_scan_json,
                scanner_version, created_at, stored_at, verified_at
            ) VALUES (?, ?, ?, ?, ?, ?, 512, 'image/webp', ?, ?, 'verified',
                ?, ?, ?, '13.40', ?, ?, ?)
        `).run(
            processingRunId,
            role,
            `processing-output-${label}-${role}`,
            hash(`processing-output:${label}:${role}`),
            stagingObjectKey,
            sha256,
            width,
            height,
            `staging-version-${label}-${role}`,
            `staging-etag-${label}-${role}`,
            metadataScanJson,
            timestamp,
            timestamp,
            timestamp
        );
        sqlite.prepare(`
            INSERT INTO draft_derivatives (
                draft_id, item_revision, consent_revision, export_bundle_id,
                source_revision, suppression_revision, role,
                staging_object_key, approved_object_key, byte_count, sha256,
                content_type, width, height, duration_milliseconds,
                metadata_scan_json, scanner_version, verified_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 512, ?, 'image/webp',
                ?, ?, NULL, ?, '13.40', ?)
        `).run(
            draftId,
            `item-pre-candidate-${label}`,
            consentRevision,
            `stale-bundle-${label}`,
            `stale-source-${label}`,
            `stale-suppression-${label}`,
            role,
            stagingObjectKey,
            sha256,
            width,
            height,
            metadataScanJson,
            timestamp
        );
    }

    if (includePromotion) sqlite.prepare(`
        INSERT INTO draft_photo_promotions (
            promotion_id, processing_run_id, draft_id, site_mode,
            item_revision, consent_revision, export_bundle_id, source_revision,
            suppression_revision, expected_state_version, result_state_version,
            idempotency_key, idempotency_key_hash, payload_fingerprint,
            service_actor_identity_hash, status, created_at, updated_at
        ) VALUES (?, ?, ?, 'family', ?, ?, ?, ?, ?, 4, 5, ?, ?, ?, ?,
            'active', ?, ?)
    `).run(
        promotionId,
        processingRunId,
        draftId,
        `item-pre-candidate-${label}`,
        consentRevision,
        `stale-bundle-${label}`,
        `stale-source-${label}`,
        `stale-suppression-${label}`,
        promotionIdempotencyKey,
        hash(`promotion-idempotency-key:${promotionIdempotencyKey}`),
        hash(`promotion-payload:${label}`),
        actorHash,
        timestamp,
        timestamp
    );
    if (includePromotion) for (const row of rows) {
        sqlite.prepare(`
            INSERT INTO draft_photo_promotion_objects (
                promotion_id, role, staging_object_key,
                staging_object_version, staging_etag, approved_object_key,
                sha256, byte_count, content_type, width, height, status,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 512, 'image/webp', ?, ?,
                'reserved', ?, ?)
        `).run(
            promotionId,
            row.role,
            row.stagingObjectKey,
            `staging-version-${label}-${row.role}`,
            `staging-etag-${label}-${row.role}`,
            row.approvedObjectKey,
            row.sha256,
            row.width,
            row.height,
            timestamp,
            timestamp
        );
    }

    const targetSetHash = hash(`target-set:${label}`);
    if (includePromotion) sqlite.prepare(`
        INSERT INTO draft_photo_public_generations (
            promotion_id, promotion_id_hash, draft_id, draft_id_hash,
            approved_origin, approved_origin_hash, candidate_state_version,
            generation_fingerprint, target_set_hash, created_at
        ) VALUES (?, ?, ?, ?, 'https://media.synthetic.example', ?, 5, ?, ?, ?)
    `).run(
        promotionId,
        hash(`promotion-id:${promotionId}`),
        draftId,
        hash(`draft-id:${draftId}`),
        hash('approved-origin:https://media.synthetic.example'),
        hash(`generation:${label}`),
        targetSetHash,
        timestamp
    );
    if (includePromotion) for (const [index, row] of rows.entries()) {
        const targetSha = mismatchTarget && index === 0
            ? hash(`mismatched-target:${label}`)
            : row.sha256;
        const targetKey = mismatchTarget && index === 0
            ? `media/v1/${targetSha}/display.webp`
            : row.approvedObjectKey;
        sqlite.prepare(`
            INSERT INTO draft_photo_public_generation_targets (
                promotion_id, role, approved_object_key,
                approved_object_key_hash, public_url_hash, expected_sha256,
                generation_target_set_hash, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            promotionId,
            row.role,
            targetKey,
            hash(`approved-key:${targetKey}`),
            hash(`public-url:${targetKey}`),
            targetSha,
            targetSetHash,
            timestamp
        );
    }

    return {
        draftId,
        processingRunId,
        promotionId: includePromotion ? promotionId : null
    };
}

function insertCurrentDeliveryEpoch() {
    const epoch = {
        epochId: 'media_delivery_epoch_processing_only',
        epochIdHash: hash('epoch:processing-only'),
        origin: 'https://media.synthetic.example',
        originHash: hash('approved-origin:https://media.synthetic.example'),
        contractHash: hash('delivery-contract:processing-only'),
        versionHash: hash('delivery-version:processing-only'),
        witnessKeyHash: hash('witness-key:processing-only'),
        witnessSha256: hash('witness-bytes:processing-only'),
        configurationHash: hash('delivery-configuration:processing-only'),
        activationReceiptHash: hash('epoch-activation:processing-only'),
        registeredAt: '2026-09-11T02:00:00.000Z',
        activatedAt: '2026-09-11T02:00:01.000Z'
    };
    const actorHash = hash('delivery-actor');
    sqlite.prepare(`
        INSERT INTO gallery_media_delivery_epochs (
            epoch_id, epoch_id_hash, epoch_sequence, approved_origin,
            approved_origin_hash, delivery_contract_hash, delivery_version_hash,
            witness_object_key_hash, witness_sha256, witness_byte_count,
            witness_content_type, configuration_hash,
            registered_by_identity_hash, registered_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 44, 'image/webp', ?, ?, ?)
    `).run(
        epoch.epochId,
        epoch.epochIdHash,
        epoch.origin,
        epoch.originHash,
        epoch.contractHash,
        epoch.versionHash,
        epoch.witnessKeyHash,
        epoch.witnessSha256,
        epoch.configurationHash,
        actorHash,
        epoch.registeredAt
    );
    sqlite.prepare(`
        INSERT INTO gallery_media_delivery_epoch_activations (
            activation_receipt_hash, epoch_id_hash, epoch_sequence,
            previous_epoch_id_hash, activation_idempotency_key_hash,
            activation_payload_hash, service_actor_identity_hash, activated_at
        ) VALUES (?, ?, 1, NULL, ?, ?, ?, ?)
    `).run(
        epoch.activationReceiptHash,
        epoch.epochIdHash,
        hash('epoch-activation-idempotency:processing-only'),
        hash('epoch-activation-payload:processing-only'),
        actorHash,
        epoch.activatedAt
    );
    sqlite.prepare(`
        INSERT INTO gallery_media_delivery_current_epoch (
            singleton_id, epoch_id_hash, epoch_sequence,
            activation_receipt_hash, activated_at
        ) VALUES (1, ?, 1, ?, ?)
    `).run(
        epoch.epochIdHash,
        epoch.activationReceiptHash,
        epoch.activatedAt
    );
    return epoch;
}

function insertZeroGenerationWithdrawalHostReceipt(fixture, epoch, stateVersion) {
    const verificationId =
        `hostverify_${identifierHex('processing-only-withdrawal')}`;
    const host = {
        verificationIdHash: hash(`verification:${verificationId}`),
        finalReceiptHash: hash('host-final-receipt:processing-only'),
        withdrawalCycleHash: hash('withdrawal-cycle:processing-only'),
        emptySetHash: hash(''),
        idempotencyKey: 'host-absence-processing-only-0001',
        idempotencyKeyHash: hash('host-idempotency:processing-only'),
        payloadFingerprint: hash('host-payload:processing-only')
    };
    const draftIdHash = hash(`draft-id:${fixture.draftId}`);
    const verificationCreatedAt = '2026-09-11T02:01:00.000Z';
    const witnessVerifiedAt = '2026-09-11T02:01:01.000Z';
    const receiptVerifiedAt = '2026-09-11T02:01:02.000Z';
    sqlite.prepare(`
        INSERT INTO draft_public_host_absence_verifications (
            verification_id, verification_id_hash, draft_id, draft_id_hash,
            expected_state_version, verification_purpose,
            purpose_evidence_hash, withdrawal_kind, withdrawal_cycle_hash,
            promotion_set_hash, cleanup_evidence_set_hash,
            approved_origin_hash, target_set_hash, generation_count,
            generation_target_row_count, target_count,
            media_delivery_epoch_id_hash, delivery_contract_hash,
            delivery_version_hash, idempotency_key, idempotency_key_hash,
            payload_fingerprint, service_actor_identity_hash, created_at
        ) VALUES (
            ?, ?, ?, ?, ?, 'withdrawal', NULL, 'editorial-removal', ?,
            ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?
        )
    `).run(
        verificationId,
        host.verificationIdHash,
        fixture.draftId,
        draftIdHash,
        stateVersion,
        host.withdrawalCycleHash,
        host.emptySetHash,
        host.emptySetHash,
        epoch.originHash,
        host.emptySetHash,
        epoch.epochIdHash,
        epoch.contractHash,
        epoch.versionHash,
        host.idempotencyKey,
        host.idempotencyKeyHash,
        host.payloadFingerprint,
        hash('finalizer-service-actor'),
        verificationCreatedAt
    );
    sqlite.prepare(`
        INSERT INTO draft_public_host_absence_witness_proofs (
            verification_id, witness_object_key_hash, witness_sha256,
            witness_byte_count, witness_content_type,
            before_head_evidence_hash, before_get_evidence_hash,
            after_head_evidence_hash, after_get_evidence_hash,
            observed_contract_hash, observed_version_hash, verified_at
        ) VALUES (?, ?, ?, 44, 'image/webp', ?, ?, ?, ?, ?, ?, ?)
    `).run(
        verificationId,
        epoch.witnessKeyHash,
        epoch.witnessSha256,
        hash('witness-before-head:processing-only'),
        hash('witness-before-get:processing-only'),
        hash('witness-after-head:processing-only'),
        hash('witness-after-get:processing-only'),
        epoch.contractHash,
        epoch.versionHash,
        witnessVerifiedAt
    );
    sqlite.prepare(`
        INSERT INTO gallery_public_host_absence_receipts (
            final_receipt_hash, verification_id_hash, draft_id_hash,
            promotion_set_hash, cleanup_evidence_set_hash,
            withdrawal_cycle_hash, approved_origin_hash, target_set_hash,
            generation_count, target_count, verified_state_version,
            verification_purpose, purpose_evidence_hash,
            media_delivery_epoch_id_hash, delivery_contract_hash,
            delivery_version_hash, idempotency_key_hash,
            payload_fingerprint, verified_at
        ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 'withdrawal', NULL,
            ?, ?, ?, ?, ?, ?
        )
    `).run(
        host.finalReceiptHash,
        host.verificationIdHash,
        draftIdHash,
        host.emptySetHash,
        host.emptySetHash,
        host.withdrawalCycleHash,
        epoch.originHash,
        host.emptySetHash,
        stateVersion,
        epoch.epochIdHash,
        epoch.contractHash,
        epoch.versionHash,
        host.idempotencyKeyHash,
        host.payloadFingerprint,
        receiptVerifiedAt
    );
    return host;
}

function readPreservedEvidence() {
    return {
        upload: sqlite.prepare('SELECT * FROM draft_upload_sessions WHERE draft_id = ?')
            .all(processingOnly.draftId),
        consent: sqlite.prepare('SELECT * FROM draft_consent_attestations WHERE draft_id = ?')
            .all(processingOnly.draftId),
        cleanups: sqlite.prepare('SELECT * FROM draft_processing_cleanups WHERE draft_id = ?')
            .all(processingOnly.draftId),
        tombstones: sqlite.prepare('SELECT * FROM gallery_processing_cleanup_tombstones').all(),
        host: sqlite.prepare('SELECT * FROM gallery_public_host_absence_receipts').all()
    };
}

function createSqliteD1(database, mapFirst = (_sql, row) => row) {
    class Statement {
        constructor(sql, bindings = []) {
            this.sql = sql;
            this.bindings = bindings;
        }
        bind(...bindings) {
            return new Statement(this.sql, bindings);
        }
        async first(columnName) {
            const row = mapFirst(this.sql,
                database.prepare(this.sql).get(...this.bindings) ?? null);
            return columnName === undefined || row === null ? row : row[columnName];
        }
        async all() {
            return {
                success: true,
                results: database.prepare(this.sql).all(...this.bindings)
            };
        }
        runSynchronously() {
            const result = database.prepare(this.sql).run(...this.bindings);
            return { success: true, meta: { changes: Number(result.changes) } };
        }
        async run() {
            return this.runSynchronously();
        }
    }
    return {
        prepare(sql) {
            return new Statement(sql);
        },
        async batch(statements) {
            database.exec('BEGIN IMMEDIATE');
            try {
                const results = statements.map(statement => statement.runSynchronously());
                database.exec('COMMIT');
                return results;
            } catch (error) {
                if (database.isTransaction) database.exec('ROLLBACK');
                throw error;
            }
        }
    };
}

function identifierHex(value) {
    const digest = hash(value).slice(0, 32).split('');
    digest[12] = '4';
    digest[16] = '8';
    return digest.join('');
}

function uuid(value) {
    const hex = identifierHex(value);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
        `${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function hash(value) {
    return createHash('sha256').update(value).digest('hex');
}
