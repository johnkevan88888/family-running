# Active Work

## Current task: owner-authenticated Gallery media upload foundation

### Status — 27 August 2026

The storage, authentication, access, processing, and publication decision is
accepted and documented on `codex/gallery-upload-architecture`. The owner
approved the Cloudflare-managed `workers.dev` pilot and, on 26 August, approved
Phase B non-production provisioning and deployment with synthetic text records
only. That approval does not include DNS changes, real media, GitHub Apps,
Pull Requests, merges, or production publication. On 27 August the owner
accepted the projected family-scale cost, approved the existing Cloudflare
account for this isolated resource set, and completed sign-in. One empty
non-production D1 database, three empty private R2 buckets, and the two
least-privilege Workers are now provisioned. Zero Trust Free, account MFA, and
the $5 account-email budget alert are active. The administration Worker is
owner-only behind Worker-level Access; the media Worker remains public but can
read only the empty approved-derivative bucket. No original, derivative,
manifest item, DNS record, or public media URL has been created. Pull Request
#76 contains implementation code and documentation only.

The selected first implementation keeps the championship site static and uses
a separate Cloudflare Access-protected Worker for the one owner. Private R2
buckets separate untouched originals, candidate derivatives, and approved
public-preview derivatives; D1 holds private consent, moderation, state, and
audit records; and a separate public Worker can read only approved derivatives.
A protected default-branch GitHub Actions job applies deterministic photo/video
processing and independently verifies metadata removal before a repository-
scoped GitHub App opens a normal manifest Pull Request. The App has no merge
authority.

The protected processing-environment approval is the explicit authorization to
make sanitized, unguessable media URLs reachable for the standard Netlify Pull
Request preview. Explicit merge approval remains a separate release gate for
the public manifest. The public Gallery `1.0` schema, site/date/event/distance
selection, public athlete-ID tagging, cross-mode equality, consent boundary,
metadata stripping, global suppression, and host-first takedown contracts do
not change.

The pilot uses Cloudflare-managed `workers.dev` hostnames and deliberately does
not move `aceofrace.com` from its existing DNS. A first-party media hostname is
still preferred, but its DNS migration is a separate future decision. The
complete architecture, threat boundaries, retention rules, validation matrix,
and phased implementation plan are in
[Owner-Authenticated Gallery Upload Architecture](gallery-upload-architecture.md).

Provider-independent Phase A is implemented locally. The unpublished upload
contract binds opaque drafts to exact export, source, item, consent, and
suppression revisions; permits only the accepted state transitions with
compare-and-swap and idempotency evidence; sends only an opaque draft ID to the
future processor; and accepts only processor-bound immutable derivative URLs.
Consent and guardian gates still apply with no athlete tags. Current and pending
hidden IDs block the whole item before processing and publication.

The tagging helper accepts only public athlete IDs and orders selected-race
runners before the remaining public roster. Athlete-wide exclusion is
revision-bound, checks both complete manifests and every shared ID, appends only
the public ID to suppression, removes whole matching items, deduplicates owned
derivative references, and fails closed on external/reused URLs. Individual
rejection and withdrawal cannot emit a public item; consent withdrawal also
requires verified private-original deletion.

The media policy covers supported formats and limits, extension/MIME/signature
agreement, corrupt inputs, derivative dimensions/codecs/streams, exact
SHA-256/length/pinned-scanner evidence, truncation/tool failure, and zero
surviving public metadata or chapters. Synthetic JPEG-like and QuickTime-like
byte fixtures carry hostile GPS, device, source-name, chapter, and secret
sentinels without using family media.

The final `pnpm test` passes: repository safety, vendored libraries, both-mode
CSV and Gallery validation, both new focused suites, all workflow regressions,
the 114-file public artifact, and desktop/mobile browser smoke tests in Family
and Everyone modes. The suppression browser rehearsal now covers the same
shared hidden item in both modes and proves no hidden media request occurs.
Responsive screenshots remain only under ignored `test-artifacts/`. The public
manifests remain empty; no site runtime, public data, or published artifact entry
changed. An independent final security review found no remaining Phase A
blocker.

The Phase B service baseline is also implemented under the unpublished
`gallery-admin/` boundary. The administration Worker reads the platform-
validated identity through `ctx.access`, admits exactly one configured owner,
originally served a minimal no-script shell directly, separates browser and future
automation routes, and requires a signed 30-minute session plus same-origin and
CSRF evidence for its one synthetic D1 write. It exposes no upload, original-
preview, processing, manifest, suppression-edit, GitHub, merge, or publication
route.

The separate delivery Worker binds only the approved-derivative bucket and
accepts `GET` or `HEAD` for the four exact immutable Gallery derivative paths.
It cannot list a bucket or reach D1, originals, or staging. The reviewed D1
migration binds every derivative to the active item, consent, export, source,
and suppression revisions; preserves version, withdrawal, idempotency, and
append-only audit evidence; and records pending whole-item athlete exclusions
by public athlete ID only. Private child data can be purged only after terminal
cleanup evidence and an append-only opaque tombstone survive. The Phase B API
can write only the server-generated exact canary
`synthetic:phase-b-auth-boundary-v1`. Tracked Wrangler examples disable preview
URLs and are deliberately inert until copied to ignored local configuration
with confirmed resource identifiers. The original deployed Phase B admin
remains D1-only. The tracked Phase C admin example now grants D1 plus only the
private-original bucket and an hourly cleanup schedule; the media example still
grants only the approved-derivative bucket.

At the Phase B checkpoint, Wrangler `4.126.0` compiled both Workers with the
then-intended binding split. The
focused administration suite passes the authentication matrix, single-owner
configuration, browser/service separation, CSRF/session/origin controls,
synthetic-only D1 write, secret-leak checks, delivery methods and byte ranges,
hostile object metadata, object-version consistency, binding isolation, inert
configuration, and in-memory migration guards. Those migration checks cover
initial-state and replacement bypasses, active-consent and derivative revision
binding, pending-exclusion state/tag/derivative blocks, unique private object
ownership, and evidence-gated retention cascades. Caller expected-version
compare-and-swap, its transition receipt, and its audit event must still be
coupled atomically by the later state-changing service; the migration alone
does not claim that caller-level guarantee. The public manifests remain empty
and the Phase A tagging, consent, metadata-stripping, whole-item suppression,
and host-first takedown contracts are unchanged.

