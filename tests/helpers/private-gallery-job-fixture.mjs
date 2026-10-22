import assert from 'node:assert/strict';
import {handleArchiveServiceRequest} from '../../gallery-admin/src/private-gallery-service-adapter.js';
import {handleWithdrawalFinalizerRequest} from '../../gallery-admin/src/withdrawal-finalizer-worker.js';
import {handleAdminRequest} from '../../gallery-admin/src/admin-worker.js';
import {createBrowserSession} from '../../gallery-admin/src/session.js';
import {createArchiveServiceClient,createArchiveProcessingClient,createArchivePromotionClient,createArchiveJobClient,createArchiveFinalizerClient} from '../../scripts/gallery-media/archive-service-client.mjs';
import * as delivery from '../../gallery-admin/src/media-delivery-contract.js';
export async function privateGalleryJobFixture(f,{reportFailure}={}) {
    const clients={},jobs={},environments={},identities={},requests=[];
    let replyHook;
    for(const [index,purpose] of ['processing','promotion','verifier','finalizer'].entries()) {
        const subject=String(index+1).repeat(32)+'.access',name={verifier:'public-host-verifier',finalizer:'withdrawal-finalizer'}[purpose]||purpose;
        const origin=`https://family-running-gallery-${name}-dev.family-running.workers.dev`;
        const env={DB:f.env.DB,APPROVED_MEDIA_ORIGIN:f.env.APPROVED_MEDIA_ORIGIN,EXPECTED_MEDIA_VERSION:f.env.EXPECTED_MEDIA_VERSION,
            ...(purpose==='processing'?{PROCESSOR_IDENTITIES:`subject:${subject}`,PROCESSING_ORIGIN:origin,PRIVATE_ORIGINALS:f.original,DERIVATIVE_STAGING:f.staging}:
                purpose==='promotion'?{PROMOTER_IDENTITIES:`subject:${subject}`,PROMOTION_ORIGIN:origin,DERIVATIVE_STAGING:f.staging,APPROVED_MEDIA:f.approved}:
                purpose==='finalizer'?{FINALIZER_IDENTITY:`subject:${subject}`,FINALIZER_ORIGIN:origin,PRIVATE_ORIGINALS:f.original}:
                {PUBLIC_HOST_VERIFIER_IDENTITY:`subject:${subject}`,PUBLIC_HOST_VERIFIER_ORIGIN:origin,MEDIA_CONTRACT:delivery.MEDIA_DELIVERY_CONTRACT_VALUE,
                    MEDIA_WITNESS_KEY:delivery.MEDIA_BINDING_WITNESS_KEY,MEDIA_WITNESS_SHA256:delivery.MEDIA_BINDING_WITNESS_SHA256,
                    MEDIA_WITNESS_BYTE_COUNT:'28',MEDIA_WITNESS_CONTENT_TYPE:'image/webp'})};
        environments[purpose]=env;identities[purpose]={type:'service',subject};
        const configuration={purpose,origin,clientId:`fictional-${purpose}`,clientSecret:'fictional-secret',reportFailure,fetchImpl:async request=>{
            assert.equal(request.redirect,'error');assert.equal(request.credentials,'omit');assert.equal(request.headers.get('CF-Access-Client-Secret'),'fictional-secret');
            requests.push([purpose,new URL(request.url).pathname]);
            const dependencies={verifyAccessIdentity:async()=>identities[purpose],fetch:f.publicFetch};
            const response=purpose==='finalizer'?await handleWithdrawalFinalizerRequest(request,env,dependencies):
                await handleArchiveServiceRequest(request,env,purpose,f.catalog,dependencies);
            Object.defineProperty(response,'url',{value:request.url});await replyHook?.(request,response);return response;
        }};
        if(purpose==='finalizer') clients.finalizer=createArchiveFinalizerClient(configuration);
        else if(purpose==='promotion') clients.promotion=createArchivePromotionClient(configuration);
        else if(purpose==='processing') clients.processing=createArchiveProcessingClient(configuration);
        else clients[purpose]=createArchiveServiceClient(configuration);
        if(['promotion','finalizer'].includes(purpose)) jobs[purpose]=createArchiveJobClient(configuration);
    }
    const origin='https://synthetic-owner-jobs.example';
    const ownerEnv={DB:f.env.DB,PRIVATE_ORIGINALS:f.original,ADMIN_ORIGIN:origin,OWNER_IDENTITIES:`subject:${f.owner.subject}`,SESSION_SECRET:'fictional-protected-job-session-secret'};
    const session=await createBrowserSession(f.owner,ownerEnv,f.site,Date.now());
    const request=(assetId,body,extra={})=>new Request(`${origin}/api/browser/private-assets/${assetId}/archive-jobs?site=${f.site}`,{
        method:body?'POST':'GET',headers:{Cookie:session.cookie.split(';')[0],...(body?{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken,
            Origin:origin,'Sec-Fetch-Site':'same-origin'}:{}),...extra},body:body?JSON.stringify(body):undefined});
    const ownerResponse=(assetId,body,extra,identity=f.owner)=>handleAdminRequest(request(assetId,body,extra),ownerEnv,{verifyAccessIdentity:async()=>identity});
    const ownerJob=async body=>{const response=await ownerResponse(f.assetId,body);assert.ok(response.ok,await response.clone().text());return (await response.json()).job.jobId;};
    return {...clients,jobs,environments,identities,requests,ownerEnv,ownerResponse,ownerJob,setReplyHook:hook=>{replyHook=hook;}};
}
