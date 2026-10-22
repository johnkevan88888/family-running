-- Private file capture precedes tagging. This is NOT an archive intake, consent
-- attempt or public-use grant. Existing rows and attestations are unchanged.
CREATE TABLE family_gallery_saved_files (
 photo_id TEXT PRIMARY KEY NOT NULL REFERENCES family_gallery_draft_photos(photo_id) ON DELETE CASCADE,
 draft_id TEXT NOT NULL REFERENCES family_gallery_drafts(draft_id),
 owner_hash TEXT NOT NULL CHECK(length(owner_hash)=64),
 asset_id TEXT UNIQUE NOT NULL CHECK(length(asset_id)=42 AND substr(asset_id,1,6)='asset_'),
 original_format TEXT NOT NULL CHECK(original_format IN('jpg','png')),
 byte_count INTEGER NOT NULL CHECK(byte_count BETWEEN 1 AND 26214400),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
 permission_version INTEGER NOT NULL CHECK(permission_version>0),
 provider_upload_id TEXT UNIQUE,
 provider_version TEXT,
 provider_etag TEXT,
 writer_closed TEXT CHECK(writer_closed IS NULL OR writer_closed IN('abort-confirmed','no-such-upload')),
 delete_requested INTEGER NOT NULL DEFAULT 0 CHECK(delete_requested IN(0,1)),
 deletion_closure TEXT CHECK(deletion_closure IS NULL OR deletion_closure IN('abort-confirmed','no-such-upload')),
 original_absent INTEGER NOT NULL DEFAULT 0 CHECK(original_absent IN(0,1) AND original_absent<=delete_requested),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 CHECK((provider_version IS NULL AND provider_etag IS NULL AND writer_closed IS NULL)
  OR (provider_upload_id IS NOT NULL AND provider_version IS NOT NULL AND provider_etag IS NOT NULL
   AND length(provider_version)>0 AND length(provider_etag)>0 AND writer_closed IS NOT NULL))
);
CREATE TRIGGER family_gallery_saved_file_insert BEFORE INSERT ON family_gallery_saved_files BEGIN
 SELECT RAISE(ABORT,'Saved file owner/source required') WHERE NOT EXISTS(
  SELECT 1 FROM family_gallery_draft_photos p JOIN family_gallery_drafts d USING(draft_id)
  JOIN family_gallery_current_permission c ON c.owner_hash=d.owner_hash
  WHERE p.photo_id=NEW.photo_id AND d.draft_id=NEW.draft_id AND d.owner_hash=NEW.owner_hash
   AND d.state='editing' AND p.reservation_json IS NULL AND p.asset_id IS NULL
   AND c.active=1 AND c.version=NEW.permission_version
   AND json_extract(p.metadata_json,'$.originalFormat')=NEW.original_format
   AND json_extract(p.metadata_json,'$.sha256')=NEW.sha256
   AND json_extract(p.metadata_json,'$.byteCount')=NEW.byte_count);
 SELECT RAISE(ABORT,'Saved file cannot be replaced') WHERE EXISTS(
  SELECT 1 FROM family_gallery_saved_files WHERE photo_id=NEW.photo_id OR asset_id=NEW.asset_id);
 SELECT RAISE(ABORT,'Fresh saved file identity required') WHERE EXISTS(
  SELECT 1 FROM private_gallery_assets WHERE asset_id=NEW.asset_id)
  OR NEW.provider_upload_id IS NOT NULL OR NEW.provider_version IS NOT NULL OR NEW.writer_closed IS NOT NULL
  OR NEW.delete_requested!=0 OR NEW.original_absent!=0 OR NEW.deletion_closure IS NOT NULL;