Final validation after the conflict-path hardening passed `pnpm test`, including
repository safety, vendored libraries, both-mode CSV and Gallery validation,
all upload/media/admin contract suites, artifact isolation, and Family and
Everyone browser checks at desktop and mobile sizes. Both Workers also compile
with Wrangler `4.126.0` in dry-run mode with the exact D1-only and approved-R2-
only binding inventories. An independent read-only security replay confirmed
that draft, derivative, publication, audit, and retention `INSERT OR REPLACE`
and `UPDATE OR REPLACE` attempts fail without deleting or changing the existing
evidence, and found no remaining local Phase B blocker.

External Phase B provisioning is complete within the approved boundary.
Wrangler is
authenticated through an ignored local credential with only user/account read,
Workers write, Worker-scripts write, and D1 write scopes; unrelated Pages, DNS,
AI, email, queue, and other product permissions were not granted. The
`family-running-gallery-dev` D1 database was created in Cloudflare's automatic
ENAM region, the reviewed migration applied successfully, and remote checks
found the expected 11 schema tables, 43 triggers, zero Gallery drafts, and zero
synthetic records.

Zero Trust Free and account MFA are active. R2 Standard is enabled with separate
empty originals, staging, and approved-derivative buckets; direct R2 development
URLs and custom domains are disabled. A $5 account-email budget alert is active.
The D1-only administration Worker and approved-R2-only media Worker are deployed
only on isolated `workers.dev` hostnames. The administration Worker is protected
for all production and preview traffic by the exact owner policy; the reusable
owner policy carries the approved 30-minute session duration even though the
application UI retains its one-hour-or-longer duration control.

Remote authentication checks prove that anonymous access is denied, the owner
can reach the private administration shell, and a temporary exact Service Auth
credential could reach only `/api/service/health`, not a browser route. A wrong
credential was denied. The temporary credential, reusable service policy,
application assignment, and Worker automation allowlist secret were then
deleted; the revoked credential remains denied and the owner route still works.
The media Worker returned `404` for its root, queries, and nonexistent immutable
objects, and returned `405` for writes. All buckets remain empty and private.

The service-token rehearsal exposed one current Worker-level Access detail:
`ctx.access.getIdentity()` resolves to `undefined` for Service Auth while Access
still supplies its validated audience and injected signed application assertion.
The Worker therefore uses `ctx.access` as the validation boundary, accepts only
the strict documented service-token claim shape, requires its audience to equal
the Access context audience, and repeats the exact Client ID allowlist check.
Malformed, browser, wrong-audience, wrong-identity, and non-service shapes fail
closed. The response-only redacted probes used to establish that contract were
removed before the final deployment.

Final validation after remote cleanup passes the complete `pnpm test` suite:
repository safety, vendored libraries, both-mode CSV and Gallery validation,
upload/media/admin contracts, workflow regressions, the 114-file public artifact,
and desktop/mobile browser smoke tests. The public manifests remain empty.

Phase C is now implemented and verified locally, but has not been deployed.
The owner page is served as separate same-origin HTML, CSS, and JavaScript under
the existing Access boundary. It has no file picker and accepts only its
built-in synthetic photo or video fixtures. It has no destination selector.
The exact `?site=family` or `?site=everyone` area from which it is opened is
shown as a fixed label and supplies the only catalog the page may request. Race
runners are shown first, every tag remains a public athlete ID, and each draft
binds exactly that one area plus the export bundle, source revision, suppression
revision, item revision, and consent revision used to validate it. The signed
browser session, server routes, draft queries, and D1 guards all enforce the
same area, so a body field or draft identifier cannot redirect an upload into
the other manifest.

The owner workflow now captures editorial fields, public-use consent, the
minor/guardian decision, and an optional private evidence reference. The
evidence reference remains in access-controlled D1 and is never returned to the
browser or audit log. Draft creation, editing, upload initiation, completion,
and moderation use compare-and-swap versions, immutable idempotency receipts,
and append-only hashed audit evidence. Approval rechecks the current catalog,
consent, checked-in suppression document, and unresolved athlete-wide exclusion
records. The checked-in suppression list is empty today, so exact static-list
suppression remains exercised by the provider-independent contract suite while
the end-to-end Worker suite exercises pending exclusion and non-current athlete
fail-closed paths.

Migration `0002_private_uploads.sql` adds the private multipart session, part,
and mutation-receipt ledgers without exposing provider identifiers. The browser
uploads sequential 5 MiB parts with a client chunk digest. The Worker checks the
part bytes, signature, extension and MIME agreement, then streams the completed
private R2 object through a server-side whole-file SHA-256 before allowing
`private-review`. The multipart ETag is never treated as that checksum.
Protected previews require the signed owner session and use version-bound
`GET`, `HEAD`, and single-range reads. An internal hourly scheduled handler
expires incomplete sessions after 24 hours only after abort and object-absence
evidence; the external R2 lifecycle fallback is deliberately not configured
without a separate deployment approval.

The Phase C synthetic integration suite uses the actual administration router,
both real migrations in in-memory SQLite, and a deterministic fake private R2
multipart store. It proves consent and guardian gates, current tag validation,
stale and pending-exclusion blocks, inherited-area isolation, rejection of a
forged destination or cross-area draft ID, two-part interruption/resume,
out-of-order and concurrent writes, checksum/size/signature failures, exact
idempotent retries, protected ranges, moderation transitions, 25-hour cleanup,
private-identifier redaction, empty public manifests, and public-artifact
exclusion.
That rehearsal found and fixed two integration defects: generated site catalogs
were initially read at the wrong object level, and exact upload-initiation
retries were initially checked after the draft version had advanced.

The final `pnpm test` passes, including the fresh catalog check, combined
70-trigger schema boundary suite, Phase C integration suite, responsive
area-locked owner page in Family and Everyone at 1440 x 900 and 390 x 844, the
114-file public artifact, and Family and Everyone desktop/mobile browser smoke
tests. A Wrangler `4.126.0` dry run also
compiles the Phase C admin Worker with exactly `DB` and `PRIVATE_ORIGINALS`—no
staging or approved-public binding. Both public Gallery manifests remain empty.
No private original, real media, derivative, public URL, or manifest item was
created in Phase C. Pull Request #76 contains code and documentation only; no
DNS change, merge, deployment, or publication was performed.
The four refreshed owner-page screenshots were reviewed: each shows only its
fixed Family or Everyone area label and no destination control. Independent
review also found and closed a lower-level rerouting gap: D1 now rejects changing
an existing draft from either valid area to the other, and the integration suite
proves every cross-area upload/part/completion request returns before R2 access.

