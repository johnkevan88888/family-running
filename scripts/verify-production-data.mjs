import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { findChromiumExecutable, loadPlaywright } from './browser-runtime.mjs';
import { parseCsv } from './export-bundle-tools.mjs';
import { isPublishedPath } from './published-site-entries.mjs';

export const PRODUCTION_ORIGIN = 'https://www.aceofrace.com';
export const PRODUCTION_VERIFICATION_TIMEOUT_MS = 15 * 60 * 1000;
export const PRODUCTION_POLL_INTERVAL_MS = 10 * 1000;
export const PRODUCTION_REQUEST_TIMEOUT_MS = 15 * 1000;
export const PRODUCTION_FETCH_CONCURRENCY = 8;
export const PRODUCTION_BROWSER_TIMEOUT_MS = 20 * 1000;

const manifestPath = 'data/export_manifest.csv';
const manifestHeaders = [
    'ExportBundleID',
    'ExportedAtUTC',
    'SchemaVersion',
    'Scope',
    'RelativePath',
    'DataRowCount'
];
const siteInfoHeaders = ['Label', 'Value', 'ExportBundleID'];
const modes = ['family', 'everyone'];
const requestHeaders = Object.freeze({
    Accept: 'text/csv',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache'
});

/**
 * Verifies that the immutable public CSVs from a reviewed data commit are the
 * exact bytes served by production, then proves that both supported query modes
 * render while requesting CSV rows from that same export bundle.
 *
 * `readExpectedFile` is the release integration point. It receives a safe
 * repository-relative `data/...csv` path and must return that file's exact
 * bytes (or UTF-8 text) from the immutable reviewed commit, for example via
 * `git show <validated-head>:<path>`. `stagedRoot` is a convenience fallback
 * for deterministic tests and standalone diagnostics only.
 */
export async function verifyProductionData(options = {}) {
    const logger = options.logger || (message => console.log(message));
    const productionOrigin = normalizeProductionOrigin(
        options.productionOrigin || PRODUCTION_ORIGIN
    );
    const readExpectedFile = resolveExpectedFileReader(options);
    const expected = await loadExpectedProductionContract({
        readExpectedFile,
        concurrency: options.expectedReadConcurrency || PRODUCTION_FETCH_CONCURRENCY
    });

    logger(`Waiting for production bundle ${expected.bundleId}...`);

    const dataProof = await pollForExactProductionBundle(expected, {
        productionOrigin,
        fetchImpl: options.fetchImpl || globalThis.fetch,
        timeoutMs: options.timeoutMs ?? PRODUCTION_VERIFICATION_TIMEOUT_MS,
        pollIntervalMs: options.pollIntervalMs ?? PRODUCTION_POLL_INTERVAL_MS,
        requestTimeoutMs: options.requestTimeoutMs ?? PRODUCTION_REQUEST_TIMEOUT_MS,
        concurrency: options.fetchConcurrency || PRODUCTION_FETCH_CONCURRENCY,
        now: options.now || monotonicNow,
        sleep: options.sleep || defaultSleep,
        logger
    });

    const rendering = await verifyProductionRendering(expected, {
        productionOrigin,
        launchBrowser: options.launchBrowser,
        browserTimeoutMs: options.browserTimeoutMs ?? PRODUCTION_BROWSER_TIMEOUT_MS
    });

    logger(`Production bundle ${expected.bundleId} is live in Family and Everyone.`);

    return {
        bundleId: expected.bundleId,
        exportedAtUtc: expected.exportedAtUtc,
        productionOrigin,
        verifiedFileCount: expected.files.size,
        fetchAttempts: dataProof.fetchAttempts,
        modes: rendering.modes
    };
}

