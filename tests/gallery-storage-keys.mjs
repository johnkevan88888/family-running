import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

import { handleMediaRequest } from '../gallery-admin/src/media-worker.js';
import { cleanupExpiredPrivateUploads } from '../gallery-admin/src/upload-service.js';
import {
    DERIVATIVE_KEY_SPECS,
    ORIGINAL_EXTENSIONS,
    buildV1ApprovedDerivativeKey,
    buildV1PrivateOriginalKey,
    buildV1StagingDerivativeKey,
    derivativeKeyMatchesRecord,
    normalizeOriginalExtension,
    parsePrivateOriginalKey,
    parseV1ApprovedDerivativeKey,
    parseV1StagingDerivativeKey,
    privateOriginalKeyMatchesRecord
} from '../gallery-admin/src/storage-keys.js';

const uploadedAt = '2026-08-28T04:05:06.007Z';
const draftId = makeDraftId('1');
const uploadId = makeUploadId('a');
const processingRunId = makeRunId('b');
const derivativeHash = 'c'.repeat(64);

assert.deepEqual(ORIGINAL_EXTENSIONS, [
    'jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'mp4', 'mov', 'webm'
]);
assert.ok(Object.isFrozen(ORIGINAL_EXTENSIONS));
assert.ok(Object.isFrozen(DERIVATIVE_KEY_SPECS));

for (const extension of ORIGINAL_EXTENSIONS) {
    assert.equal(
        normalizeOriginalExtension(`synthetic-original.${extension.toUpperCase()}`),
        extension
    );
}
for (const fileName of [
    '',
    'synthetic-original',
    'synthetic-original.exe',
    'synthetic-original.jpg.exe',
    'synthetic-original.',
    null,
    42
]) {
    assert.equal(normalizeOriginalExtension(fileName), null);
}

const privateKey = buildV1PrivateOriginalKey({
    site: 'family',
    uploadedAt,
    draftId,
    uploadId,
    extension: 'jpg',
    uploaderName: 'john-private-uploader',
    originalFileName: 'john-race-2026.jpg',
    raceDate: '2026-08-17',
    raceEvent: 'private-race-name',
    athleteId: 'private-athlete-id',
    consentReference: 'private-consent-reference',
    exclusionReason: 'private-exclusion-reason'
});
assert.equal(
    privateKey,
    `private-originals/v1/family/2026/08/${draftId}/${uploadId}/original.jpg`
);
assert.deepEqual(parsePrivateOriginalKey(privateKey), {
    kind: 'v1-private-original',
    site: 'family',
    uploadYear: '2026',
    uploadMonth: '08',
    draftId,
    uploadId,
    extension: 'jpg'
});
assert.ok(Object.isFrozen(parsePrivateOriginalKey(privateKey)));

const exactPrivateRecord = {
    site: 'family',
    uploadedAt,
    draftId,
    uploadId,
    extension: 'jpg'
};
assert.equal(privateOriginalKeyMatchesRecord(privateKey, exactPrivateRecord), true);
for (const override of [
    { site: 'everyone' },
    { uploadedAt: '2026-09-01T00:00:00.000Z' },
    { draftId: makeDraftId('2') },
    { uploadId: makeUploadId('b') },
    { extension: 'jpeg' }
]) {
    assert.equal(
        privateOriginalKeyMatchesRecord(privateKey, {
            ...exactPrivateRecord,
            ...override
        }),
        false
    );
}

const legacyObjectId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const legacyKey = `private-originals/phase-c/${draftId}/${legacyObjectId}.jpg`;
assert.deepEqual(parsePrivateOriginalKey(legacyKey), {
    kind: 'phase-c-legacy',
    draftId,
    legacyObjectId,
    extension: 'jpg'
});
assert.equal(privateOriginalKeyMatchesRecord(legacyKey, exactPrivateRecord), true);
assert.equal(privateOriginalKeyMatchesRecord(legacyKey, {
    ...exactPrivateRecord,
    site: 'shared'
}), false);
assert.equal(privateOriginalKeyMatchesRecord(legacyKey, {
    ...exactPrivateRecord,
    uploadId: 'phase-c-session'
}), false);

