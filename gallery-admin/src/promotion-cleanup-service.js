import {
    inspectStaticWebp,
    readBoundedBytes,
    sha256Hex
} from './media-byte-verification.js';
import { hashIdentity } from './session.js';
import { buildV1ApprovedDerivativeKey } from './storage-keys.js';

const textEncoder = new TextEncoder();
const INPUT_KEYS = Object.freeze(['expectedStateVersion', 'idempotencyKey']);
const REQUIRED_ROLES = Object.freeze(['photo-display', 'photo-thumbnail']);
const PROMOTION_ID_PATTERN = /^promotion_[a-f0-9]{32}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_PROVIDER_VALUE_PATTERN = /^[^\u0000-\u001f\u007f]{1,512}$/;
const MAX_LIST_PAGES = 256;

export async function cleanupPhotoPromotion(
    env,
    identity,
    promotionId,
    input,
    nowMilliseconds
) {
    if (
        !hasCleanupBindings(env) ||
        !validServiceIdentity(identity) ||
        !PROMOTION_ID_PATTERN.test(promotionId || '') ||
        !validInput(input)
    ) {
        return failure(400, 'invalid-request');
    }

    const payloadFingerprint = await fingerprint({
        operation: 'photo-promotion-cleanup',
        promotionId,
        expectedStateVersion: input.expectedStateVersion,
        idempotencyKey: input.idempotencyKey
    });
    const cleanupIdempotencyKeyHash = await hashProviderFact(
        'cleanup-idempotency-key',
        input.idempotencyKey
    );

    try {
        let cleanup = await readCleanup(env.DB, promotionId);
        if (!cleanup) {
            const receipt = await readCleanupReceipt(
                env.DB,
                await hashProviderFact('promotion-id', promotionId)
            );
            if (receipt) {
                return cleanupReceiptMatches(
                    receipt,
                    cleanupIdempotencyKeyHash,
                    payloadFingerprint
                )
                    ? cleanupReceiptSuccess(promotionId, receipt)
                    : failure(409, 'conflict');
            }
        }
        let replayed = Boolean(cleanup);
        if (cleanup && !cleanupReplayMatches(cleanup, input, payloadFingerprint)) {
            return failure(409, 'conflict');
        }

        if (!cleanup) {
            const context = await readCleanupContext(env.DB, promotionId);
            if (!context) return failure(404, 'not-found');
            const reason = deriveCleanupReason(context);
            const objects = await readSourceObjects(env.DB, promotionId);
            if (
                !reason ||
                context.stateVersion !== input.expectedStateVersion ||
                !validSourceObjects(objects, promotionId)
            ) {
                return failure(409, 'promotion-cleanup-not-eligible');
            }

            const occurredAt = isoTime(nowMilliseconds);
            const cleanupId = randomIdentifier('pcleanup');
            const cleanupIdHash = await hashProviderFact('cleanup-id', cleanupId);
            const promotionIdHash = await hashProviderFact('promotion-id', promotionId);
            const processingRunIdHash = await hashProviderFact(
                'processing-run-id',
                context.processingRunId
            );
            const draftIdHash = await hashProviderFact('draft-id', context.draftId);
            const sourcePromotionIdempotencyKeyHash = await hashProviderFact(
                'promotion-idempotency-key',
                context.promotionIdempotencyKey
            );
            const actorIdentityHash = await hashIdentity(identity);
            const subjectHash = await sha256Text(`draft:${context.draftId}`);
            const objectSnapshots = [];
            for (const object of objects) {
                objectSnapshots.push(await snapshotObject(cleanupId, object, occurredAt));
            }

            const statements = [env.DB.prepare(`
                INSERT INTO draft_photo_promotion_cleanups (
                    cleanup_id, cleanup_id_hash,
                    promotion_id, promotion_id_hash,
                    processing_run_id, processing_run_id_hash,
                    draft_id, draft_id_hash, cleanup_reason, withdrawal_kind,
                    source_promotion_status,
                    source_promotion_idempotency_key,
                    source_promotion_idempotency_key_hash,
                    source_promotion_payload_fingerprint,
                    expected_state_version, object_count,
                    idempotency_key, cleanup_idempotency_key_hash,
                    payload_fingerprint,
                    service_actor_identity_hash, status, created_at, updated_at
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                    ?11, ?12, ?13, ?14, ?15, 2, ?16, ?17, ?18,
                    ?19, 'closing', ?20, ?20
                )
            `).bind(
                cleanupId,
                cleanupIdHash,
                promotionId,
                promotionIdHash,
                context.processingRunId,
                processingRunIdHash,
                context.draftId,
                draftIdHash,
                reason.cleanupReason,
                reason.withdrawalKind,
                context.promotionStatus,
                context.promotionIdempotencyKey,
                sourcePromotionIdempotencyKeyHash,
                context.promotionPayloadFingerprint,
                input.expectedStateVersion,
                input.idempotencyKey,
                cleanupIdempotencyKeyHash,
                payloadFingerprint,
                actorIdentityHash,
                occurredAt
            )];
            for (const object of objectSnapshots) {
                statements.push(env.DB.prepare(`
                    INSERT INTO draft_photo_promotion_cleanup_objects (
                        cleanup_id, role, approved_object_key,
                        approved_object_key_hash, provider_admission_token_hash,
                        provider_upload_id, provider_upload_id_hash,
                        provider_part_etag, provider_part_etag_hash,
                        original_object_status,
                        expected_sha256, expected_byte_count,
                        expected_content_type, expected_width, expected_height,
                        expected_object_version, expected_object_version_hash,
                        expected_etag, expected_etag_hash, status, created_at
                    ) VALUES (
                        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                        ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18,
                        ?19, 'pending', ?20
                    )
                `).bind(
                    object.cleanupId,
                    object.role,
                    object.approvedObjectKey,
                    object.approvedObjectKeyHash,
                    object.providerAdmissionTokenHash,
                    object.providerUploadId,
                    object.providerUploadIdHash,
                    object.providerPartEtag,
                    object.providerPartEtagHash,
                    object.originalObjectStatus,
                    object.expectedSha256,
                    object.expectedByteCount,
                    object.expectedContentType,
                    object.expectedWidth,
                    object.expectedHeight,
                    object.expectedObjectVersion,
                    object.expectedObjectVersionHash,
                    object.expectedEtag,
                    object.expectedEtagHash,
                    object.createdAt
                ));
            }
            statements.push(auditInsert(env.DB, {
                eventType: 'photo-promotion-cleanup-started',
                subjectHash,
                actorIdentityHash,
                payloadHash: payloadFingerprint,
                stateVersion: input.expectedStateVersion,
                occurredAt
            }));

            try {
                await runBatch(env.DB, statements);
            } catch {
                cleanup = await readCleanup(env.DB, promotionId);
                if (!cleanup || !cleanupReplayMatches(cleanup, input, payloadFingerprint)) {
                    return failure(
                        cleanup ? 409 : 503,
                        cleanup ? 'conflict' : 'service-unavailable'
                    );
                }
                replayed = true;
            }
            cleanup = cleanup || await readCleanup(env.DB, promotionId);
        }

        if (!cleanup) return failure(503, 'service-unavailable');
        if (cleanup.status !== 'cleaned') {
            cleanup = await continueCleanup(env, cleanup, nowMilliseconds);
        }
        return cleanup?.status === 'cleaned'
            ? cleanupSuccess(cleanup, replayed, replayed ? 200 : 201)
            : failure(503, 'service-unavailable');
    } catch (error) {
        try {
            const replay = await readCleanup(env.DB, promotionId);
            if (
                replay?.status === 'cleaned' &&
                cleanupReplayMatches(replay, input, payloadFingerprint)
            ) {
                return cleanupSuccess(replay, true, 200);
            }
            const receipt = await readCleanupReceipt(
                env.DB,
                await hashProviderFact('promotion-id', promotionId)
            );
            if (receipt && cleanupReceiptMatches(
                receipt,
                cleanupIdempotencyKeyHash,
                payloadFingerprint
            )) {
                return cleanupReceiptSuccess(promotionId, receipt);
            }
        } catch {
            // Fall through to the fail-closed response.
        }
        return error instanceof ApprovedObjectConflict
            ? failure(409, 'approved-object-conflict')
            : failure(503, 'service-unavailable');
    }
}

