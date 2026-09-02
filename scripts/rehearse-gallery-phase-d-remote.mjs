import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import catalogSnapshot from '../gallery-admin/generated/catalog-snapshot.js';
import {
    buildV1StagingDerivativeKey,
    privateOriginalKeyMatchesRecord,
    parsePrivateOriginalKey,
    parseV1StagingDerivativeKey
} from '../gallery-admin/src/storage-keys.js';
import { processSyntheticGalleryPhoto } from './gallery-media/processor.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const adminConfigPath = 'gallery-admin/wrangler.admin.local.jsonc';
const databaseName = 'family-running-gallery-dev';
const processingWorkerName = 'family-running-gallery-processing-dev';
const trustedProcessingOrigin =
    'https://family-running-gallery-processing-dev.family-running.workers.dev';
const stagingBucketName = 'family-running-gallery-staging-dev';
const eligibleMarker = 'synthetic-phase-d-race-rehearsal';
const fixtureSiteModesJson = '["family"]';
const fixtureRaceDate = '2026-08-22';
const fixtureRaceEvent = 'Budapest Park, Toronto - Parkrun';
const fixtureRaceDistance = '5 km';
const fixtureAthleteIdsJson = '["john-kevan"]';
const fixtureOriginalSha256 =
    '6768c0fdd5f22b6eed7425d141a4b69da531ccfa68d9f59ca9388d656f0b81ff';
const serviceRequestTimeoutMs = 30_000;
const wranglerCommandTimeoutMs = 60_000;
const wranglerKillGraceMs = 2_000;
const rehearsalFaultHeader = 'X-Gallery-Rehearsal-Fault';
const runIdPattern = /^run_[a-f0-9]{12}4[a-f0-9]{3}[89ab][a-f0-9]{15}$/;
const draftIdPattern =
    /^draft_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const accessClientIdPattern = /^[0-9a-f]{32}\.access$/;
const accessSecretPattern = /^[A-Za-z0-9_-]{32,256}$/;
const exactOptionKeys = Object.freeze([
    'fetchImpl',
    'processPhoto',
    'processingOrigin',
    'serviceToken',
    'wranglerRunner'
]);
const sentinelBytes = Buffer.from(
    'family-running synthetic phase-d prefix sentinel v1\n',
    'utf8'
);
const sentinelSha256 = sha256(sentinelBytes);
const sentinelLeaf = 'rehearsal-untracked-sentinel.bin';
const internalWranglerRequestCapability = Symbol('phase-d-internal-wrangler-request');
const scenarioAStartIdempotencyKey = 'phase-d-remote-a-start-0001';
const scenarioAFailureIdempotencyKey = 'phase-d-remote-a-failed-0001';
const scenarioACleanupIdempotencyKey = 'phase-d-remote-a-cleanup-0001';
const scenarioARetryIdempotencyKey = 'phase-d-remote-a-retry-0001';
const scenarioAProcessingStateVersion = 4;
const scenarioAFailedStateVersion = 5;
const scenarioAApprovedStateVersion = 6;
const scenarioADiagnosticsJson =
    '{"schemaVersion":"1.0","code":"processing-failed"}';
const scenarioDProcessingStateVersion = 13;
const scenarioDFailedStateVersion = 14;
const scenarioDApprovedStateVersion = 15;
const scenarioDDisplayIdempotencyKey = 'phase-d-remote-d-display-0001';
const cleanupIdPattern =
    /^cleanup_[a-f0-9]{12}4[a-f0-9]{3}[89ab][a-f0-9]{15}$/;
const scenarioPlan = Object.freeze([
    Object.freeze({ key: 'a', label: 'failed-no-output' }),
    Object.freeze({ key: 'b', label: 'lost-upload-part' }),
    Object.freeze({ key: 'c', label: 'abort-wins-lost-abort' }),
    Object.freeze({ key: 'd', label: 'complete-wins-lost-delete' }),
    Object.freeze({ key: 'e', label: 'exact-prefix-refusal' }),
    Object.freeze({ key: 'f', label: 'final-staged' })
]);
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

export const galleryPhaseDRemoteRehearsalContract = Object.freeze({
    adminConfigPath,
    databaseName,
    eligibleMarker,
    processingWorkerName,
    trustedProcessingOrigin,
    stagingBucketName,
    fixture: Object.freeze({
        publicItemId: eligibleMarker,
        siteModesJson: fixtureSiteModesJson,
        raceDate: fixtureRaceDate,
        raceEvent: fixtureRaceEvent,
        raceDistance: fixtureRaceDistance,
        athleteIdsJson: fixtureAthleteIdsJson,
        originalSha256: fixtureOriginalSha256
    }),
    timeouts: Object.freeze({
        serviceRequestMilliseconds: serviceRequestTimeoutMs,
        wranglerCommandMilliseconds: wranglerCommandTimeoutMs,
        wranglerKillGraceMilliseconds: wranglerKillGraceMs
    }),
    faultValues: Object.freeze([
        'after-upload-part',
        'after-complete',
        'after-abort',
        'after-delete'
    ]),
    scenarios: Object.freeze(scenarioPlan.map(({ key, label }) => ({ key, label })))
});

// Narrow local test seam: it exposes no rehearsal option, credential, media
// identifier, or Wrangler argument. Tests supply only a fake child launcher so
// the exact production deadline/kill path can be advanced without waiting.
export const galleryPhaseDRemoteRehearsalTestHooks = Object.freeze({
    exerciseWranglerDeadline(spawnImpl) {
        if (typeof spawnImpl !== 'function') {
            throw rehearsalError('invalid-wrangler-test-launcher');
        }
        return spawnWrangler('phase-d-wrangler-timeout-probe.mjs', [], undefined, spawnImpl);
    }
});

/**
 * Run the complete non-production, synthetic-only A-F rehearsal.
 *
 * This is deliberately a callable module rather than a command-line program.
 * The Cloudflare Access service token is accepted only as an in-memory argument;
 * this module never reads it from argv, the environment, a file, or a log.
 *
 * This is a one-way remote sequence with narrowly bounded Scenario A and
 * Scenario D resume paths. Recovery never restores or recreates the D1 fixture
 * by itself. It first reconciles the exact server-returned run, staging
 * object/multipart, cleanup, receipt, audit, and tombstone evidence; otherwise
 * a D1-only recovery could orphan private R2 state.
 */
export async function runGalleryPhaseDRemoteRehearsal(options) {
    const dependencies = validateOptions(options);
    const d1 = createD1Client(dependencies.wranglerRunner);
    const boundaryBefore = await readBoundarySnapshot(d1, 'boundary-before');
    assertPrivateBoundary(boundaryBefore);
    await assertRetryMigrationReady(d1);

    const fixture = await discoverExactFixture(d1);
    let currentStateVersion = fixture.stateVersion;
    let cleanupCount = 0;
    let derivativePutCount = 0;
    let interruptedRequestCount = 0;
    const scenarioStatuses = [];
    const scenarioDRecovery = ['d-failed', 'd-after-retry'].includes(
        fixture.recoveryPhase
    );

    if (scenarioDRecovery) {
        // A-C are counted only after their complete immutable history is
        // attested by recoverScenarioD. The fifth interrupted request is added
        // only after D reaches its terminal cleanup proof.
        cleanupCount = 3;
        derivativePutCount = 1;
        interruptedRequestCount = 4;
        scenarioStatuses.push(
            statusRecord('a'),
            statusRecord('b'),
            statusRecord('c')
        );
        currentStateVersion = await recoverScenarioD(dependencies, d1, fixture);
        cleanupCount += 1;
        interruptedRequestCount += 1;
        scenarioStatuses.push(statusRecord('d'));
    } else {

    // A: fail before any derivative is admitted, then prove zero-output cleanup.
    // A prior interrupted invocation may be continued only from one of the two
    // exact server-discovered Scenario A checkpoints. Nothing is reset or
    // recreated, and the normal fresh path retains its original strict replay
    // expectations.
    if (fixture.recoveryPhase === null) {
        const run = await startRun(dependencies, fixture.draftId, currentStateVersion, 'a');
        const failed = await failRun(dependencies, run, 'a');
        const cleaned = await cleanupRun(dependencies, run, failed.stateVersion, 'a');
        requireStatus(cleaned.response, 201, 'cleanup-a');
        requireCleanupSuccess(cleaned.body, run.processingRunId, false, 'cleanup-a');
        await assertCleanedRun(d1, run.processingRunId, 0);
        currentStateVersion = await retryFailedRun(
            dependencies, run, failed.stateVersion, 'a'
        );
        cleanupCount += 1;
        scenarioStatuses.push(statusRecord('a'));
    } else {
        const run = Object.freeze({
            processingRunId: fixture.scenarioAProcessingRunId
        });
        if (fixture.recoveryPhase === 'before-retry') {
            const beforeRetry = await readScenarioARecoverySnapshot(
                d1,
                fixture,
                'recovery-a-before-retry'
            );
            assertScenarioARecoverySnapshot(beforeRetry, fixture, 'before-retry');
            const firstRetryVersion = await retryFailedRun(
                dependencies,
                run,
                scenarioAFailedStateVersion,
                'a',
                'either'
            );
            if (firstRetryVersion !== scenarioAApprovedStateVersion) {
                throw rehearsalError('recovery-a-retry-state-invalid');
            }
        }

        const beforeReplay = assertScenarioARecoverySnapshot(
            await readScenarioARecoverySnapshot(
                d1,
                fixture,
                'recovery-a-before-replay'
            ),
            fixture,
            'after-retry'
        );
        const replayVersion = await retryFailedRun(
            dependencies,
            run,
            scenarioAFailedStateVersion,
            'a',
            'replayed'
        );
        if (replayVersion !== scenarioAApprovedStateVersion) {
            throw rehearsalError('recovery-a-replay-state-invalid');
        }
        const afterReplay = assertScenarioARecoverySnapshot(
            await readScenarioARecoverySnapshot(
                d1,
                fixture,
                'recovery-a-after-replay'
            ),
            fixture,
            'after-retry'
        );
        if (JSON.stringify(afterReplay) !== JSON.stringify(beforeReplay)) {
            throw rehearsalError('recovery-a-replay-mutated-evidence');
        }

        currentStateVersion = scenarioAApprovedStateVersion;
        cleanupCount = 1;
        scenarioStatuses.push(statusRecord('a'));
    }

    // B: lose the provider upload-part response, then replay the exact bytes.
    {
        const run = await startRun(dependencies, fixture.draftId, currentStateVersion, 'b');
        const processed = await processRunPhoto(dependencies, fixture.draftId, run);
        const display = derivativeByRole(processed, 'photo-display');
        requireStatus(
            await putDerivative(dependencies, run, display, 'b-display', 'after-upload-part'),
            503,
            'fault-b-after-upload-part'
        );
        interruptedRequestCount += 1;
        requireStatus(
            await putDerivative(dependencies, run, display, 'b-display'),
            201,
            'retry-b-display'
        );
        derivativePutCount += 1;
        const failed = await failRun(dependencies, run, 'b');
        const cleaned = await cleanupRun(dependencies, run, failed.stateVersion, 'b');
        requireStatus(cleaned.response, 201, 'cleanup-b');
        requireCleanupSuccess(cleaned.body, run.processingRunId, false, 'cleanup-b');
        await assertCleanedRun(d1, run.processingRunId, 1);
        currentStateVersion = await retryFailedRun(
            dependencies, run, failed.stateVersion, 'b'
        );
        cleanupCount += 1;
        scenarioStatuses.push(statusRecord('b'));
    }

    // C: a part exists but completion has not won; cleanup aborts it. The first
    // abort response is then deliberately lost and the exact cleanup is retried.
    {
        const run = await startRun(dependencies, fixture.draftId, currentStateVersion, 'c');
        const processed = await processRunPhoto(dependencies, fixture.draftId, run);
        const display = derivativeByRole(processed, 'photo-display');
        requireStatus(
            await putDerivative(dependencies, run, display, 'c-display', 'after-upload-part'),
            503,
            'fault-c-after-upload-part'
        );
        interruptedRequestCount += 1;
        const failed = await failRun(dependencies, run, 'c');
        const firstCleanup = await cleanupRun(
            dependencies,
            run,
            failed.stateVersion,
            'c',
            'after-abort'
        );
        requireStatus(firstCleanup.response, 503, 'fault-c-after-abort');
        interruptedRequestCount += 1;
        const replay = await cleanupRun(dependencies, run, failed.stateVersion, 'c');
        requireStatus(replay.response, 200, 'retry-c-cleanup');
        requireCleanupSuccess(
            replay.body, run.processingRunId, true, 'retry-c-cleanup'
        );
        await assertCleanedRun(d1, run.processingRunId, 1);
        currentStateVersion = await retryFailedRun(
            dependencies, run, failed.stateVersion, 'c'
        );
        cleanupCount += 1;
        scenarioStatuses.push(statusRecord('c'));
    }

    // D: completion creates the exact object before its response is lost. The
    // cleanup path recognizes complete-wins, deletes it, then loses that delete
    // response and converges on an exact replay.
    {
        const run = await startRun(dependencies, fixture.draftId, currentStateVersion, 'd');
        const processed = await processRunPhoto(dependencies, fixture.draftId, run);
        const display = derivativeByRole(processed, 'photo-display');
        requireStatus(
            await putDerivative(dependencies, run, display, 'd-display', 'after-complete'),
            503,
            'fault-d-after-complete'
        );
        interruptedRequestCount += 1;
        const failed = await failRun(dependencies, run, 'd');
        const firstCleanup = await cleanupRun(
            dependencies,
            run,
            failed.stateVersion,
            'd',
            'after-delete'
        );
        requireStatus(firstCleanup.response, 503, 'fault-d-after-delete');
        interruptedRequestCount += 1;
        const replay = await cleanupRun(dependencies, run, failed.stateVersion, 'd');
        requireStatus(replay.response, 200, 'retry-d-cleanup');
        requireCleanupSuccess(
            replay.body, run.processingRunId, true, 'retry-d-cleanup'
        );
        await assertCleanedRun(d1, run.processingRunId, 1);
        currentStateVersion = await retryFailedRun(
            dependencies, run, failed.stateVersion, 'd'
        );
        cleanupCount += 1;
        scenarioStatuses.push(statusRecord('d'));
    }
    }

    // E: place one fixed synthetic sentinel beneath the exact server-derived
    // run prefix. Cleanup must refuse to tombstone that non-ledger object.
    {
        const run = await startRun(dependencies, fixture.draftId, currentStateVersion, 'e');
        const processed = await processRunPhoto(dependencies, fixture.draftId, run);
        const display = derivativeByRole(processed, 'photo-display');
        requireStatus(
            await putDerivative(dependencies, run, display, 'e-display'),
            201,
            'put-e-display'
        );
        derivativePutCount += 1;
        const failed = await failRun(dependencies, run, 'e');
        const sentinelKey = buildSentinelKey(fixture.draftId, run);
        let sentinelPutAttempted = false;
        let sentinelDeleted = false;
        try {
            sentinelPutAttempted = true;
            await dependencies.wranglerRunner(internalWranglerRequest({
                kind: 'staging-put-sentinel',
                configPath: adminConfigPath,
                bucketName: stagingBucketName,
                key: sentinelKey,
                bytes: Uint8Array.from(sentinelBytes),
                sha256: sentinelSha256
            }));
            const refused = await cleanupRun(dependencies, run, failed.stateVersion, 'e');
            requireStatus(refused.response, 503, 'prefix-e-refusal');
            await assertPrefixRefusal(d1, run.processingRunId);
            await deleteExactSentinel(dependencies, sentinelKey);
            sentinelDeleted = true;
            const cleaned = await cleanupRun(dependencies, run, failed.stateVersion, 'e');
            requireStatus(cleaned.response, 200, 'retry-e-cleanup');
            requireCleanupSuccess(
                cleaned.body, run.processingRunId, true, 'retry-e-cleanup'
            );
            await assertCleanedRun(d1, run.processingRunId, 1);
            currentStateVersion = await retryFailedRun(
                dependencies, run, failed.stateVersion, 'e'
            );
            cleanupCount += 1;
            scenarioStatuses.push(statusRecord('e'));
        } finally {
            if (sentinelPutAttempted && !sentinelDeleted) {
                try {
                    await deleteExactSentinel(dependencies, sentinelKey);
                    sentinelDeleted = true;
                } catch {
                    throw rehearsalError('sentinel-failsafe-cleanup-failed');
                }
            }
        }
    }

    // F is intentionally last. A staged run remains in processing and the D1
    // replacement guard correctly prevents this draft being reused again.
    {
        const run = await startRun(dependencies, fixture.draftId, currentStateVersion, 'f');
        const processed = await processRunPhoto(dependencies, fixture.draftId, run);
        for (const role of run.requiredRoles) {
            const derivative = derivativeByRole(processed, role);
            requireStatus(
                await putDerivative(dependencies, run, derivative, `f-${role}`),
                201,
                `put-f-${role}`
            );
            derivativePutCount += 1;
        }
        const staged = await recordStagedResult(dependencies, run, processed, 'f');
        requireStatus(staged.response, 200, 'result-f-staged');
        if (
            !hasExactKeys(staged.body, [
                'schemaVersion',
                'processingRunId',
                'status',
                'state',
                'stateVersion',
                'roles',
                'replayed'
            ]) ||
            staged.body.schemaVersion !== '1.0' ||
            staged.body.processingRunId !== run.processingRunId ||
            staged.body.status !== 'staged' ||
            staged.body.state !== 'processing' ||
            staged.body.stateVersion !== run.stateVersion ||
            !exactRoles(staged.body.roles, run.requiredRoles) ||
            staged.body.replayed !== false
        ) {
            throw rehearsalError('final-staged-state-mismatch');
        }
        await assertFinalStagedRun(d1, run.processingRunId, cleanupCount);
        scenarioStatuses.push(statusRecord('f'));
    }

    const boundaryAfter = await readBoundarySnapshot(d1, 'boundary-after');
    assertPrivateBoundary(boundaryAfter);
    if (JSON.stringify(boundaryAfter) !== JSON.stringify(boundaryBefore)) {
        throw rehearsalError('approved-public-boundary-changed');
    }
    const foreignKeys = await d1.rows('foreign-key-check', 'PRAGMA foreign_key_check;');
    if (foreignKeys.length !== 0) {
        throw rehearsalError('foreign-key-check-failed');
    }

    // The returned report contains counts and pass/fail statuses only. It never
    // carries credentials, identities, sites, tags, IDs, keys, hashes, or media.
    return Object.freeze({
        status: 'passed',
        scenarioCount: scenarioStatuses.length,
        cleanupCount,
        derivativePutCount,
        interruptedRequestCount,
        scenarios: Object.freeze(scenarioStatuses),
        finalStatus: 'staged',
        approvedReferenceCount: boundaryAfter.approvedReferenceCount,
        publicationReferenceCount: boundaryAfter.publicationReferenceCount,
        publicwardDraftCount: boundaryAfter.publicwardDraftCount,
        foreignKeyViolationCount: 0
    });
}

