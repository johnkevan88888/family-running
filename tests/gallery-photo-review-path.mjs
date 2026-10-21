import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
    assessPhotoOnlyDiff,
    classifyPhotoReview
} from '../scripts/classify-gallery-photo-review.mjs';

// Fictional public metadata only. No service call, original, stock photograph,
// credential, network request or real-media decoding is used by this suite.
const origin = 'https://family-running-gallery-media-dev.family-running.workers.dev';
const canonical = document => `${JSON.stringify(document, null, 2)}\n`;
const clone = value => JSON.parse(JSON.stringify(value));
const empty = {schemaVersion: '1.0', items: []};
const suppression = {schemaVersion: '1.0', hiddenAthleteIds: []};
const generation = '11111111-1111-4111-8111-111111111111';
const nextGeneration = '22222222-2222-4222-8222-222222222222';
const thirdGeneration = '33333333-3333-4333-8333-333333333333';
function photo(id, publicGeneration, digit) {
    return {
        id: `photo-${id}`,
        type: 'photo',
        title: 'Fictional review photo',
        caption: '',
        alt: 'Generated test photo',
        raceDate: '2026-08-22',
        raceEvent: 'Fictional test race',
        raceDistance: '5 km',
        sourceUrl: `${origin}/media/v2/${publicGeneration}/${digit.repeat(64)}/display.webp`,
        thumbnailUrl: `${origin}/media/v2/${publicGeneration}/${String(Number(digit) + 1).repeat(64)}/thumbnail.webp`,
        featured: false,
        athleteIds: ['fictional-runner'],
        podiumFraming: {'fictional-runner': {x: 50, y: 25, zoom: 2}}
    };
}
const oldPhoto = photo('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', generation, '1');
const newPhoto = photo('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', nextGeneration, '3');
const otherPhoto = photo('cccccccc-cccc-4ccc-8ccc-cccccccccccc', thirdGeneration, '5');
const baseDocument = {schemaVersion: '1.0', items: [oldPhoto]};
const headDocument = {schemaVersion: '1.0', items: [oldPhoto, newPhoto]};
const baseline = {
    changedEntries: [{status: 'M', path: 'gallery-data/family.json'}],
    baseText: canonical(baseDocument),
    headText: canonical(headDocument),
    otherText: canonical(empty),
    suppressionText: canonical(suppression)
};
let cases = 0;
function check(name, values, expected = 'full') {
    const result = assessPhotoOnlyDiff({...baseline, ...values});
    assert.equal(result.suite, expected, name);
    assert.equal(typeof result.reason, 'string', `${name}: explanation is present`);
    assert(result.reason.length > 0, `${name}: explanation is nonempty`);
    cases += 1;
}
function changedPhoto(change) {
    const candidate = clone(headDocument);
    change(candidate.items[1], candidate);
    return {headText: canonical(candidate)};
}

check('Family exact one-photo append', {}, 'photo-only');
check('Everyone exact one-photo append', {
    changedEntries: [{status: 'M', path: 'gallery-data/everyone.json'}]
}, 'photo-only');
check('First photo in an empty area', {
    baseText: canonical(empty),
    headText: canonical({schemaVersion: '1.0', items: [newPhoto]})
}, 'photo-only');
check('Framing may be absent', changedPhoto(item => delete item.podiumFraming), 'photo-only');
check('Unrelated hidden person does not hide this photo', {
    suppressionText: canonical({schemaVersion: '1.0', hiddenAthleteIds: ['different-person']})
}, 'photo-only');
check('Unrelated valid opposite-area photo is preserved', {
    otherText: canonical({schemaVersion: '1.0', items: [otherPhoto]})
}, 'photo-only');

