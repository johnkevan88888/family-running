import {handleScopedArchiveRequest,safeArchiveResult} from './private-gallery-service-request.js';
import {verifyScopedArchivePhotoPublicAbsence} from './private-gallery-photo-lifecycle.js';
const config=Object.freeze({purpose:'verifier',identity:'PUBLIC_HOST_VERIFIER_IDENTITY',origin:'PUBLIC_HOST_VERIFIER_ORIGIN',buckets:[],operations:['verify']});
export function handleArchiveVerifierRequest(request,env,dependencies={}) {
    return handleScopedArchiveRequest(request,env,config,null,dependencies,async ({env,scope,site,attemptId})=>
        safeArchiveResult(await verifyScopedArchivePhotoPublicAbsence(env,scope,site,attemptId,dependencies.fetch||fetch,dependencies.timeoutMilliseconds)));
}
