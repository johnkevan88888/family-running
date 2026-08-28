import galleryContractModule from '../../gallery-contract.js';
import mediaPolicyModule from '../../gallery-media-policy.js';
import uploadContractModule from '../../gallery-upload-contract.js';
import { hashIdentity } from './session.js';

// Loading the public contract first is deliberate: the provider-independent
// upload contract delegates the exact public item shape to it.
void galleryContractModule;

const mediaPolicy = mediaPolicyModule?.default || mediaPolicyModule;
const uploadContract = uploadContractModule?.default || uploadContractModule;

const PART_SIZE = 5 * 1024 * 1024;
const UPLOAD_LIFETIME_MILLISECONDS = 24 * 60 * 60 * 1000;
const ID_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_PROVIDER_VALUE_PATTERN = /^[^\u0000-\u001f\u007f]{1,1024}$/;
const MAX_PROVIDER_UPLOAD_ID_LENGTH = 1024;
const MAX_PROVIDER_OBJECT_VALUE_LENGTH = 256;
const SYNTHETIC_FILE_PATTERN = /^synthetic-[A-Za-z0-9][A-Za-z0-9._-]{0,220}\.(jpg|jpeg|png|webp|heic|heif|mp4|mov|webm)$/;
const BEGIN_UPLOAD_KEYS = new Set([
    'expectedStateVersion',
    'fileName',
    'declaredMimeType',
    'byteLength',
    'idempotencyKey',
    'syntheticOnlyConfirmed'
]);
const COMPLETE_UPLOAD_KEYS = new Set([
    'expectedStateVersion',
    'idempotencyKey'
]);
const PREVIEWABLE_STATES = new Set([
    'private-review',
    'approved-for-processing'
]);
const SITE_MODES = new Set(['family', 'everyone']);
const FORMAT_BY_EXTENSION = Object.freeze({
    jpg: 'jpeg',
    jpeg: 'jpeg',
    png: 'png',
    webp: 'webp',
    heic: 'heif',
    heif: 'heif',
    mp4: 'mp4',
    mov: 'quicktime',
    webm: 'webm'
});
const PREVIEW_CONTENT_TYPES = Object.freeze({
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    heif: 'image/heif',
    mp4: 'video/mp4',
    quicktime: 'video/quicktime',
    webm: 'video/webm'
});

export async function beginPrivateUpload(
    env,
    identity,
    siteMode,
    draftId,
    input,
    catalogSnapshot,
    nowMilliseconds,
    dependencies = {}
) {
    const inputProblems = validateBeginUploadInput(input);
    if (
        !validSiteMode(siteMode) ||
        !ID_PATTERN.test(String(draftId || '')) ||
        inputProblems.length
    ) {
        return failure(400, 'invalid-request', inputProblems);
    }
    if (!hasDatabase(env) || !hasOriginalsBucket(env)) {
        return failure(503, 'service-unavailable');
    }

    const now = isoTime(nowMilliseconds);
    const ownerHash = await hashIdentity(identity);
    const draftRow = await readDraftForUpload(
        env.DB,
        draftId,
        ownerHash,
        siteMode
    );
    if (!draftRow) {
        return failure(404, 'not-found');
    }

    const format = formatForUploadInput(input, draftRow.mediaType);
    if (!format) {
        return failure(415, 'unsupported-media-type');
    }
    const limit = mediaPolicy.inputLimits?.[draftRow.mediaType]?.maximumBytes;
    if (!Number.isSafeInteger(limit) || input.byteLength > limit) {
        return failure(413, 'request-too-large');
    }
    const operationFingerprint = await fingerprint({
        operation: 'begin-private-upload',
        draftId,
        siteMode,
        expectedStateVersion: input.expectedStateVersion,
        fileExtension: extensionOf(input.fileName),
        declaredMimeType: input.declaredMimeType,
        byteLength: input.byteLength,
        syntheticOnlyConfirmed: input.syntheticOnlyConfirmed
    });
    const replay = await readUploadByIdempotency(
        env.DB,
        draftId,
        input.idempotencyKey,
        ownerHash
    );
    if (replay) {
        if (replay.initiationPayloadFingerprint !== operationFingerprint) {
            return failure(409, 'conflict');
        }
        return success(200, {
            replayed: true,
            upload: await safeUploadStatus(env.DB, replay)
        });
    }

    if (input.expectedStateVersion !== draftRow.stateVersion) {
        return failure(409, 'conflict');
    }

    const approvalProblems = await validateCurrentDraftApproval(
        env.DB,
        draftRow,
        catalogSnapshot
    );
    if (approvalProblems.length) {
        return failure(409, 'stale-or-blocked', approvalProblems);
    }

    const current = await readCurrentUpload(env.DB, draftId, ownerHash);
    if (current && ['active', 'completing', 'complete'].includes(current.status)) {
        return failure(409, 'upload-already-exists');
    }
    if (!['draft', 'uploading'].includes(draftRow.state)) {
        return failure(409, 'invalid-state');
    }
    if (draftRow.state === 'uploading' && !current) {
        // A previous terminal upload is required before a same-state restart.
        const terminal = await readLatestUpload(env.DB, draftId, ownerHash);
        if (!terminal || !['failed', 'aborted', 'expired'].includes(terminal.status)) {
            return failure(409, 'invalid-state');
        }
    }

    const uploadSessionId = randomIdentifier('upload');
    const objectKey = privateObjectKey(draftId, extensionOf(input.fileName));
    let providerUpload;
    try {
        providerUpload = await env.PRIVATE_ORIGINALS.createMultipartUpload(
            objectKey,
            {
                httpMetadata: {
                    contentType: input.declaredMimeType,
                    contentDisposition: 'inline'
                }
            }
        );
    } catch {
        return failure(503, 'service-unavailable');
    }

    if (
        !providerUpload ||
        providerUpload.key !== objectKey ||
        !safeProviderValue(
            providerUpload.uploadId,
            MAX_PROVIDER_UPLOAD_ID_LENGTH
        )
    ) {
        await bestEffortAbort(providerUpload);
        return failure(503, 'service-unavailable');
    }

    const createdAt = now;
    const expiresAt = new Date(
        safeNow(nowMilliseconds) + UPLOAD_LIFETIME_MILLISECONDS
    ).toISOString();
    const partCount = Math.ceil(input.byteLength / PART_SIZE);
    const actorHash = ownerHash;
    const auditSubjectHash = await sha256Text(`draft:${draftId}`);
    const auditEventId = randomIdentifier('audit');
    const isFirstUpload = draftRow.state === 'draft';

    try {
        const statements = [];
        statements.push(env.DB.prepare(
            'UPDATE gallery_drafts SET ' +
            (isFirstUpload
                ? "state = 'uploading', state_version = state_version + 1, "
                : '') +
            'original_object_key = ?1, original_detected_type = NULL, ' +
            'original_byte_count = NULL, original_sha256 = NULL, ' +
            'upload_complete = 0, updated_at = ?2 ' +
            'WHERE draft_id = ?3 AND state = ?4 AND state_version = ?5 ' +
            'AND item_revision = ?6 AND upload_complete = 0 ' +
            'AND site_modes_json = ?7'
        ).bind(
            objectKey,
            createdAt,
            draftId,
            draftRow.state,
            input.expectedStateVersion,
            draftRow.itemRevision,
            JSON.stringify([siteMode])
        ));

        statements.push(env.DB.prepare(
            'INSERT INTO draft_upload_sessions (' +
            'upload_session_id, draft_id, item_revision, consent_revision, ' +
            'export_bundle_id, source_revision, suppression_revision, ' +
            'provider_upload_id, object_key, file_extension, declared_content_type, ' +
            'declared_byte_count, part_size, part_count, synthetic_only_confirmed, ' +
            'verified_owner_identity_hash, initiation_idempotency_key, ' +
            'initiation_payload_fingerprint, created_at, updated_at, expires_at' +
            ') VALUES (' + placeholders(21) + ')'
        ).bind(
            uploadSessionId,
            draftId,
            draftRow.itemRevision,
            draftRow.activeConsentRevision,
            draftRow.exportBundleId,
            draftRow.sourceRevision,
            draftRow.suppressionRevision,
            providerUpload.uploadId,
            objectKey,
            extensionOf(input.fileName),
            input.declaredMimeType,
            input.byteLength,
            PART_SIZE,
            partCount,
            1,
            actorHash,
            input.idempotencyKey,
            operationFingerprint,
            createdAt,
            createdAt,
            expiresAt
        ));

        if (isFirstUpload) {
            statements.push(env.DB.prepare(
                'INSERT INTO draft_transition_receipts (' +
                'draft_id, idempotency_key, payload_fingerprint, from_state, ' +
                'to_state, expected_state_version, result_state_version, created_at' +
                ') VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)'
            ).bind(
                draftId,
                input.idempotencyKey,
                operationFingerprint,
                'draft',
                'uploading',
                input.expectedStateVersion,
                input.expectedStateVersion + 1,
                createdAt
            ));
        } else {
            statements.push(env.DB.prepare(
                'INSERT INTO draft_mutation_receipts (' +
                'draft_id, idempotency_key, mutation_kind, payload_fingerprint, ' +
                'expected_item_revision, result_item_revision, created_at' +
                ') VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)'
            ).bind(
                draftId,
                input.idempotencyKey,
                'restart-upload',
                operationFingerprint,
                draftRow.itemRevision,
                draftRow.itemRevision,
                createdAt
            ));
        }

        statements.push(env.DB.prepare(
            'INSERT INTO gallery_audit_events (' +
            'audit_event_id, subject_reference_hash, event_type, state_version, ' +
            'actor_identity_hash, payload_hash, occurred_at' +
            ') VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)'
        ).bind(
            auditEventId,
            auditSubjectHash,
            isFirstUpload ? 'upload-started' : 'upload-restarted',
            isFirstUpload
                ? input.expectedStateVersion + 1
                : input.expectedStateVersion,
            actorHash,
            operationFingerprint,
            createdAt
        ));

        await runBatch(env.DB, statements);
    } catch {
        await bestEffortAbort(providerUpload);
        return failure(409, 'conflict');
    }

    const stored = await readUploadBySessionId(env.DB, uploadSessionId, ownerHash);
    if (!stored) {
        await bestEffortAbort(providerUpload);
        return failure(503, 'service-unavailable');
    }
    return success(201, {
        replayed: false,
        upload: await safeUploadStatus(env.DB, stored)
    });
}

