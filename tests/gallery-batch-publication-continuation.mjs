import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {reviewedBatchFixture} from './helpers/gallery-batch-publication-fixture.mjs';
import {batchRun} from './helpers/private-gallery-batch-fixture.mjs';
import {runProtectedBatchPublication} from '../scripts/gallery-media/batch-publication-continuation.mjs';
import {runProtectedBatchReviewRefresh} from '../scripts/gallery-media/batch-review-refresh.mjs';
import {requestPrivateArchiveBatchPublication} from '../gallery-admin/src/private-gallery-batch-service.js';
import {changePrivateGalleryVisibility} from '../gallery-admin/src/private-gallery-visibility-service.js';
import {batchPublicationStep,safeArchiveDiagnostic,formatArchiveDiagnostic} from '../scripts/gallery-media/archive-diagnostics.mjs';

globalThis.fetch=()=>assert.fail('Publication continuation tests must never contact a remote service');
const executionRun='https://github.com/johnkevan88888/family-running/actions/runs/1001';
const refreshRun='https://github.com/johnkevan88888/family-running/actions/runs/1000';
const same=(a,b)=>assert.deepEqual(a,b);
const tables=f=>Object.fromEntries(f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({name})=>[name,f.db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all()]));
const immutable=f=>Object.fromEntries(Object.entries(tables(f)).filter(([name])=>!['private_gallery_batch_publications','private_gallery_batch_completions',
    'private_gallery_batch_member_origins'].includes(name)));
const count=(f,table)=>f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
const mutations=f=>[...f.original.calls,...f.staging.calls,...f.approved.calls].filter(([op])=>!['get','head'].includes(op));
const grant=async f=>assert.equal((await requestPrivateArchiveBatchPublication(f.env,f.owner,f.site,f.jobId,{idempotencyKey:crypto.randomUUID()})).ok,true);
const run=(f,phase='prepare',patch={})=>runProtectedBatchPublication({jobId:f.jobId,runReference:executionRun,phase,
    expectedBaseSha:f.github.state.main,jobs:f.c.jobs.promotion,promotion:f.c.promotion,github:f.github,...patch});
const ownerMerge=(f,headSha=f.review.review.headSha)=>{
    f.github.ownerMerge({...f.review.review,headSha});f.github.state.pulls[0].merged_by={login:'johnkevan88888'};
};
const corrupt=f=>{
    const row=f.db.prepare("SELECT object_key FROM private_gallery_pipeline_outputs WHERE attempt_id=? AND tier='approved' AND role='photo-thumbnail'").get(f.members[1].attemptId);
    f.approved.objects.get(row.object_key).bytes=Buffer.from('Synthetic invalid thumbnail');
};
let checks=0;

