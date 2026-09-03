import assert from 'node:assert/strict';

import { verifyGalleryReviewBoundary } from '../scripts/gallery-media/github-review-boundary.mjs';

const baseSha = 'a'.repeat(40);
const token = 'short-lived-test-token';
const expectedRule = type => ({
    type,
    ruleset_id: 18119142,
    ruleset_source_type: 'Repository',
    ruleset_source: 'johnkevan88888/family-running'
});
const requiredRules = [
    expectedRule('update'),
    expectedRule('pull_request'),
    expectedRule('required_status_checks')
];

const requests = [];
const result = await verifyGalleryReviewBoundary({
    expectedBaseSha: baseSha,
    token,
    fetchImpl: async (url, init) => {
        requests.push({ url: new URL(url), init });
        if (requests.length === 1 || requests.length === 4) {
            return jsonResponse(200, mainRef(baseSha));
        }
        if (requests.length === 2) {
            return jsonResponse(200, requiredRules);
        }
        return jsonResponse(422, { message: 'Repository rule violations found' });
    }
});

assert.deepEqual(result, {
    schemaVersion: '1.0',
    repository: 'johnkevan88888/family-running',
    baseRef: 'main',
    baseSha,
    rulesetId: 18119142,
    directMainUpdateDenied: true,
    mergeDeniedByUpdateRestriction: true,
    mainRefUnchanged: true
});
assert.deepEqual(requests.map(entry => entry.init.method), ['GET', 'GET', 'PATCH', 'GET']);
assert.equal(requests[1].url.pathname, '/repos/johnkevan88888/family-running/rules/branches/main');
assert.equal(requests[1].url.search, '?per_page=100');
assert.equal(requests[2].url.pathname, '/repos/johnkevan88888/family-running/git/refs/heads/main');
assert.deepEqual(JSON.parse(requests[2].init.body), { sha: baseSha, force: false });
assert.ok(requests.every(entry => entry.init.redirect === 'error'));
assert.ok(requests.every(entry => entry.init.headers.Authorization === `Bearer ${token}`));

await assert.rejects(runWith({ rules: requiredRules.filter(rule => rule.type !== 'update') }),
    /requires one exact update/);
await assert.rejects(runWith({ initialSha: 'b'.repeat(40) }), /changed or malformed main ref/);
await assert.rejects(runWith({ denialStatus: 200, denialBody: mainRef(baseSha) }),
    /unexpectedly accepted a main ref update/);
await assert.rejects(runWith({ denialBody: { message: 'Validation Failed' } }),
    /was not an accepted rules-owned denial/);
const structuredProtectedRefResult = await runWith({
    denialBody: {
        message: 'Validation Failed',
        errors: [{
            resource: 'Reference',
            code: 'protected',
            message: 'Cannot update this protected ref.'
        }]
    }
});
assert.equal(structuredProtectedRefResult.directMainUpdateDenied, true);
await assert.rejects(runWith({
    denialBody: {
        message: 'Validation Failed',
        errors: [{
            resource: 'Reference',
            code: 'invalid',
            message: 'Cannot update this protected ref.'
        }]
    }
}), /was not an accepted rules-owned denial/);
await assert.rejects(runWith({ finalSha: 'c'.repeat(40) }), /changed or malformed main ref/);
await assert.rejects(
    verifyGalleryReviewBoundary({ expectedBaseSha: baseSha, token, fetchImpl: null }),
    /HTTPS fetch implementation/
);

console.log('Gallery GitHub review permission-boundary tests passed.');

function runWith(overrides = {}) {
    let count = 0;
    return verifyGalleryReviewBoundary({
        expectedBaseSha: baseSha,
        token,
        fetchImpl: async () => {
            count += 1;
            if (count === 1) {
                return jsonResponse(200, mainRef(overrides.initialSha || baseSha));
            }
            if (count === 2) {
                return jsonResponse(200, overrides.rules || requiredRules);
            }
            if (count === 3) {
                return jsonResponse(
                    overrides.denialStatus || 422,
                    overrides.denialBody || { message: 'Repository rule violations found' }
                );
            }
            return jsonResponse(200, mainRef(overrides.finalSha || baseSha));
        }
    });
}

function mainRef(sha) {
    return { ref: 'refs/heads/main', object: { type: 'commit', sha } };
}

function jsonResponse(status, value) {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}
