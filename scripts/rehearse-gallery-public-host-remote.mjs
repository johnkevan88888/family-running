import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const adminConfigPath = 'gallery-admin/wrangler.admin.local.jsonc';
const databaseName = 'family-running-gallery-dev';
const verifierWorkerName = 'family-running-gallery-public-host-verifier-dev';
const mediaWorkerName = 'family-running-gallery-media-dev';
const approvedMediaBucketName = 'family-running-gallery-approved-dev';
const verifierOrigin =
    'https://family-running-gallery-public-host-verifier-dev.family-running.workers.dev';
const verifierVersion = '6ba9af24-6123-480b-8e6f-980a742348dc';
const mediaOrigin =
    'https://family-running-gallery-media-dev.family-running.workers.dev';
const mediaVersion = 'cf327eb6-6ba6-46e4-a5da-8e3f541afb8e';
const mediaContract = 'approved-media-v1';
const epochId = 'media_delivery_epoch_dev_0001';
const epochIdHash =
    '6b26d6226b5f78a4e8da0e478b3708accc6e1163b0a1952ace23110e112a05e3';
const epochConfigurationHash =
    '01dd06bfa9f40cc82b0989bec1d7a30cc92c3462dea4e041cf287b7d4fcace08';
const approvedOriginHash =
    '3f67888be09246609c86995b5a2645037c8dfac8fb95f15cc25bbcd5b72f5942';
const deliveryContractHash =
    '31a74085d717759998ba73b59971f5a52173b42a8e97d525a3bc65b78cf9ba87';
const deliveryVersionHash =
    '3cc5883c44ae2f0c1a851ee7168160db9d70dceabd5bb4cf59515e9f38ba8b4a';
const witnessObjectKeyHash =
    'edd5105c5059232525fe64632d96dbbd167630a56db12aac64ef48275753896b';
const witnessKey =
    'media/v1/54bdb34ea423475fe0544cacbf32ab4f7e75846b5f25f1296e9bb2d157cd9f77/display.webp';
const witnessSha256 =
    '54bdb34ea423475fe0544cacbf32ab4f7e75846b5f25f1296e9bb2d157cd9f77';
const witnessByteCount = 28;
const witnessContentType = 'image/webp';
const draftId = 'draft_7ad3a4d4-9b37-4f49-8e94-b5e254417c38';
const accessControlDraftId = 'draft_5f74580e-3224-4d93-89f8-18378f4dcb8a';
const draftIdHash =
    'e60923d2acf7fa6cf1c442cfe064e00bd70bf3c2b09a5c7f3adff5f49f4fe8d5';
const publicItemId = 'synthetic-public-host-rehearsal-0001';
const idempotencyKey = 'public-host-remote-rehearsal-0001';
const idempotencyKeyHash =
    '1d2572925099f00ac9f98fe9b3b7915a078d75f03a8e883926822b3187e4a693';
const ownerIdentityHash =
    '6aada308af25d06b2ff0158a38297a078bd371a72f612db7a18c6f49a5a6f061';
const withdrawalCycleHash =
    '54a2609d66e420a0655257c866eda5cd1804290fe89999130be94e749e2b8240';
const retentionActorHash =
    '69440871111849a21b4252a00fd94364b58f667ed652d7bf700a92613c0e125a';
const retentionEvidenceHash =
    '9a7bad515451128d99de9548ceaba3a57292fb2308c6708850bfffb24092bfa4';
const emptySha256 =
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const accessClientIdPattern = /^[0-9a-f]{32}\.access$/;
const accessSecretPattern = /^[A-Za-z0-9_-]{32,256}$/;
const verificationIdPattern = /^hostverify_[a-f0-9]{32}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const commandTimeoutMs = 60_000;
const requestTimeoutMs = 30_000;
const killGraceMs = 2_000;
const internalRunnerCapability = Symbol('gallery-public-host-remote-rehearsal');

const exactOptionKeys = Object.freeze([
    'bookmarkSink', 'boundaryReader', 'd1Runner', 'fetchImpl', 'serviceToken'
]);

export const galleryPublicHostRemoteRehearsalContract = Object.freeze({
    adminConfigPath,
    databaseName,
    verifierWorkerName,
    mediaWorkerName,
    approvedMediaBucketName,
    verifierOrigin,
    verifierVersion,
    mediaOrigin,
    mediaVersion,
    mediaContract,
    epochId,
    epochIdHash,
    epochConfigurationHash,
    approvedOriginHash,
    deliveryContractHash,
    deliveryVersionHash,
    witnessObjectKeyHash,
    witnessKey,
    witnessSha256,
    witnessByteCount,
    witnessContentType,
    withdrawalCycleHash,
    fixture: Object.freeze({
        draftId,
        accessControlDraftId,
        publicItemId,
        idempotencyKey,
        site: 'family',
        athleteIds: Object.freeze([]),
        withdrawalKind: 'editorial-removal',
        purgeKind: 'retention-expiry'
    })
});

export const galleryPublicHostRemoteRehearsalSql = Object.freeze({
    snapshot: fixtureSnapshotSql(),
    snapshotCore: fixtureSnapshotCoreSql(),
    snapshotEvidence: fixtureSnapshotEvidenceSql(),
    seed: seedFixtureSql(),
    guardScalar: guardScalarSql(),
    guardWithdrawal: guardWithdrawalSql(),
    guardPurge: purgeSql(),
    transitionWithdrawn: transitionWithdrawnSql(),
    insertTombstone: insertTombstoneSql(),
    confirmPrivateOriginalDeletion: confirmPrivateOriginalDeletionSql(),
    purge: purgeSql(),
    integrity: integritySql()
});

export const galleryPublicHostRemoteRehearsalTestHooks = Object.freeze({
    mergeSnapshotParts,
    parseD1Results
});

export async function runGalleryPublicHostRemoteRehearsal(options) {
    const dependencies = validateOptions(options);
    const beforeBoundary = await readBoundary(
        dependencies.boundaryReader,
        'before',
        dependencies.serviceToken.clientId
    );
    const beforeBookmark = await runD1(
        dependencies.d1Runner,
        'bookmark-before',
        'bookmark'
    );
    requireBookmark(beforeBookmark, 'bookmark-before');
    await persistBookmark(dependencies.bookmarkSink, 'before', beforeBookmark);

    let snapshot = assertSnapshot(await readSnapshot(dependencies.d1Runner));
    assertRemoteBoundary(snapshot);
    let phase = classifyPhase(snapshot);
    const initialPhase = phase;
    assertIntegrity(await runD1(
        dependencies.d1Runner,
        'integrity-before',
        'read',
        integritySql()
    ));
    assertPhaseSnapshot(snapshot, phase);

    await assertAccessFailure(dependencies.fetchImpl, null, 'no-credential');
    await assertAccessFailure(
        dependencies.fetchImpl,
        wrongServiceToken(dependencies.serviceToken),
        'wrong-credential'
    );
    await assertCredentialedMethodControl(
        dependencies.fetchImpl,
        dependencies.serviceToken
    );
    assertSnapshotsEqual(
        snapshot,
        assertSnapshot(await readSnapshot(dependencies.d1Runner)),
        'access-controls-mutated-state'
    );

    if (phase === 'complete') {
        assertCompleteSnapshot(snapshot);
        assertIntegrity(await runD1(
            dependencies.d1Runner,
            'integrity-after',
            'read',
            integritySql()
        ));
        const afterBoundary = await readBoundary(
            dependencies.boundaryReader,
            'after',
            dependencies.serviceToken.clientId
        );
        assertBoundariesEqual(beforeBoundary, afterBoundary);
        const afterBookmark = await runD1(
            dependencies.d1Runner,
            'bookmark-after',
            'bookmark'
        );
        requireBookmark(afterBookmark, 'bookmark-after');
        await persistBookmark(dependencies.bookmarkSink, 'after', afterBookmark);
        return successSummary(initialPhase);
    }

    if (phase === 'fresh') {
        await runD1(dependencies.d1Runner, 'seed-fixture', 'write', seedFixtureSql());
        snapshot = assertSnapshot(await readSnapshot(dependencies.d1Runner));
        assertSeededSnapshot(snapshot);

        await expectGuardFailure(
            dependencies.d1Runner,
            'guard-scalar-before-receipt',
            guardScalarSql(),
            'host deletion confirmation requires a current complete receipt'
        );
        await expectGuardFailure(
            dependencies.d1Runner,
            'guard-withdrawal-before-receipt',
            guardWithdrawalSql(),
            'current complete public-host absence receipt is required'
        );
        await expectGuardFailure(
            dependencies.d1Runner,
            'guard-purge-before-receipt',
            purgeSql(),
            'gallery draft purge requires current public-host absence evidence'
        );
        assertSnapshotsEqual(
            snapshot,
            assertSnapshot(await readSnapshot(dependencies.d1Runner)),
            'guard-failure-mutated-state'
        );

        const stale = await verifierPost(
            dependencies.fetchImpl,
            dependencies.serviceToken,
            0,
            `${idempotencyKey}-stale`
        );
        requireFailureResponse(stale, 409, 'state-or-generation-drift', 'stale-post');
        assertSnapshotsEqual(
            snapshot,
            assertSnapshot(await readSnapshot(dependencies.d1Runner)),
            'stale-post-mutated-state'
        );
        phase = 'seeded';
    }

    if (phase === 'seeded' || phase === 'verification-pending') {
        const created = await postWithLostResponseRecovery(dependencies);
        snapshot = assertSnapshot(await readSnapshot(dependencies.d1Runner));
        assertVerifiedSnapshot(snapshot);
        assertResponseMatchesSnapshot(created, snapshot, 'verification-create');
        phase = 'verified';
    }

    if (phase === 'verified') {
        const beforeReplay = snapshot;
        const replay = await verifierPost(
            dependencies.fetchImpl,
            dependencies.serviceToken,
            1,
            idempotencyKey
        );
        requireSuccessResponse(replay, 200, true, 'verification-replay');
        snapshot = assertSnapshot(await readSnapshot(dependencies.d1Runner));
        assertSnapshotsEqual(beforeReplay, snapshot, 'verification-replay-mutated-state');
        assertResponseMatchesSnapshot(replay, snapshot, 'verification-replay');

        requireSingleChange(await runD1(
            dependencies.d1Runner,
            'transition-withdrawn',
            'write',
            transitionWithdrawnSql()
        ), 'transition-withdrawn');
        snapshot = assertSnapshot(await readSnapshot(dependencies.d1Runner));
        assertWithdrawnSnapshot(snapshot);
        phase = 'withdrawn';
    }

    if (phase === 'withdrawn') {
        await expectGuardFailure(
            dependencies.d1Runner,
            'guard-purge-before-tombstone',
            purgeSql(),
            'gallery draft purge requires current public-host absence evidence'
        );
        requireSingleChange(await runD1(
            dependencies.d1Runner,
            'insert-retention-tombstone',
            'write',
            insertTombstoneSql()
        ), 'insert-retention-tombstone');
        snapshot = assertSnapshot(await readSnapshot(dependencies.d1Runner));
        assertTombstonedSnapshot(snapshot);
        phase = 'tombstoned';
    }

    if (phase === 'tombstoned') {
        await expectGuardFailure(
            dependencies.d1Runner,
            'guard-purge-before-private-original-proof',
            purgeSql(),
            'gallery draft purge requires current public-host absence evidence'
        );
        requireSingleChange(await runD1(
            dependencies.d1Runner,
            'confirm-private-original-deletion',
            'write',
            confirmPrivateOriginalDeletionSql()
        ), 'confirm-private-original-deletion');
        snapshot = assertSnapshot(await readSnapshot(dependencies.d1Runner));
        assertPurgeReadySnapshot(snapshot);
        phase = 'purge-ready';
    }

    if (phase === 'purge-ready') {
        requireSingleChange(await runD1(
            dependencies.d1Runner,
            'purge-fixture',
            'write',
            purgeSql()
        ), 'purge-fixture');
        snapshot = assertSnapshot(await readSnapshot(dependencies.d1Runner));
        assertCompleteSnapshot(snapshot);
    }

    const integrity = await runD1(
        dependencies.d1Runner,
        'integrity-after',
        'read',
        integritySql()
    );
    assertIntegrity(integrity);
    const afterBoundary = await readBoundary(
        dependencies.boundaryReader,
        'after',
        dependencies.serviceToken.clientId
    );
    assertBoundariesEqual(beforeBoundary, afterBoundary);
    const afterBookmark = await runD1(
        dependencies.d1Runner,
        'bookmark-after',
        'bookmark'
    );
    requireBookmark(afterBookmark, 'bookmark-after');
    await persistBookmark(dependencies.bookmarkSink, 'after', afterBookmark);
    return successSummary(initialPhase);
}

