-- Owner-confirmed presentation only. Existing consent/attempt/review evidence is
-- not backfilled or rewritten; private tags and detector information stay private.
ALTER TABLE private_gallery_attempts ADD COLUMN framing_version INTEGER
 CHECK(framing_version IS NULL OR (typeof(framing_version)='integer' AND framing_version BETWEEN 0 AND 9007199254740991));
CREATE TABLE private_gallery_frame_revisions (
 asset_id TEXT NOT NULL REFERENCES private_gallery_assets(asset_id) ON DELETE CASCADE,
 version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991),
 owner_hash TEXT NOT NULL, site_mode TEXT NOT NULL CHECK(site_mode IN('family','everyone')),
 idempotency_key TEXT UNIQUE NOT NULL, request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
 tag_version INTEGER NOT NULL CHECK(typeof(tag_version)='integer' AND tag_version>=1),
 person_ids_json TEXT NOT NULL CHECK(json_valid(person_ids_json)),
 source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
 orientation TEXT NOT NULL CHECK(orientation='exif-transposed-v1'),
 image_width INTEGER NOT NULL CHECK(typeof(image_width)='integer' AND image_width BETWEEN 1 AND 100000),
 image_height INTEGER NOT NULL CHECK(typeof(image_height)='integer' AND image_height BETWEEN 1 AND 100000),
 frames_json TEXT NOT NULL CHECK(json_valid(frames_json)), confirmed INTEGER NOT NULL CHECK(confirmed=1),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(asset_id,version), CHECK(image_width*image_height<=50000000)
);
CREATE TRIGGER private_gallery_frame_admission BEFORE INSERT ON private_gallery_frame_revisions BEGIN
 SELECT RAISE(ABORT,'Framing revision cannot be replaced') WHERE EXISTS(SELECT 1 FROM private_gallery_frame_revisions
  WHERE (asset_id=NEW.asset_id AND version=NEW.version) OR idempotency_key=NEW.idempotency_key);
 SELECT RAISE(ABORT,'Framing owner area or revision changed') WHERE NOT EXISTS(SELECT 1 FROM private_gallery_assets a
  WHERE a.asset_id=NEW.asset_id AND a.owner_identity_hash=NEW.owner_hash AND a.site_mode=NEW.site_mode)
  OR NEW.version!=(SELECT coalesce(max(version),0)+1 FROM private_gallery_frame_revisions WHERE asset_id=NEW.asset_id);
 SELECT RAISE(ABORT,'Framing tags changed') WHERE NOT EXISTS(SELECT 1 FROM private_gallery_current_tag_sets
  WHERE asset_id=NEW.asset_id AND tag_version=NEW.tag_version AND current_person_ids_json=NEW.person_ids_json)
  OR json_type(NEW.person_ids_json) IS NOT 'array' OR json_array_length(NEW.person_ids_json) NOT BETWEEN 1 AND 100
  OR EXISTS(SELECT 1 FROM json_each(NEW.person_ids_json) j LEFT JOIN private_gallery_current_asset_tags t
   ON t.asset_id=NEW.asset_id AND t.ordinal=j.key AND t.person_id=j.value WHERE t.person_id IS NULL)
  OR (SELECT count(*) FROM private_gallery_current_asset_tags WHERE asset_id=NEW.asset_id)!=json_array_length(NEW.person_ids_json);
 SELECT RAISE(ABORT,'Framing source unavailable or deleted') WHERE NOT EXISTS(SELECT 1 FROM private_archive_original_receipts
  WHERE asset_id=NEW.asset_id AND sha256=NEW.source_sha256)
  OR EXISTS(SELECT 1 FROM private_archive_deletion_requests WHERE asset_id=NEW.asset_id);
 SELECT RAISE(ABORT,'Framing request or clock invalid') WHERE length(NEW.idempotency_key)!=36
  OR substr(NEW.idempotency_key,9,1)!='-' OR substr(NEW.idempotency_key,14,2)!='-4'
  OR substr(NEW.idempotency_key,19,1)!='-' OR substr(NEW.idempotency_key,20,1) NOT IN('8','9','a','b')
  OR substr(NEW.idempotency_key,24,1)!='-' OR length(replace(NEW.idempotency_key,'-',''))!=32
  OR replace(NEW.idempotency_key,'-','') GLOB '*[^0-9a-f]*'
  OR NEW.created_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER private_gallery_frame_numeric_guard BEFORE INSERT ON private_gallery_frame_revisions BEGIN
 SELECT RAISE(ABORT,'Numeric per-tag framing required') WHERE json_type(NEW.frames_json) IS NOT 'object'
  OR (SELECT count(*) FROM json_each(NEW.frames_json))>100
  OR (SELECT count(*) FROM json_each(NEW.frames_json))!=(SELECT count(DISTINCT key) FROM json_each(NEW.frames_json))
  OR EXISTS(SELECT 1 FROM json_each(NEW.frames_json) f WHERE
   NOT EXISTS(SELECT 1 FROM json_each(NEW.person_ids_json) WHERE value=f.key)
   OR f.type!='object' OR (SELECT count(*) FROM json_each(f.value))!=3
   OR (SELECT count(DISTINCT key) FROM json_each(f.value))!=3
   OR EXISTS(SELECT 1 FROM json_each(f.value) WHERE key NOT IN('x','y','zoom'))
   OR json_type(f.value,'$.x') NOT IN('integer','real') OR json_type(f.value,'$.y') NOT IN('integer','real')
   OR json_type(f.value,'$.zoom') NOT IN('integer','real')
   OR json_extract(f.value,'$.x') NOT BETWEEN 0 AND 100 OR json_extract(f.value,'$.y') NOT BETWEEN 0 AND 100
   OR json_extract(f.value,'$.zoom') NOT BETWEEN 1 AND 8);
