# Active Work

## Current task: fixed-origin public-host verification for Gallery takedown

### Status — 30 August 2026

Pull Request #84 merged the photo-promotion and approved-storage-cleanup
foundation to `main` at exact commit
`4b6c7be70d77ce389f7ee9a5b103858cd31ff55b`. The Pages artifact and production
site were then verified against that exact commit: all 114 published files,
including the 72 manifest-listed CSVs, byte-matched; Family and Everyone both
rendered; and both public Gallery manifests remained empty. This proves the
static release only. At that checkpoint, migrations `0007` and `0008`, the
promotion service, the approved-media lifecycle rule, and all public-media
operations remained undeployed.

The next safety slice is implemented and fully locally validated in this source
change, based exactly on that verified `main`.
Migration `0009_public_host_verification.sql` and the accompanying code make
public-host absence a separate, stronger fact than approved-R2 absence. They do
not add a destination selector or change the established inherited-area,
race/date/event/distance, public-athlete-ID tagging, consent/guardian,
metadata-stripping, external-media, storage-key, suppression, or whole-item
exclusion contracts.

Each photo promotion now creates one immutable public generation containing
exactly two targets—`photo-display` and `photo-thumbnail`—bound to the fixed
approved origin, candidate state version, object-key hashes, public-URL hashes,
and expected SHA-256 values. Generations survive approved-storage cleanup so
every URL that may ever have been public remains enumerable until an approved
parent-draft purge. A permanently retired approved-key hash cannot be reused by
a later generation or another draft.

The delivery boundary now has append-only media-delivery epochs. An epoch binds
the exact HTTPS media origin, delivery-contract header, deployed media Worker
version, fixed configuration hash, and one synthetic WebP witness. Only an
explicitly registered and activated next epoch can become current. A new
generation, withdrawal cycle, or delivery-epoch activation invalidates older
host-absence evidence.
The compatibility scalar `host_deletion_confirmed` is reset by migration `0009`
and may become true again only in the same transaction that appends a complete
receipt for the current generation set and current epoch.

The locally modified read-only media Worker still has only `APPROVED_MEDIA`,
plus Cloudflare version metadata. Recognized delivery responses carry the exact
contract and Worker-version headers. A fixed 28-byte synthetic WebP at its
content-addressed witness key is the proof that the public front door reaches
the intended Worker version and approved bucket. Witness responses and all
failure responses are `no-store`; ordinary immutable media retains the existing
short revalidation policy. Missing or malformed delivery proof fails closed.

A fifth, service-only public-host-verifier Worker has D1 and fixed scalar
configuration only—no R2 binding, original, staging, manifest, GitHub, deletion,
or caller-selected host/key route. Its one fixed `POST` route accepts only an
opaque draft ID, expected state version, and idempotency key. The complete
inbound JSON body—not each chunk separately—has one five-second default
deadline, capped at 30 seconds for a test override; a stalled read or stalled
cancellation fails before D1 or public-host fetch. D1, not the caller, derives
the purpose: `withdrawal` only from a current editorial, athlete-exclusion, or
consent-withdrawal intent, and `retention-expiry` only from a rejected or
processing-failed draft with no withdrawal intent and the exact approved
retention tombstone.

Before network checks the verifier reserves every historical approved-key hash.
The permanent reservation lineage is the exact key, promotion, and draft hash.
Its first verification, cycle, idempotency, actor, and time remain immutable
audit facts, while a stronger current intent may invalidate the old receipt and
start a new cycle, and a rotated authorized service identity may recover against
that same lineage. The database still rejects a same-actor fork of one cycle and
reuse of an idempotency key for a different cycle. The verifier then uses
credential-free, no-store/no-cache, redirect-manual `HEAD` and `GET` requests
against only the configured public media origin. An exact witness `HEAD`/`GET`
runs first, then every historical target must return the contract-marked,
current-version, empty-body `404` for `HEAD` and `GET`; the witness is proved
again before a final `HEAD` of every target. A redirect, cached or credentialed
path, generic `404`, wrong binding, wrong witness, changed Worker version,
response body, timeout, or live object cannot become absence evidence.

The final append-only receipt is current only while its D1-derived purpose,
purpose evidence, withdrawal cycle, state version, complete historical
generation/target set, cleanup evidence, fixed origin, and current delivery
epoch still match. A true zero-history draft uses the two witness passes and a
canonical empty set without inventing a URL or reservation; any draft with
historical generations must instead carry exact proof for every retained
target. For a withdrawal-purpose receipt, the legacy
`host_deletion_confirmed` scalar becomes `1` only in the same final transaction.
For a retention-expiry receipt, the successful API still reports
`hostDeletionConfirmed: true` because public-host absence was verified, while
that withdrawal-compatibility scalar deliberately remains `0`; the current
receipt is instead bound to the exact approved retention-tombstone evidence.
Withdrawal and consent withdrawal consume the former. A rejected or
processing-failed retention purge consumes the latter and still requires the
existing private-original deletion and retention-tombstone gates. The permanent
hash-only receipt survives parent-draft purge.