Pull Request #76's conflict resolution integrated `origin/main` at `ec04684`
into the feature branch. The only textual conflict was this active-work history;
the Gallery upload task remains current, while the completed 72-file export and
exact-bundle verification work from `main` is preserved below as previous work.
The owner catalog was regenerated against export bundle
`20260827T022723137Z-5564E17F` (12 Family athletes and 24 Everyone athletes).
Two independent read-only merge audits found no lost Gallery or workbook-
verification contract. Focused Gallery, catalog, upload, deployment-verifier,
production-data, updater, artifact, and browser checks passed, followed by the
complete `pnpm test`: 203 tracked files passed repository safety and the exact
114-file public artifact passed its isolation and browser tests. Refreshed
Family and Everyone owner and public screenshots were visually reviewed at
desktop and mobile sizes. Wrangler `4.126.0` also compiled the merged admin and
media Workers in dry-run mode with the intended isolated bindings. This resolves
the feature branch only; Pull Request #76 has not been merged to `main`, and
nothing was deployed or published.

### Handoff

- Phase C is complete locally and synthetic-only. The next step requires a new
  explicit approval: apply migration `0002` to non-production D1, add only the
  originals binding and hourly schedule to the ignored admin configuration,
  configure the 24-hour incomplete-multipart lifecycle fallback, deploy the
  reviewed admin Worker, and rehearse one synthetic photo and one synthetic
  video remotely through Access.
- The currently deployed administration Worker remains the verified Phase B
  D1-only version. All three R2 buckets and public manifests remain empty.
- Do not use real family media until synthetic photo, video, metadata-stripping,
  failure, cleanup, and takedown rehearsals pass.
- Phase D processing, sanitized derivatives, GitHub Apps/environments, and a
  manifest Pull Request have not begun. The existing approval does not permit
  real media,
  DNS changes, public media derivatives, Pull Requests, merges, or production
  publication.

## Previous task: exact-bundle post-MERGE verification and cleanup portability

### Status — 27 August 2026

The first routine update stopped safely during workbook pre-export coverage.
The repository and workbook contract signatures matched, and the staging-path
advice in the PowerShell error was only generic wrapper text. John identified
the actual workbook-owned coverage issue: the new participant did not yet have
the required `ProfileStatus` value of exactly `Active` or `Inactive`. John
corrected that source value; Codex did not inspect or modify the private
workbook.

After the participant status was corrected, fresh staged export
`test-artifacts/workbook-export-staging/run-20260826-222720-476` passed the
72-file staged-bundle validator. John reviewed and approved promotion of its 11
meaningful CSV differences. The resulting data Pull Request #74 merged as
`f8529c981138be81ccfb223146ce38b84f2c62a3`; GitHub Pages run `33035787966`
succeeded, and the production manifest plus both mode-specific `siteinfo.csv`
files were manually confirmed at bundle
`20260827T022723137Z-5564E17F`. Primary `main` is clean and current, and no
saved routine-update state or `data/refresh-*` branch remains.

The failed-preparation cleanup had also exposed a repository bug. The updater
restored `main` correctly but tried to delete the unchanged temporary branch
with `git update-ref --delete`; `update-ref` supports only `-d` for its direct
delete form. The repair on `codex/data-update-cleanup-repair` now uses
`git update-ref -d <ref> <expected-old-oid>`, preserving the existing atomic
compare-and-swap guard. A behavioral regression proves that an unchanged ref is
removed while a ref that moved to another commit is retained.

That same code branch now adds the missing automatic proof requested after
`MERGE`. The updater saves `merged` separately from `production-verified`, waits
for the `Deploy to GitHub Pages` run tied to the exact merge SHA, and retains the
run identity for safe resume. It then reads the expected files from the exact
reviewed data commit, polls the custom domain with cache revalidation, and
requires the manifest plus every one of its 71 listed CSVs to match byte-for-byte.
A real Chromium session finally opens both Family and Everyone, checks the
correct titles and mode labels, requires rendered leaderboard rows, and rejects
cross-mode, failed, stale, or mixed-bundle CSV requests. Cleanup is refused
until all of that passes. A failure keeps the branch, staged export, promotion
backup, and state; `--resume` retries verification and cannot merge again.

Final validation passed on 27 August 2026. The complete `pnpm test` suite passed
repository safety, vendored-library checks, both-mode CSV and Gallery
validation, age-grade and Gallery contracts, analytics and release-path
regressions, the real-Git local and bare-remote compare-and-swap cleanup tests,
exact Pages-run polling, the full 72-file production verifier, export-bundle and
staged-workflow suites, reconciliation, preview-artifact safety, the 114-file
preview build, and both-mode desktop/mobile browser smoke and screenshot
checks. Representative Family and Everyone desktop/mobile championship,
Overview, News, and Gallery screenshots were visually inspected with no layout
or content regression found. A separate read-only production run also matched
all 72 CSVs from exact commit `f8529c9`, rendered both live modes, and confirmed
Pages run `33035787966`; syntax and `git diff --check` passed.

### Handoff

- The production data refresh is complete; do not export or promote it again.
- The cleanup repair and post-merge verifier were merged into `main` through
  Pull Request #75 as commit `ec04684` on 27 August 2026. Do not repeat the
  completed production data refresh while reviewing later code changes.
- The original failed run has no resumable state. Its empty local branch was
  verified against the recorded `main` commit and removed with the fixed
  compare-and-swap command.

## Prior task: canonical workbook and guided data-updater contract repair

### Status — 25 August 2026

The routine updater failed safely after Pull Request #70 merged to `main` because
the repository required the 72-file, 64-column Official Results News contract
while its default `CODEX WORKING COPY.xlsm` still contained the valid pre-News
70-file exporter. The News implementation had been developed in a separate
feature draft and had never been reconciled back into the stable workbook path.
The failed run promoted no data, saved no resumable updater state, made no commit
or push, and left only an empty refresh branch plus its ignored staged output.
The empty branch was verified at the same commit as `origin/main` and removed.

John explicitly authorized private-workbook inspection and repair. Before any
change, the working copy and News draft were copied and SHA-256 verified:

- working-copy backup:
  `C:\GitHub\_private_workbooks\backups\Family Age Grading Table v2.0 CLEAN RESTORE 20260616 CODEX BACKUP BEFORE DATA UPDATE REPAIR WORKING COPY 20260825-084048.xlsm`,
  SHA-256 `3FF022831704B01259B54F75969785F503337031C3C83F73E9A271AA2B8A3A90`;
- News-draft backup:
  `C:\GitHub\_private_workbooks\backups\Family Age Grading Table v2.0 CLEAN RESTORE 20260616 CODEX BACKUP BEFORE DATA UPDATE REPAIR NEWS DRAFT 20260825-084048.xlsm`,
  SHA-256 `B123E27299879A937AA9BD9ED4F3F62A25886438BA3B5DEEEBEDDF75B7AF6ECC`.

