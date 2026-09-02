import { sha256Hex } from './media-byte-verification.js';
import { readPhotoCandidate } from './promotion-service.js';
import { hashIdentity } from './session.js';

const textEncoder = new TextEncoder();
const REPOSITORY = 'johnkevan88888/family-running';
const BASE_REF = 'main';
const TARGET_PATHS = Object.freeze({
    family: 'gallery-data/family.json',
    everyone: 'gallery-data/everyone.json'
});
const DRAFT_ID_PATTERN =
    /^draft_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const REVIEW_ID_PATTERN = /^review_[a-f0-9]{32}$/;
const PROMOTION_ID_PATTERN = /^promotion_[a-f0-9]{32}$/;
const PROCESSING_RUN_ID_PATTERN = /^run_[a-f0-9]{12}4[a-f0-9]{3}[89ab][a-f0-9]{15}$/;
const ITEM_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MANIFEST_SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const WORKFLOW_RUN_PATTERN =
    /^https:\/\/github\.com\/johnkevan88888\/family-running\/actions\/runs\/[1-9][0-9]*\/attempts\/[1-9][0-9]*$/;
const SAFE_SERVICE_SUBJECT_PATTERN = /^[^\u0000-\u001f\u007f]{1,512}$/;
const RESERVATION_INPUT_KEYS = Object.freeze([
    'baseSha',
    'expectedStateVersion',
    'idempotencyKey',
    'manifestSha256',
    'workflowRunReference'
]);
const OPEN_INPUT_KEYS = Object.freeze([
    'expectedStateVersion',
    'headSha',
    'idempotencyKey',
    'openEvidenceHash',
    'pullRequestNumber',
    'pullRequestUrl'
]);
const TERMINAL_INPUT_KEYS = Object.freeze([
    'closeEvidenceHash',
    'headSha',
    'idempotencyKey',
    'pullRequestNumber',
    'pullRequestUrl',
    'readbackEvidenceHash',
    'terminalEvidenceHash',
    'terminalKind'
]);
const ABANDONMENT_INPUT_KEYS = Object.freeze([
    'expectedStateVersion',
    'failureEvidenceHash',
    'idempotencyKey'
]);
const INVALIDATION_START_INPUT_KEYS = Object.freeze([
    'expectedStateVersion',
    'idempotencyKey'
]);

const REVIEW_SELECT = `
SELECT
    review_id AS reviewId,
    draft_id AS draftId,
    promotion_id AS promotionId,
    processing_run_id AS processingRunId,
    candidate_state_version AS candidateStateVersion,
    candidate_payload_hash AS candidatePayloadHash,
    generation_fingerprint AS generationFingerprint,
    repository,
    base_ref AS baseRef,
    base_sha AS baseSha,
    branch_ref AS branchRef,
    target_relative_path AS targetRelativePath,
    item_id AS itemId,
    manifest_sha256 AS manifestSha256,
    operation_marker_hash AS operationMarkerHash,
    workflow_run_reference AS workflowRunReference,
    status,
    reservation_idempotency_key AS reservationIdempotencyKey,
    reservation_payload_fingerprint AS reservationPayloadFingerprint,
    pull_request_number AS pullRequestNumber,
    pull_request_url AS pullRequestUrl,
    head_sha AS headSha,
    open_evidence_hash AS openEvidenceHash,
    open_idempotency_key AS openIdempotencyKey,
    open_payload_fingerprint AS openPayloadFingerprint,
    terminal_kind AS terminalKind,
    terminal_evidence_hash AS terminalEvidenceHash,
    close_evidence_hash AS closeEvidenceHash,
    readback_evidence_hash AS readbackEvidenceHash,
    terminal_idempotency_key AS terminalIdempotencyKey,
    terminal_payload_fingerprint AS terminalPayloadFingerprint,
    created_at AS createdAt,
    updated_at AS updatedAt,
    opened_at AS openedAt,
    terminal_at AS terminalAt
FROM draft_photo_review_receipts`;

const CANDIDATE_REVIEW_SELECT = `
SELECT
    promotion.promotion_id AS promotionId,
    promotion.processing_run_id AS processingRunId,
    promotion.candidate_payload_hash AS candidatePayloadHash,
    promotion.status AS promotionStatus,
    generation.candidate_state_version AS generationCandidateStateVersion,
    generation.generation_fingerprint AS generationFingerprint,
    draft.draft_id AS draftId,
    draft.public_item_id AS itemId,
    draft.state,
    draft.state_version AS stateVersion,
    draft.site_modes_json AS siteModesJson,
    draft.active_consent_revision AS activeConsentRevision,
    consent.withdrawn_at AS consentWithdrawnAt,
    publication.withdrawal_kind AS withdrawalKind,
    (SELECT COUNT(*)
       FROM json_each(draft.athlete_ids_json) AS tag
       JOIN pending_athlete_exclusions AS exclusion
         ON exclusion.athlete_id = tag.value
      WHERE exclusion.resolved_at IS NULL) AS pendingExclusionCount,
    (SELECT COUNT(*)
       FROM draft_photo_promotion_cleanups AS cleanup
      WHERE cleanup.promotion_id = promotion.promotion_id) AS cleanupCount
FROM gallery_drafts AS draft
JOIN draft_photo_promotions AS promotion
  ON promotion.draft_id = draft.draft_id
JOIN draft_photo_public_generations AS generation
  ON generation.promotion_id = promotion.promotion_id
JOIN draft_consent_attestations AS consent
  ON consent.draft_id = draft.draft_id
 AND consent.consent_revision = draft.active_consent_revision
LEFT JOIN draft_publication_references AS publication
  ON publication.draft_id = draft.draft_id
WHERE draft.draft_id = ?1
  AND promotion.status = 'candidate'`;

const INVALIDATION_SELECT = `
SELECT
    draft.draft_id AS draftId,
    draft.state,
    draft.state_version AS stateVersion,
    consent.withdrawn_at AS consentWithdrawnAt,
    publication.withdrawal_kind AS withdrawalKind,
    (SELECT COUNT(*)
       FROM json_each(draft.athlete_ids_json) AS tag
       JOIN pending_athlete_exclusions AS exclusion
         ON exclusion.athlete_id = tag.value
      WHERE exclusion.resolved_at IS NULL) AS pendingExclusionCount
FROM gallery_drafts AS draft
LEFT JOIN draft_consent_attestations AS consent
  ON consent.draft_id = draft.draft_id
 AND consent.consent_revision = draft.active_consent_revision
LEFT JOIN draft_publication_references AS publication
  ON publication.draft_id = draft.draft_id
WHERE draft.draft_id = ?1`;

const ABANDONMENT_SELECT = `
SELECT
    draft_id AS draftId,
    promotion_id AS promotionId,
    processing_run_id AS processingRunId,
    expected_state_version AS expectedStateVersion,
    result_state_version AS resultStateVersion,
    failure_evidence_hash AS failureEvidenceHash,
    idempotency_key AS idempotencyKey,
    payload_fingerprint AS payloadFingerprint,
    created_at AS createdAt
FROM draft_photo_review_abandonment_receipts`;

const TRANSITION_RECEIPT_SELECT = `
SELECT
    draft_id AS draftId,
    idempotency_key AS idempotencyKey,
    payload_fingerprint AS payloadFingerprint,
    from_state AS fromState,
    to_state AS toState,
    expected_state_version AS expectedStateVersion,
    result_state_version AS resultStateVersion,
    created_at AS createdAt
FROM draft_transition_receipts`;

