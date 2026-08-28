import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

import adminWorker, { handleAdminRequest } from '../gallery-admin/src/admin-worker.js';
import { publishedSiteEntries } from '../scripts/published-site-entries.mjs';

const adminOrigin = 'https://synthetic-phase-c-admin.example';
const fixedNow = Date.UTC(2026, 7, 27, 16, 0, 0);
const sessionSecret = 'synthetic-phase-c-session-secret-0123456789abcdef';
const privateEvidenceSentinel = 'private-evidence:synthetic-guardian-attestation';
const providerSentinel = 'provider-upload-private-sentinel';
const privateKeySentinels = [
    'private-originals/phase-c/',
    'private-originals/v1/',
    'derivative-staging/v1/'
];
const familySiteMode = 'family';
const everyoneSiteMode = 'everyone';
const jsonResponses = [];
const responseHeaders = [];

const manifestUrls = [
    new URL('../gallery-data/family.json', import.meta.url),
    new URL('../gallery-data/everyone.json', import.meta.url)
];
const manifestBaselines = await Promise.all(manifestUrls.map(url => readFile(url, 'utf8')));
for (const baseline of manifestBaselines) {
    assert.deepEqual(JSON.parse(baseline), { schemaVersion: '1.0', items: [] });
}

const migrationSources = await Promise.all([
    readFile(
        new URL('../gallery-admin/migrations/0001_private_gallery.sql', import.meta.url),
        'utf8'
    ),
    readFile(
        new URL('../gallery-admin/migrations/0002_private_uploads.sql', import.meta.url),
        'utf8'
    ),
    readFile(
        new URL('../gallery-admin/migrations/0003_private_original_v1_keys.sql', import.meta.url),
        'utf8'
    )
]);
const sqlite = new DatabaseSync(':memory:');
for (const migrationSource of migrationSources) {
    sqlite.exec(migrationSource);
}
const d1 = createSqliteD1(sqlite);
const originals = createPrivateOriginalsBucket(providerSentinel);
const env = {
    ADMIN_ORIGIN: adminOrigin,
    OWNER_IDENTITIES: 'subject:synthetic-owner',
    AUTOMATION_IDENTITIES: 'subject:synthetic-automation',
    SESSION_SECRET: sessionSecret,
    DB: d1,
    PRIVATE_ORIGINALS: originals
};
const identities = new Map([
    ['owner', { type: 'browser', subject: 'synthetic-owner' }],
    ['service', { type: 'service', subject: 'synthetic-automation' }],
    ['wrong-owner', { type: 'browser', subject: 'synthetic-other-owner' }]
]);
const verifyAccessIdentity = async request =>
    identities.get(request.headers.get('X-Synthetic-Identity')) || null;
let currentNow = fixedNow;
const browserSessions = new Map();

// Worker-level identity types remain separate even before the signed browser
// session is issued.
assert.equal((await areaRequest('/api/browser/session')).status, 403);
assert.equal((await areaRequest('/api/browser/session', { identity: 'service' })).status, 403);
assert.equal((await adminRequest('/api/service/health', { identity: 'owner' })).status, 403);
assert.equal((await adminRequest('/api/service/health', { identity: 'service' })).status, 200);
assert.equal((await adminRequest('/api/browser/health', { identity: 'owner' })).status, 200);
assert.equal((await areaRequest('/api/browser/catalog', { identity: 'owner' })).status, 403);
assert.equal((await areaRequest('/api/browser/catalog', {
    identity: 'owner',
    headers: {
        'Cf-Access-Client-Id': `${providerSentinel}.access`,
        'Cf-Access-Client-Secret': providerSentinel
    }
})).status, 403);

// Every area-scoped browser route accepts exactly one explicit site query. A
// missing, unsupported, duplicate, or extended query is not interpreted.
assert.equal((await adminRequest('/', { identity: 'owner' })).status, 404);
assert.equal((await adminRequest('/api/browser/session', { identity: 'owner' })).status, 404);
assert.equal((await adminRequest('/api/browser/session?site=both', {
    identity: 'owner'
})).status, 404);
assert.equal((await adminRequest('/api/browser/session?site=family&site=everyone', {
    identity: 'owner'
})).status, 404);
assert.equal((await adminRequest('/api/browser/session?site=family&source=gallery', {
    identity: 'owner'
})).status, 404);
assert.equal((await adminRequest('/api/browser/catalog', { identity: 'owner' })).status, 404);
assert.equal((await adminRequest('/api/browser/health?site=family', {
    identity: 'owner'
})).status, 404);
assert.equal((await areaRequest('/', { identity: 'owner' })).status, 200);

for (const siteMode of [familySiteMode, everyoneSiteMode]) {
    const sessionResponse = await areaRequest('/api/browser/session', {
        identity: 'owner',
        siteMode
    });
    assert.equal(sessionResponse.status, 200);
    const sessionBody = await responseJson(sessionResponse);
    const setCookie = sessionResponse.headers.get('Set-Cookie');
    assert.match(
        setCookie || '',
        new RegExp(`^__Host-gallery_admin_session_${siteMode}=`)
    );
    assert.match(setCookie || '', /; Secure; HttpOnly; SameSite=Strict;/);
    browserSessions.set(siteMode, {
        cookie: setCookie.split(';', 1)[0],
        csrfToken: sessionBody.csrfToken
    });
}
assert.notEqual(
    browserSessions.get(familySiteMode).csrfToken,
    browserSessions.get(everyoneSiteMode).csrfToken
);

// A signed session is scoped to the area that issued it. Even the other valid
// area cannot accept that cookie.
assert.equal((await areaRequest('/api/browser/catalog', {
    identity: 'owner',
    siteMode: everyoneSiteMode,
    headers: { Cookie: browserSessions.get(familySiteMode).cookie }
})).status, 403);
assert.equal((await areaRequest('/api/browser/catalog', {
    identity: 'owner',
    siteMode: familySiteMode,
    headers: { Cookie: browserSessions.get(everyoneSiteMode).cookie }
})).status, 403);

// A valid cookie is not enough for a mutation: the matching CSRF token and
// same-origin browser evidence are independently required.
assert.equal((await areaRequest('/api/browser/drafts', {
    method: 'POST',
    identity: 'owner',
    session: true,
    csrf: false,
    json: {}
})).status, 403);
assert.equal((await areaRequest('/api/browser/drafts', {
    method: 'POST',
    identity: 'owner',
    session: true,
    json: {},
    headers: { Origin: 'https://wrong-origin.example' }
})).status, 403);

