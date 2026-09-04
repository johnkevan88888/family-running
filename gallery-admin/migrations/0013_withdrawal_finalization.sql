PRAGMA foreign_keys = ON;

-- Exactly one terminal review/abandonment source must have both approved-media
-- and private-processing cleanup, with the live rows matching their permanent
-- tombstones. These views make that positive proof reusable at both gates.
CREATE VIEW gallery_terminal_photo_review_invalidations AS
SELECT review.draft_id, review.promotion_id, review.processing_run_id,
       review.candidate_state_version + 1 AS cleanup_state_version
FROM draft_photo_review_receipts AS review
WHERE review.status = 'terminal'
UNION ALL
SELECT abandonment.draft_id, abandonment.promotion_id,
       abandonment.processing_run_id, abandonment.result_state_version
FROM draft_photo_review_abandonment_receipts AS abandonment;

CREATE VIEW gallery_complete_photo_review_invalidation_cleanups AS
SELECT invalidation.draft_id, invalidation.promotion_id,
       invalidation.processing_run_id, invalidation.cleanup_state_version,
       promotion_cleanup.withdrawal_kind
FROM gallery_terminal_photo_review_invalidations AS invalidation
JOIN draft_photo_promotion_cleanups AS promotion_cleanup
  ON promotion_cleanup.promotion_id = invalidation.promotion_id
 AND promotion_cleanup.processing_run_id = invalidation.processing_run_id
 AND promotion_cleanup.draft_id = invalidation.draft_id
 AND promotion_cleanup.expected_state_version = invalidation.cleanup_state_version
 AND promotion_cleanup.status = 'cleaned'
JOIN gallery_photo_promotion_cleanup_tombstones AS promotion_tombstone
  ON promotion_tombstone.cleanup_id_hash = promotion_cleanup.cleanup_id_hash
 AND promotion_tombstone.promotion_id_hash = promotion_cleanup.promotion_id_hash
 AND promotion_tombstone.processing_run_id_hash = promotion_cleanup.processing_run_id_hash
 AND promotion_tombstone.draft_id_hash = promotion_cleanup.draft_id_hash
 AND promotion_tombstone.source_promotion_idempotency_key_hash =
     promotion_cleanup.source_promotion_idempotency_key_hash
 AND promotion_tombstone.source_promotion_payload_fingerprint =
     promotion_cleanup.source_promotion_payload_fingerprint
 AND promotion_tombstone.cleanup_idempotency_key_hash =
     promotion_cleanup.cleanup_idempotency_key_hash
 AND promotion_tombstone.cleanup_payload_fingerprint = promotion_cleanup.payload_fingerprint
 AND promotion_tombstone.cleanup_reason = promotion_cleanup.cleanup_reason
 AND promotion_tombstone.withdrawal_kind IS promotion_cleanup.withdrawal_kind
 AND promotion_tombstone.evidence_hash = promotion_cleanup.cleanup_evidence_hash
 AND promotion_tombstone.completed_at = promotion_cleanup.completed_at
JOIN draft_processing_cleanups AS processing_cleanup
  ON processing_cleanup.processing_run_id = invalidation.processing_run_id
 AND processing_cleanup.draft_id = invalidation.draft_id
 AND processing_cleanup.expected_state_version = invalidation.cleanup_state_version
 AND processing_cleanup.status = 'cleaned'
JOIN gallery_processing_cleanup_tombstones AS processing_tombstone
  ON processing_tombstone.cleanup_id_hash = processing_cleanup.cleanup_id_hash
 AND processing_tombstone.draft_id_hash = processing_cleanup.draft_id_hash
 AND processing_tombstone.processing_run_id_hash = processing_cleanup.processing_run_id_hash
 AND processing_tombstone.cleanup_reason = processing_cleanup.cleanup_reason
 AND processing_tombstone.evidence_hash = processing_cleanup.cleanup_evidence_hash
 AND processing_tombstone.completed_at = processing_cleanup.completed_at
WHERE (
    promotion_cleanup.cleanup_reason = 'withdrawal' AND
    promotion_cleanup.withdrawal_kind IN ('editorial-removal', 'consent-withdrawal') AND
    processing_cleanup.cleanup_reason = 'withdrawal'
) OR (
    promotion_cleanup.cleanup_reason = 'athlete-exclusion' AND
    promotion_cleanup.withdrawal_kind = 'athlete-exclusion' AND
    processing_cleanup.cleanup_reason = 'athlete-exclusion'
);

-- A withdrawal authorization never becomes a purge authorization. Each draft
-- has a separate operation, idempotency hash and payload for each action.
CREATE TABLE draft_withdrawal_finalization_operations (
    operation_id TEXT PRIMARY KEY
        CHECK (length(operation_id) BETWEEN 20 AND 128 AND operation_id NOT GLOB '*[^A-Za-z0-9_-]*'),
    operation_id_hash TEXT NOT NULL UNIQUE CHECK (length(operation_id_hash) = 64 AND operation_id_hash NOT GLOB '*[^0-9a-f]*'),
    draft_id TEXT NOT NULL,
    draft_id_hash TEXT NOT NULL CHECK (length(draft_id_hash) = 64 AND draft_id_hash NOT GLOB '*[^0-9a-f]*'),
    action TEXT NOT NULL CHECK (action IN ('withdrawal', 'purge')),
    expected_state_version INTEGER NOT NULL CHECK (expected_state_version >= 0),
    withdrawal_kind TEXT NOT NULL CHECK (withdrawal_kind IN ('editorial-removal', 'athlete-exclusion', 'consent-withdrawal')),
    withdrawal_cycle_hash TEXT NOT NULL CHECK (length(withdrawal_cycle_hash) = 64 AND withdrawal_cycle_hash NOT GLOB '*[^0-9a-f]*'),
    public_host_verification_id_hash TEXT NOT NULL CHECK (length(public_host_verification_id_hash) = 64 AND public_host_verification_id_hash NOT GLOB '*[^0-9a-f]*'),
    public_host_final_receipt_hash TEXT NOT NULL CHECK (length(public_host_final_receipt_hash) = 64 AND public_host_final_receipt_hash NOT GLOB '*[^0-9a-f]*'),
    withdrawal_receipt_hash TEXT CHECK (withdrawal_receipt_hash IS NULL OR (length(withdrawal_receipt_hash) = 64 AND withdrawal_receipt_hash NOT GLOB '*[^0-9a-f]*')),
    idempotency_key_hash TEXT NOT NULL UNIQUE CHECK (length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'),
    payload_fingerprint TEXT NOT NULL UNIQUE CHECK (length(payload_fingerprint) = 64 AND payload_fingerprint NOT GLOB '*[^0-9a-f]*'),
    service_actor_identity_hash TEXT NOT NULL CHECK (length(service_actor_identity_hash) = 64 AND service_actor_identity_hash NOT GLOB '*[^0-9a-f]*'),
    status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'completed')),
    reserved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    completed_at TEXT,
    withdrawn_at TEXT,
    retention_eligible_at TEXT,
    UNIQUE (draft_id, action),
    UNIQUE (draft_id_hash, action),
    FOREIGN KEY (draft_id) REFERENCES gallery_drafts(draft_id) ON DELETE CASCADE,
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', reserved_at) = reserved_at),
    CHECK (completed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) = completed_at),
    CHECK (withdrawn_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', withdrawn_at) = withdrawn_at),
    CHECK (retention_eligible_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', retention_eligible_at) = retention_eligible_at),
    CHECK ((action = 'withdrawal' AND withdrawal_receipt_hash IS NULL) OR (action = 'purge' AND withdrawal_receipt_hash IS NOT NULL)),
    CHECK (
        (action = 'withdrawal' AND status = 'reserved' AND completed_at IS NULL AND withdrawn_at IS NULL AND retention_eligible_at IS NULL) OR
        (action = 'withdrawal' AND status = 'completed' AND completed_at IS NOT NULL AND completed_at = withdrawn_at AND retention_eligible_at IS NOT NULL) OR
        (action = 'purge' AND status = 'reserved' AND completed_at IS NULL AND withdrawn_at IS NOT NULL AND retention_eligible_at IS NOT NULL) OR
        (action = 'purge' AND status = 'completed' AND completed_at IS NOT NULL AND withdrawn_at IS NOT NULL AND retention_eligible_at IS NOT NULL)
    )
);

-- Permanent hash-only withdrawal replay. SQLite owns the immutable withdrawal
-- time and generates the exact thirty-day deadline for non-consent removal.
CREATE TABLE gallery_withdrawal_completion_receipts (
    withdrawal_receipt_hash TEXT PRIMARY KEY CHECK (length(withdrawal_receipt_hash) = 64 AND withdrawal_receipt_hash NOT GLOB '*[^0-9a-f]*'),
    operation_id_hash TEXT NOT NULL UNIQUE CHECK (length(operation_id_hash) = 64 AND operation_id_hash NOT GLOB '*[^0-9a-f]*'),
    draft_id_hash TEXT NOT NULL UNIQUE CHECK (length(draft_id_hash) = 64 AND draft_id_hash NOT GLOB '*[^0-9a-f]*'),
    expected_state_version INTEGER NOT NULL CHECK (expected_state_version >= 0),
    result_state_version INTEGER NOT NULL CHECK (result_state_version = expected_state_version + 1),
    withdrawal_kind TEXT NOT NULL CHECK (withdrawal_kind IN ('editorial-removal', 'athlete-exclusion', 'consent-withdrawal')),
    withdrawal_cycle_hash TEXT NOT NULL CHECK (length(withdrawal_cycle_hash) = 64 AND withdrawal_cycle_hash NOT GLOB '*[^0-9a-f]*'),
    public_host_verification_id_hash TEXT NOT NULL CHECK (length(public_host_verification_id_hash) = 64 AND public_host_verification_id_hash NOT GLOB '*[^0-9a-f]*'),
    public_host_final_receipt_hash TEXT NOT NULL CHECK (length(public_host_final_receipt_hash) = 64 AND public_host_final_receipt_hash NOT GLOB '*[^0-9a-f]*'),
    promotion_set_hash TEXT NOT NULL CHECK (length(promotion_set_hash) = 64 AND promotion_set_hash NOT GLOB '*[^0-9a-f]*'),
    cleanup_evidence_set_hash TEXT NOT NULL CHECK (length(cleanup_evidence_set_hash) = 64 AND cleanup_evidence_set_hash NOT GLOB '*[^0-9a-f]*'),
    target_set_hash TEXT NOT NULL CHECK (length(target_set_hash) = 64 AND target_set_hash NOT GLOB '*[^0-9a-f]*'),
    approved_origin_hash TEXT NOT NULL CHECK (length(approved_origin_hash) = 64 AND approved_origin_hash NOT GLOB '*[^0-9a-f]*'),
    media_delivery_epoch_id_hash TEXT NOT NULL CHECK (length(media_delivery_epoch_id_hash) = 64 AND media_delivery_epoch_id_hash NOT GLOB '*[^0-9a-f]*'),
    delivery_contract_hash TEXT NOT NULL CHECK (length(delivery_contract_hash) = 64 AND delivery_contract_hash NOT GLOB '*[^0-9a-f]*'),
    delivery_version_hash TEXT NOT NULL CHECK (length(delivery_version_hash) = 64 AND delivery_version_hash NOT GLOB '*[^0-9a-f]*'),
    generation_count INTEGER NOT NULL CHECK (generation_count >= 0),
    target_count INTEGER NOT NULL CHECK (target_count >= 0),
    private_deletion_receipt_hash TEXT UNIQUE CHECK (private_deletion_receipt_hash IS NULL OR (length(private_deletion_receipt_hash) = 64 AND private_deletion_receipt_hash NOT GLOB '*[^0-9a-f]*')),
    idempotency_key_hash TEXT NOT NULL UNIQUE CHECK (length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'),
    payload_fingerprint TEXT NOT NULL UNIQUE CHECK (length(payload_fingerprint) = 64 AND payload_fingerprint NOT GLOB '*[^0-9a-f]*'),
    service_actor_identity_hash TEXT NOT NULL CHECK (length(service_actor_identity_hash) = 64 AND service_actor_identity_hash NOT GLOB '*[^0-9a-f]*'),
    withdrawn_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    retention_eligible_at TEXT GENERATED ALWAYS AS (
        CASE WHEN withdrawal_kind = 'consent-withdrawal' THEN withdrawn_at
             ELSE strftime('%Y-%m-%dT%H:%M:%fZ', withdrawn_at, '+30 days') END
    ) STORED,
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', withdrawn_at) = withdrawn_at),
    CHECK ((withdrawal_kind = 'consent-withdrawal' AND private_deletion_receipt_hash IS NOT NULL) OR (withdrawal_kind IN ('editorial-removal', 'athlete-exclusion') AND private_deletion_receipt_hash IS NULL))
);

-- Raw provider identity exists only while the parent draft exists.
CREATE TABLE draft_private_original_deletions (
    deletion_id TEXT PRIMARY KEY CHECK (length(deletion_id) BETWEEN 20 AND 128 AND deletion_id NOT GLOB '*[^A-Za-z0-9_-]*'),
    deletion_id_hash TEXT NOT NULL UNIQUE CHECK (length(deletion_id_hash) = 64 AND deletion_id_hash NOT GLOB '*[^0-9a-f]*'),
    operation_id TEXT NOT NULL UNIQUE,
    operation_id_hash TEXT NOT NULL UNIQUE CHECK (length(operation_id_hash) = 64 AND operation_id_hash NOT GLOB '*[^0-9a-f]*'),
    draft_id TEXT NOT NULL UNIQUE,
    draft_id_hash TEXT NOT NULL UNIQUE CHECK (length(draft_id_hash) = 64 AND draft_id_hash NOT GLOB '*[^0-9a-f]*'),
    upload_session_id TEXT NOT NULL UNIQUE,
    upload_session_id_hash TEXT NOT NULL UNIQUE CHECK (length(upload_session_id_hash) = 64 AND upload_session_id_hash NOT GLOB '*[^0-9a-f]*'),
    private_object_key TEXT NOT NULL UNIQUE,
    private_object_key_hash TEXT NOT NULL UNIQUE CHECK (length(private_object_key_hash) = 64 AND private_object_key_hash NOT GLOB '*[^0-9a-f]*'),
    provider_object_version TEXT NOT NULL CHECK (length(provider_object_version) BETWEEN 1 AND 256),
    provider_object_version_hash TEXT NOT NULL CHECK (length(provider_object_version_hash) = 64 AND provider_object_version_hash NOT GLOB '*[^0-9a-f]*'),
    provider_etag TEXT NOT NULL CHECK (length(provider_etag) BETWEEN 1 AND 256),
    provider_etag_hash TEXT NOT NULL CHECK (length(provider_etag_hash) = 64 AND provider_etag_hash NOT GLOB '*[^0-9a-f]*'),
    expected_byte_count INTEGER NOT NULL CHECK (expected_byte_count BETWEEN 1 AND 26214400),
    expected_sha256 TEXT NOT NULL CHECK (length(expected_sha256) = 64 AND expected_sha256 NOT GLOB '*[^0-9a-f]*'),
    reservation_head_evidence_hash TEXT NOT NULL CHECK (length(reservation_head_evidence_hash) = 64 AND reservation_head_evidence_hash NOT GLOB '*[^0-9a-f]*'),
    status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'absent')),
    terminal_kind TEXT CHECK (terminal_kind IS NULL OR terminal_kind IN ('deleted', 'not-found')),
    final_head_absence_evidence_hash TEXT CHECK (final_head_absence_evidence_hash IS NULL OR (length(final_head_absence_evidence_hash) = 64 AND final_head_absence_evidence_hash NOT GLOB '*[^0-9a-f]*')),
    prefix_absence_evidence_hash TEXT CHECK (prefix_absence_evidence_hash IS NULL OR (length(prefix_absence_evidence_hash) = 64 AND prefix_absence_evidence_hash NOT GLOB '*[^0-9a-f]*')),
    reserved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    completed_at TEXT,
    FOREIGN KEY (operation_id) REFERENCES draft_withdrawal_finalization_operations(operation_id) ON DELETE CASCADE,
    FOREIGN KEY (draft_id) REFERENCES gallery_drafts(draft_id) ON DELETE CASCADE,
    FOREIGN KEY (upload_session_id)
        REFERENCES draft_upload_sessions(upload_session_id) ON DELETE CASCADE,
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', reserved_at) = reserved_at),
    CHECK (completed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) = completed_at),
    CHECK ((status = 'reserved' AND terminal_kind IS NULL AND final_head_absence_evidence_hash IS NULL AND prefix_absence_evidence_hash IS NULL AND completed_at IS NULL) OR (status = 'absent' AND terminal_kind IS NOT NULL AND final_head_absence_evidence_hash IS NOT NULL AND prefix_absence_evidence_hash IS NOT NULL))
);

