import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    galleryManifestPublicItemFields,
    prepareGalleryManifestCandidate
} from '../scripts/gallery-media/candidate-manifest.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidateCliPath = path.join(repoRoot, 'scripts', 'prepare-gallery-manifest-candidate.mjs');
const derivativeOrigin = 'https://media-example.workers.dev';
const sourceUrl = `${derivativeOrigin}/media/v1/${'a'.repeat(64)}/display.webp`;
const thumbnailUrl = `${derivativeOrigin}/media/v1/${'b'.repeat(64)}/thumbnail.webp`;

const itemInput = {
    id: 'finish-line-smile',
    type: 'photo',
    title: 'A finish-line smile',
    caption: 'The best part of the last hundred metres.',
    alt: 'A runner smiling after crossing the finish line',
    raceDate: '2026-08-23',
    raceEvent: 'Summer 5 km',
    raceDistance: '5 km',
    featured: true,
    athleteIds: ['carolyn-kevan']
};
const manifestItem = {
    ...itemInput,
    sourceUrl,
    thumbnailUrl
};
const race = {
    raceDate: itemInput.raceDate,
    raceEvent: itemInput.raceEvent,
    raceDistance: itemInput.raceDistance
};
const familyCatalog = {
    exportBundleId: 'bundle-20260829',
    sourceRevision: 'source-20260829',
    races: [race],
    athleteIds: ['carolyn-kevan', 'david-graham-kevan']
};
const everyoneCatalog = {
    ...familyCatalog,
    races: [race],
    athleteIds: ['carolyn-kevan', 'david-graham-kevan', 'grace-chambers']
};
const suppressionDocument = {
    schemaVersion: '1.0',
    hiddenAthleteIds: []
};
const draft = {
    schemaVersion: '1.0',
    draftId: 'draft_01k3h8xb6pg0t9m2q7vr4c5n1z',
    state: 'candidate-public',
    stateVersion: 5,
    siteModes: ['family'],
    exportBundleId: familyCatalog.exportBundleId,
    sourceRevision: familyCatalog.sourceRevision,
    suppressionRevision: 'suppression-20260829',
    itemRevision: 'item-revision-1',
    itemInput,
    manifestItem,
    consent: {
        publicUseConfirmed: true,
        containsMinors: false,
        guardianApprovalConfirmed: false,
        revision: 'consent-revision-1'
    },
    withdrawalEvidence: null
};
const approvedDerivatives = {
    draftId: draft.draftId,
    itemRevision: draft.itemRevision,
    consentRevision: draft.consent.revision,
    exportBundleId: draft.exportBundleId,
    sourceRevision: draft.sourceRevision,
    suppressionRevision: draft.suppressionRevision,
    sourceUrl,
    thumbnailUrl
};
const context = {
    consentRevision: draft.consent.revision,
    suppressionRevision: draft.suppressionRevision,
    suppressionDocument,
    pendingHiddenAthleteIds: [],
    siteCatalogs: {
        family: familyCatalog,
        everyone: everyoneCatalog
    },
    approvedDerivativeOrigin: derivativeOrigin,
    approvedDerivatives
};
const candidatePackage = {
    schemaVersion: '1.0',
    operationId: 'promotion_01k3h8xb6pg0t9m2q7vr4c5n1z',
    draft,
    context,
    editorialPosition: null
};
const catalogSnapshot = {
    schemaVersion: '1.0',
    exportBundleId: draft.exportBundleId,
    sourceRevision: draft.sourceRevision,
    suppressionRevision: draft.suppressionRevision,
    suppressionDocument,
    sites: {
        family: { catalog: familyCatalog },
        everyone: { catalog: everyoneCatalog }
    }
};
const emptyManifests = {
    family: { schemaVersion: '1.0', items: [] },
    everyone: { schemaVersion: '1.0', items: [] }
};