export function createGalleryPublicHostWranglerRunner() {
    const wranglerEntrypoint = path.join(
        repositoryRoot,
        'node_modules',
        'wrangler',
        'bin',
        'wrangler.js'
    );
    return async request => {
        assertRunnerRequest(request);
        if (request.kind === 'bookmark') {
            const result = await spawnWrangler(wranglerEntrypoint, [
                'd1', 'time-travel', 'info', databaseName,
                '--config', adminConfigPath,
                '--json'
            ]);
            return parseBookmark(result.stdout);
        }
        const args = [
            'd1', 'execute', databaseName,
            '--remote',
            '--config', adminConfigPath,
            '--command', request.sql,
            '--json'
        ];
        if (request.kind === 'expect-failure') {
            const result = await spawnWrangler(wranglerEntrypoint, args, true);
            if (
                result.exitCode === 0 ||
                !result.stderrText.includes(request.expectedError)
            ) throw rehearsalError(`${request.label}-guard-not-observed`);
            return Object.freeze({ expectedFailure: true, rowsWritten: 0 });
        }
        const result = await spawnWrangler(wranglerEntrypoint, args);
        return parseD1Results(result.stdout, request.kind);
    };
}

export function runGalleryPublicHostRemoteRehearsalWithLocalDefaults(options) {
    if (
        !isPlainObject(options) ||
        !hasExactKeys(options, ['bookmarkSink', 'boundaryReader', 'serviceToken']) ||
        typeof options.bookmarkSink !== 'function' ||
        typeof options.boundaryReader !== 'function'
    ) throw rehearsalError('invalid-local-options');
    return runGalleryPublicHostRemoteRehearsal({
        serviceToken: options.serviceToken,
        bookmarkSink: options.bookmarkSink,
        boundaryReader: options.boundaryReader,
        fetchImpl: globalThis.fetch,
        d1Runner: createGalleryPublicHostWranglerRunner()
    });
}

function validateOptions(options) {
    if (
        !isPlainObject(options) ||
        !hasExactKeys(options, exactOptionKeys) ||
        typeof options.bookmarkSink !== 'function' ||
        typeof options.boundaryReader !== 'function' ||
        typeof options.fetchImpl !== 'function' ||
        typeof options.d1Runner !== 'function' ||
        !validServiceToken(options.serviceToken)
    ) throw rehearsalError('invalid-options');
    return Object.freeze({ ...options });
}

function validServiceToken(value) {
    return isPlainObject(value) &&
        hasExactKeys(value, ['clientId', 'clientSecret']) &&
        accessClientIdPattern.test(value.clientId || '') &&
        accessSecretPattern.test(value.clientSecret || '');
}

function wrongServiceToken(token) {
    const first = token.clientSecret[0] === 'A' ? 'B' : 'A';
    return Object.freeze({
        clientId: token.clientId,
        clientSecret: `${first}${token.clientSecret.slice(1)}`
    });
}

async function assertAccessFailure(fetchImpl, token, label) {
    const response = await verifierPost(
        fetchImpl,
        token,
        1,
        `${idempotencyKey}-${label}`,
        true,
        accessControlDraftId
    );
    if (
        response.status !== 401 ||
        response.url !== verificationUrl(accessControlDraftId) ||
        response.redirected !== false ||
        response.headers.get('Location') !== null
    ) throw rehearsalError(`${label}-access-boundary-invalid`);
}

async function assertCredentialedMethodControl(fetchImpl, serviceToken) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    const url = verificationUrl(accessControlDraftId);
    let response;
    try {
        response = await fetchImpl(url, {
            method: 'GET',
            headers: new Headers({
                'CF-Access-Client-Id': serviceToken.clientId,
                'CF-Access-Client-Secret': serviceToken.clientSecret
            }),
            redirect: 'manual',
            cache: 'no-store',
            credentials: 'omit',
            signal: controller.signal
        });
    } finally {
        clearTimeout(timeout);
    }
    if (
        response.status !== 405 ||
        response.url !== url ||
        response.redirected !== false ||
        response.headers.get('Location') !== null ||
        response.headers.get('Cache-Control') !== 'no-store' ||
        response.headers.get('Allow') !== 'POST' ||
        !/^application\/json(?:;|$)/i.test(response.headers.get('Content-Type') || '')
    ) throw rehearsalError('credentialed-method-control-invalid');
    let body;
    try {
        body = await response.json();
    } catch {
        throw rehearsalError('credentialed-method-control-json-invalid');
    }
    if (
        !isPlainObject(body) ||
        !hasExactKeys(body, ['error']) ||
        body.error !== 'method-not-allowed'
    ) throw rehearsalError('credentialed-method-control-body-invalid');
}

async function postWithLostResponseRecovery(dependencies) {
    try {
        const response = await verifierPost(
            dependencies.fetchImpl,
            dependencies.serviceToken,
            1,
            idempotencyKey
        );
        requireCreateOrReplayResponse(response, 'verification-create');
        return response;
    } catch (error) {
        if (error?.name === 'GalleryPublicHostRemoteRehearsalError') throw error;
        const snapshot = assertSnapshot(await readSnapshot(dependencies.d1Runner));
        if (!['seeded', 'verification-pending', 'verified'].includes(classifyPhase(snapshot))) {
            throw rehearsalError('lost-response-state-unreconciled');
        }
        const replay = await verifierPost(
            dependencies.fetchImpl,
            dependencies.serviceToken,
            1,
            idempotencyKey
        );
        requireCreateOrReplayResponse(replay, 'lost-response-retry');
        return replay;
    }
}

async function verifierPost(
    fetchImpl,
    serviceToken,
    expectedStateVersion,
    requestIdempotencyKey,
    accessOnly = false,
    targetDraftId = draftId
) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (serviceToken) {
        headers.set('CF-Access-Client-Id', serviceToken.clientId);
        headers.set('CF-Access-Client-Secret', serviceToken.clientSecret);
    }
    let response;
    try {
        response = await fetchImpl(verificationUrl(targetDraftId), {
            method: 'POST',
            headers,
            body: JSON.stringify({ expectedStateVersion, idempotencyKey: requestIdempotencyKey }),
            redirect: 'manual',
            cache: 'no-store',
            credentials: 'omit',
            signal: controller.signal
        });
    } finally {
        clearTimeout(timeout);
    }
    if (accessOnly) return response;
    if (
        response.url !== verificationUrl() ||
        response.redirected !== false ||
        response.headers.get('Location') !== null ||
        response.headers.get('Cache-Control') !== 'no-store' ||
        !/^application\/json(?:;|$)/i.test(response.headers.get('Content-Type') || '')
    ) throw rehearsalError('verifier-response-envelope-invalid');
    let body;
    try {
        body = await response.json();
    } catch {
        throw rehearsalError('verifier-response-json-invalid');
    }
    return Object.freeze({
        status: response.status,
        url: response.url,
        redirected: response.redirected,
        headers: response.headers,
        body
    });
}

function requireCreateOrReplayResponse(response, label) {
    if (response.status === 201) {
        requireSuccessResponse(response, 201, false, label);
        return;
    }
    if (response.status === 200) {
        requireSuccessResponse(response, 200, true, label);
        return;
    }
    throw rehearsalError(`${label}-invalid`);
}

function requireSuccessResponse(response, status, replayed, label) {
    if (
        response.status !== status ||
        !isPlainObject(response.body) ||
        !hasExactKeys(response.body, [
            'verificationId', 'hostDeletionConfirmed', 'replayed'
        ]) ||
        !verificationIdPattern.test(response.body.verificationId || '') ||
        response.body.hostDeletionConfirmed !== true ||
        response.body.replayed !== replayed
    ) throw rehearsalError(`${label}-invalid`);
}

function requireFailureResponse(response, status, code, label) {
    if (
        response.status !== status ||
        !isPlainObject(response.body) ||
        !hasExactKeys(response.body, ['error']) ||
        response.body.error !== code
    ) throw rehearsalError(`${label}-invalid`);
}

function verificationUrl(targetDraftId = draftId) {
    return `${verifierOrigin}/api/service/drafts/${targetDraftId}/public-host-absence-verifications`;
}

async function readSnapshot(d1Runner) {
    const parts = await runD1(
        d1Runner,
        'fixture-snapshot',
        'snapshot',
        fixtureSnapshotSql()
    );
    return mergeSnapshotParts(parts);
}

async function expectGuardFailure(d1Runner, label, sql, expectedError) {
    const result = await runD1(
        d1Runner,
        label,
        'expect-failure',
        sql,
        expectedError
    );
    if (result?.expectedFailure !== true || result?.rowsWritten !== 0) {
        throw rehearsalError(`${label}-invalid`);
    }
}

function runD1(d1Runner, label, kind, sql, expectedError) {
    return d1Runner(Object.freeze({
        label,
        kind,
        ...(sql === undefined ? {} : { sql }),
        ...(expectedError === undefined ? {} : { expectedError }),
        [internalRunnerCapability]: true
    }));
}

function assertRunnerRequest(request) {
    if (!isPlainObject(request) || request[internalRunnerCapability] !== true) {
        throw rehearsalError('invalid-runner-capability');
    }
    const expected = allowedRunnerRequest(request.label);
    if (
        !expected ||
        request.kind !== expected.kind ||
        (expected.sql !== undefined && request.sql !== expected.sql) ||
        (expected.expectedError !== undefined &&
            request.expectedError !== expected.expectedError)
    ) throw rehearsalError('invalid-runner-request');
}

