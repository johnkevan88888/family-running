// Owner-only catalogue contract. Never include its data in a public manifest or
// generated source file. This module does not grant consent or publication rights.
const personIdPattern = /^person_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const publicIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const sites = new Set(['family', 'everyone']);

function requireShape(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).sort().join('|') !== [...fields].sort().join('|')) {
        throw new Error('Invalid private Gallery catalogue shape.');
    }
}

export function selectPrivateGalleryPeople(document, inheritedSite) {
    if (!sites.has(inheritedSite)) throw new Error('Invalid inherited Gallery area.');
    requireShape(document, ['schemaVersion', 'revision', 'people']);
    if (document.schemaVersion !== 'private-gallery-roster-v1' || typeof document.revision !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/.test(document.revision) ||
        !Array.isArray(document.people) || document.people.length > 10000) {
        throw new Error('Invalid private Gallery catalogue contract.');
    }
    const privateIds = new Set(), publicIds = new Set(), people = [];
    for (const person of document.people) {
        requireShape(person, ['personId', 'displayName', 'sites', 'publicAthleteId']);
        if (typeof person.personId !== 'string' || !personIdPattern.test(person.personId) ||
            privateIds.has(person.personId) || typeof person.displayName !== 'string' ||
            person.displayName !== person.displayName.trim() || !person.displayName ||
            person.displayName.length > 200 || /[\u0000-\u001f\u007f]/u.test(person.displayName) ||
            !Array.isArray(person.sites) || person.sites.length < 1 || person.sites.length > 2 ||
            new Set(person.sites).size !== person.sites.length || person.sites.some(site => !sites.has(site))) {
            throw new Error('Invalid private Gallery person.');
        }
        if (person.publicAthleteId !== null &&
            (typeof person.publicAthleteId !== 'string' || person.publicAthleteId.length > 128 || !publicIdPattern.test(person.publicAthleteId) ||
                publicIds.has(person.publicAthleteId))) {
            throw new Error('Invalid private-to-public Gallery mapping.');
        }
        privateIds.add(person.personId);
        if (person.publicAthleteId !== null) publicIds.add(person.publicAthleteId);
        // Public-result membership is deliberately not a selection condition.
        if (person.sites.includes(inheritedSite)) people.push(Object.freeze({
            personId: person.personId, displayName: person.displayName,
            publicAthleteId: person.publicAthleteId
        }));
    }
    return Object.freeze({revision: document.revision, people: Object.freeze(people)});
}

export function resolvePrivateGalleryTags(document, inheritedSite, personIds, expectedRevision) {
    const selection = selectPrivateGalleryPeople(document, inheritedSite);
    if (selection.revision !== expectedRevision) throw new Error('Stale private Gallery catalogue.');
    if (!Array.isArray(personIds) || personIds.length < 1 || personIds.length > 100 ||
        new Set(personIds).size !== personIds.length) throw new Error('Invalid private Gallery tags.');
    const byId = new Map(selection.people.map(person => [person.personId, person]));
    const resolved = personIds.map(personId => {
        if (typeof personId !== 'string' || !byId.has(personId)) {
            throw new Error('Unknown or ineligible private Gallery person.');
        }
        return byId.get(personId);
    });
    // Never silently drop an unknown/non-public person or join by display name.
    return Object.freeze(resolved);
}
