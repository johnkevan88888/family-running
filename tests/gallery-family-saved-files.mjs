import assert from 'node:assert/strict';
import {familyUploaderFixture} from './helpers/family-uploader-fixture.mjs';
import {prepareFamilySavedFile,storeFamilySavedFile,readFamilySavedFile,deleteFamilySavedFile} from '../gallery-admin/src/family-saved-file-service.js';
import {saveFamilyDraft,readFamilyDrafts,prepareFamilyPhoto,familyPermission,submitFamilyDraft} from '../gallery-admin/src/family-uploader-service.js';
import {deletePrivateArchiveOriginal} from '../gallery-admin/src/private-archive-service.js';
import {readBoundedBytes,sha256Hex} from '../gallery-admin/src/media-byte-verification.js';
import {savePrivateGalleryFraming} from '../gallery-admin/src/private-gallery-framing-service.js';

const deps={digestReadable:async body=>sha256Hex(await readBoundedBytes(body,26214400))};
const outsider={type:'browser',subject:'unrelated-owner'};
let checks=0;
async function setup() {
    const f=await familyUploaderFixture({count:2});
    f.blank=f.photos.map(p=>({...p,personIds:[],raceIndex:null,containsMinors:null}));
    const result=await saveFamilyDraft(f.env,f.owner,f.site,f.draft.id,
        {expectedVersion:1,idempotencyKey:crypto.randomUUID(),photos:f.blank},f.catalog);
    assert.equal(result.ok,true);f.draft=result.draft;
    f.capture=async index=>{
        const id=f.photos[index].photoId;
        assert.equal((await prepareFamilySavedFile(f.env,f.owner,f.site,f.draft.id,id,{permissionVersion:1})).ok,true);
        const saved=await storeFamilySavedFile(f.env,f.owner,f.site,f.draft.id,id,f.bytes[index]);
        assert.equal(saved.ok,true,JSON.stringify(saved));assert.equal(saved.savedPrivately,true);return id;
    };
    return f;
}
{
    const f=await setup();try {
        const before=f.original.objects.size,id=await f.capture(0),row=f.db.prepare('SELECT * FROM family_gallery_saved_files WHERE photo_id=?').get(id);
        assert.equal(f.original.objects.size,before+1);
        assert.equal(f.db.prepare('SELECT count(*) n FROM private_archive_intakes WHERE asset_id=?').get(row.asset_id).n,0);
        assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_assets WHERE asset_id=?').get(row.asset_id).n,0);
        assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_attempts').get().n,0);
        assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_batch_jobs').get().n,0);
        assert.ok(row.writer_closed);
        assert.equal(f.original.uploads.get(row.provider_upload_id).state,'complete');
        assert.deepEqual((await readFamilySavedFile(f.env,f.owner,f.site,f.draft.id,id)).bytes,new Uint8Array(f.bytes[0]));
        assert.equal((await readFamilySavedFile(f.env,outsider,f.site,f.draft.id,id)).ok,false);
        assert.equal((await readFamilySavedFile(f.env,f.owner,'everyone',f.draft.id,id)).ok,false);
        assert.equal((await prepareFamilyPhoto(f.env,f.owner,f.site,f.draft.id,{photoId:id,permissionVersion:1},f.catalog,deps)).ok,false,'Untagged bytes cannot become a review source');
        assert.equal((await submitFamilyDraft(f.env,f.owner,f.site,f.draft.id,{expectedVersion:2,permissionVersion:1,completeTagsConfirmed:true},f.catalog)).ok,false);
        const calls=f.original.calls.length;
        assert.equal((await storeFamilySavedFile(f.env,f.owner,f.site,f.draft.id,id,f.bytes[0])).savedPrivately,true);
        assert.equal(f.original.calls.length,calls,'A saved-file retry does not re-upload');
        const bad=f.blank.map((p,i)=>i?p:{...p,sha256:'a'.repeat(64)});
        assert.equal((await saveFamilyDraft(f.env,f.owner,f.site,f.draft.id,{expectedVersion:2,idempotencyKey:crypto.randomUUID(),photos:bad},f.catalog)).ok,false);
        assert.equal((await readFamilyDrafts(f.env,f.owner,f.site,f.draft.id)).draft.version,2);
        assert.throws(()=>f.db.prepare('DELETE FROM family_gallery_saved_files WHERE photo_id=?').run(id));
        const changed=await saveFamilyDraft(f.env,f.owner,f.site,f.draft.id,{expectedVersion:2,idempotencyKey:crypto.randomUUID(),photos:f.photos},f.catalog);
        assert.equal(changed.ok,true,'Tagging after storage is allowed');
        const retained=await prepareFamilyPhoto(f.env,f.owner,f.site,f.draft.id,{photoId:id,permissionVersion:1},f.catalog,deps);
        assert.equal(retained.ok,true,JSON.stringify(retained));assert.equal(retained.draft.photos[0].retained,true);
        assert.equal(retained.draft.photos[0].assetId,row.asset_id,'Adopt the same key, not another original');
        assert.equal((await deleteFamilySavedFile(f.env,f.owner,f.site,f.draft.id,id)).ok,false,'Pre-tag cancellation must not bypass normal archive removal');
        assert.equal(f.original.objects.size,before+1);
        assert.equal(f.original.calls.filter(([call])=>call==='part').length,2,'One fixture upload plus one new original, with no adoption re-upload');
        const receipt=f.db.prepare('SELECT * FROM private_archive_original_receipts WHERE asset_id=?').get(row.asset_id);
        assert.equal(receipt.provider_version,row.provider_version);assert.equal(receipt.provider_etag,row.provider_etag);
        assert.equal((await deletePrivateArchiveOriginal(f.env,f.owner,f.site,row.asset_id,'owner-delete')).ok,true);
        assert.equal((await readFamilySavedFile(f.env,f.owner,f.site,f.draft.id,id)).ok,false,'Terminal deletion denies private previews too');
        assert.equal(f.original.objects.has(`private-archive/v1/family/${row.asset_id}/original.jpg`),false);
        await assert.rejects(f.original.resumeMultipartUpload(`private-archive/v1/family/${row.asset_id}/original.jpg`,row.provider_upload_id).complete([]),/NoSuchUpload/);
        assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);checks+=29;
    }finally{f.db.close();}
}
{
    const f=await setup();try {
        const id=f.photos[0].photoId;
        assert.equal((await prepareFamilySavedFile(f.env,f.owner,f.site,f.draft.id,id,{permissionVersion:2})).ok,false);
        assert.equal((await prepareFamilySavedFile(f.env,f.owner,f.site,f.draft.id,id,{permissionVersion:1,assetId:'injected'})).ok,false);
        assert.equal((await prepareFamilySavedFile(f.env,outsider,f.site,f.draft.id,id,{permissionVersion:1})).ok,false);
        assert.equal((await prepareFamilySavedFile(f.env,f.owner,f.site,f.draft.id,id,{permissionVersion:1})).ok,true);
        assert.equal((await storeFamilySavedFile(f.env,f.owner,f.site,f.draft.id,id,new Uint8Array([1,2]))).ok,false);
        const before=f.original.objects.size;
        f.original.hook=async event=>{if(event==='part'){f.original.hook=null;
            assert.equal((await familyPermission(f.env,f.owner,f.site,{expectedVersion:1,idempotencyKey:crypto.randomUUID(),active:false,guardians:false})).ok,true);}};
        assert.equal((await storeFamilySavedFile(f.env,f.owner,f.site,f.draft.id,id,f.bytes[0])).ok,false);
        assert.equal(f.original.objects.size,before,'Late permission withdrawal blocks completion');
        assert.equal((await readFamilyDrafts(f.env,f.owner,f.site,f.draft.id)).draft.photos[0].savedPrivately,false);
        assert.equal((await deleteFamilySavedFile(f.env,outsider,f.site,f.draft.id,id)).ok,false);
        assert.equal((await deleteFamilySavedFile(f.env,f.owner,f.site,f.draft.id,id)).state,'private-file-deleted','Even after permission revocation, the owner can delete an interrupted untagged original');
        assert.equal((await deleteFamilySavedFile(f.env,f.owner,f.site,f.draft.id,id)).state,'private-file-deleted');
        assert.equal(f.db.prepare('SELECT original_absent FROM family_gallery_saved_files WHERE photo_id=?').get(id).original_absent,1);
        assert.equal((await storeFamilySavedFile(f.env,f.owner,f.site,f.draft.id,id,f.bytes[0])).ok,false);
        checks+=6;
        checks+=8;
    }finally{f.db.close();}
}
{
    const f=await setup();try {
        f.original.hook=async event=>{if(event==='complete'){f.original.hook=null;throw new Error('Synthetic lost completion acknowledgement');}};
        const id=await f.capture(0),row=f.db.prepare('SELECT * FROM family_gallery_saved_files WHERE photo_id=?').get(id);
        assert.equal(f.original.calls.filter(([call])=>call==='complete').length,2,'Lost completion is read back, not repeated');
        const object=f.original.objects.get(`private-archive/v1/family/${row.asset_id}/original.jpg`);
        object.bytes=Buffer.from(object.bytes);object.bytes[20]^=1;
        assert.equal((await readFamilySavedFile(f.env,f.owner,f.site,f.draft.id,id)).ok,false,'Changed bytes fail closed even at the same provider identity');
        checks+=2;
    }finally{f.db.close();}
}
{
    const f=await setup();try {
        const id=await f.capture(0),before=f.original.objects.size;
        assert.equal((await deleteFamilySavedFile(f.env,f.owner,f.site,f.draft.id,id)).ok,true);
        assert.equal(f.original.objects.size,before-1);
        assert.equal((await readFamilySavedFile(f.env,f.owner,f.site,f.draft.id,id)).ok,false);
        assert.equal((await prepareFamilySavedFile(f.env,f.owner,f.site,f.draft.id,id,{permissionVersion:1})).ok,false);
        assert.equal((await readFamilyDrafts(f.env,f.owner,f.site,f.draft.id)).draft.photos[0].fileDeleted,true);
        assert.equal(f.db.prepare('SELECT count(*) n FROM family_gallery_saved_files').get().n,1,'Private history is not purged by original deletion');
        checks+=6;
    }finally{f.db.close();}
}
{
    // Match the reported recovery: first photo already checked, second saved
    // privately but not adopted, then an explicit guardian-scope amendment.
    const f=await setup();try {
        await f.capture(0);const second=await f.capture(1);
        const photos=f.photos.map((photo,index)=>({...photo,containsMinors:index===1}));
        assert.equal((await saveFamilyDraft(f.env,f.owner,f.site,f.draft.id,
            {expectedVersion:2,idempotencyKey:crypto.randomUUID(),photos},f.catalog)).ok,true);
        const adult=await f.frame(0);
        const tables=['family_gallery_drafts','family_gallery_draft_photos','family_gallery_saved_files',
            'private_gallery_assets','private_gallery_asset_tags','private_archive_intakes','private_archive_original_receipts',
            'private_gallery_frame_revisions','private_gallery_attempts','private_gallery_batch_jobs'];
        const snapshot=()=>Object.fromEntries(tables.map(table=>[table,f.db.prepare(`SELECT * FROM ${table}`).all()]));
        const before=snapshot(),objects=structuredClone([...f.original.objects]),calls=f.original.calls.length;
        assert.equal((await prepareFamilyPhoto(f.env,f.owner,f.site,f.draft.id,{photoId:second,permissionVersion:1},f.catalog,deps)).code,
            'family-guardian-permission-needed');
        assert.deepEqual(snapshot(),before,'Missing permission reserves nothing and keeps every saved field');
        assert.equal(f.original.calls.length,calls,'Missing guardian scope does not fetch or write pixels');
        const grant={expectedVersion:1,idempotencyKey:crypto.randomUUID(),active:true,guardians:true};
        const amended=await familyPermission(f.env,f.owner,f.site,grant);
        assert.equal(amended.version,2);assert.equal(amended.guardians,true);
        assert.deepEqual(await familyPermission(f.env,f.owner,f.site,grant),amended,'Lost-reply retry reuses exactly one grant');
        assert.equal((await familyPermission(f.env,f.owner,f.site,{...grant,guardians:false})).code,'family-permission-changed');
        assert.deepEqual(f.db.prepare('SELECT version,guardians FROM family_gallery_permissions ORDER BY version').all().map(row=>({...row})),
            [{version:1,guardians:0},{version:2,guardians:1}],'The earlier grant remains unchanged');
        assert.deepEqual(snapshot(),before,'Confirmation alone never rewrites photos, tags, framing, intake or review history');
        assert.deepEqual(structuredClone([...f.original.objects]),objects);
        assert.equal(f.original.calls.length,calls,'Confirmation does not access originals');
        await assert.rejects(prepareFamilyPhoto(f.env,f.owner,f.site,f.draft.id,{photoId:second,permissionVersion:1},f.catalog,deps),
            /Standing permission changed/,'Stale policy still fails closed');
        assert.equal((await prepareFamilyPhoto(f.env,f.owner,f.site,f.draft.id,{photoId:adult.photoId,permissionVersion:2},f.catalog,deps)).ok,true);
        const prepared=await prepareFamilyPhoto(f.env,f.owner,f.site,f.draft.id,{photoId:second,permissionVersion:2},f.catalog,deps);
        assert.equal(prepared.ok,true,JSON.stringify(prepared));const child=prepared.draft.photos[1];
        assert.equal(child.retained,true);
        assert.equal(child.assetId,before.family_gallery_saved_files.find(row=>row.photo_id===second).asset_id);
        const saved=await savePrivateGalleryFraming(f.env,f.owner,f.site,child.assetId,{
            idempotencyKey:crypto.randomUUID(),expectedVersion:0,tagVersion:1,confirmed:true,sourceSha256:child.sha256,
            orientation:'exif-transposed-v1',imageWidth:512,imageHeight:768,frames:{[f.ids[0]]:{x:51,y:22,zoom:1.5}}});
        assert.equal(saved.ok,true);
        assert.deepEqual(f.db.prepare('SELECT * FROM private_gallery_frame_revisions WHERE asset_id=?').all(adult.assetId),
            before.private_gallery_frame_revisions.filter(row=>row.asset_id===adult.assetId));
        assert.deepEqual(f.db.prepare('SELECT * FROM family_gallery_saved_files').all(),before.family_gallery_saved_files);
        assert.deepEqual(structuredClone([...f.original.objects]),objects,'Adoption preserves exact original bytes and provider identities');
        assert.equal(f.original.calls.filter(([call])=>call==='part').length,3,'One fixture original plus two saved photos, never re-uploaded');
        assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_attempts').get().n,0,'Framing and confirmation do not submit review');
        // This is an explicit local synthetic call, not an automatic UI action.
        const submitted=await submitFamilyDraft(f.env,f.owner,f.site,f.draft.id,
            {expectedVersion:3,permissionVersion:2,completeTagsConfirmed:true},f.catalog);
        assert.equal(submitted.ok,true,JSON.stringify(submitted));
        assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_current_attempt_permissions').get().n,2);
        assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_attempts WHERE standing_permission_version=2 AND framing_version=1').get().n,2);
        assert.equal(f.db.prepare('SELECT standing_permission_version FROM private_archive_intakes WHERE asset_id=?').get(adult.assetId).standing_permission_version,1,
            'Fresh review uses current permission while the original intake keeps its historical grant');
        assert.equal(f.db.prepare('SELECT count(*) n FROM private_gallery_batch_reviews').get().n,0);
        assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);checks+=28;
    }finally{f.db.close();}
}
console.log(`PASS ${checks} save-first checks: untagged private capture, exact replay, same-object adoption, guardian amendment preserving checked siblings, current permission, immutable pixels, private read isolation and terminal original deletion. Synthetic only.`);
