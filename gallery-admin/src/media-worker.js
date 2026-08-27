const MEDIA_PATH_PATTERN = /^\/media\/v1\/([a-f0-9]{64})\/(display\.webp|thumbnail\.webp|video\.mp4|poster\.webp)$/;
const CONTENT_TYPES = Object.freeze({
    'display.webp': 'image/webp',
    'thumbnail.webp': 'image/webp',
    'video.mp4': 'video/mp4',
    'poster.webp': 'image/webp'
});
const ETAG_PATTERN = /^"[A-Za-z0-9-]{1,128}"$/;
const RAW_ETAG_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

export async function handleMediaRequest(request, env) {
    const url = new URL(request.url);
    if (request.url.includes('?') || url.hash) {
        return mediaFailure(404);
    }

    const match = MEDIA_PATH_PATTERN.exec(url.pathname);
    if (!match) {
        return mediaFailure(404);
    }

    if (!['GET', 'HEAD'].includes(request.method)) {
        return mediaFailure(405, { Allow: 'GET, HEAD' });
    }

    if (
        !env?.APPROVED_MEDIA ||
        typeof env.APPROVED_MEDIA.get !== 'function' ||
        typeof env.APPROVED_MEDIA.head !== 'function'
    ) {
        return mediaFailure(503);
    }

    const key = url.pathname.slice(1);
    const filename = match[2];
    const contentType = CONTENT_TYPES[filename];
    const rangeHeader = request.headers.get('Range');

    try {
        if (request.method === 'HEAD' || rangeHeader !== null) {
            const head = await env.APPROVED_MEDIA.head(key);
            if (!head) {
                return mediaFailure(404);
            }
            const totalSize = readObjectSize(head);
            if (totalSize === null) {
                return mediaFailure(503);
            }

            if (rangeHeader !== null) {
                if (
                    typeof head.etag !== 'string' ||
                    !RAW_ETAG_PATTERN.test(head.etag)
                ) {
                    return mediaFailure(503);
                }
                const range = parseSingleRange(rangeHeader, totalSize);
                if (!range) {
                    return mediaFailure(416, {
                        'Accept-Ranges': 'bytes',
                        'Content-Range': `bytes */${totalSize}`
                    });
                }

                const headers = mediaHeaders(
                    contentType,
                    range.length,
                    head,
                    {
                        'Content-Range': `bytes ${range.offset}-${range.end}/${totalSize}`
                    }
                );
                if (request.method === 'HEAD') {
                    return new Response(null, { status: 206, headers });
                }

                const getOptions = {
                    range: { offset: range.offset, length: range.length },
                    onlyIf: { etagMatches: head.etag }
                };
                const object = await env.APPROVED_MEDIA.get(key, getOptions);
                if (!object || object.body === undefined || object.body === null) {
                    return mediaFailure(503);
                }
                if (!rangedObjectMatchesHead(object, head, range, totalSize)) {
                    return mediaFailure(503);
                }
                return new Response(object.body, { status: 206, headers });
            }

            return new Response(null, {
                status: 200,
                headers: mediaHeaders(contentType, totalSize, head)
            });
        }

        const object = await env.APPROVED_MEDIA.get(key);
        if (!object || object.body === undefined || object.body === null) {
            return mediaFailure(404);
        }
        const size = readObjectSize(object);
        if (size === null) {
            return mediaFailure(503);
        }
        return new Response(object.body, {
            status: 200,
            headers: mediaHeaders(contentType, size, object)
        });
    } catch {
        return mediaFailure(503);
    }
}

function parseSingleRange(value, totalSize) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(value);
    if (!match || (!match[1] && !match[2]) || totalSize === 0) {
        return null;
    }

    if (!match[1]) {
        const suffixLength = parseSafeInteger(match[2]);
        if (suffixLength === null || suffixLength === 0) {
            return null;
        }
        const length = Math.min(suffixLength, totalSize);
        const offset = totalSize - length;
        return { offset, length, end: totalSize - 1 };
    }

    const offset = parseSafeInteger(match[1]);
    if (offset === null || offset >= totalSize) {
        return null;
    }

    const requestedEnd = match[2] ? parseSafeInteger(match[2]) : totalSize - 1;
    if (requestedEnd === null || requestedEnd < offset) {
        return null;
    }
    const end = Math.min(requestedEnd, totalSize - 1);
    return { offset, length: end - offset + 1, end };
}

function parseSafeInteger(value) {
    if (!/^\d+$/.test(value) || value.length > 16) {
        return null;
    }
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : null;
}

function readObjectSize(object) {
    return Number.isSafeInteger(object?.size) && object.size >= 0
        ? object.size
        : null;
}

function rangedObjectMatchesHead(object, head, expectedRange, expectedSize) {
    if (
        !object.range ||
        object.range.offset !== expectedRange.offset ||
        object.range.length !== expectedRange.length ||
        object.size !== expectedSize
    ) {
        return false;
    }

    return object.etag === head.etag;
}

function mediaHeaders(contentType, contentLength, object, extra = {}) {
    const headers = new Headers({
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=60, must-revalidate',
        'Content-Disposition': 'inline',
        'Content-Length': String(contentLength),
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
        'Content-Type': contentType,
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex, noimageindex'
    });
    if (typeof object?.httpEtag === 'string' && ETAG_PATTERN.test(object.httpEtag)) {
        headers.set('ETag', object.httpEtag);
    }
    for (const [name, value] of Object.entries(extra)) {
        headers.set(name, value);
    }
    return headers;
}

function mediaFailure(status, extra = {}) {
    const headers = new Headers({
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex, noimageindex'
    });
    for (const [name, value] of Object.entries(extra)) {
        headers.set(name, value);
    }
    return new Response(null, { status, headers });
}

export default {
    fetch(request, env) {
        return handleMediaRequest(request, env);
    }
};
