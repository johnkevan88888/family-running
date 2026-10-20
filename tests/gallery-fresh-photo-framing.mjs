import assert from 'node:assert/strict';
import sharp from 'sharp';
import { archiveServiceFixture } from './helpers/private-gallery-service-fixture.mjs';
import { privateGalleryJobFixture } from './helpers/private-gallery-job-fixture.mjs';
import { syntheticGitHub, digest } from './helpers/private-gallery-lifecycle-fixtures.mjs';
import { savePrivateGalleryFraming } from '../gallery-admin/src/private-gallery-framing-service.js';
import { reservePrivateGalleryAttempt } from '../gallery-admin/src/private-gallery-attempt-service.js';
import { readPrivateGalleryAssetEligibility } from '../gallery-admin/src/private-gallery-visibility-service.js';
import { admitArchivePhotoProcessing, readArchivePhotoSource, readArchivePhotoCandidateItem } from '../gallery-admin/src/private-gallery-photo-lifecycle.js';
import { runArchivePhotoReview } from '../scripts/gallery-media/private-photo-lifecycle.mjs';
import { runProtectedArchiveReview } from '../scripts/gallery-media/protected-archive-lifecycle.mjs';
import { createArchiveServiceClient } from '../scripts/gallery-media/archive-service-client.mjs';
import { assertPhotoFramingSource } from '../scripts/gallery-media/photo-framing-source.mjs';

const privateFrames = ids => ({ [ids[0]]: { x: 20, y: 15, zoom: 2 }, [ids[1]]: { x: 80, y: 75, zoom: 3 } });
const publicFrames = { 'fixture-public': { x: 20, y: 15, zoom: 2 } };
const images = new Map();
for (const orientation of [6, 2]) {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="48"><rect width="16" height="48" fill="#f02020"/><rect x="16" width="16" height="48" fill="#2020f0"/></svg>';
    images.set(orientation, await sharp(Buffer.from(svg)).withMetadata({ orientation }).withExifMerge({ IFD0: { Make: 'private-camera-frame-sentinel' } }).jpeg().toBuffer());
    assert.equal((await sharp(images.get(orientation)).metadata()).orientation, orientation, 'fixture carries real EXIF orientation');
}

async function fresh(site, orientation, wrongDimensions = false) {
    const f = await archiveServiceFixture(site, { reserveAttempt: false, photoBytes: images.get(orientation) });
    const expectedFrames = structuredClone(publicFrames);
    if (orientation === 2) {
        // A separate fictitious two-public-person case proves that different
        // selected faces survive the same item. Mapping is fixture setup before
        // the first consent, never an edit to original or historical evidence.
        f.db.prepare('UPDATE private_gallery_people SET public_athlete_id=? WHERE person_id=?').run('fixture-public-second', f.ids[1]);
        for (const area of ['family', 'everyone']) f.catalog.sites[area].catalog.athleteIds.push('fixture-public-second');
        expectedFrames['fixture-public-second'] = { x: 80, y: 75, zoom: 3 };
        f.consent.eligibilityRevision = (await readPrivateGalleryAssetEligibility(f.env, f.owner, site, f.assetId, f.catalog)).revision;
    }
    const width = orientation === 6 ? 48 : 32, height = orientation === 6 ? 32 : 48;
    const saved = await savePrivateGalleryFraming(f.env, f.owner, site, f.assetId, {
        idempotencyKey: crypto.randomUUID(), expectedVersion: 0, tagVersion: 1, confirmed: true,
        sourceSha256: digest(f.photo), orientation: 'exif-transposed-v1',
        imageWidth: wrongDimensions ? height : width, imageHeight: wrongDimensions ? width : height,
        frames: privateFrames(f.ids)
    });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const consent = { ...f.consent, framingVersion: saved.version };
    const attempt = await reservePrivateGalleryAttempt(f.env, f.owner, site, f.assetId, consent, f.catalog);
    assert.equal(attempt.ok, true, JSON.stringify(attempt));
    return { ...f, attemptId: attempt.attemptId, width, height, consent, expectedFrames };
}

async function run(f, transport, github) {
    if (transport === 'internal') return runArchivePhotoReview({ env: f.env, identity: f.owner, site: f.site,
        attemptId: f.attemptId, catalog: f.catalog, github, publicFetch: f.publicFetch });
    const clients = await privateGalleryJobFixture(f);
    return runProtectedArchiveReview({ attemptId: f.attemptId, processing: clients.processing, promotion: clients.promotion, github });
}

