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

## The canonical workbook is preflight-coupled to the repository export contract

- **Status:** Accepted and implemented
- **Date:** 25 August 2026
- **Decision:** The stable private `CODEX WORKING COPY.xlsm` path is the single
  workbook used for routine data updates. A feature draft cannot satisfy a newly
  merged repository export contract until its verified exporter changes and the
  canonical workbook's newer data are reconciled into one backed-up working
  copy. The workbook exposes a side-effect-free automation function returning a
  repository-owned contract ID and SHA-256 schema fingerprint; the guided updater
  checks it read-only before creating a refresh branch and the full exporter
  checks it again before writing a staged bundle.
- **Rationale:** Official Results News was implemented in a separate draft while
  the launcher continued selecting a valid pre-News 70-file working copy. After
  the repository moved to 72 files, the split was discovered only by the later
  staged-set validator. The canonical working copy also contained newer result
  and participant rows, so selecting the dated draft would have lost data.
- **Consequences:** `scripts/workbook-export-contract.json` records the readable
  contract ID, 72-file/71-manifest-entry counts, 64-column News requirement, and
  a deterministic fingerprint of every sorted public CSV path plus its exact
  header. Missing or mismatched workbook capability fails before export and
  names the selected workbook. An explicit `--workbook` override must satisfy
  the same contract. The marker is an early compatibility check, not a new data
  authority: workbook post-export checks and repository staged file, header,
  bundle, and content validation remain authoritative. Any future public path or
  header change updates the JSON definition, workbook marker, tests, and
  documentation atomically.

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
- **Date:** 18 July 2026; complete-matrix export enforcement added
  11 August 2026
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
- **Complete-matrix enforcement, 11 August 2026.** Validation originally checked
  each row's own fields but nothing about the set, so a dropped, duplicated,
  misfiled, or reordered record would have passed and the Records page would
  simply have shown fewer records than exist. A valid export is now the complete
  fixed matrix: exactly one row for each of Men and Women at Marathon, Half
  Marathon, 10 Mile, 10 km, and 5 km, in that order. `RecordGroup` must be `Men`
  or `Women` and must agree with the row's own `Sex`, because `RecordGroup` is
  the heading the page renders. `RecordTitle` must be unique, `ResultDistance`
  must be the same distance as `Distance`, and `SortOrder` must be numeric,
  unique, and strictly increasing so the exported order is reproducible rather
  than incidental. Vacant records are preserved deliberately: "No eligible
  result" and "Championship Vacant" still occupy their place in the matrix and
  carry no performance to check. This constrains what the workbook may export,
  because it can no longer legitimately ship a partial or reordered set. Unlike
  the withdrawn staging-parent claim, this repository verifies it: the supported
  sexes and distances are `absoluteRecordSexes` and `absoluteRecordDistances` in
  `scripts/validate-csv.mjs`, and adding or removing a supported distance means
  changing those constants in the same change as the export.

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
  added 9 August 2026; guarded routine-data auto-merge added 9 August 2026;
  no-visual classifier added 10 August 2026; exact-bundle post-merge production
  gate added 27 August 2026; no-visual policy surfaces reconciled 28 August
  2026.
- **Decision:** Changes use a feature branch and Pull Request. A diff that can
  alter the published artifact or any file controlling dependency installation,
  artifact construction, or deployment requires automated checks and a
  successful Netlify Deploy Preview for both site modes. A diff with no
  published or publishing-control path, and whose remaining paths are all
  recognized as non-public, may put `[skip netlify]` in its title because the
  static preview cannot display the change; full tests, responsive screenshots,
  exact-diff review, and any service-specific evidence remain required. A
  routine existing-schema public CSV refresh, such as adding new
  race times, may use the marker with exact CSV diff review. A narrowly scoped
  custom-domain configuration may use it because hostname, DNS, redirect, and
  certificate behavior can only be verified on GitHub Pages after merge.
  `main` remains the protected production branch.
- **Rationale:** Reviewable previews and checks reduce the chance that an
  incorrect export or display change reaches GitHub Pages.
- **Consequences:** Do not commit or merge directly to `main`. No merge or
  production release occurs without explicit John approval. The active ruleset
  requires a Pull Request, resolved review threads, and the strict `Test static
  site` check, and blocks deletion and non-fast-forward updates.
  The no-visual route fails closed unless at least one file changed, every path
  is absent from both the published-artifact list and the publishing-control
  set, and every remaining path is positively recognized as non-public. The
  artifact and control definitions are shared with the artifact build; root
  dependency/workspace configuration, checkout attributes, build and
  publication contracts, the release-path guard, and workflows cannot qualify.
  Under the unmodified gate, the validator, its artifact-list source, and every
  workflow are controls and cannot qualify. A Pull Request changing one must use
  the standard preview pathway and separate John review. Because this gate runs
  as Pull Request workflow code, it is a regression and process control rather
  than an independent adversarial trust boundary, and it grants no automatic
  merge authority outside the narrow guided data-refresh route.
  Private administration code may qualify, but still requires its own
  authenticated/environment-specific review when applicable.
  The lightweight route fails closed unless every tracked public CSV is
  refreshed, every changed runtime file is an existing CSV under `data/` with
  an unchanged header, and only
  `docs/active-work.md` notes may accompany those exports. Every automated test
  and screenshot still runs. The custom-domain route requires the exact approved
  root `CNAME` and accepts only its explicit CNAME, production-only analytics,
  Pull Request template, test, and documentation allowlist. That narrow route
  deliberately covers production DNS/HTTPS and host-only analytics behavior
  that a Netlify hostname cannot prove; the guard and preview-comment workflow
  cannot accompany it. The active ruleset should not list Netlify's
  Deploy Preview status as an unconditional required check because eligible
  skip pathways intentionally do not create it; the full-preview requirement
  for other changes remains a documented process gate.
  Routine data refreshes use a guided local wrapper that automates branch
  creation, full-bundle staging, validation, reconciliation, tests, and Pull
  Request creation while retaining separate typed confirmations for data
  promotion and publication. For this narrow pathway, `PUBLISH` is explicit
  John approval to wait for the required GitHub check, re-verify the PR title,
  base, branch, and exact tested commit, merge through the protected Pull
  Request route, fast-forward local `main`, delete the merged local and remote
  data branch, and remove only the saved artifacts belonging to that update.
  The tested data diff is fingerprinted before approval. Code, schema,
  configuration, export-set, and broader documentation changes cannot use this
  automatic authority.
