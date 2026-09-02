import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { buildGalleryAdminCatalog } from '../build-gallery-admin-catalog.mjs';
import { repoRoot } from '../export-bundle-tools.mjs';
import { prepareGalleryManifestCandidate } from './candidate-manifest.mjs';
import {
    createGalleryReviewOpenEvidenceHash,
    createOrReconcileGalleryReview,
    reconcileStoredGalleryReview
} from './github-review-client.mjs';
import { processGalleryPhoto } from './processor.mjs';

const draftIdPattern = /^draft_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const runIdPattern = /^run_[a-f0-9]{12}4[a-f0-9]{3}[89ab][a-f0-9]{15}$/;
const commitShaPattern = /^[a-f0-9]{40}$/i;
const sha256Pattern = /^[a-f0-9]{64}$/;
const workflowRunReferencePattern =
    /^https:\/\/github\.com\/johnkevan88888\/family-running\/actions\/runs\/[1-9][0-9]*\/attempts\/[1-9][0-9]*$/;
const serviceKeys = Object.freeze(['origin', 'clientId', 'clientSecret']);
const optionKeys = Object.freeze([
    'draftId',
    'expectedBaseSha',
    'workflowRunReference',
    'githubToken',
    'processing',
    'promotion',
    'fetchImpl',
    'root',
    'processPhoto',
    'createReview',
    'reconcileReview'
]);

/**
 * Turn one already-approved private photo draft into one unmerged Gallery PR.
 * The only owner-controlled publication input is draftId. All destination,
 * event, distance, athlete, consent, and exclusion facts come from D1 through
 * the two protected service origins.
 */
