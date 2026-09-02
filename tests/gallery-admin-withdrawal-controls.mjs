import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

import catalogSnapshot from '../gallery-admin/generated/catalog-snapshot.js';
import { handleAdminRequest } from '../gallery-admin/src/admin-worker.js';
import {
    initiateAthleteExclusion,
    initiateDraftWithdrawal
} from '../gallery-admin/src/withdrawal-service.js';

const adminOrigin = 'https://synthetic-withdrawal-admin.example';
const ownerIdentity = { type: 'browser', subject: 'synthetic-withdrawal-owner' };
const fixedNow = Date.UTC(2026, 8, 2, 15, 0, 0);
const migrationNames = [
    '0001_private_gallery.sql',
    '0002_private_uploads.sql',
    '0003_private_original_v1_keys.sql',
    '0004_private_processing_staging.sql',
    '0005_private_processing_cleanup.sql',
    '0006_transition_receipt_state_version.sql',
    '0007_photo_promotion.sql',
    '0008_photo_promotion_cleanup.sql',
    '0009_public_host_verification.sql',
    '0010_photo_intake_review_bridge.sql',
    '0011_photo_review_invalidation.sql',
    '0012_owner_withdrawal_exclusion_receipts.sql'
];
const migrationSources = await Promise.all(migrationNames.map(name => readFile(
    new URL(`../gallery-admin/migrations/${name}`, import.meta.url),
    'utf8'
)));
const sqlite = new DatabaseSync(':memory:');
for (const source of migrationSources) {
    sqlite.exec(source);
}
const d1 = createSqliteD1(sqlite);
const env = {
    ADMIN_ORIGIN: adminOrigin,
    OWNER_IDENTITIES: `subject:${ownerIdentity.subject}`,
    SESSION_SECRET: 'synthetic-withdrawal-session-secret-0123456789abcdef',
    DB: d1
};
let currentNow = fixedNow;

const familyIds = new Set(catalogSnapshot.sites.family.rosterEntries.map(
    entry => entry.athleteId
));
const everyoneIds = new Set(catalogSnapshot.sites.everyone.rosterEntries.map(
    entry => entry.athleteId
));
const sharedAthleteIds = [...familyIds].filter(id => everyoneIds.has(id)).sort();
assert.ok(sharedAthleteIds.length >= 4);
const [
    editorialAthleteId,
    excludedAthleteId,
    companionAthleteId,
    proactiveAthleteId
] = sharedAthleteIds;

const editorialDraftId = 'draft_00000000-0000-4000-8000-000000000101';
const exclusionFamilyDraftId = 'draft_00000000-0000-4000-8000-000000000102';
const exclusionEveryoneDraftId = 'draft_00000000-0000-4000-8000-000000000103';
insertDraft(sqlite, editorialDraftId, 'family', [editorialAthleteId]);
insertDraft(
    sqlite,
    exclusionFamilyDraftId,
    'family',
    [excludedAthleteId, companionAthleteId]
);
insertDraft(sqlite, exclusionEveryoneDraftId, 'everyone', [excludedAthleteId]);

const sessionResponse = await ownerRequest('/api/browser/session?site=family');
assert.equal(sessionResponse.status, 200);
const sessionBody = await sessionResponse.json();
const ownerSession = {
    cookie: sessionResponse.headers.get('Set-Cookie').split(';', 1)[0],
    csrfToken: sessionBody.csrfToken
};

const editorialPath =
    `/api/browser/drafts/${editorialDraftId}/editorial-withdrawal?site=family`;
const editorialInput = {
    expectedStateVersion: 0,
    idempotencyKey: 'editorial-withdrawal-0001'
};

// The new routes inherit the same signed session, exact area, same-origin, and
// CSRF boundary as every other owner mutation.
assert.equal((await ownerRequest(editorialPath, {
    method: 'POST',
    session: true,
    csrf: false,
    json: editorialInput
})).status, 403);
assert.equal((await ownerRequest(editorialPath, {
    method: 'POST',
    json: editorialInput
})).status, 403);
assert.equal((await ownerRequest(editorialPath, {
    method: 'POST',
    session: true,
    json: editorialInput,
    headers: { Origin: 'https://wrong-origin.example' }
})).status, 403);
assert.equal((await ownerRequest(editorialPath, {
    method: 'POST',
    session: true,
    json: { ...editorialInput, reason: 'must-not-enter-private-storage' }
})).status, 400);

