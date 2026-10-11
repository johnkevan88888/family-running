import { hashIdentity } from './session.js';
import { loadPrivateGalleryRoster } from './private-gallery-roster-service.js';
import { resolvePrivateGalleryTags } from './private-gallery-roster.js';
import {assertArchiveIdentityAvailable} from './private-gallery-retirement.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const person = /^person_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fields = ['idempotencyKey', 'originalFormat', 'personIds', 'rosterRevision'];
const unavailable = () => ({ ok: false, status: 503, code: 'private-asset-unavailable' });
const conflict = () => ({ ok: false, status: 409, code: 'private-asset-conflict' });
const readSql = `SELECT a.*, s.tag_version, s.current_person_ids_json, t.person_id, t.ordinal, p.person_id AS existing_person_id
    FROM private_gallery_assets a
    JOIN private_gallery_current_tag_sets s ON s.asset_id = a.asset_id
    LEFT JOIN private_gallery_current_asset_tags t ON t.asset_id = a.asset_id
    LEFT JOIN private_gallery_people p ON p.person_id = t.person_id
    WHERE a.owner_identity_hash = ?1 AND a.site_mode = ?2 AND `;

function validContext(identity, site) {
    return identity?.type === 'browser' && typeof identity.subject === 'string' &&
        identity.subject.trim().length > 0 && ['family', 'everyone'].includes(site);
}
function validPersonIds(ids) {
    return Array.isArray(ids) && ids.length >= 1 && ids.length <= 100 &&
        new Set(ids).size === ids.length && ids.every(id => typeof id === 'string' && person.test(id));
}
async function digest(value) {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
        .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function readStored(env, owner, site, field, value) {
    // field is chosen by this module, never request text. Bounded complete read:
    // even one missing/extra association denies the whole response.
    const result = await env.DB.prepare(`${readSql}${field} = ?3 ORDER BY t.ordinal LIMIT 101`)
        .bind(owner, site, value).all();
    if (result?.success !== true || !Array.isArray(result.results)) throw new Error('Unavailable');
    if (result.results.length === 0) return null;
    const row = result.results[0], ids = JSON.parse(row.current_person_ids_json);
    if (!validPersonIds(ids) || result.results.length !== ids.length ||
        !Number.isSafeInteger(row.tag_version) || row.tag_version < 1 ||
        !uuid.test(row.asset_id?.slice(6)) || !row.asset_id.startsWith('asset_') ||
        row.site_mode !== site || row.owner_identity_hash !== owner ||
        !['jpg', 'png'].includes(row.original_format) || row.state !== 'awaiting-original' ||
        row.private_object_key !== `private-archive/v1/${site}/${row.asset_id}/original.${row.original_format}` ||
        !/^[0-9a-f]{64}$/.test(row.request_hash) ||
        result.results.some((tag, index) => tag.asset_id !== row.asset_id || tag.ordinal !== index ||
            tag.person_id !== ids[index] || tag.existing_person_id !== ids[index] ||
            tag.tag_version !== row.tag_version || tag.current_person_ids_json !== row.current_person_ids_json)) throw new Error('Incomplete');
    return { requestHash: row.request_hash, asset: {
        assetId: row.asset_id, siteMode: site, state: row.state, personIds: ids
    } };
}

// Called only after the Worker's single-owner, area-session and CSRF checks.
// This is NOT photo intake or consent: it performs no object-storage operation.
export async function reservePrivateGalleryAsset(env, identity, site, input) {
    if (!validContext(identity, site)) return { ok: false, status: 403 };
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).sort().join('|') !== fields.join('|') ||
        typeof input.idempotencyKey !== 'string' || !uuid.test(input.idempotencyKey) ||
        typeof input.rosterRevision !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(input.rosterRevision) ||
        !validPersonIds(input.personIds) || !['jpg', 'png'].includes(input.originalFormat)) {
        return { ok: false, status: 400, code: 'invalid-private-asset-request' };
    }
    try {
        const owner = await hashIdentity(identity);
        await assertArchiveIdentityAvailable(env,'reservation',JSON.stringify([owner,site,input.idempotencyKey]));
        const requestHash = await digest(JSON.stringify([
            input.rosterRevision, input.personIds, input.originalFormat
        ]));
        const readPrior = () => readStored(env, owner, site, 'a.idempotency_key', input.idempotencyKey);
        const replay = prior => prior.requestHash === requestHash
            ? { ok: true, status: 200, asset: prior.asset, replayed: true } : conflict();
        const prior = await readPrior();
        if (prior) return replay(prior);
        const { document, generation } = await loadPrivateGalleryRoster(env, site);
        try { resolvePrivateGalleryTags(document, site, input.personIds, input.rosterRevision); }
        catch { return conflict(); }
        const assetId = `asset_${crypto.randomUUID()}`;
        await assertArchiveIdentityAvailable(env,'asset',assetId);
        try {
            const result = await env.DB.prepare(`INSERT INTO private_gallery_assets
                (asset_id, site_mode, owner_identity_hash, idempotency_key, request_hash,
                 roster_generation, person_ids_json, original_format, private_object_key)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`)
                .bind(assetId, site, owner, input.idempotencyKey, requestHash, generation,
                    JSON.stringify(input.personIds), input.originalFormat,
                    `private-archive/v1/${site}/${assetId}/original.${input.originalFormat}`).run();
            if (result?.success !== true) throw new Error('Reservation unavailable');
        } catch {
            // A committed write with a lost response is recoverable without
            // inserting a second asset or replaying any upload/cleanup.
            const recovered = await readPrior();
            if (recovered) return replay(recovered);
            const current = await loadPrivateGalleryRoster(env, site);
            return current.generation !== generation ? conflict() : unavailable();
        }
        const stored = await readPrior();
        if (!stored || stored.asset.assetId !== assetId || stored.requestHash !== requestHash) return unavailable();
        return { ok: true, status: 201, asset: stored.asset, replayed: false };
    } catch { return unavailable(); }
}

export async function readPrivateGalleryAsset(env, identity, site, assetId) {
    if (!validContext(identity, site)) return { ok: false, status: 403 };
    if (typeof assetId !== 'string' || !assetId.startsWith('asset_') || !uuid.test(assetId.slice(6))) {
        return { ok: false, status: 404 };
    }
    try {
        const stored = await readStored(env, await hashIdentity(identity), site, 'a.asset_id', assetId);
        return stored ? { ok: true, status: 200, asset: stored.asset } : { ok: false, status: 404 };
    } catch { return unavailable(); }
}
