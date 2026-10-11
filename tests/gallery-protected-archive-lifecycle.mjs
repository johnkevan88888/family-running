import assert from 'node:assert/strict';
import {archiveServiceFixture} from './helpers/private-gallery-service-fixture.mjs';
import {syntheticGitHub} from './helpers/private-gallery-lifecycle-fixtures.mjs';
import {handleArchiveServiceRequest,legacyArchiveEnvironment} from '../gallery-admin/src/private-gallery-service-adapter.js';
import {createArchiveServiceClient} from '../scripts/gallery-media/archive-service-client.mjs';
import {runProtectedArchiveReview,resumeProtectedArchiveRemoval} from '../scripts/gallery-media/protected-archive-lifecycle.mjs';
import * as delivery from '../gallery-admin/src/media-delivery-contract.js';
import {changePrivateGalleryVisibility,readPrivateGalleryAssetEligibility} from '../gallery-admin/src/private-gallery-visibility-service.js';
import {reservePrivateGalleryAttempt} from '../gallery-admin/src/private-gallery-attempt-service.js';
for(const site of ['family','everyone']) {
    const f=await archiveServiceFixture(site),github=syntheticGitHub();
    const clients={},environments={},httpCalls=[];let loseOpen=false;
    for(const [index,purpose] of ['processing','promotion','verifier'].entries()) {
        const subject=String(index+1).repeat(32)+'.access',origin=`https://family-running-gallery-${purpose==='verifier'?'public-host-verifier':purpose}-dev.family-running.workers.dev`;
        const env={DB:f.env.DB,APPROVED_MEDIA_ORIGIN:f.env.APPROVED_MEDIA_ORIGIN,EXPECTED_MEDIA_VERSION:f.env.EXPECTED_MEDIA_VERSION,
            ...(purpose==='processing'?{PROCESSOR_IDENTITIES:`subject:${subject}`,PROCESSING_ORIGIN:origin,PRIVATE_ORIGINALS:f.original,DERIVATIVE_STAGING:f.staging}:
                purpose==='promotion'?{PROMOTER_IDENTITIES:`subject:${subject}`,PROMOTION_ORIGIN:origin,DERIVATIVE_STAGING:f.staging,APPROVED_MEDIA:f.approved}:
                {PUBLIC_HOST_VERIFIER_IDENTITY:`subject:${subject}`,PUBLIC_HOST_VERIFIER_ORIGIN:origin,MEDIA_CONTRACT:delivery.MEDIA_DELIVERY_CONTRACT_VALUE,
                    MEDIA_WITNESS_KEY:delivery.MEDIA_BINDING_WITNESS_KEY,MEDIA_WITNESS_SHA256:delivery.MEDIA_BINDING_WITNESS_SHA256,MEDIA_WITNESS_BYTE_COUNT:'28',MEDIA_WITNESS_CONTENT_TYPE:'image/webp'})};
        environments[purpose]=env;
        clients[purpose]=createArchiveServiceClient({purpose,origin,clientId:`fictional-${purpose}`,clientSecret:'fictional-secret',fetchImpl:async request=>{
            assert.equal(request.redirect,'error');assert.equal(request.credentials,'omit');httpCalls.push([purpose,new URL(request.url).pathname.split('/').at(-1)]);
            const response=await handleArchiveServiceRequest(request,env,purpose,f.catalog,{accessContext:{getIdentity:async()=>({service_token_status:true,common_name:subject})},fetch:f.publicFetch});
            Object.defineProperty(response,'url',{value:request.url});
            if(loseOpen && request.url.endsWith('/review-open')) {loseOpen=false;throw new Error('Fictional lost reply');}
            return response;
        }});
        assert.throws(()=>createArchiveServiceClient({purpose,origin:'https://arbitrary.example',clientId:'fictional',clientSecret:'fictional',fetchImpl:async()=>{}}));
    }
    assert.deepEqual(Object.keys(legacyArchiveEnvironment(environments.processing,'processing')).sort(),['DB','DERIVATIVE_STAGING','PRIVATE_ORIGINALS','PROCESSING_ORIGIN','PROCESSOR_IDENTITIES']);
    assert.equal(legacyArchiveEnvironment({...environments.processing,EXPECTED_MEDIA_VERSION:'invalid'},'processing').EXPECTED_MEDIA_VERSION,'invalid','Invalid additions are not stripped into a valid legacy environment');
    assert.equal(legacyArchiveEnvironment({...environments.processing,UNEXPECTED_BUCKET:f.approved},'processing').UNEXPECTED_BUCKET,f.approved,'Unknown bindings remain rejected by legacy checks');
    const run=()=>runProtectedArchiveReview({attemptId:f.attemptId,...clients,github});
    const first=await run();assert.equal(first.ok,true,JSON.stringify(first));assert.equal(first.state,'unmerged-review');
    const originalCalls=f.original.calls.length,writeCalls=f.staging.calls.filter(c=>c[0]==='part').length+f.approved.calls.filter(c=>c[0]==='part').length;
    const retry=await run();assert.equal(retry.ok,true);assert.equal(github.state.pulls.length,1);
    assert.equal(f.original.calls.length,originalCalls,'Prepared review recovery never reads the original again');
    assert.equal(f.staging.calls.filter(c=>c[0]==='part').length+f.approved.calls.filter(c=>c[0]==='part').length,writeCalls);
    // Lost durable review response closes this attempt and cleans both tiers;
    // the existing PR is reconciled and closed only in the finalization runner.
    loseOpen=true;assert.equal((await run()).ok,false);
    assert.equal(github.state.pulls[0].state,'open');assert.equal(f.original.objects.size,1);
    const removal=()=>resumeProtectedArchiveRemoval({attemptId:f.attemptId,...clients,github});
    assert.equal((await removal()).ok,true);assert.equal(github.state.pulls[0].state,'closed');
    const hostCalls=f.hostRequests.length;assert.equal((await removal()).ok,true);assert.equal(f.hostRequests.length,hostCalls);
    const restored=await reservePrivateGalleryAttempt(f.env,f.owner,site,f.assetId,{...f.consent,idempotencyKey:crypto.randomUUID()},f.catalog);
    assert.equal(restored.ok,true);const nextId=restored.attemptId;
    const next=await runProtectedArchiveReview({attemptId:nextId,...clients,github});assert.equal(next.ok,true,JSON.stringify(next));
    github.ownerMerge(next.review); // Explicit fixture-only owner publication.
    const callsBeforePublished=f.approved.calls.length;
    assert.equal((await runProtectedArchiveReview({attemptId:nextId,...clients,github})).state,'already-published');
    assert.equal(f.approved.calls.length,callsBeforePublished,'Review replay cannot silently unpublish an owner-merged item');
    assert.equal((await changePrivateGalleryVisibility(f.env,f.owner,site,f.ids[0],{expectedVersion:2,idempotencyKey:crypto.randomUUID(),preference:'hidden'})).ok,true);
    const hide=await resumeProtectedArchiveRemoval({attemptId:nextId,...clients,github});assert.equal(hide.state,'unmerged-removal-review',JSON.stringify(hide));
    assert.equal(github.state.pulls.at(-1).state,'open');assert.equal(f.original.objects.size,1);
    assert.equal(JSON.parse(github.state.commits.get(hide.review.headSha).contents[`gallery-data/${site}.json`]).items.length,0);
    const hideRetry=await resumeProtectedArchiveRemoval({attemptId:nextId,...clients,github});assert.equal(hideRetry.review.pullRequest.number,hide.review.pullRequest.number);
    github.ownerMerge(hide.review); // Fixture-only explicit owner removal merge.
    assert.equal((await resumeProtectedArchiveRemoval({attemptId:nextId,...clients,github})).state,'removed');
    assert.equal((await changePrivateGalleryVisibility(f.env,f.owner,site,f.ids[0],{expectedVersion:3,idempotencyKey:crypto.randomUUID(),preference:'allowed'})).ok,true);
    const current=await readPrivateGalleryAssetEligibility(f.env,f.owner,site,f.assetId,f.catalog);
    const fresh=await reservePrivateGalleryAttempt(f.env,f.owner,site,f.assetId,{...f.consent,idempotencyKey:crypto.randomUUID(),eligibilityRevision:current.revision},f.catalog);
    assert.equal(fresh.ok,true);
    const final=await runProtectedArchiveReview({attemptId:fresh.attemptId,...clients,github});assert.equal(final.ok,true,JSON.stringify(final));
    assert.notEqual(final.review.itemId,next.review.itemId);
    const newItem=JSON.parse(f.db.prepare('SELECT candidate_json FROM private_gallery_pipeline_review_intents WHERE attempt_id=?').get(fresh.attemptId).candidate_json).manifestText;
    const oldItem=JSON.parse(f.db.prepare('SELECT candidate_json FROM private_gallery_pipeline_review_intents WHERE attempt_id=?').get(nextId).candidate_json).manifestText;
    assert.notEqual(JSON.parse(newItem).items[0].sourceUrl,JSON.parse(oldItem).items[0].sourceUrl,'Restoration uses a fresh generation URL, never retired URLs');
    // A historical DB removal receipt does not permit an old URL to reappear
    // on current main. No byte writes occur while that discrepancy is present.
    github.state.manifests[site]=JSON.parse(oldItem);
    const partsBefore=f.staging.calls.filter(c=>c[0]==='part').length;
    assert.equal((await runProtectedArchiveReview({attemptId:fresh.attemptId,...clients,github})).ok,false);
    assert.equal(f.staging.calls.filter(c=>c[0]==='part').length,partsBefore);
    assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_asset_tags').get().n,2);
    assert.equal(github.state.requests.some(r=>r.path.endsWith('/merge') || r.method==='DELETE'),false);
    assert.equal(httpCalls.some(([purpose,op])=>purpose==='processing'&&op==='promote' || purpose==='promotion'&&op==='original'),false);
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);f.db.close();
}
console.log('Protected archive transports, real decoder, one-file review, lost-reply recovery and host/removal resumption pass both areas using synthetic HTTP/GitHub only.');
