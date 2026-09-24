import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { probeFinalizerAccess } from '../scripts/probe-gallery-finalizer-access.mjs';
import { handleWithdrawalFinalizerRequest } from
    '../gallery-admin/src/withdrawal-finalizer-worker.js';

const origin = 'https://family-running-gallery-withdrawal-finalizer-dev.family-running.workers.dev';
const dummy = 'draft_00000000-0000-4000-8000-000000000000';
const url = `${origin}/api/service/drafts/${dummy}/withdrawal-finalizations`;
const configuration = { origin, clientId: 'a'.repeat(32) + '.access',
    clientSecret: 'synthetic-secret-never-log-this-value' };
const expected = { schemaVersion: '1.0',
    status: 'gallery-finalizer-read-only-access-verified',
    anonymousStatus: 401, invalidCredentialStatus: 401, authenticatedStatus: 405 };
const calls = [];
let capabilityCalls = 0;
function forbidden() { capabilityCalls++; throw new Error('No capability may run.'); }
const env = {
    DB: { prepare: forbidden, batch: forbidden },
    PRIVATE_ORIGINALS: { head: forbidden, get: forbidden, delete: forbidden, list: forbidden },
    FINALIZER_ORIGIN: origin, FINALIZER_IDENTITY: `subject:${configuration.clientId}`
};

assert.deepEqual(await probeFinalizerAccess(configuration, { fetchImpl: async (target, init) => {
    assert.equal(target, url);
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    assert.equal(init.redirect, 'manual');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.credentials, 'omit');
    assert.ok(init.signal instanceof AbortSignal);
    const headers = new Headers(init.headers);
    assert.equal(headers.has('Cookie'), false);
    assert.equal(headers.has('X-CSRF-Token'), false);
    calls.push({ target, init });
    if (calls.length === 1) {
        assert.equal(headers.has('CF-Access-Client-Id'), false);
        assert.equal(headers.has('CF-Access-Client-Secret'), false);
        return denied();
    }
    if (calls.length === 2) {
        assert.equal(headers.get('CF-Access-Client-Id'), 'invalid.access');
        assert.equal(headers.get('CF-Access-Client-Secret'), 'invalid');
        return denied();
    }
    assert.equal(calls.length, 3);
    assert.equal(headers.get('CF-Access-Client-Id'), configuration.clientId);
    assert.equal(headers.get('CF-Access-Client-Secret'), configuration.clientSecret);
    return handleWithdrawalFinalizerRequest(new Request(target, init), env, {
        verifyAccessIdentity: async () => ({ type: 'service', subject: configuration.clientId }),
        finalizeGalleryWithdrawal: forbidden
    });
} }), expected);
assert.equal(capabilityCalls, 0, 'Even the real Worker must exit before DB/R2/service access.');
assert.equal(calls.length, 3);
assert.ok(calls.every(call => call.init.signal.aborted));

for (const change of [
    { origin: 'https://attacker.example' }, { origin: origin + '/' },
    { origin: origin + '?next=https://attacker.example' },
    { origin: origin.replace('https:', 'http:') }, { origin: origin + ':443' },
    { origin: origin.replace('https://', 'https://user:password@') },
    { clientId: 'bad.access' }, { clientId: [configuration.clientId] },
    { clientSecret: '' }, { clientSecret: 'short' },
    { clientSecret: 'a'.repeat(2049) }, { clientSecret: 'a'.repeat(16) + '\n' },
    { draftId: 'draft_11111111-1111-4111-8111-111111111111' }, { action: 'withdrawal' }
]) {
    await assert.rejects(probeFinalizerAccess({ ...configuration, ...change }, {
        fetchImpl: forbidden
    }));
}
assert.equal(capabilityCalls, 0);

const responseFaults = [
    () => methodResponse(200), () => methodResponse(201), () => methodResponse(202),
    () => methodResponse(401), () => methodResponse(403), () => methodResponse(404),
    () => methodResponse(503),
    () => methodResponse(302, { Location: origin }),
    () => methodResponse(405, { Location: 'https://attacker.example' }),
    () => methodResponse(405, { 'Cache-Control': 'public' }),
    () => methodResponse(405, { 'Cache-Control': 'x-no-store' }),
    () => methodResponse(405, { Allow: 'GET, POST' }),
    () => methodResponse(405, { 'Content-Type': 'text/html' }),
    () => methodResponse(405, {}, '{"error":"not-found"}'),
    () => methodResponse(405, {}, '{"error":"method-not-allowed","extra":true}'),
    () => methodResponse(405, {}, 'x'.repeat(513)),
    () => ({ status: 405 }),
    () => { throw new Error(configuration.clientSecret); }
];
for (const fault of responseFaults) {
    let count = 0;
    await assert.rejects(probeFinalizerAccess(configuration, { fetchImpl: async () => {
        count++;
        return count < 3 ? denied() : fault();
    } }));
    assert.equal(count, 3, 'No retry or alternate route after a failure.');
}
for (const badDenial of [
    () => methodResponse(405), () => new Response('', { status: 401 }),
    () => new Response('', { status: 302, headers: { Location: origin } })
]) {
    let count = 0;
    await assert.rejects(probeFinalizerAccess(configuration, { fetchImpl: async () => {
        count++; return badDenial();
    } }));
    assert.equal(count, 1, 'Do not transmit the real secret after unexpected anonymous admission.');
}

