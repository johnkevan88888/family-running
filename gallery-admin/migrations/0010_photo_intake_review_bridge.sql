-- Add an immutable whole-file commitment for the first real-photo intake.
-- Existing synthetic rehearsal rows remain valid with the default values;
-- every new v1 upload must use the photo-only bridge and supply its digest.
ALTER TABLE draft_upload_sessions
    ADD COLUMN declared_sha256 TEXT
        CHECK (
            declared_sha256 IS NULL OR (
                length(declared_sha256) = 64 AND
                declared_sha256 NOT GLOB '*[^0-9a-f]*'
            )
        );

ALTER TABLE draft_upload_sessions
    ADD COLUMN real_photo_intake_confirmed INTEGER NOT NULL DEFAULT 0
        CHECK (real_photo_intake_confirmed IN (0, 1));

CREATE TRIGGER draft_upload_sessions_real_photo_intake_guard
BEFORE INSERT ON draft_upload_sessions
WHEN NEW.object_key LIKE 'private-originals/v1/%'
BEGIN
    SELECT CASE WHEN
        NEW.real_photo_intake_confirmed <> 1 OR
        NEW.declared_sha256 IS NULL OR
        length(NEW.declared_sha256) <> 64 OR
        NEW.declared_sha256 GLOB '*[^0-9a-f]*' OR
        NEW.file_extension NOT IN ('jpg', 'jpeg', 'png') OR
        NEW.declared_content_type NOT IN ('image/jpeg', 'image/png')
    THEN RAISE(ABORT, 'v1 private upload requires an exact photo intake commitment') END;
END;

CREATE TRIGGER draft_upload_sessions_real_photo_intake_immutable
BEFORE UPDATE OF declared_sha256, real_photo_intake_confirmed
ON draft_upload_sessions
WHEN
    NEW.declared_sha256 IS NOT OLD.declared_sha256 OR
    NEW.real_photo_intake_confirmed <> OLD.real_photo_intake_confirmed
BEGIN
    SELECT RAISE(ABORT, 'private photo intake commitment is immutable');
END;
