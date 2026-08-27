import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    adminClientScript,
    adminShellDocument,
    adminStylesheet
} from '../gallery-admin/src/admin-assets.js';
import {
    findChromiumExecutable,
    loadPlaywright
} from '../scripts/browser-runtime.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const screenshotsDirectory = path.join(repoRoot, 'test-artifacts', 'screenshots');
const catalog = {
    schemaVersion: '1.0',
    exportBundleId: 'synthetic-browser-bundle',
    sourceRevision: `sha256:${'1'.repeat(64)}`,
    suppressionRevision: `sha256:${'2'.repeat(64)}`,
    blockedAthleteIds: [],
    sites: {
        family: {
            races: [{
                raceDate: '2026-08-22',
                raceEvent: 'Family Synthetic Parkrun',
                raceDistance: '5 km'
            }],
            roster: [
                { athleteId: 'family-spectator', participant: 'Family Synthetic Spectator' },
                { athleteId: 'family-runner', participant: 'Family Synthetic Runner' }
            ],
            results: [{
                athleteId: 'family-runner',
                raceDate: '2026-08-22',
                raceEvent: 'Family Synthetic Parkrun',
                raceDistance: '5 km'
            }]
        },
        everyone: {
            races: [{
                raceDate: '2026-08-23',
                raceEvent: 'Everyone Synthetic Road Race',
                raceDistance: '10 km'
            }],
            roster: [
                { athleteId: 'everyone-spectator', participant: 'Everyone Synthetic Spectator' },
                { athleteId: 'everyone-runner', participant: 'Everyone Synthetic Runner' }
            ],
            results: [{
                athleteId: 'everyone-runner',
                raceDate: '2026-08-23',
                raceEvent: 'Everyone Synthetic Road Race',
                raceDistance: '10 km'
            }]
        }
    }
};
const areas = [
    {
        siteMode: 'family',
        label: 'Family Gallery',
        raceDate: '2026-08-22',
        raceEvent: 'Family Synthetic Parkrun',
        runner: 'Family Synthetic Runner',
        spectator: 'Family Synthetic Spectator',
        excludedRaceEvent: 'Everyone Synthetic Road Race'
    },
    {
        siteMode: 'everyone',
        label: 'Everyone Gallery',
        raceDate: '2026-08-23',
        raceEvent: 'Everyone Synthetic Road Race',
        runner: 'Everyone Synthetic Runner',
        spectator: 'Everyone Synthetic Spectator',
        excludedRaceEvent: 'Family Synthetic Parkrun'
    }
];
const viewports = [
    { name: 'desktop', width: 1440, height: 900, isMobile: false },
    { name: 'mobile', width: 390, height: 844, isMobile: true }
];
const observedApiRequests = [];

await fs.mkdir(screenshotsDirectory, { recursive: true });
const server = createAdminServer(observedApiRequests);
const origin = await listen(server);
const { chromium } = loadPlaywright();
const browser = await chromium.launch({
    headless: true,
    executablePath: findChromiumExecutable(),
    args: ['--disable-dev-shm-usage']
});

try {
    for (const area of areas) {
        for (const viewport of viewports) {
            await checkViewport(browser, origin, viewport, area);
        }
    }
    await checkInvalidContext(browser, origin, '', 'missing');
    await checkInvalidContext(browser, origin, '?site=both', 'invalid');
    await checkInvalidContext(browser, origin, '?site=family&extra=1', 'additional');
} finally {
    await browser.close();
    await close(server);
}

console.log('Gallery administration area-locked responsive browser checks passed.');

