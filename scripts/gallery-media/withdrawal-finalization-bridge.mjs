import { createHash } from 'node:crypto';

const DRAFT_ID_PATTERN =
    /^draft_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HOST_VERIFICATION_ID_PATTERN = /^hostverify_[a-f0-9]{32}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const ISO_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SERVICE_REQUEST_TIMEOUT_MILLISECONDS = 30_000;
const MAX_UNIQUE_VERIFICATION_ROUNDS = 3;
const SERVICE_KEYS = Object.freeze(['origin', 'clientId', 'clientSecret']);
const OPTION_KEYS = Object.freeze([
    'action', 'draftId', 'verifier', 'finalizer', 'fetchImpl'
]);

/**
 * Converge one explicitly approved Gallery finalization action.
 * The finalizer is always consulted first, so its permanent receipt remains
 * reachable after operational draft and review rows have been purged.
 */
export async function runWithdrawalFinalizationBridge(options) {
    validateOptions(options);
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const verifierClient = serviceClient(options.verifier, fetchImpl);
    const finalizerClient = serviceClient(options.finalizer, fetchImpl);
    const finalizerPath =
        `/api/service/drafts/${encodeURIComponent(options.draftId)}` +
        '/withdrawal-finalizations';

    const result = await convergeFinalizerAction({
        action: options.action,
        finalizerClient,
        verifierClient,
        finalizerPath,
        draftId: options.draftId,
        idempotencyKey: operationKey(
            options.action === 'withdrawal'
                ? 'gallery-withdrawal'
                : 'gallery-purge',
            options.draftId
        )
    });

    return Object.freeze({
        schemaVersion: '1.0',
        status: result.status,
        replayed: result.replayed
    });
}

/** Fixed, non-identifying content is the only successful Actions log output. */
export function withdrawalFinalizationCompletionSummary(result) {
    if (
        !hasExactKeys(result, ['schemaVersion', 'status', 'replayed']) ||
        result.schemaVersion !== '1.0' ||
        typeof result.replayed !== 'boolean'
    ) throw new Error('Gallery finalization result is invalid.');
    if (result.status === 'withdrawn') {
        return Object.freeze({
            schemaVersion: '1.0',
            status: 'gallery-photo-withdrawal-completed'
        });
    }
    if (result.status === 'purged') {
        return Object.freeze({
            schemaVersion: '1.0',
            status: 'gallery-photo-purge-completed'
        });
    }
    if (result.status === 'retention-pending') {
        return Object.freeze({
            schemaVersion: '1.0',
            status: 'gallery-photo-retention-recorded'
        });
    }
    throw new Error('Gallery finalization result is invalid.');
}

async function convergeFinalizerAction({
    action,
    finalizerClient,
    verifierClient,
    finalizerPath,
    draftId,
    idempotencyKey
}) {
    const seenVerifications = new Set();
    let response;
    while (true) {
        response = await finalizerClient.json(
            'POST',
            finalizerPath,
            { idempotencyKey },
            [200, 201, 202]
        );
        const verification = exactHostVerificationRequest(response);
        if (!verification) break;
        const verificationMarker =
            `${verification.expectedStateVersion}:${verification.verifierIdempotencyKey}`;
        if (
            seenVerifications.has(verificationMarker) ||
            seenVerifications.size >= MAX_UNIQUE_VERIFICATION_ROUNDS
        ) throw new Error('Gallery finalization did not converge.');
        seenVerifications.add(verificationMarker);
        await verifyPublicHost(
            verifierClient,
            draftId,
            verification
        );
    }

    return action === 'withdrawal'
        ? exactWithdrawnResult(response)
        : exactPurgeResult(response);
}

async function verifyPublicHost(client, draftId, verification) {
    const response = await client.json(
        'POST',
        `/api/service/drafts/${encodeURIComponent(draftId)}` +
            '/public-host-absence-verifications',
        {
            expectedStateVersion: verification.expectedStateVersion,
            idempotencyKey: verification.verifierIdempotencyKey
        },
        [200, 201]
    );
    requireExactHostVerification(response.body);
}

function exactHostVerificationRequest(response) {
    const value = response.body;
    if (response.status !== 202 || value?.status !== 'host-verification-required') {
        return null;
    }
    if (
        !hasExactKeys(value, [
            'status', 'expectedStateVersion', 'verifierIdempotencyKey', 'replayed'
        ]) ||
        !Number.isSafeInteger(value.expectedStateVersion) ||
        value.expectedStateVersion < 0 ||
        !IDEMPOTENCY_KEY_PATTERN.test(value.verifierIdempotencyKey || '') ||
        value.replayed !== false
    ) throw new Error('Public-host verification request is invalid.');
    return Object.freeze({
        expectedStateVersion: value.expectedStateVersion,
        verifierIdempotencyKey: value.verifierIdempotencyKey
    });
}

