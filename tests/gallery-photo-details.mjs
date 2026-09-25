import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { createStaticServer } from '../scripts/serve-site.mjs';
import { findChromiumExecutable, loadPlaywright } from '../scripts/browser-runtime.mjs';
const require = createRequire(import.meta.url);
const { buildIndex: buildResultIndex } = require('../gallery-results.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const utilityContext = vm.createContext({ window: {} });
vm.runInContext(await fs.readFile(path.join(root,'utils.js'),'utf8'), utilityContext);
const buildIndex = (...args) => buildResultIndex(...args, utilityContext.csvRowsToObjects);
const header = ['AthleteID','Participant','Date','Distance','Time','AgeGrade','Event','TimeClass','AgeAtRace','ExportBundleID'];
const event = 'Synthetic Park, Lakeside';
const source = [header,
    ['runner-one','Runner One','22/08/2026','5 km','00:22:31','62.9%',event,'Official','46','fixture'],
    ['runner-two','Runner Two','22/08/2026','5 km','00:24:12.345','71.123%',event,'Official','29','fixture'],
    ['supporter','Supporter <img src=x onerror=alert(1)>','21/08/2026','10 km','00:55:00','52.1%',event,'Official','38','fixture']];
const roster = [['AthleteId','ExportBundleID'], ...source.slice(1).map(row => [row[0],'fixture'])];
const manifest = (site, count = source.length - 1) => [
    ['ExportBundleID','SchemaVersion','Scope','RelativePath','DataRowCount'],
    ['fixture','1.0','shared','data/athlete_results.csv',String(count)],
    ['fixture','1.0',site,`data/${site}/age_grade_standards.csv`,String(roster.length - 1)]];
const item = { id: 'photo-details-test', type: 'photo', title: 'Do not display editorial title',
    caption: 'Do not display editorial caption', alt: 'Synthetic complete portrait',
    raceDate: '2026-08-22', raceEvent: event, raceDistance: '5 km',
    sourceUrl: 'https://media.example.com/details.svg', thumbnailUrl: 'https://media.example.com/details.svg',
    featured: false, athleteIds: ['runner-one','runner-two','supporter'] };
const lookup = (rows = source) => buildIndex(rows, roster, manifest('family', rows.length - 1), 'family');
assert.deepEqual(lookup().forPhoto(item), [
    { name: 'Runner One', time: '00:22:31', ageGrade: '62.9%', age: '46' },
    { name: 'Runner Two', time: '00:24:12.345', ageGrade: '71.123%', age: '29' },
    { name: source[3][1], time: 'Unavailable', ageGrade: 'Unavailable', age: 'Unavailable' }]);
assert.equal(lookup([...source, source[1]]).forPhoto(item)[0].time, 'Unavailable', 'ambiguous result must not pick first');
for (const change of [{raceDate:'2026-08-23'},{raceEvent:'Different race'},{raceDistance:'10 km'}]) {
    assert.equal(lookup().forPhoto({...item,...change})[0].age, 'Unavailable');
}
const legacy = source.map(row => row.filter((_, i) => i !== 8));
assert.equal(lookup(legacy).forPhoto(item)[0].age, 'Unavailable');
assert.equal(lookup(legacy).forPhoto(item)[0].time, '00:22:31');
for (const age of ['', 'M46', '-1', '46.1', '046', '131', '#VALUE!']) {
    const rows = structuredClone(source); rows[1][8] = age;
    assert.throws(() => lookup(rows), /Invalid exported performance/);
}
for (const change of [rows => rows[1][9] = 'stale', rows => rows[0].push('unexpected'),
    rows => rows[1][2] = '31/02/2026', rows => rows.push(header.map(() => ''))]) {
    const rows = structuredClone(source); change(rows); assert.throws(() => lookup(rows));
}
assert.throws(() => buildIndex(source, roster, manifest('family', 99), 'family'));
assert.throws(() => buildIndex(source, roster, manifest('everyone'), 'family'));
const differentRoster = [roster[0], ['runner-two','fixture'], ['supporter','fixture']];
const differentManifest = manifest('family'); differentManifest[2][4] = '2';
assert.equal(buildIndex(source, differentRoster, differentManifest, 'family').forPhoto(item)[0].name, 'Athlete unavailable');
const csv = rows => rows.map(row => row.map(value => `"${value.replaceAll('"','""')}"`).join(',')).join('\r\n');
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="480"><rect width="360" height="480" fill="#246080"/><circle cx="180" cy="80" r="50" fill="white"/></svg>';
const server = await createStaticServer({ root, port: 0, silent: true });
const { chromium } = loadPlaywright();
let browser;
try {
    browser = await chromium.launch({ headless: true, executablePath: findChromiumExecutable(), args: ['--disable-dev-shm-usage'] });
    await fs.mkdir(path.join(root,'test-artifacts','screenshots'), {recursive:true});
    for (const site of ['family','everyone']) {
        for (const mobile of [false,true]) {
            const context = await browser.newContext(mobile
                ? {viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:3}
                : {viewport:{width:1440,height:1000}});
            async function scenario({hidden = [], brokenSuppression = false, stale = false} = {}) {
                const page = await context.newPage();
                let mediaRequests = 0, resultRequests = 0;
                await page.route('**/gallery-data/*.json', route => {
                    const file = new URL(route.request().url()).pathname.split('/').pop();
                    assert.ok([`${site}.json`,'hidden-athlete-ids.json'].includes(file));
                    return route.fulfill({contentType:'application/json',body:JSON.stringify(file === 'hidden-athlete-ids.json'
                        ? (brokenSuppression ? {} : {schemaVersion:'1.0',hiddenAthleteIds:hidden})
                        : {schemaVersion:'1.0',items:[item]})});
                });
                await page.route('**/data/**/*.csv', route => {
                    const file = new URL(route.request().url()).pathname.slice(1);
                    if (file === `data/${site}/siteinfo.csv`) return route.continue();
                    assert.ok(['data/athlete_results.csv','data/export_manifest.csv',`data/${site}/age_grade_standards.csv`].includes(file));
                    resultRequests++;
                    const rows = file === 'data/athlete_results.csv' ? structuredClone(source)
                        : file === 'data/export_manifest.csv' ? manifest(site) : roster;
                    if (stale && file === 'data/athlete_results.csv') rows[1][9] = 'stale';
                    return route.fulfill({contentType:'text/csv',body:csv(rows)});
                });
                await page.route('https://media.example.com/**', route => {
                    mediaRequests++; return route.fulfill({contentType:'image/svg+xml',body:svg});
                });
                return {page, requests: () => ({mediaRequests, resultRequests})};
            }
            const {page} = await scenario();
            const url = `${server.baseUrl}/gallery.html?site=${site}`;
            await page.goto(url);
            await page.locator('.gallery-photo-athlete').last().waitFor();
            const copy = page.locator('.gallery-card-copy');
            assert.equal(await copy.locator('h4').count(), 3);
            assert.deepEqual(await copy.locator('dd').allTextContents(), ['00:22:31','62.9%','46','00:24:12.345','71.123%','29','Unavailable','Unavailable','Unavailable']);
            assert.ok((await copy.innerText()).includes(source[3][1]));
            assert.equal(await copy.locator('img').count(), 0, 'CSV text must never become HTML');
            assert.doesNotMatch(await copy.innerText(), /editorial|Official|Age category/);
            assert.equal(await page.locator('.gallery-card-type').count(), 0);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
            await page.screenshot({path:path.join(root,'test-artifacts','screenshots',`gallery-details-${site}-${mobile?'mobile':'desktop'}.png`),fullPage:true,scale:'css'});
            await page.locator('.gallery-card-open').click();
            assert.equal(await page.locator('#gallery-viewer-title').innerText(), event);
            assert.deepEqual(await page.locator('#gallery-viewer-copy dd').allTextContents(), await copy.locator('dd').allTextContents());
            assert.doesNotMatch(await page.locator('#gallery-viewer-copy').innerText(), /editorial/);
            await page.keyboard.press('Escape');
            await page.close();
            const {page: stalePage} = await scenario({stale:true});
            await stalePage.goto(url); await stalePage.locator('.gallery-photo-athlete').last().waitFor();
            assert.ok((await stalePage.locator('.gallery-photo-athlete dd').allTextContents()).every(text => text === 'Unavailable'));
            await stalePage.close();
            for (const bad of [false,true]) {
                // Fresh page and counters: late lazy-image requests from a previous
                // unsuppressed document must not contaminate this privacy assertion.
                const isolated = await scenario({hidden:['runner-one'],brokenSuppression:bad});
                await isolated.page.goto(url);
                await isolated.page.locator(bad ? '.gallery-status.is-error' : '.gallery-status.is-empty').waitFor();
                assert.equal(await isolated.page.locator('.gallery-card').count(),0);
                assert.equal(isolated.requests().mediaRequests,0, 'suppress before constructing/requesting media');
                assert.equal(isolated.requests().resultRequests,0, 'no result reads for suppressed photos');
                await isolated.page.close();
            }
            await context.close();
        }
    }
} finally { await browser?.close(); await server.close(); }
console.log('Gallery photo details passed: exact result matching, exported age/AG, ambiguity, legacy, stale data, escaping, suppression, both modes and responsive viewer.');
