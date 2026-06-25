# Testing And Release Protocol

This project is a static GitHub Pages site. Excel/VBA remains the private source of truth for calculations and exports CSV files for the website. JavaScript must only render exported data; it must not calculate age grades, rankings, crowns, medal positions, target times, or championship status.

## Local Setup

Install Node.js and pnpm if they are not already available.

Install the Node development dependency once:

```bash
pnpm install
```

If Playwright cannot find a browser on your machine, install Chromium for Playwright:

```bash
pnpm exec playwright install chromium
```

## Local Commands

Run all automated checks:

```bash
pnpm test
```

Run repository safety validation only:

```bash
pnpm run validate:safety
```

Run CSV validation only:

```bash
pnpm run validate:csv
```

Run browser smoke tests and capture screenshots:

```bash
pnpm run test:browser
```

Start the local static preview:

```bash
pnpm run preview
```

Refresh responsive screenshots:

```bash
pnpm run screenshots:update
```

Local preview URLs:

- Family: `http://127.0.0.1:4173/?site=family`
- Everyone: `http://127.0.0.1:4173/?site=everyone`

## What The Automated Checks Cover

Repository safety validation checks tracked files and fails if a private workbook, Excel temporary file, obvious credential file, or private workbook backup-like file is tracked.

CSV validation checks `data/family/`, `data/everyone/`, and shared `data/athlete_results.csv`. It verifies required files, required headers, parseable CSV structure, matching row lengths, referenced leaderboard files, athlete IDs used by links, parseable dates, parseable numeric fields, parseable times, non-empty Hall of Fame data, and non-empty enabled championship files. Vacant states such as "Championship Vacant" and "No eligible results" are accepted.

Browser smoke tests run the site through a local static server for:

- `/?site=family`
- `/?site=everyone`

They check that each mode loads, uses the expected site title, renders Hall of Fame cards and leaderboards, exposes athlete links where athlete data exists, opens an athlete profile, preserves the original `site` parameter in the back link, handles collapsible sections, renders vacant Hall of Fame states, has no JavaScript exceptions, and has no failed same-origin network requests.

Screenshots are saved to `test-artifacts/screenshots/` for:

- Family desktop, 1440 x 900
- Family mobile, 390 x 844
- Everyone desktop, 1440 x 900
- Everyone mobile, 390 x 844

Generated screenshots and reports are ignored by Git.

## Manual Review Checklist For John

Before approving a Pull Request:

- Confirm the purpose and scope are clear.
- Review the files changed and why.
- Confirm any CSV schema impact is intentional.
- Confirm any Excel/VBA impact is intentional.
- Check automated test results.
- Open both preview URLs:
  - `?site=family`
  - `?site=everyone`
- Review desktop and mobile screenshots.
- Manually check Hall of Fame, leaderboards, collapsible sections, athlete links, athlete profile pages, and back links.
- Confirm known limitations and rollback approach are documented.

## Release Gate

No preview, no release.

No passing tests, no release.

No explicit John approval, no release.

## Proposed Workflow

1. Create a feature branch.
2. Make the smallest safe change.
3. Run all local checks.
4. Open a Pull Request and wait for GitHub checks plus Netlify Deploy Preview URLs.
5. John reviews the preview, screenshots, manual test steps, limitations, and rollback plan.
6. Merge to `main` only after John explicitly approves production.
7. Verify production after GitHub Pages updates.

## Pull Request Checks And Preview URLs

GitHub Actions runs `.github/workflows/pr-checks.yml` for Pull Requests targeting `main`.

Netlify Deploy Previews should be connected by John to produce public PR preview URLs:

- Family: `https://deploy-preview-PR_NUMBER--NETLIFY_SITE_NAME.netlify.app/?site=family`
- Everyone: `https://deploy-preview-PR_NUMBER--NETLIFY_SITE_NAME.netlify.app/?site=everyone`

The Netlify build uses `netlify.toml`, runs `pnpm run preview:build`, and publishes `test-artifacts/preview-site`.

## Production Verification

After an approved release reaches GitHub Pages, verify:

- [Family production](https://johnkevan88888.github.io/family-running/?site=family)
- [Everyone production](https://johnkevan88888.github.io/family-running/?site=everyone)

Check that both modes load, Hall of Fame renders, leaderboards render, athlete links open, and back links preserve the correct mode.

## Rollback

If production verification fails:

1. Stop further changes.
2. Capture the failure details and affected URL.
3. Revert the merge commit or restore the last known good commit on `main`.
4. Wait for GitHub Pages to republish.
5. Re-run production verification for both site modes.

## GitHub Settings To Configure Later

John will need to configure these manually in GitHub when ready:

- Branch protection for `main`.
- Required Pull Request review before merge.
- Required automated checks before merge: `Pull Request Checks / Test static site`.
- Required Netlify Deploy Preview status before merge.
- GitHub Pages production deployment permissions.
- Optional environment protection requiring John approval before production release.

More detail: [GitHub PR checks and preview deployments](github-pr-checks-and-preview-deployments.md).
