import { hashIdentity } from './session.js';

const textEncoder = new TextEncoder();
const DRAFT_ID_PATTERN =
    /^draft_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ATHLETE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const WITHDRAWAL_INPUT_KEYS = Object.freeze([
    'expectedStateVersion',
    'idempotencyKey'
]);
const EXCLUSION_INPUT_KEYS = Object.freeze([
    'athleteId',
    'idempotencyKey'
]);
const SITE_MODES = new Set(['family', 'everyone']);
const WITHDRAWAL_KINDS = new Set([
    'editorial-removal',
    'consent-withdrawal'
]);
const WITHDRAWABLE_STATES = new Set([
    'draft',
    'uploading',
    'private-review',
    'approved-for-processing',
    'processing',
    'candidate-public',
    'pr-open',
    'published',
    'rejected',
    'processing-failed'
]);

export async function initiateDraftWithdrawal(
    env,
    identity,
    siteMode,
    draftId,
    withdrawalKind,
    input,
    now
) {
    if (
        !validOwnerIdentity(identity) ||
        !SITE_MODES.has(siteMode) ||
        !DRAFT_ID_PATTERN.test(stringValue(draftId)) ||
        !WITHDRAWAL_KINDS.has(withdrawalKind) ||
        !validWithdrawalInput(input)
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
        const row = await readDraft(env.DB, draftId, siteMode);
        if (!row) {
            return failure(404, 'not-found');
        }

        const payloadFingerprint = await sha256Hex(canonicalJson({
            operation: 'initiate-draft-withdrawal',
            draftId,
            siteMode,
            withdrawalKind,
            expectedStateVersion: input.expectedStateVersion,
            idempotencyKey: input.idempotencyKey
        }));
        const replay = await readDraftWithdrawalReplay(
            env.DB,
            row,
            withdrawalKind,
            input,
            payloadFingerprint
        );
        if (replay) {
            return replay;
        }

        if (
            row.stateVersion !== input.expectedStateVersion ||
            row.state === 'withdrawn' ||
            !WITHDRAWABLE_STATES.has(row.state) && row.state !== 'withdrawal-pending'
        ) {
            return failure(409, 'conflict');
        }

        const actorIdentityHash = await hashIdentity(identity);
        const subjectReferenceHash = await sha256Hex(`draft:${draftId}`);
        const statements = publicationIntentStatements(env.DB, {
            draftId,
            expectedState: row.state,
            expectedStateVersion: row.stateVersion,
            withdrawalKind,
            occurredAt
        });

        if (WITHDRAWABLE_STATES.has(row.state)) {
            statements.push(
                env.DB.prepare(`
                    UPDATE gallery_drafts
                    SET state = 'withdrawal-pending',
                        state_version = state_version + 1,
                        updated_at = ?4
                    WHERE draft_id = ?1
                      AND state = ?2
                      AND state_version = ?3
                      AND site_modes_json = ?5
                `).bind(
                    draftId,
                    row.state,
                    row.stateVersion,
                    occurredAt,
                    JSON.stringify([siteMode])
                ),
                transitionReceiptInsert(env.DB, {
                    draftId,
                    idempotencyKey: input.idempotencyKey,
                    payloadFingerprint,
                    fromState: row.state,
                    expectedStateVersion: row.stateVersion,
                    occurredAt
                }),
                auditInsert(env.DB, {
                    auditEventId: randomIdentifier('audit'),
                    eventType: `${withdrawalKind}-initiated`,
                    subjectReferenceHash,
                    actorIdentityHash,
                    payloadHash: payloadFingerprint,
                    stateVersion: row.stateVersion + 1,
                    occurredAt
                })
            );
        } else {
            statements.push(guardedPendingWithdrawalAuditInsert(env.DB, {
                auditEventId: pendingWithdrawalAuditId(payloadFingerprint),
                eventType: `${withdrawalKind}-escalated`,
                subjectReferenceHash,
                actorIdentityHash,
                payloadHash: payloadFingerprint,
                stateVersion: row.stateVersion,
                occurredAt,
                draftId,
                withdrawalKind
            }));
        }

        try {
            await runBatch(env.DB, statements);
        } catch (error) {
            const latest = await readDraft(env.DB, draftId, siteMode);
            const concurrentReplay = latest && await readDraftWithdrawalReplay(
                env.DB,
                latest,
                withdrawalKind,
                input,
                payloadFingerprint
            );
            if (concurrentReplay) {
                return concurrentReplay;
            }
            return failure(409, 'conflict');
        }
        const completedRow = await readDraft(env.DB, draftId, siteMode);
        if (!draftWithdrawalResultMatches(
            completedRow,
            row.state,
            withdrawalKind,
            input.expectedStateVersion
        )) {
            return failure(409, 'conflict');
        }
        return success(200, [draftId]);
    } catch {
        return serviceFailure();
    }
}

