import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    buildGalleryAdminCatalog,
    exportedDateToIso,
    renderGalleryAdminCatalog,
    writeGalleryAdminCatalog
} from '../scripts/build-gallery-admin-catalog.mjs';
import { parseCsv, repoRoot } from '../scripts/export-bundle-tools.mjs';

await import('../gallery-contract.js');
const uploadContractModule = await import('../gallery-upload-contract.js');
const { buildAthleteTagChoices } = uploadContractModule.default || uploadContractModule;
const generatedModule = await import('../gallery-admin/generated/catalog-snapshot.js');
const generatedSnapshot = generatedModule.default;
const digestRevisionPattern = /^sha256:[a-f0-9]{64}$/;
const gitAttributes = await fs.readFile(path.join(repoRoot, '.gitattributes'), 'utf8');

assert.match(
    gitAttributes,
    /^gallery-admin\/generated\/catalog-snapshot\.js text eol=lf$/m
);

const builtSnapshot = await buildGalleryAdminCatalog();
assert.deepEqual(builtSnapshot, generatedSnapshot);
assert.equal(
    await fs.readFile(path.join(repoRoot, 'gallery-admin', 'generated', 'catalog-snapshot.js'), 'utf8'),
    renderGalleryAdminCatalog(builtSnapshot)
);
await writeGalleryAdminCatalog({ check: true });

assert.deepEqual(Object.keys(builtSnapshot), [
    'schemaVersion',
    'exportBundleId',
    'sourceRevision',
    'suppressionRevision',
    'suppressionDocument',
    'sites'
]);
assert.equal(builtSnapshot.schemaVersion, '1.0');
assert.match(builtSnapshot.sourceRevision, digestRevisionPattern);
assert.match(builtSnapshot.suppressionRevision, digestRevisionPattern);
assert.deepEqual(builtSnapshot.suppressionDocument, {
    schemaVersion: '1.0',
    hiddenAthleteIds: []
});
assert.equal(Object.isFrozen(generatedSnapshot), true);
assert.equal(Object.isFrozen(generatedSnapshot.sites.family.resultEntries), true);
assert.equal(Object.isFrozen(generatedSnapshot.sites.everyone.catalog.races), true);
assert.doesNotMatch(
    JSON.stringify(builtSnapshot),
    /athlete_results\.csv|age_grade_standards\.csv|export_manifest\.csv|hidden-athlete-ids\.json/
);

const publicAthleteRows = csvObjects(
    await fs.readFile(path.join(repoRoot, 'data', 'athlete_results.csv'), 'utf8')
);
const publicNameById = new Map(publicAthleteRows.map(row => [row.AthleteID, row.Participant]));

for (const mode of ['family', 'everyone']) {
    const site = builtSnapshot.sites[mode];
    assert.deepEqual(Object.keys(site), ['catalog', 'rosterEntries', 'resultEntries']);
    assert.deepEqual(Object.keys(site.catalog), [
        'exportBundleId',
        'sourceRevision',
        'races',
        'athleteIds'
    ]);
    assert.equal(site.catalog.exportBundleId, builtSnapshot.exportBundleId);
    assert.equal(site.catalog.sourceRevision, builtSnapshot.sourceRevision);
    assert.equal(new Set(site.catalog.races.map(JSON.stringify)).size, site.catalog.races.length);
    assert.equal(new Set(site.catalog.athleteIds).size, site.catalog.athleteIds.length);
    assert.equal(new Set(site.resultEntries.map(JSON.stringify)).size, site.resultEntries.length);
    assert.deepEqual(
        site.catalog.athleteIds,
        site.rosterEntries.map(entry => entry.athleteId)
    );

    const standardRows = csvObjects(
        await fs.readFile(
            path.join(repoRoot, 'data', mode, 'age_grade_standards.csv'),
            'utf8'
        )
    );
    const standardsIds = new Set(standardRows.map(row => row.AthleteId));
    const expectedResultBearingIds = new Set(
        publicAthleteRows
            .map(row => row.AthleteID)
            .filter(athleteId => standardsIds.has(athleteId))
    );
    assert.deepEqual(new Set(site.catalog.athleteIds), expectedResultBearingIds);

    const expectedResultEntryKeys = new Set(publicAthleteRows
        .filter(row => standardsIds.has(row.AthleteID))
        .map(row => JSON.stringify({
            athleteId: row.AthleteID,
            raceDate: exportedDateToIso(row.Date),
            raceEvent: row.Event,
            raceDistance: row.Distance
        })));
    assert.deepEqual(new Set(site.resultEntries.map(JSON.stringify)), expectedResultEntryKeys);

    const expectedRaceKeys = new Set(publicAthleteRows
        .filter(row => standardsIds.has(row.AthleteID))
        .map(row => JSON.stringify({
            raceDate: exportedDateToIso(row.Date),
            raceEvent: row.Event,
            raceDistance: row.Distance
        })));
    assert.deepEqual(new Set(site.catalog.races.map(JSON.stringify)), expectedRaceKeys);

    for (const entry of site.rosterEntries) {
        assert.equal(entry.participant, publicNameById.get(entry.athleteId));
    }

    const newestRace = site.catalog.races[0];
    const choices = buildAthleteTagChoices(
        newestRace,
        site.rosterEntries,
        site.resultEntries
    );
    assert.equal(choices.ok, true, choices.problems.join('\n'));
    const expectedRunners = new Set(site.resultEntries
        .filter(entry => sameRace(entry, newestRace))
        .map(entry => entry.athleteId));
    assert.deepEqual(
        new Set(choices.choices
            .filter(choice => choice.ranSelectedRace)
            .map(choice => choice.athleteId)),
        expectedRunners
    );
    const firstNonRunner = choices.choices.findIndex(choice => !choice.ranSelectedRace);
    assert.equal(
        firstNonRunner < 0 ? choices.choices.length : firstNonRunner,
        expectedRunners.size
    );
}

