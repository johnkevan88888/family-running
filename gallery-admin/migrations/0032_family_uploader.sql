-- Trusted-owner Family uploader. No grants, people or media are backfilled.
CREATE TABLE family_gallery_permissions (
 owner_hash TEXT NOT NULL CHECK(length(owner_hash)=64 AND owner_hash NOT GLOB '*[^0-9a-f]*'),
 version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 9007199254740991),
 active INTEGER NOT NULL CHECK(active IN(0,1)),
 guardians INTEGER NOT NULL CHECK(guardians IN(0,1) AND guardians<=active),
 idempotency_key TEXT UNIQUE NOT NULL,
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(owner_hash,version)
);
CREATE VIEW family_gallery_current_permission AS
 SELECT p.* FROM family_gallery_permissions p WHERE p.version=(
  SELECT max(version) FROM family_gallery_permissions WHERE owner_hash=p.owner_hash);
CREATE TRIGGER family_gallery_permission_guard BEFORE INSERT ON family_gallery_permissions BEGIN
 SELECT RAISE(ABORT,'Permission version changed') WHERE NEW.version!=coalesce((
  SELECT max(version)+1 FROM family_gallery_permissions WHERE owner_hash=NEW.owner_hash),1);
 SELECT RAISE(ABORT,'Permission cannot be replaced') WHERE EXISTS(
  SELECT 1 FROM family_gallery_permissions WHERE idempotency_key=NEW.idempotency_key);
END;
CREATE TRIGGER family_gallery_permission_no_update BEFORE UPDATE ON family_gallery_permissions
 BEGIN SELECT RAISE(ABORT,'Permission history immutable'); END;
CREATE TRIGGER family_gallery_permission_no_delete BEFORE DELETE ON family_gallery_permissions
 BEGIN SELECT RAISE(ABORT,'Permission history immutable'); END;

ALTER TABLE private_archive_intakes ADD COLUMN standing_permission_version INTEGER
 CHECK(standing_permission_version IS NULL OR standing_permission_version BETWEEN 1 AND 9007199254740991);
ALTER TABLE private_gallery_attempts ADD COLUMN standing_permission_version INTEGER
 CHECK(standing_permission_version IS NULL OR standing_permission_version BETWEEN 1 AND 9007199254740991);

-- An explicit photo exception covers every generation of this retained asset.
-- It does not delete the original or claim that public copies are already gone.
CREATE TABLE family_gallery_photo_permissions (
 asset_id TEXT NOT NULL REFERENCES private_gallery_assets(asset_id) ON DELETE CASCADE,
 version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 9007199254740991),
 preference TEXT NOT NULL CHECK(preference IN('allowed','hidden')),
 owner_hash TEXT NOT NULL CHECK(length(owner_hash)=64),
 idempotency_key TEXT NOT NULL UNIQUE,
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(asset_id,version)
);
CREATE VIEW family_gallery_current_photo_permission AS SELECT p.* FROM family_gallery_photo_permissions p
 WHERE p.version=(SELECT max(version) FROM family_gallery_photo_permissions WHERE asset_id=p.asset_id);
CREATE TRIGGER family_gallery_photo_permission_guard BEFORE INSERT ON family_gallery_photo_permissions BEGIN
 SELECT RAISE(ABORT,'Family photo permission owner required') WHERE NOT EXISTS(
  SELECT 1 FROM private_gallery_assets WHERE asset_id=NEW.asset_id AND owner_identity_hash=NEW.owner_hash AND site_mode='family');
 SELECT RAISE(ABORT,'Photo permission version changed') WHERE NEW.version!=coalesce((
  SELECT max(version)+1 FROM family_gallery_photo_permissions WHERE asset_id=NEW.asset_id),1);
 SELECT RAISE(ABORT,'Photo permission cannot be replaced') WHERE EXISTS(
  SELECT 1 FROM family_gallery_photo_permissions WHERE idempotency_key=NEW.idempotency_key);
END;
CREATE TRIGGER family_gallery_photo_permission_immutable BEFORE UPDATE ON family_gallery_photo_permissions
 BEGIN SELECT RAISE(ABORT,'Photo permission history immutable'); END;
