import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { validateGalleryTree } from '../scripts/validate-gallery.mjs';

const contractModule = await import('../gallery-contract.js');
const {
    filterSuppressedGalleryItems,
    validateGalleryDocument,
    validateGallerySuppressionDocument
} = contractModule.default || contractModule;

const validPhoto = {
    id: 'finish-line-smile',
    type: 'photo',
    title: 'A finish-line smile',
    caption: 'The best part of the last hundred metres.',
    alt: 'A runner smiling after crossing the finish line',
    raceDate: '2026-08-23',
    raceEvent: 'Summer 5 km',
    raceDistance: '5 km',
    sourceUrl: 'https://media.example.com/full/finish-line-smile.jpg',
    thumbnailUrl: 'https://media.example.com/thumb/finish-line-smile.webp',
    featured: true,
    athleteIds: ['carolyn-kevan']
};

const validVideo = {
    ...validPhoto,
    id: 'finishing-kick-video',
    type: 'video',
    title: 'The finishing kick',
    sourceUrl: 'https://media.example.com/video/finishing-kick.mp4',
    thumbnailUrl: 'https://media.example.com/poster/finishing-kick.webp',
    athleteIds: []
};

assert.deepEqual(
    validateGalleryDocument({ schemaVersion: '1.0', items: [validPhoto, validVideo] }),
    []
);

assert.match(
    validateGalleryDocument({ schemaVersion: '2.0', items: [] }).join('\n'),
    /schemaVersion must be exactly/
);
assert.match(
    validateGalleryDocument({ schemaVersion: '1.0', items: [{ ...validPhoto, id: 'Bad ID' }] }).join('\n'),
    /lowercase URL-safe identifier/
);
assert.match(
    validateGalleryDocument({ schemaVersion: '1.0', items: [{ ...validPhoto, sourceUrl: 'javascript:alert(1)' }] }).join('\n'),
    /absolute HTTPS URL/
);
assert.match(
    validateGalleryDocument({ schemaVersion: '1.0', items: [{ ...validPhoto, sourceUrl: 'http://media.example.com/photo.jpg' }] }).join('\n'),
    /absolute HTTPS URL/
);
assert.match(
    validateGalleryDocument({ schemaVersion: '1.0', items: [{ ...validPhoto, raceDate: '2026-02-30' }] }).join('\n'),
    /real date/
);
assert.match(
    validateGalleryDocument({ schemaVersion: '1.0', items: [{ ...validPhoto, athleteIds: ['carolyn-kevan', 'carolyn-kevan'] }] }).join('\n'),
    /duplicates "carolyn-kevan"/
);
assert.match(
    validateGalleryDocument({ schemaVersion: '1.0', items: [validPhoto, { ...validVideo, id: validPhoto.id }] }).join('\n'),
    /duplicates "finish-line-smile"/
);
assert.match(
    validateGalleryDocument({ schemaVersion: '1.0', items: [{ ...validPhoto, unexpected: true }] }).join('\n'),
    /unsupported field "unexpected"/
);

const validSuppressionDocument = {
    schemaVersion: '1.0',
    hiddenAthleteIds: ['carolyn-kevan']
};

assert.deepEqual(validateGallerySuppressionDocument(validSuppressionDocument), []);
assert.match(
    validateGallerySuppressionDocument({ schemaVersion: '1.0', hiddenAthleteIds: 'carolyn-kevan' }).join('\n'),
    /hiddenAthleteIds must be an array/
);
assert.match(
    validateGallerySuppressionDocument({ schemaVersion: '1.0', hiddenAthleteIds: ['Bad ID'] }).join('\n'),
    /not a valid athlete ID/
);
assert.match(
    validateGallerySuppressionDocument({
        schemaVersion: '1.0',
        hiddenAthleteIds: ['carolyn-kevan', 'carolyn-kevan']
    }).join('\n'),
    /duplicates "carolyn-kevan"/
);
assert.match(
    validateGallerySuppressionDocument({
        schemaVersion: '1.0',
        hiddenAthleteIds: [],
        reason: 'private'
    }).join('\n'),
    /unsupported field "reason"/
);
assert.deepEqual(
    filterSuppressedGalleryItems([validPhoto, validVideo], validSuppressionDocument),
    [validVideo]
);

