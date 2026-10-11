-- Owner-created jobs, not workflow inputs, select the asset/action/area. Claims
-- serialize ALL archive review, recovery, publication preparation and purge.
-- No timeout releases a claim: uncertain external work must be reconciled.
CREATE TABLE private_gallery_owner_jobs (
 job_id TEXT PRIMARY KEY NOT NULL,
 job_hash TEXT UNIQUE NOT NULL CHECK(length(job_hash)=64 AND job_hash NOT GLOB '*[^0-9a-f]*'),
 asset_id TEXT NOT NULL REFERENCES private_gallery_assets(asset_id),
 owner_hash TEXT NOT NULL,
 site_mode TEXT NOT NULL CHECK(site_mode IN ('family','everyone')),
 action TEXT NOT NULL CHECK(action IN ('review','removal','publication','purge-inspect','purge')),
 attempt_id TEXT REFERENCES private_gallery_attempts(attempt_id),
 idempotency_key TEXT NOT NULL,
 expected_proof_hash TEXT,
 purge_key TEXT,
 purge_scope_hash TEXT,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(owner_hash,site_mode,idempotency_key)
);
CREATE TABLE private_gallery_job_claims (
 job_id TEXT PRIMARY KEY REFERENCES private_gallery_owner_jobs(job_id),
 run_reference TEXT NOT NULL,
 run_hash TEXT NOT NULL CHECK(length(run_hash)=64 AND run_hash NOT GLOB '*[^0-9a-f]*'),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE private_gallery_job_completions (
 job_id TEXT PRIMARY KEY REFERENCES private_gallery_job_claims(job_id),
 state TEXT NOT NULL CHECK(state IN ('unmerged-review','unmerged-removal-review','removed','publication-observed','publication-revoked','purge-eligible')),
 result_json TEXT NOT NULL CHECK(json_valid(result_json)),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE private_gallery_retired_jobs (
 job_hash TEXT PRIMARY KEY NOT NULL CHECK(length(job_hash)=64 AND job_hash NOT GLOB '*[^0-9a-f]*'),
 run_hash TEXT NOT NULL CHECK(length(run_hash)=64 AND run_hash NOT GLOB '*[^0-9a-f]*'),
 proof_hash TEXT NOT NULL CHECK(length(proof_hash)=64 AND proof_hash NOT GLOB '*[^0-9a-f]*')
);
CREATE VIEW private_gallery_active_job AS SELECT j.*,c.run_reference FROM private_gallery_owner_jobs j
 JOIN private_gallery_job_claims c USING(job_id) LEFT JOIN private_gallery_job_completions d USING(job_id) WHERE d.job_id IS NULL;
CREATE TRIGGER private_gallery_owner_job_guard BEFORE INSERT ON private_gallery_owner_jobs BEGIN
 SELECT RAISE(ABORT,'Exact owner/area/asset required') WHERE NOT EXISTS(
  SELECT 1 FROM private_gallery_assets WHERE asset_id=NEW.asset_id AND owner_identity_hash=NEW.owner_hash AND site_mode=NEW.site_mode);
 SELECT RAISE(ABORT,'Owner request cannot be replaced') WHERE EXISTS(SELECT 1 FROM private_gallery_owner_jobs
  WHERE job_id=NEW.job_id OR (owner_hash=NEW.owner_hash AND site_mode=NEW.site_mode AND idempotency_key=NEW.idempotency_key));
 SELECT RAISE(ABORT,'Exact attempt required') WHERE NEW.attempt_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM private_gallery_attempts WHERE attempt_id=NEW.attempt_id AND asset_id=NEW.asset_id AND owner_identity_hash=NEW.owner_hash AND site_mode=NEW.site_mode);
 SELECT RAISE(ABORT,'Review/publication requires current attempt') WHERE NEW.action IN ('review','publication') AND (
  NEW.attempt_id IS NULL OR NOT EXISTS(SELECT 1 FROM private_gallery_current_attempt_permissions WHERE attempt_id=NEW.attempt_id)
  OR EXISTS(SELECT 1 FROM private_gallery_pipeline_closures WHERE attempt_id=NEW.attempt_id));
 SELECT RAISE(ABORT,'Publication requires its recorded review') WHERE NEW.action='publication' AND NOT EXISTS(
  SELECT 1 FROM private_gallery_pipeline_reviews WHERE attempt_id=NEW.attempt_id);
 SELECT RAISE(ABORT,'Purge requires terminal original deletion') WHERE NEW.action IN ('purge-inspect','purge') AND NOT EXISTS(
  SELECT 1 FROM private_archive_purge_snapshots WHERE asset_id=NEW.asset_id);
 SELECT RAISE(ABORT,'Exact purge confirmation required') WHERE (NEW.action='purge' AND (
  length(NEW.expected_proof_hash) IS NOT 64 OR NEW.expected_proof_hash GLOB '*[^0-9a-f]*' OR NEW.purge_key IS NULL
  OR length(NEW.purge_scope_hash) IS NOT 64 OR NEW.purge_scope_hash GLOB '*[^0-9a-f]*'))
  OR (NEW.action!='purge' AND (NEW.expected_proof_hash IS NOT NULL OR NEW.purge_key IS NOT NULL OR NEW.purge_scope_hash IS NOT NULL));
 SELECT RAISE(ABORT,'Server clock required') WHERE NEW.created_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER private_gallery_job_claim_guard BEFORE INSERT ON private_gallery_job_claims BEGIN
 SELECT RAISE(ABORT,'Claim cannot be replaced') WHERE EXISTS(SELECT 1 FROM private_gallery_job_claims WHERE job_id=NEW.job_id);
 SELECT RAISE(ABORT,'Another archive operation is still active') WHERE EXISTS(SELECT 1 FROM private_gallery_active_job);
 -- D1 limits wildcard-pattern length. Compare the fixed prefix literally and
 -- use short patterns only for the positive, digits-only Actions run suffix.
 SELECT RAISE(ABORT,'Fixed protected run reference required') WHERE
  substr(NEW.run_reference,1,62) IS NOT 'https://github.com/johnkevan88888/family-running/actions/runs/'
  OR substr(NEW.run_reference,63,1) NOT GLOB '[1-9]'
  OR substr(NEW.run_reference,63) GLOB '*[^0-9]*';
 SELECT RAISE(ABORT,'Server clock required') WHERE NEW.created_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER private_gallery_job_completion_guard BEFORE INSERT ON private_gallery_job_completions BEGIN
 SELECT RAISE(ABORT,'Completion cannot be replaced') WHERE EXISTS(SELECT 1 FROM private_gallery_job_completions WHERE job_id=NEW.job_id);
 SELECT RAISE(ABORT,'Active exact job required') WHERE NOT EXISTS(SELECT 1 FROM private_gallery_active_job WHERE job_id=NEW.job_id);
 SELECT RAISE(ABORT,'Completion must match its owner-requested action') WHERE NOT EXISTS(
  SELECT 1 FROM private_gallery_active_job j WHERE j.job_id=NEW.job_id AND (
   (j.action='review' AND NEW.state IN ('unmerged-review','unmerged-removal-review','removed'))
   OR (j.action='removal' AND NEW.state IN ('unmerged-removal-review','removed'))
   OR (j.action='publication' AND NEW.state IN ('publication-observed','publication-revoked'))
   OR (j.action='purge-inspect' AND NEW.state='purge-eligible')));
 SELECT RAISE(ABORT,'Completion envelope must match its outcome') WHERE
  json_extract(NEW.result_json,'$.state') IS NOT NEW.state OR json_type(NEW.result_json,'$.publicationEnabled') IS NOT 'false';
 SELECT RAISE(ABORT,'Exact inspection result required') WHERE NEW.state='purge-eligible' AND (
  json_type(NEW.result_json,'$.dryRun') IS NOT 'true' OR length(json_extract(NEW.result_json,'$.proofHash')) IS NOT 64
  OR json_extract(NEW.result_json,'$.proofHash') GLOB '*[^0-9a-f]*');
 SELECT RAISE(ABORT,'Review is not currently eligible and recorded') WHERE NEW.state='unmerged-review' AND NOT EXISTS(
  SELECT 1 FROM private_gallery_active_job j JOIN private_gallery_pipeline_reviews r ON r.attempt_id=j.attempt_id
  JOIN private_gallery_current_attempt_permissions p ON p.attempt_id=j.attempt_id WHERE j.job_id=NEW.job_id AND j.action='review'
  AND NOT EXISTS(SELECT 1 FROM private_gallery_pipeline_closures WHERE attempt_id=j.attempt_id));
 SELECT RAISE(ABORT,'Removal not proved for every generation') WHERE NEW.state='removed' AND EXISTS(
  SELECT 1 FROM private_gallery_active_job j JOIN private_gallery_attempts a USING(asset_id) WHERE j.job_id=NEW.job_id AND
   NOT EXISTS(SELECT 1 FROM private_gallery_pipeline_current_removal WHERE attempt_id=a.attempt_id));
 SELECT RAISE(ABORT,'Removal proposal not recorded') WHERE NEW.state='unmerged-removal-review' AND NOT EXISTS(
  SELECT 1 FROM private_gallery_active_job j JOIN private_gallery_attempts a USING(asset_id)
  JOIN private_gallery_manifest_removal_reviews r ON r.attempt_id=a.attempt_id WHERE j.job_id=NEW.job_id AND NOT EXISTS(
   SELECT 1 FROM private_gallery_review_terminals t WHERE t.attempt_id=r.attempt_id AND t.kind='removal' AND t.base_sha=r.base_sha));
 SELECT RAISE(ABORT,'Publication outcome not bound to review') WHERE NEW.state='publication-observed' AND NOT EXISTS(
  SELECT 1 FROM private_gallery_active_job j JOIN private_gallery_pipeline_reviews r ON r.attempt_id=j.attempt_id
  JOIN private_gallery_current_attempt_permissions p ON p.attempt_id=j.attempt_id
  WHERE j.job_id=NEW.job_id AND j.action='publication'
   AND NOT EXISTS(SELECT 1 FROM private_gallery_pipeline_closures WHERE attempt_id=j.attempt_id)
   AND json_extract(NEW.result_json,'$.evidence.state')='merged-by-owner'
   AND json_extract(NEW.result_json,'$.evidence.headSha')=json_extract(r.review_json,'$.headSha')
   AND json_extract(NEW.result_json,'$.evidence.pullRequestNumber')=json_extract(r.review_json,'$.pullRequest.number'));
 SELECT RAISE(ABORT,'Publication revocation not terminal') WHERE NEW.state='publication-revoked' AND NOT EXISTS(
  SELECT 1 FROM private_gallery_active_job j JOIN private_gallery_pipeline_closures c ON c.attempt_id=j.attempt_id
  JOIN private_gallery_review_terminals t ON t.attempt_id=j.attempt_id AND t.kind='addition'
  WHERE j.job_id=NEW.job_id AND j.action='publication');
 SELECT RAISE(ABORT,'Dry-run is not an inspection job') WHERE NEW.state='purge-eligible' AND NOT EXISTS(
  SELECT 1 FROM private_gallery_active_job WHERE job_id=NEW.job_id AND action='purge-inspect');
 SELECT RAISE(ABORT,'Server clock required') WHERE NEW.created_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
-- No operation can retire private metadata while publication (or any other
-- archive job) owns the global slot. The purge's owner-confirmed proof is fixed.
CREATE TRIGGER private_gallery_coordinated_purge_guard BEFORE INSERT ON private_archive_purge_operations BEGIN
 SELECT RAISE(ABORT,'Exact owner-confirmed active purge job required') WHERE NOT EXISTS(
  SELECT 1 FROM private_gallery_active_job j WHERE j.asset_id=NEW.asset_id AND j.owner_hash=NEW.owner_hash
   AND j.action='purge' AND j.expected_proof_hash=NEW.proof_hash AND j.purge_scope_hash=NEW.scope_hash);
END;
CREATE TRIGGER private_gallery_job_no_update BEFORE UPDATE ON private_gallery_owner_jobs BEGIN SELECT RAISE(ABORT,'Owner job immutable'); END;
CREATE TRIGGER private_gallery_claim_no_update BEFORE UPDATE ON private_gallery_job_claims BEGIN SELECT RAISE(ABORT,'Claim immutable'); END;
CREATE TRIGGER private_gallery_completion_no_update BEFORE UPDATE ON private_gallery_job_completions BEGIN SELECT RAISE(ABORT,'Completion immutable'); END;
CREATE TRIGGER private_gallery_job_no_delete BEFORE DELETE ON private_gallery_owner_jobs BEGIN
 SELECT RAISE(ABORT,'Exact atomic archive purge required') WHERE NOT EXISTS(SELECT 1 FROM private_archive_purge_operations WHERE asset_id=OLD.asset_id);
END;
CREATE TRIGGER private_gallery_claim_no_delete BEFORE DELETE ON private_gallery_job_claims BEGIN
 SELECT RAISE(ABORT,'Exact atomic archive purge required') WHERE NOT EXISTS(SELECT 1 FROM private_archive_purge_operations
  WHERE asset_id IN(SELECT asset_id FROM private_gallery_owner_jobs WHERE job_id=OLD.job_id));
END;
CREATE TRIGGER private_gallery_completion_no_delete BEFORE DELETE ON private_gallery_job_completions BEGIN
 SELECT RAISE(ABORT,'Exact atomic archive purge required') WHERE NOT EXISTS(SELECT 1 FROM private_archive_purge_operations
  WHERE asset_id IN(SELECT asset_id FROM private_gallery_owner_jobs WHERE job_id=OLD.job_id));
END;
-- Delete FK children in the parent's atomic transaction, including an active
-- purge claim. Hash-only retirement remains the completed purge's replay proof.
CREATE TRIGGER private_gallery_asset_job_purge BEFORE DELETE ON private_gallery_assets BEGIN
 SELECT RAISE(ABORT,'Exact atomic archive purge required') WHERE NOT EXISTS(SELECT 1 FROM private_archive_purge_operations WHERE asset_id=OLD.asset_id);
 INSERT INTO private_gallery_retired_jobs(job_hash,run_hash,proof_hash)
  SELECT j.job_hash,c.run_hash,p.proof_hash FROM private_gallery_owner_jobs j JOIN private_gallery_job_claims c USING(job_id)
  JOIN private_archive_purge_operations p ON p.asset_id=j.asset_id WHERE j.asset_id=OLD.asset_id AND j.action='purge' AND j.purge_scope_hash=p.scope_hash;
 DELETE FROM private_gallery_job_completions WHERE job_id IN(SELECT job_id FROM private_gallery_owner_jobs WHERE asset_id=OLD.asset_id);
 DELETE FROM private_gallery_job_claims WHERE job_id IN(SELECT job_id FROM private_gallery_owner_jobs WHERE asset_id=OLD.asset_id);
 DELETE FROM private_gallery_owner_jobs WHERE asset_id=OLD.asset_id;
END;
-- Jobs reference attempts too, so retire them before the first attempt, not
-- only before the asset. All are covered by that same atomic grant.
CREATE TRIGGER private_gallery_attempt_job_purge BEFORE DELETE ON private_gallery_attempts BEGIN
 SELECT RAISE(ABORT,'Exact atomic archive purge required') WHERE NOT EXISTS(SELECT 1 FROM private_archive_purge_operations WHERE asset_id=OLD.asset_id);
 INSERT INTO private_gallery_retired_jobs(job_hash,run_hash,proof_hash)
  SELECT j.job_hash,c.run_hash,p.proof_hash FROM private_gallery_owner_jobs j JOIN private_gallery_job_claims c USING(job_id)
  JOIN private_archive_purge_operations p ON p.asset_id=j.asset_id WHERE j.asset_id=OLD.asset_id AND j.action='purge' AND j.purge_scope_hash=p.scope_hash;
 DELETE FROM private_gallery_job_completions WHERE job_id IN(SELECT job_id FROM private_gallery_owner_jobs WHERE asset_id=OLD.asset_id);
 DELETE FROM private_gallery_job_claims WHERE job_id IN(SELECT job_id FROM private_gallery_owner_jobs WHERE asset_id=OLD.asset_id);
 DELETE FROM private_gallery_owner_jobs WHERE asset_id=OLD.asset_id;
END;
CREATE TRIGGER private_gallery_retired_job_guard BEFORE INSERT ON private_gallery_retired_jobs BEGIN
 SELECT RAISE(ABORT,'Retired job cannot be replaced') WHERE EXISTS(SELECT 1 FROM private_gallery_retired_jobs WHERE job_hash=NEW.job_hash);
 SELECT RAISE(ABORT,'Exact atomic purge required') WHERE NOT EXISTS(
  SELECT 1 FROM private_gallery_owner_jobs j JOIN private_gallery_job_claims c USING(job_id)
  JOIN private_archive_purge_operations p ON p.asset_id=j.asset_id WHERE j.action='purge' AND j.job_hash=NEW.job_hash
   AND c.run_hash=NEW.run_hash AND p.proof_hash=NEW.proof_hash AND j.purge_scope_hash=p.scope_hash);
END;
CREATE TRIGGER private_gallery_retired_job_no_update BEFORE UPDATE ON private_gallery_retired_jobs BEGIN SELECT RAISE(ABORT,'Retired job immutable'); END;
CREATE TRIGGER private_gallery_retired_job_no_delete BEFORE DELETE ON private_gallery_retired_jobs BEGIN SELECT RAISE(ABORT,'Retired job immutable'); END;
