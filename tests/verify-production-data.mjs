import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStaticServer } from '../scripts/serve-site.mjs';
import {
    fetchProductionFile,
    inspectCsvBundleResponse,
    isExpectedSiteRuntimePath,
    loadExpectedProductionContract,
    mapWithConcurrency,
    pollForExactProductionBundle,
    resolveExpectedFileReader,
    verifyProductionData,
    waitForTrackedCsvResponses
} from '../scripts/verify-production-data.mjs';

assert.equal(isExpectedSiteRuntimePath(''), true);
assert.equal(isExpectedSiteRuntimePath('leaderboard.js'), true);
assert.equal(isExpectedSiteRuntimePath('data/family/siteinfo.csv'), true);
assert.equal(isExpectedSiteRuntimePath('missing-runtime.js'), true);
assert.equal(
    isExpectedSiteRuntimePath('cRvKbNWgiU8YpbA3uc-z6O8LfIY9Zgewd4Zcy8NfyyioooVX98-PyVbw78ux'),
    false
);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRepositoryManifest = await fs.readFile(
    path.join(repoRoot, 'data', 'export_manifest.csv')
);
const bundleId = '20260827T022723137Z-5564E17F';
const staleBundleId = '20260825T143244865Z-7DCFE17F';
const fixture = productionFixture(bundleId);
const expected = await loadExpectedProductionContract({
    readExpectedFile: async relativePath => fixture.files.get(relativePath),
    concurrency: 2
});

assert.equal(expected.bundleId, bundleId);
assert.equal(expected.exportedAtUtc, '2026-08-27T02:27:23.137Z');
assert.equal(expected.files.size, 3);
assert.equal(expected.modes.family.siteName, 'Family Running Championships');
assert.equal(expected.modes.everyone.siteName, 'Age-Graded Running Championships');

await assert.rejects(
    loadExpectedProductionContract({
        readExpectedFile: async relativePath => {
            if (relativePath !== 'data/export_manifest.csv') {
                return fixture.files.get(relativePath);
            }

            return Buffer.from(
                fixture.files.get(relativePath).toString('utf8')
                    .replace('SchemaVersion', 'UnexpectedSchemaColumn'),
                'utf8'
            );
        }
    }),
    /unexpected header/
);

await assert.rejects(
    loadExpectedProductionContract({
        readExpectedFile: async relativePath => {
            if (relativePath !== 'data/family/siteinfo.csv') {
                return fixture.files.get(relativePath);
            }

            return Buffer.from(
                fixture.files.get(relativePath).toString('utf8')
                    .replace(bundleId, staleBundleId),
                'utf8'
            );
        }
    }),
    /does not match bundle/
);

assert.throws(
    () => resolveExpectedFileReader({}),
    /requires readExpectedFile or an absolute stagedRoot/
);
assert.throws(
    () => resolveExpectedFileReader({ stagedRoot: 'relative/path' }),
    /requires readExpectedFile or an absolute stagedRoot/
);

const readerCalls = [];
const injectedReader = resolveExpectedFileReader({
    readExpectedFile: async relativePath => {
        readerCalls.push(relativePath);
        return 'fixture';
    }
});
assert.deepEqual(await injectedReader('data/family/siteinfo.csv'), Buffer.from('fixture'));
assert.deepEqual(readerCalls, ['data/family/siteinfo.csv']);

const concurrencyOrder = [];
let activeWorkers = 0;
let maximumWorkers = 0;
const concurrencyResults = await mapWithConcurrency(
    [1, 2, 3, 4, 5, 6, 7],
    3,
    async value => {
        activeWorkers += 1;
        maximumWorkers = Math.max(maximumWorkers, activeWorkers);
        concurrencyOrder.push(value);
        await new Promise(resolve => setImmediate(resolve));
        activeWorkers -= 1;
        return value * 10;
    }
);
assert.deepEqual(concurrencyResults, [10, 20, 30, 40, 50, 60, 70]);
assert(maximumWorkers <= 3);
assert(maximumWorkers > 1);
assert.equal(concurrencyOrder.length, 7);
await assert.rejects(mapWithConcurrency([1], 0, async value => value), /positive integer/);

