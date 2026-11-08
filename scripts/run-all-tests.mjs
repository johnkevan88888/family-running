import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { assessNodeVersion } from './node-engine.mjs';
import {
    createSuspensionWatch,
    formatSuspensionVerdict,
    suspensionExitCode
} from './suspension-watch.mjs';

// Refuse before spawning a hundred child processes. Without this gate the suite
// reached `tests/gallery-photo-review-bridge.mjs` -- check 59 -- about ten
// minutes in before Node 22 failed to parse its `await using` statement, which
// reads as a failure in that file rather than a wrong Node.
const nodeVersionProblem = assessNodeVersion();

if (nodeVersionProblem) {
    console.error(nodeVersionProblem);
    process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A deliberately narrow test seam. `--self-test <file>` replaces the check list
// and the suspension watch's clock with values read from a JSON file, so
// `tests/suspension-watch.mjs` can drive THIS file and prove its failure path:
// a check that fails while the machine is frozen must exit 75 with an `INVALID:`
// line, not 1. It is a command-line argument rather than an environment
// variable so that nothing ambient can divert a real run -- `node
// scripts/run-all-tests.mjs` with no arguments cannot reach this at all.
//
// Two things keep a self-test run from ever being mistaken for a real one: it is
// refused outright when `CI` is set, and it cannot exit 0. A completed self-test
// exits 70 and says so on its last line, so neither a person reading a log nor
// a script reading an exit code can take it for a verdict on this repository.
const selfTestExitCode = 70;
const selfTestIndex = process.argv.indexOf('--self-test');
const selfTest = selfTestIndex === -1
    ? null
    : JSON.parse(readFileSync(process.argv[selfTestIndex + 1], 'utf8'));

if (selfTest && process.env.CI) {
    console.error(
        "--self-test runs an injected check list; it is a local seam for proving this " +
        "runner's own failure path. In CI the only meaningful run is the real suite, so " +
        'this is refused. Run "node scripts/run-all-tests.mjs" with no arguments.'
    );
    process.exit(1);
}

if (selfTest) {
    console.log('SELF-TEST: running an injected check list against injected clocks. This is not a test run of this repository.');
}

const repositoryChecks = [
    ['Repository safety validation', ['scripts/validate-repository-safety.mjs']],
    ['Node engine declaration consistency', ['tests/node-engine.mjs']],
    ['Browser runtime contract tests', ['tests/browser-runtime.mjs']],
    ['Suspension watch contract tests', ['tests/suspension-watch.mjs']],
    ['Suspension boundary contract tests', ['tests/suspension-boundary.mjs']],
    ['Vendored library validation', ['scripts/sync-vendor.mjs', '--check']],
    ['CSV validation', ['scripts/validate-csv.mjs']],
    ['Gallery validation', ['scripts/validate-gallery.mjs']],
    ['Age-grade master/slave contract tests', ['tests/age-grade-contract.mjs']],
    ['Gallery contract tests', ['tests/gallery-contract.mjs']],
    ['Gallery whole-photo thumbnail layout tests', ['tests/gallery-thumbnail-layout.mjs']],
    ['Championship photo-framing validation', ['scripts/validate-gallery-podium-framing.mjs']],
    ['Championship photo-framing contract and geometry tests', ['tests/gallery-podium-framing.mjs']],
    ['Championship photo-framing editor tests', ['tests/gallery-podium-editor.mjs']],
    ['Championship photo-framing browser tests', ['tests/gallery-podium-framing-browser.mjs']],
    ['Pinned protected face-detector validation', ['scripts/sync-private-face-detector.mjs', '--check']],
    ['Protected face-detector offline vendoring tamper tests', ['tests/gallery-private-face-vendor.mjs']],
    ['Protected face-detector and manual editor browser tests', ['tests/gallery-private-face-browser.mjs']],
    ['Protected framing owner route and asset boundaries', ['tests/gallery-framing-owner-boundaries.mjs']],
    ['Gallery photo result details tests', ['tests/gallery-photo-details.mjs']],
    ['Gallery age-export schema tests', ['tests/gallery-age-export.mjs']],
    ['Gallery upload contract tests', ['tests/gallery-upload-contract.mjs']],
    ['Gallery private roster contract tests', ['tests/gallery-private-roster.mjs']],
    ['Gallery private roster storage and owner-route tests', ['tests/gallery-private-roster-storage.mjs']],
    ['Gallery private asset reservation tests', ['tests/gallery-private-assets.mjs']],
    ['Gallery audited private tag correction tests', ['tests/gallery-private-tags.mjs']],
    ['Gallery internal fresh-consent attempt reservation tests', ['tests/gallery-private-attempts.mjs']],
    ['Gallery protected framing persistence and immutable snapshots', ['tests/gallery-private-framing.mjs']],
    ['Gallery fresh-photo framing processing and review integration', ['tests/gallery-fresh-photo-framing.mjs']],
    ['Gallery framing uploader and actual owner-router integration', ['tests/gallery-framing-uploader-integration.mjs']],
    ['Gallery private photo processing, hide/restore and host verification tests', ['tests/gallery-private-photo-lifecycle.mjs']],
    ['Gallery private archive quarantine tests', ['tests/gallery-private-archive.mjs']],
    ['Gallery protected owner archive intake tests', ['tests/gallery-private-owner-intake.mjs']],
    ['Gallery split archive service authority and HTTP lifecycle tests', ['tests/gallery-private-service-adapter.mjs']],
    ['Gallery archive multipart containment requirements', ['tests/gallery-archive-containment.mjs']],
    ['Gallery bounded promotion-request timeout regression', ['tests/gallery-archive-service-timeout.mjs']],
    ['Gallery processing handoff and privacy-safe failure reporting', ['tests/gallery-archive-handoff.mjs']],
    ['Gallery protected archive review and removal integration', ['tests/gallery-protected-archive-lifecycle.mjs']],
    ['Gallery local terminal archive metadata purge', ['tests/gallery-private-retention.mjs']],
    ['Gallery protected owner/workflow review recovery and publication/purge coordination', ['tests/gallery-private-owner-workflow.mjs']],
    ['Gallery protected batch queue and database guards', ['tests/gallery-batch-storage.mjs']],
    ['Simplified Family uploader permission and saved batch integration', ['tests/gallery-family-uploader.mjs']],
    ['Family save-first private upload and recovery', ['tests/gallery-family-saved-files.mjs']],
    ['Gallery event-filtered runners and per-athlete distances', ['tests/gallery-event-runners.mjs']],
    ['Simplified Family uploader protected route boundaries', ['tests/gallery-family-uploader-boundaries.mjs']],
    ['Simplified Family uploader desktop and mobile journey', ['tests/gallery-family-uploader-browser.mjs']],
    ['Gallery protected batch owner route boundaries', ['tests/gallery-batch-owner.mjs']],
    ['Gallery protected batch exact owner publication requests', ['tests/gallery-batch-publication-owner.mjs']],
    ['Gallery protected batch publication ledger and per-member origins', ['tests/gallery-batch-publication-storage.mjs']],
    ['Gallery protected batch coordinated terminal metadata retirement', ['tests/gallery-batch-coordinated-purge.mjs']],
    ['Gallery protected batch responsive owner browser tests', ['tests/gallery-batch-owner-browser.mjs']],
    ['Gallery exact batch GitHub review and recovery client', ['tests/gallery-batch-github-review.mjs']],
    ['Gallery protected batch review refresh and anchored lifecycle recovery', ['tests/gallery-batch-review-refresh.mjs']],
    ['Gallery protected current-code batch publication continuation', ['tests/gallery-batch-publication-continuation.mjs']],
    ['Gallery protected batch end-to-end processing and removal recovery', ['tests/gallery-batch-protected-workflow.mjs']],
    ['Gallery private visibility and projection tests', ['tests/gallery-private-visibility.mjs']],
    ['Gallery private library browser and SQLite tests', ['tests/gallery-private-library-browser.mjs']],
    ['Gallery additive photo-generation key tests', ['tests/gallery-photo-generation-keys.mjs']],
    ['Gallery media policy tests', ['tests/gallery-media-policy.mjs']],
    ['Gallery photo processor tests', ['tests/gallery-media-processor.mjs']],
    ['Gallery private processing bridge tests', ['tests/gallery-processing-bridge.mjs']],
    ['Gallery photo-only review bridge tests', ['tests/gallery-photo-review-bridge.mjs']],
    ['Gallery photo review invalidation bridge tests', ['tests/gallery-photo-review-invalidation-bridge.mjs']],
    ['Gallery withdrawal finalization bridge tests', ['tests/gallery-withdrawal-finalization-bridge.mjs']],
    ['Gallery finalizer read-only access probe tests', ['tests/gallery-finalizer-access-probe.mjs']],
    ['Gallery withdrawal finalization migration tests', ['tests/gallery-withdrawal-finalization-migration.mjs']],
    ['Gallery withdrawal finalizer service tests', ['tests/gallery-withdrawal-finalizer-service.mjs']],
    ['Gallery withdrawal finalizer Worker tests', ['tests/gallery-withdrawal-finalizer-worker.mjs']],
    ['Gallery photo promotion Worker tests', ['tests/gallery-photo-promotion-worker.mjs']],
    ['Gallery photo promotion configuration tests', ['tests/gallery-photo-promotion-config.mjs']],
    ['Gallery approved-media delivery-contract tests', ['tests/gallery-media-delivery-contract.mjs']],
    ['Gallery public-host verification migration tests', ['tests/gallery-public-host-migration.mjs']],
    ['Gallery photo review reservation migration tests', ['tests/gallery-photo-review-migration.mjs']],
    ['Gallery photo review reservation service tests', ['tests/gallery-photo-review-service.mjs']],
    ['Gallery legacy photo recovery tests', ['tests/gallery-pre-candidate-abandonment.mjs']],
    ['Gallery transition receipt forward-repair tests', ['tests/gallery-transition-receipt-migration.mjs']],
    ['Gallery D1 expression-depth parity tests', ['tests/gallery-d1-expression-depth.mjs']],
    ['Gallery public-host verifier tests', ['tests/gallery-public-host-verifier.mjs']],
    ['Gallery public-host remote rehearsal driver tests', ['tests/gallery-public-host-remote-rehearsal.mjs']],
    ['Gallery public-host remote SQLite/service integration tests', ['tests/gallery-public-host-remote-sqlite-integration.mjs']],
    ['Gallery approved-media lifecycle requirement tests', ['tests/gallery-approved-media-lifecycle.mjs']],
    ['Gallery manifest candidate tests', ['tests/gallery-manifest-candidate.mjs']],
    ['Gallery GitHub review permission-boundary tests', ['tests/gallery-github-review-boundary.mjs']],
    ['Gallery GitHub review client tests', ['tests/gallery-github-review-client.mjs']],
    ['Gallery processing remote-rehearsal Worker tests', ['tests/gallery-processing-rehearsal-worker.mjs']],
    ['Gallery Phase D migration-config tests', ['tests/gallery-phase-d-migration-configs.mjs']],
    ['Gallery Phase D processing-config tests', ['tests/gallery-phase-d-processing-configs.mjs']],
    ['Gallery Phase D remote rehearsal driver tests', ['tests/gallery-phase-d-remote-rehearsal.mjs']],
    ['Gallery storage-key contract tests', ['tests/gallery-storage-keys.mjs']],
    ['Gallery admin catalog snapshot check', ['scripts/build-gallery-admin-catalog.mjs', '--check']],
    ['Gallery admin catalog generation tests', ['tests/gallery-admin-catalog.mjs']],
    ['Gallery administration boundary tests', ['tests/gallery-admin-boundaries.mjs']],
    ['Gallery administration Phase C tests', ['tests/gallery-admin-phase-c.mjs']],
    ['Gallery owner withdrawal and exclusion control tests', ['tests/gallery-admin-withdrawal-controls.mjs']],
    ['Gallery administration browser tests', ['tests/gallery-admin-browser.mjs']],
    ['Analytics configuration tests', ['tests/analytics-config.mjs']],
    ['PR release-path tests', ['tests/pr-release-path.mjs']],
    ['Photo-only review scope and fallback tests', ['tests/gallery-photo-review-path.mjs']],
    ['Photo-only actual-candidate browser tests', ['tests/gallery-photo-review-browser.mjs']],
    ['Simple data-update workflow tests', ['tests/simple-data-update.mjs']],
    ['Isolated data-update workspace tests', ['tests/data-update-workspace.mjs']],
    ['Automatic data-branch refresh and fresh review tests', ['tests/data-update-refresh.mjs']],
    ['Routine data owner-merge policy tests', ['tests/data-update-merge-policy.mjs']],
    ['Pages deployment verification tests', ['tests/pages-deployment-verification.mjs']],
    ['Production data verification tests', ['tests/verify-production-data.mjs']],
    ['Export bundle validation regression tests', ['tests/export-bundle-validation.mjs']],
    ['Staged export workflow regression tests', ['tests/staged-export-workflow.mjs']],
    ['Personal-best reconciliation tests', ['tests/personal-best-reconciliation.mjs']],
    ['Preview artifact safety tests', ['tests/preview-artifact-safety.mjs']],
    ['Preview artifact build', ['scripts/build-preview-artifact.mjs']],
    ['Browser smoke tests', ['tests/browser-smoke.mjs']]
];

const checks = selfTest ? selfTest.checks : repositoryChecks;

// Every check is spawned asynchronously, so this process's event loop is idle
// throughout and the interval keeps firing on schedule. A gap in its firings is
// therefore proof the machine froze, not evidence that a check was slow.
const suspensionWatch = createSuspensionWatch(selfTest ? selfTestWatchOptions(selfTest) : {});
let completed = 0;

try {
    for (const [label, args] of checks) {
        suspensionWatch.setLabel(label);
        console.log(`\n== ${label} ==`);

        try {
            await runNode(args);
        } catch (failure) {
            // Assess BEFORE reporting the failure. A check that failed
            // while the machine was frozen has proved nothing, and this is
            // exactly how the two suspended runs presented: expired waits
            // reading as content faults, investigated for hours as code
            // flakes. Until this existed the rejection went straight out of
            // the loop and exited 1, so the one path that most needed the
            // verdict was the only path that never printed it.
            reportSuspensionAndExit();
            throw failure;
        }

        completed += 1;
        reportSuspensionAndExit();
    }
} finally {
    suspensionWatch.stop();
}

reportSuspensionAndExit();

if (selfTest) {
    // Deliberately not "All checks passed." Nothing about this repository was
    // checked, so the line a log reader looks for must not appear at all.
    console.log('SELF-TEST COMPLETE: the injected check list passed. This is not a result for this repository.');
    process.exit(selfTestExitCode);
}

console.log('\nAll checks passed.');

// A suspended run is neither a pass nor a failure, so it must not be reported
// as either. Checked after every check so the run stops promptly rather than
// spending another half hour producing results nobody can trust.
function reportSuspensionAndExit() {
    const assessment = suspensionWatch.assess();

    if (!assessment) {
        return;
    }

    suspensionWatch.stop();
    console.error('');
    console.error(formatSuspensionVerdict(assessment, { completed, total: checks.length }));
    process.exit(suspensionExitCode);
}

// Only reachable under `--self-test`. The interval is stubbed out, so samples
// come solely from the labelled boundaries and the injected clock sequence IS
// the sample set under test.
function selfTestWatchOptions({ clockSteps = [] }) {
    let index = 0;

    return {
        clocks: () => clockSteps[Math.min(index++, clockSteps.length - 1)] || { wall: 0, mono: 0 },
        setIntervalImpl: () => ({ unref() {} }),
        clearIntervalImpl: () => {}
    };
}

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
