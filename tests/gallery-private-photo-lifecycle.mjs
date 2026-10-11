import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile,readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { syntheticBucket,syntheticGitHub,digest } from './helpers/private-gallery-lifecycle-fixtures.mjs';
import { reservePrivateGalleryAsset } from '../gallery-admin/src/private-gallery-asset-service.js';
import { readPrivateGalleryRoster } from '../gallery-admin/src/private-gallery-roster-service.js';
import { reservePrivateGalleryAttempt } from '../gallery-admin/src/private-gallery-attempt-service.js';
import { changePrivateGalleryVisibility,readPrivateGalleryAssetEligibility } from '../gallery-admin/src/private-gallery-visibility-service.js';
import { preparePrivateArchiveIntake,storePrivateArchiveOriginal,deletePrivateArchiveOriginal } from '../gallery-admin/src/private-archive-service.js';
import { admitArchivePhotoProcessing,readArchivePhotoSource,readArchivePhotoCandidateItem,
    verifyArchivePhotoPublicAbsence,removeArchivePhotoCopies,closeArchivePhotoAttempt } from '../gallery-admin/src/private-gallery-photo-lifecycle.js';
import { runArchivePhotoReview,restoreArchivePhotoReview,hideArchivePhotoPerson,resumeArchivePhotoRemoval,requestArchivePhotoManifestRemoval } from '../scripts/gallery-media/private-photo-lifecycle.mjs';
import { createOrReconcileGalleryRemoval,createOrReconcileGalleryReview } from '../scripts/gallery-media/github-review-client.mjs';
import { readBoundedBytes,sha256Hex } from '../gallery-admin/src/media-byte-verification.js';
import * as delivery from '../gallery-admin/src/media-delivery-contract.js';
import { handleMediaRequest } from '../gallery-admin/src/media-worker.js';
import { isPublishedPath } from '../scripts/published-site-entries.mjs';