const catalogResponse = await areaRequest('/api/browser/catalog', {
    identity: 'owner',
    session: true
});
assert.equal(catalogResponse.status, 200);
const catalog = await responseJson(catalogResponse);
assert.deepEqual(Object.keys(catalog).sort(), [
    'blockedAthleteIds',
    'exportBundleId',
    'schemaVersion',
    'sites',
    'sourceRevision',
    'suppressionRevision'
]);
assert.deepEqual(Object.keys(catalog.sites), [familySiteMode]);
assert.ok(catalog.sites.family.races.length > 0);
assert.ok(catalog.sites.family.roster.length >= 3);
assert.ok(catalog.sites.family.results.length > 0);
assert.ok(catalog.blockedAthleteIds.every(value => typeof value === 'string'));
assert.doesNotMatch(JSON.stringify(catalog), /privateEvidence|objectKey|providerUpload|reason/i);

const familyCatalog = catalog.sites.family;
const selectedResult = familyCatalog.results.find(result =>
    familyCatalog.races.some(race => sameRace(race, result)) &&
    familyCatalog.roster.some(entry => entry.athleteId === result.athleteId)
);
assert.ok(selectedResult, 'The generated catalog must expose at least one current result choice.');
const selectedRace = {
    raceDate: selectedResult.raceDate,
    raceEvent: selectedResult.raceEvent,
    raceDistance: selectedResult.raceDistance
};
const currentAthleteIds = familyCatalog.roster
    .map(entry => entry.athleteId)
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 3);
assert.equal(currentAthleteIds.length, 3);

const everyoneCatalogResponse = await areaRequest('/api/browser/catalog', {
    identity: 'owner',
    session: true,
    siteMode: everyoneSiteMode
});
assert.equal(everyoneCatalogResponse.status, 200);
const everyoneCatalogDocument = await responseJson(everyoneCatalogResponse);
assert.deepEqual(Object.keys(everyoneCatalogDocument.sites), [everyoneSiteMode]);
assert.equal(
    everyoneCatalogDocument.exportBundleId,
    catalog.exportBundleId
);
assert.equal(
    everyoneCatalogDocument.suppressionRevision,
    catalog.suppressionRevision
);
const everyoneCatalog = everyoneCatalogDocument.sites.everyone;
const selectedEveryoneResult = everyoneCatalog.results.find(result =>
    everyoneCatalog.races.some(race => sameRace(race, result)) &&
    everyoneCatalog.roster.some(entry => entry.athleteId === result.athleteId)
);
assert.ok(
    selectedEveryoneResult,
    'The generated Everyone catalog must expose at least one current result choice.'
);
const selectedEveryoneRace = {
    raceDate: selectedEveryoneResult.raceDate,
    raceEvent: selectedEveryoneResult.raceEvent,
    raceDistance: selectedEveryoneResult.raceDistance
};

const consentWithGuardian = {
    publicUseConfirmed: true,
    containsMinors: true,
    guardianApprovalConfirmed: true,
    privateEvidenceReference: privateEvidenceSentinel
};
const consentWithoutGuardian = {
    ...consentWithGuardian,
    guardianApprovalConfirmed: false
};

// Consent for a minor fails closed until guardian approval is explicitly
// recorded. No draft row is created by the rejected request.
const missingGuardianResponse = await createDraftRequest(
    makeItem('synthetic-missing-guardian', [currentAthleteIds[0]]),
    consentWithoutGuardian
);
assert.equal(missingGuardianResponse.status, 400);
assert.match(JSON.stringify(await responseJson(missingGuardianResponse)), /guardian/i);
assert.equal(countRows(sqlite, 'gallery_drafts'), 0);

// The site area comes from the signed URL/session context, never from owner
// supplied JSON. A forged destination field makes the request invalid.
const forgedCreateResponse = await areaRequest('/api/browser/drafts', {
    method: 'POST',
    identity: 'owner',
    session: true,
    json: {
        siteModes: [everyoneSiteMode],
        itemInput: makeItem('synthetic-forged-destination', [currentAthleteIds[0]]),
        consent: consentWithGuardian
    }
});
assert.equal(forgedCreateResponse.status, 400);
assert.equal(countRows(sqlite, 'gallery_drafts'), 0);

const everyoneCreatedResponse = await createDraftRequest(
    makeItem(
        'synthetic-everyone-only',
        [selectedEveryoneResult.athleteId],
        selectedEveryoneRace
    ),
    consentWithGuardian,
    everyoneSiteMode
);
assert.equal(everyoneCreatedResponse.status, 201);
const everyoneDraft = (await responseJson(everyoneCreatedResponse)).draft;
assert.deepEqual(everyoneDraft.siteModes, [everyoneSiteMode]);

const everyoneListResponse = await areaRequest('/api/browser/drafts', {
    identity: 'owner',
    session: true,
    siteMode: everyoneSiteMode
});
assert.equal(everyoneListResponse.status, 200);
assert.ok((await responseJson(everyoneListResponse)).drafts.some(
    draft => draft.draftId === everyoneDraft.draftId
));
const familyBeforeMainResponse = await areaRequest('/api/browser/drafts', {
    identity: 'owner',
    session: true
});
assert.equal(familyBeforeMainResponse.status, 200);
assert.ok(!(await responseJson(familyBeforeMainResponse)).drafts.some(
    draft => draft.draftId === everyoneDraft.draftId
));
assert.equal((await areaRequest(`/api/browser/drafts/${everyoneDraft.draftId}`, {
    identity: 'owner',
    session: true
})).status, 404);
const bucketCallsBeforeCrossAreaRead = originals.calls.length;
assert.equal((await areaRequest(
    `/api/browser/drafts/${everyoneDraft.draftId}/original`,
    { identity: 'owner', session: true }
)).status, 404);
assert.equal(originals.calls.length, bucketCallsBeforeCrossAreaRead);

// Cross-area storage routes must stop at the area-bound draft lookup. Their
// requests are otherwise valid, so each 404 specifically proves that the
// Worker did not begin, resume, complete, abort, read, or delete an R2 object.
const crossAreaBytes = syntheticJpeg(128);
const bucketOperationsBeforeCrossAreaStorageRoutes = {
    calls: originals.calls.length,
    abortedUploads: originals.abortedUploadCount
};
const crossAreaBeginResponse = await areaRequest(
    `/api/browser/drafts/${everyoneDraft.draftId}/upload`,
    {
        method: 'POST',
        identity: 'owner',
        session: true,
        json: {
            expectedStateVersion: everyoneDraft.stateVersion,
            fileName: 'synthetic-cross-area-photo.jpg',
            declaredMimeType: 'image/jpeg',
            byteLength: crossAreaBytes.byteLength,
            idempotencyKey: 'cross-area-begin-0001',
            syntheticOnlyConfirmed: true
        }
    }
);
assert.equal(crossAreaBeginResponse.status, 404);
const crossAreaPartResponse = await areaRequest(
    `/api/browser/drafts/${everyoneDraft.draftId}/upload-parts/1`,
    {
        method: 'PUT',
        identity: 'owner',
        session: true,
        rawBody: crossAreaBytes,
        headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(crossAreaBytes.byteLength),
            'X-Chunk-SHA256': sha256(crossAreaBytes)
        }
    }
);
assert.equal(crossAreaPartResponse.status, 404);
const crossAreaCompletionResponse = await areaRequest(
    `/api/browser/drafts/${everyoneDraft.draftId}/upload-completion`,
    {
        method: 'POST',
        identity: 'owner',
        session: true,
        json: {
            expectedStateVersion: everyoneDraft.stateVersion,
            idempotencyKey: 'cross-area-complete-0001'
        }
    }
);
assert.equal(crossAreaCompletionResponse.status, 404);
assert.deepEqual(
    {
        calls: originals.calls.length,
        abortedUploads: originals.abortedUploadCount
    },
    bucketOperationsBeforeCrossAreaStorageRoutes
);

