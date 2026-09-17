PRAGMA foreign_keys = ON;

-- Migration 0014 split the completion-receipt guard successfully, but its
-- operation-reservation guard still expands the terminal-source view inside
-- an already-large state check. D1 rejects that combined expression at its
-- production depth limit. Keep the same two fail-closed checks, but compile
-- them as independent BEFORE INSERT triggers.
DROP TRIGGER draft_withdrawal_finalization_operations_withdrawal_source_guard;

CREATE TRIGGER draft_withdrawal_finalization_operations_withdrawal_state_guard
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
          SELECT 1
          FROM draft_derivatives AS derivative
          WHERE derivative.draft_id = draft.draft_id
      )
)
BEGIN
    SELECT RAISE(
        ABORT,
        'withdrawal finalization operation lacks exact current evidence'
    );
END;

CREATE TRIGGER draft_withdrawal_finalization_operations_withdrawal_source_guard
BEFORE INSERT ON draft_withdrawal_finalization_operations
WHEN NEW.action = 'withdrawal' AND NOT EXISTS (
    SELECT 1
    FROM gallery_terminal_photo_withdrawal_transitions AS terminal
    WHERE terminal.draft_id = NEW.draft_id
      AND terminal.cleanup_state_version = NEW.expected_state_version
      AND terminal.withdrawal_kind = NEW.withdrawal_kind
    GROUP BY terminal.draft_id
    HAVING COUNT(*) = 1
)
BEGIN
    SELECT RAISE(
        ABORT,
        'withdrawal finalization operation lacks exact current evidence'
    );
END;
