import assert from 'node:assert/strict';
import vm from 'node:vm';
import { archiveServiceFixture } from './helpers/private-gallery-service-fixture.mjs';
import { handleAdminRequest } from '../gallery-admin/src/admin-worker.js';
import { createBrowserSession } from '../gallery-admin/src/session.js';

// Actual protected router + full local SQL, fictional identities and generated
// bytes only. Nothing in this test can contact Cloudflare, GitHub or a live host.
const origin = 'https://synthetic-framing-owner.example';
const assets = ['/private-face-worker.js', '/private-face-editor.js',
    '/private-face-editor.css', '/gallery-podium-framing.js'];
for (const site of ['family', 'everyone']) {
    const f = await archiveServiceFixture(site, { reserveAttempt: false });
    const env = { DB: f.env.DB, PRIVATE_ORIGINALS: f.original, ADMIN_ORIGIN: origin,
        OWNER_IDENTITIES: `subject:${f.owner.subject}`, SESSION_SECRET: 'synthetic-framing-session-secret' };
    const session = await createBrowserSession(f.owner, env, site, Date.now());
    const opposite = await createBrowserSession(f.owner, env, site === 'family' ? 'everyone' : 'family', Date.now());
    const dependencies = { verifyAccessIdentity: async () => f.owner, bodyTimeoutMilliseconds: 15 };
    const route = `/api/browser/private-assets/${f.assetId}/framing`;
    const headers = { Cookie: session.cookie.split(';')[0], 'X-CSRF-Token': session.csrfToken,
        Origin: origin, 'Sec-Fetch-Site': 'same-origin' };
    const request = (path, body, extra = {}) => new Request(`${origin}${path}?site=${site}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const run = (req, deps = dependencies) => handleAdminRequest(req, env, deps);
    const read = await run(request(route));
    assert.equal(read.status, 200);
    const initial = await read.json();
    assert.equal(initial.version, 0);
    const body = { idempotencyKey: crypto.randomUUID(), expectedVersion: 0, tagVersion: initial.tagVersion,
        sourceSha256: initial.sourceSha256, orientation: 'exif-transposed-v1', imageWidth: 32, imageHeight: 48,
        frames: { [f.ids[0]]: { x: 45, y: 20, zoom: 2 } }, confirmed: true };
    const callsBefore = f.original.calls.length;
    for (const [extra, identity] of [
        [{ Cookie: '' }, f.owner], [{ 'X-CSRF-Token': 'wrong' }, f.owner],
        [{ Origin: 'https://untrusted.example' }, f.owner], [{ 'Sec-Fetch-Site': 'cross-site' }, f.owner],
        [{ Cookie: opposite.cookie.split(';')[0], 'X-CSRF-Token': opposite.csrfToken }, f.owner],
        [{ 'Cf-Access-Client-Id': 'not-a-browser' }, f.owner],
        [{}, null], [{}, { type: 'service', subject: f.owner.subject }],
        [{}, { type: 'browser', subject: 'another-synthetic-owner' }]
    ]) assert.equal((await run(request(route, body, extra), {
        ...dependencies, verifyAccessIdentity: async () => identity
    })).status, 403);
    for (const query of ['', '?site=invalid', `?site=${site}&site=${site}`, `?site=${site}&x=1`]) {
        assert.equal((await run(new Request(`${origin}${route}${query}`, { headers }))).status, 404);
    }
    assert.equal((await run(request(route, undefined, { 'Content-Type': 'application/json' }))).status, 400);
    assert.equal((await run(request(route, body, { 'Content-Encoding': 'gzip' }))).status, 400);
    assert.equal((await run(request(route, body, { 'Transfer-Encoding': 'chunked' }))).status, 400);
    assert.equal((await run(request(route, body, { 'Content-Length': '999999' }))).status, 413);
    assert.equal((await run(request(route, { ...body, faceEmbedding: [1, 2] }))).status, 422);
    const invalidUtf8 = new Request(`${origin}${route}?site=${site}`, { method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' }, body: new Uint8Array([255, 254]) });
    assert.equal((await run(invalidUtf8)).status, 400);
    const stalled = new Request(`${origin}${route}?site=${site}`, { method: 'POST', duplex: 'half',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
            cancel() { return new Promise(() => {}); } }) });
    const started = Date.now();
    assert.equal((await run(stalled)).status, 400);
    assert.ok(Date.now() - started < 1500, 'stalled bodies and cancellation have a bounded total deadline');
    assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_frame_revisions').get().n, 0);

    const saved = await run(request(route, body));
    assert.equal(saved.status, 201, await saved.clone().text());
    assert.equal((await saved.json()).version, 1);
    assert.equal((await (await run(request(route, body))).json()).replayed, true);
    const current = await (await run(request(route))).json();
    assert.deepEqual(current.frames, body.frames);
    assert.equal(current.publicationEnabled, false);
    assert.equal(f.original.calls.length, callsBefore, 'framing routes never read or alter original pixels');
    assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_attempts').get().n, 0,
        'saving framing is not public-use consent or a processing attempt');
    assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_frame_revisions').get().n, 1);
    const privateShell = await run(request('/private-gallery'));
    assert.equal(privateShell.status, 200);
    assert.match(privateShell.headers.get('Content-Security-Policy'), /worker-src 'self'/);
    assert.doesNotMatch(privateShell.headers.get('Content-Security-Policy'), /unsafe-eval|https:|blob:/);
    const legacyShell = await run(request('/'));
    assert.doesNotMatch(legacyShell.headers.get('Content-Security-Policy'), /worker-src/,
        'detection permission is not added to unrelated admin pages');
    for (const asset of assets) {
        const response = await run(request(asset));
        assert.equal(response.status, 200, asset);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
        assert.equal(response.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
        assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
        assert.equal((await run(request(asset), { ...dependencies, verifyAccessIdentity: async () => null })).status, 403);
        assert.equal((await run(request(asset), { ...dependencies,
            verifyAccessIdentity: async () => ({ type: 'service', subject: f.owner.subject }) })).status, 403);
        assert.equal((await run(new Request(`${origin}${asset}`, { headers }))).status, 404);
        if (asset === '/private-face-worker.js') {
            assert.equal(response.headers.get('Content-Security-Policy'), "default-src 'none'; connect-src 'none'");
            const source = await response.text();
            assert.ok(source.length < 400000, 'pinned detector remains a bounded embedded asset');
            assert.match(source, /MIT License/);
            assert.doesNotMatch(source, /importScripts\s*\(|fetch\s*\(|XMLHttpRequest/);
        } else if (asset === '/gallery-podium-framing.js') {
            const context = vm.createContext({});
            vm.runInContext(await response.text(), context);
            assert.equal(vm.runInContext('galleryPodiumFraming.layout(null,400,800,100,100).width', context), 50);
        }
    }
    f.db.close();
}
console.log('Protected framing owner/session/CSRF/area routes, bounded bodies, no byte I/O and exact self-hosted assets passed.');
