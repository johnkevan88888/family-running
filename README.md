# Family Running Championships

Age-graded running rankings across generations.

## Update Process

For a routine update that only changes existing website data:

1. Add the results in Excel, save, and close the workbook.
2. Double-click `update-website-data.cmd`, or run `pnpm run data:update`.
3. Review the summarized differences and type `PROMOTE` only when they are expected.
4. After the full local suite passes, type `PUBLISH` only when this routine data
   refresh is approved for production.

The guided updater creates the branch, exports and validates the complete CSV
bundle, runs all tests, opens a `[skip netlify]` Pull Request, waits for the
required GitHub check, merges through the protected Pull Request pathway, and
then removes the merged data branch and only that update's saved artifacts.

Use the full manual workflow for code, workbook-export contract, CSV schema, or
other non-routine changes.

See [Workbook website export workflow](docs/workbook-export-workflow.md).

Website:
https://www.aceofrace.com/
