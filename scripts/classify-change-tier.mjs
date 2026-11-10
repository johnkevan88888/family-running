// Which tier a Pull Request's diff falls into, and why.
//
// This decides regression scope only. It grants nothing: not consent, not
// permission to publish, not a release pathway. The full suite remains the
// required check, and this runs as a second advisory job that reports what a
// narrowed run would have been and whether it would have passed. Until that
// has agreed with the required job over many Pull Requests, its answer is
// evidence and nothing else.
//
// Everything it cannot narrow with a reviewed reason becomes `full`. That is
// the default rather than a fallback: `scripts/change-tiers.mjs` holds claims
// that a smaller set suffices, and where no claim covers the diff there is no
// reason to believe one.

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    checksForTier,
    fullTierReasons,
    maximumNarrowedFileCount
} from './change-tiers.mjs';
import { isPublishingControlPath } from './published-site-entries.mjs';
import {
    isLightweightDataRefresh,
    listDataCsvFiles,
    normalizePath,
    readCsvMetadata
} from './validate-pr-release-path.mjs';

const DATA_CSV_PATH = /^data\/(?:[^/]+\/)*[^/]+\.csv$/i;
const DECIDES_WHAT_RUNS = /^(?:scripts|tests|\.github)\//;
const reasonSet = new Set(fullTierReasons);

/** A `full` verdict, with a reason from the bounded list. */
function full(reason) {
    return { tier: 'full', reason: reasonSet.has(reason) ? reason : 'unmatched' };
}

/**
 * Classify one diff.
 *
 * `changedEntries` is `[{ status, path }]` with statuses as `git diff
 * --name-status` reports them. `csvMetadata` and `expectedDataCsvFiles` are the
 * same inputs the release-path gate uses, so the data tier and the lightweight
 * release pathway agree by construction rather than by coincidence.
 */
export function assessChangeTier({
    changedEntries = [],
    csvMetadata = new Map(),
    expectedDataCsvFiles = null,
    registeredChecks = null
}) {
    if (!Array.isArray(changedEntries)) {
        return full('diff-inputs');
    }
    if (changedEntries.length === 0) {
        // An empty diff means the inputs are wrong, not that nothing needs
        // checking. A Pull Request always changes something.
        return full('empty-diff');
    }
    if (changedEntries.length > maximumNarrowedFileCount) {
        return full('diff-too-large');
    }

    for (const entry of changedEntries) {
        if (!entry || typeof entry.path !== 'string' || typeof entry.status !== 'string') {
            return full('diff-inputs');
        }

        const file = normalizePath(entry.path);

        if (!file || file.startsWith('/') || file.split('/').includes('..') || /^[A-Za-z]:/.test(file)) {
            return full('malformed-path');
        }
        // A rename can move a file between published and unpublished in one
        // step, so it is never narrowed even though git reports it as one entry.
        if (entry.status.startsWith('R')) {
            return full('rename');
        }
        // A deletion can break a check that never reads the file -- one that
        // lists the directory, or asserts the file exists.
        if (entry.status.startsWith('D')) {
            return full('deletion');
        }
        if (!['A', 'M'].includes(entry.status)) {
            return full('unsupported-status');
        }
    }

    const files = [...new Set(changedEntries.map(entry => normalizePath(entry.path)))].sort();

    if (files.some(isPublishingControlPath)) {
        return full('publishing-control');
    }
    if (files.some(file => DECIDES_WHAT_RUNS.test(file))) {
        return full('decides-what-runs');
    }

    // The data tier first, because a complete refresh legitimately carries
    // `gallery-admin/generated/catalog-snapshot.js` and would otherwise be read
    // as a gallery-admin change -- which is how the first version of this
    // classifier sent every real refresh through the private media pipeline.
    const dataCsvFiles = files.filter(file => DATA_CSV_PATH.test(file));

    if (dataCsvFiles.length > 0) {
        const refresh = isLightweightDataRefresh({
            changedFiles: files,
            csvMetadata,
            expectedDataCsvFiles
        });

        // A partial bundle is not a cheaper refresh, it is a broken one.
        return refresh ? narrowed('data', registeredChecks) : full('incomplete-bundle');
    }

    // Everything else falls to the full suite. A gallery-editorial tier and a
    // runtime tier were designed, declared, and then found unsafe by the read
    // audit -- 9 and 55 holes respectively -- so they are not offered here
    // until they have been audited and mutation-tested as the data tier has.
    return full('unmatched');
}