function allowedRunnerRequest(label) {
    const requests = {
        'bookmark-before': { kind: 'bookmark' },
        'bookmark-after': { kind: 'bookmark' },
        'fixture-snapshot': { kind: 'snapshot', sql: fixtureSnapshotSql() },
        'seed-fixture': { kind: 'write', sql: seedFixtureSql() },
        'guard-scalar-before-receipt': {
            kind: 'expect-failure',
            sql: guardScalarSql(),
            expectedError: 'host deletion confirmation requires a current complete receipt'
        },
        'guard-withdrawal-before-receipt': {
            kind: 'expect-failure',
            sql: guardWithdrawalSql(),
            expectedError: 'current complete public-host absence receipt is required'
        },
        'guard-purge-before-receipt': {
            kind: 'expect-failure',
            sql: purgeSql(),
            expectedError: 'gallery draft purge requires current public-host absence evidence'
        },
        'transition-withdrawn': { kind: 'write', sql: transitionWithdrawnSql() },
        'guard-purge-before-tombstone': {
            kind: 'expect-failure',
            sql: purgeSql(),
            expectedError: 'gallery draft purge requires current public-host absence evidence'
        },
        'insert-retention-tombstone': { kind: 'write', sql: insertTombstoneSql() },
        'guard-purge-before-private-original-proof': {
            kind: 'expect-failure',
            sql: purgeSql(),
            expectedError: 'gallery draft purge requires current public-host absence evidence'
        },
        'confirm-private-original-deletion': {
            kind: 'write',
            sql: confirmPrivateOriginalDeletionSql()
        },
        'purge-fixture': { kind: 'write', sql: purgeSql() },
        'integrity-before': { kind: 'read', sql: integritySql() },
        'integrity-after': { kind: 'read', sql: integritySql() }
    };
    return requests[label] || null;
}

function mergeSnapshotParts(parts) {
    if (
        !Array.isArray(parts) || parts.length !== 2 ||
        parts.some(part =>
            !Array.isArray(part) || part.length !== 1 || !isPlainObject(part[0])
        )
    ) throw rehearsalError('snapshot-parts-invalid');
    const [core, evidence] = parts.map(part => part[0]);
    if (Object.keys(core).some(key => Object.hasOwn(evidence, key))) {
        throw rehearsalError('snapshot-key-collision');
    }
    if (!hasExactKeys(core, snapshotCoreKeys())) {
        throw rehearsalError('snapshot-core-shape-invalid');
    }
    if (!hasExactKeys(evidence, snapshotEvidenceKeys())) {
        throw rehearsalError('snapshot-evidence-shape-invalid');
    }
    const merged = { ...core, ...evidence };
    if (!hasExactKeys(merged, snapshotKeys())) {
        throw rehearsalError('snapshot-shape-invalid');
    }
    return Object.freeze([Object.freeze(merged)]);
}

function snapshotCoreKeys() {
    return [
        'epochCount', 'activationCount', 'currentEpochCount', 'epochSequence',
        'epochId', 'epochIdHash', 'configurationHash', 'approvedOrigin',
        'approvedOriginHash', 'deliveryContractHash', 'deliveryVersionHash',
        'witnessObjectKeyHash', 'epochWitnessSha256', 'epochWitnessByteCount',
        'epochWitnessContentType', 'accessControlDraftCount',
        'draftCount', 'publicItemCount', 'draftPublicItemId',
        'draftSiteModesJson', 'draftExportBundleId', 'draftSourceRevision',
        'draftSuppressionRevision', 'draftItemRevision', 'draftMediaType',
        'draftRaceDate', 'draftRaceEvent', 'draftRaceDistance',
        'draftAthleteIdsJson', 'draftTitle', 'draftCaption', 'draftAltText',
        'draftFeatured', 'draftOwnerIdentityHash', 'draftCreatedAt',
        'draftState', 'draftStateVersion', 'draftUpdatedAt',
        'activeConsentRevision', 'originalObjectKey', 'originalDetectedType',
        'originalByteCount', 'originalSha256', 'uploadComplete',
        'processingDiagnosticsJson', 'consentAttestationCount',
        'uploadSessionCount', 'derivativeCount',
        'processingRunCount', 'processingCleanupCount', 'photoPromotionCount',
        'photoPromotionCleanupCount'
    ];
}

function snapshotEvidenceKeys() {
    return [
        'publicationCount', 'withdrawalKind', 'hostDeletionConfirmed',
        'privateOriginalDeletionConfirmed', 'publicationUpdatedAt', 'tombstoneCount',
        'tombstonePurgeKind', 'tombstoneEligibleAt', 'tombstoneApprovedAt',
        'tombstoneActorHash', 'tombstoneEvidenceHash',
        'verificationCount', 'verificationId', 'witnessProofCount', 'targetProofCount',
        'reservationCount', 'receiptCount', 'completeReceiptCount',
        'currentReceiptCount', 'generationCount', 'generationTargetCount',
        'receiptFinalHash', 'receiptVerificationIdHash', 'receiptDraftIdHash',
        'receiptPromotionSetHash', 'receiptCleanupSetHash',
        'receiptWithdrawalCycleHash', 'receiptApprovedOriginHash',
        'receiptTargetSetHash', 'receiptGenerationCount', 'receiptTargetCount',
        'receiptStateVersion', 'receiptPurpose', 'receiptPurposeEvidenceHash',
        'receiptEpochIdHash', 'receiptDeliveryContractHash',
        'receiptDeliveryVersionHash', 'receiptIdempotencyKeyHash',
        'receiptPayloadFingerprint', 'receiptVerifiedAt',
        'receiptPurposeWithdrawalCount', 'receiptEmptyHashCount',
        'forbiddenReceiptColumnCount', 'globalVerificationCount',
        'globalWitnessProofCount', 'globalTargetProofCount',
        'globalReservationCount', 'globalReceiptCount', 'globalGenerationCount',
        'globalGenerationTargetCount', 'globalTrueHostScalarCount',
        'globalTombstoneCount'
    ];
}

function snapshotKeys() {
    return [...snapshotCoreKeys(), ...snapshotEvidenceKeys()];
}

function assertSnapshot(result) {
    if (!Array.isArray(result) || result.length !== 1 || !isPlainObject(result[0])) {
        throw rehearsalError('snapshot-invalid');
    }
    const row = result[0];
    if (!hasExactKeys(row, snapshotKeys())) throw rehearsalError('snapshot-shape-invalid');
    return Object.freeze({ ...row });
}

function assertRemoteBoundary(row) {
    if (
        row.epochCount !== 1 ||
        row.activationCount !== 1 ||
        row.currentEpochCount !== 1 ||
        row.epochSequence !== 1 ||
        row.epochId !== epochId ||
        row.epochIdHash !== epochIdHash ||
        row.configurationHash !== epochConfigurationHash ||
        row.approvedOrigin !== mediaOrigin ||
        row.approvedOriginHash !== approvedOriginHash ||
        row.deliveryContractHash !== deliveryContractHash ||
        row.deliveryVersionHash !== deliveryVersionHash ||
        row.witnessObjectKeyHash !== witnessObjectKeyHash ||
        row.epochWitnessSha256 !== witnessSha256 ||
        row.epochWitnessByteCount !== witnessByteCount ||
        row.epochWitnessContentType !== witnessContentType ||
        row.accessControlDraftCount !== 0 ||
        row.forbiddenReceiptColumnCount !== 0 ||
        row.globalGenerationCount !== 0 ||
        row.globalGenerationTargetCount !== 0 ||
        row.globalTargetProofCount !== 0 ||
        row.globalReservationCount !== 0 ||
        row.globalVerificationCount !== row.verificationCount ||
        row.globalWitnessProofCount !== row.witnessProofCount ||
        row.globalReceiptCount !== row.receiptCount ||
        row.globalTrueHostScalarCount !== (row.hostDeletionConfirmed || 0) ||
        row.globalTombstoneCount !== row.tombstoneCount
    ) throw rehearsalError('remote-boundary-drift');
    assertSyntheticFixtureIdentity(row);
    assertNoSyntheticMedia(row);
    assertVerificationAndReceipt(row);
    assertTombstone(row);
    assertChronology(row);
}

function assertSyntheticFixtureIdentity(row) {
    const fields = [
        row.draftPublicItemId,
        row.draftSiteModesJson,
        row.draftExportBundleId,
        row.draftSourceRevision,
        row.draftSuppressionRevision,
        row.draftItemRevision,
        row.draftMediaType,
        row.draftRaceDate,
        row.draftRaceEvent,
        row.draftRaceDistance,
        row.draftAthleteIdsJson,
        row.draftTitle,
        row.draftCaption,
        row.draftAltText,
        row.draftFeatured,
        row.draftOwnerIdentityHash,
        row.draftCreatedAt
    ];
    if (row.draftCount === 0) {
        if (fields.some(value => value !== null)) {
            throw rehearsalError('purged-fixture-identity-present');
        }
        return;
    }
    if (
        row.draftCount !== 1 ||
        row.draftPublicItemId !== publicItemId ||
        row.draftSiteModesJson !== '["family"]' ||
        row.draftExportBundleId !== 'synthetic-public-host-bundle-0001' ||
        row.draftSourceRevision !== 'synthetic-public-host-source-0001' ||
        row.draftSuppressionRevision !== 'synthetic-public-host-suppression-0001' ||
        row.draftItemRevision !== 'synthetic-public-host-item-0001' ||
        row.draftMediaType !== 'photo' ||
        row.draftRaceDate !== '2026-08-31' ||
        row.draftRaceEvent !== 'Synthetic verifier rehearsal' ||
        row.draftRaceDistance !== '5 km' ||
        row.draftAthleteIdsJson !== '[]' ||
        row.draftTitle !== 'Synthetic verifier rehearsal' ||
        row.draftCaption !== 'Synthetic bytes are never created.' ||
        row.draftAltText !== 'No media is attached to this synthetic verifier rehearsal.' ||
        row.draftFeatured !== 0 ||
        row.draftOwnerIdentityHash !== ownerIdentityHash ||
        row.draftCreatedAt !== '2026-08-31T18:00:00.000Z'
    ) throw rehearsalError('synthetic-fixture-identity-invalid');
}

function assertNoSyntheticMedia(row) {
    const childCounts = [
        row.consentAttestationCount,
        row.uploadSessionCount,
        row.derivativeCount,
        row.processingRunCount,
        row.processingCleanupCount,
        row.photoPromotionCount,
        row.photoPromotionCleanupCount
    ];
    if (childCounts.some(value => value !== 0)) {
        throw rehearsalError('synthetic-media-evidence-present');
    }
    const nullableFields = [
        row.activeConsentRevision,
        row.originalObjectKey,
        row.originalDetectedType,
        row.originalByteCount,
        row.originalSha256,
        row.processingDiagnosticsJson
    ];
    if (nullableFields.some(value => value !== null)) {
        throw rehearsalError('synthetic-original-evidence-present');
    }
    if (
        (row.draftCount === 1 && row.uploadComplete !== 0) ||
        (row.draftCount === 0 && row.uploadComplete !== null)
    ) throw rehearsalError('synthetic-upload-state-invalid');
}

