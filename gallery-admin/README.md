# Gallery Administration Workers

This directory contains the deployed Phase B authentication baseline and the
locally completed, synthetic-only Phase C owner workflow. It is not part of the
GitHub Pages runtime and does not provide a public-site upload control. The
Phase C code and second migration have not been deployed.

## Phase B boundary

The administration Worker has only four behaviors:

- authenticate every request through Worker-level Cloudflare Access context;
- issue a short, identity-bound browser session and CSRF token;
- write one server-generated fixed synthetic canary to D1; and
- answer a service-identity health check on a separate route namespace.

It has no original-upload, media-preview, processing, suppression-edit,
manifest-edit, GitHub, Pull Request, merge, or publication endpoint. The
migration prepares private tables for the accepted later workflow, but Phase B
code cannot write those tables.

The canary mutation accepts no request body, content type, transfer encoding,
or caller-supplied text. After the owner, origin, session, and CSRF gates pass,
the Worker inserts only `synthetic:phase-b-auth-boundary-v1`. The Phase B proof
therefore cannot accept a family, consent, or editorial record.

## Local Phase C boundary

The same Worker now has local, separately tested routes for the owner selector
catalog, private drafts, consent and guardian attestations, resumable synthetic
uploads, protected original preview, and moderation. The interface uses only
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

## Configuration boundary

The two example Wrangler files contain resource names and unmistakable invalid
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
The later processor must receive its own narrower purpose-specific capability;
neither administration nor delivery can reach all three buckets.

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

Applying migration `0002`, adding the private-original binding and schedule,
enabling the 24-hour external multipart lifecycle fallback, and deploying the
Phase C Worker all require separate explicit approval. Until then, the remote
admin remains the D1-only Phase B service. Use synthetic records and media only.
Real family media and real consent or editorial records remain prohibited until
the later synthetic derivative, metadata-stripping, deletion, and takedown
gates have passed.
