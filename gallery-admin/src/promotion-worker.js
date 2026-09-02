import { verifyWorkerAccessIdentity } from './access.js';
import { cleanupPhotoPromotion } from './promotion-cleanup-service.js';
import {
    abandonPhotoReviewCandidate,
    readPhotoReviewInvalidation,
    recordPhotoReviewOpened,
    recordPhotoReviewTerminal,
    reservePhotoReview,
    startPhotoReviewInvalidation
} from './photo-review-service.js';
import { promotePhotoDraft, readPhotoCandidate } from './promotion-service.js';
import { adminFailure, adminJson } from './responses.js';

const DRAFT_ID_FRAGMENT = '(draft_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})';
const PROMOTION_PATH_PATTERN = new RegExp(
    `^/api/service/drafts/${DRAFT_ID_FRAGMENT}/photo-promotions$`
);
const CANDIDATE_PATH_PATTERN = new RegExp(
    `^/api/service/drafts/${DRAFT_ID_FRAGMENT}/photo-candidate$`
);
const REVIEW_RESERVATION_PATH_PATTERN = new RegExp(
    `^/api/service/drafts/${DRAFT_ID_FRAGMENT}/photo-review-reservations$`
);
const REVIEW_INVALIDATION_PATH_PATTERN = new RegExp(
    `^/api/service/drafts/${DRAFT_ID_FRAGMENT}/photo-review-invalidation$`
);
const REVIEW_ABANDONMENT_PATH_PATTERN = new RegExp(
    `^/api/service/drafts/${DRAFT_ID_FRAGMENT}/photo-review-abandonment$`
);
const PROMOTION_ID_FRAGMENT = '(promotion_[a-f0-9]{32})';
const CLEANUP_PATH_PATTERN = new RegExp(
    `^/api/service/photo-promotions/${PROMOTION_ID_FRAGMENT}/cleanup$`
);
const REVIEW_ID_FRAGMENT = '(review_[a-f0-9]{32})';
const REVIEW_OPEN_PATH_PATTERN = new RegExp(
    `^/api/service/photo-reviews/${REVIEW_ID_FRAGMENT}/open$`
);
const REVIEW_TERMINAL_PATH_PATTERN = new RegExp(
    `^/api/service/photo-reviews/${REVIEW_ID_FRAGMENT}/terminal$`
);
const REVIEW_INVALIDATION_START_PATH_PATTERN = new RegExp(
    `^/api/service/photo-reviews/${REVIEW_ID_FRAGMENT}/invalidation-start$`
);
const PROMOTER_IDENTITY_PATTERN = /^subject:([0-9a-f]{32}\.access)$/;
const JSON_BODY_LIMIT = 32 * 1024;
const DEFAULT_BODY_TIMEOUT_MILLISECONDS = 5_000;
const MAX_BODY_TIMEOUT_MILLISECONDS = 30_000;
const MAX_CANCEL_WAIT_MILLISECONDS = 100;
const EXACT_ENVIRONMENT_KEYS = Object.freeze([
    'APPROVED_MEDIA',
    'APPROVED_MEDIA_ORIGIN',
    'DB',
    'DERIVATIVE_STAGING',
    'PROMOTER_IDENTITIES',
    'PROMOTION_ORIGIN'
]);

