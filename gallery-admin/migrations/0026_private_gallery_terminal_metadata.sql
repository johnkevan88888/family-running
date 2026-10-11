-- Local-only forward archive metadata purge. Legacy draft retention is untouched.
-- No Hide/Allow, expiry, or service role can manufacture terminal owner consent.
CREATE TABLE private_archive_purge_receipts (
 asset_id_hash TEXT PRIMARY KEY NOT NULL CHECK(length(asset_id_hash)=64 AND asset_id_hash NOT GLOB '*[^0-9a-f]*'),
 reservation_key_hash TEXT UNIQUE NOT NULL CHECK(length(reservation_key_hash)=64 AND reservation_key_hash NOT GLOB '*[^0-9a-f]*'),
 scope_hash TEXT UNIQUE NOT NULL CHECK(length(scope_hash)=64 AND scope_hash NOT GLOB '*[^0-9a-f]*'),
 proof_hash TEXT NOT NULL CHECK(length(proof_hash)=64 AND proof_hash NOT GLOB '*[^0-9a-f]*'),
 purged_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE private_gallery_retired_generations (
 generation_hash TEXT PRIMARY KEY NOT NULL CHECK(length(generation_hash)=64 AND generation_hash NOT GLOB '*[^0-9a-f]*'),
 item_hash TEXT UNIQUE NOT NULL CHECK(length(item_hash)=64 AND item_hash NOT GLOB '*[^0-9a-f]*')
);
CREATE TABLE private_gallery_retired_keys (
 key_hash TEXT PRIMARY KEY NOT NULL CHECK(length(key_hash)=64 AND key_hash NOT GLOB '*[^0-9a-f]*')
);
-- This row exists only inside the single atomic INSERT, never as a reusable grant.
CREATE TABLE private_archive_purge_operations (
 asset_id TEXT PRIMARY KEY NOT NULL,
 owner_hash TEXT NOT NULL CHECK(length(owner_hash)=64 AND owner_hash NOT GLOB '*[^0-9a-f]*'),
 epoch_hash TEXT NOT NULL CHECK(length(epoch_hash)=64 AND epoch_hash NOT GLOB '*[^0-9a-f]*'),
 main_sha TEXT NOT NULL CHECK(length(main_sha)=40 AND main_sha NOT GLOB '*[^0-9a-f]*'),
 manifest_hash TEXT NOT NULL CHECK(length(manifest_hash)=64 AND manifest_hash NOT GLOB '*[^0-9a-f]*'),
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 retirements_json TEXT NOT NULL CHECK(json_valid(retirements_json)),
 asset_id_hash TEXT UNIQUE NOT NULL CHECK(length(asset_id_hash)=64 AND asset_id_hash NOT GLOB '*[^0-9a-f]*'),
 reservation_key_hash TEXT UNIQUE NOT NULL CHECK(length(reservation_key_hash)=64 AND reservation_key_hash NOT GLOB '*[^0-9a-f]*'),
 scope_hash TEXT UNIQUE NOT NULL CHECK(length(scope_hash)=64 AND scope_hash NOT GLOB '*[^0-9a-f]*'),
 proof_hash TEXT NOT NULL CHECK(length(proof_hash)=64 AND proof_hash NOT GLOB '*[^0-9a-f]*')
);
CREATE VIEW private_archive_purge_snapshots AS
SELECT a.asset_id,json_object('asset',a.asset_id,'owner',a.owner_identity_hash,
 'site',a.site_mode,'reservation',a.idempotency_key,'reason',d.reason,
 'requestedAt',d.requested_at,'originalAbsentAt',r.verified_at,
 'attempts',json((SELECT json_group_array(json_array(attempt_id,generation_id,public_item_id))
  FROM(SELECT attempt_id,generation_id,public_item_id FROM private_gallery_attempts
   WHERE asset_id=a.asset_id ORDER BY attempt_id))),
 'outputs',json((SELECT json_group_array(json_array(attempt_id,tier,role,object_key))
  FROM(SELECT o.attempt_id,o.tier,o.role,o.object_key FROM private_gallery_pipeline_outputs o
   JOIN private_gallery_attempts p USING(attempt_id) WHERE p.asset_id=a.asset_id
   ORDER BY o.attempt_id,o.tier,o.role)))) AS snapshot_json
FROM private_gallery_assets a
JOIN private_archive_deletion_requests d ON d.asset_id=a.asset_id AND d.actor_identity_hash=a.owner_identity_hash
JOIN private_archive_deletion_receipts r ON r.asset_id=a.asset_id AND r.original_absent=1;
CREATE TRIGGER private_archive_purge_owner_guard BEFORE INSERT ON private_archive_purge_operations BEGIN
 SELECT RAISE(ABORT,'Exact terminal owner request and original deletion required') WHERE NOT EXISTS(
  SELECT 1 FROM private_archive_purge_snapshots s JOIN private_gallery_assets a USING(asset_id)
  WHERE s.asset_id=NEW.asset_id AND a.owner_identity_hash=NEW.owner_hash AND s.snapshot_json=NEW.snapshot_json);
 SELECT RAISE(ABORT,'Original writer closure required') WHERE EXISTS(
  SELECT 1 FROM private_archive_multipart_uploads u WHERE u.asset_id=NEW.asset_id AND NOT EXISTS(
   SELECT 1 FROM private_archive_writer_closures c WHERE c.asset_id=u.asset_id AND c.provider_upload_id=u.provider_upload_id));
 SELECT RAISE(ABORT,'Current delivery epoch required') WHERE NOT EXISTS(
  SELECT 1 FROM gallery_media_delivery_current_epoch WHERE singleton_id=1 AND epoch_id_hash=NEW.epoch_hash);
 SELECT RAISE(ABORT,'Purge cannot be replaced') WHERE EXISTS(
  SELECT 1 FROM private_archive_purge_receipts WHERE asset_id_hash=NEW.asset_id_hash
   OR reservation_key_hash=NEW.reservation_key_hash OR scope_hash=NEW.scope_hash);
END;
CREATE TRIGGER private_archive_purge_public_guard BEFORE INSERT ON private_archive_purge_operations BEGIN
 SELECT RAISE(ABORT,'All attempts require closed generation and current host proof') WHERE EXISTS(
  SELECT 1 FROM private_gallery_attempts a WHERE a.asset_id=NEW.asset_id AND
   (NOT EXISTS(SELECT 1 FROM private_gallery_pipeline_closures WHERE attempt_id=a.attempt_id)
    OR NOT EXISTS(SELECT 1 FROM private_gallery_pipeline_host_receipts WHERE attempt_id=a.attempt_id AND epoch_id_hash=NEW.epoch_hash)));
 SELECT RAISE(ABORT,'Both current storage-tier proofs required') WHERE EXISTS(
  SELECT 1 FROM private_gallery_attempts a JOIN json_each('["staging","approved"]') t
  WHERE a.asset_id=NEW.asset_id AND NOT EXISTS(SELECT 1 FROM private_gallery_pipeline_tier_absences
   WHERE attempt_id=a.attempt_id AND tier=t.value AND epoch_id_hash=NEW.epoch_hash));
 SELECT RAISE(ABORT,'Exact output cleanup required') WHERE EXISTS(
  SELECT 1 FROM private_gallery_attempts a JOIN private_gallery_pipeline_outputs o USING(attempt_id)
  WHERE a.asset_id=NEW.asset_id AND NOT EXISTS(SELECT 1 FROM private_gallery_pipeline_object_removals r
   WHERE r.attempt_id=o.attempt_id AND r.tier=o.tier AND r.role=o.role));
 SELECT RAISE(ABORT,'Current main manifest absence required') WHERE EXISTS(
  SELECT 1 FROM private_gallery_attempts a WHERE a.asset_id=NEW.asset_id AND NOT EXISTS(
   SELECT 1 FROM private_gallery_pipeline_manifest_receipts WHERE attempt_id=a.attempt_id
    AND main_sha=NEW.main_sha AND manifest_sha256=NEW.manifest_hash));
 SELECT RAISE(ABORT,'Addition review terminal proof required') WHERE EXISTS(
  SELECT 1 FROM private_gallery_attempts a JOIN private_gallery_pipeline_review_intents i USING(attempt_id)
  WHERE a.asset_id=NEW.asset_id AND NOT EXISTS(SELECT 1 FROM private_gallery_pipeline_review_closures WHERE attempt_id=a.attempt_id));
 -- No removal-review terminal ledger is wired yet. Never erase its pending authority.
 SELECT RAISE(ABORT,'Removal review terminal reconciliation not yet wired') WHERE EXISTS(
  SELECT 1 FROM private_gallery_attempts a JOIN private_gallery_manifest_removal_intents r USING(attempt_id)
  WHERE a.asset_id=NEW.asset_id);
END;
CREATE TRIGGER private_archive_purge_retirement_guard BEFORE INSERT ON private_archive_purge_operations BEGIN
 SELECT RAISE(ABORT,'Complete generation retirement hashes required') WHERE
  json_type(NEW.retirements_json,'$.generations') IS NOT 'array'
  OR json_array_length(NEW.retirements_json,'$.generations') != json_array_length(NEW.snapshot_json,'$.attempts')
  OR EXISTS(SELECT 1 FROM json_each(NEW.retirements_json,'$.generations') j WHERE
   json_type(j.value) IS NOT 'array' OR json_array_length(j.value)!=2
   OR length(json_extract(j.value,'$[0]'))!=64 OR json_extract(j.value,'$[0]') GLOB '*[^0-9a-f]*'
   OR length(json_extract(j.value,'$[1]'))!=64 OR json_extract(j.value,'$[1]') GLOB '*[^0-9a-f]*');
 SELECT RAISE(ABORT,'Complete key retirement hashes required') WHERE
  json_type(NEW.retirements_json,'$.keys') IS NOT 'array'
  OR json_array_length(NEW.retirements_json,'$.keys') != json_array_length(NEW.snapshot_json,'$.outputs')
  OR EXISTS(SELECT 1 FROM json_each(NEW.retirements_json,'$.keys') WHERE type!='text' OR length(value)!=64 OR value GLOB '*[^0-9a-f]*');
END;
DROP TRIGGER private_gallery_removal_review_no_delete;
CREATE TRIGGER private_gallery_removal_review_no_delete BEFORE DELETE ON private_gallery_manifest_removal_reviews BEGIN
 SELECT RAISE(ABORT,'Exact atomic archive purge required') WHERE NOT EXISTS(
  SELECT 1 FROM private_archive_purge_operations WHERE asset_id IN(SELECT asset_id FROM private_gallery_attempts WHERE attempt_id=OLD.attempt_id));
END;
DROP TRIGGER private_gallery_removal_intent_no_delete;
CREATE TRIGGER private_gallery_removal_intent_no_delete BEFORE DELETE ON private_gallery_manifest_removal_intents BEGIN
 SELECT RAISE(ABORT,'Exact atomic archive purge required') WHERE NOT EXISTS(
  SELECT 1 FROM private_archive_purge_operations WHERE asset_id IN(SELECT asset_id FROM private_gallery_attempts WHERE attempt_id=OLD.attempt_id));
END;
DROP TRIGGER private_gallery_pipeline_review_closures_no_delete;
CREATE TRIGGER private_gallery_pipeline_review_closures_no_delete BEFORE DELETE ON private_gallery_pipeline_review_closures BEGIN
 SELECT RAISE(ABORT,'Exact atomic archive purge required') WHERE NOT EXISTS(
  SELECT 1 FROM private_archive_purge_operations WHERE asset_id IN(SELECT asset_id FROM private_gallery_attempts WHERE attempt_id=OLD.attempt_id));
END;
DROP TRIGGER private_gallery_pipeline_reviews_no_delete;
CREATE TRIGGER private_gallery_pipeline_reviews_no_delete BEFORE DELETE ON private_gallery_pipeline_reviews BEGIN
 SELECT RAISE(ABORT,'Exact atomic archive purge required') WHERE NOT EXISTS(
  SELECT 1 FROM private_archive_purge_operations WHERE asset_id IN(SELECT asset_id FROM private_gallery_attempts WHERE attempt_id=OLD.attempt_id));
END;
DROP TRIGGER private_gallery_pipeline_review_intents_no_delete;
CREATE TRIGGER private_gallery_pipeline_review_intents_no_delete BEFORE DELETE ON private_gallery_pipeline_review_intents BEGIN
 SELECT RAISE(ABORT,'Exact atomic archive purge required') WHERE NOT EXISTS(
  SELECT 1 FROM private_archive_purge_operations WHERE asset_id IN(SELECT asset_id FROM private_gallery_attempts WHERE attempt_id=OLD.attempt_id));
END;
DROP TRIGGER private_gallery_pipeline_byte_receipts_no_delete;
CREATE TRIGGER private_gallery_pipeline_byte_receipts_no_delete BEFORE DELETE ON private_gallery_pipeline_byte_receipts BEGIN
 SELECT RAISE(ABORT,'Exact atomic archive purge required') WHERE NOT EXISTS(
  SELECT 1 FROM private_archive_purge_operations WHERE asset_id IN(SELECT asset_id FROM private_gallery_attempts WHERE attempt_id=OLD.attempt_id));
END;
DROP TRIGGER private_gallery_pipeline_writers_no_delete;
CREATE TRIGGER private_gallery_pipeline_writers_no_delete BEFORE DELETE ON private_gallery_pipeline_writers BEGIN
 SELECT RAISE(ABORT,'Exact atomic archive purge required') WHERE NOT EXISTS(
  SELECT 1 FROM private_archive_purge_operations WHERE asset_id IN(SELECT asset_id FROM private_gallery_attempts WHERE attempt_id=OLD.attempt_id));
END;
DROP TRIGGER private_gallery_pipeline_object_removals_no_delete;
CREATE TRIGGER private_gallery_pipeline_object_removals_no_delete BEFORE DELETE ON private_gallery_pipeline_object_removals BEGIN
 SELECT RAISE(ABORT,'Exact atomic archive purge required') WHERE NOT EXISTS(
  SELECT 1 FROM private_archive_purge_operations WHERE asset_id IN(SELECT asset_id FROM private_gallery_attempts WHERE attempt_id=OLD.attempt_id));
END;
DROP TRIGGER private_gallery_pipeline_outputs_no_delete;
CREATE TRIGGER private_gallery_pipeline_outputs_no_delete BEFORE DELETE ON private_gallery_pipeline_outputs BEGIN
 SELECT RAISE(ABORT,'Exact atomic archive purge required') WHERE NOT EXISTS(
  SELECT 1 FROM private_archive_purge_operations WHERE asset_id IN(SELECT asset_id FROM private_gallery_attempts WHERE attempt_id=OLD.attempt_id));
END;
DROP TRIGGER private_gallery_tier_absence_no_delete;
CREATE TRIGGER private_gallery_tier_absence_no_delete BEFORE DELETE ON private_gallery_pipeline_tier_absences BEGIN
 SELECT RAISE(ABORT,'Exact atomic archive purge required') WHERE NOT EXISTS(
  SELECT 1 FROM private_archive_purge_operations WHERE asset_id IN(SELECT asset_id FROM private_gallery_attempts WHERE attempt_id=OLD.attempt_id));
END;
DROP TRIGGER private_gallery_pipeline_host_receipts_no_delete;
CREATE TRIGGER private_gallery_pipeline_host_receipts_no_delete BEFORE DELETE ON private_gallery_pipeline_host_receipts BEGIN
 SELECT RAISE(ABORT,'Exact atomic archive purge required') WHERE NOT EXISTS(
  SELECT 1 FROM private_archive_purge_operations WHERE asset_id IN(SELECT asset_id FROM private_gallery_attempts WHERE attempt_id=OLD.attempt_id));
END;
DROP TRIGGER private_gallery_pipeline_manifest_receipts_no_delete;
CREATE TRIGGER private_gallery_pipeline_manifest_receipts_no_delete BEFORE DELETE ON private_gallery_pipeline_manifest_receipts BEGIN
 SELECT RAISE(ABORT,'Exact atomic archive purge required') WHERE NOT EXISTS(
  SELECT 1 FROM private_archive_purge_operations WHERE asset_id IN(SELECT asset_id FROM private_gallery_attempts WHERE attempt_id=OLD.attempt_id));
END;
DROP TRIGGER private_gallery_pipeline_admissions_no_delete;
CREATE TRIGGER private_gallery_pipeline_admissions_no_delete BEFORE DELETE ON private_gallery_pipeline_admissions BEGIN
 SELECT RAISE(ABORT,'Exact atomic archive purge required') WHERE NOT EXISTS(
  SELECT 1 FROM private_archive_purge_operations WHERE asset_id IN(SELECT asset_id FROM private_gallery_attempts WHERE attempt_id=OLD.attempt_id));
END;
DROP TRIGGER private_gallery_pipeline_closures_no_delete;
CREATE TRIGGER private_gallery_pipeline_closures_no_delete BEFORE DELETE ON private_gallery_pipeline_closures BEGIN
 SELECT RAISE(ABORT,'Exact atomic archive purge required') WHERE NOT EXISTS(
  SELECT 1 FROM private_archive_purge_operations WHERE asset_id IN(SELECT asset_id FROM private_gallery_attempts WHERE attempt_id=OLD.attempt_id));
END;
DROP TRIGGER private_gallery_attempt_no_delete;
CREATE TRIGGER private_gallery_attempt_no_delete BEFORE DELETE ON private_gallery_attempts BEGIN
 SELECT RAISE(ABORT,'Exact atomic archive purge required') WHERE NOT EXISTS(
  SELECT 1 FROM private_archive_purge_operations WHERE asset_id=OLD.asset_id);
END;
DROP TRIGGER private_gallery_revision_tag_no_delete;
CREATE TRIGGER private_gallery_revision_tag_no_delete BEFORE DELETE ON private_gallery_revision_tags BEGIN
 SELECT RAISE(ABORT,'Exact atomic archive purge required') WHERE NOT EXISTS(
  SELECT 1 FROM private_archive_purge_operations WHERE asset_id=OLD.asset_id);
END;
DROP TRIGGER private_gallery_tag_revision_no_delete;
CREATE TRIGGER private_gallery_tag_revision_no_delete BEFORE DELETE ON private_gallery_tag_revisions BEGIN
 SELECT RAISE(ABORT,'Exact atomic archive purge required') WHERE NOT EXISTS(
  SELECT 1 FROM private_archive_purge_operations WHERE asset_id=OLD.asset_id);
END;
DROP TRIGGER private_archive_original_no_delete;
CREATE TRIGGER private_archive_original_no_delete BEFORE DELETE ON private_archive_original_receipts BEGIN
 SELECT RAISE(ABORT,'Exact atomic archive purge required') WHERE NOT EXISTS(
  SELECT 1 FROM private_archive_purge_operations WHERE asset_id=OLD.asset_id);
END;
DROP TRIGGER private_archive_closure_no_delete;
CREATE TRIGGER private_archive_closure_no_delete BEFORE DELETE ON private_archive_writer_closures BEGIN
 SELECT RAISE(ABORT,'Exact atomic archive purge required') WHERE NOT EXISTS(
  SELECT 1 FROM private_archive_purge_operations WHERE asset_id=OLD.asset_id);
END;
DROP TRIGGER private_archive_upload_no_delete;
CREATE TRIGGER private_archive_upload_no_delete BEFORE DELETE ON private_archive_multipart_uploads BEGIN
 SELECT RAISE(ABORT,'Exact atomic archive purge required') WHERE NOT EXISTS(
  SELECT 1 FROM private_archive_purge_operations WHERE asset_id=OLD.asset_id);
END;
DROP TRIGGER private_archive_intake_no_delete;
CREATE TRIGGER private_archive_intake_no_delete BEFORE DELETE ON private_archive_intakes BEGIN
 SELECT RAISE(ABORT,'Exact atomic archive purge required') WHERE NOT EXISTS(
  SELECT 1 FROM private_archive_purge_operations WHERE asset_id=OLD.asset_id);
END;
DROP TRIGGER private_archive_receipt_no_delete;
CREATE TRIGGER private_archive_receipt_no_delete BEFORE DELETE ON private_archive_deletion_receipts BEGIN
 SELECT RAISE(ABORT,'Exact atomic archive purge required') WHERE NOT EXISTS(
  SELECT 1 FROM private_archive_purge_operations WHERE asset_id=OLD.asset_id);
END;
DROP TRIGGER private_archive_deletion_no_delete;
CREATE TRIGGER private_archive_deletion_no_delete BEFORE DELETE ON private_archive_deletion_requests BEGIN
 SELECT RAISE(ABORT,'Exact atomic archive purge required') WHERE NOT EXISTS(
  SELECT 1 FROM private_archive_purge_operations WHERE asset_id=OLD.asset_id);
END;
DROP TRIGGER private_gallery_asset_tags_no_delete;
CREATE TRIGGER private_gallery_asset_tags_no_delete BEFORE DELETE ON private_gallery_asset_tags BEGIN
 SELECT RAISE(ABORT,'Exact atomic archive purge required') WHERE NOT EXISTS(
  SELECT 1 FROM private_archive_purge_operations WHERE asset_id=OLD.asset_id);
END;
DROP TRIGGER private_gallery_assets_no_delete;
CREATE TRIGGER private_gallery_assets_no_delete BEFORE DELETE ON private_gallery_assets BEGIN
 SELECT RAISE(ABORT,'Exact atomic archive purge required') WHERE NOT EXISTS(
  SELECT 1 FROM private_archive_purge_operations WHERE asset_id=OLD.asset_id);
END;
CREATE TRIGGER private_archive_purge_atomic AFTER INSERT ON private_archive_purge_operations BEGIN
 INSERT INTO private_archive_purge_receipts(asset_id_hash,reservation_key_hash,scope_hash,proof_hash)
 VALUES(NEW.asset_id_hash,NEW.reservation_key_hash,NEW.scope_hash,NEW.proof_hash);
 INSERT INTO private_gallery_retired_generations(generation_hash,item_hash)
 SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(NEW.retirements_json,'$.generations');
 INSERT INTO private_gallery_retired_keys(key_hash) SELECT value FROM json_each(NEW.retirements_json,'$.keys');
 DELETE FROM private_gallery_manifest_removal_reviews WHERE attempt_id IN(SELECT attempt_id FROM private_gallery_attempts WHERE asset_id=NEW.asset_id);
 DELETE FROM private_gallery_manifest_removal_intents WHERE attempt_id IN(SELECT attempt_id FROM private_gallery_attempts WHERE asset_id=NEW.asset_id);
 DELETE FROM private_gallery_pipeline_review_closures WHERE attempt_id IN(SELECT attempt_id FROM private_gallery_attempts WHERE asset_id=NEW.asset_id);
 DELETE FROM private_gallery_pipeline_reviews WHERE attempt_id IN(SELECT attempt_id FROM private_gallery_attempts WHERE asset_id=NEW.asset_id);
 DELETE FROM private_gallery_pipeline_review_intents WHERE attempt_id IN(SELECT attempt_id FROM private_gallery_attempts WHERE asset_id=NEW.asset_id);
 DELETE FROM private_gallery_pipeline_byte_receipts WHERE attempt_id IN(SELECT attempt_id FROM private_gallery_attempts WHERE asset_id=NEW.asset_id);
 DELETE FROM private_gallery_pipeline_writers WHERE attempt_id IN(SELECT attempt_id FROM private_gallery_attempts WHERE asset_id=NEW.asset_id);
 DELETE FROM private_gallery_pipeline_object_removals WHERE attempt_id IN(SELECT attempt_id FROM private_gallery_attempts WHERE asset_id=NEW.asset_id);
 DELETE FROM private_gallery_pipeline_outputs WHERE attempt_id IN(SELECT attempt_id FROM private_gallery_attempts WHERE asset_id=NEW.asset_id);
 DELETE FROM private_gallery_pipeline_tier_absences WHERE attempt_id IN(SELECT attempt_id FROM private_gallery_attempts WHERE asset_id=NEW.asset_id);
 DELETE FROM private_gallery_pipeline_host_receipts WHERE attempt_id IN(SELECT attempt_id FROM private_gallery_attempts WHERE asset_id=NEW.asset_id);
 DELETE FROM private_gallery_pipeline_manifest_receipts WHERE attempt_id IN(SELECT attempt_id FROM private_gallery_attempts WHERE asset_id=NEW.asset_id);
 DELETE FROM private_gallery_pipeline_admissions WHERE attempt_id IN(SELECT attempt_id FROM private_gallery_attempts WHERE asset_id=NEW.asset_id);
 DELETE FROM private_gallery_pipeline_closures WHERE attempt_id IN(SELECT attempt_id FROM private_gallery_attempts WHERE asset_id=NEW.asset_id);
 DELETE FROM private_gallery_attempts WHERE asset_id=NEW.asset_id;
 DELETE FROM private_gallery_revision_tags WHERE asset_id=NEW.asset_id;
 DELETE FROM private_gallery_tag_revisions WHERE asset_id=NEW.asset_id;
 DELETE FROM private_archive_original_receipts WHERE asset_id=NEW.asset_id;
 DELETE FROM private_archive_writer_closures WHERE asset_id=NEW.asset_id;
 DELETE FROM private_archive_multipart_uploads WHERE asset_id=NEW.asset_id;
 DELETE FROM private_archive_intakes WHERE asset_id=NEW.asset_id;
 DELETE FROM private_archive_deletion_receipts WHERE asset_id=NEW.asset_id;
 DELETE FROM private_archive_deletion_requests WHERE asset_id=NEW.asset_id;
 DELETE FROM private_gallery_asset_tags WHERE asset_id=NEW.asset_id;
 DELETE FROM private_gallery_assets WHERE asset_id=NEW.asset_id;
 DELETE FROM private_archive_purge_operations WHERE asset_id=NEW.asset_id;
END;
CREATE TRIGGER private_archive_purge_operation_no_update BEFORE UPDATE ON private_archive_purge_operations
BEGIN SELECT RAISE(ABORT,'Purge operation immutable'); END;
CREATE TRIGGER private_archive_purge_operation_no_delete BEFORE DELETE ON private_archive_purge_operations BEGIN
 SELECT RAISE(ABORT,'Purge did not complete atomically') WHERE
 EXISTS(SELECT 1 FROM private_gallery_assets WHERE asset_id=OLD.asset_id)
 OR NOT EXISTS(SELECT 1 FROM private_archive_purge_receipts WHERE asset_id_hash=OLD.asset_id_hash AND scope_hash=OLD.scope_hash);
END;
CREATE TRIGGER private_archive_purge_receipts_insert_guard BEFORE INSERT ON private_archive_purge_receipts BEGIN
 SELECT RAISE(ABORT,'Permanent purge evidence cannot be replaced') WHERE EXISTS(SELECT 1 FROM private_archive_purge_receipts WHERE asset_id_hash=NEW.asset_id_hash OR reservation_key_hash=NEW.reservation_key_hash OR scope_hash=NEW.scope_hash);
 SELECT RAISE(ABORT,'Purge receipt clock server owned') WHERE NEW.purged_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now');
 SELECT RAISE(ABORT,'Retirement requires exact atomic purge') WHERE NOT EXISTS(SELECT 1 FROM private_archive_purge_operations WHERE asset_id_hash=NEW.asset_id_hash AND reservation_key_hash=NEW.reservation_key_hash AND scope_hash=NEW.scope_hash AND proof_hash=NEW.proof_hash);
END;
CREATE TRIGGER private_archive_purge_receipts_no_update BEFORE UPDATE ON private_archive_purge_receipts BEGIN SELECT RAISE(ABORT,'Permanent purge evidence immutable'); END;
CREATE TRIGGER private_archive_purge_receipts_no_delete BEFORE DELETE ON private_archive_purge_receipts BEGIN SELECT RAISE(ABORT,'Permanent purge evidence immutable'); END;
CREATE TRIGGER private_gallery_retired_generations_insert_guard BEFORE INSERT ON private_gallery_retired_generations BEGIN
 SELECT RAISE(ABORT,'Permanent purge evidence cannot be replaced') WHERE EXISTS(SELECT 1 FROM private_gallery_retired_generations WHERE generation_hash=NEW.generation_hash OR item_hash=NEW.item_hash);
 SELECT RAISE(ABORT,'Retirement requires exact atomic purge') WHERE NOT EXISTS(SELECT 1 FROM private_archive_purge_operations WHERE EXISTS(SELECT 1 FROM json_each(retirements_json,'$.generations') WHERE json_extract(value,'$[0]')=NEW.generation_hash AND json_extract(value,'$[1]')=NEW.item_hash));
END;
CREATE TRIGGER private_gallery_retired_generations_no_update BEFORE UPDATE ON private_gallery_retired_generations BEGIN SELECT RAISE(ABORT,'Permanent purge evidence immutable'); END;
CREATE TRIGGER private_gallery_retired_generations_no_delete BEFORE DELETE ON private_gallery_retired_generations BEGIN SELECT RAISE(ABORT,'Permanent purge evidence immutable'); END;
CREATE TRIGGER private_gallery_retired_keys_insert_guard BEFORE INSERT ON private_gallery_retired_keys BEGIN
 SELECT RAISE(ABORT,'Permanent purge evidence cannot be replaced') WHERE EXISTS(SELECT 1 FROM private_gallery_retired_keys WHERE key_hash=NEW.key_hash);
 SELECT RAISE(ABORT,'Retirement requires exact atomic purge') WHERE NOT EXISTS(SELECT 1 FROM private_archive_purge_operations WHERE EXISTS(SELECT 1 FROM json_each(retirements_json,'$.keys') WHERE value=NEW.key_hash));
END;
CREATE TRIGGER private_gallery_retired_keys_no_update BEFORE UPDATE ON private_gallery_retired_keys BEGIN SELECT RAISE(ABORT,'Permanent purge evidence immutable'); END;
CREATE TRIGGER private_gallery_retired_keys_no_delete BEFORE DELETE ON private_gallery_retired_keys BEGIN SELECT RAISE(ABORT,'Permanent purge evidence immutable'); END;
