// Test/internal composition only. Deployed Workers import their fixed-purpose
// adapter directly so promotion cannot bundle private-original processing code.
import {handleArchiveProcessingRequest} from './private-gallery-processing-adapter.js';
import {handleArchivePromotionRequest} from './private-gallery-promotion-adapter.js';
import {handleArchiveVerifierRequest} from './private-gallery-verifier-adapter.js';
import {adminFailure} from './responses.js';
export {isArchiveServicePath,legacyArchiveEnvironment} from './private-gallery-service-request.js';
export function handleArchiveServiceRequest(request,env,purpose,catalog,dependencies={}) {
    if(purpose==='processing') return handleArchiveProcessingRequest(request,env,catalog,dependencies);
    if(purpose==='promotion') return handleArchivePromotionRequest(request,env,catalog,dependencies);
    if(purpose==='verifier') return handleArchiveVerifierRequest(request,env,dependencies);
    return adminFailure(503);
}
