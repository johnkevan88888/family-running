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

## Main is PR-gated, with Netlify previews

- **Status:** Accepted policy; repository automation is implemented, but hosted
  enforcement is pending. GitHub's API reported no active branch-protection
  rule for `main` on 30 June 2026.
- **Date:** Release protocol established 25 June 2026; automated Netlify preview
  review links added 28-29 June 2026.
- **Decision:** Substantial changes use a feature branch and Pull Request.
  Automated checks and a successful Netlify Deploy Preview for both site modes
  precede review, and `main` is intended to be the protected production branch.
- **Rationale:** Reviewable previews and checks reduce the chance that an
  incorrect export or display change reaches GitHub Pages.
- **Consequences:** Do not commit or merge directly to `main`. No merge or
  production release occurs without explicit John approval. Hosted branch
  protection and required-check settings still need to be enabled and verified
  in GitHub.

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