export function resolveExpectedFileReader({ readExpectedFile, stagedRoot } = {}) {
    if (typeof readExpectedFile === 'function') {
        return async relativePath => toBuffer(await readExpectedFile(relativePath));
    }

    if (!stagedRoot || !path.isAbsolute(stagedRoot)) {
        throw new Error(
            'Production verification requires readExpectedFile or an absolute stagedRoot.'
        );
    }

    const resolvedRoot = path.resolve(stagedRoot);

    return async relativePath => {
        const safePath = validatePublicDataPath(relativePath);
        const absolutePath = path.resolve(resolvedRoot, ...safePath.split('/'));
        const relative = path.relative(resolvedRoot, absolutePath);

        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error(`Expected public-data path escapes stagedRoot: ${safePath}`);
        }

        return fs.readFile(absolutePath);
    };
}

export async function loadExpectedProductionContract({
    readExpectedFile,
    concurrency = PRODUCTION_FETCH_CONCURRENCY
}) {
    if (typeof readExpectedFile !== 'function') {
        throw new Error('Expected-file reader is required.');
    }

    const manifestBytes = toBuffer(await readExpectedFile(manifestPath));
    const manifestRows = parseCsvDocument(manifestBytes, manifestPath);

    requireExactHeader(manifestRows, manifestHeaders, manifestPath);
    requireRectangularRows(manifestRows, manifestHeaders.length, manifestPath);

    const manifestObjects = csvObjects(manifestRows);

    if (manifestObjects.length === 0) {
        throw new Error(`${manifestPath} has no public-data entries.`);
    }

    const bundleIds = uniqueValues(manifestObjects, 'ExportBundleID');
    const exportedAtValues = uniqueValues(manifestObjects, 'ExportedAtUTC');
    const schemaVersions = uniqueValues(manifestObjects, 'SchemaVersion');

    if (bundleIds.length !== 1 || !/^\d{8}T\d{9}Z-[A-F0-9]{8}$/.test(bundleIds[0] || '')) {
        throw new Error(`${manifestPath} does not contain one valid ExportBundleID.`);
    }
    if (exportedAtValues.length !== 1 || !Number.isFinite(Date.parse(exportedAtValues[0]))) {
        throw new Error(`${manifestPath} does not contain one valid ExportedAtUTC.`);
    }
    if (schemaVersions.length !== 1 || schemaVersions[0] !== '1.0') {
        throw new Error(`${manifestPath} does not contain only schema version 1.0.`);
    }

    const bundleId = bundleIds[0];
    const relativePaths = [];
    const manifestByPath = new Map();

    for (const row of manifestObjects) {
        const relativePath = validatePublicDataPath(row.RelativePath);

        if (relativePath === manifestPath) {
            throw new Error(`${manifestPath} must not list itself as a bundle member.`);
        }
        if (!['family', 'everyone', 'shared'].includes(row.Scope)) {
            throw new Error(`${manifestPath} has invalid scope "${row.Scope}" for ${relativePath}.`);
        }
        if (!/^\d+$/.test(row.DataRowCount)) {
            throw new Error(`${manifestPath} has invalid DataRowCount for ${relativePath}.`);
        }
        if (manifestByPath.has(relativePath)) {
            throw new Error(`${manifestPath} lists ${relativePath} more than once.`);
        }

        manifestByPath.set(relativePath, row);
        relativePaths.push(relativePath);
    }

    for (const mode of modes) {
        const relativePath = `data/${mode}/siteinfo.csv`;
        const entry = manifestByPath.get(relativePath);

        if (!entry || entry.Scope !== mode) {
            throw new Error(`${manifestPath} is missing its ${mode} siteinfo contract.`);
        }
    }

    const expectedEntries = await mapWithConcurrency(
        relativePaths,
        concurrency,
        async relativePath => [relativePath, toBuffer(await readExpectedFile(relativePath))]
    );
    const files = new Map([[manifestPath, manifestBytes], ...expectedEntries]);
    const modeContracts = {};

    for (const relativePath of relativePaths) {
        const bytes = files.get(relativePath);
        const rows = parseCsvDocument(bytes, relativePath);
        const expectedCount = Number(manifestByPath.get(relativePath).DataRowCount);
        const actualCount = Math.max(0, rows.length - 1);

        if (actualCount !== expectedCount) {
            throw new Error(
                `${relativePath} has ${actualCount} data rows; its manifest records ${expectedCount}.`
            );
        }

        requireFileBundleId(rows, bundleId, relativePath);
    }

    for (const mode of modes) {
        const relativePath = `data/${mode}/siteinfo.csv`;
        const rows = parseCsvDocument(files.get(relativePath), relativePath);

        requireExactHeader(rows, siteInfoHeaders, relativePath);
        requireRectangularRows(rows, siteInfoHeaders.length, relativePath);

        const objects = csvObjects(rows);
        const byLabel = new Map();

        for (const row of objects) {
            if (!row.Label || byLabel.has(row.Label)) {
                throw new Error(`${relativePath} contains a blank or duplicate Label.`);
            }
            byLabel.set(row.Label, row.Value);
        }

        for (const label of ['LastUpdatedUTC', 'PublishedFrom', 'SiteVersion', 'SiteName']) {
            if (!byLabel.has(label)) {
                throw new Error(`${relativePath} is missing ${label}.`);
            }
        }

        modeContracts[mode] = {
            mode,
            relativePath,
            rows,
            siteName: byLabel.get('SiteName'),
            lastUpdatedUtc: byLabel.get('LastUpdatedUTC')
        };
    }

    return {
        bundleId,
        exportedAtUtc: exportedAtValues[0],
        manifestRows,
        manifestByPath,
        files,
        modes: modeContracts
    };
}

