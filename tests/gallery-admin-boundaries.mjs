import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const adminModule = await import('../gallery-admin/src/admin-worker.js');
const mediaModule = await import('../gallery-admin/src/media-worker.js');

const { handleAdminRequest } = adminModule;
const { handleMediaRequest } = mediaModule;

assert.equal(typeof handleAdminRequest, 'function');
assert.equal(typeof handleMediaRequest, 'function');
assert.equal(typeof adminModule.default?.fetch, 'function');
assert.equal(typeof mediaModule.default?.fetch, 'function');

const adminOrigin = 'https://synthetic-gallery-admin.example';
const familySiteQuery = '?site=family';
const everyoneSiteQuery = '?site=everyone';
const fixedNow = Date.UTC(2026, 7, 26, 12, 0, 0);
const serviceAudience =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const serviceClientId = '0123456789abcdef0123456789abcdef.access';
const serviceIssuer = 'https://synthetic-team.cloudflareaccess.com';
const serviceAssertionPayload = {
    type: 'app',
    aud: [serviceAudience],
    exp: 1787749200,
    iss: serviceIssuer,
    common_name: serviceClientId,
    iat: 1787745600,
    sub: ''
};
const privateValues = [
    'SESSION-SECRET-PRIVATE-SENTINEL-0123456789',
    'subject:synthetic-owner',
    'subject:synthetic-automation',
    'PRIVATE-D1-DIAGNOSTIC-SENTINEL'
];

const d1 = createFakeD1();
const adminEnv = {
    ADMIN_ORIGIN: adminOrigin,
    OWNER_IDENTITIES: 'subject:synthetic-owner',
    AUTOMATION_IDENTITIES: 'subject:synthetic-automation',
    SESSION_SECRET: privateValues[0],
    DB: d1
};

const identityFixtures = new Map([
    ['owner', { type: 'browser', subject: 'synthetic-owner' }],
    ['wrong-owner', { type: 'browser', subject: 'synthetic-wrong-owner' }],
    ['browser-automation-subject', { type: 'browser', subject: 'synthetic-automation' }],
    ['service', { type: 'service', subject: 'synthetic-automation' }],
    ['wrong-service', { type: 'service', subject: 'synthetic-wrong-automation' }],
    ['service-owner-subject', { type: 'service', subject: 'synthetic-owner' }]
]);

const verifyAccessIdentity = async request => {
    const fixtureName = request.headers.get('X-Synthetic-Identity');
    if (fixtureName === 'verification-error') {
        throw new Error(privateValues[3]);
    }
    return identityFixtures.get(fixtureName) || null;
};

const failedAdminResponses = [];

// Every browser route fails closed for an anonymous, unverified, wrong, or
// wrongly typed identity. Only the exact configured owner reaches it.
for (const identity of [null, 'unverified', 'wrong-owner', 'service-owner-subject']) {
    const response = await adminRequest('/api/browser/health', { identity });
    assert.equal(response.status, 403);
    failedAdminResponses.push(response.clone());
}

const verifierFailure = await adminRequest('/api/browser/health', {
    identity: 'verification-error'
});
assert.equal(verifierFailure.status, 403);
failedAdminResponses.push(verifierFailure.clone());

const ownerHealth = await adminRequest('/api/browser/health', { identity: 'owner' });
assert.equal(ownerHealth.status, 200);
assert.equal(ownerHealth.headers.get('Access-Control-Allow-Origin'), null);
await assertResponseOmits(ownerHealth.clone(), privateValues);

for (const [path, options] of [
    [`/${familySiteQuery}`, {}],
    ['/admin.css', {}],
    ['/admin.js', {}],
    [`/api/browser/session${familySiteQuery}`, {}],
    [`/api/browser/synthetic-records${familySiteQuery}`, {
        method: 'POST',
        headers: {
            Origin: adminOrigin,
            'Sec-Fetch-Site': 'same-origin'
        }
    }]
]) {
    const response = await adminRequest(path, options);
    assert.equal(response.status, 403, `Anonymous access to ${path} must fail.`);
    failedAdminResponses.push(response.clone());
}

// Every owner-workspace route is bound to exactly one source Gallery area.
// Missing, invalid, duplicated, or extended queries fail before route handling.
const sampleDraftId = 'draft_01k3h8xb6pg0t9m2q7vr4c5n1z';
const areaScopedBrowserPaths = [
    '/',
    '/api/browser/session',
    '/api/browser/synthetic-records',
    '/api/browser/catalog',
    '/api/browser/drafts',
    `/api/browser/drafts/${sampleDraftId}`,
    `/api/browser/drafts/${sampleDraftId}/upload`,
    `/api/browser/drafts/${sampleDraftId}/upload-parts/1`,
    `/api/browser/drafts/${sampleDraftId}/upload-completion`,
    `/api/browser/drafts/${sampleDraftId}/original`,
    `/api/browser/drafts/${sampleDraftId}/transitions`
];
const invalidAreaQueries = [
    { label: 'missing area query', query: '' },
    { label: 'invalid area query', query: '?site=friends' },
    { label: 'duplicate area query', query: '?site=family&site=family' },
    { label: 'extra area query', query: '?site=family&extra=1' }
];
for (const path of areaScopedBrowserPaths) {
    for (const { label, query } of invalidAreaQueries) {
        const response = await adminRequest(`${path}${query}`, { identity: 'owner' });
        assert.equal(response.status, 404, `${path}: ${label}`);
        failedAdminResponses.push(response.clone());
    }
}

// Static assets and health endpoints are deliberately queryless. A site or
// any other query is not ignored or normalized.
for (const [path, identity] of [
    ['/admin.css', 'owner'],
    ['/admin.js', 'owner'],
    ['/api/browser/health', 'owner'],
    ['/api/service/health', 'service']
]) {
    for (const query of [
        familySiteQuery,
        '?site=friends',
        '?site=family&site=family',
        '?extra=1'
    ]) {
        const response = await adminRequest(`${path}${query}`, { identity });
        assert.equal(response.status, 404, `${path}${query}`);
        failedAdminResponses.push(response.clone());
    }
}

const ownerShell = await adminRequest(`/${familySiteQuery}`, { identity: 'owner' });
assert.equal(ownerShell.status, 200);
assert.match(ownerShell.headers.get('Content-Type') || '', /^text\/html\b/);
const expectedAdminCsp = "default-src 'none'; script-src 'self'; style-src 'self'; " +
    "connect-src 'self'; img-src 'self'; media-src 'self'; base-uri 'none'; " +
    "frame-ancestors 'none'; form-action 'self'";
