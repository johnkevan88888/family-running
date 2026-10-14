import assert from 'node:assert/strict';
import {syntheticGitHub,syntheticReviewedPhoto,digest} from './helpers/private-gallery-lifecycle-fixtures.mjs';
import {createOrReconcileGalleryReview,createOrReconcileGalleryRemoval,reconcileArchiveGalleryReview} from '../scripts/gallery-media/github-review-client.mjs';

// Fictional public fields only. No source photo, private identity, consent,
// credential or live GitHub request is needed to reproduce the merge shape.
const canonical=document=>`${JSON.stringify(document,null,2)}\n`;
const revision=text=>`sha256:${digest(text)}`;
async function fixture(site,{removal=false,direct=false}={}) {
    const github=syntheticGitHub(),path=`gallery-data/${site}.json`,item=syntheticReviewedPhoto();
    const legacy=syntheticReviewedPhoto('fixture-legacy-photo'),neighbour=syntheticReviewedPhoto('fixture-neighbour-photo');
    github.state.manifests[site].items=removal?[legacy,neighbour,item]:[legacy,neighbour];
    const baseSha=github.state.main;
    const document={schemaVersion:'1.0',items:removal?[legacy,neighbour]:[legacy,neighbour,item]},manifestText=canonical(document);
    const operationId=removal?'removal_00000000-0000-4000-8000-000000000001':'promotion_00000000-0000-4000-8000-000000000001';
    const candidate=removal?{operationId,targetRelativePath:path,item,manifestText,manifestSha256:revision(manifestText)}:
        {changed:true,targetRelativePath:path,itemId:item.id,manifestText,manifestSha256:revision(manifestText),
            receipt:{schemaVersion:'1.0',operationId,targetRelativePath:path,itemId:item.id,manifestSha256:revision(manifestText)}};
    const options={expectedBaseSha:baseSha,token:github.token,fetchImpl:github.fetchImpl};
    const review=await (removal?createOrReconcileGalleryRemoval:createOrReconcileGalleryReview)(candidate,options);
    let merged;
    if(direct) {github.ownerMerge(review);merged={mergeSha:review.headSha};}
    else merged=github.ownerReplacementMerge(review,[legacy.id]);
    return {github,candidate,review,options,item,neighbour,legacy,path,...merged,
        reconcile:extra=>reconcileArchiveGalleryReview(candidate,{...options,kind:removal?'removal':'addition',...extra})};
}
function setMergedDocument(f,document,site=f.path.includes('/family.')?'family':'everyone') {
    f.github.state.commits.get(f.mergeSha).contents[`gallery-data/${site}.json`]=canonical(document);
    f.github.state.manifests[site]=structuredClone(document);
}
const immutable=f=>JSON.stringify({candidate:f.candidate,review:f.review,branch:f.github.state.refs.get(f.review.branchRef),
    contents:f.github.state.commits.get(f.review.headSha).contents});
