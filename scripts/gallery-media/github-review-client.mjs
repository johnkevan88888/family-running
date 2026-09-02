import { createHash } from 'node:crypto';

import '../../gallery-contract.js';

const repositoryOwner = 'johnkevan88888';
const repositoryName = 'family-running';
const repositoryFullName = `${repositoryOwner}/${repositoryName}`;
const baseRef = 'main';
const apiOrigin = 'https://api.github.com';
const repositoryApiPath = `/repos/${repositoryFullName}`;
const branchPrefix = 'gallery-media/candidate-';
const allowedManifestPaths = new Set([
    'gallery-data/family.json',
    'gallery-data/everyone.json'
]);
const candidateResultKeys = Object.freeze([
    'changed',
    'targetRelativePath',
    'itemId',
    'manifestText',
    'manifestSha256',
    'receipt'
]);
const candidateReceiptKeys = Object.freeze([
    'schemaVersion',
    'operationId',
    'targetRelativePath',
    'itemId',
    'manifestSha256'
]);
const reviewResultKeys = Object.freeze([
    'schemaVersion',
    'replayed',
    'repository',
    'baseRef',
    'baseSha',
    'branchRef',
    'headSha',
    'targetRelativePath',
    'itemId',
    'manifestSha256',
    'pullRequest'
]);
const reviewPullRequestKeys = Object.freeze(['number', 'url', 'state']);
const storedReviewKeys = Object.freeze([
    'schemaVersion',
    'promotionId',
    'repository',
    'baseRef',
    'baseSha',
    'branchRef',
    'headSha',
    'targetRelativePath',
    'itemId',
    'manifestSha256',
    'operationMarkerHash',
    'pullRequest'
]);
const itemIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const operationIdPattern = /^promotion_[A-Za-z0-9_-]{16,119}$/;
const sha256RevisionPattern = /^sha256:[a-f0-9]{64}$/;
const commitShaPattern = /^[a-f0-9]{40}$/i;
const maximumManifestBytes = 1024 * 1024;
const apiVersion = '2022-11-28';
const pullRequestMarkerPrefix = '<!-- family-running-gallery-candidate:';
const galleryContract = globalThis.galleryContract;

/**
 * Create or reconcile one review-only Gallery manifest Pull Request.
 *
 * `candidateResult` must be the exact output from candidate-manifest.mjs. The
 * repository, base branch, candidate branch grammar, and two possible manifest
 * paths are fixed in this module. The only injected capabilities are an HTTPS
 * fetch implementation and a short-lived repository-scoped GitHub App token.
 */
export async function createOrReconcileGalleryReview(candidateResult, options = {}) {
    const candidate = validateCandidateResult(candidateResult);
    requireExactKeys(
        options,
        ['expectedBaseSha', 'token', 'fetchImpl'],
        'Gallery review client options'
    );
    const expectedBaseSha = validateCommitSha(options.expectedBaseSha, 'expectedBaseSha');
    const token = validateToken(options.token);
    const fetchImpl = validateFetch(options.fetchImpl);
    const github = createFixedGitHubClient(fetchImpl, token);
    const branchRef = deriveOwnedBranch(candidate.receipt.operationId);
    const title = `Add approved Gallery photo: ${candidate.itemId}`;
    const body = pullRequestBody(candidate, branchRef);
    const commitMessage = `Add approved Gallery photo ${candidate.itemId}`;

    const currentBaseSha = await readRequiredRef(github, `heads/${baseRef}`, 'base branch');
    if (currentBaseSha !== expectedBaseSha) {
        throw new Error('Gallery review base branch is stale; regenerate the candidate from current main.');
    }

    await proveCandidateIsOneAddition(github, candidate, expectedBaseSha);

    let existingPulls = await listOperationPullRequests(github, branchRef);
    if (existingPulls.length > 1) {
        throw new Error('Gallery review operation has more than one Pull Request.');
    }

    let branchSha = await readOptionalRef(github, `heads/${branchRef}`);
    let branchReplayed = branchSha !== null;

    if (branchSha === null) {
        if (existingPulls.length !== 0) {
            throw new Error('Gallery review Pull Request exists but its owned branch is missing.');
        }

        branchSha = await createCandidateCommit(github, {
            candidate,
            branchRef,
            baseSha: expectedBaseSha,
            commitMessage
        });
        branchReplayed = false;
    }

    await verifyOwnedCandidateBranch(github, {
        candidate,
        branchRef,
        branchSha,
        baseSha: expectedBaseSha,
        commitMessage
    });
    await assertBaseStillCurrent(github, expectedBaseSha);

    existingPulls = await listOperationPullRequests(github, branchRef);
    if (existingPulls.length > 1) {
        throw new Error('Gallery review operation has more than one Pull Request.');
    }

    let pullRequest;
    let pullReplayed = false;
    if (existingPulls.length === 1) {
        pullRequest = validateOpenPullRequest(existingPulls[0], {
            branchRef,
            branchSha,
            baseSha: expectedBaseSha,
            title,
            body
        });
        pullReplayed = true;
    } else {
        pullRequest = await createOrRecoverPullRequest(github, {
            branchRef,
            branchSha,
            baseSha: expectedBaseSha,
            title,
            body
        });
    }

    // Repeat the exact diff proof after PR creation/reconciliation. The GitHub
    // client never assumes that a successful mutation response proves which
    // bytes the branch now exposes for review.
    await verifyOwnedCandidateBranch(github, {
        candidate,
        branchRef,
        branchSha,
        baseSha: expectedBaseSha,
        commitMessage
    });
    await assertBaseStillCurrent(github, expectedBaseSha);

    return deepFreeze({
        schemaVersion: '1.0',
        replayed: branchReplayed || pullReplayed,
        repository: repositoryFullName,
        baseRef,
        baseSha: expectedBaseSha,
        branchRef,
        headSha: branchSha,
        targetRelativePath: candidate.targetRelativePath,
        itemId: candidate.itemId,
        manifestSha256: candidate.manifestSha256,
        pullRequest: {
            number: pullRequest.number,
            url: pullRequest.html_url,
            state: 'open'
        }
    });
}

