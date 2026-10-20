import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createStaticServer } from '../scripts/serve-site.mjs';
import { findChromiumExecutable, loadPlaywright } from '../scripts/browser-runtime.mjs';

// These are generated diagrams, not photographs or face detection. Colour is
// deliberately checked in the rendered screenshot, not merely in CSS values.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const screenshots = path.join(root, 'test-artifacts', 'screenshots');
const mediaOrigin = 'https://media.example.com';
const areas = ['family', 'everyone'];
const dimensions = [
    ['wide', 1200, 300], ['landscape', 600, 400],
    ['portrait', 360, 540], ['tall', 240, 960]
];
const groupAthletes = ['carolyn-kevan', 'david-graham-kevan', 'gareth-devine', 'mariia-bulycheva'];
const faces = new Map([
    ['carolyn-kevan', { x: 0.12, y: 0.18, zoom: 2, colour: [255, 30, 50] }],
    ['david-graham-kevan', { x: 0.88, y: 0.18, zoom: 2, colour: [0, 240, 255] }],
    ['gareth-devine', { x: 0.12, y: 0.18, zoom: 2, colour: [255, 30, 50] }],
    ['mariia-bulycheva', { x: 0.88, y: 0.18, zoom: 2, colour: [0, 240, 255] }],
    ['john-kevan', { x: 0.5, y: 0.07, zoom: 1.6, colour: [255, 30, 220] }]
]);
const groupItem = photo('synthetic-group', groupAthletes, true);
const portraitItem = photo('synthetic-top-face', ['john-kevan'], false);
// A valid later entry must not be selected merely because framing exists for it.
const laterItem = photo('synthetic-later-unselected', [...groupAthletes, 'john-kevan'], false);
const manifest = { schemaVersion: '1.0', items: [groupItem, portraitItem, laterItem] };
const suppression = { schemaVersion: '1.0', hiddenAthleteIds: [] };
const frames = Object.fromEntries([...faces].map(([athleteId, frame]) => [
    cropKey(athleteId === 'john-kevan' ? portraitItem : groupItem, athleteId),
    { x: frame.x * 100, y: frame.y * 100, zoom: frame.zoom }
]));
frames[cropKey(laterItem, 'carolyn-kevan')] = { x: 50, y: 50, zoom: 4 };
frames[cropKey(photo('synthetic-not-in-manifest', ['invented-athlete'], false), 'invented-athlete')] =
    { x: 50, y: 50, zoom: 4 };
const framing = { schemaVersion: '1.0', frames };
const { chromium } = loadPlaywright();
const server = await createStaticServer({ root, port: 0, silent: true });
let browser;

try {
    await fs.mkdir(screenshots, { recursive: true });
    browser = await chromium.launch({ headless: true, executablePath: findChromiumExecutable(),
        args: ['--disable-dev-shm-usage'] });

    for (const area of areas) {
        for (const mobile of [false, true]) {
            for (const [shape, width, height] of dimensions) {
                await withFixture({ area, mobile, width, height }, async ({ page, requests }) => {
                    await openChampionship(page, area);
                    const before = await standingsSnapshot(page);
                    await assertAllVisiblePhotos(page, width, height, `${area}/${mobile}/${shape}`);
                    await assertCompactAndRanked(page, area, mobile);
                    assert.ok(requests.every(url => !url.includes(laterItem.id)), 'later framed photo must not override first approved photo');
                    assert.ok(requests.every(url => !url.includes('synthetic-not-in-manifest')), 'orphan crop key cannot introduce media');
                    assert.equal(await page.locator('[data-gallery-athlete-photo="invented-athlete"]').count(), 0,
                        'orphan crop key cannot introduce an athlete');

                    if (shape === 'wide') {
                        await page.locator('.championship-podium').first().screenshot({
                            path: path.join(screenshots, `championship-face-framing-${area}-${mobile ? 'mobile' : 'desktop'}.png`),
                            scale: 'css'
                        });
                        // Recalculate an already rendered podium when its width changes,
                        // including crossing the mobile breakpoint in either direction.
                        await page.setViewportSize({ width: mobile ? 760 : 390, height: 900 });
                        await assertAllVisiblePhotos(page, width, height, `${area}/resized`);
                        assert.deepEqual(await standingsSnapshot(page), before, 'resize must not alter exported standings');
                        await openPreviouslyCollapsedDistance(page, area);
                        await assertAllVisiblePhotos(page, width, height, `${area}/new-distance`);
                        await assertCompactAndRanked(page, area, true);
                    }
                });
            }

            await assertOptionalFramingFailures(area, mobile);
            await assertSuppressionPrecedesFraming(area, mobile);
            await assertUnrelatedSurfacesUnchanged(area, mobile);
            await assertFailedImageStaysCompact(area, mobile);
            await assertFramingResponseTiming(area, mobile);
            await assertChampionshipAlias(area, mobile);
            await assertFreshReviewedFraming(area, mobile);
        }
    }

    console.log('Championship photo framing browser checks passed: per-person pixels, four shapes, both areas, desktop/mobile, resize/lazy sections, safe fallback and suppression.');
} finally {
    await browser?.close();
    await server.close();
}

