import '../../gallery-contract.js';
import toolchain from '../../scripts/gallery-media-toolchain.json' with {type:'json'};
import { reservePrivateGalleryAttempt } from './private-gallery-attempt-service.js';
import {assertArchiveIdentityAvailable} from './private-gallery-retirement.js';
import {archiveOperationOwner,isArchiveServiceAuthority,archiveServiceTier,
    recheckArchiveServiceConsent,readArchiveMediaEpoch} from './private-gallery-service-authority.js';
import { inspectStaticWebp,readBoundedBytes,sha256Hex } from './media-byte-verification.js';
import { matchesExactImageHttpMetadata } from './r2-http-metadata.js';
import { buildV2PhotoDerivativeKey } from './photo-generation-keys.js';
import { proveArchivePhotoHostAbsence } from './public-host-verifier-service.js';
import { MEDIA_BINDING_WITNESS_KEY,MEDIA_BINDING_WITNESS_SHA256,MEDIA_BINDING_WITNESS_SIZE,
    MEDIA_BINDING_WITNESS_CONTENT_TYPE,MEDIA_DELIVERY_CONTRACT_VALUE } from './media-delivery-contract.js';

// Internal binding-only lifecycle, not an HTTP authentication boundary. No
// default network adapter, publication, old-draft ownership or UI activation.
const roles=['photo-display','photo-thumbnail'];
const fail=()=>({ok:false,status:409,code:'private-photo-pending-or-changed'});
const digest=value=>sha256Hex(new TextEncoder().encode(value));
const safe=value=>typeof value==='string' && value.length>0 && value.length<=512 && !/[\u0000-\u001f\u007f]/u.test(value);
const first=(env,sql,...values)=>env.DB.prepare(sql).bind(...values).first();
async function all(env,sql,...values) {
    const value=await env.DB.prepare(sql).bind(...values).all();
    if(value?.success!==true || !Array.isArray(value.results)) throw new Error('Unavailable');
    return value.results;
}
async function insert(env,sql,...values) {
    const result=await env.DB.prepare(sql).bind(...values).run();
    if(result?.success!==true) throw new Error('Unavailable');
}
function primary(env) { return {...env,DB:env.DB.withSession?.('first-primary')||env.DB}; }

export async function readArchivePhotoAttempt(env,identity,site,attemptId,catalog,{allowClosed=false}={}) {
    if(!['family','everyone'].includes(site) ||
        !/^attempt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(attemptId||'')) throw new Error('Unavailable');
    const row=await first(env,`SELECT a.*,s.private_object_key,s.original_format FROM private_gallery_attempts a
        JOIN private_gallery_assets s ON s.asset_id=a.asset_id WHERE a.attempt_id=?1 AND a.owner_identity_hash=?2 AND a.site_mode=?3`,
        attemptId,await archiveOperationOwner(env,identity,site,attemptId),site);
    if(!row) throw new Error('Unavailable');
    await assertArchiveIdentityAvailable(env,'generation',row.generation_id);
    await assertArchiveIdentityAvailable(env,'item',row.public_item_id);
    if(row.private_object_key!==`private-archive/v1/${site}/${row.asset_id}/original.${row.original_format}` ||
        !['jpg','png'].includes(row.original_format)) throw new Error('Unavailable');
    if(allowClosed) return row;
    if(await first(env,'SELECT 1 FROM private_gallery_pipeline_closures WHERE attempt_id=?1',attemptId)) throw new Error('Closed');
    if(isArchiveServiceAuthority(identity)) {
        await recheckArchiveServiceConsent(env,row,catalog);
        return row;
    }
    const raceIndex=catalog?.sites?.[site]?.catalog?.races?.findIndex(r=>r.raceDate===row.race_date &&
        r.raceEvent===row.race_event && r.raceDistance===row.race_distance);
    const checked=await reservePrivateGalleryAttempt(env,identity,site,row.asset_id,{
        idempotencyKey:row.idempotency_key,tagVersion:row.tag_version,eligibilityRevision:row.eligibility_revision,
        sourceRevision:row.source_revision,suppressionRevision:row.suppression_revision,raceIndex,
        completeTagsConfirmed:true,publicUseConfirmed:true,containsMinors:Boolean(row.contains_minors),
        guardianApprovalConfirmed:Boolean(row.guardian_approval_confirmed)},catalog);
    if(!checked.ok || checked.attemptId!==attemptId || !await first(env,
        'SELECT 1 FROM private_gallery_current_attempt_permissions WHERE attempt_id=?1',attemptId)) throw new Error('Changed');
    return row;
}

