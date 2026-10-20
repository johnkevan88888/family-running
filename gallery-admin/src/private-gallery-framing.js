// Private presentation data only. No detector output, recognition, identity
// inference, consent, media URL or original bytes belong in this contract.
export const PRIVATE_FRAMING_ORIENTATION = 'exif-transposed-v1';
// Existing private roster identities predate this feature and are not required
// to use a particular UUID version/variant. Membership remains authoritative.
export const privateFramingPersonPattern = /^person_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function isFramingRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).every(key => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return typeof key === 'string' && descriptor.enumerable && Object.hasOwn(descriptor, 'value');
    });
}
export function exactFramingKeys(value, keys) {
    return isFramingRecord(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
}
export function validatePrivateFramingFrames(frames, personIds) {
    if (!isFramingRecord(frames) || Object.keys(frames).length > 100 || !Array.isArray(personIds) ||
        personIds.length < 1 || personIds.length > 100 || new Set(personIds).size !== personIds.length ||
        personIds.some(id => typeof id !== 'string' || !privateFramingPersonPattern.test(id))) return false;
    return Object.entries(frames).every(([id, frame]) => personIds.includes(id) &&
        exactFramingKeys(frame, ['x', 'y', 'zoom']) && ['x', 'y'].every(key =>
            typeof frame[key] === 'number' && Number.isFinite(frame[key]) && frame[key] >= 0 && frame[key] <= 100) &&
        typeof frame.zoom === 'number' && Number.isFinite(frame.zoom) && frame.zoom >= 1 && frame.zoom <= 8);
}
export function canonicalPrivateFramingFrames(frames) {
    return Object.fromEntries(Object.keys(frames).sort().map(id => [id, {
        x: frames[id].x, y: frames[id].y, zoom: frames[id].zoom
    }]));
}
export function validPrivateFramingDimensions(width, height) {
    return [width, height].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 100000) &&
        width * height <= 50000000;
}