check('No changed path', {changedEntries: []});
check('Both public manifests changed', {changedEntries: [
    ...baseline.changedEntries, {status: 'M', path: 'gallery-data/everyone.json'}
]});
for (const extra of ['docs/active-work.md', 'gallery.js', '.github/workflows/pr-checks.yml',
    'scripts/classify-gallery-photo-review.mjs', 'data/athlete_results.csv',
    'gallery-data/hidden-athlete-ids.json', 'gallery-podium-framing.json',
    'gallery-admin/generated/catalog-snapshot.js', 'package.json', 'pnpm-lock.yaml']) {
    check(`Mixed manifest and ${extra}`, {changedEntries: [...baseline.changedEntries, {status: 'M', path: extra}]});
}
for (const status of ['A', 'D', 'R100', 'C100', 'T', 'U', '', null]) {
    check(`Not an existing regular manifest modification (${status})`, {
        changedEntries: [{status, path: 'gallery-data/family.json'}]
    });
}
for (const value of ['gallery-data/../gallery-data/family.json', 'gallery-data\\family.json',
    'Gallery-data/family.json', './gallery-data/family.json', 'gallery-data/family.json\n']) {
    check(`No path normalization (${JSON.stringify(value)})`, {changedEntries: [{status: 'M', path: value}]});
}
check('No-op document is not a photo append', {headText: canonical(baseDocument)});
check('Removal is not a new-photo review', {headText: canonical(empty)});
check('Insertion is deliberately left to the full suite', {
    headText: canonical({schemaVersion: '1.0', items: [newPhoto, oldPhoto]})
});
const twoPhotoDocument = {schemaVersion: '1.0', items: [oldPhoto, newPhoto, otherPhoto]};
check('Two queued photos appended in one same-area manifest', {headText: canonical(twoPhotoDocument)}, 'photo-only');
function generatedBatch(count) {
    return Array.from({length: count}, (_unused, index) => photo(
        `${(index + 100).toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
        `${(index + 100).toString(16).padStart(8, '0')}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
        '3'
    ));
}
check('Twenty appended photos is the bounded batch maximum', {
    headText: canonical({schemaVersion: '1.0', items: [oldPhoto, ...generatedBatch(20)]})
}, 'photo-only');
check('Twenty-one appended photos is full suite', {
    headText: canonical({schemaVersion: '1.0', items: [oldPhoto, ...generatedBatch(21)]})
});
function changedSecondPhoto(change) {
    const candidate = clone(twoPhotoDocument);
    change(candidate.items[2], candidate);
    return {headText: canonical(candidate)};
}
check('Every queued photo must be a photo', changedSecondPhoto(item => {item.type = 'video'; delete item.podiumFraming;}));
check('Every queued photo must have public tags', changedSecondPhoto(item => {item.athleteIds = []; delete item.podiumFraming;}));
check('Every queued photo UUID is validated', changedSecondPhoto(item => {item.id = 'photo-not-a-uuid';}));
check('Second queued photo cannot repeat first item ID', changedSecondPhoto(item => {item.id = newPhoto.id;}));
check('Second queued photo cannot reuse first display URL', changedSecondPhoto(item => {item.sourceUrl = newPhoto.sourceUrl;}));
check('Second queued photo cannot reuse first thumbnail URL', changedSecondPhoto(item => {item.thumbnailUrl = newPhoto.thumbnailUrl;}));
check('Second queued photo cannot reuse first generation with different hashes', changedSecondPhoto(item => {
    item.sourceUrl = item.sourceUrl.replace(thirdGeneration, nextGeneration);
    item.thumbnailUrl = item.thumbnailUrl.replace(thirdGeneration, nextGeneration);
}));
check('Suppression applies independently to every appended photo', {
    ...changedSecondPhoto(item => {item.athleteIds = ['hidden-person']; delete item.podiumFraming;}),
    suppressionText: canonical({schemaVersion: '1.0', hiddenAthleteIds: ['hidden-person']})
});
check('Second queued photo cannot have private extra fields', changedSecondPhoto(item => {item.privateConsent = 'not-public';}));
check('Second queued photo cannot use a different media origin', changedSecondPhoto(item => {
    item.sourceUrl = item.sourceUrl.replace(origin, 'https://unapproved.invalid');
}));
check('Second queued photo cannot reference an old generation', changedSecondPhoto(item => {
    item.sourceUrl = item.sourceUrl.replace(thirdGeneration, generation);
    item.thumbnailUrl = item.thumbnailUrl.replace(thirdGeneration, generation);
}));
check('Old title edit', changedPhoto((_item, document) => {document.items[0].title = 'Changed old title';}));
check('Old framing edit', changedPhoto((_item, document) => {document.items[0].podiumFraming['fictional-runner'].x = 51;}));
check('Old item removed and replaced', {headText: canonical({schemaVersion: '1.0', items: [otherPhoto, newPhoto]})});
check('Old item order must remain exact', {
    baseText: canonical({schemaVersion: '1.0', items: [oldPhoto, otherPhoto]}),
    headText: canonical({schemaVersion: '1.0', items: [otherPhoto, oldPhoto, newPhoto]})
});