async function continueCleanup(env, initialCleanup, nowMilliseconds) {
    let cleanup = initialCleanup;
    if (cleanup.status === 'closing') {
        const objects = await readCleanupObjects(env.DB, cleanup.cleanupId);
        for (const object of objects) {
            if (object.status === 'pending') {
                await terminateMultipart(env, cleanup, object, nowMilliseconds);
            }
        }
        cleanup = await readCleanup(env.DB, cleanup.promotionId);
        if (!cleanup) return null;
        if (cleanup.status === 'closing') {
            const terminalObjects = await readCleanupObjects(env.DB, cleanup.cleanupId);
            if (
                terminalObjects.length !== cleanup.objectCount ||
                terminalObjects.some(object => object.status !== 'terminal')
            ) return null;
            const deletingAt = nextIsoTime(nowMilliseconds, cleanup.updatedAt);
            await runBatch(env.DB, [env.DB.prepare(`
                UPDATE draft_photo_promotion_cleanups
                SET status = 'deleting', updated_at = ?1
                WHERE cleanup_id = ?2 AND status = 'closing'
            `).bind(deletingAt, cleanup.cleanupId)]);
            cleanup = await readCleanup(env.DB, cleanup.promotionId);
        }
    }

    if (!cleanup || cleanup.status !== 'deleting') return cleanup;
    let cleanupObjects = await readCleanupObjects(env.DB, cleanup.cleanupId);
    for (const object of cleanupObjects) {
        if (object.status === 'terminal' || object.status === 'delete-ready') {
            await deleteCleanupObject(env, cleanup, object, nowMilliseconds);
        }
    }

    cleanup = await readCleanup(env.DB, cleanup.promotionId);
    cleanupObjects = await readCleanupObjects(env.DB, cleanup.cleanupId);
    if (
        cleanup.status !== 'deleting' ||
        cleanupObjects.length !== cleanup.objectCount ||
        cleanupObjects.some(object => object.status !== 'absent')
    ) return null;

    for (const object of cleanupObjects) {
        const key = derivedApprovedKey(object);
        if (await hashProviderFact('approved-key', key) !== object.approvedObjectKeyHash) {
            throw new ApprovedObjectConflict();
        }
        await proveExactKeyAbsent(env.APPROVED_MEDIA, key);
    }

    return finalizeCleanup(env, cleanup, cleanupObjects, nowMilliseconds);
}

