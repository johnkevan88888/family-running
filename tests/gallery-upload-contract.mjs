import assert from 'node:assert/strict';

await import('../gallery-contract.js');
const uploadContractModule = await import('../gallery-upload-contract.js');
const {
    buildAthleteTagChoices,
    canTransitionGalleryUpload,
    createProcessingDispatch,
    createPublicManifestItems,
    planAthleteSuppression,
    stateTransitions,
    transitionGalleryUpload,
    validateAthleteTagSelection,
    validateGalleryUploadApproval,
    validateGalleryUploadCandidate,
    validateGalleryUploadDraft,
    validateGalleryUploadPublication,
    validateTransitionRequest
} = uploadContractModule.default || uploadContractModule;

const derivativeOrigin = 'https://media-example.workers.dev';
const displayHash = 'a'.repeat(64);
const thumbnailHash = 'b'.repeat(64);
const sourceUrl = `${derivativeOrigin}/media/v1/${displayHash}/display.webp`;
const thumbnailUrl = `${derivativeOrigin}/media/v1/${thumbnailHash}/thumbnail.webp`;

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

const validDraft = {
    schemaVersion: '1.0',
    draftId: 'draft_01k3h8xb6pg0t9m2q7vr4c5n1z',
    state: 'draft',
    stateVersion: 0,
    siteModes: ['family'],
    exportBundleId: 'bundle-20260825',
    sourceRevision: 'abcdef1234567890',
    suppressionRevision: 'suppression-1',
    itemRevision: 'item-1',
    itemInput,
    manifestItem: null,
    consent: {
        publicUseConfirmed: true,
        containsMinors: false,
        guardianApprovalConfirmed: false,
        revision: 'consent-1'
    },
    withdrawalEvidence: null
};

const race = {
    raceDate: itemInput.raceDate,
    raceEvent: itemInput.raceEvent,
    raceDistance: itemInput.raceDistance
};
const familyCatalog = {
    exportBundleId: validDraft.exportBundleId,
    sourceRevision: validDraft.sourceRevision,
    races: [race],
    athleteIds: ['carolyn-kevan', 'david-graham-kevan']
};
const everyoneCatalog = {
    ...familyCatalog,
    athleteIds: ['carolyn-kevan', 'david-graham-kevan', 'grace-chambers']
};
const validContext = {
    consentRevision: validDraft.consent.revision,
    suppressionRevision: validDraft.suppressionRevision,
    suppressionDocument: {
        schemaVersion: '1.0',
        hiddenAthleteIds: []
    },
    pendingHiddenAthleteIds: [],
    siteCatalogs: {
        family: familyCatalog,
        everyone: everyoneCatalog
    },
    approvedDerivativeOrigin: derivativeOrigin,
    approvedDerivatives: {
        draftId: validDraft.draftId,
        itemRevision: validDraft.itemRevision,
        consentRevision: validDraft.consent.revision,
        exportBundleId: validDraft.exportBundleId,
        sourceRevision: validDraft.sourceRevision,
        suppressionRevision: validDraft.suppressionRevision,
        sourceUrl,
        thumbnailUrl
    }
};

// Draft shape, exact site vocabulary, private/public separation, and revisions.
assert.deepEqual(validateGalleryUploadDraft(validDraft), []);
assert.deepEqual(validateGalleryUploadDraft({ ...validDraft, siteModes: ['everyone'] }), []);

for (const invalidSiteModes of [
    [],
    ['family', 'everyone'],
    ['family', 'family'],
    ['everyone', 'family'],
    ['friends'],
    'family'
]) {
    assert.match(
        validateGalleryUploadDraft({ ...validDraft, siteModes: invalidSiteModes }).join('\n'),
        /siteModes must be/
    );
}

assert.match(
    validateGalleryUploadDraft({ ...validDraft, state: 'ready-for-review' }).join('\n'),
    /state must be one of/
);
assert.match(
    validateGalleryUploadDraft({ ...validDraft, stateVersion: -1 }).join('\n'),
    /stateVersion must be a non-negative/
);
assert.match(
    validateGalleryUploadDraft({ ...validDraft, exportBundleId: '' }).join('\n'),
    /exportBundleId must be/
);
assert.match(
    validateGalleryUploadDraft({ ...validDraft, sourceRevision: '../main' }).join('\n'),
    /sourceRevision must be/
);
assert.match(
    validateGalleryUploadDraft({ ...validDraft, draftId: 'finish-line-smile' }).join('\n'),
    /draftId must be an opaque URL-safe identifier/
);
assert.match(
    validateGalleryUploadDraft({ ...validDraft, itemRevision: '../item' }).join('\n'),
    /itemRevision must be/
);
assert.match(
    validateGalleryUploadDraft({ ...validDraft, storageBucket: 'private' }).join('\n'),
    /contains unsupported fields/
);

