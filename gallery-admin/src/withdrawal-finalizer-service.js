import { readBoundedBytes, sha256Hex } from './media-byte-verification.js';
import { hashIdentity } from './session.js';
import {
    parsePrivateOriginalKey,
    privateOriginalKeyMatchesRecord
} from './storage-keys.js';

const textEncoder = new TextEncoder();
const DRAFT_ID_PATTERN =
    /^draft_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PROVIDER_VALUE_PATTERN = /^[^\u0000-\u001f\u007f]{1,256}$/;
const WITHDRAWAL_KINDS = new Set([
    'editorial-removal',
    'athlete-exclusion',
    'consent-withdrawal'
]);
const INPUT_KEYS = Object.freeze(['idempotencyKey']);
const MAX_ORIGINAL_BYTES = 25 * 1024 * 1024;
const MAX_LIST_PAGES = 10_000;

/**
 * Converge one of two D1-derived actions. A key first used while the draft is
 * withdrawal-pending can only complete withdrawal. A different key first used
 * after that receipt exists can only request the guarded purge.
 */
export async function finalizeGalleryWithdrawal(
    env,
    identity,
    draftId,
    input
) {
    if (
        !validBindings(env) ||
        !validServiceIdentity(identity) ||
        !DRAFT_ID_PATTERN.test(draftId || '') ||
        !validInput(input)
    ) return failure(400, 'invalid-request');

    try {
        const request = await buildRequestEvidence(draftId, input.idempotencyKey);
        if (!request) return failure(400, 'invalid-request');
        const permanentReplay = await readPermanentReplay(env.DB, request);
        if (permanentReplay) return permanentReplay;

        const state = await readLiveState(env.DB, draftId);
        if (!state) return failure(404, 'not-found');
        const action = await deriveAction(env.DB, state, request);
        if (!action) return failure(409, 'conflict');

        if (
            action.name === 'purge' &&
            !await retentionIsEligible(env.DB, action.withdrawalReceipt)
        ) {
            return success(202, 'retention-pending', {
                eligibleAt: action.withdrawalReceipt.retentionEligibleAt,
                replayed: false
            });
        }

        const hostReceipt = await readCurrentHostReceipt(
            env.DB,
            state,
            action
        );

        if (!hostReceipt) {
            const verifierRequest = await buildVerifierRequest(
                env.DB,
                state,
                action,
                request
            );
            return verifierRequest
                ? success(202, 'host-verification-required', {
                    expectedStateVersion: action.expectedStateVersion,
                    verifierIdempotencyKey: verifierRequest,
                    replayed: false
                })
                : failure(503, 'finalization-unavailable');
        }

        const context = await readFinalizationContext(
            env.DB,
            draftId,
            action,
            hostReceipt
        );
        if (!validContext(context, state, action)) {
            return failure(409, 'conflict');
        }

        let operation = await readOperation(env.DB, draftId, action.name);
        if (operation) {
            if (!operationMatches(operation, context, action, request)) {
                return failure(409, 'conflict');
            }
            operation = await refreshHostReceiptIfNeeded(
                env.DB,
                operation,
                context
            );
        } else {
            operation = await reserveOperation(
                env.DB,
                identity,
                context,
                action,
                request
            );
        }
        if (!operation) return failure(409, 'conflict');

        if (action.name === 'withdrawal') {
            return await (context.withdrawalKind === 'consent-withdrawal'
                ? completeConsentWithdrawal(
                    env,
                    context,
                    operation
                )
                : completeRetainedWithdrawal(
                    env.DB,
                    context,
                    operation
                ));
        }
        return await completePurge(
            env,
            context,
            operation
        );
    } catch (error) {
        return error instanceof FinalizationConflict
            ? failure(409, 'conflict')
            : failure(503, 'finalization-unavailable');
    }
}

async function readPermanentReplay(database, request) {
    const withdrawal = await queryFirst(database, `
        SELECT
            draft_id_hash AS draftIdHash,
            idempotency_key_hash AS idempotencyKeyHash,
            payload_fingerprint AS payloadFingerprint
        FROM gallery_withdrawal_completion_receipts
        WHERE idempotency_key_hash = ?1
    `, request.idempotencyKeyHash);
    if (withdrawal) {
        return replayMatches(withdrawal, request)
            ? success(200, 'withdrawn', { replayed: true })
            : failure(409, 'conflict');
    }

    const purge = await queryFirst(database, `
        SELECT
            draft_id_hash AS draftIdHash,
            idempotency_key_hash AS idempotencyKeyHash,
            payload_fingerprint AS payloadFingerprint
        FROM gallery_draft_purge_receipts
        WHERE idempotency_key_hash = ?1
    `, request.idempotencyKeyHash);
    if (purge) {
        return replayMatches(purge, request)
            ? success(200, 'purged', { replayed: true })
            : failure(409, 'conflict');
    }
    return null;
}

async function readLiveState(database, draftId) {
    return queryFirst(database, `
        SELECT
            draft.draft_id AS draftId,
            draft.state,
            draft.state_version AS stateVersion,
            draft.updated_at AS draftUpdatedAt,
            publication.withdrawal_kind AS withdrawalKind,
            publication.host_deletion_confirmed AS hostDeletionConfirmed,
            current.epoch_id_hash AS currentEpochIdHash
        FROM gallery_drafts AS draft
        JOIN draft_publication_references AS publication
          ON publication.draft_id = draft.draft_id
        LEFT JOIN gallery_media_delivery_current_epoch AS current
          ON current.singleton_id = 1
        WHERE draft.draft_id = ?1
    `, draftId);
}

async function deriveAction(database, state, request) {
    if (!WITHDRAWAL_KINDS.has(state.withdrawalKind)) return null;
    const withdrawalReceipt = await queryFirst(database, `
        SELECT
            withdrawal_receipt_hash AS withdrawalReceiptHash,
            draft_id_hash AS draftIdHash,
            expected_state_version AS expectedStateVersion,
            result_state_version AS resultStateVersion,
            withdrawal_kind AS withdrawalKind,
            withdrawal_cycle_hash AS withdrawalCycleHash,
            idempotency_key_hash AS idempotencyKeyHash,
            payload_fingerprint AS payloadFingerprint,
            withdrawn_at AS withdrawnAt,
            retention_eligible_at AS retentionEligibleAt
        FROM gallery_withdrawal_completion_receipts
        WHERE draft_id_hash = ?1
    `, request.draftIdHash);

    if (
        request.requestedAction === 'withdrawal' &&
        state.state === 'withdrawal-pending' &&
        !withdrawalReceipt
    ) {
        return {
            name: 'withdrawal',
            expectedStateVersion: state.stateVersion,
            withdrawalReceipt: null
        };
    }
    if (
        request.requestedAction === 'purge' &&
        state.state === 'withdrawn' &&
        withdrawalReceipt &&
        withdrawalReceipt.draftIdHash === request.draftIdHash &&
        withdrawalReceipt.resultStateVersion === state.stateVersion &&
        withdrawalReceipt.expectedStateVersion === state.stateVersion - 1 &&
        withdrawalReceipt.withdrawalKind === state.withdrawalKind
    ) {
        if (withdrawalReceipt.idempotencyKeyHash === request.idempotencyKeyHash) {
            return null;
        }
        const existingPurge = await queryFirst(database, `
            SELECT idempotency_key_hash AS idempotencyKeyHash,
                payload_fingerprint AS payloadFingerprint
            FROM draft_withdrawal_finalization_operations
            WHERE draft_id = ?1 AND action = 'purge'
        `, state.draftId);
        if (existingPurge && (
            existingPurge.idempotencyKeyHash !== request.idempotencyKeyHash ||
            existingPurge.payloadFingerprint !== request.payloadFingerprint
        )) return null;
        return {
            name: 'purge',
            expectedStateVersion: withdrawalReceipt.resultStateVersion,
            withdrawalReceipt
        };
    }
    return null;
}

