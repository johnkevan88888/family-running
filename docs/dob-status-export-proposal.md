# Proposed Workbook-Owned DOB Status Export

## Status

- **Status:** Proposal. Design agreed with John on 16 August 2026. The export
  does not exist, and no repository work is approved.
- **Date:** 16 August 2026
- **Open question:** the exact `DOBStatus` vocabulary. See "The one thing still
  unknown".

Following the correction recorded in `docs/decision-log.md` about the workbook
staging parent, this repository must not record workbook behaviour it cannot
verify. Everything below is a *request* to the workbook side, not a statement
about what the workbook does.

## What this is for

The private Participants sheet holds a `DOBStatus` column marking whether an
athlete's date of birth is confirmed or estimated. Nothing about that reaches
the website today.

It matters more than a footnote, because age grade is computed from age. An
estimated date of birth makes the athlete's **age grade** an estimate, and age
grade drives the age-graded category, the championship ranking, the medals that
follow from that ranking, and every target derived from it. The uncertainty is
in the numbers, not in the person.

## What the site shows today

No date of birth is exported at all. Age reaches the site only as a derived
category: `AgeClass` on `halloffame.csv` and `absolute_records.csv` (`F66`), and
`SexAgeEvent` on every leaderboard (`F66|5 km`). There is no marker of any kind,
so every age grade on the site is currently presented with identical confidence,
whether or not the date of birth behind it is known.

## Why this cannot be fixed here

`DOBStatus` exists only in the private workbook. Repository policy forbids
inspecting or modifying it, and `AGENTS.md` forbids the browser deriving values
of this kind. Estimating which dates of birth look approximate from exported
data would be exactly the second source of truth the personal-best work exists
to remove.

## Proposed export

### File and scope

`data/athlete_dob_status.csv`, manifest `Scope` of `shared`.

Shared rather than per-site, because DOB confidence is a property of the athlete
rather than of a championship. The shared athlete page needs it, both site modes
need it, and a per-site copy could disagree with itself.

### Schema

`AthleteId,DOBStatus,ExportBundleID`

- `AthleteId` matches the `AthleteID` values in `data/athlete_results.csv`. The
  spelling follows `athlete_comparison_targets.csv` and the proposed
  `data/personal_bests.csv` rather than the older `AthleteID`; the join is on
  value, not on column name.
- `DOBStatus` is the workbook's own status value. See below.

### Every athlete, not only the unconfirmed ones

The obvious smaller export is a list of unconfirmed athletes alone. It was
considered and rejected: absence would then mean "confirmed", which is
indistinguishable from a broken or empty export. A failure would silently mark
every athlete on the site as having a confirmed date of birth, which is a
failure that fails in the reassuring direction.

With one row per athlete, validation can require that every athlete in
`data/athlete_results.csv` appears exactly once, so a partial export fails
loudly instead. The file is roughly 21 rows either way.

## The one thing still unknown

`Unconfirmed` is the only value confirmed to exist. The complete set has not
been read off the Participants sheet, and this repository must not guess it.

Validation should pin `DOBStatus` to a closed set, so the set has to be stated
before the validator is written. If it turns out to be more than two values, the
rendering question becomes which of them warrant a marker: the contract should
name the marked values explicitly rather than treating "anything that is not
Confirmed" as marked, so a new status added later fails validation instead of
silently inheriting a visual treatment.

## Where the marker has to reach

Thirty-one files per site carry an age grade, plus the shared results file. The
browser joins this export to each of them, and the join column is not spelled
consistently across the existing exports:

| File | Join column(s) |
| --- | --- |
| `athlete_results.csv` | `AthleteID` |
| the 20 leaderboard CSVs | `Athlete ID` |
| `halloffame.csv` | `Athlete ID` |
| `absolute_records.csv` | `Athlete ID` |
| `official_medals.csv` | `AthleteId` |
| `age_grade_standards.csv` | `AthleteId` |
| `crown_standards.csv` | `AthleteId`, `CrownHolderAthleteId` |
| `crown_history.csv` | `AthleteID`, `PreviousAthleteID` |
| `athlete_comparison_targets.csv` | `ChallengerAthleteId`, `StandardAthleteId` |

Joining an exported attribute in order to render it is display work, not
calculation, so it stays within the Excel-owns-calculation rule. It is the same
shape as the existing athlete-link joins.

## Rendering rules

1. **Mark the figure, not only the name.** The marker belongs on the age-graded
   value and its category, because that is what the estimate affects. A marker
   only against the participant name reads as a statement about the person.
2. **A visual difference alone is not enough.** Italics, a colour, or a symbol
   means nothing to a screen reader, and nothing to a sighted reader who has not
   been told the convention. Each marked value needs a text equivalent through
   `title` or `aria-label`, and each page carrying markers needs a legend.
3. **Gate on the manifest.** Render markers only when
   `data/athlete_dob_status.csv` is listed in `data/export_manifest.csv`, the
   same way the Records page is gated. An export without the file renders with
   no markers rather than failing.
4. **Never infer.** An athlete absent from the export is not "confirmed"; it is
   a validation failure. The browser must not fill the gap with an assumption in
   either direction.

## Repository work this would unblock

In sequence, after the export exists:

1. Add `data/athlete_dob_status.csv` to CSV validation: exact schema, one row
   per athlete in `data/athlete_results.csv` and no others, `DOBStatus` within
   the agreed closed set, and export-bundle integrity.
2. Load it once per page through the shared CSV helpers and join it where age
   grades render, using the column map above.
3. Render the marker and its text equivalent, plus a legend on each page that
   can show one.
4. Extend browser coverage to prove a marked athlete renders the marker and its
   accessible equivalent, an unmarked athlete renders neither, and a bundle
   without the file renders the page unmarked rather than breaking.

## Cost worth noting

This adds one more CSV request to every page that renders an age grade. The file
is tiny, but the growing number of CSV requests is already a recorded roadmap
concern under "Measured performance improvements", and this makes it one file
larger on most pages.
