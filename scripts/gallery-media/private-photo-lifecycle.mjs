import { processGalleryPhoto } from './processor.mjs';
import { assertPhotoFramingSource } from './photo-framing-source.mjs';
import { createOrReconcileArchiveGalleryReview,createOrReconcileArchiveGalleryRemoval,invalidateGalleryReview,readExistingGalleryReview,readGalleryReviewMain,readMergedGalleryReview,reconcileArchiveGalleryReview } from './github-review-client.mjs';
import { admitArchivePhotoProcessing,readArchivePhotoAttempt,readArchivePhotoSource,storeArchivePhotoDerivative,
    readArchivePhotoCandidateItem,closeArchivePhotoAttempt,removeArchivePhotoCopies,
    verifyArchivePhotoPublicAbsence,readArchivePhotoRemovalState } from '../../gallery-admin/src/private-gallery-photo-lifecycle.js';
import { changePrivateGalleryVisibility } from '../../gallery-admin/src/private-gallery-visibility-service.js';
import { reservePrivateGalleryAttempt } from '../../gallery-admin/src/private-gallery-attempt-service.js';
import { sha256Hex } from '../../gallery-admin/src/media-byte-verification.js';

// Internal runner library only: no CLI entry point, workflow/HTTP route, token
// discovery, ambient fetch, merge, deployment or publication capability.
const hash=text=>sha256Hex(new TextEncoder().encode(text));
const first=(env,sql,...args)=>env.DB.prepare(sql).bind(...args).first();
async function put(env,sql,...args) {
    const result=await env.DB.prepare(sql).bind(...args).run();
    if(result?.success!==true) throw new Error('Unavailable');
}
const canonical=value=>`${JSON.stringify(value,null,2)}\n`;
const githubOptions=github=>({token:github.token,fetchImpl:github.fetchImpl});
const pending=()=>({ok:false,status:409,state:'pending',code:'private-photo-pending-or-changed'});

async function candidateFor(env,identity,site,attemptId,catalog,main) {
    const item=await readArchivePhotoCandidateItem(env,identity,site,attemptId,catalog);
    const own=main.manifestsBySite[site],other=main.manifestsBySite[site==='family'?'everyone':'family'];
    if(own.items.some(i=>i.id===item.id) || other.items.some(i=>i.id===item.id)) throw new Error('Existing item');
    const manifestText=canonical({schemaVersion:'1.0',items:[...own.items,item]});
    const manifestSha256=`sha256:${await hash(manifestText)}`;
    return {changed:true,targetRelativePath:`gallery-data/${site}.json`,itemId:item.id,manifestText,manifestSha256,
        receipt:{schemaVersion:'1.0',operationId:`promotion_${attemptId.slice(8).replaceAll('-','')}`,
            targetRelativePath:`gallery-data/${site}.json`,itemId:item.id,manifestSha256}};
}

async function saveReview(env,attemptId,review) {
    const text=JSON.stringify({...review,replayed:false}),prior=await first(env,'SELECT review_json FROM private_gallery_pipeline_reviews WHERE attempt_id=?1',attemptId);
    if(prior) {if(prior.review_json!==text) throw new Error('Review changed');return;}
    try {await put(env,'INSERT INTO private_gallery_pipeline_reviews(attempt_id,review_json) VALUES(?1,?2)',attemptId,text);}
    catch {if((await first(env,'SELECT review_json FROM private_gallery_pipeline_reviews WHERE attempt_id=?1',attemptId))?.review_json!==text) throw new Error('Unavailable');}
}

