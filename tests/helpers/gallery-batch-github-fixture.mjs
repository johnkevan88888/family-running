import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export const batchBaseSha='a'.repeat(40);
export const batchToken='ghs_synthetic_batch_installation_token_123456';
export const batchCanonical=value=>`${JSON.stringify(value,null,2)}\n`;
export const batchRevision=text=>`sha256:${createHash('sha256').update(text).digest('hex')}`;
const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
export function batchPhoto(index) {
    const suffix=index.toString(16).padStart(12,'0'),generation=`10000000-0000-4000-8000-${suffix}`;
    const origin='https://family-running-gallery-media-dev.family-running.workers.dev';
    const first=(index*2).toString(16).padStart(64,'0'),second=(index*2+1).toString(16).padStart(64,'0');
    const person=index%2?'synthetic-ada':'synthetic-ben';
    return {id:`photo-20000000-0000-4000-8000-${suffix}`,type:'photo',title:`Synthetic photo ${index}`,caption:'Generated test data only.',
        alt:'Synthetic runner',raceDate:'2026-10-20',raceEvent:'Synthetic 5 km',raceDistance:'5 km',
        sourceUrl:`${origin}/media/v2/${generation}/${first}/display.webp`,thumbnailUrl:`${origin}/media/v2/${generation}/${second}/thumbnail.webp`,
        featured:false,athleteIds:[person],podiumFraming:{[person]:{x:45,y:30,zoom:2}}};
}
export function batchCandidate({site='family',baseItems=[],newItems=[batchPhoto(1),batchPhoto(2)],operationId=`promotion_batch_${'1'.repeat(32)}`}={}) {
    const manifestText=batchCanonical({schemaVersion:'1.0',items:[...clone(baseItems),...clone(newItems)]});
    const targetRelativePath=`gallery-data/${site}.json`,itemIds=newItems.map(item=>item.id),manifestSha256=batchRevision(manifestText);
    return {changed:true,targetRelativePath,itemIds,manifestText,manifestSha256,
        receipt:{schemaVersion:'1.0',operationId,targetRelativePath,itemIds:[...itemIds],manifestSha256}};
}
export function batchGitHub({candidate=batchCandidate(),baseItems=[],otherItems=[],hiddenAthleteIds=[],mainSha=batchBaseSha,...flags}={}) {
    const state={requests:[],mainSha,branchSha:null,branchName:null,branchManifestText:null,pulls:[],createdCommit:null,
        extraFiles:[],baseText:batchCanonical({schemaVersion:'1.0',items:baseItems}),otherText:batchCanonical({schemaVersion:'1.0',items:otherItems}),
        suppressionText:batchCanonical({schemaVersion:'1.0',hiddenAthleteIds}),mergeSha:'f'.repeat(40),mergedText:null,...flags};
    const json=(status,value)=>({ok:status>=200 && status<300,status,json:async()=>clone(value)});
    const file=(path,value)=>json(200,{type:'file',path,encoding:'base64',content:Buffer.from(value).toString('base64')});
    async function fetch(urlText,request={}) {
        const url=new URL(urlText),prefix='/repos/johnkevan88888/family-running',method=request.method||'GET';
        assert.equal(url.origin,'https://api.github.com');assert.ok(url.pathname.startsWith(prefix));
        assert.equal(request.redirect,'error');assert.equal(request.headers.Authorization,`Bearer ${batchToken}`);
        assert.equal(request.headers['X-GitHub-Api-Version'],'2022-11-28');
        const path=url.pathname.slice(prefix.length),body=request.body===undefined?undefined:JSON.parse(request.body);
        state.requests.push({method,path,search:url.search,body:clone(body)});
        if(state.onRequest) await state.onRequest({method,path,body,url,state});
        if(method==='GET' && path==='/git/ref/heads/main') return json(200,{object:{sha:state.mainSha}});
        if(method==='GET' && path.startsWith('/git/ref/heads/gallery-media/candidate-'))
            return state.branchSha?json(200,{object:{sha:state.branchSha}}):json(404,{});
        if(method==='GET' && path===`/git/commits/${batchBaseSha}`) return json(200,{tree:{sha:'b'.repeat(40)}});
        if(method==='GET' && path===`/git/commits/${state.branchSha}`) return json(200,{...state.createdCommit,
            parents:state.createdCommit.parents.map(sha=>({sha})),tree:{sha:state.createdCommit.tree}});
        if(method==='GET' && path===`/compare/${batchBaseSha}...${state.branchSha}`) return json(200,{status:'ahead',ahead_by:1,total_commits:1,
            behind_by:0,merge_base_commit:{sha:batchBaseSha},files:[{filename:candidate.targetRelativePath,status:'modified'},...state.extraFiles]});
        if(method==='GET' && path===`/compare/${state.branchSha}...${state.mergeSha}`) return json(200,{status:'ahead',behind_by:0,
            merge_base_commit:{sha:state.badHeadAncestry?'9'.repeat(40):state.branchSha}});
        if(method==='GET' && path===`/compare/${state.mergeSha}...${state.mainSha}`) return json(200,{status:state.mergeSha===state.mainSha?'identical':'ahead',
            behind_by:state.badMainAncestry?1:0,merge_base_commit:{sha:state.mergeSha}});
        if(method==='GET' && path.startsWith('/contents/gallery-data/')) {
            const at=url.searchParams.get('ref'),target=path.slice('/contents/'.length);
            if(target==='gallery-data/hidden-athlete-ids.json') return file(target,state.suppressionText);
            if(target!==candidate.targetRelativePath) return file(target,at===state.mergeSha?(state.mergedOtherText??state.otherText):state.otherText);
            if(at===batchBaseSha) return file(target,state.baseText);
            if(at===state.mergeSha) return file(target,state.mergedText??state.branchManifestText);
            if(at===state.branchSha) return file(target,state.branchManifestText);
            throw new Error('Unknown synthetic content ref');
        }
        if(method==='GET' && path==='/pulls') {
            assert.equal(url.searchParams.get('state'),'all');assert.equal(url.searchParams.get('base'),'main');
            assert.equal(url.searchParams.get('per_page'),'10');return json(200,state.pulls);
        }
        if(method==='GET' && /^\/pulls\/[1-9][0-9]*$/.test(path)) {
            const pull=state.pulls.find(p=>p.number===Number(path.split('/').at(-1)));
            if(state.failClosedRead && pull?.state==='closed') return json(503,{});
            return pull?json(200,pull):json(404,{});
        }
        if(method==='POST' && path==='/git/blobs') {
            assert.deepEqual(Object.keys(body).sort(),['content','encoding']);assert.equal(body.encoding,'base64');
            state.branchManifestText=Buffer.from(body.content,'base64').toString('utf8');return json(201,{sha:'c'.repeat(40)});
        }
        if(method==='POST' && path==='/git/trees') {
            assert.equal(body.base_tree,'b'.repeat(40));assert.equal(body.tree.length,1);
            assert.deepEqual(body.tree[0],{path:candidate.targetRelativePath,mode:'100644',type:'blob',sha:'c'.repeat(40)});
            return json(201,{sha:'d'.repeat(40)});
        }
        if(method==='POST' && path==='/git/commits') {
            assert.deepEqual(body.parents,[batchBaseSha]);state.createdCommit=clone(body);return json(201,{sha:'e'.repeat(40)});
        }
        if(method==='POST' && path==='/git/refs') {
            assert.match(body.ref,/^refs\/heads\/gallery-media\/candidate-[0-9a-f]{32}$/);
            state.branchName=body.ref.slice('refs/heads/'.length);state.branchSha=body.sha;
            if(state.advanceMain) state.mainSha='9'.repeat(40);
            if(state.loseRefResponse) {state.loseRefResponse=false;throw new Error('Lost synthetic response');}
            return json(201,{object:{sha:state.branchSha}});
        }
        if(method==='POST' && path==='/pulls') {
            assert.equal(body.base,'main');assert.equal(body.draft,false);assert.equal(body.maintainer_can_modify,false);
            assert.equal(body.head,state.branchName);
            const pull={number:state.pulls.length+1,state:'open',merged_at:null,draft:false,title:body.title,body:body.body,
                html_url:`https://github.com/johnkevan88888/family-running/pull/${state.pulls.length+1}`,
                base:{ref:'main',sha:state.mainSha,repo:{full_name:'johnkevan88888/family-running'}},
                head:{ref:state.branchName,sha:state.branchSha,repo:{full_name:'johnkevan88888/family-running'}}};
            if(state.failPullWithoutMutation) throw new Error('Unknown synthetic POST');state.pulls.push(pull);
            if(state.losePullResponse) {state.losePullResponse=false;throw new Error('Lost synthetic response');}
            return json(201,pull);
        }
        if(method==='PATCH' && /^\/pulls\/[1-9][0-9]*$/.test(path)) {
            assert.deepEqual(body,{state:'closed'});if(state.failClose) return json(503,{});
            state.pulls.find(p=>p.number===Number(path.split('/').at(-1))).state='closed';
            if(state.loseCloseResponse) {state.loseCloseResponse=false;throw new Error('Lost synthetic response');}
            return json(200,{});
        }
        throw new Error(`Unexpected synthetic route ${method} ${path}`);
    }
    return {fetch,state,merge(){state.pulls[0].state='closed';state.pulls[0].merged_at='2026-10-20T20:00:00Z';
        state.pulls[0].merge_commit_sha=state.mergeSha;state.mainSha=state.mergeSha;}};
}
