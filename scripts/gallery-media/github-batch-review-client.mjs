import {createHash} from 'node:crypto';
import galleryContract from '../../gallery-contract.js';
import {parseV2PhotoDerivativeKey} from '../../gallery-admin/src/photo-generation-keys.js';

// An additive capability: the existing one-photo client and its exact +1 proof
// are intentionally unchanged. No ambient fetch/token, merge, ref update,
// deletion, workflow dispatch, settings, deployment or publication capability.
const repository='johnkevan88888/family-running';
const api=`https://api.github.com/repos/${repository}`;
const origin='https://family-running-gallery-media-dev.family-running.workers.dev';
const paths=['gallery-data/family.json','gallery-data/everyone.json'];
const sha=/^[0-9a-f]{40}$/;
const photo=/^photo-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const operation=/^promotion_batch_[0-9a-f]{32}$/;
const maximumBytes=1048576;
const canonical=value=>`${JSON.stringify(value,null,2)}\n`;
const hash=value=>createHash('sha256').update(value,'utf8').digest('hex');
const revision=value=>`sha256:${hash(value)}`;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const plain=value=>value!==null && typeof value==='object' && !Array.isArray(value) &&
    [Object.prototype,null].includes(Object.getPrototypeOf(value));
function keys(value,expected) {
    if(!plain(value) || Object.keys(value).sort().join('|')!==expected.split('|').sort().join('|'))
        throw new Error('Exact batch review envelope required.');
}
function freeze(value) {
    if(value && typeof value==='object') {for(const child of Object.values(value)) freeze(child);Object.freeze(value);}return value;
}
function document(text) {
    if(typeof text!=='string' || Buffer.byteLength(text)>maximumBytes) throw new Error('Bounded manifest required.');
    const value=JSON.parse(text);keys(value,'schemaVersion|items');
    if(canonical(value)!==text || galleryContract.validateGalleryDocument(value).length) throw new Error('Canonical public Gallery manifest required.');
    return value;
}
function derivative(text,role) {
    const url=new URL(text),key=parseV2PhotoDerivativeKey(url.pathname.slice(1));
    if(url.origin!==origin || url.username || url.password || url.search || url.hash ||
        text!==`${origin}/${url.pathname.slice(1)}` || url.href!==text || key?.role!==role)
        throw new Error('Exact approved generation URL required.');
    return key;
}
function candidate(value) {
    keys(value,'changed|targetRelativePath|itemIds|manifestText|manifestSha256|receipt');
    keys(value.receipt,'schemaVersion|operationId|targetRelativePath|itemIds|manifestSha256');
    const ids=value.itemIds;
    if(value.changed!==true || !paths.includes(value.targetRelativePath) || !Array.isArray(ids) ||
        ids.length<1 || ids.length>20 || new Set(ids).size!==ids.length || ids.some(id=>!photo.test(id||'')) ||
        typeof value.manifestText!=='string' || Buffer.byteLength(value.manifestText)>maximumBytes ||
        value.manifestSha256!==revision(value.manifestText) || value.receipt.schemaVersion!=='1.0' ||
        !operation.test(value.receipt.operationId||'') || value.receipt.targetRelativePath!==value.targetRelativePath ||
        !same(value.receipt.itemIds,ids) || value.receipt.manifestSha256!==value.manifestSha256)
        throw new Error('Exact bounded photo-batch candidate required.');
    const valueDocument=document(value.manifestText),items=valueDocument.items.slice(-ids.length);
    if(!same(items.map(item=>item.id),ids) || items.some(item=>item.type!=='photo' || !item.athleteIds.length))
        throw new Error('Batch must be an ordered appended photo suffix.');
    for(const item of items) {
        const display=derivative(item.sourceUrl,'photo-display'),thumbnail=derivative(item.thumbnailUrl,'photo-thumbnail');
        // Small photos can legitimately produce identical display/thumbnail
        // bytes. Roles still have distinct exact URLs and independent receipts.
        if(display.generationId!==thumbnail.generationId) throw new Error('Invalid derivative pair.');
    }
    return freeze(JSON.parse(JSON.stringify(value)));
}
function branch(value) {return `gallery-media/candidate-${hash(`family-running-gallery-review-branch-v1\0${value.receipt.operationId}`).slice(0,32)}`;}
const title=value=>`Add approved Gallery photo batch: ${value.itemIds.length} photos`;
const message=value=>`Add approved Gallery photo batch ${value.receipt.operationId}`;
function body(value) {
    return [`<!-- family-running-gallery-batch-candidate:${hash(`family-running-gallery-review-operation-v1\0${value.receipt.operationId}`)} -->`,
        '## Approved Gallery photo batch','',`- Manifest: \`${value.targetRelativePath}\``,
        ...value.itemIds.map(id=>`- Public item ID: \`${id}\``),`- Manifest SHA-256: \`${value.manifestSha256}\``,
        `- Candidate branch: \`${branch(value)}\``,'',
        'Each photo retains its own protected consent and safety evidence. This automated Pull Request is for review only. It does not authorize merge, deployment, or publication.'].join('\n');
}
function options(value,create=false) {
    keys(value,create?'expectedBaseSha|token|fetchImpl|admitPullRequest':'expectedBaseSha|token|fetchImpl');
    if(!sha.test(value.expectedBaseSha||'') || typeof value.token!=='string' || value.token.length<16 || value.token.length>1024 ||
        /[\s\u0000-\u001f\u007f]/.test(value.token) || typeof value.fetchImpl!=='function' || create && typeof value.admitPullRequest!=='function')
        throw new Error('Explicit protected batch review capabilities required.');
    return client(value);
}
function client({fetchImpl,token}) {
    return async (method,path,bodyValue,missing=false)=>{
        // Every route is constructed internally, never supplied by a caller.
        const get=/^\/git\/ref\/heads\/(?:main|gallery-media\/candidate-[0-9a-f]{32})$|^\/git\/commits\/[0-9a-f]{40}$|^\/compare\/[0-9a-f]{40}\.\.\.[0-9a-f]{40}$|^\/contents\/gallery-data\/(?:family|everyone|hidden-athlete-ids)\.json\?ref=[0-9a-f]{40}$|^\/pulls\/[1-9][0-9]*$|^\/pulls\?state=all&head=johnkevan88888%3Agallery-media%2Fcandidate-[0-9a-f]{32}&base=main&per_page=10$/;
        if(!(method==='GET' && bodyValue===undefined && get.test(path) ||
            method==='POST' && ['/git/blobs','/git/trees','/git/commits','/git/refs','/pulls'].includes(path) && plain(bodyValue) ||
            method==='PATCH' && /^\/pulls\/[1-9][0-9]*$/.test(path) && same(bodyValue,{state:'closed'})))
            throw new Error('Unsupported batch repository operation.');
        let response;
        try {response=await fetchImpl(api+path,{method,redirect:'error',headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${token}`,
            'Content-Type':'application/json','User-Agent':'family-running-gallery-review','X-GitHub-Api-Version':'2022-11-28'},
            body:bodyValue===undefined?undefined:JSON.stringify(bodyValue)});} catch {throw new Error(`GitHub batch ${method} response unavailable.`);}
        if(missing && response?.status===404) return null;
        if(!response?.ok) throw new Error(`GitHub batch ${method} failed.`);
        try {return await response.json();} catch {throw new Error('Invalid batch GitHub response.');}
    };
}
async function ref(github,name,required=true) {
    const value=await github('GET',`/git/ref/heads/${name}`,undefined,!required);
    if(value===null && !required) return null;
    if(!sha.test(value?.object?.sha||'')) throw new Error('Verified Git ref required.');return value.object.sha;
}
async function current(github,baseSha) {if(await ref(github,'main')!==baseSha) throw new Error('Batch base main changed.');}
async function text(github,path,at) {
    const value=await github('GET',`/contents/${path}?ref=${at}`);
    if(value?.type!=='file' || value.path!==path || value.encoding!=='base64' || typeof value.content!=='string') throw new Error('Verified repository file required.');
    const encoded=value.content.replace(/\s+/g,'');
    if(!encoded || encoded.length>Math.ceil(maximumBytes/3)*4+4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('Bounded canonical encoding required.');
    const bytes=Buffer.from(encoded,'base64');
    if(bytes.length>maximumBytes || bytes.toString('base64')!==encoded) throw new Error('Invalid repository bytes.');
    return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
async function prove(github,value,baseSha) {
    const base=document(await text(github,value.targetRelativePath,baseSha));
    const other=document(await text(github,paths.find(path=>path!==value.targetRelativePath),baseSha));
    const suppressionText=await text(github,'gallery-data/hidden-athlete-ids.json',baseSha);
    const suppression=JSON.parse(suppressionText);
    if(canonical(suppression)!==suppressionText || galleryContract.validateGallerySuppressionDocument(suppression).length)
        throw new Error('Valid current suppression required.');
    const proposed=document(value.manifestText),added=proposed.items.slice(base.items.length);
    if(proposed.items.length!==base.items.length+value.itemIds.length || !same(proposed.items.slice(0,base.items.length),base.items) ||
        !same(added.map(item=>item.id),value.itemIds)) throw new Error('Batch must append exactly its members without changing existing items or order.');
    const seen=[...base.items,...other.items];
    for(const item of added) {
        const generation=derivative(item.sourceUrl,'photo-display').generationId;
        if(item.athleteIds.some(id=>suppression.hiddenAthleteIds.includes(id))) throw new Error('Suppressed member cannot enter batch review.');
        for(const old of seen) {
            if(old.id===item.id || [old.sourceUrl,old.thumbnailUrl,old.posterUrl].filter(Boolean).some(url=>
                url===item.sourceUrl || url===item.thumbnailUrl || parseV2PhotoDerivativeKey(new URL(url).pathname.slice(1))?.generationId===generation))
                throw new Error('Existing, cross-area or within-batch media reuse refused.');
        }
        seen.push(item);
    }
}
async function pulls(github,value) {
    const query=new URLSearchParams({state:'all',head:`johnkevan88888:${branch(value)}`,base:'main',per_page:'10'});
    const result=await github('GET',`/pulls?${query}`);
    if(!Array.isArray(result) || result.length>1) throw new Error('Batch operation must identify at most one review.');return result;
}
function checkedPull(pull,value,baseSha,headSha,allowed=['open'],exactBase=true) {
    if(!allowed.includes(pull?.state) || !Number.isSafeInteger(pull.number) || pull.number<1 ||
        pull.html_url!==`https://github.com/${repository}/pull/${pull.number}` || pull.draft!==false ||
        pull.title!==title(value) || pull.body!==body(value) || pull.base?.ref!=='main' ||
        pull.base?.repo?.full_name!==repository || exactBase && pull.base.sha!==baseSha ||
        pull.head?.repo?.full_name!==repository || pull.head?.ref!==branch(value) || pull.head.sha!==headSha ||
        allowed.length===1 && allowed[0]==='open' && pull.merged_at!==null) throw new Error('Changed, stale or unowned batch review.');
    return pull;
}
async function verifyBranch(github,value,baseSha,headSha) {
    if(await ref(github,branch(value))!==headSha) throw new Error('Batch review branch changed.');
    const commit=await github('GET',`/git/commits/${headSha}`);
    if(commit?.message!==message(value) || commit.parents?.length!==1 || commit.parents[0]?.sha!==baseSha) throw new Error('Unknown batch commit or parent.');
    const compare=await github('GET',`/compare/${baseSha}...${headSha}`);
    if(compare?.status!=='ahead' || compare.ahead_by!==1 || compare.total_commits!==1 || compare.behind_by!==0 ||
        compare.merge_base_commit?.sha!==baseSha || compare.files?.length!==1 || compare.files[0].filename!==value.targetRelativePath ||
        compare.files[0].status!=='modified' || compare.files[0].previous_filename!==undefined ||
        await text(github,value.targetRelativePath,headSha)!==value.manifestText) throw new Error('Batch branch must contain exactly one unchanged candidate file.');
    if(await ref(github,branch(value))!==headSha) throw new Error('Batch branch changed during proof.');
}
function result(value,baseSha,headSha,pull,replayed) {
    return freeze({schemaVersion:'1.0',replayed,repository,baseRef:'main',baseSha,branchRef:branch(value),headSha,
        targetRelativePath:value.targetRelativePath,itemIds:[...value.itemIds],manifestSha256:value.manifestSha256,
        pullRequest:{number:pull.number,url:pull.html_url,state:'open'}});
}
function checkedReview(review,value,baseSha) {
    keys(review,'schemaVersion|replayed|repository|baseRef|baseSha|branchRef|headSha|targetRelativePath|itemIds|manifestSha256|pullRequest');
    keys(review.pullRequest,'number|url|state');
    if(review.schemaVersion!=='1.0' || typeof review.replayed!=='boolean' || review.repository!==repository || review.baseRef!=='main' ||
        review.baseSha!==baseSha || review.branchRef!==branch(value) || !sha.test(review.headSha||'') ||
        review.targetRelativePath!==value.targetRelativePath || !same(review.itemIds,value.itemIds) || review.manifestSha256!==value.manifestSha256 ||
        !Number.isSafeInteger(review.pullRequest.number) || review.pullRequest.number<1 || review.pullRequest.state!=='open' ||
        review.pullRequest.url!==`https://github.com/${repository}/pull/${review.pullRequest.number}`) throw new Error('Exact saved batch review required.');
    return review;
}
function mergedResult(value,baseSha,review,proof) {
    // This is explicitly shared batch evidence. It is never a one-photo +1
    // candidate/review receipt, even when a batch has only one member.
    return {schemaVersion:'1.0',repository,baseRef:'main',baseSha,branchRef:branch(value),headSha:review.headSha,
        targetRelativePath:value.targetRelativePath,itemIds:[...value.itemIds],manifestSha256:value.manifestSha256,
        state:'merged-by-owner',pullRequest:{number:review.pullRequest.number,url:review.pullRequest.url,state:'closed'},
        mergeSha:proof.mergeSha,mainSha:proof.mainSha};
}
function collides(item,other) {
    const generation=derivative(item.sourceUrl,'photo-display').generationId;
    return other.id===item.id || [other.sourceUrl,other.thumbnailUrl,other.posterUrl].filter(Boolean).some(url=>
        url===item.sourceUrl || url===item.thumbnailUrl ||
        parseV2PhotoDerivativeKey(new URL(url).pathname.slice(1))?.generationId===generation);
}
async function stableMerged(github,value,review,proof,owner=false) {
    if(await ref(github,branch(value))!==review.headSha) throw new Error('Batch branch changed during merged proof.');
    const pull=checkedPull(await github('GET',`/pulls/${review.pullRequest.number}`),value,review.baseSha,review.headSha,['closed'],false);
    if(pull.merge_commit_sha!==proof.mergeSha || typeof pull.merged_at!=='string' || Number.isNaN(Date.parse(pull.merged_at)) ||
        owner && pull.merged_by?.login!=='johnkevan88888') throw new Error('Batch terminal review changed during merged proof.');
    await current(github,proof.mainSha);
}

export async function createOrReconcileArchiveGalleryBatchReview(candidateValue,configuration={}) {
    const value=candidate(candidateValue),github=options(configuration,true),baseSha=configuration.expectedBaseSha;
    await current(github,baseSha);await prove(github,value,baseSha);
    let existing=await pulls(github,value),headSha=await ref(github,branch(value),false);
    const replayed=headSha!==null || existing.length>0;
    if(!headSha) {
        if(existing.length) throw new Error('Batch review branch missing.');
        const base=await github('GET',`/git/commits/${baseSha}`);
        if(!sha.test(base?.tree?.sha||'')) throw new Error('Verified base tree required.');
        const blob=await github('POST','/git/blobs',{content:Buffer.from(value.manifestText).toString('base64'),encoding:'base64'});
        if(!sha.test(blob?.sha||'')) throw new Error('Verified candidate blob required.');
        const tree=await github('POST','/git/trees',{base_tree:base.tree.sha,tree:[{path:value.targetRelativePath,mode:'100644',type:'blob',sha:blob.sha}]});
        if(!sha.test(tree?.sha||'')) throw new Error('Verified candidate tree required.');
        const commit=await github('POST','/git/commits',{message:message(value),tree:tree.sha,parents:[baseSha]});
        if(!sha.test(commit?.sha||'')) throw new Error('Verified candidate commit required.');
        try {
            const created=await github('POST','/git/refs',{ref:`refs/heads/${branch(value)}`,sha:commit.sha});
            if(created?.object?.sha!==commit.sha) throw new Error('Changed created branch.');headSha=commit.sha;
        } catch {headSha=await ref(github,branch(value));}
    }
    await verifyBranch(github,value,baseSha,headSha);await current(github,baseSha);
    existing=await pulls(github,value);
    let pull;
    if(existing.length) pull=checkedPull(existing[0],value,baseSha,headSha);
    else {
        // One durable SQL admission immediately precedes the only PR POST. An
        // uncertain POST is observed, never retried by this invocation.
        await configuration.admitPullRequest();
        try {checkedPull(await github('POST','/pulls',{title:title(value),head:branch(value),base:'main',body:body(value),draft:false,
            maintainer_can_modify:false}),value,baseSha,headSha);} catch { /* exact readback below */ }
        existing=await pulls(github,value);
        if(existing.length!==1) throw new Error('Batch PR creation remains uncertain.');pull=checkedPull(existing[0],value,baseSha,headSha);
    }
    pull=checkedPull(await github('GET',`/pulls/${pull.number}`),value,baseSha,headSha);
    await verifyBranch(github,value,baseSha,headSha);await prove(github,value,baseSha);await current(github,baseSha);
    return result(value,baseSha,headSha,pull,replayed);
}

export async function readExistingGalleryBatchReview(candidateValue,configuration={}) {
    const value=candidate(candidateValue),github=options(configuration),baseSha=configuration.expectedBaseSha;
    await current(github,baseSha);await prove(github,value,baseSha);
    const headSha=await ref(github,branch(value)),existing=await pulls(github,value);
    if(existing.length!==1) throw new Error('Batch creation remains uncertain.');
    const pull=checkedPull(await github('GET',`/pulls/${checkedPull(existing[0],value,baseSha,headSha).number}`),value,baseSha,headSha);
    await verifyBranch(github,value,baseSha,headSha);await current(github,baseSha);
    return result(value,baseSha,headSha,pull,true);
}

async function merged(github,value,baseSha,headSha,pull) {
    if(pull.state!=='closed' || typeof pull.merged_at!=='string' || Number.isNaN(Date.parse(pull.merged_at)) ||
        !sha.test(pull.merge_commit_sha||'') || await text(github,value.targetRelativePath,pull.merge_commit_sha)!==value.manifestText)
        throw new Error('Merged batch bytes are not its exact reviewed candidate.');
    await prove(github,value,baseSha);
    const contains=await github('GET',`/compare/${headSha}...${pull.merge_commit_sha}`);
    if(!['identical','ahead'].includes(contains?.status) || contains.behind_by!==0 || contains.merge_base_commit?.sha!==headSha)
        throw new Error('Merge does not contain the reviewed batch head.');
    // Main can advance independently in the other area. It may not turn this
    // reviewed batch into cross-area copies of the same photo/generation.
    const otherPath=paths.find(path=>path!==value.targetRelativePath);
    const other=document(await text(github,otherPath,pull.merge_commit_sha));
    const added=document(value.manifestText).items.slice(-value.itemIds.length);
    for(const item of added) if(other.items.some(old=>old.id===item.id || [old.sourceUrl,old.thumbnailUrl,old.posterUrl].filter(Boolean).some(url=>
        url===item.sourceUrl || url===item.thumbnailUrl || parseV2PhotoDerivativeKey(new URL(url).pathname.slice(1))?.generationId===
            derivative(item.sourceUrl,'photo-display').generationId))) throw new Error('Merged batch is duplicated across areas.');
    const mainSha=await ref(github,'main'),comparison=await github('GET',`/compare/${pull.merge_commit_sha}...${mainSha}`);
    if(!['identical','ahead'].includes(comparison?.status) || comparison.behind_by!==0 || comparison.merge_base_commit?.sha!==pull.merge_commit_sha)
        throw new Error('Batch merge is outside current main.');
    await current(github,mainSha);
    return {state:'merged-by-owner',pullRequestNumber:pull.number,mergeSha:pull.merge_commit_sha,mainSha,headSha};
}
async function readMerged(github,value,reviewValue,baseSha) {
    const review=checkedReview(reviewValue,value,baseSha),existing=await pulls(github,value);
    if(existing.length!==1 || existing[0].number!==review.pullRequest.number) throw new Error('Changed batch review identity.');
    const pull=checkedPull(await github('GET',`/pulls/${review.pullRequest.number}`),value,baseSha,review.headSha,['closed'],false);
    await verifyBranch(github,value,baseSha,review.headSha);
    return {review,pull,proof:await merged(github,value,baseSha,review.headSha,pull)};
}
export async function readMergedGalleryBatchReview(candidateValue,reviewValue,configuration={}) {
    const value=candidate(candidateValue),github=options(configuration),baseSha=configuration.expectedBaseSha;
    const {proof}=await readMerged(github,value,reviewValue,baseSha);
    return freeze(proof);
}

export async function readMergedGalleryBatchPublication(candidateValue,reviewValue,configuration={}) {
    const value=candidate(candidateValue),github=options(configuration),baseSha=configuration.expectedBaseSha;
    const {review,pull,proof}=await readMerged(github,value,reviewValue,baseSha);
    if(pull.merged_by?.login!=='johnkevan88888') throw new Error('Exact owner merge required for new batch publication.');
    const own=document(await text(github,value.targetRelativePath,proof.mainSha));
    const other=document(await text(github,paths.find(path=>path!==value.targetRelativePath),proof.mainSha));
    const suppressionText=await text(github,'gallery-data/hidden-athlete-ids.json',proof.mainSha),suppression=JSON.parse(suppressionText);
    if(canonical(suppression)!==suppressionText || galleryContract.validateGallerySuppressionDocument(suppression).length)
        throw new Error('Valid current suppression required for batch publication.');
    const items=document(value.manifestText).items.slice(-value.itemIds.length);
    if(!same(own.items.filter(item=>value.itemIds.includes(item.id)).map(item=>item.id),value.itemIds))
        throw new Error('All exact ordered batch members must remain on current main.');
    for(const item of items) {
        if(!same(own.items.find(currentItem=>currentItem.id===item.id),item) ||
            item.athleteIds.some(id=>suppression.hiddenAthleteIds.includes(id)) ||
            [...own.items.filter(old=>old.id!==item.id),...other.items].some(old=>collides(item,old)))
            throw new Error('Changed, suppressed or reused batch member cannot complete publication.');
    }
    await stableMerged(github,value,review,proof,true);
    return freeze(mergedResult(value,baseSha,review,proof));
}

export async function readMergedGalleryBatchMemberReview(candidateValue,reviewValue,itemId,configuration={}) {
    const value=candidate(candidateValue);
    if(typeof itemId!=='string' || !value.itemIds.includes(itemId)) throw new Error('Exact original batch member required.');
    const github=options(configuration),baseSha=configuration.expectedBaseSha;
    const {review,proof}=await readMerged(github,value,reviewValue,baseSha);
    // Historical origin proof deliberately does not re-authorize publication.
    // It remains usable for removal after consent/suppression changes or after
    // a sibling has already been removed. The caller must separately establish
    // the member's current exact presence/absence before a strict -1 removal.
    // The wire state's legacy name, "merged-by-owner", is not owner attribution
    // here: missing/changed merged_by must not prevent privacy cleanup. Only
    // readMergedGalleryBatchPublication establishes owner publication authority.
    await stableMerged(github,value,review,proof);
    return freeze(mergedResult(value,baseSha,review,proof));
}

export async function reconcileArchiveGalleryBatchReview(candidateValue,configuration={}) {
    const value=candidate(candidateValue),github=options(configuration),baseSha=configuration.expectedBaseSha;
    const headSha=await ref(github,branch(value),false),existing=await pulls(github,value);
    if(!headSha && existing.length) throw new Error('Uncertain batch review identity.');
    if(headSha) {await verifyBranch(github,value,baseSha,headSha);await prove(github,value,baseSha);}
    const evidence={schemaVersion:'1.0',repository,baseRef:'main',baseSha,branchRef:branch(value),headSha,
        targetRelativePath:value.targetRelativePath,itemIds:[...value.itemIds],manifestSha256:value.manifestSha256,
        state:'no-pr-created',pullRequest:null,mergeSha:null,mainSha:null};
    if(!existing.length) {
        if(await ref(github,branch(value),false)!==headSha || (await pulls(github,value)).length) throw new Error('Batch changed during reconciliation.');
        return freeze(evidence);
    }
    let pull=checkedPull(await github('GET',`/pulls/${checkedPull(existing[0],value,baseSha,headSha,['open','closed'],false).number}`),
        value,baseSha,headSha,['open','closed'],false);
    if(pull.state==='open' && pull.merged_at===null) {
        try {await github('PATCH',`/pulls/${pull.number}`,{state:'closed'});} catch { /* readback required */ }
        pull=checkedPull(await github('GET',`/pulls/${pull.number}`),value,baseSha,headSha,['closed'],false);
    }
    if(pull.state!=='closed') throw new Error('Batch review is not terminal.');
    evidence.pullRequest={number:pull.number,url:pull.html_url,state:'closed'};
    if(pull.merged_at===null) evidence.state='closed-unmerged';
    else {
        const proof=await merged(github,value,baseSha,headSha,pull);
        evidence.state=proof.state;evidence.mergeSha=proof.mergeSha;evidence.mainSha=proof.mainSha;
    }
    if(await ref(github,branch(value))!==headSha) throw new Error('Batch branch changed during reconciliation.');
    return freeze(evidence);
}
