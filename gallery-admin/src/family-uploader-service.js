import {hashIdentity} from './session.js';
import {sha256Hex} from './media-byte-verification.js';
import {requireFamilyPermission} from './family-permission.js';
import {loadPrivateGalleryRoster} from './private-gallery-roster-service.js';
import {resolvePrivateGalleryTags} from './private-gallery-roster.js';
import {reservePrivateGalleryAsset} from './private-gallery-asset-service.js';
import {readPrivateGalleryAssetEligibility} from './private-gallery-visibility-service.js';
import {preparePrivateArchiveIntake} from './private-archive-service.js';
import {readPrivateGalleryFraming} from './private-gallery-framing-service.js';
import {reservePrivateGalleryAttempt} from './private-gallery-attempt-service.js';
import {queuePrivateArchiveBatch,readPrivateArchiveBatches} from './private-gallery-batch-service.js';
import {dispatchFamilyReview} from './family-review-dispatch.js';
import {projectFamilyRunnerResults} from './photo-event-results.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha=/^[0-9a-f]{64}$/;
const first=(env,sql,...args)=>env.DB.prepare(sql).bind(...args).first();
const statement=(env,sql,...args)=>env.DB.prepare(sql).bind(...args);
const digest=value=>sha256Hex(new TextEncoder().encode(JSON.stringify(value)));
const exact=(value,keys)=>value && typeof value==='object' && !Array.isArray(value) &&
    Object.keys(value).sort().join('|')===[...keys].sort().join('|');
const failure=(status=409,code='family-draft-changed')=>({ok:false,status,code});
async function rows(env,sql,...args) {
    const result=await statement(env,sql,...args).all();
    if(result?.success!==true || !Array.isArray(result.results)) throw new Error('Unavailable');
    return result.results;
}
async function write(env,sql,...args) {
    const result=await statement(env,sql,...args).run();
    if(result?.success!==true) throw new Error('Unavailable');
    return result.meta?.changes;
}
async function batch(env,statements) {
    const result=await env.DB.batch(statements);
    if(!Array.isArray(result)||result.length!==statements.length||result.some(value=>value?.success!==true)) throw new Error('Unavailable');
}
const safeContext=(identity,site)=>site==='family' && identity?.type==='browser' && typeof identity.subject==='string' && identity.subject.trim();

export async function familyPermission(env,identity,site,input) {
    if(!safeContext(identity,site)) return failure(403);
    const owner=await hashIdentity(identity);
    const current=()=>first(env,'SELECT * FROM family_gallery_current_permission WHERE owner_hash=?1',owner);
    const summary=row=>({ok:true,status:200,version:row?.version??0,active:row?.active===1,guardians:row?.guardians===1});
    if(input===undefined) return summary(await current());
    if(!exact(input,['expectedVersion','idempotencyKey','active','guardians']) || !uuid.test(input.idempotencyKey) ||
        !Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0 || typeof input.active!=='boolean' ||
        typeof input.guardians!=='boolean' || input.guardians && !input.active) return failure(422);
    const hash=await digest([owner,input.expectedVersion,input.active,input.guardians]);
    const prior=()=>first(env,'SELECT * FROM family_gallery_permissions WHERE idempotency_key=?1',input.idempotencyKey);
    let saved=await prior();
    if(!saved) {
        try { await write(env,`INSERT INTO family_gallery_permissions(owner_hash,version,active,guardians,idempotency_key,request_hash)
            VALUES(?1,?2,?3,?4,?5,?6)`,owner,input.expectedVersion+1,Number(input.active),Number(input.guardians),input.idempotencyKey,hash); }
        catch { if(!await prior()) return failure(); }
        saved=await prior();
    }
    const latest=await current();
    return saved?.owner_hash===owner && saved.request_hash===hash && latest?.version===saved.version ? summary(latest):failure();
}

