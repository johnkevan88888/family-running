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

4. **Workbook-owned recency flag for athlete Recent Results.** Partially
   addressed on 11 August 2026. `buildRecentResults` in `athlete.js` used
   `new Date()`, so the twelve month window was measured against the visitor's
   own browser clock: two visitors in different timezones, or the same visitor
   either side of midnight, could see different sets. It now anchors to the
   exported `LastUpdatedUTC`, the same value the Overview has always used, so
   the two pages agree and every visitor sees the same set.

   What remains needs the workbook. Anchoring to the export makes the window
   deterministic, but the browser still computes a rolling twelve months rather
   than reading the workbook's own Current/12-Month period membership, so a
   result can still sit inside one and outside the other if those definitions
   diverge. The complete fix is an Excel/VBA-owned column on
   `data/athlete_results.csv` marking each row's membership of the current
   period, with the browser filtering on the exported value instead of computing
   a window at all. That is an export-contract change, so it stays a proposal
   for John, not repository work. Related: the athlete page also picks personal
   bests in JavaScript by sorting exported rows, which is a browser-side
   derivation of the same kind.

5. **Retroactive removal of deactivated participants.** The private Participants
   sheet holds a `ProfileStatus` column. John's intent, stated 16 August 2026, is
   that deactivating a participant removes every mention of them from the site,
   retroactively as well as going forward, and that no new result of theirs is
   published.

   **The repository needs no work for this, and no `ProfileStatus` export.** If
   the workbook stops exporting a participant everywhere, the site never learns
   they existed. Validation is satisfied by that: every referenced athlete ID
   must exist in `data/athlete_results.csv`, so removing them from the shared
   results file and from every file referencing it leaves no dangling reference.
   Removing them from only some files fails validation, which is the desirable
   direction for the check to fail in.

   It is recorded here rather than in `docs/decision-log.md` because it is
   workbook-side behaviour this repository cannot verify, and the decision log's
   own correction of 10 August 2026 says such claims belong in the roadmap as
   proposals until confirmed against the workbook.

   Three consequences are worth having written down before it is used:

   - **It edits other people's history.** Ranks are positional, so removing an
     athlete promotes everyone below them and changes the medals in
     `official_medals.csv`. Measured on 16 August 2026 in Family, of 21
     result-bearing athletes: three hold an absolute record, five hold an
     official medal, two appear in the Hall of Fame, and four appear across the
     eight `crown_history.csv` rows. Deactivating one of those few rewrites
     pages about other people; deactivating any of the other sixteen is
     contained.
   - **Crown history replays differently.** `crown_history.csv` is rebuilt from
     presently valid official results, so a transition recorded as one athlete
     taking a crown from another changes when the previous holder is removed.
   - **Published profile links dead-end.** An `athlete.html?id=...` link shared
     earlier renders "Athlete not found" once the athlete is gone.

   **It does not remove them from GitHub.** This repository is public, verified
   16 August 2026, and every past commit of `data/athlete_results.csv` still
   carries the athlete's name, age category, event names, and dates, readable
   and indexable regardless of the site's `noindex`. Removing a participant from
   the current export removes them from the website only. If a deactivation is
   ever prompted by someone asking to be taken off, the export change alone does
   not achieve that; closing the remaining route is the separate open item about
   the repository being public.

   Operationally, expect a large multi-file diff as ranks shift. The guided
   updater's separate `MERGE` confirmation is the right place to review it.

6. **Visual marking of estimated dates of birth.** The private Participants
   sheet holds a `DOBStatus` column. Because age grade is computed from age, an
   estimated date of birth makes the age grade, the age-graded category, the
   resulting rank, and every target derived from them estimates too, and the
   site currently presents every age grade with identical confidence.

   The design was agreed with John on 16 August 2026 and is written up in
   [Proposed workbook-owned DOB status export](dob-status-export-proposal.md):
   a shared `data/athlete_dob_status.csv` carrying one row per athlete, joined
   in the browser wherever an age grade renders. Unlike the item above, this
   does need repository work, but only after the workbook exports the file. One
   question is still open there: the exact `DOBStatus` vocabulary, which
   validation has to pin to a closed set.

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