The current working copy had 183 race-result rows and 23 participants, versus
171 and 22 in the feature draft. The verified 64-column `OfficialNewsExport`
module and its 20-line automation integration were therefore ported into a copy
of the newer working workbook; the older whole draft was not substituted and no
result data was discarded. A full export from that candidate passed staged CSV
and bundle validation for all 72 public CSVs. The repaired canonical working
copy also exposes a side-effect-free export-contract query coupled to the
repository's path-and-header fingerprint. Its current SHA-256 is
`1D6AAB753E9BD7B0FAB7CC1DC2721EB9A4CD9B6BB8578460C3AFD570A852BCEE`;
the repaired pre-marker copy remains backed up with SHA-256
`220D71CFC5463E6410AE3566DF44F64D7C098D9943EEC916689B35B464E1F129`.

Repository hardening is implemented locally on
`codex/data-update-workbook-repair`. Before creating a data branch, the updater
now opens the selected workbook read-only and requires the tracked contract ID
plus schema fingerprint. A missing or stale marker fails with a targeted
pre-News explanation and creates neither a staged run nor a refresh branch. The
full export repeats the check, and any later pre-state preparation failure
restores the original Git position only while its recorded ref is unchanged,
then compare-and-swap deletes only the exact unchanged temporary branch. The
exact staged file/header/content validators remain authoritative.

Final candidate export
`test-artifacts/workbook-export-staging/run-20260825-085938-959` passed the
72-file validator with 43 Family and 75 Everyone News milestones. Reconciliation
found 18 meaningful public CSV differences arising from the newer workbook data,
including 12 additional shared result rows. Those data changes have not been
promoted or published and still require the updater's normal review and explicit
approvals after this code repair follows the standard Pull Request path.

Final repository validation passed on 25 August 2026. The complete `pnpm test`
suite passed repository safety, vendored-library checks, both-mode CSV and
Gallery validation, age-grade and Gallery contracts, analytics and release-path
regressions, the export-bundle and staged-workflow suites, reconciliation,
preview-artifact safety, the 114-file preview build, and both-mode desktop/mobile
browser smoke and screenshot checks. `git diff --check` also passed apart from
Git's expected LF-to-CRLF working-copy notices.

### Handoff

- Do not replace the canonical workbook with the dated News draft; it lacks the
  newer result and participant rows.
- Do not use `--resume` for the failed 25 August run; no state was saved.
- Do not promote the retained staged export as part of this code repair. Start a
  fresh routine update after the updater repair is reviewed and merged.

## Prior task: workbook-owned News medal positions, displaced holders, and ranked-athlete counts

### Status — 24 August 2026

The ranked-athlete-count follow-up was implemented and promoted locally on
`codex/news-medal-position-labels`, then merged to `main` through Pull Request
#70 on 24 August 2026. This historical section records the pre-merge evidence.
It followed the News baseline from Pull Request #68 and preserved the Gallery
work already on `main`.

The private News draft workbook was backed up before this authorized change.
The untouched backup is
`C:\GitHub\_private_workbooks\backups\Family Age Grading Table v2.0 CLEAN RESTORE 20260616 CODEX BACKUP BEFORE NEWS MEDAL SNAPSHOTS 20260824-124900.xlsm`
with SHA-256
`EC88F72559AF66CC877AAFCCD11A2A496178457EEFFB3EF0D3031276DA5EB0A5`.
The workbook exporter now writes eight additional, workbook-owned snapshot
fields: `MedalBefore` and `MedalAfter` for Current/All-Time and
Distance/Overall. The existing four `MedalEntry` fields remain exclusively
about entering a medal position.

Before the follow-up displaced-holder export change, the draft workbook was
backed up again at
`C:\GitHub\_private_workbooks\backups\Family Age Grading Table v2.0 CLEAN RESTORE 20260616 CODEX BACKUP BEFORE NEWS MEDAL DISPLACEMENT 20260824-142249.xlsm`
with SHA-256
`077EC7E0F375F34F0ADEB2C903FF7B9B986D362CD5C6CA326368C86DA40AC849`.

The prior displaced-holder extension made the exact News schema 60 columns. The
ranked-athlete-count follow-up extends its candidate schema to 64 columns by
adding `CurrentDistanceRankedAthleteCountAfter`,
`CurrentOverallRankedAthleteCountAfter`,
`AllTimeDistanceRankedAthleteCountAfter`, and
`AllTimeOverallRankedAthleteCountAfter` immediately after their corresponding
`RankAfter` fields. Each is the workbook's post-result count of distinct
eligible athletes in that precise ranked table; it is never a raw-result count,
roster count, maximum rank, or browser calculation. It must be positive and at
least the exported after-rank. Dedicated 1 Mile distance contexts remain blank,
while their Overall contexts are populated.

Before the authorized count extension, the updated private News draft workbook
was backed up at
`C:\GitHub\_private_workbooks\backups\Family Age Grading Table v2.0 CLEAN RESTORE 20260616 CODEX BACKUP BEFORE NEWS RANKED ATHLETE COUNTS 20260824-152830.xlsm`
with SHA-256
`C2BDFA9104A1A7DFEAD6A1998331C3335AC9FA808668C3D5FF821CA905CD5562`.

The browser never derives a medal from a rank: it shows an exported transition
such as `Silver → Gold` only when both snapshot fields are valid. A snapshot
transition remains neutral; only an exported `MedalEntry` can create the
established `Medal breakthrough!` callout, card accent, and `New … medal
position` badge. Invalid or partial snapshots render nothing. The page
announces the visual arrow as `to` for assistive technology.

Each Current/All-Time and Distance/Overall context now also has four
workbook-owned displaced-holder fields: an athlete ID, athlete name, prior
medal, and resulting medal. A complete quartet identifies the former holder of
the medal just claimed by the News athlete and can express only
`Gold → Silver`, `Silver → Bronze`, or `Bronze → No medal`. The exporter
leaves the entire quartet blank when no unique actual handoff exists. The
browser displays only a complete valid quartet, links the exported athlete ID
while preserving the selected mode, and does not fetch Gallery suppression data
or infer a holder from rank. Its compact visible phrasing is now simply
`Gold taken from David Graham-Kevan`; it deliberately omits the former holder's
resulting status.

The fresh full 64-column staged export is retained at
`test-artifacts/workbook-export-staging/run-20260824-155838-506` and passed
staged-bundle validation for all 72 public CSVs. Reconciliation found exactly
the intended two meaningful changes—Family and Everyone
`official_result_news.csv`—with every other exported file unchanged. Carolyn
Kevan's 26 August 2017 Family record now exports `#2 to #1 / 5` for All-Time
Distance and `#2 to #1 / 6` for All-Time Overall, attributed compactly as Gold
taken from David Graham-Kevan.