export async function runGalleryPhaseDRemoteRehearsalWithLocalDefaults(options) {
    if (
        !isPlainObject(options) ||
        !hasExactKeys(options, ['processingOrigin', 'serviceToken'])
    ) {
        throw rehearsalError('invalid-local-rehearsal-options');
    }
    return runGalleryPhaseDRemoteRehearsal({
        serviceToken: options.serviceToken,
        processingOrigin: options.processingOrigin,
        fetchImpl: globalThis.fetch,
        wranglerRunner: createGalleryPhaseDWranglerRunner(),
        processPhoto: processSyntheticGalleryPhoto
    });
}

/**
 * Create the concrete local Wrangler adapter used from a Node REPL. It invokes
 * the repository-pinned Wrangler through the current Node process, never a
 * shell, and permits only the D1 and private-staging actions emitted above.
 */
function createGalleryPhaseDWranglerRunner() {
    const wranglerEntrypoint = path.join(
        repositoryRoot,
        'node_modules',
        'wrangler',
        'bin',
        'wrangler.js'
    );
    let activeSentinelKey = null;
    let activeSentinelVerified = false;
    return async request => {
        if (
            !isPlainObject(request) ||
            request[internalWranglerRequestCapability] !== true
        ) {
            throw rehearsalError('invalid-wrangler-request');
        }
        if (request.kind === 'd1-json') {
            assertExactWranglerCoordinates(request);
            assertAllowedD1Query(request);
            const output = await spawnWrangler(wranglerEntrypoint, [
                'd1', 'execute', databaseName,
                '--remote',
                '--config', adminConfigPath,
                '--command', request.sql,
                '--json'
            ]);
            return parseD1Rows(output.stdout);
        }
        if (request.kind === 'staging-get-recovery-object') {
            assertExactRecoveryStagingRequest(request);
            const output = await spawnWrangler(wranglerEntrypoint, [
                'r2', 'object', 'get', `${stagingBucketName}/${request.key}`,
                '--remote', '--pipe',
                '--config', adminConfigPath
            ]);
            const bytes = Uint8Array.from(output.stdout);
            if (
                bytes.byteLength !== request.byteLength ||
                sha256(bytes) !== request.sha256
            ) {
                throw rehearsalError('recovery-d-staging-object-mismatch');
            }
            return bytes;
        }
        assertExactSentinelRequest(request);
        const objectPath = `${stagingBucketName}/${request.key}`;
        if (request.kind === 'staging-put-sentinel') {
            if (
                activeSentinelKey !== null ||
                !(request.bytes instanceof Uint8Array) ||
                sha256(request.bytes) !== sentinelSha256 ||
                request.sha256 !== sentinelSha256
            ) {
                throw rehearsalError('invalid-sentinel-put');
            }
            // Retain the exact attempted key before the remote call. If the
            // command stores the object but its response is lost, Scenario E's
            // finally block can still re-read and remove only this sentinel.
            activeSentinelKey = request.key;
            activeSentinelVerified = false;
            await spawnWrangler(wranglerEntrypoint, [
                'r2', 'object', 'put', objectPath,
                '--remote', '--pipe', '--force',
                '--content-type', 'application/octet-stream',
                '--config', adminConfigPath
            ], request.bytes);
            return Object.freeze({ status: 'stored' });
        }
        if (request.kind === 'staging-get-sentinel') {
            if (request.key !== activeSentinelKey) {
                throw rehearsalError('invalid-sentinel-get');
            }
            const output = await spawnWrangler(wranglerEntrypoint, [
                'r2', 'object', 'get', objectPath,
                '--remote', '--pipe',
                '--config', adminConfigPath
            ]);
            const bytes = Uint8Array.from(output.stdout);
            if (sha256(bytes) !== sentinelSha256) {
                throw rehearsalError('sentinel-evidence-mismatch');
            }
            activeSentinelVerified = true;
            return bytes;
        }
        if (request.kind === 'staging-delete-sentinel') {
            if (
                request.key !== activeSentinelKey ||
                activeSentinelVerified !== true ||
                request.expectedSha256 !== sentinelSha256
            ) {
                throw rehearsalError('invalid-sentinel-delete');
            }
            // Wrangler has no conditional R2 delete flag. Re-read the exact
            // fixed bytes immediately before deletion. The private adapter is
            // unexported, accepts an unforgeable internal capability, and only
            // one current server-owned run can reach this unique leaf.
            const current = await spawnWrangler(wranglerEntrypoint, [
                'r2', 'object', 'get', objectPath,
                '--remote', '--pipe',
                '--config', adminConfigPath
            ]);
            if (sha256(current.stdout) !== sentinelSha256) {
                throw rehearsalError('sentinel-evidence-mismatch');
            }
            await spawnWrangler(wranglerEntrypoint, [
                'r2', 'object', 'delete', objectPath,
                '--remote',
                '--config', adminConfigPath
            ]);
            activeSentinelKey = null;
            activeSentinelVerified = false;
            return Object.freeze({ status: 'deleted' });
        }
        throw rehearsalError('unsupported-wrangler-request');
    };
}

function validateOptions(options) {
    if (
        !isPlainObject(options) ||
        !hasExactKeys(options, exactOptionKeys) ||
        options.processingOrigin !== trustedProcessingOrigin ||
        typeof options.fetchImpl !== 'function' ||
        typeof options.wranglerRunner !== 'function' ||
        typeof options.processPhoto !== 'function' ||
        !isPlainObject(options.serviceToken) ||
        !hasExactKeys(options.serviceToken, ['clientId', 'clientSecret']) ||
        !accessClientIdPattern.test(options.serviceToken.clientId || '') ||
        !accessSecretPattern.test(options.serviceToken.clientSecret || '')
    ) {
        throw rehearsalError('invalid-rehearsal-options');
    }
    return Object.freeze({ ...options });
}

function createD1Client(wranglerRunner) {
    return Object.freeze({
        async rows(label, sql) {
            if (!/^[a-z0-9-]{1,80}$/.test(label) || typeof sql !== 'string') {
                throw rehearsalError('invalid-d1-query');
            }
            const request = internalWranglerRequest({
                kind: 'd1-json',
                label,
                configPath: adminConfigPath,
                databaseName,
                sql
            });
            assertExactWranglerCoordinates(request);
            assertAllowedD1Query(request);
            const rows = await wranglerRunner(request);
            if (!Array.isArray(rows) || rows.some(row => !isPlainObject(row))) {
                throw rehearsalError('invalid-d1-response');
            }
            return rows;
        }
    });
}

async function assertRetryMigrationReady(d1) {
    const indexRows = await d1.rows(
        'retry-index-preflight',
        retryIndexPreflightSql()
    );
    if (
        indexRows.length !== 2 ||
        !indexRows.every(row =>
            hasExactKeys(row, [
                'indexName',
                'isUnique',
                'isPartial',
                'sequenceNumber',
                'columnName'
            ]) &&
            row.indexName ===
                'draft_transition_receipts_state_version_unique' &&
            row.isUnique === 1 &&
            row.isPartial === 0
        ) ||
        indexRows[0].sequenceNumber !== 0 ||
        indexRows[0].columnName !== 'draft_id' ||
        indexRows[1].sequenceNumber !== 1 ||
        indexRows[1].columnName !== 'expected_state_version'
    ) {
        throw rehearsalError('retry-migration-index-invalid');
    }

    const duplicateRows = await d1.rows(
        'retry-duplicates-preflight',
        retryDuplicatesPreflightSql()
    );
    if (
        duplicateRows.length !== 1 ||
        !hasExactKeys(duplicateRows[0], ['duplicateGroupCount']) ||
        duplicateRows[0].duplicateGroupCount !== 0
    ) {
        throw rehearsalError('retry-migration-duplicates-present');
    }
}

function retryIndexPreflightSql() {
    return `
        SELECT
            index_list.name AS indexName,
            index_list."unique" AS isUnique,
            index_list.partial AS isPartial,
            index_info.seqno AS sequenceNumber,
            index_info.name AS columnName
        FROM pragma_index_list('draft_transition_receipts') AS index_list
        JOIN pragma_index_info(
            'draft_transition_receipts_state_version_unique'
        ) AS index_info
        WHERE index_list.name =
            'draft_transition_receipts_state_version_unique'
        ORDER BY index_info.seqno
    `;
}

function retryDuplicatesPreflightSql() {
    return `
        SELECT COUNT(*) AS duplicateGroupCount
        FROM (
            SELECT 1
            FROM draft_transition_receipts
            GROUP BY draft_id, expected_state_version
            HAVING COUNT(*) > 1
        ) AS duplicate_groups
    `;
}

async function discoverExactFixture(d1) {
    const rows = await d1.rows('discover-fixture', discoverFixtureSql());
    if (rows.length !== 1) {
        throw rehearsalError('eligible-fixture-count-mismatch');
    }
    const row = rows[0];
    let siteModes;
    let athleteIds;
    try {
        siteModes = JSON.parse(row.siteModesJson);
        athleteIds = JSON.parse(row.athleteIdsJson);
    } catch {
        throw rehearsalError('eligible-fixture-invalid');
    }
    const parsedOriginalKey = parsePrivateOriginalKey(row.originalObjectKey);
    const discoveredRuns = Object.freeze(Object.fromEntries(scenarioPlan.map(({ key }) => {
        const upperKey = key.toUpperCase();
        return [key, Object.freeze({
            count: row[`scenario${upperKey}RunCount`],
            processingRunId: row[`scenario${upperKey}ProcessingRunId`]
        })];
    })));
    if (
        !draftIdPattern.test(row.draftId || '') ||
        !Number.isSafeInteger(row.stateVersion) ||
        row.stateVersion < 0 ||
        !Array.isArray(siteModes) ||
        siteModes.length !== 1 ||
        siteModes[0] !== 'family' ||
        row.siteModesJson !== fixtureSiteModesJson ||
        !Array.isArray(athleteIds) ||
        athleteIds.length !== 1 ||
        athleteIds[0] !== 'john-kevan' ||
        row.athleteIdsJson !== fixtureAthleteIdsJson ||
        row.raceDate !== fixtureRaceDate ||
        row.raceEvent !== fixtureRaceEvent ||
        row.raceDistance !== fixtureRaceDistance ||
        row.originalSha256 !== fixtureOriginalSha256 ||
        row.exportBundleId !== catalogSnapshot.exportBundleId ||
        row.sourceRevision !== catalogSnapshot.sourceRevision ||
        row.suppressionRevision !== catalogSnapshot.suppressionRevision ||
        row.mediaType !== 'photo' ||
        row.uploadComplete !== 1 ||
        row.uploadStatus !== 'complete' ||
        row.syntheticOnlyConfirmed !== 1 ||
        row.consentPublicUseConfirmed !== 1 ||
        ![0, 1].includes(row.consentContainsMinors) ||
        ![0, 1].includes(row.consentGuardianApprovalConfirmed) ||
        (row.consentContainsMinors === 1 &&
            row.consentGuardianApprovalConfirmed !== 1) ||
        row.consentWithdrawnAt !== null ||
        row.pendingTaggedExclusionCount !== 0 ||
        !Number.isSafeInteger(row.priorRunCount) ||
        row.priorRunCount < 0 ||
        Object.values(discoveredRuns).some(run =>
            !Number.isSafeInteger(run.count) ||
            run.count < 0 ||
            (run.count === 0 && run.processingRunId !== null) ||
            (run.count === 1 && !runIdPattern.test(run.processingRunId || ''))
        ) ||
        row.itemRevision !== row.uploadItemRevision ||
        row.consentRevision !== row.uploadConsentRevision ||
        row.exportBundleId !== row.uploadExportBundleId ||
        row.sourceRevision !== row.uploadSourceRevision ||
        row.suppressionRevision !== row.uploadSuppressionRevision ||
        parsedOriginalKey?.kind !== 'v1-private-original' ||
        !privateOriginalKeyMatchesRecord(row.originalObjectKey, {
            site: siteModes[0],
            uploadedAt: row.uploadedAt,
            draftId: row.draftId,
            uploadId: row.uploadSessionId,
            extension: row.fileExtension
        })
    ) {
        throw rehearsalError('eligible-fixture-invalid');
    }

    const fresh =
        row.state === 'approved-for-processing' &&
        row.stateVersion === 3 &&
        row.processingDiagnosticsJson === null &&
        row.priorRunCount === 0 &&
        Object.values(discoveredRuns).every(run =>
            run.count === 0 && run.processingRunId === null
        );
    if (fresh) {
        return Object.freeze({
            draftId: row.draftId,
            stateVersion: row.stateVersion,
            recoveryPhase: null,
            scenarioAProcessingRunId: null
        });
    }

    const beforeRetry =
        row.state === 'processing-failed' &&
        row.stateVersion === scenarioAFailedStateVersion &&
        row.processingDiagnosticsJson === scenarioADiagnosticsJson;
    const afterRetry =
        row.state === 'approved-for-processing' &&
        row.stateVersion === scenarioAApprovedStateVersion &&
        row.processingDiagnosticsJson === null;
    const scenarioARecovery =
        (beforeRetry || afterRetry) &&
        row.priorRunCount === 1 &&
        discoveredRuns.a.count === 1 &&
        scenarioPlan.slice(1).every(({ key }) => discoveredRuns[key].count === 0);
    if (!scenarioARecovery) {
        const scenarioDFailed =
            row.state === 'processing-failed' &&
            row.stateVersion === scenarioDFailedStateVersion &&
            row.processingDiagnosticsJson === scenarioADiagnosticsJson;
        const scenarioDAfterRetry =
            row.state === 'approved-for-processing' &&
            row.stateVersion === scenarioDApprovedStateVersion &&
            row.processingDiagnosticsJson === null;
        const exactDRunSet =
            row.priorRunCount === 4 &&
            scenarioDRecoveryPlan.every(({ key }) => discoveredRuns[key].count === 1) &&
            discoveredRuns.e.count === 0 &&
            discoveredRuns.f.count === 0;
        if ((!scenarioDFailed && !scenarioDAfterRetry) || !exactDRunSet) {
            throw rehearsalError('eligible-fixture-invalid');
        }
        return Object.freeze({
            draftId: row.draftId,
            stateVersion: row.stateVersion,
            recoveryPhase: scenarioDFailed ? 'd-failed' : 'd-after-retry',
            scenarioAProcessingRunId: discoveredRuns.a.processingRunId,
            scenarioDProcessingRunId: discoveredRuns.d.processingRunId,
            recoveryRunIds: Object.freeze(Object.fromEntries(
                scenarioDRecoveryPlan.map(({ key }) => [
                    key,
                    discoveredRuns[key].processingRunId
                ])
            ))
        });
    }
    return Object.freeze({
        draftId: row.draftId,
        stateVersion: row.stateVersion,
        recoveryPhase: beforeRetry ? 'before-retry' : 'after-retry',
        scenarioAProcessingRunId: discoveredRuns.a.processingRunId
    });
}

function discoverFixtureSql() {
    return `
        SELECT
            draft.draft_id AS draftId,
            draft.state,
            draft.state_version AS stateVersion,
            draft.processing_diagnostics_json AS processingDiagnosticsJson,
            draft.site_modes_json AS siteModesJson,
            draft.export_bundle_id AS exportBundleId,
            draft.source_revision AS sourceRevision,
            draft.suppression_revision AS suppressionRevision,
            draft.item_revision AS itemRevision,
            draft.active_consent_revision AS consentRevision,
            draft.media_type AS mediaType,
            draft.race_date AS raceDate,
            draft.race_event AS raceEvent,
            draft.race_distance AS raceDistance,
            draft.athlete_ids_json AS athleteIdsJson,
            draft.upload_complete AS uploadComplete,
            draft.original_object_key AS originalObjectKey,
            draft.original_sha256 AS originalSha256,
            upload.upload_session_id AS uploadSessionId,
            upload.file_extension AS fileExtension,
            upload.created_at AS uploadedAt,
            upload.status AS uploadStatus,
            upload.synthetic_only_confirmed AS syntheticOnlyConfirmed,
            upload.item_revision AS uploadItemRevision,
            upload.consent_revision AS uploadConsentRevision,
            upload.export_bundle_id AS uploadExportBundleId,
            upload.source_revision AS uploadSourceRevision,
            upload.suppression_revision AS uploadSuppressionRevision,
            consent.public_use_confirmed AS consentPublicUseConfirmed,
            consent.contains_minors AS consentContainsMinors,
            consent.guardian_approval_confirmed AS consentGuardianApprovalConfirmed,
            consent.withdrawn_at AS consentWithdrawnAt,
            (SELECT COUNT(*)
                FROM json_each(draft.athlete_ids_json) AS tag
                JOIN pending_athlete_exclusions AS exclusion
                  ON exclusion.athlete_id = tag.value
                WHERE exclusion.resolved_at IS NULL) AS pendingTaggedExclusionCount,
            (SELECT COUNT(*) FROM draft_processing_runs AS run
                WHERE run.draft_id = draft.draft_id) AS priorRunCount,
            (SELECT COUNT(*) FROM draft_processing_runs AS run
                WHERE run.draft_id = draft.draft_id
                  AND run.start_idempotency_key =
                    '${scenarioAStartIdempotencyKey}') AS scenarioARunCount,
            (SELECT run.processing_run_id FROM draft_processing_runs AS run
                WHERE run.draft_id = draft.draft_id
                  AND run.start_idempotency_key =
                    '${scenarioAStartIdempotencyKey}') AS scenarioAProcessingRunId,
            (SELECT COUNT(*) FROM draft_processing_runs AS run
                WHERE run.draft_id = draft.draft_id
                  AND run.start_idempotency_key =
                    'phase-d-remote-b-start-0001') AS scenarioBRunCount,
            (SELECT run.processing_run_id FROM draft_processing_runs AS run
                WHERE run.draft_id = draft.draft_id
                  AND run.start_idempotency_key =
                    'phase-d-remote-b-start-0001') AS scenarioBProcessingRunId,
            (SELECT COUNT(*) FROM draft_processing_runs AS run
                WHERE run.draft_id = draft.draft_id
                  AND run.start_idempotency_key =
                    'phase-d-remote-c-start-0001') AS scenarioCRunCount,
            (SELECT run.processing_run_id FROM draft_processing_runs AS run
                WHERE run.draft_id = draft.draft_id
                  AND run.start_idempotency_key =
                    'phase-d-remote-c-start-0001') AS scenarioCProcessingRunId,
            (SELECT COUNT(*) FROM draft_processing_runs AS run
                WHERE run.draft_id = draft.draft_id
                  AND run.start_idempotency_key =
                    'phase-d-remote-d-start-0001') AS scenarioDRunCount,
            (SELECT run.processing_run_id FROM draft_processing_runs AS run
                WHERE run.draft_id = draft.draft_id
                  AND run.start_idempotency_key =
                    'phase-d-remote-d-start-0001') AS scenarioDProcessingRunId,
            (SELECT COUNT(*) FROM draft_processing_runs AS run
                WHERE run.draft_id = draft.draft_id
                  AND run.start_idempotency_key =
                    'phase-d-remote-e-start-0001') AS scenarioERunCount,
            (SELECT run.processing_run_id FROM draft_processing_runs AS run
                WHERE run.draft_id = draft.draft_id
                  AND run.start_idempotency_key =
                    'phase-d-remote-e-start-0001') AS scenarioEProcessingRunId,
            (SELECT COUNT(*) FROM draft_processing_runs AS run
                WHERE run.draft_id = draft.draft_id
                  AND run.start_idempotency_key =
                    'phase-d-remote-f-start-0001') AS scenarioFRunCount,
            (SELECT run.processing_run_id FROM draft_processing_runs AS run
                WHERE run.draft_id = draft.draft_id
                  AND run.start_idempotency_key =
                    'phase-d-remote-f-start-0001') AS scenarioFProcessingRunId
        FROM gallery_drafts AS draft
        JOIN draft_consent_attestations AS consent
          ON consent.draft_id = draft.draft_id
         AND consent.consent_revision = draft.active_consent_revision
        JOIN draft_upload_sessions AS upload
          ON upload.draft_id = draft.draft_id
         AND upload.object_key = draft.original_object_key
        WHERE draft.public_item_id = '${eligibleMarker}'
          AND draft.site_modes_json = '${fixtureSiteModesJson}'
          AND draft.race_date = '${fixtureRaceDate}'
          AND draft.race_event = '${fixtureRaceEvent}'
          AND draft.race_distance = '${fixtureRaceDistance}'
          AND draft.athlete_ids_json = '${fixtureAthleteIdsJson}'
          AND draft.original_sha256 = '${fixtureOriginalSha256}';
    `;
}