export async function reservePhotoReview(
    env,
    identity,
    draftId,
    input,
    nowMilliseconds,
    dependencies = {}
) {
    if (
        !validBindings(env) ||
        !validServiceIdentity(identity) ||
        !DRAFT_ID_PATTERN.test(draftId || '') ||
        !validReservationInput(input)
    ) return failure(400, 'invalid-request');

    try {
        const existing = await readReviewByDraft(env.DB, draftId);
        if (existing) {
            const replayFingerprint = await reservationFingerprint(
                existing,
                input
            );
            return reservationReplayMatches(existing, input, replayFingerprint)
                ? success(200, { review: publicReview(existing), replayed: true })
                : failure(409, 'conflict');
        }
        if (await readAbandonmentByDraft(env.DB, draftId)) {
            return failure(409, 'review-not-eligible');
        }

        const candidateReader = dependencies.readPhotoCandidate || readPhotoCandidate;
        const verifiedCandidate = await candidateReader(env, identity, draftId);
        if (verifiedCandidate?.ok !== true || !isPlainObject(verifiedCandidate.candidate)) {
            if (verifiedCandidate?.status === 404) return failure(404, 'not-found');
            return verifiedCandidate?.status === 409
                ? failure(409, 'review-not-eligible')
                : failure(503, 'service-unavailable');
        }
        const candidate = await readCandidateReview(env.DB, draftId);
        const derived = await deriveReservation(candidate, verifiedCandidate.candidate);
        if (
            !derived ||
            candidate.stateVersion !== input.expectedStateVersion
        ) return failure(candidate ? 409 : 404, candidate ? 'review-not-eligible' : 'not-found');

        const reviewId = randomIdentifier('review');
        const occurredAt = isoTime(nowMilliseconds);
        const actorIdentityHash = await hashIdentity(identity);
        const subjectHash = await sha256Text(`draft:${draftId}`);
        const idempotencyKeyHash = await sha256Text(
            `photo-review-reservation-idempotency-key:${input.idempotencyKey}`
        );
        const provisional = {
            reviewId,
            draftId,
            promotionId: candidate.promotionId,
            processingRunId: candidate.processingRunId,
            candidateStateVersion: candidate.stateVersion,
            candidatePayloadHash: candidate.candidatePayloadHash,
            generationFingerprint: candidate.generationFingerprint,
            repository: REPOSITORY,
            baseRef: BASE_REF,
            baseSha: input.baseSha,
            branchRef: derived.branchRef,
            targetRelativePath: derived.targetRelativePath,
            itemId: candidate.itemId,
            manifestSha256: input.manifestSha256,
            operationMarkerHash: derived.operationMarkerHash,
            workflowRunReference: input.workflowRunReference
        };
        const payloadFingerprint = await reservationFingerprint(provisional, input);

        try {
            await runBatch(env.DB, [
                env.DB.prepare(`
                    INSERT INTO draft_photo_review_receipts (
                        review_id, draft_id, promotion_id, processing_run_id,
                        candidate_state_version, candidate_payload_hash,
                        generation_fingerprint, repository, base_ref, base_sha,
                        branch_ref, target_relative_path, item_id,
                        manifest_sha256, operation_marker_hash,
                        workflow_run_reference, status,
                        reservation_idempotency_key,
                        reservation_idempotency_key_hash,
                        reservation_payload_fingerprint,
                        service_actor_identity_hash,
                        created_at, updated_at
                    ) VALUES (
                        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                        ?12, ?13, ?14, ?15, ?16, 'reserved', ?17, ?18,
                        ?19, ?20, ?21, ?21
                    )
                `).bind(
                    reviewId,
                    draftId,
                    candidate.promotionId,
                    candidate.processingRunId,
                    candidate.stateVersion,
                    candidate.candidatePayloadHash,
                    candidate.generationFingerprint,
                    REPOSITORY,
                    BASE_REF,
                    input.baseSha,
                    derived.branchRef,
                    derived.targetRelativePath,
                    candidate.itemId,
                    input.manifestSha256,
                    derived.operationMarkerHash,
                    input.workflowRunReference,
                    input.idempotencyKey,
                    idempotencyKeyHash,
                    payloadFingerprint,
                    actorIdentityHash,
                    occurredAt
                ),
                auditInsert(env.DB, {
                    eventType: 'photo-review-reserved',
                    subjectHash,
                    actorIdentityHash,
                    payloadHash: payloadFingerprint,
                    stateVersion: candidate.stateVersion,
                    occurredAt
                })
            ]);
        } catch {
            const raced = await readReviewByDraft(env.DB, draftId);
            if (!raced) return failure(503, 'service-unavailable');
            const replayFingerprint = await reservationFingerprint(raced, input);
            return reservationReplayMatches(raced, input, replayFingerprint)
                ? success(200, { review: publicReview(raced), replayed: true })
                : failure(409, 'conflict');
        }

        const created = await readReviewById(env.DB, reviewId);
        return created && reservationReplayMatches(created, input, payloadFingerprint)
            ? success(201, { review: publicReview(created), replayed: false })
            : failure(503, 'service-unavailable');
    } catch {
        return failure(503, 'service-unavailable');
    }
}

