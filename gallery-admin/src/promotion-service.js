import '../../gallery-contract.js';
import '../../gallery-upload-contract.js';

import catalogSnapshot from '../generated/catalog-snapshot.js';

import {
    inspectStaticWebp,
    readBoundedBytes,
    sha256Hex
} from './media-byte-verification.js';
import { hashIdentity } from './session.js';
import {
    buildV1ApprovedDerivativeKey,
    buildV1StagingDerivativeKey
} from './storage-keys.js';

const uploadContract = globalThis.galleryUploadContract;
const textEncoder = new TextEncoder();
const INPUT_KEYS = Object.freeze(['expectedStateVersion', 'idempotencyKey']);
const REQUIRED_ROLES = Object.freeze(['photo-display', 'photo-thumbnail']);
const DRAFT_ID_PATTERN = /^draft_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_PROVIDER_VALUE_PATTERN = /^[^\u0000-\u001f\u007f]{1,512}$/;

const PROMOTION_SELECT = `
SELECT
    promotion.promotion_id AS promotionId,
    promotion.processing_run_id AS processingRunId,
    promotion.draft_id AS draftId,
    promotion.site_mode AS siteMode,
    promotion.item_revision AS promotionItemRevision,
    promotion.consent_revision AS promotionConsentRevision,
    promotion.export_bundle_id AS promotionExportBundleId,
    promotion.source_revision AS promotionSourceRevision,
    promotion.suppression_revision AS promotionSuppressionRevision,
    promotion.expected_state_version AS expectedStateVersion,
    promotion.result_state_version AS resultStateVersion,
    promotion.idempotency_key AS idempotencyKey,
    promotion.payload_fingerprint AS payloadFingerprint,
    promotion.service_actor_identity_hash AS serviceActorIdentityHash,
    promotion.status AS promotionStatus,
    promotion.candidate_payload_hash AS candidatePayloadHash,
    promotion.created_at AS promotionCreatedAt,
    promotion.updated_at AS promotionUpdatedAt,
    promotion.candidate_at AS candidateAt,
    generation.approved_origin AS generationApprovedOrigin,
    generation.approved_origin_hash AS generationApprovedOriginHash,
    generation.candidate_state_version AS generationCandidateStateVersion,
    generation.generation_fingerprint AS generationFingerprint,
    generation.target_set_hash AS generationTargetSetHash,
    epoch.approved_origin AS currentApprovedOrigin,
    epoch.approved_origin_hash AS currentApprovedOriginHash,
    (SELECT COUNT(*)
        FROM draft_photo_public_generation_targets AS target
        WHERE target.promotion_id = promotion.promotion_id
    ) AS generationTargetCount,
    draft.public_item_id AS publicItemId,
    draft.state,
    draft.state_version AS stateVersion,
    draft.site_modes_json AS siteModesJson,
    draft.export_bundle_id AS exportBundleId,
    draft.source_revision AS sourceRevision,
    draft.suppression_revision AS suppressionRevision,
    draft.item_revision AS itemRevision,
    draft.active_consent_revision AS activeConsentRevision,
    draft.media_type AS mediaType,
    draft.race_date AS raceDate,
    draft.race_event AS raceEvent,
    draft.race_distance AS raceDistance,
    draft.athlete_ids_json AS athleteIdsJson,
    draft.title,
    draft.caption,
    draft.alt_text AS altText,
    draft.featured,
    draft.editorial_position AS editorialPosition,
    consent.public_use_confirmed AS publicUseConfirmed,
    consent.contains_minors AS containsMinors,
    consent.guardian_approval_confirmed AS guardianApprovalConfirmed,
    consent.withdrawn_at AS consentWithdrawnAt,
    run.status AS runStatus,
    (SELECT COUNT(*) FROM draft_processing_cleanups AS cleanup
        WHERE cleanup.processing_run_id = promotion.processing_run_id) AS cleanupCount,
    (SELECT COUNT(*) FROM draft_photo_promotion_cleanups AS cleanup
        WHERE cleanup.promotion_id = promotion.promotion_id) AS promotionCleanupCount,
    (SELECT COUNT(*)
        FROM json_each(draft.athlete_ids_json) AS tag
        JOIN pending_athlete_exclusions AS exclusion
          ON exclusion.athlete_id = tag.value
        WHERE exclusion.resolved_at IS NULL) AS pendingExclusionCount
FROM draft_photo_promotions AS promotion
JOIN gallery_drafts AS draft ON draft.draft_id = promotion.draft_id
JOIN draft_photo_public_generations AS generation
  ON generation.promotion_id = promotion.promotion_id
JOIN gallery_media_delivery_current_epoch AS current_epoch
  ON current_epoch.singleton_id = 1
JOIN gallery_media_delivery_epochs AS epoch
  ON epoch.epoch_id_hash = current_epoch.epoch_id_hash
LEFT JOIN draft_consent_attestations AS consent
  ON consent.draft_id = promotion.draft_id
 AND consent.consent_revision = promotion.consent_revision
JOIN draft_processing_runs AS run
  ON run.processing_run_id = promotion.processing_run_id`;

const ELIGIBILITY_SELECT = `
SELECT
    draft.draft_id AS draftId,
    draft.public_item_id AS publicItemId,
    draft.state,
    draft.state_version AS stateVersion,
    draft.site_modes_json AS siteModesJson,
    draft.export_bundle_id AS exportBundleId,
    draft.source_revision AS sourceRevision,
    draft.suppression_revision AS suppressionRevision,
    draft.item_revision AS itemRevision,
    draft.active_consent_revision AS activeConsentRevision,
    draft.media_type AS mediaType,
    draft.race_date AS raceDate,
    draft.race_event AS raceEvent,
    draft.race_distance AS raceDistance,
    draft.athlete_ids_json AS athleteIdsJson,
    draft.title,
    draft.caption,
    draft.alt_text AS altText,
    draft.featured,
    draft.editorial_position AS editorialPosition,
    consent.public_use_confirmed AS publicUseConfirmed,
    consent.contains_minors AS containsMinors,
    consent.guardian_approval_confirmed AS guardianApprovalConfirmed,
    consent.withdrawn_at AS consentWithdrawnAt,
    run.processing_run_id AS processingRunId,
    run.site_mode AS runSiteMode,
    run.status AS runStatus,
    run.media_type AS runMediaType,
    run.item_revision AS runItemRevision,
    run.consent_revision AS runConsentRevision,
    run.export_bundle_id AS runExportBundleId,
    run.source_revision AS runSourceRevision,
    run.suppression_revision AS runSuppressionRevision,
    (SELECT COUNT(*) FROM draft_processing_cleanups AS cleanup
        WHERE cleanup.processing_run_id = run.processing_run_id) AS cleanupCount,
    (SELECT COUNT(*)
        FROM json_each(draft.athlete_ids_json) AS tag
        JOIN pending_athlete_exclusions AS exclusion
          ON exclusion.athlete_id = tag.value
        WHERE exclusion.resolved_at IS NULL) AS pendingExclusionCount
FROM gallery_drafts AS draft
JOIN draft_consent_attestations AS consent
  ON consent.draft_id = draft.draft_id
 AND consent.consent_revision = draft.active_consent_revision
JOIN draft_processing_runs AS run
  ON run.draft_id = draft.draft_id
 AND run.status = 'staged'`;

