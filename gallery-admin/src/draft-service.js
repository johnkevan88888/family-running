import '../../gallery-contract.js';
import '../../gallery-upload-contract.js';

import { hashIdentity } from './session.js';

const uploadContract = globalThis.galleryUploadContract;
const textEncoder = new TextEncoder();

const CREATE_KEYS = Object.freeze(['itemInput', 'consent']);
const UPDATE_KEYS = Object.freeze([
    'expectedItemRevision',
    'idempotencyKey',
    ...CREATE_KEYS
]);
const TRANSITION_KEYS = Object.freeze([
    'toState',
    'expectedStateVersion',
    'idempotencyKey'
]);
const ITEM_KEYS = Object.freeze([
    'id',
    'type',
    'title',
    'caption',
    'alt',
    'raceDate',
    'raceEvent',
    'raceDistance',
    'featured',
    'athleteIds'
]);
const CONSENT_INPUT_KEYS = Object.freeze([
    'publicUseConfirmed',
    'containsMinors',
    'guardianApprovalConfirmed',
    'privateEvidenceReference'
]);
const CATALOG_SNAPSHOT_KEYS = Object.freeze([
    'schemaVersion',
    'exportBundleId',
    'sourceRevision',
    'suppressionRevision',
    'suppressionDocument',
    'sites'
]);
const SITE_SNAPSHOT_KEYS = Object.freeze([
    'catalog',
    'rosterEntries',
    'resultEntries'
]);
const DRAFT_ID_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const PHASE_C_TARGETS = new Set([
    'approved-for-processing',
    'rejected',
    'private-review',
    'draft'
]);
const PHASE_C_TRANSITIONS = Object.freeze({
    'approved-for-processing': 'private-review',
    rejected: 'private-review',
    'private-review': 'approved-for-processing',
    draft: 'rejected'
});
const EDITABLE_STATES = new Set(['draft', 'private-review']);
const SITE_MODES = new Set(['family', 'everyone']);

const DRAFT_SELECT = `
SELECT
    draft.draft_id,
    draft.public_item_id,
    draft.state,
    draft.state_version,
    draft.site_modes_json,
    draft.export_bundle_id,
    draft.source_revision,
    draft.suppression_revision,
    draft.item_revision,
    draft.media_type,
    draft.race_date,
    draft.race_event,
    draft.race_distance,
    draft.athlete_ids_json,
    draft.title,
    draft.caption,
    draft.alt_text,
    draft.featured,
    draft.upload_complete,
    draft.created_at,
    draft.updated_at,
    consent.consent_revision,
    consent.public_use_confirmed,
    consent.contains_minors,
    consent.guardian_approval_confirmed,
    consent.withdrawn_at
FROM gallery_drafts AS draft
LEFT JOIN draft_consent_attestations AS consent
  ON consent.draft_id = draft.draft_id
 AND consent.consent_revision = draft.active_consent_revision`;

export async function listDrafts(env, siteMode) {
    if (!validSiteMode(siteMode)) {
        return failure(400, 'invalid-request');
    }
    if (!hasReadableDatabase(env)) {
        return serviceFailure();
    }

    try {
        const result = await env.DB.prepare(
            `${DRAFT_SELECT} WHERE draft.site_modes_json = ?1 ` +
            'ORDER BY draft.updated_at DESC, draft.draft_id ASC'
        ).bind(JSON.stringify([siteMode])).all();
        const rows = Array.isArray(result?.results) ? result.results : [];
        const drafts = rows.map(rowToSafeDraft);
        return freezeResult({ ok: true, status: 200, drafts });
    } catch {
        return serviceFailure();
    }
}

export async function getDraft(env, siteMode, draftId) {
    if (
        !validSiteMode(siteMode) ||
        !DRAFT_ID_PATTERN.test(stringValue(draftId))
    ) {
        return failure(400, 'invalid-request');
    }
    if (!hasReadableDatabase(env)) {
        return serviceFailure();
    }

    try {
        const row = await firstRow(
            env.DB.prepare(
                `${DRAFT_SELECT} WHERE draft.draft_id = ?1 ` +
                'AND draft.site_modes_json = ?2'
            ).bind(draftId, JSON.stringify([siteMode]))
        );
        if (!row) {
            return failure(404, 'not-found');
        }
        return success(200, rowToSafeDraft(row));
    } catch {
        return serviceFailure();
    }
}

