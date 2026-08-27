PRAGMA foreign_keys = ON;

CREATE TABLE gallery_drafts (
    draft_id TEXT PRIMARY KEY
        CHECK (length(draft_id) BETWEEN 20 AND 128),
    public_item_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'draft'
        CHECK (state IN (
            'draft',
            'uploading',
            'private-review',
            'approved-for-processing',
            'processing',
            'candidate-public',
            'pr-open',
            'published',
            'rejected',
            'withdrawal-pending',
            'withdrawn',
            'processing-failed'
        )),
    state_version INTEGER NOT NULL DEFAULT 0
        CHECK (state_version >= 0),
    site_modes_json TEXT NOT NULL
        CHECK (
            json_valid(site_modes_json) AND
            site_modes_json IN (
                '["family"]',
                '["everyone"]',
                '["family","everyone"]'
            )
        ),
    export_bundle_id TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    suppression_revision TEXT NOT NULL,
    item_revision TEXT NOT NULL,
    active_consent_revision TEXT,
    media_type TEXT NOT NULL
        CHECK (media_type IN ('photo', 'video')),
    race_date TEXT NOT NULL,
    race_event TEXT NOT NULL,
    race_distance TEXT NOT NULL,
    athlete_ids_json TEXT NOT NULL
        CHECK (
            json_valid(athlete_ids_json) AND
            json_type(athlete_ids_json) = 'array'
        ),
    title TEXT NOT NULL,
    caption TEXT NOT NULL,
    alt_text TEXT NOT NULL,
    featured INTEGER NOT NULL
        CHECK (featured IN (0, 1)),
    editorial_position INTEGER,
    original_object_key TEXT,
    original_detected_type TEXT,
    original_byte_count INTEGER
        CHECK (original_byte_count IS NULL OR original_byte_count >= 0),
    original_sha256 TEXT
        CHECK (
            original_sha256 IS NULL OR (
                length(original_sha256) = 64 AND
                original_sha256 NOT GLOB '*[^0-9a-f]*'
            )
        ),
    upload_complete INTEGER NOT NULL DEFAULT 0
        CHECK (upload_complete IN (0, 1)),
    processing_diagnostics_json TEXT
        CHECK (
            processing_diagnostics_json IS NULL OR
            json_valid(processing_diagnostics_json)
        ),
    verified_owner_identity_hash TEXT NOT NULL
        CHECK (
            length(verified_owner_identity_hash) = 64 AND
            verified_owner_identity_hash NOT GLOB '*[^0-9a-f]*'
        ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (public_item_id),
    UNIQUE (original_object_key),
    FOREIGN KEY (draft_id, active_consent_revision)
        REFERENCES draft_consent_attestations(draft_id, consent_revision)
        DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE draft_consent_attestations (
    draft_id TEXT NOT NULL,
    consent_revision TEXT NOT NULL,
    public_use_confirmed INTEGER NOT NULL
        CHECK (public_use_confirmed IN (0, 1)),
    contains_minors INTEGER NOT NULL
        CHECK (contains_minors IN (0, 1)),
    guardian_approval_confirmed INTEGER NOT NULL
        CHECK (guardian_approval_confirmed IN (0, 1)),
    private_evidence_reference TEXT,
    verified_owner_identity_hash TEXT NOT NULL
        CHECK (
            length(verified_owner_identity_hash) = 64 AND
            verified_owner_identity_hash NOT GLOB '*[^0-9a-f]*'
        ),
    attested_at TEXT NOT NULL,
    withdrawn_at TEXT,
    PRIMARY KEY (draft_id, consent_revision),
    FOREIGN KEY (draft_id) REFERENCES gallery_drafts(draft_id)
        ON DELETE CASCADE
);

CREATE TABLE draft_derivatives (
    draft_id TEXT NOT NULL,
    item_revision TEXT NOT NULL,
    consent_revision TEXT NOT NULL,
    export_bundle_id TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    suppression_revision TEXT NOT NULL,
    role TEXT NOT NULL
        CHECK (role IN (
            'photo-display',
            'photo-thumbnail',
            'video',
            'video-poster'
        )),
    staging_object_key TEXT,
    approved_object_key TEXT,
    byte_count INTEGER NOT NULL
        CHECK (byte_count >= 0),
    sha256 TEXT NOT NULL
        CHECK (
            length(sha256) = 64 AND
            sha256 NOT GLOB '*[^0-9a-f]*'
        ),
    content_type TEXT NOT NULL
        CHECK (content_type IN ('image/webp', 'video/mp4')),
    width INTEGER NOT NULL
        CHECK (width > 0),
    height INTEGER NOT NULL
        CHECK (height > 0),
    duration_milliseconds INTEGER
        CHECK (
            duration_milliseconds IS NULL OR
            duration_milliseconds >= 0
        ),
    metadata_scan_json TEXT NOT NULL
        CHECK (json_valid(metadata_scan_json)),
    scanner_version TEXT NOT NULL,
    verified_at TEXT NOT NULL,
    host_deleted_at TEXT,
    PRIMARY KEY (draft_id, role),
    UNIQUE (staging_object_key),
    UNIQUE (approved_object_key),
    FOREIGN KEY (draft_id) REFERENCES gallery_drafts(draft_id)
        ON DELETE CASCADE,
    FOREIGN KEY (draft_id, consent_revision)
        REFERENCES draft_consent_attestations(draft_id, consent_revision)
        ON DELETE CASCADE
);

CREATE TABLE draft_publication_references (
    draft_id TEXT PRIMARY KEY,
    workflow_run_reference TEXT,
    candidate_branch_reference TEXT,
    pull_request_reference TEXT,
    merge_commit_reference TEXT,
    host_deletion_confirmed INTEGER NOT NULL DEFAULT 0
        CHECK (host_deletion_confirmed IN (0, 1)),
    private_original_deletion_confirmed INTEGER NOT NULL DEFAULT 0
        CHECK (private_original_deletion_confirmed IN (0, 1)),
    withdrawal_kind TEXT
        CHECK (
            withdrawal_kind IS NULL OR
            withdrawal_kind IN (
                'editorial-removal',
                'athlete-exclusion',
                'consent-withdrawal'
            )
        ),
    updated_at TEXT NOT NULL,
    FOREIGN KEY (draft_id) REFERENCES gallery_drafts(draft_id)
        ON DELETE CASCADE
);

CREATE TABLE draft_transition_receipts (
    draft_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL
        CHECK (length(idempotency_key) BETWEEN 16 AND 128),
    payload_fingerprint TEXT NOT NULL
        CHECK (
            length(payload_fingerprint) = 64 AND
            payload_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
    from_state TEXT NOT NULL
        CHECK (from_state IN (
            'draft', 'uploading', 'private-review',
            'approved-for-processing', 'processing', 'candidate-public',
            'pr-open', 'published', 'rejected', 'withdrawal-pending',
            'withdrawn', 'processing-failed'
        )),
    to_state TEXT NOT NULL
        CHECK (to_state IN (
            'draft', 'uploading', 'private-review',
            'approved-for-processing', 'processing', 'candidate-public',
            'pr-open', 'published', 'rejected', 'withdrawal-pending',
            'withdrawn', 'processing-failed'
        )),
    expected_state_version INTEGER NOT NULL
        CHECK (expected_state_version >= 0),
    result_state_version INTEGER NOT NULL
        CHECK (result_state_version = expected_state_version + 1),
    created_at TEXT NOT NULL,
    PRIMARY KEY (draft_id, idempotency_key),
    FOREIGN KEY (draft_id) REFERENCES gallery_drafts(draft_id)
        ON DELETE CASCADE
);

CREATE TABLE pending_athlete_exclusions (
    athlete_id TEXT PRIMARY KEY
        CHECK (
            length(athlete_id) BETWEEN 1 AND 100 AND
            athlete_id = lower(athlete_id) AND
            athlete_id NOT GLOB '*[^a-z0-9-]*' AND
            athlete_id NOT LIKE '-%' AND
            athlete_id NOT LIKE '%-' AND
            athlete_id NOT LIKE '%--%'
        ),
    exclusion_revision TEXT NOT NULL,
    expected_suppression_revision TEXT NOT NULL,
    request_audit_hash TEXT NOT NULL
        CHECK (
            length(request_audit_hash) = 64 AND
            request_audit_hash NOT GLOB '*[^0-9a-f]*'
        ),
    actor_identity_hash TEXT NOT NULL
        CHECK (
            length(actor_identity_hash) = 64 AND
            actor_identity_hash NOT GLOB '*[^0-9a-f]*'
        ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    resolved_suppression_revision TEXT,
    resolution_audit_hash TEXT
        CHECK (
            resolution_audit_hash IS NULL OR (
                length(resolution_audit_hash) = 64 AND
                resolution_audit_hash NOT GLOB '*[^0-9a-f]*'
            )
        ),
    resolved_at TEXT,
    CHECK (
        (
            resolved_suppression_revision IS NULL AND
            resolution_audit_hash IS NULL AND
            resolved_at IS NULL
        ) OR (
            resolved_suppression_revision IS NOT NULL AND
            resolution_audit_hash IS NOT NULL AND
            resolved_at IS NOT NULL
        )
    )
);

CREATE TABLE gallery_audit_events (
    audit_event_id TEXT PRIMARY KEY,
    subject_reference_hash TEXT NOT NULL
        CHECK (
            length(subject_reference_hash) = 64 AND
            subject_reference_hash NOT GLOB '*[^0-9a-f]*'
        ),
    event_type TEXT NOT NULL
        CHECK (
            length(event_type) BETWEEN 1 AND 100 AND
            event_type NOT GLOB '*[^a-z0-9-]*' AND
            event_type NOT LIKE '-%' AND
            event_type NOT LIKE '%-'
        ),
    state_version INTEGER
        CHECK (state_version IS NULL OR state_version >= 0),
    actor_identity_hash TEXT NOT NULL
        CHECK (
            length(actor_identity_hash) = 64 AND
            actor_identity_hash NOT GLOB '*[^0-9a-f]*'
        ),
    payload_hash TEXT NOT NULL
        CHECK (
            length(payload_hash) = 64 AND
            payload_hash NOT GLOB '*[^0-9a-f]*'
        ),
    occurred_at TEXT NOT NULL
);

CREATE TABLE gallery_retention_tombstones (
    draft_id TEXT PRIMARY KEY
        CHECK (length(draft_id) BETWEEN 20 AND 128),
    purge_kind TEXT NOT NULL
        CHECK (purge_kind IN ('consent-withdrawal', 'retention-expiry')),
    eligible_at TEXT NOT NULL,
    approved_at TEXT NOT NULL,
    approved_by_identity_hash TEXT NOT NULL
        CHECK (
            length(approved_by_identity_hash) = 64 AND
            approved_by_identity_hash NOT GLOB '*[^0-9a-f]*'
        ),
    evidence_hash TEXT NOT NULL
        CHECK (
            length(evidence_hash) = 64 AND
            evidence_hash NOT GLOB '*[^0-9a-f]*'
        ),
    CHECK (eligible_at <= approved_at)
);

CREATE TABLE phase_b_synthetic_records (
    record_id TEXT PRIMARY KEY,
    synthetic_text TEXT NOT NULL
        CHECK (synthetic_text = 'synthetic:phase-b-auth-boundary-v1'),
    actor_identity_hash TEXT NOT NULL
        CHECK (
            length(actor_identity_hash) = 64 AND
            actor_identity_hash NOT GLOB '*[^0-9a-f]*'
        ),
    created_at TEXT NOT NULL
);

CREATE INDEX gallery_drafts_state_index
    ON gallery_drafts(state, updated_at);

CREATE INDEX gallery_drafts_suppression_revision_index
    ON gallery_drafts(suppression_revision);

CREATE INDEX gallery_audit_events_subject_index
    ON gallery_audit_events(subject_reference_hash, occurred_at);

CREATE INDEX pending_athlete_exclusions_active_index
    ON pending_athlete_exclusions(resolved_at, athlete_id);

CREATE TRIGGER gallery_audit_events_no_update
BEFORE UPDATE ON gallery_audit_events
BEGIN
    SELECT RAISE(ABORT, 'gallery audit events are append-only');
END;

CREATE TRIGGER gallery_audit_events_no_delete
BEFORE DELETE ON gallery_audit_events
BEGIN
    SELECT RAISE(ABORT, 'gallery audit events are append-only');
END;

CREATE TRIGGER gallery_retention_tombstones_no_update
BEFORE UPDATE ON gallery_retention_tombstones
BEGIN
    SELECT RAISE(ABORT, 'gallery retention tombstones are append-only');
END;

CREATE TRIGGER gallery_retention_tombstones_no_delete
BEFORE DELETE ON gallery_retention_tombstones
BEGIN
    SELECT RAISE(ABORT, 'gallery retention tombstones are append-only');
END;

CREATE TRIGGER gallery_drafts_initial_state_guard
BEFORE INSERT ON gallery_drafts
WHEN NEW.state <> 'draft' OR
     NEW.state_version <> 0 OR
     NEW.active_consent_revision IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'gallery drafts must be inserted at draft version zero');
END;

CREATE TRIGGER gallery_drafts_no_replace_guard
BEFORE INSERT ON gallery_drafts
WHEN EXISTS (
    SELECT 1 FROM gallery_drafts AS existing
    WHERE existing.draft_id = NEW.draft_id
       OR existing.public_item_id = NEW.public_item_id
       OR (
           NEW.original_object_key IS NOT NULL AND
           existing.original_object_key = NEW.original_object_key
       )
)
BEGIN
    SELECT RAISE(ABORT, 'gallery draft replacement is forbidden');
END;

CREATE TRIGGER draft_consent_attestations_no_replace_guard
BEFORE INSERT ON draft_consent_attestations
WHEN EXISTS (
    SELECT 1 FROM draft_consent_attestations AS existing
    WHERE existing.draft_id = NEW.draft_id
      AND existing.consent_revision = NEW.consent_revision
)
BEGIN
    SELECT RAISE(ABORT, 'consent attestation replacement is forbidden');
END;

CREATE TRIGGER draft_derivatives_no_replace_guard
BEFORE INSERT ON draft_derivatives
WHEN EXISTS (
    SELECT 1 FROM draft_derivatives AS existing
    WHERE (existing.draft_id = NEW.draft_id AND existing.role = NEW.role)
       OR (
           NEW.staging_object_key IS NOT NULL AND
           existing.staging_object_key = NEW.staging_object_key
       )
       OR (
           NEW.approved_object_key IS NOT NULL AND
           existing.approved_object_key = NEW.approved_object_key
       )
)
BEGIN
    SELECT RAISE(ABORT, 'derivative evidence replacement is forbidden');
END;

CREATE TRIGGER draft_publication_references_no_replace_guard
BEFORE INSERT ON draft_publication_references
WHEN EXISTS (
    SELECT 1 FROM draft_publication_references AS existing
    WHERE existing.draft_id = NEW.draft_id
)
BEGIN
    SELECT RAISE(ABORT, 'publication evidence replacement is forbidden');
END;

CREATE TRIGGER draft_transition_receipts_no_replace_guard
BEFORE INSERT ON draft_transition_receipts
WHEN EXISTS (
    SELECT 1 FROM draft_transition_receipts AS existing
    WHERE existing.draft_id = NEW.draft_id
      AND existing.idempotency_key = NEW.idempotency_key
)
BEGIN
    SELECT RAISE(ABORT, 'transition receipt replacement is forbidden');
END;

CREATE TRIGGER pending_athlete_exclusions_no_replace_guard
BEFORE INSERT ON pending_athlete_exclusions
WHEN EXISTS (
    SELECT 1 FROM pending_athlete_exclusions AS existing
    WHERE existing.athlete_id = NEW.athlete_id
)
BEGIN
    SELECT RAISE(ABORT, 'pending athlete exclusion replacement is forbidden');
END;

CREATE TRIGGER gallery_audit_events_no_replace_guard
BEFORE INSERT ON gallery_audit_events
WHEN EXISTS (
    SELECT 1 FROM gallery_audit_events AS existing
    WHERE existing.audit_event_id = NEW.audit_event_id
)
BEGIN
    SELECT RAISE(ABORT, 'gallery audit event replacement is forbidden');
END;

CREATE TRIGGER gallery_retention_tombstones_no_replace_guard
BEFORE INSERT ON gallery_retention_tombstones
WHEN EXISTS (
    SELECT 1 FROM gallery_retention_tombstones AS existing
    WHERE existing.draft_id = NEW.draft_id
)
BEGIN
    SELECT RAISE(ABORT, 'gallery retention tombstone replacement is forbidden');
END;

CREATE TRIGGER phase_b_synthetic_records_no_replace_guard
BEFORE INSERT ON phase_b_synthetic_records
WHEN EXISTS (
    SELECT 1 FROM phase_b_synthetic_records AS existing
    WHERE existing.record_id = NEW.record_id
)
BEGIN
    SELECT RAISE(ABORT, 'Phase B synthetic record replacement is forbidden');
END;

CREATE TRIGGER gallery_drafts_identity_update_guard
BEFORE UPDATE OF draft_id ON gallery_drafts
WHEN NEW.draft_id IS NOT OLD.draft_id
BEGIN
    SELECT RAISE(ABORT, 'gallery draft identity is immutable');
END;

CREATE TRIGGER gallery_drafts_unique_update_guard
BEFORE UPDATE OF public_item_id, original_object_key ON gallery_drafts
WHEN EXISTS (
    SELECT 1 FROM gallery_drafts AS existing
    WHERE existing.draft_id <> OLD.draft_id
      AND (
          existing.public_item_id = NEW.public_item_id OR
          (
              NEW.original_object_key IS NOT NULL AND
              existing.original_object_key = NEW.original_object_key
          )
      )
)
BEGIN
    SELECT RAISE(ABORT, 'gallery draft update conflicts with existing storage ownership');
END;

CREATE TRIGGER draft_derivatives_identity_update_guard
BEFORE UPDATE OF draft_id, role ON draft_derivatives
WHEN NEW.draft_id IS NOT OLD.draft_id OR
     NEW.role IS NOT OLD.role
BEGIN
    SELECT RAISE(ABORT, 'derivative evidence identity is immutable');
END;

CREATE TRIGGER draft_derivatives_unique_update_guard
BEFORE UPDATE OF staging_object_key, approved_object_key ON draft_derivatives
WHEN EXISTS (
    SELECT 1 FROM draft_derivatives AS existing
    WHERE NOT (
              existing.draft_id = OLD.draft_id AND
              existing.role = OLD.role
          )
      AND (
          (
              NEW.staging_object_key IS NOT NULL AND
              existing.staging_object_key = NEW.staging_object_key
          ) OR
          (
              NEW.approved_object_key IS NOT NULL AND
              existing.approved_object_key = NEW.approved_object_key
          )
      )
)
BEGIN
    SELECT RAISE(ABORT, 'derivative update conflicts with existing storage ownership');
END;

CREATE TRIGGER draft_publication_references_identity_update_guard
BEFORE UPDATE OF draft_id ON draft_publication_references
WHEN NEW.draft_id IS NOT OLD.draft_id
BEGIN
    SELECT RAISE(ABORT, 'publication evidence identity is immutable');
END;

CREATE TRIGGER draft_transition_receipts_no_update
BEFORE UPDATE ON draft_transition_receipts
BEGIN
    SELECT RAISE(ABORT, 'transition receipt append-only update is forbidden');
END;

CREATE TRIGGER draft_transition_receipts_direct_delete_guard
BEFORE DELETE ON draft_transition_receipts
WHEN EXISTS (
    SELECT 1 FROM gallery_drafts AS parent
    WHERE parent.draft_id = OLD.draft_id
)
BEGIN
    SELECT RAISE(ABORT, 'transition receipt direct deletion is forbidden; approved draft purge only');
END;

CREATE TRIGGER gallery_drafts_active_consent_assignment_guard
BEFORE UPDATE OF active_consent_revision ON gallery_drafts
WHEN NEW.active_consent_revision IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM draft_consent_attestations AS consent
    WHERE consent.draft_id = NEW.draft_id
      AND consent.consent_revision = NEW.active_consent_revision
      AND consent.public_use_confirmed = 1
      AND (
          consent.contains_minors = 0 OR
          consent.guardian_approval_confirmed = 1
      )
      AND consent.withdrawn_at IS NULL
)
BEGIN
    SELECT RAISE(ABORT, 'active consent must reference a valid attestation');
END;

CREATE TRIGGER gallery_drafts_consent_state_gate_guard
BEFORE UPDATE OF state, active_consent_revision ON gallery_drafts
WHEN NEW.state IN (
    'approved-for-processing',
    'processing',
    'candidate-public',
    'pr-open',
    'published'
) AND NOT EXISTS (
    SELECT 1
    FROM draft_consent_attestations AS consent
    WHERE consent.draft_id = NEW.draft_id
      AND consent.consent_revision = NEW.active_consent_revision
      AND consent.public_use_confirmed = 1
      AND (
          consent.contains_minors = 0 OR
          consent.guardian_approval_confirmed = 1
      )
      AND consent.withdrawn_at IS NULL
)
BEGIN
    SELECT RAISE(ABORT, 'valid active consent is required for this state');
END;

CREATE TRIGGER gallery_drafts_derivative_revision_change_guard
BEFORE UPDATE OF
    item_revision,
    active_consent_revision,
    export_bundle_id,
    source_revision,
    suppression_revision
ON gallery_drafts
WHEN (
    NEW.item_revision IS NOT OLD.item_revision OR
    NEW.active_consent_revision IS NOT OLD.active_consent_revision OR
    NEW.export_bundle_id IS NOT OLD.export_bundle_id OR
    NEW.source_revision IS NOT OLD.source_revision OR
    NEW.suppression_revision IS NOT OLD.suppression_revision
) AND EXISTS (
    SELECT 1 FROM draft_derivatives AS derivative
    WHERE derivative.draft_id = OLD.draft_id
)
BEGIN
    SELECT RAISE(ABORT, 'derivative evidence must be cleared before a bound revision changes');
END;

CREATE TRIGGER gallery_drafts_item_revision_guard
BEFORE UPDATE OF
    public_item_id,
    site_modes_json,
    media_type,
    race_date,
    race_event,
    race_distance,
    athlete_ids_json,
    title,
    caption,
    alt_text,
    featured,
    editorial_position
ON gallery_drafts
WHEN (
    NEW.public_item_id IS NOT OLD.public_item_id OR
    NEW.site_modes_json IS NOT OLD.site_modes_json OR
    NEW.media_type IS NOT OLD.media_type OR
    NEW.race_date IS NOT OLD.race_date OR
    NEW.race_event IS NOT OLD.race_event OR
    NEW.race_distance IS NOT OLD.race_distance OR
    NEW.athlete_ids_json IS NOT OLD.athlete_ids_json OR
    NEW.title IS NOT OLD.title OR
    NEW.caption IS NOT OLD.caption OR
    NEW.alt_text IS NOT OLD.alt_text OR
    NEW.featured IS NOT OLD.featured OR
    NEW.editorial_position IS NOT OLD.editorial_position
) AND NEW.item_revision IS OLD.item_revision
BEGIN
    SELECT RAISE(ABORT, 'gallery item changes require a new item revision');
END;

CREATE TRIGGER draft_consent_attestations_immutable_guard
BEFORE UPDATE OF
    draft_id,
    consent_revision,
    public_use_confirmed,
    contains_minors,
    guardian_approval_confirmed,
    private_evidence_reference,
    verified_owner_identity_hash,
    attested_at
ON draft_consent_attestations
WHEN NEW.draft_id IS NOT OLD.draft_id OR
     NEW.consent_revision IS NOT OLD.consent_revision OR
     NEW.public_use_confirmed IS NOT OLD.public_use_confirmed OR
     NEW.contains_minors IS NOT OLD.contains_minors OR
     NEW.guardian_approval_confirmed IS NOT OLD.guardian_approval_confirmed OR
     NEW.private_evidence_reference IS NOT OLD.private_evidence_reference OR
     NEW.verified_owner_identity_hash IS NOT OLD.verified_owner_identity_hash OR
     NEW.attested_at IS NOT OLD.attested_at
BEGIN
    SELECT RAISE(ABORT, 'consent attestation evidence is immutable');
END;

CREATE TRIGGER draft_consent_withdrawal_shape_guard
BEFORE UPDATE OF withdrawn_at ON draft_consent_attestations
WHEN OLD.withdrawn_at IS NOT NULL OR
     NEW.withdrawn_at IS NULL OR
     length(NEW.withdrawn_at) = 0
BEGIN
    SELECT RAISE(ABORT, 'consent withdrawal is one-way and timestamped');
END;

CREATE TRIGGER draft_consent_withdrawal_evidence_guard
BEFORE UPDATE OF withdrawn_at ON draft_consent_attestations
WHEN EXISTS (
    SELECT 1
    FROM gallery_drafts AS draft
    WHERE draft.draft_id = OLD.draft_id
      AND draft.active_consent_revision = OLD.consent_revision
) AND NOT EXISTS (
    SELECT 1
    FROM gallery_drafts AS draft
    JOIN draft_publication_references AS publication
      ON publication.draft_id = draft.draft_id
    WHERE draft.draft_id = OLD.draft_id
      AND draft.state = 'withdrawal-pending'
      AND publication.withdrawal_kind = 'consent-withdrawal'
      AND publication.host_deletion_confirmed = 1
      AND publication.private_original_deletion_confirmed = 1
      AND NOT EXISTS (
          SELECT 1 FROM draft_derivatives AS derivative
          WHERE derivative.draft_id = draft.draft_id
      )
)
BEGIN
    SELECT RAISE(ABORT, 'consent withdrawal requires verified object deletion');
END;

CREATE TRIGGER draft_consent_withdrawal_deactivate
AFTER UPDATE OF withdrawn_at ON draft_consent_attestations
WHEN NEW.withdrawn_at IS NOT NULL
BEGIN
    UPDATE gallery_drafts
    SET active_consent_revision = NULL,
        updated_at = NEW.withdrawn_at
    WHERE draft_id = NEW.draft_id
      AND active_consent_revision = NEW.consent_revision;
END;

CREATE TRIGGER draft_derivatives_revision_insert_guard
BEFORE INSERT ON draft_derivatives
WHEN NOT EXISTS (
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
)
BEGIN
    SELECT RAISE(ABORT, 'derivative evidence revisions are stale');
END;

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
)
BEGIN
    SELECT RAISE(ABORT, 'updated derivative evidence revisions are stale');
END;

CREATE TRIGGER draft_derivatives_pending_exclusion_insert_guard
BEFORE INSERT ON draft_derivatives
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
    SELECT RAISE(ABORT, 'pending athlete exclusion blocks derivative evidence');
END;

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
)
BEGIN
    SELECT RAISE(ABORT, 'pending athlete exclusion blocks derivative evidence');