Focused delivery-contract, media-boundary, storage-key, migration, verifier,
combined-bridge, timeout, retention, purge, and security checks pass. The real
SQLite bridge forces the final withdrawal scalar statement to fail, proves the
same transaction rolls back target proof, witness proof, and final receipt while
leaving only the resumable attempt and permanent reservations, then proves the
exact retry commits once. The final post-documentation `pnpm test` passes:
repository safety, vendored dependencies, both-mode CSV and Gallery validation,
every focused Gallery service and migration suite, release/export regressions,
the exact 114-file artifact build, and responsive Family and Everyone browser
smoke tests all pass. Two independent final security reviews report no blocker.
The tracked public manifests and suppression file are unchanged, and no real
media or public candidate has been created.

Pull Request #85 carries this source integration through the standard preview
path because `package.json` is conservatively treated as a publishing-control
file. Its initial no-visual classification was rejected before tests ran, then
corrected without weakening the release gate.

### Non-production D1 migration deployment — 31 August 2026

With separate owner approval for this database step only, forward migrations
`0007_photo_promotion.sql`, `0008_photo_promotion_cleanup.sql`, and
`0009_public_host_verification.sql` were applied in order to the existing
non-production Gallery D1 database from exact merged source commit
`693383ba03380b6e8d846e26fcd79b1cad5059f6`. Before mutation, Wrangler reported
exactly those three files pending after `0001`–`0006`; the database had zero
foreign-key violations and zero legacy true `host_deletion_confirmed` values.
Cloudflare Time Travel recovery bookmarks were captured before and after the
operation without adding them to the repository.

Wrangler reported all three migrations successful and now reports no pending
migrations. Independent remote checks found all 15 expected new tables, six
named indexes, two views, and all 93 distinct migration safety triggers. Every
new promotion, cleanup, delivery-epoch, generation, retirement, proof, and
receipt table remains empty; both receipt views return zero rows; the legacy
host-confirmation scalar remains zero; `PRAGMA foreign_key_check` returns no
rows; and `PRAGMA quick_check` returns `ok`. The database now has 34 tables.
Focused local public-host-migration, full processing-bridge, and promotion-
Worker boundary tests also passed immediately before the remote application.

This approval and deployment changed D1 schema only. It did not deploy or
replace a Worker, upload the synthetic witness, register or activate a delivery
epoch, create Access resources, apply an R2 lifecycle rule, create approved
media, edit a manifest, open a Pull Request, or publish anything. The new
database boundary therefore remains deliberately fail closed: there is no
current delivery epoch and no current public-host-absence receipt.

### Deliberate deployment blockers and handoff

The approved non-production D1 schema step is complete through migration
`0009`. The modified media Worker, its synthetic witness, the verifier Worker,
and delivery-epoch records remain undeployed. The deployed media Worker has not
been replaced or proved with the new version binding; the witness object does
not exist remotely; and no verifier Access application, service identity,
policy, or Worker has been created.

Remote work requires separate approval for each mutation and must use a
reviewed rolling order. The completed first step was applying forward D1
migrations `0007`–`0009`. The next separately approved step is to deploy the
exact media Worker with version metadata; then place and byte-verify only the
fixed synthetic witness in approved R2; register and activate the matching delivery epoch;
create the narrow Access service identity and policy; deploy the fixed verifier;
then run the synthetic fixed-origin absence, wrong-binding, redirect, cache,
credential, epoch-rotation, zero-generation-withdrawal, and purge rehearsal.
The exact live media Worker version ID must be confirmed before its epoch is
activated. Failure at any step remains closed and does not authorize a scalar,
withdrawal, tombstone, purge, promotion, Pull Request, or publication.
Applying the approved-prefix lifecycle rule and deploying or granting Access to
the promotion Worker remain later, separately approved gates after that proof.

The tracked one-day, `media/v1/` incomplete-multipart lifecycle requirement is
only crash containment for an R2 create whose response was permanently lost.
It is not synchronous cleanup evidence and cannot permit a tombstone or purge.
That rule has not been applied or verified remotely. A lost create response
therefore remains in D1 `admitting`, and cleanup continues to fail closed even
after a later provider lifecycle pass.

After the public-host proof is independently validated and remotely rehearsed,
the remaining review-path work is a read-only candidate
retrieval/orchestration boundary and a protected
default-branch workflow accepting only one opaque `draft_id`. It must retrieve
a fresh candidate immediately before repository mutation, recheck the service
state after that mutation, and close or block review after a later consent
withdrawal or athlete exclusion. Creating or
installing the repository-scoped GitHub App, creating the protected environment,
or changing `main` rules remains a separate external approval. Before any App
installation, the remote rules must prove an App token is denied both a direct
`main` update and a Pull Request merge; local absence of a merge API is not by
itself a cryptographic permission boundary. The first remote checkpoint remains
one synthetic photo and an unmerged rehearsal Pull Request. Applying any
Cloudflare migration, changing or deploying a Worker, uploading the witness,
creating Access credentials/policies, or running the remote rehearsal requires
fresh explicit approval. Real family media, video, merge, production
publication, and DNS changes remain out of scope.

