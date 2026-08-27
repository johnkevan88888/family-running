import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const checks = [
    ['Repository safety validation', ['scripts/validate-repository-safety.mjs']],
    ['Vendored library validation', ['scripts/sync-vendor.mjs', '--check']],
    ['CSV validation', ['scripts/validate-csv.mjs']],
    ['Gallery validation', ['scripts/validate-gallery.mjs']],
    ['Age-grade master/slave contract tests', ['tests/age-grade-contract.mjs']],
    ['Gallery contract tests', ['tests/gallery-contract.mjs']],
    ['Gallery upload contract tests', ['tests/gallery-upload-contract.mjs']],
    ['Gallery media policy tests', ['tests/gallery-media-policy.mjs']],
    ['Gallery admin catalog snapshot check', ['scripts/build-gallery-admin-catalog.mjs', '--check']],
    ['Gallery admin catalog generation tests', ['tests/gallery-admin-catalog.mjs']],
    ['Gallery administration boundary tests', ['tests/gallery-admin-boundaries.mjs']],
    ['Gallery administration Phase C tests', ['tests/gallery-admin-phase-c.mjs']],
    ['Gallery administration browser tests', ['tests/gallery-admin-browser.mjs']],
    ['Analytics configuration tests', ['tests/analytics-config.mjs']],
    ['PR release-path tests', ['tests/pr-release-path.mjs']],
    ['Simple data-update workflow tests', ['tests/simple-data-update.mjs']],
    ['Pages deployment verification tests', ['tests/pages-deployment-verification.mjs']],
    ['Production data verification tests', ['tests/verify-production-data.mjs']],
    ['Export bundle validation regression tests', ['tests/export-bundle-validation.mjs']],
    ['Staged export workflow regression tests', ['tests/staged-export-workflow.mjs']],
    ['Personal-best reconciliation tests', ['tests/personal-best-reconciliation.mjs']],
    ['Preview artifact safety tests', ['tests/preview-artifact-safety.mjs']],
    ['Preview artifact build', ['scripts/build-preview-artifact.mjs']],
    ['Browser smoke tests', ['tests/browser-smoke.mjs']]
];

for (const [label, args] of checks) {
    console.log(`\n== ${label} ==`);
    await runNode(args);
}

console.log('\nAll checks passed.');

function runNode(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, {
            cwd: repoRoot,
            env: process.env,
            stdio: 'inherit'
        });

        child.on('error', reject);
        child.on('exit', code => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`${args.join(' ')} failed with exit code ${code}`));
            }
        });
    });
}
