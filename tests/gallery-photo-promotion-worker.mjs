import assert from 'node:assert/strict';

import promotionWorker, {
    handlePromotionRequest
} from '../gallery-admin/src/promotion-worker.js';

const promotionOrigin = 'https://synthetic-gallery-promotion.example';
const approvedMediaOrigin = 'https://synthetic-gallery-media.example';
const promoterSubject = '0123456789abcdef0123456789abcdef.access';
const draftId = 'draft_11111111-1111-4111-8111-111111111111';
const promotionPath = `/api/service/drafts/${draftId}/photo-promotions`;
const candidatePath = `/api/service/drafts/${draftId}/photo-candidate`;
const promotionId = 'promotion_11111111111141118111111111111111';
const processingRunId = 'run_11111111111141118111111111111111';
const cleanupPath = `/api/service/photo-promotions/${promotionId}/cleanup`;
const reviewId = 'review_11111111111141118111111111111111';
const reviewReservationPath =
    `/api/service/drafts/${draftId}/photo-review-reservations`;
const reviewInvalidationPath =
    `/api/service/drafts/${draftId}/photo-review-invalidation`;
const reviewOpenPath = `/api/service/photo-reviews/${reviewId}/open`;
const reviewTerminalPath = `/api/service/photo-reviews/${reviewId}/terminal`;
const reviewInvalidationStartPath =
    `/api/service/photo-reviews/${reviewId}/invalidation-start`;
const reviewAbandonmentPath =
    `/api/service/drafts/${draftId}/photo-review-abandonment`;
const validInput = {
    expectedStateVersion: 19,
    idempotencyKey: 'photo-promotion-worker-0001'
};
const fixedNow = Date.UTC(2026, 7, 29, 18, 0, 0);

assert.equal(typeof promotionWorker.fetch, 'function');

const environment = createEnvironment();
const defaultEntryPointResponse = await promotionWorker.fetch(
    new Request(`${promotionOrigin}${promotionPath}`, { method: 'GET' }),
    environment,
    {
        access: {
            async getIdentity() {
                return {
                    service_token_status: true,
                    service_token_id: promoterSubject
                };
            }
        }
    }
);
assert.equal(defaultEntryPointResponse.status, 405);
assert.equal(defaultEntryPointResponse.headers.get('Allow'), 'POST');

const missingAccessContextResponse = await promotionWorker.fetch(
    new Request(`${promotionOrigin}${promotionPath}`, { method: 'GET' }),
    environment,
    {}
);
assert.equal(missingAccessContextResponse.status, 403);

