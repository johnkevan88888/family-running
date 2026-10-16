# Protected Gallery tagging and reversible visibility

## Current local completion — 11 October 2026

All 75 local check groups passed at 23:03:10 UTC, including the actual D1 engine,
both areas and responsive browser checks. Public output remains byte-identical
to main. Exact files, receipts and separate release/activation gates are recorded
in `docs/active-work.md`; this is local proof, not a live lifecycle rehearsal.

The approved local-only pass connects owner job requests, protected review/removal
recovery, publication preparation and terminal purge inspection/confirmation.
`0027` adds pre-POST admission and immutable addition/removal terminal evidence.
An interrupted intent with no admitted POST can be positively reconciled as no-PR;
an in-flight/uncertain POST cannot. Historical unknown writers remain fenced.
Current main alone does not settle a removal PR; its exact closed/owner-merged
result is required before manifest completion/restoration/finalization/purge.

`0028` records owner/session/CSRF/area-bound jobs and non-expiring global claims.
The local UI queues only an exact asset/action/consent attempt, then links to the
owner-approved workflow; it cannot dispatch or publish. Opening saved asset/job
status is read-only. Minor/guardian answers, all private tags, server-derived public
metadata and fresh eligibility checks remain unchanged. Terminal original deletion
and metadata purge have separate controls; Hide never authorizes either.

The two manual main-only archive workflows accept only an opaque job ID. Existing
processing/finalization environments keep service/App credentials separate, never
passing them as outputs/artifacts. Purpose-authenticated HTTP controllers consume
the private owner job. Publication preparation holds its claim across the separate
owner merge, until checked observation or terminal cancellation. A confirmed purge
cannot acquire that slot; it also needs its exact owner-approved proof/key.
Completed purge retires private jobs in the same transaction and keeps hash-only
completion replay, without further media/host/GitHub operations.

Rerun the SAME failed Actions run; a new run cannot steal its claim. No timeout or
empty storage inventory fabricates absence. Existing current host/witness evidence
and completed cleanup are reused; real proof remains distinct from local fixtures.
This coordinates the supported owner path, not arbitrary out-of-band owner merges.
Live activation must verify owner-only environment approvals, the App/main update
restriction, fixed configuration, archive multipart containment and that publication
procedure. No remote resources/settings/credentials/deployment/rehearsal occur here.
Full validation/evidence and exact changed paths are in `docs/active-work.md`.

Previous-stage status (superseded by the completed owner/workflow integration above):
accepted product/storage direction; local protected-roster storage,
owner reads, atomic private asset/tag reservations and internal pre-publication
archive quarantine/removal, audited complete-tag correction and internal
fresh-consent attempt reservation and internal archive-source processing/review,
whole-photo hide/restore and fixed-origin removal proof implemented locally.
Protected owner intake/fresh-consent HTTP controls and a separate exact-removal
review adapter and strictly scoped processing/promotion/verifier/finalizer service
paths are now implemented locally. Explicit protected-transport runner libraries
connect review, recovery, removal proposals and fresh-generation restoration;
they have no CLI, credential discovery, workflow dispatch, merge or publication.
No Actions workflow is yet wired to these archive runners. Terminal archive
metadata purge is implemented/tested locally as internal libraries only; the whole lifecycle is not
yet owner-operable or deployed. No real-photo intake is approved by this status.
Not deployed, and not part of the UI/data release in PR #120.

## Strict service continuation — 10 October 2026

`private-gallery-service-authority.js` issues an ephemeral exact-attempt authority
only after the adapter verifies the configured single Access service identity.
All archive operations require configured media origin/version and matching
current epoch/witness values. No ledger-origin fallback, optional-version path,
browser impersonation or caller destination/key is present. Fresh public consent
can still be created only through the existing browser-owner session/CSRF path.
The full private roster, complete tags, consent, catalogue, suppression and pending
exclusions are rechecked before byte/review operations and afterward where needed.

The existing processing/promotion/verifier Workers route archive requests through
their fixed purpose and exact separated bindings. Original readback precedes the
actual pinned metadata-stripping decoder; staging/approved receipts bind actual
independently read bytes. The independently bundled finalizer adapter accepts
only an existing owner-deletion request and cannot process derivatives or purge.
`0025_private_gallery_split_cleanup.sql` adds immutable current-epoch tier absence
receipts and host-before-manifest completion guards. The verifier has no R2 binding
and refuses host I/O before both storage receipts; it then runs the unchanged
fixed-origin witness/target protocol. Missing storage is never public-host absence.

