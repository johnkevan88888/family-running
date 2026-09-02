import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough } from 'node:stream';

import catalogSnapshot from '../gallery-admin/generated/catalog-snapshot.js';
import {
    buildV1PrivateOriginalKey,
    buildV1StagingDerivativeKey
} from '../gallery-admin/src/storage-keys.js';
import {
    PROCESSING_REHEARSAL_FIXTURE
} from '../gallery-admin/src/processing-rehearsal-faults.js';
import * as remoteRehearsal from '../scripts/rehearse-gallery-phase-d-remote.mjs';

const {
    galleryPhaseDRemoteRehearsalContract,
    galleryPhaseDRemoteRehearsalTestHooks,
    runGalleryPhaseDRemoteRehearsal,
    runGalleryPhaseDRemoteRehearsalWithLocalDefaults
} = remoteRehearsal;

const processingOrigin =
    'https://family-running-gallery-processing-dev.family-running.workers.dev';
const serviceToken = Object.freeze({
    clientId: `${'a'.repeat(32)}.access`,
    clientSecret: 'b'.repeat(64)
});
const draftId = 'draft_00000000-0000-4000-8000-000000000001';
const uploadId = 'upload_00000000000040008000000000000001';
const uploadedAt = '2026-08-28T12:00:00.000Z';
const sourceBytes = Buffer.from('synthetic remote phase d source bytes', 'utf8');
const sourceSha256 = sha256(sourceBytes);
const originalObjectKey = buildV1PrivateOriginalKey({
    site: 'family',
    uploadedAt,
    draftId,
    uploadId,
    extension: 'jpg'
});
const displayBytes = Buffer.from('synthetic display webp bytes', 'utf8');
const thumbnailBytes = Buffer.from('synthetic thumbnail webp bytes', 'utf8');
const exactSentinelBytes = Buffer.from(
    'family-running synthetic phase-d prefix sentinel v1\n',
    'utf8'
);
const exactSentinelSha256 =
    '44752564755a237248ea51a331e9a90fea023bed1e6e6f2545aaede8dd366529';
const runIds = Array.from({ length: 6 }, (_, index) => makeRunId(index + 1));
const scenarioDRecoveryPlan = Object.freeze([
    Object.freeze({
        key: 'a', startExpectedStateVersion: 3, processingStateVersion: 4,
        failedStateVersion: 5, approvedStateVersion: 6, cleanupOutputCount: 0
    }),
    Object.freeze({
        key: 'b', startExpectedStateVersion: 6, processingStateVersion: 7,
        failedStateVersion: 8, approvedStateVersion: 9, cleanupOutputCount: 1
    }),
    Object.freeze({
        key: 'c', startExpectedStateVersion: 9, processingStateVersion: 10,
        failedStateVersion: 11, approvedStateVersion: 12, cleanupOutputCount: 1
    }),
    Object.freeze({
        key: 'd', startExpectedStateVersion: 12, processingStateVersion: 13,
        failedStateVersion: 14, approvedStateVersion: 15, cleanupOutputCount: 1
    })
]);
const scenarioDOutputSha256 = sha256(displayBytes);
const scenarioDStagingObjectKey = buildV1StagingDerivativeKey({
    site: 'family',
    draftId,
    processingRunId: runIds[3],
    sha256: scenarioDOutputSha256,
    role: 'photo-display'
});
const migrationNames = Object.freeze([
    '0001_private_gallery.sql',
    '0002_private_uploads.sql',
    '0003_private_original_v1_keys.sql',
    '0004_private_processing_staging.sql',
    '0005_private_processing_cleanup.sql',
    '0006_transition_receipt_state_version.sql'
]);
const migrationSources = await Promise.all(migrationNames.map(migrationName =>
    readFile(
        new URL(`../gallery-admin/migrations/${migrationName}`, import.meta.url),
        'utf8'
    )
));

assert.deepEqual(galleryPhaseDRemoteRehearsalContract.faultValues, [
    'after-upload-part',
    'after-complete',
    'after-abort',
    'after-delete'
]);
assert.equal('createGalleryPhaseDWranglerRunner' in remoteRehearsal, false);
assert.equal(
    galleryPhaseDRemoteRehearsalContract.eligibleMarker,
    'synthetic-phase-d-race-rehearsal'
);
assert.equal(
    galleryPhaseDRemoteRehearsalContract.adminConfigPath,
    'gallery-admin/wrangler.admin.local.jsonc'
);
assert.equal(
    galleryPhaseDRemoteRehearsalContract.trustedProcessingOrigin,
    'https://family-running-gallery-processing-dev.family-running.workers.dev'
);
assert.equal(
    galleryPhaseDRemoteRehearsalContract.databaseName,
    'family-running-gallery-dev'
);
assert.equal(
    galleryPhaseDRemoteRehearsalContract.processingWorkerName,
    'family-running-gallery-processing-dev'
);
assert.deepEqual(
    galleryPhaseDRemoteRehearsalContract.fixture,
    PROCESSING_REHEARSAL_FIXTURE
);
assert.deepEqual(galleryPhaseDRemoteRehearsalContract.timeouts, {
    serviceRequestMilliseconds: 30_000,
    wranglerCommandMilliseconds: 60_000,
    wranglerKillGraceMilliseconds: 2_000
});

const expectedReport = {
    status: 'passed',
    scenarioCount: 6,
    cleanupCount: 5,
    derivativePutCount: 4,
    interruptedRequestCount: 5,
    scenarios: [
        { scenario: 'failed-no-output', status: 'passed' },
        { scenario: 'lost-upload-part', status: 'passed' },
        { scenario: 'abort-wins-lost-abort', status: 'passed' },
        { scenario: 'complete-wins-lost-delete', status: 'passed' },
        { scenario: 'exact-prefix-refusal', status: 'passed' },
        { scenario: 'final-staged', status: 'passed' }
    ],
    finalStatus: 'staged',
    approvedReferenceCount: 0,
    publicationReferenceCount: 0,
    publicwardDraftCount: 0,
    foreignKeyViolationCount: 0
};

const harness = createHarness();
const report = await runGalleryPhaseDRemoteRehearsal({
    serviceToken,
    processingOrigin,
    fetchImpl: harness.fetchImpl,
    wranglerRunner: harness.wranglerRunner,
    processPhoto: harness.processPhoto
});

assert.deepEqual(report, expectedReport);
assert.equal(Object.isFrozen(report), true);
assert.equal(Object.isFrozen(report.scenarios), true);
assert.equal(harness.processCalls.length, 5);
assert.equal(harness.sentinelStored, false);

const safeRequestSequence = harness.requests.map(request => ({
    method: request.method,
    pathname: request.pathname,
    fault: request.fault,
    status: request.status
}));
const scenarioBUploads = harness.requests.filter(request =>
    request.pathname ===
        `/api/service/processing-runs/${runIds[1]}/derivatives/photo-display`
);
assert.equal(scenarioBUploads.length, 2);
assert.deepEqual(
    scenarioBUploads.map(request => ({
        bodySha256: request.bodySha256,
        byteLength: request.byteLength,
        contentSha256: request.contentSha256,
        contentLength: request.contentLength,
        idempotencyKey: request.idempotencyKey
    })),
    [0, 1].map(() => ({
        bodySha256: sha256(displayBytes),
        byteLength: displayBytes.byteLength,
        contentSha256: sha256(displayBytes),
        contentLength: String(displayBytes.byteLength),
        idempotencyKey: 'phase-d-remote-b-display-0001'
    }))
);
assert.deepEqual(
    safeRequestSequence.filter(request => request.fault !== null),
    [
        {
            method: 'PUT',
            pathname: `/api/service/processing-runs/${runIds[1]}/derivatives/photo-display`,
            fault: 'after-upload-part',
            status: 503
        },
        {
            method: 'PUT',
            pathname: `/api/service/processing-runs/${runIds[2]}/derivatives/photo-display`,
            fault: 'after-upload-part',
            status: 503
        },
        {
            method: 'POST',
            pathname: `/api/service/processing-runs/${runIds[2]}/cleanup`,
            fault: 'after-abort',
            status: 503
        },
        {
            method: 'PUT',
            pathname: `/api/service/processing-runs/${runIds[3]}/derivatives/photo-display`,
            fault: 'after-complete',
            status: 503
        },
        {
            method: 'POST',
            pathname: `/api/service/processing-runs/${runIds[3]}/cleanup`,
            fault: 'after-delete',
            status: 503
        }
    ]
);
for (const faultRequest of safeRequestSequence.filter(request => request.fault !== null)) {
    assert.equal(faultRequest.status, 503);
}
assert.deepEqual(
    safeRequestSequence.filter(request => request.pathname.endsWith('/retry')),
    runIds.slice(0, 5).map(processingRunId => ({
        method: 'POST',
        pathname: `/api/service/processing-runs/${processingRunId}/retry`,
        fault: null,
        status: 200
    }))
);
assert.deepEqual(
    safeRequestSequence.filter(request =>
        request.pathname.endsWith('/cleanup') && request.status === 200
    ).map(request => request.pathname),
    [
        `/api/service/processing-runs/${runIds[2]}/cleanup`,
        `/api/service/processing-runs/${runIds[3]}/cleanup`,
        `/api/service/processing-runs/${runIds[4]}/cleanup`
    ]
);
assert.equal(
    safeRequestSequence.at(-1).pathname,
    `/api/service/processing-runs/${runIds[5]}/result`
);
assert.equal(safeRequestSequence.at(-1).status, 200);

const runnerKinds = harness.runnerCalls.map(call => call.kind);
assert.equal(runnerKinds.filter(kind => kind === 'staging-put-sentinel').length, 1);
assert.equal(runnerKinds.filter(kind => kind === 'staging-get-sentinel').length, 1);
assert.equal(runnerKinds.filter(kind => kind === 'staging-delete-sentinel').length, 1);
assert.equal(
    harness.runnerCalls.every(call =>
        call.kind === 'd1-json' ||
        call.bucketName === 'family-running-gallery-staging-dev'
    ),
    true
);
assert.equal(
    harness.runnerCalls.some(call =>
        JSON.stringify(call).includes('approved') && call.kind !== 'd1-json'
    ),
    false
);
assert.equal(
    harness.requests.every(request => request.origin === processingOrigin),
    true
);

// Every generated read-only D1 query is prepared and executed by real SQLite
// against the exact six-migration schema. This catches malformed SQL that a
// string-allowlist mock cannot detect.
const schemaDatabase = new DatabaseSync(':memory:');
schemaDatabase.exec('PRAGMA foreign_keys = ON;');
for (const migrationSource of migrationSources) {
    schemaDatabase.exec(migrationSource);
}
const generatedD1Calls = harness.runnerCalls.filter(call => call.kind === 'd1-json');
assert.deepEqual([...new Set(generatedD1Calls.map(call => call.label))].sort(), [
    'boundary-after',
    'boundary-before',
    'cleaned-run-evidence',
    'discover-fixture',
    'final-staged-evidence',
    'foreign-key-check',
    'prefix-refusal-evidence',
    'retry-duplicates-preflight',
    'retry-index-preflight'
]);
for (const call of generatedD1Calls) {
    assert.doesNotThrow(() => schemaDatabase.prepare(call.sql).all(), call.label);
}
schemaDatabase.close();

assert.equal(
    harness.runnerCalls.some(call =>
        call.kind === 'd1-json' &&
        (/^reset-/.test(call.label) || /UPDATE\s+gallery_drafts/i.test(call.sql))
    ),
    false
);

