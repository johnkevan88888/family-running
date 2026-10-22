import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {setImmediate as flush} from 'node:timers/promises';
import {readFile} from 'node:fs/promises';
import {createArchiveServiceClient,createArchiveJobClient,createArchiveFinalizerClient} from '../scripts/gallery-media/archive-service-client.mjs';
import {archivePhotoStep,safeArchiveDiagnostic,formatArchiveDiagnostic,reportArchiveDiagnostic} from '../scripts/gallery-media/archive-diagnostics.mjs';
import {processingError} from '../scripts/gallery-media/errors.mjs';
import {runProtectedArchiveJob} from '../scripts/gallery-media/protected-archive-job.mjs';
import {familyUploaderFixture} from './helpers/family-uploader-fixture.mjs';
import {privateGalleryJobFixture} from './helpers/private-gallery-job-fixture.mjs';
import {syntheticGitHub} from './helpers/private-gallery-lifecycle-fixtures.mjs';

globalThis.fetch=()=>assert.fail('Handoff tests must not contact a remote service');
const attemptId='attempt_11111111-1111-4111-8111-111111111111';
const jobId='job_11111111-1111-4111-8111-111111111111';
const assetId='asset_11111111-1111-4111-8111-111111111111';
const origin='https://family-running-gallery-processing-dev.family-running.workers.dev';
const secret='PRIVATE-SECRET-MUST-NEVER-APPEAR';
const runReference='https://github.com/johnkevan88888/family-running/actions/runs/765';
const events=[];
const config=(fetchImpl,extra={})=>({purpose:'processing',origin,clientId:'fixture-client',clientSecret:secret,
    fetchImpl,reportFailure:event=>events.push(event),...extra});
function response(request,options={}) {
    const res=new Response(options.body??'{}',{status:options.status??200,
        headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...options.headers}});
    Object.defineProperty(res,'url',{value:options.url??request.url});return res;
}
for(const [options,reason] of [
    [{url:'https://untrusted.invalid/'+secret},'response-origin'],
    [{headers:{'Cache-Control':'public'}},'response-cache'],
    [{headers:{'Content-Type':'text/html'},body:secret},'response-type'],
    [{body:secret},'response-body'],[{body:new Uint8Array([255])},'response-body'],
    [{body:' '.repeat(2097153)},'response-body'],
    [{body:'{"framingSource":null}'},'framing-response'],
    [{status:403,body:JSON.stringify({error:secret})},'http-status']]) {
    events.length=0;let calls=0;
    const client=createArchiveServiceClient(config(async req=>{calls++;return response(req,options);}));
    assert.equal((await client(attemptId,'start')).ok,false);assert.equal(calls,1);
    assert.deepEqual(events,[{kind:'transport',service:'processing',operation:'start',reason,...(options.status?{status:403}:{})}]);
}
events.length=0;
assert.equal((await createArchiveServiceClient(config(async()=>{throw new Error(secret);}))(attemptId,'start')).ok,false);
assert.equal(events[0].reason,'transport-unavailable');
for(const [headers,body,reason] of [
    [{'Content-Length':'2'},'xx','source-headers'],
    [{'Content-Type':'image/jpeg','Content-Length':'2','X-Gallery-Sha256':'a'.repeat(64)},'x','response-length'],
    [{'Content-Type':'image/jpeg','Content-Length':'1','X-Gallery-Sha256':'a'.repeat(64)},'xx','response-body']]) {
    events.length=0;
    const result=await createArchiveServiceClient(config(async req=>response(req,{headers,body})))(attemptId,'original');
    assert.equal(result.ok,false);assert.equal(events[0].reason,reason);
}

