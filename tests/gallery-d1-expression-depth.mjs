import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withdrawalFinalizerTestHooks } from
    '../gallery-admin/src/withdrawal-finalizer-service.js';
import { readPrivateGalleryRoster } from
    '../gallery-admin/src/private-gallery-roster-service.js';
import { reservePrivateGalleryAsset, readPrivateGalleryAsset } from '../gallery-admin/src/private-gallery-asset-service.js';
import { preparePrivateArchiveIntake } from '../gallery-admin/src/private-archive-service.js';
import { correctPrivateGalleryTags } from '../gallery-admin/src/private-gallery-tag-service.js';
import { reservePrivateGalleryAttempt } from '../gallery-admin/src/private-gallery-attempt-service.js';
import { readPrivateGalleryAssetEligibility,changePrivateGalleryVisibility } from '../gallery-admin/src/private-gallery-visibility-service.js';
import {queuePrivateArchiveJob,claimArchiveJob} from '../gallery-admin/src/private-gallery-job-service.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const wranglerPackageRoot = path.dirname(require.resolve('wrangler/package.json'));
const wranglerPath = path.join(
    wranglerPackageRoot,
    'bin',
    'wrangler.js'
);
const workerConfigPath = path.join(
    repositoryRoot,
    'gallery-admin',
    'wrangler.withdrawal-finalizer.example.jsonc'
);
const databaseName = 'family-running-gallery-dev';
const temporaryPrefix = 'gallery-d1-expression-depth-';
const temporaryParent = await fs.realpath(os.tmpdir());
const temporaryRoot = await fs.mkdtemp(
    path.join(temporaryParent, temporaryPrefix)
);

assert.equal(path.dirname(temporaryRoot), temporaryParent);
assert.match(path.basename(temporaryRoot), /^gallery-d1-expression-depth-/);

