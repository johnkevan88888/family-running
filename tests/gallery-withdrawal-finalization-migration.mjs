import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

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

const database = new DatabaseSync(':memory:');
for (const migration of migrations.slice(0, -1)) database.exec(migration);

// Earlier migrations separately prove how upload, processing, promotion and
// review rows are produced. Drop only those setup guards needed to build exact
// parent fixtures; migration 0013's finalization guards remain untouched.
for (const trigger of [
    'gallery_drafts_state_version_guard',
    'gallery_drafts_transition_guard',
    'gallery_drafts_consent_state_gate_guard',
    'gallery_drafts_candidate_processing_guard',
    'gallery_drafts_photo_review_withdrawal_guard',
    'draft_upload_sessions_insert_guard',
    'draft_processing_runs_insert_guard',
    'draft_photo_promotions_insert_guard',
    'draft_photo_promotions_no_delete_guard',
    'draft_photo_public_generations_insert_guard',
    'draft_photo_public_generation_targets_insert_guard',
    'draft_photo_review_receipts_insert_guard',
    'draft_photo_promotion_cleanups_insert_guard',
    'draft_processing_cleanups_insert_guard',
    'draft_processing_cleanups_photo_promotion_guard'
]) {
    database.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
}

const actorHash = hash('synthetic-finalizer-service-actor');
const consent = seedPhotoDraft('consent', 1, 'consent-withdrawal');
const editorial = seedPhotoDraft('editorial', 2, 'editorial-removal');
const historicalFixtures = [
    seedHistoricalRetentionDraft('rejected'),
    seedHistoricalRetentionDraft('processing-failed')
];
const preMigrationOrphanDraftId = `draft_${uuid('draft:pre-0013-orphan')}`;
database.prepare(`
    INSERT INTO gallery_retention_tombstones (
        draft_id, purge_kind, eligible_at, approved_at,
        approved_by_identity_hash, evidence_hash
    ) VALUES (?, 'retention-expiry', '2026-07-01T00:00:00.000Z',
        '2026-08-01T00:00:00.000Z', ?, ?)
`).run(
    preMigrationOrphanDraftId,
    actorHash,
    hash('pre-0013-orphan-retention-evidence')
);

// Apply the migration under test only after the historical fixture exists.
// That models a legitimate pre-migration rejected/processing-failed row whose
// one-way private-deletion scalar was already true.
database.exec(migrations.at(-1));

assert.equal(database.prepare(
    'SELECT COUNT(*) AS count FROM gallery_retention_tombstones WHERE draft_id = ?'
).get(preMigrationOrphanDraftId).count, 0,
'Migration 0013 must remove retention rows orphaned by a pre-0013 guarded purge.');

