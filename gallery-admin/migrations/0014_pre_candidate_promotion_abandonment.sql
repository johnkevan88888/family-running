PRAGMA foreign_keys = ON;

-- A promotion may have reserved approved-media destinations before the
-- processing catalogue moved on. This view recognizes only that exact,
-- pre-candidate lineage. It grants no promotion, publication or R2 write;
-- its sole purpose is one-way abandonment followed by the existing cleanup
-- and withdrawal-finalization proofs.
CREATE VIEW gallery_abandonable_pre_candidate_photo_promotions AS
SELECT
    draft.draft_id,
    draft.state_version,
    promotion.promotion_id,
    promotion.processing_run_id,
    promotion.expected_state_version,
    promotion.result_state_version
FROM gallery_drafts AS draft
JOIN draft_consent_attestations AS consent
  ON consent.draft_id = draft.draft_id
 AND consent.consent_revision = draft.active_consent_revision
JOIN draft_processing_runs AS run
  ON run.draft_id = draft.draft_id
JOIN draft_photo_promotions AS promotion
  ON promotion.draft_id = draft.draft_id
 AND promotion.processing_run_id = run.processing_run_id
JOIN draft_photo_public_generations AS generation
  ON generation.promotion_id = promotion.promotion_id
 AND generation.draft_id = draft.draft_id
LEFT JOIN draft_publication_references AS publication
  ON publication.draft_id = draft.draft_id
WHERE run.processing_state_version = promotion.expected_state_version
  AND draft.site_modes_json = json_array(promotion.site_mode)
  AND draft.media_type = 'photo'
  AND draft.item_revision = promotion.item_revision
  AND draft.item_revision = run.item_revision
  AND draft.active_consent_revision = promotion.consent_revision
  AND draft.active_consent_revision = run.consent_revision
  AND draft.export_bundle_id = promotion.export_bundle_id
  AND draft.export_bundle_id = run.export_bundle_id
  AND draft.source_revision = promotion.source_revision
  AND draft.source_revision = run.source_revision
  AND draft.suppression_revision = promotion.suppression_revision
  AND draft.suppression_revision = run.suppression_revision
  AND consent.public_use_confirmed = 1
  AND (consent.contains_minors = 0 OR consent.guardian_approval_confirmed = 1)
  AND run.status = 'staged'
  AND run.site_mode = promotion.site_mode
  AND run.media_type = 'photo'
  AND promotion.status = 'active'
  AND promotion.result_state_version = promotion.expected_state_version + 1
  AND generation.candidate_state_version = promotion.result_state_version
  AND (
      (
          draft.state = 'processing'
          AND draft.state_version = promotion.expected_state_version
          AND consent.withdrawn_at IS NULL
          AND publication.draft_id IS NULL
          AND NOT EXISTS (
              SELECT 1
              FROM json_each(draft.athlete_ids_json) AS tag
              JOIN pending_athlete_exclusions AS exclusion
                ON exclusion.athlete_id = tag.value
              WHERE exclusion.resolved_at IS NULL
          )
      ) OR (
          draft.state = 'withdrawal-pending'
          AND draft.state_version = promotion.result_state_version
          AND publication.withdrawal_kind IS NOT NULL
          AND EXISTS (
              SELECT 1
              FROM draft_transition_receipts AS transition
              WHERE transition.draft_id = draft.draft_id
                AND transition.from_state = 'processing'
                AND transition.to_state = 'withdrawal-pending'
                AND transition.expected_state_version =
                    promotion.expected_state_version
                AND transition.result_state_version =
                    promotion.result_state_version
          )
          AND (
              publication.withdrawal_kind = 'consent-withdrawal' OR (
                  consent.withdrawn_at IS NULL
                  AND publication.withdrawal_kind = 'athlete-exclusion'
                  AND EXISTS (
                      SELECT 1
                      FROM json_each(draft.athlete_ids_json) AS tag
                      JOIN pending_athlete_exclusions AS exclusion
                        ON exclusion.athlete_id = tag.value
                      WHERE exclusion.resolved_at IS NULL
                  )
              ) OR (
                  consent.withdrawn_at IS NULL
                  AND publication.withdrawal_kind = 'editorial-removal'
                  AND NOT EXISTS (
                      SELECT 1
                      FROM json_each(draft.athlete_ids_json) AS tag
                      JOIN pending_athlete_exclusions AS exclusion
                        ON exclusion.athlete_id = tag.value
                      WHERE exclusion.resolved_at IS NULL
                  )
              )
          )
      )
  )
  AND NOT EXISTS (
      SELECT 1 FROM draft_photo_review_receipts AS review
      WHERE review.draft_id = draft.draft_id
         OR review.promotion_id = promotion.promotion_id
         OR review.processing_run_id = run.processing_run_id
  )
  AND NOT EXISTS (
      SELECT 1 FROM draft_photo_review_abandonment_receipts AS abandonment
      WHERE abandonment.draft_id = draft.draft_id
         OR abandonment.promotion_id = promotion.promotion_id
         OR abandonment.processing_run_id = run.processing_run_id
  )
  AND NOT EXISTS (
      SELECT 1 FROM draft_photo_promotion_cleanups AS cleanup
      WHERE cleanup.promotion_id = promotion.promotion_id
  )
  AND NOT EXISTS (
      SELECT 1 FROM draft_processing_cleanups AS cleanup
      WHERE cleanup.processing_run_id = run.processing_run_id
  )
  AND (
      SELECT COUNT(*) FROM draft_processing_outputs AS output
      WHERE output.processing_run_id = run.processing_run_id
  ) = 2
  AND (
      SELECT COUNT(*) FROM draft_derivatives AS derivative
      WHERE derivative.draft_id = draft.draft_id
  ) = 2
  AND (
      SELECT COUNT(*) FROM draft_photo_promotion_objects AS object
      WHERE object.promotion_id = promotion.promotion_id
  ) = 2
  AND (
      SELECT COUNT(*) FROM draft_photo_public_generation_targets AS target
      WHERE target.promotion_id = promotion.promotion_id
  ) = 2
  AND (
      SELECT COUNT(*)
      FROM draft_photo_promotion_objects AS object
      JOIN draft_processing_outputs AS output
        ON output.processing_run_id = run.processing_run_id
       AND output.role = object.role
      JOIN draft_derivatives AS derivative
        ON derivative.draft_id = draft.draft_id
       AND derivative.role = object.role
      JOIN draft_photo_public_generation_targets AS target
        ON target.promotion_id = promotion.promotion_id
       AND target.role = object.role
      WHERE object.promotion_id = promotion.promotion_id
        AND object.role IN ('photo-display', 'photo-thumbnail')
        AND object.status IN (
            'reserved', 'admitting', 'upload-open', 'part-uploaded', 'verified'
        )
        AND output.status = 'verified'
        AND object.staging_object_key = output.staging_object_key
        AND object.staging_object_version = output.staging_object_version
        AND object.staging_etag = output.staging_etag
        AND object.sha256 = output.sha256
        AND object.byte_count = output.byte_count
        AND object.content_type = output.content_type
        AND object.width = output.width
        AND object.height = output.height
        AND derivative.item_revision = promotion.item_revision
        AND derivative.consent_revision = promotion.consent_revision
        AND derivative.export_bundle_id = promotion.export_bundle_id
        AND derivative.source_revision = promotion.source_revision
        AND derivative.suppression_revision = promotion.suppression_revision
        AND derivative.staging_object_key = output.staging_object_key
        AND derivative.approved_object_key IS NULL
        AND derivative.byte_count = output.byte_count
        AND derivative.sha256 = output.sha256
        AND derivative.content_type = output.content_type
        AND derivative.width = output.width
        AND derivative.height = output.height
        AND derivative.duration_milliseconds IS NULL
        AND derivative.metadata_scan_json = output.metadata_scan_json
        AND derivative.scanner_version = output.scanner_version
        AND derivative.host_deleted_at IS NULL
        AND target.approved_object_key = object.approved_object_key
        AND target.expected_sha256 = object.sha256
        AND target.generation_target_set_hash = generation.target_set_hash
  ) = 2;