const editorialResponse = await ownerRequest(editorialPath, {
    method: 'POST',
    session: true,
    json: editorialInput
});
assert.equal(editorialResponse.status, 200);
assert.deepEqual(await editorialResponse.json(), {
    replayed: false,
    affectedDraftIds: [editorialDraftId]
});
assert.deepEqual(readDraftState(sqlite, editorialDraftId), {
    state: 'withdrawal-pending',
    state_version: 1
});
assert.equal(readWithdrawalKind(sqlite, editorialDraftId), 'editorial-removal');
assert.equal(countRows(sqlite, 'draft_transition_receipts', editorialDraftId), 1);
assert.equal(countRows(sqlite, 'gallery_audit_events'), 1);

const editorialReplay = await ownerRequest(editorialPath, {
    method: 'POST',
    session: true,
    json: editorialInput
});
assert.equal(editorialReplay.status, 200);
assert.deepEqual(await editorialReplay.json(), {
    replayed: true,
    affectedDraftIds: [editorialDraftId]
});
assert.equal(countRows(sqlite, 'draft_transition_receipts', editorialDraftId), 1);

// Consent withdrawal is the only permitted escalation of an existing removal
// intent. It records intent only: final withdrawal still fails without the
// existing host and private-original deletion evidence.
const consentInput = {
    expectedStateVersion: 1,
    idempotencyKey: 'consent-withdrawal-0001'
};
const consentPath =
    `/api/browser/drafts/${editorialDraftId}/consent-withdrawal?site=family`;
const consentResponse = await ownerRequest(consentPath, {
    method: 'POST',
    session: true,
    json: consentInput
});
assert.equal(consentResponse.status, 200);
assert.deepEqual(await consentResponse.json(), {
    replayed: false,
    affectedDraftIds: [editorialDraftId]
});
assert.equal(readWithdrawalKind(sqlite, editorialDraftId), 'consent-withdrawal');
assert.deepEqual(readDraftState(sqlite, editorialDraftId), {
    state: 'withdrawal-pending',
    state_version: 1
});
const consentReplay = await ownerRequest(consentPath, {
    method: 'POST',
    session: true,
    json: consentInput
});
assert.equal(consentReplay.status, 200);
assert.equal((await consentReplay.json()).replayed, true);
assert.throws(() => sqlite.prepare(
    "UPDATE gallery_drafts SET state = 'withdrawn', state_version = 2 WHERE draft_id = ?"
).run(editorialDraftId), /public-host absence receipt|verified withdrawal evidence/i);

// Athlete-wide exclusion is proactive: any current server-catalog athlete can
// be excluded before a Gallery item uses the tag.
const exclusionPath = '/api/browser/athlete-exclusions?site=family';
const proactiveInput = {
    athleteId: proactiveAthleteId,
    idempotencyKey: 'proactive-athlete-exclusion-0001'
};
const proactiveResponse = await ownerRequest(exclusionPath, {
    method: 'POST',
    session: true,
    json: proactiveInput
});
assert.equal(proactiveResponse.status, 201);
assert.deepEqual(await proactiveResponse.json(), {
    replayed: false,
    affectedDraftIds: []
});
assert.equal(sqlite.prepare(
    'SELECT affected_draft_ids_json FROM athlete_exclusion_request_receipts ' +
    'WHERE athlete_id = ?'
).get(proactiveAthleteId).affected_draft_ids_json, '[]');
const proactiveReplay = await ownerRequest(exclusionPath, {
    method: 'POST',
    session: true,
    json: proactiveInput
});
assert.equal(proactiveReplay.status, 200);
assert.deepEqual(await proactiveReplay.json(), {
    replayed: true,
    affectedDraftIds: []
});

