import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    defaultPreviewOutputDir,
    findAssetProblems,
    findDataBundleProblems,
    findGalleryDataProblems,
    findVendorProblems,
    managedArtifactRoot,
    resolvePreviewOutputDir
} from '../scripts/preview-artifact-contract.mjs';
import { publishedSiteEntries } from '../scripts/published-site-entries.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildScript = path.join(repoRoot, 'scripts', 'build-preview-artifact.mjs');
const trackedDataRoot = path.join(repoRoot, 'data');

// -- The output directory the build is allowed to delete -------------------
//
// `scripts/build-preview-artifact.mjs` starts with a recursive, forced
// `fs.rm(outputDir)`. Before this gate existed, `PREVIEW_OUTPUT_DIR` went
// straight into that call, so a typo or a stray environment variable could have
// deleted the repository, tracked `data/`, or a parent directory outright.

assert.equal(resolvePreviewOutputDir(undefined), defaultPreviewOutputDir);
assert.equal(resolvePreviewOutputDir(''), defaultPreviewOutputDir);
assert.equal(
    resolvePreviewOutputDir(path.join(managedArtifactRoot, 'preview-site-alternate')),
    path.join(managedArtifactRoot, 'preview-site-alternate')
);
assert.equal(
    resolvePreviewOutputDir(path.join(managedArtifactRoot, 'nested', 'deeper')),
    path.join(managedArtifactRoot, 'nested', 'deeper')
);

const rejectedOutputDirs = [
    {
        name: 'repository root',
        value: repoRoot,
        expected: /repository root cannot be used/
    },
    {
        name: 'tracked data',
        value: trackedDataRoot,
        expected: /Tracked data and its descendants/
    },
    {
        name: 'tracked site data',
        value: path.join(trackedDataRoot, 'family'),
        expected: /Tracked data and its descendants/
    },
    {
        name: 'parent of the repository',
        value: path.dirname(repoRoot),
        expected: /outside it/
    },
    {
        name: 'grandparent of the repository',
        value: path.dirname(path.dirname(repoRoot)),
        expected: /outside it/
    },
    {
        name: 'sibling of the repository',
        value: path.join(path.dirname(repoRoot), 'family-running-elsewhere'),
        expected: /outside it/
    },
    {
        name: 'tracked directory outside test-artifacts',
        value: path.join(repoRoot, 'vendor'),
        expected: /outside it/
    },
    {
        name: 'the managed artifact directory itself',
        value: managedArtifactRoot,
        expected: /cannot itself be the preview output directory/
    },
    {
        name: 'relative path',
        value: path.join('test-artifacts', 'preview-site'),
        expected: /nonblank absolute path/
    },
    {
        name: 'relative dot path',
        value: `.${path.sep}test-artifacts${path.sep}preview-site`,
        expected: /nonblank absolute path/
    },
    {
        name: 'traversal out of the managed directory',
        value: `${managedArtifactRoot}${path.sep}..${path.sep}..${path.sep}anywhere`,
        expected: /ambiguous path segment/
    },
    {
        name: 'path with surrounding whitespace',
        value: ` ${defaultPreviewOutputDir}`,
        expected: /without surrounding whitespace/
    },
    {
        name: 'blank path',
        value: '   ',
        expected: /nonblank absolute path/
    }
];

for (const testCase of rejectedOutputDirs) {
    assert.throws(
        () => resolvePreviewOutputDir(testCase.value),
        testCase.expected,
        `Expected the preview output directory "${testCase.name}" to be rejected.`
    );
}

console.log(`PASS - preview output directory containment (${rejectedOutputDirs.length} rejected paths)`);

// The gate above is only worth anything if the build consults it before
// deleting anything. Proving that end to end means actually pointing the build
// at a directory outside the managed artifact root -- so the target is a
// throwaway temporary directory, never the repository. If the gate ever stops
// running before `fs.rm`, this canary disappears and the test fails, without a
// tracked file ever being at risk.
const sacrificialRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'family-running-artifact-guard-'));
const canary = path.join(sacrificialRoot, 'canary.txt');