const createdResponse = await createDraftRequest(
    makeItem('synthetic-phase-c-main', currentAthleteIds.slice(0, 2)),
    consentWithGuardian
);
assert.equal(createdResponse.status, 201);
let mainDraft = (await responseJson(createdResponse)).draft;
assert.equal(mainDraft.state, 'draft');
assert.equal(mainDraft.stateVersion, 0);
assert.deepEqual(mainDraft.siteModes, [familySiteMode]);
assert.deepEqual(mainDraft.itemInput.athleteIds, currentAthleteIds.slice(0, 2));
assert.equal(mainDraft.consent.containsMinors, true);
assert.equal(mainDraft.consent.guardianApprovalConfirmed, true);
assert.equal(JSON.stringify(mainDraft).includes(privateEvidenceSentinel), false);
const mainDraftId = mainDraft.draftId;

const listResponse = await areaRequest('/api/browser/drafts', {
    identity: 'owner',
    session: true
});
assert.equal(listResponse.status, 200);
assert.ok((await responseJson(listResponse)).drafts.some(draft => draft.draftId === mainDraftId));
const getResponse = await areaRequest(`/api/browser/drafts/${mainDraftId}`, {
    identity: 'owner',
    session: true
});
assert.equal(getResponse.status, 200);
assert.equal((await responseJson(getResponse)).draft.draftId, mainDraftId);

// Editing uses item-revision compare-and-swap. The current catalog tags are
// preserved in the requested order; a stale editor cannot overwrite them.
const updatePayload = {
    expectedItemRevision: mainDraft.itemRevision,
    idempotencyKey: 'edit-main-draft-000001',
    itemInput: {
        ...mainDraft.itemInput,
        caption: 'Synthetic Phase C caption after owner review.',
        athleteIds: [...mainDraft.itemInput.athleteIds].reverse()
    },
    consent: consentWithGuardian
};
const forgedUpdateResponse = await areaRequest(`/api/browser/drafts/${mainDraftId}`, {
    method: 'PUT',
    identity: 'owner',
    session: true,
    json: {
        ...updatePayload,
        siteModes: [everyoneSiteMode]
    }
});
assert.equal(forgedUpdateResponse.status, 400);

const updateResponse = await areaRequest(`/api/browser/drafts/${mainDraftId}`, {
    method: 'PUT',
    identity: 'owner',
    session: true,
    json: updatePayload
});
assert.equal(updateResponse.status, 200);
mainDraft = (await responseJson(updateResponse)).draft;
assert.deepEqual(mainDraft.itemInput.athleteIds, [...currentAthleteIds.slice(0, 2)].reverse());
assert.notEqual(mainDraft.itemRevision, updatePayload.expectedItemRevision);
const updateReplay = await areaRequest(`/api/browser/drafts/${mainDraftId}`, {
    method: 'PUT',
    identity: 'owner',
    session: true,
    json: updatePayload
});
assert.equal(updateReplay.status, 200);
assert.equal((await responseJson(updateReplay)).replayed, true);
const staleEdit = await areaRequest(`/api/browser/drafts/${mainDraftId}`, {
    method: 'PUT',
    identity: 'owner',
    session: true,
    json: {
        ...updatePayload,
        idempotencyKey: 'edit-main-stale-000001'
    }
});
assert.equal(staleEdit.status, 409);

// A current pending exclusion is a hard gate even though the static catalog
// snapshot itself remains unchanged.
insertPendingExclusion(sqlite, currentAthleteIds[2], catalog.suppressionRevision);
const pendingResponse = await createDraftRequest(
    makeItem('synthetic-pending-exclusion', [currentAthleteIds[2]]),
    consentWithGuardian
);
assert.equal(pendingResponse.status, 400);
assert.match(JSON.stringify(await responseJson(pendingResponse)), /suppression|excluded|blocked/i);

// The currently generated suppression list is empty. The same browser route
// nevertheless fails closed for a non-current/suppressed tag, and this branch
// becomes an exact static-suppression assertion automatically when a blocked ID
// exists in a future checked-in snapshot.
const unavailableAthleteId = catalog.blockedAthleteIds[0] || 'synthetic-hidden-athlete';
const suppressedResponse = await createDraftRequest(
    makeItem('synthetic-suppressed-tag', [unavailableAthleteId]),
    consentWithGuardian
);
assert.equal(suppressedResponse.status, 400);
assert.match(JSON.stringify(await responseJson(suppressedResponse)), /suppression|catalog|athlete/i);

// A draft tied to a no-longer-current export revision cannot start an upload.
const staleDraftResponse = await createDraftRequest(
    makeItem('synthetic-stale-source', [currentAthleteIds[0]]),
    consentWithGuardian
);
assert.equal(staleDraftResponse.status, 201);
const staleDraft = (await responseJson(staleDraftResponse)).draft;
sqlite.prepare(
    'UPDATE gallery_drafts SET export_bundle_id = ?, item_revision = ?, updated_at = ? ' +
    'WHERE draft_id = ?'
).run(
    'stale-export-bundle-v0',
    'item_stale_export_revision_0001',
    new Date(currentNow + 1).toISOString(),
    staleDraft.draftId
);
const staleBegin = await beginUpload(staleDraft.draftId, 0, 128, 'stale-upload-start-0001');
assert.equal(staleBegin.status, 409);
assert.equal((await responseJson(staleBegin)).error, 'stale-or-blocked');