export async function initiateAthleteExclusion(
    env,
    identity,
    siteMode,
    input,
    catalogSnapshot,
    now
) {
    if (
        !validOwnerIdentity(identity) ||
        !SITE_MODES.has(siteMode) ||
        !validExclusionInput(input)
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
        const actorIdentityHash = await hashIdentity(identity);
        const existingReceipt = await readExclusionReceipt(
            env.DB,
            input.athleteId
        );
        if (existingReceipt) {
            const existingExclusion = await readPendingExclusion(
                env.DB,
                input.athleteId
            );
            return await exclusionReplay(
                existingExclusion,
                existingReceipt,
                actorIdentityHash,
                input.athleteId,
                input.idempotencyKey
            );
        }

        if (!isCurrentPublicAthlete(
            catalogSnapshot,
            siteMode,
            input.athleteId
        )) {
            return failure(400, 'invalid-request');
        }

        const expectedSuppressionRevision = catalogSnapshot.suppressionRevision;
        const {
            requestAuditHash,
            idempotencyKeyHash,
            payloadFingerprint
        } = await exclusionRequestEvidence(
            input.athleteId,
            input.idempotencyKey,
            expectedSuppressionRevision
        );
        const existing = await readPendingExclusion(env.DB, input.athleteId);
        if (existing) {
            return failure(409, 'conflict');
        }

        const affectedRows = await readAffectedDrafts(env.DB, input.athleteId);

        const exclusionRevision = `exclusion_${requestAuditHash}`;
        const athleteSubjectHash = await sha256Hex(`athlete:${input.athleteId}`);
        const statements = [
            env.DB.prepare(`
                INSERT INTO pending_athlete_exclusions (
                    athlete_id,
                    exclusion_revision,
                    expected_suppression_revision,
                    request_audit_hash,
                    actor_identity_hash,
                    created_at,
                    updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
            `).bind(
                input.athleteId,
                exclusionRevision,
                expectedSuppressionRevision,
                requestAuditHash,
                actorIdentityHash,
                occurredAt
            ),
            await exclusionReceiptInsert(env.DB, {
                athleteId: input.athleteId,
                requestAuditHash,
                idempotencyKeyHash,
                payloadFingerprint,
                actorIdentityHash,
                expectedSuppressionRevision,
                affectedDraftIds: affectedRows.map(row => row.draftId),
                occurredAt
            }),
            auditInsert(env.DB, {
                auditEventId: `audit_${requestAuditHash}`,
                eventType: 'athlete-exclusion-initiated',
                subjectReferenceHash: athleteSubjectHash,
                actorIdentityHash,
                payloadHash: requestAuditHash,
                stateVersion: null,
                occurredAt
            })
        ];

        for (const row of affectedRows) {
            statements.push(...publicationIntentStatements(env.DB, {
                draftId: row.draftId,
                expectedState: row.state,
                expectedStateVersion: row.stateVersion,
                withdrawalKind: 'athlete-exclusion',
                occurredAt
            }));

            const draftSubjectHash = await sha256Hex(`draft:${row.draftId}`);
            const draftPayloadFingerprint = await sha256Hex(canonicalJson({
                operation: 'apply-athlete-exclusion-to-draft',
                exclusionRevision,
                draftId: row.draftId,
                fromState: row.state,
                expectedStateVersion: row.stateVersion
            }));

            if (WITHDRAWABLE_STATES.has(row.state)) {
                const transitionIdempotencyKey = await sha256Hex(
                    `athlete-exclusion-transition:${input.idempotencyKey}:${row.draftId}`
                );
                statements.push(
                    env.DB.prepare(`
                        UPDATE gallery_drafts
                        SET state = 'withdrawal-pending',
                            state_version = state_version + 1,
                            updated_at = ?4
                        WHERE draft_id = ?1
                          AND state = ?2
                          AND state_version = ?3
                          AND EXISTS (
                              SELECT 1 FROM json_each(athlete_ids_json) AS tag
                              WHERE tag.value = ?5
                          )
                    `).bind(
                        row.draftId,
                        row.state,
                        row.stateVersion,
                        occurredAt,
                        input.athleteId
                    ),
                    transitionReceiptInsert(env.DB, {
                        draftId: row.draftId,
                        idempotencyKey: transitionIdempotencyKey,
                        payloadFingerprint: draftPayloadFingerprint,
                        fromState: row.state,
                        expectedStateVersion: row.stateVersion,
                        occurredAt
                    })
                );
            }

            statements.push(auditInsert(env.DB, {
                auditEventId: randomIdentifier('audit'),
                eventType: 'athlete-exclusion-applied',
                subjectReferenceHash: draftSubjectHash,
                actorIdentityHash,
                payloadHash: draftPayloadFingerprint,
                stateVersion: WITHDRAWABLE_STATES.has(row.state)
                    ? row.stateVersion + 1
                    : row.stateVersion,
                occurredAt
            }));
        }

        try {
            await runBatch(env.DB, statements);
        } catch (error) {
            const receipt = await readExclusionReceipt(env.DB, input.athleteId);
            if (receipt) {
                const concurrent = await readPendingExclusion(
                    env.DB,
                    input.athleteId
                );
                return await exclusionReplay(
                    concurrent,
                    receipt,
                    actorIdentityHash,
                    input.athleteId,
                    input.idempotencyKey
                );
            }
            return failure(409, 'conflict');
        }
        const [completedExclusion, completedReceipt] = await Promise.all([
            readPendingExclusion(env.DB, input.athleteId),
            readExclusionReceipt(env.DB, input.athleteId)
        ]);
        const completed = await exclusionReplay(
            completedExclusion,
            completedReceipt,
            actorIdentityHash,
            input.athleteId,
            input.idempotencyKey,
            false,
            201
        );
        return completed || serviceFailure();
    } catch {
        return serviceFailure();
    }
}