CREATE TRIGGER family_gallery_photo_permission_keep BEFORE DELETE ON family_gallery_photo_permissions BEGIN
 SELECT RAISE(ABORT,'Only coordinated purge removes photo permission') WHERE NOT EXISTS(
  SELECT 1 FROM private_archive_purge_operations WHERE asset_id=OLD.asset_id);
END;
CREATE TRIGGER family_gallery_photo_permission_close AFTER INSERT ON family_gallery_photo_permissions
 WHEN NEW.preference='hidden' BEGIN
 INSERT INTO private_gallery_pipeline_closures(attempt_id,reason)
  SELECT attempt_id,'visibility' FROM private_gallery_attempts a WHERE a.asset_id=NEW.asset_id
   AND NOT EXISTS(SELECT 1 FROM private_gallery_pipeline_closures c WHERE c.attempt_id=a.attempt_id);
END;

CREATE TRIGGER family_gallery_intake_permission BEFORE INSERT ON private_archive_intakes
 WHEN NEW.standing_permission_version IS NOT NULL BEGIN
 SELECT RAISE(ABORT,'Current Family retention permission required') WHERE NOT EXISTS(
  SELECT 1 FROM private_gallery_assets a JOIN family_gallery_current_permission p ON p.owner_hash=a.owner_identity_hash
  WHERE a.asset_id=NEW.asset_id AND a.site_mode='family' AND p.active=1
   AND p.version=NEW.standing_permission_version AND (NEW.contains_minors=0 OR p.guardians=1));
END;
CREATE TRIGGER family_gallery_attempt_permission BEFORE INSERT ON private_gallery_attempts BEGIN
 SELECT RAISE(ABORT,'Photo public use withdrawn') WHERE EXISTS(
  SELECT 1 FROM family_gallery_current_photo_permission WHERE asset_id=NEW.asset_id AND preference='hidden');
 SELECT RAISE(ABORT,'Standing permission basis cannot be omitted') WHERE NEW.standing_permission_version IS NULL
  AND EXISTS(SELECT 1 FROM private_archive_intakes WHERE asset_id=NEW.asset_id AND standing_permission_version IS NOT NULL);
 SELECT RAISE(ABORT,'Current Family public-use permission required') WHERE NEW.standing_permission_version IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM family_gallery_current_permission p WHERE p.owner_hash=NEW.owner_identity_hash
   AND NEW.site_mode='family' AND p.version=NEW.standing_permission_version AND p.active=1
   AND (NEW.contains_minors=0 OR p.guardians=1));
END;

CREATE TRIGGER family_gallery_upload_permission BEFORE INSERT ON private_archive_multipart_uploads BEGIN
 SELECT RAISE(ABORT,'Family intake permission changed') WHERE EXISTS(
  SELECT 1 FROM private_archive_intakes i JOIN private_gallery_assets a USING(asset_id)
  WHERE i.asset_id=NEW.asset_id AND i.standing_permission_version IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM family_gallery_current_permission p WHERE p.owner_hash=a.owner_identity_hash
    AND p.version=i.standing_permission_version AND p.active=1 AND (i.contains_minors=0 OR p.guardians=1)));
END;
CREATE TRIGGER family_gallery_receipt_permission BEFORE INSERT ON private_archive_original_receipts BEGIN
 SELECT RAISE(ABORT,'Family intake permission changed') WHERE EXISTS(
  SELECT 1 FROM private_archive_intakes i JOIN private_gallery_assets a USING(asset_id)
  WHERE i.asset_id=NEW.asset_id AND i.standing_permission_version IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM family_gallery_current_permission p WHERE p.owner_hash=a.owner_identity_hash
    AND p.version=i.standing_permission_version AND p.active=1 AND (i.contains_minors=0 OR p.guardians=1)));
END;

