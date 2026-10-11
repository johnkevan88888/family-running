import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {readPrivateGalleryRoster} from '../gallery-admin/src/private-gallery-roster-service.js';
import {reservePrivateGalleryAsset,readPrivateGalleryAsset} from '../gallery-admin/src/private-gallery-asset-service.js';
import {createPrivateGalleryPerson,readPrivateGalleryVisibility,readPrivateGalleryPreferences,changePrivateGalleryVisibility,
    readPrivateGalleryAssetEligibility} from '../gallery-admin/src/private-gallery-visibility-service.js';
import {handleAdminRequest} from '../gallery-admin/src/admin-worker.js';

const db = new DatabaseSync(':memory:');
const directory = new URL('../gallery-admin/migrations/',import.meta.url);
for (const file of (await readdir(directory)).filter(name=>name.endsWith('.sql')).sort()) db.exec(await readFile(new URL(file,directory),'utf8'));
const owner = {type:'browser',subject:'synthetic-owner'};
let beforeWrite,afterWrite;
const env = {ADMIN_ORIGIN:'https://synthetic-private-library.example',OWNER_IDENTITIES:'subject:synthetic-owner',
    AUTOMATION_IDENTITIES:'subject:synthetic-service',SESSION_SECRET:'synthetic-only-private-library-session-secret',
    DB:{prepare(sql){let values=[];return {sql,get values(){return values;},bind(...bindings){values=bindings;return this;},
        async first(){return db.prepare(sql).get(...values) ?? null;},
        async all(){return {success:true,results:db.prepare(sql).all(...values)};},
        async run(){beforeWrite?.(sql);const result=db.prepare(sql).run(...values);afterWrite?.(sql);return {success:true,meta:{changes:Number(result.changes)}};}};},
        async batch(statements){db.exec('BEGIN');try{const result=[];for(const statement of statements)result.push(await statement.run());db.exec('COMMIT');return result;}
            catch(error){db.exec('ROLLBACK');throw error;}}}};
const catalog = {sourceRevision:'synthetic-source-v1',suppressionRevision:'synthetic-suppression-v1',
    suppressionDocument:{schemaVersion:'1.0',hiddenAthleteIds:[]},sites:{family:{catalog:{athleteIds:['synthetic-public']}},everyone:{catalog:{athleteIds:[]}}}};
const roster = async()=>readPrivateGalleryRoster(env,'family');
async function person(name,publicId=null){return createPrivateGalleryPerson(env,owner,'family',{idempotencyKey:crypto.randomUUID(),
    rosterRevision:(await roster()).revision,displayName:name,publicAthleteId:publicId},catalog);}
const firstInput = {idempotencyKey:crypto.randomUUID(),rosterRevision:(await roster()).revision,
    displayName:'Synthetic Public Runner',publicAthleteId:'synthetic-public'};
const first = await createPrivateGalleryPerson(env,owner,'family',firstInput,catalog);
assert.equal(first.status,201,JSON.stringify(first));
assert.equal((await createPrivateGalleryPerson(env,owner,'family',firstInput,catalog)).replayed,true);
assert.equal((await createPrivateGalleryPerson(env,owner,'family',{...firstInput,displayName:'Different'},catalog)).status,409);
const second = await person('Synthetic Private Runner <not markup>');
assert.equal(second.status,201,JSON.stringify(second));
const ids = [first.personId,second.personId];
for(const change of [{publicAthleteId:'unknown'},{displayName:'bad\nname'},{displayName:''},{siteMode:'everyone'},
    {personId:first.personId},{displayName:'x'.repeat(201)}]) {
    assert.equal((await createPrivateGalleryPerson(env,owner,'family',{...firstInput,idempotencyKey:crypto.randomUUID(),...change},catalog)).status,422);
}
assert.equal((await createPrivateGalleryPerson(env,owner,'everyone',firstInput,catalog)).status,422);
assert.equal((await createPrivateGalleryPerson(env,{type:'service',subject:owner.subject},'family',firstInput,catalog)).status,403);
assert.equal((await readPrivateGalleryVisibility(env,owner,'family',ids[0])).preference,'hidden');
const asset = await reservePrivateGalleryAsset(env,owner,'family',{idempotencyKey:crypto.randomUUID(),originalFormat:'jpg',
    personIds:ids,rosterRevision:(await roster()).revision});
