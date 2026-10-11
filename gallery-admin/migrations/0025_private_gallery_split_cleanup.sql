-- Separate storage services certify only their own exact closed generation.
-- These receipts are storage evidence, never public-host absence evidence.
CREATE TABLE private_gallery_pipeline_tier_absences (
 attempt_id TEXT NOT NULL REFERENCES private_gallery_pipeline_closures(attempt_id),
 tier TEXT NOT NULL CHECK(tier IN ('staging','approved')),
 epoch_id_hash TEXT NOT NULL REFERENCES gallery_media_delivery_epochs(epoch_id_hash),
 verified_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(attempt_id,tier,epoch_id_hash)
);
CREATE TRIGGER private_gallery_tier_absence_guard BEFORE INSERT ON private_gallery_pipeline_tier_absences BEGIN
 SELECT RAISE(ABORT,'Current delivery epoch required') WHERE NOT EXISTS (
  SELECT 1 FROM gallery_media_delivery_current_epoch WHERE singleton_id=1 AND epoch_id_hash=NEW.epoch_id_hash);
 SELECT RAISE(ABORT,'Tier cleanup incomplete') WHERE EXISTS (
  SELECT 1 FROM private_gallery_pipeline_outputs o LEFT JOIN private_gallery_pipeline_object_removals r
   USING(attempt_id,tier,role) WHERE o.attempt_id=NEW.attempt_id AND o.tier=NEW.tier AND r.attempt_id IS NULL);
 SELECT RAISE(ABORT,'Tier proof cannot be replaced') WHERE EXISTS (
  SELECT 1 FROM private_gallery_pipeline_tier_absences WHERE attempt_id=NEW.attempt_id AND tier=NEW.tier AND epoch_id_hash=NEW.epoch_id_hash);
 SELECT RAISE(ABORT,'Server clock required') WHERE NEW.verified_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER private_gallery_tier_absence_no_update BEFORE UPDATE ON private_gallery_pipeline_tier_absences
BEGIN SELECT RAISE(ABORT,'Tier proof immutable'); END;
CREATE TRIGGER private_gallery_tier_absence_no_delete BEFORE DELETE ON private_gallery_pipeline_tier_absences
BEGIN SELECT RAISE(ABORT,'Tier proof purge not enabled'); END;

CREATE TRIGGER private_gallery_split_manifest_guard BEFORE INSERT ON private_gallery_pipeline_manifest_receipts BEGIN
 SELECT RAISE(ABORT,'Current host absence required') WHERE NOT EXISTS(
  SELECT 1 FROM private_gallery_pipeline_host_receipts h JOIN gallery_media_delivery_current_epoch e
   ON e.epoch_id_hash=h.epoch_id_hash WHERE h.attempt_id=NEW.attempt_id);
 SELECT RAISE(ABORT,'Exact review terminal evidence required') WHERE EXISTS(
  SELECT 1 FROM private_gallery_pipeline_review_intents i WHERE i.attempt_id=NEW.attempt_id AND NOT EXISTS(
   SELECT 1 FROM private_gallery_pipeline_review_closures c WHERE c.attempt_id=i.attempt_id));
END;