-- Permanent hash-only R2 deletion proof.
CREATE TABLE gallery_private_original_deletion_tombstones (
    deletion_receipt_hash TEXT PRIMARY KEY CHECK (length(deletion_receipt_hash) = 64 AND deletion_receipt_hash NOT GLOB '*[^0-9a-f]*'),
    deletion_id_hash TEXT NOT NULL UNIQUE CHECK (length(deletion_id_hash) = 64 AND deletion_id_hash NOT GLOB '*[^0-9a-f]*'),
    operation_id_hash TEXT NOT NULL UNIQUE CHECK (length(operation_id_hash) = 64 AND operation_id_hash NOT GLOB '*[^0-9a-f]*'),
    draft_id_hash TEXT NOT NULL UNIQUE CHECK (length(draft_id_hash) = 64 AND draft_id_hash NOT GLOB '*[^0-9a-f]*'),
    upload_session_id_hash TEXT NOT NULL UNIQUE CHECK (length(upload_session_id_hash) = 64 AND upload_session_id_hash NOT GLOB '*[^0-9a-f]*'),
    private_object_key_hash TEXT NOT NULL UNIQUE CHECK (length(private_object_key_hash) = 64 AND private_object_key_hash NOT GLOB '*[^0-9a-f]*'),
    provider_object_version_hash TEXT NOT NULL CHECK (length(provider_object_version_hash) = 64 AND provider_object_version_hash NOT GLOB '*[^0-9a-f]*'),
    provider_etag_hash TEXT NOT NULL CHECK (length(provider_etag_hash) = 64 AND provider_etag_hash NOT GLOB '*[^0-9a-f]*'),
    expected_byte_count INTEGER NOT NULL CHECK (expected_byte_count BETWEEN 1 AND 26214400),
    expected_sha256 TEXT NOT NULL CHECK (length(expected_sha256) = 64 AND expected_sha256 NOT GLOB '*[^0-9a-f]*'),
    terminal_kind TEXT NOT NULL CHECK (terminal_kind IN ('deleted', 'not-found')),
    reservation_head_evidence_hash TEXT NOT NULL CHECK (length(reservation_head_evidence_hash) = 64 AND reservation_head_evidence_hash NOT GLOB '*[^0-9a-f]*'),
    final_head_absence_evidence_hash TEXT NOT NULL CHECK (length(final_head_absence_evidence_hash) = 64 AND final_head_absence_evidence_hash NOT GLOB '*[^0-9a-f]*'),
    prefix_absence_evidence_hash TEXT NOT NULL CHECK (length(prefix_absence_evidence_hash) = 64 AND prefix_absence_evidence_hash NOT GLOB '*[^0-9a-f]*'),
    service_actor_identity_hash TEXT NOT NULL CHECK (length(service_actor_identity_hash) = 64 AND service_actor_identity_hash NOT GLOB '*[^0-9a-f]*'),
    deleted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at)
);

