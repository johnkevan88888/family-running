// Runs the narrowed set of checks for this change, and nothing else.
//
// Advisory. The full suite remains the required check; this exists so a
// narrowed run can be compared against it on real Pull Requests. A pass here
// proves nothing on its own, and a failure here is a real failure -- the checks
// are the same checks.
//
// Registration order is kept, not recomputed, for the same reason the suite
// keeps it: `scripts/build-preview-artifact.mjs` must run before anything
// served from the artifact, and the runner's own list is where that order is
// already correct.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checksForTier } from './change-tiers.mjs';
import { environmentFor } from './check-lanes.mjs';
import {
    assessChangeTier,
    readChangedEntries,
    readRegisteredCheckCommands,
    readRegisteredChecks
} from './classify-change-tier.mjs';
import { listDataCsvFiles, normalizePath, readCsvMetadata } from './validate-pr-release-path.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registeredChecks = readRegisteredChecks(repoRoot);
const baseSha = process.env.PR_BASE_SHA;
const headSha = process.env.PR_HEAD_SHA;

if (!/^[0-9a-f]{40}$/.test(baseSha || '') || !/^[0-9a-f]{40}$/.test(headSha || '')) {
    console.error('PR_BASE_SHA and PR_HEAD_SHA must both be 40-character commit SHAs.');
    process.exit(1);
}

const changedEntries = readChangedEntries(baseSha, headSha);
const files = changedEntries.map(entry => normalizePath(entry.path));
const verdict = assessChangeTier({
    changedEntries,
    csvMetadata: readCsvMetadata(baseSha, headSha, files),
    expectedDataCsvFiles: listDataCsvFiles(headSha),
    registeredChecks
});
const tierChecks = checksForTier(verdict.tier, registeredChecks);

// Whether this diff is the case the data tier exists for, recorded separately
// from the tier itself: the exit criterion counts real refreshes, not just
// agreements.
const dataRefresh = verdict.tier === 'data';

if (!tierChecks) {
    // Nothing was narrowed, so there is nothing for this job to add.
    console.log(`Tier: full (${verdict.reason}). The required job runs every check; this job runs nothing.`);
    summarise({ tier: 'full', reason: verdict.reason, result: 'not-run', dataRefresh: false, checks: 0, seconds: 0 });
    process.exit(0);
}

// The tier's checks, in the order the suite registers them, and with the
// arguments it registers them with -- three of them verify rather than rewrite
// only because of a `--check` flag.
const ordered = readRegisteredCheckCommands(repoRoot).filter(command => tierChecks.includes(command.script));
const started = Date.now();
const failed = [];

console.log(`Tier: ${verdict.tier} — ${ordered.length} of ${registeredChecks.length} checks.`);
console.log(`Changed files: ${files.length}.`);

for (const [index, command] of ordered.entries()) {
    const check = command.args.join(' ');
    const checkStarted = Date.now();
    const code = await run(command);
    const seconds = ((Date.now() - checkStarted) / 1000).toFixed(1);

    if (code === 0) {
        console.log(`[${index + 1}/${ordered.length}] ${check} — passed in ${seconds}s`);
    } else {
        console.log(`[${index + 1}/${ordered.length}] ${check} — FAILED (exit ${code}) after ${seconds}s`);
        failed.push(check);
    }
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1);

console.log(`\nTier ${verdict.tier}: ${ordered.length - failed.length} of ${ordered.length} passed in ${elapsed}s.`);

summarise({
    tier: verdict.tier,
    reason: verdict.reason,
    result: failed.length > 0 ? 'fail' : 'pass',
    dataRefresh,
    checks: ordered.length,
    seconds: Number(elapsed)
});

if (failed.length > 0) {
    console.error(`Failed: ${failed.join(', ')}`);
    process.exit(1);
}

console.log('The narrowed tier passed. The required full-suite job is the authority on this Pull Request.');

/**
 * One line per run, in a fixed shape, so `scripts/collect-tier-agreement.mjs`
 * can read the Actions history without parsing prose.
 *
 * It carries no paths, no file names and no diff content -- the Actions log for
 * a public repository is public, and the only things here are the Pull Request
 * number, the head SHA that GitHub already shows, and the shape of the
 * decision.
 */
function summarise(fields) {
    const pullRequest = process.env.PR_NUMBER || 'unknown';

    console.log(`CHANGE_TIER_SUMMARY pr=${pullRequest} head=${headSha} tier=${fields.tier} ` +
        `reason=${fields.reason ?? 'narrowed'} result=${fields.result} ` +
        `data_refresh=${fields.dataRefresh} checks=${fields.checks} seconds=${fields.seconds}`);
}

function run(command) {
    return new Promise(resolve => {
        const child = spawn(process.execPath, command.args, {
            cwd: repoRoot,
            env: { ...process.env, ...environmentFor(command.script) },
            stdio: 'inherit',
            windowsHide: true
        });

        child.on('error', () => resolve(-1));
        child.on('close', code => resolve(code ?? 1));
    });
}