try {
    const stateRoot = path.join(temporaryRoot, 'state');
    const configRoot = path.join(temporaryRoot, 'wrangler-config');
    await fs.mkdir(stateRoot);
    await fs.mkdir(configRoot);

    const environment = localOnlyEnvironment(configRoot);
    const commonArguments = [
        databaseName,
        '--local',
        '--config',
        workerConfigPath,
        '--persist-to',
        stateRoot
    ];

    // Prove that this pinned Wrangler/workerd runtime enforces the same
    // expression-depth boundary that production D1 enforces. Without this
    // calibration, a more permissive generic SQLite build could let the
    // migration test pass while the deployed query still fails.
    const depthBoundaryProbe = runWrangler([
        'd1',
        'execute',
        ...commonArguments,
        '--command',
        `EXPLAIN SELECT ${Array(101).fill('1').join(' AND ')}`,
        '--json'
    ], environment);
    assert.notEqual(
        depthBoundaryProbe.status,
        0,
        'The local D1 parity probe unexpectedly accepted an expression deeper than 100.'
    );
    assert.match(
        combinedOutput(depthBoundaryProbe),
        /Expression tree is too large \(maximum depth 100\): SQLITE_ERROR/,
        diagnostic(depthBoundaryProbe)
    );

    const migrations = runWrangler([
        'd1',
        'migrations',
        'apply',
        ...commonArguments
    ], environment, 120_000);
    assert.equal(migrations.error, undefined, diagnostic(migrations));
    assert.equal(migrations.status, 0, diagnostic(migrations));
    const claimCompile = runWrangler(['d1','execute',...commonArguments,'--command',
        'EXPLAIN INSERT INTO private_gallery_job_claims DEFAULT VALUES','--json'],environment);
    assert.equal(claimCompile.status,0,diagnostic(claimCompile));

    // EXPLAIN compiles each INSERT and all table triggers into bytecode but does
    // not execute them. DEFAULT VALUES deliberately avoids fixture data: these
    // tests are about whether D1 can compile both sides of the finalization
    // boundary, not whether fabricated evidence can satisfy either contract.
    const operationCompile = runWrangler([
        'd1',
        'execute',
        ...commonArguments,
        '--command',
        'EXPLAIN INSERT INTO draft_withdrawal_finalization_operations DEFAULT VALUES',
        '--json'
    ], environment);
    assert.equal(operationCompile.error, undefined, diagnostic(operationCompile));
    assert.equal(operationCompile.status, 0, diagnostic(operationCompile));

    const operationCompileResult = parseWranglerJson(operationCompile);
    assert.equal(
        Array.isArray(operationCompileResult),
        true,
        diagnostic(operationCompile)
    );
    assert.equal(operationCompileResult.length, 1, diagnostic(operationCompile));
    assert.equal(operationCompileResult[0].success, true, diagnostic(operationCompile));
    assert.ok(
        operationCompileResult[0].results.length > 0,
        diagnostic(operationCompile)
    );

    const receiptCompile = runWrangler([
        'd1',
        'execute',
        ...commonArguments,
        '--command',
        'EXPLAIN INSERT INTO gallery_withdrawal_completion_receipts DEFAULT VALUES',
        '--json'
    ], environment);
    assert.equal(receiptCompile.error, undefined, diagnostic(receiptCompile));
    assert.equal(receiptCompile.status, 0, diagnostic(receiptCompile));

    const receiptCompileResult = parseWranglerJson(receiptCompile);
    assert.equal(Array.isArray(receiptCompileResult), true, diagnostic(receiptCompile));
    assert.equal(receiptCompileResult.length, 1, diagnostic(receiptCompile));
    assert.equal(receiptCompileResult[0].success, true, diagnostic(receiptCompile));
    assert.ok(receiptCompileResult[0].results.length > 0, diagnostic(receiptCompile));

    // Compile the exact new legacy-evidence SELECT in the same depth-limited
    // engine. Its underlying view is intentionally not nested in the already
    // large context SELECT or either write guard.
    const legacyQuery = withdrawalFinalizerTestHooks.legacyProcessingOnlyCleanupSelect
        .replaceAll('?1', "'draft_00000000-0000-4000-8000-000000000000'")
        .replaceAll('?2', '20')
        .replaceAll('?3', "'upload_00000000000040008000000000000000'");
    const legacyCompile = runWrangler([
        'd1', 'execute', ...commonArguments,
        '--command', `EXPLAIN ${legacyQuery}`, '--json'
    ], environment);
    assert.equal(legacyCompile.error, undefined, diagnostic(legacyCompile));
    assert.equal(legacyCompile.status, 0, diagnostic(legacyCompile));
    const legacyCompileResult = parseWranglerJson(legacyCompile);
    assert.equal(legacyCompileResult.length, 1);
    assert.equal(legacyCompileResult[0].success, true);
    assert.ok(legacyCompileResult[0].results.length > 0);

    // Keep a direct non-mutation assertion beside the compile check. Even if a
    // future Wrangler release changes its EXPLAIN output, this test must never
    // create a synthetic permanent receipt as a side effect.
    const finalizationCounts = runWrangler([
        'd1',
        'execute',
        ...commonArguments,
        '--command',
        'SELECT ' +
            '(SELECT COUNT(*) FROM draft_withdrawal_finalization_operations) ' +
                'AS operationCount, ' +
            '(SELECT COUNT(*) FROM gallery_withdrawal_completion_receipts) ' +
                'AS receiptCount, ' +
            '(SELECT sql FROM sqlite_schema WHERE type = \'trigger\' ' +
                'AND name = \'draft_transition_receipts_no_replace_guard\') ' +
                'AS transitionReplacementGuard',
        '--json'
    ], environment);
    assert.equal(finalizationCounts.error, undefined, diagnostic(finalizationCounts));
    assert.equal(finalizationCounts.status, 0, diagnostic(finalizationCounts));

    const countResult = parseWranglerJson(finalizationCounts);
    assert.equal(countResult[0].success, true, diagnostic(finalizationCounts));
    assert.equal(countResult[0].results[0].operationCount, 0);
    assert.equal(countResult[0].results[0].receiptCount, 0);
    assert.match(countResult[0].results[0].transitionReplacementGuard,
        /existing\.idempotency_key = NEW\.idempotency_key OR\s+existing\.expected_state_version = NEW\.expected_state_version/);

    // Exercise the new private reader through the actual pinned D1 runtime,
    // not just Node SQLite. This disposable database contains fictitious data.
    const personId = 'person_00000000-0000-4000-8000-000000000001';
    const seedRoster = runWrangler([
        'd1', 'execute', ...commonArguments, '--command',
        `INSERT INTO private_gallery_people
            (person_id, display_name, public_athlete_id, family, everyone)
         VALUES ('${personId}', 'Synthetic D1 Private Runner', NULL, 1, 0)`,
        '--json'
    ], environment);
    assert.equal(seedRoster.status, 0, diagnostic(seedRoster));
    const roster = await readPrivateGalleryRoster({ DB: { prepare(sql) {
        return { async all() {
            const query = runWrangler([
                'd1', 'execute', ...commonArguments, '--command', sql, '--json'
            ], environment);
            assert.equal(query.status, 0, diagnostic(query));
            const results = parseWranglerJson(query);
            assert.equal(results.length, 1);
            return results[0];
        } };
    } } }, 'family');
    assert.equal(roster.ok, true);
    assert.deepEqual(roster.people, [{ personId, displayName: 'Synthetic D1 Private Runner', publicAthleteId: null }]);
    assert.match(roster.revision, /^sha256:[0-9a-f]{64}$/);

    // Execute the real prepared service statements against disposable local D1.
    // Wrangler has no binding arguments: literalize ONLY these synthetic test
    // values, with quote escaping and no credentials/media/real-person data.
    let beforeAssetWrite,lastD1Failure;
    const assetEnv = { DB: { prepare(sql) {
        let bindings = [];
        const execute = () => {
            const command = sql.replace(/\?(\d+)/g, (_, index) => {
                const value = bindings[Number(index) - 1];
                if (value === null) return 'NULL';
                if (Number.isSafeInteger(value)) return String(value);
                assert.equal(typeof value, 'string');
                return `'${value.replaceAll("'", "''")}'`;
            });
            const query = runWrangler(['d1', 'execute', ...commonArguments, '--command', command, '--json'], environment);
            if (query.status !== 0) { lastD1Failure=diagnostic(query);throw new Error(lastD1Failure); }
            const results = parseWranglerJson(query);
            assert.equal(results.length, 1);
            return results[0];
        };
        return { bind(...values) { bindings = values; return this; }, async all() { return execute(); },
            async first() { return execute().results[0] ?? null; },
            async run() { const hook = beforeAssetWrite; beforeAssetWrite = undefined; hook?.(); return execute(); } };
    } } };
    const owner = {type:'browser',subject:'synthetic-d1-owner'};
    const reservationInput = {idempotencyKey:crypto.randomUUID(), originalFormat:'jpg',
        personIds:[personId], rosterRevision:roster.revision};
    const reservation = await reservePrivateGalleryAsset(assetEnv, owner, 'family', reservationInput);
    assert.equal(reservation.status, 201, JSON.stringify(reservation));
    assert.deepEqual((await readPrivateGalleryAsset(assetEnv, owner, 'family', reservation.asset.assetId)).asset, reservation.asset);
    assert.equal((await reservePrivateGalleryAsset(assetEnv, owner, 'family', reservationInput)).replayed, true);
    beforeAssetWrite = () => {
        const edit = runWrangler(['d1', 'execute', ...commonArguments, '--command',
            `UPDATE private_gallery_people SET display_name = 'Synthetic D1 Changed Runner' WHERE person_id = '${personId}'`, '--json'], environment);
        assert.equal(edit.status, 0, diagnostic(edit));
    };
    const raced = await reservePrivateGalleryAsset(assetEnv, owner, 'family', {...reservationInput,idempotencyKey:crypto.randomUUID()});
    assert.equal(raced.status,409);
    const counts = runWrangler(['d1','execute',...commonArguments,'--command',
        'SELECT (SELECT count(*) FROM private_gallery_assets) AS assets, (SELECT count(*) FROM private_gallery_asset_tags) AS tags', '--json'],environment);
    assert.equal(counts.status,0,diagnostic(counts));
    assert.deepEqual(parseWranglerJson(counts)[0].results,[{assets:1,tags:1}]);

    const currentRoster = await readPrivateGalleryRoster(assetEnv,'family');
    const tagCorrection = await correctPrivateGalleryTags(assetEnv,owner,'family',reservation.asset.assetId,{
        idempotencyKey:crypto.randomUUID(),expectedVersion:1,rosterRevision:currentRoster.revision,
        personIds:[personId],completeTagsConfirmed:true,privateRetentionConfirmed:true,
        containsMinors:false,guardianApprovalConfirmed:false
    });
    assert.equal(tagCorrection.status,201,JSON.stringify(tagCorrection));
    assert.equal(tagCorrection.tagVersion,2);
    const intake = await preparePrivateArchiveIntake(assetEnv,owner,'family',reservation.asset.assetId,{
        byteCount:100,sha256:'a'.repeat(64),declaredMimeType:'image/jpeg',
        privateRetentionConfirmed:true,containsMinors:false,guardianApprovalConfirmed:false,
        rosterRevision:currentRoster.revision,tagVersion:2
    });
    assert.equal(intake.status,201,JSON.stringify(intake));
    // Fictitious retained-source evidence for the actual attempt INSERT. R2
    // byte integrity is exercised separately with generated JPEG fixtures.
    const originalSeed = runWrangler(['d1','execute',...commonArguments,'--command',
        `INSERT INTO private_archive_multipart_uploads VALUES ('${reservation.asset.assetId}','synthetic-d1-writer');
         INSERT INTO private_archive_original_receipts (asset_id,byte_count,sha256,provider_version,provider_etag)
         VALUES ('${reservation.asset.assetId}',100,'${'a'.repeat(64)}','synthetic-d1-version','synthetic-d1-etag')`, '--json'],environment);
    assert.equal(originalSeed.status,0,diagnostic(originalSeed));
    const allowed = await changePrivateGalleryVisibility(assetEnv,owner,'family',personId,{
        expectedVersion:1,idempotencyKey:crypto.randomUUID(),preference:'allowed'});
    assert.equal(allowed.ok,true,JSON.stringify(allowed));
    const attemptCatalog={exportBundleId:'synthetic-d1-bundle',sourceRevision:`sha256:${'a'.repeat(64)}`,
        suppressionRevision:`sha256:${'b'.repeat(64)}`,suppressionDocument:{schemaVersion:'1.0',hiddenAthleteIds:[]},
        sites:{family:{catalog:{exportBundleId:'synthetic-d1-bundle',sourceRevision:`sha256:${'a'.repeat(64)}`,
            races:[{raceDate:'2026-01-01',raceEvent:'Synthetic D1 Race',raceDistance:'5 km'}],athleteIds:[]}}}};
    const eligible = await readPrivateGalleryAssetEligibility(assetEnv,owner,'family',reservation.asset.assetId,attemptCatalog);
    assert.equal(eligible.visibilityEligible,true,JSON.stringify(eligible));
    const attempt=await reservePrivateGalleryAttempt(assetEnv,owner,'family',reservation.asset.assetId,{
        idempotencyKey:crypto.randomUUID(),tagVersion:2,eligibilityRevision:eligible.revision,
        sourceRevision:attemptCatalog.sourceRevision,suppressionRevision:attemptCatalog.suppressionRevision,
        raceIndex:0,completeTagsConfirmed:true,publicUseConfirmed:true,containsMinors:false,guardianApprovalConfirmed:false
    },attemptCatalog);
    assert.equal(attempt.status,201,JSON.stringify(attempt));
    assert.equal(attempt.processingEnabled,false);assert.equal(attempt.publicationEnabled,false);
    const ownerJob=await queuePrivateArchiveJob(assetEnv,owner,'family',reservation.asset.assetId,{
        action:'review',attemptId:attempt.attemptId,idempotencyKey:crypto.randomUUID()});
    assert.equal(ownerJob.status,201,JSON.stringify(ownerJob));
    const runReference='https://github.com/johnkevan88888/family-running/actions/runs/123';
    await assert.rejects(assetEnv.DB.prepare('INSERT INTO private_gallery_job_claims(job_id,run_reference,run_hash) VALUES(?1,?2,?3)')
        .bind(ownerJob.job.jobId,runReference+'x','0'.repeat(64)).run(),/Fixed protected run reference/);
    lastD1Failure=undefined;
    try {
        assert.equal((await claimArchiveJob(assetEnv,ownerJob.job.jobId,runReference,'promotion')).run_reference,runReference);
    } catch (error) { assert.fail(`${error.message}\n${lastD1Failure||'No D1 statement failed.'}`); }
    await assert.rejects(claimArchiveJob(assetEnv,ownerJob.job.jobId,runReference+'4','promotion'),'Different run cannot take the active slot');
    for (const table of ['private_gallery_tag_revisions','private_gallery_revision_tags','private_archive_intakes',
        'private_archive_multipart_uploads','private_archive_original_receipts',
        'private_archive_deletion_requests','private_archive_writer_closures','private_archive_deletion_receipts','private_gallery_attempts',
        ...['admissions','closures','outputs','writers','byte_receipts','review_intents','reviews','review_closures',
            'object_removals','host_receipts','manifest_receipts'].map(name=>`private_gallery_pipeline_${name}`),
            'private_gallery_manifest_removal_intents','private_gallery_manifest_removal_reviews','private_gallery_pipeline_tier_absences',
            'private_archive_purge_operations','private_archive_purge_receipts','private_gallery_retired_generations','private_gallery_retired_keys',
            'private_gallery_review_write_admissions','private_gallery_review_terminals','private_gallery_owner_jobs','private_gallery_job_claims',
            'private_gallery_job_completions','private_gallery_retired_jobs']) {
        const compiled = runWrangler(['d1','execute',...commonArguments,'--command',
            `EXPLAIN INSERT INTO ${table} DEFAULT VALUES`,'--json'],environment);
        assert.equal(compiled.status,0,diagnostic(compiled));
        assert.ok(parseWranglerJson(compiled)[0].results.length>0);
    }

    console.log('Gallery D1 expression-depth parity, private roster, tag correction, archive intake/cleanup, fresh-consent reservation and atomic metadata-purge trigger compilation passed.');
} finally {
    const resolvedTemporaryRoot = await fs.realpath(temporaryRoot);
    assert.equal(path.dirname(resolvedTemporaryRoot), temporaryParent);
    assert.match(path.basename(resolvedTemporaryRoot), /^gallery-d1-expression-depth-/);
    await fs.rm(resolvedTemporaryRoot, { recursive: true, force: true });
}

function runWrangler(arguments_, environment, timeout = 60_000) {
    return spawnSync(process.execPath, [wranglerPath, ...arguments_], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: environment,
        maxBuffer: 16 * 1024 * 1024,
        timeout,
        windowsHide: true
    });
}

function localOnlyEnvironment(configRoot) {
    const environment = {
        ...process.env,
        CI: '1',
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        NO_D1_WARNING: 'true',
        WRANGLER_SEND_METRICS: 'false',
        XDG_CONFIG_HOME: configRoot
    };
    const credentialNames = /^(?:CF|CLOUDFLARE)_(?:ACCOUNT_ID|API_KEY|API_TOKEN|EMAIL)$/i;
    for (const name of Object.keys(environment)) {
        if (credentialNames.test(name)) delete environment[name];
    }
    return environment;
}

function parseWranglerJson(result) {
    try {
        return JSON.parse(result.stdout);
    } catch (error) {
        assert.fail(`${diagnostic(result)}\nJSON parse failed: ${error.message}`);
    }
}

function combinedOutput(result) {
    return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function diagnostic(result) {
    return `Wrangler exited ${result.status}:\n${combinedOutput(result)}`;
}