END;

CREATE TRIGGER gallery_drafts_state_version_guard
BEFORE UPDATE OF state, state_version ON gallery_drafts
WHEN (
    (NEW.state = OLD.state AND NEW.state_version <> OLD.state_version) OR
    (NEW.state <> OLD.state AND NEW.state_version <> OLD.state_version + 1)
)
BEGIN
    SELECT RAISE(ABORT, 'gallery draft state version must use one-step compare-and-swap');
END;

CREATE TRIGGER gallery_drafts_transition_guard
BEFORE UPDATE OF state ON gallery_drafts
WHEN NEW.state <> OLD.state AND NOT (
    (OLD.state = 'draft' AND NEW.state IN ('uploading', 'withdrawal-pending')) OR
    (OLD.state = 'uploading' AND NEW.state IN ('private-review', 'withdrawal-pending')) OR
    (OLD.state = 'private-review' AND NEW.state IN (
        'approved-for-processing', 'rejected', 'withdrawal-pending'
    )) OR
    (OLD.state = 'approved-for-processing' AND NEW.state IN (
        'private-review', 'processing', 'withdrawal-pending'
    )) OR
    (OLD.state = 'processing' AND NEW.state IN (
        'candidate-public', 'processing-failed', 'withdrawal-pending'
    )) OR
    (OLD.state = 'processing-failed' AND NEW.state IN (
        'approved-for-processing', 'withdrawal-pending'
    )) OR
    (OLD.state = 'candidate-public' AND NEW.state IN (
        'private-review', 'pr-open', 'withdrawal-pending'
    )) OR
    (OLD.state = 'pr-open' AND NEW.state IN (
        'candidate-public', 'published', 'withdrawal-pending'
    )) OR
    (OLD.state = 'published' AND NEW.state = 'withdrawal-pending') OR
    (OLD.state = 'rejected' AND NEW.state IN ('draft', 'withdrawal-pending')) OR
    (OLD.state = 'withdrawal-pending' AND NEW.state = 'withdrawn')
)
BEGIN
    SELECT RAISE(ABORT, 'invalid gallery draft state transition');