John approved promotion on 24 August 2026. The promotion revalidated the staged
candidate and atomically replaced tracked `data/`; the prior tracked bundle is
retained locally at
`test-artifacts/workbook-export-promotion/20260824204022069/previous-data`.
The complete `pnpm test` suite then passed against the promoted data, including
repository safety, vendored libraries, CSV and Gallery validation, News/export
and staged-workflow regressions, preview-artifact safety and build, plus both
desktop and mobile browser smoke/screenshot checks.

### Handoff

- The complete 64-column bundle has been promoted atomically; do not selectively
  overwrite individual data files.
- Pull Request #70 merged this follow-up on 24 August 2026. Production state is
  recorded separately from this historical implementation handoff.

## Historical record: Official Results News first draft

### Original task title

Official Results News medal-position breakthroughs.

### Historical status

Implemented locally on 23 August 2026 on `codex/news-official-results` in the
isolated worktree
`C:\GitHub\family-running\test-artifacts\worktrees\news-official-results`.
The branch originally diverged from `main` immediately before the Gallery work.
Current `main` at `f4e0305`, including merged Pull Request #69, is now integrated
locally so this branch inherits the complete Gallery production baseline.

The static News page loads only
`data/<selected-site>/official_result_news.csv`, preserves `?site=`, renders the
workbook's exported order, improvements, and before/after Current and All-Time
distance/Overall positions, and performs no PB or ranking calculation. The
repository validator requires the exact 36-column export, both mode-specific
manifest paths, the complete Official leaderboard matrix, source agreement,
milestone chains, rank-field arithmetic, 1 Mile's Overall-only movement, and
genuine source-time precision through milliseconds. Four workbook-owned
`MedalEntry` fields align with the four rank contexts and tell the browser when
a result crossed from unranked or Rank 4+ into Gold, Silver, or Bronze. The
browser does not derive that meaning from the rank numbers.

John approved the next presentation refinement on 23 August 2026: optional
athlete, year, and distance filters plus a latest-first initial batch with a
`Show older` control. The controls operate only on the already loaded selected-
site News rows. The page starts with the 12 newest matches; each filter change
resets the view to the 12 newest matching entries, and `Show older` reveals the
next 12 without changing their exported order. `Reset filters` clears all three
controls and restores the first 12 newest entries. Filter choices, the `Showing
X of Y milestones` summary, and progressive reveal are browser presentation
only: they do not select milestones, compare results, recalculate improvements
or ranks, or require a workbook/data-schema change. The implementation is
complete. The full `pnpm test` suite passes, including long filtered histories,
filter-reset batching, combined no-match, header-only/error, both-mode desktop
and mobile, and overflow coverage. Real-data review confirmed the Everyone
5 km history moves from 12 of 43 to 24 of 43 after one reveal, and the mobile
controls render without overflow or browser warnings/errors.

John approved a second presentation-only refinement on 23 August 2026 to make
each milestone substantially more compact. At desktop widths, each card leads
left to right from Result, through the exported PB improvement or first-result
baseline, to the exported Championship movement, with decorative arrows
guiding the eye between stages and down the feed. Mobile keeps the same content
and reading order in a compact vertical flow. This changes no workbook logic,
CSV schema, milestone selection, calculation, value, or rank. The refinement is
implemented and the full `pnpm test` suite passes. Browser smoke coverage passed
for both modes at 1440 x 900, a 720px intermediate-width probe, and 390 x 844;
responsive screenshots were reviewed with no overflow. Representative
real-data cards remain within the tested 320px desktop and 850px mobile height
ceilings. The visible history is about 55% shorter on desktop and 37% shorter
on mobile than the preceding layout.

John requested a further refinement on 23 August 2026 to make entry into a
medal-winning position stand out. The settled contract adds
`CurrentDistanceMedalEntry`, `CurrentOverallMedalEntry`,
`AllTimeDistanceMedalEntry`, and `AllTimeOverallMedalEntry`, each blank or one
of `Gold`, `Silver`, and `Bronze`. A field is populated only when that context's
workbook-owned before rank is blank or at least 4 and its after rank is 1, 2,
or 3. Movement within the existing medal positions is not a new entry. Each
context is independent, tied competition ranks use their exported rank
directly, and 1 Mile's distance fields remain blank. The local page uses only
those exported values to add an explicit `Medal breakthrough!` callout, a
celebratory card accent, and a labelled medal badge on every affected movement
row; colour and decorative icons are not the only indication.

The 36-column repository validator and focused export-bundle regression
fixtures are implemented. Syntax checks and `pnpm run test:export-bundle`
pass, including Gold, Silver, Bronze, multi-context, tied-rank, within-podium,
missing, wrong, extraneous, unsupported, 1 Mile, and cross-mode cases. The
backed-up News draft workbook produced staged 72-file export
`test-artifacts/workbook-export-staging/run-20260823-195159-167-medal`, which
passed the updated validator. Reconciliation found only the two News CSVs
meaningfully changed; every prior News fact, rank, and delta remained identical.
The bundle was promoted atomically, with the previous tracked data retained at
`test-artifacts/workbook-export-promotion/20260823235713853`, and tracked-data
validation passes. It exports 24 Family cards carrying at least one medal
entry, across 59 contexts, and 34 such Everyone cards across 77 contexts. The
complete `pnpm test` suite now passes. The preview artifact contains 114 files,
and browser smoke coverage passes in both modes at 1440px, the 720px
intermediate probe, and 390px mobile. Responsive screenshots were refreshed and
manually reviewed: the medal callout and per-context badges are readable,
contained within their cards, and introduce no horizontal overflow. Commit
`2b28907` is pushed to Pull Request #68 and all remote checks are green. The
refreshed Deploy Preview at
`https://deploy-preview-68--thunderous-moxie-c5aac5.netlify.app/news.html`
shows `Updated 23 Aug 2026 7:52 PM`. Remote DOM verification found the Family
initial batch contains 5 medal cards and 10 medal badges, while Everyone
contains 2 cards and 4 badges. Both modes have the correct selected-mode title
and links and no horizontal overflow.

The earlier remote preview predated Pull Request #69 and was not review evidence
for the combined site. The merge from `main` resolved four additive
conflict files while retaining both features; Gallery runtime files remain
byte-for-byte inherited from `main`, and the diff against `main` contains News
rather than deletions of Gallery. The first combined browser run exposed the
longer athlete Back to Championships navigation wrapping to a second desktop
row. A narrow athlete-only desktop rule now keeps all eight links on one row and
reduced the measured header from 223.6px to 177.6px.

