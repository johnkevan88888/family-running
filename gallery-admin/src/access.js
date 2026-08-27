const SAFE_IDENTITY_PATTERN = /^[^\u0000-\u001f\u007f]{1,512}$/;
const SERVICE_CLIENT_ID_PATTERN = /^[0-9a-f]{32}\.access$/i;
const ASSERTION_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_ASSERTION_LENGTH = 16384;
const MAX_ASSERTION_PAYLOAD_LENGTH = 12288;

export async function verifyWorkerAccessIdentity(accessContext, request) {
    if (!accessContext || typeof accessContext.getIdentity !== 'function') {
        throw new Error('Worker-level Access did not authenticate this request.');
    }

    const identity = await accessContext.getIdentity();
    if (identity === undefined) {
        // Worker-level Access has already validated and injected this assertion.
        // Decode it only to recover the exact non-human identity and audience;
        // ctx.access remains the authentication and signature-validation boundary.
        return verifyServiceApplicationAssertion(accessContext, request);
    }
    if (!isPlainObject(identity)) {
        throw new Error('Worker-level Access identity is unavailable.');
    }

    const serviceIdentity = firstSafeIdentityValue(
        identity.service_token_id,
        identity.common_name
    );
    const applicationClaimServiceIdentity =
        identity.service_token_status === undefined &&
        identity.email === undefined &&
        identity.type === 'app' &&
        identity.sub === ''
            ? firstSafeIdentityValue(identity.common_name)
            : null;
    if (
        identity.service_token_status === true ||
        applicationClaimServiceIdentity !== null
    ) {
        const subject = applicationClaimServiceIdentity || serviceIdentity;
        if (!subject) {
            throw new Error('Worker-level Access service identity is invalid.');
        }
        return {
            type: 'service',
            subject
        };
    }

    const email = normalizeEmail(identity.email);
    if (!email) {
        throw new Error('Worker-level Access browser identity is invalid.');
    }

    const subject = firstSafeIdentityValue(
        identity.user_uuid,
        identity.id,
        email
    );
    if (!subject) {
        throw new Error('Worker-level Access browser identity is incomplete.');
    }

    return {
        type: 'browser',
        subject,
        email
    };
}

function verifyServiceApplicationAssertion(accessContext, request) {
    const audience = firstSafeIdentityValue(accessContext?.aud);
    const assertion = request?.headers?.get?.('Cf-Access-Jwt-Assertion');
    if (
        !audience ||
        typeof assertion !== 'string' ||
        assertion.length === 0 ||
        assertion.length > MAX_ASSERTION_LENGTH
    ) {
        throw new Error('Worker-level Access service assertion is unavailable.');
    }

    const segments = assertion.split('.');
    if (
        segments.length !== 3 ||
        segments.some(segment =>
            segment.length === 0 ||
            !ASSERTION_SEGMENT_PATTERN.test(segment)
        )
    ) {
        throw new Error('Worker-level Access service assertion is malformed.');
    }

    const payload = decodeAssertionPayload(segments[1]);
    const subject = normalizeServiceClientId(payload?.common_name);
    if (
        !isPlainObject(payload) ||
        payload.type !== 'app' ||
        payload.sub !== '' ||
        Object.prototype.hasOwnProperty.call(payload, 'email') ||
        !subject ||
        !assertionAudienceMatches(payload.aud, audience) ||
        !isValidAccessIssuer(payload.iss) ||
        !isPositiveSafeInteger(payload.iat) ||
        !isPositiveSafeInteger(payload.exp) ||
        payload.exp <= payload.iat
    ) {
        throw new Error('Worker-level Access service assertion is invalid.');
    }

    return {
        type: 'service',
        subject
    };
}

function assertionAudienceMatches(claim, expectedAudience) {
    if (typeof claim === 'string') {
        return firstSafeIdentityValue(claim) === expectedAudience;
    }
    return Array.isArray(claim) &&
        claim.length > 0 &&
        claim.every(value => firstSafeIdentityValue(value) === value) &&
        claim.includes(expectedAudience);
}

function decodeAssertionPayload(segment) {
    if (
        typeof segment !== 'string' ||
        segment.length === 0 ||
        segment.length > MAX_ASSERTION_PAYLOAD_LENGTH ||
        !ASSERTION_SEGMENT_PATTERN.test(segment)
    ) {
        return null;
    }

    try {
        const paddingLength = (4 - (segment.length % 4)) % 4;
        const base64 = segment
            .replace(/-/g, '+')
            .replace(/_/g, '/') + '='.repeat(paddingLength);
        const decoded = atob(base64);
        const bytes = Uint8Array.from(decoded, character =>
            character.charCodeAt(0)
        );
        const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const payload = JSON.parse(json);
        return isPlainObject(payload) ? payload : null;
    } catch {
        return null;
    }
}

function normalizeServiceClientId(value) {
    const normalized = firstSafeIdentityValue(value);
    return normalized && SERVICE_CLIENT_ID_PATTERN.test(normalized)
        ? normalized
        : null;
}

function isValidAccessIssuer(value) {
    if (typeof value !== 'string' || !SAFE_IDENTITY_PATTERN.test(value)) {
        return false;
    }
    try {
        const issuer = new URL(value);
        return issuer.protocol === 'https:' &&
            issuer.username === '' &&
            issuer.password === '' &&
            issuer.port === '' &&
            issuer.pathname === '/' &&
            issuer.search === '' &&
            issuer.hash === '' &&
            issuer.hostname.endsWith('.cloudflareaccess.com') &&
            issuer.hostname !== 'cloudflareaccess.com';
    } catch {
        return false;
    }
}

function isPositiveSafeInteger(value) {
    return Number.isSafeInteger(value) && value > 0;
}

function firstSafeIdentityValue(...values) {
    for (const value of values) {
        if (typeof value !== 'string') {
            continue;
        }
        const normalized = value.trim();
        if (SAFE_IDENTITY_PATTERN.test(normalized)) {
            return normalized;
        }
    }
    return null;
}

function normalizeEmail(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.trim().toLowerCase();
    if (
        !SAFE_IDENTITY_PATTERN.test(normalized) ||
        !normalized.includes('@') ||
        /\s/.test(normalized)
    ) {
        return null;
    }
    return normalized;
}

function isPlainObject(value) {
    return value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype;
}