export async function createDraft(
    env,
    identity,
    siteMode,
    input,
    catalogSnapshot,
    now
) {
    if (
        !validSiteMode(siteMode) ||
        !validCreateInput(input) ||
        !validCatalogSnapshot(catalogSnapshot) ||
        !validOwnerIdentity(identity)
    ) {
        return failure(400, 'invalid-request');
    }
    if (!hasWritableDatabase(env)) {
        return serviceFailure();
    }

    const occurredAt = normalizeTimestamp(now);
    if (!occurredAt) {
        return serviceFailure();
    }

    try {
        const [pendingAthleteIds, duplicate] = await Promise.all([
            readPendingAthleteIds(env.DB),
            firstRow(
                env.DB.prepare(
                    'SELECT draft_id FROM gallery_drafts WHERE public_item_id = ?1'
                ).bind(input.itemInput.id)
            )
        ]);
        if (duplicate) {
            return failure(409, 'conflict');
        }

        const draftId = randomIdentifier('draft');
        const itemRevision = randomIdentifier('item');
        const consentRevision = randomIdentifier('consent');
        const actorIdentityHash = await hashIdentity(identity);
        const contractDraft = makeContractDraft({
            draftId,
            state: 'draft',
            stateVersion: 0,
            siteModes: [siteMode],
            catalogSnapshot,
            itemRevision,
            itemInput: input.itemInput,
            consent: input.consent,
            consentRevision
        });
        const context = makeApprovalContext(
            contractDraft,
            catalogSnapshot,
            pendingAthleteIds
        );
        const problems = uploadContract.validateGalleryUploadApproval(
            contractDraft,
            context
        );
        if (problems.length) {
            return validationFailure(400, problems);
        }

        const auditPayloadHash = await sha256Hex(canonicalJson({
            operation: 'create-draft',
            draft: contractDraft,
            privateEvidenceReference: input.consent.privateEvidenceReference
        }));
        const subjectReferenceHash = await sha256Hex(`draft:${draftId}`);
        const statements = [
            env.DB.prepare(`
                INSERT INTO gallery_drafts (
                    draft_id,
                    public_item_id,
                    site_modes_json,
                    export_bundle_id,
                    source_revision,
                    suppression_revision,
                    item_revision,
                    media_type,
                    race_date,
                    race_event,
                    race_distance,
                    athlete_ids_json,
                    title,
                    caption,
                    alt_text,
                    featured,
                    editorial_position,
                    verified_owner_identity_hash,
                    created_at,
                    updated_at
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                    ?11, ?12, ?13, ?14, ?15, ?16, NULL, ?17, ?18, ?18
                )
            `).bind(
                draftId,
                contractDraft.itemInput.id,
                JSON.stringify(contractDraft.siteModes),
                contractDraft.exportBundleId,
                contractDraft.sourceRevision,
                contractDraft.suppressionRevision,
                contractDraft.itemRevision,
                contractDraft.itemInput.type,
                contractDraft.itemInput.raceDate,
                contractDraft.itemInput.raceEvent,
                contractDraft.itemInput.raceDistance,
                JSON.stringify(contractDraft.itemInput.athleteIds),
                contractDraft.itemInput.title,
                contractDraft.itemInput.caption,
                contractDraft.itemInput.alt,
                contractDraft.itemInput.featured ? 1 : 0,
                actorIdentityHash,
                occurredAt
            ),
            consentInsert(env.DB, {
                draftId,
                consentRevision,
                consent: input.consent,
                actorIdentityHash,
                occurredAt
            }),
            env.DB.prepare(`
                UPDATE gallery_drafts
                SET active_consent_revision = ?2,
                    updated_at = ?3
                WHERE draft_id = ?1
                  AND state = 'draft'
                  AND state_version = 0
                  AND active_consent_revision IS NULL
            `).bind(draftId, consentRevision, occurredAt),
            auditInsert(env.DB, {
                eventType: 'draft-created',
                subjectReferenceHash,
                actorIdentityHash,
                payloadHash: auditPayloadHash,
                stateVersion: 0,
                occurredAt
            })
        ];

        try {
            await runBatch(env.DB, statements);
        } catch (error) {
            const existing = await firstRow(
                env.DB.prepare(
                    'SELECT draft_id FROM gallery_drafts WHERE public_item_id = ?1'
                ).bind(input.itemInput.id)
            );
            if (existing) {
                return failure(409, 'conflict');
            }
            throw error;
        }
        return success(201, safeDraftFromContract(
            contractDraft,
            false,
            occurredAt,
            occurredAt
        ));
    } catch {
        return serviceFailure();
    }
}

