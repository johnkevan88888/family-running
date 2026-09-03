import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

import { finalizeGalleryWithdrawal } from
    '../gallery-admin/src/withdrawal-finalizer-service.js';

const APPROVED_ORIGIN = 'https://media.synthetic.example';
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
    '0013_withdrawal_finalization.sql'
];
const migrations = await Promise.all(migrationNames.map(name => readFile(
    new URL(`../gallery-admin/migrations/${name}`, import.meta.url),
    'utf8'
)));

const sqlite = new DatabaseSync(':memory:');
for (const migration of migrations.slice(0, -1)) sqlite.exec(migration);

// The earlier migration suites already prove their own admission paths. This
// fixture temporarily removes and then restores those exact triggers so it can
// assemble two fully linked, already-reviewed photos without re-running the
// browser, processor, promotion, review and cleanup Workers. Migration 0013 is
// then applied normally, and every finalizer trigger remains real and active.
const suspendedTriggers = suspendAllTriggers(sqlite);
const epoch = seedDeliveryEpoch(sqlite);
const editorial = seedReviewedPhoto(sqlite, {
    ordinal: 1,
    withdrawalKind: 'editorial-removal'
});
const consent = seedReviewedPhoto(sqlite, {
    ordinal: 2,
    withdrawalKind: 'consent-withdrawal'
});
const athleteExclusion = seedReviewedPhoto(sqlite, {
    ordinal: 3,
    withdrawalKind: 'athlete-exclusion'
});
restoreTriggers(sqlite, suspendedTriggers);
sqlite.exec(migrations.at(-1));

assert.equal(sqlite.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
assert.equal(sqlite.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');

const d1 = createSqliteD1(sqlite);
const originals = createPrivateOriginalsBucket();
originals.seed(editorial.objectKey, editorial.bytes, {
    version: editorial.providerVersion,
    etag: editorial.providerEtag
});
originals.seed(consent.objectKey, consent.bytes, {
    version: consent.providerVersion,
    etag: consent.providerEtag
});
originals.seed(athleteExclusion.objectKey, athleteExclusion.bytes, {
    version: athleteExclusion.providerVersion,
    etag: athleteExclusion.providerEtag
});
const env = { DB: d1, PRIVATE_ORIGINALS: originals };
const identity = {
    type: 'service',
    subject: '0123456789abcdef0123456789abcdef.access'
};

// The service must ask the protected workflow for exact public-host proof
// before reserving either a withdrawal operation or an R2 deletion.
const noHostCalls = originals.calls.length;
const needsHostProof = await finalizeGalleryWithdrawal(
    env,
    identity,
    editorial.draftId,
    { idempotencyKey: editorial.withdrawalKey }
);
assert.equal(needsHostProof.ok, true, JSON.stringify(needsHostProof));
assert.equal(needsHostProof.status, 202);
assert.equal(needsHostProof.code, 'host-verification-required');
assert.equal(needsHostProof.expectedStateVersion, 7);
assert.match(needsHostProof.verifierIdempotencyKey, /^gallery_host_[a-f0-9]{48}$/);
assert.equal(needsHostProof.replayed, false);
assert.equal(originals.calls.length, noHostCalls);
assert.equal(count(sqlite, 'draft_withdrawal_finalization_operations'), 0);
assert.equal(count(sqlite, 'draft_private_original_deletions'), 0);

// A purge key cannot be smuggled into the earlier withdrawal phase.
assert.notEqual(editorial.withdrawalKey, editorial.purgeKey);
const earlyWrongAction = await finalizeGalleryWithdrawal(
    env,
    identity,
    editorial.draftId,
    { idempotencyKey: editorial.purgeKey }
);
assert.deepEqual(earlyWrongAction, { ok: false, status: 409, code: 'conflict' });
assert.equal(count(sqlite, 'draft_withdrawal_finalization_operations'), 0);
assert.equal(originals.calls.length, noHostCalls);

seedCurrentHostProof(sqlite, editorial, epoch);
const editorialCallsBefore = originals.calls.length;
const withdrawnEditorial = await finalizeGalleryWithdrawal(
    env,
    identity,
    editorial.draftId,
    { idempotencyKey: editorial.withdrawalKey }
);
assert.equal(withdrawnEditorial.ok, true, JSON.stringify(withdrawnEditorial));
assert.equal(withdrawnEditorial.status, 201);
assert.equal(withdrawnEditorial.code, 'withdrawn');
assert.equal(withdrawnEditorial.replayed, false);
assert.equal(originals.calls.length, editorialCallsBefore,
    'Editorial withdrawal must retain the private original without even reading R2.');
assert.equal(originals.has(editorial.objectKey), true);
assert.deepEqual(readDraft(sqlite, editorial.draftId), {
    state: 'withdrawn',
    stateVersion: 8,
    activeConsentRevision: editorial.consentRevision,
    updatedAt: readWithdrawalReceipt(sqlite, editorial).withdrawnAt
});
assert.deepEqual(readUpload(sqlite, editorial.uploadId), {
    status: 'complete',
    objectDeletedAt: null
});
assert.deepEqual(readPublication(sqlite, editorial.draftId), {
    hostDeletionConfirmed: 1,
    privateDeletionConfirmed: 0,
    withdrawalKind: 'editorial-removal'
});
const editorialReceipt = readWithdrawalReceipt(sqlite, editorial);
assert.equal(editorialReceipt.generationCount, 1);
assert.equal(editorialReceipt.targetCount, 2);
assert.equal(editorialReceipt.privateDeletionReceiptHash, null);
assert.equal(
    Date.parse(editorialReceipt.retentionEligibleAt) -
        Date.parse(editorialReceipt.withdrawnAt),
    30 * 24 * 60 * 60 * 1000
);

const editorialReplayCalls = originals.calls.length;
assert.deepEqual(await finalizeGalleryWithdrawal(
    env,
    identity,
    editorial.draftId,
    { idempotencyKey: editorial.withdrawalKey }
), { ok: true, status: 200, code: 'withdrawn', replayed: true });
assert.equal(originals.calls.length, editorialReplayCalls);

// The second approval is deliberately non-destructive until SQL's immutable
// 30-day deadline. No purge reservation and no storage call may happen early.
const retentionPending = await finalizeGalleryWithdrawal(
    env,
    identity,
    editorial.draftId,
    { idempotencyKey: editorial.purgeKey }
);
assert.equal(retentionPending.ok, true, JSON.stringify(retentionPending));
assert.equal(retentionPending.status, 202);
assert.equal(retentionPending.code, 'retention-pending');
assert.equal(retentionPending.eligibleAt, editorialReceipt.retentionEligibleAt);
assert.equal(retentionPending.replayed, false);
assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM draft_withdrawal_finalization_operations
    WHERE draft_id = ? AND action = 'purge'
`).get(editorial.draftId).count, 0);
assert.equal(originals.calls.length, editorialReplayCalls);

// Athlete exclusion follows the distinct athlete-exclusion cleanup evidence
// branch, but retains the private original under the same SQL-owned 30-day
// rule. Its early purge approval must remain a zero-I/O safe stop.
seedCurrentHostProof(sqlite, athleteExclusion, epoch);
const athleteCallsBefore = originals.calls.length;
assert.deepEqual(await finalizeGalleryWithdrawal(
    env,
    identity,
    athleteExclusion.draftId,
    { idempotencyKey: athleteExclusion.withdrawalKey }
), { ok: true, status: 201, code: 'withdrawn', replayed: false });
assert.equal(originals.calls.length, athleteCallsBefore);
assert.equal(originals.has(athleteExclusion.objectKey), true);
assert.equal(readDraft(sqlite, athleteExclusion.draftId).state, 'withdrawn');
const athleteReceipt = readWithdrawalReceipt(sqlite, athleteExclusion);
assert.equal(
    Date.parse(athleteReceipt.retentionEligibleAt) -
        Date.parse(athleteReceipt.withdrawnAt),
    30 * 24 * 60 * 60 * 1000
);
assert.deepEqual(await finalizeGalleryWithdrawal(
    env,
    identity,
    athleteExclusion.draftId,
    { idempotencyKey: athleteExclusion.purgeKey }
), {
    ok: true,
    status: 202,
    code: 'retention-pending',
    eligibleAt: athleteReceipt.retentionEligibleAt,
    replayed: false
});
assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM draft_withdrawal_finalization_operations
    WHERE draft_id = ? AND action = 'purge'
`).get(athleteExclusion.draftId).count, 0);
assert.equal(originals.calls.length, athleteCallsBefore);