/**
 * Close one exact stale Gallery review PR. The deterministic candidate branch
 * is retained for separately reviewed cleanup because GitHub ref deletion has
 * no expected-SHA compare-and-swap. This operation cannot merge a PR, update or
 * delete main, or delete any branch.
 */
export async function invalidateGalleryReview(candidateResult, reviewResult, options = {}) {
    const candidate = validateCandidateResult(candidateResult);
    requireExactKeys(
        options,
        ['expectedBaseSha', 'token', 'fetchImpl'],
        'Gallery review invalidation options'
    );
    const expectedBaseSha = validateCommitSha(options.expectedBaseSha, 'expectedBaseSha');
    const token = validateToken(options.token);
    const fetchImpl = validateFetch(options.fetchImpl);
    const review = validateReviewResult(reviewResult, candidate, expectedBaseSha);
    const github = createFixedGitHubClient(fetchImpl, token);
    const pullPath = `/pulls/${review.pullRequest.number}`;

    const pullBefore = await github.request('GET', pullPath);
    validateOwnedPullRequestForInvalidation(pullBefore, candidate, review, ['open', 'closed']);

    let closeRequestError = null;
    if (pullBefore.state === 'open') {
        try {
            await github.request('PATCH', pullPath, { state: 'closed' });
        } catch (error) {
            closeRequestError = error;
        }
    }

    try {
        const verifiedPull = await github.request('GET', pullPath);
        validateOwnedPullRequestForInvalidation(verifiedPull, candidate, review, ['closed']);
    } catch (verificationError) {
        throw closeRequestError || verificationError;
    }

    return deepFreeze({
        schemaVersion: '1.0',
        repository: repositoryFullName,
        branchRef: review.branchRef,
        branchState: 'retained-for-reviewed-cleanup',
        pullRequest: {
            number: review.pullRequest.number,
            url: review.pullRequest.url,
            state: 'closed'
        }
    });
}

/**
 * Recover and close a review from its immutable D1 receipt after the original
 * workflow has ended. Unlike the immediate invalidator above, this path does
 * not need the candidate manifest bytes to still be eligible in D1. It proves
 * the deterministic branch, exact manifest hash, operation marker, and
 * unmerged Pull Request directly from GitHub before returning terminal proof.
 */
export async function reconcileStoredGalleryReview(storedReview, options = {}) {
    const review = validateStoredReview(storedReview);
    requireExactKeys(
        options,
        ['token', 'fetchImpl'],
        'Stored Gallery review reconciliation options'
    );
    const token = validateToken(options.token);
    const fetchImpl = validateFetch(options.fetchImpl);
    const github = createFixedGitHubClient(fetchImpl, token);

    const branchSha = await readOptionalRef(github, `heads/${review.branchRef}`);
    if (branchSha === null) {
        if (review.pullRequest !== null) {
            throw new Error('Stored Gallery review has a Pull Request but its owned branch is missing.');
        }
        const pulls = await listOperationPullRequests(github, review.branchRef);
        if (pulls.length !== 0) {
            throw new Error('Stored Gallery review has a Pull Request without its owned branch.');
        }
        return storedTerminalResult(review, 'no-pr-created', null, null);
    }
    if (review.headSha !== null && review.headSha !== branchSha) {
        throw new Error('Stored Gallery review branch changed after its open receipt.');
    }

    await verifyStoredCandidateBranch(github, review, branchSha);
    const pulls = await listOperationPullRequests(github, review.branchRef);
    if (pulls.length > 1) {
        throw new Error('Stored Gallery review operation has more than one Pull Request.');
    }
    if (pulls.length === 0) {
        if (review.pullRequest !== null) {
            throw new Error('Stored Gallery review Pull Request is missing.');
        }
        return storedTerminalResult(review, 'no-pr-created', branchSha, null);
    }

    const pullBefore = validateStoredPullRequest(pulls[0], review, branchSha, [
        'open',
        'closed'
    ]);
    let closeRequestError = null;
    if (pullBefore.state === 'open') {
        try {
            await github.request('PATCH', `/pulls/${pullBefore.number}`, {
                state: 'closed'
            });
        } catch (error) {
            closeRequestError = error;
        }
    }

    let pullAfter;
    try {
        pullAfter = validateStoredPullRequest(
            await github.request('GET', `/pulls/${pullBefore.number}`),
            review,
            branchSha,
            ['closed']
        );
    } catch (verificationError) {
        throw closeRequestError || verificationError;
    }
    return storedTerminalResult(review, 'closed-unmerged', branchSha, pullAfter);
}

