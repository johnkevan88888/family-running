# Active Work

## Task title

Age Grade Standards pace-display enhancement

## Status

Implementation complete and locally validated on
`feat/age-grade-pace-toggle`. Ready for review, with the private VBA source
limitation recorded below.

## Completed scope

- Added exported `pace_per_km` and `pace_per_mile` fields to every Family and
  Everyone age-grade standards row.
- Kept target times and all existing headings, distance labels, class bands,
  ordering, and site modes unchanged.
- Added one accessible, persisted `/km` and `/mi` pace control to the existing
  table; `/km` remains the first-visit default.
- Kept browser JavaScript display-only: it selects between two exported pace
  strings and performs no pace or standards calculations.
- Added exact pace validation using the full target time, specified race
  distances, 1.609344 km per mile, and downward rounding to one decimal place.
- Added failure regressions for missing, malformed, and mathematically
  incorrect pace exports.
- Added browser coverage for both site modes, both responsive viewports,
  keyboard selection, reload persistence, and the four required examples.

## Validation completed

- [x] CSV validation for Family and Everyone.
- [x] Export/CSV failure regression tests.
- [x] Browser tests for Family and Everyone at desktop and mobile widths.
- [x] Interactive browser verification of semantics, switching, persistence,
  and representative values.
- [x] Desktop and mobile pace screenshots for `/km` and `/mi`.
- [x] `pnpm test`: repository safety (94 tracked files), CSV validation,
  export/CSV regressions, and browser smoke tests all passed.
- [x] `pnpm run screenshots:update`: responsive review images refreshed.
- [x] With explicit owner approval, the ignored private workbook was updated
  in place and its `CrownStandards` sheet was rebuilt and verified in Excel.

## Screenshot output

Generated review images are under the ignored
`test-artifacts/screenshots/` directory. Each site mode has desktop and mobile
images for both `km` and `mi`, named:

`<mode>-age-grade-standards-<viewport>-<unit>.png`

## Workbook/export status

After explicit owner approval to access the private workbook, its embedded
`CrownStandardsExport` module was updated to build `pace_per_km` and
`pace_per_mile` with Excel-owned `ROUNDDOWN(..., 1)` formulas using the exact
race distances and 1.609344 km per mile. The workbook stores the pace values as
numeric times formatted `[m]:ss.0`; the refresh-only macro rebuilt both Family
and Everyone blocks without writing public files. The workbook and its local
backup remain ignored and uncommitted.

The workbook's broader website exporter predates the repository-wide
`ExportBundleID` and manifest contract. It was therefore not run against
`data/`. Before this workbook is used for a full website export, that separate
legacy exporter must be upgraded to the current bundle contract.

## Release status

- No push, Pull Request, merge, preview deployment, production deployment, or
  GitHub setting change was requested or performed.