export async function readPrivateUploadStatus(env, identity, siteMode, draftId) {
    if (
        !validSiteMode(siteMode) ||
        !ID_PATTERN.test(String(draftId || '')) ||
        !hasDatabase(env)
    ) {
        return failure(400, 'invalid-request');
    }
    const ownerHash = await hashIdentity(identity);
    const draft = await readDraftForUpload(
        env.DB,
        draftId,
        ownerHash,
        siteMode
    );
    if (!draft) {
        return failure(404, 'not-found');
    }
    const upload = await readLatestUpload(env.DB, draftId, ownerHash);
    if (!upload) {
        return failure(404, 'not-found');
    }
    return success(200, { upload: await safeUploadStatus(env.DB, upload) });
}

export async function storePrivateUploadPart(
    env,
    identity,
    siteMode,
    draftId,
    partNumber,
    request,
    nowMilliseconds,
    dependencies = {}
) {
    if (
        !validSiteMode(siteMode) ||
        !ID_PATTERN.test(String(draftId || '')) ||
        !Number.isSafeInteger(partNumber) ||
        partNumber < 1 ||
        partNumber > 100 ||
        !hasDatabase(env) ||
        !hasOriginalsBucket(env)
    ) {
        return failure(400, 'invalid-request');
    }
    if (
        request.method !== 'PUT' ||
        request.headers.get('Content-Type') !== 'application/octet-stream' ||
        request.headers.has('Content-Encoding') ||
        request.body === null
    ) {
        return failure(415, 'unsupported-media-type');
    }
    const suppliedHash = request.headers.get('X-Chunk-SHA256');
    if (!SHA256_PATTERN.test(String(suppliedHash || ''))) {
        return failure(400, 'invalid-request');
    }

    const ownerHash = await hashIdentity(identity);
    const draft = await readDraftForUpload(
        env.DB,
        draftId,
        ownerHash,
        siteMode
    );
    if (!draft) {
        return failure(404, 'not-found');
    }
    const upload = await readCurrentUpload(env.DB, draftId, ownerHash);
    if (!upload || upload.status !== 'active') {
        return failure(409, 'invalid-state');
    }
    if (incompleteUploadExpired(upload, nowMilliseconds)) {
        return failure(409, 'invalid-state');
    }
    const expectedByteCount = expectedPartByteCount(upload, partNumber);
    if (expectedByteCount === null) {
        return failure(409, 'invalid-part');
    }
    const declaredLength = request.headers.get('Content-Length');
    if (
        declaredLength !== null &&
        (!/^\d+$/.test(declaredLength) || Number(declaredLength) !== expectedByteCount)
    ) {
        return failure(400, 'invalid-part-size');
    }

    const existingPart = await readUploadPart(
        env.DB,
        upload.uploadSessionId,
        partNumber
    );
    if (existingPart) {
        if (
            existingPart.byteCount !== expectedByteCount ||
            existingPart.sha256 !== suppliedHash
        ) {
            return failure(409, 'conflict');
        }
        return success(200, {
            replayed: true,
            upload: await safeUploadStatus(env.DB, upload)
        });
    }
    if (partNumber !== upload.nextPartNumber) {
        return failure(409, 'out-of-sequence');
    }

    let partBytes;
    let calculatedHash;
    try {
        partBytes = await readExactPartBytes(
            request.body,
            expectedByteCount
        );
        if (partBytes === null) {
            return failure(422, 'invalid-media');
        }
        calculatedHash = await digestReadable(
            bytesToReadable(partBytes),
            dependencies
        );
    } catch {
        return failure(503, 'service-unavailable');
    }

    if (calculatedHash !== suppliedHash) {
        return failure(422, 'invalid-media');
    }

    let detectedFormat = upload.detectedFormat;
    if (partNumber === 1) {
        detectedFormat = mediaPolicy.detectAllowedFileType(
            partBytes.subarray(0, 64)
        );
        if (!detectedFormat || detectedFormat !== expectedFormat(upload.fileExtension)) {
            const recorded = await failUpload(
                env,
                upload,
                ownerHash,
                'signature-mismatch',
                nowMilliseconds,
                { abortMultipart: true }
            );
            return recorded
                ? failure(422, 'invalid-media')
                : failure(503, 'service-unavailable');
        }
    }

    let multipart;
    let uploadedPart;
    try {
        multipart = env.PRIVATE_ORIGINALS.resumeMultipartUpload(
            upload.objectKey,
            upload.providerUploadId
        );
        uploadedPart = await multipart.uploadPart(partNumber, partBytes);
    } catch {
        return failure(503, 'service-unavailable');
    }

    if (
        uploadedPart?.partNumber !== partNumber ||
        !safeProviderValue(
            uploadedPart?.etag,
            MAX_PROVIDER_OBJECT_VALUE_LENGTH
        )
    ) {
        await failUpload(
            env,
            upload,
            ownerHash,
            'provider-error',
            nowMilliseconds,
            { abortMultipart: true }
        );
        return failure(503, 'service-unavailable');
    }

    const uploadedAt = isoTime(nowMilliseconds);
    try {
        await runBatch(env.DB, [
            env.DB.prepare(
                'INSERT INTO draft_upload_parts (' +
                'upload_session_id, part_number, provider_etag, byte_count, ' +
                'sha256, uploaded_at' +
                ') VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
            ).bind(
                upload.uploadSessionId,
                partNumber,
                uploadedPart.etag,
                expectedByteCount,
                calculatedHash,
                uploadedAt
            ),
            env.DB.prepare(
                'UPDATE draft_upload_sessions SET ' +
                'next_part_number = next_part_number + 1, ' +
                'uploaded_byte_count = uploaded_byte_count + ?1, ' +
                'detected_format = ?2, updated_at = ?3 ' +
                'WHERE upload_session_id = ?4 AND status = ?5 ' +
                'AND next_part_number = ?6 AND uploaded_byte_count = ?7'
            ).bind(
                expectedByteCount,
                detectedFormat,
                uploadedAt,
                upload.uploadSessionId,
                'active',
                partNumber,
                upload.uploadedByteCount
            )
        ]);
    } catch {
        return failure(409, 'conflict');
    }

    const refreshed = await readUploadBySessionId(
        env.DB,
        upload.uploadSessionId,
        ownerHash
    );
    if (!refreshed) {
        return failure(503, 'service-unavailable');
    }
    return success(201, {
        replayed: false,
        upload: await safeUploadStatus(env.DB, refreshed)
    });
}

