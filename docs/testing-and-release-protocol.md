# Testing And Release Protocol

This project is a static GitHub Pages site. Excel/VBA remains the private source of truth for calculations and exports CSV files for the website. JavaScript must only render exported data; it must not calculate age grades, rankings, crowns, medal positions, target times, records, or championship status.

## Local Setup

Install Node.js and pnpm if they are not already available.

Install the Node development dependency once:

```bash
pnpm install
```

If Playwright cannot find a browser on your machine, install Chromium for Playwright:

```bash
pnpm exec playwright install chromium
```

## Local Commands

Run all automated checks:

```bash
pnpm test
```

Run repository safety validation only:

```bash
pnpm run validate:safety
```

Run CSV validation only:

```bash
pnpm run validate:csv
```

Validate the two owner-curated gallery manifests:

```bash
pnpm run validate:gallery
```

Run the provider-independent owner-upload state, tagging, consent, and
exclusion contract tests:

```bash
pnpm run test:gallery-upload-contract
```

Run the Gallery input-file and metadata-inspection policy tests against
synthetic hostile fixtures:

```bash
pnpm run test:gallery-media-policy
```

Run the server-only storage-key grammar and forward-migration tests:

```bash
pnpm run test:gallery-storage-keys
```

Run the unpublished Gallery administration, D1 migration, authentication, and
derivative-delivery boundary tests:

```bash
pnpm run test:gallery-admin-boundaries
```

Check that the owner selector snapshot still exactly matches the current public
export, then run the synthetic private-upload and responsive owner-page suites:

```bash
pnpm run validate:gallery-admin-catalog
pnpm run test:gallery-admin-catalog
pnpm run test:gallery-admin-phase-c
pnpm run test:gallery-admin-browser
```

Run the photo-only processor, private-staging bridge, local review bridge, rehearsal
boundary, deployment-configuration, and remote-driver contract suites:

```bash
pnpm run test:gallery-media-processor
pnpm run test:gallery-processing-bridge
pnpm run test:gallery-photo-review-bridge
pnpm run test:gallery-processing-rehearsal-worker
pnpm run test:gallery-phase-d-migration-configs
pnpm run test:gallery-phase-d-processing-configs
pnpm run test:gallery-phase-d-remote-rehearsal
pnpm run test:gallery-public-host-remote-rehearsal
pnpm run test:gallery-public-host-remote-sqlite-integration
```

These commands use generated synthetic bytes, in-memory substitutes, and fake
command/service adapters. They do not mutate Cloudflare. Running the actual
remote rehearsal requires separate explicit approval and an Access credential
passed only in memory, never through an argument, environment variable, file,
report, or log.

The administration integration suite drives the actual router through
signed-session and CSRF controls, applies migrations `0001`–`0003` plus the
local photo-intake migration `0010`, and
uses a deterministic in-memory multipart store with synthetic bytes only. It
covers draft and consent revisions, exact inherited Family/Everyone context, separate
area-bound sessions, server-injected single-area drafts, cross-area denial,
current public tags, pending exclusions, stale catalogs, real-photo extension,
MIME and complete pre-upload checksum binding, interrupted and
concurrent parts, whole-object checksums, signature and size failures,
idempotent retries, protected preview ranges, moderation, 24-hour cleanup,
response redaction, empty public manifests, and artifact exclusion. The
responsive owner-page suite covers both exact entry URLs, responsive
screenshots, a generated PNG through the real file-picker path, omission of the
original filename, and proves there is no destination control or protected
request when the context is missing or malformed. The review-bridge suite proves
the workflow accepts only an opaque draft ID, re-reads candidate evidence before
and after review creation, prepares one in-memory inherited-area manifest
addition, does not edit either tracked manifest, and exposes no push, merge,
deployment, or `GITHUB_TOKEN` path. The separate contract suite carries the exact
checked-in suppression case while that public list is empty.

This suite uses synthetic identities, text, and bytes only. It exercises the
production `ctx.access` path, exact single-owner configuration, browser/service
separation, both the full service identity and Worker-level Access's
`getIdentity() === undefined` plus validated application-assertion path, strict
Client ID/issuer/claim checks, string and array audience matching, malformed and
browser-claim rejection, signed 30-minute sessions, Origin, `Sec-Fetch-Site`, CSRF, cookie
and expiry checks, and the one fixed, server-generated
`synthetic:phase-b-auth-boundary-v1` D1 canary write with no accepted request
body. It also applies all reviewed migrations to an in-memory SQLite database
and verifies initial-state/replacement guards, active-consent and derivative
revision binding, pending whole-item exclusion gates, unique private object
ownership, withdrawal and retention evidence, cascaded private deletion, and
surviving append-only opaque audit/tombstone records. Delivery coverage proves
exact immutable `GET`/`HEAD` paths, conditional ranges tied to one R2 ETag and
size, security headers, hostile R2 metadata rejection, and the absence of
originals, staging, D1, listing, or write capability. Static checks keep the
tracked Wrangler examples inert and disable preview URLs. The Phase C
administration Worker has only D1 plus private originals and one hourly cleanup
schedule; the public media Worker has only approved derivatives; and the
separate processing Worker has exactly D1, private originals, and private
derivative staging.

Check that the committed `vendor/` browser libraries still match the pinned
dependencies:

```bash
pnpm run validate:vendor
```

Refresh `vendor/` after deliberately changing a pinned library version in
`package.json`:

```bash
pnpm run vendor:sync
```

Run the guided routine data updater after saving and closing Excel:

```powershell
pnpm run data:update
```

Check only that the default private workbook matches the repository export
contract:

```powershell
pnpm run workbook:check:contract
```

This preflight opens the workbook read-only, creates no data branch or staged
run, and prints its exact capability signature. The guided updater performs the
same check before branch creation and the full export repeats it.

After a reviewed promotion, the updater also regenerates the private
`gallery-admin/generated/catalog-snapshot.js` from the promoted public CSV
bundle. This is deterministic derived data and is not published by GitHub
Pages. It does not become a source for rankings or other championship values.

Resume an update stopped at a review checkpoint:

```powershell
pnpm run data:update -- --resume
```

This wrapper prepares the complete staged export, preserves the explicit
`PROMOTE` checkpoint, and runs this full test suite. `PUBLISH` then commits and
pushes the validated bundle, opens an eligible `[skip netlify]` Pull Request,
and waits for GitHub checks and screenshot generation.

It stops there. `PUBLISH` is given before the Pull Request exists, so it cannot
be approval of a diff and screenshots that have not been produced yet. The run
prints the Pull Request, the `gh pr diff` command for the exact CSV diff, and
the check run holding the responsive-screenshot artifact, then requires a
separate `MERGE` confirmation. A declined merge leaves the Pull Request open and
the update resumable with `--resume`.

After `MERGE` the updater re-reads GitHub rather than trusting what was true
before the pause: it re-verifies the Pull Request identity, that the head commit
is still the exact validated commit, and that the required check still succeeds,
then merges through the protected Pull Request pathway. It does not treat the
merge itself as proof that the website changed. It waits for the Pages workflow
run for the exact merge commit, compares the complete 72-file production CSV
bundle byte-for-byte with the reviewed data commit, and uses a real browser to
check that both `?site=family` and `?site=everyone` render their correct title,
mode, and standings. Only then does it delete the merged branch and perform
update-scoped cleanup. A failure retains the merged state and recovery files;
`--resume` retries verification without attempting another merge.

Run focused export-bundle failure regression tests:

```bash
pnpm run test:export-bundle
```

Run staged-export workflow regression tests:

```bash
pnpm run test:staged-export
```

Run preview artifact safety regression tests:

```bash
pnpm run test:artifact-safety
```

Run browser smoke tests and capture screenshots:

```bash
pnpm run test:browser
```

Build the static preview artifact used by local checks and standard Netlify
previews:

```bash
pnpm run preview:build
```

Start the local static preview:

```bash
pnpm run preview
```

Refresh responsive screenshots:

```bash
pnpm run screenshots:update
```

Generate, validate, and reconcile a private-workbook export without changing
tracked data:

```powershell
pnpm run workbook:export:staged
pnpm run workbook:validate:staged --staged "<STAGED_EXPORT_ROOT>"
pnpm run workbook:compare:staged --staged "<STAGED_EXPORT_ROOT>"
```

See [Workbook website export workflow](workbook-export-workflow.md). Promotion
is a separate explicitly approved command and is never part of automated
export or validation.

Local preview URLs:

- Family: `http://127.0.0.1:4173/?site=family`
- Everyone: `http://127.0.0.1:4173/?site=everyone`

## What The Automated Checks Cover

Repository safety validation checks tracked files and fails if a private workbook, Excel add-in, exported VBA source file (`.bas`, `.cls`, `.frm`, `.frx`), Excel temporary file, obvious credential file, or private workbook backup-like file is tracked.

Vendored library validation compares every file in `vendor/` against the build resolved by the pnpm lockfile, so the committed browser libraries can never drift from a reviewed, pinned dependency version. The public site loads Chart.js and its date adapter from `vendor/`, never from a third-party CDN, which also means the browser smoke tests exercise the athlete progression chart instead of its unavailable-library fallback.

