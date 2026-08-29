import '../../gallery-contract.js';
import '../../gallery-upload-contract.js';

import catalogSnapshot from '../generated/catalog-snapshot.js';
import toolchainContract from '../../scripts/gallery-media-toolchain.json' with { type: 'json' };

import { hashIdentity } from './session.js';
import {
    buildV1StagingDerivativeKey,
    privateOriginalKeyMatchesRecord
} from './storage-keys.js';

const uploadContract = globalThis.galleryUploadContract;
const textEncoder = new TextEncoder();
const START_KEYS = Object.freeze(['expectedStateVersion', 'idempotencyKey']);
const RETRY_KEYS = Object.freeze(['expectedStateVersion', 'idempotencyKey']);
const CLEANUP_KEYS = Object.freeze(['expectedStateVersion', 'idempotencyKey']);
const STAGED_RESULT_KEYS = Object.freeze([
    'outcome',
    'expectedStateVersion',
    'idempotencyKey',
    'source',
    'toolchain',
    'derivatives'
]);
const FAILED_RESULT_KEYS = Object.freeze([
    'outcome',
    'expectedStateVersion',
    'idempotencyKey',
    'errorCode'
]);
const RESULT_SOURCE_KEYS = Object.freeze(['sha256', 'byteLength', 'detectedFormat']);
const RESULT_TOOLCHAIN_KEYS = Object.freeze([
    'sharp',
    'libvips',
    'webp',
    'png',
    'exiftool',
    'videoEnabled'
]);
const RESULT_DERIVATIVE_KEYS = Object.freeze([
    'role',
    'sha256',
    'byteLength',
    'width',
    'height',
    'durationMilliseconds',
    'metadataEntryCount',
    'metadataFindingCategories'
]);
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const DRAFT_ID_PATTERN = /^draft_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const RUN_ID_PATTERN = /^run_[a-f0-9]{12}4[a-f0-9]{3}[89ab][a-f0-9]{15}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PROVIDER_UPLOAD_ID_MAXIMUM_LENGTH = 512;
const REQUIRED_ROLES = Object.freeze(['photo-display', 'photo-thumbnail']);
const REQUIRED_ROLE_SET = new Set(REQUIRED_ROLES);
const ROLE_LIMITS = Object.freeze({
    'photo-display': Object.freeze({ maximumBytes: 25 * 1024 * 1024, maximumLongEdge: 1600 }),
    'photo-thumbnail': Object.freeze({ maximumBytes: 5 * 1024 * 1024, maximumLongEdge: 480 })
});
const FAILURE_CODES = new Set([
    'cleanup-failed',
    'derivative-rejected',
    'invalid-media',
    'metadata-scan-failed',
    'processing-failed',
    'source-rejected',
    'toolchain-unavailable'
]);
const ORIGINAL_CONTENT_TYPES = Object.freeze({
    jpeg: 'image/jpeg',
    png: 'image/png'
});

const DRAFT_EVIDENCE_SELECT = `
SELECT
    draft.draft_id AS draftId,
    draft.public_item_id AS publicItemId,
    draft.state,
    draft.state_version AS stateVersion,
    draft.processing_diagnostics_json AS processingDiagnosticsJson,
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
    draft.upload_complete AS uploadComplete,
    draft.original_object_key AS originalObjectKey,
    draft.original_detected_type AS originalDetectedType,
    draft.original_byte_count AS originalByteCount,
    draft.original_sha256 AS originalSha256,
    consent.consent_revision AS consentRevision,
    consent.public_use_confirmed AS publicUseConfirmed,
    consent.contains_minors AS containsMinors,
    consent.guardian_approval_confirmed AS guardianApprovalConfirmed,
    consent.withdrawn_at AS consentWithdrawnAt,
    upload.upload_session_id AS uploadSessionId,
    upload.item_revision AS uploadItemRevision,
    upload.consent_revision AS uploadConsentRevision,
    upload.export_bundle_id AS uploadExportBundleId,
    upload.source_revision AS uploadSourceRevision,
    upload.suppression_revision AS uploadSuppressionRevision,
    upload.object_key AS uploadObjectKey,
    upload.file_extension AS uploadFileExtension,
    upload.declared_content_type AS originalDeclaredContentType,
    upload.declared_byte_count AS uploadByteCount,
    upload.detected_format AS uploadDetectedFormat,
    upload.status AS uploadStatus,
    upload.completed_object_version AS originalObjectVersion,
    upload.completed_etag AS originalEtag,
    upload.completed_sha256 AS uploadSha256,
    upload.synthetic_only_confirmed AS syntheticOnlyConfirmed,
    upload.created_at AS uploadedAt,
    (SELECT COUNT(*) FROM draft_derivatives AS derivative
        WHERE derivative.draft_id = draft.draft_id) AS existingDerivativeCount
FROM gallery_drafts AS draft
JOIN draft_consent_attestations AS consent
  ON consent.draft_id = draft.draft_id
 AND consent.consent_revision = draft.active_consent_revision
JOIN draft_upload_sessions AS upload
  ON upload.draft_id = draft.draft_id
 AND upload.object_key = draft.original_object_key`;

const RUN_SELECT = `
SELECT
    run.processing_run_id AS processingRunId,
    run.draft_id AS draftId,
    run.site_mode AS runSiteMode,
    run.media_type AS runMediaType,
    run.item_revision AS runItemRevision,
    run.consent_revision AS runConsentRevision,
    run.export_bundle_id AS runExportBundleId,
    run.source_revision AS runSourceRevision,
    run.suppression_revision AS runSuppressionRevision,
    run.upload_session_id AS runUploadSessionId,
    run.original_object_key AS runOriginalObjectKey,
    run.original_detected_type AS runOriginalDetectedType,
    run.original_declared_content_type AS runOriginalDeclaredContentType,
    run.original_byte_count AS runOriginalByteCount,
    run.original_sha256 AS runOriginalSha256,
    run.original_object_version AS runOriginalObjectVersion,
    run.original_etag AS runOriginalEtag,
    run.start_expected_state_version AS startExpectedStateVersion,
    run.processing_state_version AS processingStateVersion,
    run.start_idempotency_key AS startIdempotencyKey,
    run.start_payload_fingerprint AS startPayloadFingerprint,
    run.status AS runStatus,
    run.result_idempotency_key AS resultIdempotencyKey,
    run.result_payload_fingerprint AS resultPayloadFingerprint,
    run.result_toolchain_json AS resultToolchainJson,
    run.failure_code AS failureCode,
    run.created_at AS runCreatedAt,
    run.updated_at AS runUpdatedAt,
    run.completed_at AS runCompletedAt,
    evidence.*
FROM draft_processing_runs AS run
JOIN (${DRAFT_EVIDENCE_SELECT}) AS evidence ON evidence.draftId = run.draft_id`;

export async function startProcessingRun(env, identity, draftId, input, nowMilliseconds) {
    if (
        !hasProcessingBindings(env) ||
        !validServiceIdentity(identity) ||
        !DRAFT_ID_PATTERN.test(draftId || '') ||
        !isExactObject(input, START_KEYS) ||
        !Number.isSafeInteger(input.expectedStateVersion) ||
        input.expectedStateVersion < 0 ||
        !IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey || '')
    ) {
        return failure(400, 'invalid-request');
    }

    const startFingerprint = await fingerprint({
        operation: 'processing-start',
        draftId,
        expectedStateVersion: input.expectedStateVersion,
        idempotencyKey: input.idempotencyKey
    });

    try {
        const existing = await readStartReplay(env.DB, draftId, input.idempotencyKey);
        if (existing) {
            if (await processingCleanupExists(env.DB, existing.processingRunId)) {
                return failure(409, 'processing-not-eligible');
            }
            return startReplay(existing, startFingerprint, input);
        }

        const draft = await readDraftEvidence(env.DB, draftId);
        const problems = await processingEligibilityProblems(draft, {
            requiredState: 'approved-for-processing',
            expectedStateVersion: input.expectedStateVersion
        }, env.DB);
        if (problems.length > 0) {
            return failure(409, 'processing-not-eligible');
        }

        const [siteMode] = JSON.parse(draft.siteModesJson);
        const processingRunId = randomIdentifier('run');
        const processingStateVersion = input.expectedStateVersion + 1;
        const occurredAt = isoTime(nowMilliseconds);
        const actorIdentityHash = await hashIdentity(identity);
        const subjectHash = await sha256Text(`draft:${draftId}`);

        await runBatch(env.DB, [
            env.DB.prepare(
                "UPDATE gallery_drafts SET state = 'processing', " +
                'state_version = state_version + 1, updated_at = ?1 ' +
                "WHERE draft_id = ?2 AND state = 'approved-for-processing' " +
                'AND state_version = ?3 AND item_revision = ?4 ' +
                'AND active_consent_revision = ?5 AND export_bundle_id = ?6 ' +
                'AND source_revision = ?7 AND suppression_revision = ?8'
            ).bind(
                occurredAt,
                draftId,
                input.expectedStateVersion,
                draft.itemRevision,
                draft.consentRevision,
                draft.exportBundleId,
                draft.sourceRevision,
                draft.suppressionRevision
            ),
            env.DB.prepare(`
                INSERT INTO draft_processing_runs (
                    processing_run_id, draft_id, site_mode, media_type,
                    item_revision, consent_revision, export_bundle_id,
                    source_revision, suppression_revision, upload_session_id,
                    original_object_key, original_detected_type,
                    original_declared_content_type, original_byte_count,
                    original_sha256, original_object_version, original_etag,
                    start_expected_state_version, processing_state_version,
                    start_idempotency_key, start_payload_fingerprint,
                    service_actor_identity_hash, status, created_at, updated_at
                ) VALUES (
                    ?1, ?2, ?3, 'photo', ?4, ?5, ?6, ?7, ?8, ?9,
                    ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18,
                    ?19, ?20, ?21, 'active', ?22, ?22
                )
            `).bind(
                processingRunId,
                draftId,
                siteMode,
                draft.itemRevision,
                draft.consentRevision,
                draft.exportBundleId,
                draft.sourceRevision,
                draft.suppressionRevision,
                draft.uploadSessionId,
                draft.originalObjectKey,
                draft.originalDetectedType,
                draft.originalDeclaredContentType,
                draft.originalByteCount,
                draft.originalSha256,
                draft.originalObjectVersion,
                draft.originalEtag,
                input.expectedStateVersion,
                processingStateVersion,
                input.idempotencyKey,
                startFingerprint,
                actorIdentityHash,
                occurredAt
            ),
            env.DB.prepare(`
                INSERT INTO draft_transition_receipts (
                    draft_id, idempotency_key, payload_fingerprint,
                    from_state, to_state, expected_state_version,
                    result_state_version, created_at
                ) VALUES (
                    ?1, ?2, ?3, 'approved-for-processing', 'processing', ?4, ?5, ?6
                )
            `).bind(
                draftId,
                input.idempotencyKey,
                startFingerprint,
                input.expectedStateVersion,
                processingStateVersion,
                occurredAt
            ),
            auditInsert(env.DB, {
                eventType: 'processing-started',
                subjectHash,
                actorIdentityHash,
                payloadHash: startFingerprint,
                stateVersion: processingStateVersion,
                occurredAt
            })
        ]);

        const created = await readRun(env.DB, processingRunId);
        if (!created || created.runStatus !== 'active') {
            throw new Error('Processing run creation was not durable.');
        }
        return startSuccess(created, false, 201);
    } catch {
        try {
            const replay = await readStartReplay(env.DB, draftId, input.idempotencyKey);
            if (!replay) {
                return failure(503, 'service-unavailable');
            }
            return await processingCleanupExists(env.DB, replay.processingRunId)
                ? failure(409, 'processing-not-eligible')
                : startReplay(replay, startFingerprint, input);
        } catch {
            return failure(503, 'service-unavailable');
        }
    }
}