// Begin a two-part upload. Only the safe progress contract is returned; the R2
// object key and multipart upload ID stay entirely server-side.
const partSize = 5 * 1024 * 1024;
const mainBytes = syntheticJpeg(partSize + 257);
const beginResponse = await beginUpload(
    mainDraftId,
    mainDraft.stateVersion,
    mainBytes.byteLength,
    'begin-main-upload-00001'
);
const beginBody = await responseJson(beginResponse);
assert.equal(beginResponse.status, 201, JSON.stringify(beginBody));
assert.equal(beginBody.replayed, false);
assert.equal(beginBody.upload.partCount, 2);
assert.equal(beginBody.upload.partSize, partSize);
assert.equal(beginBody.upload.nextPartNumber, 1);
assertSafeUploadShape(beginBody.upload);
const mainUploadRecord = sqlite.prepare(
    'SELECT upload_session_id AS uploadSessionId, object_key AS objectKey, ' +
    'file_extension AS fileExtension, created_at AS createdAt ' +
    'FROM draft_upload_sessions WHERE draft_id = ?'
).get(mainDraftId);
assert.match(mainUploadRecord.uploadSessionId, /^upload_[a-f0-9]{32}$/);
assert.equal(mainUploadRecord.fileExtension, 'jpg');
const expectedMainObjectKey =
    `private-originals/v1/family/${mainUploadRecord.createdAt.slice(0, 4)}/` +
    `${mainUploadRecord.createdAt.slice(5, 7)}/${mainDraftId}/` +
    `${mainUploadRecord.uploadSessionId}/original.jpg`;
assert.equal(mainUploadRecord.objectKey, expectedMainObjectKey);
assert.ok(originals.calls.some(call =>
    call.operation === 'createMultipartUpload' && call.key === expectedMainObjectKey
));
const beginReplay = await beginUpload(
    mainDraftId,
    mainDraft.stateVersion,
    mainBytes.byteLength,
    'begin-main-upload-00001'
);
assert.equal(beginReplay.status, 200);
assert.equal((await responseJson(beginReplay)).replayed, true);
const beginConflict = await beginUpload(
    mainDraftId,
    mainDraft.stateVersion,
    mainBytes.byteLength + 1,
    'begin-main-upload-00001'
);
assert.equal(beginConflict.status, 409);

const uploadingDraftResponse = await areaRequest(`/api/browser/drafts/${mainDraftId}`, {
    identity: 'owner',
    session: true
});
mainDraft = (await responseJson(uploadingDraftResponse)).draft;
assert.equal(mainDraft.state, 'uploading');
assert.equal(mainDraft.stateVersion, 1);

const partOne = mainBytes.subarray(0, partSize);
const partTwo = mainBytes.subarray(partSize);
assert.equal((await uploadPart(mainDraftId, 2, partTwo)).status, 409);
assert.equal((await uploadPart(mainDraftId, 1, partOne.subarray(0, 10))).status, 400);

// Without Content-Length, the Worker must still enforce the exact part size
// before making any R2 call. Both malformed requests leave the active upload
// resumable at part 1.
const callsBeforeMalformedBodies = originals.calls.length;
assert.equal((await uploadPart(
    mainDraftId,
    1,
    partOne.subarray(0, partOne.byteLength - 1),
    undefined,
    { includeContentLength: false }
)).status, 422);
assert.equal(originals.calls.length, callsBeforeMalformedBodies);
const oversizedPartOne = syntheticJpeg(partOne.byteLength + 1);
assert.equal((await uploadPart(
    mainDraftId,
    1,
    oversizedPartOne,
    undefined,
    { includeContentLength: false }
)).status, 422);
assert.equal(originals.calls.length, callsBeforeMalformedBodies);

// Two simultaneous copies of the same chunk can produce one new write and one
// replay/conflict, but never two ledger rows or skipped progress.
const concurrentPartResponses = await Promise.all([
    uploadPart(mainDraftId, 1, partOne),
    uploadPart(mainDraftId, 1, partOne)
]);
assert.ok(concurrentPartResponses.some(response => response.status === 201));
assert.ok(concurrentPartResponses.every(response => [200, 201, 409].includes(response.status)));
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM draft_upload_parts WHERE part_number = 1'
).get().count, 1);

const resumeResponse = await areaRequest(`/api/browser/drafts/${mainDraftId}/upload`, {
    identity: 'owner',
    session: true
});
assert.equal(resumeResponse.status, 200);
const resumeBody = await responseJson(resumeResponse);
assert.equal(resumeBody.upload.nextPartNumber, 2);
assert.equal(resumeBody.upload.uploadedByteCount, partSize);
assert.equal(resumeBody.upload.uploadedParts.length, 1);

const prematureCompletion = await completeUpload(
    mainDraftId,
    mainDraft.stateVersion,
    'complete-main-upload-001'
);
assert.equal(prematureCompletion.status, 409);
assert.equal((await responseJson(prematureCompletion)).error, 'upload-incomplete');

originals.failNextPartNumber = 2;
assert.equal((await uploadPart(mainDraftId, 2, partTwo)).status, 503);
const afterInterruption = await areaRequest(`/api/browser/drafts/${mainDraftId}/upload`, {
    identity: 'owner',
    session: true
});
assert.equal((await responseJson(afterInterruption)).upload.nextPartNumber, 2);

assert.equal((await uploadPart(
    mainDraftId,
    2,
    partTwo,
    '0'.repeat(64)
)).status, 422);
const partTwoResponse = await uploadPart(
    mainDraftId,
    2,
    partTwo,
    undefined,
    { includeContentLength: false }
);
assert.equal(partTwoResponse.status, 201);
assert.equal((await responseJson(partTwoResponse)).upload.nextPartNumber, 3);
assert.ok(originals.calls.some(call =>
    call.operation === 'uploadPart' && call.receivedUint8Array === true
));
const partTwoReplay = await uploadPart(mainDraftId, 2, partTwo);
assert.equal(partTwoReplay.status, 200);
assert.equal((await responseJson(partTwoReplay)).replayed, true);

const completionResponse = await completeUpload(
    mainDraftId,
    mainDraft.stateVersion,
    'complete-main-upload-001'
);
assert.equal(completionResponse.status, 201);
const completionBody = await responseJson(completionResponse);
assert.equal(completionBody.replayed, false);
assert.equal(completionBody.draft.state, 'private-review');
assert.equal(completionBody.draft.uploadComplete, true);
assert.equal(completionBody.draft.originalByteCount, mainBytes.byteLength);
assert.equal(completionBody.draft.originalSha256, sha256(mainBytes));
const completionReplay = await completeUpload(
    mainDraftId,
    mainDraft.stateVersion,
    'complete-main-upload-001'
);
assert.equal(completionReplay.status, 200);
assert.equal((await responseJson(completionReplay)).replayed, true);
mainDraft = completionBody.draft;

