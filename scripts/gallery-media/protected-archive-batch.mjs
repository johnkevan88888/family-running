import {processGalleryPhoto} from './processor.mjs';
import {assertPhotoFramingSource} from './photo-framing-source.mjs';
import {readGalleryReviewMain} from './github-review-client.mjs';
import {createOrReconcileArchiveGalleryBatchReview,readExistingGalleryBatchReview,
    reconcileArchiveGalleryBatchReview,readMergedGalleryBatchPublication,
    readMergedGalleryBatchMemberReview} from './github-batch-review-client.mjs';
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
async function settleUnmerged(context,job,evidence) {
    const {jobs,jobId,runReference,processing,promotion}=context;
    // An admitted POST may land after an empty PR listing. Do not manufacture
    // closures which a later outage could mistake for deletion authority.
    if(evidence.state==='merged-by-owner' || evidence.state==='no-pr-created' && job.writeAdmitted!==false) return false;
    const closed=await Promise.allSettled(job.attempts.flatMap(id=>[processing,promotion].map(service=>checked(service,id,'close'))));
    if(closed.some(result=>result.status!=='fulfilled')) return false;
    await checked(jobs,jobId,'batch-terminal',{runReference,evidence});
    return cleanAll(job,processing,promotion);
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
        // Review alone never supplies the owner's separate publication grant.
        if(job.candidate && job.candidate.itemIds.some(id=>!absent(main,id,[])))
            return {ok:false,state:'already-published',publicationEnabled:false};
        if(job.reviewTerminal) {await cleanAll(job,processing,promotion,true);return pending();}
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
        try {
            // The owner can merge between the first main snapshot and a later
            // review read. A validation failure is not proof of an unmerged
            // PR: refresh durable intent/main and positively close/read it.
            const saved=(await checked(jobs,jobId,'read',{runReference})).job;
            const current=await readGalleryReviewMain(gh(github));
            if(!saved || saved.candidate?.itemIds.some(id=>!absent(current,id,[]))) {
                await cleanAll(saved||job,processing,promotion,true);return pending();
            }
            if(saved.candidate) {
                const evidence=await reconcileArchiveGalleryBatchReview(saved.candidate,{expectedBaseSha:saved.baseSha,...gh(github)});
                if(evidence.state==='merged-by-owner') {await cleanAll(saved,processing,promotion,true);return pending();}
                await settleUnmerged(context,saved,evidence);
            } else await cleanAll(saved,processing,promotion);
        } catch {await cleanAll(job,processing,promotion,true);}
        return pending(); // Unknown external writes retain the exact same run.
    }
}