function photo(id, athleteIds, featured) {
    return {
        id, type: 'photo', title: `Synthetic framing ${id}`, caption: '',
        alt: 'A deliberately synthetic photograph diagram with coloured face circles near the image edges. '.repeat(3).trim(),
        raceDate: '2026-08-22', raceEvent: 'Synthetic framing fixture', raceDistance: '5 km',
        sourceUrl: `${mediaOrigin}/full/${id}.svg`, thumbnailUrl: `${mediaOrigin}/thumb/${id}.svg`,
        featured, athleteIds
    };
}

function cropKey(item, athleteId) {
    return createHash('sha256').update(JSON.stringify([
        'gallery-podium-framing-v1', item.id, athleteId, item.sourceUrl, item.thumbnailUrl
    ]), 'utf8').digest('hex');
}

function diagram(width, height, topFace) {
    const radius = Math.min(width, height) * 0.035;
    const circles = topFace
        ? `<circle cx="${width * 0.5}" cy="${height * 0.07}" r="${radius}" fill="rgb(255,30,220)"/>`
        : `<circle cx="${width * 0.12}" cy="${height * 0.18}" r="${radius}" fill="rgb(255,30,50)"/>
           <circle cx="${width * 0.88}" cy="${height * 0.18}" r="${radius}" fill="rgb(0,240,255)"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
        <rect width="${width}" height="${height}" fill="#28604c"/>
        <rect x="1" y="1" width="${width - 2}" height="${height - 2}" fill="none" stroke="#ffd700" stroke-width="2"/>
        ${circles}</svg>`;
}

async function withFixture(options, callback) {
    const { area, mobile, width = 1200, height = 300 } = options;
    const context = await browser.newContext(mobile
        ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
        : { viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const requests = [];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === server.baseUrl) {
            if (url.pathname.startsWith('/gallery-data/')) {
                const name = path.posix.basename(url.pathname);
                assert.ok([`${area}.json`, 'hidden-athlete-ids.json'].includes(name), `${area} must not load another area's manifest`);
                return route.fulfill({ contentType: 'application/json', body: JSON.stringify(
                    name === 'hidden-athlete-ids.json' ? options.suppression ?? suppression : options.manifest ?? manifest) });
            }
            if (url.pathname === '/gallery-podium-framing.json') {
                if (options.framingDelay) await new Promise(resolve => setTimeout(resolve, options.framingDelay));
                if (options.framingStatus) return route.fulfill({ status: options.framingStatus, body: 'Unavailable' });
                return route.fulfill({ contentType: 'application/json', body:
                    options.framingBody ?? JSON.stringify(options.framing ?? framing) });
            }
            return route.continue();
        }
        if (url.origin === mediaOrigin) {
            requests.push(url.href);
            const item = (options.manifest ?? manifest).items.find(candidate =>
                candidate.sourceUrl === url.href || candidate.thumbnailUrl === url.href);
            assert.ok(item, `no unapproved external media request: ${url.href}`);
            if (options.failImages) return route.abort();
            return route.fulfill({ contentType: 'image/svg+xml', body: diagram(width, height, item.id === portraitItem.id) });
        }
        return route.abort();
    });
    try {
        await callback({ page, requests });
        assert.deepEqual(errors, [], `${area}: no uncaught browser errors`);
    } finally {
        await context.close();
    }
}

