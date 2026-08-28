# Gallery Administration Workers

This directory contains the deployed authentication baseline and the remotely
verified, synthetic-only Phase C owner workflow. It is not part of the GitHub
Pages runtime and does not provide a public-site upload control. The deployed
administration Worker remains owner-only and can reach only D1 and private
originals; the separate media Worker can reach only approved derivatives.
The local Phase D processing Worker is a third, service-only component that can
read private originals and write private staging, but cannot reach approved
media or either public manifest.

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

## Local Phase D private-processing bridge

`src/processing-worker.js` is a separate service-only Worker entry point. It has
no HTML, owner session, browser route, list/search route, caller-selected
deletion route, or public-media route. It accepts only these exact operations:

- claim one server-selected draft for processing;
- download that run's version-pinned private original;
- upload one `photo-display` or `photo-thumbnail` WebP to a server-built private
  staging key; and
- record a canonical staged result or one fixed safe failure code; and
- close and clean one exact processing run after D1 proves an athlete exclusion,
  withdrawal, or processing-failure reason.

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

This component is currently local and synthetic-only. Do not apply migrations
`0004` or `0005`, create a new Access service token, or deploy it until the
combined processing/cleanup implementation has passed review and a separately
approved non-production Cloudflare rehearsal has confirmed the provider race
behavior. Any later external action and all real media still require separate
approval.

## Configuration boundary

The three example Wrangler files contain resource names and unmistakable invalid
replacement markers only. They are not deployable as committed. This is
deliberate: current Wrangler can automatically provision a D1 database when an
identifier is omitted. Make ignored local configuration only after the exact
non-production resources are confirmed, replace the markers there, and never
commit a real database or account identifier.

The currently deployed Phase B admin Worker binds only D1. The tracked Phase C
example adds exactly the private-original bucket plus an hourly cleanup trigger.
It does not bind derivative staging or approved-public storage. The three
provisioned bucket names are:

- `family-running-gallery-originals-dev`
- `family-running-gallery-staging-dev`
- `family-running-gallery-approved-dev`

The public media Worker binds only the last bucket. Phase C binds only the first.
The local processing example binds D1 plus only the first two buckets. Neither
administration, processing, nor delivery can reach all three buckets.

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

`migrations/0003_private_original_v1_keys.sql` is the unpromoted forward
migration for the accepted storage-key contract. It preserves existing
`private-originals/phase-c/` session and part evidence while new Worker-created
uploads use
`private-originals/v1/<site>/<UTC-year>/<UTC-month>/<draft-id>/<upload-id>/original.<extension>`.
Its rolling-deployment guard temporarily accepts the exact legacy UUID form as
well as exact v1, because applying the database migration and replacing the
Worker cannot be one atomic Cloudflare operation. The Worker generates v1 only
and validates the site, timestamp, opaque IDs, and extension against D1 before
any R2 read, write, abort, completion, preview, or cleanup action. This third
migration is local only; do not apply it until the v1 multipart-lifecycle rule
and remote rehearsal are separately approved.

When that later deployment is approved, the safe order is: review and extend
the multipart fallback for the v1 prefix, apply `0003` while the old Worker can
still use its compatibility branch, deploy the v1-only Worker, then repeat the
synthetic remote proof. Do not deploy the v1-only Worker against schema `0002`;
that older schema correctly rejects v1 keys.

`migrations/0004_private_processing_staging.sql` is the unpromoted local Phase D
run/output ledger. It records the exact original and current consent/catalog/
suppression evidence claimed by each processing run, reserves one immutable
private staging object per role, and permits only the one-way
`reserved -> stored -> verified` path. Database triggers reject replacement,
stale draft or consent evidence, unresolved tagged-athlete exclusions, extra or
missing photo roles, and a staged result without the exact verified private
derivative pair. It blocks `candidate-public`, processing-derivative mutation,
and draft purge absolutely because this slice has no race-safe cleanup
operation. The migration adds no promotion or public-manifest writer and is not
applied remotely.

`migrations/0005_private_processing_cleanup.sql` is that local companion. It
records every admitted one-part multipart handle, closes a run permanently when
cleanup starts, snapshots the exact private targets, permits deletion only
after terminal provider and R2-absence evidence, and retains only an append-only
hash commitment after normal private rows are purged. Its narrow exceptions
replace `0004`'s absolute deletion guards; the absolute `candidate-public`
guard remains. The migration adds no binding, scheduled job, approved-media
access, promotion path, public URL, manifest writer, or GitHub authority, and it
has not been applied remotely.

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
migration `0002`, the private-original binding, hourly cleanup schedule,
prefix-scoped one-day multipart fallback, and synthetic Phase C deployment.
Remote D1 and private R2 contain exactly one built-in Family photo and one
built-in Everyone video in private review. Staging and approved storage remain
empty. Use synthetic records and media only. Real family media and real consent
or editorial records remain prohibited until the later synthetic derivative,
metadata-stripping, deletion, and takedown gates have passed.
