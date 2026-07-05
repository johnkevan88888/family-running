import fs from 'node:fs/promises';
import path from 'node:path';
import {
    assertExactTrackedCsvSet,
    compareBundles,
    listPublicCsvFiles,
    repoRoot,
    runCsvValidator,
    stagingParent
} from '../scripts/export-bundle-tools.mjs';

const stagedRoot = path.join(
    stagingParent,
    `workflow-test-${process.pid}-${Date.now()}`
);
const dataRoot = path.join(stagedRoot, 'data');
const bundleId = '20990101T010203004Z-A1B2C3D4';
const exportedAt = '2099-01-01T01:02:03.004Z';

try {
    await fs.mkdir(stagedRoot, { recursive: true });
    await fs.cp(path.join(repoRoot, 'data'), dataRoot, { recursive: true });
    await rewriteVolatileMetadata();

    const files = assertExactTrackedCsvSet(stagedRoot);
    const validation = runCsvValidator(stagedRoot);

    assert(validation.status === 0, validation.stderr || validation.stdout);
    assert(files.length === listPublicCsvFiles(path.join(repoRoot, 'data')).length);

    const metadataOnlyComparison = compareBundles(stagedRoot);
    assert(
        metadataOnlyComparison.meaningfulDifferences.length === 0,
        'Volatile bundle metadata should not create reconciliation differences.'
    );
    console.log('PASS - staged bundle validation and volatile metadata normalization');

    const siteInfo = path.join(dataRoot, 'family', 'siteinfo.csv');
    const originalSiteInfo = await fs.readFile(siteInfo, 'utf8');
    const changedSiteInfo = originalSiteInfo.replace(
        /(^SiteVersion,)[^,\r\n]+/m,
        '$1v9.9'
    );
    assert(changedSiteInfo !== originalSiteInfo, 'Could not mutate site version fixture.');
    await fs.writeFile(siteInfo, changedSiteInfo);

    const changedComparison = compareBundles(stagedRoot);
    assert(
        changedComparison.meaningfulDifferences.some(
            result => result.relativePath === 'data/family/siteinfo.csv'
        ),
        'Meaningful staged content change was not reported.'
    );
    console.log('PASS - meaningful staged difference detection');

    const removedFile = path.join(dataRoot, 'family', 'crown_history.csv');
    await fs.rm(removedFile);
    let missingFileRejected = false;

    try {
        assertExactTrackedCsvSet(stagedRoot);
    } catch (error) {
        missingFileRejected = error.message.includes('missing staged file');
    }

    assert(missingFileRejected, 'Incomplete staged file set was not rejected.');
    console.log('PASS - incomplete staged file-set rejection');
} finally {
    await fs.rm(stagedRoot, { recursive: true, force: true });
}

console.log('Staged export workflow regression tests passed.');

async function rewriteVolatileMetadata() {
    const csvFiles = listPublicCsvFiles(dataRoot);

    for (const relativePath of csvFiles) {
        const filePath = path.join(dataRoot, relativePath);
        let text = await fs.readFile(filePath, 'utf8');

        if (relativePath.replace(/\\/g, '/') === 'export_manifest.csv') {
            const lines = splitLines(text);

            for (let index = 1; index < lines.length; index += 1) {
                const fields = lines[index].split(',');
                fields[0] = bundleId;
                fields[1] = exportedAt;
                lines[index] = fields.join(',');
            }
            text = `${lines.join('\r\n')}\r\n`;
        } else {
            const lines = splitLines(text);

            for (let index = 1; index < lines.length; index += 1) {
                lines[index] = lines[index].replace(/[^,]*$/, bundleId);
            }

            if (/[/\\]siteinfo\.csv$/i.test(relativePath)) {
                const updatedAtIndex = lines.findIndex(line =>
                    line.startsWith('LastUpdatedUTC,')
                );
                const fields = lines[updatedAtIndex].split(',');
                fields[1] = exportedAt;
                lines[updatedAtIndex] = fields.join(',');
            }

            text = `${lines.join('\r\n')}\r\n`;
        }

        await fs.writeFile(filePath, text);
    }
}

function splitLines(text) {
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd().split('\n');
}

function assert(condition, message = 'Assertion failed.') {
    if (!condition) {
        throw new Error(message);
    }
}