CSV validation checks `data/family/`, `data/everyone/`, and shared `data/athlete_results.csv`. Excel/VBA generates one `ExportBundleID` per full export and appends it to every public data CSV. VBA writes `data/export_manifest.csv` last, making it the export-completion and consistency contract. Its exact schema is `ExportBundleID,ExportedAtUTC,SchemaVersion,Scope,RelativePath,DataRowCount`, with schema version `1.0`, scopes limited to `family`, `everyone`, and `shared`, repository-relative paths, and row counts excluding headers. Validation rejects missing manifests, invalid schemas or paths, missing or mixed IDs, bundle mismatches, missing or unlisted files, duplicate manifest paths, inconsistent manifest metadata, and wrong row counts, so partial, stale, or mixed exports cannot pass release checks.

The guided-updater regression suite also recomputes the tracked workbook schema
fingerprint from all sorted `data/` paths and exact headers, checks the 72-file,
71-manifest-entry, and 64-column News metadata, requires one exact preflight
marker, and verifies that an explicit workbook override reaches both preflight
and export. Source-order guards keep the read-only preflight before refresh-branch
creation and keep the full export before any workbook save. Failure cleanup is
guarded by saved-state absence, exact branch identity, a clean worktree, and an
unchanged recorded `origin/main` commit before restoring the original Git
position and deleting only the exact temporary ref. Staged-workflow coverage
retains late rejection of the characteristic pre-News bundle missing both News
files, so the capability marker never replaces authoritative bundle validation.

The existing content checks remain in force: required files and headers, parseable CSV structure, matching row lengths, leaderboard files referenced by `webtables.csv`, athlete IDs used by links, official medal exports, parseable dates, numeric fields and times, non-empty Hall of Fame data, and non-empty enabled championship files. Validation also enforces the exact `crown_history.csv` contract, crown order and chronology, transition and previous-holder rules, and final-holder agreement with the All-Time Official Hall of Fame without deriving history in JavaScript. Athlete medals remain Excel-owned exports and are rendered directly from `official_medals.csv`; their rows must match the current exported official leaderboards. When present, `absolute_records.csv` must be a workbook-owned official raw-time export with Men and Women records, source-row audit fields, and no browser-derived record calculation. It is validated as a complete fixed matrix: exactly one row for each of Men and Women at Marathon, Half Marathon, 10 Mile, 10 km, and 5 km, in that order, with no missing, duplicated, extra, or reordered rows. `RecordGroup` must be `Men` or `Women` and must agree with the row's own `Sex`, `RecordTitle` must be unique, `ResultDistance` must be the same distance as `Distance`, and `SortOrder` must be numeric, unique, and strictly increasing so the exported order is reproducible rather than incidental. Vacant states such as "Championship Vacant" and "No eligible results" are accepted; a vacant record still occupies its place in the matrix but carries no performance to check.

### Official Results News first-draft acceptance record

This is the acceptance record for the approved first draft in
[Official Result News Contract](official-news-contract.md). The workbook draft
produced a 72-file export with authoritative row counts of 43 for Family and 64
for Everyone. Staged validation passed, reconciliation against tracked data
found only the two new News CSVs plus the manifest, and John approved promotion
on 23 August 2026. The complete post-promotion suite, browser checks, artifact
checks, and responsive review pass. Promotion and local validation do not
publish the feature; release remains a separate explicit approval.

The tracked News export includes
`data/family/official_result_news.csv` and
`data/everyone/official_result_news.csv`. Both files are required even when one
is header-only, have their own site scopes, and join the atomic bundle in the
same release. The tracked public bundle contains 72 CSV files: 71 manifest
entries plus
`data/export_manifest.csv`.

### News medal-entry extension status (historical baseline)

The approved medal-position refinement changes only the two News CSV headers,
their workbook population, repository validation, and News presentation; it
does not add another public file or change which results qualify as milestones.
The exact News header grows from 32 to 36 columns by placing
`CurrentDistanceMedalEntry`, `CurrentOverallMedalEntry`,
`AllTimeDistanceMedalEntry`, and `AllTimeOverallMedalEntry` immediately after
their aligned rank triplets. Each field is blank or `Gold`, `Silver`, or
`Bronze` and is populated only for an unranked/Rank 4+ to Rank 1/2/3 crossing
in that workbook-owned context. Contexts and site modes remain independent;
within-medal movement is blank, tied athletes use their exported competition
rank, and 1 Mile distance entries are blank.

The 36-column repository validator and synthetic export-bundle regressions are
implemented. Syntax checks and the focused `pnpm run test:export-bundle` pass.
The backed-up News draft produced staged 72-file export
`test-artifacts/workbook-export-staging/run-20260823-195159-167-medal`, which
passed the updated validator. Reconciliation found only the two News CSVs
meaningfully changed and every prior News fact, rank, and delta identical. The
bundle was promoted atomically; the prior tracked data is recoverable at
`test-artifacts/workbook-export-promotion/20260823235713853`. Tracked-data
validation passes. The promoted export contains 24 Family cards carrying at
least one medal entry across 59 contexts, and 34 such Everyone cards across 77
contexts. The complete News feeds remain 43 Family and 64 Everyone milestones.
The complete `pnpm test` suite passes, including the combined 114-file
News-and-Gallery preview-artifact build. Browser smoke coverage passes in both
modes at 1440px, the 720px
intermediate probe, and 390px mobile. Responsive screenshots were refreshed and
manually reviewed; the medal callout and per-context badges remain readable and
contained, with no horizontal overflow. The integration of current `main` also
preserves Gallery validation, populated/fallback presentation, and both-mode
responsive screenshots. Merge commit `65190fe` is pushed to Pull Request #68;
the required static-site check and combined Deploy Preview passed, and GitHub
reports the PR clean and mergeable. This verification does not merge or release
the change.

### News medal-position snapshot extension status (historical baseline)

Real-data review on 24 August 2026 showed that the entry-only fields correctly
left an existing-medal upgrade unmarked: for example, an All-Time Rank 2 to
Rank 1 movement has no new entry but must visibly say `Silver` to `Gold`. The
exact News schema therefore grows from 36 to 44 columns. Immediately after each
existing `MedalEntry`, the workbook must export the matching `MedalBefore` and
`MedalAfter` fields for Current Distance, Current Overall, All Time Distance,
and All Time Overall. `MedalEntry` remains threshold-only: it is populated only
for an unranked/Rank 4+ to Rank 1/2/3 crossing and remains blank for upgrades
or retained medal positions.

Every snapshot field is blank, `Gold`, `Silver`, or `Bronze`, and must match
the corresponding workbook-owned before or after competition rank exactly. The
fields are mode- and context-specific. A 1 Mile Distance context leaves all
three aligned medal fields blank; a table-unavailable context does the same.
The prior 36-column export evidence above is historical baseline evidence only:
the 44-column change requires a fresh full staged export, reconciliation,
promotion, focused validation, complete suite, and both-mode responsive review.

Focused CSV validation must require the exact ordered 44-column News header and
enforce the complete contract: one selected-site file, literal `Official`, the
six canonical distances, contiguous newest-first `SortOrder`, unique positive
`SourceRow`, descending dates and reverse source order within a date,
source-result identity, full-precision/display age-grade agreement, the four
closed milestone types, exact previous-best and delta population rules,
strictly improving age-grade and raw-time chains, `HH:MM:SS[.fff]` raw times
and improvements that retain genuine source precision through milliseconds,
and every valid/invalid rank triplet blank pattern. `TimeImprovementSeconds`
may therefore be a positive decimal value to at most three places. Validation
must match the documented rounding relationship when public
`athlete_results.csv` exposes a coarser time; it must not reject or round away a
valid precise News value. It must cover first results, combined milestones, a
sub-second raw-time improvement, a positive exact age-grade improvement whose
one-decimal displays are equal, unranked-to-ranked movement, zero rank
movement, unavailable 1 Mile distance tables, quoted and multiline event text,
and a valid header-only file. Failure fixtures must reject unofficial or
unsupported results, duplicates, missing bundle registration, malformed
chronology, invented first-result baselines, zero or negative improvements,
wrong delta arithmetic, partial rank triplets, and a mode or source mismatch.
Age-grade subtraction and two-decimal display rounding must be checked with
exact fixed-decimal arithmetic, including half-up boundary cases. Cross-mode
validation must require every Family milestone to match the same public source
result and non-rank/non-medal-position values in Everyone while allowing
mode-specific order, rank triplets, and all medal fields. Every `MedalEntry`,
`MedalBefore`, and `MedalAfter` field must be checked against its own aligned
rank snapshot: reject missing, wrong, extraneous, or unsupported values; accept
Gold/Silver/Bronze, multiple contexts on one row, and direct competition-rank
tie semantics; require a within-medal upgrade such as `Silver` to `Gold` to
retain its blank entry field while supplying both snapshots; and keep
unavailable 1 Mile Distance contexts blank.

The repository may validate exported arithmetic and public-source agreement,
but it must not generate milestones or ranks. Before the manifest is written,
workbook post-export validation must replay date/`SourceRow` order, preserve
source time through millisecond precision, apply the
strict historical Current rule (`result date > D - 365 days` and
`result date <= D`), populate all three aligned medal fields from the same
workbook-owned historical rank context, and compare its complete terminal
Current and All-Time state with all 12 Official leaderboard files in each mode.
This workbook check is required because rounded public rows cannot independently
prove exact milestone completeness or historical ranking.

