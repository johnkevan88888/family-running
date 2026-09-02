# Curated Gallery Publishing Workflow

Phase 1 is an owner-curated public gallery. It deliberately does not accept
visitor uploads and does not put photographs or videos into Git or the GitHub
Pages artifact.

The owner-only upload architecture, provider-independent contract, Phase B
authentication boundary, and synthetic Phase C rehearsal are complete. Phase C
is remotely verified behind Cloudflare Access with private originals and D1
evidence only. The non-production real-photo JPEG/PNG admin intake now replaces the
built-in generator for the next photo pilot while preserving the same private
storage, area, catalog, consent, suppression, and exclusion boundaries. The private Phase D photo-processing and
staging-cleanup boundary has also passed its approved non-production A–F
rehearsal. Its final display and thumbnail remain private Scenario F staging
evidence; they are not approved or public media.

The normal processing Worker was restored after the fault-injection proof with
exactly D1, private originals, and private derivative staging. It cannot reach
approved media, a public manifest, GitHub, DNS, merge, or publication controls.
The temporary rehearsal service token and its dedicated policy were deleted
after the proof. The processing Access application remains installed with zero
policies, so it is deliberately parked fail closed until a separately approved
service identity and policy are created for future work. The owner application
and owner policy remain unchanged.
Verified derivatives may become reachable for Pull Request review only through
the separately gated promotion and candidate-manifest workflow. Its first
photo-only implementation slice now exists locally: it can verify an exact
staged pair, construct one public-safe candidate for the inherited area, and
prepare one review-only GitHub operation. A second local slice now closes
approved-media admission, resolves every known multipart handle, deletes only
the exact verified owned objects, proves R2 absence, and retains hash-only
replay evidence. It is deliberately not deployed: R2 absence still is not
fixed-origin public-host proof, and the promotion Worker, its Access identity,
and the updated processing routes remain gated. Migration `0010` is applied
and independently verified. The updated admin Worker is deployed as exact
version `c411bead-edb5-441b-aa0b-36594ff8a9b8` with its intended narrow
bindings and unchanged owner Access app/policy; anonymous health requests still
redirect to Access. A normal owner Access session returned exact
`{"ok":true,"scope":"owner-browser"}` from the browser health route, confirmed
by both the supplied screenshot and an independent live-tab readback. The admin
health gate is complete, but a real-photo upload is still prohibited. The required
`media/v1/` one-day incomplete-multipart rule is now applied and independently
verified, but remains orphan containment only. Protected candidate retrieval,
the photo-only orchestration runner, and the default-branch workflow now exist
locally but have not been deployed, provisioned, or dispatched. The committed
manifests and normal reviewed Pull
Request remain the only public publication path. See
[Owner-Authenticated Gallery Upload Architecture](gallery-upload-architecture.md).

The repository-scoped GitHub App and protected environment, remote
promotion/cleanup, and full synthetic Pull Request rehearsal remain future
work. The fixed-origin host-absence verifier exists remotely only for its
completed approved synthetic proof and is not a shortcut around
generation-bound withdrawal verification. Video processing and real family
media use remain forbidden until separately approved. The local implementation does not authorize a public media URL,
manifest change, DNS change, Pull Request, merge, or publication.

## Public And Private Boundaries

- The private Excel workbook remains the source of championship calculations
  and is not involved in gallery publishing.
- `gallery-data/family.json` and `gallery-data/everyone.json` are the public
  editorial manifests. The selected site requests only its own manifest.
- `gallery-data/hidden-athlete-ids.json` is the shared owner-maintained
  suppression list. It applies to both site modes.
- Media files live in dedicated external media storage and are referenced with
  absolute HTTPS URLs. No third-party JavaScript is loaded.
- Every published media URL is public. The site's `noindex` setting reduces
  search visibility but is not access control and does not prevent downloading.

## Before Adding A Moment

This checklist describes the future explicitly approved end-to-end publication
workflow. Local promotion, fresh candidate retrieval, in-memory manifest
generation, orchestration, the protected workflow file, and GitHub review
client now exist together with storage-only approved-side cleanup. They are not
remote infrastructure and have never been dispatched. The current deployed
private service therefore still cannot promote media or create a candidate
manifest or Pull Request.

1. Confirm that the people shown have approved public use of the photograph or
   video. Take particular care with children.
2. Keep the private original, including any useful geotag or device metadata,
   only through the Access-protected owner application and private media
   repository. Never copy that metadata into a public manifest.
3. Let the pinned processor create the required web-ready files outside Git:
   photographs have a compact thumbnail and larger display image; videos will
   have a web-compatible video and separate poster only after their later
   processing contract is implemented. Processing must strip location/device
   metadata and independently verify the finalized bytes before private staging.
4. Let the promotion service—not a browser-supplied path—derive the approved
   keys, recheck current consent, suppression, exclusions, and revisions, and
   verify the exact staged and approved bytes. Its storage-cleanup companion,
   orphan-multipart lifecycle containment, and separate generation-bound
   public-host deletion verifier must all be operational before this step is
   enabled remotely. Bucket absence alone is not host-absence evidence.
5. Generate the candidate from a fresh service-authenticated read using only
   the inherited Family or Everyone area, then prove the proposed manifest is
   the exact current document plus one reviewed item before opening a Pull
   Request.
6. Use the approved public media Worker hostname. The first pilot uses its
   Cloudflare-managed `workers.dev` address without changing production DNS; a
   first-party hostname remains preferred as a separately approved follow-up.
   Do not put API keys, upload credentials, signed management URLs, or private
   originals into either manifest.

## Manifest Entry

