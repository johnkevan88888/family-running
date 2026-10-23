import {readGalleryReviewMain} from './github-review-client.mjs';
import {readExistingGalleryBatchReview,readMergedGalleryBatchPublication} from './github-batch-review-client.mjs';
import {batchPublicationStep} from './archive-diagnostics.mjs';

const repository='johnkevan88888/family-running';
const prefix=`https://api.github.com/repos/${repository}/`;
const jobPattern=/^job_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const attemptPattern=/^attempt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const assetPattern=/^asset_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const runPattern=/^https:\/\/github\.com\/johnkevan88888\/family-running\/actions\/runs\/[1-9][0-9]*$/;
const sha=/^[0-9a-f]{40}$/;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const identity=({state,result,publicationEvidence,...job})=>job;

// Current code, original held identity. There is deliberately no claim,
// processing, cleanup, original, purge, consent-writing or GitHub-writing
// operation. A failed check preserves the job for explicit recovery; it is
// never interpreted as permission to close a review or remove a photograph.
export async function runProtectedBatchPublication({jobId,runReference,phase,expectedBaseSha,jobs,promotion,github,reportFailure}) {
    const step=batchPublicationStep(reportFailure);
    await step('job-configuration',async()=>{
        if(!jobPattern.test(jobId||'') || !runPattern.test(runReference||'') || !['prepare','observe'].includes(phase) ||
            !sha.test(expectedBaseSha||'') || typeof jobs!=='function' || typeof promotion!=='function' ||
            typeof github?.fetchImpl!=='function' || typeof github.token!=='string' || !github.token ||
            reportFailure!==undefined && typeof reportFailure!=='function') throw new Error('Protected continuation configuration required.');
    });
    const fetchImpl=async(url,input)=>{
        if(typeof url!=='string' || !url.startsWith(prefix) || new URL(url).origin!=='https://api.github.com' || input?.method!=='GET')
            throw new Error('Read-only repository access required.');
        return github.fetchImpl(url,input);
    };
    const gh={token:github.token,fetchImpl};
    let saved;
    const read=async()=>{
        const response=await step('job-read',async()=>{
            const response=await jobs(jobId,'read',{runReference:saved?.runReference||runReference});
            if(response?.ok!==true) throw new Error('Protected job unavailable.');return response;
        });
        return step('job-evidence',async()=>{
            const job=response.value?.job;
            if(job?.jobId!==jobId || job.action!=='batch-review' || !['running','publication-observed'].includes(job.state) ||
                job.state==='publication-observed' && phase!=='observe' || !runPattern.test(job.runReference||'') ||
                job.runReference===runReference || !['family','everyone'].includes(job.site) || job.publicationRequested!==true ||
                phase==='prepare' && job.publicationEvidence ||
                job.reviewTerminal!==false || job.terminalEvidence || job.writeAdmitted!==true ||
                !sha.test(job.baseSha||'') || !job.candidate || !job.review || job.review.baseSha!==job.baseSha ||
                job.candidate.targetRelativePath!==`gallery-data/${job.site}.json` ||
                !Array.isArray(job.attempts) || job.attempts.length<1 || job.attempts.length>20 ||
                new Set(job.attempts).size!==job.attempts.length || job.attempts.some(id=>!attemptPattern.test(id)) ||
                !Array.isArray(job.members) || job.members.length!==job.attempts.length ||
                new Set(job.members.map(m=>m.assetId)).size!==job.members.length ||
                job.members.some((m,i)=>m.attemptId!==job.attempts[i] || !assetPattern.test(m.assetId||'') || m.closed!==false) ||
                job.state==='running' && job.result || job.state==='publication-observed' &&
                (job.result?.state!=='publication-observed' || job.result.publicationEnabled!==false ||
                    !job.publicationEvidence || !same(job.result.evidence,job.publicationEvidence)))
                throw new Error('Exact owner-granted held batch required.');
            if(saved && !same(identity(job),identity(saved))) throw new Error('Immutable batch identity changed.');
            saved??=structuredClone(job);return job;
        });
    };
    await read();
    const configuration={expectedBaseSha:saved.baseSha,...gh};
    const main=()=>step('main-ref',async()=>{
        const current=await readGalleryReviewMain(gh);
        if(current.baseSha!==expectedBaseSha) throw new Error('Current main changed.');return current;
    });
    const pull=()=>step('review-head',async()=>{
        const number=saved.review.pullRequest?.number;
        if(!Number.isSafeInteger(number) || number<1) throw new Error('Exact review required.');
        const response=await fetchImpl(`${prefix}pulls/${number}`,{method:'GET',redirect:'error',headers:{
            Authorization:`Bearer ${gh.token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}});
        if(!response.ok) throw new Error('Review unavailable.');
        const value=await response.json();
        if(value.number!==number || value.html_url!==saved.review.pullRequest.url || value.head?.ref!==saved.review.branchRef ||
            value.head?.repo?.full_name!==repository || value.base?.ref!=='main' || value.base?.repo?.full_name!==repository ||
            !sha.test(value.head.sha||'') || value.draft!==false ||
            (phase==='prepare'?value.state!=='open' || value.merged_at!==null:value.state!=='closed' || !value.merged_at))
            throw new Error('Review phase or identity changed.');
        return value.head.sha;
    });
    const snapshot=await main(),headSha=await pull();
    await step('phase-boundary',async()=>{
        const present=saved.candidate.itemIds?.some(id=>['family','everyone'].some(site=>snapshot.manifestsBySite[site].items.some(item=>item.id===id)));
        if(typeof present!=='boolean' || (phase==='prepare'?present || saved.publicationEvidence:!present))
            throw new Error('Separate owner merge phase required.');
    });
    const checked=async()=>{
        const job=await read();
        const document=await step('candidate-evidence',async()=>{
            const value=JSON.parse(job.candidate.manifestText);
            if(!Array.isArray(job.candidate.itemIds) || job.candidate.itemIds.length!==job.attempts.length ||
                new Set(job.candidate.itemIds).size!==job.attempts.length || !Array.isArray(value.items))
                throw new Error('Exact member manifest required.');return value;
        });
        for(const [index,id] of job.attempts.entries()) await step('photo-eligibility',async()=>{
            // Existing service rechecks current permission, exclusions, tags,
            // catalogue, framing and the actual approved/staged byte receipts.
            const result=await promotion(id,'candidate');
            if(result?.ok!==true || result.value?.site!==job.site || result.value.item?.id!==job.candidate.itemIds[index] ||
                !same(document.items.find(item=>item.id===result.value.item.id),result.value.item))
                throw new Error('Photo is no longer exactly eligible.');
        },index+1,job.attempts.length);
        await read();
        await step('publication-check',async()=>{
            const response=await jobs(jobId,'batch-publication-check',{runReference:saved.runReference});
            if(response?.ok!==true || response.value?.state!=='ready-for-owner-merge' || response.value.claimHeld!==true ||
                response.value.publicationEnabled!==false) throw new Error('Owner grant or member eligibility changed.');
        });
        await read();
    };
    const receipt=(state,replayed=false)=>({ok:true,state,phase,executionRunReference:runReference,originalRunReference:saved.runReference,
        baseSha:expectedBaseSha,checkedHeadSha:headSha,pullRequest:saved.review.pullRequest.number,
        reviewUrl:saved.review.pullRequest.url,replayed,claimHeld:state!=='publication-observed',publicationEnabled:false});
    const stable=async()=>{
        await read();await main();
        await step('review-head',async()=>{if(await pull()!==headSha) throw new Error('Review head changed.');});
    };
    if(phase==='prepare') {
        await checked();
        await step('review-history',()=>readExistingGalleryBatchReview(saved.candidate,configuration,saved.review));
        await checked();await stable();
        return receipt('ready-for-separate-owner-merge');
    }
    const evidence=await step('review-history',()=>readMergedGalleryBatchPublication(saved.candidate,saved.review,configuration));
    await step('phase-boundary',async()=>{
        if(evidence.mainSha!==expectedBaseSha || saved.publicationEvidence && !same(evidence,saved.publicationEvidence))
            throw new Error('Exact owner-merged evidence required.');
    });
    // A lost completion reply may already have released the held claim. Read
    // its exact durable receipt, not the mutation/check endpoints, on replay.
    if(saved.state==='publication-observed') {await stable();return receipt('publication-observed',true);}
    await checked();await stable();
    if(!saved.publicationEvidence) await step('publication-observe',async()=>{
        const response=await jobs(jobId,'batch-publication-observe',{runReference:saved.runReference,evidence});
        if(response?.ok!==true || response.value?.state!=='publication-origin-recorded' || response.value.publicationEnabled!==false)
            throw new Error('Observation unavailable; preserve the held job.');
    });
    await checked();await stable();
    const result={ok:true,state:'publication-observed',evidence,publicationEnabled:false};
    await step('publication-complete',async()=>{
        // Never retry an uncertain write in this run. The authenticated durable
        // read below distinguishes success with a lost reply from pending work.
        try {await jobs(jobId,'complete',{runReference:saved.runReference,result});} catch { /* Read back exact receipt. */ }
    });
    await step('completion-readback',async()=>{
        const current=await read();
        if(current.state!=='publication-observed' || !same(current.result.evidence,evidence))
            throw new Error('Completion not confirmed; preserve the held job.');
    });
    return receipt('publication-observed');
}