- **No-visual policy correction, 28 August 2026.** The path-aware
  `no-visual-change` classifier and its tests had existed since 10 August, but
  the Pull Request template, bot comment, decision text, and release overview
  still named only the data-refresh and custom-domain skip cases. Pull Request
  #75 consequently ran a Netlify preview even though its release tooling,
  tests, and documentation could not enter or alter that artifact. The policy
  surfaces now expose the existing pathway consistently. The unmodified guard
  rejects workspace/checkout configuration and changes to the guard itself,
  requiring the standard pathway plus separate John review.
- **Correction, 12 August 2026.** The paragraph above described `PUBLISH` as
  approval to merge. That was accurate but unsound, and audit finding P2-04
  identified why: `PUBLISH` is typed before the Pull Request is created, so it
  could not be approval of the exact committed diff or the responsive
  screenshots, neither of which exists at that point. Meanwhile this protocol
  told John that both are reviewed before approval. The code proved screenshots
  were *generated*, never that anyone looked at them. The guided pathway now
  splits the two: `PUBLISH` authorizes committing, pushing, opening the Pull
  Request, and waiting for its required check; the run then stops, prints the
  Pull Request, its exact diff command, and the run holding the screenshot
  artifact, and requires a separate exact `MERGE` before publishing. `MERGE` is
  the production approval, and after it the updater re-reads GitHub to
  re-verify Pull Request identity, that the head commit is still the validated
  one, and that the required check still succeeds, so a push during the review
  pause is refused rather than merged. Declining leaves the Pull Request open
  and the update resumable. The custom-domain route also now requires the exact
  approved hostname rather than any syntactically valid one, which was audit
  finding P2-02.
- **Post-merge verification, 27 August 2026.** A completed merge and a green
  deployment are necessary but do not prove that the custom domain is serving
  the reviewed data. The guided routine-data updater therefore records
  `merged` and `production-verified` as separate resumable phases. After
  `MERGE`, it waits for the Pages workflow run whose head is the exact merge
  commit, then compares the production manifest and all 71 listed CSV files
  byte-for-byte with the immutable reviewed data commit. It finally opens the
  Family and Everyone production URLs in a real browser and requires their
  correct mode, title, rendered standings, selected-mode requests, and export
  bundle identity. Cache-revalidation headers are used; HTTP 200 alone is not
  evidence. The branch, staged export, promotion backup, and updater state are
  retained on failure, and `--resume` retries only this proof. Cleanup is
  structurally refused until `production-verified`, so a verifier interruption
  cannot cause another merge or destroy its recovery evidence.

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

## Official Results News is a workbook-owned historical replay

- **Status:** Accepted and implemented locally; approved 72-file data bundle
  promoted and validated; medal-entry extension complete; not released
- **Date:** 23 August 2026
- **Decision:** Excel/VBA independently reconstructs Family and Everyone
  Official-result milestone history from the presently valid result set. A
  milestone is a first Official result at one of the six contracted distances,
  a strict full-precision age-grade personal best at that athlete/distance, a
  strict Official raw-time personal best at that athlete/distance, or both.
  Genuine source-time precision is preserved through milliseconds for raw
  times and improvements, formatted `HH:MM:SS[.fff]`; the coarser public
  `athlete_results.csv` time must not force News values to whole seconds.
  Same-day replay is ascending result date then authoritative `SourceRow`.
  Current rank snapshots apply expiries before the result and use the
  workbook's strict rolling rule, `result date > D - 365 days` and
  `result date <= D`; All-Time snapshots contain every earlier replayed
  Official result. The browser displays the exported milestone, deltas, and
  before/after ranks without recalculating them. Athlete, year, and distance
  filters and a latest-first `Show older` control may select and progressively
  reveal already exported rows while preserving `SortOrder`; they remain
  presentation behavior and do not create a second replay or ranking path.
  Individual cards may compactly arrange the same exported content as a
  desktop left-to-right Result, PB improvement or baseline, and Championship
  movement flow, then stack those stages in the same order on mobile.
  Connector arrows are decorative and carry no information unavailable from
  the semantic content order. A result entering a medal position is also
  workbook-owned. Four context-aligned fields independently export blank,
  `Gold`, `Silver`, or `Bronze` for Current Distance, Current Overall, All Time
  Distance, and All Time Overall. They populate only for a crossing from
  unranked or Rank 4+ into Rank 1/2/3; movement within an existing medal
  position is not a new entry. Competition rank supplies tie semantics, and
  the browser may celebrate only the exported values rather than inferring a
  medal from before/after ranks.
- **Rationale:** Exact milestone selection and historical positions depend on
  full-precision age grades, source order, site eligibility, the workbook's
  rolling-window rule, and the same ranking logic as the live Official tables.
  Public result rows and current leaderboard snapshots do not carry enough
  information to reproduce those decisions safely. Although the News row
  carries before/after ranks for display, having the browser convert them into
  medals would create a second championship-award rule. Four aligned enums are
  the smallest robust export shape that preserves which of several simultaneous
  contexts changed and which medal each one entered.
