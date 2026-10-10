-- Audited complete-tag corrections only. No draft/publication link or byte route.
-- The original reservation, tags, intake and permission evidence stay immutable.
CREATE TABLE private_gallery_tag_revisions (
    asset_id TEXT NOT NULL REFERENCES private_gallery_assets(asset_id),
    version INTEGER NOT NULL CHECK (version BETWEEN 2 AND 9007199254740991),
    idempotency_key TEXT UNIQUE NOT NULL CHECK (
        length(idempotency_key) = 36 AND substr(idempotency_key,9,1) = '-' AND
        substr(idempotency_key,14,2) = '-4' AND substr(idempotency_key,19,1) = '-' AND
        substr(idempotency_key,20,1) IN ('8','9','a','b') AND substr(idempotency_key,24,1) = '-' AND
        length(replace(idempotency_key,'-','')) = 32 AND replace(idempotency_key,'-','') NOT GLOB '*[^0-9a-f]*'),
    actor_identity_hash TEXT NOT NULL CHECK (length(actor_identity_hash) = 64 AND actor_identity_hash NOT GLOB '*[^0-9a-f]*'),
    request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
    roster_generation INTEGER NOT NULL CHECK (roster_generation BETWEEN 1 AND 9007199254740991),
    previous_person_ids_json TEXT NOT NULL CHECK (json_valid(previous_person_ids_json)),
    person_ids_json TEXT NOT NULL CHECK (json_valid(person_ids_json)),
    complete_tags_confirmed INTEGER NOT NULL CHECK (complete_tags_confirmed = 1),
    private_retention_confirmed INTEGER NOT NULL CHECK (private_retention_confirmed = 1),
    contains_minors INTEGER NOT NULL CHECK (contains_minors IN (0,1)),
    guardian_approval_confirmed INTEGER NOT NULL CHECK (guardian_approval_confirmed = contains_minors),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (asset_id,version)
);
CREATE TABLE private_gallery_revision_tags (
    asset_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    person_id TEXT NOT NULL REFERENCES private_gallery_people(person_id),
    ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 99),
    PRIMARY KEY (asset_id,version,person_id),
    UNIQUE (asset_id,version,ordinal),
    FOREIGN KEY (asset_id,version) REFERENCES private_gallery_tag_revisions(asset_id,version)
);
CREATE INDEX private_gallery_revision_tags_person ON private_gallery_revision_tags(person_id,asset_id);
CREATE VIEW private_gallery_current_tag_sets AS
SELECT a.asset_id,coalesce(r.version,1) AS tag_version,
    coalesce(r.person_ids_json,a.person_ids_json) AS current_person_ids_json
FROM private_gallery_assets a LEFT JOIN private_gallery_tag_revisions r ON r.asset_id = a.asset_id
    AND r.version = (SELECT max(version) FROM private_gallery_tag_revisions WHERE asset_id = a.asset_id);
CREATE VIEW private_gallery_current_asset_tags AS
SELECT t.asset_id,t.person_id,t.ordinal FROM private_gallery_asset_tags t
    JOIN private_gallery_current_tag_sets s ON s.asset_id = t.asset_id AND s.tag_version = 1
UNION ALL
SELECT t.asset_id,t.person_id,t.ordinal FROM private_gallery_revision_tags t
    JOIN private_gallery_current_tag_sets s ON s.asset_id = t.asset_id AND s.tag_version = t.version;

