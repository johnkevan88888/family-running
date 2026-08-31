# Gallery Administration Workers

This directory contains the deployed authentication baseline, the remotely
verified synthetic-only Phase C owner workflow, and the Phase D private photo-
processing boundary. It is not part of the GitHub Pages runtime and does not
provide a public-site upload control. The deployed administration Worker
remains owner-only and can reach only D1 and private originals; the separate
media Worker can reach only approved derivatives. The normal Phase D processing
Worker is a third, service-only component that can read private originals and
write private staging, but cannot reach approved media or either public
manifest. Its non-production Access application is currently parked fail closed
with zero policies and no retained rehearsal service identity. A fourth local-
only promotion Worker now covers D1 plus staging-read and approved-write access;
it is not deployed and cannot reach originals, manifests, or GitHub.

## Historical Phase B boundary

The Phase B baseline administration Worker had only four behaviors:

- authenticated every request through Worker-level Cloudflare Access context;
- issued a short, identity-bound browser session and CSRF token;
- wrote one server-generated fixed synthetic canary to D1; and
- answered a service-identity health check on a separate route namespace.

It had no original-upload, media-preview, processing, suppression-edit,
manifest-edit, GitHub, Pull Request, merge, or publication endpoint. The
migration prepared private tables for the accepted later workflow, but Phase B
code could not write those tables.

The canary mutation accepted no request body, content type, transfer encoding,
or caller-supplied text. After the owner, origin, session, and CSRF gates passed,
the Worker inserted only `synthetic:phase-b-auth-boundary-v1`. The Phase B proof
therefore could not accept a family, consent, or editorial record.

## Phase C boundary

The same Worker now has implemented, tested, and non-production-deployed routes
for the owner selector catalog, private drafts, consent and guardian
attestations, resumable synthetic uploads, protected original preview, and
moderation. The interface uses only
same-origin HTML, CSS, and JavaScript returned by the authenticated Worker. It
has no file picker: Phase C creates a built-in synthetic photo or video, and the
server also requires a `synthetic-*` filename plus an explicit synthetic-only
flag.

The deterministic selector snapshot is built from the exact public export.
The owner opens the page with exactly `?site=family` or `?site=everyone`; that
area appears as a fixed label and there is no Family, Everyone, or Both control.
The signed session, route query, server-created draft, and database guard all
bind the upload to that one area. A body cannot choose `siteModes`, and a draft
from the other area is not listed, readable, mutable, or previewable. Each draft
also records its export, source, suppression, item, and consent revisions; tags
are public athlete IDs only. Current checked-in suppression and unresolved
athlete-wide exclusion evidence block approval. Consent and guardian gates also
apply when no athlete is tagged.

Multipart originals use only `PRIVATE_ORIGINALS`. The server chooses every
private object key and provider upload ID, accepts sequential 5 MiB parts,
checks a client chunk SHA-256, verifies signature/extension/MIME agreement, and
streams the complete R2 object through an independent server SHA-256. Provider
ETags are version evidence, never the content checksum. The browser receives
only safe progress and digest fields. It never receives an object key, provider
ID, owner identity hash, private evidence reference, or audit payload.

Signed owner sessions protect list, draft, status, and version-bound original
`GET`, `HEAD`, and range reads; every mutation also requires exact origin,
`Sec-Fetch-Site`, and CSRF evidence. An internal hourly scheduled handler
expires incomplete sessions after 24 hours only after confirmed multipart abort
and object absence. It does not expose a public maintenance endpoint.

The media Worker binds only `APPROVED_MEDIA`. It serves `GET` and `HEAD` for
these exact immutable key forms:

- `media/v1/<sha256>/display.webp`
- `media/v1/<sha256>/thumbnail.webp`
- `media/v1/<sha256>/video.mp4`
- `media/v1/<sha256>/poster.webp`

It cannot list a bucket, choose an object from a query parameter, proxy another
host, or access private originals, derivative staging, D1, or an administration
route. Response media types come from the validated key rather than mutable R2
metadata.

A ranged read also requires one nonempty raw R2 ETag. The Worker passes that
ETag as an `onlyIf.etagMatches` condition and accepts the response only when its
full object size, raw ETag, and returned range exactly match the preceding
`head`. A changed object or missing proof returns `503` rather than mixing
bytes from different versions.