async function checkViewport(browserInstance, adminOrigin, viewport, area) {
    const context = await browserInstance.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        isMobile: viewport.isMobile,
        deviceScaleFactor: 1
    });
    const page = await context.newPage();
    const browserErrors = [];
    const requestStart = observedApiRequests.length;
    page.on('pageerror', error => browserErrors.push(error.message));
    page.on('console', message => {
        if (message.type() === 'error') {
            browserErrors.push(message.text());
        }
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });

    try {
        const response = await page.goto(
            `${adminOrigin}?site=${area.siteMode}`,
            { waitUntil: 'networkidle' }
        );
        assert.equal(response?.status(), 200);
        await page.locator('#admin-workspace').waitFor({ state: 'visible' });
        await assertPageBasics(page, area);

        const dateOptions = await page.locator('#race-date option').allTextContents();
        assert.ok(dateOptions.includes(formatIsoDate(area.raceDate)));
        assert.equal(dateOptions.length, 2);
        await page.locator('#race-date').selectOption(area.raceDate);

        const raceOptions = await page.locator('#race-choice option').allTextContents();
        assert.ok(raceOptions.some(value => value.includes(area.raceEvent)));
        assert.ok(raceOptions.every(value => !value.includes(area.excludedRaceEvent)));
        await page.locator('#race-choice').selectOption({ index: 1 });

        const athleteLabels = await page.locator('#athlete-choices label').allTextContents();
        assert.match(athleteLabels[0], new RegExp(escapeRegExp(area.runner)));
        assert.match(athleteLabels[1], new RegExp(escapeRegExp(area.spectator)));
        assert.ok(athleteLabels.every(label => !label.includes(
            area.siteMode === 'family' ? 'Everyone Synthetic' : 'Family Synthetic'
        )));

        const previewRequest = page.waitForRequest(request => {
            const url = new URL(request.url());
            return url.pathname.endsWith('/original');
        });
        await page.locator('.draft-card .button').click();
        await previewRequest;
        await page.locator('#protected-preview').waitFor({ state: 'visible' });

        await page.locator('#item-id').fill(`synthetic-${area.siteMode}-${viewport.name}`);
        await page.locator('#item-title').fill(`${area.label} synthetic test`);
        await page.locator('#item-alt').fill('A generated shape used only to test the private upload form.');
        await page.locator('#public-use-confirmed').check();
        await page.locator('input[name="contains-minors"][value="no"]').check();
        await page.locator('#create-draft').click();
        await page.locator('#app-status').filter({
            hasText: 'The private draft was saved.'
        }).waitFor();

        const dimensions = await page.evaluate(() => ({
            clientWidth: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth,
            viewportMeta: document.querySelector('meta[name="viewport"]')?.content || ''
        }));
        assert.equal(dimensions.viewportMeta, 'width=device-width,initial-scale=1');
        assert.ok(
            dimensions.scrollWidth <= dimensions.clientWidth,
            `${area.siteMode} ${viewport.name} admin page overflowed ` +
                `${dimensions.clientWidth}px to ${dimensions.scrollWidth}px.`
        );
        assert.deepEqual(browserErrors, []);

        const requests = observedApiRequests.slice(requestStart);
        assert.ok(requests.some(request => request.pathname.endsWith('/original')));
        const createRequest = requests.find(request => (
            request.method === 'POST' && request.pathname === '/api/browser/drafts'
        ));
        assert.ok(createRequest, `${area.siteMode} did not send a draft-create request.`);
        assert.ok(createRequest.body && typeof createRequest.body === 'object');
        assert.equal(Object.hasOwn(createRequest.body, 'siteModes'), false);
        assert.ok(
            requests.every(request => request.search === `?site=${area.siteMode}`),
            `${area.siteMode} emitted an API or preview request without its exact area context.`
        );

        const screenshotSuffix = area.siteMode === 'family'
            ? viewport.name
            : `${area.siteMode}-${viewport.name}`;
        await page.screenshot({
            path: path.join(
                screenshotsDirectory,
                `gallery-admin-phase-c-${screenshotSuffix}.png`
            ),
            fullPage: true
        });
    } finally {
        await context.close();
    }
}

async function assertPageBasics(page, area) {
    await assert.doesNotReject(() => page.locator('h1').getByText(
        'Private Gallery administration',
        { exact: true }
    ).waitFor());
    assert.match(
        await page.locator('.synthetic-warning').innerText(),
        /only the built-in synthetic test photo or video/i
    );
    assert.equal(await page.locator('#site-area-label').innerText(), area.label);
    assert.match(
        await page.locator('.fixed-area').innerText(),
        /area cannot be changed on this page/i
    );
    assert.equal(await page.locator('input[name="site-mode"]').count(), 0);
    assert.equal(await page.locator('select[name="site-mode"]').count(), 0);
    assert.equal(await page.locator('button[name="site-mode"]').count(), 0);
    assert.equal(await page.getByText('Where should it appear?', { exact: true }).count(), 0);
    assert.equal(await page.locator('input[type="file"]').count(), 0);
    assert.equal(await page.locator('script:not([src])').count(), 0);
    assert.equal(await page.locator('style').count(), 0);
}

async function checkInvalidContext(browserInstance, adminOrigin, query, label) {
    const context = await browserInstance.newContext();
    const page = await context.newPage();
    const requestStart = observedApiRequests.length;
    try {
        const response = await page.goto(`${adminOrigin}${query}`, { waitUntil: 'networkidle' });
        assert.equal(response?.status(), 200);
        await page.locator('#error-summary').waitFor({ state: 'visible' });
        assert.match(
            await page.locator('#error-summary').innerText(),
            /must be opened from a Gallery area using exactly \?site=family or \?site=everyone/i
        );
        assert.equal(await page.locator('#admin-workspace').isHidden(), true);
        assert.equal(
            observedApiRequests.length,
            requestStart,
            `The ${label} area context sent a protected API request instead of failing closed.`
        );
    } finally {
        await context.close();
    }
}