const serviceCalls = [];
const cleanupCalls = [];
const candidateCalls = [];
const reviewReservationCalls = [];
const reviewOpenCalls = [];
const reviewInvalidationCalls = [];
const reviewInvalidationStartCalls = [];
const reviewTerminalCalls = [];
const reviewAbandonmentCalls = [];
const review = {
    schemaVersion: '1.0',
    reviewId,
    draftId,
    promotionId,
    processingRunId,
    candidateStateVersion: 20,
    candidatePayloadHash: '1'.repeat(64),
    generationFingerprint: '2'.repeat(64),
    repository: 'johnkevan88888/family-running',
    baseRef: 'main',
    baseSha: '3'.repeat(40),
    branchRef: `gallery-media/candidate-${'4'.repeat(32)}`,
    targetRelativePath: 'gallery-data/family.json',
    itemId: 'synthetic-review-photo',
    manifestSha256: `sha256:${'5'.repeat(64)}`,
    operationMarkerHash: '6'.repeat(64),
    workflowRunReference:
        'https://github.com/johnkevan88888/family-running/actions/runs/123/attempts/1',
    status: 'reserved',
    pullRequestNumber: null,
    pullRequestUrl: null,
    headSha: null,
    openEvidenceHash: null,
    terminalKind: null,
    terminalEvidenceHash: null,
    closeEvidenceHash: null,
    readbackEvidenceHash: null
};
const cleanupPackage = {
    promotionId,
    expectedStateVersion: 21,
    idempotencyKey: `photo-review-cleanup-${'6'.repeat(32)}`
};
const processingCleanupPackage = {
    processingRunId,
    expectedStateVersion: 21,
    idempotencyKey: `photo-review-staging-${'6'.repeat(32)}`
};
const validDependencies = {
    verifyAccessIdentity: async () => ({
        type: 'service',
        subject: promoterSubject
    }),
    now: () => fixedNow,
    async promotePhotoDraft(...args) {
        serviceCalls.push(args);
        return {
            ok: true,
            status: 201,
            candidate: {
                schemaVersion: '1.0',
                operationId: 'promotion_11111111111141118111111111111111'
            },
            replayed: false
        };
    },
    async cleanupPhotoPromotion(...args) {
        cleanupCalls.push(args);
        return {
            ok: true,
            status: 201,
            promotionId,
            cleanupReason: 'athlete-exclusion',
            promotionStatus: 'cleaned',
            replayed: false,
            providerUploadId: 'must-not-cross-worker-boundary',
            approvedObjectKey: 'media/v1/must-not-cross-worker-boundary',
            evidenceHash: 'a'.repeat(64)
        };
    },
    async readPhotoCandidate(...args) {
        candidateCalls.push(args);
        return {
            ok: true,
            status: 200,
            candidate: {
                schemaVersion: '1.0',
                operationId: 'promotion_11111111111141118111111111111111'
            }
        };
    },
    async reservePhotoReview(...args) {
        reviewReservationCalls.push(args);
        return { ok: true, status: 201, review, replayed: false };
    },
    async recordPhotoReviewOpened(...args) {
        reviewOpenCalls.push(args);
        return {
            ok: true,
            status: 201,
            review: {
                ...review,
                status: 'open',
                pullRequestNumber: 123,
                pullRequestUrl:
                    'https://github.com/johnkevan88888/family-running/pull/123',
                headSha: '7'.repeat(40),
                openEvidenceHash: '8'.repeat(64)
            },
            replayed: false
        };
    },
    async readPhotoReviewInvalidation(...args) {
        reviewInvalidationCalls.push(args);
        return {
            ok: true,
            status: 200,
            receiptKind: 'review',
            review,
            invalidation: {
                withdrawalKind: 'athlete-exclusion',
                terminalKind: 'no-pr-created',
                cleanup: cleanupPackage,
                processingCleanup: processingCleanupPackage
            },
            replayed: true
        };
    },
    async startPhotoReviewInvalidation(...args) {
        reviewInvalidationStartCalls.push(args);
        return {
            ok: true,
            status: 201,
            review,
            invalidationStart: {
                withdrawalKind: 'editorial-removal',
                expectedStateVersion: 20,
                resultStateVersion: 21,
                cleanup: cleanupPackage,
                processingCleanup: processingCleanupPackage
            },
            replayed: false
        };
    },
    async recordPhotoReviewTerminal(...args) {
        reviewTerminalCalls.push(args);
        return {
            ok: true,
            status: 201,
            review: {
                ...review,
                status: 'terminal',
                terminalKind: 'no-pr-created',
                terminalEvidenceHash: '9'.repeat(64)
            },
            cleanup: cleanupPackage,
            processingCleanup: processingCleanupPackage,
            replayed: false
        };
    },
    async abandonPhotoReviewCandidate(...args) {
        reviewAbandonmentCalls.push(args);
        return {
            ok: true,
            status: 201,
            abandonment: {
                schemaVersion: '1.0',
                draftId,
                promotionId,
                processingRunId,
                expectedStateVersion: 20,
                resultStateVersion: 21,
                failureEvidenceHash: 'a'.repeat(64),
                status: 'withdrawal-pending'
            },
            cleanup: cleanupPackage,
            processingCleanup: processingCleanupPackage,
            replayed: false
        };
    }
};

const validResponse = await requestPromotion({}, environment, validDependencies);
assert.equal(validResponse.status, 201);
assert.deepEqual(await validResponse.json(), {
    candidate: {
        schemaVersion: '1.0',
        operationId: 'promotion_11111111111141118111111111111111'
    },
    replayed: false
});
assert.equal(validResponse.headers.get('Cache-Control'), 'no-store');
assert.equal(validResponse.headers.get('X-Robots-Tag'), 'noindex, nofollow, noarchive');
assert.equal(serviceCalls.length, 1);
assert.equal(serviceCalls[0][0], environment);
assert.deepEqual(serviceCalls[0][1], {
    type: 'service',
    subject: promoterSubject
});
assert.equal(serviceCalls[0][2], draftId);
assert.deepEqual(serviceCalls[0][3], validInput);
assert.equal(serviceCalls[0][4], approvedMediaOrigin);
assert.equal(serviceCalls[0][5], fixedNow);