## Current task: keep routine data refreshes independent of Gallery changes

### Status — 29 August 2026

A tooling repair is implemented locally on
`codex/data-update-gallery-catalog`, based on current `origin/main` at
`f5a7592502da91b255c0d75c97cbb16578437a98`. A real routine refresh promoted
all 72 validated CSVs successfully but then stopped because the newly tracked
private Gallery catalogue was stale. The workbook export, staged bundle, and
promotion were not at fault: the Gallery catalogue is generated from the export
manifest, shared athlete results, and both age-grade standards files, while the
guided updater still assumed that only the CSV paths could change.

The updater now regenerates that exact catalogue after promotion and before the
full suite. It permits no other Gallery path, includes the generated bytes in
the tested-diff fingerprint, requires the exact 72-CSV-plus-catalogue working
and staged file set, and stages both together. The Pull Request release-path
gate uses the same single generated path, requires it for a lightweight data
refresh, and continues to reject unrelated Gallery, code, schema,
configuration, or workflow changes. The catalogue remains outside the GitHub
Pages artifact and cannot calculate or alter workbook-owned championship data.

Focused updater, release-path, catalogue-generation, repository-safety, and
whitespace checks pass. The complete suite also passes: vendored dependencies,
both-mode CSV and Gallery validation, Gallery media/admin contracts, updater and
release regressions, the 114-file public artifact, and desktop/mobile Chromium
checks for Family and Everyone. Representative Family and Everyone
championship screenshots plus the private Gallery administration desktop and
mobile captures were visually inspected without an apparent layout regression.
The exact repair diff contains 11 tooling, test, policy, and documentation
files; it contains no CSV, public runtime, public Gallery manifest, media, or
generated catalogue change.

After the workbook changed again, the superseded promoted refresh
`data/refresh-20260829-124743` was retired recoverably rather than published.
The prior tracked data was restored byte-for-byte, local `main` is clean, the
saved updater state and exact temporary branch were removed from the active
workflow, and the old promoted data, staged export, promotion artifacts, and
state now remain only under the ignored
`test-artifacts/retired-data-updates/data-refresh-20260829-124743/` quarantine.
No fresh workbook export should start until this tooling repair is integrated;
otherwise it will repeat the same stale-catalogue failure. The repair is now
pushed for standard-path review in Pull Request #81. It has not been merged,
deployed, or published.

### Handoff

This repair changes release tooling and the release-path guard, so it must use
the standard review pathway before a genuinely fresh data refresh starts. Do
not copy the tooling edits into a data branch or weaken the stale-catalogue
test.

## Current task: Netlify skip for changes a static preview cannot show

### Status — 28 August 2026

The no-visual `[skip netlify]` route is ready for review on
`codex/netlify-nonvisual-skip`, based on the latest `origin/main` after Pull
Request #76. The route itself had existed since 10 August, but the Pull Request
template, preview-comment workflow, decision record, and release guide still
described only data-refresh and custom-domain skips. That mismatch caused Pull
Request #75's release-tooling-only change to request an unnecessary Netlify
preview.

The eligibility gate now positively recognizes known non-public areas such as
documentation, tests, local/workbook release tooling, and the separate private
`gallery-admin/` implementation. It rejects every published path, every known
dependency/build/deployment control, local GitHub actions, package-manager
hooks, the release-path guard itself, unknown root configuration, and future
scripts that have not been deliberately classified. Published paths and
publication controls remain tied to the artifact builder's shared
`scripts/published-site-entries.mjs` source of truth. The exact twelve-file Pull
Request #75 diff is a regression case and now classifies as `no-visual-change`.

The bot comment now says only that a skip was requested from the Pull Request
title. It cannot claim eligibility; the required `Pull Request Checks / Test
static site` check must pass and report the accepted pathway. Full tests,
responsive screenshots, exact-diff review, and any private-service evidence
still apply. The narrow custom-domain exception remains explicit for
production-only DNS, HTTPS, and analytics behavior that a Netlify hostname
cannot prove; the unmodified gate excludes the guard and preview-comment
workflow from that exception.

This rule change itself changes workflows and the guard, so it must use the
standard Netlify-preview pathway and separate John review. The Pull Request gate
is a regression and process control rather than an independent adversarial trust
boundary, and it grants no automatic merge authority beyond the existing guided
data-refresh route. No GitHub ruleset setting has been changed in this local
implementation.

Focused release-path tests and `git diff --check` pass. The final `pnpm test`
also passes on the latest Gallery-media baseline: repository safety, vendored
libraries, both-mode CSV and Gallery validation, Gallery administration suites,
all release/data/export regressions, the 114-file artifact build, and desktop
and mobile browser smoke tests for Family and Everyone. Screenshots remain only
under ignored `test-artifacts/`. No public runtime file, CSV, Gallery manifest,
media asset, Cloudflare resource, or live deployment changed. Nothing has been
committed, pushed, opened as a Pull Request, or merged for this task.