export async function readPhotoCandidate(env, identity, draftId) {
    if (
        !DRAFT_ID_PATTERN.test(draftId || '') ||
        !validServiceIdentity(identity) ||
        !env?.DB ||
        typeof env.DB.prepare !== 'function' ||
        !env?.APPROVED_MEDIA ||
        typeof env.APPROVED_MEDIA.head !== 'function' ||
        typeof env.APPROVED_MEDIA.get !== 'function'
    ) {
        return failure(400, 'invalid-request');
    }

    try {
        const promotion = await readCandidatePromotionByDraft(env.DB, draftId);
        if (!promotion) return failure(404, 'not-found');
        const candidate = await buildCandidatePackage(env, promotion);
        return candidate
            ? success(200, { candidate })
            : failure(409, 'promotion-not-eligible');
    } catch {
        return failure(503, 'service-unavailable');
    }
}

export async function promotePhotoDraft(
    env,
    identity,
    draftId,
    input,
    approvedOrigin,
    nowMilliseconds
) {
    const normalizedApprovedOrigin = normalizeApprovedOrigin(approvedOrigin);
    if (
        !DRAFT_ID_PATTERN.test(draftId || '') ||
        !validInput(input) ||
        !validServiceIdentity(identity) ||
        normalizedApprovedOrigin === null
    ) {
        return failure(400, 'invalid-request');
    }

    const approvedOriginHash = await sha256Text(
        `approved-media-origin:${normalizedApprovedOrigin}`
    );
    const payloadFingerprint = await fingerprint({
        operation: 'photo-promotion',
        draftId,
        expectedStateVersion: input.expectedStateVersion,
        idempotencyKey: input.idempotencyKey,
        approvedOriginHash
    });
    const idempotencyKeyHash = await sha256Text(
        `promotion-idempotency-key:${input.idempotencyKey}`
    );

    try {
        let promotion = await readPromotionByIdempotency(
            env.DB,
            draftId,
            input.idempotencyKey
        );
        if (promotion) {
            if (!promotionReplayMatches(promotion, input, payloadFingerprint)) {
                return failure(409, 'conflict');
            }
            return continuePromotion(env, promotion, nowMilliseconds, true);
        }

        const cleanedReceipt = await readCleanedPromotionReceipt(
            env.DB,
            await sha256Text(`draft-id:${draftId}`),
            idempotencyKeyHash
        );
        if (cleanedReceipt) {
            return cleanedReceipt.sourcePromotionPayloadFingerprint === payloadFingerprint
                ? failure(409, 'promotion-cleaned')
                : failure(409, 'conflict');
        }

        const evidence = await readEligibility(env.DB, draftId);
        const outputs = evidence
            ? await readEligibleOutputs(env.DB, evidence.processingRunId)
            : [];
        if (!promotionEvidenceIsCurrent(evidence, outputs, input.expectedStateVersion)) {
            return failure(evidence ? 409 : 404, evidence ? 'promotion-not-eligible' : 'not-found');
        }

        const deliveryEpoch = await readCurrentMediaDeliveryEpoch(env.DB);
        if (
            !deliveryEpoch ||
            deliveryEpoch.approvedOrigin !== normalizedApprovedOrigin ||
            deliveryEpoch.approvedOriginHash !== approvedOriginHash
        ) {
            return failure(409, 'promotion-not-eligible');
        }

        const promotionId = randomIdentifier('promotion');
        const occurredAt = isoTime(nowMilliseconds);
        const actorIdentityHash = await hashIdentity(identity);
        const subjectHash = await sha256Text(`draft:${draftId}`);
        const promotionIdHash = await sha256Text(`promotion-id:${promotionId}`);
        const draftIdHash = await sha256Text(`draft-id:${draftId}`);
        const objectRows = [];
        for (const output of outputs) {
            const approvedObjectKey = buildV1ApprovedDerivativeKey({
                sha256: output.sha256,
                role: output.role
            });
            const approvedObjectKeyHash = await sha256Text(
                `approved-object-key:${approvedObjectKey}`
            );
            const publicUrlHash = await sha256Text(
                `public-media-url:${normalizedApprovedOrigin}/${approvedObjectKey}`
            );
            objectRows.push({
                ...output,
                approvedObjectKey,
                approvedObjectKeyHash,
                publicUrlHash
            });
        }
        objectRows.sort((left, right) => left.role.localeCompare(right.role));
        const generationTargetSetHash = await hashCanonicalRecords(
            objectRows.map(object => publicTargetRecord({
                promotionIdHash,
                role: object.role,
                approvedObjectKeyHash: object.approvedObjectKeyHash,
                publicUrlHash: object.publicUrlHash,
                expectedSha256: object.sha256
            }))
        );
        const generationFingerprint = await sha256Text([
            'public-generation',
            promotionIdHash,
            draftIdHash,
            approvedOriginHash,
            String(input.expectedStateVersion + 1),
            generationTargetSetHash
        ].join(':'));

        try {
            await runBatch(env.DB, [
                env.DB.prepare(`
                    INSERT INTO draft_photo_promotions (
                        promotion_id, processing_run_id, draft_id, site_mode,
                        item_revision, consent_revision, export_bundle_id,
                        source_revision, suppression_revision,
                        expected_state_version, result_state_version,
                        idempotency_key, idempotency_key_hash,
                        payload_fingerprint,
                        service_actor_identity_hash, created_at, updated_at
                    ) VALUES (
                        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                        ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16
                    )
                `).bind(
                    promotionId,
                    evidence.processingRunId,
                    draftId,
                    evidence.runSiteMode,
                    evidence.itemRevision,
                    evidence.activeConsentRevision,
                    evidence.exportBundleId,
                    evidence.sourceRevision,
                    evidence.suppressionRevision,
                    input.expectedStateVersion,
                    input.expectedStateVersion + 1,
                    input.idempotencyKey,
                    idempotencyKeyHash,
                    payloadFingerprint,
                    actorIdentityHash,
                    occurredAt
                ),
                ...objectRows.map(object => env.DB.prepare(`
                    INSERT INTO draft_photo_promotion_objects (
                        promotion_id, role, staging_object_key,
                        staging_object_version, staging_etag,
                        approved_object_key, sha256, byte_count,
                        content_type, width, height, created_at, updated_at
                    ) VALUES (
                        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                        ?9, ?10, ?11, ?12, ?12
                    )
                `).bind(
                    promotionId,
                    object.role,
                    object.stagingObjectKey,
                    object.stagingObjectVersion,
                    object.stagingEtag,
                    object.approvedObjectKey,
                    object.sha256,
                    object.byteCount,
                    object.contentType,
                    object.width,
                    object.height,
                    occurredAt
                )),
                env.DB.prepare(`
                    INSERT INTO draft_photo_public_generations (
                        promotion_id, promotion_id_hash, draft_id, draft_id_hash,
                        approved_origin, approved_origin_hash,
                        candidate_state_version, generation_fingerprint,
                        target_set_hash, created_at
                    ) VALUES (
                        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
                    )
                `).bind(
                    promotionId,
                    promotionIdHash,
                    draftId,
                    draftIdHash,
                    normalizedApprovedOrigin,
                    approvedOriginHash,
                    input.expectedStateVersion + 1,
                    generationFingerprint,
                    generationTargetSetHash,
                    occurredAt
                ),
                ...objectRows.map(object => env.DB.prepare(`
                    INSERT INTO draft_photo_public_generation_targets (
                        promotion_id, role, approved_object_key,
                        approved_object_key_hash, public_url_hash,
                        expected_sha256, generation_target_set_hash, created_at
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                `).bind(
                    promotionId,
                    object.role,
                    object.approvedObjectKey,
                    object.approvedObjectKeyHash,
                    object.publicUrlHash,
                    object.sha256,
                    generationTargetSetHash,
                    occurredAt
                )),
                auditInsert(env.DB, {
                    eventType: 'photo-promotion-started',
                    subjectHash,
                    actorIdentityHash,
                    payloadHash: payloadFingerprint,
                    stateVersion: input.expectedStateVersion,
                    occurredAt
                })
            ]);
        } catch {
            promotion = await readPromotionByIdempotency(
                env.DB,
                draftId,
                input.idempotencyKey
            );
            if (!promotion || !promotionReplayMatches(promotion, input, payloadFingerprint)) {
                return failure(409, 'conflict');
            }
            return continuePromotion(env, promotion, nowMilliseconds, true);
        }

        promotion = await readPromotion(env.DB, promotionId);
        return continuePromotion(env, promotion, nowMilliseconds, false);
    } catch {
        return failure(503, 'service-unavailable');
    }
}

