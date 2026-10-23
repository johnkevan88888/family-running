# Simplified Family uploader

## Guardian confirmation recovery — local-only, 22 October 2026

The Family permission panel now states whether guardian permission is included.
An active grant without that scope exposes a separate, unchecked confirmation
and **Add guardian permission** button. Answering Yes to the under-18 question
never grants permission. The affected card and Check thumbnails explain the
missing confirmation; the protected server independently refuses adoption or
submission with `family-guardian-permission-needed` before any reservation.

Confirmation uses the existing append-only policy endpoint, with an exact
expected version and stable retry input. It does not rewrite the earlier grant,
reload or reset the batch, fetch/upload an original, change tags/framing, create
an attempt or submit a review. A saved adult photo can keep its original intake
and framing while the unadopted minor-containing photo continues under the new
grant. Any later explicit batch submission binds fresh attempts to the current
grant. Existing reviews are not renewed; the panel warns that changing policy
requires their existing advanced recovery and fresh permission checks.

After a lost reply, retry the same confirmation. **Check saved permission** is
a read-only way to reconcile the current grant without reopening the batch or
losing thumbnail work. A stale tab cannot overwrite a newer grant or withdrawal.
Athlete/photo opt-outs and all downstream consent, exclusion, source, framing
and publication checks remain unchanged. No migration or shared-service guard
change is needed. Local synthetic evidence is not a live permission update or
deployment; release and admin-only activation remain separately approved.

## Save-first private files — local-only, 22 October 2026

Adding a new photo now immediately saves its bytes in the existing protected
originals bucket, before event, person or under-18 answers are requested. The
owner must already have active standing private-retention permission. The card
shows progress and only says Saved privately after bounded JPEG/PNG/hash checks,
exact provider readback and durable closure of its sole multipart writer. A
failed upload remains visibly unfinished and has an explicit same-photo retry.
No tags, ages, guardian answers, consent attempts or public URLs are invented.

Forward migration `0034` records this pre-tag file separately from the existing
tagged archive intake. The original keeps one server-owned private-archive key;
the normal reservation adopts that identity only after all existing tag, event,
runner-distance, minors and permission checks pass. The existing intake verifies
the same provider version/hash, without copying or uploading the original again.
Review, stripping, framing, suppression and publication retain their own gates.

New saved files can reopen through an owner-only, Family-session, same-origin
CSRF-protected POST read. Responses are no-store, non-embeddable attachments;
the browser verifies the exact fingerprint before decoding. There is no public
or presigned original URL, arbitrary-key fetch, third-party image processing,
GET download endpoint or new preview-object lifecycle. This supersedes the
earlier local-file-only preview decision for new save-first files only. Existing
legacy metadata-only cards keep their original matching-file recovery route.

Before tagged adoption, an explicit owner cancellation can fence and close the
registered writer, delete only that untagged original and verify storage absence.
It works after permission withdrawal too. It keeps terminal draft history and
never claims purge or public-host removal; start a fresh batch after cancelling
such a draft. Once adopted, the existing archive deletion/removal process is the
only deletion route. Its coordinated purge also retires the new file evidence.
No current real batch or original is removed by this local implementation.

## Event and runner selection

The multi-distance extension groups events by exact exported event name and date,
across all distances. Runners at this event lists only the selected Family
catalogue's participants. Each selected runner retains their own distance; if
the athlete has several distances at that event, the owner chooses one explicitly
before thumbnails can be checked or review prepared. No event, result, time,
age or AG is guessed.

Other people pictured is a separate tag selection, including public athletes
who did not participate, supporters and saved private/excluded people. Moving
to another event keeps every person tag but clears result associations and asks
the owner to choose that event's runners. An opted-out person still blocks the
whole photo, regardless of which selection they appear in.

New draft metadata adds `runnerResults` with private person and exact catalogue
race indices, checked server-side against the saved source revision. New consent
attempts freeze a server-derived public athlete/distance projection through
forward migration `0033_photo_event_results.sql`. Public items may carry
`raceResults`; private identities and performance values are never copied into
it. The common date/event applies to every projected result. The legacy scalar
`raceDistance` remains an exact exported event anchor, not a shared distance for
every pictured person. Public displays use each runner's association instead.

Existing drafts and attempts omit these optional fields and keep their original
meaning and exact evidence. Migration0033 adds a nullable immutable field without
backfilling, rewriting tags or resubmitting batches. Reserved source/people details
remain fixed. Unreserved legacy cards convert only after an explicit owner edit;
opening a saved batch does not rewrite it. Fresh multi-distance consent, processing,
promotion and publication all recheck current result membership alongside the
unchanged permission, complete-tag, suppression, byte and framing checks.

## Scope

The owner uploader at `/family-uploader?site=family` accepts several new photos
and prepares one combined review. The existing Everyone
uploader and advanced Family library remain available. No accounts, contributor
roles, public registration or commercial moderation system are added.

## Everyday journey

1. Choose up to 20 JPEG or PNG photos. Each card gets an independent random
   identity; filenames and matching athlete tags do not identify a photo.
   Choosing files automatically saves the original privately as well as its card.
   Wait for Saved privately; an unsuccessful upload offers Retry private save.
2. Select an event and its runners, plus other people pictured. The event
   is never guessed. Apply the event and people to other unchecked cards if useful,
   then check everyone pictured and answer the under-18 question for each photo.
   Saved private people remain selectable even if absent from the public roster.
3. Choose Check thumbnails and check the desktop/mobile previews. One
   face with one selected person receives a suggestion, not an identity claim.
   Multiple suggestions need a choice; manual positioning, zoom and whole-photo
   fallback remain available. Use these thumbnail views explicitly saves the
   checked source/tag/framing revision.
