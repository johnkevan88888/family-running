import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const gallery = require('../gallery-contract.js');
const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetDirectory = path.join(defaultRoot, 'scripts', 'gallery-podium-editor');
const configName = 'gallery-podium-framing.json';
const tokenHeader = 'x-gallery-framing-token';
const bodyLimit = 4096;

function fail(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function exactKeys(value, keys) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function sameToken(value, expected) {
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && value.length === expected.length
        && timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

async function fixedFile(root, name, maximum, optional = false) {
    const parts = name.split('/');
    for (let index = 1; index < parts.length; index += 1) {
        const directory = await lstat(path.join(root, ...parts.slice(0, index)));
        if (!directory.isDirectory() || directory.isSymbolicLink()) throw fail(422, 'Required local directories must not be symbolic links.');
    }
    const target = path.join(root, name);
    const info = await lstat(target).catch(error => {
        if (optional && error.code === 'ENOENT') return null;
        throw error;
    });
    if (!info) return null;
    if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) {
        throw fail(422, 'A required local file is not a bounded regular file.');
    }
    const bytes = await readFile(target);
    if (bytes.length > maximum) throw fail(422, 'A local file exceeds its limit.');
    return bytes;
}

function parseJson(bytes) {
    try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
        throw fail(422, 'A required JSON document is malformed.');
    }
}

async function readSnapshot(root, site, framing) {
    const [manifestBytes, suppressionBytes, configBytes] = await Promise.all([
        fixedFile(root, `gallery-data/${site}.json`, 2 * 1024 * 1024),
        fixedFile(root, 'gallery-data/hidden-athlete-ids.json', 128 * 1024),
        fixedFile(root, configName, 512 * 1024, true)
    ]);
    const manifest = parseJson(manifestBytes);
    const suppression = parseJson(suppressionBytes);
    const config = configBytes === null ? { schemaVersion: '1.0', frames: {} } : parseJson(configBytes);
    const problems = [
        ...gallery.validateGalleryDocument(manifest),
        ...gallery.validateGallerySuppressionDocument(suppression),
        ...framing.validateDocument(config)
    ];
    if (problems.length) throw fail(422, 'Gallery, suppression or framing validation failed. No photo is available.');
    const revision = createHash('sha256')
        .update(JSON.stringify([site, manifestBytes.toString('base64'), suppressionBytes.toString('base64'), configBytes?.toString('base64') ?? null]))
        .digest('hex');
    // Whole-item suppression is resolved BEFORE exposing URLs or creating images.
    const items = gallery.filterSuppressedGalleryItems(manifest.items, suppression)
        .filter(item => item.type === 'photo' && item.athleteIds.length > 0);
    const photos = await Promise.all(items.map(async item => ({
        id: item.id,
        title: item.title,
        raceEvent: item.raceEvent,
        raceDate: item.raceDate,
        sourceUrl: item.sourceUrl,
        thumbnailUrl: item.thumbnailUrl,
        athletes: await Promise.all(item.athleteIds.map(async id => {
            const key = await framing.keyFor(item, id);
            return { id, key, frame: config.frames[key] ?? null };
        }))
    })));
    return { site, revision, photos, config };
}

async function boundedBody(request) {
    const declaredLength = request.headers['content-length'];
    if (declaredLength !== undefined && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > bodyLimit)) {
        request.resume();
        throw fail(413, 'Save request is too large.');
    }
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let settled = false;
        const timer = setTimeout(() => finish(fail(408, 'Save request timed out.')), 5000);
        timer.unref();
        function finish(error, value) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) {
                request.resume();
                reject(error);
            } else resolve(value);
        }
        request.on('data', chunk => {
            if (settled) return;
            size += chunk.length;
            if (size > bodyLimit) return finish(fail(413, 'Save request is too large.'));
            chunks.push(chunk);
        });
        request.on('end', () => finish(null, Buffer.concat(chunks)));
        request.on('error', () => finish(fail(400, 'Save request could not be read.')));
        request.on('aborted', () => finish(fail(400, 'Save request was interrupted.')));
    });
}

async function saveFrame(root, site, framing, value) {
    if (!exactKeys(value, ['revision', 'itemId', 'athleteId', 'frame'])
        || typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision)
        || typeof value.itemId !== 'string' || typeof value.athleteId !== 'string') {
        throw fail(400, 'Save requires exactly revision, itemId, athleteId and frame.');
    }
    if (value.frame !== null) {
        if (!exactKeys(value.frame, ['x', 'y', 'zoom'])
            || framing.validateDocument({ schemaVersion: '1.0', frames: { ['a'.repeat(64)]: value.frame } }).length) {
            throw fail(400, 'The frame must contain valid numeric x, y and zoom values.');
        }
    }
    const lockPath = path.join(root, '.gallery-podium-framing.lock');
    let lock;
    try {
        lock = await open(lockPath, 'wx', 0o600);
    } catch (error) {
        if (error.code === 'EEXIST') throw fail(409, 'Another framing save is in progress. Refresh and try again.');
        throw error;
    }
    let temporaryPath;
    try {
        const current = await readSnapshot(root, site, framing);
        if (current.revision !== value.revision) throw fail(409, 'Files changed since this view. Refresh before saving.');
        const photo = current.photos.find(item => item.id === value.itemId);
        const athlete = photo?.athletes.find(item => item.id === value.athleteId);
        if (!athlete) throw fail(422, 'This photo/person pair is no longer eligible.');
        const next = { schemaVersion: '1.0', frames: { ...current.config.frames } };
        if (value.frame === null) delete next.frames[athlete.key];
        else next.frames[athlete.key] = value.frame;
        if (framing.validateDocument(next).length) throw fail(422, 'The saved document would be invalid.');
        const sorted = { schemaVersion: '1.0', frames: Object.fromEntries(Object.entries(next.frames).sort(([a], [b]) => a.localeCompare(b))) };
        const serialized = `${JSON.stringify(sorted, null, 2)}\n`;
        if (Buffer.byteLength(serialized) > 512 * 1024) throw fail(422, 'The saved document would exceed its size limit.');
        temporaryPath = path.join(root, `.gallery-podium-framing-${randomBytes(12).toString('hex')}.tmp`);
        const temporaryFile = await open(temporaryPath, 'wx', 0o600);
        try {
            await temporaryFile.writeFile(serialized);
            await temporaryFile.sync();
        } finally {
            await temporaryFile.close();
        }
        // Check the complete binding again immediately before the atomic replacement.
        const beforeReplace = await readSnapshot(root, site, framing);
        if (beforeReplace.revision !== value.revision) throw fail(409, 'Files changed during save. Refresh before saving.');
        await rename(temporaryPath, path.join(root, configName));
        temporaryPath = null;
        const saved = await readSnapshot(root, site, framing);
        return { site: saved.site, revision: saved.revision, photos: saved.photos, saved: true };
    } finally {
        if (temporaryPath) await unlink(temporaryPath).catch(() => {});
        await lock.close();
        await unlink(lockPath);
    }
}

