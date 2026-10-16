import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {setImmediate as flush} from 'node:timers/promises';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createArchiveServiceClient,createArchiveProcessingClient,createArchivePromotionClient,createArchiveJobClient,createArchiveFinalizerClient} from '../scripts/gallery-media/archive-service-client.mjs';
import {runProtectedArchiveJob} from '../scripts/gallery-media/protected-archive-job.mjs';
import {archiveServiceFixture} from './helpers/private-gallery-service-fixture.mjs';
import {privateGalleryJobFixture} from './helpers/private-gallery-job-fixture.mjs';
import {syntheticGitHub} from './helpers/private-gallery-lifecycle-fixtures.mjs';
import {changePrivateGalleryVisibility} from '../gallery-admin/src/private-gallery-visibility-service.js';

const attemptId='attempt_11111111-1111-4111-8111-111111111111';
const jobId='job_11111111-1111-4111-8111-111111111111';
const assetId='asset_11111111-1111-4111-8111-111111111111';
const runReference='https://github.com/johnkevan88888/family-running/actions/runs/123';
const origin=purpose=>`https://family-running-gallery-${{verifier:'public-host-verifier',finalizer:'withdrawal-finalizer'}[purpose]||purpose}-dev.family-running.workers.dev`;
const configuration=(purpose,fetchImpl)=>({purpose,origin:origin(purpose),clientId:'fictional-timeout-client',clientSecret:'fictional-timeout-secret',fetchImpl});
const payload={promoted:true};
function response(url,options={}) {
    const reply=new Response(Object.hasOwn(options,'body')?options.body:JSON.stringify(payload),{
        status:options.status??200,headers:{'Cache-Control':'no-store','Content-Type':'application/json; charset=utf-8',...options.headers}});
    Object.defineProperty(reply,'url',{value:options.url??url});
    if(options.redirected) Object.defineProperty(reply,'redirected',{value:true});
    return reply;
}
async function clocked(run) {
    mock.timers.enable({apis:['setTimeout']});
    try {await run();} finally {mock.timers.reset();}
}
function probe({factory=createArchivePromotionClient,purpose='promotion',operation='promote',delay=11000,reply=response,id=attemptId,
    input=operation.startsWith('photo-')?{bytes:new ArrayBuffer(1),toolchain:{fixture:true}}:undefined}={}) {
    const requests=[];let settled=false,value;
    const client=factory(configuration(purpose,request=>{
        requests.push(request);
        assert.equal(request.url,`${origin(purpose)}/api/service/archive-attempts/${id}/${operation}`);
        assert.equal(request.redirect,'error');assert.equal(request.credentials,'omit');assert.equal(request.cache,'no-store');
        assert.equal(request.headers.get('CF-Access-Client-Id'),'fictional-timeout-client');
        assert.equal(request.headers.get('CF-Access-Client-Secret'),'fictional-timeout-secret');
        if(operation.startsWith('photo-')) {
            assert.equal(request.method,'PUT');assert.equal(request.headers.get('Content-Type'),'image/webp');
            assert.deepEqual(JSON.parse(request.headers.get('X-Gallery-Toolchain')),input.toolchain);
        }
        return new Promise(resolve=>{setTimeout(()=>resolve(reply(request.url)),delay);});
    }));
    const result=client(id,operation,input).then(result=>{settled=true;value=result;return result;});
    return {requests,result,get settled(){return settled;},get value(){return value;},
        advance:async milliseconds=>{mock.timers.tick(milliseconds);await flush();}};
}