END;

CREATE TRIGGER gallery_drafts_withdrawal_evidence_guard
BEFORE UPDATE OF state ON gallery_drafts
WHEN NEW.state = 'withdrawn' AND NOT EXISTS (
    SELECT 1
    FROM draft_publication_references AS publication
    WHERE publication.draft_id = OLD.draft_id
      AND publication.withdrawal_kind IS NOT NULL
      AND publication.host_deletion_confirmed = 1
      AND (
          publication.withdrawal_kind <> 'consent-withdrawal' OR
          publication.private_original_deletion_confirmed = 1
      )
)
BEGIN
    SELECT RAISE(ABORT, 'verified withdrawal evidence is required');
END;

CREATE TRIGGER pending_athlete_exclusions_immutable_guard
BEFORE UPDATE OF
    athlete_id,
    exclusion_revision,
    expected_suppression_revision,
    request_audit_hash,
    actor_identity_hash,
    created_at
ON pending_athlete_exclusions
WHEN NEW.athlete_id IS NOT OLD.athlete_id OR
     NEW.exclusion_revision IS NOT OLD.exclusion_revision OR
     NEW.expected_suppression_revision IS NOT OLD.expected_suppression_revision OR
     NEW.request_audit_hash IS NOT OLD.request_audit_hash OR
     NEW.actor_identity_hash IS NOT OLD.actor_identity_hash OR
     NEW.created_at IS NOT OLD.created_at