export async function processingOriginalResponse(env, processingRunId) {
    if (!hasProcessingBindings(env) || !RUN_ID_PATTERN.test(processingRunId || '')) {
        return null;
    }

    try {
        const run = await readRun(env.DB, processingRunId);
        const problems = await processingEligibilityProblems(run, {
            requiredState: 'processing',
            expectedStateVersion: run?.processingStateVersion,
            requiredRunStatus: 'active'
        }, env.DB);
        if (problems.length > 0 || !runMatchesEvidence(run)) {
            return null;
        }

        const head = await env.PRIVATE_ORIGINALS.head(run.runOriginalObjectKey);
        if (!objectMatchesOriginal(head, run)) {
            return null;
        }
        const object = await env.PRIVATE_ORIGINALS.get(run.runOriginalObjectKey, {
            onlyIf: { etagMatches: run.runOriginalEtag }
        });
        if (!objectMatchesOriginal(object, run) || object.body === null || object.body === undefined) {
            return null;
        }
        const bytes = await readBodyBytes(object.body, run.runOriginalByteCount);
        if (
            bytes.byteLength !== run.runOriginalByteCount ||
            await sha256Hex(bytes) !== run.runOriginalSha256
        ) {
            return null;
        }

        // The R2 read can take long enough for consent or an athlete-wide
        // exclusion to change. Re-read D1 after the complete body is buffered
        // so revoked evidence never leaves this service.
        const finalRun = await readRun(env.DB, processingRunId);
        const finalProblems = await processingEligibilityProblems(finalRun, {
            requiredState: 'processing',
            expectedStateVersion: run.processingStateVersion,
            requiredRunStatus: 'active'
        }, env.DB);
        if (finalProblems.length > 0 || !runMatchesEvidence(finalRun)) {
            return null;
        }

        const headers = privateByteHeaders(
            run.runOriginalDeclaredContentType,
            bytes.byteLength
        );
        headers.set('Content-Disposition', 'attachment');
        headers.set('Content-Digest', `sha-256=:${hexToBase64(run.runOriginalSha256)}:`);
        headers.set('X-Gallery-Content-SHA256', run.runOriginalSha256);
        return new Response(bytes, { status: 200, headers });
    } catch {
        return null;
    }
}

export async function retryProcessingRun(
    env,
    identity,
    processingRunId,
    input,
    nowMilliseconds
) {
    if (
        !hasProcessingBindings(env) ||
        !validServiceIdentity(identity) ||
        !RUN_ID_PATTERN.test(processingRunId || '') ||
        !isExactObject(input, RETRY_KEYS) ||
        !Number.isSafeInteger(input.expectedStateVersion) ||
        input.expectedStateVersion < 0 ||
        !IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey || '')
    ) {
        return failure(400, 'invalid-request');
    }

    const payloadFingerprint = await fingerprint({
        operation: 'processing-retry',
        processingRunId,
        expectedStateVersion: input.expectedStateVersion,
        idempotencyKey: input.idempotencyKey
    });

    try {
        const runIdentity = await readRunIdentity(env.DB, processingRunId);
        if (!runIdentity) {
            return failure(404, 'not-found');
        }
        const subjectHash = await sha256Text(`draft:${runIdentity.draftId}`);

        const replay = await processingRetryReplay(
            env.DB,
            runIdentity,
            input,
            payloadFingerprint,
            subjectHash
        );
        if (replay) {
            return replay;
        }

        const actorIdentityHash = await hashIdentity(identity);

        const run = await readRun(env.DB, processingRunId);
        const cleanupProof = await readRetryCleanupProof(env.DB, processingRunId);
        if (!await failedRunIsRetryEligible(run, cleanupProof, input, env.DB)) {
            return failure(409, 'processing-not-eligible');
        }

        const occurredAt = isoTime(nowMilliseconds);
        const expectedDiagnostics = JSON.stringify({
            schemaVersion: '1.0',
            code: run.failureCode
        });

        await runBatch(env.DB, [
            retryDraftCasStatement(env.DB, {
                run,
                cleanupProof,
                input,
                expectedDiagnostics,
                occurredAt
            }),
            env.DB.prepare(`
                INSERT INTO draft_transition_receipts (
                    draft_id, idempotency_key, payload_fingerprint,
                    from_state, to_state, expected_state_version,
                    result_state_version, created_at
                ) VALUES (
                    ?1, ?2, ?3, 'processing-failed',
                    'approved-for-processing', ?4, ?5, ?6
                )
            `).bind(
                run.draftId,
                input.idempotencyKey,
                payloadFingerprint,
                input.expectedStateVersion,
                input.expectedStateVersion + 1,
                occurredAt
            ),
            auditInsert(env.DB, {
                eventType: 'processing-retry-approved',
                subjectHash,
                actorIdentityHash,
                payloadHash: payloadFingerprint,
                stateVersion: input.expectedStateVersion + 1,
                occurredAt
            })
        ]);

        const committed = await processingRetryReplay(
            env.DB,
            runIdentity,
            input,
            payloadFingerprint,
            subjectHash
        );
        if (!committed?.ok) {
            throw new Error('Processing retry transition was not durable.');
        }
        return retrySuccess(processingRunId, input, false);
    } catch {
        try {
            const runIdentity = await readRunIdentity(env.DB, processingRunId);
            if (!runIdentity) {
                return failure(503, 'service-unavailable');
            }
            const subjectHash = await sha256Text(`draft:${runIdentity.draftId}`);
            const replay = await processingRetryReplay(
                env.DB,
                runIdentity,
                input,
                payloadFingerprint,
                subjectHash
            );
            if (replay) {
                return replay;
            }

            const run = await readRun(env.DB, processingRunId);
            const cleanupProof = await readRetryCleanupProof(env.DB, processingRunId);
            return await failedRunIsRetryEligible(run, cleanupProof, input, env.DB)
                ? failure(503, 'service-unavailable')
                : failure(409, 'processing-not-eligible');
        } catch {
            return failure(503, 'service-unavailable');
        }
    }
}

export async function storeProcessingDerivative(
    env,
    processingRunId,
    role,
    request,
    nowMilliseconds,
    dependencies = {}
) {
    const roleLimits = ROLE_LIMITS[role];
    const idempotencyKey = request.headers.get('Idempotency-Key');
    const claimedSha256 = request.headers.get('X-Gallery-Content-SHA256');
    const declaredLengthText = request.headers.get('Content-Length');
    if (
        !hasProcessingBindings(env) ||
        !RUN_ID_PATTERN.test(processingRunId || '') ||
        !roleLimits ||
        !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey || '') ||
        !SHA256_PATTERN.test(claimedSha256 || '') ||
        request.headers.get('Content-Type') !== 'image/webp' ||
        request.headers.has('Content-Encoding') ||
        request.headers.has('Content-Range') ||
        request.headers.has('Range') ||
        request.headers.has('Transfer-Encoding') ||
        !/^[1-9][0-9]*$/.test(declaredLengthText || '') ||
        Number(declaredLengthText) > roleLimits.maximumBytes ||
        request.body === null
    ) {
        return failure(400, 'invalid-request');
    }

    try {
        const run = await readRun(env.DB, processingRunId);
        const problems = await processingEligibilityProblems(run, {
            requiredState: 'processing',
            expectedStateVersion: run?.processingStateVersion,
            requiredRunStatus: 'active'
        }, env.DB);
        if (problems.length > 0 || !runMatchesEvidence(run)) {
            return failure(409, 'processing-not-eligible');
        }

        const declaredLength = Number(declaredLengthText);
        const bytes = await readRequestBody(request, roleLimits.maximumBytes);
        if (bytes.byteLength !== declaredLength) {
            return failure(422, 'derivative-rejected');
        }
        const sha256 = await sha256Hex(bytes);
        if (sha256 !== claimedSha256) {
            return failure(422, 'derivative-rejected');
        }
        const dimensions = inspectStaticWebp(bytes);
        if (
            !dimensions ||
            Math.max(dimensions.width, dimensions.height) > roleLimits.maximumLongEdge
        ) {
            return failure(422, 'derivative-rejected');
        }

        const stagingObjectKey = buildV1StagingDerivativeKey({
            site: run.runSiteMode,
            draftId: run.draftId,
            processingRunId,
            sha256,
            role
        });
        const payloadFingerprint = await fingerprint({
            operation: 'processing-output-upload',
            processingRunId,
            role,
            contentType: 'image/webp',
            byteLength: bytes.byteLength,
            sha256,
            width: dimensions.width,
            height: dimensions.height,
            idempotencyKey
        });
        const occurredAt = isoTime(nowMilliseconds);

        let output = await readOutput(env.DB, processingRunId, role);
        if (output && !outputReplayMatches(output, {
            idempotencyKey,
            payloadFingerprint,
            stagingObjectKey,
            sha256,
            byteLength: bytes.byteLength,
            dimensions
        })) {
            return failure(409, 'conflict');
        }
        if (!output) {
            try {
                await runStatement(env.DB.prepare(`
                    INSERT INTO draft_processing_outputs (
                        processing_run_id, role, upload_idempotency_key,
                        upload_payload_fingerprint, staging_object_key, sha256,
                        byte_count, content_type, width, height, status, created_at
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'image/webp', ?8, ?9, 'reserved', ?10)
                `).bind(
                    processingRunId,
                    role,
                    idempotencyKey,
                    payloadFingerprint,
                    stagingObjectKey,
                    sha256,
                    bytes.byteLength,
                    dimensions.width,
                    dimensions.height,
                    occurredAt
                ));
            } catch {
                output = await readOutput(env.DB, processingRunId, role);
                if (!output || !outputReplayMatches(output, {
                    idempotencyKey,
                    payloadFingerprint,
                    stagingObjectKey,
                    sha256,
                    byteLength: bytes.byteLength,
                    dimensions
                })) {
                    return failure(409, 'conflict');
                }
            }
            output = await readOutput(env.DB, processingRunId, role);
        }

        if (output.status === 'verified' || output.status === 'stored') {
            const stored = await readExactStagedObject(env.DERIVATIVE_STAGING, output);
            return stored
                ? outputSuccess(output, true)
                : failure(503, 'service-unavailable');
        }
        if (output.status !== 'reserved') {
            return failure(409, 'conflict');
        }

        const beforeWrite = await readRun(env.DB, processingRunId);
        if ((await processingEligibilityProblems(beforeWrite, {
            requiredState: 'processing',
            expectedStateVersion: run.processingStateVersion,
            requiredRunStatus: 'active'
        }, env.DB)).length > 0 || !runMatchesEvidence(beforeWrite)) {
            return failure(409, 'processing-not-eligible');
        }

        const storedObject = await ensureExactMultipartObject(
            env,
            output,
            bytes,
            nowMilliseconds,
            dependencies
        );
        if (!storedObject) {
            return failure(503, 'service-unavailable');
        }

        const afterWrite = await readRun(env.DB, processingRunId);
        if ((await processingEligibilityProblems(afterWrite, {
            requiredState: 'processing',
            expectedStateVersion: run.processingStateVersion,
            requiredRunStatus: 'active'
        }, env.DB)).length > 0 || !runMatchesEvidence(afterWrite)) {
            return failure(409, 'processing-not-eligible');
        }

        try {
            const multipart = await readMultipartUpload(env.DB, processingRunId, role);
            if (
                !multipart ||
                multipart.status !== 'part-uploaded' ||
                multipart.stagingObjectKey !== output.stagingObjectKey ||
                multipart.uploadPayloadFingerprint !== payloadFingerprint
            ) {
                return failure(503, 'service-unavailable');
            }
            const storedAt = nextIsoTime(nowMilliseconds, multipart.updatedAt);
            await runBatch(env.DB, [
                env.DB.prepare(`
                    UPDATE draft_processing_outputs
                    SET status = 'stored', staging_object_version = ?1,
                        staging_etag = ?2, stored_at = ?3
                    WHERE processing_run_id = ?4 AND role = ?5 AND status = 'reserved'
                      AND upload_payload_fingerprint = ?6
                `).bind(
                    storedObject.version,
                    storedObject.etag,
                    storedAt,
                    processingRunId,
                    role,
                    payloadFingerprint
                ),
                env.DB.prepare(`
                    UPDATE draft_processing_multipart_uploads
                    SET status = 'terminal', terminal_kind = 'completed',
                        updated_at = ?1, terminal_at = ?1
                    WHERE processing_run_id = ?2 AND role = ?3
                      AND status = 'part-uploaded'
                      AND upload_payload_fingerprint = ?4
                `).bind(
                    nextIsoTime(nowMilliseconds, storedAt),
                    processingRunId,
                    role,
                    payloadFingerprint
                )
            ]);
        } catch {
            // The completed provider upload and the immutable reservation stay
            // recoverable. An exact retry adopts the object; cleanup can also
            // prove and remove it after closing the D1 write gate.
        }

        const finalOutput = await readOutput(env.DB, processingRunId, role);
        if (!finalOutput || finalOutput.status !== 'stored') {
            return failure(503, 'service-unavailable');
        }
        return outputSuccess(finalOutput, false);
    } catch {
        return failure(503, 'service-unavailable');
    }
}

