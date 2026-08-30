import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// The upload contract deliberately resolves the public Gallery contract from
// globalThis so that the same files work in both Node and a browser. Load the
// public contract first to preserve that existing boundary.
const galleryContract = require('../../gallery-contract.js');
const uploadContract = require('../../gallery-upload-contract.js');

const schemaVersion = '1.0';
const siteModes = Object.freeze(['family', 'everyone']);
const targetPaths = Object.freeze({
    family: 'gallery-data/family.json',
    everyone: 'gallery-data/everyone.json'
});
const publicItemFields = Object.freeze([
    'id',
    'type',
    'title',
    'caption',
    'alt',
    'raceDate',
    'raceEvent',
    'raceDistance',
    'sourceUrl',
    'thumbnailUrl',
    'featured',
    'athleteIds'
]);
const candidatePackageFields = Object.freeze([
    'schemaVersion',
    'operationId',
    'draft',
    'context',
    'editorialPosition'
]);
const candidateContextFields = Object.freeze([
    'consentRevision',
    'suppressionRevision',
    'suppressionDocument',
    'pendingHiddenAthleteIds',
    'siteCatalogs',
    'approvedDerivativeOrigin',
    'approvedDerivatives'
]);
const manifestDocumentFields = Object.freeze(['schemaVersion', 'items']);
const currentStateFields = Object.freeze([
    'catalogSnapshot',
    'manifestsBySite',
    'replayReceipt'
]);
const replayReceiptFields = Object.freeze([
    'schemaVersion',
    'operationId',
    'targetRelativePath',
    'itemId',
    'manifestSha256'
]);
const operationIdPattern = /^promotion_[A-Za-z0-9_-]{16,119}$/;
const sha256RevisionPattern = /^sha256:[a-f0-9]{64}$/;

export const galleryManifestCandidateSchemaVersion = schemaVersion;
export const galleryManifestPublicItemFields = publicItemFields;

/**
 * Build one candidate Gallery manifest without reading files or calling a
 * service. The only possible target is derived from draft.siteModes[0].
 */
export function prepareGalleryManifestCandidate(candidatePackage, currentState) {
    validateCandidatePackageShape(candidatePackage);
    validateCurrentStateShape(currentState);

    const { draft, context } = candidatePackage;
    const publicationProblems = uploadContract.validateGalleryUploadPublication(
        draft,
        context
    );
    if (!Array.isArray(publicationProblems) || publicationProblems.length > 0) {
        throw new Error(
            `Gallery manifest candidate failed the publication contract: ${
                Array.isArray(publicationProblems)
                    ? publicationProblems.join(' ')
                    : 'the publication validator returned an invalid result.'
            }`
        );
    }

    if (draft.state !== 'candidate-public') {
        throw new Error('Gallery manifest automation requires state "candidate-public".');
    }
    if (draft.itemInput.type !== 'photo' || draft.manifestItem.type !== 'photo') {
        throw new Error('Gallery manifest automation currently accepts photographs only.');
    }

    // validateGalleryUploadPublication already rejects every shape except one
    // inherited site. Keep the explicit assertion because the original D1
    // column constraint is wider than the application contract.
    if (
        !Array.isArray(draft.siteModes) ||
        draft.siteModes.length !== 1 ||
        !siteModes.includes(draft.siteModes[0])
    ) {
        throw new Error('Gallery manifest target must be one inherited site mode.');
    }

    const targetSite = draft.siteModes[0];
    const otherSite = targetSite === 'family' ? 'everyone' : 'family';
    const targetRelativePath = targetPaths[targetSite];

    validateFreshCatalog(candidatePackage, currentState.catalogSnapshot, targetSite);

    const manifestsBySite = cloneAndValidateManifests(currentState.manifestsBySite);
    validateExistingSharedItems(manifestsBySite);

    const publicCopies = uploadContract.createPublicManifestItems(draft, context);
    if (
        publicCopies?.ok !== true ||
        Object.keys(publicCopies.itemsBySite || {}).length !== 1 ||
        !Object.hasOwn(publicCopies.itemsBySite, targetSite)
    ) {
        throw new Error('Gallery manifest public-item projection did not preserve one inherited site.');
    }
    const publicItem = pickPublicItem(publicCopies.itemsBySite[targetSite]);
    assertExactPublicItem(publicItem);

    const otherItem = manifestsBySite[otherSite].items.find(item => item.id === publicItem.id);
    if (otherItem) {
        const relationship = sameJson(otherItem, publicItem) ? 'identical' : 'different';
        throw new Error(
            `Gallery manifest item "${publicItem.id}" already exists in the other site mode with ${relationship} content; automated uploads cannot create shared items.`
        );
    }

    const targetDocument = manifestsBySite[targetSite];
    const existingIndex = targetDocument.items.findIndex(item => item.id === publicItem.id);
    if (existingIndex >= 0) {
        if (!sameJson(targetDocument.items[existingIndex], publicItem)) {
            throw new Error(
                `Gallery manifest item "${publicItem.id}" already exists in the inherited site with different content.`
            );
        }

        const manifestText = renderCanonicalGalleryManifest(targetDocument);
        const manifestSha256 = sha256Revision(manifestText);
        validateReplayReceipt(
            currentState.replayReceipt,
            candidatePackage.operationId,
            targetRelativePath,
            publicItem.id,
            manifestSha256
        );

        return deepFreeze({
            changed: false,
            targetRelativePath,
            itemId: publicItem.id,
            manifestText,
            manifestSha256,
            receipt: makeReplayReceipt(
                candidatePackage.operationId,
                targetRelativePath,
                publicItem.id,
                manifestSha256
            )
        });
    }

    const insertionIndex = candidatePackage.editorialPosition === null
        ? targetDocument.items.length
        : candidatePackage.editorialPosition;
    if (insertionIndex > targetDocument.items.length) {
        throw new Error(
            `Gallery manifest editorialPosition ${insertionIndex} is outside the current item range 0-${targetDocument.items.length}.`
        );
    }

    const nextItems = targetDocument.items.map(cloneJson);
    nextItems.splice(insertionIndex, 0, cloneJson(publicItem));
    const nextDocument = {
        schemaVersion: galleryContract.schemaVersion,
        items: nextItems
    };
    const nextProblems = galleryContract.validateGalleryDocument(nextDocument);
    if (nextProblems.length > 0) {
        throw new Error(
            `Generated Gallery manifest is invalid: ${nextProblems.join(' ')}`
        );
    }

    const nextManifests = {
        ...manifestsBySite,
        [targetSite]: nextDocument
    };
    validateExistingSharedItems(nextManifests);

    const manifestText = renderCanonicalGalleryManifest(nextDocument);
    const manifestSha256 = sha256Revision(manifestText);

    return deepFreeze({
        changed: true,
        targetRelativePath,
        itemId: publicItem.id,
        manifestText,
        manifestSha256,
        receipt: makeReplayReceipt(
            candidatePackage.operationId,
            targetRelativePath,
            publicItem.id,
            manifestSha256
        )
    });
}