// Publication is an owner grant on the SAME immutable review job/run, never a
// new claim, a merge capability or aggregate consent. Every member remains an
// independently checked original, generation, tag/consent and public item.
export async function runProtectedArchiveBatchPublication(context) {
    const {jobId,runReference,job,jobs,processing,promotion,github}=context;
    try {
        validate(context);
        if(job.publicationRequested!==true || !job.candidate || !job.review) return pending();
    } catch {return pending();}
    let main;
    try {main=await readGalleryReviewMain(gh(github));}
    catch {await cleanAll(job,processing,promotion,true);return pending();}
    const configuration={expectedBaseSha:job.baseSha,...gh(github)};
    let completionStarted=false,observationUncertain=false;
    try {
        if(job.reviewTerminal) {await cleanAll(job,processing,promotion,true);return pending();}
        // Recheck the protected source/consent/catalogue/exclusions and exact
        // approved byte receipts before either readiness or merge observation.
        await checkedItems(job,job.candidate,promotion);
        await checked(jobs,jobId,'batch-publication-check',{runReference});
        if(job.candidate.itemIds.some(id=>!absent(main,id,[]))) {
            const evidence=await readMergedGalleryBatchPublication(job.candidate,job.review,configuration);
            if(evidence.mainSha!==main.baseSha) return pending();
            if(!job.publicationEvidence) {
                observationUncertain=true;
                await checked(jobs,jobId,'batch-publication-observe',{runReference,evidence});
                observationUncertain=false;
            }
            await checkedItems(job,job.candidate,promotion);
            await checked(jobs,jobId,'batch-publication-check',{runReference});
            if((await readGalleryReviewMain(gh(github))).baseSha!==main.baseSha) return pending();
            const result={ok:true,state:'publication-observed',evidence,publicationEnabled:false};
            completionStarted=true;
            await checked(jobs,jobId,'complete',{runReference,result});
            return result;
        }
        if(main.baseSha!==job.baseSha) return pending();
        const review=await readExistingGalleryBatchReview(job.candidate,configuration);
        await checkedItems(job,job.candidate,promotion);
        await checked(jobs,jobId,'batch-publication-check',{runReference});
        if((await readGalleryReviewMain(gh(github))).baseSha!==main.baseSha) return pending();
        return {ok:true,state:'ready-for-separate-owner-merge',review,claimHeld:true,publicationEnabled:false};
    } catch {
        try {
            const current=(await checked(jobs,jobId,'read',{runReference})).job;
            // A lost completion reply must replay its durable terminal result,
            // never convert successfully observed publication into cleanup.
            if(current?.state==='publication-observed') return {ok:true,...current.result,replayed:true,publicationEnabled:false};
        } catch {if(completionStarted || observationUncertain) return pending();}
        // Neither a lost/in-flight completion nor an uncertain origin write
        // proves revocation. In particular, never delete after completion may
        // already have released the global claim successfully.
        if(completionStarted || observationUncertain) return pending();
        // Revocation can race the owner's separate merge. First positively
        // establish shared review history; never infer unmerged from an error
        // or delete unclosed potentially-published sources on a main outage.
        try {
            const evidence=await readMergedGalleryBatchMemberReview(job.candidate,job.review,job.candidate.itemIds[0],configuration);
            if(!job.publicationEvidence) await checked(jobs,jobId,'batch-publication-observe',{runReference,evidence});
        } catch {
            try {
                const evidence=await reconcileArchiveGalleryBatchReview(job.candidate,configuration);
                if(evidence.state==='merged-by-owner') {
                    if(!job.publicationEvidence) await checked(jobs,jobId,'batch-publication-observe',{runReference,evidence});
                } else {await settleUnmerged(context,job,evidence);return pending();}
            } catch {return pending();}
        }
        await cleanAll(job,processing,promotion);
        return pending(); // Independent host proof and main removal still due.
    }
}

export async function resumeProtectedArchiveBatchRemoval(context) {
    const {jobId,runReference,job,jobs,processing,promotion,github}=context;
    try {validate(context);} catch {return pending();}
    let main;
    try {main=await readGalleryReviewMain(gh(github));}
    catch {await cleanAll(job,processing,promotion,true);return pending();}
    try {
        // A review-only grant cannot silently retire separately owner-merged
        // photos. An explicitly granted publication retains this SAME claim
        // through post-merge revocation and each separate removal proposal.
        const present=job.candidate?.itemIds.some(id=>!absent(main,id,[]))===true;
        if(present && job.publicationRequested!==true) return pending();
        // Reconcile first: an owner merge can race our initial absent-main
        // snapshot. Empty listings with admitted POSTs remain wholly pending.
        let cleaned=false;
        if(job.candidate && !job.reviewTerminal && !job.publicationEvidence) {
            const evidence=await reconcileArchiveGalleryBatchReview(job.candidate,{expectedBaseSha:job.baseSha,...gh(github)});
            if(evidence.state==='merged-by-owner') {
                if(job.publicationRequested!==true) return pending();
                await checked(jobs,jobId,'batch-publication-observe',{runReference,evidence});
            } else {
                if(!await settleUnmerged(context,job,evidence)) return pending();
                cleaned=true;
            }
        }
        if(!cleaned && !await cleanAll(job,processing,promotion)) return pending();
        // Independent still-current host receipts are read through the normal
        // removal path. Its SQL cannot accept a member until shared PR terminal.
        const snapshotVerifier=async id=>({ok:true,value:{hostDeletionConfirmed:
            (await checked(promotion,id,'review')).hostDeletionConfirmed===true}});
        const completionMain=await readGalleryReviewMain(gh(github));
        for(const id of job.attempts) {
            const result=await resumeProtectedArchiveRemoval({attemptId:id,processing,promotion,verifier:snapshotVerifier,github});
            if(result?.ok===true && result.state==='unmerged-removal-review') return {...result,claimHeld:true};
            if(result?.ok!==true || result.state!=='removed' || result.mainSha!==completionMain.baseSha) return pending();
        }
        if((await readGalleryReviewMain(gh(github))).baseSha!==completionMain.baseSha) return pending();
        const result={ok:true,state:'removed',mainSha:completionMain.baseSha,publicationEnabled:false};
        await checked(jobs,jobId,'complete',{runReference,result});
        return result;
    } catch {return pending();}
}
