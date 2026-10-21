import assert from 'node:assert/strict';
import {privateGalleryBatchFixture,batchRun} from './private-gallery-batch-fixture.mjs';
import {runProtectedArchiveJob} from '../../scripts/gallery-media/protected-archive-job.mjs';
import {readArchiveBatchJob} from '../../gallery-admin/src/private-gallery-batch-service.js';
import {archiveBatchOperation} from '../../gallery-admin/src/private-gallery-batch-promotion.js';

// Generated pixels/invented tags, actual protected storage/adapters/decoder.
// Every GitHub/host operation is an injected in-memory transport, never network.
export async function reviewedBatchFixture(site='family') {
    const f=await privateGalleryBatchFixture(site,{small:true});
    f.execute=(phase,overrides={})=>runProtectedArchiveJob({jobId:f.jobId,runReference:batchRun,phase,...f.c,
        jobs:f.c.jobs[['verify','finalize'].includes(phase)?'finalizer':'promotion'],github:f.github,...overrides});
    f.review=await f.execute('review');assert.equal(f.review.state,'unmerged-review',JSON.stringify(f.review));
    f.batchOperation=async(operation,value={})=>archiveBatchOperation({...f.c.environments.promotion,
        ARCHIVE_SERVICE_IDENTITY:`subject:${f.c.identities.promotion.subject}`},f.c.identities.promotion,
        await readArchiveBatchJob(f.env,f.jobId),f.catalog,operation,{runReference:batchRun,...value});
    return f;
}
export function syntheticBatchMergedEvidence(review,{mainSha='d'.repeat(40),mergeSha='c'.repeat(40)}={}) {
    const {replayed,...recorded}=review;
    return {...recorded,pullRequest:{...recorded.pullRequest,state:'closed'},state:'merged-by-owner',mergeSha,mainSha};
}
