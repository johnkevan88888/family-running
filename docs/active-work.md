# Active Work

## Task title

Restore GoatCounter production visit collection

## Status

Root-cause diagnosis, implementation, and local validation are complete on
`agent/fix-goatcounter-script-load`. The change is published for review through
a draft Pull Request. No merge, release, production publication, or GitHub
setting change has been performed.

## Current approved scope

- Restore production visit collection after browsers blocked GoatCounter's
  versioned loader because its configured subresource-integrity hash no longer
  matched the served content.
- Use GoatCounter's current recommended `https://gc.zgo.at/count.js` loader
  without the stale integrity pin.
- Preserve the production-only host/path guard, Family/Everyone path mapping,
  public athlete IDs, query-parameter minimization, and visible disclosure.
- Add regression coverage that rejects reintroducing an integrity pin on this
  mutable loader configuration.
- Do not change championship data, workbook calculations, CSV schemas, or
  visible championship behaviour.

## Files changed in this pass

- `analytics.js`
- `tests/analytics-config.mjs`
- `docs/active-work.md`
- `docs/testing-and-release-protocol.md`
- `docs/decision-log.md`

## Validation results

- Passed:
  - `pnpm test`
  - `node --check analytics.js`
  - `node tests/analytics-config.mjs`
  - `git diff --check`
- Pre-fix production browser tracing confirmed the browser requested
  `count.v4.js`, blocked it for an integrity digest mismatch, and never sent a
  visit beacon.
- A corrected-file production-host probe reached the current `count.js` loader.
  GoatCounter returned HTTP 204 to the automated headless client, so the probe
  did not add a fake dashboard visit.
- Browser smoke tests regenerated responsive screenshots for Family and
  Everyone at desktop and mobile sizes. This fix has no visual changes.

## Data note

- No workbook, public CSV, export manifest, or championship calculation changed.
- The GoatCounter endpoint and loader URL are public configuration, not
  credentials. No password or API key is stored in the repository.

## Handoff notes

- After an approved production release, open Family and Everyone in a normal
  browser with GoatCounter allowed, then confirm both paths appear in the
  dashboard after its short processing delay.
- Client-side analytics can be blocked by privacy tools, so totals are useful
  indicators rather than guaranteed counts of every visit.

## Recently completed historical work

- PR #21 introduced GoatCounter production analytics. Its integrity-pinned
  versioned loader was blocked in production, prompting this follow-up fix.
- PR #20 added the workbook-owned absolute Records page and was merged before
  this analytics task began.
- PR #18 static navigation review fixes were completed previously on
  `feat/site-navigation`, including the Championships landing, Hall of Fame,
  Overview, shared navigation, and browser smoke coverage.
- The initial static navigation split for PR #18 created separate public pages
  for Overview, Championships, Hall of Fame, and athlete profiles, with shared
  navigation and browser smoke coverage.
- Staging-root portability for private workbook exports was completed and merged
  previously. The workbook now uses `Settings!tbSettings[Approved Staging Root]`
  and tracked `data/` was promoted from a validated staged bundle.
- Export-bundle modernization was completed previously. Workbook exports stage a
  complete manifest-backed bundle before any explicitly approved promotion to
  tracked public data.
