import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

import {
    galleryPublicHostRemoteRehearsalContract as contract,
    galleryPublicHostRemoteRehearsalSql as sql,
    galleryPublicHostRemoteRehearsalTestHooks as testHooks,
    runGalleryPublicHostRemoteRehearsal
} from '../scripts/rehearse-gallery-public-host-remote.mjs';

const clientId = `${'a'.repeat(32)}.access`;
const clientSecret = 'B'.repeat(64);
const serviceToken = Object.freeze({ clientId, clientSecret });
const verificationId = `hostverify_${'b'.repeat(32)}`;
const verificationIdHash = createHash('sha256').update(
    `public-host-verification-id:${verificationId}`
).digest('hex');
const coreSnapshotKeys = snapshotAliases(sql.snapshotCore);
const evidenceSnapshotKeys = snapshotAliases(sql.snapshotEvidence);

assert.equal(contract.fixture.site, 'family');
assert.deepEqual(contract.fixture.athleteIds, []);
assert.equal(contract.fixture.withdrawalKind, 'editorial-removal');
assert.equal(contract.fixture.purgeKind, 'retention-expiry');
assert.match(sql.seed, /'\["family"\]'/);
assert.match(sql.seed, /'\[\]'/);
assert.doesNotMatch(sql.seed, /consent|original_object_key|approved_object_key/i);
assert.doesNotMatch(sql.seed, /retention-expiry'[^;]+verification/i);
assert.match(sql.guardScalar, /host_deletion_confirmed = 1/);
assert.equal(sql.guardPurge, sql.purge);
assert.match(sql.transitionWithdrawn, /receipt\.verified_at, '\+1 second'/);
assert.match(sql.insertTombstone, /draft\.updated_at[\s\S]+draft\.updated_at, '\+1 second'/);
assert.match(sql.confirmPrivateOriginalDeletion, /tombstone\.approved_at, '\+1 second'/);
assert.equal(coreSnapshotKeys.length, 52);
assert.equal(evidenceSnapshotKeys.length, 52);
assert.ok(coreSnapshotKeys.length <= 64);
assert.ok(evidenceSnapshotKeys.length <= 64);
assert.equal(new Set([...coreSnapshotKeys, ...evidenceSnapshotKeys]).size, 104);
assert.equal(sql.snapshot, `${sql.snapshotCore}\n${sql.snapshotEvidence}`);
for (const casSql of [
    sql.transitionWithdrawn,
    sql.insertTombstone,
    sql.confirmPrivateOriginalDeletion
]) {
    assert.match(casSql, /original_object_key IS NULL/);
    assert.match(casSql, /upload_complete = 0/);
    assert.match(casSql, /draft_upload_sessions/);
    assert.match(casSql, /draft_derivatives/);
    assert.match(casSql, /draft_processing_runs/);
    assert.match(casSql, /draft_photo_promotions/);
    assert.match(casSql, new RegExp(
        `idempotency_key_hash = '${'1d2572925099f00ac9f98fe9b3b7915a078d75f03a8e883926822b3187e4a693'}'`
    ));
    assert.match(casSql, /SELECT changes\(\) AS changedRowCount/);
}
assert.deepEqual(
    testHooks.parseD1Results(Buffer.from(JSON.stringify([
        { success: true, results: [] },
        { success: true, results: [{ changedRowCount: 1 }] }
    ])), 'write'),
    { success: true, changedRowCount: 1 }
);
assert.deepEqual(
    testHooks.parseD1Results(Buffer.from(JSON.stringify([
        { success: true, results: [] }
    ])), 'write'),
    { success: true }
);
assert.deepEqual(
    testHooks.parseD1Results(Buffer.from(JSON.stringify([
        { success: true, results: [{ core: 1 }] },
        { success: true, results: [{ evidence: 2 }] }
    ])), 'snapshot'),
    [[{ core: 1 }], [{ evidence: 2 }]]
);
for (const malformed of [
    [{ success: true, results: [{ only: 1 }] }],
    [
        { success: true, results: [{ one: 1 }] },
        { success: true, results: [{ two: 2 }] },
        { success: true, results: [{ three: 3 }] }
    ],
    [
        { success: true, results: [] },
        { success: true, results: [{ evidence: 2 }] }
    ],
    [
        { success: true, results: [{ core: 1 }, { extra: 2 }] },
        { success: true, results: [{ evidence: 2 }] }
    ]
]) {
    assert.throws(
        () => testHooks.parseD1Results(
            Buffer.from(JSON.stringify(malformed)),
            'snapshot'
        ),
        /wrangler-snapshot-result-invalid/
    );
}

const canonicalFreshSnapshot = snapshot({ phase: 'fresh' });
const canonicalFreshParts = splitSnapshot(canonicalFreshSnapshot);
assert.deepEqual(
    testHooks.mergeSnapshotParts(canonicalFreshParts),
    [canonicalFreshSnapshot]
);
assert.throws(
    () => testHooks.mergeSnapshotParts([canonicalFreshParts[0]]),
    /snapshot-parts-invalid/
);
assert.throws(
    () => testHooks.mergeSnapshotParts([
        canonicalFreshParts[0],
        [{ ...canonicalFreshParts[1][0], epochCount: 1 }]
    ]),
    /snapshot-key-collision/
);
const missingCoreKey = { ...canonicalFreshParts[0][0] };
delete missingCoreKey.epochCount;
assert.throws(
    () => testHooks.mergeSnapshotParts([
        [missingCoreKey], canonicalFreshParts[1]
    ]),
    /snapshot-core-shape-invalid/
);
const missingEvidenceKey = { ...canonicalFreshParts[1][0] };
delete missingEvidenceKey.receiptCount;
assert.throws(
    () => testHooks.mergeSnapshotParts([
        canonicalFreshParts[0], [missingEvidenceKey]
    ]),
    /snapshot-evidence-shape-invalid/
);

const normal = createHarness();
const result = await runGalleryPublicHostRemoteRehearsal({
    bookmarkSink: normal.bookmarkSink,
    boundaryReader: normal.boundaryReader,
    d1Runner: normal.d1Runner,
    fetchImpl: normal.fetchImpl,
    serviceToken
});
assert.deepEqual(result, {
    status: 'passed',
    initialPhase: 'fresh',
    resumedRun: false,
    replayedRun: false,
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
assert.equal(normal.state.phase, 'complete');
assert.deepEqual(normal.state.guardLabels, [
    'guard-scalar-before-receipt',
    'guard-withdrawal-before-receipt',
    'guard-purge-before-receipt',
    'guard-purge-before-tombstone',
    'guard-purge-before-private-original-proof'
]);
assert.equal(normal.state.exactPostCount, 2);
assert.equal(normal.state.stalePostCount, 1);
assert.equal(normal.state.unauthorizedPostCount, 2);
assert.equal(normal.state.bookmarkCount, 2);
assert.equal(normal.state.boundaryReadCount, 2);
assert.equal(normal.state.credentialedGetCount, 1);
assert.equal(normal.state.snapshotCount, 11);
assert.deepEqual(normal.state.persistedBookmarkPhases, ['before', 'after']);

for (const initialPhase of [
    'seeded', 'verification-pending', 'verified', 'withdrawn',
    'tombstoned', 'purge-ready'
]) {
    const resumed = createHarness({ initialPhase });
    const resumedResult = await runGalleryPublicHostRemoteRehearsal({
        bookmarkSink: resumed.bookmarkSink,
        boundaryReader: resumed.boundaryReader,
        d1Runner: resumed.d1Runner,
        fetchImpl: resumed.fetchImpl,
        serviceToken
    });
    assert.equal(resumedResult.status, 'passed');
    assert.equal(resumedResult.initialPhase, initialPhase);
    assert.equal(resumedResult.resumedRun, true);
    assert.equal(resumedResult.replayedRun, false);
    assert.equal(resumed.state.phase, 'complete');
}

const lost = createHarness({ loseFirstExactResponse: true });
const recovered = await runGalleryPublicHostRemoteRehearsal({
    bookmarkSink: lost.bookmarkSink,
    boundaryReader: lost.boundaryReader,
    d1Runner: lost.d1Runner,
    fetchImpl: lost.fetchImpl,
    serviceToken
});
assert.equal(recovered.status, 'passed');
assert.equal(lost.state.phase, 'complete');
assert.equal(lost.state.exactPostCount, 3);

const completed = createHarness({ initialPhase: 'complete' });
const replayedRun = await runGalleryPublicHostRemoteRehearsal({
    bookmarkSink: completed.bookmarkSink,
    boundaryReader: completed.boundaryReader,
    d1Runner: completed.d1Runner,
    fetchImpl: completed.fetchImpl,
    serviceToken
});
assert.equal(replayedRun.replayedRun, true);
assert.equal(replayedRun.initialPhase, 'complete');
assert.equal(replayedRun.resumedRun, true);
assert.equal(completed.state.exactPostCount, 0);
assert.equal(completed.state.unauthorizedPostCount, 2);
assert.equal(completed.state.credentialedGetCount, 1);
assert.equal(completed.state.integrityCount, 2);

await assert.rejects(
    runGalleryPublicHostRemoteRehearsal({
        bookmarkSink: normal.bookmarkSink,
        boundaryReader: normal.boundaryReader,
        d1Runner: normal.d1Runner,
        fetchImpl: normal.fetchImpl,
        serviceToken: { ...serviceToken, extra: true }
    }),
    /invalid-options/
);

const drift = createHarness({ boundaryDrift: true });
await assert.rejects(
    runGalleryPublicHostRemoteRehearsal({
        bookmarkSink: drift.bookmarkSink,
        boundaryReader: drift.boundaryReader,
        d1Runner: drift.d1Runner,
        fetchImpl: drift.fetchImpl,
        serviceToken
    }),
    /remote-boundary-drift/
);
assert.equal(drift.state.phase, 'fresh');

const boundaryChanged = createHarness({
    initialPhase: 'complete',
    boundaryChangeAfterFirst: true
});
await assert.rejects(
    runGalleryPublicHostRemoteRehearsal({
        bookmarkSink: boundaryChanged.bookmarkSink,
        boundaryReader: boundaryChanged.boundaryReader,
        d1Runner: boundaryChanged.d1Runner,
        fetchImpl: boundaryChanged.fetchImpl,
        serviceToken
    }),
    /boundary-after-invalid/
);

const invalidSurvivor = createHarness({
    initialPhase: 'complete',
    invalidReceipt: true
});
await assert.rejects(
    runGalleryPublicHostRemoteRehearsal({
        bookmarkSink: invalidSurvivor.bookmarkSink,
        boundaryReader: invalidSurvivor.boundaryReader,
        d1Runner: invalidSurvivor.d1Runner,
        fetchImpl: invalidSurvivor.fetchImpl,
        serviceToken
    }),
    /permanent-receipt-invalid/
);

const invalidSurvivorChronology = createHarness({
    initialPhase: 'complete',
    invalidChronology: true
});
await assert.rejects(
    runGalleryPublicHostRemoteRehearsal({
        bookmarkSink: invalidSurvivorChronology.bookmarkSink,
        boundaryReader: invalidSurvivorChronology.boundaryReader,
        d1Runner: invalidSurvivorChronology.d1Runner,
        fetchImpl: invalidSurvivorChronology.fetchImpl,
        serviceToken
    }),
    /receipt-tombstone-chronology-invalid/
);

const invalidCompleteViews = createHarness({
    initialPhase: 'complete',
    invalidCompleteViewCount: true
});
await assert.rejects(
    runGalleryPublicHostRemoteRehearsal({
        bookmarkSink: invalidCompleteViews.bookmarkSink,
        boundaryReader: invalidCompleteViews.boundaryReader,
        d1Runner: invalidCompleteViews.d1Runner,
        fetchImpl: invalidCompleteViews.fetchImpl,
        serviceToken
    }),
    /purged-fixture-invalid/
);

const invalidVerificationLink = createHarness({
    initialPhase: 'complete',
    invalidVerificationLink: true
});
await assert.rejects(
    runGalleryPublicHostRemoteRehearsal({
        bookmarkSink: invalidVerificationLink.bookmarkSink,
        boundaryReader: invalidVerificationLink.boundaryReader,
        d1Runner: invalidVerificationLink.d1Runner,
        fetchImpl: invalidVerificationLink.fetchImpl,
        serviceToken
    }),
    /permanent-receipt-verification-link-invalid/
);

const concurrentReplay = createHarness({ returnReplayOnFirstExact: true });
assert.equal((await runGalleryPublicHostRemoteRehearsal({
    bookmarkSink: concurrentReplay.bookmarkSink,
    boundaryReader: concurrentReplay.boundaryReader,
    d1Runner: concurrentReplay.d1Runner,
    fetchImpl: concurrentReplay.fetchImpl,
    serviceToken
})).status, 'passed');

const responseMismatch = createHarness({ wrongResponseVerificationId: true });
await assert.rejects(
    runGalleryPublicHostRemoteRehearsal({
        bookmarkSink: responseMismatch.bookmarkSink,
        boundaryReader: responseMismatch.boundaryReader,
        d1Runner: responseMismatch.d1Runner,
        fetchImpl: responseMismatch.fetchImpl,
        serviceToken
    }),
    /verification-create-receipt-mismatch/
);

const mediaEvidence = createHarness({ mediaEvidenceDrift: true });
await assert.rejects(
    runGalleryPublicHostRemoteRehearsal({
        bookmarkSink: mediaEvidence.bookmarkSink,
        boundaryReader: mediaEvidence.boundaryReader,
        d1Runner: mediaEvidence.d1Runner,
        fetchImpl: mediaEvidence.fetchImpl,
        serviceToken
    }),
    /synthetic-original-evidence-present/
);

const fixtureIdentityCollision = createHarness({
    initialPhase: 'seeded',
    fixtureIdentityDrift: true
});
await assert.rejects(
    runGalleryPublicHostRemoteRehearsal({
        bookmarkSink: fixtureIdentityCollision.bookmarkSink,
        boundaryReader: fixtureIdentityCollision.boundaryReader,
        d1Runner: fixtureIdentityCollision.d1Runner,
        fetchImpl: fixtureIdentityCollision.fetchImpl,
        serviceToken
    }),
    /synthetic-fixture-identity-invalid/
);

await validateFixtureSqlAgainstRealMigrations();

console.log(
    'Gallery public-host remote rehearsal driver: fixed zero-generation withdrawal, ' +
    'Access failures, stale request, guard failures, replay, lost response, purge, ' +
    'and permanent-survivor boundaries passed.'
);

function createHarness(options = {}) {
    const state = {
        phase: options.initialPhase || 'fresh',
        boundaryDrift: options.boundaryDrift === true,
        invalidReceipt: options.invalidReceipt === true,
        invalidChronology: options.invalidChronology === true,
        invalidCompleteViewCount: options.invalidCompleteViewCount === true,
        invalidVerificationLink: options.invalidVerificationLink === true,
        fixtureIdentityDrift: options.fixtureIdentityDrift === true,
        mediaEvidenceDrift: options.mediaEvidenceDrift === true,
        loseFirstExactResponse: options.loseFirstExactResponse === true,
        lost: false,
        guardLabels: [],
        exactPostCount: 0,
        stalePostCount: 0,
        unauthorizedPostCount: 0,
        credentialedGetCount: 0,
        bookmarkCount: 0,
        boundaryReadCount: 0,
        integrityCount: 0,
        snapshotCount: 0,
        persistedBookmarkPhases: []
    };

    const boundaryReader = async value => {
        assert.deepEqual(Object.keys(value), ['phase']);
        assert.equal(value.phase, state.boundaryReadCount === 0 ? 'before' : 'after');
        state.boundaryReadCount += 1;
        const valueBoundary = boundary();
        if (options.boundaryChangeAfterFirst && state.boundaryReadCount === 2) {
            valueBoundary.approvedMedia.multipartUploadCount = 1;
        }
        return valueBoundary;
    };

    const bookmarkSink = async value => {
        assert.deepEqual(Object.keys(value).sort(), ['bookmark', 'phase']);
        assert.match(value.bookmark, /^[0-9a-f-]{32,160}$/);
        state.persistedBookmarkPhases.push(value.phase);
    };

    const d1Runner = async request => {
        if (request.kind === 'bookmark') {
            state.bookmarkCount += 1;
            return {
                present: true,
                bookmark: `00000000-00000000-00000000-${String(
                    state.bookmarkCount
                ).padStart(32, '0')}`
            };
        }
        if (request.label === 'fixture-snapshot') {
            assert.equal(request.kind, 'snapshot');
            assert.equal(request.sql, sql.snapshot);
            state.snapshotCount += 1;
            return splitSnapshot(snapshot(state));
        }
        if (['integrity-before', 'integrity-after'].includes(request.label)) {
            state.integrityCount += 1;
            return [{ foreignKeyViolationCount: 0, quickCheck: 'ok' }];
        }
        if (request.kind === 'expect-failure') {
            state.guardLabels.push(request.label);
            return { expectedFailure: true, rowsWritten: 0 };
        }
        if (request.label === 'seed-fixture') {
            assert.equal(state.phase, 'fresh');
            state.phase = 'seeded';
            return { success: true };
        }
        if (request.label === 'transition-withdrawn') {
            assert.equal(state.phase, 'verified');
            state.phase = 'withdrawn';
            return { success: true, changedRowCount: 1 };
        }
        if (request.label === 'insert-retention-tombstone') {
            assert.equal(state.phase, 'withdrawn');
            state.phase = 'tombstoned';
            return { success: true, changedRowCount: 1 };
        }
        if (request.label === 'confirm-private-original-deletion') {
            assert.equal(state.phase, 'tombstoned');
            state.phase = 'purge-ready';
            return { success: true, changedRowCount: 1 };
        }
        if (request.label === 'purge-fixture') {
            assert.equal(state.phase, 'purge-ready');
            state.phase = 'complete';
            return { success: true, changedRowCount: 1 };
        }
        throw new Error(`Unexpected D1 request ${request.label}.`);
    };

    const fetchImpl = async (url, request) => {
        const fixtureUrl =
            `${contract.verifierOrigin}/api/service/drafts/${contract.fixture.draftId}` +
            '/public-host-absence-verifications';
        const controlUrl =
            `${contract.verifierOrigin}/api/service/drafts/` +
            `${contract.fixture.accessControlDraftId}/public-host-absence-verifications`;
        assert.equal(request.redirect, 'manual');
        assert.equal(request.cache, 'no-store');
        assert.equal(request.credentials, 'omit');
        const sentClientId = request.headers.get('CF-Access-Client-Id');
        const sentSecret = request.headers.get('CF-Access-Client-Secret');
        if (sentClientId !== clientId || sentSecret !== clientSecret) {
            assert.equal(request.method, 'POST');
            assert.equal(url, controlUrl);
            state.unauthorizedPostCount += 1;
            return response(401, url, null, { 'Cache-Control': 'no-store' });
        }
        if (request.method === 'GET') {
            assert.equal(url, controlUrl);
            state.credentialedGetCount += 1;
            return response(405, url, { error: 'method-not-allowed' }, {
                Allow: 'POST'
            });
        }
        assert.equal(request.method, 'POST');
        assert.equal(url, fixtureUrl);
        const body = JSON.parse(request.body);
        assert.deepEqual(Object.keys(body).sort(), [
            'expectedStateVersion', 'idempotencyKey'
        ]);
        if (body.expectedStateVersion === 0) {
            state.stalePostCount += 1;
            return response(409, url, { error: 'state-or-generation-drift' });
        }
        assert.equal(body.expectedStateVersion, 1);
        assert.equal(body.idempotencyKey, contract.fixture.idempotencyKey);
        const forcedReplay = options.returnReplayOnFirstExact === true &&
            state.exactPostCount === 0;
        state.exactPostCount += 1;
        const replayed = state.phase === 'verified' || forcedReplay;
        if (!replayed || forcedReplay) state.phase = 'verified';
        if (state.loseFirstExactResponse && !state.lost) {
            state.lost = true;
            throw new Error('Synthetic response lost after commit.');
        }
        return response(replayed ? 200 : 201, url, {
            verificationId: options.wrongResponseVerificationId
                ? `hostverify_${'f'.repeat(32)}`
                : verificationId,
            hostDeletionConfirmed: true,
            replayed
        });
    };

    return { state, bookmarkSink, boundaryReader, d1Runner, fetchImpl };
}

function response(status, url, body, extraHeaders = {}) {
    const headers = new Headers({
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json',
        ...extraHeaders
    });
    return {
        status,
        url,
        redirected: false,
        headers,
        async json() {
            if (body === null) throw new Error('No JSON body.');
            return body;
        }
    };
}

function boundary() {
    return {
        verifierWorker: {
            name: contract.verifierWorkerName,
            activeVersions: [{
                versionId: contract.verifierVersion,
                trafficPercent: 100
            }],
            workersDev: true,
            previewUrls: false,
            routeCount: 0,
            customDomainCount: 0,
            bindingCount: 10,
            d1Bindings: [{
                binding: 'DB',
                databaseName: contract.databaseName,
                matchesAdminConfig: true
            }],
            plainTextBindings: {
                PUBLIC_HOST_VERIFIER_ORIGIN: contract.verifierOrigin,
                PUBLIC_HOST_VERIFIER_IDENTITY: `subject:${clientId}`,
                APPROVED_MEDIA_ORIGIN: contract.mediaOrigin,
                MEDIA_CONTRACT: contract.mediaContract,
                EXPECTED_MEDIA_VERSION: contract.mediaVersion,
                MEDIA_WITNESS_KEY: contract.witnessKey,
                MEDIA_WITNESS_SHA256: contract.witnessSha256,
                MEDIA_WITNESS_BYTE_COUNT: String(contract.witnessByteCount),
                MEDIA_WITNESS_CONTENT_TYPE: contract.witnessContentType
            },
            r2Bindings: [],
            versionMetadataBindings: [],
            serviceBindings: [],
            secretBindings: []
        },
        mediaWorker: {
            name: contract.mediaWorkerName,
            activeVersions: [{
                versionId: contract.mediaVersion,
                trafficPercent: 100
            }],
            workersDev: true,
            previewUrls: false,
            routeCount: 0,
            customDomainCount: 0,
            bindingCount: 2,
            d1Bindings: [],
            plainTextBindings: [],
            r2Bindings: [{
                binding: 'APPROVED_MEDIA',
                bucketName: contract.approvedMediaBucketName
            }],
            versionMetadataBindings: [{ binding: 'MEDIA_VERSION' }],
            serviceBindings: [],
            secretBindings: []
        },
        approvedMedia: {
            bucketName: contract.approvedMediaBucketName,
            listComplete: true,
            multipartUploadCount: 0,
            objects: [{
                key: contract.witnessKey,
                sha256: contract.witnessSha256,
                byteCount: contract.witnessByteCount,
                contentType: contract.witnessContentType
            }]
        }
    };
}

function snapshotAliases(statement) {
    return [...statement.matchAll(/\) AS ([A-Za-z][A-Za-z0-9]*)/g)]
        .map(match => match[1]);
}

function splitSnapshot(row) {
    const select = keys => Object.fromEntries(keys.map(key => [key, row[key]]));
    return [[select(coreSnapshotKeys)], [select(evidenceSnapshotKeys)]];
}

function snapshot(state) {
    const fresh = state.phase === 'fresh';
    const complete = state.phase === 'complete';
    const draftPresent = !fresh && !complete;
    const verified = [
        'verified', 'withdrawn', 'tombstoned', 'purge-ready'
    ].includes(state.phase);
    const pendingAttempt = state.phase === 'verification-pending';
    const receiptPresent = verified || complete;
    const verificationPresent = (verified || pendingAttempt) && !complete;
    const hostConfirmed = verified ? 1 : 0;
    const tombstonePresent = ['tombstoned', 'purge-ready', 'complete']
        .includes(state.phase);
    const privateOriginalConfirmed = state.phase === 'purge-ready' ? 1 : 0;
    return {
        epochCount: 1,
        activationCount: 1,
        currentEpochCount: 1,
        epochSequence: 1,
        epochId: contract.epochId,
        epochIdHash: contract.epochIdHash,
        configurationHash: state.boundaryDrift
            ? 'f'.repeat(64)
            : contract.epochConfigurationHash,
        approvedOrigin: contract.mediaOrigin,
        approvedOriginHash: contract.approvedOriginHash,
        deliveryContractHash: contract.deliveryContractHash,
        deliveryVersionHash: contract.deliveryVersionHash,
        witnessObjectKeyHash: contract.witnessObjectKeyHash,
        epochWitnessSha256: contract.witnessSha256,
        epochWitnessByteCount: contract.witnessByteCount,
        epochWitnessContentType: contract.witnessContentType,
        accessControlDraftCount: 0,
        draftCount: draftPresent ? 1 : 0,
        publicItemCount: draftPresent ? 1 : 0,
        draftPublicItemId: draftPresent
            ? (state.fixtureIdentityDrift
                ? 'colliding-public-item'
                : contract.fixture.publicItemId)
            : null,
        draftSiteModesJson: draftPresent ? '["family"]' : null,
        draftExportBundleId: draftPresent
            ? 'synthetic-public-host-bundle-0001'
            : null,
        draftSourceRevision: draftPresent
            ? 'synthetic-public-host-source-0001'
            : null,
        draftSuppressionRevision: draftPresent
            ? 'synthetic-public-host-suppression-0001'
            : null,
        draftItemRevision: draftPresent
            ? 'synthetic-public-host-item-0001'
            : null,
        draftMediaType: draftPresent ? 'photo' : null,
        draftRaceDate: draftPresent ? '2026-08-31' : null,
        draftRaceEvent: draftPresent ? 'Synthetic verifier rehearsal' : null,
        draftRaceDistance: draftPresent ? '5 km' : null,
        draftAthleteIdsJson: draftPresent ? '[]' : null,
        draftTitle: draftPresent ? 'Synthetic verifier rehearsal' : null,
        draftCaption: draftPresent
            ? 'Synthetic bytes are never created.'
            : null,
        draftAltText: draftPresent
            ? 'No media is attached to this synthetic verifier rehearsal.'
            : null,
        draftFeatured: draftPresent ? 0 : null,
        draftOwnerIdentityHash: draftPresent
            ? '6aada308af25d06b2ff0158a38297a078bd371a72f612db7a18c6f49a5a6f061'
            : null,
        draftCreatedAt: draftPresent ? '2026-08-31T18:00:00.000Z' : null,
        draftState: draftPresent
            ? (['withdrawn', 'tombstoned', 'purge-ready'].includes(state.phase)
                ? 'withdrawn'
                : 'withdrawal-pending')
            : null,
        draftStateVersion: draftPresent
            ? (['withdrawn', 'tombstoned', 'purge-ready'].includes(state.phase)
                ? 2
                : 1)
            : null,
        draftUpdatedAt: draftPresent
            ? (['withdrawn', 'tombstoned', 'purge-ready'].includes(state.phase)
                ? '2026-08-31T18:00:02.000Z'
                : '2026-08-31T18:00:00.001Z')
            : null,
        activeConsentRevision: null,
        originalObjectKey: state.mediaEvidenceDrift && draftPresent
            ? 'private/originals/forbidden'
            : null,
        originalDetectedType: null,
        originalByteCount: null,
        originalSha256: null,
        uploadComplete: draftPresent ? 0 : null,
        processingDiagnosticsJson: null,
        consentAttestationCount: 0,
        uploadSessionCount: 0,
        derivativeCount: 0,
        processingRunCount: 0,
        processingCleanupCount: 0,
        photoPromotionCount: 0,
        photoPromotionCleanupCount: 0,
        publicationCount: draftPresent ? 1 : 0,
        withdrawalKind: draftPresent ? 'editorial-removal' : null,
        hostDeletionConfirmed: draftPresent ? hostConfirmed : null,
        privateOriginalDeletionConfirmed: draftPresent
            ? privateOriginalConfirmed
            : null,
        publicationUpdatedAt: draftPresent
            ? (privateOriginalConfirmed
                ? '2026-08-31T18:00:04.000Z'
                : (verified
                    ? '2026-08-31T18:00:01.000Z'
                    : '2026-08-31T18:00:00.002Z'))
            : null,
        tombstoneCount: tombstonePresent ? 1 : 0,
        tombstonePurgeKind: tombstonePresent ? 'retention-expiry' : null,
        tombstoneEligibleAt: tombstonePresent
            ? (state.invalidChronology
                ? '2026-08-31T18:00:01.000Z'
                : '2026-08-31T18:00:02.000Z')
            : null,
        tombstoneApprovedAt: tombstonePresent
            ? '2026-08-31T18:00:03.000Z'
            : null,
        tombstoneActorHash: tombstonePresent
            ? '69440871111849a21b4252a00fd94364b58f667ed652d7bf700a92613c0e125a'
            : null,
        tombstoneEvidenceHash: tombstonePresent
            ? '9a7bad515451128d99de9548ceaba3a57292fb2308c6708850bfffb24092bfa4'
            : null,
        verificationCount: verificationPresent ? 1 : 0,
        verificationId: verificationPresent ? verificationId : null,
        witnessProofCount: verified && !complete ? 1 : 0,
        targetProofCount: 0,
        reservationCount: 0,
        receiptCount: receiptPresent ? 1 : 0,
        receiptFinalHash: receiptPresent ? 'c'.repeat(64) : null,
        receiptVerificationIdHash: receiptPresent ? verificationIdHash : null,
        receiptDraftIdHash: receiptPresent
            ? 'e60923d2acf7fa6cf1c442cfe064e00bd70bf3c2b09a5c7f3adff5f49f4fe8d5'
            : null,
        receiptPromotionSetHash: receiptPresent ? 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' : null,
        receiptCleanupSetHash: receiptPresent ? 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' : null,
        receiptWithdrawalCycleHash: receiptPresent
            ? contract.withdrawalCycleHash
            : null,
        receiptApprovedOriginHash: receiptPresent ? contract.approvedOriginHash : null,
        receiptTargetSetHash: receiptPresent ? 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' : null,
        receiptGenerationCount: receiptPresent ? 0 : null,
        receiptTargetCount: receiptPresent ? 0 : null,
        receiptStateVersion: receiptPresent ? 1 : null,
        receiptPurpose: receiptPresent ? 'withdrawal' : null,
        receiptPurposeEvidenceHash: null,
        receiptEpochIdHash: receiptPresent ? contract.epochIdHash : null,
        receiptDeliveryContractHash: receiptPresent ? contract.deliveryContractHash : null,
        receiptDeliveryVersionHash: receiptPresent
            ? (state.invalidReceipt ? 'f'.repeat(64) : contract.deliveryVersionHash)
            : null,
        receiptIdempotencyKeyHash: receiptPresent
            ? '1d2572925099f00ac9f98fe9b3b7915a078d75f03a8e883926822b3187e4a693'
            : null,
        receiptPayloadFingerprint: receiptPresent
            ? (state.invalidVerificationLink ? 'c'.repeat(64) : 'b'.repeat(64))
            : null,
        receiptVerifiedAt: receiptPresent ? '2026-08-31T18:00:01.000Z' : null,
        completeReceiptCount: state.invalidCompleteViewCount && complete
            ? 1
            : (verified && !complete ? 1 : 0),
        currentReceiptCount: verified && !complete ? 1 : 0,
        generationCount: 0,
        generationTargetCount: 0,
        receiptPurposeWithdrawalCount: receiptPresent ? 1 : 0,
        receiptEmptyHashCount: receiptPresent ? 1 : 0,
        forbiddenReceiptColumnCount: 0,
        globalVerificationCount: verificationPresent ? 1 : 0,
        globalWitnessProofCount: verified && !complete ? 1 : 0,
        globalTargetProofCount: 0,
        globalReservationCount: 0,
        globalReceiptCount: receiptPresent ? 1 : 0,
        globalGenerationCount: 0,
        globalGenerationTargetCount: 0,
        globalTrueHostScalarCount: hostConfirmed,
        globalTombstoneCount: tombstonePresent ? 1 : 0
    };
}

async function validateFixtureSqlAgainstRealMigrations() {
    const database = new DatabaseSync(':memory:');
    try {
        for (let index = 1; index <= 9; index += 1) {
            const prefix = String(index).padStart(4, '0');
            const names = [
                'private_gallery',
                'private_uploads',
                'private_original_v1_keys',
                'private_processing_staging',
                'private_processing_cleanup',
                'transition_receipt_state_version',
                'photo_promotion',
                'photo_promotion_cleanup',
                'public_host_verification'
            ];
            const migration = await readFile(new URL(
                `../gallery-admin/migrations/${prefix}_${names[index - 1]}.sql`,
                import.meta.url
            ), 'utf8');
            database.exec(migration);
        }
        database.exec(sql.seed);
        const seeded = {
            ...database.prepare(sql.snapshotCore).get(),
            ...database.prepare(sql.snapshotEvidence).get()
        };
        assert.equal(seeded.draftCount, 1);
        assert.equal(seeded.draftState, 'withdrawal-pending');
        assert.equal(seeded.draftStateVersion, 1);
        assert.equal(seeded.privateOriginalDeletionConfirmed, 0);
        assert.equal(seeded.tombstoneCount, 0);
        assert.throws(
            () => database.exec(sql.guardScalar),
            /host deletion confirmation requires a current complete receipt/
        );
        assert.throws(
            () => database.exec(sql.guardWithdrawal),
            /current complete public-host absence receipt is required/
        );
        assert.throws(
            () => database.exec(sql.guardPurge),
            /current public-host absence evidence/
        );
        assert.equal(database.prepare(
            'SELECT state FROM gallery_drafts WHERE draft_id = ?'
        ).get(contract.fixture.draftId).state, 'withdrawal-pending');
        assert.equal(
            database.prepare('PRAGMA quick_check').get().quick_check,
            'ok'
        );
    } finally {
        database.close();
    }
}