export async function runPhotoReviewBridge(options) {
    validateOptions(options);
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const processPhoto = options.processPhoto || processGalleryPhoto;
    const createReview = options.createReview || createOrReconcileGalleryReview;
    const reconcileReview = options.reconcileReview || reconcileStoredGalleryReview;
    const root = path.resolve(options.root || repoRoot);
    const processingClient = serviceClient(options.processing, fetchImpl);
    const promotionClient = serviceClient(options.promotion, fetchImpl);
    const draftPath = encodeURIComponent(options.draftId);

    const eligibility = await processingClient.json(
        'GET',
        `/api/service/drafts/${draftPath}/photo-processing-eligibility`
    );
    assertEligibility(eligibility, options.draftId);

    const startKey = operationKey('photo-start', options.draftId, eligibility.stateVersion);
    const run = await processingClient.json(
        'POST',
        `/api/service/drafts/${draftPath}/processing-runs`,
        {
            expectedStateVersion: eligibility.stateVersion,
            idempotencyKey: startKey
        }
    );
    assertProcessingRun(run, options.draftId);

    let processed;
    try {
        const sourceResponse = await processingClient.raw('GET', run.source.downloadPath);
        if (sourceResponse.headers.get('Content-Length') !== String(run.source.byteLength)) {
            throw new Error('The private-photo response length does not match its bound evidence.');
        }
        const sourceBytes = Buffer.from(await sourceResponse.arrayBuffer());
        assertSourceResponse(sourceResponse, sourceBytes, run.source);
        processed = await processPhoto({
            sourceBytes,
            fileExtension: run.source.fileExtension,
            declaredMimeType: run.source.declaredMimeType,
            expectedSha256: run.source.sha256,
            draftBinding: {
                site: run.site,
                draftId: options.draftId,
                processingRunId: run.processingRunId
            }
        });
        assertProcessedPhoto(processed, run, options.draftId);

        for (const derivative of processed.derivatives) {
            const bytes = Buffer.from(await derivative.payload.arrayBuffer());
            await processingClient.raw(
                'PUT',
                `/api/service/processing-runs/${encodeURIComponent(run.processingRunId)}` +
                    `/derivatives/${encodeURIComponent(derivative.storageRole)}`,
                bytes,
                {
                    'Content-Type': 'image/webp',
                    'Content-Length': String(bytes.byteLength),
                    'X-Gallery-Content-SHA256': derivative.sha256,
                    'Idempotency-Key': operationKey(
                        `photo-${derivative.storageRole}`,
                        options.draftId,
                        run.stateVersion
                    )
                }
            );
        }
    } catch (error) {
        await failAndCleanProcessing(processingClient, run, options.draftId, error);
        throw error;
    }

    const staged = await processingClient.json(
        'POST',
        `/api/service/processing-runs/${encodeURIComponent(run.processingRunId)}/result`,
        stagedResult(run, processed, options.draftId)
    );
    if (staged?.status !== 'staged' || staged.stateVersion !== run.stateVersion) {
        throw new Error('The processing service did not confirm the exact staged photo run.');
    }

    const expectedCandidateStateVersion = staged.stateVersion + 1;
    let currentCandidate;
    let candidateResult;
    let reservation;
    let preparationStage = 'promotion';
    try {
        const candidateBeforeReview = await promoteCandidateWithOneRetry({
            promotionClient,
            draftPath,
            draftId: options.draftId,
            stagedStateVersion: staged.stateVersion
        });
        preparationStage = 'candidate-readback';
        const candidateRead = await promotionClient.json(
            'GET',
            `/api/service/drafts/${draftPath}/photo-candidate`
        );
        currentCandidate = exactCandidate(candidateRead?.candidate);
        assertSameCandidate(candidateBeforeReview, currentCandidate);
        if (currentCandidate.draft.stateVersion !== expectedCandidateStateVersion) {
            throw new Error('The promoted Gallery candidate has an unexpected state version.');
        }

        preparationStage = 'manifest-preparation';
        const manifestsBySite = await readCurrentManifests(root);
        const catalogSnapshot = await buildGalleryAdminCatalog(root);
        candidateResult = prepareGalleryManifestCandidate(currentCandidate, {
            catalogSnapshot,
            manifestsBySite,
            replayReceipt: null
        });
        if (!candidateResult.changed) {
            throw new Error('The approved Gallery photo is already present on current main.');
        }

        preparationStage = 'review-reservation';
        reservation = await reserveReviewWithOneRetry({
            promotionClient,
            draftPath,
            currentCandidate,
            candidateResult,
            options,
            run
        });
    } catch (preReviewError) {
        try {
            await compensateAbandonedCandidate({
                promotionClient,
                processingClient,
                run,
                draftId: options.draftId,
                expectedStateVersion: expectedCandidateStateVersion,
                failureStage: preparationStage
            });
        } catch (compensationError) {
            throw new AggregateError(
                [preReviewError, compensationError],
                'The Gallery candidate could not reach review and its durable cleanup could not be completed.'
            );
        }
        throw new Error(
            'The Gallery candidate could not reach review; approved media and staging cleanup were confirmed.',
            { cause: preReviewError }
        );
    }

    let review = null;
    try {
        review = await createReview(candidateResult, {
            expectedBaseSha: options.expectedBaseSha,
            token: options.githubToken,
            fetchImpl
        });

        // A consent withdrawal or new exclusion may land while GitHub is
        // creating the branch and PR. The open receipt is written only after
        // this complete D1/R2 reread still matches the reserved candidate.
        const candidateAfterReview = exactCandidate((await promotionClient.json(
            'GET',
            `/api/service/drafts/${draftPath}/photo-candidate`
        ))?.candidate);
        assertSameCandidate(currentCandidate, candidateAfterReview);

        const openedResponse = await promotionClient.json(
            'POST',
            `/api/service/photo-reviews/${encodeURIComponent(reservation.reviewId)}/open`,
            {
                expectedStateVersion: reservation.candidateStateVersion,
                headSha: review.headSha,
                pullRequestNumber: review.pullRequest.number,
                pullRequestUrl: review.pullRequest.url,
                openEvidenceHash: createGalleryReviewOpenEvidenceHash(review),
                idempotencyKey: operationKey(
                    'photo-review-open',
                    options.draftId,
                    reservation.candidateStateVersion
                )
            }
        );
        assertOpenedReview(openedResponse?.review, reservation, review);
    } catch (reviewError) {
        try {
            await compensateFailedReview({
                promotionClient,
                processingClient,
                reservation,
                review,
                run,
                draftId: options.draftId,
                token: options.githubToken,
                fetchImpl,
                reconcileReview
            });
        } catch (compensationError) {
            throw new AggregateError(
                [reviewError, compensationError],
                'The Gallery review failed and its terminal cleanup could not be completed.'
            );
        }
        throw new Error(
            'The Gallery review failed; its exact PR operation was reconciled and approved media cleanup was requested.',
            { cause: reviewError }
        );
    }

    return Object.freeze({
        schemaVersion: '1.0',
        draftId: options.draftId,
        itemId: candidateResult.itemId,
        targetRelativePath: candidateResult.targetRelativePath,
        manifestSha256: candidateResult.manifestSha256,
        pullRequest: review.pullRequest
    });
}

function serviceClient(configuration, fetchImpl) {
    const origin = normalizeOrigin(configuration.origin);
    const accessHeaders = {
        'CF-Access-Client-Id': configuration.clientId,
        'CF-Access-Client-Secret': configuration.clientSecret
    };
    return {
        async raw(method, requestPath, body = undefined, extraHeaders = {}) {
            const response = await fetchImpl(`${origin}${requestPath}`, {
                method,
                headers: { ...accessHeaders, ...extraHeaders },
                body,
                redirect: 'error'
            });
            if (!(response instanceof Response) || !response.ok) {
                throw new Error(`Protected Gallery service request failed with status ${response?.status || 503}.`);
            }
            return response;
        },
        async json(method, requestPath, body = undefined) {
            let payload;
            const headers = {};
            if (body !== undefined) {
                payload = JSON.stringify(body);
                headers['Content-Type'] = 'application/json';
                headers['Content-Length'] = String(Buffer.byteLength(payload));
            }
            const response = await this.raw(method, requestPath, payload, headers);
            if (response.headers.get('Content-Type')?.split(';')[0] !== 'application/json') {
                throw new Error('Protected Gallery service returned a non-JSON response.');
            }
            return response.json();
        }
    };
}

