// The exact set of browser libraries committed to `vendor/`.
//
// `scripts/sync-vendor.mjs` copies these builds out of the pnpm-resolved
// `node_modules` tree and fails if a tracked copy has drifted.
// `scripts/build-preview-artifact.mjs` uses the same list to fail the published
// artifact if `vendor/` gained a file that no pinned dependency put there.
// Keeping one list means a vendored file can never be published without also
// being checked against its dependency.
export const vendoredLibraryFiles = [
    {
        source: 'chart.js/dist/chart.umd.min.js',
        target: 'chart.umd.min.js'
    },
    {
        source: 'chart.js/LICENSE.md',
        target: 'LICENSE-chart.js.md'
    },
    {
        source: 'chartjs-adapter-date-fns/dist/chartjs-adapter-date-fns.bundle.min.js',
        target: 'chartjs-adapter-date-fns.bundle.min.js'
    },
    {
        source: 'chartjs-adapter-date-fns/LICENSE.md',
        target: 'LICENSE-chartjs-adapter-date-fns.md'
    },
    {
        // date-fns is bundled into the adapter build above, so its licence ships too.
        source: 'date-fns/LICENSE.md',
        target: 'LICENSE-date-fns.md'
    }
];
