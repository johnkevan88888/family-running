import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { archiveServiceFixture } from './helpers/private-gallery-service-fixture.mjs';
import { syntheticGitHub } from './helpers/private-gallery-lifecycle-fixtures.mjs';
import { privateGalleryJobFixture } from './helpers/private-gallery-job-fixture.mjs';
import { validatePrivateFramingFrames, validPrivateFramingDimensions } from '../gallery-admin/src/private-gallery-framing.js';
import { readPrivateGalleryFraming, savePrivateGalleryFraming, readPrivateGalleryAttemptFraming,
    privateGalleryAttemptFramingReplayInput } from '../gallery-admin/src/private-gallery-framing-service.js';
import { reservePrivateGalleryAttempt } from '../gallery-admin/src/private-gallery-attempt-service.js';
import { readPrivateGalleryAssetEligibility, changePrivateGalleryVisibility } from '../gallery-admin/src/private-gallery-visibility-service.js';
import { correctPrivateGalleryTags } from '../gallery-admin/src/private-gallery-tag-service.js';
import { readPrivateGalleryRoster } from '../gallery-admin/src/private-gallery-roster-service.js';
import { deletePrivateArchiveOriginal } from '../gallery-admin/src/private-archive-service.js';
import { runProtectedArchivePurge } from '../scripts/gallery-media/protected-archive-purge.mjs';
import { resumeProtectedArchiveRemoval } from '../scripts/gallery-media/protected-archive-lifecycle.mjs';
import { queuePrivateArchiveJob, claimArchiveJob } from '../gallery-admin/src/private-gallery-job-service.js';

