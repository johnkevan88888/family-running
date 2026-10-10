-- Independent archive-source processing. No legacy draft/original ownership.
-- Operational receipts remain protected until separately designed metadata purge.
-- Every mutable permission is rechecked at each durable byte/review boundary.
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
 AND NOT EXISTS (SELECT 1 FROM private_archive_deletion_requests d WHERE d.asset_id=a.asset_id)
 AND NOT EXISTS (SELECT 1 FROM json_each(a.person_ids_json) j
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
 AND NOT EXISTS (SELECT 1 FROM json_each(a.public_athlete_ids_json) j JOIN pending_athlete_exclusions e ON e.athlete_id=j.value WHERE e.resolved_at IS NULL);

CREATE TABLE private_gallery_pipeline_admissions (
 attempt_id TEXT PRIMARY KEY REFERENCES private_gallery_attempts(attempt_id),
 epoch_id_hash TEXT NOT NULL REFERENCES gallery_media_delivery_epochs(epoch_id_hash),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE private_gallery_pipeline_closures (
 attempt_id TEXT PRIMARY KEY REFERENCES private_gallery_attempts(attempt_id),
 reason TEXT NOT NULL CHECK(reason IN ('visibility','tags','roster','exclusion','archive-deletion','failed','cancelled')),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE private_gallery_pipeline_outputs (
 attempt_id TEXT NOT NULL REFERENCES private_gallery_pipeline_admissions(attempt_id),
 tier TEXT NOT NULL CHECK(tier IN ('staging','approved')),
 role TEXT NOT NULL CHECK(role IN ('photo-display','photo-thumbnail')),
 object_key TEXT UNIQUE NOT NULL,
 sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
 byte_count INTEGER NOT NULL CHECK(byte_count BETWEEN 1 AND 26214400 AND (role!='photo-thumbnail' OR byte_count<=5242880)),
 width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 1600),
 height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 1600 AND (role!='photo-thumbnail' OR max(width,height)<=480)),
 scan_json TEXT NOT NULL CHECK(json_valid(scan_json)),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(attempt_id,tier,role)
);
CREATE TABLE private_gallery_pipeline_writers (
 attempt_id TEXT NOT NULL,tier TEXT NOT NULL,role TEXT NOT NULL,
 upload_id TEXT NOT NULL CHECK(length(upload_id) BETWEEN 1 AND 512),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(attempt_id,tier,role),
 FOREIGN KEY(attempt_id,tier,role) REFERENCES private_gallery_pipeline_outputs(attempt_id,tier,role)
);
CREATE TABLE private_gallery_pipeline_byte_receipts (
 attempt_id TEXT NOT NULL,tier TEXT NOT NULL,role TEXT NOT NULL,
 provider_version TEXT NOT NULL CHECK(length(provider_version) BETWEEN 1 AND 256),
 provider_etag TEXT NOT NULL CHECK(length(provider_etag) BETWEEN 1 AND 256),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(attempt_id,tier,role),
 FOREIGN KEY(attempt_id,tier,role) REFERENCES private_gallery_pipeline_writers(attempt_id,tier,role)
);
CREATE TABLE private_gallery_pipeline_review_intents (
 attempt_id TEXT PRIMARY KEY REFERENCES private_gallery_pipeline_admissions(attempt_id),
 base_sha TEXT NOT NULL CHECK(length(base_sha)=40 AND base_sha NOT GLOB '*[^0-9a-f]*'),
 candidate_json TEXT NOT NULL CHECK(json_valid(candidate_json)),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- A writer's completion is recorded even if visibility changed during GitHub
-- I/O. It is evidence needed to close the exact PR, never current eligibility.
CREATE TABLE private_gallery_pipeline_reviews (
 attempt_id TEXT PRIMARY KEY REFERENCES private_gallery_pipeline_review_intents(attempt_id),
 review_json TEXT NOT NULL CHECK(json_valid(review_json)),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE private_gallery_pipeline_review_closures (
 attempt_id TEXT PRIMARY KEY REFERENCES private_gallery_pipeline_reviews(attempt_id),
 evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE private_gallery_pipeline_object_removals (
 attempt_id TEXT NOT NULL,tier TEXT NOT NULL,role TEXT NOT NULL,
 writer_proof TEXT NOT NULL CHECK(writer_proof IN ('no-writer','aborted','no-such-upload')),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(attempt_id,tier,role),
 FOREIGN KEY(attempt_id,tier,role) REFERENCES private_gallery_pipeline_outputs(attempt_id,tier,role)
);
-- Immutable output keys survive cleanup; a closed generation cannot reopen.
CREATE TABLE private_gallery_pipeline_host_receipts (
 attempt_id TEXT NOT NULL REFERENCES private_gallery_pipeline_closures(attempt_id),
 epoch_id_hash TEXT NOT NULL REFERENCES gallery_media_delivery_epochs(epoch_id_hash),
 evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(attempt_id,epoch_id_hash)
);
CREATE TABLE private_gallery_pipeline_manifest_receipts (
 attempt_id TEXT NOT NULL REFERENCES private_gallery_pipeline_closures(attempt_id),
 main_sha TEXT NOT NULL CHECK(length(main_sha)=40 AND main_sha NOT GLOB '*[^0-9a-f]*'),
 manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256)=64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(attempt_id,main_sha)
);
CREATE VIEW private_gallery_pipeline_current_removal AS
SELECT c.attempt_id FROM private_gallery_pipeline_closures c
JOIN gallery_media_delivery_current_epoch e ON e.singleton_id=1
JOIN private_gallery_pipeline_host_receipts h ON h.attempt_id=c.attempt_id AND h.epoch_id_hash=e.epoch_id_hash
WHERE EXISTS(SELECT 1 FROM private_gallery_pipeline_manifest_receipts m WHERE m.attempt_id=c.attempt_id)
 AND NOT EXISTS(SELECT 1 FROM private_gallery_pipeline_outputs o WHERE o.attempt_id=c.attempt_id
   AND NOT EXISTS(SELECT 1 FROM private_gallery_pipeline_object_removals r
      WHERE r.attempt_id=o.attempt_id AND r.tier=o.tier AND r.role=o.role))
 AND (NOT EXISTS(SELECT 1 FROM private_gallery_pipeline_review_intents i WHERE i.attempt_id=c.attempt_id)
   OR EXISTS(SELECT 1 FROM private_gallery_pipeline_review_closures r WHERE r.attempt_id=c.attempt_id));

CREATE TRIGGER private_gallery_pipeline_admission_guard BEFORE INSERT ON private_gallery_pipeline_admissions BEGIN
 SELECT RAISE(ABORT,'Attempt no longer eligible') WHERE NOT EXISTS(SELECT 1 FROM private_gallery_current_attempt_permissions WHERE attempt_id=NEW.attempt_id);
 SELECT RAISE(ABORT,'Attempt closed') WHERE EXISTS(SELECT 1 FROM private_gallery_pipeline_closures WHERE attempt_id=NEW.attempt_id);
 SELECT RAISE(ABORT,'Current delivery epoch required') WHERE NOT EXISTS(SELECT 1 FROM gallery_media_delivery_current_epoch WHERE singleton_id=1 AND epoch_id_hash=NEW.epoch_id_hash);
 SELECT RAISE(ABORT,'Prior photo removal incomplete') WHERE EXISTS(
  SELECT 1 FROM private_gallery_pipeline_admissions p JOIN private_gallery_attempts old ON old.attempt_id=p.attempt_id
  JOIN private_gallery_attempts fresh ON fresh.attempt_id=NEW.attempt_id
  WHERE old.asset_id=fresh.asset_id AND NOT EXISTS(SELECT 1 FROM private_gallery_pipeline_current_removal r WHERE r.attempt_id=old.attempt_id));
END;
CREATE TRIGGER private_gallery_pipeline_output_guard BEFORE INSERT ON private_gallery_pipeline_outputs BEGIN
 SELECT RAISE(ABORT,'Attempt no longer eligible') WHERE NOT EXISTS(SELECT 1 FROM private_gallery_current_attempt_permissions WHERE attempt_id=NEW.attempt_id);
 SELECT RAISE(ABORT,'Attempt closed') WHERE EXISTS(SELECT 1 FROM private_gallery_pipeline_closures WHERE attempt_id=NEW.attempt_id);
 SELECT RAISE(ABORT,'Delivery epoch changed') WHERE NOT EXISTS(SELECT 1 FROM private_gallery_pipeline_admissions p JOIN gallery_media_delivery_current_epoch e ON e.epoch_id_hash=p.epoch_id_hash WHERE p.attempt_id=NEW.attempt_id);
 SELECT RAISE(ABORT,'Exact generation key required') WHERE NEW.object_key IS NOT(
  SELECT iif(NEW.tier='approved','media/v2/','derivative-staging/v2/'||a.site_mode||'/')
    ||a.generation_id||'/'||NEW.sha256||'/'||iif(NEW.role='photo-display','display.webp','thumbnail.webp')
  FROM private_gallery_attempts a WHERE a.attempt_id=NEW.attempt_id);
 SELECT RAISE(ABORT,'Verified staging counterpart required') WHERE NEW.tier='approved' AND NOT EXISTS(
  SELECT 1 FROM private_gallery_pipeline_outputs s JOIN private_gallery_pipeline_byte_receipts b USING(attempt_id,tier,role)
  WHERE s.attempt_id=NEW.attempt_id AND s.tier='staging' AND s.role=NEW.role AND s.sha256=NEW.sha256
    AND s.byte_count=NEW.byte_count AND s.width=NEW.width AND s.height=NEW.height AND s.scan_json=NEW.scan_json);
END;
CREATE TRIGGER private_gallery_pipeline_writer_guard BEFORE INSERT ON private_gallery_pipeline_writers BEGIN
 SELECT RAISE(ABORT,'Delivery epoch changed') WHERE NOT EXISTS(SELECT 1 FROM private_gallery_pipeline_admissions p JOIN gallery_media_delivery_current_epoch e ON e.epoch_id_hash=p.epoch_id_hash WHERE p.attempt_id=NEW.attempt_id);
 SELECT RAISE(ABORT,'Attempt no longer eligible') WHERE NOT EXISTS(SELECT 1 FROM private_gallery_current_attempt_permissions WHERE attempt_id=NEW.attempt_id);
 SELECT RAISE(ABORT,'Attempt closed') WHERE EXISTS(SELECT 1 FROM private_gallery_pipeline_closures WHERE attempt_id=NEW.attempt_id);
END;
CREATE TRIGGER private_gallery_pipeline_byte_guard BEFORE INSERT ON private_gallery_pipeline_byte_receipts BEGIN
 SELECT RAISE(ABORT,'Delivery epoch changed') WHERE NOT EXISTS(SELECT 1 FROM private_gallery_pipeline_admissions p JOIN gallery_media_delivery_current_epoch e ON e.epoch_id_hash=p.epoch_id_hash WHERE p.attempt_id=NEW.attempt_id);
 SELECT RAISE(ABORT,'Attempt no longer eligible') WHERE NOT EXISTS(SELECT 1 FROM private_gallery_current_attempt_permissions WHERE attempt_id=NEW.attempt_id);
 SELECT RAISE(ABORT,'Attempt closed') WHERE EXISTS(SELECT 1 FROM private_gallery_pipeline_closures WHERE attempt_id=NEW.attempt_id);
END;
CREATE TRIGGER private_gallery_pipeline_review_guard BEFORE INSERT ON private_gallery_pipeline_review_intents BEGIN
 SELECT RAISE(ABORT,'Delivery epoch changed') WHERE NOT EXISTS(SELECT 1 FROM private_gallery_pipeline_admissions p JOIN gallery_media_delivery_current_epoch e ON e.epoch_id_hash=p.epoch_id_hash WHERE p.attempt_id=NEW.attempt_id);
 SELECT RAISE(ABORT,'Attempt no longer eligible') WHERE NOT EXISTS(SELECT 1 FROM private_gallery_current_attempt_permissions WHERE attempt_id=NEW.attempt_id);
 SELECT RAISE(ABORT,'Attempt closed') WHERE EXISTS(SELECT 1 FROM private_gallery_pipeline_closures WHERE attempt_id=NEW.attempt_id);
 SELECT RAISE(ABORT,'Complete verified pair required') WHERE (SELECT count(*) FROM private_gallery_pipeline_byte_receipts WHERE attempt_id=NEW.attempt_id AND tier='approved')!=2;
END;
CREATE TRIGGER private_gallery_pipeline_removal_guard BEFORE INSERT ON private_gallery_pipeline_object_removals BEGIN
 SELECT RAISE(ABORT,'Closure required') WHERE NOT EXISTS(SELECT 1 FROM private_gallery_pipeline_closures WHERE attempt_id=NEW.attempt_id);
 SELECT RAISE(ABORT,'Exact writer closure required') WHERE (NEW.writer_proof='no-writer') != NOT EXISTS(
  SELECT 1 FROM private_gallery_pipeline_writers WHERE attempt_id=NEW.attempt_id AND tier=NEW.tier AND role=NEW.role);
END;
CREATE TRIGGER private_gallery_pipeline_host_guard BEFORE INSERT ON private_gallery_pipeline_host_receipts BEGIN
 SELECT RAISE(ABORT,'Current epoch required') WHERE NOT EXISTS(SELECT 1 FROM gallery_media_delivery_current_epoch WHERE epoch_id_hash=NEW.epoch_id_hash);
 SELECT RAISE(ABORT,'Storage removal incomplete') WHERE EXISTS(SELECT 1 FROM private_gallery_pipeline_outputs o WHERE o.attempt_id=NEW.attempt_id
  AND NOT EXISTS(SELECT 1 FROM private_gallery_pipeline_object_removals r WHERE r.attempt_id=o.attempt_id AND r.tier=o.tier AND r.role=o.role));
 SELECT RAISE(ABORT,'Complete historical target proof required') WHERE json_type(NEW.evidence_json,'$.keys') IS NOT 'array'
  OR json_extract(NEW.evidence_json,'$.keys') IS NOT(SELECT json_group_array(object_key) FROM
    (SELECT object_key FROM private_gallery_pipeline_outputs WHERE attempt_id=NEW.attempt_id AND tier='approved' ORDER BY role))
  OR json_type(NEW.evidence_json,'$.targets') IS NOT 'array'
  OR json_array_length(NEW.evidence_json,'$.targets')!=(SELECT count(*) FROM private_gallery_pipeline_outputs WHERE attempt_id=NEW.attempt_id AND tier='approved');
 SELECT RAISE(ABORT,'Two witness passes required') WHERE EXISTS(
  SELECT 1 FROM json_each('["before","after"]') p JOIN gallery_media_delivery_epochs e ON e.epoch_id_hash=NEW.epoch_id_hash
  WHERE json_extract(NEW.evidence_json,'$.witness.'||p.value||'.head.status') IS NOT 200
   OR json_extract(NEW.evidence_json,'$.witness.'||p.value||'.get.status') IS NOT 200
   OR json_extract(NEW.evidence_json,'$.witness.'||p.value||'.head.cacheControl') IS NOT 'no-store'
   OR json_extract(NEW.evidence_json,'$.witness.'||p.value||'.get.cacheControl') IS NOT 'no-store'
   OR json_extract(NEW.evidence_json,'$.witness.'||p.value||'.get.bodyHash') IS NOT e.witness_sha256);
 SELECT RAISE(ABORT,'Every historical target needs three absence observations') WHERE EXISTS(
  SELECT 1 FROM json_each(NEW.evidence_json,'$.targets') t JOIN json_each('["head","get","finalHead"]') m
  WHERE json_extract(t.value,'$[1].'||m.value||'.status') IS NOT 404
   OR json_extract(t.value,'$[1].'||m.value||'.cacheControl') IS NOT 'no-store');
END;
CREATE TRIGGER private_gallery_pipeline_review_close_guard BEFORE INSERT ON private_gallery_pipeline_review_closures BEGIN
 SELECT RAISE(ABORT,'Privacy closure required') WHERE NOT EXISTS(SELECT 1 FROM private_gallery_pipeline_closures WHERE attempt_id=NEW.attempt_id);
END;
CREATE TRIGGER private_gallery_pipeline_archive_completion BEFORE INSERT ON private_archive_deletion_receipts BEGIN
 SELECT RAISE(ABORT,'Archive public removal still pending') WHERE EXISTS(
  SELECT 1 FROM private_gallery_pipeline_admissions p JOIN private_gallery_attempts a ON a.attempt_id=p.attempt_id
  WHERE a.asset_id=NEW.asset_id AND NOT EXISTS(SELECT 1 FROM private_gallery_pipeline_current_removal r WHERE r.attempt_id=a.attempt_id));
END;
-- Block first in the same preference/tag/consent transaction. Allow never
-- reopens a closed attempt, even in an ABA cycle; restoration needs fresh consent.
CREATE TRIGGER private_gallery_pipeline_visibility_close AFTER INSERT ON private_gallery_visibility_events BEGIN
 INSERT INTO private_gallery_pipeline_closures(attempt_id,reason)
 SELECT a.attempt_id,'visibility' FROM private_gallery_attempts a JOIN json_each(a.person_ids_json) j ON j.value=NEW.person_id
 WHERE NOT EXISTS(SELECT 1 FROM private_gallery_pipeline_closures c WHERE c.attempt_id=a.attempt_id);
END;
CREATE TRIGGER private_gallery_pipeline_tags_close AFTER INSERT ON private_gallery_tag_revisions BEGIN
 INSERT INTO private_gallery_pipeline_closures(attempt_id,reason)
 SELECT a.attempt_id,'tags' FROM private_gallery_attempts a WHERE a.asset_id=NEW.asset_id
 AND NOT EXISTS(SELECT 1 FROM private_gallery_pipeline_closures c WHERE c.attempt_id=a.attempt_id);
END;
CREATE TRIGGER private_gallery_pipeline_archive_close AFTER INSERT ON private_archive_deletion_requests BEGIN
 INSERT INTO private_gallery_pipeline_closures(attempt_id,reason)
 SELECT a.attempt_id,'archive-deletion' FROM private_gallery_attempts a WHERE a.asset_id=NEW.asset_id
 AND NOT EXISTS(SELECT 1 FROM private_gallery_pipeline_closures c WHERE c.attempt_id=a.attempt_id);
END;
CREATE TRIGGER private_gallery_pipeline_roster_close AFTER UPDATE ON private_gallery_roster_version BEGIN
 INSERT INTO private_gallery_pipeline_closures(attempt_id,reason)
 SELECT a.attempt_id,'roster' FROM private_gallery_attempts a WHERE a.roster_generation!=NEW.generation
 AND NOT EXISTS(SELECT 1 FROM private_gallery_pipeline_closures c WHERE c.attempt_id=a.attempt_id);
END;
CREATE TRIGGER private_gallery_pipeline_exclusion_close AFTER INSERT ON pending_athlete_exclusions WHEN NEW.resolved_at IS NULL BEGIN
 INSERT INTO private_gallery_pipeline_closures(attempt_id,reason)
 SELECT a.attempt_id,'exclusion' FROM private_gallery_attempts a JOIN json_each(a.public_athlete_ids_json) j ON j.value=NEW.athlete_id
 WHERE NOT EXISTS(SELECT 1 FROM private_gallery_pipeline_closures c WHERE c.attempt_id=a.attempt_id);
END;
CREATE TRIGGER private_gallery_pipeline_admissions_no_replace BEFORE INSERT ON private_gallery_pipeline_admissions BEGIN
 SELECT RAISE(ABORT,'Lifecycle evidence cannot be replaced') WHERE EXISTS(SELECT 1 FROM private_gallery_pipeline_admissions WHERE attempt_id=NEW.attempt_id);
 SELECT RAISE(ABORT,'Lifecycle clock is server owned') WHERE NEW.created_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER private_gallery_pipeline_admissions_no_update BEFORE UPDATE ON private_gallery_pipeline_admissions
BEGIN SELECT RAISE(ABORT,'Lifecycle evidence immutable'); END;
CREATE TRIGGER private_gallery_pipeline_admissions_no_delete BEFORE DELETE ON private_gallery_pipeline_admissions
BEGIN SELECT RAISE(ABORT,'Lifecycle purge not enabled'); END;
CREATE TRIGGER private_gallery_pipeline_closures_no_replace BEFORE INSERT ON private_gallery_pipeline_closures BEGIN
 SELECT RAISE(ABORT,'Lifecycle evidence cannot be replaced') WHERE EXISTS(SELECT 1 FROM private_gallery_pipeline_closures WHERE attempt_id=NEW.attempt_id);
 SELECT RAISE(ABORT,'Lifecycle clock is server owned') WHERE NEW.created_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER private_gallery_pipeline_closures_no_update BEFORE UPDATE ON private_gallery_pipeline_closures
BEGIN SELECT RAISE(ABORT,'Lifecycle evidence immutable'); END;
CREATE TRIGGER private_gallery_pipeline_closures_no_delete BEFORE DELETE ON private_gallery_pipeline_closures
BEGIN SELECT RAISE(ABORT,'Lifecycle purge not enabled'); END;
CREATE TRIGGER private_gallery_pipeline_outputs_no_replace BEFORE INSERT ON private_gallery_pipeline_outputs BEGIN
 SELECT RAISE(ABORT,'Lifecycle evidence cannot be replaced') WHERE EXISTS(SELECT 1 FROM private_gallery_pipeline_outputs WHERE attempt_id=NEW.attempt_id AND tier=NEW.tier AND role=NEW.role);
 SELECT RAISE(ABORT,'Lifecycle clock is server owned') WHERE NEW.created_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER private_gallery_pipeline_outputs_no_update BEFORE UPDATE ON private_gallery_pipeline_outputs
BEGIN SELECT RAISE(ABORT,'Lifecycle evidence immutable'); END;
CREATE TRIGGER private_gallery_pipeline_outputs_no_delete BEFORE DELETE ON private_gallery_pipeline_outputs
BEGIN SELECT RAISE(ABORT,'Lifecycle purge not enabled'); END;
CREATE TRIGGER private_gallery_pipeline_writers_no_replace BEFORE INSERT ON private_gallery_pipeline_writers BEGIN
 SELECT RAISE(ABORT,'Lifecycle evidence cannot be replaced') WHERE EXISTS(SELECT 1 FROM private_gallery_pipeline_writers WHERE attempt_id=NEW.attempt_id AND tier=NEW.tier AND role=NEW.role);
 SELECT RAISE(ABORT,'Lifecycle clock is server owned') WHERE NEW.created_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER private_gallery_pipeline_writers_no_update BEFORE UPDATE ON private_gallery_pipeline_writers
BEGIN SELECT RAISE(ABORT,'Lifecycle evidence immutable'); END;
CREATE TRIGGER private_gallery_pipeline_writers_no_delete BEFORE DELETE ON private_gallery_pipeline_writers
BEGIN SELECT RAISE(ABORT,'Lifecycle purge not enabled'); END;
CREATE TRIGGER private_gallery_pipeline_byte_receipts_no_replace BEFORE INSERT ON private_gallery_pipeline_byte_receipts BEGIN
 SELECT RAISE(ABORT,'Lifecycle evidence cannot be replaced') WHERE EXISTS(SELECT 1 FROM private_gallery_pipeline_byte_receipts WHERE attempt_id=NEW.attempt_id AND tier=NEW.tier AND role=NEW.role);
 SELECT RAISE(ABORT,'Lifecycle clock is server owned') WHERE NEW.created_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER private_gallery_pipeline_byte_receipts_no_update BEFORE UPDATE ON private_gallery_pipeline_byte_receipts
BEGIN SELECT RAISE(ABORT,'Lifecycle evidence immutable'); END;
CREATE TRIGGER private_gallery_pipeline_byte_receipts_no_delete BEFORE DELETE ON private_gallery_pipeline_byte_receipts
BEGIN SELECT RAISE(ABORT,'Lifecycle purge not enabled'); END;
CREATE TRIGGER private_gallery_pipeline_review_intents_no_replace BEFORE INSERT ON private_gallery_pipeline_review_intents BEGIN
 SELECT RAISE(ABORT,'Lifecycle evidence cannot be replaced') WHERE EXISTS(SELECT 1 FROM private_gallery_pipeline_review_intents WHERE attempt_id=NEW.attempt_id);
 SELECT RAISE(ABORT,'Lifecycle clock is server owned') WHERE NEW.created_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER private_gallery_pipeline_review_intents_no_update BEFORE UPDATE ON private_gallery_pipeline_review_intents
BEGIN SELECT RAISE(ABORT,'Lifecycle evidence immutable'); END;
CREATE TRIGGER private_gallery_pipeline_review_intents_no_delete BEFORE DELETE ON private_gallery_pipeline_review_intents
BEGIN SELECT RAISE(ABORT,'Lifecycle purge not enabled'); END;
CREATE TRIGGER private_gallery_pipeline_reviews_no_replace BEFORE INSERT ON private_gallery_pipeline_reviews BEGIN
 SELECT RAISE(ABORT,'Lifecycle evidence cannot be replaced') WHERE EXISTS(SELECT 1 FROM private_gallery_pipeline_reviews WHERE attempt_id=NEW.attempt_id);
 SELECT RAISE(ABORT,'Lifecycle clock is server owned') WHERE NEW.created_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER private_gallery_pipeline_reviews_no_update BEFORE UPDATE ON private_gallery_pipeline_reviews
BEGIN SELECT RAISE(ABORT,'Lifecycle evidence immutable'); END;
CREATE TRIGGER private_gallery_pipeline_reviews_no_delete BEFORE DELETE ON private_gallery_pipeline_reviews
BEGIN SELECT RAISE(ABORT,'Lifecycle purge not enabled'); END;
CREATE TRIGGER private_gallery_pipeline_review_closures_no_replace BEFORE INSERT ON private_gallery_pipeline_review_closures BEGIN
 SELECT RAISE(ABORT,'Lifecycle evidence cannot be replaced') WHERE EXISTS(SELECT 1 FROM private_gallery_pipeline_review_closures WHERE attempt_id=NEW.attempt_id);
 SELECT RAISE(ABORT,'Lifecycle clock is server owned') WHERE NEW.created_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER private_gallery_pipeline_review_closures_no_update BEFORE UPDATE ON private_gallery_pipeline_review_closures
BEGIN SELECT RAISE(ABORT,'Lifecycle evidence immutable'); END;
CREATE TRIGGER private_gallery_pipeline_review_closures_no_delete BEFORE DELETE ON private_gallery_pipeline_review_closures
BEGIN SELECT RAISE(ABORT,'Lifecycle purge not enabled'); END;
CREATE TRIGGER private_gallery_pipeline_object_removals_no_replace BEFORE INSERT ON private_gallery_pipeline_object_removals BEGIN
 SELECT RAISE(ABORT,'Lifecycle evidence cannot be replaced') WHERE EXISTS(SELECT 1 FROM private_gallery_pipeline_object_removals WHERE attempt_id=NEW.attempt_id AND tier=NEW.tier AND role=NEW.role);
 SELECT RAISE(ABORT,'Lifecycle clock is server owned') WHERE NEW.created_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER private_gallery_pipeline_object_removals_no_update BEFORE UPDATE ON private_gallery_pipeline_object_removals
BEGIN SELECT RAISE(ABORT,'Lifecycle evidence immutable'); END;
CREATE TRIGGER private_gallery_pipeline_object_removals_no_delete BEFORE DELETE ON private_gallery_pipeline_object_removals
BEGIN SELECT RAISE(ABORT,'Lifecycle purge not enabled'); END;
CREATE TRIGGER private_gallery_pipeline_host_receipts_no_replace BEFORE INSERT ON private_gallery_pipeline_host_receipts BEGIN
 SELECT RAISE(ABORT,'Lifecycle evidence cannot be replaced') WHERE EXISTS(SELECT 1 FROM private_gallery_pipeline_host_receipts WHERE attempt_id=NEW.attempt_id AND epoch_id_hash=NEW.epoch_id_hash);
 SELECT RAISE(ABORT,'Lifecycle clock is server owned') WHERE NEW.created_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER private_gallery_pipeline_host_receipts_no_update BEFORE UPDATE ON private_gallery_pipeline_host_receipts
BEGIN SELECT RAISE(ABORT,'Lifecycle evidence immutable'); END;
CREATE TRIGGER private_gallery_pipeline_host_receipts_no_delete BEFORE DELETE ON private_gallery_pipeline_host_receipts
BEGIN SELECT RAISE(ABORT,'Lifecycle purge not enabled'); END;
CREATE TRIGGER private_gallery_pipeline_manifest_receipts_no_replace BEFORE INSERT ON private_gallery_pipeline_manifest_receipts BEGIN
 SELECT RAISE(ABORT,'Lifecycle evidence cannot be replaced') WHERE EXISTS(SELECT 1 FROM private_gallery_pipeline_manifest_receipts WHERE attempt_id=NEW.attempt_id AND main_sha=NEW.main_sha);
 SELECT RAISE(ABORT,'Lifecycle clock is server owned') WHERE NEW.created_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER private_gallery_pipeline_manifest_receipts_no_update BEFORE UPDATE ON private_gallery_pipeline_manifest_receipts
BEGIN SELECT RAISE(ABORT,'Lifecycle evidence immutable'); END;
CREATE TRIGGER private_gallery_pipeline_manifest_receipts_no_delete BEFORE DELETE ON private_gallery_pipeline_manifest_receipts
BEGIN SELECT RAISE(ABORT,'Lifecycle purge not enabled'); END;
