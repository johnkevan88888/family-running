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

    validateHallOfFame(siteDir);
    validateOfficialMedals(siteDir);
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

function validateHallOfFame(siteDir) {
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
}

function validateOfficialMedals(siteDir) {
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

    for (const row of toObjects(rows, file)) {
        validateAthleteId(row.AthleteId, file, row.__rowNumber, 'AthleteId', { required: true });
        validateNumber(row.Place, file, row.__rowNumber, 'Place', { required: true });
        validateNumber(row.SortOrder, file, row.__rowNumber, 'SortOrder', { required: true });
        validateDate(row.EventDate, file, row.__rowNumber, 'EventDate');
        validateTime(row.Time, file, row.__rowNumber, 'Time');
        validatePercent(row.AgeGrade, file, row.__rowNumber, 'AgeGrade');
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
