# Active Work

## Task title

None. No implementation task is in progress.

## Status

Everything started on 10 August 2026 is merged, deployed, and verified in
production. The next task should replace this entry with its own approved scope
before implementation begins.

This file had gone stale three times in one day, each time describing work as
in progress after it had merged. `AGENTS.md` directs agents to read it first, so
a stale entry actively misleads. It has been rewritten to describe the settled
state rather than a task, and should be treated as describing *no current work*
until someone starts something.

## What is live

Pull Requests #33 to #37 merged on 10 August 2026.

- **#33 Audit remediation.** Viewport and `lang` on every public page; Chart.js
  and its date adapter vendored into `vendor/` so the site loads no third-party
  CDN; error handling on every top-level asynchronous entry point; HTML escaping
  across the championship tables with a single `athleteLink` contract; exported
  VBA sources rejected by repository safety validation; dead code removed and
  helpers consolidated into `utils.js`; continuous integration pinned to
  Playwright's own Chromium.
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

The Pages source is `build_type: workflow`. This was set automatically by
`actions/configure-pages` on the first workflow run; no manual settings change
was needed. Production has been verified since: the site and `robots.txt` return
200, and `AGENTS.md` returns 404.

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
