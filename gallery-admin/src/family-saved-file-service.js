import mediaPolicyModule from '../../gallery-media-policy.js';
import {hashIdentity} from './session.js';
import {readBoundedBytes,sha256Hex} from './media-byte-verification.js';
import {requireFamilyPermission} from './family-permission.js';
import {assertArchiveIdentityAvailable} from './private-gallery-retirement.js';

const policy=mediaPolicyModule?.default||mediaPolicyModule;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const first=(env,sql,...args)=>env.DB.prepare(sql).bind(...args).first();
const fail=(status=409)=>({ok:false,status,code:'family-private-file-unavailable'});
const safe=value=>typeof value==='string'&&value.length>0&&value.length<=1024&&!/[\u0000-\u001f\u007f]/u.test(value);
const key=row=>`private-archive/v1/family/${row.asset_id}/original.${row.original_format}`;
async function write(env,sql,...args) {
    const result=await env.DB.prepare(sql).bind(...args).run();
    if(result?.success!==true)throw new Error('Unavailable');
}
async function context(env,identity,site,draftId,photoId,{writing=false,deleting=false}={}) {
    if(site!=='family'||identity?.type!=='browser'||typeof identity.subject!=='string'||!identity.subject.trim()||
        !uuid.test(draftId||'')||!uuid.test(photoId||''))throw new Error('Unavailable');
    const owner=await hashIdentity(identity);
    const row=await first(env,`SELECT p.*,d.owner_hash,d.state AS draft_state,f.asset_id AS file_asset_id,
        f.original_format,f.byte_count,f.sha256,f.permission_version,f.provider_upload_id,f.provider_version,f.provider_etag,f.writer_closed,
        f.delete_requested,f.deletion_closure,f.original_absent,
        EXISTS(SELECT 1 FROM private_archive_deletion_requests x WHERE x.asset_id=f.asset_id) AS deleted
        FROM family_gallery_draft_photos p JOIN family_gallery_drafts d USING(draft_id)
        LEFT JOIN family_gallery_saved_files f ON f.photo_id=p.photo_id
        WHERE p.photo_id=?1 AND d.draft_id=?2 AND d.owner_hash=?3`,photoId,draftId,owner);
    if(!row||row.deleted||row.delete_requested&&!deleting||writing&&row.draft_state!=='editing')throw new Error('Unavailable');
    if(row.file_asset_id) {
        const data=JSON.parse(row.metadata_json);
        if(row.original_format!==data.originalFormat||row.byte_count!==data.byteCount||row.sha256!==data.sha256||
            row.asset_id&&row.asset_id!==row.file_asset_id)throw new Error('Source changed');
    }
    return {...row,asset_id:row.file_asset_id,owner};
}
async function uploadContext(env,identity,site,draftId,photoId) {
    const row=await context(env,identity,site,draftId,photoId,{writing:true});
    if(!row.asset_id)throw new Error('File not prepared');
    // No assertion about people's identities or ages is made at file capture.
    // Those separate, mandatory attestations remain in the normal intake path.
    await requireFamilyPermission(env,row.owner,site,row.permission_version,false);
    return row;
}
const saved=row=>({ok:true,status:200,savedPrivately:Boolean(row.provider_version&&row.writer_closed),publicationEnabled:false});

export async function prepareFamilySavedFile(env,identity,site,draftId,photoId,input) {
    try {
        if(!input||Array.isArray(input)||typeof input!=='object'||Object.keys(input).join('|')!=='permissionVersion')return fail(422);
        let row=await context(env,identity,site,draftId,photoId,{writing:true});
        await requireFamilyPermission(env,row.owner,site,input.permissionVersion,false);
        if(!row.asset_id) {
            if(row.reservation_json) return fail(); // Legacy intake keeps its original route.
            await assertArchiveIdentityAvailable(env,'reservation',JSON.stringify([row.owner,site,photoId]));
            const data=JSON.parse(row.metadata_json),assetId=`asset_${crypto.randomUUID()}`;
            await assertArchiveIdentityAvailable(env,'asset',assetId);
            try {await write(env,`INSERT INTO family_gallery_saved_files
                (photo_id,draft_id,owner_hash,asset_id,original_format,byte_count,sha256,permission_version)
                VALUES(?1,?2,?3,?4,?5,?6,?7,?8)`,photoId,draftId,row.owner,assetId,data.originalFormat,data.byteCount,data.sha256,input.permissionVersion);}
            catch { /* Readback reconciles only the same owner/source slot. */ }
            row=await uploadContext(env,identity,site,draftId,photoId);
        }
        if(row.permission_version!==input.permissionVersion&&!row.provider_version)return fail();
        return saved(row);
    }catch{return fail();}
}

