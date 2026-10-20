const repository = 'johnkevan88888/family-running';
const shaPattern = /^[0-9a-f]{40}$/;
const catalogue = 'gallery-admin/generated/catalog-snapshot.js';
const dataPaths = ['data', catalogue];
const protectedPaths = new Set([
    '.gitattributes', '.gitmodules', 'package.json', 'pnpm-lock.yaml',
    '.npmrc', '.pnpmfile.cjs', 'pnpmfile.cjs', 'pnpm-workspace.yaml',
    'scripts/workbook-export-contract.json', 'scripts/build-gallery-admin-catalog.mjs',
    'scripts/simple-data-update.mjs', 'scripts/data-update-refresh.mjs',
    'scripts/data-update-merge-policy.mjs', 'scripts/validate-pr-release-path.mjs',
    'scripts/export-bundle-tools.mjs', 'scripts/pages-deployment-verification.mjs',
    'scripts/verify-production-data.mjs', 'scripts/browser-runtime.mjs',
    'scripts/published-site-entries.mjs',
    'update-website-data.cmd', 'gallery-data/hidden-athlete-ids.json', catalogue
]);

export function validateRefreshState(state) {
    if (state.baseCommitSha !== undefined && !shaPattern.test(state.baseCommitSha)) {
        refuse('The saved data base is invalid.');
    }
    if (state.refreshReviewRequired !== undefined && state.refreshReviewRequired !== true) {
        refuse('The saved fresh-review marker is invalid.');
    }
    if (state.refreshReviewRequired && !['refreshing', 'published', 'checked'].includes(state.phase)) {
        refuse('The fresh-review marker belongs to an unfinished published update.');
    }
    if (state.phase !== 'refreshing') {
        if (state.refresh !== undefined) refuse('A refresh journal exists outside its recovery phase.');
        return;
    }
    const journal = state.refresh;
    if (journal?.version !== 1 || journal.previousCommitSha !== state.commitSha ||
        ![journal.previousCommitSha, journal.baseCommitSha, journal.mainCommitSha,
            journal.treeSha].every(value => shaPattern.test(value || '')) ||
        (journal.commitSha !== null && !shaPattern.test(journal.commitSha || '')) ||
        (journal.testedAt !== null && (!journal.commitSha ||
            !Number.isFinite(Date.parse(journal.testedAt)))) || state.refreshReviewRequired !== true) {
        refuse('The saved refresh journal is incomplete or inconsistent.');
    }
}

/**
 * Only a previously published, unchanged data bundle can be refreshed. The
 * journal is saved BEFORE changing the branch, and the old reviewed head stays
 * authoritative until the new commit has passed local tests and reached GitHub.
 * No function here has a PR-merge or production-deployment capability.
 */