// Reproduce the previous deadline, then exercise the exact corrected adapter.
await clocked(async()=>{
    const old=probe({factory:createArchiveServiceClient});
    await old.advance(10000);assert.deepEqual(await old.result,{ok:false});assert.equal(old.requests[0].signal.aborted,true);
    await old.advance(1000);assert.deepEqual(old.value,{ok:false},'Late response cannot turn failure into success');
    assert.equal(old.requests.length,1,'No automatic retry');
});
await clocked(async()=>{
    const corrected=probe();
    await corrected.advance(10000);assert.equal(corrected.settled,false);assert.equal(corrected.requests[0].signal.aborted,false);
    await corrected.advance(1000);assert.deepEqual(await corrected.result,{ok:true,value:payload});
    await corrected.advance(30000);assert.equal(corrected.requests.length,1,'Success does not schedule another request');
});
await clocked(async()=>{
    const nearLimit=probe({delay:29999});await nearLimit.advance(29999);
    assert.deepEqual(await nearLimit.result,{ok:true,value:payload});
});
await clocked(async()=>{
    const late=probe({delay:31000});
    await late.advance(29999);assert.equal(late.settled,false);assert.equal(late.requests[0].signal.aborted,false);
    await late.advance(1);assert.deepEqual(await late.result,{ok:false});assert.equal(late.requests[0].signal.aborted,true);
    await late.advance(1000);assert.deepEqual(late.value,{ok:false});assert.equal(late.requests.length,1);
});

// The single budget includes the body; receipt of headers does not reset it.
await clocked(async()=>{
    const body=probe({delay:20000,reply:url=>response(url,{body:new ReadableStream({start(controller){
        setTimeout(()=>controller.enqueue(new TextEncoder().encode('{"promoted":')),5000);
        setTimeout(()=>{controller.enqueue(new TextEncoder().encode('true}'));controller.close();},12000);
    }})})});
    await body.advance(20000);assert.equal(body.settled,false);
    await body.advance(5000);assert.equal(body.settled,false,'Partial JSON is never completion');
    await body.advance(4999);assert.equal(body.settled,false);
    await body.advance(1);assert.deepEqual(await body.result,{ok:false});assert.equal(body.requests[0].signal.aborted,true);
    await body.advance(2000);assert.deepEqual(body.value,{ok:false},'A late complete body cannot revive the request');
});

// Each processing upload gets the same bounded total acknowledgement budget,
// not a global processing timeout and not a retry of a possibly committed write.
for(const operation of ['photo-display','photo-thumbnail']) {
    const settings={factory:createArchiveProcessingClient,purpose:'processing',operation};
    await clocked(async()=>{
        const old=probe({...settings,factory:createArchiveServiceClient});
        await old.advance(10000);assert.deepEqual(await old.result,{ok:false});assert.equal(old.requests[0].signal.aborted,true);
        await old.advance(1000);assert.deepEqual(old.value,{ok:false});assert.equal(old.requests.length,1);
    });
    await clocked(async()=>{
        const corrected=probe(settings);
        await corrected.advance(10000);assert.equal(corrected.settled,false);assert.equal(corrected.requests[0].signal.aborted,false);
        await corrected.advance(1000);assert.deepEqual(await corrected.result,{ok:true,value:payload});
        await corrected.advance(30000);assert.equal(corrected.requests.length,1,'An accepted upload is never retried');
    });
    await clocked(async()=>{
        const body=probe({...settings,delay:5000,reply:url=>response(url,{body:new ReadableStream({start(controller){
            setTimeout(()=>controller.enqueue(new TextEncoder().encode('{"promoted":')),4000);
            setTimeout(()=>{controller.enqueue(new TextEncoder().encode('true}'));controller.close();},6000);
        }})})});
        await body.advance(5000);assert.equal(body.settled,false);
        await body.advance(4000);assert.equal(body.settled,false,'Headers and partial JSON do not acknowledge a write');
        await body.advance(2000);assert.deepEqual(await body.result,{ok:true,value:payload});assert.equal(body.requests.length,1);
    });
    await clocked(async()=>{
        const nearLimit=probe({...settings,delay:29999});await nearLimit.advance(29999);
        assert.deepEqual(await nearLimit.result,{ok:true,value:payload});
    });
    await clocked(async()=>{
        const late=probe({...settings,delay:31000});
        await late.advance(29999);assert.equal(late.settled,false);assert.equal(late.requests[0].signal.aborted,false);
        await late.advance(1);assert.deepEqual(await late.result,{ok:false});assert.equal(late.requests[0].signal.aborted,true);
        await late.advance(1000);assert.deepEqual(late.value,{ok:false},'Late upload headers cannot revive a failed request');
        assert.equal(late.requests.length,1);
    });
    await clocked(async()=>{
        const body=probe({...settings,delay:20000,reply:url=>response(url,{body:new ReadableStream({start(controller){
            setTimeout(()=>controller.enqueue(new TextEncoder().encode('{"promoted":')),5000);
            setTimeout(()=>{controller.enqueue(new TextEncoder().encode('true}'));controller.close();},12000);
        }})})});
        await body.advance(20000);assert.equal(body.settled,false);
        await body.advance(5000);assert.equal(body.settled,false);
        await body.advance(4999);assert.equal(body.settled,false);
        await body.advance(1);assert.deepEqual(await body.result,{ok:false});assert.equal(body.requests[0].signal.aborted,true);
        await body.advance(2000);assert.deepEqual(body.value,{ok:false},'Late complete upload JSON cannot revive failure');
        assert.equal(body.requests.length,1,'Body timeout never schedules another upload');
    });
    for(const options of [{url:'https://arbitrary.example/reply'},{redirected:true},{headers:{'Cache-Control':'public'}},
        {headers:{'Cache-Control':''}},{headers:{'Content-Type':'text/html'}},{body:null},{body:'not-json'},
        {body:new Uint8Array([0xff])},{body:' '.repeat(2097153)},{status:401},{status:403},{status:500}]) await clocked(async()=>{
        const invalid=probe({...settings,reply:url=>response(url,options)});await invalid.advance(11000);
        assert.equal((await invalid.result).ok,false,operation);assert.equal(invalid.requests.length,1);
    });
}

