import {hashIdentity} from './session.js';
import {sha256Hex} from './media-byte-verification.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const attempt=/^attempt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const run=/^https:\/\/github\.com\/johnkevan88888\/family-running\/actions\/runs\/[1-9][0-9]*$/;
const sha=/^[0-9a-f]{40}$/;
const digest=value=>sha256Hex(new TextEncoder().encode(value));
const keys=(input,expected)=>input && Object.keys(input).sort().join('|')===expected;
const fail=(status=409)=>({ok:false,status,code:'private-batch-unavailable-or-pending'});
const first=(env,sql,...args)=>env.DB.prepare(sql).bind(...args).first();
const primary=env=>({...env,DB:env.DB.withSession?.('first-primary')||env.DB});
async function all(env,sql,...args) {
    const result=await env.DB.prepare(sql).bind(...args).all();
    if(result?.success!==true || !Array.isArray(result.results)) throw new Error('Unavailable');return result.results;
}
async function write(env,sql,...args) {
    const result=await env.DB.prepare(sql).bind(...args).run();if(result?.success!==true) throw new Error('Unavailable');
}
const summary=row=>({jobId:row.job_id,action:'batch-review',site:row.site_mode,attemptIds:JSON.parse(row.attempts_json),
    state:row.result_json?'removed':row.run_reference?'running':'queued',publicationEnabled:false,
    ...(row.run_reference?{runReference:row.run_reference}:{}),...(row.result_json?{result:JSON.parse(row.result_json)}:{}),
    ...(row.review_json && /^https:\/\/github\.com\/johnkevan88888\/family-running\/pull\/[1-9][0-9]*$/.test(JSON.parse(row.review_json).pullRequest?.url||'')?
        {reviewUrl:JSON.parse(row.review_json).pullRequest.url}:{})});

