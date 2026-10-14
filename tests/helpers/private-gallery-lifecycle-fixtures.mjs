import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const digest=text=>createHash('sha256').update(text).digest('hex');
export function syntheticReviewedPhoto(id='fixture-reviewed-photo') {
    return {id,type:'photo',title:'Generated test photo',caption:'Synthetic review evidence',alt:'Generated fixture',
        raceDate:'2026-01-01',raceEvent:'Fictional race',raceDistance:'5 km',
        sourceUrl:`https://synthetic-archive-media.example/media/v2/00000000-0000-4000-8000-000000000001/${digest(`${id}:display`)}/display.webp`,
        thumbnailUrl:`https://synthetic-archive-media.example/media/v2/00000000-0000-4000-8000-000000000001/${digest(`${id}:thumbnail`)}/thumbnail.webp`,
        featured:true,athleteIds:['fixture-public']};
}
export function syntheticBucket() {
    const objects=new Map(),uploads=new Map(),calls=[];
    const bucket={objects,uploads,calls,hook:null,
        async createMultipartUpload(key,options={}) {
            calls.push(['create',key]);const id=crypto.randomUUID();uploads.set(id,{key,options,state:'open'});
            await bucket.hook?.('create',key);
            return {key,uploadId:id,abort:()=>bucket.resumeMultipartUpload(key,id).abort()};
        },
        resumeMultipartUpload(key,id) {
            const known=()=>{const row=uploads.get(id);if(!row || row.key!==key || row.state!=='open') throw Object.assign(new Error('NoSuchUpload'),{code:'NoSuchUpload'});return row;};
            return {
                async uploadPart(partNumber,bytes) {calls.push(['part',key]);const row=known();row.bytes=Buffer.from(bytes);
                    await bucket.hook?.('part',key);return {partNumber,etag:digest(row.bytes)};},
                async complete(parts) {calls.push(['complete',key]);const row=known();assert.equal(parts[0].etag,digest(row.bytes));
                    const object={key,size:row.bytes.length,bytes:row.bytes,version:crypto.randomUUID(),etag:crypto.randomUUID(),
                        httpMetadata:row.options.httpMetadata,customMetadata:row.options.customMetadata};
                    objects.set(key,object);row.state='complete';await bucket.hook?.('complete',key);return {...object};},
                async abort() {calls.push(['abort',key]);const row=uploads.get(id);
                    if(!row || row.key!==key) throw Object.assign(new Error('NoSuchUpload'),{code:'NoSuchUpload'});
                    // Model Cloudflare's abort-resolves-after-completion shape.
                    if(row.state==='open') row.state='aborted';await bucket.hook?.('abort',key);}
            };
        },
        async get(key,options={}) {calls.push(['get',key]);await bucket.hook?.('get',key);const row=objects.get(key);
            if(!row) return null;if(options.onlyIf?.etagMatches && options.onlyIf.etagMatches!==row.etag) return {...row};
            return {...row,body:new Blob([row.bytes]).stream()};},
        async head(key) {calls.push(['head',key]);await bucket.hook?.('head',key);return objects.get(key)??null;},
        async delete(key) {calls.push(['delete',key]);objects.delete(key);await bucket.hook?.('delete',key);},
        async list({prefix,cursor}) {calls.push(['list',prefix]);await bucket.hook?.('list',prefix);
            assert.equal(cursor,undefined);return {objects:[...objects.values()].filter(row=>row.key.startsWith(prefix)),truncated:false,delimitedPrefixes:[]};},
        async put() {assert.fail('Direct PUT is forbidden in the archive lifecycle.');}
    };return bucket;
}