assert.equal(ownerShell.headers.get('Content-Security-Policy'), expectedAdminCsp);
assert.equal(ownerShell.headers.get('Cache-Control'), 'no-store');
const ownerShellBody = await ownerShell.clone().text();
assert.match(ownerShellBody, /Synthetic test mode/i);
assert.match(ownerShellBody, /Do not select or upload a real photograph or video/i);
assert.match(ownerShellBody, /<link rel="stylesheet" href="\/admin\.css">/i);
assert.match(ownerShellBody, /<script src="\/admin\.js" defer><\/script>/i);
assert.doesNotMatch(ownerShellBody, /<style\b/i);
assert.doesNotMatch(ownerShellBody, /<script(?![^>]*\bsrc=)[^>]*>/i);
assert.doesNotMatch(ownerShellBody, /https?:\/\//i);
await assertResponseOmits(ownerShell.clone(), privateValues);

for (const [path, contentType, bodyPattern] of [
    ['/admin.css', /^text\/css\b/, /\.synthetic-warning\b/],
    ['/admin.js', /^text\/javascript\b/, /\/api\/browser\/session/]
]) {
    const asset = await adminRequest(path, { identity: 'owner' });
    assert.equal(asset.status, 200, path);
    assert.match(asset.headers.get('Content-Type') || '', contentType, path);
    assert.equal(asset.headers.get('Content-Security-Policy'), expectedAdminCsp, path);
    assert.equal(asset.headers.get('Cache-Control'), 'no-store', path);
    const assetBody = await asset.clone().text();
    assert.match(assetBody, bodyPattern, path);
    assert.doesNotMatch(assetBody, /https?:\/\//i, `${path} must remain self-contained.`);
    await assertResponseOmits(asset.clone(), privateValues);
}

// A test-looking environment variable/header is never a production auth
// bypass. The default export uses the real Access verifier and fails closed.
const noBypassResponse = await adminModule.default.fetch(
    new Request(`${adminOrigin}/api/browser/health`, {
        headers: {
            'X-Synthetic-Identity': 'owner',
            'X-Test-Owner': 'true'
        }
    }),
    {
        ...adminEnv,
        DEV_BYPASS_AUTH: 'true',
        TEST_OWNER_IDENTITY: 'synthetic-owner'
    },
    {}
);
assert.equal(noBypassResponse.status, 403);
failedAdminResponses.push(noBypassResponse.clone());

const defaultOwnerResponse = await adminModule.default.fetch(
    new Request(`${adminOrigin}/api/browser/health`),
    adminEnv,
    {
        access: {
            async getIdentity() {
                return {
                    user_uuid: 'synthetic-owner',
                    email: 'owner@synthetic.invalid'
                };
            }
        }
    }
);
assert.equal(defaultOwnerResponse.status, 200);
await assertResponseOmits(defaultOwnerResponse.clone(), privateValues);

const pairedOwnerResponse = await adminModule.default.fetch(
    new Request(`${adminOrigin}/api/browser/health`),
    {
        ...adminEnv,
        OWNER_IDENTITIES: 'subject:synthetic-owner\nemail:owner@synthetic.invalid'
    },
    {
        access: {
            async getIdentity() {
                return {
                    user_uuid: 'synthetic-owner',
                    email: 'owner@synthetic.invalid'
                };
            }
        }
    }
);
assert.equal(pairedOwnerResponse.status, 200);

const multipleOwnerConfig = await adminModule.default.fetch(
    new Request(`${adminOrigin}/api/browser/health`),
    {
        ...adminEnv,
        OWNER_IDENTITIES: 'subject:synthetic-owner\nsubject:synthetic-second-owner'
    },
    {
        access: {
            async getIdentity() {
                return {
                    user_uuid: 'synthetic-owner',
                    email: 'owner@synthetic.invalid'
                };
            }
        }
    }
);
assert.equal(multipleOwnerConfig.status, 403);
failedAdminResponses.push(multipleOwnerConfig.clone());

const defaultServiceContext = {
    access: {
        async getIdentity() {
            return {
                service_token_status: true,
                service_token_id: 'synthetic-automation'
            };
        }
    }
};
const defaultServiceResponse = await adminModule.default.fetch(
    new Request(`${adminOrigin}/api/service/health`),
    adminEnv,
    defaultServiceContext
);
assert.equal(defaultServiceResponse.status, 200);
await assertResponseOmits(defaultServiceResponse.clone(), privateValues);

const defaultServiceOnBrowserRoute = await adminModule.default.fetch(
    new Request(`${adminOrigin}/api/browser/health`),
    adminEnv,
    defaultServiceContext
);
assert.equal(defaultServiceOnBrowserRoute.status, 403);
failedAdminResponses.push(defaultServiceOnBrowserRoute.clone());

// Worker-level Access can expose a service token using the documented
// application-token claim shape instead of the full get-identity shape.
const applicationClaimServiceContext = {
    access: {
        async getIdentity() {
            return {
                type: 'app',
                sub: '',
                common_name: 'synthetic-automation'
            };
        }
    }
};
const applicationClaimServiceResponse = await adminModule.default.fetch(
    new Request(`${adminOrigin}/api/service/health`),
    adminEnv,
    applicationClaimServiceContext
);
assert.equal(applicationClaimServiceResponse.status, 200);
await assertResponseOmits(applicationClaimServiceResponse.clone(), privateValues);

const applicationClaimServiceOnBrowserRoute = await adminModule.default.fetch(
    new Request(`${adminOrigin}/api/browser/health`),
    adminEnv,
    applicationClaimServiceContext
);
assert.equal(applicationClaimServiceOnBrowserRoute.status, 403);
failedAdminResponses.push(applicationClaimServiceOnBrowserRoute.clone());

// Worker-level Access currently resolves getIdentity() to undefined for a
// Service Auth request while supplying a validated application assertion and
// its audience on ctx.access. The assertion fallback remains service-only and
// exact-allowlisted.
const serviceAssertion = createAccessAssertion(serviceAssertionPayload);
const assertionServiceEnv = {
    ...adminEnv,
    AUTOMATION_IDENTITIES: `subject:${serviceClientId}`
};
const assertionServiceContext = {
    access: {
        aud: serviceAudience,
        async getIdentity() {
            return undefined;
        }
    }
};
const assertionServiceRequest = path => new Request(`${adminOrigin}${path}`, {
    headers: {
        'Cf-Access-Jwt-Assertion': serviceAssertion
    }
});

const assertionServiceResponse = await adminModule.default.fetch(
    assertionServiceRequest('/api/service/health'),
    assertionServiceEnv,
    assertionServiceContext
);
assert.equal(assertionServiceResponse.status, 200);
await assertResponseOmits(assertionServiceResponse.clone(), privateValues);

const stringAudienceServiceResponse = await adminModule.default.fetch(
    new Request(`${adminOrigin}/api/service/health`, {
        headers: {
            'Cf-Access-Jwt-Assertion': createAccessAssertion({
                ...serviceAssertionPayload,
                aud: serviceAudience
            })
        }
    }),
    assertionServiceEnv,
    assertionServiceContext
);
assert.equal(stringAudienceServiceResponse.status, 200);

const assertionServiceOnBrowserRoute = await adminModule.default.fetch(
    assertionServiceRequest('/api/browser/health'),
    assertionServiceEnv,
    assertionServiceContext
);
assert.equal(assertionServiceOnBrowserRoute.status, 403);
failedAdminResponses.push(assertionServiceOnBrowserRoute.clone());

const browserContextWithServiceAssertion = {
    access: {
        aud: serviceAudience,
        async getIdentity() {
            return {
                user_uuid: 'synthetic-owner',
                email: 'owner@synthetic.invalid'
            };
        }
    }
};
const browserCannotBecomeService = await adminModule.default.fetch(
    assertionServiceRequest('/api/service/health'),
    assertionServiceEnv,
    browserContextWithServiceAssertion
);
assert.equal(browserCannotBecomeService.status, 403);
failedAdminResponses.push(browserCannotBecomeService.clone());

const wrongServiceClientId = 'fedcba9876543210fedcba9876543210.access';
const invalidServiceAssertions = [
    null,
    '',
    'not-a-jwt',
    createAccessAssertion([]),
    createAccessAssertion({
        ...serviceAssertionPayload,
        type: 'org'
    }),
    createAccessAssertion({
        ...serviceAssertionPayload,
        sub: 'not-empty'
    }),
    createAccessAssertion({
        ...serviceAssertionPayload,
        email: 'owner@synthetic.invalid'
    }),
    createAccessAssertion({
        ...serviceAssertionPayload,
        common_name: 'not-a-service-client-id'
    }),
    createAccessAssertion({
        ...serviceAssertionPayload,
        common_name: wrongServiceClientId
    }),
    createAccessAssertion({
        ...serviceAssertionPayload,
        aud: ['wrong-audience']
    }),
    createAccessAssertion({
        ...serviceAssertionPayload,
        aud: 'wrong-audience'
    }),
    createAccessAssertion({
        ...serviceAssertionPayload,
        iss: 'https://example.invalid'
    }),
    createAccessAssertion({
        ...serviceAssertionPayload,
        iat: null
    }),
    createAccessAssertion({
        ...serviceAssertionPayload,
        exp: 'later'
    }),
    createAccessAssertion({
        ...serviceAssertionPayload,
        exp: serviceAssertionPayload.iat
    })
];

for (const assertion of invalidServiceAssertions) {
    const headers = new Headers();
    if (assertion !== null) {
        headers.set('Cf-Access-Jwt-Assertion', assertion);
    }
    const response = await adminModule.default.fetch(
        new Request(`${adminOrigin}/api/service/health`, { headers }),
        assertionServiceEnv,
        assertionServiceContext
    );
    assert.equal(response.status, 403);
    failedAdminResponses.push(response.clone());
}

for (const access of [
    {
        async getIdentity() {
            return undefined;
        }
    },
    {
        aud: 'wrong-audience',
        async getIdentity() {
            return undefined;
        }
    }
]) {
    const response = await adminModule.default.fetch(
        assertionServiceRequest('/api/service/health'),
        assertionServiceEnv,
        { access }
    );
    assert.equal(response.status, 403);
    failedAdminResponses.push(response.clone());
}

for (const identity of [
    { type: 'app', common_name: 'synthetic-automation' },
    { type: 'app', sub: 'not-a-service-token', common_name: 'synthetic-automation' },
    { type: 'org', sub: '', common_name: 'synthetic-automation' },
    { type: 'app', sub: '', common_name: 'synthetic-wrong-automation' },
    { type: 'app', sub: '', common_name: 'synthetic-automation\u0000' },
    {
        type: 'app',
        sub: '',
        common_name: 'synthetic-automation',
        service_token_status: false
    }
]) {
    const response = await adminModule.default.fetch(
        new Request(`${adminOrigin}/api/service/health`),
        adminEnv,
        {
            access: {
                async getIdentity() {
                    return identity;
                }
            }
        }
    );
    assert.equal(response.status, 403);
    failedAdminResponses.push(response.clone());
}

const browserIdentityWithApplicationClaims = {
    access: {
        async getIdentity() {
            return {
                type: 'app',
                sub: '',
                common_name: 'synthetic-automation',
                user_uuid: 'synthetic-owner',
                email: 'owner@synthetic.invalid'
            };
        }
    }
};
const browserWithApplicationClaimsResponse = await adminModule.default.fetch(
    new Request(`${adminOrigin}/api/browser/health`),
    adminEnv,
    browserIdentityWithApplicationClaims
);
assert.equal(browserWithApplicationClaimsResponse.status, 200);
const browserWithApplicationClaimsOnServiceRoute = await adminModule.default.fetch(
    new Request(`${adminOrigin}/api/service/health`),
    adminEnv,
    browserIdentityWithApplicationClaims
);
assert.equal(browserWithApplicationClaimsOnServiceRoute.status, 403);
failedAdminResponses.push(browserWithApplicationClaimsOnServiceRoute.clone());

const statusOnlyServiceIdentity = await adminModule.default.fetch(
    new Request(`${adminOrigin}/api/service/health`),
    adminEnv,
    {
        access: {
            async getIdentity() {
                return { service_token_status: true };
            }
        }
    }
);
assert.equal(statusOnlyServiceIdentity.status, 403);
failedAdminResponses.push(statusOnlyServiceIdentity.clone());

const browserIdentityWithFalseServiceStatus = {
    access: {
        async getIdentity() {
            return {
                service_token_status: false,
                common_name: 'synthetic-automation-looking-name',
                user_uuid: 'synthetic-owner',
                email: 'owner@synthetic.invalid'
            };
        }
    }
};
const falseServiceStatusBrowserResponse = await adminModule.default.fetch(
    new Request(`${adminOrigin}/api/browser/health`),
    adminEnv,
    browserIdentityWithFalseServiceStatus
);
assert.equal(
    falseServiceStatusBrowserResponse.status,
    200,
    'Only explicit true service-token status may turn a valid browser identity into a service identity.'
);
const falseServiceStatusServiceResponse = await adminModule.default.fetch(
    new Request(`${adminOrigin}/api/service/health`),
    adminEnv,
    browserIdentityWithFalseServiceStatus
);
assert.equal(falseServiceStatusServiceResponse.status, 403);
failedAdminResponses.push(falseServiceStatusServiceResponse.clone());

// Browser and automation identities are deliberately non-interchangeable.
for (const identity of [null, 'owner', 'browser-automation-subject', 'wrong-service']) {
    const response = await adminRequest('/api/service/health', { identity });
    assert.equal(response.status, 403);
    failedAdminResponses.push(response.clone());
}

const serviceHealth = await adminRequest('/api/service/health', { identity: 'service' });
assert.equal(serviceHealth.status, 200);
await assertResponseOmits(serviceHealth.clone(), privateValues);

const serviceOnBrowserRoute = await adminRequest('/api/browser/health', {
    identity: 'service'
});
assert.equal(serviceOnBrowserRoute.status, 403);
failedAdminResponses.push(serviceOnBrowserRoute.clone());

const serviceHeadersOnBrowserRoute = await adminRequest('/api/browser/health', {
    identity: 'owner',
    headers: {
        'Cf-Access-Client-Id': 'PRIVATE-CLIENT-ID-SENTINEL',
        'Cf-Access-Client-Secret': 'PRIVATE-CLIENT-SECRET-SENTINEL'
    }
});
assert.equal(serviceHeadersOnBrowserRoute.status, 403);
failedAdminResponses.push(serviceHeadersOnBrowserRoute.clone());

const unknownAdminRoute = await adminRequest('/api/browser/not-a-route', {
    identity: 'owner'
});
assert.equal(unknownAdminRoute.status, 404);
await assertResponseOmits(unknownAdminRoute.clone(), privateValues);

// Issue a real signed session through the owner route. The cookie must be
// host-only, secure, HTTP-only, strict same-site, and contain no raw identity or
// secret value.
const sessionResponse = await adminRequest(`/api/browser/session${familySiteQuery}`, {
    identity: 'owner'
});
assert.equal(sessionResponse.status, 200);
const sessionBody = await sessionResponse.clone().json();
assert.match(sessionBody.csrfToken, /^[A-Za-z0-9_-]{20,}$/);
assert.deepEqual(Object.keys(sessionBody), ['csrfToken']);

const setCookie = sessionResponse.headers.get('Set-Cookie');
assert.ok(setCookie);
assert.match(setCookie, /^__Host-gallery_admin_session_family=/);
assert.match(setCookie, /; Path=\//i);
assert.match(setCookie, /; Secure/i);
assert.match(setCookie, /; HttpOnly/i);
assert.match(setCookie, /; SameSite=Strict/i);
assert.doesNotMatch(setCookie, /; Domain=/i);
for (const value of privateValues) {
    assert.equal(setCookie.includes(value), false);
}
assert.equal(setCookie.includes('synthetic-owner'), false);

const sessionCookie = setCookie.split(';', 1)[0];
const everyoneSessionResponse = await adminRequest(
    `/api/browser/session${everyoneSiteQuery}`,
    { identity: 'owner' }
);
assert.equal(everyoneSessionResponse.status, 200);
const everyoneSessionBody = await everyoneSessionResponse.clone().json();
assert.match(everyoneSessionBody.csrfToken, /^[A-Za-z0-9_-]{20,}$/);
const everyoneSetCookie = everyoneSessionResponse.headers.get('Set-Cookie');
assert.ok(everyoneSetCookie);
assert.match(everyoneSetCookie, /^__Host-gallery_admin_session_everyone=/);
assert.notEqual(everyoneSetCookie.split(';', 1)[0], sessionCookie);
assert.match(everyoneSetCookie, /; Path=\//i);
assert.match(everyoneSetCookie, /; Secure/i);
assert.match(everyoneSetCookie, /; HttpOnly/i);
assert.match(everyoneSetCookie, /; SameSite=Strict/i);
assert.doesNotMatch(everyoneSetCookie, /; Domain=/i);
for (const value of privateValues) {
    assert.equal(everyoneSetCookie.includes(value), false);
}

const validMutationHeaders = {
    Origin: adminOrigin,
    'Sec-Fetch-Site': 'same-origin',
    Cookie: sessionCookie,
    'X-CSRF-Token': sessionBody.csrfToken
};
const everyoneMutationHeaders = {
    Origin: adminOrigin,
    'Sec-Fetch-Site': 'same-origin',
    Cookie: everyoneSetCookie.split(';', 1)[0],
    'X-CSRF-Token': everyoneSessionBody.csrfToken
};
const syntheticCanary = 'synthetic:phase-b-auth-boundary-v1';

const writesBeforeCrossAreaMutation = d1.writes.length;
const familySessionOnEveryoneArea = await adminRequest(
    `/api/browser/synthetic-records${everyoneSiteQuery}`,
    {
        method: 'POST',
        identity: 'owner',
        headers: validMutationHeaders
    }
);
assert.equal(familySessionOnEveryoneArea.status, 403);
assert.equal(d1.writes.length, writesBeforeCrossAreaMutation);
failedAdminResponses.push(familySessionOnEveryoneArea.clone());

const validEveryoneMutation = await adminRequest(
    `/api/browser/synthetic-records${everyoneSiteQuery}`,
    {
        method: 'POST',
        identity: 'owner',
        headers: everyoneMutationHeaders
    }
);
assert.equal(validEveryoneMutation.status, 201);
assert.equal(d1.writes.length, writesBeforeCrossAreaMutation + 1);

const writesBeforeValidMutation = d1.writes.length;
const validMutation = await adminRequest(`/api/browser/synthetic-records${familySiteQuery}`, {
    method: 'POST',
    identity: 'owner',
    headers: validMutationHeaders
});
assert.equal(validMutation.status, 201);
assert.equal(d1.writes.length, writesBeforeValidMutation + 1);
assert.equal(
    d1.writes.at(-1).bindings.includes(syntheticCanary),
    true,
    'Only the server-generated synthetic canary should reach D1.'
);
assert.match(d1.writes.at(-1).sql, /phase_b_synthetic_records/i);
assert.equal(
    d1.writes.at(-1).bindings.some(value => privateValues.includes(value)),
    false,
    'Session and configuration secrets must not be persisted as record values.'
);
await assertResponseOmits(validMutation.clone(), privateValues);

const zeroLengthMutation = await adminRequest(
    `/api/browser/synthetic-records${familySiteQuery}`,
    {
    method: 'POST',
    identity: 'owner',
    headers: { ...validMutationHeaders, 'Content-Length': '0' }
    }
);
assert.equal(zeroLengthMutation.status, 201);
assert.equal(d1.writes.at(-1).bindings.includes(syntheticCanary), true);

// Each browser mutation defense is independently mandatory and runs before
// the D1 write. This also proves that permissive CORS is not a fallback.
const rejectedMutations = [
    { label: 'missing Origin', omit: ['Origin'] },
    { label: 'cross-site Origin', replace: { Origin: 'https://attacker.invalid' } },
    { label: 'opaque Origin', replace: { Origin: 'null' } },
    { label: 'missing fetch metadata', omit: ['Sec-Fetch-Site'] },
    { label: 'cross-site fetch metadata', replace: { 'Sec-Fetch-Site': 'cross-site' } },
    { label: 'missing CSRF token', omit: ['X-CSRF-Token'] },
    { label: 'wrong CSRF token', replace: { 'X-CSRF-Token': 'wrong-token' } },
    { label: 'missing session cookie', omit: ['Cookie'] },
    { label: 'tampered session cookie', replace: { Cookie: `${sessionCookie}tampered` } }
];

for (const testCase of rejectedMutations) {
    const headers = { ...validMutationHeaders, ...(testCase.replace || {}) };
    for (const name of testCase.omit || []) {
        deleteHeaderCaseInsensitively(headers, name);
    }

    const writesBefore = d1.writes.length;
    const response = await adminRequest(`/api/browser/synthetic-records${familySiteQuery}`, {
        method: 'POST',
        identity: 'owner',
        headers
    });
    assert.equal(response.status, 403, testCase.label);
    assert.equal(d1.writes.length, writesBefore, `${testCase.label} must not write D1.`);
    assert.notEqual(response.headers.get('Access-Control-Allow-Origin'), '*');
    failedAdminResponses.push(response.clone());
}

const expiredSession = await adminRequest(`/api/browser/synthetic-records${familySiteQuery}`, {
    method: 'POST',
    identity: 'owner',
    headers: validMutationHeaders,
    now: fixedNow + (31 * 60 * 1000)
});
assert.equal(expiredSession.status, 403);
failedAdminResponses.push(expiredSession.clone());

for (const body of [
    { text: syntheticCanary },
    { text: 'synthetic:plausible-runner-name-race-date' },
    { text: 'real-family-record' },
    'synthetic:plausible-personal-detail',
    ''
]) {
    const writesBefore = d1.writes.length;
    const response = await adminRequest(`/api/browser/synthetic-records${familySiteQuery}`, {
        method: 'POST',
        identity: 'owner',
        headers: validMutationHeaders,
        body
    });
    assert.equal(response.status, 400);
    assert.equal(d1.writes.length, writesBefore);
    assert.equal(
        (await response.clone().text()).includes('plausible-personal-detail'),
        false
    );
    failedAdminResponses.push(response.clone());
}

for (const forbiddenBodyHeader of [
    { 'Content-Type': 'application/json' },
    { 'Content-Length': '1' },
    { 'Transfer-Encoding': 'chunked' }
]) {
    const writesBefore = d1.writes.length;
    const response = await adminRequest(`/api/browser/synthetic-records${familySiteQuery}`, {
        method: 'POST',
        identity: 'owner',
        headers: { ...validMutationHeaders, ...forbiddenBodyHeader }
    });
    assert.equal(response.status, 400);
    assert.equal(d1.writes.length, writesBefore);
    failedAdminResponses.push(response.clone());
}

for (const [path, method, expectedStatus] of [
    ['/api/browser/retention-tombstones', 'POST', 404],
    // This is now a recognized private-draft route, so it must reject a
    // mutation lacking the signed session and CSRF proof before method routing.
    [`/api/browser/drafts/${sampleDraftId}${familySiteQuery}`, 'DELETE', 403]
]) {
    const writesBefore = d1.writes.length;
    const response = await adminRequest(path, { method, identity: 'owner' });
    assert.equal(response.status, expectedStatus, path);
    assert.equal(d1.writes.length, writesBefore);
    failedAdminResponses.push(response.clone());
}

for (const response of failedAdminResponses) {
    await assertResponseOmits(response, [
        ...privateValues,
        'PRIVATE-CLIENT-ID-SENTINEL',
        'PRIVATE-CLIENT-SECRET-SENTINEL'
    ]);
}

// Public derivative delivery: exact immutable keys, allowlisted types, safe
// headers, byte ranges, and a binding boundary that has no path to originals,
// staging, D1, list, or write operations.
const displayHash = 'a'.repeat(64);
const thumbnailHash = 'b'.repeat(64);
const posterHash = 'c'.repeat(64);
const videoHash = 'd'.repeat(64);
const displayKey = `media/v1/${displayHash}/display.webp`;
const thumbnailKey = `media/v1/${thumbnailHash}/thumbnail.webp`;
const posterKey = `media/v1/${posterHash}/poster.webp`;
const videoKey = `media/v1/${videoHash}/video.mp4`;
const mediaBodies = new Map([
    [displayKey, bytes('synthetic-display')],
    [thumbnailKey, bytes('synthetic-thumbnail')],
    [posterKey, bytes('synthetic-poster')],
    [videoKey, bytes('0123456789')]
]);
const maliciousMetadataSentinel = 'PRIVATE-R2-METADATA-SENTINEL';
const approvedBucket = createApprovedBucket(mediaBodies, maliciousMetadataSentinel);
const mediaEnv = createDeliveryEnv(approvedBucket);

const defaultMediaResponse = await mediaModule.default.fetch(
    new Request(`https://synthetic-gallery-media.example/${displayKey}`),
    mediaEnv,
    {
        access: {
            async getIdentity() {
                return { user_uuid: 'irrelevant-public-media-identity' };
            }
        }
    }
);
assert.equal(defaultMediaResponse.status, 200);
assert.equal(defaultMediaResponse.headers.get('Content-Type'), 'image/webp');

for (const [key, expectedType] of [
    [displayKey, 'image/webp'],
    [thumbnailKey, 'image/webp'],
    [posterKey, 'image/webp'],
    [videoKey, 'video/mp4']
]) {
    const response = await handleMediaRequest(
        new Request(`https://synthetic-gallery-media.example/${key}`),
        mediaEnv
    );
    assert.equal(response.status, 200, key);
    assert.equal(response.headers.get('Content-Type'), expectedType);
    assert.match(response.headers.get('Content-Disposition') || '', /^inline(?:;|$)/);
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, noimageindex');
    assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
    assert.match(response.headers.get('Cache-Control') || '', /max-age=/);
    assert.equal(Number(response.headers.get('Content-Length')), mediaBodies.get(key).byteLength);
    assert.deepEqual(
        new Uint8Array(await response.arrayBuffer()),
        mediaBodies.get(key)
    );

    const serializedHeaders = JSON.stringify([...response.headers]);
    assert.equal(serializedHeaders.includes(maliciousMetadataSentinel), false);
    assert.equal(response.headers.get('X-Private-Metadata'), null);
}

const callsBeforeHead = approvedBucket.calls.length;
const headResponse = await handleMediaRequest(
    new Request(`https://synthetic-gallery-media.example/${videoKey}`, { method: 'HEAD' }),
    mediaEnv
);
assert.equal(headResponse.status, 200);
assert.equal(await headResponse.text(), '');
assert.equal(headResponse.headers.get('Content-Type'), 'video/mp4');
assert.equal(Number(headResponse.headers.get('Content-Length')), mediaBodies.get(videoKey).byteLength);
assert.deepEqual(
    approvedBucket.calls.slice(callsBeforeHead).map(call => call.operation),
    ['head'],
    'HEAD must not read the object body.'
);

const callsBeforeRange = approvedBucket.calls.length;
const rangeResponse = await handleMediaRequest(
    new Request(`https://synthetic-gallery-media.example/${videoKey}`, {
        headers: { Range: 'bytes=2-5' }
    }),
    mediaEnv
);
assert.equal(rangeResponse.status, 206);
assert.equal(rangeResponse.headers.get('Content-Range'), 'bytes 2-5/10');
assert.equal(rangeResponse.headers.get('Content-Length'), '4');
assert.equal(await rangeResponse.text(), '2345');
assert.deepEqual(
    approvedBucket.calls.slice(callsBeforeRange).map(call => call.operation),
    ['head', 'get']
);
assert.deepEqual(approvedBucket.calls.at(-1).range, { offset: 2, length: 4 });
assert.deepEqual(approvedBucket.calls.at(-1).onlyIf, { etagMatches: 'synthetic-etag' });

const privateRangeBody = bytes('PRIVATE-RANGE-BODY-SENTINEL');
for (const testCase of [
    {
        label: 'missing returned range evidence',
        behavior: { returnedRange: undefined }
    },
    {
        label: 'mismatched returned range evidence',
        behavior: { returnedRange: { offset: 1, length: 4 } }
    },
    {
        label: 'object ETag changed after HEAD',
        behavior: { getRawEtag: 'changed-etag' }
    },
    {
        label: 'object size changed after HEAD',
        behavior: { getSize: privateRangeBody.byteLength + 1 }
    }
]) {
    const unstableBucket = createApprovedBucket(
        new Map([[videoKey, privateRangeBody]]),
        maliciousMetadataSentinel,
        testCase.behavior
    );
    const response = await handleMediaRequest(
        new Request(`https://synthetic-gallery-media.example/${videoKey}`, {
            headers: { Range: 'bytes=0-3' }
        }),
        createDeliveryEnv(unstableBucket)
    );
    assert.equal(response.status, 503, testCase.label);
    assert.equal(await response.clone().text(), '', `${testCase.label} leaked a body.`);
    await assertResponseOmits(response.clone(), [
        'PRIVATE-RANGE-BODY-SENTINEL',
        maliciousMetadataSentinel
    ]);
    assert.deepEqual(
        unstableBucket.calls.map(call => call.operation),
        ['head', 'get'],
        testCase.label
    );
}

for (const range of ['bytes=10-11', 'bytes=4-2', 'bytes=0-1,3-4', 'items=0-1']) {
    const callsBefore = approvedBucket.calls.length;
    const response = await handleMediaRequest(
        new Request(`https://synthetic-gallery-media.example/${videoKey}`, {
            headers: { Range: range }
        }),
        mediaEnv
    );
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('Content-Range'), 'bytes */10');
    assert.deepEqual(
        approvedBucket.calls.slice(callsBefore).map(call => call.operation),
        ['head'],
        `${range} must not request a body.`
    );
}

const missingResponse = await handleMediaRequest(
    new Request(`https://synthetic-gallery-media.example/media/v1/${'e'.repeat(64)}/display.webp`),
    mediaEnv
);
assert.equal(missingResponse.status, 404);

const invalidMediaUrls = [
    '/',
    '/media/v1/',
    `/media/v1/${displayHash}`,
    `/media/v1/${displayHash}/`,
    `/media/v1/${displayHash.toUpperCase()}/display.webp`,
    `/media/v1/${'f'.repeat(63)}/display.webp`,
    `/media/v1/${displayHash}/DISPLAY.webp`,
    `/media/v1/${displayHash}/display.mp4`,
    `/media/v1/${videoHash}/video.webp`,
    `/media/v1/${displayHash}/original.jpg`,
    `/media/v1/${displayHash}/display.webp/extra`,
    `/media/v1/${displayHash}/display.webp?download=1`,
    `/media/v1/${displayHash}/display.webp?source=originals`,
    `/media/v1/%2e%2e/${displayHash}/display.webp`,
    '/originals/private-object',
    '/staging/private-object',
    '/api/browser/health',
    `/?key=${encodeURIComponent(displayKey)}`
];

for (const path of invalidMediaUrls) {
    const callsBefore = approvedBucket.calls.length;
    const response = await handleMediaRequest(
        new Request(`https://synthetic-gallery-media.example${path}`),
        mediaEnv
    );
    assert.equal(response.status, 404, path);
    assert.equal(approvedBucket.calls.length, callsBefore, `${path} must not touch R2.`);
}

for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const callsBefore = approvedBucket.calls.length;
    const response = await handleMediaRequest(
        new Request(`https://synthetic-gallery-media.example/${displayKey}`, { method }),
        mediaEnv
    );
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get('Allow'), 'GET, HEAD');
    assert.equal(approvedBucket.calls.length, callsBefore, `${method} must not touch R2.`);
}

assert.deepEqual(
    [...new Set(approvedBucket.calls.map(call => call.operation))].sort(),
    ['get', 'head'],
    'The delivery Worker may only inspect and read approved objects.'
);

// The reviewed deployment examples carry resource names only. Their static
// binding shape is itself a security boundary: the public Worker has no way to
// acquire a private bucket or D1 binding, and alternate preview addresses stay
// disabled.
const adminConfigSource = await readFile(
    new URL('../gallery-admin/wrangler.admin.example.jsonc', import.meta.url),
    'utf8'
);
const mediaConfigSource = await readFile(
    new URL('../gallery-admin/wrangler.media.example.jsonc', import.meta.url),
    'utf8'
);
const adminConfig = JSON.parse(stripJsonComments(adminConfigSource));
const mediaConfig = JSON.parse(stripJsonComments(mediaConfigSource));
const invalidLocalConfigId = 'REPLACE_ONLY_IN_IGNORED_LOCAL_CONFIG';

assert.equal(adminConfig.name, 'family-running-gallery-admin-dev');
assert.equal(adminConfig.main, 'src/admin-worker.js');
assert.equal(adminConfig.workers_dev, true);
assert.equal(adminConfig.preview_urls, false);
assert.deepEqual(adminConfig.triggers, { crons: ['0 * * * *'] });
assert.equal(Object.hasOwn(adminConfig, 'assets'), false);
assert.equal(adminConfig.account_id, invalidLocalConfigId);
assert.deepEqual(adminConfig.d1_databases, [{
    binding: 'DB',
    database_name: 'family-running-gallery-dev',
    database_id: invalidLocalConfigId
}]);
assert.equal(
    /^[0-9a-f]{32}$/.test(adminConfig.d1_databases[0].database_id),
    false,
    'The tracked admin example must remain deliberately nondeployable.'
);
assert.deepEqual(adminConfig.r2_buckets, [{
    binding: 'PRIVATE_ORIGINALS',
    bucket_name: 'family-running-gallery-originals-dev'
}]);
assert.deepEqual(
    [
        ...adminConfig.d1_databases.map(binding => binding.binding),
        ...adminConfig.r2_buckets.map(binding => binding.binding)
    ].sort(),
    ['DB', 'PRIVATE_ORIGINALS'],
    'The private admin Worker must receive exactly D1 and the private-originals bucket.'
);
assert.equal(
    /APPROVED_MEDIA|DERIVATIVE_STAGING|(?:^|[^A-Z])STAGING(?:[^A-Z]|$)/.test(adminConfigSource),
    false,
    'The private admin configuration must not acquire approved or staging storage.'
);

assert.equal(mediaConfig.name, 'family-running-gallery-media-dev');
assert.equal(mediaConfig.main, 'src/media-worker.js');
assert.equal(mediaConfig.workers_dev, true);
assert.equal(mediaConfig.preview_urls, false);
assert.equal(Object.hasOwn(mediaConfig, 'assets'), false);
assert.equal(mediaConfig.account_id, invalidLocalConfigId);
assert.equal(Object.hasOwn(mediaConfig, 'd1_databases'), false);
assert.deepEqual(mediaConfig.r2_buckets, [{
    binding: 'APPROVED_MEDIA',
    bucket_name: 'family-running-gallery-approved-dev'
}]);

for (const [label, source, config] of [
    ['admin', adminConfigSource, adminConfig],
    ['media', mediaConfigSource, mediaConfig]
]) {
    assert.equal(config.account_id, invalidLocalConfigId, `${label} inert account ID`);
    assert.equal(/^[0-9a-f]{32}$/.test(config.account_id), false, `${label} real account ID`);
    assert.equal(Object.hasOwn(config, 'routes'), false, `${label} routes`);
    assert.doesNotMatch(
        source,
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
        `${label} UUID`
    );
    assert.doesNotMatch(source, /\b[0-9a-f]{32}\b/i, `${label} Cloudflare resource ID`);
    assert.doesNotMatch(source, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i, `${label} email`);
    assert.doesNotMatch(source, /https?:\/\//i, `${label} private URL`);
    assert.doesNotMatch(source, /(?:<[^>]+>|\$\{[^}]+\})/, `${label} replacement template`);
    assert.doesNotMatch(
        source,
        /"(?:token|secret|password|owner_identities|access_aud)"\s*:/i,
        `${label} credential value`
    );
}

assert.equal(
    (adminConfigSource.match(/REPLACE_ONLY_IN_IGNORED_LOCAL_CONFIG/g) || []).length,
    2,
    'The admin example must carry inert account and D1 identifiers.'
);
assert.equal(
    (mediaConfigSource.match(/REPLACE_ONLY_IN_IGNORED_LOCAL_CONFIG/g) || []).length,
    1,
    'The media example must carry one inert account identifier.'
);

assert.equal(
    mediaConfigSource.includes('PRIVATE_ORIGINALS') ||
        mediaConfigSource.includes('DERIVATIVE_STAGING') ||
        mediaConfigSource.includes('"DB"'),
    false,
    'The public media configuration must not name any private binding.'
);

// Apply the exact reviewed D1 migration to SQLite and exercise its database-
// enforced fail-closed rules, independent of the Worker handler.
const migrationSource = await readFile(
    new URL('../gallery-admin/migrations/0001_private_gallery.sql', import.meta.url),
    'utf8'
);
const phaseCMigrationSource = await readFile(
    new URL('../gallery-admin/migrations/0002_private_uploads.sql', import.meta.url),
    'utf8'
);
const database = new DatabaseSync(':memory:');
database.exec(migrationSource);

assert.equal(database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
assert.deepEqual(
    database.prepare(
        "SELECT name FROM sqlite_schema " +
        "WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map(row => row.name),
    [
        'draft_consent_attestations',
        'draft_derivatives',
        'draft_publication_references',
        'draft_transition_receipts',
        'gallery_audit_events',
        'gallery_drafts',
        'gallery_retention_tombstones',
        'pending_athlete_exclusions',
        'phase_b_synthetic_records'
    ]
);
assert.deepEqual(
    database.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name"
    ).all().map(row => row.name),
    [
        'draft_consent_attestations_immutable_guard',
        'draft_consent_attestations_no_replace_guard',
        'draft_consent_withdrawal_deactivate',
        'draft_consent_withdrawal_evidence_guard',
        'draft_consent_withdrawal_shape_guard',
        'draft_derivatives_identity_update_guard',
        'draft_derivatives_no_replace_guard',
        'draft_derivatives_pending_exclusion_insert_guard',
        'draft_derivatives_pending_exclusion_update_guard',
        'draft_derivatives_revision_insert_guard',
        'draft_derivatives_revision_update_guard',
        'draft_derivatives_unique_update_guard',
        'draft_publication_references_identity_update_guard',
        'draft_publication_references_no_replace_guard',
        'draft_transition_receipts_direct_delete_guard',
        'draft_transition_receipts_no_replace_guard',
        'draft_transition_receipts_no_update',
        'gallery_audit_events_no_delete',
        'gallery_audit_events_no_replace_guard',
        'gallery_audit_events_no_update',
        'gallery_drafts_active_consent_assignment_guard',
        'gallery_drafts_consent_state_gate_guard',
        'gallery_drafts_derivative_revision_change_guard',
        'gallery_drafts_identity_update_guard',
        'gallery_drafts_initial_state_guard',
        'gallery_drafts_item_revision_guard',
        'gallery_drafts_no_replace_guard',
        'gallery_drafts_pending_exclusion_insert_guard',
        'gallery_drafts_pending_exclusion_state_guard',
        'gallery_drafts_pending_exclusion_tag_guard',
        'gallery_drafts_purge_guard',
        'gallery_drafts_state_version_guard',
        'gallery_drafts_transition_guard',
        'gallery_drafts_unique_update_guard',
        'gallery_drafts_withdrawal_evidence_guard',
        'gallery_retention_tombstones_no_delete',
        'gallery_retention_tombstones_no_replace_guard',
        'gallery_retention_tombstones_no_update',
        'pending_athlete_exclusions_delete_guard',
        'pending_athlete_exclusions_immutable_guard',
        'pending_athlete_exclusions_no_replace_guard',
        'pending_athlete_exclusions_resolution_guard',
        'phase_b_synthetic_records_no_replace_guard'
    ]
);

const identityHash = '1'.repeat(64);
const timestamp = '2026-08-26T12:00:00.000Z';
database.prepare(
    'INSERT INTO phase_b_synthetic_records ' +
    '(record_id, synthetic_text, actor_identity_hash, created_at) VALUES (?, ?, ?, ?)'
).run('synthetic-record-1', syntheticCanary, identityHash, timestamp);
for (const [recordId, text] of [
    ['other-synthetic-record', 'synthetic:plausible-personal-detail'],
    ['non-synthetic-record', 'private:migration-canary']
]) {
    assert.throws(
        () => database.prepare(
            'INSERT INTO phase_b_synthetic_records ' +
            '(record_id, synthetic_text, actor_identity_hash, created_at) VALUES (?, ?, ?, ?)'
        ).run(recordId, text, identityHash, timestamp),
        /CHECK constraint failed/i
    );
}

database.prepare(
    'INSERT INTO gallery_drafts (' +
    'draft_id, public_item_id, site_modes_json, export_bundle_id, ' +
    'source_revision, suppression_revision, item_revision, media_type, ' +
    'race_date, race_event, race_distance, athlete_ids_json, title, caption, ' +
    'alt_text, featured, verified_owner_identity_hash, created_at, updated_at' +
    ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
).run(
    'draft_01k3h8xb6pg0t9m2q7vr4c5n1z',
    'synthetic-migration-item',
    '["family"]',
    'bundle-synthetic',
    'source-synthetic',
    'suppression-synthetic',
    'item-synthetic',
    'photo',
    '2026-08-26',
    'Synthetic 5 km',
    '5 km',
    '[]',
    'Synthetic title',
    'Synthetic caption',
    'Synthetic alternative text',
    0,
    identityHash,
    timestamp,
    timestamp
);

assert.throws(
    () => database.exec(
        "UPDATE gallery_drafts SET state = 'published', state_version = 1 " +
        "WHERE public_item_id = 'synthetic-migration-item'"
    ),
    /invalid gallery draft state transition/i
);
assert.throws(
    () => database.exec(
        "UPDATE gallery_drafts SET state = 'uploading', state_version = 2 " +
        "WHERE public_item_id = 'synthetic-migration-item'"
    ),
    /one-step compare-and-swap/i
);
database.exec(
    "UPDATE gallery_drafts SET state = 'uploading', state_version = 1 " +
    "WHERE public_item_id = 'synthetic-migration-item'"
);
assert.throws(
    () => database.exec(
        "UPDATE gallery_drafts SET state_version = 2 " +
        "WHERE public_item_id = 'synthetic-migration-item'"
    ),
    /one-step compare-and-swap/i
);
database.exec(
    "UPDATE gallery_drafts SET state = 'withdrawal-pending', state_version = 2 " +
    "WHERE public_item_id = 'synthetic-migration-item'"
);
assert.throws(
    () => database.exec(
        "UPDATE gallery_drafts SET state = 'withdrawn', state_version = 3 " +
        "WHERE public_item_id = 'synthetic-migration-item'"
    ),
    /verified withdrawal evidence is required/i
);
database.prepare(
    'INSERT INTO draft_publication_references (' +
    'draft_id, host_deletion_confirmed, private_original_deletion_confirmed, ' +
    'withdrawal_kind, updated_at' +
    ') VALUES (?, ?, ?, ?, ?)'
).run(
    'draft_01k3h8xb6pg0t9m2q7vr4c5n1z',
    1,
    0,
    'editorial-removal',
    timestamp
);
database.exec(
    "UPDATE gallery_drafts SET state = 'withdrawn', state_version = 3 " +
    "WHERE public_item_id = 'synthetic-migration-item'"
);
const withdrawnDraft = database.prepare(
    "SELECT state, state_version AS stateVersion FROM gallery_drafts " +
    "WHERE public_item_id = 'synthetic-migration-item'"
).get();
assert.equal(withdrawnDraft.state, 'withdrawn');
assert.equal(withdrawnDraft.stateVersion, 3);

database.prepare(
    'INSERT INTO gallery_audit_events ' +
    '(audit_event_id, subject_reference_hash, event_type, state_version, actor_identity_hash, payload_hash, occurred_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?)'
).run(
    'synthetic-audit-1',
    '2'.repeat(64),
    'synthetic-created',
    1,
    identityHash,
    '3'.repeat(64),
    timestamp
);
assert.throws(
    () => database.exec(
        "UPDATE gallery_audit_events SET payload_hash = '" + '4'.repeat(64) + "' " +
        "WHERE audit_event_id = 'synthetic-audit-1'"
    ),
    /append-only/i
);
assert.throws(
    () => database.exec(
        "DELETE FROM gallery_audit_events WHERE audit_event_id = 'synthetic-audit-1'"
    ),
    /append-only/i
);
assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM gallery_audit_events').get().count,
    1
);

// Drafts always begin at draft/version zero. The database prevents REPLACE
// from turning its implicit delete into a state or retention bypass; caller-
// supplied expected-version CAS remains a later transactional service concern.
for (const [draftId, overrides] of [
    ['draft_invalid_published_01', { state: 'published' }],
    ['draft_invalid_withdrawn_01', { state: 'withdrawn' }],
    ['draft_invalid_version_01', { stateVersion: 1 }]
]) {
    assert.throws(
        () => insertMigrationDraft(database, draftId, overrides),
        /inserted at draft version zero/i
    );
}

const replaceDraftId = 'draft_replace_guard_0001';
insertMigrationDraft(database, replaceDraftId);
insertMigrationConsent(database, replaceDraftId, 'consent-v1');
assert.throws(
    () => insertMigrationDraft(
        database,
        replaceDraftId,
        { state: 'published', stateVersion: 7 },
        true
    ),
    /(replacement is forbidden|inserted at draft version zero)/i
);
assert.equal(
    database.prepare('SELECT state FROM gallery_drafts WHERE draft_id = ?')
        .get(replaceDraftId).state,
    'draft'
);
assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM draft_consent_attestations WHERE draft_id = ?')
        .get(replaceDraftId).count,
    1
);

