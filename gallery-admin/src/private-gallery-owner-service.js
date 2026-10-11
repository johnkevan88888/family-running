import { readPrivateGalleryAsset } from './private-gallery-asset-service.js';
import { preparePrivateArchiveIntake,storePrivateArchiveOriginal,deletePrivateArchiveOriginal } from './private-archive-service.js';
import { reservePrivateGalleryAttempt } from './private-gallery-attempt-service.js';
import {readPrivateArchiveJobs,queuePrivateArchiveJob} from './private-gallery-job-service.js';
import { hashIdentity } from './session.js';

// Called only after the admin router's verified owner, signed inherited-area
// session, same-origin and CSRF gates. It has private-originals capability only.
const failure=status=>({ok:false,status,code:'private-photo-owner-request-stopped'});

export async function readPrivateArchiveStatus(env,identity,site,assetId) {
    const asset=await readPrivateGalleryAsset(env,identity,site,assetId);
    if(!asset.ok) return asset;
    try {
        const row=await env.DB.prepare(`SELECT s.tag_version,i.contains_minors,o.asset_id AS retained,
            d.reason,r.asset_id AS deleted FROM private_gallery_assets a
            JOIN private_gallery_current_tag_sets s USING(asset_id)
            LEFT JOIN private_archive_intakes i USING(asset_id)
            LEFT JOIN private_archive_original_receipts o USING(asset_id)
            LEFT JOIN private_archive_deletion_requests d USING(asset_id)
            LEFT JOIN private_archive_deletion_receipts r USING(asset_id)
            WHERE a.asset_id=?1 AND a.owner_identity_hash=?2 AND a.site_mode=?3`)
            .bind(assetId,await hashIdentity(identity),site).first();
        if(!row || !Number.isSafeInteger(row.tag_version)) return failure(503);
        return {ok:true,status:200,assetId,tagVersion:row.tag_version,containsMinors:row.contains_minors===1,
            state:row.deleted?'private-original-deleted':row.reason?'deletion-pending':row.retained?'quarantined':'awaiting-original',
            publicationEnabled:false};
    } catch {return failure(503);}
}

// One total body deadline, bounded cancellation, no unbounded request.json() or
// arrayBuffer(). Authentication precedes this helper. No filename is accepted.
export async function readPrivateOwnerBody(request,maximumBytes,contentType,timeoutMilliseconds=5000) {
    if(request.headers.get('Content-Type')!==contentType || request.headers.has('Content-Encoding') ||
        request.headers.has('Transfer-Encoding') || !request.body) return failure(400);
    const declared=request.headers.get('Content-Length');
    if(declared!==null && (!/^[1-9][0-9]*$/.test(declared) || Number(declared)>maximumBytes)) return failure(413);
    const duration=Number.isSafeInteger(timeoutMilliseconds) && timeoutMilliseconds>0 && timeoutMilliseconds<=30000 ? timeoutMilliseconds : 5000;
    const deadline=Date.now()+duration,reader=request.body.getReader(),chunks=[];
    let size=0;
    try {
        while(true) {
            let timer;
            const next=await Promise.race([reader.read(),new Promise((_,reject)=>{
                timer=setTimeout(()=>reject(new Error('Timed out')),Math.max(0,deadline-Date.now()));
            })]).finally(()=>clearTimeout(timer));
            if(Date.now()>=deadline) throw new Error('Timed out');
            if(next.done) break;
            if(!(next.value instanceof Uint8Array)) throw new Error('Invalid body');
            size+=next.value.byteLength;
            if(size>maximumBytes) throw new Error('Oversized body');
            chunks.push(next.value);
        }
        if(size===0 || declared!==null && size!==Number(declared)) throw new Error('Length differs');
        const bytes=new Uint8Array(size);let offset=0;
        for(const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.length;}
        return {ok:true,bytes};
    } catch {
        let timer;
        await Promise.race([Promise.resolve(reader.cancel()).catch(()=>{}),new Promise(resolve=>{timer=setTimeout(resolve,100);})])
            .finally(()=>clearTimeout(timer));
        return failure(400);
    } finally {try {reader.releaseLock();} catch { /* Timed-out read stays rejected. */ }}
}

export async function handlePrivatePhotoOwnerOperation(request,env,identity,site,route,catalog,dependencies={}) {
    try {
        if(['archive-intake','archive-jobs'].includes(route.kind) && request.method==='GET') {
            if(request.body || request.headers.has('Content-Type') || request.headers.has('Transfer-Encoding') ||
                ![null,'0'].includes(request.headers.get('Content-Length'))) return failure(400);
            return route.kind==='archive-jobs'?readPrivateArchiveJobs(env,identity,site,route.assetId):readPrivateArchiveStatus(env,identity,site,route.assetId);
        }
        if(route.kind==='archive-original') {
            if(request.method!=='PUT') return {...failure(405),allow:'PUT'};
            // Ownership is checked before reading even one request byte.
            const selected=await readPrivateGalleryAsset(env,identity,site,route.assetId);
            if(!selected.ok) return selected;
            const body=await readPrivateOwnerBody(request,26214400,'application/octet-stream',dependencies.bodyTimeoutMilliseconds);
            if(!body.ok) return body;
            return storePrivateArchiveOriginal(env,identity,site,route.assetId,new Blob([body.bytes]).stream(),dependencies);
        }
        if(request.method!=='POST') return {...failure(405),allow:route.kind==='archive-intake'?'GET, POST':'POST'};
        const body=await readPrivateOwnerBody(request,32768,'application/json',dependencies.bodyTimeoutMilliseconds);
        if(!body.ok) return body;
        let input;
        try {input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body.bytes));} catch {return failure(400);}
        if(route.kind==='archive-jobs') return queuePrivateArchiveJob(env,identity,site,route.assetId,input);
        if(route.kind==='archive-intake') return preparePrivateArchiveIntake(env,identity,site,route.assetId,input);
        if(route.kind==='archive-attempt') return reservePrivateGalleryAttempt(env,identity,site,route.assetId,input,catalog);
        if(route.kind==='archive-deletion') {
            if(!input || Object.keys(input).join('|')!=='reason' || !['owner-delete','consent-withdrawal'].includes(input.reason)) return failure(422);
            // Terminal block precedes original deletion; 0023 prevents completion
            // while linked public generations still need removal. Never purge.
            return deletePrivateArchiveOriginal(env,identity,site,route.assetId,input.reason);
        }
        return failure(404);
    } catch {return failure(503);}
}
