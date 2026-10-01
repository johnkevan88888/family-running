-- Pre-publication private archive quarantine. No public-use consent, processing
-- approval, retention extension, draft backfill or publication link is created.
CREATE TABLE private_archive_intakes (
    asset_id TEXT PRIMARY KEY NOT NULL REFERENCES private_gallery_assets(asset_id),
    roster_generation INTEGER NOT NULL CHECK (roster_generation BETWEEN 1 AND 9007199254740991),
    request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
    byte_count INTEGER NOT NULL CHECK (byte_count BETWEEN 1 AND 26214400),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
    private_retention_confirmed INTEGER NOT NULL CHECK (private_retention_confirmed = 1),
    contains_minors INTEGER NOT NULL CHECK (contains_minors IN (0,1)),
    guardian_approval_confirmed INTEGER NOT NULL CHECK (guardian_approval_confirmed = contains_minors),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE private_archive_multipart_uploads (
    asset_id TEXT PRIMARY KEY NOT NULL REFERENCES private_archive_intakes(asset_id),
    provider_upload_id TEXT UNIQUE NOT NULL CHECK (length(provider_upload_id) BETWEEN 1 AND 1024)
);
CREATE TABLE private_archive_original_receipts (
    asset_id TEXT PRIMARY KEY NOT NULL REFERENCES private_archive_multipart_uploads(asset_id),
    byte_count INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    provider_version TEXT NOT NULL CHECK (length(provider_version) BETWEEN 1 AND 256),
    provider_etag TEXT NOT NULL CHECK (length(provider_etag) BETWEEN 1 AND 256),
    verified_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE private_archive_deletion_requests (
    asset_id TEXT PRIMARY KEY NOT NULL REFERENCES private_gallery_assets(asset_id),
    actor_identity_hash TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('owner-delete','consent-withdrawal')),
    requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE private_archive_writer_closures (
    asset_id TEXT PRIMARY KEY NOT NULL REFERENCES private_archive_deletion_requests(asset_id),
    provider_upload_id TEXT NOT NULL,
    proof TEXT NOT NULL CHECK (proof IN ('abort-confirmed','no-such-upload')),
    closed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE private_archive_deletion_receipts (
    asset_id TEXT PRIMARY KEY NOT NULL REFERENCES private_archive_deletion_requests(asset_id),
    original_absent INTEGER NOT NULL CHECK (original_absent = 1),
    verified_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TRIGGER private_archive_intake_admission BEFORE INSERT ON private_archive_intakes BEGIN
    SELECT RAISE(ABORT,'Archive intake is terminally blocked') WHERE EXISTS (
        SELECT 1 FROM private_archive_deletion_requests WHERE asset_id = NEW.asset_id);
    SELECT RAISE(ABORT,'Archive roster changed') WHERE NOT EXISTS (
        SELECT 1 FROM private_gallery_roster_version WHERE singleton = 1 AND generation = NEW.roster_generation);
    SELECT RAISE(ABORT,'Complete eligible archive tags required') WHERE NOT EXISTS (
        SELECT 1 FROM private_gallery_assets a WHERE a.asset_id = NEW.asset_id
        AND (SELECT count(*) FROM private_gallery_asset_tags t WHERE t.asset_id = a.asset_id) = json_array_length(a.person_ids_json)
        AND NOT EXISTS (
            SELECT 1 FROM json_each(a.person_ids_json) j
            LEFT JOIN private_gallery_asset_tags t ON t.asset_id = a.asset_id AND t.person_id = j.value AND t.ordinal = j.key
            LEFT JOIN private_gallery_people p ON p.person_id = j.value
            WHERE t.person_id IS NULL OR p.person_id IS NULL OR
                (a.site_mode = 'family' AND p.family != 1) OR (a.site_mode = 'everyone' AND p.everyone != 1)));
    SELECT RAISE(ABORT,'Archive clock is server owned') WHERE NEW.created_at != strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER private_archive_upload_admission BEFORE INSERT ON private_archive_multipart_uploads BEGIN
    SELECT RAISE(ABORT,'Archive upload is blocked or expired') WHERE
        EXISTS (SELECT 1 FROM private_archive_deletion_requests WHERE asset_id = NEW.asset_id) OR NOT EXISTS (
            SELECT 1 FROM private_archive_intakes WHERE asset_id = NEW.asset_id
            AND roster_generation = (SELECT generation FROM private_gallery_roster_version WHERE singleton = 1)
            AND unixepoch(created_at) + 86400 > unixepoch('now'));
END;
CREATE TRIGGER private_archive_original_admission BEFORE INSERT ON private_archive_original_receipts BEGIN
    SELECT RAISE(ABORT,'Archive original is blocked or mismatched') WHERE
        EXISTS (SELECT 1 FROM private_archive_deletion_requests WHERE asset_id = NEW.asset_id) OR NOT EXISTS (
            SELECT 1 FROM private_archive_intakes WHERE asset_id = NEW.asset_id AND byte_count = NEW.byte_count
            AND roster_generation = (SELECT generation FROM private_gallery_roster_version WHERE singleton = 1)
            AND sha256 = NEW.sha256 AND unixepoch(created_at) + 86400 > unixepoch('now'));
END;
CREATE TRIGGER private_archive_deletion_admission BEFORE INSERT ON private_archive_deletion_requests BEGIN
    SELECT RAISE(ABORT,'Archive deletion owner mismatch') WHERE NOT EXISTS (
        SELECT 1 FROM private_gallery_assets WHERE asset_id = NEW.asset_id AND owner_identity_hash = NEW.actor_identity_hash);
END;
CREATE TRIGGER private_archive_closure_admission BEFORE INSERT ON private_archive_writer_closures BEGIN
    SELECT RAISE(ABORT,'Archive writer identity mismatch') WHERE NOT EXISTS (
        SELECT 1 FROM private_archive_multipart_uploads WHERE asset_id = NEW.asset_id AND provider_upload_id = NEW.provider_upload_id);
END;
CREATE TRIGGER private_archive_deletion_completion BEFORE INSERT ON private_archive_deletion_receipts BEGIN
    SELECT RAISE(ABORT,'Archive writer closure required') WHERE EXISTS (
        SELECT 1 FROM private_archive_multipart_uploads u WHERE u.asset_id = NEW.asset_id AND NOT EXISTS (
            SELECT 1 FROM private_archive_writer_closures c WHERE c.asset_id = u.asset_id AND c.provider_upload_id = u.provider_upload_id));
END;

-- Receipts/attestations are append-only, including SQLite REPLACE. Deletion of
-- bytes is not metadata purge; a future separately gated purge must retain the
-- established hash-only terminal receipts, not rewrite these old attestations.
CREATE TRIGGER private_archive_intake_no_replace BEFORE INSERT ON private_archive_intakes
WHEN EXISTS (SELECT 1 FROM private_archive_intakes WHERE asset_id = NEW.asset_id) BEGIN SELECT RAISE(ABORT,'Archive intake already exists'); END;
CREATE TRIGGER private_archive_intake_no_update BEFORE UPDATE ON private_archive_intakes BEGIN SELECT RAISE(ABORT,'Archive intake immutable'); END;
CREATE TRIGGER private_archive_intake_no_delete BEFORE DELETE ON private_archive_intakes BEGIN SELECT RAISE(ABORT,'Archive purge not enabled'); END;
CREATE TRIGGER private_archive_upload_no_replace BEFORE INSERT ON private_archive_multipart_uploads
WHEN EXISTS (SELECT 1 FROM private_archive_multipart_uploads WHERE asset_id = NEW.asset_id OR provider_upload_id = NEW.provider_upload_id) BEGIN SELECT RAISE(ABORT,'Archive writer already exists'); END;
CREATE TRIGGER private_archive_upload_no_update BEFORE UPDATE ON private_archive_multipart_uploads BEGIN SELECT RAISE(ABORT,'Archive writer immutable'); END;
CREATE TRIGGER private_archive_upload_no_delete BEFORE DELETE ON private_archive_multipart_uploads BEGIN SELECT RAISE(ABORT,'Archive purge not enabled'); END;
CREATE TRIGGER private_archive_original_no_replace BEFORE INSERT ON private_archive_original_receipts
WHEN EXISTS (SELECT 1 FROM private_archive_original_receipts WHERE asset_id = NEW.asset_id) BEGIN SELECT RAISE(ABORT,'Archive original already exists'); END;
CREATE TRIGGER private_archive_original_no_update BEFORE UPDATE ON private_archive_original_receipts BEGIN SELECT RAISE(ABORT,'Archive original immutable'); END;
CREATE TRIGGER private_archive_original_no_delete BEFORE DELETE ON private_archive_original_receipts BEGIN SELECT RAISE(ABORT,'Archive purge not enabled'); END;
CREATE TRIGGER private_archive_deletion_no_replace BEFORE INSERT ON private_archive_deletion_requests
WHEN EXISTS (SELECT 1 FROM private_archive_deletion_requests WHERE asset_id = NEW.asset_id) BEGIN SELECT RAISE(ABORT,'Archive deletion already exists'); END;
CREATE TRIGGER private_archive_deletion_no_update BEFORE UPDATE ON private_archive_deletion_requests BEGIN SELECT RAISE(ABORT,'Archive deletion immutable'); END;
CREATE TRIGGER private_archive_deletion_no_delete BEFORE DELETE ON private_archive_deletion_requests BEGIN SELECT RAISE(ABORT,'Archive deletion terminal'); END;
CREATE TRIGGER private_archive_closure_no_replace BEFORE INSERT ON private_archive_writer_closures
WHEN EXISTS (SELECT 1 FROM private_archive_writer_closures WHERE asset_id = NEW.asset_id) BEGIN SELECT RAISE(ABORT,'Archive closure already exists'); END;
CREATE TRIGGER private_archive_closure_no_update BEFORE UPDATE ON private_archive_writer_closures BEGIN SELECT RAISE(ABORT,'Archive closure immutable'); END;
CREATE TRIGGER private_archive_closure_no_delete BEFORE DELETE ON private_archive_writer_closures BEGIN SELECT RAISE(ABORT,'Archive closure terminal'); END;
CREATE TRIGGER private_archive_receipt_no_replace BEFORE INSERT ON private_archive_deletion_receipts
WHEN EXISTS (SELECT 1 FROM private_archive_deletion_receipts WHERE asset_id = NEW.asset_id) BEGIN SELECT RAISE(ABORT,'Archive deletion already completed'); END;
CREATE TRIGGER private_archive_receipt_no_update BEFORE UPDATE ON private_archive_deletion_receipts BEGIN SELECT RAISE(ABORT,'Archive receipt immutable'); END;
CREATE TRIGGER private_archive_receipt_no_delete BEFORE DELETE ON private_archive_deletion_receipts BEGIN SELECT RAISE(ABORT,'Archive receipt terminal'); END;