const frame = { x: 45, y: 16, zoom: 2 };
const read = f => readPrivateGalleryFraming(f.env, f.owner, f.site, f.assetId);
const save = (f, input) => savePrivateGalleryFraming(f.env, f.owner, f.site, f.assetId, input);
async function request(f, patch = {}) {
    const current = await read(f); assert.equal(current.ok, true, JSON.stringify(current));
    return { idempotencyKey: crypto.randomUUID(), expectedVersion: current.version, tagVersion: current.tagVersion,
        sourceSha256: current.sourceSha256, orientation: 'exif-transposed-v1', imageWidth: 32, imageHeight: 48,
        frames: { [f.ids[0]]: frame, [f.ids[1]]: { x: 85, y: 14, zoom: 3 } }, confirmed: true, ...patch };
}
async function consent(f, framingVersion) {
    const eligibility = await readPrivateGalleryAssetEligibility(f.env, f.owner, f.site, f.assetId, f.catalog);
    assert.equal(eligibility.ok, true);
    return { ...f.consent, idempotencyKey: crypto.randomUUID(), eligibilityRevision: eligibility.revision,
        tagVersion: (await read(f)).tagVersion, ...(framingVersion === undefined ? {} : { framingVersion }) };
}
const reserve = (f, input) => reservePrivateGalleryAttempt(f.env, f.owner, f.site, f.assetId, input, f.catalog);
const attempt = (f, id) => f.db.prepare('SELECT * FROM private_gallery_attempts WHERE attempt_id=?').get(id);
const revisionCount = f => f.db.prepare('SELECT count(*) n FROM private_gallery_frame_revisions').get().n;
function interceptNextFrameWrite(f, hook) {
    const base = f.env.DB, wrapped = { prepare(sql) {
        const statement = base.prepare(sql), run = statement.run;
        statement.run = async () => {
            if (sql.startsWith('INSERT INTO private_gallery_frame_revisions')) {
                f.env.DB = base;
                hook();
            }
            return run.call(statement);
        };
        return statement;
    } };
    f.env.DB = wrapped;
}
function cloneRevision(f, patch = {}) {
    const prior = f.db.prepare('SELECT * FROM private_gallery_frame_revisions ORDER BY version DESC LIMIT 1').get();
    const row = { ...prior, version: prior.version + 1, idempotency_key: crypto.randomUUID(), ...patch };
    delete row.created_at;
    f.db.prepare(`INSERT INTO private_gallery_frame_revisions (${Object.keys(row).join(',')})
        VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
}

for (const site of ['family', 'everyone']) {
    const f = await archiveServiceFixture(site, { reserveAttempt: false });
    const original = f.db.prepare('SELECT * FROM private_archive_original_receipts').get();
    const originalObject = structuredClone([...f.original.objects]);
    const initial = await read(f);
    assert.equal(initial.version, 0); assert.equal(initial.imageWidth, null); assert.deepEqual(initial.frames, {});
    const oldInput = await consent(f);
    const oldAttempt = await reserve(f, oldInput); assert.equal(oldAttempt.status, 201);
    const oldRow = attempt(f, oldAttempt.attemptId), oldSnapshot = f.db.prepare('SELECT * FROM private_gallery_attempt_framings').get();
    assert.equal(await readPrivateGalleryAttemptFraming(f.env, oldRow), null);
    assert.deepEqual(privateGalleryAttemptFramingReplayInput(oldRow), {});
    const body = await request(f);
    const ioBefore = f.original.calls.length;
    assert.equal((await save(f, body)).status, 201);
    assert.equal(f.original.calls.length, ioBefore, 'saving framing performs no source/byte I/O');
    assert.equal((await save(f, body)).replayed, true); assert.equal(revisionCount(f), 1);
    assert.equal((await reserve(f, oldInput)).replayed, true, 'later framing never rewrites or invalidates old consent/review bytes');
    assert.deepEqual(attempt(f, oldAttempt.attemptId), oldRow);
    assert.deepEqual(f.db.prepare('SELECT * FROM private_gallery_attempt_framings WHERE attempt_id=?').get(oldAttempt.attemptId), oldSnapshot);
    assert.equal((await reserve(f, await consent(f))).status, 409, 'new framed attempts must name their exact framing version');
    assert.equal((await reserve(f, await consent(f, 0))).status, 409);
    const freshInput = await consent(f, 1), fresh = await reserve(f, freshInput);
    assert.equal(fresh.status, 201, JSON.stringify(fresh));
    const freshRow = attempt(f, fresh.attemptId), snapshot = await readPrivateGalleryAttemptFraming(f.env, freshRow);
    assert.deepEqual(snapshot, { version: 1, tagVersion: 1, sourceSha256: original.sha256,
        orientation: 'exif-transposed-v1', imageWidth: 32, imageHeight: 48, podiumFraming: { 'fixture-public': frame } });
    assert.deepEqual(privateGalleryAttemptFramingReplayInput(freshRow), { framingVersion: 1 });
    const privateSnapshot = f.db.prepare('SELECT * FROM private_gallery_attempt_framings WHERE attempt_id=?').get(fresh.attemptId);
    assert.deepEqual(JSON.parse(privateSnapshot.private_frames_json), body.frames);
    assert.equal(JSON.stringify(snapshot.podiumFraming).includes(f.ids[1]), false, 'unmapped private tags never enter public framing');
    const changed = await save(f, await request(f, { frames: { [f.ids[0]]: { x: 10, y: 12, zoom: 4 } } }));
    assert.equal(changed.status, 201); assert.equal(changed.version, 2);
    assert.deepEqual(await readPrivateGalleryAttemptFraming(f.env, freshRow), snapshot, 'new edits cannot retrofit old attempts');
    assert.equal((await reserve(f, freshInput)).replayed, true);
    assert.equal((await save(f, body)).status, 409, 'lost-reply replay cannot overwrite a later revision');
    assert.equal((await reserve(f, await consent(f, 1))).status, 409);
    for (const patch of [
        { embedding: [0.1] }, { sourceUrl: 'https://private.invalid/original.jpg' }, { confirmed: false },
        { orientation: 'raw-exif' }, { imageWidth: 0 }, { imageHeight: 100001 }, { imageWidth: 50000, imageHeight: 50000 },
        { expectedVersion: -1 }, { tagVersion: 0 }, { frames: { [f.ids[0]]: { ...frame, faceBox: [0, 1] } } },
        { frames: { [f.ids[0]]: { ...frame, x: '50' } } }, { frames: { [f.ids[0]]: { ...frame, zoom: Infinity } } },
        { frames: { person_00000000_0000_4000_8000_000000000099: frame } },
        { frames: { ['person_00000000-0000-4000-8000-000000000099']: frame } },
        { frames: Object.create({ [f.ids[0]]: frame }) }
    ]) assert.equal((await save(f, await request(f, patch))).status, 422, JSON.stringify(patch));
    for (const patch of [{ sourceSha256: 'a'.repeat(64) }, { tagVersion: 2 }, { expectedVersion: 0 }]) {
        assert.equal((await save(f, await request(f, patch))).status, 409);
    }
    assert.equal((await readPrivateGalleryFraming(f.env, { type: 'service', subject: f.owner.subject }, site, f.assetId)).status, 403);
    assert.equal((await readPrivateGalleryFraming(f.env, f.owner, site === 'family' ? 'everyone' : 'family', f.assetId)).ok, false);
    assert.equal((await readPrivateGalleryFraming(f.env, { type: 'browser', subject: 'other-fictional-owner' }, site, f.assetId)).ok, false);
    // A hidden person remains privately framed; the complete group cannot publish.
    assert.equal((await changePrivateGalleryVisibility(f.env, f.owner, site, f.ids[1], {
        expectedVersion: 2, preference: 'hidden', idempotencyKey: crypto.randomUUID()
    })).ok, true);
    const hiddenSave = await save(f, await request(f)); assert.equal(hiddenSave.ok, true);
    assert.deepEqual(hiddenSave.frames, body.frames);
    assert.equal((await reserve(f, { ...await consent(f, hiddenSave.version) })).ok, false);
    assert.deepEqual(f.db.prepare('SELECT * FROM private_archive_original_receipts').get(), original);
    assert.deepEqual(structuredClone([...f.original.objects]), originalObject);
    for (const table of ['private_gallery_frame_revisions', 'private_gallery_attempt_framings']) {
        assert.throws(() => f.db.exec(`DELETE FROM ${table}`), /Exact atomic archive purge required/);
        assert.throws(() => f.db.exec(`UPDATE ${table} SET asset_id=asset_id`), /immutable/);
    }
    // Application checks and independent SQL both reject malformed nested JSON.
    for (const bad of [
        { [f.ids[0]]: { x: -1, y: 1, zoom: 1 } }, { [f.ids[0]]: { x: 1, y: 1, zoom: 9 } },
        { [f.ids[0]]: { x: 1, y: 1, zoom: 1, privateName: 'forbidden' } }, { unrelated: frame }
    ]) assert.throws(() => cloneRevision(f, { frames_json: JSON.stringify(bad) }), /framing required/);
    assert.throws(() => cloneRevision(f, { frames_json: `{"${f.ids[0]}":{"y":1,"y":2,"zoom":1}}` }), /framing required/);
    assert.throws(() => cloneRevision(f, { frames_json: `{"${f.ids[0]}":{"x":1,"y":2,"zoom":1},"${f.ids[0]}":{"x":2,"y":3,"zoom":1}}` }), /framing required/);
    assert.throws(() => cloneRevision(f, { source_sha256: 'f'.repeat(64) }), /source unavailable/);
    await assert.rejects(readPrivateGalleryAttemptFraming(f.env, { ...freshRow, original_sha256: 'f'.repeat(64) }), /binding changed/);
    await assert.rejects(readPrivateGalleryAttemptFraming(f.env, { ...freshRow, original_provider_etag: 'changed' }), /binding changed/);
    assert.equal(f.db.prepare('PRAGMA quick_check').get().quick_check, 'ok'); f.db.close();
}

// Actual writes between validation and INSERT must win over stale application reads.
for (const kind of ['cas', 'tag', 'deletion']) {
    const f = await archiveServiceFixture('family', { reserveAttempt: false });
    assert.equal((await save(f, await request(f))).ok, true);
    const body = await request(f); let reached = false;
    interceptNextFrameWrite(f, () => {
        reached = true;
        if (kind === 'cas') cloneRevision(f, { frames_json: '{}' });
        if (kind === 'tag') {
            const owner = f.db.prepare('SELECT owner_identity_hash FROM private_gallery_assets').get().owner_identity_hash;
            f.db.prepare(`INSERT INTO private_gallery_tag_revisions(asset_id,version,idempotency_key,actor_identity_hash,
                request_hash,roster_generation,previous_person_ids_json,person_ids_json,complete_tags_confirmed,
                private_retention_confirmed,contains_minors,guardian_approval_confirmed)
                SELECT asset_id,tag_version+1,?,?,?,(SELECT generation FROM private_gallery_roster_version),
                current_person_ids_json,current_person_ids_json,1,1,0,0 FROM private_gallery_current_tag_sets WHERE asset_id=?`)
                .run(crypto.randomUUID(), owner, 'e'.repeat(64), f.assetId);
        }
        if (kind === 'deletion') f.db.prepare(`INSERT INTO private_archive_deletion_requests(asset_id,actor_identity_hash,reason)
            SELECT asset_id,owner_identity_hash,'owner-delete' FROM private_gallery_assets WHERE asset_id=?`).run(f.assetId);
    });
    assert.equal((await save(f, body)).status, 409, kind); assert.equal(reached, true);
    assert.equal(revisionCount(f), kind === 'cas' ? 2 : 1);
    if (kind === 'tag') {
        const current = await read(f); assert.equal(current.stale, true); assert.deepEqual(current.frames, {});
        assert.equal((await save(f, await request(f, { frames: {} }))).status, 201, 'explicit fresh reset binds new tag version');
    }
    f.db.close();
}

// An actual committed INSERT whose response is lost recovers the exact current
// version by its idempotency key, without writing another revision or any bytes.
{
    const f = await archiveServiceFixture('family', { reserveAttempt: false });
    const body = await request(f), base = f.env.DB;
    f.env.DB = { prepare(sql) {
        const statement = base.prepare(sql), run = statement.run;
        statement.run = async () => {
            const result = await run.call(statement);
            if (sql.startsWith('INSERT INTO private_gallery_frame_revisions')) throw new Error('Synthetic lost reply after commit');
            return result;
        };
        return statement;
    } };
    const recovered = await save(f, body);
    assert.equal(recovered.ok, true); assert.equal(recovered.replayed, true);
    assert.equal(recovered.version, 1); assert.equal(revisionCount(f), 1); f.db.close();
}

// Existing private identities use the established roster grammar, not the v4
// rule for newly generated asset/attempt IDs. Neither an unframed reservation
// nor a saved framing may make an otherwise valid historical person unusable.
for (const site of ['family','everyone']) {
    const f = await archiveServiceFixture(site,{reserveAttempt:false});
    const nonV4 = 'person_00000000-0000-1000-8000-000000000003';
    f.db.prepare('INSERT INTO private_gallery_people VALUES(?,?,?,?,?)')
        .run(nonV4,'Fictional pre-existing non-v4 person','fixture-non-v4-public',1,1);
    assert.equal((await changePrivateGalleryVisibility(f.env,f.owner,site,nonV4,{
        expectedVersion:1,preference:'allowed',idempotencyKey:crypto.randomUUID()
    })).ok,true);
    for (const area of ['family','everyone']) f.catalog.sites[area].catalog.athleteIds.push('fixture-non-v4-public');
    const tags = [nonV4,f.ids[1]];
    const corrected = await correctPrivateGalleryTags(f.env,f.owner,site,f.assetId,{
        idempotencyKey:crypto.randomUUID(),expectedVersion:1,
        rosterRevision:(await readPrivateGalleryRoster(f.env,site)).revision,
        personIds:tags,completeTagsConfirmed:true,privateRetentionConfirmed:true,
        containsMinors:false,guardianApprovalConfirmed:false
    });
    assert.equal(corrected.ok,true); f.ids=tags;
    const emptyInput=await consent(f,0), empty=await reserve(f,emptyInput);
    assert.equal(empty.status,201,'Valid existing non-v4 person must not fail empty version-0 snapshot replay');
    const emptyRow=attempt(f,empty.attemptId);
    assert.equal(await readPrivateGalleryAttemptFraming(f.env,emptyRow),null);
    assert.equal((await reserve(f,emptyInput)).replayed,true);
    const body=await request(f); assert.equal(body.tagVersion,2);
    assert.equal((await save(f,body)).status,201);
    const framed=await reserve(f,await consent(f,1)); assert.equal(framed.status,201);
    const snapshot=await readPrivateGalleryAttemptFraming(f.env,attempt(f,framed.attemptId));
    assert.deepEqual(snapshot.podiumFraming,{'fixture-non-v4-public':frame});
    assert.deepEqual((await read(f)).frames,body.frames);
    assert.equal(await readPrivateGalleryAttemptFraming(f.env,emptyRow),null,'Later framing cannot retrofit the valid old empty snapshot');
    f.db.close();
}

// Forward migration leaves every older attempt/consent byte intact and unframed.
{
    const f = await archiveServiceFixture('family', { migrationThrough: 28 });
    const before = attempt(f, f.attemptId);
    f.db.exec(await readFile(new URL('../gallery-admin/migrations/0029_private_gallery_framing.sql', import.meta.url), 'utf8'));
    const after = attempt(f, f.attemptId); assert.equal(after.framing_version, null);
    delete after.framing_version; assert.deepEqual(after, before);
    assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_attempt_framings').get().n, 0);
    assert.equal(await readPrivateGalleryAttemptFraming(f.env, { ...after, framing_version: null }), null);
    f.db.close();
}

// New private metadata is proof-covered and deleted ONLY by the old coordinated
// terminal-purge path. Abort near its end must roll both framing deletions back.
for (const site of ['family', 'everyone']) {
    const f = await archiveServiceFixture(site, { reserveAttempt: false }), github = syntheticGitHub();
    assert.equal((await save(f, await request(f))).ok, true);
    const revisionRefs = () => f.db.prepare('SELECT version,request_hash FROM private_gallery_frame_revisions ORDER BY version').all()
        .map(row => [row.version,row.request_hash]);
    const attemptRefs = () => f.db.prepare('SELECT attempt_id,version FROM private_gallery_attempt_framings ORDER BY attempt_id').all()
        .map(row => [row.attempt_id,row.version]);
    const firstRevisionRefs = revisionRefs();
    const firstAttempt = await reserve(f, await consent(f,1)); assert.equal(firstAttempt.ok,true);
    const firstAttemptRefs = attemptRefs();
    assert.equal((await save(f, await request(f,{frames:{[f.ids[0]]:{x:50,y:20,zoom:3}}}))).version,2);
    const secondAttempt = await reserve(f, await consent(f,2)); assert.equal(secondAttempt.ok,true);
    assert.notDeepEqual(revisionRefs(),firstRevisionRefs,'Every new immutable revision changes its exact compact reference set');
    assert.notDeepEqual(attemptRefs(),firstAttemptRefs,'Every new attempt snapshot changes its exact compact reference set');
    const clients = await privateGalleryJobFixture(f);
    for (const id of [firstAttempt.attemptId,secondAttempt.attemptId]) {
        const removed = await resumeProtectedArchiveRemoval({attemptId:id,...clients,github});
        assert.equal(removed.state,'removed',JSON.stringify(removed));
    }
    const narrow = { DB: f.env.DB, APPROVED_MEDIA_ORIGIN: f.env.APPROVED_MEDIA_ORIGIN, EXPECTED_MEDIA_VERSION: f.env.EXPECTED_MEDIA_VERSION };
    assert.equal((await deletePrivateArchiveOriginal(f.env, f.owner, site, f.assetId, 'owner-delete')).ok, true);
    const snapshot = JSON.parse(f.db.prepare('SELECT snapshot_json FROM private_archive_purge_snapshots').get().snapshot_json);
    assert.deepEqual(snapshot.framingRevisions,revisionRefs());
    assert.deepEqual(snapshot.attemptFramings,attemptRefs());
    assert(snapshot.framingRevisions.every(([version,hash])=>Number.isSafeInteger(version) && /^[0-9a-f]{64}$/.test(hash)));
    assert.equal(JSON.stringify(snapshot.framingRevisions).includes('zoom'),false,'Proof references do not duplicate raw coordinates');
    assert.equal(snapshot.attemptFramings.length,2);
    assert.throws(()=>f.db.exec('DELETE FROM private_gallery_attempt_framings'),/Exact atomic archive purge required/);
    const dry = await runProtectedArchivePurge({ env: narrow, identity: f.owner, site, assetId: f.assetId, github });
    assert.equal(dry.ok, true); assert.equal(dry.attemptCount, 2);
    const input = { purgeKey: crypto.randomUUID(), expectedProofHash: dry.proofHash };
    const job = await queuePrivateArchiveJob(narrow, f.owner, site, f.assetId, {
        action: 'purge', idempotencyKey: crypto.randomUUID(), ...input
    }); assert.equal(job.ok, true);
    await claimArchiveJob(narrow, job.job.jobId, 'https://github.com/johnkevan88888/family-running/actions/runs/999', 'finalizer');
    f.db.exec("CREATE TRIGGER synthetic_frame_purge_abort BEFORE DELETE ON private_gallery_assets BEGIN SELECT RAISE(ABORT,'synthetic frame interruption'); END");
    const aborted = await runProtectedArchivePurge({ env: narrow, identity: f.owner, site, assetId: f.assetId, github, input, dryRun: false });
    assert.equal(aborted.ok, false); assert.equal(revisionCount(f), 2);
    assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_attempt_framings').get().n,2,'Snapshot cascades also roll back');
    assert.equal(f.db.prepare('SELECT count(*) n FROM private_archive_purge_receipts').get().n, 0);
    f.db.exec('DROP TRIGGER synthetic_frame_purge_abort');
    const done = await runProtectedArchivePurge({ env: narrow, identity: f.owner, site, assetId: f.assetId, github, input, dryRun: false });
    assert.equal(done.ok, true, JSON.stringify(done)); assert.equal(revisionCount(f), 0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_attempt_framings').get().n, 0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_people').get().n, 2);
    assert(f.hostRequests.length>0,'Actual reserved generations require genuine fixed-host witness checks even without output');
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []); f.db.close();
}
assert.equal(validatePrivateFramingFrames({ privateName: frame }, ['person_00000000-0000-4000-8000-000000000001']), false);
assert.equal(validPrivateFramingDimensions(10000,5000),true);
assert.equal(validPrivateFramingDimensions(10000,5001),false,'Framing must not broaden the existing 50-million-pixel photo ceiling');
console.log('Private framing: numeric/privacy contract, owner/source/tag CAS, immutable fresh snapshots, private projection, legacy upgrade and guarded purge rollback passed.');
