// Records which repository files a check actually opens.
//
// Preloaded with `--require` by `scripts/trace-check-reads.mjs`, so it patches
// `fs` before any check's modules load, and inherited by spawned children
// through NODE_OPTIONS. It is AUDIT INSTRUMENTATION ONLY: nothing in the suite,
// the classifier or the release path depends on it at runtime, and a trace it
// fails to write never changes a check's outcome.
//
// Measuring reads cannot replace the reviewed tier table -- it sees what a
// check opened, not what it is responsible for, so it misses a check that
// asserts a file is ABSENT or that asserts on output it generates. It is the
// other direction that is useful: a check that demonstrably reads a tier's
// files and is not in that tier is a hole, and that is what the audit fails on.

// Preloaded with --require, so it patches fs before any check's ESM loads.
// Records every repository path the process (and, through NODE_OPTIONS, its
// children) actually opens, and appends them to FAMILY_RUNNING_TRACE on exit.
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');

const repoRoot = path.resolve(process.env.FAMILY_RUNNING_TRACE_ROOT || path.join(__dirname, '..'));
const tracePath = process.env.FAMILY_RUNNING_TRACE;
const seen = new Set();

function record(candidate) {
    if (typeof candidate !== 'string' && !(candidate instanceof URL)) {
        return;
    }
    let resolved;

    try {
        resolved = path.resolve(candidate instanceof URL
            ? decodeURIComponent(candidate.pathname).replace(/^\/([A-Za-z]:)/, '$1')
            : String(candidate));
    } catch {
        return;
    }
    if (!resolved.toLowerCase().startsWith(repoRoot.toLowerCase())) {
        return;
    }

    let relative = path.relative(repoRoot, resolved).split(path.sep).join('/');

    // The artifact is a copy of the published site. A read of
    // test-artifacts/preview-site/athlete.js IS a read of athlete.js, and the
    // tier has to see it as one, or every browser check would look as though it
    // depended on nothing but a build output.
    const artifact = 'test-artifacts/preview-site/';

    if (relative.startsWith(artifact)) {
        relative = relative.slice(artifact.length);
    }
    if (!relative || relative.startsWith('..') || relative.startsWith('node_modules/')) {
        return;
    }

    seen.add(relative);
}

for (const name of ['readFileSync', 'openSync', 'createReadStream', 'existsSync', 'statSync', 'lstatSync', 'readdirSync', 'realpathSync', 'accessSync']) {
    const original = fs[name];

    if (typeof original !== 'function') continue;
    fs[name] = function (first, ...rest) {
        record(first);
        return original.call(this, first, ...rest);
    };
}

for (const name of ['readFile', 'open', 'stat', 'lstat', 'readdir', 'access', 'realpath']) {
    const original = fsPromises[name];

    if (typeof original !== 'function') continue;
    fsPromises[name] = function (first, ...rest) {
        record(first);
        return original.call(this, first, ...rest);
    };
}

process.on('exit', () => {
    if (!tracePath || !seen.size) return;
    try {
        fs.appendFileSync(tracePath, [...seen].join('\n') + '\n');
    } catch {
        // A trace that cannot be written must not change the check's outcome.
    }
});