try {
    await fs.writeFile(canary, 'must survive a refused build\n', 'utf8');

    const refused = await runBuild({ PREVIEW_OUTPUT_DIR: sacrificialRoot });

    assert.notEqual(refused.code, 0, 'The build accepted an output directory outside test-artifacts/.');
    assert.match(refused.output, /Refusing to build the preview artifact/);
    assert.match(refused.output, /outside it/);
    assert.equal(
        await fs.readFile(canary, 'utf8'),
        'must survive a refused build\n',
        'A refused build deleted the directory it refused to use.'
    );
} finally {
    await fs.rm(sacrificialRoot, { recursive: true, force: true });
}

console.log('PASS - the build refuses an out-of-tree output directory before deleting it');

// -- What the artifact is allowed to publish -------------------------------
//
// `data/`, `vendor/`, `assets/`, and `gallery-data/` are copied as whole
// directories, so the build's
// file-by-file whitelist says nothing about their contents. Whatever is in them
// is published at its path on the public web.

const newsRuntimeEntries = ['news.html', 'news.js', 'news.css'];

assert.deepEqual(
    newsRuntimeEntries.filter(entry => !publishedSiteEntries.includes(entry)),
    [],
    'The official-results News page is incomplete in the published runtime contract.'
);

console.log('PASS - the News page is complete in the published runtime contract');

const manifest = [
    ['ExportBundleID', 'ExportedAtUTC', 'SchemaVersion', 'Scope', 'RelativePath', 'DataRowCount'],
    ['B1', '2099-01-01T00:00:00.000Z', '1.0', 'shared', 'data/athlete_results.csv', '3'],
    ['B1', '2099-01-01T00:00:00.000Z', '1.0', 'family', 'data/family/webtables.csv', '4']
];
const contractedBundle = [
    'index.html',
    'data/export_manifest.csv',
    'data/athlete_results.csv',
    'data/family/webtables.csv'
];

assert.deepEqual(findDataBundleProblems(contractedBundle, manifest), []);
assert.deepEqual(
    findDataBundleProblems([...contractedBundle, 'data/family/notes.md'], manifest),
    ['Published data/ contains "data/family/notes.md", which is not part of the exported CSV bundle.']
);
assert.deepEqual(
    findDataBundleProblems([...contractedBundle, 'data/scratch/leftover.csv'], manifest),
    ['Published data/ contains "data/scratch/leftover.csv", which is not part of the exported CSV bundle.']
);
assert.deepEqual(
    findDataBundleProblems([...contractedBundle, 'data/family/~$webtables.csv'], manifest),
    ['Published data/ contains "data/family/~$webtables.csv", which is not part of the exported CSV bundle.']
);
assert.deepEqual(
    findDataBundleProblems(contractedBundle.filter(entry => entry !== 'data/family/webtables.csv'), manifest),
    ['Published data/ is missing "data/family/webtables.csv", which the export manifest contracts.']
);
assert.deepEqual(
    findDataBundleProblems(['index.html'], manifest).length,
    3,
    'A published artifact with no data/ at all should report every contracted file as missing.'
);
assert.match(
    findDataBundleProblems(contractedBundle, [['ExportBundleID', 'Scope']]).join('\n'),
    /has no RelativePath column/
);
assert.match(
    findDataBundleProblems(
        contractedBundle,
        [...manifest, ['B1', '2099-01-01T00:00:00.000Z', '1.0', 'family', 'scripts/build.mjs', '1']]
    ).join('\n'),
    /is not a CSV under data\//
);
// Windows-style separators reach this check through path.relative, so they must
// normalize rather than read as unexpected files.
assert.deepEqual(
    findDataBundleProblems(
        ['index.html', 'data\\export_manifest.csv', 'data\\athlete_results.csv', 'data\\family\\webtables.csv'],
        manifest
    ),
    []
);

console.log('PASS - published data/ must be exactly the contracted CSV bundle');

const vendoredBundle = [
    'index.html',
    'vendor/chart.umd.min.js',
    'vendor/LICENSE-chart.js.md',
    'vendor/chartjs-adapter-date-fns.bundle.min.js',
    'vendor/LICENSE-chartjs-adapter-date-fns.md',
    'vendor/LICENSE-date-fns.md'
];

