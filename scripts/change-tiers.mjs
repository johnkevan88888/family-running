// Which checks a change needs, declared and reviewed.
//
// This table is the source of truth. It is not generated, and the classifier
// does not consult a trace at runtime: a tier is a reviewed statement about
// what a change can break, and a statement nobody reviewed is not one.
// `scripts/trace-check-reads.mjs` audits it afterwards -- it fails when a
// check's observed reads intersect a tier's paths and the check is absent from
// that tier -- so the declaration is checked against reality without the
// classifier ever depending on the measurement.
//
// The membership rule, and it is the only one: a check belongs to a tier when
// that tier's paths can change its verdict. Not when it mentions them, not when
// it feels related. `tests/export-bundle-validation.mjs` exercises the
// validator against fixtures it builds itself, so promoting new CSVs cannot
// change its answer; it belongs with the scripts that it tests, not with the
// data. The same rule puts the suite's own contracts -- the lane table, the
// suspension watch, the parallel runner, the release paths -- in the scripts
// tier, because only a change to the runner or the workflow can alter them.
//
// Everything unrecognised is `full`. That is the default, not a fallback: a
// tier is a claim that a smaller set suffices, and absent a reviewed claim
// there is no reason to believe it.

/**
 * Checks that run for every change, whatever it touches.
 *
 * Three, and deliberately not more. The membership rule admits only checks
 * whose verdict any change at all can alter: the repository-wide safety scan,
 * the declared Node engine, and the browser runtime contract -- which is what
 * decides whether a browser check can run at all. Together they cost about half
 * a second, so the floor is free. Adding the suite's own contract checks here
 * would cost 58 seconds on every tier for invariants that only a change to
 * `scripts/` or `tests/` can break, and those are in `scriptsTier`.
 */
export const floorChecks = Object.freeze([
    'scripts/validate-repository-safety.mjs',
    'tests/node-engine.mjs',
    'tests/browser-runtime.mjs'
]);

/**
 * One complete promoted data refresh: the whole 72-CSV bundle, the routine
 * derived artifacts, optionally the handoff note, no new CSV and no changed
 * header. The predicate itself is `isLightweightDataRefresh` in
 * `scripts/validate-pr-release-path.mjs`, shared with the release-path gate so
 * the two can never disagree about what a refresh is.
 *
 * What can a promoted bundle break? The exported values themselves, the
 * contracts that read them, and the pages that render them. Not the validators'
 * own regression tests, not the updater's, and not the private media pipeline,
 * which never reads `data/`. That last exclusion is the point: a routine
 * refresh has been running `tests/gallery-d1-expression-depth.mjs`, ten minutes
 * of Cloudflare D1 expression-depth parity, for nothing.
 */
export const dataTierChecks = Object.freeze([
    // The exported bundle against its own schema, scope and manifest.
    'scripts/validate-csv.mjs',
    // The calculator's conformance vector travels inside the bundle.
    'tests/age-grade-contract.mjs',
    // Gallery surfaces that look results up by exported value.
    'tests/gallery-age-export.mjs',
    'tests/gallery-photo-details.mjs',
    // Suppression and the public manifest contract, which gate what any page
    // may show about an athlete who appears in the new data.
    'tests/gallery-contract.mjs',
    'scripts/validate-gallery.mjs',
    // Every refresh regenerates the catalogue; this proves it still matches the
    // promoted data rather than the bundle it was built from.
    'scripts/build-gallery-admin-catalog.mjs',
    // Added on the read audit's evidence, against the first draft of this
    // table, which put all three in the scripts tier on the reasoning that they
    // test a validator rather than the data. They read 74 real exported files
    // between them, and a mutation test settled it: drop one row from one
    // leaderboard CSV and all three change verdict. A check whose answer a
    // refresh can change belongs to the refresh.
    'tests/export-bundle-validation.mjs',
    'tests/staged-export-workflow.mjs',
    'tests/verify-production-data.mjs',
    // The artifact is what visitors receive, and `data/` is copied into it
    // whole, so its contracts are data contracts.
    'tests/preview-artifact-safety.mjs',
    'scripts/build-preview-artifact.mjs',
    // The pages, rendered from the artifact, in both modes at both viewports.
    'tests/published-site-browser-root.mjs',
    'tests/gallery-thumbnail-layout.mjs',
    'tests/gallery-photo-review-browser.mjs',
    'tests/gallery-podium-framing-browser.mjs',
    'tests/browser-smoke.mjs'
]);