export async function completePrivateUpload(
    env,
    identity,
    siteMode,
    draftId,
    input,
    catalogSnapshot,
    nowMilliseconds,
    dependencies = {}
) {
    const problems = validateCompleteUploadInput(input);
    if (
        !validSiteMode(siteMode) ||
        !ID_PATTERN.test(String(draftId || '')) ||
        problems.length
    ) {
        return failure(400, 'invalid-request', problems);
    }
    if (!hasDatabase(env) || !hasOriginalsBucket(env)) {
        return failure(503, 'service-unavailable');
    }

    const ownerHash = await hashIdentity(identity);
    let draftRow = await readDraftForUpload(
        env.DB,
        draftId,
        ownerHash,
        siteMode
    );
    if (!draftRow) {
        return failure(404, 'not-found');
    }
    const operationFingerprint = await fingerprint({
        operation: 'complete-private-upload',
        draftId,
        siteMode,
        expectedStateVersion: input.expectedStateVersion
    });
    const existingReceipt = await readTransitionReceipt(
        env.DB,
        draftId,
        input.idempotencyKey
    );
    if (existingReceipt) {
        if (existingReceipt.payloadFingerprint !== operationFingerprint) {
            return failure(409, 'conflict');
        }
        const completedDraft = await readDraftForUpload(
            env.DB,
            draftId,
            ownerHash,
            siteMode
        );
        if (
            completedDraft?.state !== 'private-review' ||
            completedDraft.stateVersion !== existingReceipt.resultStateVersion
        ) {
            return failure(409, 'conflict');
        }
        return success(200, {
            replayed: true,
            draft: safeCompletedDraft(completedDraft)
        });
    }

    if (
        draftRow.state !== 'uploading' ||
        draftRow.stateVersion !== input.expectedStateVersion
    ) {
        return failure(409, 'conflict');
    }
    const approvalProblems = await validateCurrentDraftApproval(
        env.DB,
        draftRow,
        catalogSnapshot
    );
    if (approvalProblems.length) {
        return failure(409, 'stale-or-blocked', approvalProblems);
    }

    let upload = await readCurrentUpload(env.DB, draftId, ownerHash);
    if (!upload || !['active', 'completing', 'complete'].includes(upload.status)) {
        return failure(409, 'invalid-state');
    }
    if (
        upload.status !== 'complete' &&
        incompleteUploadExpired(upload, nowMilliseconds)
    ) {
        return failure(409, 'invalid-state');
    }
    if (
        upload.itemRevision !== draftRow.itemRevision ||
        upload.consentRevision !== draftRow.activeConsentRevision ||
        upload.exportBundleId !== draftRow.exportBundleId ||
        upload.sourceRevision !== draftRow.sourceRevision ||
        upload.suppressionRevision !== draftRow.suppressionRevision
    ) {
        return failure(409, 'stale-or-blocked');
    }

    if (upload.status === 'active') {
        if (
            upload.nextPartNumber !== upload.partCount + 1 ||
            upload.uploadedByteCount !== upload.declaredByteCount
        ) {
            return failure(409, 'upload-incomplete');
        }
        const startedAt = isoTime(nowMilliseconds);
        try {
            const result = await env.DB.prepare(
                "UPDATE draft_upload_sessions SET status = 'completing', " +
                'completion_idempotency_key = ?1, completion_payload_fingerprint = ?2, ' +
                'completion_started_at = ?3, updated_at = ?3 ' +
                "WHERE upload_session_id = ?4 AND status = 'active' " +
                'AND next_part_number = part_count + 1 ' +
                'AND uploaded_byte_count = declared_byte_count'
            ).bind(
                input.idempotencyKey,
                operationFingerprint,
                startedAt,
                upload.uploadSessionId
            ).run();
            if (result?.success === false) {
                return failure(503, 'service-unavailable');
            }
        } catch {
            // A concurrent request may have claimed the same completion.
        }
        upload = await readUploadBySessionId(
            env.DB,
            upload.uploadSessionId,
            ownerHash
        );
        if (!upload) {
            return failure(503, 'service-unavailable');
        }
    }

    if (
        upload.completionIdempotencyKey !== input.idempotencyKey ||
        upload.completionPayloadFingerprint !== operationFingerprint
    ) {
        return failure(409, 'conflict');
    }

    const parts = await readAllUploadParts(env.DB, upload.uploadSessionId);
    if (!partsExactlyComplete(upload, parts)) {
        return failure(409, 'upload-incomplete');
    }

    let completedObject;
    try {
        completedObject = await env.PRIVATE_ORIGINALS.head(upload.objectKey);
        if (!completedObject) {
            const multipart = env.PRIVATE_ORIGINALS.resumeMultipartUpload(
                upload.objectKey,
                upload.providerUploadId
            );
            try {
                completedObject = await multipart.complete(parts.map(part => ({
                    partNumber: part.partNumber,
                    etag: part.providerEtag
                })));
            } catch {
                completedObject = await env.PRIVATE_ORIGINALS.head(upload.objectKey);
                if (!completedObject) {
                    throw new Error('Multipart completion failed.');
                }
            }
        }
    } catch {
        return failure(503, 'service-unavailable');
    }

    if (!completedObjectMatchesSession(completedObject, upload)) {
        const completionFailureCode = completedObject &&
            Number.isSafeInteger(completedObject.size) &&
            completedObject.size !== upload.declaredByteCount
            ? 'size-mismatch'
            : 'provider-error';
        const recorded = await failUpload(
            env,
            upload,
            ownerHash,
            completionFailureCode,
            nowMilliseconds,
            { deleteObject: true }
        );
        return recorded && completionFailureCode === 'size-mismatch'
            ? failure(422, 'invalid-media')
            : failure(503, 'service-unavailable');
    }

    let verified;
    try {
        const object = await env.PRIVATE_ORIGINALS.get(upload.objectKey, {
            onlyIf: { etagMatches: completedObject.etag }
        });
        if (
            !object ||
            object.body === undefined ||
            object.body === null ||
            object.etag !== completedObject.etag ||
            object.version !== completedObject.version ||
            object.size !== completedObject.size
        ) {
            throw new Error('Completed object changed during verification.');
        }
        verified = await hashAndInspectReadable(object.body, dependencies);
    } catch {
        return failure(503, 'service-unavailable');
    }

    const detectedFormat = mediaPolicy.detectAllowedFileType(
        Uint8Array.from(verified.prefix)
    );
    if (
        verified.byteCount !== upload.declaredByteCount ||
        detectedFormat !== expectedFormat(upload.fileExtension)
    ) {
        const recorded = await failUpload(
            env,
            upload,
            ownerHash,
            verified.byteCount !== upload.declaredByteCount
                ? 'size-mismatch'
                : 'signature-mismatch',
            nowMilliseconds,
            { deleteObject: true }
        );
        return recorded
            ? failure(422, 'invalid-media')
            : failure(503, 'service-unavailable');
    }

    const completedAt = isoTime(nowMilliseconds);
    const auditSubjectHash = await sha256Text(`draft:${draftId}`);
    try {
        await runBatch(env.DB, [
            env.DB.prepare(
                "UPDATE draft_upload_sessions SET status = 'complete', " +
                'completed_object_version = ?1, completed_etag = ?2, ' +
                'completed_sha256 = ?3, completed_at = ?4, updated_at = ?4 ' +
                "WHERE upload_session_id = ?5 AND status = 'completing' " +
                'AND completion_idempotency_key = ?6 ' +
                'AND completion_payload_fingerprint = ?7'
            ).bind(
                completedObject.version,
                completedObject.etag,
                verified.sha256,
                completedAt,
                upload.uploadSessionId,
                input.idempotencyKey,
                operationFingerprint
            ),
            env.DB.prepare(
                "UPDATE gallery_drafts SET state = 'private-review', " +
                'state_version = state_version + 1, original_detected_type = ?1, ' +
                'original_byte_count = ?2, original_sha256 = ?3, upload_complete = 1, ' +
                'updated_at = ?4 WHERE draft_id = ?5 AND state = ?6 ' +
                'AND state_version = ?7 AND item_revision = ?8 ' +
                'AND original_object_key = ?9 AND upload_complete = 0 ' +
                'AND site_modes_json = ?10'
            ).bind(
                detectedFormat,
                upload.declaredByteCount,
                verified.sha256,
                completedAt,
                draftId,
                'uploading',
                input.expectedStateVersion,
                upload.itemRevision,
                upload.objectKey,
                JSON.stringify([siteMode])
            ),
            env.DB.prepare(
                'INSERT INTO draft_transition_receipts (' +
                'draft_id, idempotency_key, payload_fingerprint, from_state, ' +
                'to_state, expected_state_version, result_state_version, created_at' +
                ') VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)'
            ).bind(
                draftId,
                input.idempotencyKey,
                operationFingerprint,
                'uploading',
                'private-review',
                input.expectedStateVersion,
                input.expectedStateVersion + 1,
                completedAt
            ),
            env.DB.prepare(
                'INSERT INTO gallery_audit_events (' +
                'audit_event_id, subject_reference_hash, event_type, state_version, ' +
                'actor_identity_hash, payload_hash, occurred_at' +
                ') VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)'
            ).bind(
                randomIdentifier('audit'),
                auditSubjectHash,
                'upload-verified',
                input.expectedStateVersion + 1,
                ownerHash,
                operationFingerprint,
                completedAt
            )
        ]);
    } catch {
        return failure(409, 'conflict');
    }

    draftRow = await readDraftForUpload(
        env.DB,
        draftId,
        ownerHash,
        siteMode
    );
    if (!draftRow) {
        return failure(503, 'service-unavailable');
    }
    return success(201, {
        replayed: false,
        draft: safeCompletedDraft(draftRow)
    });
}

