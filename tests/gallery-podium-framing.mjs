import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import framing from '../gallery-podium-framing.js';
import { validateGalleryPodiumFramingTree } from '../scripts/validate-gallery-podium-framing.mjs';

const { validateDocument, keyFor, layout } = framing;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = 'a'.repeat(64);
const frame = { x: 50, y: 20, zoom: 2 };
const documentFor = value => ({ schemaVersion: '1.0', frames: { [digest]: value } });
const photo = {
    id: 'synthetic-photo', type: 'photo', title: 'Synthetic group',
    sourceUrl: 'https://media.example.invalid/generation-one/display.webp',
    thumbnailUrl: 'https://media.example.invalid/generation-one/thumbnail.webp',
    athleteIds: ['runner-one', 'runner-two']
};

assert.equal(globalThis.galleryPodiumFraming, framing, 'CommonJS and global API are the same contract');
assert.deepEqual(Object.keys(framing).sort(), ['browserScript', 'keyFor', 'layout', 'validateDocument']);
const protectedBrowser = vm.createContext({ crypto: webcrypto, TextEncoder, URL });
vm.runInContext(framing.browserScript(), protectedBrowser);
assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext(
    `galleryPodiumFraming.layout(${JSON.stringify(frame)},400,800,100,100)`, protectedBrowser))),
    layout(frame, 400, 800, 100, 100),
    'protected uploader and public runtime use the same self-contained geometry');
assert.equal(await vm.runInContext(`galleryPodiumFraming.keyFor(${JSON.stringify(photo)},'runner-one')`, protectedBrowser),
    await keyFor(photo, 'runner-one'), 'protected shared runtime retains exact generation binding');
assert.deepEqual(validateDocument({ schemaVersion: '1.0', frames: {} }), []);
assert.deepEqual(validateDocument(documentFor(frame)), []);
assert.deepEqual(validateDocument(documentFor({ x: 0, y: 100, zoom: 8 })), []);
assert.deepEqual(validateDocument({ schemaVersion: '1.0', frames: Object.create(null) }), []);

for (const value of [null, [], 'private name', 12, Object.create({ schemaVersion: '1.0', frames: {} })]) {
    assert.ok(validateDocument(value).length, 'malformed or inherited document rejected');
}
for (const value of [
    {}, { schemaVersion: '2.0', frames: {} }, { schemaVersion: '1.0' },
    { schemaVersion: '1.0', frames: [] }, { schemaVersion: '1.0', frames: null },
    { schemaVersion: '1.0', frames: {}, names: ['Private person'] },
    { schemaVersion: '1.0', frames: { 'runner-one': frame } },
    { schemaVersion: '1.0', frames: { 'https://example.invalid/photo': frame } },
    { schemaVersion: '1.0', frames: { ['A'.repeat(64)]: frame } },
    JSON.parse('{"schemaVersion":"1.0","frames":{"__proto__":{"x":1,"y":1,"zoom":1}}}')
]) assert.ok(validateDocument(value).length, 'wrong schema, privacy fields or non-digest keys rejected');

for (const value of [
    null, [], {}, { ...frame, x: '50' }, { ...frame, y: null },
    { ...frame, x: -1 }, { ...frame, x: 100.00001 }, { ...frame, y: NaN },
    { ...frame, y: Infinity }, { ...frame, zoom: -1 }, { ...frame, zoom: 0.99 },
    { ...frame, zoom: 8.00001 }, { ...frame, zoom: Infinity },
    { ...frame, athleteId: 'runner-one' }, { ...frame, name: 'Private name' },
    { ...frame, sourceUrl: photo.sourceUrl }, { ...frame, faceDetected: true },
    Object.create(frame)
]) assert.ok(validateDocument(documentFor(value)).length, 'bad geometry/privacy fields/custom prototypes rejected');

