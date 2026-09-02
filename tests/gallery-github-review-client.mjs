import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';

import * as reviewClientModule from '../scripts/gallery-media/github-review-client.mjs';

assert.deepEqual(
    Object.keys(reviewClientModule),
    ['createOrReconcileGalleryReview', 'invalidateGalleryReview'],
    'The module must expose only review creation and exact stale-review invalidation.'
);

const { createOrReconcileGalleryReview, invalidateGalleryReview } = reviewClientModule;
const reviewClientSource = await fs.readFile(
    new URL('../scripts/gallery-media/github-review-client.mjs', import.meta.url),
    'utf8'
);
assert.doesNotMatch(reviewClientSource, /['"]DELETE['"]|requestNoContent|expectNoContent/);
const baseSha = 'a'.repeat(40);
const token = 'ghs_synthetic_installation_token_123456789';
const operationId = 'promotion_01k3h8xb6pg0t9m2q7vr4c5n1z';
const manifestDocument = {
    schemaVersion: '1.0',
    items: [{
        id: 'synthetic-finish-photo',
        type: 'photo',
        title: 'Synthetic finish',
        caption: 'Synthetic review-only evidence.',
        alt: 'A synthetic runner crossing a finish line',
        raceDate: '2026-08-23',
        raceEvent: 'Summer 5 km',
        raceDistance: '5 km',
        sourceUrl: `https://media.example.com/media/v1/${'1'.repeat(64)}/display.webp`,
        thumbnailUrl: `https://media.example.com/media/v1/${'2'.repeat(64)}/thumbnail.webp`,
        featured: true,
        athleteIds: ['carolyn-kevan']
    }]
};
const manifestText = `${JSON.stringify(manifestDocument, null, 2)}\n`;
const manifestSha256 = sha256Revision(manifestText);
const candidate = deepClone({
    changed: true,
    targetRelativePath: 'gallery-data/family.json',
    itemId: 'synthetic-finish-photo',
    manifestText,
    manifestSha256,
    receipt: {
        schemaVersion: '1.0',
        operationId,
        targetRelativePath: 'gallery-data/family.json',
        itemId: 'synthetic-finish-photo',
        manifestSha256
    }
});
const emptyManifestText = `${JSON.stringify({ schemaVersion: '1.0', items: [] }, null, 2)}\n`;

const freshGitHub = createMockGitHub();
const created = await createOrReconcileGalleryReview(candidate, {
    expectedBaseSha: baseSha,
    token,
    fetchImpl: freshGitHub.fetch
});

assert.equal(created.schemaVersion, '1.0');
assert.equal(created.replayed, false);
assert.equal(created.repository, 'johnkevan88888/family-running');
assert.equal(created.baseRef, 'main');
assert.equal(created.baseSha, baseSha);
assert.match(created.branchRef, /^gallery-media\/candidate-[a-f0-9]{32}$/);
assert.equal(created.headSha, freshGitHub.state.branchSha);
assert.equal(created.targetRelativePath, candidate.targetRelativePath);
assert.equal(created.itemId, candidate.itemId);
assert.equal(created.manifestSha256, candidate.manifestSha256);
assert.deepEqual(created.pullRequest, {
    number: 1,
    url: 'https://github.com/johnkevan88888/family-running/pull/1',
    state: 'open'
});
assert.equal(Object.isFrozen(created), true);
assert.equal(Object.isFrozen(created.pullRequest), true);
assert.doesNotMatch(JSON.stringify(created), /synthetic_installation_token/);

const mutationRequests = freshGitHub.state.requests.filter(request => request.method !== 'GET');
assert.deepEqual(
    mutationRequests.map(request => [request.method, request.path]),
    [
        ['POST', '/git/blobs'],
        ['POST', '/git/trees'],
        ['POST', '/git/commits'],
        ['POST', '/git/refs'],
        ['POST', '/pulls']
    ]
);
assert.equal(
    freshGitHub.state.requests.some(request =>
        ['PATCH', 'PUT', 'DELETE'].includes(request.method)
    ),
    false
);
assert.equal(
    freshGitHub.state.requests.some(request =>
        /(?:\/merge|deployments|pages|environments|secrets)/i.test(request.path)
    ),
    false
);
assert.equal(
    freshGitHub.state.requests.some(request =>
        request.method !== 'GET' && /(?:\/git\/refs?\/heads\/main|refs\/heads\/main)/.test(
            `${request.path}\n${JSON.stringify(request.body)}`
        )
    ),
    false
);
assert.equal(freshGitHub.state.createdTree.tree.length, 1);
assert.equal(freshGitHub.state.createdTree.tree[0].path, candidate.targetRelativePath);
assert.deepEqual(freshGitHub.state.createdCommit.parents, [baseSha]);
assert.equal(freshGitHub.state.pullRequests.length, 1);

const invalidationGitHub = createMockGitHub();
const reviewToInvalidate = await createOrReconcileGalleryReview(candidate, {
    expectedBaseSha: baseSha,
    token,
    fetchImpl: invalidationGitHub.fetch
});
const invalidated = await invalidateGalleryReview(candidate, reviewToInvalidate, {
    expectedBaseSha: baseSha,
    token,
    fetchImpl: invalidationGitHub.fetch
});
assert.deepEqual(invalidated, {
    schemaVersion: '1.0',
    repository: 'johnkevan88888/family-running',
    branchRef: reviewToInvalidate.branchRef,
    branchState: 'retained-for-reviewed-cleanup',
    pullRequest: {
        number: 1,
        url: 'https://github.com/johnkevan88888/family-running/pull/1',
        state: 'closed'
    }
});
assert.equal(invalidationGitHub.state.pullRequests[0].state, 'closed');
assert.equal(invalidationGitHub.state.branchSha, reviewToInvalidate.headSha);
assert.deepEqual(
    invalidationGitHub.state.requests
        .filter(request => ['PATCH', 'DELETE'].includes(request.method))
        .map(request => [request.method, request.path, request.body]),
    [['PATCH', '/pulls/1', { state: 'closed' }]]
);
assert.equal(
    invalidationGitHub.state.requests.some(request =>
        ['PATCH', 'DELETE'].includes(request.method) &&
        /(?:merge|heads\/main|deploy|pages|environment|secret)/i.test(
            `${request.path}\n${JSON.stringify(request.body)}`
        )
    ),
    false,
    'Invalidation must not merge, mutate main, deploy, or administer the repository.'
);

const patchCountBeforeReplay = invalidationGitHub.state.requests.filter(
    request => request.method === 'PATCH'
).length;
const replayedInvalidation = await invalidateGalleryReview(candidate, reviewToInvalidate, {
    expectedBaseSha: baseSha,
    token,
    fetchImpl: invalidationGitHub.fetch
});
assert.equal(replayedInvalidation.pullRequest.state, 'closed');
assert.equal(
    invalidationGitHub.state.requests.filter(request => request.method === 'PATCH').length,
    patchCountBeforeReplay,
    'An already-closed exact review must be read back without another mutation.'
);
assert.equal(invalidationGitHub.state.branchSha, reviewToInvalidate.headSha);

const failedCloseGitHub = createMockGitHub({ failCloseWithoutMutation: true });
const failedCloseReview = await createOrReconcileGalleryReview(candidate, {
    expectedBaseSha: baseSha,
    token,
    fetchImpl: failedCloseGitHub.fetch
});
await assert.rejects(
    invalidateGalleryReview(candidate, failedCloseReview, {
        expectedBaseSha: baseSha,
        token,
        fetchImpl: failedCloseGitHub.fetch
    }),
    /GitHub PATCH request failed with status 503/
);
assert.equal(failedCloseGitHub.state.pullRequests[0].state, 'open');
assert.equal(
    failedCloseGitHub.state.requests.some(request => request.method === 'DELETE'),
    false,
    'A failed close must never trigger automatic branch deletion.'
);

const failedReadbackGitHub = createMockGitHub({ failClosedReadback: true });
const failedReadbackReview = await createOrReconcileGalleryReview(candidate, {
    expectedBaseSha: baseSha,
    token,
    fetchImpl: failedReadbackGitHub.fetch
});
await assert.rejects(
    invalidateGalleryReview(candidate, failedReadbackReview, {
        expectedBaseSha: baseSha,
        token,
        fetchImpl: failedReadbackGitHub.fetch
    }),
    /GitHub GET request failed with status 503/
);
assert.equal(failedReadbackGitHub.state.pullRequests[0].state, 'closed');
assert.equal(failedReadbackGitHub.state.branchSha, failedReadbackReview.headSha);

const changedBranchGitHub = createMockGitHub();
const changedBranchReview = await createOrReconcileGalleryReview(candidate, {
    expectedBaseSha: baseSha,
    token,
    fetchImpl: changedBranchGitHub.fetch
});
changedBranchGitHub.state.branchSha = '9'.repeat(40);
changedBranchGitHub.state.pullRequests[0].head.sha = changedBranchGitHub.state.branchSha;
const changedBranchInvalidation = await invalidateGalleryReview(candidate, changedBranchReview, {
    expectedBaseSha: baseSha,
    token,
    fetchImpl: changedBranchGitHub.fetch
});
assert.equal(changedBranchInvalidation.branchState, 'retained-for-reviewed-cleanup');
assert.equal(changedBranchGitHub.state.pullRequests[0].state, 'closed');
assert.equal(changedBranchGitHub.state.branchSha, '9'.repeat(40));
assert.equal(
    changedBranchGitHub.state.requests.some(request => request.method === 'DELETE'),
    false,
    'A changed ref must be retained while its exact marked PR is closed.'
);

const changedBaseGitHub = createMockGitHub();
const changedBaseReview = await createOrReconcileGalleryReview(candidate, {
    expectedBaseSha: baseSha,
    token,
    fetchImpl: changedBaseGitHub.fetch
});
changedBaseGitHub.state.pullRequests[0].base.sha = '8'.repeat(40);
const changedBaseInvalidation = await invalidateGalleryReview(candidate, changedBaseReview, {
    expectedBaseSha: baseSha,
    token,
    fetchImpl: changedBaseGitHub.fetch
});
assert.equal(changedBaseInvalidation.pullRequest.state, 'closed');
assert.equal(changedBaseGitHub.state.pullRequests[0].state, 'closed');
assert.equal(changedBaseGitHub.state.branchSha, changedBaseReview.headSha);

const beforeReplayMutations = mutationRequests.length;
const replayed = await createOrReconcileGalleryReview(candidate, {
    expectedBaseSha: baseSha,
    token,
    fetchImpl: freshGitHub.fetch
});
assert.equal(replayed.replayed, true);
assert.equal(replayed.branchRef, created.branchRef);
assert.equal(replayed.headSha, created.headSha);
assert.equal(replayed.pullRequest.number, created.pullRequest.number);
assert.equal(
    freshGitHub.state.requests.filter(request => request.method !== 'GET').length,
    beforeReplayMutations,
    'An exact replay must not create another Git object, branch, or Pull Request.'
);

const lostRefGitHub = createMockGitHub({ loseRefResponseOnce: true });
const recoveredRef = await createOrReconcileGalleryReview(candidate, {
    expectedBaseSha: baseSha,
    token,
    fetchImpl: lostRefGitHub.fetch
});
assert.equal(recoveredRef.replayed, false);
assert.equal(lostRefGitHub.state.pullRequests.length, 1);
assert.equal(
    lostRefGitHub.state.requests.filter(request =>
        request.method === 'POST' && request.path === '/git/refs'
    ).length,
    1,
    'A lost ref response must reconcile the exact created ref instead of creating another.'
);

const lostPullGitHub = createMockGitHub({ losePullResponseOnce: true });
const recoveredPull = await createOrReconcileGalleryReview(candidate, {
    expectedBaseSha: baseSha,
    token,
    fetchImpl: lostPullGitHub.fetch
});
assert.equal(recoveredPull.pullRequest.number, 1);
assert.equal(lostPullGitHub.state.pullRequests.length, 1);
assert.equal(
    lostPullGitHub.state.requests.filter(request =>
        request.method === 'POST' && request.path === '/pulls'
    ).length,
    1,
    'A lost PR response must reconcile the exact PR instead of creating another.'
);

const staleGitHub = createMockGitHub({ mainSha: 'f'.repeat(40) });
await assert.rejects(
    createOrReconcileGalleryReview(candidate, {
        expectedBaseSha: baseSha,
        token,
        fetchImpl: staleGitHub.fetch
    }),
    /base branch is stale/
);
assert.equal(staleGitHub.state.requests.some(request => request.method !== 'GET'), false);

const racingMainGitHub = createMockGitHub({ advanceMainAfterRefCreate: true });
await assert.rejects(
    createOrReconcileGalleryReview(candidate, {
        expectedBaseSha: baseSha,
        token,
        fetchImpl: racingMainGitHub.fetch
    }),
    /base branch changed during candidate reconciliation/
);
assert.equal(
    racingMainGitHub.state.requests.some(request =>
        request.method === 'POST' && request.path === '/pulls'
    ),
    false,
    'A main-branch race must stop before Pull Request creation.'
);

const unknownCommitGitHub = createMockGitHub();
await createOrReconcileGalleryReview(candidate, {
    expectedBaseSha: baseSha,
    token,
    fetchImpl: unknownCommitGitHub.fetch
});
unknownCommitGitHub.state.createdCommit.parents = ['9'.repeat(40)];
const unknownCommitMutationCount = unknownCommitGitHub.state.requests.filter(
    request => request.method !== 'GET'
).length;
await assert.rejects(
    createOrReconcileGalleryReview(candidate, {
        expectedBaseSha: baseSha,
        token,
        fetchImpl: unknownCommitGitHub.fetch
    }),
    /unknown commit or parent/
);
assert.equal(
    unknownCommitGitHub.state.requests.filter(request => request.method !== 'GET').length,
    unknownCommitMutationCount
);

const tamperedManifestGitHub = createMockGitHub();
await createOrReconcileGalleryReview(candidate, {
    expectedBaseSha: baseSha,
    token,
    fetchImpl: tamperedManifestGitHub.fetch
});
tamperedManifestGitHub.state.branchManifestText = `${manifestText} `;
await assert.rejects(
    createOrReconcileGalleryReview(candidate, {
        expectedBaseSha: baseSha,
        token,
        fetchImpl: tamperedManifestGitHub.fetch
    }),
    /different manifest bytes/
);

const extraDiffGitHub = createMockGitHub();
await createOrReconcileGalleryReview(candidate, {
    expectedBaseSha: baseSha,
    token,
    fetchImpl: extraDiffGitHub.fetch
});
extraDiffGitHub.state.extraComparisonFile = {
    filename: 'gallery-data/everyone.json',
    status: 'modified'
};
await assert.rejects(
    createOrReconcileGalleryReview(candidate, {
        expectedBaseSha: baseSha,
        token,
        fetchImpl: extraDiffGitHub.fetch
    }),
    /exactly one inherited manifest/
);

const closedPullGitHub = createMockGitHub();
await createOrReconcileGalleryReview(candidate, {
    expectedBaseSha: baseSha,
    token,
    fetchImpl: closedPullGitHub.fetch
});
closedPullGitHub.state.pullRequests[0].state = 'closed';
await assert.rejects(
    createOrReconcileGalleryReview(candidate, {
        expectedBaseSha: baseSha,
        token,
        fetchImpl: closedPullGitHub.fetch
    }),
    /closed, stale, or does not match/
);
assert.equal(closedPullGitHub.state.pullRequests.length, 1);

const missingBranchGitHub = createMockGitHub();
await createOrReconcileGalleryReview(candidate, {
    expectedBaseSha: baseSha,
    token,
    fetchImpl: missingBranchGitHub.fetch
});
missingBranchGitHub.state.branchSha = null;
await assert.rejects(
    createOrReconcileGalleryReview(candidate, {
        expectedBaseSha: baseSha,
        token,
        fetchImpl: missingBranchGitHub.fetch
    }),
    /Pull Request exists but its owned branch is missing/
);

const duplicatePullGitHub = createMockGitHub();
await createOrReconcileGalleryReview(candidate, {
    expectedBaseSha: baseSha,
    token,
    fetchImpl: duplicatePullGitHub.fetch
});
duplicatePullGitHub.state.pullRequests.push({
    ...deepClone(duplicatePullGitHub.state.pullRequests[0]),
    number: 2,
    html_url: 'https://github.com/johnkevan88888/family-running/pull/2'
});
await assert.rejects(
    createOrReconcileGalleryReview(candidate, {
        expectedBaseSha: baseSha,
        token,
        fetchImpl: duplicatePullGitHub.fetch
    }),
    /more than one Pull Request/
);

const existingBaseItem = {
    ...deepClone(manifestDocument.items[0]),
    id: 'existing-finish-photo',
    title: 'Existing finish',
    sourceUrl: `https://media.example.com/media/v1/${'3'.repeat(64)}/display.webp`,
    thumbnailUrl: `https://media.example.com/media/v1/${'4'.repeat(64)}/thumbnail.webp`
};
const existingBaseText = `${JSON.stringify({
    schemaVersion: '1.0',
    items: [existingBaseItem]
}, null, 2)}\n`;
const removesExistingGitHub = createMockGitHub({ baseManifestText: existingBaseText });
await assert.rejects(
    createOrReconcileGalleryReview(candidate, {
        expectedBaseSha: baseSha,
        token,
        fetchImpl: removesExistingGitHub.fetch
    }),
    /add exactly one manifest item/
);
assert.equal(
    removesExistingGitHub.state.requests.some(request => request.method !== 'GET'),
    false,
    'A candidate that removes a base item must fail before any GitHub mutation.'
);

const changedExistingDocument = {
    schemaVersion: '1.0',
    items: [
        { ...existingBaseItem, title: 'Silently changed existing finish' },
        deepClone(manifestDocument.items[0])
    ]
};
const changedExistingCandidate = candidateForDocument(changedExistingDocument);
const changesExistingGitHub = createMockGitHub({ baseManifestText: existingBaseText });
await assert.rejects(
    createOrReconcileGalleryReview(changedExistingCandidate, {
        expectedBaseSha: baseSha,
        token,
        fetchImpl: changesExistingGitHub.fetch
    }),
    /preserve every existing manifest item and its order/
);
assert.equal(
    changesExistingGitHub.state.requests.some(request => request.method !== 'GET'),
    false,
    'A candidate that edits a base item must fail before any GitHub mutation.'
);

const secondExistingItem = {
    ...deepClone(existingBaseItem),
    id: 'second-existing-finish-photo',
    title: 'Second existing finish',
    sourceUrl: `https://media.example.com/media/v1/${'5'.repeat(64)}/display.webp`,
    thumbnailUrl: `https://media.example.com/media/v1/${'6'.repeat(64)}/thumbnail.webp`
};
const twoItemBaseText = `${JSON.stringify({
    schemaVersion: '1.0',
    items: [existingBaseItem, secondExistingItem]
}, null, 2)}\n`;
const reorderedExistingCandidate = candidateForDocument({
    schemaVersion: '1.0',
    items: [
        secondExistingItem,
        existingBaseItem,
        deepClone(manifestDocument.items[0])
    ]
});
const reordersExistingGitHub = createMockGitHub({ baseManifestText: twoItemBaseText });
await assert.rejects(
    createOrReconcileGalleryReview(reorderedExistingCandidate, {
        expectedBaseSha: baseSha,
        token,
        fetchImpl: reordersExistingGitHub.fetch
    }),
    /preserve every existing manifest item and its order/
);
assert.equal(
    reordersExistingGitHub.state.requests.some(request => request.method !== 'GET'),
    false,
    'A candidate that reorders base items must fail before any GitHub mutation.'
);

const videoManifestDocument = deepClone(manifestDocument);
videoManifestDocument.items[0].type = 'video';
const videoManifestText = `${JSON.stringify(videoManifestDocument, null, 2)}\n`;
const videoManifestSha256 = sha256Revision(videoManifestText);
const videoCandidate = {
    ...candidate,
    manifestText: videoManifestText,
    manifestSha256: videoManifestSha256,
    receipt: {
        ...candidate.receipt,
        manifestSha256: videoManifestSha256
    }
};
await assert.rejects(
    createOrReconcileGalleryReview(videoCandidate, {
        expectedBaseSha: baseSha,
        token,
        fetchImpl: async () => {
            throw new Error('A video candidate must fail before GitHub access.');
        }
    }),
    /valid photo manifest/
);

for (const [invalidCandidate, pattern] of [
    [{ ...candidate, site: 'everyone' }, /must contain exactly/],
    [{ ...candidate, changed: false }, /newly generated/],
    [{ ...candidate, targetRelativePath: 'gallery-data/everyone.json' }, /receipt does not match/],
    [{ ...candidate, targetRelativePath: '../family.json' }, /not an inherited manifest/],
    [{ ...candidate, manifestSha256: `sha256:${'0'.repeat(64)}` }, /does not match its bytes/],
    [{
        ...candidate,
        receipt: { ...candidate.receipt, operationId: 'invalid-operation' }
    }, /receipt does not match/],
    [{
        ...candidate,
        manifestText: JSON.stringify(manifestDocument)
    }, /manifest bytes are invalid/]
]) {
    await assert.rejects(
        createOrReconcileGalleryReview(invalidCandidate, {
            expectedBaseSha: baseSha,
            token,
            fetchImpl: async () => {
                throw new Error('Validation failure must happen before GitHub access.');
            }
        }),
        pattern
    );
}

await assert.rejects(
    createOrReconcileGalleryReview(candidate, {
        expectedBaseSha: baseSha,
        token,
        fetchImpl: async () => response(500, {}),
        destination: 'everyone'
    }),
    /client options must contain exactly/
);

await assert.rejects(
    createOrReconcileGalleryReview(candidate, {
        expectedBaseSha: baseSha,
        token
    }),
    /client options must contain exactly/
);

console.log('Gallery GitHub review client tests passed.');

function createMockGitHub(options = {}) {
    const state = {
        requests: [],
        mainSha: options.mainSha || baseSha,
        baseTreeSha: 'b'.repeat(40),
        blobSha: 'c'.repeat(40),
        treeSha: 'd'.repeat(40),
        commitSha: 'e'.repeat(40),
        createdBlob: null,
        createdTree: null,
        createdCommit: null,
        branchName: null,
        branchSha: null,
        branchManifestText: null,
        baseManifestText: options.baseManifestText || emptyManifestText,
        pullRequests: [],
        extraComparisonFile: null,
        loseRefResponseOnce: options.loseRefResponseOnce === true,
        losePullResponseOnce: options.losePullResponseOnce === true,
        failCloseWithoutMutation: options.failCloseWithoutMutation === true,
        failClosedReadback: options.failClosedReadback === true,
        advanceMainAfterRefCreate: options.advanceMainAfterRefCreate === true
    };

    async function fetch(urlValue, request = {}) {
        const url = new URL(urlValue);
        const method = request.method || 'GET';
        const repositoryPrefix = '/repos/johnkevan88888/family-running';
        assert.equal(url.origin, 'https://api.github.com');
        assert.equal(url.pathname.startsWith(repositoryPrefix), true);
        assert.equal(request.redirect, 'error');
        assert.equal(request.headers.Authorization, `Bearer ${token}`);
        assert.equal(request.headers['X-GitHub-Api-Version'], '2022-11-28');

        const path = url.pathname.slice(repositoryPrefix.length);
        const body = request.body === undefined ? undefined : JSON.parse(request.body);
        state.requests.push({ method, path, search: url.search, body: deepClone(body) });

        if (method === 'GET' && path === '/git/ref/heads/main') {
            return response(200, { object: { sha: state.mainSha } });
        }
        if (
            method === 'GET' &&
            path.startsWith('/git/ref/heads/gallery-media/candidate-')
        ) {
            return state.branchSha === null
                ? response(404, { message: 'Not Found' })
                : response(200, { object: { sha: state.branchSha } });
        }
        if (method === 'GET' && path === `/git/commits/${state.mainSha}`) {
            return response(200, {
                sha: state.mainSha,
                tree: { sha: state.baseTreeSha },
                parents: []
            });
        }
        if (
            method === 'GET' &&
            state.createdCommit &&
            path === `/git/commits/${state.branchSha}`
        ) {
            return response(200, {
                sha: state.branchSha,
                message: state.createdCommit.message,
                tree: { sha: state.createdCommit.tree },
                parents: state.createdCommit.parents.map(sha => ({ sha }))
            });
        }
        if (
            method === 'GET' &&
            path === `/compare/${baseSha}...${state.branchSha}`
        ) {
            const files = [{
                filename: candidate.targetRelativePath,
                status: 'modified'
            }];
            if (state.extraComparisonFile) {
                files.push(deepClone(state.extraComparisonFile));
            }
            return response(200, {
                status: 'ahead',
                ahead_by: 1,
                total_commits: 1,
                files
            });
        }
        if (method === 'GET' && path === `/contents/${candidate.targetRelativePath}`) {
            const ref = url.searchParams.get('ref');
            if (ref === baseSha) {
                return response(200, {
                    type: 'file',
                    path: candidate.targetRelativePath,
                    encoding: 'base64',
                    content: Buffer.from(state.baseManifestText, 'utf8').toString('base64')
                });
            }
            assert.match(ref || '', /^gallery-media\/candidate-[a-f0-9]{32}$/);
            return response(200, {
                type: 'file',
                path: candidate.targetRelativePath,
                encoding: 'base64',
                content: Buffer.from(state.branchManifestText, 'utf8').toString('base64')
            });
        }
        if (method === 'GET' && path === '/pulls') {
            assert.equal(url.searchParams.get('state'), 'all');
            assert.equal(url.searchParams.get('base'), 'main');
            assert.equal(
                url.searchParams.get('head'),
                `johnkevan88888:${state.branchName || url.searchParams.get('head')?.split(':')[1]}`
            );
            return response(200, deepClone(state.pullRequests));
        }
        if (method === 'GET' && /^\/pulls\/[1-9][0-9]*$/.test(path)) {
            const number = Number(path.split('/').at(-1));
            const pullRequest = state.pullRequests.find(value => value.number === number);
            if (state.failClosedReadback && pullRequest?.state === 'closed') {
                return response(503, { message: 'Synthetic closed-state readback failure' });
            }
            return pullRequest
                ? response(200, deepClone(pullRequest))
                : response(404, { message: 'Not Found' });
        }
        if (method === 'POST' && path === '/git/blobs') {
            state.createdBlob = deepClone(body);
            state.branchManifestText = Buffer.from(body.content, 'base64').toString('utf8');
            return response(201, { sha: state.blobSha });
        }
        if (method === 'POST' && path === '/git/trees') {
            state.createdTree = deepClone(body);
            return response(201, { sha: state.treeSha });
        }
        if (method === 'POST' && path === '/git/commits') {
            state.createdCommit = deepClone(body);
            return response(201, { sha: state.commitSha });
        }
        if (method === 'POST' && path === '/git/refs') {
            state.branchName = body.ref.replace(/^refs\/heads\//, '');
            state.branchSha = body.sha;
            if (state.advanceMainAfterRefCreate) {
                state.advanceMainAfterRefCreate = false;
                state.mainSha = 'f'.repeat(40);
            }
            if (state.loseRefResponseOnce) {
                state.loseRefResponseOnce = false;
                throw new TypeError('Synthetic lost ref response');
            }
            return response(201, { object: { sha: state.branchSha } });
        }
        if (method === 'POST' && path === '/pulls') {
            assert.equal(body.head, state.branchName);
            const pullRequest = makePullRequest(body, state);
            state.pullRequests.push(pullRequest);
            if (state.losePullResponseOnce) {
                state.losePullResponseOnce = false;
                throw new TypeError('Synthetic lost Pull Request response');
            }
            return response(201, deepClone(pullRequest));
        }
        if (method === 'PATCH' && /^\/pulls\/[1-9][0-9]*$/.test(path)) {
            assert.deepEqual(body, { state: 'closed' });
            if (state.failCloseWithoutMutation) {
                return response(503, { message: 'Synthetic close failure' });
            }
            const number = Number(path.split('/').at(-1));
            const pullRequest = state.pullRequests.find(value => value.number === number);
            if (!pullRequest) return response(404, { message: 'Not Found' });
            pullRequest.state = 'closed';
            return response(200, deepClone(pullRequest));
        }
        return response(404, { message: `Unexpected mock route: ${method} ${path}` });
    }

    return { fetch, state };
}

function candidateForDocument(documentValue) {
    const text = `${JSON.stringify(documentValue, null, 2)}\n`;
    const revision = sha256Revision(text);
    return {
        ...deepClone(candidate),
        manifestText: text,
        manifestSha256: revision,
        receipt: {
            ...deepClone(candidate.receipt),
            manifestSha256: revision
        }
    };
}

function makePullRequest(body, state) {
    const number = state.pullRequests.length + 1;
    return {
        number,
        state: 'open',
        merged_at: null,
        draft: false,
        title: body.title,
        body: body.body,
        html_url: `https://github.com/johnkevan88888/family-running/pull/${number}`,
        base: {
            ref: body.base,
            sha: state.mainSha,
            repo: { full_name: 'johnkevan88888/family-running' }
        },
        head: {
            ref: body.head,
            sha: state.branchSha,
            repo: { full_name: 'johnkevan88888/family-running' }
        }
    };
}

function response(status, value) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async json() {
            return deepClone(value);
        }
    };
}

function sha256Revision(text) {
    return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function deepClone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