-- Preserve the existing candidate abandonment path and add only the exact
-- pre-candidate shape above. Any review receipt still excludes abandonment.
DROP TRIGGER draft_photo_review_abandonment_receipts_insert_guard;

CREATE TRIGGER draft_photo_review_abandonment_receipts_insert_guard
BEFORE INSERT ON draft_photo_review_abandonment_receipts
WHEN EXISTS (
    SELECT 1 FROM draft_photo_review_receipts AS review
    WHERE review.draft_id = NEW.draft_id
       OR review.promotion_id = NEW.promotion_id
       OR review.processing_run_id = NEW.processing_run_id
) OR (
    NOT EXISTS (
        SELECT 1
        FROM gallery_drafts AS draft
        JOIN draft_photo_promotions AS promotion
          ON promotion.promotion_id = NEW.promotion_id
         AND promotion.draft_id = draft.draft_id
        WHERE draft.draft_id = NEW.draft_id
          AND draft.state = 'candidate-public'
          AND draft.state_version = NEW.expected_state_version
          AND promotion.status = 'candidate'
          AND promotion.result_state_version = NEW.expected_state_version
          AND promotion.processing_run_id = NEW.processing_run_id
    ) AND NOT EXISTS (
        SELECT 1
        FROM gallery_abandonable_pre_candidate_photo_promotions AS abandoned
        WHERE abandoned.draft_id = NEW.draft_id
          AND abandoned.promotion_id = NEW.promotion_id
          AND abandoned.processing_run_id = NEW.processing_run_id
          AND abandoned.expected_state_version = NEW.expected_state_version
          AND abandoned.result_state_version = NEW.result_state_version
    )
)
BEGIN
    SELECT RAISE(ABORT, 'photo review abandonment lacks exact unreserved candidate evidence');
END;

-- Existing candidate transitions remain valid. A processing transition is
-- accepted only when the immutable abandonment receipt proves that exact
-- one-step state change. The source state is retained for the generalized
-- terminal-evidence view below.
CREATE VIEW gallery_terminal_photo_review_withdrawal_transitions AS
SELECT
    transition.draft_id,
    transition.from_state,
    transition.expected_state_version,
    transition.result_state_version,
    CASE transition.from_state
        WHEN 'processing' THEN 'pre-candidate-photo-promotion'
        ELSE 'photo-review'
    END AS source_kind
FROM draft_transition_receipts AS transition
WHERE transition.to_state = 'withdrawal-pending'
  AND (
      transition.from_state = 'candidate-public' OR (
          transition.from_state = 'processing' AND EXISTS (
              SELECT 1
              FROM draft_photo_review_abandonment_receipts AS abandonment
              WHERE abandonment.draft_id = transition.draft_id
                AND abandonment.expected_state_version =
                    transition.expected_state_version
                AND abandonment.result_state_version =
                    transition.result_state_version
          )
      )
  );