function retained(f, originalRow, attemptRow) {
    assert.deepEqual(f.db.prepare('SELECT * FROM private_archive_original_receipts WHERE asset_id=?').get(f.assetId), originalRow);
    assert.deepEqual(f.db.prepare('SELECT * FROM private_gallery_attempts WHERE attempt_id=?').get(f.attemptId), attemptRow,
        'processing/review must not change original consent or attempt evidence');
    assert.equal(f.original.objects.size, 1, 'the original stays private and retained');
    assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_current_asset_tags WHERE asset_id=?').get(f.assetId).n, 2);
    assert.equal(f.db.prepare('SELECT count(*) n FROM gallery_drafts').get().n, 0, 'new framing must not create a legacy draft');
}

for (const site of ['family', 'everyone']) {
    for (const transport of ['internal', 'http']) {
        for (const orientation of transport === 'http' ? [6, 2] : [6]) {
            const f = await fresh(site, orientation), github = syntheticGitHub();
            try {
                const originalRow = f.db.prepare('SELECT * FROM private_archive_original_receipts WHERE asset_id=?').get(f.assetId);
                const attemptRow = f.db.prepare('SELECT * FROM private_gallery_attempts WHERE attempt_id=?').get(f.attemptId);
                const result = await run(f, transport, github);
                assert.equal(result.ok, true, JSON.stringify({ site, transport, orientation, result }));
                assert.equal(result.state, 'unmerged-review');
                const item = await readArchivePhotoCandidateItem(f.env, f.owner, site, f.attemptId, f.catalog);
                assert.deepEqual(item.podiumFraming, f.expectedFrames, 'project only framed, already-tagged public athlete IDs');
                const intent = JSON.parse(f.db.prepare('SELECT candidate_json FROM private_gallery_pipeline_review_intents WHERE attempt_id=?').get(f.attemptId).candidate_json);
                assert.equal(intent.targetRelativePath, `gallery-data/${site}.json`);
                assert.deepEqual(JSON.parse(intent.manifestText).items, [item]);
                assert.equal(intent.manifestSha256, `sha256:${digest(intent.manifestText)}`, 'review hash covers the complete optional public framing');
                assert.equal(github.state.pulls.length, 1);
                assert.equal(github.state.pulls[0].state, 'open');
                assert.equal(github.state.manifests[site].items.length, 0, 'a candidate is never publication');
                for (const sentinel of ['private-camera-frame-sentinel', ...f.ids, 'person_', 'asset_', 'attempt_', 'imageWidth', 'imageHeight', 'orientation', 'embedding', 'sourceSha256']) {
                    assert.equal(intent.manifestText.includes(sentinel), false, `private/technical value leaked: ${sentinel}`);
                }
                const display = f.db.prepare("SELECT object_key FROM private_gallery_pipeline_outputs WHERE attempt_id=? AND tier='approved' AND role='photo-display'").get(f.attemptId);
                const body = f.approved.objects.get(display.object_key).bytes;
                const metadata = await sharp(body).metadata();
                assert.equal(metadata.width, f.width);
                assert.equal(metadata.height, f.height);
                assert.equal(metadata.orientation, undefined, 'public output is oriented pixels, not retained EXIF');
                assert.equal(metadata.exif, undefined);
                const { data, info } = await sharp(body).removeAlpha().raw().toBuffer({ resolveWithObject: true });
                const point = orientation === 2 ? [0.2, 0.5] : [0.5, 0.2];
                const offset = (Math.floor(point[1] * info.height) * info.width + Math.floor(point[0] * info.width)) * info.channels;
                assert.ok(orientation === 2 ? data[offset + 2] > data[offset] + 80 : data[offset] > data[offset + 2] + 80,
                    'mirror/rotation is applied before percentage framing is used');
                const originalCalls = f.original.calls.length, beforeIntent = JSON.stringify(intent);
                const byteWrites = f.staging.calls.filter(call => call[0] === 'part').length + f.approved.calls.filter(call => call[0] === 'part').length;
                assert.equal((await savePrivateGalleryFraming(f.env, f.owner, site, f.assetId, {
                    idempotencyKey: crypto.randomUUID(), expectedVersion: 1, tagVersion: 1, confirmed: true,
                    sourceSha256: digest(f.photo), orientation: 'exif-transposed-v1', imageWidth: f.width, imageHeight: f.height,
                    frames: { [f.ids[0]]: { x: 90, y: 90, zoom: 4 } }
                })).ok, true, 'an editable newer frame is allowed for a future attempt only');
                assert.equal((await run(f, transport, github)).ok, true);
                assert.deepEqual((await readArchivePhotoCandidateItem(f.env, f.owner, site, f.attemptId, f.catalog)).podiumFraming, f.expectedFrames);
                assert.equal(JSON.stringify(JSON.parse(f.db.prepare('SELECT candidate_json FROM private_gallery_pipeline_review_intents WHERE attempt_id=?').get(f.attemptId).candidate_json)), beforeIntent);
                assert.equal(f.original.calls.length, originalCalls, 'review replay does not reread the original');
                assert.equal(f.staging.calls.filter(call => call[0] === 'part').length + f.approved.calls.filter(call => call[0] === 'part').length, byteWrites);
                retained(f, originalRow, attemptRow);
                assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
            } finally { f.db.close(); }
        }

        const wrong = await fresh(site, 6, true), github = syntheticGitHub();
        try {
            const originalRow = wrong.db.prepare('SELECT * FROM private_archive_original_receipts WHERE asset_id=?').get(wrong.assetId);
            const attemptRow = wrong.db.prepare('SELECT * FROM private_gallery_attempts WHERE attempt_id=?').get(wrong.attemptId);
            assert.equal((await run(wrong, transport, github)).ok, false, 'raw/untransposed dimensions do not match the independently oriented source');
            assert.equal(wrong.staging.calls.some(call => ['create', 'part', 'complete'].includes(call[0])), false, 'dimension mismatch stops before the first derivative PUT');
            assert.equal(wrong.approved.calls.some(call => ['create', 'part', 'complete'].includes(call[0])), false);
            assert.equal(github.state.pulls.length, 0);
            retained(wrong, originalRow, attemptRow);
        } finally { wrong.db.close(); }
    }

    const legacy = await archiveServiceFixture(site, { migrationThrough: 28 });
    try {
        const result = await admitArchivePhotoProcessing(legacy.env, legacy.owner, site, legacy.attemptId, legacy.catalog);
        assert.equal(JSON.stringify(result), JSON.stringify({ ok: true, status: 200, attemptId: legacy.attemptId, state: 'admitted', replayed: false }),
            'old omitted framing retains the exact processing acknowledgement');
        const source = await readArchivePhotoSource(legacy.env, legacy.owner, site, legacy.attemptId, legacy.catalog);
        assert.equal(Object.hasOwn(source, 'framingSource'), false, 'pre-migration originals acquire no new claim');
    } finally { legacy.db.close(); }
}

