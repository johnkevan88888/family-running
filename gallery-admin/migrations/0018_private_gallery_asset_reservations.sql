-- Private reservations only: no upload, consent, publication or retention claim.
-- Deliberately independent of drafts and their terminal cleanup lifecycle.
CREATE TABLE private_gallery_assets (
    asset_id TEXT PRIMARY KEY NOT NULL CHECK (
        length(asset_id) = 42 AND substr(asset_id, 1, 6) = 'asset_' AND
        substr(asset_id, 15, 1) = '-' AND substr(asset_id, 20, 2) = '-4' AND
        substr(asset_id, 25, 1) = '-' AND substr(asset_id, 26, 1) IN ('8','9','a','b') AND
        substr(asset_id, 30, 1) = '-' AND
        length(replace(substr(asset_id, 7), '-', '')) = 32 AND
        replace(substr(asset_id, 7), '-', '') NOT GLOB '*[^0-9a-f]*'
    ),
    site_mode TEXT NOT NULL CHECK (site_mode IN ('family', 'everyone')),
    owner_identity_hash TEXT NOT NULL CHECK (length(owner_identity_hash) = 64 AND owner_identity_hash NOT GLOB '*[^0-9a-f]*'),
    idempotency_key TEXT NOT NULL CHECK (
        length(idempotency_key) = 36 AND substr(idempotency_key, 9, 1) = '-' AND
        substr(idempotency_key, 14, 2) = '-4' AND substr(idempotency_key, 19, 1) = '-' AND
        substr(idempotency_key, 20, 1) IN ('8','9','a','b') AND substr(idempotency_key, 24, 1) = '-' AND
        length(replace(idempotency_key, '-', '')) = 32 AND replace(idempotency_key, '-', '') NOT GLOB '*[^0-9a-f]*'
    ),
    request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
    roster_generation INTEGER NOT NULL CHECK (roster_generation BETWEEN 1 AND 9007199254740991),
    person_ids_json TEXT NOT NULL CHECK (json_valid(person_ids_json)),
    original_format TEXT NOT NULL CHECK (original_format IN ('jpg', 'png')),
    private_object_key TEXT UNIQUE NOT NULL CHECK (
        private_object_key = 'private-archive/v1/' || site_mode || '/' || asset_id || '/original.' || original_format
    ),
    state TEXT NOT NULL DEFAULT 'awaiting-original' CHECK (state = 'awaiting-original'),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (owner_identity_hash, site_mode, idempotency_key)
);

CREATE TABLE private_gallery_asset_tags (
    asset_id TEXT NOT NULL REFERENCES private_gallery_assets(asset_id) ON DELETE RESTRICT,
    person_id TEXT NOT NULL REFERENCES private_gallery_people(person_id) ON DELETE RESTRICT,
    ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 99),
    PRIMARY KEY (asset_id, person_id),
    UNIQUE (asset_id, ordinal)
);
CREATE INDEX private_gallery_asset_tags_person ON private_gallery_asset_tags(person_id, asset_id);

CREATE TRIGGER private_gallery_assets_admission
BEFORE INSERT ON private_gallery_assets BEGIN
    SELECT RAISE(ABORT, 'Private Gallery reservation cannot be replaced') WHERE EXISTS (
        SELECT 1 FROM private_gallery_assets WHERE asset_id = NEW.asset_id OR
            (owner_identity_hash = NEW.owner_identity_hash AND site_mode = NEW.site_mode AND idempotency_key = NEW.idempotency_key)
    );
    SELECT RAISE(ABORT, 'Private Gallery roster changed') WHERE NOT EXISTS (
        SELECT 1 FROM private_gallery_roster_version WHERE singleton = 1 AND generation = NEW.roster_generation
    );
    SELECT RAISE(ABORT, 'Complete private Gallery tags required') WHERE
        json_type(NEW.person_ids_json) != 'array' OR json_array_length(NEW.person_ids_json) NOT BETWEEN 1 AND 100;
    SELECT RAISE(ABORT, 'Invalid private Gallery tags') WHERE EXISTS (
        SELECT 1 FROM json_each(NEW.person_ids_json) j
        LEFT JOIN private_gallery_people p ON p.person_id = j.value
        WHERE j.type != 'text' OR p.person_id IS NULL OR
            (NEW.site_mode = 'family' AND p.family != 1) OR
            (NEW.site_mode = 'everyone' AND p.everyone != 1)
    );
    SELECT RAISE(ABORT, 'Duplicate private Gallery tags') WHERE
        (SELECT count(DISTINCT value) FROM json_each(NEW.person_ids_json)) != json_array_length(NEW.person_ids_json);
END;

-- One statement atomically reserves the asset AND all ordered associations.
CREATE TRIGGER private_gallery_assets_insert_tags
AFTER INSERT ON private_gallery_assets BEGIN
    INSERT INTO private_gallery_asset_tags (asset_id, person_id, ordinal)
        SELECT NEW.asset_id, value, key FROM json_each(NEW.person_ids_json);
END;
CREATE TRIGGER private_gallery_asset_tags_admission
BEFORE INSERT ON private_gallery_asset_tags BEGIN
    SELECT RAISE(ABORT, 'Private Gallery tag cannot be replaced') WHERE EXISTS (
        SELECT 1 FROM private_gallery_asset_tags WHERE asset_id = NEW.asset_id AND
            (person_id = NEW.person_id OR ordinal = NEW.ordinal)
    );
    SELECT RAISE(ABORT, 'Private Gallery tag must match reservation') WHERE NOT EXISTS (
        SELECT 1 FROM private_gallery_assets a, json_each(a.person_ids_json) j
        WHERE a.asset_id = NEW.asset_id AND j.key = NEW.ordinal AND j.value = NEW.person_id
    );
END;

-- No correction/deletion endpoint exists yet. A future forward migration must
-- define audited tag revisions and archive-specific consent/deletion cleanup
-- before real intake can be enabled; these are NOT permanent retention rules.
CREATE TRIGGER private_gallery_assets_no_update BEFORE UPDATE ON private_gallery_assets BEGIN
    SELECT RAISE(ABORT, 'Private Gallery reservation is immutable');
END;
CREATE TRIGGER private_gallery_assets_no_delete BEFORE DELETE ON private_gallery_assets BEGIN
    SELECT RAISE(ABORT, 'Private Gallery reservation cleanup is not enabled');
END;
CREATE TRIGGER private_gallery_asset_tags_no_update BEFORE UPDATE ON private_gallery_asset_tags BEGIN
    SELECT RAISE(ABORT, 'Private Gallery tag revision is not enabled');
END;
CREATE TRIGGER private_gallery_asset_tags_no_delete BEFORE DELETE ON private_gallery_asset_tags BEGIN
    SELECT RAISE(ABORT, 'Private Gallery tag cleanup is not enabled');
END;

-- SQLite REPLACE can implicitly delete a person through either unique key.
-- Stable private associations must never be rebound by that shortcut.
CREATE TRIGGER private_gallery_people_no_replace BEFORE INSERT ON private_gallery_people
WHEN EXISTS (SELECT 1 FROM private_gallery_people WHERE person_id = NEW.person_id OR
    (NEW.public_athlete_id IS NOT NULL AND public_athlete_id = NEW.public_athlete_id)) BEGIN
    SELECT RAISE(ABORT, 'Private Gallery person replacement is not permitted');
END;