const missingManifestField = { ...validDraft };
delete missingManifestField.manifestItem;
assert.match(
    validateGalleryUploadDraft(missingManifestField).join('\n'),
    /missing required field "manifestItem"/
);
assert.match(
    validateGalleryUploadDraft({
        ...validDraft,
        consent: { ...validDraft.consent, privateNote: 'Do not publish this.' }
    }).join('\n'),
    /contains unsupported fields/
);
assert.match(
    validateGalleryUploadDraft({
        ...validDraft,
        itemInput: { ...itemInput, moderationStatus: 'approved' }
    }).join('\n'),
    /contains unsupported fields/
);
const attackerControlledKey = '<img src=x onerror=sentinel-key-leak>';
const unsupportedItemProblems = validateGalleryUploadDraft({
    ...validDraft,
    itemInput: { ...itemInput, [attackerControlledKey]: 'private' },
    manifestItem: { ...manifestItem, [attackerControlledKey]: 'private' }
}).join('\n');
assert.match(unsupportedItemProblems, /contains unsupported fields/);
assert.doesNotMatch(unsupportedItemProblems, /sentinel-key-leak/);
assert.match(
    validateGalleryUploadDraft({
        ...validDraft,
        itemInput: { ...itemInput, title: '' }
    }).join('\n'),
    /title must be non-empty text/
);
assert.match(
    validateGalleryUploadDraft({
        ...validDraft,
        manifestItem: { ...manifestItem, title: 'Changed after review' }
    }).join('\n'),
    /manifestItem.title must exactly match itemInput.title/
);
assert.match(
    validateGalleryUploadDraft({
        ...validDraft,
        state: 'candidate-public'
    }).join('\n'),
    /requires a complete public manifest item/
);
assert.match(
    validateGalleryUploadDraft({
        ...validDraft,
        withdrawalEvidence: {
            hostDeletionConfirmed: true,
            evidenceRevision: 'delete-1'
        }
    }).join('\n'),
    /withdrawalEvidence must be null before withdrawal completes/
);

// Approval gates re-read consent, the draft's single selected catalog, and suppression.
assert.deepEqual(validateGalleryUploadApproval(validDraft, validContext), []);
assert.match(
    validateGalleryUploadApproval({
        ...validDraft,
        consent: { ...validDraft.consent, publicUseConfirmed: false }
    }, validContext).join('\n'),
    /Public use must be confirmed/
);
assert.match(
    validateGalleryUploadApproval({
        ...validDraft,
        consent: {
            ...validDraft.consent,
            containsMinors: true,
            guardianApprovalConfirmed: false
        }
    }, validContext).join('\n'),
    /Guardian approval must be confirmed/
);
assert.deepEqual(
    validateGalleryUploadApproval({
        ...validDraft,
        consent: {
            ...validDraft.consent,
            containsMinors: true,
            guardianApprovalConfirmed: true
        }
    }, validContext),
    []
);

// Consent is about every depicted person, not whether a public athlete tag was
// selected. Empty tags therefore never bypass either consent gate.
const untaggedDraft = {
    ...validDraft,
    itemRevision: 'item-untagged-1',
    itemInput: { ...itemInput, athleteIds: [] },
    manifestItem: null
};
assert.deepEqual(validateGalleryUploadApproval(untaggedDraft, validContext), []);
assert.match(
    validateGalleryUploadApproval({
        ...untaggedDraft,
        consent: { ...untaggedDraft.consent, publicUseConfirmed: false }
    }, validContext).join('\n'),
    /Public use must be confirmed/
);
assert.equal(
    createProcessingDispatch({
        ...untaggedDraft,
        state: 'approved-for-processing',
        consent: { ...untaggedDraft.consent, publicUseConfirmed: false }
    }, validContext),
    null
);
assert.match(
    validateGalleryUploadApproval({
        ...untaggedDraft,
        consent: {
            ...untaggedDraft.consent,
            containsMinors: true,
            guardianApprovalConfirmed: false
        }
    }, validContext).join('\n'),
    /Guardian approval must be confirmed/
);
const untaggedManifestItem = { ...manifestItem, athleteIds: [] };
const untaggedPublication = createPublicManifestItems({
    ...untaggedDraft,
    state: 'candidate-public',
    manifestItem: untaggedManifestItem,
    consent: { ...untaggedDraft.consent, publicUseConfirmed: false }
}, {
    ...validContext,
    approvedDerivatives: {
        ...validContext.approvedDerivatives,
        itemRevision: untaggedDraft.itemRevision
    }
});
assert.equal(untaggedPublication.ok, false);
assert.deepEqual(untaggedPublication.itemsBySite, {});
assert.match(untaggedPublication.problems.join('\n'), /Public use must be confirmed/);
assert.match(
    validateGalleryUploadApproval(validDraft, {
        ...validContext,
        consentRevision: 'consent-2'
    }).join('\n'),
    /consent revision is stale/
);
assert.match(
    validateGalleryUploadApproval(validDraft, {
        ...validContext,
        suppressionRevision: 'suppression-2'
    }).join('\n'),
    /suppression revision is stale/
);
assert.match(
    validateGalleryUploadApproval(validDraft, {
        ...validContext,
        suppressionDocument: {
            schemaVersion: '1.0',
            hiddenAthleteIds: ['carolyn-kevan']
        }
    }).join('\n'),
    /blocked by person-tag suppression for: carolyn-kevan/
);
assert.match(
    validateGalleryUploadApproval(validDraft, {
        ...validContext,
        pendingHiddenAthleteIds: ['carolyn-kevan']
    }).join('\n'),
    /blocked by person-tag suppression for: carolyn-kevan/
);
assert.match(
    validateGalleryUploadApproval(validDraft, {
        ...validContext,
        pendingHiddenAthleteIds: undefined
    }).join('\n'),
    /pending suppression data/
);
const unsupportedSuppressionProblems = validateGalleryUploadApproval(validDraft, {
    ...validContext,
    suppressionDocument: {
        schemaVersion: '1.0',
        hiddenAthleteIds: [],
        [attackerControlledKey]: 'private request text'
    }
}).join('\n');
assert.match(unsupportedSuppressionProblems, /contains unsupported fields/);
assert.doesNotMatch(unsupportedSuppressionProblems, /sentinel-key-leak/);
assert.match(
    validateGalleryUploadApproval(validDraft, {
        ...validContext,
        suppressionDocument: undefined
    }).join('\n'),
    /suppression data/
);