export async function handlePromotionRequest(request, env, dependencies = {}) {
    const identityVerifier = dependencies.verifyAccessIdentity ||
        (() => verifyWorkerAccessIdentity(dependencies.accessContext, request));
    const identity = await verifyIdentity(identityVerifier);
    if (
        !identity ||
        !matchesSinglePromoterIdentity(identity, env?.PROMOTER_IDENTITIES) ||
        !requestUsesConfiguredOrigin(request, env?.PROMOTION_ORIGIN) ||
        !requestUsesOnlyAccessAssertionCookie(request) ||
        request.headers.has('X-CSRF-Token')
    ) {
        return adminFailure(403);
    }

    let url;
    try {
        url = new URL(request.url);
    } catch {
        return adminFailure(404);
    }
    if (url.search !== '' || url.hash !== '') {
        return adminFailure(404);
    }

    const route = matchRoute(url.pathname);
    if (!route) {
        return adminFailure(404);
    }
    if (!hasExactEnvironment(env)) {
        return adminFailure(503);
    }
    if (['candidate', 'review-invalidation'].includes(route.kind)) {
        if (request.method !== 'GET') {
            return adminFailure(405, { Allow: 'GET' });
        }
        if (!isBodylessRead(request)) {
            return adminFailure(400);
        }
        const readOperation = route.kind === 'candidate'
            ? dependencies.readPhotoCandidate || readPhotoCandidate
            : dependencies.readPhotoReviewInvalidation ||
                readPhotoReviewInvalidation;
        try {
            return promotionResultResponse(
                await readOperation(env, identity, route.draftId),
                route
            );
        } catch {
            return adminFailure(503);
        }
    }

    if (request.method !== 'POST') {
        return adminFailure(405, { Allow: 'POST' });
    }

    const parsed = await readBoundedJson(
        request,
        dependencies.bodyTimeoutMilliseconds
    );
    if (!parsed.ok) {
        return adminFailure(parsed.status);
    }

    const operations = {
        cleanup: dependencies.cleanupPhotoPromotion || cleanupPhotoPromotion,
        promote: dependencies.promotePhotoDraft || promotePhotoDraft,
        'review-abandonment': dependencies.abandonPhotoReviewCandidate ||
            abandonPhotoReviewCandidate,
        'review-open': dependencies.recordPhotoReviewOpened ||
            recordPhotoReviewOpened,
        'review-invalidation-start': dependencies.startPhotoReviewInvalidation ||
            startPhotoReviewInvalidation,
        'review-reserve': dependencies.reservePhotoReview || reservePhotoReview,
        'review-terminal': dependencies.recordPhotoReviewTerminal ||
            recordPhotoReviewTerminal
    };
    const operation = operations[route.kind];
    try {
        let result;
        if (route.kind === 'cleanup') {
            result = await operation(
                env,
                identity,
                route.promotionId,
                parsed.value,
                readNow(dependencies.now)
            );
        } else if (route.kind === 'promote') {
            result = await operation(
                env,
                identity,
                route.draftId,
                parsed.value,
                env.APPROVED_MEDIA_ORIGIN,
                readNow(dependencies.now)
            );
        } else {
            result = await operation(
                env,
                identity,
                route.draftId || route.reviewId,
                parsed.value,
                readNow(dependencies.now)
            );
        }
        return promotionResultResponse(result, route);
    } catch {
        return adminFailure(503);
    }
}

function matchRoute(pathname) {
    let match = CANDIDATE_PATH_PATTERN.exec(pathname);
    if (match) return { kind: 'candidate', draftId: match[1] };
    match = REVIEW_RESERVATION_PATH_PATTERN.exec(pathname);
    if (match) return { kind: 'review-reserve', draftId: match[1] };
    match = REVIEW_ABANDONMENT_PATH_PATTERN.exec(pathname);
    if (match) return { kind: 'review-abandonment', draftId: match[1] };
    match = REVIEW_INVALIDATION_PATH_PATTERN.exec(pathname);
    if (match) return { kind: 'review-invalidation', draftId: match[1] };
    match = PROMOTION_PATH_PATTERN.exec(pathname);
    if (match) return { kind: 'promote', draftId: match[1] };
    match = CLEANUP_PATH_PATTERN.exec(pathname);
    if (match) return { kind: 'cleanup', promotionId: match[1] };
    match = REVIEW_OPEN_PATH_PATTERN.exec(pathname);
    if (match) return { kind: 'review-open', reviewId: match[1] };
    match = REVIEW_INVALIDATION_START_PATH_PATTERN.exec(pathname);
    if (match) return { kind: 'review-invalidation-start', reviewId: match[1] };
    match = REVIEW_TERMINAL_PATH_PATTERN.exec(pathname);
    return match ? { kind: 'review-terminal', reviewId: match[1] } : null;
}