- **Consequences:** The first draft adds required site-specific
  `data/family/official_result_news.csv` and
  `data/everyone/official_result_news.csv` exports. The workbook draft produced
  a staged 72-file bundle with authoritative row counts of 43 for Family and 64
  for Everyone. The staged validator passed, and reconciliation against tracked
  data found only the two new News CSVs plus the manifest. After explicit
  approval, that bundle became the tracked 72-file contract and passed the
  complete repository, artifact, browser, and responsive validation suite.
  Corrections, deactivation, or eligibility changes may legitimately rewrite
  older News because this is a replay of current valid history, not an archive
  of previously published pages. Current-window expiries and administrative
  changes do not create standalone entries. The workbook must compare the
  replay's final Current and All-Time state with the same bundle's complete
  Official leaderboards before it may write the manifest. The exact schema,
  blank rules, display behavior, and acceptance plan are in
  [Official Result News Contract](official-news-contract.md). Promotion and
  local validation do not publish the feature; release remains a separate
  explicit approval. Filtering and progressive reveal require no workbook or
  schema change: clearing filters and revealing all batches must reproduce the
  complete selected-mode export in its authoritative order. Compact card flow
  likewise changes no export, calculation, milestone, improvement, or rank;
  it only changes how each already exported row uses the available width. The
  completed responsive validation covered both modes at 1440 x 900, a 720px
  intermediate width, and 390 x 844, with reviewed screenshots and no
  overflow. All tested real-data cards remained within the 320px desktop and
  850px mobile height ceilings, making the visible history about 55% shorter on
  desktop and 37% shorter on mobile than the preceding layout. The medal-entry
  extension expands the News header from 32 to 36 columns without adding
  another public file or changing milestone selection. One result may carry
  several medal entries, Family and Everyone may differ, and 1 Mile remains
  Overall-only. The page uses an explicit `Medal breakthrough!` callout and
  labelled per-context medal badges, so colour is not the only signal and the
  wording does not claim a permanent award. The refreshed staged 72-file export
  passed validation; reconciliation found only the two News CSVs meaningfully
  changed and preserved every prior News fact, rank, and delta. Atomic promotion
  and tracked-data validation pass. The promoted rows contain 24 Family cards
  with 59 medal-entry contexts and 34 Everyone cards with 77. The focused
  synthetic regression suite and complete `pnpm test` suite pass. After current
  `main`, including the Gallery baseline, was integrated locally, the combined
  114-file artifact and both-mode desktop/mobile browser coverage also passed.
  Refreshed News and Gallery screenshots were manually reviewed without
  overflow. Merge commit `65190fe` is pushed to Pull Request #68; GitHub reports
  it clean and mergeable, and both the required static-site check and combined
  Deploy Preview passed. This is not merged or released.

## News medal-position snapshots remain workbook-owned

- **Status:** Accepted product and architecture decision; coordinated schema
  migration required before release
- **Date:** 24 August 2026
- **Decision:** Retain the four threshold-only `MedalEntry` fields and add
  workbook-owned `MedalBefore` and `MedalAfter` fields immediately after each
  one, growing the Official Results News export from 36 to 44 columns. Each
  snapshot is blank, `Gold`, `Silver`, or `Bronze` and records that same
  context's workbook-owned before or after competition-rank medal state. The
  page uses the exported snapshots to label existing-medal transitions such as
  `Silver` to `Gold`; it must not translate ranks into medal labels.
- **Rationale:** `MedalEntry` correctly answers a narrow question—whether this
  result newly crossed into the medal positions—but intentionally stays blank
  for Rank 3 to Rank 2, Rank 2 to Rank 1, and retained medal positions. The
  missing label is therefore missing source data, not a presentation inference
  for JavaScript to repair. Adding separate snapshots preserves the existing
  breakthrough semantics while carrying the information required to render all
  actual medal-position movements safely.
- **Consequences:** The exact header, workbook exporter and post-export checks,
  validator, export-bundle fixtures, browser fixtures, News rendering, and
  responsive review must migrate together. A Rank 2 to Rank 1 row has blank
  `MedalEntry`, `Silver` `MedalBefore`, and `Gold` `MedalAfter`. Entry into a
  medal position retains its existing explicit callout; an upgrade or retained
  position does not become a new entry. The two News files remain the only
  semantically changed public data files and the 72-file bundle shape remains
  unchanged, but a fresh atomic full export and full validation are required.

## News displaced-medal holders remain workbook-owned

- **Status:** Accepted product and architecture decision; coordinated schema
  migration completed locally and awaiting PR review
- **Date:** 24 August 2026
- **Decision:** Extend each Official Results News medal context with four
  workbook-owned fields after `MedalAfter`: the displaced athlete's public ID
  and name, followed by their prior and resulting medal. This grows the exact
  export from 44 to 60 columns. A complete quartet represents one verified
  former holder of the News athlete's newly claimed medal and is allowed only
  for `Gold → Silver`, `Silver → Bronze`, or `Bronze → No medal`; otherwise
  all four fields remain blank.
- **Rationale:** A new or upgraded medal position can displace another
  athlete, but the browser has neither the historic full table nor authority
  to infer who that was. A direct export preserves the current selected-mode
  replay and source tie-break semantics while avoiding a misleading singular
  attribution in absent or ambiguous cases.
- **Consequences:** The workbook verifies the prior holder against its own
  before/after snapshot. Repository validation requires a complete-or-blank,
  public, selected-mode, non-self quartet with the allowed chain; browser code
  only renders and links a complete valid export. Gallery's media-only
  `hidden-athlete-ids.json` is not a News visibility policy and is never
  fetched for this feature. `MedalEntry` remains the sole breakthrough callout
  signal. The full 72-file export remains atomic, and only the two News CSVs
  change semantically.

## News ranked-athlete counts remain workbook-owned

- **Status:** Accepted product and architecture decision; coordinated schema
  migration promoted locally and validated by the complete suite, awaiting PR
  review
- **Date:** 24 August 2026
- **Decision:** Add one workbook-owned post-result count immediately after
  each Official Results News `RankAfter`, growing the exact export from 60 to
  64 columns: `CurrentDistanceRankedAthleteCountAfter`,
  `CurrentOverallRankedAthleteCountAfter`,
  `AllTimeDistanceRankedAthleteCountAfter`, and
  `AllTimeOverallRankedAthleteCountAfter`. Each is the number of distinct
  athletes represented in that exact selected-mode, period, and
  Distance/Overall after-snapshot table with a qualifying Official
  performance; it is positive, includes the News athlete, and is at least
  that athlete's `RankAfter`.
