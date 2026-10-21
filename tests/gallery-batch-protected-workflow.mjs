import assert from 'node:assert/strict';
import sharp from 'sharp';
import {privateGalleryBatchFixture,batchRun} from './helpers/private-gallery-batch-fixture.mjs';
import {runProtectedArchiveJob} from '../scripts/gallery-media/protected-archive-job.mjs';
import {changePrivateGalleryVisibility} from '../gallery-admin/src/private-gallery-visibility-service.js';
import {queuePrivateArchiveJob} from '../gallery-admin/src/private-gallery-job-service.js';
import {readPrivateArchiveBatches,requestPrivateArchiveBatchPublication} from '../gallery-admin/src/private-gallery-batch-service.js';
import {readMergedGalleryBatchPublication} from '../scripts/gallery-media/github-batch-review-client.mjs';
import {deletePrivateArchiveOriginal} from '../gallery-admin/src/private-archive-service.js';

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
async function grantPublication(f) {
    const result=await requestPrivateArchiveBatchPublication(f.env,f.owner,f.site,f.jobId,{idempotencyKey:crypto.randomUUID()});
    assert.equal(result.ok,true,JSON.stringify(result));return result;
}
function ownerMerge(f,review) {
    f.github.ownerMerge(review); // The only merge capability is this fixture.
    f.github.state.pulls.find(pull=>pull.number===review.pullRequest.number).merged_by={login:'johnkevan88888'};
}
async function publishFixture(f) {
    const reviewed=await execute(f,'review');assert.equal(reviewed.state,'unmerged-review',JSON.stringify(reviewed));
    await grantPublication(f);
    const ready=await execute(f,'review');assert.equal(ready.state,'ready-for-separate-owner-merge',JSON.stringify(ready));
    assert.equal(ready.claimHeld,true);assert.equal(count(f,'private_gallery_active_job'),1);
    assert.equal(f.github.state.pulls[0].state,'open','The runner has no merge capability');
    ownerMerge(f,reviewed.review);
    const observed=await execute(f,'review');assert.equal(observed.state,'publication-observed',JSON.stringify(observed));
    assert.equal(count(f,'private_gallery_active_job'),0);
    return {reviewed,ready,observed};
}
async function individualJob(f,member,action='removal',extra={}) {
    const queued=await queuePrivateArchiveJob(f.env,f.owner,f.site,member.assetId,{action,idempotencyKey:crypto.randomUUID(),...extra});
    assert.equal(queued.ok,true,JSON.stringify(queued));
    const runReference=`https://github.com/johnkevan88888/family-running/actions/runs/${500+count(f,'private_gallery_owner_jobs')}`;
    return phase=>runProtectedArchiveJob({jobId:queued.job.jobId,runReference,phase,...f.c,
        jobs:f.c.jobs[['verify','finalize','purge'].includes(phase)?'finalizer':'promotion'],github:f.github});
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
            assert.equal(f.github.state.pulls[0].state,'closed','Failed review positively closes the unmerged PR before unclosed byte cleanup');
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
            const priorDeletes=deletes(f),priorTerminals=count(f,'private_gallery_batch_terminals');f.github.state.unavailable=true;
            assert.equal((await execute(f,'reconcile')).ok,false);assert.ok(deletes(f)>=priorDeletes);
            assert.equal(count(f,'private_gallery_batch_terminals'),priorTerminals,'Current outage preserves previously completed terminal evidence');assert.equal(count(f,'private_gallery_active_job'),1);
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
            assert.equal(count(f,'private_gallery_pipeline_closures'),0,'Uncertain no-PR cannot manufacture later cleanup authority');
            assert.equal(count(f,'private_gallery_active_job'),1);
            release();assert.equal((await running).state,'unmerged-review');f.github.state.hook=null;
            assert.equal((await execute(f,'reconcile')).state,'pending','Separate cancellation closes the now-observable shared PR before host verification');
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
    // A main snapshot is not a merge lock. If the owner merges between it and
    // the exact PR read, neither review error recovery nor cancellation can
    // create closures/deletion authority for unclosed, potentially-live photos.
    for(const phase of ['review','reconcile']) {
        const f=await privateGalleryBatchFixture(site);
        try {
            const review=await execute(f,'review');let merged=false;
            const before=deletes(f);
            f.github.state.hook=async(path,method)=>{
                if(!merged && method==='GET' && path==='/pulls') {merged=true;ownerMerge(f,review.review);}
            };
            assert.equal((await execute(f,phase)).state,'pending');f.github.state.hook=null;
            assert.equal(merged,true);assert.equal(deletes(f),before);
            assert.equal(count(f,'private_gallery_pipeline_closures'),0,'A stale absent snapshot cannot manufacture future cleanup permission');
            assert.equal(count(f,'private_gallery_active_job'),1);
        } finally {f.db.close();}
    }
    // The separate owner grant selects publication on the original held job.
    // All-member observation releases it, while immutable member origins make
    // later strict one-photo removal independent of already-removed siblings.
    {
        const f=await privateGalleryBatchFixture(site),before=retained(f);
        try {
            const {observed}=await publishFixture(f);
            assert.equal(observed.evidence.state,'merged-by-owner');
            assert.equal(count(f,'private_gallery_batch_publications'),1);
            assert.equal(count(f,'private_gallery_batch_member_origins'),2);
            assert.equal(count(f,'private_gallery_pipeline_review_intents'),0,'No synthetic single-photo addition receipt');
            assert.equal(count(f,'private_gallery_pipeline_reviews'),0);
            assert.equal(retained(f),before);
            const readCount=f.github.state.requests.length;
            assert.equal((await execute(f,'review')).replayed,true);
            assert.equal(f.github.state.requests.length,readCount,'Completed publication replay is read-only');
            for(const [index,member] of f.members.entries()) {
                const sibling=f.members[1-index],siblingItem=f.github.state.manifests[site].items.find(item=>
                    item.id===f.db.prepare('SELECT public_item_id FROM private_gallery_attempts WHERE attempt_id=?').get(sibling.attemptId).public_item_id);
                const job=await individualJob(f,member);
                assert.equal((await job('cleanup')).state,'cleanup-ready');
                assert.equal((await job('verify')).state,'host-ready');
                const removal=await job('reconcile');assert.equal(removal.state,'unmerged-removal-review',JSON.stringify(removal));
                assert.equal(JSON.parse(f.db.prepare('SELECT removal_json FROM private_gallery_manifest_removal_intents WHERE attempt_id=? ORDER BY created_at DESC').get(member.attemptId).removal_json).manifestText.includes('private-'),false);
                assert.equal(f.original.objects.size,2,'Hide/removal retains both originals');
                if(siblingItem) assert.deepEqual(f.github.state.manifests[site].items.find(item=>item.id===siblingItem.id),siblingItem);
                ownerMerge(f,removal.review);
                // The ordinary request that produced a review is complete;
                // a fresh owner removal job observes its merge and absence.
                const reconcile=await individualJob(f,member);
                assert.equal((await reconcile('cleanup')).state,'cleanup-ready');
                assert.equal((await reconcile('verify')).state,'host-ready');
                assert.equal((await reconcile('reconcile')).state,'removed');
                assert.equal((await reconcile('finalize')).state,'hidden-original-retained');
                assert.equal(f.github.state.manifests[site].items.length,1-index);
                assert.equal(retained(f),before,'Originals, tags, consent and framing remain unchanged after removal');
            }
            assert.equal(count(f,'private_gallery_batch_member_origins'),2,'Removing photos does not erase shared publication history');
            // Refresh the first photo's older absence receipt through another
            // ordinary protected removal job at the latest shared main. No
            // direct SQL receipt fabrication or timestamp reset is involved.
            for(const member of f.members) {
                const refresh=await individualJob(f,member);
                assert.equal((await refresh('cleanup')).state,'cleanup-ready');
                assert.equal((await refresh('verify')).state,'host-ready');
                assert.equal((await refresh('reconcile')).state,'removed');
                assert.equal((await deletePrivateArchiveOriginal(f.env,f.owner,site,member.assetId,'owner-delete')).ok,true);
            }
            const proofs=[];
            for(const member of f.members) {
                const inspect=await individualJob(f,member,'purge-inspect');
                const proof=await inspect('purge');assert.equal(proof.state,'purge-eligible',JSON.stringify(proof));proofs.push(proof.proofHash);
            }
            const leader=await individualJob(f,f.members[0],'purge',{expectedProofHash:proofs[0],purgeKey:crypto.randomUUID()});
            assert.equal((await leader('purge')).state,'pending','One member cannot authorize deletion of shared siblings');
            assert.equal(count(f,'private_gallery_assets'),2);assert.equal(count(f,'private_gallery_batch_member_origins'),2);
            await individualJob(f,f.members[1],'purge',{expectedProofHash:proofs[1],purgeKey:crypto.randomUUID()});
            const purged=await leader('purge');assert.equal(purged.state,'private-records-purged',JSON.stringify(purged));
            assert.equal(count(f,'private_gallery_assets'),0);assert.equal(count(f,'private_gallery_batch_jobs'),0);
            assert.equal(count(f,'private_gallery_batch_member_origins'),0,'No private shared manifest/review JSON remains after coordinated terminal purge');
            assert.equal(count(f,'private_archive_purge_receipts'),2);assert.equal(f.original.objects.size,0);
            assert.equal((await leader('purge')).replayed,true,'Retired protected leader job replays without old member records');
            assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
        } finally {f.db.close();}
    }
    // Revocation before the separate owner merge closes the exact shared PR,
    // retaining the batch claim until independent host and stable-main proof.
    {
        const f=await privateGalleryBatchFixture(site);
        try {
            assert.equal((await execute(f,'review')).state,'unmerged-review');await grantPublication(f);
            await revoke(f);assert.equal((await execute(f,'review')).state,'pending');
            assert.equal(f.github.state.pulls[0].state,'closed');assert.equal(count(f,'private_gallery_batch_publications'),0);
            assert.equal(count(f,'private_gallery_active_job'),1);await finishRemoval(f);
        } finally {f.db.close();}
    }
    // A revoked member after the owner merge must not deadlock the shared
    // claim or pretend publication passed. Positive merge history is retained;
    // all cleanup/host checks and separate -1 owner reviews are still required.
    {
        const f=await privateGalleryBatchFixture(site),before=retained(f);
        try {
            const review=await execute(f,'review');await grantPublication(f);
            ownerMerge(f,review.review);await revoke(f);
            const closed=count(f,'private_gallery_pipeline_closures');
            const unclosed=f.members.filter(member=>!f.db.prepare('SELECT 1 FROM private_gallery_pipeline_closures WHERE attempt_id=?').get(member.attemptId));
            const protectedKeys=unclosed.flatMap(member=>f.db.prepare('SELECT object_key FROM private_gallery_pipeline_outputs WHERE attempt_id=?').all(member.attemptId).map(row=>row.object_key));
            const deleted=deletes(f);f.github.state.unavailable=true;
            assert.equal((await execute(f,'review')).state,'pending');
            assert.equal(count(f,'private_gallery_pipeline_closures'),closed,'Outage cannot manufacture new closure authority');
            for(const key of protectedKeys) assert.equal([...f.staging.calls,...f.approved.calls].slice().filter(call=>call[0]==='delete' && call[1]===key).length,0,'Only the already-revoked member may clean during an outage');
            assert.ok(deletes(f)>=deleted);f.github.state.unavailable=false;
            assert.equal((await execute(f,'review')).state,'pending');
            assert.equal(count(f,'private_gallery_batch_publications'),1,'Exact merge origin is retained, not successful publication');
            assert.equal(count(f,'private_gallery_batch_completions'),0);assert.equal(count(f,'private_gallery_active_job'),1);
            assert.equal((await execute(f,'verify')).state,'host-ready');
            for(let index=0;index<2;index++) {
                const removal=await execute(f,'reconcile');assert.equal(removal.state,'unmerged-removal-review',JSON.stringify(removal));
                assert.equal(removal.claimHeld,true);assert.equal(count(f,'private_gallery_active_job'),1);
                ownerMerge(f,removal.review);
            }
            assert.equal((await execute(f,'reconcile')).state,'removed');
            assert.equal(count(f,'private_gallery_active_job'),0);assert.equal(retained(f),before);
            assert.equal(f.original.objects.size,2);assert.equal((await execute(f,'finalize')).state,'hidden-original-retained');
        } finally {f.db.close();}
    }
    // The completion response may be lost after commit, or while the accepted
    // RPC still waits to commit. Even with an origin already saved, a failed
    // ledger read cannot authorize closing/deleting a successful publication.
    for(const timing of ['committed','in-flight']) {
        const f=await privateGalleryBatchFixture(site);let release,late;
        try {
            const reviewed=await execute(f,'review');await grantPublication(f);ownerMerge(f,reviewed.review);
            const candidate=JSON.parse(f.db.prepare('SELECT candidate_json FROM private_gallery_batch_intents').get().candidate_json);
            const evidence=await readMergedGalleryBatchPublication(candidate,reviewed.review,
                {expectedBaseSha:reviewed.review.baseSha,token:f.github.token,fetchImpl:f.github.fetchImpl});
            assert.equal((await f.c.jobs.promotion(f.jobId,'batch-publication-observe',{runReference:batchRun,evidence})).ok,true);
            const before=deletes(f);let uncertain=false;
            const jobs=async(...args)=>{
                if(uncertain && args[1]==='read') return {ok:false};
                if(args[1]==='complete') {
                    uncertain=true;
                    if(timing==='committed') await f.c.jobs.promotion(...args);
                    else {const gate=new Promise(resolve=>{release=resolve;});late=gate.then(()=>f.c.jobs.promotion(...args));}
                    throw new Error('Synthetic completion response lost');
                }
                return f.c.jobs.promotion(...args);
            };
            assert.equal((await execute(f,'review',{jobs})).state,'pending');
            assert.equal(deletes(f),before);assert.equal(count(f,'private_gallery_pipeline_closures'),0);
            if(late) {assert.equal(count(f,'private_gallery_active_job'),1);release();assert.equal((await late).ok,true);}
            assert.equal(count(f,'private_gallery_active_job'),0);
            assert.equal((await execute(f,'review')).replayed,true);assert.equal(deletes(f),before);
        } finally {release?.();await late;f.db.close();}
    }
    // A terminal checkpoint may commit before its reply is lost and before
    // object cleanup starts. The next real prepare→verify→reconcile sequence
    // resumes closed-only cleanup instead of looping forever at verification.
    for(const publication of [false,true]) {
        const f=await privateGalleryBatchFixture(site);let lose=true;
        try {
            assert.equal((await execute(f,'review')).state,'unmerged-review');
            if(publication) {await grantPublication(f);await revoke(f);}
            f.c.setReplyHook(async(request,response)=>{
                if(lose && request.url.endsWith('/batch-terminal') && response.ok) {lose=false;throw new Error('Synthetic committed terminal response lost');}
            });
            assert.equal((await execute(f,publication?'review':'reconcile')).state,'pending');f.c.setReplyHook(null);
            assert.equal(count(f,'private_gallery_batch_terminals'),1);assert.equal(count(f,'private_gallery_pipeline_closures'),2);
            assert.equal(f.approved.objects.size,5,'Durable terminal committed before derivative cleanup');
            assert.equal((await execute(f,'review')).state,'pending');
            await finishRemoval(f);assert.equal(f.approved.objects.size,1,'Only the synthetic binding witness remains');
        } finally {f.db.close();}
    }
    // Positive merge history alone cannot complete publication. A catalogue
    // change after origin storage is caught by the second all-member check.
    {
        const f=await privateGalleryBatchFixture(site);let changed=false;
        try {
            const reviewed=await execute(f,'review');await grantPublication(f);ownerMerge(f,reviewed.review);
            f.c.setReplyHook(async(request,response)=>{
                if(!changed && request.url.endsWith('/batch-publication-observe') && response.ok) {
                    changed=true;f.catalog.sourceRevision=`sha256:${'c'.repeat(64)}`;
                }
            });
            assert.equal((await execute(f,'review')).state,'pending');f.c.setReplyHook(null);
            assert.equal(changed,true);assert.equal(count(f,'private_gallery_batch_publications'),1);
            assert.equal(count(f,'private_gallery_batch_completions'),0,'Origin proof does not replace fresh catalogue/consent/bytes eligibility');
            assert.equal(count(f,'private_gallery_active_job'),1);assert.equal(count(f,'private_gallery_pipeline_closures'),2);
            assert.equal(f.original.objects.size,2);
        } finally {f.db.close();}
    }
}
console.log('Protected batch review/publication, per-photo removal, coordinated purge, same-run recovery, owner-merge races, revocation, lost/delayed writes and independent host absence pass both areas with generated images only.');