-- Permanent hash-only purge replay. Its AFTER INSERT trigger below performs
-- the parent deletion, so this receipt can never commit without the purge.
CREATE TABLE gallery_draft_purge_receipts (
    purge_receipt_hash TEXT PRIMARY KEY CHECK (length(purge_receipt_hash) = 64 AND purge_receipt_hash NOT GLOB '*[^0-9a-f]*'),
    operation_id_hash TEXT NOT NULL UNIQUE CHECK (length(operation_id_hash) = 64 AND operation_id_hash NOT GLOB '*[^0-9a-f]*'),
    withdrawal_operation_id_hash TEXT NOT NULL UNIQUE CHECK (length(withdrawal_operation_id_hash) = 64 AND withdrawal_operation_id_hash NOT GLOB '*[^0-9a-f]*'),
    withdrawal_receipt_hash TEXT NOT NULL UNIQUE CHECK (length(withdrawal_receipt_hash) = 64 AND withdrawal_receipt_hash NOT GLOB '*[^0-9a-f]*'),
    draft_id_hash TEXT NOT NULL UNIQUE CHECK (length(draft_id_hash) = 64 AND draft_id_hash NOT GLOB '*[^0-9a-f]*'),
    expected_state_version INTEGER NOT NULL CHECK (expected_state_version >= 1),
    withdrawal_kind TEXT NOT NULL CHECK (withdrawal_kind IN ('editorial-removal', 'athlete-exclusion', 'consent-withdrawal')),
    withdrawal_cycle_hash TEXT NOT NULL CHECK (length(withdrawal_cycle_hash) = 64 AND withdrawal_cycle_hash NOT GLOB '*[^0-9a-f]*'),
    public_host_verification_id_hash TEXT NOT NULL CHECK (length(public_host_verification_id_hash) = 64 AND public_host_verification_id_hash NOT GLOB '*[^0-9a-f]*'),
    public_host_final_receipt_hash TEXT NOT NULL CHECK (length(public_host_final_receipt_hash) = 64 AND public_host_final_receipt_hash NOT GLOB '*[^0-9a-f]*'),
    private_deletion_receipt_hash TEXT NOT NULL UNIQUE CHECK (length(private_deletion_receipt_hash) = 64 AND private_deletion_receipt_hash NOT GLOB '*[^0-9a-f]*'),
    retention_evidence_hash TEXT NOT NULL UNIQUE CHECK (length(retention_evidence_hash) = 64 AND retention_evidence_hash NOT GLOB '*[^0-9a-f]*'),
    idempotency_key_hash TEXT NOT NULL UNIQUE CHECK (length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'),
    payload_fingerprint TEXT NOT NULL UNIQUE CHECK (length(payload_fingerprint) = 64 AND payload_fingerprint NOT GLOB '*[^0-9a-f]*'),
    service_actor_identity_hash TEXT NOT NULL CHECK (length(service_actor_identity_hash) = 64 AND service_actor_identity_hash NOT GLOB '*[^0-9a-f]*'),
    withdrawn_at TEXT NOT NULL,
    retention_eligible_at TEXT NOT NULL,
    purged_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', withdrawn_at) = withdrawn_at),
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', retention_eligible_at) = retention_eligible_at),
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', purged_at) = purged_at)
);

CREATE INDEX draft_withdrawal_finalization_operations_status_index
    ON draft_withdrawal_finalization_operations(action, status, reserved_at);
CREATE INDEX draft_private_original_deletions_status_index
    ON draft_private_original_deletions(status, reserved_at);

CREATE TRIGGER draft_withdrawal_finalization_operations_no_replace_guard
BEFORE INSERT ON draft_withdrawal_finalization_operations
WHEN EXISTS (
    SELECT 1 FROM draft_withdrawal_finalization_operations AS existing
    WHERE existing.operation_id = NEW.operation_id
       OR existing.operation_id_hash = NEW.operation_id_hash
       OR existing.idempotency_key_hash = NEW.idempotency_key_hash
       OR existing.payload_fingerprint = NEW.payload_fingerprint
       OR (existing.draft_id = NEW.draft_id AND existing.action = NEW.action)
       OR (existing.draft_id_hash = NEW.draft_id_hash AND existing.action = NEW.action)
)
BEGIN
    SELECT RAISE(ABORT, 'withdrawal finalization operation replacement is forbidden');
END;

-- Reservation is possible only from the exact current state and host receipt.
-- Withdrawal also requires one positive terminal review source and both exact
-- cleanup tombstones. Purge is a new authorization over a completed withdrawal
-- and cannot be reserved before the database-owned retention deadline.
CREATE TRIGGER draft_withdrawal_finalization_operations_insert_guard
BEFORE INSERT ON draft_withdrawal_finalization_operations
WHEN NOT EXISTS (
    SELECT 1
    FROM gallery_drafts AS draft
    JOIN draft_publication_references AS publication
      ON publication.draft_id = draft.draft_id
    JOIN gallery_current_public_host_absence_receipts AS host
      ON host.draft_id = draft.draft_id
     AND host.verification_purpose = 'withdrawal'
     AND host.withdrawal_kind = NEW.withdrawal_kind
     AND host.withdrawal_cycle_hash = NEW.withdrawal_cycle_hash
     AND host.verification_id_hash = NEW.public_host_verification_id_hash
     AND host.final_receipt_hash = NEW.public_host_final_receipt_hash
    WHERE draft.draft_id = NEW.draft_id
      AND publication.withdrawal_kind = NEW.withdrawal_kind
      AND publication.host_deletion_confirmed = 1
      AND NEW.status = 'reserved'
      AND NEW.reserved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND (
          (
              NEW.action = 'withdrawal' AND
              NEW.withdrawal_receipt_hash IS NULL AND
              NEW.withdrawn_at IS NULL AND
              NEW.retention_eligible_at IS NULL AND
              draft.state = 'withdrawal-pending' AND
              draft.state_version = NEW.expected_state_version AND
              host.expected_state_version = NEW.expected_state_version AND
              NOT EXISTS (
                  SELECT 1 FROM draft_derivatives AS derivative
                  WHERE derivative.draft_id = draft.draft_id
              ) AND
              EXISTS (
                  SELECT 1 FROM draft_transition_receipts AS transition
                  WHERE transition.draft_id = draft.draft_id
                    AND transition.from_state = 'candidate-public'
                    AND transition.to_state = 'withdrawal-pending'
                    AND transition.result_state_version = NEW.expected_state_version
              ) AND
              (SELECT COUNT(*)
                 FROM gallery_terminal_photo_review_invalidations AS terminal
                WHERE terminal.draft_id = draft.draft_id) = 1 AND
              (SELECT COUNT(*)
                 FROM gallery_complete_photo_review_invalidation_cleanups AS cleanup
                WHERE cleanup.draft_id = draft.draft_id
                  AND cleanup.cleanup_state_version = NEW.expected_state_version
                  AND cleanup.withdrawal_kind = NEW.withdrawal_kind) = 1 AND
              (
                  (
                      NEW.withdrawal_kind IN ('editorial-removal', 'athlete-exclusion') AND
                      publication.private_original_deletion_confirmed = 0 AND
                      draft.active_consent_revision IS NOT NULL AND
                      EXISTS (
                          SELECT 1 FROM draft_upload_sessions AS upload
                          WHERE upload.draft_id = draft.draft_id
                            AND upload.status = 'complete'
                            AND upload.object_key = draft.original_object_key
                            AND upload.completed_sha256 = draft.original_sha256
                      )
                  ) OR (
                      NEW.withdrawal_kind = 'consent-withdrawal' AND
                      publication.private_original_deletion_confirmed = 0 AND
                      draft.active_consent_revision IS NOT NULL AND
                      EXISTS (
                          SELECT 1 FROM draft_upload_sessions AS upload
                          WHERE upload.draft_id = draft.draft_id
                            AND upload.status = 'complete'
                            AND upload.object_key = draft.original_object_key
                            AND upload.completed_sha256 = draft.original_sha256
                      )
                  )
              )
          ) OR (
              NEW.action = 'purge' AND
              NEW.withdrawal_receipt_hash IS NOT NULL AND
              draft.state = 'withdrawn' AND
              draft.state_version = NEW.expected_state_version AND
              NOT EXISTS (
                  SELECT 1 FROM gallery_retention_tombstones AS retention
                  WHERE retention.draft_id = draft.draft_id
              ) AND
              EXISTS (
                  SELECT 1
                  FROM gallery_withdrawal_completion_receipts AS withdrawal
                  JOIN draft_withdrawal_finalization_operations AS withdrawal_operation
                    ON withdrawal_operation.operation_id_hash = withdrawal.operation_id_hash
                  WHERE withdrawal.withdrawal_receipt_hash = NEW.withdrawal_receipt_hash
                    AND withdrawal.draft_id_hash = NEW.draft_id_hash
                    AND withdrawal.result_state_version = NEW.expected_state_version
                    AND withdrawal.withdrawal_kind = NEW.withdrawal_kind
                    AND withdrawal.withdrawal_cycle_hash = NEW.withdrawal_cycle_hash
                    AND withdrawal_operation.action = 'withdrawal'
                    AND withdrawal_operation.status = 'completed'
                    AND withdrawal_operation.draft_id = draft.draft_id
                    AND NEW.withdrawn_at = withdrawal.withdrawn_at
                    AND NEW.retention_eligible_at = withdrawal.retention_eligible_at
                    AND host.expected_state_version IN (
                        withdrawal.expected_state_version,
                        NEW.expected_state_version
                    )
              ) AND
              julianday('now') >= julianday(NEW.retention_eligible_at) AND
              (
                  (
                      NEW.withdrawal_kind = 'consent-withdrawal' AND
                      publication.private_original_deletion_confirmed = 1 AND
                      EXISTS (
                          SELECT 1 FROM draft_upload_sessions AS upload
                          WHERE upload.draft_id = draft.draft_id
                            AND upload.status = 'deleted'
                      )
                  ) OR (
                      NEW.withdrawal_kind IN ('editorial-removal', 'athlete-exclusion') AND
                      publication.private_original_deletion_confirmed = 0 AND
                      EXISTS (
                          SELECT 1 FROM draft_upload_sessions AS upload
                          WHERE upload.draft_id = draft.draft_id
                            AND upload.status = 'complete'
                            AND upload.object_key = draft.original_object_key
                            AND upload.completed_sha256 = draft.original_sha256
                      )
                  )
              )
          )
      )
)
BEGIN
    SELECT RAISE(ABORT, 'withdrawal finalization operation lacks exact current evidence');
END;

CREATE TRIGGER draft_withdrawal_finalization_operations_identity_guard
BEFORE UPDATE OF operation_id, operation_id_hash, draft_id, draft_id_hash,
    action, expected_state_version, withdrawal_kind, withdrawal_cycle_hash,
    withdrawal_receipt_hash, idempotency_key_hash, payload_fingerprint,
    service_actor_identity_hash, reserved_at
ON draft_withdrawal_finalization_operations
WHEN NEW.operation_id IS NOT OLD.operation_id OR
     NEW.operation_id_hash IS NOT OLD.operation_id_hash OR
     NEW.draft_id IS NOT OLD.draft_id OR
     NEW.draft_id_hash IS NOT OLD.draft_id_hash OR
     NEW.action IS NOT OLD.action OR
     NEW.expected_state_version IS NOT OLD.expected_state_version OR
     NEW.withdrawal_kind IS NOT OLD.withdrawal_kind OR
     NEW.withdrawal_cycle_hash IS NOT OLD.withdrawal_cycle_hash OR
     NEW.withdrawal_receipt_hash IS NOT OLD.withdrawal_receipt_hash OR
     NEW.idempotency_key_hash IS NOT OLD.idempotency_key_hash OR
     NEW.payload_fingerprint IS NOT OLD.payload_fingerprint OR
     NEW.service_actor_identity_hash IS NOT OLD.service_actor_identity_hash OR
     NEW.reserved_at IS NOT OLD.reserved_at
BEGIN
    SELECT RAISE(ABORT, 'withdrawal finalization operation identity is immutable');
END;

-- A still-reserved operation may bind a newer current host proof after an
-- epoch invalidation. No other identity or authorization fact may change.
CREATE TRIGGER draft_withdrawal_finalization_operations_host_refresh_guard
BEFORE UPDATE OF public_host_verification_id_hash, public_host_final_receipt_hash
ON draft_withdrawal_finalization_operations
WHEN (
    NEW.public_host_verification_id_hash IS NOT OLD.public_host_verification_id_hash OR
    NEW.public_host_final_receipt_hash IS NOT OLD.public_host_final_receipt_hash
) AND NOT EXISTS (
    SELECT 1
    FROM gallery_current_public_host_absence_receipts AS host
    WHERE OLD.status = 'reserved'
      AND host.draft_id = OLD.draft_id
      AND host.verification_purpose = 'withdrawal'
      AND host.withdrawal_kind = OLD.withdrawal_kind
      AND host.withdrawal_cycle_hash = OLD.withdrawal_cycle_hash
      AND host.verification_id_hash = NEW.public_host_verification_id_hash
      AND host.final_receipt_hash = NEW.public_host_final_receipt_hash
      AND (
          (OLD.action = 'withdrawal' AND host.expected_state_version = OLD.expected_state_version) OR
          (OLD.action = 'purge' AND host.expected_state_version IN (
              OLD.expected_state_version,
              OLD.expected_state_version - 1
          ))
      )
)
BEGIN
    SELECT RAISE(ABORT, 'withdrawal finalization host receipt refresh is not current');
END;

CREATE TRIGGER draft_withdrawal_finalization_operations_progress_guard
BEFORE UPDATE OF status, completed_at, withdrawn_at, retention_eligible_at
ON draft_withdrawal_finalization_operations
WHEN (
    NEW.status IS NOT OLD.status OR
    NEW.completed_at IS NOT OLD.completed_at OR
    NEW.withdrawn_at IS NOT OLD.withdrawn_at OR
    NEW.retention_eligible_at IS NOT OLD.retention_eligible_at
) AND NOT (
    OLD.status = 'reserved' AND NEW.status = 'completed' AND
    (
        (
            OLD.action = 'withdrawal' AND
            EXISTS (
                SELECT 1 FROM gallery_withdrawal_completion_receipts AS receipt
                WHERE receipt.operation_id_hash = OLD.operation_id_hash
                  AND receipt.draft_id_hash = OLD.draft_id_hash
                  AND receipt.withdrawn_at = NEW.withdrawn_at
                  AND receipt.retention_eligible_at = NEW.retention_eligible_at
                  AND receipt.withdrawn_at = NEW.completed_at
            )
        ) OR (
            OLD.action = 'purge' AND
            EXISTS (
                SELECT 1 FROM gallery_draft_purge_receipts AS receipt
                WHERE receipt.operation_id_hash = OLD.operation_id_hash
                  AND receipt.draft_id_hash = OLD.draft_id_hash
                  AND receipt.withdrawn_at = NEW.withdrawn_at
                  AND receipt.retention_eligible_at = NEW.retention_eligible_at
                  AND receipt.purged_at = NEW.completed_at
            )
        )
    )
)
BEGIN
    SELECT RAISE(ABORT, 'invalid withdrawal finalization operation progress');
END;

CREATE TRIGGER draft_withdrawal_finalization_operations_direct_delete_guard
BEFORE DELETE ON draft_withdrawal_finalization_operations
WHEN EXISTS (SELECT 1 FROM gallery_drafts AS draft WHERE draft.draft_id = OLD.draft_id)
BEGIN
    SELECT RAISE(ABORT, 'withdrawal finalization operation direct deletion is forbidden');
END;

CREATE TRIGGER gallery_withdrawal_completion_receipts_no_replace_guard
BEFORE INSERT ON gallery_withdrawal_completion_receipts
WHEN EXISTS (
    SELECT 1 FROM gallery_withdrawal_completion_receipts AS existing
    WHERE existing.withdrawal_receipt_hash = NEW.withdrawal_receipt_hash
       OR existing.operation_id_hash = NEW.operation_id_hash
       OR existing.draft_id_hash = NEW.draft_id_hash
       OR existing.idempotency_key_hash = NEW.idempotency_key_hash
       OR existing.payload_fingerprint = NEW.payload_fingerprint
       OR (
           NEW.private_deletion_receipt_hash IS NOT NULL AND
           existing.private_deletion_receipt_hash = NEW.private_deletion_receipt_hash
       )
)
BEGIN
    SELECT RAISE(ABORT, 'withdrawal completion receipt replacement is forbidden');
END;

-- Inserting this receipt is the sole final-withdrawal command. The guard checks
-- the exact host survivor fields as well as the live current view, a positive
-- review/abandonment source and both cleanup tombstones. Consent has already
-- deleted its original; editorial/athlete removal must still retain it.
CREATE TRIGGER gallery_withdrawal_completion_receipts_insert_guard
BEFORE INSERT ON gallery_withdrawal_completion_receipts
WHEN NOT EXISTS (
    SELECT 1
    FROM draft_withdrawal_finalization_operations AS operation
    JOIN gallery_drafts AS draft ON draft.draft_id = operation.draft_id
    JOIN draft_publication_references AS publication
      ON publication.draft_id = operation.draft_id
    JOIN gallery_current_public_host_absence_receipts AS current_host
      ON current_host.draft_id = operation.draft_id
     AND current_host.verification_purpose = 'withdrawal'
     AND current_host.withdrawal_kind = operation.withdrawal_kind
     AND current_host.expected_state_version = operation.expected_state_version
     AND current_host.withdrawal_cycle_hash = operation.withdrawal_cycle_hash
     AND current_host.verification_id_hash = operation.public_host_verification_id_hash
     AND current_host.final_receipt_hash = operation.public_host_final_receipt_hash
    JOIN gallery_public_host_absence_receipts AS host
      ON host.verification_id_hash = current_host.verification_id_hash
     AND host.final_receipt_hash = current_host.final_receipt_hash
    WHERE operation.action = 'withdrawal'
      AND operation.status = 'reserved'
      AND operation.operation_id_hash = NEW.operation_id_hash
      AND operation.draft_id_hash = NEW.draft_id_hash
      AND operation.expected_state_version = NEW.expected_state_version
      AND NEW.result_state_version = operation.expected_state_version + 1
      AND operation.withdrawal_kind = NEW.withdrawal_kind
      AND operation.withdrawal_cycle_hash = NEW.withdrawal_cycle_hash
      AND operation.public_host_verification_id_hash = NEW.public_host_verification_id_hash
      AND operation.public_host_final_receipt_hash = NEW.public_host_final_receipt_hash
      AND operation.idempotency_key_hash = NEW.idempotency_key_hash
      AND operation.payload_fingerprint = NEW.payload_fingerprint
      AND operation.service_actor_identity_hash = NEW.service_actor_identity_hash
      AND draft.state = 'withdrawal-pending'
      AND draft.state_version = operation.expected_state_version
      AND publication.withdrawal_kind = operation.withdrawal_kind
      AND publication.host_deletion_confirmed = 1
      AND NOT EXISTS (
          SELECT 1 FROM draft_derivatives AS derivative
          WHERE derivative.draft_id = draft.draft_id
      )
      AND EXISTS (
          SELECT 1 FROM draft_transition_receipts AS transition
          WHERE transition.draft_id = draft.draft_id
            AND transition.from_state = 'candidate-public'
            AND transition.to_state = 'withdrawal-pending'
            AND transition.result_state_version = operation.expected_state_version
      )
      AND (SELECT COUNT(*)
             FROM gallery_terminal_photo_review_invalidations AS terminal
            WHERE terminal.draft_id = draft.draft_id) = 1
      AND (SELECT COUNT(*)
             FROM gallery_complete_photo_review_invalidation_cleanups AS cleanup
            WHERE cleanup.draft_id = draft.draft_id
              AND cleanup.cleanup_state_version = operation.expected_state_version
              AND cleanup.withdrawal_kind = operation.withdrawal_kind) = 1
      AND host.draft_id_hash = operation.draft_id_hash
      AND host.withdrawal_cycle_hash = operation.withdrawal_cycle_hash
      AND host.verified_state_version = operation.expected_state_version
      AND host.verification_purpose = 'withdrawal'
      AND host.purpose_evidence_hash IS NULL
      AND host.promotion_set_hash = NEW.promotion_set_hash
      AND host.cleanup_evidence_set_hash = NEW.cleanup_evidence_set_hash
      AND host.target_set_hash = NEW.target_set_hash
      AND host.approved_origin_hash = NEW.approved_origin_hash
      AND host.media_delivery_epoch_id_hash = NEW.media_delivery_epoch_id_hash
      AND host.delivery_contract_hash = NEW.delivery_contract_hash
      AND host.delivery_version_hash = NEW.delivery_version_hash
      AND host.generation_count = NEW.generation_count
      AND host.target_count = NEW.target_count
      AND NEW.withdrawn_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND (
          (
              operation.withdrawal_kind IN ('editorial-removal', 'athlete-exclusion') AND
              NEW.private_deletion_receipt_hash IS NULL AND
              publication.private_original_deletion_confirmed = 0 AND
              draft.active_consent_revision IS NOT NULL AND
              EXISTS (
                  SELECT 1
                  FROM draft_upload_sessions AS upload
                  JOIN draft_consent_attestations AS consent
                    ON consent.draft_id = upload.draft_id
                   AND consent.consent_revision = upload.consent_revision
                  WHERE upload.draft_id = draft.draft_id
                    AND upload.status = 'complete'
                    AND upload.object_key = draft.original_object_key
                    AND upload.completed_sha256 = draft.original_sha256
                    AND consent.consent_revision = draft.active_consent_revision
                    AND consent.withdrawn_at IS NULL
              )
          ) OR (
              operation.withdrawal_kind = 'consent-withdrawal' AND
              NEW.private_deletion_receipt_hash IS NOT NULL AND
              publication.private_original_deletion_confirmed = 1 AND
              draft.active_consent_revision IS NULL AND
              EXISTS (
                  SELECT 1
                  FROM draft_private_original_deletions AS deletion
                  JOIN gallery_private_original_deletion_tombstones AS tombstone
                    ON tombstone.deletion_id_hash = deletion.deletion_id_hash
                   AND tombstone.operation_id_hash = deletion.operation_id_hash
                   AND tombstone.draft_id_hash = deletion.draft_id_hash
                   AND tombstone.upload_session_id_hash = deletion.upload_session_id_hash
                  JOIN draft_upload_sessions AS upload
                    ON upload.upload_session_id = deletion.upload_session_id
                  JOIN draft_consent_attestations AS consent
                    ON consent.draft_id = upload.draft_id
                   AND consent.consent_revision = upload.consent_revision
                  WHERE deletion.operation_id = operation.operation_id
                    AND deletion.draft_id = draft.draft_id
                    AND deletion.status = 'absent'
                    AND deletion.completed_at = tombstone.deleted_at
                    AND tombstone.deletion_receipt_hash = NEW.private_deletion_receipt_hash
                    AND upload.status = 'deleted'
                    AND upload.object_deleted_at = tombstone.deleted_at
                    AND consent.withdrawn_at IS NOT NULL
                    AND NEW.withdrawn_at >= consent.withdrawn_at
              )
          )
      )
)
BEGIN
    SELECT RAISE(ABORT, 'withdrawal completion receipt lacks exact final evidence');
END;

CREATE TRIGGER gallery_withdrawal_completion_receipts_no_update
BEFORE UPDATE ON gallery_withdrawal_completion_receipts
BEGIN
    SELECT RAISE(ABORT, 'withdrawal completion receipts are append-only');
END;

CREATE TRIGGER gallery_withdrawal_completion_receipts_no_delete
BEFORE DELETE ON gallery_withdrawal_completion_receipts
BEGIN
    SELECT RAISE(ABORT, 'withdrawal completion receipts are append-only');
END;

-- The state transition, its ordinary service receipt and the live operation
-- completion are consequences of one permanent receipt insert. Any failure in
-- this trigger rolls the receipt and every consequence back together.
CREATE TRIGGER gallery_withdrawal_completion_receipts_apply
AFTER INSERT ON gallery_withdrawal_completion_receipts
BEGIN
    UPDATE gallery_drafts
    SET state = 'withdrawn',
        state_version = NEW.result_state_version,
        updated_at = NEW.withdrawn_at
    WHERE draft_id = (
        SELECT operation.draft_id
        FROM draft_withdrawal_finalization_operations AS operation
        WHERE operation.operation_id_hash = NEW.operation_id_hash
          AND operation.action = 'withdrawal'
          AND operation.status = 'reserved'
    )
      AND state = 'withdrawal-pending'
      AND state_version = NEW.expected_state_version;

    INSERT INTO draft_transition_receipts (
        draft_id, idempotency_key, payload_fingerprint, from_state, to_state,
        expected_state_version, result_state_version, created_at
    )
    SELECT
        operation.draft_id,
        operation.operation_id,
        operation.payload_fingerprint,
        'withdrawal-pending',
        'withdrawn',
        NEW.expected_state_version,
        NEW.result_state_version,
        NEW.withdrawn_at
    FROM draft_withdrawal_finalization_operations AS operation
    WHERE operation.operation_id_hash = NEW.operation_id_hash
      AND operation.action = 'withdrawal'
      AND operation.status = 'reserved';

    UPDATE draft_withdrawal_finalization_operations
    SET status = 'completed',
        completed_at = NEW.withdrawn_at,
        withdrawn_at = NEW.withdrawn_at,
        retention_eligible_at = NEW.retention_eligible_at
    WHERE operation_id_hash = NEW.operation_id_hash
      AND action = 'withdrawal'
      AND status = 'reserved';
END;

CREATE TRIGGER draft_private_original_deletions_no_replace_guard
BEFORE INSERT ON draft_private_original_deletions
WHEN EXISTS (
    SELECT 1 FROM draft_private_original_deletions AS existing
    WHERE existing.deletion_id = NEW.deletion_id
       OR existing.deletion_id_hash = NEW.deletion_id_hash
       OR existing.operation_id = NEW.operation_id
       OR existing.operation_id_hash = NEW.operation_id_hash
       OR existing.draft_id = NEW.draft_id
       OR existing.draft_id_hash = NEW.draft_id_hash
       OR existing.upload_session_id = NEW.upload_session_id
       OR existing.upload_session_id_hash = NEW.upload_session_id_hash
       OR existing.private_object_key = NEW.private_object_key
       OR existing.private_object_key_hash = NEW.private_object_key_hash
)
BEGIN
    SELECT RAISE(ABORT, 'private original deletion replacement is forbidden');
END;

-- Consent deletes under the still-reserved withdrawal action. Editorial and
-- athlete removal can reserve deletion only under a later purge action, after
-- the exact database-owned thirty-day deadline.
CREATE TRIGGER draft_private_original_deletions_insert_guard
BEFORE INSERT ON draft_private_original_deletions
WHEN NOT EXISTS (
    SELECT 1
    FROM draft_withdrawal_finalization_operations AS operation
    JOIN gallery_drafts AS draft ON draft.draft_id = operation.draft_id
    JOIN draft_publication_references AS publication
      ON publication.draft_id = operation.draft_id
    JOIN draft_upload_sessions AS upload
      ON upload.draft_id = operation.draft_id
     AND upload.upload_session_id = NEW.upload_session_id
    JOIN gallery_current_public_host_absence_receipts AS host
      ON host.draft_id = operation.draft_id
     AND host.verification_purpose = 'withdrawal'
     AND host.withdrawal_kind = operation.withdrawal_kind
     AND host.withdrawal_cycle_hash = operation.withdrawal_cycle_hash
     AND host.verification_id_hash = operation.public_host_verification_id_hash
     AND host.final_receipt_hash = operation.public_host_final_receipt_hash
    WHERE operation.operation_id = NEW.operation_id
      AND operation.operation_id_hash = NEW.operation_id_hash
      AND operation.draft_id = NEW.draft_id
      AND operation.draft_id_hash = NEW.draft_id_hash
      AND operation.status = 'reserved'
      AND publication.withdrawal_kind = operation.withdrawal_kind
      AND publication.host_deletion_confirmed = 1
      AND publication.private_original_deletion_confirmed = 0
      AND draft.upload_complete = 1
      AND upload.status = 'complete'
      AND upload.object_key = draft.original_object_key
      AND upload.object_key = NEW.private_object_key
      AND upload.completed_object_version = NEW.provider_object_version
      AND upload.completed_etag = NEW.provider_etag
      AND upload.declared_byte_count = NEW.expected_byte_count
      AND upload.declared_sha256 = NEW.expected_sha256
      AND upload.completed_sha256 = NEW.expected_sha256
      AND NEW.status = 'reserved'
      AND NEW.reserved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND NOT EXISTS (
          SELECT 1 FROM gallery_private_original_deletion_tombstones AS tombstone
          WHERE tombstone.draft_id_hash = NEW.draft_id_hash
      )
      AND (
          (
              operation.action = 'withdrawal' AND
              operation.withdrawal_kind = 'consent-withdrawal' AND
              operation.expected_state_version = draft.state_version AND
              draft.state = 'withdrawal-pending' AND
              draft.active_consent_revision = upload.consent_revision AND
              host.expected_state_version = operation.expected_state_version
          ) OR (
              operation.action = 'purge' AND
              operation.withdrawal_kind IN ('editorial-removal', 'athlete-exclusion') AND
              operation.expected_state_version = draft.state_version AND
              draft.state = 'withdrawn' AND
              operation.withdrawal_receipt_hash IS NOT NULL AND
              julianday('now') >= julianday(operation.retention_eligible_at) AND
              EXISTS (
                  SELECT 1 FROM gallery_withdrawal_completion_receipts AS withdrawal
                  WHERE withdrawal.withdrawal_receipt_hash = operation.withdrawal_receipt_hash
                    AND withdrawal.draft_id_hash = operation.draft_id_hash
                    AND withdrawal.result_state_version = operation.expected_state_version
                    AND withdrawal.withdrawal_kind = operation.withdrawal_kind
                    AND withdrawal.withdrawn_at = operation.withdrawn_at
                    AND withdrawal.retention_eligible_at = operation.retention_eligible_at
              )
          )
      )
)
BEGIN
    SELECT RAISE(ABORT, 'private original deletion lacks exact reserved object evidence');
END;

CREATE TRIGGER draft_private_original_deletions_identity_guard
BEFORE UPDATE OF deletion_id, deletion_id_hash, operation_id, operation_id_hash,
    draft_id, draft_id_hash, upload_session_id, upload_session_id_hash,
    private_object_key, private_object_key_hash, provider_object_version,
    provider_object_version_hash, provider_etag, provider_etag_hash,
    expected_byte_count, expected_sha256, reservation_head_evidence_hash,
    reserved_at
ON draft_private_original_deletions
WHEN NEW.deletion_id IS NOT OLD.deletion_id OR
     NEW.deletion_id_hash IS NOT OLD.deletion_id_hash OR
     NEW.operation_id IS NOT OLD.operation_id OR
     NEW.operation_id_hash IS NOT OLD.operation_id_hash OR
     NEW.draft_id IS NOT OLD.draft_id OR
     NEW.draft_id_hash IS NOT OLD.draft_id_hash OR
     NEW.upload_session_id IS NOT OLD.upload_session_id OR
     NEW.upload_session_id_hash IS NOT OLD.upload_session_id_hash OR
     NEW.private_object_key IS NOT OLD.private_object_key OR
     NEW.private_object_key_hash IS NOT OLD.private_object_key_hash OR
     NEW.provider_object_version IS NOT OLD.provider_object_version OR
     NEW.provider_object_version_hash IS NOT OLD.provider_object_version_hash OR
     NEW.provider_etag IS NOT OLD.provider_etag OR
     NEW.provider_etag_hash IS NOT OLD.provider_etag_hash OR
     NEW.expected_byte_count IS NOT OLD.expected_byte_count OR
     NEW.expected_sha256 IS NOT OLD.expected_sha256 OR
     NEW.reservation_head_evidence_hash IS NOT OLD.reservation_head_evidence_hash OR
     NEW.reserved_at IS NOT OLD.reserved_at
BEGIN
    SELECT RAISE(ABORT, 'private original deletion identity is immutable');
END;

CREATE TRIGGER draft_private_original_deletions_progress_guard
BEFORE UPDATE OF status, terminal_kind, final_head_absence_evidence_hash,
    prefix_absence_evidence_hash, completed_at
ON draft_private_original_deletions
WHEN (
    NEW.status IS NOT OLD.status OR
    NEW.terminal_kind IS NOT OLD.terminal_kind OR
    NEW.final_head_absence_evidence_hash IS NOT OLD.final_head_absence_evidence_hash OR
    NEW.prefix_absence_evidence_hash IS NOT OLD.prefix_absence_evidence_hash OR
    NEW.completed_at IS NOT OLD.completed_at
) AND NOT (
    OLD.status = 'reserved' AND NEW.status = 'absent' AND
    NEW.terminal_kind IN ('deleted', 'not-found') AND
    NEW.final_head_absence_evidence_hash IS NOT NULL AND
    NEW.prefix_absence_evidence_hash IS NOT NULL AND
    NEW.completed_at IS NULL AND
    EXISTS (
        SELECT 1
        FROM draft_withdrawal_finalization_operations AS operation
        JOIN gallery_current_public_host_absence_receipts AS host
          ON host.draft_id = operation.draft_id
         AND host.verification_purpose = 'withdrawal'
         AND host.withdrawal_kind = operation.withdrawal_kind
         AND host.withdrawal_cycle_hash = operation.withdrawal_cycle_hash
         AND host.verification_id_hash = operation.public_host_verification_id_hash
         AND host.final_receipt_hash = operation.public_host_final_receipt_hash
        WHERE operation.operation_id = OLD.operation_id
          AND operation.operation_id_hash = OLD.operation_id_hash
          AND operation.status = 'reserved'
          AND (
              operation.action = 'withdrawal' OR
              julianday('now') >= julianday(operation.retention_eligible_at)
          )
    )
) AND NOT (
    OLD.status = 'absent' AND NEW.status = 'absent' AND
    NEW.terminal_kind IS OLD.terminal_kind AND
    NEW.final_head_absence_evidence_hash IS OLD.final_head_absence_evidence_hash AND
    NEW.prefix_absence_evidence_hash IS OLD.prefix_absence_evidence_hash AND
    OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL AND
    EXISTS (
        SELECT 1 FROM gallery_private_original_deletion_tombstones AS tombstone
        WHERE tombstone.deletion_id_hash = OLD.deletion_id_hash
          AND tombstone.operation_id_hash = OLD.operation_id_hash
          AND tombstone.draft_id_hash = OLD.draft_id_hash
          AND tombstone.deleted_at = NEW.completed_at
    )
)
BEGIN
    SELECT RAISE(ABORT, 'invalid private original deletion progress');
END;

CREATE TRIGGER draft_private_original_deletions_direct_delete_guard
BEFORE DELETE ON draft_private_original_deletions
WHEN EXISTS (SELECT 1 FROM gallery_drafts AS draft WHERE draft.draft_id = OLD.draft_id)
BEGIN
    SELECT RAISE(ABORT, 'private original deletion direct deletion is forbidden');
END;

CREATE TRIGGER gallery_private_original_deletion_tombstones_no_replace_guard
BEFORE INSERT ON gallery_private_original_deletion_tombstones
WHEN EXISTS (
    SELECT 1 FROM gallery_private_original_deletion_tombstones AS existing
    WHERE existing.deletion_receipt_hash = NEW.deletion_receipt_hash
       OR existing.deletion_id_hash = NEW.deletion_id_hash
       OR existing.operation_id_hash = NEW.operation_id_hash
       OR existing.draft_id_hash = NEW.draft_id_hash
       OR existing.upload_session_id_hash = NEW.upload_session_id_hash
       OR existing.private_object_key_hash = NEW.private_object_key_hash
)
BEGIN
    SELECT RAISE(ABORT, 'private original deletion tombstone replacement is forbidden');
END;

CREATE TRIGGER gallery_private_original_deletion_tombstones_insert_guard
BEFORE INSERT ON gallery_private_original_deletion_tombstones
WHEN NOT EXISTS (
    SELECT 1
    FROM draft_private_original_deletions AS deletion
    JOIN draft_withdrawal_finalization_operations AS operation
      ON operation.operation_id = deletion.operation_id
     AND operation.operation_id_hash = deletion.operation_id_hash
    JOIN gallery_current_public_host_absence_receipts AS host
      ON host.draft_id = operation.draft_id
     AND host.verification_purpose = 'withdrawal'
     AND host.withdrawal_kind = operation.withdrawal_kind
     AND host.withdrawal_cycle_hash = operation.withdrawal_cycle_hash
     AND host.verification_id_hash = operation.public_host_verification_id_hash
     AND host.final_receipt_hash = operation.public_host_final_receipt_hash
    WHERE deletion.status = 'absent'
      AND deletion.completed_at IS NULL
      AND operation.status = 'reserved'
      AND deletion.deletion_id_hash = NEW.deletion_id_hash
      AND deletion.operation_id_hash = NEW.operation_id_hash
      AND deletion.draft_id_hash = NEW.draft_id_hash
      AND deletion.upload_session_id_hash = NEW.upload_session_id_hash
      AND deletion.private_object_key_hash = NEW.private_object_key_hash
      AND deletion.provider_object_version_hash = NEW.provider_object_version_hash
      AND deletion.provider_etag_hash = NEW.provider_etag_hash
      AND deletion.expected_byte_count = NEW.expected_byte_count
      AND deletion.expected_sha256 = NEW.expected_sha256
      AND deletion.terminal_kind = NEW.terminal_kind
      AND deletion.reservation_head_evidence_hash = NEW.reservation_head_evidence_hash
      AND deletion.final_head_absence_evidence_hash = NEW.final_head_absence_evidence_hash
      AND deletion.prefix_absence_evidence_hash = NEW.prefix_absence_evidence_hash
      AND operation.service_actor_identity_hash = NEW.service_actor_identity_hash
      AND NEW.deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND julianday(NEW.deleted_at) >= julianday(deletion.reserved_at)
      AND (
          (operation.action = 'withdrawal' AND operation.withdrawal_kind = 'consent-withdrawal') OR
          (operation.action = 'purge' AND
              operation.withdrawal_kind IN ('editorial-removal', 'athlete-exclusion') AND
              julianday('now') >= julianday(operation.retention_eligible_at))
      )
)
BEGIN
    SELECT RAISE(ABORT, 'private original deletion tombstone lacks exact absence evidence');
END;

CREATE TRIGGER gallery_private_original_deletion_tombstones_no_update
BEFORE UPDATE ON gallery_private_original_deletion_tombstones
BEGIN
    SELECT RAISE(ABORT, 'private original deletion tombstones are append-only');
END;

CREATE TRIGGER gallery_private_original_deletion_tombstones_no_delete
BEFORE DELETE ON gallery_private_original_deletion_tombstones
BEGIN
    SELECT RAISE(ABORT, 'private original deletion tombstones are append-only');
END;

CREATE TRIGGER gallery_private_original_deletion_tombstones_complete_live
AFTER INSERT ON gallery_private_original_deletion_tombstones
BEGIN
    UPDATE draft_private_original_deletions
    SET completed_at = NEW.deleted_at
    WHERE deletion_id_hash = NEW.deletion_id_hash
      AND operation_id_hash = NEW.operation_id_hash
      AND status = 'absent'
      AND completed_at IS NULL;
END;

-- A completed upload can become deleted only after the exact R2 reservation,
-- final absence evidence and permanent tombstone agree byte-for-byte.
CREATE TRIGGER draft_upload_sessions_finalizer_delete_guard
BEFORE UPDATE OF status ON draft_upload_sessions
WHEN OLD.status = 'complete' AND NEW.status = 'deleted' AND NOT EXISTS (
    SELECT 1
    FROM draft_private_original_deletions AS deletion
    JOIN draft_withdrawal_finalization_operations AS operation
      ON operation.operation_id = deletion.operation_id
     AND operation.operation_id_hash = deletion.operation_id_hash
    JOIN gallery_private_original_deletion_tombstones AS tombstone
      ON tombstone.deletion_id_hash = deletion.deletion_id_hash
     AND tombstone.operation_id_hash = deletion.operation_id_hash
     AND tombstone.draft_id_hash = deletion.draft_id_hash
     AND tombstone.upload_session_id_hash = deletion.upload_session_id_hash
     AND tombstone.private_object_key_hash = deletion.private_object_key_hash
    WHERE deletion.upload_session_id = OLD.upload_session_id
      AND deletion.draft_id = OLD.draft_id
      AND deletion.status = 'absent'
      AND deletion.completed_at = tombstone.deleted_at
      AND operation.status = 'reserved'
      AND deletion.private_object_key = OLD.object_key
      AND deletion.provider_object_version = OLD.completed_object_version
      AND deletion.provider_etag = OLD.completed_etag
      AND deletion.expected_byte_count = OLD.declared_byte_count
      AND deletion.expected_sha256 = OLD.completed_sha256
      AND NEW.object_deleted_at = tombstone.deleted_at
      AND julianday(NEW.updated_at) >= julianday(tombstone.deleted_at)
)
BEGIN
    SELECT RAISE(ABORT, 'private upload deletion requires exact finalizer evidence');
END;

-- The compatibility scalar is one-way. It cannot become true until the exact
-- upload is terminal and its hash-only deletion tombstone exists, and it can
-- never later be downgraded to zero.
CREATE TRIGGER draft_publication_references_private_deletion_insert_guard
BEFORE INSERT ON draft_publication_references
WHEN NEW.private_original_deletion_confirmed = 1
BEGIN
    SELECT RAISE(ABORT, 'private original deletion cannot be pre-confirmed');
END;

CREATE TRIGGER draft_publication_references_private_deletion_guard
BEFORE UPDATE OF private_original_deletion_confirmed ON draft_publication_references
WHEN (
    OLD.private_original_deletion_confirmed = 1 AND
    NEW.private_original_deletion_confirmed = 0
) OR (
    OLD.private_original_deletion_confirmed = 0 AND
    NEW.private_original_deletion_confirmed = 1 AND NOT EXISTS (
        SELECT 1
        FROM draft_private_original_deletions AS deletion
        JOIN draft_withdrawal_finalization_operations AS operation
          ON operation.operation_id = deletion.operation_id
         AND operation.operation_id_hash = deletion.operation_id_hash
        JOIN gallery_private_original_deletion_tombstones AS tombstone
          ON tombstone.deletion_id_hash = deletion.deletion_id_hash
         AND tombstone.operation_id_hash = deletion.operation_id_hash
         AND tombstone.draft_id_hash = deletion.draft_id_hash
         AND tombstone.upload_session_id_hash = deletion.upload_session_id_hash
        JOIN draft_upload_sessions AS upload
          ON upload.upload_session_id = deletion.upload_session_id
        WHERE deletion.draft_id = OLD.draft_id
          AND deletion.status = 'absent'
          AND deletion.completed_at = tombstone.deleted_at
          AND operation.status = 'reserved'
          AND operation.withdrawal_kind = OLD.withdrawal_kind
          AND upload.status = 'deleted'
          AND upload.object_deleted_at = tombstone.deleted_at
          AND (
              (operation.action = 'withdrawal' AND operation.withdrawal_kind = 'consent-withdrawal') OR
              (operation.action = 'purge' AND operation.withdrawal_kind IN ('editorial-removal', 'athlete-exclusion'))
          )
    )
)
BEGIN
    SELECT RAISE(ABORT, 'private original deletion scalar requires exact permanent proof');
END;

-- Tighten the consent boundary: the active attestation can be withdrawn only
-- while the draft remains pending, after its exact private original is absent,
-- its upload is deleted and the current public-host receipt still agrees.
DROP TRIGGER draft_consent_withdrawal_evidence_guard;

CREATE TRIGGER draft_consent_withdrawal_evidence_guard
BEFORE UPDATE OF withdrawn_at ON draft_consent_attestations
WHEN EXISTS (
    SELECT 1 FROM gallery_drafts AS draft
    WHERE draft.draft_id = OLD.draft_id
      AND draft.active_consent_revision = OLD.consent_revision
) AND NOT EXISTS (
    SELECT 1
    FROM gallery_drafts AS draft
    JOIN draft_publication_references AS publication
      ON publication.draft_id = draft.draft_id
    JOIN draft_withdrawal_finalization_operations AS operation
      ON operation.draft_id = draft.draft_id
     AND operation.action = 'withdrawal'
     AND operation.status = 'reserved'
    JOIN draft_private_original_deletions AS deletion
      ON deletion.operation_id = operation.operation_id
     AND deletion.operation_id_hash = operation.operation_id_hash
    JOIN gallery_private_original_deletion_tombstones AS tombstone
      ON tombstone.deletion_id_hash = deletion.deletion_id_hash
     AND tombstone.operation_id_hash = deletion.operation_id_hash
     AND tombstone.draft_id_hash = deletion.draft_id_hash
     AND tombstone.upload_session_id_hash = deletion.upload_session_id_hash
    JOIN draft_upload_sessions AS upload
      ON upload.upload_session_id = deletion.upload_session_id
    JOIN gallery_current_public_host_absence_receipts AS host
      ON host.draft_id = draft.draft_id
     AND host.verification_purpose = 'withdrawal'
     AND host.withdrawal_kind = operation.withdrawal_kind
     AND host.expected_state_version = operation.expected_state_version
     AND host.withdrawal_cycle_hash = operation.withdrawal_cycle_hash
     AND host.verification_id_hash = operation.public_host_verification_id_hash
     AND host.final_receipt_hash = operation.public_host_final_receipt_hash
    WHERE draft.draft_id = OLD.draft_id
      AND draft.state = 'withdrawal-pending'
      AND draft.state_version = operation.expected_state_version
      AND publication.withdrawal_kind = 'consent-withdrawal'
      AND publication.host_deletion_confirmed = 1
      AND publication.private_original_deletion_confirmed = 1
      AND operation.withdrawal_kind = 'consent-withdrawal'
      AND deletion.status = 'absent'
      AND deletion.completed_at = tombstone.deleted_at
      AND upload.status = 'deleted'
      AND upload.object_deleted_at = tombstone.deleted_at
      AND upload.consent_revision = OLD.consent_revision
      AND NOT EXISTS (
          SELECT 1 FROM draft_derivatives AS derivative
          WHERE derivative.draft_id = draft.draft_id
      )
      AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.withdrawn_at) = NEW.withdrawn_at
      AND julianday(NEW.withdrawn_at) >= julianday(tombstone.deleted_at)
      AND julianday(NEW.withdrawn_at) <= julianday('now', '+5 seconds')
)
BEGIN
    SELECT RAISE(ABORT, 'consent withdrawal requires exact private and public deletion evidence');
