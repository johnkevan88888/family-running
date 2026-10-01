import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import sharp from 'sharp';
import {preparePrivateArchiveIntake,storePrivateArchiveOriginal,deletePrivateArchiveOriginal} from '../gallery-admin/src/private-archive-service.js';
import {reservePrivateGalleryAsset,readPrivateGalleryAsset} from '../gallery-admin/src/private-gallery-asset-service.js';
import {readPrivateGalleryRoster} from '../gallery-admin/src/private-gallery-roster-service.js';
import {handleAdminRequest} from '../gallery-admin/src/admin-worker.js';

const db = new DatabaseSync(':memory:');
const dir = new URL('../gallery-admin/migrations/',import.meta.url);
for (const name of (await readdir(dir)).filter(name=>name.endsWith('.sql')).sort()) db.exec(await readFile(new URL(name,dir),'utf8'));
const people = [1,2].map(n=>`person_00000000-0000-4000-8000-${String(n).padStart(12,'0')}`);
for (const [n,id] of people.entries()) db.prepare('INSERT INTO private_gallery_people VALUES (?,?,?,1,1)')
    .run(id,`Synthetic Archive Runner ${n}`, n===0?'synthetic-archive-runner':null);
const owner = {type:'browser',subject:'synthetic-owner'};
const photo = await sharp({create:{width:31,height:47,channels:3,background:'#164c73'}}).jpeg().toBuffer();
const png = await sharp({create:{width:31,height:47,channels:3,background:'#164c73'}}).png().toBuffer();
const sha = bytes=>createHash('sha256').update(bytes).digest('hex');
const stream = bytes=>new Response(bytes).body;
const dependencies = { async digestReadable(body) {
    const hash = createHash('sha256'); for await (const chunk of body) hash.update(chunk); return hash.digest('hex');
} };
let beforeSql,afterSql;
const env = { DB:{prepare(sql) {
    let values=[];
    return {bind(...bindings){values=bindings;return this;},
        async all(){return {success:true,results:db.prepare(sql).all(...values)};},
        async first(){return db.prepare(sql).get(...values)??null;},
        async run(){beforeSql?.(sql); const result=db.prepare(sql).run(...values); afterSql?.(sql);return {success:true,meta:{changes:Number(result.changes)}};}
    };
}}, PRIVATE_ORIGINALS:bucket() };
async function asset(site='family',format='jpg',bytes=photo) {
    const roster=await readPrivateGalleryRoster(env,site);
    const result=await reservePrivateGalleryAsset(env,owner,site,{idempotencyKey:crypto.randomUUID(),
        originalFormat:format,personIds:people,rosterRevision:roster.revision});
    assert.equal(result.status,201,JSON.stringify(result));
    return {id:result.asset.assetId,site,bytes,input:{byteCount:bytes.length,sha256:sha(bytes),
        declaredMimeType:format==='jpg'?'image/jpeg':'image/png',privateRetentionConfirmed:true,
        containsMinors:false,guardianApprovalConfirmed:false,rosterRevision:roster.revision}};
}
const prepare = a=>preparePrivateArchiveIntake(env,owner,a.site,a.id,a.input);
const store = a=>storePrivateArchiveOriginal(env,owner,a.site,a.id,stream(a.bytes),dependencies);
const remove = a=>deletePrivateArchiveOriginal(env,owner,a.site,a.id,'consent-withdrawal');
const key = a=>db.prepare('SELECT private_object_key FROM private_gallery_assets WHERE asset_id=?').get(a.id).private_object_key;
const count = (table,id)=>db.prepare(`SELECT count(*) n FROM ${table} WHERE asset_id=?`).get(id).n;

