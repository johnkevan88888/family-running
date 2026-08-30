export async function readBoundedBytes(body, maximumBytes) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
        throw new Error('A valid media byte limit is required.');
    }
    if (body instanceof Uint8Array) {
        if (body.byteLength > maximumBytes) throw new Error('Body exceeds the private limit.');
        return Uint8Array.from(body);
    }
    if (body instanceof ArrayBuffer) {
        if (body.byteLength > maximumBytes) throw new Error('Body exceeds the private limit.');
        return new Uint8Array(body.slice(0));
    }
    if (typeof body?.arrayBuffer === 'function') {
        const arrayBuffer = await body.arrayBuffer();
        if (arrayBuffer.byteLength > maximumBytes) throw new Error('Body exceeds the private limit.');
        return new Uint8Array(arrayBuffer);
    }
    if (typeof body?.getReader !== 'function') {
        throw new Error('Readable body is unavailable.');
    }

    const chunks = [];
    let total = 0;
    const reader = body.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!(value instanceof Uint8Array)) {
                throw new Error('Readable body returned an invalid chunk.');
            }
            total += value.byteLength;
            if (total > maximumBytes) {
                await reader.cancel();
                throw new Error('Body exceeds the private limit.');
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

export async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)]
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
}

export function inspectStaticWebp(bytes) {
    if (
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength < 20 ||
        ascii(bytes, 0, 4) !== 'RIFF' ||
        ascii(bytes, 8, 12) !== 'WEBP' ||
        readUint32Le(bytes, 4) !== bytes.byteLength - 8
    ) return null;

    let offset = 12;
    let dimensions = null;
    let imageChunks = 0;
    let canvasDimensions = null;
    while (offset + 8 <= bytes.byteLength) {
        const kind = ascii(bytes, offset, offset + 4);
        const length = readUint32Le(bytes, offset + 4);
        const dataOffset = offset + 8;
        const nextOffset = dataOffset + length + (length % 2);
        if (!Number.isSafeInteger(length) || nextOffset > bytes.byteLength) return null;
        if (['EXIF', 'XMP ', 'ICCP', 'ANIM', 'ANMF'].includes(kind)) return null;
        if (kind === 'VP8X') {
            if (length !== 10 || canvasDimensions !== null) return null;
            const flags = bytes[dataOffset];
            if ((flags & 0b00111110) !== 0) return null;
            canvasDimensions = {
                width: 1 + readUint24Le(bytes, dataOffset + 4),
                height: 1 + readUint24Le(bytes, dataOffset + 7)
            };
        } else if (kind === 'VP8 ') {
            if (
                length < 10 ||
                bytes[dataOffset + 3] !== 0x9d ||
                bytes[dataOffset + 4] !== 0x01 ||
                bytes[dataOffset + 5] !== 0x2a
            ) return null;
            dimensions = {
                width: readUint16Le(bytes, dataOffset + 6) & 0x3fff,
                height: readUint16Le(bytes, dataOffset + 8) & 0x3fff
            };
            imageChunks += 1;
        } else if (kind === 'VP8L') {
            if (length < 5 || bytes[dataOffset] !== 0x2f) return null;
            const packed = readUint32Le(bytes, dataOffset + 1);
            dimensions = {
                width: 1 + (packed & 0x3fff),
                height: 1 + ((packed >>> 14) & 0x3fff)
            };
            imageChunks += 1;
        } else if (kind !== 'ALPH') {
            return null;
        }
        offset = nextOffset;
    }
    if (
        offset !== bytes.byteLength ||
        imageChunks !== 1 ||
        !validDimensions(dimensions) ||
        (canvasDimensions && !sameDimensions(canvasDimensions, dimensions))
    ) return null;
    return dimensions;
}

function sameDimensions(left, right) {
    return Boolean(left) && Boolean(right) &&
        left.width === right.width && left.height === right.height;
}

function validDimensions(value) {
    return Boolean(value) &&
        Number.isSafeInteger(value.width) && value.width > 0 &&
        Number.isSafeInteger(value.height) && value.height > 0;
}

function ascii(bytes, start, end) {
    return String.fromCharCode(...bytes.subarray(start, end));
}

function readUint16Le(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint24Le(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readUint32Le(bytes, offset) {
    return (
        bytes[offset] |
        (bytes[offset + 1] << 8) |
        (bytes[offset + 2] << 16) |
        (bytes[offset + 3] << 24)
    ) >>> 0;
}