async function terminateMultipart(env, cleanup, object, nowMilliseconds) {
    const key = requireCurrentCleanupKey(cleanup, object);
    if (
        object.originalObjectStatus === 'admitting' &&
        object.providerUploadId === null
    ) return;
    let terminalKind = 'not-created';
    if (object.providerUploadId) {
        terminalKind = 'aborted';
        try {
            const multipart = env.APPROVED_MEDIA.resumeMultipartUpload(
                key,
                object.providerUploadId
            );
            await multipart.abort();
        } catch (error) {
            if (!isNoSuchUploadError(error)) throw error;
            terminalKind = 'not-found';
        }
    }

    const head = await env.APPROVED_MEDIA.head(key);
    if (head) {
        if (!['part-uploaded', 'verified'].includes(object.originalObjectStatus)) {
            throw new ApprovedObjectConflict();
        }
        const exact = await readExactApprovedObject(env.APPROVED_MEDIA, object, head);
        if (!exact) throw new ApprovedObjectConflict();
        terminalKind = 'completed';
    }

    const terminalAt = nextIsoTime(nowMilliseconds, cleanup.updatedAt);
    await runBatch(env.DB, [env.DB.prepare(`
        UPDATE draft_photo_promotion_cleanup_objects
        SET status = 'terminal', provider_terminal_kind = ?1, terminal_at = ?2
        WHERE cleanup_id = ?3 AND role = ?4 AND status = 'pending'
    `).bind(terminalKind, terminalAt, cleanup.cleanupId, object.role)]);
    const terminal = await readCleanupObject(env.DB, cleanup.cleanupId, object.role);
    if (terminal?.status !== 'terminal') {
        throw new Error('Multipart terminal evidence was not durable.');
    }
}

async function deleteCleanupObject(env, cleanup, initialObject, nowMilliseconds) {
    let object = initialObject;
    const key = derivedApprovedKey(object);
    if (await hashProviderFact('approved-key', key) !== object.approvedObjectKeyHash) {
        throw new ApprovedObjectConflict();
    }

    if (object.status === 'terminal') {
        const head = await env.APPROVED_MEDIA.head(key);
        if (!head) {
            await proveExactKeyAbsent(env.APPROVED_MEDIA, key);
            await markObjectAbsent(env.DB, cleanup, object, null, nowMilliseconds);
            return;
        }
        const exact = await readExactApprovedObject(env.APPROVED_MEDIA, object, head);
        const secondHead = await env.APPROVED_MEDIA.head(key);
        if (!exact || !sameProviderObject(exact, secondHead)) {
            throw new ApprovedObjectConflict();
        }
        const authorizedAt = nextIsoTime(nowMilliseconds, object.terminalAt);
        const versionHash = await hashProviderFact('object-version', exact.version);
        const etagHash = await hashProviderFact('etag', exact.etag);
        await runBatch(env.DB, [env.DB.prepare(`
            UPDATE draft_photo_promotion_cleanup_objects
            SET status = 'delete-ready', observed_object_version_hash = ?1,
                observed_etag_hash = ?2, delete_authorized_at = ?3
            WHERE cleanup_id = ?4 AND role = ?5 AND status = 'terminal'
        `).bind(versionHash, etagHash, authorizedAt, cleanup.cleanupId, object.role)]);
        object = await readCleanupObject(env.DB, cleanup.cleanupId, object.role);
        if (object?.status !== 'delete-ready') {
            throw new Error('Approved delete authorization was not durable.');
        }
    }

    if (object.status !== 'delete-ready') return;
    let deletedAt = null;
    const current = await env.APPROVED_MEDIA.head(key);
    if (current) {
        const exact = await readExactApprovedObject(env.APPROVED_MEDIA, object, current);
        const secondHead = await env.APPROVED_MEDIA.head(key);
        if (
            !exact ||
            !sameProviderObject(exact, secondHead) ||
            await hashProviderFact('object-version', exact.version) !==
                object.observedObjectVersionHash ||
            await hashProviderFact('etag', exact.etag) !== object.observedEtagHash
        ) {
            throw new ApprovedObjectConflict();
        }
        deletedAt = nextIsoTime(nowMilliseconds, object.deleteAuthorizedAt);
        await env.APPROVED_MEDIA.delete(key);
    }
    await proveExactKeyAbsent(env.APPROVED_MEDIA, key);
    await markObjectAbsent(env.DB, cleanup, object, deletedAt, nowMilliseconds);
}

