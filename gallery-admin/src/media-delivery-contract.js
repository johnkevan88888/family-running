export const MEDIA_DELIVERY_CONTRACT_HEADER = 'X-Family-Running-Media-Contract';
export const MEDIA_DELIVERY_CONTRACT_VALUE = 'approved-media-v1';
export const MEDIA_DELIVERY_VERSION_HEADER = 'X-Family-Running-Media-Version';

export const MEDIA_BINDING_WITNESS_SHA256 =
    '54bdb34ea423475fe0544cacbf32ab4f7e75846b5f25f1296e9bb2d157cd9f77';
export const MEDIA_BINDING_WITNESS_SIZE = 28;
export const MEDIA_BINDING_WITNESS_CONTENT_TYPE = 'image/webp';
export const MEDIA_BINDING_WITNESS_KEY =
    `media/v1/${MEDIA_BINDING_WITNESS_SHA256}/display.webp`;
export const MEDIA_BINDING_WITNESS_PATH = `/${MEDIA_BINDING_WITNESS_KEY}`;

const CANONICAL_WORKER_VERSION_ID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EXACT_MEDIA_ENVIRONMENT_KEYS = Object.freeze([
    'APPROVED_MEDIA',
    'MEDIA_VERSION'
]);

export function readMediaDeliveryProof(env) {
    try {
        const environmentKeys = Object.keys(env || {});
        const approvedMedia = env?.APPROVED_MEDIA;
        const versionId = env?.MEDIA_VERSION?.id;
        if (
            environmentKeys.length !== EXACT_MEDIA_ENVIRONMENT_KEYS.length ||
            environmentKeys.some(key => !EXACT_MEDIA_ENVIRONMENT_KEYS.includes(key)) ||
            !approvedMedia ||
            typeof approvedMedia.get !== 'function' ||
            typeof approvedMedia.head !== 'function' ||
            typeof versionId !== 'string' ||
            !CANONICAL_WORKER_VERSION_ID.test(versionId)
        ) {
            return null;
        }

        return Object.freeze({
            contract: MEDIA_DELIVERY_CONTRACT_VALUE,
            version: versionId
        });
    } catch {
        return null;
    }
}
