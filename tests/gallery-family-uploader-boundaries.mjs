import assert from 'node:assert/strict';
import {familyUploaderFixture} from './helpers/family-uploader-fixture.mjs';
import {handleAdminRequest} from '../gallery-admin/src/admin-worker.js';
import {createBrowserSession} from '../gallery-admin/src/session.js';
const f=await familyUploaderFixture(),origin='https://synthetic-family-boundaries.example';
const env={...f.env,ADMIN_ORIGIN:origin,OWNER_IDENTITIES:'subject:'+f.owner.subject,SESSION_SECRET:'synthetic-family-security-secret'};
const session=await createBrowserSession(f.owner,env,'family',Date.now()),opposite=await createBrowserSession(f.owner,env,'everyone',Date.now());
const headers={Cookie:session.cookie.split(';')[0],'X-CSRF-Token':session.csrfToken,Origin:origin,'Sec-Fetch-Site':'same-origin'};
const deps={verifyAccessIdentity:async()=>f.owner,bodyTimeoutMilliseconds:15};
const request=(path,body,extra={})=>new Request(origin+path+'?site=family',{method:body?'POST':'GET',headers:{...headers,...(body?{'Content-Type':'application/json'}:{}),...extra},body:body?JSON.stringify(body):undefined});
const run=(r,overrides={})=>handleAdminRequest(r,env,{...deps,...overrides});let checks=0;
try{
    const routes=['family-permission','family-photo-permission','family-athletes','family-drafts',
        `family-drafts/${f.draft.id}`,`family-drafts/${f.draft.id}/prepare`,`family-drafts/${f.draft.id}/submit`,
        `family-drafts/${f.draft.id}/files/${f.photos[0].photoId}`,`family-drafts/${f.draft.id}/files/${f.photos[0].photoId}/read`,
        `family-drafts/${f.draft.id}/files/${f.photos[0].photoId}/delete`];
    for(const name of routes){
        const path='/api/browser/'+name;
        for(const [extra,identity] of [[{Cookie:''},f.owner],[{'X-CSRF-Token':'wrong'},f.owner],[{Origin:'https://untrusted.example'},f.owner],
            [{'Sec-Fetch-Site':'cross-site'},f.owner],[{Cookie:opposite.cookie.split(';')[0],'X-CSRF-Token':opposite.csrfToken},f.owner],
            [{'Cf-Access-Client-Id':'not-a-browser'},f.owner],[{},null],[{},{type:'service',subject:f.owner.subject}],[{},{type:'browser',subject:'outsider'}]]){
            assert.equal((await run(request(path,{},extra),{verifyAccessIdentity:async()=>identity})).status,403);checks++;
        }
    }
    for(const path of ['/family-uploader','/family-uploader.js','/family-uploader.css']){
        const response=await run(request(path));assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
        assert.equal((await run(request(path),{verifyAccessIdentity:async()=>null})).status,403);
        assert.equal((await handleAdminRequest(new Request(origin+path+'?site=everyone'),env,deps)).status,404);checks+=4;
    }
    const path='/api/browser/family-drafts';
    for(const [extra,status] of [[{'Content-Encoding':'gzip'},400],[{'Transfer-Encoding':'chunked'},400],[{'Content-Length':'999999'},413]]){
        assert.equal((await run(request(path,{idempotencyKey:crypto.randomUUID()},extra))).status,status);checks++;
    }
    assert.equal((await run(request(path,undefined,{'Content-Type':'application/json'}))).status,400);
    assert.equal((await run(request(path,{idempotencyKey:crypto.randomUUID(),owner:'injected'}))).status,422);
    const bad=new Request(origin+path+'?site=family',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:new Uint8Array([255])});
    assert.equal((await run(bad)).status,400);checks+=3;
    const stalled=new Request(origin+path+'?site=family',{method:'POST',duplex:'half',headers:{...headers,'Content-Type':'application/json'},
        body:new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));},cancel(){return new Promise(()=>{});}})});
    const start=Date.now();assert.equal((await run(stalled)).status,400);assert.ok(Date.now()-start<1500);checks+=2;
    assert.equal(f.db.prepare('SELECT count(*) n FROM family_gallery_drafts').get().n,1);
    assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_batch_jobs').get().n,0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_attempts').get().n,0);
    assert.equal(f.original.objects.size,1,'Invalid requests did not touch the fixture original');checks+=4;
    const filePath=`/api/browser/family-drafts/${f.draft.id}/files/${f.photos[0].photoId}`;
    assert.equal((await run(request(filePath,{permissionVersion:1}))).status,200);
    const binary=(extra={},bytes=f.bytes[0])=>new Request(origin+filePath+'?site=family',{method:'PUT',headers:{...headers,'Content-Type':'application/octet-stream',...extra},body:bytes});
    for(const [extra,status] of [[{'X-CSRF-Token':'wrong'},403],[{'Content-Encoding':'gzip'},400],[{'Content-Type':'image/jpeg'},400],[{'Content-Length':'999999999'},413]])
        assert.equal((await run(binary(extra))).status,status);
    assert.equal((await run(binary({},new Uint8Array([1,2,3])))).status,422);
    assert.equal((await run(binary())).status,200);
    assert.equal((await run(request(filePath+'/read'))).status,405,'Original read is POST plus owner/session/CSRF, never an embeddable GET URL');
    assert.equal((await run(request(filePath+'/read',{key:'injected'}))).status,422);
    const preview=await run(request(filePath+'/read',{}));assert.equal(preview.status,200);
    assert.equal(preview.headers.get('Cache-Control'),'private, no-store');assert.equal(preview.headers.get('X-Content-Type-Options'),'nosniff');
    assert.equal(preview.headers.get('Cross-Origin-Resource-Policy'),'same-origin');
    assert.equal(preview.headers.get('X-Robots-Tag'),'noindex, nofollow, noarchive');
    assert.deepEqual(new Uint8Array(await preview.arrayBuffer()),new Uint8Array(f.bytes[0]));
    assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_attempts').get().n,0);checks+=15;
}finally{f.db.close();}
console.log(`PASS ${checks} new Family route checks: owner Access, service/anonymous denial, signed area, CSRF, exact bodies, bounded reads and no-store assets.`);
