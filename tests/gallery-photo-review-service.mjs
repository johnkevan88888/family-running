import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

import {
    abandonPhotoReviewCandidate,
    readPhotoReviewInvalidation,
    recordPhotoReviewOpened,
    recordPhotoReviewTerminal,
    reservePhotoReview,
    startPhotoReviewInvalidation
} from '../gallery-admin/src/photo-review-service.js';

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
const sqlite = new DatabaseSync(':memory:');
for (const migration of migrations) sqlite.exec(migration);

// Parent services already prove how these rows are created. Remove only their
// insert gates so this focused test can exercise the review service against the
// real 0011 lifecycle and the earlier withdrawal state machine.
for (const trigger of [
    'gallery_drafts_state_version_guard',
    'gallery_drafts_transition_guard',
    'gallery_drafts_consent_state_gate_guard',
    'gallery_drafts_candidate_processing_guard',
    'draft_photo_promotions_insert_guard',
    'draft_photo_public_generations_insert_guard',
    'draft_photo_public_generation_targets_insert_guard'
]) sqlite.exec(`DROP TRIGGER ${trigger}`);

const d1 = createSqliteD1(sqlite);
const env = {
    DB: d1,
    APPROVED_MEDIA: {
        async head() { return null; },
        async get() { return null; }
    }
};
const identity = {
    type: 'service',
    subject: '0123456789abcdef0123456789abcdef.access'
};
const fixedNow = Date.UTC(2026, 8, 2, 16, 0, 0);
const candidate = seedCandidate(1);
const candidateReader = async () => ({
    ok: true,
    status: 200,
    candidate: {
        schemaVersion: '1.0',
        operationId: candidate.promotionId,
        draft: {
            draftId: candidate.draftId,
            state: 'candidate-public',
            stateVersion: 6
        }
    }
});
const reserveInput = {
    expectedStateVersion: 6,
    baseSha: 'a'.repeat(40),
    manifestSha256: `sha256:${hash('manifest-one')}`,
    workflowRunReference:
        'https://github.com/johnkevan88888/family-running/actions/runs/101/attempts/1',
    idempotencyKey: 'review-reserve-service-0001'
};

const reserved = await reservePhotoReview(
    env,
    identity,
    candidate.draftId,
    reserveInput,
    fixedNow,
    { readPhotoCandidate: candidateReader }
);
assert.equal(reserved.status, 201);
assert.equal(reserved.review.status, 'reserved');
assert.equal(reserved.review.draftId, candidate.draftId);
assert.equal(reserved.review.promotionId, candidate.promotionId);
assert.equal(reserved.review.targetRelativePath, 'gallery-data/family.json');
assert.match(reserved.review.branchRef, /^gallery-media\/candidate-[a-f0-9]{32}$/);
assert.equal(reserved.replayed, false);

const reservedReplay = await reservePhotoReview(
    env,
    identity,
    candidate.draftId,
    reserveInput,
    fixedNow + 1,
    { readPhotoCandidate: candidateReader }
);
assert.equal(reservedReplay.status, 200);
assert.equal(reservedReplay.replayed, true);
assert.equal(reservedReplay.review.reviewId, reserved.review.reviewId);
const reservedReadback = await readPhotoReviewInvalidation(
    env,
    identity,
    candidate.draftId
);
assert.equal(reservedReadback.status, 200);
assert.equal(reservedReadback.receiptKind, 'review');
assert.equal(reservedReadback.review.reviewId, reserved.review.reviewId);
assert.equal(reservedReadback.review.status, 'reserved');
assert.equal(reservedReadback.invalidation, null);
assert.equal(reservedReadback.replayed, true);
assert.equal((await reservePhotoReview(
    env,
    identity,
    candidate.draftId,
    { ...reserveInput, manifestSha256: `sha256:${hash('different')}` },
    fixedNow + 2,
    { readPhotoCandidate: candidateReader }
)).code, 'conflict');