const serializedSafeEvidence = JSON.stringify(report);
assert.doesNotMatch(serializedSafeEvidence, new RegExp(serviceToken.clientId, 'i'));
assert.doesNotMatch(serializedSafeEvidence, new RegExp(serviceToken.clientSecret, 'i'));
assert.doesNotMatch(serializedSafeEvidence, /private-originals\/v1/i);
assert.doesNotMatch(serializedSafeEvidence, /athlete/i);
assert.doesNotMatch(serializedSafeEvidence, /draft_|run_|derivative-staging|provider/i);

// The callable surface rejects every attempt to add a caller-selected media
// identity or destination before either fetch or Wrangler can run.
for (const forbidden of [
    { site: 'everyone' },
    { athleteId: 'runner-1' },
    { draftId },
    { runId: runIds[0] },
    { objectKey: 'derivative-staging/v1/forged' },
    { providerUploadId: 'provider-forged' }
]) {
    let fetchCount = 0;
    let runnerCount = 0;
    await assert.rejects(
        () => runGalleryPhaseDRemoteRehearsal({
            serviceToken,
            processingOrigin,
            fetchImpl: async () => {
                fetchCount += 1;
                return new Response(null, { status: 503 });
            },
            wranglerRunner: async () => {
                runnerCount += 1;
                return [];
            },
            processPhoto: async () => null,
            ...forbidden
        }),
        /invalid-rehearsal-options/
    );
    assert.equal(fetchCount, 0);
    assert.equal(runnerCount, 0);
}

for (const untrustedOrigin of [
    'https://example.com',
    'https://family-running-gallery-processing-dev.attacker-account.workers.dev'
]) {
    let fetchCount = 0;
    let runnerCount = 0;
    await assert.rejects(
        () => runGalleryPhaseDRemoteRehearsal({
            serviceToken,
            processingOrigin: untrustedOrigin,
            fetchImpl: async () => {
                fetchCount += 1;
                return new Response(null, { status: 503 });
            },
            wranglerRunner: async () => {
                runnerCount += 1;
                return [];
            },
            processPhoto: async () => null
        }),
        /invalid-rehearsal-options/
    );
    assert.equal(fetchCount, 0);
    assert.equal(runnerCount, 0);
}
await assert.rejects(
    () => runGalleryPhaseDRemoteRehearsalWithLocalDefaults({
        serviceToken,
        processingOrigin,
        site: 'family'
    }),
    /invalid-local-rehearsal-options/
);
await assert.rejects(
    () => runGalleryPhaseDRemoteRehearsal({
        serviceToken: { clientId: 'forged', clientSecret: 'forged' },
        processingOrigin,
        fetchImpl: async () => new Response(null, { status: 503 }),
        wranglerRunner: async () => [],
        processPhoto: async () => null
    }),
    /invalid-rehearsal-options/
);

// The retry transition depends on migration 0006. Before any service request,
// the remote runner proves the exact unique, non-partial index and refuses
// legacy duplicate transition history instead of attempting to repair it.
for (const migrationPreflightMutation of [
    'missing-index',
    'wrong-name',
    'nonunique-index',
    'partial-index',
    'wrong-column-order',
    'extra-index-row',
    'duplicate-history'
]) {
    const failedHarness = createHarness({ migrationPreflightMutation });
    await assert.rejects(
        () => runGalleryPhaseDRemoteRehearsal({
            serviceToken,
            processingOrigin,
            fetchImpl: failedHarness.fetchImpl,
            wranglerRunner: failedHarness.wranglerRunner,
            processPhoto: failedHarness.processPhoto
        }),
        migrationPreflightMutation === 'duplicate-history'
            ? /retry-migration-duplicates-present/
            : /retry-migration-index-invalid/,
        migrationPreflightMutation
    );
    assert.equal(failedHarness.requests.length, 0, migrationPreflightMutation);
    assert.equal(failedHarness.processCalls.length, 0, migrationPreflightMutation);
}

// Discovery is fail-closed: only the one exact, current Family rehearsal
// fixture qualifies. State version, site, race, athlete-tag, consent,
// exclusion, digest, and private-key drift all stop before the first processing
// request so every supported recovery checkpoint stays reachable.
for (const mutation of [
    'duplicate',
    'state-version-drift',
    'legacy',
    'everyone',
    'extra-tag',
    'different-tag',
    'race-mismatch',
    'hash-mismatch',
    'consent-withdrawn',
    'pending-exclusion'
]) {
    const failedHarness = createHarness({ discoveryMutation: mutation });
    await assert.rejects(
        () => runGalleryPhaseDRemoteRehearsal({
            serviceToken,
            processingOrigin,
            fetchImpl: failedHarness.fetchImpl,
            wranglerRunner: failedHarness.wranglerRunner,
            processPhoto: failedHarness.processPhoto
        }),
        mutation === 'duplicate'
            ? /eligible-fixture-count-mismatch/
            : /eligible-fixture-invalid/
    );
    assert.equal(failedHarness.requests.length, 0);
}

for (const mutation of [
    'extra-top-key',
    'extra-source-key',
    'wrong-scope',
    'wrong-filename'
]) {
    const failedHarness = createHarness({ startResponseMutation: mutation });
    await assert.rejects(
        () => runGalleryPhaseDRemoteRehearsal({
            serviceToken,
            processingOrigin,
            fetchImpl: failedHarness.fetchImpl,
            wranglerRunner: failedHarness.wranglerRunner,
            processPhoto: failedHarness.processPhoto
        }),
        /start-a-evidence-invalid/,
        mutation
    );
    assert.equal(failedHarness.processCalls.length, 0, mutation);
}

{
    const failedHarness = createHarness({
        startResponseMutation: 'digest-mismatch'
    });
    await assert.rejects(
        () => runGalleryPhaseDRemoteRehearsal({
            serviceToken,
            processingOrigin,
            fetchImpl: failedHarness.fetchImpl,
            wranglerRunner: failedHarness.wranglerRunner,
            processPhoto: failedHarness.processPhoto
        }),
        /source-evidence-mismatch/
    );
    assert.equal(failedHarness.processCalls.length, 0);
}

for (const mutation of ['extra-key', 'wrong-run', 'wrong-state', 'replayed']) {
    const failedHarness = createHarness({ retryResponseMutation: mutation });
    await assert.rejects(
        () => runGalleryPhaseDRemoteRehearsal({
            serviceToken,
            processingOrigin,
            fetchImpl: failedHarness.fetchImpl,
            wranglerRunner: failedHarness.wranglerRunner,
            processPhoto: failedHarness.processPhoto
        }),
        /retry-a-evidence-invalid/,
        mutation
    );
}

for (const responseCase of [
    {
        options: { derivativeResponseMutation: 'extra-key' },
        error: /put-b-display-evidence-invalid/
    },
    {
        options: { resultResponseMutation: 'failed-extra-key' },
        error: /fail-a-evidence-invalid/
    },
    {
        options: { cleanupResponseMutation: 'initial-extra-key' },
        error: /cleanup-a-evidence-invalid/
    },
    {
        options: { cleanupResponseMutation: 'replay-extra-key' },
        error: /retry-c-cleanup-evidence-invalid/
    },
    {
        options: { resultResponseMutation: 'staged-extra-key' },
        error: /final-staged-state-mismatch/
    }
]) {
    const failedHarness = createHarness(responseCase.options);
    await assert.rejects(
        () => runGalleryPhaseDRemoteRehearsal({
            serviceToken,
            processingOrigin,
            fetchImpl: failedHarness.fetchImpl,
            wranglerRunner: failedHarness.wranglerRunner,
            processPhoto: failedHarness.processPhoto
        }),
        responseCase.error
    );
}

// Once the fixed sentinel put has been attempted, every subsequent failure
// path must re-read/hash/delete that one exact key before preserving the
// original rehearsal error. No alternate prefix or bucket is ever touched.
for (const failureCase of [
    { stage: 'put-response', error: /injected-put-response/ },
    { stage: 'prefix-cleanup-request', error: /service-request-failed/ },
    { stage: 'prefix-cleanup-status', error: /prefix-e-refusal-status-502/ },
    { stage: 'prefix-evidence', error: /injected-prefix-evidence/ },
    { stage: 'sentinel-get', error: /injected-sentinel-get/ },
    { stage: 'sentinel-bytes', error: /sentinel-evidence-mismatch/ },
    { stage: 'sentinel-delete', error: /injected-sentinel-delete/ }
]) {
    const failedHarness = createHarness({ sentinelFailureStage: failureCase.stage });
    await assert.rejects(
        () => runGalleryPhaseDRemoteRehearsal({
            serviceToken,
            processingOrigin,
            fetchImpl: failedHarness.fetchImpl,
            wranglerRunner: failedHarness.wranglerRunner,
            processPhoto: failedHarness.processPhoto
        }),
        failureCase.error,
        failureCase.stage
    );
    assert.equal(failedHarness.sentinelStored, false, failureCase.stage);
    const sentinelCalls = failedHarness.runnerCalls.filter(call =>
        call.kind.startsWith('staging-')
    );
    assert.equal(
        sentinelCalls.some(call => call.kind === 'staging-delete-sentinel'),
        true,
        failureCase.stage
    );
    assert.equal(sentinelCalls.every(call =>
        call.configPath === 'gallery-admin/wrangler.admin.local.jsonc' &&
        call.bucketName === 'family-running-gallery-staging-dev' &&
        call.key === `derivative-staging/v1/family/${draftId}/${runIds[4]}/` +
            'rehearsal-untracked-sentinel.bin' &&
        [
            'staging-put-sentinel',
            'staging-get-sentinel',
            'staging-delete-sentinel'
        ].includes(call.kind)
    ), true, failureCase.stage);
}

// A fetch that never answers is aborted at the fixed service deadline. When
// that happens after Scenario E stored its sentinel, the same exact reread,
// digest check, and delete still run from finally before the timeout surfaces.
{
    const timers = installManualTimers();
    const timedOutHarness = createHarness({
        serviceTimeoutStage: 'prefix-cleanup-request',
        triggerServiceTimeout: () => timers.fireNext(30_000)
    });
    try {
        await assert.rejects(
            () => runGalleryPhaseDRemoteRehearsal({
                serviceToken,
                processingOrigin,
                fetchImpl: timedOutHarness.fetchImpl,
                wranglerRunner: timedOutHarness.wranglerRunner,
                processPhoto: timedOutHarness.processPhoto
            }),
            /service-request-timeout/
        );
        assert.equal(timedOutHarness.sentinelStored, false);
        assert.equal(timedOutHarness.runnerCalls.filter(call =>
            call.kind === 'staging-delete-sentinel'
        ).length, 1);
        assert.equal(timers.pendingCount, 0);
        assert.equal(timers.clearCallCount > 0, true);
    } finally {
        timers.restore();
    }
}

// The concrete Wrangler path has its own fixed deadline. It first requests a
// normal child termination, then force-kills after the fixed grace period, and
// surfaces only the redacted timeout code while clearing both timers.
{
    const timers = installManualTimers();
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const killSignals = [];
    child.kill = signal => {
        killSignals.push(signal ?? 'SIGTERM');
        return true;
    };
    try {
        const timeoutResult = galleryPhaseDRemoteRehearsalTestHooks
            .exerciseWranglerDeadline((executable, args, options) => {
                assert.equal(executable, process.execPath);
                assert.deepEqual(args, [
                    'phase-d-wrangler-timeout-probe.mjs'
                ]);
                assert.equal(options.shell, false);
                assert.equal(options.windowsHide, true);
                return child;
            });
        timers.fireNext(60_000);
        assert.deepEqual(killSignals, ['SIGTERM']);
        timers.fireNext(2_000);
        await assert.rejects(timeoutResult, /wrangler-command-timeout/);
        assert.deepEqual(killSignals, ['SIGTERM', 'SIGKILL']);
        assert.equal(timers.pendingCount, 0);
        assert.equal(timers.clearCallCount >= 2, true);
    } finally {
        timers.restore();
    }
}