const migrations=new URL('../gallery-admin/migrations/',import.meta.url);
const names=(await readdir(migrations)).filter(name=>name.endsWith('.sql')).sort();
const require=createRequire(import.meta.url);
// Exercise the pinned CLI splitter as well as SQLite. In particular, a CASE
// expression inside BEGIN/END must not prematurely terminate a trigger.
const {unstable_splitSqlQuery}=require('wrangler');
const parserDatabase=new DatabaseSync(':memory:');
for(const name of names) {
    const sql=await readFile(new URL(name,migrations),'utf8');
    if(name.startsWith('0023') || name.startsWith('0024')) for(const statement of unstable_splitSqlQuery(sql)) parserDatabase.exec(statement);
    else parserDatabase.exec(sql);
}
parserDatabase.close();
const owner={type:'browser',subject:'synthetic-private-photo-owner'};
const person=n=>`person_00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const photo=await sharp({create:{width:32,height:48,channels:3,background:'#2468ac'}})
    .withExif({IFD0:{Make:'private-camera-sentinel'}}).jpeg().toBuffer();
const witness=await sharp(Buffer.from([0,0,0,0]),{raw:{width:1,height:1,channels:4}})
    .webp({lossless:true,quality:100,effort:6,alphaQuality:100,smartSubsample:false}).toBuffer();
assert.equal(digest(witness),delivery.MEDIA_BINDING_WITNESS_SHA256);

async function fixture(site='family',ids=[person(1),person(2)],actualBuckets=null) {
    const db=new DatabaseSync(':memory:');for(const name of names) db.exec(await readFile(new URL(name,migrations),'utf8'));
    const original=actualBuckets?.original||syntheticBucket(),staging=actualBuckets?.staging||syntheticBucket(),
        approved=actualBuckets?.approved||syntheticBucket(),github=syntheticGitHub();
    const f={db,original,staging,approved,github,site,ids,beforeWrite:null,afterWrite:null,hostFault:null,hostRequests:[]};
    const env={PRIVATE_ORIGINALS:original,PRIVATE_DERIVATIVE_STAGING:staging,APPROVED_MEDIA:approved,
        APPROVED_MEDIA_ORIGIN:'https://synthetic-private-photo.example',EXPECTED_MEDIA_VERSION:'12345678-1234-5678-9abc-1234567890ab',
        DB:{prepare(sql){let args=[];return {bind(...values){args=values;return this;},
            async first(){return db.prepare(sql).get(...args)??null;},async all(){return {success:true,results:db.prepare(sql).all(...args)};},
            async run(){const before=f.beforeWrite;f.beforeWrite=null;await before?.(sql,args);
                const result=db.prepare(sql).run(...args);const after=f.afterWrite;f.afterWrite=null;await after?.(sql,args);
                return {success:true,meta:{changes:Number(result.changes)}};}};}}};f.env=env;
    for(const [n,pub] of [[1,'synthetic-public'],[2,null],[3,null]])
        db.prepare('INSERT INTO private_gallery_people VALUES(?,?,?,?,?)').run(person(n),`Private fictitious runner ${n}`,pub,1,1);
    f.catalog={schemaVersion:'1.0',exportBundleId:'synthetic-private-photo-bundle',sourceRevision:`sha256:${'a'.repeat(64)}`,
        suppressionRevision:`sha256:${'b'.repeat(64)}`,suppressionDocument:{schemaVersion:'1.0',hiddenAthleteIds:[]},sites:{}};
    for(const area of ['family','everyone']) f.catalog.sites[area]={catalog:{exportBundleId:f.catalog.exportBundleId,
        sourceRevision:f.catalog.sourceRevision,races:[{raceDate:'2026-01-01',raceEvent:'Synthetic Race',raceDistance:'5 km'}],athleteIds:['synthetic-public']}};
    f.preference=async (id,preference)=>{
        const version=db.prepare('SELECT version FROM private_gallery_current_visibility WHERE person_id=?').get(id).version;
        const result=await changePrivateGalleryVisibility(env,owner,site,id,{expectedVersion:version,idempotencyKey:crypto.randomUUID(),preference});
        assert.equal(result.ok,true,JSON.stringify(result));return result;
    };
    for(const id of ids) await f.preference(id,'allowed');
    const roster=(await readPrivateGalleryRoster(env,site)).revision;
    const saved=await reservePrivateGalleryAsset(env,owner,site,{idempotencyKey:crypto.randomUUID(),originalFormat:'jpg',personIds:ids,rosterRevision:roster});
    assert.equal(saved.ok,true);f.assetId=saved.asset.assetId;
    assert.equal((await preparePrivateArchiveIntake(env,owner,site,f.assetId,{byteCount:photo.length,sha256:digest(photo),declaredMimeType:'image/jpeg',
        privateRetentionConfirmed:true,containsMinors:false,guardianApprovalConfirmed:false,rosterRevision:roster})).ok,true);
    assert.equal((await storePrivateArchiveOriginal(env,owner,site,f.assetId,new Blob([photo]).stream(),{
        digestReadable:async body=>sha256Hex(await readBoundedBytes(body,photo.length))})).ok,true);
    f.originalRow=db.prepare('SELECT * FROM private_archive_original_receipts WHERE asset_id=?').get(f.assetId);
    f.originalKey=db.prepare('SELECT private_object_key FROM private_gallery_assets WHERE asset_id=?').get(f.assetId).private_object_key;
    f.consent=async ()=>{
        const eligibility=await readPrivateGalleryAssetEligibility(env,owner,site,f.assetId,f.catalog);
        return {idempotencyKey:crypto.randomUUID(),tagVersion:1,
            eligibilityRevision:eligibility.revision,sourceRevision:f.catalog.sourceRevision,suppressionRevision:f.catalog.suppressionRevision,
            raceIndex:0,completeTagsConfirmed:true,publicUseConfirmed:true,containsMinors:false,guardianApprovalConfirmed:false};
    };
    f.fresh=async ()=>reservePrivateGalleryAttempt(env,owner,site,f.assetId,await f.consent(),f.catalog);
    const attempt=await f.fresh();assert.equal(attempt.ok,true,JSON.stringify(attempt));f.attemptId=attempt.attemptId;
    f.rotateEpoch=()=>{
        const prior=db.prepare('SELECT * FROM gallery_media_delivery_current_epoch').get(),n=prior?prior.epoch_sequence+1:1;
        const epochId=`synthetic-photo-epoch-${n}`,epochHash=digest(`epoch:${n}`),activation=digest(`activation:${n}`);
        const registered=`2026-01-${String(n).padStart(2,'0')}T00:00:00.000Z`,activated=`2026-01-${String(n).padStart(2,'0')}T00:00:01.000Z`;
        db.prepare(`INSERT INTO gallery_media_delivery_epochs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(epochId,epochHash,n,env.APPROVED_MEDIA_ORIGIN,
            digest(`approved-media-origin:${env.APPROVED_MEDIA_ORIGIN}`),digest(`approved-media-contract:${delivery.MEDIA_DELIVERY_CONTRACT_VALUE}`),
            digest(`approved-media-version:${env.EXPECTED_MEDIA_VERSION}`),digest(`approved-object-key:${delivery.MEDIA_BINDING_WITNESS_KEY}`),
            delivery.MEDIA_BINDING_WITNESS_SHA256,28,'image/webp',digest(`config:${n}`),digest('synthetic-actor'),registered);
        db.prepare('INSERT INTO gallery_media_delivery_epoch_activations VALUES(?,?,?,?,?,?,?,?)').run(activation,epochHash,n,prior?.epoch_id_hash??null,
            digest(`activation-key:${n}`),digest(`activation-payload:${n}`),digest('synthetic-actor'),activated);
        if(!prior) db.prepare('INSERT INTO gallery_media_delivery_current_epoch VALUES(1,?,?,?,?)').run(epochHash,n,activation,activated);
        else db.prepare('UPDATE gallery_media_delivery_current_epoch SET epoch_id_hash=?,epoch_sequence=?,activation_receipt_hash=?,activated_at=? WHERE singleton_id=1')
            .run(epochHash,n,activation,activated);
    };f.rotateEpoch();
    if(actualBuckets) await approved.put(delivery.MEDIA_BINDING_WITNESS_KEY,witness,{httpMetadata:{contentType:'image/webp',cacheControl:'no-store'}});
    else approved.objects.set(delivery.MEDIA_BINDING_WITNESS_KEY,{key:delivery.MEDIA_BINDING_WITNESS_KEY,bytes:witness,size:28,version:'witness',etag:'witness',
        httpMetadata:{contentType:'image/webp',cacheControl:'no-store'}});
    f.publicFetch=async request=>{
        assert.equal(new URL(request.url).origin,env.APPROVED_MEDIA_ORIGIN);assert.equal(request.redirect,'manual');assert.equal(request.cache,'no-store');
        assert.equal(request.credentials,'omit');assert.equal(request.headers.get('Cache-Control'),'no-cache, no-store');
        f.hostRequests.push([request.method,request.url]);
        let response=await handleMediaRequest(request,{APPROVED_MEDIA:approved,MEDIA_VERSION:{id:env.EXPECTED_MEDIA_VERSION}});
        Object.defineProperty(response,'url',{value:request.url});
        if(f.hostFault) response=await f.hostFault(request,response);return response;
    };
    f.options=()=>({env,identity:owner,site,attemptId:f.attemptId,catalog:f.catalog,github,publicFetch:f.publicFetch,timeoutMilliseconds:50});
    f.retain=()=>{
        assert.deepEqual(db.prepare('SELECT * FROM private_archive_original_receipts WHERE asset_id=?').get(f.assetId),f.originalRow);
        const originalObject=original.objects.get(f.originalKey);assert.deepEqual(originalObject.bytes,photo);
        assert.equal(originalObject.version,f.originalRow.provider_version);assert.equal(originalObject.etag,f.originalRow.provider_etag);
        assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_current_asset_tags WHERE asset_id=?').get(f.assetId).n,ids.length);
        assert.equal(db.prepare('SELECT count(*) n FROM gallery_drafts').get().n,0);
    };return f;
}

