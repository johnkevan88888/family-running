# GitHub PR Checks And Preview Deployments

This repository is now prepared for the Pull Request gate:

feature branch -> automated tests -> preview URLs -> John approval -> merge -> production verification.

## Automated Pull Request Checks

Workflow file:

- `.github/workflows/pr-checks.yml`

The workflow runs for Pull Requests targeting `main` and for manual dispatches. It:

- checks out the repository;
- installs Node 24 and pnpm;
- installs the locked dependencies;
- installs the Playwright Chromium browser;
- runs `pnpm test`;
- uploads responsive screenshots as a workflow artifact.

Recommended required GitHub status check:

- `Pull Request Checks / Test static site`

## Automated Preview Review Links

Workflow file:

- `.github/workflows/pr-preview-review-links.yml`

For Pull Requests targeting `main`, the workflow creates or updates exactly one bot-maintained comment headed `Family Running preview review links`. That comment is the authoritative entry point for preview review and includes the Family link, Everyone link, preview root, and current short head commit SHA.

The workflow uses the verified Netlify hostname stored in its source-controlled configuration. It runs from trusted `main` with `pull_request_target`, does not check out repository code, and does not run Pull Request code.

Netlify's Deploy Preview status must be successful before the deterministic links are treated as ready. Both `?site=family` and `?site=everyone` must be checked before approval.

For a manual test, open `PR Preview Review Links` in GitHub Actions, choose **Run workflow**, select the branch containing the workflow version to test, enter the target Pull Request number, and run it. The manual route obtains the Pull Request details through the GitHub API and uses the same comment-generation path. Run it again to confirm that the marked comment is updated rather than duplicated.

## Preview Deployment Provider

Use Netlify Deploy Previews for Pull Request preview URLs. This keeps preview hosting separate from the live GitHub Pages production site.

Repository configuration file:

- `netlify.toml`

Netlify build settings from the repository:

- Build command: `pnpm run preview:build`
- Publish directory: `test-artifacts/preview-site`
- Node version: `24`

The preview build copies only the static runtime site files and `data/` exports into the publish directory. It does not publish docs, scripts, tests, dependency folders, reports, or local artifacts.

## Expected Preview URLs

For Pull Request `123`, Netlify will use these preview URLs:

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
6. Require Pull Request review before merge.
7. Require status checks before merge:
   - `Pull Request Checks / Test static site`
   - the Netlify Deploy Preview status check
8. Require John approval before production release.

## Why Not GitHub Pages For PR Previews

GitHub Pages deployment actions publish artifacts to the GitHub Pages site. This repository already uses GitHub Pages as production, so PR preview deployments must not target GitHub Pages. Netlify previews provide unique Pull Request URLs without replacing production.

## Release Gate

No passing automated tests, no release.

No successful Netlify Deploy Preview status and no review of both automated Family and Everyone links, no release.

No explicit John approval, no release.