async function failAndCleanProcessing(client, run, draftId, error) {
    const allowedCodes = new Set([
        'cleanup-failed',
        'derivative-rejected',
        'invalid-media',
        'metadata-scan-failed',
        'processing-failed',
        'source-rejected',
        'toolchain-unavailable'
    ]);
    const errorCode = allowedCodes.has(error?.code) ? error.code : 'processing-failed';
    try {
        const failed = await client.json(
            'POST',
            `/api/service/processing-runs/${encodeURIComponent(run.processingRunId)}/result`,
            {
                outcome: 'failed',
                expectedStateVersion: run.stateVersion,
                idempotencyKey: operationKey('photo-failed', draftId, run.stateVersion),
                errorCode
            }
        );
        if (failed?.state === 'processing-failed' && Number.isSafeInteger(failed.stateVersion)) {
            await client.json(
                'POST',
                `/api/service/processing-runs/${encodeURIComponent(run.processingRunId)}/cleanup`,
                {
                    expectedStateVersion: failed.stateVersion,
                    idempotencyKey: operationKey('photo-cleanup', draftId, failed.stateVersion)
                }
            );
        }
    } catch {
        // Preserve the original safe processing failure. Server-side retention
        // and retry evidence remain authoritative if cleanup could not finish.
    }
}

function stagedResult(run, processed, draftId) {
    return {
        outcome: 'staged',
        expectedStateVersion: run.stateVersion,
        idempotencyKey: operationKey('photo-staged', draftId, run.stateVersion),
        source: {
            sha256: processed.source.sha256,
            byteLength: processed.source.byteLength,
            detectedFormat: processed.source.detectedFormat
        },
        toolchain: { ...processed.toolchain },
        derivatives: processed.derivatives.map(derivative => ({
            role: derivative.storageRole,
            sha256: derivative.sha256,
            byteLength: derivative.byteLength,
            width: derivative.width,
            height: derivative.height,
            durationMilliseconds: null,
            metadataEntryCount: derivative.metadataEntryCount,
            metadataFindingCategories: []
        }))
    };
}

async function readCurrentManifests(root) {
    const values = {};
    for (const site of ['family', 'everyone']) {
        const text = await fs.readFile(path.join(root, 'gallery-data', `${site}.json`), 'utf8');
        values[site] = JSON.parse(text);
    }
    return values;
}

async function reserveReviewWithOneRetry({
    promotionClient,
    draftPath,
    currentCandidate,
    candidateResult,
    options,
    run
}) {
    const body = {
        expectedStateVersion: currentCandidate.draft.stateVersion,
        baseSha: options.expectedBaseSha.toLowerCase(),
        manifestSha256: candidateResult.manifestSha256,
        workflowRunReference: options.workflowRunReference,
        idempotencyKey: operationKey(
            'photo-review-reserve',
            options.draftId,
            currentCandidate.draft.stateVersion
        )
    };
    const attempt = async () => exactReviewReservation(
        (await promotionClient.json(
            'POST',
            `/api/service/drafts/${draftPath}/photo-review-reservations`,
            body
        ))?.review,
        currentCandidate,
        candidateResult,
        options,
        run
    );
    try {
        return await attempt();
    } catch (firstError) {
        try {
            return await attempt();
        } catch (secondError) {
            try {
                const recovered = await promotionClient.json(
                    'GET',
                    `/api/service/drafts/${draftPath}/photo-review-invalidation`
                );
                return exactRecoveredReservation(
                    recovered,
                    currentCandidate,
                    candidateResult,
                    options,
                    run
                );
            } catch (recoveryError) {
                throw new AggregateError(
                    [firstError, secondError, recoveryError],
                    'The exact Gallery review reservation could not be confirmed.'
                );
            }
        }
    }
}

async function promoteCandidateWithOneRetry({
    promotionClient,
    draftPath,
    draftId,
    stagedStateVersion
}) {
    const body = {
        expectedStateVersion: stagedStateVersion,
        idempotencyKey: operationKey(
            'photo-promotion',
            draftId,
            stagedStateVersion
        )
    };
    const attempt = async () => exactCandidate((await promotionClient.json(
        'POST',
        `/api/service/drafts/${draftPath}/photo-promotions`,
        body
    ))?.candidate);
    try {
        return await attempt();
    } catch (firstError) {
        try {
            return await attempt();
        } catch (secondError) {
            throw new AggregateError(
                [firstError, secondError],
                'The exact promoted Gallery candidate could not be confirmed.'
            );
        }
    }
}

