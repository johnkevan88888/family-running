import '../../gallery-contract.js';
import {sha256Hex} from './media-byte-verification.js';
import {issueArchiveServiceAuthority} from './private-gallery-service-authority.js';
import {readArchivePhotoCandidateItem} from './private-gallery-photo-lifecycle.js';
import {readArchiveBatchJob} from './private-gallery-batch-service.js';

// Promotion-only capabilities stay out of the owner/finalizer ledger bundle.
const run=/^https:\/\/github\.com\/johnkevan88888\/family-running\/actions\/runs\/[1-9][0-9]*$/;
const sha=/^[0-9a-f]{40}$/;
const digest=value=>sha256Hex(new TextEncoder().encode(value));
const keys=(input,expected)=>input && Object.keys(input).sort().join('|')===expected;
const canonical=value=>`${JSON.stringify(value,null,2)}\n`;
const first=(env,sql,...args)=>env.DB.prepare(sql).bind(...args).first();
async function all(env,sql,...args) {
    const result=await env.DB.prepare(sql).bind(...args).all();
    if(result?.success!==true || !Array.isArray(result.results)) throw new Error('Unavailable');return result.results;
}
async function write(env,sql,...args) {
    const result=await env.DB.prepare(sql).bind(...args).run();if(result?.success!==true) throw new Error('Unavailable');
}
function validMain(main) {
    return keys(main,'baseSha|manifestsBySite') && sha.test(main.baseSha||'') && keys(main.manifestsBySite,'everyone|family') &&
        ['family','everyone'].every(site=>globalThis.galleryContract.validateGalleryDocument(main.manifestsBySite[site]).length===0);
}
async function checkedItems(env,identity,row,catalog) {
    const memberRows=await all(env,'SELECT * FROM private_gallery_batch_members WHERE job_id=?1 ORDER BY ordinal',row.job_id);
    if(memberRows.length!==JSON.parse(row.attempts_json).length || memberRows.length<1 || memberRows.length>20) throw new Error('Unavailable');
    const items=[];
    for(const member of memberRows) {
        const scoped=await issueArchiveServiceAuthority(env,identity,row.site_mode,member.attempt_id,'promotion');
        items.push(await readArchivePhotoCandidateItem({...env,PRIVATE_DERIVATIVE_STAGING:env.DERIVATIVE_STAGING},scoped,row.site_mode,member.attempt_id,catalog));
    }
    return items;
}
const itemUses=(item,id,urls)=>item.id===id || ['sourceUrl','thumbnailUrl','posterUrl'].some(field=>urls.includes(item[field]));
function requireReview(review,row,candidate,branchRef,terminal=false) {
    const expected=terminal?'baseRef|baseSha|branchRef|headSha|itemIds|mainSha|manifestSha256|mergeSha|pullRequest|repository|schemaVersion|state|targetRelativePath':
        'baseRef|baseSha|branchRef|headSha|itemIds|manifestSha256|pullRequest|replayed|repository|schemaVersion|targetRelativePath';
    if(!keys(review,expected) || review.schemaVersion!=='1.0' || review.repository!=='johnkevan88888/family-running' || review.baseRef!=='main' ||
        review.baseSha!==row.base_sha || review.branchRef!==branchRef || review.targetRelativePath!==candidate.targetRelativePath ||
        review.manifestSha256!==candidate.manifestSha256 || JSON.stringify(review.itemIds)!==JSON.stringify(candidate.itemIds)) throw new Error('Unavailable');
    if(!terminal && (typeof review.replayed!=='boolean' || !sha.test(review.headSha||''))) throw new Error('Unavailable');
    if(terminal && !['no-pr-created','closed-unmerged','merged-by-owner'].includes(review.state)) throw new Error('Unavailable');
    if(terminal && review.state==='no-pr-created') {
        if(review.pullRequest!==null || review.mergeSha!==null || review.mainSha!==null || !(review.headSha===null || sha.test(review.headSha||''))) throw new Error('Unavailable');
        return;
    }
    if(!sha.test(review.headSha||'') || !keys(review.pullRequest,'number|state|url') || !Number.isSafeInteger(review.pullRequest.number) || review.pullRequest.number<1 ||
        review.pullRequest.url!==`https://github.com/johnkevan88888/family-running/pull/${review.pullRequest.number}` ||
        review.pullRequest.state!==(terminal?'closed':'open')) throw new Error('Unavailable');
    if(terminal && (review.state==='merged-by-owner'? !sha.test(review.mergeSha||'') || !sha.test(review.mainSha||''):review.mergeSha!==null || review.mainSha!==null)) throw new Error('Unavailable');
}
// Called only after the exact promotion Access/epoch/run gate. Caller-supplied
// items, area, owners, keys and URLs are never accepted; each item is derived
// through the unchanged per-photo consent/catalog/byte/framing checks.
export async function archiveBatchOperation(env,identity,row,catalog,operation,input) {
    if(row.action!=='batch-review' || row.run_reference!==input.runReference || row.result_json || !run.test(input.runReference||'')) throw new Error('Unavailable');
    if(operation==='batch-reserve') {
        if(!validMain(input.main)) throw new Error('Unavailable');
        const items=await checkedItems(env,identity,row,catalog),main=input.main;
        const historical=await all(env,`SELECT a.attempt_id,a.public_item_id FROM private_gallery_batch_members m
            JOIN private_gallery_attempts a ON a.asset_id=m.asset_id AND a.attempt_id!=m.attempt_id
            JOIN private_gallery_pipeline_admissions p ON p.attempt_id=a.attempt_id WHERE m.job_id=?1`,row.job_id);
        for(const old of historical) {
            if(!await first(env,'SELECT 1 FROM private_gallery_pipeline_current_removal WHERE attempt_id=?1',old.attempt_id)) throw new Error('Pending history');
            const outputs=await all(env,"SELECT object_key FROM private_gallery_pipeline_outputs WHERE attempt_id=?1 AND tier='approved'",old.attempt_id);
            const urls=outputs.map(o=>`${env.APPROVED_MEDIA_ORIGIN}/${o.object_key}`);
            if(['family','everyone'].some(site=>main.manifestsBySite[site].items.some(item=>itemUses(item,old.public_item_id,urls)))) throw new Error('Pending history');
        }
        const usedIds=new Set(),usedUrls=new Set();
        for(const item of items) {
            const urls=[item.sourceUrl,item.thumbnailUrl];
            if(usedIds.has(item.id) || urls.some(url=>usedUrls.has(url)) || ['family','everyone'].some(site=>
                main.manifestsBySite[site].items.some(old=>itemUses(old,item.id,urls)))) throw new Error('Reused public identity');
            usedIds.add(item.id);urls.forEach(url=>usedUrls.add(url));
        }
        const targetRelativePath=`gallery-data/${row.site_mode}.json`,itemIds=items.map(i=>i.id);
        const manifestText=canonical({schemaVersion:'1.0',items:[...main.manifestsBySite[row.site_mode].items,...items]});
        if(new TextEncoder().encode(manifestText).length>1048576) throw new Error('Unavailable');
        const manifestSha256=`sha256:${await digest(manifestText)}`;
        const candidate={changed:true,targetRelativePath,itemIds,manifestText,manifestSha256,receipt:{schemaVersion:'1.0',
            operationId:`promotion_batch_${row.job_id.slice(4).replaceAll('-','')}`,targetRelativePath,itemIds,manifestSha256}};
        const text=JSON.stringify(candidate);
        if(!row.candidate_json) {
            try {await write(env,'INSERT INTO private_gallery_batch_intents(job_id,base_sha,candidate_json) VALUES(?1,?2,?3)',row.job_id,main.baseSha,text);}
            catch {if(!(await readArchiveBatchJob(env,row.job_id))?.candidate_json) throw new Error('Unavailable');}
        }
        const saved=await readArchiveBatchJob(env,row.job_id);
        if(saved.base_sha!==main.baseSha || saved.candidate_json!==text) throw new Error('Changed replay');
        return {baseSha:main.baseSha,candidate};
    }
    if(!row.candidate_json) throw new Error('Unavailable');
    const candidate=JSON.parse(row.candidate_json);
    const branchRef=`gallery-media/candidate-${(await digest(`family-running-gallery-review-branch-v1\0${candidate.receipt.operationId}`)).slice(0,32)}`;
    if(operation==='batch-write' || operation==='batch-open' || operation==='batch-publication-check') {
        const items=await checkedItems(env,identity,row,catalog);
        const savedItems=JSON.parse(candidate.manifestText).items.slice(-items.length);
        if(JSON.stringify(items)!==JSON.stringify(savedItems)) throw new Error('Changed photo');
    }
    if(operation==='batch-publication-check') {
        if(!row.publication_request_json || row.evidence_json || !row.review_json || row.publication_request_json!==row.review_json)
            throw new Error('Unavailable');
        return {state:'ready-for-owner-merge',claimHeld:true,publicationEnabled:false};
    }
    if(operation==='batch-publication-observe') {
        if(!row.publication_request_json || row.evidence_json || !row.review_json || row.publication_request_json!==row.review_json)
            throw new Error('Unavailable');
        requireReview(input.evidence,row,candidate,branchRef,true);
        if(input.evidence.state!=='merged-by-owner') throw new Error('Unavailable');
        const recorded=JSON.parse(row.review_json);
        if(recorded.headSha!==input.evidence.headSha || recorded.pullRequest.number!==input.evidence.pullRequest.number ||
            recorded.pullRequest.url!==input.evidence.pullRequest.url) throw new Error('Unavailable');
        const text=JSON.stringify(input.evidence);
        // Positive merge history is needed for cleanup even when permission
        // changed during GitHub I/O. The separate completion boundary must
        // still pass every actual-byte/catalogue/consent/framing recheck.
        if(!row.publication_evidence_json) {
            try {await write(env,'INSERT INTO private_gallery_batch_publications(job_id,evidence_json) VALUES(?1,?2)',row.job_id,text);}
            catch {if(!(await readArchiveBatchJob(env,row.job_id))?.publication_evidence_json) throw new Error('Unavailable');}
        }
        if((await readArchiveBatchJob(env,row.job_id)).publication_evidence_json!==text) throw new Error('Changed replay');
        return {state:'publication-origin-recorded',publicationEnabled:false};
    }
    if(operation==='batch-write') {
        await write(env,'INSERT INTO private_gallery_batch_write_admissions(job_id) VALUES(?1)',row.job_id);
        return {state:'single-pr-post-admitted'};
    }
    if(operation==='batch-open') {
        requireReview(input.review,row,candidate,branchRef);
        const text=JSON.stringify({...input.review,replayed:false});
        if(!row.review_json) {
            try {await write(env,'INSERT INTO private_gallery_batch_reviews(job_id,review_json) VALUES(?1,?2)',row.job_id,text);}
            catch {if(!(await readArchiveBatchJob(env,row.job_id))?.review_json) throw new Error('Unavailable');}
        }
        if((await readArchiveBatchJob(env,row.job_id)).review_json!==text) throw new Error('Changed replay');
        return {state:'unmerged-review',publicationEnabled:false};
    }
    if(operation==='batch-terminal') {
        requireReview(input.evidence,row,candidate,branchRef,true);
        const text=JSON.stringify(input.evidence);
        if(!row.evidence_json) {
            try {await write(env,'INSERT INTO private_gallery_batch_terminals(job_id,evidence_json) VALUES(?1,?2)',row.job_id,text);}
            catch {if(!(await readArchiveBatchJob(env,row.job_id))?.evidence_json) throw new Error('Unavailable');}
        }
        if((await readArchiveBatchJob(env,row.job_id)).evidence_json!==text) throw new Error('Changed replay');
        return {state:'review-terminal-recorded'};
    }
    throw new Error('Unavailable');
}