async function retentionIsEligible(database, withdrawalReceipt) {
    if (!validIsoTime(withdrawalReceipt?.retentionEligibleAt)) return false;
    const row = await queryFirst(database, `
        SELECT CASE
            WHEN julianday('now') >= julianday(?1) THEN 1
            ELSE 0
        END AS eligible
    `, withdrawalReceipt.retentionEligibleAt);
    return row?.eligible === 1;
}

async function readCurrentHostReceipt(database, state, action) {
    if (state.hostDeletionConfirmed !== 1) return null;
    const allowedVersions = action.name === 'withdrawal'
        ? [action.expectedStateVersion]
        : [
            action.expectedStateVersion,
            action.withdrawalReceipt.expectedStateVersion
        ];
    const rows = await queryAll(database, `
        SELECT
            expected_state_version AS expectedStateVersion,
            withdrawal_cycle_hash AS withdrawalCycleHash,
            verification_id_hash AS publicHostVerificationIdHash,
            final_receipt_hash AS publicHostFinalReceiptHash,
            verified_at AS hostVerifiedAt
        FROM gallery_current_public_host_absence_receipts
        WHERE draft_id = ?1
          AND verification_purpose = 'withdrawal'
          AND withdrawal_kind = ?2
        ORDER BY expected_state_version DESC, verified_at DESC
    `, state.draftId, state.withdrawalKind);
    return rows.find(row =>
        allowedVersions.includes(row.expectedStateVersion) &&
        SHA256_PATTERN.test(row.withdrawalCycleHash || '') &&
        SHA256_PATTERN.test(row.publicHostVerificationIdHash || '') &&
        SHA256_PATTERN.test(row.publicHostFinalReceiptHash || '') &&
        validIsoTime(row.hostVerifiedAt)
    ) || null;
}

async function buildVerifierRequest(database, state, action, request) {
    const epoch = state.currentEpochIdHash || (await queryFirst(database, `
        SELECT epoch_id_hash AS epochIdHash
        FROM gallery_media_delivery_current_epoch WHERE singleton_id = 1
    `))?.epochIdHash;
    if (!SHA256_PATTERN.test(epoch || '')) return null;
    const digest = await hashText(canonicalJson({
        operation: 'gallery-public-host-verification-request',
        action: action.name,
        draftIdHash: request.draftIdHash,
        expectedStateVersion: action.expectedStateVersion,
        withdrawalKind: state.withdrawalKind,
        currentEpochIdHash: epoch,
        finalizerIdempotencyKeyHash: request.idempotencyKeyHash
    }));
    return `gallery_host_${digest.slice(0, 48)}`;
}

async function readFinalizationContext(database, draftId, action, hostReceipt) {
    const row = await queryFirst(database, `
        SELECT
            draft.draft_id AS draftId,
            draft.state,
            draft.state_version AS stateVersion,
            draft.updated_at AS draftUpdatedAt,
            draft.site_modes_json AS siteModesJson,
            draft.media_type AS mediaType,
            draft.item_revision AS itemRevision,
            draft.active_consent_revision AS activeConsentRevision,
            draft.export_bundle_id AS exportBundleId,
            draft.source_revision AS sourceRevision,
            draft.suppression_revision AS suppressionRevision,
            draft.original_object_key AS originalObjectKey,
            draft.original_detected_type AS originalDetectedType,
            draft.original_byte_count AS originalByteCount,
            draft.original_sha256 AS originalSha256,
            draft.upload_complete AS uploadComplete,
            publication.withdrawal_kind AS withdrawalKind,
            publication.host_deletion_confirmed AS hostDeletionConfirmed,
            publication.private_original_deletion_confirmed AS privateDeletionConfirmed,
            host.expected_state_version AS hostExpectedStateVersion,
            host.withdrawal_cycle_hash AS withdrawalCycleHash,
            host.verification_id_hash AS publicHostVerificationIdHash,
            host.final_receipt_hash AS publicHostFinalReceiptHash,
            host.verified_at AS hostVerifiedAt,
            permanent_host.promotion_set_hash AS promotionSetHash,
            permanent_host.cleanup_evidence_set_hash AS cleanupEvidenceSetHash,
            permanent_host.target_set_hash AS targetSetHash,
            permanent_host.approved_origin_hash AS approvedOriginHash,
            permanent_host.media_delivery_epoch_id_hash AS mediaDeliveryEpochIdHash,
            permanent_host.delivery_contract_hash AS deliveryContractHash,
            permanent_host.delivery_version_hash AS deliveryVersionHash,
            permanent_host.generation_count AS generationCount,
            permanent_host.target_count AS targetCount,
            upload.upload_session_id AS uploadSessionId,
            upload.object_key AS uploadObjectKey,
            upload.file_extension AS uploadFileExtension,
            upload.declared_content_type AS declaredContentType,
            upload.declared_byte_count AS declaredByteCount,
            upload.detected_format AS uploadDetectedFormat,
            upload.status AS uploadStatus,
            upload.completed_object_version AS providerObjectVersion,
            upload.completed_etag AS providerEtag,
            upload.completed_sha256 AS completedSha256,
            upload.item_revision AS uploadItemRevision,
            upload.consent_revision AS uploadConsentRevision,
            upload.export_bundle_id AS uploadExportBundleId,
            upload.source_revision AS uploadSourceRevision,
            upload.suppression_revision AS uploadSuppressionRevision,
            upload.real_photo_intake_confirmed AS realPhotoIntakeConfirmed,
            upload.created_at AS uploadCreatedAt,
            upload.completed_at AS uploadCompletedAt,
            consent.withdrawn_at AS consentWithdrawnAt
        FROM gallery_drafts AS draft
        JOIN draft_publication_references AS publication
          ON publication.draft_id = draft.draft_id
        JOIN gallery_current_public_host_absence_receipts AS host
          ON host.draft_id = draft.draft_id
         AND host.verification_purpose = 'withdrawal'
         AND host.withdrawal_kind = publication.withdrawal_kind
         AND host.verification_id_hash = ?2
         AND host.final_receipt_hash = ?3
        JOIN gallery_public_host_absence_receipts AS permanent_host
          ON permanent_host.final_receipt_hash = host.final_receipt_hash
        JOIN draft_upload_sessions AS upload
          ON upload.draft_id = draft.draft_id
         AND upload.object_key = draft.original_object_key
        JOIN draft_consent_attestations AS consent
          ON consent.draft_id = upload.draft_id
         AND consent.consent_revision = upload.consent_revision
        WHERE draft.draft_id = ?1
    `,
    draftId,
    hostReceipt.publicHostVerificationIdHash,
    hostReceipt.publicHostFinalReceiptHash
    );
    if (!row) return null;
    const prefixes = await queryAll(database, `
        SELECT object_key AS objectKey
        FROM draft_upload_sessions
        WHERE draft_id = ?1
        ORDER BY upload_session_id ASC
    `, draftId);
    row.privatePrefixes = derivePrivatePrefixes(prefixes, draftId);
    return row;
}

