# Active Work

## Task title

Repository audit remediation pass

## Status

Implementation and local validation are complete on `fix/audit-remediation-pass`.
No merge, push, Pull Request, release, deployment, production publication, GitHub
setting change, private workbook access, or workbook modification has been
performed.

## Current approved scope

John asked for a repository audit and then approved completing the audit's eight
prioritised recommendations in order. Vendoring the chart library was explicitly
chosen from the offered options.

1. Add `<meta name="viewport">` and `lang="en"` to all five public pages, and make
   the mobile browser tests use device emulation so a missing tag fails.
2. Vendor Chart.js and its date adapter into `vendor/`, removing the runtime
   jsDelivr dependency.
3. Handle rejections on every top-level asynchronous entry point so a failed
   export load shows a message instead of a permanent placeholder.
4. Escape every rendered cell in the championship tables and give `athleteLink` a
   single, consistent escaping contract.
5. Close the exported-VBA-source gap in repository safety validation and loosen
   the workbook-backup heuristic.
6. Record the browser-clock recency question for John's decision.
7. Delete dead code and consolidate duplicated helpers into `utils.js`.
8. Make continuous integration use Playwright's pinned Chromium.

Excel/VBA remains the source of truth. No calculation was moved into JavaScript,
and no exported CSV or workbook file was altered.

## Files changed

- `index.html`, `championships.html`, `hall-of-fame.html`, `overview.html`,
  `athlete.html`
- `utils.js`, `leaderboard.js`, `athlete.js`, `site-navigation.js`, `site.css`
- `vendor/` (new: pinned Chart.js and date-adapter builds plus their licences)
- `scripts/sync-vendor.mjs` (new), `scripts/run-all-tests.mjs`,
  `scripts/build-preview-artifact.mjs`, `scripts/validate-repository-safety.mjs`
- `tests/browser-smoke.mjs`
- `package.json`, `pnpm-lock.yaml`, `.gitignore`
- `AGENTS.md`, `docs/testing-and-release-protocol.md`, `docs/roadmap.md`,
  `docs/active-work.md`

## Validation results

- Full `pnpm test` passed: repository safety validation, vendored library
  validation, CSV validation for Family and Everyone, export-bundle regression
  tests, staged-export workflow regression tests, and browser smoke tests.
- `pnpm run preview:build` produced an 81-file artifact including `vendor/`.
- JavaScript syntax checks passed for `utils.js`, `leaderboard.js`, `athlete.js`,
  `site-navigation.js`, and `tests/browser-smoke.mjs`.

Behaviour was verified directly rather than assumed:

- **Viewport.** With the tag, a 390px emulated context lays out at 390px. With
  the tag stripped, the same page lays out at 980px. An initial attempt to rely
  on the existing horizontal-overflow assertion was proven insufficient, because
  a 980px layout does not overflow; `assertResponsiveViewport` now checks the tag,
  the `lang` attribute, and the applied layout width directly. Temporarily
  removing the tag from one page made the suite fail with six explicit errors.
- **Chart.** The vendored build renders a real Chart instance on a `time` scale
  with the exported official points plotted, and no console or page errors. The
  previous CDN build was unreachable under the tests' cross-origin blocking, so
  this path had never been exercised.
- **Error handling.** Forcing HTTP 500 on `webtables.csv`, `halloffame.csv`,
  `crown_history.csv`, and `athlete_results.csv` produced the intended visible
  message on the championships, Hall of Fame, crown history, overview, and
  athlete pages instead of a stuck placeholder.

## Known limitations and follow-up opportunities

- **Recent Results uses the visitor's browser clock.** `buildRecentResults` in
  `athlete.js` measures its twelve month window from `new Date()`, so it can
  disagree with the workbook's Current/12-Month period, and two visitors in
  different timezones can see different sets. This is recorded as a proposal in
  `docs/roadmap.md` because the narrow fix is a workbook-owned recency column on
  `data/athlete_results.csv`, which is John's decision and not repository work.
  The athlete page also derives personal bests by sorting exported rows in
  JavaScript, which is a browser-side derivation of the same kind.
- `championships.html` remains a byte-for-byte duplicate of `index.html` except
  for its title. It is retained deliberately for old direct links, but the two
  files will drift; a redirect stub or canonical link is the smaller long-term
  shape.
- Remaining lower-priority audit items were not in the approved eight and were
  left alone: no `404.html`, `robots.txt`, favicon, or meta description; inline
  `onclick` handlers that would block a Content-Security-Policy; `athlete.html`
  lacking a `<main>` landmark and carrying two `<h1>` elements; deprecated
  `border`/`cellpadding` attributes on the athlete results table; tag-pinned
  rather than SHA-pinned GitHub Actions; continuous integration not running on
  push to `main`; no linting or formatting configuration; and
  `package.json` version `0.0.0` against `SiteVersion v1.5`.

## Handoff notes

- Review the Championships landing, Hall of Fame, Overview, and athlete profile
  pages in both `?site=family` and `?site=everyone`.
- Pay particular attention to the mobile screenshots. They now reflect a real
  phone layout for the first time, so they will differ substantially from the
  previous set even though no stylesheet rule changed for them.
- Confirm the vendored `vendor/` licences and pinned versions are acceptable to
  carry in the repository.
- Decide the Recent Results recency question recorded in `docs/roadmap.md`.
- No merge, push, or release should occur without explicit approval.