Browser smoke coverage must open the eventual News page in Family and Everyone
at 1440 x 900 and 390 x 844. It must prove selected-mode-only requests,
mode-preserving navigation and athlete links, exact exported order including
same-day rows, all four milestone types, first/tiny/combined improvements,
fractional raw-time values and improvements, unranked, unchanged, gained-place,
unavailable-table, header-only, and failed-load states. It must also prove
that only exported `MedalEntry` fields trigger the explicit card callout, that
exported `MedalBefore`/`MedalAfter` labels render an existing-medal upgrade such
as `Silver` to `Gold`, that multiple contexts render, that a within-medal move
is not called a new entry, and that rank numbers alone do not cause the browser
to infer a medal or snapshot. The treatment must use visible text as well as
colour and decorative icons. It must also prove there is no fallback
calculation from
`athlete_results.csv`, no leaked `SourceRow`, exact age grade, `SortOrder`, or
bundle metadata, no script or same-origin request failure, and no horizontal
page overflow. Responsive screenshots for both modes must include a combined
milestone and an entry with all four rank movements visible.

The approved News navigation refinement is presentation-only. Browser coverage
must also prove that Athlete, Year, and canonical Distance controls are built
from the loaded selected-mode rows; all three filters combine; a filter change
resets the view to the 12 newest matching entries; and `Reset filters` clears
all controls and restores the first 12 newest entries. The initial view must
contain the 12 newest matches, `Show older` must reveal the next 12 without
reordering them, and the control must disappear or become unavailable after all
matches are visible. The `Showing X of Y milestones` summary, no-matches state,
keyboard-operable labelled controls, hidden controls in header-only/error
states, and desktop/mobile layout must be covered. Filtering and progressive
reveal must not request another CSV, leak the other mode's rows, or calculate
any milestone, improvement, position, or rank.

The later compact-card refinement remains presentation-only. Browser coverage
must prove that a populated desktop card reads left to right as Result, the
exported PB improvement or first-result baseline, then Championship movement;
that mobile preserves the same information and order in a compact vertical
flow; and that visual arrow connectors are hidden from assistive technology.
Both layouts must retain the existing milestone, improvement, movement,
filtering, progressive-reveal, and no-overflow assertions. No workbook, schema,
calculation, or content fixture changes are required for this refinement.

The compact-card acceptance run passed on 23 August 2026. The full `pnpm test`
suite passed, including browser smoke coverage for both modes at 1440 x 900,
the 720px intermediate probe, and 390 x 844 mobile. Responsive screenshots were
reviewed with no horizontal overflow. All tested real-data cards remained
within the 320px desktop and 850px mobile height ceilings; the visible history
was about 55% shorter on desktop and 37% shorter on mobile than the preceding
layout. This local acceptance does not merge or release the change. The Pull
Request preview was subsequently refreshed and verified for the medal-position
extension at commit `2b28907`.

Analytics configuration tests prove that GoatCounter loads only for the
production `www.aceofrace.com` and `aceofrace.com` domains, plus the legacy
`johnkevan88888.github.io/family-running` address. Local runs, Netlify previews,
unrelated subdomains, and unrelated GitHub Pages paths must not load it. The
tests also verify that Family and Everyone paths stay distinct, unrelated query
parameters are discarded, and only public athlete IDs are retained on profile
paths. They also lock the integration to GoatCounter's current recommended
loader without the stale subresource-integrity pin that previously caused
browsers to block the script before it could submit a visit.

Focused regression tests copy `data/` to temporary directories and prove validation rejects a changed CSV bundle ID, a CSV omitted from the manifest, and an incorrect manifest row count. They also prove it rejects a missing, extra, duplicated, misordered, or unsupported absolute record, an invalid `RecordGroup`, a `RecordGroup` that disagrees with its `Sex`, a duplicate or non-increasing `SortOrder`, a duplicate `RecordTitle`, and a `ResultDistance` for another distance, while a legitimately vacant record still validates. Production CSVs are not mutated by these tests.

Staged-export regression tests also prove that a complete copied bundle
validates, volatile bundle metadata is ignored during reconciliation,
meaningful content changes are reported, and an incomplete staged file set is
rejected. They also enforce the fail-closed staging-root rules: only an
absolute, canonical, immediate child of the repository's ignored
`test-artifacts/workbook-export-staging/` parent is accepted; repository root,
tracked `data/`, descendants of `data/`, relative paths, nested staging paths,
and ambiguous paths are rejected.

The preview artifact build copies the static runtime pages, JavaScript, styles,
vendored libraries, `CNAME`, and public `data/` bundle into
`test-artifacts/preview-site`, then fails if a required runtime file is absent
from the publish directory. It also fails if documentation, scripts, tests,
workflow files, or repository configuration appear in the artifact, because that
artifact is the public web root for both Netlify previews and production.

The build deletes its output directory recursively before rebuilding it, so
`PREVIEW_OUTPUT_DIR` is resolved through a fail-closed gate before anything is
removed. Only a canonical absolute path strictly inside the ignored
`test-artifacts/` directory is accepted; the repository root, tracked `data/`
and its descendants, parent and sibling directories, `test-artifacts/` itself,
relative paths, traversal segments, and surrounding whitespace are all rejected.

`data/`, `vendor/`, `assets/`, and `gallery-data/` are copied as whole
directories, so the file whitelist says nothing about their contents. Each is checked against its own
contract instead. Published `data/` must be exactly `data/export_manifest.csv`
plus every path that manifest lists, so a scratch file, an editor backup, an
unlisted export, or a missing contracted CSV fails the build rather than
reaching the public web. Published `vendor/` must be exactly the
vendored-library set defined in `scripts/vendored-library-files.mjs`, the same
list `pnpm run validate:vendor` checks against the pnpm lockfile, so no file can
be published from `vendor/` without also being pinned to a reviewed dependency.
Published `assets/` must be brand imagery only: everything under
`assets/brand/`, and only vector or raster image formats, so a stylesheet,
script, or document cannot be served from the public web root by being dropped
into the assets folder. Published `gallery-data/` must contain exactly
`family.json`, `everyone.json`, and `hidden-athlete-ids.json`. Photographs and
videos are externally hosted, so adding any media file, private original, or
scratch document to that directory fails the build.

Preview artifact safety regression tests cover both gates. They assert every
rejected output-directory shape, prove the build refuses an out-of-tree
directory without deleting it by aiming a refused build at a throwaway
directory containing a canary file, and prove all four publication contracts on
the real tree by adding one stray file to `data/`, one to `vendor/`, one to
`assets/brand/`, and one to `gallery-data/`, then removing them again.

The same artifact is deployed to GitHub Pages by
`.github/workflows/deploy-pages.yml` on every push to `main`. Pages no longer
serves the repository root, so files such as `AGENTS.md`, `docs/`, `scripts/`,
and `package.json` are not readable from the production domain. Anything a
visitor's browser genuinely needs must be listed in `runtimeEntries`, and the
suite can prove the published set is complete by serving the artifact directly:

```bash
pnpm run build:site
SITE_ROOT=test-artifacts/preview-site pnpm run test:browser
```

A no-visual-change `[skip netlify]` pathway covers changes that cannot alter
what the static preview would show. It is allowed when no changed file is
published to the site and no changed file decides what is published or how it
is deployed. "Published" is read from
`scripts/published-site-entries.mjs`, the same list the artifact build copies,
so adding a page makes it preview-relevant in the same edit rather than
requiring a second list to be kept in step. Documentation, tests, local
release tooling, and private `gallery-admin/` implementation can qualify;
pages, styles, runtime scripts, vendored libraries, public data/media metadata,
and publishing controls cannot. Publishing controls include root package,
lock, workspace, checkout and Netlify configuration, artifact-build contracts,
the release-path guard itself, and GitHub workflows. Omitting the marker always
requires a full preview, whatever the change.

The classifier positively recognizes known non-public areas and an explicit set
of reviewed local tools. It does not infer that an unfamiliar file is harmless
merely because that file is absent from the current artifact list. Unknown root
configuration, future scripts, and future GitHub build actions therefore fail
closed until deliberately classified.

Skipping Netlify does not mean skipping review. The exact diff, full automated
suite, and responsive screenshots remain required. A private service or admin
surface also needs its own authenticated/environment-specific evidence because
the public static Netlify preview cannot exercise it.

Pull Request release-path tests recognize Netlify's `[skip netlify]` title
marker for an eligible no-visual change, narrow lightweight data refresh, or
custom-domain configuration. The no-visual route requires at least one changed
file, rejects every published or publishing-control path, and rejects unknown
paths it cannot prove are in a known non-public area. The data route requires at
least one changed existing CSV under `data/`, requires the complete tracked public
CSV bundle and its exact deterministic
`gallery-admin/generated/catalog-snapshot.js` to be refreshed, permits only
optional `docs/active-work.md` notes alongside them, rejects added or removed
CSVs or any other Gallery path, and compares every changed CSV header against
`main` to reject schema changes. The complete test suite independently rebuilds
the catalogue and rejects a stale or hand-edited result. The
domain route requires the root `CNAME` to contain exactly the approved
production hostname, `www.aceofrace.com`, compared case-insensitively, and
permits only the explicit CNAME, production-only analytics, Pull Request
template, test, and documentation allowlist. This is a deliberate exception for
production DNS/HTTPS and production-host-only analytics behavior that a Netlify
hostname cannot verify; the release guard and preview-comment workflow cannot
use it. A syntax check alone previously let any valid hostname take the
preview-skipping route and self-approve it; a genuine domain migration must now
change `CUSTOM_DOMAIN_CANONICAL_HOST` in
`scripts/validate-pr-release-path.mjs`, its tests, this document, and the DNS
plan together, through the standard preview pathway. Any marked diff that does
not satisfy one of the three skip contracts fails the eligibility gate and must
use a standard Deploy Preview.