for(const site of ['family','everyone']) {
    const f=await fixture(site),{db,env}=f;
    const originalCalls=f.original.calls.length;
    for(const identity of [{type:'service',subject:'synthetic-service'},{type:'browser',subject:'different-owner'}]) {
        assert.equal((await admitArchivePhotoProcessing(env,identity,site,f.attemptId,f.catalog)).ok,false);
        await assert.rejects(readArchivePhotoSource(env,identity,site,f.attemptId,f.catalog));
    }
    assert.equal((await admitArchivePhotoProcessing(env,owner,site==='family'?'everyone':'family',f.attemptId,f.catalog)).ok,false);
    assert.equal(f.original.calls.length,originalCalls,'Denied contexts perform no source I/O');
    const review=await runArchivePhotoReview(f.options());assert.equal(review.ok,true,JSON.stringify(review));assert.equal(review.state,'unmerged-review');
    const item=await readArchivePhotoCandidateItem(env,owner,site,f.attemptId,f.catalog);
    assert.deepEqual(item.athleteIds,['synthetic-public']);assert.equal(item.raceEvent,'Synthetic Race');
    assert.match(item.sourceUrl,/\/media\/v2\/[0-9a-f-]{36}\/[a-f0-9]{64}\/display.webp$/);
    const intent=JSON.parse(db.prepare('SELECT candidate_json FROM private_gallery_pipeline_review_intents WHERE attempt_id=?').get(f.attemptId).candidate_json);
    assert.equal(intent.targetRelativePath,`gallery-data/${site}.json`);assert.equal(JSON.parse(intent.manifestText).items.length,1);
    for(const sentinel of ['private-camera-sentinel','Private fictitious','person_','asset_','attempt_','consent','provider','original'])
        assert.equal(intent.manifestText.includes(sentinel),false,sentinel);
    const requests=f.github.state.requests.length;
    assert.equal((await runArchivePhotoReview(f.options())).ok,true);
    assert.equal(f.github.state.requests.slice(requests).every(r=>r.method==='GET'),true,'Review replay is read-only');
    f.retain();
    // Represent a separately approved owner publication in fixture state only.
    f.github.ownerMerge(review.review);
    const version=db.prepare('SELECT version FROM private_gallery_current_visibility WHERE person_id=?').get(person(2)).version;
    const hidden=await hideArchivePhotoPerson({...f.options(),personId:person(2),input:{expectedVersion:version,idempotencyKey:crypto.randomUUID(),preference:'hidden'}});
    assert.equal(hidden.ok,false);assert.equal(hidden.outcomes[0].state,'manifest-removal-required',JSON.stringify(hidden));
    assert.equal(hidden.outcomes[0].hostDeletionConfirmed,true);assert.equal(f.approved.objects.size,1);assert.equal(f.staging.objects.size,0);
    f.retain();assert.deepEqual(f.github.state.manifests[site].items[0],item,'Hiding cannot secretly merge a manifest change');
    const removalReview=await requestArchivePhotoManifestRemoval(f.options());
    assert.equal(removalReview.ok,true,JSON.stringify(removalReview));
    assert.equal(removalReview.state,'unmerged-removal-review');assert.equal(removalReview.completed,false);
    assert.deepEqual(f.github.state.manifests[site].items[0],item,'Removal review cannot merge or alter main');
    const removed=JSON.parse(db.prepare('SELECT removal_json FROM private_gallery_manifest_removal_intents').get().removal_json);
    const options={expectedBaseSha:f.github.state.main,token:f.github.token,fetchImpl:f.github.fetchImpl};
    const before=f.github.state.requests.length;
    assert.equal((await requestArchivePhotoManifestRemoval(f.options())).ok,true);
    assert.ok(f.github.state.requests.slice(before).every(request=>request.method==='GET'),'Exact removal retry is read-only');
    const candidateBad={...intent,manifestText:removed.manifestText,manifestSha256:removed.manifestSha256,
        receipt:{...intent.receipt,manifestSha256:removed.manifestSha256}};
    await assert.rejects(createOrReconcileGalleryReview(candidateBad,options),'Addition client still rejects a removal');
    for(const mutation of [{...removed,operationId:'promotion_wrong'},
        {...removed,item:{...removed.item,raceEvent:'Wrong race'}},
        {...removed,targetRelativePath:`gallery-data/${site==='family'?'everyone':'family'}.json`}]) {
        const requests=f.github.state.requests.length;
        await assert.rejects(createOrReconcileGalleryRemoval(mutation,options));
        assert.ok(f.github.state.requests.slice(requests).every(request=>request.method==='GET'),'Invalid removal cannot mutate GitHub');
    }
    f.github.ownerMerge(removalReview.review); // Explicit fixture owner approval only.
    let movedMain=false;
    f.afterWrite=function moveAtManifest(sql) {
        if(!/INSERT INTO private_gallery_pipeline_manifest_receipts/.test(sql)) {f.afterWrite=moveAtManifest;return;}
        f.github.state.main='d'.repeat(40);movedMain=true;};
    assert.equal((await resumeArchivePhotoRemoval(f.options())).ok,false,'Main movement during receipt insertion remains pending');
    assert.equal(movedMain,true,'The competing main update must actually occur');
    const done=await resumeArchivePhotoRemoval(f.options());assert.equal(done.completed,true,JSON.stringify(done));
    const old=f.attemptId,oldGeneration=db.prepare('SELECT generation_id FROM private_gallery_attempts WHERE attempt_id=?').get(old).generation_id;
    const calls=f.original.calls.length;assert.equal((await resumeArchivePhotoRemoval(f.options())).completed,true);assert.equal(f.original.calls.length,calls);
    assert.equal((await admitArchivePhotoProcessing(env,owner,site,old,f.catalog)).ok,false,'Retired generation cannot reopen');
    await f.preference(person(1),'hidden');await f.preference(person(2),'allowed');
    const deniedRequests=f.github.state.requests.length,deniedReads=f.original.calls.length;
    assert.equal((await restoreArchivePhotoReview({...f.options(),assetId:f.assetId,consent:await f.consent()})).ok,false,
        'Another hidden person blocks the whole photo');
    assert.equal(f.github.state.requests.length,deniedRequests);assert.equal(f.original.calls.length,deniedReads);
    await f.preference(person(1),'allowed');
    assert.equal((await restoreArchivePhotoReview({...f.options(),assetId:f.assetId,consent:{}})).ok,false,'Allow does not supply public consent');
    // A previously valid receipt must not admit new bytes if external main
    // later references the retired photo again. This is fixture-only owner state.
    f.github.state.manifests[site].items.push(item);f.github.state.main='c'.repeat(40);
    const beforeRestore=f.original.calls.length;
    assert.equal((await restoreArchivePhotoReview({...f.options(),assetId:f.assetId,consent:await f.consent()})).ok,false,
        'Historical removal evidence is not current manifest convergence');
    assert.equal(f.original.calls.length,beforeRestore);assert.equal(f.approved.objects.size,1);
    f.github.ownerRemove(site,item.id);
    const restored=await restoreArchivePhotoReview({...f.options(),assetId:f.assetId,consent:await f.consent()});
    assert.equal(restored.ok,true,JSON.stringify(restored));f.attemptId=restored.attemptId;
    const restoredItem=await readArchivePhotoCandidateItem(env,owner,site,f.attemptId,f.catalog);
    assert.notEqual(restoredItem.sourceUrl,item.sourceUrl);assert.notEqual(restoredItem.thumbnailUrl,item.thumbnailUrl);
    assert.notEqual(db.prepare('SELECT generation_id FROM private_gallery_attempts WHERE attempt_id=?').get(f.attemptId).generation_id,oldGeneration);
    const oldHash=db.prepare("SELECT sha256 FROM private_gallery_pipeline_outputs WHERE attempt_id=? AND tier='approved' AND role='photo-display'").get(old).sha256;
    assert.equal(db.prepare("SELECT sha256 FROM private_gallery_pipeline_outputs WHERE attempt_id=? AND tier='approved' AND role='photo-display'").get(f.attemptId).sha256,oldHash,
        'Identical stripped bytes use a new generation, not altered pixels/hash salt');
    f.retain();assert.equal(f.github.state.pulls.at(-1).state,'open');assert.equal(f.github.state.manifests[site].items.length,0);
    // Immutable evidence and no legacy purge reachability.
    for(const table of ['admissions','outputs','writers','byte_receipts','review_intents','reviews','closures','object_removals','host_receipts','manifest_receipts']) {
        assert.throws(()=>db.exec(`DELETE FROM private_gallery_pipeline_${table}`),/immutable|purge/);
        assert.throws(()=>db.exec(`INSERT OR REPLACE INTO private_gallery_pipeline_${table} SELECT * FROM private_gallery_pipeline_${table}`),/replaced|eligible|closed|incomplete/);
    }
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');db.close();
}

