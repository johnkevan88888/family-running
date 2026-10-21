import assert from 'node:assert/strict';
import sharp from 'sharp';
import {privateGalleryBatchFixture,batchRun} from './helpers/private-gallery-batch-fixture.mjs';
import {runProtectedArchiveJob} from '../scripts/gallery-media/protected-archive-job.mjs';
import {changePrivateGalleryVisibility} from '../gallery-admin/src/private-gallery-visibility-service.js';
import {queuePrivateArchiveJob} from '../gallery-admin/src/private-gallery-job-service.js';
import {readPrivateArchiveBatches} from '../gallery-admin/src/private-gallery-batch-service.js';

const execute=(f,phase,overrides={})=>runProtectedArchiveJob({jobId:f.jobId,runReference:batchRun,phase,...f.c,
    jobs:f.c.jobs[['verify','finalize'].includes(phase)?'finalizer':'promotion'],github:f.github,...overrides});
const count=(f,table)=>f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
const retained=f=>JSON.stringify(Object.fromEntries(['private_gallery_assets','private_gallery_asset_tags','private_archive_original_receipts',
    'private_gallery_attempts','private_gallery_attempt_framings','private_gallery_frame_revisions'].map(table=>
        [table,f.db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()])));
const writes=f=>f.staging.calls.filter(c=>c[0]==='part').length+f.approved.calls.filter(c=>c[0]==='part').length;
const deletes=f=>f.staging.calls.filter(c=>c[0]==='delete').length+f.approved.calls.filter(c=>c[0]==='delete').length;
async function revoke(f) {
    const result=await changePrivateGalleryVisibility(f.env,f.owner,f.site,f.ids[0],
        {expectedVersion:2,idempotencyKey:crypto.randomUUID(),preference:'hidden'});assert.equal(result.ok,true);
}
async function finishRemoval(f) {
    const verified=await execute(f,'verify');assert.equal(verified.state,'host-ready',JSON.stringify(verified));
    const removed=await execute(f,'reconcile');assert.equal(removed.state,'removed',JSON.stringify(removed));
    assert.equal(count(f,'private_gallery_active_job'),0);
    assert.equal((await execute(f,'finalize')).state,'hidden-original-retained');
    assert.equal(f.original.objects.size,2);assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
    return removed;
}