function matches(object,row) {
    return object?.key===key(row)&&object.size===row.byte_count&&safe(object.version)&&safe(object.etag)&&
        (!row.provider_version||object.version===row.provider_version&&object.etag===row.provider_etag);
}
async function checkedBytes(env,row) {
    const object=await env.PRIVATE_ORIGINALS.get(key(row),{onlyIf:{etagMatches:row.provider_etag}});
    if(!matches(object,row)||typeof object.body?.getReader!=='function')throw new Error('Source unavailable');
    const bytes=await readBoundedBytes({getReader:()=>object.body.getReader()},row.byte_count);
    if(bytes.byteLength!==row.byte_count||await sha256Hex(bytes)!==row.sha256||
        policy.detectAllowedFileType(bytes)!==(row.original_format==='jpg'?'jpeg':'png'))throw new Error('Source mismatch');
    return bytes;
}

// One durable multipart writer, bounded bytes and exact readback. A "saved"
// receipt also proves that writer is closed, before the normal tagged archive
// can adopt the SAME object key. No second original, copy or public URL exists.
export async function storeFamilySavedFile(env,identity,site,draftId,photoId,bytes) {
    try {
        let row=await uploadContext(env,identity,site,draftId,photoId);
        if(row.provider_version)return saved(row);
        if(!(bytes instanceof Uint8Array)||bytes.byteLength!==row.byte_count||await sha256Hex(bytes)!==row.sha256||
            policy.detectAllowedFileType(bytes)!==(row.original_format==='jpg'?'jpeg':'png'))return fail(422);
        row=await uploadContext(env,identity,site,draftId,photoId);
        if(!row.provider_upload_id) {
            const created=await env.PRIVATE_ORIGINALS.createMultipartUpload(key(row),{
                httpMetadata:{contentType:'application/octet-stream',cacheControl:'no-store'}});
            if(created?.key!==key(row)||!safe(created.uploadId))throw new Error('Writer unavailable');
            try {await write(env,`UPDATE family_gallery_saved_files SET provider_upload_id=?1
                WHERE photo_id=?2 AND provider_upload_id IS NULL`,created.uploadId,photoId);}
            catch { /* Never send bytes through an unregistered writer. */ }
            try {row=await uploadContext(env,identity,site,draftId,photoId);}
            catch(error){await created.abort();throw error;}
            if(row.provider_upload_id!==created.uploadId)await created.abort();
        }
        if(!row.provider_upload_id)throw new Error('Writer unavailable');
        const upload=env.PRIVATE_ORIGINALS.resumeMultipartUpload(key(row),row.provider_upload_id);
        let object=await env.PRIVATE_ORIGINALS.head(key(row));
        if(!object) {
            const part=await upload.uploadPart(1,bytes);
            if(part?.partNumber!==1||!safe(part.etag))throw new Error('Part unavailable');
            row=await uploadContext(env,identity,site,draftId,photoId);
            try {object=await upload.complete([part]);}
            catch {object=await env.PRIVATE_ORIGINALS.head(key(row));}
        }
        if(!matches(object,row))throw new Error('Object unavailable');
        const checked={...row,provider_version:object.version,provider_etag:object.etag};
        await checkedBytes(env,checked);
        let closure='abort-confirmed';
        try {await upload.abort();}
        catch(error){if(![error?.name,error?.code,error?.message].includes('NoSuchUpload'))throw error;closure='no-such-upload';}
        row=await uploadContext(env,identity,site,draftId,photoId);
        if(!matches(await env.PRIVATE_ORIGINALS.head(key(row)),checked))throw new Error('Readback changed');
        try {await write(env,`UPDATE family_gallery_saved_files SET provider_version=?1,provider_etag=?2,writer_closed=?3
            WHERE photo_id=?4 AND provider_version IS NULL`,object.version,object.etag,closure,photoId);}
        catch { /* Exact immutable readback is required after an uncertain write. */ }
        row=await uploadContext(env,identity,site,draftId,photoId);
        if(row.provider_version!==object.version||row.provider_etag!==object.etag||!row.writer_closed)throw new Error('Receipt unavailable');
        return saved(row);
    }catch{return fail();}
}

