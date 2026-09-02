import {
    photoInvalidationCompletionSummary,
    runPhotoReviewInvalidationBridge
} from './gallery-media/photo-review-invalidation-bridge.mjs';

function requiredEnvironment(name) {
    const value = process.env[name];
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`Required protected environment value ${name} is missing.`);
    }
    return value;
}

if (process.argv.length !== 2) {
    throw new Error('This command accepts no arguments; the protected workflow supplies one opaque draft ID.');
}

try {
    await runPhotoReviewInvalidationBridge({
        draftId: requiredEnvironment('GALLERY_DRAFT_ID'),
        githubToken: requiredEnvironment('GALLERY_GITHUB_APP_TOKEN'),
        processing: {
            origin: requiredEnvironment('GALLERY_PROCESSING_ORIGIN'),
            clientId: requiredEnvironment('GALLERY_PROCESSING_ACCESS_CLIENT_ID'),
            clientSecret: requiredEnvironment('GALLERY_PROCESSING_ACCESS_CLIENT_SECRET')
        },
        promotion: {
            origin: requiredEnvironment('GALLERY_PROMOTION_ORIGIN'),
            clientId: requiredEnvironment('GALLERY_PROMOTION_ACCESS_CLIENT_ID'),
            clientSecret: requiredEnvironment('GALLERY_PROMOTION_ACCESS_CLIENT_SECRET')
        }
    });
    process.stdout.write(`${JSON.stringify(photoInvalidationCompletionSummary())}\n`);
} catch (error) {
    process.stderr.write(`Gallery photo invalidation failed: ${error.message}\n`);
    process.exitCode = 1;
}
