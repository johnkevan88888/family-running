import '../../gallery-contract.js';
import { hashIdentity } from './session.js';
import { sha256Hex } from './media-byte-verification.js';
import { loadPrivateGalleryRoster } from './private-gallery-roster-service.js';
import { resolvePrivateGalleryTags, selectPrivateGalleryPeople } from './private-gallery-roster.js';
import { readPrivateGalleryAsset } from './private-gallery-asset-service.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const failure = status => ({ok:false,status,code:'private-gallery-unavailable-or-changed'});
const exact = (input, keys) => input && typeof input === 'object' && !Array.isArray(input) &&
    Object.keys(input).sort().join('|') === [...keys].sort().join('|');
const contextValid = (identity,site) => identity?.type === 'browser' && typeof identity.subject === 'string' &&
    identity.subject.trim().length > 0 && ['family','everyone'].includes(site);
const fingerprint = input => sha256Hex(new TextEncoder().encode(JSON.stringify(input)));

// Explicit creation, never an import/name join against a private workbook.
// The inherited area and optional public mapping are checked server-side.
export async function createPrivateGalleryPerson(env,identity,site,input,catalog) {
    if (!contextValid(identity,site)) return failure(403);
    if (!exact(input,['idempotencyKey','rosterRevision','displayName','publicAthleteId']) ||
        !uuid.test(input.idempotencyKey) || typeof input.displayName !== 'string' ||
        input.displayName !== input.displayName.trim() || !input.displayName || input.displayName.length > 200 ||
        /[\u0000-\u001f\u007f]/u.test(input.displayName) ||
        !(input.publicAthleteId === null || typeof input.publicAthleteId === 'string' &&
          catalog?.sites?.[site]?.catalog?.athleteIds?.includes(input.publicAthleteId))) return failure(422);
    try {
        const owner = await hashIdentity(identity);
        const hash = await fingerprint([site,input.rosterRevision,input.displayName,input.publicAthleteId]);
        const prior = () => env.DB.prepare('SELECT * FROM private_gallery_person_requests WHERE idempotency_key = ?1')
            .bind(input.idempotencyKey).first();
        const replay = row => row.actor_identity_hash === owner && row.request_hash === hash
            ? {ok:true,status:200,personId:row.person_id,replayed:true} : failure(409);
        const existing = await prior();
        if (existing) return replay(existing);
        const {document,generation} = await loadPrivateGalleryRoster(env,site);
        if (document.revision !== input.rosterRevision) return failure(409);
        const personId = `person_${crypto.randomUUID()}`;
        try {
            const result = await env.DB.batch([
                env.DB.prepare(`INSERT INTO private_gallery_person_requests
                    (idempotency_key,person_id,actor_identity_hash,request_hash,roster_generation) VALUES (?1,?2,?3,?4,?5)`)
                    .bind(input.idempotencyKey,personId,owner,hash,generation),
                env.DB.prepare(`INSERT INTO private_gallery_people
                    (person_id,display_name,public_athlete_id,family,everyone) VALUES (?1,?2,?3,?4,?5)`)
                    .bind(personId,input.displayName,input.publicAthleteId,Number(site==='family'),Number(site==='everyone'))
            ]);
            if (!Array.isArray(result) || result.length !== 2 || result.some(row=>row?.success !== true)) throw new Error('Unavailable');
        } catch {
            const recovered = await prior();
            return recovered ? replay(recovered) : failure(409);
        }
        const stored = await prior();
        return stored?.person_id === personId && stored.request_hash === hash
            ? {ok:true,status:201,personId,replayed:false} : failure(503);
    } catch { return failure(503); }
}

export async function readPrivateGalleryVisibility(env,identity,site,personId) {
    if (!contextValid(identity,site)) return failure(403);
    try {
        const {document} = await loadPrivateGalleryRoster(env,site);
        resolvePrivateGalleryTags(document,site,[personId],document.revision);
        const row = await env.DB.prepare(`SELECT version,preference FROM private_gallery_current_visibility WHERE person_id = ?1`)
            .bind(personId).first();
        if (!Number.isSafeInteger(row?.version) || row.version < 1 || !['hidden','allowed'].includes(row.preference)) return failure(503);
        return {ok:true,status:200,personId,version:row.version,preference:row.preference};
    } catch { return failure(503); }
}

// One bounded whole-roster preference read, not N full-roster reads for N
// displayed people. Validate every area before returning the inherited area.
export async function readPrivateGalleryPreferences(env,identity,site) {
    if (!contextValid(identity,site)) return failure(403);
    try {
        const {document} = await loadPrivateGalleryRoster(env,site);
        const result = await env.DB.prepare(`SELECT p.person_id,v.version,v.preference
            FROM private_gallery_people p LEFT JOIN private_gallery_current_visibility v ON v.person_id = p.person_id
            ORDER BY p.person_id LIMIT 10001`).all();
        const rows = result?.results;
        if (result?.success !== true || !Array.isArray(rows) || rows.length !== document.people.length ||
            rows.some((row,index)=>row.person_id !== document.people[index].personId ||
                !Number.isSafeInteger(row.version) || row.version < 1 || !['hidden','allowed'].includes(row.preference))) return failure(503);
        if ((await loadPrivateGalleryRoster(env,site)).document.revision !== document.revision) return failure(409);
        const byId = new Map(rows.map(row=>[row.person_id,row]));
        const selected = selectPrivateGalleryPeople(document,site);
        return {ok:true,status:200,revision:selected.revision,people:selected.people.map(person=>({...person,
            version:byId.get(person.personId).version,preference:byId.get(person.personId).preference}))};
    } catch { return failure(503); }
}