async function continuePromotion(env, promotion, nowMilliseconds, replayed) {
    if (!promotion) return failure(503, 'service-unavailable');
    if (promotion.promotionStatus === 'candidate') {
        const candidate = await buildCandidatePackage(env, promotion);
        return candidate
            ? success(200, { candidate, replayed: true })
            : failure(409, 'promotion-not-eligible');
    }
    if (promotion.promotionStatus !== 'active') return failure(409, 'conflict');

    for (const role of REQUIRED_ROLES) {
        const object = await readPromotionObject(env.DB, promotion.promotionId, role);
        const stored = await ensureApprovedObject(env, promotion, object, nowMilliseconds);
        if (!stored.ok) return stored;
    }

    const current = await readPromotion(env.DB, promotion.promotionId);
    const objects = await readPromotionObjects(env.DB, promotion.promotionId);
    const evidence = await readEligibility(env.DB, promotion.draftId);
    const outputs = evidence
        ? await readEligibleOutputs(env.DB, evidence.processingRunId)
        : [];
    if (
        !promotionSnapshotIsCurrent(current, evidence, outputs) ||
        objects.length !== 2 ||
        objects.some(object => object.status !== 'verified')
    ) {
        return failure(409, 'promotion-not-eligible');
    }

    const provisional = candidatePackage(
        current,
        objects,
        current.generationApprovedOrigin,
        'candidate-public'
    );
    if (!provisional) return failure(503, 'service-unavailable');
    const candidatePayloadHash = await fingerprint(provisional);
    const occurredAt = nextIsoTime(nowMilliseconds, current.promotionUpdatedAt);
    const subjectHash = await sha256Text(`draft:${current.draftId}`);

    try {
        await runBatch(env.DB, [
            ...objects.map(object => env.DB.prepare(`
                UPDATE draft_derivatives
                SET approved_object_key = ?3
                WHERE draft_id = ?1
                  AND role = ?2
                  AND staging_object_key = ?4
                  AND approved_object_key IS NULL
            `).bind(
                current.draftId,
                object.role,
                object.approvedObjectKey,
                object.stagingObjectKey
            )),
            env.DB.prepare(`
                UPDATE draft_photo_promotions
                SET status = 'candidate', candidate_payload_hash = ?2,
                    candidate_at = ?3, updated_at = ?3
                WHERE promotion_id = ?1 AND status = 'active'
            `).bind(current.promotionId, candidatePayloadHash, occurredAt),
            env.DB.prepare(`
                UPDATE gallery_drafts
                SET state = 'candidate-public', state_version = ?3, updated_at = ?4
                WHERE draft_id = ?1
                  AND state = 'processing'
                  AND state_version = ?2
            `).bind(
                current.draftId,
                current.expectedStateVersion,
                current.resultStateVersion,
                occurredAt
            ),
            env.DB.prepare(`
                INSERT INTO draft_transition_receipts (
                    draft_id, idempotency_key, payload_fingerprint,
                    from_state, to_state, expected_state_version,
                    result_state_version, created_at
                ) VALUES (
                    ?1, ?2, ?3, 'processing', 'candidate-public', ?4, ?5, ?6
                )
            `).bind(
                current.draftId,
                current.idempotencyKey,
                current.payloadFingerprint,
                current.expectedStateVersion,
                current.resultStateVersion,
                occurredAt
            ),
            auditInsert(env.DB, {
                eventType: 'photo-promotion-candidate',
                subjectHash,
                actorIdentityHash: current.serviceActorIdentityHash,
                payloadHash: candidatePayloadHash,
                stateVersion: current.resultStateVersion,
                occurredAt
            })
        ]);
    } catch {
        const replay = await readPromotion(env.DB, current.promotionId);
        if (replay?.promotionStatus !== 'candidate') {
            return failure(409, 'conflict');
        }
        const candidate = await buildCandidatePackage(env, replay);
        return candidate
            ? success(200, { candidate, replayed: true })
            : failure(409, 'promotion-not-eligible');
    }

    const completed = await readPromotion(env.DB, current.promotionId);
    const candidate = await buildCandidatePackage(env, completed);
    return candidate
        ? success(201, { candidate, replayed })
        : failure(409, 'promotion-not-eligible');
}