// A fixed repository transport, never a real GitHub request or credential.
// Owner merge/removal are explicit test-state changes, not client capabilities.
export function syntheticGitHub() {
    const empty={schemaVersion:'1.0',items:[]};
    const state={main:'a'.repeat(40),manifests:{family:structuredClone(empty),everyone:structuredClone(empty)},
        refs:new Map(),commits:new Map(),blobs:new Map(),trees:new Map(),pulls:[],requests:[],unavailable:false,hook:null};
    const json=(status,value)=>({ok:status>=200&&status<300,status,json:async()=>structuredClone(value)});
    const sha=label=>digest(`${label}:${state.requests.length}`).slice(0,40);
    const mainContents=()=>Object.fromEntries(['family','everyone'].map(site=>[`gallery-data/${site}.json`,`${JSON.stringify(state.manifests[site],null,2)}\n`]));
    const isAncestor=(base,head,seen=new Set())=>{
        if(base===head) return true;
        if(seen.has(head)) return false;
        seen.add(head);
        return (state.commits.get(head)?.parents||[]).some(parent=>isAncestor(base,parent.sha,seen));
    };
    const fetchImpl=async (urlValue,options)=>{
        assert.ok(String(urlValue).startsWith('https://api.github.com/repos/johnkevan88888/family-running/'));
        assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer synthetic-private-gallery-token');
        const url=new URL(urlValue),path=url.pathname.slice('/repos/johnkevan88888/family-running'.length),method=options.method;
        const body=options.body?JSON.parse(options.body):undefined;
        state.requests.push({path,method,body});if(state.unavailable) throw new Error('Synthetic GitHub outage');
        await state.hook?.(path,method);
        if(method==='GET' && path==='/git/ref/heads/main') return json(200,{object:{sha:state.main}});
        if(method==='GET' && path.startsWith('/git/ref/heads/')) {
            const head=state.refs.get(path.slice('/git/ref/heads/'.length));return head?json(200,{object:{sha:head}}):json(404,{});
        }
        if(method==='GET' && path.startsWith('/git/commits/')) {
            const ref=path.split('/').at(-1);
            return json(200,state.commits.get(ref)||{sha:ref,tree:{sha:'b'.repeat(40)},parents:[]});
        }
        if(method==='GET' && path.startsWith('/contents/')) {
            const file=path.slice('/contents/'.length),ref=url.searchParams.get('ref');
            const commit=state.commits.get(state.refs.get(ref)||ref);
            const contents=ref===state.main?mainContents():commit?.contents;
            if(!contents?.[file]) return json(404,{});
            return json(200,{type:'file',path:file,encoding:'base64',content:Buffer.from(contents[file]).toString('base64')});
        }
        if(method==='GET' && path.startsWith('/compare/')) {
            const [base,head]=path.slice('/compare/'.length).split('...'),commit=state.commits.get(head);
            if(commit?.path && commit.parents?.[0]?.sha===base) return json(200,{status:'ahead',ahead_by:1,behind_by:0,
                merge_base_commit:{sha:base},total_commits:1,files:[{filename:commit.path,status:'modified'}]});
            if(commit) return json(200,{status:head===base?'identical':isAncestor(base,head)?'ahead':'diverged',ahead_by:head===base?0:1,
                behind_by:isAncestor(base,head)?0:1,merge_base_commit:{sha:isAncestor(base,head)?base:state.main},total_commits:1,files:[]});
            return json(200,{status:head===base?'identical':'ahead',ahead_by:1,behind_by:0,merge_base_commit:{sha:base},total_commits:1,files:[]});
        }
        if(method==='GET' && path==='/pulls') {
            const branch=url.searchParams.get('head')?.split(':')[1];return json(200,state.pulls.filter(p=>p.head.ref===branch));
        }
        if(method==='GET' && /^\/pulls\/\d+$/.test(path)) return json(200,state.pulls.find(p=>p.number===Number(path.split('/').at(-1))));
        if(method==='POST' && path==='/git/blobs') {const id=sha('blob');state.blobs.set(id,Buffer.from(body.content,'base64').toString('utf8'));return json(201,{sha:id});}
        if(method==='POST' && path==='/git/trees') {const id=sha('tree');assert.equal(body.tree.length,1);state.trees.set(id,body.tree[0]);return json(201,{sha:id});}
        if(method==='POST' && path==='/git/commits') {
            // Preserve the base document after main moves, just as a pinned
            // GitHub contents read does. Never infer historical bytes from main.
            if(!state.commits.has(state.main)) state.commits.set(state.main,{sha:state.main,tree:{sha:'b'.repeat(40)},parents:[],contents:mainContents()});
            const id=sha('commit'),tree=state.trees.get(body.tree);state.commits.set(id,{sha:id,message:body.message,tree:{sha:body.tree},
                parents:body.parents.map(sha=>({sha})),path:tree.path,contents:{...mainContents(),[tree.path]:state.blobs.get(tree.sha)}});return json(201,{sha:id});
        }
        if(method==='POST' && path==='/git/refs') {assert.match(body.ref,/^refs\/heads\/gallery-media\/candidate-[0-9a-f]{32}$/);
            state.refs.set(body.ref.slice('refs/heads/'.length),body.sha);return json(201,{object:{sha:body.sha}});}
        if(method==='POST' && path==='/pulls') {
            assert.equal(body.base,'main');const number=state.pulls.length+1;
            const pull={number,state:'open',merged_at:null,draft:false,title:body.title,body:body.body,
                html_url:`https://github.com/johnkevan88888/family-running/pull/${number}`,
                base:{ref:'main',sha:state.main,repo:{full_name:'johnkevan88888/family-running'}},
                head:{ref:body.head,sha:state.refs.get(body.head),repo:{full_name:'johnkevan88888/family-running'}}};
            state.pulls.push(pull);return json(201,pull);
        }
        if(method==='PATCH' && /^\/pulls\/\d+$/.test(path)) {
            assert.deepEqual(body,{state:'closed'});const pull=state.pulls.find(p=>p.number===Number(path.split('/').at(-1)));
            assert.equal(pull.merged_at,null);pull.state='closed';return json(200,pull);
        }
        assert.fail(`Forbidden/unimplemented synthetic repository request ${method} ${path}`);
    };
    return {state,fetchImpl,token:'synthetic-private-gallery-token',ownerMerge(review) {
        const pull=state.pulls.find(p=>p.number===review.pullRequest.number),commit=state.commits.get(review.headSha);
        pull.state='closed';pull.merged_at='2026-10-10T12:00:00.000Z';pull.merge_commit_sha=review.headSha;
        state.main=review.headSha;
        for(const site of ['family','everyone']) state.manifests[site]=JSON.parse(commit.contents[`gallery-data/${site}.json`]);
    },ownerReplacementMerge(review,retiredItemIds) {
        // Model the observed indirect merge: immutable review H is a parent
        // of M, but GitHub associates the review with final replacement C.
        // C removes old entries; it does not rewrite the reviewed branch H.
        const pull=state.pulls.find(p=>p.number===review.pullRequest.number),commit=state.commits.get(review.headSha);
        const intermediate=sha(`owner-reviewed-merge:${review.headSha}`),final=sha(`owner-replacement:${review.headSha}`);
        state.commits.set(intermediate,{sha:intermediate,tree:{sha:'b'.repeat(40)},parents:[{sha:state.main},{sha:review.headSha}],contents:structuredClone(commit.contents)});
        const contents=structuredClone(commit.contents),document=JSON.parse(contents[review.targetRelativePath]);
        document.items=document.items.filter(item=>!retiredItemIds.includes(item.id));
        contents[review.targetRelativePath]=`${JSON.stringify(document,null,2)}\n`;
        state.commits.set(final,{sha:final,tree:{sha:'b'.repeat(40)},parents:[{sha:intermediate}],contents});
        pull.state='closed';pull.merged_at='2026-10-13T19:57:42.000Z';pull.merged_by=null;pull.merge_commit_sha=final;
        state.main=final;
        for(const site of ['family','everyone']) state.manifests[site]=JSON.parse(contents[`gallery-data/${site}.json`]);
        return {intermediate,mergeSha:final};
    },ownerRemove(site,itemId) {
        const parent=state.main;
        state.manifests[site].items=state.manifests[site].items.filter(i=>i.id!==itemId);state.main=sha('owner-removal');
        state.commits.set(state.main,{sha:state.main,tree:{sha:'b'.repeat(40)},parents:[{sha:parent}],contents:mainContents()});
    }};
}
