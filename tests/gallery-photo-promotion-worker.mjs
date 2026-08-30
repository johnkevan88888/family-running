import assert from 'node:assert/strict';

import promotionWorker, {
    handlePromotionRequest
} from '../gallery-admin/src/promotion-worker.js';

const promotionOrigin = 'https://synthetic-gallery-promotion.example';
const approvedMediaOrigin = 'https://synthetic-gallery-media.example';
const promoterSubject = '0123456789abcdef0123456789abcdef.access';
const draftId = 'draft_11111111-1111-4111-8111-111111111111';
const promotionPath = `/api/service/drafts/${draftId}/photo-promotions`;
const promotionId = 'promotion_11111111111141118111111111111111';
const cleanupPath = `/api/service/photo-promotions/${promotionId}/cleanup`;
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
