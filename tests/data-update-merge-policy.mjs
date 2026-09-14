import assert from 'node:assert/strict';
import { verifyRoutineDataMergePolicy } from '../scripts/data-update-merge-policy.mjs';

const repository = 'johnkevan88888/family-running';
const baseCommit = 'b'.repeat(40);
const headCommit = 'a'.repeat(40);
const state = {
    pullRequestUrl: `https://github.com/${repository}/pull/105`,
    commitSha: headCommit,
    branch: 'data/refresh-20260914-000214'
};
const completeConnection = nodes => ({
    totalCount: nodes.length, nodes, pageInfo: { hasNextPage: false }
});

function fixture() {
    const parameters = {
        non_fast_forward: {}, deletion: {}, update: {},
        pull_request: {
            required_approving_review_count: 0,
            dismiss_stale_reviews_on_push: false,
            required_reviewers: [],
            require_code_owner_review: false,
            require_last_push_approval: false,
            required_review_thread_resolution: true,
            require_extra_approval_for_unattributed_changes: true,
            allowed_merge_methods: ['merge']
        },
        required_status_checks: {
            strict_required_status_checks_policy: true,
            do_not_enforce_on_create: false,
            required_status_checks: [{ context: 'Test static site', integration_id: 15368 }]
        }
    };
    return {
        rules: Object.entries(parameters).map(([type, ruleParameters]) => ({
            type, parameters: ruleParameters,
            ruleset_id: 18119142, ruleset_source_type: 'Repository', ruleset_source: repository
        })),
        protection: 'HTTP/2.0 404 Not Found\r\nContent-Type: application/json\r\n\r\n' +
            JSON.stringify({ message: 'Branch not protected', status: '404' }),
        pr: {
            url: state.pullRequestUrl, number: 105, state: 'OPEN',
            baseRefName: 'main', baseRefOid: baseCommit, headRefName: state.branch,
            headRefOid: headCommit, isDraft: false, mergeable: 'MERGEABLE', reviewDecision: ''
        },
        base: { ref: 'refs/heads/main', object: { type: 'commit', sha: baseCommit } },
        comparison: { status: 'ahead', behind_by: 0, merge_base_commit: { sha: baseCommit } },
        checks: [{ name: 'Test static site', bucket: 'pass', state: 'SUCCESS' }],
        checkRuns: {
            total_count: 1,
            check_runs: [{ name: 'Test static site', app: { id: 15368 }, head_sha: headCommit,
                status: 'completed', conclusion: 'success' }]
        },
        reviews: { data: { repository: { pullRequest: {
            url: state.pullRequestUrl, headRefOid: headCommit,
            reviewThreads: completeConnection([]), reviews: completeConnection([])
        } } } },
        finalBase: null
    };
}

function runFixture(data = fixture(), stateOverride = state) {
    const calls = [];
    let baseReads = 0;
    const runCommand = (gh, args, options) => {
        assert.equal(gh, 'fake-gh');
        assert.equal(options.quiet, true);
        assert.ok(options.label);
        calls.push(args);
        let value;
        if (args[0] === 'pr') {
            assert.ok(['view', 'checks'].includes(args[1]), 'Only read-only PR commands are permitted.');
            assert.equal(args[2], state.pullRequestUrl);
            assert.ok(args.includes(repository));
            if (args[1] === 'view') value = data.pr;
            else {
                assert.ok(args.includes('--required'));
                value = data.checks;
            }
        } else {
            assert.equal(args[0], 'api');
            if (args[1] === 'graphql') {
                assert.ok(args.some(value => value.startsWith('query=query(')));
                assert.ok(!args.some(value => /\bmutation\b/.test(value)));
                assert.ok(args.includes('number=105'));
                value = data.reviews;
            } else {
                assert.equal(args[1], '--method');
                assert.equal(args[2], 'GET', 'REST policy proof must never mutate GitHub.');
                const endpoint = args.at(-1);
                assert.ok(endpoint.startsWith(`repos/${repository}/`));
                if (endpoint.includes('/rules/branches/')) value = data.rules;
                else if (endpoint.endsWith('/branches/main/protection')) {
                    assert.ok(args.includes('--include'));
                    assert.deepEqual(options.acceptedStatuses, [0, 1]);
                    return { status: 1, stdout: data.protection };
                } else if (endpoint.endsWith('/git/ref/heads/main')) {
                    value = ++baseReads === 1 ? data.base : data.finalBase || data.base;
                } else if (endpoint.includes('/compare/')) {
                    assert.ok(endpoint.endsWith(`${baseCommit}...${headCommit}`));
                    value = data.comparison;
                } else if (endpoint.includes('/check-runs?')) {
                    assert.ok(endpoint.includes(`/commits/${headCommit}/`));
                    assert.ok(endpoint.includes('filter=latest&per_page=100'));
                    value = data.checkRuns;
                } else assert.fail(`Unexpected read endpoint: ${endpoint}`);
            }
        }
        return { status: 0, stdout: JSON.stringify(value) };
    };
    return { result: verifyRoutineDataMergePolicy({ state: stateOverride, gh: 'fake-gh', runCommand }), calls };
}

assert.deepEqual(runFixture().result, { useAdmin: true, baseCommit });
const unrestricted = fixture();
unrestricted.rules = [{ type: 'some_future_protection' }];
assert.deepEqual(runFixture(unrestricted).result, { useAdmin: false, baseCommit });
assert.equal(runFixture(unrestricted).calls.length, 2,
    'Without the update restriction, return to ordinary server-enforced merging.');