// Every non-promote operation retains its previous ten-second default.
for(const operation of ['candidate','review','review-reserve','review-open','review-close','review-write','review-terminal',
    'removal-reserve','removal-open','manifest-absence','close','cleanup']) await clocked(async()=>{
    const normal=probe({operation});await normal.advance(10000);assert.deepEqual(await normal.result,{ok:false},operation);
});
for(const operation of ['start','original','close','cleanup']) await clocked(async()=>{
    const normal=probe({factory:createArchiveProcessingClient,purpose:'processing',operation});
    await normal.advance(10000);assert.deepEqual(await normal.result,{ok:false},operation);
    assert.equal(normal.requests[0].signal.aborted,true);assert.equal(normal.requests.length,1);
});
for(const [purpose,operation,value] of [['processing','start'],['processing','original'],
    ['processing','photo-display',{bytes:new ArrayBuffer(1),toolchain:{}}],['processing','photo-thumbnail',{bytes:new ArrayBuffer(1),toolchain:{}}],
    ['processing','close'],['processing','cleanup'],['verifier','verify']]) await clocked(async()=>{
    let request;
    const client=createArchiveServiceClient(configuration(purpose,received=>{request=received;return new Promise(()=>{});}));
    const result=client(attemptId,operation,value);mock.timers.tick(10000);assert.deepEqual(await result,{ok:false});
    assert.equal(request.signal.aborted,true,purpose+'/'+operation);
});
for(const purpose of ['promotion','finalizer']) await clocked(async()=>{
    let request;const client=createArchiveJobClient(configuration(purpose,received=>{request=received;return new Promise(()=>{});}));
    const result=client(jobId,'read',{runReference});mock.timers.tick(10000);assert.deepEqual(await result,{ok:false});assert.equal(request.signal.aborted,true);
});
await clocked(async()=>{
    let request;const client=createArchiveFinalizerClient(configuration('finalizer',received=>{request=received;return new Promise(()=>{});}));
    const result=client(assetId);mock.timers.tick(10000);assert.deepEqual(await result,{ok:false});assert.equal(request.signal.aborted,true);
});

