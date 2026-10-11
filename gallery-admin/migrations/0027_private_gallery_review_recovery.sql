-- One-way PR POST admission. Absence of a PR is terminal only BEFORE this
-- boundary; a timed-out admitted POST is uncertain, never an assumed no-PR.
CREATE TABLE private_gallery_review_write_admissions (
 attempt_id TEXT NOT NULL REFERENCES private_gallery_attempts(attempt_id),
 kind TEXT NOT NULL CHECK(kind IN ('addition','removal')),
 base_sha TEXT NOT NULL CHECK(length(base_sha)=40 AND base_sha NOT GLOB '*[^0-9a-f]*'),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(attempt_id,kind,base_sha)
);
CREATE TABLE private_gallery_review_terminals (
 attempt_id TEXT NOT NULL REFERENCES private_gallery_attempts(attempt_id),
 kind TEXT NOT NULL CHECK(kind IN ('addition','removal')),
 base_sha TEXT NOT NULL CHECK(length(base_sha)=40 AND base_sha NOT GLOB '*[^0-9a-f]*'),
 evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(attempt_id,kind,base_sha)
);
CREATE VIEW private_gallery_review_requests AS
 SELECT attempt_id,'addition' AS kind,base_sha,
  json_extract(candidate_json,'$.targetRelativePath') AS path,
  json_extract(candidate_json,'$.itemId') AS item_id,
  json_extract(candidate_json,'$.manifestSha256') AS manifest_hash FROM private_gallery_pipeline_review_intents
 UNION ALL SELECT attempt_id,'removal',base_sha,
  json_extract(removal_json,'$.targetRelativePath'),json_extract(removal_json,'$.item.id'),
  json_extract(removal_json,'$.manifestSha256') FROM private_gallery_manifest_removal_intents;
-- A historical request has no pre-POST gate evidence. Conservatively classify
-- it as potentially admitted; upgrading must never invent a no-PR receipt.
INSERT INTO private_gallery_review_write_admissions(attempt_id,kind,base_sha)
 SELECT attempt_id,kind,base_sha FROM private_gallery_review_requests;