assert.equal(asset.status,201);
const eligible = async()=>readPrivateGalleryAssetEligibility(env,owner,'family',asset.asset.assetId,catalog);
assert.equal((await eligible()).visibilityEligible,false);
assert.deepEqual((await eligible()).publicAthleteIds,['synthetic-public']);
async function change(id,preference,input){const current=await readPrivateGalleryVisibility(env,owner,'family',id);
    return changePrivateGalleryVisibility(env,owner,'family',id,input ?? {expectedVersion:current.version,idempotencyKey:crypto.randomUUID(),preference});}
assert.equal((await change(ids[0],'allowed')).version,2);
assert.equal((await eligible()).visibilityEligible,false,'Second person still blocks whole photo');
assert.equal((await change(ids[1],'allowed')).version,2);
const allowed=await eligible();
assert.equal(allowed.visibilityEligible,true);
assert.equal(allowed.requiresFreshPublicConsent,true);
assert.equal(allowed.publicationEnabled,false);
assert.equal(JSON.stringify(allowed).includes('Synthetic'),false);
assert.equal(JSON.stringify(allowed).includes('person_'),false);
const hideInput={expectedVersion:2,idempotencyKey:crypto.randomUUID(),preference:'hidden'};
assert.equal((await change(ids[1],'hidden',hideInput)).version,3);
assert.equal((await eligible()).visibilityEligible,false);
assert.deepEqual((await readPrivateGalleryAsset(env,owner,'family',asset.asset.assetId)).asset.personIds,ids);
assert.equal((await change(ids[1],'hidden',hideInput)).replayed,true);
assert.equal((await change(ids[1],'allowed')).version,4);
assert.equal((await eligible()).visibilityEligible,true);
assert.notEqual((await eligible()).revision,allowed.revision,'Hide/allow ABA invalidates an older review');
assert.equal((await change(ids[1],'hidden',hideInput)).status,409,'Old replay cannot claim current success');
catalog.suppressionDocument.hiddenAthleteIds=['synthetic-public'];
assert.equal((await eligible()).visibilityEligible,false,'Private allow cannot override public suppression');
catalog.suppressionDocument.hiddenAthleteIds=[];
db.prepare(`INSERT INTO pending_athlete_exclusions
    (athlete_id,exclusion_revision,expected_suppression_revision,request_audit_hash,actor_identity_hash,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`).run('synthetic-public','synthetic-exclusion','synthetic-suppression-v1','a'.repeat(64),'b'.repeat(64),
        '2026-10-01T15:00:00.000Z','2026-10-01T15:00:00.000Z');
assert.equal((await eligible()).visibilityEligible,false,'Private allow never overrides an unresolved public exclusion');
// Use the existing exclusion schema only through its full established service
// in cross-layer tests; suppression validity and unknown mappings fail here.
catalog.suppressionDocument=null;
assert.equal((await eligible()).status,503);
catalog.suppressionDocument={schemaVersion:'1.0',hiddenAthleteIds:[]};
catalog.sites.family.catalog.athleteIds=[];
assert.equal((await eligible()).status,409);
catalog.sites.family.catalog.athleteIds=['synthetic-public'];
const third=await person('Synthetic Revision Race');
beforeWrite=sql=>{if(sql.includes('INSERT INTO private_gallery_visibility_events')){
    beforeWrite=undefined;db.prepare('UPDATE private_gallery_people SET display_name=? WHERE person_id=?').run('Synthetic Changed',third.personId);}};
assert.equal((await change(third.personId,'allowed')).status,409);
assert.equal((await readPrivateGalleryVisibility(env,owner,'family',third.personId)).version,1);
afterWrite=sql=>{if(sql.includes('INSERT INTO private_gallery_visibility_events')){afterWrite=undefined;throw new Error('Synthetic lost reply');}};
const lost=await change(third.personId,'allowed');
assert.equal(lost.version,2);assert.equal(lost.replayed,true);
const generation=db.prepare('SELECT generation FROM private_gallery_roster_version').get().generation;
assert.throws(()=>db.prepare(`INSERT INTO private_gallery_visibility_events
    (person_id,version,preference,idempotency_key,actor_identity_hash,request_hash,site_mode,roster_generation)
    VALUES (?,3,'allowed',?,NULL,?,'family',?)`).run(third.personId,crypto.randomUUID(),'a'.repeat(64),generation),
    'SQLite NULL semantics cannot admit an unaudited allowed event');