function assertVerificationAndReceipt(row) {
    if (
        (row.verificationCount === 0 && row.verificationId !== null) ||
        (row.verificationCount === 1 &&
            !verificationIdPattern.test(row.verificationId || ''))
    ) throw rehearsalError('verification-identity-invalid');
    const receiptFields = [
        row.receiptFinalHash,
        row.receiptVerificationIdHash,
        row.receiptDraftIdHash,
        row.receiptPromotionSetHash,
        row.receiptCleanupSetHash,
        row.receiptWithdrawalCycleHash,
        row.receiptApprovedOriginHash,
        row.receiptTargetSetHash,
        row.receiptGenerationCount,
        row.receiptTargetCount,
        row.receiptStateVersion,
        row.receiptPurpose,
        row.receiptPurposeEvidenceHash,
        row.receiptEpochIdHash,
        row.receiptDeliveryContractHash,
        row.receiptDeliveryVersionHash,
        row.receiptIdempotencyKeyHash,
        row.receiptPayloadFingerprint,
        row.receiptVerifiedAt
    ];
    if (row.receiptCount === 0) {
        if (receiptFields.some(value => value !== null)) {
            throw rehearsalError('unexpected-permanent-receipt');
        }
        return;
    }
    if (
        row.receiptCount !== 1 ||
        !SHA256_PATTERN.test(row.receiptFinalHash || '') ||
        !SHA256_PATTERN.test(row.receiptVerificationIdHash || '') ||
        row.receiptDraftIdHash !== draftIdHash ||
        row.receiptPromotionSetHash !== emptySha256 ||
        row.receiptCleanupSetHash !== emptySha256 ||
        row.receiptWithdrawalCycleHash !== withdrawalCycleHash ||
        row.receiptApprovedOriginHash !== approvedOriginHash ||
        row.receiptTargetSetHash !== emptySha256 ||
        row.receiptGenerationCount !== 0 || row.receiptTargetCount !== 0 ||
        row.receiptStateVersion !== 1 || row.receiptPurpose !== 'withdrawal' ||
        row.receiptPurposeEvidenceHash !== null ||
        row.receiptEpochIdHash !== epochIdHash ||
        row.receiptDeliveryContractHash !== deliveryContractHash ||
        row.receiptDeliveryVersionHash !== deliveryVersionHash ||
        row.receiptIdempotencyKeyHash !== idempotencyKeyHash ||
        !SHA256_PATTERN.test(row.receiptPayloadFingerprint || '') ||
        !validIsoTime(row.receiptVerifiedAt)
    ) throw rehearsalError('permanent-receipt-invalid');
    const derivedVerificationId =
        `hostverify_${row.receiptPayloadFingerprint.slice(0, 32)}`;
    const derivedVerificationIdHash = createHash('sha256').update(
        `public-host-verification-id:${derivedVerificationId}`
    ).digest('hex');
    if (row.receiptVerificationIdHash !== derivedVerificationIdHash) {
        throw rehearsalError('permanent-receipt-verification-link-invalid');
    }
}

function assertTombstone(row) {
    const fields = [
        row.tombstonePurgeKind,
        row.tombstoneEligibleAt,
        row.tombstoneApprovedAt,
        row.tombstoneActorHash,
        row.tombstoneEvidenceHash
    ];
    if (row.tombstoneCount === 0) {
        if (fields.some(value => value !== null)) {
            throw rehearsalError('unexpected-retention-tombstone');
        }
        return;
    }
    if (
        row.tombstoneCount !== 1 ||
        row.tombstonePurgeKind !== 'retention-expiry' ||
        row.tombstoneActorHash !== retentionActorHash ||
        row.tombstoneEvidenceHash !== retentionEvidenceHash ||
        !validIsoTime(row.tombstoneEligibleAt) ||
        !validIsoTime(row.tombstoneApprovedAt) ||
        !(row.tombstoneEligibleAt < row.tombstoneApprovedAt)
    ) throw rehearsalError('retention-tombstone-invalid');
}

function assertChronology(row) {
    if (
        row.tombstoneCount === 1 &&
        !(row.receiptVerifiedAt < row.tombstoneEligibleAt)
    ) throw rehearsalError('receipt-tombstone-chronology-invalid');
    if (row.draftCount === 0) {
        if (
            row.publicItemCount !== 0 ||
            row.draftUpdatedAt !== null ||
            row.publicationUpdatedAt !== null
        ) throw rehearsalError('purged-parent-state-invalid');
        return;
    }
    if (
        !validIsoTime(row.draftUpdatedAt) ||
        !validIsoTime(row.publicationUpdatedAt)
    ) throw rehearsalError('fixture-chronology-invalid');
    if (
        row.draftState === 'withdrawn' &&
        (!(row.receiptVerifiedAt < row.draftUpdatedAt))
    ) throw rehearsalError('withdrawal-chronology-invalid');
    if (
        row.tombstoneCount === 1 &&
        (row.draftUpdatedAt !== row.tombstoneEligibleAt ||
            !(row.tombstoneEligibleAt < row.tombstoneApprovedAt))
    ) throw rehearsalError('tombstone-chronology-invalid');
    if (
        row.privateOriginalDeletionConfirmed === 1 &&
        (!(row.tombstoneApprovedAt < row.publicationUpdatedAt))
    ) throw rehearsalError('private-proof-chronology-invalid');
}

function validIsoTime(value) {
    return typeof value === 'string' &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
        Number.isFinite(Date.parse(value));
}

function classifyPhase(row) {
    if (
        row.draftCount === 0 && row.publicItemCount === 0 &&
        row.publicationCount === 0 &&
        row.verificationCount === 0 && row.witnessProofCount === 0 &&
        row.receiptCount === 0 && row.tombstoneCount === 0
    ) return 'fresh';
    if (
        row.draftCount === 1 && row.publicItemCount === 1 &&
        row.draftState === 'withdrawal-pending' && row.draftStateVersion === 1 &&
        row.publicationCount === 1 && row.withdrawalKind === 'editorial-removal' &&
        row.hostDeletionConfirmed === 0 &&
        row.privateOriginalDeletionConfirmed === 0 && row.tombstoneCount === 0 &&
        row.verificationCount === 0 && row.witnessProofCount === 0 &&
        row.receiptCount === 0
    ) return 'seeded';
    if (
        row.draftCount === 1 && row.draftState === 'withdrawal-pending' &&
        row.draftStateVersion === 1 && row.publicationCount === 1 &&
        row.hostDeletionConfirmed === 0 && row.tombstoneCount === 0 &&
        row.verificationCount === 1 && row.receiptCount === 0
    ) return 'verification-pending';
    if (
        row.draftCount === 1 && row.draftState === 'withdrawal-pending' &&
        row.draftStateVersion === 1 && row.hostDeletionConfirmed === 1 &&
        row.verificationCount === 1 && row.witnessProofCount === 1 &&
        row.receiptCount === 1 && row.privateOriginalDeletionConfirmed === 0 &&
        row.tombstoneCount === 0
    ) return 'verified';
    if (
        row.draftCount === 1 && row.draftState === 'withdrawn' &&
        row.draftStateVersion === 2 && row.hostDeletionConfirmed === 1 &&
        row.verificationCount === 1 && row.witnessProofCount === 1 &&
        row.receiptCount === 1 && row.privateOriginalDeletionConfirmed === 0 &&
        row.tombstoneCount === 0
    ) return 'withdrawn';
    if (
        row.draftCount === 1 && row.draftState === 'withdrawn' &&
        row.draftStateVersion === 2 && row.hostDeletionConfirmed === 1 &&
        row.verificationCount === 1 && row.witnessProofCount === 1 &&
        row.receiptCount === 1 && row.privateOriginalDeletionConfirmed === 0 &&
        row.tombstoneCount === 1
    ) return 'tombstoned';
    if (
        row.draftCount === 1 && row.draftState === 'withdrawn' &&
        row.draftStateVersion === 2 && row.hostDeletionConfirmed === 1 &&
        row.verificationCount === 1 && row.witnessProofCount === 1 &&
        row.receiptCount === 1 && row.privateOriginalDeletionConfirmed === 1 &&
        row.tombstoneCount === 1
    ) return 'purge-ready';
    if (
        row.draftCount === 0 && row.publicationCount === 0 &&
        row.verificationCount === 0 && row.witnessProofCount === 0 &&
        row.receiptCount === 1 && row.tombstoneCount === 1
    ) return 'complete';
    throw rehearsalError('fixture-state-unrecognized');
}

function assertSeededSnapshot(row) {
    assertRemoteBoundary(row);
    if (
        classifyPhase(row) !== 'seeded' ||
        row.witnessProofCount !== 0 || row.targetProofCount !== 0 ||
        row.reservationCount !== 0 || row.completeReceiptCount !== 0 ||
        row.currentReceiptCount !== 0 ||
        row.receiptPurposeWithdrawalCount !== 0 || row.receiptEmptyHashCount !== 0
    ) throw rehearsalError('seed-fixture-invalid');
}

function assertVerificationPendingSnapshot(row) {
    assertRemoteBoundary(row);
    if (
        classifyPhase(row) !== 'verification-pending' ||
        row.publicItemCount !== 1 || row.publicationCount !== 1 ||
        row.withdrawalKind !== 'editorial-removal' ||
        row.privateOriginalDeletionConfirmed !== 0 ||
        row.witnessProofCount !== 0 ||
        row.targetProofCount !== 0 || row.reservationCount !== 0 ||
        row.completeReceiptCount !== 0 || row.currentReceiptCount !== 0 ||
        row.receiptPurposeWithdrawalCount !== 0 || row.receiptEmptyHashCount !== 0
    ) throw rehearsalError('verification-pending-fixture-invalid');
}

function assertVerifiedSnapshot(row) {
    assertRemoteBoundary(row);
    if (
        classifyPhase(row) !== 'verified' ||
        row.publicItemCount !== 1 || row.publicationCount !== 1 ||
        row.withdrawalKind !== 'editorial-removal' ||
        row.targetProofCount !== 0 || row.reservationCount !== 0 ||
        row.completeReceiptCount !== 1 || row.currentReceiptCount !== 1 ||
        row.receiptPurposeWithdrawalCount !== 1 || row.receiptEmptyHashCount !== 1
    ) throw rehearsalError('verified-fixture-invalid');
}

function assertWithdrawnSnapshot(row) {
    assertRemoteBoundary(row);
    if (
        classifyPhase(row) !== 'withdrawn' ||
        row.publicItemCount !== 1 || row.publicationCount !== 1 ||
        row.withdrawalKind !== 'editorial-removal' ||
        row.targetProofCount !== 0 || row.reservationCount !== 0 ||
        row.completeReceiptCount !== 1 || row.currentReceiptCount !== 1
    ) throw rehearsalError('withdrawn-fixture-invalid');
}

function assertTombstonedSnapshot(row) {
    assertRemoteBoundary(row);
    if (
        classifyPhase(row) !== 'tombstoned' ||
        row.publicItemCount !== 1 || row.publicationCount !== 1 ||
        row.withdrawalKind !== 'editorial-removal' ||
        row.targetProofCount !== 0 || row.reservationCount !== 0 ||
        row.completeReceiptCount !== 1 || row.currentReceiptCount !== 1
    ) {
        throw rehearsalError('tombstoned-fixture-invalid');
    }
}

