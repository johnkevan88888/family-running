import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { loadPlaywright, findChromiumExecutable } from '../scripts/browser-runtime.mjs';
import { privateGalleryDocument } from '../gallery-admin/src/private-gallery-assets.js';
import { adminStylesheet } from '../gallery-admin/src/admin-assets.js';
import { privateFaceEditorScript, privateFaceWorkerScript, privateFaceEditorStylesheet } from '../gallery-admin/src/private-gallery-face-assets.js';

const fixture = await readFile(new URL('fixtures/face-framing/synthetic-runners-ai.png', import.meta.url));
assert.equal(createHash('sha256').update(fixture).digest('hex'), '35b6566479871ad6e72465699a2f3a6d3b0d4888fcf924333ebb4826bae7b4db');
const photo = await sharp(fixture).resize(800,800).jpeg().toBuffer();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const people = ['11111111','22222222','33333333'].map((value,index)=>({personId:`person_${value}-1111-4111-8111-111111111111`,displayName:`Fictional person ${index+1}`}));
const assetId='asset_aaaaaaaa-1111-4111-8111-111111111111';
let saved, expectedSha=sha(photo), saveRequests=[], badNetwork=[], mode='normal', loseSave=false, lastSaveKey;
const initial=()=>({ok:true,assetId,version:0,tagVersion:1,sourceSha256:expectedSha,orientation:'exif-transposed-v1',imageWidth:null,imageHeight:null,frames:{},stale:false,publicationEnabled:false});
const geometry=await readFile(new URL('../gallery-podium-framing.js',import.meta.url),'utf8');
const harness=`window.faceController=window.privateGalleryFaceFraming.create({site:new URLSearchParams(location.search).get('site'),getContext:()=>({assetId:${JSON.stringify(assetId)},people:${JSON.stringify(people)},busy:Boolean(window.faceBusy)}),api:async(path,body)=>{const response=await fetch(path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});if(!response.ok)throw new Error('Synthetic save refused');return response.json();}});document.getElementById('private-photo').addEventListener('change',event=>{void window.faceController.selectFile(event.target.files[0]);});window.faceReady=window.faceController.setAsset();`;
const server=createServer(async(req,res)=>{
    const target=new URL(req.url,'http://127.0.0.1');
    const respond=(value,type='text/javascript',status=200)=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store'});res.end(value);};
    if(target.pathname==='/private-gallery') return respond(privateGalleryDocument(target.searchParams.get('site')),'text/html');
    if(target.pathname==='/private-gallery.js') return respond(harness);
    if(target.pathname==='/gallery-podium-framing.js') return respond(geometry);
    if(target.pathname==='/private-face-editor.js') return respond(privateFaceEditorScript());
    if(target.pathname==='/private-face-editor.css') return respond(privateFaceEditorStylesheet(),'text/css');
    if(target.pathname==='/admin.css') return respond(adminStylesheet(),'text/css');
    if(target.pathname==='/private-face-worker.js') {
        if(mode==='error') return respond('throw new Error("synthetic detector failure")');
        if(mode==='timeout') return respond('onmessage=()=>{}');
        if(mode==='late') return respond('onmessage=e=>setTimeout(()=>postMessage({id:e.data.id,faces:[{x:99,y:99,width:5,height:5}]}),800)');
        return respond(privateFaceWorkerScript());
    }
    if(target.pathname===`/api/browser/private-assets/${assetId}`) return respond(JSON.stringify({ok:true,asset:{assetId,personIds:people.map(value=>value.personId)}}),'application/json');
    if(target.pathname===`/api/browser/private-assets/${assetId}/framing`) {
        if(req.method==='GET') return respond(JSON.stringify(saved||initial()),'application/json');
        let body='';for await(const chunk of req)body+=chunk;
        const input=JSON.parse(body);saveRequests.push(input);
        assert.equal(input.confirmed,true);assert.equal(input.sourceSha256,expectedSha);assert.equal(input.orientation,'exif-transposed-v1');
        assert.deepEqual(Object.keys(input).sort(),['idempotencyKey','expectedVersion','tagVersion','sourceSha256','orientation','imageWidth','imageHeight','frames','confirmed'].sort());
        for(const [id,frame] of Object.entries(input.frames)) {assert(people.some(value=>value.personId===id));assert.deepEqual(Object.keys(frame).sort(),['x','y','zoom']);}
        if(lastSaveKey===input.idempotencyKey) return respond(JSON.stringify({...saved,replayed:true}),'application/json');
        lastSaveKey=input.idempotencyKey;
        saved={...initial(),version:(saved?.version||0)+1,imageWidth:input.imageWidth,imageHeight:input.imageHeight,frames:input.frames};
        if(loseSave) {loseSave=false;return respond('{"error":"synthetic-lost-save-response"}','application/json',503);}
        return respond(JSON.stringify(saved),'application/json');
    }
    if(target.pathname!=='/favicon.ico') badNetwork.push(target.pathname);
    respond('not found','text/plain',404);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const screenshots=new URL('../test-artifacts/screenshots/',import.meta.url);await mkdir(screenshots,{recursive:true});
const browser=await loadPlaywright().chromium.launch({headless:true,executablePath:findChromiumExecutable()});
async function ready(page,buffer=photo,mimeType='image/jpeg') {
    expectedSha=sha(buffer);saved=null;saveRequests=[];lastSaveKey=null;
    await page.goto(origin+'/private-gallery?site=family');
    await page.evaluate(()=>window.faceReady);
    await page.locator('#private-photo').setInputFiles({name:mimeType==='image/png'?'synthetic.png':'synthetic.jpg',mimeType,buffer});
    await page.waitForFunction(()=>!document.getElementById('private-framing-workspace').hidden);
}
try {
    for(const viewport of [{width:1440,height:1000},{width:390,height:844}]) {
        const context=await browser.newContext({viewport});
        const unexpected=[];
        await context.route('**/*',route=>{
            if(new URL(route.request().url()).origin!==origin){unexpected.push(route.request().url());return route.abort();}
            return route.continue();
        });
        const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
        try {
            mode='normal';await ready(page);
            await page.waitForFunction(()=>document.getElementById('private-face-candidates').childElementCount>=3,{timeout:10000});
            assert.equal(await page.locator('#private-framing-person option').count(),3);
            assert.equal(await page.locator('#private-framing-confirm').isChecked(),false);
            assert.equal(saveRequests.length,0,'detection never saves or confirms');
            assert.equal(await page.locator('#private-complete-tags').isChecked(),false);
            assert.equal(await page.locator('#private-public-use').isChecked(),false);
            for(let index=0;index<3;index++) {
                await page.locator('#private-framing-person').selectOption(people[index].personId);
                await page.locator('#private-face-candidates button').nth(index).click();
                assert.equal(await page.locator('#private-framing-save').isEnabled(),false);
            }
            await page.locator('#private-framing-confirm').check();
            assert.equal(await page.locator('#private-framing-save').isEnabled(),true);
            await page.locator('#private-framing-person').selectOption(people[0].personId);
            assert.equal(await page.locator('#private-framing-confirm').isChecked(),false,'changing the person requires a fresh explicit check');
            assert.equal(await page.locator('#private-framing-save').isEnabled(),false,'Save follows the reset confirmation immediately');
            await assert.rejects(page.evaluate(()=>window.faceController.beforeConsent()),/Save or discard/);
            await page.evaluate(()=>{const button=document.getElementById('private-framing-save');button.disabled=false;button.click();});
            assert.equal(saveRequests.length,0,'forcing an enabled button cannot replace explicit confirmation');
            await page.locator('#private-framing-confirm').check();
            await page.evaluate(()=>{window.faceBusy=true;window.faceController.refreshControls();const button=document.getElementById('private-framing-save');button.disabled=false;button.click();});
            assert.equal(saveRequests.length,0,'forcing an enabled button cannot bypass outer uploader operation exclusion');
            await page.evaluate(()=>{window.faceBusy=false;window.faceController.refreshControls();});
            await page.getByRole('button',{name:'Save checked framing privately'}).click();
            await page.getByText('Checked framing saved privately.',{exact:false}).waitFor();
            assert.equal(Object.keys(saved.frames).length,3);
            assert.equal(await page.evaluate(()=>window.faceController.beforeConsent()),1);
            assert.equal(saved.imageWidth,800);assert.equal(saved.imageHeight,800);
            assert.equal(saveRequests.length,1);
            assert.equal(await page.locator('#private-framing-confirm').isChecked(),false);
            await page.screenshot({path:fileURLToPath(new URL(`private-face-framing-${viewport.width}.png`,screenshots)),fullPage:true});
            assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
            await page.evaluate(()=>window.faceController.setAsset());
            assert.equal(await page.locator('#private-framing-workspace').isHidden(),true,'reopening does not read an original');
            assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
        } finally {await context.close();}
    }
    const context=await browser.newContext();const page=await context.newPage();
    try {
        mode='normal';const blank=await sharp({create:{width:400,height:300,channels:3,background:'#ffffff'}}).jpeg().toBuffer();
        await ready(page,blank);
        await page.getByText('No face was found.',{exact:false}).waitFor();
        await page.locator('#private-framing-image').click({position:{x:150,y:70}});
        await page.locator('#private-framing-confirm').check();
        await page.getByRole('button',{name:'Save checked framing privately'}).click();
        await page.getByText('Checked framing saved privately.',{exact:false}).waitFor();
        assert.equal(Object.keys(saved.frames).length,1,'manual point works when real model detects no faces');
        mode='normal';await ready(page,blank);
        await page.locator('#private-framing-image').click({position:{x:110,y:75}});
        await page.locator('#private-framing-confirm').check();loseSave=true;
        await page.getByRole('button',{name:'Save checked framing privately'}).click();
        await page.getByText('No automatic save retry was attempted.',{exact:false}).waitFor();
        assert.equal(saved.version,1);assert.equal(saveRequests.length,1);
        await page.getByRole('button',{name:'Save checked framing privately'}).click();
        await page.getByText('Checked framing saved privately.',{exact:false}).waitFor();
        assert.equal(saved.version,1,'explicit lost-response retry does not append another revision');
        assert.equal(saveRequests.length,2);assert.equal(saveRequests[0].idempotencyKey,saveRequests[1].idempotencyKey);
        mode='normal';await ready(page);
        await page.locator('#private-photo').setInputFiles({name:'mismatched.jpg',mimeType:'image/jpeg',buffer:blank});
        await page.getByText('This local file does not match the saved original.',{exact:false}).waitFor();
        await assert.rejects(page.evaluate(()=>window.faceController.beforeConsent()),/not verified against/);
        assert.equal(saveRequests.length,0);
        const tall=await sharp({create:{width:600,height:1800,channels:3,background:'#c7c7c7'}}).jpeg().toBuffer();
        await ready(page,tall);
        const tallBox=await page.locator('#private-framing-image').boundingBox();
        await page.locator('#private-framing-image').click({position:{x:tallBox.width*.5,y:tallBox.height*.25}});
        const focal=await page.evaluate(()=>{
            const photo=document.getElementById('private-framing-image').getBoundingClientRect(),point=document.getElementById('private-framing-marker').getBoundingClientRect();
            return {x:(point.left+point.width/2-photo.left)/photo.width*100,y:(point.top+point.height/2-photo.top)/photo.height*100};
        });
        assert(Math.abs(focal.x-50)<1 && Math.abs(focal.y-25)<1,'marker follows the displayed portrait pixels, not its larger wrapper');
        mode='error';await ready(page);await page.getByText('Automatic detection is unavailable.',{exact:false}).waitFor();
        await page.locator('#private-framing-x').fill('42');assert.equal(await page.locator('#private-framing-save').isEnabled(),false);
        mode='timeout';await ready(page);await page.getByText('Automatic detection timed out.',{exact:false}).waitFor({timeout:8000});
        mode='late';await ready(page);const changed=await sharp({create:{width:120,height:240,channels:3,background:'#00bb88'}}).png().toBuffer();
        expectedSha=sha(changed);
        await page.locator('#private-photo').setInputFiles({name:'changed.png',mimeType:'image/png',buffer:changed});
        await page.waitForFunction(()=>document.getElementById('private-framing-image').width===120);
        await page.waitForTimeout(1000);
        assert.equal(await page.locator('#private-face-candidates button').count(),1,'only current selection may receive a late result');
        assert.equal(await page.locator('#private-framing-confirm').isChecked(),false);
        assert.equal(saveRequests.length,0);
        // Native decoding, not a stub: compare all eight EXIF orientations,
        // including mirrors, to the production processor's Sharp autoOrient.
        const quadrant=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="240"><rect width="80" height="120" fill="#ff0000"/><rect x="80" width="80" height="120" fill="#00ff00"/><rect y="120" width="80" height="120" fill="#0000ff"/><rect x="80" y="120" width="80" height="120" fill="#ffff00"/></svg>')).jpeg().toBuffer();
        mode='timeout';
        for(let orientation=1;orientation<=8;orientation++) {
            const input=await sharp(quadrant).withMetadata({orientation}).jpeg({quality:95}).toBuffer();
            await ready(page,input);
            const expected=await sharp(input).autoOrient().raw().toBuffer({resolveWithObject:true});
            const rendered=await page.evaluate(()=>{
                const canvas=document.getElementById('private-framing-image'),ctx=canvas.getContext('2d');
                return {width:canvas.width,height:canvas.height,corners:[[.25,.25],[.75,.25],[.25,.75],[.75,.75]].map(([x,y])=>Array.from(ctx.getImageData(Math.floor(canvas.width*x),Math.floor(canvas.height*y),1,1).data).slice(0,3))};
            });
            assert.equal(rendered.width,expected.info.width,`orientation ${orientation} width`);assert.equal(rendered.height,expected.info.height,`orientation ${orientation} height`);
            for(const [index,[x,y]] of [[.25,.25],[.75,.25],[.25,.75],[.75,.75]].entries()) {
                const at=(Math.floor(expected.info.height*y)*expected.info.width+Math.floor(expected.info.width*x))*expected.info.channels;
                for(let channel=0;channel<3;channel++) assert(Math.abs(rendered.corners[index][channel]-expected.data[at+channel])<15,`orientation ${orientation} corner ${index}`);
            }
        }
        const oversized=await sharp({create:{width:8,height:8,channels:3,background:'#fff'}}).png().toBuffer();
        const invalid=Buffer.from(oversized);invalid.writeUInt32BE(100000,16);invalid.writeUInt32BE(100000,20);
        await ready(page,photo);
        await page.locator('#private-photo').setInputFiles({name:'too-large.png',mimeType:'image/png',buffer:invalid});
        await page.getByText('The local image dimensions exceed the photo policy.',{exact:false}).waitFor();
        assert.equal(await page.locator('#private-framing-workspace').isHidden(),true);
        assert.equal(saveRequests.length,0);
    } finally {await context.close();}
    assert.deepEqual(badNetwork,[],'no original, upload, workflow or external-model request is possible in this detector fixture');
    console.log('Private face browser passed: actual pinned model detects three AI-generated faces; explicit per-person manual confirmation, no identity/tag/consent inference, no external requests, zero/error/timeout fallback, stale-file cancellation, all eight native EXIF orientations and responsive previews.');
} finally {await browser.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}
