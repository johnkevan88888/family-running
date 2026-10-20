import {processGalleryPhoto} from './processor.mjs';
import {assertPhotoFramingSource} from './photo-framing-source.mjs';
import {readGalleryReviewMain,createOrReconcileArchiveGalleryReview,createOrReconcileArchiveGalleryRemoval,readExistingGalleryReview,
    reconcileArchiveGalleryReview} from './github-review-client.mjs';

// Explicit authenticated transports only. No credential discovery, ambient
// fetch, dispatch, merge, publication, bucket access or legacy draft replay.
const opaque=/^attempt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const gh=github=>({token:github.token,fetchImpl:github.fetchImpl});
const uses=(item,id,urls)=>item.id===id || ['sourceUrl','thumbnailUrl','posterUrl'].some(field=>urls.includes(item[field]));
const absent=(main,id,urls)=>['family','everyone'].every(site=>!main.manifestsBySite[site].items.some(item=>uses(item,id,urls)));
const pending=()=>({ok:false,state:'pending',publicationEnabled:false});
function input(attemptId,...services) {
    if(!opaque.test(attemptId||'') || services.some(service=>typeof service!=='function')) throw new Error('Unavailable');
}
async function checked(service,attemptId,operation,value) {
    const result=await service(attemptId,operation,value);
    if(!result || result.ok!==true) throw new Error('Unavailable');
    return result.value;
}

export async function runProtectedArchiveReview({attemptId,processing,promotion,github}) {
    input(attemptId,processing,promotion);
    let saved;
    try {
        saved=await checked(promotion,attemptId,'review');
        const main=await readGalleryReviewMain(gh(github));
        if(saved.historical.some(old=>!old.removed || !absent(main,old.itemId,old.urls))) return pending();
        if(saved.reviewTerminal) return pending();
        // A repeated review job is not authority to remove an owner-published
        // photo. Existing publication is a separate reconciliation gate.
        if(saved.candidate && !absent(main,saved.candidate.itemId,[])) return {ok:false,state:'already-published',publicationEnabled:false};
        if(saved.state!=='prepared') {
            const admission=await checked(processing,attemptId,'start');
            const source=await checked(processing,attemptId,'original');
            const processed=await processGalleryPhoto({sourceBytes:Buffer.from(source.bytes),fileExtension:source.mimeType==='image/jpeg'?'jpg':'png',
                declaredMimeType:source.mimeType,expectedSha256:source.sha256,
                draftBinding:{site:saved.site,draftId:`draft_${attemptId.slice(8)}`,processingRunId:`run_${attemptId.slice(8).replaceAll('-','')}`}});
            assertPhotoFramingSource(admission.framingSource,processed.source);
            for(const derivative of processed.derivatives) await checked(processing,attemptId,derivative.storageRole,
                {bytes:await derivative.payload.arrayBuffer(),toolchain:processed.toolchain});
            await checked(promotion,attemptId,'promote');
            saved={...saved,...await checked(promotion,attemptId,'review-reserve',await readGalleryReviewMain(gh(github)))};
        }
        const item=(await checked(promotion,attemptId,'candidate')).item;
        if(JSON.stringify(JSON.parse(saved.candidate.manifestText).items.find(i=>i.id===saved.candidate.itemId))!==JSON.stringify(item)) throw new Error('Changed');
        const options={expectedBaseSha:saved.baseSha,...gh(github)};
        const review=saved.review?await readExistingGalleryReview(saved.candidate,options):await createOrReconcileArchiveGalleryReview(saved.candidate,
            {...options,admitPullRequest:()=>checked(promotion,attemptId,'review-write',{kind:'addition',baseSha:saved.baseSha})});
        await checked(promotion,attemptId,'review-open',{review});
        await checked(promotion,attemptId,'candidate');
        return {ok:true,state:'unmerged-review',review,publicationEnabled:false};
    } catch {
        // Each tier can close and clean independently, even when the other
        // service or GitHub is unavailable. Host completion stays separate.
        await Promise.allSettled([processing,promotion].map(async service=>{
            await checked(service,attemptId,'close');await checked(service,attemptId,'cleanup');
        }));
        return pending();
    }
}

// Finalization transports are passed separately, never copied into the review
// environment. Completed storage, review and still-current host receipts replay
// as reads. A manifest removal proposal is not silently merged by this runner.
export async function resumeProtectedArchiveRemoval({attemptId,processing,promotion,verifier,github}) {
    input(attemptId,processing,promotion,verifier);
    try {
        const cleanup=await Promise.allSettled([processing,promotion].map(async service=>{
            await checked(service,attemptId,'close');return checked(service,attemptId,'cleanup');
        }));
        if(cleanup.some(result=>result.status!=='fulfilled')) return pending();
        const host=await checked(verifier,attemptId,'verify');
        if(host.hostDeletionConfirmed!==true) return pending();
        const saved=await checked(promotion,attemptId,'review');
        if(saved.candidate && !saved.reviewTerminal) {
            const evidence=await reconcileArchiveGalleryReview(saved.candidate,{expectedBaseSha:saved.baseSha,...gh(github),kind:'addition'});
            await checked(promotion,attemptId,'review-terminal',{kind:'addition',baseSha:saved.baseSha,evidence});
        }
        const main=await readGalleryReviewMain(gh(github));
        const id=saved.candidate?.itemId;
        if(id && !absent(main,id,[])) {
            const {baseSha,removal}=await checked(promotion,attemptId,'removal-reserve',main);
            const review=await createOrReconcileArchiveGalleryRemoval(removal,{expectedBaseSha:baseSha,...gh(github),
                admitPullRequest:()=>checked(promotion,attemptId,'review-write',{kind:'removal',baseSha})});
            await checked(promotion,attemptId,'removal-open',{baseSha,review});
            return {ok:true,state:'unmerged-removal-review',completed:false,review,hostDeletionConfirmed:true,publicationEnabled:false};
        }
        // A main removal does not settle its PRs. Close obsolete unmerged
        // proposals, or verify the owner's exact merged bytes/ancestry first.
        for(const old of saved.removals) if(!old.terminal) {
            const evidence=await reconcileArchiveGalleryReview(old.removal,{expectedBaseSha:old.baseSha,...gh(github),kind:'removal'});
            await checked(promotion,attemptId,'review-terminal',{kind:'removal',baseSha:old.baseSha,evidence});
        }
        await checked(promotion,attemptId,'manifest-absence',main);
        if((await readGalleryReviewMain(gh(github))).baseSha!==main.baseSha) return pending();
        return {ok:true,state:'removed',hostDeletionConfirmed:true,mainSha:main.baseSha,publicationEnabled:false};
    } catch {return pending();}
}