async function markObjectAbsent(database, cleanup, object, deletedAt, nowMilliseconds) {
    const absenceVerifiedAt = nextIsoTime(
        nowMilliseconds,
        deletedAt || object.deleteAuthorizedAt || object.terminalAt
    );
    await runBatch(database, [database.prepare(`
        UPDATE draft_photo_promotion_cleanup_objects
        SET approved_object_key = NULL, provider_upload_id = NULL,
            provider_part_etag = NULL, expected_object_version = NULL,
            expected_etag = NULL, status = 'absent', deleted_at = ?1,
            absence_verified_at = ?2
        WHERE cleanup_id = ?3 AND role = ?4 AND status = ?5
    `).bind(
        deletedAt,
        absenceVerifiedAt,
        cleanup.cleanupId,
        object.role,
        object.status
    )]);
    const absent = await readCleanupObject(database, cleanup.cleanupId, object.role);
    if (absent?.status !== 'absent') {
        throw new Error('Approved-object absence evidence was not durable.');
    }
}

async function finalizeCleanup(env, cleanup, objects, nowMilliseconds) {
    const latestAbsence = objects.reduce(
        (latest, object) => laterTimestamp(latest, object.absenceVerifiedAt),
        cleanup.updatedAt
    );
    const completedAt = nextIsoTime(nowMilliseconds, latestAbsence);
    if (
        cleanup.cleanupIdHash !== await hashProviderFact('cleanup-id', cleanup.cleanupId) ||
        cleanup.promotionIdHash !== await hashProviderFact('promotion-id', cleanup.promotionId) ||
        cleanup.processingRunIdHash !== await hashProviderFact(
            'processing-run-id', cleanup.processingRunId
        ) ||
        cleanup.draftIdHash !== await hashProviderFact('draft-id', cleanup.draftId)
    ) return null;

    const sourcePromotionIdempotencyKeyHash = await hashProviderFact(
        'promotion-idempotency-key',
        cleanup.sourcePromotionIdempotencyKey
    );
    const cleanupIdempotencyKeyHash = await hashProviderFact(
        'cleanup-idempotency-key',
        cleanup.idempotencyKey
    );
    if (
        cleanup.sourcePromotionIdempotencyKeyHash !== sourcePromotionIdempotencyKeyHash ||
        cleanup.cleanupIdempotencyKeyHash !== cleanupIdempotencyKeyHash
    ) return null;
    const evidenceHash = await fingerprint({
        operation: 'approved-photo-cleanup',
        schemaVersion: '1.0',
        cleanupIdHash: cleanup.cleanupIdHash,
        promotionIdHash: cleanup.promotionIdHash,
        processingRunIdHash: cleanup.processingRunIdHash,
        draftIdHash: cleanup.draftIdHash,
        cleanupReason: cleanup.cleanupReason,
        withdrawalKind: cleanup.withdrawalKind,
        sourcePromotionStatus: cleanup.sourcePromotionStatus,
        sourcePromotionIdempotencyKeyHash,
        sourcePromotionPayloadFingerprint: cleanup.sourcePromotionPayloadFingerprint,
        expectedStateVersion: cleanup.expectedStateVersion,
        cleanupIdempotencyKeyHash,
        objects: objects.map(object => ({
            role: object.role,
            approvedObjectKeyHash: object.approvedObjectKeyHash,
            providerAdmissionTokenHash: object.providerAdmissionTokenHash,
            providerUploadIdHash: object.providerUploadIdHash,
            providerPartEtagHash: object.providerPartEtagHash,
            originalObjectStatus: object.originalObjectStatus,
            expectedSha256: object.expectedSha256,
            expectedByteCount: object.expectedByteCount,
            expectedContentType: object.expectedContentType,
            expectedWidth: object.expectedWidth,
            expectedHeight: object.expectedHeight,
            expectedObjectVersionHash: object.expectedObjectVersionHash,
            expectedEtagHash: object.expectedEtagHash,
            providerTerminalKind: object.providerTerminalKind,
            observedObjectVersionHash: object.observedObjectVersionHash,
            observedEtagHash: object.observedEtagHash,
            deleteAuthorizedAt: object.deleteAuthorizedAt,
            deletedAt: object.deletedAt,
            absenceVerifiedAt: object.absenceVerifiedAt,
            exactKeyPrefixEmpty: true
        })),
        completedAt
    });
    const subjectHash = await sha256Text(`draft:${cleanup.draftId}`);
    const statements = [];

    for (const object of objects) {
        const key = derivedApprovedKey(object);
        statements.push(env.DB.prepare(`
            UPDATE draft_derivatives
            SET approved_object_key = NULL
            WHERE draft_id = ?1 AND role = ?2
              AND approved_object_key = ?3
              AND sha256 = ?4 AND byte_count = ?5
        `).bind(
            cleanup.draftId,
            object.role,
            key,
            object.expectedSha256,
            object.expectedByteCount
        ));
    }

    statements.push(
        env.DB.prepare(`
            DELETE FROM draft_photo_promotion_objects
            WHERE promotion_id = ?1
        `).bind(cleanup.promotionId),
        env.DB.prepare(`
            DELETE FROM draft_photo_promotions
            WHERE promotion_id = ?1
        `).bind(cleanup.promotionId),
        env.DB.prepare(`
            UPDATE draft_photo_promotion_cleanups
            SET status = 'cleaned', cleanup_evidence_hash = ?1,
                updated_at = ?2, completed_at = ?2
            WHERE cleanup_id = ?3 AND status = 'deleting'
        `).bind(evidenceHash, completedAt, cleanup.cleanupId),
        env.DB.prepare(`
            INSERT INTO gallery_photo_promotion_cleanup_tombstones (
                cleanup_id_hash, promotion_id_hash, processing_run_id_hash,
                draft_id_hash, source_promotion_idempotency_key_hash,
                source_promotion_payload_fingerprint,
                cleanup_idempotency_key_hash,
                cleanup_payload_fingerprint, cleanup_reason, withdrawal_kind,
                evidence_hash, completed_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
            )
        `).bind(
            cleanup.cleanupIdHash,
            cleanup.promotionIdHash,
            cleanup.processingRunIdHash,
            cleanup.draftIdHash,
            sourcePromotionIdempotencyKeyHash,
            cleanup.sourcePromotionPayloadFingerprint,
            cleanupIdempotencyKeyHash,
            cleanup.payloadFingerprint,
            cleanup.cleanupReason,
            cleanup.withdrawalKind,
            evidenceHash,
            completedAt
        ),
        auditInsert(env.DB, {
            eventType: 'photo-promotion-approved-media-cleaned',
            subjectHash,
            actorIdentityHash: cleanup.serviceActorIdentityHash,
            payloadHash: evidenceHash,
            stateVersion: cleanup.expectedStateVersion,
            occurredAt: completedAt
        })
    );

    try {
        await runBatch(env.DB, statements);
    } catch {
        const replay = await readCleanup(env.DB, cleanup.promotionId);
        return replay?.status === 'cleaned' ? replay : null;
    }
    return readCleanup(env.DB, cleanup.promotionId);
}