export function createGalleryReviewOpenEvidenceHash(reviewResult) {
    if (
        !isPlainObject(reviewResult) ||
        reviewResult.repository !== repositoryFullName ||
        reviewResult.baseRef !== baseRef ||
        !commitShaPattern.test(stringValue(reviewResult.headSha)) ||
        !/^gallery-media\/candidate-[a-f0-9]{32}$/.test(
            stringValue(reviewResult.branchRef)
        ) ||
        !isPlainObject(reviewResult.pullRequest) ||
        !Number.isSafeInteger(reviewResult.pullRequest.number) ||
        reviewResult.pullRequest.number < 1 ||
        reviewResult.pullRequest.url !==
            `https://github.com/${repositoryFullName}/pull/${reviewResult.pullRequest.number}`
    ) {
        throw new Error('Gallery review open evidence is invalid.');
    }
    return hashOpenPullIdentity({
        number: reviewResult.pullRequest.number,
        url: reviewResult.pullRequest.url,
        branchRef: reviewResult.branchRef,
        headSha: reviewResult.headSha,
        baseRef: reviewResult.baseRef
    });
}

async function createCandidateCommit(github, {
    candidate,
    branchRef,
    baseSha,
    commitMessage
}) {
    const baseCommit = await github.request('GET', `/git/commits/${baseSha}`);
    const baseTreeSha = validateCommitSha(baseCommit?.tree?.sha, 'base tree SHA');
    const blob = await github.request('POST', '/git/blobs', {
        content: Buffer.from(candidate.manifestText, 'utf8').toString('base64'),
        encoding: 'base64'
    });
    const blobSha = validateCommitSha(blob?.sha, 'candidate blob SHA');
    const tree = await github.request('POST', '/git/trees', {
        base_tree: baseTreeSha,
        tree: [{
            path: candidate.targetRelativePath,
            mode: '100644',
            type: 'blob',
            sha: blobSha
        }]
    });
    const treeSha = validateCommitSha(tree?.sha, 'candidate tree SHA');
    const commit = await github.request('POST', '/git/commits', {
        message: commitMessage,
        tree: treeSha,
        parents: [baseSha]
    });
    const proposedCommitSha = validateCommitSha(commit?.sha, 'candidate commit SHA');

    try {
        const created = await github.request('POST', '/git/refs', {
            ref: `refs/heads/${branchRef}`,
            sha: proposedCommitSha
        });
        const createdSha = validateCommitSha(created?.object?.sha, 'candidate branch SHA');
        if (createdSha !== proposedCommitSha) {
            throw new Error('GitHub returned a different commit for the candidate branch.');
        }
        return createdSha;
    } catch (error) {
        // A concurrent identical run, or a lost successful HTTP response, may
        // leave the exact owned ref present. Read it back and let the complete
        // parent/content/diff proof below decide whether it is safe to adopt.
        const recoveredSha = await readOptionalRef(github, `heads/${branchRef}`);
        if (recoveredSha === null) {
            throw error;
        }
        return recoveredSha;
    }
}

async function proveCandidateIsOneAddition(github, candidate, baseSha) {
    const contents = await github.request(
        'GET',
        `/contents/${candidate.targetRelativePath}?ref=${baseSha}`
    );
    const baseManifestText = decodeRepositoryFile(
        contents,
        candidate.targetRelativePath,
        'base manifest'
    );
    let baseDocument;
    let candidateDocument;
    try {
        baseDocument = JSON.parse(baseManifestText);
        candidateDocument = JSON.parse(candidate.manifestText);
    } catch {
        throw new Error('Gallery review base or candidate manifest is not valid JSON.');
    }
    if (
        !isPlainObject(baseDocument) ||
        baseDocument.schemaVersion !== '1.0' ||
        !Array.isArray(baseDocument.items) ||
        Object.keys(baseDocument).sort().join(',') !== 'items,schemaVersion'
    ) {
        throw new Error('Gallery review base manifest has an unsupported document shape.');
    }
    const baseProblems = typeof galleryContract?.validateGalleryDocument === 'function'
        ? galleryContract.validateGalleryDocument(baseDocument)
        : ['The public Gallery contract is unavailable.'];
    if (baseProblems.length !== 0) {
        throw new Error('Gallery review base manifest does not satisfy the public Gallery contract.');
    }
    if (baseDocument.items.some(item => item?.id === candidate.itemId)) {
        throw new Error('Gallery review candidate item already exists on the base branch.');
    }
    if (candidateDocument.items.length !== baseDocument.items.length + 1) {
        throw new Error('Gallery review candidate must add exactly one manifest item.');
    }
    const survivingItems = candidateDocument.items.filter(item => item?.id !== candidate.itemId);
    if (
        survivingItems.length !== baseDocument.items.length ||
        JSON.stringify(survivingItems) !== JSON.stringify(baseDocument.items)
    ) {
        throw new Error('Gallery review candidate must preserve every existing manifest item and its order.');
    }
}

