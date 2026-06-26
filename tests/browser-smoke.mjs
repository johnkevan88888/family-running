import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticServer } from '../scripts/serve-site.mjs';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const siteRoot = process.env.SITE_ROOT
    ? path.resolve(process.env.SITE_ROOT)
    : repoRoot;
const artifactsDir = path.join(repoRoot, 'test-artifacts', 'screenshots');
const modes = ['family', 'everyone'];
const viewports = [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'mobile', width: 390, height: 844 }
];
const updateScreenshots = process.argv.includes('--update-screenshots');

const { chromium } = loadPlaywright();
await fs.mkdir(artifactsDir, { recursive: true });

const preview = await createStaticServer({ root: siteRoot, port: Number(process.env.PORT || 0), silent: true });
const failures = [];
let browser;

try {
    browser = await chromium.launch({
        headless: true,
        executablePath: findChromiumExecutable(),
        args: ['--disable-dev-shm-usage']
    });

    for (const mode of modes) {
        for (const viewport of viewports) {
            await runModeViewportTest(browser, mode, viewport);
        }
    }
} finally {
    if (browser) {
        await browser.close();
    }

    await preview.close();
}

if (failures.length) {
    console.error('Browser smoke tests failed:');
    for (const failure of failures) {
        console.error(`- ${failure}`);
    }
    process.exit(1);
}

console.log(`Browser smoke tests passed. Screenshots saved in ${path.relative(repoRoot, artifactsDir)}.`);

async function runModeViewportTest(browserInstance, mode, viewport) {
    const context = await browserInstance.newContext({ viewport });
    const page = await context.newPage();
    const sameOriginFailures = [];
    const consoleErrors = [];
    const pageErrors = [];

    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(10000);

    await context.route('**/*', route => {
        const url = route.request().url();

        if (isSameOrigin(url) || url === 'about:blank') {
            route.continue();
        } else {
            route.abort();
        }
    });

    page.on('console', message => {
        const locationUrl = message.location().url;

        if (message.type() === 'error' && (!locationUrl || isSameOrigin(locationUrl))) {
            consoleErrors.push(message.text());
        }
    });

    page.on('pageerror', error => {
        pageErrors.push(error.message);
    });

    page.on('requestfailed', request => {
        if (isSameOrigin(request.url())) {
            sameOriginFailures.push(`${request.url()} failed: ${request.failure()?.errorText || 'unknown error'}`);
        }
    });

    page.on('response', response => {
        if (isSameOrigin(response.url()) && response.status() >= 400) {
            sameOriginFailures.push(`${response.url()} returned HTTP ${response.status()}`);
        }
    });

    try {
        await page.goto(`${preview.baseUrl}/?site=${mode}`, { waitUntil: 'domcontentloaded' });
        await waitForRenderedChampionship(page, mode);
        await waitForNetworkToSettle(page);

        const siteName = await expectedSiteName(mode);
        await expectText(page, '#site-title', siteName, `${mode} site title`);
        await expectCountAtLeast(page, '#hall-of-fame .hof-card', 1, `${mode} Hall of Fame cards`);
        await expectCountAtLeast(page, '#leaderboards table tr', 2, `${mode} leaderboard rows`);
        await assertHallOfFameDisplayLabels(page, mode, viewport);

        const athleteLinkCount = await page.locator('a[href^="athlete.html?id="]').count();
        if ((await hasAthleteData()) && athleteLinkCount < 1) {
            failures.push(`${mode}/${viewport.name}: expected at least one athlete link.`);
        }

        await assertVacantStatesRender(page, mode, viewport);
        await assertCollapsibleSections(page, mode, viewport);
        await assertLeaderboardDisplayLabels(page, mode, viewport);
        await assertAthleteNavigation(page, mode, viewport);
        await assertAthleteOfficialMedals(page, mode, viewport);

        await page.setViewportSize(viewport);
        await page.goto(`${preview.baseUrl}/?site=${mode}`, { waitUntil: 'domcontentloaded' });
        await waitForRenderedChampionship(page, mode);
        await waitForNetworkToSettle(page);
        await page.screenshot({
            path: path.join(artifactsDir, `${mode}-${viewport.name}.png`),
            fullPage: true
        });

        if (updateScreenshots) {
            console.log(`Updated ${mode}-${viewport.name}.png`);
        }
    } catch (error) {
        failures.push(`${mode}/${viewport.name}: ${error.message}`);
    } finally {
        for (const error of consoleErrors) {
            failures.push(`${mode}/${viewport.name}: console error: ${error}`);
        }

        for (const error of pageErrors) {
            failures.push(`${mode}/${viewport.name}: JavaScript exception: ${error}`);
        }

        for (const error of sameOriginFailures) {
            failures.push(`${mode}/${viewport.name}: same-origin request failure: ${error}`);
        }

        await context.close();
    }
}