async function epoch(env) {
    return readArchiveMediaEpoch(env);
}

export async function admitArchivePhotoProcessing(env,identity,site,attemptId,catalog) {
    env=primary(env);
    try {
        await archiveOperationOwner(env,identity,site,attemptId,'admit');
        await readArchivePhotoAttempt(env,identity,site,attemptId,catalog);
        const current=await epoch(env);
        const prior=await first(env,'SELECT * FROM private_gallery_pipeline_admissions WHERE attempt_id=?1',attemptId);
        if(prior && prior.epoch_id_hash!==current.epochIdHash) throw new Error('Changed');
        if(!prior) {
            try { await insert(env,'INSERT INTO private_gallery_pipeline_admissions(attempt_id,epoch_id_hash) VALUES(?1,?2)',attemptId,current.epochIdHash); }
            catch { const stored=await first(env,'SELECT * FROM private_gallery_pipeline_admissions WHERE attempt_id=?1',attemptId);
                if(stored?.epoch_id_hash!==current.epochIdHash) throw new Error('Unavailable'); }
        }
        await readArchivePhotoAttempt(env,identity,site,attemptId,catalog);
        return {ok:true,status:200,attemptId,state:'admitted',replayed:Boolean(prior)};
    } catch { return fail(); }
}

export async function readArchivePhotoSource(env,identity,site,attemptId,catalog) {
    env=primary(env);
    await archiveOperationOwner(env,identity,site,attemptId,'source');
    const row=await readArchivePhotoAttempt(env,identity,site,attemptId,catalog);
    if(!await first(env,'SELECT 1 FROM private_gallery_pipeline_admissions WHERE attempt_id=?1',attemptId)) throw new Error('Not admitted');
    const object=await env.PRIVATE_ORIGINALS.get(row.private_object_key,{onlyIf:{etagMatches:row.original_provider_etag}});
    if(!object?.body || object.version!==row.original_provider_version || object.etag!==row.original_provider_etag ||
        object.size!==row.original_byte_count) throw new Error('Source changed');
    const bytes=await readBoundedBytes(object.body,row.original_byte_count);
    if(bytes.length!==row.original_byte_count || await sha256Hex(bytes)!==row.original_sha256) throw new Error('Source changed');
    await readArchivePhotoAttempt(env,identity,site,attemptId,catalog);
    return {bytes,fileExtension:row.original_format,declaredMimeType:row.original_format==='jpg'?'image/jpeg':'image/png',
        expectedSha256:row.original_sha256,site};
}

async function outputRows(env,attemptId) {
    const rows=await all(env,`SELECT o.*,w.upload_id,b.provider_version,b.provider_etag,r.writer_proof
        FROM private_gallery_pipeline_outputs o LEFT JOIN private_gallery_pipeline_writers w USING(attempt_id,tier,role)
        LEFT JOIN private_gallery_pipeline_byte_receipts b USING(attempt_id,tier,role)
        LEFT JOIN private_gallery_pipeline_object_removals r USING(attempt_id,tier,role)
        WHERE o.attempt_id=?1 ORDER BY o.tier,o.role LIMIT 5`,attemptId);
    if(rows.length>4) throw new Error('Invalid set');
    return rows;
}
async function verifiedBytes(bucket,row,object=null) {
    object ||= await bucket.get(row.object_key,row.provider_etag?{onlyIf:{etagMatches:row.provider_etag}}:{});
    if(!object?.body || object.size!==row.byte_count || !safe(object.etag) || !safe(object.version) ||
        (row.provider_version && (object.version!==row.provider_version || object.etag!==row.provider_etag)) ||
        object.httpMetadata?.cacheControl!=='no-store' ||
        !matchesExactImageHttpMetadata({...object.httpMetadata,cacheControl:undefined},'image/webp') ||
        !object.customMetadata || Object.keys(object.customMetadata).sort().join('|')!=='role|scope|sha256' ||
        object.customMetadata.scope!=='archive-photo-v2' || object.customMetadata.role!==row.role ||
        object.customMetadata.sha256!==row.sha256) throw new Error('Object changed');
    const bytes=await readBoundedBytes(object.body,row.byte_count);
    const dimensions=inspectStaticWebp(bytes);
    if(bytes.length!==row.byte_count || await sha256Hex(bytes)!==row.sha256 ||
        dimensions?.width!==row.width || dimensions?.height!==row.height) throw new Error('Object changed');
    return {bytes,version:object.version,etag:object.etag};
}