function validContext(context, state, action) {
    if (!context || !Array.isArray(context.privatePrefixes)) return false;
    let siteModes;
    try {
        siteModes = JSON.parse(context.siteModesJson);
    } catch {
        return false;
    }
    const site = Array.isArray(siteModes) && siteModes.length === 1
        ? siteModes[0]
        : null;
    const expectedLiveState = action.name === 'withdrawal'
        ? 'withdrawal-pending'
        : 'withdrawn';
    const expectedLiveVersion = action.expectedStateVersion;
    return ['family', 'everyone'].includes(site) &&
        context.draftId === state.draftId &&
        context.state === expectedLiveState &&
        context.stateVersion === expectedLiveVersion &&
        context.withdrawalKind === state.withdrawalKind &&
        context.mediaType === 'photo' &&
        context.uploadComplete === 1 &&
        context.privateDeletionConfirmed === (
            action.name === 'purge' && context.withdrawalKind === 'consent-withdrawal'
                ? 1
                : 0
        ) &&
        context.hostDeletionConfirmed === 1 &&
        (action.name === 'withdrawal'
            ? context.hostExpectedStateVersion === action.expectedStateVersion
            : [
                action.expectedStateVersion,
                action.withdrawalReceipt.expectedStateVersion
            ].includes(context.hostExpectedStateVersion)) &&
        context.uploadStatus === (
            action.name === 'purge' && context.withdrawalKind === 'consent-withdrawal'
                ? 'deleted'
                : 'complete'
        ) &&
        context.realPhotoIntakeConfirmed === 1 &&
        ['jpeg', 'png'].includes(context.originalDetectedType) &&
        context.uploadDetectedFormat === context.originalDetectedType &&
        originalUploadFormatMatches(context) &&
        context.originalObjectKey === context.uploadObjectKey &&
        context.originalByteCount === context.declaredByteCount &&
        context.originalSha256 === context.completedSha256 &&
        context.originalByteCount >= 1 &&
        context.originalByteCount <= MAX_ORIGINAL_BYTES &&
        SHA256_PATTERN.test(context.originalSha256 || '') &&
        PROVIDER_VALUE_PATTERN.test(context.providerObjectVersion || '') &&
        PROVIDER_VALUE_PATTERN.test(context.providerEtag || '') &&
        context.itemRevision === context.uploadItemRevision &&
        context.exportBundleId === context.uploadExportBundleId &&
        context.sourceRevision === context.uploadSourceRevision &&
        context.suppressionRevision === context.uploadSuppressionRevision &&
        SHA256_PATTERN.test(context.withdrawalCycleHash || '') &&
        SHA256_PATTERN.test(context.publicHostVerificationIdHash || '') &&
        SHA256_PATTERN.test(context.publicHostFinalReceiptHash || '') &&
        SHA256_PATTERN.test(context.promotionSetHash || '') &&
        SHA256_PATTERN.test(context.cleanupEvidenceSetHash || '') &&
        SHA256_PATTERN.test(context.targetSetHash || '') &&
        SHA256_PATTERN.test(context.approvedOriginHash || '') &&
        SHA256_PATTERN.test(context.mediaDeliveryEpochIdHash || '') &&
        SHA256_PATTERN.test(context.deliveryContractHash || '') &&
        SHA256_PATTERN.test(context.deliveryVersionHash || '') &&
        context.mediaDeliveryEpochIdHash === state.currentEpochIdHash &&
        Number.isSafeInteger(context.generationCount) &&
        context.generationCount >= 1 &&
        Number.isSafeInteger(context.targetCount) &&
        context.targetCount >= 1 &&
        validIsoTime(context.uploadCreatedAt) &&
        validIsoTime(context.uploadCompletedAt) &&
        privateOriginalKeyMatchesRecord(context.originalObjectKey, {
            site,
            uploadedAt: context.uploadCreatedAt,
            draftId: context.draftId,
            uploadId: context.uploadSessionId,
            extension: context.uploadFileExtension
        }) &&
        context.privatePrefixes.length >= 1 &&
        (action.name === 'withdrawal'
            ? context.activeConsentRevision === context.uploadConsentRevision &&
                context.consentWithdrawnAt === null
            : action.withdrawalReceipt?.withdrawnAt === context.draftUpdatedAt &&
                action.withdrawalReceipt.withdrawalCycleHash ===
                    context.withdrawalCycleHash &&
                action.withdrawalReceipt.resultStateVersion ===
                    context.stateVersion);
}

function originalUploadFormatMatches(context) {
    if (context.originalDetectedType === 'png') {
        return context.uploadFileExtension === 'png' &&
            context.declaredContentType === 'image/png';
    }
    return ['jpg', 'jpeg'].includes(context.uploadFileExtension) &&
        context.declaredContentType === 'image/jpeg';
}

async function readOperation(database, draftId, action) {
    return queryFirst(database, `
        SELECT
            operation_id AS operationId,
            operation_id_hash AS operationIdHash,
            draft_id AS draftId,
            draft_id_hash AS draftIdHash,
            action,
            expected_state_version AS expectedStateVersion,
            withdrawal_kind AS withdrawalKind,
            withdrawal_cycle_hash AS withdrawalCycleHash,
            public_host_verification_id_hash AS publicHostVerificationIdHash,
            public_host_final_receipt_hash AS publicHostFinalReceiptHash,
            withdrawal_receipt_hash AS withdrawalReceiptHash,
            idempotency_key_hash AS idempotencyKeyHash,
            payload_fingerprint AS payloadFingerprint,
            service_actor_identity_hash AS serviceActorIdentityHash,
            status,
            reserved_at AS reservedAt,
            completed_at AS completedAt,
            withdrawn_at AS withdrawnAt,
            retention_eligible_at AS retentionEligibleAt
        FROM draft_withdrawal_finalization_operations
        WHERE draft_id = ?1 AND action = ?2
    `, draftId, action);
}

function operationMatches(operation, context, action, request) {
    return operation.draftId === context.draftId &&
        operation.draftIdHash === request.draftIdHash &&
        operation.action === action.name &&
        operation.expectedStateVersion === action.expectedStateVersion &&
        operation.withdrawalKind === context.withdrawalKind &&
        operation.withdrawalCycleHash === context.withdrawalCycleHash &&
        operation.withdrawalReceiptHash === (
            action.name === 'purge'
                ? action.withdrawalReceipt.withdrawalReceiptHash
                : null
        ) &&
        operation.idempotencyKeyHash === request.idempotencyKeyHash &&
        operation.payloadFingerprint === request.payloadFingerprint &&
        ['reserved', 'completed'].includes(operation.status);
}

async function refreshHostReceiptIfNeeded(database, operation, context) {
    if (
        operation.publicHostVerificationIdHash ===
            context.publicHostVerificationIdHash &&
        operation.publicHostFinalReceiptHash === context.publicHostFinalReceiptHash
    ) return operation;
    if (operation.status === 'completed') throw new FinalizationConflict();
    await runBatch(database, [database.prepare(`
        UPDATE draft_withdrawal_finalization_operations
        SET public_host_verification_id_hash = ?2,
            public_host_final_receipt_hash = ?3
        WHERE operation_id = ?1
          AND status = 'reserved'
    `).bind(
        operation.operationId,
        context.publicHostVerificationIdHash,
        context.publicHostFinalReceiptHash
    )]);
    const refreshed = await readOperation(database, operation.draftId, operation.action);
    if (
        !refreshed ||
        refreshed.publicHostVerificationIdHash !==
            context.publicHostVerificationIdHash ||
        refreshed.publicHostFinalReceiptHash !== context.publicHostFinalReceiptHash
    ) throw new FinalizationConflict();
    return refreshed;
}

async function reserveOperation(
    database,
    identity,
    context,
    action,
    request
) {
    const actorHash = await hashIdentity(identity);
    const operationSeed = await hashText(canonicalJson({
        operation: 'gallery-withdrawal-finalization-operation',
        action: action.name,
        draftIdHash: request.draftIdHash,
        idempotencyKeyHash: request.idempotencyKeyHash,
        actorHash
    }));
    const operationId = `finalize_${operationSeed.slice(0, 32)}`;
    const operationIdHash = await hashText(
        `withdrawal-finalization-operation-id:${operationId}`
    );
    try {
        await runBatch(database, [database.prepare(`
            INSERT INTO draft_withdrawal_finalization_operations (
                operation_id, operation_id_hash, draft_id, draft_id_hash,
                action, expected_state_version, withdrawal_kind,
                withdrawal_cycle_hash, public_host_verification_id_hash,
                public_host_final_receipt_hash, withdrawal_receipt_hash,
                idempotency_key_hash, payload_fingerprint,
                service_actor_identity_hash, withdrawn_at,
                retention_eligible_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                ?13, ?14, ?15, ?16
            )
        `).bind(
            operationId,
            operationIdHash,
            context.draftId,
            request.draftIdHash,
            action.name,
            action.expectedStateVersion,
            context.withdrawalKind,
            context.withdrawalCycleHash,
            context.publicHostVerificationIdHash,
            context.publicHostFinalReceiptHash,
            action.withdrawalReceipt?.withdrawalReceiptHash ?? null,
            request.idempotencyKeyHash,
            request.payloadFingerprint,
            actorHash,
            action.name === 'purge' ? action.withdrawalReceipt.withdrawnAt : null,
            action.name === 'purge'
                ? action.withdrawalReceipt.retentionEligibleAt
                : null
        )]);
    } catch {
        const raced = await readOperation(database, context.draftId, action.name);
        if (!raced || !operationMatches(raced, context, action, request)) {
            throw new FinalizationConflict();
        }
        return raced;
    }
    return readOperation(database, context.draftId, action.name);
}