export async function cleanupProcessingRun(
    env,
    identity,
    processingRunId,
    input,
    nowMilliseconds
) {
    if (
        !hasProcessingBindings(env) ||
        !validServiceIdentity(identity) ||
        !RUN_ID_PATTERN.test(processingRunId || '') ||
        !isExactObject(input, CLEANUP_KEYS) ||
        !Number.isSafeInteger(input.expectedStateVersion) ||
        input.expectedStateVersion < 0 ||
        !IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey || '')
    ) {
        return failure(400, 'invalid-request');
    }

    const payloadFingerprint = await fingerprint({
        operation: 'processing-cleanup',
        processingRunId,
        expectedStateVersion: input.expectedStateVersion,
        idempotencyKey: input.idempotencyKey
    });

    try {
        let cleanup = await readCleanup(env.DB, processingRunId);
        let replayed = Boolean(cleanup);
        if (cleanup && !cleanupReplayMatches(cleanup, input, payloadFingerprint)) {
            return failure(409, 'conflict');
        }

        if (!cleanup) {
            const context = await readCleanupContext(env.DB, processingRunId);
            if (!context) {
                return failure(404, 'not-found');
            }
            const cleanupReason = deriveCleanupReason(context);
            if (
                !cleanupReason ||
                context.stateVersion !== input.expectedStateVersion ||
                context.approvedDerivativeCount !== 0
            ) {
                return failure(409, 'processing-not-eligible');
            }

            const outputs = await readOutputs(env.DB, processingRunId);
            const occurredAt = isoTime(nowMilliseconds);
            const cleanupId = randomIdentifier('cleanup');
            const cleanupIdHash = await sha256Text(cleanupId);
            const draftIdHash = await sha256Text(context.draftId);
            const processingRunIdHash = await sha256Text(processingRunId);
            const actorIdentityHash = await hashIdentity(identity);
            const statements = [env.DB.prepare(`
                INSERT INTO draft_processing_cleanups (
                    cleanup_id, cleanup_id_hash,
                    processing_run_id, processing_run_id_hash,
                    draft_id, draft_id_hash, cleanup_reason,
                    expected_state_version, output_count, idempotency_key,
                    payload_fingerprint, service_actor_identity_hash, status,
                    created_at, updated_at
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                    ?11, ?12, 'closing', ?13, ?13
                )
            `).bind(
                cleanupId,
                cleanupIdHash,
                processingRunId,
                processingRunIdHash,
                context.draftId,
                draftIdHash,
                cleanupReason,
                input.expectedStateVersion,
                outputs.length,
                input.idempotencyKey,
                payloadFingerprint,
                actorIdentityHash,
                occurredAt
            )];
            for (const output of outputs) {
                statements.push(env.DB.prepare(`
                    INSERT INTO draft_processing_cleanup_objects (
                        cleanup_id, role, staging_object_key,
                        staging_object_key_hash, expected_sha256,
                        expected_byte_count, expected_object_version_hash,
                        expected_etag_hash, status
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending')
                `).bind(
                    cleanupId,
                    output.role,
                    output.stagingObjectKey,
                    await hashProviderFact('staging-key', output.stagingObjectKey),
                    output.sha256,
                    output.byteCount,
                    output.stagingObjectVersion
                        ? await hashProviderFact('object-version', output.stagingObjectVersion)
                        : null,
                    output.stagingEtag
                        ? await hashProviderFact('etag', output.stagingEtag)
                        : null
                ));
            }
            try {
                await runBatch(env.DB, statements);
            } catch {
                cleanup = await readCleanup(env.DB, processingRunId);
                if (!cleanup || !cleanupReplayMatches(cleanup, input, payloadFingerprint)) {
                    return failure(cleanup ? 409 : 503, cleanup ? 'conflict' : 'service-unavailable');
                }
                replayed = true;
            }
            cleanup = cleanup || await readCleanup(env.DB, processingRunId);
        }

        if (!cleanup) {
            return failure(503, 'service-unavailable');
        }
        if (cleanup.status !== 'cleaned') {
            cleanup = await continueProcessingCleanup(env, cleanup, nowMilliseconds);
        }
        return cleanup?.status === 'cleaned'
            ? cleanupSuccess(cleanup, replayed, replayed ? 200 : 201)
            : failure(503, 'service-unavailable');
    } catch {
        try {
            const replay = await readCleanup(env.DB, processingRunId);
            if (
                replay?.status === 'cleaned' &&
                cleanupReplayMatches(replay, input, payloadFingerprint)
            ) {
                return cleanupSuccess(replay, true, 200);
            }
        } catch {
            // Fall through to the fail-closed response.
        }
        return failure(503, 'service-unavailable');
    }
}

export async function recordProcessingResult(
    env,
    identity,
    processingRunId,
    input,
    nowMilliseconds
) {
    if (
        !hasProcessingBindings(env) ||
        !validServiceIdentity(identity) ||
        !RUN_ID_PATTERN.test(processingRunId || '') ||
        !validResultInput(input)
    ) {
        return failure(400, 'invalid-request');
    }

    const payloadFingerprint = await fingerprint({
        operation: 'processing-result',
        processingRunId,
        result: canonicalResultInput(input)
    });

    try {
        let run = await readRun(env.DB, processingRunId);
        if (!run) {
            return failure(404, 'not-found');
        }
        if (await processingCleanupExists(env.DB, processingRunId)) {
            return failure(409, 'processing-not-eligible');
        }
        if (run.runStatus !== 'active') {
            return resultReplay(run, input, payloadFingerprint);
        }
        const problems = await processingEligibilityProblems(run, {
            requiredState: 'processing',
            expectedStateVersion: input.expectedStateVersion,
            requiredRunStatus: 'active'
        }, env.DB);
        if (problems.length > 0 || !runMatchesEvidence(run)) {
            return failure(409, 'processing-not-eligible');
        }

        const occurredAt = isoTime(nowMilliseconds);
        const actorIdentityHash = await hashIdentity(identity);
        const subjectHash = await sha256Text(`draft:${run.draftId}`);

        if (input.outcome === 'failed') {
            const failureTransitionKey = `failure_${await sha256Text(
                `${processingRunId}:${input.idempotencyKey}`
            )}`;
            await runBatch(env.DB, [
                env.DB.prepare(
                    "UPDATE gallery_drafts SET state = 'processing-failed', " +
                    'state_version = state_version + 1, ' +
                    'processing_diagnostics_json = ?1, updated_at = ?2 ' +
                    "WHERE draft_id = ?3 AND state = 'processing' " +
                    'AND state_version = ?4 AND item_revision = ?5 ' +
                    'AND active_consent_revision = ?6 AND export_bundle_id = ?7 ' +
                    'AND source_revision = ?8 AND suppression_revision = ?9'
                ).bind(
                    JSON.stringify({ schemaVersion: '1.0', code: input.errorCode }),
                    occurredAt,
                    run.draftId,
                    input.expectedStateVersion,
                    run.runItemRevision,
                    run.runConsentRevision,
                    run.runExportBundleId,
                    run.runSourceRevision,
                    run.runSuppressionRevision
                ),
                env.DB.prepare(`
                    UPDATE draft_processing_runs
                    SET status = 'failed', result_idempotency_key = ?1,
                        result_payload_fingerprint = ?2,
                        result_transition_key = ?3, failure_code = ?4,
                        updated_at = ?5, completed_at = ?5
                    WHERE processing_run_id = ?6 AND status = 'active'
                `).bind(
                    input.idempotencyKey,
                    payloadFingerprint,
                    failureTransitionKey,
                    input.errorCode,
                    occurredAt,
                    processingRunId
                ),
                env.DB.prepare(`
                    INSERT INTO draft_transition_receipts (
                        draft_id, idempotency_key, payload_fingerprint,
                        from_state, to_state, expected_state_version,
                        result_state_version, created_at
                    ) VALUES (?1, ?2, ?3, 'processing', 'processing-failed', ?4, ?5, ?6)
                `).bind(
                    run.draftId,
                    failureTransitionKey,
                    payloadFingerprint,
                    input.expectedStateVersion,
                    input.expectedStateVersion + 1,
                    occurredAt
                ),
                auditInsert(env.DB, {
                    eventType: 'processing-failed',
                    subjectHash,
                    actorIdentityHash,
                    payloadHash: payloadFingerprint,
                    stateVersion: input.expectedStateVersion + 1,
                    occurredAt
                })
            ]);
            run = await readRun(env.DB, processingRunId);
            return resultSuccess(run, false, 200);
        }

        const outputs = await readOutputs(env.DB, processingRunId);
        if (!stagedResultMatchesRun(input, run, outputs)) {
            return failure(422, 'derivative-rejected');
        }
        for (const output of outputs) {
            if (!await readExactStagedObject(env.DERIVATIVE_STAGING, output)) {
                return failure(503, 'service-unavailable');
            }
        }

        const scannerVersion = input.toolchain.exiftool;
        const metadataEvidenceByRole = new Map(input.derivatives.map(derivative => [
            derivative.role,
            JSON.stringify({
                schemaVersion: '1.0',
                scannerName: 'exiftool',
                scannerVersion,
                metadataEntryCount: 0,
                findingCategories: []
            })
        ]));
        const statements = [];
        for (const output of outputs) {
            statements.push(env.DB.prepare(`
                UPDATE draft_processing_outputs
                SET status = 'verified', metadata_scan_json = ?1,
                    scanner_version = ?2, verified_at = ?3
                WHERE processing_run_id = ?4 AND role = ?5 AND status = 'stored'
            `).bind(
                metadataEvidenceByRole.get(output.role),
                scannerVersion,
                occurredAt,
                processingRunId,
                output.role
            ));
        }
        for (const output of outputs) {
            statements.push(env.DB.prepare(`
                INSERT INTO draft_derivatives (
                    draft_id, item_revision, consent_revision, export_bundle_id,
                    source_revision, suppression_revision, role,
                    staging_object_key, approved_object_key, byte_count, sha256,
                    content_type, width, height, duration_milliseconds,
                    metadata_scan_json, scanner_version, verified_at, host_deleted_at
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?10,
                    'image/webp', ?11, ?12, NULL, ?13, ?14, ?15, NULL
                )
            `).bind(
                run.draftId,
                run.runItemRevision,
                run.runConsentRevision,
                run.runExportBundleId,
                run.runSourceRevision,
                run.runSuppressionRevision,
                output.role,
                output.stagingObjectKey,
                output.byteCount,
                output.sha256,
                output.width,
                output.height,
                metadataEvidenceByRole.get(output.role),
                scannerVersion,
                occurredAt
            ));
        }
        statements.push(env.DB.prepare(`
            UPDATE draft_processing_runs
            SET status = 'staged', result_idempotency_key = ?1,
                result_payload_fingerprint = ?2, result_toolchain_json = ?3,
                updated_at = ?4, completed_at = ?4
            WHERE processing_run_id = ?5 AND status = 'active'
        `).bind(
            input.idempotencyKey,
            payloadFingerprint,
            JSON.stringify(canonicalToolchain(input.toolchain)),
            occurredAt,
            processingRunId
        ));
        statements.push(auditInsert(env.DB, {
            eventType: 'processing-staged',
            subjectHash,
            actorIdentityHash,
            payloadHash: payloadFingerprint,
            stateVersion: run.processingStateVersion,
            occurredAt
        }));
        await runBatch(env.DB, statements);

        run = await readRun(env.DB, processingRunId);
        return resultSuccess(run, false, 200);
    } catch {
        try {
            const replay = await readRun(env.DB, processingRunId);
            return replay &&
                replay.runStatus !== 'active' &&
                !await processingCleanupExists(env.DB, processingRunId)
                ? resultReplay(replay, input, payloadFingerprint)
                : failure(503, 'service-unavailable');
        } catch {
            return failure(503, 'service-unavailable');
        }
    }
}

