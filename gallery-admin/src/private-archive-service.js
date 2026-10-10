import mediaPolicyModule from '../../gallery-media-policy.js';
import { hashIdentity } from './session.js';
import { readBoundedBytes, sha256Hex } from './media-byte-verification.js';
import { readPrivateGalleryAsset } from './private-gallery-asset-service.js';
import { loadPrivateGalleryRoster } from './private-gallery-roster-service.js';
import { resolvePrivateGalleryTags } from './private-gallery-roster.js';

const policy = mediaPolicyModule?.default || mediaPolicyModule;
const maximumBytes = 25 * 1024 * 1024;
const hex = /^[0-9a-f]{64}$/;
const safeProvider = (value, limit = 256) => typeof value === 'string' && value.length > 0 &&
    value.length <= limit && !/[\u0000-\u001f\u007f]/u.test(value);
const failure = status => ({ ok:false, status, code:status === 409 ? 'archive-blocked-or-conflicting' : 'archive-unavailable' });
const response = (status, state) => ({ok:true,status,state});
const intakeFields = ['byteCount','containsMinors','declaredMimeType','guardianApprovalConfirmed','privateRetentionConfirmed','rosterRevision','sha256'];

// Preparatory internal service: deliberately NOT wired into the admin Worker.
// The future route must use its verified owner/session/CSRF boundary. No helper
// here confers public-use consent or performs image decoding/publishing.
async function context(env, identity, site, assetId) {
    const selected = await readPrivateGalleryAsset(env, identity, site, assetId);
    if (!selected.ok) throw Object.assign(new Error('Unavailable'), {status:selected.status});
    const owner = await hashIdentity(identity);
    const row = await env.DB.prepare(`SELECT a.original_format, a.private_object_key,
        i.request_hash, i.roster_generation, i.byte_count, i.sha256, s.tag_version, s.current_person_ids_json,
        (unixepoch(i.created_at) + 86400 > unixepoch('now')) AS unexpired,
        (i.roster_generation = v.generation) AS roster_current,
        u.provider_upload_id, o.provider_version, o.provider_etag,
        d.reason AS deletion_reason, c.proof AS closure_proof, r.original_absent
        FROM private_gallery_assets a
        JOIN private_gallery_current_tag_sets s ON s.asset_id = a.asset_id
        LEFT JOIN private_archive_intakes i ON i.asset_id = a.asset_id
        LEFT JOIN private_archive_multipart_uploads u ON u.asset_id = a.asset_id
        LEFT JOIN private_archive_original_receipts o ON o.asset_id = a.asset_id
        LEFT JOIN private_archive_deletion_requests d ON d.asset_id = a.asset_id
        LEFT JOIN private_archive_writer_closures c ON c.asset_id = a.asset_id
        LEFT JOIN private_archive_deletion_receipts r ON r.asset_id = a.asset_id
        LEFT JOIN private_gallery_roster_version v ON v.singleton = 1
        WHERE a.asset_id = ?1 AND a.owner_identity_hash = ?2 AND a.site_mode = ?3`)
        .bind(assetId,owner,site).first();
    if (!row || !Number.isSafeInteger(row.tag_version) || row.tag_version < 1 ||
        row.current_person_ids_json !== JSON.stringify(selected.asset.personIds) || !['jpg','png'].includes(row.original_format) ||
        row.private_object_key !== `private-archive/v1/${site}/${assetId}/original.${row.original_format}` ||
        (row.provider_upload_id !== null && !safeProvider(row.provider_upload_id,1024))) throw new Error('Unavailable');
    return {...row,owner,personIds:selected.asset.personIds};
}
async function run(env, sql, ...bindings) {
    const result = await env.DB.prepare(sql).bind(...bindings).run();
    if (result?.success !== true) throw new Error('Unavailable');
}
const blocked = row => Boolean(row.deletion_reason) || row.unexpired !== 1 || row.roster_current !== 1;
const state = row => row.original_absent === 1 ? 'private-original-deleted' : row.deletion_reason ? 'deletion-pending' :
    row.provider_version ? 'quarantined' : row.request_hash ? 'awaiting-upload' : 'awaiting-consent';
const publicError = error => failure([403,404,409,422].includes(error?.status) ? error.status : 503);