async function compensateAbandonedCandidate({
    promotionClient,
    processingClient,
    run,
    draftId,
    expectedStateVersion,
    failureStage
}) {
    const failureEvidenceHash = createHash('sha256')
        .update('family-running-gallery-review-abandonment-v1\0', 'utf8')
        .update(draftId, 'utf8')
        .update('\0', 'utf8')
        .update(run.processingRunId, 'utf8')
        .update('\0', 'utf8')
        .update(String(expectedStateVersion), 'utf8')
        .update('\0', 'utf8')
        .update(failureStage, 'utf8')
        .digest('hex');
    const response = await promotionClient.json(
        'POST',
        `/api/service/drafts/${encodeURIComponent(draftId)}/photo-review-abandonment`,
        {
            expectedStateVersion,
            failureEvidenceHash,
            idempotencyKey: operationKey(
                'photo-review-abandonment',
                draftId,
                expectedStateVersion
            )
        }
    );
    if (
        response?.abandonment?.draftId !== draftId ||
        response.abandonment.processingRunId !== run.processingRunId ||
        response.abandonment.expectedStateVersion !== expectedStateVersion ||
        response.abandonment.resultStateVersion !== expectedStateVersion + 1 ||
        response.abandonment.failureEvidenceHash !== failureEvidenceHash ||
        response.abandonment.status !== 'withdrawal-pending'
    ) {
        throw new Error('The review service did not persist exact candidate-abandonment evidence.');
    }
    await performMediaCleanup({
        promotionClient,
        processingClient,
        cleanup: response.cleanup,
        processingCleanup: response.processingCleanup,
        expectedPromotionId: response.abandonment.promotionId,
        expectedProcessingRunId: run.processingRunId
    });
}

async function compensateFailedReview({
    promotionClient,
    processingClient,
    reservation,
    run,
    draftId,
    token,
    fetchImpl,
    reconcileReview
}) {
    const invalidation = await startAndReadReviewInvalidation({
        promotionClient,
        reservation,
        draftId
    });

    // Privacy first: once D1 has recorded the one-way withdrawal intent, an
    // unavailable GitHub API must not keep the approved derivative reachable.
    await cleanApprovedMedia(
        promotionClient,
        invalidation.invalidation.cleanup,
        reservation.promotionId
    );

    const terminal = await reconcileReview(
        storedReviewEvidence(invalidation.review),
        { token, fetchImpl }
    );
    const terminalResponse = await promotionClient.json(
        'POST',
        `/api/service/photo-reviews/${encodeURIComponent(reservation.reviewId)}/terminal`,
        {
            terminalKind: terminal.terminalKind,
            terminalEvidenceHash: terminal.terminalEvidenceHash,
            closeEvidenceHash: terminal.closeEvidenceHash,
            readbackEvidenceHash: terminal.readbackEvidenceHash,
            headSha: terminal.terminalKind === 'closed-unmerged'
                ? terminal.headSha
                : null,
            pullRequestNumber: terminal.terminalKind === 'closed-unmerged'
                ? terminal.pullRequest?.number
                : null,
            pullRequestUrl: terminal.terminalKind === 'closed-unmerged'
                ? terminal.pullRequest?.url
                : null,
            idempotencyKey: operationKey(
                'photo-review-terminal',
                draftId,
                reservation.candidateStateVersion
            )
        }
    );
    assertTerminalReview(terminalResponse?.review, reservation, terminal);

    await cleanPrivateStaging(
        processingClient,
        invalidation.invalidation.processingCleanup,
        run.processingRunId
    );
}

async function startAndReadReviewInvalidation({
    promotionClient,
    reservation,
    draftId
}) {
    const body = {
        expectedStateVersion: reservation.candidateStateVersion,
        idempotencyKey: operationKey(
            'photo-review-invalidation-start',
            draftId,
            reservation.candidateStateVersion
        )
    };
    const requestPath =
        `/api/service/photo-reviews/${encodeURIComponent(reservation.reviewId)}` +
        '/invalidation-start';
    const attempt = async () => exactInvalidationStart(
        await promotionClient.json('POST', requestPath, body),
        reservation
    );
    let start;
    try {
        start = await attempt();
    } catch (firstError) {
        try {
            start = await attempt();
        } catch (secondError) {
            try {
                return exactReviewInvalidation(
                    await promotionClient.json(
                        'GET',
                        `/api/service/drafts/${encodeURIComponent(draftId)}` +
                            '/photo-review-invalidation'
                    ),
                    reservation
                );
            } catch (recoveryError) {
                throw new AggregateError(
                    [firstError, secondError, recoveryError],
                    'The durable Gallery review invalidation could not be confirmed.'
                );
            }
        }
    }

    const persisted = exactReviewInvalidation(
        await promotionClient.json(
            'GET',
            `/api/service/drafts/${encodeURIComponent(draftId)}` +
                '/photo-review-invalidation'
        ),
        reservation
    );
    if (
        withdrawalPriority(persisted.invalidation.withdrawalKind) <
            withdrawalPriority(start.withdrawalKind) ||
        persisted.invalidation.cleanup.expectedStateVersion !== start.resultStateVersion
    ) {
        throw new Error('The durable Gallery invalidation readback changed after it started.');
    }
    return persisted;
}

