# Active Work

## Task title

Audit remediation: artifact deletion safety, published-bundle contracts,
absolute-records validation, exported-value escaping, and shared CSV parsing.

## Status

Implemented and fully validated on `fix/audit-remediation-artifact-and-csv-safety`.
Not committed, not pushed, no Pull Request, not merged, not deployed. Every one
of those steps needs John's explicit approval.

This is a standard change, not a lightweight refresh: it touches published
runtime files and the build definition, so it requires a full Netlify Deploy
Preview and review of both site modes before merge. No `[skip netlify]` marker.

## Exact scope

Five audit findings, implemented as specified. No visible behaviour was changed
and both `?site=family` and `?site=everyone` continue to work identically.

1. **The artifact build could delete anything.**
   `scripts/build-preview-artifact.mjs` begins with a recursive, forced
   `fs.rm(outputDir)`, and `PREVIEW_OUTPUT_DIR` went straight into it. A typo or
   a stray environment variable could have deleted the repository root, tracked
   `data/`, or a parent directory without confirmation. That value is now
   resolved through a fail-closed gate in the new
   `scripts/preview-artifact-contract.mjs` before anything is removed. Only a
   canonical absolute path strictly inside the ignored `test-artifacts/`
   directory is accepted. The repository root, tracked `data/` and its
   descendants, parent and sibling directories, `test-artifacts/` itself,
   directories inside the repository but outside `test-artifacts/`, relative
   paths, traversal segments, and surrounding whitespace are all rejected. The
   canonical-path helper is the one already used for staged export roots, now
   exported from `scripts/export-bundle-tools.mjs` rather than duplicated.

2. **`absolute_records.csv` validation was per-row only.**
   It checked each row's own fields but nothing about the set, so a dropped,
   duplicated, misfiled, or reordered record would have passed. Validation now
   enforces the full contract: exactly one row for each of Men and Women at
   Marathon, Half Marathon, 10 Mile, 10 km, and 5 km, in that order;
   `RecordGroup` restricted to `Men` or `Women` and required to agree with the
   row's own `Sex`; unique `RecordTitle`; `ResultDistance` required to be the
   same distance as `Distance`; and `SortOrder` numeric, unique, and strictly
   increasing so the exported order is reproducible. Vacant records are
   explicitly preserved: "No eligible result" and "Championship Vacant" still
   occupy their place in the matrix and are exempted from the performance
   checks, and a regression test proves it.

3. **The exported `DisplayDistance` reached the page unescaped.**
   `leaderboard.js` interpolated `webtables.csv`'s `DisplayDistance` directly
   into each distance-toggle heading. It is now escaped like every other
   exported value. A browser regression test drives markup-bearing text through
   that heading, the `DisplayTitle`, a table header, and both the linked and
   unlinked participant paths, and asserts the text renders literally, that no
   element is created from it, and that no injected handler executes. Reverting
   the fix makes that test fail on all three counts, including the
   script-execution probe.

4. **The published artifact never checked `data/` or `vendor/` contents.**
   Both are copied as whole directories, so the file whitelist said nothing
   about what was inside them; anything present was published at its path.
   `data/` is now checked against `data/export_manifest.csv`, the export
   contract that already defines one complete bundle: published `data/` must be
   exactly the manifest plus every path it lists, so a scratch file, an editor
   backup, an unlisted export, or a missing contracted CSV fails the build.
   `vendor/` is checked against the exact vendored-library set, now a single
   list in the new `scripts/vendored-library-files.mjs` shared with
   `pnpm run validate:vendor`, so nothing can be published from `vendor/`
   without also being pinned to a reviewed dependency.

5. **The browser CSV parser split on line breaks first.**
   That cannot be correct: a quoted field may contain a newline, so the browser
   would have seen several malformed rows where `scripts/validate-csv.mjs` sees
   one valid one, on a file that passed every release check. `utils.js` now
   parses the whole document with `parseCSV`, matching the repository validator
   field for field across quoted commas, escaped quotes, mixed CRLF and LF, and
   quoted multiline fields, and failing closed on an unclosed quoted field
   rather than rendering mangled data. Duplicate helpers were removed at the
   same time: `escapeRecordHTML` in `records.js`, `escapePaceHTML` inside
   `utils.js`, and `rowsToObjects` in `calculator.js` all now use the shared
   `escapeHTML` and `csvRowsToObjects`.

## Files changed