const expectedFilenames = {
    'photo-display': 'display.webp',
    'photo-thumbnail': 'thumbnail.webp',
    video: 'video.mp4',
    'video-poster': 'poster.webp'
};
const approvedKeys = [];
for (const [role, filename] of Object.entries(expectedFilenames)) {
    const stagingKey = buildV1StagingDerivativeKey({
        site: 'everyone',
        draftId,
        processingRunId,
        sha256: derivativeHash,
        role,
        uploaderEmail: 'private@example.com',
        raceEvent: 'private-race-name',
        athleteIds: ['private-athlete-id'],
        consent: 'private-consent-reference'
    });
    assert.equal(
        stagingKey,
        `derivative-staging/v1/everyone/${draftId}/${processingRunId}/` +
        `${derivativeHash}/${filename}`
    );
    assert.deepEqual(parseV1StagingDerivativeKey(stagingKey), {
        site: 'everyone',
        draftId,
        processingRunId,
        sha256: derivativeHash,
        role,
        filename,
        contentType: filename === 'video.mp4' ? 'video/mp4' : 'image/webp'
    });
    assert.equal(derivativeKeyMatchesRecord(stagingKey, {
        tier: 'staging',
        site: 'everyone',
        draftId,
        processingRunId,
        sha256: derivativeHash,
        role
    }), true);

    const approvedKey = buildV1ApprovedDerivativeKey({
        sha256: derivativeHash,
        role,
        raceDate: '2026-08-17',
        title: 'private-title',
        originalFileName: 'private-original-name.mov'
    });
    approvedKeys.push(approvedKey);
    assert.equal(approvedKey, `media/v1/${derivativeHash}/${filename}`);
    assert.deepEqual(parseV1ApprovedDerivativeKey(approvedKey), {
        sha256: derivativeHash,
        role,
        filename,
        contentType: filename === 'video.mp4' ? 'video/mp4' : 'image/webp'
    });
    assert.equal(derivativeKeyMatchesRecord(approvedKey, {
        tier: 'approved',
        sha256: derivativeHash,
        role
    }), true);
}

for (const key of [privateKey, ...approvedKeys]) {
    for (const forbidden of [
        'john-private-uploader',
        'john-race-2026',
        'private@example.com',
        'private-race-name',
        'private-athlete-id',
        'private-consent-reference',
        'private-exclusion-reason',
        'private-title',
        '2026-08-17'
    ]) {
        assert.equal(key.includes(forbidden), false);
    }
}

for (const invalidInput of [
    { site: 'shared' },
    { site: 'Family' },
    { uploadedAt: '2026-02-31T00:00:00.000Z' },
    { uploadedAt: '2026-08-28T04:05:06Z' },
    { uploadedAt: '2026-08-28T04:05:06.007+00:00' },
    { draftId: 'draft_not-a-uuid-but-long-enough' },
    { draftId: draftId.toUpperCase() },
    { uploadId: makeWrongVersionUploadId('a') },
    { uploadId: uploadId.toUpperCase() },
    { extension: 'JPG' },
    { extension: 'exe' },
    { extension: '../jpg' }
]) {
    assert.throws(
        () => buildV1PrivateOriginalKey({
            site: 'family',
            uploadedAt,
            draftId,
            uploadId,
            extension: 'jpg',
            ...invalidInput
        }),
        /Invalid server storage-key input/
    );
}

for (const invalidKey of [
    privateKey.replace('/family/', '/everyone/'),
    privateKey.replace('/2026/08/', '/2026//08/'),
    privateKey.replace('/original.jpg', '/../original.jpg'),
    privateKey.replace('/original.jpg', '/john-race.jpg'),
    privateKey.toUpperCase(),
    `${privateKey}/extra`,
    `/${privateKey}`,
    '',
    null
]) {
    if (invalidKey === privateKey.replace('/family/', '/everyone/')) {
        assert.equal(parsePrivateOriginalKey(invalidKey)?.site, 'everyone');
        assert.equal(privateOriginalKeyMatchesRecord(invalidKey, exactPrivateRecord), false);
    } else {
        assert.equal(parsePrivateOriginalKey(invalidKey), null);
    }
}

for (const role of [
    'video-playback',
    'display.webp',
    'toString',
    'constructor',
    '__proto__',
    '',
    null
]) {
    assert.throws(
        () => buildV1ApprovedDerivativeKey({ sha256: derivativeHash, role }),
        /Invalid server storage-key input/
    );
}
assert.throws(
    () => buildV1ApprovedDerivativeKey({
        sha256: derivativeHash.toUpperCase(),
        role: 'photo-display'
    }),
    /Invalid server storage-key input/
);
assert.equal(parseV1ApprovedDerivativeKey(
    `media/v1/${derivativeHash}/original.jpg`
), null);
assert.equal(parseV1StagingDerivativeKey(
    `derivative-staging/v1/family/${draftId}/${processingRunId}/` +
    `${derivativeHash}/video-playback.mp4`
), null);
assert.equal(derivativeKeyMatchesRecord(approvedKeys[0], {
    tier: 'approved',
    sha256: derivativeHash,
    role: 'photo-thumbnail'
}), false);

