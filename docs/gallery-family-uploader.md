# Simplified Family uploader

## Event and runner selection

The multi-distance extension groups events by exact exported event name and date,
across all distances. Runners at this event lists only the selected Family
catalogue's participants. Each selected runner retains their own distance; if
the athlete has several distances at that event, the owner chooses one explicitly
before the photo can be retained. No event, result, time, age or AG is guessed.

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
   Choosing files saves draft metadata, not image bytes.
2. Select an event and its runners, plus other people pictured. The event
   is never guessed. Apply the event and people to other unsaved cards if useful,
   then check everyone pictured and answer the under-18 question for each photo.
   Saved private people remain selectable even if absent from the public roster.
3. Save each original privately and check the desktop/mobile thumbnails. One
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

After reopening a batch, saved tags and progress are available. Uploading an
unretained photo or adjusting thumbnails requires its matching local file.
There is no browser original-download route and no new private-preview object
lifecycle. Already-retained, checked photos can be submitted without selecting
the local files again. Leaving local-only files or unsaved framing warns or
stops the user rather than silently discarding the work.

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
