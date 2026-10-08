import assert from 'node:assert/strict';
import {buildV2PhotoDerivativeKey,createPhotoGenerationId,parseV2PhotoDerivativeKey} from '../gallery-admin/src/photo-generation-keys.js';
import {buildV1ApprovedDerivativeKey,parseV1ApprovedDerivativeKey} from '../gallery-admin/src/storage-keys.js';
import {handleMediaRequest} from '../gallery-admin/src/media-worker.js';
import {MEDIA_BINDING_WITNESS_KEY,MEDIA_BINDING_WITNESS_SIZE} from '../gallery-admin/src/media-delivery-contract.js';

const hash='a'.repeat(64), first=createPhotoGenerationId(), second=createPhotoGenerationId();
assert.notEqual(first,second);
const oldKey=buildV1ApprovedDerivativeKey({sha256:hash,role:'photo-display'});
assert.equal(oldKey,`media/v1/${hash}/display.webp`);
assert.equal(parseV2PhotoDerivativeKey(oldKey),null);
const key=buildV2PhotoDerivativeKey({generationId:first,sha256:hash,role:'photo-display'});
assert.notEqual(key,buildV2PhotoDerivativeKey({generationId:second,sha256:hash,role:'photo-display'}),
    'Identical metadata-stripped photo bytes receive different generation URLs');
assert.equal(parseV1ApprovedDerivativeKey(key),null,'Do not reinterpret old v1 contracts');
assert.deepEqual(parseV2PhotoDerivativeKey(key),{generationId:first,sha256:hash,role:'photo-display',filename:'display.webp',contentType:'image/webp'});
for(const role of ['video','video-poster','original','__proto__']) assert.throws(()=>buildV2PhotoDerivativeKey({generationId:first,sha256:hash,role}));
for(const generationId of ['person_'+first,'asset_'+first,'draft_'+first,first.toUpperCase(),'../'+first,'not-secure']) {
    assert.throws(()=>buildV2PhotoDerivativeKey({generationId,sha256:hash,role:'photo-display'}));
}
for(const malformed of [key+'/extra',key+'?download=1',key.replace('display.webp','video.mp4'),
    key.replace('/v2/','/v3/'),key.replace(hash,hash.toUpperCase()),key.replace(first,first.toUpperCase())]) assert.equal(parseV2PhotoDerivativeKey(malformed),null);
let reads=0;
const objects=new Map([[key,{body:new Uint8Array([1,2,3]),size:3,etag:'syntheticetag',httpEtag:'"syntheticetag"'}],
    [oldKey,{body:new Uint8Array([4,5,6]),size:3}]]);
assert.equal((await handleMediaRequest(new Request('https://synthetic.example/'+key),{})).status,503);
const env={MEDIA_VERSION:{id:'12345678-1234-5678-9abc-1234567890ab'},APPROVED_MEDIA:{
    async get(objectKey,options){reads++;const object=objects.get(objectKey);if(!object)return null;
        if(options?.onlyIf?.etagMatches !== undefined && options.onlyIf.etagMatches !== object.etag)return {...object,body:undefined};
        return options?.range ? {...object,body:object.body.slice(options.range.offset,options.range.offset+options.range.length),range:options.range} : object;},
    async head(objectKey){reads++;return objects.get(objectKey) ?? null;}
}};
const request=(objectKey,options={})=>handleMediaRequest(new Request('https://synthetic.example/'+objectKey,options),env);
for(const objectKey of [oldKey,key]) {
    const response=await request(objectKey);
    assert.equal(response.status,200);
    assert.equal(response.headers.get('Content-Type'),'image/webp');
    assert.equal(response.headers.get('X-Family-Running-Media-Contract'),'approved-media-v1');
    assert.equal(response.headers.get('Cache-Control'),'public, max-age=60, must-revalidate');
    assert.equal((await response.arrayBuffer()).byteLength,3);
    assert.equal((await request(objectKey,{method:'HEAD'})).status,200);
    assert.equal((await request(objectKey,{method:'POST'})).status,405);
}
const range=await request(key,{headers:{Range:'bytes=1-2'}});
assert.equal(range.status,206);
assert.equal(range.headers.get('Content-Range'),'bytes 1-2/3');
assert.deepEqual([...new Uint8Array(await range.arrayBuffer())],[2,3]);
assert.equal((await request(key,{headers:{Range:'bytes=100-'}})).status,416);
const before=reads;
for(const malformed of [key+'/extra',key+'?download=1',key.replace('display.webp','video.mp4'),
    key.replace('/v2/','/v3/'),key.replace(hash,hash.toUpperCase()),key.replace(first,first.toUpperCase())]) {
    assert.equal((await request(malformed)).status,404);
}
assert.equal(reads,before,'Malformed generation requests cannot read storage');
objects.delete(key);
assert.equal((await request(key)).status,404,'Removing one generation does not resurrect it');
assert.equal((await request(oldKey)).status,200,'Unrelated v1 pilot is unchanged');
assert.equal(MEDIA_BINDING_WITNESS_KEY.startsWith('media/v1/'),true);
assert.ok(MEDIA_BINDING_WITNESS_SIZE > 0);
console.log('Additive opaque photo-generation keys, unchanged v1 delivery, photo-only restrictions, exact range reads and fail-closed denial passed.');
