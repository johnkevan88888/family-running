import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticServer } from '../scripts/serve-site.mjs';
import { findChromiumExecutable, loadPlaywright } from '../scripts/browser-runtime.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const siteRoot = process.env.SITE_ROOT
    ? path.resolve(process.env.SITE_ROOT)
    : repoRoot;
const artifactsDir = path.join(repoRoot, 'test-artifacts', 'screenshots');
const modes = ['family', 'everyone'];
// `isMobile` makes Chromium honour the page's meta viewport tag. Without it a
// 390px context lays out at 390px regardless, so mobile assertions and
// screenshots would not reflect a real phone. A page missing the tag lays out at
// the ~980px fallback width instead, which `assertResponsiveViewport` checks for
// directly -- it does not overflow, so the overflow check alone would miss it.
const viewports = [
    {
        name: 'desktop',
        contextOptions: { viewport: { width: 1440, height: 900 } }
    },
    {
        name: 'mobile',
        contextOptions: {
            viewport: { width: 390, height: 844 },
            deviceScaleFactor: 3,
            isMobile: true,
            hasTouch: true
        }
    }
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
    await runAbsoluteRecordsEdgeCaseTests(browser);
    await runHostileExportedValueTests(browser);
    await runCsvParsingContractTests(browser);
    await runRecentResultsWindowTests(browser);
    await runBrandMetadataTests(browser);
    await runMobileLeaderboardCardTests(browser);
    await runDocumentTitleTests(browser);
    await runCalculatorComparisonUnavailableEdgeCaseTests(browser);
    await runCalculatorComparisonEdgeCaseTests(browser);
    await runAgeGradeCalculatorContractEdgeCaseTests(browser);
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
    const context = await browserInstance.newContext(viewport.contextOptions);
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
        await page.goto(`${preview.baseUrl}/index.html?site=${mode}`, { waitUntil: 'domcontentloaded' });
        await waitForRenderedChampionship(page, mode);
        await waitForNetworkToSettle(page);

        const siteName = await expectedSiteName(mode);
        await expectText(page, '#site-title', siteName, `${mode} site title`);
        await assertPrimaryNavigation(page, mode, viewport, 'championships');
        await assertNoModeSwitch(page, mode, viewport, 'championships');
        await expectCountAtLeast(page, '#leaderboards table tr', 2, `${mode} landing championship leaderboard rows`);
        await assertSitePaceToggle(page, mode, viewport);
        await assertNavigationBetweenPublicPages(page, mode, viewport);
        await assertResponsiveViewport(page, viewport, `${mode}/${viewport.name} landing championships page`);
        await assertBundleMetadataHidden(page, `${mode}/${viewport.name} landing championships page`);

        await page.goto(`${preview.baseUrl}/championships.html?site=${mode}`, { waitUntil: 'domcontentloaded' });
        await waitForRenderedChampionship(page, mode);
        await waitForNetworkToSettle(page);
        await assertPrimaryNavigation(page, mode, viewport, 'championships');
        await assertNoModeSwitch(page, mode, viewport, 'championships');
        await expectCountAtLeast(page, '#leaderboards table tr', 2, `${mode} championship leaderboard rows`);
        await assertResponsiveViewport(page, viewport, `${mode}/${viewport.name} championships page`);
        await assertBundleMetadataHidden(page, `${mode}/${viewport.name} championships page`);

        await assertLeaderboardDisplayLabels(page, mode, viewport);
        await assertCollapsibleSections(page, mode, viewport);
        await assertAthleteNavigation(page, mode, viewport);
        await assertAthleteOfficialMedals(page, mode, viewport);
        await assertAgeGradeStandards(page, mode, viewport);

        await page.goto(`${preview.baseUrl}/hall-of-fame.html?site=${mode}`, { waitUntil: 'domcontentloaded' });
        await waitForRenderedHallOfFame(page, mode);
        await waitForNetworkToSettle(page);
        await assertPrimaryNavigation(page, mode, viewport, 'hall-of-fame');
        await assertNoModeSwitch(page, mode, viewport, 'hall-of-fame');
        await expectCountAtLeast(page, '#hall-of-fame .hof-card', 1, `${mode} Hall of Fame cards`);
        await assertHallOfFameDisplayLabels(page, mode, viewport);
        await assertCrownHistory(page, mode, viewport, requestedPaths);
        await assertVisiblePaceUnit(page.locator('#hall-of-fame'), 'km', `${mode}/${viewport.name} Hall of Fame paces`);
        await assertVacantStatesRender(page, mode, viewport);
        await assertResponsiveViewport(page, viewport, `${mode}/${viewport.name} Hall of Fame page`);
        await assertBundleMetadataHidden(page, `${mode}/${viewport.name} Hall of Fame page`);

        const recordsRequestStart = requestedPaths.length;
        await page.goto(`${preview.baseUrl}/records.html?site=${mode}`, { waitUntil: 'domcontentloaded' });
        await waitForRenderedRecords(page, mode);
        await waitForNetworkToSettle(page);
        await assertPrimaryNavigation(page, mode, viewport, 'records');
        await assertNoModeSwitch(page, mode, viewport, 'records');
        await assertAbsoluteRecordsPage(page, mode, viewport, requestedPaths.slice(recordsRequestStart));
        await assertResponsiveViewport(page, viewport, `${mode}/${viewport.name} records page`);
        await assertBundleMetadataHidden(page, `${mode}/${viewport.name} records page`);

        const headToHeadRequestStart = requestedPaths.length;
        await page.goto(`${preview.baseUrl}/calculator.html?site=${mode}`, { waitUntil: 'domcontentloaded' });
        await waitForRenderedCalculator(page, mode);
        await waitForNetworkToSettle(page);
        await assertPrimaryNavigation(page, mode, viewport, 'head-to-head');
        await assertNoModeSwitch(page, mode, viewport, 'head-to-head');
        await assertCalculatorPage(page, mode, viewport, requestedPaths.slice(headToHeadRequestStart));
        await assertResponsiveViewport(page, viewport, `${mode}/${viewport.name} head-to-head page`);
        await assertBundleMetadataHidden(page, `${mode}/${viewport.name} head-to-head page`);

        const ageGradeCalculatorRequestStart = requestedPaths.length;
        await page.goto(`${preview.baseUrl}/age-grade-calculator.html?site=${mode}`, { waitUntil: 'domcontentloaded' });
        await waitForRenderedAgeGradeCalculator(page, mode);
        await waitForNetworkToSettle(page);
        await assertPrimaryNavigation(page, mode, viewport, 'calculator');
        await assertNoModeSwitch(page, mode, viewport, 'calculator');
        await assertAgeGradeCalculatorPage(
            page,
            mode,
            viewport,
            requestedPaths.slice(ageGradeCalculatorRequestStart)
        );
        await assertResponsiveViewport(page, viewport, `${mode}/${viewport.name} age-grade calculator page`);
        await assertBundleMetadataHidden(page, `${mode}/${viewport.name} age-grade calculator page`);

        const overviewRequestStart = requestedPaths.length;
        await page.goto(`${preview.baseUrl}/overview.html?site=${mode}`, { waitUntil: 'domcontentloaded' });
        await waitForRenderedOverview(page, mode);
        await waitForNetworkToSettle(page);
        await assertPrimaryNavigation(page, mode, viewport, 'overview');
        await assertNoModeSwitch(page, mode, viewport, 'overview');
        await assertOverviewPage(page, mode, viewport, requestedPaths.slice(overviewRequestStart));
        await assertVisiblePaceUnit(page.locator('#overview-dashboard'), 'km', `${mode}/${viewport.name} Overview paces`);
        await assertResponsiveViewport(page, viewport, `${mode}/${viewport.name} overview page`);
        await assertBundleMetadataHidden(page, `${mode}/${viewport.name} overview page`);

        const athleteLinkCount = await page.locator('a[href^="athlete.html?id="]').count();
        if ((await hasAthleteData()) && athleteLinkCount < 1) {
            failures.push(`${mode}/${viewport.name}: expected at least one athlete link.`);
        }

        await assertDirectAthleteProfile(page, mode, viewport);

        await page.setViewportSize(viewport.contextOptions.viewport);
        await capturePageScreenshot(page, mode, viewport, 'championships', waitForRenderedChampionship);
        await capturePageScreenshot(page, mode, viewport, 'hall-of-fame', waitForRenderedHallOfFame);
        await capturePageScreenshot(page, mode, viewport, 'records', waitForRenderedRecords);
        await capturePageScreenshot(page, mode, viewport, 'head-to-head', waitForRenderedCalculator);
        await capturePageScreenshot(page, mode, viewport, 'calculator', waitForRenderedAgeGradeCalculator);
        await capturePageScreenshot(page, mode, viewport, 'overview', waitForRenderedOverview);

        if (updateScreenshots) {
            console.log(`Updated ${mode} ${viewport.name} screenshots`);
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
    await page.waitForSelector('#leaderboards table', { state: 'visible' });
    await page.waitForFunction(expectedMode => {
        const title = document.querySelector('#site-title')?.textContent?.trim() || '';
        const expected = expectedMode === 'everyone'
            ? 'Age-Graded Running Championships'
            : 'Family Running Championships';

        return title === expected;
    }, mode);
}

async function waitForRenderedOverview(page, mode) {
    await page.waitForSelector('#site-title', { state: 'visible' });
    await page.waitForSelector('#overview-dashboard .overview-stat-card', { state: 'visible' });
    await page.waitForSelector('#overview-recent-results .overview-result-card', { state: 'visible' });
    await page.waitForFunction(expectedMode => {
        const title = document.querySelector('#site-title')?.textContent?.trim() || '';
        const expected = expectedMode === 'everyone'
            ? 'Age-Graded Running Championships'
            : 'Family Running Championships';

        return title === expected;
    }, mode);
}

async function waitForRenderedHallOfFame(page, mode) {
    await page.waitForSelector('#site-title', { state: 'visible' });
    await page.waitForSelector('#hall-of-fame .hof-card', { state: 'visible' });
    await page.waitForSelector('#crown-history[data-rendered="true"]');
    await page.waitForFunction(expectedMode => {
        const title = document.querySelector('#site-title')?.textContent?.trim() || '';
        const expected = expectedMode === 'everyone'
            ? 'Age-Graded Running Championships'
            : 'Family Running Championships';

        return title === expected;
    }, mode);
}

async function waitForRenderedRecords(page, mode) {
    await page.waitForSelector('#site-title', { state: 'visible' });
    await page.waitForSelector('#absolute-records[data-rendered="true"]');
    await page.waitForFunction(expectedMode => {
        const title = document.querySelector('#site-title')?.textContent?.trim() || '';
        const expected = expectedMode === 'everyone'
            ? 'Age-Graded Running Championships'
            : 'Family Running Championships';

        return title === expected;
    }, mode);
}

async function waitForRenderedCalculator(page, mode) {
    await page.waitForSelector('#site-title', { state: 'visible' });
    await page.waitForSelector('#comparison-results[data-rendered="true"]');
    await page.waitForFunction(expectedMode => {
        const title = document.querySelector('#site-title')?.textContent?.trim() || '';
        const expected = expectedMode === 'everyone'
            ? 'Age-Graded Running Championships'
            : 'Family Running Championships';

        return title === expected;
    }, mode);
}

async function assertCalculatorPage(page, mode, viewport, requestedPaths) {
    const context = `${mode}/${viewport.name}`;
    const selectedFile = `data/${mode}/age_grade_standards.csv`;
    const comparisonFile = `data/${mode}/athlete_comparison_targets.csv`;
    const currentChampionshipFile = `data/${mode}/overall-current-official-${mode}.csv`;
    const otherMode = mode === 'family' ? 'everyone' : 'family';
    const otherFile = `data/${otherMode}/age_grade_standards.csv`;
    const otherComparisonFile = `data/${otherMode}/athlete_comparison_targets.csv`;
    const standards = await readCsvObjects(selectedFile);
    const manifest = await readCsvObjects('data/export_manifest.csv');
    const comparisonAvailable = manifest.some(row => row.RelativePath === comparisonFile);
    const comparisonTargets = comparisonAvailable ? await readCsvObjects(comparisonFile) : [];
    const currentChampionshipRows = await readCsvObjects(currentChampionshipFile);

    if (!requestedPaths.includes(selectedFile)) {
        failures.push(`${context}: Calculator did not request ${selectedFile}.`);
    }
    if (!requestedPaths.includes('data/athlete_results.csv')) {
        failures.push(`${context}: Calculator did not request shared athlete names.`);
    }
    if (!requestedPaths.includes('data/export_manifest.csv')) {
        failures.push(`${context}: Calculator did not request the export manifest.`);
    }
    if (!requestedPaths.includes(currentChampionshipFile)) {
        failures.push(`${context}: Calculator did not request the current overall championship for its default rivalry.`);
    }
    if (requestedPaths.includes(otherFile)) {
        failures.push(`${context}: Calculator requested the other site mode's ${otherFile}.`);
    }
    if (comparisonAvailable && !requestedPaths.includes(comparisonFile)) {
        failures.push(`${context}: Calculator did not request the comparison file listed in the current manifest.`);
    }
    if (!comparisonAvailable && requestedPaths.includes(comparisonFile)) {
        failures.push(`${context}: Calculator requested a comparison file absent from the current manifest.`);
    }
    if (requestedPaths.includes(otherComparisonFile)) {
        failures.push(`${context}: Calculator requested the other site mode's comparison file.`);
    }

    const intro = normalizeText(await page.locator('.calculator-hero').textContent());
    const calculatorText = normalizeText(await page.locator('.calculator-page').textContent());
    for (const requiredText of ['Head to Head', 'latest championship export']) {
        if (!intro.includes(requiredText)) {
            failures.push(`${context}: Calculator intro omitted "${requiredText}".`);
        }
    }

    const targetAthlete = page.locator('#target-athlete');
    const targetGrade = page.locator('#target-grade');
    const exportedAthleteIds = [...new Set(standards.map(row => row.AthleteId).filter(Boolean))];

    if (await targetAthlete.count() !== 0 || await targetGrade.count() !== 0) {
        failures.push(`${context}: Calculator retained the removed race-target controls.`);
    }
    if (calculatorText.includes('Build a race target')) {
        failures.push(`${context}: Calculator retained the removed race-target section.`);
    }
    for (const selector of ['#comparison-athlete-a', '#comparison-athlete-b']) {
        if (await page.locator(`${selector} option`).count() !== exportedAthleteIds.length) {
            failures.push(`${context}: Comparison athlete options did not match the selected site's export.`);
        }
    }

    const comparisonA = await page.locator('#comparison-athlete-a').inputValue();
    const comparisonB = await page.locator('#comparison-athlete-b').inputValue();
    const summary = normalizeText(await page.locator('#comparison-summary').textContent());
    const comparisonText = normalizeText(await page.locator('#comparison-results').textContent());

    if (comparisonA === comparisonB) {
        failures.push(`${context}: Challenger and The Standard defaulted to the same athlete.`);
    }
    const expectedRivalry = closestTopFiveRivalry(currentChampionshipRows, new Set(exportedAthleteIds));
    if (expectedRivalry && (
        comparisonA !== expectedRivalry.challengerId ||
        comparisonB !== expectedRivalry.standardId
    )) {
        failures.push(`${context}: Calculator did not default to the closest top-five current championship rivalry.`);
    }
    if (await page.locator('#comparison-grade').count() !== 0) {
        failures.push(`${context}: Comparison retained the removed shared age-grade selector.`);
    }
    if (!summary.includes('challenges') || !summary.includes('official results first and unofficial results below')) {
        failures.push(`${context}: Comparison did not explain the challenger/standard relationship.`);
    }
    if (comparisonAvailable) {
        if (comparisonText.includes('Head-to-head targets are not available in this championship update yet.')) {
            failures.push(`${context}: Comparison rendered unavailable despite a manifest-listed export.`);
        }
        await assertCalculatorComparisonCards(page, comparisonTargets, context);
        const expectedPeriods = comparisonPeriods(comparisonTargets);
        if (await page.locator('input[name="comparison-period"]').count() !== expectedPeriods.length) {
            failures.push(`${context}: Standards-period options did not match the exported comparison periods.`);
        }
    } else if (!comparisonText.includes('Head-to-head targets are not available in this championship update yet.')) {
        failures.push(`${context}: Comparison did not render the current-export unavailable state.`);
    }

    const perMile = page.locator('.site-pace-control').getByRole('button', { name: 'Show pace per mile' });
    const perKm = page.locator('.site-pace-control').getByRole('button', { name: 'Show pace per kilometre' });
    await perMile.click();
    await assertVisiblePaceUnit(page.locator('.calculator-page'), 'mi', `${context} calculator paces`);
    await perKm.click();
}

async function assertAgeGradeCalculatorPage(page, mode, viewport, requestedPaths) {
    const context = `${mode}/${viewport.name} age-grade calculator`;
    const selectedFile = `data/${mode}/age_grade_calculator.csv`;
    const otherMode = mode === 'family' ? 'everyone' : 'family';
    const otherFile = `data/${otherMode}/age_grade_calculator.csv`;
    const rows = await readCsvObjects(selectedFile);
    const athleteIds = [...new Set(rows.map(row => row.AthleteId).filter(Boolean))];
    const distances = [...new Set(rows.map(row => row.Distance).filter(Boolean))];

    if (!requestedPaths.includes(selectedFile)) {
        failures.push(`${context}: did not request ${selectedFile}.`);
    }
    if (requestedPaths.includes(otherFile)) {
        failures.push(`${context}: requested the other site mode's calculator export.`);
    }

    const intro = normalizeText(await page.locator('.calculator-hero').textContent());
    for (const requiredText of ['Calculate your age grade', 'latest workbook export']) {
        if (!intro.includes(requiredText)) {
            failures.push(`${context}: intro omitted "${requiredText}".`);
        }
    }

    if (await page.locator('#age-grade-athlete option').count() !== athleteIds.length) {
        failures.push(`${context}: athlete dropdown did not match the selected site's workbook export.`);
    }
    if (await page.locator('#age-grade-distance option').count() !== distances.length) {
        failures.push(`${context}: distance dropdown did not match the workbook export.`);
    }

    const example = rows.find(row => row.Distance === '5 km') || rows[0];
    if (!example) {
        failures.push(`${context}: calculator export had no example row.`);
        return;
    }

    await page.locator('#age-grade-athlete').selectOption(example.AthleteId);
    await page.locator('#age-grade-distance').selectOption(example.Distance);
    await page.locator('#age-grade-time').fill('2430');
    await page.locator('#age-grade-time').blur();

    const normalizedTime = await page.locator('#age-grade-time').inputValue();
    if (normalizedTime !== '24:30') {
        failures.push(`${context}: compact time 2430 normalized to "${normalizedTime}" instead of "24:30".`);
    }

    const expectedPercentage = `${((Number(example.AgeGradedStandardSeconds) / 1470) * 100).toFixed(2)}%`;
    await expectText(page, '#age-grade-percentage', expectedPercentage, `${context} workbook result`);

    const longRaceExample = rows.find(row => row.Distance === 'Marathon' && row.AthleteId === example.AthleteId)
        || rows.find(row => row.Distance === 'Marathon');
    await page.locator('#age-grade-athlete').selectOption(longRaceExample.AthleteId);
    await page.locator('#age-grade-distance').selectOption(longRaceExample.Distance);
    await page.locator('#age-grade-time').fill('14530.5');
    await page.locator('#age-grade-time').blur();
    if (await page.locator('#age-grade-time').inputValue() !== '1:45:30.5') {
        failures.push(`${context}: compact time 14530.5 did not preserve its optional tenth.`);
    }
    const expectedLongPercentage = `${((Number(longRaceExample.AgeGradedStandardSeconds) / 6330.5) * 100).toFixed(2)}%`;
    await expectText(page, '#age-grade-percentage', expectedLongPercentage, `${context} fractional workbook result`);

    await page.locator('#age-grade-time').fill('14530');
    await page.locator('#age-grade-time').blur();
    if (await page.locator('#age-grade-time').inputValue() !== '1:45:30') {
        failures.push(`${context}: compact time 14530 did not work without the optional tenth.`);
    }

    await page.locator('#age-grade-time').fill('24:99');
    await page.locator('#age-grade-time').blur();
    if (await page.locator('#age-grade-time').getAttribute('aria-invalid') !== 'true') {
        failures.push(`${context}: invalid seconds were not marked invalid.`);
    }
    if (!normalizeText(await page.locator('#age-grade-time-error').textContent())) {
        failures.push(`${context}: invalid time did not render guidance.`);
    }

    const contractStatus = normalizeText(await page.locator('#age-grade-contract-status').textContent());
    if (!contractStatus.includes('Checked against the workbook calculation contract')) {
        failures.push(`${context}: workbook contract confirmation was not shown.`);
    }
}

async function assertCalculatorComparisonCards(page, targets, context) {
    const challengerId = await page.locator('#comparison-athlete-a').inputValue();
    const standardId = await page.locator('#comparison-athlete-b').inputValue();
    const selectedPeriod = await page.locator('input[name="comparison-period"]:checked').inputValue();
    const expectedRows = targets
        .filter(row =>
            row.ChallengerAthleteId === challengerId &&
            row.StandardAthleteId === standardId &&
            comparisonPeriod(row) === selectedPeriod
        )
        .sort((a, b) => {
            const classRank = value => String(value || '').trim().toLowerCase() === 'official' ? 0 : 1;
            return classRank(a.StandardTimeClass) - classRank(b.StandardTimeClass)
                || Number(a.SortOrder) - Number(b.SortOrder);
        });
    const expectedGroups = mergeExpectedComparisonBenchmarks(expectedRows);
    const expectedDistanceCount = new Set(expectedRows.map(row =>
        `${String(row.StandardTimeClass || '').trim().toLowerCase()}|${row.Distance}`
    )).size;
    const cards = page.locator('.comparison-distance-card');
    const benchmarks = page.locator('.comparison-benchmark');
    const sections = page.locator('.comparison-class-section');

    if (!expectedRows.length) {
        failures.push(`${context}: Default challenger/standard pair has no exported comparison rows.`);
        return;
    }
    if (await cards.count() !== expectedDistanceCount) {
        failures.push(`${context}: Comparison distance-card count did not match the selected export rows.`);
    }
    if (await sections.count() !== 2
        || await sections.nth(0).getAttribute('data-time-class') !== 'official'
        || await sections.nth(1).getAttribute('data-time-class') !== 'unofficial') {
        failures.push(`${context}: Comparison did not render official results before unofficial results.`);
    }
    if (await benchmarks.count() !== expectedGroups.length) {
        failures.push(`${context}: Comparison benchmark count did not match the selected export rows.`);
        return;
    }
    if (await page.locator('.comparison-benchmark-type').count() !== expectedRows.length) {
        failures.push(`${context}: Combined comparison rows did not retain every exported benchmark badge.`);
    }

    for (let index = 0; index < expectedGroups.length; index += 1) {
        const group = expectedGroups[index];
        const row = group[0];
        const text = normalizeText(await benchmarks.nth(index).textContent());

        for (const expected of [
            ...group.map(groupRow => groupRow.BenchmarkType),
            row.StandardTime,
            `${row.StandardAgeGrade} age grade`,
            formatWebsiteDate(row.StandardDate),
            row.StandardEvent,
            row.StandardTimeClass,
            row.RequiredTimeToBeat,
            `${row.RequiredPacePerKm} /km`
        ]) {
            if (!text.includes(expected)) {
                failures.push(`${context}: Comparison benchmark ${index + 1} omitted exported value "${expected}".`);
            }
        }
    }
}

function mergeExpectedComparisonBenchmarks(rows) {
    const groups = [];
    const byPerformance = new Map();

    for (const row of rows) {
        const key = JSON.stringify([
            row.StandardTimeClass,
            row.Distance,
            row.StandardTime,
            row.StandardAgeGrade,
            row.StandardDate,
            row.StandardEvent,
            row.RequiredTimeToBeat,
            row.RequiredPacePerKm,
            row.RequiredPacePerMile
        ]);
        if (!byPerformance.has(key)) {
            const group = [];
            byPerformance.set(key, group);
            groups.push(group);
        }
        byPerformance.get(key).push(row);
    }

    return groups;
}

function comparisonPeriod(row) {
    return String(row.Period || '').trim().toLowerCase() === 'current'
        ? 'Current'
        : 'All Time';
}

function comparisonPeriods(rows) {
    const available = new Set(rows.map(comparisonPeriod));
    return ['Current', 'All Time'].filter(period => available.has(period));
}

function closestTopFiveRivalry(rows, availableAthletes) {
    const contenders = rows
        .map(row => ({
            athleteId: row['Athlete ID'],
            rank: Number(row.Rank),
            ageGrade: Number(String(row['Age Graded Score'] || '').replace('%', ''))
        }))
        .filter(contender =>
            availableAthletes.has(contender.athleteId) &&
            Number.isFinite(contender.rank) &&
            contender.rank >= 1 &&
            contender.rank <= 5 &&
            Number.isFinite(contender.ageGrade)
        )
        .sort((a, b) => a.rank - b.rank);
    let closest = null;

    for (let higherIndex = 0; higherIndex < contenders.length; higherIndex += 1) {
        for (let lowerIndex = higherIndex + 1; lowerIndex < contenders.length; lowerIndex += 1) {
            const higher = contenders[higherIndex];
            const lower = contenders[lowerIndex];
            const gap = Math.abs(higher.ageGrade - lower.ageGrade);
            if (!closest || gap < closest.gap || (gap === closest.gap && higher.rank < closest.standardRank)) {
                closest = {
                    challengerId: lower.athleteId,
                    standardId: higher.athleteId,
                    standardRank: higher.rank,
                    gap
                };
            }
        }
    }

    return closest;
}

async function assertOverviewPage(page, mode, viewport, requestedPaths) {
    const context = `${mode}/${viewport.name}`;
    await expectCountAtLeast(page, '#overview-dashboard .overview-stat-card', 4, `${context} overview statistic cards`);
    await expectCountAtLeast(page, '#overview-dashboard .overview-list li', 1, `${context} overview most-active rows`);
    await expectCountAtLeast(page, '#overview-recent-results .overview-result-card', 1, `${context} overview recent results`);

    if (await page.locator('#leaderboards').count() !== 0 || await page.locator('.distance-toggle').count() !== 0) {
        failures.push(`${context}: Overview rendered the full championship catalogue.`);
    }

    if (await page.locator('#hall-of-fame').count() !== 0 || await page.locator('#crown-history').count() !== 0) {
        failures.push(`${context}: Overview rendered Hall of Fame or crown-history sections.`);
    }

    if (await page.locator('.overview-actions').count() !== 0) {
        failures.push(`${context}: Overview rendered the removed championship exploration section.`);
    }

    const bodyText = normalizeText(await page.locator('body').textContent());
    if (bodyText.includes('Explore the championships')) {
        failures.push(`${context}: Overview rendered the removed "Explore the championships" copy.`);
    }

    await assertOverviewRecentResults(page, mode, viewport);
    await assertOverviewActivity(page, mode, viewport);

    const modeRequests = requestedPaths.filter(requestPath =>
        requestPath.startsWith(`data/${mode}/`)
    );
    const forbiddenRequests = modeRequests.filter(requestPath =>
        requestPath.endsWith('/halloffame.csv') ||
        requestPath.endsWith('/crown_history.csv')
    );

    if (forbiddenRequests.length) {
        failures.push(`${context}: Overview requested historical data: ${forbiddenRequests.join(', ')}.`);
    }
}

async function assertOverviewRecentResults(page, mode, viewport) {
    const context = `${mode}/${viewport.name}`;
    const expectedRows = await expectedOverviewRecentRows(mode);
    const cards = page.locator('#overview-recent-results .overview-result-card');
    const cardCount = await cards.count();

    if (cardCount !== expectedRows.length) {
        failures.push(`${context}: rendered ${cardCount} recent result cards, expected ${expectedRows.length}.`);
    }

    const comparableCount = Math.min(cardCount, expectedRows.length);
    for (let index = 0; index < comparableCount; index += 1) {
        const expectedRow = expectedRows[index];
        const text = normalizeText(await cards.nth(index).textContent());
        const expectedValues = [
            expectedRow.Participant,
            formatWebsiteDate(expectedRow.Date),
            expectedRow.Distance,
            expectedRow.Time,
            expectedRow.AgeGrade,
            expectedRow.TimeClass,
            expectedRow.Event
        ].filter(Boolean);

        for (const value of expectedValues) {
            if (!text.includes(normalizeText(value))) {
                failures.push(`${context}: recent result ${index + 1} omitted exported value "${value}".`);
            }
        }
    }

    const renderedText = normalizeText(await page.locator('#overview-recent-results').textContent());
    if (renderedText.includes('Unofficial')) {
        failures.push(`${context}: Overview recent results included an unofficial result.`);
    }

    if (mode === 'family' && (renderedText.includes('Grace Chambers') || renderedText.includes('Jim Chambers'))) {
        failures.push(`${context}: Family Overview recent results included non-family athletes Grace or Jim.`);
    }
}

async function assertOverviewActivity(page, mode, viewport) {
    const context = `${mode}/${viewport.name}`;
    const expectedRows = await expectedOverviewActivityRows(mode);
    const items = page.locator('#overview-dashboard .overview-list li');
    const itemCount = await items.count();

    if (itemCount !== expectedRows.length) {
        failures.push(`${context}: rendered ${itemCount} 12-month activity rows, expected ${expectedRows.length}.`);
    }

    const comparableCount = Math.min(itemCount, expectedRows.length);
    for (let index = 0; index < comparableCount; index += 1) {
        const expectedRow = expectedRows[index];
        const text = normalizeText(await items.nth(index).textContent());
        const expectedText = `${expectedRow.name} ${expectedRow.count} ${expectedRow.count === 1 ? 'run' : 'runs'}`;

        if (!text.includes(expectedText)) {
            failures.push(`${context}: 12-month activity row ${index + 1} was "${text}", expected "${expectedText}".`);
        }
    }

    await expectText(
        page,
        '#most-active-title',
        'Most official runs recorded in the last 12 months',
        `${context} activity window heading`
    );
    await expectText(
        page,
        '#recent-results-title',
        'Most recent official results from the last six months',
        `${context} recent-results window heading`
    );
}

async function assertPrimaryNavigation(page, mode, viewport, activePage) {
    const context = `${mode}/${viewport.name} ${activePage}`;
    const championshipsLabel = activePage === 'athlete'
        ? 'Back to Championships'
        : 'Championships';
    const expected = new Map([
        [championshipsLabel, 'index.html'],
        ['Hall of Fame', 'hall-of-fame.html'],
        ['Records', 'records.html'],
        ['Head to Head', 'calculator.html'],
        ['Calculator', 'age-grade-calculator.html'],
        ['Overview', 'overview.html']
    ]);

    for (const [label, filename] of expected) {
        const link = page.locator('.site-nav').getByRole('link', { name: label, exact: true });
        const count = await link.count();
        if (count !== 1) {
            failures.push(`${context}: expected one ${label} navigation link, found ${count}.`);
            continue;
        }

        const href = await link.getAttribute('href');
        const url = new URL(href, preview.baseUrl);
        if (!url.pathname.endsWith(`/${filename}`) || url.searchParams.get('site') !== mode) {
            failures.push(`${context}: ${label} link "${href}" did not preserve site mode.`);
        }

        const expectedActive = filename === pageFileForKey(activePage);
        const ariaCurrent = await link.getAttribute('aria-current');
        if (expectedActive && ariaCurrent !== 'page') {
            failures.push(`${context}: ${label} link was not marked active.`);
        }
        if (!expectedActive && ariaCurrent === 'page') {
            failures.push(`${context}: ${label} link was incorrectly marked active.`);
        }
    }

    await assertWebsiteDateFormat(page, context);
}

async function assertWebsiteDateFormat(page, context) {
    const bodyText = normalizeText(await page.locator('body').textContent());
    const rawExportedDates = bodyText.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/g) || [];

    if (rawExportedDates.length) {
        failures.push(`${context}: displayed unformatted date(s): ${[...new Set(rawExportedDates)].join(', ')}.`);
    }

    const updatedText = normalizeText(await page.locator('#last-updated').textContent());
    const fullDatePattern = /\b\d{1,2} (?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4}\b/;
    if (!fullDatePattern.test(updatedText)) {
        failures.push(`${context}: header update timestamp was not in day Month year format: "${updatedText}".`);
    }
}

