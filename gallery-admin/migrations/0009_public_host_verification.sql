PRAGMA foreign_keys = ON;

-- Public-host absence is a separate fact from approved R2 absence.  The media
-- delivery epoch is append-only so a Worker, binding, witness, or fixed-origin
-- change has an explicit database identity.  The singleton pointer may move
-- only to the next registered and activated epoch.
CREATE TABLE gallery_media_delivery_epochs (
    epoch_id TEXT PRIMARY KEY
        CHECK (
            length(epoch_id) BETWEEN 16 AND 128 AND
            epoch_id NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
    epoch_id_hash TEXT NOT NULL UNIQUE
        CHECK (length(epoch_id_hash) = 64 AND epoch_id_hash NOT GLOB '*[^0-9a-f]*'),
    epoch_sequence INTEGER NOT NULL UNIQUE CHECK (epoch_sequence >= 1),
    approved_origin TEXT NOT NULL,
    approved_origin_hash TEXT NOT NULL
        CHECK (
            length(approved_origin_hash) = 64 AND
            approved_origin_hash NOT GLOB '*[^0-9a-f]*'
        ),
    delivery_contract_hash TEXT NOT NULL
        CHECK (
            length(delivery_contract_hash) = 64 AND
            delivery_contract_hash NOT GLOB '*[^0-9a-f]*'
        ),
    delivery_version_hash TEXT NOT NULL
        CHECK (
            length(delivery_version_hash) = 64 AND
            delivery_version_hash NOT GLOB '*[^0-9a-f]*'
        ),
    witness_object_key_hash TEXT NOT NULL
        CHECK (
            length(witness_object_key_hash) = 64 AND
            witness_object_key_hash NOT GLOB '*[^0-9a-f]*'
        ),
    witness_sha256 TEXT NOT NULL
        CHECK (length(witness_sha256) = 64 AND witness_sha256 NOT GLOB '*[^0-9a-f]*'),
    witness_byte_count INTEGER NOT NULL CHECK (witness_byte_count > 0),
    witness_content_type TEXT NOT NULL CHECK (witness_content_type = 'image/webp'),
    configuration_hash TEXT NOT NULL UNIQUE
        CHECK (
            length(configuration_hash) = 64 AND
            configuration_hash NOT GLOB '*[^0-9a-f]*'
        ),
    registered_by_identity_hash TEXT NOT NULL
        CHECK (
            length(registered_by_identity_hash) = 64 AND
            registered_by_identity_hash NOT GLOB '*[^0-9a-f]*'
        ),
    registered_at TEXT NOT NULL,
    CHECK (
        approved_origin = lower(approved_origin) AND
        substr(approved_origin, 1, 8) = 'https://' AND
        length(approved_origin) BETWEEN 12 AND 253 AND
        substr(approved_origin, 9) NOT GLOB '*[/?#@\\% ]*' AND
        instr(substr(approved_origin, 9), ':') = 0 AND
        substr(approved_origin, -1) NOT IN ('.', '-')
    )
);

CREATE TABLE gallery_media_delivery_epoch_activations (
    activation_receipt_hash TEXT PRIMARY KEY
        CHECK (
            length(activation_receipt_hash) = 64 AND
            activation_receipt_hash NOT GLOB '*[^0-9a-f]*'
        ),
    epoch_id_hash TEXT NOT NULL UNIQUE
        CHECK (length(epoch_id_hash) = 64 AND epoch_id_hash NOT GLOB '*[^0-9a-f]*'),
    epoch_sequence INTEGER NOT NULL UNIQUE CHECK (epoch_sequence >= 1),
    previous_epoch_id_hash TEXT
        CHECK (
            previous_epoch_id_hash IS NULL OR (
                length(previous_epoch_id_hash) = 64 AND
                previous_epoch_id_hash NOT GLOB '*[^0-9a-f]*'
            )
        ),
    activation_idempotency_key_hash TEXT NOT NULL UNIQUE
        CHECK (
            length(activation_idempotency_key_hash) = 64 AND
            activation_idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
        ),
    activation_payload_hash TEXT NOT NULL UNIQUE
        CHECK (
            length(activation_payload_hash) = 64 AND
            activation_payload_hash NOT GLOB '*[^0-9a-f]*'
        ),
    service_actor_identity_hash TEXT NOT NULL
        CHECK (
            length(service_actor_identity_hash) = 64 AND
            service_actor_identity_hash NOT GLOB '*[^0-9a-f]*'
        ),
    activated_at TEXT NOT NULL,
    FOREIGN KEY (epoch_id_hash)
        REFERENCES gallery_media_delivery_epochs(epoch_id_hash),
    CHECK (
        (epoch_sequence = 1 AND previous_epoch_id_hash IS NULL) OR
        (epoch_sequence > 1 AND previous_epoch_id_hash IS NOT NULL)
    )
);

CREATE TABLE gallery_media_delivery_current_epoch (
    singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
    epoch_id_hash TEXT NOT NULL UNIQUE
        CHECK (length(epoch_id_hash) = 64 AND epoch_id_hash NOT GLOB '*[^0-9a-f]*'),
    epoch_sequence INTEGER NOT NULL UNIQUE CHECK (epoch_sequence >= 1),
    activation_receipt_hash TEXT NOT NULL UNIQUE
        CHECK (
            length(activation_receipt_hash) = 64 AND
            activation_receipt_hash NOT GLOB '*[^0-9a-f]*'
        ),
    activated_at TEXT NOT NULL,
    FOREIGN KEY (epoch_id_hash)
        REFERENCES gallery_media_delivery_epochs(epoch_id_hash),
    FOREIGN KEY (activation_receipt_hash)
        REFERENCES gallery_media_delivery_epoch_activations(activation_receipt_hash)
);

-- One raw generation survives approved-media cleanup so every URL that may
-- ever have been public remains enumerable.  It disappears only with the
-- approved parent-draft purge.  The promotion itself is intentionally not a
-- foreign key because promotion cleanup removes that operational row earlier.
CREATE TABLE draft_photo_public_generations (
    promotion_id TEXT PRIMARY KEY
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
    draft_id TEXT NOT NULL,
    draft_id_hash TEXT NOT NULL
        CHECK (length(draft_id_hash) = 64 AND draft_id_hash NOT GLOB '*[^0-9a-f]*'),
    approved_origin TEXT NOT NULL,
    approved_origin_hash TEXT NOT NULL
        CHECK (
            length(approved_origin_hash) = 64 AND
            approved_origin_hash NOT GLOB '*[^0-9a-f]*'
        ),
    candidate_state_version INTEGER NOT NULL CHECK (candidate_state_version >= 1),
    generation_fingerprint TEXT NOT NULL UNIQUE
        CHECK (
            length(generation_fingerprint) = 64 AND
            generation_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
    target_set_hash TEXT NOT NULL
        CHECK (length(target_set_hash) = 64 AND target_set_hash NOT GLOB '*[^0-9a-f]*'),
    created_at TEXT NOT NULL,
    UNIQUE (draft_id, candidate_state_version),
    FOREIGN KEY (draft_id) REFERENCES gallery_drafts(draft_id)
        ON DELETE CASCADE,
    CHECK (
        approved_origin = lower(approved_origin) AND
        substr(approved_origin, 1, 8) = 'https://' AND
        length(approved_origin) BETWEEN 12 AND 253 AND
        substr(approved_origin, 9) NOT GLOB '*[/?#@\\% ]*' AND
        instr(substr(approved_origin, 9), ':') = 0 AND
        substr(approved_origin, -1) NOT IN ('.', '-')
    )
);

CREATE TABLE draft_photo_public_generation_targets (
    promotion_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('photo-display', 'photo-thumbnail')),
    approved_object_key TEXT NOT NULL,
    approved_object_key_hash TEXT NOT NULL
        CHECK (
            length(approved_object_key_hash) = 64 AND
            approved_object_key_hash NOT GLOB '*[^0-9a-f]*'
        ),
    public_url_hash TEXT NOT NULL
        CHECK (length(public_url_hash) = 64 AND public_url_hash NOT GLOB '*[^0-9a-f]*'),
    expected_sha256 TEXT NOT NULL
        CHECK (length(expected_sha256) = 64 AND expected_sha256 NOT GLOB '*[^0-9a-f]*'),
    generation_target_set_hash TEXT NOT NULL
        CHECK (
            length(generation_target_set_hash) = 64 AND
            generation_target_set_hash NOT GLOB '*[^0-9a-f]*'
        ),
    created_at TEXT NOT NULL,
    PRIMARY KEY (promotion_id, role),
    UNIQUE (approved_object_key),
    UNIQUE (approved_object_key_hash),
    UNIQUE (public_url_hash),
    FOREIGN KEY (promotion_id)
        REFERENCES draft_photo_public_generations(promotion_id)
        ON DELETE CASCADE,
    CHECK (
        approved_object_key = 'media/v1/' || expected_sha256 ||
            CASE role
                WHEN 'photo-display' THEN '/display.webp'
                ELSE '/thumbnail.webp'
            END
    )
);

-- The verifier operation keeps raw draft identity only until draft purge.
-- Every permanent receipt below contains hashes only.
CREATE TABLE draft_public_host_absence_verifications (
    verification_id TEXT PRIMARY KEY
        CHECK (
            length(verification_id) = 43 AND
            substr(verification_id, 1, 11) = 'hostverify_' AND
            substr(verification_id, 12) NOT GLOB '*[^0-9a-f]*'
        ),
    verification_id_hash TEXT NOT NULL UNIQUE
        CHECK (
            length(verification_id_hash) = 64 AND
            verification_id_hash NOT GLOB '*[^0-9a-f]*'
        ),
    draft_id TEXT NOT NULL,
    draft_id_hash TEXT NOT NULL
        CHECK (length(draft_id_hash) = 64 AND draft_id_hash NOT GLOB '*[^0-9a-f]*'),
    expected_state_version INTEGER NOT NULL CHECK (expected_state_version >= 0),
    verification_purpose TEXT NOT NULL DEFAULT 'withdrawal'
        CHECK (verification_purpose IN ('withdrawal', 'retention-expiry')),
    purpose_evidence_hash TEXT
        CHECK (
            purpose_evidence_hash IS NULL OR (
                length(purpose_evidence_hash) = 64 AND
                purpose_evidence_hash NOT GLOB '*[^0-9a-f]*'
            )
        ),
    withdrawal_kind TEXT NOT NULL
        CHECK (withdrawal_kind IN (
            'editorial-removal', 'athlete-exclusion', 'consent-withdrawal',
            'retention-expiry'
        )),
    withdrawal_cycle_hash TEXT NOT NULL
        CHECK (
            length(withdrawal_cycle_hash) = 64 AND
            withdrawal_cycle_hash NOT GLOB '*[^0-9a-f]*'
        ),
    promotion_set_hash TEXT NOT NULL
        CHECK (
            length(promotion_set_hash) = 64 AND
            promotion_set_hash NOT GLOB '*[^0-9a-f]*'
        ),
    cleanup_evidence_set_hash TEXT NOT NULL
        CHECK (
            length(cleanup_evidence_set_hash) = 64 AND
            cleanup_evidence_set_hash NOT GLOB '*[^0-9a-f]*'
        ),
    approved_origin_hash TEXT NOT NULL
        CHECK (
            length(approved_origin_hash) = 64 AND
            approved_origin_hash NOT GLOB '*[^0-9a-f]*'
        ),
    target_set_hash TEXT NOT NULL
        CHECK (length(target_set_hash) = 64 AND target_set_hash NOT GLOB '*[^0-9a-f]*'),
    generation_count INTEGER NOT NULL CHECK (generation_count >= 0),
    generation_target_row_count INTEGER NOT NULL
        CHECK (generation_target_row_count = generation_count * 2),
    target_count INTEGER NOT NULL CHECK (target_count >= 0),
    media_delivery_epoch_id_hash TEXT NOT NULL
        CHECK (
            length(media_delivery_epoch_id_hash) = 64 AND
            media_delivery_epoch_id_hash NOT GLOB '*[^0-9a-f]*'
        ),
    delivery_contract_hash TEXT NOT NULL
        CHECK (
            length(delivery_contract_hash) = 64 AND
            delivery_contract_hash NOT GLOB '*[^0-9a-f]*'
        ),
    delivery_version_hash TEXT NOT NULL
        CHECK (
            length(delivery_version_hash) = 64 AND
            delivery_version_hash NOT GLOB '*[^0-9a-f]*'
        ),
    idempotency_key TEXT NOT NULL
        CHECK (
            length(idempotency_key) BETWEEN 16 AND 128 AND
            idempotency_key NOT GLOB '*[^A-Za-z0-9_-]*'
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
    service_actor_identity_hash TEXT NOT NULL
        CHECK (
            length(service_actor_identity_hash) = 64 AND
            service_actor_identity_hash NOT GLOB '*[^0-9a-f]*'
        ),
    created_at TEXT NOT NULL,
    UNIQUE (
        draft_id, expected_state_version, media_delivery_epoch_id_hash,
        verification_purpose, withdrawal_cycle_hash, service_actor_identity_hash
    ),
    UNIQUE (draft_id, idempotency_key),
    FOREIGN KEY (draft_id) REFERENCES gallery_drafts(draft_id)
        ON DELETE CASCADE,
    CHECK (
        generation_count > 0 OR (
            generation_target_row_count = 0 AND
            target_count = 0 AND
            promotion_set_hash =
                'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' AND
            cleanup_evidence_set_hash =
                'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' AND
            target_set_hash =
                'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
        )
    ),
    CHECK (
        (
            verification_purpose = 'withdrawal' AND
            withdrawal_kind IN (
                'editorial-removal', 'athlete-exclusion', 'consent-withdrawal'
            ) AND
            purpose_evidence_hash IS NULL
        ) OR (
            verification_purpose = 'retention-expiry' AND
            withdrawal_kind = 'retention-expiry' AND
            purpose_evidence_hash IS NOT NULL
        )
    )
);

-- A reservation is permanent and hash-only.  Its first cycle, actor,
-- verification, and idempotency hashes are immutable audit facts.  Later
-- attempts may reuse only the exact key/promotion/draft lineage; no later
-- promotion can resurrect a retired content-addressed URL.
CREATE TABLE gallery_approved_media_key_retirement_reservations (
    approved_object_key_hash TEXT PRIMARY KEY
        CHECK (
            length(approved_object_key_hash) = 64 AND
            approved_object_key_hash NOT GLOB '*[^0-9a-f]*'
        ),
    verification_id_hash TEXT NOT NULL,
    promotion_id_hash TEXT NOT NULL,
    draft_id_hash TEXT NOT NULL,
    withdrawal_cycle_hash TEXT NOT NULL,
    reservation_idempotency_key_hash TEXT NOT NULL,
    reserved_by_identity_hash TEXT NOT NULL,
    reserved_at TEXT NOT NULL,
    CHECK (length(verification_id_hash) = 64 AND verification_id_hash NOT GLOB '*[^0-9a-f]*'),
    CHECK (length(promotion_id_hash) = 64 AND promotion_id_hash NOT GLOB '*[^0-9a-f]*'),
    CHECK (length(draft_id_hash) = 64 AND draft_id_hash NOT GLOB '*[^0-9a-f]*'),
    CHECK (length(withdrawal_cycle_hash) = 64 AND withdrawal_cycle_hash NOT GLOB '*[^0-9a-f]*'),
    CHECK (
        length(reservation_idempotency_key_hash) = 64 AND
        reservation_idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
    ),
    CHECK (
        length(reserved_by_identity_hash) = 64 AND
        reserved_by_identity_hash NOT GLOB '*[^0-9a-f]*'
    )
);

CREATE TABLE draft_public_host_absence_target_proofs (
    verification_id TEXT NOT NULL,
    approved_object_key_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('photo-display', 'photo-thumbnail')),
    public_url_hash TEXT NOT NULL,
    expected_sha256 TEXT NOT NULL,
    head_evidence_hash TEXT NOT NULL,
    get_evidence_hash TEXT NOT NULL,
    final_head_evidence_hash TEXT NOT NULL,
    observed_contract_hash TEXT NOT NULL,
    observed_version_hash TEXT NOT NULL,
    verified_at TEXT NOT NULL,
    PRIMARY KEY (verification_id, approved_object_key_hash),
    FOREIGN KEY (verification_id)
        REFERENCES draft_public_host_absence_verifications(verification_id)
        ON DELETE CASCADE,
    CHECK (length(approved_object_key_hash) = 64 AND approved_object_key_hash NOT GLOB '*[^0-9a-f]*'),
    CHECK (length(public_url_hash) = 64 AND public_url_hash NOT GLOB '*[^0-9a-f]*'),
    CHECK (length(expected_sha256) = 64 AND expected_sha256 NOT GLOB '*[^0-9a-f]*'),
    CHECK (length(head_evidence_hash) = 64 AND head_evidence_hash NOT GLOB '*[^0-9a-f]*'),
    CHECK (length(get_evidence_hash) = 64 AND get_evidence_hash NOT GLOB '*[^0-9a-f]*'),
    CHECK (
        length(final_head_evidence_hash) = 64 AND
        final_head_evidence_hash NOT GLOB '*[^0-9a-f]*'
    ),
    CHECK (length(observed_contract_hash) = 64 AND observed_contract_hash NOT GLOB '*[^0-9a-f]*'),
    CHECK (length(observed_version_hash) = 64 AND observed_version_hash NOT GLOB '*[^0-9a-f]*')
);

CREATE TABLE draft_public_host_absence_witness_proofs (
    verification_id TEXT PRIMARY KEY,
    witness_object_key_hash TEXT NOT NULL,
    witness_sha256 TEXT NOT NULL,
    witness_byte_count INTEGER NOT NULL CHECK (witness_byte_count > 0),
    witness_content_type TEXT NOT NULL CHECK (witness_content_type = 'image/webp'),
    before_head_evidence_hash TEXT NOT NULL,
    before_get_evidence_hash TEXT NOT NULL,
    after_head_evidence_hash TEXT NOT NULL,
    after_get_evidence_hash TEXT NOT NULL,
    observed_contract_hash TEXT NOT NULL,
    observed_version_hash TEXT NOT NULL,
    verified_at TEXT NOT NULL,
    FOREIGN KEY (verification_id)
        REFERENCES draft_public_host_absence_verifications(verification_id)
        ON DELETE CASCADE,
    CHECK (length(witness_object_key_hash) = 64 AND witness_object_key_hash NOT GLOB '*[^0-9a-f]*'),
    CHECK (length(witness_sha256) = 64 AND witness_sha256 NOT GLOB '*[^0-9a-f]*'),
    CHECK (length(before_head_evidence_hash) = 64 AND before_head_evidence_hash NOT GLOB '*[^0-9a-f]*'),
    CHECK (length(before_get_evidence_hash) = 64 AND before_get_evidence_hash NOT GLOB '*[^0-9a-f]*'),
    CHECK (length(after_head_evidence_hash) = 64 AND after_head_evidence_hash NOT GLOB '*[^0-9a-f]*'),
    CHECK (length(after_get_evidence_hash) = 64 AND after_get_evidence_hash NOT GLOB '*[^0-9a-f]*'),
    CHECK (length(observed_contract_hash) = 64 AND observed_contract_hash NOT GLOB '*[^0-9a-f]*'),
    CHECK (length(observed_version_hash) = 64 AND observed_version_hash NOT GLOB '*[^0-9a-f]*')
);

-- This is the final purge survivor.  It intentionally has no foreign key and
-- contains no draft ID, promotion ID, key, origin, URL, or idempotency key.
CREATE TABLE gallery_public_host_absence_receipts (
    final_receipt_hash TEXT PRIMARY KEY
        CHECK (
            length(final_receipt_hash) = 64 AND
            final_receipt_hash NOT GLOB '*[^0-9a-f]*'
        ),
    verification_id_hash TEXT NOT NULL UNIQUE,
    draft_id_hash TEXT NOT NULL,
    promotion_set_hash TEXT NOT NULL,
    cleanup_evidence_set_hash TEXT NOT NULL,
    withdrawal_cycle_hash TEXT NOT NULL,
    approved_origin_hash TEXT NOT NULL,
    target_set_hash TEXT NOT NULL,
    generation_count INTEGER NOT NULL CHECK (generation_count >= 0),
    target_count INTEGER NOT NULL CHECK (target_count >= 0),
    verified_state_version INTEGER NOT NULL CHECK (verified_state_version >= 0),
    verification_purpose TEXT NOT NULL DEFAULT 'withdrawal'
        CHECK (verification_purpose IN ('withdrawal', 'retention-expiry')),
    purpose_evidence_hash TEXT
        CHECK (
            purpose_evidence_hash IS NULL OR (
                length(purpose_evidence_hash) = 64 AND
                purpose_evidence_hash NOT GLOB '*[^0-9a-f]*'
            )
        ),
    media_delivery_epoch_id_hash TEXT NOT NULL,
    delivery_contract_hash TEXT NOT NULL,
    delivery_version_hash TEXT NOT NULL,
    idempotency_key_hash TEXT NOT NULL UNIQUE,
    payload_fingerprint TEXT NOT NULL,
    verified_at TEXT NOT NULL,
    CHECK (length(verification_id_hash) = 64 AND verification_id_hash NOT GLOB '*[^0-9a-f]*'),
    CHECK (length(draft_id_hash) = 64 AND draft_id_hash NOT GLOB '*[^0-9a-f]*'),
    CHECK (length(promotion_set_hash) = 64 AND promotion_set_hash NOT GLOB '*[^0-9a-f]*'),
    CHECK (length(cleanup_evidence_set_hash) = 64 AND cleanup_evidence_set_hash NOT GLOB '*[^0-9a-f]*'),
    CHECK (length(withdrawal_cycle_hash) = 64 AND withdrawal_cycle_hash NOT GLOB '*[^0-9a-f]*'),
    CHECK (length(approved_origin_hash) = 64 AND approved_origin_hash NOT GLOB '*[^0-9a-f]*'),
    CHECK (length(target_set_hash) = 64 AND target_set_hash NOT GLOB '*[^0-9a-f]*'),
    CHECK (
        length(media_delivery_epoch_id_hash) = 64 AND
        media_delivery_epoch_id_hash NOT GLOB '*[^0-9a-f]*'
    ),
    CHECK (length(delivery_contract_hash) = 64 AND delivery_contract_hash NOT GLOB '*[^0-9a-f]*'),
    CHECK (length(delivery_version_hash) = 64 AND delivery_version_hash NOT GLOB '*[^0-9a-f]*'),
    CHECK (length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'),
    CHECK (length(payload_fingerprint) = 64 AND payload_fingerprint NOT GLOB '*[^0-9a-f]*'),
    CHECK (
        (verification_purpose = 'withdrawal' AND purpose_evidence_hash IS NULL) OR
        (verification_purpose = 'retention-expiry' AND purpose_evidence_hash IS NOT NULL)
    )
);

CREATE INDEX draft_photo_public_generations_draft_index
    ON draft_photo_public_generations(draft_id, candidate_state_version);
CREATE INDEX draft_public_host_absence_verifications_draft_index
    ON draft_public_host_absence_verifications(draft_id, expected_state_version);
CREATE INDEX gallery_public_host_absence_receipts_draft_hash_index
    ON gallery_public_host_absence_receipts(draft_id_hash, verified_state_version);

-- All permanent and operational ledgers explicitly resist REPLACE collisions.
CREATE TRIGGER gallery_media_delivery_epochs_no_replace_guard
BEFORE INSERT ON gallery_media_delivery_epochs
WHEN EXISTS (
    SELECT 1 FROM gallery_media_delivery_epochs AS existing
    WHERE existing.epoch_id = NEW.epoch_id
       OR existing.epoch_id_hash = NEW.epoch_id_hash
       OR existing.epoch_sequence = NEW.epoch_sequence
       OR existing.configuration_hash = NEW.configuration_hash
)
BEGIN
    SELECT RAISE(ABORT, 'media delivery epoch replacement is forbidden');
END;

CREATE TRIGGER gallery_media_delivery_epochs_no_update
BEFORE UPDATE ON gallery_media_delivery_epochs
BEGIN
    SELECT RAISE(ABORT, 'media delivery epochs are append-only');
END;

CREATE TRIGGER gallery_media_delivery_epochs_no_delete
BEFORE DELETE ON gallery_media_delivery_epochs
BEGIN
    SELECT RAISE(ABORT, 'media delivery epochs are append-only');
END;

CREATE TRIGGER gallery_media_delivery_epoch_activations_no_replace_guard
BEFORE INSERT ON gallery_media_delivery_epoch_activations
WHEN EXISTS (
    SELECT 1 FROM gallery_media_delivery_epoch_activations AS existing
    WHERE existing.activation_receipt_hash = NEW.activation_receipt_hash
       OR existing.epoch_id_hash = NEW.epoch_id_hash
       OR existing.epoch_sequence = NEW.epoch_sequence
       OR existing.activation_idempotency_key_hash = NEW.activation_idempotency_key_hash
       OR existing.activation_payload_hash = NEW.activation_payload_hash
)
BEGIN
    SELECT RAISE(ABORT, 'media delivery epoch activation replacement is forbidden');
END;

CREATE TRIGGER gallery_media_delivery_epoch_activations_insert_guard
BEFORE INSERT ON gallery_media_delivery_epoch_activations
WHEN NOT EXISTS (
    SELECT 1
    FROM gallery_media_delivery_epochs AS epoch
    WHERE epoch.epoch_id_hash = NEW.epoch_id_hash
      AND epoch.epoch_sequence = NEW.epoch_sequence
      AND NEW.activated_at > epoch.registered_at
      AND (
          (
              NEW.epoch_sequence = 1 AND
              NEW.previous_epoch_id_hash IS NULL AND
              NOT EXISTS (SELECT 1 FROM gallery_media_delivery_current_epoch)
          ) OR (
              NEW.epoch_sequence > 1 AND
              EXISTS (
                  SELECT 1 FROM gallery_media_delivery_current_epoch AS current
                  WHERE current.singleton_id = 1
                    AND current.epoch_sequence + 1 = NEW.epoch_sequence
                    AND current.epoch_id_hash = NEW.previous_epoch_id_hash
              )
          )
      )
)
BEGIN
    SELECT RAISE(ABORT, 'media delivery epoch activation is not the next registered epoch');
END;

CREATE TRIGGER gallery_media_delivery_epoch_activations_no_update
BEFORE UPDATE ON gallery_media_delivery_epoch_activations
BEGIN
    SELECT RAISE(ABORT, 'media delivery epoch activations are append-only');
END;

CREATE TRIGGER gallery_media_delivery_epoch_activations_no_delete
BEFORE DELETE ON gallery_media_delivery_epoch_activations
BEGIN
    SELECT RAISE(ABORT, 'media delivery epoch activations are append-only');
END;

CREATE TRIGGER gallery_media_delivery_current_epoch_no_replace_guard
BEFORE INSERT ON gallery_media_delivery_current_epoch
WHEN EXISTS (SELECT 1 FROM gallery_media_delivery_current_epoch)
BEGIN
    SELECT RAISE(ABORT, 'current media delivery epoch replacement is forbidden');
END;

CREATE TRIGGER gallery_media_delivery_current_epoch_insert_guard
BEFORE INSERT ON gallery_media_delivery_current_epoch
WHEN NEW.singleton_id <> 1 OR NEW.epoch_sequence <> 1 OR NOT EXISTS (
    SELECT 1
    FROM gallery_media_delivery_epoch_activations AS activation
    JOIN gallery_media_delivery_epochs AS epoch
      ON epoch.epoch_id_hash = activation.epoch_id_hash
    WHERE activation.activation_receipt_hash = NEW.activation_receipt_hash
      AND activation.epoch_id_hash = NEW.epoch_id_hash
      AND activation.epoch_sequence = NEW.epoch_sequence
      AND activation.previous_epoch_id_hash IS NULL
      AND activation.activated_at = NEW.activated_at
      AND epoch.epoch_sequence = NEW.epoch_sequence
)
BEGIN
    SELECT RAISE(ABORT, 'current media delivery epoch lacks initial activation evidence');
END;

CREATE TRIGGER gallery_media_delivery_current_epoch_update_guard
BEFORE UPDATE ON gallery_media_delivery_current_epoch
WHEN NEW.singleton_id IS NOT OLD.singleton_id OR
     NEW.epoch_sequence <> OLD.epoch_sequence + 1 OR
     NEW.epoch_id_hash IS OLD.epoch_id_hash OR
     NEW.activation_receipt_hash IS OLD.activation_receipt_hash OR
     NEW.activated_at <= OLD.activated_at OR
     NOT EXISTS (
         SELECT 1
         FROM gallery_media_delivery_epoch_activations AS activation
         JOIN gallery_media_delivery_epochs AS epoch
           ON epoch.epoch_id_hash = activation.epoch_id_hash
         WHERE activation.activation_receipt_hash = NEW.activation_receipt_hash
           AND activation.epoch_id_hash = NEW.epoch_id_hash
           AND activation.epoch_sequence = NEW.epoch_sequence
           AND activation.previous_epoch_id_hash = OLD.epoch_id_hash
           AND activation.activated_at = NEW.activated_at
           AND epoch.epoch_sequence = NEW.epoch_sequence
     )
BEGIN
    SELECT RAISE(ABORT, 'current media delivery epoch may advance only through exact activation evidence');
END;

CREATE TRIGGER gallery_media_delivery_current_epoch_no_delete
BEFORE DELETE ON gallery_media_delivery_current_epoch
BEGIN
    SELECT RAISE(ABORT, 'current media delivery epoch deletion is forbidden');
END;

CREATE TRIGGER draft_photo_public_generations_no_replace_guard
BEFORE INSERT ON draft_photo_public_generations
WHEN EXISTS (
    SELECT 1 FROM draft_photo_public_generations AS existing
    WHERE existing.promotion_id = NEW.promotion_id
       OR existing.promotion_id_hash = NEW.promotion_id_hash
       OR existing.generation_fingerprint = NEW.generation_fingerprint
       OR (
           existing.draft_id = NEW.draft_id AND
           existing.candidate_state_version = NEW.candidate_state_version
       )
)
BEGIN
    SELECT RAISE(ABORT, 'public generation replacement is forbidden');
END;

CREATE TRIGGER draft_photo_public_generations_insert_guard
BEFORE INSERT ON draft_photo_public_generations
WHEN NOT EXISTS (
    SELECT 1
    FROM draft_photo_promotions AS promotion
    JOIN gallery_drafts AS draft ON draft.draft_id = promotion.draft_id
    WHERE promotion.promotion_id = NEW.promotion_id
      AND promotion.draft_id = NEW.draft_id
      AND promotion.status = 'active'
      AND promotion.result_state_version = NEW.candidate_state_version
      AND promotion.expected_state_version = draft.state_version
      AND draft.state = 'processing'
)
BEGIN
    SELECT RAISE(ABORT, 'public generation lacks current active promotion evidence');
END;

CREATE TRIGGER draft_photo_public_generations_no_update
BEFORE UPDATE ON draft_photo_public_generations
BEGIN
    SELECT RAISE(ABORT, 'public generations are immutable');
END;

CREATE TRIGGER draft_photo_public_generations_direct_delete_guard
BEFORE DELETE ON draft_photo_public_generations
WHEN EXISTS (SELECT 1 FROM gallery_drafts AS draft WHERE draft.draft_id = OLD.draft_id)
BEGIN
    SELECT RAISE(ABORT, 'public generation direct deletion is forbidden; approved draft purge only');
END;

CREATE TRIGGER draft_photo_public_generation_targets_no_replace_guard
BEFORE INSERT ON draft_photo_public_generation_targets
WHEN EXISTS (
    SELECT 1 FROM draft_photo_public_generation_targets AS existing
    WHERE (existing.promotion_id = NEW.promotion_id AND existing.role = NEW.role)
       OR existing.approved_object_key = NEW.approved_object_key
       OR existing.approved_object_key_hash = NEW.approved_object_key_hash
       OR existing.public_url_hash = NEW.public_url_hash
)
BEGIN
    SELECT RAISE(ABORT, 'public generation target replacement is forbidden');
END;

CREATE TRIGGER draft_photo_public_generation_targets_insert_guard
BEFORE INSERT ON draft_photo_public_generation_targets
WHEN EXISTS (
    SELECT 1 FROM gallery_approved_media_key_retirement_reservations AS retired
    WHERE retired.approved_object_key_hash = NEW.approved_object_key_hash
) OR NOT EXISTS (
    SELECT 1
    FROM draft_photo_public_generations AS generation
    JOIN draft_photo_promotion_objects AS object
      ON object.promotion_id = generation.promotion_id
     AND object.role = NEW.role
    WHERE generation.promotion_id = NEW.promotion_id
      AND generation.target_set_hash = NEW.generation_target_set_hash
      AND object.approved_object_key = NEW.approved_object_key
      AND object.sha256 = NEW.expected_sha256
)
BEGIN
    SELECT RAISE(ABORT, 'public generation target is retired or lacks exact promotion evidence');
END;

CREATE TRIGGER draft_photo_public_generation_targets_no_update
BEFORE UPDATE ON draft_photo_public_generation_targets
BEGIN
    SELECT RAISE(ABORT, 'public generation targets are immutable');
END;

CREATE TRIGGER draft_photo_public_generation_targets_direct_delete_guard
BEFORE DELETE ON draft_photo_public_generation_targets
WHEN EXISTS (
    SELECT 1
    FROM draft_photo_public_generations AS generation
    JOIN gallery_drafts AS draft ON draft.draft_id = generation.draft_id
    WHERE generation.promotion_id = OLD.promotion_id
)
BEGIN
    SELECT RAISE(ABORT, 'public generation target direct deletion is forbidden; approved draft purge only');
END;

-- Candidate state now requires the immutable origin/generation snapshot and
-- the currently active media-delivery epoch before any URL can be emitted.
CREATE TRIGGER draft_photo_promotions_public_generation_guard
BEFORE UPDATE OF status ON draft_photo_promotions
WHEN OLD.status = 'active' AND NEW.status = 'candidate' AND NOT EXISTS (
    SELECT 1
    FROM draft_photo_public_generations AS generation
    JOIN gallery_media_delivery_current_epoch AS current ON current.singleton_id = 1
    JOIN gallery_media_delivery_epochs AS epoch
      ON epoch.epoch_id_hash = current.epoch_id_hash
    WHERE generation.promotion_id = OLD.promotion_id
      AND generation.draft_id = OLD.draft_id
      AND generation.candidate_state_version = OLD.result_state_version
      AND generation.approved_origin = epoch.approved_origin
      AND generation.approved_origin_hash = epoch.approved_origin_hash
      AND (SELECT COUNT(*)
          FROM draft_photo_public_generation_targets AS target
          WHERE target.promotion_id = generation.promotion_id) = 2
      AND NOT EXISTS (
          SELECT 1
          FROM draft_photo_public_generation_targets AS target
          LEFT JOIN draft_photo_promotion_objects AS object
            ON object.promotion_id = target.promotion_id
           AND object.role = target.role
           AND object.approved_object_key = target.approved_object_key
           AND object.sha256 = target.expected_sha256
           AND object.status = 'verified'
          WHERE target.promotion_id = generation.promotion_id
            AND object.promotion_id IS NULL
      )
)
BEGIN
    SELECT RAISE(ABORT, 'photo promotion lacks complete current public generation evidence');
END;

CREATE TRIGGER draft_public_host_absence_verifications_no_replace_guard
BEFORE INSERT ON draft_public_host_absence_verifications
WHEN EXISTS (
    SELECT 1 FROM draft_public_host_absence_verifications AS existing
    WHERE existing.verification_id = NEW.verification_id
       OR existing.verification_id_hash = NEW.verification_id_hash
       OR existing.idempotency_key_hash = NEW.idempotency_key_hash
       OR (
           existing.draft_id = NEW.draft_id AND
           existing.expected_state_version = NEW.expected_state_version AND
           existing.media_delivery_epoch_id_hash = NEW.media_delivery_epoch_id_hash AND
           existing.verification_purpose = NEW.verification_purpose AND
           existing.withdrawal_cycle_hash = NEW.withdrawal_cycle_hash AND
           existing.service_actor_identity_hash = NEW.service_actor_identity_hash
       )
       OR (
           existing.draft_id = NEW.draft_id AND
           existing.idempotency_key = NEW.idempotency_key
       )
)
BEGIN
    SELECT RAISE(ABORT, 'public-host absence verification replacement is forbidden');
END;

CREATE TRIGGER draft_public_host_absence_verifications_insert_guard
BEFORE INSERT ON draft_public_host_absence_verifications
WHEN NOT EXISTS (
    SELECT 1
    FROM gallery_drafts AS draft
    JOIN draft_publication_references AS publication
      ON publication.draft_id = draft.draft_id
    LEFT JOIN gallery_retention_tombstones AS retention
      ON retention.draft_id = draft.draft_id
    JOIN gallery_media_delivery_current_epoch AS current ON current.singleton_id = 1
    JOIN gallery_media_delivery_epochs AS epoch
      ON epoch.epoch_id_hash = current.epoch_id_hash
    WHERE draft.draft_id = NEW.draft_id
      AND draft.state_version = NEW.expected_state_version
      AND publication.host_deletion_confirmed = 0
      AND (
          (
              NEW.verification_purpose = 'withdrawal' AND
              NEW.purpose_evidence_hash IS NULL AND
              NEW.withdrawal_kind IN (
                  'editorial-removal', 'athlete-exclusion', 'consent-withdrawal'
              ) AND
              draft.state IN ('withdrawal-pending', 'withdrawn') AND
              publication.withdrawal_kind = NEW.withdrawal_kind
          ) OR (
              NEW.verification_purpose = 'retention-expiry' AND
              NEW.withdrawal_kind = 'retention-expiry' AND
              draft.state IN ('rejected', 'processing-failed') AND
              publication.withdrawal_kind IS NULL AND
              retention.purge_kind = 'retention-expiry' AND
              retention.evidence_hash = NEW.purpose_evidence_hash AND
              NEW.created_at > retention.approved_at
          )
      )
      AND epoch.epoch_id_hash = NEW.media_delivery_epoch_id_hash
      AND epoch.approved_origin_hash = NEW.approved_origin_hash
      AND epoch.delivery_contract_hash = NEW.delivery_contract_hash
      AND epoch.delivery_version_hash = NEW.delivery_version_hash
      AND NEW.generation_count = (
          SELECT COUNT(*) FROM draft_photo_public_generations AS generation
          WHERE generation.draft_id = draft.draft_id
      )
      AND NEW.generation_target_row_count = (
          SELECT COUNT(*)
          FROM draft_photo_public_generation_targets AS target
          JOIN draft_photo_public_generations AS generation
            ON generation.promotion_id = target.promotion_id
          WHERE generation.draft_id = draft.draft_id
      )
      AND NEW.target_count = (
          SELECT COUNT(DISTINCT target.approved_object_key_hash)
          FROM draft_photo_public_generation_targets AS target
          JOIN draft_photo_public_generations AS generation
            ON generation.promotion_id = target.promotion_id
          WHERE generation.draft_id = draft.draft_id
      )
      AND NOT EXISTS (
          SELECT 1 FROM draft_photo_public_generations AS generation
          WHERE generation.draft_id = draft.draft_id
            AND (
                generation.approved_origin <> epoch.approved_origin OR
                generation.approved_origin_hash <> epoch.approved_origin_hash OR
                (SELECT COUNT(*)
                    FROM draft_photo_public_generation_targets AS target
                    WHERE target.promotion_id = generation.promotion_id) <> 2 OR
                NOT EXISTS (
                    SELECT 1 FROM draft_photo_public_generation_targets AS target
                    WHERE target.promotion_id = generation.promotion_id
                      AND target.role = 'photo-display'
                ) OR
                NOT EXISTS (
                    SELECT 1 FROM draft_photo_public_generation_targets AS target
                    WHERE target.promotion_id = generation.promotion_id
                      AND target.role = 'photo-thumbnail'
                ) OR
                NOT EXISTS (
                    SELECT 1 FROM gallery_photo_promotion_cleanup_tombstones AS cleanup
                    WHERE cleanup.promotion_id_hash = generation.promotion_id_hash
                )
            )
      )
      AND NOT EXISTS (
          SELECT 1
          FROM draft_photo_public_generations AS generation
          JOIN gallery_photo_promotion_cleanup_tombstones AS cleanup
            ON cleanup.promotion_id_hash = generation.promotion_id_hash
          WHERE generation.draft_id = draft.draft_id
            AND NEW.created_at <= cleanup.completed_at
      )
      AND (
          NEW.verification_purpose <> 'withdrawal' OR
          draft.state <> 'withdrawn' OR NOT EXISTS (
              SELECT 1
              FROM gallery_public_host_absence_receipts AS prior
              JOIN draft_public_host_absence_verifications AS prior_verification
                ON prior_verification.verification_id_hash = prior.verification_id_hash
              WHERE prior.draft_id_hash = NEW.draft_id_hash
                AND prior.verification_purpose = 'withdrawal'
                AND prior_verification.withdrawal_kind = NEW.withdrawal_kind
                AND prior.withdrawal_cycle_hash <> NEW.withdrawal_cycle_hash
          )
      )
      AND NOT EXISTS (
          SELECT 1 FROM draft_derivatives AS derivative
          WHERE derivative.draft_id = draft.draft_id
            AND derivative.approved_object_key IS NOT NULL
      )
)
BEGIN
    SELECT RAISE(ABORT, 'public-host absence verification lacks the current complete generation set');
END;

CREATE TRIGGER draft_public_host_absence_verifications_no_update
BEFORE UPDATE ON draft_public_host_absence_verifications
BEGIN
    SELECT RAISE(ABORT, 'public-host absence verifications are immutable');
END;

CREATE TRIGGER draft_public_host_absence_verifications_direct_delete_guard
BEFORE DELETE ON draft_public_host_absence_verifications
WHEN EXISTS (SELECT 1 FROM gallery_drafts AS draft WHERE draft.draft_id = OLD.draft_id)
BEGIN
    SELECT RAISE(ABORT, 'public-host verification direct deletion is forbidden; approved draft purge only');
END;

CREATE TRIGGER gallery_approved_media_key_retirement_reservations_no_replace_guard
BEFORE INSERT ON gallery_approved_media_key_retirement_reservations
WHEN EXISTS (
    SELECT 1 FROM gallery_approved_media_key_retirement_reservations AS existing
    WHERE existing.approved_object_key_hash = NEW.approved_object_key_hash
)
BEGIN
    SELECT RAISE(ABORT, 'approved-media key retirement reservation replacement is forbidden');
END;

CREATE TRIGGER gallery_approved_media_key_retirement_reservations_insert_guard
BEFORE INSERT ON gallery_approved_media_key_retirement_reservations
WHEN NOT EXISTS (
    SELECT 1
    FROM draft_public_host_absence_verifications AS verification
    JOIN draft_photo_public_generations AS generation
      ON generation.draft_id = verification.draft_id
     AND generation.promotion_id_hash = NEW.promotion_id_hash
    JOIN draft_photo_public_generation_targets AS target
      ON target.promotion_id = generation.promotion_id
     AND target.approved_object_key_hash = NEW.approved_object_key_hash
    JOIN gallery_photo_promotion_cleanup_tombstones AS cleanup
      ON cleanup.promotion_id_hash = generation.promotion_id_hash
    JOIN gallery_drafts AS draft ON draft.draft_id = verification.draft_id
    WHERE verification.verification_id_hash = NEW.verification_id_hash
      AND verification.draft_id_hash = NEW.draft_id_hash
      AND verification.withdrawal_cycle_hash = NEW.withdrawal_cycle_hash
      AND verification.idempotency_key_hash = NEW.reservation_idempotency_key_hash
      AND verification.service_actor_identity_hash = NEW.reserved_by_identity_hash
      AND draft.state_version = verification.expected_state_version
)
BEGIN
    SELECT RAISE(ABORT, 'approved-media key retirement reservation lacks current cleanup evidence');
END;

CREATE TRIGGER gallery_approved_media_key_retirement_reservations_no_update
BEFORE UPDATE ON gallery_approved_media_key_retirement_reservations
BEGIN
    SELECT RAISE(ABORT, 'approved-media key retirement reservations are append-only');
END;

CREATE TRIGGER gallery_approved_media_key_retirement_reservations_no_delete
BEFORE DELETE ON gallery_approved_media_key_retirement_reservations
BEGIN
    SELECT RAISE(ABORT, 'approved-media key retirement reservations are append-only');
END;

CREATE TRIGGER draft_public_host_absence_target_proofs_no_replace_guard
BEFORE INSERT ON draft_public_host_absence_target_proofs
WHEN EXISTS (
    SELECT 1 FROM draft_public_host_absence_target_proofs AS existing
    WHERE existing.verification_id = NEW.verification_id
      AND existing.approved_object_key_hash = NEW.approved_object_key_hash
)
BEGIN
    SELECT RAISE(ABORT, 'public-host target proof replacement is forbidden');
END;

CREATE TRIGGER draft_public_host_absence_target_proofs_insert_guard
BEFORE INSERT ON draft_public_host_absence_target_proofs
WHEN NOT EXISTS (
    SELECT 1
    FROM draft_public_host_absence_verifications AS verification
    JOIN gallery_drafts AS draft ON draft.draft_id = verification.draft_id
    JOIN gallery_media_delivery_current_epoch AS current
      ON current.epoch_id_hash = verification.media_delivery_epoch_id_hash
    JOIN draft_photo_public_generations AS generation
      ON generation.draft_id = verification.draft_id
    JOIN draft_photo_public_generation_targets AS target
      ON target.promotion_id = generation.promotion_id
     AND target.approved_object_key_hash = NEW.approved_object_key_hash
    JOIN gallery_approved_media_key_retirement_reservations AS reservation
      ON reservation.approved_object_key_hash = target.approved_object_key_hash
     AND reservation.promotion_id_hash = generation.promotion_id_hash
     AND reservation.draft_id_hash = verification.draft_id_hash
    WHERE verification.verification_id = NEW.verification_id
      AND draft.state_version = verification.expected_state_version
      AND target.role = NEW.role
      AND target.public_url_hash = NEW.public_url_hash
      AND target.expected_sha256 = NEW.expected_sha256
      AND NEW.observed_contract_hash = verification.delivery_contract_hash
      AND NEW.observed_version_hash = verification.delivery_version_hash
      AND NEW.verified_at > verification.created_at
)
BEGIN
    SELECT RAISE(ABORT, 'public-host target proof is not one current reserved generation target');
END;

CREATE TRIGGER draft_public_host_absence_target_proofs_no_update
BEFORE UPDATE ON draft_public_host_absence_target_proofs
BEGIN
    SELECT RAISE(ABORT, 'public-host target proofs are immutable');
END;

CREATE TRIGGER draft_public_host_absence_target_proofs_direct_delete_guard
BEFORE DELETE ON draft_public_host_absence_target_proofs
WHEN EXISTS (
    SELECT 1
    FROM draft_public_host_absence_verifications AS verification
    JOIN gallery_drafts AS draft ON draft.draft_id = verification.draft_id
    WHERE verification.verification_id = OLD.verification_id
)
BEGIN
    SELECT RAISE(ABORT, 'public-host target proof direct deletion is forbidden; approved draft purge only');
END;

CREATE TRIGGER draft_public_host_absence_witness_proofs_no_replace_guard
BEFORE INSERT ON draft_public_host_absence_witness_proofs
WHEN EXISTS (
    SELECT 1 FROM draft_public_host_absence_witness_proofs AS existing
    WHERE existing.verification_id = NEW.verification_id
)
BEGIN
    SELECT RAISE(ABORT, 'public-host witness proof replacement is forbidden');
END;

CREATE TRIGGER draft_public_host_absence_witness_proofs_insert_guard
BEFORE INSERT ON draft_public_host_absence_witness_proofs
WHEN NOT EXISTS (
    SELECT 1
    FROM draft_public_host_absence_verifications AS verification
    JOIN gallery_drafts AS draft ON draft.draft_id = verification.draft_id
    JOIN gallery_media_delivery_current_epoch AS current
      ON current.epoch_id_hash = verification.media_delivery_epoch_id_hash
    JOIN gallery_media_delivery_epochs AS epoch
      ON epoch.epoch_id_hash = current.epoch_id_hash
    WHERE verification.verification_id = NEW.verification_id
      AND draft.state_version = verification.expected_state_version
      AND epoch.witness_object_key_hash = NEW.witness_object_key_hash
      AND epoch.witness_sha256 = NEW.witness_sha256
      AND epoch.witness_byte_count = NEW.witness_byte_count
      AND epoch.witness_content_type = NEW.witness_content_type
      AND epoch.delivery_contract_hash = NEW.observed_contract_hash
      AND epoch.delivery_version_hash = NEW.observed_version_hash
      AND NEW.verified_at > verification.created_at
)
BEGIN
    SELECT RAISE(ABORT, 'public-host witness proof does not match the current delivery epoch');
END;

CREATE TRIGGER draft_public_host_absence_witness_proofs_no_update
BEFORE UPDATE ON draft_public_host_absence_witness_proofs
BEGIN
    SELECT RAISE(ABORT, 'public-host witness proofs are immutable');
END;

CREATE TRIGGER draft_public_host_absence_witness_proofs_direct_delete_guard
BEFORE DELETE ON draft_public_host_absence_witness_proofs
WHEN EXISTS (
    SELECT 1
    FROM draft_public_host_absence_verifications AS verification
    JOIN gallery_drafts AS draft ON draft.draft_id = verification.draft_id
    WHERE verification.verification_id = OLD.verification_id
)
BEGIN
    SELECT RAISE(ABORT, 'public-host witness proof direct deletion is forbidden; approved draft purge only');
END;

CREATE TRIGGER gallery_public_host_absence_receipts_no_replace_guard
BEFORE INSERT ON gallery_public_host_absence_receipts
WHEN EXISTS (
    SELECT 1 FROM gallery_public_host_absence_receipts AS existing
    WHERE existing.final_receipt_hash = NEW.final_receipt_hash
       OR existing.verification_id_hash = NEW.verification_id_hash
       OR existing.idempotency_key_hash = NEW.idempotency_key_hash
)
BEGIN
    SELECT RAISE(ABORT, 'public-host absence receipt replacement is forbidden');
END;

CREATE TRIGGER gallery_public_host_absence_receipts_insert_guard
BEFORE INSERT ON gallery_public_host_absence_receipts
WHEN NOT EXISTS (
    SELECT 1
    FROM draft_public_host_absence_verifications AS verification
    JOIN gallery_drafts AS draft ON draft.draft_id = verification.draft_id
    JOIN draft_publication_references AS publication
      ON publication.draft_id = verification.draft_id
    LEFT JOIN gallery_retention_tombstones AS retention
      ON retention.draft_id = verification.draft_id
    JOIN gallery_media_delivery_current_epoch AS current
      ON current.epoch_id_hash = verification.media_delivery_epoch_id_hash
    JOIN draft_public_host_absence_witness_proofs AS witness
      ON witness.verification_id = verification.verification_id
    WHERE verification.verification_id_hash = NEW.verification_id_hash
      AND verification.draft_id_hash = NEW.draft_id_hash
      AND verification.promotion_set_hash = NEW.promotion_set_hash
      AND verification.cleanup_evidence_set_hash = NEW.cleanup_evidence_set_hash
      AND verification.withdrawal_cycle_hash = NEW.withdrawal_cycle_hash
      AND verification.approved_origin_hash = NEW.approved_origin_hash
      AND verification.target_set_hash = NEW.target_set_hash
      AND verification.generation_count = NEW.generation_count
      AND verification.target_count = NEW.target_count
      AND verification.expected_state_version = NEW.verified_state_version
      AND verification.verification_purpose = NEW.verification_purpose
      AND verification.purpose_evidence_hash IS NEW.purpose_evidence_hash
      AND verification.media_delivery_epoch_id_hash = NEW.media_delivery_epoch_id_hash
      AND verification.delivery_contract_hash = NEW.delivery_contract_hash
      AND verification.delivery_version_hash = NEW.delivery_version_hash
      AND verification.idempotency_key_hash = NEW.idempotency_key_hash
      AND verification.payload_fingerprint = NEW.payload_fingerprint
      AND draft.state_version = verification.expected_state_version
      AND (
          (
              verification.verification_purpose = 'withdrawal' AND
              verification.purpose_evidence_hash IS NULL AND
              draft.state IN ('withdrawal-pending', 'withdrawn') AND
              publication.withdrawal_kind = verification.withdrawal_kind
          ) OR (
              verification.verification_purpose = 'retention-expiry' AND
              verification.withdrawal_kind = 'retention-expiry' AND
              draft.state IN ('rejected', 'processing-failed') AND
              publication.withdrawal_kind IS NULL AND
              retention.purge_kind = 'retention-expiry' AND
              retention.evidence_hash = verification.purpose_evidence_hash
          )
      )
      AND witness.observed_contract_hash = verification.delivery_contract_hash
      AND witness.observed_version_hash = verification.delivery_version_hash
      AND NEW.verified_at > verification.created_at
      AND NEW.verified_at > witness.verified_at
      AND NOT EXISTS (
          SELECT 1
          FROM draft_public_host_absence_target_proofs AS proof
          WHERE proof.verification_id = verification.verification_id
            AND NEW.verified_at <= proof.verified_at
      )
      AND NEW.generation_count = (
          SELECT COUNT(*) FROM draft_photo_public_generations AS generation
          WHERE generation.draft_id = verification.draft_id
      )
      AND verification.generation_target_row_count = (
          SELECT COUNT(*)
          FROM draft_photo_public_generation_targets AS target
          JOIN draft_photo_public_generations AS generation
            ON generation.promotion_id = target.promotion_id
          WHERE generation.draft_id = verification.draft_id
      )
      AND NEW.generation_count = (
          SELECT COUNT(*)
          FROM draft_photo_public_generations AS generation
          JOIN gallery_photo_promotion_cleanup_tombstones AS cleanup
            ON cleanup.promotion_id_hash = generation.promotion_id_hash
          WHERE generation.draft_id = verification.draft_id
      )
      AND NOT EXISTS (
          SELECT 1
          FROM draft_photo_public_generations AS generation
          JOIN gallery_photo_promotion_cleanup_tombstones AS cleanup
            ON cleanup.promotion_id_hash = generation.promotion_id_hash
          WHERE generation.draft_id = verification.draft_id
            AND NEW.verified_at <= cleanup.completed_at
      )
      AND NOT EXISTS (
          SELECT 1
          FROM draft_photo_public_generations AS generation
          WHERE generation.draft_id = verification.draft_id
            AND (
                (SELECT COUNT(*)
                    FROM draft_photo_public_generation_targets AS target
                    WHERE target.promotion_id = generation.promotion_id) <> 2 OR
                NOT EXISTS (
                    SELECT 1 FROM draft_photo_public_generation_targets AS target
                    WHERE target.promotion_id = generation.promotion_id
                      AND target.role = 'photo-display'
                ) OR
                NOT EXISTS (
                    SELECT 1 FROM draft_photo_public_generation_targets AS target
                    WHERE target.promotion_id = generation.promotion_id
                      AND target.role = 'photo-thumbnail'
                )
            )
      )
      AND (SELECT COUNT(*)
          FROM draft_public_host_absence_target_proofs AS proof
          WHERE proof.verification_id = verification.verification_id
      ) = verification.target_count
      AND NOT EXISTS (
          SELECT 1
          FROM draft_photo_public_generations AS generation
          JOIN draft_photo_public_generation_targets AS target
            ON target.promotion_id = generation.promotion_id
          WHERE generation.draft_id = verification.draft_id
            AND NOT EXISTS (
                SELECT 1
                FROM draft_public_host_absence_target_proofs AS proof
                WHERE proof.verification_id = verification.verification_id
                  AND proof.approved_object_key_hash = target.approved_object_key_hash
                  AND proof.role = target.role
                  AND proof.public_url_hash = target.public_url_hash
                  AND proof.expected_sha256 = target.expected_sha256
            )
      )
      AND NOT EXISTS (
          SELECT 1
          FROM draft_photo_public_generations AS generation
          JOIN draft_photo_public_generation_targets AS target
            ON target.promotion_id = generation.promotion_id
          WHERE generation.draft_id = verification.draft_id
            AND NOT EXISTS (
                SELECT 1
                FROM gallery_approved_media_key_retirement_reservations AS reservation
                WHERE reservation.approved_object_key_hash = target.approved_object_key_hash
                  AND reservation.promotion_id_hash = generation.promotion_id_hash
                  AND reservation.draft_id_hash = verification.draft_id_hash
            )
      )
)
BEGIN
    SELECT RAISE(ABORT, 'public-host absence receipt lacks complete current proof');
END;

CREATE TRIGGER gallery_public_host_absence_receipts_no_update
BEFORE UPDATE ON gallery_public_host_absence_receipts
BEGIN
    SELECT RAISE(ABORT, 'public-host absence receipts are append-only');
END;

CREATE TRIGGER gallery_public_host_absence_receipts_no_delete
BEFORE DELETE ON gallery_public_host_absence_receipts
BEGIN
    SELECT RAISE(ABORT, 'public-host absence receipts are append-only');
END;

-- Proof completeness is deliberately separate from the legacy withdrawal
-- scalar.  This view is the only source permitted to turn that scalar on, and
-- it also supplies the retention-only purge path where the scalar stays off.
CREATE VIEW gallery_complete_public_host_absence_receipts AS
SELECT
    verification.draft_id,
    verification.withdrawal_kind,
    verification.verification_purpose,
    verification.purpose_evidence_hash,
    verification.expected_state_version,
    verification.withdrawal_cycle_hash,
    verification.verification_id_hash,
    receipt.final_receipt_hash,
    receipt.verified_at
FROM gallery_public_host_absence_receipts AS receipt
JOIN draft_public_host_absence_verifications AS verification
  ON verification.verification_id_hash = receipt.verification_id_hash
JOIN gallery_drafts AS draft ON draft.draft_id = verification.draft_id
JOIN draft_publication_references AS publication
  ON publication.draft_id = verification.draft_id
JOIN gallery_media_delivery_current_epoch AS current
  ON current.epoch_id_hash = receipt.media_delivery_epoch_id_hash
WHERE receipt.verification_purpose = verification.verification_purpose
  AND receipt.purpose_evidence_hash IS verification.purpose_evidence_hash
  AND (
      (
          verification.verification_purpose = 'withdrawal' AND
          verification.purpose_evidence_hash IS NULL AND
          publication.withdrawal_kind = verification.withdrawal_kind AND
          (
              draft.state_version = verification.expected_state_version OR
              (
                  draft.state = 'withdrawn' AND
                  draft.state_version = verification.expected_state_version + 1
              )
          )
      ) OR (
          verification.verification_purpose = 'retention-expiry' AND
          verification.withdrawal_kind = 'retention-expiry' AND
          publication.withdrawal_kind IS NULL AND
          draft.state IN ('rejected', 'processing-failed') AND
          draft.state_version = verification.expected_state_version AND
          EXISTS (
              SELECT 1 FROM gallery_retention_tombstones AS retention
              WHERE retention.draft_id = verification.draft_id
                AND retention.purge_kind = 'retention-expiry'
                AND retention.evidence_hash = verification.purpose_evidence_hash
          )
      )
  )
  AND receipt.draft_id_hash = verification.draft_id_hash
  AND receipt.withdrawal_cycle_hash = verification.withdrawal_cycle_hash
  AND receipt.promotion_set_hash = verification.promotion_set_hash
  AND receipt.cleanup_evidence_set_hash = verification.cleanup_evidence_set_hash
  AND receipt.target_set_hash = verification.target_set_hash
  AND receipt.approved_origin_hash = verification.approved_origin_hash
  AND receipt.delivery_contract_hash = verification.delivery_contract_hash
  AND receipt.delivery_version_hash = verification.delivery_version_hash
  AND receipt.generation_count = (
      SELECT COUNT(*) FROM draft_photo_public_generations AS generation
      WHERE generation.draft_id = verification.draft_id
  )
  AND verification.generation_target_row_count = (
      SELECT COUNT(*)
      FROM draft_photo_public_generation_targets AS target
      JOIN draft_photo_public_generations AS generation
        ON generation.promotion_id = target.promotion_id
      WHERE generation.draft_id = verification.draft_id
  )
  AND receipt.target_count = (
      SELECT COUNT(DISTINCT target.approved_object_key_hash)
      FROM draft_photo_public_generation_targets AS target
      JOIN draft_photo_public_generations AS generation
        ON generation.promotion_id = target.promotion_id
      WHERE generation.draft_id = verification.draft_id
  );

-- "Current" additionally binds the compatibility scalar for withdrawal.
-- Retention expiry is a distinct never-public proof and deliberately requires
-- that scalar to remain zero.
CREATE VIEW gallery_current_public_host_absence_receipts AS
SELECT complete.*
FROM gallery_complete_public_host_absence_receipts AS complete
JOIN draft_publication_references AS publication
  ON publication.draft_id = complete.draft_id
WHERE (
    complete.verification_purpose = 'withdrawal' AND
    publication.withdrawal_kind = complete.withdrawal_kind AND
    publication.host_deletion_confirmed = 1
) OR (
    complete.verification_purpose = 'retention-expiry' AND
    publication.withdrawal_kind IS NULL AND
    publication.host_deletion_confirmed = 0
);

-- Legacy scalar truth is deliberately invalidated by this forward migration.
-- It may become true again only after the current receipt has been appended.
UPDATE draft_publication_references
SET host_deletion_confirmed = 0
WHERE host_deletion_confirmed = 1;

CREATE TRIGGER draft_publication_references_host_deletion_insert_guard
BEFORE INSERT ON draft_publication_references
WHEN NEW.host_deletion_confirmed = 1 AND NOT EXISTS (
    SELECT 1 FROM gallery_complete_public_host_absence_receipts AS current
    WHERE current.draft_id = NEW.draft_id
      AND current.verification_purpose = 'withdrawal'
      AND current.withdrawal_kind = NEW.withdrawal_kind
)
BEGIN
    SELECT RAISE(ABORT, 'host deletion confirmation requires a current complete receipt');
END;

CREATE TRIGGER draft_publication_references_host_deletion_update_guard
BEFORE UPDATE OF host_deletion_confirmed ON draft_publication_references
WHEN NEW.host_deletion_confirmed = 1 AND OLD.host_deletion_confirmed = 0 AND NOT EXISTS (
    SELECT 1 FROM gallery_complete_public_host_absence_receipts AS current
    WHERE current.draft_id = NEW.draft_id
      AND current.verification_purpose = 'withdrawal'
      AND current.withdrawal_kind = NEW.withdrawal_kind
)
BEGIN
    SELECT RAISE(ABORT, 'host deletion confirmation requires a current complete receipt');
END;

CREATE TRIGGER draft_publication_references_withdrawal_receipt_invalidate
AFTER UPDATE OF withdrawal_kind ON draft_publication_references
WHEN NEW.withdrawal_kind IS NOT OLD.withdrawal_kind AND NEW.host_deletion_confirmed = 1
BEGIN
    UPDATE draft_publication_references
    SET host_deletion_confirmed = 0
    WHERE draft_id = NEW.draft_id;
END;

CREATE TRIGGER draft_photo_public_generations_receipt_invalidate
AFTER INSERT ON draft_photo_public_generations
BEGIN
    UPDATE draft_publication_references
    SET host_deletion_confirmed = 0
    WHERE draft_id = NEW.draft_id
      AND host_deletion_confirmed = 1;
END;

CREATE TRIGGER gallery_media_delivery_current_epoch_receipt_invalidate
AFTER UPDATE ON gallery_media_delivery_current_epoch
BEGIN
    UPDATE draft_publication_references
    SET host_deletion_confirmed = 0
    WHERE host_deletion_confirmed = 1;
END;

-- Purge consumes a current purpose-bound receipt.  Withdrawn drafts use the
-- withdrawal proof and scalar; rejected/processing-failed retention purges use
-- the approved retention tombstone directly and keep that scalar off.  A later
-- delivery activation invalidates both forms until they are freshly proved.
DROP TRIGGER gallery_drafts_purge_guard;

CREATE TRIGGER gallery_drafts_purge_guard
BEFORE DELETE ON gallery_drafts
WHEN NOT EXISTS (
    SELECT 1
    FROM gallery_retention_tombstones AS tombstone
    JOIN draft_publication_references AS publication
      ON publication.draft_id = OLD.draft_id
    JOIN gallery_current_public_host_absence_receipts AS receipt
      ON receipt.draft_id = OLD.draft_id
    WHERE tombstone.draft_id = OLD.draft_id
      AND publication.private_original_deletion_confirmed = 1
      AND (
          (
              tombstone.purge_kind = 'consent-withdrawal' AND
              OLD.state = 'withdrawn' AND
              publication.withdrawal_kind = 'consent-withdrawal' AND
              publication.host_deletion_confirmed = 1 AND
              receipt.verification_purpose = 'withdrawal' AND
              receipt.withdrawal_kind = publication.withdrawal_kind
          ) OR (
              tombstone.purge_kind = 'retention-expiry' AND
              OLD.state = 'withdrawn' AND
              publication.host_deletion_confirmed = 1 AND
              receipt.verification_purpose = 'withdrawal' AND
              receipt.withdrawal_kind = publication.withdrawal_kind
          ) OR (
              tombstone.purge_kind = 'retention-expiry' AND
              OLD.state IN ('rejected', 'processing-failed') AND
              publication.withdrawal_kind IS NULL AND
              publication.host_deletion_confirmed = 0 AND
              receipt.verification_purpose = 'retention-expiry' AND
              receipt.purpose_evidence_hash = tombstone.evidence_hash
          )
      )
)
BEGIN
    SELECT RAISE(ABORT, 'gallery draft purge requires current public-host absence evidence');
END;

DROP TRIGGER gallery_drafts_withdrawal_evidence_guard;

CREATE TRIGGER gallery_drafts_withdrawal_evidence_guard
BEFORE UPDATE OF state ON gallery_drafts
WHEN NEW.state = 'withdrawn' AND NOT EXISTS (
    SELECT 1
    FROM draft_publication_references AS publication
    JOIN gallery_current_public_host_absence_receipts AS receipt
      ON receipt.draft_id = publication.draft_id
     AND receipt.verification_purpose = 'withdrawal'
     AND receipt.withdrawal_kind = publication.withdrawal_kind
     AND receipt.expected_state_version = OLD.state_version
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
    SELECT RAISE(ABORT, 'current complete public-host absence receipt is required');
END;

DROP TRIGGER draft_consent_withdrawal_evidence_guard;

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
    JOIN gallery_current_public_host_absence_receipts AS receipt
      ON receipt.draft_id = draft.draft_id
     AND receipt.verification_purpose = 'withdrawal'
     AND receipt.withdrawal_kind = publication.withdrawal_kind
     AND receipt.expected_state_version = draft.state_version
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
    SELECT RAISE(ABORT, 'consent withdrawal requires a current complete public-host absence receipt');
END;

PRAGMA foreign_key_check;