export function refreshRoutineDataBranch({
    state, runGit, readMain, readPullRequest, persistState, runTests,
    validateReleasePath, now = () => new Date().toISOString(), logger = console.log
}) {
    validateRefreshState(state);
    if (!['published', 'checked', 'refreshing'].includes(state.phase)) {
        return { state, refreshed: false };
    }
    if (!shaPattern.test(state.commitSha || '') ||
        !/^data\/refresh-[0-9]{8}-[0-9]{6}$/.test(state.branch || '') ||
        !new RegExp(`^https://github\\.com/${repository}/pull/[1-9][0-9]*$`).test(state.pullRequestUrl || '') ||
        !state.productionApprovedAt || !Number.isFinite(Date.parse(state.productionApprovedAt))) {
        refuse('A valid published update and its PUBLISH approval are required.');
    }
    const git = (args, label, options = {}) => runGit(args, { label, quiet: true, ...options });
    const capture = (args, label) => git(args, label).stdout.trim();
    const clean = () => {
        if (capture(['status', '--porcelain', '--untracked-files=all'], 'Check refresh working tree')) {
            refuse('Local changes were retained. Refresh requires a clean working tree; no files were reset or stashed.');
        }
    };
    const parents = commit => capture(['show', '-s', '--format=%P', commit], 'Read commit parents').split(' ').filter(Boolean);
    const ancestor = (first, second) => {
        const result = git(['merge-base', '--is-ancestor', first, second], 'Check commit ancestry', { acceptedStatuses: [0, 1] });
        return result.status === 0;
    };
    const changed = (first, second) => git([
        'diff', '--no-renames', '--name-only', '-z', first, second, '--'
    ], 'Read exact changed paths').stdout.split('\0').filter(Boolean);
    const requireSameData = (first, second) => {
        if (git(['diff', '--quiet', first, second, '--', ...dataPaths],
            'Verify original data bytes', { acceptedStatuses: [0, 1] }).status !== 0) {
            refuse('The original public data or derived catalogue changed. Nothing will be pushed.');
        }
    };
    const validatePlan = (previous, base, target) => {
        if (!ancestor(base, target)) refuse('Main was rewritten or moved backwards; automatic refresh is refused.');
        if (capture(['merge-base', '--all', previous, target], 'Read unique data base') !== base) {
            refuse('The published data branch has unexpected ancestry.');
        }
        const incoming = changed(base, target);
        // Windows checkout paths are case-insensitive; aliases must not evade a guard.
        const outgoing = new Set(changed(base, previous).map(file => file.toLowerCase()));
        const unsafe = incoming.filter(file => {
            const normalized = file.toLowerCase();
            return normalized === 'data' || normalized.startsWith('data/') ||
                protectedPaths.has(normalized) || outgoing.has(normalized);
        });
        if (unsafe.length) {
            refuse(`Main changed data, export/tool contracts, or overlapping files: ${unsafe.join(', ')}. The existing bundle was retained for separate review.`);
        }
        validateReleasePath({ baseCommitSha: base, headCommitSha: previous, state });
        const preview = git(['merge-tree', '--write-tree', previous, target],
            'Preview main integration', { acceptedStatuses: [0, 1] });
        if (preview.status !== 0 || !shaPattern.test(preview.stdout.trim())) {
            refuse('Main cannot be integrated cleanly. No branch, index or working files were changed.');
        }
        return preview.stdout.trim();
    };
    const identity = (pullRequest, allowedHeads) => {
        if (pullRequest?.html_url !== state.pullRequestUrl || pullRequest.title !== state.pullRequestTitle ||
            !/\[skip netlify\]/i.test(pullRequest.title || '') || pullRequest.base?.ref !== 'main' ||
            pullRequest.base?.repo?.full_name !== repository || pullRequest.head?.ref !== state.branch ||
            pullRequest.head?.repo?.full_name !== repository || !allowedHeads.includes(pullRequest.head?.sha) ||
            pullRequest.draft !== false) {
            refuse('GitHub no longer identifies the exact published data Pull Request.');
        }
        if (pullRequest.state !== 'open') {
            if (state.phase !== 'refreshing' && pullRequest.merged === true) return false;
            refuse('The data Pull Request is no longer open; no refresh is permitted.');
        }
        if (pullRequest.auto_merge) refuse('Disable automatic PR merging before refreshing the data branch.');
        return true;
    };
    const main = readMain();
    if (main?.ref !== 'refs/heads/main' || main.object?.type !== 'commit' ||
        !shaPattern.test(main.object?.sha || '')) refuse('The current main commit could not be established.');
    const mainSha = main.object.sha;
    const allowedHeads = [state.commitSha, ...(state.refresh?.commitSha ? [state.refresh.commitSha] : [])];
    if (!identity(readPullRequest(state), allowedHeads)) return { state, refreshed: false };
    const origin = capture(['remote', 'get-url', 'origin'], 'Verify fixed repository remote');
    if (![ `https://github.com/${repository}`, `https://github.com/${repository}.git`,
        `git@github.com:${repository}.git`, `ssh://git@github.com/${repository}.git` ].includes(origin)) {
        refuse('origin must identify the fixed championship repository; its URL was not changed.');
    }

    if (!state.refresh) {
        const oldParents = parents(state.commitSha);
        const base = state.baseCommitSha || (oldParents.length === 1 ? oldParents[0] : null);
        if (!shaPattern.test(base || '')) refuse('This older merged data branch has no recorded base and needs separate review.');
        // Fetch before ancestry checks: another worktree may not have this main.
        git(['fetch', '--no-tags', 'origin', 'main'], 'Fetch current main');
        if (capture(['rev-parse', 'FETCH_HEAD'], 'Pin fetched main') !== mainSha ||
            readMain()?.object?.sha !== mainSha) refuse('Main moved while it was fetched. Resume to retry safely.');
        if (!ancestor(base, mainSha)) refuse('Main was rewritten or moved backwards; automatic refresh is refused.');
        if (ancestor(mainSha, state.commitSha)) return { state, refreshed: false };
        const treeSha = validatePlan(state.commitSha, base, mainSha);
        clean();
        if (capture(['rev-parse', `refs/heads/${state.branch}`], 'Pin local data branch') !== state.commitSha) {
            refuse('The local data branch no longer matches its saved reviewed commit.');
        }
        state.phase = 'refreshing';
        state.refreshReviewRequired = true;
        state.refresh = {
            version: 1, previousCommitSha: state.commitSha, baseCommitSha: base,
            mainCommitSha: mainSha, treeSha, commitSha: null, testedAt: null
        };
        delete state.checkedAt;
        delete state.checkRunUrl;
        persistState(state);
    }

    const journal = state.refresh;
    validateRefreshState(state);
    const previousParents = parents(journal.previousCommitSha);
    const recordedBase = state.baseCommitSha || (previousParents.length === 1 ? previousParents[0] : null);
    if (recordedBase !== journal.baseCommitSha ||
        validatePlan(journal.previousCommitSha, journal.baseCommitSha, journal.mainCommitSha) !== journal.treeSha) {
        refuse('The saved refresh plan no longer matches the original Git history.');
    }
    clean();
    const local = capture(['rev-parse', `refs/heads/${state.branch}`], 'Read recovering data branch');
    if (local !== journal.previousCommitSha && local !== journal.commitSha) {
        // The merge may have completed just before the journal write was interrupted.
        const actualParents = parents(local);
        if (journal.commitSha || actualParents.join(' ') !==
            `${journal.previousCommitSha} ${journal.mainCommitSha}` ||
            capture(['rev-parse', `${local}^{tree}`], 'Verify interrupted merge tree') !== journal.treeSha) {
            refuse('The recovering local branch moved unexpectedly; no changes were discarded.');
        }
        journal.commitSha = local;
        persistState(state);
    }
    git(['switch', state.branch], 'Resume exact data branch');
    clean();
    if (!journal.commitSha) {
        logger('Main changed. Integrating it into the existing data branch without changing the exported bundle...');
        git(['-c', 'merge.autoStash=false', 'merge', '--no-autostash', '--no-ff', '--no-edit',
            '-m', 'Refresh routine data branch against current main', journal.mainCommitSha], 'Integrate pinned main');
        journal.commitSha = capture(['rev-parse', 'HEAD'], 'Pin refreshed commit');
        persistState(state);
    }
    const verifyLocalResult = () => {
        clean();
        if (capture(['rev-parse', 'HEAD'], 'Recheck tested head') !== journal.commitSha ||
            parents(journal.commitSha).join(' ') !== `${journal.previousCommitSha} ${journal.mainCommitSha}` ||
            capture(['rev-parse', `${journal.commitSha}^{tree}`], 'Recheck merged tree') !== journal.treeSha) {
            refuse('The refreshed commit changed identity or tree; no push is permitted.');
        }
        requireSameData(journal.previousCommitSha, journal.commitSha);
        validateReleasePath({ baseCommitSha: journal.mainCommitSha, headCommitSha: journal.commitSha, state });
    };
    verifyLocalResult();
    if (!journal.testedAt) {
        logger('Running the complete checks and responsive screenshots for the refreshed commit...');
        runTests();
        verifyLocalResult();
        journal.testedAt = now();
        persistState(state);
    }
    verifyLocalResult();
    const remote = readPullRequest(state);
    identity(remote, [journal.previousCommitSha, journal.commitSha]);
    if (remote.head.sha !== journal.commitSha) {
        logger('Pushing the tested refresh to the existing Pull Request...');
        // Normal fast-forward push only. A competing remote commit is never overwritten.
        git(['push', 'origin', `${journal.commitSha}:refs/heads/${state.branch}`], 'Push tested data refresh');
    }
    identity(readPullRequest(state), [journal.commitSha]);
    state.commitSha = journal.commitSha;
    state.baseCommitSha = journal.mainCommitSha;
    state.testedAt = journal.testedAt;
    state.phase = 'published';
    delete state.refresh;
    persistState(state);
    return { state, refreshed: true };
}

