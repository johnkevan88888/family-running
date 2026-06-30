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
- `utils.js` contains shared CSV loading/parsing and athlete-link helpers.
- `data/family/` contains CSV exports for the Family mode.
- `data/everyone/` contains CSV exports for the Everyone mode.
- `data/athlete_results.csv` is shared profile result data used by athlete pages.
- `data/export_manifest.csv` is the completion and consistency contract for one full website-data export.

## Export Bundle Contract

- Excel/VBA generates one URL-safe `ExportBundleID` at the start of each full website-data export.
- Every public CSV except `data/export_manifest.csv` carries that ID in an additive `ExportBundleID` column.
- VBA writes `data/export_manifest.csv` only after all planned public CSVs have been created and post-export validation has passed.
- The manifest schema is exactly:
  `ExportBundleID,ExportedAtUTC,SchemaVersion,Scope,RelativePath,DataRowCount`.
- `Scope` is `family`, `everyone`, or `shared`; paths are repository-relative; row counts exclude the CSV header.
- Repository validation rejects partial, stale, mixed, missing, unlisted, or wrongly counted exports.
- The private macro-enabled workbook and every dated backup remain outside Git and must never be staged or committed.

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
- CSV validation for both `data/family/` and `data/everyone/`.
- Browser smoke tests for both `?site=family` and `?site=everyone`.
- Responsive screenshots for desktop and mobile views.

Generated screenshots, reports, browser output, and dependency folders must stay out of Git.
