# Decision Log

This log records durable architectural decisions, not proposed features.
Unknown historical details are labelled rather than inferred.

## Excel/VBA is the private source of truth

- **Status:** Accepted
- **Date:** June 2026; formally documented by 25 June 2026. The exact original
  decision date is unknown.
- **Decision:** Excel/VBA owns championship data, eligibility, calculations,
  rankings, medals, crowns, standards, and export ordering.
- **Rationale:** One authoritative calculation path prevents the workbook and
  public site from producing different championship outcomes.
- **Consequences:** Private workbooks and backups stay outside Git. Website
  changes that need new calculated values require workbook-owned exports.

## Production is a static GitHub Pages site

- **Status:** Accepted and live
- **Date:** By 5 June 2026; the exact original decision date is unknown.
- **Decision:** Production is served as static HTML, CSS, JavaScript, and CSV
  files through GitHub Pages.
- **Rationale:** The site needs no application server because its publishable
  state is fully exported.
- **Consequences:** Runtime code cannot depend on server-side calculation or
  private workbook access. Netlify is used for Pull Request previews, not
  production.

## Family and Everyone are required site modes

- **Status:** Accepted
- **Date:** 7 June 2026
- **Decision:** `?site=family` and `?site=everyone` are both supported, and the
  selected mode is preserved through athlete navigation.
- **Rationale:** The two audiences use separate site-specific exports while
  sharing one static application.
- **Consequences:** Features, exports, validation, previews, and release checks
  must cover both modes and prevent cross-mode data loading.

## CSV exports are the public website data contract

- **Status:** Accepted
- **Date:** By June 2026; atomic export-bundle enforcement added 29 June 2026.
  The exact original CSV-contract date is unknown.
- **Decision:** The website consumes public CSVs exported by Excel/VBA. A full
  export shares one `ExportBundleID`, and `data/export_manifest.csv` is written
  last as the completion and consistency contract.
- **Rationale:** CSVs provide a reviewable boundary between the private
  calculation system and the public static site.
- **Consequences:** Schema changes must be deliberate and coordinated with VBA,
  validators, tests, and both site folders. Partial, stale, mixed, missing, or
  unlisted export bundles must fail validation.

## JavaScript is display-only

- **Status:** Accepted
- **Date:** June 2026; explicitly reinforced on 25 June 2026 when official medal
  ownership moved back to Excel.
- **Decision:** JavaScript loads, validates for safe rendering, links, sorts by
  exported display order, and displays exported values. It does not calculate
  championship outcomes.
- **Rationale:** Browser-side calculation would create a second source of truth.
- **Consequences:** Age grades, rankings, championship status, crowns, target
  times, and medal positions must arrive from Excel/VBA-owned exports.

## Public site navigation uses static page separation

- **Status:** Accepted
- **Date:** 10 July 2026
- **Decision:** The public site separates the visitor experience into static
  Overview, Championships, and Hall of Fame pages, with athlete profiles
  remaining on `athlete.html`. A shared navigation helper preserves the selected
  `?site=family` or `?site=everyone` mode across public pages and profile
  links.
- **Rationale:** Championships, honours, and history should be discoverable as
  normal pages rather than being presented as one long landing page. Static
  pages keep the GitHub Pages architecture simple and reviewable without adding
  a client-side router or framework.
- **Consequences:** Navigation and mode switching must be tested for both site
  modes on Overview, Championships, Hall of Fame, and athlete pages. JavaScript
  remains display-only: championship standings, honours, crown history, records,
  and profile data continue to come from workbook-exported CSVs.

## Workbook exports are staged before public-data promotion

- **Status:** Accepted
- **Date:** 2 July 2026
- **Decision:** The private workbook writes one complete website-data bundle to
  a fresh ignored staging folder. Repository tooling validates and reconciles
  that bundle before a separate explicitly approved promotion can replace
  tracked `data/`. The approved staging parent is a clearly named value in the
  workbook's existing `Settings!tbSettings` configuration table, not an
  absolute repository path embedded in VBA.
- **Rationale:** A staged manifest-last export proves completeness and internal
  consistency without risking partial, stale, mixed, or selectively copied
  public data.
- **Consequences:** The official broad workbook exporter no longer writes
  directly to tracked `data/`. Failed exports delete their incomplete staging
  folder. Promotion requires a clean tracked data tree, successful validation,
  human review of meaningful differences, and explicit approval. Staging-root
  validation is fail-closed: it accepts only a canonical fresh immediate child
  of the configured parent and rejects the repository root, tracked `data/`,
  its descendants, and relative or ambiguous paths.

## Main is PR-gated, with Netlify previews

- **Status:** Accepted policy; repository automation and an active default-branch
  ruleset are implemented. The ruleset was verified through GitHub's API on
  30 June 2026.
- **Date:** Release protocol established 25 June 2026; automated Netlify preview
  review links added 28-29 June 2026; hosted ruleset verified 30 June 2026.
- **Decision:** Substantial changes use a feature branch and Pull Request.
  Automated checks and a successful Netlify Deploy Preview for both site modes
  precede review, and `main` is intended to be the protected production branch.
- **Rationale:** Reviewable previews and checks reduce the chance that an
  incorrect export or display change reaches GitHub Pages.
- **Consequences:** Do not commit or merge directly to `main`. No merge or
  production release occurs without explicit John approval. The active ruleset
  requires a Pull Request, resolved review threads, and the strict
  `Test static site` check, and blocks deletion and non-fast-forward updates.
  It currently requires zero approving reviews and does not list Netlify's
  Deploy Preview status as a required check, so those documented safeguards
  still rely on process rather than hosted enforcement.

## Crown history is exported, not reconstructed in the browser

- **Status:** Accepted and released
- **Date:** Defined 27 June 2026; released 28 June 2026 in merge commit
  `a8442b7`.
- **Decision:** Excel/VBA replays authoritative results and exports All-Time
  Official crown-holder changes independently for Family and Everyone.
  JavaScript renders the exported chronology.
- **Rationale:** Correct history depends on workbook-owned eligibility,
  tie-breaks, corrections, and prior-holder state that public snapshots cannot
  reliably reconstruct.
- **Consequences:** Both site folders require `crown_history.csv`. The browser
  must not infer missing history, synthetic vacancies, prior holders, or
  Current/12-Month crown events.
