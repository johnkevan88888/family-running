# Official Result News Contract

## Status

- **Product semantics:** Approved on 23 August 2026 for the
  `codex/news-official-results` branch.
- **Implementation status:** First-draft workbook replay, site page, and
  repository validation implemented. The approved 72-file export contains 43
  Family rows and 64 Everyone rows and is promoted into tracked `data/`. The
  hardened CSV contract, complete local suite, artifact build, and both-mode
  desktop/mobile checks pass as of 23 August 2026. Publication remains a
  separate explicit approval. Athlete, year, and distance filters plus a
  latest-first `Show older` refinement were approved later on 23 August 2026;
  that presentation-only refinement is implemented and the complete local
  suite and real-data responsive review pass. A further compact card-flow
  refinement was approved and implemented on 23 August 2026. The full local
  suite, both-mode desktop/intermediate/mobile browser coverage, responsive
  screenshot review, and overflow checks pass. The Pull Request preview update
  passed before the next schema change; nothing is merged or released. A
  workbook-owned medal-position-entry extension was requested on 23 August
  2026. Its 36-column repository contract, focused fixtures, and browser
  presentation are implemented locally. The refreshed staged 72-file workbook
  bundle passed validation and reconciliation, only the two News CSVs changed
  meaningfully, and atomic tracked-data promotion plus focused regression
  validation passed. After the merged Gallery baseline was integrated, the
  complete `pnpm test` suite and combined 114-file artifact build pass. Both
  modes pass browser coverage at 1440px, 720px, and 390px; refreshed
  responsive screenshots were manually reviewed with readable, contained
  medal callouts and badges and no overflow. Merge commit `65190fe` is pushed to
  Pull Request #68; GitHub reports it clean and mergeable, and the required
  static-site check plus combined Deploy Preview passed. Nothing is merged or
  released.
- **Medal-position and displaced-holder extensions:** A real-data review on
  24 August 2026 found that the 36-column entry-only contract correctly left a
  `MedalEntry` blank for an existing-medal upgrade such as Rank 2 to Rank 1,
  but therefore gave the page no workbook-owned way to label the
  Silver-to-Gold change. The resulting 44-column snapshot contract retains the
  four threshold-only `MedalEntry` fields and adds `MedalBefore`/
  `MedalAfter` snapshots. A further approved follow-up grows the contract to
  60 columns by adding a complete-or-blank displaced-holder quartet after each
  `MedalAfter`. This is a coordinated workbook, full-export, validator,
  browser, test, and documentation change; earlier 36- and 44-column evidence
  is historical baseline evidence, not acceptance evidence for the later
  extension.
- **Scope:** Official-result milestones and their reconstructed championship
  effect. This is not an editorial news system.

This contract defines the workbook-owned data required for a new **News** page.
The calculation is intentionally on the Excel/VBA side of the public boundary.
The static website loads and displays the exported rows; it must not identify
personal bests, replay history, calculate deltas, or reconstruct ranks.

## Product boundary

The News page contains one entry for each presently valid official result that:

1. is an athlete's first official result at a supported canonical distance;
2. strictly improves that athlete's full-precision age-grade best at that
   distance;
3. strictly improves that athlete's fastest official raw time at that distance;
   or
4. does both 2 and 3.

The six currently recorded canonical distances are:

1. `Marathon`
2. `Half Marathon`
3. `10 Mile`
4. `10 km`
5. `5 km`
6. `1 Mile`

Distance aliases in the workbook, including `H. Mar`, must be normalized before
milestones are selected. Marathon through 5 km have dedicated championship
distance tables. `1 Mile` is still eligible for News because the workbook's
Official Overall championship includes it, but its distance-table rank fields
are blank because no 1 Mile championship table exists. Any other unsupported
distance is excluded until the workbook and this contract add it deliberately.

Only `TimeClass=Official` is eligible. Unofficial results must not establish a
baseline, improve a baseline, affect a replayed rank, or appear in either News
export.

The first official result at an athlete/distance key is a milestone, but it is
not described as an improvement. It establishes the first age-grade and raw-time
baselines, so its previous-best and improvement fields are blank.

Age-grade and raw-time milestones are selected independently:

- an age-grade milestone requires the new full-precision age grade to be
  strictly greater than the previous full-precision best;
- a raw-time milestone requires the new time to be strictly less than the
  previous fastest time; and