async function assertNoModeSwitch(page, mode, viewport, pageKey) {
    const context = `${mode}/${viewport.name} ${pageKey}`;
    const switchLinks = await page.locator('.site-mode-link').count();
    const badgeCount = await page.locator('.site-mode-badge').count();

    if (switchLinks !== 0) {
        failures.push(`${context}: rendered ${switchLinks} Family/Everyone switch link(s).`);
    }

    if (badgeCount !== 0) {
        failures.push(`${context}: rendered ${badgeCount} redundant current-site badge(s).`);
    }

    const expectedLabel = mode === 'everyone' ? 'Everyone' : 'Family';
    const subtitleLabel = normalizeText(await page.locator('#site-mode-label').textContent());
    if (!subtitleLabel.includes(expectedLabel)) {
        failures.push(`${context}: site subtitle was "${subtitleLabel}", expected ${expectedLabel}.`);
    }
}

async function waitForRenderedAgeGradeCalculator(page, mode) {
    await page.waitForSelector('#site-title', { state: 'visible' });
    await page.waitForFunction(() => {
        const input = document.querySelector('#age-grade-time');
        const status = document.querySelector('#age-grade-contract-status')?.textContent || '';
        return input && !input.disabled && status.includes('Checked against');
    });
    await page.waitForFunction(expectedMode => {
        const title = document.querySelector('#site-title')?.textContent?.trim() || '';
        const expected = expectedMode === 'everyone'
            ? 'Age-Graded Running Championships'
            : 'Family Running Championships';

        return title === expected;
    }, mode);
}