function prepare(candidate = candidatePackage, overrides = {}) {
    return prepareGalleryManifestCandidate(candidate, {
        catalogSnapshot,
        manifestsBySite: emptyManifests,
        replayReceipt: null,
        ...overrides
    });
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function withCandidate(changes = {}) {
    const value = clone(candidatePackage);
    return Object.assign(value, changes);
}

function currentItem(id) {
    return {
        ...manifestItem,
        id,
        title: `Existing ${id}`,
        sourceUrl: `${derivativeOrigin}/media/v1/${id.padEnd(64, 'c').slice(0, 64)}/display.webp`,
        thumbnailUrl: `${derivativeOrigin}/media/v1/${id.padEnd(64, 'd').slice(0, 64)}/thumbnail.webp`
    };
}

// One inherited area, exact public projection, and canonical bytes.
const familyResult = prepare();
assert.equal(familyResult.changed, true);
assert.equal(familyResult.targetRelativePath, 'gallery-data/family.json');
assert.equal(familyResult.itemId, itemInput.id);
assert.match(familyResult.manifestSha256, /^sha256:[a-f0-9]{64}$/);
assert.equal(Object.isFrozen(familyResult), true);

const familyDocument = JSON.parse(familyResult.manifestText);
assert.deepEqual(familyDocument.items.map(item => item.id), [itemInput.id]);
assert.deepEqual(Object.keys(familyDocument.items[0]), galleryManifestPublicItemFields);
assert.equal(
    familyResult.manifestText,
    `${JSON.stringify(familyDocument, null, 2)}\n`
);
for (const privateField of [
    'operationId',
    'editorialPosition',
    'consent',
    'privateEvidenceReference',
    'originalKey',
    'stagingKey',
    'uploader'
]) {
    assert.equal(familyResult.manifestText.includes(privateField), false);
}

const everyoneCandidate = clone(candidatePackage);
everyoneCandidate.draft.siteModes = ['everyone'];
const everyoneResult = prepare(everyoneCandidate);
assert.equal(everyoneResult.targetRelativePath, 'gallery-data/everyone.json');
assert.equal(everyoneResult.manifestText, familyResult.manifestText);

// Destination, path, and private-field injection fail instead of becoming
// workflow controls or public metadata.
for (const injected of [
    { site: 'everyone' },
    { targetPath: 'gallery-data/everyone.json' },
    { privateEvidenceReference: 'private://evidence' }
]) {
    assert.throws(
        () => prepare({ ...candidatePackage, ...injected }),
        /unsupported field/
    );
}
assert.throws(
    () => prepare({
        ...candidatePackage,
        context: { ...context, originalKey: 'private/original.jpg' }
    }),
    /unsupported field "originalKey"/
);
assert.throws(
    () => prepare({
        ...candidatePackage,
        draft: {
            ...draft,
            manifestItem: { ...manifestItem, uploader: 'owner@example.com' }
        }
    }),
    /unsupported fields/
);
assert.throws(
    () => prepare(candidatePackage, { targetPath: 'gallery-data/everyone.json' }),
    /unsupported field "targetPath"/
);

// Photo-only checkpoint.
const videoSourceUrl = `${derivativeOrigin}/media/v1/${'c'.repeat(64)}/video.mp4`;
const videoThumbnailUrl = `${derivativeOrigin}/media/v1/${'d'.repeat(64)}/poster.webp`;
const videoInput = { ...itemInput, id: 'finish-line-video', type: 'video' };
const videoCandidate = clone(candidatePackage);
videoCandidate.draft.itemInput = videoInput;
videoCandidate.draft.manifestItem = {
    ...videoInput,
    sourceUrl: videoSourceUrl,
    thumbnailUrl: videoThumbnailUrl
};
videoCandidate.context.approvedDerivatives.sourceUrl = videoSourceUrl;
videoCandidate.context.approvedDerivatives.thumbnailUrl = videoThumbnailUrl;
assert.throws(() => prepare(videoCandidate), /photographs only/);

// Consent, public-data, suppression, pending exclusion, race/roster, and exact
// derivative evidence are rechecked through the existing publication contract.
assert.throws(
    () => prepare({
        ...candidatePackage,
        context: { ...context, consentRevision: 'consent-revision-2' }
    }),
    /consent revision is stale/
);
assert.throws(
    () => prepare(candidatePackage, {
        catalogSnapshot: { ...catalogSnapshot, exportBundleId: 'new-bundle' }
    }),
    /export bundle is stale/
);
assert.throws(
    () => prepare(candidatePackage, {
        catalogSnapshot: { ...catalogSnapshot, sourceRevision: 'new-source' }
    }),
    /source revision is stale/
);
assert.throws(
    () => prepare(candidatePackage, {
        catalogSnapshot: { ...catalogSnapshot, suppressionRevision: 'new-suppression' }
    }),
    /suppression revision is stale/
);

const hiddenContext = clone(context);
hiddenContext.suppressionDocument.hiddenAthleteIds = ['carolyn-kevan'];
const hiddenSnapshot = clone(catalogSnapshot);
hiddenSnapshot.suppressionDocument.hiddenAthleteIds = ['carolyn-kevan'];
assert.throws(
    () => prepare(
        { ...candidatePackage, context: hiddenContext },
        { catalogSnapshot: hiddenSnapshot }
    ),
    /blocked by person-tag suppression/
);
assert.throws(
    () => prepare({
        ...candidatePackage,
        context: { ...context, pendingHiddenAthleteIds: ['carolyn-kevan'] }
    }),
    /blocked by person-tag suppression/
);

const wrongRaceContext = clone(context);
wrongRaceContext.siteCatalogs.family.races = [{
    ...race,
    raceDate: '2026-08-24'
}];
assert.throws(
    () => prepare({ ...candidatePackage, context: wrongRaceContext }),
    /race is not available/
);
const wrongRosterContext = clone(context);
wrongRosterContext.siteCatalogs.family.athleteIds = ['david-graham-kevan'];
assert.throws(
    () => prepare({ ...candidatePackage, context: wrongRosterContext }),
    /athlete "carolyn-kevan" is not available/
);
assert.throws(
    () => prepare({
        ...candidatePackage,
        context: {
            ...context,
            approvedDerivatives: {
                ...approvedDerivatives,
                itemRevision: 'other-item-revision'
            }
        }
    }),
    /derivative evidence is stale/
);
assert.throws(
    () => prepare({
        ...candidatePackage,
        context: {
            ...context,
            approvedDerivatives: {
                ...approvedDerivatives,
                sourceUrl: `${sourceUrl}?download=1`
            }
        },
        draft: {
            ...draft,
            manifestItem: { ...manifestItem, sourceUrl: `${sourceUrl}?download=1` }
        }
    }),
    /query or fragment/
);

const changedCurrentCatalog = clone(catalogSnapshot);
changedCurrentCatalog.sites.family.catalog.races.push({
    raceDate: '2026-08-30',
    raceEvent: 'New result',
    raceDistance: '5 km'
});
assert.throws(
    () => prepare(candidatePackage, { catalogSnapshot: changedCurrentCatalog }),
    /site catalog is stale/
);

// Append and exact zero-based start/middle/end insertion preserve all existing
// relative order. Out-of-range and unsafe positions fail closed.
const existingItems = [currentItem('first-photo'), currentItem('second-photo')];
for (const [position, expectedIds] of [
    [null, ['first-photo', 'second-photo', itemInput.id]],
    [0, [itemInput.id, 'first-photo', 'second-photo']],
    [1, ['first-photo', itemInput.id, 'second-photo']],
    [2, ['first-photo', 'second-photo', itemInput.id]]
]) {
    const positioned = clone(candidatePackage);
    positioned.editorialPosition = position;
    const result = prepare(positioned, {
        manifestsBySite: {
            family: { schemaVersion: '1.0', items: existingItems },
            everyone: { schemaVersion: '1.0', items: [] }
        }
    });
    assert.deepEqual(JSON.parse(result.manifestText).items.map(item => item.id), expectedIds);
}
for (const invalidPosition of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
        () => prepare({ ...candidatePackage, editorialPosition: invalidPosition }),
        /editorialPosition/
    );
}
assert.throws(
    () => prepare({ ...candidatePackage, editorialPosition: 3 }, {
        manifestsBySite: {
            family: { schemaVersion: '1.0', items: existingItems },
            everyone: { schemaVersion: '1.0', items: [] }
        }
    }),
    /outside the current item range/
);