END;

-- Preserve the normal complete-upload rule. Its only terminal exception is
-- the receipt-driven consent transition with the exact deletion tombstone.
DROP TRIGGER gallery_drafts_upload_completion_guard;

CREATE TRIGGER gallery_drafts_upload_completion_guard
BEFORE UPDATE OF state, upload_complete, original_object_key,
    original_detected_type, original_byte_count, original_sha256
ON gallery_drafts
WHEN NEW.upload_complete = 1 AND NOT (
    EXISTS (
        SELECT 1
        FROM draft_upload_sessions AS upload
        WHERE upload.draft_id = NEW.draft_id
          AND upload.status = 'complete'
          AND upload.object_key = NEW.original_object_key
          AND upload.detected_format = NEW.original_detected_type
          AND upload.declared_byte_count = NEW.original_byte_count
          AND upload.completed_sha256 = NEW.original_sha256
          AND upload.item_revision = NEW.item_revision
          AND upload.consent_revision = NEW.active_consent_revision
          AND upload.export_bundle_id = NEW.export_bundle_id
          AND upload.source_revision = NEW.source_revision
          AND upload.suppression_revision = NEW.suppression_revision
    ) OR (
        OLD.state = 'withdrawal-pending' AND
        NEW.state = 'withdrawn' AND
        OLD.active_consent_revision IS NULL AND
        NEW.active_consent_revision IS NULL AND
        NEW.upload_complete IS OLD.upload_complete AND
        NEW.original_object_key IS OLD.original_object_key AND
        NEW.original_detected_type IS OLD.original_detected_type AND
        NEW.original_byte_count IS OLD.original_byte_count AND
        NEW.original_sha256 IS OLD.original_sha256 AND
        EXISTS (
            SELECT 1
            FROM draft_withdrawal_finalization_operations AS operation
            JOIN gallery_withdrawal_completion_receipts AS receipt
              ON receipt.operation_id_hash = operation.operation_id_hash
             AND receipt.draft_id_hash = operation.draft_id_hash
            JOIN draft_private_original_deletions AS deletion
              ON deletion.operation_id = operation.operation_id
             AND deletion.operation_id_hash = operation.operation_id_hash
            JOIN gallery_private_original_deletion_tombstones AS tombstone
              ON tombstone.deletion_id_hash = deletion.deletion_id_hash
             AND tombstone.operation_id_hash = deletion.operation_id_hash
             AND tombstone.draft_id_hash = deletion.draft_id_hash
             AND tombstone.upload_session_id_hash = deletion.upload_session_id_hash
            JOIN draft_upload_sessions AS upload
              ON upload.upload_session_id = deletion.upload_session_id
            JOIN draft_consent_attestations AS consent
              ON consent.draft_id = upload.draft_id
             AND consent.consent_revision = upload.consent_revision
            JOIN draft_publication_references AS publication
              ON publication.draft_id = operation.draft_id
            WHERE operation.draft_id = NEW.draft_id
              AND operation.action = 'withdrawal'
              AND operation.status = 'reserved'
              AND operation.withdrawal_kind = 'consent-withdrawal'
              AND receipt.withdrawal_kind = 'consent-withdrawal'
              AND receipt.expected_state_version = OLD.state_version
              AND receipt.result_state_version = NEW.state_version
              AND receipt.private_deletion_receipt_hash = tombstone.deletion_receipt_hash
              AND deletion.status = 'absent'
              AND deletion.completed_at = tombstone.deleted_at
              AND upload.status = 'deleted'
              AND upload.object_deleted_at = tombstone.deleted_at
              AND upload.object_key = NEW.original_object_key
              AND upload.detected_format = NEW.original_detected_type
              AND upload.declared_byte_count = NEW.original_byte_count
              AND upload.completed_sha256 = NEW.original_sha256
              AND upload.item_revision = NEW.item_revision
              AND upload.export_bundle_id = NEW.export_bundle_id
              AND upload.source_revision = NEW.source_revision
              AND upload.suppression_revision = NEW.suppression_revision
              AND consent.withdrawn_at IS NOT NULL
              AND publication.withdrawal_kind = 'consent-withdrawal'
              AND publication.host_deletion_confirmed = 1
              AND publication.private_original_deletion_confirmed = 1
        )
    )
)
BEGIN
    SELECT RAISE(ABORT, 'gallery draft lacks a verified private original');