- **Rationale:** A rank alone hides the size of the eligible championship
  field, while the browser has neither the historical table nor authority to
  count it. Reusing the workbook's after snapshot lets News render `#1 / 12`
  accurately, including when Current expiries or tied competition ranks make
  the table size non-obvious.
- **Consequences:** The count is never a raw result count, roster size,
  maximum rank, or browser calculation. It is blank with an unavailable table,
  including each 1 Mile Distance context, while 1 Mile Overall remains
  populated. The page fails closed for a missing, malformed, zero, or
  below-rank count and displays the compact displaced-holder attribution only
  as `Gold taken from Alex`, without a claimed later medal status. The exact
  header, workbook exporter, validator, fixtures, browser rendering, and
  responsive review must change together; a fresh atomic full bundle remains
  required.

## Production usage analytics are aggregate and cookie-free

- **Status:** Accepted; scope of the third-party-runtime prohibition clarified
  11 August 2026
- **Date:** 22 July 2026; exception to the no-third-party-runtime rule recorded
  11 August 2026
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
- **Clarification, 11 August 2026.** This entry and `AGENTS.md` contradicted
  each other for three weeks. `AGENTS.md` stated flatly that the public site
  must not load runtime code from a third-party CDN, which is what `vendor/`
  exists to guarantee, while this decision requires exactly that for analytics
  and forbids pinning it. The 11 August 2026 audit remediation surfaced the
  contradiction without changing any analytics code, and John resolved it by
  narrowing the prohibition rather than changing the integration. The rule now
  reads: no third-party runtime code for site functionality. The GoatCounter
  loader is the single named exception, because every page renders identically
  if it never loads. Two consequences are accepted knowingly rather than fixed.
  Without an integrity pin, whatever `gc.zgo.at` serves executes with full page
  privileges on the production domain; that is the deliberate trade against a
  stale pin, which is a certain failure rather than an unlikely one. And because
  the loader runs only on production hostnames while the browser smoke tests
  abort every cross-origin request, no automated test exercises it. Neither the
  vendored-library check nor the published-`vendor/` contract says anything
  about that host. Do not add a second exception, and do not extend this one to
  anything a page needs in order to work.

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

## GitHub Pages publishes a built artifact, not the repository root

- **Status:** Accepted and implemented
- **Date:** 10 August 2026
- **Decision:** Production is deployed by `.github/workflows/deploy-pages.yml`,
  which builds the runtime artifact and publishes only that. Pages no longer
  serves the repository root. `CNAME` is part of the artifact, so the
  `www.aceofrace.com` custom domain survives the change.
- **Rationale:** Serving the repository root made every tracked non-runtime file
  publicly readable at its path on the live site. `AGENTS.md`,
  `docs/decision-log.md`, `docs/active-work.md`, and `package.json` all returned
  HTTP 200 on the production domain. Those documents describe the private
  workbook, the staging and promotion workflow, and known governance gaps. No
  credential or workbook was ever exposed, but the public surface was wider than
  intended and easy to widen further by accident.
- **Consequences:** The published artifact is the definition of the public site.
  A file that is not in `runtimeEntries` is not on the web, so new runtime files
  must be added there or they will 404 in production. The build fails if
  documentation, scripts, tests, workflow files, or repository configuration
  appear in the artifact, and fails if `CNAME` is missing. Previews and
  production now build through the same script, so preview fidelity improves.
  This does not change what the site itself publishes: exported public CSVs
  under `data/` remain readable by design, because the browser fetches them.

## The public site is excluded from search results

- **Status:** Accepted and implemented
- **Date:** 10 August 2026
- **Decision:** Every public page carries
  `<meta name="robots" content="noindex, follow">`, and `robots.txt` explicitly
  allows crawling. The site stays fully available to anyone with the link but is
  not listed in search results.
- **Rationale:** The site publishes real athletes' names, age categories, event
  names, and dates. John chose for it to be shareable rather than searchable.
  Crawling must stay allowed because a crawler has to fetch a page to read its
  noindex tag; a `Disallow` rule would prevent search engines ever seeing it and
  would leave already-indexed pages listed as bare URLs. Blocking `/data/` would
  be worse still, because every page renders from those exported CSVs, so a
  blocked crawler would index only "Loading..." placeholders.
- **Consequences:** New public pages must carry the tag; browser smoke tests fail
  if one does not. This governs search visibility only. It is not access control:
  the exported CSVs remain fetchable by anyone with the URL, because the browser
  needs them, and the repository is public so the same data is readable on
  GitHub. Making the data genuinely private would require authenticated hosting,
  which GitHub Pages does not provide. The Open Graph tags still work, so shared
  links continue to preview correctly in messaging apps.

## Gallery media is owner-curated and stored outside Git

- **Status:** Accepted and implemented locally; no media published yet
- **Date:** 23 August 2026
- **Decision:** Phase 1 adds a public, owner-curated Gallery without accepting
  visitor uploads. Family and Everyone each load their own versioned JSON
  manifest from `gallery-data/`. The manifests hold approved editorial metadata
  and absolute HTTPS media URLs; photograph and video files remain in dedicated
  external media storage rather than Git or the GitHub Pages artifact. Gallery
  items may be featured on Championships and Overview or associated with public
  athlete IDs for profile presentation, but they do not affect championship
  data or calculations.
- **Uploader preparation:** A future authenticated upload flow is constrained to
  select an exported race rather than accept a free-text event: the uploader
  chooses a race date, then one of the distinct event-and-distance combinations
  in public results for that date and site mode. People tags use public athlete
  IDs; runners in the selected race appear first, with other public athletes in
  that mode still available for spectators and supporters. The stored
  `raceDate`, `raceEvent`, `raceDistance`, and `athleteIds` fields already match
  that flow. File transfer, uploader identity, and moderation remain outside
  Phase 1 until authenticated media storage is selected. Captions are public;
  geotags and embedded device metadata remain private repository metadata. A
  public derivative strips them, and neither public manifest has a geotag field.
  The later 24–25 August 2026 decision below now selects that owner-only
  storage and access model without changing the completed Phase 1 public
  contract.
