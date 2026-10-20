import { hashIdentity } from './session.js';
import { sha256Hex } from './media-byte-verification.js';
import { readPrivateGalleryTags } from './private-gallery-tag-service.js';
import { PRIVATE_FRAMING_ORIENTATION, exactFramingKeys, validatePrivateFramingFrames,
    canonicalPrivateFramingFrames, validPrivateFramingDimensions } from './private-gallery-framing.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha = /^[0-9a-f]{64}$/;
const publicId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const fail = status => ({ ok: false, status, code: 'private-framing-unavailable-or-changed' });
const fields = ['confirmed', 'expectedVersion', 'frames', 'idempotencyKey', 'imageHeight', 'imageWidth',
    'orientation', 'sourceSha256', 'tagVersion'];
const first = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).first();

async function source(env, identity, site, assetId) {
    const tags = await readPrivateGalleryTags(env, identity, site, assetId);
    if (!tags.ok) return tags;
    const owner = await hashIdentity(identity);
    const original = await first(env, `SELECT o.*, EXISTS(SELECT 1 FROM private_archive_deletion_requests d
        WHERE d.asset_id=o.asset_id) AS deleted FROM private_archive_original_receipts o
        JOIN private_gallery_assets a ON a.asset_id=o.asset_id WHERE o.asset_id=?1
        AND a.owner_identity_hash=?2 AND a.site_mode=?3`, assetId, owner, site);
    if (!original || original.deleted !== 0 || tags.correctionBlocked || !sha.test(original.sha256)) return fail(409);
    const current = await first(env, `SELECT * FROM private_gallery_frame_revisions
        WHERE asset_id=?1 ORDER BY version DESC LIMIT 1`, assetId);
    if (current && (!Number.isSafeInteger(current.version) || current.version < 1)) return fail(503);
    return { ok: true, tags, owner, original, current };
}

function safeState(assetId, selected) {
    const { tags, original, current } = selected;
    const stale = Boolean(current && (current.tag_version !== tags.tagVersion || current.source_sha256 !== original.sha256));
    let frames = {};
    if (current && !stale) {
        frames = JSON.parse(current.frames_json);
        if (current.orientation !== PRIVATE_FRAMING_ORIENTATION ||
            !validPrivateFramingDimensions(current.image_width, current.image_height) ||
            !validatePrivateFramingFrames(frames, tags.personIds) ||
            current.person_ids_json !== JSON.stringify(tags.personIds)) throw new Error('Invalid stored framing');
    }
    return { ok: true, status: 200, assetId, version: current?.version ?? 0, tagVersion: tags.tagVersion,
        sourceSha256: original.sha256, orientation: PRIVATE_FRAMING_ORIENTATION,
        imageWidth: current && !stale ? current.image_width : null,
        imageHeight: current && !stale ? current.image_height : null,
        frames, stale, publicationEnabled: false };
}

// The existing Worker owner/area-session/CSRF boundary must precede these helpers.
// They use D1 only, never read original pixels or grant publication permission.
export async function readPrivateGalleryFraming(env, identity, site, assetId) {
    try {
        const selected = await source(env, identity, site, assetId);
        return selected.ok ? safeState(assetId, selected) : selected;
    } catch { return fail(503); }
}

export async function savePrivateGalleryFraming(env, identity, site, assetId, input) {
    if (!exactFramingKeys(input, fields) || !uuid.test(input.idempotencyKey) || input.confirmed !== true ||
        !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || input.expectedVersion >= Number.MAX_SAFE_INTEGER ||
        !Number.isSafeInteger(input.tagVersion) || input.tagVersion < 1 ||
        typeof input.sourceSha256 !== 'string' || !sha.test(input.sourceSha256) ||
        input.orientation !== PRIVATE_FRAMING_ORIENTATION || !validPrivateFramingDimensions(input.imageWidth, input.imageHeight)) return fail(422);
    try {
        const selected = await source(env, identity, site, assetId);
        if (!selected.ok) return selected;
        if (!validatePrivateFramingFrames(input.frames, selected.tags.personIds)) return fail(422);
        const frames = canonicalPrivateFramingFrames(input.frames);
        const requestHash = await sha256Hex(new TextEncoder().encode(JSON.stringify([
            site, assetId, input.idempotencyKey, input.expectedVersion, input.tagVersion,
            input.sourceSha256, input.orientation, input.imageWidth, input.imageHeight, frames, true
        ])));
        const prior = () => first(env, 'SELECT * FROM private_gallery_frame_revisions WHERE idempotency_key=?1', input.idempotencyKey);
        const replay = async row => {
            const latest = await source(env, identity, site, assetId);
            if (!latest.ok || row.asset_id !== assetId || row.owner_hash !== selected.owner || row.request_hash !== requestHash ||
                latest.current?.version !== row.version || latest.tags.tagVersion !== row.tag_version ||
                latest.original.sha256 !== row.source_sha256) return fail(409);
            return { ...safeState(assetId, latest), replayed: true };
        };
        const existing = await prior();
        if (existing) return replay(existing);
        if ((selected.current?.version ?? 0) !== input.expectedVersion || selected.tags.tagVersion !== input.tagVersion ||
            selected.original.sha256 !== input.sourceSha256) return fail(409);
        try {
            const result = await env.DB.prepare(`INSERT INTO private_gallery_frame_revisions
                (asset_id,version,owner_hash,site_mode,idempotency_key,request_hash,tag_version,person_ids_json,
                 source_sha256,orientation,image_width,image_height,frames_json,confirmed)
                VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,1)`)
                .bind(assetId,input.expectedVersion+1,selected.owner,site,input.idempotencyKey,requestHash,input.tagVersion,
                    JSON.stringify(selected.tags.personIds),input.sourceSha256,input.orientation,input.imageWidth,input.imageHeight,
                    JSON.stringify(frames)).run();
            if (result?.success !== true) throw new Error('Unavailable');
        } catch {
            const recovered = await prior();
            return recovered ? replay(recovered) : fail(409);
        }
        const stored = await prior();
        if (!stored) return fail(503);
        const result = await replay(stored);
        return result.ok ? { ...result, status: 201, replayed: false } : result;
    } catch { return fail(503); }
}

