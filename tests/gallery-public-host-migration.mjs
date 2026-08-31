import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const migrationUrls = [
    '../gallery-admin/migrations/0001_private_gallery.sql',
    '../gallery-admin/migrations/0002_private_uploads.sql',
    '../gallery-admin/migrations/0003_private_original_v1_keys.sql',
    '../gallery-admin/migrations/0004_private_processing_staging.sql',
    '../gallery-admin/migrations/0005_private_processing_cleanup.sql',
    '../gallery-admin/migrations/0006_transition_receipt_state_version.sql',
    '../gallery-admin/migrations/0007_photo_promotion.sql',
    '../gallery-admin/migrations/0008_photo_promotion_cleanup.sql',
    '../gallery-admin/migrations/0009_public_host_verification.sql'
];
const migrations = await Promise.all(migrationUrls.map(async relativeUrl =>
    readFile(new URL(relativeUrl, import.meta.url), 'utf8')
));

const database = new DatabaseSync(':memory:');
for (const migration of migrations) {
    database.exec(migration);
}

assert.equal(database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
for (const table of [
    'gallery_media_delivery_epochs',
    'gallery_media_delivery_epoch_activations',
    'gallery_media_delivery_current_epoch',
    'draft_photo_public_generations',
    'draft_photo_public_generation_targets',
    'draft_public_host_absence_verifications',
    'gallery_approved_media_key_retirement_reservations',
    'draft_public_host_absence_target_proofs',
    'draft_public_host_absence_witness_proofs',
    'gallery_public_host_absence_receipts'
]) {
    assert.equal(database.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = ?"
    ).get(table).count, 1, table);
}
assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_schema " +
    "WHERE type = 'view' AND name = 'gallery_current_public_host_absence_receipts'"
).get().count, 1);

// This isolated fixture seeds only pre-0009 parent rows.  Those earlier state
// machines are already covered by their dedicated tests; dropping their insert
// guards here keeps this test focused on the new database boundary.
for (const trigger of [
    'gallery_drafts_state_version_guard',
    'gallery_drafts_transition_guard',
    'gallery_drafts_consent_state_gate_guard',
    'draft_photo_promotions_insert_guard',
    'draft_photo_promotion_objects_insert_guard',
    'gallery_photo_promotion_cleanup_tombstones_insert_guard',
    'draft_photo_promotion_objects_no_delete_guard',
    'draft_photo_promotions_no_delete_guard'
]) {
    database.exec(`DROP TRIGGER ${trigger}`);
}

const origin = 'https://media.synthetic.example';
const originHash = hash(`approved-origin:${origin}`);
const emptyHash = hash('');
const actorHash = hash('service-actor');
const timestamp1 = '2026-08-30T12:00:00.000Z';
const timestamp2 = '2026-08-30T12:10:00.000Z';
const receipt1At = '2026-08-30T12:11:00.000Z';
const epoch1 = insertEpoch({
    sequence: 1,
    suffix: 'one',
    origin,
    originHash,
    timestamp: timestamp1
});

assert.throws(
    () => database.prepare(
        'UPDATE gallery_media_delivery_current_epoch ' +
        'SET epoch_sequence = 2, epoch_id_hash = ?, activation_receipt_hash = ?, ' +
        'activated_at = ? WHERE singleton_id = 1'
    ).run(hash('unregistered-epoch'), hash('unregistered-activation'), timestamp2),
    /exact activation evidence/i
);
assert.throws(
    () => database.exec('DELETE FROM gallery_media_delivery_current_epoch'),
    /deletion is forbidden/i
);
assert.throws(
    () => database.exec(
        'INSERT OR REPLACE INTO gallery_media_delivery_current_epoch ' +
        'SELECT * FROM gallery_media_delivery_current_epoch'
    ),
    /replacement is forbidden/i
);

const primaryDraftId = 'draft_public_host_primary_0001';
const primaryDraftHash = hash(`draft:${primaryDraftId}`);
insertDraft(primaryDraftId, 'primary-public-item');
setDraftState(primaryDraftId, 'processing', 5);

const promotionId = 'promotion_11111111111141118111111111111111';
const promotionHash = hash(`promotion:${promotionId}`);
const displaySha = hash('display-bytes');
const thumbnailSha = hash('thumbnail-bytes');
const displayKey = `media/v1/${displaySha}/display.webp`;
const thumbnailKey = `media/v1/${thumbnailSha}/thumbnail.webp`;
const displayKeyHash = hash(`approved-key:${displayKey}`);
const thumbnailKeyHash = hash(`approved-key:${thumbnailKey}`);
const displayUrlHash = hash(`public-url:${origin}/${displayKey}`);
const thumbnailUrlHash = hash(`public-url:${origin}/${thumbnailKey}`);
const generationTargetSetHash = hash('primary-generation-target-set');

