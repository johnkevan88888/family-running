import assert from 'node:assert/strict';
import sharp from 'sharp';
import {archiveServiceFixture} from './private-gallery-service-fixture.mjs';
import {digest} from './private-gallery-lifecycle-fixtures.mjs';
import {familyPermission,createFamilyDraft,saveFamilyDraft,prepareFamilyPhoto,submitFamilyDraft} from '../../gallery-admin/src/family-uploader-service.js';
import {storePrivateArchiveOriginal} from '../../gallery-admin/src/private-archive-service.js';
import {savePrivateGalleryFraming} from '../../gallery-admin/src/private-gallery-framing-service.js';
import {readBoundedBytes,sha256Hex} from '../../gallery-admin/src/media-byte-verification.js';

export function transactionalDB(f) {
    f.env.DB.batch=async statements=>{f.db.exec('BEGIN');try{const results=[];
        for(const statement of statements)results.push(await statement.run());f.db.exec('COMMIT');return results;
    }catch(error){f.db.exec('ROLLBACK');throw error;}};
}
export async function familyUploaderFixture({ready=false,submitted=false,count=3}={}) {
    const f=await archiveServiceFixture('family',{reserveAttempt:false,mediaOrigin:'https://family-running-gallery-media-dev.family-running.workers.dev'});
    transactionalDB(f);
    f.catalog.sites.family.rosterEntries=[{athleteId:'fixture-public',participant:'Fictional family runner'},
        {athleteId:'fixture-new',participant:'Fictional new runner'}];
    f.catalog.sites.family.catalog.athleteIds.push('fixture-new');
    f.permissionInput={expectedVersion:0,idempotencyKey:crypto.randomUUID(),active:true,guardians:false};
    f.permission=await familyPermission(f.env,f.owner,f.site,f.permissionInput);assert.equal(f.permission.ok,true);
    f.draft=(await createFamilyDraft(f.env,f.owner,f.site,{idempotencyKey:crypto.randomUUID()})).draft;
    f.bytes=await Promise.all(Array.from({length:count},(_,index)=>sharp({create:{width:512,height:768,channels:3,
        background:['#1234ab','#ab1234','#34ab12'][index%3]}}).withExif({IFD0:{Make:'synthetic-private-camera-'+index}}).jpeg().toBuffer()));
    f.photos=f.bytes.map(bytes=>({photoId:crypto.randomUUID(),originalFormat:'jpg',byteCount:bytes.length,sha256:digest(bytes),
        personIds:[f.ids[0]],raceIndex:0,containsMinors:false}));
    f.saveInput={expectedVersion:0,idempotencyKey:crypto.randomUUID(),photos:f.photos};
    const saved=await saveFamilyDraft(f.env,f.owner,f.site,f.draft.id,f.saveInput,f.catalog);assert.equal(saved.ok,true,JSON.stringify(saved));f.draft=saved.draft;
    f.prepare=async index=>{
        const result=await prepareFamilyPhoto(f.env,f.owner,f.site,f.draft.id,{photoId:f.photos[index].photoId,permissionVersion:1},f.catalog);
        assert.equal(result.ok,true,JSON.stringify(result));f.draft=result.draft;return f.draft.photos[index];
    };
    f.retain=async index=>{
        const photo=await f.prepare(index),bytes=f.bytes[index];
        const result=await storePrivateArchiveOriginal(f.env,f.owner,f.site,photo.assetId,new Blob([bytes]).stream(),{
            digestReadable:async body=>sha256Hex(await readBoundedBytes(body,bytes.length))});assert.equal(result.ok,true,JSON.stringify(result));
        return photo;
    };
    f.frame=async index=>{
        const photo=await f.retain(index),result=await savePrivateGalleryFraming(f.env,f.owner,f.site,photo.assetId,{
            idempotencyKey:crypto.randomUUID(),expectedVersion:0,tagVersion:1,confirmed:true,sourceSha256:photo.sha256,
            orientation:'exif-transposed-v1',imageWidth:512,imageHeight:768,frames:{[f.ids[0]]:{x:45,y:25,zoom:2}}});
        assert.equal(result.ok,true,JSON.stringify(result));return photo;
    };
    f.submitInput={expectedVersion:1,permissionVersion:1,completeTagsConfirmed:true};
    f.submit=async(dependencies={})=>{const result=await submitFamilyDraft(f.env,f.owner,f.site,f.draft.id,f.submitInput,f.catalog,dependencies);
        if(result.ok){f.draft=result.draft;f.jobId=result.draft.jobId;}return result;};
    if(ready||submitted)for(let i=0;i<count;i++)await f.frame(i);
    if(submitted)assert.equal((await f.submit()).ok,true);
    return f;
}