for (const field of ['baseText', 'headText', 'otherText', 'suppressionText']) {
    check(`${field} malformed JSON`, {[field]: '{broken'});
    check(`${field} is not a document`, {[field]: 'null\n'});
}
check('Noncanonical candidate whitespace', {headText: JSON.stringify(headDocument)});
check('Oversized candidate body', {headText: ' '.repeat(1024 * 1024 + 1)});
check('Duplicate root JSON key', {headText: canonical(headDocument).replace('"schemaVersion": "1.0",', '"schemaVersion": "1.0",\n  "schemaVersion": "1.0",')});
check('Extra candidate root metadata', {headText: canonical({...headDocument, privateNote: 'not public'})});
check('Extra base root metadata', {baseText: canonical({...baseDocument, privateNote: 'not public'})});
check('Extra opposite root metadata', {otherText: canonical({...empty, privateNote: 'not public'})});
check('Extra suppression metadata', {suppressionText: canonical({...suppression, reasons: ['private']})});
check('Unsupported schema', {headText: canonical({...headDocument, schemaVersion: '2.0'})});
check('Video is not a photo-only review', changedPhoto(item => {item.type = 'video'; delete item.podiumFraming;}));
check('New unknown private field', changedPhoto(item => {item.privatePersonId = 'private-person';}));
check('Invalid photo UUID', changedPhoto(item => {item.id = 'photo-not-a-uuid';}));
check('Reused old item identity', changedPhoto(item => {item.id = oldPhoto.id;}));
check('No complete public tags', changedPhoto(item => {item.athleteIds = []; delete item.podiumFraming;}));
check('Malformed athlete ID', changedPhoto(item => {item.athleteIds = ['Not public']; delete item.podiumFraming;}));
check('Duplicate athlete tags', changedPhoto(item => {item.athleteIds.push('fictional-runner');}));
check('Suppressed new athlete', {suppressionText: canonical({schemaVersion: '1.0', hiddenAthleteIds: ['fictional-runner']})});
check('Malformed suppression list', {suppressionText: canonical({schemaVersion: '1.0', hiddenAthleteIds: 'fictional-runner'})});
check('Unmapped framing tag', changedPhoto(item => {item.podiumFraming['private-person'] = {x: 1, y: 1, zoom: 1};}));
check('String framing value', changedPhoto(item => {item.podiumFraming['fictional-runner'].x = '50';}));
check('Private framing data', changedPhoto(item => {item.podiumFraming['fictional-runner'].name = 'Not allowed';}));
check('Out of bounds zoom', changedPhoto(item => {item.podiumFraming['fictional-runner'].zoom = 9;}));