`archive-service-client.mjs` has fixed provider origins, explicit authenticated
transports, forbidden redirects and bounded whole-request/response reads. The
15 October local-only transport correction gives only processing `photo-display`
and `photo-thumbnail` PUTs the existing bounded 30-second total exchange option;
the promotion `promote` operation already has that option. Other operations keep
their 10-second defaults. Complete response validation and uncertain-write
closure/cleanup remain unchanged; no automatic write retry or Worker change is
introduced. A verified stored derivative is not, by itself, a successful response
or current consent. This is not a confirmed diagnosis of the failed live review.
The protected archive runner uses the existing narrow GitHub client. Prepared reviews
recover without reading the source or rewriting bytes. Privacy cleanup runs both
tiers independently of GitHub outages. Published-photo hiding may produce only an
unmerged one-file removal review; restoration requires fresh owner consent, checks
both current-main manifests against every old generation and uses fresh URLs.
A normal review rerun cannot silently unpublish an owner-merged photo.

An intent interrupted before any review exists still stops pending: positive
no-review terminal reconciliation is not yet wired into the archive guards.
Do not invent open/closed review evidence to finish it. This edge, Actions wiring
and explicit activation/rehearsal remain necessary before owner operation.

`archive-media-lifecycle.required.json` and the read-only containment validator
require exact 24-hour abort rules on all three new prefixes and reject overlapping
object-changing rules or unknown policy shapes. Generated policies pass locally;
no live bucket policy has been inspected or altered by this continuation.

After a separate explicit local-only approval, `0026` and the DB-only retention
service implement terminal owner deletion/consent-withdrawal metadata purge.
Hide/Allow and retention expiry do not qualify. Original deletion, every attempt's
closed generation, both tier receipts, current epoch/host and current-main absence,
and terminal addition-review evidence are required. An unadmitted generation is
not omitted. Zero actual attempts is not an R2-derived public-host receipt.
Both current-main manifests are inspected for old IDs/URLs. Exact private rows
are deleted atomically with hash-only permanent audit and retirement; shared
people/preferences, unrelated archives and legacy retention remain intact.
Completed replay does not repeat storage/host/GitHub work. Immutable retirement
fences prevent old reservation/asset/generation/item/key reuse.

The fixed-client purge wrapper is internal only, with two current-main reads;
it cannot establish an atomic GitHub/D1 transaction. Publication serialization,
authenticated owner/CSRF orchestration and Actions wiring remain prerequisites.
Any saved removal intent/review currently blocks purge because its terminal ledger is not
wired yet. The pre-review interrupted-addition case also remains pending.
No HTTP purge route, deployment, migration application or live purge is included.

Local components: `gallery-admin/src/private-gallery-roster.js` validates an
owner-only catalogue and resolves complete private person tags without a public
results membership filter. Forward migration `0017_private_gallery_roster.sql`
adds empty protected people/revision tables without touching existing drafts,
consent, exclusions, storage, receipts or retention. No real identities are seeded.
`private-gallery-roster-service.js` reads the entire bounded roster and generation
in one primary D1 query, validates it before area filtering, and computes its
revision on the server. Every row edit advances the generation, including an
edit which restores old values. Missing/corrupt storage fails closed, not to a
public-roster fallback. The digest detects stale selectors; it is not consent
or a substitute for the SQL revision check required at a future tag write.

The new GET-only `/api/browser/private-roster?site=family|everyone` route uses
the existing verified single-owner identity and area-bound signed session. It
returns only the revision and that area's people, with no-store/same-origin
headers. Automation is denied. No roster import/write route, UI switch, byte
intake or public projection is added in this slice. The
existing uploader and public-result catalogue remain unchanged until the full
photo lifecycle can enforce private tags safely. Future imports need a separately
reviewed transaction and stable identity mapping; direct SQL fixture setup in
the tests is not an approved real-person import procedure.

