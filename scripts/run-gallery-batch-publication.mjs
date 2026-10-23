import {createArchiveJobClient,createArchivePromotionClient} from './gallery-media/archive-service-client.mjs';
import {runProtectedBatchPublication} from './gallery-media/batch-publication-continuation.mjs';
import {verifyGalleryReviewBoundary} from './gallery-media/github-review-boundary.mjs';
import {readBoundedBytes} from '../gallery-admin/src/media-byte-verification.js';
import {formatArchiveDiagnostic,reportArchiveDiagnostic} from './gallery-media/archive-diagnostics.mjs';

const required=name=>{const value=process.env[name];if(typeof value!=='string' || !value) throw new Error('Protected configuration missing.');return value;};
let failures=0,stage='configuration';
const reportFailure=event=>{if(failures++<32) process.stderr.write(formatArchiveDiagnostic(event));};
try {
    if(process.argv.length!==2 || process.env.GITHUB_ACTIONS!=='true' || process.env.GITHUB_REPOSITORY!=='johnkevan88888/family-running' ||
        process.env.GITHUB_REF!=='refs/heads/main' || process.env.GITHUB_EVENT_NAME!=='workflow_dispatch' ||
        !/^[0-9a-f]{40}$/.test(required('GALLERY_BASE_SHA')) || required('GALLERY_BASE_SHA')!==required('GITHUB_SHA') ||
        !/^[1-9][0-9]*$/.test(required('GITHUB_RUN_ID')) || !['prepare','observe'].includes(required('GALLERY_PUBLICATION_PHASE')) ||
        !/^job_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(required('GALLERY_ARCHIVE_JOB_ID')))
        throw new Error('Protected exact-main manual continuation required.');
    const fetchImpl=async(url,options)=>{
        const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
        try {
            const response=await fetch(url,{...options,redirect:'error',signal:controller.signal});
            const bytes=await readBoundedBytes(response.body,2097152);
            return {ok:response.ok,status:response.status,json:async()=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),
                text:async()=>new TextDecoder('utf-8',{fatal:true}).decode(bytes)};
        } finally {clearTimeout(timer);controller.abort();}
    };
    const github={token:required('GALLERY_GITHUB_APP_TOKEN'),fetchImpl},expectedBaseSha=required('GALLERY_BASE_SHA');
    stage='permission-boundary';
    await verifyGalleryReviewBoundary({expectedBaseSha,...github});
    stage='service-configuration';
    const configuration={purpose:'promotion',origin:required('GALLERY_PROMOTION_ORIGIN'),
        clientId:required('GALLERY_PROMOTION_ACCESS_CLIENT_ID'),clientSecret:required('GALLERY_PROMOTION_ACCESS_CLIENT_SECRET'),fetchImpl:fetch,reportFailure};
    const jobs=createArchiveJobClient(configuration),promotion=createArchivePromotionClient(configuration);
    stage=null;
    const result=await runProtectedBatchPublication({jobId:required('GALLERY_ARCHIVE_JOB_ID'),phase:required('GALLERY_PUBLICATION_PHASE'),
        runReference:`https://github.com/johnkevan88888/family-running/actions/runs/${required('GITHUB_RUN_ID')}`,
        expectedBaseSha,jobs,promotion,github,reportFailure});
    process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
    if(stage) reportArchiveDiagnostic(reportFailure,{kind:'batch-publication',stage,reason:'step-failed'});
    process.stderr.write('Batch publication continuation stopped. Preserve the original claim, photos and review evidence. No processing, cleanup, claim transfer or GitHub merge was requested.\n');
    process.exitCode=1;
}
