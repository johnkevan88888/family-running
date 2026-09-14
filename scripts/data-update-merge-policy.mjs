const repository = 'johnkevan88888/family-running';
const repositoryApi = `repos/${repository}`;
const rulesetId = 18119142;
const requiredCheckName = 'Test static site';
const actionsAppId = 15368;
const shaPattern = /^[0-9a-f]{40}$/;

const expectedRuleParameters = {
    non_fast_forward: {},
    deletion: {},
    update: {},
    pull_request: {
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: false,
        required_reviewers: [],
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: true,
        // GitHub documents that this has no effect when zero approvals are required.
        require_extra_approval_for_unattributed_changes: true,
        allowed_merge_methods: ['merge']
    },
    required_status_checks: {
        strict_required_status_checks_policy: true,
        do_not_enforce_on_create: false,
        required_status_checks: [{ context: requiredCheckName, integration_id: actionsAppId }]
    }
};

/**
 * Read-only proof for the existing owner's restricted-update merge route.
 * No approval is granted here: the caller must obtain MERGE first, re-read its
 * exact PR identity afterwards, and retain --match-head-commit on the merge.
 * Unknown protections and incomplete provider responses never enable --admin.
 */
export function verifyRoutineDataMergePolicy({ state, gh, runCommand }) {
    const match = new RegExp(`^https://github\\.com/${repository}/pull/([1-9][0-9]*)$`)
        .exec(state?.pullRequestUrl || '');
    if (!match || !shaPattern.test(state?.commitSha || '') ||
        !/^data\/refresh-[0-9]{8}-[0-9]{6}$/.test(state?.branch || '')) {
        refuse('The saved routine-data Pull Request identity is invalid.');
    }
    const pullRequestNumber = Number(match[1]);
    if (!Number.isSafeInteger(pullRequestNumber)) refuse('The Pull Request number is invalid.');

    const command = (args, label, options = {}) => runCommand(gh, args, {
        quiet: true, label, ...options
    });
    const readJson = (args, label) => parseJson(command(args, label).stdout, label);
    const readApi = (endpoint, label) => readJson(
        ['api', '--method', 'GET', `${repositoryApi}/${endpoint}`], label
    );

    const rules = readApi('rules/branches/main?per_page=100', 'Read current main rules');
    if (!Array.isArray(rules) || rules.length >= 100) {
        refuse('The complete effective main rules could not be established.');
    }
    if (!rules.some(rule => rule?.type === 'update')) {
        // Without this restriction, ordinary GitHub merge enforcement is sufficient.
        const base = readApi('git/ref/heads/main', 'Read current production commit');
        if (base?.ref !== 'refs/heads/main' || base.object?.type !== 'commit' ||
            !shaPattern.test(base.object?.sha || '')) {
            refuse('The current production commit could not be established.');
        }
        return { useAdmin: false, baseCommit: base.object.sha };
    }
    verifyRecognizedRules(rules);

    const protection = command(
        ['api', '--method', 'GET', '--include', `${repositoryApi}/branches/main/protection`],
        'Check for additional classic branch protection',
        { acceptedStatuses: [0, 1] }
    );
    const httpResponse = /^HTTP\/\S+ 404[^\r\n]*\r?\n[\s\S]*?\r?\n\r?\n([\s\S]*)$/
        .exec(protection.stdout || '');
    if (!httpResponse || parseJson(httpResponse[1], 'Classic protection response').message !==
        'Branch not protected') {
        refuse('Additional classic branch protection is present or could not be ruled out.');
    }

    const pullRequest = readJson([
        'pr', 'view', state.pullRequestUrl, '--repo', repository, '--json',
        'url,number,state,baseRefName,baseRefOid,headRefName,headRefOid,isDraft,mergeable,reviewDecision'
    ], 'Recheck routine-data Pull Request');
    if (pullRequest.url !== state.pullRequestUrl || pullRequest.number !== pullRequestNumber ||
        pullRequest.baseRefName !== 'main' || pullRequest.headRefName !== state.branch ||
        pullRequest.headRefOid !== state.commitSha || pullRequest.state !== 'OPEN' ||
        pullRequest.isDraft !== false || pullRequest.mergeable !== 'MERGEABLE') {
        refuse('The Pull Request is not the exact open, mergeable, reviewed data update.');
    }
    if (![null, '', 'APPROVED'].includes(pullRequest.reviewDecision)) {
        refuse('The Pull Request still requires review or has requested changes.');
    }

    const base = readApi('git/ref/heads/main', 'Read current production commit');
    const baseSha = base?.object?.sha;
    if (base?.ref !== 'refs/heads/main' || base.object?.type !== 'commit' ||
        !shaPattern.test(baseSha || '') || pullRequest.baseRefOid !== baseSha) {
        refuse('The current production commit could not be established consistently.');
    }
    const comparison = readApi(
        `compare/${baseSha}...${state.commitSha}`,
        'Verify data branch contains current production'
    );
    if (!['ahead', 'identical'].includes(comparison?.status) || comparison.behind_by !== 0 ||
        comparison.merge_base_commit?.sha !== baseSha) {
        refuse('The data branch must include the current production commit before merging.');
    }

    const checks = readJson([
        'pr', 'checks', state.pullRequestUrl, '--repo', repository, '--required',
        '--json', 'name,bucket,state'
    ], 'Recheck all currently required GitHub checks');
    if (!Array.isArray(checks) || checks.length === 0 ||
        !checks.some(check => check?.name === requiredCheckName) ||
        checks.some(check => check?.bucket !== 'pass' || check.state !== 'SUCCESS')) {
        refuse('Every current required check must succeed; skipped or pending checks are insufficient.');
    }
    const checkResponse = readApi(
        `commits/${state.commitSha}/check-runs?filter=latest&per_page=100`,
        'Verify required check comes from GitHub Actions'
    );
    if (!Array.isArray(checkResponse?.check_runs) ||
        !Number.isSafeInteger(checkResponse.total_count) ||
        checkResponse.total_count !== checkResponse.check_runs.length ||
        checkResponse.total_count > 100) {
        refuse('The complete current check-run list could not be established.');
    }
    const requiredRuns = checkResponse.check_runs.filter(run => run?.name === requiredCheckName);
    if (requiredRuns.length === 0 || requiredRuns.some(run =>
        run.app?.id !== actionsAppId || run.head_sha !== state.commitSha ||
        run.status !== 'completed' || run.conclusion !== 'success')) {
        refuse('The exact data commit needs a successful Test static site run from GitHub Actions.');
    }

    const reviews = readJson([
        'api', 'graphql', '-f', `query=${reviewQuery}`, '-F', `number=${pullRequestNumber}`
    ], 'Verify review conversations are resolved');
    const reviewed = reviews?.data?.repository?.pullRequest;
    if (reviews.errors?.length || reviewed?.url !== state.pullRequestUrl ||
        reviewed.headRefOid !== state.commitSha) {
        refuse('The Pull Request review response is incomplete or changed identity.');
    }
    verifyCompleteConnection(reviewed.reviewThreads, 'review conversations');
    if (reviewed.reviewThreads.nodes.some(thread => thread?.isResolved !== true)) {
        refuse('Every Pull Request review conversation must be resolved before merging.');
    }
    verifyCompleteConnection(reviewed.reviews, 'submitted reviews');
    const opinions = new Map();
    const submittedReviews = reviewed.reviews.nodes.filter(review => review?.state !== 'PENDING');
    if (submittedReviews.some(review => !Number.isFinite(Date.parse(review?.submittedAt)))) {
        refuse('A submitted review has no valid submission time.');
    }
    for (const review of submittedReviews.sort((first, second) =>
        Date.parse(first.submittedAt) - Date.parse(second.submittedAt))) {
        if (!['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING'].includes(review?.state)) {
            refuse('A Pull Request review has an unrecognized state.');
        }
        if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) {
            if (!review.author?.login) refuse('A submitted review has no identifiable author.');
            opinions.set(review.author.login, review.state);
        }
    }
    if ([...opinions.values()].includes('CHANGES_REQUESTED')) {
        refuse('A reviewer still has requested changes on this Pull Request.');
    }

    const finalBase = readApi('git/ref/heads/main', 'Confirm production did not move during verification');
    if (finalBase?.ref !== 'refs/heads/main' || finalBase.object?.sha !== baseSha) {
        refuse('Production changed during verification; update the data branch and retry.');
    }
    return { useAdmin: true, baseCommit: baseSha };
}

