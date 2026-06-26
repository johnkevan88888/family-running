import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = path.join(repoRoot, 'data');
const siteModes = ['family', 'everyone'];
const errors = [];
const warnings = [];
const csvCache = new Map();

const athleteRows = readCsvRequired('data/athlete_results.csv', [
    'AthleteID',
    'Participant',
    'Date',
    'Distance',
    'Time',
    'AgeGrade',
    'Event',
    'TimeClass'
]);
const athleteObjects = toObjects(athleteRows, 'data/athlete_results.csv');
const athleteIds = new Set();

for (const row of athleteObjects) {
    const rowNumber = row.__rowNumber;

    requireValue(row.AthleteID, 'data/athlete_results.csv', rowNumber, 'AthleteID');
    requireValue(row.Participant, 'data/athlete_results.csv', rowNumber, 'Participant');
    validateDate(row.Date, 'data/athlete_results.csv', rowNumber, 'Date', { required: true });
    validateTime(row.Time, 'data/athlete_results.csv', rowNumber, 'Time', { required: true });
    validatePercent(row.AgeGrade, 'data/athlete_results.csv', rowNumber, 'AgeGrade', { required: true });

    if (row.AthleteID) {
        if (athleteIds.has(row.AthleteID)) {
            // Multiple rows per athlete are expected.
        }
        athleteIds.add(row.AthleteID);
    }
}

if (athleteIds.size === 0) {
    addError('data/athlete_results.csv', 1, 'No athlete IDs found.');
}

for (const siteMode of siteModes) {
    validateSite(siteMode);
}

if (warnings.length) {
    console.warn('CSV validation warnings:');
    for (const warning of warnings) {
        console.warn(`- ${warning}`);
    }
}

if (errors.length) {
    console.error('CSV validation failed:');
    for (const error of errors) {
        console.error(`- ${error}`);
    }
    process.exit(1);
}

console.log(`CSV validation passed for ${siteModes.map(mode => `data/${mode}/`).join(' and ')}.`);

function validateSite(siteMode) {
    const siteDir = `data/${siteMode}`;

    if (!fs.existsSync(path.join(repoRoot, siteDir))) {
        addError(siteDir, 1, 'Required site data directory is missing.');
        return;
    }

    const webtablesRows = readCsvRequired(`${siteDir}/webtables.csv`, [
        'SortOrder',
        'TimeClass',
        'DisplayDistance',
        'DisplayTitle',
        'DisplayDescription',
        'FileName',
        'Enabled'
    ]);
    const webtables = toObjects(webtablesRows, `${siteDir}/webtables.csv`);

    if (webtables.length === 0) {
        addError(`${siteDir}/webtables.csv`, 1, 'webtables.csv must include at least one table row.');
    }

    for (const row of webtables) {
        validateNumber(row.SortOrder, `${siteDir}/webtables.csv`, row.__rowNumber, 'SortOrder', { required: true });
        validateAllowed(row.TimeClass, ['All', 'Official'], `${siteDir}/webtables.csv`, row.__rowNumber, 'TimeClass');
        validateBoolean(row.Enabled, `${siteDir}/webtables.csv`, row.__rowNumber, 'Enabled');
        requireValue(row.FileName, `${siteDir}/webtables.csv`, row.__rowNumber, 'FileName');
        validateLeaderboardDisplayLabels(row, siteMode, `${siteDir}/webtables.csv`);
    }

    const siteInfoRows = readCsvRequired(`${siteDir}/siteinfo.csv`, ['Label', 'Value']);
    const siteInfo = toObjects(siteInfoRows, `${siteDir}/siteinfo.csv`);
    const siteInfoMap = new Map(siteInfo.map(row => [row.Label, row]));
    const requiredSiteInfoLabels = ['LastUpdatedUTC', 'PublishedFrom', 'SiteVersion', 'SiteName'];

    for (const label of requiredSiteInfoLabels) {
        if (!siteInfoMap.has(label)) {
            addError(`${siteDir}/siteinfo.csv`, 1, `Missing required siteinfo label "${label}".`);
        }
    }

    if (siteInfoMap.has('LastUpdatedUTC')) {
        validateIsoDate(siteInfoMap.get('LastUpdatedUTC').Value, `${siteDir}/siteinfo.csv`, siteInfoMap.get('LastUpdatedUTC').__rowNumber, 'Value');
    }

    validateLeaderboardIndex(siteDir, siteMode, webtables);
    validateHallOfFame(siteDir, siteMode, webtables);
    validateOfficialMedals(siteDir, siteMode, webtables);
    validateCrownStandards(siteDir);
    validateAgeGradeStandards(siteDir);

    const enabledTables = webtables.filter(row => String(row.Enabled || '').toUpperCase() === 'TRUE');

    if (enabledTables.length === 0) {
        addError(`${siteDir}/webtables.csv`, 1, 'At least one enabled leaderboard table is required.');
    }

    for (const row of enabledTables) {
        validateLeaderboardFile(siteDir, row.FileName, row.__rowNumber);
    }

    validateEveryCsvInFolder(siteDir);
}