/** A fresh combination always gets a new review checkpoint, even with a stale
 * --approve-merge flag. The pending marker survives failed checks and restarts. */
export async function finishRefreshReview(state, { waitForChecks, verifyEvidence, showReview, persistState }) {
    if (!state.refreshReviewRequired) return { state, stop: false };
    if (state.phase === 'published') state = await waitForChecks(state);
    if (state.phase !== 'checked') return { state, stop: state.phase !== 'merged' };
    if (typeof verifyEvidence !== 'function') refuse('Fresh review evidence must be verified before clearing its marker.');
    await verifyEvidence(state);
    showReview(state);
    delete state.refreshReviewRequired;
    persistState(state);
    return { state, stop: true };
}

export function verifyFreshReviewEvidence(state, readApi) {
    const match = new RegExp(`^https://github\\.com/${repository}/actions/runs/([1-9][0-9]*)/job/[1-9][0-9]*$`)
        .exec(state.checkRunUrl || '');
    const runId = Number(match?.[1]);
    if (!Number.isSafeInteger(runId) || runId <= 0) refuse('The fresh check has no recognized screenshot run.');
    const run = readApi(`actions/runs/${runId}`);
    if (run?.id !== runId || run.head_sha !== state.commitSha || run.event !== 'pull_request' ||
        run.status !== 'completed' || run.conclusion !== 'success') {
        refuse('The screenshot run does not prove success for the exact refreshed commit.');
    }
    const response = readApi(`actions/runs/${runId}/artifacts?per_page=100`);
    if (!Array.isArray(response?.artifacts) || !Number.isSafeInteger(response.total_count) ||
        response.total_count !== response.artifacts.length || response.total_count > 100 ||
        !response.artifacts.some(artifact => artifact?.name === `responsive-screenshots-${runId}` &&
            artifact.expired === false && Number.isSafeInteger(artifact.id) && artifact.id > 0 &&
            Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0)) {
        refuse('A fresh, complete responsive screenshot artifact is required for review.');
    }
    return { runId };
}

function refuse(message) {
    throw new Error(`Automatic data refresh refused: ${message}`);
}