async function completeRetainedWithdrawal(
    database,
    context,
    operation
) {
    const existing = await readWithdrawalReceipt(database, operation.draftIdHash);
    if (existing) {
        return existing.operationIdHash === operation.operationIdHash
            ? success(200, 'withdrawn', { replayed: true })
            : failure(409, 'conflict');
    }
    if (operation.status !== 'reserved') throw new FinalizationConflict();

    const evidence = await buildWithdrawalReceipt(context, operation, null);
    const auditHash = await hashText(canonicalJson({
        operation: 'gallery-withdrawal-completed',
        withdrawalReceiptHash: evidence.withdrawalReceiptHash
    }));
    await runBatch(database, [
        withdrawalReceiptStatement(database, evidence),
        auditStatement(database, {
            auditId: `audit_${auditHash}`,
            subjectHash: await hashText(`draft:${context.draftId}`),
            eventType: 'gallery-withdrawal-completed',
            stateVersion: operation.expectedStateVersion + 1,
            actorHash: operation.serviceActorIdentityHash,
            payloadHash: auditHash
        })
    ]);
    const completed = await readWithdrawalReceipt(database, operation.draftIdHash);
    const live = await readLiveState(database, context.draftId);
    if (
        !completed ||
        completed.withdrawalReceiptHash !== evidence.withdrawalReceiptHash ||
        !retentionPeriodMatches(completed) ||
        live?.state !== 'withdrawn' ||
        live.stateVersion !== operation.expectedStateVersion + 1
    ) {
        throw new FinalizationConflict();
    }
    return success(201, 'withdrawn', { replayed: false });
}

async function completeConsentWithdrawal(
    env,
    context,
    operation
) {
    const existing = await readWithdrawalReceipt(env.DB, operation.draftIdHash);
    if (existing) {
        return existing.operationIdHash === operation.operationIdHash
            ? success(200, 'withdrawn', { replayed: true })
            : failure(409, 'conflict');
    }
    if (operation.status !== 'reserved') throw new FinalizationConflict();

    const deletion = await deletePrivateOriginal(
        env,
        context,
        operation
    );
    const evidence = await buildWithdrawalReceipt(
        context,
        operation,
        deletion.deletionReceiptHash
    );
    const auditHash = await hashText(canonicalJson({
        operation: 'gallery-consent-withdrawal-completed',
        withdrawalReceiptHash: evidence.withdrawalReceiptHash,
        deletionReceiptHash: deletion.deletionReceiptHash
    }));

    await runBatch(env.DB, [
        markDeletionAbsentStatement(env.DB, deletion),
        deletionTombstoneStatement(env.DB, deletion),
        markUploadDeletedStatement(env.DB, deletion),
        markPrivateDeletionStatement(env.DB, context.draftId, deletion),
        withdrawConsentStatement(env.DB, context, deletion),
        withdrawalReceiptStatement(env.DB, evidence),
        auditStatement(env.DB, {
            auditId: `audit_${auditHash}`,
            subjectHash: await hashText(`draft:${context.draftId}`),
            eventType: 'gallery-consent-withdrawal-completed',
            stateVersion: operation.expectedStateVersion + 1,
            actorHash: operation.serviceActorIdentityHash,
            payloadHash: auditHash
        })
    ]);
    const completed = await readWithdrawalReceipt(env.DB, operation.draftIdHash);
    const live = await readLiveState(env.DB, context.draftId);
    if (
        !completed ||
        completed.withdrawalReceiptHash !== evidence.withdrawalReceiptHash ||
        !retentionPeriodMatches(completed) ||
        live?.state !== 'withdrawn' ||
        live.stateVersion !== operation.expectedStateVersion + 1
    ) {
        throw new FinalizationConflict();
    }
    return success(201, 'withdrawn', { replayed: false });
}

async function completePurge(env, context, operation) {
    const withdrawal = await readWithdrawalReceipt(env.DB, operation.draftIdHash);
    if (
        !withdrawal ||
        withdrawal.withdrawalKind !== context.withdrawalKind ||
        withdrawal.resultStateVersion !== operation.expectedStateVersion ||
        withdrawal.withdrawalReceiptHash !== operation.withdrawalReceiptHash
    ) throw new FinalizationConflict();

    if (!await retentionIsEligible(env.DB, withdrawal)) {
        return success(202, 'retention-pending', {
            eligibleAt: withdrawal.retentionEligibleAt,
            replayed: false
        });
    }

    let deletion;
    if (context.withdrawalKind === 'consent-withdrawal') {
        deletion = await readDeletionTombstone(
            env.DB,
            withdrawal.privateDeletionReceiptHash
        );
        if (!deletion || !await deletionTombstoneMatches(
            deletion,
            context,
            operation,
            withdrawal
        )) throw new FinalizationConflict();
    } else {
        deletion = await deletePrivateOriginal(
            env,
            context,
            operation
        );
    }

    const retention = await buildRetentionEvidence(
        context,
        operation,
        withdrawal,
        deletion
    );
    const purge = await buildPurgeReceipt(
        context,
        operation,
        withdrawal,
        deletion,
        retention
    );
    const statements = [];
    if (context.withdrawalKind !== 'consent-withdrawal') {
        statements.push(
            markDeletionAbsentStatement(env.DB, deletion),
            deletionTombstoneStatement(env.DB, deletion),
            markUploadDeletedStatement(env.DB, deletion),
            markPrivateDeletionStatement(env.DB, context.draftId, deletion)
        );
    }
    statements.push(
        env.DB.prepare(`
            INSERT INTO gallery_retention_tombstones (
                draft_id, purge_kind, eligible_at, approved_at,
                approved_by_identity_hash, evidence_hash
            ) VALUES (
                ?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                ?4, ?5
            )
        `).bind(
            context.draftId,
            context.withdrawalKind === 'consent-withdrawal'
                ? 'consent-withdrawal'
                : 'retention-expiry',
            withdrawal.retentionEligibleAt,
            operation.serviceActorIdentityHash,
            retention.evidenceHash
        ),
        purgeReceiptStatement(env.DB, purge),
        auditStatement(env.DB, {
            auditId: `audit_${purge.purgeReceiptHash}`,
            subjectHash: operation.draftIdHash,
            eventType: 'gallery-draft-purged',
            stateVersion: operation.expectedStateVersion,
            actorHash: operation.serviceActorIdentityHash,
            payloadHash: purge.purgeReceiptHash
        })
    );
    await runBatch(env.DB, statements);
    const replay = await queryFirst(env.DB, `
        SELECT draft_id_hash AS draftIdHash,
            idempotency_key_hash AS idempotencyKeyHash,
            payload_fingerprint AS payloadFingerprint
        FROM gallery_draft_purge_receipts
        WHERE purge_receipt_hash = ?1
    `, purge.purgeReceiptHash);
    if (!replayMatches(replay, {
        draftIdHash: operation.draftIdHash,
        idempotencyKeyHash: operation.idempotencyKeyHash,
        payloadFingerprint: operation.payloadFingerprint
    }) || await readLiveState(env.DB, context.draftId)) {
        throw new FinalizationConflict();
    }
    return success(201, 'purged', { replayed: false });
}

