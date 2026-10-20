import '../../gallery-contract.js';
import '../../gallery-upload-contract.js';
import { hashIdentity } from './session.js';
import { sha256Hex } from './media-byte-verification.js';
import { loadPrivateGalleryRoster } from './private-gallery-roster-service.js';
import { readPrivateGalleryAssetEligibility } from './private-gallery-visibility-service.js';
import { readPrivateGalleryTags } from './private-gallery-tag-service.js';
import {assertArchiveIdentityAvailable} from './private-gallery-retirement.js';
import { readPrivateGalleryAttemptFraming } from './private-gallery-framing-service.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const revision = /^sha256:[0-9a-f]{64}$/;
const fields = ['completeTagsConfirmed','containsMinors','eligibilityRevision','guardianApprovalConfirmed',
    'idempotencyKey','publicUseConfirmed','raceIndex','sourceRevision','suppressionRevision','tagVersion'];
const failure = status => ({ok:false,status,code:'private-attempt-unavailable-or-changed'});
const fingerprint = value => sha256Hex(new TextEncoder().encode(JSON.stringify(value)));
const safeProvider = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);

// INTERNAL ONLY. Future HTTP wiring needs verified owner, area session and CSRF.
// Reserving fresh consent is not decoder/stripping proof, processing approval or
// permission to expose preview bytes. No legacy draft or R2 object is mutated.
export async function reservePrivateGalleryAttempt(env,identity,site,assetId,input,catalog) {
    if (identity?.type !== 'browser' || typeof identity.subject !== 'string' || !identity.subject.trim() ||
        !['family','everyone'].includes(site)) return failure(403);
    const hasFramingVersion = input && Object.hasOwn(input, 'framingVersion');
    const requestFields = hasFramingVersion ? [...fields, 'framingVersion'].sort() : fields;
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).sort().join('|') !== requestFields.join('|') || !uuid.test(input.idempotencyKey) ||
        (hasFramingVersion && (!Number.isSafeInteger(input.framingVersion) || input.framingVersion < 0)) ||
        input.completeTagsConfirmed !== true || input.publicUseConfirmed !== true || typeof input.containsMinors !== 'boolean' ||
        input.guardianApprovalConfirmed !== input.containsMinors || !Number.isSafeInteger(input.tagVersion) || input.tagVersion < 1 ||
        !Number.isSafeInteger(input.raceIndex) || input.raceIndex < 0 ||
        ![input.eligibilityRevision,input.sourceRevision,input.suppressionRevision].every(value=>typeof value === 'string' && revision.test(value))) return failure(422);
    try {
        const owner = await hashIdentity(identity);
        const hash = await fingerprint([site,assetId,...requestFields.map(key=>input[key])]);
        const prior = () => env.DB.prepare('SELECT *, (unixepoch(created_at)+86400 > unixepoch(\'now\')) AS unexpired FROM private_gallery_attempts WHERE idempotency_key = ?1')
            .bind(input.idempotencyKey).first();
        const snapshot = async () => {
            const tags = await readPrivateGalleryTags(env,identity,site,assetId);
            if (!tags.ok) return tags;
            if (tags.correctionBlocked || tags.tagVersion !== input.tagVersion) return failure(409);
            const eligibility = await readPrivateGalleryAssetEligibility(env,identity,site,assetId,catalog);
            if (!eligibility.ok) return eligibility;
            if (!eligibility.visibilityEligible || eligibility.revision !== input.eligibilityRevision ||
                catalog?.sourceRevision !== input.sourceRevision || catalog?.suppressionRevision !== input.suppressionRevision) return failure(409);
            const {document,generation} = await loadPrivateGalleryRoster(env,site);
            const visibility = await env.DB.prepare(`SELECT t.person_id,v.version,v.preference
                FROM private_gallery_current_asset_tags t LEFT JOIN private_gallery_current_visibility v ON v.person_id=t.person_id
                WHERE t.asset_id=?1 ORDER BY t.ordinal LIMIT 101`).bind(assetId).all();
            const rows = visibility?.results;
            if (visibility?.success !== true || !Array.isArray(rows) || rows.length !== tags.personIds.length ||
                rows.some((row,index)=>row.person_id !== tags.personIds[index] || !Number.isSafeInteger(row.version) || row.version < 1 ||
                    row.preference !== 'allowed')) return failure(409);
            const original = await env.DB.prepare(`SELECT o.*, CASE WHEN ?2=1 THEN i.contains_minors ELSE r.contains_minors END AS current_minors
                FROM private_archive_original_receipts o JOIN private_archive_intakes i ON i.asset_id=o.asset_id
                LEFT JOIN private_gallery_tag_revisions r ON r.asset_id=o.asset_id AND r.version=?2
                WHERE o.asset_id=?1 AND i.byte_count=o.byte_count AND i.sha256=o.sha256`).bind(assetId,tags.tagVersion).first();
            if (!original || !Number.isSafeInteger(original.byte_count) || original.byte_count < 1 || original.byte_count > 26214400 ||
                !/^[0-9a-f]{64}$/.test(original.sha256) || !safeProvider(original.provider_version) || !safeProvider(original.provider_etag) ||
                original.current_minors !== Number(input.containsMinors)) return failure(409);
            const race = catalog?.sites?.[site]?.catalog?.races?.[input.raceIndex];
            if (!race) return failure(409);
            // Reuse the normal public approval validator for catalogue/race and
            // projected public IDs. The temporary view is never a stored draft.
            const consentRevision = `consent_${input.idempotencyKey}`;
            const view = {schemaVersion:'1.0',draftId:`draft_${input.idempotencyKey}`,state:'draft',stateVersion:0,siteModes:[site],
                exportBundleId:catalog.exportBundleId,sourceRevision:catalog.sourceRevision,suppressionRevision:catalog.suppressionRevision,
                itemRevision:`item_${input.idempotencyKey}`,manifestItem:null,withdrawalEvidence:null,
                itemInput:{id:`photo-${input.idempotencyKey}`,type:'photo',title:'Photo',caption:'',alt:'Photo',...race,
                    featured:false,athleteIds:eligibility.publicAthleteIds},
                consent:{publicUseConfirmed:true,containsMinors:input.containsMinors,guardianApprovalConfirmed:input.guardianApprovalConfirmed,revision:consentRevision}};
            if (globalThis.galleryUploadContract.validateGalleryUploadApproval(view,{consentRevision,
                suppressionDocument:catalog.suppressionDocument,suppressionRevision:catalog.suppressionRevision,pendingHiddenAthleteIds:[],
                siteCatalogs:{[site]:catalog.sites[site].catalog}}).length) return failure(409);
            // Check the earlier reads against one last complete eligibility read.
            const latest = await readPrivateGalleryAssetEligibility(env,identity,site,assetId,catalog);
            if (!latest.ok || !latest.visibilityEligible || latest.revision !== eligibility.revision ||
                (await loadPrivateGalleryRoster(env,site)).document.revision !== document.revision) return failure(409);
            return {ok:true,tags,eligibility,generation,original,race,
                visibility:rows.map(row=>[row.person_id,row.version,row.preference])};
        };
        const replay = async row => {
            if (row.asset_id !== assetId || row.site_mode !== site || row.owner_identity_hash !== owner || row.request_hash !== hash ||
                row.unexpired !== 1 || !uuid.test(row.attempt_id?.slice(8)) || !uuid.test(row.generation_id) ||
                !uuid.test(row.public_item_id?.slice(6))) return failure(409);
            // Framing is immutable attempt evidence, never a read of today's
            // editable settings. Later owner edits cannot rewrite an old review.
            await readPrivateGalleryAttemptFraming(env, row);
            const current = await snapshot();
            if (!current.ok) return current;
            if (row.roster_generation !== current.generation || row.tag_version !== current.tags.tagVersion ||
                row.person_ids_json !== JSON.stringify(current.tags.personIds) || row.visibility_json !== JSON.stringify(current.visibility) ||
                row.public_athlete_ids_json !== JSON.stringify(current.eligibility.publicAthleteIds) ||
                row.original_sha256 !== current.original.sha256 || row.original_byte_count !== current.original.byte_count ||
                row.original_provider_version !== current.original.provider_version || row.original_provider_etag !== current.original.provider_etag ||
                row.export_bundle_id !== catalog.exportBundleId || row.source_revision !== catalog.sourceRevision || row.suppression_revision !== catalog.suppressionRevision ||
                row.eligibility_revision !== current.eligibility.revision || row.race_date !== current.race.raceDate ||
                row.race_event !== current.race.raceEvent || row.race_distance !== current.race.raceDistance ||
                row.complete_tags_confirmed !== 1 || row.public_use_confirmed !== 1 || row.contains_minors !== Number(input.containsMinors) ||
                row.guardian_approval_confirmed !== Number(input.guardianApprovalConfirmed)) return failure(409);
            return {ok:true,status:200,attemptId:row.attempt_id,assetId,state:'reserved',replayed:true,
                processingEnabled:false,publicationEnabled:false};
        };
        const existing = await prior();
        if (existing) return replay(existing);
        const current = await snapshot();
        if (!current.ok) return current;
        const attemptId = `attempt_${crypto.randomUUID()}`;
        const generationId=crypto.randomUUID(),itemId=`photo-${crypto.randomUUID()}`;
        await assertArchiveIdentityAvailable(env,'generation',generationId);
        await assertArchiveIdentityAvailable(env,'item',itemId);
        try {
            const result = await env.DB.prepare(`INSERT INTO private_gallery_attempts
                (attempt_id,asset_id,site_mode,generation_id,public_item_id,idempotency_key,owner_identity_hash,request_hash,
                 roster_generation,tag_version,person_ids_json,visibility_json,public_athlete_ids_json,eligibility_revision,
                 export_bundle_id,source_revision,suppression_revision,race_date,race_event,race_distance,
                 original_byte_count,original_sha256,original_provider_version,original_provider_etag,
                 complete_tags_confirmed,public_use_confirmed,contains_minors,guardian_approval_confirmed${hasFramingVersion ? ',framing_version' : ''})
                VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,1,1,?25,?26${hasFramingVersion ? ',?27' : ''})`)
                .bind(attemptId,assetId,site,generationId,itemId,input.idempotencyKey,owner,hash,
                    current.generation,current.tags.tagVersion,JSON.stringify(current.tags.personIds),JSON.stringify(current.visibility),
                    JSON.stringify(current.eligibility.publicAthleteIds),current.eligibility.revision,catalog.exportBundleId,catalog.sourceRevision,
                    catalog.suppressionRevision,current.race.raceDate,current.race.raceEvent,current.race.raceDistance,
                    current.original.byte_count,current.original.sha256,current.original.provider_version,current.original.provider_etag,
                    Number(input.containsMinors),Number(input.guardianApprovalConfirmed),...(hasFramingVersion ? [input.framingVersion] : [])).run();
            if (result?.success !== true) throw new Error('Unavailable');
        } catch {
            const recovered = await prior();
            return recovered ? replay(recovered) : failure(409);
        }
        const stored = await prior();
        if (!stored || stored.attempt_id !== attemptId) return failure(503);
        const result = await replay(stored);
        return result.ok ? {...result,status:201,replayed:false} : result;
    } catch { return failure(503); }
}
