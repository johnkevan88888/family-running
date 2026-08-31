import {
    MEDIA_BINDING_WITNESS_CONTENT_TYPE,
    MEDIA_BINDING_WITNESS_KEY,
    MEDIA_BINDING_WITNESS_SHA256,
    MEDIA_BINDING_WITNESS_SIZE,
    MEDIA_DELIVERY_CONTRACT_HEADER,
    MEDIA_DELIVERY_CONTRACT_VALUE,
    MEDIA_DELIVERY_VERSION_HEADER
} from './media-delivery-contract.js';
import { hashIdentity } from './session.js';

const textEncoder = new TextEncoder();
const INPUT_KEYS = Object.freeze(['expectedStateVersion', 'idempotencyKey']);
const REQUIRED_TARGET_ROLES = Object.freeze(['photo-display', 'photo-thumbnail']);
const DRAFT_ID_PATTERN = /^draft_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PROMOTION_ID_PATTERN = /^promotion_[a-f0-9]{32}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MEDIA_VERSION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const APPROVED_MEDIA_KEY_PATTERN = /^media\/v1\/([a-f0-9]{64})\/(display|thumbnail)\.webp$/;
const MAX_WITNESS_BYTES = 64 * 1024;
const MAX_ABSENCE_BODY_BYTES = 1;
const DEFAULT_FETCH_TIMEOUT_MILLISECONDS = 5_000;
const EXACT_SERVICE_ENVIRONMENT_KEYS = Object.freeze([
    'APPROVED_MEDIA_ORIGIN',
    'DB',
    'EXPECTED_MEDIA_VERSION',
    'MEDIA_CONTRACT',
    'MEDIA_WITNESS_BYTE_COUNT',
    'MEDIA_WITNESS_CONTENT_TYPE',
    'MEDIA_WITNESS_KEY',
    'MEDIA_WITNESS_SHA256',
    'PUBLIC_HOST_VERIFIER_IDENTITY',
    'PUBLIC_HOST_VERIFIER_ORIGIN'
]);

