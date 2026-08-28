import catalogSnapshot from '../generated/catalog-snapshot.js';

import { verifyWorkerAccessIdentity } from './access.js';
import {
    adminClientScript,
    adminShellDocument,
    adminStylesheet
} from './admin-assets.js';
import {
    createDraft,
    getDraft,
    listDrafts,
    transitionDraft,
    updateDraftDetails
} from './draft-service.js';
import {
    createBrowserSession,
    hashIdentity,
    validateBrowserSession
} from './session.js';
import {
    adminFailure,
    adminHtml,
    adminJson,
    adminScript,
    adminStyles
} from './responses.js';
import {
    beginPrivateUpload,
    cleanupExpiredPrivateUploads,
    completePrivateUpload,
    privateOriginalResponse,
    readPrivateUploadStatus,
    storePrivateUploadPart
} from './upload-service.js';

const ADMIN_SHELL_PATH = '/';
const ADMIN_STYLES_PATH = '/admin.css';
const ADMIN_SCRIPT_PATH = '/admin.js';
const BROWSER_HEALTH_PATH = '/api/browser/health';
const BROWSER_SESSION_PATH = '/api/browser/session';
const BROWSER_CATALOG_PATH = '/api/browser/catalog';
const BROWSER_DRAFTS_PATH = '/api/browser/drafts';
const SYNTHETIC_RECORDS_PATH = '/api/browser/synthetic-records';
const SERVICE_HEALTH_PATH = '/api/service/health';
const IDENTITY_VALUE_PATTERN = /^[^\u0000-\u001f\u007f]{1,512}$/;
const DRAFT_ID_FRAGMENT = '([A-Za-z0-9_-]{20,128})';
const DRAFT_PATH_PATTERN = new RegExp(`^${BROWSER_DRAFTS_PATH}/${DRAFT_ID_FRAGMENT}$`);
const UPLOAD_PATH_PATTERN = new RegExp(
    `^${BROWSER_DRAFTS_PATH}/${DRAFT_ID_FRAGMENT}/upload$`
);
const UPLOAD_PART_PATH_PATTERN = new RegExp(
    `^${BROWSER_DRAFTS_PATH}/${DRAFT_ID_FRAGMENT}/upload-parts/([1-9][0-9]{0,2})$`
);
const UPLOAD_COMPLETION_PATH_PATTERN = new RegExp(
    `^${BROWSER_DRAFTS_PATH}/${DRAFT_ID_FRAGMENT}/upload-completion$`
);
const ORIGINAL_PATH_PATTERN = new RegExp(
    `^${BROWSER_DRAFTS_PATH}/${DRAFT_ID_FRAGMENT}/original$`
);
const TRANSITIONS_PATH_PATTERN = new RegExp(
    `^${BROWSER_DRAFTS_PATH}/${DRAFT_ID_FRAGMENT}/transitions$`
);
const JSON_BODY_LIMIT = 32 * 1024;
const PHASE_B_CANARY_TEXT = 'synthetic:phase-b-auth-boundary-v1';
const SITE_QUERY_MODES = Object.freeze({
    '?site=family': 'family',
    '?site=everyone': 'everyone'
});

export async function handleAdminRequest(request, env, dependencies = {}) {
    const now = readNow(dependencies.now);
    const identityVerifier = dependencies.verifyAccessIdentity ||
        (() => verifyWorkerAccessIdentity(
            dependencies.accessContext,
            request
        ));
    const identity = await verifyIdentity(identityVerifier, request, env);

    if (!identity) {
        return adminFailure(403);
    }

    const url = new URL(request.url);
    if (url.hash) {
        return adminFailure(404);
    }
    const areaScoped = isAreaScopedBrowserPath(url.pathname);
    const siteMode = areaScoped ? SITE_QUERY_MODES[url.search] : null;
    if (
        (areaScoped && !siteMode) ||
        (!areaScoped && url.search !== '')
    ) {
        return adminFailure(404);
    }

    if (isBrowserPath(url.pathname)) {
        if (
            identity.type !== 'browser' ||
            !identityMatchesSingleOwner(identity, env?.OWNER_IDENTITIES) ||
            requestCarriesServiceCredentials(request) ||
            !requestUsesConfiguredOrigin(request, env?.ADMIN_ORIGIN)
        ) {
            return adminFailure(403);
        }
        return handleBrowserRoute(
            request,
            env,
            identity,
            url.pathname,
            siteMode,
            now,
            dependencies
        );
    }

    if (url.pathname === SERVICE_HEALTH_PATH) {
        if (
            identity.type !== 'service' ||
            !identityMatchesAllowlist(identity, env?.AUTOMATION_IDENTITIES) ||
            !requestUsesConfiguredOrigin(request, env?.ADMIN_ORIGIN)
        ) {
            return adminFailure(403);
        }
        if (request.method !== 'GET') {
            return adminFailure(405, { Allow: 'GET' });
        }
        return adminJson(200, { ok: true, scope: 'synthetic-phase-b' });
    }

    return adminFailure(404);
}