async function assertSitePaceToggle(page, mode, viewport) {
    const context = `${mode}/${viewport.name} site pace toggle`;
    const control = page.locator('.site-pace-control');
    const perKm = control.getByRole('button', { name: 'Show pace per kilometre' });
    const perMile = control.getByRole('button', { name: 'Show pace per mile' });

    await assertVisiblePaceUnit(page.locator('#leaderboards'), 'km', context);

    await perMile.click();
    if (await perMile.getAttribute('aria-pressed') !== 'true') {
        failures.push(`${context}: /mi was not selected after using the site-wide control.`);
    }
    await assertVisiblePaceUnit(page.locator('#leaderboards'), 'mi', context);

    await perKm.click();
    if (await perKm.getAttribute('aria-pressed') !== 'true') {
        failures.push(`${context}: /km was not restored after using the site-wide control.`);
    }
    await assertVisiblePaceUnit(page.locator('#leaderboards'), 'km', context);
}

async function assertVisiblePaceUnit(root, unit, context) {
    const otherUnit = unit === 'km' ? 'mi' : 'km';
    const visiblePaces = await root.locator('.pace-display').evaluateAll(elements =>
        elements
            .filter(element => !element.hidden && element.offsetParent !== null)
            .map(element => element.textContent.trim())
    );

    if (!visiblePaces.some(text => text.endsWith(`/${unit}`))) {
        failures.push(`${context}: no visible /${unit} pace values were rendered.`);
    }

    if (visiblePaces.some(text => text.endsWith(`/${otherUnit}`))) {
        failures.push(`${context}: /${otherUnit} pace values remained visible while /${unit} was selected.`);
    }
}

async function assertNavigationBetweenPublicPages(page, mode, viewport) {
    const context = `${mode}/${viewport.name}`;
    const targets = [
        { label: 'Hall of Fame', pageKey: 'hall-of-fame', waitFor: waitForRenderedHallOfFame },
        { label: 'Records', pageKey: 'records', waitFor: waitForRenderedRecords },
        { label: 'Head to Head', pageKey: 'head-to-head', waitFor: waitForRenderedCalculator },
        { label: 'Calculator', pageKey: 'calculator', waitFor: waitForRenderedAgeGradeCalculator },
        { label: 'Overview', pageKey: 'overview', waitFor: waitForRenderedOverview },
        { label: 'Championships', pageKey: 'championships', waitFor: waitForRenderedChampionship }
    ];

    for (const target of targets) {
        const link = page.locator('.site-nav').getByRole('link', { name: target.label, exact: true });
        await Promise.all([
            page.waitForURL(url =>
                url.pathname.endsWith(`/${pageFileForKey(target.pageKey)}`) &&
                url.searchParams.get('site') === mode
            ),
            link.click()
        ]);
        await target.waitFor(page, mode);
        await waitForNetworkToSettle(page);
        await assertPrimaryNavigation(page, mode, viewport, target.pageKey);
    }

    if (new URL(page.url()).searchParams.get('site') !== mode) {
        failures.push(`${context}: page navigation did not preserve site mode.`);
    }
}

