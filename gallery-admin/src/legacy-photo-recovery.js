const PRE_CANDIDATE_ABANDONMENT_SELECT = `
SELECT
    recoverable.draft_id AS draftId,
    draft.state AS draftState,
    draft.state_version AS currentStateVersion,
    recoverable.promotion_id AS promotionId,
    recoverable.processing_run_id AS processingRunId,
    recoverable.expected_state_version AS stateVersion,
    recoverable.expected_state_version AS expectedStateVersion,
    recoverable.result_state_version AS resultStateVersion,
    promotion.status AS promotionStatus,
    run.status AS runStatus
FROM gallery_abandonable_pre_candidate_photo_promotions AS recoverable
JOIN gallery_drafts AS draft ON draft.draft_id = recoverable.draft_id
JOIN draft_processing_runs AS run
  ON run.processing_run_id = recoverable.processing_run_id
 AND run.draft_id = recoverable.draft_id
JOIN draft_photo_promotions AS promotion
  ON promotion.promotion_id = recoverable.promotion_id
 AND promotion.processing_run_id = recoverable.processing_run_id
 AND promotion.draft_id = recoverable.draft_id
WHERE recoverable.draft_id = ?1`;

const PRE_CANDIDATE_ABANDONMENT_RECOVERY_SELECT = `
SELECT
    abandonment.draft_id AS draftId,
    draft.state AS draftState,
    draft.state_version AS currentStateVersion,
    abandonment.promotion_id AS promotionId,
    abandonment.processing_run_id AS processingRunId,
    abandonment.expected_state_version AS stateVersion,
    abandonment.expected_state_version AS expectedStateVersion,
    abandonment.result_state_version AS resultStateVersion,
    run.status AS runStatus
FROM draft_photo_review_abandonment_receipts AS abandonment
JOIN gallery_drafts AS draft ON draft.draft_id = abandonment.draft_id
JOIN draft_processing_runs AS run
  ON run.processing_run_id = abandonment.processing_run_id
 AND run.draft_id = abandonment.draft_id
JOIN draft_publication_references AS publication
  ON publication.draft_id = abandonment.draft_id
JOIN gallery_terminal_photo_withdrawal_transitions AS transition
  ON transition.draft_id = abandonment.draft_id
 AND transition.expected_state_version = abandonment.expected_state_version
 AND transition.result_state_version = abandonment.result_state_version
WHERE abandonment.draft_id = ?1
  AND draft.state = 'withdrawal-pending'
  AND draft.state_version = abandonment.result_state_version
  AND run.status = 'staged'
  AND run.processing_state_version = abandonment.expected_state_version
  AND publication.withdrawal_kind IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM gallery_complete_photo_withdrawal_cleanups AS cleanup
      WHERE cleanup.draft_id = abandonment.draft_id
        AND cleanup.processing_run_id = abandonment.processing_run_id
        AND cleanup.promotion_id = abandonment.promotion_id
        AND cleanup.cleanup_state_version = abandonment.result_state_version
  )`;

const PROCESSING_ONLY_RECOVERY_SELECT = `
SELECT
    source.draft_id AS draftId,
    source.draft_state AS draftState,
    source.current_state_version AS currentStateVersion,
    source.processing_run_id AS processingRunId,
    source.run_status AS runStatus,
    source.withdrawal_kind AS withdrawalKind,
    source.expected_state_version AS expectedStateVersion,
    source.cleanup_state_version AS cleanupStateVersion,
    source.transition_payload_fingerprint AS transitionPayloadFingerprint
FROM gallery_processing_only_editorial_withdrawal_sources AS source
WHERE source.draft_id = ?1`;

export async function readPreCandidateAbandonmentFacts(database, draftId) {
    return queryFirst(database, PRE_CANDIDATE_ABANDONMENT_SELECT, draftId);
}

export async function readPreCandidateAbandonmentRecoveryFacts(database, draftId) {
    return queryFirst(database, PRE_CANDIDATE_ABANDONMENT_RECOVERY_SELECT, draftId);
}

export async function readProcessingOnlyRecoveryFacts(database, draftId) {
    return queryFirst(database, PROCESSING_ONLY_RECOVERY_SELECT, draftId);
}

export function exactPreCandidateAbandonmentFacts(facts, draftId) {
    return Boolean(facts) &&
        facts.draftId === draftId &&
        /^promotion_[a-f0-9]{32}$/.test(facts.promotionId || '') &&
        /^run_[a-f0-9]{32}$/.test(facts.processingRunId || '') &&
        ['processing', 'withdrawal-pending'].includes(facts.draftState) &&
        Number.isSafeInteger(facts.stateVersion) &&
        facts.stateVersion >= 1 &&
        facts.expectedStateVersion === facts.stateVersion &&
        facts.resultStateVersion === facts.stateVersion + 1 &&
        facts.currentStateVersion === (
            facts.draftState === 'processing'
                ? facts.expectedStateVersion
                : facts.resultStateVersion
        ) &&
        facts.promotionStatus === 'active' &&
        facts.runStatus === 'staged';
}

export function exactPreCandidateAbandonmentRecoveryFacts(facts, draftId) {
    return Boolean(facts) &&
        facts.draftId === draftId &&
        /^promotion_[a-f0-9]{32}$/.test(facts.promotionId || '') &&
        /^run_[a-f0-9]{32}$/.test(facts.processingRunId || '') &&
        facts.draftState === 'withdrawal-pending' &&
        Number.isSafeInteger(facts.stateVersion) &&
        facts.stateVersion >= 1 &&
        facts.expectedStateVersion === facts.stateVersion &&
        facts.resultStateVersion === facts.stateVersion + 1 &&
        facts.currentStateVersion === facts.resultStateVersion &&
        facts.runStatus === 'staged';
}

export function exactProcessingOnlyRecoveryFacts(facts, draftId) {
    return Boolean(facts) &&
        facts.draftId === draftId &&
        /^run_[a-f0-9]{32}$/.test(facts.processingRunId || '') &&
        facts.draftState === 'withdrawal-pending' &&
        facts.runStatus === 'staged' &&
        facts.withdrawalKind === 'editorial-removal' &&
        Number.isSafeInteger(facts.expectedStateVersion) &&
        facts.expectedStateVersion >= 1 &&
        facts.cleanupStateVersion === facts.expectedStateVersion + 1 &&
        facts.currentStateVersion === facts.cleanupStateVersion &&
        /^[a-f0-9]{64}$/.test(facts.transitionPayloadFingerprint || '');
}

async function queryFirst(database, sql, ...bindings) {
    const statement = database.prepare(sql).bind(...bindings);
    if (typeof statement.first === 'function') return statement.first();
    const result = await statement.all();
    return Array.isArray(result?.results) ? result.results[0] ?? null : null;
}