// Private originals can be viewed only through the authenticated Worker. HEAD
// and byte ranges reveal no storage identifiers and carry no-store headers.
assert.equal((await areaRequest(`/api/browser/drafts/${mainDraftId}/original`)).status, 403);
assert.equal((await areaRequest(`/api/browser/drafts/${mainDraftId}/original`, {
    identity: 'service'
})).status, 403);
const previewHead = await areaRequest(`/api/browser/drafts/${mainDraftId}/original`, {
    method: 'HEAD',
    identity: 'owner',
    session: true
});
assert.equal(previewHead.status, 200);
assert.equal(previewHead.headers.get('Content-Length'), String(mainBytes.byteLength));
assert.equal(previewHead.headers.get('Cache-Control'), 'no-store');
const previewRange = await areaRequest(`/api/browser/drafts/${mainDraftId}/original`, {
    identity: 'owner',
    session: true,
    headers: { Range: 'bytes=1-3' }
});
assert.equal(previewRange.status, 206);
assert.equal(previewRange.headers.get('Content-Range'), `bytes 1-3/${mainBytes.byteLength}`);
assert.deepEqual(new Uint8Array(await previewRange.arrayBuffer()), mainBytes.subarray(1, 4));
const previewGet = await areaRequest(`/api/browser/drafts/${mainDraftId}/original`, {
    identity: 'owner',
    session: true
});
assert.equal(previewGet.status, 200);
assert.deepEqual(new Uint8Array(await previewGet.arrayBuffer()), mainBytes);
assert.equal((await areaRequest(`/api/browser/drafts/${mainDraftId}/original`, {
    identity: 'owner',
    session: true,
    headers: { Range: `bytes=${mainBytes.byteLength}-` }
})).status, 416);

// The moderation loop supports approval, return for review, rejection, and a
// deliberate reopen. Each state change is compare-and-swap protected.
assert.equal((await transitionDraft(
    mainDraftId,
    'approved-for-processing',
    mainDraft.stateVersion - 1,
    'approve-main-stale-0001'
)).status, 409);
let transitionResponse = await transitionDraft(
    mainDraftId,
    'approved-for-processing',
    mainDraft.stateVersion,
    'approve-main-draft-0001'
);
assert.equal(transitionResponse.status, 200);
mainDraft = (await responseJson(transitionResponse)).draft;
assert.equal(mainDraft.state, 'approved-for-processing');
const approveReplay = await transitionDraft(
    mainDraftId,
    'approved-for-processing',
    mainDraft.stateVersion - 1,
    'approve-main-draft-0001'
);
assert.equal(approveReplay.status, 200);
assert.equal((await responseJson(approveReplay)).replayed, true);

transitionResponse = await transitionDraft(
    mainDraftId,
    'private-review',
    mainDraft.stateVersion,
    'return-main-review-0001'
);
assert.equal(transitionResponse.status, 200);
mainDraft = (await responseJson(transitionResponse)).draft;
assert.equal(mainDraft.state, 'private-review');
transitionResponse = await transitionDraft(
    mainDraftId,
    'rejected',
    mainDraft.stateVersion,
    'reject-main-draft-0001'
);
assert.equal(transitionResponse.status, 200);
mainDraft = (await responseJson(transitionResponse)).draft;
assert.equal(mainDraft.state, 'rejected');
assert.equal((await areaRequest(`/api/browser/drafts/${mainDraftId}/original`, {
    identity: 'owner',
    session: true
})).status, 404);
transitionResponse = await transitionDraft(
    mainDraftId,
    'draft',
    mainDraft.stateVersion,
    'reopen-main-draft-0001'
);
assert.equal(transitionResponse.status, 200);
mainDraft = (await responseJson(transitionResponse)).draft;
assert.equal(mainDraft.state, 'draft');
assert.equal(mainDraft.uploadComplete, true);

// Signature mismatch is terminal and observable. The fake bucket confirms the
// multipart upload was aborted without exposing its provider ID to the client.
const signatureDraft = await createValidDraft('synthetic-signature-failure', currentAthleteIds[0]);
let failureResponse = await beginUpload(
    signatureDraft.draftId,
    signatureDraft.stateVersion,
    128,
    'begin-signature-bad-001'
);
assert.equal(failureResponse.status, 201);
const invalidJpeg = new Uint8Array(128).fill(0x41);
failureResponse = await uploadPart(signatureDraft.draftId, 1, invalidJpeg);
assert.equal(failureResponse.status, 422);
let failureStatus = await areaRequest(`/api/browser/drafts/${signatureDraft.draftId}/upload`, {
    identity: 'owner',
    session: true
});
assert.equal((await responseJson(failureStatus)).upload.status, 'failed');
assert.ok(originals.abortedUploadCount >= 1);

// Provider size mismatch after multipart completion is rejected and the
// completed private object is deleted.
const sizeDraft = await createValidDraft('synthetic-size-failure', currentAthleteIds[0]);
const smallJpeg = syntheticJpeg(257);
assert.equal((await beginUpload(
    sizeDraft.draftId,
    sizeDraft.stateVersion,
    smallJpeg.byteLength,
    'begin-size-failure-0001'
)).status, 201);
assert.equal((await uploadPart(sizeDraft.draftId, 1, smallJpeg)).status, 201);
originals.truncateNextComplete = true;
failureResponse = await completeUpload(
    sizeDraft.draftId,
    sizeDraft.stateVersion + 1,
    'complete-size-fail-0001'
);
assert.equal(failureResponse.status, 422);
failureStatus = await areaRequest(`/api/browser/drafts/${sizeDraft.draftId}/upload`, {
    identity: 'owner',
    session: true
});
assert.equal((await responseJson(failureStatus)).upload.status, 'failed');

// A same-sized object corrupted between part acceptance and whole-object
// verification also fails closed on its signature.
const corruptDraft = await createValidDraft('synthetic-corrupt-failure', currentAthleteIds[0]);
assert.equal((await beginUpload(
    corruptDraft.draftId,
    corruptDraft.stateVersion,
    smallJpeg.byteLength,
    'begin-corrupt-fail-0001'
)).status, 201);
assert.equal((await uploadPart(corruptDraft.draftId, 1, smallJpeg)).status, 201);
originals.corruptNextComplete = true;
failureResponse = await completeUpload(
    corruptDraft.draftId,
    corruptDraft.stateVersion + 1,
    'complete-corrupt-0001'
);
assert.equal(failureResponse.status, 422);
failureStatus = await areaRequest(`/api/browser/drafts/${corruptDraft.draftId}/upload`, {
    identity: 'owner',
    session: true
});
assert.equal((await responseJson(failureStatus)).upload.status, 'failed');

