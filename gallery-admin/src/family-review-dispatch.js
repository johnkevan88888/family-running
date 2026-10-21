// Fixed workflow only. This optional secret is NOT configured by a code release.
// It needs separately approved, repository-scoped Actions dispatch permission.
// No installation key, content write, merge or environment approval is accepted.
const endpoint='https://api.github.com/repos/johnkevan88888/family-running/actions/workflows/gallery-archive-job.yml/dispatches';
export async function dispatchFamilyReview(env,jobId,dependencies={}) {
    if(!/^job_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(jobId||'')) throw new Error('Invalid job');
    const find=()=>env.DB.prepare('SELECT state FROM family_gallery_dispatches WHERE job_id=?1').bind(jobId).first();
    const prior=await find();if(prior)return {state:prior.state,replayed:true};
    if(await env.DB.prepare('SELECT 1 FROM private_gallery_batch_claims WHERE job_id=?1').bind(jobId).first())return {state:'already-started',replayed:true};
    if(typeof env.FAMILY_REVIEW_DISPATCH_TOKEN!=='string'||!env.FAMILY_REVIEW_DISPATCH_TOKEN.trim()) return {state:'owner-start-required'};
    // Write the fence BEFORE transport. A timeout/unknown answer may mean that
    // GitHub accepted the job. Never issue a second dispatch automatically.
    try {
        const result=await env.DB.prepare("INSERT INTO family_gallery_dispatches(job_id,state) VALUES(?1,'admitted')").bind(jobId).run();
        if(result?.success!==true)throw new Error('Unavailable');
    } catch {const saved=await find();if(saved)return {state:saved.state,replayed:true};throw new Error('Unavailable');}
    let state='unknown',timer;const controller=new AbortController();
    try {
        const request=new Request(endpoint,{method:'POST',redirect:'error',signal:controller.signal,headers:{
            'Authorization':'Bearer '+env.FAMILY_REVIEW_DISPATCH_TOKEN,'Accept':'application/vnd.github+json',
            'Content-Type':'application/json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'family-gallery-owner'},
            body:JSON.stringify({ref:'main',inputs:{job_id:jobId},return_run_details:false})});
        state=await Promise.race([(async()=>{
            const response=await (dependencies.dispatchFetch||fetch)(request);
            if(response.status===204&&!response.redirected&&!response.body)return 'acknowledged';
            if(response.body)await response.body.cancel();return 'unknown';
        })(),new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve('unknown');},5000);})]);
    } catch { /* Unknown outcomes stay fenced. Provider errors never reach logs/UI. */ }
    finally {clearTimeout(timer);controller.abort();}
    try {await env.DB.prepare("UPDATE family_gallery_dispatches SET state=?1 WHERE job_id=?2 AND state='admitted'").bind(state,jobId).run();}
    catch {return {state:'admitted'};}
    return {state};
}
