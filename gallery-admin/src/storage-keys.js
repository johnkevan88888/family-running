const SITE_PATTERN = /^(family|everyone)$/;
const DRAFT_ID_PATTERN = /^draft_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const UPLOAD_ID_PATTERN = /^upload_[a-f0-9]{12}4[a-f0-9]{3}[89ab][a-f0-9]{15}$/;
const PROCESSING_RUN_ID_PATTERN = /^run_[a-f0-9]{12}4[a-f0-9]{3}[89ab][a-f0-9]{15}$/;
const LEGACY_OBJECT_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SERVER_TIMESTAMP_PATTERN = /^([0-9]{4})-(0[1-9]|1[0-2])-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

export const ORIGINAL_EXTENSIONS = Object.freeze([
    'jpg',
    'jpeg',
    'png',
    'webp',
    'heic',
    'heif',
    'mp4',
    'mov',
    'webm'
]);

const originalExtensionSet = new Set(ORIGINAL_EXTENSIONS);

export const DERIVATIVE_KEY_SPECS = Object.freeze({
    'photo-display': Object.freeze({
        filename: 'display.webp',
        contentType: 'image/webp'
    }),
    'photo-thumbnail': Object.freeze({
        filename: 'thumbnail.webp',
        contentType: 'image/webp'
    }),
    video: Object.freeze({
        filename: 'video.mp4',
        contentType: 'video/mp4'
    }),
    'video-poster': Object.freeze({
        filename: 'poster.webp',
        contentType: 'image/webp'
    })
});

const derivativeRoleByFilename = new Map(
    Object.entries(DERIVATIVE_KEY_SPECS).map(([role, spec]) => [spec.filename, role])
);

const legacyPrivatePattern = new RegExp(
    '^private-originals/phase-c/' +
    '(draft_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})/' +
    '([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\\.' +
    `(${ORIGINAL_EXTENSIONS.join('|')})$`
);

const v1PrivatePattern = new RegExp(
    '^private-originals/v1/' +
    '(family|everyone)/([0-9]{4})/(0[1-9]|1[0-2])/' +
    '(draft_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})/' +
    '(upload_[a-f0-9]{12}4[a-f0-9]{3}[89ab][a-f0-9]{15})/' +
    `original\\.(${ORIGINAL_EXTENSIONS.join('|')})$`
);

const stagingPattern = new RegExp(
    '^derivative-staging/v1/' +
    '(family|everyone)/' +
    '(draft_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})/' +
    '(run_[a-f0-9]{12}4[a-f0-9]{3}[89ab][a-f0-9]{15})/' +
    '([a-f0-9]{64})/' +
    '(display\\.webp|thumbnail\\.webp|video\\.mp4|poster\\.webp)$'
);

const approvedPattern = /^media\/v1\/([a-f0-9]{64})\/(display\.webp|thumbnail\.webp|video\.mp4|poster\.webp)$/;

export function normalizeOriginalExtension(fileName) {
    const match = typeof fileName === 'string'
        ? /\.([A-Za-z0-9]+)$/.exec(fileName)
        : null;
    const extension = match?.[1]?.toLowerCase() || '';
    return originalExtensionSet.has(extension) ? extension : null;
}

export function buildV1PrivateOriginalKey({
    site,
    uploadedAt,
    draftId,
    uploadId,
    extension
}) {
    assertMatch(site, SITE_PATTERN);
    assertMatch(draftId, DRAFT_ID_PATTERN);
    assertMatch(uploadId, UPLOAD_ID_PATTERN);
    assertExtension(extension);
    const dateMatch = canonicalServerTimestampMatch(uploadedAt);
    if (!dateMatch) {
        throw new TypeError('Invalid server storage-key input.');
    }
    const key = `private-originals/v1/${site}/${dateMatch[1]}/${dateMatch[2]}/` +
        `${draftId}/${uploadId}/original.${extension}`;
    if (!parsePrivateOriginalKey(key)) {
        throw new TypeError('Invalid server storage-key input.');
    }
    return key;
}

export function parsePrivateOriginalKey(key) {
    if (typeof key !== 'string') {
        return null;
    }
    let match = legacyPrivatePattern.exec(key);
    if (match) {
        return Object.freeze({
            kind: 'phase-c-legacy',
            draftId: match[1],
            legacyObjectId: match[2],
            extension: match[3]
        });
    }
    match = v1PrivatePattern.exec(key);
    if (!match) {
        return null;
    }
    return Object.freeze({
        kind: 'v1-private-original',
        site: match[1],
        uploadYear: match[2],
        uploadMonth: match[3],
        draftId: match[4],
        uploadId: match[5],
        extension: match[6]
    });
}

