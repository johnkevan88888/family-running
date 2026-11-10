// The browser checks render the published artifact, not the repository.
//
// `scripts/published-site-entries.mjs` is the allowlist of what reaches the
// public web, and `scripts/build-preview-artifact.mjs` copies exactly those
// entries. Until now the browser checks served the REPOSITORY ROOT, where every
// runtime file exists whether or not it is on that list. So the one mistake the
// allowlist exists to prevent -- adding a page or a script to the site and
// forgetting to publish it -- could not be caught by rendering the site: the
// checks loaded the file from the working tree and passed, and production
// served a 404.
//
// This check holds the three things that close that gap:
//
//   1. Every browser check that serves the real site is declared in
//      `publishedSiteScripts`, DERIVED from the sources rather than trusted, and
//      every one of them honours SITE_ROOT.
//   2. The runner and the focused photo group both take that declaration from
//      one place, so a check cannot be served the artifact in one and the
//      repository in the other.
//   3. A runtime entry missing from the allowlist makes the suite FAIL. Not
//      argued -- run. A real registered browser check is run against a real
//      artifact with one entry withheld, and must fail.
//
// (3) is the point of the whole change, so it is proved rather than asserted
// about. `tests/gallery-thumbnail-layout.mjs` carries it: it is a registered
// browser check, it serves the site root, it loads `gallery.html` and asserts
// the cards that only `gallery.js` can create, and it takes about three
// seconds.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    browserScripts,
    environmentFor,
    publishedSiteScripts
} from '../scripts/check-lanes.mjs';
import { defaultPreviewOutputDir } from '../scripts/preview-artifact-contract.mjs';
import { publishedSiteEntries } from '../scripts/published-site-entries.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFile(path.join(repoRoot, relative), 'utf8');

// -- 1. The declaration is derived, not trusted ---------------------------
//
// A browser check serves the real site when it calls `createStaticServer`.
// Anything else builds its own fixture tree or drives a local tool, and the
// published artifact is not what it is testing.

// This file is excluded from its own scan. It calls `createStaticServer` below
// to prove that a missing root is refused, not to serve the site, so matching
// itself would declare a coverage it does not have. The launcher and spawner
// derivations in `tests/check-lanes.mjs` carry the same exclusion for the same
// reason: a check that names what it is looking for finds itself first.
const self = 'tests/published-site-browser-root.mjs';
const servers = [];

for (const script of browserScripts) {
    if (script !== self && (await read(script)).includes('createStaticServer(')) {
        servers.push(script);
    }
}

assert.deepEqual(
    [...publishedSiteScripts].sort(),
    servers.sort(),
    'every browser check that serves the site must be declared in publishedSiteScripts, and nothing else may be'
);
assert.ok(servers.length >= 5, `expected the site-serving browser checks, found ${servers.length}`);