assert.equal(exportedDateToIso('29/02/2024'), '2024-02-29');
assert.throws(() => exportedDateToIso('29/02/2023'), /real calendar date/);
assert.throws(() => exportedDateToIso('2024-02-29'), /DD\/MM\/YYYY/);
assert.deepEqual(await buildGalleryAdminCatalog(), builtSnapshot);

const fixtureRoots = [];
try {
    const duplicateSuppressionRoot = await createFixture({
        hiddenAthleteIds: ['runner-one', 'runner-one']
    });
    fixtureRoots.push(duplicateSuppressionRoot);
    await assert.rejects(
        buildGalleryAdminCatalog(duplicateSuppressionRoot),
        /hidden athlete ID.*duplicated/
    );

    const inconsistentNameRoot = await createFixture({
        athleteRows: [
            resultRow('runner-one', 'Runner One', '01/01/2026'),
            resultRow('runner-one', 'Renamed Runner', '02/01/2026')
        ]
    });
    fixtureRoots.push(inconsistentNameRoot);
    await assert.rejects(
        buildGalleryAdminCatalog(inconsistentNameRoot),
        /inconsistent public name/
    );

    const duplicateResult = resultRow('runner-one', 'Runner One', '01/01/2026');
    const duplicateResultRoot = await createFixture({
        athleteRows: [duplicateResult, [...duplicateResult]]
    });
    fixtureRoots.push(duplicateResultRoot);
    await assert.rejects(
        buildGalleryAdminCatalog(duplicateResultRoot),
        /duplicates an existing public result/
    );

    const malformedDateRoot = await createFixture({
        athleteRows: [resultRow('runner-one', 'Runner One', '31/02/2026')]
    });
    fixtureRoots.push(malformedDateRoot);
    await assert.rejects(
        buildGalleryAdminCatalog(malformedDateRoot),
        /real calendar date/
    );

    const mixedBundleRoot = await createFixture({ standardsBundleId: 'bundle-other' });
    fixtureRoots.push(mixedBundleRoot);
    await assert.rejects(
        buildGalleryAdminCatalog(mixedBundleRoot),
        /exact ExportBundleID/
    );

    const unsupportedShapeRoot = await createFixture({ extraAthleteHeader: true });
    fixtureRoots.push(unsupportedShapeRoot);
    await assert.rejects(
        buildGalleryAdminCatalog(unsupportedShapeRoot),
        /unsupported CSV shape/
    );

    const lineEndingRoot = await createFixture();
    fixtureRoots.push(lineEndingRoot);
    await writeGalleryAdminCatalog({ root: lineEndingRoot });
    const lfSnapshot = await buildGalleryAdminCatalog(lineEndingRoot);
    const revisionSourcePaths = [
        'data/export_manifest.csv',
        'data/athlete_results.csv',
        'data/family/age_grade_standards.csv',
        'data/everyone/age_grade_standards.csv',
        'gallery-data/hidden-athlete-ids.json'
    ];
    await Promise.all(revisionSourcePaths.map(async relativePath => {
        const sourcePath = path.join(lineEndingRoot, ...relativePath.split('/'));
        const lfText = await fs.readFile(sourcePath, 'utf8');
        assert.doesNotMatch(lfText, /\r\n/);
        await fs.writeFile(sourcePath, lfText.replace(/\n/g, '\r\n'), 'utf8');
    }));
    assert.deepEqual(await buildGalleryAdminCatalog(lineEndingRoot), lfSnapshot);
    await writeGalleryAdminCatalog({ root: lineEndingRoot, check: true });

    const staleRoot = await createFixture();
    fixtureRoots.push(staleRoot);
    await writeGalleryAdminCatalog({ root: staleRoot });
    await fs.writeFile(
        path.join(staleRoot, 'gallery-data', 'hidden-athlete-ids.json'),
        `${JSON.stringify({ schemaVersion: '1.0', hiddenAthleteIds: ['runner-one'] }, null, 2)}\n`,
        'utf8'
    );
    await assert.rejects(
        writeGalleryAdminCatalog({ root: staleRoot, check: true }),
        /snapshot is stale/
    );
} finally {
    await Promise.all(fixtureRoots.map(root => fs.rm(root, { recursive: true, force: true })));
}

