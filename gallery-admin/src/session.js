const COOKIE_NAME_PREFIX = '__Host-gallery_admin_session_';
const SESSION_LIFETIME_SECONDS = 30 * 60;
const SITE_MODES = new Set(['family', 'everyone']);
const SESSION_KEYS = Object.freeze([
    'v',
    'kind',
    'siteMode',
    'identityHash',
    'csrfHash',
    'iat',
    'exp',
    'nonce'
]);
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const HEX_64_PATTERN = /^[a-f0-9]{64}$/;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export async function createBrowserSession(identity, env, siteMode, nowMilliseconds) {
    const nowSeconds = Math.floor(nowMilliseconds / 1000);
    const accessExpirySeconds = Number.isFinite(identity?.expiresAt)
        ? Math.floor(identity.expiresAt / 1000)
        : nowSeconds + SESSION_LIFETIME_SECONDS;
    const expiresAt = Math.min(
        nowSeconds + SESSION_LIFETIME_SECONDS,
        accessExpirySeconds
    );

    if (
        identity?.type !== 'browser' ||
        !SITE_MODES.has(siteMode) ||
        expiresAt <= nowSeconds
    ) {
        throw new Error('Browser session cannot be issued.');
    }

    const csrfToken = randomBase64Url(32);
    const payload = {
        v: 1,
        kind: 'browser',
        siteMode,
        identityHash: await hashIdentity(identity),
        csrfHash: await sha256Hex(csrfToken),
        iat: nowSeconds,
        exp: expiresAt,
        nonce: randomBase64Url(16)
    };
    const encodedPayload = encodeBase64Url(textEncoder.encode(JSON.stringify(payload)));
    const signature = await signPayload(encodedPayload, env?.SESSION_SECRET);
    const value = `${encodedPayload}.${encodeBase64Url(signature)}`;

    return {
        csrfToken,
        cookie: `${cookieName(siteMode)}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${expiresAt - nowSeconds}`
    };
}

export async function validateBrowserSession(
    request,
    identity,
    env,
    siteMode,
    nowMilliseconds,
    options = {}
) {
    try {
        if (identity?.type !== 'browser' || !SITE_MODES.has(siteMode)) {
            return false;
        }

        const token = readCookie(request.headers.get('Cookie'), siteMode);
        const segments = token?.split('.') || [];
        if (
            segments.length !== 2 ||
            segments.some((segment) => !BASE64URL_PATTERN.test(segment))
        ) {
            return false;
        }

        const hmacKey = await importHmacKey(env?.SESSION_SECRET);
        const signatureValid = await crypto.subtle.verify(
            'HMAC',
            hmacKey,
            decodeBase64Url(segments[1]),
            textEncoder.encode(segments[0])
        );
        if (!signatureValid) {
            return false;
        }

        const payloadBytes = decodeBase64Url(segments[0]);
        if (payloadBytes.byteLength > 2048) {
            return false;
        }
        const payload = JSON.parse(textDecoder.decode(payloadBytes));
        if (!isExactSessionPayload(payload)) {
            return false;
        }
        if (!constantTimeTextEqual(payload.siteMode, siteMode)) {
            return false;
        }

        const nowSeconds = Math.floor(nowMilliseconds / 1000);
        if (
            payload.iat > nowSeconds + 30 ||
            payload.exp <= nowSeconds ||
            payload.exp - payload.iat > SESSION_LIFETIME_SECONDS
        ) {
            return false;
        }

        const currentIdentityHash = await hashIdentity(identity);
        if (!constantTimeTextEqual(payload.identityHash, currentIdentityHash)) {
            return false;
        }

        if (options.requireCsrf === false) {
            return true;
        }

        const csrfToken = request.headers.get('X-CSRF-Token');
        if (
            typeof csrfToken !== 'string' ||
            !BASE64URL_PATTERN.test(csrfToken) ||
            csrfToken.length > 256
        ) {
            return false;
        }
        const csrfHash = await sha256Hex(csrfToken);
        return constantTimeTextEqual(payload.csrfHash, csrfHash);
    } catch {
        return false;
    }
}

export async function hashIdentity(identity) {
    return sha256Hex(identityKey(identity));
}

function identityKey(identity) {
    if (
        identity &&
        typeof identity.subject === 'string' &&
        identity.subject.length > 0
    ) {
        return `subject:${identity.subject}`;
    }
    if (
        identity &&
        typeof identity.email === 'string' &&
        identity.email.length > 0
    ) {
        return `email:${identity.email.toLowerCase()}`;
    }
    throw new Error('Verified identity is incomplete.');
}

async function sha256Hex(value) {
    const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(value));
    return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

function randomBase64Url(byteCount) {
    const bytes = new Uint8Array(byteCount);
    crypto.getRandomValues(bytes);
    return encodeBase64Url(bytes);
}

async function signPayload(encodedPayload, secret) {
    const key = await importHmacKey(secret);
    return new Uint8Array(await crypto.subtle.sign(
        'HMAC',
        key,
        textEncoder.encode(encodedPayload)
    ));
}

async function importHmacKey(secret) {
    if (typeof secret !== 'string') {
        throw new Error('Session signing key is unavailable.');
    }
    const secretBytes = textEncoder.encode(secret);
    if (secretBytes.byteLength < 32 || secretBytes.byteLength > 1024) {
        throw new Error('Session signing key has an invalid length.');
    }
    return crypto.subtle.importKey(
        'raw',
        secretBytes,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign', 'verify']
    );
}

function readCookie(cookieHeader, siteMode) {
    if (typeof cookieHeader !== 'string' || cookieHeader.length > 4096) {
        return null;
    }
    const name = cookieName(siteMode);
    const values = cookieHeader
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part.startsWith(`${name}=`))
        .map((part) => part.slice(name.length + 1));
    return values.length === 1 && values[0] ? values[0] : null;
}

function cookieName(siteMode) {
    if (!SITE_MODES.has(siteMode)) {
        throw new Error('Session site mode is invalid.');
    }
    return `${COOKIE_NAME_PREFIX}${siteMode}`;
}

function isExactSessionPayload(value) {
    if (!isPlainObject(value)) {
        return false;
    }
    const keys = Object.keys(value).sort();
    if (
        keys.length !== SESSION_KEYS.length ||
        !SESSION_KEYS.every((key) => keys.includes(key))
    ) {
        return false;
    }
    return value.v === 1 &&
        value.kind === 'browser' &&
        SITE_MODES.has(value.siteMode) &&
        HEX_64_PATTERN.test(value.identityHash) &&
        HEX_64_PATTERN.test(value.csrfHash) &&
        Number.isSafeInteger(value.iat) &&
        Number.isSafeInteger(value.exp) &&
        typeof value.nonce === 'string' &&
        BASE64URL_PATTERN.test(value.nonce);
}

function encodeBase64Url(bytes) {
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function decodeBase64Url(value) {
    const remainder = value.length % 4;
    if (remainder === 1) {
        throw new Error('Invalid base64url value.');
    }
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') +
        (remainder === 0 ? '' : '='.repeat(4 - remainder));
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

function constantTimeTextEqual(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') {
        return false;
    }
    const length = Math.max(left.length, right.length);
    let difference = left.length ^ right.length;
    for (let index = 0; index < length; index += 1) {
        difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
    }
    return difference === 0;
}

function isPlainObject(value) {
    return value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype;
}