async function openChampionship(page, area, entry = 'index.html') {
    await page.goto(`${server.baseUrl}/${entry}?site=${area}`, { waitUntil: 'networkidle' });
    await page.locator('.championship-podium').first().waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelectorAll('#leaderboards table tbody tr').length >= 3);
}

async function nextLayout(page) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function assertAllVisiblePhotos(page, width, height, label) {
    const frames = page.locator('.championship-podium-media.has-gallery-media:visible');
    assert.ok(await frames.count() >= 3, `${label}: expected photo-backed podium`);
    for (let index = 0; index < await frames.count(); index += 1) {
        const container = frames.nth(index);
        const athleteId = await container.getAttribute('data-gallery-athlete-photo');
        const point = faces.get(athleteId);
        if (!point) continue;
        const item = athleteId === 'john-kevan' ? portraitItem : groupItem;
        assert.equal(await container.getAttribute('data-gallery-media-id'), item.id, `${label}/${athleteId}: first eligible photo`);
        const image = container.locator('img');
        await image.scrollIntoViewIfNeeded();
        await image.evaluate(img => img.decode());
        await nextLayout(page);
        assert.equal(await image.getAttribute('src'), item.sourceUrl, `${label}/${athleteId}: configured crop uses the approved detailed derivative`);
        const actual = await imageGeometry(container);
        const scale = Math.max(actual.frameWidth / width, actual.frameHeight / height) * point.zoom;
        const wanted = {
            width: width * scale, height: height * scale,
            left: Math.min(0, Math.max(actual.frameWidth - width * scale, actual.frameWidth / 2 - point.x * width * scale)),
            top: Math.min(0, Math.max(actual.frameHeight - height * scale, actual.frameHeight / 2 - point.y * height * scale))
        };
        for (const property of ['width', 'height', 'left', 'top']) {
            assert.ok(Math.abs(actual[property] - wanted[property]) < 1.2,
                `${label}/${athleteId}: ${property} expected ${wanted[property]}, got ${actual[property]}`);
        }
        assert.ok(actual.left <= 0.6 && actual.top <= 0.6 &&
            actual.left + actual.width >= actual.frameWidth - 0.6 &&
            actual.top + actual.height >= actual.frameHeight - 0.6, `${label}/${athleteId}: no exposed empty image edges`);
        const faceX = actual.left + point.x * actual.width;
        const faceY = actual.top + point.y * actual.height;
        assert.ok(faceX >= 0 && faceX < actual.frameWidth && faceY >= 0 && faceY < actual.frameHeight,
            `${label}/${athleteId}: face remains visible even with edge clamping`);
        const rendered = await sharp(await container.screenshot({ scale: 'css', animations: 'disabled' })).removeAlpha().raw()
            .toBuffer({ resolveWithObject: true });
        const pixelX = Math.min(rendered.info.width - 1, Math.max(0, Math.round(faceX)));
        const pixelY = Math.min(rendered.info.height - 1, Math.max(0, Math.round(faceY)));
        const offset = (pixelY * rendered.info.width + pixelX) * rendered.info.channels;
        assert.ok(point.colour.every((channel, channelIndex) => Math.abs(rendered.data[offset + channelIndex] - channel) <= 18),
            `${label}/${athleteId}: rendered face pixel must match the selected person, not the other group member`);
    }
}