const exactCsv = fixture.files.get('data/family/siteinfo.csv');
assert.equal(
    inspectCsvBundleResponse(exactCsv, bundleId, 'data/family/siteinfo.csv').dataRowCount,
    4
);
assert.throws(
    () => inspectCsvBundleResponse(
        Buffer.from(exactCsv.toString('utf8').replace(bundleId, staleBundleId), 'utf8'),
        bundleId,
        'data/family/siteinfo.csv'
    ),
    /instead of/
);
assert.throws(
    () => inspectCsvBundleResponse(
        Buffer.from('Label,Value\r\nSiteName,Family\r\n', 'utf8'),
        bundleId,
        'data/family/siteinfo.csv'
    ),
    /exactly one ExportBundleID/
);

await verifyPollingRetriesStaleAndIndependentlyCachedFiles();
await verifyPollingRetriesTransportFailures();
await verifyPollingRejectsAlteredBytesWithTheExpectedId();
await verifyPollingTimesOutWithActionableIdentity();
await verifyFetchContract();
await verifyTrackedCsvWaitIncludesLateRequests();
await verifyTrackedCsvWaitHasABoundedDeadline();
await verifyLocalBrowserAndFullBundle();

console.log('Production data verification tests passed.');

async function verifyPollingRetriesStaleAndIndependentlyCachedFiles() {
    const stale = productionFixture(staleBundleId);
    const calls = [];
    const callCounts = new Map();
    let clock = 0;

    const result = await pollForExactProductionBundle(expected, {
        productionOrigin: 'https://production.example.test',
        fetchImpl: async (url, options) => {
            const relativePath = requestRelativePath(url);
            const count = (callCounts.get(relativePath) || 0) + 1;
            callCounts.set(relativePath, count);
            calls.push({ url, options, relativePath, count });

            if (relativePath === 'data/export_manifest.csv' && count === 1) {
                return response(stale.files.get(relativePath));
            }
            if (relativePath === 'data/family/siteinfo.csv' && count === 1) {
                return response(stale.files.get(relativePath));
            }

            return response(fixture.files.get(relativePath));
        },
        timeoutMs: 100,
        pollIntervalMs: 5,
        requestTimeoutMs: 0,
        concurrency: 2,
        now: () => clock,
        sleep: async milliseconds => {
            clock += milliseconds;
        }
    });

    assert.equal(result.fetchAttempts, 5);
    assert.equal(callCounts.get('data/export_manifest.csv'), 3);
    assert.equal(callCounts.get('data/family/siteinfo.csv'), 2);
    assert.equal(callCounts.get('data/everyone/siteinfo.csv'), 1);

    for (const call of calls) {
        const parsed = new URL(call.url);
        assert.equal(parsed.search, '', 'Cache busting must use headers, not query strings.');
        assert.equal(call.options.headers['Cache-Control'], 'no-cache');
        assert.equal(call.options.headers.Pragma, 'no-cache');
        assert.equal(call.options.headers.Accept, 'text/csv');
        assert.equal(call.options.redirect, 'error');
    }
}

async function verifyPollingRetriesTransportFailures() {
    let manifestCalls = 0;
    let clock = 0;

    const result = await pollForExactProductionBundle(expected, {
        productionOrigin: 'https://production.example.test',
        fetchImpl: async url => {
            const relativePath = requestRelativePath(url);

            if (relativePath === 'data/export_manifest.csv') {
                manifestCalls += 1;
                if (manifestCalls === 1) throw new Error('temporary DNS failure');
                if (manifestCalls === 2) return response('Not deployed', 404);
            }

            return response(fixture.files.get(relativePath));
        },
        timeoutMs: 100,
        pollIntervalMs: 5,
        requestTimeoutMs: 0,
        now: () => clock,
        sleep: async milliseconds => {
            clock += milliseconds;
        }
    });

    assert.equal(result.fetchAttempts, 5);
    assert.equal(manifestCalls, 4);
}