function exactInvalidationStart(value, reservation) {
    if (!exactKeys(value, ['invalidationStart', 'replayed', 'review'])) {
        throw new Error('The Gallery invalidation-start response shape is invalid.');
    }
    const review = exactReviewReceipt(value.review, reservation, ['reserved', 'open']);
    const start = value.invalidationStart;
    if (
        typeof value.replayed !== 'boolean' ||
        !exactKeys(start, [
            'cleanup', 'expectedStateVersion', 'processingCleanup',
            'resultStateVersion', 'withdrawalKind'
        ]) ||
        !['editorial-removal', 'athlete-exclusion', 'consent-withdrawal']
            .includes(start.withdrawalKind) ||
        start.expectedStateVersion !== reservation.candidateStateVersion ||
        start.resultStateVersion !== reservation.candidateStateVersion + 1 ||
        !validCleanupPackages(
            start.cleanup,
            start.processingCleanup,
            reservation.promotionId,
            reservation.processingRunId,
            start.resultStateVersion
        )
    ) {
        throw new Error('The review service did not start the exact durable invalidation.');
    }
    return { review, ...start };
}

function exactReviewInvalidation(value, reservation) {
    if (
        !exactKeys(value, ['invalidation', 'receiptKind', 'replayed', 'review']) ||
        value.receiptKind !== 'review' ||
        value.replayed !== true
    ) {
        throw new Error('The review service did not return a durable review receipt.');
    }
    const review = exactReviewReceipt(value.review, reservation, ['reserved', 'open']);
    const invalidation = value.invalidation;
    if (
        !exactKeys(invalidation, [
            'cleanup', 'processingCleanup', 'terminalKind', 'withdrawalKind'
        ]) ||
        !['editorial-removal', 'athlete-exclusion', 'consent-withdrawal']
            .includes(invalidation.withdrawalKind) ||
        !['closed-unmerged', 'no-pr-created'].includes(invalidation.terminalKind) ||
        !validCleanupPackages(
            invalidation.cleanup,
            invalidation.processingCleanup,
            reservation.promotionId,
            reservation.processingRunId,
            reservation.candidateStateVersion + 1
        )
    ) {
        throw new Error('The review service did not return exact invalidation cleanup.');
    }
    return { review, invalidation };
}

async function performMediaCleanup({
    promotionClient,
    processingClient,
    cleanup,
    processingCleanup,
    expectedPromotionId,
    expectedProcessingRunId
}) {
    if (!validCleanupPackages(
        cleanup,
        processingCleanup,
        expectedPromotionId,
        expectedProcessingRunId
    )) throw new Error('The Gallery cleanup package is invalid.');
    await cleanApprovedMedia(promotionClient, cleanup, expectedPromotionId);
    await cleanPrivateStaging(
        processingClient,
        processingCleanup,
        expectedProcessingRunId
    );
}

async function cleanApprovedMedia(client, cleanup, expectedPromotionId) {
    if (
        !plainObject(cleanup) ||
        cleanup.promotionId !== expectedPromotionId ||
        !Number.isSafeInteger(cleanup.expectedStateVersion) ||
        !/^photo-review-cleanup-[a-f0-9]{32}$/.test(cleanup.idempotencyKey || '')
    ) throw new Error('The approved Gallery cleanup package is invalid.');
    const promotionCleanup = await client.json(
        'POST',
        `/api/service/photo-promotions/${encodeURIComponent(cleanup.promotionId)}/cleanup`,
        {
            expectedStateVersion: cleanup.expectedStateVersion,
            idempotencyKey: cleanup.idempotencyKey
        }
    );
    if (
        promotionCleanup?.promotionId !== cleanup.promotionId ||
        promotionCleanup?.promotionStatus !== 'cleaned'
    ) {
        throw new Error('Approved Gallery media cleanup was not confirmed.');
    }
}