async function ensureApprovedObject(env, promotion, initialObject, nowMilliseconds) {
    if (!initialObject) return failure(503, 'service-unavailable');
    if (!await promotionIsStillEligible(env, promotion)) {
        return failure(409, 'promotion-not-eligible');
    }
    let object = initialObject;
    if (object.status === 'verified') {
        return await exactApprovedObject(env.APPROVED_MEDIA, object)
            ? success(200, {})
            : failure(409, 'approved-object-conflict');
    }

    const stagingBytes = await readExactStagingBytes(env.DERIVATIVE_STAGING, object);
    if (!stagingBytes) return failure(409, 'staging-object-conflict');
    if (!await promotionIsStillEligible(env, promotion)) {
        return failure(409, 'promotion-not-eligible');
    }

    if (object.status === 'admitting') {
        // Only the invocation whose admission token was persisted may create
        // the provider handle. A later retry cannot know whether an earlier
        // create call succeeded but lost its response, so it must stop here.
        return failure(503, 'service-unavailable');
    }

    if (object.status === 'reserved') {
        const existing = await env.APPROVED_MEDIA.head(object.approvedObjectKey);
        if (existing) return failure(409, 'approved-object-conflict');

        const admissionTokenHash = await sha256Text(
            `approved-admission:${crypto.randomUUID()}`
        );
        const admittedAt = nextIsoTime(nowMilliseconds, object.updatedAt);
        try {
            await runStatement(env.DB.prepare(`
                UPDATE draft_photo_promotion_objects
                SET status = 'admitting', provider_admission_token_hash = ?3,
                    updated_at = ?4
                WHERE promotion_id = ?1 AND role = ?2 AND status = 'reserved'
            `).bind(
                promotion.promotionId,
                object.role,
                admissionTokenHash,
                admittedAt
            ));
        } catch {
            // A concurrent cleanup or promotion retry may have won. The
            // persisted token below, rather than D1 changes metadata, decides
            // whether this invocation owns the one permitted provider create.
        }

        object = await readPromotionObject(env.DB, promotion.promotionId, object.role);
        if (
            object?.status !== 'admitting' ||
            object.providerAdmissionTokenHash !== admissionTokenHash
        ) {
            return await promotionIsStillEligible(env, promotion)
                ? failure(503, 'service-unavailable')
                : failure(409, 'promotion-not-eligible');
        }

        let multipart;
        try {
            multipart = await env.APPROVED_MEDIA.createMultipartUpload(
                object.approvedObjectKey,
                approvedMetadata(object.role)
            );
        } catch {
            // The provider may have created a handle even when its response is
            // lost. Keep the durable admission unresolved so cleanup cannot
            // falsely record that no multipart upload ever existed.
            return failure(503, 'service-unavailable');
        }
        if (!safeProviderUpload(multipart, object.approvedObjectKey)) {
            await safeAbort(multipart);
            return failure(503, 'service-unavailable');
        }
        const uploadIdHash = await sha256Text(`approved-upload:${multipart.uploadId}`);
        const occurredAt = nextIsoTime(nowMilliseconds, object.updatedAt);
        try {
            await runBatch(env.DB, [
                env.DB.prepare(`
                    UPDATE draft_photo_promotion_objects
                    SET status = 'upload-open', provider_upload_id = ?3,
                        provider_upload_id_hash = ?4, updated_at = ?5
                    WHERE promotion_id = ?1 AND role = ?2
                      AND status = 'admitting'
                      AND provider_admission_token_hash = ?6
                `).bind(
                    promotion.promotionId,
                    object.role,
                    multipart.uploadId,
                    uploadIdHash,
                    occurredAt,
                    admissionTokenHash
                ),
                env.DB.prepare(`
                    UPDATE draft_photo_promotion_cleanup_objects
                    SET original_object_status = 'upload-open',
                        provider_upload_id = ?3,
                        provider_upload_id_hash = ?4
                    WHERE cleanup_id = (
                        SELECT cleanup_id
                        FROM draft_photo_promotion_cleanups
                        WHERE promotion_id = ?1 AND status = 'closing'
                    )
                      AND role = ?2 AND status = 'pending'
                      AND original_object_status = 'admitting'
                      AND provider_admission_token_hash = ?5
                      AND provider_upload_id IS NULL
                      AND provider_upload_id_hash IS NULL
                `).bind(
                    promotion.promotionId,
                    object.role,
                    multipart.uploadId,
                    uploadIdHash,
                    admissionTokenHash
                )
            ]);
        } catch {
            const persisted = await readPromotionObject(
                env.DB,
                promotion.promotionId,
                object.role
            );
            if (
                persisted?.status !== 'upload-open' ||
                persisted.providerUploadId !== multipart.uploadId ||
                persisted.providerAdmissionTokenHash !== admissionTokenHash
            ) {
                await safeAbort(multipart);
                return await promotionIsStillEligible(env, promotion)
                    ? failure(409, 'conflict')
                    : failure(409, 'promotion-not-eligible');
            }
        }
        object = await readPromotionObject(env.DB, promotion.promotionId, object.role);
        if (
            object?.status !== 'upload-open' ||
            object.providerUploadId !== multipart.uploadId ||
            object.providerAdmissionTokenHash !== admissionTokenHash
        ) {
            await safeAbort(multipart);
            return await promotionIsStillEligible(env, promotion)
                ? failure(409, 'conflict')
                : failure(409, 'promotion-not-eligible');
        }
        if (!await promotionIsStillEligible(env, promotion)) {
            // Cleanup won after admission. The exact provider ID has already
            // been handed to its durable snapshot, so abort is safe and no
            // media part is sent by this invocation.
            await safeAbort(multipart);
            return failure(409, 'promotion-not-eligible');
        }
    }

    if (object.status === 'upload-open') {
        // Narrow the read/provider-call window for retries as well as the
        // initial invocation. A cleanup that already exists owns the exact
        // handle and this path must not intentionally send another part.
        if (!await promotionIsStillEligible(env, promotion)) {
            return failure(409, 'promotion-not-eligible');
        }
        try {
            const multipart = env.APPROVED_MEDIA.resumeMultipartUpload(
                object.approvedObjectKey,
                object.providerUploadId
            );
            const part = await multipart.uploadPart(1, stagingBytes);
            if (
                part?.partNumber !== 1 ||
                !SAFE_PROVIDER_VALUE_PATTERN.test(part.etag || '')
            ) return failure(503, 'service-unavailable');
            await runStatement(env.DB.prepare(`
                UPDATE draft_photo_promotion_objects
                SET status = 'part-uploaded', provider_part_etag = ?3,
                    updated_at = ?4
                WHERE promotion_id = ?1 AND role = ?2 AND status = 'upload-open'
            `).bind(
                promotion.promotionId,
                object.role,
                part.etag,
                nextIsoTime(nowMilliseconds, object.updatedAt)
            ));
        } catch {
            object = await readPromotionObject(env.DB, promotion.promotionId, object.role);
            if (object?.status !== 'part-uploaded') {
                return failure(503, 'service-unavailable');
            }
        }
        object = await readPromotionObject(env.DB, promotion.promotionId, object.role);
    }

    if (object?.status !== 'part-uploaded') return failure(503, 'service-unavailable');
    if (!await promotionIsStillEligible(env, promotion)) {
        return failure(409, 'promotion-not-eligible');
    }
    try {
        const multipart = env.APPROVED_MEDIA.resumeMultipartUpload(
            object.approvedObjectKey,
            object.providerUploadId
        );
        await multipart.complete([{ partNumber: 1, etag: object.providerPartEtag }]);
    } catch (error) {
        if (!isNoSuchUploadError(error)) return failure(503, 'service-unavailable');
    }

    const approved = await readExactApprovedObject(env.APPROVED_MEDIA, object);
    if (!approved) return failure(409, 'approved-object-conflict');
    if (!await promotionIsStillEligible(env, promotion)) {
        return failure(409, 'promotion-not-eligible');
    }
    try {
        await runStatement(env.DB.prepare(`
            UPDATE draft_photo_promotion_objects
            SET status = 'verified', approved_object_version = ?3,
                approved_etag = ?4, verified_at = ?5, updated_at = ?5
            WHERE promotion_id = ?1 AND role = ?2 AND status = 'part-uploaded'
        `).bind(
            promotion.promotionId,
            object.role,
            approved.version,
            approved.etag,
            nextIsoTime(nowMilliseconds, object.updatedAt)
        ));
    } catch {
        object = await readPromotionObject(env.DB, promotion.promotionId, object.role);
        if (object?.status !== 'verified') return failure(503, 'service-unavailable');
    }
    object = await readPromotionObject(env.DB, promotion.promotionId, object.role);
    return object?.status === 'verified' && await exactApprovedObject(env.APPROVED_MEDIA, object)
        ? success(200, {})
        : failure(409, 'approved-object-conflict');
}

