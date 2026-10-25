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
import catalog from '../gallery-admin/generated/catalog-snapshot.js';
import {familyPermission} from '../gallery-admin/src/family-uploader-service.js';
import {createBrowserSession} from '../gallery-admin/src/session.js';
import {parseCsv} from '../scripts/export-bundle-tools.mjs';
import {exportedDateToIso} from '../scripts/build-gallery-admin-catalog.mjs';

// Independently confirm the selected catalogue race is workbook-labelled Official.
const [resultHeaders,...resultRows]=parseCsv((await readFile(new URL('../data/athlete_results.csv',import.meta.url),'utf8')).replace(/^\uFEFF/,''));
const officialJohnRaces=new Set(resultRows.map(row=>Object.fromEntries(resultHeaders.map((name,index)=>[name,row[index]])))
    .filter(row=>row.AthleteID==='john-kevan'&&row.TimeClass==='Official')
    .map(row=>JSON.stringify([exportedDateToIso(row.Date),row.Event,row.Distance])));
const johnRace=catalog.sites.family.resultEntries.find(row=>row.athleteId==='john-kevan'&&
    officialJohnRaces.has(JSON.stringify([row.raceDate,row.raceEvent,row.raceDistance])));
assert.ok(johnRace,'The browser journey requires an exported Official result for John');

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
    const page=await context.newPage(),errors=[],unexpected=[],requests=[];let loseSave=false,losePermission=false;
    page.on('pageerror',error=>errors.push(error.message));
    await context.route('**/*',async route=>{
        const incoming=route.request(),url=new URL(incoming.url());if(url.origin!==origin){unexpected.push(url.href);return route.abort();}
        const headers=await incoming.allHeaders();if(headers.origin===origin)headers['sec-fetch-site']='same-origin';
        const request=new Request(incoming.url(),{method:incoming.method(),headers,body:incoming.method==='GET'?undefined:incoming.postDataBuffer()});
        requests.push([incoming.method(),url.pathname]);
        const response=await handleAdminRequest(request,env,{verifyAccessIdentity:async()=>owner,
            digestReadable:async body=>sha256Hex(await readBoundedBytes(body,26214400))});
        if(losePermission&&incoming.method()==='POST'&&url.pathname==='/api/browser/family-permission'&&response.ok){losePermission=false;return route.fulfill({status:503,contentType:'application/json',body:'{"ok":false}'});}
        if(loseSave&&incoming.method()==='POST'&&/family-drafts\/[0-9a-f-]+$/.test(url.pathname)&&response.ok){loseSave=false;return route.fulfill({status:503,contentType:'application/json',body:'{"ok":false}'});}
        return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
    });
    const idle=()=>page.waitForFunction(()=>!document.getElementById('family-files').disabled);
    const status=text=>page.locator('#family-status').filter({hasText:text}).waitFor();
    try{
        await page.goto(origin+'/family-uploader?site=family');await status('Family library ready');await idle();
        assert.equal(await page.locator('h1').textContent(),'Add Family photos');
        assert.equal(await page.locator('#family-guardian-permission').isChecked(),false,'Guardian scope is never presumed');
        await page.getByRole('button',{name:'Use standing Family permission',exact:true}).click();await status('Standing Family permission saved');await idle();
        assert.match(await page.locator('#family-permission-status').textContent(),/Guardian permission is not included yet/);
        await page.locator('#family-files').setInputFiles(photos.map((buffer,index)=>({name:`synthetic-${index}.jpg`,mimeType:'image/jpeg',buffer})));
        await status('Choose the event and people next');await idle();assert.equal(await page.locator('.family-photo-card').count(),3);
        assert.equal(bucket.objects.size,3,'Adding photos saves the originals before any tags are selected');
        assert.equal(db.prepare('SELECT count(*) n FROM private_archive_intakes').get().n,0,'Private saving does not invent tagged intake evidence');
        assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_attempts').get().n,0,'Private saving never grants public review');
        const id=db.prepare('SELECT draft_id FROM family_gallery_drafts').get().draft_id;
        const uploadCount=requests.filter(([method])=>method==='PUT').length;
        assert.equal(await page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;}),false,
            'Privately saved but untagged photos survive closing the tab');
        await page.reload();await status('Family library ready');await idle();
        await page.locator('#family-drafts').selectOption(id);await page.getByRole('button',{name:'Open batch',exact:true}).click();await status('Saved batch opened');await idle();
        await page.getByRole('button',{name:'Check photo 1',exact:true}).click();await status('Privately saved photo opened');await idle();
        assert.equal(await page.locator('#family-reselect-label').isVisible(),false,'The saved photo opens without a local-file chooser');
        assert.equal(requests.filter(([method])=>method==='PUT').length,uploadCount,'Reopening never uploads again');
        assert.equal(bucket.calls.filter(([method])=>method==='part').length,3);
        const chooseEvent=async race=>{await page.locator('#family-event-search').fill(race.raceEvent);
            const option=await page.locator('#family-event option').allTextContents();
            const label=option.find(text=>text.startsWith(race.raceDate+' · '+race.raceEvent+' · '));
            assert.ok(label);await page.locator('#family-event').selectOption({label});await idle();};
        await chooseEvent(johnRace);
        await page.locator('#family-athlete-search').fill('John Kevan');
        await page.locator('#family-athletes').getByRole('checkbox').check();await status('People saved');await idle();
        const johnDistance=page.getByRole('combobox',{name:'Distance for John Kevan',exact:true});
        assert.equal(await johnDistance.count(),0,'Only the longest Official distance is offered for this runner');
        const firstMetadata=JSON.parse(db.prepare('SELECT metadata_json FROM family_gallery_draft_photos WHERE draft_id=? AND ordinal=0').get(id).metadata_json);
        assert.equal(firstMetadata.runnerResults.length,1);
        assert.deepEqual(catalog.sites.family.catalog.races[firstMetadata.runnerResults[0].raceIndex],{
            raceDate:johnRace.raceDate,raceEvent:johnRace.raceEvent,raceDistance:johnRace.raceDistance
        },'The saved runner selection is the exact exported Official race, including its distance');
        assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_people').get().n,1,'Direct public athlete selection creates one protected association');
        await page.getByRole('button',{name:'Use this event and people on other unchecked photos'}).click();await status('Event and people copied');await idle();
        for(let index=0;index<3;index++){
            await page.getByRole('button',{name:index?'Next photo':'Check photo 1',exact:true}).click();await idle();
            await page.locator('#family-minors').selectOption(index===1?'yes':'no');await idle();
            if(index===1){
                const snapshot=()=>Object.fromEntries(['family_gallery_drafts','family_gallery_draft_photos','family_gallery_saved_files',
                    'private_archive_intakes','private_archive_original_receipts','private_gallery_frame_revisions',
                    'private_gallery_attempts','private_gallery_batch_jobs'].map(table=>[table,db.prepare(`SELECT * FROM ${table}`).all()]));
                const before=snapshot(),objects=structuredClone([...bucket.objects]),calls=bucket.calls.length;
                const prepares=requests.filter(([,path])=>path.endsWith('/prepare')).length;
                const session=await createBrowserSession(owner,env,'family',Date.now());
                const second=db.prepare('SELECT photo_id FROM family_gallery_draft_photos WHERE draft_id=? AND ordinal=1').get(id).photo_id;
                const blocked=await handleAdminRequest(new Request(origin+'/api/browser/family-drafts/'+id+'/prepare?site=family',{
                    method:'POST',headers:{Cookie:session.cookie.split(';')[0],'X-CSRF-Token':session.csrfToken,
                        Origin:origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json'},
                    body:JSON.stringify({photoId:second,permissionVersion:1})}),env,{verifyAccessIdentity:async()=>owner});
                assert.equal(blocked.status,409);assert.equal((await blocked.json()).error,'family-guardian-permission-needed',
                    'Bypassing the client still gets the protected, specific server refusal');
                assert.equal(blocked.headers.get('Cache-Control'),'no-store');
                assert.equal(await page.locator('#family-guardian-needed').isVisible(),true);
                assert.equal(await page.locator('#family-guardian-confirm').isChecked(),false,'Answering Yes is not guardian confirmation');
                assert.equal(await page.locator('#family-guardian-save').isEnabled(),false);
                assert.match(await page.locator('.family-photo-card').nth(1).textContent(),/guardian permission needed/);
                await page.getByRole('button',{name:'Check thumbnails',exact:true}).click();await status('Guardian permission is needed');await idle();
                assert.equal(requests.filter(([,path])=>path.endsWith('/prepare')).length,prepares,'Client stops before adoption, not after a generic error');
                assert.deepEqual(snapshot(),before);assert.equal(bucket.calls.length,calls);
                await page.screenshot({path:fileURLToPath(new URL(`family-guardian-needed-${mobile?'mobile':'desktop'}.png`,screenshots)),fullPage:true});
                await page.locator('#family-guardian-confirm').check();losePermission=true;
                await page.getByRole('button',{name:'Add guardian permission',exact:true}).click();await status('save could not be confirmed');await idle();
                assert.equal(db.prepare('SELECT count(*) n FROM family_gallery_permissions').get().n,2);
                assert.equal(await page.locator('#family-guardian-confirm').isChecked(),true,'Keep the exact uncertain confirmation for retry');
                assert.equal(await page.locator('#family-guardian-confirm').isEnabled(),false);
                await page.getByRole('button',{name:'Add guardian permission',exact:true}).click();await status('Guardian permission saved');await idle();
                assert.equal(db.prepare('SELECT count(*) n FROM family_gallery_permissions').get().n,2,'Retry never creates a third grant');
                assert.match(await page.locator('#family-permission-status').textContent(),/Guardian permission is included/);
                assert.equal(await page.locator('#family-guardian-update').isVisible(),false);
                assert.equal(await page.locator('#family-guardian-needed').isVisible(),false);
                assert.equal(await page.locator('#family-selected').textContent(),'Photo 2','The unfinished photo stays selected');
                assert.equal(await page.locator('#family-minors').inputValue(),'yes','Do not hide the issue by changing the age answer');
                assert.deepEqual(snapshot(),before,'Confirmation keeps the whole batch, tags, intake and saved sibling framing');
                assert.deepEqual(structuredClone([...bucket.objects]),objects);assert.equal(bucket.calls.length,calls);
                assert.equal(requests.filter(([method])=>method==='PUT').length,uploadCount);
                assert.equal(requests.some(([,path])=>path.endsWith('/submit')),false,'Confirmation never submits review');
                assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
            }
            await page.getByRole('button',{name:'Check thumbnails',exact:true}).click();await status('Saved privately. Check');await idle();
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
        assert.equal(bucket.calls.filter(([method])=>method==='part').length,3,'Tagging adopts the saved objects without copying or re-upload');
        assert.equal(db.prepare('SELECT count(*) n FROM family_gallery_permissions').get().n,2,'One initial grant and one explicit scope amendment, not repeated per-photo forms');
        assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_attempts').get().n,0,'Saving thumbnails never queues review');
        await page.screenshot({path:fileURLToPath(new URL(`family-uploader-${mobile?'mobile':'desktop'}.png`,screenshots)),fullPage:true});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'No horizontal overflow');
        await page.reload();await status('Family library ready');await idle();
        await page.locator('#family-drafts').selectOption(id);await page.getByRole('button',{name:'Open batch',exact:true}).click();await status('Saved batch opened');await idle();
        assert.equal(await page.locator('.family-photo-card').count(),3);
        assert.equal(await page.getByRole('button',{name:'Send 3 photos for review',exact:true}).isEnabled(),true,'Saved checked photos can submit without rereading originals');
        await page.getByRole('button',{name:'Send 3 photos for review',exact:true}).click();await status('Batch saved for one combined review');await idle();
        assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_batch_jobs').get().n,1);
        assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_attempts WHERE standing_permission_version=2 AND framing_version=1').get().n,3);
        assert.equal(db.prepare('SELECT count(*) n FROM private_archive_intakes WHERE standing_permission_version=1').get().n,1,
            'First intake keeps its original evidence while fresh review uses the amended permission');
        assert.match(await page.locator('#family-review-status').textContent(),/Automatic processing is not configured/);
        assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_batch_reviews').get().n,0,'No fake live PR success');
        assert.equal(requests.some(([method,path])=>method==='GET'&&path.endsWith('/archive-original')),false);
        // A new draft keeps its stable save key across an uncertain response.
        await page.getByRole('button',{name:'Start a new batch'}).click();await status('New saved Family batch');await idle();loseSave=true;
        assert.equal(await page.locator('#family-review-status').textContent(),'','Old batch progress is not shown for the new draft');
        await page.locator('#family-files').setInputFiles({name:'synthetic-retry.jpg',mimeType:'image/jpeg',buffer:photos[0]});
        await status('The save could not be confirmed');await idle();
        await page.getByRole('button',{name:'Save details',exact:true}).click();await status('Photo details saved.');await idle();
        assert.equal(db.prepare('SELECT count(*) n FROM family_gallery_draft_photos').get().n,4,'Unknown-save retry adds no duplicate card');
        await page.getByRole('button',{name:'Retry private save',exact:true}).click();await status('Photo saved privately.');await idle();
        // An event with different distances shows each eligible runner once.
        const multi=catalog.sites.family.resultEntries.find(r=>r.athleteId==='jack-graham-kevan'&&r.raceEvent==='Sutcliffe & Co Worcester City');
        await chooseEvent(multi);await page.locator('#family-athlete-search').fill('');
        const participantIds=[...new Set(catalog.sites.family.resultEntries.filter(r=>r.raceEvent===multi.raceEvent&&r.raceDate===multi.raceDate).map(r=>r.athleteId))];
        assert.equal(await page.locator('#family-athletes input').count(),participantIds.length);
        assert.equal(await page.locator('#family-athletes').getByRole('checkbox',{name:/John Kevan/}).count(),0,'Non-participant absent from runners');
        await page.locator('#family-athletes').getByRole('checkbox',{name:/Jack Graham-Kevan/}).check();await status('People saved');await idle();
        await page.locator('#family-athletes').getByRole('checkbox',{name:/David Graham-Kevan/}).check();await status('People saved');await idle();
        await page.locator('#family-other-people summary').click();
        await page.locator('#family-private-people').getByRole('checkbox',{name:'John Kevan',exact:true}).check();await status('People saved');await idle();
        const savedCard=db.prepare("SELECT p.photo_id,p.metadata_json FROM family_gallery_draft_photos p JOIN family_gallery_drafts d USING(draft_id) WHERE d.state='editing'").get();
        const mixed=JSON.parse(savedCard.metadata_json);
        assert.equal(mixed.personIds.length,3);assert.equal(mixed.runnerResults.length,2);
        assert.deepEqual(mixed.runnerResults.map(r=>catalog.sites.family.catalog.races[r.raceIndex].raceDistance),['10 km','H. Mar']);
        await page.screenshot({path:fileURLToPath(new URL(`family-event-runners-${mobile?'mobile':'desktop'}.png`,screenshots)),fullPage:true});
        // Official shorter splits are excluded: the runner gets the half marathon.
        const double=catalog.sites.family.resultEntries.find(r=>r.athleteId==='blake-coleman'&&r.raceEvent==='Great Birmingham Run');
        await chooseEvent(double);
        const moved=JSON.parse(db.prepare('SELECT metadata_json FROM family_gallery_draft_photos WHERE photo_id=?').get(savedCard.photo_id).metadata_json);
        assert.deepEqual(moved.personIds,mixed.personIds,'Changing event preserves every tag');assert.deepEqual(moved.runnerResults,[]);
        await page.locator('#family-athletes').getByRole('checkbox',{name:/Blake Coleman/}).check();await status('People saved');await idle();
        const distance=page.getByRole('combobox',{name:'Distance for Blake Coleman',exact:true});
        assert.equal(await distance.count(),0,'Shorter split times are not selectable');
        const longest=JSON.parse(db.prepare('SELECT metadata_json FROM family_gallery_draft_photos WHERE photo_id=?').get(savedCard.photo_id).metadata_json);
        assert.equal(longest.runnerResults.length,1);
        assert.equal(catalog.sites.family.catalog.races[longest.runnerResults[0].raceIndex].raceDistance,'H. Mar');
        await page.locator('#family-minors').selectOption('no');await idle();
        assert.equal(bucket.objects.size,4,'Changing runner selection preserves the saved private original');
        assert.equal(db.prepare('SELECT count(*) n FROM private_archive_original_receipts').get().n,3,'Selecting the race does not grant tagged intake');
        // Simulate another owner tab changing permission while this tab is open.
        assert.equal((await familyPermission(env,owner,'family',{expectedVersion:2,idempotencyKey:crypto.randomUUID(),active:true,guardians:false})).ok,true);
        await page.getByRole('button',{name:'Check saved permission',exact:true}).click();await status('Saved permission checked');await idle();
        assert.equal(await page.locator('#family-guardian-confirm').isChecked(),false,'A fresh confirmation is required after checking current scope');
        assert.equal((await familyPermission(env,owner,'family',{expectedVersion:3,idempotencyKey:crypto.randomUUID(),active:false,guardians:false})).ok,true);
        await page.locator('#family-guardian-confirm').check();
        await page.getByRole('button',{name:'Add guardian permission',exact:true}).click();await status('Family permission changed');await idle();
        assert.equal(db.prepare('SELECT count(*) n FROM family_gallery_permissions').get().n,4,'A stale tab cannot overwrite withdrawal');
        await page.getByRole('button',{name:'Check saved permission',exact:true}).click();await status('Saved permission checked');await idle();
        assert.equal(await page.locator('#family-permission-setup').isVisible(),true);
        assert.equal(await page.locator('#family-guardian-update').isVisible(),false);
        assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_current_attempt_permissions').get().n,0,'Old reviews are not renewed or rewritten by policy changes');
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
        assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    }catch(error){await page.screenshot({path:fileURLToPath(new URL(`family-uploader-failure-${mobile?'mobile':'desktop'}.png`,screenshots)),fullPage:true});
        console.error('Local synthetic UI status:',await page.locator('#family-status').textContent(),errors);throw error;
    }finally{await context.close();db.close();}
}}finally{await browser.close();}
console.log('PASS Family uploader desktop/mobile: synthetic face detection, manual zoom, mixed adult/minor saved batch, explicit guardian confirmation, lost-reply and stale-tab recovery preserving originals/tags/framing, one local review request; no external requests or publication.');