function startReplay(existing, fingerprintValue, input) {
    if (
        existing.startPayloadFingerprint !== fingerprintValue ||
        existing.startExpectedStateVersion !== input.expectedStateVersion
    ) {
        return failure(409, 'conflict');
    }
    return startSuccess(existing, true, 200);
}

function startSuccess(run, replayed, status) {
    return success(status, {
        schemaVersion: '1.0',
        scope: 'synthetic-local-phase-d',
        processingRunId: run.processingRunId,
        site: run.runSiteMode,
        mediaType: run.runMediaType,
        state: 'processing',
        stateVersion: run.processingStateVersion,
        source: {
            downloadPath: `/api/service/processing-runs/${run.processingRunId}/original`,
            sha256: run.runOriginalSha256,
            byteLength: run.runOriginalByteCount,
            detectedFormat: run.runOriginalDetectedType,
            declaredMimeType: run.runOriginalDeclaredContentType,
            syntheticFileName: `synthetic-source.${run.runOriginalDetectedType === 'jpeg' ? 'jpg' : 'png'}`
        },
        requiredRoles: [...REQUIRED_ROLES],
        runStatus: run.runStatus,
        replayed
    });
}

function outputSuccess(output, replayed) {
    return success(replayed ? 200 : 201, {
        schemaVersion: '1.0',
        processingRunId: output.processingRunId,
        role: output.role,
        sha256: output.sha256,
        byteLength: output.byteCount,
        width: output.width,
        height: output.height,
        replayed
    });
}

function resultSuccess(run, replayed, status) {
    if (!run || !['staged', 'failed'].includes(run.runStatus)) {
        return failure(503, 'service-unavailable');
    }
    return success(status, {
        schemaVersion: '1.0',
        processingRunId: run.processingRunId,
        processingStatus: run.runStatus,
        state: run.runStatus === 'failed' ? 'processing-failed' : 'processing',
        stateVersion: run.runStatus === 'failed'
            ? run.processingStateVersion + 1
            : run.processingStateVersion,
        roles: run.runStatus === 'staged' ? [...REQUIRED_ROLES] : [],
        replayed
    });
}

function cleanupSuccess(cleanup, replayed, status) {
    return success(status, {
        processingRunId: cleanup.processingRunId,
        cleanupReason: cleanup.cleanupReason,
        processingStatus: 'cleaned',
        replayed
    });
}

function cleanupReplayMatches(cleanup, input, payloadFingerprint) {
    return cleanup.idempotencyKey === input.idempotencyKey &&
        cleanup.payloadFingerprint === payloadFingerprint &&
        cleanup.expectedStateVersion === input.expectedStateVersion;
}

function retrySuccess(processingRunId, input, replayed) {
    return success(200, {
        schemaVersion: '1.0',
        processingRunId,
        state: 'approved-for-processing',
        stateVersion: input.expectedStateVersion + 1,
        replayed
    });
}

async function processingRetryReplay(
    database,
    runIdentity,
    input,
    payloadFingerprint,
    subjectHash
) {
    const receipt = await readTransitionReceipt(
        database,
        runIdentity.draftId,
        input.idempotencyKey
    );
    if (!receipt) {
        return null;
    }
    if (
        receipt.payloadFingerprint !== payloadFingerprint ||
        receipt.fromState !== 'processing-failed' ||
        receipt.toState !== 'approved-for-processing' ||
        receipt.expectedStateVersion !== input.expectedStateVersion ||
        receipt.resultStateVersion !== input.expectedStateVersion + 1
    ) {
        return failure(409, 'conflict');
    }
    const auditMatches = await readRetryAuditMatches(database, {
        subjectHash,
        payloadFingerprint,
        stateVersion: receipt.resultStateVersion,
        occurredAt: receipt.createdAt
    });
    if (auditMatches !== 1) {
        return failure(503, 'service-unavailable');
    }
    return retrySuccess(runIdentity.processingRunId, input, true);
}

async function failedRunIsRetryEligible(run, cleanupProof, input, database) {
    const problems = await processingEligibilityProblems(run, {
        requiredState: 'processing-failed',
        expectedStateVersion: input.expectedStateVersion,
        requiredRunStatus: 'failed',
        allowProcessingCleanup: true
    }, database);
    return problems.length === 0 &&
        runMatchesEvidence(run) &&
        run.processingStateVersion + 1 === input.expectedStateVersion &&
        validProcessingFailureDiagnostics(run) &&
        await retryCleanupProofMatches(cleanupProof, run, input);
}

function validProcessingFailureDiagnostics(run) {
    if (!FAILURE_CODES.has(run?.failureCode)) {
        return false;
    }
    try {
        const diagnostics = JSON.parse(run.processingDiagnosticsJson);
        return isPlainObject(diagnostics) &&
            hasExactKeys(diagnostics, ['schemaVersion', 'code']) &&
            diagnostics.schemaVersion === '1.0' &&
            diagnostics.code === run.failureCode;
    } catch {
        return false;
    }
}

async function retryCleanupProofMatches(cleanup, run, input) {
    if (
        !cleanup ||
        cleanup.processingRunId !== run?.processingRunId ||
        cleanup.draftId !== run.draftId ||
        cleanup.cleanupReason !== 'processing-failed' ||
        cleanup.expectedStateVersion !== input.expectedStateVersion ||
        cleanup.status !== 'cleaned' ||
        !SHA256_PATTERN.test(cleanup.cleanupEvidenceHash || '') ||
        typeof cleanup.completedAt !== 'string' ||
        cleanup.completedAt.length < 1 ||
        cleanup.outputRowCount !== 0 ||
        cleanup.multipartRowCount !== 0 ||
        cleanup.derivativeRowCount !== 0 ||
        cleanup.cleanupObjectCount !== cleanup.outputCount ||
        cleanup.activeCleanupObjectCount !== 0 ||
        cleanup.matchingTombstoneCount !== 1
    ) {
        return false;
    }
    return cleanup.cleanupIdHash === await sha256Text(cleanup.cleanupId) &&
        cleanup.draftIdHash === await sha256Text(run.draftId) &&
        cleanup.processingRunIdHash === await sha256Text(run.processingRunId);
}

function retryDraftCasStatement(database, {
    run,
    cleanupProof,
    input,
    expectedDiagnostics,
    occurredAt
}) {
    return database.prepare(`
        UPDATE gallery_drafts
        SET state = 'approved-for-processing',
            state_version = state_version + 1,
            processing_diagnostics_json = NULL,
            updated_at = ?1
        WHERE draft_id = ?2
          AND state = 'processing-failed'
          AND state_version = ?3
          AND processing_diagnostics_json = ?4
          AND export_bundle_id = ?5
          AND source_revision = ?6
          AND suppression_revision = ?7
          AND media_type = 'photo'
          AND upload_complete = 1
          -- Keep the transactional CAS shallow enough for D1's expression-depth
          -- limit. The eligibility read above validates the complete evidence
          -- graph. At mutation time the draft triggers recheck the volatile
          -- consent, exclusion, upload, state, and revision gates, while a
          -- cleaned cleanup and its tombstone are immutable terminal evidence.
          AND EXISTS (
              SELECT 1
              FROM draft_processing_runs AS retry_run
              JOIN draft_processing_cleanups AS cleanup
                ON cleanup.processing_run_id = retry_run.processing_run_id
              JOIN gallery_processing_cleanup_tombstones AS tombstone
                ON tombstone.cleanup_id_hash = cleanup.cleanup_id_hash
               AND tombstone.draft_id_hash = cleanup.draft_id_hash
               AND tombstone.processing_run_id_hash = cleanup.processing_run_id_hash
               AND tombstone.cleanup_reason = cleanup.cleanup_reason
               AND tombstone.evidence_hash = cleanup.cleanup_evidence_hash
               AND tombstone.completed_at = cleanup.completed_at
              WHERE retry_run.processing_run_id = ?8
                AND retry_run.draft_id = gallery_drafts.draft_id
                AND retry_run.status = 'failed'
                AND retry_run.failure_code = ?9
                AND retry_run.processing_state_version + 1 = ?3
                AND cleanup.cleanup_id = ?10
                AND cleanup.cleanup_id_hash = ?11
                AND cleanup.processing_run_id_hash = ?12
                AND cleanup.draft_id = retry_run.draft_id
                AND cleanup.draft_id_hash = ?13
                AND cleanup.cleanup_reason = 'processing-failed'
                AND cleanup.expected_state_version = ?3
                AND cleanup.status = 'cleaned'
                AND cleanup.cleanup_evidence_hash = ?14
                AND cleanup.completed_at IS NOT NULL
          )
    `).bind(
        occurredAt,
        run.draftId,
        input.expectedStateVersion,
        expectedDiagnostics,
        catalogSnapshot.exportBundleId,
        catalogSnapshot.sourceRevision,
        catalogSnapshot.suppressionRevision,
        run.processingRunId,
        run.failureCode,
        cleanupProof.cleanupId,
        cleanupProof.cleanupIdHash,
        cleanupProof.processingRunIdHash,
        cleanupProof.draftIdHash,
        cleanupProof.cleanupEvidenceHash
    );
}

function resultReplay(run, input, payloadFingerprint) {
    if (
        run.resultIdempotencyKey !== input.idempotencyKey ||
        run.resultPayloadFingerprint !== payloadFingerprint ||
        run.processingStateVersion !== input.expectedStateVersion ||
        (input.outcome === 'staged' && run.runStatus !== 'staged') ||
        (input.outcome === 'failed' && (
            run.runStatus !== 'failed' || run.failureCode !== input.errorCode
        ))
    ) {
        return failure(409, 'conflict');
    }
    return resultSuccess(run, true, 200);
}

async function processingEligibilityProblems(record, requirements, database) {
    const problems = [];
    if (!record || typeof record !== 'object') {
        return ['missing'];
    }
    if (
        record.state !== requirements.requiredState ||
        record.stateVersion !== requirements.expectedStateVersion ||
        (requirements.requiredRunStatus && record.runStatus !== requirements.requiredRunStatus)
    ) {
        problems.push('state');
    }
    if (
        record.processingRunId &&
        requirements.allowProcessingCleanup !== true &&
        await processingCleanupExists(database, record.processingRunId)
    ) {
        problems.push('cleanup');
    }
    if (!evidenceShapeIsCurrent(record)) {
        problems.push('evidence');
    }
    let contractDraft;
    try {
        contractDraft = contractDraftFromRow(record);
    } catch {
        problems.push('contract');
        return problems;
    }
    let pendingAthleteIds;
    try {
        pendingAthleteIds = await readPendingAthleteIds(database);
    } catch {
        problems.push('suppression');
        return problems;
    }
    const contractProblems = uploadContract?.validateGalleryUploadApproval(
        contractDraft,
        {
            consentRevision: record.consentRevision,
            suppressionDocument: catalogSnapshot.suppressionDocument,
            suppressionRevision: catalogSnapshot.suppressionRevision,
            pendingHiddenAthleteIds: pendingAthleteIds,
            siteCatalogs: {
                family: catalogSnapshot.sites.family.catalog,
                everyone: catalogSnapshot.sites.everyone.catalog
            }
        }
    );
    if (!Array.isArray(contractProblems) || contractProblems.length > 0) {
        problems.push('approval');
    }
    return problems;
}

