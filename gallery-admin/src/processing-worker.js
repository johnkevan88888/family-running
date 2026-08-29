import { verifyWorkerAccessIdentity } from './access.js';
import {
    cleanupProcessingRun,
    processingOriginalResponse,
    recordProcessingResult,
    retryProcessingRun,
    startProcessingRun,
    storeProcessingDerivative
} from './processing-service.js';
import { adminFailure, adminJson } from './responses.js';

const DRAFT_ID_FRAGMENT = '(draft_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})';
const RUN_ID_FRAGMENT = '(run_[a-f0-9]{12}4[a-f0-9]{3}[89ab][a-f0-9]{15})';
const START_PATH_PATTERN = new RegExp(
    `^/api/service/drafts/${DRAFT_ID_FRAGMENT}/processing-runs$`
);
const ORIGINAL_PATH_PATTERN = new RegExp(
    `^/api/service/processing-runs/${RUN_ID_FRAGMENT}/original$`
);
const DERIVATIVE_PATH_PATTERN = new RegExp(
    `^/api/service/processing-runs/${RUN_ID_FRAGMENT}/derivatives/(photo-display|photo-thumbnail)$`
);
const RESULT_PATH_PATTERN = new RegExp(
    `^/api/service/processing-runs/${RUN_ID_FRAGMENT}/result$`
);
const CLEANUP_PATH_PATTERN = new RegExp(
    `^/api/service/processing-runs/${RUN_ID_FRAGMENT}/cleanup$`
);
const RETRY_PATH_PATTERN = new RegExp(
    `^/api/service/processing-runs/${RUN_ID_FRAGMENT}/retry$`
);
const PROCESSOR_IDENTITY_PATTERN = /^subject:([0-9a-f]{32}\.access)$/;
const JSON_BODY_LIMIT = 32 * 1024;
export const PROCESSING_REHEARSAL_HEADER = 'X-Gallery-Rehearsal-Fault';
const EXACT_ENVIRONMENT_KEYS = Object.freeze([
    'DB',
    'PRIVATE_ORIGINALS',
    'DERIVATIVE_STAGING',
    'PROCESSOR_IDENTITIES',
    'PROCESSING_ORIGIN'
]);