function validateHallOfFame(siteDir, siteMode, webtables) {
    const file = `${siteDir}/halloffame.csv`;
    const rows = readCsvRequired(file, [
        'Award',
        'Participant',
        'Distance',
        'Time',
        'AgeGrade',
        'Date',
        'Event',
        'Athlete ID',
        'AgeClass'
    ]);
    const objects = toObjects(rows, file);

    if (objects.length === 0) {
        addError(file, 1, 'Hall of Fame must not be empty.');
    }

    for (const row of objects) {
        requireValue(row.Award, file, row.__rowNumber, 'Award');
        requireValue(row.Participant, file, row.__rowNumber, 'Participant');

        const vacant = isVacantParticipant(row.Participant);
        if (vacant) {
            continue;
        }

        validateDate(row.Date, file, row.__rowNumber, 'Date');
        validateTime(row.Time, file, row.__rowNumber, 'Time');
        validatePercent(row.AgeGrade, file, row.__rowNumber, 'AgeGrade');
        validateAthleteId(row['Athlete ID'], file, row.__rowNumber, 'Athlete ID', { required: true });
    }

    validateHallOfFameAgainstOfficialLeaderboards(siteDir, siteMode, webtables, objects);
}

function validateHallOfFameAgainstOfficialLeaderboards(siteDir, siteMode, webtables, hallRows) {
    const file = `${siteDir}/halloffame.csv`;
    const rowsByAward = new Map();

    for (const row of hallRows) {
        const award = String(row.Award || '').trim();

        if (rowsByAward.has(award)) {
            addError(file, row.__rowNumber, `Duplicate Hall of Fame award "${award}".`);
            continue;
        }

        rowsByAward.set(award, row);
    }

    for (const expected of expectedHallOfFameRows(siteDir, siteMode, webtables)) {
        const actual = rowsByAward.get(expected.Award);

        if (!actual) {
            addError(file, 1, `Missing Hall of Fame row for "${expected.Award}".`);
            continue;
        }

        compareExportedValue(actual.Participant, expected.Participant, file, actual.__rowNumber, 'Participant', expected.Award);

        if (expected.Vacant) {
            continue;
        }

        compareExportedValue(canonicalDistanceLabel(actual.Distance), expected.Distance, file, actual.__rowNumber, 'Distance', expected.Award);
        compareExportedValue(actual.Time, expected.Time, file, actual.__rowNumber, 'Time', expected.Award);
        compareExportedValue(actual.AgeGrade, expected.AgeGrade, file, actual.__rowNumber, 'AgeGrade', expected.Award);
        compareExportedValue(actual.Date, expected.Date, file, actual.__rowNumber, 'Date', expected.Award);
        compareExportedValue(actual['Athlete ID'], expected.AthleteId, file, actual.__rowNumber, 'Athlete ID', expected.Award);
        compareExportedValue(actual.AgeClass, expected.AgeClass, file, actual.__rowNumber, 'AgeClass', expected.Award);
    }
}