export async function updateDraftDetails(
    env,
    identity,
    siteMode,
    draftId,
    input,
    catalogSnapshot,
    now
) {
    if (
        !validSiteMode(siteMode) ||
        !DRAFT_ID_PATTERN.test(stringValue(draftId)) ||
        !validUpdateInput(input) ||
        !validCatalogSnapshot(catalogSnapshot) ||
        !validOwnerIdentity(identity)
    ) {
        return failure(400, 'invalid-request');
    }
    if (!hasWritableDatabase(env)) {
        return serviceFailure();
    }

    const occurredAt = normalizeTimestamp(now);
    if (!occurredAt) {
        return serviceFailure();
    }

    try {
        const row = await readDraftRow(env.DB, draftId, siteMode);
        if (!row) {
            return failure(404, 'not-found');
        }
        const currentDraft = rowToContractDraft(row);
        const payloadFingerprint = await sha256Hex(canonicalJson({
            operation: 'edit-details',
            draftId,
            expectedItemRevision: input.expectedItemRevision,
            siteModes: [siteMode],
            itemInput: input.itemInput,
            consent: input.consent,
            catalogRevisions: {
                exportBundleId: catalogSnapshot.exportBundleId,
                sourceRevision: catalogSnapshot.sourceRevision,
                suppressionRevision: catalogSnapshot.suppressionRevision
            }
        }));
        const existingReceipt = await readMutationReceipt(
            env.DB,
            draftId,
            input.idempotencyKey
        );
        if (existingReceipt) {
            return mutationReplay(
                existingReceipt,
                currentDraft,
                payloadFingerprint,
                input,
                row
            );
        }

        if (
            !EDITABLE_STATES.has(currentDraft.state) ||
            currentDraft.itemRevision !== input.expectedItemRevision ||
            (row.upload_complete === 1 && currentDraft.itemInput.type !== input.itemInput.type)
        ) {
            return failure(409, 'conflict');
        }

        const pendingAthleteIds = await readPendingAthleteIds(env.DB);
        const itemRevision = randomIdentifier('item');
        const consentRevision = randomIdentifier('consent');
        const nextDraft = makeContractDraft({
            draftId,
            state: currentDraft.state,
            stateVersion: currentDraft.stateVersion,
            siteModes: [siteMode],
            catalogSnapshot,
            itemRevision,
            itemInput: input.itemInput,
            consent: input.consent,
            consentRevision
        });
        const context = makeApprovalContext(
            nextDraft,
            catalogSnapshot,
            pendingAthleteIds
        );
        const problems = uploadContract.validateGalleryUploadApproval(nextDraft, context);
        if (problems.length) {
            return validationFailure(400, problems);
        }

        const actorIdentityHash = await hashIdentity(identity);
        const subjectReferenceHash = await sha256Hex(`draft:${draftId}`);
        const statements = [
            consentInsert(env.DB, {
                draftId,
                consentRevision,
                consent: input.consent,
                actorIdentityHash,
                occurredAt
            }),
            env.DB.prepare(`
                UPDATE gallery_drafts
                SET public_item_id = ?3,
                    site_modes_json = ?4,
                    export_bundle_id = ?5,
                    source_revision = ?6,
                    suppression_revision = ?7,
                    item_revision = ?8,
                    active_consent_revision = ?9,
                    media_type = ?10,
                    race_date = ?11,
                    race_event = ?12,
                    race_distance = ?13,
                    athlete_ids_json = ?14,
                    title = ?15,
                    caption = ?16,
                    alt_text = ?17,
                    featured = ?18,
                    updated_at = ?19
                WHERE draft_id = ?1
                  AND item_revision = ?2
                  AND state IN ('draft', 'private-review')
                  AND site_modes_json = ?20
            `).bind(
                draftId,
                input.expectedItemRevision,
                nextDraft.itemInput.id,
                JSON.stringify(nextDraft.siteModes),
                nextDraft.exportBundleId,
                nextDraft.sourceRevision,
                nextDraft.suppressionRevision,
                nextDraft.itemRevision,
                nextDraft.consent.revision,
                nextDraft.itemInput.type,
                nextDraft.itemInput.raceDate,
                nextDraft.itemInput.raceEvent,
                nextDraft.itemInput.raceDistance,
                JSON.stringify(nextDraft.itemInput.athleteIds),
                nextDraft.itemInput.title,
                nextDraft.itemInput.caption,
                nextDraft.itemInput.alt,
                nextDraft.itemInput.featured ? 1 : 0,
                occurredAt,
                JSON.stringify([siteMode])
            ),
            env.DB.prepare(`
                INSERT INTO draft_mutation_receipts (
                    draft_id,
                    idempotency_key,
                    mutation_kind,
                    payload_fingerprint,
                    expected_item_revision,
                    result_item_revision,
                    created_at
                ) VALUES (
                    ?1,
                    ?2,
                    CASE WHEN EXISTS (
                        SELECT 1 FROM gallery_drafts
                        WHERE draft_id = ?1 AND item_revision = ?6
                    ) THEN 'edit-details' ELSE 'stale' END,
                    ?3, ?4, ?6, ?5
                )
            `).bind(
                draftId,
                input.idempotencyKey,
                payloadFingerprint,
                input.expectedItemRevision,
                occurredAt,
                nextDraft.itemRevision
            ),
            auditInsert(env.DB, {
                eventType: 'draft-details-edited',
                subjectReferenceHash,
                actorIdentityHash,
                payloadHash: payloadFingerprint,
                stateVersion: nextDraft.stateVersion,
                occurredAt
            })
        ];

        try {
            await runBatch(env.DB, statements);
        } catch (error) {
            try {
                const [latestRow, latestReceipt] = await Promise.all([
                    readDraftRow(env.DB, draftId, siteMode),
                    readMutationReceipt(env.DB, draftId, input.idempotencyKey)
                ]);
                if (latestRow && latestReceipt) {
                    return mutationReplay(
                        latestReceipt,
                        rowToContractDraft(latestRow),
                        payloadFingerprint,
                        input,
                        latestRow
                    );
                }
                return failure(409, 'conflict');
            } catch {
                throw error;
            }
        }
        return success(
            200,
            safeDraftFromContract(
                nextDraft,
                row.upload_complete === 1,
                row.created_at,
                occurredAt
            )
        );
    } catch {
        return serviceFailure();
    }
}