// Migration 0009 owns these tables. Keeping all SQL in this block makes the
// D1 contract auditable and keeps schema spelling out of the network proof.
export const PUBLIC_HOST_VERIFIER_SQL = Object.freeze({
    readCurrentEpoch: `
        /* public-host-verifier:read-current-epoch */
        SELECT epoch.epoch_id_hash AS epochIdHash,
            epoch.epoch_sequence AS epochSequence,
            epoch.approved_origin AS approvedOrigin,
            epoch.approved_origin_hash AS approvedOriginHash,
            epoch.delivery_contract_hash AS deliveryContractHash,
            epoch.delivery_version_hash AS deliveryVersionHash,
            epoch.witness_object_key_hash AS witnessObjectKeyHash,
            epoch.witness_sha256 AS witnessSha256,
            epoch.witness_byte_count AS witnessByteCount,
            epoch.witness_content_type AS witnessContentType,
            current.activated_at AS activatedAt
        FROM gallery_media_delivery_current_epoch AS current
        JOIN gallery_media_delivery_epochs AS epoch
          ON epoch.epoch_id_hash = current.epoch_id_hash
        WHERE current.singleton_id = 1
    `,
    readCurrentReceipt: `
        /* public-host-verifier:read-current-receipt */
        SELECT verification.verification_id AS verificationId,
            verification.verification_id_hash AS verificationIdHash,
            verification.draft_id_hash AS draftIdHash,
            verification.expected_state_version AS expectedStateVersion,
            verification.verification_purpose AS verificationPurpose,
            verification.purpose_evidence_hash AS purposeEvidenceHash,
            verification.withdrawal_kind AS withdrawalKind,
            verification.idempotency_key AS idempotencyKey,
            verification.idempotency_key_hash AS idempotencyKeyHash,
            verification.payload_fingerprint AS payloadFingerprint,
            verification.media_delivery_epoch_id_hash AS mediaDeliveryEpochIdHash,
            verification.delivery_contract_hash AS deliveryContractHash,
            verification.delivery_version_hash AS deliveryVersionHash,
            receipt.final_receipt_hash AS finalReceiptHash,
            receipt.verified_at AS verifiedAt
        FROM gallery_current_public_host_absence_receipts AS current_receipt
        JOIN draft_public_host_absence_verifications AS verification
          ON verification.draft_id = current_receipt.draft_id
         AND verification.expected_state_version = current_receipt.expected_state_version
        JOIN gallery_public_host_absence_receipts AS receipt
          ON receipt.verification_id_hash = verification.verification_id_hash
         AND receipt.final_receipt_hash = current_receipt.final_receipt_hash
        WHERE verification.draft_id = ?1
          AND verification.idempotency_key = ?2
    `,
    readVerification: `
        /* public-host-verifier:read-verification */
        SELECT verification_id AS verificationId,
            verification_id_hash AS verificationIdHash,
            draft_id AS draftId, draft_id_hash AS draftIdHash,
            expected_state_version AS expectedStateVersion,
            verification_purpose AS verificationPurpose,
            purpose_evidence_hash AS purposeEvidenceHash,
            withdrawal_kind AS withdrawalKind,
            withdrawal_cycle_hash AS withdrawalCycleHash,
            promotion_set_hash AS promotionSetHash,
            cleanup_evidence_set_hash AS cleanupEvidenceSetHash,
            approved_origin_hash AS approvedOriginHash,
            target_set_hash AS targetSetHash,
            generation_count AS generationCount,
            generation_target_row_count AS generationTargetRowCount,
            target_count AS targetCount,
            media_delivery_epoch_id_hash AS mediaDeliveryEpochIdHash,
            delivery_contract_hash AS deliveryContractHash,
            delivery_version_hash AS deliveryVersionHash,
            idempotency_key AS idempotencyKey,
            idempotency_key_hash AS idempotencyKeyHash,
            payload_fingerprint AS payloadFingerprint,
            service_actor_identity_hash AS serviceActorIdentityHash,
            created_at AS createdAt
        FROM draft_public_host_absence_verifications
        WHERE draft_id = ?1 AND idempotency_key = ?2
    `,
    readEvidence: `
        /* public-host-verifier:read-evidence */
        SELECT draft.draft_id AS draftId, draft.state,
            draft.state_version AS stateVersion,
            publication.withdrawal_kind AS withdrawalKind,
            publication.host_deletion_confirmed AS hostDeletionConfirmed,
            (SELECT verification.withdrawal_cycle_hash
                FROM draft_public_host_absence_verifications AS verification
                WHERE verification.draft_id = draft.draft_id
                  AND verification.verification_purpose = 'withdrawal'
                  AND verification.withdrawal_kind = publication.withdrawal_kind
                ORDER BY verification.created_at DESC LIMIT 1
            ) AS priorWithdrawalCycleHash,
            retention.purge_kind AS retentionPurgeKind,
            retention.eligible_at AS retentionEligibleAt,
            retention.approved_at AS retentionApprovedAt,
            retention.approved_by_identity_hash AS retentionApprovedByIdentityHash,
            retention.evidence_hash AS retentionEvidenceHash,
            (SELECT COUNT(*) FROM draft_derivatives AS derivative
                WHERE derivative.draft_id = draft.draft_id
                  AND derivative.approved_object_key IS NOT NULL
            ) AS approvedReferenceCount,
            (SELECT COUNT(*) FROM draft_photo_promotions AS promotion
                WHERE promotion.draft_id = draft.draft_id
            ) AS activePromotionCount,
            (SELECT COUNT(*) FROM draft_photo_promotion_cleanups AS cleanup
                WHERE cleanup.draft_id = draft.draft_id
                  AND cleanup.status <> 'cleaned'
            ) AS incompleteCleanupCount
        FROM gallery_drafts AS draft
        JOIN draft_publication_references AS publication
          ON publication.draft_id = draft.draft_id
        LEFT JOIN gallery_retention_tombstones AS retention
          ON retention.draft_id = draft.draft_id
        WHERE draft.draft_id = ?1
    `,
    readCleanupEvidence: `
        /* public-host-verifier:read-cleanup-evidence */
        SELECT generation.promotion_id_hash AS promotionIdHash,
            cleanup.evidence_hash AS cleanupEvidenceHash,
            cleanup.completed_at AS completedAt
        FROM draft_photo_public_generations AS generation
        JOIN gallery_photo_promotion_cleanup_tombstones AS cleanup
          ON cleanup.promotion_id_hash = generation.promotion_id_hash
         AND cleanup.draft_id_hash = generation.draft_id_hash
        WHERE generation.draft_id = ?1
        ORDER BY generation.promotion_id_hash
    `,
    readGenerations: `
        /* public-host-verifier:read-generations */
        SELECT promotion_id AS generationId,
            promotion_id_hash AS promotionIdHash,
            approved_origin AS approvedOrigin,
            approved_origin_hash AS approvedOriginHash,
            candidate_state_version AS candidateStateVersion,
            generation_fingerprint AS generationFingerprint,
            target_set_hash AS targetSetHash, created_at AS createdAt
        FROM draft_photo_public_generations
        WHERE draft_id = ?1
        ORDER BY candidate_state_version, promotion_id
    `,
    readTargets: `
        /* public-host-verifier:read-targets */
        SELECT target.promotion_id AS generationId,
            generation.promotion_id_hash AS promotionIdHash,
            target.role, target.approved_object_key AS approvedObjectKey,
            target.approved_object_key_hash AS approvedObjectKeyHash,
            target.public_url_hash AS publicUrlHash,
            target.expected_sha256 AS expectedSha256,
            target.generation_target_set_hash AS generationTargetSetHash,
            target.created_at AS createdAt
        FROM draft_photo_public_generation_targets AS target
        JOIN draft_photo_public_generations AS generation
          ON generation.promotion_id = target.promotion_id
        WHERE generation.draft_id = ?1
        ORDER BY generation.candidate_state_version, target.promotion_id, target.role
    `,
    insertVerification: `
        /* public-host-verifier:insert-verification */
        INSERT INTO draft_public_host_absence_verifications (
            verification_id, verification_id_hash, draft_id, draft_id_hash,
            expected_state_version, withdrawal_kind, withdrawal_cycle_hash,
            promotion_set_hash, cleanup_evidence_set_hash,
            approved_origin_hash, target_set_hash, generation_count,
            generation_target_row_count, target_count,
            media_delivery_epoch_id_hash, delivery_contract_hash,
            delivery_version_hash, idempotency_key, idempotency_key_hash,
            payload_fingerprint, service_actor_identity_hash, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
            ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)
    `,
    insertRetentionVerification: `
        /* public-host-verifier:insert-retention-verification */
        INSERT INTO draft_public_host_absence_verifications (
            verification_id, verification_id_hash, draft_id, draft_id_hash,
            expected_state_version, verification_purpose, purpose_evidence_hash,
            withdrawal_kind, withdrawal_cycle_hash, promotion_set_hash,
            cleanup_evidence_set_hash, approved_origin_hash, target_set_hash,
            generation_count, generation_target_row_count, target_count,
            media_delivery_epoch_id_hash, delivery_contract_hash,
            delivery_version_hash, idempotency_key, idempotency_key_hash,
            payload_fingerprint, service_actor_identity_hash, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
            ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)
    `,
    reserveKey: `
        /* public-host-verifier:reserve-key */
        INSERT INTO gallery_approved_media_key_retirement_reservations (
            approved_object_key_hash, verification_id_hash,
            promotion_id_hash, draft_id_hash, withdrawal_cycle_hash,
            reservation_idempotency_key_hash, reserved_by_identity_hash,
            reserved_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    `,
    readReservation: `
        /* public-host-verifier:read-reservation */
        SELECT approved_object_key_hash AS approvedObjectKeyHash,
            verification_id_hash AS verificationIdHash,
            promotion_id_hash AS promotionIdHash,
            draft_id_hash AS draftIdHash,
            withdrawal_cycle_hash AS withdrawalCycleHash,
            reservation_idempotency_key_hash AS reservationIdempotencyKeyHash,
            reserved_by_identity_hash AS reservedByIdentityHash,
            reserved_at AS reservedAt
        FROM gallery_approved_media_key_retirement_reservations
        WHERE approved_object_key_hash = ?1
    `,
    insertTargetProof: `
        /* public-host-verifier:insert-target-proof */
        INSERT INTO draft_public_host_absence_target_proofs (
            verification_id, approved_object_key_hash, role, public_url_hash,
            expected_sha256, head_evidence_hash, get_evidence_hash,
            final_head_evidence_hash, observed_contract_hash,
            observed_version_hash, verified_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
    `,
    insertWitnessProof: `
        /* public-host-verifier:insert-witness-proof */
        INSERT INTO draft_public_host_absence_witness_proofs (
            verification_id, witness_object_key_hash, witness_sha256,
            witness_byte_count, witness_content_type,
            before_head_evidence_hash, before_get_evidence_hash,
            after_head_evidence_hash, after_get_evidence_hash,
            observed_contract_hash, observed_version_hash, verified_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
    `,
    insertReceipt: `
        /* public-host-verifier:insert-receipt */
        INSERT INTO gallery_public_host_absence_receipts (
            final_receipt_hash, verification_id_hash, draft_id_hash,
            promotion_set_hash, cleanup_evidence_set_hash,
            withdrawal_cycle_hash, approved_origin_hash, target_set_hash,
            generation_count, target_count, verified_state_version,
            media_delivery_epoch_id_hash, delivery_contract_hash,
            delivery_version_hash, idempotency_key_hash,
            payload_fingerprint, verified_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
            ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
    `,
    insertRetentionReceipt: `
        /* public-host-verifier:insert-retention-receipt */
        INSERT INTO gallery_public_host_absence_receipts (
            final_receipt_hash, verification_id_hash, draft_id_hash,
            promotion_set_hash, cleanup_evidence_set_hash,
            withdrawal_cycle_hash, approved_origin_hash, target_set_hash,
            generation_count, target_count, verified_state_version,
            verification_purpose, purpose_evidence_hash,
            media_delivery_epoch_id_hash, delivery_contract_hash,
            delivery_version_hash, idempotency_key_hash,
            payload_fingerprint, verified_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
            ?13, ?14, ?15, ?16, ?17, ?18, ?19)
    `,
    confirmHostDeletion: `
        /* public-host-verifier:confirm-host-deletion */
        UPDATE draft_publication_references
        SET host_deletion_confirmed = 1, updated_at = ?3
        WHERE draft_id = ?1 AND host_deletion_confirmed = 0
          AND EXISTS (
              SELECT 1 FROM gallery_complete_public_host_absence_receipts AS receipt
              WHERE receipt.draft_id = ?1
                AND receipt.expected_state_version = ?2
                AND receipt.verification_purpose = 'withdrawal'
                AND receipt.withdrawal_kind = draft_publication_references.withdrawal_kind
          )
    `
});