export async function familyPhotoPermission(env,identity,site,input) {
    if(!safeContext(identity,site)) return failure(403);
    if(!exact(input,['assetId','expectedVersion','idempotencyKey','preference']) || !uuid.test(input.idempotencyKey) ||
        !Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0||!['allowed','hidden'].includes(input.preference)) return failure(422);
    const owner=await hashIdentity(identity),hash=await digest([input.assetId,input.expectedVersion,input.preference]);
    const owned=await first(env,"SELECT 1 FROM private_gallery_assets WHERE asset_id=?1 AND owner_identity_hash=?2 AND site_mode='family'",input.assetId,owner);
    if(!owned)return failure(404);
    const find=()=>first(env,'SELECT * FROM family_gallery_photo_permissions WHERE idempotency_key=?1',input.idempotencyKey);
    let saved=await find();
    if(!saved){try{await write(env,`INSERT INTO family_gallery_photo_permissions(asset_id,version,preference,owner_hash,idempotency_key,request_hash)
        VALUES(?1,?2,?3,?4,?5,?6)`,input.assetId,input.expectedVersion+1,input.preference,owner,input.idempotencyKey,hash);}
        catch{if(!await find())return failure();}saved=await find();}
    const latest=await first(env,'SELECT * FROM family_gallery_current_photo_permission WHERE asset_id=?1',input.assetId);
    if(saved?.owner_hash!==owner||saved.asset_id!==input.assetId||saved.request_hash!==hash||latest?.version!==saved.version)return failure();
    return {ok:true,status:200,version:latest.version,preference:latest.preference,removalVerified:false,publicationEnabled:false};
}

// Select by stable public ID, never by name. Existing hidden people stay hidden.
export async function resolveFamilyAthlete(env,identity,site,input,catalog) {
    if(!safeContext(identity,site)) return failure(403);
    if(!exact(input,['athleteId','idempotencyKey','permissionVersion']) || !uuid.test(input.idempotencyKey)) return failure(422);
    const owner=await hashIdentity(identity);
    await requireFamilyPermission(env,owner,site,input.permissionVersion,false);
    const athlete=catalog?.sites?.family?.rosterEntries?.find(value=>value.athleteId===input.athleteId);
    if(!athlete || typeof athlete.participant!=='string') return failure(422);
    const find=()=>first(env,`SELECT p.*,v.preference,v.version FROM private_gallery_people p
        JOIN private_gallery_current_visibility v USING(person_id) WHERE p.public_athlete_id=?1`,athlete.athleteId);
    let saved=await find();
    if(!saved) {
        const {generation}=await loadPrivateGalleryRoster(env,site),person=`person_${input.idempotencyKey}`;
        const hash=await digest(['family-athlete-v1',owner,athlete.athleteId,input.permissionVersion]);
        try { await batch(env,[
            statement(env,`INSERT INTO private_gallery_person_requests(idempotency_key,person_id,actor_identity_hash,request_hash,roster_generation)
                VALUES(?1,?2,?3,?4,?5)`,input.idempotencyKey,person,owner,hash,generation),
            statement(env,'INSERT INTO private_gallery_people(person_id,display_name,public_athlete_id,family,everyone) VALUES(?1,?2,?3,1,0)',person,athlete.participant,athlete.athleteId),
            statement(env,`INSERT INTO private_gallery_visibility_events(person_id,version,preference,idempotency_key,actor_identity_hash,request_hash,site_mode,roster_generation)
                VALUES(?1,2,'allowed',?2,?3,?4,'family',?5)`,person,`family:${input.idempotencyKey}`,owner,hash,generation+1)
        ]); } catch { if(!await find()) return failure(); }
        saved=await find();
    }
    if(saved?.family!==1) return failure(409,'family-athlete-needs-owner-link');
    return {ok:true,status:200,personId:saved.person_id,displayName:saved.display_name,preference:saved.preference};
}