// Public-host absence is independently required, not inferred from R2.
{
    const f=await fixture();assert.equal((await runArchivePhotoReview(f.options())).ok,true);
    await f.preference(person(2),'hidden');assert.equal((await removeArchivePhotoCopies(f.env,owner,f.site,f.attemptId)).ok,true);
    const epochHash=f.db.prepare('SELECT epoch_id_hash FROM gallery_media_delivery_current_epoch').get().epoch_id_hash;
    assert.throws(()=>f.db.prepare('INSERT INTO private_gallery_pipeline_host_receipts(attempt_id,epoch_id_hash,evidence_json) VALUES(?,?,?)')
        .run(f.attemptId,epochHash,'{}'),/proof|witness/i,'A direct generic proof cannot bypass the complete network evidence shape');
    const targetCount=f.db.prepare("SELECT count(*) n FROM private_gallery_pipeline_outputs WHERE tier='approved'").get().n;assert.equal(targetCount,2);
    for(const fault of ['live','cached','redirect','wrong-version','nonempty','wrong-witness','generic','body-timeout']) {
        f.hostFault=async (request,response)=>{
            const isWitness=request.url.endsWith(delivery.MEDIA_BINDING_WITNESS_KEY);
            if(isWitness && fault==='wrong-witness' && request.method==='GET') {
                const changed=new Response(Buffer.alloc(28),{status:200,headers:response.headers});Object.defineProperty(changed,'url',{value:request.url});return changed;
            }
            if(isWitness) return response;
            if(fault==='cached') response.headers.set('Cache-Control','public, max-age=60');
            if(fault==='wrong-version') response.headers.set(delivery.MEDIA_DELIVERY_VERSION_HEADER,'00000000-0000-4000-8000-000000000000');
            if(fault==='generic') response.headers.delete(delivery.MEDIA_DELIVERY_CONTRACT_HEADER);
            if(fault==='redirect') response.headers.set('Location','https://elsewhere.example');
            if(['live','nonempty','body-timeout'].includes(fault)) {
                const body=fault==='body-timeout'?new ReadableStream({pull(){return new Promise(()=>{});}}):'unexpected';
                const changed=new Response(request.method==='HEAD'?null:body,{status:fault==='live'?200:404,headers:response.headers});
                Object.defineProperty(changed,'url',{value:request.url});return changed;
            }return response;
        };
        const proof=await verifyArchivePhotoPublicAbsence(f.env,owner,f.site,f.attemptId,f.publicFetch,20);
        assert.equal(proof.ok,false,fault);assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_pipeline_host_receipts').get().n,0,fault);
    }
    f.hostFault=null;f.github.state.unavailable=true;
    assert.equal((await resumeArchivePhotoRemoval(f.options())).ok,false,'GitHub outage cannot invent manifest completion');
    assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_pipeline_host_receipts').get().n,1);
    assert.equal(f.approved.objects.size,1);f.retain();
    f.github.state.unavailable=false;assert.equal((await resumeArchivePhotoRemoval(f.options())).completed,true);
    const oldRequests=f.hostRequests.length;f.rotateEpoch();
    let rotatedAtCommit=false;
    const rotateAtCommit=async sql=>{
        if(sql.includes('INSERT INTO private_gallery_pipeline_host_receipts')) {rotatedAtCommit=true;f.rotateEpoch();}
        else f.beforeWrite=rotateAtCommit;
    };f.beforeWrite=rotateAtCommit;
    assert.equal((await resumeArchivePhotoRemoval(f.options())).ok,false,'Epoch race is rejected by the SQL receipt guard');
    assert.equal(rotatedAtCommit,true);assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_pipeline_host_receipts').get().n,1);
    assert.equal((await resumeArchivePhotoRemoval(f.options())).completed,true);assert.ok(f.hostRequests.length>oldRequests,'Epoch rotation requires fresh host proof');
    assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_pipeline_host_receipts').get().n,2);f.db.close();
}

