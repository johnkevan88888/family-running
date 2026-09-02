import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';

import {
    buildV1ApprovedDerivativeKey,
    buildV1StagingDerivativeKey,
    DERIVATIVE_KEY_SPECS
} from '../../gallery-admin/src/storage-keys.js';
import { processingError, sanitizeProcessingError } from './errors.mjs';
import {
    insideResizeDimensionsAreConformant,
    inspectPhotoInput,
    transformPhotoDerivative
} from './photo.mjs';
import { requiredPolicyRolesForMediaType, storageRoleForPolicyRole } from './roles.mjs';
import { scanPhotoMetadata, sha256Hex } from './scanner.mjs';
import {
    assertPinnedExifTool,
    assertPinnedSharp,
    closeExifTool,
    configurePinnedSharp,
    createPinnedExifTool
} from './toolchain.mjs';

const photoMimeByExtension = Object.freeze({
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png'
});
const sha256Pattern = /^[a-f0-9]{64}$/;

export async function processGalleryPhoto(request, dependencies = {}) {
    validateRequest(request);

    const policy = dependencies.policy || await loadMediaPolicy();
    if (request.sourceBytes.byteLength > policy.inputLimits.photo.maximumBytes) {
        // Reject before duplicating caller-owned bytes or starting either native
        // tool. The inspector repeats this check as defence in depth.
        throw processingError('input-rejected');
    }
    const sharpImplementation = dependencies.sharpImplementation || sharp;
    const makeExifTool = dependencies.createExifTool || createPinnedExifTool;
    const transform = dependencies.transformPhotoDerivative || transformPhotoDerivative;
    const scanMetadata = dependencies.scanPhotoMetadata || scanPhotoMetadata;
    const observeWorkDirectory = dependencies.observeWorkDirectory;
    const removeWorkDirectory = dependencies.removeWorkDirectory || removeIsolatedWorkDirectory;
    const workPrefix = path.join(os.tmpdir(), 'family-running-gallery-media-');
    let workDirectory = null;
    let exiftool = null;
    let result = null;
    let failure = null;

    try {
        configurePinnedSharp(sharpImplementation);
        const sharpEvidence = assertPinnedSharp(sharpImplementation);
        const sourceBytes = Buffer.from(request.sourceBytes);
        if (sha256Hex(sourceBytes) !== request.expectedSha256) {
            throw processingError('source-rejected');
        }
        const input = await inspectPhotoInput({
            bytes: sourceBytes,
            policy,
            fileName: `owner-photo.${request.fileExtension}`,
            declaredMimeType: request.declaredMimeType,
            sharpImplementation
        });

        exiftool = makeExifTool();
        const exiftoolEvidence = await assertPinnedExifTool(exiftool);

        workDirectory = await fs.mkdtemp(workPrefix);
        if (observeWorkDirectory !== undefined) {
            if (typeof observeWorkDirectory !== 'function') {
                throw processingError('invalid-request');
            }
            observeWorkDirectory(workDirectory);
        }

        const sourceExtension = input.detectedFormat === 'jpeg' ? 'jpg' : input.detectedFormat;
        const sourcePath = path.join(workDirectory, `source.${sourceExtension}`);
        await fs.writeFile(sourcePath, sourceBytes, { flag: 'wx', mode: 0o600 });
        const sourceMetadata = await scanMetadata({
            exiftool,
            filePath: sourcePath,
            bytes: sourceBytes,
            scannerVersion: exiftoolEvidence.scannerVersion,
            stage: 'source',
            expectedFormat: input.detectedFormat,
            policy
        });

        const derivatives = [];
        for (const policyRole of requiredPolicyRolesForMediaType('photo')) {
            const profile = policy.derivativeProfiles[policyRole];
            const storageRole = storageRoleForPolicyRole(policyRole);
            const storageSpec = DERIVATIVE_KEY_SPECS[storageRole];
            const outputPath = path.join(workDirectory, storageSpec.filename);
            await transform({
                sourceBytes,
                outputPath,
                maximumLongEdge: profile.maximumLongEdge,
                sharpImplementation
            });

            const derivativeBytes = await fs.readFile(outputPath);
            const derivative = await verifyPhotoDerivative({
                derivativeBytes,
                outputPath,
                policyRole,
                storageRole,
                storageSpec,
                maximumLongEdge: profile.maximumLongEdge,
                sourceDimensions: {
                    width: input.orientedWidth,
                    height: input.orientedHeight
                },
                request,
                policy,
                sharpImplementation,
                sharpEvidence,
                exiftool,
                exiftoolEvidence,
                scanMetadata
            });
            derivatives.push(derivative);
        }

        assertCompleteDerivativeSet(derivatives, 'photo');
        result = {
            schemaVersion: '1.0',
            scope: 'photo-processing-v1',
            mediaType: 'photo',
            inheritedSite: request.draftBinding.site,
            draftId: request.draftBinding.draftId,
            processingRunId: request.draftBinding.processingRunId,
            source: Object.freeze({
                sha256: sha256Hex(sourceBytes),
                byteLength: sourceBytes.byteLength,
                detectedFormat: input.detectedFormat,
                orientedWidth: input.orientedWidth,
                orientedHeight: input.orientedHeight,
                metadataEntryCount: sourceMetadata.metadataEntryCount,
                metadataFindingCategories: sourceMetadata.findingCategories
            }),
            toolchain: Object.freeze({
                sharp: sharpEvidence.scannerVersion,
                libvips: sharpEvidence.libvipsVersion,
                webp: sharpEvidence.webpVersion,
                png: sharpEvidence.pngVersion,
                exiftool: exiftoolEvidence.scannerVersion,
                videoEnabled: false
            }),
            derivatives: Object.freeze(derivatives)
        };
    } catch (error) {
        failure = sanitizeProcessingError(error);
    }

    if (exiftool) {
        try {
            await closeExifTool(exiftool);
        } catch (error) {
            failure = sanitizeProcessingError(error, 'cleanup-failed');
        }
    }

    if (workDirectory) {
        try {
            await removeWorkDirectory(workDirectory);
        } catch {
            failure = processingError('cleanup-failed');
        }
    }

    if (failure) {
        throw failure;
    }

    return result;
}

