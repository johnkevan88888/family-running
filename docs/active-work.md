# Active Work

This file holds the single task John has currently approved. When no task is
active, it records the most recently completed handoff. Roadmap entries are
proposals only. Replace this content when a new task is approved rather than
running multiple active scopes here.

## Task title

No active task

## Task classification

No product or documentation work is currently active or approved.

## Most recently completed task

- Task: Post-merge baseline and release-governance verification.
- Status: complete.
- PR [#12](https://github.com/johnkevan88888/family-running/pull/12)
  merged into `main` on 30 June 2026 as commit
  `3d8b7b7f8ebcfc2263cbae6d0304d3992c3f82f9`.

## Baseline verified by the completed task

- PR [#11](https://github.com/johnkevan88888/family-running/pull/11)
  merged into `main` on 30 June 2026.
- The actual post-merge `main` commit is
  `fa46c14988bc9f7dede21baa823b0e963766d765`.
- After fetching from `origin`, local `main` was fast-forwarded to that commit
  and confirmed clean and exactly aligned with `origin/main`.
- The shared operating layer is present on `main`:
  - `AGENTS.md`
  - `docs/active-work.md`
  - `docs/decision-log.md`
  - `docs/roadmap.md`
- Excel/VBA remains the private source of truth, JavaScript remains
  display-only, and both `?site=family` and `?site=everyone` remain required.

## Documentation-system status

- The shared operating layer introduced by PR #11 is merged and available from
  the default branch.
- This record replaces PR #11's pre-merge handoff state with the verified
  post-merge baseline.
- The post-merge governance verification delivered by PR #12 is complete.
- `docs/decision-log.md` received only the factual release-governance status
  correction discovered by this verification.
- `docs/roadmap.md` is unchanged and remains proposal-only.

## Release-governance verification

- GitHub's REST API reported repository ruleset `main` (ID `18119142`) as
  active and targeting the default branch on 30 June 2026.
- The active ruleset:
  - requires changes to reach `main` through a Pull Request;
  - requires review threads to be resolved;
  - permits merge commits as the only merge method;
  - blocks branch deletion and non-fast-forward updates; and
  - requires the strict `Test static site` status check.
- Governance gaps remain visible:
  - no approving review is required; and
  - Netlify's Deploy Preview is not a required GitHub status check.
- The ruleset also does not require a code-owner or last-push approval.
- The classic branch-protection endpoint required authentication, but the
  applicable ruleset endpoints were available and confirmed active protection.
- No GitHub repository setting was changed by this task.

## Completed scope

- Verify the fetched post-merge baseline and exact `main` commit.
- Verify the presence of the shared operating documents.
- Verify and record the live release-governance safeguards.
- Deliver this handoff update through a focused documentation-only Pull Request.

## Explicitly out of scope

- Product behaviour, presentation, or implementation.
- CSV schemas or production data.
- Excel/VBA workbooks, macros, exports, or backups.
- JavaScript calculations or browser-derived championship outcomes.
- GitHub, Netlify, GitHub Pages, workflow, dependency, or release-setting
  changes.
- Approval or implementation of a roadmap proposal.

## Validation completed

- [x] `pnpm test` — passed repository safety validation (94 tracked files), CSV
  validation for Family and Everyone, export-bundle regression tests, and
  browser smoke tests for both site modes.
- [x] Responsive screenshots were generated only under the ignored
  `test-artifacts/screenshots/` path.
- [x] Final tracked-file audit — only `docs/active-work.md` and the factual
  release-governance correction in `docs/decision-log.md` changed; no
  application, CSV, workflow, dependency, workbook, screenshot, or
  configuration file changed.

## Completed PR and release status

- Pull Request: [#12](https://github.com/johnkevan88888/family-running/pull/12)
  merged as `3d8b7b7f8ebcfc2263cbae6d0304d3992c3f82f9`.
- Post-merge governance verification: complete.
- Product release: not requested.

## Product status

- No product work is active or approved.
- Recommended next product discussion only:
  “Crown History Phase 2: Excel/VBA-exported same-holder All-Time Official crown
  improvements, excluding Current/12-Month history and browser-side
  calculations.”
- This recommendation is not an active task and does not authorise product,
  workbook, CSV, JavaScript, presentation, or release work.

## Codex handoff notes

- Do not begin Crown History Phase 2 unless John explicitly approves it and
  this file is replaced with its exact scope and acceptance criteria.
- Preserve Excel/VBA ownership of calculations and JavaScript's display-only
  role.
- Keep both site modes in every future product and release gate.
- Treat approving-review and required-Netlify-check enforcement as visible
  governance gaps, not as permission to bypass the documented review process.