const openInput = {
    expectedStateVersion: 6,
    headSha: 'b'.repeat(40),
    pullRequestNumber: 71,
    pullRequestUrl: 'https://github.com/johnkevan88888/family-running/pull/71',
    openEvidenceHash: hash('open-evidence-one'),
    idempotencyKey: 'review-open-service-0001'
};
const opened = await recordPhotoReviewOpened(
    env,
    identity,
    reserved.review.reviewId,
    openInput,
    fixedNow + 1000,
    { readPhotoCandidate: candidateReader }
);
assert.equal(opened.status, 201);
assert.equal(opened.review.status, 'open');
assert.equal(opened.review.pullRequestNumber, 71);
assert.equal(opened.replayed, false);
const openedReadback = await readPhotoReviewInvalidation(
    env,
    identity,
    candidate.draftId
);
assert.equal(openedReadback.status, 200);
assert.equal(openedReadback.receiptKind, 'review');
assert.equal(openedReadback.review.status, 'open');
assert.equal(openedReadback.review.pullRequestNumber, 71);
assert.equal(openedReadback.invalidation, null);

const terminalInput = {
    terminalKind: 'closed-unmerged',
    terminalEvidenceHash: hash('terminal-one'),
    closeEvidenceHash: hash('close-one'),
    readbackEvidenceHash: hash('readback-one'),
    headSha: openInput.headSha,
    pullRequestNumber: openInput.pullRequestNumber,
    pullRequestUrl: openInput.pullRequestUrl,
    idempotencyKey: 'review-terminal-service-0001'
};
d1.failAfterNextBatch = true;
const terminal = await recordPhotoReviewTerminal(
    env,
    identity,
    reserved.review.reviewId,
    terminalInput,
    fixedNow + 2000
);
assert.equal(terminal.status, 201);
assert.equal(terminal.review.status, 'terminal');
assert.equal(terminal.review.terminalKind, 'closed-unmerged');
assert.equal(terminal.cleanup.expectedStateVersion, 7);
assert.equal(terminal.cleanup.promotionId, candidate.promotionId);
assert.match(terminal.cleanup.idempotencyKey, /^photo-review-cleanup-[a-f0-9]{32}$/);
assert.equal(terminal.processingCleanup.processingRunId, candidate.processingRunId);
assert.equal(terminal.processingCleanup.expectedStateVersion, 7);
assert.match(
    terminal.processingCleanup.idempotencyKey,
    /^photo-review-staging-[a-f0-9]{32}$/
);
const compensatedDraft = sqlite.prepare(
    'SELECT state, state_version AS stateVersion FROM gallery_drafts WHERE draft_id = ?'
).get(candidate.draftId);
assert.equal(compensatedDraft.state, 'withdrawal-pending');
assert.equal(compensatedDraft.stateVersion, 7);
assert.equal(sqlite.prepare(
    'SELECT withdrawal_kind AS withdrawalKind FROM draft_publication_references ' +
    'WHERE draft_id = ?'
).get(candidate.draftId).withdrawalKind, 'editorial-removal');
const terminalTransition = sqlite.prepare(`
    SELECT from_state AS fromState, to_state AS toState,
        expected_state_version AS expectedStateVersion,
        result_state_version AS resultStateVersion
    FROM draft_transition_receipts
    WHERE draft_id = ? AND idempotency_key = ?
`).get(candidate.draftId, terminalInput.idempotencyKey);
assert.equal(terminalTransition.fromState, 'candidate-public');
assert.equal(terminalTransition.toState, 'withdrawal-pending');
assert.equal(terminalTransition.expectedStateVersion, 6);
assert.equal(terminalTransition.resultStateVersion, 7);

const terminalReplay = await recordPhotoReviewTerminal(
    env,
    identity,
    reserved.review.reviewId,
    terminalInput,
    fixedNow + 3000
);
assert.equal(terminalReplay.status, 200);
assert.equal(terminalReplay.replayed, true);
assert.deepEqual(terminalReplay.cleanup, terminal.cleanup);