function expectedHallOfFameRows(siteDir, siteMode, webtables) {
    const webtableByFile = new Map(
        webtables.map(row => [String(row.FileName || '').trim(), row])
    );
    const expected = [];

    for (const sourceFile of discoverOfficialLeaderboardExports(siteDir, siteMode, webtables)) {
        const sourcePath = `${siteDir}/${sourceFile}`;
        const metadata = leaderboardMedalMetadata(sourceFile, webtableByFile.get(sourceFile), siteMode);
        const rows = toObjects(readCsvRequired(sourcePath, [
            'Rank',
            'Participant',
            'Race Year',
            'Time Class',
            'SexAgeEvent',
            'Time',
            'Age Graded Score',
            'Age Graded Category',
            'Athlete ID'
        ]));
        const award = `${metadata.Period} ${hallOfFameAwardDistance(metadata.Distance)} Official Champion`;
        const champion = rows.find(row => Number(row.Rank) === 1 && !isNoEligibleRow(row) && !isVacantParticipant(row.Participant));

        if (!champion) {
            expected.push({
                Award: award,
                Participant: 'Championship Vacant',
                Vacant: true
            });
            continue;
        }

        const result = findMatchingAthleteResult(champion);
        const ageClass = String(champion.SexAgeEvent || '').split('|')[0] || '';

        if (!result) {
            addError(sourcePath, champion.__rowNumber, `Could not find a matching athlete result for Hall of Fame award "${award}".`);
        }

        expected.push({
            Award: award,
            Participant: String(champion.Participant || '').trim(),
            Distance: metadata.Distance === 'Overall'
                ? canonicalDistanceLabel(distanceFromSexAgeEvent(champion.SexAgeEvent))
                : canonicalDistanceLabel(metadata.Distance),
            Time: String(champion.Time || '').trim(),
            AgeGrade: String(champion['Age Graded Score'] || '').trim(),
            Date: result ? result.Date : '',
            AthleteId: String(champion['Athlete ID'] || '').trim(),
            AgeClass: ageClass,
            Vacant: false
        });
    }

    return expected;
}

function hallOfFameAwardDistance(distance) {
    const label = canonicalDistanceLabel(distance);

    if (label === '5 km') {
        return '5k';
    }

    if (label === '10 km') {
        return '10k';
    }

    return label;
}

function validateOfficialMedals(siteDir, siteMode, webtables) {
    const file = `${siteDir}/official_medals.csv`;
    const rows = readCsvRequired(file, [
        'AthleteId',
        'Medal',
        'Place',
        'Period',
        'Distance',
        'AwardTitle',
        'Time',
        'AgeGrade',
        'EventDate',
        'EventName',
        'SortOrder'
    ]);

    const medalRows = toObjects(rows, file);

    for (const row of medalRows) {
        validateAthleteId(row.AthleteId, file, row.__rowNumber, 'AthleteId', { required: true });
        validateNumber(row.Place, file, row.__rowNumber, 'Place', { required: true });
        validateNumber(row.SortOrder, file, row.__rowNumber, 'SortOrder', { required: true });
        validateDate(row.EventDate, file, row.__rowNumber, 'EventDate');
        validateTime(row.Time, file, row.__rowNumber, 'Time');
        validatePercent(row.AgeGrade, file, row.__rowNumber, 'AgeGrade');
    }

    validateOfficialMedalsAgainstLeaderboardExports(siteDir, siteMode, webtables, medalRows);
}

function validateLeaderboardIndex(siteDir, siteMode, webtables) {
    const referencedFiles = new Set(
        webtables
            .map(row => String(row.FileName || '').trim())
            .filter(Boolean)
    );
    const absoluteDir = path.join(repoRoot, siteDir);
    const leaderboardFiles = fs.readdirSync(absoluteDir)
        .filter(fileName => Boolean(parseLeaderboardExportFileName(fileName, siteMode)));

    for (const fileName of leaderboardFiles) {
        if (!referencedFiles.has(fileName)) {
            addError(`${siteDir}/webtables.csv`, 1, `Leaderboard export "${fileName}" exists but is not referenced by webtables.csv.`);
        }
    }
}

function validateLeaderboardDisplayLabels(row, siteMode, file) {
    const parsed = parseLeaderboardExportFileName(row.FileName, siteMode);

    if (parsed?.distance !== '10mile') {
        return;
    }

    for (const field of ['DisplayDistance', 'DisplayTitle', 'DisplayDescription']) {
        const value = String(row[field] || '');

        if (value.includes('10mile') || !value.includes('10 Mile')) {
            addError(file, row.__rowNumber, `${field} must display "10 Mile" for 10 Mile leaderboards.`);
        }
    }
}