async function readExactStagingBytes(bucket, object) {
    const head = await bucket.head(object.stagingObjectKey);
    if (!stagingObjectMatches(head, object)) return null;
    const stored = await bucket.get(object.stagingObjectKey, {
        onlyIf: { etagMatches: object.stagingEtag }
    });
    if (
        !stagingObjectMatches(stored, object) ||
        stored.body === undefined ||
        stored.body === null
    ) return null;
    const bytes = await readBoundedBytes(stored.body, object.byteCount);
    const dimensions = inspectStaticWebp(bytes);
    return bytes.byteLength === object.byteCount &&
        await sha256Hex(bytes) === object.sha256 &&
        dimensions?.width === object.width &&
        dimensions?.height === object.height
        ? bytes
        : null;
}

function stagingObjectMatches(stored, object) {
    return Boolean(stored) &&
        stored.size === object.byteCount &&
        stored.version === object.stagingObjectVersion &&
        stored.etag === object.stagingEtag &&
        exactMetadata(stored, object.role, 'gallery-private-staging-v1');
}

async function readExactApprovedObject(bucket, object) {
    const head = await bucket.head(object.approvedObjectKey);
    if (!approvedObjectMatches(head, object)) return null;
    const stored = await bucket.get(object.approvedObjectKey, {
        onlyIf: { etagMatches: head.etag }
    });
    if (
        !approvedObjectMatches(stored, object) ||
        stored.version !== head.version ||
        stored.etag !== head.etag ||
        stored.body === undefined ||
        stored.body === null
    ) return null;
    const bytes = await readBoundedBytes(stored.body, object.byteCount);
    const dimensions = inspectStaticWebp(bytes);
    return bytes.byteLength === object.byteCount &&
        await sha256Hex(bytes) === object.sha256 &&
        dimensions?.width === object.width &&
        dimensions?.height === object.height
        ? head
        : null;
}

async function exactApprovedObject(bucket, object) {
    const stored = await readExactApprovedObject(bucket, object);
    return Boolean(stored) &&
        stored.version === object.approvedObjectVersion &&
        stored.etag === object.approvedEtag;
}

function approvedObjectMatches(stored, object) {
    return Boolean(stored) &&
        stored.size === object.byteCount &&
        safeProviderValue(stored.version) &&
        safeProviderValue(stored.etag) &&
        exactMetadata(stored, object.role, 'gallery-approved-media-v1');
}

function exactMetadata(stored, role, contract) {
    const http = stored?.httpMetadata;
    const custom = stored?.customMetadata;
    return isPlainObject(http) &&
        Object.keys(http).length === 1 &&
        http.contentType === 'image/webp' &&
        isPlainObject(custom) &&
        Object.keys(custom).length === 2 &&
        custom.contract === contract &&
        custom.role === role;
}

function approvedMetadata(role) {
    return {
        httpMetadata: { contentType: 'image/webp' },
        customMetadata: {
            contract: 'gallery-approved-media-v1',
            role
        }
    };
}

function promotionEvidenceIsCurrent(evidence, outputs, expectedStateVersion) {
    if (!evidence || evidence.stateVersion !== expectedStateVersion) return false;
    const draft = contractDraft(evidence, 'processing', null);
    const pendingAthleteIds = evidence.pendingExclusionCount === 0 ? [] : ['blocked'];
    const context = approvalContext(evidence.activeConsentRevision, pendingAthleteIds);
    const problems = uploadContract.validateGalleryUploadApproval(draft, context);
    return problems.length === 0 &&
        evidence.state === 'processing' &&
        evidence.runStatus === 'staged' &&
        evidence.runMediaType === 'photo' &&
        evidence.runSiteMode === draft.siteModes[0] &&
        evidence.runItemRevision === evidence.itemRevision &&
        evidence.runConsentRevision === evidence.activeConsentRevision &&
        evidence.runExportBundleId === evidence.exportBundleId &&
        evidence.runSourceRevision === evidence.sourceRevision &&
        evidence.runSuppressionRevision === evidence.suppressionRevision &&
        evidence.cleanupCount === 0 &&
        evidence.pendingExclusionCount === 0 &&
        validOutputSet(evidence, outputs);
}