export async function preparePrivateArchiveIntake(env, identity, site, assetId, input) {
    try {
        const row = await context(env,identity,site,assetId);
        if (row.deletion_reason) return failure(409);
        const mime = row.original_format === 'jpg' ? 'image/jpeg' : 'image/png';
        // Existing version-one callers remain valid only for uncorrected tags.
        // A corrected set requires the owner's explicit current tag version.
        const tagVersion = input?.tagVersion ?? 1;
        const inputFields = input && Object.hasOwn(input,'tagVersion') ? [...intakeFields,'tagVersion'].sort() : intakeFields;
        if (!input || typeof input !== 'object' || Array.isArray(input) ||
            Object.keys(input).sort().join('|') !== inputFields.join('|') ||
            !Number.isSafeInteger(tagVersion) || tagVersion < 1 ||
            !Number.isSafeInteger(input.byteCount) || input.byteCount < 1 || input.byteCount > maximumBytes ||
            typeof input.sha256 !== 'string' || !hex.test(input.sha256) || input.declaredMimeType !== mime ||
            input.privateRetentionConfirmed !== true || typeof input.containsMinors !== 'boolean' ||
            input.guardianApprovalConfirmed !== input.containsMinors ||
            typeof input.rosterRevision !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(input.rosterRevision)) return failure(422);
        if (tagVersion !== row.tag_version) return failure(409);
        const attestation = intakeFields.map(key=>input[key]);
        // Preserve the exact v1 fingerprint for pre-0021 intake replays; an
        // additive corrected-tag fingerprint must never rewrite old evidence.
        const fingerprint = await sha256Hex(new TextEncoder().encode(JSON.stringify(
            tagVersion === 1 ? attestation : [tagVersion,...attestation])));
        if (row.request_hash) return row.request_hash === fingerprint ? response(200,state(row)) : failure(409);
        const {document,generation} = await loadPrivateGalleryRoster(env,site);
        try { resolvePrivateGalleryTags(document,site,row.personIds,input.rosterRevision); }
        catch { return failure(409); }
        try {
            await run(env,`INSERT INTO private_archive_intakes
                (asset_id,roster_generation,request_hash,byte_count,sha256,private_retention_confirmed,contains_minors,guardian_approval_confirmed,tag_version)
                VALUES (?1,?2,?3,?4,?5,1,?6,?7,?8)`,assetId,generation,fingerprint,input.byteCount,input.sha256,
                Number(input.containsMinors),Number(input.guardianApprovalConfirmed),row.tag_version);
        } catch {
            const recovered = await context(env,identity,site,assetId);
            if (recovered.deletion_reason) return failure(409);
            return recovered.request_hash === fingerprint ? response(200,state(recovered)) : failure(409);
        }
        return response(201,'awaiting-upload');
    } catch (error) { return publicError(error); }
}

export async function storePrivateArchiveOriginal(env, identity, site, assetId, body, dependencies = {}) {
    try {
        let row = await context(env,identity,site,assetId);
        if (row.deletion_reason || !row.request_hash) return failure(409);
        if (row.provider_version) return response(200,'quarantined');
        if (blocked(row) || typeof body?.getReader !== 'function') return failure(409);
        // Bounded stream read, never Blob.arrayBuffer() or an unbounded body read.
        let bytes;
        try { bytes = await readBoundedBytes({getReader:()=>body.getReader()},row.byte_count); }
        catch { return failure(422); }
        if (bytes.byteLength !== row.byte_count || await sha256Hex(bytes) !== row.sha256 ||
            policy.detectAllowedFileType(bytes) !== (row.original_format === 'jpg' ? 'jpeg' : 'png')) return failure(422);
        row = await context(env,identity,site,assetId);
        if (blocked(row)) return failure(409);
        if (!row.provider_upload_id) {
            const created = await env.PRIVATE_ORIGINALS.createMultipartUpload(row.private_object_key, {
                httpMetadata:{contentType:'application/octet-stream',cacheControl:'no-store'}
            });
            if (created?.key !== row.private_object_key || !safeProvider(created.uploadId,1024)) throw new Error('Invalid writer');
            // No bytes may be sent until this exact provider ID is durable.
            // A losing/unregistered creation can therefore never write an object.
            try { await run(env,'INSERT INTO private_archive_multipart_uploads (asset_id,provider_upload_id) VALUES (?1,?2)',assetId,created.uploadId); }
            catch {
                let recovered;
                try { recovered = await context(env,identity,site,assetId); }
                catch { await created.abort(); throw new Error('Registration unavailable'); }
                if (recovered.provider_upload_id !== created.uploadId) await created.abort();
            }
            row = await context(env,identity,site,assetId);
            if (blocked(row) || !row.provider_upload_id) return failure(409);
        }
        const upload = env.PRIVATE_ORIGINALS.resumeMultipartUpload(row.private_object_key,row.provider_upload_id);
        let object = await env.PRIVATE_ORIGINALS.head(row.private_object_key);
        if (!object) {
            const part = await upload.uploadPart(1,bytes);
            bytes = null;
            if (part?.partNumber !== 1 || !safeProvider(part.etag)) throw new Error('Invalid part');
            row = await context(env,identity,site,assetId);
            if (blocked(row)) return failure(409);
            try { object = await upload.complete([part]); }
            catch {
                object = await env.PRIVATE_ORIGINALS.head(row.private_object_key);
                if (!object) throw new Error('Incomplete upload');
            }
        }
        bytes = null;
        if (!objectMatches(object,row)) throw new Error('Object mismatch');
        const stored = await env.PRIVATE_ORIGINALS.get(row.private_object_key,{onlyIf:{etagMatches:object.etag}});
        if (!objectMatches(stored,row) || stored.version !== object.version || stored.etag !== object.etag ||
            typeof stored.body?.getReader !== 'function') throw new Error('Readback mismatch');
        const digest = await boundedDigest(stored.body,row.byte_count,dependencies);
        if (digest !== row.sha256) throw new Error('Readback checksum mismatch');
        try {
            await run(env,`INSERT INTO private_archive_original_receipts
                (asset_id,byte_count,sha256,provider_version,provider_etag) VALUES (?1,?2,?3,?4,?5)`,
                assetId,row.byte_count,row.sha256,object.version,object.etag);
        } catch {
            const current = await context(env,identity,site,assetId);
            if (current.deletion_reason) return failure(409);
            if (current.provider_version !== object.version || current.provider_etag !== object.etag) throw new Error('Receipt unavailable');
        }
        return response(200,'quarantined');
    } catch (error) { return publicError(error); }
}

