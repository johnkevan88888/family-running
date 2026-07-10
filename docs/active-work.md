# Active Work

## Task title

Static multi-page site navigation

## Status

Implementation and local validation complete on `feat/site-navigation`. The
branch has not been pushed, no Pull Request has been opened, and no release,
deployment, publication, GitHub setting change, workbook change, or private
workbook access was performed.

## Completed scope

- Split the public site into normal static pages:
  - `index.html` is now a concise Overview.
  - `championships.html` contains the full championship standings experience.
  - `hall-of-fame.html` contains Hall of Fame cards and All-Time Official crown
    progression/history.
  - `athlete.html` remains the athlete profile destination.
- Added shared responsive navigation and mode switching in `site-navigation.js`.
- Added shared public-page styling in `site.css`.
- Preserved `?site=family` and `?site=everyone` across page navigation, mode
  switching, athlete links, and athlete back links.
- Kept JavaScript display-only. Overview highlights use existing workbook-
  exported current official leaderboard CSVs; no rankings, honours, crown
  history, medals, or profile values are calculated in the browser.
- Kept vacant/no-result states such as `Championship Vacant` and
  `No eligible results`.
- Updated browser smoke tests to cover direct loads and navigation for Overview,
  Championships, Hall of Fame, and valid athlete profiles in both site modes.
- Updated the preview artifact allowlist so the new static runtime pages/assets
  are included in PR previews.

## Files changed

- `index.html`
- `championships.html`
- `hall-of-fame.html`
- `athlete.html`
- `site.css`
- `site-navigation.js`
- `leaderboard.js`
- `athlete.js`
- `utils.js`
- `scripts/build-preview-artifact.mjs`
- `tests/browser-smoke.mjs`
- `docs/active-work.md`
- `docs/decision-log.md`

## Validation results

- JavaScript syntax checks passed for:
  - `leaderboard.js`
  - `athlete.js`
  - `site-navigation.js`
  - `tests/browser-smoke.mjs`
  - `scripts/build-preview-artifact.mjs`
- `pnpm test` passed:
  - repository safety validation;
  - CSV validation for Family and Everyone data;
  - export-bundle validation regression tests;
  - staged-export workflow regression tests;
  - browser smoke tests.
- Browser screenshots were regenerated in ignored `test-artifacts/screenshots/`
  for Overview, Championships, and Hall of Fame across Family/Everyone desktop
  and mobile views.

## Screenshot review

Inspected the generated navigation screenshots for both modes and desktop/mobile
layouts. The shared header wraps cleanly on mobile, the active page is visible,
the Family/Everyone selector remains distinct from page navigation, and no
navigation overflow, clipping, or unreadable controls were observed.

## Known limitations and follow-up opportunities

- Championship tables remain very compact on mobile, matching the existing
  table-first presentation. A future task could improve mobile table ergonomics
  without changing exported data or browser-side ownership boundaries.
- The old ignored screenshot filenames from the previous smoke-test naming may
  still exist locally under `test-artifacts/screenshots/`; they are not tracked.

## Handoff notes

- Review the Overview, Championships, Hall of Fame, and athlete profile pages in
  both `?site=family` and `?site=everyone`.
- Confirm the PR preview includes the new `championships.html`,
  `hall-of-fame.html`, `site.css`, and `site-navigation.js` runtime assets.
- Do not release without the normal PR checks, Netlify preview review, and
  explicit approval.

## Recently completed historical work

- Staging-root portability for private workbook exports was completed and merged
  previously. The workbook now uses `Settings!tbSettings[Approved Staging Root]`
  and tracked `data/` was promoted from a validated staged bundle.
- Export-bundle modernization was completed previously. Workbook exports stage a
  complete manifest-backed bundle before any explicitly approved promotion to
  tracked public data.