// Duplicate IDs never turn a one-area upload into a shared upload. Existing
// shared manual content remains valid only when identical across both modes.
assert.throws(
    () => prepare(candidatePackage, {
        manifestsBySite: {
            family: { schemaVersion: '1.0', items: [{ ...manifestItem, title: 'Conflict' }] },
            everyone: { schemaVersion: '1.0', items: [] }
        }
    }),
    /inherited site with different content/
);
assert.throws(
    () => prepare(candidatePackage, {
        manifestsBySite: {
            family: { schemaVersion: '1.0', items: [] },
            everyone: { schemaVersion: '1.0', items: [familyDocument.items[0]] }
        }
    }),
    /automated uploads cannot create shared items/
);
assert.throws(
    () => prepare(candidatePackage, {
        manifestsBySite: {
            family: { schemaVersion: '1.0', items: [] },
            everyone: {
                schemaVersion: '1.0',
                items: [{ ...familyDocument.items[0], title: 'Different content' }]
            }
        }
    }),
    /automated uploads cannot create shared items/
);

const manualSharedItem = currentItem('manual-shared-photo');
assert.doesNotThrow(() => prepare(candidatePackage, {
    manifestsBySite: {
        family: { schemaVersion: '1.0', items: [manualSharedItem] },
        everyone: { schemaVersion: '1.0', items: [clone(manualSharedItem)] }
    }
}));
assert.throws(
    () => prepare(candidatePackage, {
        manifestsBySite: {
            family: { schemaVersion: '1.0', items: [manualSharedItem] },
            everyone: {
                schemaVersion: '1.0',
                items: [{ ...manualSharedItem, title: 'Drifted shared item' }]
            }
        }
    }),
    /shared item "manual-shared-photo" differs/
);

