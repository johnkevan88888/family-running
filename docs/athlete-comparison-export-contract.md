# Athlete Comparison Export Contract

## Purpose

The Calculator's head-to-head view selects a Challenger and The Standard. For
each championship distance where The Standard has a public result, it shows:

- The Standard's best age-graded performance.
- The Standard's fastest raw-time performance.
- The workbook-calculated time and pace the Challenger must beat to score a
  higher age grade than each performance.
- Separate Current (last 12 months) and All Time standards when the export
  supplies both periods.

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
ChallengerAthleteId,StandardAthleteId,Distance,BenchmarkType,StandardTime,StandardAgeGrade,StandardDate,StandardEvent,StandardTimeClass,Period,RequiredTimeToBeat,RequiredPacePerKm,RequiredPacePerMile,SortOrder,ExportBundleID
```

The browser and repository validator temporarily accept the previously
published schema without `Period` and treat those rows as `All Time`. The next
workbook export-contract revision should add `Period`; once both site exports
have moved to the revised schema, this compatibility path can be removed.

## Row contract

- Export every ordered Challenger/Standard pair available to the selected site,
  excluding self-comparisons.
- Use the five canonical distances: `5 km`, `10 km`, `10 Mile`,
  `Half Marathon`, and `Marathon`.
- Use `Current` for standards selected only from performances in the export
  date's rolling 12-month window, and `All Time` for standards selected from
  the complete result history. Emit rows only where the Standard athlete has
  a qualifying result for that period, distance, and result class.
- Select benchmarks independently within each available `Official` and
  `Unofficial` result class. The Calculator groups official rows first and
  unofficial rows in a separately labelled section below.
- For every pair, distance, and available result class, emit two rows:
  - `Best Age Grade`: The Standard's highest age-grade result in that class.
  - `Fastest Time`: The Standard's fastest raw-time result in that class.
- Emit both benchmark rows even when one performance sets both standards. This
  lets the page preserve both badges while visually combining their identical
  performance and target into one row. With two periods and both result
  classes, the export produces up to eight rows per pair and distance.
- `StandardTime`, `StandardAgeGrade`, `StandardDate`, `StandardEvent`, and
  `StandardTimeClass` must identify one exact row in
  `data/athlete_results.csv`.
- `RequiredTimeToBeat` is the time the Challenger must run at the age category
  used for the current export to score strictly higher than
  `StandardAgeGrade`.
- `RequiredPacePerKm` and `RequiredPacePerMile` are workbook-exported paces for
  `RequiredTimeToBeat`, rounded down to one tenth of a second using the same
  rule as `age_grade_standards.csv`.
- `SortOrder` controls presentation within each period. Order distances as
  5 km, 10 km, 10 Mile, Half Marathon, and Marathon. Within each distance use
  official best age grade, official fastest time, unofficial best age grade,
  then unofficial fastest time (`101`-`104`, `201`-`204`, and so on). Current
  and All Time rows may reuse the same period-local sort values.

## Browser-only presentation choices

- The period switch shows one period at a time and defaults to `Current` when
  that period exists; legacy exports show the sole `All Time` option.
- When Best Age Grade and Fastest Time identify the same source performance
  and exported challenger target, the page displays one performance row with
  both badges.
- The default matchup is the smallest exported age-grade percentage gap among
  the top five rows in the selected site's Current Official Overall
  championship. The lower-ranked athlete is the Challenger and the
  higher-ranked athlete is The Standard. This selects an initial view only; it
  does not calculate or change any age grade.

## Tie-breaking

Apply tie-breaking within the same result class to keep repeated exports
deterministic. The rules are [Workbook Tie-Break Rules](tie-break-rules.md), and
they are stated there rather than here because the same chain now governs this
export, the proposed `data/personal_bests.csv`, and the workbook's own
overall-crown comparison.

**Changed on 13 August 2026.** This section previously read:

> - For `Best Age Grade`, prefer the faster time when age grades tie, then the
>   most recent date, then the earlier workbook source row.
> - For `Fastest Time`, prefer the higher age grade when times tie, then the most
>   recent date, then the earlier workbook source row.

Two things changed. Ties are now compared on the workbook's unrounded age grade
before any of these criteria apply, and **older wins over more recent** rather
than the reverse. The order of the remaining criteria changed with it; the full
chain is in the linked document.

No currently exported row changes. There is no tie in the current results for
any of this to decide, measured on 13 August 2026.

## Validation

When present, repository validation checks the supported transitional or
period-labelled schema, athlete identities, period/distance/benchmark values,
source-performance agreement, period-specific top-performance status,
target-time and pace formatting, pair/period/distance completeness, duplicate
rows, sort values, and export-bundle integrity. Browser coverage separately
proves that period switching and official/unofficial source-performance
sections retain exact exported values.