Browser smoke tests run the site through a local static server for:

- `/?site=family`
- `/?site=everyone`

Gallery coverage opens the Gallery in both site modes at desktop and mobile
sizes, checks that navigation preserves the selected mode, and proves that only
that mode's manifest and the shared suppression list are requested. The tracked
empty manifests render a deliberate first-moment state. Synthetic populated
coverage renders one photo and one video, checks photo/video filters,
literal-text handling for hostile captions, accessible viewer focus
restoration, featured moments on the Championships page, athlete-associated
moments on profiles, and approved athlete-tagged podium photography. Person-tag
suppression is checked across Gallery cards, featured moments, athlete profiles,
and championship podiums without requesting the hidden media. Unsafe media URLs
and malformed suppression lists fail closed. The populated Gallery grid and
photo podium are checked for mobile overflow and saved at desktop and mobile
sizes.

Repository gallery validation also joins each item back to the public exported
results. Its race date, event, and distance must identify a result available in
that site mode, and every tagged athlete must belong to that mode's public
result-bearing roster. This is the same contract the authenticated uploader's
cascading date, race, and people selectors use. The shared suppression document is
also contract-validated for exact schema, URL-safe athlete IDs, uniqueness, and
unsupported fields; suppression IDs do not need a current gallery item so an
owner can record a request before future media is added.

The unpublished Gallery upload contract tests bind a draft to exact current
export and suppression revisions, require exactly one inherited site area,
reject a shared upload draft, keep race participants before the remaining
public roster in the tag picker, apply consent and child-guardian gates even
when no athlete is tagged, and use versioned/idempotent state changes. Fresh
suppression is checked again before processing and publication. Rejected and
withdrawn items cannot emit manifest entries; completion of a published-item
withdrawal requires host-deletion evidence. A pre-public individual withdrawal
uses the same verified-host-absence evidence, where success also covers the
zero-object case.
Athlete-wide exclusion tests remove whole items from
both manifests, keep the public suppression proposal ID-only, deduplicate owned
derivative references, and fail closed on stale revisions, inconsistent shared
items, external URLs, or collateral URL reuse.

Storage-key tests must prove that only the server constructs keys; a draft's
signed single site area cannot be replaced by a request value; private and
staging keys match their exact versioned grammar; and approved keys remain one
of the four content-addressed public derivative forms. Fixtures must reject
original filenames, uploader identity, race metadata, athlete identity,
consent/exclusion detail, traversal, duplicate separators, unsupported roles,
uppercase or malformed hashes, a mismatch between D1 derivative role and its
exact canonical filename, and any private or staging key returned to a browser.
Original-key tests must prove the server keeps only the normalized allowlisted
extension from the upload declaration and later fails closed if MIME or detected
bytes disagree. Migration coverage must preserve the deployed Phase C prefix
while admitting v1 only through a reviewed forward migration.

The unpublished media-policy tests use synthetic photo/video byte buffers and
hostile scanner records. They require extension, declared type, detected magic,
size, pixel, duration, decoder, derivative profile, stream, codec, and fast-start
agreement; bind successful non-truncated scanner output to the exact byte count
and SHA-256; reject every surviving public metadata tag or chapter; and verify
that private metadata and credential sentinels never appear in returned results
or console output. These administration contracts and fixtures are excluded
from the public Pages artifact.

The local Phase D photo-processor test additionally runs the pinned Sharp and
ExifTool binaries against generated synthetic JPEG and opaque PNG files. It proves
orientation handling, no-upscale display and thumbnail dimensions (including
odd aspect ratios), deterministic finalized bytes and hashes, exact file-to-byte
binding before and after metadata inspection, disabled user ExifTool
configuration, metadata rejection, immutable returned payloads, all-or-nothing
failure, redacted errors, and private temporary-file cleanup. The complete test
runner must invoke this test. Processor code, fixtures, temporary files, and
generated derivatives must remain outside the GitHub Pages artifact. This test
also proves that oversized inputs, malformed storage-binding IDs, and transparent
PNG inputs fail before unnecessary native-tool work. It does not authorize real
media or claim video processing coverage.

The local private-processing and photo-promotion bridge test then drives the
real administration router, all nine D1 migrations, deterministic in-memory
private-staging and approved R2 implementations, the real pinned photo
processor, and the two separately bound service-only routers from end to end
with synthetic bytes. The processing portion proves that the site area, race, tags,
consent, revisions, suppression state, original key, run ID, and staging keys
come from current server evidence rather than request choices. It also covers
exact Access identity and origin checks, version-pinned original download,
D1-before-R2 output reservation, persisted one-part multipart admission,
independent R2 readback, retry recovery when part, completion, or following D1
responses are lost, conflicting retries, revocation during the original R2
read, exclusion in the final R2-to-D1 write gap, mid-run revision blocks,
direct terminal-row bypasses, role-specific byte limits, fixed safe failure
codes, canonical result replay, and the exact verified display/thumbnail pair
required to stage a run. Deterministic race hooks must also prove that only one
simultaneous staged-versus-failed or conflicting-failure result can win and
that the losing request cannot append a false receipt or audit event.

Retry coverage must apply migration `0006_transition_receipt_state_version.sql`
and prove its exact unique `(draft_id, expected_state_version)` index, reject a
pre-existing duplicate pair before remote use, and prove that both plain insert
and distinct-idempotency-key `INSERT OR REPLACE` collisions preserve the exact
winning receipt. The migration's no-replace guard must cover both the original
idempotency constraint and the new state-version constraint. Keep the D1
mutation below the provider's expression-depth limit. The service may pre-read the complete
evidence graph, but the transactional mutation must remain a shallow draft
compare-and-swap plus one immutable failed-run, completed-cleanup, and tombstone
join. Existing D1 triggers must recheck concurrent consent, exclusion, upload,
state, and revision changes. A competing same-version transition must roll its
draft, receipt, and audit batch back; an exact committed retry must replay
without changing evidence.

Cleanup coverage must prove that a D1 closure committed before multipart-handle
admission prevents any media part from being sent, while a handle committed
first is included in the immutable cleanup snapshot. The in-memory R2 substitute
must model abort-wins, complete-wins, exact `NoSuchUpload`, and the observed case
where `abort()` resolves even though completion has already made the exact
object visible. It must also model a lost abort response, lost completion
response, lost delete response, and D1 failure after provider success. Direct
`put()` must fail the test so it cannot silently return to the processing path.
Cleanup must reject a mismatched expected object, an unknown object under the
canonical run prefix, any caller-supplied target, and any new output, result, or
derivative after closure. It must verify exact bytes and metadata before
deletion, final `head()` absence, and a fully paginated empty prefix before
removing D1 operational evidence. If an older Worker already stored terminal
kind `aborted`, recovery must preserve that immutable fact. When the exact
object is present, it must record observed provider hashes, deletion time, and
absence time. If a replay instead finds the object already absent after a lost
delete response, those earlier observed and deletion fields may remain null,
but final absence, the cleaned cleanup record, and its tombstone are mandatory.
No-output, partial-output, failed, fully staged, withdrawal, and pending tagged-
athlete exclusion cases must converge under exact retries; resolving an
exclusion must not reopen an old run. Every processing run must have completed
cleanup evidence before draft purge.

Withdrawal coverage must separately prove the exact private-original upload row
is `deleted`, with retained version/ETag/SHA and a deletion timestamp, before a
cleaned run can reach `withdrawn`. Staging cleanup alone must never invent
private-original deletion, public-host deletion, consent withdrawal, or
publication evidence. The test byte-compares both public manifests and the
suppression file before and after the flow and proves the processing Worker has
no approved-media binding.

The isolated photo-promotion portion uses D1, private-staging read access, and
approved-media write access only. It accepts no area, race, athlete, role,
object key, URL, or manifest target from the caller. It must prove that an exact
verified display/thumbnail pair is copied only after a unique hashed D1
admission wins; the provider create is never called directly from `reserved`;
and the exact one-part multipart ID is handed to the open promotion or a
concurrently closing cleanup before a media part is sent. Staging and approved
bytes, hashes, versions, ETags, WebP dimensions, content type, and custom
metadata are independently re-read; current consent, guardian approval,
revisions, suppression, and pending athlete exclusions are rechecked; an
initially forged verified row and direct evidence deletion fail; and lost part,
completion, or D1 responses have one exact idempotent recovery. Candidate
replay must re-read both approved R2 objects and then re-read current D1
eligibility, so removing or changing either object fails closed even when D1
still says it is verified. The final synthetic transition may reach
`candidate-public`, but `pr-open`, `published`, publication, and draft purge
remain blocked.