END;

DROP TRIGGER gallery_drafts_withdrawal_evidence_guard;

-- The permanent receipt already exists when its AFTER trigger reaches this
-- transition. That makes direct state mutation impossible and binds updated_at
-- to SQLite's own canonical withdrawal instant.
CREATE TRIGGER gallery_drafts_withdrawal_evidence_guard
BEFORE UPDATE OF state ON gallery_drafts
WHEN NEW.state = 'withdrawn' AND NOT EXISTS (
    SELECT 1
    FROM draft_withdrawal_finalization_operations AS operation
    JOIN gallery_withdrawal_completion_receipts AS receipt
      ON receipt.operation_id_hash = operation.operation_id_hash
     AND receipt.draft_id_hash = operation.draft_id_hash
    JOIN draft_publication_references AS publication
      ON publication.draft_id = operation.draft_id
    JOIN gallery_current_public_host_absence_receipts AS host
      ON host.draft_id = operation.draft_id
     AND host.verification_purpose = 'withdrawal'
     AND host.withdrawal_kind = operation.withdrawal_kind
     AND host.expected_state_version = operation.expected_state_version
     AND host.withdrawal_cycle_hash = operation.withdrawal_cycle_hash
     AND host.verification_id_hash = operation.public_host_verification_id_hash
     AND host.final_receipt_hash = operation.public_host_final_receipt_hash
    WHERE operation.draft_id = OLD.draft_id
      AND operation.action = 'withdrawal'
      AND operation.status = 'reserved'
      AND OLD.state = 'withdrawal-pending'
      AND OLD.state_version = operation.expected_state_version
      AND NEW.state_version = receipt.result_state_version
      AND receipt.expected_state_version = operation.expected_state_version
      AND NEW.updated_at = receipt.withdrawn_at
      AND receipt.withdrawal_kind = operation.withdrawal_kind
      AND receipt.withdrawal_cycle_hash = operation.withdrawal_cycle_hash
      AND receipt.public_host_verification_id_hash = operation.public_host_verification_id_hash
      AND receipt.public_host_final_receipt_hash = operation.public_host_final_receipt_hash
      AND publication.withdrawal_kind = operation.withdrawal_kind
      AND publication.host_deletion_confirmed = 1
      AND NOT EXISTS (
          SELECT 1 FROM draft_derivatives AS derivative
          WHERE derivative.draft_id = OLD.draft_id
      )
      AND (SELECT COUNT(*)
             FROM gallery_terminal_photo_review_invalidations AS terminal
            WHERE terminal.draft_id = OLD.draft_id) = 1
      AND (SELECT COUNT(*)
             FROM gallery_complete_photo_review_invalidation_cleanups AS cleanup
            WHERE cleanup.draft_id = OLD.draft_id
              AND cleanup.cleanup_state_version = operation.expected_state_version
              AND cleanup.withdrawal_kind = operation.withdrawal_kind) = 1
      AND (
          (
              operation.withdrawal_kind IN ('editorial-removal', 'athlete-exclusion') AND
              publication.private_original_deletion_confirmed = 0 AND
              receipt.private_deletion_receipt_hash IS NULL AND
              NEW.active_consent_revision IS NOT NULL AND
              EXISTS (
                  SELECT 1 FROM draft_upload_sessions AS upload
                  WHERE upload.draft_id = OLD.draft_id
                    AND upload.status = 'complete'
                    AND upload.object_key = NEW.original_object_key
                    AND upload.completed_sha256 = NEW.original_sha256
              )
          ) OR (
              operation.withdrawal_kind = 'consent-withdrawal' AND
              publication.private_original_deletion_confirmed = 1 AND
              receipt.private_deletion_receipt_hash IS NOT NULL AND
              NEW.active_consent_revision IS NULL AND
              EXISTS (
                  SELECT 1
                  FROM draft_private_original_deletions AS deletion
                  JOIN gallery_private_original_deletion_tombstones AS tombstone
                    ON tombstone.deletion_id_hash = deletion.deletion_id_hash
                   AND tombstone.operation_id_hash = deletion.operation_id_hash
                   AND tombstone.draft_id_hash = deletion.draft_id_hash
                  JOIN draft_upload_sessions AS upload
                    ON upload.upload_session_id = deletion.upload_session_id
                  JOIN draft_consent_attestations AS consent
                    ON consent.draft_id = upload.draft_id
                   AND consent.consent_revision = upload.consent_revision
                  WHERE deletion.operation_id = operation.operation_id
                    AND deletion.status = 'absent'
                    AND deletion.completed_at = tombstone.deleted_at
                    AND tombstone.deletion_receipt_hash = receipt.private_deletion_receipt_hash
                    AND upload.status = 'deleted'
                    AND consent.withdrawn_at IS NOT NULL
              )
          )
      )
)
BEGIN
    SELECT RAISE(ABORT, 'final withdrawal requires an exact completion receipt');