export async function handleProcessingRequest(request, env, dependencies = {}) {
    const hasRehearsalHeader = request.headers.has(PROCESSING_REHEARSAL_HEADER);
    const prepareRehearsalRequest = dependencies.prepareRehearsalRequest;
    if (hasRehearsalHeader && typeof prepareRehearsalRequest !== 'function') {
        return adminFailure(403);
    }

    const identityVerifier = dependencies.verifyAccessIdentity ||
        (() => verifyWorkerAccessIdentity(dependencies.accessContext, request));
    const identity = await verifyIdentity(identityVerifier);
    if (
        !identity ||
        !matchesSingleProcessorIdentity(identity, env?.PROCESSOR_IDENTITIES) ||
        !requestUsesConfiguredOrigin(request, env?.PROCESSING_ORIGIN) ||
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
    if (!hasExactBindings(env)) {
        return adminFailure(503);
    }

    let processingServiceDependencies = {};
    if (hasRehearsalHeader) {
        let prepared;
        try {
            prepared = await prepareRehearsalRequest({
                env,
                request,
                route
            });
        } catch {
            return adminFailure(503);
        }
        if (prepared?.ok !== true) {
            return adminFailure(prepared?.status === 403 ? 403 : 503);
        }
        if (
            !rehearsalRequestMatches(request, prepared.request) ||
            !rehearsalEnvironmentMatches(env, prepared.env) ||
            typeof prepared.shouldInterruptProviderRecovery !== 'function'
        ) {
            return adminFailure(503);
        }
        request = prepared.request;
        env = prepared.env;
        processingServiceDependencies = {
            shouldInterruptProviderRecovery:
                prepared.shouldInterruptProviderRecovery
        };
    }

    const now = readNow(dependencies.now);
    if (route.kind === 'start') {
        if (request.method !== 'POST') {
            return adminFailure(405, { Allow: 'POST' });
        }
        const parsed = await readBoundedJson(request);
        if (!parsed.ok) {
            return adminFailure(parsed.status);
        }
        return processingResultResponse(await startProcessingRun(
            env,
            identity,
            route.draftId,
            parsed.value,
            now
        ));
    }

    if (route.kind === 'original') {
        if (request.method !== 'GET') {
            return adminFailure(405, { Allow: 'GET' });
        }
        if (!isBodylessRead(request) || request.headers.has('Range')) {
            return adminFailure(400);
        }
        return await processingOriginalResponse(env, route.processingRunId) ||
            adminFailure(404);
    }

    if (route.kind === 'derivative') {
        if (request.method !== 'PUT') {
            return adminFailure(405, { Allow: 'PUT' });
        }
        return processingResultResponse(await storeProcessingDerivative(
            env,
            route.processingRunId,
            route.role,
            request,
            now,
            processingServiceDependencies
        ));
    }

    if (request.method !== 'POST') {
        return adminFailure(405, { Allow: 'POST' });
    }
    const parsed = await readBoundedJson(request);
    if (!parsed.ok) {
        return adminFailure(parsed.status);
    }
    return processingResultResponse(await (
        route.kind === 'cleanup'
            ? cleanupProcessingRun(
                env,
                identity,
                route.processingRunId,
                parsed.value,
                now
            )
            : route.kind === 'retry'
                ? retryProcessingRun(
                    env,
                    identity,
                    route.processingRunId,
                    parsed.value,
                    now
                )
                : recordProcessingResult(
                env,
                identity,
                route.processingRunId,
                parsed.value,
                now
            )
    ));
}

function matchRoute(pathname) {
    let match = START_PATH_PATTERN.exec(pathname);
    if (match) {
        return { kind: 'start', draftId: match[1] };
    }
    match = ORIGINAL_PATH_PATTERN.exec(pathname);
    if (match) {
        return { kind: 'original', processingRunId: match[1] };
    }
    match = DERIVATIVE_PATH_PATTERN.exec(pathname);
    if (match) {
        return {
            kind: 'derivative',
            processingRunId: match[1],
            role: match[2]
        };
    }
    match = RESULT_PATH_PATTERN.exec(pathname);
    if (match) {
        return { kind: 'result', processingRunId: match[1] };
    }
    match = RETRY_PATH_PATTERN.exec(pathname);
    if (match) {
        return { kind: 'retry', processingRunId: match[1] };
    }
    match = CLEANUP_PATH_PATTERN.exec(pathname);
    return match
        ? { kind: 'cleanup', processingRunId: match[1] }
        : null;
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

function matchesSingleProcessorIdentity(identity, configuredIdentity) {
    if (
        typeof configuredIdentity !== 'string' ||
        configuredIdentity.trim() !== configuredIdentity
    ) {
        return false;
    }
    const match = PROCESSOR_IDENTITY_PATTERN.exec(configuredIdentity);
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

function hasExactBindings(env) {
    return env &&
        Object.keys(env).every(key => EXACT_ENVIRONMENT_KEYS.includes(key)) &&
        env.DB &&
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
        typeof env.DERIVATIVE_STAGING.resumeMultipartUpload === 'function' &&
        env.APPROVED_MEDIA === undefined &&
        env.PUBLIC_MANIFESTS === undefined &&
        env.GITHUB_TOKEN === undefined &&
        env.GITHUB_REPOSITORY === undefined;
}

function rehearsalRequestMatches(original, prepared) {
    if (
        !(prepared instanceof Request) ||
        prepared.url !== original.url ||
        prepared.method !== original.method ||
        prepared.headers.has(PROCESSING_REHEARSAL_HEADER) ||
        prepared.bodyUsed ||
        (prepared.body === null) !== (original.body === null)
    ) {
        return false;
    }
    const originalHeaders = normalizedHeadersWithoutRehearsal(original.headers);
    const preparedHeaders = normalizedHeadersWithoutRehearsal(prepared.headers);
    return JSON.stringify(preparedHeaders) === JSON.stringify(originalHeaders);
}

function normalizedHeadersWithoutRehearsal(headers) {
    return [...headers.entries()]
        .filter(([name]) =>
            name.toLowerCase() !== PROCESSING_REHEARSAL_HEADER.toLowerCase()
        )
        .sort(([left], [right]) => left.localeCompare(right));
}

function rehearsalEnvironmentMatches(original, prepared) {
    return hasExactBindings(prepared) &&
        prepared !== original &&
        prepared.DB === original.DB &&
        prepared.PRIVATE_ORIGINALS === original.PRIVATE_ORIGINALS &&
        prepared.DERIVATIVE_STAGING !== original.DERIVATIVE_STAGING &&
        prepared.PROCESSOR_IDENTITIES === original.PROCESSOR_IDENTITIES &&
        prepared.PROCESSING_ORIGIN === original.PROCESSING_ORIGIN;
}

function isBodylessRead(request) {
    const contentLength = request.headers.get('Content-Length');
    return request.body === null &&
        !request.headers.has('Content-Type') &&
        !request.headers.has('Content-Encoding') &&
        !request.headers.has('Transfer-Encoding') &&
        (contentLength === null || contentLength === '0');
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
        return { ok: false, status: Number(declaredLength) > JSON_BODY_LIMIT ? 413 : 400 };
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

function processingResultResponse(result) {
    if (!result || typeof result !== 'object' || !Number.isInteger(result.status)) {
        return adminFailure(503);
    }
    if (result.ok === true) {
        const body = {};
        for (const [key, value] of Object.entries(result)) {
            if (key !== 'ok' && key !== 'status') {
                body[key === 'processingStatus' ? 'status' : key] = value;
            }
        }
        return adminJson(result.status, body);
    }
    const allowedStatuses = new Set([400, 404, 409, 413, 422, 503]);
    const status = allowedStatuses.has(result.status) ? result.status : 503;
    const allowedCodes = new Set([
        'conflict',
        'derivative-rejected',
        'invalid-request',
        'not-found',
        'processing-not-eligible',
        'service-unavailable'
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
        return handleProcessingRequest(request, env, {
            accessContext: context?.access
        });
    }
};