export async function transitionDraft(
    env,
    identity,
    siteMode,
    draftId,
    input,
    catalogSnapshot,
    now
) {
    if (
        !validSiteMode(siteMode) ||
        !DRAFT_ID_PATTERN.test(stringValue(draftId)) ||
        !isExactObject(input, TRANSITION_KEYS) ||
        !PHASE_C_TARGETS.has(input.toState) ||
        !validCatalogSnapshot(catalogSnapshot) ||
        !validOwnerIdentity(identity)
    ) {
        return failure(400, 'invalid-request');
    }
    if (!hasWritableDatabase(env)) {
        return serviceFailure();
    }

    const occurredAt = normalizeTimestamp(now);
    if (!occurredAt) {
        return serviceFailure();
    }

    try {
        const row = await readDraftRow(env.DB, draftId, siteMode);
        if (!row) {
            return failure(404, 'not-found');
        }
        const currentDraft = rowToContractDraft(row);
        const payloadFingerprint = await sha256Hex(canonicalJson({
            operation: 'transition-draft',
            draftId,
            siteMode,
            toState: input.toState,
            expectedStateVersion: input.expectedStateVersion
        }));
        const request = {
            ...input,
            payloadFingerprint
        };
        const requestProblems = uploadContract.validateTransitionRequest(request);
        if (requestProblems.length) {
            return validationFailure(400, requestProblems);
        }

        const existingReceipt = await readTransitionReceipt(
            env.DB,
            draftId,
            input.idempotencyKey
        );
        if (existingReceipt) {
            return transitionReplay(
                existingReceipt,
                currentDraft,
                payloadFingerprint,
                input,
                row
            );
        }

        if (
            currentDraft.state !== PHASE_C_TRANSITIONS[input.toState] ||
            input.toState === 'approved-for-processing' &&
            row.upload_complete !== 1
        ) {
            return failure(409, 'conflict');
        }

        let context = {};
        if (input.toState === 'approved-for-processing') {
            const pendingAthleteIds = await readPendingAthleteIds(env.DB);
            context = makeApprovalContext(
                currentDraft,
                catalogSnapshot,
                pendingAthleteIds
            );
        }
        const transition = uploadContract.transitionGalleryUpload(
            currentDraft,
            request,
            context
        );
        if (!transition.ok) {
            return validationFailure(409, transition.problems);
        }

        const actorIdentityHash = await hashIdentity(identity);
        const subjectReferenceHash = await sha256Hex(`draft:${draftId}`);
        const receipt = transition.idempotencyRecord;
        const statements = [
            env.DB.prepare(`
                UPDATE gallery_drafts
                SET state = ?4,
                    state_version = ?3 + 1,
                    updated_at = ?5
                WHERE draft_id = ?1
                  AND state = ?2
                  AND state_version = ?3
                  AND site_modes_json = ?6
            `).bind(
                draftId,
                receipt.fromState,
                receipt.expectedStateVersion,
                receipt.toState,
                occurredAt,
                JSON.stringify([siteMode])
            ),
            env.DB.prepare(`
                INSERT INTO draft_transition_receipts (
                    draft_id,
                    idempotency_key,
                    payload_fingerprint,
                    from_state,
                    to_state,
                    expected_state_version,
                    result_state_version,
                    created_at
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6,
                    CASE WHEN changes() = 1 THEN ?7 ELSE ?6 END,
                    ?8
                )
            `).bind(
                draftId,
                receipt.idempotencyKey,
                receipt.payloadFingerprint,
                receipt.fromState,
                receipt.toState,
                receipt.expectedStateVersion,
                receipt.resultStateVersion,
                occurredAt
            ),
            auditInsert(env.DB, {
                eventType: 'draft-state-transition',
                subjectReferenceHash,
                actorIdentityHash,
                payloadHash: payloadFingerprint,
                stateVersion: receipt.resultStateVersion,
                occurredAt
            })
        ];

        try {
            await runBatch(env.DB, statements);
        } catch (error) {
            try {
                const [latestRow, latestReceipt] = await Promise.all([
                    readDraftRow(env.DB, draftId, siteMode),
                    readTransitionReceipt(env.DB, draftId, input.idempotencyKey)
                ]);
                if (latestRow && latestReceipt) {
                    return transitionReplay(
                        latestReceipt,
                        rowToContractDraft(latestRow),
                        payloadFingerprint,
                        input,
                        latestRow
                    );
                }
                return failure(409, 'conflict');
            } catch {
                throw error;
            }
        }
        return success(
            200,
            safeDraftFromContract(
                transition.draft,
                row.upload_complete === 1,
                row.created_at,
                occurredAt
            )
        );
    } catch {
        return serviceFailure();
    }
}

