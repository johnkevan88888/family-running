import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

import {
    parseV1ApprovedDerivativeKey,
    parseV1StagingDerivativeKey
} from '../gallery-admin/src/storage-keys.js';
import {
    insideResizeDimensionsAreConformant,
    inspectSyntheticPhotoInput,
    transformPhotoDerivative
} from '../scripts/gallery-media/photo.mjs';
import { processSyntheticGalleryPhoto } from '../scripts/gallery-media/processor.mjs';
import {
    POLICY_TO_STORAGE_ROLE,
    REQUIRED_POLICY_ROLES,
    requiredPolicyRolesForMediaType,
    storageRoleForPolicyRole
} from '../scripts/gallery-media/roles.mjs';
import { scanPhotoMetadata, sha256Hex } from '../scripts/gallery-media/scanner.mjs';
import {
    assertPinnedExifTool,
    assertVideoToolchainAvailable,
    closeExifTool,
    createPinnedExifTool,
    galleryMediaToolchain
} from '../scripts/gallery-media/toolchain.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'scripts', 'process-gallery-media.mjs');
const sentinels = Object.freeze([
    'PRIVATE-GPS-CONTEXT-SENTINEL',
    'PRIVATE-DEVICE-SENTINEL',
    'PRIVATE-OWNER-SENTINEL',
    'PRIVATE-SOURCE-NAME-SENTINEL.jpg',
    'PRIVATE-TOKEN-SENTINEL',
    'PRIVATE-CONSENT-SENTINEL'
]);
const draftBinding = Object.freeze({
    site: 'family',
    draftId: makeDraftId('1'),
    processingRunId: makeRunId('2')
});

assert.deepEqual(POLICY_TO_STORAGE_ROLE, {
    'photo-display': 'photo-display',
    'photo-thumbnail': 'photo-thumbnail',
    'video-playback': 'video',
    'video-poster': 'video-poster'
});
assert.deepEqual(REQUIRED_POLICY_ROLES, {
    photo: ['photo-display', 'photo-thumbnail'],
    video: ['video-playback', 'video-poster']
});
assert.ok(Object.isFrozen(POLICY_TO_STORAGE_ROLE));
assert.ok(Object.isFrozen(REQUIRED_POLICY_ROLES.photo));
assert.equal(storageRoleForPolicyRole('video-playback'), 'video');
assert.deepEqual(requiredPolicyRolesForMediaType('photo'), [
    'photo-display',
    'photo-thumbnail'
]);
assert.throws(() => storageRoleForPolicyRole('video'), /Unsupported Gallery derivative role/);
assert.throws(() => requiredPolicyRolesForMediaType('audio'), /Unsupported Gallery media type/);

assert.equal(galleryMediaToolchain.scope, 'synthetic-local-phase-d');
assert.equal(galleryMediaToolchain.photo.enabled, true);
assert.equal(galleryMediaToolchain.photo.sharpRuntimeVersion, '0.35.2');
assert.equal(galleryMediaToolchain.photo.exiftoolRuntimeVersion, '13.40');
assert.equal(galleryMediaToolchain.photo.pngRuntimeVersion, '1.6.58');
assert.equal(galleryMediaToolchain.video.enabled, false);
assert.equal(galleryMediaToolchain.video.runnerDigest, null);
assert.throws(
    () => assertVideoToolchainAvailable(),
    error => error?.code === 'toolchain-unavailable'
);

const cliResult = spawnSync(process.execPath, [cliPath, '--check-photo-toolchain'], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true
});
assert.equal(cliResult.status, 0, cliResult.stderr);
assert.deepEqual(JSON.parse(cliResult.stdout), {
    status: 'ok',
    scope: 'synthetic-local-phase-d',
    photo: {
        sharp: '0.35.2',
        libvips: '8.18.3',
        webp: '1.6.0',
        png: '1.6.58',
        exiftool: '13.40'
    },
    video: {
        enabled: false,
        reason: 'reviewed-runner-not-installed'
    }
});
assert.equal(cliResult.stdout.includes(repoRoot), false);
assert.equal(cliResult.stderr, '');

for (const invalidArguments of [[], ['--unknown']]) {
    const invalidCli = spawnSync(process.execPath, [cliPath, ...invalidArguments], {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true
    });
    assert.equal(invalidCli.status, 2);
    assert.match(invalidCli.stderr, /^Usage:/);
    assert.equal(invalidCli.stdout, '');
}