The private source workbook was copied and hash-verified before inspection. The
unchanged backup is
`C:\GitHub\_private_workbooks\backups\Family Age Grading Table v2.0 CLEAN RESTORE 20260616 CODEX BACKUP BEFORE OFFICIAL NEWS 20260823-163247.xlsm`
with SHA-256
`4B1D11EA6946F0A8A58691B767610CA417D12DE7BAC5F0C9EAD43B368C439AB9`.
All News changes were made in the separate draft
`C:\GitHub\_private_workbooks\Family Age Grading Table v2.0 CLEAN RESTORE 20260616 CODEX OFFICIAL NEWS DRAFT 20260823-164900.xlsm`;
the named working copy was not modified. The draft replay agrees with all 24
final Official leaderboard exports and produced 43 Family milestones and 64
Everyone milestones.

A hardened replacement 72-file workbook export succeeded at
`test-artifacts/workbook-export-staging/run-20260823-173218-385`. Its staged
bundle and CSV validation passed. Reconciliation found every existing CSV
semantically unchanged; the only meaningful differences are the two new News
CSVs and the two new rows in `data/export_manifest.csv`. Exact fixed-decimal
age-grade validation, millisecond time comparison, duplicate public-source
detection, and Family-to-Everyone source agreement are covered by the passing
59-case export-bundle regression suite. Repository safety, vendored-library and
syntax checks, focused frontend rendering, preview-artifact publication, and
both-mode desktop/mobile browser coverage have passed. The four responsive
screenshots were reviewed with no overflow or presentation defect found.

John approved promotion on 23 August 2026. The validated bundle is now the
tracked 72-file `data/` contract. The previous tracked data is retained in the
ignored recovery folder
`test-artifacts/workbook-export-promotion/20260823215439556/previous-data`.
The complete `pnpm test` suite passes against the promoted data: repository,
vendor, CSV, 59 export-bundle regressions, staged workflow, reconciliation,
artifact safety/build, and both-mode browser checks. The final artifact contains
114 files. A separate real-data visual check rendered all 43 Family and 64
Everyone entries with no mobile overflow or browser warning/error. The first
draft, filters, and compact presentation are on Pull Request #68 and passed
their pre-medal preview checks. The medal-position extension is local work
with its refreshed export promoted and its complete local suite and responsive
review passing. After the Gallery integration, the complete `pnpm test` suite
passed repository safety, vendor, CSV, Gallery validation and contract tests,
News regressions, staged-export and reconciliation checks, artifact safety, the
114-file build, and browser smoke coverage for both modes at desktop and mobile.
Refreshed News and Gallery screenshots were reviewed without overflow or layout
regression. Merge commit `65190fe` is pushed to Pull Request #68. GitHub reports
the PR clean and mergeable; the required `Test static site` check and the
combined Netlify Deploy Preview both passed on that commit. Nothing from Pull
Request #68 has been merged, published, or released.

## Prior work: owner-curated photo and video gallery, Phase 1

### Status

Completed locally on 23 August 2026 on
`codex/curated-gallery-phase-1`. The site now has a mode-preserving Gallery
page with photo/video filters, responsive media cards, an accessible native
viewer, deliberate empty and unavailable states, and featured Race moments
panels on the landing, Championships, Overview, and athlete pages. The two
mode-specific manifests are intentionally empty until approved media is ready;
no private family photos or videos were invented, copied into Git, or
published.

Gallery media is owner-curated and hosted outside Git. The repository contains
only mode-specific metadata in `gallery-data/family.json` and
`gallery-data/everyone.json`; the preview artifact contract permits exactly
those two JSON files and rejects a stray media file. Every entry is validated
against the public result data and public athlete roster for its site mode.
The public schema records race date, event, distance, and tagged athlete IDs,
so a future authenticated uploader can first choose a date, then choose one of
the exported event-and-distance races on that date, then tag people from the
relevant site roster. Actual file transfer, authentication, consent capture,
and moderation remain deliberately out of Phase 1 until a storage and access
model is selected; no non-functional upload control is exposed on the public
site. Captions are public manifest fields. Geotags and embedded device metadata
remain private media-repository metadata; public derivatives strip them and the
public manifest has no geotag field.

The shared owner-maintained `gallery-data/hidden-athlete-ids.json` list now
provides a person-tag opt-out. Adding one public athlete ID suppresses every
tagged item from the Gallery, featured Race moments, and athlete profiles in
both modes before the browser creates a media element, so hidden media is not
requested during page rendering. The gallery fails closed if the list is
missing or malformed. The file contains IDs only, never names or request
reasons, and its public-static limitation is documented: complete takedown also
requires removing the file from the external media host.

Every non-vacant Current and All-Time championship table now has a photo podium
made from its first three workbook-exported ranked rows. Overall and every
distance dropdown retain the original Current-then-All-Time order, and each
full table remains directly below its podium with every original column and row
still present. The exported rank supplies matching medals in the card and the
table. Category badges display only their first word while preserving the full
exported value as an accessible label, and time/pace values use one consistent
line break. Mobile keeps all three podium cards in one compact row instead of
stacking them into a long page.

Approved athlete-tagged gallery media decorates the corresponding podium card;
manifest order remains the editorial choice, with a photograph preferred over
a video poster. Suppression is applied first, and a missing, suppressed, or
unavailable image leaves a branded initials fallback without changing the
ranking. Vacant and no-result exports keep their valid tables without inventing
a podium.

Final `pnpm test` passed repository safety, vendored-library checks, CSV
validation for both modes, gallery manifest and race/tag association checks,
gallery contract regressions, the age-grade contract, analytics and release
workflow regressions, export workflow regressions, preview-artifact safety and
build checks, the 109-file preview artifact, and browser smoke tests. Browser
coverage includes Gallery and championship podiums in both modes at 1440 x 900
and 390 x 844, synthetic populated photo and video states, category and
time/pace presentation, matching podium/table medals, opened distance groups,
filtering, escaped hostile captions, viewer focus restoration, featured
moments, athlete associations, global person-tag suppression without
hidden-media requests, invalid-manifest and invalid-suppression fail-closed
behavior, and mode isolation. Empty/fallback and populated desktop/mobile
Championship and Gallery screenshots were reviewed; no horizontal overflow was
found and the mobile podium remained a compact three-column row.

Excel and the private workbook were not inspected or changed. Pull Request #69
merged into `main` as `f4e0305`, and its GitHub Pages deployment succeeded. The
Gallery UI, manifests, suppression contract, featured moments, and championship
podiums are therefore the production baseline inherited by later work. The two
mode-specific manifests remain intentionally empty until approved external
media hosting and real media entries are supplied.