export async function pollForExactProductionBundle(expected, options = {}) {
    const productionOrigin = normalizeProductionOrigin(
        options.productionOrigin || PRODUCTION_ORIGIN
    );
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const timeoutMs = options.timeoutMs ?? PRODUCTION_VERIFICATION_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? PRODUCTION_POLL_INTERVAL_MS;
    const requestTimeoutMs = options.requestTimeoutMs ?? PRODUCTION_REQUEST_TIMEOUT_MS;
    const concurrency = options.concurrency || PRODUCTION_FETCH_CONCURRENCY;
    const now = options.now || monotonicNow;
    const sleep = options.sleep || defaultSleep;
    const logger = options.logger || (() => {});

    if (typeof fetchImpl !== 'function') {
        throw new Error('Production verification requires a fetch implementation.');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
        throw new Error('Production verification timeout must be a nonnegative number.');
    }

    const deadline = now() + timeoutMs;
    let fetchAttempts = 0;
    let lastSummary = '';

    const pollPaths = async paths => {
        const pending = new Set(paths);
        let failures = [];
        let attempted = false;

        while (pending.size > 0) {
            if (attempted && now() >= deadline) {
                throw productionTimeoutError(expected.bundleId, pending, failures);
            }

            attempted = true;
            fetchAttempts += 1;
            const results = await mapWithConcurrency(
                [...pending],
                concurrency,
                relativePath => {
                    const remaining = deadline - now();

                    if (remaining <= 0) {
                        return {
                            ok: false,
                            relativePath,
                            status: null,
                            error: 'verification deadline expired'
                        };
                    }

                    return fetchProductionFile(relativePath, {
                        productionOrigin,
                        fetchImpl,
                        requestTimeoutMs: Math.min(requestTimeoutMs, remaining)
                    });
                }
            );
            failures = [];

            for (const result of results) {
                const expectedBytes = expected.files.get(result.relativePath);

                if (result.ok && buffersEqual(result.bytes, expectedBytes)) {
                    pending.delete(result.relativePath);
                    continue;
                }

                failures.push(describeFileMismatch(result, expected.bundleId));
            }

            if (pending.size === 0) {
                return;
            }

            const summary = summarizePendingFiles(pending, failures);
            if (summary !== lastSummary) {
                logger(summary);
                lastSummary = summary;
            }

            const remaining = deadline - now();
            if (remaining <= 0) {
                throw productionTimeoutError(expected.bundleId, pending, failures);
            }

            await sleep(Math.min(pollIntervalMs, remaining));
        }
    };

    // The manifest is the completion marker. Avoid repeatedly downloading the
    // full bundle while Pages still serves the previous deployment.
    await pollPaths([manifestPath]);
    await pollPaths([...expected.files.keys()].filter(file => file !== manifestPath));
    // Re-read the completion marker after every independently cached data path
    // matched, so the proof cannot straddle a later deployment.
    await pollPaths([manifestPath]);

    return { fetchAttempts };
}

