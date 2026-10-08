# Protected Gallery tagging and reversible visibility

Status: accepted product/storage direction; local protected-roster storage,
owner reads, atomic private asset/tag reservations and internal pre-publication
archive quarantine/removal implemented. End-to-end
photo intake/tagging/visibility is not implemented.
Not deployed, and not part of the UI/data release in PR #120.

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

The reservation endpoints remain `awaiting-original`. They accept no bytes; no upload
or publication route accepts these records, and no image/hash/consent claim is
made. This is a future ownership reservation, NOT a verified retained photo.
Records and tags are immutable in this preparatory slice; archive-specific
audited tag revisions and consent/deletion cleanup require a forward migration
before real intake is enabled. This temporary fence does not extend old draft
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

This service is deliberately not imported by the admin Worker or wired to any
HTTP route, workflow or UI. The existing reservation endpoint remains a
reservation reader. The future intake integration must use the existing
verified single-owner identity, area-bound session and CSRF checks; these
internal helpers enforce owner/area scoping but do not independently authenticate
an HTTP request. No new bindings, resources, credentials or worker configuration
are introduced. No old draft, original, consent or terminal receipt is imported.

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
That inspection/processing bridge is still required before review/publication.
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
convergence, full consent-withdrawal completion or metadata purge. No archive
publication link exists yet. Before activation, implement and test the decoder/
processing bridge, audited tag correction, archive metadata retention/purge and
visibility/consent orchestration. Recheck orphan-multipart containment for the
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
SQL promotion/cleanup/host-proof and review integration remains fail-closed and
unfinished. No v2 processing workflow or private archive upload route is active.

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