## Concurrent task: owner-authenticated Gallery media upload foundation

### Status — 29 August 2026

The storage, authentication, access, processing, and publication decision is
accepted and documented on `codex/gallery-upload-architecture`. Pull Request
#76 merged the Gallery foundation to `main` as
`41ac3ef614030cdd1c4a1efdb6e9a59769315a48`; its Pages deployment and exact
72-file public data bundle were verified separately. On 28 August the owner
explicitly approved the isolated non-production Phase C deployment and two
built-in synthetic media rehearsals. That approval does not include DNS
changes, real media, sanitized or public derivatives, GitHub Apps, Pull
Requests, merges, or production publication. Phase C is now deployed and
verified behind the existing owner-only Worker-level Access boundary. One
synthetic Family photo and one synthetic Everyone video exist only as private
originals and private D1 records. During that Phase C deployment, the public
media Worker, production site, three public Gallery JSON files, DNS, staging
bucket, and approved-derivative bucket did not change. The later Phase D
rehearsal described below deliberately left two synthetic photo derivatives in
private staging; approved storage and all public surfaces remain unchanged.

The selected first implementation keeps the championship site static and uses
a separate Cloudflare Access-protected Worker for the one owner. Private R2
buckets separate untouched originals, candidate derivatives, and approved
public-preview derivatives; D1 holds private consent, moderation, state, and
audit records; and a separate public Worker can read only approved derivatives.
A protected default-branch GitHub Actions job applies deterministic photo/video
processing and independently verifies metadata removal before a repository-
scoped GitHub App opens a normal manifest Pull Request. Its client contains no
merge operation, and repository rules plus a token rehearsal must separately
prove the App cannot update `main` or merge a Pull Request.

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
with confirmed resource identifiers. At the Phase B checkpoint, the deployed
admin remained D1-only. The tracked Phase C admin example now grants D1 plus
only the private-original bucket and an hourly cleanup schedule; the media
example still grants only the approved-derivative bucket.

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

At the Phase B checkpoint, external provisioning was complete within the
approved boundary. Wrangler was authenticated through an ignored local
credential with only user/account read,
Workers write, Worker-scripts write, and D1 write scopes; unrelated Pages, DNS,
AI, email, queue, and other product permissions were not granted. The
`family-running-gallery-dev` D1 database was created in Cloudflare's automatic
ENAM region, the reviewed migration applied successfully, and remote checks
found the expected 11 schema tables, 43 triggers, zero Gallery drafts, and zero
synthetic records.

Zero Trust Free and account MFA were active. R2 Standard was enabled with
separate, then-empty originals, staging, and approved-derivative buckets;
direct R2 development URLs and custom domains were disabled. A $5 account-email
budget alert was active. The D1-only administration Worker and approved-R2-only
media Worker were deployed only on isolated `workers.dev` hostnames. The
administration Worker was protected for all production and preview traffic by
the exact owner policy; the reusable owner policy carried the approved
30-minute session duration even though the application UI retained its one-
hour-or-longer duration control.

At that Phase B checkpoint, remote authentication checks proved that anonymous
access was denied, the owner could reach the private administration shell, and
a temporary exact Service Auth credential could reach only
`/api/service/health`, not a browser route. A wrong credential was denied. The
temporary credential, reusable service policy, application assignment, and
Worker automation allowlist secret were then deleted; the revoked credential
remained denied and the owner route still worked. The media Worker returned
`404` for its root, queries, and nonexistent immutable objects, and returned
`405` for writes. All buckets were private and empty at that checkpoint. Later
Phase C and Phase D rehearsals added only the private originals and private-
staging derivatives recorded below; approved storage and public manifests
remain empty.

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

At the pre-deployment checkpoint, Phase C was implemented and verified locally.
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
migrations `0001` and `0002` in in-memory SQLite, and a deterministic fake
private R2 multipart store. It proves consent and guardian gates, current tag validation,
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
No private original, real media, derivative, public URL, or manifest item had
been created at that checkpoint. Pull Request #76 then contained code and
documentation only; no DNS change, merge, deployment, or publication had been
performed.
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
media Workers in dry-run mode with the intended isolated bindings. This
resolved the feature branch checkpoint only; Pull Request #76 had not yet been
merged to `main`, and nothing had then been deployed or published.

The first post-push GitHub Actions replay then exposed a Windows/Linux catalog
determinism defect: Git's LF-normalized CSV and JSON sources were checked out as
CRLF on Windows, and their working-copy line endings had been included in the
catalog revision hashes. The generator now canonicalizes public text newlines
before parsing and hashing, the generated snapshot is explicitly pinned to LF
in `.gitattributes`, and a fixture proves that LF and CRLF inputs produce the
same complete catalog and revision. The canonical snapshot revisions are now
`sha256:76a58d9443532209758f39dba33686fd3090be050a689e8a6b7a85d9a194825f`
for its public sources and
`sha256:d9f63d28d14853b9452c95c4f15b912e4a0385134e699b9be1bf229eab687cda`
for suppression. A final full `pnpm test` passed after that fix, including the
responsive browser screenshots.