for (const target of ['document', 'frames', 'frame']) {
    for (const property of ['accessor', 'symbol', 'hidden']) {
        const value = documentFor({ ...frame });
        const record = target === 'document' ? value : target === 'frames' ? value.frames : value.frames[digest];
        let getterCalled = false;
        if (property === 'accessor') Object.defineProperty(record, 'unsafe', { enumerable: true, get() {
            getterCalled = true; throw new Error('Accessor must not execute');
        } });
        if (property === 'symbol') record[Symbol('unsafe')] = 'private';
        if (property === 'hidden') Object.defineProperty(record, 'unsafe', { value: 'private', enumerable: false });
        assert.ok(validateDocument(value).length);
        assert.equal(getterCalled, false, 'validation never executes accessors');
    }
}
const tooMany = Object.fromEntries(Array.from({ length: 2001 }, (_, index) => [
    index.toString(16).padStart(64, '0'), frame
]));
assert.match(validateDocument({ schemaVersion: '1.0', frames: tooMany }).join('\n'), /no more than 2000/);
delete tooMany[(2000).toString(16).padStart(64, '0')];
assert.deepEqual(validateDocument({ schemaVersion: '1.0', frames: tooMany }), [], 'exactly 2000 inert digests allowed');

const expectedKey = createHash('sha256').update(JSON.stringify([
    'gallery-podium-framing-v1', photo.id, 'runner-one', photo.sourceUrl, photo.thumbnailUrl
]), 'utf8').digest('hex');
assert.equal(await keyFor(photo, 'runner-one'), expectedKey);
assert.match(expectedKey, /^[a-f0-9]{64}$/);
assert.notEqual(await keyFor(photo, 'runner-two'), expectedKey, 'group photos have athlete-specific crops');
for (const changed of [
    { ...photo, id: 'new-photo' },
    { ...photo, sourceUrl: 'https://media.example.invalid/generation-two/display.webp' },
    { ...photo, thumbnailUrl: 'https://media.example.invalid/generation-two/thumbnail.webp' }
]) assert.notEqual(await keyFor(changed, 'runner-one'), expectedKey, 'new item or URL generation cannot reuse an old crop');
for (const [item, athlete] of [
    [null, 'runner-one'], [Object.create(photo), 'runner-one'],
    [{ ...photo, type: 'video' }, 'runner-one'], [{ ...photo, id: 'Bad ID' }, 'runner-one'],
    [photo, 'runner-three'], [photo, 'Runner One'], [photo, ''],
    [{ ...photo, athleteIds: [] }, 'runner-one'],
    [{ ...photo, athleteIds: ['runner-one', 'runner-one'] }, 'runner-one'],
    [{ ...photo, athleteIds: ['runner-one', 4] }, 'runner-one'],
    [{ ...photo, sourceUrl: 'http://media.example.invalid/a' }, 'runner-one'],
    [{ ...photo, sourceUrl: 'https://name:secret@media.example.invalid/a' }, 'runner-one'],
    [{ ...photo, thumbnailUrl: 'javascript:alert(1)' }, 'runner-one'],
    [{ ...photo, thumbnailUrl: ' https://media.example.invalid/a' }, 'runner-one']
]) await assert.rejects(keyFor(item, athlete), /public photo/);

assert.deepEqual(layout(null, 400, 800, 100, 100), { left: 25, top: 0, width: 50, height: 100 });
assert.deepEqual(layout(null, 800, 400, 100, 100), { left: 0, top: 25, width: 100, height: 50 });
assert.deepEqual(layout(null, 400, 400, 100, 100), { left: 0, top: 0, width: 100, height: 100 });
assert.deepEqual(layout(null, 1200, 200, 120, 120), { left: 0, top: 50, width: 120, height: 20 });
assert.deepEqual(layout({ x: 50, y: 20, zoom: 1 }, 400, 800, 100, 100),
    { left: 0, top: 0, width: 100, height: 200 });
assert.deepEqual(layout({ x: 50, y: 20, zoom: 2 }, 400, 800, 100, 100),
    { left: -50, top: -30, width: 200, height: 400 });
const groupLeft = layout({ x: 10, y: 50, zoom: 1 }, 1200, 200, 100, 100);
const groupRight = layout({ x: 90, y: 50, zoom: 1 }, 1200, 200, 100, 100);
assert.deepEqual(groupLeft, { left: -10, top: 0, width: 600, height: 100 });
assert.deepEqual(groupRight, { left: -490, top: 0, width: 600, height: 100 });
assert.notEqual(groupLeft.left, groupRight.left, 'wide group can focus either tagged athlete');