const reply=value=>({ok:true,status:200,json:async()=>structuredClone(value)});
let adversarialCases=0;
for(const site of ['family','everyone']) {
    const f=await fixture(site),before=immutable(f),writes=f.github.state.requests.filter(r=>r.method!=='GET').length;
    assert.notEqual(f.mergeSha,f.review.headSha);
    assert.notEqual(f.mergeSha,f.intermediate);
    const terminal=await f.reconcile();
    assert.equal(terminal.state,'merged-by-owner');assert.equal(terminal.headSha,f.review.headSha);
    assert.equal(terminal.mergeSha,f.mergeSha);assert.equal(terminal.mainSha,f.mergeSha);
    assert.equal(terminal.manifestSha256,f.candidate.manifestSha256,'The receipt remains bound to the ORIGINAL review document');
    assert.equal(immutable(f),before,'Never rewrite the original candidate, branch, head or review');
    assert.equal(f.github.state.requests.filter(r=>r.method!=='GET').length,writes,'Merged reconciliation performs GET only');
    assert.deepEqual(await f.reconcile(),terminal,'Exact reconciliation replay is read-only');
    f.github.ownerRemove(site,f.item.id);
    const later=await f.reconcile();
    assert.equal(later.mergeSha,f.mergeSha);assert.equal(later.mainSha,f.github.state.main);
    assert.notEqual(later.mainSha,later.mergeSha,'Evidence records actual merge and later main separately, never current absence as merge proof');
    const direct=await fixture(site,{direct:true});assert.equal((await direct.reconcile()).state,'merged-by-owner');

    const badDocuments=[
        ['missing approved photo',{schemaVersion:'1.0',items:[]}],
        ...['id','title','caption','alt','raceDate','raceEvent','raceDistance','sourceUrl','thumbnailUrl','featured','athleteIds','type'].map(field=>{
            const changes={id:'changed-photo',title:'Changed',caption:'Changed',alt:'Changed',raceDate:'2026-01-02',raceEvent:'Changed',raceDistance:'10 km',
                sourceUrl:'https://other.example/changed.webp',thumbnailUrl:'https://other.example/changed.webp',featured:false,athleteIds:[],type:'video'};
            return [`changed approved ${field}`,{schemaVersion:'1.0',items:[{...f.item,[field]:changes[field]}]}];
        }),
        ['extra private field',{schemaVersion:'1.0',items:[{...f.item,personIds:['private-person']}]}],
        ['unsupported document field',{schemaVersion:'1.0',items:[f.item],privateNote:'not public'}],
        ['duplicate ID',{schemaVersion:'1.0',items:[f.item,f.item]}],
        ['added unrelated photo',{schemaVersion:'1.0',items:[f.item,syntheticReviewedPhoto('fixture-unreviewed')]}],
        ['edited surviving neighbour',{schemaVersion:'1.0',items:[{...f.neighbour,caption:'Changed'},f.item]}],
        ['reordered surviving items',{schemaVersion:'1.0',items:[f.item,f.neighbour]}]
    ];
    for(const [label,document] of badDocuments) {
        const bad=await fixture(site);setMergedDocument(bad,document);
        await assert.rejects(bad.reconcile(),undefined,`${site}: ${label}`);adversarialCases++;
    }
    for(const duplicate of [f.item,{...syntheticReviewedPhoto('fixture-cross-area'),sourceUrl:f.item.sourceUrl},
        {...syntheticReviewedPhoto('fixture-cross-area'),thumbnailUrl:f.item.thumbnailUrl}]) {
        const bad=await fixture(site);setMergedDocument(bad,{schemaVersion:'1.0',items:[duplicate]},site==='family'?'everyone':'family');
        await assert.rejects(bad.reconcile(),undefined,'Inherited area cannot be shared by ID or approved URL');adversarialCases++;
    }
    for(const change of [
        pull=>{pull.head.sha='f'.repeat(40);},pull=>{pull.head.ref='unowned-branch';},pull=>{pull.base.ref='other';},
        pull=>{pull.head.repo.full_name='other/repository';},pull=>{pull.body+='changed';},pull=>{pull.title+='changed';},
        pull=>{pull.draft=true;},pull=>{pull.merged_at='invalid';},pull=>{pull.merge_commit_sha='invalid';},pull=>{pull.state='open';}
    ]) {
        const bad=await fixture(site);
        await assert.rejects(bad.reconcile({fetchImpl:async(url,options)=>{
            const response=await bad.github.fetchImpl(url,options);
            if(new URL(url).pathname.endsWith(`/pulls/${bad.review.pullRequest.number}`)) {
                const pull=await response.json();change(pull);return reply(pull);
            }
            return response;
        }}));adversarialCases++;
    }
    const changedHead=await fixture(site);
    changedHead.github.state.commits.get(changedHead.review.headSha).contents[changedHead.path]=canonical({schemaVersion:'1.0',items:[changedHead.item]});
    await assert.rejects(changedHead.reconcile(),/different manifest bytes/);adversarialCases++;
    const detached=await fixture(site);
    detached.github.state.commits.get(detached.mergeSha).parents=[];
    await assert.rejects(detached.reconcile(),undefined,'Same approved photo is NOT proof that the reviewed head was merged');adversarialCases++;
    for(const range of ['review-to-merge','merge-to-main']) for(const comparison of [
        {status:'diverged',behind_by:1,merge_base_commit:{sha:'f'.repeat(40)}},
        {status:'ahead',behind_by:1,merge_base_commit:{sha:range==='review-to-merge'?f.review.headSha:f.mergeSha}},
        {status:'ahead',behind_by:0,merge_base_commit:{sha:'f'.repeat(40)}},
        {status:'ahead',merge_base_commit:{sha:range==='review-to-merge'?f.review.headSha:f.mergeSha}}
    ]) {
        const bad=await fixture(site),endpoint=`/compare/${range==='review-to-merge'?bad.review.headSha:bad.mergeSha}...${bad.mergeSha}`;
        await assert.rejects(bad.reconcile({fetchImpl:(url,options)=>new URL(url).pathname.endsWith(endpoint)?reply(comparison):bad.github.fetchImpl(url,options)}));
        adversarialCases++;
    }
    const branchRace=await fixture(site);let branchReads=0;
    branchRace.github.state.hook=(path,method)=>{
        if(method==='GET' && path===`/git/ref/heads/${branchRace.review.branchRef}` && ++branchReads===3)
            branchRace.github.state.refs.set(branchRace.review.branchRef,'f'.repeat(40));
    };
    await assert.rejects(branchRace.reconcile(),/Review branch changed/);adversarialCases++;
    const mainRace=await fixture(site);let mainReads=0;
    mainRace.github.state.hook=(path,method)=>{
        if(method==='GET' && path==='/git/ref/heads/main' && ++mainReads===2) mainRace.github.state.main='f'.repeat(40);
    };
    await assert.rejects(mainRace.reconcile(),/base branch changed/);adversarialCases++;
    // This compatibility exception is addition-only. A removal must still
    // have its complete exact reviewed manifest, with no collateral deletion.
    const removal=await fixture(site,{removal:true});
    await assert.rejects(removal.reconcile(),/Merged bytes differ/);adversarialCases++;
    const exactRemoval=await fixture(site,{removal:true,direct:true});
    assert.equal((await exactRemoval.reconcile()).state,'merged-by-owner');
}
console.log(`Gallery indirect owner-replacement review reconciliation passes both areas with ${adversarialCases} adversarial refusals; original evidence and exact removal guards are preserved.`);
