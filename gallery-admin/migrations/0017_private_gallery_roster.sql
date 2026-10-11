-- Private owner catalogue only. No public IDs/names are seeded. This migration
-- does not change draft consent, exclusions, retention, storage keys or receipts.
CREATE TABLE private_gallery_roster_version (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991)
);
INSERT INTO private_gallery_roster_version (singleton, generation) VALUES (1, 1);

CREATE TRIGGER private_gallery_roster_version_insert_guard
BEFORE INSERT ON private_gallery_roster_version
WHEN EXISTS (SELECT 1 FROM private_gallery_roster_version)
BEGIN
    SELECT RAISE(ABORT, 'Private Gallery revision cannot be replaced');
END;

CREATE TABLE private_gallery_people (
    person_id TEXT PRIMARY KEY NOT NULL CHECK (
        length(person_id) = 43 AND substr(person_id, 1, 7) = 'person_' AND
        substr(person_id, 16, 1) = '-' AND substr(person_id, 21, 1) = '-' AND
        substr(person_id, 26, 1) = '-' AND substr(person_id, 31, 1) = '-' AND
        length(replace(substr(person_id, 8), '-', '')) = 32 AND
        replace(substr(person_id, 8), '-', '') NOT GLOB '*[^0-9a-f]*'
    ),
    display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
    public_athlete_id TEXT UNIQUE CHECK (
        public_athlete_id IS NULL OR (
            length(public_athlete_id) BETWEEN 1 AND 128 AND
            public_athlete_id NOT GLOB '*[^a-z0-9-]*' AND
            substr(public_athlete_id, 1, 1) != '-' AND
            substr(public_athlete_id, -1, 1) != '-' AND
            instr(public_athlete_id, '--') = 0
        )
    ),
    family INTEGER NOT NULL CHECK (family IN (0, 1)),
    everyone INTEGER NOT NULL CHECK (everyone IN (0, 1)),
    CHECK (family + everyone >= 1)
);

CREATE TRIGGER private_gallery_person_identity_guard
BEFORE UPDATE OF person_id ON private_gallery_people
WHEN NEW.person_id != OLD.person_id
BEGIN
    SELECT RAISE(ABORT, 'Private Gallery identity cannot be reassigned');
END;

-- Every edit invalidates a previous selector revision, including an edit which
-- restores earlier values. Future imports must update the roster transactionally.
CREATE TRIGGER private_gallery_people_insert_revision
AFTER INSERT ON private_gallery_people BEGIN
    UPDATE private_gallery_roster_version SET generation = generation + 1 WHERE singleton = 1;
END;
CREATE TRIGGER private_gallery_people_update_revision
AFTER UPDATE ON private_gallery_people BEGIN
    UPDATE private_gallery_roster_version SET generation = generation + 1 WHERE singleton = 1;
END;
CREATE TRIGGER private_gallery_people_delete_revision
AFTER DELETE ON private_gallery_people BEGIN
    UPDATE private_gallery_roster_version SET generation = generation + 1 WHERE singleton = 1;
END;

CREATE TRIGGER private_gallery_roster_version_update_guard
BEFORE UPDATE ON private_gallery_roster_version
WHEN NEW.singleton != OLD.singleton OR NEW.generation != OLD.generation + 1
BEGIN
    SELECT RAISE(ABORT, 'Private Gallery revision must advance');
END;
CREATE TRIGGER private_gallery_roster_version_delete_guard
BEFORE DELETE ON private_gallery_roster_version BEGIN
    SELECT RAISE(ABORT, 'Private Gallery revision cannot be removed');
END;
