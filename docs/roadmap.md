# Roadmap Proposals

Nothing in this file is committed or approved work. The order is a suggested
priority for product discussion, based only on current documentation, code, and
repository history. An item becomes active only when John approves it and
`docs/active-work.md` is replaced with its exact scope.

## Next candidate tasks

1. **Mobile championship leaderboards are close to unreadable.** On
   `index.html` and `championships.html` at 390 x 844 with device emulation, the
   nine-column standings table renders at full width inside a 390px viewport.
   Every column compresses until text wraps a character or two at a time: an
   Age Graded Category badge reading "Regional Class" becomes a narrow vertical
   strip of single letters, participant names such as "David Graham-Kevan" break
   across four lines, and each row grows several times taller than it needs to
   be. The Everyone mode is worse than Family simply because it has more rows;
   its full-page mobile screenshot is roughly 15,800 pixels tall.

   Nothing fails today, which is why this needs recording rather than fixing in
   passing. There is no horizontal overflow, the viewport tag is correct, and
   every automated mobile assertion passes, so the suite cannot see it. Only a
   screenshot review does.

   This is presentation work and must stay presentation work: ranking order,
   values, medals, age grades, and categories are Excel-owned exports and cannot
   be recomputed, reordered, or omitted on the basis of a browser-side judgement
   about what matters. Approaches worth discussing, none of them chosen: a
   card-per-athlete layout below a breakpoint, as the Records page already uses
   successfully on mobile; a reduced default column set with the rest available
   on demand; or letting the table scroll horizontally inside its own container.
   Deliberately excluded from the 11 August 2026 audit remediation, which was
   scoped to safety and correctness and must not redesign the site.

2. **Crown-history enhancement.** Define a Phase 2 for All-Time Official crown
   history. The narrowest evidence-backed increment is to consider showing an
   existing holder's crown-improving performances, which the MVP explicitly
   excludes. Any added history must be replayed and exported by Excel/VBA; keep
   Current/12-Month history separate.
3. **Athlete medal and crown presentation refinement.** Improve the information
   hierarchy and clarity of the existing `official_medals.csv` medal cabinet and
   `crown_standards.csv` crown-target cards. This is a presentation proposal,
   not permission to calculate awards or targets in JavaScript.

4. **Workbook-owned recency flag for athlete Recent Results.** `buildRecentResults`
   in `athlete.js` selects "Recent Results" using `new Date()`, so the twelve
   month window is measured against the visitor's own browser clock rather than
   the workbook's Current/12-Month period. Two visitors in different timezones,
   or the same visitor before and after midnight, can therefore see different
   sets, and a result can appear under Recent Results while being outside the
   Current championship period. The narrowest fix is an Excel/VBA-owned column on
   `data/athlete_results.csv` marking each row's membership of the current
   period, with the browser filtering on the exported value instead of computing
   a date window. This needs a workbook export-contract change, so it is a
   proposal for John, not repository work. Related: the athlete page also picks
   personal bests in JavaScript by sorting exported rows, which is a browser-side
   derivation of the same kind.

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
3. **Release-process refinement.** Enable and verify hosted `main` branch
   protection and required checks, then close any remaining gaps in preview
   review, production verification, and handoff recording. Existing automation
   should be refined, not replaced without evidence.

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
