import {createArchiveJobClient,createArchivePromotionClient} from './gallery-media/archive-service-client.mjs';
import {runProtectedBatchReviewRefresh} from './gallery-media/batch-review-refresh.mjs';
import {verifyGalleryReviewBoundary} from './gallery-media/github-review-boundary.mjs';
import {readBoundedBytes} from '../gallery-admin/src/media-byte-verification.js';
import {formatArchiveDiagnostic,reportArchiveDiagnostic} from './gallery-media/archive-diagnostics.mjs';

const required=name=>{const value=process.env[name];if(typeof value!=='string' || !value) throw new Error('Protected configuration missing.');return value;};
let reportedFailures=0,stage='configuration';
const reportFailure=event=>{if(reportedFailures++<32) process.stderr.write(formatArchiveDiagnostic(event));};
try {
    if(process.argv.length!==2 || process.env.GITHUB_ACTIONS!=='true' || process.env.GITHUB_REPOSITORY!=='johnkevan88888/family-running' ||
        process.env.GITHUB_REF!=='refs/heads/main' || process.env.GITHUB_EVENT_NAME!=='workflow_dispatch' ||
        !/^[0-9a-f]{40}$/.test(required('GALLERY_BASE_SHA')) || required('GALLERY_BASE_SHA')!==required('GITHUB_SHA') ||
        !/^[1-9][0-9]*$/.test(required('GITHUB_RUN_ID')) ||
        !/^job_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(required('GALLERY_ARCHIVE_JOB_ID')))
        throw new Error('Protected exact-main manual refresh required.');
    const fetchImpl=async(url,options)=>{
        const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
        try {
            const response=await fetch(url,{...options,redirect:'error',signal:controller.signal});
            const bytes=await readBoundedBytes(response.body,2097152);
            return {ok:response.ok,status:response.status,json:async()=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),
                text:async()=>new TextDecoder('utf-8',{fatal:true}).decode(bytes)};
        } finally {clearTimeout(timer);controller.abort();}
    };
    const github={token:required('GALLERY_GITHUB_APP_TOKEN'),fetchImpl};
    const expectedBaseSha=required('GALLERY_BASE_SHA');
    // Existing negative same-SHA main-update probe; it must remain denied.
    stage='permission-boundary';
    await verifyGalleryReviewBoundary({expectedBaseSha,...github});
    stage='service-configuration';
    const configuration={purpose:'promotion',origin:required('GALLERY_PROMOTION_ORIGIN'),
        clientId:required('GALLERY_PROMOTION_ACCESS_CLIENT_ID'),clientSecret:required('GALLERY_PROMOTION_ACCESS_CLIENT_SECRET'),fetchImpl:fetch,reportFailure};
    const jobs=createArchiveJobClient(configuration),promotion=createArchivePromotionClient(configuration);
    stage=null; // The protected runner reports its exact bounded stage from here.
    const result=await runProtectedBatchReviewRefresh({jobId:required('GALLERY_ARCHIVE_JOB_ID'),
        runReference:`https://github.com/johnkevan88888/family-running/actions/runs/${required('GITHUB_RUN_ID')}`,
        expectedBaseSha,jobs,promotion,github,reportFailure});
    process.stdout.write(`${JSON.stringify({ok:true,state:'unmerged-review-refreshed',...result,publicationEnabled:false})}\n`);
} catch {
    if(stage) reportArchiveDiagnostic(reportFailure,{kind:'batch-review-refresh',stage,reason:'step-failed'});
    process.stderr.write('Batch review refresh stopped. Preserve its original claim and receipts; inspect the exact review before retrying. No photo processing, cleanup or publication was requested.\n');
    process.exitCode=1;
}