export async function verifyPublicHostAbsence(
    env,
    identity,
    draftId,
    input,
    startedAtMilliseconds,
    dependencies = {}
) {
    const config = readConfig(env);
    if (
        !config ||
        !validServiceIdentity(identity) ||
        !DRAFT_ID_PATTERN.test(draftId || '') ||
        !validInput(input)
    ) return failure(400, 'invalid-request');

    const fetcher = dependencies.fetch || globalThis.fetch;
    if (typeof fetcher !== 'function') {
        return failure(503, 'public-host-unverifiable');
    }

    try {
        const configEvidence = await buildConfigEvidence(config);
        const epoch = await queryFirst(
            env.DB,
            PUBLIC_HOST_VERIFIER_SQL.readCurrentEpoch
        );
        if (!epochMatchesConfig(epoch, config, configEvidence)) {
            return failure(503, 'public-host-unverifiable');
        }

        const currentReceipt = await queryFirst(
            env.DB,
            PUBLIC_HOST_VERIFIER_SQL.readCurrentReceipt,
            draftId,
            input.idempotencyKey
        );
        if (currentReceipt) {
            const currentPurpose = receiptPurpose(currentReceipt);
            return currentReceiptMatches(
                currentReceipt, input, epoch, currentPurpose
            )
                ? success(200, currentReceipt.verificationId, true)
                : failure(409, 'state-or-generation-drift');
        }

        const draftIdHash = await sha256Text(`draft-id:${draftId}`);
        const initialSnapshot = await readSnapshot(
            env.DB,
            draftId,
            draftIdHash,
            config
        );
        if (!initialSnapshot.exists) return failure(404, 'not-found');
        const verificationPurpose = deriveVerificationPurpose(
            initialSnapshot, input.expectedStateVersion
        );
        if (!verificationPurpose || !snapshotEligible(
            initialSnapshot, input.expectedStateVersion, verificationPurpose
        )) return failure(409, 'state-or-generation-drift');

        const idempotencyKeyHash = await sha256Text(verificationPurpose === 'withdrawal'
            ? `public-host-absence-idempotency-key:${input.idempotencyKey}`
            : `public-host-retention-expiry-idempotency-key:${input.idempotencyKey}`
        );
        let snapshotHashes;
        try {
            snapshotHashes = await hashSnapshot(
                initialSnapshot,
                draftIdHash,
                configEvidence.approvedOriginHash,
                verificationPurpose
            );
        } catch {
            return failure(409, 'state-or-generation-drift');
        }
        const actorIdentityHash = await hashIdentity(identity);
        const payloadFingerprint = await fingerprint({
            operation: 'public-host-absence-verification',
            verificationPurpose,
            purposeEvidenceHash: verificationPurpose === 'retention-expiry'
                ? initialSnapshot.evidence.retentionEvidenceHash
                : null,
            draftIdHash,
            expectedStateVersion: input.expectedStateVersion,
            idempotencyKeyHash,
            withdrawalKind: verificationPurpose === 'retention-expiry'
                ? 'retention-expiry'
                : initialSnapshot.evidence.withdrawalKind,
            ...snapshotHashes,
            mediaDeliveryEpochIdHash: epoch.epochIdHash,
            deliveryContractHash: epoch.deliveryContractHash,
            deliveryVersionHash: epoch.deliveryVersionHash,
            actorIdentityHash
        });
        const verificationId = `hostverify_${payloadFingerprint.slice(0, 32)}`;
        const verificationIdHash = await sha256Text(
            `public-host-verification-id:${verificationId}`
        );
        const createdAt = nextIsoTime(
            startedAtMilliseconds,
            dependencies.now,
            [
                epoch.activatedAt,
                ...initialSnapshot.generations.map(row => row.createdAt),
                ...initialSnapshot.cleanupEvidence.map(row => row.completedAt),
                initialSnapshot.evidence.retentionApprovedAt
            ]
        );
        const attempt = {
            verificationId,
            verificationIdHash,
            draftId,
            draftIdHash,
            expectedStateVersion: input.expectedStateVersion,
            verificationPurpose,
            purposeEvidenceHash: verificationPurpose === 'retention-expiry'
                ? initialSnapshot.evidence.retentionEvidenceHash
                : null,
            withdrawalKind: verificationPurpose === 'retention-expiry'
                ? 'retention-expiry'
                : initialSnapshot.evidence.withdrawalKind,
            ...snapshotHashes,
            mediaDeliveryEpochIdHash: epoch.epochIdHash,
            deliveryContractHash: epoch.deliveryContractHash,
            deliveryVersionHash: epoch.deliveryVersionHash,
            idempotencyKey: input.idempotencyKey,
            idempotencyKeyHash,
            payloadFingerprint,
            actorIdentityHash,
            createdAt
        };

        const existingVerification = await queryFirst(
            env.DB,
            PUBLIC_HOST_VERIFIER_SQL.readVerification,
            draftId,
            input.idempotencyKey
        );
        if (existingVerification) {
            if (!verificationMatches(existingVerification, attempt, false)) {
                return failure(409, 'state-or-generation-drift');
            }
            attempt.createdAt = existingVerification.createdAt;
        } else {
            const insert = env.DB.prepare(
                verificationPurpose === 'withdrawal'
                    ? PUBLIC_HOST_VERIFIER_SQL.insertVerification
                    : PUBLIC_HOST_VERIFIER_SQL.insertRetentionVerification
            ).bind(...verificationInsertBindings(attempt));
            try {
                await runBatch(env.DB, [insert]);
            } catch {
                const replay = await queryFirst(
                    env.DB,
                    PUBLIC_HOST_VERIFIER_SQL.readVerification,
                    draftId,
                    input.idempotencyKey
                );
                if (!replay || !verificationMatches(replay, attempt, false)) {
                    return failure(409, 'state-or-generation-drift');
                }
                attempt.createdAt = replay.createdAt;
            }
        }

        const targets = uniqueTargets(initialSnapshot.targets);
        if (!await reserveKeys(env.DB, targets, attempt)) {
            return failure(409, 'state-or-generation-drift');
        }

        const networkProof = await proveHostAbsence(
            fetcher,
            config,
            targets,
            dependencies.fetchTimeoutMilliseconds
        );
        if (!networkProof.ok) return networkProof;

        const finalSnapshot = await readSnapshot(
            env.DB,
            draftId,
            draftIdHash,
            config
        );
        if (!snapshotEligible(
            finalSnapshot, input.expectedStateVersion, verificationPurpose
        )) {
            return failure(409, 'state-or-generation-drift');
        }
        let finalHashes;
        try {
            finalHashes = await hashSnapshot(
                finalSnapshot,
                draftIdHash,
                configEvidence.approvedOriginHash,
                verificationPurpose
            );
        } catch {
            return failure(409, 'state-or-generation-drift');
        }
        if (!sameSnapshotHashes(snapshotHashes, finalHashes)) {
            return failure(409, 'state-or-generation-drift');
        }
        const finalEpoch = await queryFirst(
            env.DB,
            PUBLIC_HOST_VERIFIER_SQL.readCurrentEpoch
        );
        if (!sameEpoch(epoch, finalEpoch)) {
            return failure(409, 'state-or-generation-drift');
        }
        if (!await reservationsMatch(env.DB, targets, attempt)) {
            return failure(409, 'state-or-generation-drift');
        }

        const proofAt = nextIsoTime(Date.parse(attempt.createdAt), dependencies.now, [
            attempt.createdAt
        ]);
        const receiptAt = nextIsoTime(Date.parse(proofAt), dependencies.now, [
            proofAt,
            ...finalSnapshot.cleanupEvidence.map(row => row.completedAt)
        ]);
        const targetProofRows = await buildTargetProofRows(
            targets,
            networkProof.targetEvidence,
            attempt,
            proofAt
        );
        const witnessProof = await buildWitnessProof(
            networkProof.witnessEvidence,
            config,
            configEvidence,
            attempt,
            proofAt
        );
        const finalReceiptHash = await fingerprint({
            operation: 'public-host-absence-final-receipt',
            verificationPurpose,
            purposeEvidenceHash: attempt.purposeEvidenceHash,
            verificationIdHash,
            draftIdHash,
            promotionSetHash: snapshotHashes.promotionSetHash,
            cleanupEvidenceSetHash: snapshotHashes.cleanupEvidenceSetHash,
            withdrawalCycleHash: snapshotHashes.withdrawalCycleHash,
            approvedOriginHash: snapshotHashes.approvedOriginHash,
            targetSetHash: snapshotHashes.targetSetHash,
            generationCount: snapshotHashes.generationCount,
            targetCount: snapshotHashes.targetCount,
            verifiedStateVersion: input.expectedStateVersion,
            mediaDeliveryEpochIdHash: epoch.epochIdHash,
            deliveryContractHash: epoch.deliveryContractHash,
            deliveryVersionHash: epoch.deliveryVersionHash,
            idempotencyKeyHash,
            payloadFingerprint,
            targetProofHashes: targetProofRows.map(row => row.proofHash),
            witnessProofHash: witnessProof.proofHash,
            receiptAt
        });

        const statements = [
            ...targetProofRows.map(row => env.DB.prepare(
                PUBLIC_HOST_VERIFIER_SQL.insertTargetProof
            ).bind(
                attempt.verificationId,
                row.approvedObjectKeyHash,
                row.role,
                row.publicUrlHash,
                row.expectedSha256,
                row.headEvidenceHash,
                row.getEvidenceHash,
                row.finalHeadEvidenceHash,
                attempt.deliveryContractHash,
                attempt.deliveryVersionHash,
                proofAt
            )),
            env.DB.prepare(PUBLIC_HOST_VERIFIER_SQL.insertWitnessProof).bind(
                attempt.verificationId,
                configEvidence.witnessObjectKeyHash,
                config.witnessSha256,
                config.witnessByteCount,
                config.witnessContentType,
                witnessProof.beforeHeadEvidenceHash,
                witnessProof.beforeGetEvidenceHash,
                witnessProof.afterHeadEvidenceHash,
                witnessProof.afterGetEvidenceHash,
                attempt.deliveryContractHash,
                attempt.deliveryVersionHash,
                proofAt
            ),
            env.DB.prepare(verificationPurpose === 'withdrawal'
                ? PUBLIC_HOST_VERIFIER_SQL.insertReceipt
                : PUBLIC_HOST_VERIFIER_SQL.insertRetentionReceipt
            ).bind(...receiptInsertBindings(attempt, finalReceiptHash, receiptAt))
        ];
        if (verificationPurpose === 'withdrawal') {
            statements.push(
                env.DB.prepare(PUBLIC_HOST_VERIFIER_SQL.confirmHostDeletion).bind(
                    draftId,
                    input.expectedStateVersion,
                    receiptAt
                )
            );
        }

        try {
            await runBatch(env.DB, statements);
        } catch {
            const replay = await queryFirst(
                env.DB,
                PUBLIC_HOST_VERIFIER_SQL.readCurrentReceipt,
                draftId,
                input.idempotencyKey
            );
            return replay && currentReceiptMatches(
                replay, input, epoch, verificationPurpose
            ) &&
                replay.payloadFingerprint === payloadFingerprint
                ? success(200, replay.verificationId, true)
                : failure(409, 'state-or-generation-drift');
        }
        return success(201, verificationId, false);
    } catch {
        return failure(503, 'public-host-unverifiable');
    }
}