export async function privateOriginalResponse(
    env,
    identity,
    siteMode,
    draftId,
    request
) {
    if (
        !validSiteMode(siteMode) ||
        !ID_PATTERN.test(String(draftId || '')) ||
        !['GET', 'HEAD'].includes(request.method) ||
        !hasDatabase(env) ||
        !hasOriginalsBucket(env)
    ) {
        return null;
    }
    const ownerHash = await hashIdentity(identity);
    const row = await readPreviewRecord(
        env.DB,
        draftId,
        ownerHash,
        siteMode
    );
    if (!row || !PREVIEWABLE_STATES.has(row.state)) {
        return null;
    }
    const contentType = PREVIEW_CONTENT_TYPES[row.detectedFormat];
    if (!contentType) {
        return null;
    }

    try {
        const head = await env.PRIVATE_ORIGINALS.head(row.objectKey);
        if (!previewObjectMatchesRecord(head, row)) {
            return null;
        }
        const rangeHeader = request.headers.get('Range');
        if (rangeHeader !== null) {
            const range = parseSingleRange(rangeHeader, head.size);
            if (!range) {
                return new Response(null, {
                    status: 416,
                    headers: privateMediaHeaders(contentType, 0, {
                        'Content-Range': `bytes */${head.size}`
                    })
                });
            }
            if (request.method === 'HEAD') {
                return new Response(null, {
                    status: 206,
                    headers: privateMediaHeaders(contentType, range.length, {
                        'Content-Range': `bytes ${range.offset}-${range.end}/${head.size}`
                    })
                });
            }
            const object = await env.PRIVATE_ORIGINALS.get(row.objectKey, {
                range: { offset: range.offset, length: range.length },
                onlyIf: { etagMatches: row.completedEtag }
            });
            if (!rangedPreviewObjectMatches(object, row, range)) {
                return null;
            }
            return new Response(object.body, {
                status: 206,
                headers: privateMediaHeaders(contentType, range.length, {
                    'Content-Range': `bytes ${range.offset}-${range.end}/${head.size}`
                })
            });
        }

        if (request.method === 'HEAD') {
            return new Response(null, {
                status: 200,
                headers: privateMediaHeaders(contentType, head.size)
            });
        }
        const object = await env.PRIVATE_ORIGINALS.get(row.objectKey, {
            onlyIf: { etagMatches: row.completedEtag }
        });
        if (!previewObjectMatchesRecord(object, row) || !object.body) {
            return null;
        }
        return new Response(object.body, {
            status: 200,
            headers: privateMediaHeaders(contentType, object.size)
        });
    } catch {
        return null;
    }
}

