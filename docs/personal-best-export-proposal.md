# Proposed Workbook-Owned Personal-Best Export

## Status

- **Status:** Schema and semantics settled 13 August 2026. The export does not
  exist, and no repository work is approved.
- **Date:** Proposed 12 August 2026; open questions settled 13 August 2026.
- **Addresses:** audit finding P2-03 in
  [Audit of Pull Requests #19 to #32](pr-19-32-audit.md)

The four questions this document originally left open were decided by John on
13 August 2026 and are recorded under "Settled semantics" below. That fixes the
contract the workbook can be built against; it is not approval to build it, and
it is not approval for the repository work listed at the end.

This document exists because P2-03 cannot be fixed inside this repository, and
the next step the audit recommends is a design that crosses into the private
workbook. It is written so that design decision can be made once, deliberately,
rather than discovered halfway through an implementation.

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
  `buildAthletePage` has already ordered by date descending
  ([athlete.js](../athlete.js), the `athleteResults` sort), and rely on
  `Array.prototype.sort` being stable, so a tie resolves to the **most recent**
  result. That is an emergent property of two unrelated pieces of code, not a
  rule. It is the most likely place for the browser and the workbook to disagree
  without anyone noticing.

  The divergence is present today, not merely possible. The Calculator's export
  already has a written tie-break under "Recommended tie-breaking" in
  [the athlete comparison export contract](athlete-comparison-export-contract.md):
  for `Best Age Grade`, prefer the faster time, then the most recent date, then
  the earlier workbook source row; for `Fastest Time`, prefer the higher age
  grade, then the most recent date, then the earlier source row. The browser
  skips each rule's **first** criterion entirely and resolves on date alone. Two
  results at one distance with equal age grades but different times would
  therefore select differently in the Calculator and on the athlete's own
  profile. No such tie exists in current data, which is why nothing has failed.

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

`AthleteId,Distance,TimeClass,Period,BenchmarkType,Time,AgeGrade,Date,Event,SourceRow,SortOrder,ExportBundleID`

- `AthleteId` matches `data/athlete_results.csv`.
- `Distance` is one of the five supported distances, in the canonical spelling
  the other exports already use.
- `TimeClass` is `Official` or `Unofficial`.
- `Period` is `All Time`, and only `All Time`, until Current-period bests are
  separately decided. See settled question 4.
- `BenchmarkType` is `Best Age Grade` or `Fastest Time`, matching the
  Calculator's vocabulary exactly.
- `Time`, `AgeGrade`, `Date`, `Event` are the exact source performance, copied
  from the row the workbook selected, so the page displays exported values
  rather than deriving them.
- `SourceRow` is the auditable worksheet row, as `absolute_records.csv` already
  does.
- `SortOrder` is numeric, unique per athlete, and strictly increasing, so the
  display order is reproducible rather than incidental.

### Settled semantics

Decided by John on 13 August 2026. These four are the contract the workbook
should be built against.

1. **The tie-break is the one already written down.** The workbook applies the
   `Best Age Grade` and `Fastest Time` rules from "Recommended tie-breaking" in
   [the athlete comparison export contract](athlete-comparison-export-contract.md),
   unchanged, rather than replicating the browser's accidental date-only
   behaviour. Rejected alternative: matching the current browser output. That
   would ask the workbook to reproduce an emergent property of two unrelated
   pieces of code, and would leave two different tie-break rules in one system.
   Adopting the documented rule costs nothing visible today, because the audit
   found no tied key where the two disagree; it changes output only on data that
   does not yet exist.
2. **Coverage: no placeholder rows.** One row per athlete, distance, result
   class, and benchmark type that actually exists. An athlete with no result at
   a distance has no row for it, so the page can distinguish "no result" from
   "not exported". Rejected alternative: a complete matrix of placeholders,
   which would let validation enforce a fixed row count per athlete but would
   make an empty `Time` indistinguishable from a malformed export.
3. **A performance that is both benchmarks is exported as two rows,** one per
   `BenchmarkType`, so `AthleteId` + `Distance` + `TimeClass` + `Period` +
   `BenchmarkType` is always exactly one row. The page collapses them into a
   single card carrying both badges, which is what the Calculator already does
   for the same case. Rejected alternative: one row flagged as both, which makes
   the key conditional and diverges from the export this schema mirrors.
4. **`Period` is carried now, with `All Time` as its only value.** Personal
   bests on the athlete page remain all-time only; the column exists so that
   adding Current-period bests later does not require a second trip through the
   workbook, a re-export, and a validator change. Validation pins it to the
   single allowed value until that decision is taken. Rejected alternative:
   omitting it, which is a more honest schema today but puts the cost on the
   expensive side of the boundary.

### What these decisions do not change

`jess-graham-kevan` renders five empty personal-best cards today: the only
public result is one 1 Mile run, and 1 Mile is not among the five distances
either the athlete page or the comparison export supports. Under decision 2 that
athlete has no exported rows and the page still renders five empty cards. This
is unchanged behaviour rather than a regression, and adding 1 Mile is a separate
question about supported distances, not part of this export.

## Repository work this would unblock

In sequence, after the export exists:

1. Add `data/personal_bests.csv` to CSV validation: schema, allowed values,
   uniqueness per athlete/distance/class/period/benchmark, `Period` pinned to
   `All Time`, `SortOrder` ordering, and agreement of every exported performance
   with `data/athlete_results.csv`. That last check is what makes the export
   auditable rather than trusted.
2. **Reconcile the draft export against what the page renders today**, before
   anything is deleted. Compare every athlete, distance, result class, and
   benchmark type in the export against the value the current browser selectors
   produce for the same key, and report every difference. Added 13 August 2026;
   it was missing from the original sequence. Step 1 proves the export agrees
   with `athlete_results.csv`, which is not the same as knowing what visibly
   changes on a profile. Any difference is then either a workbook defect or a
   deliberate supersede, decided at that point rather than noticed later by the
   athlete it concerns. Expect differences to be zero on current data: the audit
   reconciled both existing exports and found none, and the settled tie-break
   changes nothing on data without ties.
3. Render the athlete page from the export, gated on the file appearing in
   `data/export_manifest.csv`, exactly as the Records page is gated.
4. Delete `getFastestResult` and `getBestAgeGradeResult`, plus `distanceMatches`
   and `normaliseDistance`. Verified on 13 August 2026: the two selectors are
   the only callers of that alias matching, so all four go, along with the
   `distances` alias list inside `buildPersonalBests`.
5. Preserve an explicit empty state per benchmark. Do not fall back to browser
   calculation for an athlete missing from the export: a silent fallback would
   restore the two-source problem in the one case where it matters.
6. Extend browser coverage to prove the page renders exported values and shows
   the empty state rather than computing anything.

## Risk if this is left alone

Low today and unbounded later. The audit reconciled both current exports and
found no disagreement: all 70 Family and all 96 Everyone All Time benchmark keys
select the same source performance in both paths. The exposure is that the
agreement is contingent. A tie introduced by new data, or an eligibility or
correction rule applied in the workbook, can move one path without moving the
other, and nothing would fail: the athlete page and the Calculator would simply
show different bests for the same athlete and distance.