const candidateResponse = await requestPromotion({
    method: 'GET',
    url: `${promotionOrigin}${candidatePath}`,
    body: undefined
}, environment, validDependencies);
assert.equal(candidateResponse.status, 200);
assert.deepEqual(await candidateResponse.json(), {
    candidate: {
        schemaVersion: '1.0',
        operationId: 'promotion_11111111111141118111111111111111'
    }
});
assert.equal(candidateCalls.length, 1);
assert.equal(candidateCalls[0][0], environment);
assert.deepEqual(candidateCalls[0][1], {
    type: 'service',
    subject: promoterSubject
});
assert.equal(candidateCalls[0][2], draftId);
assert.equal((await requestPromotion({
    method: 'POST',
    url: `${promotionOrigin}${candidatePath}`
}, environment, validDependencies)).status, 405);

const reservationInput = {
    expectedStateVersion: 20,
    baseSha: review.baseSha,
    manifestSha256: review.manifestSha256,
    workflowRunReference: review.workflowRunReference,
    idempotencyKey: 'photo-review-reserve-0001'
};
const reservationResponse = await requestPromotion({
    url: `${promotionOrigin}${reviewReservationPath}`,
    body: JSON.stringify(reservationInput)
}, environment, validDependencies);
assert.equal(reservationResponse.status, 201);
assert.deepEqual(await reservationResponse.json(), { review, replayed: false });
assert.equal(reviewReservationCalls.length, 1);
assert.equal(reviewReservationCalls[0][2], draftId);
assert.deepEqual(reviewReservationCalls[0][3], reservationInput);
assert.equal(reviewReservationCalls[0][4], fixedNow);

const reviewOpenInput = {
    expectedStateVersion: 20,
    headSha: '7'.repeat(40),
    pullRequestNumber: 123,
    pullRequestUrl: 'https://github.com/johnkevan88888/family-running/pull/123',
    openEvidenceHash: '8'.repeat(64),
    idempotencyKey: 'photo-review-open-0001'
};
const reviewOpenResponse = await requestPromotion({
    url: `${promotionOrigin}${reviewOpenPath}`,
    body: JSON.stringify(reviewOpenInput)
}, environment, validDependencies);
assert.equal(reviewOpenResponse.status, 201);
assert.equal((await reviewOpenResponse.json()).review.status, 'open');
assert.equal(reviewOpenCalls.length, 1);
assert.equal(reviewOpenCalls[0][2], reviewId);
assert.deepEqual(reviewOpenCalls[0][3], reviewOpenInput);

const invalidationResponse = await requestPromotion({
    method: 'GET',
    url: `${promotionOrigin}${reviewInvalidationPath}`,
    body: undefined
}, environment, validDependencies);
assert.equal(invalidationResponse.status, 200);
assert.deepEqual(await invalidationResponse.json(), {
    receiptKind: 'review',
    review,
    invalidation: {
        withdrawalKind: 'athlete-exclusion',
        terminalKind: 'no-pr-created',
        cleanup: cleanupPackage,
        processingCleanup: processingCleanupPackage
    },
    replayed: true
});
assert.equal(reviewInvalidationCalls.length, 1);
assert.equal(reviewInvalidationCalls[0][2], draftId);

const receiptOnlyResponse = await requestPromotion({
    method: 'GET',
    url: `${promotionOrigin}${reviewInvalidationPath}`,
    body: undefined
}, environment, {
    ...validDependencies,
    async readPhotoReviewInvalidation() {
        return {
            ok: true,
            status: 200,
            receiptKind: 'review',
            review,
            invalidation: null,
            replayed: true
        };
    }
});
assert.equal(receiptOnlyResponse.status, 200);
assert.deepEqual(await receiptOnlyResponse.json(), {
    receiptKind: 'review',
    review,
    invalidation: null,
    replayed: true
});

