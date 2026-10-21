import {hashIdentity} from './session.js';
import {sha256Hex} from './media-byte-verification.js';
import {readArchiveBatchJob,claimArchiveBatchJob,completeArchiveBatchJob} from './private-gallery-batch-service.js';
const digest=value=>sha256Hex(new TextEncoder().encode(value));
export const archiveJobHash=id=>digest(`private-gallery-job-v1\0${id}`);
export const archiveRunHash=reference=>digest(`private-gallery-run-v1\0${reference}`);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const job=/^job_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const run=/^https:\/\/github\.com\/johnkevan88888\/family-running\/actions\/runs\/[1-9][0-9]*$/;
const fail=(status=409)=>({ok:false,status,code:'archive-job-unavailable-or-pending'});
const primary=env=>({...env,DB:env.DB.withSession?.('first-primary')||env.DB});
const first=(env,sql,...args)=>env.DB.prepare(sql).bind(...args).first();
const keys=(input,expected)=>input && Object.keys(input).sort().join('|')===expected;
async function ownerAsset(env,identity,site,assetId) {
    if(identity?.type!=='browser' || !['family','everyone'].includes(site)) throw new Error('Unavailable');
    const owner=await hashIdentity(identity);
    const row=await first(env,'SELECT 1 FROM private_gallery_assets WHERE asset_id=?1 AND site_mode=?2 AND owner_identity_hash=?3',assetId,site,owner);
    if(!row) throw new Error('Unavailable');return owner;
}
const safe=row=>({jobId:row.job_id,action:row.action,attemptId:row.attempt_id,state:row.completed_state||
    (row.run_reference?'running':'queued'),...(row.run_reference?{runReference:row.run_reference}:{}),
    ...(row.result_json?{result:JSON.parse(row.result_json)}:{}),publicationEnabled:false});
