# Active Work

## Task title

Absolute records page and workbook audit sheet

## Status

Implementation, tracked public-data promotion, and local validation are complete
on `feat/absolute-records-page`. Workbook review remains pending.
No merge, release, deployment, production publication, or GitHub setting change
has been performed.

## Current approved scope

- Add a public Records page for non-age-graded, absolute fastest-time records.
- Keep JavaScript display-only. Absolute records are workbook-owned exports,
  not browser-derived rankings.
- Add a visible `AbsoluteRecords` worksheet to the private master workbook so
  Men and Women official raw-time records can be reviewed and audited by source
  `tbRaceResults` worksheet row.
- Export `data/family/absolute_records.csv` and
  `data/everyone/absolute_records.csv` from the workbook's staged export flow.
- Preserve `?site=family` and `?site=everyone` navigation behavior.

## Files changed in this pass

- `records.html`
- `records.js`
- `site-navigation.js`
- `site.css`
- `scripts/validate-csv.mjs`
- `scripts/export-bundle-tools.mjs`
- `scripts/promote-staged-export.mjs`
- `tests/browser-smoke.mjs`
- `tests/staged-export-workflow.mjs`
- `data/` promoted from staged workbook export
- `docs/active-work.md`
- `docs/testing-and-release-protocol.md`
- `docs/workbook-export-workflow.md`
- `docs/decision-log.md`

## Private workbook changes

- Updated the private master workbook:
  `_private_workbooks/Family Age Grading Table v2.0 CLEAN RESTORE 20260616 CODEX WORKING COPY.xlsm`.
- Added a formula-driven `AbsoluteRecords` sheet with separate Family and
  Everyone blocks. Each block includes Men and Women records for Marathon, Half
  Marathon, 10 Mile, 10 km, and 5 km.
- Updated workbook export VBA so staged exports include
  `absolute_records.csv` for both site modes.
- Private backups were created before workbook changes, including:
  - `backups/Family Age Grading Table before absolute records sheet 20260718-111929.xlsm`
  - `backups/Family Age Grading Table before absolute records export VBA 20260718-111605.xlsm`

## Validation results

- Passed:
  - `pnpm test`
  - `node --check records.js`
  - `node --check tests/browser-smoke.mjs`
  - `node --check scripts/validate-csv.mjs`
  - `node --check scripts/export-bundle-tools.mjs`
  - `node --check scripts/promote-staged-export.mjs`
  - `node --check tests/staged-export-workflow.mjs`
  - `pnpm run validate:csv`
  - `pnpm run test:staged-export`
  - `pnpm run test:browser`
  - Direct staged CSV validation with `CSV_VALIDATION_ROOT` set to
    `test-artifacts/workbook-export-staging/run-20260718-112059-123`
  - `pnpm run workbook:validate:staged --staged test-artifacts/workbook-export-staging/run-20260718-112059-123`
  - `pnpm run workbook:compare:staged --staged test-artifacts/workbook-export-staging/run-20260718-112059-123`
- A staged workbook export completed at
  `test-artifacts/workbook-export-staging/run-20260718-112059-123`.
  Its manifest includes both new absolute record CSVs with 10 data rows each.
- The staged bundle was promoted with explicit approval for the two new public
  CSV contract files:
  `data/family/absolute_records.csv` and
  `data/everyone/absolute_records.csv`.
- The previous tracked `data/` directory was retained locally at
  `test-artifacts/workbook-export-promotion/20260718161729818/previous-data`.
- Post-promotion reconciliation reported no meaningful content differences
  between tracked `data/` and the staged workbook bundle after volatile
  metadata normalization.

## Data note

- Tracked public CSV files under `data/` were promoted from the validated staged
  workbook bundle.
- The Records page now renders the workbook-exported Men/Women absolute records
  for the selected site mode.
- Browser smoke coverage still includes a synthetic records CSV fixture proving
  Men/Women cards render, selected-site-only CSV requests are preserved, and
  empty exported record states behave correctly.

## Handoff notes

- Review the new `AbsoluteRecords` worksheet in the private master workbook.
- Review the promoted `data/family/absolute_records.csv` and
  `data/everyone/absolute_records.csv` files alongside the private workbook
  audit sheet.
- Review the full promoted data-bundle diff before PR approval because a full
  workbook promotion updates bundle IDs across public CSVs.

## Recently completed historical work

- PR #18 static navigation review fixes were completed previously on
  `feat/site-navigation`, including the Championships landing, Hall of Fame,
  Overview, shared navigation, and browser smoke coverage.
- The initial static navigation split for PR #18 created separate public pages
  for Overview, Championships, Hall of Fame, and athlete profiles, with shared
  navigation and browser smoke coverage.
- Staging-root portability for private workbook exports was completed and merged
  previously. The workbook now uses `Settings!tbSettings[Approved Staging Root]`
  and tracked `data/` was promoted from a validated staged bundle.
- Export-bundle modernization was completed previously. Workbook exports stage a
  complete manifest-backed bundle before any explicitly approved promotion to
  tracked public data.
