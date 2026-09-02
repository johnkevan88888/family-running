import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    photoInvalidationCompletionSummary,
    runPhotoReviewInvalidationBridge
} from '../scripts/gallery-media/photo-review-invalidation-bridge.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const draftId = 'draft_12345678-1234-4123-8123-1234567890ab';
const reviewId = `review_${'1'.repeat(32)}`;
const promotionId = `promotion_${'2'.repeat(32)}`;
const processingRunId = `run_${'3'.repeat(12)}4${'4'.repeat(3)}8${'5'.repeat(15)}`;
const processingOrigin = 'https://gallery-processing.example';
const promotionOrigin = 'https://gallery-promotion.example';
const access = {
    clientId: 'photo-invalidation-client-id.access',
    clientSecret: 'photo-invalidation-client-secret'
};
const branchRef = `gallery-media/candidate-${createHash('sha256')
    .update('family-running-gallery-review-branch-v1\0', 'utf8')
    .update(promotionId, 'utf8')
    .digest('hex')
    .slice(0, 32)}`;
const operationMarkerHash = createHash('sha256')
    .update('family-running-gallery-review-operation-v1\0', 'utf8')
    .update(promotionId, 'utf8')
    .digest('hex');
const pullRequestNumber = 456;
const pullRequestUrl =
    `https://github.com/johnkevan88888/family-running/pull/${pullRequestNumber}`;
const headSha = '6'.repeat(40);
const cleanup = {
    promotionId,
    expectedStateVersion: 4,
    idempotencyKey: `photo-review-cleanup-${'7'.repeat(32)}`
};
const processingCleanup = {
    processingRunId,
    expectedStateVersion: 4,
    idempotencyKey: `photo-review-staging-${'8'.repeat(32)}`
};
const abandonment = {
    schemaVersion: '1.0',
    draftId,
    promotionId,
    processingRunId,
    expectedStateVersion: 3,
    resultStateVersion: 4,
    failureEvidenceHash: '0'.repeat(64),
    status: 'withdrawal-pending'
};
const openReview = reviewEvidence('open');
const terminal = {
    terminalKind: 'closed-unmerged',
    terminalEvidenceHash: '9'.repeat(64),
    closeEvidenceHash: 'a'.repeat(64),
    readbackEvidenceHash: 'b'.repeat(64),
    headSha,
    pullRequest: {
        number: pullRequestNumber,
        url: pullRequestUrl,
        state: 'closed'
    }
};

const publicManifestPaths = [
    path.join(root, 'gallery-data', 'family.json'),
    path.join(root, 'gallery-data', 'everyone.json')
];
const manifestsBefore = await Promise.all(publicManifestPaths.map(file => fs.readFile(file)));
const requests = [];
const result = await runPhotoReviewInvalidationBridge({
    draftId,
    githubToken: 'short-lived-test-token',
    processing: { origin: processingOrigin, ...access },
    promotion: { origin: promotionOrigin, ...access },
    fetchImpl: serviceFetch(requests, openReview),
    reconcileReview: async (stored, options) => {
        assert.equal(
            requests.at(-1).pathname,
            `/api/service/photo-promotions/${promotionId}/cleanup`,
            'Approved media must be removed before any GitHub reconciliation.'
        );
        assert.deepEqual(Object.keys(options).sort(), ['fetchImpl', 'token']);
        assert.equal(options.token, 'short-lived-test-token');
        assert.deepEqual(stored.pullRequest, {
            number: pullRequestNumber,
            url: pullRequestUrl,
            state: 'open'
        });
        assert.equal(stored.branchRef, branchRef);
        assert.equal(stored.headSha, headSha);
        return terminal;
    }
});

assert.deepEqual(result, {
    schemaVersion: '1.0',
    draftId,
    reviewId,
    terminalKind: 'closed-unmerged',
    withdrawalKind: 'consent-withdrawal',
    approvedMediaStatus: 'cleaned',
    stagingStatus: 'cleaned',
    branchState: 'retained-for-reviewed-cleanup'
});
assert.deepEqual(requests.map(request => `${request.method} ${request.pathname}`), [
    `GET /api/service/drafts/${draftId}/photo-review-invalidation`,
    `POST /api/service/photo-promotions/${promotionId}/cleanup`,
    `POST /api/service/photo-reviews/${reviewId}/terminal`,
    `POST /api/service/processing-runs/${processingRunId}/cleanup`
]);
assert.deepEqual(requests[1].body, {
    expectedStateVersion: 4,
    idempotencyKey: cleanup.idempotencyKey
});
assert.deepEqual(requests[3].body, {
    expectedStateVersion: 4,
    idempotencyKey: processingCleanup.idempotencyKey
});

const outageRequests = [];
await assert.rejects(
    runPhotoReviewInvalidationBridge({
        draftId,
        githubToken: 'short-lived-test-token',
        processing: { origin: processingOrigin, ...access },
        promotion: { origin: promotionOrigin, ...access },
        fetchImpl: serviceFetch(outageRequests, openReview),
        reconcileReview: async () => {
            assert.equal(
                outageRequests.at(-1).pathname,
                `/api/service/photo-promotions/${promotionId}/cleanup`
            );
            throw new Error('synthetic GitHub outage');
        }
    }),
    /Approved Gallery media is removed, but exact Pull Request closure is still pending/
);
assert.deepEqual(outageRequests.map(request => request.pathname), [
    `/api/service/drafts/${draftId}/photo-review-invalidation`,
    `/api/service/photo-promotions/${promotionId}/cleanup`
]);