function publicationIntentStatements(database, {
    draftId,
    expectedState,
    expectedStateVersion,
    withdrawalKind,
    occurredAt
}) {
    return [
        database.prepare(`
            INSERT INTO draft_publication_references (
                draft_id,
                workflow_run_reference,
                candidate_branch_reference,
                pull_request_reference,
                merge_commit_reference,
                host_deletion_confirmed,
                private_original_deletion_confirmed,
                withdrawal_kind,
                updated_at
            )
            SELECT ?1, NULL, NULL, NULL, NULL, 0, 0, ?4, ?5
            WHERE EXISTS (
                SELECT 1 FROM gallery_drafts
                WHERE draft_id = ?1 AND state = ?2 AND state_version = ?3
            ) AND NOT EXISTS (
                SELECT 1 FROM draft_publication_references WHERE draft_id = ?1
            )
        `).bind(
            draftId,
            expectedState,
            expectedStateVersion,
            withdrawalKind,
            occurredAt
        ),
        database.prepare(`
            UPDATE draft_publication_references
            SET withdrawal_kind = CASE
                    WHEN ?4 = 'consent-withdrawal' THEN 'consent-withdrawal'
                    WHEN withdrawal_kind IS NULL THEN ?4
                    ELSE withdrawal_kind
                END,
                updated_at = ?5
            WHERE draft_id = ?1
              AND EXISTS (
                  SELECT 1 FROM gallery_drafts
                  WHERE draft_id = ?1 AND state = ?2 AND state_version = ?3
              )
        `).bind(
            draftId,
            expectedState,
            expectedStateVersion,
            withdrawalKind,
            occurredAt
        )
    ];
}

function transitionReceiptInsert(database, {
    draftId,
    idempotencyKey,
    payloadFingerprint,
    fromState,
    expectedStateVersion,
    occurredAt
}) {
    return database.prepare(`
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
            ?1, ?2, ?3, ?4, 'withdrawal-pending', ?5,
            CASE WHEN changes() = 1 THEN ?5 + 1 ELSE ?5 END,
            ?6
        )
    `).bind(
        draftId,
        idempotencyKey,
        payloadFingerprint,
        fromState,
        expectedStateVersion,
        occurredAt
    );
}

