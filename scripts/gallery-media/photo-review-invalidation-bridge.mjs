import { createHash } from 'node:crypto';

import { reconcileStoredGalleryReview } from './github-review-client.mjs';

const DRAFT_ID_PATTERN =
    /^draft_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const REVIEW_ID_PATTERN = /^review_[a-f0-9]{32}$/;
const PROMOTION_ID_PATTERN = /^promotion_[a-f0-9]{32}$/;
const PROCESSING_RUN_ID_PATTERN =
    /^run_[a-f0-9]{12}4[a-f0-9]{3}[89ab][a-f0-9]{15}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SHA256_REVISION_PATTERN = /^sha256:[a-f0-9]{64}$/;
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const ITEM_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SERVICE_KEYS = Object.freeze(['origin', 'clientId', 'clientSecret']);
const OPTION_KEYS = Object.freeze([
    'draftId',
    'githubToken',
    'processing',
    'promotion',
    'fetchImpl',
    'reconcileReview'
]);
const REVIEW_KEYS = Object.freeze([
    'baseRef', 'baseSha', 'branchRef', 'candidatePayloadHash',
    'candidateStateVersion', 'closeEvidenceHash', 'draftId',
    'generationFingerprint', 'headSha', 'itemId', 'manifestSha256',
    'openEvidenceHash', 'operationMarkerHash', 'processingRunId',
    'promotionId', 'pullRequestNumber', 'pullRequestUrl',
    'readbackEvidenceHash', 'repository', 'reviewId', 'schemaVersion',
    'status', 'targetRelativePath', 'terminalEvidenceHash', 'terminalKind',
    'workflowRunReference'
]);
const ABANDONMENT_KEYS = Object.freeze([
    'draftId', 'expectedStateVersion', 'failureEvidenceHash',
    'processingRunId', 'promotionId', 'resultStateVersion', 'schemaVersion',
    'status'
]);

/**
 * Remove approved media for one owner-withdrawn draft, then close only its
 * exact immutable review operation. No caller chooses a site, manifest, PR,
 * branch, media key, athlete, or withdrawal reason.
 */
export async function runPhotoReviewInvalidationBridge(options) {
    validateOptions(options);
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const reconcileReview = options.reconcileReview || reconcileStoredGalleryReview;
    const promotionClient = serviceClient(options.promotion, fetchImpl);
    const processingClient = serviceClient(options.processing, fetchImpl);
    const draftPath = encodeURIComponent(options.draftId);

    const response = await promotionClient.json(
        'GET',
        `/api/service/drafts/${draftPath}/photo-review-invalidation`
    );
    const evidence = exactInvalidationReceipt(response, options.draftId);

    // Privacy-first: an unavailable GitHub API must never keep approved media
    // publicly reachable after the owner has already recorded withdrawal.
    await cleanApprovedMedia(promotionClient, evidence.cleanup);

    if (evidence.receiptKind === 'abandonment') {
        await cleanPrivateStaging(processingClient, evidence.processingCleanup);
        return Object.freeze({
            schemaVersion: '1.0',
            draftId: options.draftId,
            abandonmentStatus: evidence.abandonment.status,
            approvedMediaStatus: 'cleaned',
            stagingStatus: 'cleaned',
            branchState: 'no-reviewed-pr'
        });
    }

    let terminalReview = evidence.review;
    if (evidence.review.status !== 'terminal') {
        let terminal;
        try {
            terminal = await reconcileReview(storedReviewEvidence(evidence.review), {
                token: options.githubToken,
                fetchImpl
            });
        } catch (error) {
            throw new Error(
                'Approved Gallery media is removed, but exact Pull Request closure is still pending.',
                { cause: error }
            );
        }
        const terminalResponse = await promotionClient.json(
            'POST',
            `/api/service/photo-reviews/${encodeURIComponent(evidence.review.reviewId)}/terminal`,
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
                    options.draftId,
                    evidence.review.candidateStateVersion
                )
            }
        );
        terminalReview = exactTerminalReview(
            terminalResponse?.review,
            evidence.review,
            terminal
        );
    }

    await cleanPrivateStaging(
        processingClient,
        evidence.processingCleanup
    );

    return Object.freeze({
        schemaVersion: '1.0',
        draftId: options.draftId,
        reviewId: terminalReview.reviewId,
        terminalKind: terminalReview.terminalKind,
        withdrawalKind: evidence.invalidation.withdrawalKind,
        approvedMediaStatus: 'cleaned',
        stagingStatus: 'cleaned',
        branchState: terminalReview.terminalKind === 'closed-unmerged'
            ? 'retained-for-reviewed-cleanup'
            : 'no-reviewed-pr'
    });
}