async function waitForRenderedChampionship(page, mode) {
    await page.waitForSelector('#site-title', { state: 'visible' });
    await page.waitForSelector('#hall-of-fame .hof-card', { state: 'visible' });
    await page.waitForSelector('#leaderboards table', { state: 'visible' });
    await page.waitForFunction(expectedMode => {
        const title = document.querySelector('#site-title')?.textContent?.trim() || '';
        const expected = expectedMode === 'everyone'
            ? 'Age-Graded Running Championships'
            : 'Family Running Championships';

        return title === expected;
    }, mode);
}

async function waitForNetworkToSettle(page) {
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
}

async function assertCollapsibleSections(page, mode, viewport) {
    const toggles = page.locator('.distance-toggle');
    const count = await toggles.count();
    let closedIndex = -1;

    for (let index = 0; index < count; index += 1) {
        const text = await toggles.nth(index).textContent();

        if (text?.includes('[+]')) {
            closedIndex = index;
            break;
        }
    }

    if (closedIndex < 0) {
        return;
    }

    const closedToggle = toggles.nth(closedIndex);
    const content = page.locator('.distance-content').nth(closedIndex);
    await closedToggle.click();
    await page.waitForFunction(
        element => element.style.display === 'block',
        await content.elementHandle()
    );
    await content.locator('table').first().waitFor({ state: 'visible' });
    await waitForNetworkToSettle(page);
    await closedToggle.click();
    await page.waitForFunction(
        element => element.style.display === 'none',
        await content.elementHandle()
    );
}

async function assertLeaderboardDisplayLabels(page, mode, viewport) {
    const labels = await page.$$eval('.distance-toggle', nodes =>
        nodes.map(node => node.textContent.trim().replace(/\s+/g, ' '))
    );

    if (!labels.some(label => label.includes('10 Mile'))) {
        failures.push(`${mode}/${viewport.name}: expected a visible 10 Mile leaderboard section.`);
    }

    if (labels.some(label => label.includes('10mile'))) {
        failures.push(`${mode}/${viewport.name}: 10 Mile leaderboard section is displayed as "10mile".`);
    }
}

async function assertHallOfFameDisplayLabels(page, mode, viewport) {
    const awards = await page.$$eval('#hall-of-fame .hof-award', nodes =>
        nodes.map(node => node.textContent.trim().replace(/\s+/g, ' '))
    );

    if (!awards.some(award => award.includes('10 Mile'))) {
        failures.push(`${mode}/${viewport.name}: expected visible 10 Mile Hall of Fame cards.`);
    }

    if (awards.some(award => award.includes('10mile'))) {
        failures.push(`${mode}/${viewport.name}: Hall of Fame card is displayed as "10mile".`);
    }
}