async function deletePrivateOriginal(
    env,
    context,
    operation
) {
    let deletion = await readDeletionOperation(env.DB, context.draftId);
    if (deletion) {
        if (!await deletionMatches(deletion, context, operation)) {
            throw new FinalizationConflict();
        }
    } else {
        const head = await safeHead(env.PRIVATE_ORIGINALS, context.originalObjectKey);
        if (!head || !headMatches(head, context)) throw new FinalizationConflict();
        const prefixes = context.privatePrefixes;
        await assertPrefixInventory(
            env.PRIVATE_ORIGINALS,
            prefixes,
            context.originalObjectKey
        );
        const headEvidenceHash = await providerHeadEvidence(head);
        const seed = await hashText(canonicalJson({
            operationIdHash: operation.operationIdHash,
            privateObjectKeyHash: await hashProviderFact(
                'private-object-key',
                context.originalObjectKey
            )
        }));
        const deletionId = `originaldelete_${seed.slice(0, 32)}`;
        const record = {
            deletionId,
            deletionIdHash: await hashText(`private-original-deletion-id:${deletionId}`),
            operationId: operation.operationId,
            operationIdHash: operation.operationIdHash,
            draftId: context.draftId,
            draftIdHash: operation.draftIdHash,
            uploadSessionId: context.uploadSessionId,
            uploadSessionIdHash: await hashProviderFact(
                'upload-session-id', context.uploadSessionId
            ),
            privateObjectKey: context.originalObjectKey,
            privateObjectKeyHash: await hashProviderFact(
                'private-object-key', context.originalObjectKey
            ),
            providerObjectVersion: context.providerObjectVersion,
            providerObjectVersionHash: await hashProviderFact(
                'object-version', context.providerObjectVersion
            ),
            providerEtag: context.providerEtag,
            providerEtagHash: await hashProviderFact('etag', context.providerEtag),
            expectedByteCount: context.originalByteCount,
            expectedSha256: context.originalSha256,
            reservationHeadEvidenceHash: headEvidenceHash,
            status: 'reserved',
            terminalKind: null,
            completedAt: null,
            finalHeadAbsenceEvidenceHash: null,
            prefixAbsenceEvidenceHash: null
        };
        await runBatch(env.DB, [reserveDeletionStatement(env.DB, record)]);
        deletion = await readDeletionOperation(env.DB, context.draftId);
        if (!deletion || !await deletionMatches(deletion, context, operation)) {
            throw new FinalizationConflict();
        }
    }

    if (deletion.status === 'absent') {
        const tombstone = await readDeletionTombstoneForOperation(
            env.DB,
            deletion
        );
        if (!tombstone || !await deletionTombstoneMatchesLive(
            tombstone,
            deletion,
            operation
        )) {
            throw new FinalizationConflict();
        }
        return { ...deletion, ...tombstone };
    }

    let head = await safeHead(env.PRIVATE_ORIGINALS, deletion.privateObjectKey);
    let terminalKind;
    if (head === null) {
        terminalKind = 'not-found';
    } else {
        if (!headMatchesDeletion(head, deletion)) throw new FinalizationConflict();
        await assertPrefixInventory(
            env.PRIVATE_ORIGINALS,
            context.privatePrefixes,
            deletion.privateObjectKey
        );
        const stored = await env.PRIVATE_ORIGINALS.get(deletion.privateObjectKey, {
            onlyIf: { etagMatches: head.etag }
        });
        if (!headMatchesDeletion(stored, deletion) || !stored?.body) {
            throw new FinalizationConflict();
        }
        const bytes = await readBoundedBytes(stored.body, deletion.expectedByteCount);
        if (
            bytes.byteLength !== deletion.expectedByteCount ||
            await sha256Hex(bytes) !== deletion.expectedSha256
        ) throw new FinalizationConflict();
        const finalHead = await safeHead(
            env.PRIVATE_ORIGINALS,
            deletion.privateObjectKey
        );
        if (!sameProviderObject(head, finalHead)) throw new FinalizationConflict();
        await env.PRIVATE_ORIGINALS.delete(deletion.privateObjectKey);
        terminalKind = 'deleted';
    }

    head = await safeHead(env.PRIVATE_ORIGINALS, deletion.privateObjectKey);
    if (head !== null) throw new FinalizationConflict();
    await assertPrefixInventory(env.PRIVATE_ORIGINALS, context.privatePrefixes, null);
    const finalHeadAbsenceEvidenceHash = await hashText(canonicalJson({
        operation: 'private-original-final-head-absence',
        deletionIdHash: deletion.deletionIdHash,
        observed: 'absent'
    }));
    const prefixAbsenceEvidenceHash = await hashText(canonicalJson({
        operation: 'private-original-prefix-absence',
        deletionIdHash: deletion.deletionIdHash,
        prefixSetHash: await hashText(context.privatePrefixes.join('\n')),
        observedObjectCount: 0
    }));
    const completed = {
        ...deletion,
        terminalKind,
        finalHeadAbsenceEvidenceHash,
        prefixAbsenceEvidenceHash,
        serviceActorIdentityHash: operation.serviceActorIdentityHash
    };
    const tombstone = await buildDeletionTombstone(completed);
    return { ...completed, ...tombstone };
}

function headMatches(head, context) {
    return Boolean(head) &&
        head.size === context.originalByteCount &&
        head.version === context.providerObjectVersion &&
        head.etag === context.providerEtag;
}

function headMatchesDeletion(head, deletion) {
    return Boolean(head) &&
        head.size === deletion.expectedByteCount &&
        head.version === deletion.providerObjectVersion &&
        head.etag === deletion.providerEtag;
}

function sameProviderObject(left, right) {
    return Boolean(left) && Boolean(right) &&
        left.size === right.size &&
        left.version === right.version &&
        left.etag === right.etag;
}

async function safeHead(bucket, key) {
    const result = await bucket.head(key);
    return result === null ? null : result;
}

async function assertPrefixInventory(bucket, prefixes, expectedKey) {
    const seen = new Set();
    for (const prefix of prefixes) {
        let cursor;
        const cursors = new Set();
        for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
            const result = await bucket.list({
                prefix,
                limit: 1000,
                ...(cursor ? { cursor } : {})
            });
            if (
                !result ||
                !Array.isArray(result.objects) ||
                !Array.isArray(result.delimitedPrefixes) ||
                result.delimitedPrefixes.length !== 0 ||
                typeof result.truncated !== 'boolean'
            ) throw new Error('Private object inventory is unavailable.');
            for (const object of result.objects) {
                if (typeof object?.key !== 'string' || seen.has(object.key)) {
                    throw new FinalizationConflict();
                }
                seen.add(object.key);
            }
            if (result.truncated !== true) break;
            if (
                typeof result.cursor !== 'string' ||
                result.cursor.length < 1 ||
                cursors.has(result.cursor)
            ) throw new Error('Private object inventory pagination is invalid.');
            cursors.add(result.cursor);
            cursor = result.cursor;
            if (page === MAX_LIST_PAGES - 1) {
                throw new Error('Private object inventory is too large.');
            }
        }
    }
    const expected = expectedKey === null ? [] : [expectedKey];
    if (
        seen.size !== expected.length ||
        expected.some(key => !seen.has(key))
    ) throw new FinalizationConflict();
}

function derivePrivatePrefixes(rows, draftId) {
    if (!Array.isArray(rows) || rows.length < 1) return null;
    const prefixes = new Set();
    for (const row of rows) {
        const parsed = parsePrivateOriginalKey(row?.objectKey);
        if (!parsed || parsed.draftId !== draftId) return null;
        const marker = `/${draftId}/`;
        const index = row.objectKey.indexOf(marker);
        if (index < 1) return null;
        prefixes.add(row.objectKey.slice(0, index + marker.length));
    }
    return [...prefixes].sort();
}

async function providerHeadEvidence(head) {
    return hashText(canonicalJson({
        operation: 'private-original-reservation-head',
        size: head.size,
        versionHash: await hashProviderFact('object-version', head.version),
        etagHash: await hashProviderFact('etag', head.etag)
    }));
}