/**
 * Checks that read real `data/` files and still do not belong to the data tier.
 *
 * `scripts/trace-check-reads.mjs` flags every check that reads a tier's files
 * and is outside it, because that is usually a hole. These four are not: each
 * reads exported data to build a fixture or to assert a shape, and a mutation
 * test showed its verdict unchanged by a data change that three other checks
 * caught. Reading is not the same as depending, which is why this list exists
 * rather than the audit being loosened -- a NEW check that reads `data/` still
 * fails the audit until somebody reviews it into one column or the other.
 *
 * Each was verified by dropping one row from one leaderboard CSV and re-running
 * it. Re-verify if that stops being true.
 */
export const dataSurfaceExceptions = Object.freeze([
    // Reads the exported roster to build its own bridge fixtures.
    'tests/gallery-photo-review-bridge.mjs',
    // Drives the updater against a synthetic workspace; the real export is
    // input to the fixture, not the thing under test.
    'tests/simple-data-update.mjs',
    // Asserts the catalogue's shape, which does not vary with row counts.
    'tests/gallery-admin-catalog.mjs',
    // Reads one exported file to populate an uploader fixture.
    'tests/gallery-family-uploader-browser.mjs'
]);

// There is deliberately no gallery-editorial or runtime tier yet, though both
// were designed and declared. `scripts/trace-check-reads.mjs` audited them and
// found them unsafe:
//
//   - A runtime tier of 25 checks left 55 HOLES. The private media pipeline
//     imports `gallery-contract.js`, `gallery-media-policy.js`,
//     `gallery-upload-contract.js` and `gallery-podium-framing.js`, all root
//     runtime files, so a change to any of them can change the verdict of
//     dozens of checks the tier would have skipped.
//   - A gallery-editorial tier left 9 holes: nine checks outside it read
//     `gallery-data/*.json`.
//
// The data tier has none, and it is the only one that has been mutation-tested
// check by check. Shadowing a tier the audit already calls wrong would gather
// agreement evidence about the wrong thing, so those paths fall to `full` until
// their tiers are audited and mutation-tested the same way.

// There is deliberately no gallery-admin tier either. One was declared and
// measured: 109 checks at 2225 s against the full suite's 2226 s, a saving of
// nothing, because the private media pipeline IS most of the suite and the only
// checks a `gallery-admin/**` change cannot affect are five that run in under a
// second between them. A tier that names a saving it does not deliver is worse
// than no tier.

/** Tier names, in the order the classifier reports them. */
export const tierNames = Object.freeze(['data', 'full']);

/**
 * Why a change was not narrowed to a smaller tier. A bounded list: the advisory
 * job prints it into a public Actions log, so it carries no paths, SHAs or
 * identifiers -- only the shape of the decision.
 */
export const fullTierReasons = Object.freeze([
    'unmatched',
    'publishing-control',
    'decides-what-runs',
    'diff-inputs',
    'empty-diff',
    'diff-too-large',
    'unsupported-status',
    'rename',
    'deletion',
    'malformed-path',
    'incomplete-bundle',
    'no-saving'
]);

/** The largest diff the classifier will narrow. Beyond it, everything runs. */
export const maximumNarrowedFileCount = 200;

/**
 * The checks a named tier runs, floor included, or `null` for the whole suite.
 */
export function checksForTier(tier) {
    if (tier === 'data') {
        return [...new Set([...floorChecks, ...dataTierChecks])];
    }

    return null;
}