- **Person-tag suppression:** The shared owner-maintained
  `gallery-data/hidden-athlete-ids.json` list suppresses every item tagged with
  a listed public athlete ID across both site modes, including Gallery cards,
  featured moments, and athlete profiles. Suppression is applied before media
  elements are created, and a missing or malformed list makes the gallery fail
  closed. The file holds IDs only—never names, reasons, or request details—and
  may retain an unused ID to protect against a future tagged item. It is public
  metadata because this remains a static public site; a private administration
  record would require authenticated storage outside GitHub Pages.
- **Rationale:** GitHub Pages can render a gallery but cannot receive uploads,
  and committing video or growing photo libraries would permanently inflate Git
  history and the published artifact. Owner curation provides the visual benefit
  while retaining the existing static production and review model.
- **Consequences:** Excel/VBA is not involved in gallery publishing. The selected
  site mode requests only its own manifest. Repository validation rejects unsafe
  URLs, invalid schema, race tuples absent from that mode's public results,
  athlete tags outside that mode's public roster, and inconsistent shared items.
  The artifact contract permits only `family.json`, `everyone.json`, and
  `hidden-athlete-ids.json` under `gallery-data/`, so a photograph, video,
  private original, or scratch file saved there fails the build. Media is
  rendered with native browser image and video elements and no external
  JavaScript. Published media remains public: `noindex` reduces search
  visibility but is not access control. Hiding an item from the site does not
  delete it from the external media host, so a complete takedown removes it
  there as well. Consent review, metadata removal, a private-original boundary,
  and explicit release approval are part of the publishing workflow.

## Owner Gallery uploads use a separate authenticated service and reviewed manifest Pull Requests

- **Status:** Accepted; provider-independent Phase A and non-production Phase B
  infrastructure/authentication are implemented and verified; synthetic-only
  Phase C is deployed and remotely verified in non-production; the first local
  Phase D photo-processing and private-staging bridge slices are implemented
  but not committed, pushed, deployed, or published
- **Date:** 25–28 August 2026
- **Decision:** Keep the public championship site static and add no public
  upload page. A separate Cloudflare Worker administration application is
  protected in full by Cloudflare Access for one MFA-enabled owner identity and
  repeats the identity allowlist in application logic. Untouched originals live
  in a private R2 bucket; private draft, consent, moderation, state, and audit
  records live in D1; candidate derivatives stage in a second private R2 bucket;
  and verified derivatives explicitly approved for Pull Request preview move to
  a third bucket exposed only through a separate public read-only media Worker.
- **Storage-key organisation:** On 28 August 2026 the owner accepted permanent,
  server-generated v1 object keys rather than human or editorial filenames.
  Private originals use
  `private-originals/v1/{site}/{upload-year}/{upload-month}/{draft-id}/{upload-id}/original.{extension}`;
  private staging uses
  `derivative-staging/v1/{site}/{draft-id}/{processing-run-id}/{sha256}/{canonical-filename}`;
  and approved derivatives retain the existing exact
  `media/v1/{sha256}/{canonical-filename}` contract. The date segments are the
  server's UTC upload date, not the race date. Keys never contain an uploader
  name or email, original filename, race metadata, athlete identity, caption,
  consent, exclusion, location, device, or mutable state. D1 supplies private
  organisation and any friendly owner download name; the selected area's
  manifest alone determines where approved media appears. Existing synthetic
  `private-originals/phase-c/` objects remain unchanged. Real v1 uploads require
  a forward-only migration and reviewed lifecycle/test changes before use.
  Migration `0003_private_original_v1_keys.sql` and the server-only key builder
  are now implemented locally but not remotely applied. The migration preserves
  old rows and uses one narrow rolling-deployment compatibility branch for the
  exact Phase C UUID grammar while the updated Worker creates v1 only. This is
  required because a D1 migration and Worker replacement are separate platform
  operations; a later migration may remove legacy insertion only after every
  deployed Worker is confirmed v1-only.
- **Processing and publication:** A protected default-branch GitHub Actions job
  uses pinned photo/video and metadata-inspection tools. It may obtain one
  approved original through a narrowly scoped Access service route, but must
  never retain it as an artifact or disclose its bytes, filename, metadata,
  consent record, or credentials in public logs. It fails closed unless every
  derivative is free of location and device metadata. A repository-scoped
  GitHub App creates only a candidate branch and normal Pull Request. It has no
  merge authority. Existing Gallery validation, standard Netlify preview,
  responsive review, and explicit merge approval remain the only way a
  manifest reaches GitHub Pages.
- **Approval boundary:** Approval of the protected processing environment is
  the explicit authorization to make the verified unguessable derivative URLs
  reachable for Pull Request preview. Merge approval separately authorizes the
  public manifest to reference them. Rejected Pull Requests leave no production
  manifest change and their unreferenced derivatives are cleaned up. Real media
  is forbidden until synthetic upload, metadata-stripping, failure, deletion,
  and takedown rehearsals pass.
- **DNS:** The first implementation uses Cloudflare-managed `workers.dev`
  hostnames and does not move the existing production DNS. A first-party
  `media.aceofrace.com` hostname remains preferred but requires its own later,
  explicitly approved DNS migration and manifest transition.
- **Approved pilot boundary:** On 25 August 2026, the owner approved the
  `workers.dev` pilot and temporary processing of each private original on an
  ephemeral GitHub-hosted runner. This approval does not authorize provisioning,
  credentials, real-media transfer, public derivatives, Pull Requests, merge,
  deployment, publication, or DNS changes.
