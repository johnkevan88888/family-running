import { runPhotoReviewRefreshBridge } from './gallery-media/photo-review-bridge.mjs';
import { verifyGalleryReviewBoundary } from './gallery-media/github-review-boundary.mjs';

function required(name) {
    const value = process.env[name];
    if (typeof value !== 'string' || !value) throw new Error('Missing protected configuration.');
    return value;
}

try {
    if (process.argv.length !== 2) throw new Error('No command-line arguments accepted.');
    const expectedBaseSha = required('GALLERY_BASE_SHA');
    const githubToken = required('GALLERY_GITHUB_APP_TOKEN');
    await verifyGalleryReviewBoundary({ expectedBaseSha, token: githubToken, fetchImpl: globalThis.fetch });
    const result = await runPhotoReviewRefreshBridge({
        draftId: required('GALLERY_DRAFT_ID'), expectedBaseSha, githubToken,
        promotion: {
            origin: required('GALLERY_PROMOTION_ORIGIN'),
            clientId: required('GALLERY_PROMOTION_ACCESS_CLIENT_ID'),
            clientSecret: required('GALLERY_PROMOTION_ACCESS_CLIENT_SECRET')
        }
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
    process.stderr.write('Gallery review refresh failed; no publication was requested. Check the protected review state before retrying.\n');
    process.exitCode = 1;
}