const invalidation = await readPhotoReviewInvalidation(
    env,
    identity,
    candidate.draftId
);
assert.equal(invalidation.status, 200);
assert.equal(invalidation.receiptKind, 'review');
assert.equal(invalidation.replayed, true);
assert.equal(invalidation.invalidation.withdrawalKind, 'editorial-removal');
assert.equal(invalidation.invalidation.terminalKind, 'closed-unmerged');
assert.deepEqual(invalidation.invalidation.cleanup, terminal.cleanup);
assert.deepEqual(
    invalidation.invalidation.processingCleanup,
    terminal.processingCleanup
);

// The migration test proves final withdrawal is blocked until both cleanup
// tombstones exist. Isolate the service readback here by advancing the already
// terminal draft: delayed retries must still return the receipt-bound version
// 7 packages, never the mutable withdrawn state version 8.
assert.throws(
    () => sqlite.prepare(`
        UPDATE gallery_drafts
           SET state = 'withdrawn', state_version = state_version + 1
         WHERE draft_id = ?
    `).run(candidate.draftId),
    /approved and staging cleanup tombstones are required/i
);
sqlite.exec(`
    DROP TRIGGER gallery_drafts_withdrawal_evidence_guard;
    DROP TRIGGER gallery_drafts_photo_review_cleanup_guard;
`);
sqlite.prepare(`
    UPDATE gallery_drafts
       SET state = 'withdrawn', state_version = state_version + 1
     WHERE draft_id = ?
`).run(candidate.draftId);
assert.deepEqual(readDraftState(sqlite, candidate.draftId), {
    state: 'withdrawn',
    stateVersion: 8
});
const delayedTerminalReplay = await recordPhotoReviewTerminal(
    env,
    identity,
    reserved.review.reviewId,
    terminalInput,
    fixedNow + 3500
);
assert.equal(delayedTerminalReplay.status, 200);
assert.equal(delayedTerminalReplay.replayed, true);
assert.deepEqual(delayedTerminalReplay.cleanup, terminal.cleanup);
assert.deepEqual(
    delayedTerminalReplay.processingCleanup,
    terminal.processingCleanup
);
const delayedInvalidation = await readPhotoReviewInvalidation(
    env,
    identity,
    candidate.draftId
);
assert.deepEqual(delayedInvalidation.invalidation.cleanup, terminal.cleanup);
assert.deepEqual(
    delayedInvalidation.invalidation.processingCleanup,
    terminal.processingCleanup
);

// Recover a PR that GitHub created and closed after the normal open-receipt
// write was lost. The terminal route stores exact PR proof without inventing
// an open lifecycle receipt.
const recoveredCandidate = seedCandidate(2);
const recoveredReader = async () => ({
    ok: true,
    status: 200,
    candidate: {
        schemaVersion: '1.0',
        operationId: recoveredCandidate.promotionId,
        draft: {
            draftId: recoveredCandidate.draftId,
            state: 'candidate-public',
            stateVersion: 6
        }
    }
});
const recoveredReservation = await reservePhotoReview(
    env,
    identity,
    recoveredCandidate.draftId,
    {
        ...reserveInput,
        baseSha: 'c'.repeat(40),
        manifestSha256: `sha256:${hash('manifest-two')}`,
        workflowRunReference:
            'https://github.com/johnkevan88888/family-running/actions/runs/102/attempts/1',
        idempotencyKey: 'review-reserve-service-0002'
    },
    fixedNow + 4000,
    { readPhotoCandidate: recoveredReader }
);
assert.equal(recoveredReservation.status, 201);
const recoveredTerminal = await recordPhotoReviewTerminal(
    env,
    identity,
    recoveredReservation.review.reviewId,
    {
        terminalKind: 'closed-unmerged',
        terminalEvidenceHash: hash('terminal-two'),
        closeEvidenceHash: hash('close-two'),
        readbackEvidenceHash: hash('readback-two'),
        headSha: 'd'.repeat(40),
        pullRequestNumber: 72,
        pullRequestUrl:
            'https://github.com/johnkevan88888/family-running/pull/72',
        idempotencyKey: 'review-terminal-service-0002'
    },
    fixedNow + 5000
);
assert.equal(recoveredTerminal.status, 201);
assert.equal(recoveredTerminal.review.status, 'terminal');
assert.equal(recoveredTerminal.review.pullRequestNumber, 72);
assert.equal(recoveredTerminal.review.openEvidenceHash, null);
assert.equal(sqlite.prepare(
    'SELECT opened_at AS openedAt FROM draft_photo_review_receipts WHERE review_id = ?'
).get(recoveredReservation.review.reviewId).openedAt, null);

