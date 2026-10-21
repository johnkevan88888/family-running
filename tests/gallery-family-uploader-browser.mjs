import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {handleAdminRequest} from '../gallery-admin/src/admin-worker.js';
import {loadPlaywright,findChromiumExecutable} from '../scripts/browser-runtime.mjs';
import {syntheticBucket,digest} from './helpers/private-gallery-lifecycle-fixtures.mjs';
import {transactionalDB} from './helpers/family-uploader-fixture.mjs';
import {readBoundedBytes,sha256Hex} from '../gallery-admin/src/media-byte-verification.js';

const root=new URL('../gallery-admin/migrations/',import.meta.url);
const migrations=await Promise.all((await readdir(root)).filter(n=>n.endsWith('.sql')).sort().map(n=>readFile(new URL(n,root),'utf8')));
const fixture=await readFile(new URL('fixtures/face-framing/synthetic-runners-ai.png',import.meta.url));
assert.equal(digest(fixture),'35b6566479871ad6e72465699a2f3a6d3b0d4888fcf924333ebb4826bae7b4db');
const meta=await sharp(fixture).metadata(),width=Math.floor(meta.width/3);
const photos=await Promise.all([0,1,2].map(index=>sharp(fixture).extract({left:index*width,top:0,width,height:meta.height})
    .resize({height:768}).withExif({IFD0:{Make:'synthetic-family-'+index}}).jpeg().toBuffer()));