- equalling either best is not an improvement, even when a workbook tie-break
  would select a different representative performance.

The comparison is always per athlete and canonical distance over all earlier
presently valid official results. It is not reset by the Current/12-Month
window. The Current window affects rank snapshots only.

## Meaning of historical

The page is a deterministic reconstruction from the workbook's **current valid
history**, not an archive of what a visitor literally saw on the site years ago.

For each site mode, Excel/VBA must replay all official results that are valid at
the time of export, using the mode's current eligible roster, current result
eligibility rules, canonical distance mapping, full-precision age grades, and
the tie-break rules in [Workbook Tie-Break Rules](tie-break-rules.md).

Consequences of this definition:

- a correction to an old result may rewrite, add, or remove an old News entry;
- deactivation or a current eligibility change applies retroactively to the
  reconstructed history;
- an athlete is not included merely because they appeared in an old published
  bundle; and
- the page must not claim to reproduce historical roster membership,
  administrative state, or a previously published snapshot.

Administrative changes and result expiries are not standalone News entries.
Only a qualifying official result creates a row.

## Authoritative replay order

Excel/VBA processes eligible source results in ascending effective result date.
Results on the same date are processed in ascending authoritative workbook
source order, represented by `SourceRow`. This ordering applies across athletes
and distances, not only within one athlete's results.

For a result being processed:

1. apply all Current-window expiries for that result date;
2. take the four applicable **before** rank snapshots without the new result;
3. evaluate and add the result in authoritative source order;
4. take the four applicable **after** rank snapshots; and
5. emit a News row only if the result meets one of the milestone rules above.

Earlier source rows on the same date therefore affect a later row's before
snapshot. Later source rows on that date do not affect it. A row's rank movement
is the effect of adding that result after expiries, not the combined end-of-day
effect of every race on that date.

## Current and All-Time rank snapshots

For each milestone, export before and after positions where the corresponding
Official championship table is available:

- Current distance;
- Current Overall;
- All-Time distance; and
- All-Time Overall.

The distance rank uses the row's canonical `Distance` when that dedicated table
exists. Overall uses the same cross-distance selection and ordering as the
existing Official Overall championship. A `1 Mile` milestone therefore has
blank Current and All-Time distance triplets, but populated Current and
All-Time Overall triplets.

Rank selection, ordering, eligibility, and ties must come from the same workbook
logic as the corresponding published Official leaderboards. In particular,
full-precision age grade is used even though the News page displays the normal
rounded `AgeGrade` value. The shared tie-break rules determine the representative
performance and final order; the News export must not introduce a second ranking
rule.

### Current window

For a result dated `D`, Current uses the historical equivalent of the workbook's
authoritative `tbRaceResults[Within 12 Months]` rule:

```text
result date > D - 365 days
and
result date <= D
```

The lower bound is strict. Before the before-snapshot, remove results dated on
or before `D - 365 days`; a result exactly 365 days old is outside Current. The
new result and later same-day source rows are absent from the before-snapshot.
This is a fixed 365-day test, not calendar-month subtraction or `EDATE` logic.

This ordering is deliberate. If an older result expires on the race date, the
before position is the athlete's position after that expiry; `PlacesGained`
then isolates the movement caused by the new race.

### All-Time window

All-Time contains every earlier presently valid official result already
processed in the replay. Its before-snapshot excludes the new result; its
after-snapshot includes it.

## Export files

The workbook must create one required, site-specific, denormalized export per
complete bundle:

- `data/family/official_result_news.csv`
- `data/everyone/official_result_news.csv`

The files are site-specific because the same performance can produce different
rank movements in Family and Everyone, or can be eligible in only one mode.
Each file has the corresponding `family` or `everyone` manifest scope and must
carry the current bundle's `ExportBundleID`. A mode with no qualifying rows
still exports the header-only file.

The exact ordered header is the concatenation of the following five lines,
with no line breaks inserted:

```text
SortOrder,SourceRow,AthleteID,AthleteName,ResultDate,Distance,Time,AgeGrade,AgeGradeExact,Event,TimeClass,MilestoneType,PreviousBestTime,TimeImprovementSeconds,TimeImprovement,PreviousBestAgeGrade,PreviousBestAgeGradeExact,AgeGradeImprovementExact,AgeGradeImprovement,
CurrentDistanceRankBefore,CurrentDistanceRankAfter,CurrentDistancePlacesGained,CurrentDistanceMedalEntry,CurrentDistanceMedalBefore,CurrentDistanceMedalAfter,CurrentDistanceDisplacedAthleteID,CurrentDistanceDisplacedAthleteName,CurrentDistanceDisplacedMedalBefore,CurrentDistanceDisplacedMedalAfter,
CurrentOverallRankBefore,CurrentOverallRankAfter,CurrentOverallPlacesGained,CurrentOverallMedalEntry,CurrentOverallMedalBefore,CurrentOverallMedalAfter,CurrentOverallDisplacedAthleteID,CurrentOverallDisplacedAthleteName,CurrentOverallDisplacedMedalBefore,CurrentOverallDisplacedMedalAfter,
AllTimeDistanceRankBefore,AllTimeDistanceRankAfter,AllTimeDistancePlacesGained,AllTimeDistanceMedalEntry,AllTimeDistanceMedalBefore,AllTimeDistanceMedalAfter,AllTimeDistanceDisplacedAthleteID,AllTimeDistanceDisplacedAthleteName,AllTimeDistanceDisplacedMedalBefore,AllTimeDistanceDisplacedMedalAfter,
AllTimeOverallRankBefore,AllTimeOverallRankAfter,AllTimeOverallPlacesGained,AllTimeOverallMedalEntry,AllTimeOverallMedalBefore,AllTimeOverallMedalAfter,AllTimeOverallDisplacedAthleteID,AllTimeOverallDisplacedAthleteName,AllTimeOverallDisplacedMedalBefore,AllTimeOverallDisplacedMedalAfter,ExportBundleID
```

This is a 60-column contract. Each rank context has three rank fields, three
medal fields, and four displaced-holder fields. The quartet follows that
context's `MedalAfter` field.

No column may be renamed, omitted, reordered, or added without a coordinated
workbook, validator, browser, test, and documentation change.

## Column contract

### Identity and display order

- `SortOrder` is a required positive integer, unique and contiguous from `1`
  within the file. Rows are physically exported in ascending `SortOrder`.
  `1` is the newest entry. Dates therefore descend; within one date, later
  authoritative `SourceRow` values appear before earlier values so the display
  is the reverse of replay order.
- `SourceRow` is the required positive, unique worksheet source row for the
  result. It is audit metadata and the same result carries the same source row
  in both site modes. The browser must not display it or use it to calculate
  anything.
- `AthleteID` is the required stable workbook athlete ID. It must exist in
  `data/athlete_results.csv` and be eligible for the export's site mode.
- `AthleteName` is the required workbook display name and must agree with the
  source result. JavaScript must not derive it from `AthleteID`.
- `ResultDate` is the source result date in `DD/MM/YYYY` format.
- `Distance` is one of the six canonical labels in this contract.
- `Event` is source event text. It may be blank only when the source genuinely
  has no event; no placeholder is invented. Repository source matching treats
  that blank as equivalent to the existing `athlete_results.csv` `UNKNOWN`
  placeholder for the same source row.
- `TimeClass` is required and must be the literal `Official`.
- `ExportBundleID` is required and must match the complete export manifest.

### Source performance

- `Time` is the source result's raw time, normalized to millisecond precision
  and formatted as `HH:MM:SS` with an optional one-to-three digit fractional
  suffix. Unlike the existing public result exports, it retains a genuine
  sub-second value when the workbook has one.
- `AgeGrade` is the workbook's normal display value, including `%`, rounded by
  the existing workbook display rule.
- `AgeGradeExact` is the same result's age grade at the workbook's full working
  precision, including `%`. It is not rounded to the display value and is not
  shown on the page. Rounding it through the workbook's normal display rule must
  reproduce `AgeGrade`.

### Milestone type

`MilestoneType` is required and has exactly four allowed values:

- `First Official Result`
- `Age Grade PB`
- `Raw-Time PB`
- `Age Grade + Raw-Time PB`

The value controls which previous-best and improvement fields are populated.
The browser may use it to choose exported-value labels and badges; it must not
infer the type by comparing values.

### Raw-time improvement

- `PreviousBestTime` is the athlete's fastest earlier official time at this
  canonical distance.
- `TimeImprovementSeconds` is the positive number of seconds, to at most three
  decimal places, by which `Time` beats `PreviousBestTime`.
