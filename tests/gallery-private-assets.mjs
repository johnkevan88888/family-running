import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { handleAdminRequest } from '../gallery-admin/src/admin-worker.js';
import { reservePrivateGalleryAsset, readPrivateGalleryAsset } from '../gallery-admin/src/private-gallery-asset-service.js';
import { readPrivateGalleryRoster } from '../gallery-admin/src/private-gallery-roster-service.js';
import { parsePrivateOriginalKey } from '../gallery-admin/src/storage-keys.js';
import { isPublishedPath } from '../scripts/published-site-entries.mjs';

const db = new DatabaseSync(':memory:');
const migrations = new URL('../gallery-admin/migrations/', import.meta.url);
for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
    db.exec(await readFile(new URL(name, migrations), 'utf8'));
}
const id = n => `person_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const owner = { type: 'browser', subject: 'synthetic-owner' };
const now = Date.UTC(2026, 8, 25, 15);
let reads = 0, writes = 0, beforeWrite, afterWrite;
const env = {
    ADMIN_ORIGIN: 'https://synthetic-private-assets.example',
    OWNER_IDENTITIES: 'subject:synthetic-owner',
    AUTOMATION_IDENTITIES: 'subject:synthetic-service',
    SESSION_SECRET: 'synthetic-only-private-asset-session-secret',
    PRIVATE_ORIGINALS: new Proxy({}, { get() { throw new Error('No byte intake is authorized by a reservation'); } }),
    DB: { prepare(sql) {
        let bindings = [];
        return {
            bind(...values) { bindings = values; return this; },
            async all() { reads++; return { success: true, results: db.prepare(sql).all(...bindings) }; },
            async run() {
                writes++;
                beforeWrite?.(); beforeWrite = undefined;
                db.prepare(sql).run(...bindings);
                const hook = afterWrite; afterWrite = undefined; hook?.();
                return { success: true };
            }
        };
    } }
};
const insertPerson = db.prepare(`INSERT INTO private_gallery_people
    (person_id, display_name, public_athlete_id, family, everyone) VALUES (?, ?, ?, ?, ?)`);
insertPerson.run(id(1), 'Synthetic Public Runner', 'synthetic-public-runner', 1, 1);
insertPerson.run(id(2), 'Synthetic Private Runner', null, 1, 0);
insertPerson.run(id(3), 'Synthetic Other Runner', null, 0, 1);
async function input(site = 'family', personIds = [id(1), id(2)]) {
    return { idempotencyKey: crypto.randomUUID(), originalFormat: 'jpg', personIds,
        rosterRevision: (await readPrivateGalleryRoster(env, site)).revision };
}
const firstInput = await input();
const first = await reservePrivateGalleryAsset(env, owner, 'family', firstInput);
assert.equal(first.status, 201, JSON.stringify(first));
assert.equal(first.replayed, false);
assert.deepEqual(first.asset.personIds, [id(1), id(2)]);
assert.equal(first.asset.state, 'awaiting-original');
assert.deepEqual(Object.keys(first.asset).sort(), ['assetId', 'personIds', 'siteMode', 'state']);
const stored = db.prepare('SELECT * FROM private_gallery_assets WHERE asset_id = ?').get(first.asset.assetId);
assert.equal(stored.private_object_key, `private-archive/v1/family/${first.asset.assetId}/original.jpg`);
assert.equal(parsePrivateOriginalKey(stored.private_object_key), null);
assert.equal(db.prepare('SELECT count(*) AS n FROM private_gallery_asset_tags').get().n, 2);
const writesAfterFirst = writes;
assert.equal((await reservePrivateGalleryAsset(env, owner, 'family', firstInput)).replayed, true);
assert.equal(writes, writesAfterFirst);
assert.equal((await reservePrivateGalleryAsset(env, owner, 'family', { ...firstInput, originalFormat: 'png' })).status, 409);
for (const extra of [{siteMode:'everyone'}, {assetId:first.asset.assetId}, {privateObjectKey:'x'},
    {draftId:'draft_old'}, {consent:true}, {publicAthleteId:'synthetic-public-runner'}, {displayName:'Synthetic'}]) {
    assert.equal((await reservePrivateGalleryAsset(env, owner, 'family', { ...firstInput, ...extra })).status, 400);
}
for (const change of [{personIds:[]}, {personIds:[id(1),id(1)]}, {personIds:['synthetic-public-runner']},
    {personIds:[null]}, {personIds:Array(101).fill(id(1))}, {originalFormat:'mp4'}, {originalFormat:'webp'},
    {idempotencyKey:'bad'}, {rosterRevision:'bad'}]) {
    assert.equal((await reservePrivateGalleryAsset(env, owner, 'family', { ...firstInput, ...change })).status, 400);
}
for (const ids of [[id(3)], [id(99)]]) {
    assert.equal((await reservePrivateGalleryAsset(env, owner, 'family', await input('family',ids))).status, 409);
}
assert.equal(writes, writesAfterFirst);
assert.equal((await readPrivateGalleryAsset(env, owner, 'everyone', first.asset.assetId)).status, 404);
assert.equal((await readPrivateGalleryAsset(env, {type:'browser',subject:'different-owner'}, 'family', first.asset.assetId)).status, 404);
assert.equal((await readPrivateGalleryAsset(env, owner, 'family', 'asset_bad')).status, 404);
assert.equal((await reservePrivateGalleryAsset(env, {type:'service',subject:'synthetic-service'}, 'family', firstInput)).status, 403);

// Current roster changes never erase a saved private tag. Replay acknowledges
// that reservation only, not current eligibility or consent to publish it.
db.prepare('UPDATE private_gallery_people SET family = 0, everyone = 1, public_athlete_id = NULL WHERE person_id = ?').run(id(1));
assert.deepEqual((await readPrivateGalleryAsset(env, owner, 'family', first.asset.assetId)).asset, first.asset);
assert.equal((await reservePrivateGalleryAsset(env, owner, 'family', firstInput)).replayed, true);
assert.equal((await reservePrivateGalleryAsset(env, owner, 'family', { ...firstInput, idempotencyKey:crypto.randomUUID() })).status, 409);
db.prepare('UPDATE private_gallery_people SET family = 1 WHERE person_id = ?').run(id(1));
// Race after read/validation, immediately before the real SQL INSERT.
const racingInput = await input();
beforeWrite = () => db.prepare('UPDATE private_gallery_people SET display_name = ? WHERE person_id = ?').run('Synthetic Edited Runner', id(2));
assert.equal((await reservePrivateGalleryAsset(env, owner, 'family', racingInput)).status, 409);
assert.equal(db.prepare('SELECT count(*) AS n FROM private_gallery_assets').get().n, 1);
assert.equal(db.prepare('SELECT count(*) AS n FROM private_gallery_asset_tags').get().n, 2);
// Failure part-way through the tag trigger rolls back the parent AND all tags.
db.exec(`CREATE TRIGGER synthetic_tag_failure BEFORE INSERT ON private_gallery_asset_tags
    WHEN NEW.ordinal = 1 BEGIN SELECT RAISE(ABORT, 'synthetic tag failure'); END`);
assert.equal((await reservePrivateGalleryAsset(env, owner, 'family', await input())).status, 503);
assert.equal(db.prepare('SELECT count(*) AS n FROM private_gallery_assets').get().n, 1);
assert.equal(db.prepare('SELECT count(*) AS n FROM private_gallery_asset_tags').get().n, 2);
db.exec('DROP TRIGGER synthetic_tag_failure');
afterWrite = () => { throw new Error('synthetic lost response'); };
const retryInput = await input();
const recovered = await reservePrivateGalleryAsset(env, owner, 'family', retryInput);
assert.equal(recovered.status, 200);
assert.equal(recovered.replayed, true);
assert.equal(db.prepare('SELECT count(*) AS n FROM private_gallery_assets').get().n, 2);
assert.deepEqual((await reservePrivateGalleryAsset(env, owner, 'family', retryInput)).asset, recovered.asset);

// Direct database boundary: no tag omission/replacement, old-key alias, video,
// public state, stale generation or shortcut to another person's stable ID.
const cols = Object.keys(stored), values = cols.map(key => stored[key]);
const sqlInsert = `INSERT INTO private_gallery_assets (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`;
const generation = db.prepare('SELECT generation FROM private_gallery_roster_version').get().generation;
function raw(overrides) {
    const assetId = `asset_${crypto.randomUUID()}`;
    const row = { ...stored, asset_id:assetId, idempotency_key:crypto.randomUUID(), roster_generation:generation,
        private_object_key:`private-archive/v1/family/${assetId}/original.jpg`, ...overrides };
    return cols.map(key=>row[key]);
}
for (const overrides of [
    {person_ids_json:'[]'}, {person_ids_json:'null'}, {person_ids_json:'{}'}, {person_ids_json:'broken'},
    {person_ids_json:JSON.stringify([id(1),id(1)])}, {person_ids_json:JSON.stringify([id(3)])},
    {person_ids_json:JSON.stringify([id(99)])}, {person_ids_json:JSON.stringify([1])},
    {roster_generation:generation-1}, {state:'published'}, {original_format:'mp4'},
    {private_object_key:'private-originals/phase-c/draft_old/upload_old.jpg'}
]) assert.throws(()=>db.prepare(sqlInsert).run(...raw(overrides)));
assert.throws(()=>db.prepare(sqlInsert.replace('INSERT INTO','INSERT OR REPLACE INTO')).run(...values));
for (const sql of [
    "UPDATE private_gallery_assets SET state = 'published'", 'DELETE FROM private_gallery_assets',
    'DELETE FROM private_gallery_asset_tags', 'UPDATE private_gallery_asset_tags SET ordinal = 99'
]) assert.throws(()=>db.exec(sql));
for (const ids of [[id(1),0],[id(3),2]]) assert.throws(()=>db.prepare(
    'INSERT OR REPLACE INTO private_gallery_asset_tags (asset_id,person_id,ordinal) VALUES (?,?,?)'
).run(first.asset.assetId,...ids));
assert.throws(()=>db.prepare('DELETE FROM private_gallery_people WHERE person_id = ?').run(id(2)));
assert.throws(()=>db.prepare('INSERT OR REPLACE INTO private_gallery_people VALUES (?, ?, NULL, 1, 0)').run(id(2),'Synthetic Reassigned'));
db.prepare('UPDATE private_gallery_people SET public_athlete_id = ? WHERE person_id = ?').run('synthetic-public-runner',id(1));
assert.throws(()=>db.prepare('INSERT OR REPLACE INTO private_gallery_people VALUES (?, ?, ?, 1, 0)').run(id(9),'Synthetic Alias','synthetic-public-runner'));

// Real route/session/CSRF path, with no UI switch or public data changes.
async function request(path, options = {}) {
    const { identity = owner, site = 'family', method = 'GET', headers = {}, body, time = now, query = `?site=${site}` } = options;
    return handleAdminRequest(new Request(`${env.ADMIN_ORIGIN}${path}${query}`, {
        method, headers, ...(body === undefined ? {} : {body:typeof body === 'string' ? body : JSON.stringify(body)})
    }), env, { verifyAccessIdentity:async()=>identity, now:()=>time });
}
const sessions = {};
for (const site of ['family','everyone']) {
    const response = await request('/api/browser/session', {site});
    assert.equal(response.status,200);
    sessions[site] = { Cookie:response.headers.get('Set-Cookie').split(';')[0],
        'X-CSRF-Token':(await response.json()).csrfToken, Origin:env.ADMIN_ORIGIN,
        'Sec-Fetch-Site':'same-origin', 'Content-Type':'application/json' };
}
const route = '/api/browser/private-assets';
const postBody = await input();
const beforeDenials = [reads,writes];
for (const options of [
    {identity:null}, {identity:{type:'browser',subject:'different-owner'}}, {identity:{type:'service',subject:'synthetic-service'}},
    {headers:{}}, {headers:{...sessions.family,'X-CSRF-Token':'invalid'}},
    {headers:{...sessions.family,Origin:'https://elsewhere.example'}},
    {headers:{...sessions.family,'Sec-Fetch-Site':'cross-site'}},
    {headers:{...sessions.family,'CF-Access-Client-Secret':'synthetic'}},
    {headers:sessions.everyone}, {time:now+31*60*1000}
]) assert.equal((await request(route,{method:'POST',headers:sessions.family,body:postBody,...options})).status,403);
assert.deepEqual([reads,writes],beforeDenials);
assert.equal((await request(route,{method:'POST',headers:sessions.family,body:'{'})).status,400);
assert.equal((await request(route,{method:'POST',headers:sessions.family,body:' '.repeat(32769)})).status,413);
assert.equal((await request(route,{method:'POST',headers:{...sessions.family,'Content-Type':'text/plain'},body:'{}'})).status,400);
assert.equal((await request(route,{headers:sessions.family})).status,405);
assert.equal((await request(route,{method:'POST',headers:sessions.family,body:postBody,query:'?site=family&site=everyone'})).status,404);
for (const site of ['family','everyone']) {
    const body = await input(site,site==='family'?[id(1),id(2)]:[id(1),id(3)]);
    const created = await request(route,{site,method:'POST',headers:sessions[site],body});
    assert.equal(created.status,201,await created.clone().text());
    const result = await created.json();
    assert.deepEqual(result.asset.personIds,body.personIds);
    assert.equal(result.asset.siteMode,site);
    const response = await request(`${route}/${result.asset.assetId}`,{site,headers:sessions[site]});
    assert.equal(response.status,200);
    assert.equal(response.headers.get('Cache-Control'),'no-store');
    assert.equal(response.headers.get('Cross-Origin-Resource-Policy'),'same-origin');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'),null);
    const text = await response.text();
    for (const forbidden of ['private-archive/', 'owner_identity_hash','idempotency','request_hash','Synthetic','public_athlete_id']) {
        assert.equal(text.includes(forbidden),false);
    }
    assert.equal((await request(`${route}/${result.asset.assetId}`,{site,method:'POST',headers:sessions[site],body:{}})).status,405);
    assert.equal((await request(`${route}/${result.asset.assetId}`,{site,headers:{}})).status,403);
}
assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');

// Corrupt stored associations must never become a shorter partial response.
db.exec('DROP TRIGGER private_gallery_asset_tags_no_delete');
db.prepare('DELETE FROM private_gallery_asset_tags WHERE asset_id = ? AND ordinal = 1').run(first.asset.assetId);
assert.equal((await readPrivateGalleryAsset(env,owner,'family',first.asset.assetId)).status,503);
assert.equal((await reservePrivateGalleryAsset(env,owner,'family',firstInput)).status,503);
for (const path of ['gallery-admin/src/private-gallery-asset-service.js','gallery-admin/migrations/0018_private_gallery_asset_reservations.sql']) {
    assert.equal(isPublishedPath(path),false);
}
db.close();
console.log('Private asset reservations: complete atomic tags, revision races, idempotent recovery, SQL fences, owner/area/CSRF and private-only responses passed.');