async function handleBrowserRoute(
    request,
    env,
    identity,
    pathname,
    siteMode,
    now,
    dependencies
) {
    if (pathname === ADMIN_SHELL_PATH) {
        if (request.method !== 'GET') {
            return adminFailure(405, { Allow: 'GET' });
        }
        return adminHtml(200, adminShellDocument(siteMode));
    }

    if (pathname === ADMIN_STYLES_PATH) {
        if (request.method !== 'GET') {
            return adminFailure(405, { Allow: 'GET' });
        }
        return adminStyles(200, adminStylesheet());
    }

    if (pathname === ADMIN_SCRIPT_PATH) {
        if (request.method !== 'GET') {
            return adminFailure(405, { Allow: 'GET' });
        }
        return adminScript(200, adminClientScript());
    }

    if (pathname === BROWSER_HEALTH_PATH) {
        if (request.method !== 'GET') {
            return adminFailure(405, { Allow: 'GET' });
        }
        return adminJson(200, { ok: true, scope: 'owner-browser' });
    }

    if (pathname === BROWSER_SESSION_PATH) {
        if (request.method !== 'GET') {
            return adminFailure(405, { Allow: 'GET' });
        }
        try {
            const session = await createBrowserSession(identity, env, siteMode, now);
            return adminJson(
                200,
                { csrfToken: session.csrfToken },
                { 'Set-Cookie': session.cookie }
            );
        } catch {
            return adminFailure(503);
        }
    }

    if (pathname === SYNTHETIC_RECORDS_PATH) {
        if (request.method !== 'POST') {
            return adminFailure(405, { Allow: 'POST' });
        }
        if (!await authorizePrivateRoute(
            request,
            env,
            identity,
            siteMode,
            now,
            true
        )) {
            return adminFailure(403);
        }
        return createSyntheticRecord(request, env, identity, now);
    }

    const route = matchPhaseCRoute(pathname);
    if (!route) {
        return adminFailure(404);
    }
    const mutation = !['GET', 'HEAD'].includes(request.method);
    if (!await authorizePrivateRoute(
        request,
        env,
        identity,
        siteMode,
        now,
        mutation
    )) {
        return adminFailure(403);
    }

    if (route.kind === 'catalog') {
        if (request.method !== 'GET') {
            return adminFailure(405, { Allow: 'GET' });
        }
        return adminJson(200, browserCatalog(catalogSnapshot, siteMode));
    }

    if (route.kind === 'drafts') {
        if (request.method === 'GET') {
            return serviceResultResponse(await listDrafts(env, siteMode));
        }
        if (request.method === 'POST') {
            const parsed = await readBoundedJson(request);
            if (!parsed.ok) {
                return adminFailure(parsed.status);
            }
            return serviceResultResponse(await createDraft(
                env,
                identity,
                siteMode,
                parsed.value,
                catalogSnapshot,
                now
            ));
        }
        return adminFailure(405, { Allow: 'GET, POST' });
    }

    if (route.kind === 'draft') {
        if (request.method === 'GET') {
            return serviceResultResponse(await getDraft(
                env,
                siteMode,
                route.draftId
            ));
        }
        if (request.method === 'PUT') {
            const parsed = await readBoundedJson(request);
            if (!parsed.ok) {
                return adminFailure(parsed.status);
            }
            return serviceResultResponse(await updateDraftDetails(
                env,
                identity,
                siteMode,
                route.draftId,
                parsed.value,
                catalogSnapshot,
                now
            ));
        }
        return adminFailure(405, { Allow: 'GET, PUT' });
    }

    if (route.kind === 'upload') {
        if (request.method === 'GET') {
            return serviceResultResponse(await readPrivateUploadStatus(
                env,
                identity,
                siteMode,
                route.draftId
            ));
        }
        if (request.method === 'POST') {
            const parsed = await readBoundedJson(request);
            if (!parsed.ok) {
                return adminFailure(parsed.status);
            }
            return serviceResultResponse(await beginPrivateUpload(
                env,
                identity,
                siteMode,
                route.draftId,
                parsed.value,
                catalogSnapshot,
                now,
                dependencies
            ));
        }
        return adminFailure(405, { Allow: 'GET, POST' });
    }

    if (route.kind === 'upload-part') {
        if (request.method !== 'PUT') {
            return adminFailure(405, { Allow: 'PUT' });
        }
        return serviceResultResponse(await storePrivateUploadPart(
            env,
            identity,
            siteMode,
            route.draftId,
            route.partNumber,
            request,
            now,
            dependencies
        ));
    }

    if (route.kind === 'upload-completion') {
        if (request.method !== 'POST') {
            return adminFailure(405, { Allow: 'POST' });
        }
        const parsed = await readBoundedJson(request);
        if (!parsed.ok) {
            return adminFailure(parsed.status);
        }
        return serviceResultResponse(await completePrivateUpload(
            env,
            identity,
            siteMode,
            route.draftId,
            parsed.value,
            catalogSnapshot,
            now,
            dependencies
        ));
    }

    if (route.kind === 'original') {
        if (!['GET', 'HEAD'].includes(request.method)) {
            return adminFailure(405, { Allow: 'GET, HEAD' });
        }
        const response = await privateOriginalResponse(
            env,
            identity,
            siteMode,
            route.draftId,
            request
        );
        return response || adminFailure(404);
    }

    if (route.kind === 'transitions') {
        if (request.method !== 'POST') {
            return adminFailure(405, { Allow: 'POST' });
        }
        const parsed = await readBoundedJson(request);
        if (!parsed.ok) {
            return adminFailure(parsed.status);
        }
        return serviceResultResponse(await transitionDraft(
            env,
            identity,
            siteMode,
            route.draftId,
            parsed.value,
            catalogSnapshot,
            now
        ));
    }

    return adminFailure(404);
}