function assertPurgeReadySnapshot(row) {
    assertRemoteBoundary(row);
    if (
        classifyPhase(row) !== 'purge-ready' ||
        row.publicItemCount !== 1 || row.publicationCount !== 1 ||
        row.withdrawalKind !== 'editorial-removal' ||
        row.targetProofCount !== 0 || row.reservationCount !== 0 ||
        row.completeReceiptCount !== 1 || row.currentReceiptCount !== 1
    ) {
        throw rehearsalError('purge-ready-fixture-invalid');
    }
}

function assertCompleteSnapshot(row) {
    assertRemoteBoundary(row);
    if (
        classifyPhase(row) !== 'complete' ||
        row.targetProofCount !== 0 || row.reservationCount !== 0 ||
        row.generationCount !== 0 || row.generationTargetCount !== 0 ||
        row.completeReceiptCount !== 0 || row.currentReceiptCount !== 0 ||
        row.draftState !== null || row.draftStateVersion !== null ||
        row.withdrawalKind !== null || row.hostDeletionConfirmed !== null ||
        row.privateOriginalDeletionConfirmed !== null ||
        row.receiptPurposeWithdrawalCount !== 1 || row.receiptEmptyHashCount !== 1
    ) throw rehearsalError('purged-fixture-invalid');
}

function assertPhaseSnapshot(row, phase) {
    if (phase === 'fresh') {
        if (
            classifyPhase(row) !== 'fresh' ||
            row.completeReceiptCount !== 0 || row.currentReceiptCount !== 0 ||
            row.receiptPurposeWithdrawalCount !== 0 ||
            row.receiptEmptyHashCount !== 0
        ) throw rehearsalError('fresh-fixture-invalid');
        return;
    }
    if (phase === 'seeded') return assertSeededSnapshot(row);
    if (phase === 'verification-pending') {
        return assertVerificationPendingSnapshot(row);
    }
    if (phase === 'verified') return assertVerifiedSnapshot(row);
    if (phase === 'withdrawn') return assertWithdrawnSnapshot(row);
    if (phase === 'tombstoned') return assertTombstonedSnapshot(row);
    if (phase === 'purge-ready') return assertPurgeReadySnapshot(row);
    if (phase === 'complete') return assertCompleteSnapshot(row);
    throw rehearsalError('fixture-state-unrecognized');
}

function assertSnapshotsEqual(before, after, code) {
    if (JSON.stringify(before) !== JSON.stringify(after)) throw rehearsalError(code);
}

function assertIntegrity(result) {
    if (
        !Array.isArray(result) || result.length !== 1 ||
        !isPlainObject(result[0]) ||
        !hasExactKeys(result[0], ['foreignKeyViolationCount', 'quickCheck']) ||
        result[0].foreignKeyViolationCount !== 0 ||
        result[0].quickCheck !== 'ok'
    ) throw rehearsalError('integrity-invalid');
}

async function readBoundary(boundaryReader, phase, serviceClientId) {
    let boundary;
    try {
        boundary = await boundaryReader(Object.freeze({ phase }));
    } catch {
        throw rehearsalError(`boundary-${phase}-unavailable`);
    }
    assertBoundary(boundary, serviceClientId, phase);
    return JSON.stringify(boundary);
}

function assertBoundary(boundary, serviceClientId, phase) {
    const code = `boundary-${phase}-invalid`;
    if (!isPlainObject(boundary) || !hasExactKeys(boundary, [
        'approvedMedia', 'mediaWorker', 'verifierWorker'
    ])) throw rehearsalError(code);

    const verifier = boundary.verifierWorker;
    if (
        !isPlainObject(verifier) ||
        !hasExactKeys(verifier, [
            'activeVersions', 'bindingCount', 'customDomainCount', 'd1Bindings',
            'name', 'plainTextBindings', 'previewUrls', 'r2Bindings',
            'routeCount', 'secretBindings', 'serviceBindings',
            'versionMetadataBindings', 'workersDev'
        ]) ||
        verifier.name !== verifierWorkerName ||
        verifier.workersDev !== true || verifier.previewUrls !== false ||
        verifier.routeCount !== 0 || verifier.customDomainCount !== 0 ||
        verifier.bindingCount !== 10 ||
        !exactActiveVersion(verifier.activeVersions, verifierVersion) ||
        !exactD1Binding(verifier.d1Bindings) ||
        !exactPlainTextBindings(verifier.plainTextBindings, serviceClientId) ||
        !exactEmptyArray(verifier.r2Bindings) ||
        !exactEmptyArray(verifier.versionMetadataBindings) ||
        !exactEmptyArray(verifier.serviceBindings) ||
        !exactEmptyArray(verifier.secretBindings)
    ) throw rehearsalError(code);

    const media = boundary.mediaWorker;
    if (
        !isPlainObject(media) ||
        !hasExactKeys(media, [
            'activeVersions', 'bindingCount', 'customDomainCount', 'd1Bindings',
            'name', 'plainTextBindings', 'previewUrls', 'r2Bindings',
            'routeCount', 'secretBindings', 'serviceBindings',
            'versionMetadataBindings', 'workersDev'
        ]) ||
        media.name !== mediaWorkerName ||
        media.workersDev !== true || media.previewUrls !== false ||
        media.routeCount !== 0 || media.customDomainCount !== 0 ||
        media.bindingCount !== 2 ||
        !exactActiveVersion(media.activeVersions, mediaVersion) ||
        !exactEmptyArray(media.d1Bindings) ||
        !exactEmptyArray(media.plainTextBindings) ||
        !exactEmptyArray(media.serviceBindings) ||
        !exactEmptyArray(media.secretBindings) ||
        !Array.isArray(media.r2Bindings) || media.r2Bindings.length !== 1 ||
        !isPlainObject(media.r2Bindings[0]) ||
        !hasExactKeys(media.r2Bindings[0], ['binding', 'bucketName']) ||
        media.r2Bindings[0].binding !== 'APPROVED_MEDIA' ||
        media.r2Bindings[0].bucketName !== approvedMediaBucketName ||
        !Array.isArray(media.versionMetadataBindings) ||
        media.versionMetadataBindings.length !== 1 ||
        !isPlainObject(media.versionMetadataBindings[0]) ||
        !hasExactKeys(media.versionMetadataBindings[0], ['binding']) ||
        media.versionMetadataBindings[0].binding !== 'MEDIA_VERSION'
    ) throw rehearsalError(code);

    const inventory = boundary.approvedMedia;
    if (
        !isPlainObject(inventory) ||
        !hasExactKeys(inventory, [
            'bucketName', 'listComplete', 'multipartUploadCount', 'objects'
        ]) ||
        inventory.bucketName !== approvedMediaBucketName ||
        inventory.listComplete !== true || inventory.multipartUploadCount !== 0 ||
        !Array.isArray(inventory.objects) || inventory.objects.length !== 1 ||
        !isPlainObject(inventory.objects[0]) ||
        !hasExactKeys(inventory.objects[0], [
            'byteCount', 'contentType', 'key', 'sha256'
        ]) ||
        inventory.objects[0].key !== witnessKey ||
        inventory.objects[0].sha256 !== witnessSha256 ||
        inventory.objects[0].byteCount !== witnessByteCount ||
        inventory.objects[0].contentType !== witnessContentType
    ) throw rehearsalError(code);
}

function exactActiveVersion(value, expectedVersion) {
    return Array.isArray(value) && value.length === 1 &&
        isPlainObject(value[0]) &&
        hasExactKeys(value[0], ['trafficPercent', 'versionId']) &&
        value[0].versionId === expectedVersion &&
        value[0].trafficPercent === 100;
}

function exactD1Binding(value) {
    return Array.isArray(value) && value.length === 1 &&
        isPlainObject(value[0]) &&
        hasExactKeys(value[0], [
            'binding', 'databaseName', 'matchesAdminConfig'
        ]) &&
        value[0].binding === 'DB' &&
        value[0].databaseName === databaseName &&
        value[0].matchesAdminConfig === true;
}

function exactPlainTextBindings(value, serviceClientId) {
    return isPlainObject(value) && hasExactKeys(value, [
        'APPROVED_MEDIA_ORIGIN', 'EXPECTED_MEDIA_VERSION', 'MEDIA_CONTRACT',
        'MEDIA_WITNESS_BYTE_COUNT', 'MEDIA_WITNESS_CONTENT_TYPE',
        'MEDIA_WITNESS_KEY', 'MEDIA_WITNESS_SHA256',
        'PUBLIC_HOST_VERIFIER_IDENTITY', 'PUBLIC_HOST_VERIFIER_ORIGIN'
    ]) &&
        value.PUBLIC_HOST_VERIFIER_ORIGIN === verifierOrigin &&
        value.PUBLIC_HOST_VERIFIER_IDENTITY === `subject:${serviceClientId}` &&
        value.APPROVED_MEDIA_ORIGIN === mediaOrigin &&
        value.MEDIA_CONTRACT === mediaContract &&
        value.EXPECTED_MEDIA_VERSION === mediaVersion &&
        value.MEDIA_WITNESS_KEY === witnessKey &&
        value.MEDIA_WITNESS_SHA256 === witnessSha256 &&
        value.MEDIA_WITNESS_BYTE_COUNT === String(witnessByteCount) &&
        value.MEDIA_WITNESS_CONTENT_TYPE === witnessContentType;
}

function exactEmptyArray(value) {
    return Array.isArray(value) && value.length === 0;
}

function assertBoundariesEqual(before, after) {
    if (before !== after) throw rehearsalError('boundary-changed-during-rehearsal');
}

function requireSingleChange(result, label) {
    if (
        !isPlainObject(result) ||
        result.success !== true ||
        result.changedRowCount !== 1
    ) throw rehearsalError(`${label}-cas-failed`);
}

function assertResponseMatchesSnapshot(response, snapshot, label) {
    const verificationId = response?.body?.verificationId;
    const verificationIdHash = typeof verificationId === 'string'
        ? createHash('sha256').update(
            `public-host-verification-id:${verificationId}`
        ).digest('hex')
        : null;
    if (
        !verificationIdHash ||
        snapshot.verificationId !== verificationId ||
        snapshot.receiptVerificationIdHash !== verificationIdHash
    ) throw rehearsalError(`${label}-receipt-mismatch`);
}

function requireBookmark(value, label) {
    if (
        !isPlainObject(value) ||
        !hasExactKeys(value, ['bookmark', 'present']) ||
        value.present !== true ||
        typeof value.bookmark !== 'string' ||
        !/^[0-9a-f-]{32,160}$/.test(value.bookmark)
    ) {
        throw rehearsalError(`${label}-invalid`);
    }
}

async function persistBookmark(bookmarkSink, phase, value) {
    try {
        await bookmarkSink(Object.freeze({ phase, bookmark: value.bookmark }));
    } catch {
        throw rehearsalError(`bookmark-${phase}-persistence-failed`);
    }
}