function verificationInsertBindings(attempt) {
    const commonBeforePurpose = [
        attempt.verificationId,
        attempt.verificationIdHash,
        attempt.draftId,
        attempt.draftIdHash,
        attempt.expectedStateVersion
    ];
    const commonAfterPurpose = [
        attempt.withdrawalKind,
        attempt.withdrawalCycleHash,
        attempt.promotionSetHash,
        attempt.cleanupEvidenceSetHash,
        attempt.approvedOriginHash,
        attempt.targetSetHash,
        attempt.generationCount,
        attempt.generationTargetRowCount,
        attempt.targetCount,
        attempt.mediaDeliveryEpochIdHash,
        attempt.deliveryContractHash,
        attempt.deliveryVersionHash,
        attempt.idempotencyKey,
        attempt.idempotencyKeyHash,
        attempt.payloadFingerprint,
        attempt.actorIdentityHash,
        attempt.createdAt
    ];
    return attempt.verificationPurpose === 'withdrawal'
        ? [...commonBeforePurpose, ...commonAfterPurpose]
        : [
            ...commonBeforePurpose,
            attempt.verificationPurpose,
            attempt.purposeEvidenceHash,
            ...commonAfterPurpose
        ];
}

function receiptInsertBindings(attempt, finalReceiptHash, receiptAt) {
    const commonBeforePurpose = [
        finalReceiptHash,
        attempt.verificationIdHash,
        attempt.draftIdHash,
        attempt.promotionSetHash,
        attempt.cleanupEvidenceSetHash,
        attempt.withdrawalCycleHash,
        attempt.approvedOriginHash,
        attempt.targetSetHash,
        attempt.generationCount,
        attempt.targetCount,
        attempt.expectedStateVersion
    ];
    const commonAfterPurpose = [
        attempt.mediaDeliveryEpochIdHash,
        attempt.deliveryContractHash,
        attempt.deliveryVersionHash,
        attempt.idempotencyKeyHash,
        attempt.payloadFingerprint,
        receiptAt
    ];
    return attempt.verificationPurpose === 'withdrawal'
        ? [...commonBeforePurpose, ...commonAfterPurpose]
        : [
            ...commonBeforePurpose,
            attempt.verificationPurpose,
            attempt.purposeEvidenceHash,
            ...commonAfterPurpose
        ];
}

async function readSnapshot(database, draftId, draftIdHash, config) {
    const evidence = await queryFirst(
        database,
        PUBLIC_HOST_VERIFIER_SQL.readEvidence,
        draftId
    );
    if (!evidence) return { exists: false };
    const [cleanupEvidence, generations, targets] = await Promise.all([
        queryAll(database, PUBLIC_HOST_VERIFIER_SQL.readCleanupEvidence, draftId),
        queryAll(database, PUBLIC_HOST_VERIFIER_SQL.readGenerations, draftId),
        queryAll(database, PUBLIC_HOST_VERIFIER_SQL.readTargets, draftId)
    ]);
    return normalizeSnapshot(
        evidence,
        cleanupEvidence,
        generations,
        targets,
        draftIdHash,
        config
    );
}