async function proveExactKeyAbsent(bucket, key) {
    if (await bucket.head(key)) throw new ApprovedObjectConflict();
    if (!await exactKeyPrefixIsEmpty(bucket, key)) {
        throw new ApprovedObjectConflict();
    }
    if (await bucket.head(key)) throw new ApprovedObjectConflict();
}

async function exactKeyPrefixIsEmpty(bucket, prefix) {
    let cursor;
    const seenCursors = new Set();
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const listing = await bucket.list({
            prefix,
            limit: 1000,
            ...(cursor ? { cursor } : {})
        });
        if (
            !listing ||
            !Array.isArray(listing.objects) ||
            !Array.isArray(listing.delimitedPrefixes) ||
            typeof listing.truncated !== 'boolean'
        ) throw new Error('Malformed approved-media listing response.');
        if (listing.objects.length > 0 || listing.delimitedPrefixes.length > 0) {
            return false;
        }
        if (!listing.truncated) return true;
        if (
            typeof listing.cursor !== 'string' ||
            listing.cursor.length < 1 ||
            listing.cursor.length > 2048 ||
            seenCursors.has(listing.cursor)
        ) throw new Error('Malformed approved-media listing cursor.');
        seenCursors.add(listing.cursor);
        cursor = listing.cursor;
    }
    throw new Error('Approved-media listing exceeded the page limit.');
}

