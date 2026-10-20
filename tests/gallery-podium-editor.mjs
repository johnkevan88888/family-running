import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { findChromiumExecutable, loadPlaywright } from '../scripts/browser-runtime.mjs';
import sharp from 'sharp';
import { startGalleryPodiumEditor } from '../scripts/gallery-podium-editor.mjs';

const require = createRequire(import.meta.url);
const framing = require('../gallery-podium-framing.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = path.join(root, 'test-artifacts');
await mkdir(artifactRoot, { recursive: true });
const fixture = await mkdtemp(path.join(artifactRoot, 'gallery-podium-editor-'));
await mkdir(path.join(fixture, 'gallery-data'));
const photo = {
    id: 'synthetic-finish', type: 'photo', title: 'Synthetic finish', caption: '',
    alt: 'Fictional runner for local testing only', raceDate: '2026-08-22', raceEvent: 'Fictional 5 km', raceDistance: '5 km',
    sourceUrl: 'https://media.example.test/approved/synthetic-display.webp',
    thumbnailUrl: 'https://media.example.test/approved/synthetic-thumbnail.webp',
    featured: false, athleteIds: ['fictional-runner', 'fictional-friend']
};
const suppressedPhoto = { ...photo, id: 'synthetic-suppressed', sourceUrl: 'https://media.example.test/never/suppressed.webp', athleteIds: ['hidden-runner', 'fictional-runner'] };
const video = { ...photo, id: 'synthetic-video', type: 'video', sourceUrl: 'https://media.example.test/never/video.mp4' };
const manifest = { schemaVersion: '1.0', items: [photo, suppressedPhoto, video] };
const everyonePhoto = { ...photo, id: 'synthetic-everyone', athleteIds: ['everyone-runner'] };
const suppression = { schemaVersion: '1.0', hiddenAthleteIds: ['hidden-runner'] };
const unrelatedKey = 'e'.repeat(64);
const unrelatedFrame = { x: 4, y: 5, zoom: 2 };
const config = { schemaVersion: '1.0', frames: { [unrelatedKey]: unrelatedFrame } };
const configPath = path.join(fixture, 'gallery-podium-framing.json');
const familyPath = path.join(fixture, 'gallery-data', 'family.json');
const suppressionPath = path.join(fixture, 'gallery-data', 'hidden-athlete-ids.json');
async function jsonWrite(file, value) { await writeFile(file, `${JSON.stringify(value, null, 2)}\n`); }
await jsonWrite(familyPath, manifest);
await jsonWrite(path.join(fixture, 'gallery-data', 'everyone.json'), { schemaVersion: '1.0', items: [everyonePhoto] });
await jsonWrite(suppressionPath, suppression);
await jsonWrite(configPath, config);
// There is deliberately no private original, credential, Worker or GitHub fixture.
const editor = await startGalleryPodiumEditor({ root: fixture, site: 'family', port: 0 });
const url = new URL(editor.url);
const origin = url.origin;
const token = new URLSearchParams(url.hash.slice(1)).get('token');
const headers = { 'x-gallery-framing-token': token };
async function state() {
    const response = await fetch(`${origin}/state`, { headers });
    assert.equal(response.status, 200);
    return response.json();
}
async function post(value, extra = {}) {
    return fetch(`${origin}/save`, {
        method: 'POST', headers: { ...headers, origin, 'content-type': 'application/json', ...extra },
        body: typeof value === 'string' ? value : JSON.stringify(value)
    });
}
function rawRequest(route, customHeaders = {}) {
    return new Promise((resolve, reject) => {
        const request = httpRequest({ hostname: '127.0.0.1', port: url.port, path: route, headers: customHeaders }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
        });
        request.on('error', reject);
        request.end();
    });
}
let browser;
try {
    const originalFamily = await readFile(familyPath);
    const originalSuppression = await readFile(suppressionPath);
    const initial = await state();
    assert.equal(initial.site, 'family');
    assert.match(initial.revision, /^[a-f0-9]{64}$/);
    assert.equal(initial.photos.length, 1);
    assert.deepEqual(initial.photos[0].athletes.map(value => value.id), photo.athleteIds);
    assert.equal(initial.photos[0].athletes[0].frame, null);
    const key = await framing.keyFor(photo, 'fictional-runner');
    assert.equal(initial.photos[0].athletes[0].key, key);
    assert(!JSON.stringify(initial).includes('suppressed.webp'));
    assert(!JSON.stringify(initial).includes('video.mp4'));
    assert(!JSON.stringify(initial).includes('hidden-runner'));
    assert.equal((await fetch(`${origin}/state`)).status, 403);
    assert.equal((await fetch(`${origin}/state`, { headers: { ...headers, origin: 'https://attacker.example' } })).status, 403);
    assert.equal((await fetch(`${origin}/state`, { headers: { ...headers, 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await rawRequest('/state', { ...headers, host: 'attacker.example' })).status, 403);
    assert.equal((await rawRequest('http://attacker.example/state', headers)).status, 403);
    for (const route of ['/private/original.jpg', '/gallery-data/family.json', '/gallery-podium-framing.json', '/.git/config', '/editor.js?arbitrary=file']) {
        assert.equal((await fetch(`${origin}${route}`, { headers })).status, 404, route);
    }
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(page.headers.get('content-security-policy'), /img-src https:\/\/media\.example\.test/);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    const body = { revision: initial.revision, itemId: photo.id, athleteId: 'fictional-runner', frame: { x: 48.5, y: 14, zoom: 2.25 } };
    const originalConfig = await readFile(configPath, 'utf8');
    assert.equal((await post(body, { 'x-gallery-framing-token': '0'.repeat(64) })).status, 403);
    assert.equal((await post(body, { origin: 'https://attacker.example' })).status, 403);
    assert.equal((await post(body, { origin: 'null' })).status, 403);
    assert.equal((await post(body, { 'content-type': 'text/plain' })).status, 403);
    assert.equal((await fetch(`${origin}/save`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, 403);
    assert.equal((await post('a'.repeat(5000))).status, 413);
    assert.equal((await post('{broken')).status, 422);
    for (const bad of [
        { ...body, path: '../outside.json' }, { ...body, sourceUrl: 'https://attacker.example/evil' },
        { ...body, frame: { x: -1, y: 0, zoom: 1 } }, { ...body, frame: { x: 50, y: 101, zoom: 1 } },
        { ...body, frame: { x: '50', y: 50, zoom: 1 } }, { ...body, frame: { x: 50, y: 50, zoom: 0.99 } },
        { ...body, frame: { x: 50, y: 50, zoom: 8.1 } }, { ...body, frame: { x: 50, y: 50, zoom: 1, sourceUrl: 'bad' } },
        { ...body, frame: [] }, { ...body, itemId: null }, { ...body, revision: 'bad' }
    ]) assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
    assert.equal((await post({ ...body, itemId: suppressedPhoto.id })).status, 422);
    assert.equal((await post({ ...body, athleteId: 'hidden-runner' })).status, 422);
    assert.equal((await post({ ...body, itemId: video.id })).status, 422);
    assert.equal((await post({ ...body, athleteId: 'unknown-runner' })).status, 422);
    assert.equal(await readFile(configPath, 'utf8'), originalConfig, 'refused requests must not write');
    const savedResponse = await post(body);
    assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json();
    assert.equal(saved.saved, true);
    assert.notEqual(saved.revision, initial.revision);
    let stored = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(stored.frames[key], body.frame);
    assert.deepEqual(stored.frames[unrelatedKey], unrelatedFrame);
    assert.equal(Object.keys(stored.frames).length, 2);
    assert(!JSON.stringify(stored).includes(photo.id));
    assert(!JSON.stringify(stored).includes('fictional-runner'));
    assert(!JSON.stringify(stored).includes('https:'));
    assert.equal((await post(body)).status, 409, 'stale framing revision');
    const reset = await post({ ...body, revision: saved.revision, frame: null });
    assert.equal(reset.status, 200);
    stored = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(stored, config, 'reset preserves every unrelated frame');
    assert.deepEqual(await readFile(familyPath), originalFamily);
    assert.deepEqual(await readFile(suppressionPath), originalSuppression);
    const beforeSuppression = await state();
    await jsonWrite(suppressionPath, { schemaVersion: '1.0', hiddenAthleteIds: ['fictional-runner'] });
    assert.equal((await post({ ...body, revision: beforeSuppression.revision })).status, 409);
    assert.equal((await state()).photos.length, 0, 'whole group is suppressed');
    await jsonWrite(suppressionPath, suppression);
    const beforeManifest = await state();
    await jsonWrite(familyPath, { ...manifest, items: [{ ...photo, sourceUrl: 'https://media.example.test/approved/new-generation.webp' }] });
    assert.equal((await post({ ...body, revision: beforeManifest.revision })).status, 409, 'stale generation');
    await jsonWrite(familyPath, manifest);
    for (const malformedFile of [suppressionPath, familyPath, configPath]) {
        const preserved = await readFile(malformedFile);
        await writeFile(malformedFile, '{broken');
        const denied = await fetch(`${origin}/state`, { headers });
        assert.equal(denied.status, 422);
        assert(!await denied.text().then(text => text.includes(photo.sourceUrl)));
        assert.equal((await post(body)).status, 422, 'malformed fixed files also refuse a save');
        await writeFile(malformedFile, preserved);
    }
    await jsonWrite(configPath, config);
    const everyone = await startGalleryPodiumEditor({ root: fixture, site: 'everyone' });
    try {
        const otherUrl = new URL(everyone.url);
        const otherToken = new URLSearchParams(otherUrl.hash.slice(1)).get('token');
        const response = await fetch(`${otherUrl.origin}/state`, { headers: { 'x-gallery-framing-token': otherToken } });
        const value = await response.json();
        assert.equal(value.site, 'everyone');
        assert.equal(value.photos[0].id, everyonePhoto.id);
        assert.equal((await fetch(`${otherUrl.origin}/state`, { headers })).status, 403, 'tokens cannot cross editor instances');
    } finally { await everyone.close(); }
    assert.deepEqual((await readdir(fixture)).sort(), ['gallery-data', 'gallery-podium-framing.json']);
    await assert.rejects(startGalleryPodiumEditor({ root: fixture, site: '../private' }), /Site/);
    await assert.rejects(startGalleryPodiumEditor({ root: fixture, port: -1 }), /Port/);

    // A new anonymous browser context loads invented pixels only. It cannot use
    // the owner's browser session, read originals, or contact external services.
    browser = await loadPlaywright().chromium.launch({ headless: true, executablePath: findChromiumExecutable() });
    const image = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="800"><rect width="400" height="800" fill="#416a4e"/><circle cx="200" cy="120" r="55" fill="#ffd2ac"/><circle cx="180" cy="112" r="5"/><circle cx="220" cy="112" r="5"/><path d="M180 140 Q200 157 220 140" fill="none" stroke="#593c26" stroke-width="5"/><rect x="135" y="180" width="130" height="320" fill="#153d70"/></svg>')).webp().toBuffer();
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
        await jsonWrite(configPath, config);
        const context = await browser.newContext({ viewport });
        const external = [];
        const violations = [];
        try {
            await context.route('**/*', async route => {
                const requestUrl = route.request().url();
                if (requestUrl.startsWith(origin)) return route.continue();
                external.push(requestUrl);
                if (requestUrl === photo.sourceUrl) return route.fulfill({ status: 200, contentType: 'image/webp', body: image });
                return route.abort();
            });
            const page = await context.newPage();
            page.on('pageerror', error => violations.push(error.message));
            await page.goto(editor.url);
            await page.waitForFunction(() => document.getElementById('full-photo').naturalWidth === 400);
            assert.equal(await page.locator('#photo-person option').count(), 2);
            assert.match(await page.locator('#status').textContent(), /Ready: family/);
            const sourceBox = await page.locator('#full-photo').boundingBox();
            await page.locator('#full-photo').click({ position: { x: sourceBox.width * .5, y: sourceBox.height * .15 } });
            const pickedFrame = { x: Number(await page.locator('#position-x').inputValue()), y: Number(await page.locator('#position-y').inputValue()), zoom: 2.5 };
            assert(Math.abs(pickedFrame.x - 50) <= .5, 'face click horizontal coordinate survives browser pixel rounding');
            assert(Math.abs(pickedFrame.y - 15) <= .5, 'face click vertical coordinate survives browser pixel rounding');
            assert.equal(await page.locator('#save').isEnabled(), true);
            const geometry = await page.evaluate(() => [...document.querySelectorAll('.preview')].map(preview => {
                const box = preview.getBoundingClientRect();
                const image = preview.querySelector('img');
                return { box: [box.width, box.height], style: Object.fromEntries(['left', 'top', 'width', 'height'].map(name => [name, parseFloat(image.style[name])])) };
            }));
            for (const preview of geometry) {
                const expected = framing.layout(pickedFrame, 400, 800, ...preview.box);
                for (const name of Object.keys(expected)) assert(Math.abs(preview.style[name] - expected[name]) < .001, 'preview uses the shared layout without a second crop calculation');
            }
            await page.getByRole('button', { name: 'Save framing locally' }).click();
            await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Saved locally.'));
            assert.deepEqual(JSON.parse(await readFile(configPath)).frames[key], pickedFrame);
            assert.equal(await page.locator('#save').isEnabled(), false);
            await page.screenshot({ path: path.join(fixture, `editor-framed-${viewport.width}.png`), fullPage: true });
            await page.getByRole('button', { name: 'Reset to whole photo' }).click();
            assert.equal(await page.locator('#focal-marker').isHidden(), true);
            await page.getByRole('button', { name: 'Save framing locally' }).click();
            await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Saved locally.'));
            assert.deepEqual(JSON.parse(await readFile(configPath)), config);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
            await page.screenshot({ path: path.join(fixture, `editor-${viewport.width}.png`), fullPage: true });
            assert.equal(violations.length, 0, violations.join('\n'));
            assert(external.length > 0);
            assert(external.every(value => value === photo.sourceUrl), 'only the approved synthetic public derivative is loaded');
        } finally { await context.close(); }
    }
    // Malformed suppression blocks the HTML and state before any browser image.
    await writeFile(suppressionPath, '{malformed');
    const blocked = await fetch(origin);
    assert.equal(blocked.status, 422);
    assert(!await blocked.text().then(text => text.includes(photo.sourceUrl)));
    console.log('Gallery podium editor: loopback/CSRF, exact saves, stale binding, suppression, preservation and synthetic desktop/mobile controls passed.');
    console.log(`Synthetic screenshots: ${fixture}`);
} finally {
    if (browser) await browser.close();
    await editor.close();
}
