# Roadmap Proposals

Items under "Next candidate tasks", "Later candidate tasks", and "Explicitly
deferred ideas" are not committed or approved work. Their order is a suggested
priority for product discussion, based only on current documentation, code, and
repository history. An item becomes active only when John approves it and
`docs/active-work.md` is replaced with its exact scope. An approved first draft
is recorded separately below so its status is not confused with either a
candidate idea or a completed release.

## Approved first draft

**Official Results News.** Product semantics were approved on 23 August 2026
and are fixed in
[Official Result News Contract](official-news-contract.md). The first draft is
workbook-owned: Excel/VBA replays each mode's presently valid Official results,
selects first results and strict full-precision age-grade or raw-time personal
bests per athlete/distance, applies the strict historical 365-day Current
window before each result, and exports before/after Current and All-Time
distance/Overall ranks. Genuine source times and improvements retain precision
through milliseconds and use `HH:MM:SS[.fff]`, even when the public
`athlete_results.csv` time is rounded. Same-day results use authoritative
`SourceRow` order; the browser only displays the result.

This is approved scope, not completed release work. The workbook draft has
produced a staged 72-file export with authoritative row counts of 43 for Family
and 64 for Everyone. The staged validator passed, and reconciliation against
tracked data found only `data/family/official_result_news.csv`,
`data/everyone/official_result_news.csv`, and the manifest. The approved bundle
is now the tracked 72-file contract. The hardened 59-case failure suite, staged
validation, complete post-promotion suite, both-mode browser checks, artifact
checks, and responsive screenshot review pass. Release remains a separate
explicit decision. The coordinated workbook,
export-contract, repository, and public-runtime change must use the manual
standard-preview release path and explicit approval rather than the routine
existing-schema data pathway.

John approved a presentation-only follow-up on 23 August 2026: Athlete, Year,
and Distance filters plus a 12-entry latest-first initial batch and `Show older`
control. It operates on the existing selected-mode export, preserves exported
order, and does not change the workbook, CSV schema, milestone selection,
improvements, or historical ranks. It is implemented on the same branch; the
complete suite and real-data desktop/mobile review pass. This remains local
review-ready work, not a release.

John approved a second presentation-only follow-up on 23 August 2026 to reduce
the space used by each update. Desktop cards use the available width as a
left-to-right Result, PB improvement or baseline, and Championship movement
flow with decorative visual arrows; mobile preserves the same information and
order in a compact vertical flow. It changes no workbook logic, schema,
calculation, exported content, milestone, or historical position.
Implementation and responsive validation are complete on the same branch. The
full `pnpm test` suite passed, both modes passed browser checks at 1440 x 900,
the 720px intermediate probe, and 390 x 844, and reviewed screenshots had no
overflow. All tested real-data cards remained within the 320px desktop and
850px mobile height ceilings; the visible history is about 55% shorter on
desktop and 37% shorter on mobile than the preceding layout. The Pull Request
preview passed for that compact version. This remains unmerged review work, not
a release.

John requested a third follow-up on 23 August 2026 to make a result entering a
medal-winning position visibly stand out. This is not a browser-derived medal:
the News export grows from 32 to 36 columns with one workbook-owned blank or
Gold/Silver/Bronze `MedalEntry` field for each Current/All-Time,
Distance/Overall rank context. A field is populated only for an unranked or
Rank 4+ to Rank 1/2/3 crossing; existing-medal upgrades stay blank, tied ranks
use the workbook's competition rank, multiple contexts may populate, and 1 Mile
remains Overall-only. The page uses the exported fields for the textual callout
`Medal breakthrough!`, a card accent, and labelled badges on affected movement
rows. The repository contract and focused synthetic tests pass locally. A
refreshed staged 72-file workbook export passed validation and reconciliation,
only the two News CSVs changed meaningfully, and atomic tracked-data promotion
plus validation passed. It contains 24 Family cards with 59 medal-entry
contexts and 34 Everyone cards with 77. After integrating the Gallery baseline,
the complete `pnpm test` suite and 114-file artifact build pass; both modes pass
browser coverage at 1440px,
720px, and 390px. Refreshed screenshots were manually reviewed with readable,
contained medal treatment and no overflow. Pull Request #68 requires the local
current-main integration to be pushed and a new combined preview to pass. This
is not merged or released.

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

5. **Visual marking of estimated dates of birth.** The private Participants
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