function validCreateInput(input) {
    return isExactObject(input, CREATE_KEYS) &&
        isExactObject(input.itemInput, ITEM_KEYS) &&
        validConsentInput(input.consent);
}

function validUpdateInput(input) {
    return isExactObject(input, UPDATE_KEYS) &&
        REVISION_PATTERN.test(stringValue(input.expectedItemRevision)) &&
        IDEMPOTENCY_KEY_PATTERN.test(stringValue(input.idempotencyKey)) &&
        isExactObject(input.itemInput, ITEM_KEYS) &&
        validConsentInput(input.consent);
}

function validConsentInput(consent) {
    if (!isExactObject(consent, CONSENT_INPUT_KEYS)) {
        return false;
    }
    const evidence = consent.privateEvidenceReference;
    return typeof consent.publicUseConfirmed === 'boolean' &&
        typeof consent.containsMinors === 'boolean' &&
        typeof consent.guardianApprovalConfirmed === 'boolean' &&
        (
            evidence === null ||
            (
                typeof evidence === 'string' &&
                evidence === evidence.trim() &&
                evidence.length >= 1 &&
                evidence.length <= 500 &&
                !/[\u0000-\u001f\u007f]/.test(evidence)
            )
        );
}

function validCatalogSnapshot(snapshot) {
    if (
        !uploadContract ||
        uploadContract.schemaVersion !== '1.0' ||
        !isExactObject(snapshot, CATALOG_SNAPSHOT_KEYS) ||
        snapshot.schemaVersion !== uploadContract.schemaVersion ||
        !REVISION_PATTERN.test(stringValue(snapshot.exportBundleId)) ||
        !REVISION_PATTERN.test(stringValue(snapshot.sourceRevision)) ||
        !REVISION_PATTERN.test(stringValue(snapshot.suppressionRevision)) ||
        !isPlainObject(snapshot.sites) ||
        !hasExactKeys(snapshot.sites, ['family', 'everyone']) ||
        globalThis.galleryContract.validateGallerySuppressionDocument(
            snapshot.suppressionDocument
        ).length > 0
    ) {
        return false;
    }

    return ['family', 'everyone'].every(siteMode => {
        const site = snapshot.sites[siteMode];
        return isExactObject(site, SITE_SNAPSHOT_KEYS) &&
            isExactObject(site.catalog, [
                'exportBundleId',
                'sourceRevision',
                'races',
                'athleteIds'
            ]) &&
            site.catalog.exportBundleId === snapshot.exportBundleId &&
            site.catalog.sourceRevision === snapshot.sourceRevision &&
            Array.isArray(site.catalog.races) &&
            Array.isArray(site.catalog.athleteIds) &&
            Array.isArray(site.rosterEntries) &&
            Array.isArray(site.resultEntries);
    });
}