// The public delivery Worker and the key contract must agree on every exact
// approved key. Private and staging paths stop before any R2 call.
const deliveryCalls = [];
const deliveryEnv = {
    MEDIA_VERSION: { id: '11111111-1111-4111-8111-111111111111' },
    APPROVED_MEDIA: {
        async head(key) {
            deliveryCalls.push(key);
            return null;
        },
        async get() {
            throw new Error('The focused conformance test uses HEAD only.');
        }
    }
};
for (const key of approvedKeys) {
    const response = await handleMediaRequest(
        new Request(`https://synthetic-media.example/${key}`, { method: 'HEAD' }),
        deliveryEnv
    );
    assert.equal(response.status, 404);
}
assert.deepEqual(deliveryCalls, approvedKeys);
for (const key of [privateKey, buildV1StagingDerivativeKey({
    site: 'family',
    draftId,
    processingRunId,
    sha256: derivativeHash,
    role: 'photo-display'
})]) {
    const callCount = deliveryCalls.length;
    assert.equal((await handleMediaRequest(
        new Request(`https://synthetic-media.example/${key}`, { method: 'HEAD' }),
        deliveryEnv
    )).status, 404);
    assert.equal(deliveryCalls.length, callCount);
}

// Corrupt database evidence never reaches R2 and is surfaced as a failed
// cleanup run rather than being silently treated as success.
let blockedCleanupR2Calls = 0;
const blockedCleanupEnv = {
    DB: {
        prepare() {
            return {
                bind() {
                    return this;
                },
                async all() {
                    return {
                        results: [{
                            uploadSessionId: uploadId,
                            draftId,
                            providerUploadId: 'provider-corrupt-key',
                            objectKey: `private-originals/v1/everyone/2026/08/` +
                                `${draftId}/${uploadId}/original.jpg`,
                            fileExtension: 'jpg',
                            createdAt: uploadedAt,
                            status: 'active',
                            siteModesJson: '["family"]'
                        }]
                    };
                }
            };
        },
        async batch() {
            throw new Error('A blocked cleanup record must not mutate D1.');
        }
    },
    PRIVATE_ORIGINALS: Object.fromEntries([
        'createMultipartUpload',
        'resumeMultipartUpload',
        'head',
        'get',
        'delete'
    ].map(name => [name, async () => {
        blockedCleanupR2Calls += 1;
        throw new Error(`A blocked cleanup record must not call R2 ${name}.`);
    }]))
};
for (const execute of [false, true]) {
    const result = await cleanupExpiredPrivateUploads(
        blockedCleanupEnv,
        Date.parse('2026-08-30T00:00:00.000Z'),
        { execute }
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
}
assert.equal(blockedCleanupR2Calls, 0);

// Database enforcement is independent of the JavaScript builder. The forward
// migration accepts exact v1 keys for each area and an exact legacy key during
// a rolling Worker update, while rejecting cross-area and malformed records.
const migrationSources = await Promise.all([
    '0001_private_gallery.sql',
    '0002_private_uploads.sql',
    '0003_private_original_v1_keys.sql'
].map(fileName => readFile(
    new URL(`../gallery-admin/migrations/${fileName}`, import.meta.url),
    'utf8'
)));
const database = new DatabaseSync(':memory:');
for (const migrationSource of migrationSources) {
    database.exec(migrationSource);
}

const familyDatabaseDraft = makeDraftId('3');
const familyDatabaseUpload = makeUploadId('d');
const familyDatabaseKey = buildV1PrivateOriginalKey({
    site: 'family',
    uploadedAt,
    draftId: familyDatabaseDraft,
    uploadId: familyDatabaseUpload,
    extension: 'jpg'
});
prepareUploadingDraft(database, {
    draftId: familyDatabaseDraft,
    site: 'family',
    objectKey: familyDatabaseKey
});
insertUploadSession(database, {
    draftId: familyDatabaseDraft,
    uploadId: familyDatabaseUpload,
    objectKey: familyDatabaseKey,
    createdAt: uploadedAt,
    extension: 'jpg',
    label: 'family-v1'
});

const everyoneDatabaseDraft = makeDraftId('4');
const everyoneDatabaseUpload = makeUploadId('e');
const everyoneDatabaseKey = buildV1PrivateOriginalKey({
    site: 'everyone',
    uploadedAt,
    draftId: everyoneDatabaseDraft,
    uploadId: everyoneDatabaseUpload,
    extension: 'mov'
});
prepareUploadingDraft(database, {
    draftId: everyoneDatabaseDraft,
    site: 'everyone',
    objectKey: everyoneDatabaseKey,
    mediaType: 'video'
});
insertUploadSession(database, {
    draftId: everyoneDatabaseDraft,
    uploadId: everyoneDatabaseUpload,
    objectKey: everyoneDatabaseKey,
    createdAt: uploadedAt,
    extension: 'mov',
    contentType: 'video/quicktime',
    label: 'everyone-v1'
});

const legacyDatabaseDraft = makeDraftId('5');
const legacyDatabaseUpload = makeUploadId('f');
const rollingLegacyKey =
    `private-originals/phase-c/${legacyDatabaseDraft}/` +
    'ffffffff-ffff-4fff-8fff-ffffffffffff.jpg';
prepareUploadingDraft(database, {
    draftId: legacyDatabaseDraft,
    site: 'family',
    objectKey: rollingLegacyKey
});
insertUploadSession(database, {
    draftId: legacyDatabaseDraft,
    uploadId: legacyDatabaseUpload,
    objectKey: rollingLegacyKey,
    createdAt: uploadedAt,
    extension: 'jpg',
    label: 'legacy-compatibility'
});

assert.equal(database.prepare(
    'SELECT COUNT(*) AS count FROM draft_upload_sessions'
).get().count, 3);
assert.deepEqual(database.prepare(
    'SELECT object_key AS objectKey FROM draft_upload_sessions ORDER BY object_key'
).all().map(row => row.objectKey).sort(), [
    familyDatabaseKey,
    everyoneDatabaseKey,
    rollingLegacyKey
].sort());

assertRejectedDatabaseSession(database, {
    draftId: makeDraftId('6'),
    site: 'family',
    uploadId: makeUploadId('6'),
    objectKey: buildV1PrivateOriginalKey({
        site: 'everyone',
        uploadedAt,
        draftId: makeDraftId('6'),
        uploadId: makeUploadId('6'),
        extension: 'jpg'
    }),
    createdAt: uploadedAt,
    label: 'cross-site'
});
assertRejectedDatabaseSession(database, {
    draftId: 'draft_not-a-uuid-but-long-enough',
    site: 'family',
    uploadId: makeUploadId('7'),
    objectKey:
        `private-originals/v1/family/2026/08/draft_not-a-uuid-but-long-enough/` +
        `${makeUploadId('7')}/original.jpg`,
    createdAt: uploadedAt,
    label: 'invalid-draft-id'
});
assertRejectedDatabaseSession(database, {
    draftId: makeDraftId('7'),
    site: 'family',
    uploadId: makeWrongVersionUploadId('7'),
    objectKey:
        `private-originals/v1/family/2026/08/${makeDraftId('7')}/` +
        `${makeWrongVersionUploadId('7')}/original.jpg`,
    createdAt: uploadedAt,
    label: 'invalid-upload-id'
});
assertRejectedDatabaseSession(database, {
    draftId: makeDraftId('8'),
    site: 'family',
    uploadId: makeUploadId('8'),
    objectKey:
        `private-originals/v1/family/2026/08/${makeDraftId('8')}/` +
        `${makeUploadId('8')}/original.jpg`,
    createdAt: '2026-08-28X04:05:06.007Z',
    label: 'malformed-timestamp'
});
assertRejectedDatabaseSession(database, {
    draftId: makeDraftId('9'),
    site: 'family',
    uploadId: makeUploadId('9'),
    objectKey:
        `private-originals/v1/family/2026/09/${makeDraftId('9')}/` +
        `${makeUploadId('9')}/original.jpg`,
    createdAt: uploadedAt,
    label: 'wrong-month'
});
assertRejectedDatabaseSession(database, {
    draftId: makeDraftId('a'),
    site: 'family',
    uploadId: makeUploadId('1'),
    objectKey:
        `private-originals/v1/family/2026/08/${makeDraftId('a')}/` +
        `${makeUploadId('1')}/original.jpg`,
    createdAt: uploadedAt,
    label: 'synthetic-flag',
    syntheticOnlyConfirmed: 0
});

assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name LIKE '%_v1'"
).get().count, 0);
database.close();