async function cleanPrivateStaging(client, processingCleanup, expectedProcessingRunId) {
    if (
        !plainObject(processingCleanup) ||
        processingCleanup.processingRunId !== expectedProcessingRunId ||
        !Number.isSafeInteger(processingCleanup.expectedStateVersion) ||
        !/^photo-review-staging-[a-f0-9]{32}$/.test(
            processingCleanup.idempotencyKey || ''
        )
    ) throw new Error('The private Gallery cleanup package is invalid.');
    const processingResult = await client.json(
        'POST',
        `/api/service/processing-runs/${encodeURIComponent(processingCleanup.processingRunId)}/cleanup`,
        {
            expectedStateVersion: processingCleanup.expectedStateVersion,
            idempotencyKey: processingCleanup.idempotencyKey
        }
    );
    if (
        processingResult?.processingRunId !== processingCleanup.processingRunId ||
        processingResult?.status !== 'cleaned'
    ) {
        throw new Error('Private Gallery staging cleanup was not confirmed.');
    }
}

function validCleanupPackages(
    cleanup,
    processingCleanup,
    expectedPromotionId,
    expectedProcessingRunId,
    expectedStateVersion = undefined
) {
    return plainObject(cleanup) &&
        cleanup.promotionId === expectedPromotionId &&
        Number.isSafeInteger(cleanup.expectedStateVersion) &&
        (expectedStateVersion === undefined ||
            cleanup.expectedStateVersion === expectedStateVersion) &&
        /^photo-review-cleanup-[a-f0-9]{32}$/.test(cleanup.idempotencyKey || '') &&
        plainObject(processingCleanup) &&
        processingCleanup.processingRunId === expectedProcessingRunId &&
        processingCleanup.expectedStateVersion === cleanup.expectedStateVersion &&
        /^photo-review-staging-[a-f0-9]{32}$/.test(
            processingCleanup.idempotencyKey || ''
        );
}

function exactReviewReservation(value, candidate, candidateResult, options, run) {
    const promotionId = candidate?.operationId;
    const expectedBranch = deriveReviewBranch(promotionId);
    const expectedMarker = createHash('sha256')
        .update('family-running-gallery-review-operation-v1\0', 'utf8')
        .update(promotionId || '', 'utf8')
        .digest('hex');
    if (
        !plainObject(value) ||
        !/^review_[a-f0-9]{32}$/.test(value.reviewId || '') ||
        value.draftId !== options.draftId ||
        value.promotionId !== promotionId ||
        value.processingRunId !== run.processingRunId ||
        value.candidateStateVersion !== candidate?.draft?.stateVersion ||
        !sha256Pattern.test(value.candidatePayloadHash || '') ||
        !sha256Pattern.test(value.generationFingerprint || '') ||
        value.repository !== 'johnkevan88888/family-running' ||
        value.baseRef !== 'main' ||
        value.baseSha !== options.expectedBaseSha.toLowerCase() ||
        value.branchRef !== expectedBranch ||
        value.targetRelativePath !== candidateResult.targetRelativePath ||
        value.itemId !== candidateResult.itemId ||
        value.manifestSha256 !== candidateResult.manifestSha256 ||
        value.operationMarkerHash !== expectedMarker ||
        value.workflowRunReference !== options.workflowRunReference ||
        value.status !== 'reserved' ||
        value.pullRequestNumber !== null ||
        value.pullRequestUrl !== null ||
        value.headSha !== null
    ) {
        throw new Error('The review service did not reserve the exact Gallery candidate.');
    }
    return value;
}

function exactRecoveredReservation(value, candidate, candidateResult, options, run) {
    if (
        !exactKeys(value, ['invalidation', 'receiptKind', 'replayed', 'review']) ||
        value.receiptKind !== 'review' ||
        value.replayed !== true ||
        value.invalidation !== null
    ) {
        throw new Error('The review service did not return an exact reserved receipt.');
    }
    return exactReviewReservation(
        value.review,
        candidate,
        candidateResult,
        options,
        run
    );
}