function evidenceShapeIsCurrent(record) {
    let siteModes;
    try {
        siteModes = JSON.parse(record.siteModesJson);
    } catch {
        return false;
    }
    if (
        !Array.isArray(siteModes) ||
        siteModes.length !== 1 ||
        !['family', 'everyone'].includes(siteModes[0]) ||
        record.mediaType !== 'photo' ||
        !['jpeg', 'png'].includes(record.originalDetectedType) ||
        record.originalDeclaredContentType !== ORIGINAL_CONTENT_TYPES[record.originalDetectedType] ||
        record.originalByteCount < 1 ||
        record.originalByteCount > 25 * 1024 * 1024 ||
        !SHA256_PATTERN.test(record.originalSha256 || '') ||
        record.uploadComplete !== 1 ||
        record.existingDerivativeCount !== 0 ||
        record.uploadStatus !== 'complete' ||
        record.syntheticOnlyConfirmed !== 1 ||
        record.consentRevision !== record.activeConsentRevision ||
        record.consentWithdrawnAt !== null ||
        record.publicUseConfirmed !== 1 ||
        (record.containsMinors === 1 && record.guardianApprovalConfirmed !== 1) ||
        record.itemRevision !== record.uploadItemRevision ||
        record.consentRevision !== record.uploadConsentRevision ||
        record.exportBundleId !== record.uploadExportBundleId ||
        record.sourceRevision !== record.uploadSourceRevision ||
        record.suppressionRevision !== record.uploadSuppressionRevision ||
        record.originalObjectKey !== record.uploadObjectKey ||
        record.originalDetectedType !== record.uploadDetectedFormat ||
        record.originalByteCount !== record.uploadByteCount ||
        record.originalSha256 !== record.uploadSha256 ||
        record.exportBundleId !== catalogSnapshot.exportBundleId ||
        record.sourceRevision !== catalogSnapshot.sourceRevision ||
        record.suppressionRevision !== catalogSnapshot.suppressionRevision ||
        typeof record.originalObjectVersion !== 'string' ||
        record.originalObjectVersion.length < 1 ||
        record.originalObjectVersion.length > 256 ||
        typeof record.originalEtag !== 'string' ||
        record.originalEtag.length < 1 ||
        record.originalEtag.length > 256
    ) {
        return false;
    }
    return privateOriginalKeyMatchesRecord(record.originalObjectKey, {
        site: siteModes[0],
        uploadedAt: record.uploadedAt,
        draftId: record.draftId,
        uploadId: record.uploadSessionId,
        extension: record.uploadFileExtension
    });
}

function runMatchesEvidence(run) {
    return Boolean(run) &&
        run.runSiteMode === JSON.parse(run.siteModesJson)[0] &&
        run.runMediaType === run.mediaType &&
        run.runItemRevision === run.itemRevision &&
        run.runConsentRevision === run.consentRevision &&
        run.runExportBundleId === run.exportBundleId &&
        run.runSourceRevision === run.sourceRevision &&
        run.runSuppressionRevision === run.suppressionRevision &&
        run.runUploadSessionId === run.uploadSessionId &&
        run.runOriginalObjectKey === run.originalObjectKey &&
        run.runOriginalDetectedType === run.originalDetectedType &&
        run.runOriginalDeclaredContentType === run.originalDeclaredContentType &&
        run.runOriginalByteCount === run.originalByteCount &&
        run.runOriginalSha256 === run.originalSha256 &&
        run.runOriginalObjectVersion === run.originalObjectVersion &&
        run.runOriginalEtag === run.originalEtag;
}

function contractDraftFromRow(row) {
    return {
        schemaVersion: uploadContract.schemaVersion,
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
            revision: row.consentRevision
        },
        withdrawalEvidence: null
    };
}

function validResultInput(input) {
    if (!isPlainObject(input) || !['staged', 'failed'].includes(input.outcome)) {
        return false;
    }
    const expectedKeys = input.outcome === 'staged' ? STAGED_RESULT_KEYS : FAILED_RESULT_KEYS;
    if (
        !hasExactKeys(input, expectedKeys) ||
        !Number.isSafeInteger(input.expectedStateVersion) ||
        input.expectedStateVersion < 0 ||
        !IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey || '')
    ) {
        return false;
    }
    if (input.outcome === 'failed') {
        return FAILURE_CODES.has(input.errorCode);
    }
    return validStagedResult(input);
}

function canonicalResultInput(input) {
    if (input.outcome === 'failed') {
        return {
            outcome: 'failed',
            expectedStateVersion: input.expectedStateVersion,
            idempotencyKey: input.idempotencyKey,
            errorCode: input.errorCode
        };
    }
    return {
        outcome: 'staged',
        expectedStateVersion: input.expectedStateVersion,
        idempotencyKey: input.idempotencyKey,
        source: {
            sha256: input.source.sha256,
            byteLength: input.source.byteLength,
            detectedFormat: input.source.detectedFormat
        },
        toolchain: canonicalToolchain(input.toolchain),
        derivatives: [...input.derivatives]
            .sort((left, right) => left.role < right.role ? -1 : left.role > right.role ? 1 : 0)
            .map(derivative => ({
                role: derivative.role,
                sha256: derivative.sha256,
                byteLength: derivative.byteLength,
                width: derivative.width,
                height: derivative.height,
                durationMilliseconds: derivative.durationMilliseconds,
                metadataEntryCount: derivative.metadataEntryCount,
                metadataFindingCategories: [...derivative.metadataFindingCategories]
            }))
    };
}

function canonicalToolchain(toolchain) {
    return {
        sharp: toolchain.sharp,
        libvips: toolchain.libvips,
        webp: toolchain.webp,
        png: toolchain.png,
        exiftool: toolchain.exiftool,
        videoEnabled: toolchain.videoEnabled
    };
}

function validStagedResult(input) {
    if (
        !isExactObject(input.source, RESULT_SOURCE_KEYS) ||
        !SHA256_PATTERN.test(input.source.sha256 || '') ||
        !Number.isSafeInteger(input.source.byteLength) ||
        input.source.byteLength < 1 ||
        !['jpeg', 'png'].includes(input.source.detectedFormat) ||
        !isExactObject(input.toolchain, RESULT_TOOLCHAIN_KEYS) ||
        input.toolchain.videoEnabled !== false ||
        input.toolchain.sharp !== toolchainContract.photo.sharpRuntimeVersion ||
        input.toolchain.libvips !== toolchainContract.photo.libvipsRuntimeVersion ||
        input.toolchain.webp !== toolchainContract.photo.webpRuntimeVersion ||
        input.toolchain.png !== toolchainContract.photo.pngRuntimeVersion ||
        input.toolchain.exiftool !== toolchainContract.photo.exiftoolRuntimeVersion ||
        !Array.isArray(input.derivatives) ||
        input.derivatives.length !== REQUIRED_ROLES.length
    ) {
        return false;
    }
    const roles = new Set();
    for (const derivative of input.derivatives) {
        if (
            !isExactObject(derivative, RESULT_DERIVATIVE_KEYS) ||
            !REQUIRED_ROLE_SET.has(derivative.role) ||
            roles.has(derivative.role) ||
            !SHA256_PATTERN.test(derivative.sha256 || '') ||
            !Number.isSafeInteger(derivative.byteLength) ||
            derivative.byteLength < 1 ||
            !Number.isSafeInteger(derivative.width) ||
            derivative.width < 1 ||
            !Number.isSafeInteger(derivative.height) ||
            derivative.height < 1 ||
            derivative.durationMilliseconds !== null ||
            derivative.metadataEntryCount !== 0 ||
            !Array.isArray(derivative.metadataFindingCategories) ||
            derivative.metadataFindingCategories.length !== 0
        ) {
            return false;
        }
        roles.add(derivative.role);
    }
    return REQUIRED_ROLES.every(role => roles.has(role));
}

function stagedResultMatchesRun(input, run, outputs) {
    if (
        input.expectedStateVersion !== run.processingStateVersion ||
        input.source.sha256 !== run.runOriginalSha256 ||
        input.source.byteLength !== run.runOriginalByteCount ||
        input.source.detectedFormat !== run.runOriginalDetectedType ||
        outputs.length !== REQUIRED_ROLES.length ||
        outputs.some(output => output.status !== 'stored')
    ) {
        return false;
    }
    const byRole = new Map(outputs.map(output => [output.role, output]));
    return input.derivatives.every(derivative => {
        const output = byRole.get(derivative.role);
        return output &&
            output.sha256 === derivative.sha256 &&
            output.byteCount === derivative.byteLength &&
            output.width === derivative.width &&
            output.height === derivative.height;
    });
}

async function ensureExactMultipartObject(
    env,
    output,
    bytes,
    nowMilliseconds,
    dependencies
) {
    const bucket = env.DERIVATIVE_STAGING;
    let multipart = await readMultipartUpload(
        env.DB,
        output.processingRunId,
        output.role
    );

    if (!multipart) {
        if (await processingCleanupExists(env.DB, output.processingRunId)) {
            return null;
        }
        let created;
        try {
            created = await bucket.createMultipartUpload(output.stagingObjectKey, {
                httpMetadata: { contentType: 'image/webp' },
                customMetadata: {
                    contract: 'gallery-private-staging-v1',
                    role: output.role
                }
            });
        } catch {
            // A lost create response can leave only an empty provider upload:
            // no part is sent until an exact upload ID is durable in D1.
            return null;
        }
        if (
            created?.key !== output.stagingObjectKey ||
            !safeProviderUploadId(created?.uploadId)
        ) {
            await abortUnpersistedMultipart(created);
            return null;
        }

        const createdAt = isoTime(nowMilliseconds);
        const providerUploadIdHash = await hashProviderFact(
            'multipart-upload-id',
            created.uploadId
        );
        try {
            await runStatement(env.DB.prepare(`
                INSERT INTO draft_processing_multipart_uploads (
                    processing_run_id, role, staging_object_key,
                    upload_payload_fingerprint, provider_upload_id,
                    provider_upload_id_hash, status, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', ?7, ?7)
            `).bind(
                output.processingRunId,
                output.role,
                output.stagingObjectKey,
                output.uploadPayloadFingerprint,
                created.uploadId,
                providerUploadIdHash,
                createdAt
            ));
        } catch {
            // Another exact request may have committed its own handle, or the
            // cleanup gate may have closed. The losing provider upload has no
            // part and is aborted without ever receiving media bytes.
        }

        multipart = await readMultipartUpload(
            env.DB,
            output.processingRunId,
            output.role
        );
        if (multipart?.providerUploadId !== created.uploadId) {
            await abortUnpersistedMultipart(created);
        }
    }

    if (!multipartReplayMatches(multipart, output)) {
        return null;
    }

    let head = await bucket.head(output.stagingObjectKey);
    if (head) {
        if (
            multipart.status === 'open' ||
            (multipart.status === 'terminal' && multipart.terminalKind !== 'completed') ||
            !storedObjectShapeMatches(head, output) ||
            !await exactStagedObject(bucket, output, head)
        ) {
            return null;
        }
        return { version: head.version, etag: head.etag };
    }
    if (multipart.status === 'terminal') {
        return null;
    }

    if (multipart.status === 'open') {
        let part;
        try {
            const resumed = bucket.resumeMultipartUpload(
                multipart.stagingObjectKey,
                multipart.providerUploadId
            );
            part = await resumed.uploadPart(1, bytes);
        } catch {
            return null;
        }
        if (
            part?.partNumber !== 1 ||
            !safeProviderValue(part.etag)
        ) {
            return null;
        }
        const partUploadedAt = nextIsoTime(nowMilliseconds, multipart.updatedAt);
        try {
            await runStatement(env.DB.prepare(`
                UPDATE draft_processing_multipart_uploads
                SET status = 'part-uploaded', provider_part_etag = ?1,
                    updated_at = ?2, part_uploaded_at = ?2
                WHERE processing_run_id = ?3 AND role = ?4 AND status = 'open'
                  AND provider_upload_id = ?5
                  AND upload_payload_fingerprint = ?6
            `).bind(
                part.etag,
                partUploadedAt,
                output.processingRunId,
                output.role,
                multipart.providerUploadId,
                output.uploadPayloadFingerprint
            ));
        } catch {
            return null;
        }
        multipart = await readMultipartUpload(
            env.DB,
            output.processingRunId,
            output.role
        );
        if (
            !multipartReplayMatches(multipart, output) ||
            multipart.status !== 'part-uploaded'
        ) {
            return null;
        }
    }

    if (
        multipart.status !== 'part-uploaded' ||
        !safeProviderValue(multipart.providerPartEtag) ||
        await processingCleanupExists(env.DB, output.processingRunId)
    ) {
        return null;
    }

    try {
        const resumed = bucket.resumeMultipartUpload(
            multipart.stagingObjectKey,
            multipart.providerUploadId
        );
        await resumed.complete([{
            partNumber: 1,
            etag: multipart.providerPartEtag
        }]);
    } catch (error) {
        if (
            dependencies?.shouldInterruptProviderRecovery?.(error, 'complete') === true
        ) {
            throw error;
        }
        // Completion may have committed even when its response was lost. Only
        // the exact object at the server-owned key can be adopted below.
    }

    head = await bucket.head(output.stagingObjectKey);
    if (
        !storedObjectShapeMatches(head, output) ||
        !await exactStagedObject(bucket, output, head)
    ) {
        return null;
    }
    return { version: head.version, etag: head.etag };
}