const scenarios = [
    ['new protection', data => data.rules.push({ type: 'required_deployments' }), /additional/],
    ['duplicate rule', data => data.rules.push(data.rules[0]), /duplicate/],
    ['missing protection', data => data.rules.shift(), /missing/],
    ['other ruleset', data => { data.rules[0].ruleset_id = 9; }, /differs/],
    ['other source', data => { data.rules[0].ruleset_source = 'someone/else'; }, /differs/],
    ['required review', data => { data.rules[3].parameters.required_approving_review_count = 1; }, /differs/],
    ['code owners', data => { data.rules[3].parameters.require_code_owner_review = true; }, /differs/],
    ['unknown rule parameter', data => { data.rules[3].parameters.future_protection = true; }, /differs/],
    ['additional required check', data => { data.rules[4].parameters.required_status_checks.push({
        context: 'Another gate', integration_id: 5
    }); }, /differs/],
    ['relaxed strict check', data => { data.rules[4].parameters.strict_required_status_checks_policy = false; }, /differs/],
    ['classic protection', data => { data.protection = 'HTTP/2.0 200 OK\n\n{}'; }, /classic/],
    ['classic inaccessible', data => { data.protection = 'HTTP/2.0 404 Not Found\n\n{"message":"Not Found"}'; }, /classic/],
    ['classic unauthenticated', data => { data.protection = 'HTTP/2.0 401 Unauthorized\n\n{"message":"Requires authentication"}'; }, /classic/],
    ['wrong PR', data => { data.pr.url += '0'; }, /exact open/],
    ['changed head', data => { data.pr.headRefOid = 'c'.repeat(40); }, /exact open/],
    ['draft PR', data => { data.pr.isDraft = true; }, /exact open/],
    ['closed PR', data => { data.pr.state = 'CLOSED'; }, /exact open/],
    ['unknown mergeability', data => { data.pr.mergeable = 'UNKNOWN'; }, /exact open/],
    ['requested review changes', data => { data.pr.reviewDecision = 'CHANGES_REQUESTED'; }, /requires review/],
    ['approval required', data => { data.pr.reviewDecision = 'REVIEW_REQUIRED'; }, /requires review/],
    ['inconsistent base', data => { data.pr.baseRefOid = 'c'.repeat(40); }, /consistently/],
    ['behind production', data => { data.comparison.status = 'behind'; data.comparison.behind_by = 1; }, /include/],
    ['divergent base', data => { data.comparison.merge_base_commit.sha = 'c'.repeat(40); }, /include/],
    ['missing required check', data => { data.checks = []; }, /Every current/],
    ['skipped check', data => { data.checks[0].bucket = 'skipping'; data.checks[0].state = 'SKIPPED'; }, /Every current/],
    ['pending check', data => { data.checks[0].bucket = 'pending'; }, /Every current/],
    ['new failing required check', data => { data.checks.push({ name: 'Security', bucket: 'fail', state: 'FAILURE' }); }, /Every current/],
    ['wrong check app', data => { data.checkRuns.check_runs[0].app.id = 1; }, /GitHub Actions/],
    ['wrong check head', data => { data.checkRuns.check_runs[0].head_sha = 'c'.repeat(40); }, /GitHub Actions/],
    ['failed Actions check', data => { data.checkRuns.check_runs[0].conclusion = 'failure'; }, /GitHub Actions/],
    ['truncated check list', data => { data.checkRuns.total_count = 101; }, /complete current/],
    ['changed review identity', data => { data.reviews.data.repository.pullRequest.headRefOid = 'c'.repeat(40); }, /changed identity/],
    ['unresolved conversation', data => { data.reviews.data.repository.pullRequest.reviewThreads = completeConnection([{ isResolved: false }]); }, /must be resolved/],
    ['conversation next page', data => { data.reviews.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage = true; }, /truncated/],
    ['truncated reviews', data => { data.reviews.data.repository.pullRequest.reviews.totalCount = 101; }, /truncated/],
    ['GraphQL error', data => { data.reviews.errors = [{ message: 'partial results' }]; }, /incomplete/],
    ['base moves during checks', data => { data.finalBase = { ...data.base, object: { type: 'commit', sha: 'c'.repeat(40) } }; }, /changed during/]
];
for (const [name, modify, expected] of scenarios) {
    const data = fixture();
    modify(data);
    assert.throws(() => runFixture(data), expected, name);
}

const requested = fixture();
const earlierChangeRequest = {
    state: 'CHANGES_REQUESTED', author: { login: 'reviewer' }, submittedAt: '2026-09-14T00:00:00Z'
};
requested.reviews.data.repository.pullRequest.reviews = completeConnection([earlierChangeRequest]);
assert.throws(() => runFixture(requested), /reviewer still has requested changes/,
    'Optional change requests are respected even when GitHub reviewDecision is empty.');
requested.reviews.data.repository.pullRequest.reviews = completeConnection([
    { state: 'APPROVED', author: { login: 'reviewer' }, submittedAt: '2026-09-14T01:00:00Z' },
    earlierChangeRequest
]);
assert.deepEqual(runFixture(requested).result, { useAdmin: true, baseCommit },
    'A later approval supersedes that reviewer\'s earlier request, independent of response order.');

assert.throws(() => runFixture(fixture(), { ...state, pullRequestUrl: 'https://github.com/other/repo/pull/105' }), /identity is invalid/);
assert.throws(() => verifyRoutineDataMergePolicy({
    state, gh: 'fake-gh', runCommand: () => ({ stdout: 'invalid JSON' })
}), /valid JSON/);
assert.throws(() => verifyRoutineDataMergePolicy({
    state, gh: 'fake-gh', runCommand: () => { throw new Error('GitHub authentication unavailable'); }
}), /authentication unavailable/);

console.log(`Routine data merge policy tests passed (${scenarios.length + 9} cases; read-only fake provider).`);
