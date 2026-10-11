import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir} from 'node:fs/promises';
import sharp from 'sharp';
import {syntheticBucket,digest} from './private-gallery-lifecycle-fixtures.mjs';
import {reservePrivateGalleryAsset} from '../../gallery-admin/src/private-gallery-asset-service.js';
import {readPrivateGalleryRoster} from '../../gallery-admin/src/private-gallery-roster-service.js';
import {reservePrivateGalleryAttempt} from '../../gallery-admin/src/private-gallery-attempt-service.js';
import {changePrivateGalleryVisibility,readPrivateGalleryAssetEligibility} from '../../gallery-admin/src/private-gallery-visibility-service.js';
import {preparePrivateArchiveIntake,storePrivateArchiveOriginal} from '../../gallery-admin/src/private-archive-service.js';
import {readBoundedBytes,sha256Hex} from '../../gallery-admin/src/media-byte-verification.js';
import * as delivery from '../../gallery-admin/src/media-delivery-contract.js';
import {handleMediaRequest} from '../../gallery-admin/src/media-worker.js';

export async function archiveServiceFixture(site='family',{reserveAttempt=true,migrationThrough=Infinity}={}) {
    const db=new DatabaseSync(':memory:'),directory=new URL('../../gallery-admin/migrations/',import.meta.url);
    for(const name of (await readdir(directory)).filter(n=>n.endsWith('.sql') && Number(n.slice(0,4))<=migrationThrough).sort()) db.exec(await readFile(new URL(name,directory),'utf8'));
    const original=syntheticBucket(),staging=syntheticBucket(),approved=syntheticBucket();
    const owner={type:'browser',subject:'fictional-archive-service-owner'};
    const env={PRIVATE_ORIGINALS:original,PRIVATE_DERIVATIVE_STAGING:staging,APPROVED_MEDIA:approved,
        APPROVED_MEDIA_ORIGIN:'https://synthetic-archive-media.example',EXPECTED_MEDIA_VERSION:'12345678-1234-5678-9abc-1234567890ab',
        DB:{prepare(sql){let args=[];return {bind(...values){args=values;return this;},
            async first(){return db.prepare(sql).get(...args)??null;},async all(){return {success:true,results:db.prepare(sql).all(...args)};},
            async run(){const result=db.prepare(sql).run(...args);return {success:true,meta:{changes:Number(result.changes)}};}};}}};
    const ids=[1,2].map(n=>`person_00000000-0000-4000-8000-00000000000${n}`);
    for(const [index,id] of ids.entries()) {
        db.prepare('INSERT INTO private_gallery_people VALUES(?,?,?,?,?)').run(id,`Fictitious tagged person ${index}`,index===0?'fixture-public':null,1,1);
        assert.equal((await changePrivateGalleryVisibility(env,owner,site,id,{expectedVersion:1,idempotencyKey:crypto.randomUUID(),preference:'allowed'})).ok,true);
    }
    const catalog={schemaVersion:'1.0',exportBundleId:'synthetic-archive-service-bundle',sourceRevision:`sha256:${'a'.repeat(64)}`,
        suppressionRevision:`sha256:${'b'.repeat(64)}`,suppressionDocument:{schemaVersion:'1.0',hiddenAthleteIds:[]},sites:{}};
    for(const area of ['family','everyone']) catalog.sites[area]={catalog:{exportBundleId:catalog.exportBundleId,sourceRevision:catalog.sourceRevision,
        races:[{raceDate:'2026-01-01',raceEvent:'Fictitious race',raceDistance:'5 km'}],athleteIds:['fixture-public']}};
    const roster=(await readPrivateGalleryRoster(env,site)).revision;
    const asset=await reservePrivateGalleryAsset(env,owner,site,{idempotencyKey:crypto.randomUUID(),rosterRevision:roster,personIds:ids,originalFormat:'jpg'});
    assert.equal(asset.ok,true);const assetId=asset.asset.assetId;
    const photo=await sharp({create:{width:32,height:48,channels:3,background:'#7ab341'}}).withExif({IFD0:{Make:'private-camera'}}).jpeg().toBuffer();
    assert.equal((await preparePrivateArchiveIntake(env,owner,site,assetId,{rosterRevision:roster,byteCount:photo.length,sha256:digest(photo),
        declaredMimeType:'image/jpeg',privateRetentionConfirmed:true,containsMinors:false,guardianApprovalConfirmed:false})).ok,true);
    assert.equal((await storePrivateArchiveOriginal(env,owner,site,assetId,new Blob([photo]).stream(),{
        digestReadable:async body=>sha256Hex(await readBoundedBytes(body,photo.length))})).ok,true);
    const eligibility=await readPrivateGalleryAssetEligibility(env,owner,site,assetId,catalog);
    const consent={idempotencyKey:crypto.randomUUID(),tagVersion:1,eligibilityRevision:eligibility.revision,sourceRevision:catalog.sourceRevision,
        suppressionRevision:catalog.suppressionRevision,raceIndex:0,completeTagsConfirmed:true,publicUseConfirmed:true,containsMinors:false,guardianApprovalConfirmed:false};
    const attempt=reserveAttempt?await reservePrivateGalleryAttempt(env,owner,site,assetId,consent,catalog):null;
    if(reserveAttempt) assert.equal(attempt.ok,true);
    const epoch=digest('fixture-epoch'),activation=digest('fixture-activation'),registered='2026-01-01T00:00:00.000Z',activated='2026-01-01T00:00:01.000Z';
    db.prepare('INSERT INTO gallery_media_delivery_epochs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('synthetic-service-epoch',epoch,1,env.APPROVED_MEDIA_ORIGIN,
        digest(`approved-media-origin:${env.APPROVED_MEDIA_ORIGIN}`),digest(`approved-media-contract:${delivery.MEDIA_DELIVERY_CONTRACT_VALUE}`),
        digest(`approved-media-version:${env.EXPECTED_MEDIA_VERSION}`),digest(`approved-object-key:${delivery.MEDIA_BINDING_WITNESS_KEY}`),
        delivery.MEDIA_BINDING_WITNESS_SHA256,28,'image/webp',digest('fixture-config'),digest('fixture-actor'),registered);
    db.prepare('INSERT INTO gallery_media_delivery_epoch_activations VALUES(?,?,?,?,?,?,?,?)').run(activation,epoch,1,null,
        digest('fixture-activation-key'),digest('fixture-activation-payload'),digest('fixture-actor'),activated);
    db.prepare('INSERT INTO gallery_media_delivery_current_epoch VALUES(1,?,?,?,?)').run(epoch,1,activation,activated);
    const witness=await sharp(Buffer.from([0,0,0,0]),{raw:{width:1,height:1,channels:4}}).webp({lossless:true,quality:100,effort:6,alphaQuality:100,smartSubsample:false}).toBuffer();
    assert.equal(digest(witness),delivery.MEDIA_BINDING_WITNESS_SHA256);
    approved.objects.set(delivery.MEDIA_BINDING_WITNESS_KEY,{key:delivery.MEDIA_BINDING_WITNESS_KEY,bytes:witness,size:28,version:'fixture-witness',etag:'fixture-witness',httpMetadata:{contentType:'image/webp',cacheControl:'no-store'}});
    const hostRequests=[];
    const publicFetch=async request=>{
        assert.equal(new URL(request.url).origin,env.APPROVED_MEDIA_ORIGIN);hostRequests.push(request.url);
        const response=await handleMediaRequest(request,{APPROVED_MEDIA:approved,MEDIA_VERSION:{id:env.EXPECTED_MEDIA_VERSION}});
        Object.defineProperty(response,'url',{value:request.url});return response;
    };
    return {db,env,original,staging,approved,owner,site,assetId,attemptId:attempt?.attemptId,catalog,consent,photo,ids,epoch,hostRequests,publicFetch};
}
