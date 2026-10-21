import assert from 'node:assert/strict';
import {reviewedBatchFixture} from './helpers/gallery-batch-publication-fixture.mjs';
import {addSyntheticBatchMember} from './helpers/gallery-batch-storage-fixture.mjs';
import {readGalleryReviewMain} from '../scripts/gallery-media/github-review-client.mjs';
import {deletePrivateArchiveOriginal} from '../gallery-admin/src/private-archive-service.js';
import {inspectPrivateArchivePurge,purgePrivateArchiveMetadata} from '../gallery-admin/src/private-gallery-retention-service.js';
import {queuePrivateArchiveJob,claimArchiveJob,readRetiredArchiveJob} from '../gallery-admin/src/private-gallery-job-service.js';
import {reservePrivateGalleryAsset} from '../gallery-admin/src/private-gallery-asset-service.js';
import {readPrivateGalleryRoster} from '../gallery-admin/src/private-gallery-roster-service.js';
import {queuePrivateArchiveBatch} from '../gallery-admin/src/private-gallery-batch-service.js';
import {completeArchiveJob} from '../gallery-admin/src/private-gallery-job-service.js';
import {reservePrivateGalleryAttempt} from '../gallery-admin/src/private-gallery-attempt-service.js';
import {readPrivateGalleryAssetEligibility} from '../gallery-admin/src/private-gallery-visibility-service.js';