const scenarioDHistoryKeys = Object.freeze([
    'scenario',
    'draftId',
    'processingRunId',
    'draftState',
    'draftStateVersion',
    'processingDiagnosticsJson',
    'draftUpdatedAt',
    'runEvidenceMatch',
    'pendingTaggedExclusionCount',
    'priorRunCount',
    'startExpectedStateVersion',
    'processingStateVersion',
    'startIdempotencyKey',
    'startPayloadFingerprint',
    'runActorIdentityHash',
    'runStatus',
    'resultIdempotencyKey',
    'resultPayloadFingerprint',
    'resultTransitionKey',
    'failureCode',
    'runCreatedAt',
    'runUpdatedAt',
    'runCompletedAt',
    'cleanupId',
    'cleanupIdHash',
    'cleanupProcessingRunIdHash',
    'cleanupDraftIdHash',
    'cleanupReason',
    'cleanupExpectedStateVersion',
    'cleanupOutputCount',
    'cleanupIdempotencyKey',
    'cleanupPayloadFingerprint',
    'cleanupActorIdentityHash',
    'cleanupStatus',
    'cleanupEvidenceHash',
    'cleanupCreatedAt',
    'cleanupUpdatedAt',
    'cleanupCompletedAt',
    'outputRowCount',
    'multipartRowCount',
    'derivativeRowCount',
    'cleanupCount',
    'cleanupObjectCount',
    'absentCleanupObjectCount',
    'activeCleanupObjectCount',
    'matchingTombstoneCount',
    'runTombstoneCount',
    'startReceiptCount',
    'failureReceiptCount',
    'startAuditCount',
    'failureAuditCount',
    'retryReceiptCount',
    'retryStateVersionReceiptCount',
    'retryReceiptIdempotencyKey',
    'retryReceiptPayloadFingerprint',
    'retryReceiptFromState',
    'retryReceiptToState',
    'retryReceiptExpectedStateVersion',
    'retryReceiptResultStateVersion',
    'retryReceiptCreatedAt',
    'retryAuditCount',
    'retrySubjectAuditCount'
]);

function scenarioDRecoveryFacts(draftId, processingRunId, scenario) {
    const plan = scenarioDRecoveryPlan.find(entry => entry.key === scenario);
    if (
        !plan ||
        !draftIdPattern.test(draftId || '') ||
        !runIdPattern.test(processingRunId || '')
    ) {
        throw rehearsalError('recovery-d-binding-invalid');
    }
    const startIdempotencyKey = `phase-d-remote-${scenario}-start-0001`;
    const failureIdempotencyKey = `phase-d-remote-${scenario}-failed-0001`;
    const cleanupIdempotencyKey = `phase-d-remote-${scenario}-cleanup-0001`;
    const retryIdempotencyKey = `phase-d-remote-${scenario}-retry-0001`;
    const startPayloadFingerprint = sha256Text(JSON.stringify({
        operation: 'processing-start',
        draftId,
        expectedStateVersion: plan.startExpectedStateVersion,
        idempotencyKey: startIdempotencyKey
    }));
    const failurePayloadFingerprint = sha256Text(JSON.stringify({
        operation: 'processing-result',
        processingRunId,
        result: {
            outcome: 'failed',
            expectedStateVersion: plan.processingStateVersion,
            idempotencyKey: failureIdempotencyKey,
            errorCode: 'processing-failed'
        }
    }));
    const cleanupPayloadFingerprint = sha256Text(JSON.stringify({
        operation: 'processing-cleanup',
        processingRunId,
        expectedStateVersion: plan.failedStateVersion,
        idempotencyKey: cleanupIdempotencyKey
    }));
    const retryPayloadFingerprint = sha256Text(JSON.stringify({
        operation: 'processing-retry',
        processingRunId,
        expectedStateVersion: plan.failedStateVersion,
        idempotencyKey: retryIdempotencyKey
    }));
    return Object.freeze({
        ...plan,
        startIdempotencyKey,
        failureIdempotencyKey,
        cleanupIdempotencyKey,
        retryIdempotencyKey,
        startPayloadFingerprint,
        failurePayloadFingerprint,
        cleanupPayloadFingerprint,
        retryPayloadFingerprint,
        failureTransitionKey:
            `failure_${sha256Text(`${processingRunId}:${failureIdempotencyKey}`)}`,
        auditSubjectHash: sha256Text(`draft:${draftId}`),
        draftIdHash: sha256Text(draftId),
        processingRunIdHash: sha256Text(processingRunId)
    });
}

async function readScenarioDHistory(d1, fixture) {
    if (
        !isPlainObject(fixture) ||
        !draftIdPattern.test(fixture.draftId || '') ||
        !isPlainObject(fixture.recoveryRunIds) ||
        scenarioDRecoveryPlan.some(({ key }) =>
            !runIdPattern.test(fixture.recoveryRunIds[key] || '')
        )
    ) {
        throw rehearsalError('recovery-d-binding-invalid');
    }
    const rows = await d1.rows(
        'recovery-d-history',
        scenarioDHistorySql(fixture.draftId)
    );
    if (
        rows.length !== scenarioDRecoveryPlan.length ||
        rows.some(row => !hasExactKeys(row, scenarioDHistoryKeys))
    ) {
        throw rehearsalError('recovery-d-history-unavailable');
    }
    return rows;
}

function assertScenarioDHistory(rows, fixture) {
    const byScenario = new Map(rows.map(row => [row.scenario, row]));
    if (
        byScenario.size !== scenarioDRecoveryPlan.length ||
        scenarioDRecoveryPlan.some(({ key }) => !byScenario.has(key))
    ) {
        throw rehearsalError('recovery-d-history-invalid');
    }

    let recoveryPhase;
    const dRow = byScenario.get('d');
    if (
        fixture.recoveryPhase === 'd-failed' &&
        dRow.cleanupStatus === 'deleting'
    ) {
        recoveryPhase = 'd-deleting';
    } else if (
        fixture.recoveryPhase === 'd-failed' &&
        dRow.cleanupStatus === 'cleaned'
    ) {
        recoveryPhase = 'd-cleaned-before-retry';
    } else if (
        fixture.recoveryPhase === 'd-after-retry' &&
        dRow.cleanupStatus === 'cleaned'
    ) {
        recoveryPhase = 'd-after-retry';
    } else {
        throw rehearsalError('recovery-d-phase-invalid');
    }

    const expectedDraftState = recoveryPhase === 'd-after-retry'
        ? 'approved-for-processing'
        : 'processing-failed';
    const expectedDraftVersion = recoveryPhase === 'd-after-retry'
        ? scenarioDApprovedStateVersion
        : scenarioDFailedStateVersion;
    const expectedDiagnostics = recoveryPhase === 'd-after-retry'
        ? null
        : scenarioADiagnosticsJson;
    const expectedRetryAuditCount = recoveryPhase === 'd-after-retry' ? 4 : 3;

    for (const plan of scenarioDRecoveryPlan) {
        const row = byScenario.get(plan.key);
        const facts = scenarioDRecoveryFacts(
            fixture.draftId,
            fixture.recoveryRunIds[plan.key],
            plan.key
        );
        if (
            row.draftId !== fixture.draftId ||
            row.processingRunId !== fixture.recoveryRunIds[plan.key] ||
            row.draftState !== expectedDraftState ||
            row.draftStateVersion !== expectedDraftVersion ||
            row.processingDiagnosticsJson !== expectedDiagnostics ||
            !nonEmptyString(row.draftUpdatedAt) ||
            row.runEvidenceMatch !== 1 ||
            row.pendingTaggedExclusionCount !== 0 ||
            row.priorRunCount !== 4 ||
            row.startExpectedStateVersion !== facts.startExpectedStateVersion ||
            row.processingStateVersion !== facts.processingStateVersion ||
            row.startIdempotencyKey !== facts.startIdempotencyKey ||
            row.startPayloadFingerprint !== facts.startPayloadFingerprint ||
            !sha256Pattern.test(row.runActorIdentityHash || '') ||
            row.runStatus !== 'failed' ||
            row.resultIdempotencyKey !== facts.failureIdempotencyKey ||
            row.resultPayloadFingerprint !== facts.failurePayloadFingerprint ||
            row.resultTransitionKey !== facts.failureTransitionKey ||
            row.failureCode !== 'processing-failed' ||
            !nonEmptyString(row.runCreatedAt) ||
            !nonEmptyString(row.runUpdatedAt) ||
            row.runUpdatedAt !== row.runCompletedAt ||
            !cleanupIdPattern.test(row.cleanupId || '') ||
            row.cleanupIdHash !== sha256Text(row.cleanupId) ||
            row.cleanupProcessingRunIdHash !== facts.processingRunIdHash ||
            row.cleanupDraftIdHash !== facts.draftIdHash ||
            row.cleanupReason !== 'processing-failed' ||
            row.cleanupExpectedStateVersion !== facts.failedStateVersion ||
            row.cleanupOutputCount !== facts.cleanupOutputCount ||
            row.cleanupIdempotencyKey !== facts.cleanupIdempotencyKey ||
            row.cleanupPayloadFingerprint !== facts.cleanupPayloadFingerprint ||
            !sha256Pattern.test(row.cleanupActorIdentityHash || '') ||
            !nonEmptyString(row.cleanupCreatedAt) ||
            !nonEmptyString(row.cleanupUpdatedAt) ||
            row.derivativeRowCount !== 0 ||
            row.cleanupCount !== 1 ||
            row.startReceiptCount !== 1 ||
            row.failureReceiptCount !== 1 ||
            row.startAuditCount !== 1 ||
            row.failureAuditCount !== 1 ||
            row.retrySubjectAuditCount !== expectedRetryAuditCount
        ) {
            throw rehearsalError('recovery-d-history-invalid');
        }

        if (plan.key !== 'd') {
            if (
                row.cleanupStatus !== 'cleaned' ||
                !sha256Pattern.test(row.cleanupEvidenceHash || '') ||
                !nonEmptyString(row.cleanupCompletedAt) ||
                row.cleanupUpdatedAt !== row.cleanupCompletedAt ||
                row.outputRowCount !== 0 ||
                row.multipartRowCount !== 0 ||
                row.cleanupObjectCount !== facts.cleanupOutputCount ||
                row.absentCleanupObjectCount !== facts.cleanupOutputCount ||
                row.activeCleanupObjectCount !== 0 ||
                row.matchingTombstoneCount !== 1 ||
                row.runTombstoneCount !== 1 ||
                !exactRetryHistory(row, facts)
            ) {
                throw rehearsalError('recovery-d-prior-proof-invalid');
            }
            continue;
        }

        if (recoveryPhase === 'd-deleting') {
            if (
                row.cleanupEvidenceHash !== null ||
                row.cleanupCompletedAt !== null ||
                row.outputRowCount !== 1 ||
                row.multipartRowCount !== 1 ||
                row.cleanupObjectCount !== 1 ||
                row.absentCleanupObjectCount !== 0 ||
                row.activeCleanupObjectCount !== 1 ||
                row.matchingTombstoneCount !== 0 ||
                row.runTombstoneCount !== 0 ||
                !emptyRetryHistory(row)
            ) {
                throw rehearsalError('recovery-d-deleting-invalid');
            }
        } else {
            if (
                !cleanedScenarioDHistory(row) ||
                (recoveryPhase === 'd-cleaned-before-retry'
                    ? !emptyRetryHistory(row)
                    : !exactRetryHistory(row, facts))
            ) {
                throw rehearsalError('recovery-d-terminal-history-invalid');
            }
        }
    }

    return Object.freeze({
        recoveryPhase,
        rows: Object.freeze(Object.fromEntries(
            scenarioDRecoveryPlan.map(({ key }) => [key, Object.freeze(byScenario.get(key))])
        ))
    });
}

function cleanedScenarioDHistory(row) {
    return row.cleanupStatus === 'cleaned' &&
        sha256Pattern.test(row.cleanupEvidenceHash || '') &&
        nonEmptyString(row.cleanupCompletedAt) &&
        row.cleanupUpdatedAt === row.cleanupCompletedAt &&
        row.outputRowCount === 0 &&
        row.multipartRowCount === 0 &&
        row.cleanupObjectCount === 1 &&
        row.absentCleanupObjectCount === 1 &&
        row.activeCleanupObjectCount === 0 &&
        row.matchingTombstoneCount === 1 &&
        row.runTombstoneCount === 1;
}

function emptyRetryHistory(row) {
    const fields = [
        'retryReceiptIdempotencyKey',
        'retryReceiptPayloadFingerprint',
        'retryReceiptFromState',
        'retryReceiptToState',
        'retryReceiptExpectedStateVersion',
        'retryReceiptResultStateVersion',
        'retryReceiptCreatedAt'
    ];
    return row.retryReceiptCount === 0 &&
        row.retryStateVersionReceiptCount === 0 &&
        row.retryAuditCount === 0 &&
        fields.every(key => row[key] === null);
}

function exactRetryHistory(row, facts) {
    return row.retryReceiptCount === 1 &&
        row.retryStateVersionReceiptCount === 1 &&
        row.retryReceiptIdempotencyKey === facts.retryIdempotencyKey &&
        row.retryReceiptPayloadFingerprint === facts.retryPayloadFingerprint &&
        row.retryReceiptFromState === 'processing-failed' &&
        row.retryReceiptToState === 'approved-for-processing' &&
        row.retryReceiptExpectedStateVersion === facts.failedStateVersion &&
        row.retryReceiptResultStateVersion === facts.approvedStateVersion &&
        nonEmptyString(row.retryReceiptCreatedAt) &&
        row.retryAuditCount === 1;
}