function promotionSnapshotIsCurrent(promotion, evidence, outputs) {
    return Boolean(promotion) &&
        promotion.promotionStatus === 'active' &&
        validPromotionGenerationSnapshot(promotion) &&
        Boolean(evidence) &&
        promotion.processingRunId === evidence.processingRunId &&
        promotion.draftId === evidence.draftId &&
        promotion.siteMode === evidence.runSiteMode &&
        promotion.promotionItemRevision === evidence.itemRevision &&
        promotion.promotionConsentRevision === evidence.activeConsentRevision &&
        promotion.promotionExportBundleId === evidence.exportBundleId &&
        promotion.promotionSourceRevision === evidence.sourceRevision &&
        promotion.promotionSuppressionRevision === evidence.suppressionRevision &&
        promotion.expectedStateVersion === evidence.stateVersion &&
        promotion.promotionCleanupCount === 0 &&
        promotionEvidenceIsCurrent(evidence, outputs, promotion.expectedStateVersion);
}

async function promotionIsStillEligible(env, promotion) {
    const current = await readPromotion(env.DB, promotion.promotionId);
    const evidence = current ? await readEligibility(env.DB, current.draftId) : null;
    const outputs = evidence
        ? await readEligibleOutputs(env.DB, evidence.processingRunId)
        : [];
    return promotionSnapshotIsCurrent(current, evidence, outputs);
}

function validOutputSet(evidence, outputs) {
    if (outputs.length !== 2) return false;
    const roles = outputs.map(output => output.role).sort();
    if (JSON.stringify(roles) !== JSON.stringify(REQUIRED_ROLES)) return false;
    return outputs.every(output => {
        if (
            output.outputStatus !== 'verified' ||
            output.contentType !== 'image/webp' ||
            !SHA256_PATTERN.test(output.sha256 || '') ||
            output.derivativeApprovedObjectKey !== null ||
            output.derivativeStagingObjectKey !== output.stagingObjectKey ||
            output.derivativeSha256 !== output.sha256 ||
            output.derivativeByteCount !== output.byteCount ||
            output.metadataScanJson !==
                '{"schemaVersion":"1.0","scannerName":"exiftool","scannerVersion":"13.40","metadataEntryCount":0,"findingCategories":[]}'
        ) return false;
        try {
            return buildV1StagingDerivativeKey({
                site: evidence.runSiteMode,
                draftId: evidence.draftId,
                processingRunId: evidence.processingRunId,
                sha256: output.sha256,
                role: output.role
            }) === output.stagingObjectKey;
        } catch {
            return false;
        }
    });
}

function contractDraft(row, state, manifestItem) {
    return {
        schemaVersion: uploadContract.schemaVersion,
        draftId: row.draftId,
        state,
        stateVersion: state === 'candidate-public' ? row.resultStateVersion : row.stateVersion,
        siteModes: JSON.parse(row.siteModesJson),
        exportBundleId: row.exportBundleId,
        sourceRevision: row.sourceRevision,
        suppressionRevision: row.suppressionRevision,
        itemRevision: row.itemRevision,
        itemInput: {
            id: row.publicItemId,
            type: row.mediaType,
            title: row.title,
            caption: row.caption,
            alt: row.altText,
            raceDate: row.raceDate,
            raceEvent: row.raceEvent,
            raceDistance: row.raceDistance,
            featured: row.featured === 1,
            athleteIds: JSON.parse(row.athleteIdsJson)
        },
        manifestItem,
        consent: {
            publicUseConfirmed: row.publicUseConfirmed === 1,
            containsMinors: row.containsMinors === 1,
            guardianApprovalConfirmed: row.guardianApprovalConfirmed === 1,
            revision: row.activeConsentRevision || row.promotionConsentRevision
        },
        withdrawalEvidence: null
    };
}

function approvalContext(consentRevision, pendingHiddenAthleteIds, approved = {}) {
    return {
        consentRevision,
        suppressionRevision: catalogSnapshot.suppressionRevision,
        suppressionDocument: catalogSnapshot.suppressionDocument,
        pendingHiddenAthleteIds,
        siteCatalogs: {
            family: catalogSnapshot.sites.family.catalog,
            everyone: catalogSnapshot.sites.everyone.catalog
        },
        ...approved
    };
}

async function buildCandidatePackage(env, promotion) {
    let current = await readPromotion(env.DB, promotion.promotionId);
    if (!candidateEvidenceIsCurrent(current)) return null;
    const objects = await readPromotionObjects(env.DB, promotion.promotionId);
    const targets = await readPublicGenerationTargets(env.DB, promotion.promotionId);
    if (!await exactPublicGeneration(current, objects, targets)) return null;
    for (const object of objects) {
        if (object.status !== 'verified' || !await exactApprovedObject(env.APPROVED_MEDIA, object)) {
            return null;
        }
    }

    // The two provider reads can take long enough for consent, revisions, or a
    // pending athlete exclusion to change. Re-read the complete D1 view after
    // both objects so a stale pre-read cannot authorize this response.
    current = await readPromotion(env.DB, promotion.promotionId);
    if (!candidateEvidenceIsCurrent(current)) return null;
    const currentTargets = await readPublicGenerationTargets(env.DB, promotion.promotionId);
    if (!await exactPublicGeneration(current, objects, currentTargets)) return null;
    const candidate = candidatePackage(
        current,
        objects,
        current.generationApprovedOrigin,
        current.state
    );
    if (!candidate) return null;
    return await fingerprint(candidate) === current.candidatePayloadHash
        ? candidate
        : null;
}