export async function cleanupExpiredPrivateUploads(
    env,
    nowMilliseconds,
    { execute = false } = {}
) {
    if (!hasDatabase(env) || !hasOriginalsBucket(env)) {
        return failure(503, 'service-unavailable');
    }
    const now = isoTime(nowMilliseconds);
    let rows;
    try {
        rows = await queryAll(env.DB,
            'SELECT upload_session_id AS uploadSessionId, draft_id AS draftId, ' +
            'provider_upload_id AS providerUploadId, object_key AS objectKey, status ' +
            'FROM draft_upload_sessions WHERE status IN (\'active\', \'completing\') ' +
            'AND expires_at <= ?1 ORDER BY expires_at, upload_session_id',
            now
        );
    } catch {
        return failure(503, 'service-unavailable');
    }
    if (!execute) {
        return success(200, {
            mode: 'dry-run',
            expiredDraftIds: rows.map(row => row.draftId)
        });
    }

    const completed = [];
    const cleanupActorHash = await sha256Text(
        'system:phase-c-private-upload-cleanup'
    );
    for (const row of rows) {
        try {
            const existingObject = await env.PRIVATE_ORIGINALS.head(row.objectKey);
            if (existingObject) {
                // A completed object must be reconciled by the normal completion
                // path; expiry must never delete it speculatively.
                continue;
            }
            let abortConfirmed = false;
            try {
                const multipart = env.PRIVATE_ORIGINALS.resumeMultipartUpload(
                    row.objectKey,
                    row.providerUploadId
                );
                await multipart.abort();
                abortConfirmed = true;
            } catch (error) {
                // R2 may already have applied its own lifecycle expiry. Only
                // the exact provider "missing upload" result is equivalent to
                // a successful abort; transient errors remain eligible for a
                // later cleanup retry.
                abortConfirmed = isMissingMultipartError(error);
            }
            if (!abortConfirmed) {
                continue;
            }
            // Check again after the abort. This closes the race in which a
            // completion finishes between the first HEAD and the abort call.
            if (await env.PRIVATE_ORIGINALS.head(row.objectKey)) {
                continue;
            }
            const subjectHash = await sha256Text(`draft:${row.draftId}`);
            const evidenceHash = await fingerprint({
                operation: 'private-upload-expired',
                draftId: row.draftId,
                uploadSessionId: row.uploadSessionId,
                previousStatus: row.status
            });
            await runBatch(env.DB, [
                env.DB.prepare(
                    "UPDATE draft_upload_sessions SET status = 'expired', " +
                    "failure_code = 'expired', updated_at = ?1 " +
                    'WHERE upload_session_id = ?2 AND status = ?3'
                ).bind(now, row.uploadSessionId, row.status),
                env.DB.prepare(
                    'INSERT INTO gallery_audit_events (' +
                    'audit_event_id, subject_reference_hash, event_type, state_version, ' +
                    'actor_identity_hash, payload_hash, occurred_at' +
                    ") VALUES (?1, ?2, CASE WHEN changes() = 1 THEN 'upload-expired' ELSE NULL END, " +
                    '?3, ?4, ?5, ?6)'
                ).bind(
                    randomIdentifier('audit'),
                    subjectHash,
                    null,
                    cleanupActorHash,
                    evidenceHash,
                    now
                ),
                env.DB.prepare(
                    'UPDATE gallery_drafts SET original_object_key = NULL, ' +
                    'original_detected_type = NULL, original_byte_count = NULL, ' +
                    'original_sha256 = NULL, upload_complete = 0, updated_at = ?1 ' +
                    'WHERE draft_id = ?2 AND original_object_key = ?3 ' +
                    'AND upload_complete = 0'
                ).bind(now, row.draftId, row.objectKey)
            ]);
            completed.push(row.draftId);
        } catch {
            // Leave the row observable for the next cleanup run.
        }
    }
    return success(200, { mode: 'execute', expiredDraftIds: completed });
}

function isMissingMultipartError(error) {
    return error?.name === 'NoSuchUpload' ||
        error?.code === 'NoSuchUpload' ||
        error?.message === 'NoSuchUpload';
}

function validateBeginUploadInput(input) {
    const problems = exactObjectProblems(input, BEGIN_UPLOAD_KEYS);
    if (!isPlainObject(input)) {
        return problems;
    }
    if (!Number.isSafeInteger(input.expectedStateVersion) || input.expectedStateVersion < 0) {
        problems.push('expectedStateVersion must be a non-negative integer.');
    }
    if (
        typeof input.fileName !== 'string' ||
        input.fileName.length > 255 ||
        !SYNTHETIC_FILE_PATTERN.test(input.fileName)
    ) {
        problems.push('Phase C accepts only a synthetic-* test filename in an approved media format.');
    }
    if (
        typeof input.declaredMimeType !== 'string' ||
        input.declaredMimeType !== input.declaredMimeType.toLowerCase() ||
        !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(input.declaredMimeType)
    ) {
        problems.push('declaredMimeType is invalid.');
    }
    if (!Number.isSafeInteger(input.byteLength) || input.byteLength <= 0) {
        problems.push('byteLength must be a positive integer.');
    }
    if (!IDEMPOTENCY_KEY_PATTERN.test(String(input.idempotencyKey || ''))) {
        problems.push('idempotencyKey is invalid.');
    }
    if (input.syntheticOnlyConfirmed !== true) {
        problems.push('Synthetic-only confirmation is required in Phase C.');
    }
    return problems;
}

function validateCompleteUploadInput(input) {
    const problems = exactObjectProblems(input, COMPLETE_UPLOAD_KEYS);
    if (!isPlainObject(input)) {
        return problems;
    }
    if (!Number.isSafeInteger(input.expectedStateVersion) || input.expectedStateVersion < 0) {
        problems.push('expectedStateVersion must be a non-negative integer.');
    }
    if (!IDEMPOTENCY_KEY_PATTERN.test(String(input.idempotencyKey || ''))) {
        problems.push('idempotencyKey is invalid.');
    }
    return problems;
}

function exactObjectProblems(value, expectedKeys) {
    if (!isPlainObject(value)) {
        return ['Request body must be a JSON object.'];
    }
    const keys = Object.keys(value);
    const problems = [];
    if (
        keys.length !== expectedKeys.size ||
        keys.some(key => !expectedKeys.has(key)) ||
        [...expectedKeys].some(key => !Object.hasOwn(value, key))
    ) {
        problems.push('Request body contains missing or unsupported fields.');
    }
    return problems;
}

function formatForUploadInput(input, mediaType) {
    const extension = extensionOf(input.fileName);
    const formatName = expectedFormat(extension);
    const format = mediaPolicy.inputFormats?.[formatName];
    return format &&
        format.mediaType === mediaType &&
        format.extensions.includes(extension) &&
        format.mimeTypes.includes(input.declaredMimeType)
        ? formatName
        : null;
}