function scenarioDHistorySql(draftId) {
    const draftLiteral = exactSqlLiteral(draftId, draftIdPattern, 'draft ID');
    const auditSubjectLiteral = exactSqlLiteral(
        sha256Text(`draft:${draftId}`),
        sha256Pattern,
        'audit subject hash'
    );
    return `
        WITH expected(scenario, ordinal, start_key, retry_key) AS (
            VALUES
                ('a', 1, 'phase-d-remote-a-start-0001', 'phase-d-remote-a-retry-0001'),
                ('b', 2, 'phase-d-remote-b-start-0001', 'phase-d-remote-b-retry-0001'),
                ('c', 3, 'phase-d-remote-c-start-0001', 'phase-d-remote-c-retry-0001'),
                ('d', 4, 'phase-d-remote-d-start-0001', 'phase-d-remote-d-retry-0001')
        )
        SELECT
            expected.scenario,
            draft.draft_id AS draftId,
            run.processing_run_id AS processingRunId,
            draft.state AS draftState,
            draft.state_version AS draftStateVersion,
            draft.processing_diagnostics_json AS processingDiagnosticsJson,
            draft.updated_at AS draftUpdatedAt,
            CASE WHEN
                draft.export_bundle_id = '${catalogSnapshot.exportBundleId}' AND
                draft.source_revision = '${catalogSnapshot.sourceRevision}' AND
                draft.suppression_revision = '${catalogSnapshot.suppressionRevision}' AND
                draft.media_type = 'photo' AND
                draft.upload_complete = 1 AND
                run.site_mode = json_extract(draft.site_modes_json, '$[0]') AND
                run.media_type = draft.media_type AND
                run.item_revision = draft.item_revision AND
                run.consent_revision = draft.active_consent_revision AND
                run.export_bundle_id = draft.export_bundle_id AND
                run.source_revision = draft.source_revision AND
                run.suppression_revision = draft.suppression_revision AND
                run.original_object_key = draft.original_object_key AND
                run.original_detected_type = draft.original_detected_type AND
                run.original_declared_content_type = upload.declared_content_type AND
                run.original_byte_count = draft.original_byte_count AND
                run.original_sha256 = draft.original_sha256 AND
                consent.public_use_confirmed = 1 AND
                (consent.contains_minors = 0 OR
                    consent.guardian_approval_confirmed = 1) AND
                consent.withdrawn_at IS NULL AND
                upload.status = 'complete' AND
                upload.synthetic_only_confirmed = 1 AND
                upload.item_revision = run.item_revision AND
                upload.consent_revision = run.consent_revision AND
                upload.export_bundle_id = run.export_bundle_id AND
                upload.source_revision = run.source_revision AND
                upload.suppression_revision = run.suppression_revision AND
                upload.object_key = run.original_object_key AND
                upload.detected_format = run.original_detected_type AND
                upload.declared_byte_count = run.original_byte_count AND
                upload.completed_object_version = run.original_object_version AND
                upload.completed_etag = run.original_etag AND
                upload.completed_sha256 = run.original_sha256
                THEN 1 ELSE 0 END AS runEvidenceMatch,
            (SELECT COUNT(*)
                FROM json_each(draft.athlete_ids_json) AS tag
                JOIN pending_athlete_exclusions AS exclusion
                  ON exclusion.athlete_id = tag.value
                WHERE exclusion.resolved_at IS NULL) AS pendingTaggedExclusionCount,
            (SELECT COUNT(*) FROM draft_processing_runs AS prior
                WHERE prior.draft_id = draft.draft_id) AS priorRunCount,
            run.start_expected_state_version AS startExpectedStateVersion,
            run.processing_state_version AS processingStateVersion,
            run.start_idempotency_key AS startIdempotencyKey,
            run.start_payload_fingerprint AS startPayloadFingerprint,
            run.service_actor_identity_hash AS runActorIdentityHash,
            run.status AS runStatus,
            run.result_idempotency_key AS resultIdempotencyKey,
            run.result_payload_fingerprint AS resultPayloadFingerprint,
            run.result_transition_key AS resultTransitionKey,
            run.failure_code AS failureCode,
            run.created_at AS runCreatedAt,
            run.updated_at AS runUpdatedAt,
            run.completed_at AS runCompletedAt,
            cleanup.cleanup_id AS cleanupId,
            cleanup.cleanup_id_hash AS cleanupIdHash,
            cleanup.processing_run_id_hash AS cleanupProcessingRunIdHash,
            cleanup.draft_id_hash AS cleanupDraftIdHash,
            cleanup.cleanup_reason AS cleanupReason,
            cleanup.expected_state_version AS cleanupExpectedStateVersion,
            cleanup.output_count AS cleanupOutputCount,
            cleanup.idempotency_key AS cleanupIdempotencyKey,
            cleanup.payload_fingerprint AS cleanupPayloadFingerprint,
            cleanup.service_actor_identity_hash AS cleanupActorIdentityHash,
            cleanup.status AS cleanupStatus,
            cleanup.cleanup_evidence_hash AS cleanupEvidenceHash,
            cleanup.created_at AS cleanupCreatedAt,
            cleanup.updated_at AS cleanupUpdatedAt,
            cleanup.completed_at AS cleanupCompletedAt,
            (SELECT COUNT(*) FROM draft_processing_outputs AS output
                WHERE output.processing_run_id = run.processing_run_id) AS outputRowCount,
            (SELECT COUNT(*) FROM draft_processing_multipart_uploads AS multipart
                WHERE multipart.processing_run_id = run.processing_run_id) AS multipartRowCount,
            (SELECT COUNT(*) FROM draft_derivatives AS derivative
                WHERE derivative.draft_id = draft.draft_id) AS derivativeRowCount,
            (SELECT COUNT(*) FROM draft_processing_cleanups AS current_cleanup
                WHERE current_cleanup.processing_run_id = run.processing_run_id) AS cleanupCount,
            (SELECT COUNT(*) FROM draft_processing_cleanup_objects AS object
                WHERE object.cleanup_id = cleanup.cleanup_id) AS cleanupObjectCount,
            (SELECT COUNT(*) FROM draft_processing_cleanup_objects AS object
                WHERE object.cleanup_id = cleanup.cleanup_id
                  AND object.status = 'absent'
                  AND object.staging_object_key IS NULL
                  AND object.provider_terminal_kind IS NOT NULL
                  AND object.absence_verified_at IS NOT NULL
            ) AS absentCleanupObjectCount,
            (SELECT COUNT(*) FROM draft_processing_cleanup_objects AS object
                WHERE object.cleanup_id = cleanup.cleanup_id
                  AND (object.status <> 'absent' OR
                    object.staging_object_key IS NOT NULL OR
                    object.provider_terminal_kind IS NULL OR
                    object.absence_verified_at IS NULL)) AS activeCleanupObjectCount,
            (SELECT COUNT(*) FROM gallery_processing_cleanup_tombstones AS tombstone
                WHERE tombstone.cleanup_id_hash = cleanup.cleanup_id_hash
                  AND tombstone.draft_id_hash = cleanup.draft_id_hash
                  AND tombstone.processing_run_id_hash = cleanup.processing_run_id_hash
                  AND tombstone.cleanup_reason = cleanup.cleanup_reason
                  AND tombstone.evidence_hash = cleanup.cleanup_evidence_hash
                  AND tombstone.completed_at = cleanup.completed_at
            ) AS matchingTombstoneCount,
            (SELECT COUNT(*) FROM gallery_processing_cleanup_tombstones AS tombstone
                WHERE tombstone.processing_run_id_hash =
                    cleanup.processing_run_id_hash) AS runTombstoneCount,
            (SELECT COUNT(*) FROM draft_transition_receipts AS receipt
                WHERE receipt.draft_id = draft.draft_id
                  AND receipt.idempotency_key = run.start_idempotency_key
                  AND receipt.payload_fingerprint = run.start_payload_fingerprint
                  AND receipt.from_state = 'approved-for-processing'
                  AND receipt.to_state = 'processing'
                  AND receipt.expected_state_version = run.start_expected_state_version
                  AND receipt.result_state_version = run.processing_state_version
                  AND receipt.created_at = run.created_at) AS startReceiptCount,
            (SELECT COUNT(*) FROM draft_transition_receipts AS receipt
                WHERE receipt.draft_id = draft.draft_id
                  AND receipt.idempotency_key = run.result_transition_key
                  AND receipt.payload_fingerprint = run.result_payload_fingerprint
                  AND receipt.from_state = 'processing'
                  AND receipt.to_state = 'processing-failed'
                  AND receipt.expected_state_version = run.processing_state_version
                  AND receipt.result_state_version = run.processing_state_version + 1
                  AND receipt.created_at = run.completed_at) AS failureReceiptCount,
            (SELECT COUNT(*) FROM gallery_audit_events AS audit
                WHERE audit.subject_reference_hash = ${auditSubjectLiteral}
                  AND audit.event_type = 'processing-started'
                  AND audit.payload_hash = run.start_payload_fingerprint
                  AND audit.state_version = run.processing_state_version
                  AND audit.occurred_at = run.created_at) AS startAuditCount,
            (SELECT COUNT(*) FROM gallery_audit_events AS audit
                WHERE audit.subject_reference_hash = ${auditSubjectLiteral}
                  AND audit.event_type = 'processing-failed'
                  AND audit.payload_hash = run.result_payload_fingerprint
                  AND audit.state_version = run.processing_state_version + 1
                  AND audit.occurred_at = run.completed_at) AS failureAuditCount,
            (SELECT COUNT(*) FROM draft_transition_receipts AS exact_retry
                WHERE exact_retry.draft_id = draft.draft_id
                  AND exact_retry.idempotency_key = expected.retry_key) AS retryReceiptCount,
            (SELECT COUNT(*) FROM draft_transition_receipts AS version_retry
                WHERE version_retry.draft_id = draft.draft_id
                  AND version_retry.expected_state_version =
                    run.processing_state_version + 1) AS retryStateVersionReceiptCount,
            retry.idempotency_key AS retryReceiptIdempotencyKey,
            retry.payload_fingerprint AS retryReceiptPayloadFingerprint,
            retry.from_state AS retryReceiptFromState,
            retry.to_state AS retryReceiptToState,
            retry.expected_state_version AS retryReceiptExpectedStateVersion,
            retry.result_state_version AS retryReceiptResultStateVersion,
            retry.created_at AS retryReceiptCreatedAt,
            (SELECT COUNT(*) FROM gallery_audit_events AS audit
                WHERE audit.subject_reference_hash = ${auditSubjectLiteral}
                  AND audit.event_type = 'processing-retry-approved'
                  AND audit.payload_hash = retry.payload_fingerprint
                  AND audit.state_version = retry.result_state_version
                  AND audit.occurred_at = retry.created_at) AS retryAuditCount,
            (SELECT COUNT(*) FROM gallery_audit_events AS audit
                WHERE audit.subject_reference_hash = ${auditSubjectLiteral}
                  AND audit.event_type = 'processing-retry-approved'
            ) AS retrySubjectAuditCount
        FROM expected
        JOIN gallery_drafts AS draft ON draft.draft_id = ${draftLiteral}
        LEFT JOIN draft_processing_runs AS run
          ON run.draft_id = draft.draft_id
         AND run.start_idempotency_key = expected.start_key
        LEFT JOIN draft_consent_attestations AS consent
          ON consent.draft_id = run.draft_id
         AND consent.consent_revision = run.consent_revision
        LEFT JOIN draft_upload_sessions AS upload
          ON upload.upload_session_id = run.upload_session_id
         AND upload.draft_id = run.draft_id
        LEFT JOIN draft_processing_cleanups AS cleanup
          ON cleanup.processing_run_id = run.processing_run_id
        LEFT JOIN draft_transition_receipts AS retry
          ON retry.draft_id = draft.draft_id
         AND retry.idempotency_key = expected.retry_key
        ORDER BY expected.ordinal;
    `;
}

const scenarioDObjectKeys = Object.freeze([
    'draftId',
    'processingRunId',
    'cleanupId',
    'cleanupStatus',
    'cleanupExpectedStateVersion',
    'cleanupIdempotencyKey',
    'cleanupPayloadFingerprint',
    'outputCount',
    'outputRole',
    'outputIdempotencyKey',
    'outputPayloadFingerprint',
    'outputStagingObjectKey',
    'outputSha256',
    'outputByteCount',
    'outputContentType',
    'outputWidth',
    'outputHeight',
    'outputStatus',
    'outputObjectVersion',
    'outputEtag',
    'outputStoredAt',
    'outputVerifiedAt',
    'outputCreatedAt',
    'multipartCount',
    'multipartRole',
    'multipartStagingObjectKey',
    'multipartPayloadFingerprint',
    'providerUploadId',
    'providerUploadIdHash',
    'multipartStatus',
    'providerPartEtag',
    'multipartTerminalKind',
    'multipartCreatedAt',
    'multipartUpdatedAt',
    'multipartPartUploadedAt',
    'multipartTerminalAt',
    'cleanupObjectCount',
    'cleanupObjectRole',
    'cleanupObjectStagingKey',
    'cleanupObjectStagingKeyHash',
    'cleanupObjectExpectedSha256',
    'cleanupObjectExpectedByteCount',
    'cleanupObjectExpectedVersionHash',
    'cleanupObjectExpectedEtagHash',
    'cleanupObjectProviderTerminalKind',
    'cleanupObjectObservedVersionHash',
    'cleanupObjectObservedEtagHash',
    'cleanupObjectStatus',
    'cleanupObjectDeletedAt',
    'cleanupObjectAbsenceVerifiedAt'
]);

async function readScenarioDObjectSnapshot(d1, fixture) {
    const rows = await d1.rows(
        'recovery-d-object',
        scenarioDObjectSql(fixture.draftId)
    );
    if (
        rows.length !== 1 ||
        !hasExactKeys(rows[0], scenarioDObjectKeys)
    ) {
        throw rehearsalError('recovery-d-object-unavailable');
    }
    return rows[0];
}

function assertScenarioDObjectSnapshot(snapshot, fixture, dHistory) {
    const facts = scenarioDRecoveryFacts(
        fixture.draftId,
        fixture.scenarioDProcessingRunId,
        'd'
    );
    const parsedKey = parseV1StagingDerivativeKey(snapshot.outputStagingObjectKey);
    const outputPayloadFingerprint = sha256Text(JSON.stringify({
        operation: 'processing-output-upload',
        processingRunId: fixture.scenarioDProcessingRunId,
        role: 'photo-display',
        contentType: 'image/webp',
        byteLength: snapshot.outputByteCount,
        sha256: snapshot.outputSha256,
        width: snapshot.outputWidth,
        height: snapshot.outputHeight,
        idempotencyKey: scenarioDDisplayIdempotencyKey
    }));
    if (
        !isPlainObject(snapshot) ||
        !hasExactKeys(snapshot, scenarioDObjectKeys) ||
        snapshot.draftId !== fixture.draftId ||
        snapshot.processingRunId !== fixture.scenarioDProcessingRunId ||
        snapshot.cleanupId !== dHistory.cleanupId ||
        snapshot.cleanupStatus !== 'deleting' ||
        snapshot.cleanupExpectedStateVersion !== scenarioDFailedStateVersion ||
        snapshot.cleanupIdempotencyKey !== facts.cleanupIdempotencyKey ||
        snapshot.cleanupPayloadFingerprint !== facts.cleanupPayloadFingerprint ||
        snapshot.outputCount !== 1 ||
        snapshot.outputRole !== 'photo-display' ||
        snapshot.outputIdempotencyKey !== scenarioDDisplayIdempotencyKey ||
        snapshot.outputPayloadFingerprint !== outputPayloadFingerprint ||
        !sha256Pattern.test(snapshot.outputSha256 || '') ||
        !Number.isSafeInteger(snapshot.outputByteCount) ||
        snapshot.outputByteCount < 1 ||
        snapshot.outputByteCount > 26_214_400 ||
        snapshot.outputContentType !== 'image/webp' ||
        !Number.isSafeInteger(snapshot.outputWidth) ||
        !Number.isSafeInteger(snapshot.outputHeight) ||
        snapshot.outputWidth < 1 ||
        snapshot.outputHeight < 1 ||
        Math.max(snapshot.outputWidth, snapshot.outputHeight) > 1600 ||
        snapshot.outputStatus !== 'reserved' ||
        snapshot.outputObjectVersion !== null ||
        snapshot.outputEtag !== null ||
        snapshot.outputStoredAt !== null ||
        snapshot.outputVerifiedAt !== null ||
        !nonEmptyString(snapshot.outputCreatedAt) ||
        parsedKey?.site !== 'family' ||
        parsedKey?.draftId !== fixture.draftId ||
        parsedKey?.processingRunId !== fixture.scenarioDProcessingRunId ||
        parsedKey?.sha256 !== snapshot.outputSha256 ||
        parsedKey?.role !== 'photo-display' ||
        snapshot.multipartCount !== 1 ||
        snapshot.multipartRole !== snapshot.outputRole ||
        snapshot.multipartStagingObjectKey !== snapshot.outputStagingObjectKey ||
        snapshot.multipartPayloadFingerprint !== snapshot.outputPayloadFingerprint ||
        !nonEmptyString(snapshot.providerUploadId) ||
        snapshot.providerUploadId.length > 512 ||
        snapshot.providerUploadIdHash !== sha256Text(
            `multipart-upload-id:${snapshot.providerUploadId}`
        ) ||
        snapshot.multipartStatus !== 'terminal' ||
        !nonEmptyString(snapshot.providerPartEtag) ||
        snapshot.multipartTerminalKind !== 'aborted' ||
        !nonEmptyString(snapshot.multipartCreatedAt) ||
        !nonEmptyString(snapshot.multipartUpdatedAt) ||
        !nonEmptyString(snapshot.multipartPartUploadedAt) ||
        snapshot.multipartTerminalAt !== snapshot.multipartUpdatedAt ||
        snapshot.cleanupObjectCount !== 1 ||
        snapshot.cleanupObjectRole !== snapshot.outputRole ||
        snapshot.cleanupObjectStagingKey !== snapshot.outputStagingObjectKey ||
        snapshot.cleanupObjectStagingKeyHash !== sha256Text(
            `staging-key:${snapshot.outputStagingObjectKey}`
        ) ||
        snapshot.cleanupObjectExpectedSha256 !== snapshot.outputSha256 ||
        snapshot.cleanupObjectExpectedByteCount !== snapshot.outputByteCount ||
        snapshot.cleanupObjectExpectedVersionHash !== null ||
        snapshot.cleanupObjectExpectedEtagHash !== null ||
        snapshot.cleanupObjectProviderTerminalKind !== null ||
        snapshot.cleanupObjectObservedVersionHash !== null ||
        snapshot.cleanupObjectObservedEtagHash !== null ||
        snapshot.cleanupObjectStatus !== 'pending' ||
        snapshot.cleanupObjectDeletedAt !== null ||
        snapshot.cleanupObjectAbsenceVerifiedAt !== null
    ) {
        throw rehearsalError('recovery-d-object-invalid');
    }
    return Object.freeze({ ...snapshot });
}

function scenarioDObjectSql(draftId) {
    const draftLiteral = exactSqlLiteral(draftId, draftIdPattern, 'draft ID');
    return `
        SELECT
            draft.draft_id AS draftId,
            run.processing_run_id AS processingRunId,
            cleanup.cleanup_id AS cleanupId,
            cleanup.status AS cleanupStatus,
            cleanup.expected_state_version AS cleanupExpectedStateVersion,
            cleanup.idempotency_key AS cleanupIdempotencyKey,
            cleanup.payload_fingerprint AS cleanupPayloadFingerprint,
            (SELECT COUNT(*) FROM draft_processing_outputs AS exact_output
                WHERE exact_output.processing_run_id = run.processing_run_id
            ) AS outputCount,
            output.role AS outputRole,
            output.upload_idempotency_key AS outputIdempotencyKey,
            output.upload_payload_fingerprint AS outputPayloadFingerprint,
            output.staging_object_key AS outputStagingObjectKey,
            output.sha256 AS outputSha256,
            output.byte_count AS outputByteCount,
            output.content_type AS outputContentType,
            output.width AS outputWidth,
            output.height AS outputHeight,
            output.status AS outputStatus,
            output.staging_object_version AS outputObjectVersion,
            output.staging_etag AS outputEtag,
            output.stored_at AS outputStoredAt,
            output.verified_at AS outputVerifiedAt,
            output.created_at AS outputCreatedAt,
            (SELECT COUNT(*) FROM draft_processing_multipart_uploads AS exact_multipart
                WHERE exact_multipart.processing_run_id = run.processing_run_id
            ) AS multipartCount,
            multipart.role AS multipartRole,
            multipart.staging_object_key AS multipartStagingObjectKey,
            multipart.upload_payload_fingerprint AS multipartPayloadFingerprint,
            multipart.provider_upload_id AS providerUploadId,
            multipart.provider_upload_id_hash AS providerUploadIdHash,
            multipart.status AS multipartStatus,
            multipart.provider_part_etag AS providerPartEtag,
            multipart.terminal_kind AS multipartTerminalKind,
            multipart.created_at AS multipartCreatedAt,
            multipart.updated_at AS multipartUpdatedAt,
            multipart.part_uploaded_at AS multipartPartUploadedAt,
            multipart.terminal_at AS multipartTerminalAt,
            (SELECT COUNT(*) FROM draft_processing_cleanup_objects AS exact_object
                WHERE exact_object.cleanup_id = cleanup.cleanup_id
            ) AS cleanupObjectCount,
            object.role AS cleanupObjectRole,
            object.staging_object_key AS cleanupObjectStagingKey,
            object.staging_object_key_hash AS cleanupObjectStagingKeyHash,
            object.expected_sha256 AS cleanupObjectExpectedSha256,
            object.expected_byte_count AS cleanupObjectExpectedByteCount,
            object.expected_object_version_hash AS cleanupObjectExpectedVersionHash,
            object.expected_etag_hash AS cleanupObjectExpectedEtagHash,
            object.provider_terminal_kind AS cleanupObjectProviderTerminalKind,
            object.observed_object_version_hash AS cleanupObjectObservedVersionHash,
            object.observed_etag_hash AS cleanupObjectObservedEtagHash,
            object.status AS cleanupObjectStatus,
            object.deleted_at AS cleanupObjectDeletedAt,
            object.absence_verified_at AS cleanupObjectAbsenceVerifiedAt
        FROM gallery_drafts AS draft
        JOIN draft_processing_runs AS run
          ON run.draft_id = draft.draft_id
         AND run.start_idempotency_key = 'phase-d-remote-d-start-0001'
        JOIN draft_processing_cleanups AS cleanup
          ON cleanup.processing_run_id = run.processing_run_id
        JOIN draft_processing_outputs AS output
          ON output.processing_run_id = run.processing_run_id
         AND output.role = 'photo-display'
        JOIN draft_processing_multipart_uploads AS multipart
          ON multipart.processing_run_id = output.processing_run_id
         AND multipart.role = output.role
        JOIN draft_processing_cleanup_objects AS object
          ON object.cleanup_id = cleanup.cleanup_id
         AND object.role = output.role
        WHERE draft.draft_id = ${draftLiteral};
    `;
}

async function reconcileScenarioDStagingObject(dependencies, fixture, snapshot) {
    const bytes = await dependencies.wranglerRunner(internalWranglerRequest({
        kind: 'staging-get-recovery-object',
        configPath: adminConfigPath,
        bucketName: stagingBucketName,
        key: snapshot.outputStagingObjectKey,
        draftId: fixture.draftId,
        processingRunId: fixture.scenarioDProcessingRunId,
        sha256: snapshot.outputSha256,
        byteLength: snapshot.outputByteCount
    }));
    if (
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength !== snapshot.outputByteCount ||
        sha256(bytes) !== snapshot.outputSha256
    ) {
        throw rehearsalError('recovery-d-staging-object-mismatch');
    }
}