async function exclusionReceiptInsert(database, {
    athleteId,
    requestAuditHash,
    idempotencyKeyHash,
    payloadFingerprint,
    actorIdentityHash,
    expectedSuppressionRevision,
    affectedDraftIds,
    occurredAt
}) {
    const sortedDraftIds = [...affectedDraftIds].sort();
    const affectedDraftIdsJson = JSON.stringify(sortedDraftIds);
    return database.prepare(`
        INSERT INTO athlete_exclusion_request_receipts (
            athlete_id,
            request_audit_hash,
            idempotency_key_hash,
            payload_fingerprint,
            actor_identity_hash,
            expected_suppression_revision,
            affected_draft_ids_json,
            affected_draft_ids_hash,
            affected_draft_count,
            created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
    `).bind(
        athleteId,
        requestAuditHash,
        idempotencyKeyHash,
        payloadFingerprint,
        actorIdentityHash,
        expectedSuppressionRevision,
        affectedDraftIdsJson,
        await sha256Hex(affectedDraftIdsJson),
        sortedDraftIds.length,
        occurredAt
    );
}

function auditInsert(database, {
    auditEventId,
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
        auditEventId,
        subjectReferenceHash,
        eventType,
        stateVersion,
        actorIdentityHash,
        payloadHash,
        occurredAt
    );
}