export function privateGalleryAttemptFramingReplayInput(attemptRow) {
    return attemptRow.framing_version === null || attemptRow.framing_version === undefined
        ? {} : { framingVersion: attemptRow.framing_version };
}

// No current framing lookup: historical attempts keep their original snapshot.
// Caller separately verifies actual decoder orientation/dimensions before writes.
export async function readPrivateGalleryAttemptFraming(env, attemptRow) {
    if (!Object.hasOwn(attemptRow, 'framing_version')) return null; // pre-0029 schema
    const row = await first(env, 'SELECT * FROM private_gallery_attempt_framings WHERE attempt_id=?1', attemptRow.attempt_id);
    if (!row) {
        if (attemptRow.framing_version === null) return null; // genuine old attempt
        throw new Error('Missing immutable framing snapshot');
    }
    if (row.asset_id !== attemptRow.asset_id || row.version !== (attemptRow.framing_version ?? 0) ||
        row.tag_version !== attemptRow.tag_version || row.source_sha256 !== attemptRow.original_sha256 ||
        row.original_provider_version !== attemptRow.original_provider_version || row.original_provider_etag !== attemptRow.original_provider_etag ||
        row.person_ids_json !== attemptRow.person_ids_json || row.public_athlete_ids_json !== attemptRow.public_athlete_ids_json) {
        throw new Error('Immutable framing binding changed');
    }
    const privateFrames = JSON.parse(row.private_frames_json), projection = JSON.parse(row.person_projection_json);
    const personIds = JSON.parse(attemptRow.person_ids_json), publicIds = JSON.parse(attemptRow.public_athlete_ids_json);
    if (!validatePrivateFramingFrames(privateFrames, personIds) || !Array.isArray(projection) || projection.length !== personIds.length ||
        !Array.isArray(publicIds) || projection.some((entry, index) => !Array.isArray(entry) || entry.length !== 2 ||
            entry[0] !== personIds[index] || (entry[1] !== null && (typeof entry[1] !== 'string' || !publicId.test(entry[1])))) ||
        JSON.stringify(projection.filter(entry => entry[1] !== null).map(entry => entry[1])) !== JSON.stringify(publicIds)) {
        throw new Error('Framing projection changed');
    }
    const expected = Object.fromEntries(projection.filter(([personId, id]) => id !== null && Object.hasOwn(privateFrames, personId))
        .map(([personId, id]) => [id, privateFrames[personId]]));
    const actual = JSON.parse(row.public_frames_json);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Public framing projection changed');
    if (row.version === 0) {
        if (Object.keys(privateFrames).length || row.orientation !== null || row.image_width !== null || row.image_height !== null) {
            throw new Error('Empty framing snapshot changed');
        }
        return null;
    }
    const revision = await first(env, 'SELECT * FROM private_gallery_frame_revisions WHERE asset_id=?1 AND version=?2', row.asset_id, row.version);
    if (!revision || revision.tag_version !== row.tag_version || revision.source_sha256 !== row.source_sha256 ||
        revision.person_ids_json !== row.person_ids_json || revision.frames_json !== row.private_frames_json ||
        revision.orientation !== row.orientation || revision.image_width !== row.image_width || revision.image_height !== row.image_height ||
        row.orientation !== PRIVATE_FRAMING_ORIENTATION || !validPrivateFramingDimensions(row.image_width, row.image_height)) {
        throw new Error('Framing source changed');
    }
    return { version: row.version, tagVersion: row.tag_version, sourceSha256: row.source_sha256,
        orientation: row.orientation, imageWidth: row.image_width, imageHeight: row.image_height, podiumFraming: actual };
}
