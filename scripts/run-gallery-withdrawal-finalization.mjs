import {
    runWithdrawalFinalizationBridge,
    withdrawalFinalizationCompletionSummary
} from './gallery-media/withdrawal-finalization-bridge.mjs';

function requiredEnvironment(name) {
    const value = process.env[name];
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error('Required protected environment configuration is missing.');
    }
    return value;
}

try {
    if (process.argv.length !== 2) {
        throw new Error('The protected workflow runner accepts no arguments.');
    }
    const result = await runWithdrawalFinalizationBridge({
        action: requiredEnvironment('GALLERY_FINALIZATION_ACTION'),
        draftId: requiredEnvironment('GALLERY_DRAFT_ID'),
        verifier: {
            origin: requiredEnvironment('GALLERY_PUBLIC_HOST_VERIFIER_ORIGIN'),
            clientId: requiredEnvironment(
                'GALLERY_PUBLIC_HOST_VERIFIER_ACCESS_CLIENT_ID'
            ),
            clientSecret: requiredEnvironment(
                'GALLERY_PUBLIC_HOST_VERIFIER_ACCESS_CLIENT_SECRET'
            )
        },
        finalizer: {
            origin: requiredEnvironment('GALLERY_WITHDRAWAL_FINALIZER_ORIGIN'),
            clientId: requiredEnvironment(
                'GALLERY_WITHDRAWAL_FINALIZER_ACCESS_CLIENT_ID'
            ),
            clientSecret: requiredEnvironment(
                'GALLERY_WITHDRAWAL_FINALIZER_ACCESS_CLIENT_SECRET'
            )
        }
    });
    process.stdout.write(
        `${JSON.stringify(withdrawalFinalizationCompletionSummary(result))}\n`
    );
} catch {
    process.stderr.write('Gallery photo finalization failed.\n');
    process.exitCode = 1;
}