const helpCli = spawnSync(process.execPath, [cliPath, '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true
});
assert.equal(helpCli.status, 0);
assert.match(helpCli.stdout, /^Usage:/);
assert.equal(helpCli.stderr, '');

for (const dimensions of [
    {
        sourceWidth: 1_300,
        sourceHeight: 4_700,
        outputWidth: 133,
        outputHeight: 480,
        maximumLongEdge: 480
    },
    {
        sourceWidth: 1_600,
        sourceHeight: 4_700,
        outputWidth: 163,
        outputHeight: 480,
        maximumLongEdge: 480
    },
    {
        sourceWidth: 3_100,
        sourceHeight: 4_700,
        outputWidth: 317,
        outputHeight: 480,
        maximumLongEdge: 480
    },
    {
        sourceWidth: 1_600,
        sourceHeight: 999,
        outputWidth: 480,
        outputHeight: 300,
        maximumLongEdge: 480
    }
]) {
    assert.equal(insideResizeDimensionsAreConformant(dimensions), true);
    assert.equal(
        insideResizeDimensionsAreConformant({
            ...dimensions,
            outputHeight: dimensions.outputHeight - 1
        }),
        false
    );
}

const fixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'family-running-gallery-fixture-'));
let fixtureExifTool;

try {
    fixtureExifTool = createPinnedExifTool();
    const fixtureScanner = await assertPinnedExifTool(fixtureExifTool);
    const hostilePhotoPath = path.join(fixtureDirectory, 'source.jpg');
    await sharp({
        create: {
            width: 1_800,
            height: 1_200,
            channels: 3,
            background: { r: 22, g: 88, b: 144 }
        }
    })
        .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
        .toFile(hostilePhotoPath);

    const writeResult = await fixtureExifTool.write(hostilePhotoPath, {
        'EXIF:Make': sentinels[1],
        'EXIF:Model': 'SYNTHETIC-CAMERA-MODEL',
        'EXIF:Artist': sentinels[2],
        'EXIF:ImageDescription': sentinels[0],
        'EXIF:UserComment': `${sentinels[4]} ${sentinels[5]}`,
        'EXIF:Software': 'SYNTHETIC-PRIVATE-SOFTWARE',
        'EXIF:GPSLatitude': 28.1234,
        'EXIF:GPSLongitude': 16.5678,
        'EXIF:GPSLatitudeRef': 'N',
        'EXIF:GPSLongitudeRef': 'W',
        'EXIF:Orientation': 6,
        'XMP-xmpMM:PreservedFileName': sentinels[3]
    }, {
        writeArgs: ['-overwrite_original', '-n']
    });
    assert.equal(writeResult.updated, 1);
    assert.equal(writeResult.created, 0);
    assert.equal(writeResult.unchanged, 0);
    assert.equal(writeResult.warnings?.length ?? 0, 0);
    assert.equal(await pathExists(`${hostilePhotoPath}_original`), false);

    const hostileRaw = await fixtureExifTool.readRaw(hostilePhotoPath, [
        '-G0:1', '-a', '-s', '-n', '-struct', '-all:all'
    ]);
    const hostilePaths = new Set(Object.keys(hostileRaw));
    for (const requiredPath of [
        'EXIF:IFD0:Orientation',
        'EXIF:IFD0:Make',
        'EXIF:IFD0:Model',
        'EXIF:IFD0:Artist',
        'EXIF:ExifIFD:UserComment',
        'EXIF:GPS:GPSLatitude',
        'EXIF:GPS:GPSLongitude',
        'XMP:XMP-xmpMM:PreservedFileName'
    ]) {
        assert.equal(hostilePaths.has(requiredPath), true, `Missing hostile tag ${requiredPath}.`);
    }

    const hostileBytes = await fs.readFile(hostilePhotoPath);
    for (const sentinel of sentinels) {
        assert.equal(
            hostileBytes.includes(Buffer.from(sentinel)),
            true,
            `The synthetic source does not contain ${sentinel}.`
        );
    }

    const workDirectories = [];
    const request = {
        syntheticOnly: true,
        sourceBytes: hostileBytes,
        fileName: 'synthetic-hostile-source.jpg',
        declaredMimeType: 'image/jpeg',
        draftBinding
    };
    const first = await processSyntheticGalleryPhoto(request, {
        observeWorkDirectory: workDirectory => workDirectories.push(workDirectory)
    });

    assert.equal(workDirectories.length, 1);
    assert.equal(await pathExists(workDirectories[0]), false);
    assert.equal(first.scope, 'synthetic-local-phase-d');
    assert.equal(first.mediaType, 'photo');
    assert.equal(first.inheritedSite, 'family');
    assert.equal(first.draftId, draftBinding.draftId);
    assert.equal(first.processingRunId, draftBinding.processingRunId);
    assert.equal(first.source.sha256, sha256Hex(hostileBytes));
    assert.equal(first.source.orientedWidth, 1_200);
    assert.equal(first.source.orientedHeight, 1_800);
    assert.ok(first.source.metadataEntryCount >= 8);
    assert.ok(first.source.metadataFindingCategories.includes('location'));
    assert.ok(first.source.metadataFindingCategories.includes('device'));
    assert.ok(first.source.metadataFindingCategories.includes('orientation'));
    assert.ok(first.source.metadataFindingCategories.includes('source-name'));
    assert.deepEqual(first.toolchain, {
        sharp: '0.35.2',
        libvips: '8.18.3',
        webp: '1.6.0',
        png: '1.6.58',
        exiftool: fixtureScanner.scannerVersion,
        videoEnabled: false
    });
    assert.deepEqual(first.derivatives.map(entry => entry.policyRole), [
        'photo-display',
        'photo-thumbnail'
    ]);

    const expectedDimensions = {
        'photo-display': { width: 1_067, height: 1_600 },
        'photo-thumbnail': { width: 320, height: 480 }
    };
    const firstDerivativeBytes = new Map();
    for (const derivative of first.derivatives) {
        assert.equal(derivative.payload instanceof Blob, true);
        assert.equal(derivative.payload.type, 'image/webp');
        const derivativeBytes = await derivativePayloadBytes(derivative);
        firstDerivativeBytes.set(derivative.policyRole, derivativeBytes);
        assert.equal(derivative.sha256, sha256Hex(derivativeBytes));
        assert.equal(derivative.byteLength, derivativeBytes.byteLength);
        assert.equal(derivative.payload.size, derivative.byteLength);
        assert.equal(derivative.metadataEntryCount, 0);
        assert.equal(derivative.contentType, 'image/webp');
        assert.equal(derivative.width, expectedDimensions[derivative.policyRole].width);
        assert.equal(derivative.height, expectedDimensions[derivative.policyRole].height);
        assert.equal(derivativeBytes.subarray(0, 4).toString('ascii'), 'RIFF');
        assert.equal(derivativeBytes.subarray(8, 12).toString('ascii'), 'WEBP');
        assert.equal(parseV1StagingDerivativeKey(derivative.stagingKey)?.sha256, derivative.sha256);
        assert.equal(parseV1StagingDerivativeKey(derivative.stagingKey)?.site, 'family');
        assert.equal(parseV1ApprovedDerivativeKey(derivative.approvedKey)?.sha256, derivative.sha256);
        assert.equal(parseV1ApprovedDerivativeKey(derivative.approvedKey)?.role, derivative.storageRole);
        for (const sentinel of sentinels) {
            assert.equal(derivativeBytes.includes(Buffer.from(sentinel)), false);
        }
    }

    const mutableCopy = await derivativePayloadBytes(first.derivatives[0]);
    mutableCopy[0] ^= 0xff;
    assert.notEqual(sha256Hex(mutableCopy), first.derivatives[0].sha256);
    assert.equal(
        sha256Hex(await derivativePayloadBytes(first.derivatives[0])),
        first.derivatives[0].sha256,
        'Mutating a materialized copy must not alter the verified immutable payload.'
    );

    const safeEvidenceText = JSON.stringify(stripDerivativePayloads(first));
    for (const privateValue of [...sentinels, hostilePhotoPath, fixtureDirectory, request.fileName]) {
        assert.equal(safeEvidenceText.includes(privateValue), false);
    }
    assert.equal(Object.hasOwn(first, 'fileName'), false);
    assert.equal(Object.hasOwn(first, 'destinationSite'), false);

    const secondWorkDirectories = [];
    const second = await processSyntheticGalleryPhoto(request, {
        observeWorkDirectory: workDirectory => secondWorkDirectories.push(workDirectory)
    });
    assert.equal(await pathExists(secondWorkDirectories[0]), false);
    assert.deepEqual(
        second.derivatives.map(entry => ({
            policyRole: entry.policyRole,
            sha256: entry.sha256,
            stagingKey: entry.stagingKey,
            approvedKey: entry.approvedKey
        })),
        first.derivatives.map(entry => ({
            policyRole: entry.policyRole,
            sha256: entry.sha256,
            stagingKey: entry.stagingKey,
            approvedKey: entry.approvedKey
        }))
    );
    for (let index = 0; index < first.derivatives.length; index += 1) {
        assert.equal(
            firstDerivativeBytes.get(first.derivatives[index].policyRole).equals(
                await derivativePayloadBytes(second.derivatives[index])
            ),
            true
        );
    }

    const smallPhoto = await sharp({
        create: {
            width: 32,
            height: 24,
            channels: 3,
            background: { r: 1, g: 2, b: 3 }
        }
    }).png().toBuffer();
    const small = await processSyntheticGalleryPhoto({
        ...request,
        sourceBytes: smallPhoto,
        fileName: 'synthetic-gallery-photo.png',
        declaredMimeType: 'image/png',
        draftBinding: {
            site: 'everyone',
            draftId: makeDraftId('3'),
            processingRunId: makeRunId('4')
        }
    });
    assert.deepEqual(
        small.derivatives.map(entry => [entry.width, entry.height]),
        [[32, 24], [32, 24]],
        'The fixed photo profiles must never enlarge a small source.'
    );
    assert.ok(small.derivatives.every(entry => entry.stagingKey.includes('/everyone/')));

    const phaseCShapePhoto = await sharp({
        create: {
            width: 800,
            height: 450,
            channels: 4,
            background: { r: 12, g: 34, b: 56, alpha: 1 }
        }
    }).png().toBuffer();
    const phaseCShape = await processSyntheticGalleryPhoto({
        ...request,
        sourceBytes: phaseCShapePhoto,
        fileName: 'synthetic-gallery-photo.png',
        declaredMimeType: 'image/png',
        draftBinding: {
            site: 'family',
            draftId: makeDraftId('7'),
            processingRunId: makeRunId('8')
        }
    });
    assert.deepEqual(
        phaseCShape.derivatives.map(entry => [entry.width, entry.height]),
        [[800, 450], [480, 270]],
        'The processor must accept the Phase C browser fixture PNG shape.'
    );

    const transparentPng = await sharp({
        create: {
            width: 24,
            height: 16,
            channels: 4,
            background: { r: 12, g: 34, b: 56, alpha: 0.5 }
        }
    }).png().toBuffer();
    let transparentExifToolCalled = false;
    await assert.rejects(
        processSyntheticGalleryPhoto({
            ...request,
            sourceBytes: transparentPng,
            fileName: 'synthetic-transparent-source.png',
            declaredMimeType: 'image/png'
        }, {
            createExifTool: () => {
                transparentExifToolCalled = true;
                return createPinnedExifTool();
            }
        }),
        error => error?.code === 'input-rejected'
    );
    assert.equal(
        transparentExifToolCalled,
        false,
        'Transparent PNG input must be rejected before ExifTool or derivative work.'
    );

    const oddRatioPhoto = await sharp({
        create: {
            width: 1_600,
            height: 999,
            channels: 3,
            background: { r: 9, g: 8, b: 7 }
        }
    }).jpeg().toBuffer();
    const oddRatio = await processSyntheticGalleryPhoto({
        ...request,
        sourceBytes: oddRatioPhoto,
        fileName: 'synthetic-odd-ratio-source.jpg',
        draftBinding: {
            site: 'family',
            draftId: makeDraftId('5'),
            processingRunId: makeRunId('6')
        }
    });
    assert.deepEqual(
        oddRatio.derivatives.map(entry => [entry.width, entry.height]),
        [[1_600, 999], [480, 300]],
        'Pinned decoding must not change the contracted odd-ratio resize rounding.'
    );

    const metadataBearingDerivativePath = path.join(fixtureDirectory, 'metadata-bearing.webp');
    await fs.writeFile(
        metadataBearingDerivativePath,
        firstDerivativeBytes.get('photo-display'),
        { flag: 'wx' }
    );
    const derivativeWrite = await fixtureExifTool.write(metadataBearingDerivativePath, {
        'XMP-xmpMM:PreservedFileName': sentinels[3]
    }, {
        writeArgs: ['-overwrite_original']
    });
    assert.equal(derivativeWrite.updated, 1);
    assert.equal(derivativeWrite.warnings?.length ?? 0, 0);
    const metadataBearingBytes = await fs.readFile(metadataBearingDerivativePath);
    await assert.rejects(
        scanPhotoMetadata({
            exiftool: fixtureExifTool,
            filePath: metadataBearingDerivativePath,
            bytes: metadataBearingBytes,
            scannerVersion: fixtureScanner.scannerVersion,
            stage: 'public-derivative',
            expectedFormat: 'webp',
            expectedDimensions: { width: 1_067, height: 1_600 },
            policy: await loadMediaPolicy()
        }),
        error =>
            ['metadata-scan-failed', 'derivative-rejected'].includes(error?.code) &&
            !error.message.includes(sentinels[3])
    );

    const policy = await loadMediaPolicy();
    const cleanBaselinePath = path.join(fixtureDirectory, 'clean-baseline.webp');
    const cleanBaselineBytes = firstDerivativeBytes.get('photo-display');
    await fs.writeFile(cleanBaselinePath, cleanBaselineBytes, { flag: 'wx' });
    const cleanCrossPlatformRaw = {
        SourceFile: cleanBaselinePath,
        'ExifTool:ExifToolVersion': Number(fixtureScanner.scannerVersion),
        'File:FileType': 'WEBP',
        'File:FileTypeExtension': 'WEBP',
        'File:MIMEType': 'image/webp',
        'File:System:FileInodeChangeDate': 'synthetic-system-value',
        'RIFF:ImageWidth': 1_067,
        'RIFF:ImageHeight': 1_600,
        errors: [],
        warnings: []
    };
    const cleanCrossPlatformScan = await scanPhotoMetadata({
        exiftool: { readRaw: async () => cleanCrossPlatformRaw },
        filePath: cleanBaselinePath,
        bytes: cleanBaselineBytes,
        scannerVersion: fixtureScanner.scannerVersion,
        stage: 'public-derivative',
        expectedFormat: 'webp',
        expectedDimensions: { width: 1_067, height: 1_600 },
        policy
    });
    assert.equal(cleanCrossPlatformScan.metadataEntryCount, 0);

    await assert.rejects(
        scanPhotoMetadata({
            exiftool: {
                readRaw: async () => ({
                    ...cleanCrossPlatformRaw,
                    'File:Comment': sentinels[4],
                })
            },
            filePath: cleanBaselinePath,
            bytes: cleanBaselineBytes,
            scannerVersion: fixtureScanner.scannerVersion,
            stage: 'public-derivative',
            expectedFormat: 'webp',
            expectedDimensions: { width: 1_067, height: 1_600 },
            policy
        }),
        error => error?.code === 'derivative-rejected' && !error.message.includes(sentinels[4])
    );
    await assert.rejects(
        scanPhotoMetadata({
            exiftool: {
                readRaw: async () => ({
                    ...cleanCrossPlatformRaw,
                    errors: [],
                    warnings: [sentinels[4]]
                })
            },
            filePath: cleanBaselinePath,
            bytes: cleanBaselineBytes,
            scannerVersion: fixtureScanner.scannerVersion,
            stage: 'public-derivative',
            expectedFormat: 'webp',
            expectedDimensions: { width: 1_067, height: 1_600 },
            policy
        }),
        error => error?.code === 'metadata-scan-failed' && !error.message.includes(sentinels[4])
    );

    await assert.rejects(
        scanPhotoMetadata({
            exiftool: fixtureExifTool,
            filePath: cleanBaselinePath,
            bytes: metadataBearingBytes,
            scannerVersion: fixtureScanner.scannerVersion,
            stage: 'public-derivative',
            expectedFormat: 'webp',
            expectedDimensions: { width: 1_067, height: 1_600 },
            policy
        }),
        error => error?.code === 'metadata-scan-failed'
    );

    const hostileConfigDirectory = path.join(fixtureDirectory, 'hostile-exiftool-home');
    await fs.mkdir(hostileConfigDirectory);
    await fs.writeFile(
        path.join(hostileConfigDirectory, '.ExifTool_config'),
        '%Image::ExifTool::UserDefined::Options = ( IgnoreTags => ["all"] );\n1;\n',
        'utf8'
    );
    const previousExifToolHome = process.env.EXIFTOOL_HOME;
    let hardenedExifTool;
    try {
        process.env.EXIFTOOL_HOME = hostileConfigDirectory;
        hardenedExifTool = createPinnedExifTool();
        const hardenedEvidence = await assertPinnedExifTool(hardenedExifTool);
        assert.deepEqual(hardenedExifTool.options.exiftoolArgs.slice(0, 2), ['-config', '']);
        assert.equal(hardenedExifTool.options.ignoreMinorErrors, false);
        assert.notEqual(hardenedExifTool.options.exiftoolEnv.EXIFTOOL_HOME, hostileConfigDirectory);
        await assert.rejects(
            scanPhotoMetadata({
                exiftool: hardenedExifTool,
                filePath: metadataBearingDerivativePath,
                bytes: metadataBearingBytes,
                scannerVersion: hardenedEvidence.scannerVersion,
                stage: 'public-derivative',
                expectedFormat: 'webp',
                expectedDimensions: { width: 1_067, height: 1_600 },
                policy
            }),
            error => ['metadata-scan-failed', 'derivative-rejected'].includes(error?.code)
        );
    } finally {
        if (hardenedExifTool) {
            await closeExifTool(hardenedExifTool);
        }
        if (previousExifToolHome === undefined) {
            delete process.env.EXIFTOOL_HOME;
        } else {
            process.env.EXIFTOOL_HOME = previousExifToolHome;
        }
    }

    const failedWorkDirectories = [];
    let transformCount = 0;
    await assert.rejects(
        processSyntheticGalleryPhoto(request, {
            observeWorkDirectory: workDirectory => failedWorkDirectories.push(workDirectory),
            transformPhotoDerivative: async options => {
                transformCount += 1;
                if (transformCount === 2) {
                    throw new Error(`${sentinels[4]} ${hostilePhotoPath}`);
                }
                await transformPhotoDerivative(options);
            }
        }),
        error =>
            error?.code === 'processing-failed' &&
            !error.message.includes(sentinels[4]) &&
            !error.message.includes(hostilePhotoPath)
    );
    assert.equal(transformCount, 2);
    assert.equal(await pathExists(failedWorkDirectories[0]), false);

    const cleanupPriorityWorkDirectories = [];
    let cleanupPriorityExifTool;
    await assert.rejects(
        processSyntheticGalleryPhoto(request, {
            observeWorkDirectory: workDirectory => cleanupPriorityWorkDirectories.push(workDirectory),
            createExifTool: () => {
                cleanupPriorityExifTool = createPinnedExifTool();
                return {
                    version: (...args) => cleanupPriorityExifTool.version(...args),
                    readRaw: (...args) => cleanupPriorityExifTool.readRaw(...args),
                    end: async () => {
                        await cleanupPriorityExifTool.end();
                        throw new Error(`${sentinels[4]} cleanup failure`);
                    }
                };
            },
            transformPhotoDerivative: async () => {
                throw new Error(`${sentinels[5]} processing failure`);
            }
        }),
        error =>
            error?.code === 'cleanup-failed' &&
            !error.message.includes(sentinels[4]) &&
            !error.message.includes(sentinels[5])
    );
    assert.equal(await pathExists(cleanupPriorityWorkDirectories[0]), false);

    const wrongFormatWorkDirectories = [];
    await assert.rejects(
        processSyntheticGalleryPhoto(request, {
            observeWorkDirectory: workDirectory => wrongFormatWorkDirectories.push(workDirectory),
            transformPhotoDerivative: async ({ sourceBytes, outputPath }) => {
                await fs.writeFile(outputPath, sourceBytes, { flag: 'wx', mode: 0o600 });
            }
        }),
        error => error?.code === 'derivative-rejected' && !error.message.includes(sentinels[0])
    );
    assert.equal(await pathExists(wrongFormatWorkDirectories[0]), false);

    let wrongVersionClosed = false;
    await assert.rejects(
        processSyntheticGalleryPhoto(request, {
            createExifTool: () => ({
                version: async () => '13.41',
                end: async () => {
                    wrongVersionClosed = true;
                }
            })
        }),
        error => error?.code === 'toolchain-unavailable'
    );
    assert.equal(wrongVersionClosed, true);

    const oversizedBytes = Buffer.alloc(policy.inputLimits.photo.maximumBytes + 1);
    oversizedBytes.set([0xff, 0xd8, 0xff], 0);
    let oversizedDecoderCalled = false;
    await assert.rejects(
        inspectSyntheticPhotoInput({
            bytes: oversizedBytes,
            policy,
            fileName: 'synthetic-oversized-source.jpg',
            declaredMimeType: 'image/jpeg',
            sharpImplementation: () => {
                oversizedDecoderCalled = true;
                throw new Error('The native decoder must not be reached.');
            }
        }),
        error => error?.code === 'input-rejected'
    );
    assert.equal(oversizedDecoderCalled, false);

    let oversizedProcessorToolchainCalled = false;
    let oversizedProcessorDecoderCalled = false;
    await assert.rejects(
        processSyntheticGalleryPhoto({
            ...request,
            sourceBytes: oversizedBytes,
            fileName: 'synthetic-oversized-source.jpg'
        }, {
            policy,
            createExifTool: () => {
                oversizedProcessorToolchainCalled = true;
                return createPinnedExifTool();
            },
            sharpImplementation: () => {
                oversizedProcessorDecoderCalled = true;
                throw new Error('The native decoder must not be reached.');
            }
        }),
        error => error?.code === 'input-rejected'
    );
    assert.equal(oversizedProcessorToolchainCalled, false);
    assert.equal(oversizedProcessorDecoderCalled, false);

    const corruptWorkDirectories = [];
    await assert.rejects(
        processSyntheticGalleryPhoto({
            ...request,
            sourceBytes: Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02])
        }, {
            observeWorkDirectory: workDirectory => corruptWorkDirectories.push(workDirectory)
        }),
        error => ['decoder-rejected', 'input-rejected'].includes(error?.code)
    );
    assert.equal(await pathExists(corruptWorkDirectories[0]), false);

    for (const forbiddenRequest of [
        { ...request, syntheticOnly: false },
        { ...request, destinationSite: 'everyone' },
        { ...request, uploaderName: 'PRIVATE-UPLOADER' },
        { ...request, athleteTags: ['private-athlete'] },
        { ...request, consentReference: 'private-consent' }
    ]) {
        await assert.rejects(
            processSyntheticGalleryPhoto(forbiddenRequest),
            error => error?.code === 'invalid-request'
        );
    }

    let invalidBindingToolchainCalled = false;
    let invalidBindingDecoderCalled = false;
    await assert.rejects(
        processSyntheticGalleryPhoto({
            ...request,
            draftBinding: {
                ...draftBinding,
                draftId: 'bad',
                processingRunId: 'bad'
            }
        }, {
            createExifTool: () => {
                invalidBindingToolchainCalled = true;
                return createPinnedExifTool();
            },
            sharpImplementation: () => {
                invalidBindingDecoderCalled = true;
                throw new Error('The native decoder must not be reached.');
            }
        }),
        error => error?.code === 'invalid-request'
    );
    assert.equal(invalidBindingToolchainCalled, false);
    assert.equal(invalidBindingDecoderCalled, false);
} finally {
    if (fixtureExifTool) {
        await closeExifTool(fixtureExifTool);
    }
    await fs.rm(fixtureDirectory, { recursive: true, force: true });
}

console.log('Gallery media synthetic photo processor tests passed.');

function stripDerivativePayloads(result) {
    return {
        ...result,
        derivatives: result.derivatives.map(({ payload, ...evidence }) => evidence)
    };
}

async function derivativePayloadBytes(derivative) {
    return Buffer.from(await derivative.payload.arrayBuffer());
}

async function pathExists(candidate) {
    if (!candidate) {
        return false;
    }
    try {
        await fs.access(candidate);
        return true;
    } catch {
        return false;
    }
}

function makeDraftId(character) {
    return `draft_${character.repeat(8)}-${character.repeat(4)}-4${character.repeat(3)}-` +
        `8${character.repeat(3)}-${character.repeat(12)}`;
}

function makeRunId(character) {
    return `run_${character.repeat(12)}4${character.repeat(3)}8${character.repeat(15)}`;
}

async function loadMediaPolicy() {
    const module = await import('../gallery-media-policy.js');
    return module.default || module;
}