END;

-- Once a terminal state's retention clock exists, ordinary same-state writes
-- cannot backdate it. Leaving rejected/processing-failed through an allowed
-- state transition remains possible.
CREATE TRIGGER gallery_drafts_terminal_timestamp_immutable_guard
BEFORE UPDATE OF updated_at ON gallery_drafts
WHEN OLD.state IN ('withdrawn', 'rejected', 'processing-failed') AND
     NEW.state = OLD.state AND NEW.updated_at IS NOT OLD.updated_at
BEGIN
    SELECT RAISE(ABORT, 'terminal gallery draft timestamp is immutable');
END;

-- All new retention approvals use SQLite's current clock. Withdrawn drafts are
-- tied to the finalizer's immutable withdrawal receipt; the older rejected and
-- processing-failed branch is preserved but now enforces an actual thirty-day
-- interval and current-time eligibility.
CREATE TRIGGER gallery_retention_tombstones_finalization_insert_guard
BEFORE INSERT ON gallery_retention_tombstones
WHEN NOT (
    EXISTS (
        SELECT 1
        FROM gallery_drafts AS draft
        JOIN draft_publication_references AS publication
          ON publication.draft_id = draft.draft_id
        JOIN draft_withdrawal_finalization_operations AS operation
          ON operation.draft_id = draft.draft_id
         AND operation.action = 'purge'
         AND operation.status = 'reserved'
        JOIN gallery_withdrawal_completion_receipts AS withdrawal
          ON withdrawal.withdrawal_receipt_hash = operation.withdrawal_receipt_hash
         AND withdrawal.draft_id_hash = operation.draft_id_hash
        JOIN draft_withdrawal_finalization_operations AS withdrawal_operation
          ON withdrawal_operation.operation_id_hash = withdrawal.operation_id_hash
         AND withdrawal_operation.action = 'withdrawal'
         AND withdrawal_operation.status = 'completed'
        JOIN draft_private_original_deletions AS deletion
          ON deletion.draft_id = draft.draft_id
         AND deletion.status = 'absent'
        JOIN gallery_private_original_deletion_tombstones AS deletion_tombstone
          ON deletion_tombstone.deletion_id_hash = deletion.deletion_id_hash
         AND deletion_tombstone.operation_id_hash = deletion.operation_id_hash
         AND deletion_tombstone.draft_id_hash = deletion.draft_id_hash
         AND deletion_tombstone.upload_session_id_hash = deletion.upload_session_id_hash
        JOIN draft_upload_sessions AS upload
          ON upload.upload_session_id = deletion.upload_session_id
        JOIN gallery_current_public_host_absence_receipts AS host
          ON host.draft_id = draft.draft_id
         AND host.verification_purpose = 'withdrawal'
         AND host.withdrawal_kind = operation.withdrawal_kind
         AND host.withdrawal_cycle_hash = operation.withdrawal_cycle_hash
         AND host.verification_id_hash = operation.public_host_verification_id_hash
         AND host.final_receipt_hash = operation.public_host_final_receipt_hash
        WHERE draft.draft_id = NEW.draft_id
          AND draft.state = 'withdrawn'
          AND draft.state_version = operation.expected_state_version
          AND draft.updated_at = withdrawal.withdrawn_at
          AND operation.withdrawal_kind = withdrawal.withdrawal_kind
          AND operation.withdrawal_cycle_hash = withdrawal.withdrawal_cycle_hash
          AND operation.withdrawn_at = withdrawal.withdrawn_at
          AND operation.retention_eligible_at = withdrawal.retention_eligible_at
          AND host.expected_state_version IN (
              withdrawal.expected_state_version,
              operation.expected_state_version
          )
          AND publication.withdrawal_kind = operation.withdrawal_kind
          AND publication.host_deletion_confirmed = 1
          AND publication.private_original_deletion_confirmed = 1
          AND deletion.completed_at = deletion_tombstone.deleted_at
          AND upload.status = 'deleted'
          AND upload.object_deleted_at = deletion_tombstone.deleted_at
          AND NEW.approved_by_identity_hash = operation.service_actor_identity_hash
          AND NEW.eligible_at = withdrawal.retention_eligible_at
          AND NEW.approved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          AND julianday('now') >= julianday(NEW.eligible_at)
          AND (
              (
                  operation.withdrawal_kind = 'consent-withdrawal' AND
                  NEW.purge_kind = 'consent-withdrawal' AND
                  NEW.eligible_at = withdrawal.withdrawn_at AND
                  deletion.operation_id_hash = withdrawal.operation_id_hash AND
                  deletion_tombstone.deletion_receipt_hash = withdrawal.private_deletion_receipt_hash
              ) OR (
                  operation.withdrawal_kind IN ('editorial-removal', 'athlete-exclusion') AND
                  NEW.purge_kind = 'retention-expiry' AND
                  NEW.eligible_at = strftime(
                      '%Y-%m-%dT%H:%M:%fZ', withdrawal.withdrawn_at, '+30 days'
                  ) AND
                  deletion.operation_id_hash = operation.operation_id_hash
              )
          )
    ) OR EXISTS (
        SELECT 1
        FROM gallery_drafts AS draft
        JOIN draft_publication_references AS publication
          ON publication.draft_id = draft.draft_id
        WHERE draft.draft_id = NEW.draft_id
          AND draft.state IN ('rejected', 'processing-failed')
          AND publication.withdrawal_kind IS NULL
          AND publication.host_deletion_confirmed = 0
          AND publication.private_original_deletion_confirmed = 1
          AND NEW.purge_kind = 'retention-expiry'
          AND NEW.eligible_at = strftime(
              '%Y-%m-%dT%H:%M:%fZ', draft.updated_at, '+30 days'
          )
          AND NEW.approved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          AND julianday('now') >= julianday(NEW.eligible_at)
    )
)
BEGIN
    SELECT RAISE(ABORT, 'retention tombstone lacks an exact eligible cleanup path');