The owner then approved the non-production Phase C deployment and rehearsal.
Migration `0002_private_uploads.sql` applied cleanly to D1: the resulting remote
schema has 13 application tables, 70 triggers, no foreign-key violations, and
no pending migration. The ignored admin configuration grants exactly `DB` and
`PRIVATE_ORIGINALS`, with one hourly `0 * * * *` schedule. The deployed Worker
version `dc845e2d-1f60-41ce-bc8d-3ab24ef087ab` has exactly `fetch` and
`scheduled` handlers plus the existing three secrets. The public media Worker
remains on its previous version and still has only the approved-derivative
binding.

The separate provider fallback now preserves Cloudflare's default seven-day
multipart-abort rule and adds a one-day rule only for
`private-originals/phase-c/`. It cannot expire completed objects. The Worker
also enforces `expiresAt` on every part and completion request, so the 24-hour
boundary closes immediately rather than waiting for the hourly cleanup or the
provider's eventual lifecycle pass.

The first live synthetic photo found one real Workers/R2 compatibility defect:
the reviewed implementation passed R2 a transformed and teed request stream,
which the live multipart path rejected before recording a part. The session
remained active and resumable. The repair reads exactly one bounded part of at
most 5 MiB, rejects short, long, hash-mismatched, or signature-mismatched bytes
before R2, then passes a fixed-length `Uint8Array` to `uploadPart`. Regression
tests prove malformed bodies without `Content-Length` never touch R2 and a
correct body still succeeds. The resumed Family upload and a fresh Everyone
video then both completed with independent server checksums.

At the Phase C remote checkpoint, D1 contained exactly two synthetic-only
drafts: one Family photo and one Everyone video, both in `private-review`, each
with its own consent record, one completed upload session, and one part. It then
contained zero pending athlete exclusions, derivatives, publication references,
or Phase B canaries. The
authenticated interface showed runners before other public athlete IDs, no
destination selector, no Family draft in Everyone, and a protected preview for
each completed original. Anonymous requests to both original routes redirect
to Access. Direct `r2.dev` access is disabled and all three buckets have no
custom domain. R2's bucket summary remained at its eventually updated zero
metric during the rehearsal, so both remote objects were independently fetched
through Wrangler with `--remote`; their byte counts and SHA-256 values exactly
matched the completed D1 evidence. The temporary verification copies were
deleted immediately.

At that checkpoint, the staging and approved-derivative buckets were empty.
Live production still serves empty `family.json` and `everyone.json`, an empty
suppression ID list,
and `404` for `/gallery-admin/`. No derivative, public media URL, manifest item,
DNS change, Pull Request, merge, or publication was created. The complete
`pnpm test` suite passed twice around the live compatibility repair, including
repository safety, both Gallery modes, Phase C integration, 70-trigger schema,
artifact isolation, and desktop/mobile browser smoke tests.

The owner has now accepted the v1 storage-key organisation contract before
Phase D. Permanent R2 keys stay server-generated and machine-oriented: private
originals are grouped by immutable site, server UTC upload month, opaque draft,
and opaque upload ID; private processing candidates are grouped by site, draft,
and opaque run; approved derivatives retain their existing content-addressed
`media/v1/{sha256}/{canonical-filename}` paths. Uploader identity, original
filename, race metadata, athlete tags, consent, exclusions, captions, location,
device, and mutable state never enter a key. D1 supplies the owner-facing label
and search fields, and the single area-bound manifest remains the only control
over where approved media appears.

That contract is now implemented locally without enabling real uploads. The new
server-only key module builds and parses exact private, staging, and approved v1
forms; the upload service creates private v1 keys from the signed area, one
server timestamp, the opaque draft/upload IDs, and the normalized allowlisted
extension. Every later private R2 operation rechecks that stored identity and
fails closed before touching an unexpected key. Corrupt cleanup evidence now
marks the scheduled run failed without disclosing or acting on the key.

Forward migration `0003_private_original_v1_keys.sql` rebuilds the upload
session/part pair together and preserves existing Phase C rows and foreign-key
evidence exactly. Its insert guard temporarily accepts the exact old Phase C
UUID form as well as exact site-bound v1 so a running old Worker cannot be
stranded between the D1 migration and Worker deployment; the updated Worker
itself writes v1 only. Focused storage-key tests cover both site areas, all four
derivative roles, privacy exclusions, malformed/traversal inputs, public Worker
agreement, corrupt cleanup evidence, database grammar, and rolling
compatibility. The Phase C integration test applies all three migrations and
proves the exact generated R2 key remains absent from browser bodies and
headers. The populated-schema boundary test proves row-for-row migration
preservation, 12 tables, 70 triggers, six named indexes, clean foreign keys,
and no shadow table.

At the storage-key-only checkpoint, nothing in Cloudflare changed: migration
`0003` was not yet applied, the deployed Worker and two
`private-originals/phase-c/` objects were unchanged, and the one-day lifecycle
fallback still covered only the Phase C prefix. Both public manifests remained
empty. Applying the migration, extending the v1 lifecycle boundary, deploying,
uploading real media, opening a Pull Request, merging, or publishing were all
outside that local step.