async function assertAthleteNavigation(page, mode, viewport) {
    const link = page.locator('a[href^="athlete.html?id="]').first();

    if (await link.count() === 0) {
        return;
    }

    const href = await link.getAttribute('href');
    if (!href || !href.includes(`site=${mode}`)) {
        failures.push(`${mode}/${viewport.name}: athlete link does not preserve site parameter.`);
        return;
    }

    await page.goto(new URL(href, page.url()).href, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#athlete-name');
    await page.waitForFunction(() => {
        const name = document.querySelector('#athlete-name')?.textContent?.trim() || '';
        return name && name !== 'Loading...';
    });
    await waitForNetworkToSettle(page);

    const backHref = await page.locator('.back-link').getAttribute('href');
    if (backHref !== `index.html?site=${mode}`) {
        failures.push(`${mode}/${viewport.name}: back link was "${backHref}", expected index.html?site=${mode}.`);
    }

    await page.goto(new URL(backHref, page.url()).href, { waitUntil: 'domcontentloaded' });

    if (new URL(page.url()).searchParams.get('site') !== mode) {
        failures.push(`${mode}/${viewport.name}: back navigation did not preserve site parameter.`);
    }

    await waitForRenderedChampionship(page, mode);
}

async function assertAthleteOfficialMedals(page, mode, viewport) {
    const medalScenario = await findMedalledAthleteScenario(mode);

    if (!medalScenario) {
        return;
    }

    const requestUrls = [];
    const captureRequest = request => {
        if (isSameOrigin(request.url())) {
            requestUrls.push(request.url());
        }
    };

    page.on('request', captureRequest);

    try {
        await page.goto(`${preview.baseUrl}/athlete.html?id=${encodeURIComponent(medalScenario.athleteId)}&site=${mode}`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#athlete-name');
        await page.waitForFunction(() => {
            const name = document.querySelector('#athlete-name')?.textContent?.trim() || '';
            return name && name !== 'Loading...' && name !== 'Athlete not found';
        });
        await page.locator('#official-medals-section:not(.hidden) .official-medal').first().waitFor({ state: 'visible' });
        await waitForNetworkToSettle(page);
    } finally {
        page.off('request', captureRequest);
    }

    const requestedPaths = requestUrls
        .map(sameOriginRequestPath)
        .filter(Boolean);
    const officialMedalsPath = `data/${mode}/official_medals.csv`;

    if (!requestedPaths.includes(officialMedalsPath)) {
        failures.push(`${mode}/${viewport.name}: athlete medal profile did not request ${officialMedalsPath}.`);
    }

    const leaderboardPaths = await athleteMedalForbiddenLeaderboardPaths(mode);
    const requestedLeaderboardPaths = leaderboardPaths.filter(file => requestedPaths.includes(file));

    if (requestedLeaderboardPaths.length) {
        failures.push(`${mode}/${viewport.name}: athlete medal profile requested leaderboard data: ${requestedLeaderboardPaths.join(', ')}.`);
    }

    await assertDisplayedOfficialMedals(page, mode, viewport, medalScenario.medals);
}

async function assertDisplayedOfficialMedals(page, mode, viewport, expectedMedals) {
    const cards = page.locator('#official-medals .official-medal');
    const cardCount = await cards.count();

    if (cardCount !== expectedMedals.length) {
        failures.push(`${mode}/${viewport.name}: rendered ${cardCount} official medal cards, expected ${expectedMedals.length}.`);
    }

    const comparableCount = Math.min(cardCount, expectedMedals.length);

    for (let index = 0; index < comparableCount; index += 1) {
        const medal = expectedMedals[index];
        const text = normalizeText(await cards.nth(index).textContent());
        const expectedValues = [
            medal.AwardTitle,
            medal.Period,
            medal.Distance,
            medal.Time ? `Time: ${medal.Time}` : '',
            medal.AgeGrade ? `Age grade: ${medal.AgeGrade}` : '',
            medal.EventName,
            medal.EventDate,
            medal.Place ? `#${medal.Place}` : ''
        ].filter(Boolean);

        for (const expectedValue of expectedValues) {
            if (!text.includes(normalizeText(expectedValue))) {
                failures.push(`${mode}/${viewport.name}: official medal card ${index + 1} did not include exported value "${expectedValue}".`);
            }
        }
    }
}

async function assertVacantStatesRender(page, mode, viewport) {
    const hallRows = await readCsvObjects(`data/${mode}/halloffame.csv`);
    const hasVacant = hallRows.some(row => String(row.Participant || '').toLowerCase().includes('vacant'));

    if (!hasVacant) {
        return;
    }

    const vacantCards = await page.locator('.hof-card.vacant').count();
    if (vacantCards < 1) {
        failures.push(`${mode}/${viewport.name}: Hall of Fame has vacant data but no vacant card rendered.`);
    }
}

async function expectText(page, selector, expected, label) {
    const actual = await page.locator(selector).first().textContent();

    if (actual?.trim() !== expected) {
        throw new Error(`${label} was "${actual?.trim()}", expected "${expected}".`);
    }
}

async function expectCountAtLeast(page, selector, minimum, label) {
    const count = await page.locator(selector).count();

    if (count < minimum) {
        throw new Error(`${label} count was ${count}, expected at least ${minimum}.`);
    }
}

async function expectedSiteName(mode) {
    const rows = await readCsvObjects(`data/${mode}/siteinfo.csv`);
    const row = rows.find(candidate => candidate.Label === 'SiteName');
    return row?.Value || (mode === 'everyone' ? 'Age-Graded Running Championships' : 'Family Running Championships');
}

async function hasAthleteData() {
    const rows = await readCsvObjects('data/athlete_results.csv');
    return rows.some(row => row.AthleteID);
}

async function findMedalledAthleteScenario(mode) {
    const medalRows = await readCsvObjects(`data/${mode}/official_medals.csv`);
    const athleteRows = await readCsvObjects('data/athlete_results.csv');
    const athleteIds = new Set(athleteRows.map(row => row.AthleteID).filter(Boolean));
    const medalsByAthlete = new Map();

    for (const medal of sortRowsByExportedOrder(medalRows).filter(row => athleteIds.has(row.AthleteId))) {
        if (!medalsByAthlete.has(medal.AthleteId)) {
            medalsByAthlete.set(medal.AthleteId, []);
        }

        medalsByAthlete.get(medal.AthleteId).push(medal);
    }

    const [athleteId, medals] = medalsByAthlete.entries().next().value || [];

    return athleteId
        ? { athleteId, medals }
        : null;
}

async function athleteMedalForbiddenLeaderboardPaths(mode) {
    const webtables = await readCsvObjects(`data/${mode}/webtables.csv`);
    const paths = new Set([`data/${mode}/webtables.csv`]);

    for (const row of webtables) {
        if (row.FileName) {
            paths.add(`data/${mode}/${row.FileName}`);
        }
    }

    return [...paths];
}

async function readCsvObjects(relativePath) {
    const text = await fs.readFile(path.join(repoRoot, relativePath), 'utf8');
    const rows = parseCsv(text);
    const headers = rows[0] || [];

    return rows.slice(1)
        .filter(row => row.some(value => value !== ''))
        .map(row => Object.fromEntries(headers.map((header, index) => [header, row[index] || ''])));
}

function sortRowsByExportedOrder(rows) {
    return rows
        .map((row, index) => ({
            ...row,
            __csvIndex: index
        }))
        .sort(compareExportedRowOrder);
}

function compareExportedRowOrder(a, b) {
    const sortA = exportedSortValue(a);
    const sortB = exportedSortValue(b);

    if (sortA !== null && sortB !== null && sortA !== sortB) {
        return sortA - sortB;
    }

    return a.__csvIndex - b.__csvIndex;
}

function exportedSortValue(row) {
    for (const field of ['SortOrder', 'DisplayOrder', 'Order']) {
        if (!Object.prototype.hasOwnProperty.call(row, field)) {
            continue;
        }

        const value = Number(row[field]);

        if (Number.isFinite(value)) {
            return value;
        }
    }

    return null;
}

function sameOriginRequestPath(url) {
    try {
        return decodeURIComponent(new URL(url).pathname)
            .replace(/^\/+/, '')
            .replace(/\\/g, '/');
    } catch {
        return '';
    }
}

function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseCsv(text) {
    const rows = [];
    let row = [];
    let value = '';
    let insideQuotes = false;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1];

        if (char === '"') {
            if (insideQuotes && next === '"') {
                value += '"';
                index += 1;
            } else {
                insideQuotes = !insideQuotes;
            }
            continue;
        }

        if (char === ',' && !insideQuotes) {
            row.push(value.trim());
            value = '';
            continue;
        }

        if ((char === '\n' || char === '\r') && !insideQuotes) {
            row.push(value.trim());
            rows.push(row);
            row = [];
            value = '';

            if (char === '\r' && next === '\n') {
                index += 1;
            }
            continue;
        }

        value += char;
    }

    if (value.length || row.length) {
        row.push(value.trim());
        rows.push(row);
    }

    return rows;
}

