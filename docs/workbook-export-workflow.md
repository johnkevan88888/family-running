# Workbook Website Export Workflow

Excel/VBA is the private source of truth. The workbook creates a complete
website-data bundle in a fresh ignored staging folder. Repository tooling then
validates and compares that bundle. Promotion to tracked `data/` is a separate,
explicit action after human review.

The existing core workbook entry point is:

`ExportWebsiteDataIncludingCrownStandards`

The complete automation wrapper, including athlete comparison targets, is:

`AthleteComparisonExport.ExportWebsiteDataIncludingAthleteComparisonForAutomation(stagingRoot)`

The approved staging parent is a hardcoded VBA constant in the private workbook:

```vba
Private Const STAGING_PARENT As String = "C:\GitHub\family-running\test-artifacts\workbook-export-staging\"
```

Note the trailing backslash, which the constant includes. For the operating
release workspace the path is:

`C:\GitHub\family-running\test-artifacts\workbook-export-staging`

**This is not portable.** Moving or cloning the repository to a different path
breaks exporting until that constant is edited by hand, and the workbook's
rejection message names only the parent it expects, not the root it was given.
`scripts/run-workbook-staged-export.ps1` prints both so a mismatch is legible.

An earlier version of this document claimed the parent was read from a
`Settings!tbSettings` setting named `Approved Staging Root`, and that no absolute
path was embedded in VBA. That was never true of the workbook. See
`docs/decision-log.md` for the correction. Making it genuinely portable remains
open workbook work.

The supplied export root must be a fresh, immediate child of the configured
parent after canonical path normalization.
The gate rejects relative or ambiguous paths, the repository root, tracked
`data/`, and every descendant of tracked `data/`.

The legacy direct-to-`data/` path has been retired. A workbook export must never
start by overwriting tracked public data.

## Authoritative export-bundle contract

Repository validation in `scripts/validate-csv.mjs` is authoritative.

- The manifest path is exactly `data/export_manifest.csv`.
- Its ordered schema is exactly:
  `ExportBundleID,ExportedAtUTC,SchemaVersion,Scope,RelativePath,DataRowCount`.
- `SchemaVersion` is `1.0`.
- `ExportBundleID` matches
  `YYYYMMDDTHHMMSSmmmZ-XXXXXXXX`, enforced as
  `^\d{8}T\d{9}Z-[A-F0-9]{8}$`.
- `ExportedAtUTC` is an ISO UTC timestamp with milliseconds.
- Every public CSV except the manifest contains exactly one additive
  `ExportBundleID` column.
- Every nonblank data row carries the same bundle ID as the manifest.
- Every manifest row uses the same bundle ID, timestamp, and schema version.
- `Scope` is `family`, `everyone`, or `shared`.
- Family paths are `data/family/<file>.csv`; Everyone paths are
  `data/everyone/<file>.csv`; shared paths are direct children of `data/`.
- Paths are safe, forward-slash, repository-relative CSV paths.
- `DataRowCount` is a non-negative integer excluding the header.
- Every manifest entry must exist and have the stated row count.
- Every public CSV must appear exactly once in the manifest.
- Family, Everyone, and shared scopes must all be present.

The staged-workflow validator additionally requires the staged public CSV file
set to match the currently tracked contract. The current export contract
contains 68 CSV files: 67 manifest entries plus the manifest itself.

## Workbook guarantees

The workbook exporter:

1. reads the approved staging parent from its `STAGING_PARENT` VBA constant and
   accepts only a canonical, fresh immediate child folder of that exact root;
2. creates `data/`, `data/family/`, and `data/everyone/` inside that folder;
3. calculates the required website-source sheets;
4. runs the workbook's source-coverage validation;
5. exports every enabled Family and Everyone leaderboard plus shared and
   supporting exports;
6. writes UTF-8 CSV without a byte-order mark, using stable workbook order;
7. adds one bundle ID to every public CSV row;
8. rejects missing sources, blank or errored export ranges, duplicate output
   paths, malformed IDs, missing planned files, unregistered CSVs, and wrong
   row counts;
9. runs post-export workbook validation;
10. writes the manifest last; and
11. deletes the incomplete staging folder if any step fails.

The complete export includes leaderboard files, `webtables.csv`,
`siteinfo.csv`, Hall of Fame, official medals, crown history, crown standards,
age-grade standards including `pace_per_km` and `pace_per_mile`, absolute
records, Family and Everyone athlete-comparison targets, and shared
`athlete_results.csv`.

## Streamlined routine data update

For a simple existing-schema data refresh, such as adding race times, save and
close Excel and then either double-click `update-website-data.cmd` or run:

```powershell
pnpm run data:update
```

The guided updater:

1. confirms that GitHub CLI is logged in and the repository is clean;
2. fetches current `origin/main` and creates a timestamped `data/refresh-*`
   branch from it;
3. generates a fresh complete staged workbook export;
4. validates and reconciles the bundle without changing tracked data;
5. lists every meaningful CSV difference and requires the exact word
   `PROMOTE` before replacing tracked `data/`;