// Actual SQLite guards, protected HTTP adapters and byte checks, with generated
// pixels only. Both unchanged and refreshed reviews retain the original claim.
for(const site of ['family','everyone']) for(const refreshed of [false,true]) {
    const f=await reviewedBatchFixture(site);
    try {
        let head=f.review.review.headSha;
        if(refreshed) {
            f.github.advanceMain({'tests/released-runner.mjs':'synthetic current code'});
            head=(await runProtectedBatchReviewRefresh({jobId:f.jobId,runReference:refreshRun,expectedBaseSha:f.github.state.main,
                jobs:f.c.jobs.promotion,promotion:f.c.promotion,github:f.github})).headSha;
        }
        await grant(f);
        const before=tables(f),protectedBefore=immutable(f),sourceReads=f.original.calls.length,storageWrites=mutations(f),gitIndex=f.github.state.requests.length;
        const jobs=[];
        const prepare=await run(f,'prepare',{jobs:async(id,operation,value)=>{
            jobs.push({id,operation,value});return f.c.jobs.promotion(id,operation,value);
        }});
        assert.equal(prepare.state,'ready-for-separate-owner-merge');assert.equal(prepare.checkedHeadSha,head);
        assert.equal(prepare.originalRunReference,batchRun);assert.equal(prepare.executionRunReference,executionRun);
        assert.equal(prepare.claimHeld,true);assert.equal(prepare.publicationEnabled,false);
        same(tables(f),before);same(mutations(f),storageWrites);assert.equal(f.original.calls.length,sourceReads);
        assert(jobs.every((call,index)=>call.id===f.jobId && ['read','batch-publication-check'].includes(call.operation) &&
            call.value.runReference===(index===0?executionRun:batchRun)));
        assert(f.github.state.requests.slice(gitIndex).every(request=>request.method==='GET'));
        assert.equal(f.github.state.pulls[0].state,'open');assert.equal(count(f,'private_gallery_active_job'),1);
        await assert.rejects(run(f,'observe'),'Observation cannot perform the separate owner merge');
        ownerMerge(f,head);
        await assert.rejects(run(f,'prepare'),'Readiness cannot pretend an already-merged review is open');
        const observed=await run(f,'observe');assert.equal(observed.state,'publication-observed');assert.equal(observed.claimHeld,false);
        same(immutable(f),protectedBefore);same(mutations(f),storageWrites);assert.equal(f.original.calls.length,sourceReads);
        assert.equal(count(f,'private_gallery_active_job'),0);assert.equal(f.original.objects.size,2);
        assert.equal(count(f,'private_gallery_batch_member_origins'),2,'Existing SQL records each independently removable published member');
        const evidence=JSON.parse(f.db.prepare('SELECT evidence_json FROM private_gallery_batch_publications').get().evidence_json);
        assert.equal(evidence.headSha,f.review.review.headSha);assert.equal(evidence.baseSha,f.review.review.baseSha);
        const completed=tables(f);const replayCalls=[];
        const replay=await run(f,'observe',{jobs:async(...args)=>{replayCalls.push(args[1]);return f.c.jobs.promotion(...args);}});
        assert.equal(replay.replayed,true);same(tables(f),completed);assert(replayCalls.every(op=>op==='read'));
        assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);checks++;
    } finally {f.db.close();}
}

// Every caller-controlled identity change is rejected without claiming,
// processing, deleting, closing the PR or writing protected data.
{
    const f=await reviewedBatchFixture();
    try {
        const before=tables(f);
        await assert.rejects(run(f),'Owner grant must exist');same(tables(f),before);await grant(f);
        const baseline=tables(f),sourceReads=f.original.calls.length,storageWrites=mutations(f),gitIndex=f.github.state.requests.length;
        for(const mutate of [
            j=>{j.jobId='job_00000000-0000-4000-8000-000000000000';},j=>{j.action='review';},j=>{j.state='queued';},
            j=>{j.runReference=executionRun;},j=>{j.runReference='https://example.invalid/456';},j=>{delete j.runReference;},
            j=>{j.site='elsewhere';},j=>{j.publicationRequested=false;},j=>{j.reviewTerminal=true;},j=>{j.writeAdmitted=false;},
            j=>{j.baseSha='bad';},j=>{j.review.baseSha='c'.repeat(40);},j=>{j.candidate.targetRelativePath='gallery-data/everyone.json';},
            j=>{j.attempts=[];},j=>{j.attempts.push(j.attempts[0]);},j=>{j.attempts[0]='wrong';},j=>{j.members.reverse();},
            j=>{j.members[1].assetId=j.members[0].assetId;},j=>{j.members[0].closed=true;},j=>{j.result={state:'removed'};},
            j=>{j.review.headSha='a'.repeat(40);},j=>{j.candidate.itemIds.reverse();},j=>{j.review.extra=true;}
        ]) {
            await assert.rejects(run(f,'prepare',{jobs:async(...args)=>{
                assert.equal(args[1],'read');const result=await f.c.jobs.promotion(...args);mutate(result.value.job);return result;
            }}));
            same(tables(f),baseline);same(mutations(f),storageWrites);assert.equal(f.original.calls.length,sourceReads);checks++;
        }
        for(const patch of [{jobId:'bad'},{runReference:'bad'},{phase:'merge'},{expectedBaseSha:'bad'},{jobs:null},{promotion:null},{github:{}}]) {
            await assert.rejects(run(f,'prepare',patch));same(tables(f),baseline);checks++;
        }
        assert(f.github.state.requests.slice(gitIndex).every(r=>r.method==='GET'));
        assert.equal(f.github.state.pulls[0].state,'open');
    } finally {f.db.close();}
}

