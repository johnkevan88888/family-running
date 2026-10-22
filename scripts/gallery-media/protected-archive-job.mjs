import {runProtectedArchiveReview,resumeProtectedArchiveRemoval} from './protected-archive-lifecycle.mjs';
import {runProtectedArchiveBatchReview,runProtectedArchiveBatchPublication,resumeProtectedArchiveBatchRemoval} from './protected-archive-batch.mjs';
import {readGalleryReviewMain,readExistingGalleryReview,readMergedGalleryReview,reconcileArchiveGalleryReview} from './github-review-client.mjs';
const pending=()=>({ok:false,state:'pending',publicationEnabled:false});
async function checked(service,id,operation,value) {
    if(typeof service!=='function') throw new Error('Unavailable');
    const result=await service(id,operation,value);if(result?.ok!==true) throw new Error('Unavailable');return result.value;
}
const options=github=>({token:github.token,fetchImpl:github.fetchImpl});
// Each phase receives ONLY its environment's transports. No cross-environment
// credential transfer, automatic dispatch, merge, default fetch or bucket I/O.
export async function runProtectedArchiveJob({jobId,runReference,phase,jobs,processing,promotion,verifier,finalizer,github,reportFailure}) {
    try {
        if(!['review','cleanup','verify','reconcile','finalize','publication','purge'].includes(phase)) return pending();
        const response=await checked(jobs,jobId,['verify','finalize'].includes(phase)?'read':'claim',{runReference});
        if(response.state==='private-records-purged') return response;
        const job=response.job;
        if(!job || job.jobId!==jobId || job.runReference!==runReference || !Array.isArray(job.attempts)) return pending();
        const complete=async result=>{
            await checked(jobs,jobId,'complete',{runReference,result});return result;
        };
        const snapshotVerifier=async attemptId=>({ok:true,value:{hostDeletionConfirmed:(await checked(promotion,attemptId,'review')).hostDeletionConfirmed===true}});
        if(!['running','queued'].includes(job.state) && !['verify','finalize'].includes(phase))
            return {ok:true,...job.result,replayed:true,publicationEnabled:false};
        if(job.action==='batch-review') {
            const context={jobId,runReference,job,jobs,processing,promotion,github,reportFailure};
            if(phase==='review' || phase==='publication') return job.publicationRequested===true?
                runProtectedArchiveBatchPublication(context):phase==='review'?runProtectedArchiveBatchReview(context):pending();
            if(phase==='verify') {
                for(const id of job.attempts) if((await checked(verifier,id,'verify')).hostDeletionConfirmed!==true) return pending();
                return {ok:true,state:'host-ready',publicationEnabled:false};
            }
            if(phase==='reconcile') return resumeProtectedArchiveBatchRemoval(context);
            // Shared recovery never deletes originals or purges. A pending
            // owner removal PR keeps the original global batch claim held.
            if(phase==='finalize') return {ok:true,state:job.state==='removed'?'hidden-original-retained':'awaiting-owner-removal-review',publicationEnabled:false};
            return pending();
        }
        if(phase==='review') {
            if(job.action!=='review' || !job.attemptId) return pending();
            const result=await runProtectedArchiveReview({attemptId:job.attemptId,processing,promotion,github,reportFailure});
            return result.ok?await complete(result):result; // Unknown writes keep the durable claim.
        }
        if(['cleanup','verify','reconcile','finalize'].includes(phase)) {
            if(!['review','removal'].includes(job.action)) return pending();
            if(phase==='cleanup') {
                for(const attemptId of job.attempts) for(const service of [processing,promotion]) {
                    await checked(service,attemptId,'close');await checked(service,attemptId,'cleanup');
                }
                return {ok:true,state:'cleanup-ready',publicationEnabled:false};
            }
            if(phase==='verify') {
                for(const attemptId of job.attempts) if((await checked(verifier,attemptId,'verify')).hostDeletionConfirmed!==true) return pending();
                return {ok:true,state:'host-ready',publicationEnabled:false};
            }
            if(phase==='finalize') {
                if(job.state!=='removed') return {ok:true,state:'awaiting-owner-removal-review',publicationEnabled:false};
                if(job.deletionRequested) {
                    if(typeof finalizer!=='function' || (await finalizer(job.assetId))?.ok!==true) return pending();
                }
                return {ok:true,state:job.deletionRequested?'private-original-deleted':'hidden-original-retained',publicationEnabled:false};
            }
            for(const attemptId of job.attempts) {
                const result=await resumeProtectedArchiveRemoval({attemptId,processing,promotion,verifier:snapshotVerifier,github});
                if(!result.ok) return result;
                if(result.state==='unmerged-removal-review') return await complete(result);
            }
            return await complete({ok:true,state:'removed',publicationEnabled:false});
        }
        if(phase==='publication') {
            if(job.action!=='publication' || !job.attemptId) return pending();
            const saved=await checked(promotion,job.attemptId,'review');
            if(!saved.review || !saved.candidate) return pending();
            try {
                await checked(promotion,job.attemptId,'candidate');
                const main=await readGalleryReviewMain(options(github));
                if(main.manifestsBySite[saved.site].items.some(i=>i.id===saved.candidate.itemId)) {
                    const item=JSON.parse(saved.candidate.manifestText).items.find(i=>i.id===saved.candidate.itemId);
                    if(JSON.stringify(main.manifestsBySite[saved.site].items.find(i=>i.id===item.id))!==JSON.stringify(item) ||
                        main.manifestsBySite[saved.site==='family'?'everyone':'family'].items.some(row=>row.id===item.id ||
                            ['sourceUrl','thumbnailUrl','posterUrl'].some(field=>[item.sourceUrl,item.thumbnailUrl].includes(row[field])))) throw new Error('Changed publication');
                    const evidence=await readMergedGalleryReview(saved.candidate,saved.review,{expectedBaseSha:saved.baseSha,...options(github)});
                    await checked(promotion,job.attemptId,'candidate');
                    if(evidence.mainSha!==main.baseSha || (await readGalleryReviewMain(options(github))).baseSha!==main.baseSha) return pending();
                    return await complete({ok:true,state:'publication-observed',evidence,publicationEnabled:false});
                }
                if(main.baseSha!==saved.baseSha || saved.historical.some(i=>!i.removed || ['family','everyone'].some(site=>main.manifestsBySite[site].items.some(row=>
                    row.id===i.itemId || ['sourceUrl','thumbnailUrl','posterUrl'].some(field=>i.urls.includes(row[field])))))) return pending();
                const review=await readExistingGalleryReview(saved.candidate,{expectedBaseSha:saved.baseSha,...options(github)});
                await checked(promotion,job.attemptId,'candidate');
                if((await readGalleryReviewMain(options(github))).baseSha!==main.baseSha) return pending();
                // NOT a merge. Keep publication's slot until the owner merges
                // separately and reruns this SAME protected run, or revocation
                // is positively reconciled. Purge cannot acquire it meanwhile.
                return {ok:true,state:'ready-for-separate-owner-merge',review,claimHeld:true,publicationEnabled:false};
            } catch {
                for(const service of [processing,promotion]) {
                    await checked(service,job.attemptId,'close');await checked(service,job.attemptId,'cleanup');
                }
                const evidence=await reconcileArchiveGalleryReview(saved.candidate,{expectedBaseSha:saved.baseSha,...options(github),kind:'addition'});
                await checked(promotion,job.attemptId,'review-terminal',{kind:'addition',baseSha:saved.baseSha,evidence});
                return await complete({ok:true,state:'publication-revoked',publicationEnabled:false});
            }
        }
        if(!['purge-inspect','purge'].includes(job.action)) return pending();
        const main=await readGalleryReviewMain(options(github));
        const inspected=await checked(jobs,jobId,'purge-inspect',{runReference,main});
        if(job.action==='purge-inspect') return await complete(inspected);
        if(inspected.proofHash!==job.expectedProofHash) return pending();
        const current=await readGalleryReviewMain(options(github));
        if(JSON.stringify(current)!==JSON.stringify(main)) return pending();
        return await checked(jobs,jobId,'purge',{runReference,main:current}); // Atomic purge retires the job too.
    } catch {return pending();}
}
