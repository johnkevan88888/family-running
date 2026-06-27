# All-Time Official Crown Progression MVP

## Product boundary

The MVP is a read-only history of the moments when an athlete first won, or later
retook, an **All-Time Official** crown. It is not a history of every improvement
made by an existing holder.

It must not include Current/12-Month crowns. Those rankings can change when
results enter or leave a rolling date window without an athlete taking an
all-time crown, so they are a different product and data model.

Excel/VBA remains the private source of truth. The website must only load,
validate, and display the exported history. JavaScript must not derive the
history from `athlete_results.csv`, Hall of Fame rows, current leaderboard
snapshots, or any other public export.

## Exact MVP experience

Add an **All-Time Official Crown Progression** section to `index.html`,
immediately after Hall of Fame and before the championship leaderboards. This
position connects the history to the current Hall of Fame holder while keeping
it separate from both leaderboard periods and from the athlete-page
“Progression” chart.

The section will:

- explain that it shows only first awards and later transfers of All-Time
  Official crowns, never Current/12-Month crown changes;
- show non-empty crown groups in this order: Overall, Marathon, Half Marathon,
  10 Mile, 10 km, and 5 km;
- show Overall expanded by default when present, otherwise the first exported
  group, with the other groups collapsed;
- show each group's exported entries from oldest to newest as a vertical
  timeline;
- show the effective date, new holder, time, age grade, event, previous-holder
  details when exported, and the exported change reason;
- link a new or previous holder to `athlete.html` only when that holder has an
  exported athlete ID, preserving the active `?site=family` or
  `?site=everyone` mode; and
- use a single-column timeline at mobile widths, without a horizontally
  scrolling results table.

There will be no period selector and no Current/12-Month option. The renderer
will preserve the workbook's exported chronology; it will not calculate who
held a crown before or after a row. A header-only export will produce the
neutral message “No All-Time Official crown progression has been exported.”

## Export contract

The two site modes have independent, required exports:

- `data/family/crown_history.csv`
- `data/everyone/crown_history.csv`

The exact header order is:

```csv
Distance,CrownScope,EffectiveDate,AthleteID,AthleteName,Time,AgeGrade,Event,PreviousAthleteID,PreviousAthleteName,PreviousTime,PreviousAgeGrade,ChangeReason
```

Contract details:

- `Distance` identifies the crown: `Overall`, `Marathon`, `Half Marathon`,
  `10 Mile`, `10 km`, or `5 km`.
- `CrownScope` must be the literal value `All-Time Official` on every row.
- `EffectiveDate` is the official result date on which the exported holder
  change took effect, formatted `DD/MM/YYYY`.
- `AthleteName`, `Time`, `AgeGrade`, and `ChangeReason` are required,
  display-ready values from Excel/VBA. `Event` should be exported when it is
  present in the source result.
- `AthleteID` and `PreviousAthleteID` are stable workbook IDs used only to
  create optional profile links. They must never be generated from names in
  JavaScript.
- The four `Previous*` fields describe the holder immediately before this
  exported change. They are not populated by looking at another website row.
- Rows are exported in the crown order above and, within each crown, in stable
  ascending effective chronology. Same-day changes must use the workbook's
  authoritative result and tie-break order.
- CSV fields containing commas or quotes must use normal CSV quoting.

For `Distance=Overall`, the schema identifies the crown but has no separate
performance-distance field. The MVP will display the exported event, time, and
age grade and will not infer a performance distance from other exports.

## Which moments become rows

VBA emits a row only when its authoritative replay changes a crown holder from
no holder to an athlete, or from one athlete to a different athlete.

- The first qualifying holder is one row with blank `Previous*` fields.
- An existing holder improving their own crown is not a new row.
- An athlete losing and later retaking the same crown is a new row.
- A tie produces a row only if the workbook's existing authoritative
  tie-break rules actually change the holder.
- Current/12-Month, unofficial, and all-results changes are never rows.
- Administrative corrections are not separate timeline events. The export is
  rebuilt from the workbook's presently valid official results in effective
  result-date order.

`ChangeReason` is workbook-owned display text. It must distinguish an initial
award from a transfer and must explicitly identify any row for which the
previous holder is unavailable in the source. JavaScript must not branch on
that text to decide whether a crown changed.

