import assert from 'node:assert/strict';
import { readFile,readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { reservePrivateGalleryAsset,readPrivateGalleryAsset } from '../gallery-admin/src/private-gallery-asset-service.js';
import { readPrivateGalleryRoster } from '../gallery-admin/src/private-gallery-roster-service.js';
import { correctPrivateGalleryTags,readPrivateGalleryTags } from '../gallery-admin/src/private-gallery-tag-service.js';
import { readPrivateGalleryAssetEligibility,changePrivateGalleryVisibility } from '../gallery-admin/src/private-gallery-visibility-service.js';
import { preparePrivateArchiveIntake } from '../gallery-admin/src/private-archive-service.js';
import { handleAdminRequest } from '../gallery-admin/src/admin-worker.js';
import { hashIdentity } from '../gallery-admin/src/session.js';
import { sha256Hex } from '../gallery-admin/src/media-byte-verification.js';
import { isPublishedPath } from '../scripts/published-site-entries.mjs';

const db = new DatabaseSync(':memory:');
const migrations = new URL('../gallery-admin/migrations/',import.meta.url);
const migrationNames=(await readdir(migrations)).filter(name=>name.endsWith('.sql')).sort();
for (const name of migrationNames) db.exec(await readFile(new URL(name,migrations),'utf8'));
const id = n=>`person_00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const owner = {type:'browser',subject:'synthetic-tag-owner'};
// Forward compatibility with an already-retained pre-0021 original. Historical
// permission/photo evidence is preserved and bound to original tag version one.
const legacy=new DatabaseSync(':memory:');
for(const name of migrationNames.filter(name=>name<'0021')) legacy.exec(await readFile(new URL(name,migrations),'utf8'));
const legacyAsset=`asset_${crypto.randomUUID()}`;
legacy.prepare('INSERT INTO private_gallery_people VALUES (?,?,NULL,1,0)').run(id(1),'Synthetic Legacy Runner');
legacy.prepare(`INSERT INTO private_gallery_assets
    (asset_id,site_mode,owner_identity_hash,idempotency_key,request_hash,roster_generation,person_ids_json,original_format,private_object_key)
    VALUES (?,'family',?,?,?,(SELECT generation FROM private_gallery_roster_version),?,'jpg',?)`)
    .run(legacyAsset,await hashIdentity(owner),crypto.randomUUID(),'a'.repeat(64),JSON.stringify([id(1)]),`private-archive/v1/family/${legacyAsset}/original.jpg`);
const legacyEnv={DB:{prepare(sql){let values=[];return {bind(...bindings){values=bindings;return this;},
    async all(){return {success:true,results:legacy.prepare(sql).all(...values)};},
    async first(){return legacy.prepare(sql).get(...values)??null;},
    async run(){throw new Error('Legacy replay cannot write');}};}}};
const legacyInput={byteCount:100,containsMinors:false,declaredMimeType:'image/jpeg',guardianApprovalConfirmed:false,
    privateRetentionConfirmed:true,rosterRevision:(await readPrivateGalleryRoster(legacyEnv,'family')).revision,sha256:'a'.repeat(64)};
const legacyHash=await sha256Hex(new TextEncoder().encode(JSON.stringify(Object.keys(legacyInput).sort().map(key=>legacyInput[key]))));
legacy.prepare(`INSERT INTO private_archive_intakes
    (asset_id,roster_generation,request_hash,byte_count,sha256,private_retention_confirmed,contains_minors,guardian_approval_confirmed)
    VALUES (?,(SELECT generation FROM private_gallery_roster_version),?,100,?,1,0,0)`)
    .run(legacyAsset,legacyHash,'a'.repeat(64));
legacy.prepare('INSERT INTO private_archive_multipart_uploads VALUES (?,?)').run(legacyAsset,'synthetic-legacy-upload');
legacy.prepare(`INSERT INTO private_archive_original_receipts (asset_id,byte_count,sha256,provider_version,provider_etag)
    VALUES (?,100,?,'synthetic-legacy-version','synthetic-legacy-etag')`).run(legacyAsset,'a'.repeat(64));
const legacyIntake=legacy.prepare('SELECT * FROM private_archive_intakes').get();
const legacyOriginal=legacy.prepare('SELECT * FROM private_archive_original_receipts').get();
legacy.exec(await readFile(new URL('0021_private_gallery_tag_revisions.sql',migrations),'utf8'));
assert.deepEqual({...legacy.prepare('SELECT * FROM private_archive_intakes').get()},{...legacyIntake,tag_version:1});
assert.deepEqual(legacy.prepare('SELECT * FROM private_archive_original_receipts').get(),legacyOriginal);
assert.deepEqual({...legacy.prepare('SELECT * FROM private_gallery_current_tag_sets').get()},{
    asset_id:legacyAsset,tag_version:1,current_person_ids_json:JSON.stringify([id(1)])});
assert.equal(legacy.prepare('SELECT count(*) n FROM private_gallery_tag_revisions').get().n,0);
assert.deepEqual(await preparePrivateArchiveIntake(legacyEnv,owner,'family',legacyAsset,legacyInput),{ok:true,status:200,state:'quarantined'});
assert.deepEqual(legacy.prepare('PRAGMA foreign_key_check').all(),[]);legacy.close();
let beforeSql,afterSql,writes=0;
const env = {ADMIN_ORIGIN:'https://synthetic-tags.example',OWNER_IDENTITIES:'subject:synthetic-tag-owner',
    AUTOMATION_IDENTITIES:'subject:synthetic-service',SESSION_SECRET:'synthetic-only-tag-session-secret',
    PRIVATE_ORIGINALS:new Proxy({}, {get(){throw new Error('Tag correction cannot access original bytes');}}),
    DB:{prepare(sql){let values=[];return {bind(...bindings){values=bindings;return this;},
        async first(){return db.prepare(sql).get(...values)??null;},
        async all(){return {success:true,results:db.prepare(sql).all(...values)};},
        async run(){writes++;const before=beforeSql;beforeSql=undefined;before?.(sql);
            const result=db.prepare(sql).run(...values);const after=afterSql;afterSql=undefined;after?.(sql);
            return {success:true,meta:{changes:Number(result.changes)}};}};}}};
for (const n of [1,2,3,4]) db.prepare('INSERT INTO private_gallery_people VALUES (?,?,?,?,?)')
    .run(id(n),`Synthetic Runner ${n}`,n===1?'synthetic-public':null,n===4?0:1,1);
const roster = site=>readPrivateGalleryRoster(env,site);
const catalog = {sourceRevision:'synthetic-source',suppressionRevision:'synthetic-suppression',
    suppressionDocument:{schemaVersion:'1.0',hiddenAthleteIds:[]},
    sites:{family:{catalog:{athleteIds:['synthetic-public']}},everyone:{catalog:{athleteIds:['synthetic-public']}}}};
async function asset(site='family',personIds=[id(1),id(2)]) {
    const result=await reservePrivateGalleryAsset(env,owner,site,{idempotencyKey:crypto.randomUUID(),originalFormat:'jpg',
        personIds,rosterRevision:(await roster(site)).revision});assert.equal(result.status,201);return result.asset.assetId;
}
async function input(assetId,site='family',personIds=[id(1),id(3)]) {
    return {idempotencyKey:crypto.randomUUID(),expectedVersion:(await readPrivateGalleryTags(env,owner,site,assetId)).tagVersion,
        rosterRevision:(await roster(site)).revision,personIds,completeTagsConfirmed:true,privateRetentionConfirmed:true,
        containsMinors:false,guardianApprovalConfirmed:false};
}
const correction = (assetId,body,site='family')=>correctPrivateGalleryTags(env,owner,site,assetId,body);
const first=await asset();
const oldReservation=db.prepare('SELECT * FROM private_gallery_assets WHERE asset_id=?').get(first);
const oldTags=db.prepare('SELECT * FROM private_gallery_asset_tags WHERE asset_id=? ORDER BY ordinal').all(first);
for (const n of [1,2,3]) assert.equal((await changePrivateGalleryVisibility(env,owner,'family',id(n),{
    expectedVersion:1,idempotencyKey:crypto.randomUUID(),preference:'allowed'})).ok,true);
const originalEligibility=await readPrivateGalleryAssetEligibility(env,owner,'family',first,catalog);
assert.equal(originalEligibility.visibilityEligible,true);
const firstInput=await input(first);
const corrected=await correction(first,firstInput);
assert.equal(corrected.status,201,JSON.stringify(corrected));
assert.equal(corrected.tagVersion,2);assert.equal(corrected.publicationEnabled,false);
assert.deepEqual(corrected.personIds,[id(1),id(3)]);
assert.deepEqual((await readPrivateGalleryAsset(env,owner,'family',first)).asset.personIds,[id(1),id(3)]);
assert.deepEqual(db.prepare('SELECT * FROM private_gallery_assets WHERE asset_id=?').get(first),oldReservation);
assert.deepEqual(db.prepare('SELECT * FROM private_gallery_asset_tags WHERE asset_id=? ORDER BY ordinal').all(first),oldTags);
const committedWrites=writes;
assert.equal((await correction(first,firstInput)).replayed,true);assert.equal(writes,committedWrites);
assert.equal((await correction(first,{...firstInput,containsMinors:true,guardianApprovalConfirmed:true})).status,409);
assert.equal((await correction(first,await input(first,'family',[id(1),id(2)]))).tagVersion,3);
const restoredEligibility=await readPrivateGalleryAssetEligibility(env,owner,'family',first,catalog);
assert.notEqual(restoredEligibility.revision,originalEligibility.revision,'Tag ABA invalidates previous approval');
assert.equal(restoredEligibility.publicationEnabled,false);
assert.equal((await correction(first,firstInput)).status,409,'Historical replay cannot claim current completion');
for (const change of [{completeTagsConfirmed:false},{privateRetentionConfirmed:false},{containsMinors:true},
    {guardianApprovalConfirmed:true},{expectedVersion:0},{expectedVersion:Number.MAX_SAFE_INTEGER},
    {rosterRevision:'bad'},{idempotencyKey:'bad'},{siteMode:'everyone'},{publicUseConfirmed:true},
    {draftId:'draft_old'},{privateObjectKey:'elsewhere'}]) {
    assert.equal((await correction(first,{...await input(first),...change})).status,422);
}
for (const personIds of [[],[id(1),id(1)],[id(99)],[id(4)],['synthetic-public'],[null],Array(101).fill(id(1))])
    assert.equal((await correction(first,await input(first,'family',personIds))).status,409);
assert.equal((await correction(first,{...await input(first),expectedVersion:1})).status,409);
assert.equal((await correctPrivateGalleryTags(env,{type:'service',subject:owner.subject},'family',first,firstInput)).status,403);
assert.equal((await correctPrivateGalleryTags(env,{type:'browser',subject:'other-owner'},'family',first,firstInput)).status,404);
assert.equal((await correctPrivateGalleryTags(env,owner,'everyone',first,firstInput)).status,404);

// SQL race guards must win after application validation; no partial associations.
const raced=await input(first);
beforeSql=()=>db.prepare('UPDATE private_gallery_people SET display_name=? WHERE person_id=?').run('Synthetic Edited Runner',id(3));
assert.equal((await correction(first,raced)).status,409);
assert.equal((await readPrivateGalleryTags(env,owner,'family',first)).tagVersion,3);
const racingVersion=await input(first);
beforeSql=()=>db.exec(`INSERT INTO private_gallery_tag_revisions
    SELECT asset_id,version+1,'${crypto.randomUUID()}',actor_identity_hash,request_hash,
        (SELECT generation FROM private_gallery_roster_version WHERE singleton=1),
        person_ids_json,person_ids_json,1,1,contains_minors,guardian_approval_confirmed,strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM private_gallery_tag_revisions WHERE asset_id='${first}' AND version=3`);
assert.equal((await correction(first,racingVersion)).status,409);
assert.equal((await readPrivateGalleryTags(env,owner,'family',first)).tagVersion,4);
db.exec(`CREATE TRIGGER synthetic_revision_failure BEFORE INSERT ON private_gallery_revision_tags
    WHEN NEW.ordinal=1 BEGIN SELECT RAISE(ABORT,'Synthetic revision failure'); END`);
assert.equal((await correction(first,await input(first))).status,409);
assert.equal((await readPrivateGalleryTags(env,owner,'family',first)).tagVersion,4);
db.exec('DROP TRIGGER synthetic_revision_failure');
afterSql=()=>{throw new Error('Synthetic committed response lost');};
const lost=await input(first);
assert.equal((await correction(first,lost)).replayed,true);
assert.equal((await correction(first,lost)).tagVersion,5);

// New original intake is bound to corrected tags, not the original reservation.
const originalInput={byteCount:100,sha256:'a'.repeat(64),declaredMimeType:'image/jpeg',privateRetentionConfirmed:true,
    containsMinors:false,guardianApprovalConfirmed:false,rosterRevision:(await roster('family')).revision};
assert.equal((await preparePrivateArchiveIntake(env,owner,'family',first,originalInput)).status,409,'No implicit consent to corrected tags');
originalInput.tagVersion=5;
assert.equal((await preparePrivateArchiveIntake(env,owner,'family',first,originalInput)).status,201);
assert.equal(db.prepare('SELECT tag_version FROM private_archive_intakes WHERE asset_id=?').get(first).tag_version,5);
assert.equal((await readPrivateGalleryTags(env,owner,'family',first)).correctionBlocked,true);
assert.equal((await correction(first,await input(first))).status,409,'Unfinished original writer cannot be retagged');
// Synthetic database-only verified receipt: no photo access or processing claim.
db.prepare('INSERT INTO private_archive_multipart_uploads VALUES (?,?)').run(first,'synthetic-tag-upload');
db.prepare(`INSERT INTO private_archive_original_receipts (asset_id,byte_count,sha256,provider_version,provider_etag)
    VALUES (?,100,?,'synthetic-version','synthetic-etag')`).run(first,'a'.repeat(64));
assert.equal((await readPrivateGalleryTags(env,owner,'family',first)).correctionBlocked,false);
const oldIntake=db.prepare('SELECT * FROM private_archive_intakes WHERE asset_id=?').get(first);
const oldOriginal=db.prepare('SELECT * FROM private_archive_original_receipts WHERE asset_id=?').get(first);
const retainedInput=await input(first,'family',[id(1),id(2),id(3)]);
retainedInput.containsMinors=true;retainedInput.guardianApprovalConfirmed=true;
assert.equal((await correction(first,retainedInput)).tagVersion,6);
assert.deepEqual(db.prepare('SELECT * FROM private_archive_intakes WHERE asset_id=?').get(first),oldIntake);
assert.deepEqual(db.prepare('SELECT * FROM private_archive_original_receipts WHERE asset_id=?').get(first),oldOriginal);
assert.equal(db.prepare('SELECT guardian_approval_confirmed FROM private_gallery_tag_revisions WHERE asset_id=? AND version=6').get(first).guardian_approval_confirmed,1);
assert.deepEqual((await readPrivateGalleryAssetEligibility(env,owner,'family',first,catalog)).publicAthleteIds,['synthetic-public']);
await changePrivateGalleryVisibility(env,owner,'family',id(3),{expectedVersion:2,idempotencyKey:crypto.randomUUID(),preference:'hidden'});
assert.equal((await readPrivateGalleryAssetEligibility(env,owner,'family',first,catalog)).visibilityEligible,false);
db.prepare(`INSERT INTO private_archive_deletion_requests (asset_id,actor_identity_hash,reason) VALUES (?,?,'consent-withdrawal')`)
    .run(first,await hashIdentity(owner));
assert.equal((await correction(first,retainedInput)).status,409);
assert.equal((await readPrivateGalleryTags(env,owner,'family',first)).correctionBlocked,true);
const deletionRace=await asset();const deletionInput=await input(deletionRace);
beforeSql=()=>db.prepare(`INSERT INTO private_archive_deletion_requests (asset_id,actor_identity_hash,reason) VALUES (?,?,'owner-delete')`)
    .run(deletionRace,oldReservation.owner_identity_hash);
assert.equal((await correction(deletionRace,deletionInput)).status,409);
const intakeRace=await asset();const intakeRaceInput={...originalInput,tagVersion:1};
beforeSql=()=>db.exec(`INSERT INTO private_gallery_tag_revisions
    (asset_id,version,idempotency_key,actor_identity_hash,request_hash,roster_generation,
     previous_person_ids_json,person_ids_json,complete_tags_confirmed,private_retention_confirmed,contains_minors,guardian_approval_confirmed)
    VALUES ('${intakeRace}',2,'${crypto.randomUUID()}','${oldReservation.owner_identity_hash}','${'a'.repeat(64)}',
        (SELECT generation FROM private_gallery_roster_version WHERE singleton=1),
        '${JSON.stringify([id(1),id(2)])}','${JSON.stringify([id(1),id(3)])}',1,1,0,0)`);
assert.equal((await preparePrivateArchiveIntake(env,owner,'family',intakeRace,intakeRaceInput)).status,409);
assert.equal(db.prepare('SELECT count(*) n FROM private_archive_intakes WHERE asset_id=?').get(intakeRace).n,0);

// Direct database guard: no silent overwrite/history deletion or fabricated consent.
const row=db.prepare('SELECT * FROM private_gallery_tag_revisions WHERE asset_id=? AND version=6').get(first);
const cols=Object.keys(row).filter(key=>key!=='created_at');const sql=`INSERT INTO private_gallery_tag_revisions (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`;
assert.throws(()=>db.prepare(sql.replace('INSERT INTO','INSERT OR REPLACE INTO')).run(...cols.map(k=>row[k])));
assert.throws(()=>db.exec('DELETE FROM private_gallery_tag_revisions'));
assert.throws(()=>db.exec('UPDATE private_gallery_tag_revisions SET private_retention_confirmed=0'));
assert.throws(()=>db.exec('DELETE FROM private_gallery_revision_tags'));
assert.throws(()=>db.exec('UPDATE private_gallery_revision_tags SET ordinal=99'));
const clean=await asset();
const raw={...row,asset_id:clean,version:2,idempotency_key:crypto.randomUUID(),
    roster_generation:(db.prepare('SELECT generation FROM private_gallery_roster_version').get()).generation,
    previous_person_ids_json:JSON.stringify([id(1),id(2)]),person_ids_json:JSON.stringify([id(1),id(3)])};
for (const change of [{actor_identity_hash:'b'.repeat(64)},{version:3},{roster_generation:0},
    {person_ids_json:'[]'},{person_ids_json:'null'},{person_ids_json:JSON.stringify([id(4)])},
    {person_ids_json:JSON.stringify([id(1),id(1)])},{previous_person_ids_json:'[]'},
    {private_retention_confirmed:0},{complete_tags_confirmed:0},{guardian_approval_confirmed:0}]) {
    const changed={...raw,...change};assert.throws(()=>db.prepare(sql).run(...cols.map(k=>changed[k])));
}
assert.throws(()=>db.prepare(`INSERT INTO private_gallery_tag_revisions (${cols.join(',')},created_at)
    VALUES (${cols.map(()=>'?').join(',')},?)`).run(...cols.map(k=>raw[k]),'2000-01-01T00:00:00.000Z'));
db.prepare(sql).run(...cols.map(k=>raw[k]));
assert.equal((await readPrivateGalleryTags(env,owner,'family',clean)).tagVersion,2);

// Drive the actual owner router: same-area session, CSRF, origin and bounded JSON.
const now=Date.UTC(2026,9,8,12);
async function request(path,options={}) {
    const {site='family',method='GET',headers={},body,identity=owner,time=now}=options;
    return handleAdminRequest(new Request(`${env.ADMIN_ORIGIN}${path}?site=${site}`,{method,headers,
        ...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})}),env,
        {verifyAccessIdentity:async()=>identity,now:()=>time});
}
const sessions={};
for (const site of ['family','everyone']) {
    const session=await request('/api/browser/session',{site});assert.equal(session.status,200);
    sessions[site]={Cookie:session.headers.get('Set-Cookie').split(';')[0],'X-CSRF-Token':(await session.json()).csrfToken,
        Origin:env.ADMIN_ORIGIN,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json'};
}
for (const site of ['family','everyone']) {
    const assetId=await asset(site);const path=`/api/browser/private-assets/${assetId}/tags`;const body=await input(assetId,site);
    const writeCount=writes;
    for (const change of [{identity:null},{identity:{type:'service',subject:'synthetic-service'}},
        {identity:{type:'browser',subject:'other-owner'}},{headers:{}},
        {headers:{...sessions[site],'X-CSRF-Token':'bad'}},{headers:{...sessions[site],Origin:'https://elsewhere.example'}},
        {headers:{...sessions[site],'Sec-Fetch-Site':'cross-site'}},{headers:sessions[site==='family'?'everyone':'family']},
        {time:now+31*60*1000}]) assert.equal((await request(path,{site,method:'POST',headers:sessions[site],body,...change})).status,403);
    assert.equal(writes,writeCount);
    assert.equal((await request(path,{site,method:'POST',headers:sessions[site],body:' '.repeat(32769)})).status,413);
    assert.equal((await request(path,{site,method:'POST',headers:sessions[site],body:'{'})).status,400);
    assert.equal((await request(path,{site,method:'DELETE',headers:sessions[site]})).status,405);
    const corrected=await request(path,{site,method:'POST',headers:sessions[site],body});assert.equal(corrected.status,201);
    const read=await request(path,{site,headers:sessions[site]});assert.equal(read.status,200);
    assert.equal(read.headers.get('Cache-Control'),'no-store');assert.equal(read.headers.get('Cross-Origin-Resource-Policy'),'same-origin');
    const text=await read.text();for(const forbidden of ['Synthetic','private-archive/','actor_identity_hash','request_hash','guardian']) assert.equal(text.includes(forbidden),false);
    assert.equal((await request(`/api/browser/private-assets/${assetId}/original`,{site,method:'POST',headers:sessions[site],body:'bytes'})).status,404);
}
assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
// A corrupt current association cannot return or overwrite a shorter tag set.
const corrupt=await asset();assert.equal((await correction(corrupt,await input(corrupt))).status,201);
db.exec('DROP TRIGGER private_gallery_revision_tag_no_delete');
db.prepare('DELETE FROM private_gallery_revision_tags WHERE asset_id=? AND ordinal=1').run(corrupt);
assert.equal((await readPrivateGalleryTags(env,owner,'family',corrupt)).status,503);
assert.equal((await correction(corrupt,firstInput)).status,503);
for(const path of ['gallery-admin/src/private-gallery-tag-service.js','gallery-admin/migrations/0021_private_gallery_tag_revisions.sql']) assert.equal(isPublishedPath(path),false);
db.close();
console.log('Audited complete-tag corrections: preserved history/permissions, fresh retention, ABA/race/terminal fences, atomic recovery, private projection and owner routes passed.');