-- Preserve every existing predicate. Add a current standing-policy check at
-- the common SQL boundary used by processing, promotion, review and publication.
DROP VIEW private_gallery_current_attempt_permissions;
CREATE VIEW private_gallery_current_attempt_permissions AS
 SELECT a.attempt_id FROM private_gallery_attempts a
 JOIN private_gallery_assets asset ON asset.asset_id=a.asset_id
 JOIN private_gallery_roster_version roster ON roster.singleton=1 AND roster.generation=a.roster_generation
 JOIN private_gallery_current_tag_sets tags ON tags.asset_id=a.asset_id
 JOIN private_archive_original_receipts original ON original.asset_id=a.asset_id
 WHERE asset.owner_identity_hash=a.owner_identity_hash AND asset.site_mode=a.site_mode
  AND tags.tag_version=a.tag_version AND tags.current_person_ids_json=a.person_ids_json
  AND unixepoch(a.created_at)+86400>unixepoch('now')
  AND original.sha256=a.original_sha256 AND original.byte_count=a.original_byte_count
  AND original.provider_version=a.original_provider_version AND original.provider_etag=a.original_provider_etag
  AND NOT EXISTS(SELECT 1 FROM private_archive_deletion_requests d WHERE d.asset_id=a.asset_id)
  AND NOT EXISTS(SELECT 1 FROM family_gallery_current_photo_permission p WHERE p.asset_id=a.asset_id AND p.preference='hidden')
  AND NOT EXISTS(SELECT 1 FROM json_each(a.person_ids_json) j
   LEFT JOIN private_gallery_people p ON p.person_id=j.value
   LEFT JOIN private_gallery_current_visibility v ON v.person_id=j.value
   LEFT JOIN private_gallery_current_asset_tags t ON t.asset_id=a.asset_id AND t.ordinal=j.key AND t.person_id=j.value
   WHERE p.person_id IS NULL OR t.person_id IS NULL OR v.preference IS NOT 'allowed'
    OR json_extract(a.visibility_json,'$['||j.key||']') IS NOT json_array(j.value,v.version,v.preference)
    OR (a.site_mode='family' AND p.family!=1) OR (a.site_mode='everyone' AND p.everyone!=1))
  AND (SELECT count(*) FROM private_gallery_current_asset_tags WHERE asset_id=a.asset_id)=json_array_length(a.person_ids_json)
  AND a.public_athlete_ids_json IS (SELECT json_group_array(public_athlete_id) FROM
   (SELECT p.public_athlete_id FROM json_each(a.person_ids_json) j JOIN private_gallery_people p ON p.person_id=j.value
    WHERE p.public_athlete_id IS NOT NULL ORDER BY j.key))
  AND NOT EXISTS(SELECT 1 FROM json_each(a.public_athlete_ids_json) j JOIN pending_athlete_exclusions e ON e.athlete_id=j.value WHERE e.resolved_at IS NULL)
  AND (a.standing_permission_version IS NULL OR EXISTS(SELECT 1 FROM family_gallery_current_permission p
   WHERE a.site_mode='family' AND p.owner_hash=a.owner_identity_hash AND p.version=a.standing_permission_version
    AND p.active=1 AND (a.contains_minors=0 OR p.guardians=1)));

