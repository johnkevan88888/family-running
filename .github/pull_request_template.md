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
- [ ] Lightweight data refresh: the Pull Request title already contains `[skip netlify]`, and the diff contains the complete existing-schema CSV bundle under `data/` plus optional `docs/active-work.md` notes.
- [ ] Custom-domain configuration: the title contains `[skip netlify]`, the diff includes a valid root `CNAME`, and only the domain/analytics allowlist is changed.

Both skip pathways still run every automated check and upload responsive screenshots. Changes outside their narrow allowlists require the standard preview pathway.

# Preview Review Links

For the standard pathway, use the bot-maintained `Family Running preview review links` PR comment as the authoritative review entry point. Wait for Netlify's Deploy Preview check to succeed before treating its links as ready, then inspect both `?site=family` and `?site=everyone`.

For a validated skip pathway, the bot comment confirms that Netlify was intentionally skipped. Review the exact diff and the uploaded Family and Everyone screenshots instead.

# Manual Test Steps For John

1. Standard pathway: open the Family and Everyone previews.
2. Lightweight pathway: review the exact CSV diff and confirm the Pull Request Checks workflow accepted the data-only classification.
3. Custom-domain pathway: review `CNAME`, the analytics host/path tests, and the exact allowlisted diff; verify the real domain after merge and DNS propagation.
4. Check Hall of Fame, leaderboards, collapsible sections, athlete links, athlete profile pages, and back links in the available review artifact.
4. Check desktop and mobile screenshots for both site modes.

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

- [ ] John explicitly approves production release after preview review.
