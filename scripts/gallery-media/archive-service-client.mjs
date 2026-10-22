import {readBoundedBytes} from '../../gallery-admin/src/media-byte-verification.js';
import {validatePhotoFramingSource} from './photo-framing-source.mjs';
import {reportArchiveDiagnostic} from './archive-diagnostics.mjs';
const origins=Object.freeze({processing:'https://family-running-gallery-processing-dev.family-running.workers.dev',
    promotion:'https://family-running-gallery-promotion-dev.family-running.workers.dev',
    verifier:'https://family-running-gallery-public-host-verifier-dev.family-running.workers.dev'});
const operations=Object.freeze({processing:['start','original','photo-display','photo-thumbnail','close','cleanup'],
    promotion:['promote','candidate','review','review-reserve','review-open','review-close','review-write','review-terminal','removal-reserve','removal-open','manifest-absence','close','cleanup'],verifier:['verify']});
const identifier=/^attempt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const credential=value=>typeof value==='string' && value.length>0 && value.length<=4096 && !/[\u0000-\u0020\u007f]/u.test(value);

// No ambient network or credential discovery. Fixed approved service origins,
// no caller URL/site/key, redirects forbidden, bounded complete response reads.
export function createArchiveServiceClient({purpose,origin,clientId,clientSecret,fetchImpl,timeoutMilliseconds=10000,reportFailure}) {
    if(origin!==origins[purpose] || !credential(clientId) || !credential(clientSecret) || typeof fetchImpl!=='function' ||
        !Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds<1 || timeoutMilliseconds>30000) throw new Error('Unavailable');
    return async (attemptId,operation,value)=>{
        if(!identifier.test(attemptId||'') || !operations[purpose].includes(operation)) throw new Error('Unavailable');
        const controller=new AbortController();let timer,reason='request-rejected',status,active=true;
        try {
            const responsePromise=(async()=>{
                const get=['original','candidate','review'].includes(operation),put=operation.startsWith('photo-');
                const headers=new Headers({'CF-Access-Client-Id':clientId,'CF-Access-Client-Secret':clientSecret});
                let body;
                if(!get) {
                    headers.set('Content-Type',put?'image/webp':'application/json');
                    if(put) {
                        if(!(value?.bytes instanceof ArrayBuffer) || value.bytes.byteLength>(operation==='photo-thumbnail'?5242880:26214400)) throw new Error('Unavailable');
                        headers.set('X-Gallery-Toolchain',JSON.stringify(value.toolchain));body=value.bytes;
                    } else body=JSON.stringify(value??{});
                }
                const url=`${origin}/api/service/archive-attempts/${attemptId}/${operation}`;
                reason='transport-unavailable';
                const response=await fetchImpl(new Request(url,{method:get?'GET':put?'PUT':'POST',headers,body,redirect:'error',credentials:'omit',cache:'no-store',signal:controller.signal}));
                status=response.status;reason='response-origin';
                if(response.url!==url || response.redirected) throw new Error('Unavailable');
                reason='response-cache';if(response.headers.get('Cache-Control')!=='no-store') throw new Error('Unavailable');
                reason='response-body';if(!response.body) throw new Error('Unavailable');
                const contentType=response.headers.get('Content-Type');
                if(operation==='original' && response.ok) {
                    reason='source-headers';
                    if(!['image/jpeg','image/png'].includes(contentType) || !/^[0-9a-f]{64}$/.test(response.headers.get('X-Gallery-Sha256')||'')) throw new Error('Unavailable');
                    const size=Number(response.headers.get('Content-Length'));if(!Number.isSafeInteger(size) || size<1 || size>26214400) throw new Error('Unavailable');
                    reason='response-body';const bytes=await readBoundedBytes(response.body,size);
                    reason='response-length';if(bytes.length!==size) throw new Error('Unavailable');
                    return {ok:true,value:{bytes,mimeType:contentType,sha256:response.headers.get('X-Gallery-Sha256')}};
                }
                reason='response-type';
                if(contentType!=='application/json; charset=utf-8') throw new Error('Unavailable');
                reason='response-body';
                const bytes=await readBoundedBytes(response.body,2097152),decoded=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
                reason='framing-response';
                if(operation==='start' && response.ok && Object.hasOwn(decoded,'framingSource')) validatePhotoFramingSource(decoded.framingSource);
                if(!response.ok && active) reportArchiveDiagnostic(reportFailure,{kind:'transport',service:purpose,operation,reason:'http-status',status});
                return {ok:response.ok,value:response.ok?decoded:undefined};
            })();
            return await Promise.race([responsePromise,new Promise((_,reject)=>{timer=setTimeout(()=>{reason='timeout';controller.abort();reject(new Error('Unavailable'));},timeoutMilliseconds);})]);
        } catch {reportArchiveDiagnostic(reportFailure,{kind:'transport',service:purpose,operation,reason,status});return {ok:false};}
        finally {active=false;clearTimeout(timer);controller.abort();}
    };
}

