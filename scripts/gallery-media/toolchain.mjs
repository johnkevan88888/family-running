import { createRequire } from 'node:module';
import path from 'node:path';

import { ExifTool } from 'exiftool-vendored';
import sharp from 'sharp';

import toolchainContract from '../gallery-media-toolchain.json' with { type: 'json' };
import { processingError } from './errors.mjs';

const require = createRequire(import.meta.url);
const allowedContractKeys = new Set(['schemaVersion', 'scope', 'photo', 'video']);
const allowedPhotoKeys = new Set([
    'enabled',
    'sharpPackageVersion',
    'sharpRuntimeVersion',
    'libvipsRuntimeVersion',
    'webpRuntimeVersion',
    'pngRuntimeVersion',
    'mozjpegRuntimeVersion',
    'exifRuntimeVersion',
    'exiftoolVendoredPackageVersion',
    'exiftoolPlatformPackageVersion',
    'exiftoolRuntimeVersion'
]);
const allowedVideoKeys = new Set([
    'enabled',
    'requiredFfmpegRuntimeVersion',
    'requiredFfprobeRuntimeVersion',
    'runnerDigest'
]);

validateContractShape(toolchainContract);

export const galleryMediaToolchain = deepFreeze(structuredClone(toolchainContract));

export function configurePinnedSharp(sharpImplementation = sharp) {
    try {
        sharpImplementation.cache(false);
        sharpImplementation.concurrency(1);
        sharpImplementation.simd(false);
    } catch {
        throw processingError('toolchain-unavailable');
    }
}

export function assertPinnedSharp(sharpImplementation = sharp) {
    const expected = galleryMediaToolchain.photo;
    const versions = sharpImplementation?.versions;

    if (
        expected.enabled !== true ||
        !versions ||
        versions.sharp !== expected.sharpRuntimeVersion ||
        versions.vips !== expected.libvipsRuntimeVersion ||
        versions.webp !== expected.webpRuntimeVersion ||
        versions.png !== expected.pngRuntimeVersion ||
        versions.mozjpeg !== expected.mozjpegRuntimeVersion ||
        versions.exif !== expected.exifRuntimeVersion
    ) {
        throw processingError('toolchain-unavailable');
    }

    const sharpPackage = loadResolvedPackage('sharp');
    if (sharpPackage?.version !== expected.sharpPackageVersion) {
        throw processingError('toolchain-unavailable');
    }

    return Object.freeze({
        scannerName: 'sharp',
        scannerVersion: versions.sharp,
        libvipsVersion: versions.vips,
        webpVersion: versions.webp,
        pngVersion: versions.png
    });
}

export function createPinnedExifTool() {
    const expected = galleryMediaToolchain.photo;
    const parentEntry = safeResolve('exiftool-vendored');
    const parentPackage = safeRequire('exiftool-vendored/package.json');
    const platformPackageName = process.platform === 'win32'
        ? 'exiftool-vendored.exe'
        : 'exiftool-vendored.pl';
    const resolutionPaths = parentEntry
        ? { paths: [path.dirname(parentEntry)] }
        : undefined;
    const platformPackagePath = safeResolve(`${platformPackageName}/package.json`, resolutionPaths);
    const platformEntry = safeResolve(platformPackageName, resolutionPaths);
    const platformPackage = platformPackagePath ? safeRequire(platformPackagePath) : null;
    const platformExport = platformEntry ? safeRequire(platformEntry) : null;
    const executablePath = platformExport?.default || platformExport;

    if (
        parentPackage?.version !== expected.exiftoolVendoredPackageVersion ||
        platformPackage?.version !== expected.exiftoolPlatformPackageVersion ||
        typeof executablePath !== 'string' ||
        executablePath.trim() === ''
    ) {
        throw processingError('toolchain-unavailable');
    }

    try {
        return new ExifTool({
            exiftoolPath: executablePath,
            maxProcs: 1,
            maxTasksPerProcess: 50,
            taskRetries: 0,
            spawnTimeoutMillis: 30_000,
            taskTimeoutMillis: 20_000,
            disposalTimeoutMs: 1_000,
            asyncDisposalTimeoutMs: 5_000,
            ignoreMinorErrors: false,
            readArgs: [],
            exiftoolArgs: ['-config', '', '-stay_open', 'True', '-@', '-'],
            exiftoolEnv: {
                EXIFTOOL_HOME: process.platform === 'win32'
                    ? 'C:\\__family_running_no_exiftool_config__'
                    : '/__family_running_no_exiftool_config__',
                LC_ALL: 'C',
                TZ: 'UTC'
            }
        });
    } catch {
        throw processingError('toolchain-unavailable');
    }
}