// The request boundary closes exactly at expiresAt. An expired active session
// cannot upload another byte, and remains active until the cleanup job confirms
// the provider multipart upload has been aborted.
const expiredActiveDraft = await createValidDraft(
    'synthetic-expired-active-request',
    currentAthleteIds[0]
);
const expiredActiveBegin = await beginUpload(
    expiredActiveDraft.draftId,
    expiredActiveDraft.stateVersion,
    128,
    'begin-expired-active-0001'
);
assert.equal(expiredActiveBegin.status, 201);
const expiredActiveDeadline = Date.parse(
    (await responseJson(expiredActiveBegin)).upload.expiresAt
);
assert.ok(Number.isFinite(expiredActiveDeadline));
currentNow = expiredActiveDeadline - 1;
await refreshBrowserSession();
const callsBeforeExpiredActivePart = originals.calls.length;
const expiredActivePart = await uploadPart(
    expiredActiveDraft.draftId,
    1,
    syntheticJpeg(128)
);
assert.equal(expiredActivePart.status, 409);
assert.equal((await responseJson(expiredActivePart)).error, 'invalid-state');
assert.equal(originals.calls.length, callsBeforeExpiredActivePart);
assert.equal(sqlite.prepare(
    'SELECT status FROM draft_upload_sessions WHERE draft_id = ?'
).get(expiredActiveDraft.draftId).status, 'active');
assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS count FROM draft_upload_parts AS part ' +
    'JOIN draft_upload_sessions AS session ' +
    'ON session.upload_session_id = part.upload_session_id ' +
    'WHERE session.draft_id = ?'
).get(expiredActiveDraft.draftId).count, 0);

// The same boundary applies after completion has been claimed. A transient
// provider interruption leaves the session in completing; once its deadline
// passes, a retry cannot HEAD, resume, complete, read, or delete in R2.
const expiredCompletingDraft = await createValidDraft(
    'synthetic-expired-completing-request',
    currentAthleteIds[0]
);
const expiredCompletingBytes = syntheticJpeg(128);
const expiredCompletingBegin = await beginUpload(
    expiredCompletingDraft.draftId,
    expiredCompletingDraft.stateVersion,
    expiredCompletingBytes.byteLength,
    'begin-expired-complete-0001'
);
assert.equal(expiredCompletingBegin.status, 201);
const expiredCompletingDeadline = Date.parse(
    (await responseJson(expiredCompletingBegin)).upload.expiresAt
);
assert.ok(Number.isFinite(expiredCompletingDeadline));
assert.equal((await uploadPart(
    expiredCompletingDraft.draftId,
    1,
    expiredCompletingBytes
)).status, 201);
originals.failNextHead = true;
assert.equal((await completeUpload(
    expiredCompletingDraft.draftId,
    expiredCompletingDraft.stateVersion + 1,
    'complete-expired-retry-0001'
)).status, 503);
assert.equal(sqlite.prepare(
    'SELECT status FROM draft_upload_sessions WHERE draft_id = ?'
).get(expiredCompletingDraft.draftId).status, 'completing');
currentNow = expiredCompletingDeadline - 1;
await refreshBrowserSession();
const callsBeforeExpiredCompletion = originals.calls.length;
const expiredCompletion = await completeUpload(
    expiredCompletingDraft.draftId,
    expiredCompletingDraft.stateVersion + 1,
    'complete-expired-retry-0001'
);
assert.equal(expiredCompletion.status, 409);
assert.equal((await responseJson(expiredCompletion)).error, 'invalid-state');
assert.equal(originals.calls.length, callsBeforeExpiredCompletion);
assert.equal(sqlite.prepare(
    'SELECT status FROM draft_upload_sessions WHERE draft_id = ?'
).get(expiredCompletingDraft.draftId).status, 'completing');

// The hourly scheduled cleanup is the second half of resumability: after the
// request boundary closes, it aborts incomplete multipart uploads and clears
// their private database pointers without touching any completed object.
const cleanupDraft = await createValidDraft('synthetic-expired-upload', currentAthleteIds[0]);
assert.equal((await beginUpload(
    cleanupDraft.draftId,
    cleanupDraft.stateVersion,
    128,
    'begin-expired-upload-001'
)).status, 201);
const abortedBeforeCleanup = originals.abortedUploadCount;
let scheduledCleanup;
adminWorker.scheduled(
    { scheduledTime: currentNow + (25 * 60 * 60 * 1000) },
    env,
    {
        waitUntil(promise) {
            scheduledCleanup = promise;
        }
    }
);
assert.ok(scheduledCleanup instanceof Promise);
await scheduledCleanup;
const expiredStatus = await areaRequest(`/api/browser/drafts/${cleanupDraft.draftId}/upload`, {
    identity: 'owner',
    session: true
});
assert.equal((await responseJson(expiredStatus)).upload.status, 'expired');
assert.equal(originals.abortedUploadCount, abortedBeforeCleanup + 3);
assert.equal(sqlite.prepare(
    'SELECT status FROM draft_upload_sessions WHERE draft_id = ?'
).get(expiredActiveDraft.draftId).status, 'expired');
assert.equal(sqlite.prepare(
    'SELECT status FROM draft_upload_sessions WHERE draft_id = ?'
).get(expiredCompletingDraft.draftId).status, 'expired');
assert.equal(sqlite.prepare(
    'SELECT original_object_key AS objectKey FROM gallery_drafts WHERE draft_id = ?'
).get(cleanupDraft.draftId).objectKey, null);

// Browser-facing material never includes server-owned R2 identifiers, private
// consent evidence, or the session secret.
const serializedResponses = jsonResponses.join('\n');
assert.doesNotMatch(serializedResponses, new RegExp(providerSentinel, 'i'));
for (const sentinel of privateKeySentinels) {
    assert.doesNotMatch(serializedResponses, new RegExp(escapeRegex(sentinel), 'i'));
}
assert.doesNotMatch(serializedResponses, new RegExp(escapeRegex(expectedMainObjectKey), 'i'));
assert.doesNotMatch(serializedResponses, /providerUploadId|uploadSessionId|objectKey/i);
assert.doesNotMatch(serializedResponses, new RegExp(escapeRegex(privateEvidenceSentinel), 'i'));
assert.doesNotMatch(serializedResponses, new RegExp(escapeRegex(sessionSecret), 'i'));
assert.doesNotMatch(responseHeaders.join('\n'), new RegExp(providerSentinel, 'i'));
for (const sentinel of privateKeySentinels) {
    assert.doesNotMatch(
        responseHeaders.join('\n'),
        new RegExp(escapeRegex(sentinel), 'i')
    );
}
assert.doesNotMatch(
    responseHeaders.join('\n'),
    new RegExp(escapeRegex(expectedMainObjectKey), 'i')
);

// Phase C remains completely outside the GitHub Pages artifact and never edits
// either public manifest.
assert.ok(publishedSiteEntries.every(entry =>
    entry !== 'gallery-admin' && !entry.startsWith('gallery-admin/')
));
const artifactBuilder = await readFile(
    new URL('../scripts/build-preview-artifact.mjs', import.meta.url),
    'utf8'
);
assert.match(artifactBuilder, /unpublishablePrefixes[\s\S]*'gallery-admin\/'/);
const manifestFinals = await Promise.all(manifestUrls.map(url => readFile(url, 'utf8')));
assert.deepEqual(manifestFinals, manifestBaselines);
for (const finalText of manifestFinals) {
    assert.deepEqual(JSON.parse(finalText), { schemaVersion: '1.0', items: [] });
}