async function storedDraft(env,owner,id) {
    if(!uuid.test(id||'')) throw new Error('Invalid draft');
    const draft=await first(env,'SELECT * FROM family_gallery_drafts WHERE draft_id=?1 AND owner_hash=?2',id,owner);
    if(!draft) throw new Error('Draft unavailable');
    const photos=await rows(env,`SELECT p.*,o.asset_id AS retained,
        EXISTS(SELECT 1 FROM private_archive_deletion_requests x WHERE x.asset_id=p.asset_id) AS deleted,
        (SELECT max(version) FROM private_gallery_frame_revisions f WHERE f.asset_id=p.asset_id) AS framing_version,
        (SELECT version FROM family_gallery_current_photo_permission f WHERE f.asset_id=p.asset_id) AS preference_version,
        (SELECT preference FROM family_gallery_current_photo_permission f WHERE f.asset_id=p.asset_id) AS preference,
        EXISTS(SELECT 1 FROM json_each(p.metadata_json,'$.personIds') j
            LEFT JOIN private_gallery_people person ON person.person_id=j.value
            LEFT JOIN private_gallery_current_visibility v ON v.person_id=j.value
            WHERE person.person_id IS NULL OR person.family!=1 OR v.preference IS NOT 'allowed'
                OR EXISTS(SELECT 1 FROM pending_athlete_exclusions e WHERE e.athlete_id=person.public_athlete_id AND e.resolved_at IS NULL)) AS people_blocked
        FROM family_gallery_draft_photos p LEFT JOIN private_archive_original_receipts o ON o.asset_id=p.asset_id
        WHERE p.draft_id=?1 ORDER BY p.ordinal LIMIT 21`,id);
    if(photos.length>20) throw new Error('Oversized draft');
    return {...draft,photos};
}
function publicDraft(draft) {
    return {ok:true,status:200,draft:{id:draft.draft_id,version:draft.version,state:draft.state,
        jobId:draft.job_id,photos:draft.photos.map(row=>({photoId:row.photo_id,...JSON.parse(row.metadata_json),
            assetId:row.asset_id,reserved:Boolean(row.reservation_json),retained:Boolean(row.retained),deleted:row.deleted===1,
            framingVersion:row.framing_version??0,preferenceVersion:row.preference_version??0,
            preference:row.preference??'allowed',peopleBlocked:row.people_blocked===1}))},publicationEnabled:false};
}
export async function readFamilyDrafts(env,identity,site,id) {
    if(!safeContext(identity,site)) return failure(403);
    const owner=await hashIdentity(identity);
    if(id) return publicDraft(await storedDraft(env,owner,id));
    const drafts=await rows(env,`SELECT d.draft_id,d.state,d.created_at,count(p.photo_id) AS photo_count FROM family_gallery_drafts d
        LEFT JOIN family_gallery_draft_photos p USING(draft_id) WHERE d.owner_hash=?1 GROUP BY d.draft_id
        ORDER BY d.created_at DESC,d.draft_id LIMIT 100`,owner);
    return {ok:true,status:200,drafts:drafts.map(row=>({id:row.draft_id,state:row.state,createdAt:row.created_at,count:row.photo_count}))};
}
export async function createFamilyDraft(env,identity,site,input) {
    if(!safeContext(identity,site)) return failure(403);
    if(!exact(input,['idempotencyKey'])||!uuid.test(input.idempotencyKey)) return failure(422);
    const owner=await hashIdentity(identity);
    try {await write(env,'INSERT INTO family_gallery_drafts(draft_id,owner_hash) VALUES(?1,?2)',input.idempotencyKey,owner);}
    catch { /* Exact ownership and identity checked by the read, never INSERT OR REPLACE. */ }
    return publicDraft(await storedDraft(env,owner,input.idempotencyKey));
}

