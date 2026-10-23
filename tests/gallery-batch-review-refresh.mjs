import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import * as batch from '../scripts/gallery-media/github-batch-review-client.mjs';
import {runProtectedBatchReviewRefresh} from '../scripts/gallery-media/batch-review-refresh.mjs';
import {runProtectedArchiveJob} from '../scripts/gallery-media/protected-archive-job.mjs';
import {syntheticGitHub} from './helpers/private-gallery-lifecycle-fixtures.mjs';
import {batchCandidate,batchPhoto} from './helpers/gallery-batch-github-fixture.mjs';
import {privateGalleryBatchFixture,batchRun} from './helpers/private-gallery-batch-fixture.mjs';
import {requestPrivateArchiveBatchPublication} from '../gallery-admin/src/private-gallery-batch-service.js';
import {changePrivateGalleryVisibility} from '../gallery-admin/src/private-gallery-visibility-service.js';
import {queuePrivateArchiveJob} from '../gallery-admin/src/private-gallery-job-service.js';
import {batchReviewRefreshStep,safeArchiveDiagnostic,formatArchiveDiagnostic} from '../scripts/gallery-media/archive-diagnostics.mjs';

globalThis.fetch=()=>assert.fail('Refresh regression tests must never contact a remote service');

const clone=value=>structuredClone(value);
const options=(g,base=g.state.main)=>({expectedBaseSha:base,token:g.token,fetchImpl:g.fetchImpl});
const refWrites=g=>g.state.requests.filter(r=>r.method==='PATCH' && r.path.startsWith('/git/refs/'));
const writes=g=>g.state.requests.filter(r=>r.method!=='GET');
let checks=0;
async function fixture(site='family',count=2) {
    const g=syntheticGitHub(),value=batchCandidate({site,newItems:Array.from({length:count},(_,i)=>batchPhoto(i+1))});
    const review=clone(await batch.createOrReconcileArchiveGalleryBatchReview(value,{...options(g),admitPullRequest:async()=>{}}));
    const frozen=clone({review,value,pull:g.state.pulls[0],commit:g.state.commits.get(review.headSha)});
    const next=g.advanceMain({'tests/released-fix.mjs':'export const corrected = true;\n'});
    const refresh=(readEligibleCandidate=async()=>clone(value),patch={})=>batch.refreshStoredGalleryBatchReview(value,review,
        {...options(g,next),readEligibleCandidate,...patch});
    return {g,value,review,frozen,next,refresh};
}
// Regression: the actual main ref advanced twice, but both PR endpoints still
// report a legitimate earlier main snapshot. Never "repair" the PR response or
// candidate bytes in the fixture to make the refresh succeed.
for(const site of ['family','everyone']) for(const count of [1,2,20]) for(const reported of ['original','intermediate','current']) {
    const f=await fixture(site,count);
    const current=f.g.advanceMain({'tests/next-main.mjs':'new main'}, {updatePullBase:false});
    const reportedBase=reported==='original'?f.review.baseSha:reported==='intermediate'?f.next:current;
    f.g.state.pulls[0].base.sha=reportedBase;
    const before=clone({review:f.review,value:f.value,pull:f.g.state.pulls[0]});
    const result=await f.refresh(undefined,{expectedBaseSha:current});
    assert.equal(result.baseSha,current);assert.equal(result.originalHeadSha,f.review.headSha);
    assert.deepEqual(f.g.state.commits.get(result.headSha).parents.map(p=>p.sha),[f.review.headSha,current]);
    assert.equal(f.g.state.pulls[0].base.sha,reportedBase,'Reported metadata is not rewritten');
    assert.equal(f.g.state.pulls[0].body,before.pull.body);assert.equal(f.g.state.pulls[0].title,before.pull.title);
    assert.deepEqual(f.review,before.review);assert.deepEqual(f.value,before.value);
    assert.equal(refWrites(f.g).length,1);assert.equal(refWrites(f.g)[0].body.force,false);
    const afterWrites=writes(f.g).length;
    assert.equal((await f.refresh(undefined,{expectedBaseSha:current})).replayed,true);
    const read=await batch.readExistingGalleryBatchReview(f.value,options(f.g,f.review.baseSha),f.review);
    assert.deepEqual({...read,replayed:false},f.review,'Anchored continuation retains the original receipt');
    assert.equal(writes(f.g).length,afterWrites);checks++;
}
// A stale field is not a wildcard: both list and detail responses must still
// identify the exact review, with a bounded, proven main-history snapshot.
for(const endpoint of ['list','detail']) for(const mutation of ['missing','malformed','uppercase','before-anchor','side-branch',
    'future-base','candidate-head','base-ref','base-repo','head-ref','head-repo','head-sha','title','body','url','draft','closed','merged']) {
    const f=await fixture(),transport=f.g.fetchImpl;
    const current=f.g.advanceMain({}, {updatePullBase:false}),other='9'.repeat(40);
    f.g.state.commits.set(other,{sha:other,parents:mutation==='future-base'?[{sha:current}]:
        mutation==='side-branch'?[{sha:f.review.baseSha}]:[],contents:{}});
    if(mutation==='before-anchor') f.g.state.commits.get(f.review.baseSha).parents=[{sha:other}];
    const changed=pull=>{
        if(mutation==='missing') delete pull.base.sha;
        if(mutation==='malformed') pull.base.sha='../'+other;
        if(mutation==='uppercase') pull.base.sha='A'.repeat(40);
        if(['before-anchor','side-branch','future-base'].includes(mutation)) pull.base.sha=other;
        if(mutation==='candidate-head') pull.base.sha=f.review.headSha;
        if(mutation==='base-ref') pull.base.ref='not-main';
        if(mutation==='base-repo') pull.base.repo.full_name='someone/else';
        if(mutation==='head-ref') pull.head.ref+='changed';
        if(mutation==='head-repo') pull.head.repo.full_name='someone/else';
        if(mutation==='head-sha') pull.head.sha=other;
        if(mutation==='title') pull.title+='changed';
        if(mutation==='body') pull.body+='changed';
        if(mutation==='url') pull.html_url+='0';
        if(mutation==='draft') pull.draft=true;
        if(mutation==='closed') pull.state='closed';
        if(mutation==='merged') pull.merged_at='2026-01-01T00:00:00Z';
        return pull;
    };
    const fetchImpl=async(url,input)=>{
        const result=await transport(url,input),route=new URL(url).pathname;
        if(input.method==='GET' && (endpoint==='list'?route.endsWith('/pulls'):/\/pulls\/\d+$/.test(route))) {
            const value=await result.json();return {...result,json:async()=>endpoint==='list'?value.map(changed):changed(value)};
        }return result;
    };
    const before=writes(f.g).length,events=[];
    await assert.rejects(f.refresh(undefined,{expectedBaseSha:current,fetchImpl,reportFailure:e=>events.push(e)}),mutation);
    assert.equal(writes(f.g).length,before);assert.equal(f.g.state.refs.get(f.review.branchRef),f.review.headSha);
    assert(events.some(e=>e.stage==='review-identity'));checks++;
}
for(const failure of ['http','diverged','behind','wrong-ancestor','malformed']) {
    const f=await fixture(),current=f.g.advanceMain({}, {updatePullBase:false}),transport=f.g.fetchImpl;
    const fetchImpl=async(url,input)=>{
        const result=await transport(url,input);
        if(new URL(url).pathname.endsWith(`/compare/${f.next}...${current}`)) {
            if(failure==='http') return {ok:false,status:404,json:async()=>({})};
            const value=await result.json();
            if(failure==='diverged') value.status='diverged';
            if(failure==='behind') value.behind_by=1;
            if(failure==='wrong-ancestor') value.merge_base_commit.sha='9'.repeat(40);
            if(failure==='malformed') delete value.merge_base_commit;
            return {...result,json:async()=>value};
        }return result;
    };
    const before=writes(f.g).length,events=[];
    await assert.rejects(f.refresh(undefined,{expectedBaseSha:current,fetchImpl,reportFailure:e=>events.push(e)}));
    assert.equal(writes(f.g).length,before);assert(events.some(e=>e.stage==='review-base-history'));checks++;
}
// Independent endpoint snapshots can each lag by different valid amounts.
{
    const f=await fixture(),current=f.g.advanceMain({}, {updatePullBase:false}),transport=f.g.fetchImpl;
    const fetchImpl=async(url,input)=>{
        const response=await transport(url,input);
        if(/\/pulls\/\d+$/.test(new URL(url).pathname) && input.method==='GET') {
            const value=await response.json();value.base.sha=f.review.baseSha;
            return {...response,json:async()=>value};
        }return response;
    };
    const events=[];f.g.state.loseRefreshReply=true;
    const result=await f.refresh(undefined,{expectedBaseSha:current,fetchImpl,reportFailure:e=>events.push(e)});
    assert.equal(result.replayed,false);assert.equal(refWrites(f.g).length,1);assert.deepEqual(events,[]);
    const count=writes(f.g).length;
    assert.equal((await f.refresh(undefined,{expectedBaseSha:current,fetchImpl,reportFailure:async()=>{throw new Error('Observer failed');}})).replayed,true);
    assert.equal(writes(f.g).length,count);checks++;
}
for(const site of ['family','everyone']) for(const count of [1,2,20]) {
    const {g,value,review,frozen,next,refresh}=await fixture(site,count);
    await assert.rejects(batch.readExistingGalleryBatchReview(value,options(g,review.baseSha),review),/explicitly approved refresh/);
    let eligibility=0;g.state.loseRefreshReply=true;
    const result=await refresh(async()=>{eligibility++;return clone(value);});
    assert.equal(result.replayed,false);assert.equal(result.originalHeadSha,review.headSha);assert.equal(result.baseSha,next);
    assert.notEqual(result.headSha,review.headSha);assert.equal(eligibility,3);
    assert.deepEqual(g.state.commits.get(review.headSha),frozen.commit);
    assert.deepEqual(review,frozen.review);assert.deepEqual(value,frozen.value);
    const commit=g.state.commits.get(result.headSha);
    assert.deepEqual(commit.parents.map(p=>p.sha),[review.headSha,next]);
    assert.equal(commit.contents[value.targetRelativePath],value.manifestText);
    assert.equal(commit.contents['tests/released-fix.mjs'],'export const corrected = true;\n');
    assert.equal(g.state.main,next);assert.equal(g.state.pulls.length,1);
    assert.equal(g.state.pulls[0].title,frozen.pull.title);assert.equal(g.state.pulls[0].body,frozen.pull.body);
    assert.equal(g.state.pulls[0].state,'open');assert.equal(refWrites(g).length,1);assert.equal(refWrites(g)[0].body.force,false);
    const read=await batch.readExistingGalleryBatchReview(value,options(g,review.baseSha),review);
    assert.deepEqual({...read,replayed:false},review,'Ledger receipt remains anchored, not overwritten by the new tip');
    const before=writes(g).length;
    assert.equal((await refresh()).replayed,true);assert.equal(writes(g).length,before,'Lost reply retry creates nothing');
    const proof=await batch.reconcileArchiveGalleryBatchReview(value,options(g,review.baseSha));
    assert.equal(proof.state,'closed-unmerged');assert.equal(proof.headSha,review.headSha);
    assert.equal(g.state.refs.get(review.branchRef),result.headSha);checks++;
}