-- A staged processing run that never created promotion, generation or review
-- evidence has a distinct terminal lineage. Its append-only owner transition
-- and audit stay bound to the exact complete upload and staged run. The view
-- accepts either the untouched two-output staging set or that same run's
-- immutable cleanup lineage, so retries remain possible after byte deletion
-- without inventing a promotion or review receipt.
CREATE VIEW gallery_processing_only_editorial_withdrawal_sources AS
SELECT
    transition.draft_id,
    draft.state AS draft_state,
    draft.state_version AS current_state_version,
    run.processing_run_id,
    run.status AS run_status,
    transition.expected_state_version,
    transition.result_state_version AS cleanup_state_version,
    publication.withdrawal_kind,
    transition.payload_fingerprint AS transition_payload_fingerprint,
    transition.created_at AS withdrawal_requested_at
FROM draft_transition_receipts AS transition
JOIN gallery_drafts AS draft
  ON draft.draft_id = transition.draft_id
JOIN draft_processing_runs AS run
  ON run.draft_id = transition.draft_id
 AND run.processing_state_version = transition.expected_state_version
JOIN draft_upload_sessions AS upload
  ON upload.upload_session_id = run.upload_session_id
 AND upload.draft_id = draft.draft_id
JOIN draft_consent_attestations AS consent
  ON consent.draft_id = draft.draft_id
 AND consent.consent_revision = draft.active_consent_revision
JOIN draft_publication_references AS publication
  ON publication.draft_id = draft.draft_id
WHERE transition.from_state = 'processing'
  AND transition.to_state = 'withdrawal-pending'
  AND draft.state = 'withdrawal-pending'
  AND draft.state_version = transition.result_state_version
  AND draft.updated_at = transition.created_at
  AND run.status = 'staged'
  AND run.completed_at IS NOT NULL
  AND transition.created_at >= run.completed_at
  AND (
      SELECT COUNT(*) FROM draft_processing_runs AS exact_run
      WHERE exact_run.draft_id = draft.draft_id
        AND exact_run.processing_state_version = transition.expected_state_version
        AND exact_run.status = 'staged'
  ) = 1
  AND draft.site_modes_json = json_array(run.site_mode)
  AND draft.media_type = run.media_type
  AND draft.media_type = 'photo'
  AND draft.item_revision = run.item_revision
  AND draft.active_consent_revision = run.consent_revision
  AND draft.export_bundle_id = run.export_bundle_id
  AND draft.source_revision = run.source_revision
  AND draft.suppression_revision = run.suppression_revision
  AND draft.original_object_key = run.original_object_key
  AND draft.original_detected_type = run.original_detected_type
  AND draft.original_byte_count = run.original_byte_count
  AND draft.original_sha256 = run.original_sha256
  AND upload.status = 'complete'
  AND upload.synthetic_only_confirmed = 1
  AND upload.item_revision = run.item_revision
  AND upload.consent_revision = run.consent_revision
  AND upload.export_bundle_id = run.export_bundle_id
  AND upload.source_revision = run.source_revision
  AND upload.suppression_revision = run.suppression_revision
  AND upload.object_key = run.original_object_key
  AND upload.detected_format = run.original_detected_type
  AND upload.declared_content_type = run.original_declared_content_type
  AND upload.declared_byte_count = run.original_byte_count
  AND upload.completed_sha256 = run.original_sha256
  AND upload.completed_object_version = run.original_object_version
  AND upload.completed_etag = run.original_etag
  AND upload.verified_owner_identity_hash = draft.verified_owner_identity_hash
  AND consent.verified_owner_identity_hash = draft.verified_owner_identity_hash
  AND publication.withdrawal_kind = 'editorial-removal'
  AND publication.private_original_deletion_confirmed = 0
  AND publication.workflow_run_reference IS NULL
  AND publication.candidate_branch_reference IS NULL
  AND publication.pull_request_reference IS NULL
  AND publication.merge_commit_reference IS NULL
  AND consent.public_use_confirmed = 1
  AND (consent.contains_minors = 0 OR consent.guardian_approval_confirmed = 1)
  AND consent.withdrawn_at IS NULL
  AND NOT EXISTS (
      SELECT 1
      FROM json_each(draft.athlete_ids_json) AS tag
      JOIN pending_athlete_exclusions AS exclusion
        ON exclusion.athlete_id = tag.value
      WHERE exclusion.resolved_at IS NULL
  )
  AND (
      SELECT COUNT(*)
      FROM gallery_audit_events AS withdrawal_audit
      WHERE withdrawal_audit.event_type = 'editorial-removal-initiated'
        AND withdrawal_audit.payload_hash = transition.payload_fingerprint
        AND withdrawal_audit.state_version = transition.result_state_version
        AND withdrawal_audit.actor_identity_hash =
            draft.verified_owner_identity_hash
        AND withdrawal_audit.occurred_at = transition.created_at
  ) = 1
  AND NOT EXISTS (
      SELECT 1 FROM draft_photo_promotions AS promotion
      WHERE promotion.draft_id = draft.draft_id
  )
  AND NOT EXISTS (
      SELECT 1 FROM draft_photo_promotion_cleanups AS cleanup
      WHERE cleanup.draft_id = draft.draft_id
  )
  AND NOT EXISTS (
      SELECT 1 FROM draft_photo_review_receipts AS review
      WHERE review.draft_id = draft.draft_id
  )
  AND NOT EXISTS (
      SELECT 1 FROM draft_photo_review_abandonment_receipts AS abandonment
      WHERE abandonment.draft_id = draft.draft_id
  )
  AND NOT EXISTS (
      SELECT 1 FROM draft_photo_public_generations AS generation
      WHERE generation.draft_id = draft.draft_id
  )
  AND NOT EXISTS (
      SELECT 1 FROM draft_derivatives AS derivative
      WHERE derivative.draft_id = draft.draft_id
        AND derivative.approved_object_key IS NOT NULL
  )
  AND (
      (
          NOT EXISTS (
              SELECT 1 FROM draft_processing_cleanups AS cleanup
              WHERE cleanup.processing_run_id = run.processing_run_id
          )
          AND (
              SELECT COUNT(*) FROM draft_processing_outputs AS output
              WHERE output.processing_run_id = run.processing_run_id
                AND output.status = 'verified'
                AND output.role IN ('photo-display', 'photo-thumbnail')
          ) = 2
          AND (
              SELECT COUNT(*) FROM draft_derivatives AS derivative
              WHERE derivative.draft_id = draft.draft_id
                AND derivative.staging_object_key IS NOT NULL
                AND derivative.approved_object_key IS NULL
                AND derivative.role IN ('photo-display', 'photo-thumbnail')
          ) = 2
          AND (
              SELECT COUNT(*)
              FROM draft_processing_outputs AS output
              JOIN draft_derivatives AS derivative
                ON derivative.draft_id = draft.draft_id
               AND derivative.role = output.role
              WHERE output.processing_run_id = run.processing_run_id
                AND output.status = 'verified'
                AND output.role IN ('photo-display', 'photo-thumbnail')
                AND derivative.item_revision = run.item_revision
                AND derivative.consent_revision = run.consent_revision
                AND derivative.export_bundle_id = run.export_bundle_id
                AND derivative.source_revision = run.source_revision
                AND derivative.suppression_revision = run.suppression_revision
                AND derivative.staging_object_key = output.staging_object_key
                AND derivative.approved_object_key IS NULL
                AND derivative.byte_count = output.byte_count
                AND derivative.sha256 = output.sha256
                AND derivative.content_type = output.content_type
                AND derivative.width = output.width
                AND derivative.height = output.height
                AND derivative.duration_milliseconds IS NULL
                AND derivative.metadata_scan_json = output.metadata_scan_json
                AND derivative.scanner_version = output.scanner_version
                AND derivative.host_deleted_at IS NULL
          ) = 2
      ) OR EXISTS (
          SELECT 1
          FROM draft_processing_cleanups AS cleanup
          WHERE cleanup.processing_run_id = run.processing_run_id
            AND cleanup.draft_id = draft.draft_id
            AND cleanup.cleanup_reason = 'withdrawal'
            AND cleanup.expected_state_version = transition.result_state_version
            AND cleanup.output_count = 2
            AND cleanup.created_at >= transition.created_at
            AND (
                (
                    cleanup.status IN ('closing', 'deleting') AND
                    cleanup.cleanup_evidence_hash IS NULL AND
                    cleanup.completed_at IS NULL AND
                    NOT EXISTS (
                        SELECT 1
                        FROM gallery_processing_cleanup_tombstones AS tombstone
                        WHERE tombstone.cleanup_id_hash = cleanup.cleanup_id_hash
                           OR tombstone.processing_run_id_hash =
                              cleanup.processing_run_id_hash
                    )
                ) OR (
                    cleanup.status = 'cleaned' AND
                    cleanup.cleanup_evidence_hash IS NOT NULL AND
                    cleanup.completed_at IS NOT NULL AND
                    EXISTS (
                        SELECT 1
                        FROM gallery_processing_cleanup_tombstones AS tombstone
                        WHERE tombstone.cleanup_id_hash = cleanup.cleanup_id_hash
                          AND tombstone.draft_id_hash = cleanup.draft_id_hash
                          AND tombstone.processing_run_id_hash =
                              cleanup.processing_run_id_hash
                          AND tombstone.cleanup_reason = cleanup.cleanup_reason
                          AND tombstone.evidence_hash = cleanup.cleanup_evidence_hash
                          AND tombstone.completed_at = cleanup.completed_at
                    )
                )
            )
      )
  );

