# Active Work

## Task title

Personal-best reconciliation harness. Approved by John on 13 August 2026,
delivered and awaiting review.

## Status

`scripts/reconcile-personal-bests.mjs` compares a draft workbook personal-best
export against what `athlete.html` renders today, so a disagreement is a
decision taken deliberately rather than something an athlete later notices about
their own profile. It exists before the export does, because a trial export can
then be checked the moment it lands instead of waiting on new tooling.

It reads the rendered page rather than recomputing anything. The defect it
serves to close is that one concept has two selectors; a third selector living
in a reconciliation script would repeat the mistake. It drives the real page in
the real browser and reads the Personal Bests cards out of the DOM.

Two modes: `--export <path>` compares and exits non-zero on any difference,
`--emit-current <path>` writes current rendered selections in the proposed
schema. The specimen is a record of present browser behaviour for the workbook
to replicate or knowingly supersede. It is not an export: it carries
`NOT-AN-EXPORT-RENDERED-SPECIMEN` as its `ExportBundleID`, and the script
refuses to write one anywhere inside `data/`.

`loadPlaywright` and `findChromiumExecutable` moved out of
`tests/browser-smoke.mjs` into `scripts/browser-runtime.mjs` so both entry
points launch the same browser. A second copy would have drifted, and a
reconciliation that reads the page has to launch what the test suite launches or
its result means nothing. No behaviour changed; the full suite passes.

Everything else approved so far is delivered and merged. The Ace of Race visual
restyle is the one approved item that never shipped: it was split off, and its
Pull Request has since been closed rather than parked.

### Measured on 13 August 2026

Both from the harness itself, against the current export:

- **Personal bests render identically in Family and Everyone.** All 96
  selections across 19 athletes match in both modes. This was the premise behind
  exporting the file as `shared` rather than per-site, and it had not previously
  been checked. The script re-checks it on every run unless `--site` pins one
  mode.
- **96 rendered selections exist across 19 athletes**, against a theoretical
  maximum of 380 (19 athletes x 5 distances x 2 result classes x 2 benchmark
  types). Most cards are legitimately empty, which is why settled decision 2
  exports no placeholder rows.

This file has a history of going stale, describing work as in progress after it
had merged. `AGENTS.md` directs agents to read it first, so a stale entry
actively misleads. Keep it describing the settled state, and treat it as
describing *no current work* until someone starts something.

Reconciled against `git log`, `gh pr list --state all`, and
`git ls-remote --heads origin` on 13 August 2026. It had drifted in four ways:
it described the closed #44 as an open draft on a branch that no longer exists,
it listed a `<title>` fix as parked that #52 had already shipped, it omitted
#50, #51, and #52 from what shipped, and it repeated a coverage figure from the
audit that re-measurement does not support. Verify it this way again rather
than trusting it.

## What shipped

Pull Requests #39 to #43 merged on 11 August 2026, all deployed and verified in
production. #39 is the audit remediation described under "Earlier releases"
below. The three items John approved afterwards are listed next; their
bracketed numbers refer to the open-items list as it stood on 11 August 2026,
which has since changed and no longer matches the numbering under "Open items"
further down.

- **#41 Recent Results clock** (then item 4, partially addressed).
  `buildRecentResults` in `athlete.js` measured its twelve month window from
  `new Date()`, so two visitors in different timezones, or the same visitor
  either side of midnight, could see different sets. It now reads
  `LastUpdatedUTC` from the selected site's `siteinfo.csv`, falls back to the
  athlete's own latest exported result, and only then to the visitor's clock,
  mirroring `buildOverviewStats`. No upper bound was added deliberately: hiding
  an athlete's newest result on their own page would be worse than the
  asymmetry.
- **#42 Branding metadata** (then item 5, part one). Description, theme colour,
  Open Graph, Twitter card, and favicon metadata on all seven pages, plus four
  brand images. The only visible effect is the browser-tab icon and working
  link previews; no page content or text changed.
