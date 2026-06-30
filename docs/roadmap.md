# Roadmap Proposals

Nothing in this file is committed or approved work. The order is a suggested
priority for product discussion, based only on current documentation, code, and
repository history. An item becomes active only when John approves it and
`docs/active-work.md` is replaced with its exact scope.

## Next candidate tasks

1. **Crown-history enhancement.** Define a Phase 2 for All-Time Official crown
   history. The narrowest evidence-backed increment is to consider showing an
   existing holder's crown-improving performances, which the MVP explicitly
   excludes. Any added history must be replayed and exported by Excel/VBA; keep
   Current/12-Month history separate.
2. **Athlete medal and crown presentation refinement.** Improve the information
   hierarchy and clarity of the existing `official_medals.csv` medal cabinet and
   `crown_standards.csv` crown-target cards. This is a presentation proposal,
   not permission to calculate awards or targets in JavaScript.

## Later candidate tasks

1. **Non-age-graded records and fastest-time presentation.** The athlete page
   already presents fastest times and Hall of Fame supports record-book/fastest
   card concepts. Define which official raw-time records are meaningful and an
   Excel/VBA-owned export contract before expanding them into a championship
   feature.
2. **Measured performance improvements.** Profile static-site loading and
   rendering before choosing optimisations, with particular attention to the
   growing number of CSV requests and athlete-page sections. Any workbook macro
   performance work remains private and outside this repository.
3. **Release-process refinement.** Verify hosted `main` branch protection and
   required checks, then close any remaining gaps in preview review, production
   verification, and handoff recording. Existing automation should be refined,
   not replaced without evidence.

## Explicitly deferred ideas

- **Current/12-Month crown history.** Rolling-window crowns can change without a
  new performance taking the all-time crown and require a separate product and
  data model.
- **Browser-derived records, rankings, medals, crowns, or targets.** These
  conflict with the Excel/VBA source-of-truth decision.
- **Synthetic vacancy or administrative-correction timeline events.** The
  released crown-history contract intentionally excludes them.
- **Broad visual redesign.** Consider only as a separately approved product
  task with explicit behaviour and regression boundaries.
