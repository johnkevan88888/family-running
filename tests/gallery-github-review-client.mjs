import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';

import * as reviewClientModule from '../scripts/gallery-media/github-review-client.mjs';

assert.deepEqual(
    Object.keys(reviewClientModule),
    [
        'createGalleryReviewOpenEvidenceHash',
        'createOrReconcileGalleryReview',
        'invalidateGalleryReview',
        'reconcileStoredGalleryReview',
        'refreshStoredGalleryReview'
    ],
    'The module must expose only review creation and exact review invalidation/reconciliation.'
);

const {
    createGalleryReviewOpenEvidenceHash,
    createOrReconcileGalleryReview,
    invalidateGalleryReview,
    reconcileStoredGalleryReview,
    refreshStoredGalleryReview
} = reviewClientModule;
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

const storedGitHub = createMockGitHub();
const storedCreated = await createOrReconcileGalleryReview(candidate, {
    expectedBaseSha: baseSha,
    token,
    fetchImpl: storedGitHub.fetch
});
const storedReview = storedReviewFrom(storedCreated);
const storedOpenEvidenceHash = createGalleryReviewOpenEvidenceHash(storedCreated);
assert.match(storedOpenEvidenceHash, /^[a-f0-9]{64}$/);
const storedTerminal = await reconcileStoredGalleryReview(storedReview, {
    token,
    fetchImpl: storedGitHub.fetch
});
assert.equal(storedTerminal.terminalKind, 'closed-unmerged');
assert.match(storedTerminal.terminalEvidenceHash, /^[a-f0-9]{64}$/);
assert.equal(
    storedTerminal.openEvidenceHash,
    storedOpenEvidenceHash
);
assert.match(storedTerminal.closeEvidenceHash, /^[a-f0-9]{64}$/);
assert.match(storedTerminal.readbackEvidenceHash, /^[a-f0-9]{64}$/);
assert.equal(storedTerminal.pullRequest.state, 'closed');
assert.equal(storedGitHub.state.pullRequests[0].state, 'closed');
assert.equal(storedTerminal.branchState, 'retained-for-reviewed-cleanup');

const noPullGitHub = createMockGitHub();
const noPullCreated = await createOrReconcileGalleryReview(candidate, {
    expectedBaseSha: baseSha,
    token,
    fetchImpl: noPullGitHub.fetch
});
noPullGitHub.state.pullRequests.length = 0;
const noPullTerminal = await reconcileStoredGalleryReview(
    storedReviewFrom(noPullCreated, { reserved: true }),
    { token, fetchImpl: noPullGitHub.fetch }
);
assert.equal(noPullTerminal.terminalKind, 'no-pr-created');
assert.equal(noPullTerminal.pullRequest, null);
assert.equal(noPullTerminal.closeEvidenceHash, null);
assert.equal(noPullTerminal.readbackEvidenceHash, null);
assert.equal(noPullTerminal.branchState, 'retained-for-reviewed-cleanup');

const mergedStoredGitHub = createMockGitHub();
const mergedStoredCreated = await createOrReconcileGalleryReview(candidate, {
    expectedBaseSha: baseSha,
    token,
    fetchImpl: mergedStoredGitHub.fetch
});
mergedStoredGitHub.state.pullRequests[0].state = 'closed';
mergedStoredGitHub.state.pullRequests[0].merged_at = '2026-09-02T00:00:00.000Z';
await assert.rejects(
    reconcileStoredGalleryReview(storedReviewFrom(mergedStoredCreated), {
        token,
        fetchImpl: mergedStoredGitHub.fetch
    }),
    /merged, changed, or unowned/
);