CREATE TRIGGER private_gallery_tag_revision_admission BEFORE INSERT ON private_gallery_tag_revisions BEGIN
    SELECT RAISE(ABORT,'Tag revision cannot be replaced') WHERE EXISTS (
        SELECT 1 FROM private_gallery_tag_revisions WHERE (asset_id = NEW.asset_id AND version = NEW.version)
            OR idempotency_key = NEW.idempotency_key);
    SELECT RAISE(ABORT,'Tag revision owner or version changed') WHERE NOT EXISTS (
        SELECT 1 FROM private_gallery_assets a JOIN private_gallery_current_tag_sets s ON s.asset_id = a.asset_id
        WHERE a.asset_id = NEW.asset_id AND a.owner_identity_hash = NEW.actor_identity_hash
            AND s.tag_version + 1 = NEW.version AND s.current_person_ids_json = NEW.previous_person_ids_json);
    SELECT RAISE(ABORT,'Tag revision roster changed') WHERE NOT EXISTS (
        SELECT 1 FROM private_gallery_roster_version WHERE singleton = 1 AND generation = NEW.roster_generation);
    SELECT RAISE(ABORT,'Complete tag revision required') WHERE json_type(NEW.person_ids_json) != 'array'
        OR json_array_length(NEW.person_ids_json) NOT BETWEEN 1 AND 100;
    SELECT RAISE(ABORT,'Duplicate tag revision') WHERE
        (SELECT count(DISTINCT value) FROM json_each(NEW.person_ids_json)) != json_array_length(NEW.person_ids_json);
    SELECT RAISE(ABORT,'Invalid tag revision or inherited area') WHERE EXISTS (
        SELECT 1 FROM json_each(NEW.person_ids_json) j
        LEFT JOIN private_gallery_people p ON p.person_id = j.value
        JOIN private_gallery_assets a ON a.asset_id = NEW.asset_id
        WHERE j.type != 'text' OR p.person_id IS NULL OR
            (a.site_mode = 'family' AND p.family != 1) OR (a.site_mode = 'everyone' AND p.everyone != 1));
    SELECT RAISE(ABORT,'Current tags incomplete') WHERE NOT EXISTS (
        SELECT 1 FROM private_gallery_current_tag_sets s WHERE s.asset_id = NEW.asset_id
        AND (SELECT count(*) FROM private_gallery_current_asset_tags t WHERE t.asset_id = s.asset_id) = json_array_length(s.current_person_ids_json)
        AND NOT EXISTS (SELECT 1 FROM json_each(s.current_person_ids_json) j
            LEFT JOIN private_gallery_current_asset_tags t ON t.asset_id = s.asset_id AND t.ordinal = j.key AND t.person_id = j.value
            WHERE t.person_id IS NULL));
    SELECT RAISE(ABORT,'Deleted archive cannot be retagged') WHERE EXISTS (
        SELECT 1 FROM private_archive_deletion_requests WHERE asset_id = NEW.asset_id);
    -- Do not change the people covered by an in-flight, expired or uncertain writer.
    SELECT RAISE(ABORT,'Original intake unfinished') WHERE EXISTS (
        SELECT 1 FROM private_archive_intakes i WHERE i.asset_id = NEW.asset_id AND NOT EXISTS (
            SELECT 1 FROM private_archive_original_receipts o WHERE o.asset_id = i.asset_id));
    SELECT RAISE(ABORT,'Tag correction clock is server owned') WHERE NEW.created_at != strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER private_gallery_tag_revision_associations AFTER INSERT ON private_gallery_tag_revisions BEGIN
    INSERT INTO private_gallery_revision_tags (asset_id,version,person_id,ordinal)
        SELECT NEW.asset_id,NEW.version,value,key FROM json_each(NEW.person_ids_json);
END;
CREATE TRIGGER private_gallery_revision_tag_admission BEFORE INSERT ON private_gallery_revision_tags BEGIN
    SELECT RAISE(ABORT,'Revision association cannot be replaced') WHERE EXISTS (
        SELECT 1 FROM private_gallery_revision_tags WHERE asset_id = NEW.asset_id AND version = NEW.version
            AND (person_id = NEW.person_id OR ordinal = NEW.ordinal));
    SELECT RAISE(ABORT,'Revision association must match complete tags') WHERE NOT EXISTS (
        SELECT 1 FROM private_gallery_tag_revisions r,json_each(r.person_ids_json) j
        WHERE r.asset_id = NEW.asset_id AND r.version = NEW.version AND j.key = NEW.ordinal AND j.value = NEW.person_id);
