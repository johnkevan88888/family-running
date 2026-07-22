import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const analyticsSource = await fs.readFile(path.join(repoRoot, 'analytics.js'), 'utf8');

const local = runAnalytics({
    hostname: '127.0.0.1',
    pathname: '/index.html',
    search: '?site=family'
});
assert.equal(local.scripts.length, 0, 'local previews must not load GoatCounter');
assert.equal(local.window.goatcounter, undefined, 'local previews must not configure GoatCounter');

const netlify = runAnalytics({
    hostname: 'deploy-preview-21--example.netlify.app',
    pathname: '/index.html',
    search: '?site=everyone'
});
assert.equal(netlify.scripts.length, 0, 'Netlify previews must not load GoatCounter');

const unrelatedGithubPage = runAnalytics({
    hostname: 'johnkevan88888.github.io',
    pathname: '/another-site/',
    search: '?site=family'
});
assert.equal(unrelatedGithubPage.scripts.length, 0, 'other GitHub Pages projects must not load GoatCounter');

const family = runAnalytics({
    hostname: 'johnkevan88888.github.io',
    pathname: '/family-running/',
    search: '?site=family&utm_source=test'
});
assertTrackerScript(family.scripts);
assert.equal(family.window.goatcounter.path(), '/family-running/?site=family');

const everyone = runAnalytics({
    hostname: 'johnkevan88888.github.io',
    pathname: '/family-running/records.html',
    search: '?site=everyone'
});
assertTrackerScript(everyone.scripts);
assert.equal(everyone.window.goatcounter.path(), '/family-running/records.html?site=everyone');

const defaultSite = runAnalytics({
    hostname: 'johnkevan88888.github.io',
    pathname: '/family-running',
    search: '?site=unexpected'
});
assert.equal(defaultSite.window.goatcounter.path(), '/family-running/?site=family');

const athlete = runAnalytics({
    hostname: 'johnkevan88888.github.io',
    pathname: '/family-running/athlete.html',
    search: '?id=athlete-42&site=everyone&private=discarded'
});
assert.equal(
    athlete.window.goatcounter.path(),
    '/family-running/athlete.html?site=everyone&id=athlete-42',
    'athlete analytics should retain only the public athlete ID and selected site'
);

console.log('Analytics configuration tests passed.');

function runAnalytics(location) {
    const scripts = [];
    const window = { location: { ...location } };
    const document = {
        createElement(tagName) {
            return { tagName, dataset: {} };
        },
        head: {
            appendChild(script) {
                scripts.push(script);
            }
        }
    };

    vm.runInNewContext(analyticsSource, {
        document,
        URLSearchParams,
        window
    });

    return { scripts, window };
}

function assertTrackerScript(scripts) {
    assert.equal(scripts.length, 1, 'production pages should load one GoatCounter script');
    assert.equal(scripts[0].src, 'https://gc.zgo.at/count.js');
    assert.equal(scripts[0].dataset.goatcounter, 'https://familyrunning.goatcounter.com/count');
    assert.equal(
        'integrity' in scripts[0],
        false,
        'the current GoatCounter loader must not be blocked by a stale integrity pin'
    );
}
