PRAGMA foreign_keys = ON;

-- Phase C stores provider upload state privately. Neither the provider upload
-- ID nor the server-generated object key is ever returned to the browser.
CREATE TABLE draft_upload_sessions (
    upload_session_id TEXT PRIMARY KEY
        CHECK (
            length(upload_session_id) BETWEEN 20 AND 128 AND
            upload_session_id NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
    draft_id TEXT NOT NULL,
    item_revision TEXT NOT NULL,
    consent_revision TEXT NOT NULL,
    export_bundle_id TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    suppression_revision TEXT NOT NULL,
    provider_upload_id TEXT NOT NULL UNIQUE
        CHECK (length(provider_upload_id) BETWEEN 1 AND 1024),
    object_key TEXT NOT NULL UNIQUE
        CHECK (
            object_key LIKE 'private-originals/phase-c/%' AND
            object_key NOT LIKE '%..%' AND
            object_key NOT LIKE '%//%' AND
            length(object_key) BETWEEN 60 AND 512
        ),
    file_extension TEXT NOT NULL
        CHECK (file_extension IN (
            'jpg', 'jpeg', 'png', 'webp', 'heic', 'heif',
            'mp4', 'mov', 'webm'
        )),
    declared_content_type TEXT NOT NULL
        CHECK (declared_content_type IN (
            'image/jpeg', 'image/png', 'image/webp', 'image/heic',
            'image/heif', 'video/mp4', 'video/quicktime', 'video/webm'
        )),
    declared_byte_count INTEGER NOT NULL
        CHECK (declared_byte_count BETWEEN 1 AND 524288000),
    part_size INTEGER NOT NULL
        CHECK (part_size = 5242880),
    part_count INTEGER NOT NULL
        CHECK (
            part_count BETWEEN 1 AND 100 AND
            part_count = ((declared_byte_count + part_size - 1) / part_size)
        ),
    next_part_number INTEGER NOT NULL DEFAULT 1
        CHECK (next_part_number BETWEEN 1 AND part_count + 1),
    uploaded_byte_count INTEGER NOT NULL DEFAULT 0
        CHECK (uploaded_byte_count BETWEEN 0 AND declared_byte_count),
    detected_format TEXT
        CHECK (
            detected_format IS NULL OR
            detected_format IN ('jpeg', 'png', 'webp', 'heif', 'mp4', 'quicktime', 'webm')
        ),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN (
            'active', 'completing', 'complete', 'failed',
            'aborted', 'expired', 'deleted'
        )),
    completed_object_version TEXT
        CHECK (
            completed_object_version IS NULL OR
            length(completed_object_version) BETWEEN 1 AND 256
        ),
    completed_etag TEXT
        CHECK (
            completed_etag IS NULL OR
            length(completed_etag) BETWEEN 1 AND 256
        ),
    completed_sha256 TEXT
        CHECK (
            completed_sha256 IS NULL OR (
                length(completed_sha256) = 64 AND
                completed_sha256 NOT GLOB '*[^0-9a-f]*'
            )
        ),
    failure_code TEXT
        CHECK (
            failure_code IS NULL OR
            failure_code IN (
                'checksum-mismatch', 'signature-mismatch', 'size-mismatch',
                'object-missing', 'provider-error', 'owner-aborted', 'expired'
            )
        ),
    synthetic_only_confirmed INTEGER NOT NULL
        CHECK (synthetic_only_confirmed = 1),
    verified_owner_identity_hash TEXT NOT NULL
        CHECK (
            length(verified_owner_identity_hash) = 64 AND
            verified_owner_identity_hash NOT GLOB '*[^0-9a-f]*'
        ),
    initiation_idempotency_key TEXT NOT NULL
        CHECK (
            length(initiation_idempotency_key) BETWEEN 16 AND 128 AND
            initiation_idempotency_key NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
    initiation_payload_fingerprint TEXT NOT NULL
        CHECK (
            length(initiation_payload_fingerprint) = 64 AND
            initiation_payload_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
    completion_idempotency_key TEXT
        CHECK (
            completion_idempotency_key IS NULL OR (
                length(completion_idempotency_key) BETWEEN 16 AND 128 AND
                completion_idempotency_key NOT GLOB '*[^A-Za-z0-9_-]*'
            )
        ),
    completion_payload_fingerprint TEXT
        CHECK (
            completion_payload_fingerprint IS NULL OR (
                length(completion_payload_fingerprint) = 64 AND
                completion_payload_fingerprint NOT GLOB '*[^0-9a-f]*'
            )
        ),
    completion_started_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    completed_at TEXT,
    object_deleted_at TEXT,
    UNIQUE (draft_id, initiation_idempotency_key),
    FOREIGN KEY (draft_id) REFERENCES gallery_drafts(draft_id)
        ON DELETE CASCADE,
    FOREIGN KEY (draft_id, consent_revision)
        REFERENCES draft_consent_attestations(draft_id, consent_revision)
        ON DELETE CASCADE,
    CHECK (created_at <= updated_at AND created_at < expires_at),
    CHECK (
        (status = 'complete' AND completed_at IS NOT NULL AND object_deleted_at IS NULL) OR
        (status = 'deleted' AND completed_at IS NOT NULL AND object_deleted_at IS NOT NULL) OR
        (status NOT IN ('complete', 'deleted') AND completed_at IS NULL AND object_deleted_at IS NULL)
    ),
    CHECK (
        status IN ('complete', 'deleted') OR
        (
            completed_object_version IS NULL AND
            completed_etag IS NULL AND
            completed_sha256 IS NULL
        )
    ),
    CHECK (
        status IN ('failed', 'aborted', 'expired') OR failure_code IS NULL
    ),
    CHECK (
        (
            completion_idempotency_key IS NULL AND
            completion_payload_fingerprint IS NULL AND
            completion_started_at IS NULL
        ) OR (
            completion_idempotency_key IS NOT NULL AND
            completion_payload_fingerprint IS NOT NULL AND
            completion_started_at IS NOT NULL
        )
    ),
    CHECK (
        status NOT IN ('completing', 'complete', 'deleted') OR
        completion_idempotency_key IS NOT NULL
    ),
    CHECK (
        status <> 'active' OR completion_idempotency_key IS NULL
    )
);

CREATE TABLE draft_upload_parts (
    upload_session_id TEXT NOT NULL,
    part_number INTEGER NOT NULL
        CHECK (part_number BETWEEN 1 AND 100),
    provider_etag TEXT NOT NULL
        CHECK (length(provider_etag) BETWEEN 1 AND 256),
    byte_count INTEGER NOT NULL
        CHECK (byte_count BETWEEN 1 AND 5242880),
    sha256 TEXT NOT NULL
        CHECK (
            length(sha256) = 64 AND
            sha256 NOT GLOB '*[^0-9a-f]*'
        ),
    uploaded_at TEXT NOT NULL,
    PRIMARY KEY (upload_session_id, part_number),
    FOREIGN KEY (upload_session_id)
        REFERENCES draft_upload_sessions(upload_session_id)
        ON DELETE CASCADE
);

-- Same-state editorial changes cannot use state_version, so they receive a
-- separate immutable idempotency receipt tied to item-revision compare-and-swap.
CREATE TABLE draft_mutation_receipts (
    draft_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL
        CHECK (
            length(idempotency_key) BETWEEN 16 AND 128 AND
            idempotency_key NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
    mutation_kind TEXT NOT NULL
        CHECK (mutation_kind IN ('edit-details', 'restart-upload')),
    payload_fingerprint TEXT NOT NULL
        CHECK (
            length(payload_fingerprint) = 64 AND
            payload_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
    expected_item_revision TEXT NOT NULL,
    result_item_revision TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (draft_id, idempotency_key),
    FOREIGN KEY (draft_id) REFERENCES gallery_drafts(draft_id)
        ON DELETE CASCADE
);

CREATE UNIQUE INDEX draft_upload_sessions_current_index
    ON draft_upload_sessions(draft_id)
    WHERE status IN ('active', 'completing', 'complete');

CREATE INDEX draft_upload_sessions_expiry_index
    ON draft_upload_sessions(status, expires_at);

CREATE TRIGGER draft_upload_sessions_no_replace_guard
BEFORE INSERT ON draft_upload_sessions
WHEN EXISTS (
    SELECT 1 FROM draft_upload_sessions AS existing
    WHERE existing.upload_session_id = NEW.upload_session_id
       OR existing.provider_upload_id = NEW.provider_upload_id
       OR existing.object_key = NEW.object_key
       OR (
           existing.draft_id = NEW.draft_id AND
           existing.initiation_idempotency_key = NEW.initiation_idempotency_key
       )
)
BEGIN
    SELECT RAISE(ABORT, 'private upload session replacement is forbidden');
END;

CREATE TRIGGER draft_upload_parts_no_replace_guard
BEFORE INSERT ON draft_upload_parts
WHEN EXISTS (
    SELECT 1 FROM draft_upload_parts AS existing
    WHERE existing.upload_session_id = NEW.upload_session_id
      AND existing.part_number = NEW.part_number
)
BEGIN
    SELECT RAISE(ABORT, 'private upload part replacement is forbidden');
END;

CREATE TRIGGER draft_mutation_receipts_no_replace_guard
BEFORE INSERT ON draft_mutation_receipts
WHEN EXISTS (
    SELECT 1 FROM draft_mutation_receipts AS existing
    WHERE existing.draft_id = NEW.draft_id
      AND existing.idempotency_key = NEW.idempotency_key
)
BEGIN
    SELECT RAISE(ABORT, 'draft mutation receipt replacement is forbidden');
END;

CREATE TRIGGER draft_upload_sessions_identity_guard
BEFORE UPDATE OF
    upload_session_id,
    draft_id,
    item_revision,
    consent_revision,
    export_bundle_id,
    source_revision,
    suppression_revision,
    provider_upload_id,
    object_key,
    file_extension,
    declared_content_type,
    declared_byte_count,
    part_size,
    part_count,
    synthetic_only_confirmed,
    verified_owner_identity_hash,
    initiation_idempotency_key,
    initiation_payload_fingerprint,
    created_at,
    expires_at
ON draft_upload_sessions
WHEN NEW.upload_session_id IS NOT OLD.upload_session_id OR
     NEW.draft_id IS NOT OLD.draft_id OR
     NEW.item_revision IS NOT OLD.item_revision OR
     NEW.consent_revision IS NOT OLD.consent_revision OR
     NEW.export_bundle_id IS NOT OLD.export_bundle_id OR
     NEW.source_revision IS NOT OLD.source_revision OR
     NEW.suppression_revision IS NOT OLD.suppression_revision OR
     NEW.provider_upload_id IS NOT OLD.provider_upload_id OR
     NEW.object_key IS NOT OLD.object_key OR
     NEW.file_extension IS NOT OLD.file_extension OR
     NEW.declared_content_type IS NOT OLD.declared_content_type OR
     NEW.declared_byte_count IS NOT OLD.declared_byte_count OR
     NEW.part_size IS NOT OLD.part_size OR
     NEW.part_count IS NOT OLD.part_count OR
     NEW.synthetic_only_confirmed IS NOT OLD.synthetic_only_confirmed OR
     NEW.verified_owner_identity_hash IS NOT OLD.verified_owner_identity_hash OR
     NEW.initiation_idempotency_key IS NOT OLD.initiation_idempotency_key OR
     NEW.initiation_payload_fingerprint IS NOT OLD.initiation_payload_fingerprint OR
     NEW.created_at IS NOT OLD.created_at OR
     NEW.expires_at IS NOT OLD.expires_at
BEGIN
    SELECT RAISE(ABORT, 'private upload session identity is immutable');
END;

CREATE TRIGGER draft_upload_parts_no_update
BEFORE UPDATE ON draft_upload_parts
BEGIN
    SELECT RAISE(ABORT, 'private upload part evidence is immutable');
END;

CREATE TRIGGER draft_upload_parts_direct_delete_guard
BEFORE DELETE ON draft_upload_parts
WHEN EXISTS (
    SELECT 1 FROM draft_upload_sessions AS parent
    WHERE parent.upload_session_id = OLD.upload_session_id
)
BEGIN
    SELECT RAISE(ABORT, 'private upload part direct deletion is forbidden');
END;

CREATE TRIGGER draft_mutation_receipts_no_update
BEFORE UPDATE ON draft_mutation_receipts
BEGIN
    SELECT RAISE(ABORT, 'draft mutation receipts are append-only');
END;

CREATE TRIGGER draft_mutation_receipts_direct_delete_guard
BEFORE DELETE ON draft_mutation_receipts
WHEN EXISTS (
    SELECT 1 FROM gallery_drafts AS parent
    WHERE parent.draft_id = OLD.draft_id
)
BEGIN
    SELECT RAISE(ABORT, 'draft mutation receipt direct deletion is forbidden');
END;

CREATE TRIGGER draft_mutation_receipts_result_guard
BEFORE INSERT ON draft_mutation_receipts
WHEN NOT EXISTS (
    SELECT 1 FROM gallery_drafts AS draft
    WHERE draft.draft_id = NEW.draft_id
      AND draft.item_revision = NEW.result_item_revision
)
BEGIN
    SELECT RAISE(ABORT, 'draft mutation receipt does not match the committed item revision');
END;

CREATE TRIGGER draft_upload_sessions_insert_guard
BEFORE INSERT ON draft_upload_sessions
WHEN NOT EXISTS (
    SELECT 1
    FROM gallery_drafts AS draft
    JOIN draft_consent_attestations AS consent
      ON consent.draft_id = draft.draft_id
     AND consent.consent_revision = draft.active_consent_revision
    WHERE draft.draft_id = NEW.draft_id
      AND draft.state = 'uploading'
      AND draft.item_revision = NEW.item_revision
      AND draft.active_consent_revision = NEW.consent_revision
      AND draft.export_bundle_id = NEW.export_bundle_id
      AND draft.source_revision = NEW.source_revision
      AND draft.suppression_revision = NEW.suppression_revision
      AND draft.original_object_key = NEW.object_key
      AND draft.upload_complete = 0
      AND consent.public_use_confirmed = 1
      AND (consent.contains_minors = 0 OR consent.guardian_approval_confirmed = 1)
      AND consent.withdrawn_at IS NULL
      AND (
          (draft.media_type = 'photo' AND NEW.declared_byte_count <= 26214400) OR
          (draft.media_type = 'video' AND NEW.declared_byte_count <= 524288000)
      )
)
BEGIN
    SELECT RAISE(ABORT, 'private upload session is stale or lacks valid consent');
END;

CREATE TRIGGER draft_upload_sessions_pending_exclusion_guard
BEFORE INSERT ON draft_upload_sessions
WHEN EXISTS (
    SELECT 1
    FROM gallery_drafts AS draft
    JOIN json_each(draft.athlete_ids_json) AS tag
    JOIN pending_athlete_exclusions AS exclusion
      ON exclusion.athlete_id = tag.value
    WHERE draft.draft_id = NEW.draft_id
      AND exclusion.resolved_at IS NULL
)
BEGIN
    SELECT RAISE(ABORT, 'pending athlete exclusion blocks private upload');
END;

CREATE TRIGGER draft_upload_parts_insert_guard
BEFORE INSERT ON draft_upload_parts
WHEN NOT EXISTS (
    SELECT 1
    FROM draft_upload_sessions AS session
    WHERE session.upload_session_id = NEW.upload_session_id
      AND session.status = 'active'
      AND session.next_part_number = NEW.part_number
      AND NEW.part_number <= session.part_count
      AND NEW.byte_count = CASE
          WHEN NEW.part_number < session.part_count THEN session.part_size
          ELSE session.declared_byte_count -
              (session.part_size * (session.part_count - 1))
      END
)
BEGIN
    SELECT RAISE(ABORT, 'private upload part is out of sequence or the wrong size');
END;

CREATE TRIGGER draft_upload_sessions_progress_guard
BEFORE UPDATE OF next_part_number, uploaded_byte_count, detected_format
ON draft_upload_sessions
WHEN NEW.status = OLD.status AND (
    OLD.status <> 'active' OR
    NEW.next_part_number <> OLD.next_part_number + 1 OR
    NEW.uploaded_byte_count <> OLD.uploaded_byte_count + COALESCE((
        SELECT part.byte_count
        FROM draft_upload_parts AS part
        WHERE part.upload_session_id = OLD.upload_session_id
          AND part.part_number = OLD.next_part_number
    ), -1) OR
    (OLD.next_part_number = 1 AND NEW.detected_format IS NULL) OR
    (OLD.next_part_number > 1 AND NEW.detected_format IS NOT OLD.detected_format) OR
    NEW.updated_at IS OLD.updated_at
)
BEGIN
    SELECT RAISE(ABORT, 'private upload progress must advance by one verified part');
END;

-- Progress belongs only to the active part-recording step. A status change
-- must not be used to smuggle in a second, unverified progress mutation.
CREATE TRIGGER draft_upload_sessions_progress_transition_guard
BEFORE UPDATE OF status, next_part_number, uploaded_byte_count, detected_format
ON draft_upload_sessions
WHEN NEW.status <> OLD.status AND (
    NEW.next_part_number IS NOT OLD.next_part_number OR
    NEW.uploaded_byte_count IS NOT OLD.uploaded_byte_count OR
    NEW.detected_format IS NOT OLD.detected_format
)
BEGIN
    SELECT RAISE(ABORT, 'private upload progress is immutable during a status transition');
END;

CREATE TRIGGER draft_upload_sessions_status_guard
BEFORE UPDATE OF status ON draft_upload_sessions
WHEN NEW.status <> OLD.status AND NOT (
    (OLD.status = 'active' AND NEW.status IN (
        'completing', 'failed', 'aborted', 'expired'
    )) OR
    (OLD.status = 'completing' AND NEW.status IN (
        'complete', 'failed', 'aborted', 'expired'
    )) OR
    (OLD.status = 'complete' AND NEW.status = 'deleted')
)
BEGIN
    SELECT RAISE(ABORT, 'invalid private upload session transition');
END;

CREATE TRIGGER draft_upload_sessions_completion_start_guard
BEFORE UPDATE OF
    status,
    completion_idempotency_key,
    completion_payload_fingerprint,
    completion_started_at
ON draft_upload_sessions
WHEN NEW.status = 'completing' AND NOT (
    OLD.status = 'active' AND
    OLD.next_part_number = OLD.part_count + 1 AND
    OLD.uploaded_byte_count = OLD.declared_byte_count AND
    OLD.completion_idempotency_key IS NULL AND
    OLD.completion_payload_fingerprint IS NULL AND
    OLD.completion_started_at IS NULL AND
    NEW.completion_idempotency_key IS NOT NULL AND
    NEW.completion_payload_fingerprint IS NOT NULL AND
    NEW.completion_started_at IS NOT NULL
)
BEGIN
    SELECT RAISE(ABORT, 'private upload completion cannot start before every part is recorded');
END;

CREATE TRIGGER draft_upload_sessions_completion_guard
BEFORE UPDATE OF
    status,
    completion_idempotency_key,
    completion_payload_fingerprint,
    completion_started_at,
    completed_object_version,
    completed_etag,
    completed_sha256,
    completed_at
ON draft_upload_sessions
WHEN NEW.status = 'complete' AND NOT (
    OLD.status = 'completing' AND
    NEW.completion_idempotency_key IS NOT NULL AND
    NEW.completion_payload_fingerprint IS NOT NULL AND
    NEW.completion_started_at IS NOT NULL AND
    NEW.next_part_number = NEW.part_count + 1 AND
    NEW.uploaded_byte_count = NEW.declared_byte_count AND
    NEW.detected_format IS NOT NULL AND
    length(NEW.completed_object_version) BETWEEN 1 AND 256 AND
    length(NEW.completed_etag) BETWEEN 1 AND 256 AND
    NEW.completed_sha256 IS NOT NULL AND
    NEW.completed_at IS NOT NULL AND
    NEW.failure_code IS NULL AND
    (SELECT COUNT(*) FROM draft_upload_parts AS part
        WHERE part.upload_session_id = NEW.upload_session_id) = NEW.part_count AND
    (SELECT COALESCE(SUM(part.byte_count), 0) FROM draft_upload_parts AS part
        WHERE part.upload_session_id = NEW.upload_session_id) = NEW.declared_byte_count
)
BEGIN
    SELECT RAISE(ABORT, 'private upload completion lacks verified object evidence');
END;

CREATE TRIGGER draft_upload_sessions_terminal_shape_guard
BEFORE UPDATE OF status, failure_code, object_deleted_at
ON draft_upload_sessions
WHEN (
    NEW.status IN ('failed', 'aborted', 'expired') AND NEW.failure_code IS NULL
) OR (
    NEW.status = 'deleted' AND (
        OLD.status <> 'complete' OR
        NEW.object_deleted_at IS NULL OR
        NEW.object_deleted_at IS OLD.object_deleted_at
    )
)
BEGIN
    SELECT RAISE(ABORT, 'private upload terminal evidence is incomplete');
END;

CREATE TRIGGER gallery_drafts_upload_completion_guard
BEFORE UPDATE OF
    state,
    upload_complete,
    original_object_key,
    original_detected_type,
    original_byte_count,
    original_sha256
ON gallery_drafts
WHEN NEW.upload_complete = 1 AND NOT EXISTS (
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
)
BEGIN
    SELECT RAISE(ABORT, 'gallery draft lacks a verified private original');
END;

CREATE TRIGGER gallery_drafts_private_review_upload_guard
BEFORE UPDATE OF state ON gallery_drafts
WHEN NEW.state = 'private-review' AND (
    NEW.upload_complete <> 1 OR
    NEW.original_object_key IS NULL OR
    NEW.original_detected_type IS NULL OR
    NEW.original_byte_count IS NULL OR
    NEW.original_sha256 IS NULL
)
BEGIN
    SELECT RAISE(ABORT, 'private review requires a complete verified upload');
END;

CREATE TRIGGER gallery_drafts_completed_original_immutable_guard
BEFORE UPDATE OF
    media_type,
    original_object_key,
    original_detected_type,
    original_byte_count,
    original_sha256,
    upload_complete
ON gallery_drafts
WHEN OLD.upload_complete = 1 AND (
    NEW.media_type IS NOT OLD.media_type OR
    NEW.original_object_key IS NOT OLD.original_object_key OR
    NEW.original_detected_type IS NOT OLD.original_detected_type OR
    NEW.original_byte_count IS NOT OLD.original_byte_count OR
    NEW.original_sha256 IS NOT OLD.original_sha256 OR
    NEW.upload_complete IS NOT OLD.upload_complete
)
BEGIN
    SELECT RAISE(ABORT, 'verified private original evidence is immutable');
END;

CREATE TRIGGER gallery_drafts_active_upload_media_guard
BEFORE UPDATE OF media_type ON gallery_drafts
WHEN NEW.media_type IS NOT OLD.media_type AND EXISTS (
    SELECT 1 FROM draft_upload_sessions AS session
    WHERE session.draft_id = OLD.draft_id
      AND session.status IN ('active', 'completing', 'complete')
)
BEGIN
    SELECT RAISE(ABORT, 'media type cannot change while a private upload exists');
END;

-- The service updates the draft first, then inserts the immutable receipt in
-- the same D1 batch. A stale zero-row update therefore aborts the full batch.
CREATE TRIGGER draft_transition_receipts_result_guard
BEFORE INSERT ON draft_transition_receipts
WHEN NOT EXISTS (
    SELECT 1 FROM gallery_drafts AS draft
    WHERE draft.draft_id = NEW.draft_id
      AND draft.state = NEW.to_state
      AND draft.state_version = NEW.result_state_version
)
BEGIN
    SELECT RAISE(ABORT, 'transition receipt does not match the committed draft state');
END;

-- Purge must not cascade away the only remaining object references. Every
-- derivative row must already be cleared and every original session terminal.
CREATE TRIGGER gallery_drafts_phase_c_purge_object_guard
BEFORE DELETE ON gallery_drafts
WHEN EXISTS (
    SELECT 1 FROM draft_derivatives AS derivative
    WHERE derivative.draft_id = OLD.draft_id
) OR EXISTS (
    SELECT 1 FROM draft_upload_sessions AS session
    WHERE session.draft_id = OLD.draft_id
      AND session.status NOT IN ('failed', 'aborted', 'expired', 'deleted')
)
BEGIN
    SELECT RAISE(ABORT, 'gallery draft purge requires all object evidence to be terminal');
END;

-- An owner upload is created from one Gallery area and stays bound to that
-- area. The older Phase B table check admitted a dual-mode draft, so Phase C
-- closes that path at the database boundary as well as in application code.
CREATE TRIGGER gallery_drafts_single_site_insert_guard
BEFORE INSERT ON gallery_drafts
WHEN NEW.site_modes_json NOT IN ('["family"]', '["everyone"]')
BEGIN
    SELECT RAISE(ABORT, 'gallery upload draft must belong to exactly one site mode');
END;

CREATE TRIGGER gallery_drafts_single_site_update_guard
BEFORE UPDATE OF site_modes_json ON gallery_drafts
WHEN NEW.site_modes_json NOT IN ('["family"]', '["everyone"]')
BEGIN
    SELECT RAISE(ABORT, 'gallery upload draft must belong to exactly one site mode');
END;

CREATE TRIGGER gallery_drafts_site_mode_immutable_guard
BEFORE UPDATE OF site_modes_json ON gallery_drafts
WHEN NEW.site_modes_json IS NOT OLD.site_modes_json
BEGIN
    SELECT RAISE(ABORT, 'gallery draft site mode is immutable after creation');
END;