export async function abandonPhotoReviewCandidate(
    env,
    identity,
    draftId,
    input,
    nowMilliseconds
) {
    if (
        !validBindings(env) ||
        !validServiceIdentity(identity) ||
        !DRAFT_ID_PATTERN.test(draftId || '') ||
        !validAbandonmentInput(input)
    ) return failure(400, 'invalid-request');

    try {
        let receipt = await readAbandonmentByDraft(env.DB, draftId);
        if (receipt) {
            const replayFingerprint = await abandonmentFingerprint(receipt, input);
            return abandonmentReplayMatches(receipt, input, replayFingerprint)
                ? abandonmentSuccess(receipt, true, 200)
                : failure(409, 'conflict');
        }
        if (await readReviewByDraft(env.DB, draftId)) {
            return failure(409, 'conflict');
        }
        const candidate = await readCandidateReview(env.DB, draftId);
        if (
            !currentCandidateFacts(candidate) ||
            candidate.stateVersion !== input.expectedStateVersion
        ) return failure(candidate ? 409 : 404, candidate ? 'review-not-eligible' : 'not-found');

        const provisional = {
            draftId,
            promotionId: candidate.promotionId,
            processingRunId: candidate.processingRunId,
            expectedStateVersion: input.expectedStateVersion,
            resultStateVersion: input.expectedStateVersion + 1
        };
        const payloadFingerprint = await abandonmentFingerprint(provisional, input);
        const idempotencyKeyHash = await sha256Text(
            `photo-review-abandonment-idempotency-key:${input.idempotencyKey}`
        );
        const actorIdentityHash = await hashIdentity(identity);
        const subjectHash = await sha256Text(`draft:${draftId}`);
        const occurredAt = isoTime(nowMilliseconds);

        try {
            await runBatch(env.DB, [
                env.DB.prepare(`
                    INSERT INTO draft_photo_review_abandonment_receipts (
                        draft_id, promotion_id, processing_run_id,
                        expected_state_version,
                        result_state_version, failure_evidence_hash,
                        idempotency_key, idempotency_key_hash,
                        payload_fingerprint, service_actor_identity_hash,
                        created_at
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                `).bind(
                    draftId,
                    candidate.promotionId,
                    candidate.processingRunId,
                    input.expectedStateVersion,
                    input.expectedStateVersion + 1,
                    input.failureEvidenceHash,
                    input.idempotencyKey,
                    idempotencyKeyHash,
                    payloadFingerprint,
                    actorIdentityHash,
                    occurredAt
                ),
                env.DB.prepare(`
                    INSERT INTO draft_publication_references (
                        draft_id, withdrawal_kind, updated_at
                    )
                    SELECT
                        draft.draft_id,
                        CASE
                            WHEN consent.withdrawn_at IS NOT NULL
                                THEN 'consent-withdrawal'
                            WHEN EXISTS (
                                SELECT 1
                                FROM json_each(draft.athlete_ids_json) AS tag
                                JOIN pending_athlete_exclusions AS exclusion
                                  ON exclusion.athlete_id = tag.value
                                WHERE exclusion.resolved_at IS NULL
                            ) THEN 'athlete-exclusion'
                            ELSE 'editorial-removal'
                        END,
                        ?2
                    FROM gallery_drafts AS draft
                    LEFT JOIN draft_consent_attestations AS consent
                      ON consent.draft_id = draft.draft_id
                     AND consent.consent_revision = draft.active_consent_revision
                    WHERE draft.draft_id = ?1
                      AND NOT EXISTS (
                          SELECT 1 FROM draft_publication_references
                          WHERE draft_id = ?1
                      )
                `).bind(draftId, occurredAt),
                env.DB.prepare(`
                    UPDATE draft_publication_references
                       SET withdrawal_kind = CASE
                               WHEN EXISTS (
                                   SELECT 1
                                   FROM gallery_drafts AS draft
                                   JOIN draft_consent_attestations AS consent
                                     ON consent.draft_id = draft.draft_id
                                    AND consent.consent_revision =
                                        draft.active_consent_revision
                                   WHERE draft.draft_id = ?1
                                     AND consent.withdrawn_at IS NOT NULL
                               ) THEN 'consent-withdrawal'
                               WHEN withdrawal_kind IS NULL THEN
                                   CASE WHEN EXISTS (
                                       SELECT 1
                                       FROM gallery_drafts AS draft,
                                           json_each(draft.athlete_ids_json) AS tag
                                       JOIN pending_athlete_exclusions AS exclusion
                                         ON exclusion.athlete_id = tag.value
                                       WHERE draft.draft_id = ?1
                                         AND exclusion.resolved_at IS NULL
                                   ) THEN 'athlete-exclusion'
                                   ELSE 'editorial-removal' END
                               ELSE withdrawal_kind
                           END,
                           updated_at = ?2
                     WHERE draft_id = ?1
                       AND (
                           withdrawal_kind IS NULL OR
                           withdrawal_kind <> 'consent-withdrawal' AND EXISTS (
                               SELECT 1
                               FROM gallery_drafts AS draft
                               JOIN draft_consent_attestations AS consent
                                 ON consent.draft_id = draft.draft_id
                                AND consent.consent_revision =
                                    draft.active_consent_revision
                               WHERE draft.draft_id = ?1
                                 AND consent.withdrawn_at IS NOT NULL
                           )
                       )
                `).bind(draftId, occurredAt),
                env.DB.prepare(`
                    UPDATE gallery_drafts
                       SET state = 'withdrawal-pending',
                           state_version = state_version + 1,
                           updated_at = ?3
                     WHERE draft_id = ?1
                       AND state = 'candidate-public'
                       AND state_version = ?2
                       AND EXISTS (
                           SELECT 1
                           FROM draft_photo_review_abandonment_receipts
                           WHERE draft_id = ?1
                       )
                       AND NOT EXISTS (
                           SELECT 1 FROM draft_photo_review_receipts
                           WHERE draft_id = ?1
                       )
                `).bind(
                    draftId,
                    input.expectedStateVersion,
                    occurredAt
                ),
                env.DB.prepare(`
                    INSERT INTO draft_transition_receipts (
                        draft_id, idempotency_key, payload_fingerprint,
                        from_state, to_state, expected_state_version,
                        result_state_version, created_at
                    ) VALUES (
                        ?1, ?2, ?3, 'candidate-public',
                        'withdrawal-pending', ?4,
                        CASE WHEN changes() = 1 THEN ?5 ELSE ?4 END,
                        ?6
                    )
                `).bind(
                    draftId,
                    input.idempotencyKey,
                    payloadFingerprint,
                    input.expectedStateVersion,
                    input.expectedStateVersion + 1,
                    occurredAt
                ),
                auditInsert(env.DB, {
                    eventType: 'photo-review-abandoned',
                    subjectHash,
                    actorIdentityHash,
                    payloadHash: payloadFingerprint,
                    stateVersion: input.expectedStateVersion + 1,
                    occurredAt
                })
            ]);
        } catch {
            // Read back the immutable receipt below to recover a committed
            // transaction whose response was lost.
        }

        receipt = await readAbandonmentByDraft(env.DB, draftId);
        const finalContext = await readInvalidationContext(env.DB, draftId);
        return receipt &&
            finalContext?.state === 'withdrawal-pending' &&
            finalContext.stateVersion === receipt.resultStateVersion &&
            finalContext.withdrawalKind !== null &&
            abandonmentReplayMatches(receipt, input, payloadFingerprint)
            ? abandonmentSuccess(
                receipt,
                receipt.createdAt !== occurredAt,
                receipt.createdAt === occurredAt ? 201 : 200
            )
            : failure(receipt ? 409 : 503, receipt ? 'conflict' : 'service-unavailable');
    } catch {
        return failure(503, 'service-unavailable');
    }
}

export async function recordPhotoReviewOpened(
    env,
    identity,
    reviewId,
    input,
    nowMilliseconds,
    dependencies = {}
) {
    if (
        !validBindings(env) ||
        !validServiceIdentity(identity) ||
        !REVIEW_ID_PATTERN.test(reviewId || '') ||
        !validOpenInput(input)
    ) return failure(400, 'invalid-request');

    try {
        let review = await readReviewById(env.DB, reviewId);
        if (!review) return failure(404, 'not-found');
        const payloadFingerprint = await openFingerprint(review, input);
        if (review.status !== 'reserved') {
            return openReplayMatches(review, input, payloadFingerprint)
                ? success(200, { review: publicReview(review), replayed: true })
                : failure(409, 'conflict');
        }
        if (
            review.candidateStateVersion !== input.expectedStateVersion ||
            input.pullRequestUrl !==
                `https://github.com/${REPOSITORY}/pull/${input.pullRequestNumber}`
        ) return failure(409, 'conflict');

        const candidateReader = dependencies.readPhotoCandidate || readPhotoCandidate;
        const candidate = await candidateReader(env, identity, review.draftId);
        const facts = await readCandidateReview(env.DB, review.draftId);
        if (
            candidate?.ok !== true ||
            !facts ||
            !candidateReviewStillMatches(review, facts, candidate.candidate)
        ) return failure(409, 'review-not-eligible');

        const idempotencyKeyHash = await sha256Text(
            `photo-review-open-idempotency-key:${input.idempotencyKey}`
        );
        const occurredAt = nextIsoTime(nowMilliseconds, review.updatedAt);
        const actorIdentityHash = await hashIdentity(identity);
        const subjectHash = await sha256Text(`draft:${review.draftId}`);
        try {
            await runBatch(env.DB, [
                env.DB.prepare(`
                    UPDATE draft_photo_review_receipts
                       SET status = 'open', pull_request_number = ?1,
                           pull_request_url = ?2, head_sha = ?3,
                           open_evidence_hash = ?4, open_idempotency_key = ?5,
                           open_idempotency_key_hash = ?6,
                           open_payload_fingerprint = ?7,
                           updated_at = ?8, opened_at = ?8
                     WHERE review_id = ?9
                       AND status = 'reserved'
                       AND candidate_state_version = ?11
                       AND EXISTS (
                           SELECT 1
                             FROM gallery_drafts AS draft
                             JOIN draft_consent_attestations AS consent
                               ON consent.draft_id = draft.draft_id
                              AND consent.consent_revision =
                                  draft.active_consent_revision
                             JOIN draft_photo_promotions AS promotion
                               ON promotion.promotion_id = ?12
                              AND promotion.draft_id = draft.draft_id
                             JOIN draft_photo_public_generations AS generation
                               ON generation.promotion_id = promotion.promotion_id
                              AND generation.draft_id = draft.draft_id
                             LEFT JOIN draft_publication_references AS publication
                               ON publication.draft_id = draft.draft_id
                            WHERE draft.draft_id = ?10
                              AND draft.state = 'candidate-public'
                              AND draft.state_version = ?11
                              AND draft.media_type = 'photo'
                              AND draft.public_item_id = ?16
                              AND draft.item_revision = promotion.item_revision
                              AND draft.active_consent_revision =
                                  promotion.consent_revision
                              AND draft.export_bundle_id = promotion.export_bundle_id
                              AND draft.source_revision = promotion.source_revision
                              AND draft.suppression_revision =
                                  promotion.suppression_revision
                              AND consent.public_use_confirmed = 1
                              AND (
                                  consent.contains_minors = 0 OR
                                  consent.guardian_approval_confirmed = 1
                              )
                              AND consent.withdrawn_at IS NULL
                              AND publication.withdrawal_kind IS NULL
                              AND promotion.status = 'candidate'
                              AND promotion.processing_run_id = ?13
                              AND promotion.result_state_version = ?11
                              AND promotion.candidate_payload_hash = ?14
                              AND generation.candidate_state_version = ?11
                              AND generation.generation_fingerprint = ?15
                              AND (
                                  SELECT COUNT(*)
                                    FROM draft_photo_public_generation_targets AS target
                                   WHERE target.promotion_id = generation.promotion_id
                                     AND target.role IN (
                                         'photo-display', 'photo-thumbnail'
                                     )
                              ) = 2
                              AND NOT EXISTS (
                                  SELECT 1
                                    FROM json_each(draft.athlete_ids_json) AS tag
                                    JOIN pending_athlete_exclusions AS exclusion
                                      ON exclusion.athlete_id = tag.value
                                   WHERE exclusion.resolved_at IS NULL
                              )
                              AND NOT EXISTS (
                                  SELECT 1
                                    FROM draft_photo_promotion_cleanups AS cleanup
                                   WHERE cleanup.promotion_id = promotion.promotion_id
                              )
                       )
                `).bind(
                    input.pullRequestNumber,
                    input.pullRequestUrl,
                    input.headSha,
                    input.openEvidenceHash,
                    input.idempotencyKey,
                    idempotencyKeyHash,
                    payloadFingerprint,
                    occurredAt,
                    reviewId,
                    review.draftId,
                    input.expectedStateVersion,
                    review.promotionId,
                    review.processingRunId,
                    review.candidatePayloadHash,
                    review.generationFingerprint,
                    review.itemId
                ),
                reviewOpenAuditInsert(env.DB, {
                    reviewId,
                    subjectHash,
                    actorIdentityHash,
                    payloadHash: payloadFingerprint,
                    stateVersion: review.candidateStateVersion,
                    occurredAt
                })
            ]);
        } catch {
            // The exact readback below distinguishes a lost response from a
            // competing or malformed write.
        }
        review = await readReviewById(env.DB, reviewId);
        const replayed = Boolean(review) && (
            review.status !== 'open' || review.openedAt !== occurredAt
        );
        return review && openReplayMatches(review, input, payloadFingerprint)
            ? success(replayed ? 200 : 201, {
                review: publicReview(review),
                replayed
            })
            : failure(409, 'conflict');
    } catch {
        return failure(503, 'service-unavailable');
    }
}

