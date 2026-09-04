import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    runWithdrawalFinalizationBridge,
    withdrawalFinalizationCompletionSummary
} from '../scripts/gallery-media/withdrawal-finalization-bridge.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const draftId = 'draft_12345678-1234-4123-8123-1234567890ab';
const finalizerPath = `/api/service/drafts/${draftId}/withdrawal-finalizations`;
const verifierPath =
    `/api/service/drafts/${draftId}/public-host-absence-verifications`;
const verifier = service(
    'https://gallery-verifier.example',
    'verifier-client-id.access',
    'verifier-client-secret'
);
const finalizer = service(
    'https://gallery-finalizer.example',
    'finalizer-client-id.access',
    'finalizer-client-secret'
);
const withdrawalKey = operationKey('gallery-withdrawal');
const purgeKey = operationKey('gallery-purge');
const withdrawalVerification = verificationRequest(
    8,
    'gallery-host-withdrawal-0001'
);
const purgeVerification = verificationRequest(9, 'gallery-host-purge-0001');
const publicManifestPaths = [
    path.join(root, 'gallery-data', 'family.json'),
    path.join(root, 'gallery-data', 'everyone.json'),
    path.join(root, 'gallery-data', 'hidden-athlete-ids.json')
];
const manifestsBefore = await Promise.all(
    publicManifestPaths.map(file => fs.readFile(file))
);

assert.notEqual(withdrawalKey, purgeKey);

// The withdrawal workflow can converge only the withdrawal action. It asks
// the finalizer first, obtains exactly the requested host proof, and retries
// the same deterministic action key.
const withdrawalRequests = [];
const withdrawn = await runWithdrawalFinalizationBridge({
    action: 'withdrawal',
    draftId,
    verifier,
    finalizer,
    fetchImpl: sequenceFetch(withdrawalRequests, [
        finalizerResponse(202, withdrawalVerification),
        verifierResponse(201),
        finalizerResponse(201, { status: 'withdrawn', replayed: false })
    ])
});
assert.deepEqual(withdrawn, {
    schemaVersion: '1.0',
    status: 'withdrawn',
    replayed: false
});
assert.deepEqual(
    withdrawalRequests.map(request => `${request.origin}${request.pathname}`),
    [
        `${finalizer.origin}${finalizerPath}`,
        `${verifier.origin}${verifierPath}`,
        `${finalizer.origin}${finalizerPath}`
    ]
);
assert.deepEqual(withdrawalRequests.map(request => request.body), [
    { idempotencyKey: withdrawalKey },
    {
        expectedStateVersion: withdrawalVerification.expectedStateVersion,
        idempotencyKey: withdrawalVerification.verifierIdempotencyKey
    },
    { idempotencyKey: withdrawalKey }
]);

// Purge is a separate protected run and uses a distinct key. It cannot repeat
// or initiate the withdrawal action on behalf of the other workflow.
const purgeRequests = [];
const purged = await runWithdrawalFinalizationBridge({
    action: 'purge',
    draftId,
    verifier,
    finalizer,
    fetchImpl: sequenceFetch(purgeRequests, [
        finalizerResponse(202, purgeVerification),
        verifierResponse(200, true),
        finalizerResponse(201, { status: 'purged', replayed: false })
    ])
});
assert.deepEqual(purged, {
    schemaVersion: '1.0',
    status: 'purged',
    replayed: false
});
assert.deepEqual(purgeRequests.map(request => request.body), [
    { idempotencyKey: purgeKey },
    {
        expectedStateVersion: purgeVerification.expectedStateVersion,
        idempotencyKey: purgeVerification.verifierIdempotencyKey
    },
    { idempotencyKey: purgeKey }
]);

for (const request of [...withdrawalRequests, ...purgeRequests]) {
    assert.equal(request.method, 'POST');
    assert.equal(request.contentType, 'application/json');
    assert.equal(
        request.contentLength,
        String(Buffer.byteLength(JSON.stringify(request.body)))
    );
}