const unsupportedCatalogProblems = validateGalleryUploadApproval(validDraft, {
    ...validContext,
    siteCatalogs: {
        ...validContext.siteCatalogs,
        family: { ...familyCatalog, [attackerControlledKey]: 'private catalog data' }
    }
}).join('\n');
assert.match(unsupportedCatalogProblems, /site catalog.*contains unsupported fields/);
assert.doesNotMatch(unsupportedCatalogProblems, /sentinel-key-leak/);

const unsupportedCatalogModeProblems = validateGalleryUploadApproval(validDraft, {
    ...validContext,
    siteCatalogs: {
        ...validContext.siteCatalogs,
        [attackerControlledKey]: { privateValue: 'private catalog data' }
    }
}).join('\n');
assert.match(unsupportedCatalogModeProblems, /site catalogs contain unsupported site modes/);
assert.doesNotMatch(unsupportedCatalogModeProblems, /sentinel-key-leak/);

const unsupportedRaceProblems = validateGalleryUploadApproval(validDraft, {
    ...validContext,
    siteCatalogs: {
        ...validContext.siteCatalogs,
        family: {
            ...familyCatalog,
            races: [{ ...race, [attackerControlledKey]: 'private race data' }]
        }
    }
}).join('\n');
assert.match(unsupportedRaceProblems, /race\[0\].*contains unsupported fields/);
assert.doesNotMatch(unsupportedRaceProblems, /sentinel-key-leak/);

assert.match(
    validateGalleryUploadApproval(validDraft, {
        ...validContext,
        siteCatalogs: {
            ...validContext.siteCatalogs,
            family: {
                ...familyCatalog,
                races: [race, {
                    raceDate: '2026-99-99',
                    raceEvent: 'Unused malformed race',
                    raceDistance: '5 km'
                }]
            }
        }
    }).join('\n'),
    /race\[1\].*valid race date/
);
assert.match(
    validateGalleryUploadApproval(validDraft, {
        ...validContext,
        siteCatalogs: {
            ...validContext.siteCatalogs,
            family: { ...familyCatalog, races: [race, { ...race }] }
        }
    }).join('\n'),
    /duplicate race tuples/
);
assert.match(
    validateGalleryUploadApproval(validDraft, {
        ...validContext,
        siteCatalogs: {
            ...validContext.siteCatalogs,
            family: {
                ...familyCatalog,
                athleteIds: [...familyCatalog.athleteIds, 'Typed Athlete Name']
            }
        }
    }).join('\n'),
    /athleteIds\[2\].*not a valid public athlete ID/
);
assert.match(
    validateGalleryUploadApproval(validDraft, {
        ...validContext,
        siteCatalogs: {
            ...validContext.siteCatalogs,
            family: {
                ...familyCatalog,
                athleteIds: [...familyCatalog.athleteIds, 'carolyn-kevan']
            }
        }
    }).join('\n'),
    /duplicate athlete IDs/
);

const everyoneDraft = { ...validDraft, siteModes: ['everyone'] };
assert.deepEqual(validateGalleryUploadApproval(everyoneDraft, validContext), []);
assert.match(
    validateGalleryUploadApproval(everyoneDraft, {
        ...validContext,
        siteCatalogs: {
            ...validContext.siteCatalogs,
            everyone: { ...everyoneCatalog, exportBundleId: 'bundle-new' }
        }
    }).join('\n'),
    /export bundle is stale for site mode "everyone"/
);
assert.match(
    validateGalleryUploadApproval(everyoneDraft, {
        ...validContext,
        siteCatalogs: {
            ...validContext.siteCatalogs,
            everyone: { ...everyoneCatalog, sourceRevision: 'fedcba9876543210' }
        }
    }).join('\n'),
    /source revision is stale for site mode "everyone"/
);
assert.match(
    validateGalleryUploadApproval(everyoneDraft, {
        ...validContext,
        siteCatalogs: {
            ...validContext.siteCatalogs,
            everyone: { ...everyoneCatalog, races: [] }
        }
    }).join('\n'),
    /race is not available in the "everyone" site catalog/
);
assert.match(
    validateGalleryUploadApproval(everyoneDraft, {
        ...validContext,
        siteCatalogs: {
            ...validContext.siteCatalogs,
            everyone: { ...everyoneCatalog, athleteIds: ['grace-chambers'] }
        }
    }).join('\n'),
    /athlete "carolyn-kevan" is not available in the "everyone" site catalog/
);

