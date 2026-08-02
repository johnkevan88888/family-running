# Athlete Comparison Export Contract

## Purpose

The Calculator's head-to-head view selects a Challenger and The Standard. For
each championship distance where The Standard has a public result, it shows:

- The Standard's best age-graded performance.
- The Standard's fastest raw-time performance.
- The workbook-calculated time and pace the Challenger must beat to score a
  higher age grade than each performance.

The browser only selects and renders exported rows. It does not choose winning
performances, calculate age grades, interpolate targets, or subtract time.

## Files

The workbook adds one site-specific file to each complete export:

- `data/family/athlete_comparison_targets.csv`
- `data/everyone/athlete_comparison_targets.csv`

Each file carries the current `ExportBundleID` and is listed in
`data/export_manifest.csv`. Until the workbook exporter supplies these files,
the Calculator shows a clear unavailable state and does not request a missing
file.

## Exact schema

```text
ChallengerAthleteId,StandardAthleteId,Distance,BenchmarkType,StandardTime,StandardAgeGrade,StandardDate,StandardEvent,StandardTimeClass,RequiredTimeToBeat,RequiredPacePerKm,RequiredPacePerMile,SortOrder,ExportBundleID
```

## Row contract

- Export every ordered Challenger/Standard pair available to the selected site,
  excluding self-comparisons.
- Use the five canonical distances: `5 km`, `10 km`, `10 Mile`,
  `Half Marathon`, and `Marathon`.
- Use all public results, retaining `Official` or `Unofficial` in
  `StandardTimeClass`. The Calculator groups official rows first and unofficial
  rows in a separately labelled section below.
- A result class can be empty for a pairing because the browser groups only the
  winning source rows supplied by the export; it does not select fallback
  performances from `data/athlete_results.csv`.
- Emit two rows for every pair and distance where The Standard has a result:
  - `Best Age Grade`: The Standard's highest age-grade result.
  - `Fastest Time`: The Standard's fastest raw-time result.
- Emit both benchmark rows even when one performance sets both standards.
- `StandardTime`, `StandardAgeGrade`, `StandardDate`, `StandardEvent`, and
  `StandardTimeClass` must identify one exact row in
  `data/athlete_results.csv`.
- `RequiredTimeToBeat` is the time the Challenger must run at the age category
  used for the current export to score strictly higher than
  `StandardAgeGrade`.
- `RequiredPacePerKm` and `RequiredPacePerMile` are workbook-exported paces for
  `RequiredTimeToBeat`, rounded down to one tenth of a second using the same
  rule as `age_grade_standards.csv`.
- `SortOrder` controls presentation. Order distances as 5 km, 10 km, 10 Mile,
  Half Marathon, and Marathon, with `Best Age Grade` before `Fastest Time`.

## Recommended tie-breaking

To keep repeated exports deterministic:

- For `Best Age Grade`, prefer the faster time when age grades tie, then the
  most recent date, then the earlier workbook source row.
- For `Fastest Time`, prefer the higher age grade when times tie, then the most
  recent date, then the earlier workbook source row.

## Validation

Repository validation treats the file as optional until the workbook exporter
adds it. When present, validation checks the exact schema, athlete identities,
distance and benchmark values, source-performance agreement, top-performance
status, target-time and pace formatting, pair/distance completeness, duplicate
rows, sort values, and export-bundle integrity. Browser coverage separately
proves that official and unofficial source-performance rows stay in their
correct sections.