const abandonmentReceipt = {
    schemaVersion: '1.0',
    draftId,
    promotionId,
    processingRunId,
    expectedStateVersion: 20,
    resultStateVersion: 21,
    failureEvidenceHash: 'a'.repeat(64),
    status: 'withdrawal-pending'
};
const abandonmentReadbackResponse = await requestPromotion({
    method: 'GET',
    url: `${promotionOrigin}${reviewInvalidationPath}`,
    body: undefined
}, environment, {
    ...validDependencies,
    async readPhotoReviewInvalidation() {
        return {
            ok: true,
            status: 200,
            receiptKind: 'abandonment',
            abandonment: abandonmentReceipt,
            cleanup: cleanupPackage,
            processingCleanup: processingCleanupPackage,
            replayed: true
        };
    }
});
assert.equal(abandonmentReadbackResponse.status, 200);
assert.deepEqual(await abandonmentReadbackResponse.json(), {
    receiptKind: 'abandonment',
    abandonment: abandonmentReceipt,
    cleanup: cleanupPackage,
    processingCleanup: processingCleanupPackage,
    replayed: true
});
assert.equal((await requestPromotion({
    method: 'GET',
    url: `${promotionOrigin}${reviewInvalidationPath}`,
    body: undefined
}, environment, {
    ...validDependencies,
    async readPhotoReviewInvalidation() {
        return {
            ok: true,
            status: 200,
            receiptKind: 'review',
            review,
            invalidation: null,
            abandonment: abandonmentReceipt,
            replayed: true
        };
    }
})).status, 503);

const invalidationStartInput = {
    expectedStateVersion: 20,
    idempotencyKey: 'photo-review-invalidation-start-0001'
};
const invalidationStartResponse = await requestPromotion({
    url: `${promotionOrigin}${reviewInvalidationStartPath}`,
    body: JSON.stringify(invalidationStartInput)
}, environment, validDependencies);
assert.equal(invalidationStartResponse.status, 201);
assert.deepEqual(await invalidationStartResponse.json(), {
    review,
    invalidationStart: {
        withdrawalKind: 'editorial-removal',
        expectedStateVersion: 20,
        resultStateVersion: 21,
        cleanup: cleanupPackage,
        processingCleanup: processingCleanupPackage
    },
    replayed: false
});
assert.equal(reviewInvalidationStartCalls.length, 1);
assert.equal(reviewInvalidationStartCalls[0][2], reviewId);
assert.deepEqual(reviewInvalidationStartCalls[0][3], invalidationStartInput);
assert.equal((await requestPromotion({
    method: 'GET',
    url: `${promotionOrigin}${reviewInvalidationStartPath}`,
    body: undefined
}, environment, validDependencies)).status, 405);
const malformedInvalidationStart = await requestPromotion({
    url: `${promotionOrigin}${reviewInvalidationStartPath}`,
    body: JSON.stringify(invalidationStartInput)
}, environment, {
    ...validDependencies,
    async startPhotoReviewInvalidation() {
        return {
            ok: true,
            status: 201,
            review,
            invalidationStart: {
                withdrawalKind: 'editorial-removal',
                expectedStateVersion: 20,
                resultStateVersion: 21,
                cleanup: cleanupPackage,
                processingCleanup: processingCleanupPackage,
                terminalKind: 'no-pr-created'
            },
            replayed: false
        };
    }
});
assert.equal(malformedInvalidationStart.status, 503);

const reviewTerminalInput = {
    terminalKind: 'no-pr-created',
    terminalEvidenceHash: '9'.repeat(64),
    closeEvidenceHash: null,
    readbackEvidenceHash: null,
    headSha: null,
    pullRequestNumber: null,
    pullRequestUrl: null,
    idempotencyKey: 'photo-review-terminal-0001'
};
const reviewTerminalResponse = await requestPromotion({
    url: `${promotionOrigin}${reviewTerminalPath}`,
    body: JSON.stringify(reviewTerminalInput)
}, environment, validDependencies);
assert.equal(reviewTerminalResponse.status, 201);
assert.deepEqual(await reviewTerminalResponse.json(), {
    review: {
        ...review,
        status: 'terminal',
        terminalKind: 'no-pr-created',
        terminalEvidenceHash: '9'.repeat(64)
    },
    cleanup: cleanupPackage,
    processingCleanup: processingCleanupPackage,
    replayed: false
});
assert.equal(reviewTerminalCalls.length, 1);
assert.equal(reviewTerminalCalls[0][2], reviewId);
assert.deepEqual(reviewTerminalCalls[0][3], reviewTerminalInput);