async function authorizePrivateRoute(
    request,
    env,
    identity,
    siteMode,
    now,
    requireCsrf
) {
    if (requireCsrf && !isSameOriginMutation(request, env?.ADMIN_ORIGIN)) {
        return false;
    }
    return validateBrowserSession(request, identity, env, siteMode, now, {
        requireCsrf
    });
}

async function createSyntheticRecord(request, env, identity, now) {
    const contentType = request.headers.get('Content-Type');
    const declaredLength = request.headers.get('Content-Length');
    if (
        request.body !== null ||
        contentType !== null ||
        request.headers.has('Transfer-Encoding') ||
        (declaredLength !== null && declaredLength !== '0')
    ) {
        return adminFailure(400);
    }

    if (!env?.DB || typeof env.DB.prepare !== 'function') {
        return adminFailure(503);
    }

    try {
        const recordId = crypto.randomUUID();
        const actorIdentityHash = await hashIdentity(identity);
        const result = await env.DB.prepare(
            'INSERT INTO phase_b_synthetic_records ' +
            '(record_id, synthetic_text, actor_identity_hash, created_at) ' +
            'VALUES (?1, ?2, ?3, ?4)'
        ).bind(
            recordId,
            PHASE_B_CANARY_TEXT,
            actorIdentityHash,
            new Date(now).toISOString()
        ).run();

        if (result?.success === false) {
            return adminFailure(503);
        }
        return adminJson(201, { recordId });
    } catch {
        return adminFailure(503);
    }
}

function matchPhaseCRoute(pathname) {
    if (pathname === BROWSER_CATALOG_PATH) {
        return { kind: 'catalog' };
    }
    if (pathname === BROWSER_DRAFTS_PATH) {
        return { kind: 'drafts' };
    }
    return matchDraftRoute(pathname, DRAFT_PATH_PATTERN, 'draft') ||
        matchDraftRoute(pathname, UPLOAD_PATH_PATTERN, 'upload') ||
        matchUploadPartRoute(pathname) ||
        matchDraftRoute(pathname, UPLOAD_COMPLETION_PATH_PATTERN, 'upload-completion') ||
        matchDraftRoute(pathname, ORIGINAL_PATH_PATTERN, 'original') ||
        matchDraftRoute(pathname, TRANSITIONS_PATH_PATTERN, 'transitions');
}

