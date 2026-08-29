# Purpose And Scope

-

# Files Changed And Why

-

# Data / CSV Schema Impact

-

# Excel / VBA Impact

-

# Automated Test Results

- [ ] Repository safety validation passed.
- [ ] CSV validation passed for `data/family/`.
- [ ] CSV validation passed for `data/everyone/`.
- [ ] Browser smoke tests passed for `?site=family`.
- [ ] Browser smoke tests passed for `?site=everyone`.

# Release Path

- [ ] Standard change: use the Netlify Deploy Preview and review both site modes.
- [ ] No visual change: the title contains `[skip netlify]`, and the automated gate confirms that every changed file is a recognized non-public path which neither enters nor controls the published artifact.
- [ ] Lightweight data refresh: the Pull Request title already contains `[skip netlify]`, and the diff contains the complete existing-schema CSV bundle under `data/`, its exact generated `gallery-admin/generated/catalog-snapshot.js`, plus optional `docs/active-work.md` notes.
- [ ] Custom-domain configuration: the title contains `[skip netlify]`, the diff includes a valid root `CNAME`, and only the domain/analytics allowlist is changed.

All three skip pathways still run every automated check and upload responsive screenshots. A no-visual change may also need service-specific evidence that Netlify cannot provide. The no-visual route accepts only recognized non-public paths. Published files or publishing controls require the standard pathway unless the diff qualifies under the separate narrow data/custom-domain contracts; an unclassified path also requires the standard pathway.

# Preview Review Links

For the standard pathway, use the bot-maintained `Family Running preview review links` PR comment as the authoritative review entry point. Wait for Netlify's Deploy Preview check to succeed before treating its links as ready, then inspect both `?site=family` and `?site=everyone`.

For a requested skip pathway, the bot comment records the `[skip netlify]` title marker only. Treat the skip as validated only when `Pull Request Checks / Test static site` passes and classifies the diff as eligible. Then review the exact diff and the uploaded Family and Everyone screenshots instead.

# Manual Test Steps For John

1. Standard pathway: open the Family and Everyone previews.
2. No-visual pathway: review the exact diff, confirm the automated gate accepted it, and review any relevant non-Netlify evidence for private services or local tooling.
3. Lightweight pathway: review the exact CSV diff and generated private Gallery catalogue, then confirm the Pull Request Checks workflow accepted the routine-data classification.
4. Custom-domain pathway: review `CNAME`, the analytics host/path tests, and the exact allowlisted diff; verify the real domain after merge and DNS propagation.
5. Check Hall of Fame, leaderboards, collapsible sections, athlete links, athlete profile pages, and back links in the available review artifact.
6. Check desktop and mobile screenshots for both site modes.

# Desktop And Mobile Screenshots

- [ ] Family desktop screenshot attached.
- [ ] Family mobile screenshot attached.
- [ ] Everyone desktop screenshot attached.
- [ ] Everyone mobile screenshot attached.

# Known Limitations

-

# Rollback Approach

-

# Production Approval

- [ ] John explicitly approves production release after the applicable Netlify-preview or validated-skip evidence review.