Approved-storage cleanup coverage must prove whole-item display-and-thumbnail
closure for cancellation, pending athlete exclusion, and withdrawal, with
consent withdrawal taking irreversible priority over any weaker reason. It must
cover cleanup before provider admission, exact-ID handoff while create and
cleanup race, abort-wins, complete-wins, lost create/part/complete/abort/delete
and D1 responses, an unresolved `admitting` row, and the lifecycle fallback's
strictly non-evidentiary role. Even after simulated lifecycle removal, unresolved
admission must not permit terminal cleanup, a tombstone, or purge. R2 evidence
must include conditioned exact-object verification, final `head()` absence, a
fully paginated empty server-built prefix, hostile foreign keys, malformed or
repeating cursors, and a strict completion timestamp later than all absence
timestamps. Database tests must reject direct state jumps and plain or
`OR REPLACE` deletion/identity collisions. Terminal replay must work after
operational promotion rows and the draft are purged, while retaining only hashes
and outcome evidence—never raw object keys. The cleanup must not set public-host
or private-original deletion evidence, and tracked public manifests must remain
byte-identical.

Migration `0009_public_host_verification.sql` needs its own structural and
behavioral suite. It must prove that every promotion creates one immutable
generation with exactly the display and thumbnail targets; all generations and
targets survive approved-storage cleanup; activation records and delivery
epochs are append-only; and each epoch binds the exact fixed HTTPS origin,
delivery contract, media Worker version, configuration hash, and synthetic
witness. It must reject replacement, target-count or role drift, non-sequential
activation, retirement reuse across generations or drafts, deletion of durable
proof, and a generation created without the current epoch. A new generation,
withdrawal cycle, or epoch activation must invalidate the prior current-receipt
view and compatibility scalar. Reservation tests must distinguish stable
ownership from attempt provenance: the key, promotion, and draft hashes are the
permanent lineage; the first verification, cycle, idempotency, actor, and time
remain immutable history. A stronger current intent and rotated authorized
identity may start a new immutable attempt against that same lineage, but one
actor cannot fork the same cycle and one idempotency key cannot be replayed into
a changed cycle.

The media-delivery contract test must run the real media Worker with only
`APPROVED_MEDIA` and Cloudflare version metadata. It must require the exact
contract and canonical Worker-version headers, byte-hash the fixed 28-byte WebP
witness at its content-addressed key, require `no-store` for witness and every
failure, preserve the short revalidation policy for ordinary immutable media,
and fail closed for an extra/missing binding, malformed version, wrong witness,
key/type mismatch, replacement, range drift, redirect-like input, or storage
error.

The separate public-host-verifier test must run the real fixed router with D1
and fixed scalar configuration only. Before network checks it must prove that
all historical approved-key hashes are permanently retired. Its injected public
front door must observe `redirect: manual`, `cache: no-store`,
`credentials: omit`, `Cache-Control: no-cache, no-store`, and
`Pragma: no-cache`. An exact witness `HEAD` and full-body-hashed `GET` must run
first. Every historical target `HEAD`/`GET` then needs the exact response URL,
no redirect or `Location`, `no-store`, current contract/version, and an empty
`404`. The witness must be proved again before a final `HEAD` of every target.
Live media must be a
conflict; a generic or cached `404`, credential-dependent route, wrong binding,
wrong witness, version drift, body, timeout, redirect, or unexpected status must
be unverifiable and cannot produce a receipt. The router test must also stall an
inbound request stream and prove one total five-second default body deadline,
with a test override capped at 30 seconds, covers all reads and bounded
cancellation before D1 or public fetch.

Purpose tests must prove D1 derives `withdrawal` only from the current editorial,
athlete-exclusion, or consent-withdrawal intent, and derives `retention-expiry`
only for a rejected or processing-failed draft with no withdrawal intent and a
matching approved retention tombstone. The caller cannot choose the purpose.
Before one transactional commit, the verifier must re-read that purpose and
evidence, the current epoch, state version, withdrawal cycle, complete immutable
generation/target set, and approved-storage cleanup. A true zero-history case
must use canonical empty counts/hashes and the same two witness passes without
inventing a target or retirement row. A historical retention or withdrawal case
must instead prove every retained target; a witness-only shortcut must fail.

The real SQLite bridge—not only the in-memory D1 substitute—must force the last
withdrawal scalar statement to fail and prove that target proofs, witness proof,
and final receipt all roll back together while the resumable verification and
permanent reservations remain. Its exact retry must then commit once. A
withdrawal-purpose receipt may set the legacy `host_deletion_confirmed` scalar
only in that final transaction. A retention-expiry success must return API
`hostDeletionConfirmed: true` to report verified public-host absence while the
legacy withdrawal scalar remains `0`; its current receipt must be bound to the
retention tombstone evidence. Withdrawal and consent-withdrawal tests consume
the former receipt. Rejected/processing-failed retention purge consumes the
latter and must still require private-original deletion and the approved
retention tombstone. Parent-draft purge must retain the permanent hash-only
receipt and any permanent retired-key commitments.

These injected local verifier tests establish the fault contract, not remote
fault evidence. The approved live run has now proved Access, the fixed
witness/front door, canonical zero-generation editorial-removal withdrawal, and
guarded purge of that withdrawn fixture after an approved retention-expiry
tombstone. Its stale request failed without mutation, exact replay was
idempotent, purge remained blocked until the tombstone and private-original
proof existed, and final operational fixture state returned to zero while one
permanent hash-only receipt and one permanent tombstone survived. That receipt
remains withdrawal-purpose. A genuine
retention-expiry-purpose fixture must reach rejected or processing-failed
through real synthetic private upload/processing evidence; direct D1 fabrication
is forbidden, so retention-purpose verification remains local. A zero-
generation fixture cannot exercise a historical target. The live witness and
absent controls confirmed no redirects and `no-store` responses, but injected
redirect, bad-cache, wrong-binding, historical-target, or
epoch-rotation proof requires a separately reviewed fault/rotation harness and
explicit approval for each changed media/verifier deployment and sequential
epoch activation. Because epoch activations are append-only, a real rotation is
an irreversible forward ledger change even if normal Worker code is restored;
it was not part of the completed zero-generation rehearsal.

The local candidate-manifest tests must prove that exactly one inherited
`family.json` or `everyone.json` document is derived from the current public
catalogue and suppression list; that the result contains only the public `1.0`
photo fields; and that duplicate IDs, cross-mode sharing, hidden tags, unsafe
insertion positions, and conflicting retries fail closed. They also prove the
generator emits one canonical document. The GitHub review-client tests use only
an injected local HTTP substitute. They must reject supplied non-canonical bytes
and prove one fixed repository, `main` parent, owned candidate namespace,
one-file diff, exact manifest bytes, lost-response reconciliation, and refusal
of merge, deployment, Pages, settings, secret, environment, default-branch,
force-update, `PATCH`, `PUT`, and `DELETE` operations. Before mutation, it must
read the target manifest at the exact expected `main` commit and reject any
candidate that removes, edits, or reorders an existing item instead of adding
exactly one new item. Configuration tests must prove the promotion Worker has
exactly its intended D1, staging, and approved bindings, with no originals,
GitHub token, manifest, or caller-selected deletion target. The tracked approved
R2 lifecycle contract must describe exactly one enabled, one-day incomplete-
multipart abort rule under `media/v1/`, explicitly label it orphan containment
only, and forbid its use as cleanup, tombstone, or purge proof.

These tests do not exercise Cloudflare, use real media, write either tracked
manifest, create a GitHub App, open a remote Pull Request, merge, deploy, or
publish. Migrations `0007`–`0009` were subsequently applied to the
non-production D1 database on 31 August 2026. The modified media Worker and
witness were then separated into distinct approval gates: the Worker was
deployed at exact version `cf327eb6-6ba6-46e4-a5da-8e3f541afb8e`, then the
fixed witness was separately uploaded and independently byte-verified. The
matching delivery epoch was then separately registered and activated as
sequence `1`, after an all-or-nothing
local rehearsal and remote preflight. Exact postflight reads found one epoch,
one activation, one matching current pointer, zero generations/receipts/legacy
host confirmations, no foreign-key violations, and `quick_check: ok`; the live
witness and canonical absent control still matched the current epoch. The
promotion Worker remains undeployed; the fixed-origin verifier's final
migration/bridge and diff checks pass. The
complete post-documentation `pnpm test` also passes, including the exact
114-file artifact and responsive
Family and Everyone browser checks. The remaining non-production rollout then
completed the separately approved exact-host Access, verifier deployment,
non-mutating proof, live zero-generation withdrawal, and cleanup gates. Before
the mutating rehearsal, live API reads proved one exact-host application with a
15-minute session, one Service Auth policy attached only there, and one enabled
temporary token. The application was hidden from the App Launcher and configured
to return `401` for failed Service Auth. Independent stateless `GET` requests
proved no credentials and an exact Client ID with the wrong secret returned
`401`, while the exact pair reached the Worker's pre-D1 method stop and returned
`405`, `Allow: POST`, no-store JSON, no redirect, and no `Location` header.

The original one-time secret was unavailable at action time, so the exact
temporary token was rotated; Cloudflare immediately invalidated the old secret.
The replacement credential was held only for the run and was not written to Git,
configuration, D1, or R2. It appeared once in protected browser-automation
output, so the credential was treated as spent and removed during cleanup.

The approved live rehearsal passed. A stale request returned `409` without a D1
change; the current request created one withdrawal-purpose canonical-empty-set
receipt; and exact replay returned the same receipt. The compatibility scalar,
withdrawal, and purge failed closed before that receipt. Withdrawal then
succeeded, but purge remained blocked until the approved tombstone and later
private-original deletion proof existed. Final purge removed all operational
fixture rows while deliberately retaining one permanent hash-only receipt and
one permanent hash-only tombstone. Delivery epoch sequence `1` remained current,
fixture identity fields were null, foreign-key checking was clean, and
`quick_check` returned `ok`. Before-and-after recovery bookmarks were captured
without recording their values.