function makeContractDraft({
    draftId,
    state,
    stateVersion,
    siteModes,
    catalogSnapshot,
    itemRevision,
    itemInput,
    consent,
    consentRevision
}) {
    return {
        schemaVersion: uploadContract.schemaVersion,
        draftId,
        state,
        stateVersion,
        siteModes: clone(siteModes),
        exportBundleId: catalogSnapshot.exportBundleId,
        sourceRevision: catalogSnapshot.sourceRevision,
        suppressionRevision: catalogSnapshot.suppressionRevision,
        itemRevision,
        itemInput: clone(itemInput),
        manifestItem: null,
        consent: {
            publicUseConfirmed: consent.publicUseConfirmed,
            containsMinors: consent.containsMinors,
            guardianApprovalConfirmed: consent.guardianApprovalConfirmed,
            revision: consentRevision
        },
        withdrawalEvidence: null
    };
}

function makeApprovalContext(draft, catalogSnapshot, pendingAthleteIds) {
    return {
        consentRevision: draft.consent.revision,
        suppressionDocument: catalogSnapshot.suppressionDocument,
        suppressionRevision: catalogSnapshot.suppressionRevision,
        pendingHiddenAthleteIds: pendingAthleteIds,
        siteCatalogs: {
            family: catalogSnapshot.sites.family.catalog,
            everyone: catalogSnapshot.sites.everyone.catalog
        }
    };
}

