import {verifyWorkerAccessIdentity} from './access.js';
import {adminFailure,adminJson} from './responses.js';
import {readPrivateOwnerBody} from './private-gallery-owner-service.js';
import {issueArchiveServiceAuthority} from './private-gallery-service-authority.js';
import {MEDIA_BINDING_WITNESS_KEY,MEDIA_BINDING_WITNESS_SHA256,MEDIA_BINDING_WITNESS_SIZE,
    MEDIA_BINDING_WITNESS_CONTENT_TYPE,MEDIA_DELIVERY_CONTRACT_VALUE} from './media-delivery-contract.js';
const pathPattern=/^\/api\/service\/archive-attempts\/(attempt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/(start|original|photo-display|photo-thumbnail|promote|candidate|review|review-reserve|review-open|review-close|review-write|review-terminal|removal-reserve|removal-open|manifest-absence|close|cleanup|verify)$/;
export function isArchiveServicePath(request) {
    try {return ['/api/service/archive-attempts/','/api/service/archive-assets/','/api/service/archive-jobs/'].some(prefix=>new URL(request.url).pathname.startsWith(prefix));} catch {return false;}
}

// New archive requests never use this compatibility helper: their fixed
// origin/version are mandatory and checked against the epoch on every call.
// Existing v1 routes may ignore only these validated, non-binding additions;
// unknown bindings still reach their original exact-environment rejection.
export function legacyArchiveEnvironment(env,purpose) {
    const additions=purpose==='promotion'?['EXPECTED_MEDIA_VERSION']:['APPROVED_MEDIA_ORIGIN','EXPECTED_MEDIA_VERSION'];
    if(!additions.some(key=>Object.hasOwn(env||{},key))) return env;
    if(!additions.every(key=>Object.hasOwn(env,key)) || !/^https:\/\/[a-z0-9.-]+$/.test(env.APPROVED_MEDIA_ORIGIN||'') ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(env.EXPECTED_MEDIA_VERSION||'')) return env;
    return Object.fromEntries(Object.entries(env).filter(([key])=>!additions.includes(key)));
}

// This adapter has no secrets, GitHub client, owner impersonation, dispatch or
// combined bucket environment. Existing Workers select their fixed purpose.
export async function handleScopedArchiveRequest(request,env,config,catalog,dependencies,dispatch) {
    const purpose=config.purpose;
    try {
        const identity=await (dependencies.verifyAccessIdentity?dependencies.verifyAccessIdentity():
            verifyWorkerAccessIdentity(dependencies.accessContext,request));
        const url=new URL(request.url);
        if(identity?.type!=='service' || !/^[0-9a-f]{32}\.access$/.test(identity.subject||'') ||
            env[config.identity]!==`subject:${identity.subject}` || url.origin!==env[config.origin] || url.protocol!=='https:' ||
            request.headers.has('X-CSRF-Token') || request.headers.has('Cookie') &&
                !/^CF_Authorization=[A-Za-z0-9._-]+$/.test(request.headers.get('Cookie'))) return adminFailure(403);
        if(url.search || url.hash || url.username || url.password) return adminFailure(404);
        const route=pathPattern.exec(url.pathname);
        if(!route || !config.operations.includes(route[2])) return adminFailure(404);
        const expected=['DB','APPROVED_MEDIA_ORIGIN','EXPECTED_MEDIA_VERSION',config.identity,config.origin,...config.buckets].sort();
        // The verifier additionally preserves its existing fixed witness vars.
        const witnessKeys=purpose==='verifier'?['MEDIA_CONTRACT','MEDIA_WITNESS_BYTE_COUNT','MEDIA_WITNESS_CONTENT_TYPE','MEDIA_WITNESS_KEY','MEDIA_WITNESS_SHA256']:[];
        if(Object.keys(env).sort().join('|')!==[...expected,...witnessKeys].sort().join('|') ||
            config.buckets.some(key=>!env[key])) return adminFailure(503);
        if(purpose==='verifier' && (env.MEDIA_CONTRACT!==MEDIA_DELIVERY_CONTRACT_VALUE || env.MEDIA_WITNESS_KEY!==MEDIA_BINDING_WITNESS_KEY ||
            env.MEDIA_WITNESS_SHA256!==MEDIA_BINDING_WITNESS_SHA256 || env.MEDIA_WITNESS_CONTENT_TYPE!==MEDIA_BINDING_WITNESS_CONTENT_TYPE ||
            String(env.MEDIA_WITNESS_BYTE_COUNT)!==String(MEDIA_BINDING_WITNESS_SIZE))) return adminFailure(503);
        env={...env,DB:env.DB.withSession?.('first-primary')||env.DB};
        const [attemptId,operation]=route.slice(1);
        const method=['original','candidate','review'].includes(operation)?'GET':operation.startsWith('photo-')?'PUT':'POST';
        if(request.method!==method) return adminFailure(405,{Allow:method});
        if(method==='GET' && (request.body || request.headers.has('Content-Type') || request.headers.has('Range') ||
            request.headers.has('Content-Encoding') || request.headers.has('Transfer-Encoding') ||
            ![null,'0'].includes(request.headers.get('Content-Length')))) return adminFailure(400);
        const row=await env.DB.prepare('SELECT site_mode FROM private_gallery_attempts WHERE attempt_id=?1').bind(attemptId).first();
        if(!row) return adminFailure(404);
        const scopedEnv={...env,ARCHIVE_SERVICE_IDENTITY:env[config.identity]};
        const scope=await issueArchiveServiceAuthority(scopedEnv,identity,row.site_mode,attemptId,purpose);
        const site=row.site_mode;
        let input;
        if(method==='POST') {
            const body=await readPrivateOwnerBody(request,['review-reserve','removal-reserve','manifest-absence'].includes(operation)?2097152:32768,'application/json',dependencies.bodyTimeoutMilliseconds);
            if(!body.ok) return adminFailure(body.status);
            const text=new TextDecoder('utf-8',{fatal:true}).decode(body.bytes);
            input=JSON.parse(text);
            if(!['review-reserve','review-open','review-close','review-write','review-terminal','removal-reserve','removal-open','manifest-absence'].includes(operation) && text!=='{}') return adminFailure(422);
        }
        return await dispatch({request,env:scopedEnv,scope,site,attemptId,catalog,operation,input,dependencies});
    } catch {return adminFailure(409);}
}
export function safeArchiveResult(result) {return result.ok?adminJson(200,result):adminFailure(result.status||409);}