END;
CREATE TRIGGER private_gallery_frame_no_update BEFORE UPDATE ON private_gallery_frame_revisions
 BEGIN SELECT RAISE(ABORT,'Framing evidence immutable'); END;
CREATE TRIGGER private_gallery_frame_no_delete BEFORE DELETE ON private_gallery_frame_revisions BEGIN
 SELECT RAISE(ABORT,'Exact atomic archive purge required') WHERE NOT EXISTS(
  SELECT 1 FROM private_archive_purge_operations WHERE asset_id=OLD.asset_id);
END;
CREATE TABLE private_gallery_attempt_framings (
 attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES private_gallery_attempts(attempt_id) ON DELETE CASCADE,
 asset_id TEXT NOT NULL REFERENCES private_gallery_assets(asset_id) ON DELETE CASCADE,
 version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version>=0), tag_version INTEGER NOT NULL,
 source_sha256 TEXT NOT NULL, original_provider_version TEXT NOT NULL, original_provider_etag TEXT NOT NULL,
 person_ids_json TEXT NOT NULL, public_athlete_ids_json TEXT NOT NULL, person_projection_json TEXT NOT NULL,
 private_frames_json TEXT NOT NULL, public_frames_json TEXT NOT NULL,
 orientation TEXT, image_width INTEGER, image_height INTEGER,
 CHECK(json_valid(person_projection_json) AND json_valid(private_frames_json) AND json_valid(public_frames_json))
);
CREATE TRIGGER private_gallery_attempt_framing_guard BEFORE INSERT ON private_gallery_attempts BEGIN
 SELECT RAISE(ABORT,'Exact current framing revision required') WHERE coalesce(NEW.framing_version,0) !=
  (SELECT coalesce(max(version),0) FROM private_gallery_frame_revisions WHERE asset_id=NEW.asset_id);
 SELECT RAISE(ABORT,'Framing source or tag revision changed') WHERE coalesce(NEW.framing_version,0)>0 AND NOT EXISTS(
  SELECT 1 FROM private_gallery_frame_revisions WHERE asset_id=NEW.asset_id AND version=NEW.framing_version
   AND tag_version=NEW.tag_version AND person_ids_json=NEW.person_ids_json AND source_sha256=NEW.original_sha256);
END;
CREATE TRIGGER private_gallery_attempt_framing_snapshot AFTER INSERT ON private_gallery_attempts BEGIN
 INSERT INTO private_gallery_attempt_framings(attempt_id,asset_id,version,tag_version,source_sha256,
  original_provider_version,original_provider_etag,person_ids_json,public_athlete_ids_json,person_projection_json,
  private_frames_json,public_frames_json,orientation,image_width,image_height)
 SELECT NEW.attempt_id,NEW.asset_id,coalesce(NEW.framing_version,0),NEW.tag_version,NEW.original_sha256,
  NEW.original_provider_version,NEW.original_provider_etag,NEW.person_ids_json,NEW.public_athlete_ids_json,
  (SELECT json_group_array(json_array(person_id,public_athlete_id)) FROM(
   SELECT p.person_id,p.public_athlete_id FROM json_each(NEW.person_ids_json) j
   JOIN private_gallery_people p ON p.person_id=j.value ORDER BY j.key)),
  coalesce(r.frames_json,'{}'),
  (SELECT json_group_object(public_athlete_id,json(value)) FROM(
   SELECT p.public_athlete_id,f.value FROM json_each(coalesce(r.frames_json,'{}')) f
   JOIN private_gallery_people p ON p.person_id=f.key JOIN json_each(NEW.person_ids_json) t ON t.value=p.person_id
   WHERE p.public_athlete_id IS NOT NULL ORDER BY t.key)),r.orientation,r.image_width,r.image_height
 FROM private_gallery_assets a LEFT JOIN private_gallery_frame_revisions r ON r.asset_id=a.asset_id
  AND r.version=NEW.framing_version WHERE a.asset_id=NEW.asset_id;
