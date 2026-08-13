# Proposed Workbook-Owned Personal-Best Export

## Status

- **Status:** Proposal. Not accepted, not implemented, not agreed with the
  workbook.
- **Date:** 12 August 2026
- **Addresses:** audit finding P2-03 in
  [Audit of Pull Requests #19 to #32](pr-19-32-audit.md)

Nothing here is approved. This document exists because P2-03 cannot be fixed
inside this repository, and the next step the audit recommends is a design that
crosses into the private workbook. It is written so that design decision can be
made once, deliberately, rather than discovered halfway through an
implementation.

Following the correction recorded in `docs/decision-log.md` about the workbook
staging parent, this repository must not record workbook behaviour it cannot
verify. Everything below is therefore a *request* to the workbook side, not a
statement about what the workbook does.

## Why this cannot be fixed here

`buildPersonalBests` in `athlete.js` selects each distance's fastest time and
best age grade in the browser. The Calculator reads the same two benchmarks from
workbook-owned `athlete_comparison_targets.csv`. One concept, two selectors.

The repository cannot resolve that on its own:

- The fix needs a workbook-owned export, and only Excel/VBA can produce one.
  Repository policy forbids modifying or inspecting the private workbook.
- Generating the file from repository code would *be* the second source of
  truth, which is the defect.
- Pointing the athlete page at an export that does not exist yet would empty a
  working Personal Bests section in production.
- Keeping the JavaScript selectors as a fallback until the export arrives is the
  silent fallback the audit warns against, and would leave two selectors in
  place anyway.

So the repository work is real but strictly second: contract, validation, and
rendering, after the export exists.

## What the browser does today, exactly

The workbook needs this in order to decide whether to replicate it or
deliberately supersede it. None of it is currently written down anywhere, which
is part of the problem.

- **Distances:** Marathon, Half Marathon, 10 Mile, 10 km, 5 km, matched through
  an alias list (`H. Mar`, `10M`, `5km`, and similar).
- **Result classes:** Official and Unofficial, selected independently, so each
  distance shows four benchmarks.
- **Fastest Time:** lowest `Time` converted to seconds. A malformed time sorts
  last through `Number.MAX_SAFE_INTEGER`.
- **Best Age Grade:** highest `AgeGrade`. An unparseable age grade becomes `0`.
- **Tie-break: accidental.** Neither selector defines one. Both sort a list that
  `buildAthletePage` has already ordered by date descending, and rely on
  `Array.prototype.sort` being stable, so a tie resolves to the **most recent**
  result. That is an emergent property of two unrelated pieces of code, not a
  rule. It is the most likely place for the browser and the workbook to disagree
  without anyone noticing.

## Proposed export

### File and scope

`data/personal_bests.csv`, manifest `Scope` of `shared`.

**Shared rather than per-site, deliberately.** Athlete profiles already read
shared `data/athlete_results.csv`, and a direct
`athlete.html?id=...&site=family` URL legitimately renders any athlete who has
results. Measured against the current export: `data/athlete_results.csv` holds
19 distinct athletes, while the Family comparison export covers 12. Seven
result-bearing athletes therefore have no Family benchmark rows at all. A
per-site personal-best export would leave those profiles empty in Family mode,
and loading the Everyone export to fill the gap would break mode isolation.

### Proposed schema

Modelled on `athlete_comparison_targets.csv` so the two exports stay
recognisably the same family of thing.

`AthleteId,Distance,TimeClass,BenchmarkType,Time,AgeGrade,Date,Event,SourceRow,SortOrder,ExportBundleID`

- `AthleteId` matches `data/athlete_results.csv`.
- `Distance` is one of the five supported distances, in the canonical spelling
  the other exports already use.
- `TimeClass` is `Official` or `Unofficial`.
- `BenchmarkType` is `Best Age Grade` or `Fastest Time`, matching the
  Calculator's vocabulary exactly.
- `Time`, `AgeGrade`, `Date`, `Event` are the exact source performance, copied
  from the row the workbook selected, so the page displays exported values
  rather than deriving them.
- `SourceRow` is the auditable worksheet row, as `absolute_records.csv` already
  does.
- `SortOrder` is numeric, unique per athlete, and strictly increasing, so the
  display order is reproducible rather than incidental.

### Semantics the workbook needs to settle

1. **The tie-break.** Whatever it is, it should be stated rather than emergent.
   Matching the current accidental behaviour (most recent wins) keeps the
   visible output identical on today's data; anything else changes it.
2. **Coverage.** One row per athlete, distance, result class, and benchmark type
   that exists. An athlete with no result at a distance should have no row for
   it rather than a placeholder, so the page can distinguish "no result" from
   "not exported".
3. **Whether the same performance can be both benchmarks.** It frequently is.
   The Calculator already handles this by rendering one row with two badges; the
   athlete page would need the same treatment or two rows.
4. **Period.** The Calculator's export carries `Period` for Current and All
   Time. Personal bests on the athlete page are all-time only today. Adding a
   `Period` column now would avoid a second schema change if Current bests are
   ever wanted; omitting it keeps the export smaller.

## Repository work this would unblock

In sequence, after the export exists:

1. Add `data/personal_bests.csv` to CSV validation: schema, allowed values,
   uniqueness per athlete/distance/class/benchmark, `SortOrder` ordering, and
   agreement of every exported performance with `data/athlete_results.csv`. That
   last check is what makes the export auditable rather than trusted.
2. Render the athlete page from the export, gated on the file appearing in
   `data/export_manifest.csv`, exactly as the Records page is gated.
3. Delete `getFastestResult` and `getBestAgeGradeResult`, and the alias-matching
   they depend on if nothing else uses it.
4. Preserve an explicit empty state per benchmark. Do not fall back to browser
   calculation for an athlete missing from the export: a silent fallback would
   restore the two-source problem in the one case where it matters.
5. Extend browser coverage to prove the page renders exported values and shows
   the empty state rather than computing anything.

## Risk if this is left alone

Low today and unbounded later. The audit reconciled both current exports and
found no disagreement: all 70 Family and all 96 Everyone All Time benchmark keys
select the same source performance in both paths. The exposure is that the
agreement is contingent. A tie introduced by new data, or an eligibility or
correction rule applied in the workbook, can move one path without moving the
other, and nothing would fail: the athlete page and the Calculator would simply
show different bests for the same athlete and distance.