## Prior work: header refinement, Head-to-Head rename, and workbook-locked age-grade calculator

### Task title

Header refinement, Head-to-Head rename, and workbook-locked age-grade calculator.

### Status

Completed locally on 23 August 2026 on `codex/header-layout`. The shared header
places Updated at the top right, groups navigation at the left, aligns Pace at
the far right, and removes the redundant Family/Everyone button. On athlete
pages, Championships becomes the mode-preserving Back to Championships link;
the obsolete championship-type strip is removed and the compact athlete banner
puts Athlete Profile and the athlete name on one line. The desktop header is
176px tall, down from 269px, and the athlete banner is 86px, down from 185px.
Mobile uses two navigation buttons per row, keeps Updated above them, and has no
horizontal overflow.

The former Calculator navigation item and `calculator.html` are now Head to
Head. A distinct Calculator item opens `age-grade-calculator.html`, where an
athlete selects their name and distance and enters one paste-friendly duration.
The field accepts `MM:SS`, `H:MM:SS`, compact digits such as `2430`, and longer
compact times such as `14530` or `14530.5`; the optional decimal is retained as
tenths of a second. It normalizes on blur and updates the percentage as soon as
the duration is valid.

Excel remains the calculation master. The private working workbook was backed
up before modification at
`C:\GitHub\_private_workbooks\backups\Family Age Grading Table v2.0 CLEAN RESTORE 20260616 CODEX BACKUP BEFORE AGE GRADE CALCULATOR 20260823-092353.xlsm`.
The source and backup both had SHA-256
`663D41FDA2DB3EC761E2EDFECC58897F2DB5D2C8C23B69360DCDBCA43B8D9CAE`.
The workbook exporter now verifies the live `RaceResults` formula and display
format, checks calculated results against it, and exports full-precision
age-graded standards plus a formula signature, version, and conformance value.
The browser performs only the final exported-standard/time division and refuses
to enable the calculator if any contract value differs. Final workbook
verification found zero formula errors, all calculator module markers present,
and SHA-256 `4B1D11EA6946F0A8A58691B767610CA417D12DE7BAC5F0C9EAD43B368C439AB9`.

The complete workbook export produced bundle
`20260823T134439531Z-0EFF6180`: 70 public CSV files, including 60 Family and 110
Everyone calculator rows. Staged validation passed before promotion. Human
review confirmed that the only non-calculator reconciliation differences were
row order in `athlete_results.csv` and corresponding internal `SourceRow`
numbers in absolute records; visible result and record values did not change.
John separately approved full-bundle promotion. The prior tracked data remains
recoverable at
`test-artifacts/workbook-export-promotion/20260823141116609/previous-data`.

Final `pnpm test` passed repository safety, vendored libraries, both-mode CSV
validation, the Excel/JavaScript contract tests, analytics, release-path and
workflow regressions, export-bundle and staged-workflow regressions,
personal-best reconciliation, preview-artifact safety, the 102-file public
artifact build, and browser smoke tests. Browser coverage includes both modes at
1440 x 900 and 390 x 844, compact time entry, workbook-exact output, invalid
time guidance, and deliberate formula-signature mismatch fail-closed behavior.
Desktop/mobile Calculator and Head-to-Head screenshots were reviewed. Pull
Request #66 was merged into `main` as `aa16b79` and its feature branch was
removed locally and remotely. The automatic GitHub Pages deployment succeeded,
and the production Calculator returned HTTP 200 in both Family and Everyone
modes.

## Prior work: workbook-owned athlete deactivation

John approved the athlete-deactivation requirements and explicitly authorized
inspection and modification of the named private working copy on 21 August
2026. A timestamped backup was created outside the repository and verified
byte-for-byte before any edit. The working copy now implements the approved
contract in worksheet formulas and VBA; the backup remains unchanged.

`ProfileStatus` is a closed `Active`/`Inactive` list. Result eligibility fails
closed, and inactive athletes are excluded before every public leaderboard,
Hall of Fame, record, history, standard, target, comparison, and athlete-profile
export is selected or ranked. Workbook validation now rejects blank or unknown
statuses, incorrect source wiring, and any inactive athlete ID or name found in
the staged CSV tree. No JavaScript change and no public `ProfileStatus` column
are required.

The full authorized workbook export completed with bundle ID
`20260822T013004265Z-1DF86180`. Repository staged-bundle validation passed all
68 public CSV files. The two existing inactive participants had references in
12 tracked public files and have zero references in the staged bundle. The 13
meaningful file differences are the expected Everyone-mode removals,
re-ranking, dependent standards/targets, and manifest row-count updates; every
Family-mode file is unchanged. Workbook visual review found no layout
regression, and the saved validation sheet reports post-export PASS with zero
issues.

The exact validated bundle has been promoted into tracked `data/` on the local
`codex/athlete-deactivation` review branch. The promotion tool retained the
previous tracked data in an ignored recovery folder. The branch is prepared for
Pull Request review, but nothing has been merged, published, or deployed.
Publication remains a separate review and approval step under the workbook
export workflow.

Final repository verification on 21 August 2026: the complete `pnpm test` suite
passed repository safety, vendored libraries, both-mode CSV validation, export
bundle and staged-workflow regressions, preview-artifact safety, the preview
build, and browser smoke tests. The same browser suite then passed against an
ignored preview populated with the staged export when its expected values were
also sourced from that staged bundle. Family and Everyone desktop/mobile
screenshots were reviewed. A focused browser check confirmed that both inactive
athletes' old profile URLs render `Athlete not found` and preserve the selected
site mode. The complete suite, focused profile check, and screenshot review all
passed again after local data promotion.

Everything approved before this requirements task is delivered and merged. #54
settled the personal-best export contract and #55 delivered the reconciliation
harness, both on 14 August 2026; #57 to #60 followed on 15 and 16 August. All of
it is described below, and production was verified on 16 August 2026.

The Ace of Race visual restyle is the one approved item that never shipped: it
was split off, and its Pull Request has since been closed rather than parked.

## Merged on 14 August 2026

### #54 The personal-best export contract

The four open questions in
[Proposed workbook-owned personal-best export](personal-best-export-proposal.md)
were settled, fixing the contract the workbook can be built against. Settling it
is not approval to build it, and the repository work that document lists stays
unapproved until an export exists.

The tie-break outgrew this export and is now stated once in
[Workbook Tie-Break Rules](tie-break-rules.md), because the same chain governs
`athlete_comparison_targets.csv`, the proposed `data/personal_bests.csv`, and
the workbook's overall-crown comparison. Older wins over more recent, reversing
what the comparison contract previously said; ties are compared on the unrounded
age grade first, which is why `AgeGradeExact` is in the schema. No exported row
changes: there is no tie in the current results for any of it to decide.