- **#43 Mobile leaderboard cards** (then item 6). Below the 700px breakpoint
  each standings row renders as a card, with the participant name as the
  heading and the rank or medal at the top right. The markup stays one semantic
  table; the layout is a media query reading `data-label` back through
  `content: attr(...)`. Desktop is unchanged.

Three more merged on 13 August 2026:

- **#50 and #51 workflow action bumps.** `actions/deploy-pages` to v5, then the
  remaining workflow actions off Node 20. No site behaviour changed.
- **#52 Mode-aware page title.** Each `<title>` was fixed markup, so an
  Everyone-mode tab read "Family Running Championships" while the header showed
  the exported Everyone name. `site-navigation.js` now replaces the site-name
  portion of the title with the exported `SiteName`, keeping each page's own
  prefix. The athlete page is deliberately excluded: its title names the
  athlete and no site mode, which was already correct.

## Not shipped: the Ace of Race restyle

**Pull Request #44 is closed**, not open, and its branch
`feat/ace-of-race-restyle` no longer exists on origin. John's decision on
11 August 2026 was that the restyle needed more work before it shipped. His
instruction on 13 August 2026 is that if it is redone it must start from
scratch; #44 is reference material, not a base. Redoing it is candidate work
and is **not approved**.

Because the branch is gone, the closed work is recoverable only through
GitHub's Pull Request ref:

```bash
git fetch origin refs/pull/44/head
```

That resolves to `bc14896`, verified on 13 August 2026. It holds the navy
header over the track pattern with gold and coral edges, the Ace of Race mark
and wordmark, a cream page background, the brand palette across headings,
navigation, badges, and cards, and a page-title rename to "Ace of Race".

Of the two corrections #44 carried, one has since shipped by a different route
and one is still only a warning:

1. **Shipped.** `<title>` was mode-blind. #44 would have fixed it by renaming
   the site to "Ace of Race", making the static title mode-neutral. #52 fixed
   it instead by substituting the exported `SiteName`, which keeps the
   workbook's own name visible. Nothing here is outstanding.
2. **Still a hazard.** On `feat/ace-of-race-branding`, `site-navigation.js`
   deletes the code that fills the heading from the exported `SiteName`, and
   `tests/browser-smoke.mjs` removes five identical render gates that assert a
   page rendered *for the requested site mode* rather than merely finishing.
   Main has both today; the heading fill is in `site-navigation.js` from around
   line 166. A restyle built on that branch would regress them, so a redo must
   keep the exported name visible and keep the gates. #44's approach was to
   show it as `#site-name` in the subtitle and collapse the gates into one
   `waitForExportedSiteName` helper.

`feat/ace-of-race-branding` is therefore still not superseded and must not be
deleted. Verified on 13 August 2026: it is the only place
`assets/brand/track-pattern.svg` and `assets/brand/icon-512.png` exist, because
main's `assets/brand/` holds only `ace-of-race-mark.svg`,
`apple-touch-icon.png`, `favicon-32.png`, and `og-image.png`. No Pull Request
was ever opened against that branch, so unlike #44 there is no `refs/pull/*`
copy and deleting it is irreversible. `icon-512.png` is referenced by nothing
and is 512 x 576 rather than square despite its name.

## Decisions taken on 11 August 2026

Both are recorded in `docs/decision-log.md`; neither is outstanding.

1. **The no-third-party-runtime rule is narrowed to site functionality**, with
   the GoatCounter analytics loader as its single named exception. This resolved
   a three-week contradiction between `AGENTS.md` and the accepted 22 July
   analytics decision. No analytics code changed.
2. **The absolute-records matrix is recorded as dated enforcement** of the
   existing workbook-owned decision rather than as a new entry.

Two further choices were made while approving the work above and are recorded
here rather than in the decision log, because they are product preferences
rather than architecture: cards rather than reduced columns or horizontal
scrolling for the mobile standings, because cards keep every exported column
visible; and branding metadata before the visual restyle, because the two carry
very different review risk. The second of those is why the restyle could be
parked without holding anything else up.

## Audit completed on 12 August 2026