Each manifest uses schema version `1.0` and an `items` array. Order in the array
is display order. The uploader creates one area-bound private draft; the later
candidate generator and GitHub review client may add it only to the manifest for
that inherited area. They cannot create a shared Family-and-Everyone upload.
The repository retains its defensive rule that, if a future manual edit places
the same `id` in both manifests, the item must be byte-for-byte identical in
both.

The authenticated uploader follows the same constrained sequence the manifest
validator enforces:

1. Open the uploader in the intended Family or Everyone area. The incoming
   site context is fixed and visible; there is no destination control.
2. Select a race date from the dates present in public results for that area.
3. Select a race from the distinct event-and-distance combinations exported for
   that date. Distance is part of the race identity because one event can hold
   more than one distance on the same day.
4. Tag people by public athlete ID. People with a result in the selected race
   appear first; the rest of the public site roster remains available so a
   supporter or spectator can be tagged too.

No free-text athlete names or race names are stored. This keeps gallery links
stable and ensures removed or mode-ineligible athletes fail validation rather
than appearing as stale tags.

The promotion service and fresh candidate-retrieval path must re-read the shared
suppression and pending-exclusion state before returning or using a candidate.
They block a new item carrying a hidden athlete ID. One hidden tag suppresses
the whole item everywhere, for both photographs and videos; it does not merely
remove the person's label. The owner remains responsible for tagging every
identifiable public-roster person who needs this protection because the system
does not use face recognition. An authenticated athlete-wide exclusion prepares
the existing public ID-only suppression change and identifies all tagged host
objects that need takedown; private names, reasons, and request notes never
enter the public suppression file.

## Hide Every Moment Tagged With A Person

If someone asks not to appear in the gallery, add their public athlete ID to
`hiddenAthleteIds` in `gallery-data/hidden-athlete-ids.json`:

```json
{
  "schemaVersion": "1.0",
  "hiddenAthleteIds": ["carolyn-kevan"]
}
```

One entry suppresses every photograph or video carrying that person tag from
the Gallery, featured Race moments, and athlete profiles in both Family and
Everyone modes. The browser filters the metadata before creating image or video
elements, so it does not request the suppressed media as part of page rendering.
The list may retain an ID even when no current gallery item uses it, protecting
against a later item being tagged with that ID.

Use athlete IDs only. Do not add names, request details, or reasons. This is a
static public site, so the JSON file itself is publicly fetchable and must not
contain private administrative notes. An athlete ID can be found in the public
`data/athlete_results.csv` export.

Suppression removes the item from this website; it does not delete a file from
the external media host or invalidate a media URL that someone already knows.
For a complete takedown, also remove the media from its host and remove its
manifest entry.

```json
{
  "schemaVersion": "1.0",
  "items": [
    {
      "id": "summer-5k-finish-line",
      "type": "photo",
      "title": "Across the line",
      "caption": "A strong finish after a warm evening race.",
      "alt": "A runner crossing the finish line with spectators behind",
      "raceDate": "2026-08-23",
      "raceEvent": "Summer 5 km",
      "raceDistance": "5 km",
      "sourceUrl": "https://media.example.com/full/summer-5k-finish-line.jpg",
      "thumbnailUrl": "https://media.example.com/thumb/summer-5k-finish-line.webp",
      "featured": true,
      "athleteIds": ["carolyn-kevan"]
    }
  ]
}
```

- `type` is `photo` or `video`.
- `alt` describes the visible content for someone who cannot see it.
- `raceDate`, `raceEvent`, and `raceDistance` must identify an existing public
  result for the selected site mode. These values are selected in sequence by
  the authenticated uploader rather than typed as free text.
- `featured: true` makes the item eligible for Race moments panels on the
  Championships and Overview pages.
- `athleteIds` connects the item to those athlete profiles. Use an empty array
  when no profile association is wanted. The uploader shows people who ran
  the selected race first, followed by other public athletes in that site mode,
  so spectators or supporters can also be tagged without inventing names.
- `sourceUrl` is the large image or playable video. `thumbnailUrl` is the card
  image and the poster shown before a video plays.
- `caption` is public editorial text. Geotags and embedded EXIF/device metadata
  remain only in access-controlled private media storage, are not fields in
  this schema, and must not be present in either public derivative.

## Championship Podiums

Every non-vacant championship table keeps its full exported table and gains a
photo podium immediately above it. This applies to Current first and All-Time
second in Overall and in every distance dropdown. The podium uses the first
three ranked rows exactly as exported; it does not calculate or reorder a
standing. The exported `Rank` supplies the matching medal in both the podium
card and the table.

For a tagged athlete, the first approved photograph in manifest order is used;
if no photograph exists, an approved video poster may be used. Suppression is
applied before either can become an image request. When no eligible media is
available, the card retains a branded initials fallback and the ranking remains
fully readable.

## Validation And Release

Run `pnpm test`. Gallery validation rejects malformed JSON, unsafe or non-HTTPS
URLs, duplicate IDs, unsupported fields, invalid dates, unknown athlete IDs,
invalid or duplicate suppression IDs, and differing copies of a shared item.
The browser fails closed if the suppression list is missing or malformed. The
artifact build also rejects every unexpected file under `gallery-data/`,
including photographs and videos.

Any public manifest or runtime Gallery change is a standard site change: use a
feature branch, a normal Pull Request, a successful Netlify preview, responsive
screenshot review for both site modes, and explicit approval before merge or
publication. A private-service-only change follows the repository's release-
path classifier and still requires the complete local suite, exact-diff review,
service-specific evidence, and explicit approval for every remote mutation.