const first=await asset();
for (const change of [{privateRetentionConfirmed:false},{containsMinors:true},{guardianApprovalConfirmed:true},
    {publicUseConfirmed:true},{byteCount:26214401},{sha256:'bad'},{declaredMimeType:'video/mp4'},
    {draftId:'draft_old'},{privateObjectKey:'elsewhere'},{destination:'everyone'}]) {
    assert.equal((await preparePrivateArchiveIntake(env,owner,'family',first.id,{...first.input,...change})).status,422);
}
assert.equal((await store(first)).status,409);
assert.equal(env.PRIVATE_ORIGINALS.calls.length,0);
assert.equal((await prepare(first)).status,201);
assert.equal((await prepare(first)).status,200);
assert.equal((await preparePrivateArchiveIntake(env,owner,'family',first.id,{...first.input,sha256:'a'.repeat(64)})).status,409);
assert.equal((await storePrivateArchiveOriginal(env,owner,'everyone',first.id,stream(photo),dependencies)).status,404);
assert.equal((await storePrivateArchiveOriginal(env,{type:'service',subject:owner.subject},'family',first.id,stream(photo),dependencies)).status,403);
assert.equal((await storePrivateArchiveOriginal(env,{type:'browser',subject:'different'},'family',first.id,stream(photo),dependencies)).status,404);
for (const bytes of [photo.subarray(1),Buffer.concat([photo,Buffer.from([0])]),Buffer.alloc(photo.length)]) {
    assert.equal((await storePrivateArchiveOriginal(env,owner,'family',first.id,stream(bytes),dependencies)).status,422);
}
assert.equal(env.PRIVATE_ORIGINALS.calls.length,0);
assert.deepEqual(await store(first),{ok:true,status:200,state:'quarantined'});
assert.deepEqual(env.PRIVATE_ORIGINALS.objects.get(key(first)).bytes,photo);
const replayCalls=env.PRIVATE_ORIGINALS.calls.length;
assert.equal((await store(first)).state,'quarantined');
assert.equal(env.PRIVATE_ORIGINALS.calls.length,replayCalls);
assert.deepEqual((await readPrivateGalleryAsset(env,owner,'family',first.id)).asset.personIds,people);
assert.equal(count('private_archive_original_receipts',first.id),1);
const second=await asset('everyone','png',png);
second.input.containsMinors=true;second.input.guardianApprovalConfirmed=true;
assert.equal((await prepare(second)).status,201);
assert.equal((await store(second)).state,'quarantined');
assert.equal((await remove(first)).state,'private-original-deleted');
assert.equal(env.PRIVATE_ORIGINALS.objects.has(key(first)),false);
assert.equal(env.PRIVATE_ORIGINALS.objects.has(key(second)),true);
assert.equal(count('private_archive_deletion_receipts',first.id),1);
assert.deepEqual((await readPrivateGalleryAsset(env,owner,'family',first.id)).asset.personIds,people);
const callsAfterDelete=env.PRIVATE_ORIGINALS.calls.length;
assert.equal((await remove(first)).state,'private-original-deleted');
assert.equal((await store(first)).status,409);
assert.equal((await prepare(first)).status,409);
assert.equal(env.PRIVATE_ORIGINALS.calls.length,callsAfterDelete);

// Deletion before any writer registration fences both late creation and bytes.
const beforeCreate=await asset();await prepare(beforeCreate);
env.PRIVATE_ORIGINALS.hooks.create=async()=>{assert.equal((await remove(beforeCreate)).state,'private-original-deleted');};
assert.equal((await store(beforeCreate)).status,409);
assert.equal(count('private_archive_multipart_uploads',beforeCreate.id),0);
assert.equal(env.PRIVATE_ORIGINALS.objects.has(key(beforeCreate)),false);

// Deletion between part admission and completion aborts the provider writer.
const partRace=await asset();await prepare(partRace);
env.PRIVATE_ORIGINALS.hooks.part=async()=>{assert.equal((await remove(partRace)).state,'private-original-deleted');};
assert.equal((await store(partRace)).status,503);
assert.equal(count('private_archive_original_receipts',partRace.id),0);
assert.equal(env.PRIVATE_ORIGINALS.objects.has(key(partRace)),false);
// A complete call already in flight is also invalid after successful abort.
const completeRace=await asset();await prepare(completeRace);
env.PRIVATE_ORIGINALS.hooks.complete=async()=>{assert.equal((await remove(completeRace)).state,'private-original-deleted');};
assert.equal((await store(completeRace)).status,503);
assert.equal(env.PRIVATE_ORIGINALS.objects.has(key(completeRace)),false);

