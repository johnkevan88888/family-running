# Workbook-Owned Athlete Deactivation Requirements

## Status

- **Status:** Approved by John on 21 August 2026.
- **Implementation:** Completed in the authorized private workbook working copy
  on 21 August 2026.
- **Repository impact:** Requirements and validation only. No website runtime
  change is required. The validated export is promoted locally on the review
  branch but has not been committed or published.

These are requirements for the private Excel/VBA source of truth. John gave
explicit permission to inspect and modify the named working copy after a backup
was made. A timestamped backup was created outside the repository and verified
byte-for-byte before the working copy was changed. The workbook and its backup
remain private and outside Git.

## Required outcome

Changing a participant to an inactive value in the Participants sheet's
`ProfileStatus` column removes every mention of that athlete from the current
website after the next complete approved export and publication.

Removal is retroactive as well as prospective:

- none of the athlete's historical results are published;
- no new result for the athlete is published while they remain inactive;
- the athlete is absent from both `?site=family` and `?site=everyone`; and
- an old `athlete.html?id=...` URL renders the existing "Athlete not found"
  state.

This is removal from the current website, not erasure. Names and results in old
public Git commits remain available. Rewriting Git history is explicitly out of
scope.

## Workbook implementation boundary

The workbook must determine eligibility from `ProfileStatus`. The browser must
not receive `ProfileStatus`, infer it, or hide an athlete after their data has
already been published.

The confirmed `ProfileStatus` vocabulary is exactly `Active` and `Inactive`.
The workbook uses that closed set and fails the full export on a blank or
unknown value. It does not assume that every value other than one spelling of
`Inactive` is active.

Only eligible active participants may enter any website-source calculation or
export. Filtering an athlete out after ranks, medals, records, or crown history
have been calculated does not meet this requirement.

The implemented controls are upstream and fail closed:

- the Participants table provides an `Active`/`Inactive` validation list;
- `tbRaceResults[Profile Active]` is true only when the participant lookup
  resolves exactly to `Active`;
- leaderboard, Hall of Fame, profile-result, absolute-record, crown-history,
  crown-standard, age-grade-standard, and athlete-comparison sources exclude
  inactive athletes before selection or ranking; and
- pre-export validation checks the status vocabulary and source wiring, while
  post-export validation scans every staged CSV for inactive athlete IDs or
  names and stops the export if it finds one.

## Calculations that must be rebuilt

After the eligibility filter is applied, the workbook must recalculate all
website-owned outputs from the remaining eligible results, including:

- Family and Everyone leaderboards, with complete rank sequences;
- official medals;
- Hall of Fame holders;
- absolute records;
- All-Time Official crown history;
- crown standards and targets;
- age-grade standards;
- athlete comparison targets; and
- the shared athlete-results export used by profile pages.

Removing an athlete may legitimately promote other athletes, reassign medals
or records, change a Hall of Fame holder, and replay crown history differently.
Those are required consequences, not differences to suppress.

## Public export contract

The inactive athlete's ID and name must be absent from every applicable public
CSV in the complete bundle, including:

- `data/athlete_results.csv`;
- every enabled leaderboard named by each mode's `webtables.csv`;
- `halloffame.csv`;
- `official_medals.csv`;
- `absolute_records.csv`;
- `crown_history.csv`, as both current and previous holder;
- `crown_standards.csv`, as both challenger and holder;
- `age_grade_standards.csv`; and
- `athlete_comparison_targets.csv`, as both challenger and standard.

Do not add `ProfileStatus` to any public CSV, the export manifest, page markup,
or JavaScript.

The exporter must still produce one complete bundle with one new
`ExportBundleID`, write `data/export_manifest.csv` last, and satisfy the
existing manifest and row-count contract.

## Acceptance checks

Use a non-production test participant first. A successful staged export must
show all of the following before tracked data is promoted:

1. The inactive athlete's ID and name do not appear anywhere in the staged
   `data/` tree.
2. The athlete's old profile URL renders "Athlete not found" in both site modes.
3. Both site modes render without the athlete in leaderboards, records, Hall of
   Fame, comparison controls, medals, standards, or crown history.
4. Rankings are recalculated rather than left with a gap. Standard competition
   ranking remains valid for genuine ties.
5. Medals, records, Hall of Fame, crown history, and targets agree with the
   newly calculated eligible population.
6. CSV validation, export-bundle regression tests, repository safety checks,
   vendored-library validation, preview-artifact safety tests, and browser smoke
   tests all pass.
7. Desktop and mobile screenshots for Family and Everyone are reviewed for the
   expected downstream changes.

## Implementation verification

The authorized working copy passed its pre-export and post-export validation on
21 August 2026. A fresh bundle with ID
`20260822T013004265Z-1DF86180` passed repository CSV and staged-bundle validation
with all 68 public CSV files present.

The workbook already contained two `Inactive` participants, providing a direct
acceptance case. Their names and IDs had references in 12 tracked public files;
the staged bundle contains zero references to either athlete. The comparison
shows only the expected removals and downstream re-ranking or row-count changes
in Everyone mode. All Family-mode values are unchanged apart from volatile
bundle metadata. The validated bundle was subsequently promoted into tracked
`data/` on the local `codex/athlete-deactivation` review branch.

The full repository test suite passed. Browser smoke tests and responsive
screenshots also passed against an ignored preview populated with the staged
bundle, and a focused check confirmed both inactive athletes' old profile URLs
render `Athlete not found` in Family and Everyone modes. The complete suite and
focused profile check passed again after local promotion. Nothing has been
published; release still requires Pull Request review and explicit merge
approval.

The current repository validation reports references to an athlete missing from
`data/athlete_results.csv` and fails core leaderboard, Hall of Fame, medal,
record, history, and comparison inconsistencies. Some legacy-compatible
standards references are warnings rather than errors. It also rejects
leaderboard rank gaps. It cannot detect an inactive athlete who was mistakenly
exported consistently everywhere, because `ProfileStatus` deliberately never
leaves the private workbook. The workbook therefore needs its own pre-export
coverage check that no inactive participant enters any website-source range.

## Release pathway

Generate a fresh complete staged bundle and follow
[Workbook Website Export Workflow](workbook-export-workflow.md). Expect a large
multi-file diff when a ranked athlete is removed. Review every meaningful
difference and use the guided updater's separate `MERGE` checkpoint for final
publication approval.

Do not selectively copy edited CSVs and do not publish directly from the
workbook.