// Only exact processor-approved immutable derivative URLs can become public.
const processingCandidate = {
    ...validDraft,
    state: 'processing',
    stateVersion: 4,
    manifestItem
};
assert.deepEqual(validateGalleryUploadCandidate(processingCandidate, validContext), []);
assert.match(
    validateGalleryUploadCandidate({
        ...processingCandidate,
        consent: { ...processingCandidate.consent, revision: 'consent-2' }
    }, {
        ...validContext,
        consentRevision: 'consent-2'
    }).join('\n'),
    /derivative evidence is stale/
);
assert.match(
    validateGalleryUploadCandidate({
        ...processingCandidate,
        itemRevision: 'item-2'
    }, validContext).join('\n'),
    /derivative evidence is stale/
);
assert.match(
    validateGalleryUploadCandidate({
        ...processingCandidate,
        exportBundleId: 'bundle-20260826'
    }, {
        ...validContext,
        siteCatalogs: {
            family: { ...familyCatalog, exportBundleId: 'bundle-20260826' },
            everyone: { ...everyoneCatalog, exportBundleId: 'bundle-20260826' }
        }
    }).join('\n'),
    /derivative evidence is stale/
);
assert.match(
    validateGalleryUploadCandidate({
        ...processingCandidate,
        sourceRevision: 'abcdef1234567891'
    }, {
        ...validContext,
        siteCatalogs: {
            family: { ...familyCatalog, sourceRevision: 'abcdef1234567891' },
            everyone: { ...everyoneCatalog, sourceRevision: 'abcdef1234567891' }
        }
    }).join('\n'),
    /derivative evidence is stale/
);
assert.match(
    validateGalleryUploadCandidate({
        ...processingCandidate,
        suppressionRevision: 'suppression-2'
    }, {
        ...validContext,
        suppressionRevision: 'suppression-2'
    }).join('\n'),
    /derivative evidence is stale/
);
const unsupportedDerivativeProblems = validateGalleryUploadCandidate(processingCandidate, {
    ...validContext,
    approvedDerivatives: {
        ...validContext.approvedDerivatives,
        [attackerControlledKey]: 'processor-private-path'
    }
}).join('\n');
assert.match(unsupportedDerivativeProblems, /contains unsupported fields/);
assert.doesNotMatch(unsupportedDerivativeProblems, /sentinel-key-leak/);
assert.match(
    validateGalleryUploadCandidate(processingCandidate, {
        ...validContext,
        approvedDerivativeOrigin: 'https://other.example.com'
    }).join('\n'),
    /exact approved origin/
);
assert.match(
    validateGalleryUploadCandidate(processingCandidate, {
        ...validContext,
        approvedDerivatives: {
            ...validContext.approvedDerivatives,
            sourceUrl: `${sourceUrl}?token=secret`
        }
    }).join('\n'),
    /must exactly match the processor-approved URL|must not contain a query/
);
assert.match(
    validateGalleryUploadCandidate({
        ...processingCandidate,
        manifestItem: {
            ...manifestItem,
            sourceUrl: `https://foreign.example.com/media/v1/${displayHash}/display.webp`
        }
    }, {
        ...validContext,
        approvedDerivatives: {
            ...validContext.approvedDerivatives,
            sourceUrl: `https://foreign.example.com/media/v1/${displayHash}/display.webp`
        }
    }).join('\n'),
    /must use the exact approved origin/
);
assert.match(
    validateGalleryUploadCandidate({
        ...processingCandidate,
        manifestItem: {
            ...manifestItem,
            sourceUrl: `${derivativeOrigin}/public/display.webp`
        }
    }, {
        ...validContext,
        approvedDerivatives: {
            ...validContext.approvedDerivatives,
            sourceUrl: `${derivativeOrigin}/public/display.webp`
        }
    }).join('\n'),
    /immutable media key grammar/
);
assert.match(
    validateGalleryUploadCandidate({
        ...processingCandidate,
        manifestItem: { ...manifestItem, thumbnailUrl: `${thumbnailUrl}#poster` }
    }, {
        ...validContext,
        approvedDerivatives: {
            ...validContext.approvedDerivatives,
            sourceUrl,
            thumbnailUrl: `${thumbnailUrl}#poster`
        }
    }).join('\n'),
    /must not contain a query or fragment/
);

const candidateDraft = {
    ...processingCandidate,
    state: 'candidate-public',
    stateVersion: 5
};
assert.deepEqual(validateGalleryUploadPublication(candidateDraft, validContext), []);
assert.match(
    validateGalleryUploadPublication(processingCandidate, validContext).join('\n'),
    /publication requires state "candidate-public" or "pr-open"/
);

const videoSourceUrl = `${derivativeOrigin}/media/v1/${'c'.repeat(64)}/video.mp4`;
const videoPosterUrl = `${derivativeOrigin}/media/v1/${'d'.repeat(64)}/poster.webp`;
const videoItemInput = {
    ...itemInput,
    id: 'finish-line-video',
    type: 'video'
};
const videoCandidate = {
    ...validDraft,
    state: 'candidate-public',
    stateVersion: 5,
    itemInput: videoItemInput,
    manifestItem: {
        ...videoItemInput,
        sourceUrl: videoSourceUrl,
        thumbnailUrl: videoPosterUrl
    }
};
assert.deepEqual(validateGalleryUploadPublication(videoCandidate, {
    ...validContext,
    approvedDerivatives: {
        ...validContext.approvedDerivatives,
        sourceUrl: videoSourceUrl,
        thumbnailUrl: videoPosterUrl
    }
}), []);

const publicCopies = createPublicManifestItems(candidateDraft, validContext);
assert.equal(publicCopies.ok, true);
assert.deepEqual(Object.keys(publicCopies.itemsBySite), ['family']);
assert.deepEqual(publicCopies.itemsBySite.family, manifestItem);
assert.notEqual(publicCopies.itemsBySite.family, manifestItem);
assert.equal(Object.isFrozen(publicCopies), true);
assert.equal(Object.isFrozen(publicCopies.itemsBySite), true);
assert.equal(Object.isFrozen(publicCopies.itemsBySite.family), true);
assert.equal(Object.isFrozen(publicCopies.itemsBySite.family.athleteIds), true);
assert.throws(() => {
    publicCopies.itemsBySite.family.athleteIds.push('another-athlete');
}, TypeError);
assert.equal('consent' in publicCopies.itemsBySite.family, false);
assert.equal('state' in publicCopies.itemsBySite.family, false);

const everyonePublicCopy = createPublicManifestItems({
    ...candidateDraft,
    siteModes: ['everyone']
}, validContext);
assert.equal(everyonePublicCopy.ok, true);
assert.deepEqual(Object.keys(everyonePublicCopy.itemsBySite), ['everyone']);
assert.deepEqual(everyonePublicCopy.itemsBySite.everyone, manifestItem);
assert.equal(Object.hasOwn(everyonePublicCopy.itemsBySite, 'family'), false);

