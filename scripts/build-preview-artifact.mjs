import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from './export-bundle-tools.mjs';
import {
    findAssetProblems,
    findDataBundleProblems,
    findGalleryDataProblems,
    findUnpublishablePublicationEntryProblems,
    findVendorProblems,
    resolvePreviewOutputDir
} from './preview-artifact-contract.mjs';
import { publishedSiteEntries } from './published-site-entries.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Resolved before anything is deleted. `fs.rm` below is recursive and forced, so
// an unchecked PREVIEW_OUTPUT_DIR would silently destroy the repository root,
// tracked `data/`, or any parent directory. The gate is fail-closed: only a
// canonical absolute path inside the managed, Git-ignored artifact directory is
// accepted.
let outputDir;

try {
    outputDir = resolvePreviewOutputDir(process.env.PREVIEW_OUTPUT_DIR);
} catch (error) {
    console.error(`Refusing to build the preview artifact: ${error.message}`);
    process.exit(1);
}

// The publishable site: everything the browser needs and nothing else. This
// artifact is what GitHub Pages serves in production and what Netlify serves for
// previews, so anything absent here is simply not on the public web. Repository
// documentation, scripts, tests, and configuration are deliberately excluded.
// The list lives in published-site-entries.mjs because the release-path
// validator needs the same definition of "reaches visitors".
const runtimeEntries = publishedSiteEntries;

const publicationEntryProblems = findUnpublishablePublicationEntryProblems(runtimeEntries);
if (publicationEntryProblems.length) {
    console.error('Refusing to build a publication allowlist that includes repository-only files:');
    for (const problem of publicationEntryProblems) {
        console.error(`- ${problem}`);
    }
    process.exit(1);
}

await fs.rm(outputDir, { recursive: true, force: true });
await fs.mkdir(outputDir, { recursive: true });

for (const entry of runtimeEntries) {
    const source = path.join(repoRoot, entry);
    const destination = path.join(outputDir, entry);

    await fs.cp(source, destination, {
        recursive: true,
        force: true,
        errorOnExist: false
    });
}

await fs.writeFile(path.join(outputDir, '.nojekyll'), '', 'utf8');

const copiedFiles = await listFiles(outputDir);
const safetyProblems = copiedFiles
    .map(file => path.relative(outputDir, file).replace(/\\/g, '/'))
    .filter(isForbiddenPreviewFile);

if (safetyProblems.length) {
    console.error('Preview artifact contains forbidden files:');
    for (const problem of safetyProblems) {
        console.error(`- ${problem}`);
    }
    process.exit(1);
}

// This artifact is the public web root, so repository documentation, tooling,
// and configuration must never appear in it. The copy above is whitelist-based,
// but this repeats the same shared guard against the files actually copied.
const publishedPaths = copiedFiles.map(file =>
    path.relative(outputDir, file).replace(/\\/g, '/')
);
const leakedFiles = findUnpublishablePublicationEntryProblems(publishedPaths);

if (leakedFiles.length) {
    console.error('Published artifact contains repository files that must not be public:');
    for (const leaked of leakedFiles) {
        console.error(`- ${leaked}`);
    }
    process.exit(1);
}

// `data/`, `vendor/`, `assets/`, and `gallery-data/` are copied as whole
// directories, so the
// whitelist above says nothing about their contents. Each is checked against
// its own contract instead: `data/` against the export manifest that defines
// one complete CSV bundle, `vendor/` against the exact set of pinned browser
// libraries, and `assets/` against the brand-image shape it is allowed to take.
// Anything else in any of them would be published at its path.
const contractProblems = [
    ...findDataBundleProblems(publishedPaths, await readPublishedManifest()),
    ...findVendorProblems(publishedPaths),
    ...findAssetProblems(publishedPaths),
    ...findGalleryDataProblems(publishedPaths)
];

if (contractProblems.length) {
    console.error('Published artifact does not match its published-content contracts:');
    for (const problem of contractProblems) {
        console.error(`- ${problem}`);
    }
    process.exit(1);
}

for (const requiredFile of ['CNAME', 'robots.txt', 'index.html', 'championships.html', 'hall-of-fame.html', 'records.html', 'gallery.html', 'calculator.html', 'overview.html', 'athlete.html', 'analytics.js', 'records.js', 'gallery.css', 'gallery-contract.js', 'gallery.js', 'calculator.js', 'gallery-data/family.json', 'gallery-data/everyone.json', 'gallery-data/hidden-athlete-ids.json', 'assets/brand/ace-of-race-mark.svg', 'assets/brand/favicon-32.png', 'assets/brand/apple-touch-icon.png', 'assets/brand/og-image.png', 'vendor/chart.umd.min.js', 'vendor/chartjs-adapter-date-fns.bundle.min.js', 'data/family/webtables.csv', 'data/everyone/webtables.csv', 'data/family/absolute_records.csv', 'data/everyone/absolute_records.csv']) {
    try {
        await fs.access(path.join(outputDir, requiredFile));
    } catch {
        console.error(`Preview artifact is missing required file: ${requiredFile}`);
        process.exit(1);
    }
}

console.log(`Preview artifact created at ${path.relative(repoRoot, outputDir)} (${copiedFiles.length} files).`);

// Read from the artifact rather than the repository, so the contract is checked
// against what would actually be served.
async function readPublishedManifest() {
    try {
        return parseCsv(
            await fs.readFile(path.join(outputDir, 'data', 'export_manifest.csv'), 'utf8')
        );
    } catch {
        console.error('Published artifact is missing data/export_manifest.csv.');
        process.exit(1);
    }
}

async function listFiles(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            files.push(...await listFiles(fullPath));
        } else if (entry.isFile()) {
            files.push(fullPath);
        }
    }

    return files;
}

function isForbiddenPreviewFile(relativePath) {
    const basename = path.basename(relativePath);
    const lowerName = basename.toLowerCase();
    const lowerPath = relativePath.toLowerCase();

    return [
        /\.(xlsm|xlsx|xls|xlsb|xlam)$/i.test(lowerName),
        /\.(bas|cls|frm|frx)$/i.test(lowerName),
        basename.startsWith('~$'),
        lowerName === '.env',
        /^\.env\./.test(lowerName),
        /\.(pem|key|p12|pfx)$/i.test(lowerName),
        lowerName === 'credentials.json',
        /^client_secret.*\.json$/.test(lowerName),
        /^service[-_]?account.*\.json$/.test(lowerName),
        /(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/.test(lowerPath),
        /password/.test(lowerName),
        /private[-_]?key/.test(lowerName)
    ].some(Boolean);
}
