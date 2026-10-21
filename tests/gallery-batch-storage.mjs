import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {archiveServiceFixture} from './helpers/private-gallery-service-fixture.mjs';
import {privateGalleryJobFixture} from './helpers/private-gallery-job-fixture.mjs';
import {addSyntheticBatchMember} from './helpers/gallery-batch-storage-fixture.mjs';
import {queuePrivateArchiveBatch,readPrivateArchiveBatches,readArchiveBatchJob,archiveBatchSummary} from '../gallery-admin/src/private-gallery-batch-service.js';
import {queuePrivateArchiveJob,claimArchiveJob,completeArchiveJob} from '../gallery-admin/src/private-gallery-job-service.js';
import {changePrivateGalleryVisibility} from '../gallery-admin/src/private-gallery-visibility-service.js';
import {reservePrivateGalleryAttempt} from '../gallery-admin/src/private-gallery-attempt-service.js';

const runReference='https://github.com/johnkevan88888/family-running/actions/runs/100';
const retained=f=>JSON.stringify(Object.fromEntries(['private_gallery_assets','private_gallery_asset_tags','private_gallery_attempts',
    'private_archive_intakes','private_archive_original_receipts','private_gallery_frame_revisions','private_gallery_attempt_frames']
    .filter(name=>f.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))
    .map(name=>[name,f.db.prepare(`SELECT * FROM ${name}`).all()])));
