import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticServer } from '../scripts/serve-site.mjs';
import { findChromiumExecutable, loadPlaywright } from '../scripts/browser-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, 'test-artifacts', 'screenshots');
const shapes = [
    ['portrait', 360, 480],
    ['landscape', 480, 320],
    ['square', 480, 480],
    ['wide-group', 960, 240]
];
const fixtures = new Map(shapes.map(([name, width, height]) => [name,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect width="${width}" height="${height}" fill="#246080"/>
      <rect x="3" y="3" width="${width - 6}" height="${height - 6}" fill="none" stroke="#ffd700" stroke-width="6"/>
      ${[0.12, 0.5, 0.88].map(x => `<circle cx="${width * x}" cy="${height * 0.16}" r="${Math.min(width, height) * 0.07}" fill="#ffffff"/>`).join('')}
      <text x="50%" y="55%" text-anchor="middle" fill="white" font-size="24">${name}</text>
    </svg>`
]));
const manifest = { schemaVersion: '1.0', items: shapes.map(([name]) => ({
    id: `whole-photo-${name}`, type: 'photo', title: `Whole photo: ${name}`,
    caption: '', alt: `Synthetic ${name} frame with three circles near the top`,
    raceDate: '2026-08-22', raceEvent: 'Synthetic layout test', raceDistance: '5 km',
    sourceUrl: `https://media.example.com/${name}.svg`,
    thumbnailUrl: `https://media.example.com/${name}.svg`,
    featured: false, athleteIds: []
})) };

const { chromium } = loadPlaywright();
const server = await createStaticServer({ root, port: 0, silent: true });
let browser;
try {
    await fs.mkdir(artifacts, { recursive: true });
    browser = await chromium.launch({ headless: true, executablePath: findChromiumExecutable(),
        args: ['--disable-dev-shm-usage'] });
    for (const site of ['family', 'everyone']) {
        for (const mobile of [false, true]) {
            const device = mobile ? 'mobile' : 'desktop';
            const context = await browser.newContext(mobile
                ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }
                : { viewport: { width: 1440, height: 900 } });
            try {
                const page = await context.newPage();
                await page.route('**/gallery-data/*.json', route => {
                    const file = new URL(route.request().url()).pathname.split('/').pop();
                    assert.ok([`${site}.json`, 'hidden-athlete-ids.json'].includes(file), 'must not load the other area');
                    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(
                        file === 'hidden-athlete-ids.json'
                            ? { schemaVersion: '1.0', hiddenAthleteIds: [] } : manifest) });
                });
                await page.route('https://media.example.com/**', route => {
                    const name = path.basename(new URL(route.request().url()).pathname, '.svg');
                    return route.fulfill({ contentType: 'image/svg+xml', body: fixtures.get(name) });
                });
                await page.goto(`${server.baseUrl}/gallery.html?site=${site}`);
                await page.locator('.gallery-card').last().waitFor({ state: 'visible' });
                assert.equal(await page.locator('.gallery-card').count(), shapes.length);
                for (const [name, width, height] of shapes) {
                    const photo = page.locator(`#moment-whole-photo-${name} .gallery-card-image`);
                    await photo.scrollIntoViewIfNeeded();
                    await photo.evaluate(img => img.decode());
                    for (const hovered of [false, true]) {
                        if (hovered) await photo.hover();
                        const geometry = await photo.evaluate(img => {
                            const css = getComputedStyle(img), frame = img.getBoundingClientRect();
                            return { fit: css.objectFit, position: css.objectPosition, transform: css.transform,
                                width: frame.width, height: frame.height, naturalWidth: img.naturalWidth,
                                naturalHeight: img.naturalHeight };
                        });
                        const label = `${site}/${device}/${name}/${hovered ? 'hover' : 'rest'}`;
                        assert.equal(geometry.fit, 'contain', `${label}: preserve the whole photo`);
                        assert.equal(geometry.position, '50% 50%', `${label}: centre the complete image`);
                        assert.equal(geometry.transform, 'none', `${label}: no zoom clipping`);
                        assert.equal(geometry.naturalWidth, width, label);
                        assert.equal(geometry.naturalHeight, height, label);
                        const scale = Math.min(geometry.width / width, geometry.height / height);
                        assert.ok(width * scale <= geometry.width + 0.01 && height * scale <= geometry.height + 0.01, label);
                    }
                }
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
                await page.screenshot({ path: path.join(artifacts, `gallery-whole-photo-${site}-${device}.png`),
                    fullPage: true, scale: 'css' });
            } finally {
                await context.close();
            }
        }
    }
    console.log('Gallery whole-photo thumbnails passed: four shapes, both areas, desktop/mobile, rest/hover.');
} finally {
    await browser?.close();
    await server.close();
}