for(const mutate of [
    r=>{r.headSha='9'.repeat(40);},r=>{r.baseSha='bad';},r=>{r.branchRef+='x';},r=>{r.pullRequest.number=99;},
    r=>{r.pullRequest.state='closed';},r=>{r.itemIds.reverse();},r=>{r.manifestSha256='sha256:'+'0'.repeat(64);},r=>{r.extra=true;}
]) {
    const f=await fixture();mutate(f.review);const before=writes(f.g).length;
    await assert.rejects(f.refresh());assert.equal(writes(f.g).length,before);checks++;
}
for(const change of ['suppression','other-area-reuse','changed-existing','backward-main','foreign-pr','closed-pr','merged-pr','changed-framing','extra-option']) {
    const f=await fixture();let read=async()=>clone(f.value),patch={};
    if(change==='suppression') f.g.state.suppression.hiddenAthleteIds=['synthetic-ada'];
    if(change==='other-area-reuse') f.g.state.manifests.everyone.items=[batchPhoto(1)];
    if(change==='changed-existing') f.g.state.manifests.family.items=[batchPhoto(100)];
    if(change==='backward-main') f.g.state.commits.get(f.next).parents=[];
    if(change==='foreign-pr') f.g.state.pulls[0].head.repo.full_name='someone/else';
    if(change==='closed-pr') f.g.state.pulls[0].state='closed';
    if(change==='merged-pr') {f.g.state.pulls[0].state='closed';f.g.state.pulls[0].merged_at='2026-01-01T00:00:00Z';}
    if(change==='changed-framing') read=async()=>{const items=[batchPhoto(1),batchPhoto(2)];items[1].podiumFraming['synthetic-ben'].x=20;return batchCandidate({newItems:items});};
    if(change==='extra-option') patch.force=true;
    const before=writes(f.g).length;await assert.rejects(f.refresh(read,patch));assert.equal(writes(f.g).length,before);checks++;
}

