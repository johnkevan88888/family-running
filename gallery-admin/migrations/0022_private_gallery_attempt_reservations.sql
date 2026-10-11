-- Internal preparation only: a new consent-bound attempt, NOT a legacy draft,
-- processing approval, storage transfer or public generation admission.
CREATE TABLE private_gallery_attempts (
    attempt_id TEXT PRIMARY KEY NOT NULL CHECK (attempt_id GLOB 'attempt_*' AND length(attempt_id) = 44),
    asset_id TEXT NOT NULL REFERENCES private_gallery_assets(asset_id),
    site_mode TEXT NOT NULL CHECK (site_mode IN ('family','everyone')),
    generation_id TEXT UNIQUE NOT NULL,
    public_item_id TEXT UNIQUE NOT NULL,
    idempotency_key TEXT UNIQUE NOT NULL,
    owner_identity_hash TEXT NOT NULL CHECK (length(owner_identity_hash) = 64 AND owner_identity_hash NOT GLOB '*[^0-9a-f]*'),
    request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
    roster_generation INTEGER NOT NULL CHECK (roster_generation BETWEEN 1 AND 9007199254740991),
    tag_version INTEGER NOT NULL CHECK (tag_version BETWEEN 1 AND 9007199254740991),
    person_ids_json TEXT NOT NULL CHECK (json_valid(person_ids_json)),
    visibility_json TEXT NOT NULL CHECK (json_valid(visibility_json)),
    public_athlete_ids_json TEXT NOT NULL CHECK (json_valid(public_athlete_ids_json)),
    eligibility_revision TEXT NOT NULL,
    export_bundle_id TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    suppression_revision TEXT NOT NULL,
    race_date TEXT NOT NULL,
    race_event TEXT NOT NULL,
    race_distance TEXT NOT NULL,
    original_byte_count INTEGER NOT NULL CHECK (original_byte_count BETWEEN 1 AND 26214400),
    original_sha256 TEXT NOT NULL,
    original_provider_version TEXT NOT NULL,
    original_provider_etag TEXT NOT NULL,
    complete_tags_confirmed INTEGER NOT NULL CHECK (complete_tags_confirmed = 1),
    public_use_confirmed INTEGER NOT NULL CHECK (public_use_confirmed = 1),
    contains_minors INTEGER NOT NULL CHECK (contains_minors IN (0,1)),
    guardian_approval_confirmed INTEGER NOT NULL CHECK (guardian_approval_confirmed = contains_minors),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Split shallow pure-read guards so provider D1 compiles the actual INSERT.
CREATE TRIGGER private_gallery_attempt_identity BEFORE INSERT ON private_gallery_attempts BEGIN
    SELECT RAISE(ABORT,'Attempt cannot be replaced') WHERE EXISTS (
        SELECT 1 FROM private_gallery_attempts WHERE attempt_id = NEW.attempt_id OR generation_id = NEW.generation_id
            OR public_item_id = NEW.public_item_id OR idempotency_key = NEW.idempotency_key);
    SELECT RAISE(ABORT,'Attempt identifiers must be opaque v4 UUIDs') WHERE EXISTS (
        SELECT 1 FROM json_each(json_array(substr(NEW.attempt_id,9),NEW.generation_id,substr(NEW.public_item_id,7),NEW.idempotency_key))
        WHERE length(value) != 36 OR substr(value,9,1) != '-' OR substr(value,14,2) != '-4'
            OR substr(value,19,1) != '-' OR substr(value,20,1) NOT IN ('8','9','a','b') OR substr(value,24,1) != '-'
            OR length(replace(value,'-','')) != 32 OR replace(value,'-','') GLOB '*[^0-9a-f]*');
    SELECT RAISE(ABORT,'Public item prefix invalid') WHERE substr(NEW.public_item_id,1,6) != 'photo-';
    SELECT RAISE(ABORT,'Attempt owner or area changed') WHERE NOT EXISTS (
        SELECT 1 FROM private_gallery_assets WHERE asset_id = NEW.asset_id AND site_mode = NEW.site_mode
            AND owner_identity_hash = NEW.owner_identity_hash);
    SELECT RAISE(ABORT,'Attempt roster changed') WHERE NOT EXISTS (
        SELECT 1 FROM private_gallery_roster_version WHERE singleton = 1 AND generation = NEW.roster_generation);
    SELECT RAISE(ABORT,'Attempt clock is server owned') WHERE NEW.created_at != strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER private_gallery_attempt_complete_tags BEFORE INSERT ON private_gallery_attempts BEGIN
    SELECT RAISE(ABORT,'Attempt current complete tags required') WHERE NOT EXISTS (
        SELECT 1 FROM private_gallery_current_tag_sets s WHERE s.asset_id = NEW.asset_id
        AND s.tag_version = NEW.tag_version AND s.current_person_ids_json = NEW.person_ids_json
        AND json_type(s.current_person_ids_json) = 'array' AND json_array_length(s.current_person_ids_json) BETWEEN 1 AND 100
        AND (SELECT count(*) FROM private_gallery_current_asset_tags t WHERE t.asset_id = s.asset_id) = json_array_length(s.current_person_ids_json)
        AND NOT EXISTS (SELECT 1 FROM json_each(s.current_person_ids_json) j
            LEFT JOIN private_gallery_current_asset_tags t ON t.asset_id = s.asset_id AND t.ordinal = j.key AND t.person_id = j.value
            LEFT JOIN private_gallery_people p ON p.person_id = j.value
            WHERE t.person_id IS NULL OR p.person_id IS NULL OR
                (NEW.site_mode = 'family' AND p.family != 1) OR (NEW.site_mode = 'everyone' AND p.everyone != 1)));
    SELECT RAISE(ABORT,'Attempt complete visibility required') WHERE json_type(NEW.visibility_json) != 'array'
        OR json_array_length(NEW.visibility_json) != json_array_length(NEW.person_ids_json)
        OR EXISTS (SELECT 1 FROM json_each(NEW.person_ids_json) j
            LEFT JOIN private_gallery_current_visibility v ON v.person_id = j.value
            WHERE v.person_id IS NULL OR v.preference != 'allowed'
                OR json_extract(NEW.visibility_json,'$[' || j.key || ']') IS NOT json_array(j.value,v.version,v.preference));
    SELECT RAISE(ABORT,'Attempt public projection changed') WHERE NEW.public_athlete_ids_json IS NOT (
        SELECT json_group_array(public_athlete_id) FROM (
            SELECT p.public_athlete_id FROM json_each(NEW.person_ids_json) j JOIN private_gallery_people p ON p.person_id = j.value
            WHERE p.public_athlete_id IS NOT NULL ORDER BY j.key));
    SELECT RAISE(ABORT,'Attempt pending exclusion') WHERE EXISTS (
        SELECT 1 FROM json_each(NEW.public_athlete_ids_json) j JOIN pending_athlete_exclusions e ON e.athlete_id = j.value
        WHERE e.resolved_at IS NULL);
END;
CREATE TRIGGER private_gallery_attempt_original BEFORE INSERT ON private_gallery_attempts BEGIN
    SELECT RAISE(ABORT,'Deleted archive cannot start attempt') WHERE EXISTS (
        SELECT 1 FROM private_archive_deletion_requests WHERE asset_id = NEW.asset_id);
    SELECT RAISE(ABORT,'Retained original receipt required') WHERE NOT EXISTS (
        SELECT 1 FROM private_archive_original_receipts o JOIN private_archive_intakes i ON i.asset_id = o.asset_id
        WHERE o.asset_id = NEW.asset_id AND o.byte_count = NEW.original_byte_count AND o.sha256 = NEW.original_sha256
            AND o.provider_version = NEW.original_provider_version AND o.provider_etag = NEW.original_provider_etag
            AND i.byte_count = o.byte_count AND i.sha256 = o.sha256);
    -- New answers cannot silently remove a recorded child's guardian gate.
    SELECT RAISE(ABORT,'Current tag guardian declaration changed') WHERE NEW.contains_minors IS NOT (
        SELECT CASE WHEN NEW.tag_version = 1 THEN i.contains_minors ELSE r.contains_minors END
        FROM private_archive_intakes i LEFT JOIN private_gallery_tag_revisions r
            ON r.asset_id = i.asset_id AND r.version = NEW.tag_version WHERE i.asset_id = NEW.asset_id);
END;
CREATE TRIGGER private_gallery_attempt_no_update BEFORE UPDATE ON private_gallery_attempts
BEGIN SELECT RAISE(ABORT,'Attempt evidence immutable'); END;
CREATE TRIGGER private_gallery_attempt_no_delete BEFORE DELETE ON private_gallery_attempts
BEGIN SELECT RAISE(ABORT,'Attempt purge not enabled'); END;