for(const failure of ['catalogue','approved-display','approved-thumbnail','staging-display','staging-thumbnail','hidden','closed',
    'suppressed','unknown-history','main-moved','refreshed-required','head-changed','member-race','grant-race','late-bytes','late-check']) {
    const f=await reviewedBatchFixture();
    try {
        await grant(f);const expectedBaseSha=f.github.state.main;
        if(failure==='catalogue') f.catalog.sourceRevision='sha256:'+'c'.repeat(64);
        if(/^(approved|staging)-/.test(failure)) {
            const [tier,role]=failure.split('-');
            const row=f.db.prepare('SELECT object_key FROM private_gallery_pipeline_outputs WHERE attempt_id=? AND tier=? AND role=?')
                .get(f.members[1].attemptId,tier,`photo-${role}`);
            f[tier].objects.get(row.object_key).bytes=Buffer.from('Synthetic corrupt bytes');
        }
        if(failure==='hidden') await changePrivateGalleryVisibility(f.env,f.owner,f.site,f.ids[0],{expectedVersion:2,idempotencyKey:crypto.randomUUID(),preference:'hidden'});
        if(failure==='closed') await f.c.promotion(f.members[0].attemptId,'close');
        if(failure==='suppressed') {
            const candidate=JSON.parse(f.db.prepare('SELECT candidate_json FROM private_gallery_batch_intents').get().candidate_json);
            f.github.state.suppression.hiddenAthleteIds=JSON.parse(candidate.manifestText).items[0].athleteIds;
        }
        if(['main-moved','refreshed-required'].includes(failure)) f.github.advanceMain({'tests/new-main.mjs':'unrefreshed'});
        if(failure==='unknown-history') f.github.state.pulls[0].body+='unexpected';
        const before=tables(f),sourceReads=f.original.calls.length,storageWrites=mutations(f),gitIndex=f.github.state.requests.length,events=[];
        let reads=0,checksCalled=0,pulls=0;
        f.github.state.hook=async(path,method)=>{
            if(method==='GET' && /^\/pulls\/\d+$/.test(path) && ++pulls===2) {
                if(failure==='late-bytes') corrupt(f);
                if(failure==='head-changed') f.github.state.pulls[0].head.sha='f'.repeat(40);
            }
        };
        const jobs=async(...args)=>{
            assert(['read','batch-publication-check'].includes(args[1]));
            const result=await f.c.jobs.promotion(...args);
            if(args[1]==='read' && ++reads===2) {
                if(failure==='member-race') result.value.job.members.reverse();
                if(failure==='grant-race') result.value.job.publicationRequested=false;
            }
            if(args[1]==='batch-publication-check' && ++checksCalled===2 && failure==='late-check') return {ok:false};
            return result;
        };
        await assert.rejects(run(f,'prepare',{jobs,expectedBaseSha:failure==='main-moved'?expectedBaseSha:f.github.state.main,reportFailure:e=>events.push(e)}),failure);
        same(tables(f),before);same(mutations(f),storageWrites);assert.equal(f.original.calls.length,sourceReads);
        assert(f.github.state.requests.slice(gitIndex).every(r=>r.method==='GET'));assert.equal(f.github.state.pulls[0].state,'open');
        assert(events.length>0,`${failure} has a clear failure stage`);
        if(/^(approved|staging)-/.test(failure)) assert(events.some(e=>e.stage==='photo-eligibility' && e.photoIndex===2));
        for(const secret of [f.jobId,...f.ids,...f.members.map(m=>m.attemptId)]) assert(!events.map(formatArchiveDiagnostic).join('').includes(secret));
        checks++;
    } finally {f.db.close();}
}