// Called by the trusted pinned processor, never with browser scanner claims.
export async function storeArchivePhotoDerivative(env,identity,site,attemptId,catalog,tier,derivative,scan) {
    env=primary(env);
    await archiveOperationOwner(env,identity,site,attemptId,tier);
    const attempt=await readArchivePhotoAttempt(env,identity,site,attemptId,catalog);
    if(!['staging','approved'].includes(tier) || !roles.includes(derivative?.storageRole) || !derivative.payload ||
        scan?.videoEnabled!==false || Object.keys(scan).sort().join('|')!=='exiftool|libvips|png|sharp|videoEnabled|webp' ||
        scan.sharp!==toolchain.photo.sharpRuntimeVersion || scan.libvips!==toolchain.photo.libvipsRuntimeVersion ||
        scan.webp!==toolchain.photo.webpRuntimeVersion || scan.png!==toolchain.photo.pngRuntimeVersion ||
        scan.exiftool!==toolchain.photo.exiftoolRuntimeVersion) throw new Error('Invalid derivative');
    const bytes=await readBoundedBytes(derivative.payload.stream(),tier==='staging'?26214400:26214400);
    const dimensions=inspectStaticWebp(bytes),role=derivative.storageRole;
    if(!dimensions || dimensions.width!==derivative.width || dimensions.height!==derivative.height ||
        bytes.length!==derivative.byteLength || await sha256Hex(bytes)!==derivative.sha256) throw new Error('Invalid derivative');
    const key=tier==='approved'?buildV2PhotoDerivativeKey({generationId:attempt.generation_id,sha256:derivative.sha256,role}):
        `derivative-staging/v2/${site}/${attempt.generation_id}/${derivative.sha256}/${role==='photo-display'?'display.webp':'thumbnail.webp'}`;
    await assertArchiveIdentityAvailable(env,'key',key);
    const scanJson=JSON.stringify(scan);
    let row=(await outputRows(env,attemptId)).find(r=>r.tier===tier && r.role===role);
    if(!row) {
        try { await insert(env,`INSERT INTO private_gallery_pipeline_outputs
            (attempt_id,tier,role,object_key,sha256,byte_count,width,height,scan_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
            attemptId,tier,role,key,derivative.sha256,bytes.length,dimensions.width,dimensions.height,scanJson); }
        catch { row=(await outputRows(env,attemptId)).find(r=>r.tier===tier && r.role===role);if(!row) throw new Error('Unavailable'); }
        row=(await outputRows(env,attemptId)).find(r=>r.tier===tier && r.role===role);
    }
    if(row.object_key!==key || row.sha256!==derivative.sha256 || row.byte_count!==bytes.length ||
        row.width!==dimensions.width || row.height!==dimensions.height || row.scan_json!==scanJson) throw new Error('Conflicting retry');
    const bucket=tier==='staging'?env.PRIVATE_DERIVATIVE_STAGING:env.APPROVED_MEDIA;
    if(tier==='approved') {
        const staged=(await outputRows(env,attemptId)).find(r=>r.tier==='staging' && r.role===role);
        if(!staged?.provider_version) throw new Error('Staging unavailable');
        await verifiedBytes(env.PRIVATE_DERIVATIVE_STAGING,staged);
    }
    if(row.provider_version) {
        await verifiedBytes(bucket,row);await readArchivePhotoAttempt(env,identity,site,attemptId,catalog);return;
    }
    if(!row.upload_id) {
        await readArchivePhotoAttempt(env,identity,site,attemptId,catalog);
        const multipart=await bucket.createMultipartUpload(key,{httpMetadata:{contentType:'image/webp',cacheControl:'no-store'},
            customMetadata:{scope:'archive-photo-v2',role,sha256:row.sha256}});
        if(!safe(multipart?.uploadId) || multipart.key!==key) throw new Error('Invalid provider');
        let registered=false;
        try { await insert(env,`INSERT INTO private_gallery_pipeline_writers(attempt_id,tier,role,upload_id) VALUES(?1,?2,?3,?4)`,
            attemptId,tier,role,multipart.uploadId);registered=true; }
        catch { row=(await outputRows(env,attemptId)).find(r=>r.tier===tier && r.role===role);
            registered=row?.upload_id===multipart.uploadId; }
        if(!registered) { await multipart.abort();throw new Error('Writer blocked'); }
        row=(await outputRows(env,attemptId)).find(r=>r.tier===tier && r.role===role);
    }
    await readArchivePhotoAttempt(env,identity,site,attemptId,catalog);
    let present=await bucket.get(key);
    if(!present) {
        const multipart=bucket.resumeMultipartUpload(key,row.upload_id);
        try { const part=await multipart.uploadPart(1,bytes);
            await readArchivePhotoAttempt(env,identity,site,attemptId,catalog);
            await multipart.complete([part]); }
        catch { present=await bucket.get(key);if(!present) throw new Error('Provider pending'); }
        present ||= await bucket.get(key);
    }
    const proof=await verifiedBytes(bucket,row,present);
    await readArchivePhotoAttempt(env,identity,site,attemptId,catalog);
    try { await insert(env,`INSERT INTO private_gallery_pipeline_byte_receipts(attempt_id,tier,role,provider_version,provider_etag)
        VALUES(?1,?2,?3,?4,?5)`,attemptId,tier,role,proof.version,proof.etag); }
    catch { const recovered=(await outputRows(env,attemptId)).find(r=>r.tier===tier && r.role===role);
        if(recovered?.provider_version!==proof.version || recovered?.provider_etag!==proof.etag) throw new Error('Unavailable'); }
    await readArchivePhotoAttempt(env,identity,site,attemptId,catalog);
}

export async function readArchivePhotoCandidateItem(env,identity,site,attemptId,catalog) {
    env=primary(env);
    await archiveOperationOwner(env,identity,site,attemptId,'candidate');
    const a=await readArchivePhotoAttempt(env,identity,site,attemptId,catalog);
    const current=await epoch(env);
    const admission=await first(env,'SELECT * FROM private_gallery_pipeline_admissions WHERE attempt_id=?1',attemptId);
    if(admission?.epoch_id_hash!==current.epochIdHash) throw new Error('Changed epoch');
    const rows=await outputRows(env,attemptId),approved=rows.filter(r=>r.tier==='approved');
    if(rows.length!==4 || approved.length!==2 || rows.some(r=>!r.provider_version)) throw new Error('Pair unavailable');
    for(const row of rows) await verifiedBytes(row.tier==='approved'?env.APPROVED_MEDIA:env.PRIVATE_DERIVATIVE_STAGING,row);
    await readArchivePhotoAttempt(env,identity,site,attemptId,catalog);
    const item={id:a.public_item_id,type:'photo',title:'Photo',caption:'',alt:'Photo',raceDate:a.race_date,raceEvent:a.race_event,
        raceDistance:a.race_distance,sourceUrl:`${current.approvedOrigin}/${approved.find(r=>r.role==='photo-display').object_key}`,
        thumbnailUrl:`${current.approvedOrigin}/${approved.find(r=>r.role==='photo-thumbnail').object_key}`,
        featured:false,athleteIds:JSON.parse(a.public_athlete_ids_json)};
    if(globalThis.galleryContract.validateGalleryDocument({schemaVersion:'1.0',items:[item]}).length) throw new Error('Invalid public item');
    return item;
}

export async function closeArchivePhotoAttempt(env,identity,site,attemptId,reason='cancelled') {
    env=primary(env);
    await archiveOperationOwner(env,identity,site,attemptId,'close');
    await readArchivePhotoAttempt(env,identity,site,attemptId,null,{allowClosed:true});
    if(!['failed','cancelled'].includes(reason)) throw new Error('Invalid close request');
    if(!await first(env,'SELECT 1 FROM private_gallery_pipeline_closures WHERE attempt_id=?1',attemptId)) {
        try { await insert(env,'INSERT INTO private_gallery_pipeline_closures(attempt_id,reason) VALUES(?1,?2)',attemptId,reason); }
        catch { if(!await first(env,'SELECT 1 FROM private_gallery_pipeline_closures WHERE attempt_id=?1',attemptId)) throw new Error('Unavailable'); }
    }
}

async function emptyPrefix(bucket,prefix) {
    let cursor;const seen=new Set();
    for(let page=0;page<1000;page++) {
        const result=await bucket.list({prefix,limit:1000,...(cursor?{cursor}:{})});
        if(!Array.isArray(result?.objects) || result.objects.length || !Array.isArray(result.delimitedPrefixes||[]) ||
            (result.delimitedPrefixes||[]).length) throw new Error('Unexpected storage object');
        if(result.truncated===false) return;
        if(result.truncated!==true || !safe(result.cursor) || seen.has(result.cursor)) throw new Error('Invalid pagination');
        cursor=result.cursor;seen.add(cursor);
    }
    throw new Error('Invalid pagination');
}

// Privacy-first cleanup deliberately does not call GitHub. Registered writers
// are closed BEFORE object deletion, including abort-resolves-after-completion.
// No original I/O is performed; receipts and exact target keys remain immutable.
export async function removeArchivePhotoCopies(env,identity,site,attemptId) {
    env=primary(env);
    try {
        const a=await readArchivePhotoAttempt(env,identity,site,attemptId,null,{allowClosed:true});
        const scopedTier=archiveServiceTier(identity,env,site,attemptId);
        if(scopedTier) await archiveOperationOwner(env,identity,site,attemptId,`remove-${scopedTier}`);
        if(!await first(env,'SELECT 1 FROM private_gallery_pipeline_closures WHERE attempt_id=?1',attemptId)) throw new Error('Not closed');
        const rows=await outputRows(env,attemptId);
        for(const row of rows) {
            if(scopedTier && row.tier!==scopedTier) continue;
            const bucket=row.tier==='approved'?env.APPROVED_MEDIA:env.PRIVATE_DERIVATIVE_STAGING;
            if(row.writer_proof) continue;
            let writerProof='no-writer';
            if(row.upload_id) {
                try { await bucket.resumeMultipartUpload(row.object_key,row.upload_id).abort();writerProof='aborted'; }
                catch(error) { if(!(error?.code==='NoSuchUpload' || error?.name==='NoSuchUpload' && Number(error.code)===10024)) throw error;
                    writerProof='no-such-upload'; }
            }
            const present=await bucket.get(row.object_key);
            if(present) {
                await verifiedBytes(bucket,row,present);
                await bucket.delete(row.object_key);
            }
            if(await bucket.head(row.object_key)) throw new Error('Object still present');
            try { await insert(env,`INSERT INTO private_gallery_pipeline_object_removals(attempt_id,tier,role,writer_proof)
                VALUES(?1,?2,?3,?4)`,attemptId,row.tier,row.role,writerProof); }
            catch { if(!await first(env,`SELECT 1 FROM private_gallery_pipeline_object_removals
                WHERE attempt_id=?1 AND tier=?2 AND role=?3`,attemptId,row.tier,row.role)) throw new Error('Unavailable'); }
        }
        if(!scopedTier || scopedTier==='approved') await emptyPrefix(env.APPROVED_MEDIA,`media/v2/${a.generation_id}/`);
        if(!scopedTier || scopedTier==='staging') await emptyPrefix(env.PRIVATE_DERIVATIVE_STAGING,`derivative-staging/v2/${site}/${a.generation_id}/`);
        for(const tier of scopedTier?[scopedTier]:['staging','approved']) {
            const current=await epoch(env);
            const found=()=>first(env,`SELECT 1 FROM private_gallery_pipeline_tier_absences
                WHERE attempt_id=?1 AND tier=?2 AND epoch_id_hash=?3`,attemptId,tier,current.epochIdHash);
            if(!await found()) {
                try {await insert(env,`INSERT INTO private_gallery_pipeline_tier_absences(attempt_id,tier,epoch_id_hash)
                    VALUES(?1,?2,?3)`,attemptId,tier,current.epochIdHash);}
                catch {if(!await found()) throw new Error('Unavailable');}
            }
            if((await epoch(env)).epochIdHash!==current.epochIdHash) throw new Error('Changed epoch');
        }
        return {ok:true,status:200,state:scopedTier?`${scopedTier}-copies-removed`:'copies-removed',hostDeletionConfirmed:false};
    } catch { return fail(); }
}

export async function verifyArchivePhotoPublicAbsence(env,identity,site,attemptId,fetchImpl,timeoutMilliseconds) {
    if(isArchiveServiceAuthority(identity)) return verifyScopedArchivePhotoPublicAbsence(env,identity,site,attemptId,fetchImpl,timeoutMilliseconds);
    return verifyArchivePhotoHostCore(env,identity,site,attemptId,fetchImpl,timeoutMilliseconds,async (env,a)=>{
        await emptyPrefix(env.APPROVED_MEDIA,`media/v2/${a.generation_id}/`);
        await emptyPrefix(env.PRIVATE_DERIVATIVE_STAGING,`derivative-staging/v2/${site}/${a.generation_id}/`);
    });
}

// Dedicated service entry point has no R2 dependency or bucket references in
// its compiled bundle. The shared host protocol itself is unchanged.
export async function verifyScopedArchivePhotoPublicAbsence(env,identity,site,attemptId,fetchImpl,timeoutMilliseconds) {
    if(!isArchiveServiceAuthority(identity)) return fail();
    return verifyArchivePhotoHostCore(env,identity,site,attemptId,fetchImpl,timeoutMilliseconds,async (env,a,e)=>{
        const proofs=await all(env,`SELECT tier FROM private_gallery_pipeline_tier_absences
            WHERE attempt_id=?1 AND epoch_id_hash=?2 ORDER BY tier`,attemptId,e.epochIdHash);
        if(JSON.stringify(proofs.map(r=>r.tier))!==JSON.stringify(['approved','staging'])) throw new Error('Storage pending');
    });
}

async function verifyArchivePhotoHostCore(env,identity,site,attemptId,fetchImpl,timeoutMilliseconds,checkStorage) {
    env=primary(env);
    try {
        await archiveOperationOwner(env,identity,site,attemptId,'verify');
        const a=await readArchivePhotoAttempt(env,identity,site,attemptId,null,{allowClosed:true});
        if(!await first(env,'SELECT 1 FROM private_gallery_pipeline_closures WHERE attempt_id=?1',attemptId)) throw new Error('Not closed');
        const e=await epoch(env),rows=await outputRows(env,attemptId);
        if(rows.some(r=>!r.writer_proof)) throw new Error('Storage pending');
        await checkStorage(env,a,e);
        const prior=await first(env,`SELECT * FROM private_gallery_pipeline_host_receipts WHERE attempt_id=?1 AND epoch_id_hash=?2`,attemptId,e.epochIdHash);
        if(prior) return {ok:true,status:200,hostDeletionConfirmed:true,replayed:true};
        const targets=await Promise.all(rows.filter(r=>r.tier==='approved').map(async r=>({approvedObjectKey:r.object_key,
            approvedObjectKeyHash:await digest(`approved-object-key:${r.object_key}`)})));
        const config={mediaOrigin:e.approvedOrigin,mediaVersion:env.EXPECTED_MEDIA_VERSION,mediaContract:MEDIA_DELIVERY_CONTRACT_VALUE,
            witnessKey:MEDIA_BINDING_WITNESS_KEY,witnessSha256:MEDIA_BINDING_WITNESS_SHA256,witnessByteCount:MEDIA_BINDING_WITNESS_SIZE,
            witnessContentType:MEDIA_BINDING_WITNESS_CONTENT_TYPE};
        const proof=await proveArchivePhotoHostAbsence(fetchImpl,config,targets,timeoutMilliseconds);
        if(!proof.ok) return proof;
        if((await epoch(env)).epochIdHash!==e.epochIdHash) throw new Error('Epoch changed');
        const latest=await outputRows(env,attemptId);
        if(JSON.stringify(latest)!==JSON.stringify(rows)) throw new Error('Target set changed');
        await insert(env,`INSERT INTO private_gallery_pipeline_host_receipts(attempt_id,epoch_id_hash,evidence_json) VALUES(?1,?2,?3)`,
            attemptId,e.epochIdHash,JSON.stringify({keys:rows.filter(r=>r.tier==='approved').map(r=>r.object_key),
                witness:proof.witnessEvidence,targets:[...proof.targetEvidence]}));
        return {ok:true,status:200,hostDeletionConfirmed:true,replayed:false};
    } catch { return fail(); }
}

export async function readArchivePhotoRemovalState(env,identity,site,attemptId) {
    env=primary(env);
    await readArchivePhotoAttempt(env,identity,site,attemptId,null,{allowClosed:true});
    const completed=Boolean(await first(env,'SELECT 1 FROM private_gallery_pipeline_current_removal WHERE attempt_id=?1',attemptId));
    return {ok:true,status:200,state:completed?'removed':'removal-pending',completed};
}