-- Drafts are editable private metadata, never immutable submitted membership.
-- Names, filenames, face detections and original pixels are not stored here.
CREATE TABLE family_gallery_drafts (
 draft_id TEXT PRIMARY KEY NOT NULL CHECK(length(draft_id)=36),
 owner_hash TEXT NOT NULL CHECK(length(owner_hash)=64),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version BETWEEN 0 AND 9007199254740991),
 state TEXT NOT NULL DEFAULT 'editing' CHECK(state IN('editing','submitting','submitted')),
 submission_key TEXT UNIQUE,
 job_id TEXT UNIQUE REFERENCES private_gallery_batch_jobs(job_id) ON DELETE SET NULL,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE family_gallery_draft_photos (
 photo_id TEXT PRIMARY KEY NOT NULL CHECK(length(photo_id)=36),
 draft_id TEXT NOT NULL REFERENCES family_gallery_drafts(draft_id),
 ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 19),
 metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json) AND length(metadata_json)<=16384),
 reservation_json TEXT CHECK(reservation_json IS NULL OR json_valid(reservation_json)),
 asset_id TEXT UNIQUE REFERENCES private_gallery_assets(asset_id) ON DELETE CASCADE,
 intake_json TEXT CHECK(intake_json IS NULL OR json_valid(intake_json)),
 attempt_key TEXT UNIQUE,
 attempt_id TEXT UNIQUE REFERENCES private_gallery_attempts(attempt_id) ON DELETE SET NULL,
 UNIQUE(draft_id,ordinal)
);
CREATE TABLE family_gallery_draft_writes (
 idempotency_key TEXT PRIMARY KEY NOT NULL,
 draft_id TEXT NOT NULL REFERENCES family_gallery_drafts(draft_id),
 expected_version INTEGER NOT NULL CHECK(expected_version>=0),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 UNIQUE(draft_id,expected_version)
);
CREATE TRIGGER family_gallery_draft_write_guard BEFORE INSERT ON family_gallery_draft_writes BEGIN
 SELECT RAISE(ABORT,'Draft changed or submitted') WHERE NOT EXISTS(SELECT 1 FROM family_gallery_drafts
  WHERE draft_id=NEW.draft_id AND version=NEW.expected_version AND state='editing');
 SELECT RAISE(ABORT,'Draft write cannot be replaced') WHERE EXISTS(SELECT 1 FROM family_gallery_draft_writes
  WHERE idempotency_key=NEW.idempotency_key OR (draft_id=NEW.draft_id AND expected_version=NEW.expected_version));
END;
CREATE TRIGGER family_gallery_draft_write_advance AFTER INSERT ON family_gallery_draft_writes BEGIN
 UPDATE family_gallery_drafts SET version=version+1 WHERE draft_id=NEW.draft_id;
END;
CREATE TRIGGER family_gallery_draft_write_immutable BEFORE UPDATE ON family_gallery_draft_writes
 BEGIN SELECT RAISE(ABORT,'Draft receipt immutable'); END;
CREATE TRIGGER family_gallery_draft_write_keep BEFORE DELETE ON family_gallery_draft_writes
 BEGIN SELECT RAISE(ABORT,'Draft receipt immutable'); END;
CREATE TRIGGER family_gallery_draft_photo_owner BEFORE INSERT ON family_gallery_draft_photos BEGIN
 SELECT RAISE(ABORT,'Editable owner draft required') WHERE NOT EXISTS(
  SELECT 1 FROM family_gallery_drafts WHERE draft_id=NEW.draft_id AND state='editing');
 SELECT RAISE(ABORT,'Photo cannot be replaced') WHERE EXISTS(
  SELECT 1 FROM family_gallery_draft_photos WHERE photo_id=NEW.photo_id);
END;
CREATE TRIGGER family_gallery_draft_photo_guard BEFORE UPDATE ON family_gallery_draft_photos BEGIN
 SELECT RAISE(ABORT,'Draft photo identity immutable') WHERE NEW.photo_id!=OLD.photo_id OR NEW.draft_id!=OLD.draft_id;
 SELECT RAISE(ABORT,'Reserved photo metadata immutable') WHERE OLD.reservation_json IS NOT NULL
  AND (NEW.metadata_json!=OLD.metadata_json OR NEW.reservation_json IS NOT OLD.reservation_json OR NEW.ordinal!=OLD.ordinal);
 SELECT RAISE(ABORT,'Retained photo cannot be replaced') WHERE OLD.asset_id IS NOT NULL AND NEW.asset_id IS NOT OLD.asset_id;
 SELECT RAISE(ABORT,'Intake evidence immutable') WHERE OLD.intake_json IS NOT NULL AND NEW.intake_json IS NOT OLD.intake_json;
 SELECT RAISE(ABORT,'Attempt key immutable') WHERE OLD.attempt_key IS NOT NULL AND NEW.attempt_key IS NOT OLD.attempt_key;
 SELECT RAISE(ABORT,'Attempt binding immutable') WHERE OLD.attempt_id IS NOT NULL AND NEW.attempt_id IS NOT OLD.attempt_id
  AND NOT EXISTS(SELECT 1 FROM private_archive_purge_operations WHERE asset_id=OLD.asset_id);
 SELECT RAISE(ABORT,'Foreign asset') WHERE NEW.asset_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM private_gallery_assets a JOIN family_gallery_drafts d ON d.draft_id=NEW.draft_id
  WHERE a.asset_id=NEW.asset_id AND a.owner_identity_hash=d.owner_hash AND a.site_mode='family');
 SELECT RAISE(ABORT,'Foreign attempt') WHERE NEW.attempt_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM private_gallery_attempts WHERE attempt_id=NEW.attempt_id AND asset_id=NEW.asset_id AND idempotency_key=NEW.attempt_key);
