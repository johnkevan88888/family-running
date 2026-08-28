const ADMIN_SECURITY_HEADERS = Object.freeze({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; media-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex, nofollow, noarchive'
});

export function adminJson(status, body, extraHeaders = {}) {
    const headers = new Headers(ADMIN_SECURITY_HEADERS);
    headers.set('Content-Type', 'application/json; charset=utf-8');
    headers.set('Vary', 'Cookie, Origin');
    for (const [name, value] of Object.entries(extraHeaders)) {
        headers.set(name, value);
    }
    return new Response(JSON.stringify(body), { status, headers });
}

export function adminFailure(status, extraHeaders = {}) {
    return adminJson(status, { error: statusLabel(status) }, extraHeaders);
}

export function adminHtml(status, html, extraHeaders = {}) {
    const response = adminJson(status, {}, extraHeaders);
    const headers = new Headers(response.headers);
    headers.set('Content-Type', 'text/html; charset=utf-8');
    return new Response(html, { status, headers });
}

export function adminStyles(status, css, extraHeaders = {}) {
    return adminText(status, css, 'text/css; charset=utf-8', extraHeaders);
}

export function adminScript(status, script, extraHeaders = {}) {
    return adminText(
        status,
        script,
        'text/javascript; charset=utf-8',
        extraHeaders
    );
}

function adminText(status, body, contentType, extraHeaders) {
    const response = adminJson(status, {}, extraHeaders);
    const headers = new Headers(response.headers);
    headers.set('Content-Type', contentType);
    return new Response(body, { status, headers });
}

function statusLabel(status) {
    switch (status) {
    case 400:
        return 'invalid-request';
    case 403:
        return 'forbidden';
    case 404:
        return 'not-found';
    case 405:
        return 'method-not-allowed';
    case 413:
        return 'request-too-large';
    case 415:
        return 'unsupported-media-type';
    case 422:
        return 'invalid-media';
    default:
        return 'service-unavailable';
    }
}