export async function runArchivePhotoReview({env,identity,site,attemptId,catalog,github,publicFetch,timeoutMilliseconds}) {
    env={...env,DB:env.DB.withSession?.('first-primary')||env.DB};
    try {
        const attempt=await readArchivePhotoAttempt(env,identity,site,attemptId,catalog);
        const prior=await env.DB.prepare(`SELECT old.attempt_id FROM private_gallery_pipeline_admissions p
            JOIN private_gallery_attempts old ON old.attempt_id=p.attempt_id
            WHERE old.asset_id=?1 AND old.attempt_id!=?2 ORDER BY old.attempt_id LIMIT 1001`)
            .bind(attempt.asset_id,attemptId).all();
        if(prior?.success!==true || !Array.isArray(prior.results) || prior.results.length>1000) return pending();
        // A stored receipt is historical evidence, not a current GitHub read.
        // Reconcile every previous generation before admitting this one. Reuse
        // still-current host proof and completed cleanup; never replay the source.
        for(const old of prior.results) if(!(await resumeArchivePhotoRemoval({env,identity,site,
            attemptId:old.attempt_id,github,publicFetch,timeoutMilliseconds})).completed) return pending();
        if(!(await admitArchivePhotoProcessing(env,identity,site,attemptId,catalog)).ok) return pending();
        const existing=await first(env,'SELECT * FROM private_gallery_pipeline_review_intents WHERE attempt_id=?1',attemptId);
        let candidate,baseSha;
        if(existing) {candidate=JSON.parse(existing.candidate_json);baseSha=existing.base_sha;}
        else {
            const source=await readArchivePhotoSource(env,identity,site,attemptId,catalog);
            // These binding IDs satisfy the existing decoder's technical input
            // grammar only. No legacy draft, upload or purge relationship exists.
            const processed=await processGalleryPhoto({sourceBytes:Buffer.from(source.bytes),fileExtension:source.fileExtension,
                declaredMimeType:source.declaredMimeType,expectedSha256:source.expectedSha256,
                draftBinding:{site,draftId:`draft_${attemptId.slice(8)}`,processingRunId:`run_${attemptId.slice(8).replaceAll('-','')}`}});
            assertPhotoFramingSource(source.framingSource,processed.source);
            for(const tier of ['staging','approved']) for(const derivative of processed.derivatives)
                await storeArchivePhotoDerivative(env,identity,site,attemptId,catalog,tier,derivative,processed.toolchain);
            const main=await readGalleryReviewMain(githubOptions(github));
            candidate=await candidateFor(env,identity,site,attemptId,catalog,main);baseSha=main.baseSha;
            try {await put(env,`INSERT INTO private_gallery_pipeline_review_intents(attempt_id,base_sha,candidate_json)
                VALUES(?1,?2,?3)`,attemptId,baseSha,JSON.stringify(candidate));}
            catch {const stored=await first(env,'SELECT * FROM private_gallery_pipeline_review_intents WHERE attempt_id=?1',attemptId);
                if(stored?.base_sha!==baseSha || stored.candidate_json!==JSON.stringify(candidate)) throw new Error('Changed');}
        }
        // Re-read BOTH independent stored objects and all mutable permissions
        // immediately before the narrow GitHub client and after it returns.
        const fresh=await readArchivePhotoCandidateItem(env,identity,site,attemptId,catalog);
        if(JSON.stringify(JSON.parse(candidate.manifestText).items.find(i=>i.id===candidate.itemId))!==JSON.stringify(fresh)) throw new Error('Candidate changed');
        const receipt=await first(env,'SELECT review_json FROM private_gallery_pipeline_reviews WHERE attempt_id=?1',attemptId);
        const review=receipt?await readExistingGalleryReview(candidate,{expectedBaseSha:baseSha,...githubOptions(github)}):
            await createOrReconcileArchiveGalleryReview(candidate,{expectedBaseSha:baseSha,...githubOptions(github),admitPullRequest:async()=>{
                await readArchivePhotoCandidateItem(env,identity,site,attemptId,catalog);
                await put(env,"INSERT INTO private_gallery_review_write_admissions(attempt_id,kind,base_sha) VALUES(?1,'addition',?2)",attemptId,baseSha);
            }});
        if(receipt && JSON.stringify({...review,replayed:false})!==receipt.review_json) throw new Error('Review changed');
        if(!receipt) await saveReview(env,attemptId,review);
        await readArchivePhotoCandidateItem(env,identity,site,attemptId,catalog);
        return {ok:true,status:200,state:'unmerged-review',attemptId,review};
    } catch {
        try {await closeArchivePhotoAttempt(env,identity,site,attemptId,'failed');
            // Public byte cleanup must not depend on GitHub availability.
            await removeArchivePhotoCopies(env,identity,site,attemptId);
            await closeReview(env,attemptId,github);
        } catch { /* Durable pending evidence is resumed, never fabricated. */ }
        return pending();
    }
}