`tests/gallery-private-roster.mjs` and `tests/gallery-private-roster-storage.mjs`
use fictitious people only. They cover the contract, full SQLite migration
chain, storage/route integration, whole-roster rejection, revision changes,
owner/session/area/method boundaries, and no public-artifact inclusion. The
existing local D1 parity suite also applies the new migration. These tests do
not prove archive retention, consent, hiding, restoration or live safety.

### Private asset/tag reservation slice

Forward migration `0018_private_gallery_asset_reservations.sql` introduces an
independent `asset_` UUID and complete ordered private-person associations.
The owner may reserve one through POST `/api/browser/private-assets` and read
it through GET `/api/browser/private-assets/{assetId}`, always using the exact
inherited `?site=family|everyone`. Existing Access-owner, signed area-session,
same-origin and CSRF checks apply; neither route is available to automation.
No destination selector or caller-supplied identity/object key is accepted.

The server validates the entire roster and exact selector revision, then one
SQL INSERT rechecks the current generation and eligible complete tag set while
atomically creating the parent and all associations. Unique owner/area/request
keys make a lost-response retry return the same asset, not duplicate it. Changing
that request's contents is a conflict. Replay confirms only the original
reservation, never current publication eligibility or consent.

The private key reservation is `private-archive/v1/{site}/{assetId}/original.jpg`
or `.png`, in the existing private-media architecture. It is never returned by
the owner APIs and cannot be parsed as a legacy draft-owned original. There is
no foreign-key relationship to a draft and no backfill/reclassification of old
withdrawn/purged records. Stable person IDs cannot be replaced; removing a
person's public mapping or area eligibility does not erase saved tags.

The reservation endpoints themselves remain `awaiting-original` and accept no
bytes. The separate owner intake controls below can quarantine an original in
local generated fixtures; a reservation alone is NOT a verified retained photo.
Neither endpoint is a publication capability.
Initial records and tags remain immutable; the separately documented 0021
correction appends new versions rather than rewriting them. Complete archive
consent/deletion/purge integration is still required before real intake is
enabled. This temporary fence does not extend old draft
retention or grant permanent retention against future consent withdrawal.

`tests/gallery-private-assets.mjs` covers actual SQL writes and authenticated
routes with fictitious people, complete private tags, cross-area denial, stale
revision races, atomic rollback, lost-response replay and corrupted-tag failure.
Local D1 tests execute the same service statements. The existing finalizer
suite also retains an independent reservation/tag row and synthetic sentinel
object while old draft consent deletion and purge complete normally. This is
cleanup-isolation evidence, not archive intake, Hide/Allow or live proof.

### Internal pre-publication quarantine and removal

Forward migration `0019_private_archive_intake.sql` and internal
`private-archive-service.js` add separate private-retention/guardian attestations,
an immutable intake fingerprint, a single durable multipart writer, byte-check
receipts, terminal removal requests, writer-closure evidence and original-absence
receipts. None of these fields grants public-use consent. Complete private tags
remain attached; original deletion does not claim that metadata has been purged.

The original internal-only slice is now consumed by the local protected owner
wrapper described below. The existing reservation endpoint remains a reservation
reader. The wrapper uses the existing verified single-owner identity, area-bound
session and CSRF checks before dispatch; these internal helpers enforce owner/
area scoping but do not independently authenticate an HTTP request. No new
bindings, resources, credentials or Worker configuration are introduced. No old
draft, original, consent or terminal receipt is imported. Nothing is deployed.

Before bytes, the owner must confirm private retention for all depicted people,
state whether minors appear and supply the corresponding guardian confirmation.
The server validates complete tags against the current private roster; SQL
rechecks that generation at admission, writer registration and byte receipt.
JPEG/PNG declarations only, 25 MiB maximum, exact MIME/format/length/SHA-256 and
the existing signature detector are enforced. The original is read back through
a conditional request and its bounded stream is hashed again. Stored objects
use generic octet-stream/no-store headers, never browser filenames or identities.

`quarantined` means only that original bytes match the declared intake. It does
NOT mean the pinned image decoder accepted the image, dimensions/transparency
passed, metadata was stripped, publication consent exists, or anything is public.
The internal 0023 bridge below now performs that inspection/processing; its
protected activation is still required for an owner-operable review path.
Private originals may retain metadata by the established storage contract;
public derivatives still require the existing full stripping/scanner gates.