async function verifyIdentity(verifier) {
    try {
        const identity = await verifier();
        return identity &&
            identity.type === 'service' &&
            typeof identity.subject === 'string' &&
            identity.subject.length >= 1 &&
            identity.subject.length <= 512 &&
            !/[\u0000-\u001f\u007f]/.test(identity.subject)
            ? identity
            : null;
    } catch {
        return null;
    }
}

function matchesSinglePromoterIdentity(identity, configuredIdentity) {
    if (
        typeof configuredIdentity !== 'string' ||
        configuredIdentity.trim() !== configuredIdentity
    ) {
        return false;
    }
    const match = PROMOTER_IDENTITY_PATTERN.exec(configuredIdentity);
    return Boolean(match) && identity.subject === match[1];
}

function requestUsesConfiguredOrigin(request, configuredOrigin) {
    const expected = normalizeConfiguredOrigin(configuredOrigin);
    if (!expected) {
        return false;
    }
    try {
        return new URL(request.url).origin === expected;
    } catch {
        return false;
    }
}

function requestUsesOnlyAccessAssertionCookie(request) {
    const cookie = request.headers.get('Cookie');
    if (cookie === null) {
        return true;
    }
    const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
    return typeof assertion === 'string' &&
        assertion.length > 0 &&
        cookie === `CF_Authorization=${assertion}`;
}

function isBodylessRead(request) {
    const contentLength = request.headers.get('Content-Length');
    return request.body === null &&
        !request.headers.has('Content-Type') &&
        !request.headers.has('Content-Encoding') &&
        !request.headers.has('Transfer-Encoding') &&
        (contentLength === null || contentLength === '0');
}

function normalizeConfiguredOrigin(value) {
    if (typeof value !== 'string' || value.trim() !== value) {
        return null;
    }
    try {
        const url = new URL(value);
        if (
            url.protocol !== 'https:' ||
            url.origin !== value ||
            url.username !== '' ||
            url.password !== '' ||
            url.pathname !== '/' ||
            url.search !== '' ||
            url.hash !== ''
        ) {
            return null;
        }
        return url.origin;
    } catch {
        return null;
    }
}

function hasExactEnvironment(env) {
    return env &&
        Object.keys(env).length === EXACT_ENVIRONMENT_KEYS.length &&
        Object.keys(env).every(key => EXACT_ENVIRONMENT_KEYS.includes(key)) &&
        env.DB &&
        typeof env.DB.prepare === 'function' &&
        typeof env.DB.batch === 'function' &&
        env.DERIVATIVE_STAGING &&
        typeof env.DERIVATIVE_STAGING.head === 'function' &&
        typeof env.DERIVATIVE_STAGING.get === 'function' &&
        env.APPROVED_MEDIA &&
        typeof env.APPROVED_MEDIA.head === 'function' &&
        typeof env.APPROVED_MEDIA.get === 'function' &&
        typeof env.APPROVED_MEDIA.delete === 'function' &&
        typeof env.APPROVED_MEDIA.list === 'function' &&
        typeof env.APPROVED_MEDIA.createMultipartUpload === 'function' &&
        typeof env.APPROVED_MEDIA.resumeMultipartUpload === 'function' &&
        normalizeConfiguredOrigin(env.APPROVED_MEDIA_ORIGIN) !== null;
}