let stalledSignal;
await assert.rejects(probeFinalizerAccess(configuration, {
    timeoutMilliseconds: 10,
    fetchImpl: (_url, init) => { stalledSignal = init.signal; return new Promise(() => {}); }
}), /timed out/);
assert.equal(stalledSignal.aborted, true);
let bodyCalls = 0;
let bodyCancelled = false;
await assert.rejects(probeFinalizerAccess(configuration, {
    timeoutMilliseconds: 10,
    fetchImpl: async () => ++bodyCalls < 3 ? denied() : methodResponse(405, {},
        new ReadableStream({ cancel() { bodyCancelled = true; } }))
}), /timed out/);
assert.equal(bodyCancelled, true);
assert.equal(bodyCalls, 3);

const workflow = await fs.readFile(new URL(
    '../.github/workflows/gallery-finalizer-access-probe.yml', import.meta.url), 'utf8');
assert.match(workflow, /^on:\s*\n  workflow_dispatch:\s*\n\npermissions:/m);
assert.doesNotMatch(workflow, /inputs:|workflow_call:|push:|pull_request:|schedule:|repository_dispatch:/);
assert.match(workflow, /permissions:\s*\n  contents: read\s*\n\n/);
assert.doesNotMatch(workflow, /write|secrets:\s*inherit|continue-on-error|always\(\)/);
assert.match(workflow, /github.repository == 'johnkevan88888\/family-running' && github.ref == 'refs\/heads\/main'/);
assert.match(workflow, /environment: gallery-finalization/);
assert.match(workflow, /persist-credentials: false/);
assert.match(workflow, /ref: \$\{\{ github.sha \}\}/);
assert.match(workflow, /timeout-minutes: 5/);
assert.deepEqual([...workflow.matchAll(/secrets\.([A-Z_]+)/g)].map(match => match[1]).sort(), [
    'GALLERY_WITHDRAWAL_FINALIZER_ACCESS_CLIENT_ID',
    'GALLERY_WITHDRAWAL_FINALIZER_ACCESS_CLIENT_SECRET', 'GALLERY_WITHDRAWAL_FINALIZER_ORIGIN'
].sort());
assert.deepEqual([...workflow.matchAll(/run: (.+)/g)].map(match => match[1].trim()),
    ['node scripts/probe-gallery-finalizer-access.mjs']);
for (const line of workflow.split(/\r?\n/).filter(line => /uses:/.test(line))) {
    assert.match(line, /@[a-f0-9]{40}(?:\s|$)/);
}
assert.doesNotMatch(workflow, /PUBLIC_HOST_VERIFIER|GALLERY_DRAFT_ID|FINALIZATION_ACTION|wrangler|pnpm|upload-artifact/);

const runner = fileURLToPath(new URL('../scripts/probe-gallery-finalizer-access.mjs', import.meta.url));
const childEnv = { ...process.env,
    GALLERY_WITHDRAWAL_FINALIZER_ORIGIN: origin,
    GALLERY_WITHDRAWAL_FINALIZER_ACCESS_CLIENT_ID: configuration.clientId,
    GALLERY_WITHDRAWAL_FINALIZER_ACCESS_CLIENT_SECRET: configuration.clientSecret };
const fixture = `globalThis.fetch = async (url, init) => {
    if (url !== ${JSON.stringify(url)} || init.method !== 'GET' || init.body !== undefined) throw Error('unsafe');
    const valid = init.headers['CF-Access-Client-Id'] === ${JSON.stringify(configuration.clientId)};
    return new Response(valid ? '${'{"error":"method-not-allowed"}'}' : '', {
        status: valid ? 405 : 401,
        headers: {'Cache-Control':'no-store','Content-Type':'application/json','Allow':'POST'}
    });
};`;
function child(preload, args = [], environment = childEnv) {
    return spawnSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), runner, ...args], {
        encoding: 'utf8', windowsHide: true, env: environment, timeout: 5000
    });
}
const success = child(fixture);
assert.equal(success.status, 0, success.stderr);
assert.equal(success.stdout, JSON.stringify(expected) + '\n');
assert.equal(success.stderr, '');
for (const result of [
    child(`globalThis.fetch = async () => { throw new Error(${JSON.stringify(configuration.clientSecret)}); };`),
    child(fixture, [dummy]),
    child(fixture, [], { ...childEnv, GALLERY_WITHDRAWAL_FINALIZER_ORIGIN: 'https://attacker.example' })
]) {
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Gallery finalizer read-only access probe failed.\n');
    assert.ok(!result.stderr.includes(configuration.clientSecret));
}
console.log('Gallery finalizer access probe: fixed-origin GET-only 401/401/405, zero Worker capabilities, bounded failures, protected workflow and redacted runner tests passed.');

function denied() {
    return new Response('', { status: 401, headers: { 'Cache-Control': 'no-store' } });
}
function methodResponse(status = 405, headers = {}, body = '{"error":"method-not-allowed"}') {
    return new Response(body, { status, headers: {
        'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8',
        Allow: 'POST', ...headers
    } });
}