// Athlete-wide exclusion outputs only the ID-only public suppression change and
// de-duplicates one shared item while identifying every whole host-side item.
const familyOnlyItem = {
    ...manifestItem,
    id: 'family-finish',
    athleteIds: ['carolyn-kevan', 'david-graham-kevan'],
    sourceUrl: `${derivativeOrigin}/media/v1/${'c'.repeat(64)}/display.webp`,
    thumbnailUrl: `${derivativeOrigin}/media/v1/${'d'.repeat(64)}/thumbnail.webp`
};
const unrelatedItem = {
    ...manifestItem,
    id: 'unrelated-finish',
    athleteIds: ['david-graham-kevan'],
    sourceUrl: `${derivativeOrigin}/media/v1/${'e'.repeat(64)}/display.webp`,
    thumbnailUrl: `${derivativeOrigin}/media/v1/${'f'.repeat(64)}/thumbnail.webp`
};
const taggedVideoItem = {
    ...manifestItem,
    id: 'everyone-finish-video',
    type: 'video',
    athleteIds: ['carolyn-kevan', 'grace-chambers'],
    sourceUrl: `${derivativeOrigin}/media/v1/${'1'.repeat(64)}/video.mp4`,
    thumbnailUrl: `${derivativeOrigin}/media/v1/${'2'.repeat(64)}/poster.webp`
};
const manifestsBySite = {
    family: {
        schemaVersion: '1.0',
        items: [manifestItem, familyOnlyItem]
    },
    everyone: {
        schemaVersion: '1.0',
        items: [manifestItem, taggedVideoItem, unrelatedItem]
    }
};
const exclusionRevisionContext = {
    expectedSuppressionRevision: 'suppression-1',
    currentSuppressionRevision: 'suppression-1',
    expectedManifestRevisions: {
        family: 'family-manifest-1',
        everyone: 'everyone-manifest-1'
    },
    currentManifestRevisions: {
        family: 'family-manifest-1',
        everyone: 'everyone-manifest-1'
    },
    approvedDerivativeOrigin: derivativeOrigin,
    knownAthleteIds: [
        'carolyn-kevan',
        'david-graham-kevan',
        'grace-chambers',
        'unused-athlete'
    ]
};
const suppressionPlan = planAthleteSuppression(
    'carolyn-kevan',
    { schemaVersion: '1.0', hiddenAthleteIds: ['existing-athlete'] },
    manifestsBySite,
    exclusionRevisionContext
);
assert.equal(suppressionPlan.ok, true);
assert.deepEqual(suppressionPlan.suppressionDocument, {
    schemaVersion: '1.0',
    hiddenAthleteIds: ['existing-athlete', 'carolyn-kevan']
});
assert.deepEqual(
    suppressionPlan.takedownItems.map(item => [item.id, item.siteModes]),
    [
        ['finish-line-smile', ['family', 'everyone']],
        ['family-finish', ['family']],
        ['everyone-finish-video', ['everyone']]
    ]
);
assert.equal(Object.isFrozen(suppressionPlan.takedownItems[0].siteModes), true);
assert.deepEqual(suppressionPlan.ownedObjectUrls, [
    manifestItem.sourceUrl,
    manifestItem.thumbnailUrl,
    familyOnlyItem.sourceUrl,
    familyOnlyItem.thumbnailUrl,
    taggedVideoItem.sourceUrl,
    taggedVideoItem.thumbnailUrl
]);
assert.deepEqual(suppressionPlan.basisRevisions, {
    suppressionRevision: 'suppression-1',
    manifestRevisions: {
        family: 'family-manifest-1',
        everyone: 'everyone-manifest-1'
    }
});
assert.deepEqual(
    suppressionPlan.correctedManifests.family.items.map(item => item.id),
    []
);
assert.deepEqual(
    suppressionPlan.correctedManifests.everyone.items.map(item => item.id),
    ['unrelated-finish']
);
assert.equal(Object.isFrozen(suppressionPlan.correctedManifests.family.items), true);
assert.deepEqual(Object.keys(suppressionPlan.suppressionDocument), [
    'schemaVersion',
    'hiddenAthleteIds'
]);
assert.doesNotMatch(
    JSON.stringify(suppressionPlan.suppressionDocument),
    /participant|reason|note|Carolyn Kevan/i
);
assert.equal(
    planAthleteSuppression(
        'carolyn-kevan',
        { schemaVersion: '1.0', hiddenAthleteIds: ['carolyn-kevan'] },
        manifestsBySite,
        exclusionRevisionContext
    ).suppressionDocument.hiddenAthleteIds.length,
    1
);
assert.match(
    planAthleteSuppression('Carolyn Kevan', {
        schemaVersion: '1.0',
        hiddenAthleteIds: []
    }, manifestsBySite, exclusionRevisionContext).problems.join('\n'),
    /valid athlete ID/
);
assert.match(
    planAthleteSuppression('unknown-athlete', {
        schemaVersion: '1.0',
        hiddenAthleteIds: []
    }, manifestsBySite, exclusionRevisionContext).problems.join('\n'),
    /not in the current known roster/
);
assert.match(
    planAthleteSuppression('carolyn-kevan', {
        schemaVersion: '1.0',
        hiddenAthleteIds: []
    }, {
        ...manifestsBySite,
        everyone: {
            schemaVersion: '1.0',
            items: [{
                ...manifestItem,
                title: 'Different shared item',
                athleteIds: ['david-graham-kevan']
            }]
        }
    }, exclusionRevisionContext).problems.join('\n'),
    /shared item "finish-line-smile" with different content/
);