for(const timing of ['pre-update','post-update']) {
    const f=await fixture();let calls=0;
    await assert.rejects(f.refresh(async()=>{
        if(++calls===(timing==='pre-update'?2:3)) throw new Error('Synthetic permission withdrawal');return clone(f.value);
    }));
    assert.equal(refWrites(f.g).length,timing==='pre-update'?0:1);
    assert.equal(f.g.state.pulls[0].state,timing==='pre-update'?'open':'closed');
    assert.deepEqual(f.g.state.commits.get(f.review.headSha),f.frozen.commit);
    assert.equal(writes(f.g).some(r=>r.method==='DELETE' || r.path.includes('/merge')),false);checks++;
}
for(const race of ['main','head','body','close','second-refresh']) {
    const f=await fixture();let calls=0;
    await assert.rejects(f.refresh(async()=>{
        if(++calls===2) {
            if(race==='main') f.g.advanceMain({'tests/another.mjs':'another'});
            if(race==='head') f.g.state.refs.set(f.review.branchRef,'9'.repeat(40));
            if(race==='body') f.g.state.pulls[0].body+='edited';
            if(race==='close') f.g.state.pulls[0].state='closed';
            if(race==='second-refresh') await f.refresh();
        }return clone(f.value);
    }));
    assert.equal(refWrites(f.g).length,race==='second-refresh'?1:0,'A competing refresh cannot be overwritten');checks++;
}
for(const fault of ['denied','lost-before-update','outage-after-update','ambiguous-pulls','missing-pr','missing-ref']) {
    const f=await fixture(),transport=f.g.fetchImpl;
    if(fault==='ambiguous-pulls') f.g.state.pulls.push(clone(f.g.state.pulls[0]));
    if(fault==='missing-pr') f.g.state.pulls=[];
    if(fault==='missing-ref') f.g.state.refs.delete(f.review.branchRef);
    const fetchImpl=async(url,input)=>{
        if(input.method==='PATCH' && new URL(url).pathname.includes('/git/refs/')) {
            if(fault==='denied') return {ok:false,status:403,json:async()=>({})};
            if(fault==='lost-before-update') throw new Error('Synthetic transport stopped before write');
            const result=await transport(url,input);
            if(fault==='outage-after-update') f.g.state.unavailable=true;
            return result;
        }
        return transport(url,input);
    };
    await assert.rejects(f.refresh(undefined,{fetchImpl}));
    if(fault!=='outage-after-update' && fault!=='missing-ref') assert.equal(f.g.state.refs.get(f.review.branchRef),f.review.headSha);
    if(fault==='outage-after-update') {
        // Unknown readback cannot close/delete/replay the underlying photos.
        assert.equal(f.g.state.pulls[0].state,'open');assert.equal(refWrites(f.g).length,1);
        f.g.state.unavailable=false;const before=writes(f.g).length;
        assert.equal((await f.refresh()).replayed,true);assert.equal(writes(f.g).length,before);
    }
    assert.equal(writes(f.g).some(r=>r.method==='DELETE' || r.path.includes('/merge')),false);checks++;
}
for(const tamper of ['message','anchor','cycle','parents','base','manifest','extra-file']) {
    const f=await fixture(),result=await f.refresh(),commit=f.g.state.commits.get(result.headSha);
    if(tamper==='message') commit.message+=' unexpected';
    if(tamper==='anchor') commit.message=commit.message.replace(f.review.headSha,'9'.repeat(40));
    if(tamper==='cycle') commit.parents[0].sha=result.headSha;
    if(tamper==='parents') commit.parents.push({sha:'9'.repeat(40)});
    if(tamper==='base') commit.parents[1].sha='9'.repeat(40);
    if(tamper==='manifest') commit.contents[f.value.targetRelativePath]=commit.contents[f.value.targetRelativePath].replace('Synthetic photo 1','Changed title');
    if(tamper==='extra-file') commit.contents['unreviewed.js']='unexpected';
    const before=writes(f.g).length;
    await assert.rejects(batch.readExistingGalleryBatchReview(f.value,options(f.g,f.review.baseSha),f.review));
    await assert.rejects(batch.reconcileArchiveGalleryBatchReview(f.value,options(f.g,f.review.baseSha)));
    assert.equal(writes(f.g).length,before,'Unknown history cannot authorize even PR closure');checks++;
}
{
    const f=await fixture();let base=f.next;
    for(let index=0;index<16;index++) {
        const result=await f.refresh(undefined,{expectedBaseSha:base});assert.equal(result.replayed,false);
        base=f.g.advanceMain({[`tests/change-${index}.mjs`]:'synthetic'});
    }
    const before=writes(f.g).length;await assert.rejects(f.refresh(undefined,{expectedBaseSha:base}),/history limit/);
    assert.equal(writes(f.g).length,before);checks++;
}