// Consent deletion has irreversible priority and no completed receipt until
// linked public host/review/manifest removal is proved. No old attestation reused.
{
    const f=await fixture();assert.equal((await runArchivePhotoReview(f.options())).ok,true);
    const deletion=await deletePrivateArchiveOriginal(f.env,owner,f.site,f.assetId,'consent-withdrawal');
    assert.equal(deletion.ok,false);assert.equal(f.original.objects.has(f.originalKey),false);
    assert.equal(f.db.prepare('SELECT count(*) n FROM private_archive_deletion_receipts').get().n,0);
    assert.equal((await resumeArchivePhotoRemoval(f.options())).completed,true);
    assert.equal((await deletePrivateArchiveOriginal(f.env,owner,f.site,f.assetId,'consent-withdrawal')).ok,true);
    await f.preference(person(2),'hidden');await f.preference(person(2),'allowed');assert.equal((await f.fresh()).ok,false);
    assert.equal((await runArchivePhotoReview(f.options())).ok,false);f.db.close();
}

// Race hooks must complete the actual competing write, not throw malformed
// fixture errors that masquerade as a safety rejection.
for(const point of ['source-get','output-insert','provider-create','approved-complete','review-return']) {
    const f=await fixture();let raced=false;
    const hide=async ()=>{if(!raced){raced=true;await f.preference(person(2),'hidden');}};
    if(point==='source-get') f.original.hook=async op=>{if(op==='get') await hide();};
    if(point==='output-insert') f.beforeWrite=async (sql)=>{if(sql.includes('INSERT INTO private_gallery_pipeline_outputs')) await hide();
        else f.beforeWrite=async next=>{if(next.includes('INSERT INTO private_gallery_pipeline_outputs')) await hide();};};
    if(point==='provider-create') f.staging.hook=async op=>{if(op==='create') await hide();};
    if(point==='approved-complete') f.approved.hook=async op=>{if(op==='complete') await hide();};
    if(point==='review-return') f.github.state.hook=async (path,method)=>{if(path==='/pulls' && method==='POST') await hide();};
    const result=await runArchivePhotoReview(f.options());assert.equal(raced,true,point);assert.equal(result.ok,false,point);
    assert.equal(f.staging.objects.size,0,point);assert.equal(f.approved.objects.size,1,point);
    assert.equal(f.github.state.pulls.every(p=>p.state==='closed'),true,point);
    f.retain();f.db.close();
}