// Active consent is one explicit valid revision. Invalid, guardian-incomplete,
// or already withdrawn evidence cannot become current, and current evidence
// cannot be withdrawn without the host-first deletion proof.
const consentDraftId = 'draft_consent_guard_001';
insertMigrationDraft(database, consentDraftId);
insertMigrationConsent(database, consentDraftId, 'consent-valid');
insertMigrationConsent(database, consentDraftId, 'consent-no-public', {
    publicUseConfirmed: 0
});
insertMigrationConsent(database, consentDraftId, 'consent-no-guardian', {
    containsMinors: 1,
    guardianApprovalConfirmed: 0
});
insertMigrationConsent(database, consentDraftId, 'consent-withdrawn', {
    withdrawnAt: timestamp
});
for (const revision of [
    'consent-no-public',
    'consent-no-guardian',
    'consent-withdrawn'
]) {
    assert.throws(
        () => activateMigrationConsent(database, consentDraftId, revision),
        /active consent must reference a valid attestation/i
    );
}
activateMigrationConsent(database, consentDraftId, 'consent-valid');
assert.throws(
    () => database.prepare(
        'UPDATE draft_consent_attestations SET withdrawn_at = ? ' +
        'WHERE draft_id = ? AND consent_revision = ?'
    ).run(timestamp, consentDraftId, 'consent-valid'),
    /consent withdrawal requires verified object deletion/i
);