One immutable provider upload ID is registered before any part is sent. A
lost/unregistered multipart creation can contain no bytes; a losing creator is
aborted. No fallback single-object PUT or replacement writer is permitted.
Incomplete intake expires after 24 hours using the SQL-owned clock, without
extending any old draft deadline. Original quarantine itself is not a time-based
permission to publish or a change to the old 30-day terminal retention policy.

Private-retention withdrawal or owner deletion is recorded before cleanup.
This permanently blocks new intake, writer registration and original admission.
Cleanup closes the exact registered multipart writer before deleting the one
server-owned archive key. A confirmed abort or exact `NoSuchUpload` condition
can record writer closure; generic provider failures cannot. It then checks
exact private-key absence before committing a receipt. Retry preserves closure
evidence and completed removal replays without storage I/O. This ordering uses
the documented multipart terminal operations, not absence alone, to fence a
delayed completion. See [R2 multipart API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2multipartupload-definition).

This is private-original removal only, not public-host absence, manifest
convergence, full consent-withdrawal completion or metadata purge by itself.
The 0023 integration below links public generations and blocks premature original
deletion completion. Before activation, finish archive metadata retention/purge
and protected visibility/consent orchestration, using the audited correction below.
Recheck orphan-multipart containment for the
new archive prefix as part of separately approved deployment preparation; no
bucket lifecycle setting is changed by local code or assumed from an old prefix.

`tests/gallery-private-archive.mjs` uses generated JPEG/PNG bytes and fictional
people. It tests both areas, private/guardian consent, bounded bodies, hash/
signature/readback mismatches, stale/expired intake, late registration, both
completion/deletion race orders, lost database responses, provider errors,
resumable cleanup and immutable receipts. It also performs actual multipart
upload/readback/removal in the pinned local R2 runtime. The D1 suite exercises
the real intake service and compiles every new cleanup write under its expression
depth limit. These local results are not evidence of live storage cleanup.

### Audited complete-tag correction — local only, 8 October 2026

Migration `0021_private_gallery_tag_revisions.sql` preserves the initial asset,
ordered tags and original intake/retention/guardian receipts. The protected
GET/POST `/api/browser/private-assets/{id}/tags` boundary appends a new complete
tag set with expected tag version, current roster revision, idempotency key,
explicit complete-person/private-retention confirmation and fresh minor/guardian
answers. No names, object keys, destination, old draft or public-use permission
are accepted in this request. New ordered associations and their audit parent
are one atomic SQL operation. Current private reads and eligibility projection
use the current complete set; a tag ABA cycle changes the eligibility digest.

Corrections are denied during unfinished/uncertain intake and after archive
deletion/consent withdrawal. SQL rechecks owner, inherited area, roster, previous
version/complete set and terminal state after application validation. An unknown
or missing tag fails the whole operation. A lost response can recover only the
same committed current revision, not overwrite later edits or resume deletion.
An owner confirming complete tags is an attestation, not automated recognition
of everyone pictured; it must be presented clearly in a future editing UI.

Corrected original intake requires the explicitly selected current tag version,
fenced again at SQL admission, writer registration and original receipt. Older
version-one callers remain valid only for uncorrected tags. Pre-0021 original
intake fingerprints are preserved for exact no-write replay. Retagging a retained
original leaves its bytes, provider version/ETag and old receipts unchanged;
the new private-retention answers attach to the new tag revision only. They do
not confer public consent or permit processing, promotion or a candidate PR.

`tests/gallery-private-tags.mjs` checks actual SQLite and protected owner routes,
upgrade of a previously retained original, append-only/complete associations,
fresh retention/guardian validation, ABA, current-tag projection, roster/tag/
intake/deletion races, atomic rollback, lost-response recovery and corrupted
association refusal. The local R2 archive suite additionally proves a tag edit
leaves exact generated photo bytes, provider version/ETag and receipts unchanged.
The local D1 suite executes the real correction and corrected-tag intake and
compiles all new writes under the provider's expression-depth limit. No real
identities/media, HTTP byte route, tag-edit UI or remote activation is included.

Championship face-framing is agreed as a separate small follow-up. Its future
position/zoom controls should belong to the particular photo/person, not change
private identity, permission or original bytes. No placeholder crop fields,
automatic face recognition or public thumbnail change is added here.

