import { createReadStream, statSync } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME_TYPES = new Map([
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.css', 'text/css; charset=utf-8'],
    ['.csv', 'text/csv; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.svg', 'image/svg+xml']
]);

export async function createStaticServer(options = {}) {
    const root = path.resolve(options.root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
    const host = options.host || '127.0.0.1';
    const requestedPort = options.port !== undefined
        ? options.port
        : process.env.PORT !== undefined
            ? process.env.PORT
            : 4173;
    const port = Number(requestedPort);
    const silent = Boolean(options.silent);

    const server = createServer(async (request, response) => {
        try {
            const requestUrl = new URL(request.url || '/', `http://${host}:${port}`);

            if (requestUrl.pathname === '/favicon.ico') {
                response.writeHead(204, { 'cache-control': 'no-store' });
                response.end();
                return;
            }

            const filePath = await resolveRequestPath(root, requestUrl.pathname);
            const fileStat = statSync(filePath);

            response.writeHead(200, {
                'content-type': MIME_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream',
                'content-length': fileStat.size,
                'cache-control': 'no-store'
            });

            createReadStream(filePath).pipe(response);
        } catch (error) {
            const status = error.statusCode || 404;
            response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
            response.end(status === 404 ? 'Not found' : 'Server error');
        }
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
            server.off('error', reject);
            resolve();
        });
    });

    const address = server.address();
    const resolvedPort = typeof address === 'object' && address ? address.port : port;
    const baseUrl = `http://${host}:${resolvedPort}`;

    if (!silent) {
        console.log(`Family preview:   ${baseUrl}/?site=family`);
        console.log(`Everyone preview: ${baseUrl}/?site=everyone`);
        console.log('Press Ctrl+C to stop.');
    }

    return {
        server,
        baseUrl,
        close: () => new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        })
    };
}

async function resolveRequestPath(root, pathname) {
    const decodedPath = decodeURIComponent(pathname);
    const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
    const candidate = path.resolve(root, relativePath);

    if (!candidate.startsWith(root + path.sep) && candidate !== root) {
        const error = new Error('Forbidden');
        error.statusCode = 403;
        throw error;
    }

    const candidateStat = await stat(candidate).catch(() => null);

    if (candidateStat?.isDirectory()) {
        const indexCandidate = path.join(candidate, 'index.html');
        await access(indexCandidate);
        return indexCandidate;
    }

    await access(candidate);
    return candidate;
}

function parseCliArgs(argv) {
    const args = new Map();

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];

        if (arg.startsWith('--')) {
            const [key, inlineValue] = arg.slice(2).split('=');
            const value = inlineValue ?? argv[index + 1];
            args.set(key, value);

            if (inlineValue === undefined && value && !value.startsWith('--')) {
                index += 1;
            }
        }
    }

    return args;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const thisPath = fileURLToPath(import.meta.url);

if (invokedPath === thisPath) {
    const args = parseCliArgs(process.argv.slice(2));
    const preview = await createStaticServer({
        port: Number(args.get('port') || process.env.PORT || 4173),
        host: args.get('host') || '127.0.0.1'
    });

    const shutdown = async () => {
        await preview.close();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
