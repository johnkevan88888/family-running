// Which checks may run beside which, and which must not.
//
// The suite is 114 checks and about 30 minutes on this machine. Almost all of
// them are independent: they read tracked files, build synthetic fixtures in
// their own temporary directories and assert. A few are not, and running those
// concurrently would produce failures that look like code faults and are not.
// This module is the whole list of exceptions, so the scheduler in
// `scripts/run-all-tests.mjs` stays a scheduler and the reasons live here.
//
// `tests/check-lanes.mjs` derives both resource groups from the test sources
// and fails if a declaration here disagrees, so a new browser check or a new
// user of the shared data-update paths cannot join the suite unnoticed.

import { defaultPreviewOutputDir } from './preview-artifact-contract.mjs';

/** Checks run first, serially: a broken repository fails in seconds. */
export const gateScripts = Object.freeze([
    'scripts/validate-repository-safety.mjs',
    'tests/node-engine.mjs',
    'tests/browser-runtime.mjs',
    'tests/suspension-watch.mjs',
    'tests/suspension-boundary.mjs',
    'tests/check-lanes.mjs',
    'tests/change-tier.mjs',
    'tests/parallel-runner.mjs',
    'scripts/sync-vendor.mjs',
    'scripts/validate-csv.mjs',
    'scripts/validate-gallery.mjs',
    'scripts/validate-gallery-podium-framing.mjs',
    'scripts/sync-private-face-detector.mjs',
    'scripts/build-gallery-admin-catalog.mjs'
]);

/**
 * Run after the gates and before anything else, in this order. The build
 * deletes and recreates `test-artifacts/preview-site`, and it runs before the
 * browser lane so the browser checks can later be pointed at the published
 * artifact instead of the repository root.
 */
export const artifactScripts = Object.freeze([
    'tests/preview-artifact-safety.mjs',
    'scripts/build-preview-artifact.mjs'
]);

/**
 * Checks that launch Chromium. Capped below `--jobs` for two reasons: each
 * instance is expensive, and the progression chart's resize wait is
 * demonstrably load-sensitive -- a full-suite run that took 42 minutes failed
 * it while the same check passed alone in under four. The cap is what keeps a
 * parallel suite from reintroducing the failure the settle window just fixed.
 */
export const browserResource = 'browser';
export const browserScripts = Object.freeze([
    'tests/browser-smoke.mjs',
    'tests/gallery-admin-browser.mjs',
    'tests/gallery-batch-owner-browser.mjs',
    'tests/gallery-family-uploader-browser.mjs',
    'tests/gallery-framing-uploader-integration.mjs',
    'tests/gallery-photo-details.mjs',
    'tests/gallery-photo-review-browser.mjs',
    'tests/gallery-podium-editor.mjs',
    'tests/gallery-podium-framing-browser.mjs',
    'tests/gallery-private-face-browser.mjs',
    'tests/gallery-private-library-browser.mjs',
    'tests/gallery-thumbnail-layout.mjs',
    // Launches no Chromium itself: it SPAWNS a browser check twice, against a
    // complete artifact and an incomplete one. The instance is just as real, so
    // it holds the resource like any other.
    'tests/published-site-browser-root.mjs'
]);

/**
 * Browser checks that serve the real site rather than a synthetic fixture.
 *
 * They are pointed at the PUBLISHED ARTIFACT, not the repository root, so what
 * CI renders is exactly what GitHub Pages deploys. The difference is not
 * cosmetic: a runtime file absent from `publishedSiteEntries` still exists in
 * the repository, so a check served from the root loads it happily and passes
 * while production 404s. Served from the artifact, the same omission fails the
 * suite -- `tests/published-site-browser-root.mjs` proves that it does.
 *
 * This is why the artifact phase runs before the browser lane. A check here
 * cannot run before `scripts/build-preview-artifact.mjs` has produced the
 * directory, and `scripts/serve-site.mjs` refuses a root that is not there
 * rather than serving 404s that would read as a site fault.
 */
export const publishedSiteScripts = Object.freeze([
    'tests/browser-smoke.mjs',
    'tests/gallery-photo-details.mjs',
    'tests/gallery-photo-review-browser.mjs',
    'tests/gallery-podium-framing-browser.mjs',
    'tests/gallery-thumbnail-layout.mjs'
]);

/**
 * Checks that use fixed paths under `test-artifacts/` -- `worktrees`,
 * `simple-data-update`, `workbook-export-staging` -- rather than a directory of
 * their own. They are mutually exclusive, and the fix is not concurrency
 * control: it is for them to use per-run directories, at which point they
 * leave this list.
 */
export const dataUpdateResource = 'data-update';
export const dataUpdateScripts = Object.freeze([
    'tests/simple-data-update.mjs',
    'tests/data-update-workspace.mjs'
]);

/** How many checks holding each resource may run at once. */
export const resourceCapacity = Object.freeze({
    [browserResource]: 2,
    [dataUpdateResource]: 1
});

const gateSet = new Set(gateScripts);
const artifactSet = new Set(artifactScripts);
const browserSet = new Set(browserScripts);
const dataUpdateSet = new Set(dataUpdateScripts);
const publishedSiteSet = new Set(publishedSiteScripts);

/** 'gate', 'artifact' or 'pool'. The phases run in that order. */
export function phaseOf(script) {
    if (gateSet.has(script)) {
        return 'gate';
    }
    if (artifactSet.has(script)) {
        return 'artifact';
    }
    return 'pool';
}

/** The resources a check holds while it runs; it waits for all of them. */
export function resourcesFor(script) {
    const resources = [];

    if (browserSet.has(script)) {
        resources.push(browserResource);
    }
    if (dataUpdateSet.has(script)) {
        resources.push(dataUpdateResource);
    }

    return resources;
}

/**
 * Extra environment a check needs, merged over the runner's own. Empty for
 * almost everything: only the checks that serve the real site are told where
 * the published artifact is.
 */
export function environmentFor(script) {
    if (publishedSiteSet.has(script)) {
        return { SITE_ROOT: defaultPreviewOutputDir };
    }

    return {};
}

/**
 * The capacity a resource has for a given `--jobs`. A resource can never be
 * allowed more concurrency than the run itself, so `--jobs=1` leaves every
 * capacity at 1 and the resources stop mattering.
 */
export function capacityFor(resource, jobs) {
    return Math.max(1, Math.min(resourceCapacity[resource] ?? jobs, jobs));
}