### Internal fresh-consent attempt reservation — local only, 10 October 2026

Forward migration `0022_private_gallery_attempt_reservations.sql` and internal
`private-gallery-attempt-service.js` reserve a distinct attempt against the
independently retained archive asset. They do not create or revive a legacy
draft, extend old retention, or copy an earlier public-consent attestation.
The current complete tag version and all people's exact visibility versions,
current roster generation, public-ID projection, catalogue/suppression revision,
server-selected race tuple and exact quarantined original receipt are saved
with fresh complete-person public-use/minor/guardian answers. Private names and
unmapped person IDs never become public athlete IDs. An earlier recorded child
declaration cannot be silently downgraded in the new public-use request.

The caller selects only a race index under the exact current catalogue revision;
the service derives date/event/distance and the inherited area. It accepts no
destination, supplied public IDs, old draft, object key, URL or generation.
New attempt, prospective public-item and prospective v2 generation identifiers
are server-generated v4 UUIDs. These are reservations, not public generation
admissions or URLs. A future public manifest still contains only its existing
fields, never these private tags/permissions/source receipts.

Shallow SQL guards recheck current owner/area, roster, complete current tag set,
all visibility versions, exact projection, pending exclusions, retained original
receipt and terminal archive removal after service validation. Lost replies
recover only the same immutable record while all facts are still current.
Hide/Allow or tag ABA cycles invalidate old approval; changed consent inputs
conflict. Reservations expire after 24 hours for current-success replay without
rewriting old evidence or deleting retained originals. Later processing must
repeat these fences and the fresh-consent lifetime, not trust a saved reservation.

This database-only module is now consumed by the local protected owner wrapper,
not a service workflow. It performs no R2/GitHub/network operation and reports
processing/publication disabled.
Quarantine remains byte-match evidence, not decoder acceptance or metadata
stripping. No source ownership transfer, active processing draft, preview object,
PR, hide/restore completion, metadata purge or public-host proof exists here.
The prospective v2 identifier cannot enter the still-v1-only promotion path.
The following internal lifecycle consumes this checked reservation; this
reservation service itself remains database-only and does not grant admission.

`tests/gallery-private-attempts.mjs` exercises full forward SQLite migrations,
fresh consent, both inherited areas, generated retained JPEG bytes, private-only
tags, minors, source/race/permission conflicts, all write-time roster/tag/
visibility/deletion/exclusion races, atomic rollback, lost replies, post-commit
revocation and expiry. Race hooks must prove the competing valid write happened,
not merely fail on a malformed fixture. Existing photo bytes/provider identity,
old intake and original receipts remain unchanged, and no legacy draft is made.
The local D1 parity suite executes this exact service INSERT and compiles its
guards under the pinned provider depth limit. Full local checks and unchanged
public-artifact comparison remain required; no live action is implied.

### Internal archive-to-review and reversible hiding — local only, 10 October 2026

Forward `0023_private_gallery_photo_lifecycle.sql` adds a separate append-only
admission/output/writer/review/removal ledger for `0022` attempts. Every byte and
review write rechecks complete current tags, exact visibility versions, roster,
pending public exclusions, fresh consent lifetime, the original receipt and the
current delivery epoch. Preference, tag, roster, exclusion or archive-deletion
changes close affected attempts immediately. Closed attempts never reopen.
Old draft ownership, consent, original retention and v1 URL retirement remain
untouched; no old draft is manufactured to reach the existing processor.

`scripts/gallery-media/private-photo-lifecycle.mjs` connects the reservation to
the existing pinned Sharp/Exiftool processor and narrow GitHub review client.
The binding service conditionally reads the retained original, hashes its
bounded stream, and independently verifies stripped static WebP bytes, dimensions,
exact generic metadata and provider identity in staging and approved storage.
Each server-derived v2 output has one immutable multipart writer registered
before bytes. An approved output must match its verified staging counterpart.
The one-file candidate contains only the existing public manifest fields,
server-derived race values and mapped public athlete IDs, never private tags,
names, consent or source receipts. Review replay is read-only; uncertain review
responses retain intent evidence for exact recovery rather than creating another PR.