function validateOfficialMedalsAgainstLeaderboardExports(siteDir, siteMode, webtables, medalRows) {
    const file = `${siteDir}/official_medals.csv`;
    const actualMedalsByKey = new Map();
    const expectedMedalsByKey = new Map();

    for (const row of medalRows) {
        const key = officialMedalKey(row.Period, row.Distance, row.Place);

        if (actualMedalsByKey.has(key)) {
            addError(file, row.__rowNumber, `Duplicate official medal row for ${medalContext(row)}.`);
            continue;
        }

        actualMedalsByKey.set(key, row);
    }

    for (const expected of expectedOfficialMedals(siteDir, siteMode, webtables)) {
        expectedMedalsByKey.set(expected.key, expected);
        const actual = actualMedalsByKey.get(expected.key);

        if (!actual) {
            addError(file, 1, `Missing official medal row for ${expected.context}.`);
            continue;
        }

        compareExportedValue(actual.AthleteId, expected.AthleteId, file, actual.__rowNumber, 'AthleteId', expected.context);
        compareExportedValue(actual.Medal, expected.Medal, file, actual.__rowNumber, 'Medal', expected.context);
        compareExportedValue(Number(actual.Place), expected.Place, file, actual.__rowNumber, 'Place', expected.context);
        compareExportedValue(canonicalPeriodLabel(actual.Period), expected.Period, file, actual.__rowNumber, 'Period', expected.context);
        compareExportedValue(canonicalDistanceLabel(actual.Distance), expected.Distance, file, actual.__rowNumber, 'Distance', expected.context);
        compareExportedValue(actual.AwardTitle, expected.AwardTitle, file, actual.__rowNumber, 'AwardTitle', expected.context);
        compareExportedValue(actual.Time, expected.Time, file, actual.__rowNumber, 'Time', expected.context);
        compareExportedValue(actual.AgeGrade, expected.AgeGrade, file, actual.__rowNumber, 'AgeGrade', expected.context);
        compareExportedValue(Number(actual.SortOrder), expected.SortOrder, file, actual.__rowNumber, 'SortOrder', expected.context);

        if (expected.EventDate) {
            compareExportedValue(actual.EventDate, expected.EventDate, file, actual.__rowNumber, 'EventDate', expected.context);
        }

        if (expected.EventName) {
            compareExportedValue(actual.EventName, expected.EventName, file, actual.__rowNumber, 'EventName', expected.context);
        }
    }

    for (const [key, actual] of actualMedalsByKey) {
        if (!expectedMedalsByKey.has(key)) {
            addError(file, actual.__rowNumber, `Unexpected official medal row for ${medalContext(actual)}.`);
        }
    }
}

function expectedOfficialMedals(siteDir, siteMode, webtables) {
    const webtableByFile = new Map(
        webtables.map(row => [String(row.FileName || '').trim(), row])
    );
    const sourceFiles = discoverOfficialLeaderboardExports(siteDir, siteMode, webtables);
    const expected = [];

    for (const sourceFile of sourceFiles) {
        const sourcePath = `${siteDir}/${sourceFile}`;
        const metadata = leaderboardMedalMetadata(sourceFile, webtableByFile.get(sourceFile), siteMode);
        const rows = readCsvRequired(sourcePath, [
            'Rank',
            'Participant',
            'Race Year',
            'Time Class',
            'SexAgeEvent',
            'Time',
            'Age Graded Score',
            'Age Graded Category',
            'Athlete ID'
        ]);

        for (const row of toObjects(rows, sourcePath)) {
            const place = Number(row.Rank);

            if (![1, 2, 3].includes(place) || isNoEligibleRow(row) || isVacantParticipant(row.Participant)) {
                continue;
            }

            const medal = medalNameForPlace(place);
            const result = findMatchingAthleteResult(row);
            const context = `${metadata.Period} ${metadata.Distance} place ${place} from ${sourceFile}`;

            if (!result) {
                addError(sourcePath, row.__rowNumber, `Could not find a matching athlete result for ${context}.`);
            }

            expected.push({
                key: officialMedalKey(metadata.Period, metadata.Distance, place),
                context,
                AthleteId: String(row['Athlete ID'] || '').trim(),
                Medal: medal,
                Place: place,
                Period: metadata.Period,
                Distance: metadata.Distance,
                AwardTitle: `${metadata.Period} ${metadata.Distance} Official ${medal}`,
                Time: String(row.Time || '').trim(),
                AgeGrade: String(row['Age Graded Score'] || '').trim(),
                EventDate: result ? result.Date : '',
                EventName: result ? result.Event : '',
                SortOrder: (metadata.SortOrder * 10) + place
            });
        }
    }

    return expected;
}