## Vacant crowns and missing former holders

A vacant championship is not a moment when an athlete took a crown.

- VBA must not export a synthetic athlete, `Championship Vacant` row, blank
  transition, or dated vacancy event.
- A crown with no qualifying official result has no rows in this export and no
  timeline group. Its current vacancy remains visible in Hall of Fame.
- If corrections leave no valid history for a crown, that crown likewise has
  no rows.

Missing historical identity data must remain missing:

- do not invent IDs, names, dates, results, events, or reasons;
- when a holder's name is known but their stable ID is not, export the name and
  leave the ID blank; the site renders plain text instead of a profile link;
- for a genuine first award, all `Previous*` fields are blank;
- when a former holder is known only partially, export only the source values
  that exist and make `ChangeReason` state that the former-holder record is
  incomplete; and
- if the new holder's stable ID is unavailable, `AthleteName` is still
  required and is rendered without a link.

## Future Excel/VBA responsibility

The private workbook export process must, independently for Family and
Everyone:

1. Use the same membership, official-result eligibility, age grading,
   distance normalization, overall-crown comparison, and tie-break rules used
   for the existing All-Time Official outputs.
2. Replay all presently valid official results in authoritative effective
   order for each supported crown.
3. Track the prior holder inside VBA and emit only initial awards and changes
   to a different holder.
4. Capture the winning result and immediate previous-holder values at the
   transition; do not attempt to recover them in the website.
5. Emit the exact schema, labels, scope, date format, and stable row order
   defined above, including a header-only file when there are no transitions.
6. Check that each crown's final history holder agrees with the workbook's
   current All-Time Official Hall of Fame/leaderboard export.
7. Write both CSVs as part of the normal atomic website export so a new Hall of
   Fame holder and its history cannot be published in different export runs.

The workbook and its VBA remain private and must not be added to this
repository.

## Likely later repository changes

- `data/family/crown_history.csv` and
  `data/everyone/crown_history.csv`: real VBA-generated exports.
- `index.html`: section container and responsive timeline styling.
- `leaderboard.js`: load the selected mode's export with `fetchCSV`, render
  escaped exported values, and preserve `site` in athlete links.
- `scripts/validate-csv.mjs`: require both exports and validate the exact
  schema, scope, values, chronology, optional IDs, and final-holder
  consistency.
- `tests/browser-smoke.mjs`: cover rendering, mode isolation, navigation,
  empty/vacant behavior, responsive layout, and same-origin requests.
- `docs/testing-and-release-protocol.md`: add the new validation and smoke-test
  coverage once implemented.

`utils.js` should not need to change because `fetchCSV` and `athleteLink`
already provide the required loading and mode-preserving link behavior.
`scripts/build-preview-artifact.mjs` already copies the whole `data/`
directory. Athlete-page files are outside this MVP.

## Proposed test plan

CSV validation for both modes:

- require each file and the exact ordered header;
- reject any `CrownScope` other than `All-Time Official`;
- validate canonical crown labels, `DD/MM/YYYY` dates, times, percentages,
  stable crown grouping, and ascending exported chronology;
- require the new-holder display fields while allowing genuinely missing IDs;
- validate any non-empty ID against `data/athlete_results.csv`, with the
  agreed warning policy for incomplete legacy identities;
- reject `Championship Vacant`, Current/12-Month, unofficial, duplicate, and
  consecutive same-holder transition rows;
- validate first-row and previous-holder field rules; and
- compare the last transition for each non-vacant crown with the corresponding
  All-Time Official Hall of Fame/leaderboard holder.

Browser smoke tests for both `?site=family` and `?site=everyone`, at 1440 x 900
and 390 x 844:

- request only the selected mode's `crown_history.csv`;
- render the exact scope explanation and only exported timeline values;
- keep exported chronology and the defined crown order;
- expand and collapse distance groups;
- preserve the selected `site` parameter in both new- and former-holder links;
- render missing IDs as text and omit unavailable previous fields;
- render no synthetic timeline entry for a vacant crown and show the
  header-only empty state;
- have no horizontal page overflow, JavaScript exceptions, or failed
  same-origin requests; and
- retain all existing Hall of Fame, leaderboard, athlete navigation, medals,
  and responsive screenshot checks.
