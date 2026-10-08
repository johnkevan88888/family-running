-- Owner-managed private identities and reversible visibility preferences.
-- These records are NOT public consent, completed withdrawal or publication.
CREATE TABLE private_gallery_person_requests (
    idempotency_key TEXT PRIMARY KEY NOT NULL,
    person_id TEXT UNIQUE NOT NULL,
    actor_identity_hash TEXT NOT NULL CHECK (length(actor_identity_hash) = 64 AND actor_identity_hash NOT GLOB '*[^0-9a-f]*'),
    request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
    roster_generation INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER private_gallery_person_request_admission
BEFORE INSERT ON private_gallery_person_requests BEGIN
    SELECT RAISE(ABORT,'Private roster changed') WHERE NOT EXISTS (
        SELECT 1 FROM private_gallery_roster_version WHERE singleton = 1 AND generation = NEW.roster_generation);
    SELECT RAISE(ABORT,'Person request cannot be replaced') WHERE EXISTS (
        SELECT 1 FROM private_gallery_person_requests WHERE idempotency_key = NEW.idempotency_key OR person_id = NEW.person_id);
END;
CREATE TRIGGER private_gallery_person_request_no_update BEFORE UPDATE ON private_gallery_person_requests
BEGIN SELECT RAISE(ABORT,'Person request immutable'); END;
CREATE TRIGGER private_gallery_person_request_no_delete BEFORE DELETE ON private_gallery_person_requests
BEGIN SELECT RAISE(ABORT,'Person request purge not enabled'); END;

CREATE TABLE private_gallery_visibility_events (
    person_id TEXT NOT NULL REFERENCES private_gallery_people(person_id),
    version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
    preference TEXT NOT NULL CHECK (preference IN ('hidden','allowed')),
    idempotency_key TEXT UNIQUE NOT NULL,
    actor_identity_hash TEXT,
    site_mode TEXT CHECK (site_mode IN ('family','everyone')),
    roster_generation INTEGER,
    request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (person_id,version),
    CHECK ((version = 1 AND preference = 'hidden' AND actor_identity_hash IS NULL AND site_mode IS NULL AND roster_generation IS NULL) OR
           (version > 1 AND actor_identity_hash IS NOT NULL AND length(actor_identity_hash) = 64 AND
            actor_identity_hash NOT GLOB '*[^0-9a-f]*' AND site_mode IS NOT NULL AND
            roster_generation IS NOT NULL AND roster_generation BETWEEN 1 AND 9007199254740991))
);
CREATE VIEW private_gallery_current_visibility AS
SELECT e.* FROM private_gallery_visibility_events e WHERE e.version = (
    SELECT max(version) FROM private_gallery_visibility_events WHERE person_id = e.person_id);

-- Existing privately stored identities also start blocked. No old draft is
-- linked, rewritten, resurrected or considered hidden by this migration.
INSERT INTO private_gallery_visibility_events
    (person_id,version,preference,idempotency_key,actor_identity_hash,request_hash)
SELECT person_id,1,'hidden','initial:' || person_id,NULL,printf('%064d',0) FROM private_gallery_people;
CREATE TRIGGER private_gallery_person_initial_visibility AFTER INSERT ON private_gallery_people BEGIN
    INSERT INTO private_gallery_visibility_events
        (person_id,version,preference,idempotency_key,actor_identity_hash,request_hash)
    VALUES (NEW.person_id,1,'hidden','initial:' || NEW.person_id,NULL,printf('%064d',0));
END;
CREATE TRIGGER private_gallery_visibility_admission BEFORE INSERT ON private_gallery_visibility_events BEGIN
    SELECT RAISE(ABORT,'Visibility event cannot be replaced') WHERE EXISTS (
        SELECT 1 FROM private_gallery_visibility_events WHERE
            (person_id = NEW.person_id AND version = NEW.version) OR idempotency_key = NEW.idempotency_key);
    SELECT RAISE(ABORT,'Visibility changed') WHERE NEW.version !=
        coalesce((SELECT max(version) + 1 FROM private_gallery_visibility_events WHERE person_id = NEW.person_id),1);
    SELECT RAISE(ABORT,'Visibility roster or area changed') WHERE NEW.version > 1 AND NOT EXISTS (
        SELECT 1 FROM private_gallery_people p JOIN private_gallery_roster_version v ON v.singleton = 1
        WHERE p.person_id = NEW.person_id AND v.generation = NEW.roster_generation AND
            ((NEW.site_mode = 'family' AND p.family = 1) OR (NEW.site_mode = 'everyone' AND p.everyone = 1)));
END;
CREATE TRIGGER private_gallery_visibility_no_update BEFORE UPDATE ON private_gallery_visibility_events
BEGIN SELECT RAISE(ABORT,'Visibility evidence immutable'); END;
CREATE TRIGGER private_gallery_visibility_no_delete BEFORE DELETE ON private_gallery_visibility_events
BEGIN SELECT RAISE(ABORT,'Visibility evidence purge not enabled'); END;
