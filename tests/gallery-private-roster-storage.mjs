import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import adminWorker, { handleAdminRequest } from '../gallery-admin/src/admin-worker.js';
import { readPrivateGalleryRoster } from '../gallery-admin/src/private-gallery-roster-service.js';
import { isPublishedPath } from '../scripts/published-site-entries.mjs';

const db = new DatabaseSync(':memory:');
const migrations = new URL('../gallery-admin/migrations/', import.meta.url);
for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
    db.exec(await readFile(new URL(name, migrations), 'utf8'));
}
assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
let reads = 0;
const env = {
    ADMIN_ORIGIN: 'https://synthetic-private-roster.example',
    OWNER_IDENTITIES: 'subject:synthetic-owner',
    AUTOMATION_IDENTITIES: 'subject:synthetic-service',
    SESSION_SECRET: 'synthetic-only-private-roster-session-secret',
    DB: { prepare(sql) {
        reads++;
        assert.match(sql.trim(), /^SELECT /);
        const statement = db.prepare(sql);
        return { async all() { return { success: true, results: statement.all() }; } };
    } }
};
const id = n => `person_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const insert = db.prepare(`INSERT INTO private_gallery_people
    (person_id, display_name, public_athlete_id, family, everyone) VALUES (?, ?, ?, ?, ?)`);
const empty = await readPrivateGalleryRoster(env, 'family');
assert.equal(empty.ok, true);
assert.deepEqual(empty.people, []);
insert.run(id(1), 'Synthetic Shared Runner', 'synthetic-shared-runner', 1, 1);
insert.run(id(2), 'Synthetic Private Runner', null, 1, 0);
insert.run(id(3), 'Synthetic Private Runner', null, 0, 1);
const family = await readPrivateGalleryRoster(env, 'family');
const everyone = await readPrivateGalleryRoster(env, 'everyone');
assert.deepEqual(family.people.map(person => person.personId), [id(1), id(2)]);
assert.deepEqual(everyone.people.map(person => person.personId), [id(1), id(3)]);
assert.equal(family.people[1].publicAthleteId, null);
assert.equal(family.revision, everyone.revision);
assert.notEqual(family.revision, empty.revision);
assert.deepEqual(await readPrivateGalleryRoster(env, 'family'), family);
assert.ok(Object.isFrozen(family.people));
// Even changing the other area's person, then restoring the same values,
// invalidates the old complete-roster revision (no stale/ABA selector reuse).
db.prepare('UPDATE private_gallery_people SET display_name = ? WHERE person_id = ?')
    .run('Synthetic Renamed Runner', id(3));
const edited = await readPrivateGalleryRoster(env, 'family');
assert.notEqual(edited.revision, family.revision);
db.prepare('UPDATE private_gallery_people SET display_name = ? WHERE person_id = ?')
    .run('Synthetic Private Runner', id(3));
const restored = await readPrivateGalleryRoster(env, 'family');
assert.notEqual(restored.revision, family.revision);
assert.notEqual(restored.revision, edited.revision);
assert.deepEqual(restored.people, family.people);

for (const values of [
    [id(4), 'Synthetic', null, 0, 0],
    [id(4), 'Synthetic', null, 2, 0],
    [id(4), 'Synthetic', 'synthetic-shared-runner', 1, 0],
    [id(4), 'Synthetic', 'bad--slug', 1, 0],
    ['person_bad', 'Synthetic', null, 1, 0]
]) assert.throws(() => insert.run(...values));
assert.throws(() => db.prepare('UPDATE private_gallery_people SET person_id = ? WHERE person_id = ?').run(id(8), id(2)));
assert.throws(() => db.exec('UPDATE private_gallery_roster_version SET generation = 1'));
assert.throws(() => db.exec('DELETE FROM private_gallery_roster_version'));
assert.throws(() => db.exec('INSERT OR REPLACE INTO private_gallery_roster_version VALUES (1, 1)'));

// Schema-valid but semantically corrupt data in the OTHER area denies the
// entire response rather than silently dropping a private tag or identity.
db.prepare('UPDATE private_gallery_people SET display_name = ? WHERE person_id = ?').run('bad\nname', id(3));
assert.equal((await readPrivateGalleryRoster(env, 'family')).status, 503);
db.prepare('UPDATE private_gallery_people SET display_name = ? WHERE person_id = ?').run('Synthetic Private Runner', id(3));
const unavailable = { ok: false, status: 503, code: 'private-roster-unavailable' };
assert.deepEqual(await readPrivateGalleryRoster({}, 'family'), unavailable);
assert.deepEqual(await readPrivateGalleryRoster(env, 'elsewhere'), unavailable);
const badRow = { generation: 1, person_id: id(1), display_name: 'Synthetic', public_athlete_id: null, family: 1, everyone: 0 };
for (const result of [
    null, { success: false, results: [badRow] }, { results: [badRow] },
    { success: true, results: [] }, { success: true, results: Array(10001).fill(badRow) },
    { success: true, results: [badRow, { ...badRow, person_id: id(2), generation: 2 }] },
    { success: true, results: [{ ...badRow, generation: '1' }] },
    { success: true, results: [{ ...badRow, public_athlete_id: 'a'.repeat(129) }] }
]) {
    assert.deepEqual(await readPrivateGalleryRoster({ DB: { prepare: () => ({ all: async () => result }) } }, 'family'), unavailable);
}

const now = Date.UTC(2026, 8, 25, 15);
const owner = { type: 'browser', subject: 'synthetic-owner' };
const sessions = new Map();
async function request(path, options = {}) {
    const { identity = owner, site = 'family', method = 'GET', headers = {}, time = now, query = `?site=${site}` } = options;
    return handleAdminRequest(new Request(`${env.ADMIN_ORIGIN}${path}${query}`, {
        method, headers
    }), env, { verifyAccessIdentity: async () => identity, now: () => time });
}
for (const site of ['family', 'everyone']) {
    const response = await request('/api/browser/session', { site });
    assert.equal(response.status, 200);
    sessions.set(site, { cookie: response.headers.get('Set-Cookie').split(';')[0], csrf: (await response.json()).csrfToken });
}
const route = '/api/browser/private-roster';
for (const site of ['family', 'everyone']) {
    const response = await request(route, { site, headers: { Cookie: sessions.get(site).cookie } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ['people', 'revision']);
    assert.deepEqual(body.people.map(person => person.personId), site === 'family' ? [id(1), id(2)] : [id(1), id(3)]);
}
const readsBeforeDenials = reads;
for (const options of [
    { identity: null }, { identity: { type: 'service', subject: 'synthetic-service' } },
    { identity: { type: 'browser', subject: 'synthetic-other' } }, {},
    { headers: { Cookie: sessions.get('everyone').cookie } },
    { time: now + 31 * 60 * 1000, headers: { Cookie: sessions.get('family').cookie } },
    { headers: { Cookie: sessions.get('family').cookie, 'Cf-Access-Client-Id': 'synthetic-service' } }
]) assert.equal((await request(route, options)).status, 403);
for (const query of ['', '?site=family&site=everyone', '?site=family&destination=everyone', '?site=unknown']) {
    assert.equal((await request(route, { query, headers: { Cookie: sessions.get('family').cookie } })).status, 404);
}
for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']) {
    const response = await request(route, { method, headers: {
        Cookie: sessions.get('family').cookie, 'X-CSRF-Token': sessions.get('family').csrf,
        Origin: env.ADMIN_ORIGIN, 'Sec-Fetch-Site': 'same-origin'
    } });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('Allow'), 'GET');
}
assert.equal((await adminWorker.fetch(new Request(`${env.ADMIN_ORIGIN}${route}?site=family`, {
    headers: { Cookie: sessions.get('family').cookie, 'Cf-Access-Authenticated-User-Email': 'spoof@example.test' }
}), env, {})).status, 403, 'Headers alone must not authenticate the owner');
assert.equal(reads, readsBeforeDenials, 'Denied requests must not read private data');
const savedDb = env.DB;
env.DB = { prepare() { throw new Error('synthetic-private-provider-sentinel'); } };
const failure = await request(route, { headers: { Cookie: sessions.get('family').cookie } });
assert.equal(failure.status, 503);
assert.deepEqual(await failure.json(), { error: 'private-roster-unavailable' });
env.DB = savedDb;

// Existing API remains public-result-only; adding a private reader grants no
// photo, consent, promotion, candidate or withdrawal authority.
const oldCatalog = await request('/api/browser/catalog', { headers: { Cookie: sessions.get('family').cookie } });
assert.equal(oldCatalog.status, 200);
assert.ok(!(await oldCatalog.text()).includes('Synthetic Private Runner'));
for (const file of ['gallery-admin/src/private-gallery-roster.js', 'gallery-admin/src/private-gallery-roster-service.js',
    'gallery-admin/migrations/0017_private_gallery_roster.sql', 'docs/gallery-private-tagging-plan.md', 'tests/gallery-private-roster-storage.mjs']) {
    assert.equal(isPublishedPath(file), false, `${file} must stay outside the public artifact`);
}
assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
db.close();
console.log('Private roster storage and owner-route tests passed: full migration chain, fictional non-public people, revision changes, SQL guards, whole-roster failure, owner/session/area isolation, no cache/leak/fallback/publication.');
