PRAGMA foreign_keys = ON;

-- One promotion claim binds the already verified private photo outputs to one
-- exact draft revision. This boundary has no manifest, GitHub, merge, or
-- publication authority. A later migration must add review evidence before
-- pr-open or published can become reachable.
CREATE TABLE draft_photo_promotions (
    promotion_id TEXT PRIMARY KEY
        CHECK (
            length(promotion_id) = 42 AND
            substr(promotion_id, 1, 10) = 'promotion_' AND
            substr(promotion_id, 11) NOT GLOB '*[^0-9a-f]*' AND
            substr(promotion_id, 23, 1) = '4' AND
            substr(promotion_id, 27, 1) IN ('8', '9', 'a', 'b')
        ),
    processing_run_id TEXT NOT NULL UNIQUE,
    draft_id TEXT NOT NULL,
    site_mode TEXT NOT NULL CHECK (site_mode IN ('family', 'everyone')),
    item_revision TEXT NOT NULL,
    consent_revision TEXT NOT NULL,
    export_bundle_id TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    suppression_revision TEXT NOT NULL,
    expected_state_version INTEGER NOT NULL CHECK (expected_state_version >= 0),
    result_state_version INTEGER NOT NULL
        CHECK (result_state_version = expected_state_version + 1),
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
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'candidate')),
    candidate_payload_hash TEXT
        CHECK (
            candidate_payload_hash IS NULL OR (
                length(candidate_payload_hash) = 64 AND
                candidate_payload_hash NOT GLOB '*[^0-9a-f]*'
            )
        ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    candidate_at TEXT,
    UNIQUE (draft_id, expected_state_version),
    UNIQUE (draft_id, idempotency_key),
    FOREIGN KEY (processing_run_id)
        REFERENCES draft_processing_runs(processing_run_id),
    FOREIGN KEY (draft_id)
        REFERENCES gallery_drafts(draft_id)
        ON DELETE CASCADE,
    FOREIGN KEY (draft_id, consent_revision)
        REFERENCES draft_consent_attestations(draft_id, consent_revision),
    CHECK (created_at <= updated_at),
    CHECK (
        (
            status = 'active' AND
            candidate_payload_hash IS NULL AND
            candidate_at IS NULL
        ) OR (
            status = 'candidate' AND
            candidate_payload_hash IS NOT NULL AND
            candidate_at IS NOT NULL
        )
    )
);