// Allow is a separate preference, never permission to publish. Restoration
// accepts fresh explicit consent, reserves a new attempt, and stops at review.
// Admission still refuses until every previous generation's removal is proven.
export async function restoreArchivePhotoReview({env,identity,site,assetId,consent,catalog,github,publicFetch,timeoutMilliseconds}) {
    try {
        const reservation=await reservePrivateGalleryAttempt(env,identity,site,assetId,consent,catalog);
        if(!reservation.ok) return pending();
        return await runArchivePhotoReview({env,identity,site,attemptId:reservation.attemptId,catalog,github,publicFetch,timeoutMilliseconds});
    } catch {return pending();}
}

async function closeReview(env,attemptId,github) {
    if(await first(env,'SELECT 1 FROM private_gallery_pipeline_review_closures WHERE attempt_id=?1',attemptId)) return;
    if(await first(env,"SELECT 1 FROM private_gallery_review_terminals WHERE attempt_id=?1 AND kind='addition'",attemptId)) return;
    const intent=await first(env,'SELECT * FROM private_gallery_pipeline_review_intents WHERE attempt_id=?1',attemptId);
    if(!intent) return;
    const candidate=JSON.parse(intent.candidate_json);
    let stored=await first(env,'SELECT review_json FROM private_gallery_pipeline_reviews WHERE attempt_id=?1',attemptId);
    if(!stored) {
        const evidence=await reconcileArchiveGalleryReview(candidate,{expectedBaseSha:intent.base_sha,...githubOptions(github),kind:'addition'});
        await saveTerminal(env,attemptId,'addition',intent.base_sha,evidence);return;
    }
    let evidence;
    try {evidence=await invalidateGalleryReview(candidate,JSON.parse(stored.review_json),{expectedBaseSha:intent.base_sha,...githubOptions(github)});}
    catch {evidence=await readMergedGalleryReview(candidate,JSON.parse(stored.review_json),{expectedBaseSha:intent.base_sha,...githubOptions(github)});}
    try {await put(env,'INSERT INTO private_gallery_pipeline_review_closures(attempt_id,evidence_json) VALUES(?1,?2)',attemptId,JSON.stringify(evidence));}
    catch {if(!await first(env,'SELECT 1 FROM private_gallery_pipeline_review_closures WHERE attempt_id=?1',attemptId)) throw new Error('Unavailable');}
}
async function saveTerminal(env,attemptId,kind,baseSha,evidence) {
    const prior=()=>first(env,'SELECT evidence_json FROM private_gallery_review_terminals WHERE attempt_id=?1 AND kind=?2 AND base_sha=?3',attemptId,kind,baseSha);
    const text=JSON.stringify(evidence);if(await prior()) return;
    try {await put(env,'INSERT INTO private_gallery_review_terminals(attempt_id,kind,base_sha,evidence_json) VALUES(?1,?2,?3,?4)',attemptId,kind,baseSha,text);}
    catch {if((await prior())?.evidence_json!==text) throw new Error('Unavailable');}
}

