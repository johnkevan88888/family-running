# Active Work

## Task title

Add a grouped athlete comparison calculator

## Status

The initial Calculator implementation and grouped official/unofficial display
were merged in PR #23. This follow-up completes the private-workbook exporter
and public data contract so official and unofficial benchmarks are selected
independently. The private VBA source module and repository validator are now
updated for both result classes. The module compiled successfully and staged
bundle `20260805T155056454Z-1459E180` passed validation and reconciliation. Its
three meaningful differences were explicitly approved and promoted, and the
complete local test suite passes. No merge or production release has been
performed for this follow-up.

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
- Updated the private `AthleteComparisonExport.bas` source to select best age
  grade and fastest time independently for Official and Unofficial results.
- Strengthened comparison CSV validation for class-specific uniqueness,
  completeness, source-performance ranking, and sort order.
- Added `docs/athlete-comparison-export-contract.md` with the exact workbook
  export schema, row rules, tie-breaking, and validation contract.
- Updated `docs/active-work.md`, `docs/testing-and-release-protocol.md`, and
  `docs/decision-log.md`.

## Validation results

- The pre-expansion implementation passed `pnpm test`, including repository
  safety, Family and Everyone CSV validation, analytics and export-workflow
  regression tests, the preview artifact build, and responsive browser smoke
  tests for both modes.
- After the contract expansion, JavaScript syntax and `git diff --check` pass.
  CSV validation correctly rejected the old comparison bundle's class-agnostic
  sort order and missing class-specific benchmark matrices.
- Staged bundle `20260805T155056454Z-1459E180` passed CSV and 68-file manifest
  validation. Reconciliation reports only the two comparison CSVs and their
  manifest row counts as meaningfully changed; the other 65 public CSVs are
  unchanged.
- The staged comparison matrices contain 770 Family rows and 1,496 Everyone
  rows. All 385 Family and 748 Everyone pair/distance/class groups contain
  exactly one `Best Age Grade` and one `Fastest Time` benchmark.
- The explicitly approved staged bundle was promoted into tracked `data/`.
  The complete `pnpm test` suite passes, including responsive browser coverage
  for both site modes.
- Browser coverage confirms the page displays exact workbook-exported source
  performances, target times, and paces from the selected mode, keeps official
  and unofficial standards in their labelled sections, omits the race-target
  builder, and never requests the other mode's comparison or age-grade
  standards.
- Synthetic workbook-export coverage confirms Challenger/Standard selection,
  both benchmark types, exact standard-performance fields, exact challenger
  target times and paces, self-comparison prevention, mode isolation, and
  responsive presentation.
- The tracked comparison exports now contain 770 Family rows and 1,496 Everyone
  rows across 5 km, 10 km, 10 Mile, Half Marathon, and Marathon. Every available
  pair/distance/result-class group contains both benchmark types, and there are
  no self-comparisons.
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
- The revised private source selects one best-age-grade row and one fastest-time
  row independently for each available result class and distance. It emits up
  to four rows per Challenger/Standard/distance combination.
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
- The revised private module was imported and compiled. The validated staging
  root `test-artifacts/workbook-export-staging/run-20260805-115026-579` was
  explicitly approved and promoted. The previous tracked data is retained under
  ignored `test-artifacts/workbook-export-promotion/20260805161831463/previous-data`
  for local rollback.
- The grouped-results implementation, expanded validator, and promoted export
  are ready for Pull Request review.
- Approval has been granted to commit, push, and open a draft Pull Request for
  this follow-up. Merge and deployment still require separate approval.
- The 2 August race-results refresh passed staged bundle validation and the
  complete `pnpm test` suite after promotion. It is included in the promoted
  public bundle for this follow-up. The prior public bundle is retained under
  ignored `test-artifacts/workbook-export-promotion/` for local rollback.

## Recently completed historical work

- PR #22 restored GoatCounter production visit collection by removing a stale
  integrity pin from the provider's mutable loader.
- PR #20 added the workbook-owned absolute Records page.
- PR #18 added the static Championships, Hall of Fame, Overview, shared
  navigation, and browser smoke coverage.
- Export-bundle staging and manifest-backed validation were completed
  previously; tracked public data is promoted only after explicit approval.