END;
CREATE TRIGGER family_gallery_draft_photo_delete BEFORE DELETE ON family_gallery_draft_photos BEGIN
 SELECT RAISE(ABORT,'Reserved photo must retain its draft evidence') WHERE
  (OLD.reservation_json IS NOT NULL OR (SELECT state FROM family_gallery_drafts WHERE draft_id=OLD.draft_id)!='editing')
  AND NOT EXISTS(SELECT 1 FROM private_archive_purge_operations WHERE asset_id=OLD.asset_id);
END;
CREATE TRIGGER family_gallery_draft_identity BEFORE UPDATE ON family_gallery_drafts BEGIN
 SELECT RAISE(ABORT,'Draft identity immutable') WHERE NEW.draft_id!=OLD.draft_id OR NEW.owner_hash!=OLD.owner_hash OR NEW.created_at!=OLD.created_at;
 SELECT RAISE(ABORT,'Submission cannot be reset') WHERE OLD.state!='editing' AND NEW.state='editing';
 SELECT RAISE(ABORT,'Submission key immutable') WHERE OLD.submission_key IS NOT NULL AND NEW.submission_key IS NOT OLD.submission_key;
 SELECT RAISE(ABORT,'Review job immutable') WHERE OLD.job_id IS NOT NULL AND NEW.job_id IS NOT OLD.job_id
  AND NOT EXISTS(SELECT 1 FROM private_gallery_batch_purge_operations p JOIN json_each(p.batch_job_ids_json) j WHERE j.value=OLD.job_id);
END;

-- A dispatch may have succeeded even if its acknowledgement was lost. Keep its
-- admission permanently; no automatic retry, cancellation or replacement run.
CREATE TABLE family_gallery_dispatches (
 job_id TEXT PRIMARY KEY REFERENCES private_gallery_batch_jobs(job_id) ON DELETE CASCADE,
 state TEXT NOT NULL CHECK(state IN('admitted','acknowledged','unknown')),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER family_gallery_dispatch_guard BEFORE INSERT ON family_gallery_dispatches BEGIN
 SELECT RAISE(ABORT,'One dispatch admission only') WHERE NEW.state!='admitted' OR EXISTS(
  SELECT 1 FROM family_gallery_dispatches WHERE job_id=NEW.job_id);
 SELECT RAISE(ABORT,'Current independent permissions required for dispatch') WHERE NOT EXISTS(
  SELECT 1 FROM private_gallery_batch_jobs b WHERE b.job_id=NEW.job_id AND NOT EXISTS(
   SELECT 1 FROM json_each(b.attempts_json) j LEFT JOIN private_gallery_current_attempt_permissions p ON p.attempt_id=j.value
   WHERE p.attempt_id IS NULL OR EXISTS(SELECT 1 FROM private_gallery_pipeline_closures c WHERE c.attempt_id=j.value)));
END;
CREATE TRIGGER family_gallery_dispatch_update BEFORE UPDATE ON family_gallery_dispatches BEGIN
 SELECT RAISE(ABORT,'Dispatch admission immutable') WHERE NEW.job_id!=OLD.job_id OR OLD.state!='admitted'
  OR NEW.state NOT IN('acknowledged','unknown') OR NEW.created_at!=OLD.created_at;
END;
CREATE TRIGGER family_gallery_dispatch_delete BEFORE DELETE ON family_gallery_dispatches BEGIN
 SELECT RAISE(ABORT,'Only coordinated retirement may remove dispatch metadata') WHERE NOT EXISTS(
  SELECT 1 FROM private_gallery_batch_purge_operations p JOIN json_each(p.batch_job_ids_json) j WHERE j.value=OLD.job_id);
END;