async function imageGeometry(container) {
    return container.evaluate(frame => {
        const image = frame.querySelector('img');
        const bounds = frame.getBoundingClientRect();
        const rect = image.getBoundingClientRect();
        const style = getComputedStyle(image);
        let width = rect.width, height = rect.height;
        if (['contain', 'cover'].includes(style.objectFit)) {
            const scale = (style.objectFit === 'contain' ? Math.min : Math.max)(
                rect.width / image.naturalWidth, rect.height / image.naturalHeight);
            width = image.naturalWidth * scale;
            height = image.naturalHeight * scale;
        }
        const positions = style.objectPosition.split(/\s+/);
        const coordinate = (value, available) => value?.endsWith('%') ? parseFloat(value) * available / 100 : parseFloat(value) || 0;
        return {
            width, height,
            left: rect.left - bounds.left + coordinate(positions[0], rect.width - width),
            top: rect.top - bounds.top + coordinate(positions[1] ?? positions[0], rect.height - height),
            frameWidth: frame.clientWidth, frameHeight: frame.clientHeight,
            fit: style.objectFit, transform: style.transform
        };
    });
}

async function standingsSnapshot(page) {
    return page.locator('#leaderboards .leaderboard-section').evaluateAll(sections => sections.map(section => ({
        title: section.querySelector('h4')?.textContent,
        table: section.querySelector('table')?.textContent.replace(/\s+/g, ' ').trim(),
        podium: [...section.querySelectorAll('.championship-podium-card')].map(card => ({
            rank: card.dataset.rank,
            person: card.querySelector('h5')?.textContent,
            medal: card.querySelector('.championship-podium-medal')?.textContent.trim()
        }))
    })));
}

