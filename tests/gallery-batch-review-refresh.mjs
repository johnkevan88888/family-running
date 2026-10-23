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
        const writesBefore=storageWrites(),base=f.github.advanceMain({'tests/released-fix.mjs':'corrected'});
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
        assert.equal((await execute(f,'review')).state,'unmerged-review');const base=f.github.advanceMain();
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
        const before=writes(f.github).length;await assert.rejects(protectedRefresh(f,base,{jobs}),kind);assert.equal(writes(f.github).length,before,kind);checks++;
    } finally {f.db.close();}
}
for(const timing of ['pre-update','post-update']) {
    const f=await privateGalleryBatchFixture();
    try {
        assert.equal((await execute(f,'review')).state,'unmerged-review');const base=f.github.advanceMain();
        const before=dbSnapshot(f),sourceReads=f.original.calls.length;let changed=false;
        f.github.state.hook=async(path,method)=>{
            if(changed || !(timing==='pre-update'?method==='POST' && path==='/git/commits':
                method==='PATCH' && path.startsWith('/git/refs/'))) return;
            changed=true;
            const {object_key:key}=f.db.prepare("SELECT object_key FROM private_gallery_pipeline_outputs WHERE attempt_id=? AND tier='approved' AND role='photo-thumbnail'")
                .get(f.members[1].attemptId);
            f.approved.objects.get(key).bytes=Buffer.from('Synthetic late storage corruption');
        };
        await assert.rejects(protectedRefresh(f,base));assert.equal(changed,true);
        assert.equal(refWrites(f.github).length,timing==='pre-update'?0:1);
        assert.equal(f.github.state.pulls[0].state,timing==='pre-update'?'open':'closed');
        assert.equal(dbSnapshot(f),before,'Failure never rewrites protected review or consent');
        assert.equal(f.original.calls.length,sourceReads);assert.equal(f.original.objects.size,2);
        assert.equal([...f.staging.calls,...f.approved.calls].some(([operation])=>operation==='delete'),false);
        checks++;
    } finally {f.db.close();}
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
    assert.equal(result.status,1);assert.match(result.stderr,/Batch review refresh stopped/);assert.equal(result.stdout,'');checks++;
}
console.log(`Batch refresh: ${checks} synthetic cases passed; exact immutable manifests/receipts, bounded forward history, current per-photo safety, no source or ledger writes, publication/removal continuity and protected workflow boundaries.`);
