// Focused regression scope only; it cannot process, consent to, merge or publish
// a photo. The PR workflow independently proves eligibility before selecting it.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const photoReviewChecks = [
    ['Repository safety', ['scripts/validate-repository-safety.mjs']],
    ['Vendored libraries', ['scripts/sync-vendor.mjs', '--check']],
    ['Both-mode CSV bundle', ['scripts/validate-csv.mjs']],
    ['Both-mode Gallery manifests and public races/tags', ['scripts/validate-gallery.mjs']],
    ['Public framing', ['scripts/validate-gallery-podium-framing.mjs']],
    ['Photo-only scope and fallback regressions', ['tests/gallery-photo-review-path.mjs']],
    ['Gallery privacy and suppression', ['tests/gallery-contract.mjs']],
    ['Consent upload contract', ['tests/gallery-upload-contract.mjs']],
    ['Metadata/media policy', ['tests/gallery-media-policy.mjs']],
    ['One-file candidate consent and exclusion contract', ['tests/gallery-manifest-candidate.mjs']],
    ['Whole-photo thumbnails', ['tests/gallery-thumbnail-layout.mjs']],
    ['Exported photo result details', ['tests/gallery-photo-details.mjs']],
    ['Public framing geometry', ['tests/gallery-podium-framing.mjs']],
    ['Framing and suppression browser regressions', ['tests/gallery-podium-framing-browser.mjs']],
    // Sequential: artifact-safety temporarily probes data/; CSV must finish first.
    ['Preview artifact safety', ['tests/preview-artifact-safety.mjs']],
    ['Actual public artifact', ['scripts/build-preview-artifact.mjs']],
    ['Actual-candidate both-mode responsive browser review', ['tests/gallery-photo-review-browser.mjs']]
];

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const started = performance.now();
    for (const [label, args] of photoReviewChecks) {
        console.log(`\n== ${label} ==`);
        await new Promise((resolve, reject) => {
            const env = { ...process.env };
            if (args[0] === 'scripts/build-preview-artifact.mjs') env.PREVIEW_OUTPUT_DIR = path.join(root, 'test-artifacts', 'preview-site');
            if (args[0] === 'tests/gallery-photo-review-browser.mjs') env.SITE_ROOT = path.join(root, 'test-artifacts', 'preview-site');
            const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
            child.on('error', reject);
            child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${args[0]} failed (${code}).`)));
        });
    }
    console.log(`\nAll ${photoReviewChecks.length} photo-only groups passed in ${((performance.now() - started) / 1000).toFixed(1)} seconds. Protected consent/publication gates remain separate.`);
}