- `TimeImprovement` is the same positive duration formatted as `HH:MM:SS` with
  the same optional fractional suffix and no sign. The page supplies the
  static word `faster`.

The three fields are required for `Raw-Time PB` and
`Age Grade + Raw-Time PB`, and blank otherwise. They satisfy:

```text
TimeImprovementSeconds = PreviousBestTime - Time
```

when both times are expressed in seconds. A zero or negative improvement is
invalid.

### Age-grade improvement

- `PreviousBestAgeGrade` is the normal displayed age grade of the performance
  holding the athlete's earlier full-precision best at this canonical distance.
- `PreviousBestAgeGradeExact` is that earlier best at full working precision,
  including `%`.
- `AgeGradeImprovementExact` is the positive full-precision percentage-point
  difference, including `%`, satisfying:

  ```text
  AgeGradeImprovementExact = AgeGradeExact - PreviousBestAgeGradeExact
  ```

- `AgeGradeImprovement` is workbook-owned display text. For a difference that
  rounds half up to at least `0.01` percentage points at two decimal places, it
  is `+N.NN pp`; a positive difference that would round to `0.00` is
  `+<0.01 pp`. The exact difference is fixed-decimal subtraction of the two
  exported exact values, not binary floating-point arithmetic. It must never
  display a genuine improvement as zero.

The four fields are required for `Age Grade PB` and
`Age Grade + Raw-Time PB`, and blank otherwise. A zero or negative exact
difference is invalid. `PreviousBestAgeGrade` and `AgeGrade` may legitimately
look identical at one decimal place; the exact values and non-zero improvement
text explain that small but real milestone.

For a combined milestone, the prior age-grade best and prior fastest time may
come from different performances. The row deliberately reports each benchmark
independently.

### First-result blanks

For `First Official Result`, all of these fields are blank:

- `PreviousBestTime`
- `TimeImprovementSeconds`
- `TimeImprovement`
- `PreviousBestAgeGrade`
- `PreviousBestAgeGradeExact`
- `AgeGradeImprovementExact`
- `AgeGradeImprovement`

The page explains that the result established both baselines. It must not show
`0`, `0.0%`, `00:00:00`, or a fabricated previous result.

### Rank and movement fields

Each table has a `RankBefore`, `RankAfter`, and `PlacesGained` triplet:

- `CurrentDistanceRankBefore`, `CurrentDistanceRankAfter`,
  `CurrentDistancePlacesGained`
- `CurrentOverallRankBefore`, `CurrentOverallRankAfter`,
  `CurrentOverallPlacesGained`
- `AllTimeDistanceRankBefore`, `AllTimeDistanceRankAfter`,
  `AllTimeDistancePlacesGained`
- `AllTimeOverallRankBefore`, `AllTimeOverallRankAfter`,
  `AllTimeOverallPlacesGained`

Ranks are positive integers copied from the workbook's before and after
snapshots. `PlacesGained` is a non-negative integer and, when both ranks exist,
must equal `RankBefore - RankAfter`.

The blank rules are exact:

| Before | After | Places gained | Meaning and rendering |
| --- | --- | --- | --- |
| integer | integer | integer | Ranked before and after. Render `#before to #after`; show `up N places` when positive and `no rank change` when zero. |
| blank | integer | blank | Previously unranked. Render `Unranked to #after`; do not invent a numeric places-gained value. |
| blank | blank | blank | That Official table is unavailable for this mode/distance. Omit this table's movement block. |
| integer | blank | any | Invalid. Adding an eligible official result cannot remove the athlete from the after table. |
| blank | integer | integer | Invalid. A numeric gain from an unranked state has no defined starting rank. |
| any other partial combination | any | any | Invalid. |

When an applicable Official table exists, `RankAfter` is required because the
new result is eligible for that table. An available table may have the same
before and after rank; this is expected for many raw-time-only milestones.

The browser must not subtract ranks, assign ordinals, infer unavailable tables,
or change the exported wording based on a calculated outcome. It only selects
the rendering case from the validated blank pattern and displays `#` plus the
exported integers.

### Medal-position fields

Each rank context has three aligned workbook-owned medal fields and an optional
four-field displaced-holder attribution:

| Rank context | Threshold entry | Before snapshot | After snapshot | Displaced-holder quartet |
| --- | --- | --- | --- | --- |
| Current Distance | `CurrentDistanceMedalEntry` | `CurrentDistanceMedalBefore` | `CurrentDistanceMedalAfter` | `CurrentDistanceDisplacedAthleteID`, `CurrentDistanceDisplacedAthleteName`, `CurrentDistanceDisplacedMedalBefore`, `CurrentDistanceDisplacedMedalAfter` |
| Current Overall | `CurrentOverallMedalEntry` | `CurrentOverallMedalBefore` | `CurrentOverallMedalAfter` | `CurrentOverallDisplacedAthleteID`, `CurrentOverallDisplacedAthleteName`, `CurrentOverallDisplacedMedalBefore`, `CurrentOverallDisplacedMedalAfter` |
| All Time Distance | `AllTimeDistanceMedalEntry` | `AllTimeDistanceMedalBefore` | `AllTimeDistanceMedalAfter` | `AllTimeDistanceDisplacedAthleteID`, `AllTimeDistanceDisplacedAthleteName`, `AllTimeDistanceDisplacedMedalBefore`, `AllTimeDistanceDisplacedMedalAfter` |
| All Time Overall | `AllTimeOverallMedalEntry` | `AllTimeOverallMedalBefore` | `AllTimeOverallMedalAfter` | `AllTimeOverallDisplacedAthleteID`, `AllTimeOverallDisplacedAthleteName`, `AllTimeOverallDisplacedMedalBefore`, `AllTimeOverallDisplacedMedalAfter` |

Every one of these 12 fields is blank or exactly `Gold`, `Silver`, or
`Bronze`. They are historical snapshot metadata owned by the workbook, not
editorial labels invented by the page.

`MedalEntry` continues to record a threshold crossing in its context, not every
movement within the medal places:

```text
if RankAfter is 1, 2, or 3
and RankBefore is blank or at least 4
then MedalEntry is Gold, Silver, or Bronze respectively
otherwise MedalEntry is blank
```

`MedalBefore` is the workbook's medal label for `RankBefore`; `MedalAfter` is
the label for `RankAfter`. For either field, Rank 1 is `Gold`, Rank 2 is
`Silver`, Rank 3 is `Bronze`, and an unranked or Rank 4+ state is blank. Thus
unranked to Rank 2 exports `Silver`, blank, `Silver` across Entry, Before, and
After; Rank 4 to Rank 3 exports `Bronze`, blank, `Bronze`; and Rank 3 to Rank 2
exports blank, `Bronze`, `Silver`. In particular, Rank 2 to Rank 1 exports a
blank `MedalEntry`, `Silver` `MedalBefore`, and `Gold` `MedalAfter`.

`MedalEntry` must never be overloaded to mean a medal upgrade, a retained medal
position, or a generic after-medal label. Its blank value is valid for all of
those cases.

A displaced-holder quartet is populated only when the News athlete changed into
a medal position and the workbook can identify one other selected-mode athlete
who held that exact `MedalAfter` in the before snapshot and lost it in the
after snapshot. All four fields are otherwise blank. A populated quartet has a
public active athlete ID and matching public name; it must never name the News
athlete. `DisplacedMedalBefore` equals the News athlete's `MedalAfter`, and
the only permitted handoffs are `Gold → Silver`, `Silver → Bronze`, and
`Bronze → No medal`. `No medal` is valid only as the resulting displaced
state, never as a focal medal snapshot.

The browser must render a handoff only from a complete valid quartet. It may
link the exported displaced athlete ID, but it must not infer a former holder,
choose among ties, derive a `No medal` state from rank, or fetch another
export to repair a missing quartet.

The four contexts are independent. One result can have different before and
after medals and different displaced holders in several tables, and Family and
Everyone may legitimately differ for the same source result. `1 Mile` has no
distance table, so all ten rank, medal, and displaced-holder fields for each of
its Distance contexts are blank while either Overall context may be populated.
A wholly unavailable table also leaves all ten aligned fields blank.

Medal names follow the workbook's exported competition rank directly. Rank 1
is Gold, Rank 2 is Silver, and Rank 3 is Bronze. A tied athlete carrying one of
those ranks receives the same value; skipped competition ranks create no medal.
Repository validation may check this closed mapping against the workbook-owned
ranks, but the browser must use the exported medal fields and never use a rank
or leaderboard row position to manufacture a medal label or tie-break.

These fields describe reconstructed historical medal positions. They are not a
claim that a final medal was permanently won: corrections or eligibility changes
can revise the replay just as they can revise any other historical News
movement.

