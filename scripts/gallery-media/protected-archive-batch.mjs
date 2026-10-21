import {processGalleryPhoto} from './processor.mjs';
import {assertPhotoFramingSource} from './photo-framing-source.mjs';
import {readGalleryReviewMain} from './github-review-client.mjs';
import {createOrReconcileArchiveGalleryBatchReview,readExistingGalleryBatchReview,
    reconcileArchiveGalleryBatchReview} from './github-batch-review-client.mjs';
import {resumeProtectedArchiveRemoval} from './protected-archive-lifecycle.mjs';

// A batch is a protected, immutable selection of independently consented
// attempts. It is NOT aggregate consent or a concatenation of old PR receipts.
// No ambient fetch, credentials, dispatch, merge, purge or original deletion.
const attempt=/^attempt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const asset=/^asset_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const jobPattern=/^job_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const runPattern=/^https:\/\/github\.com\/johnkevan88888\/family-running\/actions\/runs\/[1-9][0-9]*$/;
const pending=()=>({ok:false,state:'pending',publicationEnabled:false});
const gh=github=>({token:github.token,fetchImpl:github.fetchImpl});
const uses=(row,id,urls=[])=>row.id===id || ['sourceUrl','thumbnailUrl','posterUrl'].some(key=>urls.includes(row[key]));
const absent=(main,id,urls)=>['family','everyone'].every(site=>!main.manifestsBySite[site].items.some(row=>uses(row,id,urls)));
async function checked(service,id,operation,value) {
    const result=await service(id,operation,value);
    if(result?.ok!==true) throw new Error('Unavailable');return result.value;
}
function validate({jobId,runReference,job,jobs,processing,promotion}) {
    if(!jobPattern.test(jobId||'') || !runPattern.test(runReference||'') || job?.jobId!==jobId || job.action!=='batch-review' ||
        job.runReference!==runReference || !['family','everyone'].includes(job.site) || !Array.isArray(job.attempts) ||
        job.attempts.length<1 || job.attempts.length>20 || new Set(job.attempts).size!==job.attempts.length ||
        job.attempts.some(id=>!attempt.test(id)) || !Array.isArray(job.members) || job.members.length!==job.attempts.length ||
        new Set(job.members.map(member=>member.assetId)).size!==job.members.length ||
        job.members.some((member,index)=>member.attemptId!==job.attempts[index] || !asset.test(member.assetId||'')) ||
        [jobs,processing,promotion].some(service=>typeof service!=='function')) throw new Error('Unavailable');
}
async function cleanAll(job,processing,promotion,closedOnly=false) {
    // A failed member never prevents the other members/tiers from closing.
    const ids=closedOnly?job.members.filter(member=>member.closed===true).map(member=>member.attemptId):job.attempts;
    const results=await Promise.allSettled(ids.flatMap(id=>[processing,promotion].map(async service=>{
        await checked(service,id,'close');await checked(service,id,'cleanup');
    })));
    return results.every(result=>result.status==='fulfilled');
}
async function checkedItems(job,candidate,promotion) {
    const manifest=JSON.parse(candidate.manifestText);
    if(candidate.itemIds.length!==job.attempts.length) throw new Error('Changed');
    for(const [index,id] of job.attempts.entries()) {
        const current=await checked(promotion,id,'candidate');
        if(current.site!==job.site || current.item.id!==candidate.itemIds[index] ||
            JSON.stringify(manifest.items.find(item=>item.id===current.item.id))!==JSON.stringify(current.item)) throw new Error('Changed');
    }
}