async function abortUnpersistedMultipart(multipart) {
    if (!multipart || typeof multipart.abort !== 'function') {
        return;
    }
    try {
        await multipart.abort();
    } catch {
        // No media part was ever sent to this unpersisted upload. A lost abort
        // response therefore cannot leave private media bytes behind.
    }
}

function multipartReplayMatches(multipart, output) {
    return Boolean(multipart) &&
        multipart.processingRunId === output.processingRunId &&
        multipart.role === output.role &&
        multipart.stagingObjectKey === output.stagingObjectKey &&
        multipart.uploadPayloadFingerprint === output.uploadPayloadFingerprint &&
        safeProviderUploadId(multipart.providerUploadId);
}

async function continueProcessingCleanup(env, initialCleanup, nowMilliseconds) {
    let cleanup = initialCleanup;
    if (cleanup.status === 'closing') {
        const uploads = await readMultipartUploads(env.DB, cleanup.processingRunId);
        for (const upload of uploads) {
            if (upload.status !== 'terminal') {
                await terminateMultipartForCleanup(env, upload, nowMilliseconds);
            }
        }
        cleanup = await readCleanup(env.DB, cleanup.processingRunId);
        if (!cleanup) {
            return null;
        }
        if (cleanup.status === 'closing') {
            const stillOpen = (await readMultipartUploads(
                env.DB,
                cleanup.processingRunId
            )).some(upload => upload.status !== 'terminal');
            if (stillOpen) {
                return null;
            }
            const deletingAt = nextIsoTime(nowMilliseconds, cleanup.updatedAt);
            await runStatement(env.DB.prepare(`
                UPDATE draft_processing_cleanups
                SET status = 'deleting', updated_at = ?1
                WHERE processing_run_id = ?2 AND status = 'closing'
            `).bind(deletingAt, cleanup.processingRunId));
            cleanup = await readCleanup(env.DB, cleanup.processingRunId);
        }
    }

    if (!cleanup || cleanup.status !== 'deleting') {
        return cleanup;
    }

    const cleanupObjects = await readCleanupObjects(env.DB, cleanup.cleanupId);
    for (const object of cleanupObjects) {
        if (object.status === 'pending') {
            await deleteCleanupObject(env, cleanup, object, nowMilliseconds);
        }
    }

    cleanup = await readCleanup(env.DB, cleanup.processingRunId);
    const finalObjects = await readCleanupObjects(env.DB, cleanup.cleanupId);
    if (
        cleanup.status !== 'deleting' ||
        finalObjects.length !== cleanup.outputCount ||
        finalObjects.some(object => object.status !== 'absent')
    ) {
        return null;
    }

    const stagingPrefix = processingStagingPrefix(cleanup);
    if (!await stagingPrefixIsEmpty(env.DERIVATIVE_STAGING, stagingPrefix)) {
        return null;
    }

    const completedAt = nextIsoTime(nowMilliseconds, cleanup.updatedAt);
    const recomputedCleanupIdHash = await sha256Text(cleanup.cleanupId);
    const recomputedDraftIdHash = await sha256Text(cleanup.draftId);
    const recomputedProcessingRunIdHash = await sha256Text(cleanup.processingRunId);
    if (
        cleanup.cleanupIdHash !== recomputedCleanupIdHash ||
        cleanup.draftIdHash !== recomputedDraftIdHash ||
        cleanup.processingRunIdHash !== recomputedProcessingRunIdHash
    ) {
        return null;
    }
    const cleanupIdHash = cleanup.cleanupIdHash;
    const draftIdHash = cleanup.draftIdHash;
    const processingRunIdHash = cleanup.processingRunIdHash;
    const evidenceHash = await fingerprint({
        operation: 'processing-staging-cleanup',
        schemaVersion: '1.0',
        cleanupIdHash,
        processingRunIdHash,
        draftIdHash,
        cleanupReason: cleanup.cleanupReason,
        expectedStateVersion: cleanup.expectedStateVersion,
        stagingPrefixHash: await hashProviderFact('staging-prefix', stagingPrefix),
        prefixEmpty: true,
        objects: finalObjects.map(object => ({
            role: object.role,
            stagingObjectKeyHash: object.stagingObjectKeyHash,
            expectedSha256: object.expectedSha256,
            expectedByteCount: object.expectedByteCount,
            expectedObjectVersionHash: object.expectedObjectVersionHash,
            expectedEtagHash: object.expectedEtagHash,
            providerTerminalKind: object.providerTerminalKind,
            observedObjectVersionHash: object.observedObjectVersionHash,
            observedEtagHash: object.observedEtagHash,
            deletedAt: object.deletedAt,
            absenceVerifiedAt: object.absenceVerifiedAt
        })),
        completedAt
    });
    const subjectHash = await sha256Text(`draft:${cleanup.draftId}`);

    try {
        await runBatch(env.DB, [
            env.DB.prepare(`
                DELETE FROM draft_derivatives
                WHERE draft_id = ?1 AND approved_object_key IS NULL
                  AND EXISTS (
                      SELECT 1 FROM draft_processing_outputs AS output
                      WHERE output.processing_run_id = ?2
                        AND output.role = draft_derivatives.role
                        AND output.staging_object_key = draft_derivatives.staging_object_key
                  )
            `).bind(cleanup.draftId, cleanup.processingRunId),
            env.DB.prepare(`
                DELETE FROM draft_processing_multipart_uploads
                WHERE processing_run_id = ?1 AND status = 'terminal'
            `).bind(cleanup.processingRunId),
            env.DB.prepare(`
                DELETE FROM draft_processing_outputs
                WHERE processing_run_id = ?1
            `).bind(cleanup.processingRunId),
            env.DB.prepare(`
                UPDATE draft_processing_cleanups
                SET status = 'cleaned', cleanup_evidence_hash = ?1,
                    updated_at = ?2, completed_at = ?2
                WHERE processing_run_id = ?3 AND status = 'deleting'
            `).bind(evidenceHash, completedAt, cleanup.processingRunId),
            env.DB.prepare(`
                INSERT INTO gallery_processing_cleanup_tombstones (
                    cleanup_id_hash, draft_id_hash, processing_run_id_hash,
                    cleanup_reason, evidence_hash, completed_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            `).bind(
                cleanupIdHash,
                draftIdHash,
                processingRunIdHash,
                cleanup.cleanupReason,
                evidenceHash,
                completedAt
            ),
            auditInsert(env.DB, {
                eventType: 'processing-staging-cleaned',
                subjectHash,
                actorIdentityHash: cleanup.serviceActorIdentityHash,
                payloadHash: evidenceHash,
                stateVersion: cleanup.expectedStateVersion,
                occurredAt: completedAt
            })
        ]);
    } catch {
        const replay = await readCleanup(env.DB, cleanup.processingRunId);
        return replay?.status === 'cleaned' ? replay : null;
    }
    return readCleanup(env.DB, cleanup.processingRunId);
}

async function terminateMultipartForCleanup(env, multipart, nowMilliseconds) {
    let terminalKind = 'aborted';
    try {
        const resumed = env.DERIVATIVE_STAGING.resumeMultipartUpload(
            multipart.stagingObjectKey,
            multipart.providerUploadId
        );
        await resumed.abort();
    } catch (error) {
        if (!isNoSuchUploadError(error)) {
            throw error;
        }
        terminalKind = 'not-found';
    }

    // A resumable R2 handle does not prove that its underlying upload is still
    // active. In particular, an abort can resolve after a competing completion
    // has already made the object visible. HEAD is strongly consistent after
    // completion, so adopt only the exact server-owned object and record that
    // completion won; otherwise retain the abort/not-found outcome above.
    const head = await env.DERIVATIVE_STAGING.head(multipart.stagingObjectKey);
    if (head) {
        const output = await readOutput(
            env.DB,
            multipart.processingRunId,
            multipart.role
        );
        if (
            !output ||
            !storedObjectShapeMatches(head, output) ||
            !await exactStagedObject(env.DERIVATIVE_STAGING, output, head)
        ) {
            throw new Error('Completed staging object does not match reserved evidence.');
        }
        terminalKind = 'completed';
    }

    const terminalAt = nextIsoTime(nowMilliseconds, multipart.updatedAt);
    await runStatement(env.DB.prepare(`
        UPDATE draft_processing_multipart_uploads
        SET status = 'terminal', terminal_kind = ?1,
            updated_at = ?2, terminal_at = ?2
        WHERE processing_run_id = ?3 AND role = ?4
          AND status IN ('open', 'part-uploaded')
          AND provider_upload_id = ?5
    `).bind(
        terminalKind,
        terminalAt,
        multipart.processingRunId,
        multipart.role,
        multipart.providerUploadId
    ));
    const terminal = await readMultipartUpload(
        env.DB,
        multipart.processingRunId,
        multipart.role
    );
    if (!terminal || terminal.status !== 'terminal') {
        throw new Error('Multipart terminal evidence was not durable.');
    }
}

async function deleteCleanupObject(env, cleanup, cleanupObject, nowMilliseconds) {
    const output = await readOutput(
        env.DB,
        cleanup.processingRunId,
        cleanupObject.role
    );
    if (
        !output ||
        output.stagingObjectKey !== cleanupObject.stagingObjectKey ||
        output.sha256 !== cleanupObject.expectedSha256 ||
        output.byteCount !== cleanupObject.expectedByteCount
    ) {
        throw new Error('Cleanup output evidence changed.');
    }

    const multipart = await readMultipartUpload(
        env.DB,
        cleanup.processingRunId,
        cleanupObject.role
    );
    if (multipart && multipart.status !== 'terminal') {
        throw new Error('Cleanup attempted before multipart termination.');
    }

    let providerTerminalKind = multipart?.terminalKind || 'not-found';
    let observedObjectVersionHash = null;
    let observedEtagHash = null;
    let deletedAt = null;
    const head = await env.DERIVATIVE_STAGING.head(cleanupObject.stagingObjectKey);
    if (head) {
        if (
            !storedObjectShapeMatches(head, output) ||
            !await providerFactsMatchCleanupObject(head, cleanupObject) ||
            !await exactStagedObject(env.DERIVATIVE_STAGING, output, head)
        ) {
            throw new Error('Staging object deletion evidence did not match.');
        }
        // Keep the immutable multipart terminal fact. A provider may report an
        // abort as successful after completion already won; the observed object
        // hashes and deleted_at below separately prove that exact object's
        // deletion without rewriting the historical multipart result.
        observedObjectVersionHash = await hashProviderFact(
            'object-version',
            head.version
        );
        observedEtagHash = await hashProviderFact('etag', head.etag);
        deletedAt = isoTime(nowMilliseconds);
        await env.DERIVATIVE_STAGING.delete(cleanupObject.stagingObjectKey);
    }

    if (await env.DERIVATIVE_STAGING.head(cleanupObject.stagingObjectKey)) {
        throw new Error('Staging object remains after deletion.');
    }
    const absenceVerifiedAt = nextIsoTime(nowMilliseconds, deletedAt);
    await runStatement(env.DB.prepare(`
        UPDATE draft_processing_cleanup_objects
        SET staging_object_key = NULL, provider_terminal_kind = ?1,
            observed_object_version_hash = ?2, observed_etag_hash = ?3,
            status = 'absent', deleted_at = ?4, absence_verified_at = ?5
        WHERE cleanup_id = ?6 AND role = ?7 AND status = 'pending'
    `).bind(
        providerTerminalKind,
        observedObjectVersionHash,
        observedEtagHash,
        deletedAt,
        absenceVerifiedAt,
        cleanup.cleanupId,
        cleanupObject.role
    ));
}