// A photo PUT stores and independently verifies its bytes before acknowledging
// success. Bound that complete exchange at 30 seconds, without extending start,
// source reads, close or cleanup and without retrying an uncertain write.
export function createArchiveProcessingClient(options) {
    if(options?.purpose!=='processing') throw new Error('Unavailable');
    const normal=createArchiveServiceClient(options);
    const photo=createArchiveServiceClient({...options,timeoutMilliseconds:30000});
    return (attemptId,operation,value)=>(operation==='photo-display' || operation==='photo-thumbnail'?photo:normal)(attemptId,operation,value);
}

// The protected promotion RPC copies/verifies the two-derivative photo set. Give
// only that RPC the existing bounded 30-second option; all other operations
// retain their normal deadline, validation and uncertain-write behaviour.
export function createArchivePromotionClient(options) {
    if(options?.purpose!=='promotion') throw new Error('Unavailable');
    const normal=createArchiveServiceClient(options);
    const promote=createArchiveServiceClient({...options,timeoutMilliseconds:30000});
    return (attemptId,operation,value)=>(operation==='promote'?promote:normal)(attemptId,operation,value);
}

const finalizerOrigin='https://family-running-gallery-withdrawal-finalizer-dev.family-running.workers.dev';
// Explicit protected transports. The body cannot select an owner, area, object
// key, repository or URL. Job metadata comes from the owner request in D1.
export function createArchiveJobClient({purpose,origin,clientId,clientSecret,fetchImpl,timeoutMilliseconds=10000,reportFailure}) {
    const approved=purpose==='promotion'?origins.promotion:purpose==='finalizer'?finalizerOrigin:null;
    const request=fixedJsonTransport({purpose,origin,approved,clientId,clientSecret,fetchImpl,timeoutMilliseconds,reportFailure});
    return (jobId,operation,value)=>{
        if(!/^job_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(jobId||'') ||
            !['read','claim','complete','purge-inspect','purge','batch-reserve','batch-write','batch-open','batch-terminal',
                'batch-publication-check','batch-publication-observe'].includes(operation) ||
            purpose!=='finalizer' && operation.startsWith('purge') || purpose!=='promotion' && operation.startsWith('batch-')) throw new Error('Unavailable');
        return request(`/api/service/archive-jobs/${jobId}/${operation}`,value,operation);
    };
}
export function createArchiveFinalizerClient(options) {
    const request=fixedJsonTransport({...options,approved:finalizerOrigin});
    return assetId=>{
        if(!/^asset_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(assetId||'')) throw new Error('Unavailable');
        return request(`/api/service/archive-assets/${assetId}/finalize`,{},'finalize');
    };
}
function fixedJsonTransport({purpose,origin,approved,clientId,clientSecret,fetchImpl,timeoutMilliseconds=10000,reportFailure}) {
    if(!approved || origin!==approved || !credential(clientId) || !credential(clientSecret) || typeof fetchImpl!=='function' ||
        !Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds<1 || timeoutMilliseconds>30000) throw new Error('Unavailable');
    return async (path,value,operation)=>{
        const controller=new AbortController();let timer,reason='request-rejected',status,active=true;
        try {
            const body=JSON.stringify(value);if(typeof body!=='string' || Buffer.byteLength(body)>2097152) throw new Error('Unavailable');
            reason='transport-unavailable';
            return await Promise.race([(async()=>{
                const url=origin+path,response=await fetchImpl(new Request(url,{method:'POST',redirect:'error',credentials:'omit',cache:'no-store',signal:controller.signal,
                    headers:{'Content-Type':'application/json','CF-Access-Client-Id':clientId,'CF-Access-Client-Secret':clientSecret},body}));
                status=response.status;reason='response-origin';
                if(response.url!==url || response.redirected) throw new Error('Unavailable');
                reason='response-cache';if(response.headers.get('Cache-Control')!=='no-store') throw new Error('Unavailable');
                reason='response-type';if(response.headers.get('Content-Type')!=='application/json; charset=utf-8') throw new Error('Unavailable');
                reason='response-body';if(!response.body) throw new Error('Unavailable');
                const bytes=await readBoundedBytes(response.body,2097152);
                if(!response.ok && active) reportArchiveDiagnostic(reportFailure,{kind:'transport',service:purpose,operation,reason:'http-status',status});
                return {ok:response.ok,value:response.ok?JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)):undefined};
            })(),new Promise((_,reject)=>{timer=setTimeout(()=>{reason='timeout';controller.abort();reject(new Error('Unavailable'));},timeoutMilliseconds);})]);
        } catch {reportArchiveDiagnostic(reportFailure,{kind:'transport',service:purpose,operation,reason,status});return {ok:false};}
        finally {active=false;clearTimeout(timer);controller.abort();}
    };
}
