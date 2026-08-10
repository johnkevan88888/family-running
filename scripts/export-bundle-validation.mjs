import {
    assertTrackedCsvSet,
    normalizePnpmPathArgument,
    parseApprovedNewCsvFiles,
    parseCliArguments,
    resolveStagedRoot,
    runCsvValidator
} from './export-bundle-tools.mjs';

try {
    const options = parseCliArguments(process.argv.slice(2));
    const stagedRoot = resolveStagedRoot(
        normalizePnpmPathArgument(options.get('staged'))
    );
    const approvedNewFiles = parseApprovedNewCsvFiles(options.get('approve-new-files'));
    const files = assertTrackedCsvSet(stagedRoot, { approvedNewFiles });
    const result = runCsvValidator(stagedRoot, { inherit: true });

    if (result.status !== 0) {
        process.exit(result.status || 1);
    }

    console.log(
        `Staged export bundle validation passed (${files.length} public CSV files): ${stagedRoot}`
    );
} catch (error) {
    console.error(`Staged export bundle validation failed: ${error.message}`);
    process.exit(1);
}
