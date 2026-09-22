import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const migrationRoot = new URL('../gallery-admin/migrations/', import.meta.url);
const predecessorNames = (await readdir(migrationRoot))
    .filter(name => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) < 16)
    .sort();
assert.deepEqual(predecessorNames.map(name => Number(name.slice(0, 4))),
    Array.from({ length: 15 }, (_, index) => index + 1));
// Normalize checkout line endings only; compare all SQL and stored data exactly.
const predecessors = await Promise.all(predecessorNames.map(async name =>
    (await readFile(new URL(name, migrationRoot), 'utf8')).replace(/\r\n/g, '\n')));
const repair = (await readFile(new URL(
    '0016_transition_receipt_replacement_guard.sql', migrationRoot
), 'utf8')).replace(/\r\n/g, '\n');
const guardName = 'draft_transition_receipts_no_replace_guard';
const legacyGuard = predecessors[0].match(new RegExp(
    `CREATE TRIGGER ${guardName}\\b[\\s\\S]*?END;`
))?.[0];
assert.ok(legacyGuard);
assert.doesNotMatch(legacyGuard, /existing\.expected_state_version/);

for (const legacy of [true, false]) {
    const database = new DatabaseSync(':memory:');
    try {
        for (const migration of predecessors) database.exec(migration);
        const canonicalSchema = schemaSnapshot(database);
        const canonicalGuard = database.prepare(
            'SELECT sql FROM sqlite_schema WHERE name = ?'
        ).get(guardName).sql;
        if (legacy) {
            // Reproduce the older rule observed in the non-production schema,
            // without modifying an applied migration or removing other guards.
            database.exec(`DROP TRIGGER ${guardName}; ${legacyGuard}`);
        }
        database.exec('PRAGMA recursive_triggers = OFF');
        assert.equal(database.prepare('PRAGMA recursive_triggers').get().recursive_triggers, 0);
        const draftId = seedDraft(database, 'family', '1');
        const winnerKey = 'synthetic-receipt-winner';
        insertReceipt(database, draftId, winnerKey);
        const originalRows = rowsSnapshot(database);
        const originalSchema = schemaSnapshot(database);

        if (legacy) {
            // The index rejects a normal duplicate, but REPLACE silently removes
            // the winner under the older rule. Roll the demonstration back.
            assert.throws(() => insertReceipt(database, draftId,
                'synthetic-normal-duplicate'), /UNIQUE constraint failed/);
            database.exec('SAVEPOINT legacy_replacement');
            insertReceipt(database, draftId, 'synthetic-overwritten-receipt', true);
            assert.equal(database.prepare(
                'SELECT idempotency_key FROM draft_transition_receipts WHERE draft_id = ?'
            ).get(draftId).idempotency_key, 'synthetic-overwritten-receipt');
            database.exec('ROLLBACK TO legacy_replacement; RELEASE legacy_replacement');
            assert.equal(rowsSnapshot(database), originalRows);
        }

        database.exec(repair);
        assert.equal(rowsSnapshot(database), originalRows,
            'The forward repair must not change any existing application row.');
        assert.deepEqual(schemaSnapshot(database).filter(row => row.name !== guardName),
            originalSchema.filter(row => row.name !== guardName),
            'Every non-target schema object, including the unique index, must survive unchanged.');
        assert.deepEqual(schemaSnapshot(database), canonicalSchema,
            'The repaired schema must exactly match the previously approved 0006 rule.');
        assert.equal(database.prepare('SELECT sql FROM sqlite_schema WHERE name = ?')
            .get(guardName).sql, canonicalGuard);

        for (const recursive of [0, 1]) {
            database.exec(`PRAGMA recursive_triggers = ${recursive}`);
            for (const replace of [false, true]) {
                for (const key of [winnerKey, 'synthetic-new-request-same-version']) {
                    assert.throws(() => insertReceipt(database, draftId, key, replace),
                        /transition receipt replacement is forbidden/);
                    assert.equal(rowsSnapshot(database), originalRows);
                }
            }
        }
        assert.throws(() => database.prepare(
            'UPDATE draft_transition_receipts SET created_at = ? WHERE draft_id = ?'
        ).run('2026-09-23T12:00:00.000Z', draftId), /append-only update is forbidden/);
        assert.throws(() => database.prepare(
            'DELETE FROM draft_transition_receipts WHERE draft_id = ?'
        ).run(draftId), /direct deletion is forbidden/);
        assert.throws(() => insertReceipt(database, draftId,
            'synthetic-wrong-result-state', false, 9), /does not match the committed draft state/);
        assert.equal(rowsSnapshot(database), originalRows);

        // A legitimate next transition may append evidence, but must still use
        // a new request key. This is an in-memory fixture, not a workflow retry.
        database.exec('PRAGMA recursive_triggers = OFF');
        database.prepare(
            "UPDATE gallery_drafts SET state = 'withdrawal-pending', state_version = 2 WHERE draft_id = ?"
        ).run(draftId);
        const beforeNextReceipt = rowsSnapshot(database);
        for (const replace of [false, true]) {
            assert.throws(() => insertReceipt(database, draftId, winnerKey, replace, 1),
                /transition receipt replacement is forbidden/);
            assert.equal(rowsSnapshot(database), beforeNextReceipt);
        }
        insertReceipt(database, draftId, 'synthetic-valid-next-transition', false, 1);
        assert.equal(database.prepare(
            'SELECT COUNT(*) AS count FROM draft_transition_receipts WHERE draft_id = ?'
        ).get(draftId).count, 2);

        // The uniqueness boundary is per draft, not global or per site mode.
        const otherDraftId = seedDraft(database, 'everyone', '2');
        insertReceipt(database, otherDraftId, winnerKey);
        assert.equal(database.prepare('SELECT COUNT(*) AS count FROM draft_transition_receipts')
            .get().count, 3);
        assert.equal(database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
        assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
        assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally {
        database.close();
    }
}

console.log('Gallery transition receipt forward-repair tests passed (legacy and canonical schemas).');

function schemaSnapshot(database) {
    return database.prepare(
        'SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name'
    ).all();
}

function rowsSnapshot(database) {
    return JSON.stringify(database.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map(({ name }) => ({
        name,
        rows: database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()
    })));
}

function seedDraft(database, site, ordinal) {
    const draftId = `draft_00000000-0000-4000-8000-${ordinal.padStart(12, '0')}`;
    database.prepare(`
        INSERT INTO gallery_drafts (
            draft_id, public_item_id, site_modes_json, export_bundle_id,
            source_revision, suppression_revision, item_revision, media_type,
            race_date, race_event, race_distance, athlete_ids_json, title, caption,
            alt_text, featured, verified_owner_identity_hash, created_at, updated_at
        ) VALUES (?, ?, ?, 'synthetic-bundle', 'synthetic-source', 'synthetic-suppression',
            'synthetic-item', 'photo', '2026-09-22', 'Synthetic event', '5 km', '[]',
            'Synthetic title', 'Synthetic caption', 'Synthetic description', 0, ?, ?, ?)
    `).run(draftId, `synthetic-item-${ordinal}`, JSON.stringify([site]), '1'.repeat(64),
        '2026-09-22T12:00:00.000Z', '2026-09-22T12:00:00.000Z');
    database.prepare(
        "UPDATE gallery_drafts SET state = 'uploading', state_version = 1 WHERE draft_id = ?"
    ).run(draftId);
    return draftId;
}

function insertReceipt(database, draftId, key, replace = false, expectedVersion = 0) {
    const verb = replace ? 'INSERT OR REPLACE' : 'INSERT';
    database.prepare(`
        ${verb} INTO draft_transition_receipts (
            draft_id, idempotency_key, payload_fingerprint, from_state, to_state,
            expected_state_version, result_state_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(draftId, key, '2'.repeat(64),
        expectedVersion === 0 ? 'draft' : 'uploading',
        expectedVersion === 0 ? 'uploading' : 'withdrawal-pending',
        expectedVersion, expectedVersion + 1, '2026-09-22T12:01:00.000Z');
}