// A timed-out exchange is terminal even if an injected transport ignores abort.
// Its late rejection cannot replace/duplicate the primary diagnostic or retry.
for(const purpose of ['processing','promotion','finalizer']) {
    events.length=0;let release,request,calls=0;
    mock.timers.enable({apis:['setTimeout']});
    try {
        const clientConfig=config(req=>{calls++;request=req;return new Promise(resolve=>{release=resolve;});},{purpose,
            origin:`https://family-running-gallery-${purpose==='finalizer'?'withdrawal-finalizer':purpose}-dev.family-running.workers.dev`});
        const client=purpose==='processing'?createArchiveServiceClient(clientConfig):purpose==='promotion'?createArchiveJobClient(clientConfig):createArchiveFinalizerClient(clientConfig);
        const pending=purpose==='processing'?client(attemptId,'start'):purpose==='promotion'?client(jobId,'read',{}):client(assetId);
        mock.timers.tick(10000);assert.equal((await pending).ok,false);assert.equal(request.signal.aborted,true);
        assert.equal(events.length,1);assert.equal(events[0].reason,'timeout');
        release(response(request,{status:503,body:JSON.stringify({error:secret})}));await flush();
        assert.equal(events.length,1);assert.equal(calls,1);
    } finally {mock.timers.reset();}
}

// Neither raw errors nor attacker-supplied strings/extra fields may escape.
for(const event of [{kind:'photo-handoff',stage:secret,photoIndex:1,photoCount:2,reason:'step-failed'},
    {kind:'transport',service:'processing',operation:'start',reason:secret},
    {kind:'photo-handoff',stage:'admission',photoIndex:0,photoCount:2,reason:'step-failed'},
    {kind:'photo-handoff',stage:'admission',photoIndex:1,photoCount:21,reason:'step-failed'}]) {
    assert.equal(safeArchiveDiagnostic(event),null);assert.equal(formatArchiveDiagnostic(event),'');
}
const safe={kind:'photo-handoff',stage:'metadata-stripping',photoIndex:1,photoCount:2,reason:'source-rejected'};
assert.deepEqual(safeArchiveDiagnostic({...safe,message:secret,stack:secret,bytes:secret}),safe);
assert.equal(formatArchiveDiagnostic(safe),'Gallery stopped at Photo 1 of 2: metadata-stripping (source-rejected).\n');
events.length=0;
await assert.rejects(archivePhotoStep(e=>events.push(e),1,2)('metadata-stripping',()=>{throw processingError('source-rejected');}));
assert.deepEqual(events,[safe]);
await assert.rejects(archivePhotoStep(()=>{throw new Error(secret);})('admission',()=>{throw new Error('original');}),/original/);
reportArchiveDiagnostic(async()=>{throw new Error(secret);},safe);await flush();