export async function fetchProductionFile(relativePath, {
    productionOrigin = PRODUCTION_ORIGIN,
    fetchImpl = globalThis.fetch,
    requestTimeoutMs = PRODUCTION_REQUEST_TIMEOUT_MS
} = {}) {
    const safePath = validatePublicDataPath(relativePath);
    const url = productionFileUrl(productionOrigin, safePath);

    try {
        const response = await fetchImpl(url, {
            method: 'GET',
            headers: { ...requestHeaders },
            redirect: 'error',
            cache: 'no-store',
            signal: requestTimeoutMs > 0 && typeof AbortSignal?.timeout === 'function'
                ? AbortSignal.timeout(requestTimeoutMs)
                : undefined
        });

        if (response.status !== 200) {
            return {
                ok: false,
                relativePath: safePath,
                status: response.status,
                error: `HTTP ${response.status}`
            };
        }

        return {
            ok: true,
            relativePath: safePath,
            status: response.status,
            bytes: Buffer.from(await response.arrayBuffer())
        };
    } catch (error) {
        return {
            ok: false,
            relativePath: safePath,
            status: null,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

export async function verifyProductionRendering(expected, options = {}) {
    const productionOrigin = normalizeProductionOrigin(
        options.productionOrigin || PRODUCTION_ORIGIN
    );
    const browserTimeoutMs = options.browserTimeoutMs ?? PRODUCTION_BROWSER_TIMEOUT_MS;
    const launchBrowser = options.launchBrowser || defaultBrowserLauncher;
    const browser = await launchBrowser();
    const modeResults = {};

    try {
        for (const mode of modes) {
            modeResults[mode] = await verifyRenderedMode(browser, expected, mode, {
                productionOrigin,
                browserTimeoutMs
            });
        }
    } finally {
        await browser.close();
    }

    return { modes: modeResults };
}

export function inspectCsvBundleResponse(bytes, expectedBundleId, relativePath) {
    const rows = parseCsvDocument(bytes, relativePath);

    requireRectangularRows(rows, rows[0]?.length || 0, relativePath);

    if (rows.length === 0) {
        throw new Error(`${relativePath} is empty.`);
    }

    const bundleIndexes = rows[0]
        .map((header, index) => header === 'ExportBundleID' ? index : -1)
        .filter(index => index >= 0);

    if (bundleIndexes.length !== 1) {
        throw new Error(`${relativePath} does not have exactly one ExportBundleID column.`);
    }

    const bundleIndex = bundleIndexes[0];
    const dataRows = rows.slice(1).filter(row => row.some(value => value !== ''));

    for (const [index, row] of dataRows.entries()) {
        if (row[bundleIndex] !== expectedBundleId) {
            throw new Error(
                `${relativePath} row ${index + 2} carries ExportBundleID ` +
                `"${row[bundleIndex] || '(blank)'}" instead of "${expectedBundleId}".`
            );
        }
    }

    return { rows, dataRowCount: dataRows.length };
}

export async function mapWithConcurrency(items, concurrency, mapper) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new Error('Concurrency must be a positive integer.');
    }

    const results = new Array(items.length);
    let nextIndex = 0;

    const workers = Array.from(
        { length: Math.min(concurrency, Math.max(items.length, 1)) },
        async () => {
            while (true) {
                const index = nextIndex;
                nextIndex += 1;

                if (index >= items.length) {
                    return;
                }

                results[index] = await mapper(items[index], index);
            }
        }
    );

    await Promise.all(workers);
    return results;
}

export async function waitForTrackedCsvResponses({
    getPendingRequestCount,
    getActivityVersion,
    getResponseChecks,
    getPendingRequestPaths = () => [],
    timeoutMs,
    quietPeriodMs = 200,
    now = monotonicNow,
    sleep = defaultSleep
}) {
    if (
        typeof getPendingRequestCount !== 'function' ||
        typeof getActivityVersion !== 'function' ||
        typeof getResponseChecks !== 'function' ||
        typeof getPendingRequestPaths !== 'function'
    ) {
        throw new Error('Tracked CSV response callbacks are required.');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error('Tracked CSV response timeout must be positive.');
    }
    if (!Number.isFinite(quietPeriodMs) || quietPeriodMs < 0) {
        throw new Error('Tracked CSV quiet period cannot be negative.');
    }

    const startedAt = now();
    const deadline = startedAt + timeoutMs;
    let observedVersion = getActivityVersion();
    let quietSince = startedAt;

    while (true) {
        const currentTime = now();
        const activityVersion = getActivityVersion();

        if (activityVersion !== observedVersion) {
            observedVersion = activityVersion;
            quietSince = currentTime;
        }

        const pendingCount = getPendingRequestCount();
        if (pendingCount === 0 && currentTime - quietSince >= quietPeriodMs) {
            const checks = [...getResponseChecks()];
            const stableVersion = activityVersion;
            const results = await settleCsvResponseChecks(
                checks,
                deadline - currentTime
            );

            if (
                getPendingRequestCount() === 0 &&
                getActivityVersion() === stableVersion &&
                getResponseChecks().length === checks.length
            ) {
                return results;
            }

            observedVersion = getActivityVersion();
            quietSince = now();
            continue;
        }

        if (currentTime >= deadline) {
            const pendingPaths = [...new Set(getPendingRequestPaths())];
            const detail = pendingPaths.length > 0
                ? ` Pending: ${pendingPaths.join(', ')}.`
                : '';
            throw new Error(
                `Public CSV browser requests did not settle within ${timeoutMs}ms.` + detail
            );
        }

        const quietTimeRemaining = pendingCount === 0
            ? Math.max(1, quietPeriodMs - (currentTime - quietSince))
            : 25;
        await sleep(Math.max(
            1,
            Math.min(25, deadline - currentTime, quietTimeRemaining)
        ));
    }
}

async function settleCsvResponseChecks(checks, timeoutMs) {
    if (timeoutMs <= 0) {
        throw new Error('Public CSV browser response checks exceeded their deadline.');
    }

    let timeoutId;
    const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(
            () => reject(new Error(
                'Public CSV browser response checks exceeded their deadline.'
            )),
            Math.max(1, Math.ceil(timeoutMs))
        );
    });

    try {
        return await Promise.race([Promise.all(checks), timeout]);
    } finally {
        clearTimeout(timeoutId);
    }
}