assert.equal(database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');

for (const [type, name] of [
    ['view', 'gallery_terminal_photo_review_invalidations'],
    ['view', 'gallery_complete_photo_review_invalidation_cleanups'],
    ['table', 'draft_withdrawal_finalization_operations'],
    ['table', 'gallery_withdrawal_completion_receipts'],
    ['table', 'draft_private_original_deletions'],
    ['table', 'gallery_private_original_deletion_tombstones'],
    ['table', 'gallery_draft_purge_receipts'],
    ['trigger', 'draft_withdrawal_finalization_operations_insert_guard'],
    ['trigger', 'gallery_withdrawal_completion_receipts_insert_guard'],
    ['trigger', 'draft_upload_sessions_finalizer_delete_guard'],
    ['trigger', 'gallery_retention_tombstones_finalization_insert_guard'],
    ['trigger', 'gallery_retention_tombstones_cleanup_guard'],
    ['trigger', 'gallery_drafts_remove_raw_retention_tombstone'],
    ['trigger', 'gallery_draft_purge_receipts_purge_parent']
]) {
    assert.equal(schemaCount(type, name), 1, `${type} ${name}`);
}

// The host verifier has its own full proof tests. These two insert guards are
// dropped only so this focused fixture can inject an already-validated current
// host receipt without reproducing R2 network observations.
database.exec('DROP TRIGGER draft_public_host_absence_verifications_insert_guard');
database.exec('DROP TRIGGER gallery_public_host_absence_receipts_insert_guard');
const epoch = insertCurrentEpoch();

const consentHost = insertHostReceipt(consent, epoch, {
    suffix: 'consent-withdrawal',
    expectedStateVersion: 7,
    withdrawalKind: 'consent-withdrawal'
});
confirmHostDeletion(consent.draftId);

const consentWithdrawal = finalizationOperation(consent, consentHost, {
    action: 'withdrawal',
    expectedStateVersion: 7
});

// A host receipt alone is deliberately insufficient. The new gate positively
// requires exactly one terminal review/abandonment source and both matching
// live cleanup rows plus their permanent tombstones.
assert.throws(
    () => insertFinalizationOperation(consentWithdrawal),
    /lacks exact current evidence/i,
    'Withdrawal must reject a draft with no terminal review source.'
);
insertTerminalReview(consent);
assert.throws(
    () => insertFinalizationOperation(consentWithdrawal),
    /lacks exact current evidence/i,
    'Terminal review evidence alone must not authorize withdrawal.'
);
insertApprovedCleanup(consent);
assert.throws(
    () => insertFinalizationOperation(consentWithdrawal),
    /lacks exact current evidence/i,
    'Approved-media cleanup alone must not authorize withdrawal.'
);
const consentProcessingCleanup = insertProcessingCleanup(consent);
assert.throws(
    () => insertFinalizationOperation(consentWithdrawal),
    /lacks exact current evidence/i,
    'A live processing cleanup without its tombstone must fail closed.'
);
insertProcessingCleanupTombstone(consentProcessingCleanup);
insertFinalizationOperation(consentWithdrawal);

assert.deepEqual(
    { ...readOperation(consentWithdrawal.operationId) },
    {
        action: 'withdrawal',
        status: 'reserved',
        completedAt: null,
        withdrawnAt: null,
        retentionEligibleAt: null
    }
);
assert.throws(
    () => database.prepare(
        "UPDATE draft_withdrawal_finalization_operations SET action = 'purge' " +
        'WHERE operation_id = ?'
    ).run(consentWithdrawal.operationId),
    /identity is immutable/i,
    'A withdrawal authorization must never become a purge authorization.'
);
assert.throws(
    () => insertFinalizationOperation({
        ...consentWithdrawal,
        operationId: operationId('second-consent-withdrawal'),
        operationIdHash: hash('second-consent-withdrawal-operation'),
        idempotencyKeyHash: hash('second-consent-withdrawal-idempotency'),
        payloadFingerprint: hash('second-consent-withdrawal-payload')
    }),
    /replacement is forbidden/i,
    'Each draft can have only one withdrawal action.'
);

const prematurePurge = finalizationOperation(consent, consentHost, {
    action: 'purge',
    expectedStateVersion: 8,
    withdrawalReceiptHash: hash('not-yet-created-withdrawal-receipt'),
    withdrawnAt: now(),
    retentionEligibleAt: now()
});
assert.throws(
    () => insertFinalizationOperation(prematurePurge),
    /lacks exact current evidence/i,
    'A separately named purge action cannot run before withdrawal completes.'
);

// Consent withdrawal additionally needs exact private-object deletion. A
// mutable scalar or a completion receipt cannot be asserted before the raw
// reservation and permanent deletion tombstone agree.
const consentReceipt = withdrawalReceipt(consent, consentHost, consentWithdrawal);
assert.throws(
    () => insertWithdrawalReceipt(consentReceipt),
    /lacks exact final evidence/i
);
assert.throws(
    () => database.prepare(
        'UPDATE draft_publication_references ' +
        'SET private_original_deletion_confirmed = 1 WHERE draft_id = ?'
    ).run(consent.draftId),
    /requires exact permanent proof/i
);

const deletion = privateDeletion(consent, consentWithdrawal);
assert.throws(
    () => insertPrivateDeletion({
        ...deletion,
        providerObjectVersion: `${deletion.providerObjectVersion}-wrong`
    }),
    /lacks exact reserved object evidence/i
);
insertPrivateDeletion(deletion);
database.prepare(`
    UPDATE draft_private_original_deletions
       SET status = 'absent', terminal_kind = 'deleted',
           final_head_absence_evidence_hash = ?,
           prefix_absence_evidence_hash = ?
     WHERE deletion_id = ?
`).run(
    deletion.finalHeadAbsenceEvidenceHash,
    deletion.prefixAbsenceEvidenceHash,
    deletion.deletionId
);
insertPrivateDeletionTombstone(deletion);
const deletionTombstone = database.prepare(`
    SELECT deletion_receipt_hash AS deletionReceiptHash,
           deleted_at AS deletedAt
      FROM gallery_private_original_deletion_tombstones
     WHERE deletion_id_hash = ?
`).get(deletion.deletionIdHash);
assert.ok(deletionTombstone.deletedAt);
assert.equal(database.prepare(`
    SELECT status, completed_at AS completedAt
      FROM draft_private_original_deletions WHERE deletion_id = ?
`).get(deletion.deletionId).completedAt, deletionTombstone.deletedAt);

database.prepare(`
    UPDATE draft_upload_sessions
       SET status = 'deleted', object_deleted_at = ?, updated_at = ?
     WHERE upload_session_id = ?
`).run(deletionTombstone.deletedAt, deletionTombstone.deletedAt, consent.uploadSessionId);
database.prepare(`
    UPDATE draft_publication_references
       SET private_original_deletion_confirmed = 1, updated_at = ?
     WHERE draft_id = ?
`).run(deletionTombstone.deletedAt, consent.draftId);
assert.throws(
    () => database.prepare(`
        UPDATE draft_publication_references
           SET private_original_deletion_confirmed = 0
         WHERE draft_id = ?
    `).run(consent.draftId),
    /requires exact permanent proof/i,
    'The private-deletion scalar must be impossible to downgrade from one to zero.'
);
database.prepare(`
    UPDATE draft_consent_attestations
       SET withdrawn_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE draft_id = ? AND consent_revision = ?
`).run(consent.draftId, consent.consentRevision);
assert.equal(database.prepare(
    'SELECT active_consent_revision AS revision FROM gallery_drafts WHERE draft_id = ?'
).get(consent.draftId).revision, null);

consentReceipt.privateDeletionReceiptHash = deletionTombstone.deletionReceiptHash;
insertWithdrawalReceipt(consentReceipt);
const consentStoredReceipt = readWithdrawalReceipt(consentReceipt.withdrawalReceiptHash);
assert.equal(consentStoredReceipt.retentionEligibleAt, consentStoredReceipt.withdrawnAt);
assert.deepEqual(
    { ...database.prepare(`
        SELECT state, state_version AS stateVersion, updated_at AS updatedAt
          FROM gallery_drafts WHERE draft_id = ?
    `).get(consent.draftId) },
    {
        state: 'withdrawn',
        stateVersion: 8,
        updatedAt: consentStoredReceipt.withdrawnAt
    }
);
assert.deepEqual(
    { ...readOperation(consentWithdrawal.operationId) },
    {
        action: 'withdrawal',
        status: 'completed',
        completedAt: consentStoredReceipt.withdrawnAt,
        withdrawnAt: consentStoredReceipt.withdrawnAt,
        retentionEligibleAt: consentStoredReceipt.withdrawnAt
    }
);
assert.throws(
    () => database.prepare(
        'UPDATE gallery_withdrawal_completion_receipts SET withdrawn_at = ? ' +
        'WHERE withdrawal_receipt_hash = ?'
    ).run('2000-01-01T00:00:00.000Z', consentReceipt.withdrawalReceiptHash),
    /append-only/i,
    'SQLite-owned withdrawal time must be immutable.'
);

// Editorial withdrawal retains the original for exactly thirty days. The
// deadline is generated from the database-owned withdrawal instant, and an
// early purge reservation is rejected even with otherwise matching evidence.
const editorialHost = insertHostReceipt(editorial, epoch, {
    suffix: 'editorial-withdrawal',
    expectedStateVersion: 7,
    withdrawalKind: 'editorial-removal'
});
confirmHostDeletion(editorial.draftId);
insertTerminalReview(editorial);
insertApprovedCleanup(editorial);
insertProcessingCleanupTombstone(insertProcessingCleanup(editorial));
const editorialWithdrawal = finalizationOperation(editorial, editorialHost, {
    action: 'withdrawal',
    expectedStateVersion: 7
});
insertFinalizationOperation(editorialWithdrawal);
const forgedEditorialReceipt = withdrawalReceipt(
    editorial,
    editorialHost,
    editorialWithdrawal
);
assert.throws(
    () => database.prepare(`
        INSERT INTO gallery_withdrawal_completion_receipts (
            withdrawal_receipt_hash, operation_id_hash, draft_id_hash,
            expected_state_version, result_state_version, withdrawal_kind,
            withdrawal_cycle_hash, public_host_verification_id_hash,
            public_host_final_receipt_hash, promotion_set_hash,
            cleanup_evidence_set_hash, target_set_hash, approved_origin_hash,
            media_delivery_epoch_id_hash, delivery_contract_hash,
            delivery_version_hash, generation_count, target_count,
            private_deletion_receipt_hash, idempotency_key_hash,
            payload_fingerprint, service_actor_identity_hash, withdrawn_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        ...withdrawalReceiptValues(forgedEditorialReceipt),
        '2000-01-01T00:00:00.000Z'
    ),
    /lacks exact final evidence/i,
    'Callers cannot backdate the SQL-owned withdrawal clock.'
);
insertWithdrawalReceipt(forgedEditorialReceipt);
const editorialStoredReceipt = readWithdrawalReceipt(
    forgedEditorialReceipt.withdrawalReceiptHash
);
const calculatedEditorialDeadline = database.prepare(
    "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+30 days') AS deadline"
).get(editorialStoredReceipt.withdrawnAt).deadline;
assert.equal(editorialStoredReceipt.retentionEligibleAt, calculatedEditorialDeadline);
assert.ok(
    database.prepare('SELECT julianday(?) > julianday(\'now\') AS future')
        .get(editorialStoredReceipt.retentionEligibleAt).future,
    'The synthetic editorial retention deadline should still be in the future.'
);
assert.throws(
    () => database.prepare(
        'UPDATE gallery_drafts SET updated_at = ? WHERE draft_id = ?'
    ).run('2000-01-01T00:00:00.000Z', editorial.draftId),
    /terminal gallery draft timestamp is immutable/i
);
const earlyEditorialPurge = finalizationOperation(editorial, editorialHost, {
    action: 'purge',
    expectedStateVersion: 8,
    withdrawalReceiptHash: forgedEditorialReceipt.withdrawalReceiptHash,
    withdrawnAt: editorialStoredReceipt.withdrawnAt,
    retentionEligibleAt: editorialStoredReceipt.retentionEligibleAt
});
assert.throws(
    () => insertFinalizationOperation(earlyEditorialPurge),
    /lacks exact current evidence/i,
    'Editorial purge authorization must remain unavailable until all thirty days pass.'
);

// Consent purge uses a distinct action, idempotency hash and payload. Reusing
// the withdrawal key is rejected, while the separately authorized purge can
// proceed immediately after exact retention approval.
const consentPurge = finalizationOperation(consent, consentHost, {
    action: 'purge',
    expectedStateVersion: 8,
    withdrawalReceiptHash: consentReceipt.withdrawalReceiptHash,
    withdrawnAt: consentStoredReceipt.withdrawnAt,
    retentionEligibleAt: consentStoredReceipt.retentionEligibleAt
});
assert.throws(
    () => insertFinalizationOperation({
        ...consentPurge,
        idempotencyKeyHash: consentWithdrawal.idempotencyKeyHash
    }),
    /replacement is forbidden/i,
    'The withdrawal idempotency key cannot authorize purge.'
);
insertFinalizationOperation(consentPurge);
assert.notEqual(consentPurge.operationIdHash, consentWithdrawal.operationIdHash);
assert.notEqual(consentPurge.idempotencyKeyHash, consentWithdrawal.idempotencyKeyHash);

const retentionEvidenceHash = hash('consent-retention-evidence');
assert.throws(
    () => database.prepare(`
        INSERT INTO gallery_retention_tombstones (
            draft_id, purge_kind, eligible_at, approved_at,
            approved_by_identity_hash, evidence_hash
        )
        SELECT ?, 'consent-withdrawal',
               strftime('%Y-%m-%dT%H:%M:%fZ', withdrawn_at, '-1 second'),
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?
          FROM gallery_withdrawal_completion_receipts
         WHERE withdrawal_receipt_hash = ?
    `).run(
        consent.draftId,
        actorHash,
        hash('forged-consent-retention-evidence'),
        consentReceipt.withdrawalReceiptHash
    ),
    /lacks an exact eligible cleanup path/i,
    'A forged retention instant must not be accepted.'
);
database.prepare(`
    INSERT INTO gallery_retention_tombstones (
        draft_id, purge_kind, eligible_at, approved_at,
        approved_by_identity_hash, evidence_hash
    )
    SELECT ?, 'consent-withdrawal', retention_eligible_at,
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?
      FROM gallery_withdrawal_completion_receipts
     WHERE withdrawal_receipt_hash = ?
`).run(
    consent.draftId,
    actorHash,
    retentionEvidenceHash,
    consentReceipt.withdrawalReceiptHash
);
assert.throws(
    () => database.prepare(
        'DELETE FROM gallery_retention_tombstones WHERE draft_id = ?'
    ).run(consent.draftId),
    /raw gallery retention evidence can leave only after guarded parent purge/i,
    'The raw retention row must remain immutable while its private parent exists.'
);

const purgeReceipt = {
    purgeReceiptHash: hash('consent-purge-receipt'),
    operationIdHash: consentPurge.operationIdHash,
    withdrawalOperationIdHash: consentWithdrawal.operationIdHash,
    withdrawalReceiptHash: consentReceipt.withdrawalReceiptHash,
    draftIdHash: consent.draftIdHash,
    expectedStateVersion: 8,
    withdrawalKind: 'consent-withdrawal',
    withdrawalCycleHash: consentHost.withdrawalCycleHash,
    publicHostVerificationIdHash: consentHost.verificationIdHash,
    publicHostFinalReceiptHash: consentHost.finalReceiptHash,
    privateDeletionReceiptHash: deletionTombstone.deletionReceiptHash,
    retentionEvidenceHash,
    idempotencyKeyHash: consentPurge.idempotencyKeyHash,
    payloadFingerprint: consentPurge.payloadFingerprint,
    serviceActorIdentityHash: actorHash,
    withdrawnAt: consentStoredReceipt.withdrawnAt,
    retentionEligibleAt: consentStoredReceipt.retentionEligibleAt
};

database.exec(`
    CREATE TRIGGER synthetic_downstream_purge_block
    BEFORE DELETE ON gallery_drafts
    WHEN OLD.draft_id = '${consent.draftId}'
    BEGIN
        SELECT RAISE(ABORT, 'synthetic downstream purge block');
    END;
`);
assert.throws(
    () => insertPurgeReceipt(purgeReceipt),
    /synthetic downstream purge block/i,
    'Any parent-delete failure must roll back the receipt and operation update.'
);
assert.equal(database.prepare(
    'SELECT COUNT(*) AS count FROM gallery_draft_purge_receipts ' +
    'WHERE purge_receipt_hash = ?'
).get(purgeReceipt.purgeReceiptHash).count, 0);
assert.equal(readOperation(consentPurge.operationId).status, 'reserved');
assert.equal(database.prepare(
    'SELECT COUNT(*) AS count FROM gallery_drafts WHERE draft_id = ?'
).get(consent.draftId).count, 1);
database.exec('DROP TRIGGER synthetic_downstream_purge_block');

insertPurgeReceipt(purgeReceipt);
assert.equal(database.prepare(
    'SELECT COUNT(*) AS count FROM gallery_drafts WHERE draft_id = ?'
).get(consent.draftId).count, 0);
assert.equal(database.prepare(
    'SELECT COUNT(*) AS count FROM draft_withdrawal_finalization_operations ' +
    'WHERE draft_id_hash = ?'
).get(consent.draftIdHash).count, 0);
assert.equal(database.prepare(
    'SELECT COUNT(*) AS count FROM draft_private_original_deletions ' +
    'WHERE draft_id_hash = ?'
).get(consent.draftIdHash).count, 0);
assert.equal(database.prepare(
    'SELECT COUNT(*) AS count FROM gallery_retention_tombstones WHERE draft_id = ?'
).get(consent.draftId).count, 0,
'The raw retention authorization must leave in the atomic parent-purge transaction.');

for (const table of database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
`).all().map(row => row.name)) {
    assert.ok(/^[a-z0-9_]+$/.test(table));
    const serialized = JSON.stringify(database.prepare(`SELECT * FROM ${table}`).all());
    assert.ok(
        !serialized.includes(consent.draftId),
        `${table} retained the raw purged draft ID`
    );
}

for (const [table, keyColumn, key] of [
    [
        'gallery_withdrawal_completion_receipts',
        'withdrawal_receipt_hash',
        consentReceipt.withdrawalReceiptHash
    ],
    [
        'gallery_private_original_deletion_tombstones',
        'deletion_receipt_hash',
        deletionTombstone.deletionReceiptHash
    ],
    ['gallery_draft_purge_receipts', 'purge_receipt_hash', purgeReceipt.purgeReceiptHash]
]) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all()
        .map(column => column.name);
    for (const forbiddenRawColumn of [
        'draft_id', 'operation_id', 'upload_session_id', 'private_object_key',
        'provider_object_version', 'provider_etag'
    ]) {
        assert.ok(!columns.includes(forbiddenRawColumn), `${table}.${forbiddenRawColumn}`);
    }
    const survivor = database.prepare(
        `SELECT * FROM ${table} WHERE ${keyColumn} = ?`
    ).get(key);
    assert.ok(survivor, `${table} must survive parent purge`);
    const serialized = JSON.stringify(survivor);
    for (const rawSecret of [
        consent.draftId,
        consentWithdrawal.operationId,
        consentPurge.operationId,
        consent.uploadSessionId,
        consent.originalObjectKey,
        consent.originalObjectVersion,
        consent.originalEtag
    ]) {
        assert.ok(!serialized.includes(rawSecret), `${table} leaked ${rawSecret}`);
    }
}

