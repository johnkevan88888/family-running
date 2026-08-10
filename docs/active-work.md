# Active Work

## Task title

Repository audit remediation pass

## Status

Released. PR #33 was approved and merged to `main` on 10 August 2026 as merge
commit `2a49a83`, and GitHub Pages has republished. No workbook was accessed or
modified at any point, and no exported CSV was altered.

There is no active implementation task. The next entry should replace this one
with its own approved scope.

## What was released

An audit of the repository produced eight prioritised findings, all of which
were completed in order:

1. `<meta name="viewport">` and `lang="en"` on every public page, with mobile
   browser tests running under device emulation and an explicit
   `assertResponsiveViewport` check.
2. Chart.js and its date adapter vendored into `vendor/`, removing the runtime
   jsDelivr dependency. `scripts/sync-vendor.mjs` keeps the committed builds
   tied to the pinned dependency versions.
3. Rejection handling on every top-level asynchronous entry point, so a failed
   export load shows a message instead of a permanent placeholder.
4. Escaping for every rendered championship table cell, and a single escaping
   contract for `athleteLink`.
5. Exported VBA sources and Excel add-ins rejected by repository safety
   validation, and a looser workbook-backup heuristic.
6. The browser-clock recency question recorded in `docs/roadmap.md`.
7. Dead code deleted and duplicated helpers consolidated into `utils.js`.
8. Continuous integration pinned to Playwright's own Chromium.

Midway through, `main` advanced by fourteen commits. Merging it in surfaced
three defects that the merge would otherwise have shipped: double-escaped
athlete names at three call sites, pace markup stripped from personal bests by
a redundant escape, and two calculator edge-case tests broken by the
restructured viewport configuration. All three were fixed before merge. The
fixes were also extended to `records.html` and `records.js`.

## Validation results

- Full `pnpm test` passed on the merged branch and again on `main` after merge.
- `Test static site` passed in continuous integration, and Netlify's Deploy
  Preview succeeded.
- Production was verified after republication: `www.aceofrace.com/athlete.html`
  serves the `lang` attribute, the viewport tag, and the vendored scripts, and
  both `vendor/` builds return HTTP 200 at their exact expected byte sizes, so
  the public site no longer depends on a third-party CDN.

## Known limitations and follow-up opportunities

- **Recent Results uses the visitor's browser clock.** `buildRecentResults` in
  `athlete.js` measures its twelve month window from `new Date()`. The Overview
  now anchors its rolling windows to the exported `LastUpdatedUTC`, so the two
  pages can disagree. The narrow fix is a workbook-owned recency column, which
  is John's decision; it is recorded in `docs/roadmap.md`.
- `records.js` keeps a local `escapeRecordHTML` rather than the shared
  `utils.js` helper.
- `championships.html` remains a byte-for-byte duplicate of `index.html` except
  for its title.
- Lower-priority audit findings remain open: no `404.html`, `robots.txt`,
  favicon, or meta description; inline `onclick` handlers that would block a
  Content-Security-Policy; `athlete.html` lacking a `<main>` landmark and
  carrying two `<h1>` elements; deprecated `border`/`cellpadding` attributes on
  the athlete results table; tag-pinned rather than SHA-pinned GitHub Actions;
  continuous integration not running on push to `main`; no linting or
  formatting configuration; `package.json` version against `SiteVersion`.
- **The code added in PRs #19 to #32 has not been audited.** The audit predates
  the records page, the age-grade calculator, the analytics integration, and the
  guided data update workflow. A separate pass would be needed to give those the
  same treatment.
