# Active Work

## Task title

Privacy-friendly production usage analytics

## Status

Implementation and local validation are complete on
`feat/goatcounter-analytics`. The change is published for review through a
draft Pull Request. No merge, release, production publication, or GitHub
setting change has been performed.

## Current approved scope

- Add aggregate production visit statistics through the user-created
  `familyrunning.goatcounter.com` GoatCounter account.
- Load the tracker only on the production GitHub Pages host and
  `/family-running` path. Local runs, Netlify previews, and other GitHub Pages
  projects must not be counted.
- Keep Family and Everyone usage distinguishable while discarding unrelated
  query parameters. Retain the public athlete ID on athlete-profile paths.
- Use GoatCounter's cookie-free aggregate collection defaults and display a
  concise disclosure on every tracked page.
- Do not change championship data, workbook calculations, CSV schemas, or
  visible championship behaviour.

## Files changed in this pass

- `analytics.js`
- `index.html`
- `championships.html`
- `hall-of-fame.html`
- `records.html`
- `overview.html`
- `athlete.html`
- `site.css`
- `scripts/build-preview-artifact.mjs`
- `scripts/run-all-tests.mjs`
- `tests/analytics-config.mjs`
- `docs/active-work.md`
- `docs/testing-and-release-protocol.md`
- `docs/decision-log.md`

## Validation results

- Passed:
  - `pnpm test`
  - `node --check analytics.js`
  - `node tests/analytics-config.mjs`
  - `git diff --check`
- Responsive Overview screenshots were inspected for Family and Everyone at
  desktop and mobile sizes. The disclosure is readable without disturbing the
  page layout.

## Data note

- No workbook, public CSV, export manifest, or championship calculation changed.
- The GoatCounter endpoint and script integrity hash are public configuration,
  not credentials. No password or API key is stored in the repository.

## Handoff notes

- Confirm the GoatCounter account email address before release.
- Review the footer disclosure in both site modes.
- After an approved production release, open Family and Everyone once and
  confirm both paths appear in the GoatCounter dashboard after its short
  processing delay.
- Client-side analytics can be blocked by privacy tools, so totals are useful
  indicators rather than guaranteed counts of every visit.

## Recently completed historical work

- PR #20 added the workbook-owned absolute Records page and was merged before
  this analytics task began.
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
