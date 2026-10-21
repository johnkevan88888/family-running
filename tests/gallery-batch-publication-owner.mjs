import assert from 'node:assert/strict';
import {privateGalleryBatchFixture,batchRun} from './helpers/private-gallery-batch-fixture.mjs';
import {runProtectedArchiveJob} from '../scripts/gallery-media/protected-archive-job.mjs';
import {handleAdminRequest} from '../gallery-admin/src/admin-worker.js';
import {createBrowserSession} from '../gallery-admin/src/session.js';

// Actual owner router, migrated SQLite and pinned generated-photo processing.
// No external fetch transport, workflow dispatch or GitHub merge is supplied.
const origin='https://synthetic-batch-publication-owner.example';
for(const site of ['family','everyone']) {
    const f=await privateGalleryBatchFixture(site);
    try {
        const env={DB:f.env.DB,PRIVATE_ORIGINALS:f.original,ADMIN_ORIGIN:origin,
            OWNER_IDENTITIES:`subject:${f.owner.subject}`,SESSION_SECRET:'synthetic-batch-publication-owner-session'};
        const session=await createBrowserSession(f.owner,env,site,Date.now());
        const oppositeSite=site==='family'?'everyone':'family';
        const opposite=await createBrowserSession(f.owner,env,oppositeSite,Date.now());
        const headers={Cookie:session.cookie.split(';')[0],'X-CSRF-Token':session.csrfToken,Origin:origin,'Sec-Fetch-Site':'same-origin'};
        const dependencies={verifyAccessIdentity:async()=>f.owner,bodyTimeoutMilliseconds:15};
        const path=`/api/browser/private-batches/${f.jobId}/publication`;
        const input={idempotencyKey:crypto.randomUUID()};
        const request=(body=input,extra={},query=`?site=${site}`,method='POST',target=path)=>new Request(origin+target+query,{
            method,headers:{...headers,...(method==='POST'?{'Content-Type':'application/json'}:{}),...extra},
            body:method==='POST'?JSON.stringify(body):undefined});
        const run=(req,deps=dependencies)=>handleAdminRequest(req,env,deps);
        assert.equal((await run(request())).status,409,'Queued selection is not a saved review');
        const reviewed=await runProtectedArchiveJob({jobId:f.jobId,runReference:batchRun,phase:'review',...f.c,
            jobs:f.c.jobs.promotion,github:f.github});
        assert.equal(reviewed.state,'unmerged-review',JSON.stringify(reviewed));
        const protectedTables=['private_gallery_assets','private_gallery_asset_tags','private_gallery_attempts',
            'private_gallery_attempt_framings','private_archive_original_receipts','private_gallery_batch_reviews',
            'private_gallery_batch_claims','private_gallery_pipeline_byte_receipts'];
        const retained=()=>JSON.stringify(Object.fromEntries(protectedTables.map(table=>[table,f.db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()])));
        const before=retained(),mediaCalls=JSON.stringify([f.original.calls,f.staging.calls,f.approved.calls]);
        for(const [extra,identity] of [
            [{Cookie:''},f.owner],[{'X-CSRF-Token':'incorrect'},f.owner],[{Origin:'https://untrusted.example'},f.owner],
            [{'Sec-Fetch-Site':'cross-site'},f.owner],[{Cookie:opposite.cookie.split(';')[0],'X-CSRF-Token':opposite.csrfToken},f.owner],
            [{'Cf-Access-Client-Id':'not-owner'},f.owner],[{},null],[{},{type:'service',subject:f.owner.subject}],
            [{},{type:'browser',subject:'different-owner'}]
        ]) assert.equal((await run(request(input,extra),{...dependencies,verifyAccessIdentity:async()=>identity})).status,403);
        for(const query of ['', '?site=invalid',`?site=${site}&site=${site}`,`?site=${site}&target=everyone`])
            assert.equal((await run(request(input,{},query))).status,404);
        assert.equal((await run(request(input,{Cookie:opposite.cookie.split(';')[0],'X-CSRF-Token':opposite.csrfToken},`?site=${oppositeSite}`))).status,409);
        assert.equal((await run(request(undefined,{},`?site=${site}`,'GET'))).status,405);
        assert.equal((await run(request(input,{'Content-Encoding':'gzip'}))).status,400);
        assert.equal((await run(request(input,{'Content-Length':'999999'}))).status,413);
        for(const body of [{...input,siteMode:site},{...input,attemptIds:f.members.map(m=>m.attemptId)},
            {...input,pullRequest:reviewed.review.pullRequest.number},{...input,review:reviewed.review},
            {...input,runReference:batchRun},{idempotencyKey:'invalid'},null,[]])
            assert.equal((await run(request(body))).status,422);
        assert.equal((await run(request(input,{},`?site=${site}`,'POST',path+'/'))).status,404);
        const unknown=path.replace(f.jobId,`job_${crypto.randomUUID()}`);
        assert.equal((await run(request(input,{},`?site=${site}`,'POST',unknown))).status,409);
        const utf8=new Request(origin+path+`?site=${site}`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:new Uint8Array([255,254])});
        assert.equal((await run(utf8)).status,400);
        const stalled=new Request(origin+path+`?site=${site}`,{method:'POST',duplex:'half',headers:{...headers,'Content-Type':'application/json'},
            body:new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));},cancel(){return new Promise(()=>{});}})});
        const started=Date.now();assert.equal((await run(stalled)).status,400);assert.ok(Date.now()-started<1500);
        assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_batch_publication_requests').get().n,0);
        const response=await run(request());assert.equal(response.status,200,await response.clone().text());
        const saved=await response.json();assert.equal(saved.publicationEnabled,false);
        assert.equal(saved.job.publicationRequested,true);assert.equal(saved.job.runReference,batchRun);
        const grant=f.db.prepare('SELECT * FROM private_gallery_batch_publication_requests').get();
        assert.equal(grant.review_json,f.db.prepare('SELECT review_json FROM private_gallery_batch_reviews').get().review_json);
        assert.equal((await run(request())).status,200,'An uncertain reply retries the same exact grant');
        assert.equal((await run(request({idempotencyKey:crypto.randomUUID()}))).status,409,'A grant cannot be replaced');
        assert.deepEqual(f.db.prepare('SELECT * FROM private_gallery_batch_publication_requests').all(),[grant]);
        const listed=await (await run(new Request(`${origin}/api/browser/private-batches?site=${site}`,{headers}))).json();
        assert.equal(listed.batches[0].publicationRequested,true);
        assert.equal(listed.batches[0].reviewUrl,reviewed.review.pullRequest.url);
        assert.equal(retained(),before,'Owner approval cannot alter consent, photo, tags, framing, byte or review evidence');
        assert.equal(JSON.stringify([f.original.calls,f.staging.calls,f.approved.calls]),mediaCalls,'No media I/O from an owner grant');
        assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_active_job').get().n,1,'Original protected claim stays held');
        assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_batch_publications').get().n,0);
        assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_batch_completions').get().n,0);
        assert.equal(f.github.state.pulls[0].state,'open');assert.equal(f.github.state.manifests[site].items.length,0);
    } finally {f.db.close();}
}
console.log('Batch owner publication requests passed both areas: exact saved review, owner/session/CSRF/body limits, immutable replay, original claim retained and no consent/media/workflow/merge/publication I/O.');
