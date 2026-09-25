# Gallery photo result details

John approved exact age at the race, not grouped age category, on 25 September
2026. Age-group privacy controls are deferred. `AgeAtRace` is a public CSV field,
not private data protected by Gallery consent or the site's noindex policy. No
DOB is exported. Public disclosure of the age-enabled full bundle was explicitly
approved separately from publication of the photo candidate.

## Presentation and authority

Gallery photo cards and their enlarged viewer show only race name, distance,
race date, and each tagged athlete's name, time, AG and age at that race. Photo
titles/captions remain unchanged manifest fields but are not displayed as extra
copy. Alt text remains available for accessibility. Video presentation, Race
moments highlights and podium decorations are unchanged by the details feature.
Whole-photo thumbnails retain the 4:3 frame using centred `contain` without hover
zoom; no derivative reprocessing is required.

The private workbook's existing `tbRaceResults[Age on Day]` calculation supplies
the additive `AgeAtRace` column in `data/athlete_results.csv`, immediately before
`ExportBundleID`. Its active-profile filter and row order remain intact. No age,
age grade, category, ranking or time is calculated by Gallery code. Time and AG
display strings are retained verbatim.

`gallery-results.js` matches public athlete ID, exact exported event, distance
and race date. Date conversion changes only formatting. Selected-mode eligibility
comes from that mode's `age_grade_standards.csv`. Results, roster and manifest
must share one bundle ID, with matching registered paths/scopes and row counts.
No name-only join, leaderboard fallback, present-day age, other-race age or
first-row choice is allowed. Multiple matching results (including different time
classes) are ambiguous: all three performance fields show `Unavailable`.
Supporters retain their public name without being assigned another result.
Missing/invalid data produces unavailable details, never invented facts.

Suppression remains mandatory and resolves before loading photo details or
constructing media elements. A missing/malformed suppression list blocks the
entire Gallery. CSV parsing/conversion remains in `utils.js`; all displayed text
uses DOM `textContent`, never markup. External media, consent, metadata stripping,
tagging, exclusion, withdrawal, purge and fixed-origin verification are unchanged.

## Export contract and routine updates

The coordinated 72-file schema release activates `AgeAtRace` together with its
matching `scripts/workbook-export-contract.json` fingerprint and the regenerated
private Gallery catalogue. The private workbook reports that same signature.
Routine `update-website-data.cmd` updates keep their existing workflow and strict
preflight; no bypass or launcher change is needed. Never promote an individual
CSV outside its complete export bundle.

Every exported age must be an integer from 0 through 130. Legacy result documents
remain readable for compatibility, but display `Unavailable` for age rather than
infer one. The active tracked-bundle fingerprint and workbook header check enforce
the age-enabled schema for new routine exports.

This schema/UI release uses the normal visual-preview PR pathway, not routine
data auto-merge. It does not merge the one-photo manifest candidate or deploy
Workers. Future service catalogue alignment requires separate deployment approval.

## Regression coverage

`tests/gallery-photo-details.mjs` covers exact matching, multiple pictured people,
supporters, duplicate results, legacy/missing ages, invalid ages/dates/schemas,
stale bundles, wrong mode, text escaping, suppression before media requests, and
both-mode desktop/mobile cards/viewers. It emits synthetic responsive screenshots.
`tests/gallery-age-export.mjs` checks the active full-bundle schema fingerprint
and rejection of malformed ages by CSV validation and catalogue generation.
Thumbnail shape tests and the updated Gallery browser smoke check are also part
of the normal full suite.
