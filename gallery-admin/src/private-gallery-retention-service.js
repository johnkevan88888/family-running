import '../../gallery-contract.js';
import {hashIdentity} from './session.js';
import {sha256Hex} from './media-byte-verification.js';
import {readArchiveMediaEpoch,archiveOperationOwner,isArchiveServiceAuthority} from './private-gallery-service-authority.js';
import {archiveRetirementHash} from './private-gallery-retirement.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hex=/^[0-9a-f]{64}$/;
const fail=status=>({ok:false,status,code:'archive-purge-unavailable-or-pending'});
const hash=value=>sha256Hex(new TextEncoder().encode(value));
const canonical=value=>`${JSON.stringify(value,null,2)}\n`;
export const ARCHIVE_PURGE_INSERT=`INSERT INTO private_archive_purge_operations
 (asset_id,owner_hash,epoch_hash,main_sha,manifest_hash,snapshot_json,retirements_json,
 asset_id_hash,reservation_key_hash,scope_hash,proof_hash) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`;

// INTERNAL, DB-only. No HTTP handler, credential discovery, storage, GitHub,
// workflow, merge or publication. Its protected caller must fetch fixed
// current main immediately before calling; supplied snapshots are not live proof.
async function validScope(env,identity,site,assetId) {
    if(!['family','everyone'].includes(site) || !assetId?.startsWith('asset_') || !uuid.test(assetId.slice(6))) return false;
    if(isArchiveServiceAuthority(identity)) {
        if(Object.keys(env||{}).sort().join('|')!=='APPROVED_MEDIA_ORIGIN|ARCHIVE_SERVICE_IDENTITY|DB|EXPECTED_MEDIA_VERSION') return false;
        try {await archiveOperationOwner(env,identity,site,assetId,'purge');return true;} catch {return false;}
    }
    return identity?.type==='browser' && typeof identity.subject==='string' && identity.subject.trim() &&
        Object.keys(env||{}).sort().join('|')==='APPROVED_MEDIA_ORIGIN|DB|EXPECTED_MEDIA_VERSION';
}
const ownerHash=(env,identity,site,asset)=>isArchiveServiceAuthority(identity)?archiveOperationOwner(env,identity,site,asset,'purge'):hashIdentity(identity);
function validMain(main) {
    return main && Object.keys(main).sort().join('|')==='baseSha|manifestsBySite' &&
        /^[0-9a-f]{40}$/.test(main.baseSha||'') && Object.keys(main.manifestsBySite||{}).sort().join('|')==='everyone|family' &&
        ['family','everyone'].every(site=>globalThis.galleryContract.validateGalleryDocument(main.manifestsBySite[site]).length===0) &&
        new TextEncoder().encode(JSON.stringify(main)).length<=2097152;
}
const primary=env=>({...env,DB:env.DB.withSession?.('first-primary')||env.DB});
async function first(env,sql,...args) {return env.DB.prepare(sql).bind(...args).first();}
async function checkedRows(env,sql,...args) {
    const result=await env.DB.prepare(sql).bind(...args).all();
    if(result?.success!==true || !Array.isArray(result.results) || result.results.length>1000) throw new Error('Unavailable');
    return result.results;
}
async function proof(env,identity,site,assetId,main,coordinatedOwner=null) {
    if(!validMain(main)) throw new Error('Main unavailable');
    // Internal group proof consumes independently stored owner requests, not a
    // fabricated browser identity or a wider service authority. The leader's
    // authenticated asset scope is checked before obtaining this owner hash.
    const owner=coordinatedOwner||await ownerHash(env,identity,site,assetId),epoch=await readArchiveMediaEpoch(env);
    const stored=await first(env,'SELECT snapshot_json FROM private_archive_purge_snapshots WHERE asset_id=?1',assetId);
    if(!stored || typeof stored.snapshot_json!=='string' || stored.snapshot_json.length>2097152) throw new Error('Terminal evidence pending');
    const snapshot=JSON.parse(stored.snapshot_json);
    if(snapshot.asset!==assetId || snapshot.owner!==owner || snapshot.site!==site ||
        !['owner-delete','consent-withdrawal'].includes(snapshot.reason) || !Array.isArray(snapshot.attempts) ||
        snapshot.attempts.length>1000 || !Array.isArray(snapshot.outputs) || snapshot.outputs.length>4000) throw new Error('Unavailable');
    const manifestHash=await hash(canonical(main.manifestsBySite[site]));
    // All attempts, including reservations with no output, must be reconciled.
    // With zero attempts there has never been an archive public-generation path.
    for(const [attemptId,,itemId] of snapshot.attempts) {
        const urls=snapshot.outputs.filter(row=>row[0]===attemptId && row[1]==='approved').map(row=>`${env.APPROVED_MEDIA_ORIGIN}/${row[3]}`);
        if(['family','everyone'].some(area=>main.manifestsBySite[area].items.some(item=>item.id===itemId ||
            ['sourceUrl','thumbnailUrl','posterUrl'].some(field=>urls.includes(item[field]))))) throw new Error('Still on main');
        const status=await first(env,`SELECT
            EXISTS(SELECT 1 FROM private_gallery_pipeline_closures WHERE attempt_id=?1) AS closed,
            EXISTS(SELECT 1 FROM private_gallery_pipeline_host_receipts WHERE attempt_id=?1 AND epoch_id_hash=?2) AS host,
            (SELECT count(*) FROM private_gallery_pipeline_tier_absences WHERE attempt_id=?1 AND epoch_id_hash=?2) AS tiers,
            EXISTS(SELECT 1 FROM private_gallery_pipeline_manifest_receipts WHERE attempt_id=?1 AND main_sha=?3 AND manifest_sha256=?4) AS manifest,
            EXISTS(SELECT 1 FROM private_gallery_pipeline_review_intents WHERE attempt_id=?1) AS intent,
            (EXISTS(SELECT 1 FROM private_gallery_pipeline_review_closures WHERE attempt_id=?1) OR
             EXISTS(SELECT 1 FROM private_gallery_review_terminals WHERE attempt_id=?1 AND kind='addition')) AS terminal,
            EXISTS(SELECT 1 FROM private_gallery_manifest_removal_intents i WHERE attempt_id=?1 AND NOT EXISTS(
             SELECT 1 FROM private_gallery_review_terminals t WHERE t.attempt_id=i.attempt_id AND t.kind='removal' AND t.base_sha=i.base_sha)) AS removalReview`,
            attemptId,epoch.epochIdHash,main.baseSha,manifestHash);
        if(status.closed!==1 || status.host!==1 || status.tiers!==2 || status.manifest!==1 ||
            status.intent===1 && status.terminal!==1 || status.removalReview===1) throw new Error('Public cleanup pending');
    }
    const missing=await checkedRows(env,`SELECT o.attempt_id FROM private_gallery_pipeline_outputs o
        JOIN private_gallery_attempts a USING(attempt_id) LEFT JOIN private_gallery_pipeline_object_removals r USING(attempt_id,tier,role)
        WHERE a.asset_id=?1 AND r.attempt_id IS NULL LIMIT 1001`,assetId);
    const writer=await first(env,`SELECT 1 FROM private_archive_multipart_uploads u WHERE u.asset_id=?1 AND NOT EXISTS(
        SELECT 1 FROM private_archive_writer_closures c WHERE c.asset_id=u.asset_id AND c.provider_upload_id=u.provider_upload_id)`,assetId);
    if(missing.length || writer) throw new Error('Byte cleanup pending');
    const retirements={generations:await Promise.all(snapshot.attempts.map(async row=>[
        await archiveRetirementHash('generation',row[1]),await archiveRetirementHash('item',row[2])])),
        keys:await Promise.all(snapshot.outputs.map(row=>archiveRetirementHash('key',row[3])))};
    if(new Set(retirements.keys).size!==retirements.keys.length) throw new Error('Duplicate targets');
    const proofHash=await hash(JSON.stringify([stored.snapshot_json,epoch.epochIdHash,main.baseSha,manifestHash,retirements]));
    return {owner,epochHash:epoch.epochIdHash,mainSha:main.baseSha,manifestHash,snapshot:stored.snapshot_json,retirements,
        assetHash:await archiveRetirementHash('asset',assetId),
        reservationHash:await archiveRetirementHash('reservation',JSON.stringify([owner,site,snapshot.reservation])),proofHash,
        attemptCount:snapshot.attempts.length,outputCount:snapshot.outputs.length};
}
async function batchGroup(env,owner,site,assetId) {
    const rows=await checkedRows(env,`SELECT m.job_id,m.asset_id,c.result_json FROM private_gallery_batch_members m
        LEFT JOIN private_gallery_batch_completions c USING(job_id)
        WHERE m.owner_hash=?1 AND m.site_mode=?2 ORDER BY m.job_id,m.ordinal LIMIT 1001`,owner,site);
    if(!rows.some(row=>row.asset_id===assetId)) return null;
    const assets=new Set([assetId]),jobs=new Set();let changed=true;
    while(changed) {
        changed=false;
        for(const row of rows) if(assets.has(row.asset_id)||jobs.has(row.job_id)) {
            if(!row.result_json || !['removed','publication-observed'].includes(JSON.parse(row.result_json).state)) throw new Error('Shared review still active');
            if(!assets.has(row.asset_id)) {assets.add(row.asset_id);changed=true;}
            if(!jobs.has(row.job_id)) {jobs.add(row.job_id);changed=true;}
        }
    }
    if(assets.size>1000 || jobs.size>1000) throw new Error('Group unavailable');
    return {assets:[...assets].sort(),jobs:[...jobs].sort()};
}
async function groupProofs(env,identity,site,assetId,main,leader) {
    const group=await batchGroup(env,leader.owner,site,assetId);
    if(!group) return null;
    const proofs=[];
    for(const id of group.assets) proofs.push({assetId:id,value:id===assetId?leader:await proof(env,identity,site,id,main,leader.owner)});
    if(proofs.some(row=>row.value.epochHash!==leader.epochHash || row.value.mainSha!==leader.mainSha || row.value.manifestHash!==leader.manifestHash))
        throw new Error('Changed shared proof');
    return {...group,proofs};
}
async function purgeBatchGroup(env,identity,site,assetId,main,leader,scopeHash) {
    const group=await groupProofs(env,identity,site,assetId,main,leader);
    if(!group) return false;
    const active=await first(env,`SELECT job_id FROM private_gallery_active_job WHERE asset_id=?1 AND owner_hash=?2
        AND action='purge' AND expected_proof_hash=?3 AND purge_scope_hash=?4`,assetId,leader.owner,leader.proofHash,scopeHash);
    if(!active) throw new Error('Exact active coordinator unavailable');
    const grants=[];
    for(const {assetId:id,value:p} of group.proofs) {
        const job=await first(env,`SELECT j.job_id,j.purge_scope_hash FROM private_gallery_owner_jobs j
            WHERE j.asset_id=?1 AND j.owner_hash=?2 AND j.site_mode=?3 AND j.action='purge' AND j.expected_proof_hash=?4
            AND NOT EXISTS(SELECT 1 FROM private_gallery_job_completions c WHERE c.job_id=j.job_id)
            AND (j.job_id=?5 OR NOT EXISTS(SELECT 1 FROM private_gallery_job_claims c WHERE c.job_id=j.job_id))
            AND (?1!=?6 OR j.job_id=?5) ORDER BY j.created_at,j.job_id LIMIT 1`,id,leader.owner,site,p.proofHash,active.job_id,assetId);
        if(!job) throw new Error('Each member needs its own exact owner-confirmed purge');
        grants.push({assetId:id,ownerHash:p.owner,epochHash:p.epochHash,mainSha:p.mainSha,manifestHash:p.manifestHash,
            snapshotJson:p.snapshot,retirementsJson:JSON.stringify(p.retirements),assetHash:p.assetHash,reservationHash:p.reservationHash,
            scopeHash:job.purge_scope_hash,proofHash:p.proofHash,jobId:job.job_id});
    }
    const groupHash=await hash(JSON.stringify(['private-gallery-batch-group-purge-v1',group.jobs,
        grants.map(g=>[g.jobId,g.assetHash,g.scopeHash,g.proofHash])]));
    const result=await env.DB.prepare(`INSERT INTO private_gallery_batch_purge_operations
        (coordinator_job_id,owner_hash,batch_job_ids_json,grants_json,group_proof_hash) VALUES(?1,?2,?3,?4,?5)`)
        .bind(active.job_id,leader.owner,JSON.stringify(group.jobs),JSON.stringify(grants),groupHash).run();
    if(result?.success!==true) throw new Error('Unavailable');return true;
}
export async function inspectPrivateArchivePurge(env,identity,site,assetId,main) {
    if(!await validScope(env,identity,site,assetId)) return fail(403);
    try {
        env=primary(env);const p=await proof(env,identity,site,assetId,main);
        // Inspection has no deletion authority. For a shared group, every
        // sibling must already be terminal and independently cleanup-ready.
        await groupProofs(env,identity,site,assetId,main,p);
        return {ok:true,status:200,state:'purge-eligible',dryRun:true,proofHash:p.proofHash,
            mainSha:p.mainSha,attemptCount:p.attemptCount,outputCount:p.outputCount,publicationEnabled:false};
    } catch {return fail(409);}
}
export async function purgePrivateArchiveMetadata(env,identity,site,assetId,input) {
    if(!await validScope(env,identity,site,assetId)) return fail(403);
    if(!input || Object.keys(input).sort().join('|')!=='expectedProofHash|main|purgeKey' ||
        !uuid.test(input.purgeKey||'') || !hex.test(input.expectedProofHash||'')) return fail(422);
    env=primary(env);
    try {
        const assetHash=await archiveRetirementHash('asset',assetId);
        const scopeHash=await hash(JSON.stringify(['private-gallery-purge-v1',await ownerHash(env,identity,site,assetId),site,assetId,input.purgeKey]));
        const readReceipt=()=>first(env,'SELECT scope_hash,proof_hash FROM private_archive_purge_receipts WHERE asset_id_hash=?1',assetHash);
        const done=async()=> {
            const receipt=await readReceipt();
            if(!receipt) return null;
            if(receipt.scope_hash!==scopeHash || receipt.proof_hash!==input.expectedProofHash ||
                await first(env,'SELECT 1 FROM private_gallery_assets WHERE asset_id=?1',assetId)) return fail(409);
            return {ok:true,status:200,state:'private-records-purged',replayed:true,publicationEnabled:false};
        };
        const existing=await done();if(existing) return existing;
        const p=await proof(env,identity,site,assetId,input.main);
        if(p.proofHash!==input.expectedProofHash) return fail(409);
        try {
            // One INSERT's guarded trigger records hash-only retirement and
            // deletes all owned operational rows atomically; no persisted grant.
            if(!await purgeBatchGroup(env,identity,site,assetId,input.main,p,scopeHash)) {
                const result=await env.DB.prepare(ARCHIVE_PURGE_INSERT).bind(assetId,p.owner,p.epochHash,p.mainSha,p.manifestHash,p.snapshot,
                    JSON.stringify(p.retirements),p.assetHash,p.reservationHash,scopeHash,p.proofHash).run();
                if(result?.success!==true) throw new Error('Unavailable');
            }
        } catch {const recovered=await done();return recovered||fail(409);}
        const completed=await done();
        return completed?.ok?{...completed,replayed:false}:fail(503);
    } catch {return fail(409);}
}