// Completion/cleanup reply loss preserves the winning registration and bytes.
{
    const f=await fixture();let lost=false;
    f.approved.hook=async op=>{if(op==='complete'&&!lost){lost=true;throw new Error('Synthetic lost complete response');}};
    assert.equal((await runArchivePhotoReview(f.options())).ok,true);assert.equal(lost,true);
    await f.preference(person(2),'hidden');let failedDelete=false;
    f.approved.hook=async op=>{if(op==='delete'&&!failedDelete){failedDelete=true;throw new Error('Synthetic lost delete response');}};
    assert.equal((await resumeArchivePhotoRemoval(f.options())).ok,false);assert.equal(failedDelete,true);
    f.approved.hook=null;assert.equal((await resumeArchivePhotoRemoval(f.options())).completed,true);f.retain();f.db.close();
}

// Unknown objects and hostile R2 metadata are not guessed away. Completion
// remains pending, while exact ownership and previous receipts stay intact.
{
    const f=await fixture();assert.equal((await runArchivePhotoReview(f.options())).ok,true);
    const row=f.db.prepare("SELECT * FROM private_gallery_pipeline_outputs WHERE tier='approved' LIMIT 1").get();
    const object=f.approved.objects.get(row.object_key);object.httpMetadata.contentDisposition='attachment; filename=private-sentinel';
    await assert.rejects(readArchivePhotoCandidateItem(f.env,owner,f.site,f.attemptId,f.catalog));
    delete object.httpMetadata.contentDisposition;
    const generation=f.db.prepare('SELECT generation_id FROM private_gallery_attempts WHERE attempt_id=?').get(f.attemptId).generation_id;
    const unknown=`media/v2/${generation}/unknown`;
    f.approved.objects.set(unknown,{key:unknown,bytes:Buffer.from('foreign')});await f.preference(person(2),'hidden');
    assert.equal((await resumeArchivePhotoRemoval(f.options())).ok,false);assert.equal(f.approved.objects.has(unknown),true);
    assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_pipeline_host_receipts').get().n,0);
    f.retain();f.db.close();
}