-- Every withdrawal finalizer consumer reads the same mutually exclusive
-- terminal-source contract. Photo paths retain their promotion identity;
-- processing-only editorial withdrawal deliberately has no promotion.
CREATE VIEW gallery_terminal_photo_withdrawal_transitions AS
SELECT
    transition.source_kind,
    invalidation.draft_id,
    invalidation.promotion_id,
    invalidation.processing_run_id,
    transition.expected_state_version,
    transition.result_state_version,
    invalidation.cleanup_state_version,
    publication.withdrawal_kind
FROM gallery_terminal_photo_review_invalidations AS invalidation
JOIN gallery_terminal_photo_review_withdrawal_transitions AS transition
  ON transition.draft_id = invalidation.draft_id
 AND transition.result_state_version = invalidation.cleanup_state_version
JOIN draft_publication_references AS publication
  ON publication.draft_id = invalidation.draft_id
WHERE publication.withdrawal_kind IS NOT NULL
UNION ALL
SELECT
    'processing-only-editorial',
    terminal.draft_id,
    NULL,
    terminal.processing_run_id,
    terminal.expected_state_version,
    terminal.cleanup_state_version,
    terminal.cleanup_state_version,
    terminal.withdrawal_kind
FROM gallery_processing_only_editorial_withdrawal_sources AS terminal;

-- The processing-only branch needs only private-staging cleanup. It cannot
-- satisfy this view unless the exact cleanup and permanent tombstone agree and
-- both the live outputs and derivative rows are absent.
CREATE VIEW gallery_complete_processing_only_withdrawal_cleanups AS
SELECT
    terminal.draft_id,
    terminal.processing_run_id,
    terminal.cleanup_state_version,
    terminal.withdrawal_kind
FROM gallery_processing_only_editorial_withdrawal_sources AS terminal
JOIN draft_processing_cleanups AS cleanup
  ON cleanup.processing_run_id = terminal.processing_run_id
 AND cleanup.draft_id = terminal.draft_id
 AND cleanup.expected_state_version = terminal.cleanup_state_version
