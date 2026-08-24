# Curated Gallery Publishing Workflow

Phase 1 is an owner-curated public gallery. It deliberately does not accept
visitor uploads and does not put photographs or videos into Git or the GitHub
Pages artifact.

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
5. Prefer a first-party media hostname when storage is selected. Do not put API
   keys, upload credentials, signed management URLs, or private originals into
   either manifest.

## Manifest Entry

Each manifest uses schema version `1.0` and an `items` array. Order in the array
is display order. A shared item may be copied into both manifests, but an item
with the same `id` must be byte-for-byte identical in both.

The future uploader follows the same constrained sequence the manifest
validator enforces:

1. Select a race date from the dates present in public results for the active
   site mode.
2. Select a race from the distinct event-and-distance combinations exported for
   that date. Distance is part of the race identity because one event can hold
   more than one distance on the same day.
3. Tag people by public athlete ID. People with a result in the selected race
   appear first; the rest of the public site roster remains available so a
   supporter or spectator can be tagged too.

No free-text athlete names or race names are stored. This keeps gallery links
stable and ensures removed or mode-ineligible athletes fail validation rather
than appearing as stale tags.

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
  the future uploader rather than typed as free text.
- `featured: true` makes the item eligible for Race moments panels on the
  Championships and Overview pages.
- `athleteIds` connects the item to those athlete profiles. Use an empty array
  when no profile association is wanted. The uploader will show people who ran
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