// If exact sentinel removal cannot itself be proved, that cleanup failure
// deliberately replaces the original error with one fixed, non-sensitive code.
{
    const failedHarness = createHarness({
        sentinelFailureStage: 'prefix-evidence',
        failFailsafeCleanup: true
    });
    await assert.rejects(
        () => runGalleryPhaseDRemoteRehearsal({
            serviceToken,
            processingOrigin,
            fetchImpl: failedHarness.fetchImpl,
            wranglerRunner: failedHarness.wranglerRunner,
            processPhoto: failedHarness.processPhoto
        }),
        /sentinel-failsafe-cleanup-failed/
    );
    assert.equal(failedHarness.sentinelStored, true);
    assert.equal(failedHarness.runnerCalls.filter(call =>
        call.kind.startsWith('staging-')
    ).every(call =>
        call.configPath === 'gallery-admin/wrangler.admin.local.jsonc' &&
        call.bucketName === 'family-running-gallery-staging-dev' &&
        call.key === `derivative-staging/v1/family/${draftId}/${runIds[4]}/` +
            'rehearsal-untracked-sentinel.bin' &&
        [
            'staging-put-sentinel',
            'staging-get-sentinel',
            'staging-delete-sentinel'
        ].includes(call.kind)
    ), true);
}

const executeHarness = current => runGalleryPhaseDRemoteRehearsal({
    serviceToken,
    processingOrigin,
    fetchImpl: current.fetchImpl,
    wranglerRunner: current.wranglerRunner,
    processPhoto: current.processPhoto
});

// A stopped one-shot may continue from either exact Scenario A checkpoint:
// before its fixed retry at failed v5, or after that retry already committed at
// approved v6. Both paths prove the same immutable replay before starting B.
for (const recoveryCheckpoint of ['before-retry', 'after-retry']) {
    const recoveredHarness = createHarness({ recoveryCheckpoint });
    const recoveredReport = await executeHarness(recoveredHarness);
    assert.deepEqual(recoveredReport, expectedReport, recoveryCheckpoint);
    assert.equal(recoveredHarness.processCalls.length, 5, recoveryCheckpoint);
    assert.equal(recoveredHarness.sentinelStored, false, recoveryCheckpoint);
    assert.equal(
        recoveredHarness.recoveryRetryCallCount,
        recoveryCheckpoint === 'before-retry' ? 2 : 1,
        recoveryCheckpoint
    );
    const recoveredAPath =
        `/api/service/processing-runs/${runIds[0]}`;
    const recoveredARequests = recoveredHarness.requests.filter(request =>
        request.pathname.startsWith(recoveredAPath)
    );
    assert.deepEqual(
        recoveredARequests.map(request => request.pathname),
        Array.from(
            { length: recoveryCheckpoint === 'before-retry' ? 2 : 1 },
            () => `${recoveredAPath}/retry`
        ),
        recoveryCheckpoint
    );
    assert.equal(recoveredHarness.requests.filter(request =>
        /\/api\/service\/drafts\/[^/]+\/processing-runs$/.test(request.pathname)
    ).length, 5, recoveryCheckpoint);
    assert.equal(recoveredHarness.requests.some(request =>
        request.pathname === `${recoveredAPath}/result` ||
        request.pathname === `${recoveredAPath}/cleanup`
    ), false, recoveryCheckpoint);
    const recoveryLabels = recoveredHarness.runnerCalls
        .filter(call => call.kind === 'd1-json')
        .map(call => call.label);
    assert.equal(
        recoveryLabels.includes('recovery-a-before-retry'),
        recoveryCheckpoint === 'before-retry',
        recoveryCheckpoint
    );
    assert.equal(recoveryLabels.includes('recovery-a-before-replay'), true);
    assert.equal(recoveryLabels.includes('recovery-a-after-replay'), true);
    assert.equal(recoveredHarness.runnerCalls.some(call =>
        call.kind === 'd1-json' &&
        (/^reset-/.test(call.label) || /UPDATE\s+gallery_drafts/i.test(call.sql))
    ), false, recoveryCheckpoint);

    const recoverySchema = new DatabaseSync(':memory:');
    recoverySchema.exec('PRAGMA foreign_keys = ON;');
    for (const migrationSource of migrationSources) {
        recoverySchema.exec(migrationSource);
    }
    for (const call of recoveredHarness.runnerCalls.filter(call =>
        call.kind === 'd1-json'
    )) {
        assert.doesNotThrow(
            () => recoverySchema.prepare(call.sql).all(),
            `${recoveryCheckpoint}:${call.label}`
        );
    }
    recoverySchema.close();

    const serializedRecovery = JSON.stringify(recoveredReport);
    assert.doesNotMatch(serializedRecovery, /draft_|run_|cleanup_|audit_/i);
    assert.doesNotMatch(serializedRecovery, /athlete|derivative-staging|provider/i);
}

// A first recovered retry may itself report an exact replay when D1 committed
// but its batch response was lost. The post-retry snapshot remains decisive.
{
    const committedResponseLostHarness = createHarness({
        recoveryCheckpoint: 'before-retry',
        recoveryFirstRetryReplayed: true
    });
    assert.deepEqual(
        await executeHarness(committedResponseLostHarness),
        expectedReport
    );
    assert.equal(committedResponseLostHarness.recoveryRetryCallCount, 2);
}

// Discovery accepts no approximate recovery state and stops before a service
// request if the fixed-key checkpoint is missing or ambiguous.
for (const recoveryCase of [
    { checkpoint: 'before-retry', field: 'stateVersion', value: 4 },
    { checkpoint: 'before-retry', field: 'processingDiagnosticsJson', value: null },
    { checkpoint: 'before-retry', field: 'priorRunCount', value: 2 },
    { checkpoint: 'before-retry', field: 'scenarioARunCount', value: 0 },
    { checkpoint: 'before-retry', field: 'scenarioAProcessingRunId', value: null },
    { checkpoint: 'after-retry', field: 'stateVersion', value: 5 },
    {
        checkpoint: 'after-retry',
        field: 'processingDiagnosticsJson',
        value: '{"schemaVersion":"1.0","code":"processing-failed"}'
    }
]) {
    const failedHarness = createHarness({
        recoveryCheckpoint: recoveryCase.checkpoint,
        recoveryDiscoveryMutation: recoveryCase
    });
    await assert.rejects(
        () => executeHarness(failedHarness),
        /eligible-fixture-invalid/,
        `${recoveryCase.checkpoint}:${recoveryCase.field}`
    );
    assert.equal(failedHarness.requests.length, 0);
}

// Exact private evidence is required on both sides of the first transition.
for (const snapshotCase of [
    {
        checkpoint: 'before-retry',
        label: 'recovery-a-before-retry',
        field: 'outputRowCount',
        value: 1,
        error: /recovery-a-checkpoint-invalid/,
        expectedRequests: 0
    },
    {
        checkpoint: 'before-retry',
        label: 'recovery-a-before-replay',
        field: 'retryReceiptCount',
        value: 0,
        error: /recovery-a-after-retry-invalid/,
        expectedRequests: 1
    },
    {
        checkpoint: 'after-retry',
        label: 'recovery-a-before-replay',
        field: 'retryAuditCount',
        value: 2,
        error: /recovery-a-after-retry-invalid/,
        expectedRequests: 0
    }
]) {
    const failedHarness = createHarness({
        recoveryCheckpoint: snapshotCase.checkpoint,
        recoverySnapshotMutation: snapshotCase
    });
    await assert.rejects(
        () => executeHarness(failedHarness),
        snapshotCase.error,
        `${snapshotCase.checkpoint}:${snapshotCase.field}`
    );
    assert.equal(failedHarness.requests.length, snapshotCase.expectedRequests);
}

// The mandatory same-key replay must say it replayed and must be read-only.
for (const recoveryCheckpoint of ['before-retry', 'after-retry']) {
    const wrongReplayHarness = createHarness({
        recoveryCheckpoint,
        recoveryReplayResponseMutation: 'not-replayed'
    });
    await assert.rejects(
        () => executeHarness(wrongReplayHarness),
        /retry-a-evidence-invalid/,
        recoveryCheckpoint
    );
    assert.equal(wrongReplayHarness.processCalls.length, 0);
}

{
    const replayMutationHarness = createHarness({
        recoveryCheckpoint: 'after-retry',
        recoverySnapshotMutation: {
            label: 'recovery-a-after-replay',
            field: 'draftUpdatedAt',
            value: '2026-08-28T12:06:00.000Z'
        }
    });
    await assert.rejects(
        () => executeHarness(replayMutationHarness),
        /recovery-a-replay-mutated-evidence/
    );
    assert.equal(replayMutationHarness.processCalls.length, 0);
}

// A remote invocation may also restart at any of the three exact Scenario D
// checkpoints left by the real complete-wins race. It must reconcile A-C and
// D read-only, touch the recovered staging object only while D is still
// deleting, replay only D's fixed cleanup/retry operations, and then process
// only the new E/F runs.
for (const scenarioDRecoveryCheckpoint of [
    'd-deleting',
    'd-cleaned-before-retry',
    'd-after-retry'
]) {
    const recoveredHarness = createHarness({ scenarioDRecoveryCheckpoint });
    const recoveredReport = await executeHarness(recoveredHarness);
    assert.deepEqual(
        recoveredReport,
        expectedReport,
        scenarioDRecoveryCheckpoint
    );
    assert.deepEqual(
        recoveredHarness.processCalls.map(call => call.processingRunId),
        [runIds[4], runIds[5]],
        scenarioDRecoveryCheckpoint
    );

    const startRequests = recoveredHarness.requests.filter(request =>
        /\/api\/service\/drafts\/[^/]+\/processing-runs$/.test(request.pathname)
    );
    assert.deepEqual(
        startRequests.map(request => request.processingRunId),
        [runIds[4], runIds[5]],
        scenarioDRecoveryCheckpoint
    );
    for (const historicalRunId of runIds.slice(0, 4)) {
        const historicalRequests = recoveredHarness.requests.filter(request =>
            request.pathname.startsWith(
                `/api/service/processing-runs/${historicalRunId}/`
            )
        );
        if (historicalRunId !== runIds[3]) {
            assert.deepEqual(
                historicalRequests,
                [],
                `${scenarioDRecoveryCheckpoint}:${historicalRunId}`
            );
            continue;
        }
        assert.equal(historicalRequests.every(request =>
            request.pathname.endsWith('/cleanup') ||
            request.pathname.endsWith('/retry')
        ), true, scenarioDRecoveryCheckpoint);
    }

    const dPath = `/api/service/processing-runs/${runIds[3]}`;
    const expectedDRequests = scenarioDRecoveryCheckpoint === 'd-deleting'
        ? [
            { tail: 'cleanup', fault: 'after-delete', status: 503 },
            { tail: 'cleanup', fault: null, status: 200 },
            { tail: 'retry', fault: null, status: 200 },
            { tail: 'retry', fault: null, status: 200 }
        ]
        : scenarioDRecoveryCheckpoint === 'd-cleaned-before-retry'
            ? [
                { tail: 'cleanup', fault: null, status: 200 },
                { tail: 'retry', fault: null, status: 200 },
                { tail: 'retry', fault: null, status: 200 }
            ]
            : [
                { tail: 'cleanup', fault: null, status: 200 },
                { tail: 'retry', fault: null, status: 200 }
            ];
    assert.deepEqual(
        recoveredHarness.requests
            .filter(request => request.pathname.startsWith(`${dPath}/`))
            .map(request => ({
                tail: request.pathname.slice(dPath.length + 1),
                fault: request.fault,
                status: request.status
            })),
        expectedDRequests,
        scenarioDRecoveryCheckpoint
    );
    assert.equal(
        recoveredHarness.scenarioDRetryCallCount,
        scenarioDRecoveryCheckpoint === 'd-after-retry' ? 1 : 2,
        scenarioDRecoveryCheckpoint
    );

    const recoveryObjectCalls = recoveredHarness.runnerCalls.filter(call =>
        call.kind === 'staging-get-recovery-object'
    );
    assert.equal(
        recoveryObjectCalls.length,
        scenarioDRecoveryCheckpoint === 'd-deleting' ? 1 : 0,
        scenarioDRecoveryCheckpoint
    );
    for (const call of recoveryObjectCalls) {
        assert.equal(call.bucketName, 'family-running-gallery-staging-dev');
        assert.equal(call.key, scenarioDStagingObjectKey);
        assert.equal(call.draftId, draftId);
        assert.equal(call.processingRunId, runIds[3]);
        assert.equal(call.sha256, scenarioDOutputSha256);
        assert.equal(call.byteLength, displayBytes.byteLength);
    }
    assert.equal(recoveredHarness.runnerCalls.some(call =>
        call.kind !== 'staging-get-recovery-object' &&
        call.key === scenarioDStagingObjectKey
    ), false, scenarioDRecoveryCheckpoint);

    const recoveredD1Calls = recoveredHarness.runnerCalls.filter(call =>
        call.kind === 'd1-json'
    );
    assert.equal(recoveredD1Calls.some(call =>
        /\b(?:INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE)\b/i.test(call.sql)
    ), false, scenarioDRecoveryCheckpoint);
    const recoverySchema = new DatabaseSync(':memory:');
    recoverySchema.exec('PRAGMA foreign_keys = ON;');
    for (const migrationSource of migrationSources) {
        recoverySchema.exec(migrationSource);
    }
    for (const call of recoveredD1Calls) {
        assert.doesNotThrow(
            () => recoverySchema.prepare(call.sql).all(),
            `${scenarioDRecoveryCheckpoint}:${call.label}`
        );
    }
    recoverySchema.close();
}