const count=(f,table)=>f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
const narrow=f=>({DB:f.env.DB,APPROVED_MEDIA_ORIGIN:f.env.APPROVED_MEDIA_ORIGIN,EXPECTED_MEDIA_VERSION:f.env.EXPECTED_MEDIA_VERSION});
const run='https://github.com/johnkevan88888/family-running/actions/runs/998';
const recordState=f=>JSON.stringify(Object.fromEntries(f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({name})=>[name,f.db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all()])));
async function removedFixture(site) {
    const f=await reviewedBatchFixture(site);
    await f.execute('reconcile');
    assert.equal((await f.execute('verify')).state,'host-ready');
    assert.equal((await f.execute('reconcile')).state,'removed');
    f.main=await readGalleryReviewMain({token:f.github.token,fetchImpl:f.github.fetchImpl});
    return f;
}
async function confirm(f,assetId,proofHash) {
    const input={action:'purge',idempotencyKey:crypto.randomUUID(),purgeKey:crypto.randomUUID(),expectedProofHash:proofHash};
    const queued=await queuePrivateArchiveJob(narrow(f),f.owner,f.site,assetId,input);assert.equal(queued.ok,true,JSON.stringify(queued));
    return {jobId:queued.job.jobId,input:{purgeKey:input.purgeKey,expectedProofHash:proofHash,main:f.main}};
}
async function emptyRemovedBatch(f,members,reference='https://github.com/johnkevan88888/family-running/actions/runs/997') {
    const requested=await queuePrivateArchiveBatch(f.env,f.owner,f.site,{attemptIds:members.map(m=>m.attemptId),idempotencyKey:crypto.randomUUID()});
    assert.equal(requested.ok,true,JSON.stringify(requested));const id=requested.job.jobId;
    await claimArchiveJob(f.env,id,reference,'promotion');
    for(const member of members) {
        for(const service of [f.c.processing,f.c.promotion]) for(const operation of ['close','cleanup']) assert.equal((await service(member.attemptId,operation)).ok,true);
        assert.equal((await f.c.verifier(member.attemptId,'verify')).ok,true);
        assert.equal((await f.c.promotion(member.attemptId,'manifest-absence',f.main)).ok,true);
    }
    assert.equal((await completeArchiveJob(f.env,id,reference,{ok:true,state:'removed',mainSha:f.main.baseSha,publicationEnabled:false})).state,'removed');
    return id;
}
async function captureGroup(f,assetId,input) {
    let captured;const base=f.env.DB;
    const env={...narrow(f),DB:{prepare(sql){const stmt=base.prepare(sql),bind=stmt.bind;
        if(sql.includes('INSERT INTO private_gallery_batch_purge_operations')) {
            stmt.bind=function(...args){captured={sql,args};return bind.apply(this,args);};
            stmt.run=async()=>{throw new Error('Synthetic pre-commit inspection');};
        }return stmt;}}};
    assert.equal((await purgePrivateArchiveMetadata(env,f.owner,f.site,assetId,input)).ok,false);
    assert.ok(captured,'The exact fully checked group reaches the atomic boundary');return captured;
}
let checks=0;
for(const site of ['family','everyone']) {
    const f=await removedFixture(site);
    try {
        const [first,second]=f.members;
        assert.equal((await deletePrivateArchiveOriginal(f.env,f.owner,site,first.assetId,'owner-delete')).ok,true);
        assert.equal((await inspectPrivateArchivePurge(narrow(f),f.owner,site,first.assetId,f.main)).ok,false,
            'A shared review cannot retire while its sibling original is retained');checks++;
        assert.equal((await deletePrivateArchiveOriginal(f.env,f.owner,site,second.assetId,'owner-delete')).ok,true);
        const proofs=[];
        for(const member of f.members) {const result=await inspectPrivateArchivePurge(narrow(f),f.owner,site,member.assetId,f.main);
            assert.equal(result.ok,true,JSON.stringify(result));proofs.push(result.proofHash);checks++;}
        const leader=await confirm(f,first.assetId,proofs[0]);await claimArchiveJob(narrow(f),leader.jobId,run,'finalizer');
        const unchanged=recordState(f);
        assert.equal((await purgePrivateArchiveMetadata(narrow(f),f.owner,site,first.assetId,leader.input)).ok,false,
            'One photo confirmation cannot authorize sibling metadata deletion');checks++;
        assert.equal(recordState(f),unchanged);checks++;
        await confirm(f,second.assetId,'0'.repeat(64));
        assert.equal((await purgePrivateArchiveMetadata(narrow(f),f.owner,site,first.assetId,leader.input)).ok,false,
            'A sibling approval for the wrong proof is not authority');checks++;
        const sibling=await confirm(f,second.assetId,proofs[1]);
        assert.equal((await purgePrivateArchiveMetadata(narrow(f),f.owner,site,first.assetId,
            {...leader.input,main:{...f.main,baseSha:'f'.repeat(40)}})).ok,false,'Stale main cannot authorize retirement');checks++;
        const unrelated=await reservePrivateGalleryAsset(f.env,f.owner,site,{idempotencyKey:crypto.randomUUID(),
            rosterRevision:(await readPrivateGalleryRoster(f.env,site)).revision,personIds:f.ids,originalFormat:'jpg'});
        assert.equal(unrelated.ok,true);
        const unrelatedId=unrelated.asset.assetId;
        // A failure at the end of the sibling's deletion must roll back every
        // previous retirement, member deletion, shared JSON and audit receipt.
        const before=recordState(f);
        f.db.exec(`CREATE TRIGGER synthetic_group_failure BEFORE DELETE ON private_gallery_assets WHEN OLD.asset_id='${second.assetId}'
            BEGIN SELECT RAISE(ABORT,'synthetic final sibling interruption'); END`);
        assert.equal((await purgePrivateArchiveMetadata(narrow(f),f.owner,site,first.assetId,leader.input)).ok,false);checks++;
        assert.equal(recordState(f),before);assert.equal(count(f,'private_gallery_batch_purge_operations'),0);checks++;
        f.db.exec('DROP TRIGGER synthetic_group_failure');
        const calls=f.original.calls.length+f.staging.calls.length+f.approved.calls.length,host=f.hostRequests.length;
        // Lost commit reply recovers only from the leader's exact hash receipt.
        const base=f.env.DB,lost={...narrow(f),DB:{prepare(sql){const stmt=base.prepare(sql),run=stmt.run;
            stmt.run=async()=>{const result=await run.call(stmt);if(sql.includes('INSERT INTO private_gallery_batch_purge_operations')) throw new Error('synthetic lost group reply');return result;};return stmt;}}};
        const complete=await purgePrivateArchiveMetadata(lost,f.owner,site,first.assetId,leader.input);
        assert.equal(complete.ok,true,JSON.stringify(complete));assert.equal(complete.replayed,true);checks++;
        assert.equal(count(f,'private_gallery_batch_jobs'),0);assert.equal(count(f,'private_gallery_batch_intents'),0);
        assert.equal(count(f,'private_gallery_batch_reviews'),0);assert.equal(count(f,'private_gallery_batch_purge_operations'),0);checks++;
        assert.equal(count(f,'private_archive_purge_receipts'),2);assert.equal(count(f,'private_gallery_retired_batch_jobs'),1);checks++;
        assert.equal(count(f,'private_gallery_assets'),1);assert.equal(f.db.prepare('SELECT asset_id FROM private_gallery_assets').get().asset_id,unrelatedId);checks++;
        assert.equal(count(f,'private_gallery_attempts'),0);assert.equal(count(f,'private_gallery_active_job'),0);checks++;
        const replay=await purgePrivateArchiveMetadata(narrow(f),f.owner,site,first.assetId,{...leader.input,main:null});
        assert.equal(replay.ok,true);assert.equal(replay.replayed,true);checks++;
        assert.equal((await purgePrivateArchiveMetadata(narrow(f),f.owner,site,second.assetId,{...sibling.input,main:null})).ok,true);checks++;
        assert.equal((await purgePrivateArchiveMetadata(narrow(f),f.owner,site,first.assetId,{...leader.input,purgeKey:crypto.randomUUID()})).ok,false);checks++;
        assert.equal((await readRetiredArchiveJob(narrow(f),leader.jobId,run)).state,'private-records-purged');checks++;
        const hashOnly=f.db.prepare('SELECT * FROM private_gallery_retired_batch_jobs').get();
        assert.deepEqual(Object.keys(hashOnly).sort(),['group_proof_hash','job_hash']);
        assert.equal(JSON.stringify(hashOnly).includes(f.jobId),false);assert.equal(JSON.stringify(hashOnly).includes(first.assetId),false);checks++;
        assert.equal(f.original.calls.length+f.staging.calls.length+f.approved.calls.length,calls);assert.equal(f.hostRequests.length,host);checks++;
        assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);checks++;
    } finally {f.db.close();}
}
// Direct SQL must not combine disjoint groups even if every asset has an exact
// same-owner approval. The service derives connected membership independently.
{
    const f=await removedFixture('family');
    try {
        const other=await addSyntheticBatchMember(f,{color:'#af6732'}),otherBatch=await emptyRemovedBatch(f,[other]);
        const all=[...f.members,other],confirmations=[];
        for(const member of all) assert.equal((await deletePrivateArchiveOriginal(f.env,f.owner,f.site,member.assetId,'owner-delete')).ok,true);
        for(const member of all) {
            const dry=await inspectPrivateArchivePurge(narrow(f),f.owner,f.site,member.assetId,f.main);assert.equal(dry.ok,true);
            confirmations.push(await confirm(f,member.assetId,dry.proofHash));
        }
        // Fixture-only savepoint obtains the second group's valid payload
        // without retaining a second claim or performing any deletion.
        f.db.exec('SAVEPOINT synthetic_second_group');
        await claimArchiveJob(narrow(f),confirmations[2].jobId,run+'1','finalizer');
        const second=await captureGroup(f,other.assetId,confirmations[2].input);
        f.db.exec('ROLLBACK TO synthetic_second_group; RELEASE synthetic_second_group');
        await claimArchiveJob(narrow(f),confirmations[0].jobId,run,'finalizer');
        const first=await captureGroup(f,f.members[0].assetId,confirmations[0].input),args=[...first.args];
        args[2]=JSON.stringify([...JSON.parse(args[2]),otherBatch]);
        args[3]=JSON.stringify([...JSON.parse(args[3]),...JSON.parse(second.args[3])]);
        const before=recordState(f);
        assert.throws(()=>f.db.prepare(first.sql).run(...args),/Unrelated groups/);checks++;
        assert.equal(recordState(f),before);checks++;
        assert.equal((await purgePrivateArchiveMetadata(narrow(f),f.owner,f.site,f.members[0].assetId,confirmations[0].input)).ok,true);checks++;
        assert.equal(f.db.prepare('SELECT job_id FROM private_gallery_batch_jobs').get().job_id,otherBatch);
        assert.equal(f.db.prepare('SELECT asset_id FROM private_gallery_assets').get().asset_id,other.assetId);checks++;
    } finally {f.db.close();}
}
// A fresh generation may connect two historical batches through one retained
// asset. Purge must close over both groups, not only the first matching review.
{
    const f=await removedFixture('family');
    try {
        const shared=f.members[1],eligible=await readPrivateGalleryAssetEligibility(f.env,f.owner,f.site,shared.assetId,f.catalog);
        const fresh=await reservePrivateGalleryAttempt(f.env,f.owner,f.site,shared.assetId,{...f.consent,
            idempotencyKey:crypto.randomUUID(),eligibilityRevision:eligible.revision,framingVersion:1},f.catalog);
        assert.equal(fresh.ok,true,JSON.stringify(fresh));
        const third=await addSyntheticBatchMember(f,{color:'#ac6711'});
        await emptyRemovedBatch(f,[{assetId:shared.assetId,attemptId:fresh.attemptId},third]);
        const members=[...f.members,third];
        for(const member of members) assert.equal((await deletePrivateArchiveOriginal(f.env,f.owner,f.site,member.assetId,'owner-delete')).ok,true);
        const approved=[];
        for(const member of members) {
            const dry=await inspectPrivateArchivePurge(narrow(f),f.owner,f.site,member.assetId,f.main);assert.equal(dry.ok,true,JSON.stringify(dry));
            approved.push({member,proofHash:dry.proofHash});
        }
        const first=await confirm(f,members[0].assetId,approved[0].proofHash),second=await confirm(f,members[1].assetId,approved[1].proofHash);
        await claimArchiveJob(narrow(f),first.jobId,run,'finalizer');
        assert.equal((await purgePrivateArchiveMetadata(narrow(f),f.owner,f.site,members[0].assetId,first.input)).ok,false);checks++;
        assert.equal(count(f,'private_gallery_batch_jobs'),2);checks++;
        await confirm(f,third.assetId,approved[2].proofHash);
        assert.equal((await purgePrivateArchiveMetadata(narrow(f),f.owner,f.site,members[0].assetId,first.input)).ok,true);checks++;
        assert.equal(count(f,'private_gallery_batch_jobs'),0);assert.equal(count(f,'private_gallery_assets'),0);checks++;
        assert.equal(count(f,'private_gallery_retired_batch_jobs'),2);assert.equal(count(f,'private_archive_purge_receipts'),3);checks++;
        assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);checks++;
    } finally {f.db.close();}
}
console.log(`Protected shared-batch purge passed ${checks} synthetic checks: every member's separate terminal deletion/proof/owner grant, one held coordinator, atomic rollback/replay, unrelated preservation and hash-only retirement.`);