/**
 * A narrowed tier, unless it would run everything anyway -- in which case say
 * so rather than reporting a saving that does not exist.
 */
function narrowed(tier, registeredChecks) {
    const checks = checksForTier(tier, registeredChecks);

    if (!checks) {
        return full('unmatched');
    }
    if (registeredChecks && checks.length >= registeredChecks.length) {
        return full('no-saving');
    }

    return { tier, reason: null };
}

/**
 * The registered checks as COMMANDS, read from the runner's own list.
 *
 * The arguments matter, and dropping them is not cosmetic: the suite registers
 * `['scripts/build-gallery-admin-catalog.mjs', '--check']`,
 * `['scripts/sync-vendor.mjs', '--check']` and
 * `['scripts/sync-private-face-detector.mjs', '--check']`. Run without
 * `--check`, those scripts REGENERATE what they are meant to be verifying, so a
 * runner that spawns the bare path turns three checks into three silent
 * rewrites of the working tree.
 */
export function readRegisteredCheckCommands(repoRoot) {
    const source = readFileSync(path.join(repoRoot, 'scripts', 'run-all-tests.mjs'), 'utf8');
    const body = source.slice(source.indexOf('const repositoryChecks = ['), source.indexOf(String.fromCharCode(10) + '];'));
    const commands = [];

    for (const fragment of body.split("    ['").slice(1)) {
        const after = fragment.slice(fragment.indexOf("', ["));
        const args = after.slice(after.indexOf('[') + 1, after.indexOf(']'))
            .split(',')
            .map(part => part.trim().replace(/^'|'$/g, ''))
            .filter(Boolean);

        commands.push({ script: args[0], args });
    }

    return commands;
}

/** Just the script paths, which is what a tier declaration names. */
export function readRegisteredChecks(repoRoot) {
    return readRegisteredCheckCommands(repoRoot).map(command => command.script);
}

/** The diff between two commits, as `[{ status, path }]`. */
export function readChangedEntries(baseSha, headSha) {
    const output = execFileSync(
        'git',
        ['diff', '--name-status', '-z', `${baseSha}...${headSha}`],
        { encoding: 'utf8' }
    );
    const parts = output.split('\0').filter(Boolean);
    const entries = [];

    for (let index = 0; index < parts.length; index += 1) {
        const status = parts[index];

        // A rename or copy is reported as status, old path, new path. Both
        // paths are consumed so the next status is read from the right place.
        if (/^[RC]/.test(status)) {
            entries.push({ status, path: parts[index + 2] || parts[index + 1] || '' });
            index += 2;
            continue;
        }

        entries.push({ status, path: parts[index + 1] || '' });
        index += 1;
    }

    return entries;
}

const thisPath = fileURLToPath(import.meta.url);

if (process.argv[1] && path.resolve(process.argv[1]) === thisPath) {
    const repoRoot = path.resolve(path.dirname(thisPath), '..');
    const baseSha = process.env.PR_BASE_SHA;
    const headSha = process.env.PR_HEAD_SHA;
    let verdict;

    if (!/^[0-9a-f]{40}$/.test(baseSha || '') || !/^[0-9a-f]{40}$/.test(headSha || '')) {
        verdict = full('diff-inputs');
    } else {
        try {
            const changedEntries = readChangedEntries(baseSha, headSha);
            const files = changedEntries.map(entry => normalizePath(entry.path));

            verdict = assessChangeTier({
                changedEntries,
                csvMetadata: readCsvMetadata(baseSha, headSha, files),
                expectedDataCsvFiles: listDataCsvFiles(headSha),
                registeredChecks: readRegisteredChecks(repoRoot)
            });
        } catch {
            // A classifier that cannot read the diff knows nothing about it.
            verdict = full('diff-inputs');
        }
    }

    const checks = checksForTier(verdict.tier, readRegisteredChecks(repoRoot));

    console.log(`tier=${verdict.tier}`);
    console.log(`reason=${verdict.reason ?? 'narrowed'}`);
    console.log(`checks=${checks ? checks.length : readRegisteredChecks(repoRoot).length}`);

    if (process.env.GITHUB_OUTPUT) {
        appendFileSync(process.env.GITHUB_OUTPUT,
            `tier=${verdict.tier}\nreason=${verdict.reason ?? 'narrowed'}\n`);
    }
}