// Each of them must resolve its root through `resolveSiteRoot`. A check
// declared here that hardcodes the repository root would be handed the artifact
// and quietly ignore it, which is worse than not being declared at all: the
// declaration would claim a coverage that does not exist. Reading
// `process.env.SITE_ROOT` directly is not enough either -- these checks read
// site files before they stand up a server, so the root has to be checked where
// it is resolved rather than at the first read.
for (const script of publishedSiteScripts) {
    const source = await read(script);

    assert.ok(
        source.includes('resolveSiteRoot('),
        `${script} serves the site but does not resolve its root through resolveSiteRoot`
    );
    assert.equal(
        source.includes('process.env.SITE_ROOT'),
        false,
        `${script} reads SITE_ROOT itself, bypassing the guard that makes a missing artifact say so`
    );
    assert.ok(
        /createStaticServer\(\{\s*root:\s*siteRoot/.test(source),
        `${script} resolves a site root but does not serve from it`
    );
}

// -- 2. One decision, used everywhere -------------------------------------

for (const script of publishedSiteScripts) {
    assert.deepEqual(
        environmentFor(script),
        { SITE_ROOT: defaultPreviewOutputDir },
        `${script} must be served the published artifact`
    );
}
assert.deepEqual(environmentFor('tests/analytics-config.mjs'), {}, 'a check that serves nothing is told nothing');
assert.deepEqual(environmentFor('scripts/validate-csv.mjs'), {});

// The runner must merge it into the child environment in BOTH spawn helpers:
// `runNode` for the serial phases and `collectNode` for the buffered pool. One
// of the two left unmerged would serve the artifact at `--jobs=1` and the
// repository in parallel, or the reverse.
const runner = await read('scripts/run-all-tests.mjs');

assert.equal(
    runner.split('...environmentFor(args[0])').length - 1,
    2,
    'both spawn helpers in run-all-tests.mjs must merge environmentFor into the child environment'
);
assert.equal(
    runner.includes('env: process.env,'),
    false,
    'a spawn helper still passes the bare environment, so that lane would serve the repository root'
);

// The focused photo group takes the same decision from the same place rather
// than naming the directory itself.
const photoGroup = await read('scripts/run-gallery-photo-checks.mjs');

assert.ok(
    photoGroup.includes('...environmentFor(args[0])'),
    'the photo review group must take the site root from check-lanes, not set SITE_ROOT itself'
);
assert.equal(
    photoGroup.includes('env.SITE_ROOT'),
    false,
    'the photo review group must not set SITE_ROOT for one check of its own accord'
);

// And it must order them after its own build, for the same reason the suite
// does: that group runs strictly in list order, so a site-serving check above
// the build renders a stale artifact or none.
const { photoReviewChecks } = await import('../scripts/run-gallery-photo-checks.mjs');
const photoOrder = photoReviewChecks.map(([, args]) => args[0]);
const photoBuildAt = photoOrder.indexOf('scripts/build-preview-artifact.mjs');

assert.ok(photoBuildAt >= 0, 'the photo review group must build the artifact');

for (const script of publishedSiteScripts) {
    if (photoOrder.includes(script)) {
        assert.ok(
            photoOrder.indexOf(script) > photoBuildAt,
            `${script} renders the published artifact, so the photo review group must run it after its build`
        );
    }
}

// -- 3. A missing artifact says so, in every one of them ------------------
//
// Not just "fails". Every site-serving check must name the problem and the
// remedy, because the alternative is what two of them used to do: read a site
// file before standing up a server and abort with a bare ENOENT for
// `utils.js` or `hidden-athlete-ids.json`, which says nothing about a forgotten
// artifact build.
const { createStaticServer } = await import('../scripts/serve-site.mjs');
const absent = path.join(repoRoot, 'test-artifacts', `no-such-artifact-${process.pid}`);

await assert.rejects(
    createStaticServer({ root: absent, port: 0, silent: true }),
    /not a directory/,
    'a server rooted at a missing directory must refuse rather than serve 404s'
);

for (const script of publishedSiteScripts) {
    const attempt = await runCheck(script, absent);

    assert.notEqual(attempt.code, 0, `${script} must fail when the artifact is missing`);
    assert.match(
        attempt.output,
        /Cannot serve .*: it is not a directory\. A site root pointing at the published artifact needs "node scripts\/build-preview-artifact\.mjs" to have run first\./,
        `${script} must say the artifact build has not run, not fail on whichever ` +
        `site file it opened first. It said: ${attempt.output.slice(0, 600)}`
    );
    assert.equal(
        attempt.output.includes('404'),
        false,
        `${script} must refuse before serving a single 404`
    );
}

// -- 4. The proof: an unpublished runtime entry fails the suite -----------

const carrier = 'tests/gallery-thumbnail-layout.mjs';

assert.ok(browserScripts.includes(carrier), `${carrier} must be a registered browser check`);
assert.ok(publishedSiteScripts.includes(carrier), `${carrier} must be one of the site-serving checks`);

// `gallery.js` is the entry withheld: the carrier asserts on `.gallery-card`
// elements, and nothing else on the page creates them. It must really be on the
// allowlist, or withholding it would prove nothing.
const withheld = 'gallery.js';

assert.ok(publishedSiteEntries.includes(withheld), `${withheld} must be a published entry for this proof to mean anything`);

const artifact = path.join(repoRoot, 'test-artifacts', `published-site-root-${process.pid}`);

try {
    await fs.rm(artifact, { recursive: true, force: true });
    // A copy of the real artifact, which the artifact phase has already built.
    // Copying rather than rebuilding keeps this check at seconds, and it is the
    // same bytes either way.
    await fs.cp(defaultPreviewOutputDir, artifact, { recursive: true });

    // Both directions, because a proof that the carrier fails is worthless
    // without the control showing it passes on a complete artifact. Otherwise
    // any breakage at all would read as the proof succeeding.
    const complete = await runCarrier(artifact);

    assert.equal(complete.code, 0, `the carrier must pass against a complete artifact, exited ${complete.code}:\n${complete.output}`);

    await fs.rm(path.join(artifact, withheld));

    const incomplete = await runCarrier(artifact);

    assert.notEqual(
        incomplete.code,
        0,
        `withholding ${withheld} from the artifact must fail ${carrier}, but it passed. ` +
        'A runtime file left off publishedSiteEntries would 404 in production and no check would notice.'
    );
    assert.ok(
        incomplete.output.length > 0,
        'the failure must say something, or the next reader cannot tell a 404 from a code fault'
    );

    console.log(
        `Published-site browser root contract passed: ${publishedSiteScripts.length} site-serving browser checks ` +
        `derived from source and served the artifact; withholding ${withheld} failed ${carrier} ` +
        `with exit code ${incomplete.code} where the complete artifact passed.`
    );
} finally {
    await fs.rm(artifact, { recursive: true, force: true });
}

function runCarrier(siteRoot) {
    return runCheck(carrier, siteRoot);
}

function runCheck(script, siteRoot) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const child = spawn(process.execPath, [script], {
            cwd: repoRoot,
            env: { ...process.env, SITE_ROOT: siteRoot },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });

        child.stdout.on('data', chunk => chunks.push(chunk.toString()));
        child.stderr.on('data', chunk => chunks.push(chunk.toString()));
        child.on('error', reject);
        // `close`, not `exit`: the output is part of the assertion.
        child.on('close', code => resolve({ code: code ?? 1, output: chunks.join('') }));
    });
}