async function verifyPollingTimesOutWithActionableIdentity() {
    const stale = productionFixture(staleBundleId);
    let clock = 0;

    await assert.rejects(
        pollForExactProductionBundle(expected, {
            productionOrigin: 'https://production.example.test',
            fetchImpl: async url => response(stale.files.get(requestRelativePath(url))),
            timeoutMs: 10,
            pollIntervalMs: 5,
            requestTimeoutMs: 0,
            now: () => clock,
            sleep: async milliseconds => {
                clock += milliseconds;
            }
        }),
        error => {
            assert.match(error.message, new RegExp(bundleId));
            assert.match(error.message, new RegExp(staleBundleId));
            assert.match(error.message, /data\/export_manifest\.csv/);
            return true;
        }
    );
}

async function verifyPollingRejectsAlteredBytesWithTheExpectedId() {
    const alteredFiles = new Map(fixture.files);
    alteredFiles.set(
        'data/family/siteinfo.csv',
        Buffer.from(
            fixture.files.get('data/family/siteinfo.csv').toString('utf8')
                .replace('Levens, UK', 'Different place'),
            'utf8'
        )
    );
    let clock = 0;

    await assert.rejects(
        pollForExactProductionBundle(expected, {
            productionOrigin: 'https://production.example.test',
            fetchImpl: async url => response(alteredFiles.get(requestRelativePath(url))),
            timeoutMs: 5,
            pollIntervalMs: 5,
            requestTimeoutMs: 0,
            now: () => clock,
            sleep: async milliseconds => {
                clock += milliseconds;
            }
        }),
        error => {
            assert.match(error.message, /data\/family\/siteinfo\.csv/);
            assert.match(error.message, new RegExp(bundleId));
            return true;
        }
    );
}

