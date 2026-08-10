import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.resolve(process.env.PREVIEW_OUTPUT_DIR || path.join(repoRoot, 'test-artifacts', 'preview-site'));

// The publishable site: everything the browser needs and nothing else. This
// artifact is what GitHub Pages serves in production and what Netlify serves for
// previews, so anything absent here is simply not on the public web. Repository
// documentation, scripts, tests, and configuration are deliberately excluded.
const runtimeEntries = [
    // Keeps the www.aceofrace.com custom domain bound when Pages publishes this
    // artifact instead of the repository root. Removing it drops the domain.
    'CNAME',
    // Permissive by design; the noindex meta tag on each page does the work.
    'robots.txt',
    'index.html',
    'championships.html',
    'hall-of-fame.html',
    'records.html',
    'calculator.html',
    'overview.html',
    'athlete.html',
    'site.css',
    'site-navigation.js',
    'analytics.js',
    'athlete.css',
    'athlete.js',
    'leaderboard.js',
    'records.js',
    'calculator.css',
    'calculator.js',
    'utils.js',
    'vendor',
    'data'
];

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
// but this check fails loudly if something non-runtime is ever added to
// runtimeEntries.
const unpublishablePrefixes = [
    'docs/',
    'scripts/',
    'tests/',
    '.github/',
    'AGENTS.md',
    'README.md',
    'package.json',
    'pnpm-lock.yaml',
    'netlify.toml',
    'preview-local.cmd',
    'update-website-data.cmd'
];
const publishedPaths = copiedFiles.map(file =>
    path.relative(outputDir, file).replace(/\\/g, '/')
);
const leakedFiles = publishedPaths.filter(relativePath =>
    unpublishablePrefixes.some(prefix =>
        prefix.endsWith('/') ? relativePath.startsWith(prefix) : relativePath === prefix
    )
);

if (leakedFiles.length) {
    console.error('Published artifact contains repository files that must not be public:');
    for (const leaked of leakedFiles) {
        console.error(`- ${leaked}`);
    }
    process.exit(1);
}

for (const requiredFile of ['CNAME', 'robots.txt', 'index.html', 'championships.html', 'hall-of-fame.html', 'records.html', 'calculator.html', 'overview.html', 'athlete.html', 'analytics.js', 'records.js', 'calculator.js', 'vendor/chart.umd.min.js', 'vendor/chartjs-adapter-date-fns.bundle.min.js', 'data/family/webtables.csv', 'data/everyone/webtables.csv', 'data/family/absolute_records.csv', 'data/everyone/absolute_records.csv']) {
    try {
        await fs.access(path.join(outputDir, requiredFile));
    } catch {
        console.error(`Preview artifact is missing required file: ${requiredFile}`);
        process.exit(1);
    }
}

console.log(`Preview artifact created at ${path.relative(repoRoot, outputDir)} (${copiedFiles.length} files).`);

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