### #55 The reconciliation harness

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

## Merged on 15 and 16 August 2026

Four Pull Requests landed after #55 and are recorded here so this section is not
stale by omission.

- **#58 Athlete ID format guard.** `scripts/validate-csv.mjs` now requires every
  `AthleteID` in `data/athlete_results.csv` to be lowercase letters and digits
  separated by single hyphens. The workbook annotates participants with status
  markers, and a marker reaching the ID silently renames the athlete without
  anything downstream noticing: every exported table carries the same renamed
  key, so the reference checks resolve and the bundle validates, while
  `athlete.html?id=...` links published earlier stop matching anyone. The guard
  is applied where the ID is minted rather than at each referencing column, and
  reports once per athlete rather than once per result row.
- **#57, #59, and #60 routine data refreshes**, on 15, 15, and 16 August 2026.
  `data/` now carries `ExportBundleID` `20260816T181341410Z-0452E180` with
  `LastUpdatedUTC` of `2026-08-16T18:13:48Z`.

## Production verified on 16 August 2026

The first recorded production check since #43. It covers everything that
deployed in between, including the #52 mode-aware title, which had never been
confirmed live.

- **Both modes load and are correctly named.** Family renders
  "Family Running Championships"; Everyone renders
  "Age-Graded Running Championships" in the tab, the header, and the subtitle.
  That is #52 working: the tab no longer says Family in Everyone mode. Page
  prefixes survive the substitution, as in
  "Hall of Fame | Age-Graded Running Championships". The athlete page is
  correctly excluded and reads "Carolyn Kevan | Athlete Profile".
- **Mode is preserved everywhere checked.** Every navigation link carries
  `?site=everyone`, the athlete back link resolves to `index.html?site=everyone`,
  and the Records page's athlete links carry `?site=family`.
- **Leaderboards, Hall of Fame, Records, and Calculator all render**, with no
  stuck "Loading" text and no error text on any page checked. Records shows Men
  before Women, which is the P2-01 remediation live: the page keeps exported
  order rather than the old browser-side override.
- **The Calculator separates official from unofficial** into labelled sections
  and shows both badges on one row where a single performance sets both
  standards, as the contract describes.
- **The published-content contract holds.** `AGENTS.md`, `package.json`,
  `docs/tie-break-rules.md`, and `scripts/reconcile-personal-bests.mjs` all
  return 404; `data/athlete_results.csv` and `CNAME` return 200.
  `data/personal_bests.csv` returns 404 because it does not exist yet, which is
  the expected state.

## Leaderboard rank-sequence guard, 21 August 2026

Approved by John on 21 August 2026, ahead of any deactivation work. No merge
state is asserted here deliberately: `git log` carries that, and this file has
gone stale before by claiming one.

`validateRankSequence` in `scripts/validate-csv.mjs` requires each enabled
leaderboard to carry a complete standings sequence. It exists because ranks
are positional: deactivating a participant means recalculating the standings
without them, and a workbook that deletes their rows after ranking instead
leaves a hole, 1, 2, 4, 5.

Nothing else here would have noticed. `Rank` was otherwise only checked as a
number, read once to find the Rank 1 champion for the Hall of Fame
cross-check, and read for places 1 to 3 to derive expected medals. A gap
below third place published silently, and a missing place inside the top
three removed a medal from the championship rather than reassigning it,
because the expected medals are derived from those same rows and agree with
the omission.

Standard competition ranking is accepted, so a genuine tie reads as
1, 2, 2, 4 rather than being reported as a gap. Whether the workbook emits
ties at all is its own business; the guard only requires that whatever it
emits is a sequence. Vacant and "No eligible results" rows are skipped
through the existing helpers, and a malformed `Rank` is left to
`validateNumber` rather than reported twice.

Verified by reverting it: with the call commented out, the new
"rank gap left by removing a ranked row" case fails as
"validator unexpectedly passed", which confirms the guard is what catches a
gap and that nothing else did. Measured before writing it: of the 48
leaderboard files across both sites, 41 carry a contiguous 1 to N sequence
and 7 are the single-row "No eligible results" vacant state. No tie exists
in current data.

## Keeping this file honest

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

   **The design is now settled; the export is not built.** John decided the four
   open semantics questions on 13 August 2026: the workbook applies the tie-break
   already written in `docs/athlete-comparison-export-contract.md` rather than
   the browser's accidental date-only behaviour, absent results get no
   placeholder rows, a performance that is both benchmarks exports as two rows,
   and `Period` is carried with `All Time` as its only value. Those are recorded
   under "Settled semantics" in the proposal, along with a divergence found the
   same day: the browser skips the **first** criterion of both documented
   tie-break rules and resolves on date alone, so the two paths differ today in
   rule even though no current key exercises it.

   What remains is a workbook change, and it is John's to start. Settling the
   contract is not approval to build it, and the repository work listed in the
   proposal stays unapproved until an export exists.
5. **`og-image.png` is oversized.** 1200 x 630 is correct, but 984 KB is roughly
   five times heavier than it needs to be. It is published unmodified because it
   is John's artwork. Worth recompressing before the site is shared widely.
6. **Estimated dates of birth are not marked.** The private Participants sheet
   holds a `DOBStatus` column and nothing about it reaches the site, so every age
   grade is presented with identical confidence whether or not the date of birth
   behind it is known. Age grade is computed from age, so an estimate propagates
   into the score, the category, the rank, and the medals that follow. Design
   agreed 16 August 2026 and written up in
   [Proposed workbook-owned DOB status export](dob-status-export-proposal.md).
   **Blocked on the workbook**, and one question is still open there: the exact
   `DOBStatus` vocabulary, which validation has to pin to a closed set.
7. **Athlete deactivation is implemented in the private workbook but not yet
   released.**
   The Participants sheet holds a `ProfileStatus` column. John's decision,
   confirmed as an implementation requirement on 21 August 2026, is that
   deactivation removes every mention of a participant from the current site,
   retroactively and going forward, and publishes no new result of theirs.
   [The approved requirements](athlete-deactivation-requirements.md) replace the
   earlier roadmap proposal. The authorized working copy now excludes inactive
   athletes before recalculating every public output and rejects any inactive
   name or ID in a staged bundle. This needs no website code and no public status
   export. Git-history exposure remains accepted; the scope is display, not
   erasure. The validated export is promoted only on the local review branch;
   the current website remains unchanged until a separately approved data
   release.

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
