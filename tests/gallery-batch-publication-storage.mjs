import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {reviewedBatchFixture,syntheticBatchMergedEvidence} from './helpers/gallery-batch-publication-fixture.mjs';
import {archiveServiceFixture} from './helpers/private-gallery-service-fixture.mjs';
import {requestPrivateArchiveBatchPublication,readArchiveBatchJob,readArchiveBatchMemberOrigin,archiveBatchSummary} from '../gallery-admin/src/private-gallery-batch-service.js';
import {completeArchiveJob} from '../gallery-admin/src/private-gallery-job-service.js';
import {queuePrivateArchiveJob,claimArchiveJob} from '../gallery-admin/src/private-gallery-job-service.js';
import {changePrivateGalleryVisibility} from '../gallery-admin/src/private-gallery-visibility-service.js';
import {batchRun} from './helpers/private-gallery-batch-fixture.mjs';

let checks=0;
const count=(f,table)=>f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
const retained=f=>JSON.stringify(Object.fromEntries(['private_gallery_assets','private_gallery_attempts','private_archive_original_receipts',
    'private_gallery_asset_tags','private_gallery_attempt_framings'].map(t=>[t,f.db.prepare(`SELECT * FROM ${t}`).all()])));
for(const site of ['family','everyone']) {
    const f=await reviewedBatchFixture(site),before=retained(f),input={idempotencyKey:crypto.randomUUID()};
    try {
        const request=(body=input,identity=f.owner,area=site)=>requestPrivateArchiveBatchPublication(f.env,identity,area,f.jobId,body);
        for(const body of [null,{}, {...input,jobId:f.jobId},{...input,review:f.review.review},{idempotencyKey:'bad'}]) {
            assert.equal((await request(body)).status,422);checks++;
        }
        assert.equal((await request(input,{type:'service',subject:f.owner.subject})).status,403);checks++;
        assert.equal((await request(input,{type:'browser',subject:'different-owner'})).ok,false);checks++;
        assert.equal((await request(input,f.owner,site==='family'?'everyone':'family')).ok,false);checks++;
        await assert.rejects(f.batchOperation('batch-publication-check'));checks++;
        const approved=await request();assert.equal(approved.ok,true,JSON.stringify(approved));assert.equal(approved.job.publicationRequested,true);checks++;
        assert.equal((await request()).ok,true);assert.equal((await request({idempotencyKey:crypto.randomUUID()})).ok,false);checks++;
        assert.equal((await f.batchOperation('batch-publication-check')).claimHeld,true);checks++;
        assert.equal(count(f,'private_gallery_active_job'),1);checks++;
        const evidence=syntheticBatchMergedEvidence(f.review.review);
        for(const changed of [{...evidence,itemIds:[...evidence.itemIds].reverse()},{...evidence,headSha:'f'.repeat(40)},
            {...evidence,baseSha:'f'.repeat(40)},{...evidence,mergeSha:null},{...evidence,pullRequest:{...evidence.pullRequest,number:999}},
            {...evidence,extra:true}]) {await assert.rejects(f.batchOperation('batch-publication-observe',{evidence:changed}));checks++;}
        assert.equal(count(f,'private_gallery_batch_publications'),0);checks++;
        assert.equal((await f.batchOperation('batch-publication-observe',{evidence})).state,'publication-origin-recorded');checks++;
        assert.equal((await f.batchOperation('batch-publication-observe',{evidence})).state,'publication-origin-recorded');checks++;
        assert.equal(count(f,'private_gallery_batch_member_origins'),2);assert.equal(count(f,'private_gallery_pipeline_reviews'),0);checks++;
        for(const [index,member] of f.members.entries()) {
            const origin=await readArchiveBatchMemberOrigin(f.env,member.attemptId);
            assert.equal(origin.jobId,f.jobId);assert.equal(origin.itemId,evidence.itemIds[index]);assert.deepEqual(origin.evidence,evidence);
            assert.equal(origin.item.id,origin.itemId);checks++;
        }
        const result={ok:true,state:'publication-observed',evidence,publicationEnabled:false};
        const completed=await completeArchiveJob(f.env,f.jobId,batchRun,result);
        assert.equal(completed.state,'publication-observed');assert.equal(count(f,'private_gallery_active_job'),0);checks++;
        assert.equal((await completeArchiveJob(f.env,f.jobId,batchRun,result)).state,'publication-observed');checks++;
        await assert.rejects(completeArchiveJob(f.env,f.jobId,batchRun,{...result,evidence:{...evidence,mergeSha:'e'.repeat(40)}}));checks++;
        assert.equal((await archiveBatchSummary(f.env,await readArchiveBatchJob(f.env,f.jobId))).state,'publication-observed');checks++;
        assert.equal(retained(f),before,'Publication bridge never rewrites original/tag/framing/consent snapshots');checks++;
        // Completion-first wins against stale old-run service cancellation.
        // An unrelated asset's removal claim is not authority for this member.
        for(const reason of ['cancelled','failed']) {
            assert.throws(()=>f.db.prepare('INSERT INTO private_gallery_pipeline_closures(attempt_id,reason) VALUES(?,?)').run(f.attemptId,reason),/exact removal job/);checks++;
        }
        f.db.exec('SAVEPOINT unrelated_removal');
        const other=f.members[1],otherJob=await queuePrivateArchiveJob(f.env,f.owner,site,other.assetId,{action:'removal',idempotencyKey:crypto.randomUUID()});
        assert.equal(otherJob.ok,true);await claimArchiveJob(f.env,otherJob.job.jobId,batchRun+'3','promotion');
        assert.throws(()=>f.db.prepare("INSERT INTO private_gallery_pipeline_closures(attempt_id,reason) VALUES(?,'cancelled')").run(f.attemptId),/exact removal job/);checks++;
        f.db.exec('ROLLBACK TO unrelated_removal; RELEASE unrelated_removal');
        f.db.exec('SAVEPOINT exact_removal');
        const ownJob=await queuePrivateArchiveJob(f.env,f.owner,site,f.assetId,{action:'removal',idempotencyKey:crypto.randomUUID()});
        assert.equal(ownJob.ok,true);await claimArchiveJob(f.env,ownJob.job.jobId,batchRun+'4','promotion');
        f.db.prepare("INSERT INTO private_gallery_pipeline_closures(attempt_id,reason) VALUES(?,'cancelled')").run(f.attemptId);checks++;
        f.db.exec('ROLLBACK TO exact_removal; RELEASE exact_removal');
        // Every automatic privacy closure remains immediate and independent
        // of a service/job grant; a stale workflow can never block withdrawal.
        for(const reason of ['visibility','tags','archive-deletion','roster','exclusion']) {
            f.db.exec('SAVEPOINT immediate_privacy');
            f.db.prepare('INSERT INTO private_gallery_pipeline_closures(attempt_id,reason) VALUES(?,?)').run(f.attemptId,reason);checks++;
            f.db.exec('ROLLBACK TO immediate_privacy; RELEASE immediate_privacy');
        }
        assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);checks++;
    } finally {f.db.close();}
    // A revocation racing the owner's merge must retain positive history for
    // removal, while both actual promotion checks and SQL completion fail shut.
    const changed=await reviewedBatchFixture(site);
    try {
        assert.equal((await requestPrivateArchiveBatchPublication(changed.env,changed.owner,site,changed.jobId,{idempotencyKey:crypto.randomUUID()})).ok,true);
        assert.equal((await changePrivateGalleryVisibility(changed.env,changed.owner,site,changed.ids[0],
            {expectedVersion:2,idempotencyKey:crypto.randomUUID(),preference:'hidden'})).ok,true);
        const evidence=syntheticBatchMergedEvidence(changed.review.review);
        assert.equal((await changed.batchOperation('batch-publication-observe',{evidence})).state,'publication-origin-recorded');checks++;
        await assert.rejects(changed.batchOperation('batch-publication-check'));checks++;
        await assert.rejects(completeArchiveJob(changed.env,changed.jobId,batchRun,{ok:true,state:'publication-observed',evidence,publicationEnabled:false}));checks++;
        assert.equal(count(changed,'private_gallery_active_job'),1);assert.equal(count(changed,'private_gallery_batch_member_origins'),2);checks++;
        for(const table of ['publication_requests','publications','member_origins']) {
            assert.throws(()=>changed.db.exec(`DELETE FROM private_gallery_batch_${table}`),/retained/);checks++;
            assert.throws(()=>changed.db.exec(`UPDATE private_gallery_batch_${table} SET job_id=job_id`),/immutable/);checks++;
        }
    } finally {changed.db.close();}
}
// Forward application cannot modify existing consent/source/review evidence.
{
    const f=await archiveServiceFixture('family',{migrationThrough:30}),before=retained(f);
    f.db.exec(await readFile(new URL('../gallery-admin/migrations/0031_private_gallery_batch_publication.sql',import.meta.url),'utf8'));
    assert.equal(retained(f),before);assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);checks+=2;f.db.close();
}
console.log(`Protected batch publication storage passed ${checks} synthetic checks: separate owner grant, held claim, exact shared member origins, forward migration, late revocation and immutable history.`);