function rowToContractDraft(row) {
    const siteModes = parseJsonArray(row.site_modes_json);
    const athleteIds = parseJsonArray(row.athlete_ids_json);
    if (
        !row.consent_revision ||
        row.withdrawn_at !== null && row.withdrawn_at !== undefined ||
        ![0, 1].includes(row.public_use_confirmed) ||
        ![0, 1].includes(row.contains_minors) ||
        ![0, 1].includes(row.guardian_approval_confirmed)
    ) {
        throw new Error('Draft consent evidence is incomplete.');
    }

    return {
        schemaVersion: uploadContract.schemaVersion,
        draftId: row.draft_id,
        state: row.state,
        stateVersion: row.state_version,
        siteModes,
        exportBundleId: row.export_bundle_id,
        sourceRevision: row.source_revision,
        suppressionRevision: row.suppression_revision,
        itemRevision: row.item_revision,
        itemInput: {
            id: row.public_item_id,
            type: row.media_type,
            title: row.title,
            caption: row.caption,
            alt: row.alt_text,
            raceDate: row.race_date,
            raceEvent: row.race_event,
            raceDistance: row.race_distance,
            featured: row.featured === 1,
            athleteIds
        },
        manifestItem: null,
        consent: {
            publicUseConfirmed: row.public_use_confirmed === 1,
            containsMinors: row.contains_minors === 1,
            guardianApprovalConfirmed: row.guardian_approval_confirmed === 1,
            revision: row.consent_revision
        },
        withdrawalEvidence: null
    };
}

function rowToSafeDraft(row) {
    return safeDraftFromContract(
        rowToContractDraft(row),
        row.upload_complete === 1,
        row.created_at,
        row.updated_at
    );
}

function safeDraftFromContract(draft, uploadComplete, createdAt, updatedAt) {
    return deepFreeze({
        schemaVersion: draft.schemaVersion,
        draftId: draft.draftId,
        state: draft.state,
        stateVersion: draft.stateVersion,
        siteModes: clone(draft.siteModes),
        exportBundleId: draft.exportBundleId,
        sourceRevision: draft.sourceRevision,
        suppressionRevision: draft.suppressionRevision,
        itemRevision: draft.itemRevision,
        itemInput: clone(draft.itemInput),
        consent: clone(draft.consent),
        uploadComplete: uploadComplete === true,
        createdAt,
        updatedAt
    });
}

function consentInsert(database, {
    draftId,
    consentRevision,
    consent,
    actorIdentityHash,
    occurredAt
}) {
    return database.prepare(`
        INSERT INTO draft_consent_attestations (
            draft_id,
            consent_revision,
            public_use_confirmed,
            contains_minors,
            guardian_approval_confirmed,
            private_evidence_reference,
            verified_owner_identity_hash,
            attested_at,
            withdrawn_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL)
    `).bind(
        draftId,
        consentRevision,
        consent.publicUseConfirmed ? 1 : 0,
        consent.containsMinors ? 1 : 0,
        consent.guardianApprovalConfirmed ? 1 : 0,
        consent.privateEvidenceReference,
        actorIdentityHash,
        occurredAt
    );
}

function auditInsert(database, {
    eventType,
    subjectReferenceHash,
    actorIdentityHash,
    payloadHash,
    stateVersion,
    occurredAt
}) {
    return database.prepare(`
        INSERT INTO gallery_audit_events (
            audit_event_id,
            subject_reference_hash,
            event_type,
            state_version,
            actor_identity_hash,
            payload_hash,
            occurred_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    `).bind(
        randomIdentifier('audit'),
        subjectReferenceHash,
        eventType,
        stateVersion,
        actorIdentityHash,
        payloadHash,
        occurredAt
    );
}

async function readDraftRow(database, draftId, siteMode) {
    return firstRow(
        database.prepare(
            `${DRAFT_SELECT} WHERE draft.draft_id = ?1 ` +
            'AND draft.site_modes_json = ?2'
        ).bind(draftId, JSON.stringify([siteMode]))
    );
}

function validSiteMode(siteMode) {
    return SITE_MODES.has(siteMode);
}

async function readPendingAthleteIds(database) {
    const result = await database.prepare(`
        SELECT athlete_id
        FROM pending_athlete_exclusions
        WHERE resolved_at IS NULL
        ORDER BY athlete_id ASC
    `).all();
    if (!Array.isArray(result?.results)) {
        throw new Error('Pending exclusions are unavailable.');
    }
    return result.results.map(row => row.athlete_id);
}

async function readMutationReceipt(database, draftId, idempotencyKey) {
    return firstRow(database.prepare(`
        SELECT
            payload_fingerprint,
            expected_item_revision,
            result_item_revision
        FROM draft_mutation_receipts
        WHERE draft_id = ?1 AND idempotency_key = ?2
    `).bind(draftId, idempotencyKey));
}

