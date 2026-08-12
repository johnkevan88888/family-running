# Audit Of Pull Requests #19 To #32

## Status

- **Audit date:** 12 August 2026
- **Repository state reviewed:** `main` at `4485f62`, after Pull Request #45
- **Pull Requests reviewed:** #19 through #32 inclusive; all fourteen were
  merged between 18 July and 9 August 2026
- **Outcome:** no P0 or P1 findings; four P2 findings remain open

P2 means a material correctness, source-of-truth, or release-control weakness
that should be fixed, but for which this audit found no evidence of an active
production failure requiring an emergency change.

This is an audit record, not approval to implement the recommendations below.
No private workbook was opened or inspected. Repository policy forbids that;
workbook-related conclusions use only the public export contracts, tracked CSVs,
repository code, and documented workflow.

## Method

The audit:

- reviewed each Pull Request's purpose, metadata, changed-file set, patch, and
  merge history;
- traced surviving code to the Pull Request or earlier commit that introduced
  it;
- compared the implementation with `AGENTS.md`, the decision log, export
  contracts, testing protocol, and release documentation;
- inspected the current tests to distinguish enforced behavior from claims made
  only in prose; and
- reconciled the browser-selected personal-best source rows with the workbook-
  selected All Time comparison benchmarks in both current public exports.

Large workbook refreshes make raw line counts misleading: many Pull Requests
replace the complete CSV bundle to preserve one `ExportBundleID`. The review
therefore separated meaningful code, schema, and content changes from expected
bundle-metadata churn.

## Open Findings

### P2-01: The Records page reverses workbook-owned group order

