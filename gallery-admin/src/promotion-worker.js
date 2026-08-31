import { verifyWorkerAccessIdentity } from './access.js';
import { cleanupPhotoPromotion } from './promotion-cleanup-service.js';
import { promotePhotoDraft } from './promotion-service.js';
import { adminFailure, adminJson } from './responses.js';

const DRAFT_ID_FRAGMENT = '(draft_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})';
const PROMOTION_PATH_PATTERN = new RegExp(
    `^/api/service/drafts/${DRAFT_ID_FRAGMENT}/photo-promotions$`
);
const PROMOTION_ID_FRAGMENT = '(promotion_[a-f0-9]{32})';
const CLEANUP_PATH_PATTERN = new RegExp(
    `^/api/service/photo-promotions/${PROMOTION_ID_FRAGMENT}/cleanup$`
);
const PROMOTER_IDENTITY_PATTERN = /^subject:([0-9a-f]{32}\.access)$/;
const JSON_BODY_LIMIT = 32 * 1024;
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
    if (request.method !== 'POST') {
        return adminFailure(405, { Allow: 'POST' });
    }

    const parsed = await readBoundedJson(request);
    if (!parsed.ok) {
        return adminFailure(parsed.status);
    }

    const promotionOperation = route.kind === 'cleanup'
        ? dependencies.cleanupPhotoPromotion || cleanupPhotoPromotion
        : dependencies.promotePhotoDraft || promotePhotoDraft;
    try {
        const result = route.kind === 'cleanup'
            ? await promotionOperation(
                env,
                identity,
                route.promotionId,
                parsed.value,
                readNow(dependencies.now)
            )
            : await promotionOperation(
                env,
                identity,
                route.draftId,
                parsed.value,
                env.APPROVED_MEDIA_ORIGIN,
                readNow(dependencies.now)
            );
        return promotionResultResponse(result, route);
    } catch {
        return adminFailure(503);
    }
}

function matchRoute(pathname) {
    let match = PROMOTION_PATH_PATTERN.exec(pathname);
    if (match) return { kind: 'promote', draftId: match[1] };
    match = CLEANUP_PATH_PATTERN.exec(pathname);
    return match ? { kind: 'cleanup', promotionId: match[1] } : null;
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

async function readBoundedJson(request) {
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
    const chunks = [];
    let length = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            length += value.byteLength;
            if (length > JSON_BODY_LIMIT) {
                await reader.cancel();
                return { ok: false, status: 413 };
            }
            chunks.push(value);
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
        return { ok: false, status: 400 };
    } finally {
        reader.releaseLock();
    }
}

function promotionResultResponse(result, route) {
    if (!result || typeof result !== 'object' || !Number.isInteger(result.status)) {
        return adminFailure(503);
    }
    if (result.ok === true && [200, 201].includes(result.status)) {
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
        'service-unavailable',
        'staging-object-conflict'
    ]);
    return adminJson(status, {
        error: allowedCodes.has(result.code) ? result.code : 'service-unavailable'
    });
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