async function buildRequestEvidence(draftId, idempotencyKey) {
    const withdrawalKeyDigest = await hashText(`gallery-withdrawal:${draftId}`);
    const purgeKeyDigest = await hashText(`gallery-purge:${draftId}`);
    const expectedWithdrawalKey =
        `gallery-withdrawal-${withdrawalKeyDigest.slice(0, 32)}`;
    const expectedPurgeKey = `gallery-purge-${purgeKeyDigest.slice(0, 32)}`;
    const requestedAction = idempotencyKey === expectedWithdrawalKey
        ? 'withdrawal'
        : idempotencyKey === expectedPurgeKey
            ? 'purge'
            : null;
    if (!requestedAction) return null;
    const draftIdHash = await hashText(`draft-id:${draftId}`);
    const idempotencyKeyHash = await hashText(
        `withdrawal-finalization-idempotency-key:${idempotencyKey}`
    );
    return {
        requestedAction,
        draftIdHash,
        idempotencyKeyHash,
        payloadFingerprint: await hashText(canonicalJson({
            operation: 'gallery-withdrawal-finalization',
            requestedAction,
            draftIdHash,
            idempotencyKeyHash
        }))
    };
}

async function buildWithdrawalReceipt(
    context,
    operation,
    privateDeletionReceiptHash
) {
    const fields = {
        operationIdHash: operation.operationIdHash,
        draftIdHash: operation.draftIdHash,
        expectedStateVersion: operation.expectedStateVersion,
        resultStateVersion: operation.expectedStateVersion + 1,
        withdrawalKind: operation.withdrawalKind,
        withdrawalCycleHash: operation.withdrawalCycleHash,
        publicHostVerificationIdHash: operation.publicHostVerificationIdHash,
        publicHostFinalReceiptHash: operation.publicHostFinalReceiptHash,
        promotionSetHash: context.promotionSetHash,
        cleanupEvidenceSetHash: context.cleanupEvidenceSetHash,
        targetSetHash: context.targetSetHash,
        approvedOriginHash: context.approvedOriginHash,
        mediaDeliveryEpochIdHash: context.mediaDeliveryEpochIdHash,
        deliveryContractHash: context.deliveryContractHash,
        deliveryVersionHash: context.deliveryVersionHash,
        generationCount: context.generationCount,
        targetCount: context.targetCount,
        privateDeletionReceiptHash,
        idempotencyKeyHash: operation.idempotencyKeyHash,
        payloadFingerprint: operation.payloadFingerprint,
        serviceActorIdentityHash: operation.serviceActorIdentityHash
    };
    return {
        ...fields,
        withdrawalReceiptHash: await hashText(canonicalJson({
            operation: 'gallery-withdrawal-completion-receipt',
            ...fields
        }))
    };
}

async function buildDeletionTombstone(deletion) {
    const fields = {
        deletionIdHash: deletion.deletionIdHash,
        operationIdHash: deletion.operationIdHash,
        draftIdHash: deletion.draftIdHash,
        uploadSessionIdHash: deletion.uploadSessionIdHash,
        privateObjectKeyHash: deletion.privateObjectKeyHash,
        providerObjectVersionHash: deletion.providerObjectVersionHash,
        providerEtagHash: deletion.providerEtagHash,
        expectedByteCount: deletion.expectedByteCount,
        expectedSha256: deletion.expectedSha256,
        terminalKind: deletion.terminalKind,
        reservationHeadEvidenceHash: deletion.reservationHeadEvidenceHash,
        finalHeadAbsenceEvidenceHash: deletion.finalHeadAbsenceEvidenceHash,
        prefixAbsenceEvidenceHash: deletion.prefixAbsenceEvidenceHash,
        serviceActorIdentityHash: deletion.serviceActorIdentityHash
    };
    return {
        ...fields,
        deletionReceiptHash: await hashText(canonicalJson({
            operation: 'gallery-private-original-deletion-receipt',
            ...fields
        }))
    };
}

async function buildRetentionEvidence(
    context,
    operation,
    withdrawal,
    deletion
) {
    return {
        evidenceHash: await hashText(canonicalJson({
            operation: 'gallery-retention-approval',
            draftIdHash: operation.draftIdHash,
            withdrawalReceiptHash: withdrawal.withdrawalReceiptHash,
            deletionReceiptHash: deletion.deletionReceiptHash,
            withdrawalKind: context.withdrawalKind,
            eligibleAt: withdrawal.retentionEligibleAt,
            actorHash: operation.serviceActorIdentityHash
        }))
    };
}

async function buildPurgeReceipt(
    context,
    operation,
    withdrawal,
    deletion,
    retention
) {
    const fields = {
        operationIdHash: operation.operationIdHash,
        withdrawalOperationIdHash: withdrawal.operationIdHash,
        draftIdHash: operation.draftIdHash,
        expectedStateVersion: operation.expectedStateVersion,
        withdrawalReceiptHash: withdrawal.withdrawalReceiptHash,
        withdrawalKind: context.withdrawalKind,
        withdrawalCycleHash: context.withdrawalCycleHash,
        publicHostVerificationIdHash: context.publicHostVerificationIdHash,
        publicHostFinalReceiptHash: context.publicHostFinalReceiptHash,
        privateDeletionReceiptHash: deletion.deletionReceiptHash,
        retentionEvidenceHash: retention.evidenceHash,
        idempotencyKeyHash: operation.idempotencyKeyHash,
        payloadFingerprint: operation.payloadFingerprint,
        serviceActorIdentityHash: operation.serviceActorIdentityHash,
        withdrawnAt: withdrawal.withdrawnAt,
        retentionEligibleAt: withdrawal.retentionEligibleAt
    };
    return {
        ...fields,
        purgeReceiptHash: await hashText(canonicalJson({
            operation: 'gallery-draft-purge-receipt',
            ...fields
        }))
    };
}

async function readWithdrawalReceipt(database, draftIdHash) {
    return queryFirst(database, `
        SELECT
            withdrawal_receipt_hash AS withdrawalReceiptHash,
            operation_id_hash AS operationIdHash,
            draft_id_hash AS draftIdHash,
            expected_state_version AS expectedStateVersion,
            result_state_version AS resultStateVersion,
            withdrawal_kind AS withdrawalKind,
            withdrawal_cycle_hash AS withdrawalCycleHash,
            public_host_verification_id_hash AS publicHostVerificationIdHash,
            public_host_final_receipt_hash AS publicHostFinalReceiptHash,
            private_deletion_receipt_hash AS privateDeletionReceiptHash,
            idempotency_key_hash AS idempotencyKeyHash,
            payload_fingerprint AS payloadFingerprint,
            service_actor_identity_hash AS serviceActorIdentityHash,
            withdrawn_at AS withdrawnAt,
            retention_eligible_at AS retentionEligibleAt
        FROM gallery_withdrawal_completion_receipts
        WHERE draft_id_hash = ?1
    `, draftIdHash);
}

async function readDeletionOperation(database, draftId) {
    return queryFirst(database, `
        SELECT
            deletion_id AS deletionId,
            deletion_id_hash AS deletionIdHash,
            operation_id AS operationId,
            operation_id_hash AS operationIdHash,
            draft_id AS draftId,
            draft_id_hash AS draftIdHash,
            upload_session_id AS uploadSessionId,
            upload_session_id_hash AS uploadSessionIdHash,
            private_object_key AS privateObjectKey,
            private_object_key_hash AS privateObjectKeyHash,
            provider_object_version AS providerObjectVersion,
            provider_object_version_hash AS providerObjectVersionHash,
            provider_etag AS providerEtag,
            provider_etag_hash AS providerEtagHash,
            expected_byte_count AS expectedByteCount,
            expected_sha256 AS expectedSha256,
            reservation_head_evidence_hash AS reservationHeadEvidenceHash,
            status,
            terminal_kind AS terminalKind,
            reserved_at AS reservedAt,
            completed_at AS completedAt,
            final_head_absence_evidence_hash AS finalHeadAbsenceEvidenceHash,
            prefix_absence_evidence_hash AS prefixAbsenceEvidenceHash
        FROM draft_private_original_deletions
        WHERE draft_id = ?1
    `, draftId);
}