The storage-key implementation also corrected stale Phase B-only status wording
and made the staging/approved role-to-filename mapping plus normalized original
extension boundary explicit. The complete `pnpm test` suite passed after the
code, migration, test, and documentation changes, including repository safety,
the new storage-key suite, all Gallery upload/admin/media contracts, the Phase C
integration and responsive owner tests, artifact isolation, and both-mode
desktop/mobile public browser smoke tests. Final repository safety and
whitespace checks were repeated after review corrections and passed.

At the local Phase D implementation checkpoint, the repository was based on the
merged Gallery Phase C and storage-key baseline. A new local branch added the
first synthetic-only photo processor and its private-staging bridge without
changing Cloudflare or the
public site. The standalone processor accepts generated JPEG and opaque PNG
inputs only with canonical site, draft, and processing-run identifiers. Pinned
Sharp/libvips creates deterministic WebP display and thumbnail derivatives with
orientation correction and no upscaling. Pinned ExifTool scans the exact
finalized bytes with user configuration disabled; any unexpected metadata,
warning, truncation, byte substitution, mid-scan change, or cleanup failure
stops the run.

A separate service-only processing Worker was implemented to derive those
identifiers and all editorial/access evidence from D1 rather than trusting
processor input. Its
bindings are limited to D1, private originals, and private derivative staging.
It cannot access approved media, a public manifest, GitHub, or merge/deploy
controls. The caller cannot select the Family/Everyone destination, race,
athlete tags, consent, exclusion state, object keys, or processing-run ID. Start,
original download, two exact photo-role uploads, terminal result, and exact-run
cleanup are the only route families. D1 reserves each output before R2 creates
an empty one-part multipart upload. The exact provider upload ID must be durable
while the one-way write gate remains open before any media part is sent. The
Worker reads the completed object back independently and safely reconciles lost
part, completion, and following D1 responses. Consent, draft/catalog/
suppression revisions, and unresolved athlete exclusions are rechecked before,
during, and after the storage work.

The local race-safe cleanup companion was also implemented. A cleanup request
supplies only the opaque run ID, expected state version, and idempotency key;
D1 derives a pending tagged-athlete exclusion, withdrawal, or terminal
processing-failure reason and every target. Creating the cleanup row closes new
output, part, completion, result, derivative, and replacement-run admission.
Cleanup aborts every persisted multipart handle. If completion already won, it
verifies the exact private bytes and provider evidence before deletion. Every
expected key must return absent and the paginated server-built run prefix must
list empty before one D1 transaction removes operational rows, records the
audit event, and preserves an append-only hash-only tombstone. Even a zero-
output run must complete this evidence path before draft purge.

Focused processor, metadata-policy, storage-key, private-processing bridge,
publication-artifact, and repository-safety tests pass. The bridge end-to-end
test uses the real owner administration router, all six migrations, synthetic
JPEG bytes, the real pinned processor, a deterministic private-R2 substitute,
and the real processing router. It proves exact service authentication,
fixed-area tagging and exclusion gates, version-pinned original download,
multipart-only staging, crash-window replay, mid-run suppression blocking,
canonical result replay, simultaneous staged-versus-failed and conflicting
failure requests, delete-first consent withdrawal when no output exists,
abort-wins and complete-wins cleanup, lost create/part/complete/abort/delete
responses, cleanup before multipart admission or part evidence, malformed and
repeated prefix pagination, final D1 rollback and committed-but-lost responses,
partial/staged/no-output recovery, late-write closure, exact-object and prefix
refusal, hash-only retention, and unchanged public manifests. Direct
staging `put()` deliberately fails the fake. Independent
adversarial processor, bridge-code, and migration-schema reviews passed after
repairs for odd-ratio resize rounding, hostile ExifTool configuration, exact
path/byte binding, immutable returned bytes, cross-platform technical tags,
oversized pre-decoder rejection, cleanup-failure precedence, terminal-result
concurrency, post-read consent/exclusion rechecks, and the exact withdrawal
ordering. Final database hardening also requires every earlier run to have its
exact completed cleanup and three-hash tombstone before replacement; protects
all cleanup, evidence, tombstone, and active/staged-run uniqueness constraints
against `INSERT OR REPLACE` and `UPDATE OR REPLACE`; and still permits a new run
after a genuinely failed run has been cleaned and tombstoned. The final complete
`pnpm test` run passed against the combined code:
221 tracked files passed repository safety, every data/Gallery/admin/processor/
bridge/workflow contract passed, the 114-file public artifact passed isolation,
and both-mode desktop/mobile browser smoke checks and screenshots passed. A
final independent combined audit found no remaining local blocker. Wrangler
`4.126.0` also packaged the separate processing Worker in dry-run mode with
exactly D1, private originals, and private derivative staging. No external
resource was changed.