// The opposite ordering: completion wins, but its lost response arrives only
// after deletion; no original receipt may be committed and nothing reappears.
const lateResponse=await asset();await prepare(lateResponse);
env.PRIVATE_ORIGINALS.hooks.completed=async()=>{assert.equal((await remove(lateResponse)).state,'private-original-deleted');};
assert.notEqual((await store(lateResponse)).ok,true);
assert.equal(count('private_archive_original_receipts',lateResponse.id),0);
assert.equal(env.PRIVATE_ORIGINALS.objects.has(key(lateResponse)),false);

// Successful storage followed by a lost D1 response reconciles immutable state.
for (const table of ['private_archive_intakes','private_archive_multipart_uploads','private_archive_original_receipts']) {
    const a=await asset();
    afterSql=sql=>{if(sql.includes(`INSERT INTO ${table}`)){afterSql=undefined;throw new Error('synthetic lost SQL response');}};
    assert.equal((await prepare(a)).ok,true);
    assert.equal((await store(a)).ok,true);
    assert.equal(count(table,a.id),1);
    assert.equal((await remove(a)).ok,true);
}
for (const table of ['private_archive_deletion_requests','private_archive_writer_closures','private_archive_deletion_receipts']) {
    const a=await asset();await prepare(a);await store(a);
    afterSql=sql=>{if(sql.includes(`INSERT INTO ${table}`)){afterSql=undefined;throw new Error('synthetic lost SQL response');}};
    assert.equal((await remove(a)).state,'private-original-deleted');
    assert.equal(count(table,a.id),1);
}
const badAbort=await asset();await prepare(badAbort);await store(badAbort);
env.PRIVATE_ORIGINALS.hooks.abort=()=>{throw new Error('synthetic permission denied, not NoSuchUpload');};
assert.equal((await remove(badAbort)).status,503);
assert.equal(count('private_archive_deletion_receipts',badAbort.id),0);
assert.equal(env.PRIVATE_ORIGINALS.objects.has(key(badAbort)),true);
assert.equal((await store(badAbort)).status,409);
assert.equal((await remove(badAbort)).state,'private-original-deleted');

// Private R2 absence is not accepted until the sole possible writer is closed.
const absent=await asset();await prepare(absent);
env.PRIVATE_ORIGINALS.hooks.part=()=>{throw new Error('synthetic stopped part');};
assert.equal((await store(absent)).status,503);
env.PRIVATE_ORIGINALS.hooks.abort=()=>{throw new Error('synthetic unavailable');};
assert.equal((await remove(absent)).status,503);
assert.equal(count('private_archive_deletion_receipts',absent.id),0);
assert.equal((await remove(absent)).state,'private-original-deleted');

const failedDelete=await asset();await prepare(failedDelete);await store(failedDelete);
env.PRIVATE_ORIGINALS.hooks.delete=()=>{throw new Error('synthetic delete failure');};
assert.equal((await remove(failedDelete)).status,503);
const callsBeforeResume=env.PRIVATE_ORIGINALS.calls.filter(c=>c.op==='abort').length;
assert.equal((await remove(failedDelete)).state,'private-original-deleted');
assert.equal(env.PRIVATE_ORIGINALS.calls.filter(c=>c.op==='abort').length,callsBeforeResume);

// Mismatched/oversized conditional readback cannot acquire a stored receipt.
for (const mutation of ['hash','oversized','version','condition']) {
    const a=await asset();await prepare(a);env.PRIVATE_ORIGINALS.corrupt=mutation;
    assert.equal((await store(a)).status,503,mutation);
    assert.equal(count('private_archive_original_receipts',a.id),0);
    env.PRIVATE_ORIGINALS.corrupt=null;
    assert.equal((await remove(a)).state,'private-original-deleted');
}
const stale=await asset();
beforeSql=sql=>{if(sql.includes('INSERT INTO private_archive_intakes')){beforeSql=undefined;db.prepare('UPDATE private_gallery_people SET display_name=? WHERE person_id=?').run('Synthetic Edited',people[1]);}};
assert.equal((await prepare(stale)).status,409);
assert.equal(count('private_archive_intakes',stale.id),0);

