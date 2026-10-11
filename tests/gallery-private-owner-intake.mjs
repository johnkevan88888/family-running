import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir} from 'node:fs/promises';
import sharp from 'sharp';
import catalog from '../gallery-admin/generated/catalog-snapshot.js';
import {handleAdminRequest} from '../gallery-admin/src/admin-worker.js';
import {createBrowserSession} from '../gallery-admin/src/session.js';
import {readPrivateGalleryRoster} from '../gallery-admin/src/private-gallery-roster-service.js';
import {changePrivateGalleryVisibility,readPrivateGalleryAssetEligibility} from '../gallery-admin/src/private-gallery-visibility-service.js';
import {readBoundedBytes,sha256Hex} from '../gallery-admin/src/media-byte-verification.js';
import {syntheticBucket} from './helpers/private-gallery-lifecycle-fixtures.mjs';

const directory=new URL('../gallery-admin/migrations/',import.meta.url);
const migrations=await Promise.all((await readdir(directory)).filter(name=>name.endsWith('.sql')).sort()
    .map(name=>readFile(new URL(name,directory),'utf8')));
const origin='https://synthetic-owner-intake.example',owner={type:'browser',subject:'synthetic-owner-intake'};
const photo=await sharp({create:{width:12,height:18,channels:3,background:'#3478aa'}}).jpeg().toBuffer();
for(const site of ['family','everyone']) {
    const db=new DatabaseSync(':memory:');for(const sql of migrations)db.exec(sql);
    const bucket=syntheticBucket();
    const env={ADMIN_ORIGIN:origin,OWNER_IDENTITIES:'subject:synthetic-owner-intake',SESSION_SECRET:'synthetic-owner-intake-session-key',
        PRIVATE_ORIGINALS:bucket,DB:{prepare(sql){let args=[];return {bind(...values){args=values;return this;},
            async first(){return db.prepare(sql).get(...args)??null;},async all(){return {success:true,results:db.prepare(sql).all(...args)};},
            async run(){const result=db.prepare(sql).run(...args);return {success:true,meta:{changes:Number(result.changes)}};}};}}};
    const person='person_00000000-0000-4000-8000-000000000001';
    db.prepare('INSERT INTO private_gallery_people VALUES(?,?,?,?,?)').run(person,'Fictional private-only runner',null,1,1);
    const session=await createBrowserSession(owner,env,site,Date.now());
    const dependencies={verifyAccessIdentity:async()=>owner,bodyTimeoutMilliseconds:20,
        digestReadable:async body=>sha256Hex(await readBoundedBytes(body,photo.length))};
    const headers=()=>({'Cookie':session.cookie.split(';')[0],'X-CSRF-Token':session.csrfToken,'Origin':origin,'Sec-Fetch-Site':'same-origin'});
    const request=(path,body,method='POST',extra={})=>new Request(origin+path+'?site='+site,{
        method,headers:{...headers(),...(body===undefined?{}:{'Content-Type':'application/json'}),...extra},
        body:body===undefined?undefined:JSON.stringify(body)});
    const api=async (path,body,method='POST')=>{
        const response=await handleAdminRequest(request(path,body,method),env,dependencies);
        assert.ok(response.ok,await response.clone().text());return response.json();
    };
    const roster=(await readPrivateGalleryRoster(env,site)).revision;
    const saved=await api('/api/browser/private-assets',{idempotencyKey:crypto.randomUUID(),rosterRevision:roster,personIds:[person],originalFormat:'jpg'});
    const path='/api/browser/private-assets/'+saved.asset.assetId;
    const intake={rosterRevision:roster,tagVersion:1,byteCount:photo.length,sha256:await sha256Hex(photo),declaredMimeType:'image/jpeg',
        privateRetentionConfirmed:true,containsMinors:false,guardianApprovalConfirmed:false};
    const upload=()=>new Request(origin+path+'/archive-original?site='+site,{method:'PUT',headers:{...headers(),
        'Content-Type':'application/octet-stream','Content-Length':String(photo.length)},body:photo});
    for(const [changed,identity] of [[{'X-CSRF-Token':'wrong'},owner],[{}, {type:'service',subject:'synthetic-service'}]]) {
        const body=request(path+'/archive-intake',intake,'POST',changed);
        const response=await handleAdminRequest(body,env,{...dependencies,verifyAccessIdentity:async()=>identity});
        assert.equal(response.status,403);
    }
    const otherSession=await createBrowserSession(owner,env,site==='family'?'everyone':'family',Date.now());
    assert.equal((await handleAdminRequest(request(path+'/archive-intake',intake,'POST',{
        Cookie:otherSession.cookie.split(';')[0],'X-CSRF-Token':otherSession.csrfToken}),env,dependencies)).status,403);
    assert.equal(db.prepare('SELECT count(*) n FROM private_archive_intakes').get().n,0);
    assert.equal(bucket.calls.length,0);
    assert.equal((await api(path+'/archive-intake',undefined,'GET')).state,'awaiting-original');
    assert.equal((await api(path+'/archive-intake',intake)).state,'awaiting-upload');
    const uploaded=await handleAdminRequest(upload(),env,dependencies);assert.equal(uploaded.status,200,await uploaded.clone().text());
    assert.equal((await api(path+'/archive-intake',undefined,'GET')).state,'quarantined');
    const retained=db.prepare('SELECT * FROM private_archive_original_receipts').get();
    const calls=bucket.calls.length;
    assert.equal((await handleAdminRequest(upload(),env,dependencies)).status,200);
    assert.equal(bucket.calls.length,calls,'Lost successful reply retry does not upload again');
    assert.deepEqual(db.prepare('SELECT * FROM private_archive_original_receipts').get(),retained);
    const serial=JSON.stringify(await api(path+'/archive-intake',undefined,'GET'));
    for(const sentinel of ['private_object_key','provider_version','provider_etag','private-archive','Fictional']) assert.equal(serial.includes(sentinel),false);
    const input=async()=>({idempotencyKey:crypto.randomUUID(),tagVersion:1,eligibilityRevision:
        (await readPrivateGalleryAssetEligibility(env,owner,site,saved.asset.assetId,catalog)).revision,
        sourceRevision:catalog.sourceRevision,suppressionRevision:catalog.suppressionRevision,raceIndex:0,
        completeTagsConfirmed:true,publicUseConfirmed:true,containsMinors:false,guardianApprovalConfirmed:false});
    assert.equal((await handleAdminRequest(request(path+'/archive-attempt',await input()),env,dependencies)).status,409,'Initially hidden person blocks consent reservation');
    assert.equal((await changePrivateGalleryVisibility(env,owner,site,person,{expectedVersion:1,idempotencyKey:crypto.randomUUID(),preference:'allowed'})).ok,true);
    const consent=await input(),attempt=await api(path+'/archive-attempt',consent);
    assert.match(attempt.attemptId,/^attempt_/);assert.equal(attempt.processingEnabled,false);assert.equal(attempt.publicationEnabled,false);
    assert.equal((await api(path+'/archive-attempt',consent)).attemptId,attempt.attemptId);
    assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_attempts').get().n,1);
    assert.equal(db.prepare('SELECT count(*) n FROM gallery_drafts').get().n,0);
    // Slow/unknown streams stop at one total deadline without provider writes.
    const stalled=new Request(origin+path+'/archive-original?site='+site,{method:'PUT',headers:{...headers(),'Content-Type':'application/octet-stream'},
        body:new ReadableStream({pull(){return new Promise(()=>{});},cancel(){return new Promise(()=>{});}}),duplex:'half'});
    const start=Date.now();assert.equal((await handleAdminRequest(stalled,env,dependencies)).status,400);
    assert.ok(Date.now()-start<1000);assert.equal(bucket.calls.length,calls);
    assert.equal((await handleAdminRequest(request(path+'/archive-attempt',{...consent,owner:'invented'}),env,dependencies)).status,422);
    const deletion=await api(path+'/archive-deletion',{reason:'consent-withdrawal'});assert.equal(deletion.state,'private-original-deleted');
    assert.equal((await handleAdminRequest(request(path+'/archive-attempt',consent),env,dependencies)).status,409);
    assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_asset_tags').get().n,1,'Original removal is not metadata purge');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);db.close();
}
console.log('Protected owner archive intake/consent routes passed both areas, session/CSRF/service denial, exact retries, bounded streams and terminal deletion precedence.');