/**
 * The protected runner must not copy a withdrawal category, draft/review ID,
 * branch, or any other receipt field into GitHub Actions logs.
 */
export function photoInvalidationCompletionSummary() {
    return Object.freeze({
        schemaVersion: '1.0',
        status: 'gallery-photo-invalidation-completed'
    });
}

function exactInvalidationReceipt(value, draftId) {
    if (!plainObject(value) || value.replayed !== true) {
        throw new Error('The review service did not return an exact invalidation receipt.');
    }
    if (value.receiptKind === 'review') {
        if (!hasExactKeys(value, ['receiptKind', 'review', 'invalidation', 'replayed'])) {
            throw new Error('The review service did not return an exact review invalidation receipt.');
        }
        const result = exactReviewInvalidation(value, draftId);
        return {
            receiptKind: 'review',
            ...result,
            cleanup: result.invalidation.cleanup,
            processingCleanup: result.invalidation.processingCleanup
        };
    }
    if (value.receiptKind === 'abandonment') {
        return exactAbandonmentInvalidation(value, draftId);
    }
    throw new Error('The review service returned an unsupported invalidation receipt.');
}

function exactReviewInvalidation(value, draftId) {
    const review = value?.review;
    const invalidation = value?.invalidation;
    if (
        !hasExactKeys(review, REVIEW_KEYS) ||
        review.schemaVersion !== '1.0' ||
        !REVIEW_ID_PATTERN.test(review.reviewId || '') ||
        review.draftId !== draftId ||
        !PROMOTION_ID_PATTERN.test(review.promotionId || '') ||
        !PROCESSING_RUN_ID_PATTERN.test(review.processingRunId || '') ||
        !Number.isSafeInteger(review.candidateStateVersion) ||
        review.candidateStateVersion < 1 ||
        !SHA256_PATTERN.test(review.candidatePayloadHash || '') ||
        !SHA256_PATTERN.test(review.generationFingerprint || '') ||
        review.repository !== 'johnkevan88888/family-running' ||
        review.baseRef !== 'main' ||
        !COMMIT_SHA_PATTERN.test(review.baseSha || '') ||
        !/^gallery-media\/candidate-[a-f0-9]{32}$/.test(review.branchRef || '') ||
        !['gallery-data/family.json', 'gallery-data/everyone.json']
            .includes(review.targetRelativePath) ||
        !ITEM_ID_PATTERN.test(review.itemId || '') ||
        !SHA256_REVISION_PATTERN.test(review.manifestSha256 || '') ||
        !SHA256_PATTERN.test(review.operationMarkerHash || '') ||
        !['reserved', 'open', 'terminal'].includes(review.status) ||
        !hasExactKeys(
            invalidation,
            ['cleanup', 'processingCleanup', 'terminalKind', 'withdrawalKind']
        ) ||
        !['editorial-removal', 'athlete-exclusion', 'consent-withdrawal']
            .includes(invalidation.withdrawalKind) ||
        invalidation.terminalKind !== expectedTerminalKind(review) ||
        !validCleanup(invalidation.cleanup, review.promotionId) ||
        !validProcessingCleanup(invalidation.processingCleanup, review.processingRunId) ||
        invalidation.cleanup.expectedStateVersion !==
            invalidation.processingCleanup.expectedStateVersion
    ) {
        throw new Error('The review service did not return exact invalidation evidence.');
    }
    validateReviewLifecycle(review);
    return { review, invalidation };
}