async function readDeletionTombstone(database, deletionReceiptHash) {
    if (!SHA256_PATTERN.test(deletionReceiptHash || '')) return null;
    return queryFirst(database, `
        SELECT
            deletion_receipt_hash AS deletionReceiptHash,
            deletion_id_hash AS deletionIdHash,
            operation_id_hash AS operationIdHash,
            draft_id_hash AS draftIdHash,
            upload_session_id_hash AS uploadSessionIdHash,
            private_object_key_hash AS privateObjectKeyHash,
            provider_object_version_hash AS providerObjectVersionHash,
            provider_etag_hash AS providerEtagHash,
            expected_byte_count AS expectedByteCount,
            expected_sha256 AS expectedSha256,
            terminal_kind AS terminalKind,
            reservation_head_evidence_hash AS reservationHeadEvidenceHash,
            final_head_absence_evidence_hash AS finalHeadAbsenceEvidenceHash,
            prefix_absence_evidence_hash AS prefixAbsenceEvidenceHash,
            service_actor_identity_hash AS serviceActorIdentityHash,
            deleted_at AS deletedAt
        FROM gallery_private_original_deletion_tombstones
        WHERE deletion_receipt_hash = ?1
    `, deletionReceiptHash);
}

async function readDeletionTombstoneForOperation(database, deletion) {
    return queryFirst(database, `
        SELECT
            deletion_receipt_hash AS deletionReceiptHash,
            deletion_id_hash AS deletionIdHash,
            operation_id_hash AS operationIdHash,
            draft_id_hash AS draftIdHash,
            upload_session_id_hash AS uploadSessionIdHash,
            private_object_key_hash AS privateObjectKeyHash,
            provider_object_version_hash AS providerObjectVersionHash,
            provider_etag_hash AS providerEtagHash,
            expected_byte_count AS expectedByteCount,
            expected_sha256 AS expectedSha256,
            terminal_kind AS terminalKind,
            reservation_head_evidence_hash AS reservationHeadEvidenceHash,
            final_head_absence_evidence_hash AS finalHeadAbsenceEvidenceHash,
            prefix_absence_evidence_hash AS prefixAbsenceEvidenceHash,
            service_actor_identity_hash AS serviceActorIdentityHash,
            deleted_at AS deletedAt
        FROM gallery_private_original_deletion_tombstones
        WHERE deletion_id_hash = ?1 AND operation_id_hash = ?2
    `, deletion.deletionIdHash, deletion.operationIdHash);
}

async function deletionMatches(deletion, context, operation) {
    const expectedDeletionIdHash = await hashText(
        `private-original-deletion-id:${deletion.deletionId}`
    );
    const expectedUploadHash = await hashProviderFact(
        'upload-session-id', context.uploadSessionId
    );
    const expectedKeyHash = await hashProviderFact(
        'private-object-key', context.originalObjectKey
    );
    const expectedVersionHash = await hashProviderFact(
        'object-version', context.providerObjectVersion
    );
    const expectedEtagHash = await hashProviderFact('etag', context.providerEtag);
    const expectedHeadHash = await providerHeadEvidence({
        size: context.originalByteCount,
        version: context.providerObjectVersion,
        etag: context.providerEtag
    });
    return deletion.operationId === operation.operationId &&
        deletion.operationIdHash === operation.operationIdHash &&
        deletion.deletionIdHash === expectedDeletionIdHash &&
        deletion.draftId === context.draftId &&
        deletion.draftIdHash === operation.draftIdHash &&
        deletion.uploadSessionId === context.uploadSessionId &&
        deletion.uploadSessionIdHash === expectedUploadHash &&
        deletion.privateObjectKey === context.originalObjectKey &&
        deletion.privateObjectKeyHash === expectedKeyHash &&
        deletion.providerObjectVersion === context.providerObjectVersion &&
        deletion.providerObjectVersionHash === expectedVersionHash &&
        deletion.providerEtag === context.providerEtag &&
        deletion.providerEtagHash === expectedEtagHash &&
        deletion.expectedByteCount === context.originalByteCount &&
        deletion.expectedSha256 === context.originalSha256 &&
        deletion.reservationHeadEvidenceHash === expectedHeadHash &&
        (
            (deletion.status === 'reserved' &&
                deletion.terminalKind === null &&
                deletion.completedAt === null &&
                deletion.finalHeadAbsenceEvidenceHash === null &&
                deletion.prefixAbsenceEvidenceHash === null) ||
            (deletion.status === 'absent' &&
                ['deleted', 'not-found'].includes(deletion.terminalKind) &&
                validIsoTime(deletion.completedAt) &&
                SHA256_PATTERN.test(deletion.finalHeadAbsenceEvidenceHash || '') &&
                SHA256_PATTERN.test(deletion.prefixAbsenceEvidenceHash || ''))
        );
}

async function deletionTombstoneMatchesLive(tombstone, deletion, operation) {
    const rebuilt = await buildDeletionTombstone(tombstone);
    return rebuilt.deletionReceiptHash === tombstone.deletionReceiptHash &&
        tombstone.deletionIdHash === deletion.deletionIdHash &&
        tombstone.operationIdHash === deletion.operationIdHash &&
        tombstone.draftIdHash === deletion.draftIdHash &&
        tombstone.uploadSessionIdHash === deletion.uploadSessionIdHash &&
        tombstone.privateObjectKeyHash === deletion.privateObjectKeyHash &&
        tombstone.providerObjectVersionHash === deletion.providerObjectVersionHash &&
        tombstone.providerEtagHash === deletion.providerEtagHash &&
        tombstone.expectedByteCount === deletion.expectedByteCount &&
        tombstone.expectedSha256 === deletion.expectedSha256 &&
        tombstone.terminalKind === deletion.terminalKind &&
        tombstone.reservationHeadEvidenceHash === deletion.reservationHeadEvidenceHash &&
        tombstone.finalHeadAbsenceEvidenceHash === deletion.finalHeadAbsenceEvidenceHash &&
        tombstone.prefixAbsenceEvidenceHash === deletion.prefixAbsenceEvidenceHash &&
        tombstone.serviceActorIdentityHash === operation.serviceActorIdentityHash &&
        tombstone.deletedAt === deletion.completedAt &&
        validIsoTime(tombstone.deletedAt);
}

async function deletionTombstoneMatches(
    tombstone,
    context,
    operation,
    withdrawal
) {
    const rebuilt = await buildDeletionTombstone(tombstone);
    return rebuilt.deletionReceiptHash === tombstone.deletionReceiptHash &&
        tombstone.deletionReceiptHash === withdrawal.privateDeletionReceiptHash &&
        tombstone.operationIdHash === withdrawal.operationIdHash &&
        tombstone.draftIdHash === operation.draftIdHash &&
        tombstone.uploadSessionIdHash === await hashProviderFact(
            'upload-session-id', context.uploadSessionId
        ) &&
        tombstone.privateObjectKeyHash === await hashProviderFact(
            'private-object-key', context.originalObjectKey
        ) &&
        tombstone.providerObjectVersionHash === await hashProviderFact(
            'object-version', context.providerObjectVersion
        ) &&
        tombstone.providerEtagHash === await hashProviderFact(
            'etag', context.providerEtag
        ) &&
        tombstone.expectedByteCount === context.originalByteCount &&
        tombstone.expectedSha256 === context.originalSha256 &&
        ['deleted', 'not-found'].includes(tombstone.terminalKind) &&
        tombstone.serviceActorIdentityHash === withdrawal.serviceActorIdentityHash &&
        validIsoTime(tombstone.deletedAt);
}

