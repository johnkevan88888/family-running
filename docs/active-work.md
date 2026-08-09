# Active Work

## Task title

Streamline routine website data updates

## Status

The lightweight `[skip netlify]` pathway and 8 August public data were released
through PR #25. This follow-up adds a guarded, guided command for routine data
updates so John no longer needs to copy staging paths between commands or
manually remember the branch and Pull Request conventions. The command keeps
the existing staged-review, explicit-promotion, full-test, Pull Request, and
production-approval gates intact. It does not change workbook calculations,
CSV schemas, public data, or website behaviour.

## Challenge the Standard layout follow-up

The Calculator now combines identical Best Age Grade and Fastest Time
performances into one visible row while retaining both badges. Its initial
matchup is the smallest exported age-grade percentage gap among the top five
Current Official Overall championship rows; the lower-ranked athlete is the
Challenger and the higher-ranked athlete is The Standard.

A compact Standards period switch shows one of Current (last 12 months) or All
Time at once, avoiding duplicated official/unofficial distance cards. The
workbook exporter now supplies the workbook-owned `Period` field and selects
Current benchmarks from the export date's inclusive rolling 12-month window.
Bundle `20260809T011814593Z-6B8F617F` was generated through the complete staged
workflow and explicitly promoted after validation and reconciliation. It adds
528 Current comparison rows for Family and 1,116 for Everyone while preserving
all 770 Family and 1,620 Everyone All Time rows exactly.

Focused browser coverage verifies the default rivalry, Current-first switching,
All Time isolation, responsive period controls, and the two-badge/one-row case.
Repository validation enforces period-specific completeness, inclusive Current
date-window membership, and source-performance ranking. The complete `pnpm
test` suite passes against the promoted data, including repository safety,
both-mode CSV validation, export and staged-workflow regressions, preview
artifact creation, responsive browser tests, and refreshed desktop and mobile
Calculator screenshots. Visual review confirms the Current-first rivalry,
period controls, official/unofficial grouping, and combined two-badge rows in
both site modes.

## Streamlined routine update command

`pnpm run data:update` now guides one qualifying data refresh from a clean
workspace through branch creation, workbook export, validation,
reconciliation, explicit promotion, full tests, eligibility checks, commit,
push, and `[skip netlify]` Pull Request creation. Windows users can launch the
same flow by double-clicking `update-website-data.cmd`.

The exact confirmation words `PROMOTE` and `PUBLISH` preserve the two material
local/external change boundaries. The command never merges the Pull Request or
deploys production. A stopped update can resume from ignored local state with
`pnpm run data:update -- --resume`, without copying the staged export path.

The wrapper fails closed for a missing GitHub login, dirty worktree,
overlapping open data Pull Request, incomplete public bundle, header/schema
change, non-data file, failed bundle validation, or failed repository test.

The focused updater tests, JavaScript syntax check, `git diff --check`, and the
complete `pnpm test` suite pass locally. The full suite includes repository
safety, both-mode CSV validation, release-path tests, staged-export
regressions, preview artifact creation, browser smoke coverage, and responsive
screenshots. The implementation is local on
`feat/streamlined-data-updates` and is ready for the standard Pull Request
pathway. Merge and production deployment remain separate approval steps.

## Files changed for the streamlined updater

- Added `scripts/simple-data-update.mjs`, its focused regression test, and the
  double-clickable `update-website-data.cmd` launcher.
- Added `pnpm run data:update` and included the updater regression in the full
  repository suite.
- Updated the README, workbook workflow, testing/release protocol, preview
  deployment guide, decision log, and these handoff notes.

## Lightweight data-refresh pathway

A second Pull Request pathway is now implemented for routine existing-schema
public CSV refreshes, such as adding new race times. A Pull Request title that
contains `[skip netlify]` prevents Netlify from generating a Deploy Preview,
while the normal GitHub test job still runs the complete suite and uploads
Family and Everyone responsive screenshots. The eligibility guard fails closed
unless the diff contains the complete tracked public CSV bundle below `data/`,
unchanged CSV headers, no added or removed exports, and only optional
`docs/active-work.md` notes outside the data bundle. Code, configuration,
schema, export-set, and broader documentation changes continue to require the
standard Netlify preview pathway.

The preview-links workflow now maintains a lightweight-review comment instead
of dead preview URLs when the marker is present. The Pull Request template,
testing and release protocol, deployment guide, and durable decision log all
describe the two pathways. Focused release-path tests pass, including eligible
data refreshes and fail-closed code, schema, added-export, incomplete-bundle,
and documentation-only cases. The complete `pnpm test` suite also passes,
including repository safety, both-mode CSV validation, export workflow
regressions, the preview artifact build, browser smoke coverage, and responsive
screenshots.
The current Calculator follow-up branch contains code and contract changes, so
it remains on the standard preview pathway; this alternative is for future
qualifying data refreshes after the workflow reaches `main`.

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
- On 8 August 2026, bundle `20260808T184046876Z-5035E17F` was staged,
  reconciled, and promoted with explicit approval after adding 13 official
  5 km results. The private workbook's `Lifetime PB` and `Best 12m` flags now
  compare each row only with results in the same `Time Class`, retaining
  independent Official and Unofficial PBs.
- The private workbook now rebuilds `tbOfficialMedals` automatically from the
  enabled Official leaderboard spills before every website export, links each
  medal back to its exact `tbRaceResults` row for date and event, and normalizes
  a missing legacy event to `UNKNOWN`. The resulting 22 Family and 26 Everyone
  medal rows passed the repository's medal-to-leaderboard validation.
- The 8 August medal changes give David Graham-Kevan Current 5 km Silver in
  Family and Bronze in Everyone, move Poppy Coleman to Family Bronze, and
  remove Caitlin Siostrom and Poppy from the displaced Current 5 km places.
  Jim Chambers retains his medal places with the improved `26:01` / `67.0%`
  result, while David's existing Current Overall medals now cite `23:37` /
  `65.5%`.
- Niall Carberry's addition expands Everyone age-grade standards and crown
  standards; Jack Graham-Kevan's new current 5 km result updates his crown and
  comparison targets. Absolute-record holders and performances are unchanged;
  only their source-row audit references moved after the result-table update.

## Handoff notes

- The Current/All Time private comparison module was imported and the complete
  68-file bundle `20260809T011814593Z-6B8F617F` passed staged validation,
  reconciliation, explicit promotion, and the full repository test suite. The
  prior tracked bundle is retained under ignored
  `test-artifacts/workbook-export-promotion/20260809032702327/previous-data`
  for local rollback. PR #27 remains the review and preview path; merge and
  production deployment still require separate approval.
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
- The 8 August race-results and medal refresh passed the complete 68-file staged
  validation, reconciliation review, and `pnpm test` suite after promotion.
  The prior tracked bundle is retained under ignored
  `test-artifacts/workbook-export-promotion/20260808204832981/previous-data`
  for local rollback.

## Recently completed historical work

- PR #22 restored GoatCounter production visit collection by removing a stale
  integrity pin from the provider's mutable loader.
- PR #20 added the workbook-owned absolute Records page.
- PR #18 added the static Championships, Hall of Fame, Overview, shared
  navigation, and browser smoke coverage.
- Export-bundle staging and manifest-backed validation were completed
  previously; tracked public data is promoted only after explicit approval.
