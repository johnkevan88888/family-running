import assert from 'node:assert/strict';
import {archiveServiceFixture} from './helpers/private-gallery-service-fixture.mjs';
import {handleArchiveServiceRequest} from '../gallery-admin/src/private-gallery-service-adapter.js';
import {issueArchiveServiceAuthority} from '../gallery-admin/src/private-gallery-service-authority.js';
import {readArchivePhotoAttempt,storeArchivePhotoDerivative,readArchivePhotoSource} from '../gallery-admin/src/private-gallery-photo-lifecycle.js';
import {reservePrivateGalleryAttempt} from '../gallery-admin/src/private-gallery-attempt-service.js';
import {processGalleryPhoto} from '../scripts/gallery-media/processor.mjs';
import {handleProcessingRequest} from '../gallery-admin/src/processing-worker.js';
import {handlePromotionRequest} from '../gallery-admin/src/promotion-worker.js';
import {handlePublicHostVerifierRequest} from '../gallery-admin/src/public-host-verifier-worker.js';
import * as delivery from '../gallery-admin/src/media-delivery-contract.js';
import {syntheticGitHub} from './helpers/private-gallery-lifecycle-fixtures.mjs';
import {readGalleryReviewMain,createOrReconcileGalleryReview,invalidateGalleryReview} from '../scripts/gallery-media/github-review-client.mjs';
import {hashIdentity} from '../gallery-admin/src/session.js';
import {handleWithdrawalFinalizerRequest} from '../gallery-admin/src/withdrawal-finalizer-worker.js';