Runtime: `leaderboard.js`, `records.js`, `calculator.js`, `utils.js`.

Tooling: `scripts/build-preview-artifact.mjs`, `scripts/validate-csv.mjs`,
`scripts/sync-vendor.mjs`, `scripts/export-bundle-tools.mjs`,
`scripts/published-site-entries.mjs`, `scripts/run-all-tests.mjs`,
`package.json`, and two new modules, `scripts/preview-artifact-contract.mjs`
and `scripts/vendored-library-files.mjs`.

Tests: new `tests/preview-artifact-safety.mjs`, plus additions to
`tests/export-bundle-validation.mjs` and `tests/browser-smoke.mjs`.

Documentation: `AGENTS.md`, `docs/testing-and-release-protocol.md`,
`docs/decision-log.md`, `docs/roadmap.md`, and this file.

## Validation results

All run locally on 11 August 2026, all passing.

- Repository safety validation: passed, 133 tracked files checked.
- Vendored library validation: passed, 5 files checked.
- CSV validation for `data/family/` and `data/everyone/`: passed.
- Export bundle regression tests: 20 passed, including 12 new absolute-records
  cases and the vacant-record case that must keep passing.
- Staged export workflow regression tests: 5 passed.
- Preview artifact safety tests: passed, including 13 rejected output
  directories and both publication contracts proved on the real tree.
- Preview artifact build: passed, 93 files.
- Browser smoke tests: passed, from the repository root and again with
  `SITE_ROOT=test-artifacts/preview-site`, which proves the published set is
  still complete after the build changes.
- Full `pnpm test`: all checks passed.
- `pnpm audit --audit-level moderate`: no known vulnerabilities.
- `git diff --check`: clean.
- Desktop 1440 x 900 and mobile 390 x 844 screenshots reviewed for Family and
  Everyone. Championships, Hall of Fame, Records, Calculator, and Overview all
  render as before; medals, age-grade categories, paces, vacant states, and
  crown progression are unchanged.

Both new browser tests were verified to fail when the fixes are reverted, so
neither passes vacuously.

## Decisions taken by John

Both were raised during this task and decided on 11 August 2026. No decision is
left outstanding.

1. **The third-party-runtime prohibition contradicts the accepted GoatCounter
   decision.** `AGENTS.md` stated flatly that the public site must not load
   runtime code from a third-party CDN, which is what `vendor/` exists to
   guarantee, while the accepted 22 July 2026 analytics decision requires
   exactly that and explicitly forbids pinning it. Both could not be true.
   **John chose to narrow the prohibition rather than change the integration.**
   The rule now reads: no third-party runtime code for site functionality, with
   the GoatCounter analytics loader as the single named exception, because every
   page renders identically if it never loads. `analytics.js` is untouched, so
   there is no behaviour or visual change. Recorded in `AGENTS.md` and as a
   dated clarification on the analytics entry in `docs/decision-log.md`,
   including the two consequences accepted knowingly: an unpinned third-party
   script executes with full page privileges on the production domain, and no
   automated test exercises it, because it runs only on production hostnames
   while the browser tests abort every cross-origin request.

2. **Whether the absolute-records matrix belongs in the decision log.**
   Finding 2 constrains what the workbook may export: a valid export must now
   supply the complete Men and Women matrix in the contracted order. **John
   chose to amend the existing entry rather than add a new one.** The matrix,
   ordering, and uniqueness rules are recorded as dated complete-matrix
   enforcement in the Consequences of "Absolute records are workbook-owned
   raw-time records", mirroring how the CSV-contract entry records its atomic
   export-bundle enforcement. No other change was logged, because everything
   else in this task enforces a decision already recorded.

## Residual risks

- **Not exercised in production.** Everything above is local. The Netlify
  preview, both site modes, and post-merge production verification are still
  required by the release protocol.
- **The absolute-records matrix is deliberately strict.** If the workbook ever
  legitimately gains or drops a supported distance, or exports the sexes in a
  different order, validation will fail until
  `absoluteRecordSexes`/`absoluteRecordDistances` in `scripts/validate-csv.mjs`
  are updated in the same change. That is the intended trade, but it is a real
  coupling between the workbook and this repository.
- **The published-`data/` contract now depends on the manifest twice.** The
  manifest already decides what validation accepts; it now also decides what may
  be published. A manifest that is wrong in the same way in both places would
  still pass. Validation of the manifest itself is unchanged and remains the
  backstop.