**Introduced by:** [#20](https://github.com/johnkevan88888/family-running/pull/20)

`groupAbsoluteRecords` in [records.js](../records.js) applies a browser-owned
group sort in which Women precede Men. The browser test independently recreates
that ordering and requires `Women|Men`, so the test protects the override.

The current workbook contract and validator require the complete matrix in the
opposite exported order: Men first, then Women, with each group's distances in
the fixed workbook-owned sequence. The validator also requires a unique,
strictly increasing `SortOrder`. The page initially sorts rows by that exported
value, but then the group sort reverses the two blocks.

**Impact:** the visible Records order disagrees with the accepted export
contract, and changing the workbook's order cannot correct the page because the
browser and its test override it.

**Recommended fix:** preserve the order in which groups first appear after the
exported `SortOrder` sort, remove `absoluteRecordGroupSortValue`, and make the
browser test compare with exported order. Do not add a second hardcoded copy of
the matrix.

### P2-02: The custom-domain preview-skip gate accepts any valid hostname

**Introduced by:** [#30](https://github.com/johnkevan88888/family-running/pull/30)

The custom-domain branch of `assessReleasePath` in
[scripts/validate-pr-release-path.mjs](../scripts/validate-pr-release-path.mjs)
checks only that `CNAME` is syntactically a hostname. It does not require the
repository's approved canonical value, `www.aceofrace.com`. The regression test
rejects a URL with a protocol and path, but does not reject a different valid
hostname.

**Impact:** a Pull Request can change `CNAME` to an unintended but syntactically
valid domain, remain inside the custom-domain allowlist, add `[skip netlify]`,
and pass the release-path gate. DNS still constrains whether the new host works,
but the automated control does not enforce the domain that the documentation
and production configuration say is approved.

**Recommended fix:** make the custom-domain pathway require the exact canonical
hostname. A future intentional domain migration should change that constant,
tests, documentation, and DNS plan together through the standard preview path
or a separately approved migration path.

### P2-03: Athlete personal bests have two selectors and two sources of truth

**Conflict exposed by:** [#23](https://github.com/johnkevan88888/family-running/pull/23)
and [#24](https://github.com/johnkevan88888/family-running/pull/24)

`buildPersonalBests` in [athlete.js](../athlete.js) reads shared
`athlete_results.csv` and selects each distance's fastest time and highest age
grade in JavaScript, separately for Official and Unofficial results. The
Calculator reads workbook-selected `Best Age Grade` and `Fastest Time` rows from
site-specific `athlete_comparison_targets.csv`. Both paths therefore decide the
same All Time benchmark independently.

The current data does not expose a visible disagreement:

- Family has 70 distinct All Time athlete/distance/class/benchmark keys; all 70
  select the same source time, age grade, date, and event in both paths.
- Everyone has 96 such keys; all 96 match.
- Repeated comparison rows for different challengers are internally consistent.

That agreement is contingent, not enforced as a single source of truth. The
JavaScript selectors do not implement the workbook's documented deterministic
tie-breaks, so tied performances can diverge even when both are individually
"best". A future correction or eligibility rule applied in the workbook can
also change one path without changing the other.

The existing pairwise export is not a complete drop-in replacement for every
profile route:

- Family exports 12 challenger athletes and benchmark rows for all 11 of those
  who have results. It omits eight result-bearing athletes outside the Family
  roster, although a direct `athlete.html?id=...&site=family` URL can currently
  show their shared results and browser-derived PBs.
- Everyone exports 19 challenger athletes and benchmark rows for all 18 who
  have results. The remaining athlete has no public result to select.

Loading Everyone's export as a fallback on a Family page would violate mode
isolation. Reusing the pairwise export would also download many duplicated
challenger/standard combinations merely to render four benchmarks per distance.

**Recommended fix:** add a workbook-owned shared personal-best export with one
row per athlete, distance, result class, and benchmark type, including the exact
source performance and deterministic order. List it in the export manifest,
validate it against `athlete_results.csv`, render it on athlete pages, and
delete `getFastestResult` and `getBestAgeGradeResult`. Preserve an explicit
empty state for athletes without an exported benchmark; do not silently fall
back to browser calculation.

### P2-04: Routine data auto-merge has no post-PR screenshot review checkpoint

**Introduced by:** [#32](https://github.com/johnkevan88888/family-running/pull/32)

The guided updater in
[scripts/simple-data-update.mjs](../scripts/simple-data-update.mjs) asks for
`PUBLISH` after local tests, before it has committed, pushed, or opened the Pull
Request. It then waits for the required GitHub check and responsive screenshot
generation and immediately merges when the check passes. There is no pause at
which the operator can inspect the exact committed Pull Request diff and the
uploaded screenshot artifact.

Local browser tests do create screenshots before `PUBLISH`, but the updater
only prints a Git diff summary at that point. It neither identifies the
screenshot files for review nor asks the operator to confirm that they were
inspected. Meanwhile the release documentation and bot-maintained skip comment
both say exact-diff and Family/Everyone screenshot review happen before
approval.

**Impact:** the code proves that screenshots were generated, but the automatic
path can merge without proving or explicitly recording the required human
review. A visually wrong but test-passing data refresh can therefore reach
production through the documented happy path.

**Recommended fix:** stop after the Pull Request check succeeds, print the Pull
Request and screenshot-artifact locations, and require a second exact typed
confirmation for merge after review. Keep `PUBLISH` as authority to create the
Pull Request, or rename the two checkpoints so their scope is unambiguous.
Re-verify the PR identity, head SHA, required check, and data fingerprint after
the second confirmation.

## Pull Request By Pull Request Record

| PR | Scope | Audit result |
|---:|---|---|
| [#19](https://github.com/johnkevan88888/family-running/pull/19) | Site-wide pace display toggle; 9 files, +646/-240 | No open finding. Ordinary result pace is presentation derived from exported time and distance; workbook-exported target paces remain authoritative. |
| [#20](https://github.com/johnkevan88888/family-running/pull/20) | Workbook-owned Records page and export; 81 files, +2,883/-1,951 | P2-01 remains. The original missing-complete-matrix validation was separately fixed by #39. |
| [#21](https://github.com/johnkevan88888/family-running/pull/21) | GoatCounter analytics; 14 files, +258/-75 | The original loader failed after merge because its mutable content no longer matched the integrity pin. #22 fixed that failure. The external-loader tradeoff is now an explicitly accepted exception in the decision log. |
| [#22](https://github.com/johnkevan88888/family-running/pull/22) | GoatCounter loader correction; 5 files, +44/-43 | No additional open finding. Production-only host/path filtering and query minimization have focused tests. |
| [#23](https://github.com/johnkevan88888/family-running/pull/23) | Workbook-exported Calculator and pairwise targets; 86 files, +5,361/-1,983 | The Calculator respects workbook ownership. Its benchmark export exposed P2-03: athlete pages already chose the same PB concepts in JavaScript. |
| [#24](https://github.com/johnkevan88888/family-running/pull/24) | Official/Unofficial comparison targets; 73 files, +4,281/-3,690 | No separate finding. Stronger class-aware validation reduces target-export risk but makes the overlap in P2-03 exact. |
| [#25](https://github.com/johnkevan88888/family-running/pull/25) | Lightweight data-refresh path plus August results; 78 files, +4,926/-4,211 | No open finding in the data-only classifier. It requires the complete existing-schema CSV bundle and rejects unrelated changes. |
| [#26](https://github.com/johnkevan88888/family-running/pull/26) | Guided data-update workflow; 10 files, +949/-6 | No open finding in the original prepare/promote/test/PR flow. The later automatic-merge extension is covered under #32. |
| [#27](https://github.com/johnkevan88888/family-running/pull/27) | Current/All Time comparison periods and default matchup; 78 files, +6,629/-4,446 | No open finding. The default rivalry is a presentation choice over exported ranking and age-grade values; target calculation stays in the workbook. |
| [#28](https://github.com/johnkevan88888/family-running/pull/28) | Date display and Overview rolling windows; 8 files, +318/-70 | No open finding attributable to this patch. The separate athlete Recent Results visitor-clock issue found later was fixed by #41; workbook-owned period membership remains a roadmap item. |
| [#29](https://github.com/johnkevan88888/family-running/pull/29) | Self-contained Windows launcher; 2 files, +29/-1 | No open finding. Runtime discovery is explicit and fails closed when Node is unavailable. |
| [#30](https://github.com/johnkevan88888/family-running/pull/30) | Custom domain and preview-skip pathway; 11 files, +185/-48 | P2-02 remains. |
| [#31](https://github.com/johnkevan88888/family-running/pull/31) | Complete routine data refresh; 68 CSVs, +6,006/-6,005 | No repository-code finding. Review was limited to the public bundle contract and tracked output; the private workbook was not inspected. |
| [#32](https://github.com/johnkevan88888/family-running/pull/32) | Routine data check/merge/cleanup automation; 10 files, +605/-85 | P2-04 remains. SHA, PR identity, branch, required-check, fingerprint, and cleanup containment checks are otherwise strong. |

## Historical Issues Already Remediated Or Accepted

These are not additional open findings:

- #20 originally validated individual absolute-record rows without validating
  the complete matrix. #39 added fixed-matrix, group, distance, title, and order
  enforcement.
- #21's integrity-pinned GoatCounter loader failed in production. #22 moved to
  the provider's mutable recommended loader without integrity. The residual
  third-party execution tradeoff was explicitly accepted and documented on
  11 August 2026.
- The broad audit following #32 found five defects in earlier code; #39 fixed
  the preview output-directory gate, complete absolute-record matrix,
  `DisplayDistance` escaping, copied-directory publication contracts, and
  full-document CSV parsing.
- The athlete Recent Results clock discrepancy was fixed by #41. JavaScript
  still determines twelve-month membership, which remains a separate roadmap
  item for a future workbook-owned export field.

## Suggested Remediation Order

1. Pin the custom-domain gate to `www.aceofrace.com` because it is a small,
   isolated release-control correction.
2. Remove the Records page's group-order override and align its browser test
   with exported order.
3. Add a post-check human review checkpoint to routine data publication before
   the next guided production refresh.
4. Design and export workbook-owned personal-best rows, then remove the two
   JavaScript selectors. This is the largest item because it crosses the private
   workbook/public CSV boundary.

No recommendation above is approved implementation merely because it appears
in this audit.

## Validation Of This Audit Record

On 12 August 2026:

- `git diff --check` passed;
- every non-browser stage of `pnpm test` passed; the command wrapper reached its
  two-minute limit after starting the final browser stage; and
- `pnpm run test:browser` then passed separately, covering Family and Everyone
  at desktop and mobile sizes and refreshing the ignored responsive
  screenshots.