export async function readPhotoReviewInvalidation(env, identity, draftId) {
    if (
        !validBindings(env) ||
        !validServiceIdentity(identity) ||
        !DRAFT_ID_PATTERN.test(draftId || '')
    ) return failure(400, 'invalid-request');

    try {
        const [review, abandonment] = await Promise.all([
            readReviewByDraft(env.DB, draftId),
            readAbandonmentByDraft(env.DB, draftId)
        ]);
        if (review && abandonment) return failure(503, 'service-unavailable');
        if (review) {
            const context = await readInvalidationContext(env.DB, draftId);
            if (!context) return failure(503, 'service-unavailable');
            return success(200, {
                receiptKind: 'review',
                review: publicReview(review),
                invalidation: deriveInvalidation(review, context),
                replayed: true
            });
        }
        if (abandonment) {
            const recovered = abandonmentSuccess(abandonment, true, 200);
            return success(200, {
                receiptKind: 'abandonment',
                abandonment: recovered.abandonment,
                cleanup: recovered.cleanup,
                processingCleanup: recovered.processingCleanup,
                replayed: true
            });
        }
        return failure(404, 'not-found');
    } catch {
        return failure(503, 'service-unavailable');
    }
}

export async function startPhotoReviewInvalidation(
    env,
    identity,
    reviewId,
    input,
    nowMilliseconds
) {
    if (
        !validBindings(env) ||
        !validServiceIdentity(identity) ||
        !REVIEW_ID_PATTERN.test(reviewId || '') ||
        !validInvalidationStartInput(input)
    ) return failure(400, 'invalid-request');

    try {
        const review = await readReviewById(env.DB, reviewId);
        if (!review) return failure(404, 'not-found');
        const payloadFingerprint = await invalidationStartFingerprint(review, input);
        let receipt = await readTransitionReceipt(
            env.DB,
            review.draftId,
            input.idempotencyKey
        );
        if (receipt) {
            return invalidationStartReplayMatches(
                review,
                receipt,
                input,
                payloadFingerprint
            )
                ? invalidationStartReadback(env.DB, review, receipt, true, 200)
                : failure(409, 'conflict');
        }
        if (
            !['reserved', 'open'].includes(review.status) ||
            review.candidateStateVersion !== input.expectedStateVersion
        ) return failure(409, 'conflict');

        const context = await readInvalidationContext(env.DB, review.draftId);
        if (
            !context ||
            context.state !== 'candidate-public' ||
            context.stateVersion !== review.candidateStateVersion
        ) return failure(409, 'conflict');

        const occurredAt = nextIsoTime(nowMilliseconds, review.updatedAt);
        const actorIdentityHash = await hashIdentity(identity);
        const subjectHash = await sha256Text(`draft:${review.draftId}`);
        let transactionReturned = false;
        try {
            await runBatch(env.DB, [
                ...reviewInvalidationIntentStatements(
                    env.DB,
                    review,
                    occurredAt
                ),
                env.DB.prepare(`
                    UPDATE gallery_drafts
                       SET state = 'withdrawal-pending',
                           state_version = state_version + 1,
                           updated_at = ?3
                     WHERE draft_id = ?1
                       AND state = 'candidate-public'
                       AND state_version = ?2
                       AND EXISTS (
                           SELECT 1
                             FROM draft_photo_review_receipts AS receipt
                            WHERE receipt.review_id = ?4
                              AND receipt.draft_id = ?1
                              AND receipt.candidate_state_version = ?2
                              AND receipt.status IN ('reserved', 'open')
                       )
                `).bind(
                    review.draftId,
                    input.expectedStateVersion,
                    occurredAt,
                    reviewId
                ),
                env.DB.prepare(`
                    INSERT INTO draft_transition_receipts (
                        draft_id, idempotency_key, payload_fingerprint,
                        from_state, to_state, expected_state_version,
                        result_state_version, created_at
                    ) VALUES (
                        ?1, ?2, ?3, 'candidate-public',
                        'withdrawal-pending', ?4,
                        CASE WHEN changes() = 1 THEN ?5 ELSE ?4 END,
                        ?6
                    )
                `).bind(
                    review.draftId,
                    input.idempotencyKey,
                    payloadFingerprint,
                    input.expectedStateVersion,
                    input.expectedStateVersion + 1,
                    occurredAt
                ),
                auditInsert(env.DB, {
                    eventType: 'photo-review-invalidation-started',
                    subjectHash,
                    actorIdentityHash,
                    payloadHash: payloadFingerprint,
                    stateVersion: input.expectedStateVersion + 1,
                    occurredAt
                })
            ]);
            transactionReturned = true;
        } catch {
            // Exact receipt readback below recovers a committed lost response.
        }

        receipt = await readTransitionReceipt(
            env.DB,
            review.draftId,
            input.idempotencyKey
        );
        if (!receipt || !invalidationStartReplayMatches(
            review,
            receipt,
            input,
            payloadFingerprint
        )) return failure(receipt ? 409 : 503, receipt ? 'conflict' : 'service-unavailable');
        return await invalidationStartReadback(
            env.DB,
            review,
            receipt,
            !transactionReturned,
            transactionReturned ? 201 : 200
        );
    } catch {
        return failure(503, 'service-unavailable');
    }
}