-- Multipart upload identity is persisted before any approved byte is sent.
-- A response-lost retry can therefore resume the same provider handle, while a
-- later cleanup migration can abort it before proving object absence.
CREATE TABLE draft_photo_promotion_objects (
    promotion_id TEXT NOT NULL,
    role TEXT NOT NULL
        CHECK (role IN ('photo-display', 'photo-thumbnail')),
    staging_object_key TEXT NOT NULL,
    staging_object_version TEXT NOT NULL
        CHECK (length(staging_object_version) BETWEEN 1 AND 256),
    staging_etag TEXT NOT NULL
        CHECK (length(staging_etag) BETWEEN 1 AND 256),
    approved_object_key TEXT NOT NULL UNIQUE,
    sha256 TEXT NOT NULL
        CHECK (
            length(sha256) = 64 AND
            sha256 NOT GLOB '*[^0-9a-f]*'
        ),
    byte_count INTEGER NOT NULL CHECK (byte_count > 0),
    content_type TEXT NOT NULL CHECK (content_type = 'image/webp'),
    width INTEGER NOT NULL CHECK (width > 0),
    height INTEGER NOT NULL CHECK (height > 0),
    status TEXT NOT NULL DEFAULT 'reserved'
        CHECK (status IN (
            'reserved', 'admitting', 'upload-open', 'part-uploaded', 'verified'
        )),
    provider_admission_token_hash TEXT UNIQUE
        CHECK (
            provider_admission_token_hash IS NULL OR (
                length(provider_admission_token_hash) = 64 AND
                provider_admission_token_hash NOT GLOB '*[^0-9a-f]*'
            )
        ),
    provider_upload_id TEXT UNIQUE
        CHECK (
            provider_upload_id IS NULL OR
            length(provider_upload_id) BETWEEN 1 AND 512
        ),
    provider_upload_id_hash TEXT UNIQUE
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
    approved_object_version TEXT
        CHECK (
            approved_object_version IS NULL OR
            length(approved_object_version) BETWEEN 1 AND 256
        ),
    approved_etag TEXT
        CHECK (
            approved_etag IS NULL OR
            length(approved_etag) BETWEEN 1 AND 256
        ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    verified_at TEXT,
    PRIMARY KEY (promotion_id, role),
    FOREIGN KEY (promotion_id)
        REFERENCES draft_photo_promotions(promotion_id)
        ON DELETE CASCADE,
    CHECK (created_at <= updated_at),
    CHECK (
        (
            (
                (status = 'reserved' AND provider_admission_token_hash IS NULL) OR
                (status = 'admitting' AND provider_admission_token_hash IS NOT NULL)
            ) AND
            provider_upload_id IS NULL AND
            provider_upload_id_hash IS NULL AND
            provider_part_etag IS NULL AND
            approved_object_version IS NULL AND
            approved_etag IS NULL AND
            verified_at IS NULL
        ) OR (
            status = 'upload-open' AND
            provider_admission_token_hash IS NOT NULL AND
            provider_upload_id IS NOT NULL AND
            provider_upload_id_hash IS NOT NULL AND
            provider_part_etag IS NULL AND
            approved_object_version IS NULL AND
            approved_etag IS NULL AND
            verified_at IS NULL
        ) OR (
            status = 'part-uploaded' AND
            provider_admission_token_hash IS NOT NULL AND
            provider_upload_id IS NOT NULL AND
            provider_upload_id_hash IS NOT NULL AND
            provider_part_etag IS NOT NULL AND
            approved_object_version IS NULL AND
            approved_etag IS NULL AND
            verified_at IS NULL
        ) OR (
            status = 'verified' AND
            provider_admission_token_hash IS NOT NULL AND
            provider_upload_id IS NOT NULL AND
            provider_upload_id_hash IS NOT NULL AND
            provider_part_etag IS NOT NULL AND
            approved_object_version IS NOT NULL AND
            approved_etag IS NOT NULL AND
            verified_at IS NOT NULL
        )
    )
);

CREATE INDEX draft_photo_promotions_status_index
    ON draft_photo_promotions(status, updated_at);

CREATE TRIGGER draft_photo_promotions_no_replace_guard
BEFORE INSERT ON draft_photo_promotions
WHEN EXISTS (
    SELECT 1 FROM draft_photo_promotions AS existing
    WHERE existing.promotion_id = NEW.promotion_id
       OR existing.processing_run_id = NEW.processing_run_id
       OR (
           existing.draft_id = NEW.draft_id AND
           existing.expected_state_version = NEW.expected_state_version
       )
       OR (
           existing.draft_id = NEW.draft_id AND
           existing.idempotency_key = NEW.idempotency_key
       )
)
BEGIN
    SELECT RAISE(ABORT, 'photo promotion replacement is forbidden');
END;

CREATE TRIGGER draft_photo_promotions_insert_guard
BEFORE INSERT ON draft_photo_promotions
WHEN NOT EXISTS (
    SELECT 1
    FROM gallery_drafts AS draft
    JOIN draft_consent_attestations AS consent
      ON consent.draft_id = draft.draft_id
     AND consent.consent_revision = draft.active_consent_revision
    JOIN draft_processing_runs AS run
      ON run.processing_run_id = NEW.processing_run_id
     AND run.draft_id = draft.draft_id
    WHERE draft.draft_id = NEW.draft_id
      AND draft.state = 'processing'
      AND draft.state_version = NEW.expected_state_version
      AND draft.site_modes_json = json_array(NEW.site_mode)
      AND draft.media_type = 'photo'
      AND draft.item_revision = NEW.item_revision
      AND draft.active_consent_revision = NEW.consent_revision
      AND draft.export_bundle_id = NEW.export_bundle_id
      AND draft.source_revision = NEW.source_revision
      AND draft.suppression_revision = NEW.suppression_revision
      AND consent.public_use_confirmed = 1
      AND (consent.contains_minors = 0 OR consent.guardian_approval_confirmed = 1)
      AND consent.withdrawn_at IS NULL
      AND run.status = 'staged'
      AND run.site_mode = NEW.site_mode
      AND run.media_type = 'photo'
      AND run.item_revision = NEW.item_revision
      AND run.consent_revision = NEW.consent_revision
      AND run.export_bundle_id = NEW.export_bundle_id
      AND run.source_revision = NEW.source_revision
      AND run.suppression_revision = NEW.suppression_revision
      AND NOT EXISTS (
          SELECT 1
          FROM json_each(draft.athlete_ids_json) AS tag
          JOIN pending_athlete_exclusions AS exclusion
            ON exclusion.athlete_id = tag.value
          WHERE exclusion.resolved_at IS NULL
      )
      AND NOT EXISTS (
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
          SELECT COUNT(*) FROM draft_processing_outputs AS output
          WHERE output.processing_run_id = run.processing_run_id
            AND output.status = 'verified'
      ) = 2
      AND (
          SELECT COUNT(*)
          FROM draft_derivatives AS derivative
          JOIN draft_processing_outputs AS output
            ON output.processing_run_id = run.processing_run_id
           AND output.role = derivative.role
          WHERE derivative.draft_id = draft.draft_id
            AND derivative.staging_object_key = output.staging_object_key
            AND derivative.sha256 = output.sha256
            AND derivative.byte_count = output.byte_count
            AND derivative.approved_object_key IS NULL
      ) = 2
)
BEGIN
    SELECT RAISE(ABORT, 'photo promotion lacks current verified staging evidence');
END;

CREATE TRIGGER draft_photo_promotions_identity_update_guard
BEFORE UPDATE OF
    promotion_id,
    processing_run_id,
    draft_id,
    site_mode,
    item_revision,
    consent_revision,
    export_bundle_id,
    source_revision,
    suppression_revision,
    expected_state_version,
    result_state_version,
    idempotency_key,
    idempotency_key_hash,
    payload_fingerprint,
    service_actor_identity_hash,
    created_at
ON draft_photo_promotions
WHEN
    NEW.promotion_id IS NOT OLD.promotion_id OR
    NEW.processing_run_id IS NOT OLD.processing_run_id OR
    NEW.draft_id IS NOT OLD.draft_id OR
    NEW.site_mode IS NOT OLD.site_mode OR
    NEW.item_revision IS NOT OLD.item_revision OR
    NEW.consent_revision IS NOT OLD.consent_revision OR
    NEW.export_bundle_id IS NOT OLD.export_bundle_id OR
    NEW.source_revision IS NOT OLD.source_revision OR
    NEW.suppression_revision IS NOT OLD.suppression_revision OR
    NEW.expected_state_version IS NOT OLD.expected_state_version OR
    NEW.result_state_version IS NOT OLD.result_state_version OR
    NEW.idempotency_key IS NOT OLD.idempotency_key OR
    NEW.idempotency_key_hash IS NOT OLD.idempotency_key_hash OR
    NEW.payload_fingerprint IS NOT OLD.payload_fingerprint OR
    NEW.service_actor_identity_hash IS NOT OLD.service_actor_identity_hash OR
    NEW.created_at IS NOT OLD.created_at
BEGIN
    SELECT RAISE(ABORT, 'photo promotion identity is immutable');
END;

CREATE TRIGGER draft_photo_promotions_transition_guard
BEFORE UPDATE ON draft_photo_promotions
WHEN OLD.status = 'active' AND NOT (
    NEW.status = 'candidate' AND
    NEW.candidate_payload_hash IS NOT NULL AND
    NEW.candidate_at IS NOT NULL AND
    NEW.updated_at = NEW.candidate_at AND
    NEW.updated_at >= OLD.updated_at
)
BEGIN
    SELECT RAISE(ABORT, 'invalid photo promotion transition');
END;

CREATE TRIGGER draft_photo_promotions_no_delete_guard
BEFORE DELETE ON draft_photo_promotions
BEGIN
    SELECT RAISE(ABORT, 'photo promotion deletion requires future cleanup evidence');
END;

CREATE TRIGGER draft_photo_promotion_objects_no_replace_guard
BEFORE INSERT ON draft_photo_promotion_objects
WHEN EXISTS (
    SELECT 1 FROM draft_photo_promotion_objects AS existing
    WHERE (
        existing.promotion_id = NEW.promotion_id AND
        existing.role = NEW.role
    ) OR existing.approved_object_key = NEW.approved_object_key
       OR (
           NEW.provider_admission_token_hash IS NOT NULL AND
           existing.provider_admission_token_hash = NEW.provider_admission_token_hash
       )
       OR (
           NEW.provider_upload_id IS NOT NULL AND
           existing.provider_upload_id = NEW.provider_upload_id
       ) OR (
           NEW.provider_upload_id_hash IS NOT NULL AND
           existing.provider_upload_id_hash = NEW.provider_upload_id_hash
       )
)
BEGIN
    SELECT RAISE(ABORT, 'photo promotion object replacement is forbidden');
END;

CREATE TRIGGER draft_photo_promotion_objects_insert_guard
BEFORE INSERT ON draft_photo_promotion_objects
WHEN NOT EXISTS (
    SELECT 1
    FROM draft_photo_promotions AS promotion
    JOIN draft_processing_runs AS run
      ON run.processing_run_id = promotion.processing_run_id
    JOIN draft_processing_outputs AS output
      ON output.processing_run_id = run.processing_run_id
     AND output.role = NEW.role
    JOIN draft_derivatives AS derivative
      ON derivative.draft_id = promotion.draft_id
     AND derivative.role = output.role
    WHERE promotion.promotion_id = NEW.promotion_id
      AND promotion.status = 'active'
      AND run.status = 'staged'
      AND output.status = 'verified'
      AND output.staging_object_key = NEW.staging_object_key
      AND output.staging_object_version = NEW.staging_object_version
      AND output.staging_etag = NEW.staging_etag
      AND output.sha256 = NEW.sha256
      AND output.byte_count = NEW.byte_count
      AND output.content_type = NEW.content_type
      AND output.width = NEW.width
      AND output.height = NEW.height
      AND derivative.staging_object_key = NEW.staging_object_key
      AND derivative.approved_object_key IS NULL
      AND NEW.status = 'reserved'
      AND NEW.provider_admission_token_hash IS NULL
      AND NEW.provider_upload_id IS NULL
      AND NEW.provider_upload_id_hash IS NULL
      AND NEW.provider_part_etag IS NULL
      AND NEW.approved_object_version IS NULL
      AND NEW.approved_etag IS NULL
      AND NEW.verified_at IS NULL
      AND NEW.approved_object_key = 'media/v1/' || NEW.sha256 || CASE NEW.role
          WHEN 'photo-display' THEN '/display.webp'
          WHEN 'photo-thumbnail' THEN '/thumbnail.webp'
      END
)
BEGIN
    SELECT RAISE(ABORT, 'photo promotion object is not derived from verified staging evidence');
END;

CREATE TRIGGER draft_photo_promotion_objects_identity_update_guard
BEFORE UPDATE OF
    promotion_id,
    role,
    staging_object_key,
    staging_object_version,
    staging_etag,
    approved_object_key,
    sha256,
    byte_count,
    content_type,
    width,
    height,
    created_at
ON draft_photo_promotion_objects
WHEN
    NEW.promotion_id IS NOT OLD.promotion_id OR
    NEW.role IS NOT OLD.role OR
    NEW.staging_object_key IS NOT OLD.staging_object_key OR
    NEW.staging_object_version IS NOT OLD.staging_object_version OR
    NEW.staging_etag IS NOT OLD.staging_etag OR
    NEW.approved_object_key IS NOT OLD.approved_object_key OR
    NEW.sha256 IS NOT OLD.sha256 OR
    NEW.byte_count IS NOT OLD.byte_count OR
    NEW.content_type IS NOT OLD.content_type OR
    NEW.width IS NOT OLD.width OR
    NEW.height IS NOT OLD.height OR
    NEW.created_at IS NOT OLD.created_at
BEGIN
    SELECT RAISE(ABORT, 'photo promotion object identity is immutable');
END;

-- SQLite UPDATE OR REPLACE can otherwise delete a different row that owns a
-- UNIQUE provider identity before ordinary delete guards run. Reject that
-- collision explicitly so admission and upload ownership remain append-only.
CREATE TRIGGER draft_photo_promotion_objects_provider_identity_collision_guard
BEFORE UPDATE OF
    provider_admission_token_hash,
    provider_upload_id,
    provider_upload_id_hash
ON draft_photo_promotion_objects
WHEN EXISTS (
    SELECT 1
    FROM draft_photo_promotion_objects AS existing
    WHERE NOT (
        existing.promotion_id = OLD.promotion_id AND
        existing.role = OLD.role
    ) AND (
        (
            NEW.provider_admission_token_hash IS NOT NULL AND
            existing.provider_admission_token_hash =
                NEW.provider_admission_token_hash
        ) OR (
            NEW.provider_upload_id IS NOT NULL AND
            existing.provider_upload_id = NEW.provider_upload_id
        ) OR (
            NEW.provider_upload_id_hash IS NOT NULL AND
            existing.provider_upload_id_hash = NEW.provider_upload_id_hash
        )
    )
)
BEGIN
    SELECT RAISE(ABORT, 'photo promotion provider identity replacement is forbidden');
END;

CREATE TRIGGER draft_photo_promotion_objects_transition_guard
BEFORE UPDATE ON draft_photo_promotion_objects
WHEN NOT (
    (
        OLD.status = 'reserved' AND
        NEW.status = 'admitting' AND
        NEW.provider_admission_token_hash IS NOT NULL AND
        NEW.provider_upload_id IS NULL AND
        NEW.provider_upload_id_hash IS NULL AND
        NEW.provider_part_etag IS NULL AND
        NEW.approved_object_version IS NULL AND
        NEW.approved_etag IS NULL AND
        NEW.verified_at IS NULL
    ) OR (
        OLD.status = 'admitting' AND
        NEW.status = 'upload-open' AND
        NEW.provider_admission_token_hash IS OLD.provider_admission_token_hash AND
        NEW.provider_upload_id IS NOT NULL AND
        NEW.provider_upload_id_hash IS NOT NULL AND
        NEW.provider_part_etag IS NULL AND
        NEW.approved_object_version IS NULL AND
        NEW.approved_etag IS NULL AND
        NEW.verified_at IS NULL
    ) OR (
        OLD.status = 'upload-open' AND
        NEW.status = 'part-uploaded' AND
        NEW.provider_admission_token_hash IS OLD.provider_admission_token_hash AND
        NEW.provider_upload_id IS OLD.provider_upload_id AND
        NEW.provider_upload_id_hash IS OLD.provider_upload_id_hash AND
        NEW.provider_part_etag IS NOT NULL AND
        NEW.approved_object_version IS NULL AND
        NEW.approved_etag IS NULL AND
        NEW.verified_at IS NULL
    ) OR (
        OLD.status = 'part-uploaded' AND
        NEW.status = 'verified' AND
        NEW.provider_admission_token_hash IS OLD.provider_admission_token_hash AND
        NEW.provider_upload_id IS OLD.provider_upload_id AND
        NEW.provider_upload_id_hash IS OLD.provider_upload_id_hash AND
        NEW.provider_part_etag IS OLD.provider_part_etag AND
        NEW.approved_object_version IS NOT NULL AND
        NEW.approved_etag IS NOT NULL AND
        NEW.verified_at IS NOT NULL
    )
) OR NEW.updated_at <= OLD.updated_at
BEGIN
    SELECT RAISE(ABORT, 'invalid photo promotion object transition');
END;

CREATE TRIGGER draft_photo_promotion_objects_verified_guard
BEFORE UPDATE ON draft_photo_promotion_objects
WHEN OLD.status = 'verified'
BEGIN
    SELECT RAISE(ABORT, 'verified photo promotion object is immutable');
END;

CREATE TRIGGER draft_photo_promotion_objects_no_delete_guard
BEFORE DELETE ON draft_photo_promotion_objects
BEGIN
    SELECT RAISE(ABORT, 'photo promotion object deletion requires future cleanup evidence');
END;

-- Promotion is terminal only after both approved objects have independent
-- provider evidence and both derivative rows point at those exact keys.
CREATE TRIGGER draft_photo_promotions_candidate_guard
BEFORE UPDATE OF status ON draft_photo_promotions
WHEN NEW.status = 'candidate' AND NOT (
    OLD.status = 'active' AND
    NEW.candidate_payload_hash IS NOT NULL AND
    NEW.candidate_at IS NOT NULL AND
    EXISTS (
        SELECT 1
        FROM gallery_drafts AS draft
        JOIN draft_consent_attestations AS consent
          ON consent.draft_id = draft.draft_id
         AND consent.consent_revision = draft.active_consent_revision
        JOIN draft_processing_runs AS run
          ON run.processing_run_id = OLD.processing_run_id
        WHERE draft.draft_id = OLD.draft_id
          AND draft.state = 'processing'
          AND draft.state_version = OLD.expected_state_version
          AND draft.site_modes_json = json_array(OLD.site_mode)
          AND draft.item_revision = OLD.item_revision
          AND draft.active_consent_revision = OLD.consent_revision
          AND draft.export_bundle_id = OLD.export_bundle_id
          AND draft.source_revision = OLD.source_revision
          AND draft.suppression_revision = OLD.suppression_revision
          AND consent.public_use_confirmed = 1
          AND (consent.contains_minors = 0 OR consent.guardian_approval_confirmed = 1)
          AND consent.withdrawn_at IS NULL
          AND run.status = 'staged'
          AND NOT EXISTS (
              SELECT 1
              FROM json_each(draft.athlete_ids_json) AS tag
              JOIN pending_athlete_exclusions AS exclusion
                ON exclusion.athlete_id = tag.value
              WHERE exclusion.resolved_at IS NULL
          )
          AND NOT EXISTS (
              SELECT 1 FROM draft_processing_cleanups AS cleanup
              WHERE cleanup.processing_run_id = run.processing_run_id
          )
    ) AND
    (
        SELECT COUNT(*)
        FROM draft_photo_promotion_objects AS object
        JOIN draft_derivatives AS derivative
          ON derivative.draft_id = OLD.draft_id
         AND derivative.role = object.role
         AND derivative.approved_object_key = object.approved_object_key
        WHERE object.promotion_id = OLD.promotion_id
          AND object.status = 'verified'
    ) = 2
)
BEGIN
    SELECT RAISE(ABORT, 'photo promotion cannot become candidate without exact approved evidence');
END;

CREATE TRIGGER draft_photo_promotions_terminal_guard
BEFORE UPDATE ON draft_photo_promotions
WHEN OLD.status = 'candidate'
BEGIN
    SELECT RAISE(ABORT, 'candidate photo promotion is immutable before review lifecycle support');
END;

-- Replace the Phase D absolute derivative stop with one narrowly evidenced
-- NULL -> approved key assignment. Approved deletion remains unavailable until
-- the dedicated cleanup migration proves provider absence.
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
    )
)
BEGIN
    SELECT RAISE(ABORT, 'verified processing derivative evidence is immutable without exact promotion evidence');