END;

CREATE TRIGGER gallery_draft_purge_receipts_no_replace_guard
BEFORE INSERT ON gallery_draft_purge_receipts
WHEN EXISTS (
    SELECT 1 FROM gallery_draft_purge_receipts AS existing
    WHERE existing.purge_receipt_hash = NEW.purge_receipt_hash
       OR existing.operation_id_hash = NEW.operation_id_hash
       OR existing.withdrawal_operation_id_hash = NEW.withdrawal_operation_id_hash
       OR existing.withdrawal_receipt_hash = NEW.withdrawal_receipt_hash
       OR existing.draft_id_hash = NEW.draft_id_hash
       OR existing.private_deletion_receipt_hash = NEW.private_deletion_receipt_hash
       OR existing.retention_evidence_hash = NEW.retention_evidence_hash
       OR existing.idempotency_key_hash = NEW.idempotency_key_hash
       OR existing.payload_fingerprint = NEW.payload_fingerprint
)
BEGIN
    SELECT RAISE(ABORT, 'gallery draft purge receipt replacement is forbidden');
END;

CREATE TRIGGER gallery_draft_purge_receipts_insert_guard
BEFORE INSERT ON gallery_draft_purge_receipts
WHEN NOT EXISTS (
    SELECT 1
    FROM draft_withdrawal_finalization_operations AS operation
    JOIN gallery_withdrawal_completion_receipts AS withdrawal
      ON withdrawal.withdrawal_receipt_hash = operation.withdrawal_receipt_hash
     AND withdrawal.draft_id_hash = operation.draft_id_hash
    JOIN draft_withdrawal_finalization_operations AS withdrawal_operation
      ON withdrawal_operation.operation_id_hash = withdrawal.operation_id_hash
     AND withdrawal_operation.action = 'withdrawal'
     AND withdrawal_operation.status = 'completed'
    JOIN gallery_drafts AS draft ON draft.draft_id = operation.draft_id
    JOIN draft_publication_references AS publication
      ON publication.draft_id = operation.draft_id
    JOIN draft_private_original_deletions AS deletion
      ON deletion.draft_id = operation.draft_id
     AND deletion.status = 'absent'
    JOIN gallery_private_original_deletion_tombstones AS deletion_tombstone
      ON deletion_tombstone.deletion_id_hash = deletion.deletion_id_hash
     AND deletion_tombstone.operation_id_hash = deletion.operation_id_hash
     AND deletion_tombstone.draft_id_hash = deletion.draft_id_hash
     AND deletion_tombstone.upload_session_id_hash = deletion.upload_session_id_hash
    JOIN draft_upload_sessions AS upload
      ON upload.upload_session_id = deletion.upload_session_id
    JOIN gallery_retention_tombstones AS retention
      ON retention.draft_id = operation.draft_id
    JOIN gallery_current_public_host_absence_receipts AS host
      ON host.draft_id = operation.draft_id
     AND host.verification_purpose = 'withdrawal'
     AND host.withdrawal_kind = operation.withdrawal_kind
     AND host.withdrawal_cycle_hash = operation.withdrawal_cycle_hash
     AND host.verification_id_hash = operation.public_host_verification_id_hash
     AND host.final_receipt_hash = operation.public_host_final_receipt_hash
    WHERE operation.action = 'purge'
      AND operation.status = 'reserved'
      AND operation.operation_id_hash = NEW.operation_id_hash
      AND operation.draft_id_hash = NEW.draft_id_hash
      AND operation.expected_state_version = NEW.expected_state_version
      AND operation.withdrawal_kind = NEW.withdrawal_kind
      AND operation.withdrawal_cycle_hash = NEW.withdrawal_cycle_hash
      AND operation.public_host_verification_id_hash = NEW.public_host_verification_id_hash
      AND operation.public_host_final_receipt_hash = NEW.public_host_final_receipt_hash
      AND operation.idempotency_key_hash = NEW.idempotency_key_hash
      AND operation.payload_fingerprint = NEW.payload_fingerprint
      AND operation.service_actor_identity_hash = NEW.service_actor_identity_hash
      AND withdrawal_operation.operation_id_hash = NEW.withdrawal_operation_id_hash
      AND withdrawal.withdrawal_receipt_hash = NEW.withdrawal_receipt_hash
      AND withdrawal.withdrawal_kind = NEW.withdrawal_kind
      AND withdrawal.withdrawal_cycle_hash = NEW.withdrawal_cycle_hash
      AND withdrawal.result_state_version = NEW.expected_state_version
      AND withdrawal.withdrawn_at = NEW.withdrawn_at
      AND withdrawal.retention_eligible_at = NEW.retention_eligible_at
      AND operation.withdrawn_at = NEW.withdrawn_at
      AND operation.retention_eligible_at = NEW.retention_eligible_at
      AND draft.state = 'withdrawn'
      AND draft.state_version = NEW.expected_state_version
      AND draft.updated_at = NEW.withdrawn_at
      AND publication.withdrawal_kind = NEW.withdrawal_kind
      AND publication.host_deletion_confirmed = 1
      AND publication.private_original_deletion_confirmed = 1
      AND host.expected_state_version IN (
          withdrawal.expected_state_version,
          operation.expected_state_version
      )
      AND deletion.completed_at = deletion_tombstone.deleted_at
      AND deletion_tombstone.deletion_receipt_hash = NEW.private_deletion_receipt_hash
      AND upload.status = 'deleted'
      AND upload.object_deleted_at = deletion_tombstone.deleted_at
      AND retention.evidence_hash = NEW.retention_evidence_hash
      AND retention.eligible_at = NEW.retention_eligible_at
      AND retention.approved_by_identity_hash = NEW.service_actor_identity_hash
      AND retention.approved_at <= NEW.purged_at
      AND NEW.purged_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND julianday('now') >= julianday(NEW.retention_eligible_at)
      AND NOT EXISTS (
          SELECT 1 FROM draft_derivatives AS derivative
          WHERE derivative.draft_id = draft.draft_id
      )
      AND (
          (
              NEW.withdrawal_kind = 'consent-withdrawal' AND
              retention.purge_kind = 'consent-withdrawal' AND
              NEW.retention_eligible_at = NEW.withdrawn_at AND
              deletion.operation_id_hash = withdrawal.operation_id_hash AND
              withdrawal.private_deletion_receipt_hash = NEW.private_deletion_receipt_hash
          ) OR (
              NEW.withdrawal_kind IN ('editorial-removal', 'athlete-exclusion') AND
              retention.purge_kind = 'retention-expiry' AND
              NEW.retention_eligible_at = strftime(
                  '%Y-%m-%dT%H:%M:%fZ', NEW.withdrawn_at, '+30 days'
              ) AND
              deletion.operation_id_hash = operation.operation_id_hash
          )
      )
)
BEGIN
    SELECT RAISE(ABORT, 'gallery draft purge receipt lacks exact current evidence');