async function capturePageScreenshot(page, mode, viewport, pageKey, waitForPage) {
    await page.goto(`${preview.baseUrl}/${pageFileForKey(pageKey)}?site=${mode}`, { waitUntil: 'domcontentloaded' });
    await waitForPage(page, mode);
    await waitForNetworkToSettle(page);
    await page.screenshot({
        path: path.join(artifactsDir, `${mode}-${pageKey}-${viewport.name}.png`),
        fullPage: true
    });
}

function pageFileForKey(pageKey) {
    if (pageKey === 'hall-of-fame') return 'hall-of-fame.html';
    if (pageKey === 'overview') return 'overview.html';
    if (pageKey === 'records') return 'records.html';
    if (pageKey === 'head-to-head') return 'calculator.html';
    if (pageKey === 'calculator') return 'age-grade-calculator.html';
    if (pageKey === 'athlete') return 'athlete.html';

    return 'index.html';
}

async function assertAbsoluteRecordsPage(page, mode, viewport, requestedPaths) {
    const context = `${mode}/${viewport.name}`;
    const file = `data/${mode}/absolute_records.csv`;
    const otherMode = mode === 'family' ? 'everyone' : 'family';
    const otherFile = `data/${otherMode}/absolute_records.csv`;

    if (!requestedPaths.includes('data/export_manifest.csv')) {
        failures.push(`${context}: records page did not request the export manifest.`);
    }

    if (requestedPaths.includes(otherFile)) {
        failures.push(`${context}: records page requested the other site mode's ${otherFile}.`);
    }

    const intro = normalizeText(await page.locator('.page-intro').textContent());
    for (const requiredText of ['Absolute fastest-time records', 'without age grading']) {
        if (!intro.includes(requiredText)) {
            failures.push(`${context}: records page intro omitted "${requiredText}".`);
        }
    }

    if (!await publicCsvExists(file)) {
        if (requestedPaths.includes(file)) {
            failures.push(`${context}: records page requested ${file} before it exists in the tracked manifest.`);
        }
        await expectText(
            page,
            '#absolute-records .absolute-records-empty',
            'No absolute records have been exported yet.',
            `${context} records empty state`
        );
        return;
    }

    const rows = await readCsvObjects(file);
    if (!requestedPaths.includes(file)) {
        failures.push(`${context}: records page did not request ${file}.`);
    }

    const cards = page.locator('#absolute-records .absolute-record-card');
    const cardCount = await cards.count();
    if (cardCount !== rows.length) {
        failures.push(`${context}: rendered ${cardCount} absolute record cards, expected ${rows.length}.`);
    }

    const groupLabels = await page.$$eval('.absolute-records-group h3', nodes =>
        nodes.map(node => node.textContent.trim())
    );
    const expectedGroups = expectedAbsoluteRecordGroups(rows);
    if (groupLabels.join('|') !== expectedGroups.join('|')) {
        failures.push(
            `${context}: records page groups were ${groupLabels.join(', ')}, expected ${expectedGroups.join(', ')} in exported order.`
        );
    }

    const displayRows = sortAbsoluteRecordRowsForDisplay(rows);
    const comparableCount = Math.min(cardCount, rows.length);
    for (let index = 0; index < comparableCount; index += 1) {
        await assertRenderedAbsoluteRecord(cards.nth(index), displayRows[index], mode, `${context} record ${index + 1}`);
    }
}

// Display order is exported order, nothing more. This used to reimplement the
// page's Women-before-Men group override, which meant the test protected the
// very behaviour that reversed the workbook's export. Audit finding P2-01.
function sortAbsoluteRecordRowsForDisplay(rows) {
    return [...rows].sort((a, b) => Number(a.SortOrder || 999) - Number(b.SortOrder || 999));
}

// Derived from the export rather than restated, so this cannot become a second
// hardcoded copy of the workbook-owned matrix.
function expectedAbsoluteRecordGroups(rows) {
    const groups = [];

    for (const row of sortAbsoluteRecordRowsForDisplay(rows)) {
        const group = String(row.RecordGroup || '').trim();

        if (group && !groups.includes(group)) {
            groups.push(group);
        }
    }

    return groups;
}

