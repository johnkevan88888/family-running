import { hashIdentity } from './session.js';
import { sha256Hex } from './media-byte-verification.js';
import { readPrivateGalleryAsset } from './private-gallery-asset-service.js';
import { loadPrivateGalleryRoster } from './private-gallery-roster-service.js';
import { resolvePrivateGalleryTags } from './private-gallery-roster.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const failure = status => ({ok:false,status,code:'private-tags-unavailable-or-changed'});
const fields = ['completeTagsConfirmed','containsMinors','expectedVersion','guardianApprovalConfirmed',
    'idempotencyKey','personIds','privateRetentionConfirmed','rosterRevision'];

// Called behind the existing verified owner/session/area boundary. This helper
// only changes private tags; it grants no public consent or processing right.
export async function readPrivateGalleryTags(env,identity,site,assetId) {
    const selected = await readPrivateGalleryAsset(env,identity,site,assetId);
    if (!selected.ok) return selected;
    try {
        const row = await env.DB.prepare(`SELECT s.tag_version,s.current_person_ids_json,
            (EXISTS (SELECT 1 FROM private_archive_deletion_requests d WHERE d.asset_id = s.asset_id)
             OR EXISTS (SELECT 1 FROM private_archive_intakes i WHERE i.asset_id = s.asset_id AND NOT EXISTS (
                SELECT 1 FROM private_archive_original_receipts o WHERE o.asset_id = i.asset_id))) AS blocked
            FROM private_gallery_current_tag_sets s WHERE s.asset_id = ?1`).bind(assetId).first();
        if (!Number.isSafeInteger(row?.tag_version) || row.tag_version < 1 || ![0,1].includes(row.blocked) ||
            row.current_person_ids_json !== JSON.stringify(selected.asset.personIds)) return failure(503);
        return {ok:true,status:200,assetId,tagVersion:row.tag_version,personIds:selected.asset.personIds,
            correctionBlocked:row.blocked === 1,publicationEnabled:false};
    } catch { return failure(503); }
}

export async function correctPrivateGalleryTags(env,identity,site,assetId,input) {
    const current = await readPrivateGalleryTags(env,identity,site,assetId);
    if (!current.ok) return current;
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).sort().join('|') !== fields.join('|') || !uuid.test(input.idempotencyKey) ||
        !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 ||
        input.expectedVersion >= Number.MAX_SAFE_INTEGER || input.completeTagsConfirmed !== true ||
        input.privateRetentionConfirmed !== true || typeof input.containsMinors !== 'boolean' ||
        input.guardianApprovalConfirmed !== input.containsMinors ||
        typeof input.rosterRevision !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(input.rosterRevision)) return failure(422);
    if (current.correctionBlocked) return failure(409);
    try {
        const owner = await hashIdentity(identity);
        const hash = await sha256Hex(new TextEncoder().encode(JSON.stringify([site,assetId,...fields.map(key=>input[key])])));
        const prior = () => env.DB.prepare('SELECT * FROM private_gallery_tag_revisions WHERE idempotency_key = ?1')
            .bind(input.idempotencyKey).first();
        const replay = async row => {
            const latest = await readPrivateGalleryTags(env,identity,site,assetId);
            return row.asset_id === assetId && row.actor_identity_hash === owner && row.request_hash === hash &&
                latest.ok && !latest.correctionBlocked && latest.tagVersion === row.version &&
                JSON.stringify(latest.personIds) === row.person_ids_json ? {...latest,replayed:true} : failure(409);
        };
        const existing = await prior();
        if (existing) return replay(existing);
        if (current.tagVersion !== input.expectedVersion) return failure(409);
        const {document,generation} = await loadPrivateGalleryRoster(env,site);
        try { resolvePrivateGalleryTags(document,site,input.personIds,input.rosterRevision); }
        catch { return failure(409); }
        try {
            const result = await env.DB.prepare(`INSERT INTO private_gallery_tag_revisions
                (asset_id,version,idempotency_key,actor_identity_hash,request_hash,roster_generation,
                 previous_person_ids_json,person_ids_json,complete_tags_confirmed,private_retention_confirmed,
                 contains_minors,guardian_approval_confirmed) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,1,1,?9,?10)`)
                .bind(assetId,input.expectedVersion+1,input.idempotencyKey,owner,hash,generation,
                    JSON.stringify(current.personIds),JSON.stringify(input.personIds),Number(input.containsMinors),
                    Number(input.guardianApprovalConfirmed)).run();
            if (result?.success !== true) throw new Error('Unavailable');
        } catch {
            const recovered = await prior();
            return recovered ? replay(recovered) : failure(409);
        }
        const stored = await prior();
        if (!stored) return failure(503);
        const result = await replay(stored);
        return result.ok ? {...result,status:201,replayed:false} : result;
    } catch { return failure(503); }
}
