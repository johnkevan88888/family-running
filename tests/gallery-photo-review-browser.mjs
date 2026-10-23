import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createStaticServer } from '../scripts/serve-site.mjs';
import { findChromiumExecutable, loadPlaywright } from '../scripts/browser-runtime.mjs';
import { parseCsv } from '../scripts/export-bundle-tools.mjs';
import galleryContract from '../gallery-contract.js';
import galleryResults from '../gallery-results.js';
import { assertPhotoReviewDetails } from './helpers/gallery-photo-review-details.mjs';

// This smoke check uses the actual candidate manifest and exported public data.
// All off-origin requests are aborted before network I/O: screenshots prove
// layout and exact public fields, not real-photo pixels or delivery. The focused
// synthetic thumbnail/framing suites supply independent pixel/suppression tests.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const siteRoot = process.env.SITE_ROOT ? path.resolve(process.env.SITE_ROOT) : root;
const screenshots = path.join(root, 'test-artifacts', 'screenshots');
const read = relative => fs.readFile(path.join(siteRoot, ...relative.split('/')), 'utf8');
const suppression = JSON.parse(await read('gallery-data/hidden-athlete-ids.json'));
assert.deepEqual(galleryContract.validateGallerySuppressionDocument(suppression), []);
const utilityContext = vm.createContext({ window: {} });
vm.runInContext(await read('utils.js'), utilityContext);
const resultRows = parseCsv(await read('data/athlete_results.csv'));
const exportRows = parseCsv(await read('data/export_manifest.csv'));
const modes = ['family', 'everyone'];
const viewports = [
    ['desktop', { viewport: { width: 1440, height: 900 } }],
    ['mobile', { viewport: { width: 390, height: 844 }, isMobile: true,
        hasTouch: true, deviceScaleFactor: 3 }]
];
const started = Date.now();
const server = await createStaticServer({ root: siteRoot, port: 0, silent: true });
const { chromium } = loadPlaywright();
let browser;
try {
    await fs.mkdir(screenshots, { recursive: true });
    browser = await chromium.launch({ headless: true, executablePath: findChromiumExecutable(),
        args: ['--disable-dev-shm-usage'] });
    for (const mode of modes) {
        const documentValue = JSON.parse(await read(`gallery-data/${mode}.json`));
        assert.deepEqual(galleryContract.validateGalleryDocument(documentValue), []);
        const items = galleryContract.filterSuppressedGalleryItems(documentValue.items, suppression);
        const rosterRows = parseCsv(await read(`data/${mode}/age_grade_standards.csv`));
        const index = galleryResults.buildIndex(resultRows, rosterRows, exportRows, mode,
            utilityContext.csvRowsToObjects);
        const firstId = items.flatMap(item => item.athleteIds)[0] ||
            utilityContext.csvRowsToObjects(rosterRows)[0]?.AthleteId;
        // Cover every tagged photo athlete, including every new batch member:
        // an older first item cannot mask another athlete's profile regression.
        const profileIds = [...new Set([firstId,
            ...items.filter(item => item.type === 'photo').flatMap(item => item.athleteIds)])].filter(Boolean);
        for (const [size, options] of viewports) {
            const context = await browser.newContext(options);
            const page = await context.newPage();
            page.setDefaultTimeout(10000);
            page.setDefaultNavigationTimeout(10000);
            const failures = [], requested = [];
            await context.route('**/*', route => {
                const url = new URL(route.request().url());
                if (url.origin === server.baseUrl) return route.continue();
                return route.abort();
            });
            page.on('pageerror', error => failures.push(error.message));
            page.on('request', request => {
                const url = new URL(request.url());
                if (url.origin === server.baseUrl) requested.push(url.pathname.slice(1));
            });
            page.on('requestfailed', request => {
                if (new URL(request.url()).origin === server.baseUrl) failures.push(`Failed local request: ${request.url()}`);
            });
            page.on('response', response => {
                if (new URL(response.url()).origin === server.baseUrl && response.status() >= 400) {
                    failures.push(`Local response ${response.status()}: ${response.url()}`);
                }
            });
            try {
                const label = `${mode}/${size}`;
                await open('gallery.html');
                await page.waitForFunction(() => {
                    const status = document.querySelector('#gallery-status');
                    return document.querySelector('.gallery-card') ||
                        (status && !status.hidden && !status.textContent.includes('Loading'));
                });
                assert.equal(await page.locator('.gallery-status.is-error').count(), 0, `${label}: valid candidate must render`);
                assert.deepEqual(await page.locator('.gallery-card').evaluateAll(cards => cards.map(card => card.id)),
                    items.map(item => `moment-${item.id}`), `${label}: exact ordered visible manifest`);
                for (const item of items) {
                    const card = page.locator(`[id="moment-${item.id}"]`);
                    assert.equal(await card.locator('.gallery-card-image').getAttribute('src'), item.thumbnailUrl);
                    assert.equal(await card.locator('.gallery-card-image').getAttribute('alt'), item.alt);
                    assert.equal(await card.locator('.gallery-card-image').getAttribute('referrerpolicy'), 'no-referrer');
                    if (item.type !== 'photo') continue;
                    assert.equal(await card.locator('h3').innerText(), item.raceEvent);
                    const expected = index.forPhoto(item);
                    await assertPhotoReviewDetails(card, item, expected, utilityContext.window.dateDisplay.format,
                        `${label}/${item.id}/card`);
                    assert.equal(await card.locator('.gallery-card-image').evaluate(image => getComputedStyle(image).objectFit), 'contain');
                    await card.locator('.gallery-card-open').click();
                    await page.locator('#gallery-viewer[open]').waitFor({ state: 'visible' });
                    assert.equal(await page.locator('#gallery-viewer-title').innerText(), item.raceEvent);
                    assert.equal(await page.locator('#gallery-viewer-media img').getAttribute('src'), item.sourceUrl);
                    await assertPhotoReviewDetails(page.locator('#gallery-viewer-copy'), item, expected,
                        utilityContext.window.dateDisplay.format, `${label}/${item.id}/viewer`);
                    await page.keyboard.press('Escape');
                    assert.equal(await card.locator('.gallery-card-open').evaluate(button => button === document.activeElement), true,
                        `${label}: close restores focus`);
                }
                if (!items.length) {
                    assert.equal(await page.locator('.gallery-status.is-empty').count(), 1);
                    assert.equal(await page.locator('#gallery-filters').isHidden(), true);
                }
                await page.screenshot({ path: path.join(screenshots, `photo-review-${mode}-gallery-${size}.png`),
                    fullPage: true, scale: 'css' });

                for (const filename of ['index.html', 'championships.html', 'overview.html']) {
                    await open(filename);
                    if (filename !== 'overview.html') {
                        assert.ok(await page.locator('#leaderboards table').count() > 0, `${label}: exported tables remain`);
                        await assertPodiums(page, items, label);
                    }
                    await assertHighlights(page, items.filter(item => item.featured), mode, label);
                }
                for (const athleteId of profileIds) {
                    assert.match(athleteId, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
                    await open(`athlete.html?id=${encodeURIComponent(athleteId)}`);
                    await assertHighlights(page, items.filter(item => item.athleteIds.includes(athleteId)), mode,
                        `${label}/${athleteId}`);
                    assert.notEqual(await page.locator('#athlete-name').innerText(), 'Loading...');
                }
                assert.deepEqual(failures, [], `${label}: no local resource/JavaScript failures`);

                async function open(filename) {
                    requested.length = 0;
                    await page.goto(`${server.baseUrl}/${filename}${filename.includes('?') ? '&' : '?'}site=${mode}`,
                        { waitUntil: 'networkidle' });
                    assert.ok(requested.includes(`gallery-data/${mode}.json`), `${label}/${filename}: selected manifest requested`);
                    assert.ok(requested.includes('gallery-data/hidden-athlete-ids.json'), `${label}/${filename}: suppression requested`);
                    assert.ok(!requested.includes(`gallery-data/${mode === 'family' ? 'everyone' : 'family'}.json`),
                        `${label}/${filename}: no other-mode manifest`);
                    await assertPageLayout(page, mode, options.viewport.width, `${label}/${filename}`);
                }
            } finally { await context.close(); }
        }
    }
    console.log(`Photo-only actual-candidate browser checks passed: both modes, desktop/mobile, Gallery/viewer, exact exported details, ` +
        `both championship URLs/podium selection, Overview/athlete highlights and four responsive screenshots; ${Date.now() - started} ms. ` +
        'All external media requests were blocked; no real-media pixel/delivery proof is claimed.');
} finally {
    await browser?.close();
    await server.close();
}

async function assertPageLayout(page, mode, width, label) {
    const geometry = await page.evaluate(() => ({ width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
        viewport: document.querySelector('meta[name="viewport"]')?.content }));
    assert.equal(geometry.width, width, `${label}: mobile viewport must be honoured`);
    assert.equal(geometry.overflow, false, `${label}: no horizontal overflow`);
    assert.match(geometry.viewport, /width=device-width/);
    const links = await page.locator('.site-nav a').evaluateAll(anchors => anchors.map(anchor => anchor.href));
    assert.ok(links.length > 0, `${label}: primary navigation exists`);
    for (const href of links) assert.equal(new URL(href).searchParams.get('site'), mode, `${label}: navigation preserves mode`);
}

async function assertHighlights(page, candidates, mode, label) {
    const sections = page.locator('[data-gallery-highlights]');
    assert.ok(await sections.count() > 0, `${label}: highlight surface exists`);
    for (let at = 0; at < await sections.count(); at++) {
        const section = sections.nth(at);
        const limit = Number(await section.getAttribute('data-gallery-limit')) || 3;
        const expected = candidates.slice(0, limit);
        const hrefs = await section.locator('.race-moment-card').evaluateAll(links => links.map(link => link.href));
        assert.deepEqual(hrefs.map(href => decodeURIComponent(new URL(href).hash)), expected.map(item => `#moment-${item.id}`),
            `${label}: exact highlight selection/order`);
        assert.equal(await section.isHidden(), expected.length === 0);
        for (const href of hrefs) assert.equal(new URL(href).searchParams.get('site'), mode);
    }
}

async function assertPodiums(page, items, label) {
    const pictures = await page.locator('[data-gallery-athlete-photo]').evaluateAll(elements => elements.map(element => ({
        athlete: element.dataset.galleryAthletePhoto, id: element.dataset.galleryMediaId,
        src: element.querySelector('img')?.getAttribute('src'),
        referrer: element.querySelector('img')?.getAttribute('referrerpolicy')
    })));
    assert.ok(pictures.length > 0, `${label}: exported podium slots exist`);
    for (const picture of pictures) {
        const candidates = items.filter(item => item.athleteIds.includes(picture.athlete));
        const selected = candidates.find(item => item.type === 'photo') || candidates[0];
        assert.equal(picture.id, selected?.id, `${label}/${picture.athlete}: first eligible photo only`);
        if (selected) {
            assert.ok([selected.sourceUrl, selected.thumbnailUrl].includes(picture.src), `${label}: only selected public derivative`);
            assert.equal(picture.referrer, 'no-referrer');
        } else assert.equal(picture.src, undefined, `${label}: no eligible photo means no media element`);
    }
}
