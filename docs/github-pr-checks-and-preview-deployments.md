# GitHub PR Checks And Preview Deployments

This repository has four Pull Request review pathways:

- standard change: feature branch -> automated tests -> Netlify preview URLs -> John approval -> merge -> production verification;
- no visual change: feature branch -> automated eligibility gate and full tests -> exact diff, responsive screenshots, and any service-specific evidence -> John approval -> merge -> production verification;
- lightweight data refresh: feature branch -> automated eligibility gate and full tests -> responsive screenshots and CSV diff review -> John approval -> merge -> production verification;
- custom-domain configuration: feature branch -> automated eligibility gate and full tests -> responsive screenshots and exact diff review -> John approval -> merge -> DNS and production verification.

## Automated Pull Request Checks

Workflow file:

- `.github/workflows/pr-checks.yml`

The workflow runs on the Pull Request commit. It:

- checks out the Pull Request merge/head content;
- validates any `[skip netlify]` request against the changed-file contracts;
- installs Node 24 and pnpm;
- installs the locked dependencies;
- installs the Playwright Chromium browser;
- runs `pnpm test`;
- uploads responsive screenshots as a workflow artifact.

The release-path gate is a regression and review control, not an independent
security boundary against a contributor deliberately rewriting Pull Request
workflow code. The unmodified rule classifies the validator, its artifact-list
source, and every workflow as preview-relevant controls. A change to any of them
must use the standard preview pathway and receive separate John review; it never
inherits automatic data-refresh merge authority.

Required GitHub status check:

- `Pull Request Checks / Test static site`

## Automated Preview Review Links

Workflow file:

- `.github/workflows/pr-preview-review-links.yml`

For standard Pull Requests targeting `main`, the workflow creates or updates
exactly one bot-maintained comment headed `Family Running preview review links`.
That comment is the authoritative entry point for preview review and includes
the Family link, Everyone link, preview root, and current short head commit SHA.
For Pull Requests whose title contains `[skip netlify]`, it instead maintains a
`Family Running Netlify preview skip requested` comment with exact-diff and
screenshot review instructions. That comment reflects the title only; it does
not prove the diff is eligible. `Pull Request Checks / Test static site` must
pass and classify the pathway.

The workflow uses the verified Netlify hostname stored in its source-controlled configuration. It runs from trusted `main` with `pull_request_target`, does not check out repository code, and does not run Pull Request code.

For the standard pathway, Netlify's Deploy Preview status must be successful
before the deterministic links are treated as ready. Both `?site=family` and
`?site=everyone` must be checked before approval.

Once the workflow exists on `main`, test an implementation update by opening `PR Preview Review Links` in GitHub Actions, choosing **Run workflow**, selecting the branch containing the workflow version to test, entering the target Pull Request number, and running it. The manual route obtains the Pull Request details through the GitHub API and uses the same comment-generation path. Run it again to confirm that the marked comment is updated rather than duplicated.

GitHub only exposes `workflow_dispatch` after the workflow file exists on the default branch. The first Pull Request that introduces this workflow therefore cannot use the manual route or receive an automatic `pull_request_target` run; verify those live paths on the first subsequent Pull Request after this workflow reaches `main`.

## Preview Deployment Provider

Use Netlify Deploy Previews for Pull Request preview URLs. This keeps preview hosting separate from the live GitHub Pages production site.

Repository configuration file:

- `netlify.toml`

Netlify build settings from the repository:

- Build command: `pnpm run preview:build`
- Publish directory: `test-artifacts/preview-site`
- Node version: `24`

The preview build copies only the static runtime site files and `data/` exports into the publish directory. It does not publish docs, scripts, tests, dependency folders, reports, or local artifacts.

## No-Visual-Change Pathway

Use `[skip netlify]` when the exact Pull Request diff cannot alter the static
artifact that Netlify would display. The automated gate requires at least one
changed file and rejects the pathway if any changed path is either:

- published directly or through a copied-whole directory such as `data/`,
  `vendor/`, `assets/`, or `gallery-data/`; or
- a publishing control that can change dependency installation, artifact
  construction, or deployment.

The published-path decision comes from
`scripts/published-site-entries.mjs`, which is also the artifact builder's
source of truth. Adding a new runtime entry therefore makes that file
preview-relevant in the same change. Publishing controls include Netlify and
package-manager configuration, the root package/lock/workspace files, checkout
attributes, artifact-build contracts, the release-path guard itself, and
GitHub workflows. The unmodified gate rejects changes to the guard or its
source-of-truth list; they require the standard pathway plus separate John
review.

The classifier positively recognizes known non-public areas and an explicit
set of reviewed local tools rather than assuming every unlisted path is safe.
An unfamiliar root configuration, future script, or future GitHub action
therefore fails closed and requires the standard preview until it is
deliberately classified.

Documentation, tests, workbook/local release tooling, and private
`gallery-admin/` implementation can qualify when they are not accompanied by a
published or publishing-control file. That does not waive review. The complete
automated suite and responsive screenshots still run, the exact diff must be
reviewed, and a private service or administration surface needs its own
authenticated/environment-specific evidence because the public Netlify site
cannot display it.

