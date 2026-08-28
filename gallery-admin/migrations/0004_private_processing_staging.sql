PRAGMA foreign_keys = ON;

-- The prior upload guard correctly requires an active consent revision for all
-- publicward states, but that also blocked the final withdrawal-pending ->
-- withdrawn step after the one-way consent trigger cleared the active revision.
-- Replace it with one narrow terminal exception that keeps every upload fact
-- unchanged and requires the withdrawn attestation plus deletion evidence.
DROP TRIGGER gallery_drafts_upload_completion_guard;

CREATE TRIGGER gallery_drafts_upload_completion_guard
BEFORE UPDATE OF
    state,
    upload_complete,
    original_object_key,
    original_detected_type,
    original_byte_count,
    original_sha256
ON gallery_drafts
WHEN NEW.upload_complete = 1 AND NOT (
    EXISTS (
        SELECT 1
        FROM draft_upload_sessions AS session
        WHERE session.draft_id = NEW.draft_id
          AND session.status = 'complete'
          AND session.object_key = NEW.original_object_key
          AND session.detected_format = NEW.original_detected_type
          AND session.declared_byte_count = NEW.original_byte_count
          AND session.completed_sha256 = NEW.original_sha256
          AND session.item_revision = NEW.item_revision
          AND session.consent_revision = NEW.active_consent_revision
          AND session.export_bundle_id = NEW.export_bundle_id
          AND session.source_revision = NEW.source_revision
          AND session.suppression_revision = NEW.suppression_revision
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
            FROM draft_upload_sessions AS session
            JOIN draft_consent_attestations AS consent
              ON consent.draft_id = session.draft_id
             AND consent.consent_revision = session.consent_revision
            JOIN draft_publication_references AS publication
              ON publication.draft_id = session.draft_id
            WHERE session.draft_id = NEW.draft_id
              AND session.status = 'deleted'
              AND session.object_deleted_at IS NOT NULL
              AND length(session.completed_object_version) BETWEEN 1 AND 256
              AND length(session.completed_etag) BETWEEN 1 AND 256
              AND session.completed_sha256 IS NOT NULL
              AND session.object_key = NEW.original_object_key
              AND session.detected_format = NEW.original_detected_type
              AND session.declared_byte_count = NEW.original_byte_count
              AND session.completed_sha256 = NEW.original_sha256
              AND session.item_revision = NEW.item_revision
              AND session.export_bundle_id = NEW.export_bundle_id
              AND session.source_revision = NEW.source_revision
              AND session.suppression_revision = NEW.suppression_revision
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

-- A processing run is the immutable bridge between one approved private
-- original and one set of private staging objects. It intentionally contains
-- no approved-media key, public URL, manifest, GitHub, or publication fact.
CREATE TABLE draft_processing_runs (
    processing_run_id TEXT PRIMARY KEY
        CHECK (
            length(processing_run_id) = 36 AND
            substr(processing_run_id, 1, 4) = 'run_' AND
            substr(processing_run_id, 5, 32) NOT GLOB '*[^0-9a-f]*' AND
            substr(processing_run_id, 17, 1) = '4' AND
            substr(processing_run_id, 21, 1) IN ('8', '9', 'a', 'b')
        ),
    draft_id TEXT NOT NULL,
    site_mode TEXT NOT NULL
        CHECK (site_mode IN ('family', 'everyone')),
    media_type TEXT NOT NULL
        CHECK (media_type = 'photo'),
    item_revision TEXT NOT NULL,
    consent_revision TEXT NOT NULL,
    export_bundle_id TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    suppression_revision TEXT NOT NULL,
    upload_session_id TEXT NOT NULL,
    original_object_key TEXT NOT NULL,
    original_detected_type TEXT NOT NULL
        CHECK (original_detected_type IN ('jpeg', 'png')),
    original_declared_content_type TEXT NOT NULL
        CHECK (original_declared_content_type IN ('image/jpeg', 'image/png')),
    original_byte_count INTEGER NOT NULL
        CHECK (original_byte_count BETWEEN 1 AND 26214400),
    original_sha256 TEXT NOT NULL
        CHECK (
            length(original_sha256) = 64 AND
            original_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
    original_object_version TEXT NOT NULL
        CHECK (length(original_object_version) BETWEEN 1 AND 256),
    original_etag TEXT NOT NULL
        CHECK (length(original_etag) BETWEEN 1 AND 256),
    start_expected_state_version INTEGER NOT NULL
        CHECK (start_expected_state_version >= 0),
    processing_state_version INTEGER NOT NULL
        CHECK (processing_state_version = start_expected_state_version + 1),
    start_idempotency_key TEXT NOT NULL
        CHECK (
            length(start_idempotency_key) BETWEEN 16 AND 128 AND
            start_idempotency_key NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
    start_payload_fingerprint TEXT NOT NULL
        CHECK (
            length(start_payload_fingerprint) = 64 AND
            start_payload_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
    service_actor_identity_hash TEXT NOT NULL
        CHECK (
            length(service_actor_identity_hash) = 64 AND
            service_actor_identity_hash NOT GLOB '*[^0-9a-f]*'
        ),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'staged', 'failed')),
    result_idempotency_key TEXT
        CHECK (
            result_idempotency_key IS NULL OR (
                length(result_idempotency_key) BETWEEN 16 AND 128 AND
                result_idempotency_key NOT GLOB '*[^A-Za-z0-9_-]*'
            )
        ),
    result_payload_fingerprint TEXT
        CHECK (
            result_payload_fingerprint IS NULL OR (
                length(result_payload_fingerprint) = 64 AND
                result_payload_fingerprint NOT GLOB '*[^0-9a-f]*'
            )
        ),
    result_transition_key TEXT
        CHECK (
            result_transition_key IS NULL OR (
                length(result_transition_key) = 72 AND
                substr(result_transition_key, 1, 8) = 'failure_' AND
                substr(result_transition_key, 9) NOT GLOB '*[^0-9a-f]*'
            )
        ),
    result_toolchain_json TEXT
        CHECK (
            result_toolchain_json IS NULL OR
            result_toolchain_json =
                '{"sharp":"0.35.2","libvips":"8.18.3","webp":"1.6.0","png":"1.6.58","exiftool":"13.40","videoEnabled":false}'
        ),
    failure_code TEXT
        CHECK (
            failure_code IS NULL OR failure_code IN (
                'cleanup-failed',
                'derivative-rejected',
                'invalid-media',
                'metadata-scan-failed',
                'processing-failed',
                'source-rejected',
                'toolchain-unavailable'
            )
        ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE (draft_id, start_idempotency_key),
    FOREIGN KEY (draft_id) REFERENCES gallery_drafts(draft_id)
        ON DELETE CASCADE,
    FOREIGN KEY (upload_session_id) REFERENCES draft_upload_sessions(upload_session_id),
    FOREIGN KEY (draft_id, consent_revision)
        REFERENCES draft_consent_attestations(draft_id, consent_revision),
    CHECK (created_at <= updated_at),
    CHECK (
        (
            status = 'active' AND
            result_idempotency_key IS NULL AND
            result_payload_fingerprint IS NULL AND
            result_transition_key IS NULL AND
            result_toolchain_json IS NULL AND
            failure_code IS NULL AND
            completed_at IS NULL
        ) OR (
            status = 'staged' AND
            result_idempotency_key IS NOT NULL AND
            result_payload_fingerprint IS NOT NULL AND
            result_transition_key IS NULL AND
            result_toolchain_json IS NOT NULL AND
            failure_code IS NULL AND
            completed_at IS NOT NULL
        ) OR (
            status = 'failed' AND
            result_idempotency_key IS NOT NULL AND
            result_payload_fingerprint IS NOT NULL AND
            result_transition_key IS NOT NULL AND
            result_toolchain_json IS NULL AND
            failure_code IS NOT NULL AND
            completed_at IS NOT NULL
        )
    )
);

-- Reservation precedes the R2 write. If the Worker loses a response after the
-- object is created, an exact retry can recover the same server-owned key and
-- reconcile the immutable provider evidence without overwriting anything.
CREATE TABLE draft_processing_outputs (
    processing_run_id TEXT NOT NULL,
    role TEXT NOT NULL
        CHECK (role IN ('photo-display', 'photo-thumbnail')),
    upload_idempotency_key TEXT NOT NULL
        CHECK (
            length(upload_idempotency_key) BETWEEN 16 AND 128 AND
            upload_idempotency_key NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
    upload_payload_fingerprint TEXT NOT NULL
        CHECK (
            length(upload_payload_fingerprint) = 64 AND
            upload_payload_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
    staging_object_key TEXT NOT NULL UNIQUE,
    sha256 TEXT NOT NULL
        CHECK (
            length(sha256) = 64 AND
            sha256 NOT GLOB '*[^0-9a-f]*'
        ),
    byte_count INTEGER NOT NULL,
    content_type TEXT NOT NULL
        CHECK (content_type = 'image/webp'),
    width INTEGER NOT NULL CHECK (width > 0),
    height INTEGER NOT NULL CHECK (height > 0),
    status TEXT NOT NULL DEFAULT 'reserved'
        CHECK (status IN ('reserved', 'stored', 'verified')),
    staging_object_version TEXT
        CHECK (
            staging_object_version IS NULL OR
            length(staging_object_version) BETWEEN 1 AND 256
        ),
    staging_etag TEXT
        CHECK (
            staging_etag IS NULL OR
            length(staging_etag) BETWEEN 1 AND 256
        ),
    metadata_scan_json TEXT
        CHECK (
            metadata_scan_json IS NULL OR
            metadata_scan_json =
                '{"schemaVersion":"1.0","scannerName":"exiftool","scannerVersion":"13.40","metadataEntryCount":0,"findingCategories":[]}'
        ),
    scanner_version TEXT
        CHECK (
            scanner_version IS NULL OR scanner_version = '13.40'
        ),
    created_at TEXT NOT NULL,
    stored_at TEXT,
    verified_at TEXT,
    PRIMARY KEY (processing_run_id, role),
    FOREIGN KEY (processing_run_id)
        REFERENCES draft_processing_runs(processing_run_id)
        ON DELETE CASCADE,
    CHECK (
        (
            role = 'photo-display' AND
            byte_count BETWEEN 1 AND 26214400 AND
            width <= 1600 AND height <= 1600
        ) OR (
            role = 'photo-thumbnail' AND
            byte_count BETWEEN 1 AND 5242880 AND
            width <= 480 AND height <= 480
        )
    ),
    CHECK (
        (
            status = 'reserved' AND
            staging_object_version IS NULL AND
            staging_etag IS NULL AND
            metadata_scan_json IS NULL AND
            scanner_version IS NULL AND
            stored_at IS NULL AND
            verified_at IS NULL
        ) OR (
            status = 'stored' AND
            staging_object_version IS NOT NULL AND
            staging_etag IS NOT NULL AND
            metadata_scan_json IS NULL AND
            scanner_version IS NULL AND
            stored_at IS NOT NULL AND
            verified_at IS NULL
        ) OR (
            status = 'verified' AND
            staging_object_version IS NOT NULL AND
            staging_etag IS NOT NULL AND
            metadata_scan_json IS NOT NULL AND
            scanner_version IS NOT NULL AND
            stored_at IS NOT NULL AND
            verified_at IS NOT NULL
        )
    )
);

CREATE UNIQUE INDEX draft_processing_runs_current_index
    ON draft_processing_runs(draft_id)
    WHERE status IN ('active', 'staged');

CREATE INDEX draft_processing_runs_status_index
    ON draft_processing_runs(status, updated_at);

CREATE TRIGGER draft_processing_runs_no_replace_guard
BEFORE INSERT ON draft_processing_runs
WHEN EXISTS (
    SELECT 1 FROM draft_processing_runs AS existing
    WHERE existing.processing_run_id = NEW.processing_run_id OR (
        existing.draft_id = NEW.draft_id AND
        existing.start_idempotency_key = NEW.start_idempotency_key
    )
)
BEGIN
    SELECT RAISE(ABORT, 'processing run replacement is forbidden');
END;

CREATE TRIGGER draft_processing_outputs_no_replace_guard
BEFORE INSERT ON draft_processing_outputs
WHEN EXISTS (
    SELECT 1 FROM draft_processing_outputs AS existing
    WHERE (
        existing.processing_run_id = NEW.processing_run_id AND
        existing.role = NEW.role
    ) OR existing.staging_object_key = NEW.staging_object_key
)
BEGIN
    SELECT RAISE(ABORT, 'processing output replacement is forbidden');
END;

CREATE TRIGGER draft_processing_runs_insert_guard
BEFORE INSERT ON draft_processing_runs
WHEN NOT EXISTS (
    SELECT 1
    FROM gallery_drafts AS draft
    JOIN draft_consent_attestations AS consent
      ON consent.draft_id = draft.draft_id
     AND consent.consent_revision = draft.active_consent_revision
    JOIN draft_upload_sessions AS upload
      ON upload.upload_session_id = NEW.upload_session_id
     AND upload.draft_id = draft.draft_id
    WHERE draft.draft_id = NEW.draft_id
      AND NEW.status = 'active'
      AND draft.state = 'processing'
      AND draft.state_version = NEW.processing_state_version
      AND NEW.processing_state_version = NEW.start_expected_state_version + 1
      AND draft.site_modes_json = json_array(NEW.site_mode)
      AND draft.media_type = NEW.media_type
      AND draft.media_type = 'photo'
      AND draft.upload_complete = 1
      AND draft.item_revision = NEW.item_revision
      AND draft.active_consent_revision = NEW.consent_revision
      AND draft.export_bundle_id = NEW.export_bundle_id
      AND draft.source_revision = NEW.source_revision
      AND draft.suppression_revision = NEW.suppression_revision
      AND draft.original_object_key = NEW.original_object_key
      AND draft.original_detected_type = NEW.original_detected_type
      AND draft.original_byte_count = NEW.original_byte_count
      AND draft.original_sha256 = NEW.original_sha256
      AND consent.public_use_confirmed = 1
      AND (consent.contains_minors = 0 OR consent.guardian_approval_confirmed = 1)
      AND consent.withdrawn_at IS NULL
      AND upload.status = 'complete'
      AND upload.synthetic_only_confirmed = 1
      AND upload.item_revision = NEW.item_revision
      AND upload.consent_revision = NEW.consent_revision
      AND upload.export_bundle_id = NEW.export_bundle_id
      AND upload.source_revision = NEW.source_revision
      AND upload.suppression_revision = NEW.suppression_revision
      AND upload.object_key = NEW.original_object_key
      AND upload.detected_format = NEW.original_detected_type
      AND upload.declared_content_type = NEW.original_declared_content_type
      AND upload.declared_byte_count = NEW.original_byte_count
      AND upload.completed_sha256 = NEW.original_sha256
      AND upload.completed_object_version = NEW.original_object_version
      AND upload.completed_etag = NEW.original_etag
      AND NOT EXISTS (
          SELECT 1 FROM draft_derivatives AS derivative
          WHERE derivative.draft_id = draft.draft_id
      )
      AND NOT EXISTS (
          SELECT 1
          FROM json_each(draft.athlete_ids_json) AS tag
          JOIN pending_athlete_exclusions AS exclusion
            ON exclusion.athlete_id = tag.value
          WHERE exclusion.resolved_at IS NULL
      )
)
BEGIN
    SELECT RAISE(ABORT, 'processing run lacks current approved private evidence');
END;

CREATE TRIGGER draft_processing_runs_identity_update_guard
BEFORE UPDATE OF
    processing_run_id,
    draft_id,
    site_mode,
    media_type,
    item_revision,
    consent_revision,
    export_bundle_id,
    source_revision,
    suppression_revision,
    upload_session_id,
    original_object_key,
    original_detected_type,
    original_declared_content_type,
    original_byte_count,
    original_sha256,
    original_object_version,
    original_etag,
    start_expected_state_version,
    processing_state_version,
    start_idempotency_key,
    start_payload_fingerprint,
    service_actor_identity_hash,
    created_at
ON draft_processing_runs
WHEN
    NEW.processing_run_id IS NOT OLD.processing_run_id OR
    NEW.draft_id IS NOT OLD.draft_id OR
    NEW.site_mode IS NOT OLD.site_mode OR
    NEW.media_type IS NOT OLD.media_type OR
    NEW.item_revision IS NOT OLD.item_revision OR
    NEW.consent_revision IS NOT OLD.consent_revision OR
    NEW.export_bundle_id IS NOT OLD.export_bundle_id OR
    NEW.source_revision IS NOT OLD.source_revision OR
    NEW.suppression_revision IS NOT OLD.suppression_revision OR
    NEW.upload_session_id IS NOT OLD.upload_session_id OR
    NEW.original_object_key IS NOT OLD.original_object_key OR
    NEW.original_detected_type IS NOT OLD.original_detected_type OR
    NEW.original_declared_content_type IS NOT OLD.original_declared_content_type OR
    NEW.original_byte_count IS NOT OLD.original_byte_count OR
    NEW.original_sha256 IS NOT OLD.original_sha256 OR
    NEW.original_object_version IS NOT OLD.original_object_version OR
    NEW.original_etag IS NOT OLD.original_etag OR
    NEW.start_expected_state_version IS NOT OLD.start_expected_state_version OR
    NEW.processing_state_version IS NOT OLD.processing_state_version OR
    NEW.start_idempotency_key IS NOT OLD.start_idempotency_key OR
    NEW.start_payload_fingerprint IS NOT OLD.start_payload_fingerprint OR
    NEW.service_actor_identity_hash IS NOT OLD.service_actor_identity_hash OR
    NEW.created_at IS NOT OLD.created_at
BEGIN
    SELECT RAISE(ABORT, 'processing run identity is immutable');
END;

CREATE TRIGGER draft_processing_runs_status_guard
BEFORE UPDATE OF
    status,
    result_idempotency_key,
    result_payload_fingerprint,
    result_transition_key,
    result_toolchain_json,
    failure_code,
    updated_at,
    completed_at
ON draft_processing_runs
WHEN NOT (
    OLD.status = 'active' AND
    NEW.status IN ('staged', 'failed') AND
    NEW.result_idempotency_key IS NOT NULL AND
    NEW.result_payload_fingerprint IS NOT NULL AND
    NEW.updated_at > OLD.updated_at AND
    NEW.completed_at = NEW.updated_at AND
    (
        (
            NEW.status = 'staged' AND
            NEW.result_transition_key IS NULL AND
            NEW.result_toolchain_json IS NOT NULL AND
            NEW.failure_code IS NULL AND
            EXISTS (
                SELECT 1
                FROM gallery_drafts AS draft
                JOIN draft_consent_attestations AS consent
                  ON consent.draft_id = draft.draft_id
                 AND consent.consent_revision = draft.active_consent_revision
                WHERE draft.draft_id = OLD.draft_id
                  AND draft.state = 'processing'
                  AND draft.state_version = OLD.processing_state_version
                  AND draft.item_revision = OLD.item_revision
                  AND draft.active_consent_revision = OLD.consent_revision
                  AND draft.export_bundle_id = OLD.export_bundle_id
                  AND draft.source_revision = OLD.source_revision
                  AND draft.suppression_revision = OLD.suppression_revision
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
            ) AND
            (SELECT COUNT(*) FROM draft_processing_outputs AS output
                WHERE output.processing_run_id = OLD.processing_run_id
                  AND output.status = 'verified') = 2 AND
            (SELECT COUNT(*) FROM draft_processing_outputs AS output
                WHERE output.processing_run_id = OLD.processing_run_id
                  AND output.status = 'verified'
                  AND output.role IN ('photo-display', 'photo-thumbnail')) = 2 AND
            (SELECT COUNT(*) FROM draft_derivatives AS derivative
                WHERE derivative.draft_id = OLD.draft_id
                  AND derivative.role IN ('photo-display', 'photo-thumbnail')
                  AND derivative.staging_object_key IS NOT NULL
                  AND derivative.approved_object_key IS NULL) = 2
        ) OR (
            NEW.status = 'failed' AND
            NEW.result_transition_key IS NOT NULL AND
            NEW.result_toolchain_json IS NULL AND
            NEW.failure_code IS NOT NULL AND
            NOT EXISTS (
                SELECT 1 FROM draft_derivatives AS derivative
                WHERE derivative.draft_id = OLD.draft_id
            )
        )
    )
)
BEGIN
    SELECT RAISE(ABORT, 'invalid processing run result transition');
END;

CREATE TRIGGER draft_processing_runs_failed_draft_guard
BEFORE UPDATE OF status ON draft_processing_runs
WHEN NEW.status = 'failed' AND NOT EXISTS (
    SELECT 1 FROM gallery_drafts AS draft
    WHERE draft.draft_id = OLD.draft_id
      AND draft.state = 'processing-failed'
      AND draft.state_version = OLD.processing_state_version + 1
)
BEGIN
    SELECT RAISE(ABORT, 'failed processing result requires its atomic draft transition');
END;

CREATE TRIGGER gallery_drafts_processing_failure_active_run_guard
BEFORE UPDATE OF state ON gallery_drafts
WHEN OLD.state = 'processing' AND NEW.state = 'processing-failed' AND NOT EXISTS (
    SELECT 1 FROM draft_processing_runs AS run
    WHERE run.draft_id = OLD.draft_id
      AND run.status = 'active'
      AND run.processing_state_version = OLD.state_version
      AND run.item_revision = OLD.item_revision
      AND run.consent_revision = OLD.active_consent_revision
      AND run.export_bundle_id = OLD.export_bundle_id
      AND run.source_revision = OLD.source_revision
      AND run.suppression_revision = OLD.suppression_revision
      AND NOT EXISTS (
          SELECT 1 FROM draft_derivatives AS derivative
          WHERE derivative.draft_id = OLD.draft_id
      )
)
BEGIN
    SELECT RAISE(ABORT, 'processing failure requires the exact active run');
END;

CREATE TRIGGER draft_transition_receipts_processing_failure_guard
BEFORE INSERT ON draft_transition_receipts
WHEN NEW.from_state = 'processing' AND NEW.to_state = 'processing-failed' AND NOT EXISTS (
    SELECT 1
    FROM draft_processing_runs AS run
    JOIN gallery_drafts AS draft ON draft.draft_id = run.draft_id
    WHERE run.draft_id = NEW.draft_id
      AND run.status = 'failed'
      AND run.processing_state_version = NEW.expected_state_version
      AND run.result_transition_key = NEW.idempotency_key
      AND run.result_payload_fingerprint = NEW.payload_fingerprint
      AND draft.state = 'processing-failed'
      AND draft.state_version = NEW.result_state_version
      AND run.completed_at IS NOT NULL
)
BEGIN
    SELECT RAISE(ABORT, 'processing failure receipt lacks the exact failed run');
END;

CREATE TRIGGER draft_processing_runs_terminal_update_guard
BEFORE UPDATE ON draft_processing_runs
WHEN OLD.status <> 'active'
BEGIN
    SELECT RAISE(ABORT, 'completed processing run is immutable');
END;

CREATE TRIGGER draft_processing_runs_direct_delete_guard
BEFORE DELETE ON draft_processing_runs
WHEN EXISTS (
    SELECT 1 FROM gallery_drafts AS parent
    WHERE parent.draft_id = OLD.draft_id
)
BEGIN
    SELECT RAISE(ABORT, 'processing run direct deletion is forbidden; approved draft purge only');
END;

CREATE TRIGGER draft_processing_outputs_insert_guard
BEFORE INSERT ON draft_processing_outputs
WHEN NOT EXISTS (
    SELECT 1
    FROM draft_processing_runs AS run
    JOIN gallery_drafts AS draft ON draft.draft_id = run.draft_id
    JOIN draft_consent_attestations AS consent
      ON consent.draft_id = draft.draft_id
     AND consent.consent_revision = draft.active_consent_revision
    WHERE run.processing_run_id = NEW.processing_run_id
      AND NEW.status = 'reserved'
      AND run.status = 'active'
      AND draft.state = 'processing'
      AND draft.state_version = run.processing_state_version
      AND draft.item_revision = run.item_revision
      AND draft.active_consent_revision = run.consent_revision
      AND draft.export_bundle_id = run.export_bundle_id
      AND draft.source_revision = run.source_revision
      AND draft.suppression_revision = run.suppression_revision
      AND consent.public_use_confirmed = 1
      AND (consent.contains_minors = 0 OR consent.guardian_approval_confirmed = 1)
      AND consent.withdrawn_at IS NULL
      AND NEW.content_type = 'image/webp'
      AND NEW.staging_object_key =
          'derivative-staging/v1/' || run.site_mode || '/' || run.draft_id || '/' ||
          run.processing_run_id || '/' || NEW.sha256 || '/' || CASE NEW.role
              WHEN 'photo-display' THEN 'display.webp'
              WHEN 'photo-thumbnail' THEN 'thumbnail.webp'
          END
      AND NOT EXISTS (
          SELECT 1
          FROM json_each(draft.athlete_ids_json) AS tag
          JOIN pending_athlete_exclusions AS exclusion
            ON exclusion.athlete_id = tag.value
          WHERE exclusion.resolved_at IS NULL
      )
)
BEGIN
    SELECT RAISE(ABORT, 'processing output lacks an active current run');
END;

CREATE TRIGGER draft_processing_outputs_identity_update_guard
BEFORE UPDATE OF
    processing_run_id,
    role,
    upload_idempotency_key,
    upload_payload_fingerprint,
    staging_object_key,
    sha256,
    byte_count,
    content_type,
    width,
    height,
    created_at
ON draft_processing_outputs
WHEN
    NEW.processing_run_id IS NOT OLD.processing_run_id OR
    NEW.role IS NOT OLD.role OR
    NEW.upload_idempotency_key IS NOT OLD.upload_idempotency_key OR
    NEW.upload_payload_fingerprint IS NOT OLD.upload_payload_fingerprint OR
    NEW.staging_object_key IS NOT OLD.staging_object_key OR
    NEW.sha256 IS NOT OLD.sha256 OR
    NEW.byte_count IS NOT OLD.byte_count OR
    NEW.content_type IS NOT OLD.content_type OR
    NEW.width IS NOT OLD.width OR
    NEW.height IS NOT OLD.height OR
    NEW.created_at IS NOT OLD.created_at
BEGIN
    SELECT RAISE(ABORT, 'processing output identity is immutable');
END;

CREATE TRIGGER draft_processing_outputs_status_guard
BEFORE UPDATE OF
    status,
    staging_object_version,
    staging_etag,
    metadata_scan_json,
    scanner_version,
    stored_at,
    verified_at
ON draft_processing_outputs
WHEN NOT (
    (
        OLD.status = 'reserved' AND
        NEW.status = 'stored' AND
        NEW.staging_object_version IS NOT NULL AND
        NEW.staging_etag IS NOT NULL AND
        NEW.metadata_scan_json IS NULL AND
        NEW.scanner_version IS NULL AND
        NEW.stored_at IS NOT NULL AND
        NEW.verified_at IS NULL AND
        EXISTS (
            SELECT 1
            FROM draft_processing_runs AS run
            JOIN gallery_drafts AS draft ON draft.draft_id = run.draft_id
            JOIN draft_consent_attestations AS consent
              ON consent.draft_id = draft.draft_id
             AND consent.consent_revision = draft.active_consent_revision
            WHERE run.processing_run_id = OLD.processing_run_id
              AND run.status = 'active'
              AND draft.state = 'processing'
              AND draft.state_version = run.processing_state_version
              AND draft.item_revision = run.item_revision
              AND draft.active_consent_revision = run.consent_revision
              AND draft.export_bundle_id = run.export_bundle_id
              AND draft.source_revision = run.source_revision
              AND draft.suppression_revision = run.suppression_revision
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
        )
    ) OR (
        OLD.status = 'stored' AND
        NEW.status = 'verified' AND
        NEW.staging_object_version IS OLD.staging_object_version AND
        NEW.staging_etag IS OLD.staging_etag AND
        NEW.metadata_scan_json IS NOT NULL AND
        NEW.scanner_version IS NOT NULL AND
        NEW.stored_at IS OLD.stored_at AND
        NEW.verified_at IS NOT NULL AND
        EXISTS (
            SELECT 1 FROM draft_processing_runs AS run
            WHERE run.processing_run_id = OLD.processing_run_id
              AND run.status = 'active'
        )
    )
)
BEGIN
    SELECT RAISE(ABORT, 'invalid processing output evidence transition');
END;

CREATE TRIGGER draft_processing_outputs_terminal_update_guard
BEFORE UPDATE ON draft_processing_outputs
WHEN OLD.status = 'verified'
BEGIN
    SELECT RAISE(ABORT, 'verified processing output is immutable');
END;

CREATE TRIGGER draft_processing_outputs_direct_delete_guard
BEFORE DELETE ON draft_processing_outputs
WHEN EXISTS (
    SELECT 1 FROM draft_processing_runs AS parent
    WHERE parent.processing_run_id = OLD.processing_run_id
)
BEGIN
    SELECT RAISE(ABORT, 'processing output direct deletion is forbidden; approved draft purge only');
END;

-- While processing is active, all editable facts stay bound to the exact
-- approval snapshot. A withdrawal can still move the whole item to its
-- dedicated state without mutating those facts.
CREATE TRIGGER gallery_drafts_processing_revision_change_guard
BEFORE UPDATE OF
    site_modes_json,
    media_type,
    item_revision,
    active_consent_revision,
    export_bundle_id,
    source_revision,
    suppression_revision,
    original_object_key,
    original_detected_type,
    original_byte_count,
    original_sha256
ON gallery_drafts
WHEN EXISTS (
    SELECT 1 FROM draft_processing_runs AS run
    WHERE run.draft_id = OLD.draft_id
      AND run.status IN ('active', 'staged', 'failed')
) AND (
    NEW.site_modes_json IS NOT OLD.site_modes_json OR
    NEW.media_type IS NOT OLD.media_type OR
    NEW.item_revision IS NOT OLD.item_revision OR
    NEW.active_consent_revision IS NOT OLD.active_consent_revision OR
    NEW.export_bundle_id IS NOT OLD.export_bundle_id OR
    NEW.source_revision IS NOT OLD.source_revision OR
    NEW.suppression_revision IS NOT OLD.suppression_revision OR
    NEW.original_object_key IS NOT OLD.original_object_key OR
    NEW.original_detected_type IS NOT OLD.original_detected_type OR
    NEW.original_byte_count IS NOT OLD.original_byte_count OR
    NEW.original_sha256 IS NOT OLD.original_sha256
) AND NOT (
    OLD.state = 'withdrawal-pending' AND
    NEW.state = 'withdrawal-pending' AND
    OLD.active_consent_revision IS NOT NULL AND
    NEW.active_consent_revision IS NULL AND
    NEW.site_modes_json IS OLD.site_modes_json AND
    NEW.media_type IS OLD.media_type AND
    NEW.item_revision IS OLD.item_revision AND
    NEW.export_bundle_id IS OLD.export_bundle_id AND
    NEW.source_revision IS OLD.source_revision AND
    NEW.suppression_revision IS OLD.suppression_revision AND
    NEW.original_object_key IS OLD.original_object_key AND
    NEW.original_detected_type IS OLD.original_detected_type AND
    NEW.original_byte_count IS OLD.original_byte_count AND
    NEW.original_sha256 IS OLD.original_sha256 AND
    EXISTS (
        SELECT 1
        FROM draft_consent_attestations AS consent
        JOIN draft_publication_references AS publication
          ON publication.draft_id = consent.draft_id
        WHERE consent.draft_id = OLD.draft_id
          AND consent.consent_revision = OLD.active_consent_revision
          AND consent.withdrawn_at IS NOT NULL
          AND publication.withdrawal_kind = 'consent-withdrawal'
          AND publication.host_deletion_confirmed = 1
          AND publication.private_original_deletion_confirmed = 1
    ) AND
    NOT EXISTS (
        SELECT 1 FROM draft_derivatives AS derivative
        WHERE derivative.draft_id = OLD.draft_id
    ) AND
    NOT EXISTS (
        SELECT 1
        FROM draft_processing_outputs AS output
        JOIN draft_processing_runs AS run
          ON run.processing_run_id = output.processing_run_id
        WHERE run.draft_id = OLD.draft_id
    )
)
BEGIN
    SELECT RAISE(ABORT, 'processing evidence must be resolved before bound facts change');
END;

-- From this migration onward, staging derivative rows can only be copied from
-- the verified output ledger for the same active run and exact revision set.
CREATE TRIGGER draft_derivatives_processing_output_guard
BEFORE INSERT ON draft_derivatives
WHEN NOT EXISTS (
    SELECT 1
    FROM draft_processing_runs AS run
    JOIN draft_processing_outputs AS output
      ON output.processing_run_id = run.processing_run_id
     AND output.role = NEW.role
    WHERE run.draft_id = NEW.draft_id
      AND run.status = 'active'
      AND output.status = 'verified'
      AND run.item_revision = NEW.item_revision
      AND run.consent_revision = NEW.consent_revision
      AND run.export_bundle_id = NEW.export_bundle_id
      AND run.source_revision = NEW.source_revision
      AND run.suppression_revision = NEW.suppression_revision
      AND output.staging_object_key = NEW.staging_object_key
      AND output.sha256 = NEW.sha256
      AND output.byte_count = NEW.byte_count
      AND output.content_type = NEW.content_type
      AND output.width = NEW.width
      AND output.height = NEW.height
      AND output.metadata_scan_json = NEW.metadata_scan_json
      AND output.scanner_version = NEW.scanner_version
      AND output.verified_at = NEW.verified_at
      AND NEW.duration_milliseconds IS NULL
      AND NEW.host_deleted_at IS NULL
      AND NEW.approved_object_key IS NULL
)
BEGIN
    SELECT RAISE(ABORT, 'derivative evidence lacks a verified processing output');
END;

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
)
BEGIN
    SELECT RAISE(ABORT, 'verified processing derivative evidence is immutable');
END;

CREATE TRIGGER draft_derivatives_processing_delete_guard
BEFORE DELETE ON draft_derivatives
WHEN EXISTS (
    SELECT 1 FROM gallery_drafts AS parent WHERE parent.draft_id = OLD.draft_id
) AND EXISTS (
    SELECT 1
    FROM draft_processing_runs AS run
    JOIN draft_processing_outputs AS output
      ON output.processing_run_id = run.processing_run_id
     AND output.role = OLD.role
    WHERE run.draft_id = OLD.draft_id
      AND output.staging_object_key = OLD.staging_object_key
)
BEGIN
    SELECT RAISE(ABORT, 'processing derivative deletion is unavailable before race-safe staging cleanup');
END;

-- This bridge cannot advance public state. A future promotion migration must
-- replace this absolute stop with exact approved-object and manifest evidence.
CREATE TRIGGER gallery_drafts_candidate_processing_guard
BEFORE UPDATE OF state ON gallery_drafts
WHEN NEW.state = 'candidate-public' AND OLD.state <> 'candidate-public'
BEGIN
    SELECT RAISE(ABORT, 'candidate publication is unavailable before approved promotion evidence');
END;

CREATE TRIGGER gallery_drafts_phase_d_purge_object_guard
BEFORE DELETE ON gallery_drafts
WHEN EXISTS (
    SELECT 1
    FROM draft_processing_outputs AS output
    JOIN draft_processing_runs AS run
      ON run.processing_run_id = output.processing_run_id
    WHERE run.draft_id = OLD.draft_id
)
BEGIN
    SELECT RAISE(ABORT, 'gallery draft purge is unavailable before race-safe staging cleanup');
END;

PRAGMA foreign_key_check;