const execute=(f,phase)=>runProtectedArchiveJob({jobId:f.jobId,runReference:batchRun,phase,...f.c,
    jobs:f.c.jobs[['verify','finalize'].includes(phase)?'finalizer':'promotion'],github:f.github});
const tableCount=(f,table)=>f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
const dbSnapshot=f=>JSON.stringify(Object.fromEntries(f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({name})=>[name,f.db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all()])));
const retained=f=>JSON.stringify(Object.fromEntries(['private_gallery_assets','private_gallery_asset_tags','private_archive_intakes',
    'private_archive_original_receipts','private_gallery_attempts','private_gallery_attempt_framings','private_gallery_frame_revisions',
    'private_gallery_batch_intents','private_gallery_batch_reviews','private_gallery_batch_claims'].map(table=>[table,f.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()])));
const refreshRun='https://github.com/johnkevan88888/family-running/actions/runs/999';
const protectedRefresh=(f,base,patch={})=>runProtectedBatchReviewRefresh({jobId:f.jobId,runReference:refreshRun,expectedBaseSha:base,
    jobs:f.c.jobs.promotion,promotion:f.c.promotion,github:f.github,...patch});
async function removalJob(f,member) {
    const queued=await queuePrivateArchiveJob(f.env,f.owner,f.site,member.assetId,{action:'removal',idempotencyKey:crypto.randomUUID()});
    assert.equal(queued.ok,true);
    const runReference=`https://github.com/johnkevan88888/family-running/actions/runs/${1000+tableCount(f,'private_gallery_owner_jobs')}`;
    return phase=>runProtectedArchiveJob({jobId:queued.job.jobId,runReference,phase,...f.c,
        jobs:f.c.jobs[phase==='verify'?'finalizer':'promotion'],github:f.github});
}
async function removeUnmerged(f) {
    assert.equal((await execute(f,'reconcile')).state,'pending','Storage deletion is not host absence');
    assert.equal(tableCount(f,'private_gallery_active_job'),1);
    assert.equal((await execute(f,'verify')).state,'host-ready');
    assert.equal((await execute(f,'reconcile')).state,'removed');
    assert.equal(tableCount(f,'private_gallery_active_job'),0);
    assert.equal(f.original.objects.size,2);
}
for(const publication of [false,true]) {
    const f=await privateGalleryBatchFixture();
    try {
        assert.equal((await execute(f,'review')).state,'unmerged-review');
        if(publication) assert.equal((await requestPrivateArchiveBatchPublication(f.env,f.owner,f.site,f.jobId,{idempotencyKey:crypto.randomUUID()})).ok,true);
        const before=dbSnapshot(f),gitWrites=writes(f.github).length;
        f.github.advanceMain({'tests/safe-new-main.mjs':'new regression check'});
        assert.equal((await execute(f,'review')).state,'pending','Stale main alone cannot cancel a healthy review');
        assert.equal(f.github.state.pulls[0].state,'open');assert.equal(writes(f.github).length,gitWrites);
        assert.equal(dbSnapshot(f),before);assert.equal(tableCount(f,'private_gallery_active_job'),1);
        assert.equal([...f.staging.calls,...f.approved.calls].some(([operation])=>operation==='delete'),false);checks++;
    } finally {f.db.close();}
}
for(const site of ['family','everyone']) for(const mode of ['withdraw','publish']) {
    const f=await privateGalleryBatchFixture(site);
    try {
        const created=await execute(f,'review');assert.equal(created.state,'unmerged-review');
        const saved=retained(f),dbBefore=dbSnapshot(f),originalCalls=f.original.calls.length;
        const storageWrites=()=>[...f.staging.calls,...f.approved.calls].filter(call=>!['get','head'].includes(call[0])).length;
        const writesBefore=storageWrites();
        f.github.advanceMain({'tests/earlier-fix.mjs':'earlier'});
        const base=f.github.advanceMain({'tests/released-fix.mjs':'corrected'}, {updatePullBase:false});
        const result=await protectedRefresh(f,base);assert.equal(result.replayed,false);
        assert.equal(dbSnapshot(f),dbBefore,'Refresh writes NO protected rows, claim, consent or history');
        assert.equal(f.original.calls.length,originalCalls,'Refresh never reads an original');assert.equal(storageWrites(),writesBefore);
        const requestCount=f.github.state.requests.length;
        assert.equal((await protectedRefresh(f,base)).replayed,true);
        assert(f.github.state.requests.slice(requestCount).every(request=>request.method==='GET'));
        assert.equal((await execute(f,'review')).state,'unmerged-review');assert.equal(retained(f),saved);
        assert.equal(f.original.calls.length,originalCalls);assert.equal(storageWrites(),writesBefore);
        if(mode==='withdraw') {
            assert.equal((await changePrivateGalleryVisibility(f.env,f.owner,site,f.ids[0],
                {expectedVersion:2,idempotencyKey:crypto.randomUUID(),preference:'hidden'})).ok,true);
            await assert.rejects(protectedRefresh(f,base));
            await removeUnmerged(f);
            assert.equal(JSON.parse(f.db.prepare('SELECT evidence_json FROM private_gallery_batch_terminals').get().evidence_json).headSha,created.review.headSha);
            assert.equal(retained(f),saved);
        } else {
            assert.equal((await requestPrivateArchiveBatchPublication(f.env,f.owner,site,f.jobId,{idempotencyKey:crypto.randomUUID()})).ok,true);
            await assert.rejects(protectedRefresh(f,base),'Refresh cannot overlap a granted publication');
            assert.equal((await execute(f,'review')).state,'ready-for-separate-owner-merge');
            f.github.ownerMerge({...created.review,headSha:result.headSha});f.github.state.pulls[0].merged_by={login:'johnkevan88888'};
            assert.equal((await execute(f,'review')).state,'publication-observed');
            assert.equal(tableCount(f,'private_gallery_active_job'),0);
            const evidence=JSON.parse(f.db.prepare('SELECT evidence_json FROM private_gallery_batch_publications').get().evidence_json);
            assert.equal(evidence.headSha,created.review.headSha,'Publication receipt preserves original shared identity');
            assert.equal(retained(f),saved);
            // Independent withdrawal after a refreshed owner merge still
            // verifies host absence and removes exactly one member at a time.
            for(const member of f.members) {
                const run=await removalJob(f,member);
                assert.equal((await run('cleanup')).state,'cleanup-ready');assert.equal((await run('reconcile')).state,'pending');
                assert.equal((await run('verify')).state,'host-ready');
                const removal=await run('reconcile');assert.equal(removal.state,'unmerged-removal-review');
                f.github.ownerMerge(removal.review);
                // Review creation completed that owner request. A new explicit
                // removal request observes the merge; never replay closed work.
                const observe=await removalJob(f,member);
                assert.equal((await observe('cleanup')).state,'cleanup-ready');
                assert.equal((await observe('verify')).state,'host-ready');
                assert.equal((await observe('reconcile')).state,'removed');
                assert.equal((await observe('finalize')).state,'hidden-original-retained');
            }
            assert.equal(f.github.state.manifests[site].items.length,0);assert.equal(f.original.objects.size,2);assert.equal(retained(f),saved);
        }
        assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);checks++;
    } finally {f.db.close();}
}
// Real service checks deny changed catalogue, bytes, permission and closed
// generations before any Git write; job reads do not steal the original run.
for(const kind of ['catalogue','approved-display','approved-thumbnail','staging-display','staging-thumbnail','permission','closed','foreign-job','changed-member']) {
    const f=await privateGalleryBatchFixture();
    try {
        assert.equal((await execute(f,'review')).state,'unmerged-review');const base=f.github.advanceMain({}, {updatePullBase:false});
        if(kind==='catalogue') f.catalog.sourceRevision='sha256:'+'c'.repeat(64);
        if(/^(approved|staging)-(display|thumbnail)$/.test(kind)) {
            const [tier,role]=kind.split('-');
            const row=f.db.prepare('SELECT object_key FROM private_gallery_pipeline_outputs WHERE attempt_id=? AND tier=? AND role=?')
                .get(f.members[1].attemptId,tier,`photo-${role}`);
            assert(row,'Corrupt the second member\'s exact derivative, not the unrelated delivery witness');
            f[tier].objects.get(row.object_key).bytes=Buffer.from('wrong');
        }
        if(kind==='permission') await changePrivateGalleryVisibility(f.env,f.owner,'family',f.ids[0],{expectedVersion:2,idempotencyKey:crypto.randomUUID(),preference:'hidden'});
        if(kind==='closed') await f.c.promotion(f.attemptId,'close');
        const jobs=async(...args)=>{assert.equal(args[1],'read');const result=await f.c.jobs.promotion(...args);
            if(result.ok && kind==='foreign-job') result.value.job.jobId='job_00000000-0000-4000-8000-000000000000';
            if(result.ok && kind==='changed-member') result.value.job.members.reverse();return result;};
        const before=writes(f.github).length,events=[];
        await assert.rejects(protectedRefresh(f,base,{jobs,reportFailure:e=>events.push(e)}),kind);
        assert.equal(writes(f.github).length,before,kind);
        assert(events.some(e=>['permission','closed','foreign-job','changed-member'].includes(kind)?e.stage==='job-evidence':e.stage==='photo-eligibility'),JSON.stringify({kind,events}));
        if(/^(approved|staging)-/.test(kind)) assert(events.some(e=>e.stage==='photo-eligibility' && e.photoIndex===2 && e.photoCount===2));
        const printed=events.map(formatArchiveDiagnostic).join('');
        for(const sensitive of [f.jobId,...f.ids,...f.members.map(m=>m.attemptId),...f.members.map(m=>m.assetId)]) assert(!printed.includes(sensitive));
        checks++;
    } finally {f.db.close();}
}
for(const timing of ['pre-update','post-update']) {
    const f=await privateGalleryBatchFixture();
    try {
        assert.equal((await execute(f,'review')).state,'unmerged-review');const base=f.github.advanceMain({}, {updatePullBase:false});
        const before=dbSnapshot(f),sourceReads=f.original.calls.length;let changed=false;
        f.github.state.hook=async(path,method)=>{
            if(changed || !(timing==='pre-update'?method==='POST' && path==='/git/commits':
                method==='PATCH' && path.startsWith('/git/refs/'))) return;
            changed=true;
            const {object_key:key}=f.db.prepare("SELECT object_key FROM private_gallery_pipeline_outputs WHERE attempt_id=? AND tier='approved' AND role='photo-thumbnail'")
                .get(f.members[1].attemptId);
            f.approved.objects.get(key).bytes=Buffer.from('Synthetic late storage corruption');
        };
        const events=[];await assert.rejects(protectedRefresh(f,base,{reportFailure:e=>events.push(e)}));assert.equal(changed,true);
        assert(events.some(e=>e.stage==='photo-eligibility' && e.photoIndex===2));
        assert.equal(refWrites(f.github).length,timing==='pre-update'?0:1);
        assert.equal(f.github.state.pulls[0].state,timing==='pre-update'?'open':'closed');
        assert.equal(dbSnapshot(f),before,'Failure never rewrites protected review or consent');
        assert.equal(f.original.calls.length,sourceReads);assert.equal(f.original.objects.size,2);
        assert.equal([...f.staging.calls,...f.approved.calls].some(([operation])=>operation==='delete'),false);
        checks++;
    } finally {f.db.close();}
}

