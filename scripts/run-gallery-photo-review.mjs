import { runPhotoReviewBridge } from './gallery-media/photo-review-bridge.mjs';

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
    const result = await runPhotoReviewBridge({
        draftId: requiredEnvironment('GALLERY_DRAFT_ID'),
        expectedBaseSha: requiredEnvironment('GALLERY_BASE_SHA'),
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
    process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
    process.stderr.write(`Gallery photo review generation failed: ${error.message}\n`);
    process.exitCode = 1;
}