At the local pre-rehearsal checkpoint, this was not a complete Phase D flow.
Video remains deliberately unavailable
until a pinned immutable FFmpeg/ffprobe runner is selected. At that point there
was no service deployment, approved-media promotion, candidate-manifest
generator, GitHub App, Pull Request, public derivative, or real-media path in
this slice. Successfully
staged photo evidence deliberately leaves the draft in `processing`; cleanup is
a private recovery/takedown operation and does not promote it. Because HTTP
Workers have no hard wall-clock duration, the cleanup design uses provider-side
multipart terminal state rather than a fixed delay. Cloudflare documents the
parallel abort/completion and strongly consistent object-absence pieces, but
does not state the exact terminal race as a formal linearizability guarantee.
Migrations `0004` and `0005` and the processing Worker therefore remained a
hard no-deploy boundary until a separately approved non-production synthetic
race rehearsal could confirm the provider behavior. `candidate-public`
remained blocked absolutely. The public manifests and suppression list remained
unchanged and empty.

The Phase D photo work was merged through Pull Request #79 as commit
`313049ec8c1c8bb0b8225812de12ecfd13de40d3`. Exact GitHub Pages run
`33221319314` succeeded. Its immutable 114-file artifact matched production
byte-for-byte, all 72 public CSVs matched the merge commit, Family and Everyone
rendered from bundle `20260827T022723137Z-5564E17F`, and representative Phase D
private paths returned 404. At that merge checkpoint this was reviewed code
only: migrations `0004` and `0005` and the processing Worker were un-applied and
undeployed, and no media or public manifest was published.

### Phase D non-production rehearsal — 29 August 2026

The owner separately approved the private, synthetic-only Phase D remote
rehearsal. Remote D1 now carries the reviewed migrations through
`0006_transition_receipt_state_version.sql`. Migration `0006` adds one unique
transition receipt per `(draft_id, expected_state_version)`, so two competing
retries cannot both claim the same draft version: the losing receipt conflicts
inside the same transactional batch and rolls its draft and audit changes back.
It also extends the append-only receipt replacement guard to both idempotency-
key and state-version collisions, so a distinct-key `INSERT OR REPLACE` cannot
evict the winner.

The first exact remote retry exposed a D1 integration limit that the local
SQLite substitute had not reproduced. The full evidence graph embedded in one
`UPDATE` exceeded D1's expression-depth limit of 100. The corrected retry still
pre-reads and validates the complete run, cleanup, object, tombstone, consent,
catalog, upload, exclusion, receipt, and audit evidence, but its mutation is a
shallow compare-and-swap. Exact draft and revision facts remain in that
statement, existing D1 triggers recheck the volatile consent, exclusion,
upload, state, and revision gates, and one shallow join retains the immutable
failed-run, completed-cleanup, and tombstone proof. The new unique receipt index
provides the concurrent single-winner guarantee.

The rehearsal then exposed one real R2 multipart behavior. Completion created
the exact object and its response was deliberately lost; a later `abort()` on
the resumed handle resolved even though that completed object was already
visible. A resolved abort is therefore not object-absence proof. Cleanup now
always checks the exact server-owned key after abort or `NoSuchUpload`, verifies
its reserved shape, metadata, bytes, and SHA-256, deletes only that object, and
proves final absence. An already persisted `aborted` multipart fact remains
immutable. When recovery observes the exact object, separate observed-version
and ETag hashes plus deletion and absence timestamps prove removal without
rewriting history. When replay instead finds the object already absent after a
deliberately lost delete response, as remote Scenario D did, the earlier
observed and deletion fields may remain null; final absence, the cleaned cleanup
record, and its tombstone close the same history. The interrupted Scenario D
resumed from its exact D1 and R2 evidence without a reset or manual database
repair.

The complete A–F report passed: six scenarios, five completed cleanups, four
acknowledged derivative puts, five deliberately interrupted responses, and a
final private `staged` result. The scenarios were `failed-no-output`,
`lost-upload-part`, `abort-wins-lost-abort`, `complete-wins-lost-delete`,
`exact-prefix-refusal`, and `final-staged`. Remote D1 finished at draft state
version 19 with six runs: five failed runs, one staged run, five cleaned cleanup
records, five tombstones, two verified private derivatives, zero approved
references, zero publication references, zero publicward drafts, zero pending
athlete exclusions, and zero foreign-key violations. Scenario F's display and
thumbnail derivatives deliberately remain in private staging; they are not
approved or public media.

The fault-enabled rehearsal Worker version was
`3df7ad5e-59b8-4fa1-9186-f42b71a9b546`. After the proof, normal Worker version
`bd830cfc-c18b-465e-8835-7232309b33e4` was restored with exactly D1, private
originals, and private derivative staging. The normal entry point rejected the
rehearsal fault header with `403`, and the exact immutable retry returned
`200` with `replayed: true`. Temporary retry diagnostics were removed before
that deployment.