// Exact reruns consult finalizer receipts first. In particular, purge replay
// remains reachable after the operational draft and review rows are gone.
const withdrawalReplayRequests = [];
const withdrawalReplay = await runWithdrawalFinalizationBridge({
    action: 'withdrawal',
    draftId,
    verifier,
    finalizer,
    fetchImpl: sequenceFetch(withdrawalReplayRequests, [
        finalizerResponse(200, { status: 'withdrawn', replayed: true })
    ])
});
assert.equal(withdrawalReplay.status, 'withdrawn');
assert.equal(withdrawalReplay.replayed, true);
assert.equal(withdrawalReplayRequests.length, 1);
assert.equal(withdrawalReplayRequests[0].origin, finalizer.origin);

const postPurgeRequests = [];
const postPurgeReplay = await runWithdrawalFinalizationBridge({
    action: 'purge',
    draftId,
    verifier,
    finalizer,
    fetchImpl: sequenceFetch(postPurgeRequests, [
        finalizerResponse(200, { status: 'purged', replayed: true })
    ])
});
assert.deepEqual(postPurgeReplay, {
    schemaVersion: '1.0',
    status: 'purged',
    replayed: true
});
assert.equal(postPurgeRequests.length, 1);
assert.equal(postPurgeRequests[0].origin, finalizer.origin);
assert.deepEqual(postPurgeRequests[0].body, { idempotencyKey: purgeKey });

const retentionRequests = [];
const retentionPending = await runWithdrawalFinalizationBridge({
    action: 'purge',
    draftId,
    verifier,
    finalizer,
    fetchImpl: sequenceFetch(retentionRequests, [
        finalizerResponse(202, {
            status: 'retention-pending',
            eligibleAt: '2026-10-03T12:34:56.789Z',
            replayed: false
        })
    ])
});
assert.deepEqual(retentionPending, {
    schemaVersion: '1.0',
    status: 'retention-pending',
    replayed: false
});
assert.equal(retentionRequests.length, 1);

// A malformed proof request must never reach the verifier.
for (const [label, malformed] of [
    ['extra field', { ...withdrawalVerification, callerChoice: 'forbidden' }],
    ['missing state version', {
        status: 'host-verification-required',
        verifierIdempotencyKey: 'gallery-host-withdrawal-0001',
        replayed: false
    }],
    ['short verifier key', {
        ...withdrawalVerification,
        verifierIdempotencyKey: 'short'
    }],
    ['replayed requirement', { ...withdrawalVerification, replayed: true }]
]) {
    const stopped = [];
    await assert.rejects(
        runWithdrawalFinalizationBridge({
            action: 'withdrawal',
            draftId,
            verifier,
            finalizer,
            fetchImpl: sequenceFetch(stopped, [finalizerResponse(202, malformed)])
        }),
        /verification request is invalid/,
        label
    );
    assert.equal(stopped.length, 1, `${label} crossed the finalizer gate.`);
}

const badVerifierRequests = [];
await assert.rejects(
    runWithdrawalFinalizationBridge({
        action: 'withdrawal',
        draftId,
        verifier,
        finalizer,
        fetchImpl: sequenceFetch(badVerifierRequests, [
            finalizerResponse(202, withdrawalVerification),
            verifierResponse(201, false, { publicUrl: 'forbidden' })
        ])
    }),
    /Public-host absence was not confirmed/
);
assert.equal(badVerifierRequests.length, 2);

// A verifier-shaped 2xx is not sufficient. The finalizer must reread its own
// durable receipt and return the exact terminal state.
const missingReceiptRequests = [];
await assert.rejects(
    runWithdrawalFinalizationBridge({
        action: 'withdrawal',
        draftId,
        verifier,
        finalizer,
        fetchImpl: sequenceFetch(missingReceiptRequests, [
            finalizerResponse(202, withdrawalVerification),
            verifierResponse(201),
            finalizerResponse(409, { error: 'evidence-not-current' })
        ])
    }),
    /protected Gallery service request failed/
);
assert.equal(missingReceiptRequests.length, 3);