// Fixed enums and positions only: diagnostics cannot leak raw errors, consent,
// URLs, source paths, IDs, hashes, bodies or credentials, nor change outcomes.
const privateText='SECRET-ID-URL-PHOTO-CONSENT-MUST-NOT-LEAK';
const safe={kind:'batch-review-refresh',stage:'photo-eligibility',reason:'step-failed',photoIndex:2,photoCount:2};
assert.deepEqual(safeArchiveDiagnostic({...safe,error:new Error(privateText),message:privateText,stack:privateText,url:privateText,status:503}),safe);
assert.equal(formatArchiveDiagnostic(safe),'Gallery stopped at batch review refresh / photo-eligibility / photo 2 of 2 (step-failed).\n');
for(const invalid of [{...safe,stage:privateText},{...safe,reason:privateText},{...safe,photoIndex:0},{...safe,photoCount:21},
    {...safe,photoIndex:NaN},{...safe,photoCount:undefined},{...safe,photoIndex:'2'},{...safe,reason:'http-status'}]) {
    assert.equal(safeArchiveDiagnostic(invalid),null);assert.equal(formatArchiveDiagnostic(invalid),'');checks++;
}
for(const observer of [()=>{throw new Error(privateText);},async()=>{throw new Error(privateText);},()=>{}]) {
    const original=new Error(privateText);
    await assert.rejects(batchReviewRefreshStep(observer)('job-read',()=>{throw original;}),error=>error===original);
    assert.equal(await batchReviewRefreshStep(observer)('job-read',async()=>42),42);checks++;
}
{
    const events=[];
    await assert.rejects(protectedRefresh({jobId:'job_00000000-0000-4000-8000-000000000000',c:{jobs:{promotion:async()=>({ok:false})},promotion:async()=>assert.fail('No photo call')},github:{}},
        'a'.repeat(40),{reportFailure:e=>events.push(e)}));
    assert.deepEqual(events,[{kind:'batch-review-refresh',stage:'job-read',reason:'step-failed'}]);checks++;
}

