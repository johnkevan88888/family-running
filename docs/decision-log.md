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

## Absolute records are workbook-owned raw-time records

- **Status:** Accepted
- **Date:** 18 July 2026
- **Decision:** Absolute records are the fastest official raw times by sex and
  distance, exported separately for Family and Everyone. Excel/VBA owns the
  record selection and exposes the auditable source rows on the private
  `AbsoluteRecords` worksheet.
- **Rationale:** Absolute records are intentionally non-age-graded, but they
  still need the same single-source-of-truth boundary as standings, medals,
  crowns, and age-grade standards.
- **Consequences:** The public Records page renders only
  `data/<site>/absolute_records.csv`. It must not derive records from
  leaderboards or athlete-result CSVs in JavaScript. Record updates require a
  workbook export, staged review, and explicitly approved public-data
  promotion.

## Public site navigation uses static page separation

- **Status:** Accepted
- **Date:** 10 July 2026
- **Decision:** The public site separates the visitor experience into static
  Championships, Hall of Fame, and Overview pages, with athlete profiles
  remaining on `athlete.html`. `index.html` is the Championships landing page,
  `championships.html` remains as a direct-link compatibility page for the full
  standings experience, and `overview.html` contains descriptive public-export
  statistics and recent official results. A shared navigation helper preserves
  the incoming `?site=family` or `?site=everyone` mode across same-site public
  pages and profile links without presenting a Family/Everyone switch UI.
- **Rationale:** Championships, honours, and history should be discoverable as
  normal pages rather than being presented as one long landing page. Static
  pages keep the GitHub Pages architecture simple and reviewable without adding
  a client-side router or framework. Family and Everyone are separate public
  sites, so cross-site movement should happen by entering the corresponding site
  URL rather than by an in-page toggle.
- **Consequences:** Navigation must be tested for both site modes on
  Championships, Hall of Fame, Overview, and athlete pages. JavaScript remains
  display-only: championship standings, honours, crown history, records, and
  profile data continue to come from workbook-exported CSVs. Overview
  statistics may summarize exported public official-result rows for display,
  but must not calculate championship outcomes, rankings, medals, crowns,
  records, age grades, or workbook-owned values.

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

## Main is PR-gated, with conditional Netlify previews

- **Status:** Accepted policy; repository automation and an active default-branch
  ruleset are implemented. The ruleset was verified through GitHub's API on
  30 June 2026.
- **Date:** Release protocol established 25 June 2026; automated Netlify preview
  review links added 28-29 June 2026; hosted ruleset verified 30 June 2026;
  lightweight data-refresh pathway added 5 August 2026; custom-domain pathway
  added 9 August 2026.
- **Decision:** Changes use a feature branch and Pull Request. Code,
  configuration, schema, export-set, and broader documentation changes require
  automated checks and a successful Netlify Deploy Preview for both site modes.
  A routine existing-schema public CSV refresh, such as adding new race times,
  may put `[skip netlify]` in the Pull Request title and use full automated
  checks, exact CSV diff review, and responsive screenshots without generating
  a Netlify preview. A narrowly scoped custom-domain configuration may use the
  same marker because its hostname, DNS, redirect, and certificate behavior can
  only be verified on GitHub Pages after merge. `main` remains the protected
  production branch.
- **Rationale:** Reviewable previews and checks reduce the chance that an
  incorrect export or display change reaches GitHub Pages.
- **Consequences:** Do not commit or merge directly to `main`. No merge or
  production release occurs without explicit John approval. The active ruleset
  requires a Pull Request, resolved review threads, and the strict
  `Test static site` check, and blocks deletion and non-fast-forward updates.
  The lightweight route fails closed unless every tracked public CSV is
  refreshed, every changed runtime file is an existing CSV under `data/` with
  an unchanged header, and only
  `docs/active-work.md` notes may accompany those exports. Every automated test
  and screenshot still runs. The custom-domain route requires a syntactically
  valid root `CNAME` and accepts only its explicit domain, analytics, test,
  workflow, and documentation allowlist. The active ruleset should not list Netlify's
  Deploy Preview status as an unconditional required check because eligible
  lightweight Pull Requests intentionally do not create it; the full-preview
  requirement for other changes remains a documented process gate.
  Routine data refreshes use a guided local wrapper that automates branch
  creation, full-bundle staging, validation, reconciliation, tests, and Pull
  Request creation while retaining separate typed confirmations for data
  promotion and publication. The wrapper never merges or deploys.

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