function exactReviewReceipt(value, reservation, allowedStatuses) {
    const keys = [
        'baseRef', 'baseSha', 'branchRef', 'candidatePayloadHash',
        'candidateStateVersion', 'closeEvidenceHash', 'draftId',
        'generationFingerprint', 'headSha', 'itemId', 'manifestSha256',
        'openEvidenceHash', 'operationMarkerHash', 'promotionId',
        'processingRunId', 'pullRequestNumber', 'pullRequestUrl',
        'readbackEvidenceHash', 'repository', 'reviewId', 'schemaVersion',
        'status', 'targetRelativePath', 'terminalEvidenceHash', 'terminalKind',
        'workflowRunReference'
    ];
    if (
        !exactKeys(value, keys) ||
        !allowedStatuses.includes(value.status) ||
        value.schemaVersion !== '1.0' ||
        value.reviewId !== reservation.reviewId ||
        value.draftId !== reservation.draftId ||
        value.promotionId !== reservation.promotionId ||
        value.processingRunId !== reservation.processingRunId ||
        value.candidateStateVersion !== reservation.candidateStateVersion ||
        value.candidatePayloadHash !== reservation.candidatePayloadHash ||
        value.generationFingerprint !== reservation.generationFingerprint ||
        value.repository !== reservation.repository ||
        value.baseRef !== reservation.baseRef ||
        value.baseSha !== reservation.baseSha ||
        value.branchRef !== reservation.branchRef ||
        value.targetRelativePath !== reservation.targetRelativePath ||
        value.itemId !== reservation.itemId ||
        value.manifestSha256 !== reservation.manifestSha256 ||
        value.operationMarkerHash !== reservation.operationMarkerHash ||
        value.workflowRunReference !== reservation.workflowRunReference ||
        value.terminalKind !== null ||
        value.terminalEvidenceHash !== null ||
        value.closeEvidenceHash !== null ||
        value.readbackEvidenceHash !== null
    ) {
        throw new Error('The Gallery review receipt changed after reservation.');
    }
    const noPull = value.pullRequestNumber === null &&
        value.pullRequestUrl === null && value.headSha === null;
    if (value.status === 'reserved' && noPull && value.openEvidenceHash === null) {
        return value;
    }
    if (
        value.status === 'open' &&
        Number.isSafeInteger(value.pullRequestNumber) &&
        value.pullRequestNumber >= 1 &&
        value.pullRequestUrl ===
            `https://github.com/johnkevan88888/family-running/pull/${value.pullRequestNumber}` &&
        commitShaPattern.test(value.headSha || '') &&
        sha256Pattern.test(value.openEvidenceHash || '')
    ) return value;
    throw new Error('The Gallery review receipt lifecycle is invalid.');
}

function assertTerminalReview(value, reservation, terminal) {
    if (
        !plainObject(value) ||
        value.reviewId !== reservation.reviewId ||
        value.draftId !== reservation.draftId ||
        value.promotionId !== reservation.promotionId ||
        value.processingRunId !== reservation.processingRunId ||
        value.status !== 'terminal' ||
        value.terminalKind !== terminal.terminalKind ||
        value.terminalEvidenceHash !== terminal.terminalEvidenceHash ||
        value.closeEvidenceHash !== terminal.closeEvidenceHash ||
        value.readbackEvidenceHash !== terminal.readbackEvidenceHash ||
        value.headSha !== (terminal.terminalKind === 'closed-unmerged'
            ? terminal.headSha
            : null) ||
        value.pullRequestNumber !== (terminal.terminalKind === 'closed-unmerged'
            ? terminal.pullRequest?.number
            : null) ||
        value.pullRequestUrl !== (terminal.terminalKind === 'closed-unmerged'
            ? terminal.pullRequest?.url
            : null)
    ) {
        throw new Error('The review service did not persist exact terminal PR evidence.');
    }
}

function assertOpenedReview(value, reservation, review) {
    if (
        !plainObject(value) ||
        value.reviewId !== reservation.reviewId ||
        value.status !== 'open' ||
        value.headSha !== review.headSha ||
        value.pullRequestNumber !== review.pullRequest.number ||
        value.pullRequestUrl !== review.pullRequest.url ||
        value.openEvidenceHash !== createGalleryReviewOpenEvidenceHash(review)
    ) {
        throw new Error('The review service did not record the exact open Pull Request.');
    }
}

function storedReviewEvidence(review) {
    return {
        schemaVersion: '1.0',
        promotionId: review.promotionId,
        repository: review.repository,
        baseRef: review.baseRef,
        baseSha: review.baseSha,
        branchRef: review.branchRef,
        headSha: review.status === 'open' ? review.headSha : null,
        targetRelativePath: review.targetRelativePath,
        itemId: review.itemId,
        manifestSha256: review.manifestSha256,
        operationMarkerHash: review.operationMarkerHash,
        pullRequest: review.status === 'open'
            ? {
                number: review.pullRequestNumber,
                url: review.pullRequestUrl,
                state: 'open'
            }
            : null
    };
}