async function providerFactsMatchCleanupObject(head, cleanupObject) {
    if (
        cleanupObject.expectedObjectVersionHash &&
        await hashProviderFact('object-version', head.version) !==
            cleanupObject.expectedObjectVersionHash
    ) {
        return false;
    }
    return !cleanupObject.expectedEtagHash ||
        await hashProviderFact('etag', head.etag) === cleanupObject.expectedEtagHash;
}

async function stagingPrefixIsEmpty(bucket, prefix) {
    let cursor;
    const seenCursors = new Set();
    for (let pageNumber = 0; pageNumber < 256; pageNumber += 1) {
        const listing = await bucket.list({
            prefix,
            limit: 1000,
            ...(cursor ? { cursor } : {})
        });
        if (
            !listing ||
            !Array.isArray(listing.objects) ||
            typeof listing.truncated !== 'boolean'
        ) {
            return false;
        }
        if (listing.objects.length > 0) {
            return false;
        }
        if (!listing.truncated) {
            return true;
        }
        if (
            typeof listing.cursor !== 'string' ||
            listing.cursor.length < 1 ||
            listing.cursor.length > 2048 ||
            seenCursors.has(listing.cursor)
        ) {
            return false;
        }
        seenCursors.add(listing.cursor);
        cursor = listing.cursor;
    }
    return false;
}

function processingStagingPrefix(record) {
    return `derivative-staging/v1/${record.siteMode}/${record.draftId}/` +
        `${record.processingRunId}/`;
}

function isNoSuchUploadError(error) {
    return Boolean(error) &&
        error.name === 'NoSuchUpload' &&
        Number(error.code) === 10024;
}

async function readExactStagedObject(bucket, output) {
    const head = await bucket.head(output.stagingObjectKey);
    if (
        !storedObjectShapeMatches(head, output) ||
        (output.stagingObjectVersion && head.version !== output.stagingObjectVersion) ||
        (output.stagingEtag && head.etag !== output.stagingEtag)
    ) {
        return false;
    }
    return exactStagedObject(bucket, output, head);
}

async function exactStagedObject(bucket, output, head) {
    const object = await bucket.get(output.stagingObjectKey, {
        onlyIf: { etagMatches: head.etag }
    });
    if (
        !storedObjectShapeMatches(object, output) ||
        object.version !== head.version ||
        object.etag !== head.etag ||
        object.body === null ||
        object.body === undefined
    ) {
        return false;
    }
    const bytes = await readBodyBytes(object.body, output.byteCount);
    return bytes.byteLength === output.byteCount &&
        await sha256Hex(bytes) === output.sha256 &&
        dimensionsMatch(inspectStaticWebp(bytes), output);
}

function storedObjectShapeMatches(object, output) {
    const customMetadata = object?.customMetadata;
    const httpMetadata = object?.httpMetadata;
    return Boolean(object) &&
        object.size === output.byteCount &&
        safeProviderValue(object.version) &&
        safeProviderValue(object.etag) &&
        isPlainObject(httpMetadata) &&
        httpMetadata.contentType === 'image/webp' &&
        ['contentDisposition', 'contentEncoding', 'contentLanguage', 'cacheControl', 'cacheExpiry']
            .every(key => httpMetadata[key] === undefined) &&
        isPlainObject(customMetadata) &&
        hasExactKeys(customMetadata, ['contract', 'role']) &&
        customMetadata.contract === 'gallery-private-staging-v1' &&
        customMetadata.role === output.role;
}

function objectMatchesOriginal(object, run) {
    return Boolean(object) &&
        object.size === run.runOriginalByteCount &&
        object.version === run.runOriginalObjectVersion &&
        object.etag === run.runOriginalEtag;
}

function outputReplayMatches(output, expected) {
    return output.uploadIdempotencyKey === expected.idempotencyKey &&
        output.uploadPayloadFingerprint === expected.payloadFingerprint &&
        output.stagingObjectKey === expected.stagingObjectKey &&
        output.sha256 === expected.sha256 &&
        output.byteCount === expected.byteLength &&
        output.contentType === 'image/webp' &&
        dimensionsMatch(expected.dimensions, output);
}

function dimensionsMatch(dimensions, record) {
    return Boolean(dimensions) &&
        dimensions.width === record.width &&
        dimensions.height === record.height;
}

function inspectStaticWebp(bytes) {
    if (
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength < 20 ||
        ascii(bytes, 0, 4) !== 'RIFF' ||
        ascii(bytes, 8, 12) !== 'WEBP' ||
        readUint32Le(bytes, 4) !== bytes.byteLength - 8
    ) {
        return null;
    }

    let offset = 12;
    let dimensions = null;
    let imageChunks = 0;
    let canvasDimensions = null;
    while (offset + 8 <= bytes.byteLength) {
        const kind = ascii(bytes, offset, offset + 4);
        const length = readUint32Le(bytes, offset + 4);
        const dataOffset = offset + 8;
        const nextOffset = dataOffset + length + (length % 2);
        if (!Number.isSafeInteger(length) || nextOffset > bytes.byteLength) {
            return null;
        }
        if (['EXIF', 'XMP ', 'ICCP', 'ANIM', 'ANMF'].includes(kind)) {
            return null;
        }
        if (kind === 'VP8X') {
            if (length !== 10 || canvasDimensions !== null) {
                return null;
            }
            const flags = bytes[dataOffset];
            if ((flags & 0b00111110) !== 0) {
                return null;
            }
            canvasDimensions = {
                width: 1 + readUint24Le(bytes, dataOffset + 4),
                height: 1 + readUint24Le(bytes, dataOffset + 7)
            };
        } else if (kind === 'VP8 ') {
            if (
                length < 10 ||
                bytes[dataOffset + 3] !== 0x9d ||
                bytes[dataOffset + 4] !== 0x01 ||
                bytes[dataOffset + 5] !== 0x2a
            ) {
                return null;
            }
            dimensions = {
                width: readUint16Le(bytes, dataOffset + 6) & 0x3fff,
                height: readUint16Le(bytes, dataOffset + 8) & 0x3fff
            };
            imageChunks += 1;
        } else if (kind === 'VP8L') {
            if (length < 5 || bytes[dataOffset] !== 0x2f) {
                return null;
            }
            const packed = readUint32Le(bytes, dataOffset + 1);
            dimensions = {
                width: 1 + (packed & 0x3fff),
                height: 1 + ((packed >>> 14) & 0x3fff)
            };
            imageChunks += 1;
        } else if (kind !== 'ALPH') {
            return null;
        }
        offset = nextOffset;
    }
    if (
        offset !== bytes.byteLength ||
        imageChunks !== 1 ||
        !validDimensions(dimensions) ||
        (canvasDimensions && !dimensionsMatch(canvasDimensions, dimensions))
    ) {
        return null;
    }
    return dimensions;
}

async function readDraftEvidence(database, draftId) {
    return queryFirst(database, `${DRAFT_EVIDENCE_SELECT} WHERE draft.draft_id = ?1`, draftId);
}

async function readRun(database, processingRunId) {
    return queryFirst(
        database,
        `${RUN_SELECT} WHERE run.processing_run_id = ?1`,
        processingRunId
    );
}

async function readRunIdentity(database, processingRunId) {
    return queryFirst(database, `
        SELECT processing_run_id AS processingRunId, draft_id AS draftId
        FROM draft_processing_runs
        WHERE processing_run_id = ?1
    `, processingRunId);
}

async function readTransitionReceipt(database, draftId, idempotencyKey) {
    return queryFirst(database, `
        SELECT
            draft_id AS draftId,
            idempotency_key AS idempotencyKey,
            payload_fingerprint AS payloadFingerprint,
            from_state AS fromState,
            to_state AS toState,
            expected_state_version AS expectedStateVersion,
            result_state_version AS resultStateVersion,
            created_at AS createdAt
        FROM draft_transition_receipts
        WHERE draft_id = ?1 AND idempotency_key = ?2
    `, draftId, idempotencyKey);
}

async function readRetryAuditMatches(database, {
    subjectHash,
    payloadFingerprint,
    stateVersion,
    occurredAt
}) {
    const row = await queryFirst(database, `
        SELECT COUNT(*) AS matchCount
        FROM gallery_audit_events
        WHERE event_type = 'processing-retry-approved'
          AND subject_reference_hash = ?1
          AND payload_hash = ?2
          AND state_version = ?3
          AND occurred_at = ?4
    `, subjectHash, payloadFingerprint, stateVersion, occurredAt);
    return Number(row?.matchCount);
}

async function readStartReplay(database, draftId, idempotencyKey) {
    return queryFirst(
        database,
        `${RUN_SELECT} WHERE run.draft_id = ?1 AND run.start_idempotency_key = ?2`,
        draftId,
        idempotencyKey
    );
}

async function readOutput(database, processingRunId, role) {
    return queryFirst(database, outputSelectSql(
        'processing_run_id = ?1 AND role = ?2'
    ), processingRunId, role);
}

async function readOutputs(database, processingRunId) {
    return queryAll(database, outputSelectSql(
        'processing_run_id = ?1 ORDER BY role ASC'
    ), processingRunId);
}

async function readMultipartUpload(database, processingRunId, role) {
    return queryFirst(database, `${multipartSelectSql()}
        WHERE processing_run_id = ?1 AND role = ?2`, processingRunId, role);
}

async function readMultipartUploads(database, processingRunId) {
    return queryAll(database, `${multipartSelectSql()}
        WHERE processing_run_id = ?1 ORDER BY role ASC`, processingRunId);
}

function multipartSelectSql() {
    return `
        SELECT
            processing_run_id AS processingRunId,
            role,
            staging_object_key AS stagingObjectKey,
            upload_payload_fingerprint AS uploadPayloadFingerprint,
            provider_upload_id AS providerUploadId,
            provider_upload_id_hash AS providerUploadIdHash,
            status,
            provider_part_etag AS providerPartEtag,
            terminal_kind AS terminalKind,
            created_at AS createdAt,
            updated_at AS updatedAt,
            part_uploaded_at AS partUploadedAt,
            terminal_at AS terminalAt
        FROM draft_processing_multipart_uploads`;
}

async function processingCleanupExists(database, processingRunId) {
    return Boolean(await queryFirst(
        database,
        'SELECT 1 AS present FROM draft_processing_cleanups ' +
            'WHERE processing_run_id = ?1',
        processingRunId
    ));
}