// More waiting never relaxes origin, response, input or size validation.
for(const options of [{url:'https://arbitrary.example/reply'},{redirected:true},{headers:{'Cache-Control':'public'}},
    {headers:{'Cache-Control':''}},{headers:{'Content-Type':'text/html'}},{body:null},{body:'not-json'},
    {body:new Uint8Array([0xff])},{body:' '.repeat(2097153)},{status:401},{status:403},{status:500}]) await clocked(async()=>{
    const invalid=probe({reply:url=>response(url,options)});await invalid.advance(11000);
    assert.equal((await invalid.result).ok,false);assert.equal(invalid.requests.length,1);
});
let invalidFetches=0;
const unavailable=configuration('promotion',()=>{invalidFetches++;assert.fail('Invalid configuration must never fetch');});
for(const changed of [{purpose:'processing'},{origin:'https://arbitrary.example'},{origin:origin('promotion')+'/'},
    {clientId:''},{clientId:'has space'},{clientSecret:'has\nnewline'},{clientSecret:'x'.repeat(4097)},{fetchImpl:null}])
    assert.throws(()=>createArchivePromotionClient({...unavailable,...changed}),/Unavailable/);
for(const timeoutMilliseconds of [null,0,-1,30001,1.5,NaN,Infinity,'30000'])
    assert.throws(()=>createArchiveServiceClient({...unavailable,timeoutMilliseconds}),/Unavailable/);
const invalidInputs=createArchivePromotionClient(unavailable);
await assert.rejects(()=>invalidInputs('attempt_not-a-uuid','promote'),/Unavailable/);
await assert.rejects(()=>invalidInputs(attemptId,'original'),/Unavailable/);
await assert.rejects(()=>invalidInputs(attemptId,'video'),/Unavailable/);
assert.equal(invalidFetches,0);
const unavailableProcessing=configuration('processing',()=>{invalidFetches++;assert.fail('Invalid upload must never fetch');});
for(const changed of [{purpose:'promotion'},{origin:'https://arbitrary.example'},{origin:origin('processing')+'/'},
    {clientId:''},{clientId:'has space'},{clientSecret:'has\nnewline'},{clientSecret:'x'.repeat(4097)},{fetchImpl:null}])
    assert.throws(()=>createArchiveProcessingClient({...unavailableProcessing,...changed}),/Unavailable/);
const invalidUploads=createArchiveProcessingClient(unavailableProcessing);
await assert.rejects(()=>invalidUploads('attempt_not-a-uuid','photo-display'),/Unavailable/);
for(const operation of ['video','promote']) await assert.rejects(()=>invalidUploads(attemptId,operation),/Unavailable/);
for(const [operation,bytes] of [['photo-display',new ArrayBuffer(26214401)],['photo-thumbnail',new ArrayBuffer(5242881)],
    ['photo-display',new Uint8Array(1)],['photo-thumbnail',undefined]])
    assert.deepEqual(await invalidUploads(attemptId,operation,{bytes,toolchain:{}}),{ok:false});
assert.equal(invalidFetches,0,'Route, credential, identifier and upload-size rejection happen before HTTP');

// Confirm the protected main-only CLI selects this adapter, not a global timeout
// override or a new environment/workflow input. It is NOT executed with secrets.
const cli=await readFile(new URL('../scripts/run-gallery-archive-job.mjs',import.meta.url),'utf8');
assert.match(cli,/dependencies\.promotion=createArchivePromotionClient\(configuration\('promotion'\)\)/);
assert.match(cli,/dependencies\.processing=createArchiveProcessingClient\(configuration\('processing'\)\)/);
assert.match(cli,/dependencies\.verifier=createArchiveServiceClient\(configuration\('verifier'\)\)/);
assert.doesNotMatch(cli,/GALLERY_[A-Z_]*(?:TIMEOUT|DEADLINE)|timeoutMilliseconds/);
assert.match(cli,/GITHUB_ACTIONS!=='true'/);assert.match(cli,/GITHUB_REF!=='refs\/heads\/main'/);
assert.match(cli,/await verifyGalleryReviewBoundary/);

