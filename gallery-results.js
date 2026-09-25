(function (root, factory) {
    const contract = factory();
    if (typeof module === 'object' && module.exports) module.exports = contract;
    root.galleryResults = contract;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const legacyHeaders = ['AthleteID', 'Participant', 'Date', 'Distance', 'Time',
        'AgeGrade', 'Event', 'TimeClass', 'ExportBundleID'];
    const ageHeaders = [...legacyHeaders.slice(0, -1), 'AgeAtRace', 'ExportBundleID'];
    const agePattern = /^(?:0|[1-9][0-9]{0,2})$/;
    const validAge = value => agePattern.test(value) && Number(value) <= 130;
    const key = (id, date, event, distance) => JSON.stringify([id, date, event, distance]);

    function objects(rows, required, csvRowsToObjects) {
        const headers = rows[0] || [];
        if (new Set(headers).size !== headers.length || headers.some(h => !h || h !== h.trim()) ||
            required.some(h => !headers.includes(h)) ||
            rows.slice(1).some(row => row.length !== headers.length || row.every(cell => cell === ''))) {
            throw new Error('Invalid result CSV.');
        }
        // Conversion remains in utils.js; this wrapper only validates the shape.
        return csvRowsToObjects(rows);
    }

    // Date formatting only: never derive an age, grade or performance.
    function isoDate(value) {
        const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
        if (!match) throw new Error('Invalid exported result date.');
        const iso = `${match[3]}-${match[2]}-${match[1]}`;
        const date = new Date(`${iso}T00:00:00Z`);
        if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== iso) {
            throw new Error('Invalid exported result date.');
        }
        return iso;
    }

    function buildIndex(resultRows, rosterRows, manifestRows, site, csvRowsToObjects) {
        if (!['family', 'everyone'].includes(site)) throw new Error('Invalid site.');
        if (typeof csvRowsToObjects !== 'function') throw new Error('Shared CSV utility unavailable.');
        const header = resultRows[0] || [];
        if (![legacyHeaders, ageHeaders].some(expected => JSON.stringify(header) === JSON.stringify(expected))) {
            throw new Error('Unsupported results schema.');
        }
        const results = objects(resultRows, legacyHeaders, csvRowsToObjects);
        const roster = objects(rosterRows, ['AthleteId', 'ExportBundleID'], csvRowsToObjects);
        const manifest = objects(manifestRows,
            ['ExportBundleID', 'SchemaVersion', 'Scope', 'RelativePath', 'DataRowCount'], csvRowsToObjects);
        const bundle = manifest[0]?.ExportBundleID;
        if (!bundle || manifest.some(row => row.ExportBundleID !== bundle || row.SchemaVersion !== '1.0')) {
            throw new Error('Inconsistent export bundle.');
        }
        for (const [file, scope, rows] of [
            ['data/athlete_results.csv', 'shared', results],
            [`data/${site}/age_grade_standards.csv`, site, roster]
        ]) {
            const matches = manifest.filter(row => row.RelativePath === file && row.Scope === scope);
            if (matches.length !== 1 || matches[0].DataRowCount !== String(rows.length) ||
                rows.some(row => row.ExportBundleID !== bundle)) throw new Error('Stale result export.');
        }
        const allowedIds = new Set(roster.map(row => row.AthleteId));
        const names = new Map();
        const performances = new Map();
        for (const row of results) {
            if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.AthleteID) || !row.Participant.trim() ||
                !row.Event.trim() || !row.Distance.trim() ||
                !/^\d{2,}:[0-5]\d:[0-5]\d(?:\.\d{1,3})?$/.test(row.Time) ||
                !/^\d+(?:\.\d+)?%$/.test(row.AgeGrade) ||
                (header.includes('AgeAtRace') && !validAge(row.AgeAtRace))) {
                throw new Error('Invalid exported performance.');
            }
            const date = isoDate(row.Date);
            if (!allowedIds.has(row.AthleteID)) continue;
            if (names.has(row.AthleteID) && names.get(row.AthleteID) !== row.Participant) {
                throw new Error('Ambiguous athlete identity.');
            }
            names.set(row.AthleteID, row.Participant);
            const resultKey = key(row.AthleteID, date, row.Event, row.Distance);
            const matches = performances.get(resultKey) || [];
            matches.push(row);
            performances.set(resultKey, matches);
        }
        return Object.freeze({
            forPhoto(item) {
                return item.athleteIds.map(id => {
                    const matches = performances.get(key(id, item.raceDate, item.raceEvent, item.raceDistance)) || [];
                    const row = matches.length === 1 ? matches[0] : null;
                    return { name: names.get(id) || 'Athlete unavailable',
                        time: row?.Time || 'Unavailable', ageGrade: row?.AgeGrade || 'Unavailable',
                        age: row?.AgeAtRace || 'Unavailable' };
                });
            }
        });
    }
    return Object.freeze({ buildIndex, validAge });
});