console.log('Gallery storage-key contract tests passed.');

function makeDraftId(character) {
    return `draft_${character.repeat(8)}-${character.repeat(4)}-4${character.repeat(3)}-` +
        `8${character.repeat(3)}-${character.repeat(12)}`;
}

function makeUploadId(character) {
    return `upload_${character.repeat(12)}4${character.repeat(3)}8${character.repeat(15)}`;
}

function makeWrongVersionUploadId(character) {
    return `upload_${character.repeat(12)}5${character.repeat(3)}8${character.repeat(15)}`;
}

function makeRunId(character) {
    return `run_${character.repeat(12)}4${character.repeat(3)}8${character.repeat(15)}`;
}

function prepareUploadingDraft(database, {
    draftId,
    site,
    objectKey,
    mediaType = 'photo'
}) {
    const consentRevision = `${draftId}-consent-v1`;
    database.prepare(
        'INSERT INTO gallery_drafts (' +
        'draft_id, public_item_id, state, state_version, site_modes_json, ' +
        'export_bundle_id, source_revision, suppression_revision, item_revision, ' +
        'active_consent_revision, media_type, race_date, race_event, race_distance, ' +
        'athlete_ids_json, title, caption, alt_text, featured, original_object_key, ' +
        'verified_owner_identity_hash, created_at, updated_at' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
        draftId,
        `${draftId}-item`,
        'draft',
        0,
        JSON.stringify([site]),
        `${draftId}-bundle`,
        `${draftId}-source`,
        `${draftId}-suppression`,
        `${draftId}-item-revision`,
        null,
        mediaType,
        '2026-08-17',
        'Synthetic race',
        '5 km',
        '[]',
        'Synthetic title',
        'Synthetic caption',
        'Synthetic alternative text',
        0,
        null,
        '1'.repeat(64),
        uploadedAt,
        uploadedAt
    );
    database.prepare(
        'INSERT INTO draft_consent_attestations (' +
        'draft_id, consent_revision, public_use_confirmed, contains_minors, ' +
        'guardian_approval_confirmed, private_evidence_reference, ' +
        'verified_owner_identity_hash, attested_at, withdrawn_at' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
        draftId,
        consentRevision,
        1,
        0,
        0,
        'synthetic-private-evidence',
        '1'.repeat(64),
        uploadedAt,
        null
    );
    database.prepare(
        'UPDATE gallery_drafts SET active_consent_revision = ?, updated_at = ? ' +
        'WHERE draft_id = ?'
    ).run(consentRevision, uploadedAt, draftId);
    database.prepare(
        'UPDATE gallery_drafts SET state = ?, state_version = ?, original_object_key = ?, ' +
        'updated_at = ? WHERE draft_id = ?'
    ).run('uploading', 1, objectKey, uploadedAt, draftId);
}