const reviewQuery = `query($number: Int!) {
  repository(owner: "johnkevan88888", name: "family-running") {
    pullRequest(number: $number) {
      url headRefOid
      reviewThreads(first: 100) { totalCount nodes { isResolved } pageInfo { hasNextPage } }
      reviews(first: 100) { totalCount nodes { state submittedAt author { login } } pageInfo { hasNextPage } }
    }
  }
}`;

function verifyRecognizedRules(rules) {
    const expectedTypes = Object.keys(expectedRuleParameters).sort();
    if (!sameValue(rules.map(rule => rule?.type).sort(), expectedTypes)) {
        refuse('Main has additional, missing, or duplicate protection rules; owner merge is not enabled.');
    }
    for (const rule of rules) {
        if (rule.ruleset_id !== rulesetId || rule.ruleset_source_type !== 'Repository' ||
            rule.ruleset_source !== repository ||
            !sameValue(rule.parameters ?? {}, expectedRuleParameters[rule.type])) {
            refuse(`The ${rule.type} protection differs from the supported owner-merge policy.`);
        }
    }
}

function verifyCompleteConnection(connection, label) {
    if (!Array.isArray(connection?.nodes) || !Number.isSafeInteger(connection.totalCount) ||
        connection.totalCount !== connection.nodes.length || connection.totalCount > 100 ||
        connection.pageInfo?.hasNextPage !== false) {
        refuse(`The complete ${label} could not be established; truncated results cannot authorize an owner merge.`);
    }
}

function sameValue(left, right) {
    if (left === right) return true;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object' ||
        Array.isArray(left) !== Array.isArray(right)) return false;
    const keys = Object.keys(left).sort();
    return keys.length === Object.keys(right).length && keys.every(key =>
        Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

function parseJson(text, label) {
    try {
        return JSON.parse(text);
    } catch {
        refuse(`${label} did not return valid JSON.`);
    }
}

function refuse(message) {
    throw new Error(`Routine data merge refused: ${message}`);
}