for (const [name, transform] of [
    ['wrong origin', url => url.replace(origin, 'https://unapproved.invalid')],
    ['credentials', url => url.replace('https://', 'https://user:secret@')],
    ['HTTP', url => url.replace('https:', 'http:')],
    ['query', url => `${url}?token=not-allowed`],
    ['fragment', url => `${url}#not-allowed`],
    ['default-port normalization', url => url.replace('.dev/', '.dev:443/')],
    ['uppercase host normalization', url => url.replace('family-running-gallery-media-dev', 'FAMILY-RUNNING-GALLERY-MEDIA-DEV')],
    ['encoded path', url => url.replace('/media/', '/%6dedia/')],
    ['dot-segment path', url => url.replace('/media/', '/discard/../media/')],
    ['legacy version', url => url.replace('/v2/', '/v1/')],
    ['invalid generation', url => url.replace(nextGeneration, 'not-a-generation')],
    ['invalid hash', url => url.replace('3'.repeat(64), 'not-a-content-hash')],
    ['wrong role', url => url.replace('display.webp', 'thumbnail.webp')]
]) {
    check(`Source URL ${name}`, changedPhoto(item => {item.sourceUrl = transform(item.sourceUrl);}));
}
check('Thumbnail role swapped', changedPhoto(item => {item.thumbnailUrl = item.thumbnailUrl.replace('thumbnail.webp', 'display.webp');}));
check('Thumbnail generation differs', changedPhoto(item => {item.thumbnailUrl = item.thumbnailUrl.replace(nextGeneration, thirdGeneration);}));
check('Display and thumbnail content hashes are distinct', changedPhoto(item => {item.thumbnailUrl = item.thumbnailUrl.replace('4'.repeat(64), '3'.repeat(64));}));
check('Both derivatives reusing old generation', changedPhoto(item => {
    item.sourceUrl = item.sourceUrl.replace(nextGeneration, generation);
    item.thumbnailUrl = item.thumbnailUrl.replace(nextGeneration, generation);
}));
check('Reused old source URL', changedPhoto(item => {item.sourceUrl = oldPhoto.sourceUrl;}));
check('Reused old thumbnail URL', changedPhoto(item => {item.thumbnailUrl = oldPhoto.thumbnailUrl;}));
check('Opposite-area item identity collision', {otherText: canonical({schemaVersion: '1.0', items: [newPhoto]})});
check('Opposite-area source URL collision', {
    otherText: canonical({schemaVersion: '1.0', items: [{...otherPhoto, sourceUrl: newPhoto.sourceUrl}]})
});
check('Opposite-area thumbnail URL collision', {
    otherText: canonical({schemaVersion: '1.0', items: [{...otherPhoto, thumbnailUrl: newPhoto.thumbnailUrl}]})
});
check('Opposite-area generation collision even with new hashes', {
    otherText: canonical({schemaVersion: '1.0', items: [photo('cccccccc-cccc-4ccc-8ccc-cccccccccccc', nextGeneration, '5')]})
});