// No blind retry after uncertain writes. Actual durable readback distinguishes
// a lost completion response; an uncertain observation retains its claim.
for(const failure of ['observe-lost','complete-lost','complete-not-written','late-revocation','foreign-merger']) {
    const f=await reviewedBatchFixture();
    try {
        await grant(f);ownerMerge(f);if(failure==='foreign-merger') f.github.state.pulls[0].merged_by={login:'someone-else'};
        const before=immutable(f),storageWrites=mutations(f),sourceReads=f.original.calls.length,gitIndex=f.github.state.requests.length;
        const calls=[];
        const jobs=async(...args)=>{
            calls.push(args[1]);assert(['read','batch-publication-check','batch-publication-observe','complete'].includes(args[1]));
            if(args[1]!=='read') assert.equal(args[2].runReference,batchRun);
            if(args[1]==='complete' && failure==='complete-not-written') throw new Error('Synthetic lost request');
            const result=await f.c.jobs.promotion(...args);
            if(args[1]==='batch-publication-observe' && failure==='observe-lost' || args[1]==='complete' && failure==='complete-lost')
                throw new Error('Synthetic lost reply');
            if(args[1]==='batch-publication-observe' && failure==='late-revocation') corrupt(f);
            return result;
        };
        if(failure==='complete-lost') assert.equal((await run(f,'observe',{jobs})).state,'publication-observed');
        else await assert.rejects(run(f,'observe',{jobs}),failure);
        assert(calls.filter(op=>op==='complete').length<=1);assert(calls.filter(op=>op==='batch-publication-observe').length<=1);
        same(immutable(f),before);same(mutations(f),storageWrites);assert.equal(f.original.calls.length,sourceReads);
        assert(f.github.state.requests.slice(gitIndex).every(r=>r.method==='GET'));
        if(failure!=='complete-lost') assert.equal(count(f,'private_gallery_active_job'),1);
        if(['observe-lost','complete-not-written'].includes(failure)) {
            assert.equal((await run(f,'observe')).state,'publication-observed');assert.equal(count(f,'private_gallery_active_job'),0);
        }
        if(failure==='late-revocation') assert.equal(count(f,'private_gallery_batch_publications'),1,'Retain proven merge history without completing or deleting');
        checks++;
    } finally {f.db.close();}
}

const privateText='SECRET-PHOTO-CONSENT-MUST-NOT-LEAK';
const safe={kind:'batch-publication',stage:'photo-eligibility',reason:'step-failed',photoIndex:2,photoCount:2};
same(safeArchiveDiagnostic({...safe,error:new Error(privateText),url:privateText,body:privateText}),safe);
assert.equal(formatArchiveDiagnostic(safe),'Gallery stopped at batch publication / photo-eligibility / photo 2 of 2 (step-failed).\n');
for(const event of [{...safe,stage:privateText},{...safe,photoIndex:0},{...safe,photoCount:21},{...safe,reason:'http-status'}]) assert.equal(formatArchiveDiagnostic(event),'');
for(const observer of [()=>{throw new Error(privateText);},async()=>{throw new Error(privateText);}]) {
    const original=new Error(privateText);await assert.rejects(batchPublicationStep(observer)('job-read',()=>{throw original;}),e=>e===original);
}
const workflow=await readFile(new URL('../.github/workflows/gallery-batch-publication.yml',import.meta.url),'utf8');
assert.match(workflow,/workflow_dispatch:/);assert.match(workflow,/environment: gallery-processing/);
assert.match(workflow,/group: gallery-archive-publication-purge\s+cancel-in-progress: false/);
assert.match(workflow,/github\.ref == 'refs\/heads\/main'/);assert.match(workflow,/ref: \$\{\{ github.sha \}\}/);
assert.match(workflow,/persist-credentials: false/);assert.match(workflow,/timeout-minutes: 10/);
assert.match(workflow,/permission-pull-requests: read/);
same([...workflow.matchAll(/\$\{\{ inputs\.([^ }]+) \}\}/g)].map(m=>m[1]),['job_id','phase']);
assert.doesNotMatch(workflow,/GALLERY_PROCESSING_|GALLERY_WITHDRAWAL_|GALLERY_PUBLIC_HOST_|gallery-finalization|upload-artifact|pull_request_target:|schedule:|workflow_run:/);
for(const line of workflow.split('\n').filter(line=>line.includes('uses:'))) assert.match(line,/@[0-9a-f]{40}\b/);
const cliPath='scripts/run-gallery-batch-publication.mjs';
const env={...process.env,GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',
    GITHUB_REPOSITORY:'johnkevan88888/family-running',GITHUB_SHA:'a'.repeat(40),GALLERY_BASE_SHA:'a'.repeat(40),GITHUB_RUN_ID:'123',
    GALLERY_ARCHIVE_JOB_ID:'job_00000000-0000-4000-8000-000000000000',GALLERY_PUBLICATION_PHASE:'prepare'};
