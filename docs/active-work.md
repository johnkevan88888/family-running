# Active Work

## Task title

Add a grouped athlete comparison calculator

## Status

The Calculator implementation, private-workbook comparison exporter, and real
Family/Everyone comparison exports are complete on
`feat/age-grade-calculator`. Draft PR #23 is open. The follow-up refinement
removes the duplicate race-target builder and presents official and unofficial
comparison results in separate sections, with official results first. It has
passed the full local test suite but has not yet been committed or pushed. No
merge, production release, or GitHub setting change has been performed.

## Current approved scope

- Add a dedicated Calculator page to the shared site navigation.
- Let a visitor choose a Challenger and The Standard. For each distance, show
  The Standard's exported best age-graded performance and fastest raw-time
  performance, then the workbook-exported time the Challenger must beat to
  score a higher age grade than each one. Group official results first and
  unofficial results in a clearly labelled section below.
- Omit the single-athlete race-target builder because equivalent targets are
  already available on athlete profile pages.
- Preserve Family and Everyone query-string modes and load only the selected
  mode's `age_grade_standards.csv`.
- Keep Excel/VBA as the sole owner of age grades and target times; JavaScript
  selects and renders exact exported rows and does not interpolate or calculate
  a target.
- Preserve the existing site design, pace preference, static architecture, and
  public-data contracts.

## Files changed in this pass

- Added `calculator.html`, `calculator.css`, and `calculator.js`.
- Refined the Calculator to remove the duplicate race-target section and its
  unused JavaScript/CSS, and to group comparison rows into official and
  unofficial sections.
- Updated `site-navigation.js` with the Calculator page.
- Updated `scripts/build-preview-artifact.mjs` to publish and verify the new
  runtime files.
- Extended `tests/browser-smoke.mjs` for Calculator navigation, mode isolation,
  exported-value fidelity, interactions, pace switching, and responsive
  screenshots.
- Added the optional `athlete_comparison_targets.csv` validator, complete
  pair/distance matrix enforcement, selected-site identity checks, and focused
  malformed/incomplete-target regressions.
- Extended the staged export, comparison, and promotion tools to admit the two
  explicitly approved new CSV contract files without weakening the default
  exact-file-set gate.
- Added the private `AthleteComparisonExport` VBA module and the live
  `Athlete Comparison` worksheet. The worksheet's participant dropdown is
  table-driven and its deterministic performance tie-break prefers the most
  recent date after score and time.
- Added `docs/athlete-comparison-export-contract.md` with the exact workbook
  export schema, row rules, tie-breaking, and validation contract.
- Updated `docs/active-work.md`, `docs/testing-and-release-protocol.md`, and
  `docs/decision-log.md`.

## Validation results

- Passed `pnpm test`, including repository safety, Family and Everyone CSV
  validation, analytics and export-workflow regression tests, the preview
  artifact build, and responsive browser smoke tests for both modes.
- Browser coverage confirms the page displays exact workbook-exported source
  performances, target times, and paces from the selected mode, keeps official
  and unofficial standards in their labelled sections, omits the race-target
  builder, and never requests the other mode's comparison or age-grade
  standards.
- Synthetic workbook-export coverage confirms Challenger/Standard selection,
  both benchmark types, exact standard-performance fields, exact challenger
  target times and paces, self-comparison prevention, mode isolation, and
  responsive presentation.
- Real-export coverage verifies 572 Family rows and 1,156 Everyone rows across
  5 km, 10 km, 10 Mile, Half Marathon, and Marathon, with both benchmark types,
  complete ordered pairs for every available standard, and no self-comparisons.
- A synthetic manifest-absent edge case confirms the browser does not request a
  missing comparison CSV and renders a clear unavailable message.
- The first staged export was rejected after a Half Marathon completeness gap
  was found. The distance mapping and validator were corrected before public
  data promotion, and the corrected 68-file bundle passed strengthened staged
  validation and reconciliation.
- Responsive Calculator screenshots were generated under ignored
  `test-artifacts/screenshots/` for both site modes.
- `node --check calculator.js`, `node --check site-navigation.js`, and
  `git diff --check` passed.

## Data and product notes

- The approved workbook bundle adds
  `data/family/athlete_comparison_targets.csv` and
  `data/everyone/athlete_comparison_targets.csv` plus their manifest entries.
- Head-to-head mode presents The Standard's exported highest age grade and
  fastest raw time with official results first and unofficial results below.
  Each displayed performance retains its exported date, event, and class.
- The current workbook export selects one best-age-grade row and one
  fastest-time row across all public results for each distance. The browser
  groups those exact rows; it does not invent a fallback result for a class the
  export did not supply.
- Pairwise times for the Challenger to beat those standards belong in the new
  workbook-owned `athlete_comparison_targets.csv`; they are never derived in
  browser JavaScript.
- No tracked public CSV or export manifest was manually changed. The complete
  validated staged bundle was promoted with explicit approval.
- Date-sensitive refreshes affected current-age standards for David
  Graham-Kevan, Ben Graham-Kevan, and Jashlay Balanon. Jashlay's 20 July 2025
  result also left the rolling 12-month window, so the Everyone current
  all-results tables now use his 18 February 2026 result and move Jess
  Graham-Kevan up one place. No source result, record, medal, Hall of Fame, or
  crown-history row changed.
- On 2 August 2026, bundle `20260802T173015230Z-19C1E180` was staged,
  reconciled, and promoted with explicit approval after adding unofficial
  Toronto Training 10 km results for John Kevan (`55:20`, `51.9%`) and Caitlin
  Siostrom (`57:03`, `52.7%`). Meaningful changes were limited to the two
  athlete-result rows, Family and Everyone all/current 10 km tables, their
  downstream comparison targets, and manifest row counts. Official tables,
  records, medals, crowns, and Hall of Fame data were unchanged.

## Handoff notes

- Review the Calculator in both modes, including changing Challenger, The
  Standard, and pace unit. Confirm that the official section appears before the
  unofficial section and that challenger targets match the private workbook.
- The grouped-results follow-up is ready to commit and push to draft PR #23. Do
  not push, merge, publish, or deploy without explicit approval.
- The 2 August race-results refresh passed staged bundle validation and the
  complete `pnpm test` suite after promotion. The prior public bundle is
  retained under ignored `test-artifacts/workbook-export-promotion/` for local
  rollback. The refreshed data remains uncommitted and has not been pushed or
  published.

## Recently completed historical work

- PR #22 restored GoatCounter production visit collection by removing a stale
  integrity pin from the provider's mutable loader.
- PR #20 added the workbook-owned absolute Records page.
- PR #18 added the static Championships, Hall of Fame, Overview, shared
  navigation, and browser smoke coverage.
- Export-bundle staging and manifest-backed validation were completed
  previously; tracked public data is promoted only after explicit approval.