- **Phase B authorization and provider gate:** On 26 August 2026, the owner
  separately approved non-production Cloudflare provisioning and `workers.dev`
  deployment with synthetic text records only. That approval excludes DNS,
  real media, GitHub Apps, Pull Requests, merge, and production publication.
  On 27 August the owner accepted the projected usage-based cost and approved
  reuse of an existing Cloudflare account with isolated resource names. The
  OAuth grant was restricted to user/account read plus Workers, Worker-scripts,
  and D1 write; it did not grant Pages, DNS, AI, email, queue, or unrelated
  product access. The empty non-production D1 database and reviewed schema are
  provisioned in Cloudflare's automatic ENAM region. Zero Trust Free and account
  MFA are active, the $5 account-email budget alert is configured, and the
  three empty R2 Standard buckets have no public development URL or custom
  domain. The D1-only administration Worker and approved-R2-only media Worker
  are deployed on isolated `workers.dev` hostnames. The exact owner policy
  protects all administration production and preview traffic; its 30-minute
  reusable-policy duration overrides the longer application-level duration.
- **Phase B remote proof and cleanup:** Anonymous administration access fails
  and the exact owner reaches the private shell. A temporary exact Service Auth
  credential reached only the service health route; it was denied from browser
  routes, and a wrong credential failed at Access. The temporary token, reusable
  service policy, application assignment, and Worker automation allowlist secret
  were deleted immediately after the proof, and the revoked credential remains
  denied. The media Worker rejects its root, queries, nonexistent immutable
  objects, and writes. D1 remains empty and all three R2 buckets remain private
  and empty. No real media, public derivative, manifest change, DNS change,
  GitHub App, Pull Request, merge, or production publication was created.
- **Local Phase B boundary:** The admin Worker consumes Cloudflare's validated
  `ctx.access` identity, repeats an exact single-owner check, uses a signed
  30-minute browser session with same-origin and CSRF controls for mutations,
  and writes only one exact server-generated synthetic D1 canary with no
  request body. Its HTML is returned by the Worker because a Static Assets route
  does not carry `ctx.access`. Preview URLs are disabled. The Phase B admin
  Worker binds D1 only. The public media Worker has only the approved-derivative
  binding and exact immutable `GET`/`HEAD` routes; ranged reads fail closed
  unless the conditional response matches the prior ETag, object size, and
  exact range. It has no D1, originals, staging, listing, or mutation
  capability. D1 binds derivatives to the active consent plus item, export,
  source, and suppression revisions; blocks pending public-athlete-ID
  exclusions across whole-item tags, derivatives, and publicward states; and
  permits private-record purge only after terminal cleanup evidence and a
  surviving opaque tombstone. Tracked deployment examples contain names plus
  invalid local-replacement markers, never a real account, database, identity,
  URL, token, or secret.
- **Local Phase C boundary:** The Access-protected owner interface now uses a
  deterministic snapshot of current public exports for cascading date, race,
  distance, and public-athlete-ID selectors. The exact `?site=family` or
  `?site=everyone` entry context is a fixed label, not a destination selector.
  It is signed into a separate area cookie, injected into every draft by the
  server, and enforced on listing, reads, mutation, private-original access,
  and D1 insert/update guards. Each upload therefore belongs only to the area
  from which it was opened; missing, shared, forged-body, and cross-area
  requests fail closed. D1 stores private consent, guardian, optional evidence-
  reference, draft, multipart, receipt, and hashed audit facts. The admin Worker
  binds only D1 and private originals, accepts only built-in synthetic fixtures
  in this phase, uses sequential 5 MiB multipart uploads, reads exactly one
  bounded part into a fixed-length byte array so size, SHA-256, and first-part
  signature are checked before R2, verifies the complete R2 object with an
  independent streaming SHA-256, and exposes the original only to a current
  signed owner session through version-checked
  `GET`, `HEAD`, and range reads. An hourly
  internal cleanup job expires incomplete uploads after 24 hours only with
  confirmed abort/object absence. Part and completion routes independently
  reject a session at its exact expiry time, and a one-day provider lifecycle
  rule is limited to the Worker's `private-originals/phase-c/` prefix while
  preserving Cloudflare's global seven-day fallback. Staging, approved
  derivatives, manifests, GitHub, merge, and publication are unreachable from
  this Worker. The tracked
  Phase C configuration remains tracked without account identifiers; the
  ignored local configuration and synthetic-only non-production deployment now
  carry the reviewed originals binding and hourly schedule.
- **Phase C non-production proof:** On 28 August 2026 the owner separately
  approved migration `0002`, the private-original binding, hourly cleanup, the
  prefix-scoped one-day multipart fallback, deployment, and one built-in
  synthetic fixture in each site mode. Remote D1 has the complete 70-trigger
  schema and exactly one private-review Family photo plus one private-review
  Everyone video. Their completed private R2 bytes independently match D1's
  byte-count and SHA-256 evidence. The signed owner interface proves fixed-area
  isolation, runner-first public-ID tags, consent capture, checksum completion,
  and protected previews; anonymous original requests stop at Access. Direct
  bucket URLs remain disabled, all buckets have no custom domain, staging and
  approved-derivative storage remain empty, and the live public manifests and
  suppression list remain empty. No real media, derivative, public URL, DNS
  change, GitHub App, Pull Request, merge, or production publication was
  authorized or created.
- **Local Phase D photo-processing boundary:** The first derivative slice is a
  local synthetic-only module, not a Worker route or public upload feature. It
  accepts only JPEG and opaque PNG inputs with canonical site, draft, and
  processing-run identifiers. The standalone module validates their storage-key
  grammar but does not authenticate or look up a D1 draft; its future trusted
  integration must derive and verify them. It then uses exact pinned Sharp 0.35.2/libvips
  8.18.3 and ExifTool 13.40 tooling to produce fixed-profile WebP display and
  thumbnail derivatives. It decodes and auto-orients before a no-upscale resize,
  hashes finalized bytes, binds ExifTool inspection to those exact bytes before
  and after the scan, disables user configuration, rejects unexpected metadata
  or warnings, and returns immutable payloads with server-generated key plans.
  Temporary names and paths carry no editorial or identity data, while their
  private contents remain isolated until terminal cleanup; cleanup failure is
  terminal. The policy-to-storage mapping remains explicit: `video-playback`
  maps to storage role `video`. Video processing remains disabled until an
  immutable FFmpeg/ffprobe runner is selected; this slice has no storage,
  service identity, GitHub, manifest, Pull Request, merge, or publication
  capability. Both public manifests remain empty.
