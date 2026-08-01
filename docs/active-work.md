# Active Work

## Task title

Add an exported age-grade target calculator and athlete comparison page

## Status

Calculator implementation, the private-workbook comparison exporter, and the
real Family/Everyone comparison exports are complete on
`feat/age-grade-calculator`. The explicitly approved staged bundle has been
promoted into tracked `data/` and passes the complete local test suite. No
commit, push, Pull Request, merge, preview publication, production release, or
GitHub setting change has been performed.

## Current approved scope

- Add a dedicated Calculator page to the shared site navigation.
- Let a visitor choose an athlete and an exported age-grade standard, then show
  the required time and exported kilometre/mile pace for every championship
  distance.
- Let a visitor choose a Challenger and The Standard. For each distance, show
  The Standard's best age-graded performance and fastest raw-time performance,
  then the workbook-exported time the Challenger must beat to score a higher
  age grade than each one.
- Preserve Family and Everyone query-string modes and load only the selected
  mode's `age_grade_standards.csv`.
- Keep Excel/VBA as the sole owner of age grades and target times; JavaScript
  selects and renders exact exported rows and does not interpolate or calculate
  a target.
- Preserve the existing site design, pace preference, static architecture, and
  public-data contracts.

## Files changed in this pass

- Added `calculator.html`, `calculator.css`, and `calculator.js`.
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
  performances, target times, and paces from the selected mode and never
  requests the other mode's comparison or age-grade standards.
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
- The available goals are the six percentages already exported by the workbook:
  35%, 50%, 60%, 70%, 80%, and 90%.
- Head-to-head mode now uses The Standard's actual highest age grade and fastest
  raw time at every available championship distance. It retains each source
  performance's date, event, and Official/Unofficial class.
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

## Handoff notes

- Review the Calculator in both modes, including changing Challenger, The
  Standard, and pace unit. Confirm the two source standards and both challenger
  targets against the private workbook.
- The feature branch, promoted data, workbook changes, and private VBA module
  are ready for commit/PR review. Do not push, open a Pull Request, publish, or
  deploy without explicit approval.

## Recently completed historical work

- PR #22 restored GoatCounter production visit collection by removing a stale
  integrity pin from the provider's mutable loader.
- PR #20 added the workbook-owned absolute Records page.
- PR #18 added the static Championships, Hall of Fame, Overview, shared
  navigation, and browser smoke coverage.
- Export-bundle staging and manifest-backed validation were completed
  previously; tracked public data is promoted only after explicit approval.