async function createOrRecoverPullRequest(github, {
    branchRef,
    branchSha,
    baseSha,
    title,
    body
}) {
    let creationError = null;
    try {
        const created = await github.request('POST', '/pulls', {
            title,
            head: branchRef,
            base: baseRef,
            body,
            draft: false,
            maintainer_can_modify: false
        });
        validateOpenPullRequest(created, {
            branchRef,
            branchSha,
            baseSha,
            title,
            body
        });
    } catch (error) {
        creationError = error;
    }

    const pulls = await listOperationPullRequests(github, branchRef);
    if (pulls.length !== 1) {
        if (creationError && pulls.length === 0) {
            throw creationError;
        }
        throw new Error('Gallery review operation did not resolve to exactly one Pull Request.');
    }

    return validateOpenPullRequest(pulls[0], {
        branchRef,
        branchSha,
        baseSha,
        title,
        body
    });
}

async function verifyOwnedCandidateBranch(github, {
    candidate,
    branchRef,
    branchSha,
    baseSha,
    commitMessage
}) {
    const currentBranchSha = await readRequiredRef(
        github,
        `heads/${branchRef}`,
        'candidate branch'
    );
    if (currentBranchSha !== branchSha) {
        throw new Error('Gallery review candidate branch changed during reconciliation.');
    }

    const commit = await github.request('GET', `/git/commits/${branchSha}`);
    const parents = Array.isArray(commit?.parents) ? commit.parents : [];
    if (
        commit?.message !== commitMessage ||
        parents.length !== 1 ||
        parents[0]?.sha !== baseSha
    ) {
        throw new Error('Gallery review candidate branch has an unknown commit or parent.');
    }

    const comparison = await github.request(
        'GET',
        `/compare/${baseSha}...${branchSha}`
    );
    const files = Array.isArray(comparison?.files) ? comparison.files : [];
    if (
        comparison?.status !== 'ahead' ||
        comparison?.ahead_by !== 1 ||
        comparison?.total_commits !== 1 ||
        files.length !== 1 ||
        files[0]?.filename !== candidate.targetRelativePath ||
        files[0]?.status !== 'modified' ||
        files[0]?.previous_filename !== undefined
    ) {
        throw new Error('Gallery review branch must differ from main by exactly one inherited manifest.');
    }

    const contents = await github.request(
        'GET',
        `/contents/${candidate.targetRelativePath}?ref=${encodeURIComponent(branchRef)}`
    );
    const branchManifestText = decodeRepositoryFile(
        contents,
        candidate.targetRelativePath,
        'candidate manifest'
    );
    if (
        branchManifestText !== candidate.manifestText ||
        sha256Revision(branchManifestText) !== candidate.manifestSha256
    ) {
        throw new Error('Gallery review candidate branch contains different manifest bytes.');
    }
}

async function verifyStoredCandidateBranch(github, review, branchSha) {
    const commit = await github.request('GET', `/git/commits/${branchSha}`);
    const parents = Array.isArray(commit?.parents) ? commit.parents : [];
    if (
        commit?.message !== `Add approved Gallery photo ${review.itemId}` ||
        parents.length !== 1 ||
        parents[0]?.sha !== review.baseSha
    ) {
        throw new Error('Stored Gallery review branch has an unknown commit or parent.');
    }

    const comparison = await github.request(
        'GET',
        `/compare/${review.baseSha}...${branchSha}`
    );
    const files = Array.isArray(comparison?.files) ? comparison.files : [];
    if (
        comparison?.status !== 'ahead' ||
        comparison?.ahead_by !== 1 ||
        comparison?.total_commits !== 1 ||
        files.length !== 1 ||
        files[0]?.filename !== review.targetRelativePath ||
        files[0]?.status !== 'modified' ||
        files[0]?.previous_filename !== undefined
    ) {
        throw new Error(
            'Stored Gallery review branch must differ from its base by exactly one inherited manifest.'
        );
    }

    const contents = await github.request(
        'GET',
        `/contents/${review.targetRelativePath}?ref=${encodeURIComponent(review.branchRef)}`
    );
    const manifestText = decodeRepositoryFile(
        contents,
        review.targetRelativePath,
        'stored candidate manifest'
    );
    if (sha256Revision(manifestText) !== review.manifestSha256) {
        throw new Error('Stored Gallery review branch contains different manifest bytes.');
    }
    let documentValue;
    try {
        documentValue = JSON.parse(manifestText);
    } catch {
        throw new Error('Stored Gallery review manifest is not valid JSON.');
    }
    const manifestProblems = typeof galleryContract?.validateGalleryDocument === 'function'
        ? galleryContract.validateGalleryDocument(documentValue)
        : ['The public Gallery contract is unavailable.'];
    if (
        manifestProblems.length !== 0 ||
        documentValue.items.filter(item => item?.id === review.itemId).length !== 1
    ) {
        throw new Error('Stored Gallery review manifest does not contain its exact valid item.');
    }
}