assert.deepEqual(findVendorProblems(vendoredBundle), []);
assert.deepEqual(
    findVendorProblems([...vendoredBundle, 'vendor/analytics-helper.js']),
    ['Published vendor/ contains "vendor/analytics-helper.js", which is not one of the vendored libraries.']
);
assert.deepEqual(
    findVendorProblems([...vendoredBundle, 'vendor/extra/tracker.min.js']),
    ['Published vendor/ contains "vendor/extra/tracker.min.js", which is not one of the vendored libraries.']
);
assert.deepEqual(
    findVendorProblems(vendoredBundle.filter(entry => entry !== 'vendor/chart.umd.min.js')),
    ['Published vendor/ is missing the vendored library "vendor/chart.umd.min.js".']
);
assert.deepEqual(findVendorProblems(['index.html']).length, 5);

console.log('PASS - published vendor/ must be exactly the vendored library set');

const assetBundle = [
    'index.html',
    'assets/brand/ace-of-race-mark.svg',
    'assets/brand/favicon-32.png',
    'assets/brand/apple-touch-icon.png',
    'assets/brand/og-image.png'
];

assert.deepEqual(findAssetProblems(assetBundle), []);
assert.deepEqual(
    findAssetProblems([...assetBundle, 'assets/brand/tracker.js']),
    ['Published assets/ contains "assets/brand/tracker.js", which is not one of: .svg, .png, .jpg, .jpeg, .webp, .ico, .avif.']
);
assert.deepEqual(
    findAssetProblems([...assetBundle, 'assets/brand/notes.md']),
    ['Published assets/ contains "assets/brand/notes.md", which is not one of: .svg, .png, .jpg, .jpeg, .webp, .ico, .avif.']
);
assert.deepEqual(
    findAssetProblems([...assetBundle, 'assets/brand/README']),
    ['Published assets/ contains "assets/brand/README", which is not one of: .svg, .png, .jpg, .jpeg, .webp, .ico, .avif.']
);
assert.deepEqual(
    findAssetProblems([...assetBundle, 'assets/private/workbook-notes.png']),
    ['Published assets/ contains "assets/private/workbook-notes.png", which is outside assets/brand/.']
);
// Missing assets are caught by the build's required-file list rather than here,
// so an incomplete set is not a contract problem.
assert.deepEqual(findAssetProblems(['index.html']), []);

console.log('PASS - published assets/ must be brand images only');

const galleryDataBundle = [
    'index.html',
    'gallery-data/family.json',
    'gallery-data/everyone.json',
    'gallery-data/hidden-athlete-ids.json'
];

assert.deepEqual(findGalleryDataProblems(galleryDataBundle), []);
assert.deepEqual(
    findGalleryDataProblems([...galleryDataBundle, 'gallery-data/private-original.jpg']),
    ['Published gallery-data/ contains "gallery-data/private-original.jpg", which is not a contracted gallery metadata file.']
);
assert.deepEqual(
    findGalleryDataProblems([...galleryDataBundle, 'gallery-data/notes.md']),
    ['Published gallery-data/ contains "gallery-data/notes.md", which is not a contracted gallery metadata file.']
);
assert.deepEqual(
    findGalleryDataProblems(galleryDataBundle.filter(entry => entry !== 'gallery-data/everyone.json')),
    ['Published gallery-data/ is missing the required metadata file "gallery-data/everyone.json".']
);
assert.deepEqual(findGalleryDataProblems(['index.html']).length, 3);

console.log('PASS - published gallery-data/ must contain only the three contracted metadata files');

// Wiring proof for all contracts: a real build of the real tree, with one
// stray file added to each directory and removed again afterwards.
const buildOutputDir = path.join(managedArtifactRoot, `preview-site-safety-${process.pid}`);
const strayDataFile = path.join(trackedDataRoot, '__artifact-contract-probe__.csv');
const strayVendorFile = path.join(repoRoot, 'vendor', '__artifact-contract-probe__.js');
const strayAssetFile = path.join(repoRoot, 'assets', 'brand', '__artifact-contract-probe__.js');
const strayGalleryFile = path.join(repoRoot, 'gallery-data', '__artifact-contract-probe__.jpg');

