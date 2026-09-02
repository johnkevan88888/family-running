PRAGMA foreign_keys = ON;

-- Reserve one exact candidate before any GitHub mutation. The row then carries
-- the independently read-back Pull Request evidence until it reaches one of
-- two terminal, unmerged outcomes. This migration deliberately does not make
-- the draft states `pr-open` or `published` reachable.
CREATE TABLE draft_photo_review_receipts (
    review_id TEXT PRIMARY KEY
        CHECK (
            length(review_id) = 39 AND
            substr(review_id, 1, 7) = 'review_' AND
            substr(review_id, 8) NOT GLOB '*[^0-9a-f]*'
        ),
    draft_id TEXT NOT NULL UNIQUE,
    promotion_id TEXT NOT NULL UNIQUE
        CHECK (
            length(promotion_id) = 42 AND
            substr(promotion_id, 1, 10) = 'promotion_' AND
            substr(promotion_id, 11) NOT GLOB '*[^0-9a-f]*'
        ),
    processing_run_id TEXT NOT NULL UNIQUE
        CHECK (
            length(processing_run_id) = 36 AND
            substr(processing_run_id, 1, 4) = 'run_' AND
            substr(processing_run_id, 5) NOT GLOB '*[^0-9a-f]*' AND
            substr(processing_run_id, 17, 1) = '4' AND
            substr(processing_run_id, 21, 1) IN ('8', '9', 'a', 'b')
        ),
    candidate_state_version INTEGER NOT NULL CHECK (candidate_state_version >= 1),
    candidate_payload_hash TEXT NOT NULL
        CHECK (
            length(candidate_payload_hash) = 64 AND
            candidate_payload_hash NOT GLOB '*[^0-9a-f]*'
        ),
    generation_fingerprint TEXT NOT NULL
        CHECK (
            length(generation_fingerprint) = 64 AND
            generation_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
    repository TEXT NOT NULL
        CHECK (repository = 'johnkevan88888/family-running'),
    base_ref TEXT NOT NULL CHECK (base_ref = 'main'),
    base_sha TEXT NOT NULL
        CHECK (
            length(base_sha) = 40 AND
            base_sha NOT GLOB '*[^0-9a-f]*'
        ),
    branch_ref TEXT NOT NULL UNIQUE
        CHECK (
            length(branch_ref) = 56 AND
            substr(branch_ref, 1, 24) = 'gallery-media/candidate-' AND
            substr(branch_ref, 25) NOT GLOB '*[^0-9a-f]*'
        ),
    target_relative_path TEXT NOT NULL
        CHECK (target_relative_path IN (
            'gallery-data/family.json',
            'gallery-data/everyone.json'
        )),
    item_id TEXT NOT NULL
        CHECK (
            length(item_id) BETWEEN 1 AND 100 AND
            item_id = lower(item_id) AND
            item_id NOT GLOB '*[^a-z0-9-]*' AND
            item_id NOT LIKE '-%' AND
            item_id NOT LIKE '%-' AND
            item_id NOT LIKE '%--%'
        ),
    manifest_sha256 TEXT NOT NULL
        CHECK (
            length(manifest_sha256) = 71 AND
            substr(manifest_sha256, 1, 7) = 'sha256:' AND
            substr(manifest_sha256, 8) NOT GLOB '*[^0-9a-f]*'
        ),
    operation_marker_hash TEXT NOT NULL UNIQUE
        CHECK (
            length(operation_marker_hash) = 64 AND
            operation_marker_hash NOT GLOB '*[^0-9a-f]*'
        ),
    workflow_run_reference TEXT NOT NULL
        CHECK (length(workflow_run_reference) BETWEEN 1 AND 256),
    status TEXT NOT NULL DEFAULT 'reserved'
        CHECK (status IN ('reserved', 'open', 'terminal')),
    reservation_idempotency_key TEXT NOT NULL
        CHECK (
            length(reservation_idempotency_key) BETWEEN 16 AND 128 AND
            reservation_idempotency_key NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
    reservation_idempotency_key_hash TEXT NOT NULL
        CHECK (
            length(reservation_idempotency_key_hash) = 64 AND
            reservation_idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
        ),
    reservation_payload_fingerprint TEXT NOT NULL
        CHECK (
            length(reservation_payload_fingerprint) = 64 AND
            reservation_payload_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
    service_actor_identity_hash TEXT NOT NULL
        CHECK (
            length(service_actor_identity_hash) = 64 AND
            service_actor_identity_hash NOT GLOB '*[^0-9a-f]*'
        ),
    pull_request_number INTEGER CHECK (pull_request_number >= 1),
    pull_request_url TEXT,
    head_sha TEXT
        CHECK (
            head_sha IS NULL OR (
                length(head_sha) = 40 AND
                head_sha NOT GLOB '*[^0-9a-f]*'
            )
        ),
    open_evidence_hash TEXT
        CHECK (
            open_evidence_hash IS NULL OR (
                length(open_evidence_hash) = 64 AND
                open_evidence_hash NOT GLOB '*[^0-9a-f]*'
            )
        ),
    open_idempotency_key TEXT
        CHECK (
            open_idempotency_key IS NULL OR (
                length(open_idempotency_key) BETWEEN 16 AND 128 AND
                open_idempotency_key NOT GLOB '*[^A-Za-z0-9_-]*'
            )
        ),
    open_idempotency_key_hash TEXT
        CHECK (
            open_idempotency_key_hash IS NULL OR (
                length(open_idempotency_key_hash) = 64 AND
                open_idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
            )
        ),
    open_payload_fingerprint TEXT
        CHECK (
            open_payload_fingerprint IS NULL OR (
                length(open_payload_fingerprint) = 64 AND
                open_payload_fingerprint NOT GLOB '*[^0-9a-f]*'
            )
        ),
    terminal_kind TEXT
        CHECK (
            terminal_kind IS NULL OR
            terminal_kind IN ('closed-unmerged', 'no-pr-created')
        ),
    terminal_evidence_hash TEXT
        CHECK (
            terminal_evidence_hash IS NULL OR (
                length(terminal_evidence_hash) = 64 AND
                terminal_evidence_hash NOT GLOB '*[^0-9a-f]*'
            )
        ),
    close_evidence_hash TEXT
        CHECK (
            close_evidence_hash IS NULL OR (
                length(close_evidence_hash) = 64 AND
                close_evidence_hash NOT GLOB '*[^0-9a-f]*'
            )
        ),
    readback_evidence_hash TEXT
        CHECK (
            readback_evidence_hash IS NULL OR (
                length(readback_evidence_hash) = 64 AND
                readback_evidence_hash NOT GLOB '*[^0-9a-f]*'
            )
        ),
    terminal_idempotency_key TEXT
        CHECK (
            terminal_idempotency_key IS NULL OR (
                length(terminal_idempotency_key) BETWEEN 16 AND 128 AND
                terminal_idempotency_key NOT GLOB '*[^A-Za-z0-9_-]*'
            )
        ),
    terminal_idempotency_key_hash TEXT
        CHECK (
            terminal_idempotency_key_hash IS NULL OR (
                length(terminal_idempotency_key_hash) = 64 AND
                terminal_idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
            )
        ),
    terminal_payload_fingerprint TEXT
        CHECK (
            terminal_payload_fingerprint IS NULL OR (
                length(terminal_payload_fingerprint) = 64 AND
                terminal_payload_fingerprint NOT GLOB '*[^0-9a-f]*'
            )
        ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    opened_at TEXT,
    terminal_at TEXT,
    FOREIGN KEY (draft_id) REFERENCES gallery_drafts(draft_id)
        ON DELETE CASCADE,
    UNIQUE (draft_id, reservation_idempotency_key),
    UNIQUE (draft_id, reservation_idempotency_key_hash),
    UNIQUE (draft_id, open_idempotency_key),
    UNIQUE (draft_id, open_idempotency_key_hash),
    UNIQUE (draft_id, terminal_idempotency_key),
    UNIQUE (draft_id, terminal_idempotency_key_hash),
    UNIQUE (repository, pull_request_number),
    CHECK (
        pull_request_url IS NULL OR
        pull_request_url =
            'https://github.com/' || repository || '/pull/' || pull_request_number
    ),
    CHECK (
        (
            status = 'reserved' AND
            pull_request_number IS NULL AND
            pull_request_url IS NULL AND
            head_sha IS NULL AND
            open_evidence_hash IS NULL AND
            open_idempotency_key IS NULL AND
            open_idempotency_key_hash IS NULL AND
            open_payload_fingerprint IS NULL AND
            terminal_kind IS NULL AND
            terminal_evidence_hash IS NULL AND
            close_evidence_hash IS NULL AND
            readback_evidence_hash IS NULL AND
            terminal_idempotency_key IS NULL AND
            terminal_idempotency_key_hash IS NULL AND
            terminal_payload_fingerprint IS NULL AND
            opened_at IS NULL AND
            terminal_at IS NULL AND
            updated_at = created_at
        ) OR (
            status = 'open' AND
            pull_request_number IS NOT NULL AND
            pull_request_url IS NOT NULL AND
            head_sha IS NOT NULL AND
            open_evidence_hash IS NOT NULL AND
            open_idempotency_key IS NOT NULL AND
            open_idempotency_key_hash IS NOT NULL AND
            open_payload_fingerprint IS NOT NULL AND
            terminal_kind IS NULL AND
            terminal_evidence_hash IS NULL AND
            close_evidence_hash IS NULL AND
            readback_evidence_hash IS NULL AND
            terminal_idempotency_key IS NULL AND
            terminal_idempotency_key_hash IS NULL AND
            terminal_payload_fingerprint IS NULL AND
            opened_at IS NOT NULL AND
            terminal_at IS NULL AND
            updated_at = opened_at AND
            opened_at > created_at
        ) OR (
            status = 'terminal' AND
            terminal_kind = 'no-pr-created' AND
            pull_request_number IS NULL AND
            pull_request_url IS NULL AND
            head_sha IS NULL AND
            open_evidence_hash IS NULL AND
            open_idempotency_key IS NULL AND
            open_idempotency_key_hash IS NULL AND
            open_payload_fingerprint IS NULL AND
            terminal_evidence_hash IS NOT NULL AND
            close_evidence_hash IS NULL AND
            readback_evidence_hash IS NULL AND
            terminal_idempotency_key IS NOT NULL AND
            terminal_idempotency_key_hash IS NOT NULL AND
            terminal_payload_fingerprint IS NOT NULL AND
            opened_at IS NULL AND
            terminal_at IS NOT NULL AND
            updated_at = terminal_at AND
            terminal_at > created_at
        ) OR (
            status = 'terminal' AND
            terminal_kind = 'closed-unmerged' AND
            pull_request_number IS NOT NULL AND
            pull_request_url IS NOT NULL AND
            head_sha IS NOT NULL AND
            terminal_evidence_hash IS NOT NULL AND
            close_evidence_hash IS NOT NULL AND
            readback_evidence_hash IS NOT NULL AND
            terminal_idempotency_key IS NOT NULL AND
            terminal_idempotency_key_hash IS NOT NULL AND
            terminal_payload_fingerprint IS NOT NULL AND
            terminal_at IS NOT NULL AND
            updated_at = terminal_at AND
            (
                (
                    open_evidence_hash IS NOT NULL AND
                    open_idempotency_key IS NOT NULL AND
                    open_idempotency_key_hash IS NOT NULL AND
                    open_payload_fingerprint IS NOT NULL AND
                    opened_at IS NOT NULL AND
                    terminal_at > opened_at
                ) OR (
                    open_evidence_hash IS NULL AND
                    open_idempotency_key IS NULL AND
                    open_idempotency_key_hash IS NULL AND
                    open_payload_fingerprint IS NULL AND
                    opened_at IS NULL AND
                    terminal_at > created_at
                )
            )
        )
    )
);

CREATE INDEX draft_photo_review_receipts_status_index
    ON draft_photo_review_receipts(status, updated_at);

-- A failure before the review reservation exists still needs a durable owner
-- of the exact candidate. Keep this receipt independent of the promotion row
-- so approved-media cleanup cannot erase why the draft was compensated into
-- withdrawal-pending. It disappears only with the guarded parent-draft purge.
CREATE TABLE draft_photo_review_abandonment_receipts (
    draft_id TEXT PRIMARY KEY,
    promotion_id TEXT NOT NULL UNIQUE
        CHECK (
            length(promotion_id) = 42 AND
            substr(promotion_id, 1, 10) = 'promotion_' AND
            substr(promotion_id, 11) NOT GLOB '*[^0-9a-f]*'
        ),
    processing_run_id TEXT NOT NULL UNIQUE
        CHECK (
            length(processing_run_id) = 36 AND
            substr(processing_run_id, 1, 4) = 'run_' AND
            substr(processing_run_id, 5) NOT GLOB '*[^0-9a-f]*' AND
            substr(processing_run_id, 17, 1) = '4' AND
            substr(processing_run_id, 21, 1) IN ('8', '9', 'a', 'b')
        ),
    expected_state_version INTEGER NOT NULL CHECK (expected_state_version >= 1),
    result_state_version INTEGER NOT NULL
        CHECK (result_state_version = expected_state_version + 1),
    failure_evidence_hash TEXT NOT NULL
        CHECK (
            length(failure_evidence_hash) = 64 AND
            failure_evidence_hash NOT GLOB '*[^0-9a-f]*'
        ),
    idempotency_key TEXT NOT NULL
        CHECK (
            length(idempotency_key) BETWEEN 16 AND 128 AND
            idempotency_key NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
    idempotency_key_hash TEXT NOT NULL
        CHECK (
            length(idempotency_key_hash) = 64 AND
            idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
        ),
    payload_fingerprint TEXT NOT NULL
        CHECK (
            length(payload_fingerprint) = 64 AND
            payload_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
    service_actor_identity_hash TEXT NOT NULL
        CHECK (
            length(service_actor_identity_hash) = 64 AND
            service_actor_identity_hash NOT GLOB '*[^0-9a-f]*'
        ),
    created_at TEXT NOT NULL,
    FOREIGN KEY (draft_id) REFERENCES gallery_drafts(draft_id)
        ON DELETE CASCADE
);

CREATE TRIGGER draft_photo_review_abandonment_receipts_no_replace_guard
BEFORE INSERT ON draft_photo_review_abandonment_receipts
WHEN EXISTS (
    SELECT 1 FROM draft_photo_review_abandonment_receipts AS existing
    WHERE existing.draft_id = NEW.draft_id
       OR existing.promotion_id = NEW.promotion_id
       OR existing.processing_run_id = NEW.processing_run_id
       OR (
           existing.draft_id = NEW.draft_id AND
           existing.idempotency_key = NEW.idempotency_key
       )
       OR (
           existing.draft_id = NEW.draft_id AND
           existing.idempotency_key_hash = NEW.idempotency_key_hash
       )
)
BEGIN
    SELECT RAISE(ABORT, 'photo review abandonment receipt replacement is forbidden');
END;

CREATE TRIGGER draft_photo_review_abandonment_receipts_insert_guard
BEFORE INSERT ON draft_photo_review_abandonment_receipts
WHEN EXISTS (
    SELECT 1 FROM draft_photo_review_receipts AS review
    WHERE review.draft_id = NEW.draft_id
       OR review.promotion_id = NEW.promotion_id
       OR review.processing_run_id = NEW.processing_run_id
) OR NOT EXISTS (
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
)
BEGIN
    SELECT RAISE(ABORT, 'photo review abandonment lacks exact unreserved candidate evidence');
END;

CREATE TRIGGER draft_photo_review_abandonment_receipts_no_update
BEFORE UPDATE ON draft_photo_review_abandonment_receipts
BEGIN
    SELECT RAISE(ABORT, 'photo review abandonment receipt is immutable');
END;

CREATE TRIGGER draft_photo_review_abandonment_receipts_direct_delete_guard
BEFORE DELETE ON draft_photo_review_abandonment_receipts
WHEN EXISTS (
    SELECT 1 FROM gallery_drafts AS parent
    WHERE parent.draft_id = OLD.draft_id
)
BEGIN
    SELECT RAISE(ABORT, 'photo review abandonment direct deletion is forbidden; approved draft purge only');
END;

CREATE TRIGGER draft_photo_review_receipts_no_replace_guard
BEFORE INSERT ON draft_photo_review_receipts
WHEN EXISTS (
    SELECT 1 FROM draft_photo_review_receipts AS existing
    WHERE existing.review_id = NEW.review_id
       OR existing.draft_id = NEW.draft_id
       OR existing.promotion_id = NEW.promotion_id
       OR existing.processing_run_id = NEW.processing_run_id
       OR existing.branch_ref = NEW.branch_ref
       OR existing.operation_marker_hash = NEW.operation_marker_hash
       OR (
           existing.draft_id = NEW.draft_id AND
           existing.reservation_idempotency_key = NEW.reservation_idempotency_key
       )
       OR (
           existing.draft_id = NEW.draft_id AND
           existing.reservation_idempotency_key_hash =
               NEW.reservation_idempotency_key_hash
       )
       OR (
           NEW.pull_request_number IS NOT NULL AND
           existing.repository = NEW.repository AND
           existing.pull_request_number = NEW.pull_request_number
       )
)
BEGIN
    SELECT RAISE(ABORT, 'photo review receipt replacement is forbidden');
END;

-- The reservation must inherit the exact current candidate, public generation,
-- consent, area, public item, and suppression state. No browser or workflow
-- input may choose a different manifest destination.
CREATE TRIGGER draft_photo_review_receipts_insert_guard
BEFORE INSERT ON draft_photo_review_receipts
WHEN NEW.status <> 'reserved' OR NOT EXISTS (
    SELECT 1
    FROM gallery_drafts AS draft
    JOIN draft_consent_attestations AS consent
      ON consent.draft_id = draft.draft_id
     AND consent.consent_revision = draft.active_consent_revision
    JOIN draft_photo_promotions AS promotion
      ON promotion.promotion_id = NEW.promotion_id
     AND promotion.draft_id = draft.draft_id
    JOIN draft_photo_public_generations AS generation
      ON generation.promotion_id = promotion.promotion_id
     AND generation.draft_id = draft.draft_id
    WHERE draft.draft_id = NEW.draft_id
      AND draft.state = 'candidate-public'
      AND draft.state_version = NEW.candidate_state_version
      AND draft.media_type = 'photo'
      AND draft.public_item_id = NEW.item_id
      AND (
          (draft.site_modes_json = '["family"]' AND
              NEW.target_relative_path = 'gallery-data/family.json') OR
          (draft.site_modes_json = '["everyone"]' AND
              NEW.target_relative_path = 'gallery-data/everyone.json')
      )
      AND consent.public_use_confirmed = 1
      AND (consent.contains_minors = 0 OR consent.guardian_approval_confirmed = 1)
      AND consent.withdrawn_at IS NULL
      AND promotion.status = 'candidate'
      AND promotion.processing_run_id = NEW.processing_run_id
      AND promotion.result_state_version = NEW.candidate_state_version
      AND promotion.candidate_payload_hash = NEW.candidate_payload_hash
      AND generation.candidate_state_version = NEW.candidate_state_version
      AND generation.generation_fingerprint = NEW.generation_fingerprint
      AND (
          SELECT COUNT(*)
          FROM draft_photo_public_generation_targets AS target
          WHERE target.promotion_id = generation.promotion_id
            AND target.role IN ('photo-display', 'photo-thumbnail')
      ) = 2
      AND NOT EXISTS (
          SELECT 1
          FROM json_each(draft.athlete_ids_json) AS tag
          JOIN pending_athlete_exclusions AS exclusion
            ON exclusion.athlete_id = tag.value
          WHERE exclusion.resolved_at IS NULL
      )
      AND NOT EXISTS (
          SELECT 1 FROM draft_photo_promotion_cleanups AS cleanup
          WHERE cleanup.promotion_id = promotion.promotion_id
      )
      AND NOT EXISTS (
          SELECT 1 FROM draft_photo_review_abandonment_receipts AS abandonment
          WHERE abandonment.draft_id = draft.draft_id
             OR abandonment.promotion_id = promotion.promotion_id
             OR abandonment.processing_run_id = promotion.processing_run_id
      )
)
BEGIN
    SELECT RAISE(ABORT, 'photo review reservation lacks exact current candidate evidence');
END;

CREATE TRIGGER draft_photo_review_receipts_identity_update_guard
BEFORE UPDATE OF
    review_id,
    draft_id,
    promotion_id,
    processing_run_id,
    candidate_state_version,
    candidate_payload_hash,
    generation_fingerprint,
    repository,
    base_ref,
    base_sha,
    branch_ref,
    target_relative_path,
    item_id,
    manifest_sha256,
    operation_marker_hash,
    workflow_run_reference,
    reservation_idempotency_key,
    reservation_idempotency_key_hash,
    reservation_payload_fingerprint,
    service_actor_identity_hash,
    created_at
ON draft_photo_review_receipts
WHEN
    NEW.review_id IS NOT OLD.review_id OR
    NEW.draft_id IS NOT OLD.draft_id OR
    NEW.promotion_id IS NOT OLD.promotion_id OR
    NEW.processing_run_id IS NOT OLD.processing_run_id OR
    NEW.candidate_state_version IS NOT OLD.candidate_state_version OR
    NEW.candidate_payload_hash IS NOT OLD.candidate_payload_hash OR
    NEW.generation_fingerprint IS NOT OLD.generation_fingerprint OR
    NEW.repository IS NOT OLD.repository OR
    NEW.base_ref IS NOT OLD.base_ref OR
    NEW.base_sha IS NOT OLD.base_sha OR
    NEW.branch_ref IS NOT OLD.branch_ref OR
    NEW.target_relative_path IS NOT OLD.target_relative_path OR
    NEW.item_id IS NOT OLD.item_id OR
    NEW.manifest_sha256 IS NOT OLD.manifest_sha256 OR
    NEW.operation_marker_hash IS NOT OLD.operation_marker_hash OR
    NEW.workflow_run_reference IS NOT OLD.workflow_run_reference OR
    NEW.reservation_idempotency_key IS NOT OLD.reservation_idempotency_key OR
    NEW.reservation_idempotency_key_hash IS NOT OLD.reservation_idempotency_key_hash OR
    NEW.reservation_payload_fingerprint IS NOT OLD.reservation_payload_fingerprint OR
    NEW.service_actor_identity_hash IS NOT OLD.service_actor_identity_hash OR
    NEW.created_at IS NOT OLD.created_at
BEGIN
    SELECT RAISE(ABORT, 'photo review receipt identity is immutable');
END;

CREATE TRIGGER draft_photo_review_receipts_lifecycle_collision_guard
BEFORE UPDATE ON draft_photo_review_receipts
WHEN EXISTS (
    SELECT 1 FROM draft_photo_review_receipts AS existing
    WHERE existing.review_id <> OLD.review_id
      AND (
          (
              NEW.pull_request_number IS NOT NULL AND
              existing.repository = NEW.repository AND
              existing.pull_request_number = NEW.pull_request_number
          ) OR (
              NEW.open_idempotency_key IS NOT NULL AND
              existing.draft_id = NEW.draft_id AND
              existing.open_idempotency_key = NEW.open_idempotency_key
          ) OR (
              NEW.open_idempotency_key_hash IS NOT NULL AND
              existing.draft_id = NEW.draft_id AND
              existing.open_idempotency_key_hash = NEW.open_idempotency_key_hash
          ) OR (
              NEW.terminal_idempotency_key IS NOT NULL AND
              existing.draft_id = NEW.draft_id AND
              existing.terminal_idempotency_key = NEW.terminal_idempotency_key
          ) OR (
              NEW.terminal_idempotency_key_hash IS NOT NULL AND
              existing.draft_id = NEW.draft_id AND
              existing.terminal_idempotency_key_hash =
                  NEW.terminal_idempotency_key_hash
          )
      )
)
BEGIN
    SELECT RAISE(ABORT, 'photo review lifecycle evidence collision');
END;

CREATE TRIGGER draft_photo_review_receipts_transition_guard
BEFORE UPDATE OF
    status,
    pull_request_number,
    pull_request_url,
    head_sha,
    open_evidence_hash,
    open_idempotency_key,
    open_idempotency_key_hash,
    open_payload_fingerprint,
    terminal_kind,
    terminal_evidence_hash,
    close_evidence_hash,
    readback_evidence_hash,
    terminal_idempotency_key,
    terminal_idempotency_key_hash,
    terminal_payload_fingerprint,
    updated_at,
    opened_at,
    terminal_at
ON draft_photo_review_receipts
WHEN NOT (
    (
        OLD.status = 'reserved' AND
        NEW.status = 'open' AND
        NEW.pull_request_number IS NOT NULL AND
        NEW.pull_request_url IS NOT NULL AND
        NEW.head_sha IS NOT NULL AND
        NEW.open_evidence_hash IS NOT NULL AND
        NEW.open_idempotency_key IS NOT NULL AND
        NEW.open_idempotency_key_hash IS NOT NULL AND
        NEW.open_payload_fingerprint IS NOT NULL AND
        NEW.opened_at IS NOT NULL AND
        NEW.updated_at = NEW.opened_at AND
        NEW.opened_at > OLD.updated_at
    ) OR (
        OLD.status = 'reserved' AND
        NEW.status = 'terminal' AND
        NEW.terminal_kind = 'no-pr-created' AND
        NEW.terminal_evidence_hash IS NOT NULL AND
        NEW.terminal_idempotency_key IS NOT NULL AND
        NEW.terminal_idempotency_key_hash IS NOT NULL AND
        NEW.terminal_payload_fingerprint IS NOT NULL AND
        NEW.terminal_at IS NOT NULL AND
        NEW.updated_at = NEW.terminal_at AND
        NEW.terminal_at > OLD.updated_at
    ) OR (
        OLD.status = 'reserved' AND
        NEW.status = 'terminal' AND
        NEW.terminal_kind = 'closed-unmerged' AND
        NEW.pull_request_number IS NOT NULL AND
        NEW.pull_request_url IS NOT NULL AND
        NEW.head_sha IS NOT NULL AND
        NEW.open_evidence_hash IS NULL AND
        NEW.open_idempotency_key IS NULL AND
        NEW.open_idempotency_key_hash IS NULL AND
        NEW.open_payload_fingerprint IS NULL AND
        NEW.opened_at IS NULL AND
        NEW.terminal_evidence_hash IS NOT NULL AND
        NEW.close_evidence_hash IS NOT NULL AND
        NEW.readback_evidence_hash IS NOT NULL AND
        NEW.terminal_idempotency_key IS NOT NULL AND
        NEW.terminal_idempotency_key_hash IS NOT NULL AND
        NEW.terminal_payload_fingerprint IS NOT NULL AND
        NEW.terminal_at IS NOT NULL AND
        NEW.updated_at = NEW.terminal_at AND
        NEW.terminal_at > OLD.updated_at
    ) OR (
        OLD.status = 'open' AND
        NEW.status = 'terminal' AND
        NEW.terminal_kind = 'closed-unmerged' AND
        NEW.pull_request_number IS OLD.pull_request_number AND
        NEW.pull_request_url IS OLD.pull_request_url AND
        NEW.head_sha IS OLD.head_sha AND
        NEW.open_evidence_hash IS OLD.open_evidence_hash AND
        NEW.open_idempotency_key IS OLD.open_idempotency_key AND
        NEW.open_idempotency_key_hash IS OLD.open_idempotency_key_hash AND
        NEW.open_payload_fingerprint IS OLD.open_payload_fingerprint AND
        NEW.opened_at IS OLD.opened_at AND
        NEW.terminal_evidence_hash IS NOT NULL AND
        NEW.close_evidence_hash IS NOT NULL AND
        NEW.readback_evidence_hash IS NOT NULL AND
        NEW.terminal_idempotency_key IS NOT NULL AND
        NEW.terminal_idempotency_key_hash IS NOT NULL AND
        NEW.terminal_payload_fingerprint IS NOT NULL AND
        NEW.terminal_at IS NOT NULL AND
        NEW.updated_at = NEW.terminal_at AND
        NEW.terminal_at > OLD.updated_at
    )
)
BEGIN
    SELECT RAISE(ABORT, 'invalid photo review receipt transition');
END;

-- The service performs a fresh candidate read before recording the Pull
-- Request, but that read is not the write boundary. Recheck every mutable
-- eligibility fact inside the reserved -> open update so a withdrawal,
-- consent/revision change, athlete exclusion, or cleanup that wins the race
-- leaves the receipt reserved for the invalidation-recovery path.
CREATE TRIGGER draft_photo_review_receipts_open_candidate_guard
BEFORE UPDATE OF status ON draft_photo_review_receipts
WHEN OLD.status = 'reserved' AND NEW.status = 'open' AND NOT EXISTS (
    SELECT 1
    FROM gallery_drafts AS draft
    JOIN draft_consent_attestations AS consent
      ON consent.draft_id = draft.draft_id
     AND consent.consent_revision = draft.active_consent_revision
    JOIN draft_photo_promotions AS promotion
      ON promotion.promotion_id = OLD.promotion_id
     AND promotion.draft_id = draft.draft_id
    JOIN draft_photo_public_generations AS generation
      ON generation.promotion_id = promotion.promotion_id
     AND generation.draft_id = draft.draft_id
    LEFT JOIN draft_publication_references AS publication
      ON publication.draft_id = draft.draft_id
    WHERE draft.draft_id = OLD.draft_id
      AND draft.state = 'candidate-public'
      AND draft.state_version = OLD.candidate_state_version
      AND draft.media_type = 'photo'
      AND draft.public_item_id = OLD.item_id
      AND draft.item_revision = promotion.item_revision
      AND draft.active_consent_revision = promotion.consent_revision
      AND draft.export_bundle_id = promotion.export_bundle_id
      AND draft.source_revision = promotion.source_revision
      AND draft.suppression_revision = promotion.suppression_revision
      AND consent.public_use_confirmed = 1
      AND (consent.contains_minors = 0 OR consent.guardian_approval_confirmed = 1)
      AND consent.withdrawn_at IS NULL
      AND publication.withdrawal_kind IS NULL
      AND promotion.status = 'candidate'
      AND promotion.processing_run_id = OLD.processing_run_id
      AND promotion.result_state_version = OLD.candidate_state_version
      AND promotion.candidate_payload_hash = OLD.candidate_payload_hash
      AND generation.candidate_state_version = OLD.candidate_state_version
      AND generation.generation_fingerprint = OLD.generation_fingerprint
      AND (
          SELECT COUNT(*)
          FROM draft_photo_public_generation_targets AS target
          WHERE target.promotion_id = generation.promotion_id
            AND target.role IN ('photo-display', 'photo-thumbnail')
      ) = 2
      AND NOT EXISTS (
          SELECT 1
          FROM json_each(draft.athlete_ids_json) AS tag
          JOIN pending_athlete_exclusions AS exclusion
            ON exclusion.athlete_id = tag.value
          WHERE exclusion.resolved_at IS NULL
      )
      AND NOT EXISTS (
          SELECT 1 FROM draft_photo_promotion_cleanups AS cleanup
          WHERE cleanup.promotion_id = promotion.promotion_id
      )
)
BEGIN
    SELECT RAISE(ABORT, 'photo review open lost current candidate eligibility');
END;

CREATE TRIGGER draft_photo_review_receipts_direct_delete_guard
BEFORE DELETE ON draft_photo_review_receipts
WHEN EXISTS (
    SELECT 1 FROM gallery_drafts AS parent
    WHERE parent.draft_id = OLD.draft_id
)
BEGIN
    SELECT RAISE(ABORT, 'photo review receipt direct deletion is forbidden; approved draft purge only');
END;

-- An owner can begin a withdrawal while a review is open so that the workflow
-- can close it, but final withdrawal cannot outrun an unclosed or ambiguous
-- GitHub operation.
CREATE TRIGGER gallery_drafts_photo_review_withdrawal_guard
BEFORE UPDATE OF state ON gallery_drafts
WHEN NEW.state = 'withdrawn' AND EXISTS (
    SELECT 1 FROM draft_photo_review_receipts AS review
    WHERE review.draft_id = OLD.draft_id
      AND review.status IN ('reserved', 'open')
)
BEGIN
    SELECT RAISE(ABORT, 'open or reserved photo review must be terminal before withdrawal');
END;

-- Final withdrawal must not strand the receipt-bound private staging objects.
-- Approved-media cleanup is already a prerequisite for starting processing
-- cleanup (migration 0008). This final gate additionally requires the exact
-- candidate -> withdrawal cleanup version, a completed processing cleanup, and
-- its immutable hash-only tombstone for both review and pre-review abandonment.
CREATE TRIGGER gallery_drafts_photo_review_cleanup_guard
BEFORE UPDATE OF state ON gallery_drafts
WHEN NEW.state = 'withdrawn' AND EXISTS (
    SELECT 1
    FROM (
        SELECT
            review.promotion_id AS promotion_id,
            review.processing_run_id AS processing_run_id,
            review.candidate_state_version + 1 AS cleanup_state_version
        FROM draft_photo_review_receipts AS review
        WHERE review.draft_id = OLD.draft_id
          AND review.status = 'terminal'
        UNION ALL
        SELECT
            abandonment.promotion_id AS promotion_id,
            abandonment.processing_run_id AS processing_run_id,
            abandonment.result_state_version AS cleanup_state_version
        FROM draft_photo_review_abandonment_receipts AS abandonment
        WHERE abandonment.draft_id = OLD.draft_id
    ) AS receipt
    WHERE NOT EXISTS (
        SELECT 1
        FROM draft_photo_promotion_cleanups AS cleanup
        JOIN gallery_photo_promotion_cleanup_tombstones AS tombstone
          ON tombstone.cleanup_id_hash = cleanup.cleanup_id_hash
         AND tombstone.promotion_id_hash = cleanup.promotion_id_hash
         AND tombstone.processing_run_id_hash = cleanup.processing_run_id_hash
         AND tombstone.draft_id_hash = cleanup.draft_id_hash
         AND tombstone.source_promotion_idempotency_key_hash =
             cleanup.source_promotion_idempotency_key_hash
         AND tombstone.source_promotion_payload_fingerprint =
             cleanup.source_promotion_payload_fingerprint
         AND tombstone.cleanup_idempotency_key_hash =
             cleanup.cleanup_idempotency_key_hash
         AND tombstone.cleanup_payload_fingerprint = cleanup.payload_fingerprint
         AND tombstone.cleanup_reason = cleanup.cleanup_reason
         AND tombstone.withdrawal_kind IS cleanup.withdrawal_kind
         AND tombstone.evidence_hash = cleanup.cleanup_evidence_hash
         AND tombstone.completed_at = cleanup.completed_at
        WHERE cleanup.promotion_id = receipt.promotion_id
          AND cleanup.processing_run_id = receipt.processing_run_id
          AND cleanup.draft_id = OLD.draft_id
          AND cleanup.expected_state_version = receipt.cleanup_state_version
          AND cleanup.cleanup_reason IN ('withdrawal', 'athlete-exclusion')
          AND cleanup.status = 'cleaned'
    ) OR NOT EXISTS (
        SELECT 1
        FROM draft_processing_cleanups AS cleanup
        JOIN gallery_processing_cleanup_tombstones AS tombstone
          ON tombstone.evidence_hash = cleanup.cleanup_evidence_hash
         AND tombstone.cleanup_id_hash = cleanup.cleanup_id_hash
         AND tombstone.draft_id_hash = cleanup.draft_id_hash
         AND tombstone.processing_run_id_hash = cleanup.processing_run_id_hash
         AND tombstone.cleanup_reason = cleanup.cleanup_reason
         AND tombstone.completed_at = cleanup.completed_at
        WHERE cleanup.processing_run_id = receipt.processing_run_id
          AND cleanup.draft_id = OLD.draft_id
          AND cleanup.expected_state_version = receipt.cleanup_state_version
          AND cleanup.cleanup_reason IN ('withdrawal', 'athlete-exclusion')
          AND cleanup.status = 'cleaned'
    )
)
BEGIN
    SELECT RAISE(ABORT, 'photo review approved and staging cleanup tombstones are required before withdrawal');
END;

PRAGMA foreign_key_check;