// A local manifest/catalog failure can happen before a durable review
// reservation. Bind that exact candidate to an immutable abandonment receipt,
// preserve the transition receipt, and make both cleanup services retryable.
const abandonedCandidate = seedCandidate(3);
const abandonmentInput = {
    expectedStateVersion: 6,
    failureEvidenceHash: hash('manifest-preparation-failure'),
    idempotencyKey: 'review-abandon-service-0003'
};
d1.failAfterNextBatch = true;
const abandoned = await abandonPhotoReviewCandidate(
    env,
    identity,
    abandonedCandidate.draftId,
    abandonmentInput,
    fixedNow + 6000
);
assert.equal(abandoned.status, 201);
assert.equal(abandoned.abandonment.draftId, abandonedCandidate.draftId);
assert.equal(abandoned.abandonment.promotionId, abandonedCandidate.promotionId);
assert.equal(
    abandoned.abandonment.processingRunId,
    abandonedCandidate.processingRunId
);
assert.equal(abandoned.abandonment.resultStateVersion, 7);
assert.equal(abandoned.cleanup.expectedStateVersion, 7);
assert.equal(
    abandoned.processingCleanup.processingRunId,
    abandonedCandidate.processingRunId
);
assert.equal(abandoned.processingCleanup.expectedStateVersion, 7);
const abandonmentTransition = sqlite.prepare(`
    SELECT from_state AS fromState, to_state AS toState,
        expected_state_version AS expectedStateVersion,
        result_state_version AS resultStateVersion,
        payload_fingerprint AS payloadFingerprint
    FROM draft_transition_receipts
    WHERE draft_id = ? AND idempotency_key = ?
`).get(abandonedCandidate.draftId, abandonmentInput.idempotencyKey);
assert.equal(abandonmentTransition.fromState, 'candidate-public');
assert.equal(abandonmentTransition.toState, 'withdrawal-pending');
assert.equal(abandonmentTransition.expectedStateVersion, 6);
assert.equal(abandonmentTransition.resultStateVersion, 7);
assert.match(abandonmentTransition.payloadFingerprint, /^[a-f0-9]{64}$/);
const abandonmentReplay = await abandonPhotoReviewCandidate(
    env,
    identity,
    abandonedCandidate.draftId,
    abandonmentInput,
    fixedNow + 7000
);
assert.equal(abandonmentReplay.status, 200);
assert.equal(abandonmentReplay.replayed, true);
assert.deepEqual(abandonmentReplay.cleanup, abandoned.cleanup);
assert.deepEqual(
    abandonmentReplay.processingCleanup,
    abandoned.processingCleanup
);
const abandonmentReadback = await readPhotoReviewInvalidation(
    env,
    identity,
    abandonedCandidate.draftId
);
assert.equal(abandonmentReadback.status, 200);
assert.equal(abandonmentReadback.receiptKind, 'abandonment');
assert.deepEqual(abandonmentReadback.abandonment, abandoned.abandonment);
assert.deepEqual(abandonmentReadback.cleanup, abandoned.cleanup);
assert.deepEqual(
    abandonmentReadback.processingCleanup,
    abandoned.processingCleanup
);
assert.equal(abandonmentReadback.replayed, true);
const blockedReservation = await reservePhotoReview(
    env,
    identity,
    abandonedCandidate.draftId,
    {
        ...reserveInput,
        baseSha: 'e'.repeat(40),
        manifestSha256: `sha256:${hash('manifest-three')}`,
        workflowRunReference:
            'https://github.com/johnkevan88888/family-running/actions/runs/103/attempts/1',
        idempotencyKey: 'review-reserve-service-0003'
    },
    fixedNow + 8000,
    { readPhotoCandidate: async () => {
        throw new Error('An abandoned candidate must not be re-read.');
    } }
);
assert.equal(blockedReservation.status, 409);
assert.equal(blockedReservation.code, 'review-not-eligible');