async function readTransitionReceipt(database, draftId, idempotencyKey) {
    return firstRow(database.prepare(`
        SELECT
            payload_fingerprint,
            from_state,
            to_state,
            expected_state_version,
            result_state_version
        FROM draft_transition_receipts
        WHERE draft_id = ?1 AND idempotency_key = ?2
    `).bind(draftId, idempotencyKey));
}

function mutationReplay(receipt, currentDraft, fingerprint, input, row) {
    if (
        receipt.payload_fingerprint !== fingerprint ||
        receipt.expected_item_revision !== input.expectedItemRevision ||
        receipt.result_item_revision !== currentDraft.itemRevision
    ) {
        return failure(409, 'conflict');
    }
    return success(200, safeDraftFromContract(
        currentDraft,
        row.upload_complete === 1,
        row.created_at,
        row.updated_at
    ), true);
}

function transitionReplay(receipt, currentDraft, fingerprint, input, row) {
    if (
        receipt.payload_fingerprint !== fingerprint ||
        receipt.to_state !== input.toState ||
        receipt.expected_state_version !== input.expectedStateVersion ||
        receipt.result_state_version !== currentDraft.stateVersion ||
        receipt.to_state !== currentDraft.state
    ) {
        return failure(409, 'conflict');
    }
    return success(200, safeDraftFromContract(
        currentDraft,
        row.upload_complete === 1,
        row.created_at,
        row.updated_at
    ), true);
}

async function runBatch(database, statements) {
    const results = await database.batch(statements);
    if (
        !Array.isArray(results) ||
        results.length !== statements.length ||
        results.some(result => result?.success === false)
    ) {
        throw new Error('D1 batch failed.');
    }
}

async function firstRow(statement) {
    if (typeof statement.first === 'function') {
        return statement.first();
    }
    const result = await statement.all();
    return Array.isArray(result?.results) ? result.results[0] ?? null : null;
}

function hasReadableDatabase(env) {
    return env?.DB && typeof env.DB.prepare === 'function';
}

function hasWritableDatabase(env) {
    return hasReadableDatabase(env) && typeof env.DB.batch === 'function';
}

function validOwnerIdentity(identity) {
    return isPlainObject(identity) &&
        identity.type === 'browser' &&
        typeof identity.subject === 'string' &&
        identity.subject.length >= 1 &&
        identity.subject.length <= 512 &&
        !/[\u0000-\u001f\u007f]/.test(identity.subject);
}

function normalizeTimestamp(now) {
    const date = now instanceof Date
        ? new Date(now.getTime())
        : Number.isFinite(now)
            ? new Date(now)
            : null;
    return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

function randomIdentifier(kind) {
    return `${kind}_${crypto.randomUUID()}`;
}

async function sha256Hex(value) {
    const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(value));
    return [...new Uint8Array(digest)]
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
}

function canonicalJson(value) {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    if (isPlainObject(value)) {
        return `{${Object.keys(value)
            .sort()
            .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}

function parseJsonArray(value) {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
        throw new Error('Expected a JSON array.');
    }
    return parsed;
}

function isExactObject(value, keys) {
    return isPlainObject(value) && hasExactKeys(value, keys);
}

function hasExactKeys(value, keys) {
    const actual = Object.keys(value);
    return actual.length === keys.length &&
        keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function stringValue(value) {
    return typeof value === 'string' ? value : '';
}

function success(status, draft, replayed = false) {
    return freezeResult({ ok: true, status, replayed, draft });
}

function validationFailure(status, problems) {
    return failure(status, 'invalid-request', [...problems]);
}

function serviceFailure() {
    return failure(503, 'service-unavailable');
}

function failure(status, code, details) {
    const result = { ok: false, status, code };
    if (Array.isArray(details) && details.every(detail => typeof detail === 'string')) {
        result.details = [...details];
    }
    return freezeResult(result);
}

function freezeResult(result) {
    return deepFreeze(result);
}

function deepFreeze(value, seen = new Set()) {
    if (value === null || typeof value !== 'object' || seen.has(value)) {
        return value;
    }
    seen.add(value);
    Object.values(value).forEach(child => deepFreeze(child, seen));
    return Object.freeze(value);
}