export async function resumeArchivePhotoRemoval({env,identity,site,attemptId,github,publicFetch,timeoutMilliseconds}) {
    env={...env,DB:env.DB.withSession?.('first-primary')||env.DB};
    try {
        const attempt=await readArchivePhotoAttempt(env,identity,site,attemptId,null,{allowClosed:true});
        if(!(await removeArchivePhotoCopies(env,identity,site,attemptId)).ok) return pending();
        const host=await verifyArchivePhotoPublicAbsence(env,identity,site,attemptId,publicFetch,timeoutMilliseconds);
        if(!host.ok) return host;
        // Host cleanup/proof precedes GitHub; outages leave only manifest/review
        // reconciliation pending while private bytes and tags remain retained.
        await closeReview(env,attemptId,github);
        const main=await readGalleryReviewMain(githubOptions(github));
        const own=main.manifestsBySite[site],other=main.manifestsBySite[site==='family'?'everyone':'family'];
        const historical=await env.DB.prepare(`SELECT object_key FROM private_gallery_pipeline_outputs
            WHERE attempt_id=?1 AND tier='approved' ORDER BY role`).bind(attemptId).all();
        if(historical?.success!==true || !Array.isArray(historical.results)) throw new Error('Unavailable');
        const urls=historical.results.map(r=>`${env.APPROVED_MEDIA_ORIGIN}/${r.object_key}`);
        const usesTarget=item=>item.id===attempt.public_item_id || urls.includes(item.sourceUrl) || urls.includes(item.thumbnailUrl);
        if(other.items.some(usesTarget)) throw new Error('Cross-area/collateral manifest use');
        if(own.items.some(usesTarget)) {
            // No automatic merge/publication. Exact one-file removal proposal
            // carries only already-public metadata, never private names/reasons.
            return {ok:false,status:409,state:'manifest-removal-required',hostDeletionConfirmed:true,
                proposal:{baseSha:main.baseSha,targetRelativePath:`gallery-data/${site}.json`,
                    manifestText:canonical({schemaVersion:'1.0',items:own.items.filter(i=>!usesTarget(i))})}};
        }
        const removals=await env.DB.prepare(`SELECT i.base_sha,i.removal_json FROM private_gallery_manifest_removal_intents i
            WHERE i.attempt_id=?1 AND NOT EXISTS(SELECT 1 FROM private_gallery_review_terminals t
             WHERE t.attempt_id=i.attempt_id AND t.kind='removal' AND t.base_sha=i.base_sha) LIMIT 1001`).bind(attemptId).all();
        if(removals?.success!==true || !Array.isArray(removals.results) || removals.results.length>1000) throw new Error('Unavailable');
        for(const row of removals.results) await saveTerminal(env,attemptId,'removal',row.base_sha,
            await reconcileArchiveGalleryReview(JSON.parse(row.removal_json),{expectedBaseSha:row.base_sha,...githubOptions(github),kind:'removal'}));
        const manifestHash=await hash(canonical(own));
        if(!await first(env,`SELECT 1 FROM private_gallery_pipeline_manifest_receipts WHERE attempt_id=?1 AND main_sha=?2`,attemptId,main.baseSha)) {
            try {await put(env,`INSERT INTO private_gallery_pipeline_manifest_receipts(attempt_id,main_sha,manifest_sha256)
                VALUES(?1,?2,?3)`,attemptId,main.baseSha,manifestHash);}
            catch {if(!await first(env,`SELECT 1 FROM private_gallery_pipeline_manifest_receipts WHERE attempt_id=?1 AND main_sha=?2
                AND manifest_sha256=?3`,attemptId,main.baseSha,manifestHash)) throw new Error('Unavailable');}
        }
        // A main movement during the durable receipt write remains pending;
        // the next resume rereads it rather than calling an old receipt current.
        const finalMain=await readGalleryReviewMain(githubOptions(github));
        if(finalMain.baseSha!==main.baseSha || canonical(finalMain.manifestsBySite[site])!==canonical(own)) return pending();
        return {...await readArchivePhotoRemovalState(env,identity,site,attemptId),hostDeletionConfirmed:true};
    } catch {return pending();}
}