assert.match(
    planAthleteSuppression('carolyn-kevan', {
        schemaVersion: '1.0',
        hiddenAthleteIds: []
    }, manifestsBySite, {
        ...exclusionRevisionContext,
        currentManifestRevisions: {
            ...exclusionRevisionContext.currentManifestRevisions,
            everyone: 'everyone-manifest-2'
        }
    }).problems.join('\n'),
    /manifest revision is stale for site mode "everyone"/
);
assert.match(
    planAthleteSuppression('carolyn-kevan', {
        schemaVersion: '1.0',
        hiddenAthleteIds: []
    }, {
        family: manifestsBySite.family
    }, exclusionRevisionContext).problems.join('\n'),
    /requires the "everyone" manifest/
);

const reusedUrlItem = {
    ...unrelatedItem,
    sourceUrl: manifestItem.sourceUrl
};
assert.match(
    planAthleteSuppression('carolyn-kevan', {
        schemaVersion: '1.0',
        hiddenAthleteIds: []
    }, {
        family: manifestsBySite.family,
        everyone: {
            schemaVersion: '1.0',
            items: [manifestItem, reusedUrlItem]
        }
    }, exclusionRevisionContext).problems.join('\n'),
    /URL is reused by unaffected item "unrelated-finish"/
);

assert.match(
    planAthleteSuppression('carolyn-kevan', {
        schemaVersion: '1.0',
        hiddenAthleteIds: []
    }, {
        family: {
            schemaVersion: '1.0',
            items: [{ ...manifestItem, sourceUrl: 'https://arbitrary.example.com/photo.jpg' }]
        },
        everyone: { schemaVersion: '1.0', items: [] }
    }, exclusionRevisionContext).problems.join('\n'),
    /exact approved origin|immutable media key grammar/
);

const unusedSuppressionPlan = planAthleteSuppression('unused-athlete', {
    schemaVersion: '1.0',
    hiddenAthleteIds: []
}, manifestsBySite, exclusionRevisionContext);
assert.equal(unusedSuppressionPlan.ok, true);
assert.deepEqual(unusedSuppressionPlan.suppressionDocument.hiddenAthleteIds, ['unused-athlete']);
assert.deepEqual(unusedSuppressionPlan.takedownItems, []);
assert.deepEqual(unusedSuppressionPlan.ownedObjectUrls, []);
assert.deepEqual(unusedSuppressionPlan.correctedManifests, manifestsBySite);

// Tagging choices place selected-race runners first and selections accept IDs,
// never typed names or unknown identities.
const roster = [
    { athleteId: 'david-graham-kevan', participant: 'David Graham-Kevan' },
    { athleteId: 'carolyn-kevan', participant: 'Carolyn Kevan' },
    { athleteId: 'grace-chambers', participant: 'Grace Chambers' }
];
const choiceResult = buildAthleteTagChoices(race, roster, [
    { athleteId: 'carolyn-kevan', ...race },
    {
        athleteId: 'david-graham-kevan',
        raceDate: '2026-08-22',
        raceEvent: race.raceEvent,
        raceDistance: race.raceDistance
    },
    { athleteId: 'grace-chambers', ...race }
]);
assert.equal(choiceResult.ok, true);
assert.deepEqual(
    choiceResult.choices.map(choice => [choice.athleteId, choice.ranSelectedRace]),
    [
        ['carolyn-kevan', true],
        ['grace-chambers', true],
        ['david-graham-kevan', false]
    ]
);
assert.deepEqual(
    validateAthleteTagSelection(['carolyn-kevan', 'david-graham-kevan'], choiceResult.choices),
    []
);
assert.match(
    validateAthleteTagSelection(['Carolyn Kevan'], choiceResult.choices).join('\n'),
    /not free-text identity/
);
assert.match(
    validateAthleteTagSelection(['unknown-athlete'], choiceResult.choices).join('\n'),
    /not an available athlete ID/
);
assert.match(
    validateAthleteTagSelection(['carolyn-kevan', 'carolyn-kevan'], choiceResult.choices).join('\n'),
    /duplicates "carolyn-kevan"/
);
assert.match(
    buildAthleteTagChoices(race, roster, [
        { athleteId: 'carolyn-kevan', ...race },
        {
            athleteId: 'grace-chambers',
            raceDate: '2026-02-30',
            raceEvent: 'Unused malformed race',
            raceDistance: '5 km'
        }
    ]).problems.join('\n'),
    /resultEntries\[1\].*valid race date/
);

// Transactional state transitions require CAS plus an idempotency key bound to
// one payload fingerprint. Replays do not duplicate work; stale writers fail.
assert.deepEqual(stateTransitions.draft, ['uploading', 'withdrawal-pending']);
assert.deepEqual(stateTransitions.processing, [
    'candidate-public',
    'processing-failed',
    'withdrawal-pending'
]);
assert.equal(canTransitionGalleryUpload('draft', 'uploading'), true);
assert.equal(canTransitionGalleryUpload('draft', 'draft'), false);
assert.equal(canTransitionGalleryUpload('draft', 'published'), false);

let operationNumber = 0;
function transitionRequest(toState, expectedStateVersion, fingerprintCharacter = 'a') {
    operationNumber += 1;
    return {
        toState,
        expectedStateVersion,
        idempotencyKey: `gallery-operation-${String(operationNumber).padStart(4, '0')}`,
        payloadFingerprint: fingerprintCharacter.repeat(64)
    };
}

assert.match(
    validateTransitionRequest({
        toState: 'uploading',
        expectedStateVersion: 0,
        idempotencyKey: 'short',
        payloadFingerprint: 'not-a-hash'
    }).join('\n'),
    /idempotencyKey|payloadFingerprint/
);

