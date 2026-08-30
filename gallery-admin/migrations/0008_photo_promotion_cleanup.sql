PRAGMA foreign_keys = ON;

-- Approved-media cleanup is a separate, forward-only closure boundary. The
-- operational promotion rows remain the source snapshot until every known
-- multipart handle is terminal and every exact approved object is absent.
-- The final transaction removes those operational rows and retains this
-- cleanup plus a hash-only tombstone.
CREATE TABLE draft_photo_promotion_cleanups (
    cleanup_id TEXT PRIMARY KEY
        CHECK (
            length(cleanup_id) = 41 AND
            substr(cleanup_id, 1, 9) = 'pcleanup_' AND
            substr(cleanup_id, 10) NOT GLOB '*[^0-9a-f]*' AND
            substr(cleanup_id, 22, 1) = '4' AND
            substr(cleanup_id, 26, 1) IN ('8', '9', 'a', 'b')
        ),
    cleanup_id_hash TEXT NOT NULL UNIQUE
        CHECK (
            length(cleanup_id_hash) = 64 AND
            cleanup_id_hash NOT GLOB '*[^0-9a-f]*'
        ),
    promotion_id TEXT NOT NULL UNIQUE
        CHECK (
            length(promotion_id) = 42 AND
            substr(promotion_id, 1, 10) = 'promotion_' AND
            substr(promotion_id, 11) NOT GLOB '*[^0-9a-f]*'
        ),
    promotion_id_hash TEXT NOT NULL UNIQUE
        CHECK (
            length(promotion_id_hash) = 64 AND
            promotion_id_hash NOT GLOB '*[^0-9a-f]*'
        ),
    processing_run_id TEXT NOT NULL,
    processing_run_id_hash TEXT NOT NULL
        CHECK (
            length(processing_run_id_hash) = 64 AND
            processing_run_id_hash NOT GLOB '*[^0-9a-f]*'
        ),
    draft_id TEXT NOT NULL,
    draft_id_hash TEXT NOT NULL
        CHECK (
            length(draft_id_hash) = 64 AND
            draft_id_hash NOT GLOB '*[^0-9a-f]*'
        ),
    cleanup_reason TEXT NOT NULL
        CHECK (cleanup_reason IN (
            'athlete-exclusion',
            'promotion-cancelled',
            'withdrawal'
        )),
    withdrawal_kind TEXT
        CHECK (
            withdrawal_kind IS NULL OR
            withdrawal_kind IN (
                'editorial-removal', 'athlete-exclusion', 'consent-withdrawal'
            )
        ),
    source_promotion_status TEXT NOT NULL
        CHECK (source_promotion_status IN ('active', 'candidate')),
    source_promotion_idempotency_key TEXT NOT NULL
        CHECK (
            length(source_promotion_idempotency_key) BETWEEN 16 AND 128 AND
            source_promotion_idempotency_key NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
    source_promotion_idempotency_key_hash TEXT NOT NULL
        CHECK (
            length(source_promotion_idempotency_key_hash) = 64 AND
            source_promotion_idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
        ),
    source_promotion_payload_fingerprint TEXT NOT NULL
        CHECK (
            length(source_promotion_payload_fingerprint) = 64 AND
            source_promotion_payload_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
    expected_state_version INTEGER NOT NULL CHECK (expected_state_version >= 0),
    object_count INTEGER NOT NULL CHECK (object_count = 2),
    idempotency_key TEXT NOT NULL
        CHECK (
            length(idempotency_key) BETWEEN 16 AND 128 AND
            idempotency_key NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
    cleanup_idempotency_key_hash TEXT NOT NULL
        CHECK (
            length(cleanup_idempotency_key_hash) = 64 AND
            cleanup_idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
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
    status TEXT NOT NULL DEFAULT 'closing'
        CHECK (status IN ('closing', 'deleting', 'cleaned')),
    cleanup_evidence_hash TEXT UNIQUE
        CHECK (
            cleanup_evidence_hash IS NULL OR (
                length(cleanup_evidence_hash) = 64 AND
                cleanup_evidence_hash NOT GLOB '*[^0-9a-f]*'
            )
        ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY (processing_run_id)
        REFERENCES draft_processing_runs(processing_run_id)
        ON DELETE CASCADE,
    FOREIGN KEY (draft_id)
        REFERENCES gallery_drafts(draft_id)
        ON DELETE CASCADE,
    CHECK (created_at <= updated_at),
    CHECK (
        (cleanup_reason = 'promotion-cancelled' AND withdrawal_kind IS NULL) OR
        (cleanup_reason = 'athlete-exclusion' AND withdrawal_kind = 'athlete-exclusion') OR
        (cleanup_reason = 'withdrawal' AND withdrawal_kind IN (
            'editorial-removal', 'consent-withdrawal'
        ))
    ),
    CHECK (
        (
            status IN ('closing', 'deleting') AND
            cleanup_evidence_hash IS NULL AND
            completed_at IS NULL
        ) OR (
            status = 'cleaned' AND
            cleanup_evidence_hash IS NOT NULL AND
            completed_at IS NOT NULL
        )
    )
);

CREATE TABLE draft_photo_promotion_cleanup_objects (
    cleanup_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('photo-display', 'photo-thumbnail')),
    approved_object_key TEXT,
    approved_object_key_hash TEXT NOT NULL
        CHECK (
            length(approved_object_key_hash) = 64 AND
            approved_object_key_hash NOT GLOB '*[^0-9a-f]*'
        ),
    provider_admission_token_hash TEXT
        CHECK (
            provider_admission_token_hash IS NULL OR (
                length(provider_admission_token_hash) = 64 AND
                provider_admission_token_hash NOT GLOB '*[^0-9a-f]*'
            )
        ),
    provider_upload_id TEXT
        CHECK (
            provider_upload_id IS NULL OR
            length(provider_upload_id) BETWEEN 1 AND 512
        ),
    provider_upload_id_hash TEXT
        CHECK (
            provider_upload_id_hash IS NULL OR (
                length(provider_upload_id_hash) = 64 AND
                provider_upload_id_hash NOT GLOB '*[^0-9a-f]*'
            )
        ),
    provider_part_etag TEXT
        CHECK (
            provider_part_etag IS NULL OR
            length(provider_part_etag) BETWEEN 1 AND 256
        ),
    provider_part_etag_hash TEXT
        CHECK (
            provider_part_etag_hash IS NULL OR (
                length(provider_part_etag_hash) = 64 AND
                provider_part_etag_hash NOT GLOB '*[^0-9a-f]*'
            )
        ),
    original_object_status TEXT NOT NULL
        CHECK (original_object_status IN (
            'reserved', 'admitting', 'upload-open', 'part-uploaded', 'verified'
        )),
    expected_sha256 TEXT NOT NULL
        CHECK (
            length(expected_sha256) = 64 AND
            expected_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
    expected_byte_count INTEGER NOT NULL CHECK (expected_byte_count > 0),
    expected_content_type TEXT NOT NULL CHECK (expected_content_type = 'image/webp'),
    expected_width INTEGER NOT NULL CHECK (expected_width > 0),
    expected_height INTEGER NOT NULL CHECK (expected_height > 0),
    expected_object_version TEXT
        CHECK (
            expected_object_version IS NULL OR
            length(expected_object_version) BETWEEN 1 AND 256
        ),
    expected_object_version_hash TEXT
        CHECK (
            expected_object_version_hash IS NULL OR (
                length(expected_object_version_hash) = 64 AND
                expected_object_version_hash NOT GLOB '*[^0-9a-f]*'
            )
        ),
    expected_etag TEXT
        CHECK (
            expected_etag IS NULL OR
            length(expected_etag) BETWEEN 1 AND 256
        ),
    expected_etag_hash TEXT
        CHECK (
            expected_etag_hash IS NULL OR (
                length(expected_etag_hash) = 64 AND
                expected_etag_hash NOT GLOB '*[^0-9a-f]*'
            )
        ),
    provider_terminal_kind TEXT
        CHECK (
            provider_terminal_kind IS NULL OR
            provider_terminal_kind IN (
                'aborted', 'completed', 'not-created', 'not-found'
            )
        ),
    observed_object_version_hash TEXT
        CHECK (
            observed_object_version_hash IS NULL OR (
                length(observed_object_version_hash) = 64 AND
                observed_object_version_hash NOT GLOB '*[^0-9a-f]*'
            )
        ),
    observed_etag_hash TEXT
        CHECK (
            observed_etag_hash IS NULL OR (
                length(observed_etag_hash) = 64 AND
                observed_etag_hash NOT GLOB '*[^0-9a-f]*'
            )
        ),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'terminal', 'delete-ready', 'absent')),
    created_at TEXT NOT NULL,
    terminal_at TEXT,
    delete_authorized_at TEXT,
    deleted_at TEXT,
    absence_verified_at TEXT,
    PRIMARY KEY (cleanup_id, role),
    FOREIGN KEY (cleanup_id)
        REFERENCES draft_photo_promotion_cleanups(cleanup_id)
        ON DELETE CASCADE,
    CHECK (
        provider_upload_id IS NULL OR provider_upload_id_hash IS NOT NULL
    ),
    CHECK (
        (original_object_status = 'reserved' AND
            provider_admission_token_hash IS NULL) OR
        (original_object_status <> 'reserved' AND
            provider_admission_token_hash IS NOT NULL)
    ),
    CHECK (
        provider_part_etag IS NULL OR provider_part_etag_hash IS NOT NULL
    ),
    CHECK (
        (expected_object_version IS NULL AND expected_etag IS NULL) OR
        (
            expected_object_version IS NOT NULL AND
            expected_object_version_hash IS NOT NULL AND
            expected_etag IS NOT NULL AND
            expected_etag_hash IS NOT NULL
        )
    ),
    CHECK (
        (expected_object_version_hash IS NULL AND expected_etag_hash IS NULL) OR
        (expected_object_version_hash IS NOT NULL AND expected_etag_hash IS NOT NULL)
    ),
    CHECK (
        (observed_object_version_hash IS NULL AND observed_etag_hash IS NULL) OR
        (observed_object_version_hash IS NOT NULL AND observed_etag_hash IS NOT NULL)
    ),
    CHECK (terminal_at IS NULL OR created_at < terminal_at),
    CHECK (
        delete_authorized_at IS NULL OR (
            terminal_at IS NOT NULL AND
            terminal_at < delete_authorized_at
        )
    ),
    CHECK (
        absence_verified_at IS NULL OR (
            terminal_at IS NOT NULL AND
            terminal_at < absence_verified_at
        )
    ),
    CHECK (delete_authorized_at IS NULL OR delete_authorized_at <= absence_verified_at),
    CHECK (deleted_at IS NULL OR (
        delete_authorized_at IS NOT NULL AND
        delete_authorized_at <= deleted_at AND
        deleted_at <= absence_verified_at
    )),
    CHECK (
        (
            status = 'pending' AND
            approved_object_key IS NOT NULL AND
            provider_terminal_kind IS NULL AND
            terminal_at IS NULL AND
            observed_object_version_hash IS NULL AND
            observed_etag_hash IS NULL AND
            delete_authorized_at IS NULL AND
            deleted_at IS NULL AND
            absence_verified_at IS NULL
        ) OR (
            status = 'terminal' AND
            approved_object_key IS NOT NULL AND
            provider_terminal_kind IS NOT NULL AND
            terminal_at IS NOT NULL AND
            observed_object_version_hash IS NULL AND
            observed_etag_hash IS NULL AND
            delete_authorized_at IS NULL AND
            deleted_at IS NULL AND
            absence_verified_at IS NULL
        ) OR (
            status = 'delete-ready' AND
            approved_object_key IS NOT NULL AND
            provider_terminal_kind IS NOT NULL AND
            terminal_at IS NOT NULL AND
            observed_object_version_hash IS NOT NULL AND
            observed_etag_hash IS NOT NULL AND
            delete_authorized_at IS NOT NULL AND
            deleted_at IS NULL AND
            absence_verified_at IS NULL
        ) OR (
            status = 'absent' AND
            approved_object_key IS NULL AND
            provider_upload_id IS NULL AND
            provider_part_etag IS NULL AND
            expected_object_version IS NULL AND
            expected_etag IS NULL AND
            provider_terminal_kind IS NOT NULL AND
            terminal_at IS NOT NULL AND
            (
                (
                    observed_object_version_hash IS NULL AND
                    observed_etag_hash IS NULL AND
                    delete_authorized_at IS NULL AND
                    deleted_at IS NULL
                ) OR (
                    observed_object_version_hash IS NOT NULL AND
                    observed_etag_hash IS NOT NULL AND
                    delete_authorized_at IS NOT NULL
                )
            ) AND
            absence_verified_at IS NOT NULL
        )
    )
);

-- This is the minimal evidence that survives an approved draft purge. It has
-- deliberately no draft, run, promotion, or cleanup foreign key.
CREATE TABLE gallery_photo_promotion_cleanup_tombstones (
    cleanup_id_hash TEXT PRIMARY KEY
        CHECK (
            length(cleanup_id_hash) = 64 AND
            cleanup_id_hash NOT GLOB '*[^0-9a-f]*'
        ),
    promotion_id_hash TEXT NOT NULL UNIQUE
        CHECK (
            length(promotion_id_hash) = 64 AND
            promotion_id_hash NOT GLOB '*[^0-9a-f]*'
        ),
    processing_run_id_hash TEXT NOT NULL
        CHECK (
            length(processing_run_id_hash) = 64 AND
            processing_run_id_hash NOT GLOB '*[^0-9a-f]*'
        ),
    draft_id_hash TEXT NOT NULL
        CHECK (
            length(draft_id_hash) = 64 AND
            draft_id_hash NOT GLOB '*[^0-9a-f]*'
        ),
    source_promotion_idempotency_key_hash TEXT NOT NULL
        CHECK (
            length(source_promotion_idempotency_key_hash) = 64 AND
            source_promotion_idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
        ),
    source_promotion_payload_fingerprint TEXT NOT NULL
        CHECK (
            length(source_promotion_payload_fingerprint) = 64 AND
            source_promotion_payload_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
    cleanup_idempotency_key_hash TEXT NOT NULL
        CHECK (
            length(cleanup_idempotency_key_hash) = 64 AND
            cleanup_idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
        ),
    cleanup_payload_fingerprint TEXT NOT NULL
        CHECK (
            length(cleanup_payload_fingerprint) = 64 AND
            cleanup_payload_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
    cleanup_reason TEXT NOT NULL
        CHECK (cleanup_reason IN (
            'athlete-exclusion', 'promotion-cancelled', 'withdrawal'
        )),
    withdrawal_kind TEXT
        CHECK (
            withdrawal_kind IS NULL OR
            withdrawal_kind IN (
                'editorial-removal', 'athlete-exclusion', 'consent-withdrawal'
            )
        ),
    evidence_hash TEXT NOT NULL UNIQUE
        CHECK (
            length(evidence_hash) = 64 AND
            evidence_hash NOT GLOB '*[^0-9a-f]*'
        ),
    completed_at TEXT NOT NULL,
    UNIQUE (draft_id_hash, source_promotion_idempotency_key_hash),
    CHECK (
        (cleanup_reason = 'promotion-cancelled' AND withdrawal_kind IS NULL) OR
        (cleanup_reason = 'athlete-exclusion' AND withdrawal_kind = 'athlete-exclusion') OR
        (cleanup_reason = 'withdrawal' AND withdrawal_kind IN (
            'editorial-removal', 'consent-withdrawal'
        ))
    )
);

CREATE INDEX draft_photo_promotion_cleanups_status_index
    ON draft_photo_promotion_cleanups(status, updated_at);
CREATE INDEX draft_photo_promotion_cleanups_run_index
    ON draft_photo_promotion_cleanups(processing_run_id, completed_at);

-- Withdrawal intent is a one-way safety classification. An athlete or
-- editorial request may become the stronger consent withdrawal, but consent
-- withdrawal can never be cleared or downgraded by a competing exclusion.
CREATE TRIGGER draft_publication_references_withdrawal_intent_guard
BEFORE UPDATE OF withdrawal_kind ON draft_publication_references
WHEN NOT (
    NEW.withdrawal_kind IS OLD.withdrawal_kind OR
    (
        OLD.withdrawal_kind IS NULL AND
        NEW.withdrawal_kind IN (
            'editorial-removal', 'athlete-exclusion', 'consent-withdrawal'
        )
    ) OR (
        OLD.withdrawal_kind IN ('editorial-removal', 'athlete-exclusion') AND
        NEW.withdrawal_kind = 'consent-withdrawal'
    )
)
BEGIN
    SELECT RAISE(ABORT, 'withdrawal intent cannot be cleared or downgraded');
END;

CREATE TRIGGER draft_photo_promotion_cleanups_no_replace_guard
BEFORE INSERT ON draft_photo_promotion_cleanups
WHEN EXISTS (
    SELECT 1 FROM draft_photo_promotion_cleanups AS existing
    WHERE existing.cleanup_id = NEW.cleanup_id
       OR existing.cleanup_id_hash = NEW.cleanup_id_hash
       OR existing.promotion_id = NEW.promotion_id
       OR existing.promotion_id_hash = NEW.promotion_id_hash
)
BEGIN
    SELECT RAISE(ABORT, 'photo promotion cleanup replacement is forbidden');
END;

-- The caller cannot select a reason. D1 derives exclusion and withdrawal from
-- current evidence. A transient provider failure is never caller-labelled as
-- durable evidence: an otherwise current active promotion derives the
-- reversible promotion-cancelled reason and leaves private staging untouched.
CREATE TRIGGER draft_photo_promotion_cleanups_insert_guard
BEFORE INSERT ON draft_photo_promotion_cleanups
WHEN NOT EXISTS (
    SELECT 1
    FROM draft_photo_promotions AS promotion
    JOIN gallery_drafts AS draft ON draft.draft_id = promotion.draft_id
    JOIN draft_consent_attestations AS consent
      ON consent.draft_id = draft.draft_id
     AND consent.consent_revision = promotion.consent_revision
    LEFT JOIN draft_publication_references AS publication
      ON publication.draft_id = draft.draft_id
    WHERE promotion.promotion_id = NEW.promotion_id
      AND promotion.processing_run_id = NEW.processing_run_id
      AND promotion.draft_id = NEW.draft_id
      AND draft.state_version = NEW.expected_state_version
      AND promotion.status IN ('active', 'candidate')
      AND NEW.source_promotion_status = promotion.status
      AND NEW.source_promotion_idempotency_key = promotion.idempotency_key
      AND NEW.source_promotion_idempotency_key_hash = promotion.idempotency_key_hash
      AND NEW.source_promotion_payload_fingerprint = promotion.payload_fingerprint
      AND NEW.status = 'closing'
      AND NEW.object_count = 2
      AND NEW.object_count = (
          SELECT COUNT(*) FROM draft_photo_promotion_objects AS object
          WHERE object.promotion_id = promotion.promotion_id
      )
      AND (
          (
              NEW.cleanup_reason = 'athlete-exclusion' AND
              NEW.withdrawal_kind = 'athlete-exclusion' AND
              consent.withdrawn_at IS NULL AND
              publication.withdrawal_kind IS NOT 'consent-withdrawal' AND
              draft.state IN (
                  'processing', 'candidate-public', 'private-review',
                  'withdrawal-pending'
              ) AND
              EXISTS (
                  SELECT 1
                  FROM json_each(draft.athlete_ids_json) AS tag
                  JOIN pending_athlete_exclusions AS exclusion
                    ON exclusion.athlete_id = tag.value
                  WHERE exclusion.resolved_at IS NULL
              )
          ) OR (
              NEW.cleanup_reason = 'withdrawal' AND
              (
                  (
                      (
                          consent.withdrawn_at IS NOT NULL OR
                          publication.withdrawal_kind = 'consent-withdrawal'
                      ) AND
                      draft.state = 'withdrawal-pending' AND
                      NEW.withdrawal_kind = 'consent-withdrawal'
                  ) OR (
                      consent.withdrawn_at IS NULL AND
                      draft.state = 'withdrawal-pending' AND
                      NEW.withdrawal_kind = 'editorial-removal' AND
                      publication.withdrawal_kind IS NOT 'consent-withdrawal' AND
                      publication.withdrawal_kind IS NOT 'athlete-exclusion' AND
                      NOT EXISTS (
                          SELECT 1
                          FROM json_each(draft.athlete_ids_json) AS tag
                          JOIN pending_athlete_exclusions AS exclusion
                            ON exclusion.athlete_id = tag.value
                          WHERE exclusion.resolved_at IS NULL
                      )
                  )
              )
          ) OR (
              NEW.cleanup_reason = 'promotion-cancelled' AND
              NEW.withdrawal_kind IS NULL AND
              promotion.status = 'active' AND
              draft.state = 'processing' AND
              consent.withdrawn_at IS NULL AND
              publication.withdrawal_kind IS NULL AND
              NOT EXISTS (
                  SELECT 1
                  FROM json_each(draft.athlete_ids_json) AS tag
                  JOIN pending_athlete_exclusions AS exclusion
                    ON exclusion.athlete_id = tag.value
                  WHERE exclusion.resolved_at IS NULL
              )
          )
      )
)
BEGIN
    SELECT RAISE(ABORT, 'photo promotion cleanup lacks a current derived reason');
END;

CREATE TRIGGER draft_photo_promotion_cleanups_identity_update_guard
BEFORE UPDATE OF
    cleanup_id,
    cleanup_id_hash,
    promotion_id,
    promotion_id_hash,
    processing_run_id,
    processing_run_id_hash,
    draft_id,
    draft_id_hash,
    cleanup_reason,
    withdrawal_kind,
    source_promotion_status,
    source_promotion_idempotency_key,
    source_promotion_idempotency_key_hash,
    source_promotion_payload_fingerprint,
    expected_state_version,
    object_count,
    idempotency_key,
    cleanup_idempotency_key_hash,
    payload_fingerprint,
    service_actor_identity_hash,
    created_at
ON draft_photo_promotion_cleanups
WHEN
    NEW.cleanup_id IS NOT OLD.cleanup_id OR
    NEW.cleanup_id_hash IS NOT OLD.cleanup_id_hash OR
    NEW.promotion_id IS NOT OLD.promotion_id OR
    NEW.promotion_id_hash IS NOT OLD.promotion_id_hash OR
    NEW.processing_run_id IS NOT OLD.processing_run_id OR
    NEW.processing_run_id_hash IS NOT OLD.processing_run_id_hash OR
    NEW.draft_id IS NOT OLD.draft_id OR
    NEW.draft_id_hash IS NOT OLD.draft_id_hash OR
    NEW.cleanup_reason IS NOT OLD.cleanup_reason OR
    NEW.withdrawal_kind IS NOT OLD.withdrawal_kind OR
    NEW.source_promotion_status IS NOT OLD.source_promotion_status OR
    NEW.source_promotion_idempotency_key IS NOT OLD.source_promotion_idempotency_key OR
    NEW.source_promotion_idempotency_key_hash IS NOT OLD.source_promotion_idempotency_key_hash OR
    NEW.source_promotion_payload_fingerprint IS NOT OLD.source_promotion_payload_fingerprint OR
    NEW.expected_state_version IS NOT OLD.expected_state_version OR
    NEW.object_count IS NOT OLD.object_count OR
    NEW.idempotency_key IS NOT OLD.idempotency_key OR
    NEW.cleanup_idempotency_key_hash IS NOT OLD.cleanup_idempotency_key_hash OR
    NEW.payload_fingerprint IS NOT OLD.payload_fingerprint OR
    NEW.service_actor_identity_hash IS NOT OLD.service_actor_identity_hash OR
    NEW.created_at IS NOT OLD.created_at
BEGIN
    SELECT RAISE(ABORT, 'photo promotion cleanup identity is immutable');
END;

CREATE TRIGGER draft_photo_promotion_cleanups_evidence_collision_guard
BEFORE UPDATE OF cleanup_evidence_hash ON draft_photo_promotion_cleanups
WHEN NEW.cleanup_evidence_hash IS NOT OLD.cleanup_evidence_hash AND EXISTS (
    SELECT 1 FROM draft_photo_promotion_cleanups AS existing
    WHERE existing.cleanup_id <> OLD.cleanup_id
      AND existing.cleanup_evidence_hash = NEW.cleanup_evidence_hash
)
BEGIN
    SELECT RAISE(ABORT, 'photo promotion cleanup evidence replacement is forbidden');
END;

CREATE TRIGGER draft_photo_promotion_cleanups_status_guard
BEFORE UPDATE OF status, cleanup_evidence_hash, updated_at, completed_at
ON draft_photo_promotion_cleanups
WHEN NOT (
    (
        OLD.status = 'closing' AND
        NEW.status = 'deleting' AND
        NEW.cleanup_evidence_hash IS NULL AND
        NEW.completed_at IS NULL AND
        NEW.updated_at > OLD.updated_at AND
        (SELECT COUNT(*)
            FROM draft_photo_promotion_cleanup_objects AS object
            WHERE object.cleanup_id = OLD.cleanup_id
              AND object.status = 'terminal') = OLD.object_count AND
        NOT EXISTS (
            SELECT 1
            FROM draft_photo_promotion_objects AS source
            WHERE source.promotion_id = OLD.promotion_id
              AND NOT EXISTS (
                  SELECT 1
                  FROM draft_photo_promotion_cleanup_objects AS object
                  WHERE object.cleanup_id = OLD.cleanup_id
                    AND object.role = source.role
                    AND object.status = 'terminal'
                    AND object.approved_object_key = source.approved_object_key
                    AND object.approved_object_key_hash IS NOT NULL
                    AND object.original_object_status = source.status
                    AND object.provider_admission_token_hash IS
                        source.provider_admission_token_hash
                    AND object.expected_sha256 = source.sha256
                    AND object.expected_byte_count = source.byte_count
                    AND object.expected_content_type = source.content_type
                    AND object.expected_width = source.width
                    AND object.expected_height = source.height
                    AND object.provider_upload_id IS source.provider_upload_id
                    AND object.provider_upload_id_hash IS source.provider_upload_id_hash
                    AND object.provider_part_etag IS source.provider_part_etag
                    AND object.expected_object_version IS source.approved_object_version
                    AND object.expected_etag IS source.approved_etag
              )
        )
    ) OR (
        OLD.status = 'deleting' AND
        NEW.status = 'cleaned' AND
        NEW.cleanup_evidence_hash IS NOT NULL AND
        NEW.completed_at = NEW.updated_at AND
        NEW.updated_at > OLD.updated_at AND
        NOT EXISTS (
            SELECT 1 FROM draft_photo_promotions AS promotion
            WHERE promotion.promotion_id = OLD.promotion_id
        ) AND
        (SELECT COUNT(*)
            FROM draft_photo_promotion_cleanup_objects AS object
            WHERE object.cleanup_id = OLD.cleanup_id
              AND object.status = 'absent') = OLD.object_count AND
        NOT EXISTS (
            SELECT 1
            FROM draft_derivatives AS derivative
            JOIN draft_photo_promotion_cleanup_objects AS object
              ON object.cleanup_id = OLD.cleanup_id
             AND object.role = derivative.role
            WHERE derivative.draft_id = OLD.draft_id
              AND derivative.approved_object_key IS NOT NULL
        ) AND
        NOT EXISTS (
            SELECT 1
            FROM draft_photo_promotion_cleanup_objects AS object
            WHERE object.cleanup_id = OLD.cleanup_id
              AND (
                  object.absence_verified_at IS NULL OR
                  NEW.completed_at <= object.absence_verified_at
              )
        )
    )
)
BEGIN
    SELECT RAISE(ABORT, 'invalid photo promotion cleanup transition');
END;

CREATE TRIGGER draft_photo_promotion_cleanups_terminal_update_guard
BEFORE UPDATE ON draft_photo_promotion_cleanups
WHEN OLD.status = 'cleaned'
BEGIN
    SELECT RAISE(ABORT, 'completed photo promotion cleanup evidence is immutable');
END;

CREATE TRIGGER draft_photo_promotion_cleanup_objects_no_replace_guard
BEFORE INSERT ON draft_photo_promotion_cleanup_objects
WHEN EXISTS (
    SELECT 1 FROM draft_photo_promotion_cleanup_objects AS existing
    WHERE existing.cleanup_id = NEW.cleanup_id AND existing.role = NEW.role
)
BEGIN
    SELECT RAISE(ABORT, 'photo promotion cleanup object replacement is forbidden');
END;

CREATE TRIGGER draft_photo_promotion_cleanup_objects_insert_guard
BEFORE INSERT ON draft_photo_promotion_cleanup_objects
WHEN NOT EXISTS (
    SELECT 1
    FROM draft_photo_promotion_cleanups AS cleanup
    JOIN draft_photo_promotion_objects AS source
      ON source.promotion_id = cleanup.promotion_id
     AND source.role = NEW.role
    WHERE cleanup.cleanup_id = NEW.cleanup_id
      AND cleanup.status = 'closing'
      AND NEW.status = 'pending'
      AND NEW.approved_object_key = source.approved_object_key
      AND NEW.provider_admission_token_hash IS source.provider_admission_token_hash
      AND NEW.provider_upload_id IS source.provider_upload_id
      AND NEW.provider_upload_id_hash IS source.provider_upload_id_hash
      AND NEW.provider_part_etag IS source.provider_part_etag
      AND NEW.original_object_status = source.status
      AND NEW.expected_sha256 = source.sha256
      AND NEW.expected_byte_count = source.byte_count
      AND NEW.expected_content_type = source.content_type
      AND NEW.expected_width = source.width
      AND NEW.expected_height = source.height
      AND NEW.expected_object_version IS source.approved_object_version
      AND NEW.expected_etag IS source.approved_etag
      AND (
          (source.status = 'verified' AND
           NEW.expected_object_version_hash IS NOT NULL AND
           NEW.expected_etag_hash IS NOT NULL) OR
          (source.status <> 'verified' AND
           NEW.expected_object_version_hash IS NULL AND
           NEW.expected_etag_hash IS NULL)
      )
)
BEGIN
    SELECT RAISE(ABORT, 'photo promotion cleanup object lacks exact source evidence');
END;

CREATE TRIGGER draft_photo_promotion_cleanup_objects_identity_update_guard
BEFORE UPDATE OF
    cleanup_id,
    role,
    approved_object_key_hash,
    provider_admission_token_hash,
    provider_upload_id_hash,
    provider_part_etag_hash,
    original_object_status,
    expected_sha256,
    expected_byte_count,
    expected_content_type,
    expected_width,
    expected_height,
    expected_object_version_hash,
    expected_etag_hash,
    created_at
ON draft_photo_promotion_cleanup_objects
WHEN (
    NEW.cleanup_id IS NOT OLD.cleanup_id OR
    NEW.role IS NOT OLD.role OR
    NEW.approved_object_key_hash IS NOT OLD.approved_object_key_hash OR
    NEW.provider_admission_token_hash IS NOT OLD.provider_admission_token_hash OR
    NEW.provider_upload_id_hash IS NOT OLD.provider_upload_id_hash OR
    NEW.provider_part_etag_hash IS NOT OLD.provider_part_etag_hash OR
    NEW.original_object_status IS NOT OLD.original_object_status OR
    NEW.expected_sha256 IS NOT OLD.expected_sha256 OR
    NEW.expected_byte_count IS NOT OLD.expected_byte_count OR
    NEW.expected_content_type IS NOT OLD.expected_content_type OR
    NEW.expected_width IS NOT OLD.expected_width OR
    NEW.expected_height IS NOT OLD.expected_height OR
    NEW.expected_object_version_hash IS NOT OLD.expected_object_version_hash OR
    NEW.expected_etag_hash IS NOT OLD.expected_etag_hash OR
    NEW.created_at IS NOT OLD.created_at
) AND NOT (
    OLD.status = 'pending' AND NEW.status = 'pending' AND
    OLD.original_object_status = 'admitting' AND
    NEW.original_object_status = 'upload-open' AND
    NEW.cleanup_id IS OLD.cleanup_id AND
    NEW.role IS OLD.role AND
    NEW.approved_object_key_hash IS OLD.approved_object_key_hash AND
    NEW.provider_admission_token_hash IS OLD.provider_admission_token_hash AND
    NEW.provider_admission_token_hash IS NOT NULL AND
    OLD.provider_upload_id IS NULL AND NEW.provider_upload_id IS NOT NULL AND
    OLD.provider_upload_id_hash IS NULL AND NEW.provider_upload_id_hash IS NOT NULL AND
    NEW.provider_part_etag_hash IS OLD.provider_part_etag_hash AND
    NEW.expected_sha256 IS OLD.expected_sha256 AND
    NEW.expected_byte_count IS OLD.expected_byte_count AND
    NEW.expected_content_type IS OLD.expected_content_type AND
    NEW.expected_width IS OLD.expected_width AND
    NEW.expected_height IS OLD.expected_height AND
    NEW.expected_object_version_hash IS OLD.expected_object_version_hash AND
    NEW.expected_etag_hash IS OLD.expected_etag_hash AND
    NEW.created_at IS OLD.created_at AND
    EXISTS (
        SELECT 1
        FROM draft_photo_promotion_cleanups AS cleanup
        JOIN draft_photo_promotion_objects AS source
          ON source.promotion_id = cleanup.promotion_id
         AND source.role = OLD.role
        WHERE cleanup.cleanup_id = OLD.cleanup_id
          AND cleanup.status = 'closing'
          AND source.status = 'upload-open'
          AND source.provider_admission_token_hash =
              NEW.provider_admission_token_hash
          AND source.provider_upload_id = NEW.provider_upload_id
          AND source.provider_upload_id_hash = NEW.provider_upload_id_hash
    )
)
BEGIN
    SELECT RAISE(ABORT, 'photo promotion cleanup object identity is immutable');
END;

CREATE TRIGGER draft_photo_promotion_cleanup_objects_status_guard
BEFORE UPDATE OF
    approved_object_key,
    provider_upload_id,
    provider_part_etag,
    expected_object_version,
    expected_etag,
    provider_terminal_kind,
    observed_object_version_hash,
    observed_etag_hash,
    status,
    terminal_at,
    delete_authorized_at,
    deleted_at,
    absence_verified_at
ON draft_photo_promotion_cleanup_objects
WHEN NOT (
    (
        OLD.status = 'pending' AND NEW.status = 'pending' AND
        OLD.original_object_status = 'admitting' AND
        NEW.original_object_status = 'upload-open' AND
        NEW.approved_object_key IS OLD.approved_object_key AND
        OLD.provider_upload_id IS NULL AND NEW.provider_upload_id IS NOT NULL AND
        NEW.provider_part_etag IS OLD.provider_part_etag AND
        NEW.expected_object_version IS OLD.expected_object_version AND
        NEW.expected_etag IS OLD.expected_etag AND
        NEW.provider_terminal_kind IS OLD.provider_terminal_kind AND
        NEW.terminal_at IS OLD.terminal_at AND
        NEW.observed_object_version_hash IS OLD.observed_object_version_hash AND
        NEW.observed_etag_hash IS OLD.observed_etag_hash AND
        NEW.delete_authorized_at IS OLD.delete_authorized_at AND
        NEW.deleted_at IS OLD.deleted_at AND
        NEW.absence_verified_at IS OLD.absence_verified_at AND
        EXISTS (
            SELECT 1
            FROM draft_photo_promotion_cleanups AS cleanup
            JOIN draft_photo_promotion_objects AS source
              ON source.promotion_id = cleanup.promotion_id
             AND source.role = OLD.role
            WHERE cleanup.cleanup_id = OLD.cleanup_id
              AND cleanup.status = 'closing'
              AND source.status = 'upload-open'
              AND source.provider_admission_token_hash =
                  NEW.provider_admission_token_hash
              AND source.provider_upload_id = NEW.provider_upload_id
              AND source.provider_upload_id_hash = NEW.provider_upload_id_hash
        )
    ) OR (
        OLD.status = 'pending' AND
        NEW.status = 'terminal' AND
        NEW.approved_object_key IS OLD.approved_object_key AND
        NEW.provider_upload_id IS OLD.provider_upload_id AND
        NEW.provider_part_etag IS OLD.provider_part_etag AND
        NEW.expected_object_version IS OLD.expected_object_version AND
        NEW.expected_etag IS OLD.expected_etag AND
        NEW.provider_terminal_kind IS NOT NULL AND
        NEW.terminal_at IS NOT NULL AND
        NEW.observed_object_version_hash IS NULL AND
        NEW.observed_etag_hash IS NULL AND
        NEW.delete_authorized_at IS NULL AND
        NEW.deleted_at IS NULL AND
        NEW.absence_verified_at IS NULL AND
        EXISTS (
            SELECT 1 FROM draft_photo_promotion_cleanups AS cleanup
            WHERE cleanup.cleanup_id = OLD.cleanup_id
              AND cleanup.status = 'closing'
        ) AND
        (
            (
                OLD.original_object_status = 'reserved' AND
                OLD.provider_upload_id IS NULL AND
                NEW.provider_terminal_kind = 'not-created'
            ) OR (
                OLD.original_object_status = 'upload-open' AND
                OLD.provider_upload_id IS NOT NULL AND
                NEW.provider_terminal_kind IN ('aborted', 'not-found')
            ) OR (
                OLD.original_object_status IN ('part-uploaded', 'verified') AND
                OLD.provider_upload_id IS NOT NULL AND
                NEW.provider_terminal_kind IN (
                    'aborted', 'completed', 'not-found'
                )
            )
        )
    ) OR (
        OLD.status = 'terminal' AND
        NEW.status = 'delete-ready' AND
        NEW.approved_object_key IS OLD.approved_object_key AND
        NEW.provider_upload_id IS OLD.provider_upload_id AND
        NEW.provider_part_etag IS OLD.provider_part_etag AND
        NEW.expected_object_version IS OLD.expected_object_version AND
        NEW.expected_etag IS OLD.expected_etag AND
        NEW.provider_terminal_kind IS OLD.provider_terminal_kind AND
        NEW.terminal_at IS OLD.terminal_at AND
        NEW.observed_object_version_hash IS NOT NULL AND
        NEW.observed_etag_hash IS NOT NULL AND
        NEW.delete_authorized_at IS NOT NULL AND
        NEW.deleted_at IS NULL AND
        NEW.absence_verified_at IS NULL AND
        EXISTS (
            SELECT 1 FROM draft_photo_promotion_cleanups AS cleanup
            WHERE cleanup.cleanup_id = OLD.cleanup_id
              AND cleanup.status = 'deleting'
        )
    ) OR (
        OLD.status = 'terminal' AND
        NEW.status = 'absent' AND
        NEW.approved_object_key IS NULL AND
        NEW.provider_upload_id IS NULL AND
        NEW.provider_part_etag IS NULL AND
        NEW.expected_object_version IS NULL AND
        NEW.expected_etag IS NULL AND
        NEW.provider_terminal_kind IS OLD.provider_terminal_kind AND
        NEW.terminal_at IS OLD.terminal_at AND
        NEW.observed_object_version_hash IS NULL AND
        NEW.observed_etag_hash IS NULL AND
        NEW.delete_authorized_at IS NULL AND
        NEW.deleted_at IS NULL AND
        NEW.absence_verified_at IS NOT NULL AND
        EXISTS (
            SELECT 1 FROM draft_photo_promotion_cleanups AS cleanup
            WHERE cleanup.cleanup_id = OLD.cleanup_id
              AND cleanup.status = 'deleting'
        )
    ) OR (
        OLD.status = 'delete-ready' AND
        NEW.status = 'absent' AND
        NEW.approved_object_key IS NULL AND
        NEW.provider_upload_id IS NULL AND
        NEW.provider_part_etag IS NULL AND
        NEW.expected_object_version IS NULL AND
        NEW.expected_etag IS NULL AND
        NEW.provider_terminal_kind IS OLD.provider_terminal_kind AND
        NEW.terminal_at IS OLD.terminal_at AND
        NEW.observed_object_version_hash IS OLD.observed_object_version_hash AND
        NEW.observed_etag_hash IS OLD.observed_etag_hash AND
        NEW.delete_authorized_at IS OLD.delete_authorized_at AND
        (NEW.deleted_at IS NULL OR NEW.deleted_at >= OLD.delete_authorized_at) AND
        NEW.absence_verified_at IS NOT NULL AND
        EXISTS (
            SELECT 1 FROM draft_photo_promotion_cleanups AS cleanup
            WHERE cleanup.cleanup_id = OLD.cleanup_id
              AND cleanup.status = 'deleting'
        )
    )
)
BEGIN
    SELECT RAISE(ABORT, 'photo promotion cleanup object transition is incomplete');
END;

CREATE TRIGGER draft_photo_promotion_cleanup_objects_terminal_update_guard
BEFORE UPDATE ON draft_photo_promotion_cleanup_objects
WHEN OLD.status = 'absent'
BEGIN
    SELECT RAISE(ABORT, 'verified approved-object absence is immutable');
END;

CREATE TRIGGER gallery_photo_promotion_cleanup_tombstones_insert_guard
BEFORE INSERT ON gallery_photo_promotion_cleanup_tombstones
WHEN NOT EXISTS (
    SELECT 1 FROM draft_photo_promotion_cleanups AS cleanup
    WHERE cleanup.status = 'cleaned'
      AND cleanup.cleanup_id_hash = NEW.cleanup_id_hash
      AND cleanup.promotion_id_hash = NEW.promotion_id_hash
      AND cleanup.processing_run_id_hash = NEW.processing_run_id_hash
      AND cleanup.draft_id_hash = NEW.draft_id_hash
      AND cleanup.source_promotion_idempotency_key_hash =
          NEW.source_promotion_idempotency_key_hash
      AND cleanup.source_promotion_payload_fingerprint =
          NEW.source_promotion_payload_fingerprint
      AND cleanup.cleanup_idempotency_key_hash =
          NEW.cleanup_idempotency_key_hash
      AND cleanup.payload_fingerprint = NEW.cleanup_payload_fingerprint
      AND cleanup.cleanup_reason = NEW.cleanup_reason
      AND cleanup.withdrawal_kind IS NEW.withdrawal_kind
      AND cleanup.cleanup_evidence_hash = NEW.evidence_hash
      AND cleanup.completed_at = NEW.completed_at
)
BEGIN
    SELECT RAISE(ABORT, 'photo promotion cleanup tombstone lacks completed evidence');
END;

-- Cover every UNIQUE identity explicitly: replacement deletion can otherwise
-- evade ordinary delete-trigger expectations when recursive triggers are off.
CREATE TRIGGER gallery_photo_promotion_cleanup_tombstones_no_replace_guard
BEFORE INSERT ON gallery_photo_promotion_cleanup_tombstones
WHEN EXISTS (
    SELECT 1 FROM gallery_photo_promotion_cleanup_tombstones AS existing
    WHERE existing.cleanup_id_hash = NEW.cleanup_id_hash
       OR existing.promotion_id_hash = NEW.promotion_id_hash
       OR existing.evidence_hash = NEW.evidence_hash
       OR (
           existing.draft_id_hash = NEW.draft_id_hash AND
           existing.source_promotion_idempotency_key_hash =
               NEW.source_promotion_idempotency_key_hash
       )
)
BEGIN
    SELECT RAISE(ABORT, 'photo promotion cleanup tombstone replacement is forbidden');
END;

CREATE TRIGGER gallery_photo_promotion_cleanup_tombstones_no_update
BEFORE UPDATE ON gallery_photo_promotion_cleanup_tombstones
BEGIN
    SELECT RAISE(ABORT, 'photo promotion cleanup tombstones are append-only');
END;

CREATE TRIGGER gallery_photo_promotion_cleanup_tombstones_no_delete
BEFORE DELETE ON gallery_photo_promotion_cleanup_tombstones
BEGIN
    SELECT RAISE(ABORT, 'photo promotion cleanup tombstones are append-only');
END;

-- Once the cleanup row exists, no promotion/object transition may admit new
-- approved bytes or candidate evidence.
CREATE TRIGGER draft_photo_promotions_cleanup_update_guard
BEFORE UPDATE ON draft_photo_promotions
WHEN EXISTS (
    SELECT 1 FROM draft_photo_promotion_cleanups AS cleanup
    WHERE cleanup.promotion_id = OLD.promotion_id
)
BEGIN
    SELECT RAISE(ABORT, 'photo promotion cleanup has closed promotion mutation');
END;

CREATE TRIGGER draft_photo_promotions_cleaned_replay_guard
BEFORE INSERT ON draft_photo_promotions
WHEN EXISTS (
    SELECT 1
    FROM draft_photo_promotion_cleanups AS cleanup
    WHERE cleanup.draft_id = NEW.draft_id
      AND cleanup.source_promotion_idempotency_key = NEW.idempotency_key
)
BEGIN
    SELECT RAISE(ABORT, 'cleaned photo promotion idempotency cannot be reused');
END;

CREATE TRIGGER draft_photo_promotion_objects_cleanup_insert_guard
BEFORE INSERT ON draft_photo_promotion_objects
WHEN EXISTS (
    SELECT 1 FROM draft_photo_promotion_cleanups AS cleanup
    WHERE cleanup.promotion_id = NEW.promotion_id
)
BEGIN
    SELECT RAISE(ABORT, 'photo promotion cleanup has closed object admission');
END;

CREATE TRIGGER draft_photo_promotion_objects_cleanup_update_guard
BEFORE UPDATE ON draft_photo_promotion_objects
WHEN EXISTS (
    SELECT 1 FROM draft_photo_promotion_cleanups AS cleanup
    WHERE cleanup.promotion_id = OLD.promotion_id
) AND NOT (
    OLD.status = 'admitting' AND NEW.status = 'upload-open' AND
    OLD.provider_admission_token_hash IS NOT NULL AND
    NEW.provider_admission_token_hash IS OLD.provider_admission_token_hash AND
    OLD.provider_upload_id IS NULL AND NEW.provider_upload_id IS NOT NULL AND
    OLD.provider_upload_id_hash IS NULL AND NEW.provider_upload_id_hash IS NOT NULL AND
    NEW.provider_part_etag IS OLD.provider_part_etag AND
    NEW.approved_object_version IS OLD.approved_object_version AND
    NEW.approved_etag IS OLD.approved_etag AND
    NEW.verified_at IS OLD.verified_at AND
    EXISTS (
        SELECT 1
        FROM draft_photo_promotion_cleanups AS cleanup
        JOIN draft_photo_promotion_cleanup_objects AS object
          ON object.cleanup_id = cleanup.cleanup_id
         AND object.role = OLD.role
        WHERE cleanup.promotion_id = OLD.promotion_id
          AND cleanup.status = 'closing'
          AND object.status = 'pending'
          AND object.original_object_status = 'admitting'
          AND object.provider_admission_token_hash =
              OLD.provider_admission_token_hash
          AND object.provider_upload_id IS NULL
    )
)
BEGIN
    SELECT RAISE(ABORT, 'photo promotion cleanup has closed object mutation');
END;

-- Allow the final cleanup transaction to clear only the exact approved
-- references whose host objects have already been proved absent. Preserve the
-- original NULL -> approved promotion assignment unchanged.
DROP TRIGGER draft_derivatives_processing_immutable_update_guard;

CREATE TRIGGER draft_derivatives_processing_immutable_update_guard
BEFORE UPDATE ON draft_derivatives
WHEN EXISTS (
    SELECT 1
    FROM draft_processing_runs AS run
    JOIN draft_processing_outputs AS output
      ON output.processing_run_id = run.processing_run_id
     AND output.role = OLD.role
    WHERE run.draft_id = OLD.draft_id
      AND output.staging_object_key = OLD.staging_object_key
) AND NOT (
    (
        OLD.approved_object_key IS NULL AND
        NEW.approved_object_key IS NOT NULL AND
        NEW.draft_id IS OLD.draft_id AND
        NEW.item_revision IS OLD.item_revision AND
        NEW.consent_revision IS OLD.consent_revision AND
        NEW.export_bundle_id IS OLD.export_bundle_id AND
        NEW.source_revision IS OLD.source_revision AND
        NEW.suppression_revision IS OLD.suppression_revision AND
        NEW.role IS OLD.role AND
        NEW.staging_object_key IS OLD.staging_object_key AND
        NEW.byte_count IS OLD.byte_count AND
        NEW.sha256 IS OLD.sha256 AND
        NEW.content_type IS OLD.content_type AND
        NEW.width IS OLD.width AND
        NEW.height IS OLD.height AND
        NEW.duration_milliseconds IS OLD.duration_milliseconds AND
        NEW.metadata_scan_json IS OLD.metadata_scan_json AND
        NEW.scanner_version IS OLD.scanner_version AND
        NEW.verified_at IS OLD.verified_at AND
        NEW.host_deleted_at IS OLD.host_deleted_at AND
        EXISTS (
            SELECT 1
            FROM draft_photo_promotions AS promotion
            JOIN draft_photo_promotion_objects AS object
              ON object.promotion_id = promotion.promotion_id
             AND object.role = OLD.role
            WHERE promotion.draft_id = OLD.draft_id
              AND promotion.status = 'active'
              AND object.status = 'verified'
              AND object.staging_object_key = OLD.staging_object_key
              AND object.approved_object_key = NEW.approved_object_key
              AND object.sha256 = OLD.sha256
              AND object.byte_count = OLD.byte_count
              AND NOT EXISTS (
                  SELECT 1 FROM draft_photo_promotion_cleanups AS cleanup
                  WHERE cleanup.promotion_id = promotion.promotion_id
              )
        )
    ) OR (
        OLD.approved_object_key IS NOT NULL AND
        NEW.approved_object_key IS NULL AND
        NEW.draft_id IS OLD.draft_id AND
        NEW.item_revision IS OLD.item_revision AND
        NEW.consent_revision IS OLD.consent_revision AND
        NEW.export_bundle_id IS OLD.export_bundle_id AND
        NEW.source_revision IS OLD.source_revision AND
        NEW.suppression_revision IS OLD.suppression_revision AND
        NEW.role IS OLD.role AND
        NEW.staging_object_key IS OLD.staging_object_key AND
        NEW.byte_count IS OLD.byte_count AND
        NEW.sha256 IS OLD.sha256 AND
        NEW.content_type IS OLD.content_type AND
        NEW.width IS OLD.width AND
        NEW.height IS OLD.height AND
        NEW.duration_milliseconds IS OLD.duration_milliseconds AND
        NEW.metadata_scan_json IS OLD.metadata_scan_json AND
        NEW.scanner_version IS OLD.scanner_version AND
        NEW.verified_at IS OLD.verified_at AND
        NEW.host_deleted_at IS OLD.host_deleted_at AND
        EXISTS (
            SELECT 1
            FROM draft_photo_promotions AS promotion
            JOIN draft_photo_promotion_objects AS source
              ON source.promotion_id = promotion.promotion_id
             AND source.role = OLD.role
            JOIN draft_photo_promotion_cleanups AS cleanup
              ON cleanup.promotion_id = promotion.promotion_id
             AND cleanup.status = 'deleting'
            JOIN draft_photo_promotion_cleanup_objects AS object
              ON object.cleanup_id = cleanup.cleanup_id
             AND object.role = source.role
            WHERE promotion.draft_id = OLD.draft_id
              AND source.staging_object_key = OLD.staging_object_key
              AND source.approved_object_key = OLD.approved_object_key
              AND object.status = 'absent'
              AND object.approved_object_key IS NULL
              AND object.approved_object_key_hash IS NOT NULL
              AND object.expected_sha256 = OLD.sha256
              AND object.expected_byte_count = OLD.byte_count
        )
    )
)
BEGIN
    SELECT RAISE(ABORT, 'verified processing derivative evidence is immutable without exact promotion or cleanup evidence');
END;

DROP TRIGGER draft_derivatives_pending_exclusion_update_guard;

CREATE TRIGGER draft_derivatives_pending_exclusion_update_guard
BEFORE UPDATE ON draft_derivatives
WHEN NEW.draft_id IS OLD.draft_id AND
     NEW.role IS OLD.role AND
     EXISTS (
        SELECT 1
        FROM gallery_drafts AS draft
        JOIN json_each(draft.athlete_ids_json) AS tag
        JOIN pending_athlete_exclusions AS exclusion
          ON exclusion.athlete_id = tag.value
        WHERE draft.draft_id = NEW.draft_id
          AND exclusion.resolved_at IS NULL
     ) AND NOT (
        OLD.approved_object_key IS NOT NULL AND
        NEW.approved_object_key IS NULL AND
        EXISTS (
            SELECT 1
            FROM draft_photo_promotions AS promotion
            JOIN draft_photo_promotion_objects AS source
              ON source.promotion_id = promotion.promotion_id
             AND source.role = OLD.role
            JOIN draft_photo_promotion_cleanups AS cleanup
              ON cleanup.promotion_id = promotion.promotion_id
             AND cleanup.cleanup_reason IN ('athlete-exclusion', 'withdrawal')
             AND cleanup.status = 'deleting'
            JOIN draft_photo_promotion_cleanup_objects AS object
              ON object.cleanup_id = cleanup.cleanup_id
             AND object.role = source.role
             AND object.status = 'absent'
            WHERE promotion.draft_id = OLD.draft_id
              AND source.approved_object_key = OLD.approved_object_key
              AND object.expected_sha256 = OLD.sha256
              AND object.expected_byte_count = OLD.byte_count
        )
     )
BEGIN
    SELECT RAISE(ABORT, 'pending athlete exclusion blocks derivative evidence');
END;

DROP TRIGGER draft_derivatives_revision_update_guard;

CREATE TRIGGER draft_derivatives_revision_update_guard
BEFORE UPDATE ON draft_derivatives
WHEN NEW.draft_id IS OLD.draft_id AND
     NEW.role IS OLD.role AND
     NOT EXISTS (
        SELECT 1
        FROM gallery_drafts AS draft
        JOIN draft_consent_attestations AS consent
          ON consent.draft_id = draft.draft_id
         AND consent.consent_revision = draft.active_consent_revision
        WHERE draft.draft_id = NEW.draft_id
          AND draft.item_revision = NEW.item_revision
          AND draft.active_consent_revision = NEW.consent_revision
          AND draft.export_bundle_id = NEW.export_bundle_id
          AND draft.source_revision = NEW.source_revision
          AND draft.suppression_revision = NEW.suppression_revision
          AND consent.public_use_confirmed = 1
          AND (consent.contains_minors = 0 OR consent.guardian_approval_confirmed = 1)
          AND consent.withdrawn_at IS NULL
     ) AND NOT (
        OLD.approved_object_key IS NOT NULL AND
        NEW.approved_object_key IS NULL AND
        EXISTS (
            SELECT 1
            FROM draft_photo_promotions AS promotion
            JOIN draft_photo_promotion_objects AS source
              ON source.promotion_id = promotion.promotion_id
             AND source.role = OLD.role
            JOIN draft_photo_promotion_cleanups AS cleanup
              ON cleanup.promotion_id = promotion.promotion_id
             AND cleanup.status = 'deleting'
            JOIN draft_photo_promotion_cleanup_objects AS object
              ON object.cleanup_id = cleanup.cleanup_id
             AND object.role = source.role
             AND object.status = 'absent'
            WHERE promotion.draft_id = OLD.draft_id
              AND source.approved_object_key = OLD.approved_object_key
              AND object.expected_sha256 = OLD.sha256
              AND object.expected_byte_count = OLD.byte_count
        )
     )
BEGIN
    SELECT RAISE(ABORT, 'updated derivative evidence revisions are stale');
END;

-- Operational promotion evidence can disappear only inside the deleting
-- cleanup transaction, after host absence and derivative-reference removal.
DROP TRIGGER draft_photo_promotion_objects_no_delete_guard;

CREATE TRIGGER draft_photo_promotion_objects_no_delete_guard
BEFORE DELETE ON draft_photo_promotion_objects
WHEN NOT EXISTS (
    SELECT 1
    FROM draft_photo_promotion_cleanups AS cleanup
    JOIN draft_photo_promotion_cleanup_objects AS object
      ON object.cleanup_id = cleanup.cleanup_id
     AND object.role = OLD.role
    JOIN draft_photo_promotions AS promotion
      ON promotion.promotion_id = OLD.promotion_id
    WHERE cleanup.promotion_id = OLD.promotion_id
      AND cleanup.status = 'deleting'
      AND object.status = 'absent'
      AND object.approved_object_key IS NULL
      AND object.approved_object_key_hash IS NOT NULL
      AND object.expected_sha256 = OLD.sha256
      AND object.expected_byte_count = OLD.byte_count
      AND NOT EXISTS (
          SELECT 1 FROM draft_derivatives AS derivative
          WHERE derivative.draft_id = promotion.draft_id
            AND derivative.role = OLD.role
            AND derivative.approved_object_key = OLD.approved_object_key
      )
)
BEGIN
    SELECT RAISE(ABORT, 'photo promotion object deletion lacks approved cleanup evidence');
END;

DROP TRIGGER draft_photo_promotions_no_delete_guard;

CREATE TRIGGER draft_photo_promotions_no_delete_guard
BEFORE DELETE ON draft_photo_promotions
WHEN NOT EXISTS (
    SELECT 1
    FROM draft_photo_promotion_cleanups AS cleanup
    WHERE cleanup.promotion_id = OLD.promotion_id
      AND cleanup.status = 'deleting'
      AND NOT EXISTS (
          SELECT 1 FROM draft_photo_promotion_objects AS object
          WHERE object.promotion_id = OLD.promotion_id
      )
      AND (SELECT COUNT(*)
          FROM draft_photo_promotion_cleanup_objects AS object
          WHERE object.cleanup_id = cleanup.cleanup_id
            AND object.status = 'absent') = cleanup.object_count
)
BEGIN
    SELECT RAISE(ABORT, 'photo promotion deletion lacks completed object cleanup');
END;

CREATE TRIGGER draft_photo_promotion_cleanups_direct_delete_guard
BEFORE DELETE ON draft_photo_promotion_cleanups
WHEN EXISTS (
    SELECT 1 FROM gallery_drafts AS parent WHERE parent.draft_id = OLD.draft_id
)
BEGIN
    SELECT RAISE(ABORT, 'photo promotion cleanup direct deletion is forbidden; approved draft purge only');
END;

CREATE TRIGGER draft_photo_promotion_cleanup_objects_direct_delete_guard
BEFORE DELETE ON draft_photo_promotion_cleanup_objects
WHEN EXISTS (
    SELECT 1
    FROM draft_photo_promotion_cleanups AS cleanup
    JOIN gallery_drafts AS parent ON parent.draft_id = cleanup.draft_id
    WHERE cleanup.cleanup_id = OLD.cleanup_id
)
BEGIN
    SELECT RAISE(ABORT, 'photo promotion cleanup object deletion is forbidden; approved draft purge only');
END;

-- Private staging may be cleaned only after the approved promotion has either
-- never existed or has exact completed cleanup plus its immutable tombstone.
DROP TRIGGER draft_processing_cleanups_photo_promotion_guard;

CREATE TRIGGER draft_processing_cleanups_photo_promotion_guard
BEFORE INSERT ON draft_processing_cleanups
WHEN EXISTS (
    SELECT 1 FROM draft_photo_promotions AS promotion
    WHERE promotion.processing_run_id = NEW.processing_run_id
) OR EXISTS (
    SELECT 1
    FROM draft_photo_promotion_cleanups AS cleanup
    WHERE cleanup.processing_run_id = NEW.processing_run_id
      AND NOT EXISTS (
          SELECT 1
          FROM gallery_photo_promotion_cleanup_tombstones AS tombstone
          WHERE cleanup.status = 'cleaned'
            AND tombstone.cleanup_id_hash = cleanup.cleanup_id_hash
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
      )
)
BEGIN
    SELECT RAISE(ABORT, 'processing cleanup is unavailable before completed approved-media cleanup');
END;

DROP TRIGGER gallery_drafts_photo_promotion_purge_guard;

CREATE TRIGGER gallery_drafts_photo_promotion_purge_guard
BEFORE DELETE ON gallery_drafts
WHEN EXISTS (
    SELECT 1 FROM draft_photo_promotions AS promotion
    WHERE promotion.draft_id = OLD.draft_id
) OR EXISTS (
    SELECT 1
    FROM draft_photo_promotion_cleanups AS cleanup
    WHERE cleanup.draft_id = OLD.draft_id
      AND NOT EXISTS (
          SELECT 1
          FROM gallery_photo_promotion_cleanup_tombstones AS tombstone
          WHERE cleanup.status = 'cleaned'
            AND tombstone.cleanup_id_hash = cleanup.cleanup_id_hash
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
      )
)
BEGIN
    SELECT RAISE(ABORT, 'gallery draft purge is unavailable before approved cleanup evidence');
END;

-- R2 storage absence is not public-host absence. A separate fixed-origin
-- verifier must write publication evidence before the draft may become
-- withdrawn. Even then, current approved references block the transition, and
-- an actual consent withdrawal always retains its stronger private-original
-- deletion requirement regardless of any competing exclusion classification.
DROP TRIGGER gallery_drafts_withdrawal_evidence_guard;

CREATE TRIGGER gallery_drafts_withdrawal_evidence_guard
BEFORE UPDATE OF state ON gallery_drafts
WHEN NEW.state = 'withdrawn' AND NOT EXISTS (
    SELECT 1
    FROM draft_publication_references AS publication
    WHERE publication.draft_id = OLD.draft_id
      AND publication.withdrawal_kind IS NOT NULL
      AND publication.host_deletion_confirmed = 1
      AND NOT EXISTS (
          SELECT 1 FROM draft_derivatives AS derivative
          WHERE derivative.draft_id = OLD.draft_id
            AND derivative.approved_object_key IS NOT NULL
      )
      AND (
          NOT EXISTS (
              SELECT 1 FROM draft_consent_attestations AS consent
              WHERE consent.draft_id = OLD.draft_id
                AND consent.withdrawn_at IS NOT NULL
          ) OR (
              publication.withdrawal_kind = 'consent-withdrawal' AND
              publication.private_original_deletion_confirmed = 1
          )
      )
)
BEGIN
    SELECT RAISE(ABORT, 'current verified withdrawal evidence is required');
END;

PRAGMA foreign_key_check;
