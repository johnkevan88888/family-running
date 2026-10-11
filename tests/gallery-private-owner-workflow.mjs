import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {archiveServiceFixture} from './helpers/private-gallery-service-fixture.mjs';
import {privateGalleryJobFixture} from './helpers/private-gallery-job-fixture.mjs';
import {syntheticGitHub} from './helpers/private-gallery-lifecycle-fixtures.mjs';
import {runProtectedArchiveJob} from '../scripts/gallery-media/protected-archive-job.mjs';
import {runProtectedArchiveReview,resumeProtectedArchiveRemoval} from '../scripts/gallery-media/protected-archive-lifecycle.mjs';
import {changePrivateGalleryVisibility} from '../gallery-admin/src/private-gallery-visibility-service.js';
import {deletePrivateArchiveOriginal} from '../gallery-admin/src/private-archive-service.js';
import {preparePrivateArchiveIntake,storePrivateArchiveOriginal} from '../gallery-admin/src/private-archive-service.js';
import {reservePrivateGalleryAsset} from '../gallery-admin/src/private-gallery-asset-service.js';
import {readPrivateGalleryRoster} from '../gallery-admin/src/private-gallery-roster-service.js';
import {readBoundedBytes,sha256Hex} from '../gallery-admin/src/media-byte-verification.js';
import {runArchivePhotoReview} from '../scripts/gallery-media/private-photo-lifecycle.mjs';
import {queuePrivateArchiveJob,claimArchiveJob,readRetiredArchiveJob} from '../gallery-admin/src/private-gallery-job-service.js';
import {readGalleryReviewMain} from '../scripts/gallery-media/github-review-client.mjs';
import {inspectPrivateArchivePurge,purgePrivateArchiveMetadata} from '../gallery-admin/src/private-gallery-retention-service.js';
const runReference='https://github.com/johnkevan88888/family-running/actions/runs/123';
for(const site of ['family','everyone']) {
    // Before PR admission: no fabricated open-review receipt is needed. The
    // checked GitHub observation AND absence of a durable POST admission win.
    {
        const f=await archiveServiceFixture(site),c=await privateGalleryJobFixture(f),github=syntheticGitHub();
        let once=true;github.state.hook=(path,method)=>{if(once && method==='POST' && path==='/git/blobs') {once=false;throw new Error('Synthetic pre-PR interruption');}};
        assert.equal((await runProtectedArchiveReview({attemptId:f.attemptId,...c,github})).ok,false);
        const writes=github.state.requests.filter(r=>r.method!=='GET').length;
        assert.equal((await resumeProtectedArchiveRemoval({attemptId:f.attemptId,...c,github})).state,'removed');
        assert.equal(github.state.requests.filter(r=>r.method!=='GET').length,writes,'No-PR recovery never creates a PR');
        assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_pipeline_reviews').get().n,0);
        assert.equal(JSON.parse(f.db.prepare('SELECT evidence_json FROM private_gallery_review_terminals').get().evidence_json).state,'no-pr-created');
        assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_asset_tags').get().n,2);
        assert.equal(f.original.objects.size,1);f.db.close();
    }
    // An admitted POST really IS in flight. An empty PR list cannot finish
    // removal or purge. When it lands, resume closes the exact PR positively.
    {
        const f=await archiveServiceFixture(site),c=await privateGalleryJobFixture(f),github=syntheticGitHub();
        let release,entered;const enteredPromise=new Promise(resolve=>{entered=resolve;});
        const held=new Promise(resolve=>{release=resolve;});
        github.state.hook=async(path,method)=>{if(method==='POST'&&path==='/pulls') {entered();await held;}};
        const reviewing=runProtectedArchiveReview({attemptId:f.attemptId,...c,github});await enteredPromise;
        assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_review_write_admissions').get().n,1);
        assert.equal((await resumeProtectedArchiveRemoval({attemptId:f.attemptId,...c,github})).ok,false,'Admitted uncertain PR is NOT no-PR proof');
        assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_review_terminals').get().n,0);
        release();assert.equal((await reviewing).ok,false);
        assert.equal((await resumeProtectedArchiveRemoval({attemptId:f.attemptId,...c,github})).state,'removed');
        assert.equal(github.state.pulls[0].state,'closed');
        assert.equal(JSON.parse(f.db.prepare('SELECT evidence_json FROM private_gallery_review_terminals').get().evidence_json).state,'closed-unmerged');
        f.db.close();
    }
    // Real owner HTTP -> job ledger -> split authenticated HTTP -> processor ->
    // exact review client, then a separate held publication preparation gate.
    {
        const f=await archiveServiceFixture(site),c=await privateGalleryJobFixture(f),github=syntheticGitHub();
        const input={action:'review',attemptId:f.attemptId,idempotencyKey:crypto.randomUUID()};
        for(const [extra,identity] of [[{'X-CSRF-Token':'wrong'},f.owner],[{},c.identities.promotion]])
            assert.equal((await c.ownerResponse(f.assetId,input,extra,identity)).status,403);
        assert.equal((await c.ownerResponse(f.assetId,{...input,siteMode:site})).status,422);
        assert.equal((await c.ownerResponse(f.assetId,{...input,assetId:f.assetId})).status,422);
        const jobId=await c.ownerJob(input);assert.equal(await c.ownerJob(input),jobId);
        const execute=(phase,id=jobId,purpose='promotion')=>runProtectedArchiveJob({jobId:id,runReference,phase,...c,jobs:c.jobs[purpose],github});
        for(const invalid of [runReference.replace('/123','/0'),runReference+'x',runReference+'?attempt=1',runReference.replace('family-running','other-repository')])
            assert.throws(()=>f.db.prepare('INSERT INTO private_gallery_job_claims(job_id,run_reference,run_hash) VALUES(?,?,?)')
                .run(jobId,invalid,'0'.repeat(64)),/Fixed protected run reference/,'SQL requires the exact repository and positive digits-only run');
        const review=await execute('review');assert.equal(review.state,'unmerged-review',JSON.stringify(review));
        const originalCalls=f.original.calls.length;
        assert.equal((await execute('review')).replayed,true);assert.equal(f.original.calls.length,originalCalls);
        const publishId=await c.ownerJob({action:'publication',attemptId:f.attemptId,idempotencyKey:crypto.randomUUID()});
        const prepared=await execute('publication',publishId);assert.equal(prepared.state,'ready-for-separate-owner-merge',JSON.stringify(prepared));
        assert.equal(prepared.claimHeld,true);
        assert.throws(()=>f.db.prepare('INSERT INTO private_gallery_job_completions(job_id,state,result_json) VALUES(?,?,?)')
            .run(publishId,'removed',JSON.stringify({state:'removed',publicationEnabled:false})),/owner-requested action/,
            'Direct SQL cannot release a publication claim with a removal outcome');
        assert.throws(()=>f.db.prepare('INSERT INTO private_gallery_job_completions(job_id,state,result_json) VALUES(?,?,?)')
            .run(publishId,'publication-observed',JSON.stringify({state:'removed',publicationEnabled:false})),/envelope/,
            'Direct SQL cannot disguise the completion outcome');
        // A genuinely purge-eligible different archive cannot overlap this
        // publication. This is not merely a purge denied for missing proofs.
        const roster=(await readPrivateGalleryRoster(f.env,site)).revision;
        const other=await reservePrivateGalleryAsset(f.env,f.owner,site,{idempotencyKey:crypto.randomUUID(),rosterRevision:roster,personIds:f.ids,originalFormat:'jpg'});
        assert.equal(other.ok,true);const otherId=other.asset.assetId;
        assert.equal((await preparePrivateArchiveIntake(f.env,f.owner,site,otherId,{rosterRevision:roster,byteCount:f.photo.length,sha256:await sha256Hex(f.photo),
            declaredMimeType:'image/jpeg',privateRetentionConfirmed:true,containsMinors:false,guardianApprovalConfirmed:false})).ok,true);
        assert.equal((await storePrivateArchiveOriginal(f.env,f.owner,site,otherId,new Blob([f.photo]).stream(),{
            digestReadable:async body=>sha256Hex(await readBoundedBytes(body,f.photo.length))})).ok,true);
        assert.equal((await deletePrivateArchiveOriginal(f.env,f.owner,site,otherId,'owner-delete')).ok,true);
        const narrow={DB:f.env.DB,APPROVED_MEDIA_ORIGIN:f.env.APPROVED_MEDIA_ORIGIN,EXPECTED_MEDIA_VERSION:f.env.EXPECTED_MEDIA_VERSION};
        const otherMain=await readGalleryReviewMain({token:github.token,fetchImpl:github.fetchImpl});
        const otherDry=await inspectPrivateArchivePurge(narrow,f.owner,site,otherId,otherMain);assert.equal(otherDry.ok,true);
        const otherInput={purgeKey:crypto.randomUUID(),expectedProofHash:otherDry.proofHash,main:otherMain};
        const otherJob=await queuePrivateArchiveJob(f.env,f.owner,site,otherId,{action:'purge',idempotencyKey:crypto.randomUUID(),
            purgeKey:otherInput.purgeKey,expectedProofHash:otherInput.expectedProofHash});assert.equal(otherJob.ok,true);
        const beforeOtherPurge=github.state.requests.length;
        assert.equal((await execute('purge',otherJob.job.jobId,'finalizer')).ok,false);
        assert.equal(github.state.requests.length,beforeOtherPurge,'Purge refused before even reading GitHub while publication holds the slot');
        assert.equal((await purgePrivateArchiveMetadata(narrow,f.owner,site,otherId,otherInput)).ok,false,'SQL independently denies an uncoordinated purge');
        const removeId=await c.ownerJob({action:'removal',idempotencyKey:crypto.randomUUID()});
        const githubReads=github.state.requests.length;
        assert.equal((await execute('cleanup',removeId)).ok,false,'Publication owns global slot');
        assert.equal(github.state.requests.length,githubReads);
        assert.equal((await c.jobs.promotion(publishId,'claim',{runReference:runReference+'4'})).ok,false,'Different run cannot steal a durable claim');
        for(const table of ['private_gallery_job_claims','private_gallery_owner_jobs']) {
            assert.throws(()=>f.db.exec(`DELETE FROM ${table}`),/Exact atomic/);
            assert.throws(()=>f.db.exec(`UPDATE ${table} SET job_id=job_id`),/immutable/);
        }
        github.ownerMerge(review.review); // Fixture-only separately authorized owner merge.
        assert.equal((await execute('publication',publishId)).state,'publication-observed');
        assert.equal((await changePrivateGalleryVisibility(f.env,f.owner,site,f.ids[0],{expectedVersion:2,idempotencyKey:crypto.randomUUID(),preference:'hidden'})).ok,true);
        assert.equal((await execute('cleanup',removeId)).state,'cleanup-ready');
        assert.equal((await execute('verify',removeId,'finalizer')).state,'host-ready');
        const removing=await execute('reconcile',removeId);assert.equal(removing.state,'unmerged-removal-review',JSON.stringify(removing));
        assert.equal((await execute('finalize',removeId,'finalizer')).state,'awaiting-owner-removal-review');
        // Owner merges the removal; a new owner-approved recovery job observes
        // main AND settles that exact removal review before it can purge.
        github.ownerMerge(removing.review);
        const recovery=await c.ownerJob({action:'removal',idempotencyKey:crypto.randomUUID()});
        const counts=[f.staging.calls.filter(c=>c[0]==='delete').length,f.approved.calls.filter(c=>c[0]==='delete').length,f.hostRequests.length];
        assert.equal((await execute('cleanup',recovery)).ok,true);
        assert.equal((await execute('verify',recovery,'finalizer')).ok,true);
        assert.equal((await execute('reconcile',recovery)).state,'removed');
        assert.equal((await execute('finalize',recovery,'finalizer')).state,'hidden-original-retained');
        assert.deepEqual([f.staging.calls.filter(c=>c[0]==='delete').length,f.approved.calls.filter(c=>c[0]==='delete').length,f.hostRequests.length],counts,'Recovery reuses completed byte/host evidence');
        assert.equal(f.original.objects.size,1);assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_asset_tags WHERE asset_id=?').get(f.assetId).n,2);
        assert.equal((await c.ownerResponse(f.assetId,{action:'purge-inspect',idempotencyKey:crypto.randomUUID()})).status,409,'Hide is not terminal retention withdrawal');
        assert.equal((await deletePrivateArchiveOriginal(f.env,f.owner,site,f.assetId,'owner-delete')).ok,true);
        const inspectId=await c.ownerJob({action:'purge-inspect',idempotencyKey:crypto.randomUUID()});
        assert.equal((await c.jobs.finalizer(inspectId,'claim',{runReference})).ok,true);
        assert.throws(()=>f.db.prepare('INSERT INTO private_gallery_job_completions(job_id,state,result_json) VALUES(?,?,?)')
            .run(inspectId,'purge-eligible',JSON.stringify({state:'purge-eligible',publicationEnabled:false,dryRun:false,proofHash:'0'.repeat(64)})),
            /Exact inspection result/,'Direct SQL cannot release an inspection claim with fabricated non-dry-run evidence');
        const dry=await execute('purge',inspectId,'finalizer');assert.equal(dry.state,'purge-eligible',JSON.stringify(dry));assert.equal(dry.dryRun,true);
        const purgeId=await c.ownerJob({action:'purge',idempotencyKey:crypto.randomUUID(),purgeKey:crypto.randomUUID(),expectedProofHash:dry.proofHash});
        const done=await execute('purge',purgeId,'finalizer');assert.equal(done.state,'private-records-purged',JSON.stringify(done));
        const calls=c.requests.length;
        const replay=await runProtectedArchiveJob({jobId:purgeId,runReference,phase:'purge',jobs:c.jobs.finalizer,
            github:{fetchImpl:()=>assert.fail('Completed purge must never read GitHub')}});
        assert.equal(replay.state,'private-records-purged');assert.equal(replay.replayed,true);assert.equal(c.requests.length,calls+1,'Only hash-only receipt read');
        assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_owner_jobs').get().n,1,'Unrelated queued job survives the exact asset purge');
        assert.equal(f.db.prepare('SELECT asset_id FROM private_gallery_owner_jobs').get().asset_id,otherId);
        assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_retired_jobs').get().n,1);
        assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_active_job').get().n,0);
        assert.equal(await readRetiredArchiveJob(f.env,purgeId,runReference+'4'),null);
        assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
        assert.equal(github.state.requests.some(r=>r.path.endsWith('/merge') || r.method==='DELETE' || r.method==='PATCH'&&r.path.includes('/git/refs/heads/main')),false);
        f.db.close();
    }
}
// Upgrade must conservatively retain uncertainty for historical intents which
// predate the PR gate. It cannot turn a missing legacy admission into no-PR.
{
    const f=await archiveServiceFixture('family',{migrationThrough:26}),github=syntheticGitHub();
    assert.equal((await runArchivePhotoReview({env:f.env,identity:f.owner,site:f.site,attemptId:f.attemptId,catalog:f.catalog,github,
        publicFetch:f.publicFetch})).ok,false);
    const consentBefore=f.db.prepare('SELECT * FROM private_gallery_attempts').get();
    const intentBefore=f.db.prepare('SELECT * FROM private_gallery_pipeline_review_intents').get();assert.ok(intentBefore);
    for(const filename of ['0027_private_gallery_review_recovery.sql','0028_private_gallery_owner_jobs.sql'])
        f.db.exec(await readFile(new URL('../gallery-admin/migrations/'+filename,import.meta.url),'utf8'));
    assert.deepEqual(f.db.prepare('SELECT * FROM private_gallery_attempts').get(),consentBefore);
    assert.deepEqual(f.db.prepare('SELECT * FROM private_gallery_pipeline_review_intents').get(),intentBefore);
    assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_review_write_admissions').get().n,1);
    const c=await privateGalleryJobFixture(f);
    assert.equal((await resumeProtectedArchiveRemoval({attemptId:f.attemptId,...c,github})).ok,false,'Unknown historical writer stays pending');
    assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_review_terminals').get().n,0);f.db.close();
}
for(const filename of ['gallery-archive-job.yml','gallery-archive-purge.yml']) {
    const text=await readFile(new URL('../.github/workflows/'+filename,import.meta.url),'utf8');
    assert.match(text,/workflow_dispatch:/);assert.doesNotMatch(text,/pull_request_target:|schedule:|workflow_run:|repository_dispatch:/);
    assert.match(text,/group: gallery-archive-publication-purge/);assert.match(text,/cancel-in-progress: false/);
    assert.match(text,/permissions:\s+contents: read/);assert.match(text,/inputs:\s+job_id:/);
    assert.doesNotMatch(text,/inputs\.(?:site|branch|asset|action|url|token|secret)|persist-credentials: true|upload-artifact|wrangler|gh pr merge|skip-token-revoke/);
    for(const action of text.matchAll(/uses: (\S+)/g)) assert.match(action[1],/@[0-9a-f]{40}$/);
    for(const block of text.split(/\n  [a-z-]+:\n/).slice(1)) if(block.includes('runs-on:')) {
        assert.match(block,/github\.repository == 'johnkevan88888\/family-running'/);assert.match(block,/github\.ref == 'refs\/heads\/main'/);
        assert.match(block,/environment: gallery-(processing|finalization)/);
        if(block.includes('environment: gallery-processing')) assert.doesNotMatch(block,/secrets.GALLERY_(PUBLIC_HOST_VERIFIER|WITHDRAWAL_FINALIZER)/);
        else assert.doesNotMatch(block,/secrets.GALLERY_(PROCESSING|PROMOTION|REVIEW_APP)/);
    }
}
const denied=spawnSync(process.execPath,['scripts/run-gallery-archive-job.mjs'],{env:{...process.env,GITHUB_ACTIONS:'false'},encoding:'utf8'});
assert.equal(denied.status,1);assert.doesNotMatch(denied.stdout,/token|secret|photo|person_/);
console.log('Owner/workflow HTTP connections, pre-POST/no-PR and delayed-POST recovery, terminal removal reviews, non-expiring publication/purge serialization and hash-only purge replay pass both areas using generated media only.');