async function validatePhoto(env,photo,roster,catalog) {
    if(!exact(photo,['photoId','originalFormat','byteCount','sha256','personIds','raceIndex','containsMinors',
        ...(photo && Object.hasOwn(photo,'runnerResults')?['runnerResults']:[]),
        ...(photo && Object.hasOwn(photo,'sourceRevision')?['sourceRevision']:[])]) ||
        !uuid.test(photo.photoId) || !['jpg','png'].includes(photo.originalFormat) ||
        !Number.isSafeInteger(photo.byteCount)||photo.byteCount<1||photo.byteCount>26214400||!sha.test(photo.sha256)||
        !Array.isArray(photo.personIds)||photo.personIds.length>100 ||
        photo.raceIndex!==null && (!Number.isSafeInteger(photo.raceIndex)||photo.raceIndex<0||!catalog.sites.family.catalog.races[photo.raceIndex]) ||
        photo.containsMinors!==null && typeof photo.containsMinors!=='boolean' ||
        Object.hasOwn(photo,'sourceRevision') && photo.sourceRevision!==catalog.sourceRevision) throw new Error('Invalid photo');
    if(photo.personIds.length) resolvePrivateGalleryTags(roster,'family',photo.personIds,roster.revision);
    projectFamilyRunnerResults(photo,roster,catalog,{allowIncomplete:true});
    const {photoId,sourceRevision,...metadata}=photo;
    // Save event values, not an index that could silently point to another race.
    return {photoId,metadata:{...metadata,race:photo.raceIndex===null?null:catalog.sites.family.catalog.races[photo.raceIndex],
        sourceRevision:catalog.sourceRevision}};
}
export async function saveFamilyDraft(env,identity,site,id,input,catalog) {
    if(!safeContext(identity,site)) return failure(403);
    if(!exact(input,['expectedVersion','idempotencyKey','photos'])||!uuid.test(input.idempotencyKey)||
        !Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0||!Array.isArray(input.photos)||input.photos.length>20) return failure(422);
    const owner=await hashIdentity(identity),draft=await storedDraft(env,owner,id),hash=await digest(input.photos);
    const previous=()=>first(env,'SELECT * FROM family_gallery_draft_writes WHERE idempotency_key=?1',input.idempotencyKey);
    const replay=async prior=>prior.draft_id===id && prior.expected_version===input.expectedVersion && prior.request_hash===hash &&
        (await storedDraft(env,owner,id)).version===input.expectedVersion+1
        ? publicDraft(await storedDraft(env,owner,id)):failure();
    const prior=await previous();if(prior) return replay(prior);
    if(draft.version!==input.expectedVersion||draft.state!=='editing') return failure();
    const {document}=await loadPrivateGalleryRoster(env,site),items=[];
    try {for(const photo of input.photos) items.push(await validatePhoto(env,photo,document,catalog));}
    catch {return failure(422,'family-photo-details-invalid');}
    if(new Set(items.map(item=>item.photoId)).size!==items.length || new Set(input.photos.map(p=>p.sha256)).size!==items.length) return failure(422,'family-duplicate-photo');
    // A retained photo's tags/source are immutable in this flow. Advanced tag
    // correction remains separately audited; changing metadata is not re-upload.
    const old=new Map(draft.photos.map(row=>[row.photo_id,row]));
    // An old open browser may omit the new revision input. It cannot silently
    // reinterpret saved indices after the catalogue has changed.
    for(const photo of input.photos) if(old.has(photo.photoId) && !Object.hasOwn(photo,'sourceRevision') &&
        JSON.parse(old.get(photo.photoId).metadata_json).sourceRevision!==catalog.sourceRevision) return failure(409,'family-race-catalogue-changed');
    for(const item of items) if(old.get(item.photoId)?.reservation_json &&
        old.get(item.photoId).metadata_json!==JSON.stringify(item.metadata)) return failure(409,'family-reserved-photo-changed');
    if(draft.photos.some(row=>row.reservation_json&&!items.some(item=>item.photoId===row.photo_id))) return failure(409,'family-retained-photo-cannot-be-discarded');
    const statements=[statement(env,`INSERT INTO family_gallery_draft_writes(idempotency_key,draft_id,expected_version,request_hash)
        VALUES(?1,?2,?3,?4)`,input.idempotencyKey,id,input.expectedVersion,hash)];
    // Move existing ordinals out of the unique range with a delete/reinsert only
    // for unreserved cards. Reserved cards cannot be silently removed or replaced.
    if(draft.photos.some(row=>row.reservation_json) && items.some((item,index)=>old.has(item.photoId)&&old.get(item.photoId).ordinal!==index)) {
        return failure(409,'family-reserved-order-fixed');
    }
    for(const row of draft.photos) if(!row.reservation_json) statements.push(statement(env,'DELETE FROM family_gallery_draft_photos WHERE photo_id=?1',row.photo_id));
    for(const [ordinal,item] of items.entries()) if(!old.get(item.photoId)?.reservation_json) statements.push(statement(env,
        'INSERT INTO family_gallery_draft_photos(photo_id,draft_id,ordinal,metadata_json) VALUES(?1,?2,?3,?4)',item.photoId,id,ordinal,JSON.stringify(item.metadata)));
    try {await batch(env,statements);} catch {const recovered=await previous();return recovered?replay(recovered):failure();}
    return publicDraft(await storedDraft(env,owner,id));
}