const receiptRace=await asset();await prepare(receiptRace);
beforeSql=sql=>{if(sql.includes('INSERT INTO private_archive_original_receipts')){beforeSql=undefined;db.prepare('UPDATE private_gallery_people SET display_name=? WHERE person_id=?').run('Synthetic Changed At Receipt',people[1]);}};
assert.equal((await store(receiptRace)).status,503);
assert.equal(count('private_archive_original_receipts',receiptRace.id),0);
assert.equal((await remove(receiptRace)).state,'private-original-deleted');

const expiration=await asset();await prepare(expiration);
// Controlled corrupt-clock fixture only, restoring the exact trigger after it.
const clockTrigger=db.prepare("SELECT sql FROM sqlite_schema WHERE name='private_archive_intake_no_update'").get().sql;
db.exec('DROP TRIGGER private_archive_intake_no_update');
db.prepare("UPDATE private_archive_intakes SET created_at='2000-01-01T00:00:00.000Z' WHERE asset_id=?").run(expiration.id);
db.exec(clockTrigger);
const callsBeforeExpiry=env.PRIVATE_ORIGINALS.calls.length;
assert.equal((await store(expiration)).status,409);
assert.equal(env.PRIVATE_ORIGINALS.calls.length,callsBeforeExpiry);
assert.throws(()=>db.prepare('INSERT INTO private_archive_multipart_uploads VALUES (?,?)').run(expiration.id,'synthetic-expired'));
assert.equal((await remove(expiration)).state,'private-original-deleted');

// Admission time is SQL-owned, and no direct SQL shortcuts replace receipts,
// claim publication consent, reopen deletion or admit an original after revoke.
for (const table of ['private_archive_intakes','private_archive_multipart_uploads','private_archive_original_receipts',
    'private_archive_deletion_requests','private_archive_writer_closures','private_archive_deletion_receipts']) {
    const row=db.prepare(`SELECT * FROM ${table} WHERE asset_id=?`).get(first.id);
    assert.ok(row);
    const columns=Object.keys(row);
    assert.throws(()=>db.prepare(`INSERT OR REPLACE INTO ${table} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`).run(...columns.map(c=>row[c])));
    assert.throws(()=>db.prepare(`UPDATE ${table} SET asset_id=asset_id WHERE asset_id=?`).run(first.id));
    assert.throws(()=>db.prepare(`DELETE FROM ${table} WHERE asset_id=?`).run(first.id));
}
const unclosed=await asset();await prepare(unclosed);
db.prepare('INSERT INTO private_archive_multipart_uploads VALUES (?,?)').run(unclosed.id,'synthetic-unclosed');
const ownerHash=db.prepare('SELECT owner_identity_hash FROM private_gallery_assets WHERE asset_id=?').get(unclosed.id).owner_identity_hash;
db.prepare("INSERT INTO private_archive_deletion_requests (asset_id,actor_identity_hash,reason) VALUES (?,?,'owner-delete')").run(unclosed.id,ownerHash);
assert.throws(()=>db.prepare('INSERT INTO private_archive_deletion_receipts (asset_id,original_absent) VALUES (?,1)').run(unclosed.id));
assert.throws(()=>db.prepare("INSERT INTO private_archive_writer_closures (asset_id,provider_upload_id,proof) VALUES (?,?,'abort-confirmed')").run(unclosed.id,'wrong'));

// This preparatory API is not externally reachable, even by the valid owner.
const routeEnv={...env,ADMIN_ORIGIN:'https://synthetic-archive.example',OWNER_IDENTITIES:'subject:synthetic-owner',SESSION_SECRET:'synthetic-archive-only-session-secret'};
for (const suffix of ['archive','archive/upload','archive/deletion']) {
    const res=await handleAdminRequest(new Request(`${routeEnv.ADMIN_ORIGIN}/api/browser/private-assets/${second.id}/${suffix}?site=everyone`,{method:'POST'}),routeEnv,{verifyAccessIdentity:async()=>owner});
    assert.equal(res.status,404);
}
assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
// Real local R2, not just a storage fake: prove provider multipart closure,
// conditional readback, complete/read/delete and zero-byte resurrection fence.
const require=createRequire(import.meta.url);
const {Miniflare,convertV4MiniflareOptions}=createRequire(require.resolve('wrangler/package.json'))('miniflare');
const runtime=new Miniflare(convertV4MiniflareOptions({cf:false,workers:[{name:'private-archive-fixture',modules:true,
    script:"export default {fetch(){return new Response('synthetic-local-only')}}",
    compatibilityDate:'2026-08-25',r2Buckets:['PRIVATE_ORIGINALS']}]}));