function discoverOfficialLeaderboardExports(siteDir, siteMode, webtables) {
    const sourceFiles = new Set();

    for (const row of webtables) {
        const fileName = String(row.FileName || '').trim();
        const parsed = parseLeaderboardExportFileName(fileName, siteMode);

        if (parsed && parsed.timeClass === 'official') {
            sourceFiles.add(fileName);
        }
    }

    const absoluteDir = path.join(repoRoot, siteDir);

    for (const fileName of fs.readdirSync(absoluteDir)) {
        const parsed = parseLeaderboardExportFileName(fileName, siteMode);

        if (parsed && parsed.timeClass === 'official') {
            sourceFiles.add(fileName);
        }
    }

    return [...sourceFiles].sort((a, b) =>
        leaderboardMedalMetadata(a, null, siteMode).SortOrder - leaderboardMedalMetadata(b, null, siteMode).SortOrder
    );
}

function leaderboardMedalMetadata(fileName, webtableRow, siteMode) {
    const parsed = parseLeaderboardExportFileName(fileName, siteMode);
    const period = canonicalPeriodLabel(webtableRow?.DisplayTitle) || periodLabelFromSlug(parsed?.period);
    const distance = canonicalDistanceLabel(webtableRow?.DisplayDistance || parsed?.distance);
    const sortOrder = Number(webtableRow?.SortOrder);

    return {
        Period: period,
        Distance: distance,
        SortOrder: Number.isFinite(sortOrder) ? sortOrder : fallbackLeaderboardSortOrder(parsed)
    };
}

function parseLeaderboardExportFileName(fileName, siteMode) {
    const match = /^(overall|5km|10km|10mile|halfmarathon|marathon)-(current|alltime)-(all|official)-([a-z]+)\.csv$/i.exec(String(fileName || '').trim());

    if (!match || match[4].toLowerCase() !== siteMode) {
        return null;
    }

    return {
        distance: match[1].toLowerCase(),
        period: match[2].toLowerCase(),
        timeClass: match[3].toLowerCase()
    };
}

function fallbackLeaderboardSortOrder(parsed) {
    if (!parsed) {
        return 9999;
    }

    const distanceSort = {
        overall: 10,
        marathon: 20,
        halfmarathon: 30,
        '10mile': 40,
        '10km': 50,
        '5km': 60
    };
    const base = distanceSort[parsed.distance] ?? 999;

    return parsed.period === 'alltime' ? base + 1 : base;
}

function findMatchingAthleteResult(leaderboardRow) {
    const athleteId = String(leaderboardRow['Athlete ID'] || '').trim();
    const resultDistance = distanceFromSexAgeEvent(leaderboardRow.SexAgeEvent);

    return athleteObjects.find(row =>
        row.AthleteID === athleteId &&
        clean(row.TimeClass) === clean(leaderboardRow['Time Class']) &&
        String(row.Time || '').trim() === String(leaderboardRow.Time || '').trim() &&
        String(row.AgeGrade || '').trim() === String(leaderboardRow['Age Graded Score'] || '').trim() &&
        canonicalDistanceKey(row.Distance) === canonicalDistanceKey(resultDistance)
    );
}

function distanceFromSexAgeEvent(value) {
    const [, distance = value] = String(value || '').split('|');
    return distance;
}

function officialMedalKey(period, distance, place) {
    return `${canonicalPeriodLabel(period)}|${canonicalDistanceLabel(distance)}|${Number(place)}`;
}

function medalContext(row) {
    return `${row.Period || 'Unknown period'} ${row.Distance || 'Unknown distance'} place ${row.Place || '?'}`;
}

function medalNameForPlace(place) {
    return {
        1: 'Gold',
        2: 'Silver',
        3: 'Bronze'
    }[place] || '';
}

function canonicalPeriodLabel(value) {
    const text = clean(value).replace(/\s+/g, ' ');

    if (text.includes('all time') || text === 'alltime') {
        return 'All Time';
    }

    if (text.includes('current')) {
        return 'Current';
    }

    return '';
}

function periodLabelFromSlug(value) {
    return value === 'alltime' ? 'All Time' : 'Current';
}