function normalizeSnapshot(
    evidence,
    cleanupEvidence,
    generations,
    targets,
    draftIdHash,
    config
) {
    if (![cleanupEvidence, generations, targets].every(Array.isArray)) {
        return { exists: true, valid: false };
    }
    const generationById = new Map();
    const normalizedGenerations = [];
    for (const row of generations) {
        if (
            !PROMOTION_ID_PATTERN.test(row.generationId || '') ||
            generationById.has(row.generationId) ||
            !SHA256_PATTERN.test(row.promotionIdHash || '') ||
            row.approvedOrigin !== config.mediaOrigin ||
            !SHA256_PATTERN.test(row.approvedOriginHash || '') ||
            !Number.isSafeInteger(row.candidateStateVersion) ||
            row.candidateStateVersion < 1 ||
            !SHA256_PATTERN.test(row.generationFingerprint || '') ||
            !SHA256_PATTERN.test(row.targetSetHash || '') ||
            !validIsoTime(row.createdAt)
        ) return { exists: true, valid: false };
        const normalized = { ...row };
        generationById.set(row.generationId, normalized);
        normalizedGenerations.push(normalized);
    }

    const rolesByGeneration = new Map();
    const normalizedTargets = [];
    for (const row of targets) {
        const generation = generationById.get(row.generationId);
        const keyMatch = APPROVED_MEDIA_KEY_PATTERN.exec(
            row.approvedObjectKey || ''
        );
        const expectedFile = row.role === 'photo-display'
            ? 'display'
            : row.role === 'photo-thumbnail'
                ? 'thumbnail'
                : null;
        if (
            !generation ||
            row.promotionIdHash !== generation.promotionIdHash ||
            !keyMatch ||
            keyMatch[1] !== row.expectedSha256 ||
            keyMatch[2] !== expectedFile ||
            !SHA256_PATTERN.test(row.approvedObjectKeyHash || '') ||
            !SHA256_PATTERN.test(row.publicUrlHash || '') ||
            !SHA256_PATTERN.test(row.generationTargetSetHash || '') ||
            !validIsoTime(row.createdAt)
        ) return { exists: true, valid: false };
        const roles = rolesByGeneration.get(row.generationId) || new Set();
        if (roles.has(row.role)) return { exists: true, valid: false };
        roles.add(row.role);
        rolesByGeneration.set(row.generationId, roles);
        normalizedTargets.push({ ...row });
    }
    if (normalizedGenerations.some(generation => {
        const roles = rolesByGeneration.get(generation.generationId);
        return !roles ||
            roles.size !== REQUIRED_TARGET_ROLES.length ||
            REQUIRED_TARGET_ROLES.some(role => !roles.has(role));
    })) return { exists: true, valid: false };

    const cleanupByPromotion = new Map();
    const normalizedCleanup = [];
    for (const row of cleanupEvidence) {
        if (
            !SHA256_PATTERN.test(row.promotionIdHash || '') ||
            !SHA256_PATTERN.test(row.cleanupEvidenceHash || '') ||
            !validIsoTime(row.completedAt) ||
            cleanupByPromotion.has(row.promotionIdHash)
        ) return { exists: true, valid: false };
        cleanupByPromotion.set(row.promotionIdHash, row);
        normalizedCleanup.push({ ...row });
    }
    const generationPromotionHashes = new Set(
        normalizedGenerations.map(row => row.promotionIdHash)
    );
    if (
        cleanupByPromotion.size !== generationPromotionHashes.size ||
        [...generationPromotionHashes].some(hash => !cleanupByPromotion.has(hash)) ||
        [...cleanupByPromotion].some(([hash]) => !generationPromotionHashes.has(hash))
    ) return { exists: true, valid: false };

    return {
        exists: true,
        valid: true,
        evidence: {
            draftId: evidence.draftId,
            state: evidence.state,
            stateVersion: evidence.stateVersion,
            withdrawalKind: evidence.withdrawalKind,
            hostDeletionConfirmed: evidence.hostDeletionConfirmed,
            priorWithdrawalCycleHash: evidence.priorWithdrawalCycleHash,
            retentionPurgeKind: evidence.retentionPurgeKind,
            retentionEligibleAt: evidence.retentionEligibleAt,
            retentionApprovedAt: evidence.retentionApprovedAt,
            retentionApprovedByIdentityHash:
                evidence.retentionApprovedByIdentityHash,
            retentionEvidenceHash: evidence.retentionEvidenceHash,
            approvedReferenceCount: evidence.approvedReferenceCount,
            activePromotionCount: evidence.activePromotionCount,
            incompleteCleanupCount: evidence.incompleteCleanupCount,
            draftIdHash
        },
        cleanupEvidence: normalizedCleanup,
        generations: normalizedGenerations,
        targets: normalizedTargets
    };
}

function deriveVerificationPurpose(snapshot, expectedStateVersion) {
    const evidence = snapshot?.evidence || {};
    if (evidence.stateVersion !== expectedStateVersion) return null;
    if (
        ['withdrawal-pending', 'withdrawn'].includes(evidence.state) &&
        ['editorial-removal', 'athlete-exclusion', 'consent-withdrawal']
            .includes(evidence.withdrawalKind)
    ) return 'withdrawal';
    if (
        ['rejected', 'processing-failed'].includes(evidence.state) &&
        evidence.withdrawalKind === null &&
        evidence.retentionPurgeKind === 'retention-expiry' &&
        SHA256_PATTERN.test(evidence.retentionEvidenceHash || '')
    ) return 'retention-expiry';
    return null;
}

function snapshotEligible(snapshot, expectedStateVersion, verificationPurpose) {
    const evidence = snapshot?.evidence || {};
    const common = snapshot?.valid === true &&
        evidence.stateVersion === expectedStateVersion &&
        evidence.hostDeletionConfirmed === 0 &&
        evidence.approvedReferenceCount === 0 &&
        evidence.activePromotionCount === 0 &&
        evidence.incompleteCleanupCount === 0;
    if (!common) return false;
    if (verificationPurpose === 'withdrawal') {
        return ['withdrawal-pending', 'withdrawn'].includes(evidence.state) &&
            ['editorial-removal', 'athlete-exclusion', 'consent-withdrawal']
                .includes(evidence.withdrawalKind);
    }
    return verificationPurpose === 'retention-expiry' &&
        ['rejected', 'processing-failed'].includes(evidence.state) &&
        evidence.withdrawalKind === null &&
        evidence.retentionPurgeKind === 'retention-expiry' &&
        validIsoTime(evidence.retentionEligibleAt) &&
        validIsoTime(evidence.retentionApprovedAt) &&
        evidence.retentionEligibleAt <= evidence.retentionApprovedAt &&
        SHA256_PATTERN.test(evidence.retentionApprovedByIdentityHash || '') &&
        SHA256_PATTERN.test(evidence.retentionEvidenceHash || '');
}