## Phase D private-processing bridge

`src/processing-worker.js` is a separate service-only Worker entry point. It has
no HTML, owner session, browser route, list/search route, caller-selected
deletion route, or public-media route. It accepts only these exact operations:

- claim one server-selected draft for processing;
- download that run's version-pinned private original;
- upload one `photo-display` or `photo-thumbnail` WebP to a server-built private
  staging key; and
- record a canonical staged result or one fixed safe failure code; and
- close and clean one exact processing run after D1 proves an athlete exclusion,
  withdrawal, or processing-failure reason; and
- return a fully cleaned failed draft to `approved-for-processing` through one
  exact immutable retry receipt.

The caller supplies only opaque route IDs, idempotency evidence, finalized
bytes and hashes, and the pinned processor result. D1 supplies and repeatedly
revalidates the fixed site area, race/item evidence, consent, athlete tags,
catalog revisions, suppression state, original object evidence, and every
storage key. Pending exclusion of any tagged public athlete blocks the whole
item. A successful result records two verified private derivatives and leaves
the draft in `processing`; it does not create an approved URL or change a
manifest. Exact transition evidence makes simultaneous staged-versus-failed or
conflicting failure requests single-winner operations; the loser cannot append
a contradictory receipt or audit event. A no-output consent withdrawal can
finish only after the exact private-original upload row is terminally `deleted`
with its version, ETag, SHA, and deletion timestamp retained.

The R2/D1 write order is deliberate. D1 first reserves an output. R2 then
creates an empty one-part multipart upload, and D1 records its exact provider
upload ID while the run's one-way write gate is still open. Only that persisted
handle may receive derivative bytes or complete. The Worker reads the completed
object back before D1 can record it as stored. Exact retries reconcile lost
part, completion, or D1 responses; different bytes, metadata, dimensions, or
roles fail instead of replacing the object. Direct `put()` is not part of this
path.

Cleanup accepts only the opaque run ID, expected draft state version, and an
idempotency key. D1 derives the reason and every object and multipart target.
Creating the cleanup row atomically closes output, part, completion, result, and
derivative admission. The Worker then aborts every persisted multipart handle.
If completion won that race, it independently verifies the exact private object
before deleting it; if abort won, later part or completion work cannot recreate
the object. Every expected key must return absent and the complete server-built
run prefix must list empty before operational output rows can be removed. The
surviving cleanup record is a hash-only tombstone with no raw draft, run,
storage, provider, race, athlete, consent, or editorial data. Exact retries
resume the same evidence instead of inventing a second cleanup.

Cleanup does not delete a private original, change consent, approve media, or
write a manifest. Consent withdrawal still completes the existing separate
host-first and exact-private-original deletion workflow after staging cleanup.
Pending athlete exclusion makes the complete tagged item unavailable
immediately and cannot be undone by resolving the exclusion; a later processing
attempt requires a new run. Processing-backed derivatives remain private,
`candidate-public` is still unreachable, and draft purge requires completed
staging cleanup evidence for every processing run, including a run with no
outputs.

Supported multi-row claim and failure changes use transactional `D1.batch()`.
Unsupported direct SQL can strand an incomplete processing state, but that
partial state cannot stage, publish, mutate a verified derivative, or create a
valid failure receipt. The cleanup route recovers the supported private-output
states; unsupported direct SQL remains outside the service contract and fails
closed.

`wrangler.processing.example.jsonc` is intentionally non-deployable. A future
ignored local copy must have exactly `DB`, `PRIVATE_ORIGINALS`, and
`DERIVATIVE_STAGING`, plus these two secrets:

- `PROCESSOR_IDENTITIES`: exactly one
  `subject:<Cloudflare-Access-service-Client-ID>` entry; and
- `PROCESSING_ORIGIN`: the exact HTTPS processing Worker origin.

This component remains synthetic-only. Migrations `0003`–`0006` and the normal
processing Worker were applied and remotely rehearsed after separate approval;
the A–F photo and cleanup-race proof passed. The fault-enabled entry point was
then replaced by the normal entry point, and the temporary Access service token
and rehearsal policy were deleted. Do not create a new service identity,
reattach a policy, or deploy the rehearsal entry point without fresh explicit
approval. Remote approved-media promotion, protected manifest orchestration,
video, publication, and all real media remain separate blocked scopes. The
local-only photo promotion and candidate-generation modules described below do
not relax that deployment boundary.

