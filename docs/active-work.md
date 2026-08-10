# Active Work

## Task title

Repository audit remediation pass

## Status

Implementation and local validation are complete on `fix/audit-remediation-pass`,
which is open as PR #33 and has been merged up to date with `main`. No merge to
`main`, release, deployment, production publication, GitHub setting change,
private workbook access, or workbook modification has been performed.

The previous entry in this file described the routine data update workflow, which
was released through PR #32 and is now history.

## Current approved scope

John asked for a repository audit, then approved completing the audit's eight
prioritised recommendations in order. Vendoring the chart library was explicitly
chosen from the offered options. After `main` moved ahead by fourteen commits,
John approved merging `main` into this branch and extending the fixes to the
pages added in the meantime.

1. Add `<meta name="viewport">` and `lang="en"` to every public page, and make
   the mobile browser tests use device emulation with an explicit assertion.
2. Vendor Chart.js and its date adapter into `vendor/`, removing the runtime
   jsDelivr dependency.
3. Handle rejections on every top-level asynchronous entry point so a failed
   export load shows a message instead of a permanent placeholder.
4. Escape every rendered championship table cell and give `athleteLink` a single,
   consistent escaping contract.
5. Close the exported-VBA-source gap in repository safety validation and loosen
   the workbook-backup heuristic.
6. Record the browser-clock recency question for John's decision.
7. Delete dead code and consolidate duplicated helpers into `utils.js`.
8. Make continuous integration use Playwright's pinned Chromium.

Excel/VBA remains the source of truth. No calculation was moved into JavaScript,
and no exported CSV or workbook file was altered.

## Validation results

- Full `pnpm test` passed after the merge, covering repository safety validation,
  vendored library validation, CSV validation for both modes, analytics
  configuration tests, export-bundle and staged-export regression tests, Pull
  Request release-path tests, simple-data-update tests, and browser smoke tests.
- `pnpm run preview:build` succeeded with `vendor/` and the new pages present.
- JavaScript syntax checks passed for every changed script.

Behaviour was verified directly rather than assumed:

- **Viewport.** An initial attempt to rely on the existing horizontal-overflow
  assertion was proven wrong: a page missing the tag lays out at the roughly
  980px fallback width and does not overflow, so it passed unnoticed.
  `assertResponsiveViewport` now checks the tag, the `lang` attribute, and the
  applied layout width on every public page. Temporarily removing the tag from
  one page made the suite fail with six explicit errors.
- **Chart.** The vendored build renders a real Chart instance on a `time` scale
  with the exported official points plotted and no console or page errors. The
  previous CDN build was unreachable under the tests' cross-origin blocking, so
  this path had never been exercised.
- **Error handling.** Forcing HTTP 500 on `webtables.csv`, `halloffame.csv`,
  `crown_history.csv`, and `athlete_results.csv` produced the intended visible
  message instead of a stuck placeholder.
- **Vendored file integrity.** `.gitattributes` marks `vendor/**` as `-text`.
  Without it, `core.autocrlf` rewrote the builds to CRLF on checkout and
  `validate:vendor` reported drift on every fresh clone. Verified by deleting and
  re-checking-out the files and confirming a byte-identical comparison.

## Merge notes

Merging `main` required care where the audit changes met new upstream work:

- `athleteLink` now escapes its own label. Three call sites in merged upstream
  code passed pre-escaped names and would have double-escaped: two in
  `leaderboard.js` and one in `records.js`. All three now pass raw values.
- `escapeHTML` and `csvRowsToObjects` returned in upstream copies of
  `leaderboard.js` and `athlete.js`; the duplicates were removed again in favour
  of the `utils.js` versions.
- In the championship table, upstream's `renderTimeWithPace` and
  `formatExportedDate` are given the raw exported value rather than the escaped
  cell, since both handle their own escaping.
- Upstream's `buildOfficialMedals(results)` signature and its pace and date
  display work were kept in full. `formatPB` was confirmed still uncalled and
  stays deleted; `buildOverview` was confirmed still unreachable, as no page
  contains `#overview-highlights`.
- `records.html` gained the viewport and `lang` attributes. `calculator.html`
  already had both.
- `records.js` gained an error guard on its top-level `buildAbsoluteRecords()`
  call, matching the other entry points.

## Known limitations and follow-up opportunities

- **Recent Results uses the visitor's browser clock.** `buildRecentResults` in
  `athlete.js` measures its twelve month window from `new Date()`, so it can
  disagree with the workbook's Current/12-Month period. This is recorded as a
  proposal in `docs/roadmap.md` because the narrow fix is a workbook-owned
  recency column, which is John's decision. Note that the Overview now anchors
  its rolling windows to the exported `LastUpdatedUTC` instead, so the athlete
  page is inconsistent with the Overview on this point.
- `records.js` keeps its own local `escapeRecordHTML` rather than using the
  shared `utils.js` helper. Left alone deliberately to limit churn in recently
  added code; consolidating it would complete the item 7 pattern.
- `championships.html` remains a byte-for-byte duplicate of `index.html` except
  for its title.
- Lower-priority audit findings remain untouched: no `404.html`, `robots.txt`,
  favicon, or meta description; inline `onclick` handlers that would block a
  Content-Security-Policy; `athlete.html` lacking a `<main>` landmark and
  carrying two `<h1>` elements; deprecated `border`/`cellpadding` attributes on
  the athlete results table; tag-pinned rather than SHA-pinned GitHub Actions;
  continuous integration not running on push to `main`; no linting or formatting
  configuration; `package.json` version against `SiteVersion`.
- The code added in PRs #19 to #32 has not been audited. The original audit
  predates it.

## Handoff notes

- Review every public page in both `?site=family` and `?site=everyone`,
  including the Records and Calculator pages added upstream.
- Pay particular attention to the mobile screenshots. They now reflect a real
  phone layout for the first time, so they will differ substantially from the
  previous set even though no mobile stylesheet rule changed.
- Confirm the vendored licences and pinned versions in `vendor/` are acceptable
  to carry in the repository.
- Decide the Recent Results recency question recorded in `docs/roadmap.md`.
- No merge to `main` or release should occur without explicit approval.