function exactWithdrawnResult(response) {
    const value = response.body;
    if (
        ![200, 201].includes(response.status) ||
        !hasExactKeys(value, ['status', 'replayed']) ||
        value.status !== 'withdrawn' ||
        typeof value.replayed !== 'boolean'
    ) throw new Error('Gallery withdrawal was not confirmed.');
    return value;
}

function exactPurgeResult(response) {
    const value = response.body;
    if (
        [200, 201].includes(response.status) &&
        hasExactKeys(value, ['status', 'replayed']) &&
        value.status === 'purged' &&
        typeof value.replayed === 'boolean'
    ) return value;

    if (
        response.status === 202 &&
        hasExactKeys(value, ['status', 'eligibleAt', 'replayed']) &&
        value.status === 'retention-pending' &&
        validIsoTime(value.eligibleAt) &&
        typeof value.replayed === 'boolean'
    ) return value;

    throw new Error('Gallery purge was not confirmed.');
}

function requireExactHostVerification(value) {
    if (
        !hasExactKeys(
            value,
            ['verificationId', 'hostDeletionConfirmed', 'replayed']
        ) ||
        !HOST_VERIFICATION_ID_PATTERN.test(value.verificationId || '') ||
        value.hostDeletionConfirmed !== true ||
        typeof value.replayed !== 'boolean'
    ) throw new Error('Public-host absence was not confirmed.');
}

function serviceClient(configuration, fetchImpl) {
    const origin = normalizeOrigin(configuration.origin);
    const accessHeaders = {
        'CF-Access-Client-Id': configuration.clientId,
        'CF-Access-Client-Secret': configuration.clientSecret
    };
    return {
        async json(method, requestPath, body, allowedStatuses) {
            const payload = JSON.stringify(body);
            const response = await fetchImpl(`${origin}${requestPath}`, {
                method,
                headers: {
                    ...accessHeaders,
                    'Content-Type': 'application/json',
                    'Content-Length': String(Buffer.byteLength(payload))
                },
                body: payload,
                redirect: 'error',
                cache: 'no-store',
                credentials: 'omit',
                signal: AbortSignal.timeout(SERVICE_REQUEST_TIMEOUT_MILLISECONDS)
            });
            if (
                !(response instanceof Response) ||
                !allowedStatuses.includes(response.status)
            ) {
                throw new Error('A protected Gallery service request failed.');
            }
            if (
                response.headers.get('Content-Type')?.split(';')[0] !==
                'application/json'
            ) {
                throw new Error('A protected Gallery service returned an invalid response.');
            }
            return { status: response.status, body: await response.json() };
        }
    };
}

function validateOptions(options) {
    if (
        !plainObject(options) ||
        !hasOnlyKeys(options, OPTION_KEYS) ||
        !['withdrawal', 'purge'].includes(options.action) ||
        !DRAFT_ID_PATTERN.test(options.draftId || '') ||
        typeof (options.fetchImpl || globalThis.fetch) !== 'function'
    ) throw new Error('The Gallery finalization configuration is invalid.');

    validateService(options.verifier);
    validateService(options.finalizer);
    if (options.verifier.origin === options.finalizer.origin) {
        throw new Error('The Gallery finalization configuration is invalid.');
    }
}

function validateService(value) {
    if (
        !hasExactKeys(value, SERVICE_KEYS) ||
        normalizeOrigin(value.origin) === null ||
        !safeSecret(value.clientId) ||
        !safeSecret(value.clientSecret)
    ) throw new Error('The Gallery finalization configuration is invalid.');
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

function operationKey(label, draftId) {
    return `${label}-${createHash('sha256')
        .update(`${label}:${draftId}`)
        .digest('hex')
        .slice(0, 32)}`;
}

function validIsoTime(value) {
    return typeof value === 'string' &&
        ISO_TIME_PATTERN.test(value) &&
        Number.isFinite(Date.parse(value)) &&
        new Date(Date.parse(value)).toISOString() === value;
}

function safeSecret(value) {
    return typeof value === 'string' &&
        value.length >= 1 && value.length <= 4096 &&
        !/[\u0000-\u001f\u007f]/.test(value);
}

function plainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
        (Object.getPrototypeOf(value) === Object.prototype ||
            Object.getPrototypeOf(value) === null);
}

function hasOnlyKeys(value, allowedKeys) {
    return plainObject(value) &&
        Object.keys(value).every(key => allowedKeys.includes(key));
}

function hasExactKeys(value, expectedKeys) {
    if (!plainObject(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...expectedKeys].sort();
    return actual.length === expected.length &&
        actual.every((key, index) => key === expected[index]);
}