async function readExactApprovedObject(bucket, object, initialHead) {
    if (!approvedObjectMatches(initialHead, object)) return null;
    if (
        object.expectedObjectVersion &&
        initialHead.version !== object.expectedObjectVersion
    ) return null;
    if (object.expectedEtag && initialHead.etag !== object.expectedEtag) return null;
    const stored = await bucket.get(derivedApprovedKey(object), {
        onlyIf: { etagMatches: initialHead.etag }
    });
    if (
        !approvedObjectMatches(stored, object) ||
        stored.version !== initialHead.version ||
        stored.etag !== initialHead.etag ||
        stored.body === undefined ||
        stored.body === null
    ) return null;
    const bytes = await readBoundedBytes(stored.body, object.expectedByteCount);
    const dimensions = inspectStaticWebp(bytes);
    return bytes.byteLength === object.expectedByteCount &&
        await sha256Hex(bytes) === object.expectedSha256 &&
        dimensions?.width === object.expectedWidth &&
        dimensions?.height === object.expectedHeight
        ? initialHead
        : null;
}

function approvedObjectMatches(stored, object) {
    const http = stored?.httpMetadata;
    const custom = stored?.customMetadata;
    return Boolean(stored) &&
        stored.size === object.expectedByteCount &&
        safeProviderValue(stored.version) &&
        safeProviderValue(stored.etag) &&
        isPlainObject(http) &&
        Object.keys(http).length === 1 &&
        http.contentType === object.expectedContentType &&
        isPlainObject(custom) &&
        Object.keys(custom).length === 2 &&
        custom.contract === 'gallery-approved-media-v1' &&
        custom.role === object.role;
}

function sameProviderObject(left, right) {
    return Boolean(left) && Boolean(right) &&
        left.size === right.size &&
        left.version === right.version &&
        left.etag === right.etag;
}

function derivedApprovedKey(object) {
    return buildV1ApprovedDerivativeKey({
        sha256: object.expectedSha256,
        role: object.role
    });
}

function requireCurrentCleanupKey(cleanup, object) {
    const key = derivedApprovedKey(object);
    if (
        object.cleanupId !== cleanup.cleanupId ||
        object.approvedObjectKey !== key
    ) throw new ApprovedObjectConflict();
    return key;
}

async function snapshotObject(cleanupId, object, createdAt) {
    if (object.providerUploadId) {
        const expectedUploadHash = await sha256Text(
            `approved-upload:${object.providerUploadId}`
        );
        if (object.providerUploadIdHash !== expectedUploadHash) {
            throw new Error('Approved upload identity hash mismatch.');
        }
    }
    return {
        cleanupId,
        role: object.role,
        approvedObjectKey: object.approvedObjectKey,
        approvedObjectKeyHash: await hashProviderFact(
            'approved-key', object.approvedObjectKey
        ),
        providerAdmissionTokenHash: object.providerAdmissionTokenHash,
        providerUploadId: object.providerUploadId,
        providerUploadIdHash: object.providerUploadIdHash,
        providerPartEtag: object.providerPartEtag,
        providerPartEtagHash: object.providerPartEtag
            ? await hashProviderFact('part-etag', object.providerPartEtag)
            : null,
        originalObjectStatus: object.status,
        expectedSha256: object.sha256,
        expectedByteCount: object.byteCount,
        expectedContentType: object.contentType,
        expectedWidth: object.width,
        expectedHeight: object.height,
        expectedObjectVersion: object.approvedObjectVersion,
        expectedObjectVersionHash: object.approvedObjectVersion
            ? await hashProviderFact('object-version', object.approvedObjectVersion)
            : null,
        expectedEtag: object.approvedEtag,
        expectedEtagHash: object.approvedEtag
            ? await hashProviderFact('etag', object.approvedEtag)
            : null,
        createdAt
    };
}

function validSourceObjects(objects, promotionId) {
    return objects.length === REQUIRED_ROLES.length &&
        REQUIRED_ROLES.every((role, index) => objects[index]?.role === role) &&
        objects.every(object =>
            object.promotionId === promotionId &&
            object.approvedObjectKey === buildV1ApprovedDerivativeKey({
                sha256: object.sha256,
                role: object.role
            }) &&
            (
                (object.status === 'reserved' &&
                    object.providerAdmissionTokenHash === null &&
                    object.providerUploadId === null &&
                    object.providerPartEtag === null &&
                    object.approvedObjectVersion === null &&
                    object.approvedEtag === null) ||
                (object.status === 'admitting' &&
                    safeHash(object.providerAdmissionTokenHash) &&
                    object.providerUploadId === null &&
                    object.providerPartEtag === null &&
                    object.approvedObjectVersion === null &&
                    object.approvedEtag === null) ||
                (object.status === 'upload-open' &&
                    safeHash(object.providerAdmissionTokenHash) &&
                    safeProviderValue(object.providerUploadId) &&
                    object.providerPartEtag === null &&
                    object.approvedObjectVersion === null &&
                    object.approvedEtag === null) ||
                (object.status === 'part-uploaded' &&
                    safeHash(object.providerAdmissionTokenHash) &&
                    safeProviderValue(object.providerUploadId) &&
                    safeProviderValue(object.providerPartEtag) &&
                    object.approvedObjectVersion === null &&
                    object.approvedEtag === null) ||
                (object.status === 'verified' &&
                    safeHash(object.providerAdmissionTokenHash) &&
                    safeProviderValue(object.providerUploadId) &&
                    safeProviderValue(object.providerPartEtag) &&
                    safeProviderValue(object.approvedObjectVersion) &&
                    safeProviderValue(object.approvedEtag))
            )
        );
}