function exactAbandonmentInvalidation(value, draftId) {
    if (!hasExactKeys(
        value,
        ['receiptKind', 'abandonment', 'cleanup', 'processingCleanup', 'replayed']
    )) {
        throw new Error('The review service did not return an exact abandonment receipt.');
    }
    const abandonment = value.abandonment;
    if (
        !hasExactKeys(abandonment, ABANDONMENT_KEYS) ||
        abandonment.schemaVersion !== '1.0' ||
        abandonment.draftId !== draftId ||
        !PROMOTION_ID_PATTERN.test(abandonment.promotionId || '') ||
        !PROCESSING_RUN_ID_PATTERN.test(abandonment.processingRunId || '') ||
        !Number.isSafeInteger(abandonment.expectedStateVersion) ||
        abandonment.expectedStateVersion < 0 ||
        abandonment.resultStateVersion !== abandonment.expectedStateVersion + 1 ||
        !SHA256_PATTERN.test(abandonment.failureEvidenceHash || '') ||
        abandonment.status !== 'withdrawal-pending' ||
        !validCleanup(value.cleanup, abandonment.promotionId) ||
        value.cleanup.expectedStateVersion !== abandonment.resultStateVersion ||
        !validProcessingCleanup(value.processingCleanup, abandonment.processingRunId) ||
        value.processingCleanup.expectedStateVersion !== abandonment.resultStateVersion
    ) {
        throw new Error('The review service did not return exact abandonment evidence.');
    }
    return {
        receiptKind: 'abandonment',
        abandonment,
        cleanup: value.cleanup,
        processingCleanup: value.processingCleanup
    };
}

function validateReviewLifecycle(review) {
    const noPull = review.pullRequestNumber === null &&
        review.pullRequestUrl === null && review.headSha === null;
    const exactPull = Number.isSafeInteger(review.pullRequestNumber) &&
        review.pullRequestNumber >= 1 &&
        review.pullRequestUrl ===
            `https://github.com/johnkevan88888/family-running/pull/${review.pullRequestNumber}` &&
        COMMIT_SHA_PATTERN.test(review.headSha || '');
    if (review.status === 'reserved' && noPull) return;
    if (review.status === 'open' && exactPull && SHA256_PATTERN.test(
        review.openEvidenceHash || ''
    )) return;
    if (
        review.status === 'terminal' &&
        ['closed-unmerged', 'no-pr-created'].includes(review.terminalKind) &&
        SHA256_PATTERN.test(review.terminalEvidenceHash || '') &&
        (
            review.terminalKind === 'no-pr-created'
                ? noPull && review.closeEvidenceHash === null &&
                    review.readbackEvidenceHash === null
                : exactPull && SHA256_PATTERN.test(review.closeEvidenceHash || '') &&
                    SHA256_PATTERN.test(review.readbackEvidenceHash || '')
        )
    ) return;
    throw new Error('The stored Gallery review lifecycle evidence is invalid.');
}