export async function recordPhotoReviewTerminal(
    env,
    identity,
    reviewId,
    input,
    nowMilliseconds
) {
    if (
        !validBindings(env) ||
        !validServiceIdentity(identity) ||
        !REVIEW_ID_PATTERN.test(reviewId || '') ||
        !validTerminalInput(input)
    ) return failure(400, 'invalid-request');

    try {
        let review = await readReviewById(env.DB, reviewId);
        if (!review) return failure(404, 'not-found');
        const payloadFingerprint = await terminalFingerprint(review, input);
        if (review.status === 'terminal') {
            const terminalContext = await readInvalidationContext(
                env.DB,
                review.draftId
            );
            const terminalInvalidation = deriveInvalidation(review, terminalContext);
            return terminalReplayMatches(review, input, payloadFingerprint) &&
                terminalInvalidation
                ? success(200, {
                    review: publicReview(review),
                    cleanup: terminalInvalidation.cleanup,
                    processingCleanup: terminalInvalidation.processingCleanup,
                    replayed: true
                })
                : failure(409, 'conflict');
        }
        const context = await readInvalidationContext(env.DB, review.draftId);
        if (!context) return failure(404, 'not-found');
        if (
            (input.terminalKind === 'no-pr-created' && review.status !== 'reserved') ||
            (input.terminalKind === 'closed-unmerged' &&
                !['reserved', 'open'].includes(review.status)) ||
            (review.status === 'open' && !terminalPullMatchesReview(review, input))
        ) return failure(409, 'conflict');

        const idempotencyKeyHash = await sha256Text(
            `photo-review-terminal-idempotency-key:${input.idempotencyKey}`
        );
        const occurredAt = nextIsoTime(nowMilliseconds, review.updatedAt);
        const actorIdentityHash = await hashIdentity(identity);
        const subjectHash = await sha256Text(`draft:${review.draftId}`);
        const intentStatements = terminalIntentStatements(
            env.DB,
            review,
            context,
            occurredAt,
            input.idempotencyKey,
            payloadFingerprint
        );
        if (intentStatements === null) {
            return failure(409, 'conflict');
        }
        try {
            await runBatch(env.DB, [
                ...intentStatements,
                env.DB.prepare(`
                    UPDATE draft_photo_review_receipts
                       SET status = 'terminal', terminal_kind = ?1,
                           terminal_evidence_hash = ?2,
                           close_evidence_hash = ?3,
                           readback_evidence_hash = ?4,
                           pull_request_number = COALESCE(
                               pull_request_number, ?5
                           ),
                           pull_request_url = COALESCE(pull_request_url, ?6),
                           head_sha = COALESCE(head_sha, ?7),
                           terminal_idempotency_key = ?8,
                           terminal_idempotency_key_hash = ?9,
                           terminal_payload_fingerprint = ?10,
                           updated_at = ?11, terminal_at = ?11
                     WHERE review_id = ?12 AND status = ?13
                `).bind(
                    input.terminalKind,
                    input.terminalEvidenceHash,
                    input.closeEvidenceHash,
                    input.readbackEvidenceHash,
                    input.pullRequestNumber,
                    input.pullRequestUrl,
                    input.headSha,
                    input.idempotencyKey,
                    idempotencyKeyHash,
                    payloadFingerprint,
                    occurredAt,
                    reviewId,
                    review.status
                ),
                auditInsert(env.DB, {
                    eventType: 'photo-review-terminal',
                    subjectHash,
                    actorIdentityHash,
                    payloadHash: payloadFingerprint,
                    stateVersion: context.stateVersion,
                    occurredAt
                })
            ]);
        } catch {
            // Read back below; migration guards are the final CAS boundary.
        }
        review = await readReviewById(env.DB, reviewId);
        const finalContext = await readInvalidationContext(env.DB, review?.draftId);
        const finalInvalidation = deriveInvalidation(review, finalContext);
        const replayed = Boolean(review) && review.terminalAt !== occurredAt;
        return review &&
            finalInvalidation &&
            terminalReplayMatches(review, input, payloadFingerprint)
            ? success(replayed ? 200 : 201, {
                review: publicReview(review),
                cleanup: finalInvalidation.cleanup,
                processingCleanup: finalInvalidation.processingCleanup,
                replayed
            })
            : failure(409, 'conflict');
    } catch {
        return failure(503, 'service-unavailable');
    }
}

async function deriveReservation(facts, candidate) {
    if (!currentCandidateFacts(facts) || !isPlainObject(candidate)) return null;
    let sites;
    try {
        sites = JSON.parse(facts.siteModesJson);
    } catch {
        return null;
    }
    if (
        candidate.schemaVersion !== '1.0' ||
        candidate.operationId !== facts.promotionId ||
        candidate.draft?.draftId !== facts.draftId ||
        candidate.draft?.state !== 'candidate-public' ||
        candidate.draft?.stateVersion !== facts.stateVersion ||
        !Array.isArray(sites) ||
        sites.length !== 1 ||
        !Object.hasOwn(TARGET_PATHS, sites[0]) ||
        !ITEM_ID_PATTERN.test(facts.itemId || '')
    ) return null;
    return {
        branchRef: await deriveBranchRef(facts.promotionId),
        operationMarkerHash: await sha256Text(
            `family-running-gallery-review-operation-v1\0${facts.promotionId}`
        ),
        targetRelativePath: TARGET_PATHS[sites[0]]
    };
}

function currentCandidateFacts(facts) {
    return Boolean(facts) &&
        PROMOTION_ID_PATTERN.test(facts.promotionId || '') &&
        PROCESSING_RUN_ID_PATTERN.test(facts.processingRunId || '') &&
        SHA256_PATTERN.test(facts.candidatePayloadHash || '') &&
        SHA256_PATTERN.test(facts.generationFingerprint || '') &&
        facts.promotionStatus === 'candidate' &&
        facts.state === 'candidate-public' &&
        Number.isSafeInteger(facts.stateVersion) &&
        facts.stateVersion >= 0 &&
        facts.generationCandidateStateVersion === facts.stateVersion &&
        facts.activeConsentRevision !== null &&
        facts.consentWithdrawnAt === null &&
        facts.withdrawalKind === null &&
        facts.pendingExclusionCount === 0 &&
        facts.cleanupCount === 0;
}

function candidateReviewStillMatches(review, facts, candidate) {
    return currentCandidateFacts(facts) &&
        facts.promotionId === review.promotionId &&
        facts.processingRunId === review.processingRunId &&
        facts.stateVersion === review.candidateStateVersion &&
        facts.candidatePayloadHash === review.candidatePayloadHash &&
        facts.generationFingerprint === review.generationFingerprint &&
        candidate?.operationId === review.promotionId &&
        candidate?.draft?.draftId === review.draftId &&
        candidate?.draft?.stateVersion === review.candidateStateVersion;
}

function deriveInvalidation(review, context) {
    if (!review || !context || context.draftId !== review.draftId) return null;
    const withdrawalKind = deriveWithdrawalKind(context);
    if (!withdrawalKind) return null;
    return {
        withdrawalKind,
        terminalKind: review.status === 'open'
            ? 'closed-unmerged'
            : review.status === 'reserved'
                ? 'no-pr-created'
                : review.terminalKind,
        cleanup: {
            promotionId: review.promotionId,
            expectedStateVersion: review.candidateStateVersion + 1,
            idempotencyKey: deriveCleanupIdempotencyKey(review)
        },
        processingCleanup: {
            processingRunId: review.processingRunId,
            expectedStateVersion: review.candidateStateVersion + 1,
            idempotencyKey: deriveProcessingCleanupIdempotencyKey(review)
        }
    };
}

function deriveWithdrawalKind(context) {
    if (!context) return null;
    if (
        context.consentWithdrawnAt !== null ||
        context.withdrawalKind === 'consent-withdrawal'
    ) return 'consent-withdrawal';
    if (
        context.pendingExclusionCount > 0 ||
        context.withdrawalKind === 'athlete-exclusion'
    ) return 'athlete-exclusion';
    if (
        context.withdrawalKind === 'editorial-removal' ||
        (context.state === 'withdrawal-pending' && context.withdrawalKind === null)
    ) return 'editorial-removal';
    return null;
}