export function renderCanonicalGalleryManifest(documentValue) {
    const problems = galleryContract.validateGalleryDocument(documentValue);
    if (problems.length > 0) {
        throw new Error(`Cannot render an invalid Gallery manifest: ${problems.join(' ')}`);
    }
    rejectUnsupportedKeys(
        documentValue,
        manifestDocumentFields,
        'Gallery manifest document'
    );
    return `${JSON.stringify(documentValue, null, 2)}\n`;
}

function validateCandidatePackageShape(value) {
    requireExactObject(value, candidatePackageFields, 'Gallery manifest candidate package');

    if (value.schemaVersion !== schemaVersion) {
        throw new Error(`Gallery manifest candidate schemaVersion must be exactly "${schemaVersion}".`);
    }
    if (!operationIdPattern.test(stringValue(value.operationId))) {
        throw new Error(
            'Gallery manifest candidate operationId must be an opaque promotion_ identifier.'
        );
    }
    requireExactObject(value.context, candidateContextFields, 'Gallery manifest candidate context');

    if (
        value.editorialPosition !== null &&
        (!Number.isSafeInteger(value.editorialPosition) || value.editorialPosition < 0)
    ) {
        throw new Error(
            'Gallery manifest editorialPosition must be null or a non-negative safe integer.'
        );
    }
}

function validateCurrentStateShape(value) {
    if (!isPlainObject(value)) {
        throw new Error('Gallery manifest current state must be an object.');
    }
    rejectUnsupportedKeys(value, currentStateFields, 'Gallery manifest current state');
    for (const required of ['catalogSnapshot', 'manifestsBySite']) {
        if (!Object.hasOwn(value, required)) {
            throw new Error(`Gallery manifest current state is missing "${required}".`);
        }
    }
}

function validateFreshCatalog(candidatePackage, snapshot, targetSite) {
    if (!isPlainObject(snapshot) || !isPlainObject(snapshot.sites)) {
        throw new Error('The current Gallery catalog snapshot is unavailable.');
    }
    if (snapshot.schemaVersion !== schemaVersion) {
        throw new Error('The current Gallery catalog snapshot uses an unsupported schema.');
    }

    const { draft, context } = candidatePackage;
    if (draft.exportBundleId !== snapshot.exportBundleId) {
        throw new Error('Gallery manifest candidate export bundle is stale.');
    }
    if (draft.sourceRevision !== snapshot.sourceRevision) {
        throw new Error('Gallery manifest candidate source revision is stale.');
    }
    if (
        draft.suppressionRevision !== snapshot.suppressionRevision ||
        context.suppressionRevision !== snapshot.suppressionRevision
    ) {
        throw new Error('Gallery manifest candidate suppression revision is stale.');
    }
    if (!sameJson(context.suppressionDocument, snapshot.suppressionDocument)) {
        throw new Error('Gallery manifest candidate suppression document is stale.');
    }

    if (!isPlainObject(context.siteCatalogs) || !isPlainObject(snapshot.sites[targetSite])) {
        throw new Error('Gallery manifest candidate inherited site catalog is unavailable.');
    }

    for (const [siteMode, suppliedCatalog] of Object.entries(context.siteCatalogs)) {
        if (!siteModes.includes(siteMode)) {
            throw new Error('Gallery manifest candidate contains an unsupported site catalog.');
        }
        if (!sameJson(suppliedCatalog, snapshot.sites[siteMode]?.catalog)) {
            throw new Error(`Gallery manifest candidate site catalog is stale for "${siteMode}".`);
        }
    }

    if (!Object.hasOwn(context.siteCatalogs, targetSite)) {
        throw new Error('Gallery manifest candidate is missing its inherited site catalog.');
    }
}