// Consent withdrawal is immediately destructive, but only after a durable D1
// reservation. A provider fault after that reservation must leave a resumable
// record and must not invent a deletion receipt.
seedCurrentHostProof(sqlite, consent, epoch);
originals.failNextGet = true;
const interrupted = await finalizeGalleryWithdrawal(
    env,
    identity,
    consent.draftId,
    { idempotencyKey: consent.withdrawalKey }
);
assert.deepEqual(interrupted, {
    ok: false,
    status: 503,
    code: 'finalization-unavailable'
});
assert.equal(originals.has(consent.objectKey), true);
assert.equal(sqlite.prepare(`
    SELECT status FROM draft_withdrawal_finalization_operations
    WHERE draft_id = ? AND action = 'withdrawal'
`).get(consent.draftId).status, 'reserved');
assert.equal(sqlite.prepare(`
    SELECT status FROM draft_private_original_deletions WHERE draft_id = ?
`).get(consent.draftId).status, 'reserved');
assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM gallery_private_original_deletion_tombstones
    WHERE draft_id_hash = ?
`).get(consent.draftIdHash).count, 0);

// R2 absence and pagination evidence are accepted only in their exact
// documented shapes. Undefined HEAD or malformed list pages must fail closed
// without deleting bytes or advancing the durable reservation.
originals.queueHeadResult(undefined);
assert.deepEqual(await finalizeGalleryWithdrawal(
    env,
    identity,
    consent.draftId,
    { idempotencyKey: consent.withdrawalKey }
), { ok: false, status: 409, code: 'conflict' });
assert.equal(originals.has(consent.objectKey), true);

const originalMetadata = originals.metadata(consent.objectKey);
for (const malformedList of [
    { objects: [originalMetadata], truncated: false },
    { objects: [originalMetadata], delimitedPrefixes: null, truncated: false },
    { objects: [originalMetadata], delimitedPrefixes: [], truncated: 'false' }
]) {
    originals.queueListResult(malformedList);
    assert.deepEqual(await finalizeGalleryWithdrawal(
        env,
        identity,
        consent.draftId,
        { idempotencyKey: consent.withdrawalKey }
    ), { ok: false, status: 503, code: 'finalization-unavailable' });
    assert.equal(originals.has(consent.objectKey), true);
    assert.equal(sqlite.prepare(`
        SELECT status FROM draft_private_original_deletions WHERE draft_id = ?
    `).get(consent.draftId).status, 'reserved');
}

// A valid truncated page must be followed to its exact cursor rather than
// treating the first page as complete.
const multiPageCallStart = originals.calls.length;
originals.queueListResult({
    objects: [originalMetadata],
    delimitedPrefixes: [],
    truncated: true,
    cursor: 'synthetic-page-2'
});
originals.queueListResult({
    objects: [],
    delimitedPrefixes: [],
    truncated: false
});

const resumed = await finalizeGalleryWithdrawal(
    env,
    identity,
    consent.draftId,
    { idempotencyKey: consent.withdrawalKey }
);
assert.equal(resumed.ok, true, JSON.stringify(resumed));
assert.equal(resumed.status, 201);
assert.equal(resumed.code, 'withdrawn');
assert.equal(resumed.replayed, false);
assert.ok(originals.calls.slice(multiPageCallStart).some(call =>
    call.operation === 'list' && call.cursor === 'synthetic-page-2'
));
assert.equal(originals.has(consent.objectKey), false);
assert.deepEqual(readUpload(sqlite, consent.uploadId), {
    status: 'deleted',
    objectDeletedAt: readDeletionTombstone(sqlite, consent).deletedAt
});
assert.deepEqual(readPublication(sqlite, consent.draftId), {
    hostDeletionConfirmed: 1,
    privateDeletionConfirmed: 1,
    withdrawalKind: 'consent-withdrawal'
});
const consentDraft = readDraft(sqlite, consent.draftId);
assert.equal(consentDraft.state, 'withdrawn');
assert.equal(consentDraft.stateVersion, 8);
assert.equal(consentDraft.activeConsentRevision, null);
assert.ok(sqlite.prepare(`
    SELECT withdrawn_at AS withdrawnAt
    FROM draft_consent_attestations
    WHERE draft_id = ? AND consent_revision = ?