assert.ok(countRows(sqlite, 'draft_upload_sessions') >= 4);
assert.ok(countRows(sqlite, 'gallery_audit_events') >= 1);
sqlite.close();

console.log('Gallery admin Phase C synthetic integration tests passed.');

async function createDraftRequest(itemInput, consent, siteMode = familySiteMode) {
    return areaRequest('/api/browser/drafts', {
        method: 'POST',
        identity: 'owner',
        session: true,
        siteMode,
        json: {
            itemInput,
            consent
        }
    });
}

async function createValidDraft(id, athleteId) {
    const response = await createDraftRequest(
        makeItem(id, [athleteId]),
        consentWithGuardian
    );
    assert.equal(response.status, 201);
    return (await responseJson(response)).draft;
}

function makeItem(id, athleteIds, race = selectedRace) {
    return {
        id,
        type: 'photo',
        title: 'Synthetic race moment',
        caption: 'Generated bytes used only by the local Phase C integration test.',
        alt: 'Synthetic test pattern representing a race moment.',
        ...race,
        featured: false,
        athleteIds
    };
}

async function beginUpload(draftId, expectedStateVersion, byteLength, idempotencyKey) {
    return areaRequest(`/api/browser/drafts/${draftId}/upload`, {
        method: 'POST',
        identity: 'owner',
        session: true,
        json: {
            expectedStateVersion,
            fileName: 'synthetic-phase-c-photo.jpg',
            declaredMimeType: 'image/jpeg',
            byteLength,
            idempotencyKey,
            syntheticOnlyConfirmed: true
        }
    });
}

async function uploadPart(
    draftId,
    partNumber,
    bytes,
    hash = sha256(bytes),
    { includeContentLength = true } = {}
) {
    const headers = {
        'Content-Type': 'application/octet-stream',
        'X-Chunk-SHA256': hash
    };
    if (includeContentLength) {
        headers['Content-Length'] = String(bytes.byteLength);
    }
    return areaRequest(`/api/browser/drafts/${draftId}/upload-parts/${partNumber}`, {
        method: 'PUT',
        identity: 'owner',
        session: true,
        rawBody: bytes,
        headers
    });
}

async function completeUpload(draftId, expectedStateVersion, idempotencyKey) {
    return areaRequest(`/api/browser/drafts/${draftId}/upload-completion`, {
        method: 'POST',
        identity: 'owner',
        session: true,
        json: { expectedStateVersion, idempotencyKey }
    });
}

async function refreshBrowserSession(siteMode = familySiteMode) {
    const response = await areaRequest('/api/browser/session', {
        identity: 'owner',
        siteMode
    });
    assert.equal(response.status, 200);
    const body = await responseJson(response);
    const setCookie = response.headers.get('Set-Cookie');
    assert.ok(setCookie);
    browserSessions.set(siteMode, {
        cookie: setCookie.split(';', 1)[0],
        csrfToken: body.csrfToken
    });
}

async function transitionDraft(draftId, toState, expectedStateVersion, idempotencyKey) {
    return areaRequest(`/api/browser/drafts/${draftId}/transitions`, {
        method: 'POST',
        identity: 'owner',
        session: true,
        json: { toState, expectedStateVersion, idempotencyKey }
    });
}

async function areaRequest(path, options = {}) {
    const {
        siteMode = familySiteMode,
        ...requestOptions
    } = options;
    assert.ok([familySiteMode, everyoneSiteMode].includes(siteMode));
    assert.doesNotMatch(path, /[?#]/);
    return adminRequest(`${path}?site=${siteMode}`, {
        ...requestOptions,
        sessionSiteMode: siteMode
    });
}

async function adminRequest(path, {
    method = 'GET',
    identity = null,
    session = false,
    sessionSiteMode = familySiteMode,
    csrf = true,
    headers = {},
    json,
    rawBody
} = {}) {
    currentNow += 1;
    const requestHeaders = new Headers(headers);
    if (identity) {
        requestHeaders.set('X-Synthetic-Identity', identity);
    }
    if (session) {
        const browserSession = browserSessions.get(sessionSiteMode);
        assert.ok(browserSession, `A ${sessionSiteMode} browser session must be issued first.`);
        requestHeaders.set('Cookie', browserSession.cookie);
        if (!['GET', 'HEAD'].includes(method)) {
            requestHeaders.set('Origin', requestHeaders.get('Origin') || adminOrigin);
            requestHeaders.set('Sec-Fetch-Site', 'same-origin');
            if (csrf) {
                requestHeaders.set('X-CSRF-Token', browserSession.csrfToken);
            }
        }
    }
    let body = rawBody;
    if (json !== undefined) {
        requestHeaders.set('Content-Type', 'application/json');
        body = JSON.stringify(json);
    }
    const response = await handleAdminRequest(
        new Request(`${adminOrigin}${path}`, { method, headers: requestHeaders, body }),
        env,
        {
            verifyAccessIdentity,
            now: () => currentNow,
            digestReadable: nodeDigestReadable
        }
    );
    responseHeaders.push([...response.headers].map(entry => entry.join(': ')).join('\n'));
    if ((response.headers.get('Content-Type') || '').startsWith('application/json')) {
        jsonResponses.push(await response.clone().text());
    }
    return response;
}

async function responseJson(response) {
    return response.json();
}

function assertSafeUploadShape(upload) {
    assert.deepEqual(Object.keys(upload).sort(), [
        'completedSha256',
        'declaredContentType',
        'expectedByteCount',
        'expiresAt',
        'nextPartNumber',
        'partCount',
        'partSize',
        'status',
        'uploadedByteCount',
        'uploadedParts'
    ]);
}

function sameRace(left, right) {
    return left.raceDate === right.raceDate &&
        left.raceEvent === right.raceEvent &&
        left.raceDistance === right.raceDistance;
}

function syntheticJpeg(byteLength) {
    assert.ok(byteLength >= 3);
    const bytes = new Uint8Array(byteLength);
    for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = (index * 31 + 17) & 0xff;
    }
    bytes[0] = 0xff;
    bytes[1] = 0xd8;
    bytes[2] = 0xff;
    return bytes;
}

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

async function nodeDigestReadable(stream) {
    const digest = createHash('sha256');
    const reader = stream.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            digest.update(value);
        }
    } finally {
        reader.releaseLock();
    }
    return digest.digest('hex');
}

function insertPendingExclusion(database, athleteId, expectedSuppressionRevision) {
    const timestamp = new Date(currentNow).toISOString();
    database.prepare(
        'INSERT INTO pending_athlete_exclusions (' +
        'athlete_id, exclusion_revision, expected_suppression_revision, ' +
        'request_audit_hash, actor_identity_hash, created_at, updated_at' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
        athleteId,
        'pending-exclusion-revision-0001',
        expectedSuppressionRevision,
        'a'.repeat(64),
        'b'.repeat(64),
        timestamp,
        timestamp
    );
}