6. runs the complete repository test and responsive screenshot suite;
7. confirms that every tracked CSV was refreshed, no header changed, and the
   tested data-diff fingerprint still matches;
8. requires the exact word `PUBLISH` before committing, pushing, and opening a
   `[skip netlify]` Pull Request;
9. waits for GitHub checks, then stops and prints the Pull Request, its exact
   diff command, and the run holding the responsive-screenshot artifact;
10. requires the exact word `MERGE` as explicit production approval, then
    re-verifies the PR title, base branch, data branch, exact tested head
    commit, and required check before merging through the protected Pull
    Request pathway; and
10. fast-forwards local `main`, deletes the verified merged branch locally and
    remotely, and removes only the staged export, promotion backup, and state
    paths recorded for that update.

This automatic merge authority is limited to the existing fail-closed routine
data pathway. Code, schema, configuration, export-set, and broader
documentation changes still use the manual release process.

If the command is stopped at either review point, resume the same staged update
without copying its path:

```powershell
pnpm run data:update -- --resume
```

For a non-interactive preparation that stops before promotion:

```powershell
pnpm run data:update -- --prepare-only
```

The updater refuses dirty worktrees, overlapping open data-update Pull
Requests, incomplete bundles, changed CSV schemas, non-data changes, failed
validation, changed post-test data, failed local or GitHub tests, mismatched PR
identity, and non-fast-forward local `main`. Use the manual workflow below for
schema, export-set, code, configuration, or broader documentation changes.

## Safe refresh commands

Run commands from the repository root on Windows.

### 1. Generate a fresh staged export

```powershell
pnpm run workbook:export:staged
```

The command prints:

```text
STAGED_EXPORT_ROOT=<absolute path>
```

The default private workbook is resolved from the sibling
`_private_workbooks` folder. To override it:

```powershell
pnpm run workbook:export:staged -WorkbookPath "C:\path\source.xlsm"
```

The wrapper derives the approved staging parent from the current repository
root and refuses an alternate `-StagingBase`. The workbook independently checks
the same root against its hardcoded `STAGING_PARENT` constant, so the two must
be kept in step by hand.

### 2. Validate the staged bundle

```powershell
pnpm run workbook:validate:staged --staged "<STAGED_EXPORT_ROOT>" --approve-new-files "data/family/athlete_comparison_targets.csv,data/everyone/athlete_comparison_targets.csv"
```

This runs the existing full CSV and bundle validation and verifies the public
file set, with the two new contract files named explicitly until they are
promoted and tracked.

### 3. Compare with tracked public data

```powershell
pnpm run workbook:compare:staged --staged "<STAGED_EXPORT_ROOT>" --approve-new-files "data/family/athlete_comparison_targets.csv,data/everyone/athlete_comparison_targets.csv"
```

The comparison ignores only:

- `ExportBundleID` values;
- manifest `ExportedAtUTC`; and
- each `siteinfo.csv` `LastUpdatedUTC` value.

Everything else, including headers, row order, row counts, and display values,
is meaningful. A JSON report is written to
`<STAGED_EXPORT_ROOT>\reconciliation.json`. Exit code `2` means meaningful
differences require review; it does not mean the staged bundle is invalid.

### 4. Review

Review:

- the staged manifest and reconciliation report;
- every meaningful changed file;
- Family and Everyone output;
- representative age-grade pace values;
- repository tests and responsive browser screenshots.

Unexpected data differences are blockers. Do not change workbook-owned
results, standards, ranks, medals, crowns, or athlete data merely to make a
comparison pass.

### 5. Promote only after explicit approval

Promotion is intentionally separate and is not run by export, validation, or
comparison:

```powershell
pnpm run workbook:promote:staged --staged "<STAGED_EXPORT_ROOT>" --approve
```

If reviewed meaningful differences are intentional, explicit approval also
requires:

```powershell
pnpm run workbook:promote:staged --staged "<STAGED_EXPORT_ROOT>" --approve --approve-differences
```

If the staged bundle intentionally adds new public CSV contract files, name each
new file explicitly:

```powershell
pnpm run workbook:promote:staged --staged "<STAGED_EXPORT_ROOT>" --approve --approve-differences --approve-new-files "data/family/athlete_comparison_targets.csv,data/everyone/athlete_comparison_targets.csv"
```

Promotion refuses to run when tracked `data/` already has local changes. It
revalidates an isolated candidate, swaps the complete directory, and retains
the previous local data under ignored `test-artifacts/` for rollback. After
promotion, review the Git diff and run `pnpm test` before committing.

Never promote by selectively copying CSV files.

## Failure recovery

- A failed workbook export leaves no staged bundle.
- A staged validation or comparison failure never changes tracked data.
- A failed promotion attempts to restore the previous `data/` directory.
- A failed GitHub check or merge retains the saved state for `--resume` and
  does not delete the data branch or its rollback artifacts.
- Successful merge cleanup removes only paths recorded in that update's state;
  unrelated ignored test artifacts and older manual backups are retained.
- The private workbook and its timestamped backups remain outside Git.