const abandonmentInput = {
    expectedStateVersion: 20,
    failureEvidenceHash: 'a'.repeat(64),
    idempotencyKey: 'photo-review-abandon-0001'
};
const abandonmentResponse = await requestPromotion({
    url: `${promotionOrigin}${reviewAbandonmentPath}`,
    body: JSON.stringify(abandonmentInput)
}, environment, validDependencies);
assert.equal(abandonmentResponse.status, 201);
assert.deepEqual(await abandonmentResponse.json(), {
    abandonment: {
        schemaVersion: '1.0',
        draftId,
        promotionId,
        processingRunId,
        expectedStateVersion: 20,
        resultStateVersion: 21,
        failureEvidenceHash: 'a'.repeat(64),
        status: 'withdrawal-pending'
    },
    cleanup: cleanupPackage,
    processingCleanup: processingCleanupPackage,
    replayed: false
});
assert.equal(reviewAbandonmentCalls.length, 1);
assert.equal(reviewAbandonmentCalls[0][2], draftId);
assert.deepEqual(reviewAbandonmentCalls[0][3], abandonmentInput);

const validCleanupResponse = await requestPromotion({
    url: `${promotionOrigin}${cleanupPath}`
}, environment, validDependencies);
assert.equal(validCleanupResponse.status, 201);
assert.deepEqual(await validCleanupResponse.json(), {
    promotionId,
    cleanupReason: 'athlete-exclusion',
    promotionStatus: 'cleaned',
    replayed: false
});
assert.equal(cleanupCalls.length, 1);
assert.equal(cleanupCalls[0][0], environment);
assert.deepEqual(cleanupCalls[0][1], {
    type: 'service',
    subject: promoterSubject
});
assert.equal(cleanupCalls[0][2], promotionId);
assert.deepEqual(cleanupCalls[0][3], validInput);
assert.equal(cleanupCalls[0][4], fixedNow);

const callsBeforeAssertionCookie = serviceCalls.length;
const assertionCookieResponse = await requestPromotion({
    headers: {
        'Cf-Access-Jwt-Assertion': 'synthetic.assertion.value',
        Cookie: 'CF_Authorization=synthetic.assertion.value'
    }
}, environment, validDependencies);
assert.equal(assertionCookieResponse.status, 201);
assert.equal(serviceCalls.length, callsBeforeAssertionCookie + 1);

for (const testCase of [
    {
        label: 'missing identity',
        dependencies: {
            ...validDependencies,
            verifyAccessIdentity: async () => null
        }
    },
    {
        label: 'browser identity',
        dependencies: {
            ...validDependencies,
            verifyAccessIdentity: async () => ({ type: 'browser', subject: 'owner' })
        }
    },
    {
        label: 'wrong service identity',
        dependencies: {
            ...validDependencies,
            verifyAccessIdentity: async () => ({
                type: 'service',
                subject: 'fedcba9876543210fedcba9876543210.access'
            })
        }
    },
    {
        label: 'identity verifier failure',
        dependencies: {
            ...validDependencies,
            verifyAccessIdentity: async () => {
                throw new Error('private-access-error');
            }
        }
    },
    {
        label: 'wrong request origin',
        url: `https://wrong-origin.example${promotionPath}`
    },
    {
        label: 'unexpected cookie',
        headers: { Cookie: 'owner-session=forbidden' }
    },
    {
        label: 'assertion cookie mismatch',
        headers: {
            'Cf-Access-Jwt-Assertion': 'synthetic.assertion.value',
            Cookie: 'CF_Authorization=different.assertion.value'
        }
    },
    {
        label: 'browser CSRF header',
        headers: { 'X-CSRF-Token': 'forbidden-on-service-worker' }
    },
    {
        label: 'multiple configured identities',
        env: {
            ...environment,
            PROMOTER_IDENTITIES:
                `subject:${promoterSubject},subject:fedcba9876543210fedcba9876543210.access`
        }
    },
    {
        label: 'malformed configured identity',
        env: { ...environment, PROMOTER_IDENTITIES: promoterSubject }
    },
    {
        label: 'insecure configured origin',
        env: { ...environment, PROMOTION_ORIGIN: 'http://synthetic-gallery-promotion.example' }
    }
]) {
    const before = serviceCalls.length;
    const response = await requestPromotion(testCase, testCase.env || environment, testCase.dependencies || validDependencies);
    assert.equal(response.status, 403, testCase.label);
    assert.equal(serviceCalls.length, before, `${testCase.label} reached the promotion service.`);
}