Postflight reads proved both Worker deployments and bindings unchanged. Approved
R2 still contains only the fixed 28-byte witness with unchanged object metadata
and digest; public witness and canonical absent probes still matched the current
delivery contract. No Worker deployment, R2 mutation, lifecycle change,
promotion, manifest edit, GitHub operation, or publication occurred.

The Service Auth policy was then detached and the verifier application saved
before the reusable policy and token were deleted. Dashboard confirmations and
independent Access API list reads proved the exact-host verifier application
remains with zero policies, the owner application retains its one unchanged
policy, the processing application retains zero policies, and the rehearsal
policy and token are absent. The account has no service tokens.

This does not include retention-expiry-purpose verification, which remains
locally tested until real synthetic private upload/processing evidence exists;
D1-only fabrication is forbidden. Injected redirect, bad-cache, wrong-binding,
historical-target, and real epoch-rotation faults remain a separately reviewed
and approved fault-harness/deployment/append-only-epoch gate. The approved-prefix
lifecycle rule is now independently verified remotely as one enabled
`media/v1/`, one-day incomplete-multipart abort rule alongside the unchanged
provider default. No mutation was needed because the exact rule already existed.
Migration `0010` is applied and independently verified remotely: migration ID
`10`, both exact columns and triggers, three historical complete uploads, zero
active uploads, clean foreign keys, and `quick_check = ok`. The older admin
Worker that remained unchanged during the D1 gate was then replaced under a
separate approval. Independent API
readback proves exact version `c411bead-edb5-441b-aa0b-36594ff8a9b8` serves
100% of traffic, with compatibility date `2026-08-25`, the unchanged hourly
cron, exact D1 and private-originals bindings, the three existing secret-text
names, and no staging, approved-media, GitHub, or automation-identity binding.
The existing owner Access app and policy IDs are unchanged. Anonymous browser
and service health requests both return `302` to Access. A normal owner Access
session then returned exact `{"ok":true,"scope":"owner-browser"}` from
`GET /api/browser/health`; the supplied screenshot and an independent live-tab
readback agreed. This closes the admin deployment/health gate but does not
authorize a real-photo upload or prove the undeployed processing/promotion
boundaries.
Protected candidate retrieval/orchestration, other Worker deployments, and
Access identities/policies remain later separate gates. R2 storage absence
alone is not public-host absence.

The remote-driver contract must expect exactly six passed scenarios, five
completed cleanups, four acknowledged derivative puts, five deliberately
interrupted responses, final private status `staged`, zero approved references,
zero publication references, zero publicward drafts, and zero foreign-key
violations. Its fresh path must admit only an `approved-for-processing` draft at
state version 3 and its final staged query must prove draft state version 19; a
drifted fresh fixture must stop before the first processing request. Its
Scenario A and Scenario D resume paths must accept only exact
server-discovered checkpoints and prove the complete immutable run, cleanup,
object, receipt, audit, and tombstone history before continuing; they must never
reset or manually reconstruct remote state. Scenario F must leave its two
verified derivatives in private staging and must not promote them.

The approved 29 August 2026 remote A–F execution matched that report and ended
at draft state version 19 with six runs, five failed runs, one staged run, five
cleaned cleanup records, five tombstones, two verified private derivatives, no
pending exclusion, and no approved or publication reference. After fault
injection, normal Worker version `bd830cfc-c18b-465e-8835-7232309b33e4` was
restored with exactly three private bindings. The normal header probe returned
`403`, the immutable retry replay returned `200` with `replayed: true`, and
temporary diagnostics were removed. Both public manifests and the suppression
file retained their recorded canonical hashes. After fresh explicit approval,
the rehearsal policy was detached and deleted and the temporary Access service
token was deleted. Dashboard and API checks found neither deleted ID, the
retained processing application reported zero policies, and a credential-free
origin request was intercepted by Cloudflare Access. The old one-time secret
was already absent, so this evidence does not claim an exact credential replay.

Every public page is also checked for a `noindex` robots meta tag. The site is
kept out of search results by that tag rather than by a `robots.txt` Disallow,
so a new page shipping without it would be indexed while every other page is
not.

Desktop contexts run at 1440 x 900. Mobile contexts run at 390 x 844 with Chromium device emulation enabled, so the page's `<meta name="viewport">` tag is honoured and mobile assertions and screenshots reflect a real phone. Every public page is checked directly for a `width=device-width` viewport tag, an `<html lang>` attribute, and a layout width matching the emulated viewport. That check is deliberately explicit: a page missing the tag lays out at the roughly 980px desktop fallback, which does not overflow, so the horizontal overflow assertion alone would not catch it.

Mobile layout still runs with a three-times device scale factor, but full-page
screenshots are saved at Playwright's CSS-pixel scale. That keeps the current
390px-wide pages below Chromium's 16,384-bitmap-row full-page stitching limit.
Without the CSS-scale capture, very tall 3x mobile screenshots can repeat their
opening pixels after that boundary and appear complete while omitting the real
lower page. If a future page itself exceeds 16,384 CSS pixels, capture it in
reviewable vertical sections rather than treating one stitched image as proof.

Locally the tests use an installed system Chrome or Edge when one is present. When `CI` is set they use Playwright's own pinned Chromium, so continuous integration always tests the browser version recorded in the lockfile rather than whichever build the runner image happens to ship.

The Records page renders its groups in exported order rather than imposing one.
Browser coverage derives the expected group sequence from the exported
`SortOrder` in the CSV under test instead of restating the workbook-owned
matrix, so changing the export changes the expectation. The page and its test
previously both forced Women before Men, which reversed the export and meant a
workbook change could not correct the page.

A mobile leaderboard card regression test covers the narrow-viewport
championship layout in both site modes. Below the 700px breakpoint each
standings row renders as a card, so the test asserts the header row is hidden,
rows render as blocks, each labelled cell carries its column name through
`content: attr(data-label)`, and the rank and participant heading cells do not
repeat theirs. Its most important assertion is content parity: the card fields
must exactly equal the table's own column headers, so a future change cannot
quietly drop a column and pass as a layout improvement. The same checks run at
1440px in reverse, proving the desktop table still renders as a real table with
its header row and no injected labels. Podium coverage proves every non-vacant
rendered table keeps one podium immediately before it, the three exported
leaders retain matching medals in podium and table, category badges display one
word but keep the full exported accessible label, and time/pace values break at
the same deliberate point. On mobile the three podium cards must stay in one
row under 280px tall. Opening a previously collapsed distance proves its
exported Current section still precedes its All-Time section and that each
ranked table receives the same treatment; vacant/no-result sections
deliberately retain their table without inventing a podium.

A document-title regression test checks every static public page in both modes.
Each `<title>` is fixed markup, so an Everyone-mode tab used to read "Family
Running Championships" while the header showed the exported Everyone name.
`site-navigation.js` now replaces the site-name portion with the exported
`SiteName`, keeping each page's own prefix, and the test fails if a title omits
the selected mode's exported name or names the other mode. The athlete page is
asserted separately: its title names the athlete and no site mode, which was
already correct and must stay that way.

A brand metadata regression test checks every public page for its description,
theme colour, Open Graph, and Twitter card tags and its three icon links, then
requests each icon and the Open Graph image to prove they are actually served
rather than only referenced. It also fails if the description, `og:title`, or
`og:description` names a single site mode: one static file serves both Family
and Everyone, so mode-specific share copy would be wrong for every share of the
other mode.

A Recent Results window regression test proves the athlete page measures its
twelve month window from the export's own `LastUpdatedUTC` rather than the
visitor's clock. Its fixture is deliberately permanent: a synthetic export dated
1 June 2020 with a result from 1 March 2020, which is inside the exported window
but years outside any window measured from "now", so the assertion keeps
discriminating however long after the fixture was written the suite runs.

A hostile-value regression test drives markup-bearing text through the exported
`DisplayDistance` heading, the leaderboard `DisplayTitle`, a table header, and
both the linked and unlinked participant paths. It proves the values render as
literal text, that no element is created from them, and that no injected handler
executes. A CSV-parsing regression test proves the browser parser reads quoted
commas, escaped quotes, mixed CRLF and LF line endings, and quoted multiline
fields exactly as `scripts/validate-csv.mjs` does, and fails closed on an
unclosed quoted field rather than rendering mangled data.

They check that each mode loads, uses the expected site title, renders Hall of Fame cards and leaderboards, requests only the selected mode's crown history, preserves the exported crown order and values, handles timeline expansion, empty exports and incomplete legacy identities, preserves the selected site in holder links, exposes athlete links where athlete data exists, opens an athlete profile, preserves the original `site` parameter in the back link, renders athlete medals exported by Excel directly from `data/<site>/official_medals.csv` without requesting leaderboard CSVs for those medal cards, renders the Records page empty state while tracked data has no absolute-records export, and never renders `ExportBundleID` names or values in tables or cards. They also check the athlete progression chart renders from the vendored Chart.js build on a real time scale, synthetic absolute-records data for Men and Women rendering, selected-site-only CSV requests, linked and unlinked athletes, empty exported record states, collapsible sections, vacant Hall of Fame states, horizontal overflow, JavaScript exceptions, and failed same-origin network requests.

