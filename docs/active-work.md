# Active Work

## Task title

Private workbook staged export-bundle modernization

## Status

Implementation complete on `feat/workbook-export-bundle-contract`. Two clean
private-workbook exports independently passed the repository contract. No
staged bundle has been promoted to tracked `data/`.

## Completed scope

- Replaced direct-to-`data/` VBA paths with one official staged exporter.
- Added a fresh-folder gate under ignored
  `test-artifacts/workbook-export-staging/`.
- Preserved Excel/VBA ownership of all calculations and exported values.
- Exported all Family, Everyone, and shared public CSVs with one bundle ID.
- Preserved the exact manifest schema and bundle-ID format enforced by
  `scripts/validate-csv.mjs`.
- Added manifest-last completion, planned/actual file reconciliation, duplicate
  path detection, formula-error checks, UTF-8 output, and deletion of failed
  partial staging folders.
- Reconciled the private source workbook with the age-grade
  `pace_per_km`/`pace_per_mile` VBA change.
- Corrected the WebExport no-result fallback from an eight-column array to the
  required nine-column row, replacing an unintended `#N/A` Athlete-ID formula
  error with blank in no-result rows.
- Added repository commands for staged validation, reconciliation, and
  separately approved complete-bundle promotion.
- Added staged-workflow regression tests and a durable runbook.

## Private workbook changes

Private source:

`C:\Users\johnk\OneDrive\GitHub\_private_workbooks\Family Age Grading Table v2.0 CLEAN RESTORE 20260616 CODEX WORKING COPY.xlsm`

Changed VBA modules:

- `ExportBundleIntegrity`
- `WebsiteDataExport`
- `WebsiteExportValidation`
- `CrownStandardsExport`
- `CrownHistoryExport`

The 48 WebExport leaderboard spill formulas also received the corrected
no-result fallback width. No calculation, ranking, medal, crown, standards, or
athlete business logic was moved to JavaScript.

Private backup:

`C:\Users\johnk\OneDrive\GitHub\_private_workbooks\backups\Family Age Grading Table before export-contract modernization 20260702-102546.xlsm`

The workbook, VBA working sources, backups, and QA artefacts remain outside Git
or in ignored local folders.

## Clean staged export results

Export 1:

`test-artifacts/workbook-export-staging/run-20260702-201456-695`

Export 2:

`test-artifacts/workbook-export-staging/run-20260702-201738-294`

Both exports:

- contain 64 CSVs: 63 manifest entries plus the manifest;
- independently pass the full CSV and export-bundle validation;
- contain required Family, Everyone, and shared scopes;
- include age-grade pace fields and values; and
- are content-identical to each other after normalizing only bundle IDs and
  timestamps.

## Reconciliation against tracked data

After ignoring only documented volatile metadata:

- 57 files are content-identical.
- Seven no-result leaderboard files differ only because the staged export has
  a blank Athlete ID where tracked data contains the formula-error sentinel
  `#N/A`:
  - `data/everyone/marathon-current-all-everyone.csv`
  - `data/everyone/marathon-current-official-everyone.csv`
  - `data/family/10mile-alltime-official-family.csv`
  - `data/family/10mile-current-official-family.csv`
  - `data/family/marathon-alltime-official-family.csv`
  - `data/family/marathon-current-all-family.csv`
  - `data/family/marathon-current-official-family.csv`

This is an expected export-integrity correction, not a changed result or
championship outcome. It has not been promoted.

## Release status

- No tracked public data overwrite or promotion.
- No push, Pull Request, merge, deployment, or GitHub setting change.