- **Local Phase D private-staging bridge boundary:** A separate processing
  Worker now joins the pinned photo processor to private evidence locally. It
  accepts one exact Access service identity and has exactly three bindings: D1,
  private originals, and derivative staging. It has no browser route,
  approved-media binding, public manifest, GitHub credential, promotion,
  deletion, merge, or publication capability. D1—not the caller—derives the
  signed site area, original, upload checksum/version, race/item, consent,
  athlete tags, catalog revisions, suppression revision, and opaque run and
  object keys. A run atomically claims one `approved-for-processing` draft.
  Each photo role is reserved in D1 before a conditional create in private R2,
  then independently read back and verified before it can become stored or
  verified. Exact retries can reconcile the narrow R2-success/D1-failure crash
  window; changed bytes, roles, metadata, or evidence cannot overwrite or take
  over an object. Current consent, draft revisions, the suppression snapshot,
  and unresolved athlete-wide exclusions are rechecked throughout the flow.
  Exact terminal transition keys make simultaneous staged/failure results
  single-winner operations, so a loser cannot create a contradictory draft,
  receipt, or audit state. A no-output consent withdrawal finishes only after
  the exact original upload row is terminally `deleted` with retained object
  evidence; any processing output instead fails closed pending cleanup.
  Migration `0004_private_processing_staging.sql` adds the append-only run and
  output evidence needed for this state machine. It blocks `candidate-public`
  absolutely and makes processing-derived derivative rows immutable. Successful
  completion leaves the draft in `processing` and both objects in private
  staging. Partial output is deliberately retained as private, evidenced state;
  any processing output blocks purge. Because an HTTP Worker has no hard
  wall-clock duration, a fixed delay cannot prove an in-flight R2 write has
  ended. Migration `0004` and the processing Worker must not be deployed until
  a companion cleanup design closes new writes, handles in-flight requests,
  verifies exact object absence, and preserves a hash-only audit commitment
  without weakening immediate consent/exclusion takedown. This local slice uses
  synthetic media only and changes no Cloudflare, GitHub, public-media,
  manifest, or site state.
  Supported multi-row start and failure changes use transactional `D1.batch()`;
  unsupported direct SQL may strand a non-public intermediate state, but the
  schema does not allow that partial state to stage, publish, mutate verified
  derivatives, or create a valid failure receipt. Recovery remains part of the
  required cleanup companion.
- **Local Phase D race-safe cleanup uses persisted one-part multipart handles:**
  The direct conditional R2 `put()` design is superseded before deployment.
  Each content-addressed derivative output is still reserved in D1 first, but
  the Worker then creates an empty multipart upload and persists its exact
  provider ID while the run's one-way write gate is open. Only a persisted
  handle may receive the single final part and complete. A cleanup request
  atomically closes that gate and snapshots all outputs and handles; D1 derives
  the only accepted reasons from a pending tagged-athlete exclusion,
  withdrawal, or terminal processing failure. Callers cannot select an area,
  race, athlete, role, key, upload ID, or deletion target.
  Cleanup aborts every persisted handle. If abort wins, an already admitted
  invocation cannot later complete. If completion wins, cleanup finds and
  fully verifies the exact private object before deleting it. Exact expected
  keys must return absent and the paginated server-built run prefix must list
  empty before a transactional D1 finalization removes operational derivative,
  handle, and output rows and appends a hash-only tombstone. No-output runs use
  the same closure and evidence path before purge. Retryable provider or D1
  failures preserve the closed intermediate evidence; exact retries converge
  on the same cleanup.
  This keeps the third Worker at exactly D1, private originals, and private
  derivative staging. It does not add approved-media, public-manifest,
  suppression-edit, GitHub, merge, deployment, or publication authority.
  Cleanup does not fabricate private-original or public-host deletion evidence,
  and resolving an athlete exclusion never reopens a closed run. The absolute
  `candidate-public` guard remains.
  The design relies on R2's provider-side multipart terminal state instead of a
  duration lease because HTTP Workers have no hard wall-clock limit. Cloudflare
  documents parallel abort/completion, immediate visibility after completion,
  and strong object deletion/list consistency, but does not phrase the exact
  abort-versus-complete race as a formal linearizability guarantee. Migration
  `0005_private_processing_cleanup.sql` and the combined Worker therefore remain
  local and synthetic-only. A separately approved non-production remote race
  rehearsal is still required before migrations `0004`–`0005` or the Worker can
  be deployed.
- **Service identity compatibility:** Worker-level Service Auth supplies a
  validated `ctx.access` context and an injected signed application assertion,
  but the current runtime resolves `ctx.access.getIdentity()` to `undefined` for
  that non-human caller. The Worker falls back only in that exact state, requires
  a strict service-token application claim with an Access issuer, empty subject,
  no email, Client ID form, positive issuance/expiry fields, and a string or
  array audience equal to `ctx.access.aud`, then repeats the exact encrypted
  Client ID allowlist check. Browser identities never use the assertion fallback.
  Missing, malformed, wrong-audience, wrong-identity, and non-service claims fail
  closed. Temporary redacted response-only probes established the production
  shape and were removed before the final deployment.
- **Rationale:** GitHub Pages cannot receive or authenticate uploads, and a
  hidden static page is not an access boundary. Cloudflare provides an isolated
  authenticated ingress and object-store boundary without changing the public
  host. A deterministic processor is retained outside Cloudflare Images/Stream
  because the first release needs one independently testable metadata-removal
  contract for both photos and videos. Pull Requests preserve the existing
  editorial ordering, mode isolation, the defensive duplicate-ID equality
  check, tests, preview, rollback, and explicit release approval.
- **Consequences:** The public `1.0` manifest and suppression schemas do not
  change. Consent, originals, admin identity, object keys, hashes, and private
  notes never become public manifest fields. The uploader revalidates the exact
  inherited site/date/event/distance/athlete tuple and current suppression list
  before processing and publication; it cannot direct one upload into the
  other site's manifest. Complete takedown remains host-first deletion
  followed by the manifest/suppression correction. Public derivative URLs are
  still public and downloadable; `noindex`, opaque paths, and a private bucket
  do not revoke a copy already downloaded by a visitor.