function expectedTerminalKind(review) {
    return review.status === 'open'
        ? 'closed-unmerged'
        : review.status === 'reserved'
            ? 'no-pr-created'
            : review.terminalKind;
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

function exactTerminalReview(value, stored, terminal) {
    if (
        !plainObject(value) ||
        value.reviewId !== stored.reviewId ||
        value.draftId !== stored.draftId ||
        value.promotionId !== stored.promotionId ||
        value.processingRunId !== stored.processingRunId ||
        value.status !== 'terminal' ||
        value.terminalKind !== terminal.terminalKind ||
        value.terminalEvidenceHash !== terminal.terminalEvidenceHash ||
        value.closeEvidenceHash !== terminal.closeEvidenceHash ||
        value.readbackEvidenceHash !== terminal.readbackEvidenceHash
    ) throw new Error('The review service did not persist exact terminal evidence.');
    validateReviewLifecycle(value);
    return value;
}

async function cleanApprovedMedia(client, cleanup) {
    const result = await client.json(
        'POST',
        `/api/service/photo-promotions/${encodeURIComponent(cleanup.promotionId)}/cleanup`,
        {
            expectedStateVersion: cleanup.expectedStateVersion,
            idempotencyKey: cleanup.idempotencyKey
        }
    );
    if (
        result?.promotionId !== cleanup.promotionId ||
        result.promotionStatus !== 'cleaned'
    ) throw new Error('Approved Gallery media cleanup was not confirmed.');
}

async function cleanPrivateStaging(client, cleanup) {
    const result = await client.json(
        'POST',
        `/api/service/processing-runs/${encodeURIComponent(cleanup.processingRunId)}/cleanup`,
        {
            expectedStateVersion: cleanup.expectedStateVersion,
            idempotencyKey: cleanup.idempotencyKey
        }
    );
    if (
        result?.processingRunId !== cleanup.processingRunId ||
        result.status !== 'cleaned'
    ) throw new Error('Private Gallery staging cleanup was not confirmed.');
}

function validCleanup(value, promotionId) {
    return hasExactKeys(
        value,
        ['expectedStateVersion', 'idempotencyKey', 'promotionId']
    ) &&
        value.promotionId === promotionId &&
        Number.isSafeInteger(value.expectedStateVersion) &&
        value.expectedStateVersion >= 1 &&
        /^photo-review-cleanup-[a-f0-9]{32}$/.test(value.idempotencyKey || '');
}

function validProcessingCleanup(value, processingRunId) {
    return hasExactKeys(
        value,
        ['expectedStateVersion', 'idempotencyKey', 'processingRunId']
    ) &&
        value.processingRunId === processingRunId &&
        Number.isSafeInteger(value.expectedStateVersion) &&
        value.expectedStateVersion >= 1 &&
        /^photo-review-staging-[a-f0-9]{32}$/.test(value.idempotencyKey || '');
}

function serviceClient(configuration, fetchImpl) {
    const origin = normalizeOrigin(configuration.origin);
    const accessHeaders = {
        'CF-Access-Client-Id': configuration.clientId,
        'CF-Access-Client-Secret': configuration.clientSecret
    };
    return {
        async json(method, requestPath, body = undefined) {
            const headers = { ...accessHeaders };
            let payload;
            if (body !== undefined) {
                payload = JSON.stringify(body);
                headers['Content-Type'] = 'application/json';
                headers['Content-Length'] = String(Buffer.byteLength(payload));
            }
            const response = await fetchImpl(`${origin}${requestPath}`, {
                method,
                headers,
                body: payload,
                redirect: 'error'
            });
            if (!(response instanceof Response) || !response.ok) {
                throw new Error(
                    `Protected Gallery service request failed with status ${response?.status || 503}.`
                );
            }
            if (response.headers.get('Content-Type')?.split(';')[0] !== 'application/json') {
                throw new Error('Protected Gallery service returned a non-JSON response.');
            }
            return response.json();
        }
    };
}

function validateOptions(options) {
    if (
        !plainObject(options) ||
        Object.keys(options).some(key => !OPTION_KEYS.includes(key)) ||
        !DRAFT_ID_PATTERN.test(options.draftId || '') ||
        typeof options.githubToken !== 'string' ||
        options.githubToken.length < 1 ||
        typeof (options.fetchImpl || globalThis.fetch) !== 'function' ||
        (options.reconcileReview !== undefined &&
            typeof options.reconcileReview !== 'function')
    ) throw new Error('The photo invalidation bridge configuration is invalid.');
    validateService(options.processing);
    validateService(options.promotion);
}

function validateService(value) {
    if (
        !plainObject(value) ||
        Object.keys(value).sort().join(',') !== [...SERVICE_KEYS].sort().join(',') ||
        normalizeOrigin(value.origin) === null ||
        !safeSecret(value.clientId) ||
        !safeSecret(value.clientSecret)
    ) throw new Error('A protected Gallery service configuration is invalid.');
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

function operationKey(label, draftId, stateVersion) {
    return `${label}-${createHash('sha256')
        .update(`${label}:${draftId}:${stateVersion}`)
        .digest('hex')
        .slice(0, 32)}`;
}

function safeSecret(value) {
    return typeof value === 'string' && value.length >= 1 && value.length <= 4096 &&
        !/[\u0000-\u001f\u007f]/.test(value);
}

function plainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
        (Object.getPrototypeOf(value) === Object.prototype ||
            Object.getPrototypeOf(value) === null);
}

function hasExactKeys(value, expectedKeys) {
    if (!plainObject(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...expectedKeys].sort();
    return actual.length === expected.length &&
        actual.every((key, index) => key === expected[index]);
}