## Production usage analytics are aggregate and cookie-free

- **Status:** Accepted
- **Date:** 22 July 2026
- **Decision:** Production pages use the hosted GoatCounter account
  `familyrunning.goatcounter.com` for aggregate visit statistics. The tracker
  loads only on `www.aceofrace.com`, `aceofrace.com`, and the legacy
  `johnkevan88888.github.io/family-running` address; local development, Netlify
  previews, unrelated subdomains, and other GitHub Pages projects are excluded.
  Analytics paths retain the selected Family/Everyone mode and public athlete
  ID where relevant, but discard other query parameters.
- **Rationale:** The site owner needs a simple indication of whether and how the
  public site is used without introducing cookies, persistent browser storage,
  personal visitor profiles, or inflated counts from review traffic.
- **Consequences:** Every tracked page displays a concise GoatCounter
  disclosure. The public endpoint and provider-recommended loader configuration
  belong in source control, but account passwords and API keys never do. Do not
  add a subresource-integrity pin for mutable external loader content: a stale
  pin blocks the script and prevents all visit collection. Client-side blocking
  means statistics are indicative rather than an exact access log.

## Age-grade comparisons group exported benchmarks by result class

- **Status:** Accepted and implemented; not yet released
- **Date:** 31 July 2026
- **Decision:** The public Calculator selects a Challenger and The Standard,
  then shows source performances from the workbook-owned comparison export in
  two sections: official results first and unofficial results below. Each
  section independently contains The Standard's exported best age-graded and
  fastest raw-time performance at each available distance and the exported
  time the Challenger must beat to score a higher age grade than each
  performance. The duplicate
  single-athlete race-target builder is omitted because equivalent targets are
  already available on athlete pages. The browser does not interpolate
  percentages or derive pairwise target times.
- **Rationale:** Interactive selection makes workbook-owned standards easier to
  use without creating a second calculation path that can disagree with
  Excel/VBA.
- **Consequences:** Pairwise comparison uses the site-specific workbook-owned
  `athlete_comparison_targets.csv` contract, groups rows by the exported
  `StandardTimeClass`, requires both benchmark types for every available result
  class, and stays unavailable when that file is absent from the current export
  manifest. Family and Everyone Calculator views must load only their own
  comparison exports while continuing to use shared public athlete names.
  Source benchmark performances remain auditable against
  `data/athlete_results.csv`.

## Challenge defaults and period display are browser presentation choices

- **Status:** Accepted and implemented; period-labelled workbook export pending
- **Date:** 8 August 2026
- **Decision:** Challenge the Standard displays Current and All Time standards
  through a single period switch instead of duplicating cards. When the same
  exported source performance is both Best Age Grade and Fastest Time, one row
  retains both badges. The initial athletes are the closest age-grade
  percentage rivalry among the exported top five Current Official Overall
  championship rows, with the lower-ranked athlete challenging the
  higher-ranked athlete.
- **Rationale:** One period at a time keeps the existing official/unofficial and
  distance hierarchy readable. The default matchup makes the page immediately
  relevant while using only already-exported ranking and percentage values.
- **Consequences:** The browser may choose this initial view and merge identical
  display rows, but it still cannot derive age grades or target times. The
  comparison export adds a `Period` dimension owned by Excel/VBA. Legacy rows
  without that field remain readable as All Time during the schema transition.

## Ace of Race is the constant public brand across both data modes

- **Status:** Accepted and implemented; not yet released
- **Date:** 9 August 2026
- **Decision:** The public product name is Ace of Race in both query-string
  modes. Family and Everyone remain visible mode badges and continue to select
  isolated workbook-exported data, but workbook `SiteName` values no longer
  replace the shared wordmark after page load.
- **Rationale:** One stable identity makes the custom domain, navigation,
  favicon, social previews, and verbal system coherent. Treating Family and
  Everyone as modes preserves the existing data architecture without creating
  two competing brands.
- **Consequences:** Public page titles, metadata, header UI, and share imagery
  use Ace of Race. The `SiteName` row remains required for export compatibility
  until the private workbook contract is changed deliberately. Tests assert
  the constant brand separately from mode isolation, and the preview artifact
  must include `brand.css` and the production brand assets.