function candidateEvidenceIsCurrent(promotion) {
    if (!promotion || !validPromotionGenerationSnapshot(promotion)) return false;
    let siteModes;
    try {
        siteModes = JSON.parse(promotion.siteModesJson);
    } catch {
        return false;
    }
    return promotion.promotionStatus === 'candidate' &&
        promotion.state === 'candidate-public' &&
        promotion.stateVersion === promotion.resultStateVersion &&
        promotion.mediaType === 'photo' &&
        Array.isArray(siteModes) &&
        siteModes.length === 1 &&
        siteModes[0] === promotion.siteMode &&
        promotion.itemRevision === promotion.promotionItemRevision &&
        promotion.activeConsentRevision === promotion.promotionConsentRevision &&
        promotion.exportBundleId === promotion.promotionExportBundleId &&
        promotion.sourceRevision === promotion.promotionSourceRevision &&
        promotion.suppressionRevision === promotion.promotionSuppressionRevision &&
        promotion.publicUseConfirmed === 1 &&
        (promotion.containsMinors === 0 || promotion.guardianApprovalConfirmed === 1) &&
        promotion.consentWithdrawnAt === null &&
        promotion.runStatus === 'staged' &&
        promotion.cleanupCount === 0 &&
        promotion.promotionCleanupCount === 0 &&
        promotion.pendingExclusionCount === 0;
}

function validPromotionGenerationSnapshot(promotion) {
    return promotion.generationApprovedOrigin === promotion.currentApprovedOrigin &&
        promotion.generationApprovedOriginHash === promotion.currentApprovedOriginHash &&
        SHA256_PATTERN.test(promotion.generationApprovedOriginHash || '') &&
        SHA256_PATTERN.test(promotion.generationFingerprint || '') &&
        SHA256_PATTERN.test(promotion.generationTargetSetHash || '') &&
        promotion.generationCandidateStateVersion === promotion.resultStateVersion &&
        promotion.generationTargetCount === 2;
}

async function exactPublicGeneration(promotion, objects, targets) {
    if (
        !validPromotionGenerationSnapshot(promotion) ||
        objects.length !== 2 ||
        targets.length !== 2
    ) return false;

    const approvedOriginHash = await sha256Text(
        `approved-media-origin:${promotion.generationApprovedOrigin}`
    );
    if (approvedOriginHash !== promotion.generationApprovedOriginHash) return false;

    const objectsByRole = new Map(objects.map(object => [object.role, object]));
    const records = [];
    for (const target of targets) {
        const object = objectsByRole.get(target.role);
        if (
            !object ||
            target.promotionId !== promotion.promotionId ||
            target.approvedObjectKey !== object.approvedObjectKey ||
            target.expectedSha256 !== object.sha256 ||
            target.generationTargetSetHash !== promotion.generationTargetSetHash
        ) return false;

        const approvedObjectKeyHash = await sha256Text(
            `approved-object-key:${object.approvedObjectKey}`
        );
        const publicUrlHash = await sha256Text(
            `public-media-url:${promotion.generationApprovedOrigin}/${object.approvedObjectKey}`
        );
        if (
            target.approvedObjectKeyHash !== approvedObjectKeyHash ||
            target.publicUrlHash !== publicUrlHash
        ) return false;

        records.push(publicTargetRecord({
            promotionIdHash: target.promotionIdHash,
            role: target.role,
            approvedObjectKeyHash,
            publicUrlHash,
            expectedSha256: target.expectedSha256
        }));
    }
    return await hashCanonicalRecords(records) === promotion.generationTargetSetHash;
}

function candidatePackage(promotion, objects, approvedOrigin, state) {
    const origin = normalizeApprovedOrigin(approvedOrigin);
    if (origin === null || objects.length !== 2 || objects.some(object => object.status !== 'verified')) {
        return null;
    }
    const byRole = new Map(objects.map(object => [object.role, object]));
    const display = byRole.get('photo-display');
    const thumbnail = byRole.get('photo-thumbnail');
    if (!display || !thumbnail) return null;
    const sourceUrl = `${origin}/${display.approvedObjectKey}`;
    const thumbnailUrl = `${origin}/${thumbnail.approvedObjectKey}`;
    const manifestItem = {
        id: promotion.publicItemId,
        type: 'photo',
        title: promotion.title,
        caption: promotion.caption,
        alt: promotion.altText,
        raceDate: promotion.raceDate,
        raceEvent: promotion.raceEvent,
        raceDistance: promotion.raceDistance,
        sourceUrl,
        thumbnailUrl,
        featured: promotion.featured === 1,
        athleteIds: JSON.parse(promotion.athleteIdsJson)
    };
    const draft = contractDraft(promotion, state, manifestItem);
    const approvedDerivatives = {
        draftId: promotion.draftId,
        itemRevision: promotion.itemRevision,
        consentRevision: promotion.promotionConsentRevision,
        exportBundleId: promotion.exportBundleId,
        sourceRevision: promotion.sourceRevision,
        suppressionRevision: promotion.suppressionRevision,
        sourceUrl,
        thumbnailUrl
    };
    const context = approvalContext(promotion.promotionConsentRevision, [], {
        approvedDerivativeOrigin: origin,
        approvedDerivatives
    });
    if (uploadContract.validateGalleryUploadPublication(draft, context).length > 0) return null;
    return {
        schemaVersion: '1.0',
        operationId: promotion.promotionId,
        draft,
        context,
        editorialPosition: promotion.editorialPosition ?? null
    };
}

async function readEligibility(database, draftId) {
    return queryFirst(database, `${ELIGIBILITY_SELECT} WHERE draft.draft_id = ?1`, draftId);
}

async function readCurrentMediaDeliveryEpoch(database) {
    return queryFirst(database, `
        SELECT
            epoch.epoch_id_hash AS epochIdHash,
            epoch.approved_origin AS approvedOrigin,
            epoch.approved_origin_hash AS approvedOriginHash
        FROM gallery_media_delivery_current_epoch AS current
        JOIN gallery_media_delivery_epochs AS epoch
          ON epoch.epoch_id_hash = current.epoch_id_hash
        WHERE current.singleton_id = 1
    `);
}

async function readEligibleOutputs(database, processingRunId) {
    return queryAll(database, `
        SELECT
            output.role,
            output.status AS outputStatus,
            output.staging_object_key AS stagingObjectKey,
            output.staging_object_version AS stagingObjectVersion,
            output.staging_etag AS stagingEtag,
            output.sha256,
            output.byte_count AS byteCount,
            output.content_type AS contentType,
            output.width,
            output.height,
            output.metadata_scan_json AS metadataScanJson,
            derivative.staging_object_key AS derivativeStagingObjectKey,
            derivative.approved_object_key AS derivativeApprovedObjectKey,
            derivative.sha256 AS derivativeSha256,
            derivative.byte_count AS derivativeByteCount
        FROM draft_processing_outputs AS output
        JOIN draft_processing_runs AS run
          ON run.processing_run_id = output.processing_run_id
        JOIN draft_derivatives AS derivative
          ON derivative.draft_id = run.draft_id
         AND derivative.role = output.role
        WHERE output.processing_run_id = ?1
        ORDER BY output.role
    `, processingRunId);
}

