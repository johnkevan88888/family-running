PRAGMA foreign_keys = ON;

-- A derivative is uploaded as one private multipart upload. Creating the
-- multipart upload stores no media bytes; its exact provider ID must be
-- committed here before any part may be sent. Cleanup can therefore close D1,
-- abort every admitted provider upload, and know that no later completion can
-- recreate an object after verified deletion.
CREATE TABLE draft_processing_multipart_uploads (
    processing_run_id TEXT NOT NULL,
    role TEXT NOT NULL
        CHECK (role IN ('photo-display', 'photo-thumbnail')),
    staging_object_key TEXT NOT NULL UNIQUE,
    upload_payload_fingerprint TEXT NOT NULL
        CHECK (
            length(upload_payload_fingerprint) = 64 AND
            upload_payload_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
    provider_upload_id TEXT NOT NULL UNIQUE
        CHECK (length(provider_upload_id) BETWEEN 1 AND 512),
    provider_upload_id_hash TEXT NOT NULL UNIQUE
        CHECK (
            length(provider_upload_id_hash) = 64 AND
            provider_upload_id_hash NOT GLOB '*[^0-9a-f]*'
        ),
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'part-uploaded', 'terminal')),
    provider_part_etag TEXT
        CHECK (
            provider_part_etag IS NULL OR
            length(provider_part_etag) BETWEEN 1 AND 256
        ),
    terminal_kind TEXT
        CHECK (
            terminal_kind IS NULL OR
            terminal_kind IN ('completed', 'aborted', 'not-found')
        ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    part_uploaded_at TEXT,
    terminal_at TEXT,
    PRIMARY KEY (processing_run_id, role),
    FOREIGN KEY (processing_run_id, role)
        REFERENCES draft_processing_outputs(processing_run_id, role)
        ON DELETE CASCADE,
    CHECK (created_at <= updated_at),
    CHECK (
        (
            status = 'open' AND
            provider_part_etag IS NULL AND
            terminal_kind IS NULL AND
            part_uploaded_at IS NULL AND
            terminal_at IS NULL
        ) OR (
            status = 'part-uploaded' AND
            provider_part_etag IS NOT NULL AND
            terminal_kind IS NULL AND
            part_uploaded_at IS NOT NULL AND
            terminal_at IS NULL
        ) OR (
            status = 'terminal' AND
            terminal_kind IS NOT NULL AND
            terminal_at IS NOT NULL AND
            (
                (
                    terminal_kind = 'completed' AND
                    provider_part_etag IS NOT NULL AND
                    part_uploaded_at IS NOT NULL
                ) OR terminal_kind IN ('aborted', 'not-found')
            )
        )
    )
);