function guardedPendingWithdrawalAuditInsert(database, {
    auditEventId,
    eventType,
    subjectReferenceHash,
    actorIdentityHash,
    payloadHash,
    stateVersion,
    occurredAt,
    draftId,
    withdrawalKind
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
        )
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
        WHERE EXISTS (
            SELECT 1
            FROM gallery_drafts AS draft
            JOIN draft_publication_references AS publication
              ON publication.draft_id = draft.draft_id
            WHERE draft.draft_id = ?8
              AND draft.state = 'withdrawal-pending'
              AND draft.state_version = ?4
              AND (
                  (?9 = 'consent-withdrawal' AND
                   publication.withdrawal_kind = 'consent-withdrawal') OR
                  (?9 = 'editorial-removal' AND
                   publication.withdrawal_kind IN (
                       'editorial-removal', 'athlete-exclusion', 'consent-withdrawal'
                   ))
              )
        )
    `).bind(
        auditEventId,
        subjectReferenceHash,
        eventType,
        stateVersion,
        actorIdentityHash,
        payloadHash,
        occurredAt,
        draftId,
        withdrawalKind
    );
}

async function readDraftWithdrawalReplay(
    database,
    row,
    withdrawalKind,
    input,
    payloadFingerprint
) {
    const receipt = await firstRow(database.prepare(`
        SELECT
            payload_fingerprint AS payloadFingerprint,
            to_state AS toState,
            expected_state_version AS expectedStateVersion,
            result_state_version AS resultStateVersion
        FROM draft_transition_receipts
        WHERE draft_id = ?1 AND idempotency_key = ?2
    `).bind(row.draftId, input.idempotencyKey));

    if (receipt) {
        return receipt.payloadFingerprint === payloadFingerprint &&
            receipt.toState === 'withdrawal-pending' &&
            receipt.expectedStateVersion === input.expectedStateVersion &&
            receipt.resultStateVersion === row.stateVersion &&
            row.state === 'withdrawal-pending' &&
            withdrawalKindSatisfied(withdrawalKind, row.withdrawalKind)
            ? success(200, [row.draftId], true)
            : failure(409, 'conflict');
    }

    const pendingAudit = await firstRow(database.prepare(`
        SELECT payload_hash AS payloadHash
        FROM gallery_audit_events
        WHERE audit_event_id = ?1
    `).bind(pendingWithdrawalAuditId(payloadFingerprint)));
    if (!pendingAudit) {
        return null;
    }
    return pendingAudit.payloadHash === payloadFingerprint &&
        row.state === 'withdrawal-pending' &&
        row.stateVersion === input.expectedStateVersion &&
        withdrawalKindSatisfied(withdrawalKind, row.withdrawalKind)
        ? success(200, [row.draftId], true)
        : failure(409, 'conflict');
}

async function exclusionReplay(
    row,
    receipt,
    actorIdentityHash,
    athleteId,
    idempotencyKey,
    replayed = true,
    status = 200
) {
    if (
        !receipt ||
        receipt.athleteId !== athleteId ||
        typeof receipt.expectedSuppressionRevision !== 'string' ||
        receipt.expectedSuppressionRevision.length < 1
    ) {
        return failure(409, 'conflict');
    }
    const {
        requestAuditHash,
        idempotencyKeyHash,
        payloadFingerprint
    } = await exclusionRequestEvidence(
        athleteId,
        idempotencyKey,
        receipt.expectedSuppressionRevision
    );
    if (
        receipt.requestAuditHash !== requestAuditHash ||
        receipt.idempotencyKeyHash !== idempotencyKeyHash ||
        receipt.payloadFingerprint !== payloadFingerprint ||
        receipt.actorIdentityHash !== actorIdentityHash ||
        (row !== null && (
            row.athleteId !== receipt.athleteId ||
            row.actorIdentityHash !== receipt.actorIdentityHash ||
            row.expectedSuppressionRevision !==
                receipt.expectedSuppressionRevision ||
            row.requestAuditHash !== receipt.requestAuditHash ||
            !(row.resolvedAt === null || (
                typeof row.resolvedAt === 'string' &&
                row.resolvedAt.length > 0
            ))
        ))
    ) {
        return failure(409, 'conflict');
    }
    const affectedDraftIds = await parseAffectedDraftIds(receipt);
    return affectedDraftIds
        ? success(status, affectedDraftIds, replayed)
        : serviceFailure();
}

async function readDraft(database, draftId, siteMode) {
    return firstRow(database.prepare(`
        SELECT
            draft.draft_id AS draftId,
            draft.state,
            draft.state_version AS stateVersion,
            publication.withdrawal_kind AS withdrawalKind
        FROM gallery_drafts AS draft
        LEFT JOIN draft_publication_references AS publication
          ON publication.draft_id = draft.draft_id
        WHERE draft.draft_id = ?1 AND draft.site_modes_json = ?2
    `).bind(draftId, JSON.stringify([siteMode])));
}

async function readAffectedDrafts(database, athleteId) {
    const result = await database.prepare(`
        SELECT DISTINCT
            draft.draft_id AS draftId,
            draft.state,
            draft.state_version AS stateVersion,
            draft.site_modes_json AS siteModesJson
        FROM gallery_drafts AS draft
        JOIN json_each(draft.athlete_ids_json) AS tag
          ON tag.value = ?1
        WHERE draft.state <> 'withdrawn'
        ORDER BY draft.draft_id ASC
    `).bind(athleteId).all();
    if (!Array.isArray(result?.results)) {
        throw new Error('Affected Gallery drafts are unavailable.');
    }
    return result.results;
}

async function readPendingExclusion(database, athleteId) {
    return firstRow(database.prepare(`
        SELECT
            athlete_id AS athleteId,
            expected_suppression_revision AS expectedSuppressionRevision,
            request_audit_hash AS requestAuditHash,
            actor_identity_hash AS actorIdentityHash,
            resolved_at AS resolvedAt
        FROM pending_athlete_exclusions
        WHERE athlete_id = ?1
    `).bind(athleteId));
}

async function readExclusionReceipt(database, athleteId) {
    return firstRow(database.prepare(`
        SELECT
            athlete_id AS athleteId,
            request_audit_hash AS requestAuditHash,
            idempotency_key_hash AS idempotencyKeyHash,
            payload_fingerprint AS payloadFingerprint,
            actor_identity_hash AS actorIdentityHash,
            expected_suppression_revision AS expectedSuppressionRevision,
            affected_draft_ids_json AS affectedDraftIdsJson,
            affected_draft_ids_hash AS affectedDraftIdsHash,
            affected_draft_count AS affectedDraftCount
        FROM athlete_exclusion_request_receipts
        WHERE athlete_id = ?1
    `).bind(athleteId));
}

async function exclusionRequestEvidence(
    athleteId,
    idempotencyKey,
    expectedSuppressionRevision
) {
    return {
        requestAuditHash: await sha256Hex(canonicalJson({
            operation: 'initiate-athlete-exclusion',
            athleteId,
            expectedSuppressionRevision,
            idempotencyKey
        })),
        idempotencyKeyHash: await sha256Hex(
            `athlete-exclusion-idempotency-key:${idempotencyKey}`
        ),
        payloadFingerprint: await sha256Hex(canonicalJson({
            operation: 'initiate-athlete-exclusion',
            athleteId,
            expectedSuppressionRevision
        }))
    };
}

async function parseAffectedDraftIds(receipt) {
    try {
        const parsed = JSON.parse(receipt.affectedDraftIdsJson);
        if (
            !Array.isArray(parsed) ||
            parsed.length !== receipt.affectedDraftCount ||
            parsed.some(id => !DRAFT_ID_PATTERN.test(id)) ||
            new Set(parsed).size !== parsed.length ||
            parsed.some((id, index) => index > 0 && id <= parsed[index - 1]) ||
            await sha256Hex(receipt.affectedDraftIdsJson) !== receipt.affectedDraftIdsHash
        ) {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

function draftWithdrawalResultMatches(
    row,
    fromState,
    withdrawalKind,
    expectedStateVersion
) {
    const expectedResultVersion = WITHDRAWABLE_STATES.has(fromState)
        ? expectedStateVersion + 1
        : expectedStateVersion;
    return row !== null &&
        row.state === 'withdrawal-pending' &&
        row.stateVersion === expectedResultVersion &&
        withdrawalKindSatisfied(withdrawalKind, row.withdrawalKind);
}

function isCurrentPublicAthlete(snapshot, siteMode, athleteId) {
    if (
        !ATHLETE_ID_PATTERN.test(stringValue(athleteId)) ||
        !isPlainObject(snapshot) ||
        typeof snapshot.suppressionRevision !== 'string' ||
        snapshot.suppressionRevision.length < 1 ||
        !isPlainObject(snapshot.suppressionDocument) ||
        !Array.isArray(snapshot.suppressionDocument.hiddenAthleteIds) ||
        !isPlainObject(snapshot.sites) ||
        !isPlainObject(snapshot.sites[siteMode]) ||
        !Array.isArray(snapshot.sites[siteMode].rosterEntries)
    ) {
        return false;
    }
    if (snapshot.suppressionDocument.hiddenAthleteIds.includes(athleteId)) {
        return false;
    }
    return snapshot.sites[siteMode].rosterEntries.some(entry =>
        isPlainObject(entry) && entry.athleteId === athleteId
    );
}

function validWithdrawalInput(input) {
    return isExactObject(input, WITHDRAWAL_INPUT_KEYS) &&
        Number.isSafeInteger(input.expectedStateVersion) &&
        input.expectedStateVersion >= 0 &&
        IDEMPOTENCY_KEY_PATTERN.test(stringValue(input.idempotencyKey));
}

function validExclusionInput(input) {
    return isExactObject(input, EXCLUSION_INPUT_KEYS) &&
        ATHLETE_ID_PATTERN.test(stringValue(input.athleteId)) &&
        input.athleteId.length <= 100 &&
        IDEMPOTENCY_KEY_PATTERN.test(stringValue(input.idempotencyKey));
}

function withdrawalKindSatisfied(requested, actual) {
    if (requested === 'consent-withdrawal') {
        return actual === 'consent-withdrawal';
    }
    return [
        'editorial-removal',
        'athlete-exclusion',
        'consent-withdrawal'
    ].includes(actual);
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

function hasWritableDatabase(env) {
    return env?.DB &&
        typeof env.DB.prepare === 'function' &&
        typeof env.DB.batch === 'function';
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

function pendingWithdrawalAuditId(payloadFingerprint) {
    return `audit_${payloadFingerprint}`;
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

function isExactObject(value, keys) {
    return isPlainObject(value) &&
        Object.keys(value).length === keys.length &&
        keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function stringValue(value) {
    return typeof value === 'string' ? value : '';
}

function success(status, affectedDraftIds, replayed = false) {
    return deepFreeze({
        ok: true,
        status,
        replayed,
        affectedDraftIds: [...affectedDraftIds].sort()
    });
}

function serviceFailure() {
    return failure(503, 'service-unavailable');
}

function failure(status, code) {
    return deepFreeze({ ok: false, status, code });
}

function deepFreeze(value, seen = new Set()) {
    if (value === null || typeof value !== 'object' || seen.has(value)) {
        return value;
    }
    seen.add(value);
    Object.values(value).forEach(child => deepFreeze(child, seen));
    return Object.freeze(value);
}