function countRows(database, tableName) {
    assert.match(tableName, /^[a-z_]+$/);
    return database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count;
}

function createSqliteD1(database) {
    class Statement {
        constructor(sql, bindings = []) {
            this.sql = sql;
            this.bindings = bindings;
        }

        bind(...bindings) {
            return new Statement(this.sql, bindings);
        }

        async run() {
            return this.runSynchronously();
        }

        async first(columnName) {
            const row = database.prepare(this.sql).get(...this.bindings) ?? null;
            return columnName === undefined || row === null ? row : row[columnName];
        }

        async all() {
            return { success: true, results: database.prepare(this.sql).all(...this.bindings) };
        }

        runSynchronously() {
            const result = database.prepare(this.sql).run(...this.bindings);
            return {
                success: true,
                meta: {
                    changes: Number(result.changes),
                    last_row_id: Number(result.lastInsertRowid)
                }
            };
        }
    }

    return {
        prepare(sql) {
            return new Statement(sql);
        },
        async batch(statements) {
            database.exec('BEGIN IMMEDIATE');
            try {
                const results = statements.map(statement => {
                    assert.ok(statement instanceof Statement);
                    return statement.runSynchronously();
                });
                database.exec('COMMIT');
                return results;
            } catch (error) {
                database.exec('ROLLBACK');
                throw error;
            }
        }
    };
}

function createPrivateOriginalsBucket(providerPrefix) {
    const uploads = new Map();
    const objects = new Map();
    let nextUpload = 1;
    let nextVersion = 1;

    const bucket = {
        calls: [],
        abortedUploadCount: 0,
        failNextPartNumber: null,
        failNextHead: false,
        truncateNextComplete: false,
        corruptNextComplete: false,

        async createMultipartUpload(key, options = {}) {
            const uploadId = `${providerPrefix}-${nextUpload++}`;
            const record = {
                key,
                uploadId,
                options,
                parts: new Map(),
                aborted: false,
                complete: false
            };
            uploads.set(uploadId, record);
            bucket.calls.push({ operation: 'createMultipartUpload', key, uploadId });
            return multipart(record);
        },

        resumeMultipartUpload(key, uploadId) {
            const record = uploads.get(uploadId);
            if (!record || record.key !== key || record.aborted) {
                throw noSuchUpload();
            }
            bucket.calls.push({ operation: 'resumeMultipartUpload', key, uploadId });
            return multipart(record);
        },

        async head(key) {
            if (bucket.failNextHead) {
                bucket.failNextHead = false;
                throw new Error('Synthetic interrupted object lookup.');
            }
            bucket.calls.push({ operation: 'head', key });
            const object = objects.get(key);
            return object ? objectMetadata(object) : null;
        },

        async get(key, options = {}) {
            bucket.calls.push({ operation: 'get', key, options });
            const object = objects.get(key);
            if (!object) {
                return null;
            }
            if (options.onlyIf?.etagMatches && options.onlyIf.etagMatches !== object.etag) {
                return objectMetadata(object);
            }
            const range = options.range;
            const bytes = range
                ? object.bytes.slice(range.offset, range.offset + range.length)
                : object.bytes.slice();
            return {
                ...objectMetadata(object),
                body: bytesToStream(bytes),
                range: range ? { ...range } : undefined
            };
        },

        async delete(key) {
            bucket.calls.push({ operation: 'delete', key });
            objects.delete(key);
        }
    };

    function multipart(record) {
        return {
            key: record.key,
            uploadId: record.uploadId,
            async uploadPart(partNumber, body) {
                if (record.aborted || record.complete) {
                    throw noSuchUpload();
                }
                if (bucket.failNextPartNumber === partNumber) {
                    bucket.failNextPartNumber = null;
                    throw new Error('Synthetic interrupted multipart transfer.');
                }
                assert.ok(
                    body instanceof Uint8Array,
                    'R2 multipart uploadPart must receive a fixed-length Uint8Array.'
                );
                const bytes = body.slice();
                const etag = `part-${partNumber}-${sha256(bytes).slice(0, 24)}`;
                record.parts.set(partNumber, { bytes, etag });
                bucket.calls.push({
                    operation: 'uploadPart',
                    uploadId: record.uploadId,
                    partNumber,
                    byteLength: bytes.byteLength,
                    receivedUint8Array: true
                });
                return { partNumber, etag };
            },
            async complete(parts) {
                if (record.aborted) {
                    throw noSuchUpload();
                }
                const byteArrays = parts.map(part => {
                    const stored = record.parts.get(part.partNumber);
                    if (!stored || stored.etag !== part.etag) {
                        throw new Error('Synthetic multipart evidence mismatch.');
                    }
                    return stored.bytes;
                });
                let bytes = concatenateBytes(byteArrays);
                if (bucket.truncateNextComplete) {
                    bucket.truncateNextComplete = false;
                    bytes = bytes.slice(0, Math.max(0, bytes.byteLength - 1));
                }
                if (bucket.corruptNextComplete) {
                    bucket.corruptNextComplete = false;
                    bytes = bytes.slice();
                    bytes[0] ^= 0xff;
                }
                const object = {
                    bytes,
                    etag: `object-${sha256(bytes).slice(0, 32)}`,
                    version: `version-${nextVersion++}`
                };
                objects.set(record.key, object);
                record.complete = true;
                bucket.calls.push({
                    operation: 'complete',
                    uploadId: record.uploadId,
                    byteLength: bytes.byteLength
                });
                return objectMetadata(object);
            },
            async abort() {
                if (!record.aborted) {
                    record.aborted = true;
                    bucket.abortedUploadCount += 1;
                }
                bucket.calls.push({ operation: 'abort', uploadId: record.uploadId });
            }
        };
    }

    return bucket;
}

function objectMetadata(object) {
    return {
        size: object.bytes.byteLength,
        etag: object.etag,
        httpEtag: `"${object.etag}"`,
        version: object.version,
        uploaded: new Date(fixedNow),
        httpMetadata: { contentType: 'application/x-private-sentinel' },
        customMetadata: { privateProviderValue: providerSentinel }
    };
}

async function readStream(stream) {
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
            chunks.push(bytes);
            total += bytes.byteLength;
        }
    } finally {
        reader.releaseLock();
    }
    return concatenateBytes(chunks, total);
}

function concatenateBytes(chunks, knownTotal = undefined) {
    const total = knownTotal ?? chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

function bytesToStream(bytes) {
    return new ReadableStream({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        }
    });
}

function noSuchUpload() {
    const error = new Error('NoSuchUpload');
    error.name = 'NoSuchUpload';
    return error;
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