async function verifyRenderedMode(browser, expected, mode, {
    productionOrigin,
    browserTimeoutMs
}) {
    const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        serviceWorkers: 'block',
        extraHTTPHeaders: {
            'Cache-Control': 'no-cache',
            Pragma: 'no-cache'
        }
    });
    const page = await context.newPage();
    const errors = [];
    const requestedCsvPaths = [];
    const csvResponseChecks = [];
    const pendingCsvRequests = new Set();
    let csvActivityVersion = 0;
    const origin = new URL(productionOrigin).origin;
    const otherMode = mode === 'family' ? 'everyone' : 'family';

    page.setDefaultTimeout(browserTimeoutMs);
    page.setDefaultNavigationTimeout(Math.max(browserTimeoutMs, 30 * 1000));

    await context.route('**/*', route => {
        const url = route.request().url();

        if (url === 'about:blank' || sameOrigin(url, origin)) {
            return route.continue();
        }

        return route.abort();
    });

    page.on('request', request => {
        if (!sameOrigin(request.url(), origin)) return;

        const relativePath = requestPath(request.url());
        if (isPublicCsvPath(relativePath)) {
            requestedCsvPaths.push(relativePath);
            pendingCsvRequests.add(request);
            csvActivityVersion += 1;
        }
    });
    page.on('requestfinished', request => {
        if (pendingCsvRequests.delete(request)) {
            csvActivityVersion += 1;
        }
    });
    page.on('requestfailed', request => {
        if (pendingCsvRequests.delete(request)) {
            csvActivityVersion += 1;
        }
        if (
            sameOrigin(request.url(), origin) &&
            isExpectedSiteRuntimePath(requestPath(request.url()))
        ) {
            errors.push(
                `${request.url()} failed: ${request.failure()?.errorText || 'unknown error'}`
            );
        }
    });
    page.on('pageerror', error => errors.push(`JavaScript exception: ${error.message}`));
    page.on('console', message => {
        const locationUrl = message.location().url;

        if (
            message.type() === 'error' &&
            (
                !locationUrl ||
                (
                    sameOrigin(locationUrl, origin) &&
                    isExpectedSiteRuntimePath(requestPath(locationUrl))
                )
            )
        ) {
            errors.push(`Console error: ${message.text()}`);
        }
    });
    page.on('response', response => {
        if (!sameOrigin(response.url(), origin)) return;

        const relativePath = requestPath(response.url());

        if (
            response.status() >= 400 &&
            isExpectedSiteRuntimePath(relativePath)
        ) {
            errors.push(`${response.url()} returned HTTP ${response.status()}`);
        }

        if (!isPublicCsvPath(relativePath)) return;

        const check = (async () => {
            if (response.status() !== 200) {
                throw new Error(`${relativePath} returned HTTP ${response.status()}.`);
            }

            const bytes = Buffer.from(await response.body());
            const result = inspectCsvBundleResponse(bytes, expected.bundleId, relativePath);

            if (relativePath === expected.modes[mode].relativePath) {
                const expectedRows = expected.modes[mode].rows;
                if (!rowsEqual(result.rows, expectedRows)) {
                    throw new Error(`${relativePath} did not match the reviewed site metadata.`);
                }
            }

            return { relativePath, dataRowCount: result.dataRowCount };
        })()
            .catch(error => ({ relativePath, error }))
            .finally(() => {
                csvActivityVersion += 1;
            });

        csvResponseChecks.push(check);
        csvActivityVersion += 1;
    });

    try {
        const navigation = await page.goto(
            `${productionOrigin}/?site=${mode}`,
            { waitUntil: 'domcontentloaded' }
        );

        if (!navigation || navigation.status() !== 200) {
            errors.push(`Championship page returned HTTP ${navigation?.status() || 'unknown'}.`);
        }

        await page.waitForSelector('#site-title', { state: 'visible' });
        await page.waitForSelector('#leaderboards table', { state: 'visible' });
        await page.waitForFunction(expectedSiteName => (
            document.querySelector('#site-title')?.textContent?.trim() === expectedSiteName
        ), expected.modes[mode].siteName);
        await page.waitForFunction(() => {
            const updated = document.querySelector('#last-updated')
                ?.textContent
                ?.replace(/\s+/g, ' ')
                .trim() || '';

            return (
                document.querySelectorAll('#leaderboards table tbody tr').length > 0 &&
                updated.includes('Updated') &&
                !/loading|unavailable/i.test(updated)
            );
        });

        const presentation = await page.evaluate(() => ({
            siteName: document.querySelector('#site-title')?.textContent?.trim() || '',
            modeLabel: document.querySelector('#site-mode-label')?.textContent?.trim() || '',
            updated: document.querySelector('#last-updated')?.textContent?.replace(/\s+/g, ' ').trim() || '',
            leaderboardRows: document.querySelectorAll('#leaderboards table tbody tr').length
        }));

        if (presentation.siteName !== expected.modes[mode].siteName) {
            errors.push(
                `Rendered site title "${presentation.siteName}" instead of ` +
                `"${expected.modes[mode].siteName}".`
            );
        }

        const expectedModeLabel = mode === 'family' ? 'Family site' : 'Everyone site';
        if (presentation.modeLabel !== expectedModeLabel) {
            errors.push(
                `Rendered mode label "${presentation.modeLabel}" instead of "${expectedModeLabel}".`
            );
        }
        if (
            !presentation.updated.includes('Updated') ||
            /loading|unavailable/i.test(presentation.updated)
        ) {
            errors.push(`Rendered update status was "${presentation.updated || '(blank)'}".`);
        }
        if (presentation.leaderboardRows < 1) {
            errors.push('Rendered no championship leaderboard data rows.');
        }

        const checkedResponses = await waitForTrackedCsvResponses({
            getPendingRequestCount: () => pendingCsvRequests.size,
            getActivityVersion: () => csvActivityVersion,
            getResponseChecks: () => csvResponseChecks,
            getPendingRequestPaths: () => [...pendingCsvRequests]
                .map(request => requestPath(request.url())),
            timeoutMs: browserTimeoutMs
        });
        for (const result of checkedResponses) {
            if (result.error) {
                errors.push(result.error.message);
            }
        }

        const uniquePaths = [...new Set(requestedCsvPaths)];
        const requiredPaths = [
            `data/${mode}/siteinfo.csv`,
            `data/${mode}/webtables.csv`
        ];

        for (const requiredPath of requiredPaths) {
            if (!uniquePaths.includes(requiredPath)) {
                errors.push(`Browser did not request ${requiredPath}.`);
            }
        }

        const selectedLeaderboardPaths = uniquePaths.filter(relativePath =>
            relativePath.startsWith(`data/${mode}/`) &&
            !requiredPaths.includes(relativePath) &&
            relativePath.endsWith('.csv')
        );
        if (selectedLeaderboardPaths.length === 0) {
            errors.push(`Browser requested no rendered ${mode} leaderboard CSV.`);
        }
        if (uniquePaths.some(relativePath => relativePath.startsWith(`data/${otherMode}/`))) {
            errors.push(`Browser requested data from the unselected ${otherMode} mode.`);
        }

        if (errors.length > 0) {
            throw new Error(
                `${mode} production rendering verification failed:\n- ${errors.join('\n- ')}`
            );
        }

        return {
            siteName: presentation.siteName,
            lastUpdatedUtc: expected.modes[mode].lastUpdatedUtc,
            requestedCsvPaths: uniquePaths.sort()
        };
    } finally {
        await context.close();
    }
}