for(const site of ['family','everyone']) {
    // Actual owner-created batch, durable ledger, split Access HTTP adapters,
    // real pinned decoder/EXIF stripping, GitHub mock and framing projection.
    {
        const f=await privateGalleryBatchFixture(site),before=retained(f);
        try {
            const review=await execute(f,'review');assert.equal(review.state,'unmerged-review',JSON.stringify(review));
            assert.equal(review.claimHeld,true);assert.equal(review.publicationEnabled,false);
            const ownerView=(await readPrivateArchiveBatches(f.env,f.owner,site)).batches[0];
            assert.equal(ownerView.reviewUrl,review.review.pullRequest.url,'Owner list projects the exact durably recorded shared review');
            assert.equal(ownerView.state,'running');
            assert.equal(f.github.state.pulls.length,1);assert.equal(f.github.state.pulls[0].state,'open');
            assert.equal(f.github.state.manifests[site].items.length,0,'No test publication is performed');
            assert.equal(count(f,'private_gallery_pipeline_review_intents'),0,'Batch never rewrites one-photo intent semantics');
            assert.equal(count(f,'private_gallery_pipeline_reviews'),0);
            assert.equal(count(f,'private_gallery_active_job'),1,'Open shared review keeps the global slot');
            const candidate=JSON.parse(f.db.prepare('SELECT candidate_json FROM private_gallery_batch_intents').get().candidate_json);
            const items=JSON.parse(candidate.manifestText).items;
            assert.equal(items.length,2);assert.deepEqual(items.map(item=>item.id),review.review.itemIds);
            assert.deepEqual(items.map(item=>item.athleteIds),[['fixture-public'],['fixture-public-second']]);
            assert.deepEqual(items[0].podiumFraming,{'fixture-public':{x:25,y:20,zoom:2}});
            assert.deepEqual(items[1].podiumFraming,{'fixture-public-second':{x:70,y:60,zoom:3}});
            for(const sentinel of ['person_','asset_','attempt_','private-first-camera','private-second-camera','sourceSha256','imageWidth'])
                assert.equal(candidate.manifestText.includes(sentinel),false,`Private metadata leaked: ${sentinel}`);
            for(const item of items) for(const field of ['sourceUrl','thumbnailUrl']) {
                const bytes=f.approved.objects.get(new URL(item[field]).pathname.slice(1)).bytes;
                const metadata=await sharp(bytes).metadata();assert.equal(metadata.exif,undefined);assert.equal(metadata.xmp,undefined);
                assert.equal(metadata.iptc,undefined);assert.equal(metadata.orientation,undefined);
            }
            assert.equal(retained(f),before,'Each original, tag, consent and checked frame remains byte-for-byte unchanged');
            const originalReads=f.original.calls.length,parts=writes(f),reviewJSON=f.db.prepare('SELECT review_json FROM private_gallery_batch_reviews').get().review_json;
            const replay=await execute(f,'review');assert.equal(replay.state,'unmerged-review');assert.equal(replay.review.replayed,true);
            assert.equal(f.original.calls.length,originalReads);assert.equal(writes(f),parts);assert.equal(f.github.state.pulls.length,1);
            assert.equal(f.db.prepare('SELECT review_json FROM private_gallery_batch_reviews').get().review_json,reviewJSON);
            assert.equal((await f.c.jobs.promotion(f.jobId,'claim',{runReference:batchRun+'1'})).ok,false,'Another run cannot steal an open batch');
            assert.equal((await queuePrivateArchiveJob(f.env,f.owner,site,f.assetId,{action:'publication',attemptId:f.attemptId,idempotencyKey:crypto.randomUUID()})).ok,false);
            const beforeOutage=deletes(f);f.github.state.unavailable=true;
            assert.equal((await execute(f,'review')).ok,false);
            assert.equal(deletes(f),beforeOutage,'Unknown main must not delete unclosed possibly owner-published generations');
            assert.equal(count(f,'private_gallery_pipeline_closures'),0);f.github.state.unavailable=false;
            await revoke(f);assert.equal((await execute(f,'review')).ok,false,'One revoked member stops the whole review');
            assert.equal(count(f,'private_gallery_pipeline_closures'),2);
            assert.equal(f.github.state.pulls[0].state,'open','Closure is a separately verified GitHub reconciliation');
            assert.equal((await execute(f,'reconcile')).ok,false,'Storage cleanup is not public-host absence');
            assert.equal(count(f,'private_gallery_active_job'),1);
            await finishRemoval(f);assert.equal(f.github.state.pulls[0].state,'closed');
            const evidence=retained(f),cleanup=deletes(f),host=f.hostRequests.length;
            assert.equal((await execute(f,'reconcile')).replayed,true);assert.equal(deletes(f),cleanup);assert.equal(f.hostRequests.length,host);
            assert.equal(retained(f),evidence);assert.equal(retained(f),before);
        } finally {f.db.close();}
    }
    // A lost durable reply is not authority to create a second review or reset
    // consent. Recovery positively closes the existing shared PR and verifies
    // every generation's public-host absence before releasing its claim.
    {
        const f=await privateGalleryBatchFixture(site),before=retained(f);let lose=true;
        try {
            f.c.setReplyHook(async(request,response)=>{if(lose && request.url.endsWith('/batch-open') && response.ok) {lose=false;throw new Error('Synthetic lost batch-open reply');}});
            assert.equal((await execute(f,'review')).ok,false);f.c.setReplyHook(null);
            assert.equal(f.github.state.pulls.length,1);assert.equal(count(f,'private_gallery_batch_reviews'),1);
            assert.equal(count(f,'private_gallery_pipeline_closures'),2);
            const priorDeletes=deletes(f);f.github.state.unavailable=true;
            assert.equal((await execute(f,'reconcile')).ok,false);assert.ok(deletes(f)>=priorDeletes);
            assert.equal(count(f,'private_gallery_batch_terminals'),0);assert.equal(count(f,'private_gallery_active_job'),1);
            f.github.state.unavailable=false;await finishRemoval(f);
            assert.equal(f.github.state.pulls[0].state,'closed');assert.equal(retained(f),before);
        } finally {f.db.close();}
    }
    // An admitted PR POST still in flight cannot be turned into no-PR evidence
    // by an empty listing. When it lands, recovery observes and closes it once.
    {
        const f=await privateGalleryBatchFixture(site);let release,entered;
        const entry=new Promise(resolve=>{entered=resolve;}),held=new Promise(resolve=>{release=resolve;});
        try {
            f.github.state.hook=async(path,method)=>{if(method==='POST' && path==='/pulls') {entered();await held;}};
            const running=execute(f,'review');await entry;
            assert.equal(count(f,'private_gallery_batch_write_admissions'),1);
            assert.equal((await execute(f,'reconcile')).ok,false);
            assert.equal(count(f,'private_gallery_batch_terminals'),0,'No-PR observation cannot erase an admitted uncertain POST');
            assert.equal(count(f,'private_gallery_active_job'),1);
            release();assert.equal((await running).ok,false);f.github.state.hook=null;
            await finishRemoval(f);assert.equal(f.github.state.pulls.length,1);assert.equal(f.github.state.pulls[0].state,'closed');
            assert.equal(f.github.state.requests.filter(r=>r.method==='POST' && r.path==='/pulls').length,1);
        } finally {release?.();f.db.close();}
    }
    // Revocation before processing/intent creation needs no invented PR receipt.
    {
        const f=await privateGalleryBatchFixture(site);
        try {
            await revoke(f);assert.equal((await execute(f,'review')).ok,false);
            assert.equal(count(f,'private_gallery_batch_intents'),0);assert.equal(f.github.state.pulls.length,0);
            await finishRemoval(f);assert.equal(count(f,'private_gallery_batch_terminals'),0);
            const batches=await readPrivateArchiveBatches(f.env,f.owner,site);assert.equal(batches.batches[0].state,'removed');
        } finally {f.db.close();}
    }
    // A member revoked after derivative verification but before PR admission
    // blocks the whole PR. The other member's consent is not used as a bypass.
    {
        const f=await privateGalleryBatchFixture(site);let changed=false;
        try {
            f.github.state.hook=async(path,method)=>{if(!changed && method==='POST' && path==='/git/refs') {changed=true;await revoke(f);}};
            assert.equal((await execute(f,'review')).ok,false);f.github.state.hook=null;
            assert.equal(count(f,'private_gallery_batch_intents'),1);
            assert.equal(count(f,'private_gallery_batch_write_admissions'),0);
            assert.equal(f.github.state.pulls.length,0);await finishRemoval(f);
            assert.equal(JSON.parse(f.db.prepare('SELECT evidence_json FROM private_gallery_batch_terminals').get().evidence_json).state,'no-pr-created');
        } finally {f.db.close();}
    }
    // Changed catalogue or original bytes in the second member cannot leave
    // the first member independently published or create a partial batch PR.
    for(const failure of ['catalogue','original']) {
        const f=await privateGalleryBatchFixture(site);let changed=false;
        try {
            f.c.setReplyHook(async(request,response)=>{
                if(changed || !request.url.endsWith('/promote') || !response.ok) return;changed=true;
                if(failure==='catalogue') f.catalog.sourceRevision=`sha256:${'c'.repeat(64)}`;
                else {
                    const key=f.db.prepare('SELECT private_object_key FROM private_gallery_assets WHERE asset_id=?').get(f.members[1].assetId).private_object_key;
                    f.original.objects.get(key).bytes=Buffer.from('corrupted synthetic original');
                }
            });
            assert.equal((await execute(f,'review')).ok,false);f.c.setReplyHook(null);
            assert.equal(f.github.state.pulls.length,0);assert.equal(count(f,'private_gallery_batch_intents'),0);
            assert.equal(count(f,'private_gallery_pipeline_closures'),2);await finishRemoval(f);
        } finally {f.db.close();}
    }
    // An explicitly simulated out-of-band owner merge is not authority for
    // this review-only runner to delete live bytes or claim publication proof.
    {
        const f=await privateGalleryBatchFixture(site);
        try {
            const review=await execute(f,'review');assert.equal(review.ok,true);
            f.github.ownerMerge(review.review); // In-memory fault fixture only.
            const beforeDeletes=deletes(f),beforeWrites=writes(f);
            assert.equal((await execute(f,'review')).state,'already-published');
            assert.equal((await execute(f,'reconcile')).ok,false);
            f.github.state.unavailable=true;assert.equal((await execute(f,'review')).ok,false);
            assert.equal(deletes(f),beforeDeletes);assert.equal(writes(f),beforeWrites);
            assert.equal(count(f,'private_gallery_active_job'),1,'No unsupported publication completion');
        } finally {f.db.close();}
    }
    // Existing intake accepts small photos. Their two independently verified
    // role-specific objects may have identical bytes; that is not URL reuse.
    {
        const f=await privateGalleryBatchFixture(site,{small:true});
        try {
            assert.equal((await execute(f,'review')).state,'unmerged-review');
            const candidate=JSON.parse(f.db.prepare('SELECT candidate_json FROM private_gallery_batch_intents').get().candidate_json);
            for(const item of JSON.parse(candidate.manifestText).items) {
                assert.notEqual(item.sourceUrl,item.thumbnailUrl);
                assert.equal(new URL(item.sourceUrl).pathname.split('/').at(-2),new URL(item.thumbnailUrl).pathname.split('/').at(-2));
            }
            assert.equal(count(f,'private_gallery_pipeline_byte_receipts'),8,'Every tier and role still has its own verified receipt');
        } finally {f.db.close();}
    }
}
console.log('Protected batch queue -> split authenticated processing -> one combined review, unchanged per-photo consent/framing, same-run recovery, revocation, lost/delayed replies and independent host absence pass both areas with generated images only.');
