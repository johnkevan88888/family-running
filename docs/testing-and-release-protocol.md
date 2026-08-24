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
then merges through the protected Pull Request pathway, deletes the merged
branch, and performs update-scoped cleanup.

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

### News medal-position extension status

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
The complete `pnpm test` suite passes, including the 107-file preview-artifact
build. Browser smoke coverage passes in both modes at 1440px, the 720px
intermediate probe, and 390px mobile. Responsive screenshots were refreshed and
manually reviewed; the medal callout and per-context badges remain readable and
contained, with no horizontal overflow. The branch push and updated Deploy
Preview remain pending and are not recorded as passing here.

Focused CSV validation must require the exact ordered 36-column News header and
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
result and non-rank/non-medal-entry values in Everyone while allowing
mode-specific order, rank triplets, and medal entries. Every medal-entry field
must be checked against its own aligned rank triplet: reject missing, wrong,
extraneous, or unsupported values; accept Gold/Silver/Bronze, multiple contexts
on one row, and direct competition-rank tie semantics; keep within-medal moves
and unavailable 1 Mile distance contexts blank.

The repository may validate exported arithmetic and public-source agreement,
but it must not generate milestones or ranks. Before the manifest is written,
workbook post-export validation must replay date/`SourceRow` order, preserve
source time through millisecond precision, apply the
strict historical Current rule (`result date > D - 365 days` and
`result date <= D`), populate each medal-entry field from the same
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
that only exported medal-entry fields trigger the explicit card callout and
per-context Gold/Silver/Bronze labels, that multiple contexts render, that
within-medal movement is not called a new entry, and that rank numbers alone do
not cause the browser to infer a medal. The treatment must use visible text as
well as colour and decorative icons. It must also prove there is no fallback
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
Request preview still requires the validated branch update to be pushed.

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

`data/`, `vendor/`, and `assets/` are copied as whole directories, so the file
whitelist says nothing about their contents. Each is checked against its own
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
into the assets folder.

Preview artifact safety regression tests cover both gates. They assert every
rejected output-directory shape, prove the build refuses an out-of-tree
directory without deleting it by aiming a refused build at a throwaway
directory containing a canary file, and prove all three publication contracts on
the real tree by adding one stray file to `data/`, one to `vendor/`, and one to
`assets/brand/` and removing them again.

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

A third `[skip netlify]` pathway covers changes that cannot alter what a preview
would show. It is allowed when no changed file is published to the site and no
changed file decides what is published or how it is deployed. "Published" is
read from `scripts/published-site-entries.mjs`, the same list the artifact build
copies, so adding a page makes it preview-relevant in the same edit rather than
requiring a second list to be kept in step. Documentation, tests, and local
tooling therefore skip the preview; any page, style, script, vendored library,
`data/` file, build definition, or workflow does not. Omitting the marker always
requires a full preview, whatever the change.

Pull Request release-path tests recognize Netlify's `[skip netlify]` title
marker for a narrow lightweight data refresh or custom-domain configuration.
The data route requires at least
one changed existing CSV under `data/`, requires the complete tracked public
CSV bundle to be refreshed, permits only optional
`docs/active-work.md` notes alongside it, rejects added or removed CSVs, and
compares every changed CSV header against `main` to reject schema changes. The
domain route requires the root `CNAME` to contain exactly the approved
production hostname, `www.aceofrace.com`, compared case-insensitively, and
permits only the explicit domain, analytics, test, workflow, and documentation
allowlist. A syntax check alone previously let any valid hostname take the
preview-skipping route and self-approve it; a genuine domain migration must now
change `CUSTOM_DOMAIN_CANONICAL_HOST` in
`scripts/validate-pr-release-path.mjs`, its tests, this document, and the DNS
plan together, through the standard preview pathway. Other code,
configuration, schema, export-set, and broader documentation changes fail the
eligibility gate and must use a standard Deploy Preview.

Browser smoke tests run the site through a local static server for:

- `/?site=family`
- `/?site=everyone`

Every public page is also checked for a `noindex` robots meta tag. The site is
kept out of search results by that tag rather than by a `robots.txt` Disallow,
so a new page shipping without it would be indexed while every other page is
not.

Desktop contexts run at 1440 x 900. Mobile contexts run at 390 x 844 with Chromium device emulation enabled, so the page's `<meta name="viewport">` tag is honoured and mobile assertions and screenshots reflect a real phone. Every public page is checked directly for a `width=device-width` viewport tag, an `<html lang>` attribute, and a layout width matching the emulated viewport. That check is deliberately explicit: a page missing the tag lays out at the roughly 980px desktop fallback, which does not overflow, so the horizontal overflow assertion alone would not catch it.

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
its header row and no injected labels.

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

The same browser pass also saves full-page Calculator screenshots for Family
and Everyone at both desktop and mobile sizes, plus focused desktop and mobile
comparison screenshots using synthetic period-labelled workbook-export rows.

