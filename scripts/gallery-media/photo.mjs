import sharp from 'sharp';

import { processingError } from './errors.mjs';

const webpOptions = Object.freeze({
    quality: 82,
    alphaQuality: 100,
    lossless: false,
    nearLossless: false,
    smartSubsample: true,
    smartDeblock: false,
    preset: 'photo',
    effort: 6,
    exact: false,
    force: true
});

const enabledSyntheticPhotoFormats = new Set(['jpeg', 'png']);

export async function inspectSyntheticPhotoInput({
    bytes,
    policy,
    fileName,
    declaredMimeType,
    sharpImplementation = sharp
}) {
    if (!Buffer.isBuffer(bytes) || !policy) {
        throw processingError('invalid-request');
    }

    if (bytes.byteLength > policy.inputLimits.photo.maximumBytes) {
        throw processingError('input-rejected');
    }

    const signatureFormat = policy.detectAllowedFileType(bytes);
    if (!enabledSyntheticPhotoFormats.has(signatureFormat)) {
        // The first Phase D byte-conformance slice proves JPEG and the built-in
        // Phase C PNG fixture. Other Phase A formats remain disabled until their
        // exact decoder and metadata behavior has its own real-byte proof.
        throw processingError('input-rejected');
    }

    let metadata;
    try {
        metadata = await sharpImplementation(bytes, {
            failOn: 'error',
            limitInputPixels: policy.inputLimits.photo.maximumPixels,
            sequentialRead: true,
            autoOrient: false
        }).metadata();
    } catch {
        throw processingError('decoder-rejected');
    }

    if (
        metadata.format !== signatureFormat ||
        !Number.isSafeInteger(metadata.width) ||
        !Number.isSafeInteger(metadata.height) ||
        (metadata.pages !== undefined && metadata.pages !== 1)
    ) {
        throw processingError('decoder-rejected');
    }

    if (signatureFormat === 'png' && metadata.hasAlpha === true) {
        let statistics;
        try {
            statistics = await sharpImplementation(bytes, {
                failOn: 'error',
                limitInputPixels: policy.inputLimits.photo.maximumPixels,
                sequentialRead: true,
                autoOrient: false
            }).stats();
        } catch {
            throw processingError('decoder-rejected');
        }
        // The local slice supports the opaque Phase C PNG fixture. Transparent
        // input needs a separately approved visual policy (reject vs flatten),
        // so it fails at the input boundary rather than producing Extended WebP.
        if (statistics?.isOpaque !== true) {
            throw processingError('input-rejected');
        }
    }

    const probe = {
        schemaVersion: policy.schemaVersion,
        fileName,
        declaredMimeType,
        mediaType: 'photo',
        detectedFormat: signatureFormat,
        byteLength: bytes.byteLength,
        width: metadata.width,
        height: metadata.height,
        durationSeconds: null,
        inspectionCompleted: true,
        corrupt: false
    };
    const assessment = policy.assessInputFile(probe, bytes);
    if (!assessment.valid) {
        throw processingError('input-rejected');
    }

    const orientedWidth = metadata.autoOrient?.width;
    const orientedHeight = metadata.autoOrient?.height;
    if (!Number.isSafeInteger(orientedWidth) || !Number.isSafeInteger(orientedHeight)) {
        throw processingError('decoder-rejected');
    }

    return Object.freeze({
        detectedFormat: signatureFormat,
        width: metadata.width,
        height: metadata.height,
        orientation: Number.isSafeInteger(metadata.orientation) ? metadata.orientation : null,
        orientedWidth,
        orientedHeight
    });
}

export async function transformPhotoDerivative({
    sourceBytes,
    outputPath,
    maximumLongEdge,
    sharpImplementation = sharp
}) {
    if (
        !Buffer.isBuffer(sourceBytes) ||
        typeof outputPath !== 'string' ||
        !Number.isSafeInteger(maximumLongEdge) ||
        maximumLongEdge <= 0
    ) {
        throw processingError('invalid-request');
    }

    try {
        await sharpImplementation(sourceBytes, {
            failOn: 'error',
            limitInputPixels: 50 * 1_000 * 1_000,
            sequentialRead: true,
            autoOrient: false
        })
            .autoOrient()
            .resize({
                width: maximumLongEdge,
                height: maximumLongEdge,
                fit: 'inside',
                withoutEnlargement: true,
                kernel: sharpImplementation.kernel.lanczos3,
                fastShrinkOnLoad: false
            })
            .webp(webpOptions)
            .toFile(outputPath);
    } catch {
        throw processingError('processing-failed');
    }
}

export function insideResizeDimensionsAreConformant({
    sourceWidth,
    sourceHeight,
    outputWidth,
    outputHeight,
    maximumLongEdge
}) {
    if (
        !Number.isSafeInteger(sourceWidth) || sourceWidth <= 0 ||
        !Number.isSafeInteger(sourceHeight) || sourceHeight <= 0 ||
        !Number.isSafeInteger(outputWidth) || outputWidth <= 0 ||
        !Number.isSafeInteger(outputHeight) || outputHeight <= 0 ||
        !Number.isSafeInteger(maximumLongEdge) || maximumLongEdge <= 0
    ) {
        return false;
    }

    if (outputWidth > sourceWidth || outputHeight > sourceHeight) {
        return false;
    }

    const sourceLongEdge = Math.max(sourceWidth, sourceHeight);
    if (sourceLongEdge <= maximumLongEdge) {
        return outputWidth === sourceWidth && outputHeight === sourceHeight;
    }

    const scale = maximumLongEdge / sourceLongEdge;
    const expectedWidth = Math.max(1, Math.round(sourceWidth * scale));
    const expectedHeight = Math.max(1, Math.round(sourceHeight * scale));

    return Math.max(outputWidth, outputHeight) === maximumLongEdge &&
        outputWidth === expectedWidth &&
        outputHeight === expectedHeight;
}