const noConsentDraftId = 'draft_no_consent_gate_01';
insertMigrationDraft(database, noConsentDraftId);
advanceMigrationDraft(database, noConsentDraftId, 'uploading');
advanceMigrationDraft(database, noConsentDraftId, 'private-review');
assert.throws(
    () => advanceMigrationDraft(database, noConsentDraftId, 'approved-for-processing'),
    /valid active consent is required/i
);

const withdrawalDraftId = 'draft_consent_withdraw_1';
insertMigrationDraft(database, withdrawalDraftId);
insertMigrationConsent(database, withdrawalDraftId, 'consent-v1');
activateMigrationConsent(database, withdrawalDraftId, 'consent-v1');
insertMigrationPublication(database, withdrawalDraftId, {
    hostDeletionConfirmed: 1,
    privateOriginalDeletionConfirmed: 1,
    withdrawalKind: 'consent-withdrawal'
});
advanceMigrationDraft(database, withdrawalDraftId, 'withdrawal-pending');
database.prepare(
    'UPDATE draft_consent_attestations SET withdrawn_at = ? ' +
    'WHERE draft_id = ? AND consent_revision = ?'
).run(timestamp, withdrawalDraftId, 'consent-v1');
assert.equal(
    database.prepare('SELECT active_consent_revision FROM gallery_drafts WHERE draft_id = ?')
        .get(withdrawalDraftId).active_consent_revision,
    null
);