JOIN gallery_processing_cleanup_tombstones AS tombstone
  ON tombstone.cleanup_id_hash = cleanup.cleanup_id_hash
 AND tombstone.draft_id_hash = cleanup.draft_id_hash
 AND tombstone.processing_run_id_hash = cleanup.processing_run_id_hash
 AND tombstone.cleanup_reason = cleanup.cleanup_reason
 AND tombstone.evidence_hash = cleanup.cleanup_evidence_hash
 AND tombstone.completed_at = cleanup.completed_at
WHERE cleanup.cleanup_reason = 'withdrawal'
  AND cleanup.status = 'cleaned'
  AND cleanup.output_count = 2
  AND cleanup.created_at >= terminal.withdrawal_requested_at
  AND cleanup.completed_at >= cleanup.created_at
  AND (
      SELECT COUNT(*) FROM draft_processing_cleanup_objects AS object
      WHERE object.cleanup_id = cleanup.cleanup_id
  ) = 2
  AND (
      SELECT COUNT(*) FROM draft_processing_cleanup_objects AS object
      WHERE object.cleanup_id = cleanup.cleanup_id
        AND object.status = 'absent'
        AND object.role IN ('photo-display', 'photo-thumbnail')
  ) = 2
  AND NOT EXISTS (
      SELECT 1 FROM draft_processing_multipart_uploads AS upload
      WHERE upload.processing_run_id = terminal.processing_run_id
  )
  AND NOT EXISTS (
      SELECT 1 FROM draft_processing_outputs AS output
      WHERE output.processing_run_id = terminal.processing_run_id
  )
  AND NOT EXISTS (
      SELECT 1 FROM draft_derivatives AS derivative
      WHERE derivative.draft_id = terminal.draft_id
  );

CREATE VIEW gallery_complete_photo_withdrawal_cleanups AS
SELECT
    source.source_kind,
    source.draft_id,
    source.promotion_id,
    source.processing_run_id,
    source.expected_state_version,
    source.result_state_version,
    source.cleanup_state_version,
    source.withdrawal_kind
FROM gallery_terminal_photo_withdrawal_transitions AS source
JOIN gallery_complete_photo_review_invalidation_cleanups AS cleanup
  ON cleanup.draft_id = source.draft_id
 AND cleanup.promotion_id = source.promotion_id
 AND cleanup.processing_run_id = source.processing_run_id
 AND cleanup.cleanup_state_version = source.cleanup_state_version
 AND cleanup.withdrawal_kind = source.withdrawal_kind
WHERE source.source_kind IN ('photo-review', 'pre-candidate-photo-promotion')
UNION ALL
SELECT
    'processing-only-editorial',
    cleanup.draft_id,
    NULL,
    cleanup.processing_run_id,
    cleanup.cleanup_state_version - 1,
    cleanup.cleanup_state_version,
    cleanup.cleanup_state_version,
    cleanup.withdrawal_kind
FROM gallery_complete_processing_only_withdrawal_cleanups AS cleanup;

-- Migration 0013 is already deployed. Replace its combined operation guard
-- with small read-only gates. The purge predicates remain unchanged; the
-- withdrawal gates consume the generalized source and cleanup views above.
DROP TRIGGER draft_withdrawal_finalization_operations_insert_guard;

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
)
BEGIN
    SELECT RAISE(ABORT, 'withdrawal finalization operation lacks exact current evidence');
END;

CREATE TRIGGER draft_withdrawal_finalization_operations_withdrawal_source_guard
BEFORE INSERT ON draft_withdrawal_finalization_operations
WHEN NEW.action = 'withdrawal' AND NOT EXISTS (
    SELECT 1
    FROM gallery_drafts AS draft
    JOIN draft_publication_references AS publication
      ON publication.draft_id = draft.draft_id
    JOIN gallery_current_public_host_absence_receipts AS host
      ON host.draft_id = draft.draft_id
     AND host.verification_purpose = 'withdrawal'
     AND host.withdrawal_kind = NEW.withdrawal_kind
     AND host.expected_state_version = NEW.expected_state_version
    WHERE draft.draft_id = NEW.draft_id
      AND NEW.withdrawal_receipt_hash IS NULL
      AND NEW.withdrawn_at IS NULL
      AND NEW.retention_eligible_at IS NULL
      AND draft.state = 'withdrawal-pending'
      AND draft.state_version = NEW.expected_state_version
      AND publication.withdrawal_kind = NEW.withdrawal_kind
      AND publication.private_original_deletion_confirmed = 0
      AND draft.active_consent_revision IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM draft_derivatives AS derivative
          WHERE derivative.draft_id = draft.draft_id
      )
      AND (SELECT COUNT(*)
             FROM gallery_terminal_photo_withdrawal_transitions AS terminal
            WHERE terminal.draft_id = draft.draft_id
              AND terminal.cleanup_state_version = NEW.expected_state_version
              AND terminal.withdrawal_kind = NEW.withdrawal_kind) = 1
)
BEGIN
    SELECT RAISE(ABORT, 'withdrawal finalization operation lacks exact current evidence');
END;

CREATE TRIGGER draft_withdrawal_finalization_operations_withdrawal_cleanup_guard
BEFORE INSERT ON draft_withdrawal_finalization_operations
WHEN NEW.action = 'withdrawal' AND (
    SELECT COUNT(*)
    FROM gallery_complete_photo_withdrawal_cleanups AS cleanup
    WHERE cleanup.draft_id = NEW.draft_id
      AND cleanup.cleanup_state_version = NEW.expected_state_version
      AND cleanup.withdrawal_kind = NEW.withdrawal_kind
) <> 1
BEGIN
    SELECT RAISE(ABORT, 'withdrawal finalization operation lacks exact current evidence');