// One current public athlete ID creates one global pending exclusion. Every
// item with one matching tag moves as a whole, including an item with another
// unaffected tag and an item inherited from the other Gallery area.
const exclusionInput = {
    athleteId: excludedAthleteId,
    idempotencyKey: 'athlete-exclusion-0001'
};
assert.equal((await ownerRequest(exclusionPath, {
    method: 'GET',
    session: true
})).status, 405);
assert.equal((await ownerRequest(exclusionPath, {
    method: 'POST',
    session: true,
    csrf: false,
    json: exclusionInput
})).status, 403);
assert.equal((await ownerRequest(exclusionPath, {
    method: 'POST',
    session: true,
    json: {
        ...exclusionInput,
        participant: 'Must Not Be Stored',
        reason: 'must-not-enter-private-storage'
    }
})).status, 400);
const exclusionResponse = await ownerRequest(exclusionPath, {
    method: 'POST',
    session: true,
    json: exclusionInput
});
assert.equal(exclusionResponse.status, 201);
const exclusionBody = await exclusionResponse.json();
assert.deepEqual(exclusionBody, {
    replayed: false,
    affectedDraftIds: [exclusionEveryoneDraftId, exclusionFamilyDraftId].sort()
});
assert.equal(JSON.stringify(exclusionBody).includes('participant'), false);
assert.equal(JSON.stringify(exclusionBody).includes('reason'), false);
for (const draftId of [exclusionFamilyDraftId, exclusionEveryoneDraftId]) {
    assert.deepEqual(readDraftState(sqlite, draftId), {
        state: 'withdrawal-pending',
        state_version: 1
    });
    assert.equal(readWithdrawalKind(sqlite, draftId), 'athlete-exclusion');
    assert.equal(countRows(sqlite, 'draft_transition_receipts', draftId), 1);
}

// A later editorial request cannot weaken athlete-exclusion intent, and
// consent withdrawal is the only stronger classification. Once consent is
// recorded, another editorial request cannot downgrade it either.
const exclusionFamilyEditorialPath =
    `/api/browser/drafts/${exclusionFamilyDraftId}/editorial-withdrawal?site=family`;
assert.equal((await ownerRequest(exclusionFamilyEditorialPath, {
    method: 'POST',
    session: true,
    json: {
        expectedStateVersion: 1,
        idempotencyKey: 'editorial-after-exclusion-0001'
    }
})).status, 200);
assert.equal(readWithdrawalKind(sqlite, exclusionFamilyDraftId), 'athlete-exclusion');
const exclusionFamilyConsentPath =
    `/api/browser/drafts/${exclusionFamilyDraftId}/consent-withdrawal?site=family`;
assert.equal((await ownerRequest(exclusionFamilyConsentPath, {
    method: 'POST',
    session: true,
    json: {
        expectedStateVersion: 1,
        idempotencyKey: 'consent-after-exclusion-0001'
    }
})).status, 200);
assert.equal(readWithdrawalKind(sqlite, exclusionFamilyDraftId), 'consent-withdrawal');
assert.equal((await ownerRequest(exclusionFamilyEditorialPath, {
    method: 'POST',
    session: true,
    json: {
        expectedStateVersion: 1,
        idempotencyKey: 'editorial-after-consent-0001'
    }
})).status, 200);
assert.equal(readWithdrawalKind(sqlite, exclusionFamilyDraftId), 'consent-withdrawal');

const pendingExclusion = sqlite.prepare(
    'SELECT athlete_id, expected_suppression_revision, resolved_at ' +
    'FROM pending_athlete_exclusions WHERE athlete_id = ?'
).get(excludedAthleteId);
assert.deepEqual({ ...pendingExclusion }, {
    athlete_id: excludedAthleteId,
    expected_suppression_revision: catalogSnapshot.suppressionRevision,
    resolved_at: null
});

const exclusionReceiptColumns = sqlite.prepare(
    'PRAGMA table_info(athlete_exclusion_request_receipts)'
).all().map(column => column.name);
assert.equal(
    exclusionReceiptColumns.some(column => /name|reason|participant|note|email/i.test(column)),
    false
);
assert.throws(() => sqlite.prepare(
    'UPDATE athlete_exclusion_request_receipts SET affected_draft_count = 0 ' +
    'WHERE athlete_id = ?'
).run(excludedAthleteId), /immutable/i);
assert.throws(() => sqlite.prepare(
    'DELETE FROM athlete_exclusion_request_receipts WHERE athlete_id = ?'
).run(excludedAthleteId), /append-only/i);

const exclusionReplay = await ownerRequest(exclusionPath, {
    method: 'POST',
    session: true,
    json: exclusionInput
});
assert.equal(exclusionReplay.status, 200);
assert.deepEqual(await exclusionReplay.json(), {
    replayed: true,
    affectedDraftIds: [exclusionEveryoneDraftId, exclusionFamilyDraftId].sort()
});