export async function assertPinnedExifTool(exiftool) {
    if (!exiftool || typeof exiftool.version !== 'function') {
        throw processingError('toolchain-unavailable');
    }

    let runtimeVersion;
    try {
        runtimeVersion = await exiftool.version();
    } catch {
        throw processingError('toolchain-unavailable');
    }

    if (runtimeVersion !== galleryMediaToolchain.photo.exiftoolRuntimeVersion) {
        throw processingError('toolchain-unavailable');
    }

    return Object.freeze({
        scannerName: 'exiftool',
        scannerVersion: runtimeVersion
    });
}

export async function closeExifTool(exiftool) {
    if (!exiftool || typeof exiftool.end !== 'function') {
        throw processingError('cleanup-failed');
    }

    try {
        await exiftool.end();
    } catch {
        throw processingError('cleanup-failed');
    }
}

export function assertVideoToolchainAvailable() {
    if (
        galleryMediaToolchain.video.enabled !== true ||
        typeof galleryMediaToolchain.video.runnerDigest !== 'string' ||
        galleryMediaToolchain.video.runnerDigest.trim() === ''
    ) {
        throw processingError('toolchain-unavailable');
    }
}

function validateContractShape(contract) {
    if (!isPlainObject(contract)) {
        throw processingError('toolchain-unavailable');
    }

    rejectUnknownKeys(contract, allowedContractKeys);
    rejectUnknownKeys(contract.photo, allowedPhotoKeys);
    rejectUnknownKeys(contract.video, allowedVideoKeys);

    if (
        contract.schemaVersion !== '1.0' ||
        contract.scope !== 'synthetic-local-phase-d' ||
        contract.photo?.enabled !== true ||
        contract.video?.enabled !== false ||
        contract.video?.runnerDigest !== null
    ) {
        throw processingError('toolchain-unavailable');
    }

    for (const [key, value] of Object.entries(contract.photo)) {
        if (key !== 'enabled' && !isVersionToken(value)) {
            throw processingError('toolchain-unavailable');
        }
    }

    for (const key of ['requiredFfmpegRuntimeVersion', 'requiredFfprobeRuntimeVersion']) {
        if (!isVersionToken(contract.video?.[key])) {
            throw processingError('toolchain-unavailable');
        }
    }
}

function rejectUnknownKeys(value, allowedKeys) {
    if (!isPlainObject(value)) {
        throw processingError('toolchain-unavailable');
    }
    if (Object.keys(value).some(key => !allowedKeys.has(key))) {
        throw processingError('toolchain-unavailable');
    }
}

function isVersionToken(value) {
    return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/.test(value);
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function safeRequire(specifier) {
    try {
        return require(specifier);
    } catch {
        return null;
    }
}

function safeResolve(specifier, options) {
    try {
        return require.resolve(specifier, options);
    } catch {
        return null;
    }
}

function loadResolvedPackage(specifier) {
    const entry = safeResolve(specifier);
    if (!entry) {
        return null;
    }

    let currentDirectory = path.dirname(entry);
    for (let depth = 0; depth < 5; depth += 1) {
        const candidate = safeRequire(path.join(currentDirectory, 'package.json'));
        if (candidate?.name === specifier) {
            return candidate;
        }
        const parentDirectory = path.dirname(currentDirectory);
        if (parentDirectory === currentDirectory) {
            break;
        }
        currentDirectory = parentDirectory;
    }

    return null;
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
        return value;
    }
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
    return value;
}