let checks=0;
for(const site of ['family','everyone']) {
    const f=await archiveServiceFixture(site),second=await addSyntheticBatchMember(f),c=await privateGalleryJobFixture(f);
    const body={attemptIds:[second.attemptId,f.attemptId],idempotencyKey:crypto.randomUUID()};
    const before=retained(f),calls=f.original.calls.length;
    const queue=(value=body,owner=f.owner,area=site)=>queuePrivateArchiveBatch(f.env,owner,area,value);
    for(const value of [null,{}, {...body,attemptIds:[]},{...body,attemptIds:[f.attemptId,f.attemptId]},
        {...body,attemptIds:['attempt_invalid']},{...body,attemptIds:Array.from({length:21},()=>`attempt_${crypto.randomUUID()}`)},
        {...body,idempotencyKey:'invalid'},{...body,siteMode:site},{...body,candidate:{}}]) {
        assert.equal((await queue(value)).status,422);checks++;
    }
    for(const identity of [null,{type:'service',subject:f.owner.subject}]) {assert.equal((await queue(body,identity)).status,403);checks++;}
    assert.equal((await queue(body,f.owner,site==='family'?'everyone':'family')).status,409);checks++;
    assert.equal((await queue(body,{type:'browser',subject:'synthetic-other-owner'})).status,409);checks++;
    const nonexistent={...body,attemptIds:[`attempt_${crypto.randomUUID()}`]};assert.equal((await queue(nonexistent)).status,409);checks++;
    const saved=await queue();assert.equal(saved.status,201,JSON.stringify(saved));const id=saved.job.jobId;
    assert.deepEqual(saved.job.attemptIds,body.attemptIds);assert.equal(saved.job.action,'batch-review');checks++;
    const replay=await queue();assert.equal(replay.status,200);assert.equal(replay.job.jobId,id);checks++;
    assert.equal((await queue({...body,attemptIds:[...body.attemptIds].reverse()})).status,409);checks++;
    assert.equal((await queue({...body,idempotencyKey:crypto.randomUUID()})).status,409,'A consent attempt belongs to one immutable batch');checks++;
    const list=await readPrivateArchiveBatches(f.env,f.owner,site);assert.equal(list.batches.length,1);assert.deepEqual(list.batches[0].attemptIds,body.attemptIds);checks++;
    assert.deepEqual((await readPrivateArchiveBatches(f.env,{type:'browser',subject:'synthetic-other-owner'},site)).batches,[]);checks++;
    const row=await readArchiveBatchJob(f.env,id);const snapshot=await archiveBatchSummary(f.env,row);
    assert.deepEqual(snapshot.attempts,body.attemptIds);assert.deepEqual(snapshot.members,[{attemptId:second.attemptId,assetId:second.assetId,closed:false},{attemptId:f.attemptId,assetId:f.assetId,closed:false}]);checks++;
    for(const action of ['review','publication']) {assert.equal((await queuePrivateArchiveJob(f.env,f.owner,site,f.assetId,
        {action,attemptId:f.attemptId,idempotencyKey:crypto.randomUUID()})).ok,false);checks++;}
    assert.throws(()=>f.db.prepare('INSERT INTO private_gallery_pipeline_review_intents(attempt_id,base_sha,candidate_json) VALUES(?,?,?)')
        .run(f.attemptId,'a'.repeat(40),'{}'),/Exact batch owns/);checks++;
    assert.equal((await c.jobs.finalizer(id,'claim',{runReference})).ok,false);checks++;
    assert.equal((await c.jobs.promotion(id,'claim',{runReference})).ok,true);checks++;
    assert.equal((await c.jobs.promotion(id,'claim',{runReference})).ok,true,'Same Actions run replays its immutable claim');checks++;
    assert.equal((await c.jobs.promotion(id,'claim',{runReference:runReference+'1'})).ok,false);checks++;
    const running=await c.jobs.promotion(id,'read',{runReference});assert.deepEqual(running.value.job.attempts,body.attemptIds);assert.equal(running.value.job.state,'running');checks++;
    assert.equal((await c.jobs.finalizer(id,'read',{runReference})).ok,true);checks++;
    assert.equal((await c.jobs.finalizer(id,'read',{runReference:runReference+'1'})).ok,false);checks++;
    assert.throws(()=>c.jobs.finalizer(id,'batch-reserve',{runReference,main:{}}));checks++;
    for(const invalid of [{runReference},{runReference,main:{},items:[]},{runReference,main:{baseSha:'a'.repeat(40),manifestsBySite:{family:{schemaVersion:'1.0',items:[]},everyone:{schemaVersion:'1.0',items:[]}}}}]) {
        assert.equal((await c.jobs.promotion(id,'batch-reserve',invalid)).ok,false,'No review before each pair is independently verified');checks++;
    }
    for(const operation of ['batch-write','batch-open','batch-terminal']) {
        assert.equal((await c.jobs.promotion(id,operation,{runReference,...(operation==='batch-open'?{review:{}}:operation==='batch-terminal'?{evidence:{}}:{})})).ok,false);checks++;
    }
    const unrelated=await addSyntheticBatchMember(f,{color:'#aa3355'});
    const ordinary=await queuePrivateArchiveJob(f.env,f.owner,site,unrelated.assetId,{action:'review',attemptId:unrelated.attemptId,idempotencyKey:crypto.randomUUID()});assert.equal(ordinary.ok,true);
    assert.equal((await queue({attemptIds:[unrelated.attemptId],idempotencyKey:crypto.randomUUID()})).ok,false,'A queued single-photo job cannot be repointed into a batch');checks++;
    await assert.rejects(claimArchiveJob(f.env,ordinary.job.jobId,runReference,'promotion'));checks++;
    for(const value of [{ok:true,state:'unmerged-review',publicationEnabled:false},{ok:true,state:'publication-observed',publicationEnabled:false},
        {ok:true,state:'removed',mainSha:'a'.repeat(40),publicationEnabled:false}]) {
        await assert.rejects(completeArchiveJob(f.env,id,runReference,value));checks++;
    }
    const after=retained(f);assert.notEqual(after,before,'Only unrelated fixture intake/consent was added');
    for(const table of ['jobs','claims','intents','write_admissions','reviews','terminals','completions']) {
        const update=f.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(`private_gallery_batch_${table}_no_update`);
        assert.match(update.sql,/RAISE\(ABORT,'Batch evidence immutable'\)/);checks++;
        // Empty evidence tables have no rows; do not pretend their DELETE
        // guards executed. Check the actual trigger definition instead.
        const trigger=f.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(`private_gallery_batch_${table}_no_delete`);
        assert.match(trigger.sql,/RAISE\(ABORT,'Batch evidence retained'\)/);checks++;
    }
    assert.throws(()=>f.db.exec('DELETE FROM private_gallery_batch_jobs'),/retained/);checks++;
    assert.throws(()=>f.db.exec('DELETE FROM private_gallery_batch_claims'),/retained/);checks++;
    assert.throws(()=>f.db.exec('UPDATE private_gallery_batch_jobs SET job_id=job_id'),/immutable/);checks++;
    assert.throws(()=>f.db.exec('UPDATE private_gallery_batch_claims SET job_id=job_id'),/immutable/);checks++;
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);checks++;
    assert.equal(f.original.calls.length,calls+f.original.calls.filter(call=>call[1]?.includes(unrelated.assetId)).length,
        'Batch queue/claim/status do not read or alter media');checks++;
    assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_active_job').get().n,1);checks++;
    f.db.close();
}
// Mixed owner/area, repeated asset with distinct consents, and SQL statement
// preparation must all fail closed independently of the owner form.
{
    const f=await archiveServiceFixture('family');
    const otherArea=await addSyntheticBatchMember(f,{site:'everyone'}),otherOwner=await addSyntheticBatchMember(f,{owner:{type:'browser',subject:'synthetic-second-owner'}});
    for(const other of [otherArea,otherOwner]) {
        assert.equal((await queuePrivateArchiveBatch(f.env,f.owner,f.site,{attemptIds:[f.attemptId,other.attemptId],idempotencyKey:crypto.randomUUID()})).ok,false);checks++;
    }
    const repeated=await reservePrivateGalleryAttempt(f.env,f.owner,f.site,f.assetId,{...f.consent,idempotencyKey:crypto.randomUUID()},f.catalog);
    assert.equal(repeated.ok,true,JSON.stringify(repeated));
    assert.equal((await queuePrivateArchiveBatch(f.env,f.owner,f.site,{attemptIds:[f.attemptId,repeated.attemptId],idempotencyKey:crypto.randomUUID()})).ok,false);checks++;
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);checks++;
    f.db.close();
}
// Enforce current eligibility inside the INSERT, not only during browser/UI
// reads. Revoking one member between request validation and SQL must win.
{
    const f=await archiveServiceFixture('family'),second=await addSyntheticBatchMember(f),base=f.env.DB;
    let intercepted=false;
    f.env.DB={prepare(sql){const statement=base.prepare(sql),run=statement.run;
        statement.run=async()=>{if(sql.startsWith('INSERT INTO private_gallery_batch_jobs')&&!intercepted){intercepted=true;
            await changePrivateGalleryVisibility({...f.env,DB:base},f.owner,f.site,f.ids[0],{expectedVersion:2,idempotencyKey:crypto.randomUUID(),preference:'hidden'});}
            return run.call(statement);};return statement;}};
    assert.equal((await queuePrivateArchiveBatch(f.env,f.owner,f.site,{attemptIds:[f.attemptId,second.attemptId],idempotencyKey:crypto.randomUUID()})).ok,false);checks++;
    assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_batch_jobs').get().n,0);checks++;
    f.db.close();
}
// Migration is strictly forward/additive for existing consent and review data.
{
    const f=await archiveServiceFixture('family',{migrationThrough:29}),before=retained(f);
    f.db.exec(await readFile(new URL('../gallery-admin/migrations/0030_private_gallery_batch_reviews.sql',import.meta.url),'utf8'));
    assert.equal(retained(f),before);checks++;assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);checks++;f.db.close();
}
console.log(`Protected batch storage passed ${checks} synthetic checks: immutable ordered membership, per-photo eligibility, both-area owner isolation, additive migration, held same-run global claims and fail-closed unsupported publication/purge.`);