async function hashSnapshot(
    snapshot,
    draftIdHash,
    configuredOriginHash,
    verificationPurpose
) {
    if (snapshot.generations.some(row =>
        row.approvedOriginHash !== configuredOriginHash
    )) throw new Error('Generation origin hash mismatch.');

    const promotionRecords = snapshot.generations.map(row =>
        `promotion:${row.promotionIdHash}`
    );
    const cleanupRecords = snapshot.cleanupEvidence.map(row =>
        `cleanup:${row.promotionIdHash}:${row.cleanupEvidenceHash}`
    );
    const targetRecords = [];
    for (const target of snapshot.targets) {
        const expectedKeyHash = await sha256Text(
            `approved-object-key:${target.approvedObjectKey}`
        );
        const generation = snapshot.generations.find(
            row => row.generationId === target.generationId
        );
        const expectedUrlHash = await sha256Text(
            `public-media-url:${generation.approvedOrigin}/${target.approvedObjectKey}`
        );
        if (
            target.approvedObjectKeyHash !== expectedKeyHash ||
            target.publicUrlHash !== expectedUrlHash
        ) throw new Error('Generation target hash mismatch.');
        targetRecords.push(targetRecord(target));
    }
    for (const generation of snapshot.generations) {
        const generationTargets = snapshot.targets.filter(
            row => row.generationId === generation.generationId
        );
        const generationHash = await hashSet(
            generationTargets.map(targetRecord)
        );
        if (
            generation.targetSetHash !== generationHash ||
            generationTargets.some(row =>
                row.generationTargetSetHash !== generationHash
            )
        ) throw new Error('Generation target-set hash mismatch.');
    }

    const withdrawalCycleHash = verificationPurpose === 'retention-expiry'
        ? await sha256Text(
            `retention-expiry-cycle:${draftIdHash}:` +
            `${snapshot.evidence.state}:${snapshot.evidence.stateVersion}:` +
            `${snapshot.evidence.retentionEvidenceHash}`
        )
        : snapshot.evidence.state === 'withdrawn' &&
                SHA256_PATTERN.test(snapshot.evidence.priorWithdrawalCycleHash || '')
            ? snapshot.evidence.priorWithdrawalCycleHash
            : await sha256Text(
                `withdrawal-cycle:${draftIdHash}:` +
                `${snapshot.evidence.withdrawalKind}:` +
                `${snapshot.evidence.stateVersion}`
            );
    const uniqueKeyCount = new Set(
        snapshot.targets.map(row => row.approvedObjectKeyHash)
    ).size;
    return {
        withdrawalCycleHash,
        promotionSetHash: await hashSet(promotionRecords),
        cleanupEvidenceSetHash: await hashSet(cleanupRecords),
        approvedOriginHash: configuredOriginHash,
        targetSetHash: await hashSet(targetRecords),
        generationCount: snapshot.generations.length,
        generationTargetRowCount: snapshot.targets.length,
        targetCount: uniqueKeyCount
    };
}

function targetRecord(target) {
    return `target:${target.promotionIdHash}:${target.role}:` +
        `${target.approvedObjectKeyHash}:${target.publicUrlHash}:` +
        `${target.expectedSha256}`;
}

function sameSnapshotHashes(left, right) {
    return [
        'withdrawalCycleHash',
        'promotionSetHash',
        'cleanupEvidenceSetHash',
        'approvedOriginHash',
        'targetSetHash',
        'generationCount',
        'generationTargetRowCount',
        'targetCount'
    ].every(key => left[key] === right[key]);
}

function uniqueTargets(targets) {
    const byHash = new Map();
    for (const target of targets) {
        if (byHash.has(target.approvedObjectKeyHash)) {
            throw new Error('Duplicate retained public key.');
        }
        byHash.set(target.approvedObjectKeyHash, target);
    }
    return [...byHash.values()].sort((left, right) =>
        left.approvedObjectKey.localeCompare(right.approvedObjectKey)
    );
}

async function reserveKeys(database, targets, attempt) {
    if (targets.length === 0) return true;
    for (const target of targets) {
        const existing = await queryFirst(
            database,
            PUBLIC_HOST_VERIFIER_SQL.readReservation,
            target.approvedObjectKeyHash
        );
        if (existing) {
            if (!reservationMatchesLineage(existing, target, attempt)) return false;
            continue;
        }
        const statement = database.prepare(PUBLIC_HOST_VERIFIER_SQL.reserveKey).bind(
            target.approvedObjectKeyHash,
            attempt.verificationIdHash,
            target.promotionIdHash,
            attempt.draftIdHash,
            attempt.withdrawalCycleHash,
            attempt.idempotencyKeyHash,
            attempt.actorIdentityHash,
            attempt.createdAt
        );
        try {
            await runBatch(database, [statement]);
        } catch {
            const raced = await queryFirst(
                database,
                PUBLIC_HOST_VERIFIER_SQL.readReservation,
                target.approvedObjectKeyHash
            );
            if (!reservationMatchesLineage(raced, target, attempt)) return false;
        }
    }
    return true;
}

async function reservationsMatch(database, targets, attempt) {
    for (const target of targets) {
        const row = await queryFirst(
            database,
            PUBLIC_HOST_VERIFIER_SQL.readReservation,
            target.approvedObjectKeyHash
        );
        if (!reservationMatchesLineage(row, target, attempt)) return false;
    }
    return true;
}

function reservationMatchesLineage(row, target, attempt) {
    return Boolean(row) &&
        row.approvedObjectKeyHash === target.approvedObjectKeyHash &&
        row.promotionIdHash === target.promotionIdHash &&
        row.draftIdHash === attempt.draftIdHash &&
        SHA256_PATTERN.test(row.verificationIdHash || '') &&
        SHA256_PATTERN.test(row.withdrawalCycleHash || '') &&
        SHA256_PATTERN.test(row.reservationIdempotencyKeyHash || '') &&
        SHA256_PATTERN.test(row.reservedByIdentityHash || '') &&
        validIsoTime(row.reservedAt);
}

async function proveHostAbsence(fetcher, config, targets, requestedTimeout) {
    const timeout = normalizedTimeout(requestedTimeout);
    const witnessEvidence = { before: {}, after: {} };
    const targetEvidence = new Map();

    for (const method of ['HEAD', 'GET']) {
        const observation = await verifyWitness(fetcher, config, method, timeout);
        if (!observation.ok) return observation;
        witnessEvidence.before[method.toLowerCase()] = observation.evidence;
    }
    for (const target of targets) {
        const url = `${config.mediaOrigin}/${target.approvedObjectKey}`;
        const evidence = {};
        for (const method of ['HEAD', 'GET']) {
            const observation = await verifyAbsentTarget(
                fetcher, config, url, method, timeout
            );
            if (!observation.ok) return observation;
            evidence[method.toLowerCase()] = observation.evidence;
        }
        targetEvidence.set(target.approvedObjectKeyHash, evidence);
    }
    for (const method of ['HEAD', 'GET']) {
        const observation = await verifyWitness(fetcher, config, method, timeout);
        if (!observation.ok) return observation;
        witnessEvidence.after[method.toLowerCase()] = observation.evidence;
    }
    for (const target of targets) {
        const url = `${config.mediaOrigin}/${target.approvedObjectKey}`;
        const observation = await verifyAbsentTarget(
            fetcher, config, url, 'HEAD', timeout
        );
        if (!observation.ok) return observation;
        targetEvidence.get(target.approvedObjectKeyHash).finalHead =
            observation.evidence;
    }
    return { ok: true, witnessEvidence, targetEvidence };
}

async function verifyWitness(fetcher, config, method, timeout) {
    const url = `${config.mediaOrigin}/${config.witnessKey}`;
    try {
        return await withStrictResponse(
            fetcher,
            url,
            method,
            timeout,
            async (response, bodyTimeout) => {
                if (
                    !baseResponseMatches(response, config, url, 200) ||
                    response.headers.get('Content-Type') !==
                        config.witnessContentType ||
                    response.headers.get('Content-Length') !==
                        String(config.witnessByteCount)
                ) return unverifiable();
                let bodyHash = null;
                if (method === 'GET') {
                    const bytes = await readBoundedResponseBytes(
                        response,
                        config.witnessByteCount,
                        bodyTimeout
                    );
                    if (bytes.byteLength !== config.witnessByteCount) {
                        return unverifiable();
                    }
                    bodyHash = await sha256Bytes(bytes);
                    if (bodyHash !== config.witnessSha256) return unverifiable();
                } else if (response.body !== null) {
                    return unverifiable();
                }
                return {
                    ok: true,
                    evidence: responseEvidence(response, method, bodyHash)
                };
            }
        );
    } catch {
        return unverifiable();
    }
}

