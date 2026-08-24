import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ageGradeContract = require('../age-grade-contract.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const validationRoot = process.env.CSV_VALIDATION_ROOT
    ? path.resolve(process.env.CSV_VALIDATION_ROOT)
    : repoRoot;
const dataRoot = path.join(validationRoot, 'data');
const siteModes = ['family', 'everyone'];
const manifestFile = 'data/export_manifest.csv';
const manifestHeaders = [
    'ExportBundleID',
    'ExportedAtUTC',
    'SchemaVersion',
    'Scope',
    'RelativePath',
    'DataRowCount'
];
const manifestSchemaVersion = '1.0';
// The absolute-records export is a fixed matrix: one workbook-owned record per
// sex and supported distance, in this order. Both lists are also the exported
// row order, so validation can check completeness, uniqueness, and ordering
// against one definition rather than three.
const absoluteRecordSexes = ['Men', 'Women'];
const absoluteRecordDistances = ['Marathon', 'Half Marathon', '10 Mile', '10 km', '5 km'];
const officialNewsDistances = ['Marathon', 'Half Marathon', '10 Mile', '10 km', '5 km', '1 Mile'];
const officialNewsMilestoneTypes = [
    'First Official Result',
    'Age Grade PB',
    'Raw-Time PB',
    'Age Grade + Raw-Time PB'
];
const officialNewsMedalEntries = ['Gold', 'Silver', 'Bronze'];
const officialNewsDisplacedMedalAfterValues = [...officialNewsMedalEntries, 'No medal'];
const officialNewsDisplacedMedalSuccessors = new Map([
    ['Gold', 'Silver'],
    ['Silver', 'Bronze'],
    ['Bronze', 'No medal']
]);
const officialNewsHeaders = [
    'SortOrder',
    'SourceRow',
    'AthleteID',
    'AthleteName',
    'ResultDate',
    'Distance',
    'Time',
    'AgeGrade',
    'AgeGradeExact',
    'Event',
    'TimeClass',
    'MilestoneType',
    'PreviousBestTime',
    'TimeImprovementSeconds',
    'TimeImprovement',
    'PreviousBestAgeGrade',
    'PreviousBestAgeGradeExact',
    'AgeGradeImprovementExact',
    'AgeGradeImprovement',
    'CurrentDistanceRankBefore',
    'CurrentDistanceRankAfter',
    'CurrentDistancePlacesGained',
    'CurrentDistanceMedalEntry',
    'CurrentDistanceMedalBefore',
    'CurrentDistanceMedalAfter',
    'CurrentDistanceDisplacedAthleteID',
    'CurrentDistanceDisplacedAthleteName',
    'CurrentDistanceDisplacedMedalBefore',
    'CurrentDistanceDisplacedMedalAfter',
    'CurrentOverallRankBefore',
    'CurrentOverallRankAfter',
    'CurrentOverallPlacesGained',
    'CurrentOverallMedalEntry',
    'CurrentOverallMedalBefore',
    'CurrentOverallMedalAfter',
    'CurrentOverallDisplacedAthleteID',
    'CurrentOverallDisplacedAthleteName',
    'CurrentOverallDisplacedMedalBefore',
    'CurrentOverallDisplacedMedalAfter',
    'AllTimeDistanceRankBefore',
    'AllTimeDistanceRankAfter',
    'AllTimeDistancePlacesGained',
    'AllTimeDistanceMedalEntry',
    'AllTimeDistanceMedalBefore',
    'AllTimeDistanceMedalAfter',
    'AllTimeDistanceDisplacedAthleteID',
    'AllTimeDistanceDisplacedAthleteName',
    'AllTimeDistanceDisplacedMedalBefore',
    'AllTimeDistanceDisplacedMedalAfter',
    'AllTimeOverallRankBefore',
    'AllTimeOverallRankAfter',
    'AllTimeOverallPlacesGained',
    'AllTimeOverallMedalEntry',
    'AllTimeOverallMedalBefore',
    'AllTimeOverallMedalAfter',
    'AllTimeOverallDisplacedAthleteID',
    'AllTimeOverallDisplacedAthleteName',
    'AllTimeOverallDisplacedMedalBefore',
    'AllTimeOverallDisplacedMedalAfter',
    'ExportBundleID'
];
const officialNewsRankContexts = [
    [
        'CurrentDistanceRankBefore',
        'CurrentDistanceRankAfter',
        'CurrentDistancePlacesGained',
        'CurrentDistanceMedalEntry',
        'CurrentDistanceMedalBefore',
        'CurrentDistanceMedalAfter',
        'CurrentDistanceDisplacedAthleteID',
        'CurrentDistanceDisplacedAthleteName',
        'CurrentDistanceDisplacedMedalBefore',
        'CurrentDistanceDisplacedMedalAfter'
    ],
    [
        'CurrentOverallRankBefore',
        'CurrentOverallRankAfter',
        'CurrentOverallPlacesGained',
        'CurrentOverallMedalEntry',
        'CurrentOverallMedalBefore',
        'CurrentOverallMedalAfter',
        'CurrentOverallDisplacedAthleteID',
        'CurrentOverallDisplacedAthleteName',
        'CurrentOverallDisplacedMedalBefore',
        'CurrentOverallDisplacedMedalAfter'
    ],
    [
        'AllTimeDistanceRankBefore',
        'AllTimeDistanceRankAfter',
        'AllTimeDistancePlacesGained',
        'AllTimeDistanceMedalEntry',
        'AllTimeDistanceMedalBefore',
        'AllTimeDistanceMedalAfter',
        'AllTimeDistanceDisplacedAthleteID',
        'AllTimeDistanceDisplacedAthleteName',
        'AllTimeDistanceDisplacedMedalBefore',
        'AllTimeDistanceDisplacedMedalAfter'
    ],
    [
        'AllTimeOverallRankBefore',
        'AllTimeOverallRankAfter',
        'AllTimeOverallPlacesGained',
        'AllTimeOverallMedalEntry',
        'AllTimeOverallMedalBefore',
        'AllTimeOverallMedalAfter',
        'AllTimeOverallDisplacedAthleteID',
        'AllTimeOverallDisplacedAthleteName',
        'AllTimeOverallDisplacedMedalBefore',
        'AllTimeOverallDisplacedMedalAfter'
    ]
];
// The workbook annotates participants with status markers, and a marker that
// reaches AthleteID silently renames the athlete. Nothing downstream notices:
// every exported table carries the same renamed key, so all the reference
// checks resolve and the bundle validates, while `athlete.html?id=...` links
// published earlier stop matching anyone. Only a format rule applied where the
// ID is minted catches that, which is why this guards data/athlete_results.csv
// rather than each referencing column. A malformed ID anywhere else already
// fails the "does not exist in data/athlete_results.csv" check.
const athleteIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const errors = [];
const warnings = [];
const csvCache = new Map();

validateExportBundleIntegrity();

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
const officialNewsObjectsBySite = new Map();

for (const row of athleteObjects) {
    const rowNumber = row.__rowNumber;

    requireValue(row.AthleteID, 'data/athlete_results.csv', rowNumber, 'AthleteID');
    requireValue(row.Participant, 'data/athlete_results.csv', rowNumber, 'Participant');
    validateDate(row.Date, 'data/athlete_results.csv', rowNumber, 'Date', { required: true });
    validateTime(row.Time, 'data/athlete_results.csv', rowNumber, 'Time', { required: true });
    validatePercent(row.AgeGrade, 'data/athlete_results.csv', rowNumber, 'AgeGrade', { required: true });

    if (row.AthleteID) {
        // Multiple rows per athlete are expected, so only the first sighting of
        // an ID is checked. A marker that leaks into the key repeats on every
        // one of that athlete's result rows, and one report per athlete is the
        // difference between a readable failure and hundreds of duplicates.
        if (!athleteIds.has(row.AthleteID) && !athleteIdPattern.test(row.AthleteID)) {
            addError(
                'data/athlete_results.csv',
                rowNumber,
                `AthleteID "${row.AthleteID}" must be lowercase letters and digits separated by single hyphens.`
            );
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

validateOfficialNewsCrossModeAgreement();

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

function validateExportBundleIntegrity() {
    const manifestPath = path.join(validationRoot, manifestFile);

    if (!fs.existsSync(manifestPath)) {
        addError(manifestFile, 1, 'Required export manifest is missing.');
        return;
    }

    const manifestRows = parseCsvFile(manifestFile);
    if (manifestRows.length === 0) {
        addError(manifestFile, 1, 'Export manifest is empty.');
        return;
    }

    const actualHeaders = manifestRows[0] || [];
    if (
        actualHeaders.length !== manifestHeaders.length ||
        actualHeaders.some((header, index) => header !== manifestHeaders[index])
    ) {
        addError(
            manifestFile,
            1,
            `Manifest schema must exactly match: ${manifestHeaders.join(',')}.`
        );
        return;
    }

    const manifestObjects = toObjects(manifestRows, manifestFile);
    if (manifestObjects.length === 0) {
        addError(manifestFile, 1, 'Export manifest must contain at least one file row.');
        return;
    }

    const canonical = {
        bundleId: String(manifestObjects[0].ExportBundleID || '').trim(),
        exportedAt: String(manifestObjects[0].ExportedAtUTC || '').trim(),
        schemaVersion: String(manifestObjects[0].SchemaVersion || '').trim()
    };
    const manifestByPath = new Map();
    const scopeBundles = new Map(['family', 'everyone', 'shared'].map(scope => [scope, new Set()]));

    for (const row of manifestObjects) {
        const rowNumber = row.__rowNumber;
        const bundleId = String(row.ExportBundleID || '').trim();
        const exportedAt = String(row.ExportedAtUTC || '').trim();
        const schemaVersion = String(row.SchemaVersion || '').trim();
        const scope = String(row.Scope || '').trim();
        const relativePath = String(row.RelativePath || '').trim();
        const rowCountText = String(row.DataRowCount || '').trim();

        requireValue(bundleId, manifestFile, rowNumber, 'ExportBundleID');
        requireValue(exportedAt, manifestFile, rowNumber, 'ExportedAtUTC');
        requireValue(schemaVersion, manifestFile, rowNumber, 'SchemaVersion');
        validateManifestBundleId(bundleId, rowNumber);
        validateManifestTimestamp(exportedAt, rowNumber);

        if (schemaVersion && schemaVersion !== manifestSchemaVersion) {
            addError(
                manifestFile,
                rowNumber,
                `SchemaVersion "${schemaVersion}" must be "${manifestSchemaVersion}".`
            );
        }

        if (bundleId !== canonical.bundleId) {
            addError(
                manifestFile,
                rowNumber,
                `ExportBundleID "${bundleId}" disagrees with row 2 value "${canonical.bundleId}".`
            );
        }
        if (exportedAt !== canonical.exportedAt) {
            addError(
                manifestFile,
                rowNumber,
                `ExportedAtUTC "${exportedAt}" disagrees with row 2 value "${canonical.exportedAt}".`
            );
        }
        if (schemaVersion !== canonical.schemaVersion) {
            addError(
                manifestFile,
                rowNumber,
                `SchemaVersion "${schemaVersion}" disagrees with row 2 value "${canonical.schemaVersion}".`
            );
        }

        if (!['family', 'everyone', 'shared'].includes(scope)) {
            addError(
                manifestFile,
                rowNumber,
                `Scope "${scope}" must be one of: family, everyone, shared.`
            );
        } else if (bundleId) {
            scopeBundles.get(scope).add(bundleId);
        }

        const validPath = validateManifestRelativePath(relativePath, scope, rowNumber);
        if (relativePath) {
            if (manifestByPath.has(relativePath)) {
                addError(
                    manifestFile,
                    rowNumber,
                    `RelativePath "${relativePath}" appears more than once in the manifest.`
                );
            } else {
                manifestByPath.set(relativePath, row);
            }
        }

        if (!/^(0|[1-9]\d*)$/.test(rowCountText)) {
            addError(
                manifestFile,
                rowNumber,
                `DataRowCount "${row.DataRowCount}" must be a non-negative integer.`
            );
        }

        if (validPath) {
            validateManifestFileEntry(row, canonical.bundleId);
        }
    }

    for (const scope of ['family', 'everyone', 'shared']) {
        if (scopeBundles.get(scope).size === 0) {
            addError(manifestFile, 1, `Manifest has no "${scope}" scope rows.`);
        }
    }

    const allScopeBundleIds = new Set(
        [...scopeBundles.values()].flatMap(bundleIds => [...bundleIds])
    );
    if (allScopeBundleIds.size !== 1) {
        addError(
            manifestFile,
            1,
            `Family, Everyone, and shared rows do not belong to one export bundle (${[...allScopeBundleIds].join(', ') || 'none'}).`
        );
    }

    for (const relativePath of discoverPublicCsvFiles()) {
        if (!manifestByPath.has(relativePath)) {
            addError(
                relativePath,
                1,
                `Public CSV exists but is absent from ${manifestFile}.`
            );
        }
    }
}

function validateManifestBundleId(bundleId, rowNumber) {
    if (!bundleId) {
        return;
    }

    if (!/^\d{8}T\d{9}Z-[A-F0-9]{8}$/.test(bundleId)) {
        addError(
            manifestFile,
            rowNumber,
            `ExportBundleID "${bundleId}" is not the required URL-safe UTC timestamp and uniqueness format.`
        );
    }
}

function validateManifestTimestamp(value, rowNumber) {
    if (!value) {
        return;
    }

    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value))) {
        addError(
            manifestFile,
            rowNumber,
            `ExportedAtUTC "${value}" must be an ISO UTC timestamp with milliseconds.`
        );
    }
}

function validateManifestRelativePath(relativePath, scope, rowNumber) {
    if (!relativePath) {
        addError(manifestFile, rowNumber, 'RelativePath is required.');
        return false;
    }

    const normalized = path.posix.normalize(relativePath);
    const structurallyValid =
        !path.posix.isAbsolute(relativePath) &&
        !relativePath.includes('\\') &&
        normalized === relativePath &&
        relativePath.startsWith('data/') &&
        relativePath.toLowerCase().endsWith('.csv') &&
        relativePath !== manifestFile;

    if (!structurallyValid) {
        addError(
            manifestFile,
            rowNumber,
            `RelativePath "${relativePath}" is not a safe repository-relative public CSV path.`
        );
        return false;
    }

    const scopeMatches =
        (scope === 'family' && /^data\/family\/[^/]+\.csv$/i.test(relativePath)) ||
        (scope === 'everyone' && /^data\/everyone\/[^/]+\.csv$/i.test(relativePath)) ||
        (scope === 'shared' && /^data\/(?!family\/|everyone\/)[^/]+\.csv$/i.test(relativePath));

    if (!scopeMatches) {
        addError(
            manifestFile,
            rowNumber,
            `RelativePath "${relativePath}" is invalid for scope "${scope}".`
        );
        return false;
    }

    return true;
}

function validateManifestFileEntry(manifestRow, canonicalBundleId) {
    const relativePath = String(manifestRow.RelativePath || '').trim();
    const absolutePath = path.join(validationRoot, relativePath);

    if (!fs.existsSync(absolutePath)) {
        addError(
            manifestFile,
            manifestRow.__rowNumber,
            `RelativePath "${relativePath}" references a missing CSV.`
        );
        return;
    }

    const rows = parseCsvFile(relativePath);
    if (rows.length === 0) {
        return;
    }

    const headers = rows[0] || [];
    const bundleIndexes = headers
        .map((header, index) => header === 'ExportBundleID' ? index : -1)
        .filter(index => index >= 0);

    if (bundleIndexes.length === 0) {
        addError(relativePath, 1, 'Missing required header "ExportBundleID".');
    } else if (bundleIndexes.length > 1) {
        addError(relativePath, 1, 'Header "ExportBundleID" appears more than once.');
    }

    const dataRows = rows
        .slice(1)
        .map((row, index) => ({ row, rowNumber: index + 2 }))
        .filter(({ row }) => row.some(value => value !== ''));
    const expectedRowCount = Number(manifestRow.DataRowCount);

    if (Number.isInteger(expectedRowCount) && dataRows.length !== expectedRowCount) {
        addError(
            manifestFile,
            manifestRow.__rowNumber,
            `DataRowCount for "${relativePath}" is ${manifestRow.DataRowCount}, but the CSV contains ${dataRows.length} data rows.`
        );
    }

    if (bundleIndexes.length !== 1 || dataRows.length === 0) {
        return;
    }

    const bundleIndex = bundleIndexes[0];
    const fileBundleIds = new Set();

    for (const { row, rowNumber } of dataRows) {
        const bundleId = String(row[bundleIndex] || '').trim();

        if (!bundleId) {
            addError(relativePath, rowNumber, 'ExportBundleID is blank.');
            continue;
        }

        fileBundleIds.add(bundleId);

        if (bundleId !== String(manifestRow.ExportBundleID || '').trim()) {
            addError(
                relativePath,
                rowNumber,
                `ExportBundleID "${bundleId}" does not match manifest value "${manifestRow.ExportBundleID}".`
            );
        }
        if (bundleId !== canonicalBundleId) {
            addError(
                relativePath,
                rowNumber,
                `ExportBundleID "${bundleId}" does not match the export bundle "${canonicalBundleId}".`
            );
        }
    }

    if (fileBundleIds.size > 1) {
        addError(
            relativePath,
            1,
            `CSV contains mixed ExportBundleID values: ${[...fileBundleIds].join(', ')}.`
        );
    }
}

function discoverPublicCsvFiles() {
    if (!fs.existsSync(dataRoot)) {
        return [];
    }

    const files = [];
    visit(dataRoot);
    return files.sort();

    function visit(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const absolutePath = path.join(directory, entry.name);

            if (entry.isDirectory()) {
                visit(absolutePath);
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.csv')) {
                const relativePath = path.relative(validationRoot, absolutePath).replace(/\\/g, '/');

                if (relativePath !== manifestFile) {
                    files.push(relativePath);
                }
            }
        }
    }
}