`).get(consent.draftId, consent.consentRevision).withdrawnAt);
const consentReceipt = readWithdrawalReceipt(sqlite, consent);
assert.equal(consentReceipt.retentionEligibleAt, consentReceipt.withdrawnAt);
assert.equal(
    consentReceipt.privateDeletionReceiptHash,
    readDeletionTombstone(sqlite, consent).deletionReceiptHash
);

const consentReplayCalls = originals.calls.length;
assert.deepEqual(await finalizeGalleryWithdrawal(
    env,
    identity,
    consent.draftId,
    { idempotencyKey: consent.withdrawalKey }
), { ok: true, status: 200, code: 'withdrawn', replayed: true });
assert.equal(originals.calls.length, consentReplayCalls,
    'Permanent withdrawal replay must make zero private-storage calls.');

// The separate purge key consumes the already-proved deletion tombstone. It
// cannot touch R2 again, and the purge receipt plus its parent deletion commit
// as one SQLite transaction.
const purged = await finalizeGalleryWithdrawal(
    env,
    identity,
    consent.draftId,
    { idempotencyKey: consent.purgeKey }
);
assert.equal(purged.ok, true, JSON.stringify({
    purged,
    operation: sqlite.prepare(`
        SELECT action, expected_state_version AS expectedStateVersion,
            status, withdrawal_receipt_hash AS withdrawalReceiptHash
        FROM draft_withdrawal_finalization_operations
        WHERE draft_id = ? AND action = 'purge'
    `).get(consent.draftId) ?? null,
    draft: readDraft(sqlite, consent.draftId),
    publication: readPublication(sqlite, consent.draftId),
    withdrawal: readWithdrawalReceipt(sqlite, consent),
    databaseError: d1.lastError?.message ?? null
}));
assert.equal(purged.status, 201);
assert.equal(purged.code, 'purged');
assert.equal(purged.replayed, false);
assert.equal(originals.calls.length, consentReplayCalls);
assert.equal(readDraft(sqlite, consent.draftId), undefined);
assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count FROM gallery_draft_purge_receipts
    WHERE draft_id_hash = ?
`).get(consent.draftIdHash).count, 1);
assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count FROM gallery_withdrawal_completion_receipts
    WHERE draft_id_hash = ?
`).get(consent.draftIdHash).count, 1);
assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM gallery_private_original_deletion_tombstones
    WHERE draft_id_hash = ?
`).get(consent.draftIdHash).count, 1);
assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count FROM draft_private_original_deletions
    WHERE draft_id_hash = ?
`).get(consent.draftIdHash).count, 0);
assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count FROM gallery_retention_tombstones
    WHERE draft_id = ?
`).get(consent.draftId).count, 0,
'The atomic purge must remove the legacy raw-draft retention authorization.');

assert.deepEqual(await finalizeGalleryWithdrawal(
    env,
    identity,
    consent.draftId,
    { idempotencyKey: consent.purgeKey }
), { ok: true, status: 200, code: 'purged', replayed: true });
assert.equal(originals.calls.length, consentReplayCalls,
    'Permanent post-purge replay must make zero private-storage calls.');

// The finalizer and retention survivors for this consent fixture are hashes,
// counts, timestamps and classifications; its raw draft, upload, object-key,
// uploader, site, race and athlete identity may not survive parent purge. The
// separate migration-0012 athlete-exclusion request receipt intentionally keeps
// its original opaque affected-draft list for exact owner replay and is tested
// under that older contract elsewhere.
for (const table of [
    'gallery_withdrawal_completion_receipts',
    'gallery_private_original_deletion_tombstones',
    'gallery_draft_purge_receipts'
]) {
    const columns = sqlite.prepare(`PRAGMA table_info(${table})`)
        .all().map(column => column.name);
    for (const forbidden of [
        'draft_id', 'operation_id', 'upload_session_id', 'private_object_key',
        'provider_object_version', 'provider_etag', 'idempotency_key',
        'service_actor_identity', 'site_mode', 'race_date', 'athlete_id'
    ]) assert.equal(columns.includes(forbidden), false, `${table}.${forbidden}`);
    const serialized = JSON.stringify(sqlite.prepare(`SELECT * FROM ${table}`).all());
    for (const privateValue of [
        consent.draftId,
        consent.uploadId,
        consent.objectKey,
        identity.subject,
        'Synthetic race',
        'athlete-fixture'
    ]) assert.equal(serialized.includes(privateValue), false, `${table}: ${privateValue}`);
}

