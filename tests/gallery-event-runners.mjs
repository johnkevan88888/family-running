import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {familyUploaderFixture} from './helpers/family-uploader-fixture.mjs';
import {archiveServiceFixture} from './helpers/private-gallery-service-fixture.mjs';
import {resolveFamilyAthlete,saveFamilyDraft,readFamilyDrafts} from '../gallery-admin/src/family-uploader-service.js';
import {checkPhotoRaceResults} from '../gallery-admin/src/photo-event-results.js';
import {readArchivePhotoAttempt} from '../gallery-admin/src/private-gallery-photo-lifecycle.js';
import {issueArchiveServiceAuthority} from '../gallery-admin/src/private-gallery-service-authority.js';
import {changePrivateGalleryVisibility} from '../gallery-admin/src/private-gallery-visibility-service.js';
import galleryContract from '../gallery-contract.js';
import {privateGalleryJobFixture} from './helpers/private-gallery-job-fixture.mjs';
import {syntheticGitHub} from './helpers/private-gallery-lifecycle-fixtures.mjs';
import {runProtectedArchiveJob} from '../scripts/gallery-media/protected-archive-job.mjs';

let checks=0;
{
    const f=await archiveServiceFixture('family',{migrationThrough:32});
    try {
        const old=f.db.prepare('SELECT * FROM private_gallery_attempts').get();
        f.db.exec(await readFile(new URL('../gallery-admin/migrations/0033_photo_event_results.sql',import.meta.url),'utf8'));
        const {race_results_json,...after}=f.db.prepare('SELECT * FROM private_gallery_attempts').get();
        assert.deepEqual(after,{...old});assert.equal(race_results_json,null);
        assert.equal((await readArchivePhotoAttempt(f.env,f.owner,f.site,f.attemptId,f.catalog)).attempt_id,f.attemptId);
        checks+=3;
    } finally {f.db.close();}
}
{
    const f=await familyUploaderFixture({count:2});
    try {
        const site=f.catalog.sites.family,base=site.catalog.races[0];
        site.catalog.races.push({...base,raceDistance:'10 km'}, {...base,raceDate:'2026-01-02'}, {...base,raceEvent:'Another event'});
        site.resultEntries=[{athleteId:'fixture-public',...base},{athleteId:'fixture-new',...site.catalog.races[1]}];
        const person=await resolveFamilyAthlete(f.env,f.owner,'family',{athleteId:'fixture-new',idempotencyKey:crypto.randomUUID(),permissionVersion:1},f.catalog);
        assert.equal(person.ok,true);
        const savedBefore=f.db.prepare('SELECT * FROM family_gallery_draft_photos ORDER BY ordinal').all();
        const legacy=await saveFamilyDraft(f.env,f.owner,f.site,f.draft.id,{expectedVersion:1,idempotencyKey:crypto.randomUUID(),photos:f.photos},f.catalog);
        assert.equal(legacy.ok,true);assert.deepEqual(f.db.prepare('SELECT * FROM family_gallery_draft_photos ORDER BY ordinal').all(),savedBefore);
        const photo={...f.photos[0],personIds:[f.ids[0],person.personId,f.ids[1]],runnerResults:[
            {personId:f.ids[0],raceIndex:0},{personId:person.personId,raceIndex:1}]};
        const save=async photos=>saveFamilyDraft(f.env,f.owner,f.site,f.draft.id,{expectedVersion:2,idempotencyKey:crypto.randomUUID(),photos},f.catalog);
        assert.equal((await save([{...photo,sourceRevision:'sha256:'+'c'.repeat(64)},f.photos[1]])).ok,false,'Stale browser indices cannot select current results');
        const newer=structuredClone(f.catalog);newer.sourceRevision='sha256:'+'d'.repeat(64);
        assert.equal((await saveFamilyDraft(f.env,f.owner,f.site,f.draft.id,{expectedVersion:2,idempotencyKey:crypto.randomUUID(),photos:f.photos},newer)).ok,false,'Old browser cannot reinterpret saved legacy indices');
        for(const changed of [
            [{personId:f.ids[0],raceIndex:1}], // did not run that distance
            [{personId:f.ids[0],raceIndex:2}], // wrong date
            [{personId:f.ids[0],raceIndex:3}], // wrong event
            [{personId:f.ids[1],raceIndex:0}], // private supporter has no public result
            [photo.runnerResults[0],photo.runnerResults[0]],
            [{...photo.runnerResults[0],athleteId:'fixture-new'}],
            [{personId:'person_00000000-0000-4000-8000-000000000099',raceIndex:0}]
        ]) {assert.equal((await save([{...photo,runnerResults:changed},f.photos[1]])).ok,false);checks++;}
        assert.deepEqual(f.db.prepare('SELECT * FROM family_gallery_draft_photos ORDER BY ordinal').all(),savedBefore,'Rejected edits preserve the saved batch');
        assert.equal((await save([photo,f.photos[1]])).ok,true);
        f.photos[0]=photo;f.submitInput.expectedVersion=3;
        const reopened=await readFamilyDrafts(f.env,f.owner,f.site,f.draft.id);
        assert.deepEqual(reopened.draft.photos[0].runnerResults,photo.runnerResults);
        assert.equal(Object.hasOwn(reopened.draft.photos[1],'runnerResults'),false,'Untouched sibling keeps legacy shape');
        for(let index=0;index<2;index++)await f.frame(index);
        assert.equal((await f.submit()).ok,true);
        const attempts=f.db.prepare('SELECT a.* FROM private_gallery_attempts a JOIN family_gallery_draft_photos p ON p.attempt_id=a.attempt_id ORDER BY p.ordinal').all();
        const expected=[{athleteId:'fixture-public',raceDistance:'5 km'},{athleteId:'fixture-new',raceDistance:'10 km'}];
        assert.deepEqual(JSON.parse(attempts[0].race_results_json),expected);
        assert.equal(attempts[1].race_results_json,null);
        assert.equal(JSON.parse(attempts[0].person_ids_json).length,3,'Complete supporter tag survives public result projection');
        assert.throws(()=>f.db.prepare('UPDATE private_gallery_attempts SET race_results_json=? WHERE attempt_id=?').run('[]',attempts[0].attempt_id),/immutable/);
        assert.equal((await readArchivePhotoAttempt(f.env,f.owner,f.site,attempts[0].attempt_id,f.catalog)).attempt_id,attempts[0].attempt_id);
        const service={type:'service',subject:'a'.repeat(32)+'.access'};f.env.ARCHIVE_SERVICE_IDENTITY='subject:'+service.subject;
        const authority=await issueArchiveServiceAuthority(f.env,service,f.site,attempts[0].attempt_id,'processing');
        await readArchivePhotoAttempt(f.env,authority,f.site,attempts[0].attempt_id,f.catalog);
        const changed=structuredClone(f.catalog);changed.sites.family.resultEntries.pop();
        await assert.rejects(readArchivePhotoAttempt(f.env,authority,f.site,attempts[0].attempt_id,changed));
        await assert.rejects(readArchivePhotoAttempt(f.env,f.owner,f.site,attempts[0].attempt_id,changed));
        f.attemptId=attempts[0].attempt_id;
        const clients=await privateGalleryJobFixture(f),github=syntheticGitHub();
        const execute=phase=>runProtectedArchiveJob({jobId:f.jobId,runReference:'https://github.com/johnkevan88888/family-running/actions/runs/656',phase,
            ...clients,jobs:clients.jobs[phase==='verify'?'finalizer':'promotion'],github});
        const review=await execute('review');assert.equal(review.state,'unmerged-review',JSON.stringify(review));
        const intent=JSON.parse(f.db.prepare('SELECT candidate_json FROM private_gallery_batch_intents').get().candidate_json);
        const candidate=JSON.parse(intent.manifestText);assert.deepEqual(candidate.items[0].raceResults,expected);
        assert.equal(Object.hasOwn(candidate.items[1],'raceResults'),false);
        assert.equal(intent.manifestText.includes('person_'),false,'Private identities never leak through result selection');
        assert.equal(github.state.pulls.length,1);assert.equal(github.state.pulls[0].state,'open');assert.equal(github.state.manifests.family.items.length,0);
        assert.equal((await changePrivateGalleryVisibility(f.env,f.owner,f.site,f.ids[1],{expectedVersion:2,idempotencyKey:crypto.randomUUID(),preference:'hidden'})).ok,true);
        await assert.rejects(readArchivePhotoAttempt(f.env,authority,f.site,attempts[0].attempt_id,f.catalog),'Hidden supporter still blocks entire photo');
        await execute('reconcile');assert.equal((await execute('verify')).state,'host-ready');assert.equal((await execute('reconcile')).state,'removed');
        assert.ok(f.hostRequests.length>0,'Derivative storage cleanup cannot replace independent public-host proof');
        assert.equal(f.db.prepare('SELECT count(*) n FROM private_archive_original_receipts').get().n,3,'Originals retained');
        assert.equal(f.db.prepare('SELECT race_results_json FROM private_gallery_attempts WHERE attempt_id=?').get(attempts[0].attempt_id).race_results_json,attempts[0].race_results_json);
        assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);checks+=19;
    } finally {f.db.close();}
}
const item={id:'photo-fixture',type:'photo',title:'Photo',caption:'',alt:'Synthetic photo',raceDate:'2026-01-01',raceEvent:'Fixture',raceDistance:'5 km',
    athleteIds:['runner-one','runner-two','supporter'],sourceUrl:'https://synthetic.example/photo.webp',thumbnailUrl:'https://synthetic.example/thumb.webp',featured:false,
    raceResults:[{athleteId:'runner-one',raceDistance:'5 km'},{athleteId:'runner-two',raceDistance:'10 km'}]};
assert.deepEqual(galleryContract.validateGalleryDocument({schemaVersion:'1.0',items:[item]}),[]);
for(const raceResults of [null,{},[...item.raceResults,item.raceResults[0]],[{athleteId:'stranger',raceDistance:'5 km'}],
    [{...item.raceResults[0],time:'invented'}],[{...item.raceResults[0],personId:'private'}],[{...item.raceResults[0],raceDistance:''}]]) {
    assert.ok(galleryContract.validateGalleryDocument({schemaVersion:'1.0',items:[{...item,raceResults}]}).length);checks++;
}
assert.ok(galleryContract.validateGalleryDocument({schemaVersion:'1.0',items:[{...item,type:'video'}]}).length);
assert.throws(()=>checkPhotoRaceResults(item.raceResults,item,item.athleteIds,{resultEntries:[]}));
console.log('PASS multi-distance/event-runner checks: immutable legacy compatibility, saved batch preservation, exact event/date/runner/distance, complete private tags, protected processing/review/removal and malformed public projections.');