CREATE TABLE draft_processing_cleanups (
    cleanup_id TEXT PRIMARY KEY
        CHECK (
            length(cleanup_id) = 40 AND
            substr(cleanup_id, 1, 8) = 'cleanup_' AND
            substr(cleanup_id, 9) NOT GLOB '*[^0-9a-f]*' AND
            substr(cleanup_id, 21, 1) = '4' AND
            substr(cleanup_id, 25, 1) IN ('8', '9', 'a', 'b')
        ),
    cleanup_id_hash TEXT NOT NULL UNIQUE
        CHECK (
            length(cleanup_id_hash) = 64 AND
            cleanup_id_hash NOT GLOB '*[^0-9a-f]*'
        ),
    processing_run_id TEXT NOT NULL UNIQUE,
    processing_run_id_hash TEXT NOT NULL UNIQUE
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
            'processing-failed',
            'withdrawal'
        )),
    expected_state_version INTEGER NOT NULL
        CHECK (expected_state_version >= 0),
    output_count INTEGER NOT NULL
        CHECK (output_count BETWEEN 0 AND 2),
    idempotency_key TEXT NOT NULL
        CHECK (
            length(idempotency_key) BETWEEN 16 AND 128 AND
            idempotency_key NOT GLOB '*[^A-Za-z0-9_-]*'
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
    cleanup_evidence_hash TEXT
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
    UNIQUE (cleanup_evidence_hash),
    CHECK (created_at <= updated_at),
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

CREATE TABLE draft_processing_cleanup_objects (
    cleanup_id TEXT NOT NULL,
    role TEXT NOT NULL
        CHECK (role IN ('photo-display', 'photo-thumbnail')),
    staging_object_key TEXT,
    staging_object_key_hash TEXT NOT NULL
        CHECK (
            length(staging_object_key_hash) = 64 AND
            staging_object_key_hash NOT GLOB '*[^0-9a-f]*'
        ),
    expected_sha256 TEXT NOT NULL
        CHECK (
            length(expected_sha256) = 64 AND
            expected_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
    expected_byte_count INTEGER NOT NULL CHECK (expected_byte_count > 0),
    expected_object_version_hash TEXT
        CHECK (
            expected_object_version_hash IS NULL OR (
                length(expected_object_version_hash) = 64 AND
                expected_object_version_hash NOT GLOB '*[^0-9a-f]*'
            )
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
            provider_terminal_kind IN ('completed', 'aborted', 'not-found')
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
        CHECK (status IN ('pending', 'absent')),
    deleted_at TEXT,
    absence_verified_at TEXT,
    PRIMARY KEY (cleanup_id, role),
    FOREIGN KEY (cleanup_id)
        REFERENCES draft_processing_cleanups(cleanup_id)
        ON DELETE CASCADE,
    CHECK (
        (expected_object_version_hash IS NULL AND expected_etag_hash IS NULL) OR
        (expected_object_version_hash IS NOT NULL AND expected_etag_hash IS NOT NULL)
    ),
    CHECK (
        (
            observed_object_version_hash IS NULL AND
            observed_etag_hash IS NULL AND
            deleted_at IS NULL
        ) OR (
            observed_object_version_hash IS NOT NULL AND
            observed_etag_hash IS NOT NULL AND
            deleted_at IS NOT NULL
        )
    ),
    CHECK (deleted_at IS NULL OR deleted_at <= absence_verified_at),
    CHECK (
        (
            status = 'pending' AND
            staging_object_key IS NOT NULL AND
            provider_terminal_kind IS NULL AND
            observed_object_version_hash IS NULL AND
            observed_etag_hash IS NULL AND
            deleted_at IS NULL AND
            absence_verified_at IS NULL
        ) OR (
            status = 'absent' AND
            staging_object_key IS NULL AND
            provider_terminal_kind IS NOT NULL AND
            absence_verified_at IS NOT NULL
        )
    )
);

-- This table deliberately has no draft/run foreign key. It is the minimal
-- hash-only commitment that survives an approved private-record purge.
CREATE TABLE gallery_processing_cleanup_tombstones (
    cleanup_id_hash TEXT PRIMARY KEY
        CHECK (
            length(cleanup_id_hash) = 64 AND
            cleanup_id_hash NOT GLOB '*[^0-9a-f]*'
        ),
    draft_id_hash TEXT NOT NULL
        CHECK (
            length(draft_id_hash) = 64 AND
            draft_id_hash NOT GLOB '*[^0-9a-f]*'
        ),
    processing_run_id_hash TEXT NOT NULL UNIQUE
        CHECK (
            length(processing_run_id_hash) = 64 AND
            processing_run_id_hash NOT GLOB '*[^0-9a-f]*'
        ),
    cleanup_reason TEXT NOT NULL
        CHECK (cleanup_reason IN (
            'athlete-exclusion',
            'processing-failed',
            'withdrawal'
        )),
    evidence_hash TEXT NOT NULL
        UNIQUE
        CHECK (
            length(evidence_hash) = 64 AND
            evidence_hash NOT GLOB '*[^0-9a-f]*'
        ),
    completed_at TEXT NOT NULL
);

CREATE INDEX draft_processing_cleanups_status_index
    ON draft_processing_cleanups(status, updated_at);

CREATE TRIGGER draft_processing_multipart_uploads_no_replace_guard
BEFORE INSERT ON draft_processing_multipart_uploads
WHEN EXISTS (
    SELECT 1 FROM draft_processing_multipart_uploads AS existing
    WHERE (
        existing.processing_run_id = NEW.processing_run_id AND
        existing.role = NEW.role
    ) OR existing.staging_object_key = NEW.staging_object_key
      OR existing.provider_upload_id = NEW.provider_upload_id
      OR existing.provider_upload_id_hash = NEW.provider_upload_id_hash
)
BEGIN
    SELECT RAISE(ABORT, 'processing multipart replacement is forbidden');
END;

CREATE TRIGGER draft_processing_multipart_uploads_insert_guard
BEFORE INSERT ON draft_processing_multipart_uploads
WHEN NOT EXISTS (
    SELECT 1
    FROM draft_processing_outputs AS output
    JOIN draft_processing_runs AS run
      ON run.processing_run_id = output.processing_run_id
    JOIN gallery_drafts AS draft ON draft.draft_id = run.draft_id
    WHERE output.processing_run_id = NEW.processing_run_id
      AND output.role = NEW.role
      AND output.status = 'reserved'
      AND output.staging_object_key = NEW.staging_object_key
      AND output.upload_payload_fingerprint = NEW.upload_payload_fingerprint
      AND run.status = 'active'
      AND draft.state = 'processing'
      AND draft.state_version = run.processing_state_version
      AND draft.item_revision = run.item_revision
      AND draft.active_consent_revision = run.consent_revision
      AND draft.export_bundle_id = run.export_bundle_id
      AND draft.source_revision = run.source_revision
      AND draft.suppression_revision = run.suppression_revision
      AND NEW.status = 'open'
      AND NOT EXISTS (
          SELECT 1 FROM draft_processing_cleanups AS cleanup
          WHERE cleanup.processing_run_id = run.processing_run_id
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
    SELECT RAISE(ABORT, 'processing multipart upload lacks an open current run');
END;

CREATE TRIGGER draft_processing_multipart_uploads_identity_update_guard
BEFORE UPDATE OF
    processing_run_id,
    role,
    staging_object_key,
    upload_payload_fingerprint,
    provider_upload_id,
    provider_upload_id_hash,
    created_at
ON draft_processing_multipart_uploads
WHEN
    NEW.processing_run_id IS NOT OLD.processing_run_id OR
    NEW.role IS NOT OLD.role OR
    NEW.staging_object_key IS NOT OLD.staging_object_key OR
    NEW.upload_payload_fingerprint IS NOT OLD.upload_payload_fingerprint OR
    NEW.provider_upload_id IS NOT OLD.provider_upload_id OR
    NEW.provider_upload_id_hash IS NOT OLD.provider_upload_id_hash OR
    NEW.created_at IS NOT OLD.created_at
BEGIN
    SELECT RAISE(ABORT, 'processing multipart identity is immutable');
END;

CREATE TRIGGER draft_processing_multipart_uploads_status_guard
BEFORE UPDATE OF
    status,
    provider_part_etag,
    terminal_kind,
    updated_at,
    part_uploaded_at,
    terminal_at
ON draft_processing_multipart_uploads
WHEN NOT (
    (
        OLD.status = 'open' AND
        NEW.status = 'part-uploaded' AND
        NEW.provider_part_etag IS NOT NULL AND
        NEW.terminal_kind IS NULL AND
        NEW.part_uploaded_at IS NOT NULL AND
        NEW.terminal_at IS NULL AND
        NEW.updated_at > OLD.updated_at AND
        NOT EXISTS (
            SELECT 1 FROM draft_processing_cleanups AS cleanup
            WHERE cleanup.processing_run_id = OLD.processing_run_id
        )
    ) OR (
        OLD.status = 'part-uploaded' AND
        NEW.status = 'terminal' AND
        NEW.terminal_kind = 'completed' AND
        NEW.provider_part_etag IS OLD.provider_part_etag AND
        NEW.part_uploaded_at IS OLD.part_uploaded_at AND
        NEW.terminal_at IS NOT NULL AND
        NEW.updated_at > OLD.updated_at AND
        EXISTS (
            SELECT 1 FROM draft_processing_outputs AS output
            WHERE output.processing_run_id = OLD.processing_run_id
              AND output.role = OLD.role
              AND output.status = 'stored'
        ) AND
        NOT EXISTS (
            SELECT 1 FROM draft_processing_cleanups AS cleanup
            WHERE cleanup.processing_run_id = OLD.processing_run_id
        )
    ) OR (
        OLD.status = 'part-uploaded' AND
        NEW.status = 'terminal' AND
        NEW.terminal_kind = 'completed' AND
        NEW.provider_part_etag IS OLD.provider_part_etag AND
        NEW.part_uploaded_at IS OLD.part_uploaded_at AND
        NEW.terminal_at IS NOT NULL AND
        NEW.updated_at > OLD.updated_at AND
        EXISTS (
            SELECT 1 FROM draft_processing_cleanups AS cleanup
            WHERE cleanup.processing_run_id = OLD.processing_run_id
              AND cleanup.status IN ('closing', 'deleting')
        )
    ) OR (
        OLD.status IN ('open', 'part-uploaded') AND
        NEW.status = 'terminal' AND
        NEW.terminal_kind IN ('aborted', 'not-found') AND
        (
            (
                OLD.status = 'open' AND
                NEW.provider_part_etag IS NULL AND
                NEW.part_uploaded_at IS NULL
            ) OR (
                OLD.status = 'part-uploaded' AND
                NEW.provider_part_etag IS OLD.provider_part_etag AND
                NEW.part_uploaded_at IS OLD.part_uploaded_at
            )
        ) AND
        NEW.terminal_at IS NOT NULL AND
        NEW.updated_at > OLD.updated_at AND
        EXISTS (
            SELECT 1 FROM draft_processing_cleanups AS cleanup
            WHERE cleanup.processing_run_id = OLD.processing_run_id
              AND cleanup.status IN ('closing', 'deleting')
        )
    )
)
BEGIN
    SELECT RAISE(ABORT, 'invalid processing multipart transition');
END;

CREATE TRIGGER draft_processing_multipart_uploads_terminal_update_guard
BEFORE UPDATE ON draft_processing_multipart_uploads
WHEN OLD.status = 'terminal'
BEGIN
    SELECT RAISE(ABORT, 'terminal processing multipart evidence is immutable');
END;

-- The output ledger cannot use the older direct-object-write path after this
-- migration. A stored output must come from its exact persisted, part-uploaded
-- multipart handle; verification waits until that same handle is terminally
-- completed. The order remains acyclic:
-- part-uploaded -> output stored -> multipart completed -> output verified.
CREATE TRIGGER draft_processing_outputs_multipart_transition_guard
BEFORE UPDATE OF status ON draft_processing_outputs
WHEN (
    OLD.status = 'reserved' AND
    NEW.status = 'stored' AND
    NOT EXISTS (
        SELECT 1
        FROM draft_processing_multipart_uploads AS upload
        WHERE upload.processing_run_id = OLD.processing_run_id
          AND upload.role = OLD.role
          AND upload.staging_object_key = OLD.staging_object_key
          AND upload.upload_payload_fingerprint = OLD.upload_payload_fingerprint
          AND upload.status = 'part-uploaded'
    )
) OR (
    OLD.status = 'stored' AND
    NEW.status = 'verified' AND
    NOT EXISTS (
        SELECT 1
        FROM draft_processing_multipart_uploads AS upload
        WHERE upload.processing_run_id = OLD.processing_run_id
          AND upload.role = OLD.role
          AND upload.staging_object_key = OLD.staging_object_key
          AND upload.upload_payload_fingerprint = OLD.upload_payload_fingerprint
          AND upload.status = 'terminal'
          AND upload.terminal_kind = 'completed'
    )
)
BEGIN
    SELECT RAISE(ABORT, 'processing output transition lacks its exact completed multipart evidence');
END;

CREATE TRIGGER draft_processing_cleanups_no_replace_guard
BEFORE INSERT ON draft_processing_cleanups
WHEN EXISTS (
    SELECT 1 FROM draft_processing_cleanups AS existing
    WHERE existing.cleanup_id = NEW.cleanup_id
       OR existing.processing_run_id = NEW.processing_run_id
       OR existing.cleanup_id_hash = NEW.cleanup_id_hash
       OR existing.processing_run_id_hash = NEW.processing_run_id_hash
       OR (
           existing.draft_id = NEW.draft_id AND
           existing.draft_id_hash <> NEW.draft_id_hash
       )
       OR (
           existing.draft_id <> NEW.draft_id AND
           existing.draft_id_hash = NEW.draft_id_hash
       )
)
BEGIN
    SELECT RAISE(ABORT, 'processing cleanup replacement is forbidden');
END;

CREATE TRIGGER draft_processing_cleanups_insert_guard
BEFORE INSERT ON draft_processing_cleanups
WHEN NOT EXISTS (
    SELECT 1
    FROM draft_processing_runs AS run
    JOIN gallery_drafts AS draft ON draft.draft_id = run.draft_id
    WHERE run.processing_run_id = NEW.processing_run_id
      AND run.draft_id = NEW.draft_id
      AND draft.state_version = NEW.expected_state_version
      AND NEW.output_count = (
          SELECT COUNT(*) FROM draft_processing_outputs AS output
          WHERE output.processing_run_id = run.processing_run_id
      )
      AND NEW.status = 'closing'
      AND (
          (
              NEW.cleanup_reason = 'processing-failed' AND
              run.status = 'failed' AND
              draft.state = 'processing-failed'
          ) OR (
              NEW.cleanup_reason = 'withdrawal' AND
              draft.state = 'withdrawal-pending' AND
              NOT EXISTS (
                  SELECT 1
                  FROM json_each(draft.athlete_ids_json) AS tag
                  JOIN pending_athlete_exclusions AS exclusion
                    ON exclusion.athlete_id = tag.value
                  WHERE exclusion.resolved_at IS NULL
              )
          ) OR (
              NEW.cleanup_reason = 'athlete-exclusion' AND
              draft.state IN ('processing', 'processing-failed', 'withdrawal-pending') AND
              EXISTS (
                  SELECT 1
                  FROM json_each(draft.athlete_ids_json) AS tag
                  JOIN pending_athlete_exclusions AS exclusion
                    ON exclusion.athlete_id = tag.value
                  WHERE exclusion.resolved_at IS NULL
              )
          )
      )
      AND NOT EXISTS (
          SELECT 1 FROM draft_derivatives AS derivative
          WHERE derivative.draft_id = draft.draft_id
            AND derivative.approved_object_key IS NOT NULL
      )
)
BEGIN
    SELECT RAISE(ABORT, 'processing cleanup lacks a current private-only reason');
END;

CREATE TRIGGER draft_processing_cleanups_identity_update_guard
BEFORE UPDATE OF
    cleanup_id,
    cleanup_id_hash,
    processing_run_id,
    processing_run_id_hash,
    draft_id,
    draft_id_hash,
    cleanup_reason,
    expected_state_version,
    output_count,
    idempotency_key,
    payload_fingerprint,
    service_actor_identity_hash,
    created_at
ON draft_processing_cleanups
WHEN
    NEW.cleanup_id IS NOT OLD.cleanup_id OR
    NEW.cleanup_id_hash IS NOT OLD.cleanup_id_hash OR
    NEW.processing_run_id IS NOT OLD.processing_run_id OR
    NEW.processing_run_id_hash IS NOT OLD.processing_run_id_hash OR
    NEW.draft_id IS NOT OLD.draft_id OR
    NEW.draft_id_hash IS NOT OLD.draft_id_hash OR
    NEW.cleanup_reason IS NOT OLD.cleanup_reason OR
    NEW.expected_state_version IS NOT OLD.expected_state_version OR
    NEW.output_count IS NOT OLD.output_count OR
    NEW.idempotency_key IS NOT OLD.idempotency_key OR
    NEW.payload_fingerprint IS NOT OLD.payload_fingerprint OR
    NEW.service_actor_identity_hash IS NOT OLD.service_actor_identity_hash OR
    NEW.created_at IS NOT OLD.created_at
BEGIN
    SELECT RAISE(ABORT, 'processing cleanup identity is immutable');
END;

-- Conflict-resolution syntax must not be able to delete another cleanup by
-- stealing its unique terminal evidence hash.
CREATE TRIGGER draft_processing_cleanups_evidence_collision_guard
BEFORE UPDATE OF cleanup_evidence_hash ON draft_processing_cleanups
WHEN NEW.cleanup_evidence_hash IS NOT OLD.cleanup_evidence_hash AND EXISTS (
    SELECT 1 FROM draft_processing_cleanups AS existing
    WHERE existing.cleanup_id <> OLD.cleanup_id
      AND existing.cleanup_evidence_hash = NEW.cleanup_evidence_hash
)
BEGIN
    SELECT RAISE(ABORT, 'processing cleanup evidence replacement is forbidden');
END;

CREATE TRIGGER draft_processing_cleanups_status_guard
BEFORE UPDATE OF status, cleanup_evidence_hash, updated_at, completed_at
ON draft_processing_cleanups
WHEN NOT (
    (
        OLD.status = 'closing' AND
        NEW.status = 'deleting' AND
        NEW.cleanup_evidence_hash IS NULL AND
        NEW.completed_at IS NULL AND
        NEW.updated_at > OLD.updated_at AND
        (SELECT COUNT(*)
            FROM draft_processing_cleanup_objects AS object
            WHERE object.cleanup_id = OLD.cleanup_id
              AND object.status = 'pending') = OLD.output_count AND
        NOT EXISTS (
            SELECT 1
            FROM draft_processing_outputs AS output
            WHERE output.processing_run_id = OLD.processing_run_id
              AND NOT EXISTS (
                  SELECT 1
                  FROM draft_processing_cleanup_objects AS object
                  WHERE object.cleanup_id = OLD.cleanup_id
                    AND object.role = output.role
                    AND object.status = 'pending'
                    AND object.staging_object_key = output.staging_object_key
                    AND object.expected_sha256 = output.sha256
                    AND object.expected_byte_count = output.byte_count
              )
        ) AND
        NOT EXISTS (
            SELECT 1
            FROM draft_processing_multipart_uploads AS upload
            WHERE upload.processing_run_id = OLD.processing_run_id
              AND upload.status <> 'terminal'
        )
    ) OR (
        OLD.status = 'deleting' AND
        NEW.status = 'cleaned' AND
        NEW.cleanup_evidence_hash IS NOT NULL AND
        NEW.completed_at = NEW.updated_at AND
        NEW.updated_at > OLD.updated_at AND
        NOT EXISTS (
            SELECT 1 FROM draft_processing_outputs AS output
            WHERE output.processing_run_id = OLD.processing_run_id
        ) AND
        NOT EXISTS (
            SELECT 1 FROM draft_processing_multipart_uploads AS upload
            WHERE upload.processing_run_id = OLD.processing_run_id
        ) AND
        NOT EXISTS (
            SELECT 1
            FROM draft_derivatives AS derivative
            JOIN draft_processing_runs AS run
              ON run.draft_id = derivative.draft_id
            WHERE run.processing_run_id = OLD.processing_run_id
              AND derivative.staging_object_key IS NOT NULL
        ) AND
        (SELECT COUNT(*) FROM draft_processing_cleanup_objects AS object
            WHERE object.cleanup_id = OLD.cleanup_id
              AND object.status = 'absent') = OLD.output_count
    )
)
BEGIN
    SELECT RAISE(ABORT, 'invalid processing cleanup transition');
END;

CREATE TRIGGER draft_processing_cleanups_terminal_update_guard
BEFORE UPDATE ON draft_processing_cleanups
WHEN OLD.status = 'cleaned'
BEGIN
    SELECT RAISE(ABORT, 'completed processing cleanup evidence is immutable');
END;

CREATE TRIGGER draft_processing_cleanup_objects_no_replace_guard
BEFORE INSERT ON draft_processing_cleanup_objects
WHEN EXISTS (
    SELECT 1 FROM draft_processing_cleanup_objects AS existing
    WHERE existing.cleanup_id = NEW.cleanup_id
      AND existing.role = NEW.role
)
BEGIN
    SELECT RAISE(ABORT, 'processing cleanup object replacement is forbidden');
END;

CREATE TRIGGER draft_processing_cleanup_objects_insert_guard
BEFORE INSERT ON draft_processing_cleanup_objects
WHEN NOT EXISTS (
    SELECT 1
    FROM draft_processing_cleanups AS cleanup
    JOIN draft_processing_outputs AS output
      ON output.processing_run_id = cleanup.processing_run_id
     AND output.role = NEW.role
    WHERE cleanup.cleanup_id = NEW.cleanup_id
      AND cleanup.status = 'closing'
      AND NEW.status = 'pending'
      AND NEW.staging_object_key = output.staging_object_key
      AND NEW.expected_sha256 = output.sha256
      AND NEW.expected_byte_count = output.byte_count
      AND (
          (
              output.status = 'reserved' AND
              NEW.expected_object_version_hash IS NULL AND
              NEW.expected_etag_hash IS NULL
          ) OR (
              output.status IN ('stored', 'verified') AND
              NEW.expected_object_version_hash IS NOT NULL AND
              NEW.expected_etag_hash IS NOT NULL
          )
      )
)
BEGIN
    SELECT RAISE(ABORT, 'processing cleanup object lacks exact output evidence');
END;

CREATE TRIGGER draft_processing_cleanup_objects_identity_update_guard
BEFORE UPDATE OF
    cleanup_id,
    role,
    staging_object_key_hash,
    expected_sha256,
    expected_byte_count,
    expected_object_version_hash,
    expected_etag_hash
ON draft_processing_cleanup_objects
WHEN
    NEW.cleanup_id IS NOT OLD.cleanup_id OR
    NEW.role IS NOT OLD.role OR
    NEW.staging_object_key_hash IS NOT OLD.staging_object_key_hash OR
    NEW.expected_sha256 IS NOT OLD.expected_sha256 OR
    NEW.expected_byte_count IS NOT OLD.expected_byte_count OR
    NEW.expected_object_version_hash IS NOT OLD.expected_object_version_hash OR
    NEW.expected_etag_hash IS NOT OLD.expected_etag_hash
BEGIN
    SELECT RAISE(ABORT, 'processing cleanup object identity is immutable');
END;

CREATE TRIGGER draft_processing_cleanup_objects_status_guard
BEFORE UPDATE OF
    staging_object_key,
    provider_terminal_kind,
    observed_object_version_hash,
    observed_etag_hash,
    status,
    deleted_at,
    absence_verified_at
ON draft_processing_cleanup_objects
WHEN NOT (
    OLD.status = 'pending' AND
    NEW.status = 'absent' AND
    NEW.staging_object_key IS NULL AND
    NEW.provider_terminal_kind IS NOT NULL AND
    NEW.absence_verified_at IS NOT NULL AND
    EXISTS (
        SELECT 1
        FROM draft_processing_cleanups AS cleanup
        WHERE cleanup.cleanup_id = OLD.cleanup_id
          AND cleanup.status = 'deleting'
          AND (
              NOT EXISTS (
                  SELECT 1
                  FROM draft_processing_multipart_uploads AS upload
                  WHERE upload.processing_run_id = cleanup.processing_run_id
                    AND upload.role = OLD.role
              ) OR EXISTS (
                  SELECT 1
                  FROM draft_processing_multipart_uploads AS upload
                  WHERE upload.processing_run_id = cleanup.processing_run_id
                    AND upload.role = OLD.role
                    AND upload.status = 'terminal'
                    AND upload.terminal_kind = NEW.provider_terminal_kind
              )
          )
    )
)
BEGIN
    SELECT RAISE(ABORT, 'processing cleanup absence evidence is incomplete');
END;

CREATE TRIGGER draft_processing_cleanup_objects_terminal_update_guard
BEFORE UPDATE ON draft_processing_cleanup_objects
WHEN OLD.status = 'absent'
BEGIN
    SELECT RAISE(ABORT, 'verified processing cleanup absence is immutable');
END;

CREATE TRIGGER gallery_processing_cleanup_tombstones_no_replace_guard
BEFORE INSERT ON gallery_processing_cleanup_tombstones
WHEN EXISTS (
    SELECT 1 FROM gallery_processing_cleanup_tombstones AS existing
    WHERE existing.cleanup_id_hash = NEW.cleanup_id_hash
       OR existing.processing_run_id_hash = NEW.processing_run_id_hash
       OR existing.evidence_hash = NEW.evidence_hash
)
BEGIN
    SELECT RAISE(ABORT, 'processing cleanup tombstone replacement is forbidden');
END;

CREATE TRIGGER gallery_processing_cleanup_tombstones_insert_guard
BEFORE INSERT ON gallery_processing_cleanup_tombstones
WHEN NOT EXISTS (
    SELECT 1 FROM draft_processing_cleanups AS cleanup
    WHERE cleanup.status = 'cleaned'
      AND cleanup.cleanup_id_hash = NEW.cleanup_id_hash
      AND cleanup.draft_id_hash = NEW.draft_id_hash
      AND cleanup.processing_run_id_hash = NEW.processing_run_id_hash
      AND cleanup.cleanup_reason = NEW.cleanup_reason
      AND cleanup.cleanup_evidence_hash = NEW.evidence_hash
      AND cleanup.completed_at = NEW.completed_at
)
BEGIN
    SELECT RAISE(ABORT, 'processing cleanup tombstone lacks completed evidence');
END;

CREATE TRIGGER gallery_processing_cleanup_tombstones_no_update
BEFORE UPDATE ON gallery_processing_cleanup_tombstones
BEGIN
    SELECT RAISE(ABORT, 'processing cleanup tombstones are append-only');
END;

CREATE TRIGGER gallery_processing_cleanup_tombstones_no_delete
BEFORE DELETE ON gallery_processing_cleanup_tombstones
BEGIN
    SELECT RAISE(ABORT, 'processing cleanup tombstones are append-only');
END;

-- Once cleanup exists, no new media write or terminal processing result can
-- be admitted. Existing multipart operations are resolved by abort/complete,
-- never by a time-based lease.
CREATE TRIGGER draft_processing_outputs_cleanup_insert_guard
BEFORE INSERT ON draft_processing_outputs
WHEN EXISTS (
    SELECT 1 FROM draft_processing_cleanups AS cleanup
    WHERE cleanup.processing_run_id = NEW.processing_run_id
)
BEGIN
    SELECT RAISE(ABORT, 'processing cleanup has closed output admission');
END;

CREATE TRIGGER draft_processing_outputs_cleanup_update_guard
BEFORE UPDATE ON draft_processing_outputs
WHEN EXISTS (
    SELECT 1 FROM draft_processing_cleanups AS cleanup
    WHERE cleanup.processing_run_id = OLD.processing_run_id
)
BEGIN
    SELECT RAISE(ABORT, 'processing cleanup has closed output mutation');
END;

CREATE TRIGGER draft_processing_runs_cleanup_result_guard
BEFORE UPDATE OF status ON draft_processing_runs
WHEN EXISTS (
    SELECT 1 FROM draft_processing_cleanups AS cleanup
    WHERE cleanup.processing_run_id = OLD.processing_run_id
)
BEGIN
    SELECT RAISE(ABORT, 'processing cleanup has closed result admission');
END;

CREATE TRIGGER draft_derivatives_cleanup_insert_guard
BEFORE INSERT ON draft_derivatives
WHEN EXISTS (
    SELECT 1 FROM draft_processing_cleanups AS cleanup
    JOIN draft_processing_runs AS run
      ON run.processing_run_id = cleanup.processing_run_id
    WHERE run.draft_id = NEW.draft_id
      AND cleanup.status IN ('closing', 'deleting')
)
BEGIN
    SELECT RAISE(ABORT, 'processing cleanup has closed derivative creation');
END;

-- Extend the original no-replace guard to cover the partial current-run
-- uniqueness constraint. Without this branch, INSERT OR REPLACE could evict
-- an active or staged run merely by using a new run ID and idempotency key for
-- the same draft.
DROP TRIGGER draft_processing_runs_no_replace_guard;

CREATE TRIGGER draft_processing_runs_no_replace_guard
BEFORE INSERT ON draft_processing_runs
WHEN EXISTS (
    SELECT 1 FROM draft_processing_runs AS existing
    WHERE existing.processing_run_id = NEW.processing_run_id OR (
        existing.draft_id = NEW.draft_id AND
        existing.start_idempotency_key = NEW.start_idempotency_key
    ) OR (
        existing.draft_id = NEW.draft_id AND
        existing.status IN ('active', 'staged') AND
        NEW.status IN ('active', 'staged')
    )
)
BEGIN
    SELECT RAISE(ABORT, 'processing run replacement is forbidden');
END;

-- A failed run may be retried only after every earlier run for the draft has
-- reached proved terminal cleanup and its unique hash-only tombstone exists.
-- This also closes the gap where no cleanup row had been started yet.
CREATE TRIGGER draft_processing_runs_cleanup_insert_guard
BEFORE INSERT ON draft_processing_runs
WHEN EXISTS (
    SELECT 1
    FROM draft_processing_runs AS prior_run
    WHERE prior_run.draft_id = NEW.draft_id
      AND NOT EXISTS (
          SELECT 1
          FROM draft_processing_cleanups AS cleanup
          JOIN gallery_processing_cleanup_tombstones AS tombstone
            ON tombstone.evidence_hash = cleanup.cleanup_evidence_hash
           AND tombstone.cleanup_id_hash = cleanup.cleanup_id_hash
           AND tombstone.draft_id_hash = cleanup.draft_id_hash
           AND tombstone.processing_run_id_hash = cleanup.processing_run_id_hash
           AND tombstone.cleanup_reason = cleanup.cleanup_reason
           AND tombstone.completed_at = cleanup.completed_at
          WHERE cleanup.processing_run_id = prior_run.processing_run_id
            AND cleanup.status = 'cleaned'
      )
)
BEGIN
    SELECT RAISE(ABORT, 'every prior processing run requires completed cleanup and a hash-only tombstone before replacement');
END;

DROP TRIGGER draft_derivatives_processing_delete_guard;

CREATE TRIGGER draft_derivatives_processing_delete_guard
BEFORE DELETE ON draft_derivatives
WHEN EXISTS (
    SELECT 1 FROM gallery_drafts AS parent WHERE parent.draft_id = OLD.draft_id
) AND NOT EXISTS (
    SELECT 1
    FROM draft_processing_runs AS run
    JOIN draft_processing_outputs AS output
      ON output.processing_run_id = run.processing_run_id
     AND output.role = OLD.role
    JOIN draft_processing_cleanups AS cleanup
      ON cleanup.processing_run_id = run.processing_run_id
    JOIN draft_processing_cleanup_objects AS object
      ON object.cleanup_id = cleanup.cleanup_id
     AND object.role = output.role
    WHERE run.draft_id = OLD.draft_id
      AND output.staging_object_key = OLD.staging_object_key
      AND OLD.approved_object_key IS NULL
      AND cleanup.status = 'deleting'
      AND object.status = 'absent'
)
BEGIN
    SELECT RAISE(ABORT, 'processing derivative deletion lacks verified staging absence');
END;

DROP TRIGGER draft_processing_outputs_direct_delete_guard;

CREATE TRIGGER draft_processing_outputs_direct_delete_guard
BEFORE DELETE ON draft_processing_outputs
WHEN EXISTS (
    SELECT 1
    FROM draft_processing_runs AS run
    JOIN gallery_drafts AS parent ON parent.draft_id = run.draft_id
    WHERE run.processing_run_id = OLD.processing_run_id
) AND NOT EXISTS (
    SELECT 1
    FROM draft_processing_cleanups AS cleanup
    JOIN draft_processing_cleanup_objects AS object
      ON object.cleanup_id = cleanup.cleanup_id
     AND object.role = OLD.role
    WHERE cleanup.processing_run_id = OLD.processing_run_id
      AND cleanup.status = 'deleting'
      AND object.status = 'absent'
      AND NOT EXISTS (
          SELECT 1 FROM draft_derivatives AS derivative
          JOIN draft_processing_runs AS run ON run.draft_id = derivative.draft_id
          WHERE run.processing_run_id = OLD.processing_run_id
            AND derivative.role = OLD.role
            AND derivative.staging_object_key = OLD.staging_object_key
      )
      AND NOT EXISTS (
          SELECT 1 FROM draft_processing_multipart_uploads AS upload
          WHERE upload.processing_run_id = OLD.processing_run_id
            AND upload.role = OLD.role
      )
)
BEGIN
    SELECT RAISE(ABORT, 'processing output deletion lacks completed cleanup evidence');
END;

CREATE TRIGGER draft_processing_multipart_uploads_direct_delete_guard
BEFORE DELETE ON draft_processing_multipart_uploads
WHEN EXISTS (
    SELECT 1
    FROM draft_processing_runs AS run
    JOIN gallery_drafts AS parent ON parent.draft_id = run.draft_id
    WHERE run.processing_run_id = OLD.processing_run_id
) AND NOT EXISTS (
    SELECT 1
    FROM draft_processing_cleanups AS cleanup
    JOIN draft_processing_cleanup_objects AS object
      ON object.cleanup_id = cleanup.cleanup_id
     AND object.role = OLD.role
    WHERE cleanup.processing_run_id = OLD.processing_run_id
      AND cleanup.status = 'deleting'
      AND object.status = 'absent'
      AND OLD.status = 'terminal'
)
BEGIN
    SELECT RAISE(ABORT, 'processing multipart deletion lacks completed cleanup evidence');
END;

CREATE TRIGGER draft_processing_cleanups_direct_delete_guard
BEFORE DELETE ON draft_processing_cleanups
WHEN EXISTS (
    SELECT 1 FROM gallery_drafts AS parent
    WHERE parent.draft_id = OLD.draft_id
)
BEGIN
    SELECT RAISE(ABORT, 'processing cleanup direct deletion is forbidden; approved draft purge only');
END;

CREATE TRIGGER draft_processing_cleanup_objects_direct_delete_guard
BEFORE DELETE ON draft_processing_cleanup_objects
WHEN EXISTS (
    SELECT 1
    FROM draft_processing_cleanups AS cleanup
    JOIN gallery_drafts AS parent ON parent.draft_id = cleanup.draft_id
    WHERE cleanup.cleanup_id = OLD.cleanup_id
)
BEGIN
    SELECT RAISE(ABORT, 'processing cleanup object deletion is forbidden; approved draft purge only');
END;

DROP TRIGGER gallery_drafts_phase_d_purge_object_guard;

CREATE TRIGGER gallery_drafts_phase_d_purge_object_guard
BEFORE DELETE ON gallery_drafts
WHEN EXISTS (
    SELECT 1
    FROM draft_processing_runs AS run
    WHERE run.draft_id = OLD.draft_id
      AND NOT EXISTS (
          SELECT 1
          FROM draft_processing_cleanups AS cleanup
          JOIN gallery_processing_cleanup_tombstones AS tombstone
            ON tombstone.evidence_hash = cleanup.cleanup_evidence_hash
           AND tombstone.cleanup_id_hash = cleanup.cleanup_id_hash
           AND tombstone.draft_id_hash = cleanup.draft_id_hash
           AND tombstone.processing_run_id_hash = cleanup.processing_run_id_hash
           AND tombstone.cleanup_reason = cleanup.cleanup_reason
           AND tombstone.completed_at = cleanup.completed_at
          WHERE cleanup.processing_run_id = run.processing_run_id
            AND cleanup.status = 'cleaned'
      )
)
BEGIN
    SELECT RAISE(ABORT, 'every processing run requires completed private staging cleanup and a hash-only tombstone');
END;

PRAGMA foreign_key_check;