function cloneAndValidateManifests(value) {
    requireExactObject(value, siteModes, 'Gallery manifests by site');

    return Object.fromEntries(siteModes.map(siteMode => {
        const documentValue = value[siteMode];
        requireExactObject(
            documentValue,
            manifestDocumentFields,
            `Gallery ${siteMode} manifest`
        );
        const problems = galleryContract.validateGalleryDocument(documentValue);
        if (problems.length > 0) {
            throw new Error(`Gallery ${siteMode} manifest is invalid: ${problems.join(' ')}`);
        }
        return [siteMode, cloneJson(documentValue)];
    }));
}

function validateExistingSharedItems(manifestsBySite) {
    const everyoneById = new Map(
        manifestsBySite.everyone.items.map(item => [item.id, item])
    );
    for (const familyItem of manifestsBySite.family.items) {
        const everyoneItem = everyoneById.get(familyItem.id);
        if (everyoneItem && !sameJson(familyItem, everyoneItem)) {
            throw new Error(
                `Gallery shared item "${familyItem.id}" differs between site modes.`
            );
        }
    }
}

function pickPublicItem(value) {
    if (!isPlainObject(value)) {
        throw new Error('Gallery manifest public-item projection is not an object.');
    }
    const result = {};
    for (const field of publicItemFields) {
        if (!Object.hasOwn(value, field)) {
            throw new Error(`Gallery manifest public item is missing "${field}".`);
        }
        result[field] = cloneJson(value[field]);
    }
    return result;
}

function assertExactPublicItem(value) {
    requireExactObject(value, publicItemFields, 'Gallery manifest public item');
    const problems = galleryContract.validateGalleryDocument({
        schemaVersion: galleryContract.schemaVersion,
        items: [value]
    });
    if (problems.length > 0) {
        throw new Error(`Gallery manifest public item is invalid: ${problems.join(' ')}`);
    }
}

function validateReplayReceipt(
    receipt,
    operationId,
    targetRelativePath,
    itemId,
    manifestSha256
) {
    if (receipt === undefined || receipt === null) {
        throw new Error(
            `Gallery manifest item "${itemId}" already exists; exact replay requires matching operation evidence.`
        );
    }
    requireExactObject(receipt, replayReceiptFields, 'Gallery manifest replay receipt');
    if (
        receipt.schemaVersion !== schemaVersion ||
        receipt.operationId !== operationId ||
        receipt.targetRelativePath !== targetRelativePath ||
        receipt.itemId !== itemId ||
        receipt.manifestSha256 !== manifestSha256 ||
        !sha256RevisionPattern.test(stringValue(receipt.manifestSha256))
    ) {
        throw new Error('Gallery manifest replay receipt does not match this exact operation.');
    }
}

function makeReplayReceipt(operationId, targetRelativePath, itemId, manifestSha256) {
    return {
        schemaVersion,
        operationId,
        targetRelativePath,
        itemId,
        manifestSha256
    };
}

function sha256Revision(text) {
    return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function requireExactObject(value, expectedFields, label) {
    if (!isPlainObject(value)) {
        throw new Error(`${label} must be an object.`);
    }
    rejectUnsupportedKeys(value, expectedFields, label);
    for (const field of expectedFields) {
        if (!Object.hasOwn(value, field)) {
            throw new Error(`${label} is missing "${field}".`);
        }
    }
}

function rejectUnsupportedKeys(value, allowedFields, label) {
    const allowed = new Set(allowedFields);
    const unsupported = Object.keys(value).find(key => !allowed.has(key));
    if (unsupported) {
        throw new Error(`${label} contains unsupported field "${unsupported}".`);
    }
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function sameJson(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function stringValue(value) {
    return typeof value === 'string' ? value : '';
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value, seen = new Set()) {
    if (value === null || typeof value !== 'object' || seen.has(value)) {
        return value;
    }
    seen.add(value);
    for (const child of Object.values(value)) {
        deepFreeze(child, seen);
    }
    return Object.freeze(value);
}