const noConvergenceRequests = [];
await assert.rejects(
    runWithdrawalFinalizationBridge({
        action: 'withdrawal',
        draftId,
        verifier,
        finalizer,
        fetchImpl: sequenceFetch(noConvergenceRequests, [
            finalizerResponse(202, withdrawalVerification),
            verifierResponse(201),
            finalizerResponse(202, withdrawalVerification)
        ])
    }),
    /did not converge/
);
assert.equal(noConvergenceRequests.length, 3);

// A delivery-epoch rotation may make a just-created host receipt stale. A new
// server-derived verifier key can refresh the same protected action, while an
// identical repeated package above remains a closed failure.
const epochRefreshRequests = [];
const epochRefreshedPurge = await runWithdrawalFinalizationBridge({
    action: 'purge',
    draftId,
    verifier,
    finalizer,
    fetchImpl: sequenceFetch(epochRefreshRequests, [
        finalizerResponse(202, purgeVerification),
        verifierResponse(201),
        finalizerResponse(202, verificationRequest(
            purgeVerification.expectedStateVersion,
            'gallery-host-purge-epoch-refresh-0002'
        )),
        verifierResponse(201),
        finalizerResponse(200, { status: 'purged', replayed: false })
    ])
});
assert.equal(epochRefreshedPurge.status, 'purged');
assert.equal(epochRefreshRequests.length, 5);

for (const [label, action, responses, expectedError] of [
    ['purged is not withdrawal', 'withdrawal', [
        finalizerResponse(200, { status: 'purged', replayed: false })
    ], /withdrawal was not confirmed/],
    ['retention is not withdrawal', 'withdrawal', [
        finalizerResponse(202, {
            status: 'retention-pending',
            eligibleAt: '2026-10-03T12:34:56.789Z',
            replayed: false
        })
    ], /withdrawal was not confirmed/],
    ['withdrawn is not purge', 'purge', [
        finalizerResponse(200, { status: 'withdrawn', replayed: false })
    ], /purge was not confirmed/],
    ['wrong purged HTTP status', 'purge', [
        finalizerResponse(202, { status: 'purged', replayed: false })
    ], /purge was not confirmed/],
    ['malformed retention time', 'purge', [
        finalizerResponse(202, {
            status: 'retention-pending',
            eligibleAt: '2026-10-03',
            replayed: false
        })
    ], /purge was not confirmed/],
    ['extra purge field', 'purge', [
        finalizerResponse(201, {
            status: 'purged',
            replayed: false,
            receipt: 'forbidden'
        })
    ], /purge was not confirmed/]
]) {
    await assert.rejects(
        runWithdrawalFinalizationBridge({
            action,
            draftId,
            verifier,
            finalizer,
            fetchImpl: sequenceFetch([], responses)
        }),
        expectedError,
        label
    );
}

for (const invalidOptions of [
    {
        action: 'both', draftId, verifier, finalizer,
        fetchImpl: sequenceFetch([], [])
    },
    {
        action: 'purge', draftId, verifier,
        finalizer: { ...finalizer, origin: verifier.origin },
        fetchImpl: sequenceFetch([], [])
    },
    {
        action: 'purge', draftId, verifier, finalizer,
        callerSelectedReason: 'forbidden',
        fetchImpl: sequenceFetch([], [])
    }
]) {
    await assert.rejects(
        runWithdrawalFinalizationBridge(invalidOptions),
        /configuration is invalid/
    );
}

assert.deepEqual(withdrawalFinalizationCompletionSummary(withdrawn), {
    schemaVersion: '1.0',
    status: 'gallery-photo-withdrawal-completed'
});
assert.deepEqual(withdrawalFinalizationCompletionSummary(purged), {
    schemaVersion: '1.0',
    status: 'gallery-photo-purge-completed'
});
assert.deepEqual(withdrawalFinalizationCompletionSummary(retentionPending), {
    schemaVersion: '1.0',
    status: 'gallery-photo-retention-recorded'
});
for (const result of [withdrawn, purged, retentionPending]) {
    assert.doesNotMatch(
        JSON.stringify(withdrawalFinalizationCompletionSummary(result)),
        /draft_|hostverify_|consent|athlete|editorial|receipt|branch|pull/i
    );
}