console.log('Gallery admin catalog generation checks passed.');

function csvObjects(text) {
    const rows = parseCsv(text);
    const headers = rows[0] || [];
    return rows.slice(1).map(row => Object.fromEntries(
        headers.map((header, index) => [header, String(row[index] ?? '').trim()])
    ));
}

function sameRace(left, right) {
    return left.raceDate === right.raceDate &&
        left.raceEvent === right.raceEvent &&
        left.raceDistance === right.raceDistance;
}

async function createFixture(options = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gallery-admin-catalog-'));
    const bundleId = 'bundle-fixture';
    const standardsBundleId = options.standardsBundleId || bundleId;
    const athleteRows = options.athleteRows || [
        resultRow('runner-one', 'Runner One', '01/01/2026'),
        resultRow('runner-two', 'Runner Two', '01/01/2026')
    ];
    const familyStandards = [standardRow('runner-one', standardsBundleId)];
    const everyoneStandards = [
        standardRow('runner-one', standardsBundleId),
        standardRow('runner-two', standardsBundleId)
    ];
    const athleteHeaders = [
        'AthleteID',
        'Participant',
        'Date',
        'Distance',
        'Time',
        'AgeGrade',
        'Event',
        'TimeClass',
        'ExportBundleID',
        ...(options.extraAthleteHeader ? ['Unsupported'] : [])
    ];
    const completedAthleteRows = athleteRows.map(row => [
        ...row.slice(0, 8),
        bundleId,
        ...(options.extraAthleteHeader ? ['private-shape'] : [])
    ]);
    const standardsHeaders = [
        'AthleteId',
        'Distance',
        'Standard',
        'AgeGrade',
        'RequiredTime',
        'pace_per_km',
        'pace_per_mile',
        'SortOrder',
        'ExportBundleID'
    ];
    const manifestHeaders = [
        'ExportBundleID',
        'ExportedAtUTC',
        'SchemaVersion',
        'Scope',
        'RelativePath',
        'DataRowCount'
    ];
    const manifestRows = [
        [bundleId, '2026-01-01T00:00:00.000Z', '1.0', 'shared', 'data/athlete_results.csv', String(completedAthleteRows.length)],
        [bundleId, '2026-01-01T00:00:00.000Z', '1.0', 'family', 'data/family/age_grade_standards.csv', String(familyStandards.length)],
        [bundleId, '2026-01-01T00:00:00.000Z', '1.0', 'everyone', 'data/everyone/age_grade_standards.csv', String(everyoneStandards.length)]
    ];

    await fs.mkdir(path.join(root, 'data', 'family'), { recursive: true });
    await fs.mkdir(path.join(root, 'data', 'everyone'), { recursive: true });
    await fs.mkdir(path.join(root, 'gallery-data'), { recursive: true });
    await Promise.all([
        fs.writeFile(
            path.join(root, 'data', 'export_manifest.csv'),
            renderCsv(manifestHeaders, manifestRows),
            'utf8'
        ),
        fs.writeFile(
            path.join(root, 'data', 'athlete_results.csv'),
            renderCsv(athleteHeaders, completedAthleteRows),
            'utf8'
        ),
        fs.writeFile(
            path.join(root, 'data', 'family', 'age_grade_standards.csv'),
            renderCsv(standardsHeaders, familyStandards),
            'utf8'
        ),
        fs.writeFile(
            path.join(root, 'data', 'everyone', 'age_grade_standards.csv'),
            renderCsv(standardsHeaders, everyoneStandards),
            'utf8'
        ),
        fs.writeFile(
            path.join(root, 'gallery-data', 'hidden-athlete-ids.json'),
            `${JSON.stringify({
                schemaVersion: '1.0',
                hiddenAthleteIds: options.hiddenAthleteIds || []
            }, null, 2)}\n`,
            'utf8'
        )
    ]);

    return root;
}

function resultRow(athleteId, participant, date) {
    return [
        athleteId,
        participant,
        date,
        '5 km',
        '00:25:00',
        '50.0%',
        'Fixture Race',
        'Official'
    ];
}

function standardRow(athleteId, bundleId) {
    return [
        athleteId,
        '5 km',
        'Club',
        '50%',
        '00:25:00',
        '5:00',
        '8:02',
        '1',
        bundleId
    ];
}

function renderCsv(headers, rows) {
    return `${[headers, ...rows].map(row => row.map(csvValue).join(',')).join('\n')}\n`;
}

function csvValue(value) {
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