function createAdminServer(requestLog) {
    return http.createServer(async (request, response) => {
        try {
            const url = new URL(request.url, 'http://127.0.0.1');
            if (request.method === 'GET' && url.pathname === '/') {
                write(response, 200, 'text/html; charset=utf-8', adminShellDocument());
                return;
            }
            if (request.method === 'GET' && url.pathname === '/admin.css') {
                write(response, 200, 'text/css; charset=utf-8', adminStylesheet());
                return;
            }
            if (request.method === 'GET' && url.pathname === '/admin.js') {
                write(response, 200, 'text/javascript; charset=utf-8', adminClientScript());
                return;
            }
            if (request.method === 'GET' && url.pathname === '/favicon.ico') {
                response.writeHead(204, { 'Cache-Control': 'no-store' });
                response.end();
                return;
            }

            if (!url.pathname.startsWith('/api/browser/')) {
                writeJson(response, 404, { error: 'not-found' });
                return;
            }

            const siteMode = url.searchParams.get('site');
            const logEntry = {
                method: request.method,
                pathname: url.pathname,
                search: url.search,
                body: null
            };
            requestLog.push(logEntry);
            if (
                !['family', 'everyone'].includes(siteMode) ||
                url.search !== `?site=${siteMode}`
            ) {
                writeJson(response, 400, { error: 'invalid-site-context' });
                return;
            }

            if (request.method === 'GET' && url.pathname === '/api/browser/session') {
                writeJson(response, 200, { csrfToken: 'synthetic-browser-csrf-token' });
                return;
            }
            if (request.method === 'GET' && url.pathname === '/api/browser/catalog') {
                writeJson(response, 200, catalog);
                return;
            }
            if (request.method === 'GET' && url.pathname === '/api/browser/drafts') {
                writeJson(response, 200, { drafts: [draftFixture(siteMode)] });
                return;
            }
            if (request.method === 'POST' && url.pathname === '/api/browser/drafts') {
                logEntry.body = await readJsonBody(request);
                writeJson(response, 201, {
                    draft: {
                        ...draftFixture(siteMode),
                        draftId: `created-${siteMode}-draft`,
                        state: 'draft',
                        stateVersion: 1,
                        itemInput: logEntry.body.itemInput
                    }
                });
                return;
            }

            const originalMatch = url.pathname.match(
                /^\/api\/browser\/drafts\/([^/]+)\/original$/
            );
            if (request.method === 'GET' && originalMatch) {
                write(
                    response,
                    200,
                    'image/png',
                    Buffer.from(
                        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwC' +
                        'AAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
                        'base64'
                    )
                );
                return;
            }

            const draftMatch = url.pathname.match(/^\/api\/browser\/drafts\/([^/]+)$/);
            if (request.method === 'GET' && draftMatch) {
                writeJson(response, 200, { draft: draftFixture(siteMode) });
                return;
            }

            writeJson(response, 404, { error: 'not-found' });
        } catch (error) {
            writeJson(response, 500, { error: 'test-server-failure' });
        }
    });
}

function draftFixture(siteMode) {
    const area = areas.find(candidate => candidate.siteMode === siteMode);
    return {
        draftId: `existing-${siteMode}-draft`,
        state: 'private-review',
        stateVersion: 2,
        siteModes: [siteMode],
        originalSha256: 'a'.repeat(64),
        itemInput: {
            id: `existing-${siteMode}-moment`,
            type: 'photo',
            title: `${area.label} existing synthetic draft`,
            alt: 'A one-pixel generated test preview.',
            raceDate: area.raceDate,
            raceEvent: area.raceEvent,
            raceDistance: siteMode === 'family' ? '5 km' : '10 km',
            athleteIds: []
        }
    };
}

function readJsonBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.once('error', reject);
        request.once('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (error) {
                reject(error);
            }
        });
    });
}

function formatIsoDate(value) {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function writeJson(response, status, value) {
    write(response, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

function write(response, status, contentType, value) {
    response.writeHead(status, {
        'Cache-Control': 'no-store',
        'Content-Type': contentType,
        'X-Content-Type-Options': 'nosniff'
    });
    response.end(value);
}

function listen(serverInstance) {
    return new Promise((resolve, reject) => {
        serverInstance.once('error', reject);
        serverInstance.listen(0, '127.0.0.1', () => {
            const address = serverInstance.address();
            resolve(`http://127.0.0.1:${address.port}/`);
        });
    });
}

function close(serverInstance) {
    return new Promise((resolve, reject) => {
        serverInstance.close(error => error ? reject(error) : resolve());
    });
}
