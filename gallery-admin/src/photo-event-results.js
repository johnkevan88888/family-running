// A result association is editorial metadata, not a result calculation. The
// common date/event and every athlete/distance pair must exist in this exact
// exported catalogue. People without a result remain complete private tags.
export function checkPhotoRaceResults(value, race, athleteIds, site) {
    if (!Array.isArray(value) || value.length > 100 || !race || !Array.isArray(site?.resultEntries)) {
        throw new Error('Photo event results unavailable');
    }
    const seen = new Set();
    for (const result of value) {
        if (!result || typeof result !== 'object' || Array.isArray(result) ||
            Object.keys(result).sort().join('|') !== 'athleteId|raceDistance' ||
            !athleteIds.includes(result.athleteId) || seen.has(result.athleteId) ||
            !site.resultEntries.some(row => row.athleteId === result.athleteId &&
                row.raceDate === race.raceDate && row.raceEvent === race.raceEvent && row.raceDistance === result.raceDistance)) {
            throw new Error('Photo event result changed');
        }
        seen.add(result.athleteId);
    }
    return value.map(({athleteId,raceDistance}) => ({athleteId,raceDistance}));
}

export function photoRaceResultsReplay(row) {
    return row.race_results_json == null ? {} : {raceResults: JSON.parse(row.race_results_json)};
}

export function projectFamilyRunnerResults(photo, roster, catalog, {allowIncomplete=false}={}) {
    if (!Object.hasOwn(photo, 'runnerResults')) return {};
    if (!Array.isArray(photo.runnerResults) || photo.runnerResults.length > 100) throw new Error('Invalid runners');
    const race = catalog.sites.family.catalog.races[photo.raceIndex], seen = new Set();
    const raceResults = photo.runnerResults.map(result => {
        if (!result || typeof result !== 'object' || Array.isArray(result) ||
            Object.keys(result).sort().join('|') !== 'personId|raceIndex' ||
            !photo.personIds.includes(result.personId) || seen.has(result.personId) ||
            !(allowIncomplete && result.raceIndex === null) && (!Number.isSafeInteger(result.raceIndex) || result.raceIndex < 0)) throw new Error('Invalid runner');
        seen.add(result.personId);
        const person = roster.people.find(person => person.personId === result.personId);
        if (allowIncomplete && result.raceIndex === null && person?.publicAthleteId && race &&
            catalog.sites.family.resultEntries.some(row => row.athleteId === person.publicAthleteId && row.raceDate === race.raceDate && row.raceEvent === race.raceEvent)) return null;
        const selected = catalog.sites.family.catalog.races[result.raceIndex];
        if (!person?.publicAthleteId || !race || !selected || selected.raceDate !== race.raceDate || selected.raceEvent !== race.raceEvent) {
            throw new Error('Runner is not in this event');
        }
        return {athleteId: person.publicAthleteId, raceDistance: selected.raceDistance};
    }).filter(Boolean);
    // An empty, unfinished card can be saved before the event is chosen.
    if (raceResults.length || race) checkPhotoRaceResults(raceResults, race, raceResults.map(r => r.athleteId), catalog.sites.family);
    return {raceResults};
}
