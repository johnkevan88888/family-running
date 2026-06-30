# Active Work

This file holds the single task John has currently approved. Roadmap entries are
proposals only. Replace this content when a new task is approved rather than
running multiple active scopes here.

## Task title

Repository shared handoff operating layer

## Objective

Make the repository the durable handoff point for product planning, Codex
implementation, validation, Pull Request review, and release work.

## Baseline at task start

- `main` was clean at `b9c5d7f` on 30 June 2026. `a8442b7` is the earlier merge
  commit that released the All-Time Official Crown Progression MVP; it is not
  the current `main` commit.
- The All-Time Official Crown Progression MVP is complete and released.
- Family (`?site=family`) and Everyone (`?site=everyone`) modes are live.
- `data/family/crown_history.csv` and
  `data/everyone/crown_history.csv` both exist.
- The next product task is intentionally **not approved** and awaits product
  direction from John.

## Scope

- Add a reusable active-task handoff template and populate it with the current
  baseline.
- Record established architectural decisions.
- Record a prioritised, proposal-only roadmap grounded in repository evidence.
- Add the minimum agent instructions needed to keep those documents current.

## Explicitly out of scope

- Website behaviour or presentation.
- CSV schemas or production data.
- Excel/VBA workbooks, macros, exports, or backups.
- GitHub Actions, Netlify configuration, dependencies, or release settings.
- Selection or implementation of the next product feature.

## Relevant files

- `AGENTS.md`
- `docs/active-work.md`
- `docs/decision-log.md`
- `docs/roadmap.md`
- `docs/crown-history-mvp.md`
- `docs/testing-and-release-protocol.md`
- `docs/github-pr-checks-and-preview-deployments.md`

## Acceptance criteria

- The three operating documents are concise, evidence-based, and agree with the
  current repository state.
- `AGENTS.md` points substantial work to the active task, architecture context,
  release protocol, and decision log without duplicating them.
- No application, data, workflow, dependency, workbook, or generated artifact
  is intentionally changed.
- The work is delivered through a focused Pull Request with validation evidence.

## Validation required

- [x] `pnpm run validate:safety` — passed; 94 tracked files checked after
  staging the operating documents.
- [x] `pnpm run validate:csv` — passed for Family and Everyone.
- [x] `pnpm test` — passed repository safety, CSV validation, export-bundle
  regression tests, and browser smoke tests for both modes; responsive
  screenshots remained ignored test artifacts.
- [x] Final tracked-file audit — only `AGENTS.md` and the three operating
  documents changed; no application, data, workflow, dependency, workbook, or
  generated artifact is included.

## PR and release status

- Branch: `docs/shared-handoff-system`
- Pull Request: pending
- Release: not requested; merge and production release require explicit John
  approval.

## Implementation notes

- Documentation-only operating layer.
- Historical dates use Git history where available and are marked approximate
  where the exact original decision date is unknown.
- GitHub-hosted branch-protection enforcement cannot be established from
  tracked files alone and is recorded as an external verification point.

## Codex handoff notes

- Do not start a roadmap proposal until John approves it and this file is
  replaced with that task's exact scope and acceptance criteria.
- Preserve Excel/VBA ownership of calculations and JavaScript's display-only
  role.
- At task completion, record commands and results here, then leave PR/release
  state explicit for the next handoff.