function storedTerminalResult(review, terminalKind, branchSha, pullRequest) {
    const pullEvidence = pullRequest === null ? null : {
        number: pullRequest.number,
        url: pullRequest.html_url,
        state: pullRequest.state,
        mergedAt: pullRequest.merged_at,
        branchRef: pullRequest.head.ref,
        headSha: pullRequest.head.sha,
        baseRef: pullRequest.base.ref
    };
    const openEvidenceHash = pullEvidence === null
        ? null
        : hashOpenPullIdentity(pullEvidence);
    const closeEvidenceHash = pullEvidence === null
        ? null
        : sha256Hex(JSON.stringify({
            operation: 'gallery-review-close-observation',
            promotionId: review.promotionId,
            pullRequest: pullEvidence
        }));
    const readbackEvidenceHash = pullEvidence === null
        ? null
        : sha256Hex(JSON.stringify({
            operation: 'gallery-review-closed-readback',
            promotionId: review.promotionId,
            pullRequest: pullEvidence
        }));
    const terminalEvidenceHash = sha256Hex(JSON.stringify({
        operation: 'gallery-review-terminal-v1',
        promotionId: review.promotionId,
        repository: repositoryFullName,
        baseSha: review.baseSha,
        branchRef: review.branchRef,
        branchSha,
        manifestSha256: review.manifestSha256,
        terminalKind,
        pullRequest: pullEvidence
    }));
    return deepFreeze({
        schemaVersion: '1.0',
        repository: repositoryFullName,
        branchRef: review.branchRef,
        branchState: branchSha === null ? 'absent' : 'retained-for-reviewed-cleanup',
        headSha: branchSha,
        terminalKind,
        terminalEvidenceHash,
        openEvidenceHash,
        closeEvidenceHash,
        readbackEvidenceHash,
        pullRequest: pullEvidence === null ? null : {
            number: pullEvidence.number,
            url: pullEvidence.url,
            state: 'closed'
        }
    });
}

function hashOpenPullIdentity(value) {
    return sha256Hex(JSON.stringify({
        operation: 'gallery-review-open-identity-v1',
        repository: repositoryFullName,
        pullRequestNumber: value.number,
        pullRequestUrl: value.url,
        branchRef: value.branchRef,
        headSha: value.headSha,
        baseRef: value.baseRef
    }));
}

function sha256Hex(value) {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function decodeRepositoryFile(contents, expectedPath, label) {
    if (
        contents?.type !== 'file' ||
        contents?.path !== expectedPath ||
        contents?.encoding !== 'base64' ||
        typeof contents?.content !== 'string'
    ) {
        throw new Error(`Gallery review ${label} could not be verified from its ref.`);
    }
    const encoded = contents.content.replace(/\s+/g, '');
    if (
        encoded.length === 0 ||
        encoded.length > Math.ceil(maximumManifestBytes / 3) * 4 + 4 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
    ) {
        throw new Error(`Gallery review ${label} has invalid encoded bytes.`);
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.byteLength > maximumManifestBytes || bytes.toString('base64') !== encoded) {
        throw new Error(`Gallery review ${label} has invalid encoded bytes.`);
    }
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        throw new Error(`Gallery review ${label} is not valid UTF-8.`);
    }
}

async function listOperationPullRequests(github, branchRef) {
    const query = new URLSearchParams({
        state: 'all',
        head: `${repositoryOwner}:${branchRef}`,
        base: baseRef,
        per_page: '10'
    });
    const pulls = await github.request('GET', `/pulls?${query}`);
    if (!Array.isArray(pulls)) {
        throw new Error('GitHub returned an invalid Pull Request collection.');
    }
    return pulls;
}

function validateOpenPullRequest(value, { branchRef, branchSha, baseSha, title, body }) {
    const number = value?.number;
    const expectedUrl = `https://github.com/${repositoryFullName}/pull/${number}`;
    if (
        !Number.isSafeInteger(number) ||
        number < 1 ||
        value?.state !== 'open' ||
        value?.merged_at !== null ||
        value?.draft !== false ||
        value?.title !== title ||
        value?.body !== body ||
        value?.html_url !== expectedUrl ||
        value?.base?.ref !== baseRef ||
        value?.base?.sha !== baseSha ||
        value?.base?.repo?.full_name !== repositoryFullName ||
        value?.head?.ref !== branchRef ||
        value?.head?.sha !== branchSha ||
        value?.head?.repo?.full_name !== repositoryFullName
    ) {
        throw new Error('Gallery review Pull Request is closed, stale, or does not match this operation.');
    }
    return value;
}

function validateReviewResult(value, candidate, expectedBaseSha) {
    requireExactKeys(value, reviewResultKeys, 'Gallery review result');
    requireExactKeys(value.pullRequest, reviewPullRequestKeys, 'Gallery review Pull Request result');
    const branchRef = deriveOwnedBranch(candidate.receipt.operationId);
    const pullNumber = value.pullRequest.number;
    if (
        value.schemaVersion !== '1.0' ||
        typeof value.replayed !== 'boolean' ||
        value.repository !== repositoryFullName ||
        value.baseRef !== baseRef ||
        validateCommitSha(value.baseSha, 'review base SHA') !== expectedBaseSha ||
        value.branchRef !== branchRef ||
        !commitShaPattern.test(stringValue(value.headSha)) ||
        value.targetRelativePath !== candidate.targetRelativePath ||
        value.itemId !== candidate.itemId ||
        value.manifestSha256 !== candidate.manifestSha256 ||
        !Number.isSafeInteger(pullNumber) ||
        pullNumber < 1 ||
        value.pullRequest.url !==
            `https://github.com/${repositoryFullName}/pull/${pullNumber}` ||
        value.pullRequest.state !== 'open'
    ) {
        throw new Error('Gallery review invalidation requires the exact created review result.');
    }
    return deepFreeze(cloneJson(value));
}