// Both pre-existing terminal branches remain available, but accept only an
// exact SQL-clock approval after a real thirty-day delay and a current
// retention-purpose host receipt.
for (const historical of historicalFixtures) {
    const historicalRetentionEvidenceHash = hash(
        `historical-retention-evidence:${historical.state}`
    );
    assert.throws(
        () => database.prepare(`
            INSERT INTO gallery_retention_tombstones (
                draft_id, purge_kind, eligible_at, approved_at,
                approved_by_identity_hash, evidence_hash
            ) VALUES (?, 'retention-expiry', ?,
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?)
        `).run(
            historical.draftId,
            '2026-07-30T00:00:00.000Z',
            actorHash,
            hash(`forged-historical-retention:${historical.state}`)
        ),
        /lacks an exact eligible cleanup path/i,
        `${historical.state} cannot use a backdated eligibility instant.`
    );
    database.prepare(`
        INSERT INTO gallery_retention_tombstones (
            draft_id, purge_kind, eligible_at, approved_at,
            approved_by_identity_hash, evidence_hash
        )
        SELECT draft_id, 'retention-expiry',
               strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+30 days'),
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?
          FROM gallery_drafts WHERE draft_id = ?
    `).run(actorHash, historicalRetentionEvidenceHash, historical.draftId);
    const historicalHost = insertHostReceipt(historical, epoch, {
        suffix: `historical-retention-${historical.state}`,
        expectedStateVersion: 4,
        verificationPurpose: 'retention-expiry',
        purposeEvidenceHash: historicalRetentionEvidenceHash,
        withdrawalKind: 'retention-expiry',
        generationCount: 0,
        targetCount: 0
    });
    assert.equal(database.prepare(`
        SELECT COUNT(*) AS count
          FROM gallery_current_public_host_absence_receipts
         WHERE draft_id = ? AND verification_purpose = 'retention-expiry'
    `).get(historical.draftId).count, 1);
    database.prepare('DELETE FROM gallery_drafts WHERE draft_id = ?')
        .run(historical.draftId);
    assert.equal(database.prepare(
        'SELECT COUNT(*) AS count FROM gallery_drafts WHERE draft_id = ?'
    ).get(historical.draftId).count, 0);
    assert.equal(database.prepare(
        'SELECT COUNT(*) AS count FROM gallery_retention_tombstones WHERE draft_id = ?'
    ).get(historical.draftId).count, 0,
    `The ${historical.state} purge must remove its raw retention authorization.`);
    assert.equal(database.prepare(
        'SELECT COUNT(*) AS count FROM gallery_public_host_absence_receipts ' +
        'WHERE final_receipt_hash = ?'
    ).get(historicalHost.finalReceiptHash).count, 1);
}

assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
database.close();

console.log(
    'Gallery withdrawal finalization migration: separate withdrawal/purge actions, ' +
    'positive terminal-review cleanup proof, consent deletion, SQL-owned immutable ' +
    'retention clocks, pre-migration orphan cleanup, atomic purge rollback, hash-only ' +
    'survivors, and rejected/processing-failed retention-expiry purge passed.'
);

function seedPhotoDraft(label, ordinal, withdrawalKind) {
    const rawUuid = uuid(`draft:${label}`);
    const draftId = `draft_${rawUuid}`;
    const draftIdHash = hash(`draft:${draftId}`);
    const uploadSessionId = `upload_${identifierHex(`upload:${label}`)}`;
    const processingRunId = `run_${identifierHex(`run:${label}`)}`;
    const promotionId = `promotion_${identifierHex(`promotion:${label}`)}`;
    const reviewId = `review_${identifierHex(`review:${label}`)}`;
    const consentRevision = `consent-finalizer-${label}`;
    const timestamp = `2026-09-02T1${ordinal}:00:00.000Z`;
    const originalSha256 = hash(`original-bytes:${label}`);
    const originalObjectVersion = `private-object-version-${label}`;
    const originalEtag = `private-object-etag-${label}`;
    const originalObjectKey =
        `private-originals/v1/family/2026/09/${draftId}/${uploadSessionId}/original.jpg`;
    const candidatePayloadHash = hash(`candidate-payload:${label}`);
    const generationFingerprint = hash(`generation:${label}`);
    const generationTargetSetHash = hash(`generation-target-set:${label}`);

    database.prepare(`
        INSERT INTO gallery_drafts (
            draft_id, public_item_id, site_modes_json, export_bundle_id,
            source_revision, suppression_revision, item_revision, media_type,
            race_date, race_event, race_distance, athlete_ids_json, title,
            caption, alt_text, featured, verified_owner_identity_hash,
            created_at, updated_at
        ) VALUES (?, ?, '["family"]', 'bundle-finalizer', 'source-finalizer',
            'suppression-finalizer', 'item-finalizer', 'photo', '2026-09-02',
            'Synthetic race', '5 km', '[]', 'Synthetic finalizer photo',
            'Generated test data only.', 'Generated test image.', 0, ?, ?, ?)
    `).run(
        draftId,
        `finalizer-${label}`,
        actorHash,
        timestamp,
        timestamp
    );
    database.prepare(`
        INSERT INTO draft_consent_attestations (
            draft_id, consent_revision, public_use_confirmed, contains_minors,
            guardian_approval_confirmed, private_evidence_reference,
            verified_owner_identity_hash, attested_at
        ) VALUES (?, ?, 1, 0, 0, ?, ?, ?)
    `).run(
        draftId,
        consentRevision,
        `synthetic-private-consent-${label}`,
        actorHash,
        timestamp
    );
    database.prepare(`
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
            completed_at, declared_sha256, real_photo_intake_confirmed
        ) VALUES (?, ?, 'item-finalizer', ?, 'bundle-finalizer',
            'source-finalizer', 'suppression-finalizer', ?, ?, 'jpg',
            'image/jpeg', 1024, 5242880, 1, 2, 1024, 'jpeg', 'complete',
            ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
        uploadSessionId,
        draftId,
        consentRevision,
        `provider-upload-${label}`,
        originalObjectKey,
        originalObjectVersion,
        originalEtag,
        originalSha256,
        actorHash,
        `finalizer-init-${label}-0001`,
        hash(`init-payload:${label}`),
        `finalizer-complete-${label}-0001`,
        hash(`complete-payload:${label}`),
        timestamp,
        timestamp,
        timestamp,
        '2026-10-02T00:00:00.000Z',
        timestamp,
        originalSha256
    );
    database.prepare(`
        UPDATE gallery_drafts
           SET active_consent_revision = ?, state = 'withdrawal-pending',
               state_version = 7, upload_complete = 1,
               original_object_key = ?, original_detected_type = 'jpeg',
               original_byte_count = 1024, original_sha256 = ?, updated_at = ?
         WHERE draft_id = ?
    `).run(consentRevision, originalObjectKey, originalSha256, timestamp, draftId);
    database.prepare(`
        INSERT INTO draft_transition_receipts (
            draft_id, idempotency_key, payload_fingerprint, from_state,
            to_state, expected_state_version, result_state_version, created_at
        ) VALUES (?, ?, ?, 'candidate-public', 'withdrawal-pending', 6, 7, ?)
    `).run(
        draftId,
        `candidate-withdrawal-${label}-0001`,
        hash(`candidate-withdrawal:${label}`),
        timestamp
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
            result_toolchain_json, created_at, updated_at, completed_at
        ) VALUES (?, ?, 'family', 'photo', 'item-finalizer', ?,
            'bundle-finalizer', 'source-finalizer', 'suppression-finalizer',
            ?, ?, 'jpeg', 'image/jpeg', 1024, ?, ?, ?, 3, 4, ?, ?, ?,
            'staged', ?, ?,
            '{"sharp":"0.35.2","libvips":"8.18.3","webp":"1.6.0","png":"1.6.58","exiftool":"13.40","videoEnabled":false}',
            ?, ?, ?)
    `).run(
        processingRunId,
        draftId,
        consentRevision,
        uploadSessionId,
        originalObjectKey,
        originalSha256,
        originalObjectVersion,
        originalEtag,
        `processing-start-${label}-0001`,
        hash(`processing-start-payload:${label}`),
        actorHash,
        `processing-result-${label}-0001`,
        hash(`processing-result-payload:${label}`),
        timestamp,
        timestamp,
        timestamp
    );
    database.prepare(`
        INSERT INTO draft_photo_promotions (
            promotion_id, processing_run_id, draft_id, site_mode,
            item_revision, consent_revision, export_bundle_id, source_revision,
            suppression_revision, expected_state_version, result_state_version,
            idempotency_key, idempotency_key_hash, payload_fingerprint,
            service_actor_identity_hash, status, candidate_payload_hash,
            created_at, updated_at, candidate_at
        ) VALUES (?, ?, ?, 'family', 'item-finalizer', ?, 'bundle-finalizer',
            'source-finalizer', 'suppression-finalizer', 5, 6, ?, ?, ?, ?,
            'candidate', ?, ?, ?, ?)
    `).run(
        promotionId,
        processingRunId,
        draftId,
        consentRevision,
        `promotion-${label}-0001`,
        hash(`promotion-idempotency:${label}`),
        hash(`promotion-payload:${label}`),
        actorHash,
        candidatePayloadHash,
        timestamp,
        timestamp,
        timestamp
    );
    database.prepare(`
        INSERT INTO draft_photo_public_generations (
            promotion_id, promotion_id_hash, draft_id, draft_id_hash,
            approved_origin, approved_origin_hash, candidate_state_version,
            generation_fingerprint, target_set_hash, created_at
        ) VALUES (?, ?, ?, ?, 'https://media.synthetic.example', ?, 6, ?, ?, ?)
    `).run(
        promotionId,
        hash(`promotion:${promotionId}`),
        draftId,
        draftIdHash,
        hash('approved-origin:https://media.synthetic.example'),
        generationFingerprint,
        generationTargetSetHash,
        timestamp
    );
    for (const [role, fileName] of [
        ['photo-display', 'display.webp'],
        ['photo-thumbnail', 'thumbnail.webp']
    ]) {
        const sha256 = hash(`${label}:${role}:bytes`);
        const approvedObjectKey = `media/v1/${sha256}/${fileName}`;
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
            hash(`approved-key:${approvedObjectKey}`),
            hash(`public-url:https://media.synthetic.example/${approvedObjectKey}`),
            sha256,
            generationTargetSetHash,
            timestamp
        );
    }
    database.prepare(`
        INSERT INTO draft_publication_references (
            draft_id, host_deletion_confirmed,
            private_original_deletion_confirmed, withdrawal_kind, updated_at
        ) VALUES (?, 0, 0, ?, ?)
    `).run(draftId, withdrawalKind, timestamp);

    return {
        label,
        draftId,
        draftIdHash,
        uploadSessionId,
        processingRunId,
        promotionId,
        reviewId,
        consentRevision,
        timestamp,
        originalObjectKey,
        originalObjectVersion,
        originalEtag,
        originalSha256,
        candidatePayloadHash,
        generationFingerprint,
        generationTargetSetHash,
        withdrawalKind
    };
}