## Local photo-promotion boundary

`src/promotion-worker.js` is a fourth, service-only Worker entry point. It
accepts exactly one Access service identity and one fixed `POST` route for an
opaque draft ID. Its JSON body contains only the expected state version and an
idempotency key. It rejects caller-supplied site, destination, race, athlete,
role, key, URL, editorial, manifest, or GitHub values. Its exact runtime
environment is `DB`, `DERIVATIVE_STAGING`, `APPROVED_MEDIA`, and three scalar
identity/origin values. It cannot read a private original or edit a manifest.

Migrations `0007_photo_promotion.sql` and
`0008_photo_promotion_cleanup.sql` record one immutable promotion claim,
exactly two role objects, durable provider admission, storage-only cleanup, and
hash-only terminal replay. The service revalidates the draft's single inherited
area, active consent and guardian approval, item/catalog/suppression revisions,
tagged-athlete exclusion state, staged run, and exact verified WebP outputs. It
persists one unique hashed D1 admission token before asking R2 to create a
multipart upload. Only the winning admission may call R2. The exact provider ID
is then handed to the still-open promotion or its already-closing cleanup before
uploading the one final part. Both staging and approved reads verify version,
ETag, byte count, SHA-256,
static WebP dimensions, content type, and exact safe metadata. Lost part,
completion, or D1 responses reconcile only the same persisted operation.

Only one final transactional batch can attach both approved keys, mark the
promotion complete, move `processing -> candidate-public`, insert its immutable
transition receipt, and append the audit event. `pr-open` and `published` remain
unavailable. Replacement and direct verified insertion remain blocked.
Candidate responses independently reread both approved objects and match their
recorded version/ETag and bytes before returning public-safe data.

The cleanup route accepts only an opaque promotion ID, expected draft version,
and idempotency key. It derives the exact keys and valid reason from D1, closes
admission, resolves every known multipart handle, verifies and deletes only an
exact complete-wins object, and proves exact-object plus fully paginated prefix
absence before removing operational promotion rows. A still-unresolved
admission cannot be called absent or terminal. The surviving receipt contains
hashes and outcome evidence, not raw keys. Consent withdrawal is a one-way
highest-priority intent. Storage cleanup deliberately does not set public-host
or private-original deletion evidence.

`wrangler.promotion.example.jsonc` is intentionally non-deployable. An ignored
copy would require the confirmed D1/staging/approved resource identifiers plus:

- `PROMOTER_IDENTITIES`: exactly one
  `subject:<Cloudflare-Access-service-Client-ID>` entry;
- `PROMOTION_ORIGIN`: the exact HTTPS promotion Worker origin; and
- `APPROVED_MEDIA_ORIGIN`: the exact HTTPS read-only media Worker origin.

Do not deploy migrations `0007`–`0008` or this Worker yet. A separate
fixed-origin, generation-bound public-host absence verifier and receipt remain
required; R2 bucket absence is not host-absence proof. The tracked one-day
`media/v1/` incomplete-multipart lifecycle requirement is orphan containment
only, cannot authorize a tombstone or purge, and has not been applied remotely.
Protected live candidate retrieval/orchestration is also missing. No Access
policy/identity, remote migration, lifecycle change, Worker deployment,
approved object, manifest edit, GitHub App, or Pull Request was created by this
local slice.

## Configuration boundary

The four example Wrangler files contain resource names and unmistakable invalid
replacement markers only. They are not deployable as committed. This is
deliberate: current Wrangler can automatically provision a D1 database when an
identifier is omitted. Make ignored local configuration only after the exact
non-production resources are confirmed, replace the markers there, and never
commit a real database or account identifier.

The currently deployed Phase C admin Worker binds only D1 and private originals
plus an hourly cleanup trigger. It does not bind derivative staging or approved-
public storage. The three
provisioned bucket names are:

- `family-running-gallery-originals-dev`
- `family-running-gallery-staging-dev`
- `family-running-gallery-approved-dev`

The public media Worker binds only the last bucket. Phase C binds only the first.
The processing Worker binds D1 plus only the first two buckets. The undeployed
promotion Worker binds D1 plus only staging and approved storage. No component
can reach originals, staging, approved storage, and GitHub together.