// A durable reservation can be invalidated before GitHub reconciliation. The
// start route changes only the D1 withdrawal state and leaves the review itself
// reserved: it does not invent terminal GitHub proof.
const invalidationCandidate = seedCandidate(4);
const invalidationReader = async () => ({
    ok: true,
    status: 200,
    candidate: {
        schemaVersion: '1.0',
        operationId: invalidationCandidate.promotionId,
        draft: {
            draftId: invalidationCandidate.draftId,
            state: 'candidate-public',
            stateVersion: 6
        }
    }
});
const invalidationReservation = await reservePhotoReview(
    env,
    identity,
    invalidationCandidate.draftId,
    {
        ...reserveInput,
        baseSha: 'f'.repeat(40),
        manifestSha256: `sha256:${hash('manifest-four')}`,
        workflowRunReference:
            'https://github.com/johnkevan88888/family-running/actions/runs/104/attempts/1',
        idempotencyKey: 'review-reserve-service-0004'
    },
    fixedNow + 9000,
    { readPhotoCandidate: invalidationReader }
);
assert.equal(invalidationReservation.status, 201);
const invalidationStartInput = {
    expectedStateVersion: 6,
    idempotencyKey: 'review-invalidation-start-0004'
};
assert.equal((await startPhotoReviewInvalidation(
    env,
    identity,
    invalidationReservation.review.reviewId,
    { ...invalidationStartInput, terminalKind: 'no-pr-created' },
    fixedNow + 9999
)).code, 'invalid-request');
d1.failAfterNextBatch = true;
const invalidationStarted = await startPhotoReviewInvalidation(
    env,
    identity,
    invalidationReservation.review.reviewId,
    invalidationStartInput,
    fixedNow + 10000
);
assert.equal(invalidationStarted.status, 200);
assert.equal(invalidationStarted.replayed, true);
assert.equal(invalidationStarted.review.status, 'reserved');
assert.equal(invalidationStarted.review.terminalKind, null);
assert.equal(invalidationStarted.invalidationStart.withdrawalKind, 'editorial-removal');
assert.equal(invalidationStarted.invalidationStart.expectedStateVersion, 6);
assert.equal(invalidationStarted.invalidationStart.resultStateVersion, 7);
assert.equal(invalidationStarted.invalidationStart.cleanup.expectedStateVersion, 7);
assert.equal(
    invalidationStarted.invalidationStart.processingCleanup.expectedStateVersion,
    7
);
assert.deepEqual(readDraftState(sqlite, invalidationCandidate.draftId), {
    state: 'withdrawal-pending',
    stateVersion: 7
});
assert.equal(sqlite.prepare(
    'SELECT status FROM draft_photo_review_receipts WHERE review_id = ?'
).get(invalidationReservation.review.reviewId).status, 'reserved');
const invalidationStartReplay = await startPhotoReviewInvalidation(
    env,
    identity,
    invalidationReservation.review.reviewId,
    invalidationStartInput,
    fixedNow + 11000
);
assert.equal(invalidationStartReplay.status, 200);
assert.equal(invalidationStartReplay.replayed, true);
assert.deepEqual(
    invalidationStartReplay.invalidationStart,
    invalidationStarted.invalidationStart
);
assert.equal((await startPhotoReviewInvalidation(
    env,
    identity,
    invalidationReservation.review.reviewId,
    {
        expectedStateVersion: 6,
        idempotencyKey: 'review-invalidation-start-other'
    },
    fixedNow + 12000
)).code, 'conflict');
const startedReadback = await readPhotoReviewInvalidation(
    env,
    identity,
    invalidationCandidate.draftId
);
assert.equal(startedReadback.receiptKind, 'review');
assert.equal(startedReadback.review.status, 'reserved');
assert.equal(startedReadback.invalidation.withdrawalKind, 'editorial-removal');
assert.equal(startedReadback.invalidation.terminalKind, 'no-pr-created');
assert.deepEqual(
    startedReadback.invalidation.cleanup,
    invalidationStarted.invalidationStart.cleanup
);