function exactKeys(value, keys) {
    return plainObject(value) &&
        Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function withdrawalPriority(value) {
    return {
        'editorial-removal': 1,
        'athlete-exclusion': 2,
        'consent-withdrawal': 3
    }[value] || 0;
}

function deriveReviewBranch(promotionId) {
    if (typeof promotionId !== 'string') return null;
    const digest = createHash('sha256')
        .update('family-running-gallery-review-branch-v1\0', 'utf8')
        .update(promotionId, 'utf8')
        .digest('hex')
        .slice(0, 32);
    return `gallery-media/candidate-${digest}`;
}

function validateOptions(options) {
    if (!plainObject(options) || Object.keys(options).some(key => !optionKeys.includes(key))) {
        throw new Error('The photo review bridge options are invalid.');
    }
    if (
        !draftIdPattern.test(options.draftId || '') ||
        !commitShaPattern.test(options.expectedBaseSha || '') ||
        !workflowRunReferencePattern.test(options.workflowRunReference || '') ||
        typeof options.githubToken !== 'string' ||
        options.githubToken.length < 1 ||
        typeof (options.fetchImpl || globalThis.fetch) !== 'function' ||
        (options.processPhoto !== undefined && typeof options.processPhoto !== 'function') ||
        (options.createReview !== undefined && typeof options.createReview !== 'function') ||
        (options.reconcileReview !== undefined && typeof options.reconcileReview !== 'function')
    ) {
        throw new Error('The photo review bridge configuration is invalid.');
    }
    validateService(options.processing);
    validateService(options.promotion);
}

function validateService(value) {
    if (
        !plainObject(value) ||
        Object.keys(value).sort().join(',') !== [...serviceKeys].sort().join(',') ||
        normalizeOrigin(value.origin) === null ||
        !safeSecret(value.clientId) ||
        !safeSecret(value.clientSecret)
    ) {
        throw new Error('A protected Gallery service configuration is invalid.');
    }
}

function normalizeOrigin(value) {
    try {
        const url = new URL(value);
        return typeof value === 'string' && value === url.origin && url.protocol === 'https:'
            ? url.origin
            : null;
    } catch {
        return null;
    }
}

function safeSecret(value) {
    return typeof value === 'string' && value.length >= 1 && value.length <= 4096 &&
        !/[\u0000-\u001f\u007f]/.test(value);
}

function assertEligibility(value, draftId) {
    if (
        !plainObject(value) ||
        value.schemaVersion !== '1.0' ||
        value.draftId !== draftId ||
        value.state !== 'approved-for-processing' ||
        !Number.isSafeInteger(value.stateVersion) ||
        value.stateVersion < 0
    ) throw new Error('The processing service did not return current photo eligibility.');
}

function assertProcessingRun(run, draftId) {
    if (
        !plainObject(run) ||
        run.scope !== 'photo-processing-v1' ||
        !['family', 'everyone'].includes(run.site) ||
        run.mediaType !== 'photo' ||
        run.state !== 'processing' ||
        !Number.isSafeInteger(run.stateVersion) ||
        !runIdPattern.test(run.processingRunId || '') ||
        !plainObject(run.source) ||
        !sha256Pattern.test(run.source.sha256 || '') ||
        !Number.isSafeInteger(run.source.byteLength) ||
        run.source.byteLength < 1 ||
        run.source.byteLength > 25 * 1024 * 1024 ||
        !['jpg', 'png'].includes(run.source.fileExtension) ||
        !['image/jpeg', 'image/png'].includes(run.source.declaredMimeType) ||
        run.source.declaredMimeType !==
            (run.source.fileExtension === 'jpg' ? 'image/jpeg' : 'image/png') ||
        run.source.downloadPath !==
            `/api/service/processing-runs/${run.processingRunId}/original`
    ) throw new Error(`The processing service returned an invalid run for ${draftId}.`);
}

function assertSourceResponse(response, bytes, source) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (
        response.headers.get('Cache-Control') !== 'no-store' ||
        response.headers.get('Content-Length') !== String(source.byteLength) ||
        response.headers.get('X-Gallery-Content-SHA256') !== source.sha256 ||
        response.headers.get('Content-Type') !== source.declaredMimeType ||
        bytes.byteLength !== source.byteLength ||
        digest !== source.sha256
    ) throw new Error('The downloaded private photo did not match its bound upload evidence.');
}

function assertProcessedPhoto(processed, run, draftId) {
    const roles = processed?.derivatives?.map(value => value.storageRole).sort();
    if (
        processed?.scope !== 'photo-processing-v1' ||
        processed?.draftId !== draftId ||
        processed?.inheritedSite !== run.site ||
        processed?.processingRunId !== run.processingRunId ||
        processed?.source?.sha256 !== run.source.sha256 ||
        JSON.stringify(roles) !== JSON.stringify(['photo-display', 'photo-thumbnail'])
    ) throw new Error('The pinned processor did not return the exact bound photo derivatives.');
}

function exactCandidate(candidate) {
    if (!plainObject(candidate) || candidate.schemaVersion !== '1.0') {
        throw new Error('The promotion service did not return a valid photo candidate.');
    }
    return candidate;
}

function assertSameCandidate(left, right) {
    if (JSON.stringify(left) !== JSON.stringify(right)) {
        throw new Error('The Gallery candidate changed during review generation.');
    }
}

function operationKey(label, draftId, stateVersion) {
    return `${label}-${createHash('sha256')
        .update(`${label}:${draftId}:${stateVersion}`)
        .digest('hex')
        .slice(0, 32)}`;
}

function plainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
        (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
