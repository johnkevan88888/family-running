-- Additive, immutable per-athlete distances for new photo reviews. NULL keeps
-- every legacy attestation and its exact single-distance payload unchanged.
ALTER TABLE private_gallery_attempts ADD COLUMN race_results_json TEXT
    CHECK (race_results_json IS NULL OR
        (json_valid(race_results_json) AND json_type(race_results_json)='array'
         AND json_array_length(race_results_json)<=100 AND length(race_results_json)<=16384));

CREATE TRIGGER private_gallery_attempt_event_results BEFORE INSERT ON private_gallery_attempts
WHEN NEW.race_results_json IS NOT NULL BEGIN
    SELECT RAISE(ABORT,'Photo result associations must be exact public tag subsets') WHERE EXISTS (
        SELECT 1 FROM json_each(NEW.race_results_json) r
        WHERE r.type!='object'
            OR (SELECT count(*) FROM json_each(r.value))!=2
            OR EXISTS(SELECT 1 FROM json_each(r.value) f WHERE f.key NOT IN ('athleteId','raceDistance'))
            OR json_type(r.value,'$.athleteId') IS NOT 'text'
            OR json_type(r.value,'$.raceDistance') IS NOT 'text'
            OR length(trim(json_extract(r.value,'$.raceDistance'))) NOT BETWEEN 1 AND 300
            OR NOT EXISTS(SELECT 1 FROM json_each(NEW.public_athlete_ids_json) p WHERE p.value=json_extract(r.value,'$.athleteId')));
    SELECT RAISE(ABORT,'One selected distance per runner required') WHERE
        (SELECT count(DISTINCT json_extract(value,'$.athleteId')) FROM json_each(NEW.race_results_json))
        !=json_array_length(NEW.race_results_json);
END;
-- Existing no-update, complete-tag, source, consent and coordinated-purge guards
-- apply unchanged. Exported-result membership is rechecked by each service.
