# Championship photo framing

The separate local editor below remains available for already-public photos.
The approved local upload integration additionally offers browser face
suggestions and manual controls inside the protected uploader, with private
saving and fresh-review snapshots. See
[Automatic upload face framing](gallery-upload-face-framing.md). Neither path
identifies people or changes consent. Repository release alone does not activate
the protected uploader.

## What changes

The small championship podium pictures have their own manual framing. Pick the
person's face and adjust the zoom; the podium stays the same size. The Gallery
card and enlarged viewer still show the whole photograph. Race moments and
video posters are unchanged. Rankings, medals, exported rows and photo selection
remain unchanged: each athlete still gets their first eligible approved photo.

This is manual framing, not face detection or recognition. It cannot guarantee
a face without an owner choosing the position for that particular photo/person.
Without a saved framing, show the entire thumbnail using `contain`, never a
guessed centre crop. A group photo can have a different framing for each of its
already-public tagged athletes.

## Use the local editor

From the repository, run:

```powershell
node scripts/gallery-podium-editor.mjs --site family
```

Use `--site everyone` to edit that mode's existing approved photos instead.

1. Open the complete local link printed by the command. It works on this
   computer only; its temporary token is not a Cloudflare or GitHub credential.
2. Choose an approved photo and the pictured public athlete. Suppressed photos
   are not offered. An athlete's public ID is shown to avoid inventing a name.
3. Click the face in the complete photograph. Adjust horizontal/vertical
   position and zoom, checking both preview shapes. The exact crop adapts to
   the real podium's dimensions, which vary with screen size and medal slot.
4. Click **Save framing locally**. **Reset to whole photo** changes the preview;
   click Save to retain that reset. Saving a different photo does not change
   which photo the championship selects.
5. Review the normal championship preview and desktop/mobile screenshots.
   Saving is not publication: use the standard PR, required checks and Netlify
   preview, with explicit approval before push, PR creation, merge or deployment.

Stop the local command with Ctrl+C. No Worker deployment, database migration,
new image derivative, original upload or private-original read is needed.
The existing protected uploader is unchanged; this local editor is not a new
public or protected upload route.

## Presentation-only contract

`gallery-podium-framing.js` supplies the shared validator, generation-specific
key and crop geometry to the championship and local editor. The root file
`gallery-podium-framing.json` contains exactly:

```json
{
  "schemaVersion": "1.0",
  "frames": {
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": {
      "x": 50,
      "y": 15,
      "zoom": 2
    }
  }
}
```

Keys are lowercase SHA-256 digests of the UTF-8 JSON encoding of:

```text
["gallery-podium-framing-v1", item.id, athleteId, item.sourceUrl, item.thumbnailUrl]
```

The inputs for this legacy settings file come only from an existing, valid,
unsuppressed public manifest.
The digest is a lookup key, **not anonymisation or access control**: somebody
with those public inputs can reproduce it. Store no private person IDs, names,
tags, notes, URLs, consent information, biometrics or image bytes in this file.
Coordinates are image percentages, not geographic coordinates. `x` and `y` must
be finite numbers from 0 to 100; zoom must be finite from 1 to 8. The document is
bounded to 2,000 entries and a regular JSON file of at most 512 KiB. Unsupported
fields, inherited/accessor properties and malformed values are rejected.

The main manifest and whole-item suppression list must validate BEFORE looking
up any framing. Crop settings cannot choose a photo, add a person or URL, grant
consent, reveal a suppressed image or bypass public eligibility. A new item or
either changed URL gives a new key; a restored generation never silently reuses
its predecessor's framing. Inert leftover digests may remain after withdrawal:
they contain no explicit identity or URL and cannot render anything. This keeps
the existing one-file manifest-review/removal contract intact, without changing
saved consent, reviewed photo fields, manifest hashes or terminal evidence.

Fresh photo items may instead carry a strict public-athlete-only `podiumFraming`
field included in their exact immutable review. Those reviewed settings take
precedence for that item/person; they do not edit this legacy file or introduce
a second file into the manifest-candidate PR. Private fields never enter either
public representation. Missing framing on both paths retains whole-photo display.

For a configured photo, the podium uses its already-approved display derivative
for detail. It scales proportionally, centres the selected point and clamps the
offsets so no empty edges appear. It recomputes on image load, viewport/frame
resize and newly visible tables. An optional crop-config failure, unavailable
secure hashing or a 2.5-second config timeout keeps whole-photo presentation;
missing/malformed suppression still denies all Gallery media as before.

## Tool and publication boundaries

The editor binds only `127.0.0.1`, serves a fixed asset/route allowlist, requires
the ephemeral token plus same-origin Host/Origin checks for saves, bounds bodies,
and rechecks the selected public photo, tags, suppression and full file revision.
It refuses stale saves and preserves unrelated settings. It writes only the
fixed framing JSON using a local lock and atomic replacement. It does not proxy
media or contact GitHub/Cloudflare. Its browser loads only existing public
display URLs. Files under `scripts/gallery-podium-editor/` are NOT published.

The published runtime explicitly adds only the shared framing script and numeric
JSON. The artifact build validates the copied JSON, rejects private/unknown
fields, and keeps `gallery-data/` at its original exact three-file contract.
An ordinary build now has 117 public files rather than the previous 115.
Changes to the build's framing validator are publishing-control changes and
cannot use a preview-skipping release.

Run the framing validator and three focused tests, followed by the full suite:

```powershell
node scripts/validate-gallery-podium-framing.mjs
node tests/gallery-podium-framing.mjs
node tests/gallery-podium-editor.mjs
node tests/gallery-podium-framing-browser.mjs
node scripts/run-all-tests.mjs
```

Focused browser tests use synthetic face markers and invented media URLs only.
The already-public Toronto derivative can be viewed separately in a local
preview; that is not a private-original read, reprocessing or live publication.
