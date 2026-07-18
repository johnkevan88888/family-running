# Active Work

## Task title

Site-wide pace display

## Status

Implementation and local validation are complete on `feat/pace-display`.
No merge, release, deployment, production publication, GitHub setting change,
private workbook access, workbook modification, or public CSV data change has
been performed.

## Current approved scope

- Show pace next to rendered running performance times across the public site,
  including leaderboards, Hall of Fame cards, crown history, Overview recent
  results, athlete result tables, personal bests, official medals, crown target
  times, and age-grade standard targets.
- Use the shared header Pace `/km` `/mi` control as the single site-wide pace
  selector, including Age Grade Standards.
- Persist the selected pace unit in local storage using the existing pace unit
  preference key.
- Keep age-grade standard target paces sourced from the exported
  `pace_per_km` and `pace_per_mile` fields.
- Keep JavaScript display-only. Pace is derived from already visible exported
  times and distances; no rankings, age grades, medals, crowns, target times,
  championship outcomes, workbook-owned scores, or public CSV data are changed.
- Leave non-running timestamps, such as the site updated time, without pace.

## Files changed in this pass

- `utils.js`
- `athlete.html`
- `athlete.js`
- `leaderboard.js`
- `site-navigation.js`
- `site.css`
- `athlete.css`
- `tests/browser-smoke.mjs`
- `docs/active-work.md`

## Validation results

- Latest follow-up checks passed:
  - `node --check athlete.js`
  - `node --check tests/browser-smoke.mjs`
  - `pnpm test`
- `pnpm test` refreshed ignored screenshots in
  `test-artifacts/screenshots/`:
  - repository safety validation;
  - CSV validation for Family and Everyone data;
  - export-bundle validation regression tests;
  - staged-export workflow regression tests;
  - browser smoke tests.

## Screenshot review

Inspected regenerated Family screenshots for Championships desktop and mobile,
Hall of Fame mobile, Overview mobile, and the athlete age-grade standards mobile
pace table. The header pace control is readable, `/km` and `/mi` controls fit
beside the site badge, the age-grade standards section no longer has a duplicate
pace toggle, pace text stays inside table cells and cards, and no new overlap or
clipping was observed. Championship tables remain dense on mobile, matching the
existing compact table-first presentation.

## Data note

- No public CSV files were edited. The implementation reads the existing
  exported time and distance fields and renders pace only when a known or
  parseable race distance is available.
- Numeric exported distances such as `1 Mile`, `15 km`, and `30 km` are parsed
  for display pace in addition to the championship distances.

## Known limitations and follow-up opportunities

- Championship tables remain compact on mobile, matching the existing
  table-first presentation. A future task could improve table ergonomics without
  changing exported data or browser-side ownership boundaries.
- Where an exported time has no parseable race distance, the site leaves the
  time unchanged rather than guessing a pace.

## Handoff notes

- Review the Championships landing, Hall of Fame, Overview statistics page, and
  athlete profile pages in both `?site=family` and `?site=everyone`, with the
  Pace control toggled between `/km` and `/mi`.
- Review Netlify previews after the branch is pushed; no merge or release should
  occur without explicit approval.

## Recently completed historical work

- PR #18 static navigation review fixes were completed previously on
  `feat/site-navigation`, including the Championships landing, Hall of Fame,
  Overview, shared navigation, and browser smoke coverage.
- The initial static navigation split for PR #18 created separate public pages
  for Overview, Championships, Hall of Fame, and athlete profiles, with shared
  navigation and browser smoke coverage.
- Staging-root portability for private workbook exports was completed and merged
  previously. The workbook now uses `Settings!tbSettings[Approved Staging Root]`
  and tracked `data/` was promoted from a validated staged bundle.
- Export-bundle modernization was completed previously. Workbook exports stage a
  complete manifest-backed bundle before any explicitly approved promotion to
  tracked public data.