CREATE TRIGGER private_gallery_review_write_guard BEFORE INSERT ON private_gallery_review_write_admissions BEGIN
 SELECT RAISE(ABORT,'Exact review intent required') WHERE NOT EXISTS(
  SELECT 1 FROM private_gallery_review_requests WHERE attempt_id=NEW.attempt_id AND kind=NEW.kind AND base_sha=NEW.base_sha);
 SELECT RAISE(ABORT,'Review POST already admitted or retired') WHERE EXISTS(
  SELECT 1 FROM private_gallery_review_write_admissions WHERE attempt_id=NEW.attempt_id AND kind=NEW.kind AND base_sha=NEW.base_sha)
  OR EXISTS(SELECT 1 FROM private_gallery_review_terminals WHERE attempt_id=NEW.attempt_id AND kind=NEW.kind AND base_sha=NEW.base_sha);
 SELECT RAISE(ABORT,'Addition no longer eligible') WHERE NEW.kind='addition' AND (
  NOT EXISTS(SELECT 1 FROM private_gallery_current_attempt_permissions WHERE attempt_id=NEW.attempt_id)
  OR EXISTS(SELECT 1 FROM private_gallery_pipeline_closures WHERE attempt_id=NEW.attempt_id));
 SELECT RAISE(ABORT,'Removal generation not closed') WHERE NEW.kind='removal' AND NOT EXISTS(
  SELECT 1 FROM private_gallery_pipeline_closures WHERE attempt_id=NEW.attempt_id);
 SELECT RAISE(ABORT,'Server clock required') WHERE NEW.created_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER private_gallery_review_terminal_guard BEFORE INSERT ON private_gallery_review_terminals BEGIN
 SELECT RAISE(ABORT,'Review terminal cannot be replaced') WHERE EXISTS(
  SELECT 1 FROM private_gallery_review_terminals WHERE attempt_id=NEW.attempt_id AND kind=NEW.kind AND base_sha=NEW.base_sha);
 SELECT RAISE(ABORT,'Closed generation required') WHERE NOT EXISTS(
  SELECT 1 FROM private_gallery_pipeline_closures WHERE attempt_id=NEW.attempt_id);
 SELECT RAISE(ABORT,'Terminal review differs from exact intent') WHERE NOT EXISTS(
  SELECT 1 FROM private_gallery_review_requests r WHERE r.attempt_id=NEW.attempt_id AND r.kind=NEW.kind AND r.base_sha=NEW.base_sha
  AND json_extract(NEW.evidence_json,'$.baseSha')=r.base_sha
  AND json_extract(NEW.evidence_json,'$.targetRelativePath')=r.path
  AND json_extract(NEW.evidence_json,'$.itemId')=r.item_id
  AND json_extract(NEW.evidence_json,'$.manifestSha256')=r.manifest_hash
  AND json_extract(NEW.evidence_json,'$.schemaVersion')='1.0'
  AND json_extract(NEW.evidence_json,'$.repository')='johnkevan88888/family-running'
  AND json_extract(NEW.evidence_json,'$.baseRef')='main');
 SELECT RAISE(ABORT,'No-PR must precede any admitted POST or recorded PR') WHERE
  json_extract(NEW.evidence_json,'$.state')='no-pr-created' AND (
   json_type(NEW.evidence_json,'$.pullRequest') IS NOT 'null'
   OR EXISTS(SELECT 1 FROM private_gallery_review_write_admissions WHERE attempt_id=NEW.attempt_id AND kind=NEW.kind AND base_sha=NEW.base_sha)
   OR (NEW.kind='addition' AND EXISTS(SELECT 1 FROM private_gallery_pipeline_reviews WHERE attempt_id=NEW.attempt_id))
   OR (NEW.kind='removal' AND EXISTS(SELECT 1 FROM private_gallery_manifest_removal_reviews WHERE attempt_id=NEW.attempt_id AND base_sha=NEW.base_sha)));
 SELECT RAISE(ABORT,'Positive terminal PR evidence required') WHERE
  json_extract(NEW.evidence_json,'$.state') IN ('closed-unmerged','merged-by-owner') AND (
   json_extract(NEW.evidence_json,'$.pullRequest.state') IS NOT 'closed'
   OR json_type(NEW.evidence_json,'$.pullRequest.number') IS NOT 'integer'
   OR json_extract(NEW.evidence_json,'$.pullRequest.number')<1
   OR json_extract(NEW.evidence_json,'$.pullRequest.url') IS NOT
    'https://github.com/johnkevan88888/family-running/pull/'||json_extract(NEW.evidence_json,'$.pullRequest.number')
   OR length(json_extract(NEW.evidence_json,'$.headSha')) IS NOT 40
   OR json_extract(NEW.evidence_json,'$.headSha') GLOB '*[^0-9a-f]*');
 SELECT RAISE(ABORT,'Unknown terminal result') WHERE json_extract(NEW.evidence_json,'$.state') IS NULL
  OR json_extract(NEW.evidence_json,'$.state') NOT IN ('no-pr-created','closed-unmerged','merged-by-owner');
 SELECT RAISE(ABORT,'Exact terminal schema required') WHERE (SELECT count(*) FROM json_each(NEW.evidence_json))!=13
  OR length(json_extract(NEW.evidence_json,'$.branchRef')) IS NOT 56
  OR substr(json_extract(NEW.evidence_json,'$.branchRef'),1,24) IS NOT 'gallery-media/candidate-'
  OR substr(json_extract(NEW.evidence_json,'$.branchRef'),25) GLOB '*[^0-9a-f]*';
 SELECT RAISE(ABORT,'Exact merge outcome required') WHERE
  (json_extract(NEW.evidence_json,'$.state')='merged-by-owner' AND (
   length(json_extract(NEW.evidence_json,'$.mergeSha')) IS NOT 40 OR json_extract(NEW.evidence_json,'$.mergeSha') GLOB '*[^0-9a-f]*'
   OR length(json_extract(NEW.evidence_json,'$.mainSha')) IS NOT 40 OR json_extract(NEW.evidence_json,'$.mainSha') GLOB '*[^0-9a-f]*'))
  OR (json_extract(NEW.evidence_json,'$.state')!='merged-by-owner' AND (
   json_type(NEW.evidence_json,'$.mergeSha') IS NOT 'null' OR json_type(NEW.evidence_json,'$.mainSha') IS NOT 'null'));
 SELECT RAISE(ABORT,'Recorded PR identity cannot change') WHERE EXISTS(
  SELECT 1 FROM private_gallery_pipeline_reviews r WHERE NEW.kind='addition' AND r.attempt_id=NEW.attempt_id AND (
   json_extract(NEW.evidence_json,'$.headSha') IS NOT json_extract(r.review_json,'$.headSha')
   OR json_extract(NEW.evidence_json,'$.pullRequest.number') IS NOT json_extract(r.review_json,'$.pullRequest.number')))
  OR EXISTS(SELECT 1 FROM private_gallery_manifest_removal_reviews r WHERE NEW.kind='removal' AND r.attempt_id=NEW.attempt_id AND r.base_sha=NEW.base_sha AND (
   json_extract(NEW.evidence_json,'$.headSha') IS NOT json_extract(r.review_json,'$.headSha')
   OR json_extract(NEW.evidence_json,'$.pullRequest.number') IS NOT json_extract(r.review_json,'$.pullRequest.number')));
 SELECT RAISE(ABORT,'Server clock required') WHERE NEW.created_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER private_gallery_review_write_no_update BEFORE UPDATE ON private_gallery_review_write_admissions BEGIN SELECT RAISE(ABORT,'PR admission immutable'); END;