for (const mutation of [null, { sourceSha256: 'a'.repeat(64), orientation: 'raw', imageWidth: 32, imageHeight: 48 },
    { sourceSha256: 'a'.repeat(64), orientation: 'exif-transposed-v1', imageWidth: 32, imageHeight: 48, personId: 'private' }]) {
    const client = createArchiveServiceClient({ purpose: 'processing', origin: 'https://family-running-gallery-processing-dev.family-running.workers.dev',
        clientId: 'fictional-client', clientSecret: 'fictional-secret', fetchImpl: async request => {
            const response = new Response(JSON.stringify({ framingSource: mutation }), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
            Object.defineProperty(response, 'url', { value: request.url }); return response;
        } });
    assert.equal((await client(`attempt_${crypto.randomUUID()}`, 'start')).ok, false, 'invalid technical acknowledgement fails closed');
}
assert.doesNotThrow(() => assertPhotoFramingSource(undefined, {}), 'legacy source checks remain omitted');
assert.throws(() => assertPhotoFramingSource({ sourceSha256: 'a'.repeat(64), orientation: 'exif-transposed-v1', imageWidth: 32, imageHeight: 48 },
    { sha256: 'b'.repeat(64), orientedWidth: 32, orientedHeight: 48 }), /independently decoded/);
console.log('Fresh photo framing survives real local orientation/stripping, immutable consent, split processing/promotion and an unmerged one-file review; mismatches stop before byte writes.');