END;

-- Candidate state is now reachable only through the completed photo promotion.
DROP TRIGGER gallery_drafts_candidate_processing_guard;

CREATE TRIGGER gallery_drafts_candidate_processing_guard
BEFORE UPDATE OF state ON gallery_drafts
WHEN NEW.state = 'candidate-public' AND OLD.state <> 'candidate-public' AND NOT EXISTS (
    SELECT 1
    FROM draft_photo_promotions AS promotion
    WHERE promotion.draft_id = OLD.draft_id
      AND promotion.status = 'candidate'
      AND OLD.state = 'processing'
      AND OLD.state_version = promotion.expected_state_version
      AND NEW.state_version = promotion.result_state_version
      AND NEW.site_modes_json = json_array(promotion.site_mode)
      AND NEW.item_revision = promotion.item_revision
      AND NEW.active_consent_revision = promotion.consent_revision
      AND NEW.export_bundle_id = promotion.export_bundle_id
      AND NEW.source_revision = promotion.source_revision
      AND NEW.suppression_revision = promotion.suppression_revision
      AND (
          SELECT COUNT(*)
          FROM draft_photo_promotion_objects AS object
          JOIN draft_derivatives AS derivative
            ON derivative.draft_id = OLD.draft_id
           AND derivative.role = object.role
           AND derivative.approved_object_key = object.approved_object_key
          WHERE object.promotion_id = promotion.promotion_id
            AND object.status = 'verified'
      ) = 2
)
BEGIN
    SELECT RAISE(ABORT, 'candidate publication lacks exact photo promotion evidence');
