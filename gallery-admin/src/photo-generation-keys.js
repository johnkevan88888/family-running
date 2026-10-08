// Additive photo-only address format. Existing content-addressed v1 keys and
// their retirement evidence remain unchanged. A public generation is opaque:
// no private asset/person/draft ID, name, race or original filename appears.
const generationPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const filenameByRole = Object.freeze({'photo-display':'display.webp','photo-thumbnail':'thumbnail.webp'});
const keyPattern = /^media\/v2\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([0-9a-f]{64})\/(display\.webp|thumbnail\.webp)$/;

export function createPhotoGenerationId() {
    const generationId = crypto.randomUUID();
    if (!generationPattern.test(generationId)) throw new Error('Secure photo generation unavailable');
    return generationId;
}

export function buildV2PhotoDerivativeKey({generationId,sha256,role}) {
    if (typeof generationId !== 'string' || !generationPattern.test(generationId) ||
        typeof sha256 !== 'string' || !hashPattern.test(sha256) || !Object.hasOwn(filenameByRole,role)) {
        throw new TypeError('Invalid server-owned photo generation');
    }
    return `media/v2/${generationId}/${sha256}/${filenameByRole[role]}`;
}

export function parseV2PhotoDerivativeKey(key) {
    const match = typeof key === 'string' ? keyPattern.exec(key) : null;
    if (!match) return null;
    return Object.freeze({generationId:match[1],sha256:match[2],filename:match[3],
        role:match[3] === 'display.webp' ? 'photo-display' : 'photo-thumbnail',contentType:'image/webp'});
}
