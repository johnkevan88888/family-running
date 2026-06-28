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

    await runCrownHistoryEdgeCaseTests(browser);
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
    const requestedPaths = [];

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

    page.on('request', request => {
        if (isSameOrigin(request.url())) {
            requestedPaths.push(sameOriginRequestPath(request.url()));
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
        await assertCrownHistory(page, mode, viewport, requestedPaths);

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
    await page.waitForSelector('#crown-history[data-rendered="true"]');
    await page.waitForFunction(expectedMode => {
        const title = document.querySelector('#site-title')?.textContent?.trim() || '';
        const expected = expectedMode === 'everyone'
            ? 'Age-Graded Running Championships'
            : 'Family Running Championships';

        return title === expected;
    }, mode);
}

async function assertCrownHistory(page, mode, viewport, requestedPaths) {
    const file = `data/${mode}/crown_history.csv`;
    const otherMode = mode === 'family' ? 'everyone' : 'family';
    const otherFile = `data/${otherMode}/crown_history.csv`;
    const rows = await readCsvObjects(file);
    const crownOrder = ['Overall', 'Marathon', 'Half Marathon', '10 Mile', '10 km', '5 km'];
    const expectedGroups = crownOrder.filter(distance => rows.some(row => row.Distance === distance));
    const context = `${mode}/${viewport.name}`;

    if (!requestedPaths.includes(file)) {
        failures.push(`${context}: timeline did not request ${file}.`);
    }

    if (requestedPaths.includes(otherFile)) {
        failures.push(`${context}: timeline requested the other site mode's ${otherFile}.`);
    }

    const intro = normalizeText(await page.locator('.crown-history-intro').textContent());
    for (const requiredText of ['All-Time Official', 'Current/12-Month', 'unofficial', 'all-results']) {
        if (!intro.includes(requiredText)) {
            failures.push(`${context}: crown history scope explanation omitted "${requiredText}".`);
        }
    }

    if (!rows.length) {
        await expectText(
            page,
            '#crown-history .crown-history-empty',
            'No All-Time Official crown progression has been exported.',
            `${context} crown history empty state`
        );
        return;
    }

    const actualGroups = await page.$$eval('.crown-history-distance', nodes =>
        nodes.map(node => node.textContent.trim())
    );
    if (JSON.stringify(actualGroups) !== JSON.stringify(expectedGroups)) {
        failures.push(`${context}: crown groups were ${actualGroups.join(', ')}, expected ${expectedGroups.join(', ')}.`);
    }

    const entries = page.locator('.crown-history-item');
    const entryCount = await entries.count();
    if (entryCount !== rows.length) {
        failures.push(`${context}: rendered ${entryCount} crown transitions, expected ${rows.length}.`);
    }

    const comparableCount = Math.min(entryCount, rows.length);
    for (let index = 0; index < comparableCount; index += 1) {
        const row = rows[index];
        const entry = entries.nth(index);
        const text = normalizeText(await entry.textContent());
        const requiredValues = [
            row.EffectiveDate,
            row.AthleteName,
            row.Time,
            row.AgeGrade,
            row.Event,
            row.PreviousAthleteName,
            row.PreviousTime,
            row.PreviousAgeGrade,
            row.ChangeReason
        ].filter(Boolean);

        for (const value of requiredValues) {
            if (!text.includes(normalizeText(value))) {
                failures.push(`${context}: transition ${index + 1} omitted exported value "${value}".`);
            }
        }

        await assertTimelineAthleteLink(
            entry.locator('.crown-history-holder'),
            row.AthleteID,
            mode,
            `${context} transition ${index + 1} holder`
        );

        const hasPreviousValues = [
            row.PreviousAthleteID,
            row.PreviousAthleteName,
            row.PreviousTime,
            row.PreviousAgeGrade
        ].some(Boolean);
        const previous = entry.locator('.crown-history-previous');

        if (hasPreviousValues) {
            if (await previous.count() !== 1) {
                failures.push(`${context}: transition ${index + 1} omitted previous-holder details.`);
            } else {
                await assertTimelineAthleteLink(
                    previous,
                    row.PreviousAthleteID,
                    mode,
                    `${context} transition ${index + 1} previous holder`
                );
            }
        } else if (await previous.count() !== 0) {
            failures.push(`${context}: transition ${index + 1} rendered unavailable previous-holder details.`);
        }

        const eventCount = await entry.locator('.crown-history-event').count();
        if (Boolean(row.Event) !== Boolean(eventCount)) {
            failures.push(`${context}: transition ${index + 1} did not preserve Event availability.`);
        }
    }

    const toggles = page.locator('.crown-history-toggle');
    const defaultDistance = expectedGroups.includes('Overall') ? 'Overall' : expectedGroups[0];
    const firstToggleText = normalizeText(await toggles.first().textContent());
    const firstExpanded = await toggles.first().getAttribute('aria-expanded');

    if (!firstToggleText.includes(defaultDistance) || firstExpanded !== 'true') {
        failures.push(`${context}: expected ${defaultDistance} to be the default expanded crown group.`);
    }

    if (await toggles.count() > 1) {
        const closedToggle = toggles.nth(1);
        const contentId = await closedToggle.getAttribute('aria-controls');
        const content = page.locator(`#${contentId}`);

        if (await closedToggle.getAttribute('aria-expanded') !== 'false' || !await content.isHidden()) {
            failures.push(`${context}: non-default crown group was not initially collapsed.`);
        }

        await closedToggle.click();
        if (await closedToggle.getAttribute('aria-expanded') !== 'true' || !await content.isVisible()) {
            failures.push(`${context}: crown group did not expand.`);
        }

        await closedToggle.click();
        if (await closedToggle.getAttribute('aria-expanded') !== 'false' || !await content.isHidden()) {
            failures.push(`${context}: crown group did not collapse.`);
        }
    }

    const overflow = await page.evaluate(() => {
        const clientWidth = document.documentElement.clientWidth;
        const scrollWidth = document.documentElement.scrollWidth;
        const contributors = [...document.querySelectorAll('body *')]
            .map(element => {
                const bounds = element.getBoundingClientRect();
                return {
                    element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${element.classList.length ? `.${[...element.classList].join('.')}` : ''}`,
                    right: Math.round(bounds.right),
                    width: Math.round(bounds.width)
                };
            })
            .filter(item => item.right > clientWidth + 1)
            .sort((a, b) => b.right - a.right)
            .slice(0, 4);

        return { clientWidth, scrollWidth, contributors };
    });
    if (overflow.scrollWidth > overflow.clientWidth + 1) {
        failures.push(
            `${context}: page has horizontal overflow (${overflow.scrollWidth}px > ${overflow.clientWidth}px); ` +
            `contributors: ${overflow.contributors.map(item => `${item.element} right=${item.right} width=${item.width}`).join(', ')}.`
        );
    }
}

async function assertTimelineAthleteLink(locator, athleteId, mode, label) {
    const links = locator.locator('a[href^="athlete.html?id="]');
    const linkCount = await links.count();

    if (!athleteId) {
        if (linkCount > 0) {
            failures.push(`${label}: rendered a profile link without an exported athlete ID.`);
        }
        return;
    }

    if (linkCount !== 1) {
        failures.push(`${label}: expected one profile link for exported athlete ID "${athleteId}".`);
        return;
    }

    const href = await links.first().getAttribute('href');
    const params = new URL(href, preview.baseUrl).searchParams;

    if (params.get('id') !== athleteId || params.get('site') !== mode) {
        failures.push(`${label}: profile link "${href}" did not preserve athlete ID and site mode.`);
    }
}

async function runCrownHistoryEdgeCaseTests(browserInstance) {
    const header = 'Distance,CrownScope,EffectiveDate,AthleteID,AthleteName,Time,AgeGrade,Event,PreviousAthleteID,PreviousAthleteName,PreviousTime,PreviousAgeGrade,ChangeReason';

    await withSyntheticCrownHistory(browserInstance, `${header}\r\n`, async page => {
        await expectText(
            page,
            '#crown-history .crown-history-empty',
            'No All-Time Official crown progression has been exported.',
            'header-only crown history empty state'
        );
        if (await page.locator('.crown-history-group').count() !== 0) {
            failures.push('crown-history edge case: header-only export rendered a timeline group.');
        }
    });

    const syntheticRows = [
        header,
        'Overall,All-Time Official,01/01/2020,,Legacy Runner,00:20:00,70.0%,"Legacy ""Road"", Series",,,,,Initial qualifying holder',
        'Overall,All-Time Official,02/01/2021,current-runner,Current Runner,00:19:00,72.0%,,,Legacy Runner,,69.0%,Transferred from Legacy Runner; previous-holder data incomplete'
    ].join('\r\n');

    await withSyntheticCrownHistory(browserInstance, syntheticRows, async page => {
        const entries = page.locator('.crown-history-item');
        if (await entries.count() !== 2) {
            failures.push('crown-history edge case: partial legacy export did not render two transitions.');
            return;
        }

        if (await entries.nth(0).locator('.crown-history-holder a').count() !== 0) {
            failures.push('crown-history edge case: missing new-holder ID rendered a profile link.');
        }

        const firstEvent = normalizeText(await entries.nth(0).locator('.crown-history-event').textContent());
        if (!firstEvent.includes('Legacy "Road", Series')) {
            failures.push('crown-history edge case: quoted Event text was not preserved.');
        }

        const previous = entries.nth(1).locator('.crown-history-previous');
        if (await previous.locator('a').count() !== 0) {
            failures.push('crown-history edge case: missing previous-holder ID rendered a profile link.');
        }

        const previousText = normalizeText(await previous.textContent());
        if (!previousText.includes('Legacy Runner') || !previousText.includes('69.0%') || previousText.includes('Time:')) {
            failures.push('crown-history edge case: partial previous-holder fields were not rendered selectively.');
        }

        if (await entries.nth(1).locator('.crown-history-event').count() !== 0) {
            failures.push('crown-history edge case: unavailable Event rendered an empty field.');
        }
    });
}

async function withSyntheticCrownHistory(browserInstance, csvText, assertion) {
    const context = await browserInstance.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();

    await page.route('**/data/family/crown_history.csv', route =>
        route.fulfill({
            status: 200,
            contentType: 'text/csv',
            body: csvText
        })
    );

    try {
        await page.goto(`${preview.baseUrl}/?site=family`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#crown-history[data-rendered="true"]');
        await assertion(page);
    } catch (error) {
        failures.push(`crown-history edge case: ${error.message}`);
    } finally {
        await context.close();
    }
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