// Uncertain review receipt is recovered READ-ONLY, never by creating a PR after
// closure. The transport outage cannot stop independent public byte cleanup.
{
    const f=await fixture();let failedAfterOpen=false;
    f.github.state.hook=async path=>{
        if(path.startsWith('/compare/') && f.github.state.pulls.length>0 && !failedAfterOpen) {
            failedAfterOpen=true;f.github.state.unavailable=true;throw new Error('Synthetic lost post-create read');
        }
    };
    assert.equal((await runArchivePhotoReview(f.options())).ok,false);assert.equal(failedAfterOpen,true);
    assert.equal(f.approved.objects.size,1);assert.equal(f.github.state.pulls.length,1);
    f.github.state.hook=null;f.github.state.unavailable=false;
    const priorPosts=f.github.state.requests.filter(r=>r.method==='POST').length;
    assert.equal((await resumeArchivePhotoRemoval(f.options())).completed,true);
    assert.equal(f.github.state.requests.filter(r=>r.method==='POST').length,priorPosts,'Closed attempt recovery cannot create another review');
    assert.equal(f.github.state.pulls[0].state,'closed');f.retain();f.db.close();
}

for(const path of ['gallery-admin/src/private-gallery-photo-lifecycle.js','scripts/gallery-media/private-photo-lifecycle.mjs',
    'gallery-admin/migrations/0023_private_gallery_photo_lifecycle.sql']) assert.equal(isPublishedPath(path),false);