Put `[skip netlify]` in the Pull Request title before opening it. Omitting the
marker always selects the standard preview pathway. If the gate rejects a
marked Pull Request, remove the marker and use the standard pathway.

## Lightweight Data-Refresh Pathway

Use this pathway only for a routine full-bundle refresh, such as adding new
race times, when all of the following are true:

- every changed runtime file is an existing CSV below `data/`;
- every tracked public CSV is part of the refreshed bundle;
- no CSV header or schema changes;
- no export is added, removed, or renamed;
- the only optional non-data change is `docs/active-work.md` handoff notes;
- the complete automated suite, including repository safety, bundle
  consistency, CSV validation, browser smoke tests, and responsive screenshots,
  still passes.

Put `[skip netlify]` in the Pull Request title before opening it, for example
`[skip netlify] Refresh August race times`. [Netlify officially supports this
Pull Request title marker](https://docs.netlify.com/deploy/manage-deploys/manage-deploys-overview/#skip-a-deploy)
for skipping a Deploy Preview. Do not use `[skip ci]` because the GitHub checks
must still run.

For routine workbook updates, `pnpm run data:update` is the preferred guided
entry point. It prepares the complete export, preserves the staged review and
promotion boundary, runs the full local suite, verifies lightweight-path
eligibility, and requires `PUBLISH` before opening the correctly titled Pull
Request and waiting for GitHub checks. It then stops for review and requires a
separate `MERGE` confirmation, after which it re-verifies the PR branch, title,
head commit, and required check, merges through the protected pathway, and
waits for the Pages workflow run tied to the exact merge commit. It then
compares every production CSV with the reviewed commit and opens both live site
modes in Chromium. Scoped cleanup happens only after that proof succeeds; a
failure is resumable and never repeats the merge.

The `Pull Request Checks / Test static site` job fails closed if the marker is
used outside the no-visual, data-refresh, or custom-domain contracts. Remove
`[skip netlify]` from the title and push a new commit to return the Pull Request
to the standard preview pathway.

## Custom-Domain Pathway

Use this pathway only when the change includes a valid root `CNAME` and stays
within the explicit CNAME, production-only analytics, Pull Request template,
test, and documentation allowlist enforced by
`scripts/validate-pr-release-path.mjs`. The full automated suite and responsive
screenshots still run. This is a deliberate exception to the ordinary
published-file rule: Netlify's preview hostname cannot verify GitHub Pages DNS,
canonical-host redirects, HTTPS certificate provisioning, or the analytics
loader that is disabled away from approved production hostnames. Verify those
behaviors on production after merge and DNS propagation. Changes to the release
guard or preview-comment workflow cannot accompany this skip pathway.

## Expected Standard-Pathway Preview URLs

For standard-pathway Pull Request `123`, Netlify will use these preview URLs:

- Family: `https://deploy-preview-123--thunderous-moxie-c5aac5.netlify.app/?site=family`
- Everyone: `https://deploy-preview-123--thunderous-moxie-c5aac5.netlify.app/?site=everyone`

The verified Netlify preview hostname is `thunderous-moxie-c5aac5.netlify.app`.

## John Setup Required In GitHub And Netlify

John needs to complete these once:

1. Connect this GitHub repository to a Netlify site.
2. Keep GitHub Pages as the live production site; do not point the production domain at Netlify.
3. Confirm Netlify uses the repository `netlify.toml` build settings.
4. Enable Netlify Deploy Previews for Pull Requests.
5. Open GitHub branch protection for `main`.
6. Require Pull Request review before merge for standard, no-visual, and
   custom-domain changes. Do not add an unconditional review requirement if
   the guided routine-data `PUBLISH` auto-merge path must remain available; its
   explicit local approval is paired with the protected required check.
7. Require `Pull Request Checks / Test static site` before merge.
8. Treat the Netlify Deploy Preview status as a required process gate for the
   standard pathway, but do not configure it as an unconditional repository
   ruleset check because eligible skip pathways intentionally do not create
   that status.
9. Require John approval before production release.

## Why Not GitHub Pages For PR Previews

GitHub Pages deployment actions publish artifacts to the GitHub Pages site. This repository already uses GitHub Pages as production, so PR preview deployments must not target GitHub Pages. Netlify previews provide unique Pull Request URLs without replacing production.

## Release Gate

No passing automated tests, no release.

For standard changes: no successful Netlify Deploy Preview status and no review
of both automated Family and Everyone links, no release.

For validated no-visual changes: no accepted eligibility gate, exact diff
review, responsive screenshot review, and any required service-specific
evidence, no release.

For validated lightweight data refreshes: no accepted eligibility gate, exact
CSV diff review, and Family and Everyone responsive screenshot review, no
release.

For validated custom-domain changes: no accepted eligibility gate, exact diff
and screenshot review, and post-merge DNS/HTTPS production verification, no
release.

No explicit John approval, no release. For the guided routine-data command,
typing `MERGE` after reviewing the Pull Request diff and its uploaded
screenshots is that explicit approval; every other pathway retains a separate
Pull Request approval.
