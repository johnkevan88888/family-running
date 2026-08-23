import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseCsv, repoRoot } from './export-bundle-tools.mjs';

const contractModule = await import('../gallery-contract.js');
const galleryContract = contractModule.default || contractModule;
const siteModes = ['family', 'everyone'];

export async function validateGalleryTree(root = repoRoot) {
    const problems = [];
    const documents = new Map();
    const athleteResults = await readAthleteResults(root, problems);
    await validateSuppressionList(root, problems);

    for (const mode of siteModes) {
        const relativePath = `gallery-data/${mode}.json`;
        const fullPath = path.join(root, ...relativePath.split('/'));
        const siteAthleteIds = await readSiteAthleteIds(root, mode, athleteResults, problems);
        let documentValue;

        try {
            documentValue = JSON.parse(await fs.readFile(fullPath, 'utf8'));
        } catch (error) {
            problems.push(`${relativePath}: could not read valid JSON (${error.message}).`);
            continue;
        }

        documents.set(mode, documentValue);

        for (const problem of galleryContract.validateGalleryDocument(documentValue)) {
            problems.push(`${relativePath}: ${problem}`);
        }

        if (!Array.isArray(documentValue.items)) {
            continue;
        }

        documentValue.items.forEach((item, itemIndex) => {
            if (!Array.isArray(item?.athleteIds)) {
                return;
            }

            item.athleteIds.forEach(athleteId => {
                if (typeof athleteId === 'string' && !siteAthleteIds.has(athleteId)) {
                    problems.push(
                        `${relativePath}: items[${itemIndex}].athleteIds references athlete "${athleteId}", who is not available in this site mode.`
                    );
                }
            });

            if (!matchesExportedRace(item, athleteResults, siteAthleteIds)) {
                problems.push(
                    `${relativePath}: items[${itemIndex}] does not match an exported race by raceDate, raceEvent, and raceDistance.`
                );
            }
        });
    }

    validateSharedItems(documents, problems);
    return problems.sort();
}

async function validateSuppressionList(root, problems) {
    const relativePath = 'gallery-data/hidden-athlete-ids.json';

    try {
        const documentValue = JSON.parse(
            await fs.readFile(path.join(root, 'gallery-data', 'hidden-athlete-ids.json'), 'utf8')
        );

        for (const problem of galleryContract.validateGallerySuppressionDocument(documentValue)) {
            problems.push(`${relativePath}: ${problem}`);
        }
    } catch (error) {
        problems.push(`${relativePath}: could not read valid JSON (${error.message}).`);
    }
}

async function readAthleteResults(root, problems) {
    const relativePath = 'data/athlete_results.csv';

    try {
        const rows = parseCsv(await fs.readFile(path.join(root, 'data', 'athlete_results.csv'), 'utf8'));
        const headers = rows[0] || [];

        for (const requiredHeader of ['AthleteID', 'Participant', 'Date', 'Event', 'Distance']) {
            if (!headers.includes(requiredHeader)) {
                problems.push(`${relativePath}: no ${requiredHeader} column is available for gallery selection.`);
                return [];
            }
        }

        return rows.slice(1).map(row => Object.fromEntries(
            headers.map((header, index) => [header, String(row[index] || '').trim()])
        ));
    } catch (error) {
        problems.push(`${relativePath}: could not read public races and athletes for gallery selection (${error.message}).`);
        return [];
    }
}

async function readSiteAthleteIds(root, mode, athleteResults, problems) {
    const relativePath = `data/${mode}/age_grade_standards.csv`;

    try {
        const rows = parseCsv(await fs.readFile(path.join(root, 'data', mode, 'age_grade_standards.csv'), 'utf8'));
        const headers = rows[0] || [];
        const athleteIdIndex = headers.indexOf('AthleteId');

        if (athleteIdIndex < 0) {
            problems.push(`${relativePath}: no AthleteId column is available for gallery site-mode selection.`);
            return new Set();
        }

        const rosterIds = new Set(
            rows.slice(1)
                .map(row => String(row[athleteIdIndex] || '').trim())
                .filter(Boolean)
        );

        return new Set(
            athleteResults
                .map(row => row.AthleteID)
                .filter(athleteId => rosterIds.has(athleteId))
        );
    } catch (error) {
        problems.push(`${relativePath}: could not read the site athlete roster (${error.message}).`);
        return new Set();
    }
}

function matchesExportedRace(item, athleteResults, siteAthleteIds) {
    if (
        typeof item?.raceDate !== 'string' ||
        typeof item?.raceEvent !== 'string' ||
        typeof item?.raceDistance !== 'string'
    ) {
        return false;
    }

    const dateMatch = item.raceDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!dateMatch) {
        return false;
    }

    const exportedDate = `${dateMatch[3]}/${dateMatch[2]}/${dateMatch[1]}`;
    return athleteResults.some(row =>
        siteAthleteIds.has(row.AthleteID) &&
        row.Date === exportedDate &&
        row.Event === item.raceEvent &&
        row.Distance === item.raceDistance
    );
}

function validateSharedItems(documents, problems) {
    const familyItems = new Map(
        (documents.get('family')?.items || []).map(item => [item?.id, item])
    );
    const everyoneItems = new Map(
        (documents.get('everyone')?.items || []).map(item => [item?.id, item])
    );

    for (const [id, familyItem] of familyItems) {
        if (!id || !everyoneItems.has(id)) {
            continue;
        }

        if (JSON.stringify(familyItem) !== JSON.stringify(everyoneItems.get(id))) {
            problems.push(
                `gallery-data: item "${id}" appears in both site modes with different content; use identical content or different IDs.`
            );
        }
    }
}

const invokedPath = process.argv[1]
    ? fileURLToPath(pathToFileURL(path.resolve(process.argv[1])))
    : '';

if (invokedPath && path.resolve(invokedPath) === path.resolve(fileURLToPath(import.meta.url))) {
    const problems = await validateGalleryTree();

    if (problems.length) {
        console.error('Gallery validation failed:');
        for (const problem of problems) {
            console.error(`- ${problem}`);
        }
        process.exit(1);
    }

    console.log('Gallery validation passed for Family and Everyone.');
}