Calculator coverage checks shared navigation, selected-site-only
`age_grade_standards.csv` requests for the comparison athlete roster,
Challenger/Standard controls, official-first and unofficial-second result
grouping, the absence of the duplicate single-athlete race-target builder, the
manifest-absent comparison state, pace-unit switching, and absence of
export-bundle metadata. Synthetic workbook-export coverage checks both `Best
Age Grade` and `Fastest Time` standards in both result classes, Current and All
Time switching, and one-row/two-badge presentation when both benchmarks share
the same performance. CSV validation requires both benchmarks independently
for every available athlete, period, distance, and result class, verifies the
source performance is best within that period and class, and enforces
class-aware sort order. Browser coverage preserves exact source details and
challenger target times and paces, prevents self-comparison, defaults to the
closest age-grade gap among the exported top-five Current Official Overall
championship, preserves mode isolation, and checks responsive presentation.
The browser does not interpolate or calculate age grades or targets.

The macro-enabled source workbook and its dated private backups stay outside Git. Only VBA-generated public CSVs and `data/export_manifest.csv` belong in the repository.

Screenshots are saved to `test-artifacts/screenshots/` for:

- Family desktop, 1440 x 900
- Family mobile, 390 x 844
- Everyone desktop, 1440 x 900
- Everyone mobile, 390 x 844

The same pass saves Gallery screenshots for both modes at both sizes and focused
populated-gallery screenshots for desktop and mobile using synthetic approved
media metadata.

The same browser pass also saves full-page Calculator screenshots for Family
and Everyone at both desktop and mobile sizes, plus focused desktop and mobile
comparison screenshots using synthetic period-labelled workbook-export rows.

The synthetic populated-media pass also saves focused desktop and mobile
Championship screenshots showing an approved athlete-tagged photo on the
podium. These complement the normal both-mode screenshots, whose intentionally
empty manifests exercise the branded fallback state.

Generated screenshots and reports are ignored by Git.

### News displaced-medal-holder extension status

The later approved follow-up grows the News header from 44 to 60 columns by
adding a workbook-owned displaced-holder quartet after each context's
`MedalAfter`: athlete ID, athlete name, prior medal, and resulting medal. The
quartet is all-or-blank and represents one verified former holder only. Its
allowed chains are `Gold → Silver`, `Silver → Bronze`, and
`Bronze → No medal`; it stays blank for retained positions, no former holder,
or an ambiguous attribution. `MedalEntry` remains the only card-callout signal.

The fresh 72-file bundle at
`test-artifacts/workbook-export-staging/run-20260824-143417-090` passed
staged validation. Reconciliation found only the two mode-specific News CSVs
changed, and a field-by-field comparison found every prior News value unchanged.
Carolyn Kevan's 26 August 2017 All-Time Distance and Overall `Silver → Gold`
movement names David Graham-Kevan as the former Gold holder, who moves to
Silver. John approved atomic promotion; the recoverable prior bundle is at
`test-artifacts/workbook-export-promotion/20260824190008107/previous-data`.

Focused contract coverage validates complete-or-blank quartets, selected-mode
public identity, non-self attribution, focal-medal agreement, each permitted
handoff chain, invalid/hostile values, and 1 Mile's blank Distance contexts.
Browser coverage validates the visible statement, mode-preserving athlete link,
screen-reader transition wording, all contexts, and desktop/mobile layout.
The promoted-root `pnpm test` run passed repository safety, vendor/CSV/Gallery
validation, contract regressions, artifact safety/build, and browser smoke
tests with responsive screenshots and no overflow.

### News ranked-athlete-count extension status

The later approved presentation/data follow-up grows the News header from 60
to 64 columns. Immediately after every context's `RankAfter`, the workbook
exports `RankedAthleteCountAfter`: the positive count of distinct athletes with
a qualifying Official performance in that same selected-mode post-result
snapshot. It is at least `RankAfter`, never inferred from a rank, and blank
only with an unavailable table; 1 Mile Distance counts stay blank while 1 Mile
Overall counts remain populated. News displays `#rank / count` and fails closed
for a missing, malformed, zero, or below-rank count.

The paired presentation refinement shortens a complete former-holder
attribution to `Gold taken from Alex`. It keeps the exported identity and
selected-mode link, but does not state the displaced athlete's later medal
status. This is a new coordinated workbook/schema/validator/browser change
requiring a fresh full 64-column bundle, reconciliation, promotion, complete
suite, and both-mode responsive review before release.

## Manual Review Checklist For John

Before approving a Pull Request:

- Confirm the purpose and scope are clear.
- Review the files changed and why.
- Confirm any CSV schema impact is intentional.
- Confirm any Excel/VBA impact is intentional.
- Check automated test results.
- Confirm the Pull Request is using the correct release pathway.
- For a standard change, confirm Netlify's Deploy Preview status is successful,
  use the bot-maintained preview-links comment, and open both review links:
  - `?site=family`
  - `?site=everyone`
- For a validated no-visual change, confirm the Pull Request title contains
  `[skip netlify]`, the automated eligibility gate found no published,
  publishing-control, or unclassified path, and the exact diff plus any
  service-specific evidence has been reviewed.
- For a validated lightweight data refresh, confirm the Pull Request title
  contains `[skip netlify]`, the automated eligibility gate passed, and the
  exact CSV diff contains only the intended new data and bundle metadata. Also
  confirm that the only non-CSV routine artifact is the generated private
  Gallery catalogue and that its freshness check passed.
  When using the guided updater, this review happens at its `MERGE`
  checkpoint, after the Pull Request and its screenshot artifact exist.
- For a validated custom-domain change, confirm the title contains
  `[skip netlify]`, the eligibility gate passed, `CNAME` contains only the
  intended hostname, and the exact diff stays within the domain allowlist.
- For Gallery promotion or takedown infrastructure, separate repository/static
  proof from Cloudflare proof. Confirm the migration level, exact public media
  origin and deployed Worker version, witness bytes, current delivery epoch,
  narrow verifier Access identity/policy, no-redirect/no-cache/no-credential
  front-door evidence, and current-generation receipt. Check the canonical
  zero-generation case and the private-original/retention gates on purge. For a
  completed one-use rehearsal, also prove the temporary token and reusable
  policy are absent and the retained verifier application reports zero policies;
  confirm the owner and processing applications kept their previous policy
  counts. Record permanent hash-only receipt/tombstone survivors separately from
  operational rows rather than calling the database empty. For a
  candidate manifest, inspect the one-file structural diff and confirm it adds
  only the intended item while preserving every existing item and order in the
  upload's inherited Family or Everyone area; there must be no destination
  selector or cross-mode edit.
- Do not report a local injected redirect, cache, wrong-binding, or historical-
  target fault as remote proof. A live fault run needs a reviewed harness,
  explicit Worker-deployment approvals, restoration evidence, and a separately
  approved next epoch. Record that the append-only epoch advance cannot be
  rolled back to an earlier ledger state.
- Review desktop and mobile screenshots.
- Manually check Hall of Fame, All-Time Official Crown Progression, Official
  Results News when it is part of the change, Records, the Calculator's grouped
  head-to-head comparison, leaderboards, collapsible sections, athlete links,
  athlete profile pages, and back links.
- For the first News export, review representative workbook replay chains,
  same-day ordering, exact age-grade deltas, millisecond-preserving raw-time
  values and improvements, the strict 365-day Current boundary, all four
  before/after rank contexts, the two new manifest rows, and final-state
  agreement with every Official leaderboard before data promotion.
- For the News medal-position snapshot extension, review all 12 aligned medal
  fields, representative unranked and Rank 4+ entries into Gold/Silver/Bronze,
  a Rank 2 to Rank 1 `Silver` to `Gold` upgrade, retained medal positions,
  multi-context rows, 1 Mile's blank Distance fields, and mode-specific
  Family/Everyone differences. Confirm the preview uses `entered a
  medal-winning position` only for a new entry, does not claim a final medal
  award, and makes every medal label clear without colour or icons.
- For the displaced-medal-holder extension, review a Gold-to-Silver,
  Silver-to-Bronze, and Bronze-to-No-medal handoff; confirm the named former
  holder is exported, linked in the selected mode, and never inferred from
  ranks. Confirm retained or ambiguous cases show no attribution and that
  1 Mile Distance contexts keep the full eleven-field group blank.
- For the ranked-athlete-count extension, review `#rank / count` in every
  Current/All-Time and Distance/Overall context, including an unranked entry,
  a tied rank, 1 Mile's blank Distance counts, and populated Overall counts.
  Confirm the count is workbook-exported rather than derived and the former
  holder statement does not name their later medal status.
- For record changes, review the private workbook's `AbsoluteRecords` sheet and the staged `absolute_records.csv` files before approving tracked data promotion.
- Confirm known limitations and rollback approach are documented.

## Release Gate

No passing tests, no release.

For standard changes, no successful preview and review of both site modes, no
release.