export async function prepareFamilyPhoto(env,identity,site,id,input,catalog) {
    if(!safeContext(identity,site)) return failure(403);
    if(!exact(input,['photoId','permissionVersion'])||!uuid.test(input.photoId)) return failure(422);
    const owner=await hashIdentity(identity);let draft=await storedDraft(env,owner,id);
    let photo=draft.photos.find(row=>row.photo_id===input.photoId);
    if(!photo||draft.state!=='editing'||photo.deleted) return failure();
    const data=JSON.parse(photo.metadata_json);
    if(!data.personIds.length||typeof data.containsMinors!=='boolean'||!data.race||data.sourceRevision!==catalog.sourceRevision) return failure(409,'family-photo-details-needed');
    try {projectFamilyRunnerResults(data,(await loadPrivateGalleryRoster(env,site)).document,catalog);}
    catch {return failure(409,'family-runner-distance-needed');}
    await requireFamilyPermission(env,owner,site,input.permissionVersion,data.containsMinors);
    if(!photo.reservation_json) {
        const {document}=await loadPrivateGalleryRoster(env,site);
        const reservation={idempotencyKey:photo.photo_id,rosterRevision:document.revision,personIds:data.personIds,originalFormat:data.originalFormat};
        await write(env,`UPDATE family_gallery_draft_photos SET reservation_json=?1 WHERE photo_id=?2 AND reservation_json IS NULL
            AND EXISTS(SELECT 1 FROM family_gallery_drafts WHERE draft_id=?3 AND version=?4 AND state='editing')`,JSON.stringify(reservation),photo.photo_id,id,draft.version);
        draft=await storedDraft(env,owner,id);photo=draft.photos.find(row=>row.photo_id===input.photoId);
        if(!photo?.reservation_json||photo.metadata_json!==JSON.stringify(data)) return failure();
    }
    if(!photo.asset_id) {
        const result=await reservePrivateGalleryAsset(env,identity,site,JSON.parse(photo.reservation_json));
        if(!result.ok) return result;
        await write(env,'UPDATE family_gallery_draft_photos SET asset_id=?1 WHERE photo_id=?2 AND asset_id IS NULL',result.asset.assetId,photo.photo_id);
        photo=(await storedDraft(env,owner,id)).photos.find(row=>row.photo_id===input.photoId);
    }
    if(!photo.intake_json) {
        const {document}=await loadPrivateGalleryRoster(env,site);
        const intake={rosterRevision:document.revision,tagVersion:1,byteCount:data.byteCount,sha256:data.sha256,
            declaredMimeType:data.originalFormat==='jpg'?'image/jpeg':'image/png',privateRetentionConfirmed:true,
            containsMinors:data.containsMinors,guardianApprovalConfirmed:data.containsMinors,standingPermissionVersion:input.permissionVersion};
        await write(env,'UPDATE family_gallery_draft_photos SET intake_json=?1 WHERE photo_id=?2 AND intake_json IS NULL',JSON.stringify(intake),photo.photo_id);
        photo=(await storedDraft(env,owner,id)).photos.find(row=>row.photo_id===input.photoId);
    }
    if(!photo.retained) {
        const intake=await preparePrivateArchiveIntake(env,identity,site,photo.asset_id,JSON.parse(photo.intake_json));
        if(!intake.ok) return intake;
    }
    return publicDraft(await storedDraft(env,owner,id));
}