END;

CREATE TRIGGER draft_withdrawal_finalization_operations_withdrawal_original_guard
BEFORE INSERT ON draft_withdrawal_finalization_operations
WHEN NEW.action = 'withdrawal' AND NOT EXISTS (
    SELECT 1
    FROM gallery_drafts AS draft
    JOIN draft_upload_sessions AS upload
      ON upload.draft_id = draft.draft_id
    WHERE draft.draft_id = NEW.draft_id
      AND upload.status = 'complete'
      AND upload.object_key = draft.original_object_key
      AND upload.completed_sha256 = draft.original_sha256
)
BEGIN
    SELECT RAISE(ABORT, 'withdrawal finalization operation lacks exact current evidence');
END;

CREATE TRIGGER draft_withdrawal_finalization_operations_purge_guard
BEFORE INSERT ON draft_withdrawal_finalization_operations
WHEN NEW.action = 'purge' AND NOT EXISTS (
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
    JOIN gallery_withdrawal_completion_receipts AS withdrawal
      ON withdrawal.withdrawal_receipt_hash = NEW.withdrawal_receipt_hash
     AND withdrawal.draft_id_hash = NEW.draft_id_hash
     AND withdrawal.result_state_version = NEW.expected_state_version
     AND withdrawal.withdrawal_kind = NEW.withdrawal_kind
     AND withdrawal.withdrawal_cycle_hash = NEW.withdrawal_cycle_hash
    JOIN draft_withdrawal_finalization_operations AS withdrawal_operation
      ON withdrawal_operation.operation_id_hash = withdrawal.operation_id_hash
     AND withdrawal_operation.action = 'withdrawal'
     AND withdrawal_operation.status = 'completed'
     AND withdrawal_operation.draft_id = draft.draft_id
    WHERE draft.draft_id = NEW.draft_id
      AND draft.state = 'withdrawn'
      AND draft.state_version = NEW.expected_state_version
      AND publication.withdrawal_kind = NEW.withdrawal_kind
      AND NEW.withdrawal_receipt_hash IS NOT NULL
      AND NEW.withdrawn_at = withdrawal.withdrawn_at
      AND NEW.retention_eligible_at = withdrawal.retention_eligible_at
      AND host.expected_state_version IN (
          withdrawal.expected_state_version,
          NEW.expected_state_version
      )
      AND NOT EXISTS (
          SELECT 1 FROM gallery_retention_tombstones AS retention
          WHERE retention.draft_id = draft.draft_id
      )
      AND julianday('now') >= julianday(NEW.retention_eligible_at)
      AND (
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
BEGIN
    SELECT RAISE(ABORT, 'withdrawal finalization operation lacks exact current evidence');
END;

-- The 0013 completion guard exceeded D1's expression-depth ceiling once all
-- nested views were expanded. Each replacement trigger below is a pure read
-- with one bounded responsibility. The existing AFTER INSERT trigger remains
-- the sole state-changing command, so receipt, transition and operation update
-- still commit or roll back as one transaction.
DROP TRIGGER gallery_withdrawal_completion_receipts_insert_guard;

CREATE TRIGGER gallery_withdrawal_completion_receipts_insert_guard
BEFORE INSERT ON gallery_withdrawal_completion_receipts
WHEN NOT EXISTS (
    SELECT 1
    FROM draft_withdrawal_finalization_operations AS operation
    WHERE operation.action = 'withdrawal'
      AND operation.status = 'reserved'
      AND operation.operation_id_hash = NEW.operation_id_hash
      AND operation.draft_id_hash = NEW.draft_id_hash
      AND operation.expected_state_version = NEW.expected_state_version
      AND NEW.result_state_version = operation.expected_state_version + 1
      AND operation.withdrawal_kind = NEW.withdrawal_kind
      AND operation.withdrawal_cycle_hash = NEW.withdrawal_cycle_hash
      AND operation.public_host_verification_id_hash =
          NEW.public_host_verification_id_hash
      AND operation.public_host_final_receipt_hash =
          NEW.public_host_final_receipt_hash
      AND operation.idempotency_key_hash = NEW.idempotency_key_hash
      AND operation.payload_fingerprint = NEW.payload_fingerprint
      AND operation.service_actor_identity_hash = NEW.service_actor_identity_hash
)
BEGIN
    SELECT RAISE(ABORT, 'withdrawal completion receipt lacks exact final evidence');
END;

CREATE TRIGGER gallery_withdrawal_completion_receipts_draft_guard
BEFORE INSERT ON gallery_withdrawal_completion_receipts
WHEN NOT EXISTS (
    SELECT 1
    FROM draft_withdrawal_finalization_operations AS operation
    JOIN gallery_drafts AS draft ON draft.draft_id = operation.draft_id
    JOIN draft_publication_references AS publication
      ON publication.draft_id = operation.draft_id
    WHERE operation.operation_id_hash = NEW.operation_id_hash
      AND operation.action = 'withdrawal'
      AND operation.status = 'reserved'
      AND draft.state = 'withdrawal-pending'
      AND draft.state_version = operation.expected_state_version
      AND publication.withdrawal_kind = operation.withdrawal_kind
      AND publication.host_deletion_confirmed = 1
      AND NOT EXISTS (
          SELECT 1 FROM draft_derivatives AS derivative
          WHERE derivative.draft_id = draft.draft_id
      )
)
BEGIN
    SELECT RAISE(ABORT, 'withdrawal completion receipt lacks exact final evidence');
END;

CREATE TRIGGER gallery_withdrawal_completion_receipts_terminal_source_guard
BEFORE INSERT ON gallery_withdrawal_completion_receipts
WHEN (
    SELECT COUNT(*)
    FROM draft_withdrawal_finalization_operations AS operation
    JOIN gallery_terminal_photo_withdrawal_transitions AS terminal
      ON terminal.draft_id = operation.draft_id
     AND terminal.cleanup_state_version = operation.expected_state_version
     AND terminal.withdrawal_kind = operation.withdrawal_kind
    WHERE operation.operation_id_hash = NEW.operation_id_hash
      AND operation.action = 'withdrawal'
      AND operation.status = 'reserved'
) <> 1
BEGIN
    SELECT RAISE(ABORT, 'withdrawal completion receipt lacks exact final evidence');
END;

CREATE TRIGGER gallery_withdrawal_completion_receipts_cleanup_guard
BEFORE INSERT ON gallery_withdrawal_completion_receipts
WHEN (
    SELECT COUNT(*)
    FROM draft_withdrawal_finalization_operations AS operation
    JOIN gallery_complete_photo_withdrawal_cleanups AS cleanup
      ON cleanup.draft_id = operation.draft_id
     AND cleanup.cleanup_state_version = operation.expected_state_version
     AND cleanup.withdrawal_kind = operation.withdrawal_kind
    WHERE operation.operation_id_hash = NEW.operation_id_hash
      AND operation.action = 'withdrawal'
      AND operation.status = 'reserved'
) <> 1
BEGIN
    SELECT RAISE(ABORT, 'withdrawal completion receipt lacks exact final evidence');
END;

CREATE TRIGGER gallery_withdrawal_completion_receipts_current_host_guard
BEFORE INSERT ON gallery_withdrawal_completion_receipts
WHEN NOT EXISTS (
    SELECT 1
    FROM draft_withdrawal_finalization_operations AS operation
    JOIN gallery_current_public_host_absence_receipts AS host
      ON host.draft_id = operation.draft_id
     AND host.verification_purpose = 'withdrawal'
     AND host.withdrawal_kind = operation.withdrawal_kind
     AND host.expected_state_version = operation.expected_state_version
     AND host.withdrawal_cycle_hash = operation.withdrawal_cycle_hash
     AND host.verification_id_hash = operation.public_host_verification_id_hash
     AND host.final_receipt_hash = operation.public_host_final_receipt_hash
    WHERE operation.operation_id_hash = NEW.operation_id_hash
      AND operation.action = 'withdrawal'
      AND operation.status = 'reserved'
)
BEGIN
    SELECT RAISE(ABORT, 'withdrawal completion receipt lacks exact final evidence');
END;

CREATE TRIGGER gallery_withdrawal_completion_receipts_host_payload_guard
BEFORE INSERT ON gallery_withdrawal_completion_receipts
WHEN NOT EXISTS (
    SELECT 1
    FROM draft_withdrawal_finalization_operations AS operation
    JOIN gallery_public_host_absence_receipts AS host
      ON host.verification_id_hash = operation.public_host_verification_id_hash
     AND host.final_receipt_hash = operation.public_host_final_receipt_hash
    WHERE operation.operation_id_hash = NEW.operation_id_hash
      AND operation.action = 'withdrawal'
      AND operation.status = 'reserved'
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
)
BEGIN
    SELECT RAISE(ABORT, 'withdrawal completion receipt lacks exact final evidence');
END;

CREATE TRIGGER gallery_withdrawal_completion_receipts_clock_guard
BEFORE INSERT ON gallery_withdrawal_completion_receipts
WHEN NEW.withdrawn_at <> strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
BEGIN
    SELECT RAISE(ABORT, 'withdrawal completion receipt lacks exact final evidence');
END;

CREATE TRIGGER gallery_withdrawal_completion_receipts_retained_original_guard
BEFORE INSERT ON gallery_withdrawal_completion_receipts
WHEN NEW.withdrawal_kind IN ('editorial-removal', 'athlete-exclusion') AND
     NOT EXISTS (
        SELECT 1
        FROM draft_withdrawal_finalization_operations AS operation
        JOIN gallery_drafts AS draft ON draft.draft_id = operation.draft_id
        JOIN draft_publication_references AS publication
          ON publication.draft_id = operation.draft_id
        JOIN draft_upload_sessions AS upload
          ON upload.draft_id = draft.draft_id
        JOIN draft_consent_attestations AS consent
          ON consent.draft_id = upload.draft_id
         AND consent.consent_revision = upload.consent_revision
        WHERE operation.operation_id_hash = NEW.operation_id_hash
          AND operation.action = 'withdrawal'
          AND operation.status = 'reserved'
          AND NEW.private_deletion_receipt_hash IS NULL
          AND publication.private_original_deletion_confirmed = 0
          AND draft.active_consent_revision IS NOT NULL
          AND upload.status = 'complete'
          AND upload.object_key = draft.original_object_key
          AND upload.completed_sha256 = draft.original_sha256
          AND consent.consent_revision = draft.active_consent_revision
          AND consent.withdrawn_at IS NULL
     )
BEGIN
    SELECT RAISE(ABORT, 'withdrawal completion receipt lacks exact final evidence');
END;

CREATE TRIGGER gallery_withdrawal_completion_receipts_consent_original_guard
BEFORE INSERT ON gallery_withdrawal_completion_receipts
WHEN NEW.withdrawal_kind = 'consent-withdrawal' AND NOT EXISTS (
    SELECT 1
    FROM draft_withdrawal_finalization_operations AS operation
    JOIN gallery_drafts AS draft ON draft.draft_id = operation.draft_id
    JOIN draft_publication_references AS publication
      ON publication.draft_id = operation.draft_id
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
    WHERE operation.operation_id_hash = NEW.operation_id_hash
      AND operation.action = 'withdrawal'
      AND operation.status = 'reserved'
      AND deletion.draft_id = draft.draft_id
      AND deletion.status = 'absent'
      AND deletion.completed_at = tombstone.deleted_at
      AND tombstone.deletion_receipt_hash = NEW.private_deletion_receipt_hash
      AND publication.private_original_deletion_confirmed = 1
      AND draft.active_consent_revision IS NULL
      AND upload.status = 'deleted'
      AND upload.object_deleted_at = tombstone.deleted_at
      AND consent.withdrawn_at IS NOT NULL
      AND NEW.withdrawn_at >= consent.withdrawn_at
)
BEGIN
    SELECT RAISE(ABORT, 'withdrawal completion receipt lacks exact final evidence');
END;

-- Split the draft-state guard for the same reason. The completion receipt is
-- already present when the 0013 AFTER INSERT trigger performs this update.
DROP TRIGGER gallery_drafts_withdrawal_evidence_guard;

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
      AND receipt.public_host_verification_id_hash =
          operation.public_host_verification_id_hash
      AND receipt.public_host_final_receipt_hash =
          operation.public_host_final_receipt_hash
      AND publication.withdrawal_kind = operation.withdrawal_kind
      AND publication.host_deletion_confirmed = 1
)
BEGIN
    SELECT RAISE(ABORT, 'final withdrawal requires an exact completion receipt');
END;

CREATE TRIGGER gallery_drafts_withdrawal_derivative_absence_guard
BEFORE UPDATE OF state ON gallery_drafts
WHEN NEW.state = 'withdrawn' AND EXISTS (
    SELECT 1 FROM draft_derivatives AS derivative
    WHERE derivative.draft_id = OLD.draft_id
)
BEGIN
    SELECT RAISE(ABORT, 'final withdrawal requires an exact completion receipt');
END;

CREATE TRIGGER gallery_drafts_withdrawal_terminal_source_guard
BEFORE UPDATE OF state ON gallery_drafts
WHEN NEW.state = 'withdrawn' AND (
    SELECT COUNT(*)
    FROM draft_withdrawal_finalization_operations AS operation
    JOIN gallery_terminal_photo_withdrawal_transitions AS terminal
      ON terminal.draft_id = operation.draft_id
     AND terminal.cleanup_state_version = operation.expected_state_version
     AND terminal.withdrawal_kind = operation.withdrawal_kind
    WHERE operation.draft_id = OLD.draft_id
      AND operation.action = 'withdrawal'
      AND operation.status = 'reserved'
) <> 1
BEGIN
    SELECT RAISE(ABORT, 'final withdrawal requires an exact completion receipt');
END;

CREATE TRIGGER gallery_drafts_withdrawal_cleanup_guard
BEFORE UPDATE OF state ON gallery_drafts
WHEN NEW.state = 'withdrawn' AND (
    SELECT COUNT(*)
    FROM draft_withdrawal_finalization_operations AS operation
    JOIN gallery_complete_photo_withdrawal_cleanups AS cleanup
      ON cleanup.draft_id = operation.draft_id
     AND cleanup.cleanup_state_version = operation.expected_state_version
     AND cleanup.withdrawal_kind = operation.withdrawal_kind
    WHERE operation.draft_id = OLD.draft_id
      AND operation.action = 'withdrawal'
      AND operation.status = 'reserved'
) <> 1
BEGIN
    SELECT RAISE(ABORT, 'final withdrawal requires an exact completion receipt');
END;

CREATE TRIGGER gallery_drafts_withdrawal_retained_original_guard
BEFORE UPDATE OF state ON gallery_drafts
WHEN NEW.state = 'withdrawn' AND EXISTS (
    SELECT 1
    FROM draft_withdrawal_finalization_operations AS operation
    JOIN gallery_withdrawal_completion_receipts AS receipt
      ON receipt.operation_id_hash = operation.operation_id_hash
     AND receipt.draft_id_hash = operation.draft_id_hash
    JOIN draft_publication_references AS publication
      ON publication.draft_id = operation.draft_id
    WHERE operation.draft_id = OLD.draft_id
      AND operation.action = 'withdrawal'
      AND operation.status = 'reserved'
      AND operation.withdrawal_kind IN ('editorial-removal', 'athlete-exclusion')
      AND NOT (
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
      )
)
BEGIN
    SELECT RAISE(ABORT, 'final withdrawal requires an exact completion receipt');
END;

CREATE TRIGGER gallery_drafts_withdrawal_consent_original_guard
BEFORE UPDATE OF state ON gallery_drafts
WHEN NEW.state = 'withdrawn' AND EXISTS (
    SELECT 1
    FROM draft_withdrawal_finalization_operations AS operation
    JOIN gallery_withdrawal_completion_receipts AS receipt
      ON receipt.operation_id_hash = operation.operation_id_hash
     AND receipt.draft_id_hash = operation.draft_id_hash
    JOIN draft_publication_references AS publication
      ON publication.draft_id = operation.draft_id
    WHERE operation.draft_id = OLD.draft_id
      AND operation.action = 'withdrawal'
      AND operation.status = 'reserved'
      AND operation.withdrawal_kind = 'consent-withdrawal'
      AND NOT (
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
                AND tombstone.deletion_receipt_hash =
                    receipt.private_deletion_receipt_hash
                AND upload.status = 'deleted'
                AND consent.withdrawn_at IS NOT NULL
          )
      )
)
BEGIN
    SELECT RAISE(ABORT, 'final withdrawal requires an exact completion receipt');
END;

PRAGMA foreign_key_check;
