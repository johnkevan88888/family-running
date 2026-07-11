# Active Work

## Task title

PR #18 static navigation review fixes

## Status

Implementation and local validation are complete on `feat/site-navigation` for
PR #18 review. No merge, release, deployment, production publication, GitHub
setting change, private workbook access, or workbook modification has been
performed.

## Current approved scope

- Keep normal static page navigation, but make `index.html` the Hall of Fame
  landing page.
- Keep `championships.html` as the full championship standings page.
- Add `overview.html` as a descriptive statistics page showing leaderboard
  participation totals, results recorded in the latest exported year, official
  results in that year, latest recorded result date, most active athletes, and
  the most recent exported results.
- Remove the Family/Everyone switch UI. They are separate sites; the current
  site is shown as a non-clickable badge, and incoming `?site=family` or
  `?site=everyone` is preserved across same-site navigation and athlete links.
- Use the order Hall of Fame, Championships, Overview in the shared header.
- Remove the old Overview championship-exploration section.
- Keep JavaScript display-only. The Overview statistics describe existing public
  exported rows and site-scoped athlete IDs; they do not calculate championship
  rankings, honours, medals, crowns, records, age grades, or workbook-owned
  outcomes.

## Files changed in this review-fix pass

- `index.html`
- `overview.html`
- `leaderboard.js`
- `site-navigation.js`
- `site.css`
- `scripts/build-preview-artifact.mjs`
- `tests/browser-smoke.mjs`
- `docs/active-work.md`
- `docs/decision-log.md`

## Validation results

- JavaScript syntax checks passed for:
  - `leaderboard.js`
  - `site-navigation.js`
  - `tests/browser-smoke.mjs`
  - `scripts/build-preview-artifact.mjs`
- Browser smoke tests passed after writing ignored screenshots to
  `test-artifacts/screenshots/`.
- Full `pnpm test` passed:
  - repository safety validation;
  - CSV validation for Family and Everyone data;
  - export-bundle validation regression tests;
  - staged-export workflow regression tests;
  - browser smoke tests.
- `pnpm screenshots:update` passed and regenerated ignored page screenshots.
- After the navigation review-fix commit, a newer validated public export bundle
  was promoted into tracked `data/` and `pnpm test` passed again.

## Screenshot review

Inspected the regenerated Hall of Fame, Championships, and Overview screenshots
for both Family and Everyone modes on desktop and mobile. The shared header is
readable, the active page is clear, the current-site badge is separate from page
navigation, and no new overflow, clipping, or unreadable navigation controls
were observed.

## Data note

- Grace Chambers and Jim Chambers are not present in the current tracked
  `data/family/*.csv` public exports, which matches the separate Family site
  boundary.
- The current tracked public `data/athlete_results.csv` now contains the
  expected `07/07/2026` rows for Grace and Jim from Derry City Football Club.
  The promoted manifest bundle is `20260710T232312092Z-1391E180`, exported on
  10 July 2026.

## Known limitations and follow-up opportunities

- Championship tables remain compact on mobile, matching the existing
  table-first presentation. A future task could improve table ergonomics without
  changing exported data or browser-side ownership boundaries.
- The compatibility `hall-of-fame.html` page remains in the preview artifact for
  old direct links, but shared navigation now routes Hall of Fame to
  `index.html`.

## Handoff notes

- Review the Hall of Fame landing, Championships, Overview statistics page, and
  athlete profile pages in both `?site=family` and `?site=everyone`.
- Review Netlify previews after the branch is pushed; no merge or release should
  occur without explicit approval.

## Recently completed historical work

- The initial static navigation split for PR #18 created separate public pages
  for Overview, Championships, Hall of Fame, and athlete profiles, with shared
  navigation and browser smoke coverage.
- Staging-root portability for private workbook exports was completed and merged
  previously. The workbook now uses `Settings!tbSettings[Approved Staging Root]`
  and tracked `data/` was promoted from a validated staged bundle.
- Export-bundle modernization was completed previously. Workbook exports stage a
  complete manifest-backed bundle before any explicitly approved promotion to
  tracked public data.