const shared='person_00000000-0000-4000-8000-000000000099';
db.prepare('INSERT INTO private_gallery_people VALUES (?,?,NULL,1,1)').run(shared,'Synthetic Shared Person');
assert.equal((await changePrivateGalleryVisibility(env,owner,'everyone',shared,{expectedVersion:1,idempotencyKey:crypto.randomUUID(),preference:'allowed'})).version,2);
assert.equal((await readPrivateGalleryVisibility(env,owner,'family',shared)).preference,'allowed','A shared person has one global Gallery preference');
assert.equal((await change(shared,'hidden')).version,3);
assert.equal((await readPrivateGalleryVisibility(env,owner,'everyone',shared)).preference,'hidden','Hide cannot leave the other Gallery area allowed');
const familyPreferences=await readPrivateGalleryPreferences(env,owner,'family');
const everyonePreferences=await readPrivateGalleryPreferences(env,owner,'everyone');
assert.equal(familyPreferences.ok,true);assert.equal(everyonePreferences.ok,true);
assert.deepEqual(everyonePreferences.people.map(person=>person.personId),[shared]);
assert.equal(everyonePreferences.people[0].preference,'hidden');
assert.equal((await readPrivateGalleryPreferences(env,{type:'service',subject:owner.subject},'family')).status,403);
for(const corrupt of ['missing','invalid']) {
    const corruptEnv={...env,DB:{...env.DB,prepare(sql){
        if(sql.includes('FROM private_gallery_people p LEFT JOIN private_gallery_current_visibility')) return {async all(){
            const rows=db.prepare(sql).all();
            if(corrupt==='missing')rows.pop();else rows[rows.length-1].preference='invalid';
            return {success:true,results:rows};
        }};
        return env.DB.prepare(sql);
    }}};
    assert.equal((await readPrivateGalleryPreferences(corruptEnv,owner,'everyone')).status,503,
        'A missing or malformed whole-roster preference denies the inherited-area response');
}
assert.throws(()=>db.exec('UPDATE private_gallery_visibility_events SET preference = \'allowed\''));
assert.throws(()=>db.exec('DELETE FROM private_gallery_visibility_events'));
assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);

// Real owner/session/area/CSRF boundary: no private service accepts automation.
const now=Date.UTC(2026,9,1,15);
const request=(path,options={})=>new Request(env.ADMIN_ORIGIN+path,options);
const handle=(req,identity=owner)=>handleAdminRequest(req,env,{verifyAccessIdentity:async()=>identity,now:()=>now});
const sessionResponse=await handle(request('/api/browser/session?site=family'));
const {csrfToken}=await sessionResponse.json();
const cookie=sessionResponse.headers.get('set-cookie').split(';')[0];
const path='/api/browser/private-people/'+ids[0]+'/visibility?site=family';
for(const headers of [{},{Cookie:cookie},{Cookie:cookie,'X-CSRF-Token':csrfToken},
    {Cookie:cookie,'X-CSRF-Token':csrfToken,Origin:env.ADMIN_ORIGIN,'Sec-Fetch-Site':'cross-site'}]) {
    assert.equal((await handle(request(path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(hideInput)}))).status,403);
}
assert.equal((await handle(request(path,{headers:{Cookie:cookie}}))).status,200);
assert.equal((await handle(request('/api/browser/private-preferences?site=family',{headers:{Cookie:cookie}}))).status,200);
assert.equal((await handle(request('/api/browser/private-preferences?site=family'))).status,403);
assert.equal((await handle(request(path.replace('family','everyone'),{headers:{Cookie:cookie}}))).status,403);
assert.equal((await handle(request('/private-gallery?site=family'),{type:'service',subject:'synthetic-service'})).status,403);
assert.equal((await handle(request('/private-gallery?site=family'))).status,200);
assert.equal((await handle(request('/private-gallery?site=family&destination=everyone'))).status,404);
assert.equal((await handle(request('/private-gallery.js'))).status,200);
console.log('Private person creation, complete-tag projection, revisioned hide/allow and protected routes passed.');