const temporaryParent = path.resolve(os.tmpdir());
const temporaryRoot = await fs.mkdtemp(path.join(temporaryParent, 'family-photo-review-path-'));
assert(path.resolve(temporaryRoot).startsWith(`${temporaryParent}${path.sep}`));
assert(path.basename(temporaryRoot).startsWith('family-photo-review-path-'));
function git(args, input) {
    return execFileSync('git', ['-c', `safe.directory=${temporaryRoot}`, '-C', temporaryRoot, ...args], {
        encoding: 'utf8', input, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
        env: {...process.env, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
            GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z'}
    }).trim();
}
function blob(text) { return git(['hash-object', '-w', '--stdin'], text); }
function tree(entries) {
    return git(['mktree'], entries.map(entry => `${entry.mode} ${entry.type} ${entry.sha}\t${entry.name}\n`).join(''));
}
function makeTree({family = baseline.baseText, everyone = canonical(empty), hidden = baseline.suppressionText,
    readme = 'Synthetic local Git fixture only.\n', familyMode = '100644', familyType = 'blob', familyObject = null} = {}) {
    const gallery = tree([
        {mode: '100644', type: 'blob', sha: blob(everyone), name: 'everyone.json'},
        {mode: familyMode, type: familyType, sha: familyObject || blob(family), name: 'family.json'},
        {mode: '100644', type: 'blob', sha: blob(hidden), name: 'hidden-athlete-ids.json'}
    ]);
    return tree([
        {mode: '100644', type: 'blob', sha: blob(readme), name: 'README.md'},
        {mode: '040000', type: 'tree', sha: gallery, name: 'gallery-data'}
    ]);
}
let fixtureCommitSequence = 0;
function commit(treeSha, parents = []) {
    // Distinct fixture commits must stay distinct even on fast Linux runners
    // where Git would otherwise give identical same-second commit objects.
    return git(['commit-tree', treeSha, ...parents.flatMap(parent => ['-p', parent])],
        `Synthetic photo review fixture ${++fixtureCommitSequence}\n`);
}
function checkout(sha) {
    // This force checkout is confined to the uniquely created disposable test
    // repository above; it materializes the exact commit and a clean index.
    assert.equal(path.dirname(path.resolve(temporaryRoot)), temporaryParent);
    git(['checkout', '--quiet', '--detach', '--force', sha]);
}
async function checkGit(name, args, expected = 'full') {
    const result = await classifyPhotoReview({root: temporaryRoot, eventName: 'pull_request', ...args});
    assert.equal(result.suite, expected, name);
    assert.equal(typeof result.reason, 'string', `${name}: explanation is present`);
    assert(result.reason.length > 0, `${name}: explanation is nonempty`);
    cases += 1;
}
try {
    git(['init', '--quiet']);
    git(['config', 'user.name', 'Fictional Local Test']);
    git(['config', 'user.email', 'fictional-test@example.invalid']);
    git(['config', 'core.symlinks', 'false']);
    const baseTree = makeTree(), base = commit(baseTree);
    const candidateTree = makeTree({family: baseline.headText});
    const head = commit(candidateTree, [base]);
    checkout(head);
    const pinned = {baseSha: base, headSha: head, checkoutSha: head};
    await checkGit('Exact locally checked-out PR head', pinned, 'photo-only');
    await fs.writeFile(path.join(temporaryRoot, 'README.md'), 'Dirty tracked change\n');
    await checkGit('Dirty tracked checkout cannot borrow committed eligibility', pinned);
    checkout(head);
    const untracked = path.join(temporaryRoot, 'untracked-note.txt');
    await fs.writeFile(untracked, 'Untracked input\n');
    await checkGit('Untracked checkout cannot borrow committed eligibility', pinned);
    await fs.unlink(untracked);
    await fs.appendFile(path.join(temporaryRoot, '.git', 'info', 'exclude'), '\nignored-proof.tmp\n');
    const ignored = path.join(temporaryRoot, 'ignored-proof.tmp');
    await fs.writeFile(ignored, 'Ignored generated proof\n');
    await checkGit('Ignored generated artifacts do not change tracked eligibility', pinned, 'photo-only');
    await fs.unlink(ignored);
    for (const eventName of ['workflow_dispatch', 'push', 'pull_request_target', '', undefined]) {
        await checkGit(`No fast lane for ${eventName}`, {...pinned, eventName});
    }
    await checkGit('Invalid base SHA', {...pinned, baseSha: '--help'});
    await checkGit('Missing head SHA', {...pinned, headSha: ''});
    await checkGit('Unknown commit is not eligible', {...pinned, headSha: '0'.repeat(40)});
    await checkGit('Checkout identity must match HEAD', {...pinned, checkoutSha: base});
    await checkGit('No changes is full suite', {baseSha: head, headSha: head, checkoutSha: head});

    const merge = commit(candidateTree, [base, head]);
    checkout(merge);
    await checkGit('Exact GitHub-style synthetic merge checkout', {...pinned, checkoutSha: merge}, 'photo-only');
    const reversedMerge = commit(candidateTree, [head, base]);
    checkout(reversedMerge);
    await checkGit('Synthetic merge parents cannot be reversed', {...pinned, checkoutSha: reversedMerge});
    const alteredMerge = commit(makeTree({family: baseline.headText, readme: 'Unexpected merge edit\n'}), [base, head]);
    checkout(alteredMerge);
    await checkGit('Synthetic merge tree must equal candidate', {...pinned, checkoutSha: alteredMerge});
    const independent = commit(baseTree);
    const threeParent = commit(candidateTree, [base, head, independent]);
    checkout(threeParent);
    await checkGit('Synthetic merge must have exactly two pinned parents', {...pinned, checkoutSha: threeParent});
    checkout(head);
    const advancedBase = commit(makeTree({readme: 'New main changed\n'}), [base]);
    await checkGit('New base not contained in candidate must fall back', {...pinned, baseSha: advancedBase});
    await checkGit('Unrelated histories must fall back', {...pinned, baseSha: independent});

    for (const familyMode of ['100755', '120000']) {
        const nonregular = commit(makeTree({family: baseline.headText, familyMode}), [base]);
        checkout(nonregular);
        await checkGit(`Reject changed manifest mode ${familyMode}`, {baseSha: base, headSha: nonregular, checkoutSha: nonregular});
    }
    const submodule = commit(makeTree({familyMode: '160000', familyType: 'commit', familyObject: head}), [base]);
    checkout(submodule);
    await checkGit('Manifest cannot become a submodule', {baseSha: base, headSha: submodule, checkoutSha: submodule});
    const mixed = commit(makeTree({family: baseline.headText, readme: 'A mixed code/docs change\n'}), [base]);
    checkout(mixed);
    await checkGit('Actual Git mixed diff does not use fast lane', {baseSha: base, headSha: mixed, checkoutSha: mixed});
    const bothAreas = commit(makeTree({family: baseline.headText, everyone: canonical({schemaVersion: '1.0', items: [otherPhoto]})}), [base]);
    checkout(bothAreas);
    await checkGit('Actual Git both-area diff does not use fast lane', {baseSha: base, headSha: bothAreas, checkoutSha: bothAreas});
    for (const count of [2, 20, 21]) {
        const batchHead = commit(makeTree({family: canonical({schemaVersion: '1.0', items: [oldPhoto, ...generatedBatch(count)]})}), [base]);
        checkout(batchHead);
        await checkGit(`Actual Git ${count}-photo same-area batch`, {baseSha: base, headSha: batchHead, checkoutSha: batchHead},
            count <= 20 ? 'photo-only' : 'full');
    }
    const nonUtf8 = commit(makeTree({family: Buffer.from([0xff, 0xfe, 0xff])}), [base]);
    checkout(nonUtf8);
    await checkGit('Committed non-UTF8 content does not use fast lane', {baseSha: base, headSha: nonUtf8, checkoutSha: nonUtf8});
    const oversized = commit(makeTree({family: ' '.repeat(1024 * 1024 + 1)}), [base]);
    checkout(oversized);
    await checkGit('Committed oversized input does not use fast lane', {baseSha: base, headSha: oversized, checkoutSha: oversized});
    await checkGit('Not a Git repository safely uses full suite', {...pinned, root: temporaryParent});
} finally {
    // Remove only this suite's resolved, uniquely named disposable directory.
    assert.equal(path.dirname(path.resolve(temporaryRoot)), temporaryParent);
    assert(path.basename(temporaryRoot).startsWith('family-photo-review-path-'));
    await fs.rm(temporaryRoot, {recursive: true, force: true});
}

const workflow = await fs.readFile(new URL('../.github/workflows/pr-checks.yml', import.meta.url), 'utf8');
assert.match(workflow, /^  pull_request:/m);
assert.doesNotMatch(workflow, /^  pull_request_target:/m);
assert.match(workflow, /name: Test static site/);
assert.match(workflow, /contents: read/);
assert.doesNotMatch(workflow, /^\s+(?:paths|paths-ignore):/m, 'Required job cannot disappear through workflow path filters');
assert.match(workflow, /run: pnpm test/, 'Full suite must remain available for every noneligible change');
assert.match(workflow, /if: steps\.regression\.outputs\.suite != 'photo-only'\r?\n\s+run: pnpm test/,
    'Only positive photo-only classification may skip the full suite');
assert.match(workflow, /if: steps\.regression\.outputs\.suite == 'photo-only'\r?\n\s+run: node scripts\/run-gallery-photo-checks\.mjs/,
    'Every positive photo-only classification must execute the focused checks');
assert.doesNotMatch(workflow, /continue-on-error:/, 'Classification or validation errors cannot be ignored');
assert.doesNotMatch(workflow, /secrets\.|contents: write|pull-requests: write/, 'Ordinary PR checks do not gain secrets or write permissions');

console.log(`Gallery photo-only review classification tests passed (${cases} cases plus workflow safety assertions).`);