// A withdrawal may commit after the service's fresh candidate read but before
// its D1 batch begins. The guarded open write must then remain reserved, emit no
// false opened audit, and expose the exact invalidation recovery package.
const racedCandidate = seedCandidate(5);
const racedReader = async () => ({
    ok: true,
    status: 200,
    candidate: {
        schemaVersion: '1.0',
        operationId: racedCandidate.promotionId,
        draft: {
            draftId: racedCandidate.draftId,
            state: 'candidate-public',
            stateVersion: 6
        }
    }
});
const racedReservation = await reservePhotoReview(
    env,
    identity,
    racedCandidate.draftId,
    {
        ...reserveInput,
        baseSha: '1'.repeat(40),
        manifestSha256: `sha256:${hash('manifest-five')}`,
        workflowRunReference:
            'https://github.com/johnkevan88888/family-running/actions/runs/105/attempts/1',
        idempotencyKey: 'review-reserve-service-0005'
    },
    fixedNow + 13000,
    { readPhotoCandidate: racedReader }
);
assert.equal(racedReservation.status, 201);
d1.beforeNextBatch = () => {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
        sqlite.prepare(`
            INSERT INTO draft_publication_references (
                draft_id, withdrawal_kind, updated_at
            ) VALUES (?, 'editorial-removal', ?)
        `).run(
            racedCandidate.draftId,
            new Date(fixedNow + 13500).toISOString()
        );
        sqlite.prepare(`
            UPDATE gallery_drafts
               SET state = 'withdrawal-pending', state_version = 7, updated_at = ?
             WHERE draft_id = ? AND state = 'candidate-public' AND state_version = 6
        `).run(
            new Date(fixedNow + 13500).toISOString(),
            racedCandidate.draftId
        );
        sqlite.exec('COMMIT');
    } catch (error) {
        if (sqlite.isTransaction) sqlite.exec('ROLLBACK');
        throw error;
    }
};
const racedOpen = await recordPhotoReviewOpened(
    env,
    identity,
    racedReservation.review.reviewId,
    {
        expectedStateVersion: 6,
        headSha: '2'.repeat(40),
        pullRequestNumber: 75,
        pullRequestUrl:
            'https://github.com/johnkevan88888/family-running/pull/75',
        openEvidenceHash: hash('open-evidence-five'),
        idempotencyKey: 'review-open-service-0005'
    },
    fixedNow + 14000,
    { readPhotoCandidate: racedReader }
);
assert.equal(racedOpen.status, 409);
assert.equal(racedOpen.code, 'conflict');
assert.equal(sqlite.prepare(
    'SELECT status FROM draft_photo_review_receipts WHERE review_id = ?'
).get(racedReservation.review.reviewId).status, 'reserved');
assert.deepEqual(readDraftState(sqlite, racedCandidate.draftId), {
    state: 'withdrawal-pending',
    stateVersion: 7
});
assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count
      FROM gallery_audit_events
     WHERE event_type = 'photo-review-opened'
       AND payload_hash = ?