async function validateCurrentDraftApproval(database, row, snapshot) {
    if (!validCatalogSnapshot(snapshot)) {
        return ['The current Gallery selector catalog is unavailable.'];
    }
    const pendingRows = await queryAll(database,
        'SELECT athlete_id AS athleteId FROM pending_athlete_exclusions ' +
        'WHERE resolved_at IS NULL ORDER BY athlete_id'
    );
    const draft = contractDraft(row);
    if (!draft) {
        return ['The private Gallery draft record is malformed.'];
    }
    return uploadContract.validateGalleryUploadApproval(draft, {
        consentRevision: row.activeConsentRevision,
        suppressionRevision: snapshot.suppressionRevision,
        suppressionDocument: snapshot.suppressionDocument,
        pendingHiddenAthleteIds: pendingRows.map(entry => entry.athleteId),
        siteCatalogs: Object.fromEntries(
            Object.entries(snapshot.sites).map(([site, siteSnapshot]) => [site, {
                exportBundleId: snapshot.exportBundleId,
                sourceRevision: snapshot.sourceRevision,
                races: siteSnapshot.catalog?.races,
                athleteIds: siteSnapshot.catalog?.athleteIds
            }])
        )
    });
}

function contractDraft(row) {
    try {
        return {
            schemaVersion: '1.0',
            draftId: row.draftId,
            state: row.state,
            stateVersion: row.stateVersion,
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
            manifestItem: null,
            consent: {
                publicUseConfirmed: row.publicUseConfirmed === 1,
                containsMinors: row.containsMinors === 1,
                guardianApprovalConfirmed: row.guardianApprovalConfirmed === 1,
                revision: row.activeConsentRevision
            },
            withdrawalEvidence: null
        };
    } catch {
        // Database CHECK constraints normally make this impossible. Returning a
        // closed validation failure still keeps a corrupted or mocked row from
        // turning into an unhandled Worker exception.
        return null;
    }
}

async function readDraftForUpload(database, draftId, ownerHash, siteMode) {
    return queryFirst(database,
        'SELECT draft.draft_id AS draftId, draft.public_item_id AS publicItemId, ' +
        'draft.state, draft.state_version AS stateVersion, ' +
        'draft.site_modes_json AS siteModesJson, ' +
        'draft.export_bundle_id AS exportBundleId, ' +
        'draft.source_revision AS sourceRevision, ' +
        'draft.suppression_revision AS suppressionRevision, ' +
        'draft.item_revision AS itemRevision, ' +
        'draft.active_consent_revision AS activeConsentRevision, ' +
        'draft.media_type AS mediaType, draft.race_date AS raceDate, ' +
        'draft.race_event AS raceEvent, draft.race_distance AS raceDistance, ' +
        'draft.athlete_ids_json AS athleteIdsJson, draft.title, draft.caption, ' +
        'draft.alt_text AS altText, draft.featured, draft.editorial_position AS editorialPosition, ' +
        'draft.original_object_key AS originalObjectKey, ' +
        'draft.original_detected_type AS originalDetectedType, ' +
        'draft.original_byte_count AS originalByteCount, ' +
        'draft.original_sha256 AS originalSha256, draft.upload_complete AS uploadComplete, ' +
        'consent.public_use_confirmed AS publicUseConfirmed, ' +
        'consent.contains_minors AS containsMinors, ' +
        'consent.guardian_approval_confirmed AS guardianApprovalConfirmed, ' +
        'consent.withdrawn_at AS consentWithdrawnAt ' +
        'FROM gallery_drafts AS draft ' +
        'LEFT JOIN draft_consent_attestations AS consent ' +
        'ON consent.draft_id = draft.draft_id ' +
        'AND consent.consent_revision = draft.active_consent_revision ' +
        'WHERE draft.draft_id = ?1 AND draft.verified_owner_identity_hash = ?2 ' +
        'AND draft.site_modes_json = ?3',
        draftId,
        ownerHash,
        JSON.stringify([siteMode])
    );
}

async function readUploadByIdempotency(database, draftId, key, ownerHash) {
    return queryFirst(database, uploadSelectSql(
        'session.draft_id = ?1 AND session.initiation_idempotency_key = ?2 ' +
        'AND session.verified_owner_identity_hash = ?3'
    ), draftId, key, ownerHash);
}

async function readUploadBySessionId(database, sessionId, ownerHash) {
    return queryFirst(database, uploadSelectSql(
        'session.upload_session_id = ?1 AND session.verified_owner_identity_hash = ?2'
    ), sessionId, ownerHash);
}

async function readCurrentUpload(database, draftId, ownerHash) {
    return queryFirst(database, uploadSelectSql(
        "session.draft_id = ?1 AND session.verified_owner_identity_hash = ?2 " +
        "AND session.status IN ('active', 'completing', 'complete') " +
        'ORDER BY session.created_at DESC, session.upload_session_id DESC LIMIT 1'
    ), draftId, ownerHash);
}

async function readLatestUpload(database, draftId, ownerHash) {
    return queryFirst(database, uploadSelectSql(
        'session.draft_id = ?1 AND session.verified_owner_identity_hash = ?2 ' +
        'ORDER BY session.created_at DESC, session.upload_session_id DESC LIMIT 1'
    ), draftId, ownerHash);
}

function uploadSelectSql(whereClause) {
    return 'SELECT session.upload_session_id AS uploadSessionId, ' +
        'session.draft_id AS draftId, session.item_revision AS itemRevision, ' +
        'session.consent_revision AS consentRevision, ' +
        'session.export_bundle_id AS exportBundleId, ' +
        'session.source_revision AS sourceRevision, ' +
        'session.suppression_revision AS suppressionRevision, ' +
        'session.provider_upload_id AS providerUploadId, session.object_key AS objectKey, ' +
        'session.file_extension AS fileExtension, ' +
        'session.declared_content_type AS declaredContentType, ' +
        'session.declared_byte_count AS declaredByteCount, ' +
        'session.part_size AS partSize, session.part_count AS partCount, ' +
        'session.next_part_number AS nextPartNumber, ' +
        'session.uploaded_byte_count AS uploadedByteCount, ' +
        'session.detected_format AS detectedFormat, session.status, ' +
        'session.completed_object_version AS completedObjectVersion, ' +
        'session.completed_etag AS completedEtag, ' +
        'session.completed_sha256 AS completedSha256, ' +
        'session.failure_code AS failureCode, ' +
        'session.initiation_payload_fingerprint AS initiationPayloadFingerprint, ' +
        'session.completion_idempotency_key AS completionIdempotencyKey, ' +
        'session.completion_payload_fingerprint AS completionPayloadFingerprint, ' +
        'session.created_at AS createdAt, session.updated_at AS updatedAt, ' +
        'session.expires_at AS expiresAt, session.completed_at AS completedAt ' +
        'FROM draft_upload_sessions AS session WHERE ' + whereClause;
}

async function readUploadPart(database, sessionId, partNumber) {
    return queryFirst(database,
        'SELECT part_number AS partNumber, byte_count AS byteCount, sha256 ' +
        'FROM draft_upload_parts WHERE upload_session_id = ?1 AND part_number = ?2',
        sessionId,
        partNumber
    );
}

async function readAllUploadParts(database, sessionId) {
    return queryAll(database,
        'SELECT part_number AS partNumber, provider_etag AS providerEtag, ' +
        'byte_count AS byteCount, sha256 FROM draft_upload_parts ' +
        'WHERE upload_session_id = ?1 ORDER BY part_number',
        sessionId
    );
}