for(const change of [{GITHUB_ACTIONS:'false'},{GITHUB_EVENT_NAME:'push'},{GITHUB_REF:'refs/heads/untrusted'},
    {GITHUB_REPOSITORY:'someone/else'},{GALLERY_BASE_SHA:'b'.repeat(40)},{GITHUB_RUN_ID:'0'},{GALLERY_ARCHIVE_JOB_ID:'wrong'},{GALLERY_PUBLICATION_PHASE:'merge'}]) {
    const result=spawnSync(process.execPath,[cliPath],{encoding:'utf8',env:{...env,...change},timeout:10000});
    assert.equal(result.status,1);assert.match(result.stderr,/batch publication \/ configuration \(step-failed\)/);assert.equal(result.stdout,'');checks++;
}
const cli=await readFile(new URL(`../${cliPath}`,import.meta.url),'utf8');
assert.match(cli,/failures\+\+<32/);assert.match(cli,/verifyGalleryReviewBoundary/);assert.match(cli,/redirect:'error'/);
assert.match(cli,/readBoundedBytes\(response.body,2097152\)/);assert.match(cli,/setTimeout\(\(\)=>controller.abort\(\),10000\)/);
assert.doesNotMatch(cli,/error\.message|error\.stack|console\.(?:error|log)\(error/);
for(const stage of ['permission-boundary','service-configuration','job-read']) {
    const script=`
        import assert from 'node:assert/strict';
        const stage=${JSON.stringify(stage)},secret=${JSON.stringify(privateText)},base='a'.repeat(40);
        let count=0;
        globalThis.fetch=async(input,options)=>{
            count++;if(stage==='permission-boundary') throw new Error(secret);
            const url=typeof input==='string'?input:input.url;let value,status=200;
            if(url.endsWith('/git/ref/heads/main')) value={ref:'refs/heads/main',object:{type:'commit',sha:base}};
            else if(url.includes('/rules/branches/main?')) value=['update','pull_request','required_status_checks'].map(type=>({type,ruleset_id:18119142,ruleset_source_type:'Repository',ruleset_source:'johnkevan88888/family-running'}));
            else if(url.endsWith('/git/refs/heads/main')) {assert.equal(options.method,'PATCH');assert.deepEqual(JSON.parse(options.body),{sha:base,force:false});status=403;value={message:secret};}
            else {assert.equal(stage,'job-read');assert(url.endsWith('/read'));status=503;value={message:secret};}
            const response=new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
            Object.defineProperty(response,'url',{value:url});return response;
        };
        process.argv=[process.execPath,${JSON.stringify(cliPath)}];await import('./${cliPath}');
        assert.equal(count,stage==='permission-boundary'?1:stage==='service-configuration'?4:5);
    `;
    const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:10000,env:{...env,
        GALLERY_GITHUB_APP_TOKEN:privateText,GALLERY_PROMOTION_ORIGIN:stage==='service-configuration'?'https://wrong.invalid':
            'https://family-running-gallery-promotion-dev.family-running.workers.dev',GALLERY_PROMOTION_ACCESS_CLIENT_ID:'fixture',GALLERY_PROMOTION_ACCESS_CLIENT_SECRET:privateText}});
    assert.equal(result.status,1,result.stderr);assert.equal(result.stdout,'');assert(!result.stderr.includes(privateText));
    assert(result.stderr.includes(`batch publication / ${stage} (step-failed)`),result.stderr);checks++;
}
console.log(`Batch publication continuation: ${checks} synthetic cases passed; current code, original held claim, exact per-photo checks, read-only GitHub, owner-only merge, durable completion and no media mutation.`);