`hideArchivePhotoPerson` commits the visibility block first, then reconciles all
historical affected tag sets, including group photos. It closes writers before
removing exact staging/approved outputs, preserves completed receipts, and checks
fully paginated generation-prefix absence. GitHub failure cannot prevent this
byte cleanup. Private originals, provider identity and complete tags are retained.
Terminal archive-consent deletion still wins; its original may be removed promptly,
but a completion receipt cannot be recorded until linked public generations converge.
This does not claim metadata purge or extend legacy retention.

Public-host proof is independent of storage absence. A v2-only wrapper reuses
the established verifier with the fixed current origin/version/contract and
canonical witness HEAD/GET before and after all historical target HEAD/GET,
followed by final target HEAD. Redirects, cached/live responses, generic 404s,
wrong witnesses/versions, bodies and timeouts remain failures. SQL requires
the exact historical key set and current-epoch witness/target evidence; an
epoch race or forged empty receipt cannot mark removal complete. Legacy
verifier purposes, SQL, routes and v1 withdrawal/purge are unchanged.

Open reviews are closed through the existing exact-review client. Separately
owner-merged reviews can only be acknowledged read-only after identity, exact
manifest content and main ancestry checks; this adds no merge capability.
The 14 October local-only compatibility correction additionally recognises an
indirect owner replacement: the unchanged reviewed head must be an ancestor of
the actual merge, the exact approved photo must survive, and only old context
entries may be omitted, without edits/additions/reordering or cross-area reuse.
The original full candidate/hash/head remain immutable; removal reviews retain
full-manifest equality. This is terminal review proof, not host/main absence or
purge permission. See `docs/decision-log.md` and the focused testing protocol.
The runner rereads fixed-repository main and both manifests. A still-published
photo produces an exact one-file removal proposal and remains pending until
the separately reviewed change is actually merged. It does not create or merge
that removal PR automatically. Recorded removal status is evidence, not an
independent claim that current external main has been read; the resume runner
performs that read on every completion check.
Main movement during the durable manifest-receipt write stays pending. Before
any new attempt is admitted, the runner reconciles every earlier admitted
generation against current main, reusing only still-current host evidence and
completed storage cleanup. A later reappearance of an old item/URL therefore
blocks restoration before any new source read or public byte write.

Allow alone never restores a photo. `restoreArchivePhotoReview` requires fresh
explicit public/minor/guardian consent, a new checked attempt and proven removal
of every previous generation. All people must still be allowed and otherwise
eligible. Reprocessing the retained original may produce identical stripped
bytes, but the new generation uses different public URLs. Restoration ends at
an unmerged one-file candidate; no merge or publication function exists here.

`tests/gallery-private-photo-lifecycle.mjs` runs both areas with fictitious
people, generated metadata-bearing JPEGs, real pinned processing, full forward
SQLite migrations and the existing GitHub client against a bounded fake API.
It also exercises actual local workerd/R2 multipart storage, real media-serving
responses, write/I/O revocation races, lost provider/GitHub replies, host faults,
epoch races, complete-group hiding, fresh restoration and unchanged retained
bytes/tags, main movement at receipt insertion and retired-URL reappearance.
Owner publication and manifest removal are explicit fixture actions,
not actions by the runner or evidence of any live GitHub/Cloudflare operation.
The pinned Wrangler SQL splitter is tested because a CASE inside a trigger was
incorrectly split; equivalent `iif` predicates preserve the guards. Local D1
applies the complete chain and compiles every new write under its depth limit.

The local runner requires explicit injected bindings/owner context and network
adapters. It has no command-line entry point, credential discovery, ambient
network adapter, protected Worker route, workflow dispatch or uploader control.
Do not deploy a combined all-bucket Worker: activation must preserve the existing
separate processing and promotion capabilities. Remaining work is protected
service/owner orchestration and its completion UI, archive
metadata retention/purge and prefix-specific multipart containment checks. Those
are implementation prerequisites, not extra live approvals requested here.

### Protected owner intake and exact removal review — local partial integration, 10 October 2026

`private-gallery-owner-service.js` is routed through the existing admin boundary
at `/api/browser/private-assets/{assetId}/archive-intake`, `archive-original`,
`archive-attempt` and `archive-deletion`. Existing verified owner, inherited area,
signed session, same-origin and CSRF checks precede dispatch. Automation is denied.
No destination, identity, filename, object key or URL input is added. Ownership is
checked before reading original bytes. Exact content types, encoding/length and
size bounds, a total body deadline and bounded cancellation prevent unknown-length
or stalled bodies from bypassing intake limits. Responses expose safe state only.