async function verifyPhotoDerivative({
    derivativeBytes,
    outputPath,
    policyRole,
    storageRole,
    storageSpec,
    maximumLongEdge,
    sourceDimensions,
    request,
    policy,
    sharpImplementation,
    sharpEvidence,
    exiftool,
    exiftoolEvidence,
    scanMetadata
}) {
    if (!Buffer.isBuffer(derivativeBytes) || derivativeBytes.byteLength <= 0) {
        throw processingError('derivative-rejected');
    }
    if (policy.detectAllowedFileType(derivativeBytes) !== 'webp') {
        throw processingError('derivative-rejected');
    }

    let metadata;
    try {
        metadata = await sharpImplementation(derivativeBytes, {
            failOn: 'error',
            limitInputPixels: 50 * 1_000 * 1_000,
            sequentialRead: true
        }).metadata();
    } catch {
        throw processingError('derivative-rejected');
    }

    const technicalProbe = {
        schemaVersion: policy.schemaVersion,
        role: policyRole,
        container: metadata.format,
        width: metadata.width,
        height: metadata.height,
        durationSeconds: null,
        fastStart: false,
        streams: [{ type: 'image', codec: metadata.format }]
    };
    if (!insideResizeDimensionsAreConformant({
        sourceWidth: sourceDimensions.width,
        sourceHeight: sourceDimensions.height,
        outputWidth: metadata.width,
        outputHeight: metadata.height,
        maximumLongEdge
    })) {
        throw processingError('derivative-rejected');
    }
    const technicalExpectation = {
        role: policyRole,
        width: metadata.width,
        height: metadata.height,
        sourceWidth: sourceDimensions.width,
        sourceHeight: sourceDimensions.height,
        sourceDurationSeconds: null,
        durationToleranceSeconds: 0,
        audioExpected: false
    };
    const technicalAssessment = policy.assessDerivativeTechnicalProbe(
        technicalProbe,
        technicalExpectation
    );
    if (!technicalAssessment.valid) {
        throw processingError('derivative-rejected');
    }

    const sha256 = sha256Hex(derivativeBytes);
    const technicalEnvelopeAssessment = policy.assessScanEnvelope({
        schemaVersion: policy.schemaVersion,
        resultKind: 'technical-derivative',
        subject: {
            sha256,
            byteLength: derivativeBytes.byteLength
        },
        scanner: {
            name: sharpEvidence.scannerName,
            version: sharpEvidence.scannerVersion
        },
        status: {
            completed: true,
            truncated: false,
            exitCode: 0
        },
        result: technicalProbe
    }, {
        sha256,
        byteLength: derivativeBytes.byteLength,
        scannerName: sharpEvidence.scannerName,
        scannerVersion: sharpEvidence.scannerVersion,
        resultKind: 'technical-derivative'
    });
    if (!technicalEnvelopeAssessment.valid) {
        throw processingError('derivative-rejected');
    }

    const metadataEvidence = await scanMetadata({
        exiftool,
        filePath: outputPath,
        bytes: derivativeBytes,
        scannerVersion: exiftoolEvidence.scannerVersion,
        stage: 'public-derivative',
        expectedFormat: 'webp',
        expectedDimensions: {
            width: metadata.width,
            height: metadata.height
        },
        policy
    });
    if (metadataEvidence.sha256 !== sha256 || metadataEvidence.byteLength !== derivativeBytes.byteLength) {
        throw processingError('derivative-rejected');
    }

    const stagingKey = buildV1StagingDerivativeKey({
        site: request.draftBinding.site,
        draftId: request.draftBinding.draftId,
        processingRunId: request.draftBinding.processingRunId,
        sha256,
        role: storageRole
    });
    const approvedKey = buildV1ApprovedDerivativeKey({ sha256, role: storageRole });

    return Object.freeze({
        policyRole,
        storageRole,
        contentType: storageSpec.contentType,
        sha256,
        byteLength: derivativeBytes.byteLength,
        width: metadata.width,
        height: metadata.height,
        metadataEntryCount: metadataEvidence.metadataEntryCount,
        stagingKey,
        approvedKey,
        payload: new Blob([derivativeBytes], { type: storageSpec.contentType })
    });
}