function reviewInvalidationIntentStatements(database, review, occurredAt) {
    return [
        database.prepare(`
            INSERT INTO draft_publication_references (
                draft_id, withdrawal_kind, updated_at
            )
            SELECT
                draft.draft_id,
                CASE
                    WHEN consent.withdrawn_at IS NOT NULL
                        THEN 'consent-withdrawal'
                    WHEN EXISTS (
                        SELECT 1
                          FROM json_each(draft.athlete_ids_json) AS tag
                          JOIN pending_athlete_exclusions AS exclusion
                            ON exclusion.athlete_id = tag.value
                         WHERE exclusion.resolved_at IS NULL
                    ) THEN 'athlete-exclusion'
                    ELSE 'editorial-removal'
                END,
                ?3
              FROM gallery_drafts AS draft
              JOIN draft_photo_review_receipts AS receipt
                ON receipt.draft_id = draft.draft_id
               AND receipt.review_id = ?4
               AND receipt.candidate_state_version = ?2
               AND receipt.status IN ('reserved', 'open')
              LEFT JOIN draft_consent_attestations AS consent
                ON consent.draft_id = draft.draft_id
               AND consent.consent_revision = draft.active_consent_revision
             WHERE draft.draft_id = ?1
               AND draft.state = 'candidate-public'
               AND draft.state_version = ?2
               AND NOT EXISTS (
                   SELECT 1 FROM draft_publication_references
                    WHERE draft_id = ?1
               )
        `).bind(
            review.draftId,
            review.candidateStateVersion,
            occurredAt,
            review.reviewId
        ),
        database.prepare(`
            UPDATE draft_publication_references
               SET withdrawal_kind = CASE
                       WHEN EXISTS (
                           SELECT 1
                             FROM gallery_drafts AS draft
                             JOIN draft_consent_attestations AS consent
                               ON consent.draft_id = draft.draft_id
                              AND consent.consent_revision =
                                  draft.active_consent_revision
                            WHERE draft.draft_id = ?1
                              AND consent.withdrawn_at IS NOT NULL
                       ) THEN 'consent-withdrawal'
                       WHEN withdrawal_kind IS NULL AND EXISTS (
                           SELECT 1
                             FROM gallery_drafts AS draft,
                                  json_each(draft.athlete_ids_json) AS tag
                             JOIN pending_athlete_exclusions AS exclusion
                               ON exclusion.athlete_id = tag.value
                            WHERE draft.draft_id = ?1
                              AND exclusion.resolved_at IS NULL
                       ) THEN 'athlete-exclusion'
                       WHEN withdrawal_kind IS NULL THEN 'editorial-removal'
                       ELSE withdrawal_kind
                   END,
                   updated_at = ?3
             WHERE draft_id = ?1
               AND EXISTS (
                   SELECT 1
                     FROM gallery_drafts AS draft
                     JOIN draft_photo_review_receipts AS receipt
                       ON receipt.draft_id = draft.draft_id
                      AND receipt.review_id = ?4
                      AND receipt.candidate_state_version = ?2
                      AND receipt.status IN ('reserved', 'open')
                    WHERE draft.draft_id = ?1
                      AND draft.state = 'candidate-public'
                      AND draft.state_version = ?2
               )
               AND (
                   withdrawal_kind IS NULL OR
                   withdrawal_kind <> 'consent-withdrawal' AND EXISTS (
                       SELECT 1
                         FROM gallery_drafts AS draft
                         JOIN draft_consent_attestations AS consent
                           ON consent.draft_id = draft.draft_id
                          AND consent.consent_revision =
                              draft.active_consent_revision
                        WHERE draft.draft_id = ?1
                          AND consent.withdrawn_at IS NOT NULL
                   )
               )
        `).bind(
            review.draftId,
            review.candidateStateVersion,
            occurredAt,
            review.reviewId
        )
    ];
}

async function invalidationStartReadback(
    database,
    review,
    receipt,
    replayed,
    status
) {
    const context = await readInvalidationContext(database, review.draftId);
    const withdrawalKind = deriveWithdrawalKind(context);
    if (
        !withdrawalKind ||
        !context ||
        !['withdrawal-pending', 'withdrawn'].includes(context.state) ||
        context.stateVersion < receipt.resultStateVersion
    ) return failure(409, 'conflict');
    return success(status, {
        review: publicReview(review),
        invalidationStart: {
            withdrawalKind,
            expectedStateVersion: receipt.expectedStateVersion,
            resultStateVersion: receipt.resultStateVersion,
            cleanup: {
                promotionId: review.promotionId,
                expectedStateVersion: receipt.resultStateVersion,
                idempotencyKey: deriveCleanupIdempotencyKey(review)
            },
            processingCleanup: {
                processingRunId: review.processingRunId,
                expectedStateVersion: receipt.resultStateVersion,
                idempotencyKey: deriveProcessingCleanupIdempotencyKey(review)
            }
        },
        replayed
    });
}

function terminalIntentStatements(
    database,
    review,
    context,
    occurredAt,
    idempotencyKey,
    payloadFingerprint
) {
    if (
        !context ||
        context.draftId !== review.draftId ||
        !['candidate-public', 'withdrawal-pending'].includes(context.state) ||
        (context.state === 'candidate-public' &&
            context.stateVersion !== review.candidateStateVersion)
    ) return null;

    const desiredIntent = context.consentWithdrawnAt !== null ||
        context.withdrawalKind === 'consent-withdrawal'
        ? 'consent-withdrawal'
        : context.pendingExclusionCount > 0 ||
            context.withdrawalKind === 'athlete-exclusion'
            ? 'athlete-exclusion'
            : 'editorial-removal';

    const statements = [
        database.prepare(`
            INSERT INTO draft_publication_references (
                draft_id, withdrawal_kind, updated_at
            )
            SELECT ?1, ?2, ?3
             WHERE NOT EXISTS (
                SELECT 1 FROM draft_publication_references
                 WHERE draft_id = ?1
             )
        `).bind(review.draftId, desiredIntent, occurredAt),
        database.prepare(`
            UPDATE draft_publication_references
               SET withdrawal_kind = CASE
                       WHEN withdrawal_kind IS NULL THEN ?2
                       WHEN ?2 = 'consent-withdrawal' AND
                            withdrawal_kind <> 'consent-withdrawal'
                           THEN 'consent-withdrawal'
                       ELSE withdrawal_kind
                   END,
                   updated_at = ?3
             WHERE draft_id = ?1
               AND (
                   withdrawal_kind IS NULL OR
                   (?2 = 'consent-withdrawal' AND
                    withdrawal_kind <> 'consent-withdrawal')
               )
        `).bind(review.draftId, desiredIntent, occurredAt)
    ];
    if (context.state === 'candidate-public') {
        statements.push(database.prepare(`
            UPDATE gallery_drafts
               SET state = 'withdrawal-pending',
                   state_version = state_version + 1,
                   updated_at = ?3
             WHERE draft_id = ?1
               AND state = 'candidate-public'
               AND state_version = ?2
        `).bind(
            review.draftId,
            review.candidateStateVersion,
            occurredAt
        ));
        statements.push(database.prepare(`
            INSERT INTO draft_transition_receipts (
                draft_id, idempotency_key, payload_fingerprint,
                from_state, to_state, expected_state_version,
                result_state_version, created_at
            ) VALUES (
                ?1, ?2, ?3, 'candidate-public', 'withdrawal-pending', ?4,
                CASE WHEN changes() = 1 THEN ?5 ELSE ?4 END, ?6
            )
        `).bind(
            review.draftId,
            idempotencyKey,
            payloadFingerprint,
            review.candidateStateVersion,
            review.candidateStateVersion + 1,
            occurredAt
        ));
    }
    return statements;
}

function deriveCleanupIdempotencyKey(review) {
    return `photo-review-cleanup-${review.operationMarkerHash.slice(0, 32)}`;
}

function deriveProcessingCleanupIdempotencyKey(review) {
    return `photo-review-staging-${review.operationMarkerHash.slice(0, 32)}`;
}