The protected-library local UI saves fresh private-retention permission, uploads
an exact JPEG/PNG original and separately records fresh public-use consent. Both
minor questions require an explicit Yes/No selection, with guardian confirmation
validated server-side. Exact lost-response retries recover the existing intake/
receipt or consent reservation; they do not write another original. Confirmed
consent forms reset. Race/event/distance/date and public tags remain server-derived.
The UI explicitly says processing is not connected; saving consent cannot process,
create a review or publish. Hide remains a private preference action, not a claim
that public-byte or manifest removal has finished. Terminal original deletion is
not metadata purge and remains blocked from completion by incomplete public removal.

Forward local `0024_private_gallery_removal_reviews.sql` adds immutable removal
intents and open-review receipts keyed to the closed attempt and pinned main base.
SQL requires exact output-removal receipts, current-epoch host proof and the exact
historical public item. `requestArchivePhotoManifestRemoval` explicitly requests
a review through `createOrReconcileGalleryRemoval`; cleanup itself does not do so.
The removal client is separate from the exact-addition client. It proves that only
one inherited manifest file loses exactly the recorded item, preserves all other
items and rejects shared/cross-area URLs or changed historical metadata. It uses
the existing fixed repository/main, candidate-only branch and API allowlist, with
no merge, settings or arbitrary-file capability. Exact replay is read-only. An
open removal review stays incomplete until separate owner removal is observed on
current main; restoration still needs new consent, new URLs and current host proof.

Local owner-route, browser, fake-GitHub, full SQLite and actual local D1 tests cover
both areas, denial before I/O, stalled bodies, lost replies, retained tags/originals,
explicit synthetic owner removal and fresh restoration. These are not live proof.

The attempted service-authority adapter was rejected by tool security review
because it would add a service authority path and make required media-origin/
version checks conditional. The patch was NOT applied; the lifecycle core's
browser-owner boundary and mandatory configured origin/version checks are unchanged.
Do not bypass that rejection, impersonate a browser owner, or deploy a combined
all-bucket Worker. The next approval is a local-only stricter service design:
verified service identity may consume only an existing owner-approved exact attempt,
with mandatory fixed-origin/version configuration and separate processing/promotion/
verification capabilities. Wrong or missing configuration and cross-attempt requests
must fail before I/O. Protected orchestration, archive metadata retention/purge and
prefix-specific multipart containment remain unfinished. No release is requested.

## Outcome

The owner can tag every known athlete, including people absent from public
results. Protected Gallery records retain the photo and complete tags while a
person chooses not to appear. Opting back in makes photos eligible for a fresh
checked publication, without manual retagging. It does not automatically publish.

## Separate the three decisions

1. Public championship eligibility remains workbook-owned and unchanged.
2. Private photo tagging records who is pictured; it grants no public rights.
3. Gallery visibility and consent control whether that photo may be published.

The private catalogue needs stable opaque person IDs, an owner-visible name,
area eligibility, and an optional exact mapping to an existing public athlete
ID. Names are never join keys. Public-roster absence must not prevent private
tagging, create a public profile, or export private age/identity information.
Use a protected catalogue, not the committed generated public-results snapshot,
as the all-athlete selector source. No real private roster is included here.

## Storage and lifecycle boundary

Retained private assets must have an explicit archive identity and ownership
record separate from one processing/publication attempt. Do not clear an old
draft's withdrawal flag, extend its existing retention deadline, copy consent
attestations into a new authorization, or remove permanent cleanup receipts.
Already withdrawn/purged items cannot silently become archived items.

Use the existing protected database/private-media architecture where compatible;
do not create a new bucket, binding, credential or service merely for convenience.
Confirm that any archive ownership relationship cannot be reached by an old
draft's purge before adding it. R2 content, names and private tag associations
must remain outside Git, the public manifest and the Pages artifact.

Reversible hiding must not call the existing formal athlete-exclusion action:
that action enters terminal withdrawal and the 30-day retention lifecycle.
Introduce a distinct visibility operation and explicit owner wording. Consent
withdrawal/deletion keeps irreversible priority and its existing stronger rules.