Set these admin values outside Git:

- `OWNER_IDENTITIES`
- `AUTOMATION_IDENTITIES`
- `ADMIN_ORIGIN`
- `SESSION_SECRET`

Identity allowlists are newline-delimited and accept only explicit
`subject:<immutable-identity>` or `email:<normalized-identity>` entries. The
actual values never belong in source, example configuration, logs, or D1.
`OWNER_IDENTITIES` represents exactly one owner: use one exact entry, or one
subject entry plus the matching email entry for that same Access identity.
Multiple subjects, multiple emails, or more than two entries fail closed.

Before any admin deployment is considered usable, Worker-level Access must
protect the complete Worker, the owner policy must be exact, and anonymous,
wrong-owner, expired-assertion, service-on-browser-route, and
browser-on-service-route checks must all fail. Direct public access must remain
disabled on every R2 bucket. Account MFA, recovery handling, cost alerts, and
the current provider terms remain external setup gates.

The Worker reads the platform-validated browser identity through `ctx.access`
and `ctx.access.getIdentity()`. Worker-level Service Auth currently returns no
identity object, so the service-only health route has a strict fallback for the
platform-injected signed application assertion: it accepts only the exact
service-token claim shape and repeats the exact Access audience and Client ID
allowlist checks. Browser routes never use that fallback. Keep the Worker free
of a Static Assets binding because Cloudflare's assets router does not propagate
`ctx.access` to the user Worker. The administration HTML and its separate CSS
and JavaScript are returned directly by the Worker.

## D1 migrations

`migrations/0001_private_gallery.sql` records the accepted private model and
Phase A state vocabulary. It retains revision, consent, suppression,
idempotency, derivative, publication, withdrawal, and append-only audit
boundaries without putting any of them in a public manifest. Only the
`phase_b_synthetic_records` table is reachable from the Phase B Worker.

Drafts use ordinary `INSERT` at exactly `draft` version zero followed by
versioned `UPDATE`; collision-aware guards forbid replacement inserts across
every draft, consent, derivative, publication, transition, exclusion, audit,
retention, and Phase B canary primary or unique key. Draft and derivative
identities are immutable, and collision-aware update guards prevent
`UPDATE OR REPLACE` from taking over another draft's public item or object
keys. Publication identities are immutable. Transition receipts are immutable
and can leave D1 only through an approved parent-draft cascade.
Active consent is one nullable composite foreign key. Every derivative snapshots the exact item,
consent, export, source, and suppression revisions, and the database rejects a
stale snapshot or a bound revision change until derivative evidence is
cleared. A pending athlete exclusion stores a public athlete ID plus revision,
hash, and timestamp evidence only. It stores no name or reason and blocks any
old-or-new tag edit, derivative insert or update, and advancement toward public
states while unresolved. Whole-item withdrawal remains the escape path.

The database enforces one-step state-version changes. The Phase C draft and
upload services now atomically couple each caller-supplied expected version,
guarded update, immutable idempotency receipt, and hashed audit event in one D1
batch.

`migrations/0002_private_uploads.sql` adds the multipart session, part, and
same-state mutation-receipt ledgers. It prevents replacement, provider-identity
changes, progress smuggling, wrong-sized parts, incomplete completion, and an
upload-to-review transition without complete server verification. Provider IDs
and object keys stay private. The second migration also strengthens purge so
original-upload evidence cannot cascade away before terminal cleanup.

`migrations/0003_private_original_v1_keys.sql` is the applied forward migration
for the accepted storage-key contract. It preserves existing
`private-originals/phase-c/` session and part evidence while new Worker-created
uploads use
`private-originals/v1/<site>/<UTC-year>/<UTC-month>/<draft-id>/<upload-id>/original.<extension>`.
Its rolling-deployment guard temporarily accepts the exact legacy UUID form as
well as exact v1, because applying the database migration and replacing the
Worker cannot be one atomic Cloudflare operation. The Worker generates v1 only
and validates the site, timestamp, opaque IDs, and extension against D1 before
any R2 read, write, abort, completion, preview, or cleanup action.

The approved deployment used the safe rolling order: review the multipart
fallback for the v1 prefix, apply `0003` while the old Worker can still use its
compatibility branch, deploy the v1-only Worker, then repeat the synthetic
remote proof. Do not deploy the v1-only Worker against schema `0002`; that older
schema correctly rejects v1 keys.

