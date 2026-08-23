// Single source of truth for what reaches the public web.
//
// `scripts/build-preview-artifact.mjs` copies exactly these entries into the
// published artifact, and `scripts/validate-pr-release-path.mjs` uses the same
// list to decide whether a Pull Request could possibly change what a visual
// preview would show. Keeping one list means the two can never disagree: adding
// a page here publishes it and makes it preview-relevant in the same edit.
//
// Anything absent from this list is not on the public web at all.
export const publishedSiteEntries = [
    // Keeps the www.aceofrace.com custom domain bound when Pages publishes this
    // artifact instead of the repository root. Removing it drops the domain.
    'CNAME',
    // Permissive by design; the noindex meta tag on each page does the work.
    'robots.txt',
    'index.html',
    'championships.html',
    'hall-of-fame.html',
    'records.html',
    'gallery.html',
    'calculator.html',
    'age-grade-calculator.html',
    'overview.html',
    'athlete.html',
    'site.css',
    'site-navigation.js',
    'analytics.js',
    'athlete.css',
    'athlete.js',
    'leaderboard.js',
    'records.js',
    'gallery.css',
    'gallery-contract.js',
    'gallery.js',
    'calculator.css',
    'calculator.js',
    'age-grade-contract.js',
    'age-grade-calculator.js',
    'utils.js',
    // Brand imagery referenced by every page's favicon and Open Graph tags.
    // Copied whole like `vendor` and `data`, so its contents are contracted in
    // scripts/preview-artifact-contract.mjs rather than left unchecked.
    'assets',
    'vendor',
    'data',
    // Editorial media metadata and the shared person-tag suppression list only.
    // Photographs and videos stay in external media storage so Git history and
    // the Pages artifact remain small.
    'gallery-data'
];

// Files that are never published themselves but decide what gets published or
// how it is deployed. A change to any of these can alter the rendered site, so
// they must not qualify as a no-visual-change release.
export const publishingControlPaths = new Set([
    'netlify.toml',
    'package.json',
    'pnpm-lock.yaml',
    'scripts/build-preview-artifact.mjs',
    'scripts/published-site-entries.mjs',
    // The artifact build imports these to decide where it may write and what
    // `data/` and `vendor/` are allowed to contain, so a change to any of them
    // can change the published site.
    'scripts/preview-artifact-contract.mjs',
    'scripts/vendored-library-files.mjs',
    'scripts/export-bundle-tools.mjs'
]);

const publishingControlPrefixes = ['.github/workflows/'];

export function normalizePublishedPath(value) {
    return String(value || '')
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/^\/+/, '');
}

// True when the path is served to visitors, either directly or because it sits
// inside a published directory such as `data/` or `vendor/`.
export function isPublishedPath(value) {
    const normalized = normalizePublishedPath(value);

    return publishedSiteEntries.some(entry =>
        normalized === entry || normalized.startsWith(`${entry}/`)
    );
}

export function isPublishingControlPath(value) {
    const normalized = normalizePublishedPath(value);

    return publishingControlPaths.has(normalized) ||
        publishingControlPrefixes.some(prefix => normalized.startsWith(prefix));
}