const originalAffectedDraftIds = [
    exclusionEveryoneDraftId,
    exclusionFamilyDraftId
].sort();

// The database-level exclusion remains the final backstop for future items
// while the suppression request remains unresolved.
assert.throws(
    () => insertDraft(
        sqlite,
        'draft_00000000-0000-4000-8000-000000000104',
        'family',
        [companionAthleteId, excludedAthleteId]
    ),
    /gallery draft contains a pending athlete exclusion/i
);

// Replay is read from the immutable original-set receipt before any current
// draft lifecycle query. It therefore remains byte-for-byte stable after one,
// then every, originally affected draft reaches withdrawn.
sqlite.exec('DROP TRIGGER gallery_drafts_withdrawal_evidence_guard');
sqlite.prepare(
    "UPDATE gallery_drafts SET state = 'withdrawn', state_version = 2 WHERE draft_id = ?"
).run(exclusionFamilyDraftId);
const partialWithdrawalReplay = await ownerRequest(exclusionPath, {
    method: 'POST',
    session: true,
    json: exclusionInput
});
assert.equal(partialWithdrawalReplay.status, 200);
assert.deepEqual(await partialWithdrawalReplay.json(), {
    replayed: true,
    affectedDraftIds: originalAffectedDraftIds
});
sqlite.prepare(
    "UPDATE gallery_drafts SET state = 'withdrawn', state_version = 2 WHERE draft_id = ?"
).run(exclusionEveryoneDraftId);
const completeWithdrawalReplay = await ownerRequest(exclusionPath, {
    method: 'POST',
    session: true,
    json: exclusionInput
});
assert.equal(completeWithdrawalReplay.status, 200);
assert.deepEqual(await completeWithdrawalReplay.json(), {
    replayed: true,
    affectedDraftIds: originalAffectedDraftIds
});

// This focused fixture does not recreate the independent public-host and
// retention proofs. Once their guards are isolated, perform the real SQLite
// parent deletes and cascades so the replay proof covers genuinely purged
// draft rows, not merely a filtered lifecycle query.
sqlite.exec('DROP TRIGGER gallery_drafts_purge_guard');
sqlite.prepare('DELETE FROM gallery_drafts WHERE draft_id IN (?, ?)').run(
    exclusionFamilyDraftId,
    exclusionEveryoneDraftId
);
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM gallery_drafts WHERE draft_id IN (?, ?)'
).get(exclusionFamilyDraftId, exclusionEveryoneDraftId).count, 0);

const hiddenReplayCatalog = {
    ...catalogSnapshot,
    suppressionRevision: `${catalogSnapshot.suppressionRevision}-resolved`,
    suppressionDocument: {
        ...catalogSnapshot.suppressionDocument,
        hiddenAthleteIds: [
            ...catalogSnapshot.suppressionDocument.hiddenAthleteIds,
            excludedAthleteId,
            proactiveAthleteId
        ]
    }
};
const replayAfterPurgeAndSuppression = await initiateAthleteExclusion(
    env,
    ownerIdentity,
    'family',
    exclusionInput,
    hiddenReplayCatalog,
    currentNow += 1
);
assert.deepEqual(replayAfterPurgeAndSuppression, {
    ok: true,
    status: 200,
    replayed: true,
    affectedDraftIds: originalAffectedDraftIds
});

// Resolution and permitted cleanup of the pending operational row do not
// erase the immutable request receipt or change an exact retry response.
const resolvedAt = new Date(currentNow += 1).toISOString();
sqlite.prepare(`
    UPDATE pending_athlete_exclusions
    SET resolved_suppression_revision = ?,
        resolution_audit_hash = ?,
        resolved_at = ?,
        updated_at = ?
    WHERE athlete_id = ? AND resolved_at IS NULL
`).run(
    hiddenReplayCatalog.suppressionRevision,
    'd'.repeat(64),
    resolvedAt,
    resolvedAt,
    excludedAthleteId
);
assert.equal((await initiateAthleteExclusion(
    env,
    ownerIdentity,
    'family',
    exclusionInput,
    hiddenReplayCatalog,
    currentNow += 1
)).status, 200);
sqlite.prepare(
    'DELETE FROM pending_athlete_exclusions WHERE athlete_id = ?'
).run(excludedAthleteId);
assert.deepEqual(await initiateAthleteExclusion(
    env,
    ownerIdentity,
    'family',
    exclusionInput,
    hiddenReplayCatalog,
    currentNow += 1
), {
    ok: true,
    status: 200,
    replayed: true,
    affectedDraftIds: originalAffectedDraftIds
});