async function readBoundedJson(request, requestedTimeoutMilliseconds) {
    if (
        request.headers.get('Content-Type') !== 'application/json' ||
        request.headers.has('Content-Encoding') ||
        request.headers.has('Transfer-Encoding') ||
        request.body === null
    ) {
        return { ok: false, status: 400 };
    }
    const declaredLength = request.headers.get('Content-Length');
    if (
        !/^[1-9][0-9]*$/.test(declaredLength || '') ||
        Number(declaredLength) > JSON_BODY_LIMIT
    ) {
        return {
            ok: false,
            status: Number(declaredLength) > JSON_BODY_LIMIT ? 413 : 400
        };
    }

    const reader = request.body.getReader();
    const deadline = Date.now() + normalizeBodyTimeout(
        requestedTimeoutMilliseconds
    );
    const chunks = [];
    let length = 0;
    try {
        while (true) {
            const { done, value } = await readBeforeDeadline(reader, deadline);
            if (done) {
                break;
            }
            length += value.byteLength;
            if (length > JSON_BODY_LIMIT) {
                await cancelBeforeDeadline(reader, deadline);
                return { ok: false, status: 413 };
            }
            chunks.push(value);
        }
        if (Date.now() >= deadline) {
            return { ok: false, status: 400 };
        }
        if (length !== Number(declaredLength)) {
            return { ok: false, status: 400 };
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return { ok: true, value: JSON.parse(text) };
    } catch {
        await cancelBeforeDeadline(reader, deadline);
        return { ok: false, status: 400 };
    } finally {
        try {
            reader.releaseLock();
        } catch {
            // A timed-out read is already rejected and cannot reach D1.
        }
    }
}

function normalizeBodyTimeout(value) {
    return Number.isSafeInteger(value) &&
        value >= 1 &&
        value <= MAX_BODY_TIMEOUT_MILLISECONDS
        ? value
        : DEFAULT_BODY_TIMEOUT_MILLISECONDS;
}

function readBeforeDeadline(reader, deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
        return Promise.reject(new Error('Request body timed out.'));
    }
    let timeoutId;
    return Promise.race([
        Promise.resolve().then(() => reader.read()),
        new Promise((resolve, reject) => {
            timeoutId = setTimeout(
                () => reject(new Error('Request body timed out.')),
                remaining
            );
        })
    ]).finally(() => clearTimeout(timeoutId));
}

async function cancelBeforeDeadline(reader, deadline) {
    let cancellation;
    try {
        cancellation = Promise.resolve(reader.cancel()).catch(() => {});
    } catch {
        return;
    }
    const remaining = Math.min(
        MAX_CANCEL_WAIT_MILLISECONDS,
        Math.max(0, deadline - Date.now())
    );
    if (remaining === 0) {
        void cancellation;
        return;
    }
    let timeoutId;
    await Promise.race([
        cancellation,
        new Promise(resolve => {
            timeoutId = setTimeout(resolve, remaining);
        })
    ]).finally(() => clearTimeout(timeoutId));
}

function promotionResultResponse(result, route) {
    if (!result || typeof result !== 'object' || !Number.isInteger(result.status)) {
        return adminFailure(503);
    }
    if (result.ok === true && [200, 201].includes(result.status)) {
        if (route?.kind === 'candidate') {
            if (!result.candidate || typeof result.candidate !== 'object' || Array.isArray(result.candidate)) {
                return adminFailure(503);
            }
            return adminJson(200, { candidate: result.candidate });
        }
        if (route?.kind === 'review-abandonment') {
            return abandonmentResultResponse(result, route);
        }
        if (route?.kind?.startsWith('review-')) {
            return reviewResultResponse(result, route);
        }
        if (route?.kind === 'cleanup') {
            if (
                result.promotionId !== route.promotionId ||
                !['athlete-exclusion', 'promotion-cancelled', 'withdrawal']
                    .includes(result.cleanupReason) ||
                result.promotionStatus !== 'cleaned' ||
                typeof result.replayed !== 'boolean'
            ) return adminFailure(503);
            return adminJson(result.status, {
                promotionId: route.promotionId,
                cleanupReason: result.cleanupReason,
                promotionStatus: 'cleaned',
                replayed: result.replayed
            });
        }
        if (
            route?.kind !== 'promote' ||
            !result.candidate ||
            typeof result.candidate !== 'object' ||
            Array.isArray(result.candidate) ||
            typeof result.replayed !== 'boolean'
        ) return adminFailure(503);
        return adminJson(result.status, {
            candidate: result.candidate,
            replayed: result.replayed
        });
    }

    const allowedStatuses = new Set([400, 404, 409, 413, 503]);
    const status = allowedStatuses.has(result.status) ? result.status : 503;
    const allowedCodes = new Set([
        'approved-object-conflict',
        'conflict',
        'invalid-request',
        'not-found',
        'promotion-cleanup-not-eligible',
        'promotion-cleaned',
        'promotion-not-eligible',
        'review-invalidation-not-required',
        'review-not-eligible',
        'service-unavailable',
        'staging-object-conflict'
    ]);
    return adminJson(status, {
        error: allowedCodes.has(result.code) ? result.code : 'service-unavailable'
    });
}

