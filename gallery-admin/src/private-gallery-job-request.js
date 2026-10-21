import {verifyWorkerAccessIdentity} from './access.js';
import {adminFailure,adminJson} from './responses.js';
import {readPrivateOwnerBody} from './private-gallery-owner-service.js';
import {readArchiveMediaEpoch} from './private-gallery-service-authority.js';
import {readArchiveJob,claimArchiveJob,completeArchiveJob,archiveJobSummary,readRetiredArchiveJob} from './private-gallery-job-service.js';
import {archiveBatchSummary} from './private-gallery-batch-service.js';
const path=/^\/api\/service\/archive-jobs\/(job_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/(read|claim|complete|purge-inspect|purge|batch-reserve|batch-write|batch-open|batch-terminal|batch-publication-check|batch-publication-observe)$/;
export function isArchiveJobPath(request) {return new URL(request.url).pathname.startsWith('/api/service/archive-jobs/');}
export async function handleArchiveJobRequest(request,env,config,dependencies={},executePurge,catalog=null,executeBatchOperation) {
    const purpose=config.purpose;
    try {
        const identity=await (dependencies.verifyAccessIdentity?dependencies.verifyAccessIdentity():verifyWorkerAccessIdentity(dependencies.accessContext,request));
        const url=new URL(request.url);
        if(identity?.type!=='service' || !/^[0-9a-f]{32}\.access$/.test(identity.subject||'') ||
            env[config.identity]!==`subject:${identity.subject}` || url.origin!==env[config.origin] || url.protocol!=='https:' ||
            request.headers.has('X-CSRF-Token') || request.headers.has('Cookie') && !/^CF_Authorization=[A-Za-z0-9._-]+$/.test(request.headers.get('Cookie')))
            return adminFailure(403);
        const route=path.exec(url.pathname);
        if(!route || url.search || url.hash || url.username || url.password) return adminFailure(404);
        if(Object.keys(env).sort().join('|')!==['DB','APPROVED_MEDIA_ORIGIN','EXPECTED_MEDIA_VERSION',config.identity,config.origin,...config.buckets].sort().join('|') ||
            !/^https:\/\/[a-z0-9.-]+$/.test(env.APPROVED_MEDIA_ORIGIN||'') ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(env.EXPECTED_MEDIA_VERSION||'')) return adminFailure(503);
        if(request.method!=='POST') return adminFailure(405,{Allow:'POST'});
        const [jobId,operation]=route.slice(1);
        if(['purge-inspect','purge'].includes(operation) && purpose!=='finalizer') return adminFailure(404);
        if(operation.startsWith('batch-') && (purpose!=='promotion' || typeof executeBatchOperation!=='function')) return adminFailure(404);
        const body=await readPrivateOwnerBody(request,['purge-inspect','purge','batch-reserve'].includes(operation)?2097152:32768,'application/json',dependencies.bodyTimeoutMilliseconds);
        if(!body.ok) return adminFailure(body.status);
        const input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body.bytes));
        const expected=['purge-inspect','purge','batch-reserve'].includes(operation)?'main|runReference':operation==='complete'?'result|runReference':
            operation==='batch-open'?'review|runReference':['batch-terminal','batch-publication-observe'].includes(operation)?'evidence|runReference':'runReference';
        if(Object.keys(input||{}).sort().join('|')!==expected || !/^https:\/\/github\.com\/johnkevan88888\/family-running\/actions\/runs\/[1-9][0-9]*$/.test(input.runReference||'')) return adminFailure(422);
        env={...env,DB:env.DB.withSession?.('first-primary')||env.DB,ARCHIVE_SERVICE_IDENTITY:env[config.identity]};
        if(purpose==='finalizer') {
            const replay=await readRetiredArchiveJob(env,jobId,input.runReference);
            if(replay) return adminJson(200,replay); // No asset, epoch, host, storage or GitHub work.
        }
        await readArchiveMediaEpoch(env);
        const row=operation==='claim'?await claimArchiveJob(env,jobId,input.runReference,purpose):await readArchiveJob(env,jobId);
        const required=['purge','purge-inspect'].includes(row.action)?'finalizer':'promotion';
        // The finalizer can read a claimed removal job for its ORIGINAL-only
        // step; it cannot claim/complete that job or act as the promoter.
        if(required!==purpose && !(purpose==='finalizer' && operation==='read' && ['review','removal','batch-review'].includes(row.action) && row.run_reference===input.runReference)) return adminFailure(403);
        if(operation!=='read' && row.run_reference!==input.runReference) return adminFailure(409);
        if(operation==='complete') {
            if(row.action==='batch-review' && input.result?.state==='publication-observed' && !row.result_json) {
                // Ledger completion is deliberately capability-free. Only the
                // promoter can recheck current catalogue, framing and actual
                // bytes here; the finalizer never imports that implementation.
                if(purpose!=='promotion' || typeof executeBatchOperation!=='function') return adminFailure(404);
                await executeBatchOperation(env,identity,row,catalog,'batch-publication-check',{runReference:input.runReference});
            }
            return adminJson(200,{ok:true,job:await completeArchiveJob(env,jobId,input.runReference,input.result)});
        }
        if(operation.startsWith('batch-')) return adminJson(200,await executeBatchOperation(env,identity,row,catalog,operation,input));
        if(row.action==='batch-review') return adminJson(200,{ok:true,job:await archiveBatchSummary(env,row)});
        if(['purge-inspect','purge'].includes(operation)) {
            if(!['purge','purge-inspect'].includes(row.action) || row.completed_state || operation==='purge' && row.action!=='purge') return adminFailure(409);
            if(typeof executePurge!=='function') return adminFailure(404);
            const result=await executePurge({env,identity,row,operation,main:input.main});
            return result.ok?adminJson(200,result):adminFailure(result.status||409);
        }
        const attempts=await env.DB.prepare('SELECT attempt_id FROM private_gallery_attempts WHERE asset_id=?1 ORDER BY created_at,attempt_id LIMIT 1001').bind(row.asset_id).all();
        if(attempts?.success!==true || !Array.isArray(attempts.results) || attempts.results.length>1000) throw new Error('Unavailable');
        const deletion=await env.DB.prepare('SELECT 1 FROM private_archive_deletion_requests WHERE asset_id=?1').bind(row.asset_id).first();
        return adminJson(200,{ok:true,job:{...archiveJobSummary(row),assetId:row.asset_id,attempts:attempts.results.map(r=>r.attempt_id),
            deletionRequested:Boolean(deletion),...(row.expected_proof_hash?{expectedProofHash:row.expected_proof_hash}:{})}});
    } catch {return adminFailure(409);}
}