async function readTransitionReceipt(database, draftId, key) {
    return queryFirst(database,
        'SELECT payload_fingerprint AS payloadFingerprint, ' +
        'result_state_version AS resultStateVersion ' +
        'FROM draft_transition_receipts WHERE draft_id = ?1 AND idempotency_key = ?2',
        draftId,
        key
    );
}

async function readPreviewRecord(database, draftId, ownerHash, siteMode) {
    return queryFirst(database,
        'SELECT draft.state, session.object_key AS objectKey, ' +
        'session.detected_format AS detectedFormat, ' +
        'session.declared_byte_count AS byteCount, ' +
        'session.completed_object_version AS completedObjectVersion, ' +
        'session.completed_etag AS completedEtag ' +
        'FROM gallery_drafts AS draft JOIN draft_upload_sessions AS session ' +
        'ON session.draft_id = draft.draft_id ' +
        'WHERE draft.draft_id = ?1 AND draft.verified_owner_identity_hash = ?2 ' +
        'AND draft.site_modes_json = ?3 ' +
        "AND draft.upload_complete = 1 AND session.status = 'complete' " +
        'AND session.object_key = draft.original_object_key LIMIT 1',
        draftId,
        ownerHash,
        JSON.stringify([siteMode])
    );
}

async function safeUploadStatus(database, upload) {
    const parts = await queryAll(database,
        'SELECT part_number AS partNumber, byte_count AS byteCount, sha256 ' +
        'FROM draft_upload_parts WHERE upload_session_id = ?1 ORDER BY part_number',
        upload.uploadSessionId
    );
    return {
        status: upload.status,
        expectedByteCount: upload.declaredByteCount,
        declaredContentType: upload.declaredContentType,
        partSize: upload.partSize,
        partCount: upload.partCount,
        nextPartNumber: upload.nextPartNumber,
        uploadedByteCount: upload.uploadedByteCount,
        uploadedParts: parts,
        expiresAt: upload.expiresAt,
        completedSha256: upload.status === 'complete'
            ? upload.completedSha256
            : null
    };
}

function safeCompletedDraft(row) {
    return {
        draftId: row.draftId,
        state: row.state,
        stateVersion: row.stateVersion,
        itemRevision: row.itemRevision,
        mediaType: row.mediaType,
        uploadComplete: row.uploadComplete === 1,
        originalByteCount: row.originalByteCount,
        originalSha256: row.originalSha256,
        originalDetectedType: row.originalDetectedType
    };
}

async function failUpload(
    env,
    upload,
    ownerHash,
    code,
    nowMilliseconds,
    options = {}
) {
    if (options.abortMultipart) {
        try {
            const multipart = env.PRIVATE_ORIGINALS.resumeMultipartUpload(
                upload.objectKey,
                upload.providerUploadId
            );
            await multipart.abort();
        } catch (error) {
            // Do not call the D1 row terminal while an incomplete provider
            // upload may still exist. The exact missing-upload response is the
            // one safe idempotent equivalent of a successful abort.
            if (!isMissingMultipartError(error)) {
                return false;
            }
        }
    }
    if (options.deleteObject) {
        try {
            await env.PRIVATE_ORIGINALS.delete(upload.objectKey);
            if (await env.PRIVATE_ORIGINALS.head(upload.objectKey)) {
                return false;
            }
        } catch {
            return false;
        }
    }
    const occurredAt = isoTime(nowMilliseconds);
    const subjectHash = await sha256Text(`draft:${upload.draftId}`);
    const evidenceHash = await fingerprint({
        operation: 'private-upload-failed',
        draftId: upload.draftId,
        uploadSessionId: upload.uploadSessionId,
        code
    });
    try {
        await runBatch(env.DB, [
            env.DB.prepare(
                "UPDATE draft_upload_sessions SET status = 'failed', " +
                'failure_code = ?1, updated_at = ?2 ' +
                "WHERE upload_session_id = ?3 AND status IN ('active', 'completing')"
            ).bind(code, occurredAt, upload.uploadSessionId),
            env.DB.prepare(
                'INSERT INTO gallery_audit_events (' +
                'audit_event_id, subject_reference_hash, event_type, state_version, ' +
                'actor_identity_hash, payload_hash, occurred_at' +
                ") VALUES (?1, ?2, CASE WHEN changes() = 1 THEN 'upload-failed' ELSE NULL END, " +
                '?3, ?4, ?5, ?6)'
            ).bind(
                randomIdentifier('audit'),
                subjectHash,
                null,
                ownerHash,
                evidenceHash,
                occurredAt
            ),
            env.DB.prepare(
                'UPDATE gallery_drafts SET original_object_key = NULL, ' +
                'original_detected_type = NULL, original_byte_count = NULL, ' +
                'original_sha256 = NULL, upload_complete = 0, updated_at = ?1 ' +
                'WHERE draft_id = ?2 AND state = ?3 AND original_object_key = ?4'
            ).bind(occurredAt, upload.draftId, 'uploading', upload.objectKey)
        ]);
        return true;
    } catch {
        return false;
    }
}

function countingCaptureStream(capture, maximumBytes) {
    return new TransformStream({
        transform(chunk, controller) {
            const view = chunk instanceof Uint8Array
                ? chunk
                : new Uint8Array(chunk);
            capture.byteCount += view.byteLength;
            if (capture.byteCount > maximumBytes) {
                throw new Error('Upload part exceeds its expected size.');
            }
            const remaining = 64 - capture.prefix.length;
            if (remaining > 0) {
                capture.prefix.push(...view.subarray(0, remaining));
            }
            controller.enqueue(view);
        }
    });
}

async function readExactPartBytes(stream, expectedByteCount) {
    if (
        !Number.isSafeInteger(expectedByteCount) ||
        expectedByteCount < 1 ||
        expectedByteCount > PART_SIZE
    ) {
        throw new Error('Upload part size is outside the bounded read contract.');
    }

    const bytes = new Uint8Array(expectedByteCount);
    const reader = stream.getReader();
    let offset = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                return offset === expectedByteCount ? bytes : null;
            }
            const chunk = value instanceof Uint8Array
                ? value
                : new Uint8Array(value);
            if (offset + chunk.byteLength > expectedByteCount) {
                try {
                    await reader.cancel('Upload part exceeds its expected size.');
                } catch {
                    // The size failure is already decisive. A request-stream
                    // cancellation error must not turn it into an R2 attempt.
                }
                return null;
            }
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
    } finally {
        reader.releaseLock();
    }
}

function bytesToReadable(bytes) {
    return new ReadableStream({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        }
    });
}

async function hashAndInspectReadable(stream, dependencies) {
    const capture = { byteCount: 0, prefix: [] };
    const checked = stream.pipeThrough(countingCaptureStream(
        capture,
        Number.MAX_SAFE_INTEGER
    ));
    return {
        sha256: await digestReadable(checked, dependencies),
        byteCount: capture.byteCount,
        prefix: capture.prefix
    };
}

async function digestReadable(stream, dependencies) {
    if (typeof dependencies.digestReadable === 'function') {
        const value = await dependencies.digestReadable(stream);
        if (!SHA256_PATTERN.test(String(value || ''))) {
            throw new Error('Injected digest is invalid.');
        }
        return value;
    }
    if (typeof crypto?.DigestStream !== 'function') {
        throw new Error('Streaming digest is unavailable.');
    }
    const digestStream = new crypto.DigestStream('SHA-256');
    await stream.pipeTo(digestStream);
    return hexBytes(new Uint8Array(await digestStream.digest));
}