for (const table of sqlite.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
`).all().map(row => row.name)) {
    assert.match(table, /^[a-z0-9_]+$/);
    const serialized = JSON.stringify(sqlite.prepare(`SELECT * FROM ${table}`).all());
    assert.equal(
        serialized.includes(consent.draftId),
        false,
        `${table} retained the raw purged draft ID`
    );
}

assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
assert.equal(sqlite.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
sqlite.close();

console.log(
    'Gallery withdrawal finalizer service: finalizer-first host convergence, genuine-photo ' +
    'editorial/athlete retention, separate action keys, SQL-clock deadline, strict paginated ' +
    'R2 proof and retry, consent deletion, atomic purge, hash-only survivors, and zero-I/O ' +
    'replay passed.'
);

function seedReviewedPhoto(database, { ordinal, withdrawalKind }) {
    const digit = String(ordinal);
    const uuid = `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
    const objectUuid = `${digit.repeat(12)}4${digit.repeat(3)}8${digit.repeat(15)}`;
    const draftId = `draft_${uuid}`;
    const uploadId = `upload_${objectUuid}`;
    const processingRunId = `run_${objectUuid}`;
    const promotionId = `promotion_${objectUuid}`;
    const reviewId = `review_${hash(`review:${ordinal}`).slice(0, 32)}`;
    const consentRevision = `consent-finalizer-${ordinal}`;
    const itemRevision = `item-finalizer-${ordinal}`;
    const bundle = `bundle-finalizer-${ordinal}`;
    const source = `source-finalizer-${ordinal}`;
    const suppression = `suppression-finalizer-${ordinal}`;
    const createdAt = `2020-0${ordinal}-01T00:00:00.000Z`;
    const completedAt = `2020-0${ordinal}-01T00:01:00.000Z`;
    const terminalAt = `2020-0${ordinal}-01T00:10:00.000Z`;
    const promotionCleanupAt = `2020-0${ordinal}-01T00:11:00.000Z`;
    const processingCleanupAt = `2020-0${ordinal}-01T00:12:00.000Z`;
    const withdrawalPendingAt = `2020-0${ordinal}-01T00:13:00.000Z`;
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, ordinal, 1, 2, 3, 0xff, 0xd9]);
    const originalSha256 = hashBytes(bytes);
    const providerVersion = `original-version-${ordinal}`;
    const providerEtag = `original-etag-${ordinal}`;
    const objectKey = `private-originals/v1/family/2020/0${ordinal}/` +
        `${draftId}/${uploadId}/original.jpg`;
    const actorHash = hash(`fixture-actor:${ordinal}`);
    const draftIdHash = hash(`draft-id:${draftId}`);
    const cleanupReason = withdrawalKind === 'athlete-exclusion'
        ? 'athlete-exclusion'
        : 'withdrawal';

    database.prepare(`
        INSERT INTO gallery_drafts (
            draft_id, public_item_id, state, state_version, site_modes_json,
            export_bundle_id, source_revision, suppression_revision,
            item_revision, active_consent_revision, media_type, race_date,
            race_event, race_distance, athlete_ids_json, title, caption,
            alt_text, featured, original_object_key, original_detected_type,
            original_byte_count, original_sha256, upload_complete,
            verified_owner_identity_hash, created_at, updated_at
        ) VALUES (
            ?, ?, 'withdrawal-pending', 7, '["family"]', ?, ?, ?, ?, NULL,
            'photo', '2020-01-01', 'Synthetic race', '5 km',
            '["athlete-fixture"]', 'Synthetic finalizer fixture',
            'Synthetic data only.', 'Synthetic data only.', 0, ?, 'jpeg',
            ?, ?, 1, ?, ?, ?
        )
    `).run(
        draftId,
        `finalizer-fixture-${ordinal}`,
        bundle,
        source,
        suppression,
        itemRevision,
        objectKey,
        bytes.byteLength,
        originalSha256,
        actorHash,
        createdAt,
        withdrawalPendingAt
    );
    database.prepare(`
        INSERT INTO draft_consent_attestations (
            draft_id, consent_revision, public_use_confirmed, contains_minors,
            guardian_approval_confirmed, private_evidence_reference,
            verified_owner_identity_hash, attested_at, withdrawn_at
        ) VALUES (?, ?, 1, 0, 0, NULL, ?, ?, NULL)
    `).run(draftId, consentRevision, actorHash, createdAt);
    database.prepare(`
        UPDATE gallery_drafts SET active_consent_revision = ? WHERE draft_id = ?
    `).run(consentRevision, draftId);
    database.prepare(`
        INSERT INTO draft_upload_sessions (
            upload_session_id, draft_id, item_revision, consent_revision,
            export_bundle_id, source_revision, suppression_revision,
            provider_upload_id, object_key, file_extension,
            declared_content_type, declared_byte_count, part_size, part_count,
            next_part_number, uploaded_byte_count, detected_format, status,
            completed_object_version, completed_etag, completed_sha256,
            failure_code, synthetic_only_confirmed,
            verified_owner_identity_hash, initiation_idempotency_key,
            initiation_payload_fingerprint, completion_idempotency_key,
            completion_payload_fingerprint, completion_started_at, created_at,
            updated_at, expires_at, completed_at, object_deleted_at,
            declared_sha256, real_photo_intake_confirmed
        ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, 'jpg', 'image/jpeg', ?, 5242880, 1,
            2, ?, 'jpeg', 'complete', ?, ?, ?, NULL, 1, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, NULL, ?, 1
        )
    `).run(
        uploadId,
        draftId,
        itemRevision,
        consentRevision,
        bundle,
        source,
        suppression,
        `provider-upload-${ordinal}`,
        objectKey,
        bytes.byteLength,
        bytes.byteLength,
        providerVersion,
        providerEtag,
        originalSha256,
        actorHash,
        `upload-init-finalizer-${ordinal}`,
        hash(`upload-init-payload:${ordinal}`),
        `upload-complete-finalizer-${ordinal}`,
        hash(`upload-complete-payload:${ordinal}`),
        completedAt,
        createdAt,
        completedAt,
        `2020-0${ordinal}-02T00:00:00.000Z`,
        completedAt,
        originalSha256
    );

    database.prepare(`
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
            result_transition_key, result_toolchain_json, failure_code,
            created_at, updated_at, completed_at
        ) VALUES (
            ?, ?, 'family', 'photo', ?, ?, ?, ?, ?, ?, ?, 'jpeg',
            'image/jpeg', ?, ?, ?, ?, 3, 4, ?, ?, ?, 'staged', ?, ?, NULL,
            '{"sharp":"0.35.2","libvips":"8.18.3","webp":"1.6.0","png":"1.6.58","exiftool":"13.40","videoEnabled":false}',
            NULL, ?, ?, ?
        )
    `).run(
        processingRunId,
        draftId,
        itemRevision,
        consentRevision,
        bundle,
        source,
        suppression,
        uploadId,
        objectKey,
        bytes.byteLength,
        originalSha256,
        providerVersion,
        providerEtag,
        `processing-start-finalizer-${ordinal}`,
        hash(`processing-start-payload:${ordinal}`),
        actorHash,
        `processing-result-finalizer-${ordinal}`,
        hash(`processing-result-payload:${ordinal}`),
        createdAt,
        completedAt,
        completedAt
    );

    const candidatePayloadHash = hash(`candidate:${ordinal}`);
    const promotionIdempotencyKey = `promotion-finalizer-${ordinal}`;
    const promotionKeyHash = hash(`promotion-key:${ordinal}`);
    const promotionPayload = hash(`promotion-payload:${ordinal}`);
    database.prepare(`
        INSERT INTO draft_photo_promotions (
            promotion_id, processing_run_id, draft_id, site_mode,
            item_revision, consent_revision, export_bundle_id, source_revision,
            suppression_revision, expected_state_version, result_state_version,
            idempotency_key, idempotency_key_hash, payload_fingerprint,
            service_actor_identity_hash, status, candidate_payload_hash,
            created_at, updated_at, candidate_at
        ) VALUES (
            ?, ?, ?, 'family', ?, ?, ?, ?, ?, 5, 6, ?, ?, ?, ?,
            'candidate', ?, ?, ?, ?
        )
    `).run(
        promotionId,
        processingRunId,
        draftId,
        itemRevision,
        consentRevision,
        bundle,
        source,
        suppression,
        promotionIdempotencyKey,
        promotionKeyHash,
        promotionPayload,
        actorHash,
        candidatePayloadHash,
        completedAt,
        completedAt,
        completedAt
    );

    const generationFingerprint = hash(`generation:${ordinal}`);
    const targetSetHash = hash(`target-set:${ordinal}`);
    const promotionIdHash = hash(`promotion:${promotionId}`);
    database.prepare(`
        INSERT INTO draft_photo_public_generations (
            promotion_id, promotion_id_hash, draft_id, draft_id_hash,
            approved_origin, approved_origin_hash, candidate_state_version,
            generation_fingerprint, target_set_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 6, ?, ?, ?)
    `).run(
        promotionId,
        promotionIdHash,
        draftId,
        draftIdHash,
        APPROVED_ORIGIN,
        epoch.approvedOriginHash,
        generationFingerprint,
        targetSetHash,
        completedAt
    );
    const targets = [];
    for (const [role, fileName] of [
        ['photo-display', 'display.webp'],
        ['photo-thumbnail', 'thumbnail.webp']
    ]) {
        const expectedSha256 = hash(`public-bytes:${ordinal}:${role}`);
        const approvedObjectKey = `media/v1/${expectedSha256}/${fileName}`;
        const target = {
            role,
            approvedObjectKey,
            keyHash: hash(`approved-key:${approvedObjectKey}`),
            publicUrlHash: hash(`public-url:${APPROVED_ORIGIN}/${approvedObjectKey}`),
            expectedSha256
        };
        targets.push(target);
        database.prepare(`
            INSERT INTO draft_photo_public_generation_targets (
                promotion_id, role, approved_object_key,
                approved_object_key_hash, public_url_hash, expected_sha256,
                generation_target_set_hash, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            promotionId,
            role,
            approvedObjectKey,
            target.keyHash,
            target.publicUrlHash,
            expectedSha256,
            targetSetHash,
            completedAt
        );
    }

    database.prepare(`
        INSERT INTO draft_photo_review_receipts (
            review_id, draft_id, promotion_id, processing_run_id,
            candidate_state_version, candidate_payload_hash,
            generation_fingerprint, repository, base_ref, base_sha, branch_ref,
            target_relative_path, item_id, manifest_sha256,
            operation_marker_hash, workflow_run_reference, status,
            reservation_idempotency_key, reservation_idempotency_key_hash,
            reservation_payload_fingerprint, service_actor_identity_hash,
            terminal_kind, terminal_evidence_hash, terminal_idempotency_key,
            terminal_idempotency_key_hash, terminal_payload_fingerprint,
            created_at, updated_at, terminal_at
        ) VALUES (
            ?, ?, ?, ?, 6, ?, ?, 'johnkevan88888/family-running', 'main', ?, ?,
            'gallery-data/family.json', ?, ?, ?, ?, 'terminal', ?, ?, ?, ?,
            'no-pr-created', ?, ?, ?, ?, ?, ?, ?
        )
    `).run(
        reviewId,
        draftId,
        promotionId,
        processingRunId,
        candidatePayloadHash,
        generationFingerprint,
        digit.repeat(40),
        `gallery-media/candidate-${hash(`branch:${ordinal}`).slice(0, 32)}`,
        `finalizer-fixture-${ordinal}`,
        `sha256:${hash(`manifest:${ordinal}`)}`,
        hash(`operation-marker:${ordinal}`),
        `workflow-run-finalizer-${ordinal}`,
        `review-reserve-finalizer-${ordinal}`,
        hash(`review-reserve-key:${ordinal}`),
        hash(`review-reserve-payload:${ordinal}`),
        actorHash,
        hash(`review-terminal-evidence:${ordinal}`),
        `review-terminal-finalizer-${ordinal}`,
        hash(`review-terminal-key:${ordinal}`),
        hash(`review-terminal-payload:${ordinal}`),
        createdAt,
        terminalAt,
        terminalAt
    );

    const promotionCleanup = {
        cleanupId: `pcleanup_${uuidHex(`promotion-cleanup:${ordinal}`)}`,
        promotionIdHash,
        processingRunIdHash: hash(`run:${processingRunId}`),
        draftIdHash,
        sourceKeyHash: promotionKeyHash,
        sourcePayload: promotionPayload,
        cleanupKeyHash: hash(`promotion-cleanup-key:${ordinal}`),
        cleanupPayload: hash(`promotion-cleanup-payload:${ordinal}`),
        evidenceHash: hash(`promotion-cleanup-evidence:${ordinal}`)
    };
    promotionCleanup.cleanupIdHash = hash(`cleanup-id:${promotionCleanup.cleanupId}`);
    database.prepare(`
        INSERT INTO draft_photo_promotion_cleanups (
            cleanup_id, cleanup_id_hash, promotion_id, promotion_id_hash,
            processing_run_id, processing_run_id_hash, draft_id, draft_id_hash,
            cleanup_reason, withdrawal_kind, source_promotion_status,
            source_promotion_idempotency_key,
            source_promotion_idempotency_key_hash,
            source_promotion_payload_fingerprint, expected_state_version,
            object_count, idempotency_key, cleanup_idempotency_key_hash,
            payload_fingerprint, service_actor_identity_hash, status,
            cleanup_evidence_hash, created_at, updated_at, completed_at
        ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?,
            7, 2, ?, ?, ?, ?, 'cleaned', ?, ?, ?, ?
        )
    `).run(
        promotionCleanup.cleanupId,
        promotionCleanup.cleanupIdHash,
        promotionId,
        promotionCleanup.promotionIdHash,
        processingRunId,
        promotionCleanup.processingRunIdHash,
        draftId,
        promotionCleanup.draftIdHash,
        cleanupReason,
        withdrawalKind,
        promotionIdempotencyKey,
        promotionCleanup.sourceKeyHash,
        promotionCleanup.sourcePayload,
        `promotion-cleanup-finalizer-${ordinal}`,
        promotionCleanup.cleanupKeyHash,
        promotionCleanup.cleanupPayload,
        actorHash,
        promotionCleanup.evidenceHash,
        promotionCleanupAt,
        promotionCleanupAt,
        promotionCleanupAt
    );
    database.prepare(`
        INSERT INTO gallery_photo_promotion_cleanup_tombstones (
            cleanup_id_hash, promotion_id_hash, processing_run_id_hash,
            draft_id_hash, source_promotion_idempotency_key_hash,
            source_promotion_payload_fingerprint,
            cleanup_idempotency_key_hash, cleanup_payload_fingerprint,
            cleanup_reason, withdrawal_kind, evidence_hash, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        promotionCleanup.cleanupIdHash,
        promotionCleanup.promotionIdHash,
        promotionCleanup.processingRunIdHash,
        promotionCleanup.draftIdHash,
        promotionCleanup.sourceKeyHash,
        promotionCleanup.sourcePayload,
        promotionCleanup.cleanupKeyHash,
        promotionCleanup.cleanupPayload,
        cleanupReason,
        withdrawalKind,
        promotionCleanup.evidenceHash,
        promotionCleanupAt
    );

    const processingCleanup = {
        cleanupId: `cleanup_${uuidHex(`processing-cleanup:${ordinal}`)}`,
        processingRunIdHash: hash(`run:${processingRunId}`),
        draftIdHash,
        evidenceHash: hash(`processing-cleanup-evidence:${ordinal}`)
    };
    processingCleanup.cleanupIdHash = hash(`cleanup-id:${processingCleanup.cleanupId}`);
    database.prepare(`
        INSERT INTO draft_processing_cleanups (
            cleanup_id, cleanup_id_hash, processing_run_id,
            processing_run_id_hash, draft_id, draft_id_hash, cleanup_reason,
            expected_state_version, output_count, idempotency_key,
            payload_fingerprint, service_actor_identity_hash, status,
            cleanup_evidence_hash, created_at, updated_at, completed_at
        ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, 7, 2, ?, ?, ?, 'cleaned', ?, ?, ?, ?
        )
    `).run(
        processingCleanup.cleanupId,
        processingCleanup.cleanupIdHash,
        processingRunId,
        processingCleanup.processingRunIdHash,
        draftId,
        processingCleanup.draftIdHash,
        cleanupReason,
        `processing-cleanup-finalizer-${ordinal}`,
        hash(`processing-cleanup-payload:${ordinal}`),
        actorHash,
        processingCleanup.evidenceHash,
        processingCleanupAt,
        processingCleanupAt,
        processingCleanupAt
    );
    database.prepare(`
        INSERT INTO gallery_processing_cleanup_tombstones (
            cleanup_id_hash, draft_id_hash, processing_run_id_hash,
            cleanup_reason, evidence_hash, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
        processingCleanup.cleanupIdHash,
        processingCleanup.draftIdHash,
        processingCleanup.processingRunIdHash,
        cleanupReason,
        processingCleanup.evidenceHash,
        processingCleanupAt
    );

    database.prepare(`
        INSERT INTO draft_publication_references (
            draft_id, host_deletion_confirmed,
            private_original_deletion_confirmed, withdrawal_kind, updated_at
        ) VALUES (?, 0, 0, ?, ?)
    `).run(draftId, withdrawalKind, withdrawalPendingAt);
    database.prepare(`
        INSERT INTO draft_transition_receipts (
            draft_id, idempotency_key, payload_fingerprint, from_state,
            to_state, expected_state_version, result_state_version, created_at
        ) VALUES (?, ?, ?, 'candidate-public', 'withdrawal-pending', 6, 7, ?)
    `).run(
        draftId,
        `candidate-withdrawal-${ordinal}`,
        hash(`candidate-withdrawal-payload:${ordinal}`),
        withdrawalPendingAt
    );

    // A completed approved-media cleanup removes the operational promotion;
    // the public generation, review receipt, cleanup row and hash-only
    // tombstone deliberately retain the exact historical lineage.
    database.prepare(
        'DELETE FROM draft_photo_promotions WHERE promotion_id = ?'
    ).run(promotionId);

    return {
        draftId,
        draftIdHash,
        uploadId,
        processingRunId,
        promotionId,
        promotionIdHash,
        consentRevision,
        objectKey,
        bytes,
        originalSha256,
        providerVersion,
        providerEtag,
        withdrawalKind,
        targets,
        promotionCleanup,
        processingCleanup,
        withdrawalCycleHash: hash(`withdrawal-cycle:${ordinal}`),
        withdrawalKey: actionKey('withdrawal', draftId),
        purgeKey: actionKey('purge', draftId)
    };
}

function seedDeliveryEpoch(database) {
    const epochId = 'media_delivery_epoch_finalizer_0001';
    const epochIdHash = hash(`epoch:${epochId}`);
    const approvedOriginHash = hash(`approved-origin:${APPROVED_ORIGIN}`);
    const deliveryContractHash = hash('delivery-contract:finalizer');
    const deliveryVersionHash = hash('delivery-version:finalizer');
    const activationReceiptHash = hash('activation-receipt:finalizer');
    const timestamp = '2020-01-01T00:00:00.000Z';
    database.prepare(`
        INSERT INTO gallery_media_delivery_epochs (
            epoch_id, epoch_id_hash, epoch_sequence, approved_origin,
            approved_origin_hash, delivery_contract_hash,
            delivery_version_hash, witness_object_key_hash, witness_sha256,
            witness_byte_count, witness_content_type, configuration_hash,
            registered_by_identity_hash, registered_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 4, 'image/webp', ?, ?, ?)
    `).run(
        epochId,
        epochIdHash,
        APPROVED_ORIGIN,
        approvedOriginHash,
        deliveryContractHash,
        deliveryVersionHash,
        hash('witness-key:finalizer'),
        hash('witness-bytes:finalizer'),
        hash('delivery-config:finalizer'),
        hash('epoch-actor:finalizer'),
        timestamp
    );
    database.prepare(`
        INSERT INTO gallery_media_delivery_epoch_activations (
            activation_receipt_hash, epoch_id_hash, epoch_sequence,
            previous_epoch_id_hash, activation_idempotency_key_hash,
            activation_payload_hash, service_actor_identity_hash, activated_at
        ) VALUES (?, ?, 1, NULL, ?, ?, ?, ?)
    `).run(
        activationReceiptHash,
        epochIdHash,
        hash('activation-idempotency:finalizer'),
        hash('activation-payload:finalizer'),
        hash('activation-actor:finalizer'),
        timestamp
    );
    database.prepare(`
        INSERT INTO gallery_media_delivery_current_epoch (
            singleton_id, epoch_id_hash, epoch_sequence,
            activation_receipt_hash, activated_at
        ) VALUES (1, ?, 1, ?, ?)
    `).run(epochIdHash, activationReceiptHash, timestamp);
    return {
        epochIdHash,
        approvedOriginHash,
        deliveryContractHash,
        deliveryVersionHash,
        witnessKeyHash: hash('witness-key:finalizer'),
        witnessSha256: hash('witness-bytes:finalizer')
    };
}

function seedCurrentHostProof(database, fixture, epochValue) {
    const suffix = fixture.draftId.slice(6, 14);
    const verificationId = `hostverify_${hash(`host-verification:${suffix}`).slice(0, 32)}`;
    const verificationIdHash = hash(`verification:${verificationId}`);
    const promotionSetHash = hash(`promotion-set:${suffix}`);
    const cleanupEvidenceSetHash = hash(`cleanup-set:${suffix}`);
    const targetSetHash = hash(`host-target-set:${suffix}`);
    const idempotencyKey = `host-proof-finalizer-${suffix}`;
    const idempotencyKeyHash = hash(`host-idempotency:${suffix}`);
    const payloadFingerprint = hash(`host-payload:${suffix}`);
    const actorHash = hash(`host-actor:${suffix}`);
    const finalReceiptHash = hash(`host-final-receipt:${suffix}`);
    const createdAt = '2020-06-01T00:00:00.000Z';
    const proofAt = '2020-06-01T00:01:00.000Z';
    const receiptAt = '2020-06-01T00:02:00.000Z';

    database.prepare(`
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
            ?, ?, ?, ?, 7, 'withdrawal', NULL, ?, ?, ?, ?, ?, ?, 1, 2, 2,
            ?, ?, ?, ?, ?, ?, ?, ?
        )
    `).run(
        verificationId,
        verificationIdHash,
        fixture.draftId,
        fixture.draftIdHash,
        fixture.withdrawalKind,
        fixture.withdrawalCycleHash,
        promotionSetHash,
        cleanupEvidenceSetHash,
        epochValue.approvedOriginHash,
        targetSetHash,
        epochValue.epochIdHash,
        epochValue.deliveryContractHash,
        epochValue.deliveryVersionHash,
        idempotencyKey,
        idempotencyKeyHash,
        payloadFingerprint,
        actorHash,
        createdAt
    );
    for (const target of fixture.targets) {
        database.prepare(`
            INSERT INTO gallery_approved_media_key_retirement_reservations (
                approved_object_key_hash, verification_id_hash,
                promotion_id_hash, draft_id_hash, withdrawal_cycle_hash,
                reservation_idempotency_key_hash,
                reserved_by_identity_hash, reserved_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            target.keyHash,
            verificationIdHash,
            fixture.promotionIdHash,
            fixture.draftIdHash,
            fixture.withdrawalCycleHash,
            idempotencyKeyHash,
            actorHash,
            proofAt
        );
    }
    database.prepare(`
        INSERT INTO draft_public_host_absence_witness_proofs (
            verification_id, witness_object_key_hash, witness_sha256,
            witness_byte_count, witness_content_type,
            before_head_evidence_hash, before_get_evidence_hash,
            after_head_evidence_hash, after_get_evidence_hash,
            observed_contract_hash, observed_version_hash, verified_at
        ) VALUES (?, ?, ?, 4, 'image/webp', ?, ?, ?, ?, ?, ?, ?)
    `).run(
        verificationId,
        epochValue.witnessKeyHash,
        epochValue.witnessSha256,
        hash(`witness-before-head:${suffix}`),
        hash(`witness-before-get:${suffix}`),
        hash(`witness-after-head:${suffix}`),
        hash(`witness-after-get:${suffix}`),
        epochValue.deliveryContractHash,
        epochValue.deliveryVersionHash,
        proofAt
    );
    for (const target of fixture.targets) {
        database.prepare(`
            INSERT INTO draft_public_host_absence_target_proofs (
                verification_id, approved_object_key_hash, role,
                public_url_hash, expected_sha256, head_evidence_hash,
                get_evidence_hash, final_head_evidence_hash,
                observed_contract_hash, observed_version_hash, verified_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            verificationId,
            target.keyHash,
            target.role,
            target.publicUrlHash,
            target.expectedSha256,
            hash(`target-head:${suffix}:${target.role}`),
            hash(`target-get:${suffix}:${target.role}`),
            hash(`target-final-head:${suffix}:${target.role}`),
            epochValue.deliveryContractHash,
            epochValue.deliveryVersionHash,
            proofAt
        );
    }
    database.prepare(`
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
            ?, ?, ?, ?, ?, ?, ?, ?, 1, 2, 7, 'withdrawal', NULL, ?, ?, ?, ?, ?, ?
        )
    `).run(
        finalReceiptHash,
        verificationIdHash,
        fixture.draftIdHash,
        promotionSetHash,
        cleanupEvidenceSetHash,
        fixture.withdrawalCycleHash,
        epochValue.approvedOriginHash,
        targetSetHash,
        epochValue.epochIdHash,
        epochValue.deliveryContractHash,
        epochValue.deliveryVersionHash,
        idempotencyKeyHash,
        payloadFingerprint,
        receiptAt
    );
    database.prepare(`
        UPDATE draft_publication_references
        SET host_deletion_confirmed = 1, updated_at = ?
        WHERE draft_id = ? AND host_deletion_confirmed = 0
    `).run(receiptAt, fixture.draftId);
    assert.equal(database.prepare(`
        SELECT COUNT(*) AS count
        FROM gallery_current_public_host_absence_receipts
        WHERE draft_id = ? AND final_receipt_hash = ?
    `).get(fixture.draftId, finalReceiptHash).count, 1);
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
        async first(columnName) {
            const row = database.prepare(this.sql).get(...this.bindings) ?? null;
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
        lastError: null,
        prepare(sql) {
            return new Statement(sql);
        },
        async batch(statements) {
            api.lastError = null;
            database.exec('BEGIN IMMEDIATE');
            try {
                const results = statements.map(statement =>
                    statement.runSynchronously()
                );
                database.exec('COMMIT');
                return results;
            } catch (error) {
                if (database.isTransaction) database.exec('ROLLBACK');
                api.lastError = error;
                throw error;
            }
        }
    };
    return api;
}

function createPrivateOriginalsBucket() {
    const objects = new Map();
    const queuedHeadResults = [];
    const queuedListResults = [];
    const bucket = {
        calls: [],
        failNextGet: false,
        seed(key, bytes, { version, etag }) {
            objects.set(key, {
                key,
                bytes: Uint8Array.from(bytes),
                version,
                etag
            });
        },
        has(key) {
            return objects.has(key);
        },
        metadata(key) {
            const object = objects.get(key);
            return object ? objectMetadata(object) : null;
        },
        queueHeadResult(value) {
            queuedHeadResults.push(value);
        },
        queueListResult(value) {
            queuedListResults.push(value);
        },
        async head(key) {
            bucket.calls.push({ operation: 'head', key });
            if (queuedHeadResults.length > 0) return queuedHeadResults.shift();
            const object = objects.get(key);
            return object ? objectMetadata(object) : null;
        },
        async get(key, options = {}) {
            bucket.calls.push({ operation: 'get', key });
            if (bucket.failNextGet) {
                bucket.failNextGet = false;
                throw new Error('synthetic-r2-get-interruption');
            }
            const object = objects.get(key);
            if (!object) return null;
            if (
                options.onlyIf?.etagMatches !== undefined &&
                options.onlyIf.etagMatches !== object.etag
            ) return objectMetadata(object);
            return { ...objectMetadata(object), body: object.bytes.slice() };
        },
        async delete(key) {
            bucket.calls.push({ operation: 'delete', key });
            objects.delete(key);
        },
        async list({ prefix = '', cursor } = {}) {
            bucket.calls.push({ operation: 'list', prefix, cursor: cursor ?? null });
            if (queuedListResults.length > 0) return queuedListResults.shift();
            assert.equal(cursor, undefined);
            return {
                objects: [...objects.values()]
                    .filter(object => object.key.startsWith(prefix))
                    .map(objectMetadata),
                delimitedPrefixes: [],
                truncated: false
            };
        }
    };
    return bucket;
}

function objectMetadata(object) {
    return {
        key: object.key,
        size: object.bytes.byteLength,
        version: object.version,
        etag: object.etag
    };
}

function suspendAllTriggers(database) {
    const triggers = database.prepare(`
        SELECT name, sql FROM sqlite_schema
        WHERE type = 'trigger' AND sql IS NOT NULL
        ORDER BY name
    `).all();
    for (const trigger of triggers) {
        database.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
    }
    return triggers;
}

function restoreTriggers(database, triggers) {
    for (const trigger of triggers) database.exec(trigger.sql);
}

function readDraft(database, draftId) {
    const row = database.prepare(`
        SELECT state, state_version AS stateVersion,
            active_consent_revision AS activeConsentRevision,
            updated_at AS updatedAt
        FROM gallery_drafts WHERE draft_id = ?
    `).get(draftId);
    return row ? { ...row } : undefined;
}

function readUpload(database, uploadId) {
    const row = database.prepare(`
        SELECT status, object_deleted_at AS objectDeletedAt
        FROM draft_upload_sessions WHERE upload_session_id = ?
    `).get(uploadId);
    return row ? { ...row } : undefined;
}

function readPublication(database, draftId) {
    const row = database.prepare(`
        SELECT host_deletion_confirmed AS hostDeletionConfirmed,
            private_original_deletion_confirmed AS privateDeletionConfirmed,
            withdrawal_kind AS withdrawalKind
        FROM draft_publication_references WHERE draft_id = ?
    `).get(draftId);
    return row ? { ...row } : undefined;
}

function readWithdrawalReceipt(database, fixture) {
    return database.prepare(`
        SELECT withdrawn_at AS withdrawnAt,
            retention_eligible_at AS retentionEligibleAt,
            generation_count AS generationCount, target_count AS targetCount,
            private_deletion_receipt_hash AS privateDeletionReceiptHash
        FROM gallery_withdrawal_completion_receipts
        WHERE draft_id_hash = ?
    `).get(fixture.draftIdHash);
}

function readDeletionTombstone(database, fixture) {
    return database.prepare(`
        SELECT deletion_receipt_hash AS deletionReceiptHash,
            deleted_at AS deletedAt
        FROM gallery_private_original_deletion_tombstones
        WHERE draft_id_hash = ?
    `).get(fixture.draftIdHash);
}

function count(database, table) {
    return database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

function actionKey(action, draftId) {
    return `gallery-${action}-${hash(`gallery-${action}:${draftId}`).slice(0, 32)}`;
}

function uuidHex(seed) {
    const characters = hash(seed).slice(0, 32).split('');
    characters[12] = '4';
    characters[16] = '8';
    return characters.join('');
}

function hash(value) {
    return createHash('sha256').update(value).digest('hex');
}

function hashBytes(value) {
    return createHash('sha256').update(value).digest('hex');
}
