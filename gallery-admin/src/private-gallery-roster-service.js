import { selectPrivateGalleryPeople } from './private-gallery-roster.js';

// One primary-database query reads the revision and the complete roster from the
// same snapshot. Never cache this private response or fall back to public data.
const readRosterSql = `
    SELECT v.generation, p.person_id, p.display_name, p.public_athlete_id,
        p.family, p.everyone
    FROM private_gallery_roster_version v
    LEFT JOIN private_gallery_people p ON 1 = 1
    WHERE v.singleton = 1
    ORDER BY p.person_id
    LIMIT 10001
`;

export async function readPrivateGalleryRoster(env, inheritedSite) {
    try {
        const { document } = await loadPrivateGalleryRoster(env, inheritedSite);
        return { ok: true, status: 200, ...selectPrivateGalleryPeople(document, inheritedSite) };
    } catch {
        // Do not return provider errors, names, IDs, raw rows or partial results.
        return { ok: false, status: 503, code: 'private-roster-unavailable' };
    }
}

// Internal writer input only. The browser never receives the generation or
// other area's people. SQL rechecks this generation at the actual write.
export async function loadPrivateGalleryRoster(env, inheritedSite) {
    const result = await env.DB.prepare(readRosterSql).all();
    if (result?.success !== true || !Array.isArray(result.results) ||
        result.results.length < 1 || result.results.length > 10000) {
        throw new Error('Private roster unavailable.');
    }
    const rows = result.results;
    const generation = rows[0].generation;
    if (!Number.isSafeInteger(generation) || generation < 1 ||
        rows.some(row => row.generation !== generation)) {
        throw new Error('Private roster revision unavailable.');
    }
    const empty = rows.length === 1 && rows[0].person_id === null &&
        ['display_name', 'public_athlete_id', 'family', 'everyone']
            .every(field => rows[0][field] === null);
    const people = empty ? [] : rows.map(row => {
        if (![0, 1].includes(row.family) || ![0, 1].includes(row.everyone)) {
            throw new Error('Invalid private roster membership.');
        }
        return {
            personId: row.person_id,
            displayName: row.display_name,
            sites: ['family', 'everyone'].filter(site => row[site] === 1),
            publicAthleteId: row.public_athlete_id
        };
    });
    const schemaVersion = 'private-gallery-roster-v1';
    // Validate the WHOLE catalogue before hashing or filtering the area.
    const document = { schemaVersion, revision: `sha256:${'0'.repeat(64)}`, people };
    selectPrivateGalleryPeople(document, inheritedSite);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
        JSON.stringify({ schemaVersion, generation, people })
    ));
    document.revision = `sha256:${[...new Uint8Array(digest)]
        .map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
    return { document, generation };
}
