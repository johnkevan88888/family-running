import { verifyWorkerAccessIdentity } from './access.js';
import {
    MEDIA_BINDING_WITNESS_CONTENT_TYPE,
    MEDIA_BINDING_WITNESS_KEY,
    MEDIA_BINDING_WITNESS_SHA256,
    MEDIA_BINDING_WITNESS_SIZE,
    MEDIA_DELIVERY_CONTRACT_VALUE
} from './media-delivery-contract.js';
import { verifyPublicHostAbsence } from './public-host-verifier-service.js';
import { adminFailure, adminJson } from './responses.js';

const DRAFT_ID_FRAGMENT = '(draft_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})';
const VERIFICATION_PATH_PATTERN = new RegExp(
    `^/api/service/drafts/${DRAFT_ID_FRAGMENT}/public-host-absence-verifications$`
);
const SERVICE_IDENTITY_PATTERN = /^subject:([0-9a-f]{32}\.access)$/i;
const MEDIA_VERSION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const JSON_BODY_LIMIT = 32 * 1024;
const DEFAULT_BODY_TIMEOUT_MILLISECONDS = 5_000;
const MAX_BODY_TIMEOUT_MILLISECONDS = 30_000;
const MAX_CANCEL_WAIT_MILLISECONDS = 100;
const EXACT_ENVIRONMENT_KEYS = Object.freeze([
    'APPROVED_MEDIA_ORIGIN',
    'DB',
    'EXPECTED_MEDIA_VERSION',
    'MEDIA_CONTRACT',
    'MEDIA_WITNESS_BYTE_COUNT',
    'MEDIA_WITNESS_CONTENT_TYPE',
    'MEDIA_WITNESS_KEY',
    'MEDIA_WITNESS_SHA256',
    'PUBLIC_HOST_VERIFIER_IDENTITY',
    'PUBLIC_HOST_VERIFIER_ORIGIN'
]);

export async function handlePublicHostVerifierRequest(
    request,
    env,
    dependencies = {}
) {
    const identityVerifier = dependencies.verifyAccessIdentity ||
        (() => verifyWorkerAccessIdentity(dependencies.accessContext, request));
    const identity = await verifyIdentity(identityVerifier);
    if (
        !identity ||
        !matchesVerifierIdentity(identity, env?.PUBLIC_HOST_VERIFIER_IDENTITY) ||
        !requestUsesConfiguredOrigin(request, env?.PUBLIC_HOST_VERIFIER_ORIGIN) ||
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
    if (url.search !== '' || url.hash !== '') return adminFailure(404);

    const route = VERIFICATION_PATH_PATTERN.exec(url.pathname);
    if (!route) return adminFailure(404);
    if (!hasExactEnvironment(env)) return adminFailure(503);
    if (request.method !== 'POST') {
        return adminFailure(405, { Allow: 'POST' });
    }

    const parsed = await readBoundedJson(
        request,
        dependencies.bodyTimeoutMilliseconds
    );
    if (!parsed.ok) return adminFailure(parsed.status);

    const operation = dependencies.verifyPublicHostAbsence ||
        verifyPublicHostAbsence;
    try {
        const result = await operation(
            env,
            identity,
            route[1],
            parsed.value,
            readNow(dependencies.now),
            { fetch: dependencies.fetch, now: dependencies.now }
        );
        return verifierResultResponse(result);
    } catch {
        return adminJson(503, { error: 'public-host-unverifiable' });
    }
}

async function verifyIdentity(verifier) {
    try {
        const identity = await verifier();
        return identity?.type === 'service' &&
            typeof identity.subject === 'string' &&
            /^[0-9a-f]{32}\.access$/i.test(identity.subject)
            ? identity
            : null;
    } catch {
        return null;
    }
}

function matchesVerifierIdentity(identity, configuredIdentity) {
    if (
        typeof configuredIdentity !== 'string' ||
        configuredIdentity.trim() !== configuredIdentity
    ) return false;
    const match = SERVICE_IDENTITY_PATTERN.exec(configuredIdentity);
    return Boolean(match) && identity.subject === match[1];
}

function requestUsesConfiguredOrigin(request, configuredOrigin) {
    const expected = normalizeOrigin(configuredOrigin);
    if (!expected) return false;
    try {
        return new URL(request.url).origin === expected;
    } catch {
        return false;
    }
}

function requestUsesOnlyAccessAssertionCookie(request) {
    const cookie = request.headers.get('Cookie');
    if (cookie === null) return true;
    const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
    return typeof assertion === 'string' &&
        assertion.length > 0 &&
        cookie === `CF_Authorization=${assertion}`;
}

function hasExactEnvironment(env) {
    if (
        !env ||
        Object.keys(env).length !== EXACT_ENVIRONMENT_KEYS.length ||
        !Object.keys(env).every(key => EXACT_ENVIRONMENT_KEYS.includes(key)) ||
        !env.DB ||
        typeof env.DB.prepare !== 'function' ||
        typeof env.DB.batch !== 'function' ||
        normalizeOrigin(env.PUBLIC_HOST_VERIFIER_ORIGIN) === null ||
        normalizeOrigin(env.APPROVED_MEDIA_ORIGIN) === null ||
        !MEDIA_VERSION_PATTERN.test(env.EXPECTED_MEDIA_VERSION || '') ||
        env.MEDIA_CONTRACT !== MEDIA_DELIVERY_CONTRACT_VALUE ||
        env.MEDIA_WITNESS_KEY !== MEDIA_BINDING_WITNESS_KEY ||
        env.MEDIA_WITNESS_SHA256 !== MEDIA_BINDING_WITNESS_SHA256 ||
        String(env.MEDIA_WITNESS_BYTE_COUNT) !==
            String(MEDIA_BINDING_WITNESS_SIZE) ||
        env.MEDIA_WITNESS_CONTENT_TYPE !==
            MEDIA_BINDING_WITNESS_CONTENT_TYPE ||
        !SERVICE_IDENTITY_PATTERN.test(env.PUBLIC_HOST_VERIFIER_IDENTITY || '')
    ) return false;
    return env.PUBLIC_HOST_VERIFIER_ORIGIN !== env.APPROVED_MEDIA_ORIGIN;
}

function normalizeOrigin(value) {
    if (typeof value !== 'string' || value.trim() !== value) return null;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' &&
            url.origin === value &&
            url.username === '' &&
            url.password === '' &&
            url.port === '' &&
            url.pathname === '/' &&
            url.search === '' &&
            url.hash === ''
            ? url.origin
            : null;
    } catch {
        return null;
    }
}

