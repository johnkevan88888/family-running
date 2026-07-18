import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const checks = [
    ['Repository safety validation', ['scripts/validate-repository-safety.mjs']],
    ['CSV validation', ['scripts/validate-csv.mjs']],
    ['Export bundle validation regression tests', ['tests/export-bundle-validation.mjs']],
    ['Staged export workflow regression tests', ['tests/staged-export-workflow.mjs']],
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