let replayReconciliationCalled = false;
const replayRequests = [];
const terminalReview = reviewEvidence('terminal');
const replayResult = await runPhotoReviewInvalidationBridge({
    draftId,
    githubToken: 'short-lived-test-token',
    processing: { origin: processingOrigin, ...access },
    promotion: { origin: promotionOrigin, ...access },
    fetchImpl: serviceFetch(replayRequests, terminalReview),
    reconcileReview: async () => {
        replayReconciliationCalled = true;
    }
});
assert.equal(replayReconciliationCalled, false);
assert.equal(replayResult.terminalKind, 'closed-unmerged');
assert.deepEqual(replayRequests.map(request => request.pathname), [
    `/api/service/drafts/${draftId}/photo-review-invalidation`,
    `/api/service/photo-promotions/${promotionId}/cleanup`,
    `/api/service/processing-runs/${processingRunId}/cleanup`
]);

// The immediate review workflow may have committed an abandonment receipt and
// then lost its HTTP response. A later draft-only run must replay that durable
// receipt, remove approved media before staging, and never touch GitHub.
let abandonmentReconciliationCalled = false;
const abandonmentRequests = [];
const abandonmentResult = await runPhotoReviewInvalidationBridge({
    draftId,
    githubToken: 'short-lived-test-token',
    processing: { origin: processingOrigin, ...access },
    promotion: { origin: promotionOrigin, ...access },
    fetchImpl: abandonmentServiceFetch(abandonmentRequests),
    reconcileReview: async () => {
        abandonmentReconciliationCalled = true;
        throw new Error('GitHub must not be called for an abandonment receipt.');
    }
});
assert.equal(abandonmentReconciliationCalled, false);
assert.deepEqual(abandonmentResult, {
    schemaVersion: '1.0',
    draftId,
    abandonmentStatus: 'withdrawal-pending',
    approvedMediaStatus: 'cleaned',
    stagingStatus: 'cleaned',
    branchState: 'no-reviewed-pr'
});
assert.deepEqual(
    abandonmentRequests.map(request => `${request.method} ${request.pathname}`),
    [
        `GET /api/service/drafts/${draftId}/photo-review-invalidation`,
        `POST /api/service/photo-promotions/${promotionId}/cleanup`,
        `POST /api/service/processing-runs/${processingRunId}/cleanup`
    ]
);
assert.equal(abandonmentRequests[0].body, null, 'The recovery read must be bodyless.');
assert.deepEqual(abandonmentRequests[1].body, {
    expectedStateVersion: abandonment.resultStateVersion,
    idempotencyKey: cleanup.idempotencyKey
});
assert.deepEqual(abandonmentRequests[2].body, {
    expectedStateVersion: abandonment.resultStateVersion,
    idempotencyKey: processingCleanup.idempotencyKey
});

await assert.rejects(
    runPhotoReviewInvalidationBridge({
        draftId,
        githubToken: 'short-lived-test-token',
        processing: { origin: processingOrigin, ...access },
        promotion: { origin: promotionOrigin, ...access },
        fetchImpl: serviceFetch([], openReview, { unexpected: true }),
        reconcileReview: async () => terminal
    }),
    /exact review invalidation receipt/
);
await assert.rejects(
    runPhotoReviewInvalidationBridge({
        draftId,
        githubToken: 'short-lived-test-token',
        processing: { origin: processingOrigin, ...access },
        promotion: { origin: promotionOrigin, ...access },
        fetchImpl: abandonmentServiceFetch([], { unexpected: true }),
        reconcileReview: async () => terminal
    }),
    /exact abandonment receipt/
);

const workflowText = await fs.readFile(
    path.join(root, '.github', 'workflows', 'gallery-media-invalidation.yml'),
    'utf8'
);
assert.match(workflowText, /environment:\s*gallery-processing/);
assert.match(workflowText, /inputs:\s*\n\s+draft_id:/);
assert.doesNotMatch(
    workflowText,
    /\n\s{6}(?:site|destination|filename|caption|athlete|consent|reason|pull_request):/i
);
assert.match(workflowText, /persist-credentials:\s*false/);
assert.doesNotMatch(workflowText, /uses:\s+[^\s]+@v\d/);
assert.doesNotMatch(workflowText, /git\s+push|merge|deploy|wrangler|delete.*ref/i);

assert.deepEqual(photoInvalidationCompletionSummary(), {
    schemaVersion: '1.0',
    status: 'gallery-photo-invalidation-completed'
});
const invalidationRunnerText = await fs.readFile(
    path.join(root, 'scripts', 'run-gallery-photo-invalidation.mjs'),
    'utf8'
);
assert.match(invalidationRunnerText, /photoInvalidationCompletionSummary\(\)/);
assert.doesNotMatch(invalidationRunnerText, /JSON\.stringify\(result\)/);
assert.doesNotMatch(
    JSON.stringify(photoInvalidationCompletionSummary()),
    /draft|review|withdrawal|consent|athlete|editorial|branch|pull/i
);