function expectedPartByteCount(upload, partNumber) {
    if (partNumber < 1 || partNumber > upload.partCount) {
        return null;
    }
    return partNumber < upload.partCount
        ? upload.partSize
        : upload.declaredByteCount - (upload.partSize * (upload.partCount - 1));
}

function partsExactlyComplete(upload, parts) {
    if (parts.length !== upload.partCount) {
        return false;
    }
    let total = 0;
    for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        if (
            part.partNumber !== index + 1 ||
            part.byteCount !== expectedPartByteCount(upload, part.partNumber) ||
            !SHA256_PATTERN.test(part.sha256) ||
            !safeProviderValue(
                part.providerEtag,
                MAX_PROVIDER_OBJECT_VALUE_LENGTH
            )
        ) {
            return false;
        }
        total += part.byteCount;
    }
    return total === upload.declaredByteCount;
}

function completedObjectMatchesSession(object, upload) {
    return object &&
        object.size === upload.declaredByteCount &&
        safeProviderValue(
            object.version,
            MAX_PROVIDER_OBJECT_VALUE_LENGTH
        ) &&
        safeProviderValue(
            object.etag,
            MAX_PROVIDER_OBJECT_VALUE_LENGTH
        );
}

function previewObjectMatchesRecord(object, row) {
    return object &&
        object.body !== null &&
        object.size === row.byteCount &&
        object.version === row.completedObjectVersion &&
        object.etag === row.completedEtag;
}

function rangedPreviewObjectMatches(object, row, range) {
    return previewObjectMatchesRecord(object, row) &&
        object.body !== undefined &&
        object.range?.offset === range.offset &&
        object.range?.length === range.length;
}

function parseSingleRange(value, totalSize) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(value);
    if (!match || (!match[1] && !match[2]) || totalSize <= 0) {
        return null;
    }
    if (!match[1]) {
        const suffix = safeIntegerText(match[2]);
        if (suffix === null || suffix === 0) {
            return null;
        }
        const length = Math.min(suffix, totalSize);
        return { offset: totalSize - length, length, end: totalSize - 1 };
    }
    const offset = safeIntegerText(match[1]);
    const requestedEnd = match[2]
        ? safeIntegerText(match[2])
        : totalSize - 1;
    if (
        offset === null ||
        requestedEnd === null ||
        offset >= totalSize ||
        requestedEnd < offset
    ) {
        return null;
    }
    const end = Math.min(requestedEnd, totalSize - 1);
    return { offset, length: end - offset + 1, end };
}

function privateMediaHeaders(contentType, length, extra = {}) {
    const headers = new Headers({
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Content-Disposition': 'inline',
        'Content-Length': String(length),
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
        'Content-Type': contentType,
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex, nofollow, noarchive'
    });
    for (const [name, value] of Object.entries(extra)) {
        headers.set(name, value);
    }
    return headers;
}

async function runBatch(database, statements) {
    const results = await database.batch(statements);
    if (
        !Array.isArray(results) ||
        results.length !== statements.length ||
        results.some(result => result?.success === false)
    ) {
        throw new Error('D1 batch failed.');
    }
    return results;
}

async function queryFirst(database, sql, ...bindings) {
    const statement = database.prepare(sql).bind(...bindings);
    if (typeof statement.first !== 'function') {
        throw new Error('D1 first() is unavailable.');
    }
    return statement.first();
}

async function queryAll(database, sql, ...bindings) {
    const statement = database.prepare(sql).bind(...bindings);
    if (typeof statement.all !== 'function') {
        throw new Error('D1 all() is unavailable.');
    }
    const result = await statement.all();
    return Array.isArray(result?.results) ? result.results : [];
}

function validCatalogSnapshot(snapshot) {
    return isPlainObject(snapshot) &&
        snapshot.schemaVersion === '1.0' &&
        typeof snapshot.exportBundleId === 'string' &&
        typeof snapshot.sourceRevision === 'string' &&
        typeof snapshot.suppressionRevision === 'string' &&
        isPlainObject(snapshot.suppressionDocument) &&
        isPlainObject(snapshot.sites) &&
        isPlainObject(snapshot.sites.family) &&
        isPlainObject(snapshot.sites.everyone);
}

function validSiteMode(siteMode) {
    return SITE_MODES.has(siteMode);
}

function hasDatabase(env) {
    return env?.DB &&
        typeof env.DB.prepare === 'function' &&
        typeof env.DB.batch === 'function';
}

function hasOriginalsBucket(env) {
    return env?.PRIVATE_ORIGINALS &&
        typeof env.PRIVATE_ORIGINALS.createMultipartUpload === 'function' &&
        typeof env.PRIVATE_ORIGINALS.resumeMultipartUpload === 'function' &&
        typeof env.PRIVATE_ORIGINALS.head === 'function' &&
        typeof env.PRIVATE_ORIGINALS.get === 'function' &&
        typeof env.PRIVATE_ORIGINALS.delete === 'function';
}

function privateObjectKey(draftId, extension) {
    return `private-originals/phase-c/${draftId}/${crypto.randomUUID()}.${extension}`;
}

function randomIdentifier(prefix) {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

function expectedFormat(extension) {
    return FORMAT_BY_EXTENSION[extension] || null;
}

function extensionOf(fileName) {
    const match = typeof fileName === 'string'
        ? /\.([A-Za-z0-9]+)$/.exec(fileName)
        : null;
    return match ? match[1].toLowerCase() : '';
}

function safeProviderValue(value, maximumLength) {
    return typeof value === 'string' &&
        Number.isSafeInteger(maximumLength) &&
        value.length <= maximumLength &&
        SAFE_PROVIDER_VALUE_PATTERN.test(value);
}

function placeholders(count) {
    return Array.from({ length: count }, (_, index) => `?${index + 1}`).join(', ');
}

function safeIntegerText(value) {
    if (!/^\d{1,16}$/.test(String(value || ''))) {
        return null;
    }
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : null;
}

function safeNow(value) {
    return Number.isFinite(value) ? value : Date.now();
}

function incompleteUploadExpired(upload, nowMilliseconds) {
    const expiresAt = typeof upload?.expiresAt === 'string'
        ? Date.parse(upload.expiresAt)
        : Number.NaN;
    return !Number.isFinite(expiresAt) || expiresAt <= safeNow(nowMilliseconds);
}

function isoTime(value) {
    return new Date(safeNow(value)).toISOString();
}

async function fingerprint(value) {
    return sha256Text(canonicalJson(value));
}

async function sha256Text(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return hexBytes(new Uint8Array(digest));
}

function hexBytes(bytes) {
    return [...bytes]
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
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

function isPlainObject(value) {
    return value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype;
}

async function bestEffortAbort(upload) {
    try {
        if (upload && typeof upload.abort === 'function') {
            await upload.abort();
        }
    } catch {
        // The caller records no D1 session, so provider expiry remains the
        // final fallback for an otherwise unreachable orphan.
    }
}

function success(status, body) {
    return { ok: true, status, ...body };
}

function failure(status, code, details = undefined) {
    const result = { ok: false, status, code };
    if (Array.isArray(details) && details.length) {
        result.details = details;
    }
    return result;
}