export async function hideArchivePhotoPerson({env,identity,site,personId,input,github,publicFetch,timeoutMilliseconds}) {
    const changed=await changePrivateGalleryVisibility(env,identity,site,personId,input);
    if(!changed.ok || input.preference!=='hidden') return pending();
    // Includes historical complete tag sets, not just the newest revision; a
    // corrected or group photo must not disappear from removal reconciliation.
    const affected=await env.DB.prepare(`SELECT DISTINCT a.attempt_id,a.site_mode FROM private_gallery_attempts a
        JOIN json_each(a.person_ids_json) j ON j.value=?1 JOIN private_gallery_pipeline_closures c ON c.attempt_id=a.attempt_id
        ORDER BY a.attempt_id LIMIT 1001`).bind(personId).all();
    if(affected?.success!==true || !Array.isArray(affected.results) || affected.results.length>1000) return pending();
    const outcomes=[];
    for(const row of affected.results) outcomes.push(await resumeArchivePhotoRemoval({env,identity,site:row.site_mode,
        attemptId:row.attempt_id,github,publicFetch,timeoutMilliseconds}));
    return {ok:outcomes.every(result=>result.completed===true),status:outcomes.every(result=>result.completed===true)?200:409,
        state:outcomes.every(result=>result.completed===true)?'hidden':'removal-pending',outcomes};
}

// Explicit review step, separate from Hide's privacy-first cleanup and separate
// from the addition client. Never marks an open removal PR as removal complete.
export async function requestArchivePhotoManifestRemoval(options) {
    const {env,identity,site,attemptId,github}=options;
    try {
        const state=await resumeArchivePhotoRemoval(options);
        if(state.completed) return state;
        if(state.state!=='manifest-removal-required' || state.hostDeletionConfirmed!==true) return pending();
        const attempt=await readArchivePhotoAttempt(env,identity,site,attemptId,null,{allowClosed:true});
        const addition=await first(env,'SELECT candidate_json FROM private_gallery_pipeline_review_intents WHERE attempt_id=?1',attemptId);
        if(!addition) return pending();
        const item=JSON.parse(JSON.parse(addition.candidate_json).manifestText).items.find(value=>value.id===attempt.public_item_id);
        if(!item) return pending();
        const {baseSha,targetRelativePath,manifestText}=state.proposal;
        const prior=()=>first(env,'SELECT * FROM private_gallery_manifest_removal_intents WHERE attempt_id=?1 AND base_sha=?2',attemptId,baseSha);
        let intent=await prior();
        const removal={operationId:intent?.operation_id || `removal_${crypto.randomUUID()}`,targetRelativePath,item,
            manifestText,manifestSha256:`sha256:${await hash(manifestText)}`};
        const json=JSON.stringify(removal);
        if(intent && intent.removal_json!==json) return pending();
        if(!intent) {
            try {await put(env,`INSERT INTO private_gallery_manifest_removal_intents(attempt_id,base_sha,operation_id,removal_json)
                VALUES(?1,?2,?3,?4)`,attemptId,baseSha,removal.operationId,json);}
            catch {intent=await prior();if(!intent) return pending();}
            intent=await prior();
            // Another concurrent identical request may have won its UUID.
            const saved=JSON.parse(intent.removal_json);
            if(JSON.stringify({...saved,operationId:removal.operationId})!==json) return pending();
        }
        const review=await createOrReconcileArchiveGalleryRemoval(JSON.parse(intent.removal_json),{expectedBaseSha:baseSha,...githubOptions(github),
            admitPullRequest:()=>put(env,"INSERT INTO private_gallery_review_write_admissions(attempt_id,kind,base_sha) VALUES(?1,'removal',?2)",attemptId,baseSha)});
        const text=JSON.stringify({...review,replayed:false});
        const stored=()=>first(env,'SELECT review_json FROM private_gallery_manifest_removal_reviews WHERE attempt_id=?1 AND base_sha=?2',attemptId,baseSha);
        if(!(await stored())) {
            try {await put(env,`INSERT INTO private_gallery_manifest_removal_reviews(attempt_id,base_sha,review_json) VALUES(?1,?2,?3)`,attemptId,baseSha,text);}
            catch {if((await stored())?.review_json!==text) return pending();}
        }
        if((await stored())?.review_json!==text) return pending();
        return {ok:true,status:200,state:'unmerged-removal-review',completed:false,hostDeletionConfirmed:true,review};
    } catch {return pending();}
}
