# Active Work

## Task title

Publish only the built runtime artifact to GitHub Pages

## Status

Implementation and local validation are complete on
`feat/pages-publish-runtime-only`. No merge, release, GitHub Pages settings
change, private workbook access, or workbook modification has been performed.

**This change is not complete on merge alone.** The repository's Pages source is
still `main` branch root (`build_type: legacy`). After merge, the source must be
switched to GitHub Actions or the new workflow will build but not publish:

```bash
gh api -X PUT repos/johnkevan88888/family-running/pages -f build_type=workflow
```

Until that flip, production keeps serving the repository root exactly as it does
today, so merging alone cannot break the live site.

The previous entry described the repository audit remediation pass, released
through PR #33 and recorded in PR #34.

## Why

GitHub Pages served the repository root, so every tracked non-runtime file was
publicly readable at its path on the production domain. Verified against the
live site: `AGENTS.md`, `docs/active-work.md`, `docs/decision-log.md`, and
`package.json` all returned HTTP 200 on `www.aceofrace.com`.

No credential, private workbook, or VBA source was exposed; repository safety
validation covers those and passes. The issue is that internal documentation
describing the private workbook, the staging and promotion workflow, and known
governance gaps was readable by anyone who guessed a path.

## Scope

- Add `.github/workflows/deploy-pages.yml`, which builds the runtime artifact and
  deploys it to Pages on every push to `main`.
- Add `CNAME` to `runtimeEntries` and to the build's required-file check, so the
  `www.aceofrace.com` custom domain survives publishing an artifact instead of
  the repository root.
- Fail the build if documentation, scripts, tests, workflow files, or repository
  configuration ever appear in the artifact.
- Add a `build:site` script alias so the production path reads clearly. It runs
  the same builder Netlify already uses, so previews and production stay
  identical.

No page, style, script, CSV, or workbook change. Nothing about what the site
renders is affected.

## Validation results

- Full `pnpm test` passed.
- The artifact was built and inspected: 92 files, containing only `CNAME`,
  `.nojekyll`, the seven public pages, their styles and scripts, `vendor/`, and
  `data/`. Confirmed absent: `docs/`, `scripts/`, `tests/`, `.github/`,
  `AGENTS.md`, `README.md`, `package.json`, `netlify.toml`.
- **Completeness was proven, not assumed.** The full browser smoke suite was run
  against the artifact alone, with the site served from
  `test-artifacts/preview-site` rather than the repository:

  ```bash
  SITE_ROOT=test-artifacts/preview-site node tests/browser-smoke.mjs
  ```

  It passed for both site modes across desktop and mobile, covering every public
  page, athlete profiles, the progression chart, crown history, medals,
  age-grade standards, and pace switching. Nothing the browser needs was left
  out of the published set.

## Known limitations and follow-up opportunities

- Exported public CSVs under `data/` remain publicly readable. That is by
  design, since the browser fetches them, but it does mean athlete names, age
  categories, event names, and dates stay public and indexable. There is still
  no `robots.txt`, so they remain open to search engines and scrapers. Adding
  one is a small, separate change if wanted.
- The repository itself remains public, so all of the above is readable on
  GitHub regardless of what Pages serves. Only the live-site exposure is closed
  by this change.
- The new workflow pins its actions by tag, matching the existing workflows.
  Pinning deployment actions by commit SHA would be stronger.

## Handoff notes

- Merge, then run the `build_type=workflow` command above, then confirm
  production still serves the site and that `www.aceofrace.com/AGENTS.md` now
  returns 404 while the site itself still works.
- Check both `?site=family` and `?site=everyone` after the first Actions deploy.
- Rollback is to set `build_type` back to `legacy` with `-f source[branch]=main`
  and `-f source[path]=/`, which restores the current behaviour immediately.
