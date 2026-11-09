import {GalleryMediaProcessingError} from './errors.mjs';

const stages=new Set(['admission','original-download','metadata-stripping','framing-check','photo-display','photo-thumbnail','promotion']);
const refreshStages=new Set(['configuration','permission-boundary','service-configuration','job-configuration',
    'job-read','job-evidence','candidate-evidence','photo-eligibility','review-configuration','main-ref',
    'review-history','review-identity','review-base-history','eligibility-recheck','manifest-proof','main-history',
    'refresh-commit','branch-readback','review-closure']);
const publicationStages=new Set(['configuration','permission-boundary','service-configuration','job-configuration',
    'job-read','job-evidence','candidate-evidence','photo-eligibility','main-ref','review-history','review-head',
    'phase-boundary','publication-check','publication-observe','publication-complete','completion-readback']);
const operations=new Set(['start','original','photo-display','photo-thumbnail','promote','candidate','review','review-reserve','review-open',
    'review-close','review-write','review-terminal','removal-reserve','removal-open','manifest-absence','close','cleanup','verify',
    'read','claim','complete','purge-inspect','purge','batch-reserve','batch-write','batch-open','batch-terminal',
    'batch-publication-check','batch-publication-observe','finalize']);
// Why a protected run stopped without a result. A pending return is not a
// failure and not a success, and before this it said nothing at all: a stalled
// job gave the operator one word, "pending", and no way to tell a stale main
// from a missing host proof from a refused configuration.
//
// This is the ONE list of reasons a pending return may give, and it is a closed
// set of fixed strings because of where these lines end up. The protected
// runner holds Cloudflare Access credentials and runs in a PUBLIC repository,
// so its stderr is published in the Actions log for anyone to read. A reason is
// therefore never an error message, a URL, an origin, a storage key, a SHA, a
// job, attempt or asset ID, or an athlete ID -- and because substitution beats
// trust, anything not on this list is reported as `unclassified` instead.
export const unclassifiedPendingReason='unclassified';
export const pendingReasons=Object.freeze(['input-validation','job-configuration','main-ref','review-history',
    'review-terminal','review-identity','review-refresh-required','owner-merge-observed',
    'external-write','candidate-evidence','publication-request','publication-completion',
    'batch-settlement','cleanup','host-proof','main-removal','original-finalizer',
    'purge-proof','purge-main-stability','unexpected-failure',unclassifiedPendingReason]);
const pendingReasonSet=new Set(pendingReasons);
const reasons=new Set(['request-rejected','transport-unavailable','timeout','response-origin','response-cache','response-type',
    'response-body','response-length','source-headers','framing-response','http-status','step-failed',
    'invalid-request','source-rejected','input-rejected','decoder-rejected','toolchain-unavailable','metadata-scan-failed',
    'derivative-rejected','processing-failed','cleanup-failed']);

// Only bounded enums and a batch position may leave the protected runner.
// Never serialize an Error, response, URL, header, ID, hash, tag or source path.
export function safeArchiveDiagnostic(event) {
    // Checked before the shared reason enum, because a pending reason is drawn
    // from its own list and an unlisted one is replaced rather than dropped:
    // the operator must still learn that the run went pending.
    if(event?.kind==='run-pending') {
        return {kind:'run-pending',reason:pendingReasonSet.has(event.reason)?event.reason:unclassifiedPendingReason};
    }
    if(!event || !reasons.has(event.reason)) return null;
    if((event.kind==='batch-review-refresh' && refreshStages.has(event.stage) ||
        event.kind==='batch-publication' && publicationStages.has(event.stage)) && event.reason==='step-failed') {
        const position=event.photoIndex!==undefined || event.photoCount!==undefined;
        if(position && !(Number.isInteger(event.photoIndex) && Number.isInteger(event.photoCount) &&
            event.photoIndex>=1 && event.photoIndex<=event.photoCount && event.photoCount<=20)) return null;
        return {kind:event.kind,stage:event.stage,reason:'step-failed',
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
/**
 * Returns the `pending()` the protected archive modules return, bound to an
 * observer, so every pending return says in log output why it stopped. The
 * reason must be one of `pendingReasons`; anything else is reported as
 * `unclassified`.
 *
 * The returned object is byte-for-byte what it has always been. The reason
 * never reaches the result, D1, a Worker contract or stored job state, because
 * callers assert on that shape and a pending result is a contract.
 */
export function pendingReporter(observer) {
    return reason=>{
        reportArchiveDiagnostic(observer,{kind:'run-pending',reason});
        return {ok:false,state:'pending',publicationEnabled:false};
    };
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
export function batchPublicationStep(observer) {
    return async (stage,operation,photoIndex,photoCount)=>{
        try {return await operation();}
        catch(error) {
            reportArchiveDiagnostic(observer,{kind:'batch-publication',stage,reason:'step-failed',photoIndex,photoCount});
            throw error;
        }
    };
}
export function formatArchiveDiagnostic(event) {
    const safe=safeArchiveDiagnostic(event);if(!safe) return '';
    // Deliberately not "stopped": the run reached no result and nothing failed.
    if(safe.kind==='run-pending') return `Gallery run is pending (${safe.reason}).` + String.fromCharCode(10);
    const location=['batch-review-refresh','batch-publication'].includes(safe.kind)?`${safe.kind==='batch-publication'?'batch publication':'batch review refresh'} / ${safe.stage}${safe.photoIndex?` / photo ${safe.photoIndex} of ${safe.photoCount}`:''}`:
        safe.kind==='photo-handoff'?`Photo ${safe.photoIndex} of ${safe.photoCount}: ${safe.stage}`:
        `${safe.service}/${safe.operation}`;
    return `Gallery stopped at ${location} (${safe.reason}${safe.status?`; HTTP ${safe.status}`:''}).\n`;
}