for (const dimensions of [[400, 800, 100, 100], [1200, 200, 63, 94], [333, 333, 94, 73], [1e200, 1e200, 1e100, 1e100]]) {
    for (const x of [0, 12.5, 50, 100]) for (const y of [0, 25, 100]) for (const zoom of [1, 2, 8]) {
        const actual = layout({ x, y, zoom }, ...dimensions);
        const [,, boxWidth, boxHeight] = dimensions;
        const epsilon = Math.max(boxWidth, boxHeight) * 1e-12;
        assert.ok(Object.values(actual).every(Number.isFinite));
        assert.ok(actual.left <= epsilon && actual.top <= epsilon);
        assert.ok(actual.left + actual.width >= boxWidth - epsilon, 'saved frames never leave horizontal gaps');
        assert.ok(actual.top + actual.height >= boxHeight - epsilon, 'saved frames never leave vertical gaps');
    }
}
for (const invalid of [0, -1, NaN, Infinity, '100', undefined]) for (let index = 0; index < 4; index++) {
    const dimensions = [400, 800, 100, 100];
    dimensions[index] = invalid;
    assert.throws(() => layout(null, ...dimensions), /positive finite/);
}
assert.throws(() => layout(undefined, 400, 800, 100, 100), /plain JSON/);
assert.throws(() => layout({ ...frame, zoom: 9 }, 400, 800, 100, 100), /zoom/);
assert.throws(() => layout(frame, 1e-300, 1e300, 1e300, 1e300), /finite positive/);
assert.throws(() => layout(null, 1e300, 1e300, 1e-300, 1e-300), /finite positive/);

// A browser global executes the exact same module and hash/geometry contract;
// the fixture realm owns its JSON records, as actual browser JSON.parse does.
const source = await fs.readFile(path.join(root, 'gallery-podium-framing.js'), 'utf8');
const browser = vm.createContext({ crypto: webcrypto, TextEncoder, URL, input: JSON.stringify(photo) });
vm.runInContext('window = globalThis', browser);
vm.runInContext(source, browser);
assert.equal(vm.runInContext('window.galleryPodiumFraming === globalThis.galleryPodiumFraming', browser), true);
assert.equal(await vm.runInContext('galleryPodiumFraming.keyFor(JSON.parse(input), "runner-one")', browser), expectedKey);
assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(galleryPodiumFraming.layout({x:50,y:20,zoom:2},400,800,100,100))', browser)),
    layout(frame, 400, 800, 100, 100));
assert.equal(vm.runInContext('galleryPodiumFraming.validateDocument(JSON.parse(\'{"schemaVersion":"1.0","frames":{}}\')).length', browser), 0);
const insecureBrowser = vm.createContext({ TextEncoder, URL, input: JSON.stringify(photo) });
vm.runInContext(source, insecureBrowser);
await assert.rejects(vm.runInContext('galleryPodiumFraming.keyFor(JSON.parse(input), "runner-one")', insecureBrowser),
    /Secure SHA-256 support is required/, 'no weak or unhashed identity fallback');

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gallery-podium-framing-test-'));
try {
    assert.match((await validateGalleryPodiumFramingTree(temporaryRoot)).join('\n'), /could not read/);
    const configPath = path.join(temporaryRoot, 'gallery-podium-framing.json');
    await fs.writeFile(configPath, '{ broken JSON');
    assert.match((await validateGalleryPodiumFramingTree(temporaryRoot)).join('\n'), /could not read valid JSON/);
    await fs.writeFile(configPath, JSON.stringify(documentFor(frame)));
    assert.deepEqual(await validateGalleryPodiumFramingTree(temporaryRoot), [], 'orphan hashes remain inert and valid without any media/manifest');
    await fs.writeFile(configPath, JSON.stringify({ ...documentFor(frame), privateNotes: 'not public' }));
    assert.match((await validateGalleryPodiumFramingTree(temporaryRoot)).join('\n'), /unsupported field/);
    await fs.writeFile(configPath, ' '.repeat(512 * 1024 + 1));
    assert.match((await validateGalleryPodiumFramingTree(temporaryRoot)).join('\n'), /no larger than/);
} finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
}
assert.deepEqual(await validateGalleryPodiumFramingTree(root), []);
console.log('Gallery podium framing contract, privacy, key binding, geometry, browser parity and tree validation passed.');
