# Family Running Championships Agent Instructions

This repository is a static GitHub Pages website for the Family Running Championships.

## Shared Work Context

- Before substantial implementation, read `docs/active-work.md`, the relevant architecture or product documentation, and `docs/testing-and-release-protocol.md`.
- At completion, update `docs/active-work.md` with validation results and concise handoff notes.
- Add major durable architectural decisions to `docs/decision-log.md`.

## Source Of Truth

- Excel is the private source of truth for championship data and calculations.
- The website consumes CSV files exported from Excel/VBA.
- Do not modify, copy, upload, commit, inspect, or publish the private Excel workbook.
- JavaScript must not calculate age grades, rankings, championship status, crown standards, target times, or medal positions. Those values must remain Excel/VBA-owned and arrive in exported CSVs.

## Required Site Modes

The site must continue to support both query-string modes:

- `?site=family`
- `?site=everyone`

Preserve the selected `site` parameter when navigating between championship pages and athlete pages.

## Current Static Architecture

- `index.html` is the championship landing page.
- `leaderboard.js` reads the selected site mode, loads `data/<site>/siteinfo.csv`, `data/<site>/halloffame.csv`, and `data/<site>/webtables.csv`, then renders enabled leaderboard CSVs referenced by `webtables.csv`.
- `athlete.html` is the athlete profile page.
- `athlete.js` loads shared athlete result data from `data/athlete_results.csv` and site-specific supporting exports from `data/<site>/`.
- `utils.js` contains the shared CSV loading/parsing, HTML escaping, and
  athlete-link helpers. `escapeHTML` and `csvRowsToObjects` live here only;
  do not reintroduce per-file copies. `athleteLink` escapes its own label, so
  call sites pass raw exported values.
- The site is deliberately excluded from search results. Every public page
  carries `<meta name="robots" content="noindex, follow">`, and `robots.txt` is
  deliberately permissive so crawlers can fetch pages and read that tag. Do not
  add a `Disallow` rule: blocking crawling prevents search engines from ever
  seeing the noindex, and blocking `/data/` would leave crawlers rendering only
  "Loading..." placeholders. This controls search visibility only; it is not
  access control and does not make exported data private.
- The public site is the built artifact, not the repository. GitHub Pages
  publishes `test-artifacts/preview-site` through
  `.github/workflows/deploy-pages.yml`. A file that is not listed in
  `runtimeEntries` in `scripts/build-preview-artifact.mjs` is not on the web, so
  add new runtime files there or they will 404 in production. `CNAME` is part of
  the artifact and must stay there or the custom domain is lost. Documentation,
  scripts, tests, workflow files, and repository configuration must never appear
  in the artifact; the build fails if they do.
- `vendor/` holds committed browser libraries (Chart.js and its date adapter).
  The public site must not load runtime code from a third-party CDN. Refresh
  `vendor/` only with `pnpm run vendor:sync` after changing a pinned dependency
  version in `package.json`; `pnpm test` fails if the two disagree.
- `data/family/` contains CSV exports for the Family mode.
- `data/everyone/` contains CSV exports for the Everyone mode.
- `data/athlete_results.csv` is shared profile result data used by athlete pages.
- `data/export_manifest.csv` is the completion and consistency contract for one full website-data export.

## Export Bundle Contract

- Excel/VBA generates one URL-safe `ExportBundleID` at the start of each full website-data export.
- Every public CSV except `data/export_manifest.csv` carries that ID in an additive `ExportBundleID` column.
- VBA writes `data/export_manifest.csv` only after all planned public CSVs have been created and post-export validation has passed.
- The workbook exports first to a fresh ignored staging folder; tracked `data/` is promoted only as a separate explicitly approved step after validation and reconciliation.
- The manifest schema is exactly:
  `ExportBundleID,ExportedAtUTC,SchemaVersion,Scope,RelativePath,DataRowCount`.
- `Scope` is `family`, `everyone`, or `shared`; paths are repository-relative; row counts exclude the CSV header.
- Repository validation rejects partial, stale, mixed, missing, unlisted, or wrongly counted exports.
- The private macro-enabled workbook and every dated backup remain outside Git and must never be staged or committed.
- Follow `docs/workbook-export-workflow.md`; do not selectively copy individual CSVs from a workbook export.

## Behaviour Boundaries

- Preserve existing visible behaviour unless John explicitly requests a change.
- Do not redesign the site while making testing or release-process changes.
- Do not move Excel-owned calculations into JavaScript.
- Vacant championship states, such as "Championship Vacant" and "No eligible results", are valid exported states and must remain supported.

## Git And Release Safety

- Do not commit directly to `main`.
- Do not merge to `main` without explicit John approval.
- Do not create a release, publish, deploy, or change GitHub Pages settings without explicit John approval.
- Do not push, open a Pull Request, or alter GitHub settings unless John asks for that specific action.

## Required Checks Before Review

Before presenting a change for review, run the available local checks:

- Repository safety validation.
- Vendored library validation.
- CSV validation for both `data/family/` and `data/everyone/`.
- Browser smoke tests for both `?site=family` and `?site=everyone`.
- Responsive screenshots for desktop and mobile views.

Every public page must carry `<meta name="viewport" content="width=device-width,
initial-scale=1">`. The mobile browser tests run with device emulation, so a page
that omits it lays out at the desktop fallback width and fails the overflow
check rather than passing silently.

Generated screenshots, reports, browser output, and dependency folders must stay out of Git.