const scenarioDTerminalKeys = Object.freeze([
    'draftId',
    'processingRunId',
    'draftState',
    'draftStateVersion',
    'processingDiagnosticsJson',
    'draftUpdatedAt',
    'cleanupId',
    'cleanupIdHash',
    'cleanupProcessingRunIdHash',
    'cleanupDraftIdHash',
    'cleanupReason',
    'cleanupExpectedStateVersion',
    'cleanupOutputCount',
    'cleanupIdempotencyKey',
    'cleanupPayloadFingerprint',
    'cleanupActorIdentityHash',
    'cleanupStatus',
    'cleanupEvidenceHash',
    'cleanupCreatedAt',
    'cleanupUpdatedAt',
    'cleanupCompletedAt',
    'cleanupObjectCount',
    'cleanupObjectRole',
    'cleanupObjectStagingKey',
    'cleanupObjectStagingKeyHash',
    'cleanupObjectExpectedSha256',
    'cleanupObjectExpectedByteCount',
    'cleanupObjectExpectedVersionHash',
    'cleanupObjectExpectedEtagHash',
    'cleanupObjectProviderTerminalKind',
    'cleanupObjectObservedVersionHash',
    'cleanupObjectObservedEtagHash',
    'cleanupObjectStatus',
    'cleanupObjectDeletedAt',
    'cleanupObjectAbsenceVerifiedAt',
    'outputRowCount',
    'multipartRowCount',
    'derivativeRowCount',
    'activeCleanupObjectCount',
    'matchingTombstoneCount',
    'runTombstoneCount',
    'retryReceiptCount',
    'retryStateVersionReceiptCount',
    'retryReceiptIdempotencyKey',
    'retryReceiptPayloadFingerprint',
    'retryReceiptFromState',
    'retryReceiptToState',
    'retryReceiptExpectedStateVersion',
    'retryReceiptResultStateVersion',
    'retryReceiptCreatedAt',
    'retryAuditCount',
    'retrySubjectAuditCount'
]);

async function readScenarioDTerminalSnapshot(d1, fixture, label) {
    const rows = await d1.rows(label, scenarioDTerminalSql(fixture.draftId));
    if (
        rows.length !== 1 ||
        !hasExactKeys(rows[0], scenarioDTerminalKeys)
    ) {
        throw rehearsalError('recovery-d-terminal-unavailable');
    }
    return rows[0];
}

function assertScenarioDTerminalSnapshot(
    snapshot,
    fixture,
    dHistory,
    phase,
    objectSnapshot = null
) {
    if (!['before-retry', 'after-retry'].includes(phase)) {
        throw rehearsalError('recovery-d-terminal-phase-invalid');
    }
    const facts = scenarioDRecoveryFacts(
        fixture.draftId,
        fixture.scenarioDProcessingRunId,
        'd'
    );
    const afterRetry = phase === 'after-retry';
    if (
        !isPlainObject(snapshot) ||
        !hasExactKeys(snapshot, scenarioDTerminalKeys) ||
        snapshot.draftId !== fixture.draftId ||
        snapshot.processingRunId !== fixture.scenarioDProcessingRunId ||
        snapshot.draftState !== (afterRetry
            ? 'approved-for-processing'
            : 'processing-failed') ||
        snapshot.draftStateVersion !== (afterRetry
            ? scenarioDApprovedStateVersion
            : scenarioDFailedStateVersion) ||
        snapshot.processingDiagnosticsJson !== (afterRetry
            ? null
            : scenarioADiagnosticsJson) ||
        !nonEmptyString(snapshot.draftUpdatedAt) ||
        snapshot.cleanupId !== dHistory.cleanupId ||
        snapshot.cleanupIdHash !== dHistory.cleanupIdHash ||
        snapshot.cleanupProcessingRunIdHash !== facts.processingRunIdHash ||
        snapshot.cleanupDraftIdHash !== facts.draftIdHash ||
        snapshot.cleanupReason !== 'processing-failed' ||
        snapshot.cleanupExpectedStateVersion !== scenarioDFailedStateVersion ||
        snapshot.cleanupOutputCount !== 1 ||
        snapshot.cleanupIdempotencyKey !== facts.cleanupIdempotencyKey ||
        snapshot.cleanupPayloadFingerprint !== facts.cleanupPayloadFingerprint ||
        snapshot.cleanupActorIdentityHash !== dHistory.cleanupActorIdentityHash ||
        snapshot.cleanupStatus !== 'cleaned' ||
        !sha256Pattern.test(snapshot.cleanupEvidenceHash || '') ||
        snapshot.cleanupCreatedAt !== dHistory.cleanupCreatedAt ||
        !nonEmptyString(snapshot.cleanupUpdatedAt) ||
        snapshot.cleanupUpdatedAt !== snapshot.cleanupCompletedAt ||
        snapshot.cleanupObjectCount !== 1 ||
        snapshot.cleanupObjectRole !== 'photo-display' ||
        snapshot.cleanupObjectStagingKey !== null ||
        !sha256Pattern.test(snapshot.cleanupObjectStagingKeyHash || '') ||
        !sha256Pattern.test(snapshot.cleanupObjectExpectedSha256 || '') ||
        !Number.isSafeInteger(snapshot.cleanupObjectExpectedByteCount) ||
        snapshot.cleanupObjectExpectedByteCount < 1 ||
        snapshot.cleanupObjectExpectedByteCount > 26_214_400 ||
        snapshot.cleanupObjectExpectedVersionHash !== null ||
        snapshot.cleanupObjectExpectedEtagHash !== null ||
        snapshot.cleanupObjectProviderTerminalKind !== 'aborted' ||
        snapshot.cleanupObjectObservedVersionHash !== null ||
        snapshot.cleanupObjectObservedEtagHash !== null ||
        snapshot.cleanupObjectStatus !== 'absent' ||
        snapshot.cleanupObjectDeletedAt !== null ||
        !nonEmptyString(snapshot.cleanupObjectAbsenceVerifiedAt) ||
        snapshot.outputRowCount !== 0 ||
        snapshot.multipartRowCount !== 0 ||
        snapshot.derivativeRowCount !== 0 ||
        snapshot.activeCleanupObjectCount !== 0 ||
        snapshot.matchingTombstoneCount !== 1 ||
        snapshot.runTombstoneCount !== 1 ||
        snapshot.retrySubjectAuditCount !== (afterRetry ? 4 : 3) ||
        (afterRetry
            ? !exactRetryHistory(snapshot, facts)
            : !emptyRetryHistory(snapshot))
    ) {
        throw rehearsalError('recovery-d-terminal-invalid');
    }
    if (
        objectSnapshot && (
            snapshot.cleanupObjectStagingKeyHash !==
                objectSnapshot.cleanupObjectStagingKeyHash ||
            snapshot.cleanupObjectExpectedSha256 !== objectSnapshot.outputSha256 ||
            snapshot.cleanupObjectExpectedByteCount !== objectSnapshot.outputByteCount
        )
    ) {
        throw rehearsalError('recovery-d-terminal-object-mismatch');
    }
    return Object.freeze(Object.fromEntries(
        scenarioDTerminalKeys.map(key => [key, snapshot[key]])
    ));
}

function scenarioDTerminalSql(draftId) {
    const draftLiteral = exactSqlLiteral(draftId, draftIdPattern, 'draft ID');
    const auditSubjectLiteral = exactSqlLiteral(
        sha256Text(`draft:${draftId}`),
        sha256Pattern,
        'audit subject hash'
    );
    return `
        SELECT
            draft.draft_id AS draftId,
            run.processing_run_id AS processingRunId,
            draft.state AS draftState,
            draft.state_version AS draftStateVersion,
            draft.processing_diagnostics_json AS processingDiagnosticsJson,
            draft.updated_at AS draftUpdatedAt,
            cleanup.cleanup_id AS cleanupId,
            cleanup.cleanup_id_hash AS cleanupIdHash,
            cleanup.processing_run_id_hash AS cleanupProcessingRunIdHash,
            cleanup.draft_id_hash AS cleanupDraftIdHash,
            cleanup.cleanup_reason AS cleanupReason,
            cleanup.expected_state_version AS cleanupExpectedStateVersion,
            cleanup.output_count AS cleanupOutputCount,
            cleanup.idempotency_key AS cleanupIdempotencyKey,
            cleanup.payload_fingerprint AS cleanupPayloadFingerprint,
            cleanup.service_actor_identity_hash AS cleanupActorIdentityHash,
            cleanup.status AS cleanupStatus,
            cleanup.cleanup_evidence_hash AS cleanupEvidenceHash,
            cleanup.created_at AS cleanupCreatedAt,
            cleanup.updated_at AS cleanupUpdatedAt,
            cleanup.completed_at AS cleanupCompletedAt,
            (SELECT COUNT(*) FROM draft_processing_cleanup_objects AS exact_object
                WHERE exact_object.cleanup_id = cleanup.cleanup_id
            ) AS cleanupObjectCount,
            object.role AS cleanupObjectRole,
            object.staging_object_key AS cleanupObjectStagingKey,
            object.staging_object_key_hash AS cleanupObjectStagingKeyHash,
            object.expected_sha256 AS cleanupObjectExpectedSha256,
            object.expected_byte_count AS cleanupObjectExpectedByteCount,
            object.expected_object_version_hash AS cleanupObjectExpectedVersionHash,
            object.expected_etag_hash AS cleanupObjectExpectedEtagHash,
            object.provider_terminal_kind AS cleanupObjectProviderTerminalKind,
            object.observed_object_version_hash AS cleanupObjectObservedVersionHash,
            object.observed_etag_hash AS cleanupObjectObservedEtagHash,
            object.status AS cleanupObjectStatus,
            object.deleted_at AS cleanupObjectDeletedAt,
            object.absence_verified_at AS cleanupObjectAbsenceVerifiedAt,
            (SELECT COUNT(*) FROM draft_processing_outputs AS output
                WHERE output.processing_run_id = run.processing_run_id) AS outputRowCount,
            (SELECT COUNT(*) FROM draft_processing_multipart_uploads AS multipart
                WHERE multipart.processing_run_id = run.processing_run_id) AS multipartRowCount,
            (SELECT COUNT(*) FROM draft_derivatives AS derivative
                WHERE derivative.draft_id = draft.draft_id) AS derivativeRowCount,
            (SELECT COUNT(*) FROM draft_processing_cleanup_objects AS active_object
                WHERE active_object.cleanup_id = cleanup.cleanup_id
                  AND (active_object.status <> 'absent' OR
                    active_object.staging_object_key IS NOT NULL OR
                    active_object.provider_terminal_kind IS NULL OR
                    active_object.absence_verified_at IS NULL)
            ) AS activeCleanupObjectCount,
            (SELECT COUNT(*) FROM gallery_processing_cleanup_tombstones AS tombstone
                WHERE tombstone.cleanup_id_hash = cleanup.cleanup_id_hash
                  AND tombstone.draft_id_hash = cleanup.draft_id_hash
                  AND tombstone.processing_run_id_hash = cleanup.processing_run_id_hash
                  AND tombstone.cleanup_reason = cleanup.cleanup_reason
                  AND tombstone.evidence_hash = cleanup.cleanup_evidence_hash
                  AND tombstone.completed_at = cleanup.completed_at
            ) AS matchingTombstoneCount,
            (SELECT COUNT(*) FROM gallery_processing_cleanup_tombstones AS tombstone
                WHERE tombstone.processing_run_id_hash =
                    cleanup.processing_run_id_hash) AS runTombstoneCount,
            (SELECT COUNT(*) FROM draft_transition_receipts AS exact_retry
                WHERE exact_retry.draft_id = draft.draft_id
                  AND exact_retry.idempotency_key =
                    'phase-d-remote-d-retry-0001') AS retryReceiptCount,
            (SELECT COUNT(*) FROM draft_transition_receipts AS version_retry
                WHERE version_retry.draft_id = draft.draft_id
                  AND version_retry.expected_state_version =
                    ${scenarioDFailedStateVersion}) AS retryStateVersionReceiptCount,
            retry.idempotency_key AS retryReceiptIdempotencyKey,
            retry.payload_fingerprint AS retryReceiptPayloadFingerprint,
            retry.from_state AS retryReceiptFromState,
            retry.to_state AS retryReceiptToState,
            retry.expected_state_version AS retryReceiptExpectedStateVersion,
            retry.result_state_version AS retryReceiptResultStateVersion,
            retry.created_at AS retryReceiptCreatedAt,
            (SELECT COUNT(*) FROM gallery_audit_events AS audit
                WHERE audit.subject_reference_hash = ${auditSubjectLiteral}
                  AND audit.event_type = 'processing-retry-approved'
                  AND audit.payload_hash = retry.payload_fingerprint
                  AND audit.state_version = retry.result_state_version
                  AND audit.occurred_at = retry.created_at) AS retryAuditCount,
            (SELECT COUNT(*) FROM gallery_audit_events AS audit
                WHERE audit.subject_reference_hash = ${auditSubjectLiteral}
                  AND audit.event_type = 'processing-retry-approved'
            ) AS retrySubjectAuditCount
        FROM gallery_drafts AS draft
        JOIN draft_processing_runs AS run
          ON run.draft_id = draft.draft_id
         AND run.start_idempotency_key = 'phase-d-remote-d-start-0001'
        JOIN draft_processing_cleanups AS cleanup
          ON cleanup.processing_run_id = run.processing_run_id
        JOIN draft_processing_cleanup_objects AS object
          ON object.cleanup_id = cleanup.cleanup_id
         AND object.role = 'photo-display'
        LEFT JOIN draft_transition_receipts AS retry
          ON retry.draft_id = draft.draft_id
         AND retry.idempotency_key = 'phase-d-remote-d-retry-0001'
        WHERE draft.draft_id = ${draftLiteral};
    `;
}

async function recoverScenarioD(dependencies, d1, fixture) {
    const history = assertScenarioDHistory(
        await readScenarioDHistory(d1, fixture),
        fixture
    );
    const run = Object.freeze({
        processingRunId: fixture.scenarioDProcessingRunId
    });
    let objectSnapshot = null;

    if (history.recoveryPhase === 'd-deleting') {
        objectSnapshot = assertScenarioDObjectSnapshot(
            await readScenarioDObjectSnapshot(d1, fixture),
            fixture,
            history.rows.d
        );
        await reconcileScenarioDStagingObject(dependencies, fixture, objectSnapshot);
        const faultedCleanup = await cleanupRun(
            dependencies,
            run,
            scenarioDFailedStateVersion,
            'd',
            'after-delete'
        );
        requireStatus(faultedCleanup.response, 503, 'recovery-d-fault-after-delete');
    }

    // This mandatory same-key call either converges the deleting checkpoint or
    // proves that a prior cleanup response was the only thing lost.
    const cleanupReplay = await cleanupRun(
        dependencies,
        run,
        scenarioDFailedStateVersion,
        'd'
    );
    requireStatus(cleanupReplay.response, 200, 'recovery-d-cleanup-replay');
    requireCleanupSuccess(
        cleanupReplay.body,
        run.processingRunId,
        true,
        'recovery-d-cleanup-replay'
    );

    const terminalPhase = history.recoveryPhase === 'd-after-retry'
        ? 'after-retry'
        : 'before-retry';
    let beforeReplay = assertScenarioDTerminalSnapshot(
        await readScenarioDTerminalSnapshot(
            d1,
            fixture,
            terminalPhase === 'after-retry'
                ? 'recovery-d-before-replay'
                : 'recovery-d-before-retry'
        ),
        fixture,
        history.rows.d,
        terminalPhase,
        objectSnapshot
    );

    if (terminalPhase === 'before-retry') {
        const firstRetryVersion = await retryFailedRun(
            dependencies,
            run,
            scenarioDFailedStateVersion,
            'd',
            'either'
        );
        if (firstRetryVersion !== scenarioDApprovedStateVersion) {
            throw rehearsalError('recovery-d-retry-state-invalid');
        }
        beforeReplay = assertScenarioDTerminalSnapshot(
            await readScenarioDTerminalSnapshot(
                d1,
                fixture,
                'recovery-d-before-replay'
            ),
            fixture,
            history.rows.d,
            'after-retry',
            objectSnapshot
        );
    }

    const replayVersion = await retryFailedRun(
        dependencies,
        run,
        scenarioDFailedStateVersion,
        'd',
        'replayed'
    );
    if (replayVersion !== scenarioDApprovedStateVersion) {
        throw rehearsalError('recovery-d-replay-state-invalid');
    }
    const afterReplay = assertScenarioDTerminalSnapshot(
        await readScenarioDTerminalSnapshot(
            d1,
            fixture,
            'recovery-d-after-replay'
        ),
        fixture,
        history.rows.d,
        'after-retry',
        objectSnapshot
    );
    if (JSON.stringify(afterReplay) !== JSON.stringify(beforeReplay)) {
        throw rehearsalError('recovery-d-replay-mutated-evidence');
    }
    return scenarioDApprovedStateVersion;
}

const scenarioARecoverySnapshotKeys = Object.freeze([
    'draftId',
    'processingRunId',
    'draftState',
    'draftStateVersion',
    'processingDiagnosticsJson',
    'draftUpdatedAt',
    'runEvidenceMatch',
    'pendingTaggedExclusionCount',
    'priorRunCount',
    'startExpectedStateVersion',
    'processingStateVersion',
    'startIdempotencyKey',
    'startPayloadFingerprint',
    'runActorIdentityHash',
    'runStatus',
    'resultIdempotencyKey',
    'resultPayloadFingerprint',
    'resultTransitionKey',
    'failureCode',
    'runCreatedAt',
    'runUpdatedAt',
    'runCompletedAt',
    'cleanupId',
    'cleanupIdHash',
    'cleanupProcessingRunIdHash',
    'cleanupDraftIdHash',
    'cleanupReason',
    'cleanupExpectedStateVersion',
    'cleanupOutputCount',
    'cleanupIdempotencyKey',
    'cleanupPayloadFingerprint',
    'cleanupActorIdentityHash',
    'cleanupStatus',
    'cleanupEvidenceHash',
    'cleanupCreatedAt',
    'cleanupUpdatedAt',
    'cleanupCompletedAt',
    'tombstoneCleanupIdHash',
    'tombstoneDraftIdHash',
    'tombstoneProcessingRunIdHash',
    'tombstoneReason',
    'tombstoneEvidenceHash',
    'tombstoneCompletedAt',
    'outputRowCount',
    'multipartRowCount',
    'derivativeRowCount',
    'cleanupCount',
    'cleanupObjectCount',
    'activeCleanupObjectCount',
    'matchingTombstoneCount',
    'runTombstoneCount',
    'retryReceiptCount',
    'retryStateVersionReceiptCount',
    'retryReceiptIdempotencyKey',
    'retryReceiptPayloadFingerprint',
    'retryReceiptFromState',
    'retryReceiptToState',
    'retryReceiptExpectedStateVersion',
    'retryReceiptResultStateVersion',
    'retryReceiptCreatedAt',
    'retrySubjectAuditCount',
    'retryAuditCount',
    'retryAuditEventId',
    'retryAuditSubjectHash',
    'retryAuditActorHash',
    'retryAuditPayloadHash',
    'retryAuditStateVersion',
    'retryAuditOccurredAt'
]);