assert.deepEqual(
    await Promise.all(publicManifestPaths.map(file => fs.readFile(file))),
    manifestsBefore,
    'Invalidation must not edit either public manifest locally.'
);

console.log(
    'Gallery photo review invalidation: host-first cleanup, exact PR closure, ' +
    'GitHub-outage privacy behavior, terminal replay, delayed abandonment ' +
    'cleanup, and workflow boundary passed.'
);

function reviewEvidence(status) {
    const terminalState = status === 'terminal';
    return {
        schemaVersion: '1.0',
        reviewId,
        draftId,
        promotionId,
        processingRunId,
        candidateStateVersion: 3,
        candidatePayloadHash: 'c'.repeat(64),
        generationFingerprint: 'd'.repeat(64),
        repository: 'johnkevan88888/family-running',
        baseRef: 'main',
        baseSha: 'e'.repeat(40),
        branchRef,
        targetRelativePath: 'gallery-data/family.json',
        itemId: 'photo-invalidation-test',
        manifestSha256: `sha256:${'f'.repeat(64)}`,
        operationMarkerHash,
        workflowRunReference:
            'https://github.com/johnkevan88888/family-running/actions/runs/123/attempts/1',
        status,
        pullRequestNumber,
        pullRequestUrl,
        headSha,
        openEvidenceHash: '1'.repeat(64),
        terminalKind: terminalState ? terminal.terminalKind : null,
        terminalEvidenceHash: terminalState ? terminal.terminalEvidenceHash : null,
        closeEvidenceHash: terminalState ? terminal.closeEvidenceHash : null,
        readbackEvidenceHash: terminalState ? terminal.readbackEvidenceHash : null
    };
}

function serviceFetch(requestsList, review, extraReceiptFields = {}) {
    return async (url, init) => {
        const parsed = new URL(url);
        const headers = new Headers(init.headers);
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
        assert.equal(headers.get('CF-Access-Client-Id'), access.clientId);
        assert.equal(headers.get('CF-Access-Client-Secret'), access.clientSecret);
        requestsList.push({
            origin: parsed.origin,
            pathname: parsed.pathname,
            method: init.method,
            body
        });
        if (parsed.pathname.endsWith('/photo-review-invalidation')) {
            return jsonResponse(200, {
                receiptKind: 'review',
                review,
                invalidation: {
                    withdrawalKind: 'consent-withdrawal',
                    terminalKind: 'closed-unmerged',
                    cleanup,
                    processingCleanup
                },
                replayed: true,
                ...extraReceiptFields
            });
        }
        if (parsed.pathname === `/api/service/photo-promotions/${promotionId}/cleanup`) {
            return jsonResponse(200, {
                promotionId,
                cleanupReason: 'consent-withdrawal',
                promotionStatus: 'cleaned',
                replayed: false
            });
        }
        if (parsed.pathname === `/api/service/photo-reviews/${reviewId}/terminal`) {
            return jsonResponse(201, {
                review: reviewEvidence('terminal'),
                cleanup,
                processingCleanup,
                replayed: false
            });
        }
        if (parsed.pathname ===
            `/api/service/processing-runs/${processingRunId}/cleanup`) {
            return jsonResponse(200, {
                processingRunId,
                cleanupReason: 'consent-withdrawal',
                status: 'cleaned',
                replayed: false
            });
        }
        throw new Error(`Unexpected invalidation request ${init.method} ${parsed.pathname}`);
    };
}

function abandonmentServiceFetch(requestsList, extraReceiptFields = {}) {
    return async (url, init) => {
        const parsed = new URL(url);
        const headers = new Headers(init.headers);
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
        assert.equal(headers.get('CF-Access-Client-Id'), access.clientId);
        assert.equal(headers.get('CF-Access-Client-Secret'), access.clientSecret);
        requestsList.push({
            origin: parsed.origin,
            pathname: parsed.pathname,
            method: init.method,
            body
        });
        if (parsed.pathname.endsWith('/photo-review-invalidation')) {
            return jsonResponse(200, {
                receiptKind: 'abandonment',
                abandonment,
                cleanup,
                processingCleanup,
                replayed: true,
                ...extraReceiptFields
            });
        }
        if (parsed.pathname === `/api/service/photo-promotions/${promotionId}/cleanup`) {
            return jsonResponse(200, {
                promotionId,
                cleanupReason: 'editorial-removal',
                promotionStatus: 'cleaned',
                replayed: true
            });
        }
        if (parsed.pathname ===
            `/api/service/processing-runs/${processingRunId}/cleanup`) {
            return jsonResponse(200, {
                processingRunId,
                cleanupReason: 'editorial-removal',
                status: 'cleaned',
                replayed: true
            });
        }
        throw new Error(`Unexpected abandonment request ${init.method} ${parsed.pathname}`);
    };
}

function jsonResponse(status, value) {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}