A passing private synthetic media rehearsal is service evidence, not approval
to publish. Every fault-injection run must finish by restoring the normal
processing Worker, proving its exact D1/private-original/private-staging binding
inventory, proving the rehearsal header is rejected, and reconciling D1, R2,
approved/public references, public manifest hashes, and foreign keys. No real
media, approved-media promotion, candidate manifest, GitHub App or environment,
Pull Request, merge, DNS change, or production publication follows without its
own explicit approval. Credential deletion is also a separate destructive step
and must not be reported complete before fresh approval and revoked-token
verification. Prefer replaying the exact old credential pair after deletion
when its one-time secret is still available. If that secret was already removed
from the ephemeral session, do not recreate it or claim an exact replay:
instead require the exact token lookup to return not found, the token and policy
lists to omit their IDs, the retained Access application to report zero
policies, and a credential-free request to be intercepted before the Worker.
Record that limitation explicitly in the handoff.

The first Official Results News release changes the workbook, export set, CSV
contract, published runtime, and browser behavior. It must use the standard
preview pathway; it is not eligible for the existing-schema lightweight data
route. The 72-file staged bundle and staged validator have passed, but that is
only one release gate. No completed focused failure coverage, successful full
suite, both-mode browser and responsive screenshot review, tracked-data
promotion, and explicit approval, no News release.

The 12-field medal-position contract (four existing threshold-entry fields plus
eight before/after snapshots) is also a coordinated workbook schema, data,
validator, and browser change. It is not eligible for the existing-schema
lightweight data route. Do not reuse the earlier 36-column acceptance record:
the snapshot extension needs its own refreshed full-bundle validation,
reconciliation, promotion, tracked-data validation, complete local suite, and
both-mode responsive review before release.

The later 28-field medal-and-displacement contract (the 12 medal fields plus
16 displaced-holder fields) is likewise a coordinated workbook schema, data,
validator, and browser change. It requires a fresh 60-column full bundle,
reconciliation that isolates the two News CSVs, explicit promotion approval,
tracked-data validation, full-suite and responsive review before release.

The later four-field ranked-athlete-count extension is likewise a coordinated
workbook schema, data, validator, and browser change. It requires a fresh
64-column full bundle, reconciliation that isolates the two News CSVs,
explicit promotion approval, tracked-data validation, full-suite and
responsive review before release.

For validated lightweight data refreshes, no accepted eligibility gate, exact
CSV and derived-catalogue diff review, and responsive screenshot review for
both site modes, no release.

For validated no-visual changes, no accepted eligibility gate, exact diff
review, responsive screenshot review, and any required service-specific
evidence, no release.

For validated custom-domain changes, no accepted eligibility gate, exact diff
review, responsive screenshot review, and post-merge production verification,
no release.

No explicit John approval, no release. In the guided routine-data workflow,
`PUBLISH` approves opening the Pull Request and the exact `MERGE` confirmation,
typed after reviewing its diff and uploaded screenshots, is explicit John
approval for the merge; other pathways still require separate PR approval.

## Proposed Workflow

1. Create a feature branch.
2. Make the smallest safe change.
3. Run all local checks.
4. Choose the Pull Request pathway:
   - standard changes use an ordinary title and wait for GitHub checks, a
     successful Netlify Deploy Preview, and the preview-review-links comment;
   - an eligible no-visual change uses a title such as
     `[skip netlify] Update release verification tooling`, then relies on the
     automated eligibility gate, exact diff, responsive screenshots, and any
     applicable service-specific evidence because Netlify cannot display the
     change;
   - an eligible existing-schema data refresh uses a title such as
     `[skip netlify] Refresh August race times` before the Pull Request is
     opened, then waits for the full GitHub checks and lightweight-review
     comment without generating a Netlify preview;
   - an eligible custom-domain change uses a title such as
     `[skip netlify] Configure aceofrace.com custom domain`, then relies on the
     full GitHub checks, screenshots, exact diff review, and post-merge
     production verification because DNS behavior cannot be represented by the
     Netlify hostname.
   The guided `pnpm run data:update` command performs these branch, validation,
   promotion, test, Pull Request, and required-check wait steps for a qualifying
   routine refresh after `PUBLISH`, then stops for review before its separate
   `MERGE` confirmation. After merging, it waits for the exact Pages run,
   verifies the immutable data bundle and both rendered production modes, and
   only then performs branch deletion and scoped cleanup.
5. John reviews both site modes through the standard preview, or reviews the
   exact diff and uploaded responsive screenshots for a validated skip
   pathway, plus the manual steps, limitations, and rollback plan.
6. Merge to `main` only after John explicitly approves production. For the
   guided routine-data workflow, `MERGE` supplies this approval, typed after
   reviewing the Pull Request diff and the uploaded screenshots.
7. Verify production after GitHub Pages updates. The guided routine-data path
   performs its exact-commit, exact-bundle, both-mode verification
   automatically; standard, no-visual, and custom-domain releases still use the
   manual checks below.

## Pull Request Checks And Preview URLs

GitHub Actions runs `.github/workflows/pr-checks.yml` on the Pull Request commit
for release-path classification, the complete test suite, and responsive
screenshots. This is a regression and review gate, not a separate adversarial
trust boundary: any change to the validator, its artifact-list source, or a
workflow must use the standard preview pathway and receive separate John review.

`.github/workflows/pr-preview-review-links.yml` creates or updates one bot-maintained PR comment containing the authoritative review links:

- Family: `https://deploy-preview-PR_NUMBER--thunderous-moxie-c5aac5.netlify.app/?site=family`
- Everyone: `https://deploy-preview-PR_NUMBER--thunderous-moxie-c5aac5.netlify.app/?site=everyone`

For the standard pathway, the deterministic URLs are available immediately,
but they are not ready for review until Netlify's Deploy Preview status
succeeds. Review both site modes before approval.

For a no-visual change, add `[skip netlify]` before opening the Pull Request.
The preview-review-links workflow maintains a `Netlify preview skip requested`
comment based only on that title marker. The comment is not proof of
eligibility; `Pull Request Checks / Test static site` must pass and confirm that
no published, publishing-control, or unclassified path changed. Review the exact
diff, uploaded responsive screenshots, and any authenticated/environment-
specific evidence for a private service or admin surface.

For a lightweight data refresh, add `[skip netlify]` to the Pull Request title
before opening it. Netlify's supported title marker prevents a Deploy Preview
from being generated. The preview-review-links workflow instead maintains a
`Netlify preview skip requested` comment. `Pull Request Checks / Test static
site` confirms that only existing-schema CSV exports and optional active-work
notes changed apart from the one exact deterministic private Gallery catalogue,
runs every local-style test, and uploads the responsive screenshots. Any other
Gallery path fails this route. Do not use `[skip ci]`, because GitHub Actions
must not be skipped.

Once the workflow exists on `main`, test it manually by opening `PR Preview Review Links` in GitHub Actions, choosing **Run workflow**, selecting the implementation branch, entering the Pull Request number, and running it. Re-running it updates the same marked comment rather than adding another. GitHub does not expose `workflow_dispatch` for the first Pull Request that introduces a workflow because the workflow file is not yet on the default branch.

The Netlify build uses `netlify.toml`, runs `pnpm run preview:build`, and publishes `test-artifacts/preview-site`.

## Production Verification

After an approved release reaches GitHub Pages, verify:

- [Family production](https://www.aceofrace.com/?site=family)
- [Everyone production](https://www.aceofrace.com/?site=everyone)

Pull Request #84 is the recorded exact-release example for this boundary. It
merged to `main` at
`4b6c7be70d77ce389f7ee9a5b103858cd31ff55b`; all 114 files in the Pages
artifact and production site, including all 72 manifest-listed CSVs,
byte-matched that commit, and both Family and Everyone rendered while both
Gallery manifests remained empty. This verifies only that static GitHub Pages
release. It is not evidence that migrations `0007`–`0009`, a media Worker
version, the witness, a delivery epoch, verifier Access, or either local
service-only Worker has been deployed.

For a guided routine data refresh, a final `LIVE VERIFICATION PASSED` message is
the automated evidence for this gate. It names the expected `ExportBundleID`,
the exact Pages workflow run, and both production URLs. The verifier sends
cache-revalidation headers, requires every one of the 72 live CSV response
bodies to match the reviewed data commit exactly, and then checks both modes in
Chromium. A successful merge, a successful workflow with a different commit,
or HTTP 200 responses alone do not pass.

Check that both modes load, Hall of Fame renders, Calculator comparisons use the selected mode and separate official from unofficial source performances, leaderboards render, athlete links open, and back links preserve the correct mode. After the Official Results News first draft is released, also open News in both modes, confirm each mode requests only its own export, verify representative milestone and movement text, and check that a News athlete link preserves the selected mode.

## Rollback

If production verification fails:

1. Stop further changes.
2. Capture the failure details and affected URL.
3. Revert the merge commit or restore the last known good commit on `main`.
4. Wait for GitHub Pages to republish.
5. Re-run production verification for both site modes.

## GitHub Settings To Configure Later

John will need to configure these manually in GitHub when ready:

- Branch protection for `main`.
- Required Pull Request review before merge for standard, no-visual, and
  custom-domain changes. The guided routine-data pathway instead uses its exact
  `MERGE` approval plus the protected required check, so an unconditional review
  rule would intentionally disable that automatic path.
- Required automated check before merge: `Pull Request Checks / Test static site`.
- Netlify Deploy Preview treated as a process gate for standard changes, but
  not as an unconditional repository ruleset check because validated skip
  pathways intentionally do not create one.
- GitHub Pages production deployment permissions.
- Optional environment protection requiring John approval before production release.

More detail: [GitHub PR checks and preview deployments](github-pr-checks-and-preview-deployments.md).