4. Send the ready batch for review. Fresh, independent permission evidence is
   recorded for every photo before the existing protected batch job is queued.
   This never merges or publishes a photo. An ineligible photo blocks the batch;
   it is not silently omitted.

The Family policy is confirmed once for private retention and website use,
with optional standing guardian permission. It remains active until changed.
Explicit athlete or photo exceptions, exclusions and terminal deletion win.
The detector never infers names, ages, guardian authority or complete tags.
Family is a mode of the public website, not a private publication destination.

## Saved batches and recovery

Draft metadata is owner-scoped in D1, not shared browser storage. Versioned
writes and stable retry keys protect against two tabs and lost replies. Every
source reservation is bound to one saved photo identity. Three JPEGs with the
same people and event therefore remain three photos; a retry of one source
keeps that source's reservation. Duplicate bytes within a draft are rejected.

After reopening a batch, saved tags and progress are available. Check a new
privately saved photo to load its exact original securely for tagging/framing;
it does not ask for the local file again. Older metadata-only uploads and failed
private saves still need their matching local file. Already-retained, checked
photos can be submitted without fetching originals. Leaving unfinished uploads
or unsaved framing warns or stops the user rather than silently discarding work.

Submitting freezes the batch. A partial submission resumes its saved attempt
keys; it cannot replace consent or steal an existing workflow claim. Changed
policy, tags, framing, catalogue or expired evidence requires the checked owner
recovery route, not an automatic replacement review. Retained source/tag changes
remain audited advanced operations. This initial uploader submits a whole ready
batch; it does not split a partially ready batch automatically.

## Protected storage and permission

Forward migration `0032_family_uploader.sql` adds the policy history, per-photo
exceptions, saved drafts, exact-write receipts and dispatch admission. It adds
nullable standing-policy references to new intake and consent evidence. It
does not backfill grants, change existing hidden people, rewrite old consent,
extend a 24-hour review lifetime or change original-retention deadlines.

The current-attempt SQL boundary retains all existing predicates and additionally
checks the exact current standing-policy version and persistent photo exception.
New standing intakes cannot be presented as old explicit consent by omitting the
policy reference. Upload registration and retained-original acknowledgement also
check the standing basis. Processing, promotion, review and publication continue
to use the common current-permission guard. The advanced recovery form carries
the current standing basis for sources created through the simplified uploader.

Keep the selected photo off the website closes that photo's generations and
blocks new ones. Allow this photo for a fresh review only lifts the exception;
it never reopens an old generation or restores a retired URL. Athlete-level
withdrawal uses the existing owner library. Public-copy removal still requires
the existing cleanup, manifest reconciliation and independent public-host proof.
Neither a switch nor R2 absence claims completed public removal. Original
deletion and purge remain separately explained, owner-controlled operations.

Photo-linked draft and exception records participate in the existing atomic,
exact-group purge. Independent policy history and hash-only draft-write receipts
do not contain photo bytes, names, filenames, source URLs or raw tags. Tests use
synthetic purge only; this implementation authorizes no live purge.

## Review dispatch and activation

The optional `FAMILY_REVIEW_DISPATCH_TOKEN` is an admin-only secret for the fixed
repository's Actions dispatch endpoint. The server accepts no workflow, branch,
repository, external URL or job-ID override from the uploader. It requests only
`gallery-archive-job.yml` on `main` with the server-owned job ID. A five-second
timeout or missing acknowledgement retains a durable admission and never causes
an automatic replacement dispatch. An existing workflow claim is reused.
The bridge pins GitHub API `2022-11-28` and explicitly requests the documented
empty acknowledgement, not the newer API's run-details response. See the
[versioned workflow dispatch contract](https://docs.github.com/en/rest/actions/workflows?apiVersion=2022-11-28#create-a-workflow-dispatch-event).

No credential has been configured locally or remotely. Without it, the uploader
truthfully shows that the batch is saved and the existing owner-only workflow
must be started from advanced recovery. The dispatcher cannot approve a protected
environment. Its eventual credential needs repository-scoped Actions write,
without Contents write, administration or merge authority; GitHub does not make
that token permission specific to one workflow, so the fixed server endpoint is
also part of the restriction. Live dispatch/status evidence remains unproved.

Release requires separate approval for synchronization/retest and the ordinary
code PR/checks/merge. Activation then requires the forward migration and the
exact affected service bundles: admin, processing, promotion, public-host
verifier and withdrawal finalizer, with existing split bindings and Access
settings preserved. The media-serving Worker and public website files are not
changed. Credential configuration and a synthetic live rehearsal need their own
explicit scope. The rehearsal must stop at an unmerged candidate.

## Local evidence

- `tests/gallery-family-uploader.mjs`: 85 checks including unchanged legacy
  evidence, guardian scope, late/current permission checks, independent same-tag
  photos, saved-write recovery, one actual synthetic batch pipeline, fake GitHub
  review, independent simulated host absence and coordinated metadata retirement.
- `tests/gallery-family-uploader-boundaries.mjs`: 87 protected route checks,
  including Access identity, area/session, CSRF, exact input, bounded bodies and
  no-store assets.
- `tests/gallery-family-uploader-browser.mjs`: desktop/mobile journey using the
  pinned detector on generated face fixtures, manual zoom, direct athlete
  selection, standing permission, saved/reopened batches and lost-save recovery.
- `tests/gallery-d1-expression-depth.mjs`: additive Family SQL compilation and
  real local D1 policy/draft/photo-exception probes alongside existing contracts.
- The complete repository suite remains mandatory for this code change. Current
  run results and public-artifact evidence are recorded in `docs/active-work.md`.

All new media fixtures are generated. No live storage, real photo, workflow,
GitHub PR or publication is used as implementation evidence.
