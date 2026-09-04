import { verifyWorkerAccessIdentity } from './access.js';
import { finalizeGalleryWithdrawal } from './withdrawal-finalizer-service.js';
import { adminFailure, adminJson } from './responses.js';

const DRAFT_ID_FRAGMENT =
    '(draft_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})';
const FINALIZATION_PATH_PATTERN = new RegExp(
    `^/api/service/drafts/${DRAFT_ID_FRAGMENT}/withdrawal-finalizations$`
);
const SERVICE_IDENTITY_PATTERN = /^subject:([0-9a-f]{32}\.access)$/i;
const JSON_BODY_LIMIT = 32 * 1024;
const DEFAULT_BODY_TIMEOUT_MILLISECONDS = 5_000;
const MAX_BODY_TIMEOUT_MILLISECONDS = 30_000;
const MAX_CANCEL_WAIT_MILLISECONDS = 100;
const EXACT_ENVIRONMENT_KEYS = Object.freeze([
    'DB',
    'FINALIZER_IDENTITY',
    'FINALIZER_ORIGIN',
    'PRIVATE_ORIGINALS'
]);

export async function handleWithdrawalFinalizerRequest(
    request,
    env,
    dependencies = {}
) {
    const identityVerifier = dependencies.verifyAccessIdentity ||
        (() => verifyWorkerAccessIdentity(dependencies.accessContext, request));
    const identity = await verifyIdentity(identityVerifier);
    if (
        !identity ||
        !matchesFinalizerIdentity(identity, env?.FINALIZER_IDENTITY) ||
        !requestUsesConfiguredOrigin(request, env?.FINALIZER_ORIGIN) ||
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

    const route = FINALIZATION_PATH_PATTERN.exec(url.pathname);
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

    const operation = dependencies.finalizeGalleryWithdrawal ||
        finalizeGalleryWithdrawal;
    try {
        const result = await operation(
            env,
            identity,
            route[1],
            parsed.value
        );
        return finalizerResultResponse(result);
    } catch {
        return adminJson(503, { error: 'finalization-unavailable' });
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

function matchesFinalizerIdentity(identity, configuredIdentity) {
    if (
        typeof configuredIdentity !== 'string' ||
        configuredIdentity.trim() !== configuredIdentity
    ) return false;
    const match = SERVICE_IDENTITY_PATTERN.exec(configuredIdentity);
    return Boolean(match) && identity.subject.toLowerCase() === match[1].toLowerCase();
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
    return Boolean(
        env &&
        Object.keys(env).length === EXACT_ENVIRONMENT_KEYS.length &&
        Object.keys(env).every(key => EXACT_ENVIRONMENT_KEYS.includes(key)) &&
        env.DB &&
        typeof env.DB.prepare === 'function' &&
        typeof env.DB.batch === 'function' &&
        env.PRIVATE_ORIGINALS &&
        typeof env.PRIVATE_ORIGINALS.head === 'function' &&
        typeof env.PRIVATE_ORIGINALS.get === 'function' &&
        typeof env.PRIVATE_ORIGINALS.delete === 'function' &&
        typeof env.PRIVATE_ORIGINALS.list === 'function' &&
        normalizeOrigin(env.FINALIZER_ORIGIN) !== null &&
        SERVICE_IDENTITY_PATTERN.test(env.FINALIZER_IDENTITY || '')
    );
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
        if (Date.now() >= deadline || length !== Number(declaredLength)) {
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
            // A failed bounded read cannot reach the destructive service.
        }
    }
}

function normalizeBodyTimeout(value) {
    return Number.isSafeInteger(value) &&
        value >= 1 && value <= MAX_BODY_TIMEOUT_MILLISECONDS
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

function finalizerResultResponse(result) {
    if (!result || typeof result !== 'object' || !Number.isInteger(result.status)) {
        return adminJson(503, { error: 'finalization-unavailable' });
    }
    if (result.ok === true) {
        if (
            result.code === 'host-verification-required' &&
            result.status === 202 &&
            result.replayed === false &&
            Number.isSafeInteger(result.expectedStateVersion) &&
            result.expectedStateVersion >= 0 &&
            /^[A-Za-z0-9_-]{16,128}$/.test(result.verifierIdempotencyKey || '')
        ) {
            return adminJson(202, {
                status: result.code,
                expectedStateVersion: result.expectedStateVersion,
                verifierIdempotencyKey: result.verifierIdempotencyKey,
                replayed: false
            });
        }
        if (
            result.code === 'withdrawn' &&
            [200, 201].includes(result.status) &&
            typeof result.replayed === 'boolean'
        ) {
            return adminJson(result.status, {
                status: 'withdrawn',
                replayed: result.replayed
            });
        }
        if (
            result.code === 'retention-pending' &&
            result.status === 202 &&
            typeof result.replayed === 'boolean' &&
            canonicalTimestamp(result.eligibleAt)
        ) {
            return adminJson(202, {
                status: 'retention-pending',
                eligibleAt: result.eligibleAt,
                replayed: result.replayed
            });
        }
        if (
            result.code === 'purged' &&
            [200, 201].includes(result.status) &&
            typeof result.replayed === 'boolean'
        ) {
            return adminJson(result.status, {
                status: 'purged',
                replayed: result.replayed
            });
        }
        return adminJson(503, { error: 'finalization-unavailable' });
    }

    if (result.ok !== false) {
        return adminJson(503, { error: 'finalization-unavailable' });
    }

    const allowed = new Map([
        ['invalid-request', 400],
        ['not-found', 404],
        ['conflict', 409],
        ['finalization-unavailable', 503]
    ]);
    const expectedStatus = allowed.get(result.code);
    return expectedStatus === result.status
        ? adminJson(result.status, { error: result.code })
        : adminJson(503, { error: 'finalization-unavailable' });
}

function canonicalTimestamp(value) {
    if (typeof value !== 'string') return false;
    const parsed = new Date(value);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

export default {
    fetch(request, env, context) {
        return handleWithdrawalFinalizerRequest(request, env, {
            accessContext: context?.access
        });
    }
};