Generated screenshots and reports are ignored by Git.

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
- For a validated lightweight data refresh, confirm the Pull Request title
  contains `[skip netlify]`, the automated eligibility gate passed, and the
  exact CSV diff contains only the intended new data and bundle metadata.
  When using the guided updater, this review happens at its `MERGE`
  checkpoint, after the Pull Request and its screenshot artifact exist.
- For a validated custom-domain change, confirm the title contains
  `[skip netlify]`, the eligibility gate passed, `CNAME` contains only the
  intended hostname, and the exact diff stays within the domain allowlist.
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
- For the News medal-position extension, review all four new header fields,
  representative unranked and Rank 4+ entries into Gold/Silver/Bronze,
  multi-context rows, a within-medal move that remains unmarked, 1 Mile's blank
  distance fields, and mode-specific Family/Everyone differences. Confirm the
  preview says `entered a medal-winning position` rather than claiming a final
  medal award, and that text remains clear without colour or icons.
- For record changes, review the private workbook's `AbsoluteRecords` sheet and the staged `absolute_records.csv` files before approving tracked data promotion.
- Confirm known limitations and rollback approach are documented.

## Release Gate

No passing tests, no release.

For standard changes, no successful preview and review of both site modes, no
release.

The first Official Results News release changes the workbook, export set, CSV
contract, published runtime, and browser behavior. It must use the standard
preview pathway; it is not eligible for the existing-schema lightweight data
route. The 72-file staged bundle and staged validator have passed, but that is
only one release gate. No completed focused failure coverage, successful full
suite, both-mode browser and responsive screenshot review, tracked-data
promotion, and explicit approval, no News release.

The four-field medal-position extension is also a coordinated workbook schema,
data, validator, and browser change. It is not eligible for the existing-schema
lightweight data route. Its refreshed full-bundle validation, reconciliation,
promotion, tracked-data validation, complete local suite, and both-mode
responsive review pass. No updated Deploy Preview and explicit approval, no
release of the extension.

For validated lightweight data refreshes, no accepted eligibility gate, exact
CSV diff review, and responsive screenshot review for both site modes, no
release.

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
   `MERGE` confirmation, branch deletion, and scoped cleanup.
5. John reviews both site modes through the standard preview, or reviews the
   exact diff and uploaded responsive screenshots for a validated skip
   pathway, plus the manual steps, limitations, and rollback plan.
6. Merge to `main` only after John explicitly approves production. For the
   guided routine-data workflow, `MERGE` supplies this approval, typed after
   reviewing the Pull Request diff and the uploaded screenshots.
7. Verify production after GitHub Pages updates.

## Pull Request Checks And Preview URLs

GitHub Actions runs `.github/workflows/pr-checks.yml` for Pull Requests targeting `main`.

`.github/workflows/pr-preview-review-links.yml` creates or updates one bot-maintained PR comment containing the authoritative review links:

- Family: `https://deploy-preview-PR_NUMBER--thunderous-moxie-c5aac5.netlify.app/?site=family`
- Everyone: `https://deploy-preview-PR_NUMBER--thunderous-moxie-c5aac5.netlify.app/?site=everyone`

For the standard pathway, the deterministic URLs are available immediately,
but they are not ready for review until Netlify's Deploy Preview status
succeeds. Review both site modes before approval.

For a lightweight data refresh, add `[skip netlify]` to the Pull Request title
before opening it. Netlify's supported title marker prevents a Deploy Preview
from being generated. The preview-review-links workflow instead maintains a
lightweight-review comment, while `Pull Request Checks / Test static site`
confirms that only existing-schema CSV exports and optional active-work notes
changed. Every local-style test and the responsive screenshot upload still
runs. Do not use `[skip ci]`, because GitHub Actions must not be skipped.

Once the workflow exists on `main`, test it manually by opening `PR Preview Review Links` in GitHub Actions, choosing **Run workflow**, selecting the implementation branch, entering the Pull Request number, and running it. Re-running it updates the same marked comment rather than adding another. GitHub does not expose `workflow_dispatch` for the first Pull Request that introduces a workflow because the workflow file is not yet on the default branch.

The Netlify build uses `netlify.toml`, runs `pnpm run preview:build`, and publishes `test-artifacts/preview-site`.

## Production Verification

After an approved release reaches GitHub Pages, verify:

- [Family production](https://www.aceofrace.com/?site=family)
- [Everyone production](https://www.aceofrace.com/?site=everyone)

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
- Required Pull Request review before merge for standard and custom-domain
  changes. The guided routine-data pathway instead uses its exact `MERGE`
  approval plus the protected required check, so an unconditional review rule
  would intentionally disable that automatic path.
- Required automated checks before merge: `Pull Request Checks / Test static site`.
- Netlify Deploy Preview treated as a process gate for standard changes, but
  not as an unconditional repository ruleset check because validated
  lightweight refreshes intentionally do not create one.
- GitHub Pages production deployment permissions.
- Optional environment protection requiring John approval before production release.

More detail: [GitHub PR checks and preview deployments](github-pr-checks-and-preview-deployments.md).
