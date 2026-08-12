// Fail-closed rules for the published site artifact.
//
// `scripts/build-preview-artifact.mjs` recursively deletes its output directory
// before rebuilding it, and whatever survives that rebuild becomes the public
// web root for both Netlify previews and GitHub Pages production. Both halves of
// that are dangerous by default, so both are gated here rather than inline:
//
//   * `resolvePreviewOutputDir` decides what may legally be deleted.
//   * `findDataBundleProblems` and `findVendorProblems` decide what may legally
//     be published.
//
// The rules live in their own module so `tests/preview-artifact-safety.mjs` can
// exercise them directly instead of only observing a passing build.
import path from 'node:path';
import {
    repoRoot,
    resolveCanonicalAbsolutePath,
    sameOrDescendantPath,
    samePath
} from './export-bundle-tools.mjs';
import { vendoredLibraryFiles } from './vendored-library-files.mjs';

// Everything this build is allowed to create or destroy lives under here. The
// directory is ignored by Git, so nothing tracked can be inside it.
export const managedArtifactRoot = path.join(repoRoot, 'test-artifacts');
export const defaultPreviewOutputDir = path.join(managedArtifactRoot, 'preview-site');

const manifestRelativePath = 'data/export_manifest.csv';

// The build deletes this directory recursively, so an unchecked
// `PREVIEW_OUTPUT_DIR` is a repository-deleting foot-gun: the repository root,
// tracked `data/`, or any parent directory would all be removed without
// confirmation. Accept only a canonical absolute path strictly inside the
// managed, Git-ignored artifact directory, and reject everything else.
export function resolvePreviewOutputDir(rawValue) {
    const requested = rawValue === undefined || rawValue === null || rawValue === ''
        ? defaultPreviewOutputDir
        : String(rawValue);
    const outputDir = resolveCanonicalAbsolutePath(requested, 'preview output directory');
    const trackedDataRoot = path.join(repoRoot, 'data');

    if (samePath(outputDir, repoRoot)) {
        throw new Error(
            'The repository root cannot be used as the preview output directory.'
        );
    }
    if (sameOrDescendantPath(outputDir, trackedDataRoot)) {
        throw new Error(
            'Tracked data and its descendants cannot be used as the preview output directory.'
        );
    }
    if (samePath(outputDir, managedArtifactRoot)) {
        throw new Error(
            `The managed artifact directory ${managedArtifactRoot} cannot itself be the preview output directory.`
        );
    }
    if (!sameOrDescendantPath(outputDir, managedArtifactRoot)) {
        throw new Error(
            `The preview output directory must be inside ${managedArtifactRoot}; "${outputDir}" is outside it.`
        );
    }

    return outputDir;
}

// `data/export_manifest.csv` is the export-completion contract, so it also
// defines exactly which CSVs belong on the public web. Anything else that
// reaches `data/` in the artifact -- a scratch file, an editor backup, a
// half-removed export -- is published at its path, so the build must refuse it.
export function findDataBundleProblems(publishedPaths, manifestRows) {
    const published = publishedPaths
        .map(normalizeArtifactPath)
        .filter(entry => entry === 'data' || entry.startsWith('data/'));
    const headers = (manifestRows[0] || []).map(header => String(header).trim());
    const pathIndex = headers.indexOf('RelativePath');

    if (pathIndex < 0) {
        return [
            `${manifestRelativePath} has no RelativePath column, so the published CSV bundle cannot be verified.`
        ];
    }

    const problems = [];
    const expected = new Set([manifestRelativePath]);

    for (const row of manifestRows.slice(1)) {
        const relativePath = normalizeArtifactPath(row[pathIndex] || '');

        if (!relativePath) {
            continue;
        }
        if (!relativePath.startsWith('data/') || !relativePath.toLowerCase().endsWith('.csv')) {
            problems.push(
                `${manifestRelativePath} lists "${relativePath}", which is not a CSV under data/.`
            );
            continue;
        }

        expected.add(relativePath);
    }

    for (const relativePath of published) {
        if (!expected.has(relativePath)) {
            problems.push(
                `Published data/ contains "${relativePath}", which is not part of the exported CSV bundle.`
            );
        }
    }

    for (const relativePath of expected) {
        if (!published.includes(relativePath)) {
            problems.push(
                `Published data/ is missing "${relativePath}", which the export manifest contracts.`
            );
        }
    }

    return problems.sort();
}

// `vendor/` exists so the public site never loads runtime code from a
// third-party CDN. That guarantee is only worth anything if every file in it
// came from a pinned dependency, so publish exactly the vendored set and
// nothing else.
export function findVendorProblems(publishedPaths) {
    const published = publishedPaths
        .map(normalizeArtifactPath)
        .filter(entry => entry === 'vendor' || entry.startsWith('vendor/'));
    const expected = vendoredLibraryFiles.map(file => `vendor/${file.target}`);
    const problems = [];

    for (const relativePath of published) {
        if (!expected.includes(relativePath)) {
            problems.push(
                `Published vendor/ contains "${relativePath}", which is not one of the vendored libraries.`
            );
        }
    }

    for (const relativePath of expected) {
        if (!published.includes(relativePath)) {
            problems.push(
                `Published vendor/ is missing the vendored library "${relativePath}".`
            );
        }
    }

    return problems.sort();
}

// `assets/` is the third directory copied whole, so the same gap applies: the
// file whitelist says nothing about what is inside it. These are hand-curated
// brand images rather than generated or dependency-derived files, so the
// contract is a shape rather than an exact list -- images and vector art only,
// under `assets/brand/`. A stylesheet, script, or document appearing here would
// be served from the public web root without ever passing a review that
// expected it to.
const allowedAssetExtensions = ['.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico', '.avif'];

export function findAssetProblems(publishedPaths) {
    const published = publishedPaths
        .map(normalizeArtifactPath)
        .filter(entry => entry === 'assets' || entry.startsWith('assets/'));
    const problems = [];

    for (const relativePath of published) {
        if (!relativePath.startsWith('assets/brand/')) {
            problems.push(
                `Published assets/ contains "${relativePath}", which is outside assets/brand/.`
            );
            continue;
        }

        const extension = relativePath.slice(relativePath.lastIndexOf('.')).toLowerCase();

        if (!relativePath.includes('.') || !allowedAssetExtensions.includes(extension)) {
            problems.push(
                `Published assets/ contains "${relativePath}", which is not one of: ${allowedAssetExtensions.join(', ')}.`
            );
        }
    }

    return problems.sort();
}

function normalizeArtifactPath(value) {
    return String(value || '')
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/^\/+/, '');
}
