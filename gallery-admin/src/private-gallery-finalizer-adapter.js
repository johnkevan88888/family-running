import {verifyWorkerAccessIdentity} from './access.js';
import {adminFailure,adminJson} from './responses.js';
import {readPrivateOwnerBody} from './private-gallery-owner-service.js';
import {issueArchiveFinalizerAuthority} from './private-gallery-service-authority.js';
import {deletePrivateArchiveOriginal} from './private-archive-service.js';
import {isArchiveJobPath,handleArchiveJobRequest} from './private-gallery-job-request.js';
import {inspectPrivateArchivePurge,purgePrivateArchiveMetadata} from './private-gallery-retention-service.js';
const routePattern=/^\/api\/service\/archive-assets\/(asset_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/finalize$/;
export function isArchiveFinalizerPath(request) {
    try {return ['/api/service/archive-assets/','/api/service/archive-attempts/','/api/service/archive-jobs/'].some(prefix=>new URL(request.url).pathname.startsWith(prefix));} catch {return false;}
}
export function legacyFinalizerEnvironment(env) {
    if(!['APPROVED_MEDIA_ORIGIN','EXPECTED_MEDIA_VERSION'].some(key=>Object.hasOwn(env||{},key))) return env;
    if(!Object.hasOwn(env,'APPROVED_MEDIA_ORIGIN') || !Object.hasOwn(env,'EXPECTED_MEDIA_VERSION') ||
        !/^https:\/\/[a-z0-9.-]+$/.test(env.APPROVED_MEDIA_ORIGIN||'') ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(env.EXPECTED_MEDIA_VERSION||'')) return env;
    return Object.fromEntries(Object.entries(env).filter(([key])=>!['APPROVED_MEDIA_ORIGIN','EXPECTED_MEDIA_VERSION'].includes(key)));
}
// Independently bundled: DB and originals only. No processing, promotion,
// derivative storage, GitHub or verifier transport. Terminal metadata purge is
// DB-only and separately bound to an owner-confirmed, active coordinated job.
export async function handleArchiveFinalizerRequest(request,env,dependencies={}) {
    if(isArchiveJobPath(request)) return handleArchiveJobRequest(request,env,{purpose:'finalizer',identity:'FINALIZER_IDENTITY',origin:'FINALIZER_ORIGIN',buckets:['PRIVATE_ORIGINALS']},dependencies,
        async ({env,identity,row,operation,main})=>{
            const scope=await issueArchiveFinalizerAuthority(env,identity,row.site_mode,row.asset_id);
            const dbOnly={DB:env.DB,APPROVED_MEDIA_ORIGIN:env.APPROVED_MEDIA_ORIGIN,EXPECTED_MEDIA_VERSION:env.EXPECTED_MEDIA_VERSION,ARCHIVE_SERVICE_IDENTITY:env.ARCHIVE_SERVICE_IDENTITY};
            return operation==='purge-inspect'?inspectPrivateArchivePurge(dbOnly,scope,row.site_mode,row.asset_id,main):
                purgePrivateArchiveMetadata(dbOnly,scope,row.site_mode,row.asset_id,{main,purgeKey:row.purge_key,expectedProofHash:row.expected_proof_hash});
        });
    try {
        const identity=await (dependencies.verifyAccessIdentity?dependencies.verifyAccessIdentity():verifyWorkerAccessIdentity(dependencies.accessContext,request));
        const url=new URL(request.url);
        if(identity?.type!=='service' || !/^[0-9a-f]{32}\.access$/.test(identity.subject||'') ||
            env.FINALIZER_IDENTITY!==`subject:${identity.subject}` || url.origin!==env.FINALIZER_ORIGIN || url.protocol!=='https:' ||
            request.headers.has('X-CSRF-Token') || request.headers.has('Cookie') && !/^CF_Authorization=[A-Za-z0-9._-]+$/.test(request.headers.get('Cookie'))) return adminFailure(403);
        const route=routePattern.exec(url.pathname);
        if(!route || url.search || url.hash || url.username || url.password) return adminFailure(404);
        if(Object.keys(env).sort().join('|')!=='APPROVED_MEDIA_ORIGIN|DB|EXPECTED_MEDIA_VERSION|FINALIZER_IDENTITY|FINALIZER_ORIGIN|PRIVATE_ORIGINALS') return adminFailure(503);
        if(request.method!=='POST') return adminFailure(405,{Allow:'POST'});
        const body=await readPrivateOwnerBody(request,32768,'application/json',dependencies.bodyTimeoutMilliseconds);
        if(!body.ok) return adminFailure(body.status);
        if(new TextDecoder('utf-8',{fatal:true}).decode(body.bytes)!=='{}') return adminFailure(422);
        env={...env,DB:env.DB.withSession?.('first-primary')||env.DB,ARCHIVE_SERVICE_IDENTITY:env.FINALIZER_IDENTITY};
        const row=await env.DB.prepare(`SELECT a.site_mode,d.reason FROM private_gallery_assets a
            JOIN private_archive_deletion_requests d USING(asset_id) WHERE a.asset_id=?1`).bind(route[1]).first();
        if(!row) return adminFailure(404);
        const scope=await issueArchiveFinalizerAuthority(env,identity,row.site_mode,route[1]);
        const result=await deletePrivateArchiveOriginal(env,scope,row.site_mode,route[1],row.reason);
        return result.ok?adminJson(200,result):adminFailure(result.status||409);
    } catch {return adminFailure(409);}
}
