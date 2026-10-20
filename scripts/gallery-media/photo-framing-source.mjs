import {exactFramingKeys,PRIVATE_FRAMING_ORIENTATION} from '../../gallery-admin/src/private-gallery-framing.js';

// Technical input binding only. Coordinates and identities never travel in
// this processing acknowledgement; the public projection comes from the exact
// immutable attempt snapshot later, after independent byte verification.
export function validatePhotoFramingSource(value) {
    if (!exactFramingKeys(value,['imageHeight','imageWidth','orientation','sourceSha256']) ||
            value.orientation !== PRIVATE_FRAMING_ORIENTATION || typeof value.sourceSha256 !== 'string' ||
            !/^[a-f0-9]{64}$/.test(value.sourceSha256) ||
            ![value.imageWidth, value.imageHeight].every(number => Number.isSafeInteger(number) && number > 0) ||
            value.imageWidth * value.imageHeight > 50_000_000) {
        throw new Error('Invalid photo framing source binding.');
    }
    return value;
}

export function assertPhotoFramingSource(expected, decodedSource) {
    if (expected === undefined) return;
    validatePhotoFramingSource(expected);
    if (decodedSource?.sha256 !== expected.sourceSha256 ||
            decodedSource?.orientedWidth !== expected.imageWidth || decodedSource?.orientedHeight !== expected.imageHeight) {
        throw new Error('Photo framing does not match the independently decoded oriented source.');
    }
}