async function readBoundedJson(request, requestedTimeoutMilliseconds) {
    if (
        request.headers.get('Content-Type') !== 'application/json' ||
        request.headers.has('Content-Encoding') ||
        request.headers.has('Transfer-Encoding') ||
        request.body === null
    ) return { ok: false, status: 400 };

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
            if (done) break;
            length += value.byteLength;
            if (length > JSON_BODY_LIMIT) {
                await cancelBeforeDeadline(reader, deadline);
                return { ok: false, status: 413 };
            }
            chunks.push(value);
        }
        if (Date.now() >= deadline) return { ok: false, status: 400 };
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

function verifierResultResponse(result) {
    if (!result || typeof result !== 'object' || !Number.isInteger(result.status)) {
        return adminJson(503, { error: 'public-host-unverifiable' });
    }
    if (result.ok === true && [200, 201].includes(result.status)) {
        if (
            typeof result.verificationId !== 'string' ||
            !/^hostverify_[a-f0-9]{32}$/.test(result.verificationId) ||
            result.hostDeletionConfirmed !== true ||
            typeof result.replayed !== 'boolean'
        ) return adminJson(503, { error: 'public-host-unverifiable' });
        return adminJson(result.status, {
            verificationId: result.verificationId,
            hostDeletionConfirmed: true,
            replayed: result.replayed
        });
    }

    const allowed = new Map([
        ['invalid-request', 400],
        ['not-found', 404],
        ['public-host-object-present', 409],
        ['state-or-generation-drift', 409],
        ['public-host-unverifiable', 503]
    ]);
    const expectedStatus = allowed.get(result.code);
    return expectedStatus === result.status
        ? adminJson(result.status, { error: result.code })
        : adminJson(503, { error: 'public-host-unverifiable' });
}

function readNow(provider) {
    const value = typeof provider === 'function' ? provider() : Date.now();
    return Number.isFinite(value) ? value : Date.now();
}

export default {
    fetch(request, env, context) {
        return handlePublicHostVerifierRequest(request, env, {
            accessContext: context?.access
        });
    }
};
