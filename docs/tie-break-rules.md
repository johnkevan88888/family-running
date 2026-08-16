# Workbook Tie-Break Rules

- **Status:** Decided by John on 14 August 2026. Supersedes the earlier rule in
  [the athlete comparison export contract](athlete-comparison-export-contract.md),
  which preferred the **most recent** date.
- **Applies to:** every workbook selection of one performance from several
  candidates, whichever export it ends up in.

This document exists because the same tie-break now governs three separate
things: the pairwise benchmarks in `athlete_comparison_targets.csv`, the
proposed `data/personal_bests.csv`, and the workbook's own overall-crown and
champion comparison. Stating it once, in one place, is the point. Restating it
inside any single export contract would recreate, in documentation, exactly the
one-concept-two-rules problem these rules were settled to remove.

Nothing here is repository behaviour. The workbook applies these rules; the
repository can only check the parts an export carries.

## The chain

Compare candidates on each criterion in order, stopping at the first that
separates them.

### Selecting a Best Age Grade

1. **Highest age grade at full working precision.** Not the exported figure
   rounded to one decimal place. See "Precision" below.
2. **Longer distance wins.** Inert whenever the selection is already keyed by
   distance; live for Overall. See "Where distance does work".
3. **Older date wins.** A personal best was set on the day it was first
   achieved, not the day it was last equalled.
4. **Fastest raw time.**
5. **Earlier workbook source row.**

### Selecting a Fastest Time

1. **Lowest raw time.**
2. **Highest age grade at full working precision.**
3. **Older date wins.**
4. **Earlier workbook source row.**

Raw time cannot appear as a tie-break in this chain, because equal raw time is
what put two candidates into it. There is no Overall equivalent of Fastest
Time: comparing a marathon time with a 5 km time is not meaningful, so this
chain is always keyed by distance and criterion 2 of the age-grade chain has no
counterpart here.

## Why older wins

Reversed from the previous rule on 14 August 2026. A best is set the first time
it is achieved; equalling it later does not move the achievement. The earlier
wording preferred the most recent date, which read naturally for a leaderboard
but wrongly for a personal best.

The reversal applies to both exports together, deliberately. Applying it to
personal bests alone would have left the Calculator and the athlete page
disagreeing about the same performance, which is the defect that
[the personal-best export proposal](personal-best-export-proposal.md) exists to
close.

## Precision

Age grades are exported to one decimal place. Two performances that tie at one
decimal place will almost never tie at the workbook's own working precision, so
criterion 1 should resolve nearly every case that reaches it and the criteria
below it should rarely decide anything.

Any export whose selection depends on that precision must carry it. A selection
decided on a number the export does not contain cannot be checked by repository
validation, or by a reconciliation against what the site renders, and is
therefore trusted rather than auditable. `data/personal_bests.csv` carries it as
`AgeGradeExact`.

The same trick does not rescue times. Measured on 13 August 2026, no `Time` in
`data/athlete_results.csv` carries sub-second precision, so two results recorded
at the same whole second are a genuine tie with no finer value behind them. That
is why the chain continues past raw time rather than ending there.

## Where distance does work

The distance criterion looks inert, and inside a distance-keyed selection it is:
`data/personal_bests.csv` and `athlete_comparison_targets.csv` both fix the
distance as part of the key, so every candidate already shares it. Measured on
14 August 2026, 0 of 48 athlete/distance/class groups span more than one
distance, and none contain a distance spelling variant.

It does real work in the **Overall** category, which selects one performance
across every distance. `halloffame.csv` records the winning distance next to the
champion: the All Time Overall Official Champion is a 10 km at 78.4%, chosen
over a 5 km at 78.0% by the same athlete. `crown_standards.csv` does the same
with `Distance=Overall` and a separate `CrownDistance`.

A tie is likelier in Overall than anywhere else, because it compares an
athlete's best from every distance rather than two or three results at one
distance.

**Longer wins**, matching the crown ordering already used for display in
`leaderboard.js`: `Overall, Marathon, Half Marathon, 10 Mile, 10 km, 5 km`.

## Termination

The chain must end in a criterion that cannot itself tie, or a selection can
still be undecided. Age grade, distance, date, and time can all repeat: the same
athlete running the same time at two events on one day is enough, and a
duplicated worksheet entry is enough on its own. The earlier workbook source row
is unique by construction, so it terminates the chain. Alphabetical ordering by
name or event does not: identical strings do not separate, and within a
distance-keyed selection the athlete is fixed by the key anyway.

## Effect on current data

None. Measured on 13 August 2026 across the twenty athlete/distance/class groups
holding more than one result, there are zero exact fastest-time ties and zero
exact best-age-grade ties. No benchmark the site shows today is decided by any
tie-break, so changing the rule changes no exported row. The closest approach is
0.1 age-grade points, one rounding step away, in `carolyn-kevan` at 10 km
Unofficial.

Re-measure this rather than trusting it: the harness in
`scripts/reconcile-personal-bests.mjs` reports any disagreement between an
export and what the athlete page renders.
