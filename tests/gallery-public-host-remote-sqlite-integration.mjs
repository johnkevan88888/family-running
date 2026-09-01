import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

import sharp from 'sharp';

import {
    MEDIA_DELIVERY_CONTRACT_HEADER,
    MEDIA_DELIVERY_VERSION_HEADER
} from '../gallery-admin/src/media-delivery-contract.js';
import { verifyPublicHostAbsence } from
    '../gallery-admin/src/public-host-verifier-service.js';
import {
    galleryPublicHostRemoteRehearsalContract as contract,
    galleryPublicHostRemoteRehearsalSql as rehearsalSql,
    galleryPublicHostRemoteRehearsalTestHooks as rehearsalTestHooks
} from '../scripts/rehearse-gallery-public-host-remote.mjs';

const database = new DatabaseSync(':memory:');

try {
    await applyMigrations(database);
    seedCurrentDeliveryEpoch(database);
    const freshSnapshot = readSplitSnapshot(database);
    assert.equal(freshSnapshot.draftCount, 0);
    assert.equal(freshSnapshot.receiptCount, 0);
    assert.equal(freshSnapshot.tombstoneCount, 0);
    assertDraftIdentityNull(freshSnapshot);
    database.exec(rehearsalSql.seed);

    const seededSnapshot = readSplitSnapshot(database);
    assert.equal(seededSnapshot.draftCount, 1);
    assert.equal(seededSnapshot.receiptCount, 0);
    assertSyntheticPrivateAbsence(database);
    assertGuardFailure(
        database,
        rehearsalSql.guardScalar,
        /host deletion confirmation requires a current complete receipt/
    );
    assertGuardFailure(
        database,
        rehearsalSql.guardWithdrawal,
        /current complete public-host absence receipt is required/
    );
    assertGuardFailure(
        database,
        rehearsalSql.guardPurge,
        /gallery draft purge requires current public-host absence evidence/
    );

    const serviceSubject = `${'a'.repeat(32)}.access`;
    const witnessBody = await createWitnessBody();
    const publicFetch = createExactPublicFetch(witnessBody);
    const environment = createVerifierEnvironment(
        createSqliteD1(database),
        serviceSubject
    );
    const requestStartedAt = Date.now() - 5_000;
    const stale = await verifyPublicHostAbsence(
        environment,
        { type: 'service', subject: serviceSubject },
        contract.fixture.draftId,
        {
            expectedStateVersion: 0,
            idempotencyKey: `${contract.fixture.idempotencyKey}-stale`
        },
        requestStartedAt,
        { fetch: publicFetch, now: () => requestStartedAt }
    );
    assert.deepEqual(stale, {
        ok: false,
        status: 409,
        code: 'state-or-generation-drift'
    });
    assert.equal(publicFetch.calls.length, 0);

    const verified = await verifyPublicHostAbsence(
        environment,
        { type: 'service', subject: serviceSubject },
        contract.fixture.draftId,
        {
            expectedStateVersion: 1,
            idempotencyKey: contract.fixture.idempotencyKey
        },
        requestStartedAt,
        { fetch: publicFetch, now: () => requestStartedAt }
    );
    assert.equal(verified.ok, true, JSON.stringify(verified));
    assert.equal(verified.status, 201);
    assert.equal(verified.hostDeletionConfirmed, true);
    assert.equal(verified.replayed, false);
    assert.match(verified.verificationId, /^hostverify_[a-f0-9]{32}$/);
    assert.equal(publicFetch.calls.length, 4);

    const receiptBeforeWithdrawal = exactReceipt(database);
    assert.equal(receiptBeforeWithdrawal.verificationPurpose, 'withdrawal');
    assert.equal(receiptBeforeWithdrawal.purposeEvidenceHash, null);
    assert.equal(receiptBeforeWithdrawal.generationCount, 0);
    assert.equal(receiptBeforeWithdrawal.targetCount, 0);
    assert.equal(receiptBeforeWithdrawal.verifiedStateVersion, 1);
    assert.equal(receiptBeforeWithdrawal.draftIdHash, sha256(
        `draft-id:${contract.fixture.draftId}`
    ));
    assert.equal(receiptBeforeWithdrawal.idempotencyKeyHash, sha256(
        `public-host-absence-idempotency-key:${contract.fixture.idempotencyKey}`
    ));
    assert.equal(receiptBeforeWithdrawal.promotionSetHash, sha256(''));
    assert.equal(receiptBeforeWithdrawal.cleanupEvidenceSetHash, sha256(''));
    assert.equal(receiptBeforeWithdrawal.targetSetHash, sha256(''));
    assert.equal(receiptBeforeWithdrawal.mediaDeliveryEpochIdHash, contract.epochIdHash);
    assert.equal(receiptBeforeWithdrawal.deliveryContractHash, sha256(
        `approved-media-contract:${contract.mediaContract}`
    ));
    assert.equal(receiptBeforeWithdrawal.deliveryVersionHash, sha256(
        `approved-media-version:${contract.mediaVersion}`
    ));
    assert.equal(count(database, 'draft_public_host_absence_verifications'), 1);
    assert.equal(count(database, 'draft_public_host_absence_witness_proofs'), 1);
    assert.equal(count(database, 'draft_public_host_absence_target_proofs'), 0);
    assert.equal(count(
        database,
        'gallery_approved_media_key_retirement_reservations'
    ), 0);
    assert.deepEqual(publicationState(database), {
        hostDeletionConfirmed: 1,
        privateOriginalDeletionConfirmed: 0,
        withdrawalKind: 'editorial-removal'
    });

    const replayed = await verifyPublicHostAbsence(
        environment,
        { type: 'service', subject: serviceSubject },
        contract.fixture.draftId,
        {
            expectedStateVersion: 1,
            idempotencyKey: contract.fixture.idempotencyKey
        },
        requestStartedAt + 1,
        { fetch: publicFetch, now: () => requestStartedAt + 1 }
    );
    assert.deepEqual(replayed, {
        ok: true,
        status: 200,
        verificationId: verified.verificationId,
        hostDeletionConfirmed: true,
        replayed: true
    });
    assert.equal(publicFetch.calls.length, 4);

    database.exec(rehearsalSql.transitionWithdrawn);
    const withdrawn = draftState(database);
    assert.equal(withdrawn.state, 'withdrawn');
    assert.equal(withdrawn.stateVersion, 2);
    assert.ok(
        withdrawn.updatedAt > receiptBeforeWithdrawal.verifiedAt,
        'Withdrawal time must follow its authorizing receipt.'
    );
    assertGuardFailure(
        database,
        rehearsalSql.guardPurge,
        /gallery draft purge requires current public-host absence evidence/
    );

    database.exec(rehearsalSql.insertTombstone);
    const tombstone = { ...database.prepare(`
        SELECT purge_kind AS purgeKind, eligible_at AS eligibleAt,
            approved_at AS approvedAt,
            approved_by_identity_hash AS approvedByIdentityHash,
            evidence_hash AS evidenceHash
        FROM gallery_retention_tombstones WHERE draft_id = ?
    `).get(contract.fixture.draftId) };
    assert.equal(tombstone.purgeKind, 'retention-expiry');
    assert.match(tombstone.evidenceHash, /^[a-f0-9]{64}$/);
    assert.ok(tombstone.eligibleAt <= tombstone.approvedAt);
    assert.ok(
        tombstone.approvedAt > withdrawn.updatedAt,
        'Retention approval time must follow withdrawal.'
    );
    assertGuardFailure(
        database,
        rehearsalSql.guardPurge,
        /gallery draft purge requires current public-host absence evidence/
    );

    assertSyntheticPrivateAbsence(database);
    database.exec(rehearsalSql.confirmPrivateOriginalDeletion);
    const publicationBeforePurge = database.prepare(`
        SELECT host_deletion_confirmed AS hostDeletionConfirmed,
            private_original_deletion_confirmed AS privateOriginalDeletionConfirmed,
            updated_at AS updatedAt
        FROM draft_publication_references WHERE draft_id = ?
    `).get(contract.fixture.draftId);
    assert.equal(publicationBeforePurge.hostDeletionConfirmed, 1);
    assert.equal(publicationBeforePurge.privateOriginalDeletionConfirmed, 1);
    assert.ok(
        publicationBeforePurge.updatedAt > tombstone.approvedAt,
        'Private-original confirmation time must follow retention approval.'
    );

    database.exec(rehearsalSql.purge);
    assert.equal(count(database, 'gallery_drafts'), 0);
    assert.equal(count(database, 'draft_publication_references'), 0);
    assert.equal(count(database, 'draft_public_host_absence_verifications'), 0);
    assert.equal(count(database, 'draft_public_host_absence_witness_proofs'), 0);
    assert.equal(count(database, 'draft_public_host_absence_target_proofs'), 0);
    assert.equal(count(database, 'draft_photo_public_generations'), 0);
    assert.equal(count(database, 'draft_photo_public_generation_targets'), 0);
    assert.equal(count(
        database,
        'gallery_approved_media_key_retirement_reservations'
    ), 0);
    assert.equal(count(database, 'gallery_public_host_absence_receipts'), 1);
    assert.equal(count(database, 'gallery_retention_tombstones'), 1);
    assert.equal(count(database, 'gallery_media_delivery_epochs'), 1);
    assert.equal(count(database, 'gallery_media_delivery_epoch_activations'), 1);
    assert.equal(count(database, 'gallery_media_delivery_current_epoch'), 1);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(database.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    const purgedSnapshot = readSplitSnapshot(database);
    assert.equal(purgedSnapshot.draftCount, 0);
    assert.equal(purgedSnapshot.receiptCount, 1);
    assert.equal(purgedSnapshot.tombstoneCount, 1);
    assertDraftIdentityNull(purgedSnapshot);

    const survivingReceipt = exactReceipt(database);
    assert.deepEqual(survivingReceipt, receiptBeforeWithdrawal);
    assert.deepEqual({ ...database.prepare(`
        SELECT purge_kind AS purgeKind, eligible_at AS eligibleAt,
            approved_at AS approvedAt,
            approved_by_identity_hash AS approvedByIdentityHash,
            evidence_hash AS evidenceHash
        FROM gallery_retention_tombstones WHERE draft_id = ?
    `).get(contract.fixture.draftId) }, tombstone);

    console.log(
        'Gallery public-host remote fixture SQLite/service integration: real ' +
        'migrations and verifier passed zero-generation receipt, withdrawal, ' +
        'two purge guards, private-original proof, purge, and survivor checks.'
    );
} finally {
    database.close();
}

async function applyMigrations(target) {
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
    for (const [index, name] of names.entries()) {
        const prefix = String(index + 1).padStart(4, '0');
        const migration = await readFile(new URL(
            `../gallery-admin/migrations/${prefix}_${name}.sql`,
            import.meta.url
        ), 'utf8');
        target.exec(migration);
    }
}

function seedCurrentDeliveryEpoch(target) {
    const approvedOriginHash = sha256(
        `approved-media-origin:${contract.mediaOrigin}`
    );
    const deliveryContractHash = sha256(
        `approved-media-contract:${contract.mediaContract}`
    );
    const deliveryVersionHash = sha256(
        `approved-media-version:${contract.mediaVersion}`
    );
    const witnessObjectKeyHash = sha256(
        `approved-object-key:${contract.witnessKey}`
    );
    const actorIdentityHash = sha256('remote-fixture-sqlite-epoch-actor');
    const activationReceiptHash = sha256(
        `remote-fixture-sqlite-activation:${contract.epochIdHash}`
    );
    const registeredAt = '2026-08-31T17:59:00.000Z';
    const activatedAt = '2026-08-31T17:59:00.001Z';
    target.prepare(`
        INSERT INTO gallery_media_delivery_epochs (
            epoch_id, epoch_id_hash, epoch_sequence, approved_origin,
            approved_origin_hash, delivery_contract_hash,
            delivery_version_hash, witness_object_key_hash, witness_sha256,
            witness_byte_count, witness_content_type, configuration_hash,
            registered_by_identity_hash, registered_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        contract.epochId,
        contract.epochIdHash,
        contract.mediaOrigin,
        approvedOriginHash,
        deliveryContractHash,
        deliveryVersionHash,
        witnessObjectKeyHash,
        contract.witnessSha256,
        contract.witnessByteCount,
        contract.witnessContentType,
        contract.epochConfigurationHash,
        actorIdentityHash,
        registeredAt
    );
    target.prepare(`
        INSERT INTO gallery_media_delivery_epoch_activations (
            activation_receipt_hash, epoch_id_hash, epoch_sequence,
            previous_epoch_id_hash, activation_idempotency_key_hash,
            activation_payload_hash, service_actor_identity_hash, activated_at
        ) VALUES (?, ?, 1, NULL, ?, ?, ?, ?)
    `).run(
        activationReceiptHash,
        contract.epochIdHash,
        sha256(`remote-fixture-sqlite-activation-idempotency:${contract.epochIdHash}`),
        sha256(`remote-fixture-sqlite-activation-payload:${contract.epochIdHash}`),
        actorIdentityHash,
        activatedAt
    );
    target.prepare(`
        INSERT INTO gallery_media_delivery_current_epoch (
            singleton_id, epoch_id_hash, epoch_sequence,
            activation_receipt_hash, activated_at
        ) VALUES (1, ?, 1, ?, ?)
    `).run(contract.epochIdHash, activationReceiptHash, activatedAt);
}

function createVerifierEnvironment(d1, serviceSubject) {
    return {
        APPROVED_MEDIA_ORIGIN: contract.mediaOrigin,
        DB: d1,
        EXPECTED_MEDIA_VERSION: contract.mediaVersion,
        MEDIA_CONTRACT: contract.mediaContract,
        MEDIA_WITNESS_BYTE_COUNT: String(contract.witnessByteCount),
        MEDIA_WITNESS_CONTENT_TYPE: contract.witnessContentType,
        MEDIA_WITNESS_KEY: contract.witnessKey,
        MEDIA_WITNESS_SHA256: contract.witnessSha256,
        PUBLIC_HOST_VERIFIER_IDENTITY: `subject:${serviceSubject}`,
        PUBLIC_HOST_VERIFIER_ORIGIN: contract.verifierOrigin
    };
}

async function createWitnessBody() {
    const bytes = await sharp(
        Buffer.from([0, 0, 0, 0]),
        { raw: { width: 1, height: 1, channels: 4 } }
    ).webp({
        lossless: true,
        quality: 100,
        effort: 6,
        alphaQuality: 100,
        smartSubsample: false
    }).toBuffer();
    assert.equal(bytes.byteLength, contract.witnessByteCount);
    assert.equal(sha256(bytes), contract.witnessSha256);
    return bytes;
}

function createExactPublicFetch(witnessBody) {
    const calls = [];
    const fetcher = async request => {
        assert.equal(request.redirect, 'manual');
        assert.equal(request.cache, 'no-store');
        assert.equal(request.credentials, 'omit');
        assert.equal(request.headers.get('Cache-Control'), 'no-cache, no-store');
        assert.equal(request.headers.get('Pragma'), 'no-cache');
        assert.equal(request.headers.get('Authorization'), null);
        assert.equal(request.headers.get('Cookie'), null);
        assert.equal(request.headers.get('Cf-Access-Jwt-Assertion'), null);
        assert.equal(
            request.url,
            `${contract.mediaOrigin}/${contract.witnessKey}`
        );
        assert.ok(['HEAD', 'GET'].includes(request.method));
        calls.push({ method: request.method, url: request.url });

        const headers = new Headers({
            'Cache-Control': 'no-store',
            'Content-Length': String(contract.witnessByteCount),
            'Content-Type': contract.witnessContentType,
            [MEDIA_DELIVERY_CONTRACT_HEADER]: contract.mediaContract,
            [MEDIA_DELIVERY_VERSION_HEADER]: contract.mediaVersion
        });
        const response = new Response(
            request.method === 'HEAD' ? null : witnessBody,
            { status: 200, headers }
        );
        Object.defineProperty(response, 'url', { value: request.url });
        Object.defineProperty(response, 'redirected', { value: false });
        return response;
    };
    fetcher.calls = calls;
    return fetcher;
}

function createSqliteD1(target) {
    class Statement {
        constructor(sql, bindings = []) {
            this.sql = sql;
            this.bindings = bindings;
        }

        bind(...bindings) {
            return new Statement(this.sql, bindings);
        }

        async first(columnName) {
            const row = target.prepare(this.sql).get(...this.bindings) ?? null;
            return columnName === undefined || row === null ? row : row[columnName];
        }

        async all() {
            return {
                success: true,
                results: target.prepare(this.sql).all(...this.bindings)
            };
        }

        runSynchronously() {
            const result = target.prepare(this.sql).run(...this.bindings);
            return {
                success: true,
                meta: {
                    changes: Number(result.changes),
                    last_row_id: Number(result.lastInsertRowid)
                }
            };
        }
    }

    return {
        prepare(sql) {
            return new Statement(sql);
        },
        async batch(statements) {
            target.exec('BEGIN IMMEDIATE');
            try {
                const results = statements.map(statement =>
                    statement.runSynchronously()
                );
                target.exec('COMMIT');
                return results;
            } catch (error) {
                target.exec('ROLLBACK');
                throw error;
            }
        }
    };
}

function readSplitSnapshot(target) {
    const core = { ...target.prepare(rehearsalSql.snapshotCore).get() };
    const evidence = { ...target.prepare(rehearsalSql.snapshotEvidence).get() };
    const coreKeys = Object.keys(core);
    const evidenceKeys = Object.keys(evidence);
    assert.equal(coreKeys.length, 52);
    assert.equal(evidenceKeys.length, 52);
    assert.ok(coreKeys.length <= 64);
    assert.ok(evidenceKeys.length <= 64);
    assert.equal(
        coreKeys.some(key => Object.hasOwn(evidence, key)),
        false,
        'Split snapshot result keys must be disjoint.'
    );
    assert.equal(
        rehearsalSql.snapshot,
        `${rehearsalSql.snapshotCore}\n${rehearsalSql.snapshotEvidence}`
    );
    return rehearsalTestHooks.mergeSnapshotParts([[core], [evidence]])[0];
}

function assertDraftIdentityNull(snapshot) {
    for (const key of [
        'draftPublicItemId', 'draftSiteModesJson', 'draftExportBundleId',
        'draftSourceRevision', 'draftSuppressionRevision', 'draftItemRevision',
        'draftMediaType', 'draftRaceDate', 'draftRaceEvent', 'draftRaceDistance',
        'draftAthleteIdsJson', 'draftTitle', 'draftCaption', 'draftAltText',
        'draftFeatured', 'draftOwnerIdentityHash', 'draftCreatedAt'
    ]) {
        assert.equal(snapshot[key], null, `${key} must be null without the draft.`);
    }
}

function assertSyntheticPrivateAbsence(target) {
    const draft = target.prepare(`
        SELECT active_consent_revision AS activeConsentRevision,
            original_object_key AS originalObjectKey,
            original_detected_type AS originalDetectedType,
            original_byte_count AS originalByteCount,
            original_sha256 AS originalSha256,
            upload_complete AS uploadComplete,
            processing_diagnostics_json AS processingDiagnosticsJson
        FROM gallery_drafts WHERE draft_id = ?
    `).get(contract.fixture.draftId);
    assert.deepEqual({ ...draft }, {
        activeConsentRevision: null,
        originalObjectKey: null,
        originalDetectedType: null,
        originalByteCount: null,
        originalSha256: null,
        uploadComplete: 0,
        processingDiagnosticsJson: null
    });
    for (const table of [
        'draft_consent_attestations',
        'draft_upload_sessions',
        'draft_derivatives',
        'draft_processing_runs',
        'draft_processing_cleanups',
        'draft_photo_promotions',
        'draft_photo_promotion_cleanups',
        'draft_photo_public_generations'
    ]) {
        assert.equal(countWhereDraft(target, table), 0, `${table} must be empty.`);
    }
}

function countWhereDraft(target, table) {
    return target.prepare(
        `SELECT COUNT(*) AS count FROM ${table} WHERE draft_id = ?`
    ).get(contract.fixture.draftId).count;
}

function assertGuardFailure(target, sql, expected) {
    assert.throws(() => target.exec(sql), expected);
}

function exactReceipt(target) {
    return { ...target.prepare(`
        SELECT final_receipt_hash AS finalReceiptHash,
            verification_id_hash AS verificationIdHash,
            draft_id_hash AS draftIdHash,
            promotion_set_hash AS promotionSetHash,
            cleanup_evidence_set_hash AS cleanupEvidenceSetHash,
            withdrawal_cycle_hash AS withdrawalCycleHash,
            approved_origin_hash AS approvedOriginHash,
            target_set_hash AS targetSetHash,
            generation_count AS generationCount,
            target_count AS targetCount,
            verified_state_version AS verifiedStateVersion,
            verification_purpose AS verificationPurpose,
            purpose_evidence_hash AS purposeEvidenceHash,
            media_delivery_epoch_id_hash AS mediaDeliveryEpochIdHash,
            delivery_contract_hash AS deliveryContractHash,
            delivery_version_hash AS deliveryVersionHash,
            idempotency_key_hash AS idempotencyKeyHash,
            payload_fingerprint AS payloadFingerprint,
            verified_at AS verifiedAt
        FROM gallery_public_host_absence_receipts
        WHERE draft_id_hash = ?
    `).get(sha256(`draft-id:${contract.fixture.draftId}`)) };
}

function publicationState(target) {
    return { ...target.prepare(`
        SELECT host_deletion_confirmed AS hostDeletionConfirmed,
            private_original_deletion_confirmed AS privateOriginalDeletionConfirmed,
            withdrawal_kind AS withdrawalKind
        FROM draft_publication_references WHERE draft_id = ?
    `).get(contract.fixture.draftId) };
}

function draftState(target) {
    return { ...target.prepare(`
        SELECT state, state_version AS stateVersion, updated_at AS updatedAt
        FROM gallery_drafts WHERE draft_id = ?
    `).get(contract.fixture.draftId) };
}

function count(target, table) {
    return target.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}
