import assert from 'node:assert/strict';
import sharp from 'sharp';
import {reservePrivateGalleryAsset} from '../../gallery-admin/src/private-gallery-asset-service.js';
import {reservePrivateGalleryAttempt} from '../../gallery-admin/src/private-gallery-attempt-service.js';
import {preparePrivateArchiveIntake,storePrivateArchiveOriginal} from '../../gallery-admin/src/private-archive-service.js';
import {readPrivateGalleryRoster} from '../../gallery-admin/src/private-gallery-roster-service.js';
import {readPrivateGalleryAssetEligibility} from '../../gallery-admin/src/private-gallery-visibility-service.js';
import {readBoundedBytes,sha256Hex} from '../../gallery-admin/src/media-byte-verification.js';

// Actual protected storage/consent services, invented metadata and generated
// pixels only. No real media, ambient fetch or external mutation.
export async function addSyntheticBatchMember(f,{owner=f.owner,site=f.site,personIds=f.ids,color='#3469ab'}={}) {
    const rosterRevision=(await readPrivateGalleryRoster(f.env,site)).revision;
    const asset=await reservePrivateGalleryAsset(f.env,owner,site,{idempotencyKey:crypto.randomUUID(),rosterRevision,personIds,originalFormat:'jpg'});
    assert.equal(asset.ok,true,JSON.stringify(asset));const assetId=asset.asset.assetId;
    const photo=await sharp({create:{width:32,height:48,channels:3,background:color}}).withExif({IFD0:{Make:'private-synthetic-camera'}}).jpeg().toBuffer();
    assert.equal((await preparePrivateArchiveIntake(f.env,owner,site,assetId,{rosterRevision,byteCount:photo.length,sha256:await sha256Hex(photo),
        declaredMimeType:'image/jpeg',privateRetentionConfirmed:true,containsMinors:false,guardianApprovalConfirmed:false})).ok,true);
    assert.equal((await storePrivateArchiveOriginal(f.env,owner,site,assetId,new Blob([photo]).stream(),{
        digestReadable:async body=>sha256Hex(await readBoundedBytes(body,photo.length))})).ok,true);
    const eligibility=await readPrivateGalleryAssetEligibility(f.env,owner,site,assetId,f.catalog);
    const consent={...f.consent,idempotencyKey:crypto.randomUUID(),eligibilityRevision:eligibility.revision};
    const reserved=await reservePrivateGalleryAttempt(f.env,owner,site,assetId,consent,f.catalog);
    assert.equal(reserved.ok,true,JSON.stringify(reserved));return {assetId,attemptId:reserved.attemptId,photo,owner,site,consent};
}