async function readPromotion(database, promotionId) {
    return queryFirst(database, `${PROMOTION_SELECT} WHERE promotion.promotion_id = ?1`, promotionId);
}

async function readCandidatePromotionByDraft(database, draftId) {
    return queryFirst(
        database,
        `${PROMOTION_SELECT} WHERE promotion.draft_id = ?1 AND promotion.status = 'candidate'`,
        draftId
    );
}

async function readCleanedPromotionReceipt(database, draftIdHash, idempotencyKeyHash) {
    return queryFirst(database, `
        SELECT
            source_promotion_payload_fingerprint AS sourcePromotionPayloadFingerprint
        FROM gallery_photo_promotion_cleanup_tombstones
        WHERE draft_id_hash = ?1
          AND source_promotion_idempotency_key_hash = ?2
    `, draftIdHash, idempotencyKeyHash);
}

async function readPromotionByIdempotency(database, draftId, idempotencyKey) {
    return queryFirst(
        database,
        `${PROMOTION_SELECT} WHERE promotion.draft_id = ?1 AND promotion.idempotency_key = ?2`,
        draftId,
        idempotencyKey
    );
}

async function readPromotionObject(database, promotionId, role) {
    return queryFirst(database, `${promotionObjectSelect()} WHERE promotion_id = ?1 AND role = ?2`, promotionId, role);
}

async function readPromotionObjects(database, promotionId) {
    return queryAll(database, `${promotionObjectSelect()} WHERE promotion_id = ?1 ORDER BY role`, promotionId);
}

async function readPublicGenerationTargets(database, promotionId) {
    return queryAll(database, `
        SELECT
            target.promotion_id AS promotionId,
            generation.promotion_id_hash AS promotionIdHash,
            target.role,
            target.approved_object_key AS approvedObjectKey,
            target.approved_object_key_hash AS approvedObjectKeyHash,
            target.public_url_hash AS publicUrlHash,
            target.expected_sha256 AS expectedSha256,
            target.generation_target_set_hash AS generationTargetSetHash
        FROM draft_photo_public_generation_targets AS target
        JOIN draft_photo_public_generations AS generation
          ON generation.promotion_id = target.promotion_id
        WHERE target.promotion_id = ?1
        ORDER BY target.role
    `, promotionId);
}

function promotionObjectSelect() {
    return `
        SELECT
            promotion_id AS promotionId,
            role,
            staging_object_key AS stagingObjectKey,
            staging_object_version AS stagingObjectVersion,
            staging_etag AS stagingEtag,
            approved_object_key AS approvedObjectKey,
            sha256,
            byte_count AS byteCount,
            content_type AS contentType,
            width,
            height,
            status,
            provider_admission_token_hash AS providerAdmissionTokenHash,
            provider_upload_id AS providerUploadId,
            provider_upload_id_hash AS providerUploadIdHash,
            provider_part_etag AS providerPartEtag,
            approved_object_version AS approvedObjectVersion,
            approved_etag AS approvedEtag,
            created_at AS createdAt,
            updated_at AS updatedAt,
            verified_at AS verifiedAt
        FROM draft_photo_promotion_objects
    `;
}

function promotionReplayMatches(promotion, input, payloadFingerprint) {
    return promotion.expectedStateVersion === input.expectedStateVersion &&
        promotion.idempotencyKey === input.idempotencyKey &&
        promotion.payloadFingerprint === payloadFingerprint;
}

function validInput(input) {
    return isPlainObject(input) &&
        hasExactKeys(input, INPUT_KEYS) &&
        Number.isSafeInteger(input.expectedStateVersion) &&
        input.expectedStateVersion >= 0 &&
        IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey || '');
}

function validServiceIdentity(identity) {
    return Boolean(identity) &&
        identity.type === 'service' &&
        typeof identity.subject === 'string' &&
        SAFE_PROVIDER_VALUE_PATTERN.test(identity.subject);
}

function normalizeApprovedOrigin(value) {
    if (typeof value !== 'string' || value.trim() !== value) return null;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' &&
            url.origin === value &&
            url.username === '' &&
            url.password === '' &&
            url.pathname === '/' &&
            url.search === '' &&
            url.hash === ''
            ? url.origin
            : null;
    } catch {
        return null;
    }
}

function safeProviderUpload(value, expectedKey) {
    return Boolean(value) &&
        value.key === expectedKey &&
        SAFE_PROVIDER_VALUE_PATTERN.test(value.uploadId || '') &&
        typeof value.uploadPart === 'function' &&
        typeof value.complete === 'function' &&
        typeof value.abort === 'function';
}

function safeProviderValue(value) {
    return typeof value === 'string' && SAFE_PROVIDER_VALUE_PATTERN.test(value);
}

async function safeAbort(multipart) {
    try {
        await multipart?.abort?.();
    } catch {
        // The unpersisted provider handle remains unusable by this service.
    }
}

function isNoSuchUploadError(error) {
    return Boolean(error) && error.name === 'NoSuchUpload' && Number(error.code) === 10024;
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

async function runBatch(database, statements) {
    const results = await database.batch(statements);
    if (
        !Array.isArray(results) ||
        results.length !== statements.length ||
        results.some(result => result?.success === false)
    ) throw new Error('Promotion transaction failed.');
    return results;
}

async function runStatement(statement) {
    const result = await statement.run();
    if (result?.success === false) {
        throw new Error('Promotion statement failed.');
    }
    return result;
}

async function queryFirst(database, sql, ...bindings) {
    const statement = database.prepare(sql).bind(...bindings);
    if (typeof statement.first === 'function') return statement.first();
    const result = await statement.all();
    return result?.results?.[0] || null;
}

async function queryAll(database, sql, ...bindings) {
    const result = await database.prepare(sql).bind(...bindings).all();
    return Array.isArray(result?.results) ? result.results : [];
}

async function fingerprint(value) {
    return sha256Text(JSON.stringify(value));
}

async function sha256Text(value) {
    return sha256Hex(textEncoder.encode(value));
}

async function hashCanonicalRecords(records) {
    return sha256Text([...records].sort().join('\n'));
}

function publicTargetRecord({
    promotionIdHash,
    role,
    approvedObjectKeyHash,
    publicUrlHash,
    expectedSha256
}) {
    return [
        'target',
        promotionIdHash,
        role,
        approvedObjectKeyHash,
        publicUrlHash,
        expectedSha256
    ].join(':');
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