function deriveCleanupReason(context) {
    if (
        context.withdrawalIntent === 'consent-withdrawal' ||
        context.consentWithdrawnAt
    ) {
        return {
            cleanupReason: 'withdrawal',
            withdrawalKind: 'consent-withdrawal'
        };
    }
    if (
        context.pendingExclusionCount > 0 &&
        ['processing', 'candidate-public', 'private-review', 'withdrawal-pending']
            .includes(context.state)
    ) {
        return {
            cleanupReason: 'athlete-exclusion',
            withdrawalKind: 'athlete-exclusion'
        };
    }
    if (
        context.withdrawalIntent === 'editorial-removal' ||
        (
            context.state === 'withdrawal-pending' &&
            context.withdrawalIntent === null
        )
    ) {
        return {
            cleanupReason: 'withdrawal',
            withdrawalKind: 'editorial-removal'
        };
    }
    if (context.promotionStatus === 'active' && context.state === 'processing') {
        return { cleanupReason: 'promotion-cancelled', withdrawalKind: null };
    }
    return null;
}

async function readCleanupContext(database, promotionId) {
    return queryFirst(database, `
        SELECT
            promotion.promotion_id AS promotionId,
            promotion.processing_run_id AS processingRunId,
            promotion.draft_id AS draftId,
            promotion.status AS promotionStatus,
            promotion.idempotency_key AS promotionIdempotencyKey,
            promotion.payload_fingerprint AS promotionPayloadFingerprint,
            draft.state,
            draft.state_version AS stateVersion,
            consent.withdrawn_at AS consentWithdrawnAt,
            publication.withdrawal_kind AS withdrawalIntent,
            (SELECT COUNT(*)
                FROM json_each(draft.athlete_ids_json) AS tag
                JOIN pending_athlete_exclusions AS exclusion
                  ON exclusion.athlete_id = tag.value
                WHERE exclusion.resolved_at IS NULL) AS pendingExclusionCount
        FROM draft_photo_promotions AS promotion
        JOIN gallery_drafts AS draft ON draft.draft_id = promotion.draft_id
        JOIN draft_consent_attestations AS consent
          ON consent.draft_id = promotion.draft_id
         AND consent.consent_revision = promotion.consent_revision
        LEFT JOIN draft_publication_references AS publication
          ON publication.draft_id = promotion.draft_id
        WHERE promotion.promotion_id = ?1
    `, promotionId);
}

async function readSourceObjects(database, promotionId) {
    return queryAll(database, `
        SELECT
            promotion_id AS promotionId,
            role,
            approved_object_key AS approvedObjectKey,
            sha256,
            byte_count AS byteCount,
            content_type AS contentType,
            width,
            height,
            status,
            provider_upload_id AS providerUploadId,
            provider_admission_token_hash AS providerAdmissionTokenHash,
            provider_upload_id_hash AS providerUploadIdHash,
            provider_part_etag AS providerPartEtag,
            approved_object_version AS approvedObjectVersion,
            approved_etag AS approvedEtag
        FROM draft_photo_promotion_objects
        WHERE promotion_id = ?1 ORDER BY role ASC
    `, promotionId);
}

async function readCleanup(database, promotionId) {
    return queryFirst(database, `
        SELECT
            cleanup_id AS cleanupId,
            cleanup_id_hash AS cleanupIdHash,
            promotion_id AS promotionId,
            promotion_id_hash AS promotionIdHash,
            processing_run_id AS processingRunId,
            processing_run_id_hash AS processingRunIdHash,
            draft_id AS draftId,
            draft_id_hash AS draftIdHash,
            cleanup_reason AS cleanupReason,
            withdrawal_kind AS withdrawalKind,
            source_promotion_status AS sourcePromotionStatus,
            source_promotion_idempotency_key AS sourcePromotionIdempotencyKey,
            source_promotion_idempotency_key_hash AS sourcePromotionIdempotencyKeyHash,
            source_promotion_payload_fingerprint AS sourcePromotionPayloadFingerprint,
            expected_state_version AS expectedStateVersion,
            object_count AS objectCount,
            idempotency_key AS idempotencyKey,
            cleanup_idempotency_key_hash AS cleanupIdempotencyKeyHash,
            payload_fingerprint AS payloadFingerprint,
            service_actor_identity_hash AS serviceActorIdentityHash,
            status,
            cleanup_evidence_hash AS cleanupEvidenceHash,
            created_at AS createdAt,
            updated_at AS updatedAt,
            completed_at AS completedAt
        FROM draft_photo_promotion_cleanups
        WHERE promotion_id = ?1
    `, promotionId);
}