function insertUploadSession(database, {
    draftId,
    uploadId,
    objectKey,
    createdAt,
    extension = 'jpg',
    contentType = 'image/jpeg',
    label,
    syntheticOnlyConfirmed = 1
}) {
    const draft = database.prepare(
        'SELECT item_revision AS itemRevision, active_consent_revision AS consentRevision, ' +
        'export_bundle_id AS exportBundleId, source_revision AS sourceRevision, ' +
        'suppression_revision AS suppressionRevision FROM gallery_drafts WHERE draft_id = ?'
    ).get(draftId);
    database.prepare(
        'INSERT INTO draft_upload_sessions (' +
        'upload_session_id, draft_id, item_revision, consent_revision, export_bundle_id, ' +
        'source_revision, suppression_revision, provider_upload_id, object_key, file_extension, ' +
        'declared_content_type, declared_byte_count, part_size, part_count, next_part_number, ' +
        'uploaded_byte_count, status, synthetic_only_confirmed, verified_owner_identity_hash, ' +
        'initiation_idempotency_key, initiation_payload_fingerprint, created_at, updated_at, ' +
        'expires_at' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
        uploadId,
        draftId,
        draft.itemRevision,
        draft.consentRevision,
        draft.exportBundleId,
        draft.sourceRevision,
        draft.suppressionRevision,
        `provider-${label}`,
        objectKey,
        extension,
        contentType,
        128,
        5242880,
        1,
        1,
        0,
        'active',
        syntheticOnlyConfirmed,
        '1'.repeat(64),
        `storage-key-${label}-0001`,
        '2'.repeat(64),
        createdAt,
        createdAt,
        '2026-08-29T04:05:06.007Z'
    );
}

function assertRejectedDatabaseSession(database, {
    draftId,
    site,
    uploadId,
    objectKey,
    createdAt,
    label,
    syntheticOnlyConfirmed = 1
}) {
    prepareUploadingDraft(database, { draftId, site, objectKey });
    assert.throws(
        () => insertUploadSession(database, {
            draftId,
            uploadId,
            objectKey,
            createdAt,
            label,
            syntheticOnlyConfirmed
        }),
        /CHECK constraint failed|stale or lacks valid consent/i
    );
    assert.equal(database.prepare(
        'SELECT COUNT(*) AS count FROM draft_upload_sessions WHERE draft_id = ?'
    ).get(draftId).count, 0);
}