function successSummary(initialPhase) {
    return Object.freeze({
        status: 'passed',
        initialPhase,
        resumedRun: initialPhase !== 'fresh',
        replayedRun: initialPhase === 'complete',
        verificationPurpose: 'withdrawal',
        generationCount: 0,
        targetProofCount: 0,
        retirementReservationCount: 0,
        permanentReceiptCount: 1,
        permanentRetentionTombstoneCount: 1,
        draftPurged: true,
        epochSequence: 1,
        workerDeploymentMutationRequested: false,
        r2MutationRequested: false,
        manifestMutationRequested: false,
        boundaryUnchanged: true
    });
}

function seedFixtureSql() {
    return `PRAGMA foreign_keys = ON;
INSERT INTO gallery_drafts (
    draft_id, public_item_id, site_modes_json, export_bundle_id,
    source_revision, suppression_revision, item_revision, media_type,
    race_date, race_event, race_distance, athlete_ids_json, title,
    caption, alt_text, featured, verified_owner_identity_hash,
    created_at, updated_at
) VALUES (
    '${draftId}', '${publicItemId}', '["family"]',
    'synthetic-public-host-bundle-0001', 'synthetic-public-host-source-0001',
    'synthetic-public-host-suppression-0001', 'synthetic-public-host-item-0001',
    'photo', '2026-08-31', 'Synthetic verifier rehearsal', '5 km', '[]',
    'Synthetic verifier rehearsal', 'Synthetic bytes are never created.',
    'No media is attached to this synthetic verifier rehearsal.', 0,
    '${ownerIdentityHash}', '2026-08-31T18:00:00.000Z',
    '2026-08-31T18:00:00.000Z'
);
UPDATE gallery_drafts
SET state = 'withdrawal-pending', state_version = 1,
    updated_at = '2026-08-31T18:00:00.001Z'
WHERE draft_id = '${draftId}' AND state = 'draft' AND state_version = 0;
INSERT INTO draft_publication_references (
    draft_id, host_deletion_confirmed, private_original_deletion_confirmed,
    withdrawal_kind, updated_at
) VALUES (
    '${draftId}', 0, 0, 'editorial-removal', '2026-08-31T18:00:00.002Z'
);`;
}

// This is deliberately later than the receipt and withdrawal transition so the
// rehearsal proves both the missing-tombstone and missing-private-original
// purge guards against otherwise current public-host evidence.
function insertTombstoneSql() {
    return `INSERT INTO gallery_retention_tombstones (
    draft_id, purge_kind, eligible_at, approved_at,
    approved_by_identity_hash, evidence_hash
) SELECT
    draft.draft_id, 'retention-expiry', draft.updated_at,
    strftime('%Y-%m-%dT%H:%M:%fZ', draft.updated_at, '+1 second'),
    '${retentionActorHash}', '${retentionEvidenceHash}'
FROM gallery_drafts AS draft
JOIN draft_publication_references AS publication
  ON publication.draft_id = draft.draft_id
JOIN gallery_current_public_host_absence_receipts AS receipt
  ON receipt.draft_id = draft.draft_id
JOIN gallery_public_host_absence_receipts AS permanent
  ON permanent.final_receipt_hash = receipt.final_receipt_hash
WHERE draft.draft_id = '${draftId}'
  AND draft.state = 'withdrawn' AND draft.state_version = 2
  AND ${noSyntheticMediaPredicate('draft')}
  AND publication.withdrawal_kind = 'editorial-removal'
  AND publication.host_deletion_confirmed = 1
  AND publication.private_original_deletion_confirmed = 0
  AND ${exactCurrentWithdrawalReceiptPredicate('receipt', 'permanent')}
  AND NOT EXISTS (
      SELECT 1 FROM gallery_retention_tombstones AS existing
      WHERE existing.draft_id = draft.draft_id
  );
SELECT changes() AS changedRowCount;`;
}

function confirmPrivateOriginalDeletionSql() {
    return `UPDATE draft_publication_references AS publication
    SET private_original_deletion_confirmed = 1,
    updated_at = (
        SELECT strftime(
            '%Y-%m-%dT%H:%M:%fZ', tombstone.approved_at, '+1 second'
        )
        FROM gallery_retention_tombstones AS tombstone
        WHERE tombstone.draft_id = publication.draft_id
          AND tombstone.purge_kind = 'retention-expiry'
          AND tombstone.approved_by_identity_hash = '${retentionActorHash}'
          AND tombstone.evidence_hash = '${retentionEvidenceHash}'
    )
WHERE publication.draft_id = '${draftId}'
  AND publication.withdrawal_kind = 'editorial-removal'
  AND publication.host_deletion_confirmed = 1
  AND publication.private_original_deletion_confirmed = 0
  AND EXISTS (
      SELECT 1
      FROM gallery_drafts AS draft
      JOIN gallery_retention_tombstones AS tombstone
        ON tombstone.draft_id = draft.draft_id
      JOIN gallery_current_public_host_absence_receipts AS receipt
        ON receipt.draft_id = draft.draft_id
      JOIN gallery_public_host_absence_receipts AS permanent
        ON permanent.final_receipt_hash = receipt.final_receipt_hash
      WHERE draft.draft_id = publication.draft_id
        AND draft.state = 'withdrawn' AND draft.state_version = 2
        AND ${noSyntheticMediaPredicate('draft')}
        AND tombstone.purge_kind = 'retention-expiry'
        AND tombstone.approved_by_identity_hash = '${retentionActorHash}'
        AND tombstone.evidence_hash = '${retentionEvidenceHash}'
        AND ${exactCurrentWithdrawalReceiptPredicate('receipt', 'permanent')}
  );
SELECT changes() AS changedRowCount;`;
}

function guardScalarSql() {
    return `UPDATE draft_publication_references
SET host_deletion_confirmed = 1, updated_at = '2026-08-31T18:00:00.005Z'
WHERE draft_id = '${draftId}' AND host_deletion_confirmed = 0;`;
}

function guardWithdrawalSql() {
    return `UPDATE gallery_drafts
SET state = 'withdrawn', state_version = 2,
    updated_at = '2026-08-31T18:00:00.006Z'
WHERE draft_id = '${draftId}' AND state = 'withdrawal-pending'
  AND state_version = 1;`;
}

function transitionWithdrawnSql() {
    return `UPDATE gallery_drafts AS draft
SET state = 'withdrawn', state_version = 2,
    updated_at = (
        SELECT strftime(
            '%Y-%m-%dT%H:%M:%fZ', receipt.verified_at, '+1 second'
        )
        FROM gallery_current_public_host_absence_receipts AS receipt
        JOIN gallery_public_host_absence_receipts AS permanent
          ON permanent.final_receipt_hash = receipt.final_receipt_hash
        WHERE receipt.draft_id = draft.draft_id
          AND ${exactCurrentWithdrawalReceiptPredicate('receipt', 'permanent')}
    )
WHERE draft.draft_id = '${draftId}'
  AND draft.state = 'withdrawal-pending' AND draft.state_version = 1
  AND ${noSyntheticMediaPredicate('draft')}
  AND EXISTS (
      SELECT 1
      FROM draft_publication_references AS publication
      JOIN gallery_current_public_host_absence_receipts AS receipt
        ON receipt.draft_id = publication.draft_id
      JOIN gallery_public_host_absence_receipts AS permanent
        ON permanent.final_receipt_hash = receipt.final_receipt_hash
      WHERE publication.draft_id = draft.draft_id
        AND publication.withdrawal_kind = 'editorial-removal'
        AND publication.host_deletion_confirmed = 1
        AND publication.private_original_deletion_confirmed = 0
        AND ${exactCurrentWithdrawalReceiptPredicate('receipt', 'permanent')}
  );
SELECT changes() AS changedRowCount;`;
}

function noSyntheticMediaPredicate(alias) {
    return `${alias}.active_consent_revision IS NULL
  AND ${alias}.original_object_key IS NULL
  AND ${alias}.original_detected_type IS NULL
  AND ${alias}.original_byte_count IS NULL
  AND ${alias}.original_sha256 IS NULL
  AND ${alias}.upload_complete = 0
  AND ${alias}.processing_diagnostics_json IS NULL
  AND NOT EXISTS (SELECT 1 FROM draft_consent_attestations WHERE draft_id = ${alias}.draft_id)
  AND NOT EXISTS (SELECT 1 FROM draft_upload_sessions WHERE draft_id = ${alias}.draft_id)
  AND NOT EXISTS (SELECT 1 FROM draft_derivatives WHERE draft_id = ${alias}.draft_id)
  AND NOT EXISTS (SELECT 1 FROM draft_processing_runs WHERE draft_id = ${alias}.draft_id)
  AND NOT EXISTS (SELECT 1 FROM draft_processing_cleanups WHERE draft_id = ${alias}.draft_id)
  AND NOT EXISTS (SELECT 1 FROM draft_photo_promotions WHERE draft_id = ${alias}.draft_id)
  AND NOT EXISTS (SELECT 1 FROM draft_photo_promotion_cleanups WHERE draft_id = ${alias}.draft_id)`;
}

function exactCurrentWithdrawalReceiptPredicate(currentAlias, permanentAlias) {
    return `${currentAlias}.verification_purpose = 'withdrawal'
  AND ${currentAlias}.purpose_evidence_hash IS NULL
  AND ${currentAlias}.withdrawal_kind = 'editorial-removal'
  AND ${currentAlias}.expected_state_version = 1
  AND ${currentAlias}.verification_id_hash = ${permanentAlias}.verification_id_hash
  AND ${currentAlias}.withdrawal_cycle_hash = ${permanentAlias}.withdrawal_cycle_hash
  AND ${permanentAlias}.withdrawal_cycle_hash = '${withdrawalCycleHash}'
  AND ${permanentAlias}.draft_id_hash = '${draftIdHash}'
  AND ${permanentAlias}.promotion_set_hash = '${emptySha256}'
  AND ${permanentAlias}.cleanup_evidence_set_hash = '${emptySha256}'
  AND ${permanentAlias}.approved_origin_hash = '${approvedOriginHash}'
  AND ${permanentAlias}.target_set_hash = '${emptySha256}'
  AND ${permanentAlias}.generation_count = 0
  AND ${permanentAlias}.target_count = 0
  AND ${permanentAlias}.verified_state_version = 1
  AND ${permanentAlias}.verification_purpose = 'withdrawal'
  AND ${permanentAlias}.purpose_evidence_hash IS NULL
  AND ${permanentAlias}.media_delivery_epoch_id_hash = '${epochIdHash}'
  AND ${permanentAlias}.delivery_contract_hash = '${deliveryContractHash}'
  AND ${permanentAlias}.delivery_version_hash = '${deliveryVersionHash}'
  AND ${permanentAlias}.idempotency_key_hash = '${idempotencyKeyHash}'`;
}

function purgeSql() {
    return `DELETE FROM gallery_drafts WHERE draft_id = '${draftId}';
SELECT changes() AS changedRowCount;`;
}

function integritySql() {
    return `SELECT
    (SELECT COUNT(*) FROM pragma_foreign_key_check) AS foreignKeyViolationCount,
    (SELECT quick_check FROM pragma_quick_check LIMIT 1) AS quickCheck;`;
}