insertPromotionFixture({
    draftId: primaryDraftId,
    promotionId,
    expectedStateVersion: 5,
    displayKey,
    displaySha,
    thumbnailKey,
    thumbnailSha,
    timestamp: timestamp1
});
database.prepare(`
    INSERT INTO draft_photo_public_generations (
        promotion_id, promotion_id_hash, draft_id, draft_id_hash,
        approved_origin, approved_origin_hash, candidate_state_version,
        generation_fingerprint, target_set_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
    promotionId,
    promotionHash,
    primaryDraftId,
    primaryDraftHash,
    origin,
    originHash,
    6,
    hash('primary-generation'),
    generationTargetSetHash,
    timestamp1
);
insertGenerationTarget({
    promotionId,
    role: 'photo-display',
    key: displayKey,
    keyHash: displayKeyHash,
    urlHash: displayUrlHash,
    sha256: displaySha,
    targetSetHash: generationTargetSetHash,
    timestamp: timestamp1
});

assert.throws(
    () => database.prepare(
        'UPDATE draft_photo_public_generations SET target_set_hash = ? WHERE promotion_id = ?'
    ).run(hash('mutated-target-set'), promotionId),
    /public generations are immutable/i
);
assert.throws(
    () => database.prepare(
        'DELETE FROM draft_photo_public_generations WHERE promotion_id = ?'
    ).run(promotionId),
    /approved draft purge only/i
);
assert.throws(
    () => database.prepare(`
        INSERT OR REPLACE INTO draft_photo_public_generations
        SELECT * FROM draft_photo_public_generations WHERE promotion_id = ?
    `).run(promotionId),
    /replacement is forbidden/i
);

const withdrawalCycleHash = hash('primary-withdrawal-cycle');
setDraftState(primaryDraftId, 'withdrawal-pending', 6);
database.prepare(`
    INSERT INTO draft_publication_references (
        draft_id, host_deletion_confirmed, private_original_deletion_confirmed,
        withdrawal_kind, updated_at
    ) VALUES (?, 0, 1, 'editorial-removal', ?)
`).run(primaryDraftId, timestamp1);
insertCleanupTombstone({
    promotionHash,
    draftHash: primaryDraftHash,
    suffix: 'primary',
    timestamp: timestamp1
});

const attempt1 = verificationFixture({
    suffix: 'one',
    draftId: primaryDraftId,
    draftHash: primaryDraftHash,
    expectedStateVersion: 6,
    withdrawalCycleHash,
    epoch: epoch1,
    generationCount: 1,
    generationTargetRowCount: 2,
    targetCount: 2,
    createdAt: '2026-08-30T12:05:00.000Z'
});
assert.throws(
    () => insertVerification(attempt1),
    /complete generation set/i,
    'One target role must never be treated as a complete generation.'
);

insertGenerationTarget({
    promotionId,
    role: 'photo-thumbnail',
    key: thumbnailKey,
    keyHash: thumbnailKeyHash,
    urlHash: thumbnailUrlHash,
    sha256: thumbnailSha,
    targetSetHash: generationTargetSetHash,
    timestamp: timestamp2
});
const staleChronologyAttempt = verificationFixture({
    suffix: 'stale-chronology',
    draftId: primaryDraftId,
    draftHash: primaryDraftHash,
    expectedStateVersion: 6,
    withdrawalCycleHash,
    epoch: epoch1,
    generationCount: 1,
    generationTargetRowCount: 2,
    targetCount: 2,
    createdAt: timestamp1
});
assert.throws(
    () => insertVerification(staleChronologyAttempt),
    /complete generation set/i,
    'Verification must start strictly after every covered cleanup completed.'
);

// This repository has no multi-owner URL model.  Even before terminal key
// retirement, a second historical generation cannot claim a key or URL that
// already belongs to the first generation.
database.prepare('DELETE FROM draft_photo_promotion_objects WHERE promotion_id = ?')
    .run(promotionId);
database.prepare('DELETE FROM draft_photo_promotions WHERE promotion_id = ?')
    .run(promotionId);
const resurrectionDraftId = 'draft_public_host_resurrection_0002';
insertDraft(resurrectionDraftId, 'resurrection-public-item');
setDraftState(resurrectionDraftId, 'processing', 9);
const resurrectionPromotionId = 'promotion_22222222222242229222222222222222';
insertPromotionFixture({
    draftId: resurrectionDraftId,
    promotionId: resurrectionPromotionId,
    expectedStateVersion: 9,
    displayKey,
    displaySha,
    thumbnailKey: `media/v1/${hash('other-thumbnail')}/thumbnail.webp`,
    thumbnailSha: hash('other-thumbnail'),
    timestamp: timestamp2
});
database.prepare(`
    INSERT INTO draft_photo_public_generations (
        promotion_id, promotion_id_hash, draft_id, draft_id_hash,
        approved_origin, approved_origin_hash, candidate_state_version,
        generation_fingerprint, target_set_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
    resurrectionPromotionId,
    hash(`promotion:${resurrectionPromotionId}`),
    resurrectionDraftId,
    hash(`draft:${resurrectionDraftId}`),
    origin,
    originHash,
    10,
    hash('resurrection-generation'),
    hash('resurrection-target-set'),
    timestamp2
);
const insertResurrectionDisplayTarget = () => insertGenerationTarget({
    promotionId: resurrectionPromotionId,
    role: 'photo-display',
    key: displayKey,
    keyHash: displayKeyHash,
    urlHash: displayUrlHash,
    sha256: displaySha,
    targetSetHash: hash('resurrection-target-set'),
    timestamp: timestamp2
});
assert.throws(
    insertResurrectionDisplayTarget,
    /replacement is forbidden|UNIQUE constraint failed/i,
    'A duplicate historical key cannot acquire a second live owner.'
);
insertVerification(attempt1);
assert.throws(
    () => database.prepare(`
        UPDATE draft_public_host_absence_verifications
        SET withdrawal_cycle_hash = ? WHERE verification_id = ?
    `).run(hash('mutated-verification-cycle'), attempt1.verificationId),
    /verifications are immutable/i
);
assert.throws(
    () => database.prepare(
        'DELETE FROM draft_public_host_absence_verifications WHERE verification_id = ?'
    ).run(attempt1.verificationId),
    /approved draft purge only/i
);
assert.throws(
    () => database.prepare(`
        INSERT OR REPLACE INTO draft_public_host_absence_verifications
        SELECT * FROM draft_public_host_absence_verifications
        WHERE verification_id = ?
    `).run(attempt1.verificationId),
    /replacement is forbidden/i
);

assert.throws(
    () => database.prepare(
        'UPDATE draft_publication_references SET host_deletion_confirmed = 1 WHERE draft_id = ?'
    ).run(primaryDraftId),
    /current complete receipt/i,
    'The compatibility scalar cannot be set before the immutable receipt.'
);

reserveKey(attempt1, promotionHash, displayKeyHash, timestamp2);
reserveKey(attempt1, promotionHash, thumbnailKeyHash, timestamp2);
assert.throws(
    () => database.prepare(
        'UPDATE gallery_approved_media_key_retirement_reservations ' +
        'SET withdrawal_cycle_hash = ? WHERE approved_object_key_hash = ?'
    ).run(hash('forged-cycle'), displayKeyHash),
    /append-only/i
);
assert.throws(
    () => database.prepare(
        'DELETE FROM gallery_approved_media_key_retirement_reservations ' +
        'WHERE approved_object_key_hash = ?'
    ).run(displayKeyHash),
    /append-only/i
);
assert.throws(
    () => database.prepare(`
        INSERT OR REPLACE INTO gallery_approved_media_key_retirement_reservations
        SELECT * FROM gallery_approved_media_key_retirement_reservations
        WHERE approved_object_key_hash = ?
    `).run(displayKeyHash),
    /replacement is forbidden/i
);

assert.throws(
    () => insertWitnessProof(attempt1, epoch1, attempt1.createdAt),
    /current delivery epoch/i,
    'Witness evidence must be observed strictly after verification creation.'
);
insertWitnessProof(attempt1, epoch1, timestamp2);
insertTargetProof(attempt1, {
    role: 'photo-display',
    keyHash: displayKeyHash,
    urlHash: displayUrlHash,
    sha256: displaySha
}, timestamp2);
assert.throws(
    () => insertReceipt(attempt1, timestamp2),
    /complete current proof/i,
    'A receipt with only one of two target proofs must fail closed.'
);
insertTargetProof(attempt1, {
    role: 'photo-thumbnail',
    keyHash: thumbnailKeyHash,
    urlHash: thumbnailUrlHash,
    sha256: thumbnailSha
}, timestamp2);
assert.throws(
    () => insertReceipt(attempt1, timestamp2),
    /complete current proof/i,
    'The final receipt timestamp must be strictly later than every proof.'
);

database.exec('SAVEPOINT state_version_drift');
setDraftState(primaryDraftId, 'withdrawal-pending', 7);
assert.throws(
    () => insertReceipt(attempt1, receipt1At),
    /complete current proof/i,
    'A state-version change between network proof and commit must reject the receipt.'
);
database.exec('ROLLBACK TO state_version_drift');
database.exec('RELEASE state_version_drift');

insertReceipt(attempt1, receipt1At);
database.prepare(
    'UPDATE draft_publication_references SET host_deletion_confirmed = 1 WHERE draft_id = ?'
).run(primaryDraftId);
assert.equal(publicationHostConfirmation(primaryDraftId), 1);

// A stronger current intent may arrive after the first cycle permanently
// reserved the keys and completed a receipt.  The old receipt becomes stale,
// while a fresh cycle and a rotated service actor can both create immutable
// attempts that reuse only the same key/promotion/draft lineage.
database.exec('SAVEPOINT withdrawal_intent_escalation');
database.prepare(`
    UPDATE draft_publication_references
    SET withdrawal_kind = 'consent-withdrawal', updated_at = ?
    WHERE draft_id = ?
`).run('2026-08-30T12:11:30.000Z', primaryDraftId);
assert.equal(publicationHostConfirmation(primaryDraftId), 0);
assert.equal(database.prepare(`
    SELECT COUNT(*) AS count
    FROM gallery_current_public_host_absence_receipts
    WHERE draft_id = ? AND final_receipt_hash = ?
`).get(primaryDraftId, attempt1.finalReceiptHash).count, 0,
'An old editorial receipt must not remain current after consent escalation.');

const escalatedCycleHash = hash('primary-consent-withdrawal-cycle');
const escalatedAttempt = verificationFixture({
    suffix: 'consent-escalation',
    draftId: primaryDraftId,
    draftHash: primaryDraftHash,
    expectedStateVersion: 6,
    withdrawalCycleHash: escalatedCycleHash,
    withdrawalKind: 'consent-withdrawal',
    epoch: epoch1,
    generationCount: 1,
    generationTargetRowCount: 2,
    targetCount: 2,
    createdAt: '2026-08-30T12:12:00.000Z'
});
insertVerification(escalatedAttempt);

const sameActorSameCycle = verificationFixture({
    suffix: 'same-actor-same-cycle',
    draftId: primaryDraftId,
    draftHash: primaryDraftHash,
    expectedStateVersion: 6,
    withdrawalCycleHash: escalatedCycleHash,
    withdrawalKind: 'consent-withdrawal',
    epoch: epoch1,
    generationCount: 1,
    generationTargetRowCount: 2,
    targetCount: 2,
    createdAt: '2026-08-30T12:12:01.000Z'
});
assert.throws(
    () => insertVerification(sameActorSameCycle),
    /replacement is forbidden|UNIQUE constraint failed/i,
    'One actor cannot fork the same current cycle under a new idempotency key.'
);

const rotatedActorAttempt = verificationFixture({
    suffix: 'rotated-actor-recovery',
    draftId: primaryDraftId,
    draftHash: primaryDraftHash,
    expectedStateVersion: 6,
    withdrawalCycleHash: escalatedCycleHash,
    withdrawalKind: 'consent-withdrawal',
    actorIdentityHash: hash('rotated-verifier-service-actor'),
    epoch: epoch1,
    generationCount: 1,
    generationTargetRowCount: 2,
    targetCount: 2,
    createdAt: '2026-08-30T12:12:02.000Z'
});
insertVerification(rotatedActorAttempt);

const changedCycleSameIdempotency = verificationFixture({
    suffix: 'changed-cycle-same-idempotency',
    draftId: primaryDraftId,
    draftHash: primaryDraftHash,
    expectedStateVersion: 6,
    withdrawalCycleHash: hash('second-consent-cycle'),
    withdrawalKind: 'consent-withdrawal',
    idempotencyKey: escalatedAttempt.idempotencyKey,
    idempotencyKeyHash: escalatedAttempt.idempotencyKeyHash,
    epoch: epoch1,
    generationCount: 1,
    generationTargetRowCount: 2,
    targetCount: 2,
    createdAt: '2026-08-30T12:12:03.000Z'
});
assert.throws(
    () => insertVerification(changedCycleSameIdempotency),
    /replacement is forbidden|UNIQUE constraint failed/i,
    'An idempotency key cannot be replayed into a changed withdrawal cycle.'
);

insertWitnessProof(escalatedAttempt, epoch1, '2026-08-30T12:13:00.000Z');
insertTargetProof(escalatedAttempt, {
    role: 'photo-display', keyHash: displayKeyHash,
    urlHash: displayUrlHash, sha256: displaySha
}, '2026-08-30T12:13:00.000Z');
insertTargetProof(escalatedAttempt, {
    role: 'photo-thumbnail', keyHash: thumbnailKeyHash,
    urlHash: thumbnailUrlHash, sha256: thumbnailSha
}, '2026-08-30T12:13:00.000Z');
insertReceipt(escalatedAttempt, '2026-08-30T12:14:00.000Z');
database.prepare(
    'UPDATE draft_publication_references SET host_deletion_confirmed = 1 WHERE draft_id = ?'
).run(primaryDraftId);
assert.equal(publicationHostConfirmation(primaryDraftId), 1);
assert.equal(database.prepare(`
    SELECT COUNT(*) AS count
    FROM gallery_current_public_host_absence_receipts
    WHERE draft_id = ? AND final_receipt_hash = ?
`).get(primaryDraftId, escalatedAttempt.finalReceiptHash).count, 1);
database.exec('ROLLBACK TO withdrawal_intent_escalation');
database.exec('RELEASE withdrawal_intent_escalation');
assert.equal(publicationHostConfirmation(primaryDraftId), 1);

// Once the key also enters the terminal reservation ledger, even retrying the
// rejected second owner is blocked by the global retirement fence.
assert.throws(
    insertResurrectionDisplayTarget,
    /retired/i,
    'A globally retired content-addressed URL cannot be resurrected.'
);

// Registering a later deployment is insufficient by itself.  Only its exact
// append-only activation may advance the pointer, and advancing it immediately
// makes the old absence receipt non-current.
const epoch2Registration = epochValues({
    sequence: 2,
    suffix: 'two',
    origin,
    originHash,
    timestamp: '2026-08-30T12:20:00.000Z'
});
insertEpochRegistration(epoch2Registration);
assert.throws(
    () => updateEpochPointer(epoch2Registration),
    /exact activation evidence/i
);
insertEpochActivation(epoch2Registration, epoch1.epochIdHash);
updateEpochPointer(epoch2Registration);
const epoch2 = epoch2Registration;
assert.equal(publicationHostConfirmation(primaryDraftId), 0);
assert.equal(database.prepare(
    'SELECT COUNT(*) AS count FROM gallery_current_public_host_absence_receipts ' +
    'WHERE draft_id = ?'
).get(primaryDraftId).count, 0);
assert.throws(
    () => database.prepare(
        'UPDATE draft_publication_references SET host_deletion_confirmed = 1 WHERE draft_id = ?'
    ).run(primaryDraftId),
    /current complete receipt/i
);
assert.throws(
    () => database.prepare(
        'UPDATE gallery_media_delivery_current_epoch SET epoch_sequence = 4 ' +
        'WHERE singleton_id = 1'
    ).run(),
    /exact activation evidence/i
);
assert.throws(
    () => database.prepare(
        'UPDATE gallery_media_delivery_epochs SET approved_origin_hash = ? ' +
        'WHERE epoch_id_hash = ?'
    ).run(hash('forged-origin'), epoch1.epochIdHash),
    /append-only/i
);
assert.throws(
    () => database.prepare(
        'DELETE FROM gallery_media_delivery_epochs WHERE epoch_id_hash = ?'
    ).run(epoch1.epochIdHash),
    /append-only/i
);

const attempt2 = verificationFixture({
    suffix: 'two',
    draftId: primaryDraftId,
    draftHash: primaryDraftHash,
    expectedStateVersion: 6,
    withdrawalCycleHash,
    epoch: epoch2,
    generationCount: 1,
    generationTargetRowCount: 2,
    targetCount: 2,
    createdAt: '2026-08-30T12:20:30.000Z'
});
insertVerification(attempt2);
// Existing terminal reservations are deliberately reusable only for the same
// draft/promotion keys; a delivery-epoch refresh must not reopen those keys.
insertWitnessProof(attempt2, epoch2, '2026-08-30T12:21:00.000Z');
insertTargetProof(attempt2, {
    role: 'photo-display', keyHash: displayKeyHash,
    urlHash: displayUrlHash, sha256: displaySha
}, '2026-08-30T12:21:00.000Z');
insertTargetProof(attempt2, {
    role: 'photo-thumbnail', keyHash: thumbnailKeyHash,
    urlHash: thumbnailUrlHash, sha256: thumbnailSha
}, '2026-08-30T12:21:00.000Z');
insertReceipt(attempt2, '2026-08-30T12:22:00.000Z');
database.prepare(
    'UPDATE draft_publication_references SET host_deletion_confirmed = 1 WHERE draft_id = ?'
).run(primaryDraftId);
assert.equal(publicationHostConfirmation(primaryDraftId), 1);

database.prepare(
    'UPDATE draft_publication_references SET host_deletion_confirmed = 0 WHERE draft_id = ?'
).run(primaryDraftId);
assert.equal(database.prepare(`
    SELECT COUNT(*) AS count
    FROM gallery_current_public_host_absence_receipts
    WHERE draft_id = ? AND final_receipt_hash = ?
`).get(primaryDraftId, attempt2.finalReceiptHash).count, 0,
'An exact-cycle receipt cannot report current withdrawal confirmation while its scalar is zero.');
database.prepare(
    'UPDATE draft_publication_references SET host_deletion_confirmed = 1 WHERE draft_id = ?'
).run(primaryDraftId);
assert.equal(database.prepare(`
    SELECT COUNT(*) AS count
    FROM gallery_current_public_host_absence_receipts
    WHERE draft_id = ? AND final_receipt_hash = ?
`).get(primaryDraftId, attempt2.finalReceiptHash).count, 1);

const primaryReceiptHash = attempt2.finalReceiptHash;
for (const [sql, values, pattern] of [
    [
        'UPDATE gallery_public_host_absence_receipts SET target_count = 1 ' +
            'WHERE final_receipt_hash = ?',
        [primaryReceiptHash],
        /append-only/i
    ],
    [
        'DELETE FROM gallery_public_host_absence_receipts WHERE final_receipt_hash = ?',
        [primaryReceiptHash],
        /append-only/i
    ]
]) {
    assert.throws(() => database.prepare(sql).run(...values), pattern);
}
assert.throws(
    () => database.prepare(`
        INSERT OR REPLACE INTO gallery_public_host_absence_receipts
        SELECT * FROM gallery_public_host_absence_receipts
        WHERE final_receipt_hash = ?
    `).run(primaryReceiptHash),
    /replacement is forbidden/i
);

// The direct withdrawal gate consumes the current receipt, not merely the
// mutable compatibility scalar.
setDraftState(primaryDraftId, 'withdrawn', 7);
database.prepare(`
    INSERT INTO gallery_retention_tombstones (
        draft_id, purge_kind, eligible_at, approved_at,
        approved_by_identity_hash, evidence_hash
    ) VALUES (?, 'retention-expiry', ?, ?, ?, ?)
`).run(
    primaryDraftId,
    '2026-08-30T12:22:00.000Z',
    '2026-08-30T12:23:00.000Z',
    actorHash,
    hash('approved-primary-purge')
);
const epoch3Registration = epochValues({
    sequence: 3,
    suffix: 'three',
    origin,
    originHash,
    timestamp: '2026-08-30T12:24:00.000Z'
});
insertEpochRegistration(epoch3Registration);
insertEpochActivation(epoch3Registration, epoch2.epochIdHash);
updateEpochPointer(epoch3Registration);
const epoch3 = epoch3Registration;
assert.equal(publicationHostConfirmation(primaryDraftId), 0);
assert.throws(
    () => database.prepare('DELETE FROM gallery_drafts WHERE draft_id = ?')
        .run(primaryDraftId),
    /current public-host absence evidence|approved cleanup evidence/i,
    'Epoch rotation after withdrawal must block purge until host absence is refreshed.'
);

database.exec('SAVEPOINT historical_retention_requires_targets');
setDraftState(primaryDraftId, 'rejected', 7);
database.prepare(`
    UPDATE draft_publication_references
    SET withdrawal_kind = NULL, host_deletion_confirmed = 0, updated_at = ?
    WHERE draft_id = ?
`).run('2026-08-30T12:24:01.000Z', primaryDraftId);
const historicalRetentionAttempt = verificationFixture({
    suffix: 'historical-retention',
    draftId: primaryDraftId,
    draftHash: primaryDraftHash,
    expectedStateVersion: 7,
    verificationPurpose: 'retention-expiry',
    purposeEvidenceHash: hash('approved-primary-purge'),
    withdrawalKind: 'retention-expiry',
    withdrawalCycleHash: hash('historical-retention-cycle'),
    epoch: epoch3,
    generationCount: 1,
    generationTargetRowCount: 2,
    targetCount: 2,
    createdAt: '2026-08-30T12:24:02.000Z'
});
insertVerification(historicalRetentionAttempt);
insertWitnessProof(
    historicalRetentionAttempt, epoch3, '2026-08-30T12:24:03.000Z'
);
assert.throws(
    () => insertReceipt(historicalRetentionAttempt, '2026-08-30T12:24:04.000Z'),
    /complete current proof/i,
    'A retention-purpose draft with history cannot use a witness-only shortcut.'
);
insertTargetProof(historicalRetentionAttempt, {
    role: 'photo-display', keyHash: displayKeyHash,
    urlHash: displayUrlHash, sha256: displaySha
}, '2026-08-30T12:24:03.000Z');
assert.throws(
    () => insertReceipt(historicalRetentionAttempt, '2026-08-30T12:24:04.000Z'),
    /complete current proof/i,
    'Every historical target must have its own exact retention absence proof.'
);
insertTargetProof(historicalRetentionAttempt, {
    role: 'photo-thumbnail', keyHash: thumbnailKeyHash,
    urlHash: thumbnailUrlHash, sha256: thumbnailSha
}, '2026-08-30T12:24:03.000Z');
insertReceipt(historicalRetentionAttempt, '2026-08-30T12:24:04.000Z');
assert.equal(database.prepare(`
    SELECT COUNT(*) AS count
    FROM gallery_current_public_host_absence_receipts
    WHERE draft_id = ? AND verification_purpose = 'retention-expiry'
`).get(primaryDraftId).count, 1);
assert.equal(publicationHostConfirmation(primaryDraftId), 0);
database.exec('ROLLBACK TO historical_retention_requires_targets');
database.exec('RELEASE historical_retention_requires_targets');

const attempt3 = verificationFixture({
    suffix: 'three',
    draftId: primaryDraftId,
    draftHash: primaryDraftHash,
    expectedStateVersion: 7,
    withdrawalCycleHash,
    epoch: epoch3,
    generationCount: 1,
    generationTargetRowCount: 2,
    targetCount: 2,
    createdAt: '2026-08-30T12:24:10.000Z'
});
insertVerification(attempt3);
insertWitnessProof(attempt3, epoch3, '2026-08-30T12:25:00.000Z');
insertTargetProof(attempt3, {
    role: 'photo-display', keyHash: displayKeyHash,
    urlHash: displayUrlHash, sha256: displaySha
}, '2026-08-30T12:25:00.000Z');
insertTargetProof(attempt3, {
    role: 'photo-thumbnail', keyHash: thumbnailKeyHash,
    urlHash: thumbnailUrlHash, sha256: thumbnailSha
}, '2026-08-30T12:25:00.000Z');
insertReceipt(attempt3, '2026-08-30T12:26:00.000Z');
database.prepare(
    'UPDATE draft_publication_references SET host_deletion_confirmed = 1 WHERE draft_id = ?'
).run(primaryDraftId);
const permanentReceiptCountBeforePurge = database.prepare(
    'SELECT COUNT(*) AS count FROM gallery_public_host_absence_receipts ' +
    'WHERE draft_id_hash = ?'
).get(primaryDraftHash).count;
assert.equal(permanentReceiptCountBeforePurge, 3);
database.prepare('DELETE FROM gallery_drafts WHERE draft_id = ?').run(primaryDraftId);
assert.equal(database.prepare(
    'SELECT COUNT(*) AS count FROM draft_photo_public_generations WHERE draft_id = ?'
).get(primaryDraftId).count, 0);
assert.equal(database.prepare(
    'SELECT COUNT(*) AS count FROM draft_public_host_absence_verifications WHERE draft_id = ?'
).get(primaryDraftId).count, 0);
assert.equal(database.prepare(
    'SELECT COUNT(*) AS count FROM gallery_public_host_absence_receipts ' +
    'WHERE draft_id_hash = ?'
).get(primaryDraftHash).count, permanentReceiptCountBeforePurge);
assert.equal(database.prepare(
    'SELECT COUNT(*) AS count FROM gallery_approved_media_key_retirement_reservations ' +
    'WHERE draft_id_hash = ?'
).get(primaryDraftHash).count, 2);

// A draft that never had a public generation still follows the same receipt
// boundary.  Its exact generation/cleanup/target sets are the canonical empty
// hash, so pre-public withdrawal remains possible without inventing a URL.
const zeroDraftId = 'draft_zero_generation_withdrawal_0003';
const zeroDraftHash = hash(`draft:${zeroDraftId}`);
insertDraft(zeroDraftId, 'zero-generation-public-item');
setDraftState(zeroDraftId, 'withdrawal-pending', 1);
assert.throws(
    () => database.prepare(`
        INSERT INTO draft_publication_references (
            draft_id, host_deletion_confirmed, private_original_deletion_confirmed,
            withdrawal_kind, updated_at
        ) VALUES (?, 1, 0, 'editorial-removal', ?)
    `).run(zeroDraftId, timestamp2),
    /current complete receipt/i
);
database.prepare(`
    INSERT INTO draft_publication_references (
        draft_id, host_deletion_confirmed, private_original_deletion_confirmed,
        withdrawal_kind, updated_at
    ) VALUES (?, 0, 0, 'editorial-removal', ?)
`).run(zeroDraftId, timestamp2);
assert.throws(
    () => setDraftState(zeroDraftId, 'withdrawn', 2),
    /current complete public-host absence receipt/i
);
const zeroAttempt = verificationFixture({
    suffix: 'zero',
    draftId: zeroDraftId,
    draftHash: zeroDraftHash,
    expectedStateVersion: 1,
    withdrawalCycleHash: hash('zero-generation-withdrawal-cycle'),
    epoch: epoch3,
    generationCount: 0,
    generationTargetRowCount: 0,
    targetCount: 0,
    empty: true,
    createdAt: '2026-08-30T12:25:00.000Z'
});
insertVerification(zeroAttempt);
insertWitnessProof(zeroAttempt, epoch3, '2026-08-30T12:30:00.000Z');
insertReceipt(zeroAttempt, '2026-08-30T12:31:00.000Z');
database.prepare(
    'UPDATE draft_publication_references SET host_deletion_confirmed = 1 WHERE draft_id = ?'
).run(zeroDraftId);
setDraftState(zeroDraftId, 'withdrawn', 2);
assert.deepEqual(
    { ...database.prepare(
        'SELECT state, state_version AS stateVersion FROM gallery_drafts WHERE draft_id = ?'
    ).get(zeroDraftId) },
    { state: 'withdrawn', stateVersion: 2 }
);

// Rejected and processing-failed never-public drafts use a separate retention
// purpose derived from the approved tombstone.  It proves the canonical empty
// set with the normal witness bracket, never sets the withdrawal-only scalar,
// and authorizes the exact retention purge without inventing a media key.
const retentionDraftId = 'draft_zero_generation_retention_0004';
const retentionDraftHash = hash(`draft:${retentionDraftId}`);
const retentionEvidenceHash = hash('approved-zero-generation-retention');
insertDraft(retentionDraftId, 'zero-generation-retention-item');
setDraftState(retentionDraftId, 'rejected', 4);
database.prepare(`
    INSERT INTO draft_publication_references (
        draft_id, host_deletion_confirmed, private_original_deletion_confirmed,
        withdrawal_kind, updated_at
    ) VALUES (?, 0, 1, NULL, ?)
`).run(retentionDraftId, '2026-08-30T12:32:00.000Z');
const retentionAttempt = verificationFixture({
    suffix: 'zero-retention',
    draftId: retentionDraftId,
    draftHash: retentionDraftHash,
    expectedStateVersion: 4,
    verificationPurpose: 'retention-expiry',
    purposeEvidenceHash: retentionEvidenceHash,
    withdrawalKind: 'retention-expiry',
    withdrawalCycleHash: hash('zero-generation-retention-cycle'),
    epoch: epoch3,
    generationCount: 0,
    generationTargetRowCount: 0,
    targetCount: 0,
    empty: true,
    createdAt: '2026-08-30T12:34:00.000Z'
});
assert.throws(
    () => insertVerification(retentionAttempt),
    /current complete generation set/i,
    'Retention verification must be impossible before its approved tombstone.'
);
database.prepare(`
    INSERT INTO gallery_retention_tombstones (
        draft_id, purge_kind, eligible_at, approved_at,
        approved_by_identity_hash, evidence_hash
    ) VALUES (?, 'retention-expiry', ?, ?, ?, ?)
`).run(
    retentionDraftId,
    '2026-08-30T12:32:00.000Z',
    '2026-08-30T12:33:00.000Z',
    actorHash,
    retentionEvidenceHash
);
insertVerification(retentionAttempt);
insertWitnessProof(retentionAttempt, epoch3, '2026-08-30T12:35:00.000Z');
insertReceipt(retentionAttempt, '2026-08-30T12:36:00.000Z');
assert.equal(publicationHostConfirmation(retentionDraftId), 0);
assert.equal(database.prepare(`
    SELECT COUNT(*) AS count
    FROM gallery_current_public_host_absence_receipts
    WHERE draft_id = ? AND verification_purpose = 'retention-expiry'
      AND purpose_evidence_hash = ?
`).get(retentionDraftId, retentionEvidenceHash).count, 1);
assert.throws(
    () => database.prepare(
        'UPDATE draft_publication_references SET host_deletion_confirmed = 1 ' +
        'WHERE draft_id = ?'
    ).run(retentionDraftId),
    /current complete receipt/i,
    'Retention evidence must not turn on the withdrawal-only compatibility scalar.'
);
const retentionReceiptHash = retentionAttempt.finalReceiptHash;
database.prepare('DELETE FROM gallery_drafts WHERE draft_id = ?').run(retentionDraftId);
assert.equal(database.prepare(
    'SELECT COUNT(*) AS count FROM gallery_public_host_absence_receipts ' +
    'WHERE final_receipt_hash = ? AND verification_purpose = \'retention-expiry\''
).get(retentionReceiptHash).count, 1);
assert.equal(database.prepare(
    'SELECT COUNT(*) AS count FROM gallery_approved_media_key_retirement_reservations ' +
    'WHERE draft_id_hash = ?'
).get(retentionDraftHash).count, 0);

assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
database.close();

console.log(
    'Public-host migration: immutable generations, exact two-role proof, epoch invalidation, ' +
    'global key retirement, intent/identity recovery, zero-generation withdrawal, and ' +
    'direct retention-expiry purge passed.'
);

function hash(value) {
    return createHash('sha256').update(value).digest('hex');
}

function insertDraft(draftId, publicItemId) {
    database.prepare(`
        INSERT INTO gallery_drafts (
            draft_id, public_item_id, site_modes_json, export_bundle_id,
            source_revision, suppression_revision, item_revision, media_type,
            race_date, race_event, race_distance, athlete_ids_json, title,
            caption, alt_text, featured, verified_owner_identity_hash,
            created_at, updated_at
        ) VALUES (?, ?, '["family"]', 'bundle-synthetic', 'source-synthetic',
            'suppression-synthetic', 'item-synthetic', 'photo', '2026-08-30',
            'Synthetic race', '5 km', '[]', 'Synthetic title',
            'Synthetic caption', 'Synthetic alternative text', 0, ?, ?, ?)
    `).run(draftId, publicItemId, actorHash, timestamp1, timestamp1);
}

function setDraftState(draftId, state, stateVersion) {
    database.prepare(
        'UPDATE gallery_drafts SET state = ?, state_version = ?, updated_at = ? ' +
        'WHERE draft_id = ?'
    ).run(state, stateVersion, `2026-08-30T12:${String(stateVersion).padStart(2, '0')}:00.000Z`, draftId);
}

function epochValues({ sequence, suffix, origin: fixedOrigin, originHash: fixedOriginHash, timestamp }) {
    const epochId = `media_delivery_epoch_${suffix}`;
    return {
        epochId,
        epochIdHash: hash(`epoch:${epochId}`),
        sequence,
        origin: fixedOrigin,
        originHash: fixedOriginHash,
        contractHash: hash(`delivery-contract:${suffix}`),
        versionHash: hash(`delivery-version:${suffix}`),
        witnessKeyHash: hash(`witness-key:${suffix}`),
        witnessSha256: hash(`witness-bytes:${suffix}`),
        witnessByteCount: 44,
        witnessContentType: 'image/webp',
        configurationHash: hash(`delivery-configuration:${suffix}`),
        activationReceiptHash: hash(`epoch-activation:${suffix}`),
        activationIdempotencyHash: hash(`epoch-activation-idempotency:${suffix}`),
        activationPayloadHash: hash(`epoch-activation-payload:${suffix}`),
        registeredAt: timestamp,
        timestamp: new Date(Date.parse(timestamp) + 1000).toISOString()
    };
}

function insertEpoch({ sequence, suffix, origin: fixedOrigin, originHash: fixedOriginHash, timestamp }) {
    const epoch = epochValues({
        sequence, suffix, origin: fixedOrigin, originHash: fixedOriginHash, timestamp
    });
    insertEpochRegistration(epoch);
    insertEpochActivation(epoch, null);
    database.prepare(`
        INSERT INTO gallery_media_delivery_current_epoch (
            singleton_id, epoch_id_hash, epoch_sequence,
            activation_receipt_hash, activated_at
        ) VALUES (1, ?, ?, ?, ?)
    `).run(epoch.epochIdHash, epoch.sequence, epoch.activationReceiptHash, epoch.timestamp);
    return epoch;
}

function insertEpochRegistration(epoch) {
    database.prepare(`
        INSERT INTO gallery_media_delivery_epochs (
            epoch_id, epoch_id_hash, epoch_sequence, approved_origin,
            approved_origin_hash, delivery_contract_hash, delivery_version_hash,
            witness_object_key_hash, witness_sha256, witness_byte_count,
            witness_content_type, configuration_hash,
            registered_by_identity_hash, registered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        epoch.epochId,
        epoch.epochIdHash,
        epoch.sequence,
        epoch.origin,
        epoch.originHash,
        epoch.contractHash,
        epoch.versionHash,
        epoch.witnessKeyHash,
        epoch.witnessSha256,
        epoch.witnessByteCount,
        epoch.witnessContentType,
        epoch.configurationHash,
        actorHash,
        epoch.registeredAt
    );
}

function insertEpochActivation(epoch, previousEpochIdHash) {
    database.prepare(`
        INSERT INTO gallery_media_delivery_epoch_activations (
            activation_receipt_hash, epoch_id_hash, epoch_sequence,
            previous_epoch_id_hash, activation_idempotency_key_hash,
            activation_payload_hash, service_actor_identity_hash, activated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        epoch.activationReceiptHash,
        epoch.epochIdHash,
        epoch.sequence,
        previousEpochIdHash,
        epoch.activationIdempotencyHash,
        epoch.activationPayloadHash,
        actorHash,
        epoch.timestamp
    );
}

function updateEpochPointer(epoch) {
    database.prepare(`
        UPDATE gallery_media_delivery_current_epoch
        SET epoch_id_hash = ?, epoch_sequence = ?, activation_receipt_hash = ?,
            activated_at = ?
        WHERE singleton_id = 1
    `).run(
        epoch.epochIdHash,
        epoch.sequence,
        epoch.activationReceiptHash,
        epoch.timestamp
    );
}

function insertPromotionFixture({
    draftId,
    promotionId,
    expectedStateVersion,
    displayKey: exactDisplayKey,
    displaySha: exactDisplaySha,
    thumbnailKey: exactThumbnailKey,
    thumbnailSha: exactThumbnailSha,
    timestamp
}) {
    database.exec('PRAGMA foreign_keys = OFF');
    database.prepare(`
        INSERT INTO draft_photo_promotions (
            promotion_id, processing_run_id, draft_id, site_mode,
            item_revision, consent_revision, export_bundle_id, source_revision,
            suppression_revision, expected_state_version, result_state_version,
            idempotency_key, idempotency_key_hash, payload_fingerprint,
            service_actor_identity_hash, created_at, updated_at
        ) VALUES (?, ?, ?, 'family', 'item-synthetic', 'consent-synthetic',
            'bundle-synthetic', 'source-synthetic', 'suppression-synthetic',
            ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        promotionId,
        `run_${hash(promotionId).slice(0, 32)}`,
        draftId,
        expectedStateVersion,
        expectedStateVersion + 1,
        `promotion-idempotency-${promotionId.slice(-8)}`,
        hash(`promotion-idempotency:${promotionId}`),
        hash(`promotion-payload:${promotionId}`),
        actorHash,
        timestamp,
        timestamp
    );
    for (const [role, key, sha256] of [
        ['photo-display', exactDisplayKey, exactDisplaySha],
        ['photo-thumbnail', exactThumbnailKey, exactThumbnailSha]
    ]) {
        database.prepare(`
            INSERT INTO draft_photo_promotion_objects (
                promotion_id, role, staging_object_key, staging_object_version,
                staging_etag, approved_object_key, sha256, byte_count,
                content_type, width, height, created_at, updated_at
            ) VALUES (?, ?, ?, 'staging-version', 'staging-etag', ?, ?, 44,
                'image/webp', 4, 4, ?, ?)
        `).run(
            promotionId,
            role,
            `derivative-staging/${promotionId}/${role}.webp`,
            key,
            sha256,
            timestamp,
            timestamp
        );
    }
    database.exec('PRAGMA foreign_keys = ON');
}

function insertGenerationTarget({
    promotionId,
    role,
    key,
    keyHash,
    urlHash,
    sha256,
    targetSetHash,
    timestamp
}) {
    database.prepare(`
        INSERT INTO draft_photo_public_generation_targets (
            promotion_id, role, approved_object_key, approved_object_key_hash,
            public_url_hash, expected_sha256, generation_target_set_hash,
            created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        promotionId, role, key, keyHash, urlHash, sha256, targetSetHash, timestamp
    );
}

function insertCleanupTombstone({ promotionHash, draftHash, suffix, timestamp }) {
    database.prepare(`
        INSERT INTO gallery_photo_promotion_cleanup_tombstones (
            cleanup_id_hash, promotion_id_hash, processing_run_id_hash,
            draft_id_hash, source_promotion_idempotency_key_hash,
            source_promotion_payload_fingerprint, cleanup_idempotency_key_hash,
            cleanup_payload_fingerprint, cleanup_reason, withdrawal_kind,
            evidence_hash, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'withdrawal',
            'editorial-removal', ?, ?)
    `).run(
        hash(`cleanup-id:${suffix}`),
        promotionHash,
        hash(`processing-run:${suffix}`),
        draftHash,
        hash(`promotion-idempotency:${suffix}`),
        hash(`promotion-payload:${suffix}`),
        hash(`cleanup-idempotency:${suffix}`),
        hash(`cleanup-payload:${suffix}`),
        hash(`cleanup-evidence:${suffix}`),
        timestamp
    );
}

function verificationFixture({
    suffix,
    draftId,
    draftHash,
    expectedStateVersion,
    withdrawalCycleHash,
    epoch,
    generationCount,
    generationTargetRowCount,
    targetCount,
    empty = false,
    verificationPurpose = 'withdrawal',
    purposeEvidenceHash = null,
    withdrawalKind = 'editorial-removal',
    actorIdentityHash = actorHash,
    idempotencyKey,
    idempotencyKeyHash,
    createdAt
}) {
    const verificationId = `hostverify_${hash(`verification-id:${suffix}`).slice(0, 32)}`;
    return {
        verificationId,
        verificationIdHash: hash(`verification:${verificationId}`),
        draftId,
        draftHash,
        expectedStateVersion,
        verificationPurpose,
        purposeEvidenceHash,
        withdrawalKind,
        withdrawalCycleHash,
        promotionSetHash: empty ? emptyHash : hash(`promotion-set:${suffix}`),
        cleanupSetHash: empty ? emptyHash : hash(`cleanup-set:${suffix}`),
        originHash: epoch.originHash,
        targetSetHash: empty ? emptyHash : hash(`target-set:${suffix}`),
        generationCount,
        generationTargetRowCount,
        targetCount,
        epochIdHash: epoch.epochIdHash,
        contractHash: epoch.contractHash,
        versionHash: epoch.versionHash,
        idempotencyKey: idempotencyKey || `host-absence-${suffix}-idempotency`,
        idempotencyKeyHash: idempotencyKeyHash ||
            hash(`host-absence-idempotency:${suffix}`),
        payloadFingerprint: hash(`host-absence-payload:${suffix}`),
        finalReceiptHash: hash(`host-absence-final-receipt:${suffix}`),
        actorIdentityHash,
        createdAt: createdAt || epoch.timestamp
    };
}

function insertVerification(attempt) {
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        attempt.verificationId,
        attempt.verificationIdHash,
        attempt.draftId,
        attempt.draftHash,
        attempt.expectedStateVersion,
        attempt.verificationPurpose,
        attempt.purposeEvidenceHash,
        attempt.withdrawalKind,
        attempt.withdrawalCycleHash,
        attempt.promotionSetHash,
        attempt.cleanupSetHash,
        attempt.originHash,
        attempt.targetSetHash,
        attempt.generationCount,
        attempt.generationTargetRowCount,
        attempt.targetCount,
        attempt.epochIdHash,
        attempt.contractHash,
        attempt.versionHash,
        attempt.idempotencyKey,
        attempt.idempotencyKeyHash,
        attempt.payloadFingerprint,
        attempt.actorIdentityHash,
        attempt.createdAt
    );
}

function reserveKey(attempt, promotionIdHash, keyHash, timestamp) {
    database.prepare(`
        INSERT INTO gallery_approved_media_key_retirement_reservations (
            approved_object_key_hash, verification_id_hash, promotion_id_hash,
            draft_id_hash, withdrawal_cycle_hash,
            reservation_idempotency_key_hash, reserved_by_identity_hash,
            reserved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        keyHash,
        attempt.verificationIdHash,
        promotionIdHash,
        attempt.draftHash,
        attempt.withdrawalCycleHash,
        attempt.idempotencyKeyHash,
        attempt.actorIdentityHash,
        timestamp
    );
}

function insertWitnessProof(attempt, epoch, timestamp) {
    database.prepare(`
        INSERT INTO draft_public_host_absence_witness_proofs (
            verification_id, witness_object_key_hash, witness_sha256,
            witness_byte_count, witness_content_type,
            before_head_evidence_hash, before_get_evidence_hash,
            after_head_evidence_hash, after_get_evidence_hash,
            observed_contract_hash, observed_version_hash, verified_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        attempt.verificationId,
        epoch.witnessKeyHash,
        epoch.witnessSha256,
        epoch.witnessByteCount,
        epoch.witnessContentType,
        hash(`witness-before-head:${attempt.verificationId}`),
        hash(`witness-before-get:${attempt.verificationId}`),
        hash(`witness-after-head:${attempt.verificationId}`),
        hash(`witness-after-get:${attempt.verificationId}`),
        epoch.contractHash,
        epoch.versionHash,
        timestamp
    );
}

function insertTargetProof(attempt, target, timestamp) {
    database.prepare(`
        INSERT INTO draft_public_host_absence_target_proofs (
            verification_id, approved_object_key_hash, role, public_url_hash,
            expected_sha256, head_evidence_hash, get_evidence_hash,
            final_head_evidence_hash, observed_contract_hash,
            observed_version_hash, verified_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        attempt.verificationId,
        target.keyHash,
        target.role,
        target.urlHash,
        target.sha256,
        hash(`target-head:${attempt.verificationId}:${target.role}`),
        hash(`target-get:${attempt.verificationId}:${target.role}`),
        hash(`target-final-head:${attempt.verificationId}:${target.role}`),
        attempt.contractHash,
        attempt.versionHash,
        timestamp
    );
}

function insertReceipt(attempt, timestamp) {
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        attempt.finalReceiptHash,
        attempt.verificationIdHash,
        attempt.draftHash,
        attempt.promotionSetHash,
        attempt.cleanupSetHash,
        attempt.withdrawalCycleHash,
        attempt.originHash,
        attempt.targetSetHash,
        attempt.generationCount,
        attempt.targetCount,
        attempt.expectedStateVersion,
        attempt.verificationPurpose,
        attempt.purposeEvidenceHash,
        attempt.epochIdHash,
        attempt.contractHash,
        attempt.versionHash,
        attempt.idempotencyKeyHash,
        attempt.payloadFingerprint,
        timestamp
    );
}

function publicationHostConfirmation(draftId) {
    return database.prepare(
        'SELECT host_deletion_confirmed AS confirmed ' +
        'FROM draft_publication_references WHERE draft_id = ?'
    ).get(draftId).confirmed;
}