END;

CREATE TRIGGER draft_transition_receipts_candidate_promotion_guard
BEFORE INSERT ON draft_transition_receipts
WHEN NEW.to_state = 'candidate-public' AND NOT EXISTS (
    SELECT 1
    FROM draft_photo_promotions AS promotion
    JOIN gallery_drafts AS draft ON draft.draft_id = promotion.draft_id
    WHERE promotion.draft_id = NEW.draft_id
      AND promotion.status = 'candidate'
      AND promotion.idempotency_key = NEW.idempotency_key
      AND promotion.payload_fingerprint = NEW.payload_fingerprint
      AND promotion.expected_state_version = NEW.expected_state_version
      AND promotion.result_state_version = NEW.result_state_version
      AND NEW.from_state = 'processing'
      AND draft.state = 'candidate-public'
      AND draft.state_version = NEW.result_state_version
)
BEGIN
    SELECT RAISE(ABORT, 'candidate transition receipt lacks photo promotion evidence');
END;

-- GitHub review and production evidence are deliberately not implemented in
-- this migration. Preserve hard stops even though the original state machine
-- knows the eventual states.
CREATE TRIGGER gallery_drafts_pr_open_unavailable_guard
BEFORE UPDATE OF state ON gallery_drafts
WHEN NEW.state = 'pr-open' AND OLD.state <> 'pr-open'
BEGIN
    SELECT RAISE(ABORT, 'pull request state is unavailable before immutable review evidence');
