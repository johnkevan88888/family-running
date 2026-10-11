import {handleScopedArchiveRequest,safeArchiveResult} from './private-gallery-service-request.js';
import {adminFailure,adminJson} from './responses.js';
import {readPrivateOwnerBody} from './private-gallery-owner-service.js';
import {admitArchivePhotoProcessing,readArchivePhotoSource,storeArchivePhotoDerivative,closeArchivePhotoAttempt,removeArchivePhotoCopies} from './private-gallery-photo-lifecycle.js';
import {inspectStaticWebp,sha256Hex} from './media-byte-verification.js';
const config=Object.freeze({purpose:'processing',identity:'PROCESSOR_IDENTITIES',origin:'PROCESSING_ORIGIN',
    buckets:['PRIVATE_ORIGINALS','DERIVATIVE_STAGING'],operations:['start','original','photo-display','photo-thumbnail','close','cleanup']});
export function handleArchiveProcessingRequest(request,env,catalog,dependencies={}) {
    return handleScopedArchiveRequest(request,env,config,catalog,dependencies,dispatch);
}
async function dispatch({request,env,scope,site,attemptId,catalog,operation,dependencies}) {
    env={...env,PRIVATE_DERIVATIVE_STAGING:env.DERIVATIVE_STAGING};
        if(operation==='original') {
            const source=await readArchivePhotoSource(env,scope,site,attemptId,catalog);
            return new Response(source.bytes,{status:200,headers:{'Content-Type':source.declaredMimeType,'Content-Length':String(source.bytes.length),
                'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Gallery-Sha256':source.expectedSha256}});
        }
        if(operation.startsWith('photo-')) {
            const body=await readPrivateOwnerBody(request,operation==='photo-thumbnail'?5242880:26214400,'image/webp',dependencies.bodyTimeoutMilliseconds);
            if(!body.ok) return adminFailure(body.status);
            const header=request.headers.get('X-Gallery-Toolchain');
            if(!header || header.length>2048) return adminFailure(422);
            const scan=JSON.parse(header),dimensions=inspectStaticWebp(body.bytes);
            if(!dimensions) return adminFailure(422);
            await storeArchivePhotoDerivative(env,scope,site,attemptId,catalog,'staging',{
                storageRole:operation,width:dimensions.width,height:dimensions.height,byteLength:body.bytes.length,
                sha256:await sha256Hex(body.bytes),payload:new Blob([body.bytes])},scan);
            return adminJson(200,{state:'staged',publicationEnabled:false});
        }
        if(operation==='start') return safeArchiveResult(await admitArchivePhotoProcessing(env,scope,site,attemptId,catalog));
        if(operation==='close') {await closeArchivePhotoAttempt(env,scope,site,attemptId,'cancelled');return adminJson(200,{state:'closed'});}
        if(operation==='cleanup') return safeArchiveResult(await removeArchivePhotoCopies(env,scope,site,attemptId));
        return adminFailure(404);
}