async function readCleanupReceipt(database, promotionIdHash) {
    return queryFirst(database, `
        SELECT
            promotion_id_hash AS promotionIdHash,
            cleanup_idempotency_key_hash AS idempotencyKeyHash,
            cleanup_payload_fingerprint AS payloadFingerprint,
            cleanup_reason AS cleanupReason
        FROM gallery_photo_promotion_cleanup_tombstones
        WHERE promotion_id_hash = ?1
    `, promotionIdHash);
}

async function readCleanupObjects(database, cleanupId) {
    return queryAll(database, `${cleanupObjectSelect()} WHERE cleanup_id = ?1 ORDER BY role`, cleanupId);
}

async function readCleanupObject(database, cleanupId, role) {
    return queryFirst(
        database,
        `${cleanupObjectSelect()} WHERE cleanup_id = ?1 AND role = ?2`,
        cleanupId,
        role
    );
}

function cleanupObjectSelect() {
    return `
        SELECT
            cleanup_id AS cleanupId,
            role,
            approved_object_key AS approvedObjectKey,
            approved_object_key_hash AS approvedObjectKeyHash,
            provider_admission_token_hash AS providerAdmissionTokenHash,
            provider_upload_id AS providerUploadId,
            provider_upload_id_hash AS providerUploadIdHash,
            provider_part_etag AS providerPartEtag,
            provider_part_etag_hash AS providerPartEtagHash,
            original_object_status AS originalObjectStatus,
            expected_sha256 AS expectedSha256,
            expected_byte_count AS expectedByteCount,
            expected_content_type AS expectedContentType,
            expected_width AS expectedWidth,
            expected_height AS expectedHeight,
            expected_object_version AS expectedObjectVersion,
            expected_object_version_hash AS expectedObjectVersionHash,
            expected_etag AS expectedEtag,
            expected_etag_hash AS expectedEtagHash,
            provider_terminal_kind AS providerTerminalKind,
            observed_object_version_hash AS observedObjectVersionHash,
            observed_etag_hash AS observedEtagHash,
            status,
            created_at AS createdAt,
            terminal_at AS terminalAt,
            delete_authorized_at AS deleteAuthorizedAt,
            deleted_at AS deletedAt,
            absence_verified_at AS absenceVerifiedAt
        FROM draft_photo_promotion_cleanup_objects`;
}

function cleanupReplayMatches(cleanup, input, payloadFingerprint) {
    return cleanup.expectedStateVersion === input.expectedStateVersion &&
        cleanup.idempotencyKey === input.idempotencyKey &&
        cleanup.payloadFingerprint === payloadFingerprint;
}

function cleanupReceiptMatches(receipt, idempotencyKeyHash, payloadFingerprint) {
    return receipt.idempotencyKeyHash === idempotencyKeyHash &&
        receipt.payloadFingerprint === payloadFingerprint;
}

function cleanupSuccess(cleanup, replayed, status) {
    return success(status, {
        promotionId: cleanup.promotionId,
        cleanupReason: cleanup.cleanupReason,
        promotionStatus: 'cleaned',
        replayed
    });
}

function cleanupReceiptSuccess(promotionId, receipt) {
    return success(200, {
        promotionId,
        cleanupReason: receipt.cleanupReason,
        promotionStatus: 'cleaned',
        replayed: true
    });
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

function hasCleanupBindings(env) {
    return Boolean(env?.DB) &&
        typeof env.DB.prepare === 'function' &&
        typeof env.DB.batch === 'function' &&
        Boolean(env.APPROVED_MEDIA) &&
        typeof env.APPROVED_MEDIA.head === 'function' &&
        typeof env.APPROVED_MEDIA.get === 'function' &&
        typeof env.APPROVED_MEDIA.delete === 'function' &&
        typeof env.APPROVED_MEDIA.list === 'function' &&
        typeof env.APPROVED_MEDIA.resumeMultipartUpload === 'function';
}

function safeProviderValue(value) {
    return typeof value === 'string' && SAFE_PROVIDER_VALUE_PATTERN.test(value);
}

function safeHash(value) {
    return typeof value === 'string' && SHA256_PATTERN.test(value);
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
    ) throw new Error('Photo promotion cleanup transaction failed.');
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

async function fingerprint(value) {
    return sha256Text(JSON.stringify(value));
}

async function hashProviderFact(kind, value) {
    return sha256Text(`${kind}:${value}`);
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

function laterTimestamp(left, right) {
    const leftTime = Date.parse(left || '');
    const rightTime = Date.parse(right || '');
    if (!Number.isFinite(leftTime)) return right;
    if (!Number.isFinite(rightTime)) return left;
    return rightTime > leftTime ? right : left;
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

class ApprovedObjectConflict extends Error {}
