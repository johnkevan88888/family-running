import fs from 'node:fs';
import path from 'node:path';
import {
    assertExactTrackedCsvSet,
    compareBundles,
    formatComparisonLine,
    parseCliArguments,
    resolveStagedRoot,
    runCsvValidator
} from './export-bundle-tools.mjs';

try {
    const options = parseCliArguments(process.argv.slice(2));
    const stagedRoot = resolveStagedRoot(options.get('staged'));
    assertExactTrackedCsvSet(stagedRoot);

    const validation = runCsvValidator(stagedRoot);

    if (validation.status !== 0) {
        process.stderr.write(validation.stdout || '');
        process.stderr.write(validation.stderr || '');
        throw new Error('The staged bundle must pass CSV validation before comparison.');
    }

    const comparison = compareBundles(stagedRoot);
    const reportPath = options.get('report')
        ? path.resolve(String(options.get('report')))
        : path.join(stagedRoot, 'reconciliation.json');

    fs.writeFileSync(reportPath, `${JSON.stringify(comparison, null, 2)}\n`, 'utf8');

    for (const result of comparison.files) {
        console.log(formatComparisonLine(result));
    }
    console.log(`Reconciliation report: ${reportPath}`);

    if (comparison.meaningfulDifferences.length > 0) {
        console.error(
            `${comparison.meaningfulDifferences.length} file(s) contain meaningful differences requiring human review.`
        );
        process.exit(2);
    }

    console.log('No meaningful content differences found after volatile metadata normalization.');
} catch (error) {
    console.error(`Staged export comparison failed: ${error.message}`);
    process.exit(1);
}
