-- Review requests are not completed removals. Main/host evidence stays in 0023.
CREATE TABLE private_gallery_manifest_removal_intents (
    attempt_id TEXT NOT NULL REFERENCES private_gallery_attempts(attempt_id),
    base_sha TEXT NOT NULL CHECK(length(base_sha)=40 AND base_sha NOT GLOB '*[^0-9a-f]*'),
    operation_id TEXT UNIQUE NOT NULL,
    removal_json TEXT NOT NULL CHECK(json_valid(removal_json)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY(attempt_id,base_sha)
);
CREATE TRIGGER private_gallery_removal_intent_guard BEFORE INSERT ON private_gallery_manifest_removal_intents BEGIN
    SELECT RAISE(ABORT,'Removal review requires closed generation') WHERE NOT EXISTS (
        SELECT 1 FROM private_gallery_pipeline_closures WHERE attempt_id=NEW.attempt_id);
    SELECT RAISE(ABORT,'Removal review requires complete exact byte removal') WHERE EXISTS (
        SELECT 1 FROM private_gallery_pipeline_outputs o LEFT JOIN private_gallery_pipeline_object_removals r
            USING(attempt_id,tier,role) WHERE o.attempt_id=NEW.attempt_id AND r.attempt_id IS NULL);
    SELECT RAISE(ABORT,'Removal review requires current host proof') WHERE NOT EXISTS (
        SELECT 1 FROM private_gallery_pipeline_host_receipts h JOIN gallery_media_delivery_current_epoch e
            ON e.epoch_id_hash=h.epoch_id_hash WHERE h.attempt_id=NEW.attempt_id);
    SELECT RAISE(ABORT,'Removal review identity cannot be replaced') WHERE EXISTS (
        SELECT 1 FROM private_gallery_manifest_removal_intents WHERE (attempt_id=NEW.attempt_id AND base_sha=NEW.base_sha)
            OR operation_id=NEW.operation_id);
    SELECT RAISE(ABORT,'Opaque removal identity required') WHERE substr(NEW.operation_id,1,8)!='removal_'
        OR length(NEW.operation_id)!=44 OR substr(NEW.operation_id,17,1)!='-' OR substr(NEW.operation_id,22,2)!='-4'
        OR substr(NEW.operation_id,27,1)!='-' OR substr(NEW.operation_id,28,1) NOT IN ('8','9','a','b')
        OR substr(NEW.operation_id,32,1)!='-' OR length(replace(substr(NEW.operation_id,9),'-',''))!=32
        OR replace(substr(NEW.operation_id,9),'-','') GLOB '*[^0-9a-f]*';
    SELECT RAISE(ABORT,'Removal review clock server owned') WHERE NEW.created_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now');
END;
CREATE TRIGGER private_gallery_removal_intent_target BEFORE INSERT ON private_gallery_manifest_removal_intents BEGIN
    SELECT RAISE(ABORT,'Exact historical public item required') WHERE NOT EXISTS (
        SELECT 1 FROM private_gallery_attempts a JOIN private_gallery_pipeline_review_intents i USING(attempt_id)
        JOIN json_each(json_extract(i.candidate_json,'$.manifestText'),'$.items') item
        WHERE a.attempt_id=NEW.attempt_id AND json_extract(item.value,'$.id')=a.public_item_id
            AND json_extract(NEW.removal_json,'$.operationId')=NEW.operation_id
            AND json_extract(NEW.removal_json,'$.targetRelativePath')='gallery-data/'||a.site_mode||'.json'
            AND json_extract(NEW.removal_json,'$.item') IS item.value);
END;
CREATE TRIGGER private_gallery_removal_intent_no_update BEFORE UPDATE ON private_gallery_manifest_removal_intents
BEGIN SELECT RAISE(ABORT,'Removal intent immutable'); END;
CREATE TRIGGER private_gallery_removal_intent_no_delete BEFORE DELETE ON private_gallery_manifest_removal_intents
BEGIN SELECT RAISE(ABORT,'Removal intent purge not enabled'); END;
CREATE TABLE private_gallery_manifest_removal_reviews (
    attempt_id TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    review_json TEXT NOT NULL CHECK(json_valid(review_json)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY(attempt_id,base_sha),
    FOREIGN KEY(attempt_id,base_sha) REFERENCES private_gallery_manifest_removal_intents(attempt_id,base_sha)
);
CREATE TRIGGER private_gallery_removal_review_identity BEFORE INSERT ON private_gallery_manifest_removal_reviews BEGIN
    SELECT RAISE(ABORT,'Removal review cannot be replaced') WHERE EXISTS (
        SELECT 1 FROM private_gallery_manifest_removal_reviews WHERE attempt_id=NEW.attempt_id AND base_sha=NEW.base_sha);
    SELECT RAISE(ABORT,'Removal review clock server owned') WHERE NEW.created_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now');
    SELECT RAISE(ABORT,'Removal review differs from intent') WHERE NOT EXISTS (
        SELECT 1 FROM private_gallery_manifest_removal_intents i WHERE i.attempt_id=NEW.attempt_id AND i.base_sha=NEW.base_sha
            AND json_extract(NEW.review_json,'$.baseSha')=i.base_sha
            AND json_extract(NEW.review_json,'$.targetRelativePath')=json_extract(i.removal_json,'$.targetRelativePath')
            AND json_extract(NEW.review_json,'$.itemId')=json_extract(i.removal_json,'$.item.id')
            AND json_extract(NEW.review_json,'$.manifestSha256')=json_extract(i.removal_json,'$.manifestSha256')
            AND json_extract(NEW.review_json,'$.repository')='johnkevan88888/family-running'
            AND json_extract(NEW.review_json,'$.baseRef')='main'
            AND json_extract(NEW.review_json,'$.pullRequest.state')='open');
END;
CREATE TRIGGER private_gallery_removal_review_no_update BEFORE UPDATE ON private_gallery_manifest_removal_reviews
BEGIN SELECT RAISE(ABORT,'Removal review immutable'); END;
CREATE TRIGGER private_gallery_removal_review_no_delete BEFORE DELETE ON private_gallery_manifest_removal_reviews
BEGIN SELECT RAISE(ABORT,'Removal review purge not enabled'); END;