## Workbook responsibilities

For each site mode, Excel/VBA must:

1. select the current eligible roster and all presently valid source results
   before replay begins;
2. exclude every non-official result before baseline, milestone, window, and
   ranking logic;
3. normalize the six recorded distances, use blank distance-rank triplets for
   1 Mile, and ignore unsupported distances;
4. replay results in the authoritative date/source order defined above;
5. maintain independent all-time age-grade and raw-time bests for every
   athlete/canonical-distance key;
6. apply Current expiries before every before-snapshot;
7. obtain all four rank snapshots from the same workbook ranking logic used by
   the existing Official tables;
8. populate display, exact, delta, rank, all 12 medal-position fields, all 16
   displaced-holder fields, blank-state, source-row, and ordering fields
   without relying on the browser;
9. emit only the four milestone types defined here, with one row per qualifying
   source result per mode;
10. validate the replay and compare its final Current and All-Time state with
    the same export bundle's Official leaderboards; and
11. write both files as part of the atomic full export before
    `data/export_manifest.csv` is written.

The workbook's post-export validation is essential. The public result export
does not currently expose a full-precision age grade or authoritative source
order for every non-News result, so repository code cannot independently prove
that no exact age-grade milestone was omitted or that every historical rank is
correct.

## Repository validation

`scripts/validate-csv.mjs` should fail closed for both modes and must, at
minimum:

- require each file through `data/export_manifest.csv`, with the correct site
  scope, row count, and bundle ID;
- require the exact ordered header and matching row lengths;
- accept a header-only file;
- validate contiguous file-order `SortOrder`, positive unique `SourceRow`,
  descending dates, and reverse authoritative source order within one date;
- validate required identities, mode eligibility, one of the six canonical
  distances, literal
  `Official`, date, time, percentage, positive-number, and closed-enum formats;
- match every row's source identity, date, event, class, distance, rounded
  public time, and displayed age grade to exactly one row in
  `data/athlete_results.csv`, allowing only the existing approved distance
  aliases to normalize to `Distance`; the shared public export is allowed to
  round a News time that retains genuine sub-second source precision;
- require `AgeGradeExact` to round to `AgeGrade`;
- enforce all `MilestoneType` population and blank rules;
- verify raw-time and age-grade delta arithmetic from the exported previous and
  new values;
- verify that every displayed age-grade improvement follows the two-decimal or
  less-than rule and never renders a positive exact improvement as zero;
- validate the milestone chain in replay order: exactly one first result per
  emitted athlete/distance history, strictly increasing exact age-grade PBs,
  strictly decreasing raw-time PBs, and previous-best values agreeing with the
  prior exported milestone for that benchmark;
- reject duplicate source results and duplicate athlete/date/distance/source
  milestone rows;
- enforce the complete rank-triplet blank matrix, positive ranks, non-negative
  gains, and `before - after` arithmetic where both ranks exist;
- require every aligned `MedalEntry`, `MedalBefore`, and `MedalAfter` field to
  be blank, `Gold`, `Silver`, or `Bronze`; require the snapshot values to match
  their corresponding before/after competition ranks exactly; require the
  exact after-rank `MedalEntry` only for an unranked/Rank 4+ crossing into Rank
  1/2/3; reject a missing, wrong, unsupported, or extraneous value; allow
  independent multi-context and cross-mode values; and
- require each displaced-holder quartet to be complete or blank, selected-mode
  public, non-self-referential, aligned with the focal `MedalAfter`, and one of
  the three allowed handoff chains; and require all ten 1 Mile distance context
  fields to be blank; and
- reject any row containing `Unofficial`, a vacancy placeholder, a distance
  outside the six-value contract, a zero/negative improvement, or an invented
  previous value for a first result; and require both distance-rank triplets to
  be wholly blank for `1 Mile` while its Overall after-ranks remain populated.

Repository validation may check internal arithmetic and agreement with public
source rows, but it must not generate the News feed or treat a browser-side
replay as authoritative. Completeness of full-precision milestones and exact
historical ranks remains a workbook export responsibility.

Focused validation fixtures should prove rejection of every enum, chronology,
source, delta, rank, medal-position, displaced-holder, blank-state, and bundle
failure above, including valid Gold/Silver/Bronze crossings, valid `Silver` to
`Gold` and retained-medal snapshots, all three permitted handoffs, multiple
contexts on one row, a tied competition rank, a within-medal move with a blank
`MedalEntry`, and a valid tiny exact age-grade improvement whose one-decimal
before and after values are equal.

