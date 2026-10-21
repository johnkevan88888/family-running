import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {archiveServiceFixture} from './helpers/private-gallery-service-fixture.mjs';
import {handleAdminRequest} from '../gallery-admin/src/admin-worker.js';
import {reservePrivateGalleryAsset} from '../gallery-admin/src/private-gallery-asset-service.js';
import {reservePrivateGalleryAttempt} from '../gallery-admin/src/private-gallery-attempt-service.js';
import {preparePrivateArchiveIntake,storePrivateArchiveOriginal} from '../gallery-admin/src/private-archive-service.js';
import {readPrivateGalleryRoster} from '../gallery-admin/src/private-gallery-roster-service.js';
import {readPrivateGalleryAssetEligibility} from '../gallery-admin/src/private-gallery-visibility-service.js';
import {readBoundedBytes,sha256Hex} from '../gallery-admin/src/media-byte-verification.js';
import {loadPlaywright,findChromiumExecutable} from '../scripts/browser-runtime.mjs';
import catalogSnapshot from '../gallery-admin/generated/catalog-snapshot.js';

const origin='https://synthetic-batch-library.example';
async function browserFixture(site) {
    const f=await archiveServiceFixture(site,{reserveAttempt:false});
    // The actual admin router owns the current public catalogue. Seed the
    // fictional test person with one identifier it recognizes, before making
    // any consent attempt; no production person, photo or database is changed.
    f.catalog=catalogSnapshot;
    const athleteId=f.catalog.sites[site].catalog.athleteIds.find(id=>!f.catalog.suppressionDocument.hiddenAthleteIds.includes(id));
    f.db.prepare('UPDATE private_gallery_people SET public_athlete_id=? WHERE person_id=?').run(athleteId,f.ids[0]);
    const eligibility=await readPrivateGalleryAssetEligibility(f.env,f.owner,site,f.assetId,f.catalog);
    assert.equal(eligibility.ok,true);
    f.consent={...f.consent,idempotencyKey:crypto.randomUUID(),sourceRevision:f.catalog.sourceRevision,
        suppressionRevision:f.catalog.suppressionRevision,eligibilityRevision:eligibility.revision};
    const attempt=await reservePrivateGalleryAttempt(f.env,f.owner,site,f.assetId,f.consent,f.catalog);
    assert.equal(attempt.ok,true);f.attemptId=attempt.attemptId;return f;
}
async function anotherPhoto(f) {
    const rosterRevision=(await readPrivateGalleryRoster(f.env,f.site)).revision;
    const reserved=await reservePrivateGalleryAsset(f.env,f.owner,f.site,{idempotencyKey:crypto.randomUUID(),rosterRevision,personIds:f.ids,originalFormat:'jpg'});
    assert.equal(reserved.ok,true);const assetId=reserved.asset.assetId;
    assert.equal((await preparePrivateArchiveIntake(f.env,f.owner,f.site,assetId,{rosterRevision,byteCount:f.photo.length,
        sha256:await sha256Hex(f.photo),declaredMimeType:'image/jpeg',privateRetentionConfirmed:true,containsMinors:false,guardianApprovalConfirmed:false})).ok,true);
    assert.equal((await storePrivateArchiveOriginal(f.env,f.owner,f.site,assetId,new Blob([f.photo]).stream(),{
        digestReadable:async body=>sha256Hex(await readBoundedBytes(body,f.photo.length))})).ok,true);
    const eligibility=await readPrivateGalleryAssetEligibility(f.env,f.owner,f.site,assetId,f.catalog);
    const attempt=await reservePrivateGalleryAttempt(f.env,f.owner,f.site,assetId,{...f.consent,idempotencyKey:crypto.randomUUID(),eligibilityRevision:eligibility.revision},f.catalog);
    assert.equal(attempt.ok,true);return {assetId,attemptId:attempt.attemptId};
}
const screenshotDirectory=new URL('../test-artifacts/screenshots/',import.meta.url);await mkdir(screenshotDirectory,{recursive:true});
const {chromium}=loadPlaywright(),browser=await chromium.launch({headless:true,executablePath:findChromiumExecutable()});
try {
    for(const site of ['family','everyone']) for(const viewport of [{width:1440,height:900},{width:390,height:844}]) {
        const f=await browserFixture(site),second=await anotherPhoto(f);
        // D1's real batch is transactional. The shared Node SQLite fixture has
        // only prepared statements; provide its normal atomic test adapter.
        f.env.DB.batch=async statements=>{f.db.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());f.db.exec('COMMIT');return results;}catch(error){f.db.exec('ROLLBACK');throw error;}};
        const env={DB:f.env.DB,PRIVATE_ORIGINALS:f.original,ADMIN_ORIGIN:origin,OWNER_IDENTITIES:`subject:${f.owner.subject}`,SESSION_SECRET:'synthetic-batch-browser-session-secret'};
        const context=await browser.newContext({viewport,isMobile:viewport.width<500}),page=await context.newPage();
        const errors=[],requests=[],responses=[],batchBodies=[];page.on('pageerror',error=>errors.push(error.message));let loseReply=true,showSavedReviewFixture=false;
        await page.route('**/*',async route=>{
            const incoming=route.request();assert.equal(new URL(incoming.url()).origin,origin,'No external browser request');requests.push(incoming.url());
            const headers=await incoming.allHeaders();if(headers.origin===origin)headers['sec-fetch-site']='same-origin';
            const request=new Request(incoming.url(),{method:incoming.method(),headers,body:incoming.method()==='GET'?undefined:incoming.postDataBuffer()});
            const response=await handleAdminRequest(request,env,{verifyAccessIdentity:async()=>f.owner});
            responses.push([incoming.method(),new URL(incoming.url()).pathname,response.status]);
            if(showSavedReviewFixture && incoming.method()==='GET' && new URL(incoming.url()).pathname==='/api/browser/private-batches') {
                // Rendering-only fixture: no consent/review SQL is fabricated.
                // The protected HTTP integration suite separately proves that
                // a real stored review projects this owner-only link.
                const payload=await response.json();payload.batches=payload.batches.map(job=>({...job,state:'running',
                    runReference:'https://github.com/johnkevan88888/family-running/actions/runs/123',
                    reviewUrl:'https://github.com/johnkevan88888/family-running/pull/999'}));
                await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:JSON.stringify(payload)});return;
            }
            if(incoming.method()==='POST'&&new URL(incoming.url()).pathname==='/api/browser/private-batches') {
                batchBodies.push(incoming.postDataJSON());
                if(loseReply&&response.status===201){loseReply=false;await route.fulfill({status:503,contentType:'application/json',body:'{"error":"synthetic-lost-queue-reply"}'});return;}
            }
            await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});
        });
        await page.goto(`${origin}/private-gallery?site=${site}`);
        await page.getByText('Protected intake, consent and owner job preparation ready.',{exact:false}).waitFor();
        const open=async photo=>{
            await page.locator('#private-open-id').fill(photo.assetId);await page.getByRole('button',{name:'Open saved photo',exact:true}).click();
            await page.waitForFunction(()=>!document.getElementById('private-open-form').querySelector('button').disabled);
            assert.match(await page.locator('#private-status').innerText(),/Saved private photo opened\./,JSON.stringify({errors,responses}));
            await page.locator('#private-job-attempt').selectOption(photo.attemptId);
        };
        await open(f);await page.locator('#private-batch-add').click();
        await page.locator('#private-batch-selection-status').filter({hasText:'1 of 20'}).waitFor();
        await page.locator('#private-batch-add').click();await page.getByText('This photo is already selected.',{exact:false}).waitFor();
        await open(second);await page.locator('#private-batch-add').click();
        await page.locator('#private-batch-selection-status').filter({hasText:'2 of 20'}).waitFor();
        await page.locator('#private-batch-confirm').check();
        await page.locator('#private-batch-selection li').nth(1).getByRole('button',{name:'Move earlier'}).click();
        await page.getByText('Unsubmitted selection changed.',{exact:false}).waitFor();
        assert.equal(await page.locator('#private-batch-confirm').isChecked(),false,'Changing ordered membership clears confirmation');
        assert.match(await page.locator('#private-batch-selection li').first().innerText(),new RegExp(second.assetId));
        await page.locator('#private-batch-selection li').first().getByRole('button',{name:'Remove from selection'}).click();
        await page.locator('#private-batch-selection-status').filter({hasText:'1 of 20'}).waitFor();
        await page.locator('#private-batch-add').click();await page.locator('#private-batch-selection-status').filter({hasText:'2 of 20'}).waitFor();
        const before=f.db.prepare('SELECT * FROM private_gallery_attempts ORDER BY attempt_id').all(),calls=f.original.calls.length;
        await page.locator('#private-batch-confirm').check();await page.getByRole('button',{name:'Request combined review job',exact:true}).click();
        await page.getByText('Request stopped.',{exact:false}).waitFor();
        assert.equal(await page.locator('#private-batch-selection li').count(),2,'A lost reply keeps the exact retry selection');
        await page.getByRole('button',{name:'Request combined review job',exact:true}).click();
        await page.getByText('Combined review job saved.',{exact:false}).waitFor();
        assert.deepEqual(batchBodies[0],batchBodies[1],'Uncertain queue creation retries its exact idempotency key and order');
        assert.deepEqual(batchBodies[0].attemptIds,[f.attemptId,second.attemptId]);
        assert.equal(await page.locator('#private-batches .draft-card').count(),1);
        assert.equal(await page.locator('#private-batch-selection li').count(),0);
        assert.equal(await page.locator('#private-batch-confirm').isChecked(),false);
        assert.equal(await page.locator('#private-batches a').getAttribute('href'),'https://github.com/johnkevan88888/family-running/actions/workflows/gallery-archive-job.yml');
        assert.deepEqual(f.db.prepare('SELECT * FROM private_gallery_attempts ORDER BY attempt_id').all(),before,'Batch jobs preserve each consent');
        assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_pipeline_admissions').get().n,0,'No browser processing or publication');
        assert.equal(f.original.calls.length,calls,'No original media I/O');
        assert.equal(await page.locator('select[name="site"],select[name="destination"]').count(),0);
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
        assert.deepEqual(errors,[]);
        showSavedReviewFixture=true;await page.locator('#private-batches-refresh').click();
        await page.getByText('Combined review — review recorded; protected claim retained',{exact:true}).waitFor();
        assert.equal(await page.getByRole('link',{name:'Open the recorded combined review',exact:true}).getAttribute('href'),
            'https://github.com/johnkevan88888/family-running/pull/999');
        await page.locator('#private-batch-heading').scrollIntoViewIfNeeded();
        const screenshot=new URL(`private-batch-${site}-${viewport.width<500?'mobile':'desktop'}.png`,screenshotDirectory);
        await page.screenshot({path:screenshot.pathname.replace(/^\/([A-Za-z]:)/,'$1'),fullPage:true});
        await page.reload();await page.getByText('Protected intake, consent and owner job preparation ready.',{exact:false}).waitFor();
        assert.equal(await page.locator('#private-batch-selection li').count(),0,'Unsubmitted selection never crosses page/owner/area instances');
        await page.locator('#private-batches-refresh').click();await page.locator('#private-batches .draft-card').waitFor();
        assert.equal(await page.locator('#private-batches .draft-card').count(),1,'Saved protected jobs survive reload');
        assert.ok(requests.every(url=>new URL(url).origin===origin));
        await context.close();f.db.close();
    }
} finally {await browser.close();}
console.log('Protected batch browser passed both areas and responsive views: ordered saved attempts, explicit confirmation, duplicate refusal, lost-response replay, private queue isolation and one stored job without media/dispatch/publication.');
