# Testing And Release Protocol

This project is a static GitHub Pages site. Excel/VBA remains the private source of truth for calculations and exports CSV files for the website. JavaScript must only render exported data; it must not calculate age grades, rankings, crowns, medal positions, target times, records, or championship status.

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

Run focused export-bundle failure regression tests:

```bash
pnpm run test:export-bundle
```

Run staged-export workflow regression tests:

```bash
pnpm run test:staged-export
```

Run browser smoke tests and capture screenshots:

```bash
pnpm run test:browser
```

Build the Netlify/GitHub preview artifact:

```bash
pnpm run preview:build
```

Start the local static preview:

```bash
pnpm run preview
```

Refresh responsive screenshots:

```bash
pnpm run screenshots:update
```

Generate, validate, and reconcile a private-workbook export without changing
tracked data:

```powershell
pnpm run workbook:export:staged
pnpm run workbook:validate:staged --staged "<STAGED_EXPORT_ROOT>"
pnpm run workbook:compare:staged --staged "<STAGED_EXPORT_ROOT>"
```

See [Workbook website export workflow](workbook-export-workflow.md). Promotion
is a separate explicitly approved command and is never part of automated
export or validation.

Local preview URLs:

- Family: `http://127.0.0.1:4173/?site=family`
- Everyone: `http://127.0.0.1:4173/?site=everyone`

## What The Automated Checks Cover

Repository safety validation checks tracked files and fails if a private workbook, Excel temporary file, obvious credential file, or private workbook backup-like file is tracked.

CSV validation checks `data/family/`, `data/everyone/`, and shared `data/athlete_results.csv`. Excel/VBA generates one `ExportBundleID` per full export and appends it to every public data CSV. VBA writes `data/export_manifest.csv` last, making it the export-completion and consistency contract. Its exact schema is `ExportBundleID,ExportedAtUTC,SchemaVersion,Scope,RelativePath,DataRowCount`, with schema version `1.0`, scopes limited to `family`, `everyone`, and `shared`, repository-relative paths, and row counts excluding headers. Validation rejects missing manifests, invalid schemas or paths, missing or mixed IDs, bundle mismatches, missing or unlisted files, duplicate manifest paths, inconsistent manifest metadata, and wrong row counts, so partial, stale, or mixed exports cannot pass release checks.

The existing content checks remain in force: required files and headers, parseable CSV structure, matching row lengths, leaderboard files referenced by `webtables.csv`, athlete IDs used by links, official medal exports, parseable dates, numeric fields and times, non-empty Hall of Fame data, and non-empty enabled championship files. Validation also enforces the exact `crown_history.csv` contract, crown order and chronology, transition and previous-holder rules, and final-holder agreement with the All-Time Official Hall of Fame without deriving history in JavaScript. Athlete medals remain Excel-owned exports and are rendered directly from `official_medals.csv`; their rows must match the current exported official leaderboards. When present, `absolute_records.csv` must be a workbook-owned official raw-time export with Men and Women records, source-row audit fields, and no browser-derived record calculation. Vacant states such as "Championship Vacant" and "No eligible results" are accepted.

Analytics configuration tests prove that GoatCounter loads only for the
production `johnkevan88888.github.io/family-running` site. Local runs, Netlify
previews, and unrelated GitHub Pages paths must not load it. The tests also
verify that Family and Everyone paths stay distinct, unrelated query parameters
are discarded, and only public athlete IDs are retained on profile paths. They
also lock the integration to GoatCounter's current recommended loader without
the stale subresource-integrity pin that previously caused browsers to block
the script before it could submit a visit.

Focused regression tests copy `data/` to temporary directories and prove validation rejects a changed CSV bundle ID, a CSV omitted from the manifest, and an incorrect manifest row count. Production CSVs are not mutated by these tests.

Staged-export regression tests also prove that a complete copied bundle
validates, volatile bundle metadata is ignored during reconciliation,
meaningful content changes are reported, and an incomplete staged file set is
rejected. They also enforce the fail-closed staging-root rules: only an
absolute, canonical, immediate child of the repository's ignored
`test-artifacts/workbook-export-staging/` parent is accepted; repository root,
tracked `data/`, descendants of `data/`, relative paths, nested staging paths,
and ambiguous paths are rejected.

The preview artifact build copies the static runtime pages, JavaScript, styles,
and public `data/` bundle into `test-artifacts/preview-site`, then fails if a
required runtime file is absent from the publish directory.

Browser smoke tests run the site through a local static server for:

- `/?site=family`
- `/?site=everyone`

They check that each mode loads, uses the expected site title, renders Hall of Fame cards and leaderboards, requests only the selected mode's crown history, preserves the exported crown order and values, handles timeline expansion, empty exports and incomplete legacy identities, preserves the selected site in holder links, exposes athlete links where athlete data exists, opens an athlete profile, preserves the original `site` parameter in the back link, renders athlete medals exported by Excel directly from `data/<site>/official_medals.csv` without requesting leaderboard CSVs for those medal cards, renders the Records page empty state while tracked data has no absolute-records export, and never renders `ExportBundleID` names or values in tables or cards. They also check synthetic absolute-records data for Men and Women rendering, selected-site-only CSV requests, linked and unlinked athletes, empty exported record states, collapsible sections, vacant Hall of Fame states, horizontal overflow, JavaScript exceptions, and failed same-origin network requests.

The macro-enabled source workbook and its dated private backups stay outside Git. Only VBA-generated public CSVs and `data/export_manifest.csv` belong in the repository.

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
- Confirm Netlify's Deploy Preview status is successful.
- Use the bot-maintained `Family Running preview review links` PR comment as the authoritative review entry point.
- Open both review links:
  - `?site=family`
  - `?site=everyone`
- Review desktop and mobile screenshots.
- Manually check Hall of Fame, All-Time Official Crown Progression, Records, leaderboards, collapsible sections, athlete links, athlete profile pages, and back links.
- For record changes, review the private workbook's `AbsoluteRecords` sheet and the staged `absolute_records.csv` files before approving tracked data promotion.
- Confirm known limitations and rollback approach are documented.

## Release Gate

No preview, no release.

No passing tests, no release.

No explicit John approval, no release.

## Proposed Workflow

1. Create a feature branch.
2. Make the smallest safe change.
3. Run all local checks.
4. Open a Pull Request and wait for GitHub checks, a successful Netlify Deploy Preview status, and the automated preview-review-links comment.
5. John reviews the preview, screenshots, manual test steps, limitations, and rollback plan.
6. Merge to `main` only after John explicitly approves production.
7. Verify production after GitHub Pages updates.

## Pull Request Checks And Preview URLs

GitHub Actions runs `.github/workflows/pr-checks.yml` for Pull Requests targeting `main`.

`.github/workflows/pr-preview-review-links.yml` creates or updates one bot-maintained PR comment containing the authoritative review links:

- Family: `https://deploy-preview-PR_NUMBER--thunderous-moxie-c5aac5.netlify.app/?site=family`
- Everyone: `https://deploy-preview-PR_NUMBER--thunderous-moxie-c5aac5.netlify.app/?site=everyone`

The deterministic URLs are available immediately, but they are not ready for review until Netlify's Deploy Preview status succeeds. Review both site modes before approval.

Once the workflow exists on `main`, test it manually by opening `PR Preview Review Links` in GitHub Actions, choosing **Run workflow**, selecting the implementation branch, entering the Pull Request number, and running it. Re-running it updates the same marked comment rather than adding another. GitHub does not expose `workflow_dispatch` for the first Pull Request that introduces a workflow because the workflow file is not yet on the default branch.

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