function fixtureSnapshotCoreSql() {
    return `SELECT
    (SELECT COUNT(*) FROM gallery_media_delivery_epochs) AS epochCount,
    (SELECT COUNT(*) FROM gallery_media_delivery_epoch_activations) AS activationCount,
    (SELECT COUNT(*) FROM gallery_media_delivery_current_epoch) AS currentEpochCount,
    (SELECT epoch_sequence FROM gallery_media_delivery_current_epoch WHERE singleton_id = 1) AS epochSequence,
    (SELECT epoch.epoch_id FROM gallery_media_delivery_epochs AS epoch JOIN gallery_media_delivery_current_epoch AS current ON current.epoch_id_hash = epoch.epoch_id_hash WHERE current.singleton_id = 1) AS epochId,
    (SELECT epoch_id_hash FROM gallery_media_delivery_current_epoch WHERE singleton_id = 1) AS epochIdHash,
    (SELECT epoch.configuration_hash FROM gallery_media_delivery_epochs AS epoch JOIN gallery_media_delivery_current_epoch AS current ON current.epoch_id_hash = epoch.epoch_id_hash WHERE current.singleton_id = 1) AS configurationHash,
    (SELECT epoch.approved_origin FROM gallery_media_delivery_epochs AS epoch JOIN gallery_media_delivery_current_epoch AS current ON current.epoch_id_hash = epoch.epoch_id_hash WHERE current.singleton_id = 1) AS approvedOrigin,
    (SELECT epoch.approved_origin_hash FROM gallery_media_delivery_epochs AS epoch JOIN gallery_media_delivery_current_epoch AS current ON current.epoch_id_hash = epoch.epoch_id_hash WHERE current.singleton_id = 1) AS approvedOriginHash,
    (SELECT epoch.delivery_contract_hash FROM gallery_media_delivery_epochs AS epoch JOIN gallery_media_delivery_current_epoch AS current ON current.epoch_id_hash = epoch.epoch_id_hash WHERE current.singleton_id = 1) AS deliveryContractHash,
    (SELECT epoch.delivery_version_hash FROM gallery_media_delivery_epochs AS epoch JOIN gallery_media_delivery_current_epoch AS current ON current.epoch_id_hash = epoch.epoch_id_hash WHERE current.singleton_id = 1) AS deliveryVersionHash,
    (SELECT epoch.witness_object_key_hash FROM gallery_media_delivery_epochs AS epoch JOIN gallery_media_delivery_current_epoch AS current ON current.epoch_id_hash = epoch.epoch_id_hash WHERE current.singleton_id = 1) AS witnessObjectKeyHash,
    (SELECT epoch.witness_sha256 FROM gallery_media_delivery_epochs AS epoch JOIN gallery_media_delivery_current_epoch AS current ON current.epoch_id_hash = epoch.epoch_id_hash WHERE current.singleton_id = 1) AS epochWitnessSha256,
    (SELECT epoch.witness_byte_count FROM gallery_media_delivery_epochs AS epoch JOIN gallery_media_delivery_current_epoch AS current ON current.epoch_id_hash = epoch.epoch_id_hash WHERE current.singleton_id = 1) AS epochWitnessByteCount,
    (SELECT epoch.witness_content_type FROM gallery_media_delivery_epochs AS epoch JOIN gallery_media_delivery_current_epoch AS current ON current.epoch_id_hash = epoch.epoch_id_hash WHERE current.singleton_id = 1) AS epochWitnessContentType,
    (SELECT COUNT(*) FROM gallery_drafts WHERE draft_id = '${accessControlDraftId}') AS accessControlDraftCount,
    (SELECT COUNT(*) FROM gallery_drafts WHERE draft_id = '${draftId}') AS draftCount,
    (SELECT COUNT(*) FROM gallery_drafts WHERE public_item_id = '${publicItemId}') AS publicItemCount,
    (SELECT public_item_id FROM gallery_drafts WHERE draft_id = '${draftId}') AS draftPublicItemId,
    (SELECT site_modes_json FROM gallery_drafts WHERE draft_id = '${draftId}') AS draftSiteModesJson,
    (SELECT export_bundle_id FROM gallery_drafts WHERE draft_id = '${draftId}') AS draftExportBundleId,
    (SELECT source_revision FROM gallery_drafts WHERE draft_id = '${draftId}') AS draftSourceRevision,
    (SELECT suppression_revision FROM gallery_drafts WHERE draft_id = '${draftId}') AS draftSuppressionRevision,
    (SELECT item_revision FROM gallery_drafts WHERE draft_id = '${draftId}') AS draftItemRevision,
    (SELECT media_type FROM gallery_drafts WHERE draft_id = '${draftId}') AS draftMediaType,
    (SELECT race_date FROM gallery_drafts WHERE draft_id = '${draftId}') AS draftRaceDate,
    (SELECT race_event FROM gallery_drafts WHERE draft_id = '${draftId}') AS draftRaceEvent,
    (SELECT race_distance FROM gallery_drafts WHERE draft_id = '${draftId}') AS draftRaceDistance,
    (SELECT athlete_ids_json FROM gallery_drafts WHERE draft_id = '${draftId}') AS draftAthleteIdsJson,
    (SELECT title FROM gallery_drafts WHERE draft_id = '${draftId}') AS draftTitle,
    (SELECT caption FROM gallery_drafts WHERE draft_id = '${draftId}') AS draftCaption,
    (SELECT alt_text FROM gallery_drafts WHERE draft_id = '${draftId}') AS draftAltText,
    (SELECT featured FROM gallery_drafts WHERE draft_id = '${draftId}') AS draftFeatured,
    (SELECT verified_owner_identity_hash FROM gallery_drafts WHERE draft_id = '${draftId}') AS draftOwnerIdentityHash,
    (SELECT created_at FROM gallery_drafts WHERE draft_id = '${draftId}') AS draftCreatedAt,
    (SELECT state FROM gallery_drafts WHERE draft_id = '${draftId}') AS draftState,
    (SELECT state_version FROM gallery_drafts WHERE draft_id = '${draftId}') AS draftStateVersion,
    (SELECT updated_at FROM gallery_drafts WHERE draft_id = '${draftId}') AS draftUpdatedAt,
    (SELECT active_consent_revision FROM gallery_drafts WHERE draft_id = '${draftId}') AS activeConsentRevision,
    (SELECT original_object_key FROM gallery_drafts WHERE draft_id = '${draftId}') AS originalObjectKey,
    (SELECT original_detected_type FROM gallery_drafts WHERE draft_id = '${draftId}') AS originalDetectedType,
    (SELECT original_byte_count FROM gallery_drafts WHERE draft_id = '${draftId}') AS originalByteCount,
    (SELECT original_sha256 FROM gallery_drafts WHERE draft_id = '${draftId}') AS originalSha256,
    (SELECT upload_complete FROM gallery_drafts WHERE draft_id = '${draftId}') AS uploadComplete,
    (SELECT processing_diagnostics_json FROM gallery_drafts WHERE draft_id = '${draftId}') AS processingDiagnosticsJson,
    (SELECT COUNT(*) FROM draft_consent_attestations WHERE draft_id = '${draftId}') AS consentAttestationCount,
    (SELECT COUNT(*) FROM draft_upload_sessions WHERE draft_id = '${draftId}') AS uploadSessionCount,
    (SELECT COUNT(*) FROM draft_derivatives WHERE draft_id = '${draftId}') AS derivativeCount,
    (SELECT COUNT(*) FROM draft_processing_runs WHERE draft_id = '${draftId}') AS processingRunCount,
    (SELECT COUNT(*) FROM draft_processing_cleanups WHERE draft_id = '${draftId}') AS processingCleanupCount,
    (SELECT COUNT(*) FROM draft_photo_promotions WHERE draft_id = '${draftId}') AS photoPromotionCount,
    (SELECT COUNT(*) FROM draft_photo_promotion_cleanups WHERE draft_id = '${draftId}') AS photoPromotionCleanupCount;`;
}