const withdrawalWorkflowText = await fs.readFile(
    path.join(root, '.github', 'workflows', 'gallery-withdrawal-finalization.yml'),
    'utf8'
);
const purgeWorkflowText = await fs.readFile(
    path.join(root, '.github', 'workflows', 'gallery-withdrawal-purge.yml'),
    'utf8'
);
assertProtectedWorkflow(withdrawalWorkflowText, 'withdrawal');
assertProtectedWorkflow(purgeWorkflowText, 'purge');

const runnerPath = path.join(
    root,
    'scripts',
    'run-gallery-withdrawal-finalization.mjs'
);
const runnerText = await fs.readFile(runnerPath, 'utf8');
assert.match(runnerText, /requiredEnvironment\('GALLERY_FINALIZATION_ACTION'\)/);
assert.match(runnerText, /withdrawalFinalizationCompletionSummary\(result\)/);
assert.doesNotMatch(runnerText, /JSON\.stringify\(result\)|error\.message/);
assert.doesNotMatch(runnerText, /GITHUB_TOKEN|APP_PRIVATE_KEY|APP_ID|GALLERY_PROMOTION/);
const failedRunner = spawnSync(process.execPath, [runnerPath], {
    cwd: root,
    env: {
        ...process.env,
        GALLERY_FINALIZATION_ACTION: 'both',
        GALLERY_DRAFT_ID: 'secret-invalid-draft-value',
        GALLERY_WITHDRAWAL_FINALIZER_ORIGIN: 'secret-invalid-origin-value'
    },
    encoding: 'utf8'
});
assert.equal(failedRunner.status, 1);
assert.equal(failedRunner.stdout, '');
assert.equal(failedRunner.stderr, 'Gallery photo finalization failed.\n');
assert.doesNotMatch(failedRunner.stderr, /secret-invalid|both/);
const argumentFailure = spawnSync(process.execPath, [runnerPath, draftId], {
    cwd: root,
    env: process.env,
    encoding: 'utf8'
});
assert.equal(argumentFailure.status, 1);
assert.equal(argumentFailure.stdout, '');
assert.equal(argumentFailure.stderr, 'Gallery photo finalization failed.\n');
assert.doesNotMatch(argumentFailure.stderr, /draft_|\.mjs|Error:/);

assert.deepEqual(
    await Promise.all(publicManifestPaths.map(file => fs.readFile(file))),
    manifestsBefore,
    'Finalization orchestration must not edit public Gallery files.'
);

console.log(
    'Gallery withdrawal finalization bridge: separate finalizer-first ' +
    'withdrawal and purge approvals, verifier convergence, post-purge replay, ' +
    'protected workflows, and non-identifying runner logs passed.'
);