END;
CREATE TRIGGER private_gallery_tag_revision_no_update BEFORE UPDATE ON private_gallery_tag_revisions
BEGIN SELECT RAISE(ABORT,'Tag history immutable'); END;
CREATE TRIGGER private_gallery_tag_revision_no_delete BEFORE DELETE ON private_gallery_tag_revisions
BEGIN SELECT RAISE(ABORT,'Tag history purge not enabled'); END;
CREATE TRIGGER private_gallery_revision_tag_no_update BEFORE UPDATE ON private_gallery_revision_tags
BEGIN SELECT RAISE(ABORT,'Tag association immutable'); END;
CREATE TRIGGER private_gallery_revision_tag_no_delete BEFORE DELETE ON private_gallery_revision_tags
BEGIN SELECT RAISE(ABORT,'Tag association purge not enabled'); END;

-- Bind new intake to the exact current tag version, never reassign old consent.
ALTER TABLE private_archive_intakes ADD COLUMN tag_version INTEGER NOT NULL DEFAULT 1
    CHECK (tag_version BETWEEN 1 AND 9007199254740991);
DROP TRIGGER private_archive_intake_admission;
CREATE TRIGGER private_archive_intake_admission BEFORE INSERT ON private_archive_intakes BEGIN
    SELECT RAISE(ABORT,'Archive intake is terminally blocked') WHERE EXISTS (
        SELECT 1 FROM private_archive_deletion_requests WHERE asset_id = NEW.asset_id);
    SELECT RAISE(ABORT,'Archive roster changed') WHERE NOT EXISTS (
        SELECT 1 FROM private_gallery_roster_version WHERE singleton = 1 AND generation = NEW.roster_generation);
    SELECT RAISE(ABORT,'Complete current archive tags required') WHERE NOT EXISTS (
        SELECT 1 FROM private_gallery_assets a JOIN private_gallery_current_tag_sets s ON s.asset_id = a.asset_id
        WHERE a.asset_id = NEW.asset_id AND s.tag_version = NEW.tag_version
        AND (SELECT count(*) FROM private_gallery_current_asset_tags t WHERE t.asset_id = a.asset_id) = json_array_length(s.current_person_ids_json)
        AND NOT EXISTS (
            SELECT 1 FROM json_each(s.current_person_ids_json) j
            LEFT JOIN private_gallery_current_asset_tags t ON t.asset_id = a.asset_id AND t.person_id = j.value AND t.ordinal = j.key
            LEFT JOIN private_gallery_people p ON p.person_id = j.value
            WHERE t.person_id IS NULL OR p.person_id IS NULL OR
                (a.site_mode = 'family' AND p.family != 1) OR (a.site_mode = 'everyone' AND p.everyone != 1)));
    SELECT RAISE(ABORT,'Archive clock is server owned') WHERE NEW.created_at != strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER private_archive_upload_tag_version BEFORE INSERT ON private_archive_multipart_uploads BEGIN
    SELECT RAISE(ABORT,'Upload tag version changed') WHERE NOT EXISTS (
        SELECT 1 FROM private_archive_intakes i JOIN private_gallery_current_tag_sets s ON s.asset_id = i.asset_id
        WHERE i.asset_id = NEW.asset_id AND i.tag_version = s.tag_version);
END;
CREATE TRIGGER private_archive_original_tag_version BEFORE INSERT ON private_archive_original_receipts BEGIN
    SELECT RAISE(ABORT,'Original tag version changed') WHERE NOT EXISTS (
        SELECT 1 FROM private_archive_intakes i JOIN private_gallery_current_tag_sets s ON s.asset_id = i.asset_id
        WHERE i.asset_id = NEW.asset_id AND i.tag_version = s.tag_version);
END;
