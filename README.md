# Ace of Race

Every age. Every pace. Every race counts.

Ace of Race is a static family running site for age-graded championships,
records, crowns, athlete history, and head-to-head challenges. It preserves
separate Family and Everyone views while sharing one public brand.

The complete identity pack lives in [`branding/`](branding/README.md), with the
shareable brand book in [`output/pdf/`](output/pdf/Ace-of-Race-Brand-Guide.pdf).

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
