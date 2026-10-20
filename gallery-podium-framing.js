(function (root, factory) {
    const contract = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = contract;
    }

    root.galleryPodiumFraming = contract;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createGalleryPodiumFramingContract() {
    'use strict';

    const schemaVersion = '1.0';
    const maxFrames = 2000;
    const digestPattern = /^[a-f0-9]{64}$/;
    const identifierPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

    // This document contains presentation only. A digest cannot introduce media,
    // identify a person on its own, or make a suppressed photo eligible.
    function validateDocument(value) {
        const problems = [];
        if (!isPlainRecord(value)) {
            return ['Podium framing must be a plain JSON object with own data fields.'];
        }

        exactKeys(value, ['schemaVersion', 'frames'], 'Podium framing', problems);
        if (value.schemaVersion !== schemaVersion) {
            problems.push(`schemaVersion must be exactly "${schemaVersion}".`);
        }
        if (!isPlainRecord(value.frames)) {
            problems.push('frames must be a plain JSON object with own data fields.');
            return problems;
        }

        const keys = Object.keys(value.frames);
        if (keys.length > maxFrames) {
            problems.push(`frames must contain no more than ${maxFrames} entries.`);
            return problems;
        }
        keys.forEach(key => {
            if (!digestPattern.test(key)) {
                problems.push('Every frames key must be one lowercase SHA-256 digest.');
            }
            validateFrame(value.frames[key], `frames[${JSON.stringify(key)}]`, problems);
        });
        return problems;
    }

    // Callers must resolve suppression and public eligibility before asking for
    // this key. It binds one already-tagged athlete to one exact photo generation;
    // changing the item, source or thumbnail deliberately abandons the old crop.
    async function keyFor(item, athleteId) {
        if (!isPlainRecord(item) || item.type !== 'photo' ||
                !isIdentifier(item.id) || !isIdentifier(athleteId) ||
                !Array.isArray(item.athleteIds) ||
                !item.athleteIds.every(isIdentifier) ||
                new Set(item.athleteIds).size !== item.athleteIds.length ||
                !item.athleteIds.includes(athleteId) ||
                !isSafeMediaUrl(item.sourceUrl) || !isSafeMediaUrl(item.thumbnailUrl)) {
            throw new TypeError('A public photo with the exact tagged athlete and HTTPS media URLs is required.');
        }
        if (!globalThis.crypto?.subtle || typeof TextEncoder !== 'function') {
            throw new Error('Secure SHA-256 support is required for podium framing.');
        }
        const bytes = new TextEncoder().encode(JSON.stringify([
            'gallery-podium-framing-v1', item.id, athleteId, item.sourceUrl, item.thumbnailUrl
        ]));
        const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    }

    // Coordinates are CSS pixels within the existing podium's image box. No
    // ranking, result, athlete selection or image-byte processing happens here.
    function layout(frameOrNull, imageWidth, imageHeight, boxWidth, boxHeight) {
        if (![imageWidth, imageHeight, boxWidth, boxHeight].every(isPositiveFinite)) {
            throw new TypeError('Image and box dimensions must be positive finite numbers.');
        }
        const frameProblems = [];
        if (frameOrNull !== null) {
            validateFrame(frameOrNull, 'frame', frameProblems);
            if (frameProblems.length) {
                throw new TypeError(frameProblems.join(' '));
            }
        }

        const scale = frameOrNull === null
            ? Math.min(boxWidth / imageWidth, boxHeight / imageHeight)
            : Math.max(boxWidth / imageWidth, boxHeight / imageHeight) * frameOrNull.zoom;
        const width = imageWidth * scale;
        const height = imageHeight * scale;
        if (![scale, width, height].every(isPositiveFinite)) {
            throw new RangeError('Dimensions cannot produce finite positive podium geometry.');
        }

        const left = frameOrNull === null
            ? (boxWidth - width) / 2
            : clamp(boxWidth / 2 - width * (frameOrNull.x / 100), Math.min(0, boxWidth - width), 0);
        const top = frameOrNull === null
            ? (boxHeight - height) / 2
            : clamp(boxHeight / 2 - height * (frameOrNull.y / 100), Math.min(0, boxHeight - height), 0);
        if (![left, top].every(Number.isFinite)) {
            throw new RangeError('Dimensions cannot produce finite podium offsets.');
        }
        return { left, top, width, height };
    }

    function validateFrame(value, label, problems) {
        if (!isPlainRecord(value)) {
            problems.push(`${label} must be a plain JSON object with own data fields.`);
            return;
        }
        exactKeys(value, ['x', 'y', 'zoom'], label, problems);
        for (const field of ['x', 'y']) {
            if (typeof value[field] !== 'number' || !Number.isFinite(value[field]) ||
                    value[field] < 0 || value[field] > 100) {
                problems.push(`${label}.${field} must be a finite number from 0 through 100.`);
            }
        }
        if (typeof value.zoom !== 'number' || !Number.isFinite(value.zoom) ||
                value.zoom < 1 || value.zoom > 8) {
            problems.push(`${label}.zoom must be a finite number from 1 through 8.`);
        }
    }

    function isPlainRecord(value) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) return false;
        return Reflect.ownKeys(value).every(key => {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            return typeof key === 'string' && descriptor.enumerable && Object.hasOwn(descriptor, 'value');
        });
    }

    function exactKeys(value, allowedKeys, label, problems) {
        for (const key of Object.keys(value)) {
            if (!allowedKeys.includes(key)) problems.push(`${label} contains unsupported field "${key}".`);
        }
        for (const key of allowedKeys) {
            if (!Object.hasOwn(value, key)) problems.push(`${label} is missing required field "${key}".`);
        }
    }

    function isIdentifier(value) {
        return typeof value === 'string' && value.length <= 300 && identifierPattern.test(value);
    }

    function isSafeMediaUrl(value) {
        if (typeof value !== 'string' || value.length > 4096 || value.trim() !== value) return false;
        try {
            const url = new URL(value);
            return url.protocol === 'https:' && !url.username && !url.password;
        } catch {
            return false;
        }
    }

    function isPositiveFinite(value) {
        return typeof value === 'number' && Number.isFinite(value) && value > 0;
    }

    function clamp(value, minimum, maximum) {
        return Math.min(maximum, Math.max(minimum, value));
    }

    // The protected uploader serves this same self-contained factory. No copy of
    // the crop maths, filesystem access or private data enters its browser code.
    function browserScript() {
        return `globalThis.galleryPodiumFraming=(${createGalleryPodiumFramingContract.toString()})();`;
    }

    return Object.freeze({ validateDocument, keyFor, layout, browserScript });
});
