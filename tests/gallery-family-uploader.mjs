import assert from 'node:assert/strict';
import {familyUploaderFixture} from './helpers/family-uploader-fixture.mjs';
import {familyPermission,familyPhotoPermission,resolveFamilyAthlete,readFamilyDrafts,createFamilyDraft,saveFamilyDraft,prepareFamilyPhoto,submitFamilyDraft,familyDraftProgress} from '../gallery-admin/src/family-uploader-service.js';
import {changePrivateGalleryVisibility,readPrivateGalleryAssetEligibility} from '../gallery-admin/src/private-gallery-visibility-service.js';
import {reservePrivateGalleryAttempt} from '../gallery-admin/src/private-gallery-attempt-service.js';
import {dispatchFamilyReview} from '../gallery-admin/src/family-review-dispatch.js';
import {privateGalleryJobFixture} from './helpers/private-gallery-job-fixture.mjs';
import {syntheticGitHub} from './helpers/private-gallery-lifecycle-fixtures.mjs';
import {runProtectedArchiveJob} from '../scripts/gallery-media/protected-archive-job.mjs';
import {readGalleryReviewMain} from '../scripts/gallery-media/github-review-client.mjs';
import {deletePrivateArchiveOriginal} from '../gallery-admin/src/private-archive-service.js';
import {inspectPrivateArchivePurge,purgePrivateArchiveMetadata} from '../gallery-admin/src/private-gallery-retention-service.js';
import {queuePrivateArchiveJob,claimArchiveJob} from '../gallery-admin/src/private-gallery-job-service.js';
import {readFile} from 'node:fs/promises';
import {archiveServiceFixture} from './helpers/private-gallery-service-fixture.mjs';
import {storePrivateArchiveOriginal} from '../gallery-admin/src/private-archive-service.js';
const count=(f,table)=>f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
const outsider={type:'browser',subject:'synthetic-other-owner'};
let checks=0;

{
    const f=await archiveServiceFixture('family',{migrationThrough:31});try{
        const old=f.db.prepare('SELECT * FROM private_gallery_attempts').get(),intake=f.db.prepare('SELECT * FROM private_archive_intakes').get();
        f.db.exec(await readFile(new URL('../gallery-admin/migrations/0032_family_uploader.sql',import.meta.url),'utf8'));
        const after=f.db.prepare('SELECT * FROM private_gallery_attempts').get(),afterIntake=f.db.prepare('SELECT * FROM private_archive_intakes').get();
        const {standing_permission_version:attemptPermission,...attemptFields}=after,{standing_permission_version:intakePermission,...intakeFields}=afterIntake;
        assert.deepEqual(attemptFields,{...old});assert.deepEqual(intakeFields,{...intake});assert.equal(attemptPermission,null);assert.equal(intakePermission,null);
        assert.equal(count(f,'family_gallery_permissions'),0);assert.equal(count(f,'family_gallery_photo_permissions'),0);
        assert.equal(count(f,'private_gallery_current_attempt_permissions'),1,'Migration does not invent or revoke an old attestation');checks+=7;
    }finally{f.db.close();}
}
{
    const f=await familyUploaderFixture({count:1});try{
        const updated=await saveFamilyDraft(f.env,f.owner,f.site,f.draft.id,{expectedVersion:1,idempotencyKey:crypto.randomUUID(),
            photos:[{...f.photos[0],containsMinors:true}]},f.catalog);assert.equal(updated.ok,true);
        await assert.rejects(prepareFamilyPhoto(f.env,f.owner,f.site,f.draft.id,{photoId:f.photos[0].photoId,permissionVersion:1},f.catalog));
        assert.equal(count(f,'private_gallery_assets'),1,'No source reservation without the declared guardian permission');
        assert.equal((await familyPermission(f.env,f.owner,f.site,{expectedVersion:1,idempotencyKey:crypto.randomUUID(),active:true,guardians:true})).ok,true);
        const prepared=await prepareFamilyPhoto(f.env,f.owner,f.site,f.draft.id,{photoId:f.photos[0].photoId,permissionVersion:2},f.catalog);assert.equal(prepared.ok,true);
        const assetId=prepared.draft.photos[0].assetId;
        assert.equal(f.db.prepare('SELECT standing_permission_version FROM private_archive_intakes WHERE asset_id=?').get(assetId).standing_permission_version,2);
        assert.equal((await familyPermission(f.env,f.owner,f.site,{expectedVersion:2,idempotencyKey:crypto.randomUUID(),active:false,guardians:false})).ok,true);
        const before=f.original.calls.length;
        assert.equal((await storePrivateArchiveOriginal(f.env,f.owner,f.site,assetId,new Blob([f.bytes[0]]).stream())).ok,false);
        assert.equal(f.original.calls.length,before,'Revocation before upload fails before storage I/O');checks+=9;
    }finally{f.db.close();}
}

