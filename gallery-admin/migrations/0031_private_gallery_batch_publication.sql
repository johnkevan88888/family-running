-- Forward-only continuation of 0030. An owner may request the separate merge
-- gate for the exact existing shared review; its original non-expiring claim
-- remains held. Positive merge history is not current consent or publication.
CREATE TABLE private_gallery_batch_publication_requests (
 job_id TEXT PRIMARY KEY REFERENCES private_gallery_batch_reviews(job_id),
 owner_hash TEXT NOT NULL CHECK(length(owner_hash)=64 AND owner_hash NOT GLOB '*[^0-9a-f]*'),
 idempotency_key TEXT NOT NULL,
 review_json TEXT NOT NULL CHECK(json_valid(review_json)),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE private_gallery_batch_publications (
 job_id TEXT PRIMARY KEY REFERENCES private_gallery_batch_publication_requests(job_id),
 evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Explicit batch origins, never invented one-photo addition intents/reviews.
-- Kept separately so one member's later removal cannot erase siblings' proof.
CREATE TABLE private_gallery_batch_member_origins (
 attempt_id TEXT PRIMARY KEY REFERENCES private_gallery_attempts(attempt_id),
 job_id TEXT NOT NULL REFERENCES private_gallery_batch_publications(job_id),
 ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 19),
 item_json TEXT NOT NULL CHECK(json_valid(item_json)),
 UNIQUE(job_id,ordinal)
);
CREATE TRIGGER private_gallery_batch_publication_request_guard BEFORE INSERT ON private_gallery_batch_publication_requests BEGIN
 SELECT RAISE(ABORT,'Exact owner-approved active batch review required') WHERE NOT EXISTS(
  SELECT 1 FROM private_gallery_batch_jobs b JOIN private_gallery_batch_reviews r USING(job_id)
  JOIN private_gallery_active_job a USING(job_id)
  WHERE b.job_id=NEW.job_id AND b.owner_hash=NEW.owner_hash AND a.action='batch-review' AND r.review_json=NEW.review_json)
  OR EXISTS(SELECT 1 FROM private_gallery_batch_terminals WHERE job_id=NEW.job_id)
  OR EXISTS(SELECT 1 FROM private_gallery_batch_completions WHERE job_id=NEW.job_id);
 SELECT RAISE(ABORT,'Every verified photo must remain eligible') WHERE EXISTS(
  SELECT 1 FROM private_gallery_batch_unprepared_members WHERE job_id=NEW.job_id);
 SELECT RAISE(ABORT,'Publication request cannot be replaced') WHERE EXISTS(
  SELECT 1 FROM private_gallery_batch_publication_requests WHERE job_id=NEW.job_id);
 SELECT RAISE(ABORT,'Opaque publication request required') WHERE length(NEW.idempotency_key)!=36
  OR substr(NEW.idempotency_key,9,1)!='-' OR substr(NEW.idempotency_key,14,2)!='-4'
  OR substr(NEW.idempotency_key,19,1)!='-' OR substr(NEW.idempotency_key,20,1) NOT IN ('8','9','a','b')
  OR substr(NEW.idempotency_key,24,1)!='-' OR length(replace(NEW.idempotency_key,'-',''))!=32
  OR replace(NEW.idempotency_key,'-','') GLOB '*[^0-9a-f]*';
 SELECT RAISE(ABORT,'Server clock required') WHERE NEW.created_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER private_gallery_batch_publication_guard BEFORE INSERT ON private_gallery_batch_publications BEGIN
 SELECT RAISE(ABORT,'Exact active batch publication request required') WHERE NOT EXISTS(
  SELECT 1 FROM private_gallery_batch_publication_requests p JOIN private_gallery_active_job a USING(job_id)
  WHERE p.job_id=NEW.job_id AND a.action='batch-review');
 SELECT RAISE(ABORT,'Publication history cannot be replaced or reopened') WHERE EXISTS(
  SELECT 1 FROM private_gallery_batch_publications WHERE job_id=NEW.job_id)
  OR EXISTS(SELECT 1 FROM private_gallery_batch_terminals WHERE job_id=NEW.job_id);
 SELECT RAISE(ABORT,'Exact shared merged evidence required') WHERE (SELECT count(*) FROM json_each(NEW.evidence_json))!=13
  OR NOT EXISTS(SELECT 1 FROM private_gallery_batch_intents i JOIN private_gallery_batch_reviews r USING(job_id)
   WHERE i.job_id=NEW.job_id AND json_extract(NEW.evidence_json,'$.schemaVersion')='1.0'
   AND json_extract(NEW.evidence_json,'$.repository')='johnkevan88888/family-running'
   AND json_extract(NEW.evidence_json,'$.baseRef')='main' AND json_extract(NEW.evidence_json,'$.state')='merged-by-owner'
   AND json_extract(NEW.evidence_json,'$.baseSha')=i.base_sha
   AND json_extract(NEW.evidence_json,'$.itemIds')=json_extract(i.candidate_json,'$.itemIds')
   AND json_extract(NEW.evidence_json,'$.targetRelativePath')=json_extract(i.candidate_json,'$.targetRelativePath')
   AND json_extract(NEW.evidence_json,'$.manifestSha256')=json_extract(i.candidate_json,'$.manifestSha256')
   AND json_extract(NEW.evidence_json,'$.branchRef')=json_extract(r.review_json,'$.branchRef')
   AND json_extract(NEW.evidence_json,'$.headSha')=json_extract(r.review_json,'$.headSha')
   AND json_extract(NEW.evidence_json,'$.pullRequest.number')=json_extract(r.review_json,'$.pullRequest.number')
   AND json_extract(NEW.evidence_json,'$.pullRequest.url')=json_extract(r.review_json,'$.pullRequest.url')
   AND json_extract(NEW.evidence_json,'$.pullRequest.state')='closed')
  OR (SELECT count(*) FROM json_each(NEW.evidence_json,'$.pullRequest'))!=3
  OR json_type(NEW.evidence_json,'$.pullRequest.number') IS NOT 'integer' OR json_extract(NEW.evidence_json,'$.pullRequest.number')<1
  OR json_extract(NEW.evidence_json,'$.pullRequest.url') IS NOT 'https://github.com/johnkevan88888/family-running/pull/'||json_extract(NEW.evidence_json,'$.pullRequest.number')
  OR length(json_extract(NEW.evidence_json,'$.headSha')) IS NOT 40 OR json_extract(NEW.evidence_json,'$.headSha') GLOB '*[^0-9a-f]*'
  OR length(json_extract(NEW.evidence_json,'$.branchRef')) IS NOT 56 OR substr(json_extract(NEW.evidence_json,'$.branchRef'),1,24) IS NOT 'gallery-media/candidate-'
  OR substr(json_extract(NEW.evidence_json,'$.branchRef'),25) GLOB '*[^0-9a-f]*'
  OR length(json_extract(NEW.evidence_json,'$.mergeSha')) IS NOT 40 OR json_extract(NEW.evidence_json,'$.mergeSha') GLOB '*[^0-9a-f]*'
  OR length(json_extract(NEW.evidence_json,'$.mainSha')) IS NOT 40 OR json_extract(NEW.evidence_json,'$.mainSha') GLOB '*[^0-9a-f]*';
 -- Do not require current eligibility here: a revocation racing an owner merge
 -- must preserve positive history for removal, never report successful consent.
 SELECT RAISE(ABORT,'Server clock required') WHERE NEW.created_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER private_gallery_batch_publication_project AFTER INSERT ON private_gallery_batch_publications BEGIN
 INSERT INTO private_gallery_batch_member_origins(attempt_id,job_id,ordinal,item_json)
  SELECT m.attempt_id,m.job_id,m.ordinal,item.value FROM private_gallery_batch_members m
  JOIN private_gallery_batch_intents i USING(job_id)
  JOIN json_each(json_extract(i.candidate_json,'$.manifestText'),'$.items') item
  ON json_extract(item.value,'$.id')=m.public_item_id WHERE m.job_id=NEW.job_id;
 SELECT RAISE(ABORT,'Every exact member origin required') WHERE
  (SELECT count(*) FROM private_gallery_batch_member_origins WHERE job_id=NEW.job_id) !=
  (SELECT json_array_length(attempts_json) FROM private_gallery_batch_jobs WHERE job_id=NEW.job_id);
END;
CREATE TRIGGER private_gallery_batch_member_origin_guard BEFORE INSERT ON private_gallery_batch_member_origins BEGIN
 SELECT RAISE(ABORT,'Exact recorded shared member origin required') WHERE NOT EXISTS(
  SELECT 1 FROM private_gallery_batch_members m JOIN private_gallery_batch_publications p USING(job_id)
  JOIN private_gallery_batch_intents i USING(job_id)
  JOIN json_each(json_extract(i.candidate_json,'$.manifestText'),'$.items') item
  ON json_extract(item.value,'$.id')=m.public_item_id
  WHERE m.attempt_id=NEW.attempt_id AND m.job_id=NEW.job_id AND m.ordinal=NEW.ordinal AND item.value=NEW.item_json);
 SELECT RAISE(ABORT,'Batch member origin cannot be replaced') WHERE EXISTS(
  SELECT 1 FROM private_gallery_batch_member_origins WHERE attempt_id=NEW.attempt_id);
END;
DROP TRIGGER private_gallery_batch_completion_guard;
CREATE TRIGGER private_gallery_batch_completion_guard BEFORE INSERT ON private_gallery_batch_completions BEGIN
 SELECT RAISE(ABORT,'Active exact batch required') WHERE NOT EXISTS(SELECT 1 FROM private_gallery_active_job WHERE job_id=NEW.job_id AND action='batch-review');
 SELECT RAISE(ABORT,'Batch completion cannot be replaced') WHERE EXISTS(SELECT 1 FROM private_gallery_batch_completions WHERE job_id=NEW.job_id);
 SELECT RAISE(ABORT,'Unknown batch completion') WHERE json_extract(NEW.result_json,'$.state') IS NULL
  OR json_extract(NEW.result_json,'$.state') NOT IN ('removed','publication-observed') OR json_type(NEW.result_json,'$.publicationEnabled') IS NOT 'false';
 SELECT RAISE(ABORT,'Every member removal must be complete') WHERE json_extract(NEW.result_json,'$.state')='removed' AND (
  EXISTS(SELECT 1 FROM private_gallery_batch_members m WHERE m.job_id=NEW.job_id AND NOT EXISTS(
   SELECT 1 FROM private_gallery_pipeline_current_removal r WHERE r.attempt_id=m.attempt_id))
  OR EXISTS(SELECT 1 FROM private_gallery_batch_intents i WHERE i.job_id=NEW.job_id AND NOT EXISTS(
   SELECT 1 FROM private_gallery_batch_terminals t WHERE t.job_id=i.job_id) AND NOT EXISTS(
   SELECT 1 FROM private_gallery_batch_publications p WHERE p.job_id=i.job_id))
  OR length(json_extract(NEW.result_json,'$.mainSha')) IS NOT 40 OR json_extract(NEW.result_json,'$.mainSha') GLOB '*[^0-9a-f]*'
  OR EXISTS(SELECT 1 FROM private_gallery_batch_members m WHERE m.job_id=NEW.job_id AND NOT EXISTS(
   SELECT 1 FROM private_gallery_pipeline_manifest_receipts r WHERE r.attempt_id=m.attempt_id AND r.main_sha=json_extract(NEW.result_json,'$.mainSha'))));
 SELECT RAISE(ABORT,'Every exact member must remain eligible for publication') WHERE json_extract(NEW.result_json,'$.state')='publication-observed' AND (
  EXISTS(SELECT 1 FROM private_gallery_batch_unprepared_members WHERE job_id=NEW.job_id)
  OR (SELECT count(*) FROM private_gallery_batch_member_origins WHERE job_id=NEW.job_id) !=
   (SELECT json_array_length(attempts_json) FROM private_gallery_batch_jobs WHERE job_id=NEW.job_id)
  OR NOT EXISTS(SELECT 1 FROM private_gallery_batch_publications p WHERE p.job_id=NEW.job_id
   AND json_remove(json_extract(NEW.result_json,'$.evidence'),'$.mainSha')=json_remove(p.evidence_json,'$.mainSha'))
  OR length(json_extract(NEW.result_json,'$.evidence.mainSha')) IS NOT 40 OR json_extract(NEW.result_json,'$.evidence.mainSha') GLOB '*[^0-9a-f]*');
 SELECT RAISE(ABORT,'Server clock required') WHERE NEW.created_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
DROP TRIGGER private_gallery_batch_manifest_guard;
CREATE TRIGGER private_gallery_batch_manifest_guard BEFORE INSERT ON private_gallery_pipeline_manifest_receipts BEGIN
 SELECT RAISE(ABORT,'Shared batch review still pending') WHERE EXISTS(SELECT 1 FROM private_gallery_batch_members m
  JOIN private_gallery_batch_intents i USING(job_id) WHERE m.attempt_id=NEW.attempt_id
  AND NOT EXISTS(SELECT 1 FROM private_gallery_batch_terminals t WHERE t.job_id=m.job_id)
  AND NOT EXISTS(SELECT 1 FROM private_gallery_batch_member_origins o WHERE o.attempt_id=m.attempt_id));
END;
DROP TRIGGER private_gallery_removal_intent_target;
CREATE TRIGGER private_gallery_removal_intent_target BEFORE INSERT ON private_gallery_manifest_removal_intents BEGIN
 SELECT RAISE(ABORT,'Exact historical public item required') WHERE NOT EXISTS(
  SELECT 1 FROM private_gallery_attempts a JOIN private_gallery_pipeline_review_intents i USING(attempt_id)
  JOIN json_each(json_extract(i.candidate_json,'$.manifestText'),'$.items') item
  WHERE a.attempt_id=NEW.attempt_id AND json_extract(item.value,'$.id')=a.public_item_id
   AND json_extract(NEW.removal_json,'$.operationId')=NEW.operation_id
   AND json_extract(NEW.removal_json,'$.targetRelativePath')='gallery-data/'||a.site_mode||'.json'
   AND json_extract(NEW.removal_json,'$.item') IS item.value)
 AND NOT EXISTS(SELECT 1 FROM private_gallery_batch_member_origins o JOIN private_gallery_attempts a USING(attempt_id)
  WHERE o.attempt_id=NEW.attempt_id AND json_extract(NEW.removal_json,'$.operationId')=NEW.operation_id
   AND json_extract(NEW.removal_json,'$.targetRelativePath')='gallery-data/'||a.site_mode||'.json'
   AND json_extract(NEW.removal_json,'$.item') IS o.item_json);
END;
CREATE TRIGGER private_gallery_batch_publication_requests_no_update BEFORE UPDATE ON private_gallery_batch_publication_requests BEGIN SELECT RAISE(ABORT,'Batch evidence immutable'); END;
CREATE TRIGGER private_gallery_batch_publication_requests_no_delete BEFORE DELETE ON private_gallery_batch_publication_requests BEGIN SELECT RAISE(ABORT,'Batch evidence retained'); END;
CREATE TRIGGER private_gallery_batch_publications_no_update BEFORE UPDATE ON private_gallery_batch_publications BEGIN SELECT RAISE(ABORT,'Batch evidence immutable'); END;
CREATE TRIGGER private_gallery_batch_publications_no_delete BEFORE DELETE ON private_gallery_batch_publications BEGIN SELECT RAISE(ABORT,'Batch evidence retained'); END;
CREATE TRIGGER private_gallery_batch_member_origins_no_update BEFORE UPDATE ON private_gallery_batch_member_origins BEGIN SELECT RAISE(ABORT,'Batch evidence immutable'); END;
CREATE TRIGGER private_gallery_batch_member_origins_no_delete BEFORE DELETE ON private_gallery_batch_member_origins BEGIN SELECT RAISE(ABORT,'Batch evidence retained'); END;
-- SQL arbitrates a late successful publication response against stale workflow
-- cleanup. Privacy events retain unconditional priority; only service-generated
-- cancellation/failure needs the later exact owner-approved removal job.
CREATE TRIGGER private_gallery_batch_published_close_guard BEFORE INSERT ON private_gallery_pipeline_closures
WHEN NEW.reason IN ('cancelled','failed') BEGIN
 SELECT RAISE(ABORT,'Published batch member requires exact removal job') WHERE EXISTS(
  SELECT 1 FROM private_gallery_batch_members m JOIN private_gallery_batch_completions c USING(job_id)
  WHERE m.attempt_id=NEW.attempt_id AND json_extract(c.result_json,'$.state')='publication-observed')
 AND NOT EXISTS(SELECT 1 FROM private_gallery_attempts a JOIN private_gallery_active_job j ON j.asset_id=a.asset_id
  WHERE a.attempt_id=NEW.attempt_id AND j.action='removal' AND j.owner_hash=a.owner_identity_hash AND j.site_mode=a.site_mode);
END;

-- Shared raw JSON is never left behind after reporting a member metadata purge.
-- All connected members need their own terminal deletion + exact owner purge
-- request. A single non-expiring leader claim coordinates ONE atomic statement;
-- it grants no new claim or implicit deletion consent for any sibling.
CREATE TABLE private_gallery_retired_batch_jobs (
 job_hash TEXT PRIMARY KEY CHECK(length(job_hash)=64 AND job_hash NOT GLOB '*[^0-9a-f]*'),
 group_proof_hash TEXT NOT NULL CHECK(length(group_proof_hash)=64 AND group_proof_hash NOT GLOB '*[^0-9a-f]*')
);
CREATE TABLE private_gallery_batch_purge_operations (
 coordinator_job_id TEXT PRIMARY KEY,
 owner_hash TEXT NOT NULL CHECK(length(owner_hash)=64 AND owner_hash NOT GLOB '*[^0-9a-f]*'),
 batch_job_ids_json TEXT NOT NULL CHECK(json_valid(batch_job_ids_json) AND json_type(batch_job_ids_json)='array' AND json_array_length(batch_job_ids_json) BETWEEN 1 AND 1000),
 grants_json TEXT NOT NULL CHECK(json_valid(grants_json) AND json_type(grants_json)='array' AND json_array_length(grants_json) BETWEEN 1 AND 1000),
 group_proof_hash TEXT NOT NULL CHECK(length(group_proof_hash)=64 AND group_proof_hash NOT GLOB '*[^0-9a-f]*')
);
CREATE TRIGGER private_gallery_batch_group_purge_guard BEFORE INSERT ON private_gallery_batch_purge_operations BEGIN
 SELECT RAISE(ABORT,'One exact active owner purge coordinator required') WHERE NOT EXISTS(
  SELECT 1 FROM private_gallery_active_job j JOIN json_each(NEW.grants_json) g ON json_extract(g.value,'$.jobId')=j.job_id
  WHERE j.job_id=NEW.coordinator_job_id AND j.action='purge' AND j.owner_hash=NEW.owner_hash
   AND j.asset_id=json_extract(g.value,'$.assetId') AND j.expected_proof_hash=json_extract(g.value,'$.proofHash')
   AND j.purge_scope_hash=json_extract(g.value,'$.scopeHash'));
 SELECT RAISE(ABORT,'Every distinct member needs exact own queued owner confirmation') WHERE
  json_array_length(NEW.grants_json)!=(SELECT count(DISTINCT json_extract(value,'$.assetId')) FROM json_each(NEW.grants_json))
  OR EXISTS(SELECT 1 FROM json_each(NEW.grants_json) g WHERE (SELECT count(*) FROM json_each(g.value))!=12
   OR json_extract(g.value,'$.mainSha') IS NOT json_extract(NEW.grants_json,'$[0].mainSha')
   OR json_extract(g.value,'$.epochHash') IS NOT json_extract(NEW.grants_json,'$[0].epochHash')
   OR json_extract(g.value,'$.manifestHash') IS NOT json_extract(NEW.grants_json,'$[0].manifestHash')
   OR NOT EXISTS(SELECT 1 FROM private_gallery_owner_jobs j JOIN private_gallery_assets a ON a.asset_id=j.asset_id
    WHERE j.job_id=json_extract(g.value,'$.jobId') AND j.action='purge' AND j.owner_hash=NEW.owner_hash
     AND j.site_mode=(SELECT site_mode FROM private_gallery_active_job WHERE job_id=NEW.coordinator_job_id)
     AND j.asset_id=json_extract(g.value,'$.assetId') AND a.owner_identity_hash=j.owner_hash AND a.site_mode=j.site_mode
     AND j.expected_proof_hash=json_extract(g.value,'$.proofHash') AND j.purge_scope_hash=json_extract(g.value,'$.scopeHash')
     AND NOT EXISTS(SELECT 1 FROM private_gallery_job_completions c WHERE c.job_id=j.job_id)
     AND (j.job_id=NEW.coordinator_job_id OR NOT EXISTS(SELECT 1 FROM private_gallery_job_claims c WHERE c.job_id=j.job_id))));
 SELECT RAISE(ABORT,'Exact complete connected batch group required') WHERE
  json_array_length(NEW.batch_job_ids_json)!=(SELECT count(DISTINCT value) FROM json_each(NEW.batch_job_ids_json))
  OR EXISTS(SELECT 1 FROM json_each(NEW.batch_job_ids_json) k WHERE NOT EXISTS(
   SELECT 1 FROM private_gallery_batch_jobs b JOIN private_gallery_batch_completions c USING(job_id)
   WHERE b.job_id=k.value AND b.owner_hash=NEW.owner_hash
    AND b.site_mode=(SELECT site_mode FROM private_gallery_active_job WHERE job_id=NEW.coordinator_job_id)))
  OR EXISTS(SELECT 1 FROM private_gallery_batch_members m JOIN json_each(NEW.batch_job_ids_json) k ON k.value=m.job_id
   WHERE NOT EXISTS(SELECT 1 FROM json_each(NEW.grants_json) g WHERE json_extract(g.value,'$.assetId')=m.asset_id))
  OR EXISTS(SELECT 1 FROM json_each(NEW.grants_json) g WHERE NOT EXISTS(
   SELECT 1 FROM private_gallery_batch_members m JOIN json_each(NEW.batch_job_ids_json) k ON k.value=m.job_id
   WHERE m.asset_id=json_extract(g.value,'$.assetId')))
  OR EXISTS(SELECT 1 FROM private_gallery_batch_members m JOIN json_each(NEW.grants_json) g ON json_extract(g.value,'$.assetId')=m.asset_id
   WHERE NOT EXISTS(SELECT 1 FROM json_each(NEW.batch_job_ids_json) k WHERE k.value=m.job_id));
 SELECT RAISE(ABORT,'Unrelated groups cannot join a purge coordinator') WHERE EXISTS(
  WITH RECURSIVE connected(asset_id) AS (
   SELECT asset_id FROM private_gallery_active_job WHERE job_id=NEW.coordinator_job_id
   UNION SELECT sibling.asset_id FROM connected c JOIN private_gallery_batch_members member ON member.asset_id=c.asset_id
    JOIN private_gallery_batch_members sibling ON sibling.job_id=member.job_id LIMIT 1001)
  SELECT 1 FROM json_each(NEW.grants_json) g WHERE NOT EXISTS(
   SELECT 1 FROM connected c WHERE c.asset_id=json_extract(g.value,'$.assetId')));
END;
DROP TRIGGER private_gallery_batch_purge_guard;
CREATE TRIGGER private_gallery_batch_purge_guard BEFORE INSERT ON private_archive_purge_operations BEGIN
 SELECT RAISE(ABORT,'Shared batch needs exact coordinated retirement') WHERE EXISTS(
  SELECT 1 FROM private_gallery_batch_members WHERE asset_id=NEW.asset_id)
  OR EXISTS(SELECT 1 FROM private_gallery_batch_member_origins o JOIN private_gallery_attempts a USING(attempt_id) WHERE a.asset_id=NEW.asset_id);
END;
DROP TRIGGER private_gallery_coordinated_purge_guard;
CREATE TRIGGER private_gallery_coordinated_purge_guard BEFORE INSERT ON private_archive_purge_operations BEGIN
 SELECT RAISE(ABORT,'Exact owner-confirmed active purge job required') WHERE NOT EXISTS(
  SELECT 1 FROM private_gallery_active_job j WHERE j.asset_id=NEW.asset_id AND j.owner_hash=NEW.owner_hash
   AND j.action='purge' AND j.expected_proof_hash=NEW.proof_hash AND j.purge_scope_hash=NEW.scope_hash)
 AND NOT EXISTS(SELECT 1 FROM private_gallery_batch_purge_operations p JOIN json_each(p.grants_json) g
  WHERE p.owner_hash=NEW.owner_hash AND json_extract(g.value,'$.assetId')=NEW.asset_id
   AND json_extract(g.value,'$.ownerHash')=NEW.owner_hash AND json_extract(g.value,'$.epochHash')=NEW.epoch_hash
   AND json_extract(g.value,'$.mainSha')=NEW.main_sha AND json_extract(g.value,'$.manifestHash')=NEW.manifest_hash
   AND json_extract(g.value,'$.snapshotJson')=NEW.snapshot_json AND json_extract(g.value,'$.retirementsJson')=NEW.retirements_json
   AND json_extract(g.value,'$.assetHash')=NEW.asset_id_hash AND json_extract(g.value,'$.reservationHash')=NEW.reservation_key_hash
   AND json_extract(g.value,'$.scopeHash')=NEW.scope_hash AND json_extract(g.value,'$.proofHash')=NEW.proof_hash);
END;
CREATE TRIGGER private_gallery_batch_group_purge_atomic AFTER INSERT ON private_gallery_batch_purge_operations BEGIN
 INSERT INTO private_gallery_retired_batch_jobs(job_hash,group_proof_hash)
  SELECT b.job_hash,NEW.group_proof_hash FROM private_gallery_batch_jobs b JOIN json_each(NEW.batch_job_ids_json) j ON j.value=b.job_id;
 DELETE FROM private_gallery_batch_member_origins WHERE job_id IN(SELECT value FROM json_each(NEW.batch_job_ids_json));
 DELETE FROM private_gallery_batch_publications WHERE job_id IN(SELECT value FROM json_each(NEW.batch_job_ids_json));
 DELETE FROM private_gallery_batch_publication_requests WHERE job_id IN(SELECT value FROM json_each(NEW.batch_job_ids_json));
 DELETE FROM private_gallery_batch_completions WHERE job_id IN(SELECT value FROM json_each(NEW.batch_job_ids_json));
 DELETE FROM private_gallery_batch_terminals WHERE job_id IN(SELECT value FROM json_each(NEW.batch_job_ids_json));
 DELETE FROM private_gallery_batch_reviews WHERE job_id IN(SELECT value FROM json_each(NEW.batch_job_ids_json));
 DELETE FROM private_gallery_batch_write_admissions WHERE job_id IN(SELECT value FROM json_each(NEW.batch_job_ids_json));
 DELETE FROM private_gallery_batch_intents WHERE job_id IN(SELECT value FROM json_each(NEW.batch_job_ids_json));
 DELETE FROM private_gallery_batch_claims WHERE job_id IN(SELECT value FROM json_each(NEW.batch_job_ids_json));
 DELETE FROM private_gallery_batch_jobs WHERE job_id IN(SELECT value FROM json_each(NEW.batch_job_ids_json));
 INSERT INTO private_archive_purge_operations(asset_id,owner_hash,epoch_hash,main_sha,manifest_hash,snapshot_json,retirements_json,
  asset_id_hash,reservation_key_hash,scope_hash,proof_hash)
  SELECT json_extract(value,'$.assetId'),json_extract(value,'$.ownerHash'),json_extract(value,'$.epochHash'),json_extract(value,'$.mainSha'),
   json_extract(value,'$.manifestHash'),json_extract(value,'$.snapshotJson'),json_extract(value,'$.retirementsJson'),
   json_extract(value,'$.assetHash'),json_extract(value,'$.reservationHash'),json_extract(value,'$.scopeHash'),json_extract(value,'$.proofHash')
  FROM json_each(NEW.grants_json);
 DELETE FROM private_gallery_batch_purge_operations WHERE coordinator_job_id=NEW.coordinator_job_id;
END;
CREATE TRIGGER private_gallery_batch_group_purge_no_update BEFORE UPDATE ON private_gallery_batch_purge_operations BEGIN SELECT RAISE(ABORT,'Group purge immutable'); END;
CREATE TRIGGER private_gallery_batch_group_purge_no_delete BEFORE DELETE ON private_gallery_batch_purge_operations BEGIN
 SELECT RAISE(ABORT,'Group purge did not complete atomically') WHERE
  EXISTS(SELECT 1 FROM json_each(OLD.batch_job_ids_json) j JOIN private_gallery_batch_jobs b ON b.job_id=j.value)
  OR EXISTS(SELECT 1 FROM json_each(OLD.grants_json) g WHERE EXISTS(SELECT 1 FROM private_gallery_assets a WHERE a.asset_id=json_extract(g.value,'$.assetId'))
   OR NOT EXISTS(SELECT 1 FROM private_archive_purge_receipts r WHERE r.asset_id_hash=json_extract(g.value,'$.assetHash')
    AND r.scope_hash=json_extract(g.value,'$.scopeHash') AND r.proof_hash=json_extract(g.value,'$.proofHash')));
END;
CREATE TRIGGER private_gallery_retired_batch_guard BEFORE INSERT ON private_gallery_retired_batch_jobs BEGIN
 SELECT RAISE(ABORT,'Exact coordinated group retirement required') WHERE NOT EXISTS(
  SELECT 1 FROM private_gallery_batch_purge_operations p JOIN json_each(p.batch_job_ids_json) j
  JOIN private_gallery_batch_jobs b ON b.job_id=j.value WHERE b.job_hash=NEW.job_hash AND p.group_proof_hash=NEW.group_proof_hash);
END;
CREATE TRIGGER private_gallery_retired_batch_no_update BEFORE UPDATE ON private_gallery_retired_batch_jobs BEGIN SELECT RAISE(ABORT,'Retired batch immutable'); END;
CREATE TRIGGER private_gallery_retired_batch_no_delete BEFORE DELETE ON private_gallery_retired_batch_jobs BEGIN SELECT RAISE(ABORT,'Retired batch immutable'); END;
CREATE TRIGGER private_gallery_batch_retired_identity_guard BEFORE INSERT ON private_gallery_batch_jobs BEGIN
 SELECT RAISE(ABORT,'Retired job identity cannot be reused') WHERE EXISTS(SELECT 1 FROM private_gallery_retired_batch_jobs WHERE job_hash=NEW.job_hash);
END;
CREATE TRIGGER private_gallery_single_retired_batch_identity_guard BEFORE INSERT ON private_gallery_owner_jobs BEGIN
 SELECT RAISE(ABORT,'Retired job identity cannot be reused') WHERE EXISTS(SELECT 1 FROM private_gallery_retired_batch_jobs WHERE job_hash=NEW.job_hash);
END;

DROP TRIGGER private_gallery_batch_jobs_no_delete;
CREATE TRIGGER private_gallery_batch_jobs_no_delete BEFORE DELETE ON private_gallery_batch_jobs BEGIN
 SELECT RAISE(ABORT,'Batch evidence retained') WHERE NOT EXISTS(
  SELECT 1 FROM private_gallery_batch_purge_operations p JOIN json_each(p.batch_job_ids_json) j WHERE j.value=OLD.job_id);
END;
DROP TRIGGER private_gallery_batch_claims_no_delete;
CREATE TRIGGER private_gallery_batch_claims_no_delete BEFORE DELETE ON private_gallery_batch_claims BEGIN
 SELECT RAISE(ABORT,'Batch evidence retained') WHERE NOT EXISTS(
  SELECT 1 FROM private_gallery_batch_purge_operations p JOIN json_each(p.batch_job_ids_json) j WHERE j.value=OLD.job_id);
END;
DROP TRIGGER private_gallery_batch_intents_no_delete;
CREATE TRIGGER private_gallery_batch_intents_no_delete BEFORE DELETE ON private_gallery_batch_intents BEGIN
 SELECT RAISE(ABORT,'Batch evidence retained') WHERE NOT EXISTS(
  SELECT 1 FROM private_gallery_batch_purge_operations p JOIN json_each(p.batch_job_ids_json) j WHERE j.value=OLD.job_id);
END;
DROP TRIGGER private_gallery_batch_write_admissions_no_delete;
CREATE TRIGGER private_gallery_batch_write_admissions_no_delete BEFORE DELETE ON private_gallery_batch_write_admissions BEGIN
 SELECT RAISE(ABORT,'Batch evidence retained') WHERE NOT EXISTS(
  SELECT 1 FROM private_gallery_batch_purge_operations p JOIN json_each(p.batch_job_ids_json) j WHERE j.value=OLD.job_id);
END;
DROP TRIGGER private_gallery_batch_reviews_no_delete;
CREATE TRIGGER private_gallery_batch_reviews_no_delete BEFORE DELETE ON private_gallery_batch_reviews BEGIN
 SELECT RAISE(ABORT,'Batch evidence retained') WHERE NOT EXISTS(
  SELECT 1 FROM private_gallery_batch_purge_operations p JOIN json_each(p.batch_job_ids_json) j WHERE j.value=OLD.job_id);
END;
DROP TRIGGER private_gallery_batch_terminals_no_delete;
CREATE TRIGGER private_gallery_batch_terminals_no_delete BEFORE DELETE ON private_gallery_batch_terminals BEGIN
 SELECT RAISE(ABORT,'Batch evidence retained') WHERE NOT EXISTS(
  SELECT 1 FROM private_gallery_batch_purge_operations p JOIN json_each(p.batch_job_ids_json) j WHERE j.value=OLD.job_id);
END;
DROP TRIGGER private_gallery_batch_completions_no_delete;
CREATE TRIGGER private_gallery_batch_completions_no_delete BEFORE DELETE ON private_gallery_batch_completions BEGIN
 SELECT RAISE(ABORT,'Batch evidence retained') WHERE NOT EXISTS(
  SELECT 1 FROM private_gallery_batch_purge_operations p JOIN json_each(p.batch_job_ids_json) j WHERE j.value=OLD.job_id);
END;
DROP TRIGGER private_gallery_batch_publication_requests_no_delete;
CREATE TRIGGER private_gallery_batch_publication_requests_no_delete BEFORE DELETE ON private_gallery_batch_publication_requests BEGIN
 SELECT RAISE(ABORT,'Batch evidence retained') WHERE NOT EXISTS(
  SELECT 1 FROM private_gallery_batch_purge_operations p JOIN json_each(p.batch_job_ids_json) j WHERE j.value=OLD.job_id);
END;
DROP TRIGGER private_gallery_batch_publications_no_delete;
CREATE TRIGGER private_gallery_batch_publications_no_delete BEFORE DELETE ON private_gallery_batch_publications BEGIN
 SELECT RAISE(ABORT,'Batch evidence retained') WHERE NOT EXISTS(
  SELECT 1 FROM private_gallery_batch_purge_operations p JOIN json_each(p.batch_job_ids_json) j WHERE j.value=OLD.job_id);
END;
DROP TRIGGER private_gallery_batch_member_origins_no_delete;
CREATE TRIGGER private_gallery_batch_member_origins_no_delete BEFORE DELETE ON private_gallery_batch_member_origins BEGIN
 SELECT RAISE(ABORT,'Batch evidence retained') WHERE NOT EXISTS(
  SELECT 1 FROM private_gallery_batch_purge_operations p JOIN json_each(p.batch_job_ids_json) j WHERE j.value=OLD.job_id);
END;