function abandonmentSuccess(receipt, replayed, status) {
    return success(status, {
        abandonment: {
            schemaVersion: '1.0',
            draftId: receipt.draftId,
            promotionId: receipt.promotionId,
            processingRunId: receipt.processingRunId,
            expectedStateVersion: receipt.expectedStateVersion,
            resultStateVersion: receipt.resultStateVersion,
            failureEvidenceHash: receipt.failureEvidenceHash,
            status: 'withdrawal-pending'
        },
        cleanup: {
            promotionId: receipt.promotionId,
            expectedStateVersion: receipt.resultStateVersion,
            idempotencyKey:
                `photo-review-cleanup-${receipt.payloadFingerprint.slice(0, 32)}`
        },
        processingCleanup: {
            processingRunId: receipt.processingRunId,
            expectedStateVersion: receipt.resultStateVersion,
            idempotencyKey:
                `photo-review-staging-${receipt.payloadFingerprint.slice(0, 32)}`
        },
        replayed
    });
}

async function deriveBranchRef(promotionId) {
    const hash = await sha256Text(
        `family-running-gallery-review-branch-v1\0${promotionId}`
    );
    return `gallery-media/candidate-${hash.slice(0, 32)}`;
}

function publicReview(row) {
    return {
        schemaVersion: '1.0',
        reviewId: row.reviewId,
        draftId: row.draftId,
        promotionId: row.promotionId,
        processingRunId: row.processingRunId,
        candidateStateVersion: row.candidateStateVersion,
        candidatePayloadHash: row.candidatePayloadHash,
        generationFingerprint: row.generationFingerprint,
        repository: row.repository,
        baseRef: row.baseRef,
        baseSha: row.baseSha,
        branchRef: row.branchRef,
        targetRelativePath: row.targetRelativePath,
        itemId: row.itemId,
        manifestSha256: row.manifestSha256,
        operationMarkerHash: row.operationMarkerHash,
        workflowRunReference: row.workflowRunReference,
        status: row.status,
        pullRequestNumber: row.pullRequestNumber ?? null,
        pullRequestUrl: row.pullRequestUrl ?? null,
        headSha: row.headSha ?? null,
        openEvidenceHash: row.openEvidenceHash ?? null,
        terminalKind: row.terminalKind ?? null,
        terminalEvidenceHash: row.terminalEvidenceHash ?? null,
        closeEvidenceHash: row.closeEvidenceHash ?? null,
        readbackEvidenceHash: row.readbackEvidenceHash ?? null
    };
}

async function reservationFingerprint(review, input) {
    return fingerprint({
        operation: 'photo-review-reservation',
        draftId: review.draftId,
        promotionId: review.promotionId,
        processingRunId: review.processingRunId,
        candidateStateVersion: review.candidateStateVersion,
        candidatePayloadHash: review.candidatePayloadHash,
        generationFingerprint: review.generationFingerprint,
        repository: review.repository,
        baseRef: review.baseRef,
        baseSha: input.baseSha,
        branchRef: review.branchRef,
        targetRelativePath: review.targetRelativePath,
        itemId: review.itemId,
        manifestSha256: input.manifestSha256,
        operationMarkerHash: review.operationMarkerHash,
        workflowRunReference: input.workflowRunReference,
        expectedStateVersion: input.expectedStateVersion,
        idempotencyKey: input.idempotencyKey
    });
}

function reservationReplayMatches(review, input, fingerprintValue) {
    return review.candidateStateVersion === input.expectedStateVersion &&
        review.baseSha === input.baseSha &&
        review.manifestSha256 === input.manifestSha256 &&
        review.workflowRunReference === input.workflowRunReference &&
        review.reservationIdempotencyKey === input.idempotencyKey &&
        review.reservationPayloadFingerprint === fingerprintValue;
}

async function openFingerprint(review, input) {
    return fingerprint({
        operation: 'photo-review-open',
        reviewId: review.reviewId,
        draftId: review.draftId,
        promotionId: review.promotionId,
        expectedStateVersion: input.expectedStateVersion,
        headSha: input.headSha,
        pullRequestNumber: input.pullRequestNumber,
        pullRequestUrl: input.pullRequestUrl,
        openEvidenceHash: input.openEvidenceHash,
        idempotencyKey: input.idempotencyKey
    });
}

function openReplayMatches(review, input, fingerprintValue) {
    return ['open', 'terminal'].includes(review.status) &&
        review.candidateStateVersion === input.expectedStateVersion &&
        review.headSha === input.headSha &&
        review.pullRequestNumber === input.pullRequestNumber &&
        review.pullRequestUrl === input.pullRequestUrl &&
        review.openEvidenceHash === input.openEvidenceHash &&
        review.openIdempotencyKey === input.idempotencyKey &&
        review.openPayloadFingerprint === fingerprintValue;
}

async function terminalFingerprint(review, input) {
    return fingerprint({
        operation: 'photo-review-terminal',
        reviewId: review.reviewId,
        draftId: review.draftId,
        promotionId: review.promotionId,
        terminalKind: input.terminalKind,
        terminalEvidenceHash: input.terminalEvidenceHash,
        closeEvidenceHash: input.closeEvidenceHash,
        readbackEvidenceHash: input.readbackEvidenceHash,
        headSha: input.headSha,
        pullRequestNumber: input.pullRequestNumber,
        pullRequestUrl: input.pullRequestUrl,
        idempotencyKey: input.idempotencyKey
    });
}

async function invalidationStartFingerprint(review, input) {
    return fingerprint({
        operation: 'photo-review-invalidation-start',
        reviewId: review.reviewId,
        draftId: review.draftId,
        promotionId: review.promotionId,
        processingRunId: review.processingRunId,
        candidateStateVersion: review.candidateStateVersion,
        candidatePayloadHash: review.candidatePayloadHash,
        generationFingerprint: review.generationFingerprint,
        operationMarkerHash: review.operationMarkerHash,
        expectedStateVersion: input.expectedStateVersion,
        idempotencyKey: input.idempotencyKey
    });
}

async function abandonmentFingerprint(receipt, input) {
    return fingerprint({
        operation: 'photo-review-abandonment',
        draftId: receipt.draftId,
        promotionId: receipt.promotionId,
        processingRunId: receipt.processingRunId,
        expectedStateVersion: input.expectedStateVersion,
        resultStateVersion: input.expectedStateVersion + 1,
        failureEvidenceHash: input.failureEvidenceHash,
        idempotencyKey: input.idempotencyKey
    });
}

function abandonmentReplayMatches(receipt, input, fingerprintValue) {
    return receipt.expectedStateVersion === input.expectedStateVersion &&
        receipt.resultStateVersion === input.expectedStateVersion + 1 &&
        receipt.failureEvidenceHash === input.failureEvidenceHash &&
        receipt.idempotencyKey === input.idempotencyKey &&
        receipt.payloadFingerprint === fingerprintValue;
}

function invalidationStartReplayMatches(review, receipt, input, fingerprintValue) {
    return receipt.draftId === review.draftId &&
        receipt.idempotencyKey === input.idempotencyKey &&
        receipt.payloadFingerprint === fingerprintValue &&
        receipt.fromState === 'candidate-public' &&
        receipt.toState === 'withdrawal-pending' &&
        receipt.expectedStateVersion === input.expectedStateVersion &&
        receipt.expectedStateVersion === review.candidateStateVersion &&
        receipt.resultStateVersion === input.expectedStateVersion + 1;
}

function terminalReplayMatches(review, input, fingerprintValue) {
    return review.status === 'terminal' &&
        review.terminalKind === input.terminalKind &&
        review.terminalEvidenceHash === input.terminalEvidenceHash &&
        review.closeEvidenceHash === input.closeEvidenceHash &&
        review.readbackEvidenceHash === input.readbackEvidenceHash &&
        review.headSha === input.headSha &&
        review.pullRequestNumber === input.pullRequestNumber &&
        review.pullRequestUrl === input.pullRequestUrl &&
        review.terminalIdempotencyKey === input.idempotencyKey &&
        review.terminalPayloadFingerprint === fingerprintValue;
}