// A delayed authenticated write reply leaves uncertainty closed and the
// owner job claimed. Only the existing cleanup/host/main phases may release it.
// All I/O below is generated-photo SQLite and fictional HTTP/GitHub, not remote.
for(const site of ['family','everyone']) for(const [serviceName,delayedOperation] of [
    ['promotion','promote'],['processing','photo-display'],['processing','photo-thumbnail']]) {
    const f=await archiveServiceFixture(site),c=await privateGalleryJobFixture(f),github=syntheticGitHub();
    const ownerJobId=await c.ownerJob({action:'review',attemptId:f.attemptId,idempotencyKey:crypto.randomUUID()});
    const consentBefore=f.db.prepare('SELECT * FROM private_gallery_attempts').all();
    const tagsBefore=f.db.prepare('SELECT * FROM private_gallery_asset_tags').all();
    const originalsBefore=f.db.prepare('SELECT * FROM private_archive_original_receipts').all();
    let release,entered;
    const enteredPromise=new Promise(resolve=>{entered=resolve;});const held=new Promise(resolve=>{release=resolve;});
    c.setReplyHook(async request=>{if(request.url.endsWith('/'+delayedOperation)) {
        // This hook runs AFTER the real local HTTP handler has independently
        // verified the generated bytes. Only its acknowledgement is withheld.
        const tier=serviceName==='processing'?'staging':'approved';
        assert.ok(f.db.prepare('SELECT count(*) n FROM private_gallery_pipeline_byte_receipts WHERE attempt_id=? AND tier=?').get(f.attemptId,tier).n>0);
        entered();await held;
    }});
    const service=c[serviceName];let clockActive=false,delayedInput;
    c[serviceName]=(id,operation,value)=>{
        if(operation!==delayedOperation) return service(id,operation,value);
        delayedInput=value;
        // Do not mock the native decoder/Blob scheduling. Start the clock only
        // at this RPC, and restore normal timers before safety cleanup begins.
        mock.timers.enable({apis:['setTimeout']});clockActive=true;
        return service(id,operation,value).finally(()=>{mock.timers.reset();clockActive=false;});
    };
    const execute=(phase,purpose='promotion')=>runProtectedArchiveJob({jobId:ownerJobId,runReference,phase,...c,jobs:c.jobs[purpose],github});
    try {
        {
            const reviewing=execute('review');
            await Promise.race([enteredPromise,reviewing.then(result=>{
                throw new Error('Fictional '+delayedOperation+' was not reached: '+JSON.stringify({result,requests:c.requests}));
            })]);
            mock.timers.tick(29999);await flush();
            assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_active_job').get().n,1);
            mock.timers.tick(1);const pending=await reviewing;
            assert.deepEqual(pending,{ok:false,state:'pending',publicationEnabled:false});
            assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_active_job').get().n,1,'Timeout cannot release the claim');
            assert.equal(github.state.pulls.length,0,'No PR may be inferred from a delayed write reply');
            assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_pipeline_closures WHERE attempt_id=?').get(f.attemptId).n,1);
            assert.equal(f.staging.objects.size,0,'Closed processing attempt is cleaned, not accepted on a late acknowledgement');
            assert.equal(f.approved.objects.size,1,'Only the canonical fixture witness remains');
            assert.equal(c.requests.filter(([purpose,path])=>purpose===serviceName&&path.endsWith('/'+delayedOperation)).length,1,'No automatic write retry');
            assert.equal(f.original.objects.size,1);assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_asset_tags').get().n,2);
            assert.deepEqual(f.db.prepare('SELECT * FROM private_gallery_attempts').all(),consentBefore,'Consent history is unchanged');
            release();await flush();c.setReplyHook(undefined);
            assert.equal(github.state.pulls.length,0,'Late acknowledgement cannot create a review');
            assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_active_job').get().n,1,'Late acknowledgement cannot release the claim');
            if(serviceName==='processing') {
                // Deliberate fixture-only hostile replay, not an automatic
                // client retry: the unchanged route must reject closed authority.
                const storageCalls=f.staging.calls.length+f.approved.calls.length;
                assert.equal((await service(f.attemptId,delayedOperation,delayedInput)).ok,false);
                assert.equal(f.staging.calls.length+f.approved.calls.length,storageCalls,'Closed generation cannot write again');
            }
        }
        assert.equal((await execute('verify','finalizer')).state,'host-ready');
        assert.equal((await execute('reconcile')).state,'removed');
        assert.equal((await execute('finalize','finalizer')).state,'hidden-original-retained');
        assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_active_job').get().n,0);
        assert.equal(f.original.objects.size,1);assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
        assert.deepEqual(f.db.prepare('SELECT * FROM private_gallery_asset_tags').all(),tagsBefore);
        assert.deepEqual(f.db.prepare('SELECT * FROM private_archive_original_receipts').all(),originalsBefore);
        assert.deepEqual(f.db.prepare('SELECT * FROM private_gallery_attempts').all(),consentBefore);
        assert.equal(github.state.pulls.length,0);
    } finally {release();if(clockActive) mock.timers.reset();f.db.close();}
}