function seedHistoricalRetentionDraft(state) {
    assert.ok(['rejected', 'processing-failed'].includes(state));
    const draftId = `draft_${uuid(`draft:historical-retention:${state}`)}`;
    const updatedAt = '2026-07-01T00:00:00.000Z';
    database.prepare(`
        INSERT INTO gallery_drafts (
            draft_id, public_item_id, site_modes_json, export_bundle_id,
            source_revision, suppression_revision, item_revision, media_type,
            race_date, race_event, race_distance, athlete_ids_json, title,
            caption, alt_text, featured, verified_owner_identity_hash,
            created_at, updated_at
        ) VALUES (?, ?, '["family"]', 'bundle-finalizer',
            'source-finalizer', 'suppression-finalizer', 'item-finalizer',
            'photo', '2026-07-01', 'Synthetic race', '5 km', '[]',
            'Synthetic historical draft', 'Generated test data only.',
            'Generated test image.', 0, ?, ?, ?)
    `).run(
        draftId,
        `historical-retention-${state}`,
        actorHash,
        updatedAt,
        updatedAt
    );
    database.prepare(`
        UPDATE gallery_drafts
           SET state = ?, state_version = 4, updated_at = ?
         WHERE draft_id = ?
    `).run(state, updatedAt, draftId);
    database.prepare(`
        INSERT INTO draft_publication_references (
            draft_id, host_deletion_confirmed,
            private_original_deletion_confirmed, withdrawal_kind, updated_at
        ) VALUES (?, 0, 1, NULL, ?)
    `).run(draftId, updatedAt);
    return {
        label: `historical-${state}`,
        state,
        draftId,
        draftIdHash: hash(`draft:${draftId}`),
        updatedAt
    };
}

function insertTerminalReview(fixture) {
    const terminalAt = '2026-09-02T15:00:00.000Z';
    database.prepare(`
        INSERT INTO draft_photo_review_receipts (
            review_id, draft_id, promotion_id, processing_run_id,
            candidate_state_version, candidate_payload_hash,
            generation_fingerprint, repository, base_ref, base_sha,
            branch_ref, target_relative_path, item_id, manifest_sha256,
            operation_marker_hash, workflow_run_reference, status,
            reservation_idempotency_key, reservation_idempotency_key_hash,
            reservation_payload_fingerprint, service_actor_identity_hash,
            terminal_kind, terminal_evidence_hash, terminal_idempotency_key,
            terminal_idempotency_key_hash, terminal_payload_fingerprint,
            created_at, updated_at, terminal_at
        ) VALUES (?, ?, ?, ?, 6, ?, ?, 'johnkevan88888/family-running',
            'main', ?, ?, 'gallery-data/family.json', ?, ?, ?, ?, 'terminal',
            ?, ?, ?, ?, 'no-pr-created', ?, ?, ?, ?, ?, ?, ?)
    `).run(
        fixture.reviewId,
        fixture.draftId,
        fixture.promotionId,
        fixture.processingRunId,
        fixture.candidatePayloadHash,
        fixture.generationFingerprint,
        hash(`base-sha:${fixture.label}`).slice(0, 40),
        `gallery-media/candidate-${identifierHex(`branch:${fixture.label}`)}`,
        `finalizer-${fixture.label}`,
        `sha256:${hash(`manifest:${fixture.label}`)}`,
        hash(`review-operation-marker:${fixture.label}`),
        `workflow-run-${fixture.label}`,
        `review-reserve-${fixture.label}-0001`,
        hash(`review-reserve-idempotency:${fixture.label}`),
        hash(`review-reserve-payload:${fixture.label}`),
        actorHash,
        hash(`review-terminal-evidence:${fixture.label}`),
        `review-terminal-${fixture.label}-0001`,
        hash(`review-terminal-idempotency:${fixture.label}`),
        hash(`review-terminal-payload:${fixture.label}`),
        fixture.timestamp,
        terminalAt,
        terminalAt
    );
}