## Hide operation

- Commit a revisioned private visibility block first, atomically preventing new
  promotions, candidate creation and use of stale publication approval.
- Derive all affected photos from complete private tags, including every group
  photo. Missing identity/tag data fails closed, never drops an inconvenient tag.
- Invalidate open candidates and remove existing approved public derivatives
  using the established exact-object and retired-generation boundaries.
- Require fixed-public-origin absence proof for every historical target. An
  empty R2 listing is not public-host absence. Preserve private archive ownership
  and tags throughout; mark cleanup pending until all required proofs exist.
- Remove current public manifest entries through the reviewed repository path;
  do not put private identities, tag lists or reasons into that path.
- Completion means public-host and manifest removal are verified, not merely
  that a preference was saved or a browser card disappeared.

## Re-inclusion operation

- The owner records the person's current preference; no athlete account or
  self-service identity system is included.
- Recheck all tags, everyone else's current visibility, consent/guardian
  evidence, inherited area, and current race/catalogue facts. A person opting
  in cannot override somebody else's exclusion or revoked consent.
- Use a new processing/publication attempt, fresh stripped derivatives and a
  new non-retired public generation. Do not reuse old approved URLs or replay
  completed cleanup. The archive/tag identity remains stable.
- Only approved public identity/result fields may appear in public output.
  Non-public person tags stay private. Define and test that projection before
  widening the existing public-manifest schema; never simply copy private tags
  into `athleteIds` or weaken today's public-ID validator.
- End at an unmerged one-file manifest-candidate PR. Publication remains a
  separate owner approval, not a side effect of changing visibility.

## Smallest implementation sequence

1. Private catalogue and asset/tag schema, owner-only selector/read APIs, strict
   projection boundary and synthetic fixtures. Keep existing public contracts.
2. Forward-only visibility operation/receipt schema and existing-service
   integration, with SQL-owned revision checks and complete archive ownership.
3. Owner Hide/Allow controls with separate consent-withdrawal/delete wording;
   protected orchestration for manifest/host convergence and fresh re-inclusion.
4. Local cross-layer tests, complete repository suite and unchanged public
   artifact proof. Only then propose a bounded release/activation gate listing
   the actual migrations, affected Workers and rehearsal steps.

## Required evidence before activation

Local continuation on 1 October 2026 added explicit private-person creation,
initially hidden revisioned preferences, complete-tag projection and a protected
preparation UI. These do not complete hide/restore or grant public consent.
John also approved locally preparing photo-only generation-specific v2 URLs,
without relaxing any v1 retirement rule. Builder/delivery support is tested;
The internal `0023` runner now tests promotion/cleanup/host proof, review and
hide/restore locally. No v2 protected processing workflow or private archive
upload route is active; the remaining activation prerequisites are listed above.

| Fixture/action | Required outcome |
| --- | --- |
| Tag a person absent from public results | Visible in owner selector; private tag persisted; no public identity/age leakage |
| Hide one person in a two-person photo | Whole item blocked; private original and both tags survive |
| Other person still hidden when first opts in | No promotion/candidate/public media |
| Everyone eligible again | New attempt/generation; same archive tags; stop at unmerged candidate |
| Missing/stale catalogue, tag or consent | Fail closed with no external side effect |
| Consent withdrawal races re-inclusion | Withdrawal wins at SQL write and final publication recheck |
| Worker stops after partial public cleanup | Resume exact unfinished work; retain verified cleanup and archive |
| GitHub unavailable during hide | Public removal still proceeds; manifest state explicitly pending |
| Old R2 key absent but public URL responds | Hide remains incomplete |
| Old generation reused | Rejected permanently |
| Existing draft reaches purge deadline | Cannot delete independently retained archive bytes or resurrect draft |
| Missing/invalid public suppression file | All existing public surfaces still fail closed |

Use fictitious identities and generated media throughout local preparation.
Read/import of a real all-athlete roster, any private workbook exporter changes,
live migrations, deployments, credentials, synthetic remote rehearsal and photo
publication need the applicable explicit approval. No such action is implied by
this plan. PR #119 was separately approved, merged and its single-photo Family
pilot verified live on 30 September 2026. This new feature must preserve that
published pilot and byte-identical public output; Everyone remains empty.