function validateStoredReview(value) {
    requireExactKeys(value, storedReviewKeys, 'Stored Gallery review');
    const promotionId = stringValue(value.promotionId);
    const branchRef = deriveOwnedBranch(promotionId);
    const operationMarkerHash = deriveOperationMarkerHash(promotionId);
    if (
        value.schemaVersion !== '1.0' ||
        !operationIdPattern.test(promotionId) ||
        value.repository !== repositoryFullName ||
        value.baseRef !== baseRef ||
        !commitShaPattern.test(stringValue(value.baseSha)) ||
        value.branchRef !== branchRef ||
        !(value.headSha === null || commitShaPattern.test(stringValue(value.headSha))) ||
        !allowedManifestPaths.has(value.targetRelativePath) ||
        !itemIdPattern.test(stringValue(value.itemId)) ||
        !sha256RevisionPattern.test(stringValue(value.manifestSha256)) ||
        value.operationMarkerHash !== operationMarkerHash
    ) {
        throw new Error('Stored Gallery review evidence is invalid.');
    }
    if (value.pullRequest !== null) {
        requireExactKeys(
            value.pullRequest,
            reviewPullRequestKeys,
            'Stored Gallery review Pull Request'
        );
        const number = value.pullRequest.number;
        if (
            value.headSha === null ||
            !Number.isSafeInteger(number) ||
            number < 1 ||
            value.pullRequest.url !==
                `https://github.com/${repositoryFullName}/pull/${number}` ||
            value.pullRequest.state !== 'open'
        ) {
            throw new Error('Stored Gallery review Pull Request evidence is invalid.');
        }
    } else if (value.headSha !== null) {
        throw new Error('A reserved Gallery review cannot supply an unbound head SHA.');
    }
    return deepFreeze(cloneJson(value));
}

function validateStoredPullRequest(value, review, branchSha, allowedStates) {
    const candidate = storedCandidate(review);
    const expectedBody = pullRequestBody(candidate, review.branchRef);
    const expectedTitle = `Add approved Gallery photo: ${review.itemId}`;
    const number = value?.number;
    const expectedUrl = `https://github.com/${repositoryFullName}/pull/${number}`;
    if (
        !allowedStates.includes(value?.state) ||
        !Number.isSafeInteger(number) ||
        number < 1 ||
        value?.merged_at !== null ||
        value?.draft !== false ||
        value?.title !== expectedTitle ||
        value?.body !== expectedBody ||
        value?.html_url !== expectedUrl ||
        value?.base?.ref !== baseRef ||
        value?.base?.repo?.full_name !== repositoryFullName ||
        value?.head?.ref !== review.branchRef ||
        value?.head?.sha !== branchSha ||
        value?.head?.repo?.full_name !== repositoryFullName ||
        review.pullRequest !== null &&
            (
                number !== review.pullRequest.number ||
                expectedUrl !== review.pullRequest.url
            )
    ) {
        throw new Error(
            'Stored Gallery review reconciliation refused a merged, changed, or unowned Pull Request.'
        );
    }
    return value;
}

function storedCandidate(review) {
    return {
        targetRelativePath: review.targetRelativePath,
        itemId: review.itemId,
        manifestSha256: review.manifestSha256,
        receipt: { operationId: review.promotionId }
    };
}

function deriveOperationMarkerHash(operationId) {
    return createHash('sha256')
        .update('family-running-gallery-review-operation-v1\0', 'utf8')
        .update(operationId, 'utf8')
        .digest('hex');
}

function validateOwnedPullRequestForInvalidation(value, candidate, review, allowedStates) {
    const title = `Add approved Gallery photo: ${candidate.itemId}`;
    const body = pullRequestBody(candidate, review.branchRef);
    const number = review.pullRequest.number;
    if (
        !allowedStates.includes(value?.state) ||
        value?.number !== number ||
        value?.merged_at !== null ||
        value?.draft !== false ||
        value?.title !== title ||
        value?.body !== body ||
        value?.html_url !== review.pullRequest.url ||
        value?.base?.ref !== baseRef ||
        value?.base?.repo?.full_name !== repositoryFullName ||
        value?.head?.ref !== review.branchRef ||
        !commitShaPattern.test(stringValue(value?.head?.sha)) ||
        value?.head?.repo?.full_name !== repositoryFullName
    ) {
        throw new Error(
            'Gallery review invalidation refused a merged, changed, or unowned Pull Request.'
        );
    }
    return value;
}

async function assertBaseStillCurrent(github, expectedBaseSha) {
    const currentBaseSha = await readRequiredRef(github, `heads/${baseRef}`, 'base branch');
    if (currentBaseSha !== expectedBaseSha) {
        throw new Error('Gallery review base branch changed during candidate reconciliation.');
    }
}

async function readRequiredRef(github, ref, label) {
    const sha = await readOptionalRef(github, ref);
    if (sha === null) {
        throw new Error(`Gallery review ${label} is missing.`);
    }
    return sha;
}

async function readOptionalRef(github, ref) {
    const response = await github.requestAllowingNotFound('GET', `/git/ref/${ref}`);
    if (response === null) {
        return null;
    }
    return validateCommitSha(response?.object?.sha, 'Git ref SHA');
}