export async function runProtectedArchiveBatchReview(context) {
    const {jobId,runReference,job,jobs,processing,promotion,github}=context;
    try {validate(context);} catch {return pending();}
    let main;
    try {main=await readGalleryReviewMain(gh(github));}
    catch {
        // An unavailable main cannot tell us whether an owner merged this PR
        // out of band. Only already-closed generations may retry cleanup.
        await cleanAll(job,processing,promotion,true);return pending();
    }
    try {
        // Review recovery never silently removes a separately owner-merged
        // batch. Publication is intentionally unsupported by this bridge.
        if(job.candidate && job.candidate.itemIds.some(id=>!absent(main,id,[])))
            return {ok:false,state:'already-published',publicationEnabled:false};
        if(job.reviewTerminal) return pending();
        let saved=job;
        if(!saved.candidate) {
            for(const id of job.attempts) {
                const old=await checked(promotion,id,'review');
                if(old.site!==job.site || old.candidate || old.review || old.reviewTerminal ||
                    !Array.isArray(old.historical) || old.historical.some(item=>!item.removed || !absent(main,item.itemId,item.urls))) throw new Error('Changed');
            }
            // Process sequentially: bounded memory, separate original digest,
            // decoder/metadata scan, generation and framing for every photo.
            for(const id of job.attempts) {
                const admission=await checked(processing,id,'start');
                const source=await checked(processing,id,'original');
                const processed=await processGalleryPhoto({sourceBytes:Buffer.from(source.bytes),fileExtension:source.mimeType==='image/jpeg'?'jpg':'png',
                    declaredMimeType:source.mimeType,expectedSha256:source.sha256,
                    draftBinding:{site:job.site,draftId:`draft_${id.slice(8)}`,processingRunId:`run_${id.slice(8).replaceAll('-','')}`}});
                assertPhotoFramingSource(admission.framingSource,processed.source);
                for(const derivative of processed.derivatives) await checked(processing,id,derivative.storageRole,
                    {bytes:await derivative.payload.arrayBuffer(),toolchain:processed.toolchain});
                await checked(promotion,id,'promote');
            }
            saved={...job,...await checked(jobs,jobId,'batch-reserve',{runReference,main:await readGalleryReviewMain(gh(github))})};
        }
        await checkedItems(job,saved.candidate,promotion);
        const options={expectedBaseSha:saved.baseSha,...gh(github)};
        const review=saved.review?await readExistingGalleryBatchReview(saved.candidate,options):
            await createOrReconcileArchiveGalleryBatchReview(saved.candidate,{...options,
                admitPullRequest:()=>checked(jobs,jobId,'batch-write',{runReference})});
        await checked(jobs,jobId,'batch-open',{runReference,review});
        await checkedItems(job,saved.candidate,promotion);
        // Keep the global claim. Neither a one-photo publication job nor a
        // purge may reinterpret this shared, still-unmerged review.
        return {ok:true,state:'unmerged-review',review,claimHeld:true,publicationEnabled:false};
    } catch {
        await cleanAll(job,processing,promotion);
        return pending(); // Unknown external writes retain the exact same run.
    }
}

export async function resumeProtectedArchiveBatchRemoval(context) {
    const {jobId,runReference,job,jobs,processing,promotion,github}=context;
    try {validate(context);} catch {return pending();}
    let main;
    try {main=await readGalleryReviewMain(gh(github));}
    catch {await cleanAll(job,processing,promotion,true);return pending();}
    try {
        // This local bridge cannot remove a published batch or create a public
        // removal proposal. Never substitute storage absence for host absence.
        if(job.candidate && job.candidate.itemIds.some(id=>!absent(main,id,[]))) return pending();
        if(!await cleanAll(job,processing,promotion)) return pending();
        if(job.candidate && !job.reviewTerminal) {
            const evidence=await reconcileArchiveGalleryBatchReview(job.candidate,{expectedBaseSha:job.baseSha,...gh(github)});
            await checked(jobs,jobId,'batch-terminal',{runReference,evidence});
        }
        // Independent still-current host receipts are read through the normal
        // removal path. Its SQL cannot accept a member until shared PR terminal.
        const snapshotVerifier=async id=>({ok:true,value:{hostDeletionConfirmed:
            (await checked(promotion,id,'review')).hostDeletionConfirmed===true}});
        const completionMain=await readGalleryReviewMain(gh(github));
        for(const id of job.attempts) {
            const result=await resumeProtectedArchiveRemoval({attemptId:id,processing,promotion,verifier:snapshotVerifier,github});
            if(result?.ok!==true || result.state!=='removed' || result.mainSha!==completionMain.baseSha) return pending();
        }
        if((await readGalleryReviewMain(gh(github))).baseSha!==completionMain.baseSha) return pending();
        const result={ok:true,state:'removed',mainSha:completionMain.baseSha,publicationEnabled:false};
        await checked(jobs,jobId,'complete',{runReference,result});
        return result;
    } catch {return pending();}
}