// Derivative evidence is inseparable from all five active draft revisions.
// Stale inserts/updates and later draft-revision edits fail closed.
insertMigrationConsent(database, consentDraftId, 'consent-v2');
for (const [field, value] of [
    ['itemRevision', 'stale-item'],
    ['consentRevision', 'consent-v2'],
    ['exportBundleId', 'stale-bundle'],
    ['sourceRevision', 'stale-source'],
    ['suppressionRevision', 'stale-suppression']
]) {
    assert.throws(
        () => insertMigrationDerivative(
            database,
            consentDraftId,
            'photo-display',
            { [field]: value }
        ),
        /derivative evidence revisions are stale/i,
        field
    );
}
insertMigrationDerivative(database, consentDraftId, 'photo-display');
assert.throws(
    () => database.prepare(
        'UPDATE draft_derivatives SET item_revision = ? WHERE draft_id = ? AND role = ?'
    ).run('stale-item', consentDraftId, 'photo-display'),
    /updated derivative evidence revisions are stale/i
);
for (const [column, value] of [
    ['item_revision', 'item-v2'],
    ['active_consent_revision', 'consent-v2'],
    ['export_bundle_id', 'bundle-v2'],
    ['source_revision', 'source-v2'],
    ['suppression_revision', 'suppression-v2']
]) {
    assert.throws(
        () => database.prepare(
            `UPDATE gallery_drafts SET ${column} = ? WHERE draft_id = ?`
        ).run(value, consentDraftId),
        /derivative evidence must be cleared/i,
        column
    );
}

// A pending exclusion carries a public athlete ID plus opaque revision/audit
// hashes, never a name, reason, or note. It blocks every publicward state and
// any tag edit that would add that athlete until complete resolution evidence.
const exclusionColumns = database.prepare(
    'PRAGMA table_info(pending_athlete_exclusions)'
).all().map(column => column.name);
assert.deepEqual(exclusionColumns, [
    'athlete_id',
    'exclusion_revision',
    'expected_suppression_revision',
    'request_audit_hash',
    'actor_identity_hash',
    'created_at',
    'updated_at',
    'resolved_suppression_revision',
    'resolution_audit_hash',
    'resolved_at'
]);
assert.equal(exclusionColumns.some(column => /name|reason|note|email/i.test(column)), false);
for (const invalidAthleteId of [
    'Athlete-One', 'athlete name', '../athlete', '-athlete', 'athlete-', 'athlete--one'
]) {
    assert.throws(
        () => insertPendingExclusion(database, invalidAthleteId),
        /CHECK constraint failed/i
    );
}

const pendingAthleteId = 'public-athlete-id';
const stateCases = [
    ['draft_pending_approval_01', ['uploading', 'private-review'], 'approved-for-processing'],
    ['draft_pending_process_001', ['uploading', 'private-review', 'approved-for-processing'], 'processing'],
    ['draft_pending_candidate_01', ['uploading', 'private-review', 'approved-for-processing', 'processing'], 'candidate-public'],
    ['draft_pending_pr_open_001', ['uploading', 'private-review', 'approved-for-processing', 'processing', 'candidate-public'], 'pr-open'],
    ['draft_pending_publish_001', ['uploading', 'private-review', 'approved-for-processing', 'processing', 'candidate-public', 'pr-open'], 'published']
];
for (const [draftId, path] of stateCases) {
    insertMigrationDraft(database, draftId, {
        athleteIdsJson: JSON.stringify([pendingAthleteId])
    });
    insertMigrationConsent(database, draftId, 'consent-v1');
    activateMigrationConsent(database, draftId, 'consent-v1');
    for (const state of path) {
        advanceMigrationDraft(database, draftId, state);
    }
}
const tagDraftId = 'draft_pending_tag_edit_01';
insertMigrationDraft(database, tagDraftId);
const midProcessingDraftId = stateCases[1][0];
insertMigrationDerivative(database, midProcessingDraftId, 'photo-display');
insertPendingExclusion(database, pendingAthleteId);
for (const [draftId, , nextState] of stateCases) {
    assert.throws(
        () => advanceMigrationDraft(database, draftId, nextState),
        /pending athlete exclusion blocks gallery advancement/i,
        nextState
    );
}
assert.throws(
    () => database.prepare(
        'UPDATE gallery_drafts SET athlete_ids_json = ?, item_revision = ? WHERE draft_id = ?'
    ).run(JSON.stringify([pendingAthleteId]), 'tag-edit-v2', tagDraftId),
    /gallery tags contain a pending athlete exclusion/i
);
assert.throws(
    () => database.prepare(
        'UPDATE gallery_drafts SET athlete_ids_json = ?, item_revision = ? WHERE draft_id = ?'
    ).run('[]', 'excluded-tag-removal-v2', stateCases[0][0]),
    /gallery tags contain a pending athlete exclusion/i
);
assert.throws(
    () => database.prepare(
        'UPDATE draft_derivatives SET byte_count = ? WHERE draft_id = ? AND role = ?'
    ).run(11, midProcessingDraftId, 'photo-display'),
    /pending athlete exclusion blocks derivative evidence/i
);
assert.throws(
    () => insertMigrationDerivative(database, midProcessingDraftId, 'photo-thumbnail'),
    /pending athlete exclusion blocks derivative evidence/i
);
assert.throws(
    () => insertMigrationDraft(database, 'draft_pending_insert_001', {
        athleteIdsJson: JSON.stringify([pendingAthleteId])
    }),
    /gallery draft contains a pending athlete exclusion/i
);
database.prepare(
    'UPDATE pending_athlete_exclusions SET resolved_suppression_revision = ?, ' +
    'resolution_audit_hash = ?, resolved_at = ?, updated_at = ? WHERE athlete_id = ?'
).run(
    'suppression-v2',
    '7'.repeat(64),
    '2026-08-26T12:06:00.000Z',
    '2026-08-26T12:06:00.000Z',
    pendingAthleteId
);
advanceMigrationDraft(database, stateCases[0][0], stateCases[0][2]);

// Non-null object keys have one owner while NULL remains available during
// drafting. This keeps host-first deletion and takedown evidence unambiguous.
const storageDraftA = 'draft_storage_owner_a_01';
const storageDraftB = 'draft_storage_owner_b_01';
insertMigrationDraft(database, storageDraftA, { originalObjectKey: 'originals/shared-key' });
insertMigrationDraft(database, storageDraftB);
assert.throws(
    () => database.prepare(
        'UPDATE gallery_drafts SET original_object_key = ? WHERE draft_id = ?'
    ).run('originals/shared-key', storageDraftB),
    /gallery draft update conflicts with existing storage ownership/i
);
for (const draftId of [storageDraftA, storageDraftB]) {
    insertMigrationConsent(database, draftId, 'consent-v1');
    activateMigrationConsent(database, draftId, 'consent-v1');
}
insertMigrationDerivative(database, storageDraftA, 'photo-display', {
    stagingObjectKey: 'staging/shared-key'
});
assert.throws(
    () => insertMigrationDerivative(database, storageDraftB, 'photo-display', {
        stagingObjectKey: 'staging/shared-key'
    }),
    /derivative evidence replacement is forbidden/i
);
insertMigrationDerivative(database, storageDraftB, 'photo-thumbnail', {
    stagingObjectKey: null
});