function abandonmentResultResponse(result, route) {
    const value = result.abandonment;
    if (
        !validAbandonmentResult(result, route.draftId)
    ) return adminFailure(503);
    return adminJson(result.status, {
        abandonment: value,
        cleanup: result.cleanup,
        processingCleanup: result.processingCleanup,
        replayed: result.replayed
    });
}

function reviewResultResponse(result, route) {
    if (route.kind === 'review-invalidation') {
        return reviewRecoveryResultResponse(result, route);
    }
    if (!validReview(result.review) || typeof result.replayed !== 'boolean') {
        return adminFailure(503);
    }
    if (route.kind === 'review-reserve' && result.review.draftId !== route.draftId) {
        return adminFailure(503);
    }
    if (route.kind === 'review-open' && (
        result.review.reviewId !== route.reviewId ||
        !['open', 'terminal'].includes(result.review.status)
    )) return adminFailure(503);
    if (route.kind === 'review-invalidation-start' && (
        !plainObjectWithExactKeys(result, [
            'invalidationStart', 'ok', 'replayed', 'review', 'status'
        ]) ||
        result.review.reviewId !== route.reviewId ||
        !validInvalidationStart(result.invalidationStart, result.review)
    )) return adminFailure(503);
    if (route.kind === 'review-terminal' && (
        result.review.reviewId !== route.reviewId ||
        result.review.status !== 'terminal' ||
        !validCleanupPackage(result.cleanup) ||
        !validProcessingCleanupPackage(result.processingCleanup) ||
        result.processingCleanup.processingRunId !==
            result.review.processingRunId ||
        result.processingCleanup.expectedStateVersion !==
            result.cleanup.expectedStateVersion
    )) return adminFailure(503);
    const body = { review: result.review };
    if (route.kind === 'review-terminal') {
        body.cleanup = result.cleanup;
        body.processingCleanup = result.processingCleanup;
    }
    if (route.kind === 'review-invalidation-start') {
        body.invalidationStart = result.invalidationStart;
    }
    body.replayed = result.replayed;
    return adminJson(result.status, body);
}

function reviewRecoveryResultResponse(result, route) {
    if (result.replayed !== true) return adminFailure(503);
    if (result.receiptKind === 'review') {
        if (
            !plainObjectWithExactKeys(result, [
                'invalidation', 'ok', 'receiptKind', 'replayed', 'review', 'status'
            ]) ||
            !validReview(result.review) ||
            result.review.draftId !== route.draftId ||
            !(result.invalidation === null ||
                validInvalidation(result.invalidation, result.review))
        ) return adminFailure(503);
        return adminJson(result.status, {
            receiptKind: 'review',
            review: result.review,
            invalidation: result.invalidation,
            replayed: true
        });
    }
    if (
        result.receiptKind !== 'abandonment' ||
        !plainObjectWithExactKeys(result, [
            'abandonment', 'cleanup', 'ok', 'processingCleanup',
            'receiptKind', 'replayed', 'status'
        ]) ||
        !validAbandonmentResult(result, route.draftId)
    ) return adminFailure(503);
    return adminJson(result.status, {
        receiptKind: 'abandonment',
        abandonment: result.abandonment,
        cleanup: result.cleanup,
        processingCleanup: result.processingCleanup,
        replayed: true
    });
}