const changedStoredGitHub = createMockGitHub();
const changedStoredCreated = await createOrReconcileGalleryReview(candidate, {
    expectedBaseSha: baseSha,
    token,
    fetchImpl: changedStoredGitHub.fetch
});
changedStoredGitHub.state.branchSha = '9'.repeat(40);
changedStoredGitHub.state.pullRequests[0].head.sha = changedStoredGitHub.state.branchSha;
await assert.rejects(
    reconcileStoredGalleryReview(storedReviewFrom(changedStoredCreated), {
        token,
        fetchImpl: changedStoredGitHub.fetch
    }),
    /branch changed after its open receipt/
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

// Append-only synchronization keeps the original receipt and photo bytes.
const sync = await refreshFixture();
const immutableReceipt = JSON.stringify(sync.stored);
const refreshed = await refreshStoredGalleryReview(sync.stored, sync.options());
assert.equal(refreshed.originalHeadSha, sync.originalHead);
assert.equal(refreshed.headSha, sync.state.branchSha);
assert.equal(refreshed.baseSha, sync.state.mainSha);
assert.equal(refreshed.replayed, false);
assert.equal(JSON.stringify(sync.stored), immutableReceipt);
assert.equal(sync.eligibilityReads(), 3);
assert.deepEqual(sync.updates(), [{ sha: refreshed.headSha, force: false }]);
const replay = await refreshStoredGalleryReview(sync.stored, sync.options());
assert.equal(replay.replayed, true);
assert.equal(sync.updates().length, 1);
const terminal = await reconcileStoredGalleryReview(sync.stored, { token, fetchImpl: sync.fetch });
assert.equal(terminal.headSha, sync.originalHead, 'D1 identity stays anchored to the original open receipt.');
assert.equal(terminal.openEvidenceHash, createGalleryReviewOpenEvidenceHash(sync.created));
assert.equal(terminal.terminalKind, 'closed-unmerged');
assert.equal(sync.state.pullRequests[0].head.sha, refreshed.headSha);
const terminalReplay = await reconcileStoredGalleryReview(sync.stored, { token, fetchImpl: sync.fetch });
assert.deepEqual(terminalReplay, terminal);

const lostRefresh = await refreshFixture({ loseUpdateResponse: true });
await refreshStoredGalleryReview(lostRefresh.stored, lostRefresh.options());
assert.equal(lostRefresh.updates().length, 1);

for (const mode of ['extra-file', 'wrong-bytes', 'wrong-parent', 'backward-main',
    'wrong-pr', 'closed-pr', 'changed-manifest-base', 'ref-race']) {
    const fixture = await refreshFixture({ mode });
    await assert.rejects(refreshStoredGalleryReview(fixture.stored, fixture.options()));
    assert.equal(fixture.updates().length, 0, `${mode} must not update the ref.`);
}
for (const failAt of [1, 2, 3]) {
    const fixture = await refreshFixture({ failAt });
    await assert.rejects(refreshStoredGalleryReview(fixture.stored, fixture.options()));
    assert.equal(fixture.updates().length, failAt === 3 ? 1 : 0);
    assert.equal(fixture.state.pullRequests[0].state, failAt === 3 ? 'closed' : 'open');
}
const movedMain = await refreshFixture({ moveMainAfterUpdate: true });
await assert.rejects(refreshStoredGalleryReview(movedMain.stored, movedMain.options()), /closed after/);
assert.equal(movedMain.state.pullRequests[0].state, 'closed');
const deniedUpdate = await refreshFixture({ denyUpdate: true });
await assert.rejects(refreshStoredGalleryReview(deniedUpdate.stored, deniedUpdate.options()), /422/);
assert.equal(deniedUpdate.state.branchSha, deniedUpdate.originalHead);
const changedCandidate = await refreshFixture();
await assert.rejects(refreshStoredGalleryReview(changedCandidate.stored, {
    ...changedCandidate.options(), readEligibleCandidate: async () => candidateForDocument({
        ...manifestDocument, items: [{ ...manifestDocument.items[0], title: 'Different photo text' }]
    })
}), /preserve the exact recorded candidate/);
assert.equal(changedCandidate.updates().length, 0);

const repeated = await refreshFixture();
for (let index = 0; index < 16; index += 1) {
    repeated.state.mainSha = (100 + index).toString(16).padStart(40, '0');
    await refreshStoredGalleryReview(repeated.stored, repeated.options());
}
assert.equal(repeated.updates().length, 16);
repeated.state.mainSha = 'f'.repeat(40);
await assert.rejects(refreshStoredGalleryReview(repeated.stored, repeated.options()), /history limit reached/);
const repeatedTerminal = await reconcileStoredGalleryReview(repeated.stored, { token, fetchImpl: repeated.fetch });
assert.equal(repeatedTerminal.headSha, repeated.originalHead);

const tamperedHistory = await refreshFixture();
await refreshStoredGalleryReview(tamperedHistory.stored, tamperedHistory.options());
tamperedHistory.commits.get(tamperedHistory.state.branchSha).parents[0].sha = tamperedHistory.state.branchSha;
await assert.rejects(reconcileStoredGalleryReview(tamperedHistory.stored,
    { token, fetchImpl: tamperedHistory.fetch }), /invalid refresh history/);
assert.equal(tamperedHistory.state.pullRequests[0].state, 'open', 'Never close an unowned history.');

console.log('Gallery GitHub review client tests passed, including refresh, replay, races and anchored withdrawal.');

async function refreshFixture(settings = {}) {
    const mock = createMockGitHub();
    const created = await createOrReconcileGalleryReview(candidate, {
        expectedBaseSha: baseSha, token, fetchImpl: mock.fetch
    });
    const stored = storedReviewFrom(created);
    const originalHead = created.headSha;
    const oldCommit = { ...deepClone(mock.state.createdCommit), sha: originalHead,
        parents: mock.state.createdCommit.parents.map(sha => ({ sha })) };
    const commits = new Map([[originalHead, oldCommit]]);
    const newMain = '1'.repeat(40);
    mock.state.mainSha = newMain;
    if (settings.mode === 'wrong-pr') mock.state.pullRequests[0].body += 'changed';
    if (settings.mode === 'closed-pr') mock.state.pullRequests[0].state = 'closed';
    const extraRequests = [];
    let reads = 0;
    let commitNumber = 200;
    const fetch = async (url, request = {}) => {
        const parsed = new URL(url);
        const p = parsed.pathname.replace('/repos/johnkevan88888/family-running', '');
        const method = request.method || 'GET';
        const body = request.body && JSON.parse(request.body);
        extraRequests.push({ method, p, body });
        assert.equal(parsed.origin, 'https://api.github.com');
        if (method === 'GET' && p.startsWith('/git/commits/')) {
            const sha = p.split('/').at(-1);
            if (commits.has(sha)) return response(200, commits.get(sha));
        }
        if (method === 'GET' && p.startsWith('/compare/')) {
            const [base, head] = p.slice('/compare/'.length).split('...');
            if (head === originalHead) return response(200, {
                status: 'ahead', ahead_by: 1, total_commits: 1,
                files: [{ filename: candidate.targetRelativePath, status: 'modified' }]
            });
            if (commits.has(head)) return response(200, {
                status: 'ahead', behind_by: 0, merge_base_commit: { sha: base },
                files: [{ filename: candidate.targetRelativePath, status: 'modified' },
                    ...(settings.mode === 'extra-file' ? [{ filename: 'index.html', status: 'modified' }] : [])]
            });
            return response(200, { status: settings.mode === 'backward-main' ? 'diverged' : 'ahead',
                behind_by: 0, merge_base_commit: { sha: base } });
        }
        if (method === 'GET' && p === `/contents/${candidate.targetRelativePath}`) {
            const ref = parsed.searchParams.get('ref');
            const isCandidate = commits.has(ref);
            const text = isCandidate ? (settings.mode === 'wrong-bytes' && ref !== originalHead
                ? `${candidate.manifestText} ` : candidate.manifestText)
                : settings.mode === 'changed-manifest-base' ? candidate.manifestText : emptyManifestText;
            return response(200, { type: 'file', path: candidate.targetRelativePath,
                encoding: 'base64', content: Buffer.from(text).toString('base64') });
        }
        if (method === 'POST' && p === '/git/commits') {
            const sha = (++commitNumber).toString(16).padStart(40, '0');
            commits.set(sha, { sha, message: body.message, tree: { sha: body.tree },
                parents: body.parents.map(sha => ({ sha })) });
            if (settings.mode === 'wrong-parent') commits.get(sha).parents = [{ sha: newMain }];
            return response(201, { sha });
        }
        if (method === 'PATCH' && p.startsWith('/git/refs/')) {
            assert.equal(p, `/git/refs/heads/${stored.branchRef}`);
            assert.equal(body.force, false);
            if (settings.denyUpdate) return response(422, {});
            mock.state.branchSha = body.sha;
            mock.state.pullRequests[0].head.sha = body.sha;
            if (settings.moveMainAfterUpdate) mock.state.mainSha = '3'.repeat(40);
            if (settings.loseUpdateResponse) throw new Error('Lost successful response');
            return response(200, { object: { sha: body.sha } });
        }
        return mock.fetch(url, request);
    };
    return { state: mock.state, stored, created, originalHead, fetch, commits,
        eligibilityReads: () => reads,
        updates: () => extraRequests.filter(r => r.method === 'PATCH' && r.p.startsWith('/git/refs/')).map(r => r.body),
        options: () => ({ expectedBaseSha: mock.state.mainSha, token, fetchImpl: fetch,
            readEligibleCandidate: async () => {
                reads += 1;
                if (reads === settings.failAt) throw new Error('Consent or eligibility changed');
                if (reads === 2 && settings.mode === 'ref-race') mock.state.branchSha = '9'.repeat(40);
                return deepClone(candidate);
            }
        })
    };
}

function storedReviewFrom(review, { reserved = false } = {}) {
    return {
        schemaVersion: '1.0',
        promotionId: operationId,
        repository: review.repository,
        baseRef: review.baseRef,
        baseSha: review.baseSha,
        branchRef: review.branchRef,
        headSha: reserved ? null : review.headSha,
        targetRelativePath: review.targetRelativePath,
        itemId: review.itemId,
        manifestSha256: review.manifestSha256,
        operationMarkerHash: createHash('sha256')
            .update('family-running-gallery-review-operation-v1\0', 'utf8')
            .update(operationId, 'utf8')
            .digest('hex'),
        pullRequest: reserved ? null : deepClone(review.pullRequest)
    };
}

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
            assert.ok(ref === state.branchSha || /^gallery-media\/candidate-[a-f0-9]{32}$/.test(ref || ''));
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