try {
    env.PRIVATE_ORIGINALS=await runtime.getR2Bucket('PRIVATE_ORIGINALS');
    const actual=await asset();
    assert.equal((await prepare(actual)).status,201);
    assert.equal((await store(actual)).state,'quarantined');
    const object=await env.PRIVATE_ORIGINALS.get(key(actual));
    assert.deepEqual(Buffer.from(await object.arrayBuffer()),photo);
    const uploadId=db.prepare('SELECT provider_upload_id FROM private_archive_multipart_uploads WHERE asset_id=?').get(actual.id).provider_upload_id;
    assert.equal((await remove(actual)).state,'private-original-deleted');
    assert.equal(await env.PRIVATE_ORIGINALS.head(key(actual)),null);
    await assert.rejects(env.PRIVATE_ORIGINALS.resumeMultipartUpload(key(actual),uploadId).complete([{partNumber:1,etag:'synthetic'}]));
    assert.equal(await env.PRIVATE_ORIGINALS.head(key(actual)),null);
    assert.equal((await store(actual)).status,409);
} finally { await runtime.dispose(); }
db.close();
console.log('Private archive quarantine: separate retention consent, bounded JPEG/PNG bytes, SQL revision/terminal fences, exact writer closure, readback, interruption recovery and no external route passed.');

function bucket() {
    const objects=new Map(),uploads=new Map(),calls=[],hooks={};
    let serial=0;
    const missing=()=>Object.assign(new Error('NoSuchUpload'),{name:'NoSuchUpload'});
    async function hook(name){const fn=hooks[name];delete hooks[name];await fn?.();}
    const resume=(key,id)=>({key,uploadId:id,
        async uploadPart(partNumber,value){calls.push({op:'part',key,id});await hook('part');const u=uploads.get(id);if(!u)throw missing();u.bytes=Buffer.from(value);return {partNumber,etag:sha(u.bytes)};},
        async complete(parts){calls.push({op:'complete',key,id});await hook('complete');const u=uploads.get(id);if(!u)throw missing();assert.equal(parts[0].etag,sha(u.bytes));const o={key,size:u.bytes.length,version:`synthetic-v${++serial}`,etag:sha(u.bytes),bytes:u.bytes};objects.set(key,o);uploads.delete(id);await hook('completed');return {...o};},
        async abort(){calls.push({op:'abort',key,id});await hook('abort');if(!uploads.delete(id))throw missing();}
    });
    const api={objects,calls,hooks,corrupt:null,
        async createMultipartUpload(key,options){calls.push({op:'create',key});assert.deepEqual(options,{httpMetadata:{contentType:'application/octet-stream',cacheControl:'no-store'}});const id=`synthetic-upload-${++serial}`;uploads.set(id,{key});await hook('create');return resume(key,id);},
        resumeMultipartUpload:resume,
        async head(key){calls.push({op:'head',key});return objects.has(key)?{...objects.get(key)}:null;},
        async get(key,options){calls.push({op:'get',key});const o=objects.get(key);if(!o)return null;assert.equal(options.onlyIf.etagMatches,o.etag);
            if(api.corrupt==='condition')return {...o};
            const bytes=api.corrupt==='hash'?Buffer.alloc(o.bytes.length):api.corrupt==='oversized'?Buffer.concat([o.bytes,Buffer.from([0])]):o.bytes;
            return {...o,version:api.corrupt==='version'?'synthetic-wrong':o.version,body:stream(bytes)};},
        async delete(key){calls.push({op:'delete',key});await hook('delete');objects.delete(key);}
    };return api;
}