// An exact target replay is accepted only with the receipt for this exact
// operation and exact manifest bytes.
const replayManifests = {
    family: familyDocument,
    everyone: { schemaVersion: '1.0', items: [] }
};
assert.throws(
    () => prepare(candidatePackage, { manifestsBySite: replayManifests }),
    /exact replay requires matching operation evidence/
);
const replayResult = prepare(candidatePackage, {
    manifestsBySite: replayManifests,
    replayReceipt: familyResult.receipt
});
assert.equal(replayResult.changed, false);
assert.equal(replayResult.manifestSha256, familyResult.manifestSha256);
assert.throws(
    () => prepare(candidatePackage, {
        manifestsBySite: replayManifests,
        replayReceipt: { ...familyResult.receipt, operationId: 'promotion_0000000000000000' }
    }),
    /does not match this exact operation/
);

// Existing public documents stay exact and malformed/unexpected shapes fail.
assert.throws(
    () => prepare(candidatePackage, {
        manifestsBySite: {
            family: { schemaVersion: '1.0', items: [], privateNotes: [] },
            everyone: { schemaVersion: '1.0', items: [] }
        }
    }),
    /unsupported field "privateNotes"/
);
assert.throws(
    () => prepare(candidatePackage, {
        manifestsBySite: {
            family: { schemaVersion: '1.0', items: [{ ...manualSharedItem, secret: true }] },
            everyone: { schemaVersion: '1.0', items: [] }
        }
    }),
    /unsupported field "secret"/
);

// The CLI accepts only stdin. Malformed JSON and any destination argument are
// rejected before repository mutation, without echoing the supplied payload.
const malformedRun = spawnSync(process.execPath, [candidateCliPath], {
    cwd: repoRoot,
    input: '{not-json',
    encoding: 'utf8',
    windowsHide: true
});
assert.equal(malformedRun.status, 1);
assert.match(malformedRun.stderr, /not valid JSON/);
assert.doesNotMatch(malformedRun.stderr, /not-json/);

const destinationRun = spawnSync(process.execPath, [candidateCliPath, 'everyone'], {
    cwd: repoRoot,
    input: JSON.stringify(candidatePackage),
    encoding: 'utf8',
    windowsHide: true
});
assert.equal(destinationRun.status, 1);
assert.match(destinationRun.stderr, /no destination arguments are accepted/);
assert.doesNotMatch(destinationRun.stdout, /finish-line-smile/);

console.log('Gallery manifest candidate tests passed.');