END;
CREATE TRIGGER private_gallery_attempt_framing_insert_guard BEFORE INSERT ON private_gallery_attempt_framings BEGIN
 SELECT RAISE(ABORT,'Framing snapshot cannot be replaced') WHERE EXISTS(
  SELECT 1 FROM private_gallery_attempt_framings WHERE attempt_id=NEW.attempt_id);
 SELECT RAISE(ABORT,'Exact immutable attempt required') WHERE NOT EXISTS(SELECT 1 FROM private_gallery_attempts a
  WHERE a.attempt_id=NEW.attempt_id AND a.asset_id=NEW.asset_id AND coalesce(a.framing_version,0)=NEW.version
   AND a.tag_version=NEW.tag_version AND a.original_sha256=NEW.source_sha256
   AND a.original_provider_version=NEW.original_provider_version AND a.original_provider_etag=NEW.original_provider_etag
   AND a.person_ids_json=NEW.person_ids_json AND a.public_athlete_ids_json=NEW.public_athlete_ids_json);
 SELECT RAISE(ABORT,'Framing snapshot source required') WHERE NEW.version>0 AND NOT EXISTS(
  SELECT 1 FROM private_gallery_frame_revisions r WHERE r.asset_id=NEW.asset_id AND r.version=NEW.version
   AND r.tag_version=NEW.tag_version AND r.source_sha256=NEW.source_sha256 AND r.person_ids_json=NEW.person_ids_json
   AND r.frames_json=NEW.private_frames_json AND r.orientation=NEW.orientation
   AND r.image_width=NEW.image_width AND r.image_height=NEW.image_height);
 SELECT RAISE(ABORT,'Framing snapshot projection changed') WHERE NEW.person_projection_json IS NOT (
  SELECT json_group_array(json_array(person_id,public_athlete_id)) FROM(
   SELECT p.person_id,p.public_athlete_id FROM json_each(NEW.person_ids_json) j
   JOIN private_gallery_people p ON p.person_id=j.value ORDER BY j.key))
  OR NEW.public_frames_json IS NOT (SELECT json_group_object(public_athlete_id,json(value)) FROM(
   SELECT p.public_athlete_id,f.value FROM json_each(NEW.private_frames_json) f
   JOIN private_gallery_people p ON p.person_id=f.key JOIN json_each(NEW.person_ids_json) t ON t.value=p.person_id
   WHERE p.public_athlete_id IS NOT NULL ORDER BY t.key));
 SELECT RAISE(ABORT,'Empty frame must stay empty') WHERE NEW.version=0 AND (
  NEW.private_frames_json!='{}' OR NEW.public_frames_json!='{}' OR NEW.orientation IS NOT NULL
  OR NEW.image_width IS NOT NULL OR NEW.image_height IS NOT NULL);
END;
CREATE TRIGGER private_gallery_attempt_framing_no_update BEFORE UPDATE ON private_gallery_attempt_framings
 BEGIN SELECT RAISE(ABORT,'Attempt framing immutable'); END;
CREATE TRIGGER private_gallery_attempt_framing_no_delete BEFORE DELETE ON private_gallery_attempt_framings BEGIN
 SELECT RAISE(ABORT,'Exact atomic archive purge required') WHERE NOT EXISTS(
  SELECT 1 FROM private_archive_purge_operations WHERE asset_id=OLD.asset_id);
END;
-- Keep the existing purge authorization/proof flow, adding the new private
-- metadata to its exact snapshot. Cascades run only inside its guarded atomic
-- attempt/asset deletion; no new purge route or deletion authority is added.
DROP VIEW private_archive_purge_snapshots;
CREATE VIEW private_archive_purge_snapshots AS
SELECT a.asset_id,json_object('asset',a.asset_id,'owner',a.owner_identity_hash,
 'site',a.site_mode,'reservation',a.idempotency_key,'reason',d.reason,
 'requestedAt',d.requested_at,'originalAbsentAt',r.verified_at,
 'attempts',json((SELECT json_group_array(json_array(attempt_id,generation_id,public_item_id))
  FROM(SELECT attempt_id,generation_id,public_item_id FROM private_gallery_attempts WHERE asset_id=a.asset_id ORDER BY attempt_id))),
 'outputs',json((SELECT json_group_array(json_array(attempt_id,tier,role,object_key))
  FROM(SELECT o.attempt_id,o.tier,o.role,o.object_key FROM private_gallery_pipeline_outputs o
   JOIN private_gallery_attempts p USING(attempt_id) WHERE p.asset_id=a.asset_id ORDER BY o.attempt_id,o.tier,o.role))),
 'framingRevisions',json((SELECT json_group_array(json_array(version,request_hash))
  FROM(SELECT version,request_hash FROM private_gallery_frame_revisions WHERE asset_id=a.asset_id ORDER BY version))),
 'attemptFramings',json((SELECT json_group_array(json_array(attempt_id,version))
  FROM(SELECT attempt_id,version FROM private_gallery_attempt_framings
   WHERE asset_id=a.asset_id ORDER BY attempt_id)))) AS snapshot_json
FROM private_gallery_assets a
JOIN private_archive_deletion_requests d ON d.asset_id=a.asset_id AND d.actor_identity_hash=a.owner_identity_hash
JOIN private_archive_deletion_receipts r ON r.asset_id=a.asset_id AND r.original_absent=1;