`).get(hash(JSON.stringify({
    operation: 'photo-review-open',
    reviewId: racedReservation.review.reviewId,
    draftId: racedCandidate.draftId,
    promotionId: racedCandidate.promotionId,
    expectedStateVersion: 6,
    headSha: '2'.repeat(40),
    pullRequestNumber: 75,
    pullRequestUrl: 'https://github.com/johnkevan88888/family-running/pull/75',
    openEvidenceHash: hash('open-evidence-five'),
    idempotencyKey: 'review-open-service-0005'
}))).count, 0);
const racedRecovery = await readPhotoReviewInvalidation(
    env,
    identity,
    racedCandidate.draftId
);
assert.equal(racedRecovery.receiptKind, 'review');
assert.equal(racedRecovery.review.status, 'reserved');
assert.equal(racedRecovery.invalidation.withdrawalKind, 'editorial-removal');
assert.equal(racedRecovery.invalidation.cleanup.expectedStateVersion, 7);

assert.equal(sqlite.prepare('PRAGMA quick_check').get().quick_check, 'ok');
sqlite.close();

console.log(
    'Gallery photo review service: exact reservation/open/terminal replay, ' +
    'receipt readback, service-started invalidation, cleanup packages, lost-open ' +
    'recovery, and pre-reservation abandonment readback passed.'
);

function seedCandidate(ordinal) {
    const digit = String(ordinal);
    const uuid = `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
    const draftId = `draft_${uuid}`;
    const promotionHex = `${digit.repeat(12)}4${digit.repeat(3)}8${digit.repeat(15)}`;
    const promotionId = `promotion_${promotionHex}`;
    const runId = `run_${promotionHex}`;
    const itemId = `photo-review-service-${ordinal}`;
    const consentRevision = `consent-review-service-${ordinal}`;
    const timestamp = `2026-09-02T15:0${ordinal}:00.000Z`;
    const actorHash = hash(`actor-${ordinal}`);

    sqlite.prepare(`
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
    sqlite.prepare(`
        INSERT INTO draft_consent_attestations (
            draft_id, consent_revision, public_use_confirmed, contains_minors,
            guardian_approval_confirmed, verified_owner_identity_hash, attested_at
        ) VALUES (?, ?, 1, 0, 0, ?, ?)
    `).run(draftId, consentRevision, actorHash, timestamp);
    sqlite.prepare(
        "UPDATE gallery_drafts SET active_consent_revision = ?, state = 'candidate-public', " +
        'state_version = 6 WHERE draft_id = ?'
    ).run(consentRevision, draftId);

    sqlite.exec('PRAGMA foreign_keys = OFF');
    sqlite.prepare(`
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
        runId,
        draftId,
        consentRevision,
        `promotion-review-service-${ordinal}`,
        hash(`promotion-key-${ordinal}`),
        hash(`promotion-payload-${ordinal}`),
        actorHash,
        hash(`candidate-${ordinal}`),
        timestamp,
        timestamp,
        timestamp
    );
    sqlite.exec('PRAGMA foreign_keys = ON');

    const targetSetHash = hash(`target-set-${ordinal}`);
    sqlite.prepare(`
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
        hash('origin'),
        hash(`generation-${ordinal}`),
        targetSetHash,
        timestamp
    );
    for (const [role, name] of [
        ['photo-display', 'display.webp'],
        ['photo-thumbnail', 'thumbnail.webp']
    ]) {
        const sha = hash(`${ordinal}:${role}`);
        const key = `media/v1/${sha}/${name}`;
        sqlite.prepare(`
            INSERT INTO draft_photo_public_generation_targets (
                promotion_id, role, approved_object_key,
                approved_object_key_hash, public_url_hash, expected_sha256,
                generation_target_set_hash, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            promotionId,
            role,
            key,
            hash(`key:${key}`),
            hash(`url:${key}`),
            sha,
            targetSetHash,
            timestamp
        );
    }
    return { draftId, promotionId, processingRunId: runId };
}

function readDraftState(database, draftId) {
    return { ...database.prepare(
        'SELECT state, state_version AS stateVersion FROM gallery_drafts WHERE draft_id = ?'
    ).get(draftId) };
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
                meta: { changes: Number(result.changes) }
            };
        }
    }
    const api = {
        failAfterNextBatch: false,
        beforeNextBatch: null,
        prepare(sql) {
            return new Statement(sql);
        },
        async batch(statements) {
            const beforeBatch = api.beforeNextBatch;
            api.beforeNextBatch = null;
            if (beforeBatch) await beforeBatch();
            database.exec('BEGIN IMMEDIATE');
            try {
                const results = statements.map(statement =>
                    statement.runSynchronously()
                );
                database.exec('COMMIT');
                if (api.failAfterNextBatch) {
                    api.failAfterNextBatch = false;
                    throw new Error('synthetic-lost-d1-batch-response');
                }
                return results;
            } catch (error) {
                if (database.isTransaction) database.exec('ROLLBACK');
                throw error;
            }
        }
    };
    return api;
}

function hash(value) {
    return createHash('sha256').update(value).digest('hex');
}