BEGIN
    SELECT RAISE(ABORT, 'pending athlete exclusion evidence is immutable');
END;

CREATE TRIGGER pending_athlete_exclusions_resolution_guard
BEFORE UPDATE ON pending_athlete_exclusions
WHEN OLD.resolved_at IS NOT NULL OR
     NEW.resolved_suppression_revision IS NULL OR
     NEW.resolution_audit_hash IS NULL OR
     NEW.resolved_at IS NULL OR
     NEW.updated_at IS OLD.updated_at
BEGIN
    SELECT RAISE(ABORT, 'pending athlete exclusion resolution requires complete evidence');
END;

CREATE TRIGGER pending_athlete_exclusions_delete_guard
BEFORE DELETE ON pending_athlete_exclusions
WHEN OLD.resolved_at IS NULL
BEGIN
    SELECT RAISE(ABORT, 'an unresolved athlete exclusion cannot be deleted');
END;

CREATE TRIGGER gallery_drafts_pending_exclusion_insert_guard
BEFORE INSERT ON gallery_drafts
WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.athlete_ids_json) AS tag
    JOIN pending_athlete_exclusions AS exclusion
      ON exclusion.athlete_id = tag.value
    WHERE exclusion.resolved_at IS NULL
)
BEGIN
    SELECT RAISE(ABORT, 'gallery draft contains a pending athlete exclusion');