const workflow=await readFile(new URL('../.github/workflows/gallery-batch-review-refresh.yml',import.meta.url),'utf8');
assert.match(workflow,/workflow_dispatch:/);assert.match(workflow,/environment: gallery-processing/);
assert.match(workflow,/group: gallery-archive-publication-purge\s+cancel-in-progress: false/);
assert.match(workflow,/github\.ref == 'refs\/heads\/main'/);assert.match(workflow,/ref: \$\{\{ github.sha \}\}/);
assert.match(workflow,/persist-credentials: false/);assert.match(workflow,/timeout-minutes: 10/);
assert.deepEqual([...workflow.matchAll(/\$\{\{ inputs\.([^ }]+) \}\}/g)].map(match=>match[1]),['job_id']);
assert.doesNotMatch(workflow,/GALLERY_PROCESSING_|GALLERY_WITHDRAWAL_|GALLERY_PUBLIC_HOST_|gallery-finalization|upload-artifact|pull_request_target:|schedule:|workflow_run:/);
for(const line of workflow.split('\n').filter(line=>line.includes('uses:'))) assert.match(line,/@[0-9a-f]{40}\b/);
for(const change of [{GITHUB_ACTIONS:'false'},{GITHUB_EVENT_NAME:'push'},{GITHUB_REF:'refs/heads/untrusted'},
    {GITHUB_REPOSITORY:'someone/else'},{GALLERY_BASE_SHA:'b'.repeat(40)},{GITHUB_RUN_ID:'0'},{GALLERY_ARCHIVE_JOB_ID:'wrong'}]) {
    const result=spawnSync(process.execPath,['scripts/run-gallery-batch-review-refresh.mjs'],{encoding:'utf8',env:{
        ...process.env,GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',
        GITHUB_REPOSITORY:'johnkevan88888/family-running',GITHUB_SHA:'a'.repeat(40),GALLERY_BASE_SHA:'a'.repeat(40),GITHUB_RUN_ID:'123',
        GALLERY_ARCHIVE_JOB_ID:'job_00000000-0000-4000-8000-000000000000',...change},timeout:10000});
    assert.equal(result.status,1);assert.match(result.stderr,/batch review refresh \/ configuration \(step-failed\)/);
    assert.match(result.stderr,/Batch review refresh stopped/);assert.equal(result.stdout,'');checks++;
}
const cli=await readFile(new URL('../scripts/run-gallery-batch-review-refresh.mjs',import.meta.url),'utf8');
assert.match(cli,/reportedFailures\+\+<32/);assert.match(cli,/fetchImpl:fetch,reportFailure/);
assert.doesNotMatch(cli,/console\.(?:error|log)\(error|error\.message|error\.stack/);
// Exercise the real executable with fake HTTP only. Never acquire a real token
// or contact GitHub/Cloudflare to test permission/service failure reporting.
for(const stage of ['permission-boundary','service-configuration','job-read']) {
    const script=`
        import assert from 'node:assert/strict';
        const stage=${JSON.stringify(stage)},secret=${JSON.stringify(privateText)},base='a'.repeat(40);
        let count=0;
        globalThis.fetch=async(input,options)=>{
            count++;
            if(stage==='permission-boundary') throw new Error(secret);
            const url=typeof input==='string'?input:input.url;
            let value,status=200;
            if(url.endsWith('/git/ref/heads/main')) value={ref:'refs/heads/main',object:{type:'commit',sha:base}};
            else if(url.includes('/rules/branches/main?')) value=['update','pull_request','required_status_checks'].map(type=>({type,ruleset_id:18119142,ruleset_source_type:'Repository',ruleset_source:'johnkevan88888/family-running'}));
            else if(url.endsWith('/git/refs/heads/main')) {assert.equal(options.method,'PATCH');assert.deepEqual(JSON.parse(options.body),{sha:base,force:false});status=403;value={message:secret};}
            else {assert.equal(stage,'job-read');assert(url.endsWith('/read'));status=503;value={message:secret};}
            const response=new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
            Object.defineProperty(response,'url',{value:url});return response;
        };
        process.argv=[process.execPath,'scripts/run-gallery-batch-review-refresh.mjs'];
        await import('./scripts/run-gallery-batch-review-refresh.mjs');
        assert.equal(count,stage==='permission-boundary'?1:stage==='service-configuration'?4:5);
    `;
    const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:10000,env:{...process.env,
        GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'johnkevan88888/family-running',
        GITHUB_SHA:'a'.repeat(40),GALLERY_BASE_SHA:'a'.repeat(40),GITHUB_RUN_ID:'123',GALLERY_ARCHIVE_JOB_ID:'job_00000000-0000-4000-8000-000000000000',
        GALLERY_GITHUB_APP_TOKEN:privateText,GALLERY_PROMOTION_ORIGIN:stage==='service-configuration'?'https://wrong.invalid':
            'https://family-running-gallery-promotion-dev.family-running.workers.dev',GALLERY_PROMOTION_ACCESS_CLIENT_ID:'fixture',GALLERY_PROMOTION_ACCESS_CLIENT_SECRET:privateText}});
    assert.equal(result.status,1,result.stderr);assert.equal(result.stdout,'');assert(!result.stderr.includes(privateText));
    assert(result.stderr.includes(`batch review refresh / ${stage} (step-failed)`),result.stderr);
    if(stage==='job-read') assert.match(result.stderr,/promotion\/read \(http-status; HTTP 503\)/);
    checks++;
}
console.log(`Batch refresh: ${checks} synthetic cases passed; exact immutable manifests/receipts, bounded forward history, current per-photo safety, no source or ledger writes, publication/removal continuity and protected workflow boundaries.`);