const router=await readFile(new URL('../gallery-admin/src/admin-worker.js',import.meta.url),'utf8');
assert.doesNotMatch(router,/private-gallery-photo-lifecycle|private-photo-lifecycle|private-gallery-attempt-service/,
    'No internal lifecycle route activated');
// Actual local R2 provider behaviour, not just the deterministic fault model.
const {Miniflare,convertV4MiniflareOptions}=createRequire(require.resolve('wrangler/package.json'))('miniflare');
const runtime=new Miniflare(convertV4MiniflareOptions({cf:false,workers:[{name:'archive-lifecycle-fixture',modules:true,
    script:"export default {fetch(){return new Response('synthetic-local-only')}}",compatibilityDate:'2026-08-25',
    r2Buckets:['PRIVATE_ORIGINALS','PRIVATE_DERIVATIVE_STAGING','APPROVED_MEDIA']}]}));
try {
    const f=await fixture('family',[person(1),person(2)],{
        original:await runtime.getR2Bucket('PRIVATE_ORIGINALS'),staging:await runtime.getR2Bucket('PRIVATE_DERIVATIVE_STAGING'),
        approved:await runtime.getR2Bucket('APPROVED_MEDIA')});
    const result=await runArchivePhotoReview(f.options());assert.equal(result.ok,true,JSON.stringify(result));
    await f.preference(person(2),'hidden');
    // The actual workerd proxy uses the production five-second deadline, not
    // the deliberately tiny deterministic body-timeout fault seam above.
    const removal=await resumeArchivePhotoRemoval({...f.options(),timeoutMilliseconds:5000});
    assert.equal(removal.completed,true,JSON.stringify(removal));
    assert.deepEqual(Buffer.from(await (await f.original.get(f.originalKey)).arrayBuffer()),photo);
    assert.equal((await f.original.head(f.originalKey)).version,f.originalRow.provider_version);
    assert.equal((await f.approved.list()).objects.length,1);assert.equal((await f.staging.list()).objects.length,0);
    f.db.close();
} finally {await runtime.dispose();}
console.log('Archive photo processing/review, complete-group hiding/restoration, interrupted cleanup and fixed-origin public absence passed locally.');
