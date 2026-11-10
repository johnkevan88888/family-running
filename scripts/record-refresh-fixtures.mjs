// Re-records `tests/fixtures/real-data-refreshes.json` from the real merged
// refresh Pull Requests.
//
// The tier classifier's whole purpose is the routine refresh, so its test is
// pinned to diffs that actually happened rather than to a synthetic list
// somebody wrote to match the classifier. Run this when the bundle changes size
// or a newer refresh should replace an older one, and review the diff: a change
// to this file is a change to what "a routine refresh looks like".
//
// It reads git only. It cannot classify, validate, promote or publish anything.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(repoRoot, 'tests', 'fixtures', 'real-data-refreshes.json');

// Pull Request number, then any revision git can resolve for its base and head.
const refreshPullRequests = [
    [160, '54a0ac162', '194c241ca'],
    [162, '5a0df1db4', '67eb816c9'],
    [166, 'aec25ffa7', '7df6e3663']
];

const refreshes = refreshPullRequests.map(([pullRequest, base, head]) => {
    const baseSha = resolve(base);
    const headSha = resolve(head);

    return {
        pullRequest,
        baseSha,
        headSha,
        // `--no-renames` so the recorded list is the paths as they stand at
        // head, matching what the classifier is given.
        files: execFileSync('git', ['diff', '--no-renames', '--name-only', `${baseSha}...${headSha}`], {
            cwd: repoRoot,
            encoding: 'utf8'
        }).split('\n').filter(Boolean).sort()
    };
});

writeFileSync(output, `${JSON.stringify({
    note: 'Recorded from the real merged refresh Pull Requests by scripts/record-refresh-fixtures.mjs. A change here is a change to what a routine refresh looks like.',
    refreshes
}, null, 2)}\n`);

console.log(`Recorded ${refreshes.length} real refreshes to ${path.relative(repoRoot, output)}: ` +
    refreshes.map(refresh => `#${refresh.pullRequest} (${refresh.files.length} files)`).join(', ') + '.');

function resolve(revision) {
    return execFileSync('git', ['rev-parse', revision], { cwd: repoRoot, encoding: 'utf8' }).trim();
}
