import assert from 'node:assert/strict';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { handleAdminRequest } from '../gallery-admin/src/admin-worker.js';
import { loadPlaywright, findChromiumExecutable } from '../scripts/browser-runtime.mjs';
import { syntheticBucket, digest } from './helpers/private-gallery-lifecycle-fixtures.mjs';
import { readBoundedBytes, sha256Hex } from '../gallery-admin/src/media-byte-verification.js';

const directory = new URL('../gallery-admin/migrations/', import.meta.url);
const migrations = await Promise.all((await readdir(directory)).filter(name => name.endsWith('.sql')).sort()
    .map(name => readFile(new URL(name, directory), 'utf8')));
const origin = 'https://synthetic-framing-uploader.example';
const owner = { type: 'browser', subject: 'synthetic-framing-owner' };
const photo = await sharp({ create: { width: 160, height: 240, channels: 3, background: '#287abd' } })
    .withMetadata({ orientation: 6 }).jpeg().toBuffer();
const screenshots = new URL('../test-artifacts/screenshots/', import.meta.url);
await mkdir(screenshots, { recursive: true });
const browser = await loadPlaywright().chromium.launch({ headless: true, executablePath: findChromiumExecutable() });

try {
    for (const site of ['family', 'everyone']) for (const mobile of [false, true]) {
        const db = new DatabaseSync(':memory:');
        for (const sql of migrations) db.exec(sql);
        const bucket = syntheticBucket();
        const env = { ADMIN_ORIGIN: origin, OWNER_IDENTITIES: `subject:${owner.subject}`,
            AUTOMATION_IDENTITIES: 'subject:synthetic-service', SESSION_SECRET: 'fictional-framing-browser-session-secret',
            PRIVATE_ORIGINALS: bucket, DB: { prepare(sql) { let values = []; return {
                bind(...args) { values = args; return this; },
                async first() { return db.prepare(sql).get(...values) ?? null; },
                async all() { return { success: true, results: db.prepare(sql).all(...values) }; },
                async run() { return { success: true, meta: { changes: Number(db.prepare(sql).run(...values).changes) } }; }
            }; }, async batch(statements) { db.exec('BEGIN'); try {
                const results = []; for (const statement of statements) results.push(await statement.run());
                db.exec('COMMIT'); return results;
            } catch (error) { db.exec('ROLLBACK'); throw error; } } } };
        const context = await browser.newContext(mobile
            ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
            : { viewport: { width: 1440, height: 1000 } });
        const page = await context.newPage(), errors = [], unexpected = [], posts = [];
        page.on('pageerror', error => errors.push(error.message));
        // The actual pinned detector/positive-face path is covered separately.
        // Here exercise its genuine manual fallback, leaving the real owner UI,
        // router, signed session/CSRF checks, SQL and consent service untouched.
        await page.addInitScript(() => { window.Worker = class { constructor() { throw new Error('Synthetic detector unavailable'); } }; });
        await context.route('**/*', async route => {
            const incoming = route.request(), url = new URL(incoming.url());
            if (url.origin !== origin) { unexpected.push(url.href); return route.abort(); }
            const headers = await incoming.allHeaders();
            // Chromium interception omits this network-generated header. Add it
            // only for this exact same-origin fixture, as the established private
            // library browser test does; owner-denial tests cover real rejection.
            if (headers.origin === origin) headers['sec-fetch-site'] = 'same-origin';
            const request = new Request(incoming.url(), { method: incoming.method(), headers,
                body: incoming.method() === 'GET' ? undefined : incoming.postDataBuffer() });
            if (incoming.method() === 'POST' && /\/(framing|archive-attempt)$/.test(url.pathname)) {
                posts.push({ path: url.pathname, site: url.searchParams.get('site'), body: incoming.postDataJSON(),
                    csrf: Boolean(headers['x-csrf-token']), session: Boolean(headers.cookie), origin: headers.origin });
            }
            const response = await handleAdminRequest(request, env, { verifyAccessIdentity: async () => owner,
                digestReadable: async body => sha256Hex(await readBoundedBytes(body, photo.length)) });
            await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
        });
        try {
            await page.goto(`${origin}/private-gallery?site=${site}`);
            await page.getByText('Protected intake, consent and owner job preparation ready.', { exact: false }).waitFor();
            for (const [name, publicId] of [['Fictional public runner', 'john-kevan'], ['Fictional private runner', '']]) {
                await page.locator('#private-person-name').fill(name);
                await page.locator('#private-person-public').selectOption(publicId);
                await page.getByRole('button', { name: 'Add private person' }).click();
                await page.getByText('Private person saved, initially hidden.', { exact: false }).waitFor();
            }
            for (let index = 0; index < 2; index++) {
                await page.locator('#private-people .draft-card').nth(index).getByRole('button', { name: 'Allow for a fresh review' }).click();
                await page.getByText('Preference saved privately.', { exact: false }).waitFor();
                await page.locator('#private-tag-choices input').nth(index).check();
            }
            await page.getByRole('button', { name: 'Save private tags' }).click();
            await page.locator('#private-asset-status').filter({ hasText: 'Visibility preferences allow a fresh consent check.' }).waitFor();
            const asset = db.prepare('SELECT * FROM private_gallery_assets').get();
            const people = db.prepare('SELECT person_id,public_athlete_id FROM private_gallery_people ORDER BY person_id').all();
            const publicPerson = people.find(person => person.public_athlete_id === 'john-kevan').person_id;
            const privatePerson = people.find(person => person.public_athlete_id === null).person_id;
            await page.locator('#private-photo').setInputFiles({ name: 'synthetic-local-only.jpg', mimeType: 'image/jpeg', buffer: photo });
            await page.locator('#private-framing-workspace').waitFor({ state: 'visible' });
            await page.getByText('Automatic detection is unavailable.', { exact: false }).waitFor();
            await page.locator('#private-retention').check();
            await page.locator('#private-upload-adults').check();
            await page.getByRole('button', { name: 'Upload original to protected storage' }).click();
            await page.getByText('Private original verified. Nothing published.', { exact: true }).waitFor();
            const original = db.prepare('SELECT * FROM private_archive_original_receipts').get();
            const tags = db.prepare('SELECT * FROM private_gallery_current_asset_tags ORDER BY ordinal').all();
            assert.equal(original.sha256, digest(photo));
            assert.equal(await page.locator('#private-framing-save').isDisabled(), true, 'retention cannot implicitly confirm or enable framing save');
            assert.equal(posts.length, 0, 'local decoding/detection/retention does not save framing or public consent');
            // A generic UI action previously restored this button incorrectly.
            // Even if its DOM disabled flag is lost, the real click handler must
            // independently refuse unchecked or unedited framing.
            await page.locator('#private-framing-save').evaluate(button => { button.disabled = false; });
            await page.getByRole('button', { name: 'Save checked framing privately' }).click();
            await page.waitForTimeout(100);
            assert.equal(posts.length, 0, 'losing a disabled flag cannot authorize an unchecked save');
            assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_frame_revisions').get().n, 0);

            const expected = { [publicPerson]: { x: 37.5, y: 17.5, zoom: 2.25 }, [privatePerson]: { x: 82.5, y: 31.5, zoom: 3 } };
            for (const [personId, frame] of Object.entries(expected)) {
                await page.locator('#private-framing-person').selectOption(personId);
                const canvas = page.locator('#private-framing-image');
                const box = await canvas.boundingBox();
                await canvas.click({ position: { x: box.width * 0.3, y: box.height * 0.2 } });
                for (const [field, value] of Object.entries(frame)) await page.locator(`#private-framing-${field}`).fill(String(value));
                assert.equal(await page.locator('#private-framing-confirm').isChecked(), false);
                assert.equal(await page.locator('#private-framing-save').isDisabled(), true, 'manual edits still need explicit confirmation');
            }
            assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_frame_revisions').get().n, 0);
            await page.locator('#private-framing-confirm').check();
            await page.getByRole('button', { name: 'Save checked framing privately' }).click();
            await page.getByText('Checked framing saved privately.', { exact: false }).waitFor();
            const revision = db.prepare('SELECT * FROM private_gallery_frame_revisions').get();
            assert.equal(revision.version, 1);
            assert.deepEqual(JSON.parse(revision.frames_json), expected, 'real numeric UI POST is stored through the protected router and SQLite');
            assert.equal(revision.image_width, 240); assert.equal(revision.image_height, 160, 'EXIF6 preview dimensions are transposed');
            assert.equal(revision.orientation, 'exif-transposed-v1');
            assert.equal(await page.locator('#private-framing-confirm').isChecked(), false);
            assert.equal(await page.locator('#private-public-use').isChecked(), false, 'framing does not infer consent');
            assert.equal(await page.locator('#private-complete-tags').isChecked(), false, 'framing does not confirm complete tags');
            assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_attempts').get().n, 0);

            await page.locator('#private-complete-tags').check(); await page.locator('#private-public-use').check();
            await page.locator('#private-public-adults').check();
            await page.getByRole('button', { name: 'Save fresh public consent' }).click();
            await page.getByText('Fresh public-use consent saved separately.', { exact: false }).waitFor();
            const attempt = db.prepare('SELECT * FROM private_gallery_attempts').get();
            const snapshot = db.prepare('SELECT * FROM private_gallery_attempt_framings').get();
            assert.equal(attempt.framing_version, 1);
            assert.equal(attempt.asset_id, asset.asset_id); assert.equal(attempt.site_mode, site);
            assert.equal(snapshot.attempt_id, attempt.attempt_id); assert.equal(snapshot.version, 1);
            assert.deepEqual(JSON.parse(snapshot.private_frames_json), expected);
            assert.deepEqual(JSON.parse(snapshot.public_frames_json), { 'john-kevan': expected[publicPerson] }, 'only exact already-public tagged identities project');
            assert.equal(snapshot.source_sha256, original.sha256);
            assert.deepEqual(db.prepare('SELECT * FROM private_archive_original_receipts').get(), original);
            assert.deepEqual(db.prepare('SELECT * FROM private_gallery_current_asset_tags ORDER BY ordinal').all(), tags);
            assert.equal(bucket.objects.size, 1); assert.deepEqual(bucket.objects.get(asset.private_object_key).bytes, photo);
            assert.equal(bucket.calls.some(call => call[0] === 'delete'), false);
            assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_pipeline_admissions').get().n, 0);
            assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_owner_jobs').get().n, 0, 'browser never dispatches a review');
            assert.equal(db.prepare('SELECT count(*) n FROM private_gallery_pipeline_reviews').get().n, 0);
            assert.equal(posts.length, 2); assert.equal(posts[0].body.confirmed, true); assert.equal(posts[1].body.framingVersion, 1);
            assert.ok(posts.every(post => post.site === site && post.csrf && post.session && post.origin === origin));
            assert.deepEqual(Object.keys(posts[0].body).sort(), ['confirmed', 'expectedVersion', 'frames', 'idempotencyKey', 'imageHeight', 'imageWidth', 'orientation', 'sourceSha256', 'tagVersion']);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
            assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
            assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
            await page.locator('#private-framing-panel').screenshot({ path: fileURLToPath(new URL(`private-framing-uploader-${site}-${mobile ? 'mobile' : 'desktop'}.png`, screenshots)) });
        } finally { await context.close(); db.close(); }
    }
    console.log('Actual protected uploader browser/router/SQLite framing and fresh-consent snapshot passed both areas and desktop/mobile, with retained originals, explicit confirmation and no processing/publication.');
} finally { await browser.close(); }