async function verifyAbsentTarget(fetcher, config, url, method, timeout) {
    try {
        return await withStrictResponse(
            fetcher,
            url,
            method,
            timeout,
            async (response, bodyTimeout) => {
                if (response.status >= 200 && response.status < 300) {
                    await safelyCancel(response.body);
                    return failure(409, 'public-host-object-present');
                }
                if (!baseResponseMatches(response, config, url, 404)) {
                    await safelyCancel(response.body);
                    return unverifiable();
                }
                if (method === 'HEAD') {
                    if (response.body !== null) return unverifiable();
                } else {
                    const bytes = await readBoundedResponseBytes(
                        response,
                        MAX_ABSENCE_BODY_BYTES,
                        bodyTimeout
                    );
                    if (bytes.byteLength !== 0) return unverifiable();
                }
                return {
                    ok: true,
                    evidence: responseEvidence(response, method, null)
                };
            }
        );
    } catch {
        return unverifiable();
    }
}

async function withStrictResponse(fetcher, url, method, timeout, consumer) {
    const controller = new AbortController();
    const deadline = Date.now() + timeout;
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    const request = new Request(url, {
        method,
        redirect: 'manual',
        cache: 'no-store',
        credentials: 'omit',
        headers: {
            Accept: method === 'GET' ? 'image/webp' : '*/*',
            'Cache-Control': 'no-cache, no-store',
            Pragma: 'no-cache'
        },
        signal: controller.signal
    });
    try {
        const response = await fetcher(request);
        return await consumer(response, Math.max(1, deadline - Date.now()));
    } finally {
        clearTimeout(timeoutId);
        controller.abort();
    }
}

function baseResponseMatches(response, config, expectedUrl, expectedStatus) {
    return response &&
        response.status === expectedStatus &&
        response.url === expectedUrl &&
        response.redirected === false &&
        response.headers?.get?.('Location') === null &&
        response.headers.get('Cache-Control') === 'no-store' &&
        response.headers.get(MEDIA_DELIVERY_CONTRACT_HEADER) ===
            config.mediaContract &&
        response.headers.get(MEDIA_DELIVERY_VERSION_HEADER) ===
            config.mediaVersion;
}

function responseEvidence(response, method, bodyHash) {
    return {
        method,
        status: response.status,
        contract: response.headers.get(MEDIA_DELIVERY_CONTRACT_HEADER),
        version: response.headers.get(MEDIA_DELIVERY_VERSION_HEADER),
        cacheControl: response.headers.get('Cache-Control'),
        contentType: response.headers.get('Content-Type'),
        contentLength: response.headers.get('Content-Length'),
        bodyHash
    };
}

