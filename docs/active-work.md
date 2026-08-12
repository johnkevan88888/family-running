# Active Work

## Task title

Three approved open items, delivered as four sequenced Pull Requests.

## Status

In progress. John approved open items 4, 5, and 6 on 11 August 2026, after the
audit remediation merged. Open items 1, 2, and 3 were **not** approved and
remain untouched.

This file has a history of going stale, describing work as in progress after it
had merged. `AGENTS.md` directs agents to read it first, so a stale entry
actively misleads. When this task finishes, rewrite it to describe the settled
state again.

## Approved scope

Four Pull Requests, deliberately sequenced so `brand.css` lands last and styles
the final markup rather than markup that is about to change.

1. **Recent Results clock** (open item 4). Anchor the athlete page's twelve
   month window to the exported `LastUpdatedUTC` instead of `new Date()`.
   *Merged as Pull Request #41 on 11 August 2026.*
2. **Branding metadata** (open item 5, part one). Bring the favicon, Open Graph
   tags, meta descriptions, and `assets/brand/` forward from
   `feat/ace-of-race-branding` onto current `main`, adding `assets/brand/` to
   `publishedSiteEntries` so the images do not 404. No visual change to any
   page. *In review.*
3. **Mobile leaderboard cards** (open item 6). Below a breakpoint, render each
   athlete as a card instead of a table row, reusing the pattern the Records
   page already uses. Every exported column stays visible; ordering and values
   remain Excel-owned. *In review.*
4. **`brand.css` restyle** (open item 5, part two). The site-wide visual
   redesign, separated so it gets its own preview review rather than being
   merged alongside safe metadata. *Not started.*

Decisions taken by John when approving: cards rather than reduced columns or
horizontal scrolling, because it keeps every exported column visible and matches
the Records page; and metadata before restyle, because they carry very different
review risk.

### Pull Request 1: Recent Results clock

`buildRecentResults` in `athlete.js` measured its twelve month window from
`new Date()`, so two visitors in different timezones, or the same visitor either
side of midnight, could see different sets, and a result could appear there
while sitting outside the Overview's window. The window now comes from
`exportedWindowEnd`, which reads `LastUpdatedUTC` from the selected site's
`siteinfo.csv`, falls back to the athlete's own latest exported result, and only
then to the visitor's clock. Every step before the last is workbook-owned data.
This mirrors `buildOverviewStats` in `leaderboard.js`, which has always anchored
this way, so the two pages now agree.

No upper bound was added. A result dated at or after the export timestamp should
not exist, but hiding an athlete's newest result on their own page would be a
worse failure than the asymmetry.

This does not close open item 4. The browser still computes a rolling twelve
months rather than reading workbook-owned period membership; that remains an
export-contract proposal, recorded in `docs/roadmap.md`.

### Pull Request 2: Branding metadata

Adds the description, theme colour, Open Graph, Twitter card, and favicon
metadata to all seven public pages, and publishes the four brand images those
tags reference. Nothing visible on any page changes and no existing text was
edited.

Three deliberate departures from `feat/ace-of-race-branding`, each recorded
because the branch is being partially superseded rather than merged:

1. **`<title>` was left alone.** The branch renames every page title to
   "Ace of Race | Family running championships". Titles are visible in tabs,
   bookmarks, and history, so that rename belongs with the visual redesign in
   Pull Request 4, not in a change that is otherwise invisible.
2. **The share copy was made mode-neutral.** The branch's `og:title` and
   description both say "family championships", but one static file serves both
   `?site=family` and `?site=everyone`, and Open Graph tags cannot vary by query
   parameter. Every Everyone-mode share would have been labelled Family. The
   neutral wording keeps the branch's own tagline, "Every age. Every pace. Every
   race counts.", and drops only the mode-specific framing. A browser test now
   fails if "family" or "everyone" reappears in that copy.
3. **Only referenced assets were published.** `track-pattern.svg` is used only
   by `brand.css`, so it comes with Pull Request 4. `icon-512.png` is referenced
   by nothing at all and is also 512 x 576 rather than square, despite its name,
   so it was left on the branch.

Adding `assets` to `publishedSiteEntries` created a third copied-whole
directory, which would have reintroduced exactly the gap Pull Request #39 closed
for `data/` and `vendor/`. `findAssetProblems` closes it in the same change:
published `assets/` must be under `assets/brand/` and in an image format, so a
script or document dropped there cannot reach the public web root.

Known limitation carried into review: `og-image.png` is 1200 x 630, which is
correct, but 984 KB, which is roughly five times heavier than it needs to be for
that size. It is the branch's own artwork, so it was published unmodified rather
than re-encoded. Recompressing it is worth doing before the site is shared
widely, particularly on mobile data.

### Pull Request 3: Mobile leaderboard cards

Below the existing 700px breakpoint, each championship standings row renders as
a card: the participant name as the card heading with the rank or medal at the
top right, and the remaining columns as labelled rows. Previously the
nine-column table was squeezed into 390px, so "Regional Class" became a vertical
strip of single letters and a hyphenated name broke across four lines.

The markup stays one semantic table. `renderLeaderboardTable` now emits a real
`<thead>` and `<tbody>` and gives each `<td>` a `data-label`; the card layout is
entirely a media query in `site.css` that hides the header row and reads the
labels back with `content: attr(data-label)`. Desktop and screen readers are
therefore unaffected, and nothing is hidden, reordered, or summarised on the
browser's judgement about which exported columns matter. The rank and
participant cells are marked by column index rather than by header text, so the
layout never depends on an exported string staying spelled the same.

