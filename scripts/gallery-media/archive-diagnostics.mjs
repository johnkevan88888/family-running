import {GalleryMediaProcessingError} from './errors.mjs';

const stages=new Set(['admission','original-download','metadata-stripping','framing-check','photo-display','photo-thumbnail','promotion']);
const refreshStages=new Set(['configuration','permission-boundary','service-configuration','job-configuration',
    'job-read','job-evidence','candidate-evidence','photo-eligibility','review-configuration','main-ref',
    'review-history','review-identity','review-base-history','eligibility-recheck','manifest-proof','main-history',
    'refresh-commit','branch-readback','review-closure']);
const operations=new Set(['start','original','photo-display','photo-thumbnail','promote','candidate','review','review-reserve','review-open',
    'review-close','review-write','review-terminal','removal-reserve','removal-open','manifest-absence','close','cleanup','verify',
    'read','claim','complete','purge-inspect','purge','batch-reserve','batch-write','batch-open','batch-terminal',
    'batch-publication-check','batch-publication-observe','finalize']);
const reasons=new Set(['request-rejected','transport-unavailable','timeout','response-origin','response-cache','response-type',
    'response-body','response-length','source-headers','framing-response','http-status','step-failed',
    'invalid-request','source-rejected','input-rejected','decoder-rejected','toolchain-unavailable','metadata-scan-failed',
    'derivative-rejected','processing-failed','cleanup-failed']);

// Only bounded enums and a batch position may leave the protected runner.
// Never serialize an Error, response, URL, header, ID, hash, tag or source path.
export function safeArchiveDiagnostic(event) {
    if(!event || !reasons.has(event.reason)) return null;
    if(event.kind==='batch-review-refresh' && refreshStages.has(event.stage) && event.reason==='step-failed') {
        const position=event.photoIndex!==undefined || event.photoCount!==undefined;
        if(position && !(Number.isInteger(event.photoIndex) && Number.isInteger(event.photoCount) &&
            event.photoIndex>=1 && event.photoIndex<=event.photoCount && event.photoCount<=20)) return null;
        return {kind:'batch-review-refresh',stage:event.stage,reason:'step-failed',
            ...(position?{photoIndex:event.photoIndex,photoCount:event.photoCount}:{})};
    }
    if(event.kind==='transport' && ['processing','promotion','verifier','finalizer'].includes(event.service) && operations.has(event.operation)) {
        return {kind:'transport',service:event.service,operation:event.operation,reason:event.reason,
            ...(Number.isInteger(event.status) && event.status>=400 && event.status<=599?{status:event.status}:{})};
    }
    if(event.kind==='photo-handoff' && stages.has(event.stage) && Number.isInteger(event.photoIndex) && Number.isInteger(event.photoCount) &&
        event.photoIndex>=1 && event.photoIndex<=event.photoCount && event.photoCount<=20) {
        return {kind:'photo-handoff',photoIndex:event.photoIndex,photoCount:event.photoCount,stage:event.stage,reason:event.reason};
    }
    return null;
}
export function reportArchiveDiagnostic(observer,event) {
    // Reporting is best-effort; it cannot acknowledge a write, retry it, skip
    // cleanup or replace the original failure. No default console/network sink.
    try {const safe=safeArchiveDiagnostic(event);if(safe && typeof observer==='function') Promise.resolve(observer(safe)).catch(()=>{});} catch { /* Preserve failure. */ }
}
export function archivePhotoStep(observer,photoIndex=1,photoCount=1) {
    return async (stage,operation)=>{
        try {return await operation();}
        catch(error) {
            reportArchiveDiagnostic(observer,{kind:'photo-handoff',photoIndex,photoCount,stage,
                reason:error instanceof GalleryMediaProcessingError?error.code:'step-failed'});
            throw error;
        }
    };
}
export function batchReviewRefreshStep(observer) {
    return async (stage,operation,photoIndex,photoCount)=>{
        try {return await operation();}
        catch(error) {
            reportArchiveDiagnostic(observer,{kind:'batch-review-refresh',stage,reason:'step-failed',photoIndex,photoCount});
            throw error;
        }
    };
}
export function formatArchiveDiagnostic(event) {
    const safe=safeArchiveDiagnostic(event);if(!safe) return '';
    const location=safe.kind==='batch-review-refresh'?`batch review refresh / ${safe.stage}${safe.photoIndex?` / photo ${safe.photoIndex} of ${safe.photoCount}`:''}`:
        safe.kind==='photo-handoff'?`Photo ${safe.photoIndex} of ${safe.photoCount}: ${safe.stage}`:
        `${safe.service}/${safe.operation}`;
    return `Gallery stopped at ${location} (${safe.reason}${safe.status?`; HTTP ${safe.status}`:''}).\n`;
}
