import {handleScopedArchiveRequest,safeArchiveResult} from './private-gallery-service-request.js';
import {adminFailure,adminJson} from './responses.js';
import {readArchivePhotoAttempt,storeArchivePhotoDerivative,readArchivePhotoCandidateItem,closeArchivePhotoAttempt,removeArchivePhotoCopies} from './private-gallery-photo-lifecycle.js';
import {readBoundedBytes,sha256Hex} from './media-byte-verification.js';
import {isArchiveJobPath,handleArchiveJobRequest} from './private-gallery-job-request.js';
import {archiveBatchOperation} from './private-gallery-batch-promotion.js';
import {readArchiveBatchMemberOrigin} from './private-gallery-batch-service.js';
const config=Object.freeze({purpose:'promotion',identity:'PROMOTER_IDENTITIES',origin:'PROMOTION_ORIGIN',
    buckets:['APPROVED_MEDIA','DERIVATIVE_STAGING'],operations:['promote','candidate','review','review-reserve','review-open','review-close','review-write','review-terminal','removal-reserve','removal-open','manifest-absence','close','cleanup']});
export function handleArchivePromotionRequest(request,env,catalog,dependencies={}) {
    if(isArchiveJobPath(request)) return handleArchiveJobRequest(request,env,config,dependencies,undefined,catalog,archiveBatchOperation);
    return handleScopedArchiveRequest(request,env,config,catalog,dependencies,dispatch);
}
async function dispatch({env,scope,site,attemptId,catalog,operation,input}) {
    env={...env,PRIVATE_DERIVATIVE_STAGING:env.DERIVATIVE_STAGING};
    if(['review','review-reserve','review-open','review-close','review-write','review-terminal','removal-reserve','removal-open','manifest-absence'].includes(operation))
        return archiveReviewOperation(env,scope,site,attemptId,catalog,operation,input);
    if(operation==='close') {await closeArchivePhotoAttempt(env,scope,site,attemptId,'cancelled');return adminJson(200,{state:'closed'});}
    if(operation==='cleanup') return safeArchiveResult(await removeArchivePhotoCopies(env,scope,site,attemptId));
        if(operation==='promote') {
            await readArchivePhotoAttempt(env,scope,site,attemptId,catalog);
            const rows=await env.DB.prepare(`SELECT o.*,b.provider_etag FROM private_gallery_pipeline_outputs o
                JOIN private_gallery_pipeline_byte_receipts b USING(attempt_id,tier,role)
                WHERE o.attempt_id=?1 AND o.tier='staging' ORDER BY o.role`).bind(attemptId).all();
            if(rows?.success!==true || rows.results?.length!==2) return adminFailure(409);
            for(const output of rows.results) {
                const stored=await env.DERIVATIVE_STAGING.get(output.object_key,{onlyIf:{etagMatches:output.provider_etag}});
                if(!stored?.body) return adminFailure(409);
                const bytes=await readBoundedBytes(stored.body,output.byte_count);
                await storeArchivePhotoDerivative(env,scope,site,attemptId,catalog,'approved',{
                    storageRole:output.role,width:output.width,height:output.height,byteLength:output.byte_count,
                    sha256:output.sha256,payload:new Blob([bytes])},JSON.parse(output.scan_json));
            }
        }
        const item=await readArchivePhotoCandidateItem(env,scope,site,attemptId,catalog);
        return adminJson(200,{site,item,publicationEnabled:false});
}
const canonical=value=>`${JSON.stringify(value,null,2)}\n`;
const hash=text=>sha256Hex(new TextEncoder().encode(text));
async function write(env,sql,...args) {
    const result=await env.DB.prepare(sql).bind(...args).run();if(result?.success!==true) throw new Error('Unavailable');
}
function validMain(input) {
    return input && Object.keys(input).sort().join('|')==='baseSha|manifestsBySite' && /^[0-9a-f]{40}$/.test(input.baseSha||'') &&
        Object.keys(input.manifestsBySite||{}).sort().join('|')==='everyone|family' &&
        ['family','everyone'].every(site=>globalThis.galleryContract.validateGalleryDocument(input.manifestsBySite[site]).length===0);
}
async function archiveReviewOperation(env,scope,site,attemptId,catalog,operation,input) {
    const attempt=await readArchivePhotoAttempt(env,scope,site,attemptId,null,{allowClosed:true});
    const intent=()=>env.DB.prepare('SELECT * FROM private_gallery_pipeline_review_intents WHERE attempt_id=?1').bind(attemptId).first();
    const opened=()=>env.DB.prepare('SELECT review_json FROM private_gallery_pipeline_reviews WHERE attempt_id=?1').bind(attemptId).first();
    if(operation==='review') {
        const saved=await intent(),review=await opened(),batchOrigin=await readArchiveBatchMemberOrigin(env,attemptId);
        const terminal=await env.DB.prepare(`SELECT 1 FROM private_gallery_pipeline_review_closures WHERE attempt_id=?1
            UNION ALL SELECT 1 FROM private_gallery_review_terminals WHERE attempt_id=?1 AND kind='addition'`).bind(attemptId).first();
        const removals=await env.DB.prepare(`SELECT i.base_sha,i.removal_json,r.review_json,t.evidence_json
            FROM private_gallery_manifest_removal_intents i LEFT JOIN private_gallery_manifest_removal_reviews r USING(attempt_id,base_sha)
            LEFT JOIN private_gallery_review_terminals t ON t.attempt_id=i.attempt_id AND t.base_sha=i.base_sha AND t.kind='removal'
            WHERE i.attempt_id=?1 ORDER BY i.created_at,i.base_sha LIMIT 1001`).bind(attemptId).all();
        if(removals?.success!==true || !Array.isArray(removals.results) || removals.results.length>1000) throw new Error('Unavailable');
        const prior=await env.DB.prepare(`SELECT old.attempt_id,old.public_item_id,old.generation_id,
            EXISTS(SELECT 1 FROM private_gallery_pipeline_current_removal r WHERE r.attempt_id=old.attempt_id) AS removed
            FROM private_gallery_attempts old JOIN private_gallery_pipeline_admissions a USING(attempt_id)
            WHERE old.asset_id=?1 AND old.attempt_id!=?2 ORDER BY old.attempt_id LIMIT 1001`).bind(attempt.asset_id,attemptId).all();
        if(prior?.success!==true || !Array.isArray(prior.results) || prior.results.length>1000) throw new Error('Unavailable');
        const historical=[];
        for(const row of prior.results) {
            const keys=await env.DB.prepare(`SELECT object_key FROM private_gallery_pipeline_outputs WHERE attempt_id=?1 AND tier='approved' ORDER BY role`)
                .bind(row.attempt_id).all();if(keys?.success!==true || !Array.isArray(keys.results) || keys.results.length>2) throw new Error('Unavailable');
            historical.push({attemptId:row.attempt_id,itemId:row.public_item_id,removed:row.removed===1,
                urls:keys.results.map(r=>`${env.APPROVED_MEDIA_ORIGIN}/${r.object_key}`)});
        }
        const host=await env.DB.prepare(`SELECT 1 FROM private_gallery_pipeline_host_receipts h JOIN gallery_media_delivery_current_epoch e
            ON e.epoch_id_hash=h.epoch_id_hash WHERE h.attempt_id=?1`).bind(attemptId).first();
        return adminJson(200,{site,state:saved?'prepared':'not-prepared',historical,reviewTerminal:Boolean(terminal),hostDeletionConfirmed:Boolean(host),
            removals:removals.results.map(row=>({baseSha:row.base_sha,removal:JSON.parse(row.removal_json),terminal:Boolean(row.evidence_json)})),
            ...(saved?{baseSha:saved.base_sha,candidate:JSON.parse(saved.candidate_json)}:{}),
            ...(review?{review:JSON.parse(review.review_json)}:{}),...(batchOrigin?{batchOrigin}:{})});
    }
    if(operation==='review-write' || operation==='review-terminal') {
        const fields=operation==='review-write'?'baseSha|kind':'baseSha|evidence|kind';
        if(!input || Object.keys(input).sort().join('|')!==fields || !['addition','removal'].includes(input.kind) ||
            !/^[0-9a-f]{40}$/.test(input.baseSha||'')) return adminFailure(422);
        const row=await env.DB.prepare(`SELECT * FROM private_gallery_review_requests WHERE attempt_id=?1 AND kind=?2 AND base_sha=?3`)
            .bind(attemptId,input.kind,input.baseSha).first();
        if(!row) return adminFailure(409);
        if(operation==='review-write') {
            if(input.kind==='addition') await readArchivePhotoCandidateItem(env,scope,site,attemptId,catalog);
            // Never treat a repeated admission as permission to repeat a POST.
            await write(env,`INSERT INTO private_gallery_review_write_admissions(attempt_id,kind,base_sha) VALUES(?1,?2,?3)`,attemptId,input.kind,input.baseSha);
            return adminJson(200,{state:'single-pr-post-admitted'});
        }
        const request=input.kind==='addition'?JSON.parse((await intent()).candidate_json):JSON.parse((await env.DB.prepare(
            'SELECT removal_json FROM private_gallery_manifest_removal_intents WHERE attempt_id=?1 AND base_sha=?2').bind(attemptId,input.baseSha).first()).removal_json);
        const operationId=input.kind==='addition'?request.receipt.operationId:request.operationId;
        const evidence=input.evidence;
        if(Object.keys(evidence||{}).sort().join('|')!=='baseRef|baseSha|branchRef|headSha|itemId|mainSha|manifestSha256|mergeSha|pullRequest|repository|schemaVersion|state|targetRelativePath' ||
            evidence.schemaVersion!=='1.0' || evidence.repository!=='johnkevan88888/family-running' || evidence.baseRef!=='main' ||
            evidence.baseSha!==row.base_sha || evidence.targetRelativePath!==row.path || evidence.itemId!==row.item_id || evidence.manifestSha256!==row.manifest_hash ||
            evidence.branchRef!==`gallery-media/candidate-${(await hash(`family-running-gallery-review-branch-v1\0${operationId}`)).slice(0,32)}` ||
            !(evidence.headSha===null || /^[0-9a-f]{40}$/.test(evidence.headSha||''))) return adminFailure(422);
        if(evidence.state==='no-pr-created') {
            if(evidence.pullRequest!==null || evidence.mergeSha!==null || evidence.mainSha!==null) return adminFailure(422);
        } else {
            const pr=evidence.pullRequest;
            if(!['closed-unmerged','merged-by-owner'].includes(evidence.state) || !/^[0-9a-f]{40}$/.test(evidence.headSha||'') ||
                Object.keys(pr||{}).sort().join('|')!=='number|state|url' || pr.state!=='closed' || !Number.isSafeInteger(pr.number) || pr.number<1 ||
                pr.url!==`https://github.com/johnkevan88888/family-running/pull/${pr.number}` ||
                (evidence.state==='closed-unmerged' ? evidence.mergeSha!==null || evidence.mainSha!==null :
                    !/^[0-9a-f]{40}$/.test(evidence.mergeSha||'') || !/^[0-9a-f]{40}$/.test(evidence.mainSha||''))) return adminFailure(422);
            const recorded=input.kind==='addition'?await opened():await env.DB.prepare(
                'SELECT review_json FROM private_gallery_manifest_removal_reviews WHERE attempt_id=?1 AND base_sha=?2').bind(attemptId,input.baseSha).first();
            if(recorded) {
                const prior=JSON.parse(recorded.review_json);
                if(pr.number!==prior.pullRequest.number || pr.url!==prior.pullRequest.url || evidence.headSha!==prior.headSha) return adminFailure(409);
            }
        }
        const text=JSON.stringify(evidence),prior=()=>env.DB.prepare(`SELECT evidence_json FROM private_gallery_review_terminals WHERE attempt_id=?1 AND kind=?2 AND base_sha=?3`)
            .bind(attemptId,input.kind,input.baseSha).first();
        if(!await prior()) {
            try {await write(env,'INSERT INTO private_gallery_review_terminals(attempt_id,kind,base_sha,evidence_json) VALUES(?1,?2,?3,?4)',attemptId,input.kind,input.baseSha,text);}
            catch {if(!await prior()) throw new Error('Unavailable');}
        }
        return (await prior()).evidence_json===text?adminJson(200,{state:'review-terminal-recorded'}):adminFailure(409);
    }
    if(operation==='review-reserve') {
        if(!validMain(input)) return adminFailure(422);
        const item=await readArchivePhotoCandidateItem(env,scope,site,attemptId,catalog);
        if(['family','everyone'].some(area=>input.manifestsBySite[area].items.some(row=>row.id===item.id))) return adminFailure(409);
        const manifestText=canonical({schemaVersion:'1.0',items:[...input.manifestsBySite[site].items,item]}),manifestSha256=`sha256:${await hash(manifestText)}`;
        const candidate={changed:true,targetRelativePath:`gallery-data/${site}.json`,itemId:item.id,manifestText,manifestSha256,
            receipt:{schemaVersion:'1.0',operationId:`promotion_${attemptId.slice(8).replaceAll('-','')}`,targetRelativePath:`gallery-data/${site}.json`,itemId:item.id,manifestSha256}};
        const before=await intent();
        if(!before) {
            try {await write(env,'INSERT INTO private_gallery_pipeline_review_intents(attempt_id,base_sha,candidate_json) VALUES(?1,?2,?3)',attemptId,input.baseSha,JSON.stringify(candidate));}
            catch {if(!await intent()) throw new Error('Unavailable');}
        }
        const saved=await intent();
        if(saved.base_sha!==input.baseSha || saved.candidate_json!==JSON.stringify(candidate)) return adminFailure(409);
        await readArchivePhotoCandidateItem(env,scope,site,attemptId,catalog);
        return adminJson(200,{baseSha:saved.base_sha,candidate});
    }
    if(operation==='manifest-absence') {
        if(!validMain(input)) return adminFailure(422);
        const keys=await env.DB.prepare(`SELECT object_key FROM private_gallery_pipeline_outputs WHERE attempt_id=?1 AND tier='approved' ORDER BY role`).bind(attemptId).all();
        if(keys?.success!==true || !Array.isArray(keys.results) || keys.results.length>2) throw new Error('Unavailable');
        const urls=keys.results.map(r=>`${env.APPROVED_MEDIA_ORIGIN}/${r.object_key}`);
        if(['family','everyone'].some(area=>input.manifestsBySite[area].items.some(row=>row.id===attempt.public_item_id ||
            ['sourceUrl','thumbnailUrl','posterUrl'].some(field=>urls.includes(row[field]))))) return adminFailure(409);
        const manifestHash=await hash(canonical(input.manifestsBySite[site]));
        const receipt=()=>env.DB.prepare(`SELECT 1 FROM private_gallery_pipeline_manifest_receipts
            WHERE attempt_id=?1 AND main_sha=?2 AND manifest_sha256=?3`).bind(attemptId,input.baseSha,manifestHash).first();
        if(!await receipt()) {
            try {await write(env,`INSERT INTO private_gallery_pipeline_manifest_receipts(attempt_id,main_sha,manifest_sha256) VALUES(?1,?2,?3)`,attemptId,input.baseSha,manifestHash);}
            catch {if(!await receipt()) throw new Error('Unavailable');}
        }
        return adminJson(200,{state:'manifest-absence-recorded',mainSha:input.baseSha});
    }
    const saved=await intent();
    if(operation==='removal-reserve') {
        if(!validMain(input)) return adminFailure(422);
        const batchOrigin=saved?null:await readArchiveBatchMemberOrigin(env,attemptId);
        // A shared addition is never represented as a fabricated one-photo
        // intent. Only its explicit durable member origin authorizes removal.
        if(!saved && (!batchOrigin?.evidence || !batchOrigin.item)) return adminFailure(409);
        const candidate=saved?JSON.parse(saved.candidate_json):batchOrigin.candidate;
        const item=saved?JSON.parse(candidate.manifestText).items.find(row=>row.id===candidate.itemId):batchOrigin.item;
        const urls=[item?.sourceUrl,item?.thumbnailUrl];
        const uses=row=>row.id===item?.id || ['sourceUrl','thumbnailUrl','posterUrl'].some(field=>urls.includes(row[field]));
        const own=input.manifestsBySite[site],other=input.manifestsBySite[site==='family'?'everyone':'family'];
        if(!item || own.items.filter(uses).length!==1 || other.items.some(uses) ||
            JSON.stringify(own.items.find(row=>row.id===item.id))!==JSON.stringify(item)) return adminFailure(409);
        const manifestText=canonical({schemaVersion:'1.0',items:own.items.filter(row=>row.id!==item.id)});
        const removal={operationId:`removal_${crypto.randomUUID()}`,targetRelativePath:candidate.targetRelativePath,item,manifestText,manifestSha256:`sha256:${await hash(manifestText)}`};
        const prior=()=>env.DB.prepare('SELECT removal_json FROM private_gallery_manifest_removal_intents WHERE attempt_id=?1 AND base_sha=?2').bind(attemptId,input.baseSha).first();
        if(!await prior()) {
            try {await write(env,`INSERT INTO private_gallery_manifest_removal_intents(attempt_id,base_sha,operation_id,removal_json) VALUES(?1,?2,?3,?4)`,
                attemptId,input.baseSha,removal.operationId,JSON.stringify(removal));}
            catch {if(!await prior()) throw new Error('Unavailable');}
        }
        const stored=JSON.parse((await prior()).removal_json);
        if(JSON.stringify({...stored,operationId:removal.operationId})!==JSON.stringify(removal)) return adminFailure(409);
        return adminJson(200,{baseSha:input.baseSha,removal:stored});
    }
    if(operation==='removal-open') {
        if(!input || Object.keys(input).sort().join('|')!=='baseSha|review') return adminFailure(422);
        const row=await env.DB.prepare('SELECT removal_json FROM private_gallery_manifest_removal_intents WHERE attempt_id=?1 AND base_sha=?2').bind(attemptId,input.baseSha).first();
        if(!row) return adminFailure(409);
        const removal=JSON.parse(row.removal_json);
        if(!await validReview(input.review,input.baseSha,{...removal,itemId:removal.item.id,receipt:{operationId:removal.operationId}})) return adminFailure(422);
        const text=JSON.stringify({...input.review,replayed:false}),prior=()=>env.DB.prepare('SELECT review_json FROM private_gallery_manifest_removal_reviews WHERE attempt_id=?1 AND base_sha=?2').bind(attemptId,input.baseSha).first();
        if(!await prior()) {
            try {await write(env,'INSERT INTO private_gallery_manifest_removal_reviews(attempt_id,base_sha,review_json) VALUES(?1,?2,?3)',attemptId,input.baseSha,text);}
            catch {if(!await prior()) throw new Error('Unavailable');}
        }
        return (await prior()).review_json===text?adminJson(200,{state:'unmerged-removal-review',publicationEnabled:false}):adminFailure(409);
    }
    if(!saved) return adminFailure(409);
    const candidate=JSON.parse(saved.candidate_json);
    if(operation==='review-open') {
        if(!input || Object.keys(input).join('|')!=='review') return adminFailure(422);
        const review=input.review;
        if(Object.keys(review||{}).sort().join('|')!=='baseRef|baseSha|branchRef|headSha|itemId|manifestSha256|pullRequest|replayed|repository|schemaVersion|targetRelativePath' ||
            review.schemaVersion!=='1.0' || review.repository!=='johnkevan88888/family-running' || review.baseRef!=='main' ||
            review.baseSha!==saved.base_sha || review.targetRelativePath!==candidate.targetRelativePath || review.itemId!==candidate.itemId ||
            review.manifestSha256!==candidate.manifestSha256 || review.branchRef!==`gallery-media/candidate-${(await hash(`family-running-gallery-review-branch-v1\0${candidate.receipt.operationId}`)).slice(0,32)}` ||
            !/^[0-9a-f]{40}$/.test(review.headSha||'') || typeof review.replayed!=='boolean' ||
            Object.keys(review.pullRequest||{}).sort().join('|')!=='number|state|url' || review.pullRequest.state!=='open' ||
            !Number.isSafeInteger(review.pullRequest.number) || review.pullRequest.number<1 ||
            review.pullRequest.url!==`https://github.com/johnkevan88888/family-running/pull/${review.pullRequest.number}`) return adminFailure(422);
        const text=JSON.stringify({...review,replayed:false});
        if(!await opened()) {
            try {await write(env,'INSERT INTO private_gallery_pipeline_reviews(attempt_id,review_json) VALUES(?1,?2)',attemptId,text);}
            catch {if(!await opened()) throw new Error('Unavailable');}
        }
        if((await opened()).review_json!==text) return adminFailure(409);
        return adminJson(200,{state:'review-recorded',publicationEnabled:false});
    }
    // Exact client terminal evidence is saved even after permission revocation.
    if(!input || Object.keys(input).join('|')!=='evidence' || !await opened()) return adminFailure(422);
    const evidence=input.evidence;
    const review=JSON.parse((await opened()).review_json);
    // The protected runner supplies only the narrow client's checked terminal
    // result. Bind that result to this exact stored review, never a caller ID.
    const closed=evidence && Object.keys(evidence).sort().join('|')==='branchRef|branchState|pullRequest|repository|schemaVersion' &&
        evidence.schemaVersion==='1.0' && evidence.repository===review.repository && evidence.branchRef===review.branchRef &&
        evidence.branchState==='retained-for-reviewed-cleanup' &&
        Object.keys(evidence.pullRequest||{}).sort().join('|')==='number|state|url' && evidence.pullRequest.state==='closed' &&
        evidence.pullRequest.number===review.pullRequest.number && evidence.pullRequest.url===review.pullRequest.url;
    const merged=evidence && Object.keys(evidence).sort().join('|')==='headSha|mainSha|mergeSha|pullRequestNumber|state' &&
        evidence.state==='merged-by-owner' && evidence.pullRequestNumber===review.pullRequest.number && evidence.headSha===review.headSha &&
        /^[0-9a-f]{40}$/.test(evidence.mainSha||'') && /^[0-9a-f]{40}$/.test(evidence.mergeSha||'');
    if(!closed && !merged) return adminFailure(422);
    const text=JSON.stringify(evidence),prior=()=>env.DB.prepare('SELECT evidence_json FROM private_gallery_pipeline_review_closures WHERE attempt_id=?1').bind(attemptId).first();
    if(!await prior()) {
        try {await write(env,'INSERT INTO private_gallery_pipeline_review_closures(attempt_id,evidence_json) VALUES(?1,?2)',attemptId,text);}
        catch {if(!await prior()) throw new Error('Unavailable');}
    }
    if((await prior()).evidence_json!==text) return adminFailure(409);
    return adminJson(200,{state:'review-terminal-recorded'});
}

async function validReview(review,baseSha,candidate) {
    return Object.keys(review||{}).sort().join('|')==='baseRef|baseSha|branchRef|headSha|itemId|manifestSha256|pullRequest|replayed|repository|schemaVersion|targetRelativePath' &&
        review.schemaVersion==='1.0' && review.repository==='johnkevan88888/family-running' && review.baseRef==='main' && review.baseSha===baseSha &&
        review.targetRelativePath===candidate.targetRelativePath && review.itemId===candidate.itemId && review.manifestSha256===candidate.manifestSha256 &&
        review.branchRef===`gallery-media/candidate-${(await hash(`family-running-gallery-review-branch-v1\0${candidate.receipt.operationId}`)).slice(0,32)}` &&
        /^[0-9a-f]{40}$/.test(review.headSha||'') && typeof review.replayed==='boolean' &&
        Object.keys(review.pullRequest||{}).sort().join('|')==='number|state|url' && review.pullRequest.state==='open' &&
        Number.isSafeInteger(review.pullRequest.number) && review.pullRequest.number>0 &&
        review.pullRequest.url===`https://github.com/johnkevan88888/family-running/pull/${review.pullRequest.number}`;
}