async function defaultBrowserLauncher() {
    const { chromium } = loadPlaywright();

    return chromium.launch({
        headless: true,
        executablePath: findChromiumExecutable(),
        args: ['--disable-dev-shm-usage']
    });
}

function requireFileBundleId(rows, expectedBundleId, relativePath) {
    if (rows.length === 0) {
        throw new Error(`${relativePath} is empty.`);
    }

    requireRectangularRows(rows, rows[0].length, relativePath);

    const bundleIndexes = rows[0]
        .map((header, index) => header === 'ExportBundleID' ? index : -1)
        .filter(index => index >= 0);

    if (bundleIndexes.length !== 1) {
        throw new Error(`${relativePath} does not have exactly one ExportBundleID column.`);
    }

    const bundleIndex = bundleIndexes[0];
    for (const [index, row] of rows.slice(1).entries()) {
        if (row[bundleIndex] !== expectedBundleId) {
            throw new Error(
                `${relativePath} row ${index + 2} does not match bundle ${expectedBundleId}.`
            );
        }
    }
}

function parseCsvDocument(value, label) {
    const text = toBuffer(value).toString('utf8').replace(/^\uFEFF/, '');

    try {
        return parseCsv(text);
    } catch (error) {
        throw new Error(`${label} is not valid CSV: ${error.message}`);
    }
}