function requireManifestEntry(relativePath, expectedScope) {
    const rows = parseCsvFile(manifestFile);
    const matches = toObjects(rows, manifestFile).filter(
        row => String(row.RelativePath || '').trim() === relativePath
    );

    if (matches.length === 0) {
        addError(manifestFile, 1, `Missing required manifest path "${relativePath}".`);
        return null;
    }

    if (matches.length > 1) {
        // The bundle-integrity pass reports the duplicate rows themselves. One
        // matrix-level error keeps this requirement explicit without guessing
        // which duplicate should define the file.
        addError(manifestFile, 1, `Required manifest path "${relativePath}" is not unique.`);
        return null;
    }

    const row = matches[0];
    if (String(row.Scope || '').trim() !== expectedScope) {
        addError(
            manifestFile,
            row.__rowNumber,
            `Required manifest path "${relativePath}" must have scope "${expectedScope}".`
        );
    }

    return row;
}

function validateSite(siteMode) {
    const siteDir = `data/${siteMode}`;

    if (!fs.existsSync(path.join(validationRoot, siteDir))) {
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
    validateOfficialLeaderboardMatrix(siteDir, siteMode, webtables);
    validateHallOfFame(siteDir, siteMode, webtables);
    validateCrownHistory(siteDir);
    validateOfficialMedals(siteDir, siteMode, webtables);
    validateAbsoluteRecords(siteDir);
    validateCrownStandards(siteDir);
    validateAgeGradeStandards(siteDir);
    validateAgeGradeCalculator(siteDir);
    validateAthleteComparisonTargets(siteDir);
    validateOfficialResultNews(siteDir, siteMode);

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

function validateCrownHistory(siteDir) {
    const file = `${siteDir}/crown_history.csv`;
    const expectedHeaders = [
        'Distance',
        'CrownScope',
        'EffectiveDate',
        'AthleteID',
        'AthleteName',
        'Time',
        'AgeGrade',
        'Event',
        'PreviousAthleteID',
        'PreviousAthleteName',
        'PreviousTime',
        'PreviousAgeGrade',
        'ChangeReason',
        'ExportBundleID'
    ];
    const rows = readCsvRequired(file, expectedHeaders);
    const actualHeaders = rows[0] || [];

    if (
        actualHeaders.length !== expectedHeaders.length ||
        actualHeaders.some((header, index) => header !== expectedHeaders[index])
    ) {
        addError(file, 1, `Header must exactly match: ${expectedHeaders.join(',')}.`);
    }

    const objects = toObjects(rows, file);
    const crownOrder = ['Overall', 'Marathon', 'Half Marathon', '10 Mile', '10 km', '5 km'];
    const histories = new Map(crownOrder.map(distance => [distance, []]));
    const seenTransitions = new Set();
    let previousCrownIndex = -1;

    for (const row of objects) {
        const crownIndex = crownOrder.indexOf(String(row.Distance || '').trim());

        if (crownIndex < 0) {
            addError(file, row.__rowNumber, `Distance "${row.Distance}" must be one of: ${crownOrder.join(', ')}.`);
        } else {
            if (crownIndex < previousCrownIndex) {
                addError(file, row.__rowNumber, 'Crown groups are not in the required stable order.');
            }
            previousCrownIndex = Math.max(previousCrownIndex, crownIndex);
            histories.get(crownOrder[crownIndex]).push(row);
        }

        compareExportedValue(
            row.CrownScope,
            'All-Time Official',
            file,
            row.__rowNumber,
            'CrownScope',
            'the crown history contract'
        );
        validateStrictUkDate(row.EffectiveDate, file, row.__rowNumber, 'EffectiveDate', { required: true });
        requireValue(row.AthleteName, file, row.__rowNumber, 'AthleteName');
        validateTime(row.Time, file, row.__rowNumber, 'Time', { required: true });
        validatePercent(row.AgeGrade, file, row.__rowNumber, 'AgeGrade', { required: true });
        requireValue(row.ChangeReason, file, row.__rowNumber, 'ChangeReason');
        validateAthleteId(row.AthleteID, file, row.__rowNumber, 'AthleteID');
        validateAthleteId(row.PreviousAthleteID, file, row.__rowNumber, 'PreviousAthleteID');
        validateTime(row.PreviousTime, file, row.__rowNumber, 'PreviousTime');
        validatePercent(row.PreviousAgeGrade, file, row.__rowNumber, 'PreviousAgeGrade');

        if (isVacantParticipant(row.AthleteName) || isNoEligibleParticipant(row.AthleteName)) {
            addError(file, row.__rowNumber, 'Crown history must not contain a vacant or no-eligible-results athlete.');
        }
        if (isVacantParticipant(row.PreviousAthleteName) || isNoEligibleParticipant(row.PreviousAthleteName)) {
            addError(file, row.__rowNumber, 'Previous-holder fields must not contain a synthetic vacancy.');
        }

        const transitionKey = [
            row.Distance,
            row.EffectiveDate,
            row.AthleteID || clean(row.AthleteName)
        ].join('|');
        if (seenTransitions.has(transitionKey)) {
            addError(file, row.__rowNumber, 'Duplicate crown transition row.');
        }
        seenTransitions.add(transitionKey);
    }

    for (const crownName of crownOrder) {
        validateCrownChronology(file, crownName, histories.get(crownName));
    }

    validateCrownHistoryAgainstHallOfFame(siteDir, file, histories, crownOrder);
}

function validateCrownChronology(file, crownName, rows) {
    let previousDate = null;
    let previousTransition = null;

    rows.forEach((row, index) => {
        const effectiveDate = parseUkDate(String(row.EffectiveDate || '').trim());
        if (effectiveDate && previousDate && effectiveDate < previousDate) {
            addError(file, row.__rowNumber, `${crownName} transitions are not in ascending effective chronology.`);
        }
        if (effectiveDate) {
            previousDate = effectiveDate;
        }

        const previousFields = [
            row.PreviousAthleteID,
            row.PreviousAthleteName,
            row.PreviousTime,
            row.PreviousAgeGrade
        ].map(value => String(value || '').trim());

        if (index === 0) {
            if (previousFields.some(Boolean)) {
                addError(file, row.__rowNumber, `${crownName} initial award must have blank Previous* fields.`);
            }
            if (!/\b(initial|first)\b/i.test(String(row.ChangeReason || ''))) {
                addError(file, row.__rowNumber, `${crownName} initial award ChangeReason must identify it as the first or initial award.`);
            }
        } else {
            if (/\b(initial|first)\b/i.test(String(row.ChangeReason || ''))) {
                addError(file, row.__rowNumber, `${crownName} transfer ChangeReason must not describe an initial award.`);
            }
            if (!/\b(transfer|retak|changed|from)\b/i.test(String(row.ChangeReason || ''))) {
                addError(file, row.__rowNumber, `${crownName} transfer ChangeReason must identify the holder change.`);
            }

            const incompletePreviousHolder = previousFields.some(value => !value);
            if (
                incompletePreviousHolder &&
                !/\b(incomplete|unavailable|missing)\b/i.test(String(row.ChangeReason || ''))
            ) {
                addError(file, row.__rowNumber, `${crownName} incomplete Previous* fields must be explained by ChangeReason.`);
            }

            if (previousTransition && !sameExportedAthlete(
                row.PreviousAthleteID,
                row.PreviousAthleteName,
                previousTransition.AthleteID,
                previousTransition.AthleteName
            )) {
                addError(file, row.__rowNumber, `${crownName} previous-holder identity does not match the preceding transition holder.`);
            }
        }

        if (previousTransition && sameExportedAthlete(
            row.AthleteID,
            row.AthleteName,
            previousTransition.AthleteID,
            previousTransition.AthleteName
        )) {
            addError(file, row.__rowNumber, `${crownName} contains consecutive transitions to the same holder.`);
        }

        previousTransition = row;
    });
}

function validateCrownHistoryAgainstHallOfFame(siteDir, file, histories, crownOrder) {
    const hallFile = `${siteDir}/halloffame.csv`;
    const hallRows = toObjects(readCsvRequired(hallFile, [
        'Award',
        'Participant',
        'Distance',
        'Time',
        'AgeGrade',
        'Date',
        'Event',
        'Athlete ID',
        'AgeClass'
    ]));
    const hallByAward = new Map(hallRows.map(row => [String(row.Award || '').trim(), row]));

    for (const crownName of crownOrder) {
        const award = `All Time ${hallOfFameAwardDistance(crownName)} Official Champion`;
        const hallHolder = hallByAward.get(award);
        const crownRows = histories.get(crownName);
        const finalTransition = crownRows[crownRows.length - 1];

        if (!hallHolder) {
            addError(file, 1, `Cannot reconcile ${crownName}: Hall of Fame row "${award}" is missing.`);
            continue;
        }

        if (isVacantParticipant(hallHolder.Participant)) {
            if (crownRows.length > 0) {
                addError(file, finalTransition.__rowNumber, `${crownName} has history but its All-Time Official Hall of Fame crown is vacant.`);
            }
            continue;
        }

        if (!finalTransition) {
            addError(file, 1, `${crownName} has a current All-Time Official holder but no crown history transition.`);
            continue;
        }

        if (!sameExportedAthlete(
            finalTransition.AthleteID,
            finalTransition.AthleteName,
            hallHolder['Athlete ID'],
            hallHolder.Participant
        )) {
            addError(
                file,
                finalTransition.__rowNumber,
                `${crownName} final transition holder does not match the current All-Time Official Hall of Fame holder.`
            );
        }
    }
}

function sameExportedAthlete(firstId, firstName, secondId, secondName) {
    const leftId = clean(firstId);
    const rightId = clean(secondId);

    if (leftId && rightId) {
        return leftId === rightId;
    }

    return clean(firstName) === clean(secondName);
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
    const absoluteDir = path.join(validationRoot, siteDir);
    const leaderboardFiles = fs.readdirSync(absoluteDir)
        .filter(fileName => Boolean(parseLeaderboardExportFileName(fileName, siteMode)));

    for (const fileName of leaderboardFiles) {
        if (!referencedFiles.has(fileName)) {
            addError(`${siteDir}/webtables.csv`, 1, `Leaderboard export "${fileName}" exists but is not referenced by webtables.csv.`);
        }
    }
}

// News rank snapshots name Current/All-Time Distance/Overall positions. Those
// states are only a closed contract if every corresponding Official standings
// export exists. Do not let webtables.csv silently shrink that source matrix:
// require all six categories in both periods, independently for each mode.
function validateOfficialLeaderboardMatrix(siteDir, siteMode, webtables) {
    for (const fileName of expectedOfficialLeaderboardFiles(siteMode)) {
        const relativePath = `${siteDir}/${fileName}`;
        const matchingRows = webtables.filter(
            row => String(row.FileName || '').trim() === fileName
        );

        requireManifestEntry(relativePath, siteMode);

        if (!fs.existsSync(path.join(validationRoot, relativePath))) {
            addError(relativePath, 1, 'Required Official leaderboard matrix file is missing.');
        } else {
            const leaderboardRows = toObjects(
                readCsvRequired(relativePath, ['Participant', 'Time Class']),
                relativePath
            );
            for (const leaderboardRow of leaderboardRows) {
                // Vacant/no-eligible placeholders deliberately carry blank
                // result fields. The file and webtables metadata establish
                // that they are Official; populated standings must repeat it.
                if (isNoEligibleRow(leaderboardRow) || isVacantParticipant(leaderboardRow.Participant)) {
                    continue;
                }
                if (String(leaderboardRow['Time Class'] || '').trim() !== 'Official') {
                    addError(
                        relativePath,
                        leaderboardRow.__rowNumber,
                        `Official leaderboard matrix row must have Time Class "Official", found "${leaderboardRow['Time Class']}".`
                    );
                }
            }
        }

        if (matchingRows.length !== 1) {
            addError(
                `${siteDir}/webtables.csv`,
                1,
                `Official leaderboard matrix requires exactly one webtables.csv row for "${fileName}", found ${matchingRows.length}.`
            );
            continue;
        }

        const row = matchingRows[0];
        if (String(row.TimeClass || '').trim() !== 'Official') {
            addError(
                `${siteDir}/webtables.csv`,
                row.__rowNumber,
                `Official leaderboard matrix row "${fileName}" must have TimeClass "Official".`
            );
        }
        if (String(row.Enabled || '').trim().toUpperCase() !== 'TRUE') {
            addError(
                `${siteDir}/webtables.csv`,
                row.__rowNumber,
                `Official leaderboard matrix row "${fileName}" must be enabled.`
            );
        }
    }
}

function expectedOfficialLeaderboardFiles(siteMode) {
    const distances = ['overall', 'marathon', 'halfmarathon', '10mile', '10km', '5km'];
    const periods = ['current', 'alltime'];
    const files = [];

    for (const distance of distances) {
        for (const period of periods) {
            files.push(`${distance}-${period}-official-${siteMode}.csv`);
        }
    }

    return files;
}

function validateOfficialResultNews(siteDir, siteMode) {
    const file = `${siteDir}/official_result_news.csv`;
    requireManifestEntry(file, siteMode);

    const rows = readCsvRequired(file, officialNewsHeaders);
    const actualHeaders = rows[0] || [];

    if (
        actualHeaders.length !== officialNewsHeaders.length ||
        actualHeaders.some((header, index) => header !== officialNewsHeaders[index])
    ) {
        addError(file, 1, `Header must exactly match: ${officialNewsHeaders.join(',')}.`);
    }

    const objects = toObjects(rows, file);
    const siteAthleteIds = new Set(
        toObjects(
            readCsvRequired(`${siteDir}/age_grade_standards.csv`, ['AthleteId']),
            `${siteDir}/age_grade_standards.csv`
        )
            .map(row => String(row.AthleteId || '').trim())
            .filter(Boolean)
    );
    const seenSortOrders = new Set();
    const seenSourceRows = new Set();
    const seenPublicSourceRows = new Set();
    const seenMilestones = new Set();
    let previousDate = null;
    let previousSourceRow = null;

    for (let index = 0; index < objects.length; index += 1) {
        const row = objects[index];
        const sortOrder = parseOfficialNewsInteger(
            row.SortOrder,
            file,
            row.__rowNumber,
            'SortOrder',
            { required: true, minimum: 1 }
        );
        const sourceRow = parseOfficialNewsInteger(
            row.SourceRow,
            file,
            row.__rowNumber,
            'SourceRow',
            { required: true, minimum: 1 }
        );

        if (sortOrder !== null) {
            if (seenSortOrders.has(sortOrder)) {
                addError(file, row.__rowNumber, `Duplicate SortOrder ${sortOrder}.`);
            }
            seenSortOrders.add(sortOrder);

            if (sortOrder !== index + 1) {
                addError(
                    file,
                    row.__rowNumber,
                    `SortOrder ${sortOrder} is out of sequence: file row ${index + 1} must be SortOrder ${index + 1}.`
                );
            }
        }

        if (sourceRow !== null) {
            if (seenSourceRows.has(sourceRow)) {
                addError(file, row.__rowNumber, `Duplicate SourceRow ${sourceRow}.`);
            }
            seenSourceRows.add(sourceRow);
        }

        validateAthleteId(row.AthleteID, file, row.__rowNumber, 'AthleteID', { required: true });
        requireValue(row.AthleteName, file, row.__rowNumber, 'AthleteName');
        validateStrictUkDate(row.ResultDate, file, row.__rowNumber, 'ResultDate', { required: true });
        validateAllowed(row.Distance, officialNewsDistances, file, row.__rowNumber, 'Distance');
        validateOfficialNewsTime(row.Time, file, row.__rowNumber, 'Time', { required: true });
        validateOfficialNewsDisplayAgeGrade(row.AgeGrade, file, row.__rowNumber, 'AgeGrade', { required: true });
        const ageGradeExact = parseOfficialNewsExactPercent(
            row.AgeGradeExact,
            file,
            row.__rowNumber,
            'AgeGradeExact',
            { required: true, positive: true }
        );
        const ageGrade = parseOfficialNewsDisplayPercent(row.AgeGrade);
        if (
            ageGradeExact !== null &&
            ageGrade !== null &&
            !officialNewsRoundsTo(ageGradeExact, ageGrade, 1)
        ) {
            addError(
                file,
                row.__rowNumber,
                `AgeGradeExact "${row.AgeGradeExact}" does not round to AgeGrade "${row.AgeGrade}" at one decimal place.`
            );
        }

        compareExportedValue(
            row.TimeClass,
            'Official',
            file,
            row.__rowNumber,
            'TimeClass',
            'the Official Result News contract'
        );
        validateAllowed(
            row.MilestoneType,
            officialNewsMilestoneTypes,
            file,
            row.__rowNumber,
            'MilestoneType'
        );

        const athleteId = String(row.AthleteID || '').trim();
        if (athleteId && !siteAthleteIds.has(athleteId)) {
            addError(
                file,
                row.__rowNumber,
                `AthleteID "${athleteId}" is not eligible for the ${siteMode} site mode.`
            );
        }

        const resultDate = parseUkDate(String(row.ResultDate || '').trim());
        if (resultDate && previousDate) {
            if (resultDate > previousDate) {
                addError(file, row.__rowNumber, 'News rows must be in descending ResultDate order.');
            } else if (
                resultDate.getTime() === previousDate.getTime() &&
                sourceRow !== null &&
                previousSourceRow !== null &&
                sourceRow >= previousSourceRow
            ) {
                addError(
                    file,
                    row.__rowNumber,
                    'Rows on the same ResultDate must be in descending authoritative SourceRow order.'
                );
            }
        }
        if (resultDate) {
            previousDate = resultDate;
            previousSourceRow = sourceRow;
        }

        const milestoneKey = [
            athleteId,
            row.ResultDate,
            row.Distance,
            row.SourceRow
        ].join('|');
        if (seenMilestones.has(milestoneKey)) {
            addError(file, row.__rowNumber, 'Duplicate official result News milestone row.');
        }
        seenMilestones.add(milestoneKey);

        const sourceResult = validateOfficialNewsSourceAgreement(row, file);
        if (sourceResult) {
            row.__sourceResultRowNumber = sourceResult.__rowNumber;
            if (seenPublicSourceRows.has(sourceResult.__rowNumber)) {
                addError(
                    file,
                    row.__rowNumber,
                    `Duplicate News rows match data/athlete_results.csv row ${sourceResult.__rowNumber}.`
                );
            }
            seenPublicSourceRows.add(sourceResult.__rowNumber);
        }
        validateOfficialNewsMilestoneFields(row, file);
        for (const rankContext of officialNewsRankContexts) {
            const isDistanceContext = rankContext[0].includes('Distance');
            validateOfficialNewsRankContext(row, file, rankContext, {
                tableAvailable: !(String(row.Distance || '').trim() === '1 Mile' && isDistanceContext),
                siteAthleteIds,
                siteMode
            });
        }
    }

    validateOfficialNewsMilestoneChains(objects, file);
    officialNewsObjectsBySite.set(siteMode, objects);
}

function validateOfficialNewsSourceAgreement(row, file) {
    const newsTimeMilliseconds = parseOfficialNewsTimeToMilliseconds(row.Time);
    const matches = athleteObjects.filter(result =>
        String(result.AthleteID || '').trim() === String(row.AthleteID || '').trim() &&
        String(result.Participant || '').trim() === String(row.AthleteName || '').trim() &&
        String(result.Date || '').trim() === String(row.ResultDate || '').trim() &&
        canonicalDistanceLabel(result.Distance) === String(row.Distance || '').trim() &&
        officialNewsTimeMatchesPublicDisplay(newsTimeMilliseconds, result.Time) &&
        String(result.AgeGrade || '').trim() === String(row.AgeGrade || '').trim() &&
        officialNewsEventMatchesPublicExport(row.Event, result.Event) &&
        String(result.TimeClass || '').trim() === 'Official'
    );

    if (matches.length !== 1) {
        addError(
            file,
            row.__rowNumber,
            `Displayed source performance must match exactly one Official row in data/athlete_results.csv; found ${matches.length}.`
        );
        return null;
    }

    return matches[0];
}

function validateOfficialNewsCrossModeAgreement() {
    const familyRows = officialNewsObjectsBySite.get('family');
    const everyoneRows = officialNewsObjectsBySite.get('everyone');

    if (!familyRows || !everyoneRows) {
        return;
    }

    const everyoneBySourceRow = new Map(
        everyoneRows
            .filter(row => Number.isInteger(row.__sourceResultRowNumber))
            .map(row => [row.__sourceResultRowNumber, row])
    );
    const rankFields = new Set(officialNewsRankContexts.flat());
    const ignoredFields = new Set(['SortOrder', 'ExportBundleID', ...rankFields]);

    for (const familyRow of familyRows) {
        if (!Number.isInteger(familyRow.__sourceResultRowNumber)) {
            continue;
        }

        const everyoneRow = everyoneBySourceRow.get(familyRow.__sourceResultRowNumber);
        if (!everyoneRow) {
            // Family is a strict subset of Everyone and milestone qualification
            // is independent of mode. Everyone-only rows are valid, but every
            // Family milestone must have the same source milestone in Everyone.
            addError(
                'data/family/official_result_news.csv',
                familyRow.__rowNumber,
                `Family News source at data/athlete_results.csv row ` +
                `${familyRow.__sourceResultRowNumber} is missing from Everyone News.`
            );
            continue;
        }

        for (const field of officialNewsHeaders) {
            if (ignoredFields.has(field)) {
                continue;
            }

            if (!officialNewsCrossModeValuesEqual(field, familyRow[field], everyoneRow[field])) {
                addError(
                    'data/family/official_result_news.csv',
                    familyRow.__rowNumber,
                    `Cross-mode ${field} disagrees for data/athlete_results.csv row ` +
                    `${familyRow.__sourceResultRowNumber}: family "${familyRow[field]}"; ` +
                    `everyone "${everyoneRow[field]}".`
                );
            }
        }
    }
}

function officialNewsCrossModeValuesEqual(field, familyValue, everyoneValue) {
    const familyText = String(familyValue || '').trim();
    const everyoneText = String(everyoneValue || '').trim();

    if (['Time', 'PreviousBestTime', 'TimeImprovement'].includes(field)) {
        const familyMilliseconds = parseOfficialNewsTimeToMilliseconds(familyText);
        const everyoneMilliseconds = parseOfficialNewsTimeToMilliseconds(everyoneText);

        return familyMilliseconds === null || everyoneMilliseconds === null
            ? familyText === everyoneText
            : familyMilliseconds === everyoneMilliseconds;
    }

    if (field === 'TimeImprovementSeconds') {
        const familyMilliseconds = parseOfficialNewsSecondsToMilliseconds(familyText);
        const everyoneMilliseconds = parseOfficialNewsSecondsToMilliseconds(everyoneText);

        return familyMilliseconds === null || everyoneMilliseconds === null
            ? familyText === everyoneText
            : familyMilliseconds === everyoneMilliseconds;
    }

    if ([
        'AgeGradeExact',
        'PreviousBestAgeGradeExact',
        'AgeGradeImprovementExact'
    ].includes(field)) {
        const familyDecimal = parseOfficialNewsPercentDecimal(familyText);
        const everyoneDecimal = parseOfficialNewsPercentDecimal(everyoneText);

        return familyDecimal === null || everyoneDecimal === null
            ? familyText === everyoneText
            : officialNewsDecimalsEqual(familyDecimal, everyoneDecimal);
    }

    return familyText === everyoneText;
}

function officialNewsEventMatchesPublicExport(newsEvent, publicEvent) {
    const newsValue = String(newsEvent || '').trim();
    const publicValue = String(publicEvent || '').trim();

    return newsValue === publicValue || (!newsValue && publicValue === 'UNKNOWN');
}

function validateOfficialNewsMilestoneFields(row, file) {
    const type = String(row.MilestoneType || '').trim();
    const isFirst = type === 'First Official Result';
    const improvesTime = ['Raw-Time PB', 'Age Grade + Raw-Time PB'].includes(type);
    const improvesAgeGrade = ['Age Grade PB', 'Age Grade + Raw-Time PB'].includes(type);
    const timeFields = ['PreviousBestTime', 'TimeImprovementSeconds', 'TimeImprovement'];
    const ageGradeFields = [
        'PreviousBestAgeGrade',
        'PreviousBestAgeGradeExact',
        'AgeGradeImprovementExact',
        'AgeGradeImprovement'
    ];

    if (isFirst) {
        validateOfficialNewsBlankFields(row, file, [...timeFields, ...ageGradeFields]);
        return;
    }

    if (improvesTime) {
        validateOfficialNewsTimeImprovement(row, file);
    } else {
        validateOfficialNewsBlankFields(row, file, timeFields);
    }

    if (improvesAgeGrade) {
        validateOfficialNewsAgeGradeImprovement(row, file);
    } else {
        validateOfficialNewsBlankFields(row, file, ageGradeFields);
    }
}

function validateOfficialNewsBlankFields(row, file, fields) {
    for (const field of fields) {
        if (String(row[field] || '').trim()) {
            addError(
                file,
                row.__rowNumber,
                `${field} must be blank for MilestoneType "${row.MilestoneType}".`
            );
        }
    }
}

function validateOfficialNewsTimeImprovement(row, file) {
    validateOfficialNewsTime(
        row.PreviousBestTime,
        file,
        row.__rowNumber,
        'PreviousBestTime',
        { required: true }
    );
    const currentMilliseconds = parseOfficialNewsTimeToMilliseconds(row.Time);
    const previousMilliseconds = parseOfficialNewsTimeToMilliseconds(row.PreviousBestTime);
    const improvementSeconds = parseOfficialNewsDecimal(
        row.TimeImprovementSeconds,
        file,
        row.__rowNumber,
        'TimeImprovementSeconds',
        { required: true, positive: true, maximumDecimalPlaces: 3 }
    );
    const improvementMilliseconds = improvementSeconds === null
        ? null
        : parseOfficialNewsSecondsToMilliseconds(row.TimeImprovementSeconds);
    const improvement = String(row.TimeImprovement || '').trim();
    let formattedMilliseconds = null;

    validateOfficialNewsTime(
        improvement,
        file,
        row.__rowNumber,
        'TimeImprovement',
        { required: true }
    );
    formattedMilliseconds = parseOfficialNewsTimeToMilliseconds(improvement);

    if (
        currentMilliseconds !== null &&
        previousMilliseconds !== null &&
        improvementMilliseconds !== null &&
        previousMilliseconds - currentMilliseconds !== improvementMilliseconds
    ) {
        const expectedMilliseconds = previousMilliseconds - currentMilliseconds;
        addError(
            file,
            row.__rowNumber,
            `TimeImprovementSeconds ${row.TimeImprovementSeconds} must equal PreviousBestTime minus Time ` +
            `(${officialNewsMillisecondsToDecimalSeconds(expectedMilliseconds)}).`
        );
    }

    if (
        improvementMilliseconds !== null &&
        formattedMilliseconds !== null &&
        improvementMilliseconds !== formattedMilliseconds
    ) {
        addError(
            file,
            row.__rowNumber,
            `TimeImprovement "${improvement}" does not equal TimeImprovementSeconds ${improvementSeconds}.`
        );
    }
}

function validateOfficialNewsAgeGradeImprovement(row, file) {
    validateOfficialNewsDisplayAgeGrade(
        row.PreviousBestAgeGrade,
        file,
        row.__rowNumber,
        'PreviousBestAgeGrade',
        { required: true }
    );
    const previousExact = parseOfficialNewsExactPercent(
        row.PreviousBestAgeGradeExact,
        file,
        row.__rowNumber,
        'PreviousBestAgeGradeExact',
        { required: true, positive: true }
    );
    const currentExact = parseOfficialNewsExactPercent(
        row.AgeGradeExact,
        file,
        row.__rowNumber,
        'AgeGradeExact',
        { required: true, positive: true, reportFormat: false }
    );
    const improvementExact = parseOfficialNewsExactPercent(
        row.AgeGradeImprovementExact,
        file,
        row.__rowNumber,
        'AgeGradeImprovementExact',
        { required: true, positive: true }
    );
    const previousDisplay = parseOfficialNewsDisplayPercent(row.PreviousBestAgeGrade);

    if (
        previousExact !== null &&
        previousDisplay !== null &&
        !officialNewsRoundsTo(previousExact, previousDisplay, 1)
    ) {
        addError(
            file,
            row.__rowNumber,
            `PreviousBestAgeGradeExact "${row.PreviousBestAgeGradeExact}" does not round to PreviousBestAgeGrade "${row.PreviousBestAgeGrade}" at one decimal place.`
        );
    }

    if (
        currentExact !== null &&
        previousExact !== null &&
        improvementExact !== null &&
        !officialNewsDecimalsEqual(
            officialNewsSubtractDecimals(currentExact, previousExact),
            improvementExact
        )
    ) {
        addError(
            file,
            row.__rowNumber,
            `AgeGradeImprovementExact "${row.AgeGradeImprovementExact}" must equal AgeGradeExact minus PreviousBestAgeGradeExact.`
        );
    }

    if (improvementExact !== null) {
        const expectedDisplay = officialNewsAgeGradeImprovementDisplay(improvementExact);
        if (String(row.AgeGradeImprovement || '').trim() !== expectedDisplay) {
            addError(
                file,
                row.__rowNumber,
                `AgeGradeImprovement "${row.AgeGradeImprovement}" must be "${expectedDisplay}" for exact improvement ${row.AgeGradeImprovementExact}.`
            );
        }
    } else if (!String(row.AgeGradeImprovement || '').trim()) {
        addError(file, row.__rowNumber, 'AgeGradeImprovement is required.');
    }
}

function validateOfficialNewsRankContext(
    row,
    file,
    [
        beforeField,
        afterField,
        gainField,
        medalEntryField,
        medalBeforeField,
        medalAfterField,
        displacedAthleteIdField,
        displacedAthleteNameField,
        displacedMedalBeforeField,
        displacedMedalAfterField
    ],
    options = {}
) {
    const beforeText = String(row[beforeField] || '').trim();
    const afterText = String(row[afterField] || '').trim();
    const gainText = String(row[gainField] || '').trim();
    const medalEntryText = String(row[medalEntryField] || '').trim();
    const medalBeforeText = String(row[medalBeforeField] || '').trim();
    const medalAfterText = String(row[medalAfterField] || '').trim();
    const medalEntryIsAllowed = !medalEntryText || officialNewsMedalEntries.includes(medalEntryText);

    if (!medalEntryIsAllowed) {
        addError(
            file,
            row.__rowNumber,
            `${medalEntryField} "${medalEntryText}" must be blank or one of: ${officialNewsMedalEntries.join(', ')}.`
        );
    }

    if (options.tableAvailable === false) {
        for (const field of [
            beforeField,
            afterField,
            gainField,
            medalEntryField,
            medalBeforeField,
            medalAfterField,
            displacedAthleteIdField,
            displacedAthleteNameField,
            displacedMedalBeforeField,
            displacedMedalAfterField
        ]) {
            if (String(row[field] || '').trim()) {
                addError(
                    file,
                    row.__rowNumber,
                    `${field} must be blank because 1 Mile has no dedicated Official distance leaderboard.`
                );
            }
        }
        return;
    }

    const before = parseOfficialNewsInteger(
        beforeText,
        file,
        row.__rowNumber,
        beforeField,
        { minimum: 1 }
    );
    const after = parseOfficialNewsInteger(
        afterText,
        file,
        row.__rowNumber,
        afterField,
        { minimum: 1 }
    );

    validateOfficialNewsMedalSnapshot(
        medalBeforeText,
        medalBeforeField,
        beforeText,
        before,
        beforeField,
        row,
        file
    );
    validateOfficialNewsMedalSnapshot(
        medalAfterText,
        medalAfterField,
        afterText,
        after,
        afterField,
        row,
        file
    );

    if (
        medalEntryIsAllowed &&
        after !== null &&
        (!beforeText || before !== null)
    ) {
        const afterMedal = officialNewsMedalForRank(after);
        const enteredMedalPosition = afterMedal && (!beforeText || before > 3);
        const expectedMedalEntry = enteredMedalPosition ? afterMedal : '';

        if (medalEntryText !== expectedMedalEntry) {
            if (expectedMedalEntry) {
                addError(
                    file,
                    row.__rowNumber,
                    `${medalEntryField} must be "${expectedMedalEntry}" because the result entered a medal position at Rank ${after}.`
                );
            } else {
                addError(
                    file,
                    row.__rowNumber,
                    `${medalEntryField} must be blank because the result did not enter a new medal position.`
                );
            }
        }
    }

    // The separately validated 12-file Official matrix makes all four table
    // contexts available for every supported News distance. The contract's
    // all-blank "table unavailable" state is therefore not valid in this
    // repository configuration.
    if (!afterText) {
        addError(
            file,
            row.__rowNumber,
            `${afterField} is required because the complete Official leaderboard matrix is required.`
        );
    }

    validateOfficialNewsDisplacement(
        row,
        file,
        {
            medalBeforeText,
            medalAfterText,
            athleteIdField: displacedAthleteIdField,
            athleteNameField: displacedAthleteNameField,
            medalBeforeField: displacedMedalBeforeField,
            medalAfterField: displacedMedalAfterField
        },
        options
    );

    if (!beforeText) {
        if (gainText) {
            addError(file, row.__rowNumber, `${gainField} must be blank when ${beforeField} is blank.`);
        }
        return;
    }

    const gain = parseOfficialNewsInteger(
        gainText,
        file,
        row.__rowNumber,
        gainField,
        { required: true, minimum: 0 }
    );

    if (before !== null && after !== null && gain !== null) {
        const expectedGain = before - after;
        if (expectedGain < 0) {
            addError(
                file,
                row.__rowNumber,
                `${afterField} ${after} must not be worse than ${beforeField} ${before}.`
            );
        }
        if (gain !== expectedGain) {
            addError(
                file,
                row.__rowNumber,
                `${gainField} ${gain} must equal ${beforeField} minus ${afterField} (${expectedGain}).`
            );
        }
    }
}

function validateOfficialNewsDisplacement(
    row,
    file,
    {
        medalBeforeText,
        medalAfterText,
        athleteIdField,
        athleteNameField,
        medalBeforeField,
        medalAfterField
    },
    options
) {
    const displacedAthleteId = String(row[athleteIdField] || '').trim();
    const displacedAthleteName = String(row[athleteNameField] || '').trim();
    const displacedMedalBefore = String(row[medalBeforeField] || '').trim();
    const displacedMedalAfter = String(row[medalAfterField] || '').trim();
    const fields = [
        athleteIdField,
        athleteNameField,
        medalBeforeField,
        medalAfterField
    ];
    const values = [
        displacedAthleteId,
        displacedAthleteName,
        displacedMedalBefore,
        displacedMedalAfter
    ];
    const populated = values.filter(Boolean).length;

    // A workbook may leave the entire group blank where the prior holder was
    // absent or tied and therefore cannot be represented faithfully by this
    // singular, person-level field group. Partial metadata is never safe for
    // the display-only browser contract.
    if (populated === 0) {
        return;
    }

    if (populated !== values.length) {
        addError(
            file,
            row.__rowNumber,
            `${fields.join(', ')} must be either all blank or all populated.`
        );
        return;
    }

    if (
        !officialNewsMedalEntries.includes(medalAfterText) ||
        medalBeforeText === medalAfterText
    ) {
        addError(
            file,
            row.__rowNumber,
            `${fields.join(', ')} must be blank unless the focal athlete moves into a different medal position.`
        );
        return;
    }

    validateAthleteId(displacedAthleteId, file, row.__rowNumber, athleteIdField, { required: true });
    requireValue(displacedAthleteName, file, row.__rowNumber, athleteNameField);

    if (options.siteAthleteIds && !options.siteAthleteIds.has(displacedAthleteId)) {
        addError(
            file,
            row.__rowNumber,
            `${athleteIdField} "${displacedAthleteId}" is not eligible for the ${options.siteMode} site mode.`
        );
    }

    if (displacedAthleteId === String(row.AthleteID || '').trim()) {
        addError(
            file,
            row.__rowNumber,
            `${athleteIdField} must identify a different athlete from AthleteID.`
        );
    }

    const publicIdentityMatches = athleteObjects.some(result =>
        String(result.AthleteID || '').trim() === displacedAthleteId &&
        String(result.Participant || '').trim() === displacedAthleteName
    );
    if (!publicIdentityMatches) {
        addError(
            file,
            row.__rowNumber,
            `${athleteIdField} and ${athleteNameField} must match one athlete identity in data/athlete_results.csv.`
        );
    }

    if (!officialNewsMedalEntries.includes(displacedMedalBefore)) {
        addError(
            file,
            row.__rowNumber,
            `${medalBeforeField} "${displacedMedalBefore}" must be one of: ${officialNewsMedalEntries.join(', ')}.`
        );
    } else if (displacedMedalBefore !== medalAfterText) {
        addError(
            file,
            row.__rowNumber,
            `${medalBeforeField} must be "${medalAfterText}" because it is the focal athlete's MedalAfter.`
        );
    }

    if (!officialNewsDisplacedMedalAfterValues.includes(displacedMedalAfter)) {
        addError(
            file,
            row.__rowNumber,
            `${medalAfterField} "${displacedMedalAfter}" must be one of: ${officialNewsDisplacedMedalAfterValues.join(', ')}.`
        );
        return;
    }

    const expectedDisplacedMedalAfter = officialNewsDisplacedMedalSuccessors.get(displacedMedalBefore);
    if (expectedDisplacedMedalAfter && displacedMedalAfter !== expectedDisplacedMedalAfter) {
        addError(
            file,
            row.__rowNumber,
            `${medalAfterField} must be "${expectedDisplacedMedalAfter}" after ${medalBeforeField} "${displacedMedalBefore}".`
        );
    }
}

function validateOfficialNewsMedalSnapshot(
    medalText,
    medalField,
    rankText,
    rank,
    rankField,
    row,
    file
) {
    if (medalText && !officialNewsMedalEntries.includes(medalText)) {
        addError(
            file,
            row.__rowNumber,
            `${medalField} "${medalText}" must be blank or one of: ${officialNewsMedalEntries.join(', ')}.`
        );
        return;
    }

    if (!rankText) {
        if (medalText) {
            addError(file, row.__rowNumber, `${medalField} must be blank when ${rankField} is blank.`);
        }
        return;
    }

    if (rank === null) {
        return;
    }

    const expectedMedal = officialNewsMedalForRank(rank);
    if (medalText !== expectedMedal) {
        if (expectedMedal) {
            addError(
                file,
                row.__rowNumber,
                `${medalField} must be "${expectedMedal}" because ${rankField} is Rank ${rank}.`
            );
        } else {
            addError(
                file,
                row.__rowNumber,
                `${medalField} must be blank because ${rankField} ${rank} is not a medal position.`
            );
        }
    }
}

function officialNewsMedalForRank(rank) {
    // Rank is workbook-owned competition rank. Tied athletes therefore carry
    // the same rank and medal; skipped competition ranks award no medal. This
    // consistency check never uses row position or invents a tie-break.
    return {
        1: 'Gold',
        2: 'Silver',
        3: 'Bronze'
    }[rank] || '';
}

function validateOfficialNewsMilestoneChains(objects, file) {
    const histories = new Map();

    // The file is newest first; replay each history oldest first. This verifies
    // the denormalized previous-best fields without deriving any rank.
    for (const row of [...objects].reverse()) {
        const athleteId = String(row.AthleteID || '').trim();
        const distance = String(row.Distance || '').trim();
        const key = `${athleteId}|${distance}`;
        const type = String(row.MilestoneType || '').trim();
        const currentTime = String(row.Time || '').trim();
        const currentMilliseconds = parseOfficialNewsTimeToMilliseconds(currentTime);
        const currentExact = parseOfficialNewsExactPercent(
            row.AgeGradeExact,
            file,
            row.__rowNumber,
            'AgeGradeExact',
            { reportFormat: false }
        );
        const state = histories.get(key);

        if (!state) {
            if (type !== 'First Official Result') {
                addError(
                    file,
                    row.__rowNumber,
                    `The oldest News row for ${athleteId} ${distance} must be First Official Result.`
                );
            }
            validateOfficialNewsFirstSourceDate(row, file);
            histories.set(key, {
                bestTime: currentTime,
                bestTimeMilliseconds: currentMilliseconds,
                bestAgeGrade: String(row.AgeGrade || '').trim(),
                bestAgeGradeExact: currentExact
            });
            continue;
        }

        if (type === 'First Official Result') {
            addError(file, row.__rowNumber, `Duplicate First Official Result for ${athleteId} ${distance}.`);
            continue;
        }

        const improvesTime = ['Raw-Time PB', 'Age Grade + Raw-Time PB'].includes(type);
        const improvesAgeGrade = ['Age Grade PB', 'Age Grade + Raw-Time PB'].includes(type);

        if (currentMilliseconds !== null && state.bestTimeMilliseconds !== null) {
            if (improvesTime) {
                const previousBestMilliseconds = parseOfficialNewsTimeToMilliseconds(row.PreviousBestTime);
                if (previousBestMilliseconds !== state.bestTimeMilliseconds) {
                    addError(
                        file,
                        row.__rowNumber,
                        `PreviousBestTime "${row.PreviousBestTime}" does not match the prior exported raw-time best "${state.bestTime}".`
                    );
                }
                if (currentMilliseconds >= state.bestTimeMilliseconds) {
                    addError(file, row.__rowNumber, 'Raw-Time PB must be strictly faster than the prior exported best.');
                } else {
                    state.bestTime = currentTime;
                    state.bestTimeMilliseconds = currentMilliseconds;
                }
            } else if (currentMilliseconds < state.bestTimeMilliseconds) {
                addError(file, row.__rowNumber, 'MilestoneType omits a strict raw-time improvement.');
            }
        }

        if (currentExact !== null && state.bestAgeGradeExact !== null) {
            if (improvesAgeGrade) {
                if (String(row.PreviousBestAgeGrade || '').trim() !== state.bestAgeGrade) {
                    addError(
                        file,
                        row.__rowNumber,
                        `PreviousBestAgeGrade "${row.PreviousBestAgeGrade}" does not match the prior exported display best "${state.bestAgeGrade}".`
                    );
                }
                const previousExact = parseOfficialNewsExactPercent(
                    row.PreviousBestAgeGradeExact,
                    file,
                    row.__rowNumber,
                    'PreviousBestAgeGradeExact',
                    { reportFormat: false }
                );
                if (
                    previousExact !== null &&
                    !officialNewsDecimalsEqual(previousExact, state.bestAgeGradeExact)
                ) {
                    addError(
                        file,
                        row.__rowNumber,
                        `PreviousBestAgeGradeExact "${row.PreviousBestAgeGradeExact}" does not match the prior exported exact best.`
                    );
                }
                if (officialNewsCompareDecimals(currentExact, state.bestAgeGradeExact) <= 0) {
                    addError(file, row.__rowNumber, 'Age Grade PB must be a strict full-precision improvement.');
                } else {
                    state.bestAgeGrade = String(row.AgeGrade || '').trim();
                    state.bestAgeGradeExact = currentExact;
                }
            } else if (officialNewsCompareDecimals(currentExact, state.bestAgeGradeExact) > 0) {
                addError(file, row.__rowNumber, 'MilestoneType omits a strict full-precision age-grade improvement.');
            }
        }
    }
}

function validateOfficialNewsFirstSourceDate(row, file) {
    const resultDate = parseUkDate(String(row.ResultDate || '').trim());
    if (!resultDate) {
        return;
    }

    const hasEarlierPublicResult = athleteObjects.some(result => {
        if (
            String(result.AthleteID || '').trim() !== String(row.AthleteID || '').trim() ||
            String(result.TimeClass || '').trim() !== 'Official' ||
            canonicalDistanceLabel(result.Distance) !== String(row.Distance || '').trim()
        ) {
            return false;
        }

        const sourceDate = parseUkDate(String(result.Date || '').trim());
        return sourceDate && sourceDate < resultDate;
    });

    if (hasEarlierPublicResult) {
        addError(
            file,
            row.__rowNumber,
            'First Official Result has an earlier public Official result for the same athlete and canonical distance.'
        );
    }
}

function validateOfficialNewsDisplayAgeGrade(value, file, rowNumber, column, options = {}) {
    const text = String(value || '').trim();

    if (!text) {
        if (options.required) {
            addError(file, rowNumber, `${column} is required.`);
        }
        return;
    }

    if (!/^\d+\.\d%$/.test(text) || Number(text.slice(0, -1)) <= 0) {
        addError(file, rowNumber, `${column} "${text}" must be a positive percentage with one decimal place.`);
    }
}

function validateOfficialNewsTime(value, file, rowNumber, column, options = {}) {
    const text = String(value || '').trim();

    if (!text) {
        if (options.required) {
            addError(file, rowNumber, `${column} is required.`);
        }
        return;
    }

    if (!/^\d{2,3}:[0-5]\d:[0-5]\d(?:\.\d{1,3})?$/.test(text)) {
        addError(file, rowNumber, `${column} "${text}" must use HH:MM:SS with optional .fff.`);
    }
}

function parseOfficialNewsTimeToMilliseconds(value) {
    const text = String(value || '').trim();
    if (!/^\d{2,3}:[0-5]\d:[0-5]\d(?:\.\d{1,3})?$/.test(text)) {
        return null;
    }

    const [hoursText, minutesText, secondsText] = text.split(':');
    const [wholeSeconds, fraction = ''] = secondsText.split('.');

    return (
        (Number(hoursText) * 3600 * 1000) +
        (Number(minutesText) * 60 * 1000) +
        (Number(wholeSeconds) * 1000) +
        Number(fraction.padEnd(3, '0') || 0)
    );
}

function officialNewsTimeMatchesPublicDisplay(newsMilliseconds, publicTime) {
    const publicSeconds = parseTimeToSeconds(publicTime);

    return newsMilliseconds !== null &&
        publicSeconds !== null &&
        Math.floor((newsMilliseconds + 500) / 1000) === publicSeconds;
}

function parseOfficialNewsSecondsToMilliseconds(value) {
    const text = String(value || '').trim();
    const match = text.match(/^(0|[1-9]\d*)(?:\.(\d{1,3}))?$/);

    if (!match) {
        return null;
    }

    const wholeSeconds = Number(match[1]);
    const fractionalMilliseconds = Number((match[2] || '').padEnd(3, '0') || 0);
    const milliseconds = (wholeSeconds * 1000) + fractionalMilliseconds;

    return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

function officialNewsMillisecondsToDecimalSeconds(milliseconds) {
    const sign = milliseconds < 0 ? '-' : '';
    const absolute = Math.abs(milliseconds);
    const wholeSeconds = Math.floor(absolute / 1000);
    const fraction = String(absolute % 1000).padStart(3, '0').replace(/0+$/, '');

    return `${sign}${wholeSeconds}${fraction ? `.${fraction}` : ''}`;
}

function parseOfficialNewsDisplayPercent(value) {
    const text = String(value || '').trim();
    return /^\d+\.\d%$/.test(text)
        ? parseOfficialNewsDecimalValue(text.slice(0, -1))
        : null;
}

function parseOfficialNewsExactPercent(value, file, rowNumber, column, options = {}) {
    const text = String(value || '').trim();

    if (!text) {
        if (options.required) {
            addError(file, rowNumber, `${column} is required.`);
        }
        return null;
    }

    if (!/^(?:0|[1-9]\d*)(?:\.\d+)?%$/.test(text)) {
        if (options.reportFormat !== false) {
            addError(file, rowNumber, `${column} "${text}" must be a decimal percentage including %.`);
        }
        return null;
    }

    const decimal = parseOfficialNewsPercentDecimal(text);
    if (decimal === null || (options.positive && officialNewsCompareDecimals(decimal, officialNewsZeroDecimal()) <= 0)) {
        if (options.reportFormat !== false) {
            addError(file, rowNumber, `${column} "${text}" must be positive.`);
        }
        return null;
    }

    return decimal;
}

function parseOfficialNewsInteger(value, file, rowNumber, column, options = {}) {
    const text = String(value || '').trim();

    if (!text) {
        if (options.required) {
            addError(file, rowNumber, `${column} is required.`);
        }
        return null;
    }

    if (!/^(0|[1-9]\d*)$/.test(text)) {
        addError(file, rowNumber, `${column} "${text}" must be a non-negative integer.`);
        return null;
    }

    const number = Number(text);
    if (!Number.isSafeInteger(number) || number < (options.minimum ?? 0)) {
        addError(
            file,
            rowNumber,
            `${column} "${text}" must be an integer of at least ${options.minimum ?? 0}.`
        );
        return null;
    }

    return number;
}

function parseOfficialNewsDecimal(value, file, rowNumber, column, options = {}) {
    const text = String(value || '').trim();

    if (!text) {
        if (options.required) {
            addError(file, rowNumber, `${column} is required.`);
        }
        return null;
    }

    const decimalPattern = new RegExp(`^(?:0|[1-9]\\d*)(?:\\.\\d{1,${options.maximumDecimalPlaces ?? 3}})?$`);
    if (!decimalPattern.test(text)) {
        addError(
            file,
            rowNumber,
            `${column} "${text}" must be a non-negative decimal with at most ${options.maximumDecimalPlaces ?? 3} places.`
        );
        return null;
    }

    const number = Number(text);
    if (!Number.isFinite(number) || (options.positive && number <= 0)) {
        addError(file, rowNumber, `${column} "${text}" must be positive.`);
        return null;
    }

    return number;
}

function officialNewsRoundsTo(exact, display, decimalPlaces) {
    return officialNewsDecimalsEqual(
        officialNewsRoundDecimal(exact, decimalPlaces),
        display
    );
}

function parseOfficialNewsPercentDecimal(value) {
    const text = String(value || '').trim();

    if (!text.endsWith('%')) {
        return null;
    }

    return parseOfficialNewsDecimalValue(text.slice(0, -1));
}

function parseOfficialNewsDecimalValue(value) {
    const text = String(value || '').trim();
    const match = text.match(/^(0|[1-9]\d*)(?:\.(\d+))?$/);

    if (!match) {
        return null;
    }

    const fraction = match[2] || '';
    return {
        coefficient: BigInt(`${match[1]}${fraction}`),
        scale: fraction.length
    };
}

function officialNewsZeroDecimal() {
    return { coefficient: 0n, scale: 0 };
}

function officialNewsCompareDecimals(left, right) {
    const scale = Math.max(left.scale, right.scale);
    const leftCoefficient = officialNewsScaledCoefficient(left, scale);
    const rightCoefficient = officialNewsScaledCoefficient(right, scale);

    if (leftCoefficient < rightCoefficient) return -1;
    if (leftCoefficient > rightCoefficient) return 1;
    return 0;
}

function officialNewsDecimalsEqual(left, right) {
    return officialNewsCompareDecimals(left, right) === 0;
}

function officialNewsSubtractDecimals(left, right) {
    const scale = Math.max(left.scale, right.scale);
    return {
        coefficient:
            officialNewsScaledCoefficient(left, scale) -
            officialNewsScaledCoefficient(right, scale),
        scale
    };
}

function officialNewsScaledCoefficient(decimal, scale) {
    return decimal.coefficient * (10n ** BigInt(scale - decimal.scale));
}

function officialNewsRoundDecimal(decimal, decimalPlaces) {
    if (decimal.scale <= decimalPlaces) {
        return {
            coefficient: officialNewsScaledCoefficient(decimal, decimalPlaces),
            scale: decimalPlaces
        };
    }

    const divisor = 10n ** BigInt(decimal.scale - decimalPlaces);
    const negative = decimal.coefficient < 0n;
    const magnitude = negative ? -decimal.coefficient : decimal.coefficient;
    let roundedMagnitude = magnitude / divisor;
    const remainder = magnitude % divisor;

    if ((remainder * 2n) >= divisor) {
        roundedMagnitude += 1n;
    }

    return {
        coefficient: negative ? -roundedMagnitude : roundedMagnitude,
        scale: decimalPlaces
    };
}

function officialNewsAgeGradeImprovementDisplay(improvementExact) {
    const rounded = officialNewsRoundDecimal(improvementExact, 2);
    if (rounded.coefficient === 0n) {
        return '+<0.01 pp';
    }

    const whole = rounded.coefficient / 100n;
    const fraction = String(rounded.coefficient % 100n).padStart(2, '0');
    return `+${whole}.${fraction} pp`;
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

    const absoluteDir = path.join(validationRoot, siteDir);

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
        'pace_per_km',
        'pace_per_mile',
        'SortOrder'
    ]);

    for (const row of toObjects(rows, file)) {
        validateAthleteId(row.AthleteId, file, row.__rowNumber, 'AthleteId', { required: true, severity: 'warning' });
        validatePercent(row.AgeGrade, file, row.__rowNumber, 'AgeGrade', { required: true });
        validateTime(row.RequiredTime, file, row.__rowNumber, 'RequiredTime', { required: true });
        validateAgeGradePaces(row, file);
        validateNumber(row.SortOrder, file, row.__rowNumber, 'SortOrder', { required: true });
    }
}

function validateAgeGradeCalculator(siteDir) {
    const file = `${siteDir}/age_grade_calculator.csv`;
    const rows = readCsvRequired(file, [
        'AthleteId',
        'Participant',
        'Distance',
        'AgeGradedStandardSeconds',
        'ValidationTimeSeconds',
        'ValidationAgeGrade',
        'CalculationContractVersion',
        'CalculationContractSignature',
        'SortOrder',
        'ExportBundleID'
    ]);
    const objects = toObjects(rows, file);
    const expectedDistances = ['5 km', '10 km', '10 Mile', 'Half Marathon', 'Marathon'];
    const rowsByAthlete = new Map();
    const seenPairs = new Set();

    for (const row of objects) {
        validateAthleteId(row.AthleteId, file, row.__rowNumber, 'AthleteId', { required: true });
        requireValue(row.Participant, file, row.__rowNumber, 'Participant');
        validateAllowed(row.Distance, expectedDistances, file, row.__rowNumber, 'Distance');
        validatePositiveCalculatorNumber(row.AgeGradedStandardSeconds, file, row.__rowNumber, 'AgeGradedStandardSeconds');
        validatePositiveCalculatorNumber(row.ValidationTimeSeconds, file, row.__rowNumber, 'ValidationTimeSeconds');
        validatePositiveCalculatorNumber(row.ValidationAgeGrade, file, row.__rowNumber, 'ValidationAgeGrade');
        validateNumber(row.SortOrder, file, row.__rowNumber, 'SortOrder', { required: true });

        compareExportedValue(
            row.CalculationContractVersion,
            ageGradeContract.version,
            file,
            row.__rowNumber,
            'CalculationContractVersion',
            'website contract'
        );
        compareExportedValue(
            row.CalculationContractSignature,
            ageGradeContract.signature,
            file,
            row.__rowNumber,
            'CalculationContractSignature',
            'website contract'
        );

        const expectedScore = ageGradeContract.calculate(
            row.AgeGradedStandardSeconds,
            row.ValidationTimeSeconds
        );
        const workbookScore = Number(row.ValidationAgeGrade);
        const tolerance = Math.max(1e-13, Math.abs(workbookScore) * 1e-12);
        if (Number.isFinite(workbookScore) && Math.abs(expectedScore - workbookScore) > tolerance) {
            addError(
                file,
                row.__rowNumber,
                'ValidationAgeGrade does not match the website calculation for the workbook conformance input.'
            );
        }

        const pairKey = `${row.AthleteId}|${row.Distance}`;
        if (seenPairs.has(pairKey)) {
            addError(file, row.__rowNumber, `Duplicate calculator row "${pairKey}".`);
        }
        seenPairs.add(pairKey);

        const distanceIndex = expectedDistances.indexOf(row.Distance);
        if (distanceIndex >= 0 && Number(row.SortOrder) !== (distanceIndex + 1) * 100) {
            addError(file, row.__rowNumber, `SortOrder must be ${(distanceIndex + 1) * 100} for ${row.Distance}.`);
        }

        if (!rowsByAthlete.has(row.AthleteId)) rowsByAthlete.set(row.AthleteId, []);
        rowsByAthlete.get(row.AthleteId).push(row);
    }

    const standardsFile = `${siteDir}/age_grade_standards.csv`;
    const standards = toObjects(readCsvRequired(standardsFile, ['AthleteId']), standardsFile);
    const expectedAthletes = new Set(standards.map(row => row.AthleteId).filter(Boolean));

    for (const athleteId of expectedAthletes) {
        const athleteRows = rowsByAthlete.get(athleteId) || [];
        const exportedDistances = new Set(athleteRows.map(row => row.Distance));
        if (athleteRows.length !== expectedDistances.length) {
            addError(file, 1, `AthleteId "${athleteId}" must have exactly ${expectedDistances.length} calculator rows.`);
        }
        for (const distance of expectedDistances) {
            if (!exportedDistances.has(distance)) {
                addError(file, 1, `AthleteId "${athleteId}" is missing calculator distance "${distance}".`);
            }
        }
    }

    for (const athleteId of rowsByAthlete.keys()) {
        if (!expectedAthletes.has(athleteId)) {
            addError(file, 1, `Calculator AthleteId "${athleteId}" is not available in age_grade_standards.csv.`);
        }
    }
}

function validatePositiveCalculatorNumber(value, file, rowNumber, column) {
    validateNumber(value, file, rowNumber, column, { required: true });
    if (String(value || '').trim() && Number(value) <= 0) {
        addError(file, rowNumber, `${column} must be greater than zero.`);
    }
}

function validateAthleteComparisonTargets(siteDir) {
    const file = `${siteDir}/athlete_comparison_targets.csv`;

    if (!fs.existsSync(path.join(validationRoot, file))) {
        return;
    }

    const rows = readCsvRequired(file, [
        'ChallengerAthleteId',
        'StandardAthleteId',
        'Distance',
        'BenchmarkType',
        'StandardTime',
        'StandardAgeGrade',
        'StandardDate',
        'StandardEvent',
        'StandardTimeClass',
        'RequiredTimeToBeat',
        'RequiredPacePerKm',
        'RequiredPacePerMile',
        'SortOrder',
        'ExportBundleID'
    ]);
    const hasPeriodColumn = (rows[0] || []).includes('Period');
    const objects = toObjects(rows, file);
    const uniqueRows = new Set();
    const benchmarksByPairPeriodDistanceClass = new Map();
    const comparisonDistances = ['5 km', '10 km', '10 Mile', 'Half Marathon', 'Marathon'];
    const comparisonTimeClasses = ['Official', 'Unofficial'];
    const comparisonPeriods = hasPeriodColumn ? ['Current', 'All Time'] : ['All Time'];
    const comparisonWindow = comparisonCurrentWindow();
    const ageStandardRows = toObjects(
        readCsvRequired(`${siteDir}/age_grade_standards.csv`, ['AthleteId']),
        `${siteDir}/age_grade_standards.csv`
    );
    const siteAthleteIds = new Set(
        ageStandardRows
            .map(row => String(row.AthleteId || '').trim())
            .filter(Boolean)
    );

    for (const row of objects) {
        const period = hasPeriodColumn ? String(row.Period || '').trim() : 'All Time';
        validateAthleteId(row.ChallengerAthleteId, file, row.__rowNumber, 'ChallengerAthleteId', { required: true });
        validateAthleteId(row.StandardAthleteId, file, row.__rowNumber, 'StandardAthleteId', { required: true });
        validateAllowed(row.Distance, comparisonDistances, file, row.__rowNumber, 'Distance');
        validateAllowed(row.BenchmarkType, ['Best Age Grade', 'Fastest Time'], file, row.__rowNumber, 'BenchmarkType');
        validateTime(row.StandardTime, file, row.__rowNumber, 'StandardTime', { required: true });
        validatePercent(row.StandardAgeGrade, file, row.__rowNumber, 'StandardAgeGrade', { required: true });
        validateDate(row.StandardDate, file, row.__rowNumber, 'StandardDate', { required: true });
        requireValue(row.StandardEvent, file, row.__rowNumber, 'StandardEvent');
        validateAllowed(row.StandardTimeClass, comparisonTimeClasses, file, row.__rowNumber, 'StandardTimeClass');
        if (hasPeriodColumn) {
            validateAllowed(period, comparisonPeriods, file, row.__rowNumber, 'Period');
        }
        validateTime(row.RequiredTimeToBeat, file, row.__rowNumber, 'RequiredTimeToBeat', { required: true });
        validateComparisonTargetPaces(row, file);
        validateNumber(row.SortOrder, file, row.__rowNumber, 'SortOrder', { required: true });

        if (row.ChallengerAthleteId && row.ChallengerAthleteId === row.StandardAthleteId) {
            addError(file, row.__rowNumber, 'ChallengerAthleteId and StandardAthleteId must be different.');
        }
        if (row.ChallengerAthleteId && !siteAthleteIds.has(row.ChallengerAthleteId)) {
            addError(file, row.__rowNumber, `ChallengerAthleteId "${row.ChallengerAthleteId}" is not available in this site mode.`);
        }
        if (row.StandardAthleteId && !siteAthleteIds.has(row.StandardAthleteId)) {
            addError(file, row.__rowNumber, `StandardAthleteId "${row.StandardAthleteId}" is not available in this site mode.`);
        }

        const uniqueKey = [
            row.ChallengerAthleteId,
            row.StandardAthleteId,
            period,
            row.Distance,
            row.StandardTimeClass,
            row.BenchmarkType
        ].join('|');
        if (uniqueRows.has(uniqueKey)) {
            addError(file, row.__rowNumber, `Duplicate comparison target "${uniqueKey}".`);
        }
        uniqueRows.add(uniqueKey);

        const groupKey = [
            row.ChallengerAthleteId,
            row.StandardAthleteId,
            period,
            row.Distance,
            row.StandardTimeClass
        ].join('|');
        if (!benchmarksByPairPeriodDistanceClass.has(groupKey)) {
            benchmarksByPairPeriodDistanceClass.set(groupKey, new Set());
        }
        benchmarksByPairPeriodDistanceClass.get(groupKey).add(row.BenchmarkType);

        const distanceIndex = comparisonDistances.indexOf(row.Distance);
        const timeClassIndex = comparisonTimeClasses.indexOf(row.StandardTimeClass);
        const benchmarkIndex = ['Best Age Grade', 'Fastest Time'].indexOf(row.BenchmarkType);
        if (distanceIndex >= 0 && timeClassIndex >= 0 && benchmarkIndex >= 0) {
            const expectedSortOrder = ((distanceIndex + 1) * 100) + (timeClassIndex * 2) + benchmarkIndex + 1;
            if (Number(row.SortOrder) !== expectedSortOrder) {
                addError(file, row.__rowNumber, `SortOrder must be ${expectedSortOrder} for ${row.Distance} ${row.StandardTimeClass} ${row.BenchmarkType}.`);
            }
        }

        validateComparisonStandardSource(row, file, period, comparisonWindow);
    }

    for (const standardAthleteId of siteAthleteIds) {
        const standardDistanceClassesByPeriod = new Map(
            comparisonPeriods.map(period => [period, new Map()])
        );
        for (const result of athleteObjects.filter(result => result.AthleteID === standardAthleteId)) {
            const distance = canonicalDistanceLabel(result.Distance);
            const timeClass = String(result.TimeClass || '').trim();
            if (comparisonDistances.includes(distance) && comparisonTimeClasses.includes(timeClass)) {
                standardDistanceClassesByPeriod.get('All Time')
                    .set(`${distance}|${timeClass}`, { distance, timeClass });
                if (hasPeriodColumn && isComparisonResultInPeriod(result, 'Current', comparisonWindow)) {
                    standardDistanceClassesByPeriod.get('Current')
                        .set(`${distance}|${timeClass}`, { distance, timeClass });
                }
            }
        }

        for (const challengerAthleteId of siteAthleteIds) {
            if (challengerAthleteId === standardAthleteId) {
                continue;
            }

            for (const period of comparisonPeriods) {
                for (const { distance, timeClass } of standardDistanceClassesByPeriod.get(period).values()) {
                    const groupKey = [challengerAthleteId, standardAthleteId, period, distance, timeClass].join('|');
                    const benchmarkTypes = benchmarksByPairPeriodDistanceClass.get(groupKey) || new Set();

                    for (const requiredType of ['Best Age Grade', 'Fastest Time']) {
                        if (!benchmarkTypes.has(requiredType)) {
                            addError(file, 1, `${groupKey} is missing the ${requiredType} benchmark.`);
                        }
                    }
                }
            }
        }
    }
}

function validateComparisonStandardSource(row, file, period, comparisonWindow) {
    const matchingResults = athleteObjects.filter(result =>
        result.AthleteID === row.StandardAthleteId &&
        canonicalDistanceKey(result.Distance) === canonicalDistanceKey(row.Distance) &&
        String(result.TimeClass || '').trim() === String(row.StandardTimeClass || '').trim() &&
        isComparisonResultInPeriod(result, period, comparisonWindow)
    );
    const sourceResult = matchingResults.find(result =>
        String(result.Time || '').trim() === String(row.StandardTime || '').trim() &&
        String(result.AgeGrade || '').trim() === String(row.StandardAgeGrade || '').trim() &&
        String(result.Date || '').trim() === String(row.StandardDate || '').trim() &&
        String(result.Event || '').trim() === String(row.StandardEvent || '').trim() &&
        String(result.TimeClass || '').trim() === String(row.StandardTimeClass || '').trim()
    );

    if (!sourceResult) {
        addError(file, row.__rowNumber, 'Exported standard performance does not match data/athlete_results.csv.');
        return;
    }

    if (row.BenchmarkType === 'Best Age Grade') {
        const exportedGrade = Number(String(row.StandardAgeGrade || '').replace('%', ''));
        const hasHigherGrade = matchingResults.some(result =>
            Number(String(result.AgeGrade || '').replace('%', '')) > exportedGrade
        );
        if (hasHigherGrade) {
            addError(file, row.__rowNumber, 'Best Age Grade is not the standard athlete\'s highest exported age grade for this distance.');
        }
    }

    if (row.BenchmarkType === 'Fastest Time') {
        const exportedSeconds = parseTimeToSeconds(row.StandardTime);
        const hasFasterTime = matchingResults.some(result => {
            const resultSeconds = parseTimeToSeconds(result.Time);
            return resultSeconds !== null && exportedSeconds !== null && resultSeconds < exportedSeconds;
        });
        if (hasFasterTime) {
            addError(file, row.__rowNumber, 'Fastest Time is not the standard athlete\'s fastest exported time for this distance.');
        }
    }
}

function comparisonCurrentWindow() {
    const manifestRows = toObjects(parseCsvFile(manifestFile), manifestFile);
    const exportedAt = new Date(String(manifestRows[0]?.ExportedAtUTC || ''));

    if (Number.isNaN(exportedAt.getTime())) {
        return null;
    }

    const end = new Date(Date.UTC(
        exportedAt.getUTCFullYear(),
        exportedAt.getUTCMonth(),
        exportedAt.getUTCDate()
    ));
    const priorYear = end.getUTCFullYear() - 1;
    const lastDayOfMonth = new Date(Date.UTC(priorYear, end.getUTCMonth() + 1, 0)).getUTCDate();
    const start = new Date(Date.UTC(
        priorYear,
        end.getUTCMonth(),
        Math.min(end.getUTCDate(), lastDayOfMonth)
    ));

    return { start, end };
}

function isComparisonResultInPeriod(result, period, comparisonWindow) {
    if (period !== 'Current') {
        return true;
    }

    const resultDate = parseUkDate(String(result.Date || '').trim());
    return Boolean(
        comparisonWindow &&
        resultDate &&
        resultDate >= comparisonWindow.start &&
        resultDate <= comparisonWindow.end
    );
}

function validateComparisonTargetPaces(row, file) {
    const distance = ageGradeStandardDistance(row.Distance);
    const targetSeconds = parseTimeToSeconds(row.RequiredTimeToBeat);
    const paces = [
        ['RequiredPacePerKm', 1_000_000],
        ['RequiredPacePerMile', 1_609_344]
    ];

    if (!distance) {
        return;
    }

    for (const [column, unitInScaledKilometres] of paces) {
        const value = String(row[column] || '').trim();

        if (!/^\d+:[0-5]\d\.\d$/.test(value)) {
            addError(file, row.__rowNumber, `${column} "${value}" must use m:ss.s.`);
            continue;
        }

        if (targetSeconds === null) {
            continue;
        }

        const expected = formatPace(
            roundPaceDownToTenths(
                targetSeconds,
                distance.scaledKilometres,
                unitInScaledKilometres
            )
        );
        if (value !== expected) {
            addError(
                file,
                row.__rowNumber,
                `${column} "${value}" does not match RequiredTimeToBeat "${row.RequiredTimeToBeat}" at ${row.Distance}; expected "${expected}".`
            );
        }
    }
}

function validateAbsoluteRecords(siteDir) {
    const file = `${siteDir}/absolute_records.csv`;

    if (!fs.existsSync(path.join(validationRoot, file))) {
        return;
    }

    const rows = readCsvRequired(file, [
        'SortOrder',
        'RecordGroup',
        'RecordTitle',
        'Sex',
        'Distance',
        'ResultDistance',
        'Participant',
        'Athlete ID',
        'Time',
        'Date',
        'Event',
        'TimeClass',
        'AgeClass',
        'AgeGrade',
        'SourceRow',
        'ExportBundleID'
    ]);

    const objects = toObjects(rows, file);
    const seenPairs = new Map();
    const seenSortOrders = new Map();
    const seenTitles = new Map();
    let previousSortOrder = null;

    // The workbook exports one record per sex and supported distance, so the
    // whole matrix is known in advance. Checking each row against its expected
    // position makes a dropped, duplicated, extra, or reordered record a
    // validation failure instead of a silently shorter Records page.
    const expectedMatrix = absoluteRecordSexes.flatMap(sex =>
        absoluteRecordDistances.map(distance => ({ sex, distance }))
    );

    objects.forEach((row, index) => {
        const expected = expectedMatrix[index];
        const sex = String(row.Sex || '').trim();
        const recordGroup = String(row.RecordGroup || '').trim();
        const distance = String(row.Distance || '').trim();
        const title = String(row.RecordTitle || '').trim();

        validateNumber(row.SortOrder, file, row.__rowNumber, 'SortOrder', { required: true });
        validateAllowed(row.RecordGroup, absoluteRecordSexes, file, row.__rowNumber, 'RecordGroup');
        requireValue(row.RecordTitle, file, row.__rowNumber, 'RecordTitle');
        validateAllowed(row.Sex, absoluteRecordSexes, file, row.__rowNumber, 'Sex');
        validateAllowed(row.Distance, absoluteRecordDistances, file, row.__rowNumber, 'Distance');
        requireValue(row.ResultDistance, file, row.__rowNumber, 'ResultDistance');
        requireValue(row.Participant, file, row.__rowNumber, 'Participant');

        // RecordGroup is what the Records page uses as a heading, so a row whose
        // group disagrees with its own Sex would file a men's record under
        // Women.
        if (sex && recordGroup && recordGroup !== sex) {
            addError(
                file,
                row.__rowNumber,
                `RecordGroup "${recordGroup}" must match Sex "${sex}".`
            );
        }

        if (sex && distance) {
            const pairKey = `${sex}|${distance}`;
            const firstSeen = seenPairs.get(pairKey);

            if (firstSeen) {
                addError(
                    file,
                    row.__rowNumber,
                    `Duplicate absolute record for ${sex} ${distance}; already exported on row ${firstSeen}.`
                );
            } else {
                seenPairs.set(pairKey, row.__rowNumber);
            }
        }

        if (title) {
            const firstSeen = seenTitles.get(title);

            if (firstSeen) {
                addError(
                    file,
                    row.__rowNumber,
                    `Duplicate RecordTitle "${title}"; already exported on row ${firstSeen}.`
                );
            } else {
                seenTitles.set(title, row.__rowNumber);
            }
        }

        if (!expected) {
            addError(
                file,
                row.__rowNumber,
                `Unexpected extra record row; only ${expectedMatrix.length} rows are contracted.`
            );
        } else if (sex !== expected.sex || distance !== expected.distance) {
            addError(
                file,
                row.__rowNumber,
                `Expected the ${expected.sex} ${expected.distance} record here, found "${sex} ${distance}".`
            );
        }

        // Both the browser and a human reviewer read this export in order, so
        // the exported order must be reproducible rather than incidental.
        const sortOrder = Number(String(row.SortOrder || '').trim());
        if (Number.isFinite(sortOrder)) {
            const firstSeen = seenSortOrders.get(sortOrder);

            if (firstSeen) {
                addError(
                    file,
                    row.__rowNumber,
                    `Duplicate SortOrder ${sortOrder}; already exported on row ${firstSeen}.`
                );
            } else {
                seenSortOrders.set(sortOrder, row.__rowNumber);
            }

            if (previousSortOrder !== null && sortOrder <= previousSortOrder) {
                addError(
                    file,
                    row.__rowNumber,
                    `SortOrder ${sortOrder} must be greater than the previous row's ${previousSortOrder}.`
                );
            }

            previousSortOrder = sortOrder;
        }

        if (
            distance &&
            row.ResultDistance &&
            canonicalDistanceKey(row.ResultDistance) !== canonicalDistanceKey(distance)
        ) {
            addError(
                file,
                row.__rowNumber,
                `ResultDistance "${row.ResultDistance}" is not the same distance as Distance "${distance}".`
            );
        }

        // "No eligible result" and "Championship Vacant" are valid exported
        // states, so a vacant record still has to occupy its place in the matrix
        // but carries no performance to check.
        const emptyRecord = isVacantParticipant(row.Participant) || isNoEligibleParticipant(row.Participant);
        if (emptyRecord) {
            return;
        }

        validateAthleteId(row['Athlete ID'], file, row.__rowNumber, 'Athlete ID', { required: true });
        validateTime(row.Time, file, row.__rowNumber, 'Time', { required: true });
        validateDate(row.Date, file, row.__rowNumber, 'Date', { required: true });
        validateAllowed(row.TimeClass, ['Official'], file, row.__rowNumber, 'TimeClass');
        validatePercent(row.AgeGrade, file, row.__rowNumber, 'AgeGrade');
        validateNumber(row.SourceRow, file, row.__rowNumber, 'SourceRow', { required: true });
    });

    for (const { sex, distance } of expectedMatrix) {
        if (!seenPairs.has(`${sex}|${distance}`)) {
            addError(file, 1, `Missing the ${sex} ${distance} absolute record row.`);
        }
    }
}

function validateAgeGradePaces(row, file) {
    const distance = ageGradeStandardDistance(row.Distance);
    const targetSeconds = parseTimeToSeconds(row.RequiredTime);
    const paces = [
        ['pace_per_km', 1_000_000],
        ['pace_per_mile', 1_609_344]
    ];

    if (!distance) {
        addError(file, row.__rowNumber, `Distance "${row.Distance}" has no pace-validation distance.`);
    }

    for (const [column, unitInScaledKilometres] of paces) {
        const value = String(row[column] || '').trim();

        if (!/^\d+:[0-5]\d\.\d$/.test(value)) {
            addError(file, row.__rowNumber, `${column} "${value}" must use m:ss.s.`);
            continue;
        }

        if (targetSeconds === null || !distance) {
            continue;
        }

        const expected = formatPace(
            roundPaceDownToTenths(
                targetSeconds,
                distance.scaledKilometres,
                unitInScaledKilometres
            )
        );
        if (value !== expected) {
            addError(
                file,
                row.__rowNumber,
                `${column} "${value}" does not match RequiredTime "${row.RequiredTime}" at ${row.Distance}; expected "${expected}".`
            );
        }
    }
}

function ageGradeStandardDistance(value) {
    const distances = {
        '5 km': 5_000_000,
        '10 km': 10_000_000,
        '10 Mile': 16_093_440,
        'Half Marathon': 21_097_500,
        'Marathon': 42_195_000
    };
    const scaledKilometres = distances[String(value || '').trim()];

    if (!scaledKilometres) {
        return null;
    }

    return { scaledKilometres };
}

function parseTimeToSeconds(value) {
    const parts = String(value || '').trim().split(':').map(Number);

    if (
        ![2, 3].includes(parts.length) ||
        parts.some(part => !Number.isInteger(part) || part < 0) ||
        parts.at(-1) > 59 ||
        (parts.length === 3 && parts[1] > 59)
    ) {
        return null;
    }

    return parts.length === 3
        ? (parts[0] * 3600) + (parts[1] * 60) + parts[2]
        : (parts[0] * 60) + parts[1];
}

function roundPaceDownToTenths(targetSeconds, scaledDistance, scaledUnit) {
    return Math.floor((targetSeconds * 10 * scaledUnit) / scaledDistance);
}

function formatPace(totalTenths) {
    const minutes = Math.floor(totalTenths / 600);
    const remainingTenths = totalTenths % 600;
    const seconds = String(Math.floor(remainingTenths / 10)).padStart(2, '0');
    const tenths = remainingTenths % 10;
    return `${minutes}:${seconds}.${tenths}`;
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

    validateRankSequence(file, objects);
}

// Standings positions have to be a complete sequence. Removing a participant
// from a leaderboard after the ranking was computed leaves a hole -- 1, 2, 4, 5
// -- and nothing else here would notice: Rank is otherwise only checked as a
// number, read once to find the Rank 1 champion for the Hall of Fame
// cross-check, and read for places 1 to 3 to derive medals. A gap below third
// place therefore publishes silently, and a missing place inside the top three
// removes a medal from the championship rather than reassigning it, because the
// expected medals are derived from these same rows and agree with the omission.
//
// Standard competition ranking is accepted, so a genuine tie reads as
// 1, 2, 2, 4 rather than being reported as a gap. The workbook owns whether it
// emits ties at all; this only requires that whatever it emits is a sequence.
function validateRankSequence(file, objects) {
    const ranked = objects.filter(
        row => !isNoEligibleRow(row) && !isVacantParticipant(row.Participant)
    );

    if (ranked.length === 0) {
        return;
    }

    const ranks = ranked.map(row => Number(String(row.Rank ?? '').trim()));

    // A malformed Rank is already reported per row by validateNumber. Checking
    // the sequence around one would only add noise about positions that cannot
    // be established in the first place.
    if (ranks.some(rank => !Number.isInteger(rank) || rank < 1)) {
        return;
    }

    for (let index = 0; index < ranked.length; index += 1) {
        const rank = ranks[index];
        const position = index + 1;

        // A row either repeats the rank above it as a tie, or takes the
        // position its offset implies.
        if (index > 0 && rank === ranks[index - 1]) {
            continue;
        }

        if (rank !== position) {
            const tieNote = index > 0
                ? `, or repeat Rank ${ranks[index - 1]} to record a tie`
                : '';

            addError(
                file,
                ranked[index].__rowNumber,
                `Rank ${rank} is out of sequence: standings row ${position} must be Rank ${position}${tieNote}. A gap usually means rows were removed after ranking instead of the standings being recalculated without them.`
            );
        }
    }
}

function validateEveryCsvInFolder(siteDir) {
    const absoluteDir = path.join(validationRoot, siteDir);
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

    const absolutePath = path.join(validationRoot, relativePath);

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

function validateStrictUkDate(value, file, rowNumber, column, options = {}) {
    const text = String(value || '').trim();

    if (!text) {
        if (options.required) {
            addError(file, rowNumber, `${column} is required.`);
        }
        return;
    }

    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(text) || !parseUkDate(text)) {
        addError(file, rowNumber, `${column} "${text}" must use DD/MM/YYYY.`);
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

function isNoEligibleParticipant(value) {
    return String(value || '').toLowerCase().includes('no eligible');
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
