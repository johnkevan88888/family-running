PRAGMA foreign_keys = ON;

-- Restore migration 0006's append-only rule where the state-version unique
-- index exists but the older, idempotency-only trigger remains installed.
-- Do not rewrite applied migrations, recreate the index, or change any row.
-- Guard both conflicts before INSERT OR REPLACE can delete a winning receipt,
-- including when recursive delete triggers are disabled.
DROP TRIGGER draft_transition_receipts_no_replace_guard;

CREATE TRIGGER draft_transition_receipts_no_replace_guard
BEFORE INSERT ON draft_transition_receipts
WHEN EXISTS (
    SELECT 1 FROM draft_transition_receipts AS existing
    WHERE existing.draft_id = NEW.draft_id
      AND (
          existing.idempotency_key = NEW.idempotency_key OR
          existing.expected_state_version = NEW.expected_state_version
      )
)
BEGIN
    SELECT RAISE(ABORT, 'transition receipt replacement is forbidden');
END;
