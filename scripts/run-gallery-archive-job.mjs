import {appendFile} from 'node:fs/promises';
import {createArchiveServiceClient,createArchiveProcessingClient,createArchivePromotionClient,createArchiveJobClient,createArchiveFinalizerClient} from './gallery-media/archive-service-client.mjs';
import {runProtectedArchiveJob} from './gallery-media/protected-archive-job.mjs';
import {verifyGalleryReviewBoundary} from './gallery-media/github-review-boundary.mjs';
import {readGalleryReviewMain} from './gallery-media/github-review-client.mjs';
import {readBoundedBytes} from '../gallery-admin/src/media-byte-verification.js';
const required=name=>{const value=process.env[name];if(typeof value!=='string' || !value) throw new Error('Protected configuration missing.');return value;};
// The CLI is an Actions-only boundary; importing core libraries never discovers
// credentials or executes it. No arguments, arbitrary ref, destination or media.
try {
    if(process.argv.length!==2 || process.env.GITHUB_ACTIONS!=='true' || process.env.GITHUB_REPOSITORY!=='johnkevan88888/family-running' ||
        process.env.GITHUB_REF!=='refs/heads/main' || process.env.GITHUB_EVENT_NAME!=='workflow_dispatch' ||
        !/^[0-9a-f]{40}$/.test(required('GALLERY_BASE_SHA'))) throw new Error('Protected main-only manual run required.');
    const jobId=required('GALLERY_ARCHIVE_JOB_ID'),runReference=required('GALLERY_WORKFLOW_RUN_REFERENCE');
    let phase=required('GALLERY_ARCHIVE_PHASE');
    if(!['prepare','verify','reconcile','finalize','purge'].includes(phase)) throw new Error('Unknown phase.');
    const githubFetch=async (url,options)=>{
        const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
        try {
            const response=await fetch(url,{...options,redirect:'error',signal:controller.signal});
            const bytes=await readBoundedBytes(response.body,2097152);
            return {ok:response.ok,status:response.status,json:async()=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),
                text:async()=>new TextDecoder().decode(bytes)};
        } finally {clearTimeout(timer);controller.abort();}
    };
    const configuration=purpose=>{
        const prefix=purpose==='verifier'?'GALLERY_PUBLIC_HOST_VERIFIER':purpose==='finalizer'?'GALLERY_WITHDRAWAL_FINALIZER':`GALLERY_${purpose.toUpperCase()}`;
        return {purpose,origin:required(prefix+'_ORIGIN'),clientId:required(prefix+'_ACCESS_CLIENT_ID'),clientSecret:required(prefix+'_ACCESS_CLIENT_SECRET'),fetchImpl:fetch};
    };
    const finalization=['verify','finalize','purge'].includes(phase),purpose=finalization?'finalizer':'promotion';
    const jobs=createArchiveJobClient(configuration(purpose));
    const dependencies={jobId,runReference,jobs};
    if(!finalization) {
        const github={token:required('GALLERY_GITHUB_APP_TOKEN'),fetchImpl:githubFetch};
        // Re-prove the App restriction against CURRENT main even on a resumed
        // historical run. This PATCH is same-SHA and must be denied; never merge.
        const main=await readGalleryReviewMain({token:github.token,fetchImpl:githubFetch});
        await verifyGalleryReviewBoundary({expectedBaseSha:main.baseSha,token:github.token,fetchImpl:githubFetch});
        dependencies.github=github;dependencies.processing=createArchiveProcessingClient(configuration('processing'));
        dependencies.promotion=createArchivePromotionClient(configuration('promotion'));
        if(phase==='prepare') {
            const read=await jobs(jobId,'read',{runReference});
            if(read?.ok!==true || !['review','batch-review','removal','publication'].includes(read.value.job?.action)) throw new Error('Owner job unavailable.');
            phase={review:'review','batch-review':'review',removal:'cleanup',publication:'publication'}[read.value.job.action];
        }
    } else if(phase==='verify') dependencies.verifier=createArchiveServiceClient(configuration('verifier'));
    else if(phase==='finalize') dependencies.finalizer=createArchiveFinalizerClient(configuration('finalizer'));
    else dependencies.github={token:required('GALLERY_GITHUB_READ_TOKEN'),fetchImpl:githubFetch};
    const result=await runProtectedArchiveJob({...dependencies,phase});
    const states=['pending','unmerged-review','cleanup-ready','host-ready','removed','unmerged-removal-review','ready-for-separate-owner-merge',
        'publication-observed','publication-revoked','purge-eligible','private-records-purged','private-original-deleted','hidden-original-retained','awaiting-owner-removal-review'];
    if(!states.includes(result.state)) throw new Error('Unknown result.');
    if(process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,`state=${result.state}\n`);
    process.stdout.write(`${JSON.stringify({ok:result.ok===true,state:result.state,publicationEnabled:false})}\n`);
    if(result.ok!==true) process.exitCode=1;
} catch {
    process.stderr.write('Protected archive job stopped; retain its claim and rerun the original run after reconciliation.\n');process.exitCode=1;
}