CREATE TRIGGER private_gallery_review_terminal_no_update BEFORE UPDATE ON private_gallery_review_terminals BEGIN SELECT RAISE(ABORT,'Terminal review immutable'); END;
CREATE TRIGGER private_gallery_review_write_no_delete BEFORE DELETE ON private_gallery_review_write_admissions BEGIN
 SELECT RAISE(ABORT,'Exact atomic archive purge required') WHERE NOT EXISTS(
  SELECT 1 FROM private_archive_purge_operations WHERE asset_id IN(SELECT asset_id FROM private_gallery_attempts WHERE attempt_id=OLD.attempt_id));
END;
CREATE TRIGGER private_gallery_review_terminal_no_delete BEFORE DELETE ON private_gallery_review_terminals BEGIN
 SELECT RAISE(ABORT,'Exact atomic archive purge required') WHERE NOT EXISTS(
  SELECT 1 FROM private_archive_purge_operations WHERE asset_id IN(SELECT asset_id FROM private_gallery_attempts WHERE attempt_id=OLD.attempt_id));
END;
DROP TRIGGER private_gallery_split_manifest_guard;
CREATE TRIGGER private_gallery_split_manifest_guard BEFORE INSERT ON private_gallery_pipeline_manifest_receipts BEGIN
 SELECT RAISE(ABORT,'Current host absence required') WHERE NOT EXISTS(
  SELECT 1 FROM private_gallery_pipeline_host_receipts h JOIN gallery_media_delivery_current_epoch e
   ON e.epoch_id_hash=h.epoch_id_hash WHERE h.attempt_id=NEW.attempt_id);
 SELECT RAISE(ABORT,'Both current tier proofs required') WHERE 2!=(
  SELECT count(*) FROM private_gallery_pipeline_tier_absences t JOIN gallery_media_delivery_current_epoch e
   ON e.epoch_id_hash=t.epoch_id_hash WHERE t.attempt_id=NEW.attempt_id);
 SELECT RAISE(ABORT,'Addition review still pending') WHERE EXISTS(
  SELECT 1 FROM private_gallery_pipeline_review_intents i WHERE i.attempt_id=NEW.attempt_id AND
   NOT EXISTS(SELECT 1 FROM private_gallery_pipeline_review_closures WHERE attempt_id=i.attempt_id) AND
   NOT EXISTS(SELECT 1 FROM private_gallery_review_terminals WHERE attempt_id=i.attempt_id AND kind='addition' AND base_sha=i.base_sha));
 SELECT RAISE(ABORT,'Removal review still pending') WHERE EXISTS(
  SELECT 1 FROM private_gallery_manifest_removal_intents i WHERE i.attempt_id=NEW.attempt_id AND
   NOT EXISTS(SELECT 1 FROM private_gallery_review_terminals WHERE attempt_id=i.attempt_id AND kind='removal' AND base_sha=i.base_sha));
