PRAGMA foreign_keys = ON;

-- Preserve the exact original result of one proactive athlete-exclusion
-- request. Drafts may later become withdrawn or be purged, so replay must read
-- this immutable receipt instead of reconstructing the response from current
-- lifecycle rows. The canonical JSON contains opaque draft IDs only.
CREATE TABLE athlete_exclusion_request_receipts (
    athlete_id TEXT PRIMARY KEY
        CHECK (
            length(athlete_id) BETWEEN 1 AND 100 AND
            athlete_id = lower(athlete_id) AND
            athlete_id NOT GLOB '*[^a-z0-9-]*' AND
            athlete_id NOT LIKE '-%' AND
            athlete_id NOT LIKE '%-' AND
            athlete_id NOT LIKE '%--%'
        ),
    request_audit_hash TEXT NOT NULL UNIQUE
        CHECK (
            length(request_audit_hash) = 64 AND
            request_audit_hash NOT GLOB '*[^0-9a-f]*'
        ),
    idempotency_key_hash TEXT NOT NULL UNIQUE
        CHECK (
            length(idempotency_key_hash) = 64 AND
            idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
        ),
    payload_fingerprint TEXT NOT NULL
        CHECK (
            length(payload_fingerprint) = 64 AND
            payload_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
    actor_identity_hash TEXT NOT NULL
        CHECK (
            length(actor_identity_hash) = 64 AND
            actor_identity_hash NOT GLOB '*[^0-9a-f]*'
        ),
    expected_suppression_revision TEXT NOT NULL,
    affected_draft_ids_json TEXT NOT NULL
        CHECK (
            json_valid(affected_draft_ids_json) AND
            json_type(affected_draft_ids_json) = 'array'
        ),
    affected_draft_ids_hash TEXT NOT NULL
        CHECK (
            length(affected_draft_ids_hash) = 64 AND
            affected_draft_ids_hash NOT GLOB '*[^0-9a-f]*'
        ),
    affected_draft_count INTEGER NOT NULL
        CHECK (affected_draft_count >= 0),
    created_at TEXT NOT NULL,
    CHECK (affected_draft_count = json_array_length(affected_draft_ids_json))
);

CREATE TRIGGER athlete_exclusion_request_receipts_no_replace_guard
BEFORE INSERT ON athlete_exclusion_request_receipts
WHEN EXISTS (
    SELECT 1 FROM athlete_exclusion_request_receipts AS existing
    WHERE existing.athlete_id = NEW.athlete_id
       OR existing.request_audit_hash = NEW.request_audit_hash
       OR existing.idempotency_key_hash = NEW.idempotency_key_hash
)
BEGIN
    SELECT RAISE(ABORT, 'athlete exclusion request receipt replacement is forbidden');
END;

CREATE TRIGGER athlete_exclusion_request_receipts_insert_guard
BEFORE INSERT ON athlete_exclusion_request_receipts
WHEN NOT EXISTS (
    SELECT 1
    FROM pending_athlete_exclusions AS exclusion
    WHERE exclusion.athlete_id = NEW.athlete_id
      AND exclusion.request_audit_hash = NEW.request_audit_hash
      AND exclusion.actor_identity_hash = NEW.actor_identity_hash
      AND exclusion.expected_suppression_revision =
          NEW.expected_suppression_revision
      AND exclusion.resolved_at IS NULL
) OR EXISTS (
    SELECT 1
    FROM json_each(NEW.affected_draft_ids_json) AS affected
    WHERE affected.type <> 'text'
       OR affected.value NOT GLOB
          'draft_[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
) OR EXISTS (
    SELECT 1
    FROM json_each(NEW.affected_draft_ids_json) AS affected
    JOIN json_each(NEW.affected_draft_ids_json) AS previous
      ON previous.key = affected.key - 1
    WHERE affected.value <= previous.value
) OR EXISTS (
    SELECT 1
    FROM json_each(NEW.affected_draft_ids_json) AS affected
    WHERE NOT EXISTS (
        SELECT 1
        FROM gallery_drafts AS draft
        JOIN json_each(draft.athlete_ids_json) AS tag
          ON tag.value = NEW.athlete_id
        WHERE draft.draft_id = affected.value
          AND draft.state <> 'withdrawn'
    )
) OR EXISTS (
    SELECT 1
    FROM gallery_drafts AS draft
    JOIN json_each(draft.athlete_ids_json) AS tag
      ON tag.value = NEW.athlete_id
    WHERE draft.state <> 'withdrawn'
      AND NOT EXISTS (
          SELECT 1
          FROM json_each(NEW.affected_draft_ids_json) AS affected
          WHERE affected.value = draft.draft_id
      )
)
BEGIN
    SELECT RAISE(ABORT, 'athlete exclusion request receipt lacks the exact original draft set');
END;

CREATE TRIGGER athlete_exclusion_request_receipts_no_update
BEFORE UPDATE ON athlete_exclusion_request_receipts
BEGIN
    SELECT RAISE(ABORT, 'athlete exclusion request receipts are immutable');
END;

CREATE TRIGGER athlete_exclusion_request_receipts_no_delete
BEFORE DELETE ON athlete_exclusion_request_receipts
BEGIN
    SELECT RAISE(ABORT, 'athlete exclusion request receipts are append-only');
END;