function fixtureSnapshotEvidenceSql() {
    return `SELECT
    (SELECT COUNT(*) FROM draft_publication_references WHERE draft_id = '${draftId}') AS publicationCount,
    (SELECT withdrawal_kind FROM draft_publication_references WHERE draft_id = '${draftId}') AS withdrawalKind,
    (SELECT host_deletion_confirmed FROM draft_publication_references WHERE draft_id = '${draftId}') AS hostDeletionConfirmed,
    (SELECT private_original_deletion_confirmed FROM draft_publication_references WHERE draft_id = '${draftId}') AS privateOriginalDeletionConfirmed,
    (SELECT updated_at FROM draft_publication_references WHERE draft_id = '${draftId}') AS publicationUpdatedAt,
    (SELECT COUNT(*) FROM gallery_retention_tombstones WHERE draft_id = '${draftId}' AND purge_kind = 'retention-expiry' AND approved_by_identity_hash = '${retentionActorHash}' AND evidence_hash = '${retentionEvidenceHash}') AS tombstoneCount,
    (SELECT purge_kind FROM gallery_retention_tombstones WHERE draft_id = '${draftId}') AS tombstonePurgeKind,
    (SELECT eligible_at FROM gallery_retention_tombstones WHERE draft_id = '${draftId}') AS tombstoneEligibleAt,
    (SELECT approved_at FROM gallery_retention_tombstones WHERE draft_id = '${draftId}') AS tombstoneApprovedAt,
    (SELECT approved_by_identity_hash FROM gallery_retention_tombstones WHERE draft_id = '${draftId}') AS tombstoneActorHash,
    (SELECT evidence_hash FROM gallery_retention_tombstones WHERE draft_id = '${draftId}') AS tombstoneEvidenceHash,
    (SELECT COUNT(*) FROM draft_public_host_absence_verifications WHERE draft_id_hash = '${draftIdHash}' AND idempotency_key = '${idempotencyKey}') AS verificationCount,
    (SELECT verification_id FROM draft_public_host_absence_verifications WHERE draft_id_hash = '${draftIdHash}' AND idempotency_key = '${idempotencyKey}') AS verificationId,
    (SELECT COUNT(*) FROM draft_public_host_absence_witness_proofs AS proof JOIN draft_public_host_absence_verifications AS verification ON verification.verification_id = proof.verification_id WHERE verification.draft_id_hash = '${draftIdHash}') AS witnessProofCount,
    (SELECT COUNT(*) FROM draft_public_host_absence_target_proofs AS proof JOIN draft_public_host_absence_verifications AS verification ON verification.verification_id = proof.verification_id WHERE verification.draft_id_hash = '${draftIdHash}') AS targetProofCount,
    (SELECT COUNT(*) FROM gallery_approved_media_key_retirement_reservations WHERE draft_id_hash = '${draftIdHash}') AS reservationCount,
    (SELECT COUNT(*) FROM gallery_public_host_absence_receipts WHERE draft_id_hash = '${draftIdHash}' AND idempotency_key_hash = '${idempotencyKeyHash}') AS receiptCount,
    (SELECT final_receipt_hash FROM gallery_public_host_absence_receipts WHERE draft_id_hash = '${draftIdHash}' AND idempotency_key_hash = '${idempotencyKeyHash}') AS receiptFinalHash,
    (SELECT verification_id_hash FROM gallery_public_host_absence_receipts WHERE draft_id_hash = '${draftIdHash}' AND idempotency_key_hash = '${idempotencyKeyHash}') AS receiptVerificationIdHash,
    (SELECT draft_id_hash FROM gallery_public_host_absence_receipts WHERE draft_id_hash = '${draftIdHash}' AND idempotency_key_hash = '${idempotencyKeyHash}') AS receiptDraftIdHash,
    (SELECT promotion_set_hash FROM gallery_public_host_absence_receipts WHERE draft_id_hash = '${draftIdHash}' AND idempotency_key_hash = '${idempotencyKeyHash}') AS receiptPromotionSetHash,
    (SELECT cleanup_evidence_set_hash FROM gallery_public_host_absence_receipts WHERE draft_id_hash = '${draftIdHash}' AND idempotency_key_hash = '${idempotencyKeyHash}') AS receiptCleanupSetHash,
    (SELECT withdrawal_cycle_hash FROM gallery_public_host_absence_receipts WHERE draft_id_hash = '${draftIdHash}' AND idempotency_key_hash = '${idempotencyKeyHash}') AS receiptWithdrawalCycleHash,
    (SELECT approved_origin_hash FROM gallery_public_host_absence_receipts WHERE draft_id_hash = '${draftIdHash}' AND idempotency_key_hash = '${idempotencyKeyHash}') AS receiptApprovedOriginHash,
    (SELECT target_set_hash FROM gallery_public_host_absence_receipts WHERE draft_id_hash = '${draftIdHash}' AND idempotency_key_hash = '${idempotencyKeyHash}') AS receiptTargetSetHash,
    (SELECT generation_count FROM gallery_public_host_absence_receipts WHERE draft_id_hash = '${draftIdHash}' AND idempotency_key_hash = '${idempotencyKeyHash}') AS receiptGenerationCount,
    (SELECT target_count FROM gallery_public_host_absence_receipts WHERE draft_id_hash = '${draftIdHash}' AND idempotency_key_hash = '${idempotencyKeyHash}') AS receiptTargetCount,
    (SELECT verified_state_version FROM gallery_public_host_absence_receipts WHERE draft_id_hash = '${draftIdHash}' AND idempotency_key_hash = '${idempotencyKeyHash}') AS receiptStateVersion,
    (SELECT verification_purpose FROM gallery_public_host_absence_receipts WHERE draft_id_hash = '${draftIdHash}' AND idempotency_key_hash = '${idempotencyKeyHash}') AS receiptPurpose,
    (SELECT purpose_evidence_hash FROM gallery_public_host_absence_receipts WHERE draft_id_hash = '${draftIdHash}' AND idempotency_key_hash = '${idempotencyKeyHash}') AS receiptPurposeEvidenceHash,
    (SELECT media_delivery_epoch_id_hash FROM gallery_public_host_absence_receipts WHERE draft_id_hash = '${draftIdHash}' AND idempotency_key_hash = '${idempotencyKeyHash}') AS receiptEpochIdHash,
    (SELECT delivery_contract_hash FROM gallery_public_host_absence_receipts WHERE draft_id_hash = '${draftIdHash}' AND idempotency_key_hash = '${idempotencyKeyHash}') AS receiptDeliveryContractHash,
    (SELECT delivery_version_hash FROM gallery_public_host_absence_receipts WHERE draft_id_hash = '${draftIdHash}' AND idempotency_key_hash = '${idempotencyKeyHash}') AS receiptDeliveryVersionHash,
    (SELECT idempotency_key_hash FROM gallery_public_host_absence_receipts WHERE draft_id_hash = '${draftIdHash}' AND idempotency_key_hash = '${idempotencyKeyHash}') AS receiptIdempotencyKeyHash,
    (SELECT payload_fingerprint FROM gallery_public_host_absence_receipts WHERE draft_id_hash = '${draftIdHash}' AND idempotency_key_hash = '${idempotencyKeyHash}') AS receiptPayloadFingerprint,
    (SELECT verified_at FROM gallery_public_host_absence_receipts WHERE draft_id_hash = '${draftIdHash}' AND idempotency_key_hash = '${idempotencyKeyHash}') AS receiptVerifiedAt,
    (SELECT COUNT(*) FROM gallery_complete_public_host_absence_receipts WHERE draft_id = '${draftId}') AS completeReceiptCount,
    (SELECT COUNT(*) FROM gallery_current_public_host_absence_receipts WHERE draft_id = '${draftId}') AS currentReceiptCount,
    (SELECT COUNT(*) FROM draft_photo_public_generations WHERE draft_id_hash = '${draftIdHash}') AS generationCount,
    (SELECT COUNT(*) FROM draft_photo_public_generation_targets AS target JOIN draft_photo_public_generations AS generation ON generation.promotion_id = target.promotion_id WHERE generation.draft_id_hash = '${draftIdHash}') AS generationTargetCount,
    (SELECT COUNT(*) FROM gallery_public_host_absence_receipts WHERE draft_id_hash = '${draftIdHash}' AND verification_purpose = 'withdrawal' AND purpose_evidence_hash IS NULL AND verified_state_version = 1 AND generation_count = 0 AND target_count = 0) AS receiptPurposeWithdrawalCount,
    (SELECT COUNT(*) FROM gallery_public_host_absence_receipts WHERE draft_id_hash = '${draftIdHash}' AND promotion_set_hash = '${emptySha256}' AND cleanup_evidence_set_hash = '${emptySha256}' AND target_set_hash = '${emptySha256}') AS receiptEmptyHashCount,
    (SELECT COUNT(*) FROM pragma_table_info('gallery_public_host_absence_receipts') WHERE name IN ('draft_id','verification_id','approved_object_key','approved_origin','public_url','idempotency_key')) AS forbiddenReceiptColumnCount,
    (SELECT COUNT(*) FROM draft_public_host_absence_verifications) AS globalVerificationCount,
    (SELECT COUNT(*) FROM draft_public_host_absence_witness_proofs) AS globalWitnessProofCount,
    (SELECT COUNT(*) FROM draft_public_host_absence_target_proofs) AS globalTargetProofCount,
    (SELECT COUNT(*) FROM gallery_approved_media_key_retirement_reservations) AS globalReservationCount,
    (SELECT COUNT(*) FROM gallery_public_host_absence_receipts) AS globalReceiptCount,
    (SELECT COUNT(*) FROM draft_photo_public_generations) AS globalGenerationCount,
    (SELECT COUNT(*) FROM draft_photo_public_generation_targets) AS globalGenerationTargetCount,
    (SELECT COUNT(*) FROM draft_publication_references WHERE host_deletion_confirmed = 1) AS globalTrueHostScalarCount,
    (SELECT COUNT(*) FROM gallery_retention_tombstones) AS globalTombstoneCount;`;
}

function fixtureSnapshotSql() {
    return `${fixtureSnapshotCoreSql()}\n${fixtureSnapshotEvidenceSql()}`;
}

async function spawnWrangler(entrypoint, args, allowFailure = false) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [entrypoint, ...args], {
            cwd: repositoryRoot,
            windowsHide: true,
            shell: false,
            env: {
                ...process.env,
                WRANGLER_WRITE_LOGS: 'false',
                WRANGLER_SEND_METRICS: 'false'
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        const stdout = [];
        const stderr = [];
        let settled = false;
        let timedOut = false;
        let killTimer;
        const timeout = setTimeout(() => {
            timedOut = true;
            child.kill();
            killTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
        }, commandTimeoutMs);
        child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
        child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
        child.on('error', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            clearTimeout(killTimer);
            reject(rehearsalError(timedOut ? 'wrangler-timeout' : 'wrangler-launch-failed'));
        });
        child.on('close', exitCode => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            clearTimeout(killTimer);
            if (timedOut) {
                reject(rehearsalError('wrangler-timeout'));
                return;
            }
            if (exitCode !== 0 && !allowFailure) {
                reject(rehearsalError('wrangler-command-failed'));
                return;
            }
            resolve(Object.freeze({
                exitCode,
                stdout: Buffer.concat(stdout),
                stderrText: Buffer.concat(stderr).toString('utf8')
            }));
        });
    });
}

function parseD1Results(stdout, kind) {
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(stdout).toString('utf8'));
    } catch {
        throw rehearsalError('wrangler-json-invalid');
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some(item => item?.success !== true)) {
        throw rehearsalError('wrangler-result-invalid');
    }
    if (kind === 'snapshot') {
        if (
            parsed.length !== 2 || parsed.some(item =>
                !Array.isArray(item.results) || item.results.length !== 1 ||
                !isPlainObject(item.results[0])
            )
        ) throw rehearsalError('wrangler-snapshot-result-invalid');
        return Object.freeze(parsed.map(item =>
            Object.freeze([Object.freeze({ ...item.results[0] })])
        ));
    }
    const last = parsed.at(-1);
    if (kind === 'read') {
        if (!Array.isArray(last.results)) throw rehearsalError('wrangler-rows-invalid');
        return last.results;
    }
    const changedRow = Array.isArray(last.results) && last.results.length === 1
        ? last.results[0]
        : null;
    return Object.freeze({
        success: true,
        ...(isPlainObject(changedRow) &&
            hasExactKeys(changedRow, ['changedRowCount']) &&
            Number.isSafeInteger(changedRow.changedRowCount)
            ? { changedRowCount: changedRow.changedRowCount }
            : {})
    });
}

function parseBookmark(stdout) {
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(stdout).toString('utf8'));
    } catch {
        throw rehearsalError('bookmark-json-invalid');
    }
    const bookmark = parsed?.bookmark ?? parsed?.result?.bookmark;
    return Object.freeze({
        present: typeof bookmark === 'string' && bookmark.length > 0,
        bookmark
    });
}

function hasExactKeys(value, keys) {
    if (!isPlainObject(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length &&
        actual.every((key, index) => key === expected[index]);
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function rehearsalError(code) {
    const error = new Error(`Gallery public-host remote rehearsal stopped: ${code}.`);
    error.name = 'GalleryPublicHostRemoteRehearsalError';
    return error;
}

// Keep the hashing formula next to the fixed fixture constants. This is also a
// local review assertion that prevents a hand-edited hash from selecting a
// different permanent receipt lineage.
if (
    createHash('sha256').update(`draft-id:${draftId}`).digest('hex') !== draftIdHash ||
    createHash('sha256').update(
        `public-host-absence-idempotency-key:${idempotencyKey}`
    ).digest('hex') !== idempotencyKeyHash ||
    createHash('sha256').update(
        `media-delivery-epoch-id:${epochId}`
    ).digest('hex') !== epochIdHash ||
    createHash('sha256').update(
        `withdrawal-cycle:${draftIdHash}:editorial-removal:1`
    ).digest('hex') !== withdrawalCycleHash ||
    createHash('sha256').update(
        `approved-media-origin:${mediaOrigin}`
    ).digest('hex') !== approvedOriginHash ||
    createHash('sha256').update(
        `approved-media-contract:${mediaContract}`
    ).digest('hex') !== deliveryContractHash ||
    createHash('sha256').update(
        `approved-media-version:${mediaVersion}`
    ).digest('hex') !== deliveryVersionHash ||
    createHash('sha256').update(
        `approved-object-key:${witnessKey}`
    ).digest('hex') !== witnessObjectKeyHash
) throw rehearsalError('fixed-fixture-hash-invalid');