assert.equal((await initiateAthleteExclusion(
    env,
    ownerIdentity,
    'family',
    {
        athleteId: excludedAthleteId,
        idempotencyKey: 'athlete-exclusion-different'
    },
    hiddenReplayCatalog,
    currentNow += 1
)).status, 409);
assert.equal((await ownerRequest(exclusionPath, {
    method: 'POST',
    session: true,
    json: {
        athleteId: 'not-a-current-public-athlete',
        idempotencyKey: 'athlete-exclusion-invalid'
    }
})).status, 400);

// A legacy/malformed draft ID must make the exact-set receipt transaction
// fail and roll back. The SQL guard uses the same draft_<UUID-v4> grammar as
// service replay, so it can never commit evidence that replay later rejects.
const malformedDraftId = 'draft_malformed_receipt_0001';
insertDraft(sqlite, malformedDraftId, 'family', [companionAthleteId]);
const malformedReceiptResponse = await ownerRequest(exclusionPath, {
    method: 'POST',
    session: true,
    json: {
        athleteId: companionAthleteId,
        idempotencyKey: 'malformed-receipt-guard-0001'
    }
});
assert.equal(malformedReceiptResponse.status, 409);
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM pending_athlete_exclusions WHERE athlete_id = ?'
).get(companionAthleteId).count, 0);
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM athlete_exclusion_request_receipts ' +
    'WHERE athlete_id = ?'
).get(companionAthleteId).count, 0);

// If a surviving operational row contradicts its immutable receipt, replay
// fails closed. Trigger removal below is test-only corruption injection.
sqlite.exec(`
    DROP TRIGGER pending_athlete_exclusions_immutable_guard;
    DROP TRIGGER pending_athlete_exclusions_resolution_guard;
`);
sqlite.prepare(`
    UPDATE pending_athlete_exclusions
    SET request_audit_hash = ?
    WHERE athlete_id = ?
`).run('f'.repeat(64), proactiveAthleteId);
assert.equal((await initiateAthleteExclusion(
    env,
    ownerIdentity,
    'family',
    proactiveInput,
    hiddenReplayCatalog,
    currentNow += 1
)).status, 409);

// A consent escalation that loses its exact pending state between the initial
// read and guarded writes must not return success. The second draft read is the
// mandatory post-batch proof.
const race = createConsentEscalationRaceD1();
const racedConsent = await initiateDraftWithdrawal(
    { DB: race.database },
    ownerIdentity,
    'family',
    'draft_00000000-0000-4000-8000-000000000105',
    'consent-withdrawal',
    {
        expectedStateVersion: 1,
        idempotencyKey: 'consent-withdrawal-race-0001'
    },
    fixedNow
);
assert.equal(racedConsent.status, 409);
assert.equal(race.draftReadCount(), 2);

sqlite.close();
console.log('Gallery owner withdrawal and athlete-exclusion control tests passed.');

async function ownerRequest(path, {
    method = 'GET',
    session = false,
    csrf = true,
    json,
    headers = {}
} = {}) {
    currentNow += 1;
    const requestHeaders = new Headers(headers);
    requestHeaders.set('X-Synthetic-Identity', 'owner');
    if (session) {
        requestHeaders.set('Cookie', ownerSession.cookie);
        if (!['GET', 'HEAD'].includes(method)) {
            requestHeaders.set('Origin', requestHeaders.get('Origin') || adminOrigin);
            requestHeaders.set('Sec-Fetch-Site', 'same-origin');
            if (csrf) {
                requestHeaders.set('X-CSRF-Token', ownerSession.csrfToken);
            }
        }
    }
    let body;
    if (json !== undefined) {
        requestHeaders.set('Content-Type', 'application/json');
        body = JSON.stringify(json);
    }
    return handleAdminRequest(
        new Request(`${adminOrigin}${path}`, {
            method,
            headers: requestHeaders,
            body
        }),
        env,
        {
            verifyAccessIdentity: async request =>
                request.headers.get('X-Synthetic-Identity') === 'owner'
                    ? ownerIdentity
                    : null,
            now: () => currentNow
        }
    );
}