// The router requires owner authentication, the Family session and same-origin
// CSRF even for this read. Never expose a bucket key, original URL or filename.
export async function readFamilySavedFile(env,identity,site,draftId,photoId) {
    try {
        const row=await context(env,identity,site,draftId,photoId);
        const current=await first(env,'SELECT * FROM family_gallery_current_permission WHERE owner_hash=?1',row.owner);
        if(!row.provider_version||!row.writer_closed||current?.active!==1)return fail();
        const bytes=await checkedBytes(env,row);
        const after=await context(env,identity,site,draftId,photoId);
        await requireFamilyPermission(env,after.owner,site,current.version,false);
        return {ok:true,status:200,bytes};
    }catch{return fail();}
}

export async function familySavedFileByteLimit(env,identity,site,draftId,photoId) {
    try {return {ok:true,status:200,byteCount:(await uploadContext(env,identity,site,draftId,photoId)).byte_count};}
    catch {return fail();}
}

// An owner may cancel a pre-tag original without inventing people/age tags just
// to delete it. Once adopted, only the existing archive deletion/removal path
// applies. Metadata remains as history; this is not purge or public-host proof.
export async function deleteFamilySavedFile(env,identity,site,draftId,photoId) {
    try {
        const read=()=>context(env,identity,site,draftId,photoId,{writing:true,deleting:true});
        let row=await read();
        if(!row.asset_id||await first(env,'SELECT 1 FROM private_gallery_assets WHERE asset_id=?1',row.asset_id))return fail();
        if(row.original_absent)return {ok:true,status:200,state:'private-file-deleted',publicationEnabled:false};
        if(!row.delete_requested){
            try {await write(env,'UPDATE family_gallery_saved_files SET delete_requested=1 WHERE photo_id=?1',photoId);}
            catch { /* The durable deletion fence, not a response, authorizes cleanup. */ }
            row=await read();if(!row.delete_requested)throw new Error('Deletion not recorded');
        }
        if(row.provider_upload_id&&!row.deletion_closure) {
            let proof='abort-confirmed';
            try {await env.PRIVATE_ORIGINALS.resumeMultipartUpload(key(row),row.provider_upload_id).abort();}
            catch(error){if(![error?.name,error?.code,error?.message].includes('NoSuchUpload'))throw error;proof='no-such-upload';}
            try {await write(env,'UPDATE family_gallery_saved_files SET deletion_closure=?1 WHERE photo_id=?2 AND deletion_closure IS NULL',proof,photoId);}
            catch { /* Continue only with exact closure readback. */ }
            row=await read();if(!row.deletion_closure)throw new Error('Writer closure not recorded');
        }
        if(await env.PRIVATE_ORIGINALS.head(key(row)))await env.PRIVATE_ORIGINALS.delete(key(row));
        if(await env.PRIVATE_ORIGINALS.head(key(row))!==null)throw new Error('Absence not verified');
        try {await write(env,'UPDATE family_gallery_saved_files SET original_absent=1 WHERE photo_id=?1',photoId);}
        catch { /* A lost reply does not erase the terminal receipt. */ }
        row=await read();return row.original_absent?{ok:true,status:200,state:'private-file-deleted',publicationEnabled:false}:fail();
    }catch{return fail();}
}