for (const testCase of [
    { label: 'query string', url: `${promotionOrigin}${promotionPath}?site=everyone` },
    { label: 'fragment', url: `${promotionOrigin}${promotionPath}#private` },
    { label: 'wrong route', url: `${promotionOrigin}/api/service/photo-promotions/${draftId}` },
    {
        label: 'caller-selected destination path',
        url: `${promotionOrigin}${promotionPath}/everyone`
    }
]) {
    const before = serviceCalls.length;
    const response = await requestPromotion(testCase, environment, validDependencies);
    assert.equal(response.status, 404, testCase.label);
    assert.equal(serviceCalls.length, before, `${testCase.label} reached the promotion service.`);
}

const methodResponse = await requestPromotion({ method: 'GET', body: undefined }, environment, validDependencies);
assert.equal(methodResponse.status, 405);
assert.equal(methodResponse.headers.get('Allow'), 'POST');

for (const testCase of [
    {
        label: 'missing D1',
        env: { ...environment, DB: undefined }
    },
    {
        label: 'missing staging read',
        env: {
            ...environment,
            DERIVATIVE_STAGING: { head: async () => null }
        }
    },
    {
        label: 'missing approved multipart create',
        env: {
            ...environment,
            APPROVED_MEDIA: {
                head: async () => null,
                get: async () => null,
                resumeMultipartUpload() {}
            }
        }
    },
    {
        label: 'missing approved origin',
        env: { ...environment, APPROVED_MEDIA_ORIGIN: undefined }
    },
    {
        label: 'approved origin has a path',
        env: { ...environment, APPROVED_MEDIA_ORIGIN: `${approvedMediaOrigin}/media` }
    },
    {
        label: 'unexpected private-original binding',
        env: { ...environment, PRIVATE_ORIGINALS: {} }
    },
    {
        label: 'unexpected GitHub capability',
        env: { ...environment, GITHUB_TOKEN: 'forbidden' }
    }
]) {
    const before = serviceCalls.length;
    const response = await requestPromotion({}, testCase.env, validDependencies);
    assert.equal(response.status, 503, testCase.label);
    assert.equal(serviceCalls.length, before, `${testCase.label} reached the promotion service.`);
}

for (const testCase of [
    {
        label: 'wrong content type',
        headers: { 'Content-Type': 'text/plain' }
    },
    {
        label: 'encoded request',
        headers: { 'Content-Encoding': 'gzip' }
    },
    {
        label: 'declared length mismatch',
        headers: { 'Content-Length': '1' }
    },
    {
        label: 'invalid JSON',
        body: '{'
    }
]) {
    const before = serviceCalls.length;
    const response = await requestPromotion(testCase, environment, validDependencies);
    assert.equal(response.status, 400, testCase.label);
    assert.equal(serviceCalls.length, before, `${testCase.label} reached the promotion service.`);
}

let stalledReadCancelCalls = 0;
const stalledReadBody = new ReadableStream({
    start() {},
    cancel() {
        stalledReadCancelCalls += 1;
        return new Promise(() => {});
    }
});
const callsBeforeStalledRead = serviceCalls.length;
const stalledReadStartedAt = Date.now();
const stalledReadResponse = await handlePromotionRequest(
    streamedPromotionRequest(stalledReadBody),
    environment,
    { ...validDependencies, bodyTimeoutMilliseconds: 20 }
);
assert.equal(stalledReadResponse.status, 400);
assert.deepEqual(await stalledReadResponse.json(), { error: 'invalid-request' });
assert.ok(Date.now() - stalledReadStartedAt < 1_000);
assert.equal(stalledReadCancelCalls, 1);
assert.equal(serviceCalls.length, callsBeforeStalledRead);