// An accepted acknowledgement is never permission to continue after a
// real visibility revocation. The handler has already written/verified bytes;
// the next unchanged service/SQL fence must still stop review and clean them.
for(const site of ['family','everyone']) for(const operation of ['photo-display','photo-thumbnail']) {
    const f=await archiveServiceFixture(site),c=await privateGalleryJobFixture(f),github=syntheticGitHub();
    const ownerJobId=await c.ownerJob({action:'review',attemptId:f.attemptId,idempotencyKey:crypto.randomUUID()});
    const consentBefore=f.db.prepare('SELECT * FROM private_gallery_attempts').all();
    const tagsBefore=f.db.prepare('SELECT * FROM private_gallery_asset_tags').all();
    const originalBefore=f.db.prepare('SELECT * FROM private_archive_original_receipts').all();
    let revoked=false;
    c.setReplyHook(async request=>{
        if(request.url.endsWith('/'+operation) && !revoked) {
            assert.equal(f.db.prepare("SELECT count(*) n FROM private_gallery_pipeline_byte_receipts WHERE attempt_id=? AND tier='staging' AND role=?").get(f.attemptId,operation).n,1);
            const hidden=await changePrivateGalleryVisibility(f.env,f.owner,site,f.ids[0],{
                expectedVersion:2,idempotencyKey:crypto.randomUUID(),preference:'hidden'});
            assert.equal(hidden.ok,true,'The competing revocation must actually commit');revoked=true;
        }
    });
    const execute=(phase,purpose='promotion')=>runProtectedArchiveJob({jobId:ownerJobId,runReference,phase,...c,jobs:c.jobs[purpose],github});
    try {
        assert.deepEqual(await execute('review'),{ok:false,state:'pending',publicationEnabled:false});
        assert.equal(revoked,true);assert.equal(github.state.pulls.length,0);
        assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_pipeline_closures WHERE attempt_id=?').get(f.attemptId).n,1);
        assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_active_job').get().n,1);
        assert.equal(f.staging.objects.size,0);assert.equal(f.approved.objects.size,1);
        assert.equal(c.requests.filter(([purpose,path])=>purpose==='processing'&&path.endsWith('/'+operation)).length,1);
        c.setReplyHook(undefined);
        assert.equal((await execute('verify','finalizer')).state,'host-ready');
        assert.equal((await execute('reconcile')).state,'removed');
        assert.equal((await execute('finalize','finalizer')).state,'hidden-original-retained');
        assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_active_job').get().n,0);
        assert.equal(f.original.objects.size,1);
        assert.deepEqual(f.db.prepare('SELECT * FROM private_gallery_attempts').all(),consentBefore);
        assert.deepEqual(f.db.prepare('SELECT * FROM private_gallery_asset_tags').all(),tagsBefore);
        assert.deepEqual(f.db.prepare('SELECT * FROM private_archive_original_receipts').all(),originalBefore);
        assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
    } finally {f.db.close();}
}