// Representative evidence drift at each layer fails closed before E/F can be
// processed. The table stays deliberately small while covering prior-run,
// in-progress D, terminal D, and recovered-object evidence.
for (const recoveryCase of [
    {
        checkpoint: 'd-deleting',
        options: {
            scenarioDHistoryMutation: {
                scenario: 'b', field: 'matchingTombstoneCount', value: 0
            }
        },
        error: /recovery-d-prior-proof-invalid/
    },
    {
        checkpoint: 'd-deleting',
        options: {
            scenarioDHistoryMutation: {
                scenario: 'd', field: 'activeCleanupObjectCount', value: 0
            }
        },
        error: /recovery-d-deleting-invalid/
    },
    {
        checkpoint: 'd-cleaned-before-retry',
        options: {
            scenarioDHistoryMutation: {
                scenario: 'd', field: 'matchingTombstoneCount', value: 0
            }
        },
        error: /recovery-d-terminal-history-invalid/
    },
    {
        checkpoint: 'd-after-retry',
        options: {
            scenarioDHistoryMutation: {
                scenario: 'd', field: 'retryReceiptCount', value: 0
            }
        },
        error: /recovery-d-terminal-history-invalid/
    },
    {
        checkpoint: 'd-deleting',
        options: {
            scenarioDObjectMutation: {
                field: 'multipartTerminalKind', value: 'completed'
            }
        },
        error: /recovery-d-object-invalid/
    },
    {
        checkpoint: 'd-cleaned-before-retry',
        options: {
            scenarioDTerminalMutation: {
                label: 'recovery-d-before-retry',
                field: 'cleanupObjectStatus',
                value: 'pending'
            }
        },
        error: /recovery-d-terminal-invalid/
    }
]) {
    const failedHarness = createHarness({
        scenarioDRecoveryCheckpoint: recoveryCase.checkpoint,
        ...recoveryCase.options
    });
    await assert.rejects(
        () => executeHarness(failedHarness),
        recoveryCase.error,
        recoveryCase.checkpoint
    );
    assert.equal(failedHarness.processCalls.length, 0, recoveryCase.checkpoint);
}

for (const scenarioDStagingMutation of ['hash-mismatch', 'byte-count-mismatch']) {
    const failedHarness = createHarness({
        scenarioDRecoveryCheckpoint: 'd-deleting',
        scenarioDStagingMutation
    });
    await assert.rejects(
        () => executeHarness(failedHarness),
        /recovery-d-staging-object-mismatch/,
        scenarioDStagingMutation
    );
    assert.equal(failedHarness.requests.length, 0, scenarioDStagingMutation);
    assert.equal(failedHarness.processCalls.length, 0, scenarioDStagingMutation);
    assert.equal(failedHarness.runnerCalls.filter(call =>
        call.kind === 'staging-get-recovery-object'
    ).length, 1, scenarioDStagingMutation);
}

console.log('Gallery Phase D remote rehearsal driver tests passed.');

