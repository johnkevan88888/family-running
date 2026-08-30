PRAGMA foreign_keys = ON;

-- One draft can complete only one transition from a given state version.
-- This lets an atomic D1 batch insert its transition receipt unconditionally:
-- a stale competing mutation either fails the existing result-state trigger or
-- collides with the winner's state-version receipt, rolling the whole batch
-- back without relying on connection-local changes() state.
CREATE UNIQUE INDEX draft_transition_receipts_state_version_unique
    ON draft_transition_receipts(draft_id, expected_state_version);

-- Extend the append-only replacement guard to the new uniqueness constraint.
-- SQLite's INSERT OR REPLACE may otherwise delete the winning receipt and
-- insert a different idempotency key for the same draft version without firing
-- the direct-delete guard when recursive triggers are disabled.
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