try {
    await fs.writeFile(strayDataFile, 'Header,ExportBundleID\r\nValue,PROBE\r\n', 'utf8');

    const strayData = await runBuild({ PREVIEW_OUTPUT_DIR: buildOutputDir });

    assert.notEqual(strayData.code, 0, 'The build published a data/ file that is not in the export manifest.');
    assert.match(strayData.output, /data\/__artifact-contract-probe__\.csv/);
    assert.match(strayData.output, /not part of the exported CSV bundle/);

    await fs.rm(strayDataFile, { force: true });
    await fs.writeFile(strayVendorFile, 'window.__probe = true;\n', 'utf8');

    const strayVendor = await runBuild({ PREVIEW_OUTPUT_DIR: buildOutputDir });

    assert.notEqual(strayVendor.code, 0, 'The build published a vendor/ file no pinned dependency put there.');
    assert.match(strayVendor.output, /vendor\/__artifact-contract-probe__\.js/);
    assert.match(strayVendor.output, /not one of the vendored libraries/);

    await fs.rm(strayVendorFile, { force: true });
    await fs.writeFile(strayAssetFile, 'window.__probe = true;\n', 'utf8');

    const strayAsset = await runBuild({ PREVIEW_OUTPUT_DIR: buildOutputDir });

    assert.notEqual(strayAsset.code, 0, 'The build published a script from the brand assets directory.');
    assert.match(strayAsset.output, /assets\/brand\/__artifact-contract-probe__\.js/);
    assert.match(strayAsset.output, /is not one of/);

    await fs.rm(strayAssetFile, { force: true });
    await fs.writeFile(strayGalleryFile, 'not really an image\n', 'utf8');

    const strayGallery = await runBuild({ PREVIEW_OUTPUT_DIR: buildOutputDir });

    assert.notEqual(strayGallery.code, 0, 'The build published a media file from gallery-data/.');
    assert.match(strayGallery.output, /gallery-data\/__artifact-contract-probe__\.jpg/);
    assert.match(strayGallery.output, /not a contracted gallery metadata file/);

    await fs.rm(strayGalleryFile, { force: true });

    const clean = await runBuild({ PREVIEW_OUTPUT_DIR: buildOutputDir });

    assert.equal(clean.code, 0, `The unmodified tree failed its own contract:\n${clean.output}`);

    for (const entry of newsRuntimeEntries) {
        assert.equal(
            await pathExists(path.join(buildOutputDir, entry)),
            true,
            `The preview artifact is missing the News runtime file "${entry}".`
        );
    }
} finally {
    await fs.rm(strayDataFile, { force: true });
    await fs.rm(strayVendorFile, { force: true });
    await fs.rm(strayAssetFile, { force: true });
    await fs.rm(strayGalleryFile, { force: true });
    await fs.rm(buildOutputDir, { recursive: true, force: true });
}

// The probes are deliberately created inside tracked directories, so leaving one
// behind would look like an export defect to the next person. Prove they are
// gone rather than trusting the cleanup above.
for (const probe of [strayDataFile, strayVendorFile, strayAssetFile, strayGalleryFile]) {
    assert.equal(
        await pathExists(probe),
        false,
        `Test probe was left behind at ${probe}.`
    );
}

console.log('PASS - the artifact build enforces all publication contracts and publishes News and Gallery');
console.log('Preview artifact safety tests passed.');

function runBuild(env) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [buildScript], {
            cwd: repoRoot,
            env: { ...process.env, ...env },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let output = '';

        child.stdout.on('data', chunk => {
            output += chunk;
        });
        child.stderr.on('data', chunk => {
            output += chunk;
        });
        child.on('error', reject);
        child.on('exit', code => resolve({ code, output }));
    });
}

async function pathExists(target) {
    try {
        await fs.access(target);
        return true;
    } catch {
        return false;
    }
}
