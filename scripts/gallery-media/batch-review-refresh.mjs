import {refreshStoredGalleryBatchReview} from './github-batch-review-client.mjs';

const jobPattern=/^job_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const attemptPattern=/^attempt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const assetPattern=/^asset_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const runPattern=/^https:\/\/github\.com\/johnkevan88888\/family-running\/actions\/runs\/[1-9][0-9]*$/;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

// A separate protected refresh reads an already-held job; it cannot claim or
// transfer it. Only read and candidate operations are exposed here. In
// particular no original, process, promote, consent, complete or purge call.
export async function runProtectedBatchReviewRefresh({jobId,runReference,expectedBaseSha,jobs,promotion,github}) {
    if(!jobPattern.test(jobId||'') || !runPattern.test(runReference||'') || !/^[0-9a-f]{40}$/.test(expectedBaseSha||'') ||
        typeof jobs!=='function' || typeof promotion!=='function' || !github) throw new Error('Protected batch refresh configuration required.');
    let saved;
    const read=async()=>{
        const response=await jobs(jobId,'read',{runReference});
        const job=response?.value?.job;
        if(response?.ok!==true || job?.jobId!==jobId || job.action!=='batch-review' || job.state!=='running' ||
            !runPattern.test(job.runReference||'') || !['family','everyone'].includes(job.site) ||
            job.reviewTerminal!==false || job.writeAdmitted!==true || job.publicationRequested!==false ||
            job.publicationEvidence || job.result || !job.candidate || !job.review ||
            !Array.isArray(job.attempts) || job.attempts.length<1 || job.attempts.length>20 ||
            new Set(job.attempts).size!==job.attempts.length || job.attempts.some(id=>!attemptPattern.test(id)) ||
            !Array.isArray(job.members) || job.members.length!==job.attempts.length ||
            new Set(job.members.map(member=>member.assetId)).size!==job.members.length ||
            job.members.some((member,index)=>member.attemptId!==job.attempts[index] || !assetPattern.test(member.assetId||'') || member.closed!==false) ||
            job.review.baseSha!==job.baseSha || job.candidate.targetRelativePath!==`gallery-data/${job.site}.json`)
            throw new Error('Exact open, unclaimed-for-publication batch review required.');
        if(saved && !same(job,saved)) throw new Error('Protected batch evidence changed during refresh.');
        saved??=structuredClone(job);return job;
    };
    const readEligibleCandidate=async()=>{
        const job=await read(),document=JSON.parse(job.candidate.manifestText);
        if(job.candidate.itemIds.length!==job.attempts.length) throw new Error('Changed batch membership.');
        for(const [index,id] of job.attempts.entries()) {
            // Existing service performs actual-byte, complete-tag, consent,
            // current catalogue/exclusion and exact framing checks afresh.
            const response=await promotion(id,'candidate');
            const item=response?.value?.item;
            if(response?.ok!==true || response.value.site!==job.site || item?.id!==job.candidate.itemIds[index] ||
                !same(document.items.find(row=>row.id===item.id),item)) throw new Error('Batch photo is no longer exactly eligible.');
        }
        await read();return structuredClone(job.candidate);
    };
    const candidate=await readEligibleCandidate();
    return refreshStoredGalleryBatchReview(candidate,saved.review,{expectedBaseSha,token:github.token,fetchImpl:github.fetchImpl,readEligibleCandidate});
}