function reserveDeletionStatement(database, deletion) {
    return database.prepare(`
        INSERT INTO draft_private_original_deletions (
            deletion_id, deletion_id_hash, operation_id, operation_id_hash,
            draft_id, draft_id_hash, upload_session_id, upload_session_id_hash,
            private_object_key, private_object_key_hash,
            provider_object_version, provider_object_version_hash,
            provider_etag, provider_etag_hash, expected_byte_count,
            expected_sha256, reservation_head_evidence_hash
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
            ?14, ?15, ?16, ?17
        )
    `).bind(
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

function markDeletionAbsentStatement(database, deletion) {
    return database.prepare(`
        UPDATE draft_private_original_deletions
        SET status = 'absent', terminal_kind = ?2,
            final_head_absence_evidence_hash = ?3,
            prefix_absence_evidence_hash = ?4
        WHERE deletion_id = ?1 AND status = 'reserved'
    `).bind(
        deletion.deletionId,
        deletion.terminalKind,
        deletion.finalHeadAbsenceEvidenceHash,
        deletion.prefixAbsenceEvidenceHash
    );
}

function deletionTombstoneStatement(database, deletion) {
    return database.prepare(`
        INSERT INTO gallery_private_original_deletion_tombstones (
            deletion_receipt_hash, deletion_id_hash, operation_id_hash,
            draft_id_hash, upload_session_id_hash, private_object_key_hash,
            provider_object_version_hash, provider_etag_hash,
            expected_byte_count, expected_sha256, terminal_kind,
            reservation_head_evidence_hash, final_head_absence_evidence_hash,
            prefix_absence_evidence_hash, service_actor_identity_hash
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
            ?14, ?15
        )
    `).bind(
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
        deletion.terminalKind,
        deletion.reservationHeadEvidenceHash,
        deletion.finalHeadAbsenceEvidenceHash,
        deletion.prefixAbsenceEvidenceHash,
        deletion.serviceActorIdentityHash
    );
}

function markUploadDeletedStatement(database, deletion) {
    return database.prepare(`
        UPDATE draft_upload_sessions
        SET status = 'deleted',
            object_deleted_at = (
                SELECT deleted_at
                FROM gallery_private_original_deletion_tombstones
                WHERE deletion_receipt_hash = ?3
            ),
            updated_at = (
                SELECT deleted_at
                FROM gallery_private_original_deletion_tombstones
                WHERE deletion_receipt_hash = ?3
            )
        WHERE upload_session_id = ?1 AND status = 'complete'
          AND object_key = ?2
    `).bind(
        deletion.uploadSessionId,
        deletion.privateObjectKey,
        deletion.deletionReceiptHash
    );
}

function markPrivateDeletionStatement(database, draftId, deletion) {
    return database.prepare(`
        UPDATE draft_publication_references
        SET private_original_deletion_confirmed = 1,
            updated_at = (
                SELECT deleted_at
                FROM gallery_private_original_deletion_tombstones
                WHERE deletion_receipt_hash = ?2
            )
        WHERE draft_id = ?1 AND private_original_deletion_confirmed = 0
    `).bind(draftId, deletion.deletionReceiptHash);
}

function withdrawConsentStatement(database, context, deletion) {
    return database.prepare(`
        UPDATE draft_consent_attestations
        SET withdrawn_at = (
            SELECT deleted_at
            FROM gallery_private_original_deletion_tombstones
            WHERE deletion_receipt_hash = ?3
        )
        WHERE draft_id = ?1 AND consent_revision = ?2
          AND withdrawn_at IS NULL
    `).bind(
        context.draftId,
        context.uploadConsentRevision,
        deletion.deletionReceiptHash
    );
}

function withdrawalReceiptStatement(database, receipt) {
    return database.prepare(`
        INSERT INTO gallery_withdrawal_completion_receipts (
            withdrawal_receipt_hash, operation_id_hash, draft_id_hash,
            expected_state_version, result_state_version, withdrawal_kind,
            withdrawal_cycle_hash, public_host_verification_id_hash,
            public_host_final_receipt_hash,
            promotion_set_hash, cleanup_evidence_set_hash, target_set_hash,
            approved_origin_hash, media_delivery_epoch_id_hash,
            delivery_contract_hash, delivery_version_hash,
            generation_count, target_count,
            private_deletion_receipt_hash, idempotency_key_hash,
            payload_fingerprint, service_actor_identity_hash
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
            ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22
        )
    `).bind(
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
    );
}

function purgeReceiptStatement(database, receipt) {
    return database.prepare(`
        INSERT INTO gallery_draft_purge_receipts (
            purge_receipt_hash, operation_id_hash,
            withdrawal_operation_id_hash, withdrawal_receipt_hash,
            draft_id_hash, expected_state_version,
            withdrawal_kind, withdrawal_cycle_hash,
            public_host_verification_id_hash, public_host_final_receipt_hash,
            private_deletion_receipt_hash,
            retention_evidence_hash, idempotency_key_hash,
            payload_fingerprint, service_actor_identity_hash,
            withdrawn_at, retention_eligible_at
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
            ?13, ?14, ?15, ?16, ?17
        )
    `).bind(
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

function auditStatement(database, event) {
    return database.prepare(`
        INSERT INTO gallery_audit_events (
            audit_event_id, subject_reference_hash, event_type, state_version,
            actor_identity_hash, payload_hash, occurred_at
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6,
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        )
    `).bind(
        event.auditId,
        event.subjectHash,
        event.eventType,
        event.stateVersion,
        event.actorHash,
        event.payloadHash
    );
}

function replayMatches(receipt, request) {
    return Boolean(receipt) &&
        receipt.draftIdHash === request.draftIdHash &&
        receipt.idempotencyKeyHash === request.idempotencyKeyHash &&
        receipt.payloadFingerprint === request.payloadFingerprint;
}

function validInput(value) {
    return isPlainObject(value) &&
        hasExactKeys(value, INPUT_KEYS) &&
        IDEMPOTENCY_KEY_PATTERN.test(value.idempotencyKey || '');
}

function validBindings(env) {
    return Boolean(env?.DB) &&
        typeof env.DB.prepare === 'function' &&
        typeof env.DB.batch === 'function' &&
        Boolean(env.PRIVATE_ORIGINALS) &&
        typeof env.PRIVATE_ORIGINALS.head === 'function' &&
        typeof env.PRIVATE_ORIGINALS.get === 'function' &&
        typeof env.PRIVATE_ORIGINALS.delete === 'function' &&
        typeof env.PRIVATE_ORIGINALS.list === 'function';
}

function validServiceIdentity(identity) {
    return isPlainObject(identity) &&
        identity.type === 'service' &&
        typeof identity.subject === 'string' &&
        /^[0-9a-f]{32}\.access$/i.test(identity.subject);
}

function success(status, code, fields) {
    return { ok: true, status, code, ...fields };
}

function failure(status, code) {
    return { ok: false, status, code };
}

async function queryFirst(database, sql, ...bindings) {
    const statement = database.prepare(sql).bind(...bindings);
    if (typeof statement.first === 'function') return statement.first();
    const result = await statement.all();
    return Array.isArray(result?.results) ? result.results[0] ?? null : null;
}

async function queryAll(database, sql, ...bindings) {
    const result = await database.prepare(sql).bind(...bindings).all();
    return Array.isArray(result?.results) ? result.results : [];
}

async function runBatch(database, statements) {
    const results = await database.batch(statements);
    if (
        !Array.isArray(results) ||
        results.length !== statements.length ||
        results.some(result => result?.success === false)
    ) throw new Error('Withdrawal finalizer D1 batch failed.');
    return results;
}

function validIsoTime(value) {
    if (typeof value !== 'string') return false;
    const parsed = new Date(value);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function retentionPeriodMatches(receipt) {
    if (
        !WITHDRAWAL_KINDS.has(receipt?.withdrawalKind) ||
        !validIsoTime(receipt.withdrawnAt) ||
        !validIsoTime(receipt.retentionEligibleAt)
    ) return false;
    if (receipt.withdrawalKind === 'consent-withdrawal') {
        return receipt.retentionEligibleAt === receipt.withdrawnAt;
    }
    return receipt.retentionEligibleAt === new Date(
        Date.parse(receipt.withdrawnAt) + 30 * 24 * 60 * 60 * 1000
    ).toISOString();
}

function hasExactKeys(value, keys) {
    return isPlainObject(value) &&
        Object.keys(value).length === keys.length &&
        keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

async function hashProviderFact(kind, value) {
    return hashText(`${kind}:${value}`);
}

async function hashText(value) {
    return sha256Hex(textEncoder.encode(value));
}

function canonicalJson(value) {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    if (isPlainObject(value)) {
        return `{${Object.keys(value).sort().map(key =>
            `${JSON.stringify(key)}:${canonicalJson(value[key])}`
        ).join(',')}}`;
    }
    return JSON.stringify(value);
}

class FinalizationConflict extends Error {}

export const withdrawalFinalizerTestHooks = Object.freeze({
    buildRequestEvidence,
    derivePrivatePrefixes,
    validContext
});