function canonicalDistanceLabel(value) {
    const key = canonicalDistanceKey(value);

    return {
        overall: 'Overall',
        marathon: 'Marathon',
        halfmarathon: 'Half Marathon',
        '10mile': '10 Mile',
        '10km': '10 km',
        '5km': '5 km'
    }[key] || String(value || '').trim();
}

function canonicalDistanceKey(value) {
    const key = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\./g, '')
        .replace(/\s+/g, '');

    if (['hmar', 'halfmar', 'halfmarathon'].includes(key)) {
        return 'halfmarathon';
    }

    if (['10m', '10mi', '10mile'].includes(key)) {
        return '10mile';
    }

    return key;
}

function compareExportedValue(actual, expected, file, rowNumber, column, context) {
    if (String(actual ?? '').trim() !== String(expected ?? '').trim()) {
        addError(file, rowNumber, `${column} "${actual}" does not match ${context} value "${expected}".`);
    }
}

function validateCrownStandards(siteDir) {
    const file = `${siteDir}/crown_standards.csv`;
    const rows = readCsvRequired(file, [
        'AthleteId',
        'Distance',
        'Period',
        'CrownDistance',
        'CrownAgeCategory',
        'CrownHolderAthleteId',
        'CrownHolderName',
        'CrownAgeGrade',
        'CrownTime',
        'RequiredTimeToEqual',
        'RequiredTimeToTake',
        'AthletePB',
        'GapToPB',
        'Status',
        'SortOrder',
        'OverallTargetsToTake'
    ]);

    for (const row of toObjects(rows, file)) {
        validateAthleteId(row.AthleteId, file, row.__rowNumber, 'AthleteId', { required: true, severity: 'warning' });
        validateAthleteId(row.CrownHolderAthleteId, file, row.__rowNumber, 'CrownHolderAthleteId', { severity: 'warning' });
        validateNumber(row.SortOrder, file, row.__rowNumber, 'SortOrder', { required: true });
        validatePercent(row.CrownAgeGrade, file, row.__rowNumber, 'CrownAgeGrade');
        validateTime(row.CrownTime, file, row.__rowNumber, 'CrownTime');
        validateTime(row.RequiredTimeToEqual, file, row.__rowNumber, 'RequiredTimeToEqual');
        validateTime(row.RequiredTimeToTake, file, row.__rowNumber, 'RequiredTimeToTake');
        validateTime(row.AthletePB, file, row.__rowNumber, 'AthletePB');
        validateOverallTargets(row.OverallTargetsToTake, file, row.__rowNumber, 'OverallTargetsToTake');
    }
}

function validateAgeGradeStandards(siteDir) {
    const file = `${siteDir}/age_grade_standards.csv`;
    const rows = readCsvRequired(file, [
        'AthleteId',
        'Distance',
        'Standard',
        'AgeGrade',
        'RequiredTime',
        'SortOrder'
    ]);

    for (const row of toObjects(rows, file)) {
        validateAthleteId(row.AthleteId, file, row.__rowNumber, 'AthleteId', { required: true, severity: 'warning' });
        validatePercent(row.AgeGrade, file, row.__rowNumber, 'AgeGrade', { required: true });
        validateTime(row.RequiredTime, file, row.__rowNumber, 'RequiredTime', { required: true });
        validateNumber(row.SortOrder, file, row.__rowNumber, 'SortOrder', { required: true });
    }
}

function validateLeaderboardFile(siteDir, fileName, webtableRowNumber) {
    const safeName = String(fileName || '').trim();

    if (!safeName || safeName.includes('/') || safeName.includes('\\')) {
        addError(`${siteDir}/webtables.csv`, webtableRowNumber, `Invalid leaderboard FileName "${fileName}".`);
        return;
    }

    const file = `${siteDir}/${safeName}`;
    const rows = readCsvRequired(file, [
        'Rank',
        'Participant',
        'Race Year',
        'Time Class',
        'SexAgeEvent',
        'Time',
        'Age Graded Score',
        'Age Graded Category',
        'Athlete ID'
    ]);
    const objects = toObjects(rows, file);

    if (objects.length === 0) {
        addError(file, 1, 'Enabled leaderboard file must not be empty.');
    }

    for (const row of objects) {
        const vacant = isNoEligibleRow(row) || isVacantParticipant(row.Participant);

        if (vacant) {
            continue;
        }

        validateNumber(row.Rank, file, row.__rowNumber, 'Rank', { required: true });
        validateNumber(row['Race Year'], file, row.__rowNumber, 'Race Year');
        validateAllowed(row['Time Class'], ['All', 'Official', 'Unofficial'], file, row.__rowNumber, 'Time Class');
        validateTime(row.Time, file, row.__rowNumber, 'Time');
        validatePercent(row['Age Graded Score'], file, row.__rowNumber, 'Age Graded Score');
        validateAthleteId(row['Athlete ID'], file, row.__rowNumber, 'Athlete ID', { required: true });
    }
}