export async function submitFamilyDraft(env,identity,site,id,input,catalog,dependencies={}) {
    if(!safeContext(identity,site)) return failure(403);
    if(!exact(input,['expectedVersion','permissionVersion','completeTagsConfirmed'])||input.completeTagsConfirmed!==true||
        !Number.isSafeInteger(input.expectedVersion)) return failure(422);
    const owner=await hashIdentity(identity);let draft=await storedDraft(env,owner,id);
    if(draft.job_id) {await dispatchFamilyReview(env,draft.job_id,dependencies);return publicDraft(draft);}
    if(draft.version!==input.expectedVersion||!draft.photos.length||draft.photos.some(photo=>!photo.retained||photo.deleted||!photo.framing_version||photo.preference==='hidden')) return failure(409,'family-check-each-photo');
    await requireFamilyPermission(env,owner,site,input.permissionVersion,draft.photos.some(row=>JSON.parse(row.metadata_json).containsMinors));
    if(draft.state==='editing') {
        const statements=draft.photos.map(photo=>statement(env,'UPDATE family_gallery_draft_photos SET attempt_key=?1 WHERE photo_id=?2 AND attempt_key IS NULL',crypto.randomUUID(),photo.photo_id));
        statements.unshift(statement(env,`UPDATE family_gallery_drafts SET state='submitting',submission_key=?1
            WHERE draft_id=?2 AND version=?3 AND state='editing'`,crypto.randomUUID(),id,draft.version));
        await batch(env,statements);draft=await storedDraft(env,owner,id);
    }
    if(draft.state!=='submitting'||!draft.submission_key) return failure();
    const attempts=[];
    for(const photo of draft.photos) {
        const data=JSON.parse(photo.metadata_json),raceIndex=catalog.sites.family.catalog.races.findIndex(r=>
            r.raceDate===data.race?.raceDate && r.raceEvent===data.race?.raceEvent && r.raceDistance===data.race?.raceDistance);
        if(data.sourceRevision!==catalog.sourceRevision||raceIndex<0) return failure(409,'family-race-catalogue-changed');
        const eligibility=await readPrivateGalleryAssetEligibility(env,identity,site,photo.asset_id,catalog);
        const framing=await readPrivateGalleryFraming(env,identity,site,photo.asset_id);
        if(!eligibility.ok||!eligibility.visibilityEligible||!framing.ok||framing.stale||framing.version<1) return failure(409,'family-photo-not-eligible');
        const {document}=await loadPrivateGalleryRoster(env,site);
        let results;try {results=projectFamilyRunnerResults(data,document,catalog);}
        catch {return failure(409,'family-race-catalogue-changed');}
        const attempt=await reservePrivateGalleryAttempt(env,identity,site,photo.asset_id,{
            idempotencyKey:photo.attempt_key,tagVersion:framing.tagVersion,eligibilityRevision:eligibility.revision,
            sourceRevision:catalog.sourceRevision,suppressionRevision:catalog.suppressionRevision,raceIndex,
            completeTagsConfirmed:true,publicUseConfirmed:true,containsMinors:data.containsMinors,guardianApprovalConfirmed:data.containsMinors,
            framingVersion:framing.version,standingPermissionVersion:input.permissionVersion,...results},catalog);
        if(!attempt.ok) return attempt;
        await write(env,'UPDATE family_gallery_draft_photos SET attempt_id=?1 WHERE photo_id=?2 AND attempt_id IS NULL',attempt.attemptId,photo.photo_id);
        attempts.push(attempt.attemptId);
    }
    const queued=await queuePrivateArchiveBatch(env,identity,site,{idempotencyKey:draft.submission_key,attemptIds:attempts});
    if(!queued.ok) return queued;
    await write(env,"UPDATE family_gallery_drafts SET state='submitted',job_id=?1 WHERE draft_id=?2 AND state='submitting'",queued.job.jobId,id);
    await dispatchFamilyReview(env,queued.job.jobId,dependencies);
    return publicDraft(await storedDraft(env,owner,id));
}

export async function familyDraftProgress(env,identity,site,id) {
    if(!safeContext(identity,site)) return failure(403);
    const draft=await storedDraft(env,await hashIdentity(identity),id);
    if(!draft.job_id) return {ok:true,status:200,state:draft.state,publicationEnabled:false};
    const jobs=await readPrivateArchiveBatches(env,identity,site);
    const job=jobs.ok?jobs.batches.find(row=>row.jobId===draft.job_id):null;
    if(!job) return failure(503,'family-review-status-unavailable');
    const dispatch=await first(env,'SELECT state FROM family_gallery_dispatches WHERE job_id=?1',draft.job_id);
    return {ok:true,status:200,job,dispatchState:dispatch?.state||'owner-start-required',publicationEnabled:false};
}