async function readScenarioARecoverySnapshot(d1, fixture, label) {
    if (
        !isPlainObject(fixture) ||
        !draftIdPattern.test(fixture.draftId || '') ||
        !runIdPattern.test(fixture.scenarioAProcessingRunId || '')
    ) {
        throw rehearsalError('recovery-a-binding-invalid');
    }
    const rows = await d1.rows(
        label,
        scenarioARecoverySnapshotSql(
            fixture.draftId,
            fixture.scenarioAProcessingRunId
        )
    );
    if (rows.length !== 1 || !hasExactKeys(rows[0], scenarioARecoverySnapshotKeys)) {
        throw rehearsalError('recovery-a-evidence-unavailable');
    }
    return rows[0];
}

function assertScenarioARecoverySnapshot(snapshot, fixture, phase) {
    if (!['before-retry', 'after-retry'].includes(phase)) {
        throw rehearsalError('recovery-a-phase-invalid');
    }
    const facts = scenarioARecoveryFacts(
        fixture.draftId,
        fixture.scenarioAProcessingRunId
    );
    const nonEmptyTimeFields = [
        'draftUpdatedAt',
        'runCreatedAt',
        'runUpdatedAt',
        'runCompletedAt',
        'cleanupCreatedAt',
        'cleanupUpdatedAt',
        'cleanupCompletedAt'
    ];
    if (
        !isPlainObject(snapshot) ||
        !hasExactKeys(snapshot, scenarioARecoverySnapshotKeys) ||
        snapshot.draftId !== fixture.draftId ||
        snapshot.processingRunId !== fixture.scenarioAProcessingRunId ||
        snapshot.runEvidenceMatch !== 1 ||
        snapshot.pendingTaggedExclusionCount !== 0 ||
        snapshot.priorRunCount !== 1 ||
        snapshot.startExpectedStateVersion !==
            scenarioAProcessingStateVersion - 1 ||
        snapshot.processingStateVersion !== scenarioAProcessingStateVersion ||
        snapshot.startIdempotencyKey !== scenarioAStartIdempotencyKey ||
        snapshot.startPayloadFingerprint !== facts.startPayloadFingerprint ||
        !sha256Pattern.test(snapshot.runActorIdentityHash || '') ||
        snapshot.runStatus !== 'failed' ||
        snapshot.resultIdempotencyKey !== scenarioAFailureIdempotencyKey ||
        snapshot.resultPayloadFingerprint !== facts.failurePayloadFingerprint ||
        snapshot.resultTransitionKey !== facts.failureTransitionKey ||
        snapshot.failureCode !== 'processing-failed' ||
        nonEmptyTimeFields.some(key => !nonEmptyString(snapshot[key])) ||
        snapshot.runUpdatedAt !== snapshot.runCompletedAt ||
        !cleanupIdPattern.test(snapshot.cleanupId || '') ||
        snapshot.cleanupIdHash !== sha256Text(snapshot.cleanupId) ||
        snapshot.cleanupProcessingRunIdHash !== facts.processingRunIdHash ||
        snapshot.cleanupDraftIdHash !== facts.draftIdHash ||
        snapshot.cleanupReason !== 'processing-failed' ||
        snapshot.cleanupExpectedStateVersion !== scenarioAFailedStateVersion ||
        snapshot.cleanupOutputCount !== 0 ||
        snapshot.cleanupIdempotencyKey !== scenarioACleanupIdempotencyKey ||
        snapshot.cleanupPayloadFingerprint !== facts.cleanupPayloadFingerprint ||
        !sha256Pattern.test(snapshot.cleanupActorIdentityHash || '') ||
        snapshot.cleanupStatus !== 'cleaned' ||
        !sha256Pattern.test(snapshot.cleanupEvidenceHash || '') ||
        snapshot.cleanupUpdatedAt !== snapshot.cleanupCompletedAt ||
        snapshot.tombstoneCleanupIdHash !== snapshot.cleanupIdHash ||
        snapshot.tombstoneDraftIdHash !== snapshot.cleanupDraftIdHash ||
        snapshot.tombstoneProcessingRunIdHash !==
            snapshot.cleanupProcessingRunIdHash ||
        snapshot.tombstoneReason !== snapshot.cleanupReason ||
        snapshot.tombstoneEvidenceHash !== snapshot.cleanupEvidenceHash ||
        snapshot.tombstoneCompletedAt !== snapshot.cleanupCompletedAt ||
        snapshot.outputRowCount !== 0 ||
        snapshot.multipartRowCount !== 0 ||
        snapshot.derivativeRowCount !== 0 ||
        snapshot.cleanupCount !== 1 ||
        snapshot.cleanupObjectCount !== 0 ||
        snapshot.activeCleanupObjectCount !== 0 ||
        snapshot.matchingTombstoneCount !== 1 ||
        snapshot.runTombstoneCount !== 1
    ) {
        throw rehearsalError('recovery-a-checkpoint-invalid');
    }

    const retryFields = [
        'retryReceiptIdempotencyKey',
        'retryReceiptPayloadFingerprint',
        'retryReceiptFromState',
        'retryReceiptToState',
        'retryReceiptExpectedStateVersion',
        'retryReceiptResultStateVersion',
        'retryReceiptCreatedAt',
        'retryAuditEventId',
        'retryAuditSubjectHash',
        'retryAuditActorHash',
        'retryAuditPayloadHash',
        'retryAuditStateVersion',
        'retryAuditOccurredAt'
    ];
    if (phase === 'before-retry') {
        if (
            snapshot.draftState !== 'processing-failed' ||
            snapshot.draftStateVersion !== scenarioAFailedStateVersion ||
            snapshot.processingDiagnosticsJson !== scenarioADiagnosticsJson ||
            snapshot.retryReceiptCount !== 0 ||
            snapshot.retryStateVersionReceiptCount !== 0 ||
            snapshot.retrySubjectAuditCount !== 0 ||
            snapshot.retryAuditCount !== 0 ||
            retryFields.some(key => snapshot[key] !== null)
        ) {
            throw rehearsalError('recovery-a-before-retry-invalid');
        }
    } else if (
        snapshot.draftState !== 'approved-for-processing' ||
        snapshot.draftStateVersion !== scenarioAApprovedStateVersion ||
        snapshot.processingDiagnosticsJson !== null ||
        snapshot.retryReceiptCount !== 1 ||
        snapshot.retryStateVersionReceiptCount !== 1 ||
        snapshot.retryReceiptIdempotencyKey !== scenarioARetryIdempotencyKey ||
        snapshot.retryReceiptPayloadFingerprint !== facts.retryPayloadFingerprint ||
        snapshot.retryReceiptFromState !== 'processing-failed' ||
        snapshot.retryReceiptToState !== 'approved-for-processing' ||
        snapshot.retryReceiptExpectedStateVersion !== scenarioAFailedStateVersion ||
        snapshot.retryReceiptResultStateVersion !== scenarioAApprovedStateVersion ||
        !nonEmptyString(snapshot.retryReceiptCreatedAt) ||
        snapshot.retrySubjectAuditCount !== 1 ||
        snapshot.retryAuditCount !== 1 ||
        !nonEmptyString(snapshot.retryAuditEventId) ||
        snapshot.retryAuditSubjectHash !== facts.auditSubjectHash ||
        !sha256Pattern.test(snapshot.retryAuditActorHash || '') ||
        snapshot.retryAuditPayloadHash !== facts.retryPayloadFingerprint ||
        snapshot.retryAuditStateVersion !== scenarioAApprovedStateVersion ||
        snapshot.retryAuditOccurredAt !== snapshot.retryReceiptCreatedAt
    ) {
        throw rehearsalError('recovery-a-after-retry-invalid');
    }

    return Object.freeze(Object.fromEntries(
        scenarioARecoverySnapshotKeys.map(key => [key, snapshot[key]])
    ));
}

function scenarioARecoverySnapshotSql(draftId, processingRunId) {
    const draftLiteral = exactSqlLiteral(draftId, draftIdPattern, 'draft ID');
    const runLiteral = exactSqlLiteral(processingRunId, runIdPattern, 'run ID');
    const facts = scenarioARecoveryFacts(draftId, processingRunId);
    const auditSubjectLiteral = exactSqlLiteral(
        facts.auditSubjectHash,
        sha256Pattern,
        'audit subject hash'
    );
    const retryFingerprintLiteral = exactSqlLiteral(
        facts.retryPayloadFingerprint,
        sha256Pattern,
        'retry fingerprint'
    );
    return `
        SELECT
            draft.draft_id AS draftId,
            run.processing_run_id AS processingRunId,
            draft.state AS draftState,
            draft.state_version AS draftStateVersion,
            draft.processing_diagnostics_json AS processingDiagnosticsJson,
            draft.updated_at AS draftUpdatedAt,
            CASE WHEN
                draft.export_bundle_id = '${catalogSnapshot.exportBundleId}' AND
                draft.source_revision = '${catalogSnapshot.sourceRevision}' AND
                draft.suppression_revision = '${catalogSnapshot.suppressionRevision}' AND
                draft.media_type = 'photo' AND
                draft.upload_complete = 1 AND
                run.site_mode = json_extract(draft.site_modes_json, '$[0]') AND
                run.media_type = draft.media_type AND
                run.item_revision = draft.item_revision AND
                run.consent_revision = draft.active_consent_revision AND
                run.export_bundle_id = draft.export_bundle_id AND
                run.source_revision = draft.source_revision AND
                run.suppression_revision = draft.suppression_revision AND
                run.original_object_key = draft.original_object_key AND
                run.original_detected_type = draft.original_detected_type AND
                run.original_declared_content_type = upload.declared_content_type AND
                run.original_byte_count = draft.original_byte_count AND
                run.original_sha256 = draft.original_sha256 AND
                consent.public_use_confirmed = 1 AND
                (consent.contains_minors = 0 OR
                    consent.guardian_approval_confirmed = 1) AND
                consent.withdrawn_at IS NULL AND
                upload.status = 'complete' AND
                upload.synthetic_only_confirmed = 1 AND
                upload.item_revision = run.item_revision AND
                upload.consent_revision = run.consent_revision AND
                upload.export_bundle_id = run.export_bundle_id AND
                upload.source_revision = run.source_revision AND
                upload.suppression_revision = run.suppression_revision AND
                upload.object_key = run.original_object_key AND
                upload.detected_format = run.original_detected_type AND
                upload.declared_byte_count = run.original_byte_count AND
                upload.completed_object_version = run.original_object_version AND
                upload.completed_etag = run.original_etag AND
                upload.completed_sha256 = run.original_sha256
                THEN 1 ELSE 0 END AS runEvidenceMatch,
            (SELECT COUNT(*)
                FROM json_each(draft.athlete_ids_json) AS tag
                JOIN pending_athlete_exclusions AS exclusion
                  ON exclusion.athlete_id = tag.value
                WHERE exclusion.resolved_at IS NULL) AS pendingTaggedExclusionCount,
            (SELECT COUNT(*) FROM draft_processing_runs AS prior
                WHERE prior.draft_id = draft.draft_id) AS priorRunCount,
            run.start_expected_state_version AS startExpectedStateVersion,
            run.processing_state_version AS processingStateVersion,
            run.start_idempotency_key AS startIdempotencyKey,
            run.start_payload_fingerprint AS startPayloadFingerprint,
            run.service_actor_identity_hash AS runActorIdentityHash,
            run.status AS runStatus,
            run.result_idempotency_key AS resultIdempotencyKey,
            run.result_payload_fingerprint AS resultPayloadFingerprint,
            run.result_transition_key AS resultTransitionKey,
            run.failure_code AS failureCode,
            run.created_at AS runCreatedAt,
            run.updated_at AS runUpdatedAt,
            run.completed_at AS runCompletedAt,
            cleanup.cleanup_id AS cleanupId,
            cleanup.cleanup_id_hash AS cleanupIdHash,
            cleanup.processing_run_id_hash AS cleanupProcessingRunIdHash,
            cleanup.draft_id_hash AS cleanupDraftIdHash,
            cleanup.cleanup_reason AS cleanupReason,
            cleanup.expected_state_version AS cleanupExpectedStateVersion,
            cleanup.output_count AS cleanupOutputCount,
            cleanup.idempotency_key AS cleanupIdempotencyKey,
            cleanup.payload_fingerprint AS cleanupPayloadFingerprint,
            cleanup.service_actor_identity_hash AS cleanupActorIdentityHash,
            cleanup.status AS cleanupStatus,
            cleanup.cleanup_evidence_hash AS cleanupEvidenceHash,
            cleanup.created_at AS cleanupCreatedAt,
            cleanup.updated_at AS cleanupUpdatedAt,
            cleanup.completed_at AS cleanupCompletedAt,
            tombstone.cleanup_id_hash AS tombstoneCleanupIdHash,
            tombstone.draft_id_hash AS tombstoneDraftIdHash,
            tombstone.processing_run_id_hash AS tombstoneProcessingRunIdHash,
            tombstone.cleanup_reason AS tombstoneReason,
            tombstone.evidence_hash AS tombstoneEvidenceHash,
            tombstone.completed_at AS tombstoneCompletedAt,
            (SELECT COUNT(*) FROM draft_processing_outputs AS output
                WHERE output.processing_run_id = run.processing_run_id) AS outputRowCount,
            (SELECT COUNT(*) FROM draft_processing_multipart_uploads AS multipart
                WHERE multipart.processing_run_id = run.processing_run_id) AS multipartRowCount,
            (SELECT COUNT(*) FROM draft_derivatives AS derivative
                WHERE derivative.draft_id = draft.draft_id) AS derivativeRowCount,
            (SELECT COUNT(*) FROM draft_processing_cleanups AS current_cleanup
                WHERE current_cleanup.processing_run_id = run.processing_run_id) AS cleanupCount,
            (SELECT COUNT(*) FROM draft_processing_cleanup_objects AS object
                WHERE object.cleanup_id = cleanup.cleanup_id) AS cleanupObjectCount,
            (SELECT COUNT(*) FROM draft_processing_cleanup_objects AS object
                WHERE object.cleanup_id = cleanup.cleanup_id
                  AND (object.status <> 'absent' OR
                    object.staging_object_key IS NOT NULL OR
                    object.provider_terminal_kind IS NULL OR
                    object.absence_verified_at IS NULL)) AS activeCleanupObjectCount,
            (SELECT COUNT(*) FROM gallery_processing_cleanup_tombstones AS exact_tombstone
                WHERE exact_tombstone.cleanup_id_hash = cleanup.cleanup_id_hash
                  AND exact_tombstone.draft_id_hash = cleanup.draft_id_hash
                  AND exact_tombstone.processing_run_id_hash =
                    cleanup.processing_run_id_hash
                  AND exact_tombstone.cleanup_reason = cleanup.cleanup_reason
                  AND exact_tombstone.evidence_hash = cleanup.cleanup_evidence_hash
                  AND exact_tombstone.completed_at = cleanup.completed_at
            ) AS matchingTombstoneCount,
            (SELECT COUNT(*) FROM gallery_processing_cleanup_tombstones AS run_tombstone
                WHERE run_tombstone.processing_run_id_hash =
                    cleanup.processing_run_id_hash) AS runTombstoneCount,
            (SELECT COUNT(*) FROM draft_transition_receipts AS exact_retry
                WHERE exact_retry.draft_id = draft.draft_id
                  AND exact_retry.idempotency_key =
                    '${scenarioARetryIdempotencyKey}') AS retryReceiptCount,
            (SELECT COUNT(*) FROM draft_transition_receipts AS version_retry
                WHERE version_retry.draft_id = draft.draft_id
                  AND version_retry.expected_state_version =
                    ${scenarioAFailedStateVersion}) AS retryStateVersionReceiptCount,
            retry.idempotency_key AS retryReceiptIdempotencyKey,
            retry.payload_fingerprint AS retryReceiptPayloadFingerprint,
            retry.from_state AS retryReceiptFromState,
            retry.to_state AS retryReceiptToState,
            retry.expected_state_version AS retryReceiptExpectedStateVersion,
            retry.result_state_version AS retryReceiptResultStateVersion,
            retry.created_at AS retryReceiptCreatedAt,
            (SELECT COUNT(*) FROM gallery_audit_events AS subject_retry_audit
                WHERE subject_retry_audit.subject_reference_hash =
                    ${auditSubjectLiteral}
                  AND subject_retry_audit.event_type =
                    'processing-retry-approved') AS retrySubjectAuditCount,
            (SELECT COUNT(*) FROM gallery_audit_events AS exact_retry_audit
                WHERE exact_retry_audit.subject_reference_hash =
                    ${auditSubjectLiteral}
                  AND exact_retry_audit.event_type = 'processing-retry-approved'
                  AND exact_retry_audit.payload_hash = ${retryFingerprintLiteral}
                  AND exact_retry_audit.state_version =
                    ${scenarioAApprovedStateVersion}
                  AND exact_retry_audit.occurred_at = retry.created_at
            ) AS retryAuditCount,
            (SELECT MIN(exact_retry_audit.audit_event_id)
                FROM gallery_audit_events AS exact_retry_audit
                WHERE exact_retry_audit.subject_reference_hash =
                    ${auditSubjectLiteral}
                  AND exact_retry_audit.event_type = 'processing-retry-approved'
                  AND exact_retry_audit.payload_hash = ${retryFingerprintLiteral}
                  AND exact_retry_audit.state_version =
                    ${scenarioAApprovedStateVersion}
                  AND exact_retry_audit.occurred_at = retry.created_at
            ) AS retryAuditEventId,
            (SELECT MIN(exact_retry_audit.subject_reference_hash)
                FROM gallery_audit_events AS exact_retry_audit
                WHERE exact_retry_audit.subject_reference_hash =
                    ${auditSubjectLiteral}
                  AND exact_retry_audit.event_type = 'processing-retry-approved'
                  AND exact_retry_audit.payload_hash = ${retryFingerprintLiteral}
                  AND exact_retry_audit.state_version =
                    ${scenarioAApprovedStateVersion}
                  AND exact_retry_audit.occurred_at = retry.created_at
            ) AS retryAuditSubjectHash,
            (SELECT MIN(exact_retry_audit.actor_identity_hash)
                FROM gallery_audit_events AS exact_retry_audit
                WHERE exact_retry_audit.subject_reference_hash =
                    ${auditSubjectLiteral}
                  AND exact_retry_audit.event_type = 'processing-retry-approved'
                  AND exact_retry_audit.payload_hash = ${retryFingerprintLiteral}
                  AND exact_retry_audit.state_version =
                    ${scenarioAApprovedStateVersion}
                  AND exact_retry_audit.occurred_at = retry.created_at
            ) AS retryAuditActorHash,
            (SELECT MIN(exact_retry_audit.payload_hash)
                FROM gallery_audit_events AS exact_retry_audit
                WHERE exact_retry_audit.subject_reference_hash =
                    ${auditSubjectLiteral}
                  AND exact_retry_audit.event_type = 'processing-retry-approved'
                  AND exact_retry_audit.payload_hash = ${retryFingerprintLiteral}
                  AND exact_retry_audit.state_version =
                    ${scenarioAApprovedStateVersion}
                  AND exact_retry_audit.occurred_at = retry.created_at
            ) AS retryAuditPayloadHash,
            (SELECT MIN(exact_retry_audit.state_version)
                FROM gallery_audit_events AS exact_retry_audit
                WHERE exact_retry_audit.subject_reference_hash =
                    ${auditSubjectLiteral}
                  AND exact_retry_audit.event_type = 'processing-retry-approved'
                  AND exact_retry_audit.payload_hash = ${retryFingerprintLiteral}
                  AND exact_retry_audit.state_version =
                    ${scenarioAApprovedStateVersion}
                  AND exact_retry_audit.occurred_at = retry.created_at
            ) AS retryAuditStateVersion,
            (SELECT MIN(exact_retry_audit.occurred_at)
                FROM gallery_audit_events AS exact_retry_audit
                WHERE exact_retry_audit.subject_reference_hash =
                    ${auditSubjectLiteral}
                  AND exact_retry_audit.event_type = 'processing-retry-approved'
                  AND exact_retry_audit.payload_hash = ${retryFingerprintLiteral}
                  AND exact_retry_audit.state_version =
                    ${scenarioAApprovedStateVersion}
                  AND exact_retry_audit.occurred_at = retry.created_at
            ) AS retryAuditOccurredAt
        FROM gallery_drafts AS draft
        JOIN draft_processing_runs AS run
          ON run.draft_id = draft.draft_id
         AND run.processing_run_id = ${runLiteral}
         AND run.start_idempotency_key = '${scenarioAStartIdempotencyKey}'
        JOIN draft_consent_attestations AS consent
          ON consent.draft_id = run.draft_id
         AND consent.consent_revision = run.consent_revision
        JOIN draft_upload_sessions AS upload
          ON upload.upload_session_id = run.upload_session_id
         AND upload.draft_id = run.draft_id
        LEFT JOIN draft_processing_cleanups AS cleanup
          ON cleanup.processing_run_id = run.processing_run_id
        LEFT JOIN gallery_processing_cleanup_tombstones AS tombstone
          ON tombstone.cleanup_id_hash = cleanup.cleanup_id_hash
         AND tombstone.draft_id_hash = cleanup.draft_id_hash
         AND tombstone.processing_run_id_hash = cleanup.processing_run_id_hash
         AND tombstone.cleanup_reason = cleanup.cleanup_reason
         AND tombstone.evidence_hash = cleanup.cleanup_evidence_hash
         AND tombstone.completed_at = cleanup.completed_at
        LEFT JOIN draft_transition_receipts AS retry
          ON retry.draft_id = draft.draft_id
         AND retry.idempotency_key = '${scenarioARetryIdempotencyKey}'
        WHERE draft.draft_id = ${draftLiteral}
          AND draft.public_item_id = '${eligibleMarker}'
          AND draft.site_modes_json = '${fixtureSiteModesJson}'
          AND draft.race_date = '${fixtureRaceDate}'
          AND draft.race_event = '${fixtureRaceEvent}'
          AND draft.race_distance = '${fixtureRaceDistance}'
          AND draft.athlete_ids_json = '${fixtureAthleteIdsJson}'
          AND draft.original_sha256 = '${fixtureOriginalSha256}';
    `;
}