const uploadRequest = transitionRequest('uploading', 0, '1');
const uploading = transitionGalleryUpload(validDraft, uploadRequest);
assert.equal(uploading.ok, true);
assert.equal(uploading.changed, true);
assert.equal(uploading.draft.state, 'uploading');
assert.equal(uploading.draft.stateVersion, 1);
assert.equal(uploading.idempotencyRecord.draftId, validDraft.draftId);

const uploadReplay = transitionGalleryUpload(uploading.draft, uploadRequest, {
    idempotencyRecord: uploading.idempotencyRecord
});
assert.equal(uploadReplay.ok, true);
assert.equal(uploadReplay.changed, false);
assert.equal(uploadReplay.draft, uploading.draft);

const crossDraftReplay = transitionGalleryUpload({
    ...uploading.draft,
    draftId: 'draft_01k3h8xb6pg0t9m2q7vr4c5n2y'
}, uploadRequest, {
    idempotencyRecord: uploading.idempotencyRecord
});
assert.equal(crossDraftReplay.ok, false);
assert.match(crossDraftReplay.problems.join('\n'), /does not match the current draft/);

const changedReplay = transitionGalleryUpload(uploading.draft, {
    ...uploadRequest,
    payloadFingerprint: '2'.repeat(64)
}, {
    idempotencyRecord: uploading.idempotencyRecord
});
assert.equal(changedReplay.ok, false);
assert.match(changedReplay.problems.join('\n'), /already used with a different payload/);
assert.match(
    transitionGalleryUpload(uploading.draft, {
        ...uploadRequest,
        expectedStateVersion: 1
    }, {
        idempotencyRecord: uploading.idempotencyRecord
    }).problems.join('\n'),
    /already used with a different payload/
);

const staleConcurrent = transitionGalleryUpload(
    uploading.draft,
    transitionRequest('withdrawal-pending', 0, '3')
);
assert.equal(staleConcurrent.ok, false);
assert.match(staleConcurrent.problems.join('\n'), /transition is stale/);

const privateReview = transitionGalleryUpload(
    uploading.draft,
    transitionRequest('private-review', 1, '4')
);
assert.equal(privateReview.ok, true);
assert.equal(privateReview.draft.stateVersion, 2);

const approvalWithoutConsent = transitionGalleryUpload({
    ...privateReview.draft,
    consent: { ...privateReview.draft.consent, publicUseConfirmed: false }
}, transitionRequest('approved-for-processing', 2, '5'), validContext);
assert.equal(approvalWithoutConsent.ok, false);
assert.match(approvalWithoutConsent.problems.join('\n'), /Public use must be confirmed/);

const approved = transitionGalleryUpload(
    privateReview.draft,
    transitionRequest('approved-for-processing', 2, '6'),
    validContext
);
assert.equal(approved.ok, true);
assert.equal(approved.draft.state, 'approved-for-processing');
assert.equal(approved.draft.stateVersion, 3);

const processingDispatch = createProcessingDispatch(approved.draft, validContext);
assert.deepEqual(processingDispatch, { draftId: validDraft.draftId });
assert.deepEqual(Object.keys(processingDispatch), ['draftId']);
assert.equal(Object.isFrozen(processingDispatch), true);
assert.doesNotMatch(JSON.stringify(processingDispatch), /itemInput|manifestItem|consent|sourceRevision/);
assert.equal(createProcessingDispatch(privateReview.draft, validContext), null);
assert.equal(createProcessingDispatch(approved.draft, {
    ...validContext,
    consentRevision: 'consent-2'
}), null);
assert.equal(createProcessingDispatch(approved.draft, {
    ...validContext,
    pendingHiddenAthleteIds: ['carolyn-kevan']
}), null);

const processing = transitionGalleryUpload(
    approved.draft,
    transitionRequest('processing', 3, '7'),
    validContext
);
assert.equal(processing.ok, true);
assert.equal(processing.draft.stateVersion, 4);

const failed = transitionGalleryUpload(
    processing.draft,
    transitionRequest('processing-failed', 4, '8')
);
assert.equal(failed.ok, true);
assert.equal(
    transitionGalleryUpload(
        failed.draft,
        transitionRequest('approved-for-processing', 5, '9'),
        validContext
    ).ok,
    true
);

const processingWithCandidate = { ...processing.draft, manifestItem };
const candidate = transitionGalleryUpload(
    processingWithCandidate,
    transitionRequest('candidate-public', 4, 'a'),
    validContext
);
assert.equal(candidate.ok, true);
assert.equal(candidate.draft.state, 'candidate-public');
assert.equal(candidate.draft.stateVersion, 5);

const prOpen = transitionGalleryUpload(
    candidate.draft,
    transitionRequest('pr-open', 5, 'b'),
    validContext
);
assert.equal(prOpen.ok, true);
assert.equal(prOpen.draft.stateVersion, 6);

const newlySuppressedContext = {
    ...validContext,
    suppressionRevision: 'suppression-2',
    suppressionDocument: {
        schemaVersion: '1.0',
        hiddenAthleteIds: ['carolyn-kevan']
    }
};
const pendingBlockedPublication = transitionGalleryUpload(
    prOpen.draft,
    transitionRequest('published', 6, 'c'),
    {
        ...validContext,
        pendingHiddenAthleteIds: ['carolyn-kevan']
    }
);
assert.equal(pendingBlockedPublication.ok, false);
assert.match(
    pendingBlockedPublication.problems.join('\n'),
    /blocked by person-tag suppression/
);
assert.doesNotMatch(
    pendingBlockedPublication.problems.join('\n'),
    /suppression revision is stale/
);
const blockedPublication = transitionGalleryUpload(
    prOpen.draft,
    transitionRequest('published', 6, 'd'),
    newlySuppressedContext
);
assert.equal(blockedPublication.ok, false);
assert.match(blockedPublication.problems.join('\n'), /suppression revision is stale/);
assert.match(blockedPublication.problems.join('\n'), /blocked by person-tag suppression/);
assert.equal(blockedPublication.draft.state, 'pr-open');