function insertApprovedCleanup(fixture) {
    const cleanupId = `pcleanup_${identifierHex(`approved-cleanup:${fixture.label}`)}`;
    const cleanup = {
        cleanupId,
        cleanupIdHash: hash(`cleanup-id:${cleanupId}`),
        promotionIdHash: hash(`promotion:${fixture.promotionId}`),
        processingRunIdHash: hash(`run:${fixture.processingRunId}`),
        draftIdHash: fixture.draftIdHash,
        sourceIdempotencyKey: `promotion-source-${fixture.label}-0001`,
        sourceIdempotencyKeyHash: hash(`promotion-source-key:${fixture.label}`),
        sourcePayloadFingerprint: hash(`promotion-source-payload:${fixture.label}`),
        cleanupIdempotencyKey: `promotion-cleanup-${fixture.label}-0001`,
        cleanupIdempotencyKeyHash: hash(`promotion-cleanup-key:${fixture.label}`),
        payloadFingerprint: hash(`promotion-cleanup-payload:${fixture.label}`),
        evidenceHash: hash(`promotion-cleanup-evidence:${fixture.label}`),
        completedAt: '2026-09-02T15:01:00.000Z'
    };
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'withdrawal', ?, 'candidate',
            ?, ?, ?, 7, 2, ?, ?, ?, ?, 'cleaned', ?, ?, ?, ?)
    `).run(
        cleanup.cleanupId,
        cleanup.cleanupIdHash,
        fixture.promotionId,
        cleanup.promotionIdHash,
        fixture.processingRunId,
        cleanup.processingRunIdHash,
        fixture.draftId,
        cleanup.draftIdHash,
        fixture.withdrawalKind,
        cleanup.sourceIdempotencyKey,
        cleanup.sourceIdempotencyKeyHash,
        cleanup.sourcePayloadFingerprint,
        cleanup.cleanupIdempotencyKey,
        cleanup.cleanupIdempotencyKeyHash,
        cleanup.payloadFingerprint,
        actorHash,
        cleanup.evidenceHash,
        cleanup.completedAt,
        cleanup.completedAt,
        cleanup.completedAt
    );
    database.prepare(`
        INSERT INTO gallery_photo_promotion_cleanup_tombstones (
            cleanup_id_hash, promotion_id_hash, processing_run_id_hash,
            draft_id_hash, source_promotion_idempotency_key_hash,
            source_promotion_payload_fingerprint, cleanup_idempotency_key_hash,
            cleanup_payload_fingerprint, cleanup_reason, withdrawal_kind,
            evidence_hash, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'withdrawal', ?, ?, ?)
    `).run(
        cleanup.cleanupIdHash,
        cleanup.promotionIdHash,
        cleanup.processingRunIdHash,
        cleanup.draftIdHash,
        cleanup.sourceIdempotencyKeyHash,
        cleanup.sourcePayloadFingerprint,
        cleanup.cleanupIdempotencyKeyHash,
        cleanup.payloadFingerprint,
        fixture.withdrawalKind,
        cleanup.evidenceHash,
        cleanup.completedAt
    );
    database.prepare(
        'DELETE FROM draft_photo_promotions WHERE promotion_id = ?'
    ).run(fixture.promotionId);
}

function insertProcessingCleanup(fixture) {
    const cleanupId = `cleanup_${identifierHex(`processing-cleanup:${fixture.label}`)}`;
    const cleanup = {
        cleanupId,
        cleanupIdHash: hash(`cleanup-id:${cleanupId}`),
        processingRunIdHash: hash(`run:${fixture.processingRunId}`),
        draftIdHash: fixture.draftIdHash,
        cleanupReason: fixture.withdrawalKind === 'athlete-exclusion'
            ? 'athlete-exclusion'
            : 'withdrawal',
        evidenceHash: hash(`processing-cleanup-evidence:${fixture.label}`),
        completedAt: '2026-09-02T15:02:00.000Z'
    };
    database.prepare(`
        INSERT INTO draft_processing_cleanups (
            cleanup_id, cleanup_id_hash, processing_run_id,
            processing_run_id_hash, draft_id, draft_id_hash, cleanup_reason,
            expected_state_version, output_count, idempotency_key,
            payload_fingerprint, service_actor_identity_hash, status,
            cleanup_evidence_hash, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 7, 2, ?, ?, ?, 'cleaned', ?, ?, ?, ?)
    `).run(
        cleanup.cleanupId,
        cleanup.cleanupIdHash,
        fixture.processingRunId,
        cleanup.processingRunIdHash,
        fixture.draftId,
        cleanup.draftIdHash,
        cleanup.cleanupReason,
        `processing-cleanup-${fixture.label}-0001`,
        hash(`processing-cleanup-payload:${fixture.label}`),
        actorHash,
        cleanup.evidenceHash,
        cleanup.completedAt,
        cleanup.completedAt,
        cleanup.completedAt
    );
    return cleanup;
}

function insertProcessingCleanupTombstone(cleanup) {
    database.prepare(`
        INSERT INTO gallery_processing_cleanup_tombstones (
            cleanup_id_hash, draft_id_hash, processing_run_id_hash,
            cleanup_reason, evidence_hash, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
        cleanup.cleanupIdHash,
        cleanup.draftIdHash,
        cleanup.processingRunIdHash,
        cleanup.cleanupReason,
        cleanup.evidenceHash,
        cleanup.completedAt
    );
}