export async function startGalleryPodiumEditor({ root = defaultRoot, site = 'family', port = 0 } = {}) {
    if (!['family', 'everyone'].includes(site)) throw new Error('Site must be family or everyone.');
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer from 0 to 65535.');
    const repositoryRoot = await realpath(path.resolve(root));
    const framing = require('../gallery-podium-framing.js');
    const token = randomBytes(32).toString('hex');
    let origin;
    let host;
    const staticFiles = new Map([
        ['/', [path.join(assetDirectory, 'index.html'), 'text/html; charset=utf-8']],
        ['/editor.js', [path.join(assetDirectory, 'editor.js'), 'text/javascript; charset=utf-8']],
        ['/editor.css', [path.join(assetDirectory, 'editor.css'), 'text/css; charset=utf-8']],
        ['/gallery-podium-framing.js', [path.join(defaultRoot, 'gallery-podium-framing.js'), 'text/javascript; charset=utf-8']]
    ]);
    const server = createServer(async (request, response) => {
        const baseHeaders = {
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            'referrer-policy': 'no-referrer',
            'cross-origin-resource-policy': 'same-origin',
            'x-frame-options': 'DENY'
        };
        function answer(status, value, type = 'application/json; charset=utf-8', extra = {}) {
            response.writeHead(status, { ...baseHeaders, 'content-type': type, ...extra });
            response.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
        }
        try {
            if (request.headers.host !== host || !request.url?.startsWith('/') || request.url.startsWith('//')) {
                throw fail(403, 'Loopback host required.');
            }
            const target = new URL(request.url, origin);
            if (target.origin !== origin || target.search || target.hash) throw fail(404, 'Not found.');
            const requestOrigin = request.headers.origin;
            if (requestOrigin !== undefined && requestOrigin !== origin) throw fail(403, 'Same-origin request required.');
            if (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])) {
                throw fail(403, 'Cross-site request refused.');
            }
            if (request.method === 'GET' && staticFiles.has(target.pathname)) {
                const [file, type] = staticFiles.get(target.pathname);
                const bytes = await readFile(file);
                const snapshot = target.pathname === '/' ? await readSnapshot(repositoryRoot, site, framing) : null;
                const mediaOrigins = snapshot ? [...new Set(snapshot.photos.map(item => new URL(item.sourceUrl).origin))] : [];
                answer(200, bytes, type, target.pathname === '/' ? {
                    'content-security-policy': `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src ${mediaOrigins.length ? mediaOrigins.join(' ') : "'none'"}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
                } : {});
                return;
            }
            if (!['/state', '/save'].includes(target.pathname)) throw fail(404, 'Not found.');
            if (!sameToken(request.headers[tokenHeader], token)) throw fail(403, 'Local editor token required.');
            if (target.pathname === '/state' && request.method === 'GET') {
                const snapshot = await readSnapshot(repositoryRoot, site, framing);
                answer(200, { site: snapshot.site, revision: snapshot.revision, photos: snapshot.photos });
                return;
            }
            if (target.pathname === '/save' && request.method === 'POST') {
                if (requestOrigin !== origin || request.headers['content-type'] !== 'application/json') throw fail(403, 'Same-origin JSON required.');
                const raw = await boundedBody(request);
                const value = parseJson(raw);
                const result = await saveFrame(repositoryRoot, site, framing, value);
                answer(200, result);
                return;
            }
            throw fail(405, 'Method not allowed.');
        } catch (error) {
            answer(error.status || 500, { error: error.status ? error.message : 'The local editor could not read or save its fixed files.' });
        }
    });
    server.requestTimeout = 5000;
    server.headersTimeout = 5000;
    server.keepAliveTimeout = 1000;
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    host = `127.0.0.1:${server.address().port}`;
    origin = `http://${host}`;
    return {
        url: `${origin}/#token=${token}`,
        close: () => new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
            server.closeIdleConnections();
        })
    };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--site' || !['family', 'everyone'].includes(args[1]))) {
        throw new Error('Usage: node scripts/gallery-podium-editor.mjs [--site family|everyone]');
    }
    const editor = await startGalleryPodiumEditor({ site: args[1] || 'family' });
    console.log(`Local photo framing only: ${editor.url}`);
    console.log('Open this local link. Save changes only framing coordinates; it does not publish or alter photos. Press Ctrl+C to stop.');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await editor.close(); process.exit(0); });
}
