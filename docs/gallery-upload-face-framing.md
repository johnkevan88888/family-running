# Automatic upload face framing

## Scope and owner workflow

This is a local-only extension of the unreleased championship framing work.
It does not deploy an uploader, apply a remote migration, process a real photo,
alter an existing review, publish a candidate or enable face recognition.

1. Open the protected private library in the inherited Family or Everyone area.
   Save complete private tags and choose the matching local JPEG/PNG as before.
2. The browser locates possible faces and shows numbered suggestions on the
   local preview. It does not know their identities. For a group photograph,
   choose an existing tagged person and the corresponding suggested face.
3. Adjust position and zoom with the controls or click the correct point if a
   face was missed. Desktop/mobile preview shapes share the public crop maths.
   Reset a person to the whole-photo view if preferred.
4. Retain the original through the existing protected upload. Check the framing
   confirmation and save privately. Framing does not provide complete-person,
   private-retention, minor/guardian or public-use consent answers.
5. Record separate fresh public-use consent. That new attempt freezes the exact
   confirmed framing revision; subsequent owner-approved processing/review
   produces the usual unmerged one-file candidate.

Changing saved framing affects later fresh attempts only. It never edits an
already-created candidate or a published item. Reopening a saved asset reads
metadata, not its original pixels: reselect the matching local file to adjust
it. No new private-original GET route is introduced. Detection failure, missing
faces or an unavailable browser capability leaves manual/whole-photo fallback;
it must not invent an athlete or block unrelated championship data.

## Browser detector and privacy

Use the small pure-JavaScript Pico classifier rather than a hosted AI service.
Both code and classifier are pinned to immutable upstream bytes, checked by
`scripts/sync-private-face-detector.mjs --check`, and MIT notices are preserved
in the generated bundle and served worker. Normal checks require no network.
The deliberate sync command downloads only the fixed public upstream revision
and verifies exact SHA-256 values; it must never discover account credentials.

The dedicated browser Web Worker is not a new Cloudflare service. It receives
bounded downscaled pixels, has a hard termination deadline, and cannot make
network connections under its response CSP. The protected page permits only
same-origin workers, not blob workers, eval or outside scripts. Code/model are
served behind the existing owner boundary in the exact inherited area. There
is no camera or microphone permission, CDN loader, external inference request,
identity model, recognition profile or face embedding.

Detected boxes are temporary browser suggestions. Save only owner-confirmed
numeric x/y percentages and zoom, never detections, landmarks or image bytes.
Suggestions must not auto-create names/tags, claim every pictured person has
been tagged, infer age/minor status, change visibility or confer consent.

## Protected saving and immutable attempts

Forward migration `0029_private_gallery_framing.sql` adds append-only framing
revisions and immutable per-attempt snapshots. It does not backfill old attempts
or update existing photo, consent, review, retirement or cleanup evidence.

GET/POST `/api/browser/private-assets/{assetId}/framing?site=family|everyone`
uses the existing single-owner Access identity, signed area session, same-origin
and CSRF boundary. POST reads a bounded JSON body under a total deadline. Saves
bind exact asset owner/area, retained original SHA-256, current complete private
tag revision, canonical oriented dimensions and the expected framing version.
SQL rechecks those facts atomically. Exact lost-response replay cannot create a
second revision or overwrite a newer edit. Original deletion wins.

The orientation contract is `exif-transposed-v1`: coordinates refer to the fully
EXIF-oriented source, including mirrored images, before proportional resizing.
The browser previews that pixel orientation. Actual processing independently
checks the source SHA and oriented width/height before any derivative upload;
caller dimensions alone never prove decoder acceptance. Existing input limits,
metadata stripping and derivative verification remain authoritative.

Framing for hidden/unmapped people may remain private. Fresh consent must name
the exact current framing revision when settings exist. Its immutable snapshot
binds the original receipt, private tag version and public projection. A tag,
source or framing race rejects admission; a later edit does not retrofit an old
attempt. Guarded terminal metadata purge removes these private rows under its
existing authority and rollback controls; Hide does not delete them.

## One-file public review contract

A fresh photo item may contain optional presentation-only data:

```json
"podiumFraming": {
  "already-approved-public-athlete-id": { "x": 48, "y": 16, "zoom": 2 }
}
```

Only an exact subset of that item's approved public athlete tags is allowed.
Coordinates must be finite numbers x/y from 0 through 100 and zoom from 1 through
8; unknown/private fields and video framing are rejected. No private person ID,
source receipt, dimension, detector output, original URL or consent appears here.
The main photo, suppression, complete private tags, visibility, catalogue and
fresh consent gates run before projection. One hidden person still blocks the
whole group photograph, regardless of available crops for anyone else.

The new field is included in the exact canonical item/candidate/review hash.
It travels in the same inherited-area manifest file; the GitHub client gains no
second-file, arbitrary-write, merge or publication capability. Existing items
without the field keep their original bytes and reviews. Inline reviewed framing
takes precedence over the separate legacy numeric settings file, and only on
championship podiums. Gallery/viewer photos, video posters, standings and result
calculations are unchanged. A restored generation needs a new checked snapshot
and new reviewed item/URLs, never an edit of old retirement evidence.

## Validation and release gates

Run the pinned detector check, shared geometry, public contract and these groups:

```powershell
node tests/gallery-private-face-browser.mjs
node tests/gallery-private-face-vendor.mjs
node tests/gallery-framing-owner-boundaries.mjs
node tests/gallery-private-framing.mjs
node tests/gallery-fresh-photo-framing.mjs
node tests/gallery-framing-uploader-integration.mjs
node scripts/run-all-tests.mjs
```

Use only fictional identities and generated media. The positive face fixture is
entirely AI-generated, with its exact prompt/provenance in
`tests/fixtures/face-framing/README.md`; it is not a photograph of real people.
No fixture, detector, classifier, private API or uploader implementation may
appear in the 117-file public website artifact. Check real local D1 guards,
all EXIF orientations, lost/stale responses, whole-group suppression, private
projection, exact one-file review, unchanged old evidence and purge rollback.

Local tests do not establish live uploader behavior. After local completion,
repository release/checks/preview/merge, migration application, deployment of
the actually affected existing services and a synthetic protected rehearsal
remain explicit gates. Release the compatible static renderer before any new
framed candidate can be merged. No old real photograph needs to be reprocessed
or republished to test this local implementation.
