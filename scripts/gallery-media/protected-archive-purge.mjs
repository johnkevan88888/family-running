import {readGalleryReviewMain} from './github-review-client.mjs';
import {inspectPrivateArchivePurge,purgePrivateArchiveMetadata} from '../../gallery-admin/src/private-gallery-retention-service.js';

// Internal library only: no CLI, Actions entry point, credential discovery or
// live owner route. The caller must authenticate owner/CSRF and serialize with
// publication. GitHub and D1 cannot share a transaction; these two fixed-repo
// reads detect intervening main changes, not a live cross-system lock.
export async function runProtectedArchivePurge({env,identity,site,assetId,github,input,dryRun=true}) {
    const pending=()=>({ok:false,state:'pending',publicationEnabled:false});
    try {
        if(!dryRun) {
            // A completed receipt needs no GitHub/storage/host retry.
            const replay=await purgePrivateArchiveMetadata(env,identity,site,assetId,{...input,main:null});
            if(replay.ok) return replay;
        }
        const options={token:github.token,fetchImpl:github.fetchImpl};
        const main=await readGalleryReviewMain(options);
        const inspected=await inspectPrivateArchivePurge(env,identity,site,assetId,main);
        if(!inspected.ok || dryRun) return inspected;
        if(inspected.proofHash!==input?.expectedProofHash) return pending();
        const current=await readGalleryReviewMain(options);
        if(JSON.stringify(current)!==JSON.stringify(main)) return pending();
        return purgePrivateArchiveMetadata(env,identity,site,assetId,{...input,main:current});
    } catch {return pending();}
}