function insertDraft(database, draftId, siteMode, athleteIds) {
    database.prepare(`
        INSERT INTO gallery_drafts (
            draft_id,
            public_item_id,
            state,
            state_version,
            site_modes_json,
            export_bundle_id,
            source_revision,
            suppression_revision,
            item_revision,
            active_consent_revision,
            media_type,
            race_date,
            race_event,
            race_distance,
            athlete_ids_json,
            title,
            caption,
            alt_text,
            featured,
            verified_owner_identity_hash,
            created_at,
            updated_at
        ) VALUES (
            ?, ?, 'draft', 0, ?, ?, ?, ?, ?, NULL, 'photo',
            '2026-09-01', 'Synthetic race', '5 km', ?,
            'Synthetic title', 'Synthetic caption', 'Synthetic alt text', 0,
            ?, '2026-09-02T15:00:00.000Z', '2026-09-02T15:00:00.000Z'
        )
    `).run(
        draftId,
        `${draftId}-item`,
        JSON.stringify([siteMode]),
        catalogSnapshot.exportBundleId,
        catalogSnapshot.sourceRevision,
        catalogSnapshot.suppressionRevision,
        `${draftId}-item-revision`,
        JSON.stringify(athleteIds),
        '1'.repeat(64)
    );
}

function readDraftState(database, draftId) {
    return { ...database.prepare(
        'SELECT state, state_version FROM gallery_drafts WHERE draft_id = ?'
    ).get(draftId) };
}

function readWithdrawalKind(database, draftId) {
    return database.prepare(
        'SELECT withdrawal_kind FROM draft_publication_references WHERE draft_id = ?'
    ).get(draftId).withdrawal_kind;
}

function countRows(database, tableName, draftId) {
    assert.match(tableName, /^[a-z_]+$/);
    const statement = draftId === undefined
        ? database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`)
        : database.prepare(
            `SELECT COUNT(*) AS count FROM ${tableName} WHERE draft_id = ?`
        );
    const row = draftId === undefined ? statement.get() : statement.get(draftId);
    return Number(row.count);
}

function createSqliteD1(database) {
    class Statement {
        constructor(sql, bindings = []) {
            this.sql = sql;
            this.bindings = bindings;
        }

        bind(...bindings) {
            return new Statement(this.sql, bindings);
        }

        async run() {
            return this.runSynchronously();
        }

        async first(columnName) {
            const row = database.prepare(this.sql).get(...this.bindings) ?? null;
            return columnName === undefined || row === null ? row : row[columnName];
        }

        async all() {
            return {
                success: true,
                results: database.prepare(this.sql).all(...this.bindings)
            };
        }

        runSynchronously() {
            const result = database.prepare(this.sql).run(...this.bindings);
            return {
                success: true,
                meta: { changes: Number(result.changes) }
            };
        }
    }

    return {
        prepare(sql) {
            return new Statement(sql);
        },
        async batch(statements) {
            database.exec('BEGIN IMMEDIATE');
            try {
                const results = statements.map(statement => {
                    assert.ok(statement instanceof Statement);
                    return statement.runSynchronously();
                });
                database.exec('COMMIT');
                return results;
            } catch (error) {
                database.exec('ROLLBACK');
                throw error;
            }
        }
    };
}

function createConsentEscalationRaceD1() {
    let batchCompleted = false;
    let draftReads = 0;

    class Statement {
        constructor(sql) {
            this.sql = sql;
        }

        bind() {
            return this;
        }

        async first() {
            if (this.sql.includes('FROM gallery_drafts AS draft')) {
                draftReads += 1;
                return batchCompleted
                    ? {
                        draftId: 'draft_00000000-0000-4000-8000-000000000105',
                        state: 'withdrawn',
                        stateVersion: 2,
                        withdrawalKind: 'editorial-removal'
                    }
                    : {
                        draftId: 'draft_00000000-0000-4000-8000-000000000105',
                        state: 'withdrawal-pending',
                        stateVersion: 1,
                        withdrawalKind: 'editorial-removal'
                    };
            }
            return null;
        }

        async all() {
            return { success: true, results: [] };
        }
    }

    return {
        database: {
            prepare(sql) {
                return new Statement(sql);
            },
            async batch(statements) {
                batchCompleted = true;
                return statements.map(() => ({ success: true }));
            }
        },
        draftReadCount() {
            return draftReads;
        }
    };
}