## News page behavior

The eventual `news.html` page should:

- use mode-neutral title, description, and Open Graph copy;
- carry the required viewport and `noindex, follow` metadata;
- load only `data/<selected-site>/official_result_news.csv` and preserve
  `?site=family` or `?site=everyone` in navigation and athlete links;
- show entries newest first in exported `SortOrder`, using a responsive
  single-column timeline or card list rather than a wide table;
- make each desktop card a compact left-to-right flow from Result, through the
  exported PB improvement or first-result baseline, to the exported
  Championship movement, while keeping that same reading order in a compact
  vertical flow on mobile;
- show date, athlete, canonical distance, event when present, result time, and
  displayed age grade;
- link the athlete name with the exported `AthleteID` through the shared
  mode-preserving athlete-link helper;
- show one of the four exported milestone labels, without inferring it;
- for a first result, say that it established the official age-grade and
  raw-time baselines;
- for an age-grade PB, show previous displayed age grade, new displayed age
  grade, and `AgeGradeImprovement` as percentage points;
- for a raw-time PB, show previous best time, new time, and `TimeImprovement`
  followed by `faster`;
- show both independently for a combined milestone;
- group rank movement under `Current` and `All Time`, with Distance and Overall
  rows, applying only the validated blank/rendering cases in this contract;
- when one or more exported medal-entry fields are populated, make the card
  visibly celebratory, show the explicit text `Medal breakthrough!` and
  `Entered a medal-winning position`, and label each affected movement row as
  a new Gold, Silver, or Bronze medal position using that field's exported
  value;
- when a movement has an existing-medal snapshot, show its workbook-exported
  before/after label beside that same row (for example, `Silver` to `Gold`)
  without calling it a new entry; a retained medal position must likewise have
  visible text rather than relying on colour alone. An entry row may retain its
  existing `New Gold medal position` label rather than duplicating a blank-to-
  Gold snapshot label;
- when that same movement carries a complete displaced-holder quartet, show the
  workbook-exported former holder and their exported handoff (for example,
  `Gold taken from Alex — Alex: Gold to Silver`) beside the same row; and
- omit an unavailable movement block, but show `no rank change` rather than
  hiding a valid zero movement;
- render the neutral header-only state `No official result milestones have been
  exported.`;
- render a clear unavailable state if the selected export cannot be loaded,
  without falling back to `athlete_results.csv` or another mode's file;
- escape every exported value that reaches markup; and
- remain usable at desktop and mobile widths without page-level horizontal
  overflow.

Badges and movement must not rely on colour alone. Medal-position treatment
must include visible text in addition to colour and decorative medal/sparkle
icons. Entries should use semantic headings or list structure so dates,
athlete names, milestone types, and rank
changes remain understandable to screen readers. Arrows may guide the eye
between card stages and successive timeline entries, but they are decorative,
hidden from assistive technology, and must not be the only indication of order
or meaning.

The browser may format ordinary presentation around validated values. It must
not compare performances, subtract times or percentages, calculate rank gains,
replay a rolling window, choose a milestone type, derive a medal from a rank,
or repair a missing export. It may inspect the validated exported
`MedalEntry`, `MedalBefore`, `MedalAfter`, and complete displaced-holder
quartet alongside the existing movement blank-pattern case to choose
presentation, but it must not turn a rank number into a medal label or former
holder. Only `MedalEntry` may trigger the card accent and `Medal
breakthrough!` callout.

### Presentation filters and progressive reveal

The page may help visitors navigate a long selected-mode feed without changing
the exported News contract:

- Athlete, Year, and Distance controls are optional presentation filters and
  default to all values.
- Filter choices are derived only from the already loaded selected-site News
  rows. Athlete filtering uses the exported athlete identity, Year uses the
  exported `ResultDate`, and Distance uses the exported canonical `Distance`.
- Filters combine, so an entry is shown only when it matches every active
  control. Matching entries retain their workbook-exported newest-first
  `SortOrder`.
- The initial view contains the 12 newest matching entries. `Show older`
  reveals the next 12 matching entries in the same order.
- Changing any filter resets the view to the 12 newest matching entries.
  `Reset filters` clears all three controls and restores the first 12 newest
  entries.