function insertCurrentEpoch() {
    const epoch = {
        epochId: 'media_delivery_epoch_finalizer',
        epochIdHash: hash('epoch:finalizer'),
        sequence: 1,
        origin: 'https://media.synthetic.example',
        originHash: hash('approved-origin:https://media.synthetic.example'),
        contractHash: hash('delivery-contract:finalizer'),
        versionHash: hash('delivery-version:finalizer'),
        witnessKeyHash: hash('witness-key:finalizer'),
        witnessSha256: hash('witness-bytes:finalizer'),
        configurationHash: hash('delivery-configuration:finalizer'),
        activationReceiptHash: hash('epoch-activation:finalizer'),
        registeredAt: '2026-09-02T15:03:00.000Z',
        activatedAt: '2026-09-02T15:03:01.000Z'
    };
    database.prepare(`
        INSERT INTO gallery_media_delivery_epochs (
            epoch_id, epoch_id_hash, epoch_sequence, approved_origin,
            approved_origin_hash, delivery_contract_hash, delivery_version_hash,
            witness_object_key_hash, witness_sha256, witness_byte_count,
            witness_content_type, configuration_hash,
            registered_by_identity_hash, registered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 44, 'image/webp', ?, ?, ?)
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
        epoch.configurationHash,
        actorHash,
        epoch.registeredAt
    );
    database.prepare(`
        INSERT INTO gallery_media_delivery_epoch_activations (
            activation_receipt_hash, epoch_id_hash, epoch_sequence,
            previous_epoch_id_hash, activation_idempotency_key_hash,
            activation_payload_hash, service_actor_identity_hash, activated_at
        ) VALUES (?, ?, 1, NULL, ?, ?, ?, ?)
    `).run(
        epoch.activationReceiptHash,
        epoch.epochIdHash,
        hash('epoch-activation-idempotency:finalizer'),
        hash('epoch-activation-payload:finalizer'),
        actorHash,
        epoch.activatedAt
    );
    database.prepare(`
        INSERT INTO gallery_media_delivery_current_epoch (
            singleton_id, epoch_id_hash, epoch_sequence,
            activation_receipt_hash, activated_at
        ) VALUES (1, ?, 1, ?, ?)
    `).run(epoch.epochIdHash, epoch.activationReceiptHash, epoch.activatedAt);
    return epoch;
}

function insertHostReceipt(fixture, epoch, options) {
    const verificationPurpose = options.verificationPurpose || 'withdrawal';
    const purposeEvidenceHash = options.purposeEvidenceHash || null;
    const generationCount = options.generationCount ?? 1;
    const targetCount = options.targetCount ?? 2;
    const verificationId =
        `hostverify_${identifierHex(`host-verification:${options.suffix}`)}`;
    const host = {
        verificationId,
        verificationIdHash: hash(`verification:${verificationId}`),
        finalReceiptHash: hash(`host-final-receipt:${options.suffix}`),
        withdrawalCycleHash: hash(`withdrawal-cycle:${options.suffix}`),
        promotionSetHash: generationCount === 0
            ? hash('')
            : hash(`promotion-set:${options.suffix}`),
        cleanupEvidenceSetHash: generationCount === 0
            ? hash('')
            : hash(`cleanup-set:${options.suffix}`),
        targetSetHash: generationCount === 0
            ? hash('')
            : fixture.generationTargetSetHash,
        idempotencyKey: `host-absence-${options.suffix}-0001`,
        idempotencyKeyHash: hash(`host-idempotency:${options.suffix}`),
        payloadFingerprint: hash(`host-payload:${options.suffix}`),
        expectedStateVersion: options.expectedStateVersion,
        withdrawalKind: options.withdrawalKind,
        verificationPurpose,
        purposeEvidenceHash,
        generationCount,
        targetCount,
        ...epoch
    };
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
        host.verificationId,
        host.verificationIdHash,
        fixture.draftId,
        fixture.draftIdHash,
        host.expectedStateVersion,
        host.verificationPurpose,
        host.purposeEvidenceHash,
        host.withdrawalKind,
        host.withdrawalCycleHash,
        host.promotionSetHash,
        host.cleanupEvidenceSetHash,
        host.originHash,
        host.targetSetHash,
        host.generationCount,
        host.generationCount * 2,
        host.targetCount,
        host.epochIdHash,
        host.contractHash,
        host.versionHash,
        host.idempotencyKey,
        host.idempotencyKeyHash,
        host.payloadFingerprint,
        actorHash,
        now()
    );
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
        host.finalReceiptHash,
        host.verificationIdHash,
        fixture.draftIdHash,
        host.promotionSetHash,
        host.cleanupEvidenceSetHash,
        host.withdrawalCycleHash,
        host.originHash,
        host.targetSetHash,
        host.generationCount,
        host.targetCount,
        host.expectedStateVersion,
        host.verificationPurpose,
        host.purposeEvidenceHash,
        host.epochIdHash,
        host.contractHash,
        host.versionHash,
        host.idempotencyKeyHash,
        host.payloadFingerprint,
        now()
    );
    return host;
}

function confirmHostDeletion(draftId) {
    database.prepare(`
        UPDATE draft_publication_references
           SET host_deletion_confirmed = 1,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE draft_id = ?
    `).run(draftId);
}

function finalizationOperation(fixture, host, options) {
    const suffix = `${fixture.label}-${options.action}`;
    return {
        operationId: operationId(suffix),
        operationIdHash: hash(`finalization-operation:${suffix}`),
        draftId: fixture.draftId,
        draftIdHash: fixture.draftIdHash,
        action: options.action,
        expectedStateVersion: options.expectedStateVersion,
        withdrawalKind: fixture.withdrawalKind,
        withdrawalCycleHash: host.withdrawalCycleHash,
        publicHostVerificationIdHash: host.verificationIdHash,
        publicHostFinalReceiptHash: host.finalReceiptHash,
        withdrawalReceiptHash: options.withdrawalReceiptHash || null,
        idempotencyKeyHash: hash(`finalization-idempotency:${suffix}`),
        payloadFingerprint: hash(`finalization-payload:${suffix}`),
        serviceActorIdentityHash: actorHash,
        withdrawnAt: options.withdrawnAt || null,
        retentionEligibleAt: options.retentionEligibleAt || null
    };
}

function insertFinalizationOperation(operation) {
    database.prepare(`
        INSERT INTO draft_withdrawal_finalization_operations (
            operation_id, operation_id_hash, draft_id, draft_id_hash, action,
            expected_state_version, withdrawal_kind, withdrawal_cycle_hash,
            public_host_verification_id_hash, public_host_final_receipt_hash,
            withdrawal_receipt_hash, idempotency_key_hash,
            payload_fingerprint, service_actor_identity_hash, withdrawn_at,
            retention_eligible_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        operation.operationId,
        operation.operationIdHash,
        operation.draftId,
        operation.draftIdHash,
        operation.action,
        operation.expectedStateVersion,
        operation.withdrawalKind,
        operation.withdrawalCycleHash,
        operation.publicHostVerificationIdHash,
        operation.publicHostFinalReceiptHash,
        operation.withdrawalReceiptHash,
        operation.idempotencyKeyHash,
        operation.payloadFingerprint,
        operation.serviceActorIdentityHash,
        operation.withdrawnAt,
        operation.retentionEligibleAt
    );
}

function readOperation(operationIdValue) {
    return database.prepare(`
        SELECT action, status, completed_at AS completedAt,
               withdrawn_at AS withdrawnAt,
               retention_eligible_at AS retentionEligibleAt
          FROM draft_withdrawal_finalization_operations
         WHERE operation_id = ?
    `).get(operationIdValue);
}

function privateDeletion(fixture, operation) {
    const deletionId = `deletion_${identifierHex(`private-deletion:${fixture.label}`)}`;
    return {
        deletionId,
        deletionIdHash: hash(`deletion:${deletionId}`),
        deletionReceiptHash: hash(`deletion-receipt:${fixture.label}`),
        operationId: operation.operationId,
        operationIdHash: operation.operationIdHash,
        draftId: fixture.draftId,
        draftIdHash: fixture.draftIdHash,
        uploadSessionId: fixture.uploadSessionId,
        uploadSessionIdHash: hash(`upload:${fixture.uploadSessionId}`),
        privateObjectKey: fixture.originalObjectKey,
        privateObjectKeyHash: hash(`private-key:${fixture.originalObjectKey}`),
        providerObjectVersion: fixture.originalObjectVersion,
        providerObjectVersionHash: hash(`private-version:${fixture.originalObjectVersion}`),
        providerEtag: fixture.originalEtag,
        providerEtagHash: hash(`private-etag:${fixture.originalEtag}`),
        expectedByteCount: 1024,
        expectedSha256: fixture.originalSha256,
        reservationHeadEvidenceHash: hash(`reservation-head:${fixture.label}`),
        finalHeadAbsenceEvidenceHash: hash(`final-head:${fixture.label}`),
        prefixAbsenceEvidenceHash: hash(`prefix-empty:${fixture.label}`)
    };
}

function insertPrivateDeletion(deletion) {
    database.prepare(`
        INSERT INTO draft_private_original_deletions (
            deletion_id, deletion_id_hash, operation_id, operation_id_hash,
            draft_id, draft_id_hash, upload_session_id,
            upload_session_id_hash, private_object_key,
            private_object_key_hash, provider_object_version,
            provider_object_version_hash, provider_etag, provider_etag_hash,
            expected_byte_count, expected_sha256,
            reservation_head_evidence_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        deletion.deletionId,
        deletion.deletionIdHash,
        deletion.operationId,
        deletion.operationIdHash,
        deletion.draftId,
        deletion.draftIdHash,
        deletion.uploadSessionId,
        deletion.uploadSessionIdHash,
        deletion.privateObjectKey,
        deletion.privateObjectKeyHash,
        deletion.providerObjectVersion,
        deletion.providerObjectVersionHash,
        deletion.providerEtag,
        deletion.providerEtagHash,
        deletion.expectedByteCount,
        deletion.expectedSha256,
        deletion.reservationHeadEvidenceHash
    );
}

function insertPrivateDeletionTombstone(deletion) {
    database.prepare(`
        INSERT INTO gallery_private_original_deletion_tombstones (
            deletion_receipt_hash, deletion_id_hash, operation_id_hash,
            draft_id_hash, upload_session_id_hash, private_object_key_hash,
            provider_object_version_hash, provider_etag_hash,
            expected_byte_count, expected_sha256, terminal_kind,
            reservation_head_evidence_hash,
            final_head_absence_evidence_hash, prefix_absence_evidence_hash,
            service_actor_identity_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'deleted', ?, ?, ?, ?)
    `).run(
        deletion.deletionReceiptHash,
        deletion.deletionIdHash,
        deletion.operationIdHash,
        deletion.draftIdHash,
        deletion.uploadSessionIdHash,
        deletion.privateObjectKeyHash,
        deletion.providerObjectVersionHash,
        deletion.providerEtagHash,
        deletion.expectedByteCount,
        deletion.expectedSha256,
        deletion.reservationHeadEvidenceHash,
        deletion.finalHeadAbsenceEvidenceHash,
        deletion.prefixAbsenceEvidenceHash,
        actorHash
    );
}

function withdrawalReceipt(fixture, host, operation) {
    return {
        withdrawalReceiptHash: hash(`withdrawal-receipt:${fixture.label}`),
        operationIdHash: operation.operationIdHash,
        draftIdHash: fixture.draftIdHash,
        expectedStateVersion: operation.expectedStateVersion,
        resultStateVersion: operation.expectedStateVersion + 1,
        withdrawalKind: fixture.withdrawalKind,
        withdrawalCycleHash: host.withdrawalCycleHash,
        publicHostVerificationIdHash: host.verificationIdHash,
        publicHostFinalReceiptHash: host.finalReceiptHash,
        promotionSetHash: host.promotionSetHash,
        cleanupEvidenceSetHash: host.cleanupEvidenceSetHash,
        targetSetHash: host.targetSetHash,
        approvedOriginHash: host.originHash,
        mediaDeliveryEpochIdHash: host.epochIdHash,
        deliveryContractHash: host.contractHash,
        deliveryVersionHash: host.versionHash,
        generationCount: host.generationCount,
        targetCount: host.targetCount,
        privateDeletionReceiptHash: null,
        idempotencyKeyHash: operation.idempotencyKeyHash,
        payloadFingerprint: operation.payloadFingerprint,
        serviceActorIdentityHash: actorHash
    };
}

function withdrawalReceiptValues(receipt) {
    return [
        receipt.withdrawalReceiptHash,
        receipt.operationIdHash,
        receipt.draftIdHash,
        receipt.expectedStateVersion,
        receipt.resultStateVersion,
        receipt.withdrawalKind,
        receipt.withdrawalCycleHash,
        receipt.publicHostVerificationIdHash,
        receipt.publicHostFinalReceiptHash,
        receipt.promotionSetHash,
        receipt.cleanupEvidenceSetHash,
        receipt.targetSetHash,
        receipt.approvedOriginHash,
        receipt.mediaDeliveryEpochIdHash,
        receipt.deliveryContractHash,
        receipt.deliveryVersionHash,
        receipt.generationCount,
        receipt.targetCount,
        receipt.privateDeletionReceiptHash,
        receipt.idempotencyKeyHash,
        receipt.payloadFingerprint,
        receipt.serviceActorIdentityHash
    ];
}

function insertWithdrawalReceipt(receipt) {
    database.prepare(`
        INSERT INTO gallery_withdrawal_completion_receipts (
            withdrawal_receipt_hash, operation_id_hash, draft_id_hash,
            expected_state_version, result_state_version, withdrawal_kind,
            withdrawal_cycle_hash, public_host_verification_id_hash,
            public_host_final_receipt_hash, promotion_set_hash,
            cleanup_evidence_set_hash, target_set_hash, approved_origin_hash,
            media_delivery_epoch_id_hash, delivery_contract_hash,
            delivery_version_hash, generation_count, target_count,
            private_deletion_receipt_hash, idempotency_key_hash,
            payload_fingerprint, service_actor_identity_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...withdrawalReceiptValues(receipt));
}

function readWithdrawalReceipt(withdrawalReceiptHash) {
    return database.prepare(`
        SELECT withdrawn_at AS withdrawnAt,
               retention_eligible_at AS retentionEligibleAt
          FROM gallery_withdrawal_completion_receipts
         WHERE withdrawal_receipt_hash = ?
    `).get(withdrawalReceiptHash);
}

function insertPurgeReceipt(receipt) {
    database.prepare(`
        INSERT INTO gallery_draft_purge_receipts (
            purge_receipt_hash, operation_id_hash,
            withdrawal_operation_id_hash, withdrawal_receipt_hash,
            draft_id_hash, expected_state_version, withdrawal_kind,
            withdrawal_cycle_hash, public_host_verification_id_hash,
            public_host_final_receipt_hash, private_deletion_receipt_hash,
            retention_evidence_hash, idempotency_key_hash,
            payload_fingerprint, service_actor_identity_hash, withdrawn_at,
            retention_eligible_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        receipt.purgeReceiptHash,
        receipt.operationIdHash,
        receipt.withdrawalOperationIdHash,
        receipt.withdrawalReceiptHash,
        receipt.draftIdHash,
        receipt.expectedStateVersion,
        receipt.withdrawalKind,
        receipt.withdrawalCycleHash,
        receipt.publicHostVerificationIdHash,
        receipt.publicHostFinalReceiptHash,
        receipt.privateDeletionReceiptHash,
        receipt.retentionEvidenceHash,
        receipt.idempotencyKeyHash,
        receipt.payloadFingerprint,
        receipt.serviceActorIdentityHash,
        receipt.withdrawnAt,
        receipt.retentionEligibleAt
    );
}

function operationId(label) {
    return `finalize_${identifierHex(label)}`;
}

function uuid(label) {
    const value = identifierHex(label);
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-` +
        `${value.slice(16, 20)}-${value.slice(20)}`;
}

function identifierHex(label) {
    const characters = hash(label).slice(0, 32).split('');
    characters[12] = '4';
    characters[16] = '8';
    return characters.join('');
}

function hash(value) {
    return createHash('sha256').update(value).digest('hex');
}

function now() {
    return database.prepare(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS value"
    ).get().value;
}

function schemaCount(type, name) {
    return database.prepare(
        'SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = ? AND name = ?'
    ).get(type, name).count;
}