const published = transitionGalleryUpload(
    prOpen.draft,
    transitionRequest('published', 6, 'e'),
    validContext
);
assert.equal(published.ok, true);
assert.equal(published.draft.state, 'published');
assert.equal(published.draft.stateVersion, 7);

const withdrawalPending = transitionGalleryUpload(
    published.draft,
    transitionRequest('withdrawal-pending', 7, 'e')
);
assert.equal(withdrawalPending.ok, true);
assert.equal(withdrawalPending.draft.state, 'withdrawal-pending');

const prematureWithdrawal = transitionGalleryUpload(
    withdrawalPending.draft,
    transitionRequest('withdrawn', 8, 'f')
);
assert.equal(prematureWithdrawal.ok, false);
assert.match(prematureWithdrawal.problems.join('\n'), /host-deletion evidence is required/);

const consentWithdrawalWithoutOriginalDeletion = transitionGalleryUpload(
    withdrawalPending.draft,
    transitionRequest('withdrawn', 8, '9'),
    {
        withdrawalEvidence: {
            removalKind: 'consent-withdrawal',
            hostDeletionConfirmed: true,
            privateOriginalDeletionConfirmed: false,
            evidenceRevision: 'host-delete-1'
        }
    }
);
assert.equal(consentWithdrawalWithoutOriginalDeletion.ok, false);
assert.match(
    consentWithdrawalWithoutOriginalDeletion.problems.join('\n'),
    /requires confirmed deletion of both hosted derivatives and the private original/
);

const athleteExclusionWithdrawal = transitionGalleryUpload(
    withdrawalPending.draft,
    transitionRequest('withdrawn', 8, '8'),
    {
        withdrawalEvidence: {
            removalKind: 'athlete-exclusion',
            hostDeletionConfirmed: true,
            privateOriginalDeletionConfirmed: false,
            evidenceRevision: 'athlete-exclusion-1'
        }
    }
);
assert.equal(athleteExclusionWithdrawal.ok, true);
assert.equal(
    athleteExclusionWithdrawal.draft.withdrawalEvidence.removalKind,
    'athlete-exclusion'
);

const withdrawn = transitionGalleryUpload(
    withdrawalPending.draft,
    transitionRequest('withdrawn', 8, '0'),
    {
        withdrawalEvidence: {
            removalKind: 'consent-withdrawal',
            hostDeletionConfirmed: true,
            privateOriginalDeletionConfirmed: true,
            evidenceRevision: 'host-delete-1'
        }
    }
);
assert.equal(withdrawn.ok, true);
assert.equal(withdrawn.draft.state, 'withdrawn');
assert.equal(withdrawn.draft.stateVersion, 9);
assert.deepEqual(withdrawn.draft.withdrawalEvidence, {
    removalKind: 'consent-withdrawal',
    hostDeletionConfirmed: true,
    privateOriginalDeletionConfirmed: true,
    evidenceRevision: 'host-delete-1'
});
assert.equal(Object.isFrozen(withdrawn.draft.withdrawalEvidence), true);
assert.deepEqual(validateGalleryUploadDraft(withdrawn.draft), []);

const republishWithdrawn = transitionGalleryUpload(
    withdrawn.draft,
    transitionRequest('published', 9, '1'),
    validContext
);
assert.equal(republishWithdrawn.ok, false);
assert.match(republishWithdrawn.problems.join('\n'), /cannot transition from "withdrawn"/);

const directPublish = transitionGalleryUpload(
    validDraft,
    transitionRequest('published', 0, '2'),
    validContext
);
assert.equal(directPublish.ok, false);
assert.match(directPublish.problems.join('\n'), /cannot transition from "draft"/);

const rejected = transitionGalleryUpload(
    privateReview.draft,
    transitionRequest('rejected', 2, '3')
);
assert.equal(rejected.ok, true);
const rejectedPublication = createPublicManifestItems(rejected.draft, validContext);
assert.equal(rejectedPublication.ok, false);
assert.deepEqual(rejectedPublication.itemsBySite, {});

const withdrawnPublication = createPublicManifestItems(withdrawn.draft, validContext);
assert.equal(withdrawnPublication.ok, false);
assert.deepEqual(withdrawnPublication.itemsBySite, {});

// An individual item can be withdrawn before anything was hosted. The host
// evidence records the verified absence of derivatives, including this
// zero-object case; it never makes a false claim that an object was deleted.
const prePublicWithdrawalPending = transitionGalleryUpload(
    privateReview.draft,
    transitionRequest('withdrawal-pending', 2, '5')
);
assert.equal(prePublicWithdrawalPending.ok, true);
const prePublicWithdrawn = transitionGalleryUpload(
    prePublicWithdrawalPending.draft,
    transitionRequest('withdrawn', 3, '6'),
    {
        withdrawalEvidence: {
            removalKind: 'editorial-removal',
            hostDeletionConfirmed: true,
            privateOriginalDeletionConfirmed: false,
            evidenceRevision: 'verified-zero-hosted-objects-1'
        }
    }
);
assert.equal(prePublicWithdrawn.ok, true);
assert.equal(prePublicWithdrawn.draft.state, 'withdrawn');
assert.equal(
    transitionGalleryUpload(rejected.draft, transitionRequest('draft', 3, '4')).ok,
    true
);

console.log('Gallery upload contract tests passed.');