END;

CREATE TRIGGER gallery_drafts_pending_exclusion_tag_guard
BEFORE UPDATE OF athlete_ids_json ON gallery_drafts
WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.athlete_ids_json) AS tag
    JOIN pending_athlete_exclusions AS exclusion
      ON exclusion.athlete_id = tag.value
    WHERE exclusion.resolved_at IS NULL
)
OR EXISTS (
    SELECT 1
    FROM json_each(OLD.athlete_ids_json) AS tag
    JOIN pending_athlete_exclusions AS exclusion
      ON exclusion.athlete_id = tag.value
    WHERE exclusion.resolved_at IS NULL
)
BEGIN
    SELECT RAISE(ABORT, 'gallery tags contain a pending athlete exclusion');
END;

CREATE TRIGGER gallery_drafts_pending_exclusion_state_guard
BEFORE UPDATE OF state ON gallery_drafts
WHEN NEW.state IN (
    'approved-for-processing',
    'processing',
    'candidate-public',
    'pr-open',
    'published'
) AND EXISTS (
    SELECT 1
    FROM json_each(NEW.athlete_ids_json) AS tag
    JOIN pending_athlete_exclusions AS exclusion
      ON exclusion.athlete_id = tag.value
    WHERE exclusion.resolved_at IS NULL
)
BEGIN
    SELECT RAISE(ABORT, 'pending athlete exclusion blocks gallery advancement');
END;

CREATE TRIGGER gallery_drafts_purge_guard
BEFORE DELETE ON gallery_drafts
WHEN NOT EXISTS (
    SELECT 1
    FROM gallery_retention_tombstones AS tombstone
    JOIN draft_publication_references AS publication
      ON publication.draft_id = OLD.draft_id
    WHERE tombstone.draft_id = OLD.draft_id
      AND publication.host_deletion_confirmed = 1
      AND publication.private_original_deletion_confirmed = 1
      AND (
          (
              tombstone.purge_kind = 'consent-withdrawal' AND
              OLD.state = 'withdrawn' AND
              publication.withdrawal_kind = 'consent-withdrawal'
          ) OR (
              tombstone.purge_kind = 'retention-expiry' AND
              OLD.state IN ('rejected', 'withdrawn', 'processing-failed')
          )
      )
)
BEGIN
    SELECT RAISE(ABORT, 'gallery draft purge requires approved cleanup evidence');
END;