async function readBoundedResponseBytes(response, maximumBytes, timeout) {
    if (!response.body || typeof response.body.getReader !== 'function') {
        return new Uint8Array(0);
    }
    const reader = response.body.getReader();
    const deadline = Date.now() + timeout;
    const chunks = [];
    let length = 0;
    try {
        while (true) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new Error('Response body timed out.');
            const result = await readWithTimeout(reader, remaining);
            if (result.done) break;
            length += result.value.byteLength;
            if (length > maximumBytes) {
                await reader.cancel();
                throw new Error('Response exceeded verifier limit.');
            }
            chunks.push(result.value);
        }
    } finally {
        try {
            reader.releaseLock();
        } catch {
            // A timed-out read is already a failed proof.
        }
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

function readWithTimeout(reader, timeout) {
    let timeoutId;
    return Promise.race([
        reader.read(),
        new Promise((resolve, reject) => {
            timeoutId = setTimeout(() => {
                reject(new Error('Response body timed out.'));
                try {
                    void Promise.resolve(
                        reader.cancel('public-host-verifier-body-timeout')
                    ).catch(() => {});
                } catch {
                    // The timeout remains a failed proof.
                }
            }, timeout);
        })
    ]).finally(() => clearTimeout(timeoutId));
}

async function safelyCancel(body) {
    try {
        await body?.cancel?.();
    } catch {
        // A cancellation error cannot convert a non-proof into proof.
    }
}

async function buildTargetProofRows(targets, evidenceByKey, attempt, verifiedAt) {
    const rows = [];
    for (const target of targets) {
        const evidence = evidenceByKey.get(target.approvedObjectKeyHash);
        if (!evidence?.head || !evidence?.get || !evidence?.finalHead) {
            throw new Error('Incomplete target network evidence.');
        }
        const row = {
            approvedObjectKeyHash: target.approvedObjectKeyHash,
            role: target.role,
            publicUrlHash: target.publicUrlHash,
            expectedSha256: target.expectedSha256,
            headEvidenceHash: await fingerprint(evidence.head),
            getEvidenceHash: await fingerprint(evidence.get),
            finalHeadEvidenceHash: await fingerprint(evidence.finalHead)
        };
        row.proofHash = await fingerprint({
            verificationIdHash: attempt.verificationIdHash,
            ...row,
            verifiedAt
        });
        rows.push(row);
    }
    return rows;
}

async function buildWitnessProof(
    evidence,
    config,
    configEvidence,
    attempt,
    verifiedAt
) {
    const proof = {
        beforeHeadEvidenceHash: await fingerprint(evidence.before.head),
        beforeGetEvidenceHash: await fingerprint(evidence.before.get),
        afterHeadEvidenceHash: await fingerprint(evidence.after.head),
        afterGetEvidenceHash: await fingerprint(evidence.after.get)
    };
    proof.proofHash = await fingerprint({
        verificationIdHash: attempt.verificationIdHash,
        witnessObjectKeyHash: configEvidence.witnessObjectKeyHash,
        witnessSha256: config.witnessSha256,
        witnessByteCount: config.witnessByteCount,
        witnessContentType: config.witnessContentType,
        ...proof,
        verifiedAt
    });
    return proof;
}

function readConfig(env) {
    const mediaOrigin = normalizeOrigin(env?.APPROVED_MEDIA_ORIGIN);
    const verifierOrigin = normalizeOrigin(env?.PUBLIC_HOST_VERIFIER_ORIGIN);
    const keyMatch = APPROVED_MEDIA_KEY_PATTERN.exec(env?.MEDIA_WITNESS_KEY || '');
    const witnessByteCount = Number(env?.MEDIA_WITNESS_BYTE_COUNT);
    if (
        !env ||
        Object.keys(env).length !== EXACT_SERVICE_ENVIRONMENT_KEYS.length ||
        !Object.keys(env).every(key =>
            EXACT_SERVICE_ENVIRONMENT_KEYS.includes(key)
        ) ||
        !env?.DB ||
        typeof env.DB.prepare !== 'function' ||
        typeof env.DB.batch !== 'function' ||
        !mediaOrigin ||
        !verifierOrigin ||
        mediaOrigin === verifierOrigin ||
        !/^subject:[0-9a-f]{32}\.access$/i.test(
            env.PUBLIC_HOST_VERIFIER_IDENTITY || ''
        ) ||
        env.MEDIA_CONTRACT !== MEDIA_DELIVERY_CONTRACT_VALUE ||
        !MEDIA_VERSION_PATTERN.test(env.EXPECTED_MEDIA_VERSION || '') ||
        !keyMatch ||
        env.MEDIA_WITNESS_KEY !== MEDIA_BINDING_WITNESS_KEY ||
        env.MEDIA_WITNESS_SHA256 !== MEDIA_BINDING_WITNESS_SHA256 ||
        keyMatch[1] !== env.MEDIA_WITNESS_SHA256 ||
        keyMatch[2] !== 'display' ||
        !Number.isSafeInteger(witnessByteCount) ||
        witnessByteCount !== MEDIA_BINDING_WITNESS_SIZE ||
        witnessByteCount <= 0 ||
        witnessByteCount > MAX_WITNESS_BYTES ||
        env.MEDIA_WITNESS_CONTENT_TYPE !== MEDIA_BINDING_WITNESS_CONTENT_TYPE
    ) return null;
    return {
        mediaOrigin,
        mediaContract: env.MEDIA_CONTRACT,
        mediaVersion: env.EXPECTED_MEDIA_VERSION,
        witnessKey: env.MEDIA_WITNESS_KEY,
        witnessSha256: env.MEDIA_WITNESS_SHA256,
        witnessByteCount,
        witnessContentType: env.MEDIA_WITNESS_CONTENT_TYPE
    };
}

async function buildConfigEvidence(config) {
    return {
        approvedOriginHash: await sha256Text(
            `approved-media-origin:${config.mediaOrigin}`
        ),
        deliveryContractHash: await sha256Text(
            `approved-media-contract:${config.mediaContract}`
        ),
        deliveryVersionHash: await sha256Text(
            `approved-media-version:${config.mediaVersion}`
        ),
        witnessObjectKeyHash: await sha256Text(
            `approved-object-key:${config.witnessKey}`
        )
    };
}

function epochMatchesConfig(epoch, config, evidence) {
    return epoch &&
        SHA256_PATTERN.test(epoch.epochIdHash || '') &&
        Number.isSafeInteger(epoch.epochSequence) &&
        epoch.epochSequence >= 1 &&
        epoch.approvedOrigin === config.mediaOrigin &&
        epoch.approvedOriginHash === evidence.approvedOriginHash &&
        epoch.deliveryContractHash === evidence.deliveryContractHash &&
        epoch.deliveryVersionHash === evidence.deliveryVersionHash &&
        epoch.witnessObjectKeyHash === evidence.witnessObjectKeyHash &&
        epoch.witnessSha256 === config.witnessSha256 &&
        epoch.witnessByteCount === config.witnessByteCount &&
        epoch.witnessContentType === config.witnessContentType &&
        validIsoTime(epoch.activatedAt);
}

function sameEpoch(left, right) {
    return left && right && [
        'epochIdHash',
        'epochSequence',
        'approvedOrigin',
        'approvedOriginHash',
        'deliveryContractHash',
        'deliveryVersionHash',
        'witnessObjectKeyHash',
        'witnessSha256',
        'witnessByteCount',
        'witnessContentType',
        'activatedAt'
    ].every(key => left[key] === right[key]);
}

function currentReceiptMatches(receipt, input, epoch, verificationPurpose) {
    return receiptPurpose(receipt) === verificationPurpose &&
        (verificationPurpose === 'withdrawal'
            ? (receipt.purposeEvidenceHash ?? null) === null
            : SHA256_PATTERN.test(receipt.purposeEvidenceHash || '')) &&
        /^hostverify_[a-f0-9]{32}$/.test(receipt.verificationId || '') &&
        receipt.expectedStateVersion === input.expectedStateVersion &&
        receipt.idempotencyKey === input.idempotencyKey &&
        SHA256_PATTERN.test(receipt.idempotencyKeyHash || '') &&
        SHA256_PATTERN.test(receipt.payloadFingerprint || '') &&
        receipt.mediaDeliveryEpochIdHash === epoch.epochIdHash &&
        receipt.deliveryContractHash === epoch.deliveryContractHash &&
        receipt.deliveryVersionHash === epoch.deliveryVersionHash &&
        SHA256_PATTERN.test(receipt.finalReceiptHash || '') &&
        validIsoTime(receipt.verifiedAt);
}

function verificationMatches(row, attempt, includeCreatedAt) {
    const keys = [
        'verificationId', 'verificationIdHash', 'draftId', 'draftIdHash',
        'expectedStateVersion', 'withdrawalKind', 'withdrawalCycleHash',
        'promotionSetHash', 'cleanupEvidenceSetHash', 'approvedOriginHash',
        'targetSetHash', 'generationCount', 'generationTargetRowCount',
        'targetCount', 'mediaDeliveryEpochIdHash', 'deliveryContractHash',
        'deliveryVersionHash', 'idempotencyKey', 'idempotencyKeyHash',
        'payloadFingerprint'
    ];
    if (includeCreatedAt) keys.push('createdAt');
    return receiptPurpose(row) === attempt.verificationPurpose &&
        (row.purposeEvidenceHash ?? null) === attempt.purposeEvidenceHash &&
        row.serviceActorIdentityHash === attempt.actorIdentityHash &&
        keys.every(key => row[key] === attempt[key]) &&
        validIsoTime(row.createdAt);
}

function receiptPurpose(row) {
    const value = row?.verificationPurpose ?? 'withdrawal';
    return ['withdrawal', 'retention-expiry'].includes(value) ? value : null;
}

async function runBatch(database, statements) {
    const results = await database.batch(statements);
    if (
        !Array.isArray(results) ||
        results.length !== statements.length ||
        results.some(result => result?.success === false)
    ) throw new Error('Public-host verifier D1 batch failed.');
    return results;
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

function validInput(input) {
    return isPlainObject(input) &&
        hasExactKeys(input, INPUT_KEYS) &&
        Number.isSafeInteger(input.expectedStateVersion) &&
        input.expectedStateVersion >= 0 &&
        IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey || '');
}

function validServiceIdentity(identity) {
    return identity?.type === 'service' &&
        typeof identity.subject === 'string' &&
        /^[0-9a-f]{32}\.access$/i.test(identity.subject);
}

function normalizeOrigin(value) {
    if (typeof value !== 'string' || value.trim() !== value) return null;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' &&
            url.origin === value &&
            url.username === '' &&
            url.password === '' &&
            url.port === '' &&
            url.pathname === '/' &&
            url.search === '' &&
            url.hash === ''
            ? url.origin
            : null;
    } catch {
        return null;
    }
}

function normalizedTimeout(value) {
    return Number.isSafeInteger(value) && value >= 1 && value <= 30_000
        ? value
        : DEFAULT_FETCH_TIMEOUT_MILLISECONDS;
}

function nextIsoTime(requestedMilliseconds, provider, predecessorTimes) {
    const providerValue = typeof provider === 'function' ? provider() : Date.now();
    const predecessors = [requestedMilliseconds, ...predecessorTimes.map(Date.parse)]
        .filter(Number.isFinite);
    return new Date(Math.max(
        Number.isFinite(providerValue) ? providerValue : Date.now(),
        ...predecessors.map(value => value + 1)
    )).toISOString();
}

function validIsoTime(value) {
    return typeof value === 'string' &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
        Number.isFinite(Date.parse(value));
}

function hasExactKeys(value, keys) {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length &&
        actual.every((key, index) => key === expected[index]);
}

function isPlainObject(value) {
    return value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype;
}

async function hashSet(records) {
    return sha256Text([...records].sort().join('\n'));
}

async function fingerprint(value) {
    return sha256Text(JSON.stringify(value));
}

async function sha256Text(value) {
    return sha256Bytes(textEncoder.encode(value));
}

async function sha256Bytes(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)]
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
}

function success(status, verificationId, replayed) {
    return {
        ok: true,
        status,
        verificationId,
        // This response reports the verified public-host fact. The legacy D1
        // compatibility scalar is deliberately separate and remains false for
        // a retention-expiry receipt.
        hostDeletionConfirmed: true,
        replayed
    };
}

function failure(status, code) {
    return { ok: false, status, code };
}

function unverifiable() {
    return failure(503, 'public-host-unverifiable');
}