- **The parser now fails closed on malformed CSV.** An unclosed quoted field
  used to mangle the rest of the file silently and now rejects the load, leaving
  the section's readable error message. This is the intended behaviour and no
  tracked export triggers it, but it is a behaviour change on invalid data.
- **`tests/browser-smoke.mjs` still carries its own `parseCsv` helper.** It is
  Node-side test scaffolding, not browser code, and it now reads exported CSVs
  with the same algorithm the validator uses, so the new parser test compares
  the browser against it. It was left alone deliberately: the exported
  `parseCsv` in `scripts/export-bundle-tools.mjs` does not trim field values, so
  swapping it in would be a silent behaviour change in test fixtures.
- **Mobile leaderboard readability is untouched and still poor.** Recorded as
  separately scoped product work in `docs/roadmap.md`; see below.

## Handoff notes

- Branch `fix/audit-remediation-artifact-and-csv-safety`, based on `main` at
  `cf8904c`. Nothing has been committed.
- Run `pnpm test` to reproduce everything. `pnpm run test:artifact-safety` is
  the new focused check.
- `tests/preview-artifact-safety.mjs` deliberately writes one probe file into
  tracked `data/` and one into `vendor/` and removes them again, asserting
  afterwards that neither survived. If a run is killed mid-test, delete any
  `__artifact-contract-probe__` file before committing. `git status` was clean
  after every run here.
- Three script modules were added to `publishingControlPaths` in
  `scripts/published-site-entries.mjs`, because the artifact build now imports
  them to decide where it may write and what may be published. Changing any of
  them requires a full preview rather than the no-visual-change pathway.
- The mobile championship leaderboard problem was observed during the required
  screenshot review and is recorded as roadmap item 1 under "Next candidate
  tasks". It is not a defect the suite can catch: there is no horizontal
  overflow and every mobile assertion passes, so only a screenshot review sees
  it. It was deliberately left alone here, because this remediation must not
  redesign the site.

## Open items carried forward

These predate this task and remain unapproved. Each needs John's explicit scope.

1. **The private workbook is not portable.** It holds a hardcoded
   `Private Const STAGING_PARENT`. Moving or re-cloning the repository breaks
   exporting until that constant is edited by hand. Documented in
   `docs/workbook-export-workflow.md`; the fix is a workbook change, not
   repository work.
2. **Pull Requests #19 to #32 have never been audited.** The records page, the
   age-grade calculator, the analytics integration, and the guided data-update
   workflow all postdate the original audit, roughly 12,500 lines.
3. **The repository is public.** `data/athlete_results.csv` carries real names,
   age categories, event names, and dates, and is readable and indexable on
   GitHub regardless of the site's `noindex`. Closing that route needs a private
   repository, which needs GitHub Pro for Pages to keep working.
4. **Recent Results uses the visitor's browser clock.** `buildRecentResults` in
   `athlete.js` measures its twelve month window from `new Date()`, while the
   Overview anchors to the exported `LastUpdatedUTC`, so the two can disagree.
   The narrow fix is a workbook-owned recency column. Recorded in
   `docs/roadmap.md`.
5. **Unfinished branding work** sits on `origin/feat/ace-of-race-branding`,
   backed up but not merged. It branched before #33 and will conflict on rebase.
   Its `lang` and viewport additions are now redundant; its meta description,
   Open Graph, and favicon work is not.

## What is live

Pull Requests #33 to #37 merged on 10 August 2026, deployed and verified in
production: audit remediation (#33, #34), publishing and search visibility
(#35), a data refresh to bundle `20260810T212805716Z-199AE180` (#36), and the
staging-root correction with the `no-visual-change` preview pathway (#37). The
Pages source is `build_type: workflow`. The site and `robots.txt` return 200 and
`AGENTS.md` returns 404 on the production domain.

## Environment notes

These caused three separate production failures on 10 August and are worth
keeping in mind.

- The canonical clone is `C:\GitHub\family-running`. A stale duplicate exists at
  `C:\Users\johnk\OneDrive\GitHub\family-running` and must not be used.
- The canonical workbook is in `C:\GitHub\_private_workbooks\`. A duplicate
  exists under OneDrive. Running Excel macro automation against a synced folder
  risks the sync client locking files mid-export.
- A workbook copy predating 1 August lacks the `AthleteComparisonExport` module
  and cannot complete an export.