function validAbandonmentResult(result, expectedDraftId) {
    const value = result.abandonment;
    return typeof result.replayed === 'boolean' &&
        plainObjectWithExactKeys(value, [
            'draftId', 'expectedStateVersion', 'failureEvidenceHash',
            'processingRunId', 'promotionId', 'resultStateVersion',
            'schemaVersion', 'status'
        ]) &&
        value.schemaVersion === '1.0' &&
        value.draftId === expectedDraftId &&
        /^draft_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
            value.draftId || ''
        ) &&
        /^promotion_[a-f0-9]{32}$/.test(value.promotionId || '') &&
        /^run_[a-f0-9]{12}4[a-f0-9]{3}[89ab][a-f0-9]{15}$/.test(
            value.processingRunId || ''
        ) &&
        Number.isSafeInteger(value.expectedStateVersion) &&
        value.expectedStateVersion >= 0 &&
        value.resultStateVersion === value.expectedStateVersion + 1 &&
        /^[a-f0-9]{64}$/.test(value.failureEvidenceHash || '') &&
        value.status === 'withdrawal-pending' &&
        validCleanupPackage(result.cleanup) &&
        result.cleanup.promotionId === value.promotionId &&
        result.cleanup.expectedStateVersion === value.resultStateVersion &&
        validProcessingCleanupPackage(result.processingCleanup) &&
        result.processingCleanup.processingRunId === value.processingRunId &&
        result.processingCleanup.expectedStateVersion === value.resultStateVersion;
}

function validReview(review) {
    const keys = [
        'baseRef', 'baseSha', 'branchRef', 'candidatePayloadHash',
        'candidateStateVersion', 'closeEvidenceHash', 'draftId',
        'generationFingerprint', 'headSha', 'itemId', 'manifestSha256',
        'openEvidenceHash', 'operationMarkerHash', 'promotionId',
        'processingRunId', 'pullRequestNumber', 'pullRequestUrl',
        'readbackEvidenceHash',
        'repository', 'reviewId', 'schemaVersion', 'status',
        'targetRelativePath', 'terminalEvidenceHash', 'terminalKind',
        'workflowRunReference'
    ];
    if (
        !plainObjectWithExactKeys(review, keys) ||
        review.schemaVersion !== '1.0' ||
        !/^review_[a-f0-9]{32}$/.test(review.reviewId || '') ||
        !/^draft_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
            review.draftId || ''
        ) ||
        !/^promotion_[a-f0-9]{32}$/.test(review.promotionId || '') ||
        !/^run_[a-f0-9]{12}4[a-f0-9]{3}[89ab][a-f0-9]{15}$/.test(
            review.processingRunId || ''
        ) ||
        !Number.isSafeInteger(review.candidateStateVersion) ||
        review.candidateStateVersion < 0 ||
        !/^[a-f0-9]{64}$/.test(review.candidatePayloadHash || '') ||
        !/^[a-f0-9]{64}$/.test(review.generationFingerprint || '') ||
        review.repository !== 'johnkevan88888/family-running' ||
        review.baseRef !== 'main' ||
        !/^[a-f0-9]{40}$/.test(review.baseSha || '') ||
        !/^gallery-media\/candidate-[a-f0-9]{32}$/.test(review.branchRef || '') ||
        !['gallery-data/family.json', 'gallery-data/everyone.json']
            .includes(review.targetRelativePath) ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(review.itemId || '') ||
        !/^sha256:[a-f0-9]{64}$/.test(review.manifestSha256 || '') ||
        !/^[a-f0-9]{64}$/.test(review.operationMarkerHash || '') ||
        !/^https:\/\/github\.com\/johnkevan88888\/family-running\/actions\/runs\/[1-9][0-9]*\/attempts\/[1-9][0-9]*$/.test(
            review.workflowRunReference || ''
        ) ||
        !['reserved', 'open', 'terminal'].includes(review.status)
    ) return false;

    const noPull = review.pullRequestNumber === null &&
        review.pullRequestUrl === null &&
        review.headSha === null;
    const exactPull = Number.isSafeInteger(review.pullRequestNumber) &&
        review.pullRequestNumber >= 1 &&
        review.pullRequestUrl ===
            `https://github.com/johnkevan88888/family-running/pull/${review.pullRequestNumber}` &&
        /^[a-f0-9]{40}$/.test(review.headSha || '');
    if (review.status === 'reserved') {
        return noPull && review.openEvidenceHash === null &&
            terminalFieldsAreNull(review);
    }
    if (review.status === 'open') {
        return exactPull && /^[a-f0-9]{64}$/.test(review.openEvidenceHash || '') &&
            terminalFieldsAreNull(review);
    }
    if (
        !['closed-unmerged', 'no-pr-created'].includes(review.terminalKind) ||
        !/^[a-f0-9]{64}$/.test(review.terminalEvidenceHash || '')
    ) return false;
    return review.terminalKind === 'no-pr-created'
        ? noPull && review.openEvidenceHash === null &&
            review.closeEvidenceHash === null && review.readbackEvidenceHash === null
        : exactPull &&
            (review.openEvidenceHash === null ||
                /^[a-f0-9]{64}$/.test(review.openEvidenceHash || '')) &&
            /^[a-f0-9]{64}$/.test(review.closeEvidenceHash || '') &&
            /^[a-f0-9]{64}$/.test(review.readbackEvidenceHash || '');
}