export async function readPrivateArchiveJobs(env,identity,site,assetId) {
    try {
        env=primary(env);await ownerAsset(env,identity,site,assetId);
        const jobs=await env.DB.prepare(`SELECT j.*,c.run_reference,d.state AS completed_state,d.result_json
            FROM private_gallery_owner_jobs j LEFT JOIN private_gallery_job_claims c USING(job_id)
            LEFT JOIN private_gallery_job_completions d USING(job_id) WHERE j.asset_id=?1 ORDER BY j.created_at,j.job_id LIMIT 1001`).bind(assetId).all();
        const attempts=await env.DB.prepare(`SELECT a.attempt_id,EXISTS(SELECT 1 FROM private_gallery_pipeline_closures c WHERE c.attempt_id=a.attempt_id) AS closed
            FROM private_gallery_attempts a WHERE a.asset_id=?1 ORDER BY a.created_at,a.attempt_id LIMIT 1001`).bind(assetId).all();
        if(jobs?.success!==true || attempts?.success!==true || !Array.isArray(jobs.results) || !Array.isArray(attempts.results) ||
            jobs.results.length>1000 || attempts.results.length>1000) throw new Error('Unavailable');
        return {ok:true,status:200,jobs:jobs.results.map(safe),attempts:attempts.results.map(r=>({attemptId:r.attempt_id,closed:r.closed===1})),publicationEnabled:false};
    } catch {return fail(404);}
}
export async function queuePrivateArchiveJob(env,identity,site,assetId,input) {
    const fields=input?.action==='purge'?'action|expectedProofHash|idempotencyKey|purgeKey':
        ['review','publication'].includes(input?.action)?'action|attemptId|idempotencyKey':'action|idempotencyKey';
    if(!keys(input,fields) || !uuid.test(input.idempotencyKey||'') || !['review','removal','publication','purge-inspect','purge'].includes(input.action) ||
        (['review','publication'].includes(input.action) && !/^attempt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.attemptId||'')) ||
        (input.action==='purge' && (!/^[0-9a-f]{64}$/.test(input.expectedProofHash||'') || !uuid.test(input.purgeKey||'')))) return fail(422);
    try {
        env=primary(env);const owner=await ownerAsset(env,identity,site,assetId);
        const find=()=>first(env,'SELECT * FROM private_gallery_owner_jobs WHERE owner_hash=?1 AND site_mode=?2 AND idempotency_key=?3',owner,site,input.idempotencyKey);
        const matches=row=>row.asset_id===assetId && row.action===input.action && row.attempt_id===(input.attemptId??null) &&
            row.expected_proof_hash===(input.expectedProofHash??null) && row.purge_key===(input.purgeKey??null);
        let stored=await find();
        if(stored) return matches(stored)?{ok:true,status:200,job:safe(stored),replayed:true,publicationEnabled:false}:fail();
        try {
            const id=`job_${crypto.randomUUID()}`;
            const purgeScope=input.action==='purge'?await digest(JSON.stringify(['private-gallery-purge-v1',owner,site,assetId,input.purgeKey])):null;
            const result=await env.DB.prepare(`INSERT INTO private_gallery_owner_jobs(job_id,job_hash,asset_id,owner_hash,site_mode,action,attempt_id,idempotency_key,expected_proof_hash,purge_key,purge_scope_hash)
                VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`).bind(id,await archiveJobHash(id),assetId,owner,site,input.action,input.attemptId??null,
                    input.idempotencyKey,input.expectedProofHash??null,input.purgeKey??null,purgeScope).run();
            if(result?.success!==true) throw new Error('Unavailable');
        } catch {if(!await find()) throw new Error('Unavailable');}
        stored=await find();return matches(stored)?{ok:true,status:201,job:safe(stored),replayed:false,publicationEnabled:false}:fail();
    } catch {return fail();}
}
// Exact Access-purpose gates precede these service helpers. Non-expiring global
// claims recover only in the SAME Actions run (rerun it), never a new run which
// assumes the previous process or an in-flight request has stopped.
export async function readArchiveJob(env,jobId) {
    if(!job.test(jobId||'')) throw new Error('Unavailable');
    const row=await first(env,`SELECT j.*,c.run_reference,d.state AS completed_state,d.result_json
        FROM private_gallery_owner_jobs j LEFT JOIN private_gallery_job_claims c USING(job_id)
        LEFT JOIN private_gallery_job_completions d USING(job_id) WHERE j.job_id=?1`,jobId);
    if(!row) {
        const batch=await readArchiveBatchJob(env,jobId);
        if(!batch) throw new Error('Unavailable');return batch;
    }
    return row;
}
export async function claimArchiveJob(env,jobId,runReference,purpose) {
    if(!run.test(runReference||'')) throw new Error('Unavailable');
    const row=await readArchiveJob(env,jobId);
    if(row.action==='batch-review') return claimArchiveBatchJob(env,row,runReference,purpose);
    if((['purge','purge-inspect'].includes(row.action)?'finalizer':'promotion')!==purpose) throw new Error('Unavailable');
    if(row.run_reference && row.run_reference!==runReference) throw new Error('Rerun the original protected run.');
    if(!row.run_reference) {
        try {
            const result=await env.DB.prepare('INSERT INTO private_gallery_job_claims(job_id,run_reference,run_hash) VALUES(?1,?2,?3)')
                .bind(jobId,runReference,await archiveRunHash(runReference)).run();
            if(result?.success!==true) throw new Error('Unavailable');
        } catch {if((await readArchiveJob(env,jobId)).run_reference!==runReference) throw new Error('Unavailable');}
    }
    return readArchiveJob(env,jobId);
}
export async function completeArchiveJob(env,jobId,runReference,result) {
    const row=await readArchiveJob(env,jobId);
    if(row.action==='batch-review') return completeArchiveBatchJob(env,row,runReference,result);
    if(row.run_reference!==runReference || !run.test(runReference||'') || result?.ok!==true || result.publicationEnabled!==false ||
        !['unmerged-review','unmerged-removal-review','removed','publication-observed','publication-revoked','purge-eligible'].includes(result.state) ||
        new TextEncoder().encode(JSON.stringify(result)).length>32768) throw new Error('Unavailable');
    const outcomes={review:['unmerged-review','unmerged-removal-review','removed'],removal:['unmerged-removal-review','removed'],
        publication:['publication-observed','publication-revoked'],'purge-inspect':['purge-eligible'],purge:[]};
    if(!outcomes[row.action]?.includes(result.state)) throw new Error('Unavailable');
    if(result.review && !/^https:\/\/github\.com\/johnkevan88888\/family-running\/pull\/[1-9][0-9]*$/.test(result.review.pullRequest?.url||'')) throw new Error('Unavailable');
    if(result.state==='publication-observed' && (Object.keys(result.evidence||{}).sort().join('|')!=='headSha|mainSha|mergeSha|pullRequestNumber|state' ||
        result.evidence.state!=='merged-by-owner' || !['headSha','mainSha','mergeSha'].every(field=>/^[0-9a-f]{40}$/.test(result.evidence[field]||'')) ||
        !Number.isSafeInteger(result.evidence.pullRequestNumber) || result.evidence.pullRequestNumber<1)) throw new Error('Unavailable');
    if(result.state==='purge-eligible' && (!/^[0-9a-f]{64}$/.test(result.proofHash||'') || result.dryRun!==true)) throw new Error('Unavailable');
    const safeResult={state:result.state,publicationEnabled:false,
        ...(result.review?{reviewUrl:result.review.pullRequest.url}:{}),...(result.mainSha?{mainSha:result.mainSha}:{}),
        ...(result.evidence?{evidence:result.evidence}:{}),...(result.proofHash?{proofHash:result.proofHash}:{}),
        ...(result.attemptCount!==undefined?{attemptCount:result.attemptCount,outputCount:result.outputCount}:{}),
        ...(result.dryRun===true?{dryRun:true}:{})};
    const text=JSON.stringify(safeResult);
    if(row.completed_state) {
        if(row.completed_state!==result.state || row.result_json!==text) throw new Error('Changed replay');return safe(row);
    }
    try {
        const written=await env.DB.prepare('INSERT INTO private_gallery_job_completions(job_id,state,result_json) VALUES(?1,?2,?3)')
            .bind(jobId,result.state,text).run();if(written?.success!==true) throw new Error('Unavailable');
    } catch {if((await readArchiveJob(env,jobId)).result_json!==text) throw new Error('Unavailable');}
    return safe(await readArchiveJob(env,jobId));
}
export function archiveJobSummary(row) {return safe(row);}
export async function readRetiredArchiveJob(env,jobId,runReference) {
    if(!job.test(jobId||'') || !run.test(runReference||'')) throw new Error('Unavailable');
    const row=await first(env,'SELECT proof_hash FROM private_gallery_retired_jobs WHERE job_hash=?1 AND run_hash=?2',
        await archiveJobHash(jobId),await archiveRunHash(runReference));
    return row?{ok:true,state:'private-records-purged',proofHash:row.proof_hash,replayed:true,publicationEnabled:false}:null;
}
