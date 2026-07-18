import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.resolve(process.env.PREVIEW_OUTPUT_DIR || path.join(repoRoot, 'test-artifacts', 'preview-site'));

const runtimeEntries = [
    'index.html',
    'championships.html',
    'hall-of-fame.html',
    'records.html',
    'overview.html',
    'athlete.html',
    'site.css',
    'site-navigation.js',
    'athlete.css',
    'athlete.js',
    'leaderboard.js',
    'records.js',
    'utils.js',
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

for (const requiredFile of ['index.html', 'championships.html', 'hall-of-fame.html', 'records.html', 'overview.html', 'athlete.html', 'records.js', 'data/family/webtables.csv', 'data/everyone/webtables.csv', 'data/family/absolute_records.csv', 'data/everyone/absolute_records.csv']) {
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
        /\.(xlsm|xlsx|xls|xlsb)$/i.test(lowerName),
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