function validateEveryCsvInFolder(siteDir) {
    const absoluteDir = path.join(repoRoot, siteDir);
    const csvFiles = fs.readdirSync(absoluteDir)
        .filter(file => file.toLowerCase().endsWith('.csv'))
        .map(file => `${siteDir}/${file}`);

    for (const file of csvFiles) {
        parseCsvFile(file);
    }
}

function readCsvRequired(relativePath, requiredHeaders) {
    const rows = parseCsvFile(relativePath);

    if (rows.length === 0) {
        addError(relativePath, 1, 'Required CSV is empty.');
        return [];
    }

    const headers = rows[0] || [];

    for (const header of requiredHeaders) {
        if (!headers.includes(header)) {
            addError(relativePath, 1, `Missing required header "${header}".`);
        }
    }

    return rows;
}

function parseCsvFile(relativePath) {
    if (csvCache.has(relativePath)) {
        return csvCache.get(relativePath);
    }

    const absolutePath = path.join(repoRoot, relativePath);

    if (!fs.existsSync(absolutePath)) {
        addError(relativePath, 1, 'Required CSV file is missing.');
        csvCache.set(relativePath, []);
        return [];
    }

    const text = fs.readFileSync(absolutePath, 'utf8');
    let rows = [];

    try {
        rows = parseCsv(text);
    } catch (error) {
        addError(relativePath, error.line || 1, `CSV parsing failed: ${error.message}`);
        rows = [];
    }

    if (rows.length > 0) {
        const headerLength = rows[0].length;

        rows.forEach((row, index) => {
            const blankTrailingLine = index === rows.length - 1 && row.length === 1 && row[0] === '';

            if (!blankTrailingLine && row.length !== headerLength) {
                addError(relativePath, index + 1, `Row has ${row.length} fields but header has ${headerLength}.`);
            }
        });
    }

    csvCache.set(relativePath, rows);
    return rows;
}

function parseCsv(text) {
    const rows = [];
    let row = [];
    let value = '';
    let insideQuotes = false;
    let line = 1;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1];

        if (char === '"') {
            if (insideQuotes && next === '"') {
                value += '"';
                index += 1;
            } else {
                insideQuotes = !insideQuotes;
            }
            continue;
        }

        if (char === ',' && !insideQuotes) {
            row.push(value.trim());
            value = '';
            continue;
        }

        if ((char === '\n' || char === '\r') && !insideQuotes) {
            row.push(value.trim());
            rows.push(row);
            row = [];
            value = '';

            if (char === '\r' && next === '\n') {
                index += 1;
            }

            line += 1;
            continue;
        }

        value += char;

        if (char === '\n') {
            line += 1;
        }
    }

    if (insideQuotes) {
        const error = new Error('Unclosed quoted field.');
        error.line = line;
        throw error;
    }

    if (value.length || row.length || text.length === 0) {
        row.push(value.trim());
        rows.push(row);
    }

    return rows.filter((candidate, index) => {
        const isFinalBlank = index === rows.length - 1 && candidate.length === 1 && candidate[0] === '';
        return !isFinalBlank;
    });
}

function toObjects(rows, relativePath) {
    if (rows.length < 2) {
        return [];
    }

    const headers = rows[0];

    return rows.slice(1)
        .filter(row => row.some(value => value !== ''))
        .map((row, index) => {
            const object = { __rowNumber: index + 2 };

            for (let headerIndex = 0; headerIndex < headers.length; headerIndex += 1) {
                object[headers[headerIndex]] = row[headerIndex] ?? '';
            }

            return object;
        });
}