function createFixedGitHubClient(fetchImpl, token) {
    async function execute(method, relativePath, body, allowNotFound) {
        assertAllowedApiRequest(method, relativePath, body);
        const url = `${apiOrigin}${repositoryApiPath}${relativePath}`;
        let response;
        try {
            response = await fetchImpl(url, {
                method,
                redirect: 'error',
                headers: {
                    Accept: 'application/vnd.github+json',
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'User-Agent': 'family-running-gallery-review',
                    'X-GitHub-Api-Version': apiVersion
                },
                body: body === undefined ? undefined : JSON.stringify(body)
            });
        } catch {
            throw new Error(`GitHub ${method} request did not return a response.`);
        }

        if (allowNotFound && response?.status === 404) {
            return null;
        }
        if (!response?.ok) {
            const status = Number.isSafeInteger(response?.status) ? response.status : 0;
            throw new Error(`GitHub ${method} request failed with status ${status}.`);
        }

        try {
            return await response.json();
        } catch {
            throw new Error(`GitHub ${method} request returned invalid JSON.`);
        }
    }

    return Object.freeze({
        request(method, relativePath, body) {
            return execute(method, relativePath, body, false);
        },
        requestAllowingNotFound(method, relativePath, body) {
            return execute(method, relativePath, body, true);
        }
    });
}

function assertAllowedApiRequest(method, relativePath, body) {
    const safeGetPatterns = [
        /^\/git\/ref\/heads\/main$/,
        /^\/git\/ref\/heads\/gallery-media\/candidate-[a-f0-9]{32}$/,
        /^\/git\/commits\/[a-f0-9]{40}$/,
        /^\/compare\/[a-f0-9]{40}\.\.\.[a-f0-9]{40}$/,
        /^\/contents\/gallery-data\/(?:family|everyone)\.json\?ref=[a-f0-9]{40}$/,
        /^\/contents\/gallery-data\/(?:family|everyone)\.json\?ref=gallery-media%2Fcandidate-[a-f0-9]{32}$/,
        /^\/pulls\?state=all&head=johnkevan88888%3Agallery-media%2Fcandidate-[a-f0-9]{32}&base=main&per_page=10$/,
        /^\/pulls\/[1-9][0-9]*$/
    ];
    const safePostPaths = new Set([
        '/git/blobs',
        '/git/trees',
        '/git/commits',
        '/git/refs',
        '/pulls'
    ]);

    if (method === 'GET' && body === undefined && safeGetPatterns.some(pattern => pattern.test(relativePath))) {
        return;
    }
    if (method === 'POST' && safePostPaths.has(relativePath) && isPlainObject(body)) {
        validateMutationBody(relativePath, body);
        return;
    }
    if (
        method === 'PATCH' &&
        /^\/pulls\/[1-9][0-9]*$/.test(relativePath) &&
        isPlainObject(body)
    ) {
        requireExactKeys(body, ['state'], 'Pull Request invalidation request');
        if (body.state !== 'closed') {
            throw new Error('Pull Request invalidation may only close the exact review.');
        }
        return;
    }
    throw new Error('GitHub review client refused an unsupported repository operation.');
}

function validateMutationBody(relativePath, body) {
    if (relativePath === '/git/blobs') {
        requireExactKeys(body, ['content', 'encoding'], 'Git blob request');
        if (body.encoding !== 'base64' || typeof body.content !== 'string') {
            throw new Error('Git blob request is invalid.');
        }
        return;
    }
    if (relativePath === '/git/trees') {
        requireExactKeys(body, ['base_tree', 'tree'], 'Git tree request');
        if (
            !commitShaPattern.test(stringValue(body.base_tree)) ||
            !Array.isArray(body.tree) ||
            body.tree.length !== 1 ||
            !isPlainObject(body.tree[0]) ||
            !allowedManifestPaths.has(body.tree[0].path) ||
            body.tree[0].mode !== '100644' ||
            body.tree[0].type !== 'blob' ||
            !commitShaPattern.test(stringValue(body.tree[0].sha))
        ) {
            throw new Error('Git tree request is outside the one-manifest boundary.');
        }
        requireExactKeys(body.tree[0], ['path', 'mode', 'type', 'sha'], 'Git tree entry');
        return;
    }
    if (relativePath === '/git/commits') {
        requireExactKeys(body, ['message', 'tree', 'parents'], 'Git commit request');
        if (
            typeof body.message !== 'string' ||
            !commitShaPattern.test(stringValue(body.tree)) ||
            !Array.isArray(body.parents) ||
            body.parents.length !== 1 ||
            !commitShaPattern.test(stringValue(body.parents[0]))
        ) {
            throw new Error('Git commit request is invalid.');
        }
        return;
    }
    if (relativePath === '/git/refs') {
        requireExactKeys(body, ['ref', 'sha'], 'Git ref request');
        if (
            !/^refs\/heads\/gallery-media\/candidate-[a-f0-9]{32}$/.test(stringValue(body.ref)) ||
            !commitShaPattern.test(stringValue(body.sha))
        ) {
            throw new Error('Git ref request is outside the owned candidate namespace.');
        }
        return;
    }
    if (relativePath === '/pulls') {
        requireExactKeys(
            body,
            ['title', 'head', 'base', 'body', 'draft', 'maintainer_can_modify'],
            'Pull Request creation request'
        );
        if (
            typeof body.title !== 'string' ||
            !/^gallery-media\/candidate-[a-f0-9]{32}$/.test(stringValue(body.head)) ||
            body.base !== baseRef ||
            typeof body.body !== 'string' ||
            !body.body.includes(pullRequestMarkerPrefix) ||
            body.draft !== false ||
            body.maintainer_can_modify !== false
        ) {
            throw new Error('Pull Request creation request is outside the review-only boundary.');
        }
    }
}