Pull Requests #19 to #32 have now been audited. The durable report is
[Audit of Pull Requests #19 to #32](pr-19-32-audit.md). It records the review
method, a Pull Request-by-Pull Request disposition, historical issues already
remediated, and four open P2 findings. No remediation is approved merely by
being documented there.

The personal-best reconciliation found no current visible disagreement: all 70
distinct Family and all 96 distinct Everyone All Time benchmark keys select the
same source performance in JavaScript and the workbook export. The architecture
conflict remains because the selectors are independent, their tie-breaking can
diverge, and the Family pairwise export does not cover every direct profile
route.

**Correction to the audit's coverage figures, 13 August 2026.** The audit says
Family "omits eight result-bearing athletes outside the Family roster" and that
Everyone's one athlete without benchmark rows "has no public result to select".
Both were re-measured against the current export and neither is quite right.
`data/athlete_results.csv` holds 19 distinct athletes, all of them
result-bearing. Family's `athlete_comparison_targets.csv` names 12 of them, all
as challengers, and carries benchmark rows for 11; **seven** are absent
entirely. Everyone names all 19 and carries benchmark rows for 18. The single
athlete with no benchmark rows in either mode is `jess-graham-kevan`, who does
have a public result: one 1 Mile run. 1 Mile is not one of the five distances
either the export or the athlete page supports, which is why no benchmark
exists and why that profile renders five empty personal-best cards today. The
audit's "eight" is seven absent plus that athlete, which are two different
sets. The figure in
[Audit of Pull Requests #19 to #32](pr-19-32-audit.md) has been left as
written, because it is a dated record; this note is the correction.

Validation on 12 August: `git diff --check` passed; every non-browser stage of
`pnpm test` passed before the command wrapper's two-minute limit; and the final
browser suite passed separately for both modes at desktop and mobile sizes,
with responsive screenshots regenerated under ignored `test-artifacts/`.

## Audit findings remediated on 12 August 2026

John approved P2-01, P2-02, and P2-04 for implementation. All three remove a
case where the repository overrode, or claimed authority it did not have over,
something outside its control.

- **P2-01.** `records.js` sorted record groups Women before Men, reversing the
  workbook-owned export order that the validator requires, and its browser test
  reimplemented the same override so the test protected it. The page now keeps
  the order in which groups first appear after the exported `SortOrder` sort,
  and the test derives the expected sequence from the export under test instead
  of restating the matrix. The visible effect is that the Records page now
  renders Men before Women, matching the export.
- **P2-02.** The custom-domain release gate checked only that `CNAME` was
  syntactically a hostname, so any valid hostname could take the
  preview-skipping route and self-approve it. It now requires exactly
  `www.aceofrace.com`, compared case-insensitively so a case variant of the same
  host is still accepted.

- **P2-04.** The guided routine-data updater asked for `PUBLISH` before the Pull
  Request existed, then merged as soon as the required check passed. `PUBLISH`
  therefore could not be approval of the exact committed diff or the responsive
  screenshots, neither of which existed yet, while the release documentation
  said both were reviewed before approval. The updater now stops after the
  check, prints the Pull Request, its `gh pr diff` command, and the run holding
  the screenshot artifact, and requires a separate exact `MERGE`. After that
  confirmation it re-reads GitHub and re-verifies Pull Request identity, that
  the head commit is still the validated one, and that the required check still
  succeeds, so a push during the review pause is refused rather than merged.
  Declining leaves the Pull Request open and the update resumable from the new
  `checked` phase. `--approve-merge` exists for non-interactive use, alongside
  the existing `--approve-promote` and `--approve-publish`.

All three were verified by reverting them: restoring the group override fails
the Records assertions in all four mode/viewport combinations plus the synthetic
edge case, removing the hostname pin fails the release-path tests, and
bypassing the merge confirmation fails the updater's main-flow assertions.

The P2-04 change was documented across the release protocol, the workbook export
workflow, the preview-deployment notes, and a dated correction on the
"Main is PR-gated" decision-log entry, which had described `PUBLISH` as the
merge approval.

P2-03 remains open below. The full record stays in
[Audit of Pull Requests #19 to #32](pr-19-32-audit.md).

## Open items

None of these are approved work. Each needs John's explicit scope before
starting.

1. **The private workbook is not portable.** It holds a hardcoded
   `Private Const STAGING_PARENT`. Moving or re-cloning the repository breaks
   exporting until that constant is edited by hand. Documented in
   `docs/workbook-export-workflow.md`; the fix is a workbook change, not
   repository work.
2. **The repository is public.** `data/athlete_results.csv` carries real names,
   age categories, event names, and dates, and is readable and indexable on
   GitHub regardless of the site's `noindex`. Closing that route needs a private
   repository, which needs a paid GitHub plan for Pages to keep working.
3. **Workbook-owned recency for Recent Results.** #41 removed the visitor-clock
   dependency, but the browser still computes a rolling twelve months rather
   than reading the workbook's own Current/12-Month period membership. The
   complete fix is an Excel/VBA-owned column on `data/athlete_results.csv`.
   Recorded in `docs/roadmap.md`.
4. **The athlete page derives personal bests in JavaScript.** Audit finding
   P2-03. **Blocked on the workbook, not on repository work.**
   `buildPersonalBests` in `athlete.js` selects each distance's fastest time and
   best age grade in the browser, while the Calculator reads workbook-owned
   `athlete_comparison_targets.csv` for the same two benchmarks. Current public
   rows agree on every key, but the agreement is contingent rather than
   enforced.

   The repository cannot close this. The fix needs a workbook-owned export;
   generating that file here would be the second source of truth, pointing the
   page at an export that does not exist would empty a working section, and
   keeping the JavaScript selectors as a fallback is the silent fallback the
   audit warns against. The design, the measured coverage gap, and the exact
   current behaviour the workbook must replicate or supersede are written up in
   [Proposed workbook-owned personal-best export](personal-best-export-proposal.md).
   That proposal needs John's decision and a workbook change before any
   repository work starts.
5. **`og-image.png` is oversized.** 1200 x 630 is correct, but 984 KB is roughly
   five times heavier than it needs to be. It is published unmodified because it
   is John's artwork. Worth recompressing before the site is shared widely.

## Notes worth carrying

- The absolute-records matrix validation is deliberately strict. If the workbook
  ever legitimately gains or drops a supported distance, or exports the sexes in
  a different order, validation fails until `absoluteRecordSexes` and
  `absoluteRecordDistances` in `scripts/validate-csv.mjs` are updated in the
  same change.
- `tests/preview-artifact-safety.mjs` deliberately writes one probe file into
  tracked `data/`, one into `vendor/`, and one into `assets/brand/`, then
  removes them and asserts none survived. If a run is killed mid-test, delete
  any `__artifact-contract-probe__` file before committing.
- `tests/browser-smoke.mjs` keeps its own `parseCsv` helper. It is Node-side
  test scaffolding using the validator's algorithm, and the browser parser test
  compares against it deliberately. It was not replaced with the exported
  `parseCsv` in `scripts/export-bundle-tools.mjs`, which does not trim field
  values.
- The mobile standings cards make the Championships page at 390px roughly twice
  as tall as the old cramped table: about 8,570 CSS pixels against 4,450 for
  Family, and about 11,350 for Everyone. That is inherent to cards and was the
  accepted trade for readability.

## Earlier releases

Pull Requests #33 to #37 merged on 10 August 2026: the original audit
remediation, the switch to publishing a built artifact rather than the
repository root, `noindex` on every page, a data refresh, and the staging-root
correction.

Pull Request #39 merged on 11 August 2026 and remediated five audit findings
with no visible behaviour change: a fail-closed gate on the artifact build's
output directory, complete-matrix validation for `absolute_records.csv`, the
escaped `DisplayDistance`, published-content contracts for `data/` and
`vendor/`, and a shared full-text CSV parser matching the repository validator.
Pull Request #38 was closed rather than merged, superseded by #39.

The Pages source is `build_type: workflow`. The last recorded production
verification was after #43: both modes load, the card layout is live, brand
assets return 200, and `AGENTS.md` returns 404. #50, #51, and #52 have deployed
since and no production check is recorded for them, so the mode-aware title has
not been confirmed live.

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