const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'family-running-gallery-contract-'));

try {
    await fs.mkdir(path.join(fixtureRoot, 'data', 'family'), { recursive: true });
    await fs.mkdir(path.join(fixtureRoot, 'data', 'everyone'), { recursive: true });
    await fs.mkdir(path.join(fixtureRoot, 'gallery-data'), { recursive: true });

    await fs.writeFile(
        path.join(fixtureRoot, 'data', 'athlete_results.csv'),
        [
            'AthleteID,Participant,Date,Distance,Time,AgeGrade,Event,TimeClass,ExportBundleID',
            'carolyn-kevan,Carolyn Kevan,23/08/2026,5 km,00:28:00,70%,Summer 5 km,Official,B1',
            'grace-chambers,Grace Chambers,23/08/2026,5 km,00:27:00,71%,Summer 5 km,Official,B1'
        ].join('\r\n'),
        'utf8'
    );
    await fs.writeFile(
        path.join(fixtureRoot, 'data', 'family', 'age_grade_standards.csv'),
        'AthleteId,Distance\r\ncarolyn-kevan,5 km\r\n',
        'utf8'
    );
    await fs.writeFile(
        path.join(fixtureRoot, 'data', 'everyone', 'age_grade_standards.csv'),
        'AthleteId,Distance\r\ncarolyn-kevan,5 km\r\ngrace-chambers,5 km\r\n',
        'utf8'
    );
    await fs.writeFile(
        path.join(fixtureRoot, 'gallery-data', 'hidden-athlete-ids.json'),
        JSON.stringify({ schemaVersion: '1.0', hiddenAthleteIds: [] }),
        'utf8'
    );

    const familyItem = {
        ...validPhoto,
        raceEvent: 'Summer 5 km',
        raceDistance: '5 km',
        athleteIds: ['carolyn-kevan']
    };
    const everyoneItem = {
        ...validPhoto,
        id: 'everyone-finish-line-smile',
        raceEvent: 'Summer 5 km',
        raceDistance: '5 km',
        athleteIds: ['grace-chambers']
    };

    await writeFixtureManifests(familyItem, everyoneItem);
    assert.deepEqual(await validateGalleryTree(fixtureRoot), []);

    await writeFixtureManifests({ ...familyItem, raceDistance: '10 km' }, everyoneItem);
    assert.match(
        (await validateGalleryTree(fixtureRoot)).join('\n'),
        /does not match an exported race/
    );

    await writeFixtureManifests({ ...familyItem, athleteIds: ['grace-chambers'] }, everyoneItem);
    assert.match(
        (await validateGalleryTree(fixtureRoot)).join('\n'),
        /not available in this site mode/
    );

    await fs.writeFile(
        path.join(fixtureRoot, 'gallery-data', 'hidden-athlete-ids.json'),
        JSON.stringify({ schemaVersion: '1.0', hiddenAthleteIds: ['Bad ID'] }),
        'utf8'
    );
    assert.match(
        (await validateGalleryTree(fixtureRoot)).join('\n'),
        /hiddenAthleteIds\[0\] is not a valid athlete ID/
    );

    async function writeFixtureManifests(family, everyone) {
        await fs.writeFile(
            path.join(fixtureRoot, 'gallery-data', 'family.json'),
            JSON.stringify({ schemaVersion: '1.0', items: [family] }),
            'utf8'
        );
        await fs.writeFile(
            path.join(fixtureRoot, 'gallery-data', 'everyone.json'),
            JSON.stringify({ schemaVersion: '1.0', items: [everyone] }),
            'utf8'
        );
    }
} finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
}

console.log('Gallery contract tests passed.');