export function buildV1StagingDerivativeKey({
    site,
    draftId,
    processingRunId,
    sha256,
    role
}) {
    assertMatch(site, SITE_PATTERN);
    assertMatch(draftId, DRAFT_ID_PATTERN);
    assertMatch(processingRunId, PROCESSING_RUN_ID_PATTERN);
    assertMatch(sha256, SHA256_PATTERN);
    const spec = derivativeSpec(role);
    return `derivative-staging/v1/${site}/${draftId}/${processingRunId}/` +
        `${sha256}/${spec.filename}`;
}

export function parseV1StagingDerivativeKey(key) {
    const match = typeof key === 'string' ? stagingPattern.exec(key) : null;
    if (!match) {
        return null;
    }
    const role = derivativeRoleByFilename.get(match[5]);
    const spec = DERIVATIVE_KEY_SPECS[role];
    return Object.freeze({
        site: match[1],
        draftId: match[2],
        processingRunId: match[3],
        sha256: match[4],
        role,
        filename: spec.filename,
        contentType: spec.contentType
    });
}

export function buildV1ApprovedDerivativeKey({ sha256, role }) {
    assertMatch(sha256, SHA256_PATTERN);
    const spec = derivativeSpec(role);
    return `media/v1/${sha256}/${spec.filename}`;
}

export function parseV1ApprovedDerivativeKey(key) {
    const match = typeof key === 'string' ? approvedPattern.exec(key) : null;
    if (!match) {
        return null;
    }
    const role = derivativeRoleByFilename.get(match[2]);
    const spec = DERIVATIVE_KEY_SPECS[role];
    return Object.freeze({
        sha256: match[1],
        role,
        filename: spec.filename,
        contentType: spec.contentType
    });
}

export function privateOriginalKeyMatchesRecord(key, record) {
    const parsed = parsePrivateOriginalKey(key);
    if (!parsed || !record || typeof record !== 'object') {
        return false;
    }
    if (
        parsed.draftId !== record.draftId ||
        parsed.extension !== record.extension
    ) {
        return false;
    }
    if (parsed.kind === 'phase-c-legacy') {
        return SITE_PATTERN.test(record.site) &&
            UPLOAD_ID_PATTERN.test(record.uploadId) &&
            canonicalServerTimestampMatch(record.uploadedAt) !== null;
    }
    try {
        return key === buildV1PrivateOriginalKey({
            site: record.site,
            uploadedAt: record.uploadedAt,
            draftId: record.draftId,
            uploadId: record.uploadId,
            extension: record.extension
        });
    } catch {
        return false;
    }
}

export function derivativeKeyMatchesRecord(key, record) {
    if (!record || typeof record !== 'object') {
        return false;
    }
    try {
        if (record.tier === 'staging') {
            return key === buildV1StagingDerivativeKey({
                site: record.site,
                draftId: record.draftId,
                processingRunId: record.processingRunId,
                sha256: record.sha256,
                role: record.role
            });
        }
        if (record.tier === 'approved') {
            return key === buildV1ApprovedDerivativeKey({
                sha256: record.sha256,
                role: record.role
            });
        }
    } catch {
        return false;
    }
    return false;
}

function derivativeSpec(role) {
    const spec = typeof role === 'string' && Object.hasOwn(DERIVATIVE_KEY_SPECS, role)
        ? DERIVATIVE_KEY_SPECS[role]
        : null;
    if (!spec) {
        throw new TypeError('Invalid server storage-key input.');
    }
    return spec;
}

function canonicalServerTimestampMatch(value) {
    const match = typeof value === 'string'
        ? SERVER_TIMESTAMP_PATTERN.exec(value)
        : null;
    if (!match) {
        return null;
    }
    const parsedDate = new Date(value);
    return !Number.isNaN(parsedDate.getTime()) && parsedDate.toISOString() === value
        ? match
        : null;
}

function assertExtension(extension) {
    if (
        typeof extension !== 'string' ||
        !originalExtensionSet.has(extension) ||
        extension !== extension.toLowerCase()
    ) {
        throw new TypeError('Invalid server storage-key input.');
    }
}

function assertMatch(value, pattern) {
    if (typeof value !== 'string' || !pattern.test(value)) {
        throw new TypeError('Invalid server storage-key input.');
    }
}
