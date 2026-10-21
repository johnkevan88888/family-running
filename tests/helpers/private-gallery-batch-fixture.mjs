import assert from 'node:assert/strict';
import sharp from 'sharp';
import {archiveServiceFixture} from './private-gallery-service-fixture.mjs';
import {privateGalleryJobFixture} from './private-gallery-job-fixture.mjs';
import {syntheticGitHub,digest} from './private-gallery-lifecycle-fixtures.mjs';
import {readPrivateGalleryRoster} from '../../gallery-admin/src/private-gallery-roster-service.js';
import {reservePrivateGalleryAsset} from '../../gallery-admin/src/private-gallery-asset-service.js';
import {reservePrivateGalleryAttempt} from '../../gallery-admin/src/private-gallery-attempt-service.js';
import {changePrivateGalleryVisibility,readPrivateGalleryAssetEligibility} from '../../gallery-admin/src/private-gallery-visibility-service.js';
import {preparePrivateArchiveIntake,storePrivateArchiveOriginal} from '../../gallery-admin/src/private-archive-service.js';
import {savePrivateGalleryFraming} from '../../gallery-admin/src/private-gallery-framing-service.js';
import {readBoundedBytes,sha256Hex} from '../../gallery-admin/src/media-byte-verification.js';
import {queuePrivateArchiveBatch} from '../../gallery-admin/src/private-gallery-batch-service.js';

export const batchRun='https://github.com/johnkevan88888/family-running/actions/runs/456';
export async function privateGalleryBatchFixture(site='family',{small=false}={}) {
    // The fixed production-shaped origin is only an in-memory HTTP route. No
    // network transport is supplied anywhere in this fixture.
    const [width,height]=small?[32,48]:[512,768];
    const firstPhoto=await sharp({create:{width,height,channels:3,background:'#7ab341'}})
        .withExif({IFD0:{Make:'private-first-camera'}}).jpeg().toBuffer();
    const f=await archiveServiceFixture(site,{reserveAttempt:false,photoBytes:firstPhoto,
        mediaOrigin:'https://family-running-gallery-media-dev.family-running.workers.dev'});
    const secondPerson='person_00000000-0000-4000-8000-000000000003';
    f.db.prepare('INSERT INTO private_gallery_people VALUES(?,?,?,?,?)').run(secondPerson,'Fictitious second runner','fixture-public-second',1,1);
    assert.equal((await changePrivateGalleryVisibility(f.env,f.owner,site,secondPerson,
        {expectedVersion:1,idempotencyKey:crypto.randomUUID(),preference:'allowed'})).ok,true);
    for(const area of ['family','everyone']) f.catalog.sites[area].catalog.athleteIds.push('fixture-public-second');
    const roster=(await readPrivateGalleryRoster(f.env,site)).revision;
    const other=await reservePrivateGalleryAsset(f.env,f.owner,site,{idempotencyKey:crypto.randomUUID(),rosterRevision:roster,
        personIds:[secondPerson],originalFormat:'jpg'});assert.equal(other.ok,true);
    const otherId=other.asset.assetId,photo=await sharp({create:{width:height,height:width,channels:3,background:'#3a62bc'}})
        .withExif({IFD0:{Make:'private-second-camera'}}).jpeg().toBuffer();
    assert.equal((await preparePrivateArchiveIntake(f.env,f.owner,site,otherId,{rosterRevision:roster,byteCount:photo.length,sha256:digest(photo),
        declaredMimeType:'image/jpeg',privateRetentionConfirmed:true,containsMinors:false,guardianApprovalConfirmed:false})).ok,true);
    assert.equal((await storePrivateArchiveOriginal(f.env,f.owner,site,otherId,new Blob([photo]).stream(),{
        digestReadable:async body=>sha256Hex(await readBoundedBytes(body,photo.length))})).ok,true);
    const members=[];
    for(const [index,assetId,personIds,bytes,imageWidth,imageHeight] of [[0,f.assetId,f.ids,f.photo,width,height],[1,otherId,[secondPerson],photo,height,width]]) {
        const frames=Object.fromEntries(personIds.map((id,i)=>[id,{x:index?70:25+i*40,y:index?60:20+i*30,zoom:2+index}]));
        const saved=await savePrivateGalleryFraming(f.env,f.owner,site,assetId,{idempotencyKey:crypto.randomUUID(),expectedVersion:0,tagVersion:1,
            confirmed:true,sourceSha256:digest(bytes),orientation:'exif-transposed-v1',imageWidth,imageHeight,frames});assert.equal(saved.ok,true);
        const consent={...f.consent,idempotencyKey:crypto.randomUUID(),framingVersion:saved.version,
            eligibilityRevision:(await readPrivateGalleryAssetEligibility(f.env,f.owner,site,assetId,f.catalog)).revision};
        const attempt=await reservePrivateGalleryAttempt(f.env,f.owner,site,assetId,consent,f.catalog);assert.equal(attempt.ok,true);
        members.push({assetId,attemptId:attempt.attemptId,frames,personIds});
    }
    f.attemptId=members[0].attemptId;
    const c=await privateGalleryJobFixture(f),github=syntheticGitHub();
    const queueInput={attemptIds:members.map(member=>member.attemptId),idempotencyKey:crypto.randomUUID()};
    const queued=await queuePrivateArchiveBatch(f.env,f.owner,site,queueInput);assert.equal(queued.ok,true,JSON.stringify(queued));
    return {...f,c,github,members,jobId:queued.job.jobId,queueInput};
}