function scenarioARecoveryFacts(draftId, processingRunId) {
    if (!draftIdPattern.test(draftId || '') || !runIdPattern.test(processingRunId || '')) {
        throw rehearsalError('recovery-a-binding-invalid');
    }
    const startPayloadFingerprint = sha256Text(JSON.stringify({
        operation: 'processing-start',
        draftId,
        expectedStateVersion: scenarioAProcessingStateVersion - 1,
        idempotencyKey: scenarioAStartIdempotencyKey
    }));
    const failurePayloadFingerprint = sha256Text(JSON.stringify({
        operation: 'processing-result',
        processingRunId,
        result: {
            outcome: 'failed',
            expectedStateVersion: scenarioAProcessingStateVersion,
            idempotencyKey: scenarioAFailureIdempotencyKey,
            errorCode: 'processing-failed'
        }
    }));
    const cleanupPayloadFingerprint = sha256Text(JSON.stringify({
        operation: 'processing-cleanup',
        processingRunId,
        expectedStateVersion: scenarioAFailedStateVersion,
        idempotencyKey: scenarioACleanupIdempotencyKey
    }));
    const retryPayloadFingerprint = sha256Text(JSON.stringify({
        operation: 'processing-retry',
        processingRunId,
        expectedStateVersion: scenarioAFailedStateVersion,
        idempotencyKey: scenarioARetryIdempotencyKey
    }));
    return Object.freeze({
        startPayloadFingerprint,
        failurePayloadFingerprint,
        cleanupPayloadFingerprint,
        retryPayloadFingerprint,
        failureTransitionKey:
            `failure_${sha256Text(`${processingRunId}:${scenarioAFailureIdempotencyKey}`)}`,
        auditSubjectHash: sha256Text(`draft:${draftId}`),
        draftIdHash: sha256Text(draftId),
        processingRunIdHash: sha256Text(processingRunId)
    });
}

async function readBoundarySnapshot(d1, label) {
    const rows = await d1.rows(label, boundarySnapshotSql());
    if (rows.length !== 1) {
        throw rehearsalError('boundary-evidence-unavailable');
    }
    const snapshot = {};
    for (const key of [
        'approvedReferenceCount',
        'publicationReferenceCount',
        'publicwardDraftCount',
        'pendingExclusionCount'
    ]) {
        if (!Number.isSafeInteger(rows[0][key]) || rows[0][key] < 0) {
            throw rehearsalError('boundary-evidence-invalid');
        }
        snapshot[key] = rows[0][key];
    }
    return Object.freeze(snapshot);
}

function boundarySnapshotSql() {
    return `
        SELECT
            (SELECT COUNT(*) FROM draft_derivatives
                WHERE approved_object_key IS NOT NULL) AS approvedReferenceCount,
            (SELECT COUNT(*) FROM draft_publication_references) AS publicationReferenceCount,
            (SELECT COUNT(*) FROM gallery_drafts
                WHERE state IN ('candidate-public', 'pr-open', 'published')) AS publicwardDraftCount,
            (SELECT COUNT(*) FROM pending_athlete_exclusions
                WHERE resolved_at IS NULL) AS pendingExclusionCount;
    `;
}

function assertPrivateBoundary(snapshot) {
    if (
        snapshot.approvedReferenceCount !== 0 ||
        snapshot.publicationReferenceCount !== 0 ||
        snapshot.publicwardDraftCount !== 0 ||
        snapshot.pendingExclusionCount !== 0
    ) {
        throw rehearsalError('private-boundary-not-empty');
    }
}

async function startRun(dependencies, draftId, expectedStateVersion, key) {
    const idempotencyKey = `phase-d-remote-${key}-start-0001`;
    const { response, body } = await serviceJson(dependencies, {
        method: 'POST',
        pathname: `/api/service/drafts/${draftId}/processing-runs`,
        json: { expectedStateVersion, idempotencyKey }
    });
    requireStatus(response, 201, `start-${key}`);
    if (
        !hasExactKeys(body, [
            'schemaVersion',
            'scope',
            'processingRunId',
            'site',
            'mediaType',
            'state',
            'stateVersion',
            'source',
            'requiredRoles',
            'runStatus',
            'replayed'
        ]) ||
        body.schemaVersion !== '1.0' ||
        body.scope !== 'photo-processing-v1' ||
        !runIdPattern.test(body.processingRunId || '') ||
        body.site !== 'family' ||
        body.mediaType !== 'photo' ||
        body.state !== 'processing' ||
        body.stateVersion !== expectedStateVersion + 1 ||
        body.runStatus !== 'active' ||
        body.replayed !== false ||
        !isPlainObject(body.source) ||
        !hasExactKeys(body.source, [
            'downloadPath',
            'sha256',
            'byteLength',
            'detectedFormat',
            'declaredMimeType',
            'fileExtension'
        ]) ||
        body.source.downloadPath !==
            `/api/service/processing-runs/${body.processingRunId}/original` ||
        !sha256Pattern.test(body.source.sha256 || '') ||
        !Number.isSafeInteger(body.source.byteLength) ||
        body.source.byteLength < 1 ||
        !['jpeg', 'png'].includes(body.source.detectedFormat) ||
        !['image/jpeg', 'image/png'].includes(body.source.declaredMimeType) ||
        body.source.declaredMimeType !==
            (body.source.detectedFormat === 'jpeg' ? 'image/jpeg' : 'image/png') ||
        body.source.fileExtension !==
            (body.source.detectedFormat === 'jpeg' ? 'jpg' : 'png') ||
        !Array.isArray(body.requiredRoles) ||
        body.requiredRoles.length !== 2 ||
        body.requiredRoles[0] !== 'photo-display' ||
        body.requiredRoles[1] !== 'photo-thumbnail'
    ) {
        throw rehearsalError(`start-${key}-evidence-invalid`);
    }
    return Object.freeze({ ...body, requiredRoles: Object.freeze([...body.requiredRoles]) });
}

async function processRunPhoto(dependencies, draftId, run) {
    const response = await serviceRequest(dependencies, {
        method: 'GET',
        pathname: run.source.downloadPath
    });
    requireStatus(response, 200, 'source-download');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (
        bytes.byteLength !== run.source.byteLength ||
        sha256(bytes) !== run.source.sha256 ||
        response.headers.get('X-Gallery-Content-SHA256') !== run.source.sha256
    ) {
        throw rehearsalError('source-evidence-mismatch');
    }
    const processed = await dependencies.processPhoto({
        syntheticOnly: true,
        sourceBytes: bytes,
        fileName: `synthetic-source.${run.source.fileExtension}`,
        declaredMimeType: run.source.declaredMimeType,
        draftBinding: {
            site: run.site,
            draftId,
            processingRunId: run.processingRunId
        }
    });
    validateProcessedResult(processed, draftId, run);
    return processed;
}

function validateProcessedResult(processed, draftId, run) {
    if (
        !isPlainObject(processed) ||
        processed.inheritedSite !== run.site ||
        processed.draftId !== draftId ||
        processed.processingRunId !== run.processingRunId ||
        processed.mediaType !== 'photo' ||
        !isPlainObject(processed.source) ||
        processed.source.sha256 !== run.source.sha256 ||
        processed.source.byteLength !== run.source.byteLength ||
        processed.source.detectedFormat !== run.source.detectedFormat ||
        !isPlainObject(processed.toolchain) ||
        !Array.isArray(processed.derivatives) ||
        processed.derivatives.length !== 2
    ) {
        throw rehearsalError('processor-evidence-invalid');
    }
    const roles = new Set();
    for (const derivative of processed.derivatives) {
        const role = derivative?.storageRole;
        if (
            !run.requiredRoles.includes(role) ||
            roles.has(role) ||
            !sha256Pattern.test(derivative.sha256 || '') ||
            !Number.isSafeInteger(derivative.byteLength) ||
            derivative.byteLength < 1 ||
            !Number.isSafeInteger(derivative.width) ||
            derivative.width < 1 ||
            !Number.isSafeInteger(derivative.height) ||
            derivative.height < 1 ||
            derivative.metadataEntryCount !== 0 ||
            !(derivative.payload instanceof Blob) ||
            derivative.stagingKey !== buildV1StagingDerivativeKey({
                site: run.site,
                draftId,
                processingRunId: run.processingRunId,
                sha256: derivative.sha256,
                role
            })
        ) {
            throw rehearsalError('processor-derivative-invalid');
        }
        roles.add(role);
    }
}

function derivativeByRole(processed, role) {
    const derivative = processed.derivatives.find(entry => entry.storageRole === role);
    if (!derivative) {
        throw rehearsalError('processor-role-missing');
    }
    return derivative;
}

async function putDerivative(dependencies, run, derivative, key, fault) {
    const bytes = new Uint8Array(await derivative.payload.arrayBuffer());
    if (bytes.byteLength !== derivative.byteLength || sha256(bytes) !== derivative.sha256) {
        throw rehearsalError('derivative-payload-mismatch');
    }
    const headers = {
        'Content-Type': 'image/webp',
        'Content-Length': String(bytes.byteLength),
        'X-Gallery-Content-SHA256': derivative.sha256,
        'Idempotency-Key': `phase-d-remote-${key}-0001`
    };
    if (fault !== undefined) {
        if (!galleryPhaseDRemoteRehearsalContract.faultValues.includes(fault)) {
            throw rehearsalError('invalid-rehearsal-fault');
        }
        headers[rehearsalFaultHeader] = fault;
    }
    const result = await serviceJson(dependencies, {
        method: 'PUT',
        pathname:
            `/api/service/processing-runs/${run.processingRunId}/derivatives/` +
            derivative.storageRole,
        headers,
        body: bytes,
        acceptFailureJson: fault !== undefined
    });
    if (fault === undefined && (
        !hasExactKeys(result.body, [
            'schemaVersion',
            'processingRunId',
            'role',
            'sha256',
            'byteLength',
            'width',
            'height',
            'replayed'
        ]) ||
        result.body.schemaVersion !== '1.0' ||
        result.body.processingRunId !== run.processingRunId ||
        result.body.role !== derivative.storageRole ||
        result.body.sha256 !== derivative.sha256 ||
        result.body.byteLength !== derivative.byteLength ||
        result.body.width !== derivative.width ||
        result.body.height !== derivative.height ||
        result.body.replayed !== false
    )) {
        throw rehearsalError(`put-${key}-evidence-invalid`);
    }
    return result.response;
}

async function failRun(dependencies, run, key) {
    const result = await serviceJson(dependencies, {
        method: 'POST',
        pathname: `/api/service/processing-runs/${run.processingRunId}/result`,
        json: {
            outcome: 'failed',
            expectedStateVersion: run.stateVersion,
            idempotencyKey: `phase-d-remote-${key}-failed-0001`,
            errorCode: 'processing-failed'
        }
    });
    requireStatus(result.response, 200, `fail-${key}`);
    if (
        !hasExactKeys(result.body, [
            'schemaVersion',
            'processingRunId',
            'status',
            'state',
            'stateVersion',
            'roles',
            'replayed'
        ]) ||
        result.body.schemaVersion !== '1.0' ||
        result.body.processingRunId !== run.processingRunId ||
        result.body.status !== 'failed' ||
        result.body.state !== 'processing-failed' ||
        result.body.stateVersion !== run.stateVersion + 1 ||
        !Array.isArray(result.body.roles) ||
        result.body.roles.length !== 0 ||
        result.body.replayed !== false
    ) {
        throw rehearsalError(`fail-${key}-evidence-invalid`);
    }
    return result.body;
}

async function cleanupRun(dependencies, run, expectedStateVersion, key, fault) {
    const headers = {};
    if (fault !== undefined) {
        if (!['after-abort', 'after-delete'].includes(fault)) {
            throw rehearsalError('invalid-cleanup-fault');
        }
        headers[rehearsalFaultHeader] = fault;
    }
    return serviceJson(dependencies, {
        method: 'POST',
        pathname: `/api/service/processing-runs/${run.processingRunId}/cleanup`,
        headers,
        json: {
            expectedStateVersion,
            idempotencyKey: `phase-d-remote-${key}-cleanup-0001`
        },
        acceptFailureJson: true
    });
}

async function recordStagedResult(dependencies, run, processed, key) {
    return serviceJson(dependencies, {
        method: 'POST',
        pathname: `/api/service/processing-runs/${run.processingRunId}/result`,
        json: {
            outcome: 'staged',
            expectedStateVersion: run.stateVersion,
            idempotencyKey: `phase-d-remote-${key}-staged-0001`,
            source: {
                sha256: processed.source.sha256,
                byteLength: processed.source.byteLength,
                detectedFormat: processed.source.detectedFormat
            },
            toolchain: { ...processed.toolchain },
            derivatives: processed.derivatives.map(derivative => ({
                role: derivative.storageRole,
                sha256: derivative.sha256,
                byteLength: derivative.byteLength,
                width: derivative.width,
                height: derivative.height,
                durationMilliseconds: null,
                metadataEntryCount: derivative.metadataEntryCount,
                metadataFindingCategories: []
            }))
        }
    });
}

async function serviceJson(dependencies, request) {
    const response = await serviceRequest(dependencies, request);
    let body = {};
    try {
        body = await response.clone().json();
    } catch {
        if (!request.acceptFailureJson) {
            throw rehearsalError('service-json-invalid');
        }
    }
    if (!isPlainObject(body)) {
        throw rehearsalError('service-json-invalid');
    }
    return Object.freeze({ response, body });
}

async function serviceRequest(dependencies, {
    method,
    pathname,
    json,
    headers = {},
    body
}) {
    if (
        !['GET', 'POST', 'PUT'].includes(method) ||
        typeof pathname !== 'string' ||
        !pathname.startsWith('/api/service/') ||
        pathname.includes('?') ||
        pathname.includes('#')
    ) {
        throw rehearsalError('invalid-service-request');
    }
    const requestHeaders = new Headers(headers);
    requestHeaders.set('CF-Access-Client-Id', dependencies.serviceToken.clientId);
    requestHeaders.set('CF-Access-Client-Secret', dependencies.serviceToken.clientSecret);
    let requestBody = body;
    if (json !== undefined) {
        requestBody = JSON.stringify(json);
        requestHeaders.set('Content-Type', 'application/json');
        requestHeaders.set('Content-Length', String(Buffer.byteLength(requestBody)));
    }
    const requestUrl = `${dependencies.processingOrigin}${pathname}`;
    let response;
    const abortController = new AbortController();
    let timedOut = false;
    let timeoutHandle;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
            timedOut = true;
            abortController.abort();
            reject(rehearsalError('service-request-timeout'));
        }, serviceRequestTimeoutMs);
    });
    try {
        response = await Promise.race([
            dependencies.fetchImpl(requestUrl, {
                method,
                headers: requestHeaders,
                body: requestBody,
                redirect: 'error',
                credentials: 'omit',
                referrerPolicy: 'no-referrer',
                signal: abortController.signal
            }),
            timeoutPromise
        ]);
    } catch {
        if (timedOut) {
            throw rehearsalError('service-request-timeout');
        }
        throw rehearsalError('service-request-failed');
    } finally {
        clearTimeout(timeoutHandle);
    }
    if (
        !(response instanceof Response) ||
        response.redirected === true ||
        (response.url !== '' && response.url !== requestUrl)
    ) {
        throw rehearsalError('service-response-invalid');
    }
    return response;
}

async function assertCleanedRun(d1, runId, expectedOutputCount) {
    const rows = await d1.rows(
        'cleaned-run-evidence',
        cleanedRunEvidenceSql(runId)
    );
    const row = rows[0];
    if (
        rows.length !== 1 ||
        row.runStatus !== 'failed' ||
        row.draftState !== 'processing-failed' ||
        row.cleanupStatus !== 'cleaned' ||
        row.cleanupReason !== 'processing-failed' ||
        row.outputCount !== expectedOutputCount ||
        row.activeOutputCount !== 0 ||
        row.activeMultipartCount !== 0 ||
        row.activeDerivativeCount !== 0 ||
        row.cleanupObjectCount !== expectedOutputCount ||
        row.absentCleanupObjectCount !== expectedOutputCount ||
        row.pendingCleanupObjectCount !== 0 ||
        row.tombstoneCount !== 1
    ) {
        throw rehearsalError('cleaned-run-evidence-invalid');
    }
}