function loadPlaywright() {
    const explicitPackagePath = process.env.PLAYWRIGHT_PACKAGE_PATH;

    if (explicitPackagePath) {
        return require(explicitPackagePath);
    }

    try {
        return require('playwright');
    } catch (error) {
        console.error('Playwright is not installed. Run `pnpm install` first, or set PLAYWRIGHT_PACKAGE_PATH for a local bundled Playwright package.');
        throw error;
    }
}

function findChromiumExecutable() {
    const explicitPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.CHROME_BIN;

    if (explicitPath) {
        return explicitPath;
    }

    const candidates = process.platform === 'win32'
        ? [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
        ]
        : process.platform === 'darwin'
            ? [
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
            ]
            : [
                '/usr/bin/google-chrome',
                '/usr/bin/google-chrome-stable',
                '/usr/bin/chromium',
                '/usr/bin/chromium-browser',
                '/usr/bin/microsoft-edge'
            ];

    return candidates.find(candidate => fileExists(candidate));
}

function fileExists(candidate) {
    try {
        return Boolean(candidate && require('node:fs').existsSync(candidate));
    } catch {
        return false;
    }
}

function isSameOrigin(url) {
    try {
        return new URL(url).origin === new URL(preview.baseUrl).origin;
    } catch {
        return false;
    }
}