END;
CREATE TRIGGER family_gallery_saved_file_update BEFORE UPDATE ON family_gallery_saved_files BEGIN
 SELECT RAISE(ABORT,'Saved file identity immutable') WHERE NEW.photo_id!=OLD.photo_id OR NEW.draft_id!=OLD.draft_id
  OR NEW.owner_hash!=OLD.owner_hash OR NEW.asset_id!=OLD.asset_id OR NEW.original_format!=OLD.original_format
  OR NEW.byte_count!=OLD.byte_count OR NEW.sha256!=OLD.sha256 OR NEW.permission_version!=OLD.permission_version OR NEW.created_at!=OLD.created_at;
 SELECT RAISE(ABORT,'Saved file writer immutable') WHERE OLD.provider_upload_id IS NOT NULL AND NEW.provider_upload_id IS NOT OLD.provider_upload_id;
 SELECT RAISE(ABORT,'Saved file receipt immutable') WHERE OLD.provider_version IS NOT NULL
  AND (NEW.provider_version IS NOT OLD.provider_version OR NEW.provider_etag IS NOT OLD.provider_etag OR NEW.writer_closed IS NOT OLD.writer_closed);
 SELECT RAISE(ABORT,'Current private retention permission required') WHERE
  (NEW.provider_upload_id IS NOT OLD.provider_upload_id OR NEW.provider_version IS NOT OLD.provider_version) AND NOT EXISTS(
   SELECT 1 FROM family_gallery_current_permission WHERE owner_hash=NEW.owner_hash AND version=NEW.permission_version AND active=1);
 SELECT RAISE(ABORT,'Deletion fences all new writers and receipts') WHERE NEW.delete_requested=1
  AND (NEW.provider_upload_id IS NOT OLD.provider_upload_id OR NEW.provider_version IS NOT OLD.provider_version);
 SELECT RAISE(ABORT,'Use existing tagged original deletion') WHERE NEW.delete_requested=1
  AND EXISTS(SELECT 1 FROM private_gallery_assets WHERE asset_id=NEW.asset_id);
 SELECT RAISE(ABORT,'Private deletion is terminal') WHERE NEW.delete_requested<OLD.delete_requested OR NEW.original_absent<OLD.original_absent
  OR (OLD.deletion_closure IS NOT NULL AND NEW.deletion_closure IS NOT OLD.deletion_closure);
 SELECT RAISE(ABORT,'Close the writer before absence') WHERE NEW.original_absent=1 AND NEW.provider_upload_id IS NOT NULL AND NEW.deletion_closure IS NULL;
 SELECT RAISE(ABORT,'Deletion must be requested before writer closure') WHERE NEW.deletion_closure IS NOT NULL AND NEW.delete_requested!=1;
 SELECT RAISE(ABORT,'Editable saved file required') WHERE NOT EXISTS(
  SELECT 1 FROM family_gallery_drafts WHERE draft_id=NEW.draft_id AND state='editing');
END;
CREATE TRIGGER family_gallery_saved_file_delete BEFORE DELETE ON family_gallery_saved_files BEGIN
 SELECT RAISE(ABORT,'Only coordinated purge removes saved file evidence') WHERE NOT EXISTS(
  SELECT 1 FROM private_archive_purge_operations WHERE asset_id=OLD.asset_id);
END;
CREATE TRIGGER family_gallery_saved_file_metadata BEFORE UPDATE ON family_gallery_draft_photos
 WHEN EXISTS(SELECT 1 FROM family_gallery_saved_files WHERE photo_id=OLD.photo_id) BEGIN
 SELECT RAISE(ABORT,'Stored pixels cannot be replaced by editing a card') WHERE NOT EXISTS(
  SELECT 1 FROM family_gallery_saved_files f WHERE f.photo_id=NEW.photo_id
   AND json_extract(NEW.metadata_json,'$.originalFormat')=f.original_format
   AND json_extract(NEW.metadata_json,'$.sha256')=f.sha256
   AND json_extract(NEW.metadata_json,'$.byteCount')=f.byte_count
   AND (NEW.asset_id IS NULL OR NEW.asset_id=f.asset_id));
END;
CREATE TRIGGER family_gallery_saved_file_asset BEFORE INSERT ON private_gallery_assets
 WHEN EXISTS(SELECT 1 FROM family_gallery_saved_files WHERE photo_id=NEW.idempotency_key OR asset_id=NEW.asset_id) BEGIN
 SELECT RAISE(ABORT,'Saved source and closed writer required') WHERE NOT EXISTS(
  SELECT 1 FROM family_gallery_saved_files f JOIN family_gallery_draft_photos p ON p.photo_id=f.photo_id
  WHERE f.asset_id=NEW.asset_id AND f.photo_id=NEW.idempotency_key
   AND f.owner_hash=NEW.owner_identity_hash AND NEW.site_mode='family' AND f.original_format=NEW.original_format
   AND json_extract(p.reservation_json,'$.personIds')=NEW.person_ids_json
   AND f.provider_version IS NOT NULL AND f.writer_closed IS NOT NULL AND f.delete_requested=0);
END;
CREATE TRIGGER family_gallery_saved_file_receipt BEFORE INSERT ON private_archive_original_receipts
 WHEN EXISTS(SELECT 1 FROM family_gallery_saved_files WHERE asset_id=NEW.asset_id) BEGIN
 SELECT RAISE(ABORT,'Original must match the checked saved file') WHERE NOT EXISTS(
  SELECT 1 FROM family_gallery_saved_files f WHERE f.asset_id=NEW.asset_id AND f.byte_count=NEW.byte_count
   AND f.sha256=NEW.sha256 AND f.provider_version=NEW.provider_version AND f.provider_etag=NEW.provider_etag AND f.writer_closed IS NOT NULL AND f.delete_requested=0);
END;
-- Purge already deletes the linked draft card atomically. Its cascade retires
-- this private file evidence only with the existing exact asset purge grant.
-- An interrupted pre-link reservation must be reconciled first, never orphaned.
CREATE TRIGGER family_gallery_saved_file_asset_delete BEFORE DELETE ON private_gallery_assets BEGIN
 SELECT RAISE(ABORT,'Saved file link must be reconciled before purge') WHERE EXISTS(
  SELECT 1 FROM family_gallery_saved_files f WHERE f.asset_id=OLD.asset_id AND NOT EXISTS(
   SELECT 1 FROM family_gallery_draft_photos p WHERE p.photo_id=f.photo_id AND p.asset_id=OLD.asset_id));
END;
