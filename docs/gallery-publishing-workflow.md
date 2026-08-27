# Curated Gallery Publishing Workflow

Phase 1 is an owner-curated public gallery. It deliberately does not accept
visitor uploads and does not put photographs or videos into Git or the GitHub
Pages artifact.

The owner-only upload architecture, provider-independent contract, and
non-production Phase B authentication boundary are complete. The Phase C owner
form, private drafts, synthetic-only multipart upload, checksum, protected
preview, moderation, and cleanup are implemented and verified locally but have
not been deployed. The existing Cloudflare Access-protected admin service will
keep originals, consent/moderation records, and candidate derivatives private;
verified derivatives explicitly approved for Pull Request preview will be
served from a derivative-only media boundary. The committed manifests and
normal reviewed Pull Request remain the publication path. See
[Owner-Authenticated Gallery Upload Architecture](gallery-upload-architecture.md).

The current deployed admin remains the D1-only Phase B version and all buckets
are empty. Deploying Phase C, enabling the incomplete-multipart lifecycle rule,
or uploading even synthetic media requires a separate explicit approval. Real
family media remains forbidden until the later synthetic derivative, metadata-
stripping, deletion, and takedown rehearsals pass.

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

1. Confirm that the people shown have approved public use of the photograph or
   video. Take particular care with children.
2. Keep the private original, including any useful geotag or device metadata,
   only in the access-controlled media repository. Never copy that metadata
   into a public manifest.
3. Create a separate public derivative with embedded location and device
   metadata removed. Keep both the private original and the public derivative
   outside this repository.
4. Upload web-ready versions to the approved media host:
   - photographs: a compact thumbnail and a larger display image;
   - videos: a web-compatible video and a separate poster image.
5. Use the approved public media Worker hostname. The first pilot uses its
   Cloudflare-managed `workers.dev` address without changing production DNS; a
   first-party hostname remains preferred as a separately approved follow-up.
   Do not put API keys, upload credentials, signed management URLs, or private
   originals into either manifest.

## Manifest Entry

Each manifest uses schema version `1.0` and an `items` array. Order in the array
is display order. The authenticated uploader writes only to the manifest for
the area from which it was opened; it cannot create a shared Family-and-
Everyone upload. The repository retains its defensive rule that, if a future
manual edit places the same `id` in both manifests, the item must be byte-for-
byte identical in both.

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

The uploader must re-read the shared suppression list before it approves a
candidate. It blocks a new item carrying a hidden athlete ID. One hidden tag
suppresses the whole item everywhere, for both photographs and videos; it does
not merely remove the person's label. The owner remains responsible for tagging
every identifiable public-roster person who needs this protection because the
system does not use face recognition. An authenticated athlete-wide exclusion
prepares the existing public ID-only suppression change and identifies all
tagged host objects that need takedown; private names, reasons, and request
notes never enter the public suppression file.

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
  are private repository metadata, are not fields in this schema, and must not
  be present in either public derivative.

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

Gallery work is a standard site change: use a feature branch, a normal Pull
Request, a successful Netlify preview, responsive screenshot review for both
site modes, and explicit approval before merge or publication.