function objectMatches(object,row) {
    return object?.key === row.private_object_key && object.size === row.byte_count &&
        safeProvider(object.version) && safeProvider(object.etag);
}
async function boundedDigest(body, expected, dependencies) {
    let count = 0;
    const checked = body.pipeThrough(new TransformStream({transform(chunk,controller) {
        if (!(chunk instanceof Uint8Array)) throw new Error('Invalid stream');
        count += chunk.byteLength;
        if (count > expected) throw new Error('Readback oversized');
        controller.enqueue(chunk);
    }}));
    let result;
    if (typeof dependencies.digestReadable === 'function') result = await dependencies.digestReadable(checked);
    else {
        const digest = new crypto.DigestStream('SHA-256');
        await checked.pipeTo(digest);
        result = [...new Uint8Array(await digest.digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
    }
    if (count !== expected || typeof result !== 'string' || !hex.test(result)) throw new Error('Invalid readback');
    return result;
}

export async function deletePrivateArchiveOriginal(env,identity,site,assetId,reason) {
    if (!['owner-delete','consent-withdrawal'].includes(reason)) return failure(422);
    try {
        let row = await context(env,identity,site,assetId);
        if (row.original_absent === 1) return response(200,'private-original-deleted');
        if (!row.deletion_reason) {
            try { await run(env,'INSERT INTO private_archive_deletion_requests (asset_id,actor_identity_hash,reason) VALUES (?1,?2,?3)',assetId,row.owner,reason); }
            catch { /* Readback reconciles a committed request with lost response. */ }
            row = await context(env,identity,site,assetId);
            if (!row.deletion_reason) throw new Error('Deletion not durable');
            if (row.original_absent === 1) return response(200,'private-original-deleted');
        }
        // SQL now prevents intake, writer registration and original admission.
        // Close the sole registered multipart writer BEFORE deleting the object;
        // an in-flight completion can no longer recreate it after that fence.
        if (row.provider_upload_id && !row.closure_proof) {
            let proof = 'abort-confirmed';
            try { await env.PRIVATE_ORIGINALS.resumeMultipartUpload(row.private_object_key,row.provider_upload_id).abort(); }
            catch (error) {
                if (error?.name !== 'NoSuchUpload' && error?.code !== 'NoSuchUpload' && error?.message !== 'NoSuchUpload') throw error;
                proof = 'no-such-upload';
            }
            try { await run(env,'INSERT INTO private_archive_writer_closures (asset_id,provider_upload_id,proof) VALUES (?1,?2,?3)',assetId,row.provider_upload_id,proof); }
            catch { /* Only a durable matching closure allows continuation. */ }
            row = await context(env,identity,site,assetId);
            if (!row.closure_proof) throw new Error('Writer closure unavailable');
        }
        // Exact server-owned key only. No prefix deletion, public-host claim,
        // old-draft cleanup, manifest mutation or metadata purge is performed.
        const existing = await env.PRIVATE_ORIGINALS.head(row.private_object_key);
        if (existing) await env.PRIVATE_ORIGINALS.delete(row.private_object_key);
        if (await env.PRIVATE_ORIGINALS.head(row.private_object_key) !== null) throw new Error('Original absence unverified');
        try { await run(env,'INSERT INTO private_archive_deletion_receipts (asset_id,original_absent) VALUES (?1,1)',assetId); }
        catch { /* A lost receipt response is reconciled, never guessed. */ }
        row = await context(env,identity,site,assetId);
        return row.original_absent === 1 ? response(200,'private-original-deleted') : failure(503);
    } catch (error) { return publicError(error); }
}