- **Plan:** See
  [Owner-Authenticated Gallery Upload Architecture](gallery-upload-architecture.md).

## Championship photography is a display layer over exported standings

- **Status:** Accepted and implemented locally
- **Date:** 23 August 2026
- **Decision:** Every non-vacant Current and All-Time championship table may
  display a three-card photo podium immediately before the unchanged table.
  Overall and every distance dropdown use the same order: Current podium,
  Current table, All-Time podium, All-Time table. Podium entries are the first
  three ranked rows in the workbook-exported order, and their medals come from
  each row's exported `Rank`. The browser does not select, score, or reorder a
  champion.
- **Media boundary:** Athlete-tagged items from the already filtered
  mode-specific gallery manifest decorate podium cards. The first approved
  photograph in editorial order is preferred, then a video poster. The shared
  person-tag suppression list is applied before any podium media element is
  created. Missing or suppressed media leaves a branded fallback.
- **Rationale:** Photography can make the championship human and recognisable
  without replacing the detailed lists or creating a second ranking system.
  Keeping the original tables directly below each podium preserves every
  exported field and the audit trail visitors already use.
- **Consequences:** Vacant and no-result tables remain valid and render without
  a fabricated podium. Category badges show only their first word to stay
  compact while retaining the complete exported category as an accessible
  label. Time and pace use a deliberate consistent line break. On mobile, the
  three podium cards remain in one compact row rather than becoming a long
  vertical stack. Tests cover both modes, Overall and a lazily opened distance,
  media suppression, fallbacks, responsive sizing, medals, table-field parity,
  and original Current-before-All-Time ordering.

## Correction: the workbook staging parent is not portable

- **Status:** Correction to an earlier entry; portability is open, not accepted
- **Date:** 10 August 2026
- **Decision:** The entry "Workbook exports are staged before public-data
  promotion" claimed the approved staging parent was "a clearly named value in
  the workbook's existing `Settings!tbSettings` configuration table, not an
  absolute repository path embedded in VBA". That is not true and appears never
  to have been. The workbook holds a hardcoded constant:
  `Private Const STAGING_PARENT As String = "C:\GitHub\family-running\test-artifacts\workbook-export-staging\"`.
  Everything else in that entry stands; only the portability claim is withdrawn.
- **Rationale:** The claim was recorded from repository-side work in commit
  `d737369`, "Make workbook staging root portable", which changed only
  documentation, scripts, tests, and re-exported CSVs. The workbook is private
  and outside Git, so no repository change could implement or verify it, and no
  test asserts it. The documentation and the workbook drifted apart unnoticed
  for a month, and the gap surfaced on 10 August when a data update run from a
  relocated repository failed against a staging parent still pointing at an old
  OneDrive path.
- **Consequences:** Moving or re-cloning the repository breaks exporting until
  the VBA constant is edited by hand. `scripts/run-workbook-staged-export.ps1`
  now prints the workbook path and the staged root it passes, and includes both
  in the failure message, so a mismatch names both sides instead of only the
  expected parent. Making the parent genuinely configurable remains open
  workbook work. More generally, this repository must not record workbook-side
  behaviour as an accepted decision when nothing here can verify it; such claims
  belong in the roadmap as proposals until confirmed against the workbook.

## Athlete profile status gates every public export upstream

- **Status:** Accepted and implemented in the private workbook; public data not
  yet released
- **Date:** 21 August 2026
- **Decision:** `Participants[ProfileStatus]` uses the closed values `Active`
  and `Inactive`. Only athletes resolving exactly to `Active` may enter any
  website-source selection, ranking, record, medal, Hall of Fame, crown,
  standard, target, comparison, or profile-result export. Blank, unknown, or
  unresolved statuses fail the complete export. `ProfileStatus` itself remains
  private and is not added to CSVs or browser code.
- **Rationale:** Filtering after a leaderboard or award is calculated leaves
  rank gaps and stale medals, holders, records, or targets. Filtering only in
  JavaScript also publishes the data it is meant to suppress. Eligibility must
  therefore be applied in the Excel/VBA source of truth before every dependent
  calculation.
- **Consequences:** The workbook validates the status vocabulary and the
  eligibility wiring before export, then scans the staged CSV tree for every
  inactive athlete name and ID before the manifest is finalized. Deactivation
  removes the athlete retroactively from the current complete bundle and may
  legitimately promote or re-rank other athletes. Historical Git commits are
  not rewritten. A data promotion and publication remain separate explicit
  approvals.

## The age-grade calculator is a fail-closed JavaScript slave of Excel

- **Status:** Accepted and implemented in the private workbook and website;
  public data promotion pending
- **Date:** 23 August 2026
- **Decision:** Excel remains the master for age, sex, event standards, age
  factors, and the age-grade formula. The dedicated calculator may perform only
  the final division of a workbook-exported full-precision age-graded standard
  by a visitor-entered duration. The export carries an exact formula signature,
  contract version, and workbook-generated conformance value. The browser and
  repository validators refuse to calculate if any of them differ from the
  supported JavaScript contract.
- **Rationale:** A static site cannot send arbitrary user-entered times back to
  the private workbook. Exporting the already age-adjusted standard preserves
  workbook ownership of all personal and standards lookups while allowing an
  instant local calculation. Formula signatures and conformance vectors turn a
  potentially silent duplicate implementation into an explicit master/slave
  release contract.
- **Consequences:** `age-grade-contract.js` is the sole narrow exception to the
  general ban on JavaScript age-grade calculation. It must not derive age,
  sex, open standards, or age factors, and it cannot calculate rankings,
  categories, targets, or awards. Any workbook logic or display-precision
  change requires a same-release JavaScript and test update; otherwise export
  or page initialization fails closed. Calculator CSVs are site-specific and
  join the normal full-bundle staging, reconciliation, and promotion workflow.