for(const site of ['family','everyone']) {
    const f=await archiveServiceFixture(site),{env,db,attemptId}=f;
    const subject='1'.repeat(32)+'.access',identity={type:'service',subject};
    const configs={processing:{PROCESSOR_IDENTITIES:`subject:${subject}`,PROCESSING_ORIGIN:'https://synthetic-processing.example',PRIVATE_ORIGINALS:f.original,DERIVATIVE_STAGING:f.staging},
        promotion:{PROMOTER_IDENTITIES:`subject:${subject}`,PROMOTION_ORIGIN:'https://synthetic-promotion.example',APPROVED_MEDIA:f.approved,DERIVATIVE_STAGING:f.staging},
        verifier:{PUBLIC_HOST_VERIFIER_IDENTITY:`subject:${subject}`,PUBLIC_HOST_VERIFIER_ORIGIN:'https://synthetic-verifier.example',
            MEDIA_CONTRACT:delivery.MEDIA_DELIVERY_CONTRACT_VALUE,MEDIA_WITNESS_KEY:delivery.MEDIA_BINDING_WITNESS_KEY,
            MEDIA_WITNESS_SHA256:delivery.MEDIA_BINDING_WITNESS_SHA256,MEDIA_WITNESS_BYTE_COUNT:'28',MEDIA_WITNESS_CONTENT_TYPE:'image/webp'}};
    const origins={processing:configs.processing.PROCESSING_ORIGIN,promotion:configs.promotion.PROMOTION_ORIGIN,verifier:configs.verifier.PUBLIC_HOST_VERIFIER_ORIGIN};
    const settings=purpose=>({DB:env.DB,APPROVED_MEDIA_ORIGIN:env.APPROVED_MEDIA_ORIGIN,EXPECTED_MEDIA_VERSION:env.EXPECTED_MEDIA_VERSION,...configs[purpose]});
    const dependencies={accessContext:{getIdentity:async()=>({service_token_status:true,common_name:subject})},fetch:f.publicFetch,timeoutMilliseconds:5000};
    const request=(purpose,operation,options={})=>new Request(`${origins[purpose]}/api/service/archive-attempts/${attemptId}/${operation}`,{
        method:['original','candidate','review'].includes(operation)?'GET':operation.startsWith('photo-')?'PUT':'POST',
        headers:['original','candidate','review'].includes(operation)?{}:{'Content-Type':'application/json'},
        body:['original','candidate','review'].includes(operation)?undefined:'{}',...options});
    const call=(purpose,operation,options={})=>handleArchiveServiceRequest(request(purpose,operation,options),settings(purpose),purpose,f.catalog,dependencies);
    const count=()=>f.original.calls.length+f.staging.calls.length+f.approved.calls.length;
    const before=count();
    for(const bad of [{...settings('processing'),APPROVED_MEDIA:f.approved},{...settings('processing'),EXPECTED_MEDIA_VERSION:undefined},
        {...settings('processing'),EXPECTED_MEDIA_VERSION:'00000000-0000-4000-8000-000000000001'},
        {...settings('processing'),APPROVED_MEDIA_ORIGIN:'https://other-origin.example'}])
        assert.equal((await handleArchiveServiceRequest(request('processing','start'),bad,'processing',f.catalog,dependencies)).ok,false);
    for(const handle of [handleProcessingRequest,handlePromotionRequest,handlePublicHostVerifierRequest])
        assert.equal((await handle(request('processing','start'),settings('processing'),{verifyAccessIdentity:async()=>f.owner})).status,403);
    assert.equal(count(),before,'Wrong/missing fixed configuration and owner identity fail before any storage I/O');
    assert.equal((await handleArchiveServiceRequest(request('promotion','candidate'),{...settings('promotion'),PROMOTER_IDENTITIES:`subject:${'2'.repeat(32)}.access`},
        'promotion',f.catalog,dependencies)).status,403,'Another service assertion cannot substitute for this exact role');
    const scopedEnv={...settings('processing'),ARCHIVE_SERVICE_IDENTITY:`subject:${subject}`,PRIVATE_DERIVATIVE_STAGING:f.staging};
    const scope=await issueArchiveServiceAuthority(scopedEnv,identity,site,attemptId,'processing');
    assert.equal((await reservePrivateGalleryAttempt(env,scope,site,f.assetId,f.consent,f.catalog)).status,403,'Service authority cannot create owner consent');
    await assert.rejects(readArchivePhotoAttempt(scopedEnv,JSON.parse(JSON.stringify(scope)),site,attemptId,f.catalog));
    await assert.rejects(readArchivePhotoAttempt(scopedEnv,scope,site==='family'?'everyone':'family',attemptId,f.catalog));
    await assert.rejects(readArchivePhotoAttempt(scopedEnv,scope,site,`attempt_${crypto.randomUUID()}`,f.catalog));
    await assert.rejects(storeArchivePhotoDerivative(scopedEnv,scope,site,attemptId,f.catalog,'approved',{},{}));
    assert.equal(count(),before);
    assert.equal((await call('processing','start')).status,200);
    const source=await call('processing','original');assert.equal(source.status,200);
    const bytes=Buffer.from(await source.arrayBuffer());assert.deepEqual(bytes,f.photo);
    const processed=await processGalleryPhoto({sourceBytes:bytes,fileExtension:'jpg',declaredMimeType:'image/jpeg',expectedSha256:source.headers.get('X-Gallery-Sha256'),
        draftBinding:{site,draftId:`draft_${attemptId.slice(8)}`,processingRunId:`run_${attemptId.slice(8).replaceAll('-','')}`}});
    for(const derivative of processed.derivatives) {
        assert.equal((await call('processing',derivative.storageRole,{headers:{'Content-Type':'image/webp','X-Gallery-Toolchain':JSON.stringify(processed.toolchain)},
            body:await derivative.payload.arrayBuffer()})).status,200);
    }
    assert.equal((await call('processing','promote')).status,404,'Processing has no approved-storage path');
    const originalsBefore=f.original.calls.length;
    const promoted=await call('promotion','promote');assert.equal(promoted.status,200,await promoted.clone().text());
    const candidate=await promoted.json();assert.deepEqual(candidate.item.athleteIds,['fixture-public']);assert.equal(candidate.site,site);
    assert.equal(f.original.calls.length,originalsBefore,'Promotion cannot read private originals');
    assert.equal(JSON.stringify(candidate).includes('Fictitious tagged person'),false);
    assert.equal((await call('promotion','original')).status,404);
    assert.equal((await call('verifier','cleanup')).status,404,'Verifier has no bucket cleanup path');
    const github=syntheticGitHub(),main=await readGalleryReviewMain({token:github.token,fetchImpl:github.fetchImpl});
    assert.equal((await call('promotion','review-reserve',{body:JSON.stringify({...main,extra:true})})).status,422);
    const reserved=await call('promotion','review-reserve',{body:JSON.stringify(main)});assert.equal(reserved.status,200,await reserved.clone().text());
    const intent=await reserved.json(),review=await createOrReconcileGalleryReview(intent.candidate,{expectedBaseSha:intent.baseSha,token:github.token,fetchImpl:github.fetchImpl});
    assert.equal((await call('promotion','review-open',{body:JSON.stringify({review:{...review,branchRef:review.branchRef.slice(0,-1)+(review.branchRef.endsWith('f')?'0':'f')}})})).status,422);
    assert.equal((await call('promotion','review-open',{body:JSON.stringify({review})})).status,200);
    assert.equal((await call('promotion','review-open',{body:JSON.stringify({review:{...review,replayed:true}})})).status,200);
    assert.equal((await call('promotion','review')).status,200);
    assert.equal((await call('promotion','review-close',{body:JSON.stringify({evidence:{repository:review.repository,baseRef:'main',itemId:review.itemId,targetRelativePath:review.targetRelativePath}})})).status,422);
    assert.equal((await call('processing','close')).status,200);
    const evidence=await invalidateGalleryReview(intent.candidate,review,{expectedBaseSha:intent.baseSha,token:github.token,fetchImpl:github.fetchImpl});
    assert.equal((await call('promotion','review-close',{body:JSON.stringify({evidence:{...evidence,pullRequest:{...evidence.pullRequest,number:999}}})})).status,422);
    assert.equal((await call('promotion','review-close',{body:JSON.stringify({evidence})})).status,200);
    assert.equal((await call('promotion','manifest-absence',{body:JSON.stringify(main)})).ok,false,'Manifest proof cannot precede host proof');
    assert.equal((await call('verifier','verify')).ok,false);assert.equal(f.hostRequests.length,0,'No host proof before both tier cleanup checkpoints');
    assert.equal((await call('processing','cleanup')).status,200);
    assert.equal((await call('verifier','verify')).ok,false);assert.equal(f.hostRequests.length,0);
    assert.equal((await call('promotion','cleanup')).status,200);
    const verified=await call('verifier','verify');assert.equal(verified.status,200,await verified.clone().text());
    assert.equal((await verified.json()).hostDeletionConfirmed,true);assert.ok(f.hostRequests.length>0);
    assert.equal((await call('promotion','manifest-absence',{body:JSON.stringify(main)})).status,200);
    assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_pipeline_tier_absences').get().n,2);
    assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_pipeline_host_receipts').get().n,1);
    assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_asset_tags').get().n,2);
    assert.equal(f.original.objects.size,1,'Reversible cleanup keeps the exact retained original');
    const hostCount=f.hostRequests.length;
    assert.equal((await call('verifier','verify')).status,200);assert.equal(f.hostRequests.length,hostCount,'Still-current host proof is not replayed');
    await assert.rejects(readArchivePhotoSource(scopedEnv,scope,site,attemptId,f.catalog),'Closed authority cannot read originals');
    const finalizerEnv={DB:env.DB,PRIVATE_ORIGINALS:f.original,APPROVED_MEDIA_ORIGIN:env.APPROVED_MEDIA_ORIGIN,EXPECTED_MEDIA_VERSION:env.EXPECTED_MEDIA_VERSION,
        FINALIZER_IDENTITY:`subject:${subject}`,FINALIZER_ORIGIN:'https://synthetic-finalizer.example'};
    const finalizerRequest=()=>new Request(`${finalizerEnv.FINALIZER_ORIGIN}/api/service/archive-assets/${f.assetId}/finalize`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal((await handleWithdrawalFinalizerRequest(finalizerRequest(),finalizerEnv,dependencies)).status,404,'Service cannot manufacture owner deletion');
    db.prepare('INSERT INTO private_archive_deletion_requests(asset_id,actor_identity_hash,reason) VALUES(?,?,?)').run(f.assetId,await hashIdentity(f.owner),'consent-withdrawal');
    assert.equal((await handleWithdrawalFinalizerRequest(finalizerRequest(),{...finalizerEnv,APPROVED_MEDIA:f.approved},dependencies)).status,503);
    assert.equal((await handleWithdrawalFinalizerRequest(finalizerRequest(),finalizerEnv,dependencies)).status,200);
    assert.equal(f.original.objects.size,0);const finalCalls=f.original.calls.length;
    assert.equal((await handleWithdrawalFinalizerRequest(finalizerRequest(),finalizerEnv,dependencies)).status,200);
    assert.equal(f.original.calls.length,finalCalls,'Completed original cleanup is not replayed');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);db.close();
}
console.log('Strict archive service scopes and separate processing/promotion/verifier HTTP paths passed both areas; fixed configuration, consent, capability and cleanup/host fences retained.');