const screenshots=new URL('../test-artifacts/screenshots/',import.meta.url);await mkdir(screenshots,{recursive:true});
const origin='https://synthetic-family-uploader.example',owner={type:'browser',subject:'synthetic-family-owner'};
const browser=await loadPlaywright().chromium.launch({headless:true,executablePath:findChromiumExecutable()});
try{for(const mobile of [false,true]){
    const db=new DatabaseSync(':memory:');for(const sql of migrations)db.exec(sql);
    const bucket=syntheticBucket(),env={ADMIN_ORIGIN:origin,OWNER_IDENTITIES:'subject:'+owner.subject,
        SESSION_SECRET:'synthetic-family-browser-session-secret',PRIVATE_ORIGINALS:bucket,DB:{prepare(sql){let args=[];return{
            bind(...values){args=values;return this;},async first(){return db.prepare(sql).get(...args)??null;},
            async all(){return {success:true,results:db.prepare(sql).all(...args)};},
            async run(){return {success:true,meta:{changes:Number(db.prepare(sql).run(...args).changes)}};}
        };}}};transactionalDB({db,env});
    const context=await browser.newContext(mobile?{viewport:{width:390,height:844},isMobile:true,hasTouch:true}:{viewport:{width:1440,height:1000}});
    const page=await context.newPage(),errors=[],unexpected=[],requests=[];let loseSave=false;
    page.on('pageerror',error=>errors.push(error.message));
    await context.route('**/*',async route=>{
        const incoming=route.request(),url=new URL(incoming.url());if(url.origin!==origin){unexpected.push(url.href);return route.abort();}
        const headers=await incoming.allHeaders();if(headers.origin===origin)headers['sec-fetch-site']='same-origin';
        const request=new Request(incoming.url(),{method:incoming.method(),headers,body:incoming.method==='GET'?undefined:incoming.postDataBuffer()});
        requests.push([incoming.method(),url.pathname]);
        const response=await handleAdminRequest(request,env,{verifyAccessIdentity:async()=>owner,
            digestReadable:async body=>sha256Hex(await readBoundedBytes(body,26214400))});
        if(loseSave&&incoming.method()==='POST'&&/family-drafts\/[0-9a-f-]+$/.test(url.pathname)&&response.ok){loseSave=false;return route.fulfill({status:503,contentType:'application/json',body:'{"ok":false}'});}
        return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});
    });
    const idle=()=>page.waitForFunction(()=>!document.getElementById('family-files').disabled);
    const status=text=>page.locator('#family-status').filter({hasText:text}).waitFor();
    try{
        await page.goto(origin+'/family-uploader?site=family');await status('Family library ready');await idle();
        assert.equal(await page.locator('h1').textContent(),'Add Family photos');
        await page.getByRole('button',{name:'Use standing Family permission',exact:true}).click();await status('Standing Family permission saved');await idle();
        await page.locator('#family-files').setInputFiles(photos.map((buffer,index)=>({name:`synthetic-${index}.jpg`,mimeType:'image/jpeg',buffer})));
        await status('Choose the event and people next');await idle();assert.equal(await page.locator('.family-photo-card').count(),3);
        assert.equal(bucket.objects.size,0,'File selection and metadata autosave do not upload pixels');
        await page.locator('#family-event').selectOption({index:1});await idle();
        await page.locator('#family-athlete-search').fill('John Kevan');
        await page.locator('#family-athletes').getByRole('checkbox').check();await status('People saved');await idle();
        assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_people').get().n,1,'Direct public athlete selection creates one protected association');
        await page.getByRole('button',{name:'Use this event and people on other unsaved photos'}).click();await status('Event and people copied');await idle();
        const id=db.prepare('SELECT draft_id FROM family_gallery_drafts').get().draft_id;
        for(let index=0;index<3;index++){
            await page.getByRole('button',{name:index?'Next photo':'Check photo 1',exact:true}).click();await idle();
            await page.locator('#family-minors').selectOption('no');await idle();
            await page.getByRole('button',{name:'Save photo privately and check thumbnails'}).click();await status('Saved privately. Check');await idle();
            await page.waitForFunction(()=>document.getElementById('private-face-candidates').childElementCount>=1,null,{timeout:15000});
            if(index===0)await page.locator('#private-face-detection').filter({hasText:'One face suggested'}).waitFor();
            else await page.locator('#private-face-candidates button').first().click();
            assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_frame_revisions').get().n,index,'Automatic framing is not automatically confirmed');
            await page.locator('#private-framing-zoom').fill('1.05');
            if(index===2)assert.equal(await page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;}),true,
                'Unsaved framing warns on closing or reloading even when every original is retained');
            await page.getByRole('button',{name:'Use these thumbnail views'}).click();await status('Thumbnail views saved');await idle();
            assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_frame_revisions').get().n,index+1);
        }
        assert.equal(await page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;}),false,
            'Fully saved framing does not leave a misleading unsaved-work warning');
        assert.equal(bucket.objects.size,3);assert.equal(db.prepare('SELECT count(DISTINCT asset_id) n FROM family_gallery_draft_photos').get().n,3);
        assert.equal(db.prepare('SELECT count(*) n FROM family_gallery_permissions').get().n,1,'No repeated per-photo permission forms');
        assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_attempts').get().n,0,'Saving thumbnails never queues review');
        await page.screenshot({path:fileURLToPath(new URL(`family-uploader-${mobile?'mobile':'desktop'}.png`,screenshots)),fullPage:true});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'No horizontal overflow');
        await page.reload();await status('Family library ready');await idle();
        await page.locator('#family-drafts').selectOption(id);await page.getByRole('button',{name:'Open batch',exact:true}).click();await status('Saved batch opened');await idle();
        assert.equal(await page.locator('.family-photo-card').count(),3);
        assert.equal(await page.getByRole('button',{name:'Send 3 photos for review',exact:true}).isEnabled(),true,'Saved checked photos can submit without rereading originals');
        await page.getByRole('button',{name:'Send 3 photos for review',exact:true}).click();await status('Batch saved for one combined review');await idle();
        assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_batch_jobs').get().n,1);
        assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_attempts WHERE standing_permission_version=1 AND framing_version=1').get().n,3);
        assert.match(await page.locator('#family-review-status').textContent(),/Automatic processing is not configured/);
        assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_batch_reviews').get().n,0,'No fake live PR success');
        assert.equal(requests.some(([method,path])=>method==='GET'&&path.endsWith('/archive-original')),false);
        // A new draft keeps its stable save key across an uncertain response.
        await page.getByRole('button',{name:'Start a new batch'}).click();await status('New saved Family batch');await idle();loseSave=true;
        await page.locator('#family-files').setInputFiles({name:'synthetic-retry.jpg',mimeType:'image/jpeg',buffer:photos[0]});
        await status('The save could not be confirmed');await idle();
        await page.getByRole('button',{name:'Save details',exact:true}).click();await status('Photo details saved.');await idle();
        assert.equal(db.prepare('SELECT count(*) n FROM family_gallery_draft_photos').get().n,4,'Unknown-save retry adds no duplicate card');
        assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    }catch(error){await page.screenshot({path:fileURLToPath(new URL(`family-uploader-failure-${mobile?'mobile':'desktop'}.png`,screenshots)),fullPage:true});
        console.error('Local synthetic UI status:',await page.locator('#family-status').textContent(),errors);throw error;
    }finally{await context.close();db.close();}
}}finally{await browser.close();}
console.log('PASS Family uploader desktop/mobile: three synthetic face photos, actual detector suggestions, manual zoom, direct athlete selection, one permission, saved/resumed batch, uncertain-save retry and one protected review request; no external requests or publication.');