function terminalFieldsAreNull(review) {
    return review.terminalKind === null &&
        review.terminalEvidenceHash === null &&
        review.closeEvidenceHash === null &&
        review.readbackEvidenceHash === null;
}

function validInvalidation(invalidation, review) {
    return plainObjectWithExactKeys(
        invalidation,
        ['cleanup', 'processingCleanup', 'terminalKind', 'withdrawalKind']
    ) &&
        ['editorial-removal', 'athlete-exclusion', 'consent-withdrawal']
            .includes(invalidation.withdrawalKind) &&
        invalidation.terminalKind === (
            review.status === 'open'
                ? 'closed-unmerged'
                : review.status === 'reserved'
                    ? 'no-pr-created'
                    : review.terminalKind
        ) &&
        validCleanupPackage(invalidation.cleanup) &&
        invalidation.cleanup.promotionId === review.promotionId &&
        validProcessingCleanupPackage(invalidation.processingCleanup) &&
        invalidation.processingCleanup.processingRunId === review.processingRunId &&
        invalidation.processingCleanup.expectedStateVersion ===
            invalidation.cleanup.expectedStateVersion;
}

function validInvalidationStart(value, review) {
    return plainObjectWithExactKeys(value, [
        'cleanup', 'expectedStateVersion', 'processingCleanup',
        'resultStateVersion', 'withdrawalKind'
    ]) &&
        ['editorial-removal', 'athlete-exclusion', 'consent-withdrawal']
            .includes(value.withdrawalKind) &&
        value.expectedStateVersion === review.candidateStateVersion &&
        value.resultStateVersion === value.expectedStateVersion + 1 &&
        validCleanupPackage(value.cleanup) &&
        value.cleanup.promotionId === review.promotionId &&
        value.cleanup.expectedStateVersion === value.resultStateVersion &&
        validProcessingCleanupPackage(value.processingCleanup) &&
        value.processingCleanup.processingRunId === review.processingRunId &&
        value.processingCleanup.expectedStateVersion === value.resultStateVersion;
}

function validCleanupPackage(value) {
    return plainObjectWithExactKeys(
        value,
        ['expectedStateVersion', 'idempotencyKey', 'promotionId']
    ) &&
        /^promotion_[a-f0-9]{32}$/.test(value.promotionId || '') &&
        Number.isSafeInteger(value.expectedStateVersion) &&
        value.expectedStateVersion >= 0 &&
        /^photo-review-cleanup-[a-f0-9]{32}$/.test(value.idempotencyKey || '');
}

function validProcessingCleanupPackage(value) {
    return plainObjectWithExactKeys(
        value,
        ['expectedStateVersion', 'idempotencyKey', 'processingRunId']
    ) &&
        /^run_[a-f0-9]{12}4[a-f0-9]{3}[89ab][a-f0-9]{15}$/.test(
            value.processingRunId || ''
        ) &&
        Number.isSafeInteger(value.expectedStateVersion) &&
        value.expectedStateVersion >= 0 &&
        /^photo-review-staging-[a-f0-9]{32}$/.test(value.idempotencyKey || '');
}

function plainObjectWithExactKeys(value, expectedKeys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...expectedKeys].sort();
    return actual.length === expected.length &&
        actual.every((key, index) => key === expected[index]);
}

function readNow(provider) {
    const value = typeof provider === 'function' ? provider() : Date.now();
    return Number.isFinite(value) ? value : Date.now();
}

export default {
    fetch(request, env, context) {
        return handlePromotionRequest(request, env, {
            accessContext: context?.access
        });
    }
};