END;
DROP VIEW private_gallery_pipeline_current_removal;
CREATE VIEW private_gallery_pipeline_current_removal AS
SELECT c.attempt_id FROM private_gallery_pipeline_closures c
JOIN gallery_media_delivery_current_epoch e ON e.singleton_id=1
JOIN private_gallery_pipeline_host_receipts h ON h.attempt_id=c.attempt_id AND h.epoch_id_hash=e.epoch_id_hash
WHERE EXISTS(SELECT 1 FROM private_gallery_pipeline_manifest_receipts m WHERE m.attempt_id=c.attempt_id)
 AND 2=(SELECT count(*) FROM private_gallery_pipeline_tier_absences t WHERE t.attempt_id=c.attempt_id AND t.epoch_id_hash=e.epoch_id_hash)
 AND NOT EXISTS(SELECT 1 FROM private_gallery_pipeline_outputs o WHERE o.attempt_id=c.attempt_id
  AND NOT EXISTS(SELECT 1 FROM private_gallery_pipeline_object_removals r WHERE r.attempt_id=o.attempt_id AND r.tier=o.tier AND r.role=o.role))
 AND NOT EXISTS(SELECT 1 FROM private_gallery_review_requests i WHERE i.attempt_id=c.attempt_id AND
  NOT EXISTS(SELECT 1 FROM private_gallery_review_terminals t WHERE t.attempt_id=i.attempt_id AND t.kind=i.kind AND t.base_sha=i.base_sha)
  AND NOT(i.kind='addition' AND EXISTS(SELECT 1 FROM private_gallery_pipeline_review_closures WHERE attempt_id=i.attempt_id)));
-- Extra guards on the existing atomic purge retain every 0026 check. Replace
-- only its terminal-review alternatives, not the byte/owner/host checks.
DROP TRIGGER private_archive_purge_public_guard;
CREATE TRIGGER private_archive_purge_public_guard BEFORE INSERT ON private_archive_purge_operations BEGIN
 SELECT RAISE(ABORT,'All attempts require closed generation and current host proof') WHERE EXISTS(
  SELECT 1 FROM private_gallery_attempts a WHERE a.asset_id=NEW.asset_id AND
   (NOT EXISTS(SELECT 1 FROM private_gallery_pipeline_closures WHERE attempt_id=a.attempt_id)
    OR NOT EXISTS(SELECT 1 FROM private_gallery_pipeline_host_receipts WHERE attempt_id=a.attempt_id AND epoch_id_hash=NEW.epoch_hash)));
 SELECT RAISE(ABORT,'Both current storage-tier proofs required') WHERE EXISTS(
  SELECT 1 FROM private_gallery_attempts a JOIN json_each('["staging","approved"]') t WHERE a.asset_id=NEW.asset_id AND
   NOT EXISTS(SELECT 1 FROM private_gallery_pipeline_tier_absences WHERE attempt_id=a.attempt_id AND tier=t.value AND epoch_id_hash=NEW.epoch_hash));
 SELECT RAISE(ABORT,'Exact output cleanup required') WHERE EXISTS(
  SELECT 1 FROM private_gallery_attempts a JOIN private_gallery_pipeline_outputs o USING(attempt_id) WHERE a.asset_id=NEW.asset_id AND
   NOT EXISTS(SELECT 1 FROM private_gallery_pipeline_object_removals r WHERE r.attempt_id=o.attempt_id AND r.tier=o.tier AND r.role=o.role));
 SELECT RAISE(ABORT,'Current main manifest absence required') WHERE EXISTS(
  SELECT 1 FROM private_gallery_attempts a WHERE a.asset_id=NEW.asset_id AND NOT EXISTS(
   SELECT 1 FROM private_gallery_pipeline_manifest_receipts WHERE attempt_id=a.attempt_id AND main_sha=NEW.main_sha AND manifest_sha256=NEW.manifest_hash));
 SELECT RAISE(ABORT,'Exact terminal review proof required') WHERE EXISTS(
  SELECT 1 FROM private_gallery_attempts a JOIN private_gallery_review_requests i USING(attempt_id) WHERE a.asset_id=NEW.asset_id AND
   NOT EXISTS(SELECT 1 FROM private_gallery_review_terminals t WHERE t.attempt_id=i.attempt_id AND t.kind=i.kind AND t.base_sha=i.base_sha) AND
   NOT(i.kind='addition' AND EXISTS(SELECT 1 FROM private_gallery_pipeline_review_closures WHERE attempt_id=i.attempt_id)));
END;
-- Runs within the parent's exact atomic purge, before its FK-owned deletion.
CREATE TRIGGER private_gallery_attempt_review_purge BEFORE DELETE ON private_gallery_attempts BEGIN
 SELECT RAISE(ABORT,'Exact atomic archive purge required') WHERE NOT EXISTS(
  SELECT 1 FROM private_archive_purge_operations WHERE asset_id=OLD.asset_id);
 DELETE FROM private_gallery_review_terminals WHERE attempt_id=OLD.attempt_id;
 DELETE FROM private_gallery_review_write_admissions WHERE attempt_id=OLD.attempt_id;
END;
