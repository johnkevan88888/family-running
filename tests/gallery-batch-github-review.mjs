import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as batch from '../scripts/gallery-media/github-batch-review-client.mjs';
import {batchBaseSha as baseSha,batchToken as token,batchCandidate,batchPhoto,batchGitHub,batchCanonical,batchRevision} from './helpers/gallery-batch-github-fixture.mjs';

const clone=value=>JSON.parse(JSON.stringify(value));
const options=github=>({expectedBaseSha:baseSha,token,fetchImpl:github.fetch});
const create=async (value,github,admitPullRequest=async()=>{})=>batch.createOrReconcileArchiveGalleryBatchReview(value,{...options(github),admitPullRequest});
let checks=0;
assert.deepEqual(Object.keys(batch),['createOrReconcileArchiveGalleryBatchReview','readExistingGalleryBatchReview','readMergedGalleryBatchReview','reconcileArchiveGalleryBatchReview']);
const source=await fs.readFile(new URL('../scripts/gallery-media/github-batch-review-client.mjs',import.meta.url),'utf8');
assert.doesNotMatch(source,/['"](?:DELETE|PUT)['"]|process\.env|fetch\(/);checks++;

for(const site of ['family','everyone']) for(const count of [1,2,20]) {
    const old=batchPhoto(100),value=batchCandidate({site,baseItems:[old],newItems:Array.from({length:count},(_,i)=>batchPhoto(i+1))});
    const github=batchGitHub({candidate:value,baseItems:[old],loseRefResponse:true,losePullResponse:true});let admissions=0;
    const created=await create(value,github,async()=>{assert.equal(github.state.pulls.length,0);admissions++;});
    assert.deepEqual(created.itemIds,value.itemIds);assert.equal(created.replayed,false);assert.equal(created.pullRequest.state,'open');
    assert.equal(admissions,1);assert.equal(Object.isFrozen(created.itemIds),true);
    assert.doesNotMatch(JSON.stringify(created),/synthetic_batch_installation_token/);
    const replayed=await create(value,github,()=>assert.fail('Replay must not admit another POST'));
    assert.equal(replayed.replayed,true);assert.deepEqual(await batch.readExistingGalleryBatchReview(value,options(github)),replayed);
    assert.equal(github.state.requests.filter(r=>r.method==='POST' && r.path==='/pulls').length,1);
    assert.deepEqual(github.state.requests.filter(r=>r.method!=='GET').map(r=>[r.method,r.path]),
        [['POST','/git/blobs'],['POST','/git/trees'],['POST','/git/commits'],['POST','/git/refs'],['POST','/pulls']]);
    const terminal=await batch.reconcileArchiveGalleryBatchReview(value,options(github));
    assert.equal(terminal.state,'closed-unmerged');assert.deepEqual(terminal.itemIds,value.itemIds);
    assert.equal(github.state.branchSha,created.headSha);assert.equal(github.state.pulls[0].state,'closed');checks++;
}
for(const site of ['family','everyone']) {
    const items=[batchPhoto(1),batchPhoto(2)];
    for(const item of items) item.thumbnailUrl=item.sourceUrl.replace('/display.webp','/thumbnail.webp');
    const value=batchCandidate({site,newItems:items}),github=batchGitHub({candidate:value});
    const review=await create(value,github);
    assert.deepEqual(review.itemIds,value.itemIds);
    assert.notEqual(items[0].sourceUrl,items[0].thumbnailUrl,'Role-specific URLs remain distinct even for identical byte digests');
    assert.equal((await batch.readExistingGalleryBatchReview(value,options(github))).pullRequest.number,review.pullRequest.number);checks++;
}

const noNetwork=()=>assert.fail('Malformed input must stop before a GitHub request');
const valid=batchCandidate();
for(const mutate of [
    value=>{value.extra='unsafe';},value=>{value.changed=false;},value=>{value.itemIds=[];value.receipt.itemIds=[];},
    value=>{value.itemIds.push(value.itemIds[0]);value.receipt.itemIds=[...value.itemIds];},
    value=>{value.targetRelativePath='data/athlete_results.csv';value.receipt.targetRelativePath=value.targetRelativePath;},
    value=>{value.receipt.operationId='promotion_existing_single';},value=>{value.receipt.itemIds.reverse();},
    value=>{value.manifestText=value.manifestText.replace(/\n/g,'\r\n');value.manifestSha256=batchRevision(value.manifestText);value.receipt.manifestSha256=value.manifestSha256;},
    value=>{value.manifestSha256=`sha256:${'0'.repeat(64)}`;value.receipt.manifestSha256=value.manifestSha256;},
    value=>{value.itemIds=['photo-not-a-uuid'];value.receipt.itemIds=[...value.itemIds];},
    value=>{value.receipt.extra='secret';}
]) {const value=clone(valid);mutate(value);await assert.rejects(batch.createOrReconcileArchiveGalleryBatchReview(value,
    {expectedBaseSha:baseSha,token,fetchImpl:noNetwork,admitPullRequest:async()=>{}}));checks++;}
for(const patch of [{expectedBaseSha:'wrong'},{token:'short'},{token:'secret\nvalue'},{fetchImpl:null},{admitPullRequest:null},{site:'everyone'}]) {
    await assert.rejects(batch.createOrReconcileArchiveGalleryBatchReview(valid,{expectedBaseSha:baseSha,token,fetchImpl:noNetwork,
        admitPullRequest:async()=>{},...patch}));checks++;
}
for(const count of [0,21]) {
    const value=batchCandidate({newItems:Array.from({length:count},(_,i)=>batchPhoto(i+1))});
    await assert.rejects(create(value,{fetch:noNetwork}));checks++;
}
for(const mutate of [item=>{item.type='video';delete item.podiumFraming;},item=>{item.athleteIds=[];delete item.podiumFraming;},
    item=>{item.sourceUrl=item.sourceUrl.replace('family-running-gallery-media-dev.family-running.workers.dev','evil.example');},
    item=>{item.sourceUrl+='?token=secret';},item=>{item.thumbnailUrl=item.sourceUrl;},
    item=>{item.podiumFraming={'not-tagged':{x:1,y:2,zoom:3}};},item=>{item.latitude=43;},
    item=>{item.thumbnailUrl=item.thumbnailUrl.replace('/10000000-0000-4000-8000-000000000001/','/10000000-0000-4000-8000-000000000099/');}
]) {const items=[batchPhoto(1),batchPhoto(2)];mutate(items[0]);await assert.rejects(create(batchCandidate({newItems:items}),{fetch:noNetwork}));checks++;}

for(const fixture of [
    {mainSha:'9'.repeat(40)}, {hiddenAthleteIds:['synthetic-ada']}, {otherItems:[batchPhoto(1)]},
    {otherItems:[{...batchPhoto(100),sourceUrl:batchPhoto(1).sourceUrl}]},
    {baseItems:[batchPhoto(100)]}, {suppressionText:'{}\n'}, {otherText:'{}\n'}
]) {const github=batchGitHub({candidate:valid,...fixture});await assert.rejects(create(valid,github));
    assert.equal(github.state.requests.some(r=>r.method!=='GET'),false);checks++;}
for(const duplicate of ['urls','generation']) {
    const items=[batchPhoto(1),batchPhoto(2)];
    items[1].sourceUrl=items[1].sourceUrl.replace('10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001');
    items[1].thumbnailUrl=items[1].thumbnailUrl.replace('10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001');
    if(duplicate==='urls') {items[1].sourceUrl=items[0].sourceUrl;items[1].thumbnailUrl=items[0].thumbnailUrl;}
    const value=batchCandidate({newItems:items}),github=batchGitHub({candidate:value});await assert.rejects(create(value,github));
    assert.equal(github.state.requests.some(r=>r.method!=='GET'),false);checks++;
}
for(const change of ['edit','reorder','remove','insert']) {
    const olds=[batchPhoto(100),batchPhoto(101)],value=batchCandidate({baseItems:olds});
    const proposed=JSON.parse(value.manifestText);
    if(change==='edit') proposed.items[0].caption='Changed context';
    if(change==='reorder') proposed.items.splice(0,2,proposed.items[1],proposed.items[0]);
    if(change==='remove') proposed.items.shift();
    if(change==='insert') proposed.items.splice(1,0,batchPhoto(110));
    value.manifestText=batchCanonical(proposed);value.manifestSha256=batchRevision(value.manifestText);value.receipt.manifestSha256=value.manifestSha256;
    const github=batchGitHub({candidate:value,baseItems:olds});await assert.rejects(create(value,github));
    assert.equal(github.state.requests.some(r=>r.method!=='GET'),false);checks++;
}

const stale=batchGitHub({advanceMain:true});await assert.rejects(create(valid,stale));
assert.equal(stale.state.pulls.length,0);checks++;
const denied=batchGitHub();await assert.rejects(create(valid,denied,async()=>{throw new Error('Revoked member');}));
assert.equal(denied.state.pulls.length,0);checks++;
// Do not add a network await after durable admission but before issuing the
// POST: a failed intervening read would strand a claim with an admitted POST
// that can never land. Stale main still refuses success and the owned PR can
// be reconciled/closed under the original evidence.
const admissionRace=batchGitHub();let admissionIndex;
await assert.rejects(create(valid,admissionRace,async()=>{
    admissionIndex=admissionRace.state.requests.length;admissionRace.state.mainSha='9'.repeat(40);
}));
assert.deepEqual([admissionRace.state.requests[admissionIndex].method,admissionRace.state.requests[admissionIndex].path],['POST','/pulls']);
assert.equal(admissionRace.state.pulls.length,1);
assert.equal((await batch.reconcileArchiveGalleryBatchReview(valid,options(admissionRace))).state,'closed-unmerged');checks++;
const finalMainRace=batchGitHub({onRequest:({method,path,state})=>{
    if(method==='GET' && path==='/pulls/1') state.mainSha='9'.repeat(40);
}});
await assert.rejects(create(valid,finalMainRace));assert.equal(finalMainRace.state.pulls.length,1);
assert.equal((await batch.reconcileArchiveGalleryBatchReview(valid,options(finalMainRace))).state,'closed-unmerged');checks++;
const uncertain=batchGitHub({failPullWithoutMutation:true});let admissionCalls=0;
await assert.rejects(create(valid,uncertain,async()=>{if(admissionCalls++) throw new Error('Already admitted');}));
await assert.rejects(create(valid,uncertain,async()=>{if(admissionCalls++) throw new Error('Already admitted');}));
assert.equal(uncertain.state.requests.filter(r=>r.method==='POST' && r.path==='/pulls').length,1);checks++;
const absent=batchGitHub();assert.equal((await batch.reconcileArchiveGalleryBatchReview(valid,options(absent))).state,'no-pr-created');
assert.equal(absent.state.requests.some(r=>r.method!=='GET'),false);checks++;

for(const corruption of ['head','body','title','repository','extra-file','bytes','parent','commit-message','duplicate-pr']) {
    const github=batchGitHub();await create(valid,github);
    if(corruption==='head') github.state.pulls[0].head.sha='9'.repeat(40);
    if(corruption==='body') github.state.pulls[0].body+='tampered';
    if(corruption==='title') github.state.pulls[0].title='Other review';
    if(corruption==='repository') github.state.pulls[0].head.repo.full_name='other/repository';
    if(corruption==='extra-file') github.state.extraFiles=[{filename:'index.html',status:'modified'}];
    if(corruption==='bytes') github.state.branchManifestText+=' ';
    if(corruption==='parent') github.state.createdCommit.parents.push('9'.repeat(40));
    if(corruption==='commit-message') github.state.createdCommit.message='Another commit';
    if(corruption==='duplicate-pr') github.state.pulls.push(clone(github.state.pulls[0]));
    await assert.rejects(batch.readExistingGalleryBatchReview(valid,options(github)));
    await assert.rejects(batch.reconcileArchiveGalleryBatchReview(valid,options(github)));
    assert.equal(github.state.requests.some(r=>r.method==='PATCH'),false);checks++;
}
for(const flag of ['failClose','failClosedRead']) {
    const github=batchGitHub();await create(valid,github);github.state[flag]=true;
    await assert.rejects(batch.reconcileArchiveGalleryBatchReview(valid,options(github)));checks++;
}
const lostClose=batchGitHub({loseCloseResponse:true});await create(valid,lostClose);
assert.equal((await batch.reconcileArchiveGalleryBatchReview(valid,options(lostClose))).state,'closed-unmerged');checks++;

for(const corruption of ['none','merged-bytes','opposite-merge-duplication','head-ancestry','main-ancestry','saved-members','saved-pr']) {
    const github=batchGitHub(),review=await create(valid,github);github.merge();
    if(corruption==='merged-bytes') github.state.mergedText=batchCanonical({schemaVersion:'1.0',items:[batchPhoto(1)]});
    if(corruption==='opposite-merge-duplication') github.state.mergedOtherText=batchCanonical({schemaVersion:'1.0',items:[batchPhoto(1)]});
    if(corruption==='head-ancestry') github.state.badHeadAncestry=true;
    if(corruption==='main-ancestry') github.state.badMainAncestry=true;
    const saved=clone(review);
    if(corruption==='saved-members') saved.itemIds.reverse();
    if(corruption==='saved-pr') saved.pullRequest.number=99;
    const before=github.state.requests.length;
    if(corruption==='none') {
        const proof=await batch.readMergedGalleryBatchReview(valid,saved,options(github));assert.equal(proof.state,'merged-by-owner');
        assert.equal((await batch.reconcileArchiveGalleryBatchReview(valid,options(github))).state,'merged-by-owner');
    } else await assert.rejects(batch.readMergedGalleryBatchReview(valid,saved,options(github)));
    assert.equal(github.state.requests.slice(before).some(r=>r.method!=='GET'),false);checks++;
}

console.log(`Protected batch GitHub review: ${checks} cases passed (synthetic, no network).`);