async function assertRenderedAbsoluteRecord(card, row, mode, context) {
    const text = normalizeText(await card.textContent());
    const expectedValues = [
        row.RecordTitle,
        row.Distance,
        row.Participant,
        row.Time,
        formatWebsiteDate(row.Date),
        row.Event,
        row.TimeClass,
        row.AgeClass,
        row.AgeGrade
    ].filter(Boolean);

    for (const value of expectedValues) {
        if (!text.includes(normalizeText(value))) {
            failures.push(`${context}: omitted exported value "${value}".`);
        }
    }

    const isEmpty = String(row.Participant || '').toLowerCase().includes('no eligible') ||
        String(row.Participant || '').toLowerCase().includes('vacant');
    const links = card.locator('a[href^="athlete.html?id="]');
    const linkCount = await links.count();

    if (row['Athlete ID'] && !isEmpty) {
        if (linkCount !== 1) {
            failures.push(`${context}: expected one athlete link for ${row['Athlete ID']}.`);
        } else {
            const href = await links.first().getAttribute('href');
            const params = new URL(href, preview.baseUrl).searchParams;

            if (params.get('id') !== row['Athlete ID'] || params.get('site') !== mode) {
                failures.push(`${context}: athlete link "${href}" did not preserve athlete ID and site mode.`);
            }
        }
    } else if (linkCount !== 0) {
        failures.push(`${context}: rendered an athlete link without an exported athlete ID.`);
    }
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
            formatWebsiteDate(row.EffectiveDate),
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

    // A quoted field is allowed to contain a newline, and the file is allowed to
    // mix CRLF and LF. Both used to split a single exported row into several
    // malformed ones before the page ever saw it.
    const multilineRows =
        `${header}\r\n` +
        'Overall,All-Time Official,01/01/2020,legacy-runner,Legacy Runner,00:20:00,70.0%,"Legacy ""Road"", Series",,,,,' +
        '"Initial qualifying holder\nrecorded across two lines"\n' +
        'Overall,All-Time Official,02/01/2021,current-runner,Current Runner,00:19:00,72.0%,Winter Series,,Legacy Runner,,69.0%,Transferred from Legacy Runner\r\n';

    await withSyntheticCrownHistory(browserInstance, multilineRows, async page => {
        const entries = page.locator('.crown-history-item');

        if (await entries.count() !== 2) {
            failures.push(
                `crown-history edge case: quoted multiline export rendered ${await entries.count()} transitions, expected 2.`
            );
            return;
        }

        const reason = normalizeText(await entries.nth(0).locator('.crown-history-reason').textContent());
        if (reason !== 'Initial qualifying holder recorded across two lines') {
            failures.push(`crown-history edge case: quoted multiline field rendered as "${reason}".`);
        }

        const event = normalizeText(await entries.nth(0).locator('.crown-history-event').textContent());
        if (!event.includes('Legacy "Road", Series')) {
            failures.push('crown-history edge case: quoted comma and escaped quotes were not preserved.');
        }

        const secondReason = normalizeText(await entries.nth(1).locator('.crown-history-reason').textContent());
        if (secondReason !== 'Transferred from Legacy Runner') {
            failures.push(`crown-history edge case: the row after an LF break rendered as "${secondReason}".`);
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
        await page.goto(`${preview.baseUrl}/hall-of-fame.html?site=family`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#crown-history[data-rendered="true"]');
        await assertion(page);
    } catch (error) {
        failures.push(`crown-history edge case: ${error.message}`);
    } finally {
        await context.close();
    }
}

async function runAbsoluteRecordsEdgeCaseTests(browserInstance) {
    const manifest = [
        'ExportBundleID,ExportedAtUTC,SchemaVersion,Scope,RelativePath,DataRowCount',
        '20990101T010203004Z-A1B2C3D4,2099-01-01T01:02:03.004Z,1.0,family,data/family/absolute_records.csv,3'
    ].join('\r\n');
    const records = [
        'SortOrder,RecordGroup,RecordTitle,Sex,Distance,ResultDistance,Participant,Athlete ID,Time,Date,Event,TimeClass,AgeClass,AgeGrade,SourceRow,ExportBundleID',
        '10,Men,Men\'s 5 km record,Men,5 km,5 km,Fast Runner,fast-runner,00:18:00,01/01/2024,New Year 5k,Official,M30,70.0%,12,20990101T010203004Z-A1B2C3D4',
        '20,Men,Men\'s 10 km record,Men,10 km,10 km,No eligible result,,,,,Official,,,,20990101T010203004Z-A1B2C3D4',
        '110,Women,Women\'s Half Marathon record,Women,Half Marathon,H. Mar,Swift Runner,,01:40:00,02/02/2024,Winter Half,Official,F25,65.0%,13,20990101T010203004Z-A1B2C3D4'
    ].join('\r\n');

    await withSyntheticAbsoluteRecords(browserInstance, manifest, records, async page => {
        const cards = page.locator('#absolute-records .absolute-record-card');
        if (await cards.count() !== 3) {
            failures.push('absolute-records edge case: expected three rendered record cards.');
            return;
        }

        const groups = await page.$$eval('.absolute-records-group h3', nodes =>
            nodes.map(node => node.textContent.trim())
        );
        // The fixture exports SortOrder 10 and 20 for Men and 110 for Women, so
        // exported order is Men then Women. Card indexes below follow from that.
        if (groups.join('|') !== 'Men|Women') {
            failures.push(`absolute-records edge case: groups were ${groups.join(', ')}, expected Men, Women.`);
        }

        await assertRenderedAbsoluteRecord(
            cards.nth(0),
            {
                RecordTitle: "Men's 5 km record",
                Distance: '5 km',
                Participant: 'Fast Runner',
                'Athlete ID': 'fast-runner',
                Time: '00:18:00',
                Date: '01/01/2024',
                Event: 'New Year 5k',
                TimeClass: 'Official',
                AgeClass: 'M30',
                AgeGrade: '70.0%'
            },
            'family',
            'absolute-records edge case linked record'
        );

        const emptyText = normalizeText(await cards.nth(1).textContent());
        if (!emptyText.includes('No eligible result') || !emptyText.includes("Men's 10 km record")) {
            failures.push('absolute-records edge case: empty exported record did not render its vacant state.');
        }
        if (await cards.nth(1).locator('a').count() !== 0) {
            failures.push('absolute-records edge case: empty exported record rendered an athlete link.');
        }
        if (await cards.nth(2).locator('a').count() !== 0) {
            failures.push('absolute-records edge case: missing athlete ID rendered an athlete link.');
        }

        await assertVisiblePaceUnit(page.locator('#absolute-records'), 'km', 'absolute-records edge case paces');
    });
}

async function withSyntheticAbsoluteRecords(browserInstance, manifestText, recordsText, assertion) {
    const context = await browserInstance.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const requestedPaths = [];

    await page.route('**/data/export_manifest.csv', route =>
        route.fulfill({
            status: 200,
            contentType: 'text/csv',
            body: `${manifestText}\r\n`
        })
    );
    await page.route('**/data/family/absolute_records.csv', route =>
        route.fulfill({
            status: 200,
            contentType: 'text/csv',
            body: `${recordsText}\r\n`
        })
    );
    await page.route('**/data/everyone/absolute_records.csv', route =>
        route.abort()
    );
    page.on('request', request => {
        if (isSameOrigin(request.url())) {
            requestedPaths.push(sameOriginRequestPath(request.url()));
        }
    });

    try {
        await page.goto(`${preview.baseUrl}/records.html?site=family`, { waitUntil: 'domcontentloaded' });
        await waitForRenderedRecords(page, 'family');
        await waitForNetworkToSettle(page);

        if (!requestedPaths.includes('data/family/absolute_records.csv')) {
            failures.push('absolute-records edge case: did not request the selected site records CSV.');
        }
        if (requestedPaths.includes('data/everyone/absolute_records.csv')) {
            failures.push('absolute-records edge case: requested the other site records CSV.');
        }

        await assertion(page);
    } catch (error) {
        failures.push(`absolute-records edge case: ${error.message}`);
    } finally {
        await context.close();
    }
}

// Every value on a championship page comes from an exported CSV, so an exported
// value that reaches the page as markup is the whole attack surface. This drives
// hostile text through the leaderboard headings, table headers, and both the
// linked and unlinked participant paths, and proves it is rendered as text and
// never executed.
async function runHostileExportedValueTests(browserInstance) {
    const bundleId = '20990101T010203004Z-A1B2C3D4';
    const scriptProbe = 'window.__exportedValueScriptRan = true';
    const hostileDistance = `<img src=x onerror="${scriptProbe}">10 km`;
    const hostileTitle = `</h4><img src=x onerror="${scriptProbe}">Hostile Champions`;
    const hostileHeader = `<img src=x onerror="${scriptProbe}">Notes`;
    const hostileParticipant = `<script>${scriptProbe}</script>Linked Runner`;
    const hostileUnlinkedParticipant = `<svg onload="${scriptProbe}"></svg>Unlinked Runner`;
    const webtables = [
        'SortOrder,TimeClass,DisplayDistance,DisplayTitle,DisplayDescription,FileName,Enabled,ExportBundleID',
        [
            '110',
            'Official',
            quoteCsvField(hostileDistance),
            quoteCsvField(hostileTitle),
            'Hostile description',
            'hostile-current-official-family.csv',
            'TRUE',
            bundleId
        ].join(',')
    ].join('\r\n');
    const leaderboard = [
        [
            'Rank',
            'Participant',
            'Race Year',
            'Time Class',
            'SexAgeEvent',
            'Time',
            'Age Graded Score',
            'Age Graded Category',
            'Athlete ID',
            quoteCsvField(hostileHeader),
            'ExportBundleID'
        ].join(','),
        [
            '1',
            quoteCsvField(hostileParticipant),
            '2026',
            'Official',
            'M40|10 km',
            '00:40:00',
            '70.0%',
            'Club',
            'hostile-runner',
            'first note',
            bundleId
        ].join(','),
        [
            '2',
            quoteCsvField(hostileUnlinkedParticipant),
            '2026',
            'Official',
            'M45|10 km',
            '00:41:00',
            '69.0%',
            'Club',
            '',
            'second note',
            bundleId
        ].join(',')
    ].join('\r\n');

    const context = await browserInstance.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    await page.route('**/data/family/webtables.csv', route =>
        route.fulfill({ status: 200, contentType: 'text/csv', body: `${webtables}\r\n` })
    );
    await page.route('**/data/family/hostile-current-official-family.csv', route =>
        route.fulfill({ status: 200, contentType: 'text/csv', body: `${leaderboard}\r\n` })
    );

    try {
        await page.goto(`${preview.baseUrl}/championships.html?site=family`, { waitUntil: 'domcontentloaded' });
        await page.locator('.distance-toggle').first().waitFor({ state: 'visible' });

        const toggle = page.locator('.distance-toggle').first();
        const toggleText = await toggle.textContent();

        if (!toggleText.includes(hostileDistance)) {
            failures.push('hostile exported value: DisplayDistance was not rendered as literal text in its heading.');
        }
        if (await toggle.locator('img').count() !== 0) {
            failures.push('hostile exported value: DisplayDistance produced an element inside its heading.');
        }

        await toggle.click();
        await page.locator('#leaderboards table').first().waitFor({ state: 'visible' });
        await waitForNetworkToSettle(page);

        const leaderboardText = await page.locator('#leaderboards').textContent();

        for (const [label, expected] of [
            ['DisplayTitle', hostileTitle],
            ['table header', hostileHeader],
            ['linked participant', hostileParticipant],
            ['unlinked participant', hostileUnlinkedParticipant]
        ]) {
            if (!leaderboardText.includes(expected)) {
                failures.push(`hostile exported value: ${label} was not rendered as literal text.`);
            }
        }

        for (const selector of ['#leaderboards img', '#leaderboards script', '#leaderboards svg']) {
            if (await page.locator(selector).count() !== 0) {
                failures.push(`hostile exported value: "${selector}" was created from an exported CSV value.`);
            }
        }

        // The clinching assertion: the injected handlers never ran. Element
        // absence alone would not catch a payload that executed and removed
        // itself.
        if (await page.evaluate(() => window.__exportedValueScriptRan) !== undefined) {
            failures.push('hostile exported value: an exported CSV value executed script in the page.');
        }
    } catch (error) {
        failures.push(`hostile exported value: ${error.message}`);
    } finally {
        await context.close();
    }
}

// The browser and scripts/validate-csv.mjs must read the same bytes the same
// way. A parser that splits on line breaks first cannot: it corrupts any quoted
// field containing a newline, so a file that passes every release check would
// still render wrongly.
async function runCsvParsingContractTests(browserInstance) {
    const fixture =
        'Header A,Header B,Header C\r\n' +
        'plain,"quoted, with comma","escaped ""quotes"" inside"\r\n' +
        'lf-row,"multi\nline value",after-lf\n' +
        'crlf-row,"crlf\r\nmultiline value",after-crlf\r\n';
    const context = await browserInstance.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    try {
        await page.goto(`${preview.baseUrl}/championships.html?site=family`, { waitUntil: 'domcontentloaded' });
        await waitForRenderedChampionship(page, 'family');

        const parsed = await page.evaluate(text => parseCSV(text), fixture);
        const expected = [
            ['Header A', 'Header B', 'Header C'],
            ['plain', 'quoted, with comma', 'escaped "quotes" inside'],
            ['lf-row', 'multi\nline value', 'after-lf'],
            ['crlf-row', 'crlf\r\nmultiline value', 'after-crlf']
        ];

        if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
            failures.push(
                `csv parsing: browser parse was ${JSON.stringify(parsed)}, expected ${JSON.stringify(expected)}.`
            );
        }

        // parseCsv here is the repository validator's algorithm, so this asserts
        // agreement rather than restating the expectation a second time.
        if (JSON.stringify(parsed) !== JSON.stringify(parseCsv(fixture))) {
            failures.push('csv parsing: the browser parser disagreed with the repository validator.');
        }

        const rejectsUnclosedQuote = await page.evaluate(() => {
            try {
                parseCSV('a,"unclosed\r\nb,c\r\n');
                return false;
            } catch {
                return true;
            }
        });

        if (!rejectsUnclosedQuote) {
            failures.push('csv parsing: an unclosed quoted field was accepted instead of failing closed.');
        }
    } catch (error) {
        failures.push(`csv parsing: ${error.message}`);
    } finally {
        await context.close();
    }
}

// The athlete page's Recent Results window must be measured from the export's
// own LastUpdatedUTC, not from the visitor's clock. The fixture discriminates
// permanently: the export is dated 1 June 2020, so a result from 1 March 2020
// is inside the exported window but many years outside any window measured from
// "now". If it renders, the window is anchored to exported data. If it
// disappears, something has gone back to reading the clock.
async function runRecentResultsWindowTests(browserInstance) {
    const bundleId = '20990101T010203004Z-A1B2C3D4';
    const siteInfo = [
        'Label,Value,ExportBundleID',
        `LastUpdatedUTC,2020-06-01T00:00:00Z,${bundleId}`,
        `SiteName,"Family Running Championships",${bundleId}`
    ].join('\r\n');
    const athleteResults = [
        'AthleteID,Participant,Date,Distance,Time,AgeGrade,Event,TimeClass,ExportBundleID',
        `window-runner,Window Runner,01/03/2020,5 km,00:20:00,70.0%,Inside The Exported Window,Official,${bundleId}`,
        `window-runner,Window Runner,01/03/2019,5 km,00:21:00,68.0%,Outside The Exported Window,Official,${bundleId}`
    ].join('\r\n');

    const context = await browserInstance.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    await page.route('**/data/family/siteinfo.csv', route =>
        route.fulfill({ status: 200, contentType: 'text/csv', body: `${siteInfo}\r\n` })
    );
    await page.route('**/data/athlete_results.csv', route =>
        route.fulfill({ status: 200, contentType: 'text/csv', body: `${athleteResults}\r\n` })
    );

    try {
        await page.goto(
            `${preview.baseUrl}/athlete.html?id=window-runner&site=family`,
            { waitUntil: 'domcontentloaded' }
        );
        // Wait for the section to render at all rather than for a table.
        // A regression here empties Recent Results, so waiting for a table
        // would report a timeout instead of the assertion that explains why.
        await page.waitForFunction(
            () => (document.querySelector('#recent-results')?.innerHTML.trim().length || 0) > 0
        );
        await page.locator('#all-results table').waitFor({ state: 'visible' });
        await waitForNetworkToSettle(page);

        const recent = normalizeText(await page.locator('#recent-results').textContent());

        if (!recent.includes('Inside The Exported Window')) {
            failures.push(
                'recent-results window: a result inside the exported twelve month window was omitted, so the window is being measured from the browser clock.'
            );
        }
        if (recent.includes('Outside The Exported Window')) {
            failures.push(
                'recent-results window: a result outside the exported twelve month window was included.'
            );
        }

        // Both results must still appear in the full list, so the window is
        // filtering Recent Results only.
        const all = normalizeText(await page.locator('#all-results').textContent());
        for (const event of ['Inside The Exported Window', 'Outside The Exported Window']) {
            if (!all.includes(event)) {
                failures.push(`recent-results window: "${event}" is missing from the full results table.`);
            }
        }
    } catch (error) {
        failures.push(`recent-results window: ${error.message}`);
    } finally {
        await context.close();
    }
}

// Link previews and favicons fail silently: nothing on the page looks wrong when
// an Open Graph tag is missing or its image 404s, so only a check like this
// catches it. The asset requests are made from the page itself, so a path that
// is correct in the repository but absent from the published artifact fails
// here too.
async function runBrandMetadataTests(browserInstance) {
    const pages = [
        'index.html',
        'championships.html',
        'hall-of-fame.html',
        'records.html',
        'calculator.html',
        'age-grade-calculator.html',
        'overview.html',
        'athlete.html'
    ];
    const requiredMeta = [
        ['name', 'description'],
        ['name', 'theme-color'],
        ['name', 'twitter:card'],
        ['property', 'og:type'],
        ['property', 'og:site_name'],
        ['property', 'og:title'],
        ['property', 'og:description'],
        ['property', 'og:image']
    ];
    const context = await browserInstance.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    try {
        for (const pagePath of pages) {
            await page.goto(`${preview.baseUrl}/${pagePath}?site=family`, { waitUntil: 'domcontentloaded' });

            const head = await page.evaluate(() => ({
                meta: [...document.querySelectorAll('meta')].map(node => ({
                    key: node.getAttribute('name') || node.getAttribute('property') || '',
                    content: node.getAttribute('content') || ''
                })),
                icons: [...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]')]
                    .map(node => node.getAttribute('href') || '')
            }));

            for (const [, key] of requiredMeta) {
                const tag = head.meta.find(entry => entry.key === key);

                if (!tag) {
                    failures.push(`brand metadata: ${pagePath} is missing its "${key}" tag.`);
                } else if (!tag.content.trim()) {
                    failures.push(`brand metadata: ${pagePath} has an empty "${key}" tag.`);
                }
            }

            // The site serves both modes from one static file, so Open Graph
            // text cannot vary by mode. Copy naming one mode would be wrong for
            // every share of the other.
            for (const key of ['description', 'og:title', 'og:description']) {
                const content = head.meta.find(entry => entry.key === key)?.content.toLowerCase() || '';

                if (content.includes('family') || content.includes('everyone')) {
                    failures.push(
                        `brand metadata: ${pagePath} "${key}" names a single site mode, but one static file serves both.`
                    );
                }
            }

            if (head.icons.length < 3) {
                failures.push(`brand metadata: ${pagePath} declares ${head.icons.length} icon links, expected 3.`);
            }

            for (const href of head.icons) {
                const response = await page.request.get(new URL(href, `${preview.baseUrl}/`).toString());

                if (!response.ok()) {
                    failures.push(`brand metadata: ${pagePath} icon "${href}" returned HTTP ${response.status()}.`);
                }
            }

            const ogImage = head.meta.find(entry => entry.key === 'og:image')?.content || '';
            const ogImagePath = ogImage.replace(/^https?:\/\/[^/]+\//, '');
            const ogResponse = await page.request.get(`${preview.baseUrl}/${ogImagePath}`);

            if (!ogResponse.ok()) {
                failures.push(
                    `brand metadata: ${pagePath} og:image "${ogImage}" is not served at ${ogImagePath} (HTTP ${ogResponse.status()}).`
                );
            }
        }
    } catch (error) {
        failures.push(`brand metadata: ${error.message}`);
    } finally {
        await context.close();
    }
}

// Below the mobile breakpoint the championship standings render as one card per
// athlete. The important property is not that it looks like a card but that
// nothing was lost doing it: every exported column still reaches the reader, and
// the desktop table is untouched. The old cramped table never failed a check,
// because it fits 390px without overflowing, so these assertions are about
// content parity rather than layout.
async function runMobileLeaderboardCardTests(browserInstance) {
    for (const mode of modes) {
        const mobile = await browserInstance.newContext({
            viewport: { width: 390, height: 844 },
            deviceScaleFactor: 3,
            isMobile: true,
            hasTouch: true
        });
        const page = await mobile.newPage();

        try {
            await page.goto(`${preview.baseUrl}/championships.html?site=${mode}`, { waitUntil: 'domcontentloaded' });
            await waitForRenderedChampionship(page, mode);
            await waitForNetworkToSettle(page);

            const layout = await page.evaluate(() => {
                const table = document.querySelector('.leaderboard-section table');
                const row = table.querySelector('tbody tr');

                return {
                    thead: getComputedStyle(table.querySelector('thead')).display,
                    row: getComputedStyle(row).display,
                    headers: [...table.querySelectorAll('thead th')].map(th => th.textContent.trim()),
                    labels: [...row.querySelectorAll('td')].map(td => td.dataset.label || ''),
                    labelled: [...row.querySelectorAll('td')].map(td => ({
                        label: td.dataset.label || '',
                        before: getComputedStyle(td, '::before').content,
                        heading: td.classList.contains('cell-rank') || td.classList.contains('cell-participant'),
                        empty: td.textContent.trim() === ''
                    })),
                    overflows: document.documentElement.scrollWidth > window.innerWidth
                };
            });

            if (layout.thead !== 'none') {
                failures.push(`mobile leaderboard cards (${mode}): the header row is still displayed.`);
            }
            if (layout.row !== 'block') {
                failures.push(`mobile leaderboard cards (${mode}): rows did not become cards.`);
            }
            if (layout.overflows) {
                failures.push(`mobile leaderboard cards (${mode}): the card layout overflows horizontally.`);
            }

            // Content parity: the card shows exactly the columns the table has.
            // A card layout that quietly drops columns would be a regression
            // dressed as an improvement.
            if (layout.labels.join('|') !== layout.headers.join('|')) {
                failures.push(
                    `mobile leaderboard cards (${mode}): card fields ${layout.labels.join(', ')} do not match table columns ${layout.headers.join(', ')}.`
                );
            }

            for (const cell of layout.labelled) {
                if (cell.heading) {
                    if (cell.before !== 'none') {
                        failures.push(
                            `mobile leaderboard cards (${mode}): the "${cell.label}" heading cell repeats its label.`
                        );
                    }
                    continue;
                }

                if (cell.empty) {
                    continue;
                }

                if (!cell.before.includes(cell.label)) {
                    failures.push(
                        `mobile leaderboard cards (${mode}): "${cell.label}" renders without its column label.`
                    );
                }
            }
        } catch (error) {
            failures.push(`mobile leaderboard cards (${mode}): ${error.message}`);
        } finally {
            await mobile.close();
        }

        // The same markup must still be a table on a wide viewport. Scoping the
        // card layout to a media query is the whole point.
        const desktop = await browserInstance.newContext({ viewport: { width: 1440, height: 900 } });
        const desktopPage = await desktop.newPage();

        try {
            await desktopPage.goto(`${preview.baseUrl}/championships.html?site=${mode}`, { waitUntil: 'domcontentloaded' });
            await waitForRenderedChampionship(desktopPage, mode);
            await waitForNetworkToSettle(desktopPage);

            const desktopLayout = await desktopPage.evaluate(() => {
                const table = document.querySelector('.leaderboard-section table');

                return {
                    thead: getComputedStyle(table.querySelector('thead')).display,
                    row: getComputedStyle(table.querySelector('tbody tr')).display,
                    before: getComputedStyle(table.querySelector('tbody td'), '::before').content
                };
            });

            if (desktopLayout.thead === 'none') {
                failures.push(`mobile leaderboard cards (${mode}): the desktop table lost its header row.`);
            }
            if (desktopLayout.row !== 'table-row') {
                failures.push(
                    `mobile leaderboard cards (${mode}): the desktop table stopped rendering as rows (${desktopLayout.row}).`
                );
            }
            if (desktopLayout.before !== 'none') {
                failures.push(`mobile leaderboard cards (${mode}): desktop cells repeat their column label.`);
            }
        } catch (error) {
            failures.push(`mobile leaderboard cards (${mode}) desktop: ${error.message}`);
        } finally {
            await desktop.close();
        }
    }
}

// The browser tab is the one place the site named a mode without honouring it:
// every <title> is static, so an Everyone-mode tab read "Family Running
// Championships" while the header showed the exported Everyone name. Nothing
// visible on the page was wrong, which is why it went unnoticed.
async function runDocumentTitleTests(browserInstance) {
    const pages = [
        'index.html',
        'championships.html',
        'hall-of-fame.html',
        'records.html',
        'calculator.html',
        'age-grade-calculator.html',
        'overview.html'
    ];
    const context = await browserInstance.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    try {
        for (const mode of modes) {
            const siteName = await expectedSiteName(mode);
            const otherName = await expectedSiteName(mode === 'family' ? 'everyone' : 'family');

            for (const pagePath of pages) {
                await page.goto(`${preview.baseUrl}/${pagePath}?site=${mode}`, { waitUntil: 'domcontentloaded' });
                await page.waitForFunction(
                    expected => document.title.includes(expected),
                    siteName,
                    { timeout: 10000 }
                ).catch(() => {});

                const title = await page.title();

                if (!title.includes(siteName)) {
                    failures.push(
                        `document title (${mode}): ${pagePath} is "${title}", which does not name the exported site "${siteName}".`
                    );
                }
                if (title.includes(otherName)) {
                    failures.push(
                        `document title (${mode}): ${pagePath} is "${title}", which names the other site mode "${otherName}".`
                    );
                }
            }
        }

        // The athlete page carries no site name at all, so it was never wrong
        // and must not gain one. Its title is the athlete, which is what a
        // bookmark or history entry should say.
        await page.goto(`${preview.baseUrl}/athlete.html?id=carolyn-kevan&site=everyone`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.title.includes('Athlete Profile'), null, { timeout: 10000 })
            .catch(() => {});

        const athleteTitle = await page.title();

        if (!athleteTitle.includes('Athlete Profile')) {
            failures.push(`document title: athlete page is "${athleteTitle}", expected it to name the profile.`);
        }
        for (const mode of modes) {
            const siteName = await expectedSiteName(mode);

            if (athleteTitle.includes(siteName)) {
                failures.push(
                    `document title: athlete page is "${athleteTitle}", which should not name a site mode.`
                );
            }
        }
    } catch (error) {
        failures.push(`document title: ${error.message}`);
    } finally {
        await context.close();
    }
}

async function runAgeGradeCalculatorContractEdgeCaseTests(browserInstance) {
    const context = await browserInstance.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    try {
        const filePath = path.join(siteRoot, 'data', 'family', 'age_grade_calculator.csv');
        const csv = await fs.readFile(filePath, 'utf8');
        const mismatchedCsv = csv.replace(
            'AGOC:=[@OC]/[@[Age Factor]]|AGSCORE:=[@[AG OC]]/[@[Time Seconds]]|FORMAT:0.00%',
            'changed-workbook-contract'
        );

        await page.route('**/data/family/age_grade_calculator.csv', route => route.fulfill({
            status: 200,
            contentType: 'text/csv; charset=utf-8',
            body: mismatchedCsv
        }));
        await page.goto(`${preview.baseUrl}/age-grade-calculator.html?site=family`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#age-grade-result[data-state="error"]');

        if (!await page.locator('#age-grade-time').isDisabled()) {
            failures.push('age-grade calculator contract mismatch: time input remained enabled.');
        }
        const status = normalizeText(await page.locator('#age-grade-contract-status').textContent());
        if (!status.includes('Excel age-grade formula has changed')) {
            failures.push('age-grade calculator contract mismatch: fail-closed explanation was not shown.');
        }
    } catch (error) {
        failures.push(`age-grade calculator contract mismatch: ${error.message}`);
    } finally {
        await context.close();
    }
}

async function runCalculatorComparisonUnavailableEdgeCaseTests(browserInstance) {
    const manifestPath = path.join(siteRoot, 'data', 'export_manifest.csv');
    const manifest = (await fs.readFile(manifestPath, 'utf8'))
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .filter(line => !line.includes('/athlete_comparison_targets.csv,'))
        .join('\r\n');

    for (const viewport of viewports) {
        const context = await browserInstance.newContext(viewport.contextOptions);
        const page = await context.newPage();
        const requestedPaths = [];

        await page.route('**/data/export_manifest.csv', route =>
            route.fulfill({ status: 200, contentType: 'text/csv', body: manifest })
        );
        page.on('request', request => {
            if (isSameOrigin(request.url())) {
                requestedPaths.push(sameOriginRequestPath(request.url()));
            }
        });

        try {
            await page.goto(`${preview.baseUrl}/calculator.html?site=family`, { waitUntil: 'domcontentloaded' });
            await waitForRenderedCalculator(page, 'family');
            await waitForNetworkToSettle(page);

            if (requestedPaths.includes('data/family/athlete_comparison_targets.csv')) {
                failures.push(`calculator unavailable ${viewport.name}: requested a comparison file absent from the manifest.`);
            }

            const text = normalizeText(await page.locator('#comparison-results').textContent());
            if (!text.includes('Head-to-head targets are not available in this championship update yet.')) {
                failures.push(`calculator unavailable ${viewport.name}: unavailable state was not rendered.`);
            }
        } catch (error) {
            failures.push(`calculator unavailable ${viewport.name}: ${error.message}`);
        } finally {
            await context.close();
        }
    }
}

async function runCalculatorComparisonEdgeCaseTests(browserInstance) {
    const manifest = [
        'ExportBundleID,ExportedAtUTC,SchemaVersion,Scope,RelativePath,DataRowCount',
        '20990101T010203004Z-A1B2C3D4,2099-01-01T01:02:03.004Z,1.0,family,data/family/athlete_comparison_targets.csv,8'
    ].join('\r\n');
    const comparisonTargets = [
        'ChallengerAthleteId,StandardAthleteId,Distance,BenchmarkType,StandardTime,StandardAgeGrade,StandardDate,StandardEvent,StandardTimeClass,Period,RequiredTimeToBeat,RequiredPacePerKm,RequiredPacePerMile,SortOrder,ExportBundleID',
        'john-kevan,carolyn-kevan,5 km,Best Age Grade,00:25:20,78.0%,28/03/2026,Northern Counties Womens Relay,Official,Current,00:18:08,3:37.6,5:50.1,101,20990101T010203004Z-A1B2C3D4',
        'john-kevan,carolyn-kevan,5 km,Fastest Time,00:25:20,78.0%,28/03/2026,Northern Counties Womens Relay,Official,Current,00:18:08,3:37.6,5:50.1,102,20990101T010203004Z-A1B2C3D4',
        'john-kevan,carolyn-kevan,10 km,Best Age Grade,00:52:00,72.0%,01/02/2026,Training effort,Unofficial,Current,00:38:00,3:48.0,6:06.3,201,20990101T010203004Z-A1B2C3D4',
        'john-kevan,carolyn-kevan,10 km,Fastest Time,00:51:00,71.0%,01/02/2026,Training effort,Unofficial,Current,00:38:30,3:51.0,6:11.1,202,20990101T010203004Z-A1B2C3D4',
        'john-kevan,carolyn-kevan,5 km,Best Age Grade,00:25:20,78.0%,28/03/2026,Northern Counties Womens Relay,Official,All Time,00:18:08,3:37.6,5:50.1,101,20990101T010203004Z-A1B2C3D4',
        'john-kevan,carolyn-kevan,5 km,Fastest Time,00:23:27,77.8%,16/11/2019,Northern Masters 5k Championships,Official,All Time,00:18:11,3:38.2,5:51.1,102,20990101T010203004Z-A1B2C3D4',
        'john-kevan,carolyn-kevan,10 km,Best Age Grade,00:52:00,72.0%,01/02/2026,Training effort,Unofficial,All Time,00:38:00,3:48.0,6:06.3,201,20990101T010203004Z-A1B2C3D4',
        'john-kevan,carolyn-kevan,10 km,Fastest Time,00:51:00,71.0%,01/02/2026,Training effort,Unofficial,All Time,00:38:30,3:51.0,6:11.1,202,20990101T010203004Z-A1B2C3D4'
    ].join('\r\n');
    const currentChampionship = [
        'Rank,Participant,Race Year,Time Class,SexAgeEvent,Time,Age Graded Score,Age Graded Category,Athlete ID,ExportBundleID',
        '1,Carolyn Kevan,2026,Official,F66|5 km,00:25:20,78.0%,Regional Class,carolyn-kevan,20990101T010203004Z-A1B2C3D4',
        '2,John Kevan,2026,Official,M46|5 km,00:18:00,77.9%,Regional Class,john-kevan,20990101T010203004Z-A1B2C3D4',
        '3,David Graham-Kevan,2026,Official,M57|5 km,00:23:37,65.5%,Local Competitive,david-graham-kevan,20990101T010203004Z-A1B2C3D4',
        '4,Poppy Coleman,2026,Official,F24|5 km,00:22:37,61.5%,Local Competitive,poppy-coleman,20990101T010203004Z-A1B2C3D4',
        '5,Jack Graham-Kevan,2026,Official,M22|5 km,00:24:00,58.6%,Club,jack-graham-kevan,20990101T010203004Z-A1B2C3D4'
    ].join('\r\n');

    for (const viewport of viewports) {
        const context = await browserInstance.newContext(viewport.contextOptions);
        const page = await context.newPage();
        const requestedPaths = [];

        await page.route('**/data/export_manifest.csv', route =>
            route.fulfill({ status: 200, contentType: 'text/csv', body: `${manifest}\r\n` })
        );
        await page.route('**/data/family/athlete_comparison_targets.csv', route =>
            route.fulfill({ status: 200, contentType: 'text/csv', body: `${comparisonTargets}\r\n` })
        );
        await page.route('**/data/family/overall-current-official-family.csv', route =>
            route.fulfill({ status: 200, contentType: 'text/csv', body: `${currentChampionship}\r\n` })
        );
        await page.route('**/data/everyone/athlete_comparison_targets.csv', route => route.abort());
        page.on('request', request => {
            if (isSameOrigin(request.url())) {
                requestedPaths.push(sameOriginRequestPath(request.url()));
            }
        });

        try {
            await page.goto(`${preview.baseUrl}/calculator.html?site=family`, { waitUntil: 'domcontentloaded' });
            await waitForRenderedCalculator(page, 'family');
            await page.locator('.comparison-distance-card').first().waitFor({ state: 'visible' });
            await waitForNetworkToSettle(page);

            if (!requestedPaths.includes('data/family/athlete_comparison_targets.csv')) {
                failures.push(`calculator comparison ${viewport.name}: selected-site comparison export was not requested.`);
            }
            if (requestedPaths.includes('data/everyone/athlete_comparison_targets.csv')) {
                failures.push(`calculator comparison ${viewport.name}: other-site comparison export was requested.`);
            }
            if (await page.locator('.comparison-distance-card').count() !== 2) {
                failures.push(`calculator comparison ${viewport.name}: expected one official and one unofficial distance card.`);
            }
            if (await page.locator('.comparison-benchmark').count() !== 3) {
                failures.push(`calculator comparison ${viewport.name}: matching current benchmarks were not combined into one row.`);
            }
            if (await page.locator('.comparison-benchmark-type').count() !== 4) {
                failures.push(`calculator comparison ${viewport.name}: combined current row did not retain both benchmark badges.`);
            }
            if (await page.locator('input[name="comparison-period"]').count() !== 2
                || await page.locator('input[name="comparison-period"]:checked').inputValue() !== 'Current') {
                failures.push(`calculator comparison ${viewport.name}: did not default the period switch to Current.`);
            }

            const text = normalizeText(await page.locator('.comparison-panel').textContent());
            for (const expected of [
                'John Kevan challenges Carolyn Kevan',
                'Best Age Grade',
                '00:25:20',
                '78.0% age grade',
                '00:18:08',
                'Fastest Time',
                'Official results',
                'Unofficial results',
                'Training effort',
                '00:52:00',
                '00:51:00'
            ]) {
                if (!text.includes(expected)) {
                    failures.push(`calculator comparison ${viewport.name}: omitted exported value "${expected}".`);
                }
            }
            if (text.includes('00:23:27') || text.includes('Northern Masters 5k Championships')) {
                failures.push(`calculator comparison ${viewport.name}: Current view included an all-time-only performance.`);
            }

            await page.getByText('All time', { exact: true }).click();
            if (await page.locator('.comparison-benchmark').count() !== 4) {
                failures.push(`calculator comparison ${viewport.name}: All-time view did not show its four distinct standards.`);
            }
            const allTimeText = normalizeText(await page.locator('.comparison-panel').textContent());
            for (const expected of ['Showing all-time standards', '00:23:27', '77.8% age grade', '00:18:11']) {
                if (!allTimeText.includes(expected)) {
                    failures.push(`calculator comparison ${viewport.name}: All-time view omitted "${expected}".`);
                }
            }
            await assertVisiblePaceUnit(
                page.locator('.comparison-panel'),
                'km',
                `calculator comparison ${viewport.name} paces`
            );
            await page.locator('.site-pace-control').getByRole('button', { name: 'Show pace per mile' }).click();
            await assertVisiblePaceUnit(
                page.locator('.comparison-panel'),
                'mi',
                `calculator comparison ${viewport.name} mile paces`
            );
            await page.getByText('Current', { exact: true }).click();

            await page.locator('.comparison-panel').screenshot({
                path: path.join(artifactsDir, `family-calculator-comparison-${viewport.name}.png`)
            });

            await page.locator('#comparison-athlete-b').selectOption('john-kevan');
            const challenger = await page.locator('#comparison-athlete-a').inputValue();
            const standard = await page.locator('#comparison-athlete-b').inputValue();
            if (challenger === standard) {
                failures.push(`calculator comparison ${viewport.name}: allowed a self-comparison.`);
            }
        } catch (error) {
            failures.push(`calculator comparison ${viewport.name}: ${error.message}`);
        } finally {
            await context.close();
        }
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
    await assertResponsiveViewport(page, viewport, `${mode}/${viewport.name} athlete page`);
    await assertBundleMetadataHidden(page, `${mode}/${viewport.name} athlete page`);

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

async function assertDirectAthleteProfile(page, mode, viewport) {
    const rows = await readCsvObjects('data/athlete_results.csv');
    const athleteId = rows.find(row => row.AthleteID)?.AthleteID;

    if (!athleteId) {
        return;
    }

    await page.goto(`${preview.baseUrl}/athlete.html?id=${encodeURIComponent(athleteId)}&site=${mode}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#athlete-name');
    await page.waitForFunction(() => {
        const name = document.querySelector('#athlete-name')?.textContent?.trim() || '';
        return name && name !== 'Loading...' && name !== 'Athlete not found';
    });
    await waitForNetworkToSettle(page);
    await assertPrimaryNavigation(page, mode, viewport, 'athlete');
    await assertNoModeSwitch(page, mode, viewport, 'athlete');
    await assertAthleteHeaderLayout(page, mode, viewport);
    await assertProgressionChart(page, mode, viewport);
    await assertResponsiveViewport(page, viewport, `${mode}/${viewport.name} direct athlete page`);
    await assertBundleMetadataHidden(page, `${mode}/${viewport.name} direct athlete page`);
}

async function assertAthleteHeaderLayout(page, mode, viewport) {
    const context = `${mode}/${viewport.name} athlete header`;
    const layout = await page.evaluate(() => {
        const bounds = selector => {
            const element = document.querySelector(selector);
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            return {
                bottom: rect.bottom,
                height: rect.height,
                left: rect.left,
                right: rect.right,
                top: rect.top
            };
        };

        return {
            athleteHeader: bounds('.athlete-profile-header'),
            athleteLabel: bounds('.athlete-header-label'),
            athleteName: bounds('#athlete-name'),
            backLinkInNavigation: document.querySelectorAll('.site-nav .back-link').length,
            contextCount: document.querySelectorAll('#athlete-context').length,
            mainHeader: bounds('.site-header-main'),
            modeBadgeCount: document.querySelectorAll('.site-mode-badge').length,
            navigation: bounds('.site-navigation-panel'),
            paceControl: bounds('.site-pace-control'),
            primaryNavigation: bounds('.site-nav'),
            profileToplineCount: document.querySelectorAll('.athlete-header-topline').length,
            siteHeader: bounds('.site-header'),
            updated: bounds('#last-updated')
        };
    });

    if (layout.backLinkInNavigation !== 1) {
        failures.push(`${context}: expected the back link in the primary navigation.`);
    }
    if (layout.profileToplineCount !== 0 || layout.contextCount !== 0) {
        failures.push(`${context}: the removed championship-context row is still present.`);
    }
    if (layout.modeBadgeCount !== 0) {
        failures.push(`${context}: the redundant current-site badge is still present.`);
    }
    if (!layout.athleteHeader || layout.athleteHeader.height >= 120) {
        failures.push(`${context}: athlete banner was not reduced below 120px.`);
    }
    if (!layout.athleteLabel || !layout.athleteName || layout.athleteName.left <= layout.athleteLabel.left) {
        failures.push(`${context}: athlete name was not positioned to the right of its label.`);
    }
    if (!layout.updated || !layout.mainHeader || layout.updated.top < layout.mainHeader.top || layout.updated.bottom > layout.mainHeader.bottom + 1) {
        failures.push(`${context}: updated timestamp was not kept in the top header row.`);
    }
    if (!layout.navigation || !layout.mainHeader || layout.navigation.top < layout.mainHeader.bottom - 1) {
        failures.push(`${context}: header controls were not positioned below the title row.`);
    }
    if (!layout.paceControl || !layout.navigation || Math.abs(layout.paceControl.right - layout.navigation.right) > 1) {
        failures.push(`${context}: pace control was not aligned to the right of the menu row.`);
    }
    if (viewport.name === 'desktop' && (!layout.primaryNavigation || !layout.paceControl || layout.paceControl.left - layout.primaryNavigation.right < 24)) {
        failures.push(`${context}: menu links were not separated from the right-aligned pace control.`);
    }
    if (viewport.name === 'desktop' && (!layout.siteHeader || layout.siteHeader.height >= 210)) {
        failures.push(`${context}: main header was not reduced below 210px on desktop.`);
    }
}

// The chart library is vendored and same-origin, so unlike the previous CDN
// build it is reachable under the cross-origin blocking above and this path can
// actually be exercised.
async function assertProgressionChart(page, mode, viewport) {
    const context = `${mode}/${viewport.name}`;
    const progression = page.locator('#progression');

    const outcome = await page.waitForFunction(() => {
        const canvas = document.getElementById('age-grade-chart');
        const text = document.getElementById('progression')?.textContent?.trim() || '';

        if (text) {
            return { state: 'message', text };
        }

        if (!canvas || typeof Chart === 'undefined') {
            return null;
        }

        const instance = Chart.getChart(canvas);

        if (!instance) {
            return null;
        }

        return {
            state: 'chart',
            points: instance.data.datasets.reduce(
                (total, dataset) => total + dataset.data.length,
                0
            ),
            xScaleType: instance.scales.x?.type || ''
        };
    }, null, { timeout: 10000 })
        .then(handle => handle.jsonValue())
        .catch(() => null);

    if (!outcome) {
        const text = normalizeText(await progression.textContent());
        failures.push(
            `${context}: progression chart neither rendered nor reported a state (section text: "${text}").`
        );
        return;
    }

    if (outcome.state === 'message') {
        // "No progression data found." is a legitimate exported state. A failure
        // to load the vendored library is not.
        if (!outcome.text.startsWith('No progression data found')) {
            failures.push(`${context}: progression chart reported "${outcome.text}".`);
        }
        return;
    }

    if (outcome.xScaleType !== 'time') {
        failures.push(
            `${context}: progression x-axis was "${outcome.xScaleType}", expected the date adapter's "time" scale.`
        );
    }

    if (outcome.points < 1) {
        failures.push(`${context}: progression chart plotted no exported age-grade points.`);
    }
}

// Checked explicitly rather than inferred from the overflow assertion: a page
// missing the tag simply lays out at the ~980px fallback width, which does not
// overflow and so would otherwise pass unnoticed.
async function assertResponsiveViewport(page, viewport, context) {
    const layout = await page.evaluate(() => ({
        content: document.querySelector('meta[name="viewport"]')?.getAttribute('content') || '',
        robots: document.querySelector('meta[name="robots"]')?.getAttribute('content') || '',
        lang: document.documentElement.getAttribute('lang') || '',
        clientWidth: document.documentElement.clientWidth
    }));

    // The site is deliberately kept out of search results by this tag rather
    // than by a robots.txt Disallow, so a page shipping without it would be
    // indexed while every other page is not.
    if (!/\bnoindex\b/i.test(layout.robots)) {
        failures.push(
            `${context}: missing a noindex robots meta tag (found "${layout.robots}").`
        );
    }

    if (!/width\s*=\s*device-width/i.test(layout.content)) {
        failures.push(
            `${context}: missing a width=device-width viewport meta tag (found "${layout.content}").`
        );
    }

    if (!layout.lang) {
        failures.push(`${context}: <html> has no lang attribute.`);
    }

    const expectedWidth = viewport.contextOptions.viewport.width;

    if (layout.clientWidth > expectedWidth + 1) {
        failures.push(
            `${context}: laid out at ${layout.clientWidth}px inside a ${expectedWidth}px viewport, ` +
            'so the meta viewport tag is not being applied.'
        );
    }
}

async function assertBundleMetadataHidden(page, context) {
    const manifestRows = await readCsvObjects('data/export_manifest.csv');
    const bundleId = manifestRows[0]?.ExportBundleID || '';
    const bodyText = normalizeText(await page.locator('body').textContent());

    if (bodyText.includes('ExportBundleID')) {
        failures.push(`${context}: rendered the ExportBundleID metadata column name.`);
    }

    if (bundleId && bodyText.includes(bundleId)) {
        failures.push(`${context}: rendered export bundle metadata value "${bundleId}".`);
    }
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

async function assertAgeGradeStandards(page, mode, viewport) {
    const paceScenario = await findAgeGradePaceScenario(mode);

    if (!paceScenario) {
        failures.push(`${mode}/${viewport.name}: no athlete has all required age-grade pace examples.`);
        return;
    }

    await page.goto(
        `${preview.baseUrl}/athlete.html?id=${encodeURIComponent(paceScenario.athleteId)}&site=${mode}`,
        { waitUntil: 'domcontentloaded' }
    );
    await page.locator('#age-grade-standards-section:not(.hidden)').waitFor({ state: 'visible' });
    await waitForNetworkToSettle(page);

    const section = page.locator('#age-grade-standards-section');
    const control = page.locator('.site-pace-control');
    const perKm = control.getByRole('button', { name: 'Show pace per kilometre' });
    const perMile = control.getByRole('button', { name: 'Show pace per mile' });
    const context = `${mode}/${viewport.name}`;

    await expectText(
        page,
        '.age-grade-standards-intro p',
        'Target times and required pace. Pace is rounded down to the nearest tenth of a second.',
        `${context} age-grade pace helper`
    );

    if (await section.locator('.pace-unit-control').count() !== 0) {
        failures.push(`${context}: age-grade standards rendered a duplicate pace control.`);
    }
    if (await perKm.getAttribute('aria-pressed') !== 'true') {
        failures.push(`${context}: header /km was not selected for a first-time visitor.`);
    }
    if (await perMile.getAttribute('aria-pressed') !== 'false') {
        failures.push(`${context}: header /mi was selected before the user changed pace unit.`);
    }

    await assertRenderedAgeGradePaces(section, paceScenario.examples, 'km', context);
    await section.screenshot({
        path: path.join(artifactsDir, `${mode}-age-grade-standards-${viewport.name}-km.png`)
    });

    await perMile.focus();
    await page.keyboard.press('Enter');

    if (await perMile.getAttribute('aria-pressed') !== 'true') {
        failures.push(`${context}: keyboard selection did not activate /mi.`);
    }
    if (await perKm.getAttribute('aria-pressed') !== 'false') {
        failures.push(`${context}: /km remained pressed after selecting /mi.`);
    }

    await assertRenderedAgeGradePaces(section, paceScenario.examples, 'mi', context);
    await section.screenshot({
        path: path.join(artifactsDir, `${mode}-age-grade-standards-${viewport.name}-mi.png`)
    });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#age-grade-standards-section:not(.hidden)').waitFor({ state: 'visible' });

    const reloadedSection = page.locator('#age-grade-standards-section');
    const reloadedControl = page.locator('.site-pace-control');
    const reloadedPerMile = reloadedControl.getByRole('button', { name: 'Show pace per mile' });
    const reloadedPerKm = reloadedControl.getByRole('button', { name: 'Show pace per kilometre' });
    if (await reloadedPerMile.getAttribute('aria-pressed') !== 'true') {
        failures.push(`${context}: /mi selection did not persist after reload.`);
    }
    await assertRenderedAgeGradePaces(reloadedSection, paceScenario.examples, 'mi', `${context} after reload`);
    await assertVisiblePaceUnit(page.locator('#personal-bests'), 'mi', `${context} athlete profile paces`);

    await reloadedPerKm.click();
    await assertRenderedAgeGradePaces(reloadedSection, paceScenario.examples, 'km', `${context} restored to km`);
}

async function assertRenderedAgeGradePaces(section, examples, unit, context) {
    for (const example of examples) {
        const rows = section.locator('tbody tr');
        const rowIndex = await rows.evaluateAll(
            (elements, distance) => elements.findIndex(element =>
                element.querySelector('th')?.textContent?.trim() === distance
            ),
            example.distance
        );

        if (rowIndex < 0) {
            failures.push(`${context}: no age-grade standards row was rendered for ${example.distance}.`);
            continue;
        }

        const row = rows.nth(rowIndex);
        const cells = row.locator('td');
        const cellIndex = await cells.evaluateAll(
            (elements, targetTime) => elements.findIndex(element =>
                element.querySelector('.age-grade-target-time')?.textContent?.trim() === targetTime
            ),
            example.targetTime
        );

        if (cellIndex < 0) {
            failures.push(
                `${context}: ${example.distance} did not render target time ${example.targetTime}.`
            );
            continue;
        }

        const cell = cells.nth(cellIndex);
        const targetTime = normalizeText(await cell.locator('.age-grade-target-time').textContent());
        const paces = cell.locator('.age-grade-pace');
        const visiblePaces = [];

        for (let index = 0; index < await paces.count(); index += 1) {
            const pace = paces.nth(index);
            if (await pace.isVisible()) {
                visiblePaces.push(pace);
            }
        }

        const visiblePaceCount = visiblePaces.length;
        const expectedPace = `${example[unit]} /${unit}`;

        if (targetTime !== example.targetTime) {
            failures.push(
                `${context}: ${example.distance} target time was "${targetTime}", expected "${example.targetTime}".`
            );
        }
        if (visiblePaceCount !== 1) {
            failures.push(
                `${context}: ${example.distance} showed ${visiblePaceCount} pace values, expected exactly one.`
            );
            continue;
        }

        const actualPace = normalizeText(await visiblePaces[0].textContent());
        if (actualPace !== expectedPace) {
            failures.push(
                `${context}: ${example.distance} pace was "${actualPace}", expected "${expectedPace}".`
            );
        }
    }
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
            formatWebsiteDate(medal.EventDate),
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

async function expectedOverviewRecentRows(mode) {
    const [officialRows, windowEnd] = await Promise.all([
        overviewOfficialRows(mode),
        overviewReferenceDate(mode)
    ]);
    const windowStart = subtractCalendarMonths(windowEnd, 6);

    return officialRows
        .filter(row => row.parsedDate >= windowStart && row.parsedDate <= windowEnd)
        .sort((a, b) =>
            b.parsedDate - a.parsedDate ||
            String(a.Participant || '').localeCompare(String(b.Participant || '')) ||
            a.__csvIndex - b.__csvIndex
        );
}

async function expectedOverviewActivityRows(mode) {
    const [officialRows, windowEnd] = await Promise.all([
        overviewOfficialRows(mode),
        overviewReferenceDate(mode)
    ]);
    const windowStart = subtractCalendarMonths(windowEnd, 12);
    const counts = new Map();

    for (const row of officialRows.filter(candidate =>
        candidate.parsedDate >= windowStart && candidate.parsedDate <= windowEnd
    )) {
        const athleteId = cleanAthleteId(row.AthleteID);
        const current = counts.get(athleteId) || {
            count: 0,
            name: row.Participant || row.AthleteID
        };

        current.count += 1;
        counts.set(athleteId, current);
    }

    return [...counts.values()]
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

async function overviewOfficialRows(mode) {
    const [athleteRows, siteAthleteIds] = await Promise.all([
        readCsvObjects('data/athlete_results.csv'),
        overviewSiteAthleteIds(mode)
    ]);

    return athleteRows
        .filter(row => row.AthleteID && siteAthleteIds.has(cleanAthleteId(row.AthleteID)))
        .filter(row => String(row.TimeClass || '').toLowerCase() === 'official')
        .map((row, index) => ({
            ...row,
            __csvIndex: index,
            parsedDate: parseOverviewDate(row.Date)
        }))
        .filter(row => row.parsedDate);
}

async function overviewReferenceDate(mode) {
    const siteInfoRows = await readCsvObjects(`data/${mode}/siteinfo.csv`);
    const updatedAt = siteInfoRows.find(row => row.Label === 'LastUpdatedUTC')?.Value || '';
    return parseOverviewDate(String(updatedAt).split('T')[0]) || new Date();
}

async function overviewSiteAthleteIds(mode) {
    const ids = new Set();
    const standardsRows = await readCsvObjects(`data/${mode}/age_grade_standards.csv`);

    for (const row of standardsRows) {
        const id = cleanAthleteId(row.AthleteId || row.AthleteID || row['Athlete ID']);
        if (id) ids.add(id);
    }

    if (!ids.size && mode === 'everyone') {
        const athleteRows = await readCsvObjects('data/athlete_results.csv');
        for (const row of athleteRows) {
            const id = cleanAthleteId(row.AthleteID);
            if (id) ids.add(id);
        }
    }

    return ids;
}

function parseOverviewDate(value) {
    const text = String(value || '').trim();
    const exportedMatch = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    let year;
    let month;
    let day;

    if (exportedMatch) {
        [, day, month, year] = exportedMatch.map(Number);
    } else if (isoMatch) {
        [, year, month, day] = isoMatch.map(Number);
    } else {
        return null;
    }

    const parsed = new Date(year, month - 1, day);
    return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day
        ? parsed
        : null;
}

function subtractCalendarMonths(value, months) {
    const result = new Date(value.getTime());
    const originalDay = result.getDate();
    result.setDate(1);
    result.setMonth(result.getMonth() - months);
    result.setDate(Math.min(originalDay, new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate()));
    return result;
}

function formatWebsiteDate(value) {
    const parsed = parseOverviewDate(value);
    if (!parsed) return String(value || '');

    const months = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
    ];
    return `${parsed.getDate()} ${months[parsed.getMonth()]} ${parsed.getFullYear()}`;
}

function cleanAthleteId(value) {
    return String(value || '').trim().toLowerCase();
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

async function findAgeGradePaceScenario(mode) {
    const rows = await readCsvObjects(`data/${mode}/age_grade_standards.csv`);
    const examples = [
        { distance: '5 km', targetTime: '00:20:13', km: '4:02.6', mi: '6:30.4' },
        { distance: '10 Mile', targetTime: '01:07:20', km: '4:11.0', mi: '6:44.0' },
        { distance: 'Half Marathon', targetTime: '01:29:35', km: '4:14.7', mi: '6:50.0' },
        { distance: 'Marathon', targetTime: '02:24:12', km: '3:25.0', mi: '5:29.9' }
    ];
    const athleteIds = [...new Set(rows.map(row => row.AthleteId).filter(Boolean))];
    const athleteId = athleteIds.find(candidate => examples.every(example =>
        rows.some(row =>
            row.AthleteId === candidate &&
            row.Distance === example.distance &&
            row.RequiredTime === example.targetTime &&
            row.pace_per_km === example.km &&
            row.pace_per_mile === example.mi
        )
    ));

    return athleteId ? { athleteId, examples } : null;
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

async function publicCsvExists(relativePath) {
    try {
        await fs.access(path.join(repoRoot, relativePath));
        return true;
    } catch {
        return false;
    }
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

function quoteCsvField(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
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

function isSameOrigin(url) {
    try {
        return new URL(url).origin === new URL(preview.baseUrl).origin;
    } catch {
        return false;
    }
}