export async function changePrivateGalleryVisibility(env,identity,site,personId,input) {
    if (!contextValid(identity,site)) return failure(403);
    if (!exact(input,['expectedVersion','idempotencyKey','preference']) || !uuid.test(input.idempotencyKey) ||
        !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 ||
        !['hidden','allowed'].includes(input.preference)) return failure(422);
    try {
        const current = await readPrivateGalleryVisibility(env,identity,site,personId);
        if (!current.ok) return current;
        const owner = await hashIdentity(identity);
        const hash = await fingerprint([site,personId,input.expectedVersion,input.preference]);
        const prior = () => env.DB.prepare('SELECT * FROM private_gallery_visibility_events WHERE idempotency_key = ?1')
            .bind(input.idempotencyKey).first();
        const replay = row => row.person_id === personId && row.actor_identity_hash === owner && row.request_hash === hash &&
            row.version === current.version ? {...current,replayed:true} : failure(409);
        const existing = await prior();
        if (existing) return replay(existing);
        if (current.version !== input.expectedVersion) return failure(409);
        const {document,generation} = await loadPrivateGalleryRoster(env,site);
        resolvePrivateGalleryTags(document,site,[personId],document.revision);
        try {
            const result = await env.DB.prepare(`INSERT INTO private_gallery_visibility_events
                (person_id,version,preference,idempotency_key,actor_identity_hash,request_hash,site_mode,roster_generation)
                VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`)
                .bind(personId,input.expectedVersion+1,input.preference,input.idempotencyKey,owner,hash,site,generation).run();
            if (result?.success !== true) throw new Error('Unavailable');
        } catch {
            const recovered = await prior();
            const latest = await readPrivateGalleryVisibility(env,identity,site,personId);
            return recovered?.person_id === personId && recovered.actor_identity_hash === owner && recovered.request_hash === hash &&
                latest.ok && latest.version === recovered.version ? {...latest,replayed:true} : failure(409);
        }
        return readPrivateGalleryVisibility(env,identity,site,personId);
    } catch { return failure(503); }
}

// Read-only complete-tag eligibility. A preference is not consent, and this
// result never grants processing, public storage, PR creation or publication.
export async function readPrivateGalleryAssetEligibility(env,identity,site,assetId,catalog) {
    if (!contextValid(identity,site)) return failure(403);
    try {
        const saved = await readPrivateGalleryAsset(env,identity,site,assetId);
        if (!saved.ok) return saved;
        const {document} = await loadPrivateGalleryRoster(env,site);
        const people = resolvePrivateGalleryTags(document,site,saved.asset.personIds,document.revision);
        const result = await env.DB.prepare(`SELECT t.person_id,t.ordinal,v.version,v.preference,s.tag_version
            FROM private_gallery_current_asset_tags t JOIN private_gallery_current_tag_sets s ON s.asset_id = t.asset_id
            LEFT JOIN private_gallery_current_visibility v ON v.person_id = t.person_id
            WHERE t.asset_id = ?1 ORDER BY t.ordinal LIMIT 101`).bind(assetId).all();
        const rows = result?.results;
        if (result?.success !== true || !Array.isArray(rows) || rows.length !== people.length ||
            rows.some((row,index)=>row.person_id !== people[index].personId || row.ordinal !== index ||
                !Number.isSafeInteger(row.version) || row.version < 1 || !['hidden','allowed'].includes(row.preference) ||
                !Number.isSafeInteger(row.tag_version) || row.tag_version < 1 || row.tag_version !== rows[0].tag_version)) return failure(503);
        const publicRoster = catalog?.sites?.[site]?.catalog?.athleteIds;
        const hidden = catalog?.suppressionDocument?.hiddenAthleteIds;
        if (!Array.isArray(publicRoster) || globalThis.galleryContract?.validateGallerySuppressionDocument(catalog.suppressionDocument).length !== 0 ||
            !Array.isArray(hidden)) return failure(503);
        const pending = await env.DB.prepare('SELECT athlete_id FROM pending_athlete_exclusions WHERE resolved_at IS NULL').all();
        if (pending?.success !== true || !Array.isArray(pending.results) ||
            pending.results.some(row=>typeof row.athlete_id !== 'string')) return failure(503);
        const blockedIds = new Set([...hidden,...pending.results.map(row=>row.athlete_id)]);
        // Do not silently remap a stale public identity or expose private names.
        if (people.some(person=>person.publicAthleteId !== null && !publicRoster.includes(person.publicAthleteId))) return failure(409);
        const blocked = people.some((person,index)=>rows[index].preference !== 'allowed' || blockedIds.has(person.publicAthleteId));
        const finalRoster = await loadPrivateGalleryRoster(env,site);
        if (finalRoster.document.revision !== document.revision) return failure(409);
        const revision = `sha256:${await fingerprint([document.revision,rows[0].tag_version,rows.map(row=>[row.person_id,row.version,row.preference]),
            catalog.sourceRevision,catalog.suppressionRevision,[...blockedIds].sort()])}`;
        return {ok:true,status:200,assetId,revision,visibilityEligible:!blocked,
            publicAthleteIds:people.flatMap(person=>person.publicAthleteId === null ? [] : [person.publicAthleteId]),
            requiresFreshPublicConsent:true,publicationEnabled:false};
    } catch { return failure(503); }
}
