import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Vendored browser libraries are committed so the public site never depends on a
// third-party CDN at runtime. This script is the only supported way to refresh
// them: it copies the exact builds resolved by the pnpm lockfile, so the tracked
// files always correspond to a pinned, reviewable dependency version.
//
//   node scripts/sync-vendor.mjs           refresh vendor/ from node_modules
//   node scripts/sync-vendor.mjs --check   fail if vendor/ has drifted

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorRoot = path.join(repoRoot, 'vendor');
const checkOnly = process.argv.includes('--check');

const vendoredFiles = [
    {
        source: 'chart.js/dist/chart.umd.min.js',
        target: 'chart.umd.min.js'
    },
    {
        source: 'chart.js/LICENSE.md',
        target: 'LICENSE-chart.js.md'
    },
    {
        source: 'chartjs-adapter-date-fns/dist/chartjs-adapter-date-fns.bundle.min.js',
        target: 'chartjs-adapter-date-fns.bundle.min.js'
    },
    {
        source: 'chartjs-adapter-date-fns/LICENSE.md',
        target: 'LICENSE-chartjs-adapter-date-fns.md'
    },
    {
        // date-fns is bundled into the adapter build above, so its licence ships too.
        source: 'date-fns/LICENSE.md',
        target: 'LICENSE-date-fns.md'
    }
];

const problems = [];

if (!checkOnly) {
    fs.mkdirSync(vendorRoot, { recursive: true });
}

for (const file of vendoredFiles) {
    const sourcePath = path.join(repoRoot, 'node_modules', file.source);
    const targetPath = path.join(vendorRoot, file.target);

    if (!fs.existsSync(sourcePath)) {
        problems.push(`missing dependency build: node_modules/${file.source} (run \`pnpm install\`)`);
        continue;
    }

    const sourceContent = fs.readFileSync(sourcePath);

    if (checkOnly) {
        if (!fs.existsSync(targetPath)) {
            problems.push(`vendor/${file.target} is missing`);
            continue;
        }

        if (!fs.readFileSync(targetPath).equals(sourceContent)) {
            problems.push(`vendor/${file.target} does not match node_modules/${file.source}`);
        }

        continue;
    }

    fs.writeFileSync(targetPath, sourceContent);
    console.log(`vendor/${file.target} <- node_modules/${file.source}`);
}

if (problems.length) {
    console.error(checkOnly ? 'Vendored library check failed:' : 'Vendored library sync failed:');
    for (const problem of problems) {
        console.error(`- ${problem}`);
    }
    console.error('Run `pnpm run vendor:sync` after changing a vendored dependency version.');
    process.exit(1);
}

console.log(
    checkOnly
        ? `Vendored libraries match the installed dependencies (${vendoredFiles.length} files checked).`
        : `Vendored ${vendoredFiles.length} files into vendor/.`
);