// This is an owner request, not aggregate consent. The HTTP caller must already
// have verified Access, the inherited-area signed session, Origin and CSRF.
export async function queuePrivateArchiveBatch(env,identity,site,input) {
    if(identity?.type!=='browser' || !['family','everyone'].includes(site)) return fail(403);
    if(!keys(input,'attemptIds|idempotencyKey') || !uuid.test(input.idempotencyKey||'') || !Array.isArray(input.attemptIds) ||
        input.attemptIds.length<1 || input.attemptIds.length>20 || new Set(input.attemptIds).size!==input.attemptIds.length ||
        input.attemptIds.some(id=>!attempt.test(id||''))) return fail(422);
    try {
        env=primary(env);const owner=await hashIdentity(identity),text=JSON.stringify(input.attemptIds);
        const find=()=>first(env,'SELECT * FROM private_gallery_batch_jobs WHERE owner_hash=?1 AND site_mode=?2 AND idempotency_key=?3',owner,site,input.idempotencyKey);
        let stored=await find();
        if(stored) return stored.attempts_json===text?{ok:true,status:200,job:summary(stored),replayed:true,publicationEnabled:false}:fail();
        const id=`job_${crypto.randomUUID()}`;
        try {await write(env,`INSERT INTO private_gallery_batch_jobs(job_id,job_hash,owner_hash,site_mode,attempts_json,idempotency_key)
            VALUES(?1,?2,?3,?4,?5,?6)`,id,await digest(`private-gallery-job-v1\0${id}`),owner,site,text,input.idempotencyKey);}
        catch {if(!await find()) throw new Error('Unavailable');}
        stored=await find();return stored.attempts_json===text?{ok:true,status:201,job:summary(stored),replayed:false,publicationEnabled:false}:fail();
    } catch {return fail();}
}
export async function readPrivateArchiveBatches(env,identity,site) {
    if(identity?.type!=='browser' || !['family','everyone'].includes(site)) return fail(403);
    try {
        env=primary(env);const owner=await hashIdentity(identity);
        const rows=await all(env,`SELECT b.*,c.run_reference,d.result_json,r.review_json FROM private_gallery_batch_jobs b
            LEFT JOIN private_gallery_batch_claims c USING(job_id) LEFT JOIN private_gallery_batch_completions d USING(job_id)
            LEFT JOIN private_gallery_batch_reviews r USING(job_id)
            WHERE b.owner_hash=?1 AND b.site_mode=?2 ORDER BY b.created_at,b.job_id LIMIT 101`,owner,site);
        if(rows.length>100) throw new Error('Unavailable');
        return {ok:true,status:200,batches:rows.map(summary),publicationEnabled:false};
    } catch {return fail();}
}
export async function readArchiveBatchJob(env,jobId) {
    const row=await first(env,`SELECT b.*,c.run_reference,d.result_json,i.base_sha,i.candidate_json,r.review_json,t.evidence_json
        FROM private_gallery_batch_jobs b LEFT JOIN private_gallery_batch_claims c USING(job_id)
        LEFT JOIN private_gallery_batch_completions d USING(job_id) LEFT JOIN private_gallery_batch_intents i USING(job_id)
        LEFT JOIN private_gallery_batch_reviews r USING(job_id) LEFT JOIN private_gallery_batch_terminals t USING(job_id) WHERE b.job_id=?1`,jobId);
    return row?{...row,action:'batch-review',completed_state:row.result_json?'removed':null}:null;
}
export async function archiveBatchSummary(env,row) {
    const members=await all(env,`SELECT m.attempt_id,m.asset_id,EXISTS(SELECT 1 FROM private_gallery_pipeline_closures c WHERE c.attempt_id=m.attempt_id) AS closed
        FROM private_gallery_batch_members m WHERE m.job_id=?1 ORDER BY m.ordinal`,row.job_id);
    if(members.length!==JSON.parse(row.attempts_json).length) throw new Error('Unavailable');
    return {...summary(row),attempts:members.map(m=>m.attempt_id),members:members.map(m=>({attemptId:m.attempt_id,assetId:m.asset_id,closed:m.closed===1})),
        reviewTerminal:Boolean(row.evidence_json),...(row.evidence_json?{terminalEvidence:JSON.parse(row.evidence_json)}:{}),
        ...(row.candidate_json?{baseSha:row.base_sha,candidate:JSON.parse(row.candidate_json)}:{}),
        ...(row.review_json?{review:JSON.parse(row.review_json)}:{})};
}
export async function claimArchiveBatchJob(env,row,runReference,purpose) {
    if(purpose!=='promotion' || !run.test(runReference||'')) throw new Error('Unavailable');
    if(row.run_reference && row.run_reference!==runReference) throw new Error('Rerun the original protected run.');
    if(!row.run_reference) {
        try {await write(env,'INSERT INTO private_gallery_batch_claims(job_id,run_reference) VALUES(?1,?2)',row.job_id,runReference);}
        catch {if((await readArchiveBatchJob(env,row.job_id))?.run_reference!==runReference) throw new Error('Unavailable');}
    }
    return readArchiveBatchJob(env,row.job_id);
}
export async function completeArchiveBatchJob(env,row,runReference,result) {
    if(row.run_reference!==runReference || !run.test(runReference||'') || !keys(result,'mainSha|ok|publicationEnabled|state') || result.ok!==true || result.state!=='removed' ||
        result.publicationEnabled!==false || !sha.test(result.mainSha||'')) throw new Error('Unavailable');
    const text=JSON.stringify({state:'removed',mainSha:result.mainSha,publicationEnabled:false});
    if(!row.result_json) {
        try {await write(env,'INSERT INTO private_gallery_batch_completions(job_id,result_json) VALUES(?1,?2)',row.job_id,text);}
        catch {if((await readArchiveBatchJob(env,row.job_id))?.result_json!==text) throw new Error('Unavailable');}
    }
    const stored=await readArchiveBatchJob(env,row.job_id);
    if(stored.result_json!==text) throw new Error('Changed replay');return archiveBatchSummary(env,stored);
}