function validateAthleteId(value, file, rowNumber, column, options = {}) {
    const id = String(value || '').trim();

    if (!id || id === '#N/A') {
        if (options.required) {
            addProblem(options, file, rowNumber, `${column} is required.`);
        }
        return;
    }

    if (!athleteIds.has(id)) {
        addProblem(options, file, rowNumber, `${column} "${id}" does not exist in data/athlete_results.csv.`);
    }
}

function validateDate(value, file, rowNumber, column, options = {}) {
    const text = String(value || '').trim();

    if (!text) {
        if (options.required) {
            addError(file, rowNumber, `${column} is required.`);
        }
        return;
    }

    if (!parseUkDate(text)) {
        addError(file, rowNumber, `${column} "${text}" is not a parseable DD/MM/YYYY date.`);
    }
}

function validateIsoDate(value, file, rowNumber, column) {
    const text = String(value || '').trim();

    if (!text || Number.isNaN(Date.parse(text))) {
        addError(file, rowNumber, `${column} "${text}" is not a parseable ISO date.`);
    }
}

function validateNumber(value, file, rowNumber, column, options = {}) {
    const text = String(value || '').trim();

    if (!text) {
        if (options.required) {
            addError(file, rowNumber, `${column} is required.`);
        }
        return;
    }

    if (!Number.isFinite(Number(text))) {
        addError(file, rowNumber, `${column} "${text}" is not numeric.`);
    }
}

function validatePercent(value, file, rowNumber, column, options = {}) {
    const text = String(value || '').trim();

    if (!text) {
        if (options.required) {
            addError(file, rowNumber, `${column} is required.`);
        }
        return;
    }

    const numericText = text.endsWith('%') ? text.slice(0, -1) : text;

    if (!Number.isFinite(Number(numericText))) {
        addError(file, rowNumber, `${column} "${text}" is not a parseable percentage.`);
    }
}

function validateTime(value, file, rowNumber, column, options = {}) {
    const text = String(value || '').trim();

    if (!text) {
        if (options.required) {
            addError(file, rowNumber, `${column} is required.`);
        }
        return;
    }

    if (!/^\d{1,3}:\d{2}(:\d{2})?$/.test(text)) {
        addError(file, rowNumber, `${column} "${text}" is not a parseable time.`);
    }
}

function validateAllowed(value, allowed, file, rowNumber, column) {
    const text = String(value || '').trim();

    if (!text) {
        addError(file, rowNumber, `${column} is required.`);
        return;
    }

    if (!allowed.includes(text)) {
        addError(file, rowNumber, `${column} "${text}" must be one of: ${allowed.join(', ')}.`);
    }
}

function validateBoolean(value, file, rowNumber, column) {
    const text = String(value || '').trim().toUpperCase();

    if (!['TRUE', 'FALSE'].includes(text)) {
        addError(file, rowNumber, `${column} "${value}" must be TRUE or FALSE.`);
    }
}

function validateOverallTargets(value, file, rowNumber, column) {
    const text = String(value || '').trim();

    if (!text) {
        return;
    }

    for (const target of text.split(';')) {
        const [distance, time] = target.split('=');

        if (!distance || !time) {
            addError(file, rowNumber, `${column} entry "${target}" must use Distance=Time format.`);
            continue;
        }

        validateTime(time.trim(), file, rowNumber, `${column} (${distance.trim()})`);
    }
}

function parseUkDate(value) {
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);

    if (!match) {
        return null;
    }

    const [, dayText, monthText, yearText] = match;
    const day = Number(dayText);
    const month = Number(monthText);
    const year = Number(yearText);
    const date = new Date(Date.UTC(year, month - 1, day));

    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
    ) {
        return null;
    }

    return date;
}

function requireValue(value, file, rowNumber, column) {
    if (!String(value || '').trim()) {
        addError(file, rowNumber, `${column} is required.`);
    }
}

function clean(value) {
    return String(value || '')
        .trim()
        .toLowerCase();
}

function isVacantParticipant(value) {
    return String(value || '').toLowerCase().includes('vacant');
}

function isNoEligibleRow(row) {
    return String(row.Participant || '').toLowerCase().includes('no eligible');
}

function addError(file, rowNumber, message) {
    errors.push(`${file}:${rowNumber}: ${message}`);
}

function addProblem(options, file, rowNumber, message) {
    if (options.severity === 'warning') {
        warnings.push(`${file}:${rowNumber}: ${message}`);
    } else {
        addError(file, rowNumber, message);
    }
}