// Purge is explicit and terminal. Private child rows cascade, but the opaque
// append-only audit and approved tombstone survive and remain immutable.
const purgeDraftId = 'draft_retention_purge_001';
insertMigrationDraft(database, purgeDraftId, { originalObjectKey: 'originals/purge-key' });
insertMigrationConsent(database, purgeDraftId, 'consent-v1');
activateMigrationConsent(database, purgeDraftId, 'consent-v1');
insertMigrationDerivative(database, purgeDraftId, 'photo-display', {
    stagingObjectKey: 'staging/purge-key'
});
insertMigrationPublication(database, purgeDraftId, {
    hostDeletionConfirmed: 1,
    privateOriginalDeletionConfirmed: 1,
    withdrawalKind: 'consent-withdrawal'
});
database.prepare(
    'INSERT INTO draft_transition_receipts (' +
    'draft_id, idempotency_key, payload_fingerprint, from_state, to_state, ' +
    'expected_state_version, result_state_version, created_at' +
    ') VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
).run(
    purgeDraftId,
    'synthetic-idempotency-key',
    '8'.repeat(64),
    'draft',
    'withdrawal-pending',
    0,
    1,
    timestamp
);
const purgeReceiptBefore = migrationRowsSnapshot(
    database,
    'SELECT * FROM draft_transition_receipts WHERE draft_id = ?',
    purgeDraftId
);
assert.throws(
    () => database.prepare(
        'INSERT OR REPLACE INTO draft_transition_receipts (' +
        'draft_id, idempotency_key, payload_fingerprint, from_state, to_state, ' +
        'expected_state_version, result_state_version, created_at' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
        purgeDraftId,
        'synthetic-idempotency-key',
        'f'.repeat(64),
        'draft',
        'withdrawal-pending',
        0,
        1,
        timestamp
    ),
    /replacement is forbidden/i
);
assert.throws(
    () => database.prepare(
        'UPDATE draft_transition_receipts SET payload_fingerprint = ? ' +
        'WHERE draft_id = ? AND idempotency_key = ?'
    ).run('f'.repeat(64), purgeDraftId, 'synthetic-idempotency-key'),
    /append-only/i
);
assert.throws(
    () => database.prepare(
        'DELETE FROM draft_transition_receipts WHERE draft_id = ? AND idempotency_key = ?'
    ).run(purgeDraftId, 'synthetic-idempotency-key'),
    /direct deletion is forbidden/i
);
assert.equal(
    migrationRowsSnapshot(
        database,
        'SELECT * FROM draft_transition_receipts WHERE draft_id = ?',
        purgeDraftId
    ),
    purgeReceiptBefore
);
advanceMigrationDraft(database, purgeDraftId, 'withdrawal-pending');
advanceMigrationDraft(database, purgeDraftId, 'withdrawn');
database.prepare(
    'INSERT INTO gallery_audit_events (' +
    'audit_event_id, subject_reference_hash, event_type, state_version, ' +
    'actor_identity_hash, payload_hash, occurred_at' +
    ') VALUES (?, ?, ?, ?, ?, ?, ?)'
).run(
    'synthetic-audit-purge',
    '9'.repeat(64),
    'retention-approved',
    2,
    identityHash,
    'a'.repeat(64),
    timestamp
);
database.prepare(
    'INSERT INTO gallery_retention_tombstones (' +
    'draft_id, purge_kind, eligible_at, approved_at, approved_by_identity_hash, evidence_hash' +
    ') VALUES (?, ?, ?, ?, ?, ?)'
).run(
    purgeDraftId,
    'consent-withdrawal',
    timestamp,
    timestamp,
    identityHash,
    'b'.repeat(64)
);
database.prepare('DELETE FROM gallery_drafts WHERE draft_id = ?').run(purgeDraftId);
for (const table of [
    'draft_consent_attestations',
    'draft_derivatives',
    'draft_publication_references',
    'draft_transition_receipts'
]) {
    assert.equal(
        database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE draft_id = ?`)
            .get(purgeDraftId).count,
        0,
        table
    );
}
assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM gallery_audit_events WHERE audit_event_id = ?')
        .get('synthetic-audit-purge').count,
    1
);
assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM gallery_retention_tombstones WHERE draft_id = ?')
        .get(purgeDraftId).count,
    1
);
assert.throws(
    () => database.prepare(
        'UPDATE gallery_retention_tombstones SET evidence_hash = ? WHERE draft_id = ?'
    ).run('c'.repeat(64), purgeDraftId),
    /append-only/i
);

const blockedPurgeDraftId = 'draft_retention_blocked_01';
insertMigrationDraft(database, blockedPurgeDraftId);
insertMigrationPublication(database, blockedPurgeDraftId, {
    hostDeletionConfirmed: 1,
    privateOriginalDeletionConfirmed: 1
});
database.prepare(
    'INSERT INTO gallery_retention_tombstones (' +
    'draft_id, purge_kind, eligible_at, approved_at, approved_by_identity_hash, evidence_hash' +
    ') VALUES (?, ?, ?, ?, ?, ?)'
).run(
    blockedPurgeDraftId,
    'retention-expiry',
    timestamp,
    timestamp,
    identityHash,
    'd'.repeat(64)
);
assert.throws(
    () => database.prepare('DELETE FROM gallery_drafts WHERE draft_id = ?')
        .run(blockedPurgeDraftId),
    /purge requires approved cleanup evidence/i
);

// SQLite REPLACE performs an implicit delete on any UNIQUE conflict. Every
// private/evidence table rejects that operation before the old row or its
// cascaded children can disappear.
const publicCollisionDraftId = 'draft_public_collision_01';
insertMigrationDraft(database, publicCollisionDraftId);
insertMigrationConsent(database, publicCollisionDraftId, 'consent-v1');
const publicCollisionChildren = migrationRowsSnapshot(
    database,
    'SELECT * FROM draft_consent_attestations WHERE draft_id = ?',
    publicCollisionDraftId
);
assertMigrationReplacementForbidden(
    database,
    'SELECT * FROM gallery_drafts WHERE draft_id = ?',
    [publicCollisionDraftId],
    () => insertMigrationDraft(
        database,
        'draft_new_public_collision',
        { publicItemId: `${publicCollisionDraftId}-item` },
        true
    )
);
assert.equal(
    migrationRowsSnapshot(
        database,
        'SELECT * FROM draft_consent_attestations WHERE draft_id = ?',
        publicCollisionDraftId
    ),
    publicCollisionChildren
);

const originalCollisionDraftId = 'draft_original_collision_1';
insertMigrationDraft(database, originalCollisionDraftId, {
    originalObjectKey: 'originals/replace-collision'
});
insertMigrationConsent(database, originalCollisionDraftId, 'consent-v1');
const originalCollisionChildren = migrationRowsSnapshot(
    database,
    'SELECT * FROM draft_consent_attestations WHERE draft_id = ?',
    originalCollisionDraftId
);
assertMigrationReplacementForbidden(
    database,
    'SELECT * FROM gallery_drafts WHERE draft_id = ?',
    [originalCollisionDraftId],
    () => insertMigrationDraft(
        database,
        'draft_new_original_collision',
        { originalObjectKey: 'originals/replace-collision' },
        true
    )
);
assert.equal(
    migrationRowsSnapshot(
        database,
        'SELECT * FROM draft_consent_attestations WHERE draft_id = ?',
        originalCollisionDraftId
    ),
    originalCollisionChildren
);

assertMigrationReplacementForbidden(
    database,
    'SELECT * FROM draft_consent_attestations WHERE draft_id = ? AND consent_revision = ?',
    [consentDraftId, 'consent-valid'],
    () => database.prepare(
        'INSERT OR REPLACE INTO draft_consent_attestations (' +
        'draft_id, consent_revision, public_use_confirmed, contains_minors, ' +
        'guardian_approval_confirmed, private_evidence_reference, ' +
        'verified_owner_identity_hash, attested_at, withdrawn_at' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
        consentDraftId,
        'consent-valid',
        0,
        0,
        0,
        'changed-evidence',
        identityHash,
        timestamp,
        null
    )
);

const derivativeCollisionSnapshot = migrationRowsSnapshot(
    database,
    'SELECT * FROM draft_derivatives WHERE draft_id IN (?, ?) ORDER BY draft_id, role',
    storageDraftA,
    storageDraftB
);
for (const operation of [
    () => insertMigrationDerivative(
        database,
        storageDraftA,
        'photo-display',
        { approvedObjectKey: 'approved/replacement-attempt' },
        true
    ),
    () => insertMigrationDerivative(
        database,
        storageDraftB,
        'video-poster',
        { stagingObjectKey: 'staging/shared-key' },
        true
    ),
    () => insertMigrationDerivative(
        database,
        storageDraftB,
        'video-poster',
        { approvedObjectKey: `${storageDraftA}/photo-display/approved` },
        true
    )
]) {
    assert.throws(operation, /replacement is forbidden/i);
    assert.equal(
        migrationRowsSnapshot(
            database,
            'SELECT * FROM draft_derivatives WHERE draft_id IN (?, ?) ORDER BY draft_id, role',
            storageDraftA,
            storageDraftB
        ),
        derivativeCollisionSnapshot
    );
}

assertMigrationReplacementForbidden(
    database,
    'SELECT * FROM draft_publication_references WHERE draft_id = ?',
    [blockedPurgeDraftId],
    () => database.prepare(
        'INSERT OR REPLACE INTO draft_publication_references (' +
        'draft_id, host_deletion_confirmed, private_original_deletion_confirmed, ' +
        'withdrawal_kind, updated_at' +
        ') VALUES (?, ?, ?, ?, ?)'
    ).run(blockedPurgeDraftId, 0, 0, null, '2026-08-26T13:00:00.000Z')
);

assertMigrationReplacementForbidden(
    database,
    'SELECT * FROM pending_athlete_exclusions WHERE athlete_id = ?',
    [pendingAthleteId],
    () => database.prepare(
        'INSERT OR REPLACE INTO pending_athlete_exclusions (' +
        'athlete_id, exclusion_revision, expected_suppression_revision, ' +
        'request_audit_hash, actor_identity_hash, created_at, updated_at' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
        pendingAthleteId,
        'changed-exclusion',
        'changed-suppression',
        'e'.repeat(64),
        identityHash,
        timestamp,
        timestamp
    )
);

assertMigrationReplacementForbidden(
    database,
    'SELECT * FROM gallery_audit_events WHERE audit_event_id = ?',
    ['synthetic-audit-1'],
    () => database.prepare(
        'INSERT OR REPLACE INTO gallery_audit_events (' +
        'audit_event_id, subject_reference_hash, event_type, state_version, ' +
        'actor_identity_hash, payload_hash, occurred_at' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
        'synthetic-audit-1',
        'e'.repeat(64),
        'replacement-attempt',
        9,
        identityHash,
        'f'.repeat(64),
        timestamp
    )
);

assertMigrationReplacementForbidden(
    database,
    'SELECT * FROM gallery_retention_tombstones WHERE draft_id = ?',
    [purgeDraftId],
    () => database.prepare(
        'INSERT OR REPLACE INTO gallery_retention_tombstones (' +
        'draft_id, purge_kind, eligible_at, approved_at, approved_by_identity_hash, evidence_hash' +
        ') VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
        purgeDraftId,
        'retention-expiry',
        timestamp,
        timestamp,
        identityHash,
        'f'.repeat(64)
    )
);

assertMigrationReplacementForbidden(
    database,
    'SELECT * FROM phase_b_synthetic_records WHERE record_id = ?',
    ['synthetic-record-1'],
    () => database.prepare(
        'INSERT OR REPLACE INTO phase_b_synthetic_records ' +
        '(record_id, synthetic_text, actor_identity_hash, created_at) VALUES (?, ?, ?, ?)'
    ).run('synthetic-record-1', syntheticCanary, 'f'.repeat(64), timestamp)
);

// UPDATE OR REPLACE must not delete a different row that owns a public item or
// object key. Identity columns are immutable even when no collision exists.
let updateEvidenceBefore = migrationPrivateEvidenceSnapshot(database);
assert.throws(
    () => database.prepare(
        'UPDATE OR REPLACE gallery_drafts SET public_item_id = ?, item_revision = ? ' +
        'WHERE draft_id = ?'
    ).run(
        `${publicCollisionDraftId}-item`,
        'update-collision-item-v2',
        replaceDraftId
    ),
    /gallery draft update conflicts with existing storage ownership/i
);
assert.equal(migrationPrivateEvidenceSnapshot(database), updateEvidenceBefore);

updateEvidenceBefore = migrationPrivateEvidenceSnapshot(database);
assert.throws(
    () => database.prepare(
        'UPDATE OR REPLACE gallery_drafts SET original_object_key = ? WHERE draft_id = ?'
    ).run('originals/replace-collision', storageDraftB),
    /gallery draft update conflicts with existing storage ownership/i
);
assert.equal(migrationPrivateEvidenceSnapshot(database), updateEvidenceBefore);

for (const [column, value] of [
    ['staging_object_key', 'staging/shared-key'],
    ['approved_object_key', `${storageDraftA}/photo-display/approved`]
]) {
    updateEvidenceBefore = migrationPrivateEvidenceSnapshot(database);
    assert.throws(
        () => database.prepare(
            `UPDATE OR REPLACE draft_derivatives SET ${column} = ? ` +
            'WHERE draft_id = ? AND role = ?'
        ).run(value, storageDraftB, 'photo-thumbnail'),
        /derivative update conflicts with existing storage ownership/i,
        column
    );
    assert.equal(migrationPrivateEvidenceSnapshot(database), updateEvidenceBefore);
}

updateEvidenceBefore = migrationPrivateEvidenceSnapshot(database);
assert.throws(
    () => database.prepare(
        'UPDATE gallery_drafts SET draft_id = ? WHERE draft_id = ?'
    ).run('draft_identity_mutation_01', replaceDraftId),
    /gallery draft identity is immutable/i
);
assert.equal(migrationPrivateEvidenceSnapshot(database), updateEvidenceBefore);

for (const [assignment, bindings, expectedFailure] of [
    [
        'draft_id = ?',
        ['draft_derivative_identity_1'],
        /(derivative evidence identity is immutable|updated derivative evidence revisions are stale)/i
    ],
    ['role = ?', ['video-poster'], /derivative evidence identity is immutable/i]
]) {
    updateEvidenceBefore = migrationPrivateEvidenceSnapshot(database);
    assert.throws(
        () => database.prepare(
            `UPDATE draft_derivatives SET ${assignment} WHERE draft_id = ? AND role = ?`
        ).run(...bindings, storageDraftB, 'photo-thumbnail'),
        expectedFailure
    );
    assert.equal(migrationPrivateEvidenceSnapshot(database), updateEvidenceBefore);
}

updateEvidenceBefore = migrationPrivateEvidenceSnapshot(database);
assert.throws(
    () => database.prepare(
        'UPDATE draft_publication_references SET draft_id = ? WHERE draft_id = ?'
    ).run('draft_publication_identity_1', blockedPurgeDraftId),
    /publication evidence identity is immutable/i
);
assert.equal(migrationPrivateEvidenceSnapshot(database), updateEvidenceBefore);

// Phase C is a forward-only addition to the reviewed Phase B schema. Apply it
// after the Phase B regression cases above so those original guarantees remain
// independently exercised, then assert the complete resulting schema exactly.
database.exec(phaseCMigrationSource);

assert.deepEqual(
    database.prepare(
        "SELECT name FROM sqlite_schema " +
        "WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map(row => row.name),
    [
        'draft_consent_attestations',
        'draft_derivatives',
        'draft_mutation_receipts',
        'draft_publication_references',
        'draft_transition_receipts',
        'draft_upload_parts',
        'draft_upload_sessions',
        'gallery_audit_events',
        'gallery_drafts',
        'gallery_retention_tombstones',
        'pending_athlete_exclusions',
        'phase_b_synthetic_records'
    ]
);
const phaseCTriggerNames = database.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name"
).all().map(row => row.name);
assert.equal(phaseCTriggerNames.length, 70);
assert.deepEqual(
    phaseCTriggerNames,
    [
        'draft_consent_attestations_immutable_guard',
        'draft_consent_attestations_no_replace_guard',
        'draft_consent_withdrawal_deactivate',
        'draft_consent_withdrawal_evidence_guard',
        'draft_consent_withdrawal_shape_guard',
        'draft_derivatives_identity_update_guard',
        'draft_derivatives_no_replace_guard',
        'draft_derivatives_pending_exclusion_insert_guard',
        'draft_derivatives_pending_exclusion_update_guard',
        'draft_derivatives_revision_insert_guard',
        'draft_derivatives_revision_update_guard',
        'draft_derivatives_unique_update_guard',
        'draft_mutation_receipts_direct_delete_guard',
        'draft_mutation_receipts_no_replace_guard',
        'draft_mutation_receipts_no_update',
        'draft_mutation_receipts_result_guard',
        'draft_publication_references_identity_update_guard',
        'draft_publication_references_no_replace_guard',
        'draft_transition_receipts_direct_delete_guard',
        'draft_transition_receipts_no_replace_guard',
        'draft_transition_receipts_no_update',
        'draft_transition_receipts_result_guard',
        'draft_upload_parts_direct_delete_guard',
        'draft_upload_parts_insert_guard',
        'draft_upload_parts_no_replace_guard',
        'draft_upload_parts_no_update',
        'draft_upload_sessions_completion_guard',
        'draft_upload_sessions_completion_start_guard',
        'draft_upload_sessions_identity_guard',
        'draft_upload_sessions_insert_guard',
        'draft_upload_sessions_no_replace_guard',
        'draft_upload_sessions_pending_exclusion_guard',
        'draft_upload_sessions_progress_guard',
        'draft_upload_sessions_progress_transition_guard',
        'draft_upload_sessions_status_guard',
        'draft_upload_sessions_terminal_shape_guard',
        'gallery_audit_events_no_delete',
        'gallery_audit_events_no_replace_guard',
        'gallery_audit_events_no_update',
        'gallery_drafts_active_consent_assignment_guard',
        'gallery_drafts_active_upload_media_guard',
        'gallery_drafts_completed_original_immutable_guard',
        'gallery_drafts_consent_state_gate_guard',
        'gallery_drafts_derivative_revision_change_guard',
        'gallery_drafts_identity_update_guard',
        'gallery_drafts_initial_state_guard',
        'gallery_drafts_item_revision_guard',
        'gallery_drafts_no_replace_guard',
        'gallery_drafts_pending_exclusion_insert_guard',
        'gallery_drafts_pending_exclusion_state_guard',
        'gallery_drafts_pending_exclusion_tag_guard',
        'gallery_drafts_phase_c_purge_object_guard',
        'gallery_drafts_private_review_upload_guard',
        'gallery_drafts_purge_guard',
        'gallery_drafts_single_site_insert_guard',
        'gallery_drafts_single_site_update_guard',
        'gallery_drafts_site_mode_immutable_guard',
        'gallery_drafts_state_version_guard',
        'gallery_drafts_transition_guard',
        'gallery_drafts_unique_update_guard',
        'gallery_drafts_upload_completion_guard',
        'gallery_drafts_withdrawal_evidence_guard',
        'gallery_retention_tombstones_no_delete',
        'gallery_retention_tombstones_no_replace_guard',
        'gallery_retention_tombstones_no_update',
        'pending_athlete_exclusions_delete_guard',
        'pending_athlete_exclusions_immutable_guard',
        'pending_athlete_exclusions_no_replace_guard',
        'pending_athlete_exclusions_resolution_guard',
        'phase_b_synthetic_records_no_replace_guard'
    ]
);
assert.deepEqual(
    database.prepare(
        "SELECT name FROM sqlite_schema " +
        "WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map(row => row.name),
    [
        'draft_upload_sessions_current_index',
        'draft_upload_sessions_expiry_index',
        'gallery_audit_events_subject_index',
        'gallery_drafts_state_index',
        'gallery_drafts_suppression_revision_index',
        'pending_athlete_exclusions_active_index'
    ]
);
assert.deepEqual(
    database.prepare('PRAGMA table_info(draft_upload_parts)').all().map(column => column.name),
    ['upload_session_id', 'part_number', 'provider_etag', 'byte_count', 'sha256', 'uploaded_at']
);
assert.deepEqual(
    database.prepare('PRAGMA table_info(draft_mutation_receipts)').all()
        .map(column => column.name),
    [
        'draft_id',
        'idempotency_key',
        'mutation_kind',
        'payload_fingerprint',
        'expected_item_revision',
        'result_item_revision',
        'created_at'
    ]
);
assert.deepEqual(
    database.prepare('PRAGMA table_info(draft_upload_sessions)').all()
        .map(column => column.name),
    [
        'upload_session_id',
        'draft_id',
        'item_revision',
        'consent_revision',
        'export_bundle_id',
        'source_revision',
        'suppression_revision',
        'provider_upload_id',
        'object_key',
        'file_extension',
        'declared_content_type',
        'declared_byte_count',
        'part_size',
        'part_count',
        'next_part_number',
        'uploaded_byte_count',
        'detected_format',
        'status',
        'completed_object_version',
        'completed_etag',
        'completed_sha256',
        'failure_code',
        'synthetic_only_confirmed',
        'verified_owner_identity_hash',
        'initiation_idempotency_key',
        'initiation_payload_fingerprint',
        'completion_idempotency_key',
        'completion_payload_fingerprint',
        'completion_started_at',
        'created_at',
        'updated_at',
        'expires_at',
        'completed_at',
        'object_deleted_at'
    ]
);

// A draft is created in exactly one upload area and can never be moved into
// another area afterward. The older dual-mode representation remains invalid.
const familyAreaDraftId = 'draft_family_area_boundary_00001';
insertMigrationDraft(database, familyAreaDraftId, {
    siteModesJson: '["family"]'
});
const everyoneAreaDraftId = 'draft_everyone_area_boundary_001';
insertMigrationDraft(database, everyoneAreaDraftId, {
    siteModesJson: '["everyone"]'
});
assert.equal(
    database.prepare('SELECT site_modes_json FROM gallery_drafts WHERE draft_id = ?')
        .get(everyoneAreaDraftId).site_modes_json,
    '["everyone"]'
);
assert.throws(
    () => insertMigrationDraft(database, 'draft_shared_area_boundary_0001', {
        siteModesJson: '["family","everyone"]'
    }),
    /must belong to exactly one site mode/i
);
assert.throws(
    () => database.prepare(
        'UPDATE gallery_drafts SET site_modes_json = ?, item_revision = ?, updated_at = ? ' +
        'WHERE draft_id = ?'
    ).run(
        '["family","everyone"]',
        'draft-everyone-area-item-v2',
        '2026-08-26T12:05:00.000Z',
        everyoneAreaDraftId
    ),
    /must belong to exactly one site mode|site mode is immutable/i
);
assert.throws(
    () => database.prepare(
        'UPDATE gallery_drafts SET site_modes_json = ?, item_revision = ?, updated_at = ? ' +
        'WHERE draft_id = ?'
    ).run(
        '["everyone"]',
        'draft-family-area-item-v2',
        '2026-08-26T12:06:00.000Z',
        familyAreaDraftId
    ),
    /site mode is immutable after creation/i
);
assert.throws(
    () => database.prepare(
        'UPDATE gallery_drafts SET site_modes_json = ?, item_revision = ?, updated_at = ? ' +
        'WHERE draft_id = ?'
    ).run(
        '["family"]',
        'draft-everyone-area-item-v2',
        '2026-08-26T12:07:00.000Z',
        everyoneAreaDraftId
    ),
    /site mode is immutable after creation/i
);

// The database itself enforces the private-upload sequence. These checks do
// not trust the Worker to remember synthetic-only mode, part ordering, or the
// append-only nature of receipts.
const phaseCDraftId = 'draft_phase_c_boundary_001';
const phaseCObjectKey = `private-originals/phase-c/${'a'.repeat(48)}`;
const phaseCSessionId = 'phase_c_upload_session_001';
insertMigrationDraft(database, phaseCDraftId);
insertMigrationConsent(database, phaseCDraftId, 'consent-v1');
activateMigrationConsent(database, phaseCDraftId, 'consent-v1');
database.prepare(
    'UPDATE gallery_drafts SET state = ?, state_version = ?, original_object_key = ?, updated_at = ? ' +
    'WHERE draft_id = ?'
).run('uploading', 1, phaseCObjectKey, '2026-08-26T12:10:00.000Z', phaseCDraftId);
const phaseCDraft = database.prepare(
    'SELECT item_revision, export_bundle_id, source_revision, suppression_revision ' +
    'FROM gallery_drafts WHERE draft_id = ?'
).get(phaseCDraftId);
const insertUploadSession = syntheticOnlyConfirmed => database.prepare(
    'INSERT INTO draft_upload_sessions (' +
    'upload_session_id, draft_id, item_revision, consent_revision, export_bundle_id, ' +
    'source_revision, suppression_revision, provider_upload_id, object_key, file_extension, ' +
    'declared_content_type, declared_byte_count, part_size, part_count, next_part_number, ' +
    'uploaded_byte_count, status, synthetic_only_confirmed, verified_owner_identity_hash, ' +
    'initiation_idempotency_key, initiation_payload_fingerprint, created_at, updated_at, expires_at' +
    ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
).run(
    phaseCSessionId,
    phaseCDraftId,
    phaseCDraft.item_revision,
    'consent-v1',
    phaseCDraft.export_bundle_id,
    phaseCDraft.source_revision,
    phaseCDraft.suppression_revision,
    'synthetic-provider-upload-id',
    phaseCObjectKey,
    'jpg',
    'image/jpeg',
    5242880,
    5242880,
    1,
    1,
    0,
    'active',
    syntheticOnlyConfirmed,
    identityHash,
    'phase-c-init-key-0001',
    'e'.repeat(64),
    '2026-08-26T12:10:00.000Z',
    '2026-08-26T12:10:00.000Z',
    '2026-08-27T12:10:00.000Z'
);
assert.throws(() => insertUploadSession(0), /CHECK constraint failed/i);
insertUploadSession(1);
assert.throws(() => insertUploadSession(1), /replacement is forbidden/i);
assert.throws(
    () => database.prepare(
        'UPDATE draft_upload_sessions SET object_key = ? WHERE upload_session_id = ?'
    ).run(`${phaseCObjectKey}-changed`, phaseCSessionId),
    /private upload session identity is immutable/i
);
assert.throws(
    () => database.prepare(
        'INSERT INTO draft_upload_parts (' +
        'upload_session_id, part_number, provider_etag, byte_count, sha256, uploaded_at' +
        ') VALUES (?, ?, ?, ?, ?, ?)'
    ).run(phaseCSessionId, 1, 'synthetic-etag', 4, 'f'.repeat(64), timestamp),
    /out of sequence or the wrong size/i
);
database.prepare(
    'INSERT INTO draft_upload_parts (' +
    'upload_session_id, part_number, provider_etag, byte_count, sha256, uploaded_at' +
    ') VALUES (?, ?, ?, ?, ?, ?)'
).run(phaseCSessionId, 1, 'synthetic-etag', 5242880, 'f'.repeat(64), timestamp);
assert.throws(
    () => database.prepare(
        'INSERT OR REPLACE INTO draft_upload_parts (' +
        'upload_session_id, part_number, provider_etag, byte_count, sha256, uploaded_at' +
        ') VALUES (?, ?, ?, ?, ?, ?)'
    ).run(phaseCSessionId, 1, 'changed-etag', 5242880, 'a'.repeat(64), timestamp),
    /replacement is forbidden/i
);
assert.throws(
    () => database.prepare(
        'DELETE FROM draft_upload_parts WHERE upload_session_id = ? AND part_number = ?'
    ).run(phaseCSessionId, 1),
    /direct deletion is forbidden/i
);
assert.throws(
    () => database.prepare(
        'INSERT INTO draft_mutation_receipts (' +
        'draft_id, idempotency_key, mutation_kind, payload_fingerprint, ' +
        'expected_item_revision, result_item_revision, created_at' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
        phaseCDraftId,
        'phase-c-edit-key-0001',
        'edit-details',
        'a'.repeat(64),
        phaseCDraft.item_revision,
        'stale-item-revision',
        timestamp
    ),
    /does not match the committed item revision/i
);
database.prepare(
    'INSERT INTO draft_mutation_receipts (' +
    'draft_id, idempotency_key, mutation_kind, payload_fingerprint, ' +
    'expected_item_revision, result_item_revision, created_at' +
    ') VALUES (?, ?, ?, ?, ?, ?, ?)'
).run(
    phaseCDraftId,
    'phase-c-edit-key-0001',
    'edit-details',
    'a'.repeat(64),
    phaseCDraft.item_revision,
    phaseCDraft.item_revision,
    timestamp
);
assert.throws(
    () => database.prepare(
        'UPDATE draft_mutation_receipts SET payload_fingerprint = ? ' +
        'WHERE draft_id = ? AND idempotency_key = ?'
    ).run('b'.repeat(64), phaseCDraftId, 'phase-c-edit-key-0001'),
    /append-only/i
);
database.close();

console.log('Gallery admin and derivative-delivery boundary tests passed.');

async function adminRequest(path, {
    method = 'GET',
    identity = null,
    headers = {},
    body,
    now = fixedNow,
    env = adminEnv
} = {}) {
    const requestHeaders = new Headers(headers);
    if (identity) {
        requestHeaders.set('X-Synthetic-Identity', identity);
    }

    let requestBody;
    if (body !== undefined) {
        requestHeaders.set('Content-Type', 'application/json');
        requestBody = JSON.stringify(body);
    }

    return handleAdminRequest(
        new Request(`${adminOrigin}${path}`, {
            method,
            headers: requestHeaders,
            body: requestBody
        }),
        env,
        {
            verifyAccessIdentity,
            now: () => now
        }
    );
}

function createFakeD1() {
    const writes = [];
    return {
        writes,
        prepare(sql) {
            return {
                bind(...bindings) {
                    return {
                        async run() {
                            writes.push({ sql, bindings });
                            return {
                                success: true,
                                meta: { changes: 1 }
                            };
                        }
                    };
                }
            };
        }
    };
}

function createApprovedBucket(objects, metadataSentinel, behavior = {}) {
    const calls = [];
    const bucket = {
        calls,
        async head(key) {
            calls.push({ operation: 'head', key });
            const object = objects.get(key);
            return object ? objectMetadata(object, metadataSentinel, {
                size: behavior.headSize,
                httpEtag: behavior.headEtag,
                etag: behavior.headRawEtag
            }) : null;
        },
        async get(key, options = {}) {
            calls.push({
                operation: 'get',
                key,
                range: options.range,
                onlyIf: options.onlyIf
            });
            const object = objects.get(key);
            if (!object) {
                return null;
            }

            const range = options.range;
            const body = range
                ? object.slice(range.offset, range.offset + range.length)
                : object;
            const returnedRange = Object.hasOwn(behavior, 'returnedRange')
                ? behavior.returnedRange
                : range ? { ...range } : undefined;
            return {
                ...objectMetadata(object, metadataSentinel, {
                    size: behavior.getSize,
                    httpEtag: behavior.getEtag,
                    etag: behavior.getRawEtag
                }),
                body: behavior.body || body,
                range: returnedRange,
                writeHttpMetadata(headers) {
                    headers.set('Content-Type', 'text/html');
                    headers.set('X-Private-Metadata', metadataSentinel);
                }
            };
        }
    };

    for (const forbiddenMethod of ['list', 'put', 'delete', 'createMultipartUpload']) {
        Object.defineProperty(bucket, forbiddenMethod, {
            get() {
                throw new Error(`Delivery attempted forbidden R2 operation ${forbiddenMethod}.`);
            }
        });
    }

    return bucket;
}

function objectMetadata(object, metadataSentinel, overrides = {}) {
    return {
        size: overrides.size ?? object.byteLength,
        etag: overrides.etag ?? 'synthetic-etag',
        httpEtag: overrides.httpEtag ?? '"synthetic-etag"',
        httpMetadata: {
            contentType: 'text/html',
            cacheControl: 'public, max-age=31536000',
            contentDisposition: `attachment; filename="${metadataSentinel}.html"`
        },
        customMetadata: {
            privateValue: metadataSentinel
        }
    };
}

function createDeliveryEnv(approvedMedia) {
    const env = { APPROVED_MEDIA: approvedMedia };
    for (const forbiddenBinding of [
        'ORIGINALS',
        'ORIGINAL_MEDIA',
        'STAGING',
        'DERIVATIVE_STAGING',
        'DB'
    ]) {
        Object.defineProperty(env, forbiddenBinding, {
            get() {
                throw new Error(`Delivery attempted forbidden binding ${forbiddenBinding}.`);
            }
        });
    }
    return env;
}

function bytes(value) {
    return new TextEncoder().encode(value);
}

function deleteHeaderCaseInsensitively(headers, target) {
    const actual = Object.keys(headers).find(name => name.toLowerCase() === target.toLowerCase());
    if (actual) {
        delete headers[actual];
    }
}

function insertMigrationDraft(database, draftId, overrides = {}, replace = false) {
    const values = {
        publicItemId: `${draftId}-item`,
        state: 'draft',
        stateVersion: 0,
        siteModesJson: '["family"]',
        exportBundleId: `${draftId}-bundle-v1`,
        sourceRevision: `${draftId}-source-v1`,
        suppressionRevision: `${draftId}-suppression-v1`,
        itemRevision: `${draftId}-item-v1`,
        activeConsentRevision: null,
        mediaType: 'photo',
        athleteIdsJson: '[]',
        originalObjectKey: null,
        ...overrides
    };
    const verb = replace ? 'INSERT OR REPLACE' : 'INSERT';
    database.prepare(
        `${verb} INTO gallery_drafts (` +
        'draft_id, public_item_id, state, state_version, site_modes_json, ' +
        'export_bundle_id, source_revision, suppression_revision, item_revision, ' +
        'active_consent_revision, media_type, race_date, race_event, race_distance, ' +
        'athlete_ids_json, title, caption, alt_text, featured, original_object_key, ' +
        'verified_owner_identity_hash, created_at, updated_at' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
        draftId,
        values.publicItemId,
        values.state,
        values.stateVersion,
        values.siteModesJson,
        values.exportBundleId,
        values.sourceRevision,
        values.suppressionRevision,
        values.itemRevision,
        values.activeConsentRevision,
        values.mediaType,
        '2026-08-26',
        'Synthetic 5 km',
        '5 km',
        values.athleteIdsJson,
        'Synthetic title',
        'Synthetic caption',
        'Synthetic alternative text',
        0,
        values.originalObjectKey,
        '1'.repeat(64),
        '2026-08-26T12:00:00.000Z',
        '2026-08-26T12:00:00.000Z'
    );
}

function insertMigrationConsent(database, draftId, consentRevision, overrides = {}) {
    const values = {
        publicUseConfirmed: 1,
        containsMinors: 0,
        guardianApprovalConfirmed: 0,
        withdrawnAt: null,
        ...overrides
    };
    database.prepare(
        'INSERT INTO draft_consent_attestations (' +
        'draft_id, consent_revision, public_use_confirmed, contains_minors, ' +
        'guardian_approval_confirmed, private_evidence_reference, ' +
        'verified_owner_identity_hash, attested_at, withdrawn_at' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
        draftId,
        consentRevision,
        values.publicUseConfirmed,
        values.containsMinors,
        values.guardianApprovalConfirmed,
        'synthetic-private-evidence',
        '1'.repeat(64),
        '2026-08-26T12:00:00.000Z',
        values.withdrawnAt
    );
}

function activateMigrationConsent(database, draftId, consentRevision) {
    database.prepare(
        'UPDATE gallery_drafts SET active_consent_revision = ?, updated_at = ? ' +
        'WHERE draft_id = ?'
    ).run(consentRevision, '2026-08-26T12:01:00.000Z', draftId);
}

function insertMigrationDerivative(database, draftId, role, overrides = {}, replace = false) {
    const draft = database.prepare(
        'SELECT item_revision, active_consent_revision, export_bundle_id, ' +
        'source_revision, suppression_revision FROM gallery_drafts WHERE draft_id = ?'
    ).get(draftId);
    const values = {
        itemRevision: draft.item_revision,
        consentRevision: draft.active_consent_revision,
        exportBundleId: draft.export_bundle_id,
        sourceRevision: draft.source_revision,
        suppressionRevision: draft.suppression_revision,
        stagingObjectKey: null,
        approvedObjectKey: `${draftId}/${role}/approved`,
        ...overrides
    };
    const verb = replace ? 'INSERT OR REPLACE' : 'INSERT';
    database.prepare(
        `${verb} INTO draft_derivatives (` +
        'draft_id, item_revision, consent_revision, export_bundle_id, source_revision, ' +
        'suppression_revision, role, staging_object_key, approved_object_key, ' +
        'byte_count, sha256, content_type, width, height, duration_milliseconds, ' +
        'metadata_scan_json, scanner_version, verified_at' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
        draftId,
        values.itemRevision,
        values.consentRevision,
        values.exportBundleId,
        values.sourceRevision,
        values.suppressionRevision,
        role,
        values.stagingObjectKey,
        values.approvedObjectKey,
        10,
        '5'.repeat(64),
        role === 'video' ? 'video/mp4' : 'image/webp',
        100,
        100,
        role === 'video' ? 1000 : null,
        '{}',
        'synthetic-scanner-v1',
        '2026-08-26T12:02:00.000Z'
    );
}

function advanceMigrationDraft(database, draftId, nextState) {
    const current = database.prepare(
        'SELECT state_version FROM gallery_drafts WHERE draft_id = ?'
    ).get(draftId);
    database.prepare(
        'UPDATE gallery_drafts SET state = ?, state_version = ?, updated_at = ? ' +
        'WHERE draft_id = ?'
    ).run(
        nextState,
        current.state_version + 1,
        '2026-08-26T12:03:00.000Z',
        draftId
    );
}

function insertMigrationPublication(database, draftId, overrides = {}) {
    const values = {
        hostDeletionConfirmed: 0,
        privateOriginalDeletionConfirmed: 0,
        withdrawalKind: null,
        ...overrides
    };
    database.prepare(
        'INSERT INTO draft_publication_references (' +
        'draft_id, host_deletion_confirmed, private_original_deletion_confirmed, ' +
        'withdrawal_kind, updated_at' +
        ') VALUES (?, ?, ?, ?, ?)'
    ).run(
        draftId,
        values.hostDeletionConfirmed,
        values.privateOriginalDeletionConfirmed,
        values.withdrawalKind,
        '2026-08-26T12:04:00.000Z'
    );
}

function insertPendingExclusion(database, athleteId) {
    database.prepare(
        'INSERT INTO pending_athlete_exclusions (' +
        'athlete_id, exclusion_revision, expected_suppression_revision, ' +
        'request_audit_hash, actor_identity_hash, created_at, updated_at' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
        athleteId,
        'exclusion-v1',
        'suppression-v1',
        '6'.repeat(64),
        '1'.repeat(64),
        '2026-08-26T12:05:00.000Z',
        '2026-08-26T12:05:00.000Z'
    );
}

function migrationRowsSnapshot(database, sql, ...bindings) {
    return JSON.stringify(database.prepare(sql).all(...bindings));
}

function assertMigrationReplacementForbidden(database, sql, bindings, operation) {
    const before = migrationRowsSnapshot(database, sql, ...bindings);
    assert.throws(operation, /replacement is forbidden/i);
    assert.equal(migrationRowsSnapshot(database, sql, ...bindings), before);
}

function migrationPrivateEvidenceSnapshot(database) {
    return [
        'gallery_drafts',
        'draft_consent_attestations',
        'draft_derivatives',
        'draft_publication_references',
        'draft_transition_receipts'
    ].map(table => migrationRowsSnapshot(
        database,
        `SELECT * FROM ${table} ORDER BY rowid`
    )).join('\n');
}

function stripJsonComments(source) {
    let result = '';
    let inString = false;
    let escaped = false;

    for (let index = 0; index < source.length; index += 1) {
        const character = source[index];
        const next = source[index + 1];

        if (inString) {
            result += character;
            if (escaped) {
                escaped = false;
            } else if (character === '\\') {
                escaped = true;
            } else if (character === '"') {
                inString = false;
            }
            continue;
        }

        if (character === '"') {
            inString = true;
            result += character;
            continue;
        }
        if (character === '/' && next === '/') {
            index += 2;
            while (index < source.length && !['\r', '\n'].includes(source[index])) {
                index += 1;
            }
            result += source[index] || '';
            continue;
        }
        if (character === '/' && next === '*') {
            index += 2;
            while (
                index < source.length - 1 &&
                !(source[index] === '*' && source[index + 1] === '/')
            ) {
                if (['\r', '\n'].includes(source[index])) {
                    result += source[index];
                }
                index += 1;
            }
            index += 1;
            continue;
        }
        result += character;
    }
    return result;
}

function createAccessAssertion(payload) {
    const header = Buffer.from(JSON.stringify({
        alg: 'RS256',
        typ: 'JWT'
    })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = Buffer.from('synthetic-signature').toString('base64url');
    return `${header}.${body}.${signature}`;
}

async function assertResponseOmits(response, values) {
    const snapshot = `${JSON.stringify([...response.headers])}\n${await response.text()}`;
    for (const value of values) {
        assert.equal(snapshot.includes(value), false, `Response leaked private value: ${value}`);
    }
}