function matchDraftRoute(pathname, pattern, kind) {
    const match = pattern.exec(pathname);
    return match ? { kind, draftId: match[1] } : null;
}

function matchUploadPartRoute(pathname) {
    const match = UPLOAD_PART_PATH_PATTERN.exec(pathname);
    if (!match) {
        return null;
    }
    const partNumber = Number(match[2]);
    return Number.isSafeInteger(partNumber)
        ? { kind: 'upload-part', draftId: match[1], partNumber }
        : null;
}

function browserCatalog(snapshot, siteMode) {
    const hiddenAthleteIds = snapshot.suppressionDocument.hiddenAthleteIds;
    const site = snapshot.sites[siteMode];
    return {
        schemaVersion: snapshot.schemaVersion,
        exportBundleId: snapshot.exportBundleId,
        sourceRevision: snapshot.sourceRevision,
        suppressionRevision: snapshot.suppressionRevision,
        blockedAthleteIds: Array.isArray(hiddenAthleteIds)
            ? [...hiddenAthleteIds]
            : [],
        sites: {
            [siteMode]: {
                races: site.catalog.races.map(race => ({ ...race })),
                roster: site.rosterEntries.map(entry => ({ ...entry })),
                results: site.resultEntries.map(entry => ({ ...entry }))
            }
        }
    };
}

