import { pathToFileURL } from 'node:url';

const FINALIZER_ORIGIN =
    'https://family-running-gallery-withdrawal-finalizer-dev.family-running.workers.dev';
const PROBE_PATH = '/api/service/drafts/' +
    'draft_00000000-0000-4000-8000-000000000000/withdrawal-finalizations';
const METHOD_BODY = '{"error":"method-not-allowed"}';

// This runner has no draft/action input and imports no withdrawal or storage code.
// GET reaches the Worker's identity/environment checks, then exits before its
// finalization service. A 404 or a successful mutation is NOT a passing probe.
export async function probeFinalizerAccess(configuration, {
    fetchImpl = globalThis.fetch,
    timeoutMilliseconds = 20_000
} = {}) {
    if (!configuration || Object.keys(configuration).sort().join(',') !==
        'clientId,clientSecret,origin' ||
        configuration.origin !== FINALIZER_ORIGIN ||
        typeof configuration.clientId !== 'string' ||
        !/^[a-f0-9]{32}\.access$/i.test(configuration.clientId || '') ||
        typeof configuration.clientSecret !== 'string' ||
        !/^[\x21-\x7e]{16,2048}$/.test(configuration.clientSecret) ||
        typeof fetchImpl !== 'function' ||
        !Number.isSafeInteger(timeoutMilliseconds) ||
        timeoutMilliseconds < 1 || timeoutMilliseconds > 20_000) {
        throw new Error('Invalid access-probe configuration.');
    }

    for (const kind of ['anonymous', 'invalid', 'authenticated']) {
        const controller = new AbortController();
        let reader;
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => {
                controller.abort();
                reject(new Error('Access probe timed out.'));
            }, timeoutMilliseconds);
        });
        try {
            await Promise.race([timeout, (async () => {
                const headers = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };
                if (kind !== 'anonymous') {
                    headers['CF-Access-Client-Id'] = kind === 'authenticated'
                        ? configuration.clientId : 'invalid.access';
                    headers['CF-Access-Client-Secret'] = kind === 'authenticated'
                        ? configuration.clientSecret : 'invalid';
                }
                const response = await fetchImpl(FINALIZER_ORIGIN + PROBE_PATH, {
                    method: 'GET', headers, redirect: 'manual', credentials: 'omit',
                    cache: 'no-store', signal: controller.signal
                });
                if (!(response instanceof Response) || response.redirected ||
                    response.headers.has('Location') ||
                    !response.headers.get('Cache-Control')?.split(',')
                        .some(value => value.trim().toLowerCase() === 'no-store') ||
                    response.status !== (kind === 'authenticated' ? 405 : 401)) {
                    throw new Error('Access boundary did not match.');
                }
                if (kind !== 'authenticated') return;
                if (response.headers.get('Allow') !== 'POST' ||
                    response.headers.get('Content-Type')?.split(';')[0] !==
                        'application/json' || !response.body) {
                    throw new Error('Method boundary did not match.');
                }
                reader = response.body.getReader();
                const chunks = [];
                let length = 0;
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    length += value.byteLength;
                    if (length > 512) throw new Error('Probe response too large.');
                    chunks.push(Buffer.from(value));
                }
                if (Buffer.concat(chunks).toString('utf8') !== METHOD_BODY) {
                    throw new Error('Method boundary did not match.');
                }
            })()]);
        } finally {
            clearTimeout(timer);
            controller.abort();
            // Do not let a stalled/corrupt response extend the request deadline.
            if (reader) void reader.cancel().catch(() => {});
        }
    }
    return Object.freeze({
        schemaVersion: '1.0', status: 'gallery-finalizer-read-only-access-verified',
        anonymousStatus: 401, invalidCredentialStatus: 401, authenticatedStatus: 405
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        if (process.argv.length !== 2) throw new Error('No arguments accepted.');
        const result = await probeFinalizerAccess({
            origin: process.env.GALLERY_WITHDRAWAL_FINALIZER_ORIGIN,
            clientId: process.env.GALLERY_WITHDRAWAL_FINALIZER_ACCESS_CLIENT_ID,
            clientSecret: process.env.GALLERY_WITHDRAWAL_FINALIZER_ACCESS_CLIENT_SECRET
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch {
        // Never log a URL, credential, response body, error or stack trace.
        process.stderr.write('Gallery finalizer read-only access probe failed.\n');
        process.exitCode = 1;
    }
}