// Actual generated JPEGs, metadata stripping, HTTP adapters, standing permission
// and two private-only tagged photos. Fake storage/GitHub, no live operations.
for(const fault of [null,'admission','original-download','metadata-stripping','framing-check','photo-display','photo-thumbnail','promotion']) {
    const f=await familyUploaderFixture({submitted:true,count:2,publicAssociation:false});
    try {
        const diagnostics=[],reportFailure=event=>diagnostics.push(event),c=await privateGalleryJobFixture(f,{reportFailure}),github=syntheticGitHub();
        const attempts=f.db.prepare('SELECT * FROM private_gallery_attempts ORDER BY attempt_id').all();
        const originals=f.db.prepare('SELECT * FROM private_archive_original_receipts ORDER BY asset_id').all();
        const tags=f.db.prepare('SELECT * FROM private_gallery_asset_tags ORDER BY asset_id,person_id').all();
        const frames=f.db.prepare('SELECT * FROM private_gallery_attempt_framings ORDER BY attempt_id').all();
        const processing=c.processing,promotion=c.promotion;let current=0;
        c.processing=async(id,op,value)=>{
            if(op==='start')current++;
            const stage={start:'admission',original:'original-download','photo-display':'photo-display','photo-thumbnail':'photo-thumbnail'}[op];
            if(fault===stage && current===2)return {ok:false};
            const result=await processing(id,op,value);
            if(current===2 && result.ok && fault==='metadata-stripping' && op==='original')return {...result,value:{...result.value,sha256:'f'.repeat(64)}};
            if(current===2 && result.ok && fault==='framing-check' && op==='start')return {...result,value:{...result.value,
                framingSource:{...result.value.framingSource,imageWidth:513}}};
            return result;
        };
        c.promotion=(id,op,value)=>fault==='promotion' && current===2 && op==='promote'?Promise.resolve({ok:false}):promotion(id,op,value);
        const execute=(phase,purpose='promotion')=>runProtectedArchiveJob({jobId:f.jobId,runReference,phase,...c,jobs:c.jobs[purpose],github,reportFailure});
        const result=await execute('review');
        if(!fault) {
            assert.equal(result.state,'unmerged-review');assert.equal(github.state.pulls.length,1);assert.deepEqual(diagnostics,[]);
            const intent=f.db.prepare('SELECT candidate_json FROM private_gallery_batch_intents').get();
            const manifest=JSON.parse(JSON.parse(intent.candidate_json).manifestText);
            assert.equal(manifest.items.length,2);assert.ok(manifest.items.every(item=>item.athleteIds.length===0 && !Object.hasOwn(item,'podiumFraming')));
            assert.equal(github.state.manifests.family.items.length,0);
        } else {
            assert.deepEqual(result,{ok:false,state:'pending',publicationEnabled:false});assert.equal(github.state.pulls.length,0);
            assert.deepEqual(diagnostics,[{kind:'photo-handoff',photoIndex:2,photoCount:2,stage:fault,
                reason:fault==='metadata-stripping'?'source-rejected':'step-failed'}]);
            assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_pipeline_closures').get().n,2);
            assert.equal(f.staging.objects.size,0);assert.equal(f.approved.objects.size,1,'Only fixed witness remains');
            assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_active_job').get().n,1,'Failure reporting cannot release the claim');
            assert.equal((await execute('verify','finalizer')).state,'host-ready');
            assert.equal((await execute('reconcile')).state,'removed');
            assert.equal((await execute('finalize','finalizer')).state,'hidden-original-retained');
            assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_active_job').get().n,0);
            assert.ok(f.hostRequests.length>0,'Storage absence is not host absence');
        }
        assert.deepEqual(f.db.prepare('SELECT * FROM private_gallery_attempts ORDER BY attempt_id').all(),attempts);
        assert.deepEqual(f.db.prepare('SELECT * FROM private_archive_original_receipts ORDER BY asset_id').all(),originals);
        assert.deepEqual(f.db.prepare('SELECT * FROM private_gallery_asset_tags ORDER BY asset_id,person_id').all(),tags);
        assert.deepEqual(f.db.prepare('SELECT * FROM private_gallery_attempt_framings ORDER BY attempt_id').all(),frames);
        assert.equal(f.original.objects.size,3);assert.equal(f.db.prepare('SELECT count(*) n FROM private_archive_deletion_requests').get().n,0);
        const printed=diagnostics.map(formatArchiveDiagnostic).join('');
        for(const sensitive of [secret,f.owner.subject,...f.ids,...attempts.map(a=>a.attempt_id),...originals.map(o=>o.sha256)])assert.equal(printed.includes(sensitive),false);
        assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
    } finally {f.db.close();}
}
const cli=await readFile(new URL('../scripts/run-gallery-archive-job.mjs',import.meta.url),'utf8');
assert.match(cli,/reportedFailures\+\+<32/);assert.match(cli,/fetchImpl:fetch,reportFailure/);
assert.match(cli,/const dependencies=\{jobId,runReference,jobs,reportFailure\}/);
assert.match(cli,/do not replay a closed photo attempt/);
assert.doesNotMatch(cli,/console\.(?:error|log)\(error|error\.message|error\.stack|JSON\.stringify\(result\)/);
console.log('Offline handoff diagnostics: exact stopped photo/stage, bounded safe transport reasons, unchanged denial/deadlines, no retries, two private-only photos, retained originals/tags/consent/framing and independent cleanup/host recovery passed.');