- The page reports `Showing X of Y milestones`, provides a clear no-matches
  state, and hides or disables `Show older` when every matching entry is
  visible.
- Filter controls are not shown in the header-only or failed-load states.
- Filtering and progressive reveal must not trigger another CSV request,
  switch site modes, alter athlete links, or discard the loaded rows.

These controls may compare exported identity, date, and distance fields solely
to decide which existing cards are visible. They must not derive a milestone,
improvement, rank, eligibility state, or new ordering. Clearing all filters and
revealing all batches must reproduce the selected site's complete exported feed
in its original order.

## Browser and responsive coverage

Browser smoke tests should cover both modes at desktop and mobile sizes and
prove that the page:

- requests only the selected mode's News export;
- preserves the selected mode in navigation and athlete links;
- renders all four milestone types from synthetic workbook-owned rows;
- renders exact first-result, improvement, tiny-improvement, unranked, no-rank-
  change, places-gained, and unavailable-table states;
- renders an explicit card-level medal breakthrough and per-context exported
  Gold/Silver/Bronze labels, supports multiple medal entries on one result,
  renders exported before/after labels for upgrades such as `Silver` to
  `Gold`, renders complete exported displaced-holder handoffs including
  `Bronze` to `No medal`, does not mark a within-medal move as a new entry, and
  does not infer either a medal marker, medal snapshot, or former holder from
  RankBefore/RankAfter when the corresponding exported field is blank;
- retains exported order, including multiple same-day results;
- handles quoted commas, escaped quotes, and multiline event text through the
  shared whole-document CSV parser;
- shows the header-only and failed-load states without calculating a fallback;
- starts with the 12 newest matches, reports `Showing X of Y milestones`, and
  reveals the next 12 matching rows in order through `Show older`;
- offers Athlete, Year, and canonical Distance choices from the loaded selected-
  mode rows, combines all three filters, resets the visible batch after a
  filter change, supports `Reset filters`, and renders a no-matches state;
- hides the filtering interface for header-only and failed-load states and
  performs filtering and progressive reveal without another data request or a
  row from the other site mode;
- presents each populated desktop card in Result, improvement/baseline, then
  Championship movement order; preserves that order when compactly stacked on
  mobile; and exposes any visual arrow connectors as decorative rather than
  accessible content;
- exposes no `SourceRow`, `SortOrder`, exact-age-grade, or `ExportBundleID`
  values;
- has no JavaScript exceptions, failed same-origin requests, or horizontal page
  overflow; and
- leaves existing championship, Overview, Hall of Fame, Records, Calculator,
  gallery, and athlete behavior unchanged.

Responsive screenshots for Family and Everyone should include at least one
combined milestone and one entry with all four rank movements visible.

## Caveats to explain on the page

The introductory copy should state, in plain language, that:

- News contains official results only;
- milestones are personal to each athlete and distance;
- positions are reconstructed from the championship's currently valid result
  history, so corrections or eligibility changes can revise older entries;
- Current uses the workbook's rolling 365-day rule ending on that race date;
  and
- ranking movement uses age-graded championship tables, so a raw-time PB can
  legitimately show no position change.

The implementation must also preserve these less-visible truths:

- first results establish baselines and have no numeric improvement;
- an age-grade improvement can be real at full precision while both displayed
  age grades round to the same one-decimal value;
- same-day positions are sequential in workbook source order, not one combined
  end-of-day table;
- Current-window expiries can change the before position but do not create
  their own News entries;
- a result can appear in both site modes with different ranks, or in Everyone
  only; Family is a subset of Everyone, so every Family milestone must have an
  identical source milestone in Everyone while its ranks and `SortOrder` may
  differ;
  and
- no Overall raw-time PB exists because raw times across different distances
  are not comparable. Overall columns describe championship rank movement, not
  a cross-distance time record.

## Likely implementation sequence

1. Build and independently validate both workbook exports in a fresh staged
   bundle.
2. Reconcile sample milestone chains and before/after ranks against workbook
   sheets before promoting any data.
3. Add the repository schema and failure fixtures.
4. Add the page, selected-mode loader, shared navigation entry, styles, and
   public-artifact runtime entries.
5. Add browser behavior and responsive screenshot coverage.
6. Run the complete staged-export, repository, artifact, and both-mode browser
   protocol before review.

The private workbook and its VBA remain outside Git throughout this work.