function requireExactHeader(rows, expectedHeaders, label) {
    if (!rowsEqual([rows[0] || []], [expectedHeaders])) {
        throw new Error(`${label} has an unexpected header.`);
    }
}

function requireRectangularRows(rows, width, label) {
    for (const [index, row] of rows.entries()) {
        if (row.length !== width) {
            throw new Error(
                `${label} row ${index + 1} has ${row.length} fields; expected ${width}.`
            );
        }
    }
}

function csvObjects(rows) {
    const headers = rows[0] || [];

    return rows.slice(1)
        .filter(row => row.some(value => value !== ''))
        .map(row => Object.fromEntries(
            headers.map((header, index) => [header, row[index] ?? ''])
        ));
}

function uniqueValues(rows, field) {
    return [...new Set(rows.map(row => String(row[field] || '')))];
}

function validatePublicDataPath(value) {
    const relativePath = String(value || '').replaceAll('\\', '/');
    const segments = relativePath.split('/');

    if (
        relativePath !== value ||
        !relativePath.startsWith('data/') ||
        !relativePath.toLowerCase().endsWith('.csv') ||
        relativePath.startsWith('/') ||
        relativePath.includes('//') ||
        /[\u0000-\u001F<>:"|?*%~]/.test(relativePath) ||
        segments.some(segment => !segment || segment === '.' || segment === '..')
    ) {
        throw new Error(`Invalid public-data path: "${value}".`);
    }

    return relativePath;
}

function normalizeProductionOrigin(value) {
    let parsed;

    try {
        parsed = new URL(value);
    } catch {
        throw new Error(`Production origin is invalid: "${value}".`);
    }

    if (
        !['http:', 'https:'].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash ||
        !['', '/'].includes(parsed.pathname)
    ) {
        throw new Error(`Production origin must be an HTTP(S) origin without a path: "${value}".`);
    }

    return parsed.origin;
}

function productionFileUrl(origin, relativePath) {
    return new URL(`/${relativePath}`, `${normalizeProductionOrigin(origin)}/`).href;
}

function describeFileMismatch(result, expectedBundleId) {
    if (!result.ok) {
        return `${result.relativePath}: ${result.error}`;
    }

    const observed = observedBundleIds(result.bytes);
    const detail = observed.length > 0
        ? `observed bundle ${observed.join(', ')}`
        : 'content differs';

    return `${result.relativePath}: ${detail}; expected ${expectedBundleId}`;
}

function observedBundleIds(bytes) {
    try {
        const rows = parseCsvDocument(bytes, 'production response');
        const index = rows[0]?.indexOf('ExportBundleID') ?? -1;

        if (index < 0) return [];

        return [...new Set(
            rows.slice(1)
                .map(row => row[index])
                .filter(Boolean)
        )];
    } catch {
        return [];
    }
}

function summarizePendingFiles(pending, failures) {
    const paths = [...pending];
    const shown = failures.slice(0, 3).join('; ');
    const more = paths.length > 3 ? `; ${paths.length - 3} more pending` : '';

    return `Production is not current yet (${shown}${more}). Retrying...`;
}

function productionTimeoutError(expectedBundleId, pending, failures) {
    const detail = failures.slice(0, 8).join('\n- ');
    const remainder = pending.size > 8 ? `\n- ${pending.size - 8} more file(s) pending` : '';

    return new Error(
        `Production did not serve exact bundle ${expectedBundleId} before the verification timeout.\n` +
        `Pending files: ${[...pending].join(', ')}\n` +
        `Last observations:\n- ${detail}${remainder}`
    );
}

function toBuffer(value) {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    if (typeof value === 'string') return Buffer.from(value, 'utf8');

    throw new Error('Expected-file reader must return a Buffer, Uint8Array, or UTF-8 string.');
}

function buffersEqual(left, right) {
    return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.equals(right);
}

function rowsEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function sameOrigin(value, origin) {
    try {
        return new URL(value).origin === origin;
    } catch {
        return false;
    }
}

function requestPath(value) {
    try {
        return decodeURIComponent(new URL(value).pathname)
            .replace(/^\/+/, '')
            .replaceAll('\\', '/');
    } catch {
        return '';
    }
}

function isPublicCsvPath(relativePath) {
    return relativePath.startsWith('data/') && relativePath.toLowerCase().endsWith('.csv');
}

export function isExpectedSiteRuntimePath(relativePath) {
    const normalized = String(relativePath || '').replace(/^\/+/, '').replaceAll('\\', '/');

    if (!normalized || isPublishedPath(normalized)) {
        return true;
    }

    // This is a static site, so an actual runtime request has a file extension.
    // Some locally installed web-protection products inject opaque, extensionless
    // same-origin probes into Chromium. Those probes are not part of the Pages
    // artifact and must not be mistaken for a broken site resource.
    return /\.(?:avif|css|csv|gif|html?|ico|jpe?g|js|json|mjs|png|svg|txt|webmanifest|webp|woff2?|xml)$/i
        .test(normalized);
}

function defaultSleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function monotonicNow() {
    return performance.now();
}
