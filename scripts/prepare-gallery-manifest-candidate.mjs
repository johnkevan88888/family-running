import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildGalleryAdminCatalog } from './build-gallery-admin-catalog.mjs';
import { repoRoot } from './export-bundle-tools.mjs';
import {
    prepareGalleryManifestCandidate
} from './gallery-media/candidate-manifest.mjs';
import { validateGalleryTree } from './validate-gallery.mjs';

const execFileAsync = promisify(execFile);
const siteModes = Object.freeze(['family', 'everyone']);
const manifestRelativePaths = Object.freeze({
    family: 'gallery-data/family.json',
    everyone: 'gallery-data/everyone.json'
});
const maximumInputBytes = 1024 * 1024;

export async function prepareCandidateManifestInRepository(candidatePackage, options = {}) {
    const root = path.resolve(options.root || repoRoot);
    const manifestsBySite = {};
    const originalTexts = {};

    for (const siteMode of siteModes) {
        const relativePath = manifestRelativePaths[siteMode];
        const fullPath = fixedPathInsideRoot(root, relativePath);
        const stats = await fs.lstat(fullPath);
        if (stats.isSymbolicLink() || !stats.isFile()) {
            throw new Error(`${relativePath}: manifest must be a regular repository file.`);
        }
        await assertNoSymlinkTraversal(root, relativePath, fullPath);

        let text;
        try {
            text = await fs.readFile(fullPath, 'utf8');
            manifestsBySite[siteMode] = JSON.parse(text);
        } catch {
            throw new Error(`${relativePath}: could not read a valid JSON manifest.`);
        }
        originalTexts[siteMode] = text;
    }

    await assertManifestsClean(root);

    const catalogSnapshot = await buildGalleryAdminCatalog(root);
    const result = prepareGalleryManifestCandidate(candidatePackage, {
        catalogSnapshot,
        manifestsBySite,
        replayReceipt: null
    });

    if (!result.changed) {
        return safeResult(result);
    }

    const targetSite = result.targetRelativePath === manifestRelativePaths.family
        ? 'family'
        : result.targetRelativePath === manifestRelativePaths.everyone
            ? 'everyone'
            : '';
    if (!targetSite) {
        throw new Error('Gallery manifest generator returned an unsupported target.');
    }

    const targetPath = fixedPathInsideRoot(root, result.targetRelativePath);
    try {
        const targetStats = await fs.lstat(targetPath);
        if (targetStats.isSymbolicLink() || !targetStats.isFile()) {
            throw new Error(
                `${result.targetRelativePath}: manifest must remain a regular repository file.`
            );
        }
        await assertNoSymlinkTraversal(root, result.targetRelativePath, targetPath);
        await fs.writeFile(targetPath, result.manifestText, 'utf8');

        const problems = await validateGalleryTree(root);
        if (problems.length > 0) {
            throw new Error(
                `Generated Gallery manifest failed repository validation: ${problems.join(' ')}`
            );
        }

        const changedPaths = await galleryManifestDiffPaths(root);
        if (
            changedPaths.length !== 1 ||
            changedPaths[0] !== result.targetRelativePath
        ) {
            throw new Error(
                'Gallery manifest candidate must change exactly its one inherited manifest.'
            );
        }
    } catch (error) {
        await fs.writeFile(targetPath, originalTexts[targetSite], 'utf8');
        throw error;
    }

    return safeResult(result);
}

async function readCandidatePackageFromStdin() {
    const chunks = [];
    let byteCount = 0;

    for await (const chunk of process.stdin) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteCount += bytes.byteLength;
        if (byteCount > maximumInputBytes) {
            throw new Error('Gallery manifest candidate input exceeds the one-megabyte limit.');
        }
        chunks.push(bytes);
    }

    if (byteCount === 0) {
        throw new Error('Gallery manifest candidate package is required on stdin.');
    }

    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw new Error('Gallery manifest candidate package on stdin is not valid JSON.');
    }
}

async function assertManifestsClean(root) {
    const { stdout } = await execFileAsync(
        'git',
        [
            'status',
            '--porcelain=v1',
            '--untracked-files=all',
            '--',
            manifestRelativePaths.family,
            manifestRelativePaths.everyone
        ],
        { cwd: root, windowsHide: true }
    );
    if (stdout.trim()) {
        throw new Error('Gallery manifests must be clean before candidate generation.');
    }
}

async function galleryManifestDiffPaths(root) {
    const { stdout } = await execFileAsync(
        'git',
        [
            'diff',
            '--name-only',
            '--',
            manifestRelativePaths.family,
            manifestRelativePaths.everyone
        ],
        { cwd: root, windowsHide: true }
    );
    return stdout
        .split(/\r?\n/)
        .map(value => value.trim().replace(/\\/g, '/'))
        .filter(Boolean);
}

function fixedPathInsideRoot(root, relativePath) {
    const fullPath = path.resolve(root, ...relativePath.split('/'));
    const relative = path.relative(root, fullPath);
    if (
        !relative ||
        relative.startsWith('..') ||
        path.isAbsolute(relative)
    ) {
        throw new Error('Gallery manifest path escaped the repository root.');
    }
    return fullPath;
}

async function assertNoSymlinkTraversal(root, relativePath, fullPath) {
    const [realRoot, realFile] = await Promise.all([
        fs.realpath(root),
        fs.realpath(fullPath)
    ]);
    const expectedRealFile = path.resolve(realRoot, ...relativePath.split('/'));
    const comparable = value => process.platform === 'win32' ? value.toLowerCase() : value;

    if (comparable(realFile) !== comparable(expectedRealFile)) {
        throw new Error(`${relativePath}: manifest path must not traverse a symbolic link.`);
    }
}

function safeResult(result) {
    return Object.freeze({
        schemaVersion: '1.0',
        targetRelativePath: result.targetRelativePath,
        itemId: result.itemId,
        manifestSha256: result.manifestSha256,
        changed: result.changed
    });
}

async function runCli() {
    if (process.argv.length !== 2) {
        throw new Error(
            'Usage: provide one service-authenticated candidate package on stdin; no destination arguments are accepted.'
        );
    }

    const candidatePackage = await readCandidatePackageFromStdin();
    const result = await prepareCandidateManifestInRepository(candidatePackage);
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invokedPath = process.argv[1]
    ? fileURLToPath(pathToFileURL(path.resolve(process.argv[1])))
    : '';

if (invokedPath && path.resolve(invokedPath) === path.resolve(fileURLToPath(import.meta.url))) {
    try {
        await runCli();
    } catch (error) {
        console.error(`Gallery manifest candidate generation failed: ${error.message}`);
        process.exitCode = 1;
    }
}