END;

CREATE TRIGGER gallery_draft_purge_receipts_no_update
BEFORE UPDATE ON gallery_draft_purge_receipts
BEGIN
    SELECT RAISE(ABORT, 'gallery draft purge receipts are append-only');
END;

CREATE TRIGGER gallery_draft_purge_receipts_no_delete
BEFORE DELETE ON gallery_draft_purge_receipts
BEGIN
    SELECT RAISE(ABORT, 'gallery draft purge receipts are append-only');
END;

-- The original retention table predates the hash-only receipt model and keeps
-- a raw opaque draft ID. It remains immutable while the parent exists. After a
-- guarded parent purge, the exact row must be removed in the same transaction,
-- and only permanent hash-only purge/host evidence can authorize that cleanup.
DROP TRIGGER gallery_retention_tombstones_no_delete;

-- Migrations through 0012 allowed a guarded parent purge to leave this legacy
-- raw-ID authorization behind. Such an orphan can no longer authorize any
-- action because its parent is already absent; its permanent host receipt is
-- hash-only. Remove every pre-0013 orphan before installing the new guard so
-- the known non-production rehearsal row is not stranded permanently.
DELETE FROM gallery_retention_tombstones
WHERE NOT EXISTS (
    SELECT 1
    FROM gallery_drafts AS draft
    WHERE draft.draft_id = gallery_retention_tombstones.draft_id
);

CREATE TRIGGER gallery_retention_tombstones_cleanup_guard
BEFORE DELETE ON gallery_retention_tombstones
WHEN EXISTS (
    SELECT 1 FROM gallery_drafts AS draft
    WHERE draft.draft_id = OLD.draft_id
) OR NOT (
    EXISTS (
        SELECT 1
        FROM gallery_draft_purge_receipts AS purge
        WHERE purge.retention_evidence_hash = OLD.evidence_hash
          AND purge.retention_eligible_at = OLD.eligible_at
          AND purge.service_actor_identity_hash = OLD.approved_by_identity_hash
          AND (
              (OLD.purge_kind = 'consent-withdrawal' AND purge.withdrawal_kind = 'consent-withdrawal') OR
              (OLD.purge_kind = 'retention-expiry' AND purge.withdrawal_kind IN ('editorial-removal', 'athlete-exclusion'))
          )
    ) OR EXISTS (
        SELECT 1
        FROM gallery_public_host_absence_receipts AS host
        WHERE host.verification_purpose = 'retention-expiry'
          AND host.purpose_evidence_hash = OLD.evidence_hash
          AND OLD.purge_kind = 'retention-expiry'
    )
)
BEGIN
    SELECT RAISE(ABORT, 'raw gallery retention evidence can leave only after guarded parent purge');
END;

DROP TRIGGER gallery_drafts_purge_guard;

-- The new withdrawn branch needs the separate purge receipt. The historical
-- rejected/processing-failed branch remains available with its retention-only
-- host proof, but is hardened to a real thirty-day interval and current time.
CREATE TRIGGER gallery_drafts_purge_guard
BEFORE DELETE ON gallery_drafts
WHEN NOT (
    EXISTS (
        SELECT 1
        FROM draft_withdrawal_finalization_operations AS operation
        JOIN gallery_draft_purge_receipts AS purge
          ON purge.operation_id_hash = operation.operation_id_hash
         AND purge.draft_id_hash = operation.draft_id_hash
        JOIN gallery_withdrawal_completion_receipts AS withdrawal
          ON withdrawal.withdrawal_receipt_hash = purge.withdrawal_receipt_hash
         AND withdrawal.operation_id_hash = purge.withdrawal_operation_id_hash
         AND withdrawal.draft_id_hash = purge.draft_id_hash
        JOIN draft_publication_references AS publication
          ON publication.draft_id = operation.draft_id
        JOIN draft_private_original_deletions AS deletion
          ON deletion.draft_id = operation.draft_id
        JOIN gallery_private_original_deletion_tombstones AS deletion_tombstone
          ON deletion_tombstone.deletion_id_hash = deletion.deletion_id_hash
         AND deletion_tombstone.operation_id_hash = deletion.operation_id_hash
         AND deletion_tombstone.draft_id_hash = deletion.draft_id_hash
        JOIN gallery_retention_tombstones AS retention
          ON retention.draft_id = operation.draft_id
         AND retention.evidence_hash = purge.retention_evidence_hash
        JOIN gallery_current_public_host_absence_receipts AS host
          ON host.draft_id = operation.draft_id
         AND host.verification_purpose = 'withdrawal'
         AND host.withdrawal_kind = operation.withdrawal_kind
         AND host.withdrawal_cycle_hash = operation.withdrawal_cycle_hash
         AND host.verification_id_hash = operation.public_host_verification_id_hash
         AND host.final_receipt_hash = operation.public_host_final_receipt_hash
        WHERE operation.draft_id = OLD.draft_id
          AND operation.action = 'purge'
          AND operation.status = 'completed'
          AND OLD.state = 'withdrawn'
          AND OLD.state_version = operation.expected_state_version
          AND OLD.updated_at = withdrawal.withdrawn_at
          AND purge.expected_state_version = operation.expected_state_version
          AND purge.withdrawal_kind = operation.withdrawal_kind
          AND purge.withdrawal_cycle_hash = operation.withdrawal_cycle_hash
          AND purge.public_host_verification_id_hash = operation.public_host_verification_id_hash
          AND purge.public_host_final_receipt_hash = operation.public_host_final_receipt_hash
          AND purge.purged_at = operation.completed_at
          AND deletion.status = 'absent'
          AND deletion.completed_at = deletion_tombstone.deleted_at
          AND deletion_tombstone.deletion_receipt_hash = purge.private_deletion_receipt_hash
          AND publication.withdrawal_kind = operation.withdrawal_kind
          AND publication.host_deletion_confirmed = 1
          AND publication.private_original_deletion_confirmed = 1
          AND retention.eligible_at = withdrawal.retention_eligible_at
          AND retention.approved_at <= purge.purged_at
          AND julianday('now') >= julianday(retention.eligible_at)
          AND (
              (operation.withdrawal_kind = 'consent-withdrawal' AND retention.purge_kind = 'consent-withdrawal') OR
              (operation.withdrawal_kind IN ('editorial-removal', 'athlete-exclusion') AND retention.purge_kind = 'retention-expiry' AND retention.eligible_at = strftime('%Y-%m-%dT%H:%M:%fZ', withdrawal.withdrawn_at, '+30 days'))
          )
    ) OR EXISTS (
        SELECT 1
        FROM gallery_retention_tombstones AS retention
        JOIN draft_publication_references AS publication
          ON publication.draft_id = OLD.draft_id
        JOIN gallery_current_public_host_absence_receipts AS host
          ON host.draft_id = OLD.draft_id
         AND host.verification_purpose = 'retention-expiry'
         AND host.withdrawal_kind = 'retention-expiry'
         AND host.purpose_evidence_hash = retention.evidence_hash
        WHERE retention.draft_id = OLD.draft_id
          AND retention.purge_kind = 'retention-expiry'
          AND OLD.state IN ('rejected', 'processing-failed')
          AND publication.withdrawal_kind IS NULL
          AND publication.host_deletion_confirmed = 0
          AND publication.private_original_deletion_confirmed = 1
          AND retention.eligible_at = strftime(
              '%Y-%m-%dT%H:%M:%fZ', OLD.updated_at, '+30 days'
          )
          AND retention.approved_at >= retention.eligible_at
          AND julianday('now') >= julianday(retention.eligible_at)
    )
)
BEGIN
    SELECT RAISE(ABORT, 'gallery draft purge requires an exact current purge receipt');
END;

CREATE TRIGGER gallery_drafts_remove_raw_retention_tombstone
AFTER DELETE ON gallery_drafts
BEGIN
    DELETE FROM gallery_retention_tombstones
    WHERE draft_id = OLD.draft_id;
END;

-- Marking the purge action completed and deleting its parent happen inside the
-- purge-receipt INSERT statement. If any legacy object/cleanup guard rejects
-- deletion, the permanent receipt and operation update roll back too.
CREATE TRIGGER gallery_draft_purge_receipts_purge_parent
AFTER INSERT ON gallery_draft_purge_receipts
BEGIN
    UPDATE draft_withdrawal_finalization_operations
    SET status = 'completed', completed_at = NEW.purged_at
    WHERE operation_id_hash = NEW.operation_id_hash
      AND action = 'purge'
      AND status = 'reserved';

    DELETE FROM gallery_drafts
    WHERE draft_id = (
        SELECT operation.draft_id
        FROM draft_withdrawal_finalization_operations AS operation
        WHERE operation.operation_id_hash = NEW.operation_id_hash
          AND operation.action = 'purge'
          AND operation.status = 'completed'
    );
END;

PRAGMA foreign_key_check;
