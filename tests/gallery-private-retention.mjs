import assert from 'node:assert/strict';
import {archiveServiceFixture} from './helpers/private-gallery-service-fixture.mjs';
import {syntheticGitHub,digest} from './helpers/private-gallery-lifecycle-fixtures.mjs';
import {handleArchiveServiceRequest} from '../gallery-admin/src/private-gallery-service-adapter.js';
import {runProtectedArchiveReview,resumeProtectedArchiveRemoval} from '../scripts/gallery-media/protected-archive-lifecycle.mjs';
import {readGalleryReviewMain,createOrReconcileGalleryRemoval} from '../scripts/gallery-media/github-review-client.mjs';
import {deletePrivateArchiveOriginal} from '../gallery-admin/src/private-archive-service.js';
import {inspectPrivateArchivePurge,purgePrivateArchiveMetadata} from '../gallery-admin/src/private-gallery-retention-service.js';
import {assertArchiveIdentityAvailable} from '../gallery-admin/src/private-gallery-retirement.js';
import {changePrivateGalleryVisibility,readPrivateGalleryAssetEligibility} from '../gallery-admin/src/private-gallery-visibility-service.js';
import {reservePrivateGalleryAttempt} from '../gallery-admin/src/private-gallery-attempt-service.js';
import {reservePrivateGalleryAsset} from '../gallery-admin/src/private-gallery-asset-service.js';
import {readPrivateGalleryRoster} from '../gallery-admin/src/private-gallery-roster-service.js';
import {runProtectedArchivePurge} from '../scripts/gallery-media/protected-archive-purge.mjs';
import {queuePrivateArchiveJob,claimArchiveJob} from '../gallery-admin/src/private-gallery-job-service.js';
import * as delivery from '../gallery-admin/src/media-delivery-contract.js';
import {readFile,readdir} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';

