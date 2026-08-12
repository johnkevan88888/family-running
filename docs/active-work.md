# Active Work

## Task title

None. No implementation task is in progress.

## Status

The three open items John approved on 11 August 2026 are delivered. Two are
merged and live; the third was split, and its visual half is parked. The next
task should replace this entry with its own approved scope before implementation
begins.

This file has a history of going stale, describing work as in progress after it
had merged. `AGENTS.md` directs agents to read it first, so a stale entry
actively misleads. Keep it describing the settled state, and treat it as
describing *no current work* until someone starts something.

## What shipped

Pull Requests #39 to #43 merged on 11 August 2026, all deployed and verified in
production. #39 is the audit remediation described under "Earlier releases"
below; the three items John approved afterwards were:

- **#41 Recent Results clock** (open item 4, partially addressed).
  `buildRecentResults` in `athlete.js` measured its twelve month window from
  `new Date()`, so two visitors in different timezones, or the same visitor
  either side of midnight, could see different sets. It now reads
  `LastUpdatedUTC` from the selected site's `siteinfo.csv`, falls back to the
  athlete's own latest exported result, and only then to the visitor's clock,
  mirroring `buildOverviewStats`. No upper bound was added deliberately: hiding
  an athlete's newest result on their own page would be worse than the
  asymmetry.
- **#42 Branding metadata** (open item 5, part one). Description, theme colour,
  Open Graph, Twitter card, and favicon metadata on all seven pages, plus four
  brand images. The only visible effect is the browser-tab icon and working
  link previews; no page content or text changed.
- **#43 Mobile leaderboard cards** (open item 6). Below the 700px breakpoint
  each standings row renders as a card, with the participant name as the
  heading and the rank or medal at the top right. The markup stays one semantic
  table; the layout is a media query reading `data-label` back through
  `content: attr(...)`. Desktop is unchanged.

## Parked

**Pull Request #44, the Ace of Race restyle**, is open as a **draft** and must
not be merged. John's decision on 11 August 2026: the restyle needs more work
before it ships.

It is implemented and fully validated on `feat/ace-of-race-restyle`, so the work
is not lost. It contains the navy header over the track pattern with gold and
coral edges, the Ace of Race mark and wordmark, a cream page background, the
brand palette across headings, navigation, badges, and cards, and the page-title
rename to "Ace of Race".

Two things in it are worth preserving whatever happens to the design, because
they are corrections rather than styling:

1. The source branch's `site-navigation.js` change deletes the code that fills
   the heading from the workbook-exported `SiteName`, and its
   `tests/browser-smoke.mjs` change removes five identical render gates that
   assert a page rendered *for the requested site mode* rather than merely
   finishing. #44 keeps the exported name visible as `#site-name` in the
   subtitle and moves those gates to follow it, collapsed into one
   `waitForExportedSiteName` helper.
2. `<title>` is currently mode-blind: it is static, so an Everyone-mode tab
   reads "Family Running Championships". #44's rename fixes that by being
   mode-neutral. If the restyle is redesigned from scratch, that fix should
   survive.

`feat/ace-of-race-branding` is therefore **not** yet superseded and should not
be deleted. It still holds the original wordmark approach and `icon-512.png`,
which nothing references and which is 512 x 576 rather than square despite its
name.

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

## Open items

None of these are approved work. Each needs John's explicit scope before
starting.

1. **The private workbook is not portable.** It holds a hardcoded
   `Private Const STAGING_PARENT`. Moving or re-cloning the repository breaks
   exporting until that constant is edited by hand. Documented in
   `docs/workbook-export-workflow.md`; the fix is a workbook change, not
   repository work.
2. **Pull Requests #19 to #32 have never been audited.** The records page, the
   age-grade calculator, the analytics integration, and the guided data-update
   workflow all postdate the original audit, roughly 12,500 lines. Three
   separate unreviewed areas have now yielded real defects on inspection: #39
   found five in already-audited code, the branding branch carried two, and the
   personal-bests derivation below was found by accident.
3. **The repository is public.** `data/athlete_results.csv` carries real names,
   age categories, event names, and dates, and is readable and indexable on
   GitHub regardless of the site's `noindex`. Closing that route needs a private
   repository, which needs a paid GitHub plan for Pages to keep working.
4. **Workbook-owned recency for Recent Results.** #41 removed the visitor-clock
   dependency, but the browser still computes a rolling twelve months rather
   than reading the workbook's own Current/12-Month period membership. The
   complete fix is an Excel/VBA-owned column on `data/athlete_results.csv`.
   Recorded in `docs/roadmap.md`.
5. **The athlete page derives personal bests in JavaScript.**
   `buildPersonalBests` in `athlete.js` selects each distance's fastest time and
   best age grade from exported rows in the browser, while the Calculator solves
   the same problem by reading workbook-owned `athlete_comparison_targets.csv`,
   which already exports Best Age Grade and Fastest Time per distance and result
   class. The same concept therefore has two sources of truth that can disagree.
   Probably fixed by rendering the athlete page from the export the Calculator
   already uses, but it needs checking whether that export covers every athlete.
6. **`og-image.png` is oversized.** 1200 x 630 is correct, but 984 KB is roughly
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

The Pages source is `build_type: workflow`. Production has been verified since
#43: both modes load, the card layout is live, brand assets return 200, and
`AGENTS.md` returns 404.

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
