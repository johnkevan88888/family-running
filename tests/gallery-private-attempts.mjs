import assert from 'node:assert/strict';
import { readFile,readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { reservePrivateGalleryAsset } from '../gallery-admin/src/private-gallery-asset-service.js';
import { readPrivateGalleryRoster } from '../gallery-admin/src/private-gallery-roster-service.js';
import { correctPrivateGalleryTags } from '../gallery-admin/src/private-gallery-tag-service.js';
import { readPrivateGalleryAssetEligibility,changePrivateGalleryVisibility } from '../gallery-admin/src/private-gallery-visibility-service.js';
import { preparePrivateArchiveIntake,storePrivateArchiveOriginal } from '../gallery-admin/src/private-archive-service.js';
import { reservePrivateGalleryAttempt } from '../gallery-admin/src/private-gallery-attempt-service.js';
import { sha256Hex,readBoundedBytes } from '../gallery-admin/src/media-byte-verification.js';
import { isPublishedPath } from '../scripts/published-site-entries.mjs';
import sharp from 'sharp';

const db = new DatabaseSync(':memory:');
const migrations = new URL('../gallery-admin/migrations/',import.meta.url);
for (const name of (await readdir(migrations)).filter(name=>name.endsWith('.sql')).sort()) db.exec(await readFile(new URL(name,migrations),'utf8'));
const owner = {type:'browser',subject:'synthetic-attempt-owner'};
const person = n=>`person_00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
let beforeWrite,afterWrite,writes=0,forbidStorage=false;
const objects=new Map(),uploads=new Map();
const storage={
    async createMultipartUpload(key) {
        assert.equal(forbidStorage,false);const uploadId=crypto.randomUUID();uploads.set(uploadId,{key});
        return {key,uploadId,async abort(){uploads.delete(uploadId);}};
    },
    resumeMultipartUpload(key,uploadId) {
        assert.equal(forbidStorage,false);return {
            async uploadPart(partNumber,bytes){uploads.get(uploadId).bytes=Buffer.from(bytes);return {partNumber,etag:'synthetic-part'};},
            async complete(){const bytes=uploads.get(uploadId).bytes;
                const row={key,size:bytes.length,version:crypto.randomUUID(),etag:crypto.randomUUID(),bytes};objects.set(key,row);return row;}
        };
    },
    async head(key){assert.equal(forbidStorage,false);return objects.get(key)??null;},
    async get(key){assert.equal(forbidStorage,false);const row=objects.get(key);return row?{...row,body:new Blob([row.bytes]).stream()}:null;}
};
const env={PRIVATE_ORIGINALS:storage,DB:{prepare(sql){let values=[];return {bind(...args){values=args;return this;},
    async first(){return db.prepare(sql).get(...values)??null;},async all(){return {success:true,results:db.prepare(sql).all(...values)};},
    async run(){writes++;const before=beforeWrite;beforeWrite=undefined;before?.(sql);
        const result=db.prepare(sql).run(...values);const after=afterWrite;afterWrite=undefined;after?.(sql);
        return {success:true,meta:{changes:Number(result.changes)}};}};}}};
for (const [n,pub,family,everyone] of [[1,'synthetic-public',1,1],[2,null,1,1],[3,null,0,1]])
    db.prepare('INSERT INTO private_gallery_people VALUES (?,?,?,?,?)').run(person(n),`Synthetic Runner ${n}`,pub,family,everyone);
const catalog={schemaVersion:'1.0',exportBundleId:'synthetic-bundle',sourceRevision:`sha256:${'a'.repeat(64)}`,
    suppressionRevision:`sha256:${'b'.repeat(64)}`,suppressionDocument:{schemaVersion:'1.0',hiddenAthleteIds:[]},sites:{}};
for(const site of ['family','everyone']) catalog.sites[site]={catalog:{exportBundleId:catalog.exportBundleId,sourceRevision:catalog.sourceRevision,
    races:[{raceDate:'2026-01-01',raceEvent:'Synthetic Race',raceDistance:'5 km'}],athleteIds:['synthetic-public']}};
const roster=async site=>(await readPrivateGalleryRoster(env,site)).revision;
const bytes=await sharp({create:{width:16,height:20,channels:3,background:'#2468ac'}}).jpeg().toBuffer();
const digest=await sha256Hex(bytes);
for(const [n,site] of [[1,'family'],[2,'family'],[3,'everyone']])
    assert.equal((await changePrivateGalleryVisibility(env,owner,site,person(n),{
        expectedVersion:1,idempotencyKey:crypto.randomUUID(),preference:'allowed'})).ok,true);
async function asset(site='family',ids=[person(1),person(2)],minors=false,store=true) {
    forbidStorage=false;
    const saved=await reservePrivateGalleryAsset(env,owner,site,{idempotencyKey:crypto.randomUUID(),originalFormat:'jpg',personIds:ids,rosterRevision:await roster(site)});
    assert.equal(saved.status,201);const assetId=saved.asset.assetId;
    assert.equal((await preparePrivateArchiveIntake(env,owner,site,assetId,{byteCount:bytes.length,sha256:digest,declaredMimeType:'image/jpeg',
        privateRetentionConfirmed:true,containsMinors:minors,guardianApprovalConfirmed:minors,rosterRevision:await roster(site)})).status,201);
    if(store) assert.equal((await storePrivateArchiveOriginal(env,owner,site,assetId,new Blob([bytes]).stream(),{
        digestReadable:async body=>sha256Hex(await readBoundedBytes(body,bytes.length))})).ok,true);
    forbidStorage=true;return assetId;
}
async function input(assetId,site='family',minors=false) {
    const eligibility=await readPrivateGalleryAssetEligibility(env,owner,site,assetId,catalog);
    assert.equal(eligibility.ok,true);
    return {idempotencyKey:crypto.randomUUID(),tagVersion:db.prepare('SELECT tag_version FROM private_gallery_current_tag_sets WHERE asset_id=?').get(assetId).tag_version,
        eligibilityRevision:eligibility.revision,sourceRevision:catalog.sourceRevision,suppressionRevision:catalog.suppressionRevision,
        raceIndex:0,completeTagsConfirmed:true,publicUseConfirmed:true,containsMinors:minors,guardianApprovalConfirmed:minors};
}
const reserve=(assetId,body,site='family',snapshot=catalog)=>reservePrivateGalleryAttempt(env,owner,site,assetId,body,snapshot);
const first=await asset();
const historical=db.prepare('SELECT * FROM private_archive_intakes WHERE asset_id=?').get(first);
const original=db.prepare('SELECT * FROM private_archive_original_receipts WHERE asset_id=?').get(first);
const originalObjects=structuredClone([...objects]);
const body=await input(first);
const created=await reserve(first,body);assert.equal(created.status,201,JSON.stringify(created));
assert.equal(created.state,'reserved');assert.equal(created.processingEnabled,false);assert.equal(created.publicationEnabled,false);
assert.match(created.attemptId,/^attempt_[0-9a-f-]{36}$/);
const row=db.prepare('SELECT * FROM private_gallery_attempts WHERE attempt_id=?').get(created.attemptId);
assert.equal(row.person_ids_json,JSON.stringify([person(1),person(2)]));
assert.equal(row.public_athlete_ids_json,JSON.stringify(['synthetic-public']));
assert.equal(row.race_event,'Synthetic Race');assert.equal(row.original_sha256,digest);
assert.notEqual(row.generation_id,body.idempotencyKey);assert.notEqual(row.public_item_id,`photo-${body.idempotencyKey}`);
assert.equal(db.prepare('SELECT count(*) n FROM gallery_drafts').get().n,0,'Reservation is not an admitted legacy draft');
const committedWrites=writes;
assert.equal((await reserve(first,body)).replayed,true);assert.equal(writes,committedWrites);
assert.equal((await reserve(first,{...body,raceIndex:1})).status,409);
for(const patch of [{publicUseConfirmed:false},{completeTagsConfirmed:false},{containsMinors:true},{guardianApprovalConfirmed:true},
    {raceIndex:-1},{raceIndex:0.5},{tagVersion:0},{idempotencyKey:'invalid'},{eligibilityRevision:'invalid'},
    {personIds:[person(1)]},{siteMode:'everyone'},{draftId:'draft_old'},{privateRetentionConfirmed:true},{generationId:crypto.randomUUID()},
    {raceEvent:'Caller supplied'},{athleteIds:['synthetic-public']},{privateObjectKey:'elsewhere'}])
    assert.equal((await reserve(first,{...await input(first),...patch})).status,422);
for(const patch of [{raceIndex:1000},{sourceRevision:`sha256:${'c'.repeat(64)}`},{suppressionRevision:`sha256:${'c'.repeat(64)}`},
    {eligibilityRevision:`sha256:${'c'.repeat(64)}`},{tagVersion:2}])
    assert.equal((await reserve(first,{...await input(first),...patch})).status,409);
assert.equal((await reservePrivateGalleryAttempt(env,{type:'service',subject:owner.subject},'family',first,body,catalog)).status,403);
assert.equal((await reservePrivateGalleryAttempt(env,{type:'browser',subject:'synthetic-other'},'family',first,body,catalog)).status,409);
assert.equal((await reserve(first,body,'everyone')).status,409);
const missing=await asset('family',[person(1)],false,false);
assert.equal((await reserve(missing,await input(missing))).status,409,'Unfinished original cannot start an attempt');
const child=await asset('everyone',[person(3)],true);
assert.equal((await reserve(child,await input(child,'everyone',false),'everyone')).status,409,'Stored child declaration cannot be silently downgraded');
assert.equal((await reserve(child,await input(child,'everyone',true),'everyone')).status,201);
const childRow=db.prepare('SELECT * FROM private_gallery_attempts WHERE asset_id=?').get(child);
assert.equal(childRow.public_athlete_ids_json,'[]','Non-public people stay tagged, not public IDs');

// SQL wins every race after complete application validation.
async function race(hook) {
    const selected=await asset();const request=await input(selected);let completed=false,hookError;
    beforeWrite=()=>{try{hook(selected,request);completed=true;}catch(error){hookError=error;throw error;}};
    assert.equal((await reserve(selected,request)).status,409);
    assert.equal(hookError,undefined);assert.equal(completed,true,'Race must reach the actual SQL write');
    assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_attempts WHERE asset_id=?').get(selected).n,0);
}
await race(()=>db.prepare('UPDATE private_gallery_people SET display_name=? WHERE person_id=?').run('Synthetic Changed Name',person(2)));
await race(()=>db.prepare(`INSERT INTO private_gallery_visibility_events
    (person_id,version,preference,idempotency_key,actor_identity_hash,request_hash,site_mode,roster_generation)
    SELECT person_id,version+1,'hidden',?,? ,?,'family',(SELECT generation FROM private_gallery_roster_version)
    FROM private_gallery_current_visibility WHERE person_id=?`).run(crypto.randomUUID(),row.owner_identity_hash,'c'.repeat(64),person(2)));
let visibility=db.prepare('SELECT version FROM private_gallery_current_visibility WHERE person_id=?').get(person(2));
assert.equal((await changePrivateGalleryVisibility(env,owner,'family',person(2),{expectedVersion:visibility.version,
    idempotencyKey:crypto.randomUUID(),preference:'allowed'})).ok,true);
assert.equal((await reserve(first,body)).status,409,'Hide/Allow ABA cannot reuse earlier consent snapshot');
await race(selected=>db.prepare(`INSERT INTO private_archive_deletion_requests (asset_id,actor_identity_hash,reason) VALUES (?,?,'consent-withdrawal')`)
    .run(selected,row.owner_identity_hash));
await race(selected=>db.prepare(`INSERT INTO private_gallery_tag_revisions
    (asset_id,version,idempotency_key,actor_identity_hash,request_hash,roster_generation,previous_person_ids_json,person_ids_json,
     complete_tags_confirmed,private_retention_confirmed,contains_minors,guardian_approval_confirmed)
    SELECT asset_id,tag_version+1,?,?,?,(SELECT generation FROM private_gallery_roster_version),current_person_ids_json,current_person_ids_json,1,1,0,0
    FROM private_gallery_current_tag_sets WHERE asset_id=?`).run(crypto.randomUUID(),row.owner_identity_hash,'d'.repeat(64),selected));
await race(()=>db.prepare(`INSERT INTO pending_athlete_exclusions
    (athlete_id,exclusion_revision,expected_suppression_revision,request_audit_hash,actor_identity_hash,created_at,updated_at)
    VALUES (?,?,?,?,?,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`)
    .run('synthetic-public','synthetic-exclusion',catalog.suppressionRevision,'e'.repeat(64),row.owner_identity_hash));
assert.equal((await reserve(first,await input(first))).status,409,'Current pending exclusion blocks all group attempts');
db.prepare("UPDATE pending_athlete_exclusions SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),resolved_suppression_revision=?,resolution_audit_hash=? WHERE athlete_id=?")
    .run(catalog.suppressionRevision,'f'.repeat(64),'synthetic-public');
const suppressed=structuredClone(catalog);suppressed.suppressionDocument.hiddenAthleteIds=['synthetic-public'];
assert.equal((await reserve(first,await input(first),'family',suppressed)).status,409);
const corruptCatalog=structuredClone(catalog);delete corruptCatalog.suppressionDocument;
assert.equal((await reserve(first,await input(first),'family',corruptCatalog)).ok,false);

// Append new consent after a retag; do not transfer or rewrite old attestations.
const retag=await correctPrivateGalleryTags(env,owner,'family',first,{idempotencyKey:crypto.randomUUID(),expectedVersion:1,
    rosterRevision:await roster('family'),personIds:[person(2)],completeTagsConfirmed:true,privateRetentionConfirmed:true,
    containsMinors:false,guardianApprovalConfirmed:false});assert.equal(retag.status,201);
assert.equal((await reserve(first,body)).status,409);
const fresh=await reserve(first,await input(first));assert.equal(fresh.status,201,JSON.stringify(fresh));
assert.notEqual(fresh.attemptId,created.attemptId);
const freshRow=db.prepare('SELECT * FROM private_gallery_attempts WHERE attempt_id=?').get(fresh.attemptId);
assert.notEqual(freshRow.generation_id,row.generation_id);assert.notEqual(freshRow.public_item_id,row.public_item_id);
assert.equal(freshRow.person_ids_json,JSON.stringify([person(2)]));assert.equal(freshRow.public_athlete_ids_json,'[]');
assert.deepEqual(db.prepare('SELECT * FROM private_archive_intakes WHERE asset_id=?').get(first),historical);
assert.deepEqual(db.prepare('SELECT * FROM private_archive_original_receipts WHERE asset_id=?').get(first),original);
for(const [key,value] of originalObjects) assert.deepEqual(objects.get(key),{...value,bytes:Buffer.from(value.bytes)},
    'Reservation never changes retained bytes or provider identity');
const lost=await asset();const lostBody=await input(lost);afterWrite=()=>{throw new Error('Synthetic committed reply lost');};
assert.equal((await reserve(lost,lostBody)).replayed,true);
assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_attempts WHERE asset_id=?').get(lost).n,1);
const rolled=await asset();const rolledBody=await input(rolled);
db.exec("CREATE TRIGGER synthetic_attempt_rollback AFTER INSERT ON private_gallery_attempts BEGIN SELECT RAISE(ABORT,'Synthetic rollback'); END");
assert.equal((await reserve(rolled,rolledBody)).status,409);
assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_attempts WHERE asset_id=?').get(rolled).n,0);db.exec('DROP TRIGGER synthetic_attempt_rollback');
const postCommit=await asset();const postCommitBody=await input(postCommit);
afterWrite=()=>db.prepare(`INSERT INTO private_archive_deletion_requests (asset_id,actor_identity_hash,reason) VALUES (?,?,'consent-withdrawal')`)
    .run(postCommit,row.owner_identity_hash);
assert.equal((await reserve(postCommit,postCommitBody)).status,409,'Revocation before response denies readiness despite saved reservation');
assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_attempts WHERE asset_id=?').get(postCommit).n,1,'Completed evidence is not rewritten');
assert.equal((await reserve(postCommit,postCommitBody)).status,409);
const expires=await asset();const expiresBody=await input(expires);
assert.equal((await reserve(expires,expiresBody)).status,201);
const expiryWrites=writes;
// Test-only SQLite clock advance, never a provider timestamp rewrite.
const expiryNow=Math.floor(Date.now()/1000)+86401;
db.function('unixepoch',value=>value==='now'?expiryNow:Math.floor(Date.parse(value)/1000));
assert.equal((await reserve(expires,expiresBody)).status,409,'Expired reservation cannot replay as current authorization');
assert.equal(writes,expiryWrites);
for(const sql of ['UPDATE private_gallery_attempts SET public_use_confirmed=1','DELETE FROM private_gallery_attempts',
    `INSERT OR REPLACE INTO private_gallery_attempts SELECT * FROM private_gallery_attempts WHERE attempt_id='${created.attemptId}'`]) assert.throws(()=>db.exec(sql));
for(const filename of ['gallery-admin/src/private-gallery-attempt-service.js','gallery-admin/migrations/0022_private_gallery_attempt_reservations.sql'])
    assert.equal(isPublishedPath(filename),false);
const admin=await readFile(new URL('../gallery-admin/src/admin-worker.js',import.meta.url),'utf8');
assert.equal(admin.includes('private-gallery-attempt-service'),false,'No preparation endpoint is activated');
assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
db.close();console.log('Gallery internal fresh-consent attempt reservations, complete-tag SQL fences and unchanged retained synthetic photos passed.');