let stalledCancelCalls = 0;
const overLimitBody = new ReadableStream({
    start(controller) {
        controller.enqueue(new Uint8Array((32 * 1024) + 1));
    },
    cancel() {
        stalledCancelCalls += 1;
        return new Promise(() => {});
    }
});
const callsBeforeStalledCancel = serviceCalls.length;
const stalledCancelStartedAt = Date.now();
const stalledCancelResponse = await handlePromotionRequest(
    streamedPromotionRequest(overLimitBody),
    environment,
    { ...validDependencies, bodyTimeoutMilliseconds: 2_000 }
);
assert.equal(stalledCancelResponse.status, 413);
assert.deepEqual(await stalledCancelResponse.json(), {
    error: 'request-too-large'
});
assert.ok(Date.now() - stalledCancelStartedAt < 1_000);
assert.equal(stalledCancelCalls, 1);
assert.equal(serviceCalls.length, callsBeforeStalledCancel);

const oversizedBody = JSON.stringify({ value: 'x'.repeat(33 * 1024) });
const oversizedResponse = await requestPromotion({ body: oversizedBody }, environment, validDependencies);
assert.equal(oversizedResponse.status, 413);

for (const [serviceResult, expected] of [
    [
        { ok: false, status: 409, code: 'promotion-not-eligible', private: 'hidden' },
        { status: 409, body: { error: 'promotion-not-eligible' } }
    ],
    [
        {
            ok: false,
            status: 409,
            code: 'promotion-cleaned',
            cleanupId: 'must-not-cross-worker-boundary',
            providerUploadId: 'must-not-cross-worker-boundary'
        },
        { status: 409, body: { error: 'promotion-cleaned' } }
    ],
    [
        { ok: false, status: 418, code: 'private-provider-error' },
        { status: 503, body: { error: 'service-unavailable' } }
    ],
    [
        null,
        { status: 503, body: { error: 'service-unavailable' } }
    ]
]) {
    const response = await requestPromotion({}, environment, {
        ...validDependencies,
        promotePhotoDraft: async () => serviceResult
    });
    assert.equal(response.status, expected.status);
    assert.deepEqual(await response.json(), expected.body);
}

const thrownServiceResponse = await requestPromotion({}, environment, {
    ...validDependencies,
    promotePhotoDraft: async () => {
        throw new Error('private-provider-error');
    }
});
assert.equal(thrownServiceResponse.status, 503);
assert.deepEqual(await thrownServiceResponse.json(), { error: 'service-unavailable' });

assert.equal('delete' in environment.DERIVATIVE_STAGING, false);
assert.equal('list' in environment.DERIVATIVE_STAGING, false);
assert.equal(typeof environment.APPROVED_MEDIA.delete, 'function');
assert.equal(typeof environment.APPROVED_MEDIA.list, 'function');
assert.equal('put' in environment.APPROVED_MEDIA, false);

console.log('Gallery photo promotion Worker boundary tests passed.');

function createEnvironment() {
    return {
        APPROVED_MEDIA: {
            async head() { return null; },
            async get() { return null; },
            async delete() {},
            async list() {
                return { objects: [], delimitedPrefixes: [], truncated: false };
            },
            async createMultipartUpload() { return null; },
            resumeMultipartUpload() { return null; }
        },
        APPROVED_MEDIA_ORIGIN: approvedMediaOrigin,
        DB: {
            prepare() {},
            async batch() { return []; }
        },
        DERIVATIVE_STAGING: {
            async head() { return null; },
            async get() { return null; }
        },
        PROMOTER_IDENTITIES: `subject:${promoterSubject}`,
        PROMOTION_ORIGIN: promotionOrigin
    };
}

async function requestPromotion(options = {}, env = environment, dependencies = validDependencies) {
    const method = options.method || 'POST';
    const url = options.url || `${promotionOrigin}${promotionPath}`;
    const headers = new Headers(options.headers || {});
    let body = Object.hasOwn(options, 'body')
        ? options.body
        : JSON.stringify(validInput);
    if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
        if (!headers.has('Content-Type')) {
            headers.set('Content-Type', 'application/json');
        }
        if (!headers.has('Content-Length')) {
            headers.set('Content-Length', String(Buffer.byteLength(body)));
        }
    } else {
        body = undefined;
    }
    return handlePromotionRequest(
        new Request(url, { method, headers, body }),
        env,
        dependencies
    );
}

function streamedPromotionRequest(body) {
    return new Request(`${promotionOrigin}${promotionPath}`, {
        method: 'POST',
        headers: {
            'Content-Length': '1',
            'Content-Type': 'application/json'
        },
        body,
        duplex: 'half'
    });
}
