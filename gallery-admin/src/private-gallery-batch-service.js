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
    state:row.result_json?JSON.parse(row.result_json).state:row.run_reference?'running':'queued',publicationEnabled:false,
    publicationRequested:Boolean(row.publication_request_json),
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
        const rows=await all(env,`SELECT b.*,c.run_reference,d.result_json,r.review_json,p.review_json AS publication_request_json FROM private_gallery_batch_jobs b
            LEFT JOIN private_gallery_batch_claims c USING(job_id) LEFT JOIN private_gallery_batch_completions d USING(job_id)
            LEFT JOIN private_gallery_batch_reviews r USING(job_id)
            LEFT JOIN private_gallery_batch_publication_requests p USING(job_id)
            WHERE b.owner_hash=?1 AND b.site_mode=?2 ORDER BY b.created_at,b.job_id LIMIT 101`,owner,site);
        if(rows.length>100) throw new Error('Unavailable');
        return {ok:true,status:200,batches:rows.map(summary),publicationEnabled:false};
    } catch {return fail();}
}
export async function readArchiveBatchJob(env,jobId) {
    const row=await first(env,`SELECT b.*,c.run_reference,d.result_json,i.base_sha,i.candidate_json,r.review_json,t.evidence_json,
        p.review_json AS publication_request_json,o.evidence_json AS publication_evidence_json,
        EXISTS(SELECT 1 FROM private_gallery_batch_write_admissions w WHERE w.job_id=b.job_id) AS write_admitted
        FROM private_gallery_batch_jobs b LEFT JOIN private_gallery_batch_claims c USING(job_id)
        LEFT JOIN private_gallery_batch_completions d USING(job_id) LEFT JOIN private_gallery_batch_intents i USING(job_id)
        LEFT JOIN private_gallery_batch_reviews r USING(job_id) LEFT JOIN private_gallery_batch_terminals t USING(job_id)
        LEFT JOIN private_gallery_batch_publication_requests p USING(job_id) LEFT JOIN private_gallery_batch_publications o USING(job_id) WHERE b.job_id=?1`,jobId);
    return row?{...row,action:'batch-review',completed_state:row.result_json?JSON.parse(row.result_json).state:null}:null;
}
export async function archiveBatchSummary(env,row) {
    const members=await all(env,`SELECT m.attempt_id,m.asset_id,EXISTS(SELECT 1 FROM private_gallery_pipeline_closures c WHERE c.attempt_id=m.attempt_id) AS closed
        FROM private_gallery_batch_members m WHERE m.job_id=?1 ORDER BY m.ordinal`,row.job_id);
    if(members.length!==JSON.parse(row.attempts_json).length) throw new Error('Unavailable');
    return {...summary(row),attempts:members.map(m=>m.attempt_id),members:members.map(m=>({attemptId:m.attempt_id,assetId:m.asset_id,closed:m.closed===1})),
        reviewTerminal:Boolean(row.evidence_json),writeAdmitted:row.write_admitted===1,...(row.evidence_json?{terminalEvidence:JSON.parse(row.evidence_json)}:{}),
        ...(row.publication_evidence_json?{publicationEvidence:JSON.parse(row.publication_evidence_json)}:{}),
        ...(row.candidate_json?{baseSha:row.base_sha,candidate:JSON.parse(row.candidate_json)}:{}),
        ...(row.review_json?{review:JSON.parse(row.review_json)}:{})};
}
// The HTTP owner route supplies Access + signed area session + Origin + CSRF.
// This only records the exact existing review request; it cannot claim, merge,
// publish, extend consent, reset a run, or choose a destination.
export async function requestPrivateArchiveBatchPublication(env,identity,site,jobId,input) {
    if(identity?.type!=='browser' || !['family','everyone'].includes(site)) return fail(403);
    if(!keys(input,'idempotencyKey') || !uuid.test(input.idempotencyKey||'')) return fail(422);
    try {
        env=primary(env);const owner=await hashIdentity(identity),row=await readArchiveBatchJob(env,jobId);
        if(!row || row.owner_hash!==owner || row.site_mode!==site || !row.review_json) return fail();
        const prior=()=>first(env,'SELECT * FROM private_gallery_batch_publication_requests WHERE job_id=?1',jobId);
        let saved=await prior();
        if(!saved) {
            try {await write(env,`INSERT INTO private_gallery_batch_publication_requests(job_id,owner_hash,idempotency_key,review_json)
                VALUES(?1,?2,?3,?4)`,jobId,owner,input.idempotencyKey,row.review_json);}
            catch {if(!await prior()) throw new Error('Unavailable');}
            saved=await prior();
        }
        if(saved.owner_hash!==owner || saved.idempotency_key!==input.idempotencyKey || saved.review_json!==row.review_json) return fail();
        return {ok:true,status:200,job:summary(await readArchiveBatchJob(env,jobId)),publicationEnabled:false};
    } catch {return fail();}
}
// Explicit batch history, not a fabricated exact-one-photo candidate/review.
// Removal-only callers consume DB proof without importing promotion or bytes.
export async function readArchiveBatchMemberOrigin(env,attemptId) {
    const row=await first(env,`SELECT m.job_id,m.public_item_id,i.base_sha,i.candidate_json,r.review_json,p.evidence_json,o.item_json
        FROM private_gallery_batch_members m JOIN private_gallery_batch_intents i USING(job_id)
        LEFT JOIN private_gallery_batch_reviews r USING(job_id) LEFT JOIN private_gallery_batch_publications p USING(job_id)
        LEFT JOIN private_gallery_batch_member_origins o ON o.attempt_id=m.attempt_id WHERE m.attempt_id=?1`,attemptId);
    return row?{jobId:row.job_id,itemId:row.public_item_id,baseSha:row.base_sha,candidate:JSON.parse(row.candidate_json),
        ...(row.review_json?{review:JSON.parse(row.review_json)}:{}),...(row.evidence_json?{evidence:JSON.parse(row.evidence_json)}:{}),
        ...(row.item_json?{item:JSON.parse(row.item_json)}:{})}:null;
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
    const published=result?.state==='publication-observed';
    if(row.run_reference!==runReference || !run.test(runReference||'') || !keys(result,published?'evidence|ok|publicationEnabled|state':'mainSha|ok|publicationEnabled|state') || result.ok!==true ||
        !['removed','publication-observed'].includes(result.state) || result.publicationEnabled!==false ||
        (published?!row.publication_evidence_json || !keys(result.evidence,'baseRef|baseSha|branchRef|headSha|itemIds|mainSha|manifestSha256|mergeSha|pullRequest|repository|schemaVersion|state|targetRelativePath'):
            !sha.test(result.mainSha||''))) throw new Error('Unavailable');
    const text=JSON.stringify({state:result.state,...(published?{evidence:result.evidence}:{mainSha:result.mainSha}),publicationEnabled:false});
    if(!row.result_json) {
        try {await write(env,'INSERT INTO private_gallery_batch_completions(job_id,result_json) VALUES(?1,?2)',row.job_id,text);}
        catch {if((await readArchiveBatchJob(env,row.job_id))?.result_json!==text) throw new Error('Unavailable');}
    }
    const stored=await readArchiveBatchJob(env,row.job_id);
    if(stored.result_json!==text) throw new Error('Changed replay');return archiveBatchSummary(env,stored);
}