async function assertCompactAndRanked(page, area, compact) {
    const rows = await page.locator('.championship-podium:visible').evaluateAll(podiums => podiums.map(podium => {
        const section = podium.closest('.leaderboard-section');
        const table = section.querySelector(':scope > table');
        const headerNames = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
        const participantIndex = headerNames.indexOf('Participant');
        const rankIndex = headerNames.indexOf('Rank');
        const leaders = [...table.querySelectorAll('tbody tr')].filter(row => row.querySelector('.medal')).slice(0, 3);
        return {
            columns: getComputedStyle(podium).gridTemplateColumns.trim().split(/\s+/).length,
            height: podium.getBoundingClientRect().height,
            beforeTable: Boolean(podium.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING),
            table: leaders.map(row => ({
                name: row.cells[participantIndex]?.textContent.trim(),
                rank: ({ '🥇': '1', '🥈': '2', '🥉': '3' })[row.cells[rankIndex]?.textContent.trim()],
                medal: row.querySelector('.medal')?.textContent.trim()
            })),
            cards: [...podium.querySelectorAll('.championship-podium-card')].map(card => ({
                name: card.querySelector('h5')?.textContent.trim(), rank: card.dataset.rank,
                medal: card.querySelector('.championship-podium-medal')?.textContent.trim(),
                href: card.querySelector('h5 a')?.getAttribute('href')
            }))
        };
    }));
    for (const row of rows) {
        assert.ok(row.cards.length >= 1 && row.cards.length <= 3, 'podium contains only its exported ranked leaders');
        assert.equal(row.columns, row.cards.length,
            'three exported leaders retain three columns; genuine one/two-leader tables retain their deliberate smaller podium');
        if (compact && (await page.viewportSize()).width <= 700) assert.ok(row.height <= 280, 'mobile podium remains below 280px');
        assert.equal(row.beforeTable, true, 'complete exported table remains below podium');
        assert.deepEqual(row.cards.map(({ href, ...card }) => card), row.table, 'people, ranks and medals match the exported table exactly');
        assert.ok(row.cards.every(card => card.href?.includes(`site=${area}`)), 'athlete links preserve selected mode');
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal overflow');
}

async function openPreviouslyCollapsedDistance(page, area) {
    const toggles = page.locator('.distance-toggle');
    for (let index = 0; index < await toggles.count(); index += 1) {
        const toggle = toggles.nth(index);
        if (!(await toggle.textContent()).includes('[+]') || (await toggle.textContent()).includes('Overall')) continue;
        await toggle.click();
        const content = page.locator('.distance-content').nth(index);
        await content.locator('table').first().waitFor({ state: 'visible' });
        const titles = await content.locator(':scope > .leaderboard-section h4').allTextContents();
        assert.equal(titles.length, 2, 'new distance preserves both exported sections');
        assert.match(titles[0], /^Current /);
        assert.match(titles[1], /^All Time /);
        await nextLayout(page);
        await assertCompactAndRanked(page, area, true);
        await toggle.click();
        await toggle.click();
        await content.locator('table').first().waitFor({ state: 'visible' });
        await nextLayout(page);
        return;
    }
    assert.fail('fixture must exercise a newly opened distance');
}

async function assertContainFallback(page, label) {
    const frames = page.locator('.championship-podium-media.has-gallery-media:visible');
    assert.ok(await frames.count() >= 3, `${label}: photo must remain visible`);
    for (let index = 0; index < await frames.count(); index += 1) {
        const frame = frames.nth(index);
        const id = await frame.getAttribute('data-gallery-media-id');
        const item = manifest.items.find(candidate => candidate.id === id);
        const image = frame.locator('img');
        await image.scrollIntoViewIfNeeded();
        await image.evaluate(img => img.decode());
        assert.equal(await image.getAttribute('src'), item.thumbnailUrl, `${label}: fall back to existing thumbnail`);
        const geometry = await imageGeometry(frame);
        assert.equal(geometry.fit, 'contain', `${label}: no arbitrary centre crop`);
        assert.equal(geometry.transform, 'none', `${label}: no zoom`);
        assert.ok(geometry.width <= geometry.frameWidth + 0.5 && geometry.height <= geometry.frameHeight + 0.5,
            `${label}: entire unconfigured photograph remains inside the compact frame`);
    }
}

async function assertOptionalFramingFailures(area, mobile) {
    const invalid = [
        ['missing', { framingStatus: 404 }],
        ['malformed-json', { framingBody: '{' }],
        ['wrong-schema', { framing: { schemaVersion: '2.0', frames } }],
        ['invalid-coordinate', { framing: { schemaVersion: '1.0', frames: { ...frames, [cropKey(groupItem, 'carolyn-kevan')]: { x: 150, y: 10, zoom: 2 } } } }],
        ['empty', { framing: { schemaVersion: '1.0', frames: {} } }]
    ];
    for (const [name, options] of invalid) {
        await withFixture({ area, mobile, ...options }, async ({ page }) => {
            await openChampionship(page, area);
            await assertContainFallback(page, `${area}/${name}`);
            await assertCompactAndRanked(page, area, mobile);
        });
    }
    // A checksum for different media URLs is stale, not permission to frame the
    // selected item or to switch to the other photo.
    const staleItem = { ...groupItem, sourceUrl: `${mediaOrigin}/full/old-generation.svg` };
    await withFixture({ area, mobile, framing: { schemaVersion: '1.0', frames: {
        [cropKey(staleItem, 'carolyn-kevan')]: { x: 12, y: 18, zoom: 2 },
        [cropKey(laterItem, 'carolyn-kevan')]: { x: 50, y: 50, zoom: 4 }
    } } }, async ({ page, requests }) => {
        await openChampionship(page, area);
        await assertContainFallback(page, `${area}/stale-and-orphan`);
        assert.ok(requests.every(url => !url.includes('old-generation') && !url.includes(laterItem.id)), 'stale hashes cannot request media');
    });
}

async function assertSuppressionPrecedesFraming(area, mobile) {
    // Hide one person in a multi-person item: every use of that whole photo is
    // suppressed, including another athlete's otherwise valid crop.
    const groupOnly = { schemaVersion: '1.0', items: [groupItem] };
    for (const [name, hidden] of [
        ['tagged-hidden', { schemaVersion: '1.0', hiddenAthleteIds: ['david-graham-kevan'] }],
        ['malformed-suppression', { schemaVersion: '1.0', hiddenAthleteIds: 'not-an-array' }]
    ]) {
        await withFixture({ area, mobile, manifest: groupOnly, suppression: hidden }, async ({ page, requests }) => {
            await openChampionship(page, area);
            assert.equal(await page.locator('.championship-podium-media img').count(), 0, `${name}: no podium media elements`);
            assert.equal(await page.locator('.race-moment-card').count(), 0, `${name}: no featured media elements`);
            assert.deepEqual(requests, [], `${name}: suppression precedes every external media request`);
            await assertCompactAndRanked(page, area, mobile);
        });
    }
}

async function assertUnrelatedSurfacesUnchanged(area, mobile) {
    await withFixture({ area, mobile }, async ({ page }) => {
        await openChampionship(page, area);
        const highlight = page.locator('.race-moment-card img').first();
        await highlight.scrollIntoViewIfNeeded();
        await highlight.evaluate(img => img.decode());
        assert.equal(await highlight.getAttribute('src'), groupItem.thumbnailUrl, 'Race moments retain thumbnail, not podium crop source');
        assert.equal(await highlight.getAttribute('style'), null, 'podium positioning must not leak to featured moments');
        assert.equal(await highlight.evaluate(img => getComputedStyle(img).objectFit), 'cover', 'existing highlight presentation remains unchanged');
        await page.goto(`${server.baseUrl}/gallery.html?site=${area}`, { waitUntil: 'networkidle' });
        await page.locator('.gallery-card').first().waitFor({ state: 'visible' });
        const gridImage = page.locator(`#moment-${groupItem.id} .gallery-card-image`);
        await gridImage.evaluate(img => img.decode());
        assert.equal(await gridImage.getAttribute('src'), groupItem.thumbnailUrl);
        assert.equal(await gridImage.evaluate(img => getComputedStyle(img).objectFit), 'contain', 'Gallery still shows whole photographs');
        assert.equal(await gridImage.getAttribute('style'), null, 'no podium-only crop in Gallery');
        await page.locator(`#moment-${groupItem.id} .gallery-card-open`).click();
        const viewer = page.locator('#gallery-viewer-media img');
        await viewer.evaluate(img => img.decode());
        assert.equal(await viewer.getAttribute('src'), groupItem.sourceUrl);
        assert.equal(await viewer.getAttribute('style'), null, 'full viewer is not podium-framed');
        const viewerGeometry = await viewer.evaluate(img => ({
            width: img.getBoundingClientRect().width, height: img.getBoundingClientRect().height,
            naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
            transform: getComputedStyle(img).transform
        }));
        assert.equal(viewerGeometry.transform, 'none', 'full viewer has no podium zoom or translation');
        assert.ok(Math.abs(viewerGeometry.width / viewerGeometry.height -
            viewerGeometry.naturalWidth / viewerGeometry.naturalHeight) < 0.01,
        'existing intrinsic-size full viewer retains the whole photograph and its aspect ratio');
        await page.getByRole('button', { name: 'Close gallery viewer' }).click();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    });
}

async function assertFailedImageStaysCompact(area, mobile) {
    await withFixture({ area, mobile, failImages: true }, async ({ page }) => {
        await openChampionship(page, area);
        const image = page.locator('.championship-podium-media.has-gallery-media img:visible').first();
        await image.scrollIntoViewIfNeeded();
        await image.evaluate(img => img.complete ? undefined : new Promise(resolve => {
            img.addEventListener('error', resolve, { once: true });
            img.addEventListener('load', resolve, { once: true });
        }));
        assert.equal(await image.evaluate(img => img.naturalWidth), 0, 'fixture actually fails image loading');
        assert.equal(await image.getAttribute('alt'), groupItem.alt, 'accessible alternative survives unavailable photo');
        await assertCompactAndRanked(page, area, mobile);
    });
}

async function assertFramingResponseTiming(area, mobile) {
    // CSV rendering can finish before this optional fetch. An early initials or
    // thumbnail decoration must not memoize an unframed item and lose the saved
    // crop when the valid framing response arrives a moment later.
    await withFixture({ area, mobile, framingDelay: 200 }, async ({ page }) => {
        await openChampionship(page, area);
        await assertAllVisiblePhotos(page, 1200, 300, `${area}/delayed-framing`);
        await assertCompactAndRanked(page, area, mobile);
    });
    // The optional presentation request has a bounded 2.5-second budget. A
    // slower response keeps whole photographs and must not block standings or
    // revive a crop after that deadline has already selected safe fallback.
    await withFixture({ area, mobile, framingDelay: 2800 }, async ({ page }) => {
        await openChampionship(page, area);
        await assertContainFallback(page, `${area}/framing-timeout`);
        await assertCompactAndRanked(page, area, mobile);
        await page.waitForTimeout(350);
        await assertContainFallback(page, `${area}/no-late-framing-revival`);
    });
}

async function assertChampionshipAlias(area, mobile) {
    // Both established championship entry points serve the same standings.
    // Loading the helper on the landing page alone would leave older bookmarks
    // and their podium photographs with different presentation.
    await withFixture({ area, mobile }, async ({ page }) => {
        await openChampionship(page, area, 'championships.html');
        assert.equal(new URL(page.url()).searchParams.get('site'), area);
        await assertAllVisiblePhotos(page, 1200, 300, `${area}/championships-alias`);
        await assertCompactAndRanked(page, area, mobile);
    });
}

async function assertFreshReviewedFraming(area, mobile) {
    const reviewed = { schemaVersion: '1.0', items: manifest.items.map(item => {
        if (item.id === laterItem.id) return item;
        return { ...item, podiumFraming: Object.fromEntries(item.athleteIds.map(id => {
            const selected = faces.get(id);
            return [id, { x: selected.x * 100, y: selected.y * 100, zoom: selected.zoom }];
        })) };
    }) };
    const conflicting = { schemaVersion: '1.0', frames: Object.fromEntries(
        Object.keys(frames).map(key => [key, { x: 50, y: 80, zoom: 1 }])) };
    for (const optional of [{ framing: conflicting }, { framingStatus: 404 }]) {
        await withFixture({ area, mobile, manifest: reviewed, ...optional }, async ({ page }) => {
            await openChampionship(page, area);
            await assertAllVisiblePhotos(page, 1200, 300, `${area}/fresh-reviewed-framing`);
            await assertCompactAndRanked(page, area, mobile);
        });
    }
    await withFixture({ area, mobile, manifest: reviewed,
        suppression: { schemaVersion: '1.0', hiddenAthleteIds: [groupAthletes[0]] } }, async ({ page, requests }) => {
        await openChampionship(page, area);
        assert.equal(await page.locator(`.championship-podium-media[data-gallery-media-id="${groupItem.id}"]`).count(), 0,
            'reviewed framing cannot bypass suppression of any person in the whole group');
        assert.ok(requests.every(url => !url.includes(groupItem.id)), 'no suppressed reviewed image bytes requested');
    });
    const invalid = { ...reviewed, items: reviewed.items.map(item => item.id === groupItem.id
        ? { ...item, podiumFraming: { 'person-not-a-public-tag': { x: 12, y: 18, zoom: 2 } } } : item) };
    await withFixture({ area, mobile, manifest: invalid }, async ({ page, requests }) => {
        await openChampionship(page, area);
        assert.equal(await page.locator('.championship-podium-media img').count(), 0,
            'invalid private/unmapped framing rejects the complete Gallery document before rendering');
        assert.deepEqual(requests, [], 'legacy settings cannot rescue an invalid framed manifest');
    });
}
