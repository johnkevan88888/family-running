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
    '0011_photo_review_invalidation.sql'
];
const migrations = await Promise.all(migrationNames.map(name => readFile(
    new URL(`../gallery-admin/migrations/${name}`, import.meta.url),
    'utf8'
)));

const database = new DatabaseSync(':memory:');
for (const migration of migrations) database.exec(migration);

assert.equal(database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
assert.equal(schemaCount('table', 'draft_photo_review_receipts'), 1);
assert.equal(schemaCount('table', 'draft_photo_review_abandonment_receipts'), 1);
for (const trigger of [
    'draft_photo_review_receipts_no_replace_guard',
    'draft_photo_review_receipts_insert_guard',
    'draft_photo_review_receipts_identity_update_guard',
    'draft_photo_review_receipts_lifecycle_collision_guard',
    'draft_photo_review_receipts_transition_guard',
    'draft_photo_review_receipts_open_candidate_guard',
    'draft_photo_review_receipts_direct_delete_guard',
    'draft_photo_review_abandonment_receipts_no_replace_guard',
    'draft_photo_review_abandonment_receipts_insert_guard',
    'draft_photo_review_abandonment_receipts_no_update',
    'draft_photo_review_abandonment_receipts_direct_delete_guard',
    'gallery_drafts_photo_review_withdrawal_guard',
    'gallery_drafts_photo_review_cleanup_guard',
    'gallery_drafts_pr_open_unavailable_guard',
    'gallery_drafts_published_unavailable_guard'
]) {
    assert.equal(schemaCount('trigger', trigger), 1, trigger);
}

const columns = database.prepare(
    'PRAGMA table_info(draft_photo_review_receipts)'
).all().map(column => column.name);
for (const requiredColumn of [
    'review_id', 'draft_id', 'promotion_id', 'processing_run_id',
    'candidate_state_version',
    'candidate_payload_hash', 'generation_fingerprint', 'repository',
    'base_ref', 'base_sha', 'branch_ref', 'target_relative_path', 'item_id',
    'manifest_sha256', 'operation_marker_hash', 'workflow_run_reference',
    'status', 'reservation_idempotency_key',
    'reservation_idempotency_key_hash', 'reservation_payload_fingerprint',
    'service_actor_identity_hash', 'pull_request_number', 'pull_request_url',
    'head_sha', 'open_evidence_hash', 'open_idempotency_key',
    'open_idempotency_key_hash', 'open_payload_fingerprint', 'terminal_kind',
    'terminal_evidence_hash', 'close_evidence_hash', 'readback_evidence_hash',
    'terminal_idempotency_key', 'terminal_idempotency_key_hash',
    'terminal_payload_fingerprint', 'created_at', 'updated_at', 'opened_at',
    'terminal_at'
]) {
    assert.ok(columns.includes(requiredColumn), requiredColumn);
}
assert.ok(
    database.prepare('PRAGMA table_info(draft_photo_review_abandonment_receipts)')
        .all().some(column => column.name === 'processing_run_id')
);

// Earlier migrations already test how these parent records are produced. This
// fixture drops only their insert/state guards so this test can isolate 0011's
// real SQLite constraints without reimplementing the whole upload processor.
for (const trigger of [
    'gallery_drafts_state_version_guard',
    'gallery_drafts_transition_guard',
    'gallery_drafts_consent_state_gate_guard',
    'gallery_drafts_candidate_processing_guard',
    'draft_photo_promotions_insert_guard',
    'draft_photo_public_generations_insert_guard',
    'draft_photo_public_generation_targets_insert_guard'
]) {
    database.exec(`DROP TRIGGER ${trigger}`);
}

const actorHash = hash('synthetic-review-service-actor');
const first = seedCandidate('first', 1);
const firstReservation = reservation(first, 1);
insertReservation(firstReservation);

assert.throws(
    () => database.prepare(
        "UPDATE gallery_drafts SET state = 'pr-open', state_version = state_version + 1 " +
        'WHERE draft_id = ?'
    ).run(first.draftId),
    /pull request state is unavailable/i
);
assert.throws(
    () => database.prepare(
        "UPDATE gallery_drafts SET state = 'published', state_version = state_version + 1 " +
        'WHERE draft_id = ?'
    ).run(first.draftId),
    /published state is unavailable/i
);

const reserved = readReceipt(first.reviewId);
assert.equal(reserved.status, 'reserved');
assert.equal(reserved.draftId, first.draftId);
assert.equal(reserved.promotionId, first.promotionId);
assert.equal(reserved.pullRequestNumber, null);
assert.equal(reserved.terminalKind, null);

assert.throws(
    () => database.prepare(`
        INSERT OR REPLACE INTO draft_photo_review_receipts
        SELECT * FROM draft_photo_review_receipts WHERE review_id = ?
    `).run(first.reviewId),
    /replacement is forbidden/i
);
assert.throws(
    () => database.prepare(
        'UPDATE draft_photo_review_receipts SET manifest_sha256 = ? WHERE review_id = ?'
    ).run(`sha256:${hash('different-manifest')}`, first.reviewId),
    /identity is immutable/i
);
assert.throws(
    () => database.prepare(
        "DELETE FROM draft_photo_review_receipts WHERE review_id = ?"
    ).run(first.reviewId),
    /direct deletion is forbidden/i
);

// Isolate the new review gate from the older host-deletion withdrawal gate.
database.exec('DROP TRIGGER gallery_drafts_withdrawal_evidence_guard');
assert.throws(
    () => database.prepare(
        "UPDATE gallery_drafts SET state = 'withdrawn', state_version = state_version + 1 " +
        'WHERE draft_id = ?'
    ).run(first.draftId),
    /open or reserved photo review must be terminal/i
);

const openedAt = '2026-09-02T14:11:00.000Z';
database.prepare(`
    UPDATE draft_photo_review_receipts
    SET status = 'open', pull_request_number = 41,
        pull_request_url = 'https://github.com/johnkevan88888/family-running/pull/41',
        head_sha = ?, open_evidence_hash = ?, open_idempotency_key = ?,
        open_idempotency_key_hash = ?, open_payload_fingerprint = ?,
        updated_at = ?, opened_at = ?
    WHERE review_id = ?
`).run(
    'b'.repeat(40),
    hash('first-open-evidence'),
    'review-open-first-0001',
    hash('first-open-idempotency'),
    hash('first-open-payload'),
    openedAt,
    openedAt,
    first.reviewId
);
assert.equal(readReceipt(first.reviewId).status, 'open');
assert.throws(
    () => database.prepare(
        "UPDATE gallery_drafts SET state = 'withdrawn', state_version = state_version + 1 " +
        'WHERE draft_id = ?'
    ).run(first.draftId),
    /open or reserved photo review must be terminal/i
);
assert.throws(
    () => database.prepare(`
        UPDATE draft_photo_review_receipts
        SET status = 'terminal', terminal_kind = 'no-pr-created',
            terminal_evidence_hash = ?, terminal_idempotency_key = ?,
            terminal_idempotency_key_hash = ?, terminal_payload_fingerprint = ?,
            updated_at = ?, terminal_at = ?
        WHERE review_id = ?
    `).run(
        hash('wrong-terminal-evidence'),
        'review-terminal-wrong-0001',
        hash('wrong-terminal-idempotency'),
        hash('wrong-terminal-payload'),
        '2026-09-02T14:12:00.000Z',
        '2026-09-02T14:12:00.000Z',
        first.reviewId
    ),
    /invalid photo review receipt transition|CHECK constraint failed/i
);

const closedAt = '2026-09-02T14:13:00.000Z';
database.prepare(`
    UPDATE draft_photo_review_receipts
    SET status = 'terminal', terminal_kind = 'closed-unmerged',
        terminal_evidence_hash = ?, close_evidence_hash = ?,
        readback_evidence_hash = ?, terminal_idempotency_key = ?,
        terminal_idempotency_key_hash = ?, terminal_payload_fingerprint = ?,
        updated_at = ?, terminal_at = ?
    WHERE review_id = ?
`).run(
    hash('first-terminal-evidence'),
    hash('first-close-response'),
    hash('first-closed-readback'),
    'review-terminal-first-0001',
    hash('first-terminal-idempotency'),
    hash('first-terminal-payload'),
    closedAt,
    closedAt,
    first.reviewId
);
const closed = readReceipt(first.reviewId);
assert.equal(closed.status, 'terminal');
assert.equal(closed.terminalKind, 'closed-unmerged');
assert.equal(closed.pullRequestNumber, 41);
assert.ok(closed.closeEvidenceHash);
assert.ok(closed.readbackEvidenceHash);
assert.throws(
    () => database.prepare(
        'UPDATE draft_photo_review_receipts SET updated_at = ? WHERE review_id = ?'
    ).run('2026-09-02T14:14:00.000Z', first.reviewId),
    /invalid photo review receipt transition/i
);

// Terminal GitHub evidence alone must not let final withdrawal strand either
// approved media or private staging. The focused fixture injects already-
// completed cleanup rows only after proving each exact tombstone gate; the
// full 0005/0008 cleanup state machines have their own real-SQLite tests.
assert.throws(
    () => database.prepare(
        "UPDATE gallery_drafts SET state = 'withdrawn', state_version = state_version + 1 " +
        'WHERE draft_id = ?'
    ).run(first.draftId),
    /approved and staging cleanup tombstones are required/i
);
for (const trigger of [
    'draft_photo_promotion_cleanups_insert_guard',
    'draft_processing_cleanups_insert_guard',
    'draft_processing_cleanups_photo_promotion_guard'
]) database.exec(`DROP TRIGGER ${trigger}`);
insertCompletedApprovedCleanup(first, 7, 'first');
assert.throws(
    () => database.prepare(
        "UPDATE gallery_drafts SET state = 'withdrawn', state_version = state_version + 1 " +
        'WHERE draft_id = ?'
    ).run(first.draftId),
    /approved and staging cleanup tombstones are required/i
);
const firstProcessingCleanup = insertCompletedProcessingCleanup(
    first,
    7,
    'first'
);
assert.throws(
    () => database.prepare(
        "UPDATE gallery_drafts SET state = 'withdrawn', state_version = state_version + 1 " +
        'WHERE draft_id = ?'
    ).run(first.draftId),
    /approved and staging cleanup tombstones are required/i
);
insertProcessingCleanupTombstone(firstProcessingCleanup);
database.prepare(
    "UPDATE gallery_drafts SET state = 'withdrawn', state_version = state_version + 1 " +
    'WHERE draft_id = ?'
).run(first.draftId);
assert.equal(draftState(first.draftId), 'withdrawn');

const second = seedCandidate('second', 2);
const secondReservation = reservation(second, 2);
assert.throws(
    () => insertReservation({
        ...secondReservation,
        candidatePayloadHash: hash('wrong-candidate-payload')
    }),
    /lacks exact current candidate evidence/i
);
insertReservation(secondReservation);

assert.throws(
    () => database.prepare(`
        UPDATE draft_photo_review_receipts
        SET status = 'terminal', terminal_kind = 'closed-unmerged',
            terminal_evidence_hash = ?, close_evidence_hash = ?,
            readback_evidence_hash = ?, terminal_idempotency_key = ?,
            terminal_idempotency_key_hash = ?, terminal_payload_fingerprint = ?,
            updated_at = ?, terminal_at = ?
        WHERE review_id = ?
    `).run(
        hash('second-invalid-terminal'),
        hash('second-invalid-close'),
        hash('second-invalid-readback'),
        'review-terminal-invalid-0002',
        hash('second-invalid-terminal-key'),
        hash('second-invalid-terminal-payload'),
        '2026-09-02T14:21:00.000Z',
        '2026-09-02T14:21:00.000Z',
        second.reviewId
    ),
    /invalid photo review receipt transition|CHECK constraint failed/i
);

const noPrAt = '2026-09-02T14:22:00.000Z';
database.prepare(`
    UPDATE draft_photo_review_receipts
    SET status = 'terminal', terminal_kind = 'no-pr-created',
        terminal_evidence_hash = ?, terminal_idempotency_key = ?,
        terminal_idempotency_key_hash = ?, terminal_payload_fingerprint = ?,
        updated_at = ?, terminal_at = ?
    WHERE review_id = ?
`).run(
    hash('second-no-pr-evidence'),
    'review-terminal-second-0002',
    hash('second-terminal-idempotency'),
    hash('second-terminal-payload'),
    noPrAt,
    noPrAt,
    second.reviewId
);
const noPr = readReceipt(second.reviewId);
assert.equal(noPr.status, 'terminal');
assert.equal(noPr.terminalKind, 'no-pr-created');
assert.equal(noPr.pullRequestNumber, null);
assert.equal(noPr.closeEvidenceHash, null);
assert.equal(noPr.readbackEvidenceHash, null);

// A GitHub mutation may succeed even when the subsequent open-receipt write is
// lost. Preserve the discovered PR identity and its close/readback proof in a
// direct terminal receipt without claiming that an open receipt ever existed.
const recovered = seedCandidate('recovered', 3);
const recoveredReservation = reservation(recovered, 3);
assert.throws(
    () => insertReservation({
        ...recoveredReservation,
        branchRef: firstReservation.branchRef
    }),
    /replacement is forbidden/i
);
assert.throws(
    () => insertReservation({
        ...recoveredReservation,
        operationMarkerHash: firstReservation.operationMarkerHash
    }),
    /replacement is forbidden/i
);
insertReservation(recoveredReservation);
const recoveredAt = '2026-09-02T14:31:00.000Z';
assert.throws(
    () => database.prepare(`
        UPDATE draft_photo_review_receipts
        SET status = 'terminal', terminal_kind = 'closed-unmerged',
            pull_request_number = 42,
            pull_request_url = 'https://github.com/johnkevan88888/family-running/pull/42',
            head_sha = ?, terminal_evidence_hash = ?, close_evidence_hash = ?,
            terminal_idempotency_key = ?, terminal_idempotency_key_hash = ?,
            terminal_payload_fingerprint = ?, updated_at = ?, terminal_at = ?
        WHERE review_id = ?
    `).run(
        'c'.repeat(40),
        hash('recovered-incomplete-terminal-evidence'),
        hash('recovered-incomplete-close-response'),
        'review-terminal-incomplete-0003',
        hash('recovered-incomplete-terminal-idempotency'),
        hash('recovered-incomplete-terminal-payload'),
        recoveredAt,
        recoveredAt,
        recovered.reviewId
    ),
    /invalid photo review receipt transition|CHECK constraint failed/i,
    'A closed PR receipt must carry an independent closed-state readback.'
);
database.prepare(`
    UPDATE draft_photo_review_receipts
    SET status = 'terminal', terminal_kind = 'closed-unmerged',
        pull_request_number = 42,
        pull_request_url = 'https://github.com/johnkevan88888/family-running/pull/42',
        head_sha = ?, terminal_evidence_hash = ?, close_evidence_hash = ?,
        readback_evidence_hash = ?, terminal_idempotency_key = ?,
        terminal_idempotency_key_hash = ?, terminal_payload_fingerprint = ?,
        updated_at = ?, terminal_at = ?
    WHERE review_id = ?
`).run(
    'c'.repeat(40),
    hash('recovered-terminal-evidence'),
    hash('recovered-close-response'),
    hash('recovered-closed-readback'),
    'review-terminal-recovered-0003',
    hash('recovered-terminal-idempotency'),
    hash('recovered-terminal-payload'),
    recoveredAt,
    recoveredAt,
    recovered.reviewId
);
const recoveredClosed = readReceipt(recovered.reviewId);
assert.equal(recoveredClosed.status, 'terminal');
assert.equal(recoveredClosed.terminalKind, 'closed-unmerged');
assert.equal(recoveredClosed.pullRequestNumber, 42);
assert.equal(recoveredClosed.openEvidenceHash, null);
assert.equal(recoveredClosed.openedAt, null);
assert.ok(recoveredClosed.closeEvidenceHash);
assert.ok(recoveredClosed.readbackEvidenceHash);

const abandoned = seedCandidate('abandoned', 4);
const abandonment = {
    draftId: abandoned.draftId,
    promotionId: abandoned.promotionId,
    processingRunId: abandoned.processingRunId,
    expectedStateVersion: 6,
    resultStateVersion: 7,
    failureEvidenceHash: hash('abandoned-reservation-failure'),
    idempotencyKey: 'review-abandon-abandoned-0004',
    idempotencyKeyHash: hash('abandoned-idempotency'),
    payloadFingerprint: hash('abandoned-payload'),
    createdAt: '2026-09-02T14:41:00.000Z'
};
insertAbandonment(abandonment);
const storedAbandonment = readAbandonment(abandoned.draftId);
assert.equal(storedAbandonment.promotionId, abandoned.promotionId);
assert.equal(storedAbandonment.processingRunId, abandoned.processingRunId);
assert.equal(storedAbandonment.expectedStateVersion, 6);
assert.equal(storedAbandonment.resultStateVersion, 7);
assert.equal(storedAbandonment.failureEvidenceHash, abandonment.failureEvidenceHash);
assert.throws(
    () => insertReservation(reservation(abandoned, 4)),
    /lacks exact current candidate evidence/i,
    'An abandoned candidate must never acquire a later review reservation.'
);
assert.throws(
    () => database.prepare(`
        INSERT OR REPLACE INTO draft_photo_review_abandonment_receipts
        SELECT * FROM draft_photo_review_abandonment_receipts WHERE draft_id = ?
    `).run(abandoned.draftId),
    /replacement is forbidden/i
);
assert.throws(
    () => database.prepare(
        'UPDATE draft_photo_review_abandonment_receipts ' +
        'SET failure_evidence_hash = ? WHERE draft_id = ?'
    ).run(hash('changed-abandonment'), abandoned.draftId),
    /is immutable/i
);
assert.throws(
    () => database.prepare(
        'DELETE FROM draft_photo_review_abandonment_receipts WHERE draft_id = ?'
    ).run(abandoned.draftId),
    /direct deletion is forbidden/i
);
database.prepare(`
    UPDATE gallery_drafts
       SET state = 'withdrawal-pending', state_version = 7
     WHERE draft_id = ?
`).run(abandoned.draftId);
assert.throws(
    () => database.prepare(
        "UPDATE gallery_drafts SET state = 'withdrawn', state_version = state_version + 1 " +
        'WHERE draft_id = ?'
    ).run(abandoned.draftId),
    /approved and staging cleanup tombstones are required/i,
    'An abandonment receipt must retain the same final cleanup gate.'
);

// Direct receipt deletion is forbidden above, but its ON DELETE CASCADE must
// not strand the separately evidenced whole-draft purge. Drop only the older
// fixture's purge/evidence guards to model that prior authorization and prove
// the receipt disappears as a child of the deleted draft.
for (const trigger of [
    'gallery_drafts_purge_guard',
    'gallery_drafts_photo_promotion_purge_guard',
    'draft_photo_promotions_no_delete_guard',
    'draft_photo_public_generations_direct_delete_guard',
    'draft_photo_public_generation_targets_direct_delete_guard'
]) {
    database.exec(`DROP TRIGGER ${trigger}`);
}
database.prepare(
    'DELETE FROM draft_photo_promotions WHERE promotion_id = ?'
).run(abandoned.promotionId);
assert.ok(
    readAbandonment(abandoned.draftId),
    'Promotion cleanup must not erase the durable abandonment receipt.'
);
database.prepare('DELETE FROM gallery_drafts WHERE draft_id = ?').run(recovered.draftId);
assert.equal(readReceipt(recovered.reviewId), undefined);
database.prepare('DELETE FROM gallery_drafts WHERE draft_id = ?').run(abandoned.draftId);
assert.equal(readAbandonment(abandoned.draftId), undefined);

assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
database.close();

console.log(
    'Gallery photo review migration: exact reservation, immutable identity, ' +
    'open/readback closure, lost-open recovery, no-PR terminal receipt, ' +
    'pre-reservation abandonment, collision guards, withdrawal blocking, and ' +
    'parent-purge cascade passed.'
);

function insertCompletedApprovedCleanup(candidate, expectedStateVersion, label) {
    const cleanupId = `pcleanup_${identifierHex(`approved:${label}`)}`;
    const cleanup = {
        cleanupId,
        cleanupIdHash: hash(`cleanup-id:${cleanupId}`),
        promotionIdHash: hash(`promotion:${candidate.promotionId}`),
        processingRunIdHash: hash(`run:${candidate.processingRunId}`),
        draftIdHash: hash(`draft:${candidate.draftId}`),
        sourceIdempotencyKey: `promotion-source-${label}-0001`,
        sourceIdempotencyKeyHash: hash(`promotion-source-key:${label}`),
        sourcePayloadFingerprint: hash(`promotion-source-payload:${label}`),
        cleanupIdempotencyKey: `promotion-cleanup-${label}-0001`,
        cleanupIdempotencyKeyHash: hash(`promotion-cleanup-key:${label}`),
        payloadFingerprint: hash(`promotion-cleanup-payload:${label}`),
        evidenceHash: hash(`promotion-cleanup-evidence:${label}`),
        createdAt: '2026-09-02T14:13:30.000Z',
        completedAt: '2026-09-02T14:13:31.000Z'
    };
    database.exec('PRAGMA foreign_keys = OFF');
    try {
        database.prepare(`
            INSERT INTO draft_photo_promotion_cleanups (
                cleanup_id, cleanup_id_hash, promotion_id, promotion_id_hash,
                processing_run_id, processing_run_id_hash, draft_id,
                draft_id_hash, cleanup_reason, withdrawal_kind,
                source_promotion_status, source_promotion_idempotency_key,
                source_promotion_idempotency_key_hash,
                source_promotion_payload_fingerprint, expected_state_version,
                object_count, idempotency_key, cleanup_idempotency_key_hash,
                payload_fingerprint, service_actor_identity_hash, status,
                cleanup_evidence_hash, created_at, updated_at, completed_at
            ) VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?, 'withdrawal', 'editorial-removal',
                'candidate', ?, ?, ?, ?, 2, ?, ?, ?, ?, 'cleaned', ?, ?, ?, ?
            )
        `).run(
            cleanup.cleanupId,
            cleanup.cleanupIdHash,
            candidate.promotionId,
            cleanup.promotionIdHash,
            candidate.processingRunId,
            cleanup.processingRunIdHash,
            candidate.draftId,
            cleanup.draftIdHash,
            cleanup.sourceIdempotencyKey,
            cleanup.sourceIdempotencyKeyHash,
            cleanup.sourcePayloadFingerprint,
            expectedStateVersion,
            cleanup.cleanupIdempotencyKey,
            cleanup.cleanupIdempotencyKeyHash,
            cleanup.payloadFingerprint,
            actorHash,
            cleanup.evidenceHash,
            cleanup.createdAt,
            cleanup.completedAt,
            cleanup.completedAt
        );
    } finally {
        database.exec('PRAGMA foreign_keys = ON');
    }
    database.prepare(`
        INSERT INTO gallery_photo_promotion_cleanup_tombstones (
            cleanup_id_hash, promotion_id_hash, processing_run_id_hash,
            draft_id_hash, source_promotion_idempotency_key_hash,
            source_promotion_payload_fingerprint, cleanup_idempotency_key_hash,
            cleanup_payload_fingerprint, cleanup_reason, withdrawal_kind,
            evidence_hash, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'withdrawal', 'editorial-removal', ?, ?)
    `).run(
        cleanup.cleanupIdHash,
        cleanup.promotionIdHash,
        cleanup.processingRunIdHash,
        cleanup.draftIdHash,
        cleanup.sourceIdempotencyKeyHash,
        cleanup.sourcePayloadFingerprint,
        cleanup.cleanupIdempotencyKeyHash,
        cleanup.payloadFingerprint,
        cleanup.evidenceHash,
        cleanup.completedAt
    );
}

function insertCompletedProcessingCleanup(candidate, expectedStateVersion, label) {
    const cleanupId = `cleanup_${identifierHex(`processing:${label}`)}`;
    const cleanup = {
        cleanupId,
        cleanupIdHash: hash(`cleanup-id:${cleanupId}`),
        processingRunIdHash: hash(`run:${candidate.processingRunId}`),
        draftIdHash: hash(`draft:${candidate.draftId}`),
        evidenceHash: hash(`processing-cleanup-evidence:${label}`),
        completedAt: '2026-09-02T14:13:33.000Z'
    };
    database.exec('PRAGMA foreign_keys = OFF');
    try {
        database.prepare(`
            INSERT INTO draft_processing_cleanups (
                cleanup_id, cleanup_id_hash, processing_run_id,
                processing_run_id_hash, draft_id, draft_id_hash,
                cleanup_reason, expected_state_version, output_count,
                idempotency_key, payload_fingerprint,
                service_actor_identity_hash, status, cleanup_evidence_hash,
                created_at, updated_at, completed_at
            ) VALUES (
                ?, ?, ?, ?, ?, ?, 'withdrawal', ?, 2, ?, ?, ?, 'cleaned',
                ?, '2026-09-02T14:13:32.000Z', ?, ?
            )
        `).run(
            cleanup.cleanupId,
            cleanup.cleanupIdHash,
            candidate.processingRunId,
            cleanup.processingRunIdHash,
            candidate.draftId,
            cleanup.draftIdHash,
            expectedStateVersion,
            `processing-cleanup-${label}-0001`,
            hash(`processing-cleanup-payload:${label}`),
            actorHash,
            cleanup.evidenceHash,
            cleanup.completedAt,
            cleanup.completedAt
        );
    } finally {
        database.exec('PRAGMA foreign_keys = ON');
    }
    return cleanup;
}

function insertProcessingCleanupTombstone(cleanup) {
    database.prepare(`
        INSERT INTO gallery_processing_cleanup_tombstones (
            cleanup_id_hash, draft_id_hash, processing_run_id_hash,
            cleanup_reason, evidence_hash, completed_at
        ) VALUES (?, ?, ?, 'withdrawal', ?, ?)
    `).run(
        cleanup.cleanupIdHash,
        cleanup.draftIdHash,
        cleanup.processingRunIdHash,
        cleanup.evidenceHash,
        cleanup.completedAt
    );
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

function schemaCount(type, name) {
    return database.prepare(
        'SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = ? AND name = ?'
    ).get(type, name).count;
}

function seedCandidate(label, ordinal) {
    const suffix = String(ordinal).repeat(32);
    const draftId = `draft_photo_review_${label}_000${ordinal}`;
    const promotionId = `promotion_${suffix.slice(0, 12)}4${suffix.slice(13, 16)}8${suffix.slice(17)}`;
    const processingRunId =
        `run_${suffix.slice(0, 12)}4${suffix.slice(13, 16)}8${suffix.slice(17)}`;
    const reviewId = `review_${hash(`review:${label}`).slice(0, 32)}`;
    const itemId = `photo-review-${label}`;
    const consentRevision = `consent-photo-review-${label}`;
    const candidatePayloadHash = hash(`candidate:${label}`);
    const generationFingerprint = hash(`generation:${label}`);
    const timestamp = `2026-09-02T14:${String(ordinal * 10).padStart(2, '0')}:00.000Z`;

    database.prepare(`
        INSERT INTO gallery_drafts (
            draft_id, public_item_id, site_modes_json, export_bundle_id,
            source_revision, suppression_revision, item_revision, media_type,
            race_date, race_event, race_distance, athlete_ids_json, title,
            caption, alt_text, featured, verified_owner_identity_hash,
            created_at, updated_at
        ) VALUES (?, ?, '["family"]', 'bundle-review', 'source-review',
            'suppression-review', 'item-review', 'photo', '2026-09-02',
            'Synthetic race', '5 km', '[]', 'Synthetic review title',
            'Generated test data only.', 'Generated test image.', 0, ?, ?, ?)
    `).run(draftId, itemId, actorHash, timestamp, timestamp);
    database.prepare(`
        INSERT INTO draft_consent_attestations (
            draft_id, consent_revision, public_use_confirmed, contains_minors,
            guardian_approval_confirmed, verified_owner_identity_hash, attested_at
        ) VALUES (?, ?, 1, 0, 0, ?, ?)
    `).run(draftId, consentRevision, actorHash, timestamp);
    database.prepare(
        'UPDATE gallery_drafts SET active_consent_revision = ?, state = ?, ' +
        'state_version = 6 WHERE draft_id = ?'
    ).run(consentRevision, 'candidate-public', draftId);

    database.exec('PRAGMA foreign_keys = OFF');
    database.prepare(`
        INSERT INTO draft_photo_promotions (
            promotion_id, processing_run_id, draft_id, site_mode,
            item_revision, consent_revision, export_bundle_id, source_revision,
            suppression_revision, expected_state_version, result_state_version,
            idempotency_key, idempotency_key_hash, payload_fingerprint,
            service_actor_identity_hash, status, candidate_payload_hash,
            created_at, updated_at, candidate_at
        ) VALUES (?, ?, ?, 'family', 'item-review', ?, 'bundle-review',
            'source-review', 'suppression-review', 5, 6, ?, ?, ?, ?,
            'candidate', ?, ?, ?, ?)
    `).run(
        promotionId,
        processingRunId,
        draftId,
        consentRevision,
        `promotion-review-${label}-0001`,
        hash(`promotion-idempotency:${label}`),
        hash(`promotion-payload:${label}`),
        actorHash,
        candidatePayloadHash,
        timestamp,
        timestamp,
        timestamp
    );
    database.exec('PRAGMA foreign_keys = ON');

    const targetSetHash = hash(`target-set:${label}`);
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
        hash(`draft:${draftId}`),
        hash('approved-origin:https://media.synthetic.example'),
        generationFingerprint,
        targetSetHash,
        timestamp
    );
    for (const [role, fileName] of [
        ['photo-display', 'display.webp'],
        ['photo-thumbnail', 'thumbnail.webp']
    ]) {
        const sha256 = hash(`${label}:${role}:bytes`);
        const objectKey = `media/v1/${sha256}/${fileName}`;
        database.prepare(`
            INSERT INTO draft_photo_public_generation_targets (
                promotion_id, role, approved_object_key,
                approved_object_key_hash, public_url_hash, expected_sha256,
                generation_target_set_hash, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            promotionId,
            role,
            objectKey,
            hash(`approved-key:${objectKey}`),
            hash(`public-url:https://media.synthetic.example/${objectKey}`),
            sha256,
            targetSetHash,
            timestamp
        );
    }

    return {
        label,
        draftId,
        promotionId,
        processingRunId,
        reviewId,
        itemId,
        candidatePayloadHash,
        generationFingerprint,
        timestamp
    };
}

function reservation(candidate, ordinal) {
    return {
        ...candidate,
        baseSha: String(ordinal + 6).repeat(40),
        branchRef: `gallery-media/candidate-${hash(`branch:${candidate.label}`).slice(0, 32)}`,
        manifestSha256: `sha256:${hash(`manifest:${candidate.label}`)}`,
        operationMarkerHash: hash(`operation-marker:${candidate.label}`),
        workflowRunReference: `workflow-run-${1000 + ordinal}`,
        reservationIdempotencyKey: `review-reserve-${candidate.label}-0001`,
        reservationIdempotencyKeyHash: hash(`reserve-idempotency:${candidate.label}`),
        reservationPayloadFingerprint: hash(`reserve-payload:${candidate.label}`)
    };
}

function insertReservation(value) {
    database.prepare(`
        INSERT INTO draft_photo_review_receipts (
            review_id, draft_id, promotion_id, processing_run_id,
            candidate_state_version,
            candidate_payload_hash, generation_fingerprint, repository,
            base_ref, base_sha, branch_ref, target_relative_path, item_id,
            manifest_sha256, operation_marker_hash, workflow_run_reference,
            status, reservation_idempotency_key,
            reservation_idempotency_key_hash, reservation_payload_fingerprint,
            service_actor_identity_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 6, ?, ?, 'johnkevan88888/family-running', 'main',
            ?, ?, 'gallery-data/family.json', ?, ?, ?, ?, 'reserved',
            ?, ?, ?, ?, ?, ?)
    `).run(
        value.reviewId,
        value.draftId,
        value.promotionId,
        value.processingRunId,
        value.candidatePayloadHash,
        value.generationFingerprint,
        value.baseSha,
        value.branchRef,
        value.itemId,
        value.manifestSha256,
        value.operationMarkerHash,
        value.workflowRunReference,
        value.reservationIdempotencyKey,
        value.reservationIdempotencyKeyHash,
        value.reservationPayloadFingerprint,
        actorHash,
        value.timestamp,
        value.timestamp
    );
}

function insertAbandonment(value) {
    database.prepare(`
        INSERT INTO draft_photo_review_abandonment_receipts (
            draft_id, promotion_id, processing_run_id, expected_state_version,
            result_state_version, failure_evidence_hash, idempotency_key,
            idempotency_key_hash, payload_fingerprint,
            service_actor_identity_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        value.draftId,
        value.promotionId,
        value.processingRunId,
        value.expectedStateVersion,
        value.resultStateVersion,
        value.failureEvidenceHash,
        value.idempotencyKey,
        value.idempotencyKeyHash,
        value.payloadFingerprint,
        actorHash,
        value.createdAt
    );
}

function readAbandonment(draftId) {
    return database.prepare(`
        SELECT promotion_id AS promotionId,
            processing_run_id AS processingRunId,
            expected_state_version AS expectedStateVersion,
            result_state_version AS resultStateVersion,
            failure_evidence_hash AS failureEvidenceHash
        FROM draft_photo_review_abandonment_receipts
        WHERE draft_id = ?
    `).get(draftId);
}

function readReceipt(reviewId) {
    return database.prepare(`
        SELECT status, draft_id AS draftId, promotion_id AS promotionId,
            pull_request_number AS pullRequestNumber,
            terminal_kind AS terminalKind,
            open_evidence_hash AS openEvidenceHash,
            close_evidence_hash AS closeEvidenceHash,
            readback_evidence_hash AS readbackEvidenceHash,
            opened_at AS openedAt
        FROM draft_photo_review_receipts
        WHERE review_id = ?
    `).get(reviewId);
}

function draftState(draftId) {
    return database.prepare(
        'SELECT state FROM gallery_drafts WHERE draft_id = ?'
    ).get(draftId).state;
}