The honest trade: the Championships page at 390px is now about 8,570 CSS pixels
tall against roughly 4,450 before. Cards are inherently taller than table rows.
Making the name the card heading rather than another labelled row saved about
770 pixels of that and made the list scannable, but the page is still close to
twice as long. Readability was the approved goal, so this is the intended
outcome rather than a regression, and it is recorded here so nobody has to
rediscover it.

Not in scope: the athlete profile page's own results tables use six columns and
were left alone, since the approved item was the championship leaderboard.

## What is live

Pull Requests #33 to #37 merged on 10 August 2026.

- **#33 Audit remediation.** Viewport and `lang` on every public page; Chart.js
  and its date adapter vendored into `vendor/` so the site loads no third-party
  CDN for site functionality; error handling on every top-level asynchronous
  entry point; HTML escaping across the championship tables with a single
  `athleteLink` contract; exported VBA sources rejected by repository safety
  validation; dead code removed and helpers consolidated into `utils.js`;
  continuous integration pinned to Playwright's own Chromium.
- **#34** recorded that release.
- **#35 Publishing and search visibility.** GitHub Pages publishes only the
  built artifact, so `docs/`, `scripts/`, `AGENTS.md`, and `package.json` are no
  longer readable from the production domain. Every public page carries
  `noindex` and `robots.txt` is deliberately permissive, so the site stays live
  for anyone with the link but is excluded from search results.
- **#36 Data refresh.** Export bundle `20260810T212805716Z-199AE180`, live and
  confirmed in both site modes.
- **#37 Staging-root correction.** Documentation now describes the workbook's
  real hardcoded constant, and a `no-visual-change` pathway lets documentation
  and tooling Pull Requests skip the Netlify preview.

Pull Request #39 merged on 11 August 2026 as merge commit `05f3403`. It
remediated five audit findings with no visible behaviour change:

- **Fail-closed artifact output directory.** The build opened with a recursive
  forced `fs.rm` fed straight from `PREVIEW_OUTPUT_DIR`, so a typo could have
  deleted the repository root, tracked `data/`, or a parent directory. Only a
  canonical absolute path strictly inside `test-artifacts/` is now accepted.
- **Complete absolute-records matrix.** Validation checked each row but nothing
  about the set. A valid export is now the complete Men and Women matrix across
  the five supported distances in contracted order, with agreeing
  `RecordGroup`/`Sex`, unique `RecordTitle`, matching `ResultDistance`, and
  unique strictly increasing `SortOrder`. Vacant records are preserved.
- **Escaped `DisplayDistance`.** It was the one exported value reaching a page
  as markup unescaped.
- **Published `data/` and `vendor/` contracts.** Both directories are copied
  whole, so their contents were never checked. `data/` must now be exactly the
  export manifest plus the paths it lists; `vendor/` must be exactly the
  vendored-library set.
- **Shared full-text CSV parsing.** The browser split on line breaks first,
  which corrupts any quoted field containing a newline. `utils.js` now matches
  `scripts/validate-csv.mjs` field for field and fails closed on an unclosed
  quote. Duplicate `escapeRecordHTML`, `escapePaceHTML`, and `rowsToObjects`
  helpers were removed.

Pull Request #38 was closed rather than merged. Its only change was a
`docs/active-work.md` rewrite that #39 superseded.

The Pages source is `build_type: workflow`. Production has been verified since
#39: both site modes load, the Records page renders the full Men and Women
matrix including vacant states, championship standings and paces render, and
`?site=everyone` still returns Everyone-only records.

## Decisions taken on 11 August 2026

Both are recorded in `docs/decision-log.md`; neither is outstanding.

1. **The no-third-party-runtime rule is narrowed to site functionality**, with
   the GoatCounter analytics loader as its single named exception. This resolved
   a three-week contradiction between `AGENTS.md` and the accepted 22 July
   analytics decision. No analytics code changed. Two consequences are accepted
   knowingly: an unpinned third-party script executes with full page privileges
   on production, and no automated test exercises it, because it runs only on
   production hostnames while the browser tests abort every cross-origin
   request.
2. **The absolute-records matrix is recorded as dated enforcement** of the
   existing workbook-owned decision rather than as a new entry.

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
   workflow all postdate the original audit, roughly 12,500 lines. Merging that
   work against the audit branch surfaced three defects in the seam alone.
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
6. **Mobile championship leaderboards are close to unreadable.** Nine columns at
   390px wrap a character or two at a time. No automated check can see it: there
   is no horizontal overflow and every mobile assertion passes, so only a
   screenshot review finds it. Recorded as roadmap item 1, deliberately excluded
   from #39, which must not redesign the site.

## Notes carried from #39

- The absolute-records matrix is deliberately strict. If the workbook ever
  legitimately gains or drops a supported distance, or exports the sexes in a
  different order, validation fails until `absoluteRecordSexes` and
  `absoluteRecordDistances` in `scripts/validate-csv.mjs` are updated in the
  same change. That is the intended trade, but it is a real coupling between the
  workbook and this repository.
- `tests/preview-artifact-safety.mjs` deliberately writes one probe file into
  tracked `data/` and one into `vendor/` and removes them again, asserting
  afterwards that neither survived. If a run is killed mid-test, delete any
  `__artifact-contract-probe__` file before committing.
- `tests/browser-smoke.mjs` still carries its own `parseCsv` helper. It is
  Node-side test scaffolding using the validator's algorithm, and the browser
  parser test compares against it deliberately. It was not replaced with the
  exported `parseCsv` in `scripts/export-bundle-tools.mjs`, which does not trim
  field values.

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