async function verifyFetchContract() {
    const seen = [];
    const fetched = await fetchProductionFile('data/family/siteinfo.csv', {
        productionOrigin: 'https://production.example.test',
        requestTimeoutMs: 0,
        fetchImpl: async (url, options) => {
            seen.push({ url, options });
            return response(exactCsv);
        }
    });

    assert.equal(fetched.ok, true);
    assert.deepEqual(fetched.bytes, exactCsv);
    assert.equal(seen[0].url, 'https://production.example.test/data/family/siteinfo.csv');

    const missing = await fetchProductionFile('data/family/siteinfo.csv', {
        productionOrigin: 'https://production.example.test',
        requestTimeoutMs: 0,
        fetchImpl: async () => response('missing', 404)
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 404);

    await assert.rejects(
        fetchProductionFile('../private.xlsm', {
            productionOrigin: 'https://production.example.test',
            fetchImpl: async () => response('never')
        }),
        /Invalid public-data path/
    );
}

async function verifyTrackedCsvWaitIncludesLateRequests() {
    let clock = 0;
    let activityVersion = 0;
    let lateRequestStarted = false;
    let lateRequestFinished = false;
    const pendingPaths = new Set();
    const responseChecks = [Promise.resolve({ relativePath: 'data/family/siteinfo.csv' })];

    const results = await waitForTrackedCsvResponses({
        getPendingRequestCount: () => pendingPaths.size,
        getActivityVersion: () => activityVersion,
        getResponseChecks: () => responseChecks,
        getPendingRequestPaths: () => [...pendingPaths],
        timeoutMs: 500,
        quietPeriodMs: 50,
        now: () => clock,
        sleep: async milliseconds => {
            clock += milliseconds;

            if (!lateRequestStarted && clock >= 25) {
                lateRequestStarted = true;
                pendingPaths.add('data/family/overall-current-family.csv');
                responseChecks.push(Promise.resolve({
                    relativePath: 'data/family/overall-current-family.csv'
                }));
                activityVersion += 2;
            } else if (!lateRequestFinished && clock >= 50) {
                lateRequestFinished = true;
                pendingPaths.delete('data/family/overall-current-family.csv');
                activityVersion += 1;
            }
        }
    });

    assert.equal(lateRequestFinished, true);
    assert.equal(results.length, 2);
    assert(clock >= 100, 'The verifier must observe a quiet period after the late CSV finishes.');
}

async function verifyTrackedCsvWaitHasABoundedDeadline() {
    let clock = 0;

    await assert.rejects(
        waitForTrackedCsvResponses({
            getPendingRequestCount: () => 1,
            getActivityVersion: () => 1,
            getResponseChecks: () => [],
            getPendingRequestPaths: () => ['data/everyone/webtables.csv'],
            timeoutMs: 50,
            quietPeriodMs: 10,
            now: () => clock,
            sleep: async milliseconds => {
                clock += milliseconds;
            }
        }),
        /did not settle within 50ms[\s\S]*data\/everyone\/webtables\.csv/
    );
}

async function verifyLocalBrowserAndFullBundle() {
    const preview = await createStaticServer({ root: repoRoot, port: 0, silent: true });

    try {
        const result = await verifyProductionData({
            stagedRoot: repoRoot,
            productionOrigin: preview.baseUrl,
            timeoutMs: 10 * 1000,
            pollIntervalMs: 5,
            requestTimeoutMs: 5 * 1000,
            browserTimeoutMs: 10 * 1000,
            fetchConcurrency: 12,
            logger: () => {}
        });

        assert.equal(result.verifiedFileCount, 72);
        assert.equal(result.bundleId, currentRepositoryBundleId());
        assert.equal(result.modes.family.siteName, 'Family Running Championships');
        assert.equal(result.modes.everyone.siteName, 'Age-Graded Running Championships');

        for (const mode of ['family', 'everyone']) {
            assert(result.modes[mode].requestedCsvPaths.includes(`data/${mode}/siteinfo.csv`));
            assert(result.modes[mode].requestedCsvPaths.includes(`data/${mode}/webtables.csv`));
            assert(
                result.modes[mode].requestedCsvPaths.some(relativePath =>
                    relativePath.startsWith(`data/${mode}/overall-`) &&
                    relativePath.endsWith(`-${mode}.csv`)
                )
            );
        }
    } finally {
        await preview.close();
    }
}

function productionFixture(id) {
    const exportedAt = id === bundleId
        ? '2026-08-27T02:27:23.137Z'
        : '2026-08-25T14:32:44.865Z';
    const files = new Map();
    const family = siteInfoCsv(id, 'Family Running Championships', '2026-08-27T02:27:34Z');
    const everyone = siteInfoCsv(id, 'Age-Graded Running Championships', '2026-08-27T02:27:35Z');
    const manifest = [
        'ExportBundleID,ExportedAtUTC,SchemaVersion,Scope,RelativePath,DataRowCount',
        `${id},${exportedAt},1.0,family,data/family/siteinfo.csv,4`,
        `${id},${exportedAt},1.0,everyone,data/everyone/siteinfo.csv,4`,
        ''
    ].join('\r\n');

    files.set('data/export_manifest.csv', Buffer.from(manifest, 'utf8'));
    files.set('data/family/siteinfo.csv', Buffer.from(family, 'utf8'));
    files.set('data/everyone/siteinfo.csv', Buffer.from(everyone, 'utf8'));

    return { files };
}

function siteInfoCsv(id, siteName, updated) {
    return [
        'Label,Value,ExportBundleID',
        `LastUpdatedUTC,${updated},${id}`,
        `PublishedFrom,"Levens, UK",${id}`,
        `SiteVersion,v1.5,${id}`,
        `SiteName,"${siteName}",${id}`,
        ''
    ].join('\r\n');
}

function response(body, status = 200) {
    return new Response(body, {
        status,
        headers: { 'Content-Type': 'text/csv; charset=utf-8' }
    });
}

function requestRelativePath(url) {
    return decodeURIComponent(new URL(url).pathname).replace(/^\/+/, '');
}

function currentRepositoryBundleId() {
    const text = requireText(fixtureRepositoryManifest);
    return text.split(/\r?\n/)[1].split(',')[0];
}

function requireText(value) {
    return Buffer.from(value).toString('utf8').replace(/^\uFEFF/, '');
}