function assertProtectedWorkflow(text, action) {
    const otherAction = action === 'withdrawal' ? 'purge' : 'withdrawal';
    assert.match(text, /^on:\s*\n  workflow_dispatch:/m);
    assert.doesNotMatch(text, /^  (?:push|pull_request|schedule|repository_dispatch):/m);
    assert.match(text, /inputs:\s*\n      draft_id:/);
    assert.doesNotMatch(
        text,
        /\n      (?:action|site|destination|filename|caption|athlete|consent|reason|kind|state_version|pull_request):/i
    );
    assert.match(text, /permissions:\s*\n  contents: read/);
    assert.doesNotMatch(text, /contents:\s*write|pull-requests:\s*write/i);
    assert.match(text, /group: gallery-photo-\$\{\{ inputs\.draft_id \}\}/);
    assert.match(
        text,
        /github\.repository == 'johnkevan88888\/family-running' && github\.ref == 'refs\/heads\/main'/
    );
    assert.match(text, /environment:\s*gallery-finalization/);
    assert.match(text, /persist-credentials:\s*false/);
    assert.match(
        text,
        new RegExp(`GALLERY_FINALIZATION_ACTION:\\s*${action}(?:\\r?\\n|$)`)
    );
    assert.doesNotMatch(
        text,
        new RegExp(`GALLERY_FINALIZATION_ACTION:\\s*${otherAction}(?:\\r?\\n|$)`)
    );
    assert.doesNotMatch(text, /GALLERY_FINALIZATION_ACTION:\s*\$\{\{/);
    assert.doesNotMatch(text, /create-github-app-token|GITHUB_TOKEN|APP_PRIVATE_KEY|APP_ID/i);
    assert.doesNotMatch(text, /GALLERY_PROMOTION|photo-review-invalidation/i);
    assert.doesNotMatch(text, /git\s+push|gh\s+|merge|deploy|wrangler|delete.*ref/i);
    for (const line of text.split(/\r?\n/).filter(value => /uses:/.test(value))) {
        assert.match(line, /@[a-f0-9]{40}(?:\s|$)/, `Action is not pinned: ${line}`);
    }
    assert.deepEqual(
        [...text.matchAll(/secrets\.([A-Z0-9_]+)/g)]
            .map(match => match[1]).sort(),
        [
            'GALLERY_PUBLIC_HOST_VERIFIER_ACCESS_CLIENT_ID',
            'GALLERY_PUBLIC_HOST_VERIFIER_ACCESS_CLIENT_SECRET',
            'GALLERY_PUBLIC_HOST_VERIFIER_ORIGIN',
            'GALLERY_WITHDRAWAL_FINALIZER_ACCESS_CLIENT_ID',
            'GALLERY_WITHDRAWAL_FINALIZER_ACCESS_CLIENT_SECRET',
            'GALLERY_WITHDRAWAL_FINALIZER_ORIGIN'
        ].sort()
    );
}

function service(origin, clientId, clientSecret) {
    return Object.freeze({ origin, clientId, clientSecret });
}

function verificationRequest(expectedStateVersion, verifierIdempotencyKey) {
    return Object.freeze({
        status: 'host-verification-required',
        expectedStateVersion,
        verifierIdempotencyKey,
        replayed: false
    });
}

function finalizerResponse(status, body) {
    return { origin: finalizer.origin, status, body };
}

function verifierResponse(status, replayed = false, extra = {}) {
    return {
        origin: verifier.origin,
        status,
        body: {
            verificationId: `hostverify_${'3'.repeat(32)}`,
            hostDeletionConfirmed: true,
            replayed,
            ...extra
        }
    };
}

function sequenceFetch(requestsList, responses) {
    let responseIndex = 0;
    return async (url, init) => {
        const expected = responses[responseIndex];
        assert.ok(expected, 'The runner made an unexpected extra request.');
        responseIndex += 1;
        const parsed = new URL(url);
        assert.equal(parsed.origin, expected.origin);
        assert.equal(
            parsed.pathname,
            parsed.origin === verifier.origin ? verifierPath : finalizerPath
        );
        const configuration = parsed.origin === verifier.origin
            ? verifier
            : finalizer;
        const headers = new Headers(init.headers);
        assert.equal(headers.get('CF-Access-Client-Id'), configuration.clientId);
        assert.equal(
            headers.get('CF-Access-Client-Secret'),
            configuration.clientSecret
        );
        assert.equal(init.redirect, 'error');
        assert.equal(init.cache, 'no-store');
        assert.equal(init.credentials, 'omit');
        assert.ok(init.signal instanceof AbortSignal);
        const body = JSON.parse(init.body);
        requestsList.push({
            origin: parsed.origin,
            pathname: parsed.pathname,
            method: init.method,
            body,
            contentType: headers.get('Content-Type'),
            contentLength: headers.get('Content-Length')
        });
        return jsonResponse(expected.status, expected.body);
    };
}

function operationKey(label) {
    return `${label}-${createHash('sha256')
        .update(`${label}:${draftId}`)
        .digest('hex')
        .slice(0, 32)}`;
}

function jsonResponse(status, body) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
        }
    });
}
