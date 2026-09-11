const R2_HTTP_METADATA_KEYS = Object.freeze([
    'contentType',
    'contentLanguage',
    'contentDisposition',
    'contentEncoding',
    'cacheControl',
    'cacheExpiry'
]);
const OPTIONAL_R2_HTTP_METADATA_KEYS = Object.freeze(
    R2_HTTP_METADATA_KEYS.filter(key => key !== 'contentType')
);

export function matchesExactImageHttpMetadata(value, expectedContentType) {
    if (!isPlainObject(value) || value.contentType !== expectedContentType) {
        return false;
    }
    const actualKeys = Object.keys(value);
    return actualKeys.includes('contentType') &&
        actualKeys.every(key => R2_HTTP_METADATA_KEYS.includes(key)) &&
        OPTIONAL_R2_HTTP_METADATA_KEYS.every(key => value[key] === undefined);
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