async function assertPrefixRefusal(d1, runId) {
    const rows = await d1.rows('prefix-refusal-evidence', cleanedRunEvidenceSql(runId));
    const row = rows[0];
    if (
        rows.length !== 1 ||
        row.runStatus !== 'failed' ||
        row.draftState !== 'processing-failed' ||
        row.cleanupStatus !== 'deleting' ||
        row.cleanupReason !== 'processing-failed' ||
        row.outputCount !== 1 ||
        row.activeOutputCount !== 1 ||
        row.activeMultipartCount !== 1 ||
        row.activeDerivativeCount !== 0 ||
        row.cleanupObjectCount !== 1 ||
        row.absentCleanupObjectCount !== 1 ||
        row.pendingCleanupObjectCount !== 0 ||
        row.tombstoneCount !== 0
    ) {
        throw rehearsalError('prefix-refusal-evidence-invalid');
    }
}

async function retryFailedRun(
    dependencies,
    run,
    expectedStateVersion,
    key,
    replayExpectation = 'new'
) {
    if (!['new', 'either', 'replayed'].includes(replayExpectation)) {
        throw rehearsalError('invalid-retry-replay-expectation');
    }
    const { response, body } = await serviceJson(dependencies, {
        method: 'POST',
        pathname: `/api/service/processing-runs/${run.processingRunId}/retry`,
        json: {
            expectedStateVersion,
            idempotencyKey: `phase-d-remote-${key}-retry-0001`
        }
    });
    requireStatus(response, 200, `retry-${key}`);
    if (
        !hasExactKeys(body, [
            'schemaVersion',
            'processingRunId',
            'state',
            'stateVersion',
            'replayed'
        ]) ||
        body.schemaVersion !== '1.0' ||
        body.processingRunId !== run.processingRunId ||
        body.state !== 'approved-for-processing' ||
        body.stateVersion !== expectedStateVersion + 1 ||
        typeof body.replayed !== 'boolean' ||
        (replayExpectation === 'new' && body.replayed !== false) ||
        (replayExpectation === 'replayed' && body.replayed !== true)
    ) {
        throw rehearsalError(`retry-${key}-evidence-invalid`);
    }
    return body.stateVersion;
}

async function assertFinalStagedRun(d1, runId, expectedCleanupCount) {
    const rows = await d1.rows('final-staged-evidence', finalStagedEvidenceSql(runId));
    const row = rows[0];
    if (
        rows.length !== 1 ||
        row.runStatus !== 'staged' ||
        row.draftState !== 'processing' ||
        row.draftStateVersion !== 19 ||
        row.processingDiagnosticsJson !== null ||
        row.verifiedOutputCount !== 2 ||
        row.multipartHandleCount !== 2 ||
        row.terminalMultipartCount !== 2 ||
        row.completedMultipartCount !== 2 ||
        row.privateDerivativeCount !== 2 ||
        row.approvedDerivativeCount !== 0 ||
        row.finalCleanupCount !== 0 ||
        row.completedCleanupCount !== expectedCleanupCount
    ) {
        throw rehearsalError('final-staged-evidence-invalid');
    }
}

function cleanedRunEvidenceSql(runId) {
    const runLiteral = exactSqlLiteral(runId, runIdPattern, 'run ID');
    return `
        SELECT
            run.status AS runStatus,
            draft.state AS draftState,
            cleanup.status AS cleanupStatus,
            cleanup.cleanup_reason AS cleanupReason,
            cleanup.output_count AS outputCount,
            (SELECT COUNT(*) FROM draft_processing_outputs AS output
                WHERE output.processing_run_id = run.processing_run_id) AS activeOutputCount,
            (SELECT COUNT(*) FROM draft_processing_multipart_uploads AS multipart
                WHERE multipart.processing_run_id = run.processing_run_id) AS activeMultipartCount,
            (SELECT COUNT(*) FROM draft_derivatives AS derivative
                WHERE derivative.draft_id = run.draft_id
                  AND derivative.staging_object_key IS NOT NULL
                  AND derivative.approved_object_key IS NULL) AS activeDerivativeCount,
            (SELECT COUNT(*) FROM draft_processing_cleanup_objects AS object
                WHERE object.cleanup_id = cleanup.cleanup_id) AS cleanupObjectCount,
            (SELECT COUNT(*) FROM draft_processing_cleanup_objects AS object
                WHERE object.cleanup_id = cleanup.cleanup_id
                  AND object.status = 'absent') AS absentCleanupObjectCount,
            (SELECT COUNT(*) FROM draft_processing_cleanup_objects AS object
                WHERE object.cleanup_id = cleanup.cleanup_id
                  AND object.status = 'pending') AS pendingCleanupObjectCount,
            (SELECT COUNT(*) FROM gallery_processing_cleanup_tombstones AS tombstone
                WHERE tombstone.cleanup_id_hash = cleanup.cleanup_id_hash
                  AND tombstone.processing_run_id_hash = cleanup.processing_run_id_hash
                  AND tombstone.draft_id_hash = cleanup.draft_id_hash) AS tombstoneCount
        FROM draft_processing_runs AS run
        JOIN gallery_drafts AS draft ON draft.draft_id = run.draft_id
        LEFT JOIN draft_processing_cleanups AS cleanup
          ON cleanup.processing_run_id = run.processing_run_id
        WHERE run.processing_run_id = ${runLiteral};
    `;
}

function finalStagedEvidenceSql(runId) {
    const runLiteral = exactSqlLiteral(runId, runIdPattern, 'run ID');
    return `
        SELECT
            run.status AS runStatus,
            draft.state AS draftState,
            draft.state_version AS draftStateVersion,
            draft.processing_diagnostics_json AS processingDiagnosticsJson,
            (SELECT COUNT(*) FROM draft_processing_outputs AS output
                WHERE output.processing_run_id = run.processing_run_id
                  AND output.status = 'verified') AS verifiedOutputCount,
            (SELECT COUNT(*) FROM draft_processing_multipart_uploads AS multipart
                WHERE multipart.processing_run_id = run.processing_run_id
            ) AS multipartHandleCount,
            (SELECT COUNT(*) FROM draft_processing_multipart_uploads AS multipart
                WHERE multipart.processing_run_id = run.processing_run_id
                  AND multipart.status = 'terminal') AS terminalMultipartCount,
            (SELECT COUNT(*) FROM draft_processing_multipart_uploads AS multipart
                WHERE multipart.processing_run_id = run.processing_run_id
                  AND multipart.status = 'terminal'
                  AND multipart.terminal_kind = 'completed') AS completedMultipartCount,
            (SELECT COUNT(*) FROM draft_derivatives AS derivative
                WHERE derivative.draft_id = run.draft_id
                  AND derivative.staging_object_key IS NOT NULL
                  AND derivative.approved_object_key IS NULL) AS privateDerivativeCount,
            (SELECT COUNT(*) FROM draft_derivatives AS derivative
                WHERE derivative.draft_id = run.draft_id
                  AND derivative.approved_object_key IS NOT NULL) AS approvedDerivativeCount,
            (SELECT COUNT(*) FROM draft_processing_cleanups AS cleanup
                WHERE cleanup.processing_run_id = run.processing_run_id) AS finalCleanupCount,
            (SELECT COUNT(*) FROM draft_processing_cleanups AS cleanup
                WHERE cleanup.draft_id = run.draft_id
                  AND cleanup.status = 'cleaned') AS completedCleanupCount
        FROM draft_processing_runs AS run
        JOIN gallery_drafts AS draft ON draft.draft_id = run.draft_id
        WHERE run.processing_run_id = ${runLiteral};
    `;
}

function buildSentinelKey(draftId, run) {
    if (!draftIdPattern.test(draftId) || !runIdPattern.test(run.processingRunId || '')) {
        throw rehearsalError('invalid-sentinel-binding');
    }
    // Probe the canonical builder before deriving the exact run prefix. The
    // sentinel itself intentionally does not match a valid derivative key.
    const probe = buildV1StagingDerivativeKey({
        site: run.site,
        draftId,
        processingRunId: run.processingRunId,
        sha256: '0'.repeat(64),
        role: 'photo-display'
    });
    const suffix = `${'0'.repeat(64)}/display.webp`;
    if (!probe.endsWith(suffix)) {
        throw rehearsalError('invalid-sentinel-prefix');
    }
    return `${probe.slice(0, -suffix.length)}${sentinelLeaf}`;
}

async function deleteExactSentinel(dependencies, sentinelKey) {
    const downloaded = await dependencies.wranglerRunner(internalWranglerRequest({
        kind: 'staging-get-sentinel',
        configPath: adminConfigPath,
        bucketName: stagingBucketName,
        key: sentinelKey
    }));
    if (!(downloaded instanceof Uint8Array) || sha256(downloaded) !== sentinelSha256) {
        throw rehearsalError('sentinel-evidence-mismatch');
    }
    await dependencies.wranglerRunner(internalWranglerRequest({
        kind: 'staging-delete-sentinel',
        configPath: adminConfigPath,
        bucketName: stagingBucketName,
        key: sentinelKey,
        expectedSha256: sentinelSha256
    }));
}

function requireStatus(response, expected, label) {
    if (!(response instanceof Response) || response.status !== expected) {
        throw rehearsalError(`${label}-status-${response?.status || 'invalid'}`);
    }
}

function requireCleanupSuccess(body, processingRunId, replayed, label) {
    if (
        !hasExactKeys(body, [
            'processingRunId',
            'cleanupReason',
            'status',
            'replayed'
        ]) ||
        body.processingRunId !== processingRunId ||
        body.cleanupReason !== 'processing-failed' ||
        body.status !== 'cleaned' ||
        body.replayed !== replayed
    ) {
        throw rehearsalError(`${label}-evidence-invalid`);
    }
}

function exactRoles(actual, expected) {
    return Array.isArray(actual) &&
        Array.isArray(expected) &&
        actual.length === expected.length &&
        actual.every((role, index) => role === expected[index]);
}

function statusRecord(key) {
    const scenario = scenarioPlan.find(entry => entry.key === key);
    return Object.freeze({ scenario: scenario.label, status: 'passed' });
}

function internalWranglerRequest(fields) {
    return Object.freeze({
        ...fields,
        [internalWranglerRequestCapability]: true
    });
}

function assertExactWranglerCoordinates(request) {
    if (
        !hasExactKeys(request, ['kind', 'label', 'configPath', 'databaseName', 'sql']) ||
        request.kind !== 'd1-json' ||
        request.configPath !== adminConfigPath ||
        request.databaseName !== databaseName ||
        !/^[a-z0-9-]{1,80}$/.test(request.label || '')
    ) {
        throw rehearsalError('invalid-wrangler-coordinates');
    }
}

function assertAllowedD1Query(request) {
    if (typeof request.sql !== 'string' || request.sql.length > 32 * 1024) {
        throw rehearsalError('invalid-d1-query');
    }
    let expected;
    if (request.label === 'discover-fixture') {
        expected = discoverFixtureSql();
    } else if (request.label === 'retry-index-preflight') {
        expected = retryIndexPreflightSql();
    } else if (request.label === 'retry-duplicates-preflight') {
        expected = retryDuplicatesPreflightSql();
    } else if ([
        'recovery-a-before-retry',
        'recovery-a-before-replay',
        'recovery-a-after-replay'
    ].includes(request.label)) {
        expected = scenarioARecoverySnapshotSql(
            extractOnlyDraftId(request.sql),
            extractOnlyRunId(request.sql)
        );
    } else if (request.label === 'recovery-d-history') {
        expected = scenarioDHistorySql(extractOnlyDraftId(request.sql));
    } else if (request.label === 'recovery-d-object') {
        expected = scenarioDObjectSql(extractOnlyDraftId(request.sql));
    } else if ([
        'recovery-d-before-retry',
        'recovery-d-before-replay',
        'recovery-d-after-replay'
    ].includes(request.label)) {
        expected = scenarioDTerminalSql(extractOnlyDraftId(request.sql));
    } else if (
        request.label === 'boundary-before' ||
        request.label === 'boundary-after'
    ) {
        expected = boundarySnapshotSql();
    } else if (
        request.label === 'cleaned-run-evidence' ||
        request.label === 'prefix-refusal-evidence'
    ) {
        expected = cleanedRunEvidenceSql(extractOnlyRunId(request.sql));
    } else if (request.label === 'final-staged-evidence') {
        expected = finalStagedEvidenceSql(extractOnlyRunId(request.sql));
    } else if (request.label === 'foreign-key-check') {
        expected = 'PRAGMA foreign_key_check;';
    } else {
        throw rehearsalError('invalid-d1-query');
    }
    if (request.sql !== expected) {
        throw rehearsalError('invalid-d1-query');
    }
}

function extractOnlyRunId(sql) {
    const matches = sql.match(
        /run_[a-f0-9]{12}4[a-f0-9]{3}[89ab][a-f0-9]{15}/g
    ) || [];
    const unique = [...new Set(matches)];
    if (unique.length !== 1 || !runIdPattern.test(unique[0])) {
        throw rehearsalError('invalid-d1-query');
    }
    return unique[0];
}

function extractOnlyDraftId(sql) {
    const matches = sql.match(
        /draft_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}/g
    ) || [];
    const unique = [...new Set(matches)];
    if (unique.length !== 1 || !draftIdPattern.test(unique[0])) {
        throw rehearsalError('invalid-d1-query');
    }
    return unique[0];
}

function assertExactRecoveryStagingRequest(request) {
    const parsed = parseV1StagingDerivativeKey(request.key);
    if (
        !hasExactKeys(request, [
            'kind',
            'configPath',
            'bucketName',
            'key',
            'draftId',
            'processingRunId',
            'sha256',
            'byteLength'
        ]) ||
        request.kind !== 'staging-get-recovery-object' ||
        request.configPath !== adminConfigPath ||
        request.bucketName !== stagingBucketName ||
        !draftIdPattern.test(request.draftId || '') ||
        !runIdPattern.test(request.processingRunId || '') ||
        !sha256Pattern.test(request.sha256 || '') ||
        !Number.isSafeInteger(request.byteLength) ||
        request.byteLength < 1 ||
        request.byteLength > 26_214_400 ||
        parsed?.site !== 'family' ||
        parsed?.draftId !== request.draftId ||
        parsed?.processingRunId !== request.processingRunId ||
        parsed?.sha256 !== request.sha256 ||
        parsed?.role !== 'photo-display' ||
        buildV1StagingDerivativeKey({
            site: parsed.site,
            draftId: parsed.draftId,
            processingRunId: parsed.processingRunId,
            sha256: parsed.sha256,
            role: parsed.role
        }) !== request.key
    ) {
        throw rehearsalError('invalid-recovery-staging-request');
    }
}

function assertExactSentinelRequest(request) {
    const expectedKeys = request.kind === 'staging-put-sentinel'
        ? ['kind', 'configPath', 'bucketName', 'key', 'bytes', 'sha256']
        : request.kind === 'staging-delete-sentinel'
            ? ['kind', 'configPath', 'bucketName', 'key', 'expectedSha256']
            : ['kind', 'configPath', 'bucketName', 'key'];
    if (
        !['staging-put-sentinel', 'staging-get-sentinel', 'staging-delete-sentinel']
            .includes(request.kind) ||
        !hasExactKeys(request, expectedKeys) ||
        request.configPath !== adminConfigPath ||
        request.bucketName !== stagingBucketName ||
        !isExactSentinelKey(request.key)
    ) {
        throw rehearsalError('invalid-sentinel-request');
    }
}

function isExactSentinelKey(key) {
    const pattern = new RegExp(
        '^derivative-staging/v1/(?:family|everyone)/' +
        'draft_[a-f0-9-]{36}/run_[a-f0-9]{32}/' +
        sentinelLeaf.replaceAll('.', '\\.') + '$'
    );
    return typeof key === 'string' && pattern.test(key);
}

async function spawnWrangler(entrypoint, args, stdinBytes, spawnImpl = spawn) {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawnImpl(process.execPath, [entrypoint, ...args], {
                cwd: repositoryRoot,
                windowsHide: true,
                shell: false,
                stdio: ['pipe', 'pipe', 'pipe']
            });
        } catch {
            reject(rehearsalError('wrangler-launch-failed'));
            return;
        }
        const stdout = [];
        const stderr = [];
        let settled = false;
        let timedOut = false;
        let timeoutHandle;
        let forceKillHandle;
        const clearTimers = () => {
            clearTimeout(timeoutHandle);
            clearTimeout(forceKillHandle);
        };
        const fail = error => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimers();
            reject(error);
        };
        const succeed = value => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimers();
            resolve(value);
        };
        child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
        child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
        child.on('error', () => fail(rehearsalError(
            timedOut ? 'wrangler-command-timeout' : 'wrangler-launch-failed'
        )));
        child.on('close', code => {
            if (timedOut) {
                fail(rehearsalError('wrangler-command-timeout'));
                return;
            }
            if (code !== 0) {
                fail(rehearsalError('wrangler-command-failed'));
                return;
            }
            succeed(Object.freeze({
                stdout: Buffer.concat(stdout),
                stderrByteLength: Buffer.concat(stderr).byteLength
            }));
        });
        timeoutHandle = setTimeout(() => {
            timedOut = true;
            try {
                child.kill();
            } catch {
                // Only the fixed redacted timeout code is surfaced.
            }
            if (settled) {
                return;
            }
            forceKillHandle = setTimeout(() => {
                try {
                    child.kill('SIGKILL');
                } catch {
                    // Only the fixed redacted timeout code is surfaced.
                }
                fail(rehearsalError('wrangler-command-timeout'));
            }, wranglerKillGraceMs);
        }, wranglerCommandTimeoutMs);
        try {
            if (stdinBytes instanceof Uint8Array) {
                child.stdin.end(stdinBytes);
            } else {
                child.stdin.end();
            }
        } catch {
            fail(rehearsalError('wrangler-command-failed'));
        }
    });
}

function parseD1Rows(stdout) {
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(stdout).toString('utf8'));
    } catch {
        throw rehearsalError('wrangler-json-invalid');
    }
    if (
        !Array.isArray(parsed) ||
        parsed.length !== 1 ||
        parsed[0]?.success !== true ||
        !Array.isArray(parsed[0].results) ||
        parsed[0].results.some(row => !isPlainObject(row))
    ) {
        throw rehearsalError('wrangler-json-invalid');
    }
    return parsed[0].results;
}

function exactSqlLiteral(value, pattern, label) {
    if (typeof value !== 'string' || !pattern.test(value)) {
        throw rehearsalError(`invalid-${label.replaceAll(' ', '-')}`);
    }
    return `'${value}'`;
}

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

function sha256Text(value) {
    return sha256(Buffer.from(value, 'utf8'));
}

function nonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
}

function hasExactKeys(value, keys) {
    if (!isPlainObject(value)) {
        return false;
    }
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length &&
        actual.every((key, index) => key === expected[index]);
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function rehearsalError(code) {
    const error = new Error(`Gallery Phase D remote rehearsal stopped: ${code}.`);
    error.name = 'GalleryPhaseDRemoteRehearsalError';
    return error;
}