function validateRequest(request) {
    const binding = request?.draftBinding;
    if (
        !request ||
        !Buffer.isBuffer(request.sourceBytes) ||
        !Object.hasOwn(photoMimeByExtension, request.fileExtension) ||
        request.declaredMimeType !== photoMimeByExtension[request.fileExtension] ||
        !sha256Pattern.test(request.expectedSha256 || '') ||
        !binding ||
        !['family', 'everyone'].includes(binding.site) ||
        typeof binding.draftId !== 'string' ||
        typeof binding.processingRunId !== 'string'
    ) {
        throw processingError('invalid-request');
    }

    const allowedKeys = new Set([
        'sourceBytes',
        'fileExtension',
        'declaredMimeType',
        'expectedSha256',
        'draftBinding'
    ]);
    const allowedBindingKeys = new Set(['site', 'draftId', 'processingRunId']);
    if (
        Object.keys(request).some(key => !allowedKeys.has(key)) ||
        Object.keys(binding).some(key => !allowedBindingKeys.has(key))
    ) {
        throw processingError('invalid-request');
    }

    try {
        // Reuse the single storage-key grammar instead of maintaining a second
        // UUID expression in the processor. This probe performs no I/O.
        buildV1StagingDerivativeKey({
            site: binding.site,
            draftId: binding.draftId,
            processingRunId: binding.processingRunId,
            sha256: '0'.repeat(64),
            role: 'photo-display'
        });
    } catch {
        throw processingError('invalid-request');
    }
}

// Keep the already-merged synthetic rehearsal callable while its historical
// tests and remote rehearsal evidence remain in the repository. The go-live
// bridge uses processGalleryPhoto directly.
export async function processSyntheticGalleryPhoto(request, dependencies = {}) {
    const allowedKeys = new Set([
        'syntheticOnly',
        'sourceBytes',
        'fileName',
        'declaredMimeType',
        'draftBinding'
    ]);
    if (
        request?.syntheticOnly !== true ||
        Object.keys(request || {}).some(key => !allowedKeys.has(key))
    ) {
        throw processingError('invalid-request');
    }
    const extension = /\.([A-Za-z0-9]+)$/.exec(request?.fileName || '')?.[1]?.toLowerCase();
    return await processGalleryPhoto({
        sourceBytes: request?.sourceBytes,
        fileExtension: extension,
        declaredMimeType: request?.declaredMimeType,
        expectedSha256: Buffer.isBuffer(request?.sourceBytes)
            ? sha256Hex(request.sourceBytes)
            : '',
        draftBinding: request?.draftBinding
    }, dependencies);
}

function assertCompleteDerivativeSet(derivatives, mediaType) {
    const actualRoles = derivatives.map(entry => entry.policyRole).sort();
    const requiredRoles = [...requiredPolicyRolesForMediaType(mediaType)].sort();
    if (
        actualRoles.length !== requiredRoles.length ||
        actualRoles.some((role, index) => role !== requiredRoles[index])
    ) {
        throw processingError('derivative-rejected');
    }
}

async function loadMediaPolicy() {
    const module = await import('../../gallery-media-policy.js');
    return module.default || module;
}

async function removeIsolatedWorkDirectory(workDirectory) {
    await fs.rm(workDirectory, { recursive: true, force: true, maxRetries: 2 });
}