function createHarness({
    discoveryMutation = null,
    migrationPreflightMutation = null,
    recoveryCheckpoint = null,
    recoveryDiscoveryMutation = null,
    recoverySnapshotMutation = null,
    recoveryFirstRetryReplayed = false,
    recoveryReplayResponseMutation = null,
    sentinelFailureStage = null,
    failFailsafeCleanup = false,
    serviceTimeoutStage = null,
    triggerServiceTimeout = null,
    startResponseMutation = null,
    retryResponseMutation = null,
    derivativeResponseMutation = null,
    resultResponseMutation = null,
    cleanupResponseMutation = null,
    scenarioDRecoveryCheckpoint = null,
    scenarioDHistoryMutation = null,
    scenarioDObjectMutation = null,
    scenarioDTerminalMutation = null,
    scenarioDStagingMutation = null
} = {}) {
    const requests = [];
    const runnerCalls = [];
    const processCalls = [];
    const runById = new Map();
    const cleanupCalls = new Map();
    const scenarioDRecovery = scenarioDRecoveryCheckpoint !== null;
    let startIndex = scenarioDRecovery
        ? 4
        : recoveryCheckpoint === null ? 0 : 1;
    let cleanedEvidenceIndex = scenarioDRecovery
        ? 4
        : recoveryCheckpoint === null ? 0 : 1;
    let recoveryRetryCommitted = recoveryCheckpoint === 'after-retry';
    let recoveryRetryCallCount = 0;
    let scenarioDRetryCommitted =
        scenarioDRecoveryCheckpoint === 'd-after-retry';
    let scenarioDRetryCallCount = 0;
    let sentinelBytes = null;
    let sentinelKey = null;
    let sentinelFailureInjected = false;

    if (
        recoveryCheckpoint !== null &&
        !['before-retry', 'after-retry'].includes(recoveryCheckpoint)
    ) {
        throw new Error('invalid test recovery checkpoint');
    }
    if (
        scenarioDRecoveryCheckpoint !== null &&
        ![
            'd-deleting',
            'd-cleaned-before-retry',
            'd-after-retry'
        ].includes(scenarioDRecoveryCheckpoint)
    ) {
        throw new Error('invalid test Scenario D recovery checkpoint');
    }
    if (recoveryCheckpoint !== null && scenarioDRecovery) {
        throw new Error('test recovery checkpoints are mutually exclusive');
    }
    if (recoveryCheckpoint !== null) {
        runById.set(runIds[0], { index: 0, stateVersion: 4 });
    }
    if (scenarioDRecovery) {
        for (const [index, plan] of scenarioDRecoveryPlan.entries()) {
            runById.set(runIds[index], {
                index,
                stateVersion: plan.processingStateVersion
            });
        }
    }

    function shouldInjectSentinelFailure(stage) {
        if (sentinelFailureStage !== stage || sentinelFailureInjected) {
            return false;
        }
        sentinelFailureInjected = true;
        return true;
    }

    const discoveryRow = {
        draftId,
        state: 'approved-for-processing',
        stateVersion: 3,
        processingDiagnosticsJson: null,
        siteModesJson: '["family"]',
        exportBundleId: catalogSnapshot.exportBundleId,
        sourceRevision: catalogSnapshot.sourceRevision,
        suppressionRevision: catalogSnapshot.suppressionRevision,
        itemRevision: 'item_00000000-0000-4000-8000-000000000001',
        consentRevision: 'consent_00000000-0000-4000-8000-000000000001',
        mediaType: 'photo',
        raceDate: '2026-08-22',
        raceEvent: 'Budapest Park, Toronto - Parkrun',
        raceDistance: '5 km',
        athleteIdsJson: '["john-kevan"]',
        uploadComplete: 1,
        originalObjectKey,
        originalSha256:
            '6768c0fdd5f22b6eed7425d141a4b69da531ccfa68d9f59ca9388d656f0b81ff',
        uploadSessionId: uploadId,
        fileExtension: 'jpg',
        uploadedAt,
        uploadStatus: 'complete',
        syntheticOnlyConfirmed: 1,
        uploadItemRevision: 'item_00000000-0000-4000-8000-000000000001',
        uploadConsentRevision: 'consent_00000000-0000-4000-8000-000000000001',
        uploadExportBundleId: catalogSnapshot.exportBundleId,
        uploadSourceRevision: catalogSnapshot.sourceRevision,
        uploadSuppressionRevision: catalogSnapshot.suppressionRevision,
        consentPublicUseConfirmed: 1,
        consentContainsMinors: 0,
        consentGuardianApprovalConfirmed: 0,
        consentWithdrawnAt: null,
        pendingTaggedExclusionCount: 0,
        priorRunCount: 0,
        scenarioARunCount: 0,
        scenarioAProcessingRunId: null,
        scenarioBRunCount: 0,
        scenarioBProcessingRunId: null,
        scenarioCRunCount: 0,
        scenarioCProcessingRunId: null,
        scenarioDRunCount: 0,
        scenarioDProcessingRunId: null,
        scenarioERunCount: 0,
        scenarioEProcessingRunId: null,
        scenarioFRunCount: 0,
        scenarioFProcessingRunId: null
    };

    function currentDiscoveryRow() {
        const row = { ...discoveryRow };
        if (recoveryCheckpoint !== null) {
            row.state = recoveryCheckpoint === 'before-retry'
                ? 'processing-failed'
                : 'approved-for-processing';
            row.stateVersion = recoveryCheckpoint === 'before-retry' ? 5 : 6;
            row.processingDiagnosticsJson = recoveryCheckpoint === 'before-retry'
                ? '{"schemaVersion":"1.0","code":"processing-failed"}'
                : null;
            row.priorRunCount = 1;
            row.scenarioARunCount = 1;
            row.scenarioAProcessingRunId = runIds[0];
        }
        if (scenarioDRecovery) {
            const afterRetry = scenarioDRecoveryCheckpoint === 'd-after-retry';
            row.state = afterRetry
                ? 'approved-for-processing'
                : 'processing-failed';
            row.stateVersion = afterRetry ? 15 : 14;
            row.processingDiagnosticsJson = afterRetry
                ? null
                : '{"schemaVersion":"1.0","code":"processing-failed"}';
            row.priorRunCount = 4;
            for (const [index, plan] of scenarioDRecoveryPlan.entries()) {
                const upperKey = plan.key.toUpperCase();
                row[`scenario${upperKey}RunCount`] = 1;
                row[`scenario${upperKey}ProcessingRunId`] = runIds[index];
            }
        }
        if (recoveryDiscoveryMutation) {
            row[recoveryDiscoveryMutation.field] = recoveryDiscoveryMutation.value;
        }
        return row;
    }

    function recoverySnapshotRow(label) {
        const processingRunId = runIds[0];
        const startKey = 'phase-d-remote-a-start-0001';
        const failureKey = 'phase-d-remote-a-failed-0001';
        const cleanupKey = 'phase-d-remote-a-cleanup-0001';
        const retryKey = 'phase-d-remote-a-retry-0001';
        const cleanupId = 'cleanup_00000000000040008000000000000001';
        const startFingerprint = sha256(Buffer.from(JSON.stringify({
            operation: 'processing-start',
            draftId,
            expectedStateVersion: 3,
            idempotencyKey: startKey
        })));
        const failureFingerprint = sha256(Buffer.from(JSON.stringify({
            operation: 'processing-result',
            processingRunId,
            result: {
                outcome: 'failed',
                expectedStateVersion: 4,
                idempotencyKey: failureKey,
                errorCode: 'processing-failed'
            }
        })));
        const cleanupFingerprint = sha256(Buffer.from(JSON.stringify({
            operation: 'processing-cleanup',
            processingRunId,
            expectedStateVersion: 5,
            idempotencyKey: cleanupKey
        })));
        const retryFingerprint = sha256(Buffer.from(JSON.stringify({
            operation: 'processing-retry',
            processingRunId,
            expectedStateVersion: 5,
            idempotencyKey: retryKey
        })));
        const auditSubjectHash = sha256(Buffer.from(`draft:${draftId}`));
        const receiptCreatedAt = '2026-08-28T12:05:00.000Z';
        const row = {
            draftId,
            processingRunId,
            draftState: recoveryRetryCommitted
                ? 'approved-for-processing'
                : 'processing-failed',
            draftStateVersion: recoveryRetryCommitted ? 6 : 5,
            processingDiagnosticsJson: recoveryRetryCommitted
                ? null
                : '{"schemaVersion":"1.0","code":"processing-failed"}',
            draftUpdatedAt: recoveryRetryCommitted
                ? receiptCreatedAt
                : '2026-08-28T12:02:00.000Z',
            runEvidenceMatch: 1,
            pendingTaggedExclusionCount: 0,
            priorRunCount: 1,
            startExpectedStateVersion: 3,
            processingStateVersion: 4,
            startIdempotencyKey: startKey,
            startPayloadFingerprint: startFingerprint,
            runActorIdentityHash: sha256(Buffer.from('historical-run-actor')),
            runStatus: 'failed',
            resultIdempotencyKey: failureKey,
            resultPayloadFingerprint: failureFingerprint,
            resultTransitionKey:
                `failure_${sha256(Buffer.from(`${processingRunId}:${failureKey}`))}`,
            failureCode: 'processing-failed',
            runCreatedAt: '2026-08-28T12:01:00.000Z',
            runUpdatedAt: '2026-08-28T12:02:00.000Z',
            runCompletedAt: '2026-08-28T12:02:00.000Z',
            cleanupId,
            cleanupIdHash: sha256(Buffer.from(cleanupId)),
            cleanupProcessingRunIdHash: sha256(Buffer.from(processingRunId)),
            cleanupDraftIdHash: sha256(Buffer.from(draftId)),
            cleanupReason: 'processing-failed',
            cleanupExpectedStateVersion: 5,
            cleanupOutputCount: 0,
            cleanupIdempotencyKey: cleanupKey,
            cleanupPayloadFingerprint: cleanupFingerprint,
            cleanupActorIdentityHash: sha256(Buffer.from('historical-cleanup-actor')),
            cleanupStatus: 'cleaned',
            cleanupEvidenceHash: sha256(Buffer.from('recovery-cleanup-evidence')),
            cleanupCreatedAt: '2026-08-28T12:03:00.000Z',
            cleanupUpdatedAt: '2026-08-28T12:04:00.000Z',
            cleanupCompletedAt: '2026-08-28T12:04:00.000Z',
            tombstoneCleanupIdHash: sha256(Buffer.from(cleanupId)),
            tombstoneDraftIdHash: sha256(Buffer.from(draftId)),
            tombstoneProcessingRunIdHash: sha256(Buffer.from(processingRunId)),
            tombstoneReason: 'processing-failed',
            tombstoneEvidenceHash: sha256(Buffer.from('recovery-cleanup-evidence')),
            tombstoneCompletedAt: '2026-08-28T12:04:00.000Z',
            outputRowCount: 0,
            multipartRowCount: 0,
            derivativeRowCount: 0,
            cleanupCount: 1,
            cleanupObjectCount: 0,
            activeCleanupObjectCount: 0,
            matchingTombstoneCount: 1,
            runTombstoneCount: 1,
            retryReceiptCount: recoveryRetryCommitted ? 1 : 0,
            retryStateVersionReceiptCount: recoveryRetryCommitted ? 1 : 0,
            retryReceiptIdempotencyKey: recoveryRetryCommitted ? retryKey : null,
            retryReceiptPayloadFingerprint: recoveryRetryCommitted
                ? retryFingerprint
                : null,
            retryReceiptFromState: recoveryRetryCommitted
                ? 'processing-failed'
                : null,
            retryReceiptToState: recoveryRetryCommitted
                ? 'approved-for-processing'
                : null,
            retryReceiptExpectedStateVersion: recoveryRetryCommitted ? 5 : null,
            retryReceiptResultStateVersion: recoveryRetryCommitted ? 6 : null,
            retryReceiptCreatedAt: recoveryRetryCommitted ? receiptCreatedAt : null,
            retrySubjectAuditCount: recoveryRetryCommitted ? 1 : 0,
            retryAuditCount: recoveryRetryCommitted ? 1 : 0,
            retryAuditEventId: recoveryRetryCommitted
                ? 'audit_recovery_retry_0001'
                : null,
            retryAuditSubjectHash: recoveryRetryCommitted ? auditSubjectHash : null,
            retryAuditActorHash: recoveryRetryCommitted
                ? sha256(Buffer.from('rotated-retry-actor'))
                : null,
            retryAuditPayloadHash: recoveryRetryCommitted ? retryFingerprint : null,
            retryAuditStateVersion: recoveryRetryCommitted ? 6 : null,
            retryAuditOccurredAt: recoveryRetryCommitted ? receiptCreatedAt : null
        };
        if (
            recoverySnapshotMutation &&
            recoverySnapshotMutation.label === label
        ) {
            row[recoverySnapshotMutation.field] = recoverySnapshotMutation.value;
        }
        return row;
    }

    function scenarioDRecoveryFacts(plan, index) {
        const processingRunId = runIds[index];
        const startIdempotencyKey =
            `phase-d-remote-${plan.key}-start-0001`;
        const failureIdempotencyKey =
            `phase-d-remote-${plan.key}-failed-0001`;
        const cleanupIdempotencyKey =
            `phase-d-remote-${plan.key}-cleanup-0001`;
        const retryIdempotencyKey =
            `phase-d-remote-${plan.key}-retry-0001`;
        return {
            processingRunId,
            startIdempotencyKey,
            failureIdempotencyKey,
            cleanupIdempotencyKey,
            retryIdempotencyKey,
            startPayloadFingerprint: sha256(Buffer.from(JSON.stringify({
                operation: 'processing-start',
                draftId,
                expectedStateVersion: plan.startExpectedStateVersion,
                idempotencyKey: startIdempotencyKey
            }))),
            failurePayloadFingerprint: sha256(Buffer.from(JSON.stringify({
                operation: 'processing-result',
                processingRunId,
                result: {
                    outcome: 'failed',
                    expectedStateVersion: plan.processingStateVersion,
                    idempotencyKey: failureIdempotencyKey,
                    errorCode: 'processing-failed'
                }
            }))),
            cleanupPayloadFingerprint: sha256(Buffer.from(JSON.stringify({
                operation: 'processing-cleanup',
                processingRunId,
                expectedStateVersion: plan.failedStateVersion,
                idempotencyKey: cleanupIdempotencyKey
            }))),
            retryPayloadFingerprint: sha256(Buffer.from(JSON.stringify({
                operation: 'processing-retry',
                processingRunId,
                expectedStateVersion: plan.failedStateVersion,
                idempotencyKey: retryIdempotencyKey
            }))),
            failureTransitionKey:
                `failure_${sha256(Buffer.from(
                    `${processingRunId}:${failureIdempotencyKey}`
                ))}`
        };
    }

    function scenarioDHistoryRows() {
        const afterRetry = scenarioDRecoveryCheckpoint === 'd-after-retry';
        const rows = scenarioDRecoveryPlan.map((plan, index) => {
            const facts = scenarioDRecoveryFacts(plan, index);
            const isScenarioD = plan.key === 'd';
            const cleaned = !isScenarioD ||
                scenarioDRecoveryCheckpoint !== 'd-deleting';
            const retryCommitted = !isScenarioD || afterRetry;
            const cleanupId = makeCleanupId(index + 1);
            const cleanupCompletedAt = cleaned
                ? `2026-08-28T12:${20 + index}:00.000Z`
                : null;
            return {
                scenario: plan.key,
                draftId,
                processingRunId: facts.processingRunId,
                draftState: afterRetry
                    ? 'approved-for-processing'
                    : 'processing-failed',
                draftStateVersion: afterRetry ? 15 : 14,
                processingDiagnosticsJson: afterRetry
                    ? null
                    : '{"schemaVersion":"1.0","code":"processing-failed"}',
                draftUpdatedAt: afterRetry
                    ? '2026-08-28T12:25:00.000Z'
                    : '2026-08-28T12:19:00.000Z',
                runEvidenceMatch: 1,
                pendingTaggedExclusionCount: 0,
                priorRunCount: 4,
                startExpectedStateVersion: plan.startExpectedStateVersion,
                processingStateVersion: plan.processingStateVersion,
                startIdempotencyKey: facts.startIdempotencyKey,
                startPayloadFingerprint: facts.startPayloadFingerprint,
                runActorIdentityHash: sha256(Buffer.from(
                    `scenario-${plan.key}-run-actor`
                )),
                runStatus: 'failed',
                resultIdempotencyKey: facts.failureIdempotencyKey,
                resultPayloadFingerprint: facts.failurePayloadFingerprint,
                resultTransitionKey: facts.failureTransitionKey,
                failureCode: 'processing-failed',
                runCreatedAt: `2026-08-28T12:0${index}:00.000Z`,
                runUpdatedAt: `2026-08-28T12:1${index}:00.000Z`,
                runCompletedAt: `2026-08-28T12:1${index}:00.000Z`,
                cleanupId,
                cleanupIdHash: sha256(Buffer.from(cleanupId)),
                cleanupProcessingRunIdHash: sha256(Buffer.from(
                    facts.processingRunId
                )),
                cleanupDraftIdHash: sha256(Buffer.from(draftId)),
                cleanupReason: 'processing-failed',
                cleanupExpectedStateVersion: plan.failedStateVersion,
                cleanupOutputCount: plan.cleanupOutputCount,
                cleanupIdempotencyKey: facts.cleanupIdempotencyKey,
                cleanupPayloadFingerprint: facts.cleanupPayloadFingerprint,
                cleanupActorIdentityHash: sha256(Buffer.from(
                    `scenario-${plan.key}-cleanup-actor`
                )),
                cleanupStatus: cleaned ? 'cleaned' : 'deleting',
                cleanupEvidenceHash: cleaned
                    ? sha256(Buffer.from(
                        `scenario-${plan.key}-cleanup-evidence`
                    ))
                    : null,
                cleanupCreatedAt: `2026-08-28T12:${15 + index}:00.000Z`,
                cleanupUpdatedAt: cleaned
                    ? cleanupCompletedAt
                    : '2026-08-28T12:19:30.000Z',
                cleanupCompletedAt,
                outputRowCount: isScenarioD && !cleaned ? 1 : 0,
                multipartRowCount: isScenarioD && !cleaned ? 1 : 0,
                derivativeRowCount: 0,
                cleanupCount: 1,
                cleanupObjectCount: plan.cleanupOutputCount,
                absentCleanupObjectCount: cleaned
                    ? plan.cleanupOutputCount
                    : 0,
                activeCleanupObjectCount: isScenarioD && !cleaned ? 1 : 0,
                matchingTombstoneCount: cleaned ? 1 : 0,
                runTombstoneCount: cleaned ? 1 : 0,
                startReceiptCount: 1,
                failureReceiptCount: 1,
                startAuditCount: 1,
                failureAuditCount: 1,
                retryReceiptCount: retryCommitted ? 1 : 0,
                retryStateVersionReceiptCount: retryCommitted ? 1 : 0,
                retryReceiptIdempotencyKey: retryCommitted
                    ? facts.retryIdempotencyKey
                    : null,
                retryReceiptPayloadFingerprint: retryCommitted
                    ? facts.retryPayloadFingerprint
                    : null,
                retryReceiptFromState: retryCommitted
                    ? 'processing-failed'
                    : null,
                retryReceiptToState: retryCommitted
                    ? 'approved-for-processing'
                    : null,
                retryReceiptExpectedStateVersion: retryCommitted
                    ? plan.failedStateVersion
                    : null,
                retryReceiptResultStateVersion: retryCommitted
                    ? plan.approvedStateVersion
                    : null,
                retryReceiptCreatedAt: retryCommitted
                    ? `2026-08-28T12:${25 + index}:00.000Z`
                    : null,
                retryAuditCount: retryCommitted ? 1 : 0,
                retrySubjectAuditCount: afterRetry ? 4 : 3
            };
        });
        if (scenarioDHistoryMutation) {
            const row = rows.find(entry =>
                entry.scenario === scenarioDHistoryMutation.scenario
            );
            assert.ok(row, 'Scenario D history mutation row');
            row[scenarioDHistoryMutation.field] =
                scenarioDHistoryMutation.value;
        }
        return rows;
    }

    function scenarioDObjectRow() {
        const plan = scenarioDRecoveryPlan[3];
        const facts = scenarioDRecoveryFacts(plan, 3);
        const cleanupId = makeCleanupId(4);
        const providerUploadId = 'provider-phase-d-recovery-upload';
        const outputPayloadFingerprint = sha256(Buffer.from(JSON.stringify({
            operation: 'processing-output-upload',
            processingRunId: runIds[3],
            role: 'photo-display',
            contentType: 'image/webp',
            byteLength: displayBytes.byteLength,
            sha256: scenarioDOutputSha256,
            width: 1200,
            height: 800,
            idempotencyKey: 'phase-d-remote-d-display-0001'
        })));
        const row = {
            draftId,
            processingRunId: runIds[3],
            cleanupId,
            cleanupStatus: 'deleting',
            cleanupExpectedStateVersion: 14,
            cleanupIdempotencyKey: facts.cleanupIdempotencyKey,
            cleanupPayloadFingerprint: facts.cleanupPayloadFingerprint,
            outputCount: 1,
            outputRole: 'photo-display',
            outputIdempotencyKey: 'phase-d-remote-d-display-0001',
            outputPayloadFingerprint,
            outputStagingObjectKey: scenarioDStagingObjectKey,
            outputSha256: scenarioDOutputSha256,
            outputByteCount: displayBytes.byteLength,
            outputContentType: 'image/webp',
            outputWidth: 1200,
            outputHeight: 800,
            outputStatus: 'reserved',
            outputObjectVersion: null,
            outputEtag: null,
            outputStoredAt: null,
            outputVerifiedAt: null,
            outputCreatedAt: '2026-08-28T12:18:00.000Z',
            multipartCount: 1,
            multipartRole: 'photo-display',
            multipartStagingObjectKey: scenarioDStagingObjectKey,
            multipartPayloadFingerprint: outputPayloadFingerprint,
            providerUploadId,
            providerUploadIdHash: sha256(Buffer.from(
                `multipart-upload-id:${providerUploadId}`
            )),
            multipartStatus: 'terminal',
            providerPartEtag: 'provider-part-etag',
            multipartTerminalKind: 'aborted',
            multipartCreatedAt: '2026-08-28T12:18:00.000Z',
            multipartUpdatedAt: '2026-08-28T12:19:00.000Z',
            multipartPartUploadedAt: '2026-08-28T12:18:30.000Z',
            multipartTerminalAt: '2026-08-28T12:19:00.000Z',
            cleanupObjectCount: 1,
            cleanupObjectRole: 'photo-display',
            cleanupObjectStagingKey: scenarioDStagingObjectKey,
            cleanupObjectStagingKeyHash: sha256(Buffer.from(
                `staging-key:${scenarioDStagingObjectKey}`
            )),
            cleanupObjectExpectedSha256: scenarioDOutputSha256,
            cleanupObjectExpectedByteCount: displayBytes.byteLength,
            cleanupObjectExpectedVersionHash: null,
            cleanupObjectExpectedEtagHash: null,
            cleanupObjectProviderTerminalKind: null,
            cleanupObjectObservedVersionHash: null,
            cleanupObjectObservedEtagHash: null,
            cleanupObjectStatus: 'pending',
            cleanupObjectDeletedAt: null,
            cleanupObjectAbsenceVerifiedAt: null
        };
        if (scenarioDObjectMutation) {
            row[scenarioDObjectMutation.field] = scenarioDObjectMutation.value;
        }
        return row;
    }

    function scenarioDTerminalRow(label) {
        const plan = scenarioDRecoveryPlan[3];
        const facts = scenarioDRecoveryFacts(plan, 3);
        const cleanupId = makeCleanupId(4);
        const afterRetry = scenarioDRetryCommitted;
        const row = {
            draftId,
            processingRunId: runIds[3],
            draftState: afterRetry
                ? 'approved-for-processing'
                : 'processing-failed',
            draftStateVersion: afterRetry ? 15 : 14,
            processingDiagnosticsJson: afterRetry
                ? null
                : '{"schemaVersion":"1.0","code":"processing-failed"}',
            draftUpdatedAt: afterRetry
                ? '2026-08-28T12:28:00.000Z'
                : '2026-08-28T12:19:00.000Z',
            cleanupId,
            cleanupIdHash: sha256(Buffer.from(cleanupId)),
            cleanupProcessingRunIdHash: sha256(Buffer.from(runIds[3])),
            cleanupDraftIdHash: sha256(Buffer.from(draftId)),
            cleanupReason: 'processing-failed',
            cleanupExpectedStateVersion: 14,
            cleanupOutputCount: 1,
            cleanupIdempotencyKey: facts.cleanupIdempotencyKey,
            cleanupPayloadFingerprint: facts.cleanupPayloadFingerprint,
            cleanupActorIdentityHash: sha256(Buffer.from(
                'scenario-d-cleanup-actor'
            )),
            cleanupStatus: 'cleaned',
            cleanupEvidenceHash: sha256(Buffer.from(
                'scenario-d-cleanup-evidence'
            )),
            cleanupCreatedAt: '2026-08-28T12:18:00.000Z',
            cleanupUpdatedAt: '2026-08-28T12:27:00.000Z',
            cleanupCompletedAt: '2026-08-28T12:27:00.000Z',
            cleanupObjectCount: 1,
            cleanupObjectRole: 'photo-display',
            cleanupObjectStagingKey: null,
            cleanupObjectStagingKeyHash: sha256(Buffer.from(
                `staging-key:${scenarioDStagingObjectKey}`
            )),
            cleanupObjectExpectedSha256: scenarioDOutputSha256,
            cleanupObjectExpectedByteCount: displayBytes.byteLength,
            cleanupObjectExpectedVersionHash: null,
            cleanupObjectExpectedEtagHash: null,
            cleanupObjectProviderTerminalKind: 'aborted',
            cleanupObjectObservedVersionHash: null,
            cleanupObjectObservedEtagHash: null,
            cleanupObjectStatus: 'absent',
            cleanupObjectDeletedAt: null,
            cleanupObjectAbsenceVerifiedAt: '2026-08-28T12:27:00.000Z',
            outputRowCount: 0,
            multipartRowCount: 0,
            derivativeRowCount: 0,
            activeCleanupObjectCount: 0,
            matchingTombstoneCount: 1,
            runTombstoneCount: 1,
            retryReceiptCount: afterRetry ? 1 : 0,
            retryStateVersionReceiptCount: afterRetry ? 1 : 0,
            retryReceiptIdempotencyKey: afterRetry
                ? facts.retryIdempotencyKey
                : null,
            retryReceiptPayloadFingerprint: afterRetry
                ? facts.retryPayloadFingerprint
                : null,
            retryReceiptFromState: afterRetry ? 'processing-failed' : null,
            retryReceiptToState: afterRetry ? 'approved-for-processing' : null,
            retryReceiptExpectedStateVersion: afterRetry ? 14 : null,
            retryReceiptResultStateVersion: afterRetry ? 15 : null,
            retryReceiptCreatedAt: afterRetry
                ? '2026-08-28T12:28:00.000Z'
                : null,
            retryAuditCount: afterRetry ? 1 : 0,
            retrySubjectAuditCount: afterRetry ? 4 : 3
        };
        if (
            scenarioDTerminalMutation &&
            scenarioDTerminalMutation.label === label
        ) {
            row[scenarioDTerminalMutation.field] =
                scenarioDTerminalMutation.value;
        }
        return row;
    }

    async function wranglerRunner(request) {
        runnerCalls.push(cloneSafeRunnerCall(request));
        if (request.kind === 'staging-put-sentinel') {
            assert.equal(request.configPath, 'gallery-admin/wrangler.admin.local.jsonc');
            assert.equal(request.bucketName, 'family-running-gallery-staging-dev');
            assert.equal(
                request.key,
                `derivative-staging/v1/family/${draftId}/${runIds[4]}/` +
                    'rehearsal-untracked-sentinel.bin'
            );
            assert.deepEqual(Buffer.from(request.bytes), exactSentinelBytes);
            assert.equal(request.sha256, exactSentinelSha256);
            sentinelBytes = Uint8Array.from(request.bytes);
            sentinelKey = request.key;
            if (shouldInjectSentinelFailure('put-response')) {
                throw new Error('injected-put-response');
            }
            return { status: 'stored' };
        }
        if (request.kind === 'staging-get-sentinel') {
            assert.equal(request.key, sentinelKey);
            if (failFailsafeCleanup && sentinelFailureInjected) {
                throw new Error('injected-failsafe-cleanup');
            }
            if (shouldInjectSentinelFailure('sentinel-get')) {
                throw new Error('injected-sentinel-get');
            }
            if (shouldInjectSentinelFailure('sentinel-bytes')) {
                return Uint8Array.from(Buffer.from('wrong-sentinel-bytes', 'utf8'));
            }
            return Uint8Array.from(sentinelBytes);
        }
        if (request.kind === 'staging-delete-sentinel') {
            assert.equal(request.key, sentinelKey);
            assert.equal(request.expectedSha256, exactSentinelSha256);
            assert.equal(sha256(sentinelBytes), exactSentinelSha256);
            if (shouldInjectSentinelFailure('sentinel-delete')) {
                throw new Error('injected-sentinel-delete');
            }
            sentinelBytes = null;
            sentinelKey = null;
            return { status: 'deleted' };
        }
        if (request.kind === 'staging-get-recovery-object') {
            assert.equal(scenarioDRecoveryCheckpoint, 'd-deleting');
            assert.equal(
                request.configPath,
                'gallery-admin/wrangler.admin.local.jsonc'
            );
            assert.equal(
                request.bucketName,
                'family-running-gallery-staging-dev'
            );
            assert.equal(request.key, scenarioDStagingObjectKey);
            assert.equal(request.draftId, draftId);
            assert.equal(request.processingRunId, runIds[3]);
            assert.equal(request.sha256, scenarioDOutputSha256);
            assert.equal(request.byteLength, displayBytes.byteLength);
            if (scenarioDStagingMutation === 'byte-count-mismatch') {
                return Uint8Array.from(displayBytes.subarray(0, -1));
            }
            if (scenarioDStagingMutation === 'hash-mismatch') {
                const bytes = Uint8Array.from(displayBytes);
                bytes[0] ^= 0xff;
                return bytes;
            }
            return Uint8Array.from(displayBytes);
        }
        assert.equal(request.kind, 'd1-json');
        assert.equal(request.configPath, 'gallery-admin/wrangler.admin.local.jsonc');
        assert.equal(request.databaseName, 'family-running-gallery-dev');
        assert.equal(typeof request.sql, 'string');
        assert.doesNotMatch(request.sql, /CF-Access|clientSecret|approved-dev/i);
        if (request.label === 'boundary-before' || request.label === 'boundary-after') {
            return [{
                approvedReferenceCount: 0,
                publicationReferenceCount: 0,
                publicwardDraftCount: 0,
                pendingExclusionCount: 0
            }];
        }
        if (request.label === 'retry-index-preflight') {
            const rows = [
                {
                    indexName: 'draft_transition_receipts_state_version_unique',
                    isUnique: 1,
                    isPartial: 0,
                    sequenceNumber: 0,
                    columnName: 'draft_id'
                },
                {
                    indexName: 'draft_transition_receipts_state_version_unique',
                    isUnique: 1,
                    isPartial: 0,
                    sequenceNumber: 1,
                    columnName: 'expected_state_version'
                }
            ];
            if (migrationPreflightMutation === 'missing-index') {
                return [];
            }
            if (migrationPreflightMutation === 'wrong-name') {
                return rows.map(row => ({ ...row, indexName: 'different_index' }));
            }
            if (migrationPreflightMutation === 'nonunique-index') {
                return rows.map(row => ({ ...row, isUnique: 0 }));
            }
            if (migrationPreflightMutation === 'partial-index') {
                return rows.map(row => ({ ...row, isPartial: 1 }));
            }
            if (migrationPreflightMutation === 'wrong-column-order') {
                return [
                    { ...rows[0], columnName: 'expected_state_version' },
                    { ...rows[1], columnName: 'draft_id' }
                ];
            }
            if (migrationPreflightMutation === 'extra-index-row') {
                return [
                    ...rows,
                    { ...rows[1], sequenceNumber: 2, columnName: 'idempotency_key' }
                ];
            }
            return rows;
        }
        if (request.label === 'retry-duplicates-preflight') {
            return [{
                duplicateGroupCount:
                    migrationPreflightMutation === 'duplicate-history' ? 1 : 0
            }];
        }
        if (request.label === 'discover-fixture') {
            const current = currentDiscoveryRow();
            if (discoveryMutation === 'duplicate') {
                return [{ ...current }, { ...current }];
            }
            if (discoveryMutation === 'state-version-drift') {
                return [{ ...current, stateVersion: 4 }];
            }
            if (discoveryMutation === 'legacy') {
                return [{
                    ...current,
                    originalObjectKey:
                        `private-originals/phase-c/${draftId}/` +
                        '00000000-0000-4000-8000-000000000002.jpg'
                }];
            }
            if (discoveryMutation === 'everyone') {
                return [{ ...current, siteModesJson: '["everyone"]' }];
            }
            if (discoveryMutation === 'extra-tag') {
                return [{
                    ...current,
                    athleteIdsJson: '["john-kevan","someone-else"]'
                }];
            }
            if (discoveryMutation === 'different-tag') {
                return [{ ...current, athleteIdsJson: '["someone-else"]' }];
            }
            if (discoveryMutation === 'race-mismatch') {
                return [{ ...current, raceEvent: 'Different synthetic race' }];
            }
            if (discoveryMutation === 'hash-mismatch') {
                return [{ ...current, originalSha256: 'f'.repeat(64) }];
            }
            if (discoveryMutation === 'consent-withdrawn') {
                return [{ ...current, consentWithdrawnAt: uploadedAt }];
            }
            if (discoveryMutation === 'pending-exclusion') {
                return [{ ...current, pendingTaggedExclusionCount: 1 }];
            }
            return [current];
        }
        if ([
            'recovery-a-before-retry',
            'recovery-a-before-replay',
            'recovery-a-after-replay'
        ].includes(request.label)) {
            assert.notEqual(recoveryCheckpoint, null);
            return [recoverySnapshotRow(request.label)];
        }
        if (request.label === 'recovery-d-history') {
            assert.equal(scenarioDRecovery, true);
            return scenarioDHistoryRows();
        }
        if (request.label === 'recovery-d-object') {
            assert.equal(scenarioDRecoveryCheckpoint, 'd-deleting');
            return [scenarioDObjectRow()];
        }
        if ([
            'recovery-d-before-retry',
            'recovery-d-before-replay',
            'recovery-d-after-replay'
        ].includes(request.label)) {
            assert.equal(scenarioDRecovery, true);
            return [scenarioDTerminalRow(request.label)];
        }
        if (request.label === 'cleaned-run-evidence') {
            const outputCounts = [0, 1, 1, 1, 1];
            const outputCount = outputCounts[cleanedEvidenceIndex++];
            return [{
                runStatus: 'failed',
                draftState: 'processing-failed',
                cleanupStatus: 'cleaned',
                cleanupReason: 'processing-failed',
                outputCount,
                activeOutputCount: 0,
                activeMultipartCount: 0,
                activeDerivativeCount: 0,
                cleanupObjectCount: outputCount,
                absentCleanupObjectCount: outputCount,
                pendingCleanupObjectCount: 0,
                tombstoneCount: 1
            }];
        }
        if (request.label === 'prefix-refusal-evidence') {
            if (shouldInjectSentinelFailure('prefix-evidence')) {
                throw new Error('injected-prefix-evidence');
            }
            return [{
                runStatus: 'failed',
                draftState: 'processing-failed',
                cleanupStatus: 'deleting',
                cleanupReason: 'processing-failed',
                outputCount: 1,
                activeOutputCount: 1,
                activeMultipartCount: 1,
                activeDerivativeCount: 0,
                cleanupObjectCount: 1,
                absentCleanupObjectCount: 1,
                pendingCleanupObjectCount: 0,
                tombstoneCount: 0
            }];
        }
        if (request.label === 'final-staged-evidence') {
            return [{
                runStatus: 'staged',
                draftState: 'processing',
                draftStateVersion: 19,
                processingDiagnosticsJson: null,
                verifiedOutputCount: 2,
                multipartHandleCount: 2,
                terminalMultipartCount: 2,
                completedMultipartCount: 2,
                privateDerivativeCount: 2,
                approvedDerivativeCount: 0,
                finalCleanupCount: 0,
                completedCleanupCount: 5
            }];
        }
        if (request.label === 'foreign-key-check') {
            return [];
        }
        assert.fail(`Unexpected Wrangler request label: ${request.label}`);
    }

    async function fetchImpl(url, options) {
        const parsed = new URL(url);
        const headers = new Headers(options.headers);
        assert.equal(options.redirect, 'error');
        assert.equal(options.credentials, 'omit');
        assert.equal(options.referrerPolicy, 'no-referrer');
        assert.equal(options.signal instanceof AbortSignal, true);
        assert.equal(options.signal.aborted, false);
        assert.equal(headers.get('CF-Access-Client-Id'), serviceToken.clientId);
        assert.equal(headers.get('CF-Access-Client-Secret'), serviceToken.clientSecret);
        const fault = headers.get('X-Gallery-Rehearsal-Fault');
        let response;
        let requestProcessingRunId = null;

        const start = /^\/api\/service\/drafts\/[^/]+\/processing-runs$/.exec(parsed.pathname);
        if (start) {
            const input = JSON.parse(String(options.body));
            const expectedVersions = recoveryCheckpoint === null && !scenarioDRecovery
                ? [3, 6, 9, 12, 15, 18]
                : [null, 6, 9, 12, 15, 18];
            const scenarioKey = ['a', 'b', 'c', 'd', 'e', 'f'][startIndex];
            assert.deepEqual(Object.keys(input).sort(), [
                'expectedStateVersion',
                'idempotencyKey'
            ]);
            assert.equal(input.expectedStateVersion, expectedVersions[startIndex]);
            assert.equal(
                input.idempotencyKey,
                `phase-d-remote-${scenarioKey}-start-0001`
            );
            const processingRunId = runIds[startIndex];
            requestProcessingRunId = processingRunId;
            const stateVersion = input.expectedStateVersion + 1;
            runById.set(processingRunId, { index: startIndex, stateVersion });
            startIndex += 1;
            const startBody = {
                schemaVersion: '1.0',
                scope: 'photo-processing-v1',
                processingRunId,
                site: 'family',
                mediaType: 'photo',
                state: 'processing',
                stateVersion,
                source: {
                    downloadPath: `/api/service/processing-runs/${processingRunId}/original`,
                    sha256: sourceSha256,
                    byteLength: sourceBytes.byteLength,
                    detectedFormat: 'jpeg',
                    declaredMimeType: 'image/jpeg',
                    fileExtension: 'jpg'
                },
                requiredRoles: ['photo-display', 'photo-thumbnail'],
                runStatus: 'active',
                replayed: false
            };
            if (startResponseMutation === 'extra-top-key') {
                startBody.unexpected = true;
            } else if (startResponseMutation === 'extra-source-key') {
                startBody.source.unexpected = true;
            } else if (startResponseMutation === 'wrong-scope') {
                startBody.scope = 'different-scope';
            } else if (startResponseMutation === 'wrong-filename') {
                startBody.source.fileExtension = 'png';
            } else if (startResponseMutation === 'digest-mismatch') {
                startBody.source.sha256 = 'f'.repeat(64);
            }
            response = jsonResponse(201, startBody);
        } else {
            const route = /^\/api\/service\/processing-runs\/(run_[^/]+)\/(.+)$/.exec(
                parsed.pathname
            );
            assert.ok(route, parsed.pathname);
            const processingRunId = route[1];
            requestProcessingRunId = processingRunId;
            const tail = route[2];
            const run = runById.get(processingRunId);
            assert.ok(run, processingRunId);
            if (tail === 'retry') {
                const input = JSON.parse(String(options.body));
                const scenarioKey = ['a', 'b', 'c', 'd', 'e'][run.index];
                assert.ok(scenarioKey);
                assert.equal(options.method, 'POST');
                assert.deepEqual(Object.keys(input).sort(), [
                    'expectedStateVersion',
                    'idempotencyKey'
                ]);
                assert.equal(input.expectedStateVersion, run.stateVersion + 1);
                assert.equal(
                    input.idempotencyKey,
                    `phase-d-remote-${scenarioKey}-retry-0001`
                );
                const isRecoveredScenarioA =
                    recoveryCheckpoint !== null && run.index === 0;
                const isRecoveredScenarioD =
                    scenarioDRecovery && run.index === 3;
                const wasRecoveryRetryCommitted = recoveryRetryCommitted;
                const wasScenarioDRetryCommitted = scenarioDRetryCommitted;
                if (isRecoveredScenarioA) {
                    recoveryRetryCallCount += 1;
                    recoveryRetryCommitted = true;
                }
                if (isRecoveredScenarioD) {
                    scenarioDRetryCallCount += 1;
                    scenarioDRetryCommitted = true;
                }
                const retryBody = {
                    schemaVersion: '1.0',
                    processingRunId,
                    state: 'approved-for-processing',
                    stateVersion: input.expectedStateVersion + 1,
                    replayed: isRecoveredScenarioA
                        ? wasRecoveryRetryCommitted || recoveryFirstRetryReplayed
                        : isRecoveredScenarioD
                            ? wasScenarioDRetryCommitted
                            : false
                };
                if (retryResponseMutation === 'extra-key') {
                    retryBody.unexpected = true;
                } else if (retryResponseMutation === 'wrong-run') {
                    retryBody.processingRunId = runIds[1];
                } else if (retryResponseMutation === 'wrong-state') {
                    retryBody.state = 'processing-failed';
                } else if (retryResponseMutation === 'replayed') {
                    retryBody.replayed = true;
                }
                if (isRecoveredScenarioA && wasRecoveryRetryCommitted) {
                    if (recoveryReplayResponseMutation === 'not-replayed') {
                        retryBody.replayed = false;
                    } else if (recoveryReplayResponseMutation === 'extra-key') {
                        retryBody.unexpected = true;
                    } else if (recoveryReplayResponseMutation === 'wrong-state') {
                        retryBody.state = 'processing-failed';
                    }
                }
                response = jsonResponse(200, retryBody);
            } else if (tail === 'original') {
                response = new Response(sourceBytes, {
                    status: 200,
                    headers: {
                        'Content-Type': 'image/jpeg',
                        'Content-Length': String(sourceBytes.byteLength),
                        'X-Gallery-Content-SHA256': sourceSha256
                    }
                });
            } else if (tail.startsWith('derivatives/')) {
                assert.equal(options.method, 'PUT');
                assert.equal(headers.get('Content-Type'), 'image/webp');
                assert.match(headers.get('Idempotency-Key') || '', /^phase-d-remote-/);
                const derivativeBytes = Buffer.from(options.body);
                const expectedBytes = tail.endsWith('/photo-display')
                    ? displayBytes
                    : thumbnailBytes;
                assert.deepEqual(derivativeBytes, expectedBytes);
                assert.equal(
                    headers.get('Content-Length'),
                    String(expectedBytes.byteLength)
                );
                assert.equal(
                    headers.get('X-Gallery-Content-SHA256'),
                    sha256(expectedBytes)
                );
                if (fault) {
                    response = jsonResponse(503, { error: 'service-unavailable' });
                } else {
                    const derivativeBody = {
                        schemaVersion: '1.0',
                        processingRunId,
                        role: tail.endsWith('/photo-display')
                            ? 'photo-display'
                            : 'photo-thumbnail',
                        sha256: sha256(expectedBytes),
                        byteLength: expectedBytes.byteLength,
                        width: tail.endsWith('/photo-display') ? 1200 : 480,
                        height: tail.endsWith('/photo-display') ? 800 : 320,
                        replayed: false
                    };
                    if (derivativeResponseMutation === 'extra-key') {
                        derivativeBody.unexpected = true;
                    }
                    response = jsonResponse(201, derivativeBody);
                }
            } else if (tail === 'result') {
                const input = JSON.parse(String(options.body));
                if (input.outcome === 'failed') {
                    assert.deepEqual(Object.keys(input).sort(), [
                        'errorCode',
                        'expectedStateVersion',
                        'idempotencyKey',
                        'outcome'
                    ]);
                    assert.equal(input.expectedStateVersion, run.stateVersion);
                    assert.equal(input.errorCode, 'processing-failed');
                    assert.equal(
                        input.idempotencyKey,
                        `phase-d-remote-${['a', 'b', 'c', 'd', 'e'][run.index]}-` +
                            'failed-0001'
                    );
                    const failedBody = {
                        schemaVersion: '1.0',
                        processingRunId,
                        status: 'failed',
                        state: 'processing-failed',
                        stateVersion: run.stateVersion + 1,
                        roles: [],
                        replayed: false
                    };
                    if (resultResponseMutation === 'failed-extra-key') {
                        failedBody.unexpected = true;
                    }
                    response = jsonResponse(200, failedBody);
                } else {
                    assert.equal(run.index, 5);
                    assert.deepEqual(Object.keys(input).sort(), [
                        'derivatives',
                        'expectedStateVersion',
                        'idempotencyKey',
                        'outcome',
                        'source',
                        'toolchain'
                    ]);
                    assert.equal(input.outcome, 'staged');
                    assert.equal(input.idempotencyKey, 'phase-d-remote-f-staged-0001');
                    assert.deepEqual(
                        input.derivatives.map(entry => entry.role).sort(),
                        ['photo-display', 'photo-thumbnail']
                    );
                    const stagedBody = {
                        schemaVersion: '1.0',
                        processingRunId,
                        status: 'staged',
                        state: 'processing',
                        stateVersion: run.stateVersion,
                        roles: ['photo-display', 'photo-thumbnail'],
                        replayed: false
                    };
                    if (resultResponseMutation === 'staged-extra-key') {
                        stagedBody.unexpected = true;
                    }
                    response = jsonResponse(200, stagedBody);
                }
            } else if (tail === 'cleanup') {
                if (
                    run.index === 4 &&
                    serviceTimeoutStage === 'prefix-cleanup-request'
                ) {
                    assert.equal(typeof triggerServiceTimeout, 'function');
                    return new Promise((_, reject) => {
                        options.signal.addEventListener('abort', () => {
                            reject(new Error('mock fetch aborted'));
                        }, { once: true });
                        queueMicrotask(triggerServiceTimeout);
                    });
                }
                const input = JSON.parse(String(options.body));
                assert.deepEqual(Object.keys(input).sort(), [
                    'expectedStateVersion',
                    'idempotencyKey'
                ]);
                assert.equal(input.expectedStateVersion, run.stateVersion + 1);
                assert.equal(
                    input.idempotencyKey,
                    `phase-d-remote-${['a', 'b', 'c', 'd', 'e'][run.index]}-` +
                        'cleanup-0001'
                );
                if (
                    run.index === 4 &&
                    shouldInjectSentinelFailure('prefix-cleanup-request')
                ) {
                    throw new Error('injected-prefix-cleanup-request');
                }
                const calls = (cleanupCalls.get(processingRunId) || 0) + 1;
                cleanupCalls.set(processingRunId, calls);
                if (
                    scenarioDRecovery &&
                    run.index === 3 &&
                    scenarioDRecoveryCheckpoint === 'd-deleting' &&
                    calls === 1
                ) {
                    assert.equal(fault, 'after-delete');
                    response = jsonResponse(503, {
                        error: 'service-unavailable'
                    });
                } else if (scenarioDRecovery && run.index === 3) {
                    assert.equal(fault, null);
                    response = jsonResponse(200, {
                        processingRunId,
                        cleanupReason: 'processing-failed',
                        status: 'cleaned',
                        replayed: true
                    });
                } else if (
                    run.index === 4 &&
                    calls === 1 &&
                    shouldInjectSentinelFailure('prefix-cleanup-status')
                ) {
                    response = jsonResponse(502, { error: 'injected-status' });
                } else if (fault || (run.index === 4 && calls === 1)) {
                    response = jsonResponse(503, { error: 'service-unavailable' });
                } else {
                    const cleanupBody = {
                        processingRunId,
                        cleanupReason: 'processing-failed',
                        status: 'cleaned',
                        replayed: calls !== 1
                    };
                    if (
                        (
                            cleanupResponseMutation === 'initial-extra-key' &&
                            run.index === 0 &&
                            calls === 1
                        ) || (
                            cleanupResponseMutation === 'replay-extra-key' &&
                            run.index === 2 &&
                            calls === 2
                        )
                    ) {
                        cleanupBody.unexpected = true;
                    }
                    response = jsonResponse(calls === 1 ? 201 : 200, cleanupBody);
                }
            } else {
                assert.fail(`Unexpected processing route: ${tail}`);
            }
        }
        requests.push({
            origin: parsed.origin,
            method: options.method,
            pathname: parsed.pathname,
            fault,
            status: response.status,
            bodySha256: options.body instanceof Uint8Array
                ? sha256(options.body)
                : null,
            byteLength: options.body instanceof Uint8Array
                ? options.body.byteLength
                : null,
            contentSha256: headers.get('X-Gallery-Content-SHA256'),
            contentLength: headers.get('Content-Length'),
            idempotencyKey: headers.get('Idempotency-Key'),
            processingRunId: requestProcessingRunId
        });
        return response;
    }

    async function processPhoto(request) {
        processCalls.push({
            site: request.draftBinding.site,
            processingRunId: request.draftBinding.processingRunId
        });
        assert.equal(request.syntheticOnly, true);
        assert.equal(request.draftBinding.draftId, draftId);
        assert.equal(request.draftBinding.site, 'family');
        assert.equal(sha256(request.sourceBytes), sourceSha256);
        const derivatives = [
            makeDerivative('photo-display', displayBytes, 1200, 800, request.draftBinding),
            makeDerivative('photo-thumbnail', thumbnailBytes, 480, 320, request.draftBinding)
        ];
        return {
            schemaVersion: '1.0',
            scope: 'photo-processing-v1',
            mediaType: 'photo',
            inheritedSite: request.draftBinding.site,
            draftId: request.draftBinding.draftId,
            processingRunId: request.draftBinding.processingRunId,
            source: {
                sha256: sourceSha256,
                byteLength: sourceBytes.byteLength,
                detectedFormat: 'jpeg'
            },
            toolchain: {
                sharp: '0.35.2',
                libvips: '8.18.3',
                webp: '1.6.0',
                png: '1.6.58',
                exiftool: '13.40',
                videoEnabled: false
            },
            derivatives
        };
    }

    return {
        requests,
        runnerCalls,
        processCalls,
        fetchImpl,
        wranglerRunner,
        processPhoto,
        get recoveryRetryCallCount() {
            return recoveryRetryCallCount;
        },
        get scenarioDRetryCallCount() {
            return scenarioDRetryCallCount;
        },
        get sentinelStored() {
            return sentinelBytes !== null;
        }
    };
}