async function readCleanupContext(database, processingRunId) {
    return queryFirst(database, `
        SELECT
            run.processing_run_id AS processingRunId,
            run.draft_id AS draftId,
            run.site_mode AS siteMode,
            run.status AS runStatus,
            draft.state,
            draft.state_version AS stateVersion,
            (SELECT COUNT(*)
                FROM json_each(draft.athlete_ids_json) AS tag
                JOIN pending_athlete_exclusions AS exclusion
                  ON exclusion.athlete_id = tag.value
                WHERE exclusion.resolved_at IS NULL) AS pendingExclusionCount,
            (SELECT COUNT(*) FROM draft_derivatives AS derivative
                WHERE derivative.draft_id = draft.draft_id
                  AND derivative.approved_object_key IS NOT NULL
            ) AS approvedDerivativeCount
        FROM draft_processing_runs AS run
        JOIN gallery_drafts AS draft ON draft.draft_id = run.draft_id
        WHERE run.processing_run_id = ?1
    `, processingRunId);
}

function deriveCleanupReason(context) {
    if (
        context.pendingExclusionCount > 0 &&
        ['processing', 'processing-failed', 'withdrawal-pending'].includes(context.state)
    ) {
        return 'athlete-exclusion';
    }
    if (context.state === 'withdrawal-pending') {
        return 'withdrawal';
    }
    if (context.state === 'processing-failed' && context.runStatus === 'failed') {
        return 'processing-failed';
    }
    return null;
}

async function readCleanup(database, processingRunId) {
    return queryFirst(database, `
        SELECT
            cleanup.cleanup_id AS cleanupId,
            cleanup.cleanup_id_hash AS cleanupIdHash,
            cleanup.processing_run_id AS processingRunId,
            cleanup.processing_run_id_hash AS processingRunIdHash,
            cleanup.draft_id AS draftId,
            cleanup.draft_id_hash AS draftIdHash,
            cleanup.cleanup_reason AS cleanupReason,
            cleanup.expected_state_version AS expectedStateVersion,
            cleanup.output_count AS outputCount,
            cleanup.idempotency_key AS idempotencyKey,
            cleanup.payload_fingerprint AS payloadFingerprint,
            cleanup.service_actor_identity_hash AS serviceActorIdentityHash,
            cleanup.status,
            cleanup.cleanup_evidence_hash AS cleanupEvidenceHash,
            cleanup.created_at AS createdAt,
            cleanup.updated_at AS updatedAt,
            cleanup.completed_at AS completedAt,
            run.site_mode AS siteMode
        FROM draft_processing_cleanups AS cleanup
        JOIN draft_processing_runs AS run
          ON run.processing_run_id = cleanup.processing_run_id
        WHERE cleanup.processing_run_id = ?1
    `, processingRunId);
}

async function readRetryCleanupProof(database, processingRunId) {
    return queryFirst(database, `
        SELECT
            cleanup.cleanup_id AS cleanupId,
            cleanup.cleanup_id_hash AS cleanupIdHash,
            cleanup.processing_run_id AS processingRunId,
            cleanup.processing_run_id_hash AS processingRunIdHash,
            cleanup.draft_id AS draftId,
            cleanup.draft_id_hash AS draftIdHash,
            cleanup.cleanup_reason AS cleanupReason,
            cleanup.expected_state_version AS expectedStateVersion,
            cleanup.output_count AS outputCount,
            cleanup.status,
            cleanup.cleanup_evidence_hash AS cleanupEvidenceHash,
            cleanup.completed_at AS completedAt,
            (SELECT COUNT(*)
                FROM draft_processing_outputs AS output
                WHERE output.processing_run_id = cleanup.processing_run_id
            ) AS outputRowCount,
            (SELECT COUNT(*)
                FROM draft_processing_multipart_uploads AS multipart
                WHERE multipart.processing_run_id = cleanup.processing_run_id
            ) AS multipartRowCount,
            (SELECT COUNT(*)
                FROM draft_derivatives AS derivative
                WHERE derivative.draft_id = cleanup.draft_id
            ) AS derivativeRowCount,
            (SELECT COUNT(*)
                FROM draft_processing_cleanup_objects AS object
                WHERE object.cleanup_id = cleanup.cleanup_id
            ) AS cleanupObjectCount,
            (SELECT COUNT(*)
                FROM draft_processing_cleanup_objects AS object
                WHERE object.cleanup_id = cleanup.cleanup_id
                  AND (
                      object.status <> 'absent' OR
                      object.staging_object_key IS NOT NULL OR
                      object.provider_terminal_kind IS NULL OR
                      object.absence_verified_at IS NULL
                  )
            ) AS activeCleanupObjectCount,
            (SELECT COUNT(*)
                FROM gallery_processing_cleanup_tombstones AS tombstone
                WHERE tombstone.cleanup_id_hash = cleanup.cleanup_id_hash
                  AND tombstone.draft_id_hash = cleanup.draft_id_hash
                  AND tombstone.processing_run_id_hash = cleanup.processing_run_id_hash
                  AND tombstone.cleanup_reason = cleanup.cleanup_reason
                  AND tombstone.evidence_hash = cleanup.cleanup_evidence_hash
                  AND tombstone.completed_at = cleanup.completed_at
            ) AS matchingTombstoneCount
        FROM draft_processing_cleanups AS cleanup
        WHERE cleanup.processing_run_id = ?1
    `, processingRunId);
}

async function readCleanupObjects(database, cleanupId) {
    return queryAll(database, `
        SELECT
            cleanup_id AS cleanupId,
            role,
            staging_object_key AS stagingObjectKey,
            staging_object_key_hash AS stagingObjectKeyHash,
            expected_sha256 AS expectedSha256,
            expected_byte_count AS expectedByteCount,
            expected_object_version_hash AS expectedObjectVersionHash,
            expected_etag_hash AS expectedEtagHash,
            provider_terminal_kind AS providerTerminalKind,
            observed_object_version_hash AS observedObjectVersionHash,
            observed_etag_hash AS observedEtagHash,
            status,
            deleted_at AS deletedAt,
            absence_verified_at AS absenceVerifiedAt
        FROM draft_processing_cleanup_objects
        WHERE cleanup_id = ?1 ORDER BY role ASC
    `, cleanupId);
}

function outputSelectSql(whereClause) {
    return `
        SELECT
            processing_run_id AS processingRunId,
            role,
            upload_idempotency_key AS uploadIdempotencyKey,
            upload_payload_fingerprint AS uploadPayloadFingerprint,
            staging_object_key AS stagingObjectKey,
            sha256,
            byte_count AS byteCount,
            content_type AS contentType,
            width,
            height,
            status,
            staging_object_version AS stagingObjectVersion,
            staging_etag AS stagingEtag,
            metadata_scan_json AS metadataScanJson,
            scanner_version AS scannerVersion,
            created_at AS createdAt,
            stored_at AS storedAt,
            verified_at AS verifiedAt
        FROM draft_processing_outputs WHERE ${whereClause}
    `;
}

async function readPendingAthleteIds(database) {
    const rows = await queryAll(
        database,
        'SELECT athlete_id AS athleteId FROM pending_athlete_exclusions ' +
        'WHERE resolved_at IS NULL ORDER BY athlete_id ASC'
    );
    return rows.map(row => row.athleteId);
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
            audit_event_id, subject_reference_hash, event_type, state_version,
            actor_identity_hash, payload_hash, occurred_at
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
    ) {
        throw new Error('D1 batch failed.');
    }
}

async function runStatement(statement) {
    const result = await statement.run();
    if (result?.success === false) {
        throw new Error('D1 statement failed.');
    }
    return result;
}

async function queryFirst(database, sql, ...bindings) {
    const statement = database.prepare(sql).bind(...bindings);
    if (typeof statement.first === 'function') {
        return statement.first();
    }
    const result = await statement.all();
    return Array.isArray(result?.results) ? result.results[0] ?? null : null;
}

async function queryAll(database, sql, ...bindings) {
    const result = await database.prepare(sql).bind(...bindings).all();
    if (!Array.isArray(result?.results)) {
        throw new Error('D1 rows are unavailable.');
    }
    return result.results;
}

async function readRequestBody(request, maximumBytes) {
    return readBodyBytes(request.body, maximumBytes);
}

async function readBodyBytes(body, maximumBytes) {
    if (body instanceof Uint8Array) {
        if (body.byteLength > maximumBytes) {
            throw new Error('Body exceeds the private limit.');
        }
        return Uint8Array.from(body);
    }
    if (body instanceof ArrayBuffer) {
        if (body.byteLength > maximumBytes) {
            throw new Error('Body exceeds the private limit.');
        }
        return new Uint8Array(body.slice(0));
    }
    if (typeof body?.arrayBuffer === 'function') {
        const arrayBuffer = await body.arrayBuffer();
        if (arrayBuffer.byteLength > maximumBytes) {
            throw new Error('Body exceeds the private limit.');
        }
        return new Uint8Array(arrayBuffer);
    }
    if (typeof body?.getReader !== 'function') {
        throw new Error('Readable body is unavailable.');
    }
    const chunks = [];
    let total = 0;
    const reader = body.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            total += value.byteLength;
            if (total > maximumBytes) {
                await reader.cancel();
                throw new Error('Body exceeds the private limit.');
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)]
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
}

async function sha256Text(value) {
    return sha256Hex(textEncoder.encode(value));
}

async function fingerprint(value) {
    return sha256Text(JSON.stringify(value));
}

function privateByteHeaders(contentType, contentLength) {
    const headers = new Headers({
        'Cache-Control': 'no-store',
        'Content-Length': String(contentLength),
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
        'Content-Type': contentType,
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'X-Robots-Tag': 'noindex, nofollow, noarchive'
    });
    return headers;
}

function success(status, body) {
    return Object.freeze({ ok: true, status, ...body });
}

function failure(status, code) {
    return Object.freeze({ ok: false, status, code });
}

function hasProcessingBindings(env) {
    return env?.DB &&
        typeof env.DB.prepare === 'function' &&
        typeof env.DB.batch === 'function' &&
        env?.PRIVATE_ORIGINALS &&
        typeof env.PRIVATE_ORIGINALS.head === 'function' &&
        typeof env.PRIVATE_ORIGINALS.get === 'function' &&
        env?.DERIVATIVE_STAGING &&
        typeof env.DERIVATIVE_STAGING.head === 'function' &&
        typeof env.DERIVATIVE_STAGING.get === 'function' &&
        typeof env.DERIVATIVE_STAGING.delete === 'function' &&
        typeof env.DERIVATIVE_STAGING.list === 'function' &&
        typeof env.DERIVATIVE_STAGING.createMultipartUpload === 'function' &&
        typeof env.DERIVATIVE_STAGING.resumeMultipartUpload === 'function';
}

function validServiceIdentity(identity) {
    return isPlainObject(identity) &&
        identity.type === 'service' &&
        typeof identity.subject === 'string' &&
        identity.subject.length >= 1 &&
        identity.subject.length <= 512 &&
        !/[\u0000-\u001f\u007f]/.test(identity.subject);
}

function safeProviderValue(value) {
    return typeof value === 'string' && value.length >= 1 && value.length <= 256;
}

function safeProviderUploadId(value) {
    return typeof value === 'string' &&
        value.length >= 1 &&
        value.length <= PROVIDER_UPLOAD_ID_MAXIMUM_LENGTH &&
        !/[\u0000-\u001f\u007f]/.test(value);
}

function validDimensions(value) {
    return value &&
        Number.isSafeInteger(value.width) && value.width > 0 &&
        Number.isSafeInteger(value.height) && value.height > 0;
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

function hashProviderFact(kind, value) {
    return sha256Text(`${kind}:${value}`);
}

function hexToBytes(value) {
    const bytes = new Uint8Array(value.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
}

function hexToBase64(value) {
    let binary = '';
    for (const byte of hexToBytes(value)) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

function ascii(bytes, start, end) {
    return String.fromCharCode(...bytes.subarray(start, end));
}

function readUint16Le(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint24Le(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readUint32Le(bytes, offset) {
    return (
        bytes[offset] |
        (bytes[offset + 1] << 8) |
        (bytes[offset + 2] << 16) |
        (bytes[offset + 3] << 24)
    ) >>> 0;
}

function isExactObject(value, keys) {
    return isPlainObject(value) && hasExactKeys(value, keys);
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
