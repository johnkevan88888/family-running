-- Additive review-only batches. Individual consent/processing evidence is never
-- combined or rewritten. A batch holds the existing global slot until removal.
CREATE TABLE private_gallery_batch_jobs (
 job_id TEXT PRIMARY KEY NOT NULL,
 job_hash TEXT UNIQUE NOT NULL CHECK(length(job_hash)=64 AND job_hash NOT GLOB '*[^0-9a-f]*'),
 owner_hash TEXT NOT NULL,
 site_mode TEXT NOT NULL CHECK(site_mode IN ('family','everyone')),
 attempts_json TEXT NOT NULL CHECK(json_valid(attempts_json) AND json_type(attempts_json)='array' AND json_array_length(attempts_json) BETWEEN 1 AND 20),
 idempotency_key TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(owner_hash,site_mode,idempotency_key)
);
CREATE VIEW private_gallery_batch_members AS
 SELECT b.job_id,b.owner_hash,b.site_mode,CAST(j.key AS INTEGER) AS ordinal,a.asset_id,a.attempt_id,a.public_item_id
 FROM private_gallery_batch_jobs b JOIN json_each(b.attempts_json) j JOIN private_gallery_attempts a ON a.attempt_id=j.value;
CREATE TABLE private_gallery_batch_claims (
 job_id TEXT PRIMARY KEY REFERENCES private_gallery_batch_jobs(job_id),
 run_reference TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE private_gallery_batch_intents (
 job_id TEXT PRIMARY KEY REFERENCES private_gallery_batch_claims(job_id),
 base_sha TEXT NOT NULL CHECK(length(base_sha)=40 AND base_sha NOT GLOB '*[^0-9a-f]*'),
 candidate_json TEXT NOT NULL CHECK(json_valid(candidate_json)),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE private_gallery_batch_write_admissions (
 job_id TEXT PRIMARY KEY REFERENCES private_gallery_batch_intents(job_id),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE private_gallery_batch_reviews (
 job_id TEXT PRIMARY KEY REFERENCES private_gallery_batch_intents(job_id),
 review_json TEXT NOT NULL CHECK(json_valid(review_json)),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE private_gallery_batch_terminals (
 job_id TEXT PRIMARY KEY REFERENCES private_gallery_batch_intents(job_id),
 evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE private_gallery_batch_completions (
 job_id TEXT PRIMARY KEY REFERENCES private_gallery_batch_claims(job_id),
 result_json TEXT NOT NULL CHECK(json_valid(result_json)),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
DROP VIEW private_gallery_active_job;
CREATE VIEW private_gallery_active_job AS
 SELECT j.*,c.run_reference FROM private_gallery_owner_jobs j
 JOIN private_gallery_job_claims c USING(job_id) LEFT JOIN private_gallery_job_completions d USING(job_id) WHERE d.job_id IS NULL
 UNION ALL SELECT b.job_id,b.job_hash,NULL,b.owner_hash,b.site_mode,'batch-review',NULL,b.idempotency_key,NULL,NULL,NULL,b.created_at,c.run_reference
 FROM private_gallery_batch_jobs b JOIN private_gallery_batch_claims c USING(job_id)
 LEFT JOIN private_gallery_batch_completions d USING(job_id) WHERE d.job_id IS NULL;
CREATE VIEW private_gallery_batch_ineligible_members AS
 SELECT m.job_id,m.attempt_id FROM private_gallery_batch_members m
 WHERE NOT EXISTS(SELECT 1 FROM private_gallery_current_attempt_permissions p WHERE p.attempt_id=m.attempt_id)
 OR EXISTS(SELECT 1 FROM private_gallery_pipeline_closures c WHERE c.attempt_id=m.attempt_id);
CREATE VIEW private_gallery_batch_unprepared_members AS
 SELECT m.job_id,m.attempt_id FROM private_gallery_batch_members m WHERE
 EXISTS(SELECT 1 FROM private_gallery_batch_ineligible_members x WHERE x.job_id=m.job_id AND x.attempt_id=m.attempt_id)
 OR NOT EXISTS(SELECT 1 FROM private_gallery_pipeline_admissions a JOIN gallery_media_delivery_current_epoch e ON e.epoch_id_hash=a.epoch_id_hash WHERE a.attempt_id=m.attempt_id)
 OR 2!=(SELECT count(*) FROM private_gallery_pipeline_byte_receipts r WHERE r.attempt_id=m.attempt_id AND r.tier='approved');
CREATE TRIGGER private_gallery_batch_job_guard BEFORE INSERT ON private_gallery_batch_jobs BEGIN
 SELECT RAISE(ABORT,'Batch identity already exists') WHERE EXISTS(SELECT 1 FROM private_gallery_owner_jobs WHERE job_id=NEW.job_id)
 OR EXISTS(SELECT 1 FROM private_gallery_batch_jobs WHERE job_id=NEW.job_id OR (owner_hash=NEW.owner_hash AND site_mode=NEW.site_mode AND idempotency_key=NEW.idempotency_key));
 SELECT RAISE(ABORT,'Distinct exact owner area attempts required') WHERE
  json_array_length(NEW.attempts_json)!=(SELECT count(DISTINCT j.value) FROM json_each(NEW.attempts_json) j WHERE j.type='text')
  OR json_array_length(NEW.attempts_json)!=(SELECT count(DISTINCT a.asset_id) FROM json_each(NEW.attempts_json) j
   JOIN private_gallery_attempts a ON a.attempt_id=j.value AND a.owner_identity_hash=NEW.owner_hash AND a.site_mode=NEW.site_mode
   JOIN private_gallery_assets s ON s.asset_id=a.asset_id AND s.owner_identity_hash=NEW.owner_hash AND s.site_mode=NEW.site_mode);
 SELECT RAISE(ABORT,'Every batch consent must remain current') WHERE EXISTS(SELECT 1 FROM json_each(NEW.attempts_json) j WHERE
  NOT EXISTS(SELECT 1 FROM private_gallery_current_attempt_permissions p WHERE p.attempt_id=j.value)
  OR EXISTS(SELECT 1 FROM private_gallery_pipeline_closures c WHERE c.attempt_id=j.value));
 SELECT RAISE(ABORT,'Review membership cannot be repointed') WHERE EXISTS(SELECT 1 FROM json_each(NEW.attempts_json) j WHERE
  EXISTS(SELECT 1 FROM private_gallery_batch_members m WHERE m.attempt_id=j.value)
  OR EXISTS(SELECT 1 FROM private_gallery_pipeline_review_intents i WHERE i.attempt_id=j.value)
  OR EXISTS(SELECT 1 FROM private_gallery_owner_jobs q WHERE q.attempt_id=j.value AND q.action IN ('review','publication')));
 SELECT RAISE(ABORT,'Server clock required') WHERE NEW.created_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER private_gallery_batch_single_job_guard BEFORE INSERT ON private_gallery_owner_jobs BEGIN
 SELECT RAISE(ABORT,'Exact batch owns this attempt') WHERE NEW.action IN ('review','publication') AND EXISTS(
  SELECT 1 FROM private_gallery_batch_members WHERE attempt_id=NEW.attempt_id);
 SELECT RAISE(ABORT,'Batch identity already exists') WHERE EXISTS(SELECT 1 FROM private_gallery_batch_jobs WHERE job_id=NEW.job_id);
END;
CREATE TRIGGER private_gallery_batch_single_intent_guard BEFORE INSERT ON private_gallery_pipeline_review_intents BEGIN
 SELECT RAISE(ABORT,'Exact batch owns this attempt') WHERE EXISTS(SELECT 1 FROM private_gallery_batch_members WHERE attempt_id=NEW.attempt_id);
END;
CREATE TRIGGER private_gallery_batch_claim_guard BEFORE INSERT ON private_gallery_batch_claims BEGIN
 SELECT RAISE(ABORT,'Batch claim cannot be replaced') WHERE EXISTS(SELECT 1 FROM private_gallery_batch_claims WHERE job_id=NEW.job_id);
 SELECT RAISE(ABORT,'Another archive operation is still active') WHERE EXISTS(SELECT 1 FROM private_gallery_active_job);
 SELECT RAISE(ABORT,'Fixed protected run reference required') WHERE
  substr(NEW.run_reference,1,62) IS NOT 'https://github.com/johnkevan88888/family-running/actions/runs/'
  OR substr(NEW.run_reference,63,1) NOT GLOB '[1-9]' OR substr(NEW.run_reference,63) GLOB '*[^0-9]*';
 SELECT RAISE(ABORT,'Server clock required') WHERE NEW.created_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER private_gallery_batch_intent_guard BEFORE INSERT ON private_gallery_batch_intents BEGIN
 SELECT RAISE(ABORT,'Active exact batch required') WHERE NOT EXISTS(SELECT 1 FROM private_gallery_active_job WHERE job_id=NEW.job_id AND action='batch-review');
 SELECT RAISE(ABORT,'Batch intent cannot be replaced') WHERE EXISTS(SELECT 1 FROM private_gallery_batch_intents WHERE job_id=NEW.job_id);
 SELECT RAISE(ABORT,'Every verified photo must remain eligible') WHERE EXISTS(SELECT 1 FROM private_gallery_batch_unprepared_members WHERE job_id=NEW.job_id);
 SELECT RAISE(ABORT,'Exact ordered batch items required') WHERE json_extract(NEW.candidate_json,'$.itemIds') IS NOT
  (SELECT json_group_array(public_item_id) FROM (SELECT public_item_id FROM private_gallery_batch_members WHERE job_id=NEW.job_id ORDER BY ordinal))
  OR json_extract(NEW.candidate_json,'$.receipt.itemIds') IS NOT json_extract(NEW.candidate_json,'$.itemIds')
  OR json_extract(NEW.candidate_json,'$.targetRelativePath') IS NOT 'gallery-data/'||(SELECT site_mode FROM private_gallery_batch_jobs WHERE job_id=NEW.job_id)||'.json'
  OR json_extract(NEW.candidate_json,'$.receipt.targetRelativePath') IS NOT json_extract(NEW.candidate_json,'$.targetRelativePath')
  OR json_extract(NEW.candidate_json,'$.receipt.manifestSha256') IS NOT json_extract(NEW.candidate_json,'$.manifestSha256')
  OR json_extract(NEW.candidate_json,'$.receipt.operationId') IS NOT 'promotion_batch_'||replace(substr(NEW.job_id,5),'-','');
 SELECT RAISE(ABORT,'Server clock required') WHERE NEW.created_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER private_gallery_batch_write_guard BEFORE INSERT ON private_gallery_batch_write_admissions BEGIN
 SELECT RAISE(ABORT,'Active exact batch required') WHERE NOT EXISTS(SELECT 1 FROM private_gallery_active_job WHERE job_id=NEW.job_id AND action='batch-review');
 SELECT RAISE(ABORT,'Batch PR POST already admitted or retired') WHERE EXISTS(SELECT 1 FROM private_gallery_batch_write_admissions WHERE job_id=NEW.job_id)
  OR EXISTS(SELECT 1 FROM private_gallery_batch_terminals WHERE job_id=NEW.job_id);
 SELECT RAISE(ABORT,'Every verified photo must remain eligible') WHERE EXISTS(SELECT 1 FROM private_gallery_batch_unprepared_members WHERE job_id=NEW.job_id);
 SELECT RAISE(ABORT,'Server clock required') WHERE NEW.created_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER private_gallery_batch_review_guard BEFORE INSERT ON private_gallery_batch_reviews BEGIN
 SELECT RAISE(ABORT,'Active exact batch required') WHERE NOT EXISTS(SELECT 1 FROM private_gallery_active_job WHERE job_id=NEW.job_id AND action='batch-review');
 SELECT RAISE(ABORT,'Batch review already recorded or retired') WHERE EXISTS(SELECT 1 FROM private_gallery_batch_reviews WHERE job_id=NEW.job_id)
  OR EXISTS(SELECT 1 FROM private_gallery_batch_terminals WHERE job_id=NEW.job_id);
 SELECT RAISE(ABORT,'Every verified photo must remain eligible') WHERE EXISTS(SELECT 1 FROM private_gallery_batch_unprepared_members WHERE job_id=NEW.job_id);
 SELECT RAISE(ABORT,'Exact admitted shared review required') WHERE NOT EXISTS(SELECT 1 FROM private_gallery_batch_write_admissions WHERE job_id=NEW.job_id)
  OR NOT EXISTS(SELECT 1 FROM private_gallery_batch_intents i WHERE i.job_id=NEW.job_id
   AND json_extract(NEW.review_json,'$.itemIds')=json_extract(i.candidate_json,'$.itemIds')
   AND json_extract(NEW.review_json,'$.manifestSha256')=json_extract(i.candidate_json,'$.manifestSha256')
   AND json_extract(NEW.review_json,'$.targetRelativePath')=json_extract(i.candidate_json,'$.targetRelativePath')
   AND json_extract(NEW.review_json,'$.baseSha')=i.base_sha);
 SELECT RAISE(ABORT,'Server clock required') WHERE NEW.created_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER private_gallery_batch_terminal_guard BEFORE INSERT ON private_gallery_batch_terminals BEGIN
 SELECT RAISE(ABORT,'Batch terminal cannot be replaced') WHERE EXISTS(SELECT 1 FROM private_gallery_batch_terminals WHERE job_id=NEW.job_id);
 SELECT RAISE(ABORT,'Every generation must be closed') WHERE EXISTS(SELECT 1 FROM private_gallery_batch_members m WHERE m.job_id=NEW.job_id
  AND NOT EXISTS(SELECT 1 FROM private_gallery_pipeline_closures c WHERE c.attempt_id=m.attempt_id));
 SELECT RAISE(ABORT,'Exact shared terminal required') WHERE NOT EXISTS(SELECT 1 FROM private_gallery_batch_intents i WHERE i.job_id=NEW.job_id
  AND json_extract(NEW.evidence_json,'$.itemIds')=json_extract(i.candidate_json,'$.itemIds')
  AND json_extract(NEW.evidence_json,'$.manifestSha256')=json_extract(i.candidate_json,'$.manifestSha256')
  AND json_extract(NEW.evidence_json,'$.targetRelativePath')=json_extract(i.candidate_json,'$.targetRelativePath')
  AND json_extract(NEW.evidence_json,'$.baseSha')=i.base_sha)
  OR (SELECT count(*) FROM json_each(NEW.evidence_json))!=13
  OR json_extract(NEW.evidence_json,'$.repository') IS NOT 'johnkevan88888/family-running'
  OR json_extract(NEW.evidence_json,'$.baseRef') IS NOT 'main' OR json_extract(NEW.evidence_json,'$.schemaVersion') IS NOT '1.0'
  OR json_extract(NEW.evidence_json,'$.state') IS NULL OR json_extract(NEW.evidence_json,'$.state') NOT IN ('no-pr-created','closed-unmerged','merged-by-owner');
 SELECT RAISE(ABORT,'No-PR must precede every admitted POST') WHERE json_extract(NEW.evidence_json,'$.state')='no-pr-created' AND (
  json_type(NEW.evidence_json,'$.pullRequest') IS NOT 'null' OR EXISTS(SELECT 1 FROM private_gallery_batch_write_admissions WHERE job_id=NEW.job_id)
  OR EXISTS(SELECT 1 FROM private_gallery_batch_reviews WHERE job_id=NEW.job_id));
 SELECT RAISE(ABORT,'Exact terminal branch required') WHERE length(json_extract(NEW.evidence_json,'$.branchRef')) IS NOT 56
  OR substr(json_extract(NEW.evidence_json,'$.branchRef'),1,24) IS NOT 'gallery-media/candidate-'
  OR substr(json_extract(NEW.evidence_json,'$.branchRef'),25) GLOB '*[^0-9a-f]*';
 SELECT RAISE(ABORT,'Positive shared terminal PR evidence required') WHERE json_extract(NEW.evidence_json,'$.state') IN ('closed-unmerged','merged-by-owner') AND (
  json_extract(NEW.evidence_json,'$.pullRequest.state') IS NOT 'closed'
  OR json_type(NEW.evidence_json,'$.pullRequest.number') IS NOT 'integer' OR json_extract(NEW.evidence_json,'$.pullRequest.number')<1
  OR json_extract(NEW.evidence_json,'$.pullRequest.url') IS NOT 'https://github.com/johnkevan88888/family-running/pull/'||json_extract(NEW.evidence_json,'$.pullRequest.number')
  OR length(json_extract(NEW.evidence_json,'$.headSha')) IS NOT 40 OR json_extract(NEW.evidence_json,'$.headSha') GLOB '*[^0-9a-f]*');
 SELECT RAISE(ABORT,'Exact shared merge outcome required') WHERE
  (json_extract(NEW.evidence_json,'$.state')='merged-by-owner' AND (
   length(json_extract(NEW.evidence_json,'$.mergeSha')) IS NOT 40 OR json_extract(NEW.evidence_json,'$.mergeSha') GLOB '*[^0-9a-f]*'
   OR length(json_extract(NEW.evidence_json,'$.mainSha')) IS NOT 40 OR json_extract(NEW.evidence_json,'$.mainSha') GLOB '*[^0-9a-f]*'))
  OR (json_extract(NEW.evidence_json,'$.state')!='merged-by-owner' AND (
   json_type(NEW.evidence_json,'$.mergeSha') IS NOT 'null' OR json_type(NEW.evidence_json,'$.mainSha') IS NOT 'null'));
 SELECT RAISE(ABORT,'Recorded PR cannot change') WHERE EXISTS(SELECT 1 FROM private_gallery_batch_reviews r WHERE r.job_id=NEW.job_id AND (
  json_extract(NEW.evidence_json,'$.headSha') IS NOT json_extract(r.review_json,'$.headSha')
  OR json_extract(NEW.evidence_json,'$.pullRequest.number') IS NOT json_extract(r.review_json,'$.pullRequest.number')));
 SELECT RAISE(ABORT,'Server clock required') WHERE NEW.created_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER private_gallery_batch_manifest_guard BEFORE INSERT ON private_gallery_pipeline_manifest_receipts BEGIN
 SELECT RAISE(ABORT,'Shared batch review still pending') WHERE EXISTS(SELECT 1 FROM private_gallery_batch_members m
  JOIN private_gallery_batch_intents i USING(job_id) WHERE m.attempt_id=NEW.attempt_id
  AND NOT EXISTS(SELECT 1 FROM private_gallery_batch_terminals t WHERE t.job_id=m.job_id));
END;
CREATE TRIGGER private_gallery_batch_completion_guard BEFORE INSERT ON private_gallery_batch_completions BEGIN
 SELECT RAISE(ABORT,'Active exact batch required') WHERE NOT EXISTS(SELECT 1 FROM private_gallery_active_job WHERE job_id=NEW.job_id AND action='batch-review');
 SELECT RAISE(ABORT,'Batch completion cannot be replaced') WHERE EXISTS(SELECT 1 FROM private_gallery_batch_completions WHERE job_id=NEW.job_id);
 SELECT RAISE(ABORT,'Batch is review-only and must remain held until removal') WHERE
  json_extract(NEW.result_json,'$.state') IS NOT 'removed' OR json_type(NEW.result_json,'$.publicationEnabled') IS NOT 'false'
  OR EXISTS(SELECT 1 FROM private_gallery_batch_members m WHERE m.job_id=NEW.job_id AND NOT EXISTS(
   SELECT 1 FROM private_gallery_pipeline_current_removal r WHERE r.attempt_id=m.attempt_id))
  OR EXISTS(SELECT 1 FROM private_gallery_batch_intents i WHERE i.job_id=NEW.job_id AND NOT EXISTS(
   SELECT 1 FROM private_gallery_batch_terminals t WHERE t.job_id=i.job_id));
 SELECT RAISE(ABORT,'Every member needs the same current-main absence proof') WHERE
  length(json_extract(NEW.result_json,'$.mainSha')) IS NOT 40 OR json_extract(NEW.result_json,'$.mainSha') GLOB '*[^0-9a-f]*'
  OR EXISTS(SELECT 1 FROM private_gallery_batch_members m WHERE m.job_id=NEW.job_id AND NOT EXISTS(
   SELECT 1 FROM private_gallery_pipeline_manifest_receipts r WHERE r.attempt_id=m.attempt_id AND r.main_sha=json_extract(NEW.result_json,'$.mainSha')));
 SELECT RAISE(ABORT,'Server clock required') WHERE NEW.created_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
-- Deliberately no batch publication or terminal metadata-purge capability in
-- this review-only bridge. Never erase shared review evidence via a member.
CREATE TRIGGER private_gallery_batch_purge_guard BEFORE INSERT ON private_archive_purge_operations BEGIN
 SELECT RAISE(ABORT,'Shared batch metadata purge is not supported') WHERE EXISTS(SELECT 1 FROM private_gallery_batch_members WHERE asset_id=NEW.asset_id);
END;
CREATE TRIGGER private_gallery_batch_jobs_no_update BEFORE UPDATE ON private_gallery_batch_jobs BEGIN SELECT RAISE(ABORT,'Batch evidence immutable'); END;
CREATE TRIGGER private_gallery_batch_jobs_no_delete BEFORE DELETE ON private_gallery_batch_jobs BEGIN SELECT RAISE(ABORT,'Batch evidence retained'); END;
CREATE TRIGGER private_gallery_batch_claims_no_update BEFORE UPDATE ON private_gallery_batch_claims BEGIN SELECT RAISE(ABORT,'Batch evidence immutable'); END;
CREATE TRIGGER private_gallery_batch_claims_no_delete BEFORE DELETE ON private_gallery_batch_claims BEGIN SELECT RAISE(ABORT,'Batch evidence retained'); END;
CREATE TRIGGER private_gallery_batch_intents_no_update BEFORE UPDATE ON private_gallery_batch_intents BEGIN SELECT RAISE(ABORT,'Batch evidence immutable'); END;
CREATE TRIGGER private_gallery_batch_intents_no_delete BEFORE DELETE ON private_gallery_batch_intents BEGIN SELECT RAISE(ABORT,'Batch evidence retained'); END;
CREATE TRIGGER private_gallery_batch_write_admissions_no_update BEFORE UPDATE ON private_gallery_batch_write_admissions BEGIN SELECT RAISE(ABORT,'Batch evidence immutable'); END;
CREATE TRIGGER private_gallery_batch_write_admissions_no_delete BEFORE DELETE ON private_gallery_batch_write_admissions BEGIN SELECT RAISE(ABORT,'Batch evidence retained'); END;
CREATE TRIGGER private_gallery_batch_reviews_no_update BEFORE UPDATE ON private_gallery_batch_reviews BEGIN SELECT RAISE(ABORT,'Batch evidence immutable'); END;
CREATE TRIGGER private_gallery_batch_reviews_no_delete BEFORE DELETE ON private_gallery_batch_reviews BEGIN SELECT RAISE(ABORT,'Batch evidence retained'); END;
CREATE TRIGGER private_gallery_batch_terminals_no_update BEFORE UPDATE ON private_gallery_batch_terminals BEGIN SELECT RAISE(ABORT,'Batch evidence immutable'); END;
CREATE TRIGGER private_gallery_batch_terminals_no_delete BEFORE DELETE ON private_gallery_batch_terminals BEGIN SELECT RAISE(ABORT,'Batch evidence retained'); END;
CREATE TRIGGER private_gallery_batch_completions_no_update BEFORE UPDATE ON private_gallery_batch_completions BEGIN SELECT RAISE(ABORT,'Batch evidence immutable'); END;
CREATE TRIGGER private_gallery_batch_completions_no_delete BEFORE DELETE ON private_gallery_batch_completions BEGIN SELECT RAISE(ABORT,'Batch evidence retained'); END;