// A longer transport budget is not a consent-lifetime extension. Advance only
// the local SQLite clock; never rewrite immutable provider/consent timestamps.
for(const site of ['family','everyone']) {
    const f=await archiveServiceFixture(site),c=await privateGalleryJobFixture(f);
    try {
        const consent=f.db.prepare('SELECT * FROM private_gallery_attempts').all();
        const storageCalls=f.original.calls.length+f.staging.calls.length+f.approved.calls.length;
        const expiryNow=Math.floor(Date.now()/1000)+86401;
        f.db.function('unixepoch',value=>value==='now'?expiryNow:Math.floor(Date.parse(value)/1000));
        assert.equal((await c.processing(f.attemptId,'start')).ok,false,'Expired consent cannot start processing');
        assert.equal(f.original.calls.length+f.staging.calls.length+f.approved.calls.length,storageCalls,'Expiry fails before byte I/O');
        assert.deepEqual(f.db.prepare('SELECT * FROM private_gallery_attempts').all(),consent);
        assert.equal(f.original.objects.size,1);
    } finally {f.db.close();}
}

// Actual wall-clock reproduction, in parallel, without a network transport.
const measured=async (factory,purpose='promotion',operation='promote')=>{
    const started=performance.now();
    const result=await factory(configuration(purpose,request=>new Promise(resolve=>{
        setTimeout(()=>resolve(response(request.url)),11000);
    })))(attemptId,operation,operation.startsWith('photo-')?{bytes:new ArrayBuffer(1),toolchain:{fixture:true}}:undefined);
    return {ok:result.ok,milliseconds:Math.round(performance.now()-started)};
};
const [previous,corrected,processingPrevious,processingDisplay,processingThumbnail]=await Promise.all([
    measured(createArchiveServiceClient),measured(createArchivePromotionClient),
    measured(createArchiveServiceClient,'processing','photo-display'),
    measured(createArchiveProcessingClient,'processing','photo-display'),
    measured(createArchiveProcessingClient,'processing','photo-thumbnail')]);
assert.equal(previous.ok,false);assert.equal(corrected.ok,true);
assert.equal(processingPrevious.ok,false);assert.equal(processingDisplay.ok,true);assert.equal(processingThumbnail.ok,true);
const directory=new URL('../test-artifacts/',import.meta.url);await mkdir(directory,{recursive:true});
await writeFile(new URL('gallery-archive-timeout-regression.json',directory),JSON.stringify({
    checkedAt:new Date().toISOString(),remoteRequests:0,realMediaUsed:false,promotionBudgetMilliseconds:30000,
    processingPhotoBudgetMilliseconds:30000,unchangedControlAndGenericBudgetMilliseconds:10000,
    previous,corrected,processingPrevious,processingDisplay,processingThumbnail,clockControlledSafetyChecksPassed:true,
    generatedPhotoRecoveryBothAreasAndBothPhotoRolesPassed:true,expiredConsentRejectedBothAreas:true,
    postWriteVisibilityRevocationBothAreasAndBothPhotoRolesPassed:true,
    liveRetryPerformed:false,publicationEnabled:false},null,2)+'\n');
console.log('Route-scoped photo-upload and promotion 30-second total deadlines: delayed complete acknowledgement, exact cap, validation, no retry, late-ACK closure and retained-claim recovery pass; all transports are local/fictional.');