END;

CREATE TRIGGER gallery_drafts_published_unavailable_guard
BEFORE UPDATE OF state ON gallery_drafts
WHEN NEW.state = 'published' AND OLD.state <> 'published'
BEGIN
    SELECT RAISE(ABORT, 'published state is unavailable before exact release evidence');
END;

-- The proven private-staging cleanup must not race or erase the source evidence
-- of an approved upload. A forward cleanup migration will replace this stop
-- only after it persists exact approved-object closure and deletion proof.
CREATE TRIGGER draft_processing_cleanups_photo_promotion_guard
BEFORE INSERT ON draft_processing_cleanups
WHEN EXISTS (
    SELECT 1 FROM draft_photo_promotions AS promotion
    WHERE promotion.processing_run_id = NEW.processing_run_id
)
BEGIN
    SELECT RAISE(ABORT, 'processing cleanup is unavailable while photo promotion evidence exists');
END;

CREATE TRIGGER gallery_drafts_photo_promotion_purge_guard
BEFORE DELETE ON gallery_drafts
WHEN EXISTS (
    SELECT 1 FROM draft_photo_promotions AS promotion
    WHERE promotion.draft_id = OLD.draft_id
)
BEGIN
    SELECT RAISE(ABORT, 'gallery draft purge is unavailable before approved cleanup evidence');
END;

PRAGMA foreign_key_check;