The public boundary remained unchanged. The repository-canonical LF-byte
SHA-256 values are
`4C6E8E443A53C2172F54AC75E79463C2480878B5C59F0B2B066C330B44664186` for both
`gallery-data/family.json` and `gallery-data/everyone.json`, and
`FA82A4312752DED30ABD97EB2B44C39A4D31FE75E33F127CFA1F2E705C980050` for
`gallery-data/hidden-athlete-ids.json`. No approved-media promotion, public
manifest item, DNS change, GitHub App, Pull Request, merge, or production
publication was created by this rehearsal. A Windows CRLF working copy has
different raw-byte hashes without changing the tracked content. The temporary
Access service token and its dedicated reusable Service Auth policy were then
cleaned up after fresh explicit owner approval. The policy was detached from
the processing Access application and the application was saved before the
unused policy and token
were deleted. Cloudflare dashboard success notices and independent Access API
checks confirmed that the retained processing application still exists with
zero policies, the detached rehearsal policy and temporary token are absent,
and the account has no remaining service tokens. Their live Cloudflare
identifiers remain operational configuration outside Git. A credential-free
request to the processing Worker was redirected to the Cloudflare Access
sign-in host and did not reach the Worker. The exact deleted credential pair
could not be replayed because its one-time client secret was already absent
from the ephemeral session; the record therefore relies on Cloudflare's
authoritative deletion and absence proof rather than claiming that the old
pair itself was replayed. The owner application and
`family-running-gallery-owner-dev` policy were not changed.

Final review also closed the driver's restart baseline: a fresh rehearsal
fixture must now be exactly `approved-for-processing` state version 3, matching
every supported Scenario A and Scenario D recovery checkpoint, and the final
staged evidence must prove draft state version 19. A drifted otherwise-fresh
fixture fails before the first processing request.

Final working-tree validation on 29 August 2026 passed the complete `pnpm test`
suite. Repository safety checked 231 tracked files; the vendored libraries,
both-mode CSV and Gallery data, upload/media/processing/admin boundaries, all
six migrations, Phase D configuration and restart-safe driver contracts,
release regressions, exact 114-file public artifact, and Family/Everyone browser
smoke tests all passed. The refreshed Family and Everyone public Gallery and
fixed-area owner administration screenshots were visually reviewed at desktop
and mobile sizes. They have no horizontal overflow, the public Gallery remains
empty, and the owner page exposes the inherited area label rather than a
destination selector. After final review and documentation corrections,
`pnpm run validate:safety`, `pnpm run test:artifact-safety`, and
`git diff --check` also passed.

The reviewed Phase D commit was then rebased without conflicts onto current
`origin/main` at `f944526`. The complete `pnpm test` suite passed again against
that integrated data and updater baseline. Post-rebase visual QA found that a
few exceptionally tall 3x mobile PNGs repeated their opening pixels after
bitmap row 16,384 even though the live layout assertions passed. Full-page
browser captures now use CSS-pixel scale while retaining 390 x 844 mobile
device emulation, and the owner-page capture resets to the top before saving.
The focused public and owner browser suites and the complete suite passed with
the correction. The regenerated mobile images are 390 pixels wide; the tallest
current capture is 15,576 pixels, below the stitching boundary, and its real
lower-page content was visually reviewed.

After review, the exact ignored Phase D one-use credential runner, private
synthetic evidence copies, downloaded type-package snapshots, diagnostic SQL,
generated Wrangler configurations, and Phase D dry-run bundles were removed.
They are not recoverable from Git, but every generated configuration and bundle
can be reproduced from the retained source scripts. The reviewed preview
artifact and responsive screenshots remain under ignored `test-artifacts/`.

### Handoff

- Phase C's non-production exit gate and the private Phase D photo-processing
  race rehearsal are complete. Preserve the two legacy Phase C originals and
  Scenario F's two verified private-staging derivatives so later approved
  promotion, retention, and takedown work uses the evidenced workflow.
- Normal processing Worker version
  `bd830cfc-c18b-465e-8835-7232309b33e4` is restored with the exact three
  private bindings. Do not redeploy the rehearsal entry point or temporary
  diagnostics.
- The temporary Access service token and its dedicated rehearsal policy are
  deleted and cannot be recovered. The processing Access application remains
  installed with zero policies and is deliberately parked fail closed. Any
  future remote processing rehearsal needs a newly approved service identity
  and policy assignment; do not reuse or imply continued access from the
  deleted credential.
- The next separately approved implementation scope is approved-media
  promotion, candidate-manifest generation, a repository-scoped GitHub App and
  protected environment, and a complete synthetic Pull Request rehearsal. It
  must preserve the fixed Family/Everyone upload area, exported race selector,
  public athlete-ID tagging, consent, metadata stripping, whole-item exclusion,
  suppression, and host-first takedown contracts.
- Video processing remains unavailable until a pinned immutable
  FFmpeg/ffprobe runner and its test contract are selected. Do not use real
  family media until synthetic video, promotion, manifest, rejection, deletion,
  and takedown rehearsals pass.
- The completed private rehearsal does not authorize approved-media promotion,
  public derivatives, manifest edits, DNS changes, GitHub Pull Requests, merge,
  deployment of a public feature, or production publication.

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
