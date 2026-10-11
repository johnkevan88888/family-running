import assert from 'node:assert/strict';
import {readFile,readdir,mkdir} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {handleAdminRequest} from '../gallery-admin/src/admin-worker.js';
import {loadPlaywright,findChromiumExecutable} from '../scripts/browser-runtime.mjs';
import sharp from 'sharp';
import {syntheticBucket} from './helpers/private-gallery-lifecycle-fixtures.mjs';
import {readBoundedBytes,sha256Hex} from '../gallery-admin/src/media-byte-verification.js';

const directory=new URL('../gallery-admin/migrations/',import.meta.url);
const migrations=await Promise.all((await readdir(directory)).filter(name=>name.endsWith('.sql')).sort()
    .map(name=>readFile(new URL(name,directory),'utf8')));
const origin='https://synthetic-private-library.example';
const owner={type:'browser',subject:'synthetic-owner'};
const photo=await sharp({create:{width:14,height:21,channels:3,background:'#287abd'}}).jpeg().toBuffer();
const screenshotDirectory=new URL('../test-artifacts/screenshots/',import.meta.url);
await mkdir(screenshotDirectory,{recursive:true});
const {chromium}=loadPlaywright();
const browser=await chromium.launch({headless:true,executablePath:findChromiumExecutable()});
try {
    for(const site of ['family','everyone']) for(const viewport of [{width:1440,height:900},{width:390,height:844}]) {
        const db=new DatabaseSync(':memory:');for(const sql of migrations)db.exec(sql);
        const env={ADMIN_ORIGIN:origin,OWNER_IDENTITIES:'subject:synthetic-owner',AUTOMATION_IDENTITIES:'subject:synthetic-service',
            SESSION_SECRET:'synthetic-private-library-browser-session-secret',PRIVATE_ORIGINALS:syntheticBucket(),DB:{prepare(sql){let values=[];return {
                bind(...bindings){values=bindings;return this;},
                async first(){return db.prepare(sql).get(...values) ?? null;},
                async all(){return {success:true,results:db.prepare(sql).all(...values)};},
                async run(){const result=db.prepare(sql).run(...values);return {success:true,meta:{changes:Number(result.changes)}};}};},
                async batch(statements){db.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());
                    db.exec('COMMIT');return results;}catch(error){db.exec('ROLLBACK');throw error;}}}};
        const context=await browser.newContext({viewport,isMobile:viewport.width<500});
        const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
        let loseAssetResponse=true,loseUploadResponse=true,individualPreferenceReads=0;
        await page.route(origin+'/**',async route=>{
            const incoming=route.request();
            if(incoming.method()==='GET' && new URL(incoming.url()).pathname.endsWith('/visibility')) individualPreferenceReads++;
            const headers=await incoming.allHeaders();
            // Playwright's intercepted virtual origin omits the fetch-metadata
            // header added by a real network request. Supply it only for this
            // exact same-origin synthetic transport; route-denial tests above
            // exercise the actual Worker without this fixture adaptation.
            if(headers.origin === origin && new URL(incoming.url()).origin === origin) headers['sec-fetch-site']='same-origin';
            const request=new Request(incoming.url(),{method:incoming.method(),headers,
                body:incoming.method()==='GET' ? undefined : incoming.postDataBuffer()});
            const response=await handleAdminRequest(request,env,{verifyAccessIdentity:async()=>owner,
                digestReadable:async body=>sha256Hex(await readBoundedBytes(body,photo.length))});
            if(incoming.method()==='POST' && new URL(incoming.url()).pathname==='/api/browser/private-assets' && loseAssetResponse && response.status===201) {
                loseAssetResponse=false;await route.fulfill({status:503,contentType:'application/json',body:'{"error":"synthetic-lost-response"}'});return;
            }
            if(incoming.method()==='PUT' && new URL(incoming.url()).pathname.endsWith('/archive-original') && loseUploadResponse && response.status===200) {
                loseUploadResponse=false;await route.fulfill({status:503,contentType:'application/json',body:'{"error":"synthetic-lost-upload-response"}'});return;
            }
            await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});
        });
        await page.goto(origin+'/private-gallery?site='+site);
        await page.getByText('Protected intake, consent and owner job preparation ready.',{exact:false}).waitFor();
        for(const name of ['Synthetic Runner A','Synthetic Private Runner <not markup>']) {
            await page.locator('#private-person-name').fill(name);
            await page.getByRole('button',{name:'Add private person'}).click();
            await page.getByText('Private person saved, initially hidden.',{exact:false}).waitFor();
        }
        assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_people').get().n,2);
        assert.equal(await page.locator('#private-people img').count(),0);
        assert.ok((await page.locator('#private-people strong').allTextContents()).includes('Synthetic Private Runner <not markup>'));
        await page.locator('#private-tag-choices input').nth(0).check();
        await page.locator('#private-tag-choices input').nth(1).check();
        await page.getByRole('button',{name:'Save private tags'}).click();
        await page.getByText('Request stopped.',{exact:false}).waitFor();
        await page.getByRole('button',{name:'Save private tags'}).click();
        await page.locator('#private-asset-status').filter({hasText:'At least one depicted person blocks publication.'}).waitFor();
        assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_assets').get().n,1,'Lost response retry reserves once');
        assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_asset_tags').get().n,2);
        await page.locator('#private-people .draft-card').nth(0).getByRole('button',{name:'Allow for a fresh review'}).click();
        await page.getByText('Preference saved privately.',{exact:false}).waitFor();
        await page.getByRole('button',{name:'Save private tags'}).click();
        await page.locator('#private-asset-status').filter({hasText:'At least one depicted person blocks publication.'}).waitFor();
        await page.locator('#private-people .draft-card').nth(1).getByRole('button',{name:'Allow for a fresh review'}).click();
        await page.getByText('Preference saved privately.',{exact:false}).waitFor();
        await page.getByRole('button',{name:'Save private tags'}).click();
        await page.locator('#private-asset-status').filter({hasText:'Visibility preferences allow a fresh consent check.'}).waitFor();
        await page.locator('#private-photo').setInputFiles({name:'private-filename-must-not-leak.jpg',mimeType:'image/jpeg',buffer:photo});
        await page.locator('#private-retention').check();
        await page.locator('#private-upload-adults').check();
        await page.getByRole('button',{name:'Upload original to protected storage'}).click();
        await page.getByText('Upload stopped.',{exact:false}).waitFor();
        const storageCalls=env.PRIVATE_ORIGINALS.calls.length;
        await page.getByRole('button',{name:'Upload original to protected storage'}).click();
        await page.getByText('Private original verified. Nothing published.',{exact:true}).waitFor();
        assert.equal(env.PRIVATE_ORIGINALS.calls.length,storageCalls,'Lost upload reply is recovered from exact intake receipt, without another media write');
        assert.equal(db.prepare('SELECT count(*) n FROM private_archive_original_receipts').get().n,1);
        await page.locator('#private-complete-tags').check();await page.locator('#private-public-use').check();
        await page.locator('#private-public-adults').check();
        await page.getByRole('button',{name:'Save fresh public consent'}).click();
        await page.getByText('Fresh public-use consent saved separately.',{exact:false}).waitFor();
        assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_attempts').get().n,1);
        assert.equal(await page.locator('#private-public-use').isChecked(),false,'Next use requires fresh explicit answers');
        assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_pipeline_admissions').get().n,0,'Consent reservation does not run processing');
        await page.locator('#private-job-confirm').check();
        await page.getByRole('button',{name:'Request protected job'}).click();
        await page.getByText('Protected job requested.',{exact:false}).waitFor();
        assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_owner_jobs').get().n,1);
        assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_job_claims').get().n,0,'Browser never dispatches or claims a job');
        assert.equal(await page.locator('#private-job-confirm').isChecked(),false);
        assert.equal(await page.locator('#private-jobs a').getAttribute('href'),'https://github.com/johnkevan88888/family-running/actions/workflows/gallery-archive-job.yml');
        for(const object of env.PRIVATE_ORIGINALS.objects.values()) assert.equal(JSON.stringify(object).includes('private-filename-must-not-leak'),false);
        await page.locator('#private-people .draft-card').nth(0).getByRole('button',{name:'Set hidden preference'}).click();
        await page.getByText('Preference saved privately.',{exact:false}).waitFor();
        await page.locator('#private-asset-status').filter({hasText:'At least one depicted person blocks publication.'}).waitFor();
        assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_asset_tags').get().n,2);
        assert.equal(db.prepare('SELECT count(*) n FROM gallery_drafts').get().n,0,'Private preference cannot create an unguarded legacy review draft');
        assert.equal(await page.locator('select[name="site"],select[name="destination"]').count(),0);
        assert.equal(individualPreferenceReads,0,'The owner list must not fetch preferences individually');
        const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);
        assert.equal(overflow,false);
        assert.deepEqual(errors,[]);
        const screenshot=new URL(`private-library-${site}-${viewport.width<500?'mobile':'desktop'}.png`,screenshotDirectory);
        await page.screenshot({path:screenshot.pathname.replace(/^\/([A-Za-z]:)/,'$1'),fullPage:true});
        await context.close();db.close();
    }
} finally {await browser.close();}
console.log('Protected private library browser/SQLite path passed for both areas, desktop/mobile, literal names, full tags, preference changes and lost-response recovery.');