function validateCandidateResult(value) {
    requireExactKeys(value, candidateResultKeys, 'Gallery manifest candidate result');
    requireExactKeys(value.receipt, candidateReceiptKeys, 'Gallery manifest candidate receipt');
    if (value.changed !== true) {
        throw new Error('Gallery review creation requires a newly generated manifest candidate.');
    }
    if (!allowedManifestPaths.has(value.targetRelativePath)) {
        throw new Error('Gallery review candidate target is not an inherited manifest.');
    }
    if (
        !itemIdPattern.test(stringValue(value.itemId)) ||
        value.itemId.length > 120
    ) {
        throw new Error('Gallery review candidate itemId is invalid.');
    }
    if (
        typeof value.manifestText !== 'string' ||
        Buffer.byteLength(value.manifestText, 'utf8') > maximumManifestBytes ||
        !value.manifestText.endsWith('\n')
    ) {
        throw new Error('Gallery review candidate manifest bytes are invalid.');
    }
    if (
        !sha256RevisionPattern.test(stringValue(value.manifestSha256)) ||
        sha256Revision(value.manifestText) !== value.manifestSha256
    ) {
        throw new Error('Gallery review candidate manifest SHA-256 does not match its bytes.');
    }

    let documentValue;
    try {
        documentValue = JSON.parse(value.manifestText);
    } catch {
        throw new Error('Gallery review candidate manifest is not valid JSON.');
    }
    if (
        !isPlainObject(documentValue) ||
        documentValue.schemaVersion !== '1.0' ||
        !Array.isArray(documentValue.items) ||
        `${JSON.stringify(documentValue, null, 2)}\n` !== value.manifestText ||
        documentValue.items.filter(item => item?.id === value.itemId).length !== 1
    ) {
        throw new Error('Gallery review candidate manifest is not one canonical derived document.');
    }
    const manifestProblems = typeof galleryContract?.validateGalleryDocument === 'function'
        ? galleryContract.validateGalleryDocument(documentValue)
        : ['The public Gallery contract is unavailable.'];
    const candidateItem = documentValue.items.find(item => item?.id === value.itemId);
    if (manifestProblems.length !== 0 || candidateItem?.type !== 'photo') {
        throw new Error('Gallery review candidate is not a valid photo manifest document.');
    }

    if (
        value.receipt.schemaVersion !== '1.0' ||
        !operationIdPattern.test(stringValue(value.receipt.operationId)) ||
        value.receipt.targetRelativePath !== value.targetRelativePath ||
        value.receipt.itemId !== value.itemId ||
        value.receipt.manifestSha256 !== value.manifestSha256
    ) {
        throw new Error('Gallery review candidate receipt does not match its derived manifest.');
    }

    return deepFreeze(cloneJson(value));
}

function deriveOwnedBranch(operationId) {
    const digest = createHash('sha256')
        .update('family-running-gallery-review-branch-v1\0', 'utf8')
        .update(operationId, 'utf8')
        .digest('hex')
        .slice(0, 32);
    return `${branchPrefix}${digest}`;
}

function pullRequestBody(candidate, branchRef) {
    const operationDigest = deriveOperationMarkerHash(candidate.receipt.operationId);
    return [
        `${pullRequestMarkerPrefix}${operationDigest} -->`,
        '## Approved Gallery candidate',
        '',
        `- Manifest: \`${candidate.targetRelativePath}\``,
        `- Public item ID: \`${candidate.itemId}\``,
        `- Manifest SHA-256: \`${candidate.manifestSha256}\``,
        `- Candidate branch: \`${branchRef}\``,
        '',
        'This automated Pull Request is for review only. It does not authorize merge, deployment, or publication.'
    ].join('\n');
}

function validateCommitSha(value, label) {
    if (!commitShaPattern.test(stringValue(value))) {
        throw new Error(`Gallery review ${label} must be a 40-character Git commit SHA.`);
    }
    return value.toLowerCase();
}

function validateToken(value) {
    if (
        typeof value !== 'string' ||
        value.length < 16 ||
        value.length > 1024 ||
        /[\u0000-\u001f\u007f\s]/.test(value)
    ) {
        throw new Error('A short-lived GitHub App installation token is required.');
    }
    return value;
}

function validateFetch(value) {
    if (typeof value !== 'function') {
        throw new Error('An injected GitHub HTTPS fetch implementation is required.');
    }
    return value;
}

function sha256Revision(text) {
    return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function requireExactKeys(value, expectedKeys, label) {
    if (!isPlainObject(value)) {
        throw new Error(`${label} must be a JSON object.`);
    }
    const actual = Object.keys(value).sort();
    const expected = [...expectedKeys].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${label} must contain exactly: ${expected.join(', ')}.`);
    }
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function stringValue(value) {
    return typeof value === 'string' ? value : '';
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value, seen = new Set()) {
    if (value === null || typeof value !== 'object' || seen.has(value)) {
        return value;
    }
    seen.add(value);
    for (const child of Object.values(value)) {
        deepFreeze(child, seen);
    }
    return Object.freeze(value);
}
