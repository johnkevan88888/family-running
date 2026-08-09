# Family Running Championships

Age-graded running rankings across generations.

## Update Process

For a routine update that only changes existing website data:

1. Add the results in Excel, save, and close the workbook.
2. Double-click `update-website-data.cmd`, or run `pnpm run data:update`.
3. Review the summarized differences and follow the two guarded prompts.
4. Review the resulting Pull Request and explicitly approve it before merge.

The guided updater creates the branch, exports and validates the complete CSV
bundle, runs all tests, and opens a Pull Request whose title contains
`[skip netlify]`. It never merges or deploys by itself.

Use the full manual workflow for code, workbook-export contract, CSV schema, or
other non-routine changes.

See [Workbook website export workflow](docs/workbook-export-workflow.md).

Website:
https://www.aceofrace.com/