{
    const f=await familyUploaderFixture();try{
        assert.equal((await familyPermission(f.env,outsider,'family')).version,0);
        assert.equal((await familyPermission(f.env,f.owner,'everyone',f.permissionInput)).status,403);
        assert.deepEqual(await familyPermission(f.env,f.owner,'family',f.permissionInput),f.permission);
        assert.equal((await familyPermission(f.env,f.owner,'family',{...f.permissionInput,guardians:true})).ok,false);
        assert.equal(count(f,'family_gallery_permissions'),1);checks+=5;
        const select={athleteId:'fixture-new',idempotencyKey:crypto.randomUUID(),permissionVersion:1};
        const person=await resolveFamilyAthlete(f.env,f.owner,f.site,select,f.catalog);assert.equal(person.ok,true,JSON.stringify(person));
        assert.equal(person.preference,'allowed');assert.deepEqual(await resolveFamilyAthlete(f.env,f.owner,f.site,select,f.catalog),person);
        assert.equal(count(f,'private_gallery_people'),3);
        assert.equal((await changePrivateGalleryVisibility(f.env,f.owner,f.site,person.personId,{expectedVersion:2,idempotencyKey:crypto.randomUUID(),preference:'hidden'})).ok,true);
        assert.equal((await resolveFamilyAthlete(f.env,f.owner,f.site,select,f.catalog)).preference,'hidden');checks+=6;
        assert.equal((await readFamilyDrafts(f.env,outsider,'family')).drafts.length,0);
        await assert.rejects(readFamilyDrafts(f.env,outsider,'family',f.draft.id));
        assert.equal((await saveFamilyDraft(f.env,f.owner,f.site,f.draft.id,f.saveInput,f.catalog)).ok,true);
        assert.equal((await saveFamilyDraft(f.env,f.owner,f.site,f.draft.id,{...f.saveInput,idempotencyKey:crypto.randomUUID()},f.catalog)).ok,false);
        const more={expectedVersion:1,idempotencyKey:crypto.randomUUID(),photos:f.photos};
        assert.equal((await saveFamilyDraft(f.env,f.owner,f.site,f.draft.id,more,f.catalog)).ok,true);
        assert.equal((await saveFamilyDraft(f.env,f.owner,f.site,f.draft.id,f.saveInput,f.catalog)).ok,false,'Old receipt cannot claim to save over a newer edit');checks+=6;
        const duplicates={expectedVersion:2,idempotencyKey:crypto.randomUUID(),photos:[f.photos[0],{...f.photos[0],photoId:crypto.randomUUID()}]};
        assert.equal((await saveFamilyDraft(f.env,f.owner,f.site,f.draft.id,duplicates,f.catalog)).code,'family-duplicate-photo');
        const previous=f.env.DB.batch;f.env.DB.batch=async items=>{await previous(items);throw new Error('Synthetic lost save reply');};
        const lost={expectedVersion:2,idempotencyKey:crypto.randomUUID(),photos:f.photos};
        assert.equal((await saveFamilyDraft(f.env,f.owner,f.site,f.draft.id,lost,f.catalog)).ok,true);
        f.env.DB.batch=previous;assert.equal((await readFamilyDrafts(f.env,f.owner,f.site,f.draft.id)).draft.version,3);checks+=3;
    }finally{f.db.close();}
}
{
    const f=await familyUploaderFixture({ready:true});try{
        const photos=(await readFamilyDrafts(f.env,f.owner,f.site,f.draft.id)).draft.photos;
        assert.equal(new Set(photos.map(p=>p.assetId)).size,3,'Same tags, event and JPEG format still mean three different originals');
        assert.equal(photos.every(p=>p.retained&&p.framingVersion===1),true);
        assert.equal((await f.prepare(0)).assetId,photos[0].assetId);
        const changed={expectedVersion:1,idempotencyKey:crypto.randomUUID(),photos:f.photos.map((p,i)=>i? p:{...p,personIds:f.ids})};
        assert.equal((await saveFamilyDraft(f.env,f.owner,f.site,f.draft.id,changed,f.catalog)).ok,false);checks+=4;
        const writes=f.original.calls.length;f.env.FAMILY_REVIEW_DISPATCH_TOKEN='synthetic-not-a-real-secret';let calls=0;
        const deps={dispatchFetch:async request=>{calls++;assert.equal(request.url,'https://api.github.com/repos/johnkevan88888/family-running/actions/workflows/gallery-archive-job.yml/dispatches');
            const body=await request.json();assert.equal(body.ref,'main');assert.deepEqual(Object.keys(body.inputs),['job_id']);return new Response(null,{status:204});}};
        const queued=await f.submit(deps);assert.equal(queued.ok,true,JSON.stringify(queued));
        assert.equal((await f.submit(deps)).draft.jobId,f.jobId);assert.equal(calls,1);assert.equal(f.original.calls.length,writes);
        assert.equal(count(f,'private_gallery_batch_jobs'),1);assert.equal(count(f,'private_gallery_attempts'),3);
        assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_attempts WHERE standing_permission_version=1 AND framing_version=1').get().n,3);
        assert.equal((await familyDraftProgress(f.env,f.owner,f.site,f.draft.id)).dispatchState,'acknowledged');checks+=8;
        const attempts=f.db.prepare('SELECT attempt_id FROM private_gallery_attempts').all();
        assert.equal(count(f,'private_gallery_current_attempt_permissions'),3);
        const hide={assetId:photos[0].assetId,expectedVersion:0,idempotencyKey:crypto.randomUUID(),preference:'hidden'};
        assert.equal((await familyPhotoPermission(f.env,f.owner,f.site,hide)).ok,true);
        assert.equal((await familyPhotoPermission(f.env,outsider,f.site,hide)).ok,false);
        assert.equal(count(f,'private_gallery_current_attempt_permissions'),2);
        assert.equal(count(f,'private_gallery_pipeline_closures'),1,'Photo withdrawal closes its generation only');
        const eligible=await readPrivateGalleryAssetEligibility(f.env,f.owner,f.site,photos[0].assetId,f.catalog);
        assert.equal((await reservePrivateGalleryAttempt(f.env,f.owner,f.site,photos[0].assetId,{...f.consent,
            idempotencyKey:crypto.randomUUID(),eligibilityRevision:eligible.revision,framingVersion:1,standingPermissionVersion:1},f.catalog)).ok,false,
            'A photo exception also blocks the existing advanced fresh-attempt route at the SQL boundary');
        assert.equal((await familyPhotoPermission(f.env,f.owner,f.site,{...hide,expectedVersion:1,idempotencyKey:crypto.randomUUID(),preference:'allowed'})).ok,true);
        assert.equal(count(f,'private_gallery_pipeline_closures'),1,'Allowing future reviews never reopens a retired generation');checks+=7;
        assert.equal((await familyPermission(f.env,f.owner,f.site,{expectedVersion:1,idempotencyKey:crypto.randomUUID(),active:false,guardians:false})).ok,true);
        assert.equal(count(f,'private_gallery_current_attempt_permissions'),0);
        assert.equal(count(f,'private_archive_original_receipts'),4,'Withdrawal does not purge originals');checks+=3;
        assert.ok(attempts.length);assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
    }finally{f.db.close();}
}
{
    const f=await familyUploaderFixture({ready:true,count:1});try{
        const real=f.env.DB.prepare;let failed=false;
        f.env.DB.prepare=function(sql){const stmt=real(sql),run=stmt.run;
            if(sql.includes('INSERT INTO private_gallery_attempts'))stmt.run=async()=>{const r=await run();if(!failed){failed=true;throw new Error('Lost attempt reply');}return r;};return stmt;};
        assert.equal((await f.submit()).ok,true);assert.equal(count(f,'private_gallery_attempts'),1);
        f.env.DB.prepare=real;f.env.FAMILY_REVIEW_DISPATCH_TOKEN='synthetic';let calls=0;
        const deps={dispatchFetch:async()=>{calls++;throw new Error('Uncertain dispatch');}};
        assert.equal((await dispatchFamilyReview(f.env,f.jobId,deps)).state,'unknown');
        assert.equal((await dispatchFamilyReview(f.env,f.jobId,deps)).state,'unknown');assert.equal(calls,1);checks+=5;
    }finally{f.db.close();}
}
// Whole real local processing/review chain: only injected in-memory storage,
// synthetic images and a fake GitHub transport. No network or real media.
{
    const f=await familyUploaderFixture({submitted:true,count:1});try{
        f.env.FAMILY_REVIEW_DISPATCH_TOKEN='synthetic';let calls=0;
        const stalled={dispatchFetch:async()=>{calls++;return new Response(new ReadableStream({cancel(){return new Promise(()=>{});}}),{status:500});}};
        const started=Date.now();assert.equal((await dispatchFamilyReview(f.env,f.jobId,stalled)).state,'unknown');
        assert.ok(Date.now()-started<6500,'Even stalled error-body cancellation has a five-second total deadline');
        assert.equal((await dispatchFamilyReview(f.env,f.jobId,stalled)).state,'unknown');assert.equal(calls,1);checks+=4;
    }finally{f.db.close();}
}
{
    const f=await familyUploaderFixture({submitted:true,count:1});try{
        await claimArchiveJob(f.env,f.jobId,'https://github.com/johnkevan88888/family-running/actions/runs/650','promotion');
        f.env.FAMILY_REVIEW_DISPATCH_TOKEN='synthetic';
        assert.equal((await dispatchFamilyReview(f.env,f.jobId,{dispatchFetch:()=>assert.fail('Existing run must not be dispatched again')})).state,'already-started');checks++;
    }finally{f.db.close();}
}
{
    const f=await familyUploaderFixture({submitted:true,saveFirst:true});try{
        f.attemptId=f.db.prepare('SELECT attempt_id FROM private_gallery_attempts LIMIT 1').get().attempt_id;
        const c=await privateGalleryJobFixture(f),github=syntheticGitHub(),runReference='https://github.com/johnkevan88888/family-running/actions/runs/654';
        const execute=phase=>runProtectedArchiveJob({jobId:f.jobId,runReference,phase,...c,jobs:c.jobs[phase==='verify'?'finalizer':'promotion'],github});
        const result=await execute('review');
        assert.equal(result.state,'unmerged-review',JSON.stringify(result));assert.equal(github.state.pulls.length,1);
        assert.equal(github.state.pulls[0].state,'open');assert.equal(github.state.manifests.family.items.length,0);
        const intent=f.db.prepare('SELECT candidate_json FROM private_gallery_batch_intents').get();
        const manifest=JSON.parse(JSON.parse(intent.candidate_json).manifestText);assert.equal(manifest.items.length,3);
        assert.equal(manifest.items.every(item=>item.podiumFraming['fixture-public'].zoom===2),true);
        assert.equal(intent.candidate_json.includes('synthetic-private-camera'),false);checks+=7;
        // The following removal/purge is an entirely in-memory regression,
        // never authority to perform a live purge or touch a real photo.
        const members=(await readFamilyDrafts(f.env,f.owner,f.site,f.draft.id)).draft.photos;
        assert.equal((await familyPhotoPermission(f.env,f.owner,f.site,{assetId:members[0].assetId,expectedVersion:0,
            idempotencyKey:crypto.randomUUID(),preference:'hidden'})).ok,true);
        await execute('reconcile');assert.equal((await execute('verify')).state,'host-ready');
        assert.equal((await execute('reconcile')).state,'removed');
        assert.ok(f.hostRequests.length>0,'Storage deletion alone never establishes host absence');checks+=4;
        const main=await readGalleryReviewMain({token:github.token,fetchImpl:github.fetchImpl}),confirmations=[];
        const narrow={DB:f.env.DB,APPROVED_MEDIA_ORIGIN:f.env.APPROVED_MEDIA_ORIGIN,EXPECTED_MEDIA_VERSION:f.env.EXPECTED_MEDIA_VERSION};
        for(const member of members)assert.equal((await deletePrivateArchiveOriginal(f.env,f.owner,f.site,member.assetId,'owner-delete')).ok,true);
        for(const member of members){
            const proof=await inspectPrivateArchivePurge(narrow,f.owner,f.site,member.assetId,main);assert.equal(proof.ok,true,JSON.stringify(proof));
            const input={action:'purge',idempotencyKey:crypto.randomUUID(),purgeKey:crypto.randomUUID(),expectedProofHash:proof.proofHash};
            const queued=await queuePrivateArchiveJob(f.env,f.owner,f.site,member.assetId,input);assert.equal(queued.ok,true);
            confirmations.push({jobId:queued.job.jobId,input:{purgeKey:input.purgeKey,expectedProofHash:proof.proofHash,main}});
        }
        await claimArchiveJob(f.env,confirmations[0].jobId,'https://github.com/johnkevan88888/family-running/actions/runs/655','finalizer');
        let sqlError;narrow.DB={prepare(sql){const stmt=f.env.DB.prepare(sql),run=stmt.run;stmt.run=async()=>{
            try{return await run.call(stmt);}catch(error){sqlError=error.message;throw error;}};return stmt;}};
        const purged=await purgePrivateArchiveMetadata(narrow,f.owner,f.site,members[0].assetId,confirmations[0].input);
        assert.equal(purged.ok,true,JSON.stringify({purged,sqlError}));
        assert.equal(count(f,'family_gallery_draft_photos'),0,'New draft metadata participates in coordinated purge');
        assert.equal(count(f,'family_gallery_saved_files'),0,'Save-first file evidence retires with the same coordinated purge');
        assert.equal(count(f,'family_gallery_photo_permissions'),0,'Photo-linked exception metadata is retired too');
        assert.equal(count(f,'family_gallery_permissions'),1,'Independent owner policy remains');
        assert.equal((await readFamilyDrafts(f.env,f.owner,f.site,f.draft.id)).draft.jobId,null);
        assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);checks+=6;
    }finally{f.db.close();}
}
console.log(`PASS ${checks} Family uploader checks: standing permission, direct athlete IDs, saved independent photos, versioned retries, opt-outs, one combined synthetic review; no live operations.`);