// Prove the pinned Wrangler SQL splitter preserves every trigger body.
const require=createRequire(import.meta.url),parser=new DatabaseSync(':memory:');
for(const name of (await readdir(new URL('../gallery-admin/migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort()) {
    const sql=await readFile(new URL(`../gallery-admin/migrations/${name}`,import.meta.url),'utf8');
    for(const statement of require('wrangler').unstable_splitSqlQuery(sql)) parser.exec(statement);
}
parser.close();
for(const site of ['family','everyone']) {
    const f=await archiveServiceFixture(site),github=syntheticGitHub(),clients={};
    const narrow={DB:f.env.DB,APPROVED_MEDIA_ORIGIN:f.env.APPROVED_MEDIA_ORIGIN,EXPECTED_MEDIA_VERSION:f.env.EXPECTED_MEDIA_VERSION};
    for(const purpose of ['processing','promotion','verifier']) {
        const subject='1'.repeat(32)+'.access',origin=`https://synthetic-${purpose}.example`;
        const settings={...narrow,...(purpose==='processing'?{PROCESSOR_IDENTITIES:`subject:${subject}`,PROCESSING_ORIGIN:origin,PRIVATE_ORIGINALS:f.original,DERIVATIVE_STAGING:f.staging}:
            purpose==='promotion'?{PROMOTER_IDENTITIES:`subject:${subject}`,PROMOTION_ORIGIN:origin,APPROVED_MEDIA:f.approved,DERIVATIVE_STAGING:f.staging}:
                {PUBLIC_HOST_VERIFIER_IDENTITY:`subject:${subject}`,PUBLIC_HOST_VERIFIER_ORIGIN:origin,MEDIA_CONTRACT:delivery.MEDIA_DELIVERY_CONTRACT_VALUE,
                    MEDIA_WITNESS_KEY:delivery.MEDIA_BINDING_WITNESS_KEY,MEDIA_WITNESS_SHA256:delivery.MEDIA_BINDING_WITNESS_SHA256,
                    MEDIA_WITNESS_BYTE_COUNT:'28',MEDIA_WITNESS_CONTENT_TYPE:'image/webp'})};
        clients[purpose]=async(attemptId,operation,value)=>{
            const get=['original','candidate','review'].includes(operation),put=operation.startsWith('photo-');
            const response=await handleArchiveServiceRequest(new Request(`${origin}/api/service/archive-attempts/${attemptId}/${operation}`,
                {method:get?'GET':put?'PUT':'POST',headers:get?{}:put?{'Content-Type':'image/webp','X-Gallery-Toolchain':JSON.stringify(value.toolchain)}:{'Content-Type':'application/json'},
                    body:get?undefined:put?value.bytes:JSON.stringify(value??{})}),settings,purpose,f.catalog,
                {accessContext:{getIdentity:async()=>({service_token_status:true,common_name:subject})},fetch:f.publicFetch});
            const result=response.ok?(operation==='original'?{bytes:await response.arrayBuffer(),mimeType:response.headers.get('Content-Type'),sha256:response.headers.get('X-Gallery-Sha256')}:await response.json()):null;
            return {ok:response.ok,value:result};
        };
    }
    const main=await readGalleryReviewMain({token:github.token,fetchImpl:github.fetchImpl});
    assert.equal((await inspectPrivateArchivePurge(narrow,f.owner,site,f.assetId,main)).ok,false,'Retention is not deletion permission');
    assert.equal((await inspectPrivateArchivePurge(narrow,{type:'service',subject:'fictional'},site,f.assetId,main)).status,403);
    assert.equal((await inspectPrivateArchivePurge({...narrow,APPROVED_MEDIA:f.approved},f.owner,site,f.assetId,main)).status,403);
    assert.equal((await runProtectedArchiveReview({attemptId:f.attemptId,...clients,github})).ok,true);
    const candidateItem=JSON.parse(f.db.prepare('SELECT candidate_json FROM private_gallery_pipeline_review_intents').get().candidate_json).manifestText;
    const itemId=f.db.prepare('SELECT public_item_id FROM private_gallery_attempts').get().public_item_id;
    assert.equal((await changePrivateGalleryVisibility(f.env,f.owner,site,f.ids[0],{expectedVersion:2,idempotencyKey:crypto.randomUUID(),preference:'hidden'})).ok,true);
    assert.equal((await resumeProtectedArchiveRemoval({attemptId:f.attemptId,...clients,github})).state,'removed');
    assert.equal((await inspectPrivateArchivePurge(narrow,f.owner,site,f.assetId,main)).ok,false,'Hide retains all private records');
    // Add a second, never-admitted reservation. Purge must still reconcile it;
    // it is not silently omitted because it has no public output yet.
    assert.equal((await changePrivateGalleryVisibility(f.env,f.owner,site,f.ids[0],{expectedVersion:3,idempotencyKey:crypto.randomUUID(),preference:'allowed'})).ok,true);
    const eligible=await readPrivateGalleryAssetEligibility(f.env,f.owner,site,f.assetId,f.catalog);
    const fresh=await reservePrivateGalleryAttempt(f.env,f.owner,site,f.assetId,{...f.consent,idempotencyKey:crypto.randomUUID(),eligibilityRevision:eligible.revision},f.catalog);
    assert.equal(fresh.ok,true);
    assert.equal((await deletePrivateArchiveOriginal(f.env,f.owner,site,f.assetId,'consent-withdrawal')).ok,true);
    assert.equal((await inspectPrivateArchivePurge(narrow,f.owner,site,f.assetId,main)).ok,false,'Unadmitted generation still needs host/main/storage reconciliation');
    assert.equal((await resumeProtectedArchiveRemoval({attemptId:fresh.attemptId,...clients,github})).state,'removed');
    const before=f.db.prepare('SELECT count(*) n FROM private_gallery_assets').get().n;
    const dry=await inspectPrivateArchivePurge(narrow,f.owner,site,f.assetId,main);
    assert.equal(dry.ok,true,JSON.stringify(dry));assert.equal(dry.dryRun,true);
    assert.equal(dry.attemptCount,2);assert.equal(dry.outputCount,4);
    assert.deepEqual(globalThis.galleryContract.validateGalleryDocument(JSON.parse(candidateItem)),[]);
    // Exercise actual removal intent/review guards in an isolated savepoint.
    // Pending terminal removal authority must survive even if main is absent.
    f.db.exec('SAVEPOINT synthetic_pending_removal');
    github.state.manifests[site]=JSON.parse(candidateItem);
    const reserved=await clients.promotion(f.attemptId,'removal-reserve',await readGalleryReviewMain({token:github.token,fetchImpl:github.fetchImpl}));
    assert.equal(reserved.ok,true);
    assert.equal((await inspectPrivateArchivePurge(narrow,f.owner,site,f.assetId,main)).ok,false,'Unresolved removal intent blocks purge');
    const removalReview=await createOrReconcileGalleryRemoval(reserved.value.removal,{expectedBaseSha:main.baseSha,token:github.token,fetchImpl:github.fetchImpl});
    assert.equal((await clients.promotion(f.attemptId,'removal-open',{baseSha:main.baseSha,review:removalReview})).ok,true);
    assert.equal((await inspectPrivateArchivePurge(narrow,f.owner,site,f.assetId,main)).ok,false,'Removal review is not terminal evidence');
    f.db.exec('ROLLBACK TO synthetic_pending_removal; RELEASE synthetic_pending_removal');
    github.state.manifests[site]=structuredClone(main.manifestsBySite[site]);
    const other=site==='family'?'everyone':'family';
    assert.equal((await inspectPrivateArchivePurge(narrow,f.owner,site,f.assetId,{...main,manifestsBySite:{...main.manifestsBySite,
        [other]:JSON.parse(candidateItem)}})).ok,false,'Cross-area reference to historical URL blocks purge');
    assert.equal(f.db.prepare('SELECT count(*) n FROM private_archive_purge_receipts').get().n,0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_assets').get().n,before);
    assert.equal((await inspectPrivateArchivePurge(narrow,f.owner,site==='family'?'everyone':'family',f.assetId,main)).ok,false);
    assert.equal((await inspectPrivateArchivePurge(narrow,{type:'browser',subject:'other-fictional-owner'},site,f.assetId,main)).ok,false);
    assert.equal((await inspectPrivateArchivePurge({...narrow,EXPECTED_MEDIA_VERSION:'00000000-0000-4000-8000-000000000001'},f.owner,site,f.assetId,main)).ok,false);
    assert.equal((await inspectPrivateArchivePurge(narrow,f.owner,site,f.assetId,{...main,baseSha:'f'.repeat(40)})).ok,false,'Historical main receipt is not current main');
    const input={purgeKey:crypto.randomUUID(),expectedProofHash:dry.proofHash,main};
    assert.equal((await purgePrivateArchiveMetadata(narrow,f.owner,site,f.assetId,input)).ok,false,'No purge outside an owner-confirmed coordinated job');
    const job=await queuePrivateArchiveJob(narrow,f.owner,site,f.assetId,{action:'purge',idempotencyKey:crypto.randomUUID(),
        expectedProofHash:input.expectedProofHash,purgeKey:input.purgeKey});assert.equal(job.ok,true);
    await claimArchiveJob(narrow,job.job.jobId,'https://github.com/johnkevan88888/family-running/actions/runs/999','finalizer');
    assert.equal((await runProtectedArchivePurge({env:narrow,identity:f.owner,site,assetId:f.assetId,github})).ok,true);
    let headReads=0;
    const changedGitHub={...github,fetchImpl:async(...args)=>{
        // Each fixed-client read checks main before and after content reads.
        // Move it when the wrapper begins its second complete snapshot read.
        if(String(args[0]).endsWith('/git/ref/heads/main') && ++headReads===3) github.state.main='f'.repeat(40);
        return github.fetchImpl(...args);
    }};
    assert.equal((await runProtectedArchivePurge({env:narrow,identity:f.owner,site,assetId:f.assetId,github:changedGitHub,
        input:{purgeKey:input.purgeKey,expectedProofHash:input.expectedProofHash},dryRun:false})).ok,false);
    assert.ok(headReads>=3);github.state.main=main.baseSha;
    assert.equal((await purgePrivateArchiveMetadata(narrow,f.owner,site,f.assetId,{...input,expectedProofHash:'0'.repeat(64)})).ok,false);
    // Guard replacement must NOT make direct child/parent deletes possible.
    for(const table of ['private_gallery_assets','private_gallery_asset_tags','private_gallery_attempts','private_archive_deletion_receipts',
        'private_gallery_pipeline_outputs','private_gallery_pipeline_reviews'])
        assert.throws(()=>f.db.exec(`DELETE FROM ${table}`),/Exact atomic archive purge required/);
    // Abort near the end: every earlier delete, tombstone and audit insert rolls back.
    f.db.exec("CREATE TRIGGER synthetic_purge_failure BEFORE DELETE ON private_gallery_assets BEGIN SELECT RAISE(ABORT,'synthetic interruption'); END");
    assert.equal((await purgePrivateArchiveMetadata(narrow,f.owner,site,f.assetId,input)).ok,false);
    assert.equal(f.db.prepare('SELECT count(*) n FROM private_archive_purge_receipts').get().n,0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM private_archive_purge_operations').get().n,0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_retired_generations').get().n,0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_pipeline_outputs').get().n,4);
    assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_attempts').get().n,2);
    f.db.exec('DROP TRIGGER synthetic_purge_failure');
    const calls=f.original.calls.length+f.staging.calls.length+f.approved.calls.length,hostCalls=f.hostRequests.length;
    const snapshot=JSON.parse(f.db.prepare('SELECT snapshot_json FROM private_archive_purge_snapshots').get().snapshot_json);
    const retained=await reservePrivateGalleryAsset(f.env,f.owner,site,{idempotencyKey:crypto.randomUUID(),
        rosterRevision:(await readPrivateGalleryRoster(f.env,site)).revision,personIds:f.ids,originalFormat:'jpg'});
    assert.equal(retained.ok,true);
    // A committed INSERT with a lost response must recover from the hash-only receipt.
    const run=f.env.DB.prepare.bind(f.env.DB);
    const lost={...narrow,DB:{prepare(sql){const statement=run(sql);const original=statement.run;statement.run=async()=>{const result=await original.call(statement);
        if(sql.startsWith('INSERT INTO private_archive_purge_operations')) throw new Error('synthetic lost response');return result;};return statement;}}};
    const completed=await purgePrivateArchiveMetadata(lost,f.owner,site,f.assetId,input);
    assert.equal(completed.ok,true,JSON.stringify(completed));assert.equal(completed.replayed,true);
    assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_assets').get().n,1,'Unrelated private asset survives');
    assert.equal(f.db.prepare('SELECT asset_id FROM private_gallery_assets').get().asset_id,retained.asset.assetId);
    assert.equal(f.db.prepare('SELECT count(*) n FROM private_archive_purge_operations').get().n,0,'No reusable deletion grant survives');
    assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_retired_generations').get().n,2);
    assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_retired_keys').get().n,4);
    assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_people').get().n,2,'Shared private people/preferences are not photo records');
    const receipt=f.db.prepare('SELECT * FROM private_archive_purge_receipts').get();
    assert.deepEqual(Object.keys(receipt).sort(),['asset_id_hash','proof_hash','purged_at','reservation_key_hash','scope_hash']);
    for(const field of ['asset_id_hash','proof_hash','reservation_key_hash','scope_hash']) assert.match(receipt[field],/^[0-9a-f]{64}$/);
    for(const value of [f.assetId,itemId,f.owner.subject,site,'provider_upload_id','Fictitious tagged person'])
        assert.equal(JSON.stringify(receipt).includes(value),false);
    for(const row of snapshot.attempts) {
        await assert.rejects(assertArchiveIdentityAvailable(narrow,'generation',row[1]));
        await assert.rejects(assertArchiveIdentityAvailable(narrow,'item',row[2]));
    }
    for(const row of snapshot.outputs) await assert.rejects(assertArchiveIdentityAvailable(narrow,'key',row[3]));
    await assert.rejects(assertArchiveIdentityAvailable(narrow,'asset',f.assetId));
    const replay=await purgePrivateArchiveMetadata({...narrow,EXPECTED_MEDIA_VERSION:'unavailable'},f.owner,site,f.assetId,{...input,main:null});
    assert.equal(replay.ok,true);assert.equal(replay.replayed,true);
    assert.equal((await runProtectedArchivePurge({env:narrow,identity:f.owner,site,assetId:f.assetId,
        github:{fetchImpl:()=>{throw new Error('Must not contact GitHub');}},input:{purgeKey:input.purgeKey,expectedProofHash:input.expectedProofHash},dryRun:false})).ok,true);
    assert.equal((await reservePrivateGalleryAsset(f.env,f.owner,site,{idempotencyKey:snapshot.reservation,
        rosterRevision:(await readPrivateGalleryRoster(f.env,site)).revision,personIds:f.ids,originalFormat:'jpg'})).ok,false,'Retired owner reservation cannot create new identity');
    assert.equal((await purgePrivateArchiveMetadata(narrow,{type:'browser',subject:'other-fictional-owner'},site,f.assetId,input)).ok,false);
    assert.equal((await purgePrivateArchiveMetadata(narrow,f.owner,site,f.assetId,{...input,purgeKey:crypto.randomUUID()})).ok,false);
    assert.equal((await purgePrivateArchiveMetadata(narrow,f.owner,site,f.assetId,{...input,expectedProofHash:'0'.repeat(64)})).ok,false,'Completed replay remains proof-bound');
    assert.equal(f.original.calls.length+f.staging.calls.length+f.approved.calls.length,calls,'Purge never replays byte cleanup');
    assert.equal(f.hostRequests.length,hostCalls,'Purge never fabricates or replays host verification');
    for(const table of ['private_archive_purge_receipts','private_gallery_retired_generations','private_gallery_retired_keys','private_gallery_retired_jobs'])
    {
        assert.throws(()=>f.db.exec(`DELETE FROM ${table}`),/immutable/);
        const row=f.db.prepare(`SELECT * FROM ${table} LIMIT 1`).get(),field=Object.keys(row)[0];
        assert.throws(()=>f.db.exec(`UPDATE ${table} SET ${field}=${field}`),/immutable/);
        assert.throws(()=>f.db.prepare(`INSERT OR REPLACE INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row)),/cannot be replaced/);
    }
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.equal(f.db.prepare('PRAGMA quick_check').get().quick_check,'ok');
    assert.equal(f.db.prepare('SELECT count(*) n FROM gallery_drafts').get().n,0);f.db.close();
}
// Never-published retained originals have no fabricated public-host receipt.
// Zero actual generations is distinct from "R2 looks empty".
for(const site of ['family','everyone']) {
    const f=await archiveServiceFixture(site,{reserveAttempt:false}),github=syntheticGitHub();
    const narrow={DB:f.env.DB,APPROVED_MEDIA_ORIGIN:f.env.APPROVED_MEDIA_ORIGIN,EXPECTED_MEDIA_VERSION:f.env.EXPECTED_MEDIA_VERSION};
    assert.equal((await runProtectedArchivePurge({env:narrow,identity:f.owner,site,assetId:f.assetId,github})).ok,false);
    assert.equal((await deletePrivateArchiveOriginal(f.env,f.owner,site,f.assetId,'owner-delete')).ok,true);
    const dry=await runProtectedArchivePurge({env:narrow,identity:f.owner,site,assetId:f.assetId,github});
    assert.equal(dry.ok,true);assert.equal(dry.attemptCount,0);assert.equal(dry.outputCount,0);
    const input={purgeKey:crypto.randomUUID(),expectedProofHash:dry.proofHash};
    const job=await queuePrivateArchiveJob(narrow,f.owner,site,f.assetId,{action:'purge',idempotencyKey:crypto.randomUUID(),...input});assert.equal(job.ok,true);
    await claimArchiveJob(narrow,job.job.jobId,'https://github.com/johnkevan88888/family-running/actions/runs/999','finalizer');
    const done=await runProtectedArchivePurge({env:narrow,identity:f.owner,site,assetId:f.assetId,github,input,dryRun:false});
    assert.equal(done.ok,true,JSON.stringify(done));assert.equal(done.replayed,false);
    assert.equal(f.hostRequests.length,0);assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_pipeline_host_receipts').get().n,0);
    f.db.close();
}
console.log('Local terminal archive metadata purge passed both areas: Hide denied, all generations/current proofs required, dry-run, atomic rollback, hash-only retirement and no-cleanup replay.');