function terminalPullMatchesReview(review, input) {
    return review.headSha === input.headSha &&
        review.pullRequestNumber === input.pullRequestNumber &&
        review.pullRequestUrl === input.pullRequestUrl;
}

function validReservationInput(input) {
    return isPlainObject(input) &&
        hasExactKeys(input, RESERVATION_INPUT_KEYS) &&
        Number.isSafeInteger(input.expectedStateVersion) &&
        input.expectedStateVersion >= 0 &&
        COMMIT_SHA_PATTERN.test(input.baseSha || '') &&
        MANIFEST_SHA256_PATTERN.test(input.manifestSha256 || '') &&
        WORKFLOW_RUN_PATTERN.test(input.workflowRunReference || '') &&
        IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey || '');
}

function validOpenInput(input) {
    return isPlainObject(input) &&
        hasExactKeys(input, OPEN_INPUT_KEYS) &&
        Number.isSafeInteger(input.expectedStateVersion) &&
        input.expectedStateVersion >= 0 &&
        COMMIT_SHA_PATTERN.test(input.headSha || '') &&
        Number.isSafeInteger(input.pullRequestNumber) &&
        input.pullRequestNumber >= 1 &&
        input.pullRequestNumber <= 2147483647 &&
        input.pullRequestUrl ===
            `https://github.com/${REPOSITORY}/pull/${input.pullRequestNumber}` &&
        SHA256_PATTERN.test(input.openEvidenceHash || '') &&
        IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey || '');
}

function validTerminalInput(input) {
    if (
        !isPlainObject(input) ||
        !hasExactKeys(input, TERMINAL_INPUT_KEYS) ||
        !['closed-unmerged', 'no-pr-created'].includes(input.terminalKind) ||
        !SHA256_PATTERN.test(input.terminalEvidenceHash || '') ||
        !IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey || '')
    ) return false;
    return input.terminalKind === 'closed-unmerged'
        ? SHA256_PATTERN.test(input.closeEvidenceHash || '') &&
            SHA256_PATTERN.test(input.readbackEvidenceHash || '') &&
            COMMIT_SHA_PATTERN.test(input.headSha || '') &&
            Number.isSafeInteger(input.pullRequestNumber) &&
            input.pullRequestNumber >= 1 &&
            input.pullRequestNumber <= 2147483647 &&
            input.pullRequestUrl ===
                `https://github.com/${REPOSITORY}/pull/${input.pullRequestNumber}`
        : input.closeEvidenceHash === null &&
            input.readbackEvidenceHash === null &&
            input.headSha === null &&
            input.pullRequestNumber === null &&
            input.pullRequestUrl === null;
}

function validAbandonmentInput(input) {
    return isPlainObject(input) &&
        hasExactKeys(input, ABANDONMENT_INPUT_KEYS) &&
        Number.isSafeInteger(input.expectedStateVersion) &&
        input.expectedStateVersion >= 0 &&
        SHA256_PATTERN.test(input.failureEvidenceHash || '') &&
        IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey || '');
}

function validInvalidationStartInput(input) {
    return isPlainObject(input) &&
        hasExactKeys(input, INVALIDATION_START_INPUT_KEYS) &&
        Number.isSafeInteger(input.expectedStateVersion) &&
        input.expectedStateVersion >= 0 &&
        IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey || '');
}

function validBindings(env) {
    return Boolean(env?.DB) &&
        typeof env.DB.prepare === 'function' &&
        typeof env.DB.batch === 'function' &&
        Boolean(env.APPROVED_MEDIA) &&
        typeof env.APPROVED_MEDIA.head === 'function' &&
        typeof env.APPROVED_MEDIA.get === 'function';
}

function validServiceIdentity(identity) {
    return Boolean(identity) &&
        identity.type === 'service' &&
        typeof identity.subject === 'string' &&
        SAFE_SERVICE_SUBJECT_PATTERN.test(identity.subject);
}

async function readReviewByDraft(database, draftId) {
    return queryFirst(database, `${REVIEW_SELECT} WHERE draft_id = ?1`, draftId);
}

async function readReviewById(database, reviewId) {
    return queryFirst(database, `${REVIEW_SELECT} WHERE review_id = ?1`, reviewId);
}

async function readAbandonmentByDraft(database, draftId) {
    return queryFirst(database, `${ABANDONMENT_SELECT} WHERE draft_id = ?1`, draftId);
}

async function readTransitionReceipt(database, draftId, idempotencyKey) {
    return queryFirst(
        database,
        `${TRANSITION_RECEIPT_SELECT} WHERE draft_id = ?1 AND idempotency_key = ?2`,
        draftId,
        idempotencyKey
    );
}

async function readCandidateReview(database, draftId) {
    return queryFirst(database, CANDIDATE_REVIEW_SELECT, draftId);
}

async function readInvalidationContext(database, draftId) {
    return queryFirst(database, INVALIDATION_SELECT, draftId);
}

async function queryFirst(database, sql, ...bindings) {
    const statement = database.prepare(sql).bind(...bindings);
    if (typeof statement.first === 'function') return statement.first();
    const result = await statement.all();
    return result?.results?.[0] || null;
}

function auditInsert(database, {
    eventType,
    subjectHash,
    actorIdentityHash,
    payloadHash,
    stateVersion,
    occurredAt
}) {
    return database.prepare(`
        INSERT INTO gallery_audit_events (
            audit_event_id, subject_reference_hash, event_type,
            state_version, actor_identity_hash, payload_hash, occurred_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    `).bind(
        randomIdentifier('audit'),
        subjectHash,
        eventType,
        stateVersion,
        actorIdentityHash,
        payloadHash,
        occurredAt
    );
}

function reviewOpenAuditInsert(database, {
    reviewId,
    subjectHash,
    actorIdentityHash,
    payloadHash,
    stateVersion,
    occurredAt
}) {
    return database.prepare(`
        INSERT INTO gallery_audit_events (
            audit_event_id, subject_reference_hash, event_type,
            state_version, actor_identity_hash, payload_hash, occurred_at
        )
        SELECT ?1, ?2, 'photo-review-opened', ?3, ?4, ?5, ?6
         WHERE EXISTS (
             SELECT 1
               FROM draft_photo_review_receipts AS review
              WHERE review.review_id = ?7
                AND review.status IN ('open', 'terminal')
                AND review.candidate_state_version = ?3
                AND review.open_payload_fingerprint = ?5
         )
           AND NOT EXISTS (
             SELECT 1
               FROM gallery_audit_events AS existing
              WHERE existing.subject_reference_hash = ?2
                AND existing.event_type = 'photo-review-opened'
                AND existing.state_version = ?3
                AND existing.actor_identity_hash = ?4
                AND existing.payload_hash = ?5
         )
    `).bind(
        randomIdentifier('audit'),
        subjectHash,
        stateVersion,
        actorIdentityHash,
        payloadHash,
        occurredAt,
        reviewId
    );
}

async function runBatch(database, statements) {
    const results = await database.batch(statements);
    if (
        !Array.isArray(results) ||
        results.length !== statements.length ||
        results.some(result => result?.success === false)
    ) throw new Error('Photo review transaction failed.');
    return results;
}

async function fingerprint(value) {
    return sha256Text(JSON.stringify(value));
}

async function sha256Text(value) {
    return sha256Hex(textEncoder.encode(value));
}

function randomIdentifier(prefix) {
    return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function isoTime(nowMilliseconds) {
    const value = Number.isFinite(nowMilliseconds) ? nowMilliseconds : Date.now();
    return new Date(value).toISOString();
}

function nextIsoTime(nowMilliseconds, previousTimestamp) {
    const requested = Number.isFinite(nowMilliseconds) ? nowMilliseconds : Date.now();
    const previous = Date.parse(previousTimestamp || '');
    return new Date(Math.max(
        requested,
        Number.isFinite(previous) ? previous + 1 : requested
    )).toISOString();
}

function hasExactKeys(value, keys) {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length &&
        actual.every((key, index) => key === expected[index]);
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function success(status, body) {
    return { ok: true, status, ...body };
}

function failure(status, code) {
    return { ok: false, status, code };
}