`migrations/0004_private_processing_staging.sql` is the applied Phase D run/
output ledger. It records the exact original and current consent/catalog/
suppression evidence claimed by each processing run, reserves one immutable
private staging object per role, and permits only the one-way
`reserved -> stored -> verified` path. Database triggers reject replacement,
stale draft or consent evidence, unresolved tagged-athlete exclusions, extra or
missing photo roles, and a staged result without the exact verified private
derivative pair. Its original absolute processing-cleanup guards are narrowed
only by the evidence-gated cleanup companion below. The migration adds no
promotion or public-manifest writer.

`migrations/0005_private_processing_cleanup.sql` is the applied cleanup
companion. It
records every admitted one-part multipart handle, closes a run permanently when
cleanup starts, snapshots the exact private targets, permits deletion only
after terminal provider and R2-absence evidence, and retains only an append-only
hash commitment after normal private rows are purged. Its narrow exceptions
replace `0004`'s absolute deletion guards; the absolute `candidate-public`
guard remains. The migration adds no binding, scheduled job, approved-media
access, promotion path, public URL, manifest writer, or GitHub authority.

`migrations/0006_transition_receipt_state_version.sql` adds one unique
transition receipt for each draft and expected state version. It also extends
the append-only no-replace trigger to both idempotency-key and state-version
collisions. That prevents a different `INSERT OR REPLACE` key from evicting the
winner and makes competing failed-run retries single-winner without relying on
connection-local statement metadata.

The unapplied `migrations/0007_photo_promotion.sql` replaces only the absolute
`candidate-public` stop with exact photo-promotion evidence. It adds immutable
promotion/object rows, preserves unique ownership of every approved key,
permits only the two verified photo roles, and allows approved derivative keys
to move only from `NULL` to the exact reserved keys in the same final
transaction. It keeps review, publication, approved deletion, processing
cleanup after promotion, and draft purge hard-blocked until their own forward
evidence migrations exist. It must be applied only together with the reviewed
promotion Worker and migration `0008`.

The unapplied `migrations/0008_photo_promotion_cleanup.sql` adds the narrow
storage-cleanup exceptions. It records one immutable cleanup and exact object
snapshot, closes admission, supports the exact provider-ID handoff from a
concurrent create, permits terminal abort/complete-wins deletion only through
the evidence state machine, and requires strictly ordered final R2 absence. It
then permits operational promotion evidence to be removed only while inserting
a hash-only replay tombstone. It adds no host verifier, private-original
deletion, manifest writer, GitHub capability, merge, or deployment authority.

Private consent, derivative, publication, and transition rows cascade when an
eligible draft is explicitly purged. Original, staging, and approved object
keys are unique while present, so cleanup cannot delete another draft's
object. Purge requires verified public-host absence, verified private-original
deletion, an eligible cleanup state, and an approved append-only retention
tombstone. Consent withdrawal follows the same host-first evidence boundary.
The surviving audit and retention tables have no draft foreign key and contain
only opaque references, closed state/purge facts, hashes, identity hashes, and
timestamps—never captions, names, reasons, consent notes, object keys, or JSON
payloads. The operational sequence is host deletion or verified zero-object
absence, private-original deletion, hash-only audit/tombstone approval, then an
explicit `DELETE`; never `INSERT OR REPLACE`. Phase C cleanup is an internal
scheduled event, not a browser or service endpoint.

The owner separately approved and completed the non-production application of
migrations through `0006`, the private-original binding, hourly cleanup
schedule, prefix-scoped one-day multipart fallback, synthetic Phase C upload
proof, and synthetic Phase D photo-processing and cleanup-race proof. Remote D1
and private R2 retain one built-in Family photo original and one built-in
Everyone video original. The Everyone draft remains in `private-review`; the
Family draft is in `processing` at state version 19 with the final photo run's
display and thumbnail derivatives in private staging. Approved storage and both
public manifests remain empty. The normal processing Worker is restored with
only D1, private originals, and private staging; its Access application has zero
policies after the temporary rehearsal identity and policy were deleted. Use synthetic
records and media only. Real family media and real consent or editorial records
remain prohibited until the later video, promotion, manifest, deletion, and
takedown gates have passed.