async function readBoundedJson(request) {
    if (
        request.headers.get('Content-Type') !== 'application/json' ||
        request.headers.has('Content-Encoding') ||
        request.body === null
    ) {
        return { ok: false, status: 400 };
    }
    const declaredLength = request.headers.get('Content-Length');
    if (
        declaredLength !== null &&
        (!/^\d+$/.test(declaredLength) || Number(declaredLength) > JSON_BODY_LIMIT)
    ) {
        return { ok: false, status: 413 };
    }

    const chunks = [];
    let length = 0;
    const reader = request.body.getReader();
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

function serviceResultResponse(result) {
    if (!result || typeof result !== 'object' || !Number.isInteger(result.status)) {
        return adminFailure(503);
    }
    if (result.ok === true) {
        const body = {};
        for (const [key, value] of Object.entries(result)) {
            if (key !== 'ok' && key !== 'status') {
                body[key] = value;
            }
        }
        return adminJson(result.status, body);
    }

    const allowedStatuses = new Set([400, 404, 409, 413, 415, 422, 503]);
    const status = allowedStatuses.has(result.status) ? result.status : 503;
    const body = {
        error: typeof result.code === 'string'
            ? result.code
            : 'service-unavailable'
    };
    if (Array.isArray(result.details)) {
        body.problems = result.details
            .filter(detail => typeof detail === 'string')
            .slice(0, 8)
            .map(detail => detail.slice(0, 300));
    }
    return adminJson(status, body);
}

async function verifyIdentity(verifier, request, env) {
    try {
        const identity = await verifier(request, env);
        if (
            !isPlainObject(identity) ||
            !['browser', 'service'].includes(identity.type) ||
            typeof identity.subject !== 'string' ||
            !IDENTITY_VALUE_PATTERN.test(identity.subject)
        ) {
            return null;
        }
        if (
            identity.email !== undefined &&
            (
                typeof identity.email !== 'string' ||
                !IDENTITY_VALUE_PATTERN.test(identity.email) ||
                !identity.email.includes('@') ||
                /\s/.test(identity.email)
            )
        ) {
            return null;
        }
        if (
            identity.expiresAt !== undefined &&
            !Number.isFinite(identity.expiresAt)
        ) {
            return null;
        }
        return identity;
    } catch {
        return null;
    }
}

function identityMatchesAllowlist(identity, serializedAllowlist) {
    const allowlist = parseIdentityAllowlist(serializedAllowlist);
    if (!allowlist) {
        return false;
    }

    const candidates = [`subject:${identity.subject}`];
    if (typeof identity.email === 'string') {
        candidates.push(`email:${identity.email.toLowerCase()}`);
    }
    return candidates.some(candidate => allowlist.has(candidate));
}

function identityMatchesSingleOwner(identity, serializedAllowlist) {
    const allowlist = parseIdentityAllowlist(serializedAllowlist);
    if (!allowlist || allowlist.size < 1 || allowlist.size > 2) {
        return false;
    }

    const candidates = new Set([`subject:${identity.subject}`]);
    if (typeof identity.email === 'string') {
        candidates.add(`email:${identity.email.toLowerCase()}`);
    }

    if (allowlist.size === 1) {
        return candidates.has([...allowlist][0]);
    }

    const entries = [...allowlist];
    const hasOneSubject = entries.filter(entry => entry.startsWith('subject:')).length === 1;
    const hasOneEmail = entries.filter(entry => entry.startsWith('email:')).length === 1;
    return hasOneSubject &&
        hasOneEmail &&
        entries.every(entry => candidates.has(entry));
}

function parseIdentityAllowlist(value) {
    if (typeof value !== 'string' || value.length > 16_384) {
        return null;
    }
    const entries = value
        .split(/\r?\n/)
        .map(entry => entry.trim())
        .filter(Boolean);

    if (
        entries.length === 0 ||
        new Set(entries).size !== entries.length ||
        entries.some(entry => !validIdentityEntry(entry))
    ) {
        return null;
    }
    return new Set(entries);
}

function validIdentityEntry(entry) {
    if (entry.startsWith('subject:')) {
        return IDENTITY_VALUE_PATTERN.test(entry.slice('subject:'.length));
    }
    if (entry.startsWith('email:')) {
        const email = entry.slice('email:'.length);
        return email === email.toLowerCase() &&
            IDENTITY_VALUE_PATTERN.test(email) &&
            email.includes('@') &&
            !/\s/.test(email);
    }
    return false;
}

function requestUsesConfiguredOrigin(request, configuredOrigin) {
    const normalizedOrigin = normalizeConfiguredOrigin(configuredOrigin);
    if (!normalizedOrigin) {
        return false;
    }
    try {
        return new URL(request.url).origin === normalizedOrigin;
    } catch {
        return false;
    }
}

function isSameOriginMutation(request, configuredOrigin) {
    const normalizedOrigin = normalizeConfiguredOrigin(configuredOrigin);
    return normalizedOrigin !== null &&
        requestUsesConfiguredOrigin(request, normalizedOrigin) &&
        request.headers.get('Origin') === normalizedOrigin &&
        request.headers.get('Sec-Fetch-Site') === 'same-origin';
}

function requestCarriesServiceCredentials(request) {
    return request.headers.has('Cf-Access-Client-Id') ||
        request.headers.has('Cf-Access-Client-Secret');
}

function normalizeConfiguredOrigin(value) {
    if (typeof value !== 'string' || value.trim() !== value) {
        return null;
    }
    try {
        const parsed = new URL(value);
        if (
            parsed.protocol !== 'https:' ||
            parsed.origin !== value ||
            parsed.username ||
            parsed.password ||
            parsed.pathname !== '/' ||
            parsed.search ||
            parsed.hash
        ) {
            return null;
        }
        return parsed.origin;
    } catch {
        return null;
    }
}

function isBrowserPath(pathname) {
    return pathname === ADMIN_SHELL_PATH ||
        pathname === ADMIN_STYLES_PATH ||
        pathname === ADMIN_SCRIPT_PATH ||
        pathname === BROWSER_HEALTH_PATH ||
        pathname === BROWSER_SESSION_PATH ||
        pathname === SYNTHETIC_RECORDS_PATH ||
        matchPhaseCRoute(pathname) !== null;
}

function isAreaScopedBrowserPath(pathname) {
    return pathname === ADMIN_SHELL_PATH ||
        pathname === BROWSER_SESSION_PATH ||
        pathname === SYNTHETIC_RECORDS_PATH ||
        matchPhaseCRoute(pathname) !== null;
}

function readNow(nowProvider) {
    const value = typeof nowProvider === 'function' ? nowProvider() : Date.now();
    return Number.isFinite(value) ? value : Date.now();
}

function isPlainObject(value) {
    return value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype;
}

export default {
    fetch(request, env, context) {
        return handleAdminRequest(request, env, {
            accessContext: context?.access
        });
    },
    scheduled(controller, env, context) {
        const cleanup = cleanupExpiredPrivateUploads(
            env,
            controller?.scheduledTime,
            { execute: true }
        ).then(result => {
            if (result?.ok !== true) {
                throw new Error('Private upload cleanup failed.');
            }
        });
        context.waitUntil(cleanup);
    }
};