function makeDerivative(role, bytes, width, height, binding) {
    const digest = sha256(bytes);
    return {
        storageRole: role,
        sha256: digest,
        byteLength: bytes.byteLength,
        width,
        height,
        metadataEntryCount: 0,
        stagingKey: buildV1StagingDerivativeKey({
            site: binding.site,
            draftId: binding.draftId,
            processingRunId: binding.processingRunId,
            sha256: digest,
            role
        }),
        payload: new Blob([bytes], { type: 'image/webp' })
    };
}

function makeRunId(index) {
    return `run_${index.toString(16).padStart(12, '0')}40008${'0'.repeat(14)}${index}`;
}

function makeCleanupId(index) {
    return `cleanup_${index.toString(16).padStart(12, '0')}40008` +
        `${'0'.repeat(14)}${index}`;
}

function jsonResponse(status, body) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

function cloneSafeRunnerCall(request) {
    const clone = { ...request };
    if (request.bytes instanceof Uint8Array) {
        clone.bytes = Uint8Array.from(request.bytes);
    }
    return clone;
}

function installManualTimers() {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const pending = new Map();
    let nextHandle = 1;
    let clearCallCount = 0;
    globalThis.setTimeout = (callback, delay, ...args) => {
        assert.equal(typeof callback, 'function');
        const handle = nextHandle++;
        pending.set(handle, {
            delay,
            callback: () => callback(...args)
        });
        return handle;
    };
    globalThis.clearTimeout = handle => {
        clearCallCount += 1;
        pending.delete(handle);
    };
    return {
        fireNext(expectedDelay) {
            const entry = [...pending.entries()].find(([, timer]) =>
                timer.delay === expectedDelay
            );
            assert.ok(entry, `Missing manual ${expectedDelay}ms timer.`);
            pending.delete(entry[0]);
            entry[1].callback();
        },
        get pendingCount() {
            return pending.size;
        },
        get clearCallCount() {
            return clearCallCount;
        },
        restore() {
            pending.clear();
            globalThis.setTimeout = originalSetTimeout;
            globalThis.clearTimeout = originalClearTimeout;
        }
    };
}

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
