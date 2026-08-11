import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const validatorPath = path.join(repoRoot, 'scripts', 'validate-csv.mjs');
const sourceData = path.join(repoRoot, 'data');

const cases = [
    {
        name: 'changed CSV bundle ID',
        expected: 'data/family/10km-current-official-family.csv:2: ExportBundleID',
        mutate: async root => {
            const file = path.join(root, 'data', 'family', '10km-current-official-family.csv');
            const lines = splitLines(await fs.readFile(file, 'utf8'));
            lines[1] = lines[1].replace(/[^,]*$/, '20990101T000000000Z-DEADBEEF');
            await fs.writeFile(file, `${lines.join('\r\n')}\r\n`);
        }
    },
    {
        name: 'CSV omitted from manifest',
        expected: 'data/family/siteinfo.csv:1: Public CSV exists but is absent',
        mutate: async root => {
            const file = path.join(root, 'data', 'export_manifest.csv');
            const lines = splitLines(await fs.readFile(file, 'utf8'))
                .filter(line => !line.includes(',data/family/siteinfo.csv,'));
            await fs.writeFile(file, `${lines.join('\r\n')}\r\n`);
        }
    },
    {
        name: 'wrong manifest row count',
        expected: 'DataRowCount for "data/everyone/official_medals.csv"',
        mutate: async root => {
            const file = path.join(root, 'data', 'export_manifest.csv');
            const lines = splitLines(await fs.readFile(file, 'utf8'));
            const rowIndex = lines.findIndex(line => line.includes(',data/everyone/official_medals.csv,'));

            if (rowIndex < 0) {
                throw new Error('Could not find official medals manifest row.');
            }

            lines[rowIndex] = lines[rowIndex].replace(/(\d+)$/, value => String(Number(value) + 1));
            await fs.writeFile(file, `${lines.join('\r\n')}\r\n`);
        }
    },
    {
        name: 'missing age-grade pace field',
        expected: 'data/family/age_grade_standards.csv:1: Missing required header "pace_per_mile"',
        mutate: async root => {
            const file = path.join(root, 'data', 'family', 'age_grade_standards.csv');
            const lines = splitLines(await fs.readFile(file, 'utf8'));
            const paceColumnIndex = lines[0].split(',').indexOf('pace_per_mile');

            if (paceColumnIndex < 0) {
                throw new Error('Could not find pace_per_mile in the age-grade standards fixture.');
            }

            for (let index = 0; index < lines.length; index += 1) {
                const fields = lines[index].split(',');
                fields.splice(paceColumnIndex, 1);
                lines[index] = fields.join(',');
            }

            await fs.writeFile(file, `${lines.join('\r\n')}\r\n`);
        }
    },
    {
        name: 'malformed age-grade pace',
        expected: 'pace_per_km "4:03" must use m:ss.s',
        mutate: async root => {
            const file = path.join(root, 'data', 'everyone', 'age_grade_standards.csv');
            const lines = splitLines(await fs.readFile(file, 'utf8'));
            lines[1] = replaceCsvField(lines[1], 5, '4:03');
            await fs.writeFile(file, `${lines.join('\r\n')}\r\n`);
        }
    },
    {
        name: 'incorrect age-grade pace',
        expected: 'pace_per_mile "9:19.0" does not match RequiredTime',
        mutate: async root => {
            const file = path.join(root, 'data', 'family', 'age_grade_standards.csv');
            const lines = splitLines(await fs.readFile(file, 'utf8'));
            lines[1] = replaceCsvField(lines[1], 6, '9:19.0');
            await fs.writeFile(file, `${lines.join('\r\n')}\r\n`);
        }
    },
    {
        name: 'malformed athlete-comparison target pace',
        expected: 'RequiredPacePerKm "3:37" must use m:ss.s',
        mutate: async root => {
            const manifestFile = path.join(root, 'data', 'export_manifest.csv');
            const manifestLines = splitLines(await fs.readFile(manifestFile, 'utf8'));
            const [bundleId, exportedAt, schemaVersion] = manifestLines[1].split(',');
            manifestLines.push(
                `${bundleId},${exportedAt},${schemaVersion},family,data/family/athlete_comparison_targets.csv,2`
            );
            await fs.writeFile(manifestFile, `${manifestLines.join('\r\n')}\r\n`);

            const comparisonFile = path.join(root, 'data', 'family', 'athlete_comparison_targets.csv');
            const rows = [
                'ChallengerAthleteId,StandardAthleteId,Distance,BenchmarkType,StandardTime,StandardAgeGrade,StandardDate,StandardEvent,StandardTimeClass,RequiredTimeToBeat,RequiredPacePerKm,RequiredPacePerMile,SortOrder,ExportBundleID',
                `john-kevan,carolyn-kevan,5 km,Best Age Grade,00:25:20,78.0%,28/03/2026,Northern Counties Womens Relay,Official,00:18:08,3:37,5:50.1,101,${bundleId}`,
                `john-kevan,carolyn-kevan,5 km,Fastest Time,00:23:27,77.8%,16/11/2019,Northern Masters 5k Championships,Official,00:18:11,3:38.2,5:51.1,102,${bundleId}`
            ];
            await fs.writeFile(comparisonFile, `${rows.join('\r\n')}\r\n`);
        }
    },
    {
        name: 'incomplete athlete-comparison pair matrix',
        expected: 'is missing the Best Age Grade benchmark',
        mutate: async root => {
            const manifestFile = path.join(root, 'data', 'export_manifest.csv');
            const manifestLines = splitLines(await fs.readFile(manifestFile, 'utf8'));
            const [bundleId, exportedAt, schemaVersion] = manifestLines[1].split(',');
            manifestLines.push(
                `${bundleId},${exportedAt},${schemaVersion},family,data/family/athlete_comparison_targets.csv,2`
            );
            await fs.writeFile(manifestFile, `${manifestLines.join('\r\n')}\r\n`);

            const comparisonFile = path.join(root, 'data', 'family', 'athlete_comparison_targets.csv');
            const rows = [
                'ChallengerAthleteId,StandardAthleteId,Distance,BenchmarkType,StandardTime,StandardAgeGrade,StandardDate,StandardEvent,StandardTimeClass,RequiredTimeToBeat,RequiredPacePerKm,RequiredPacePerMile,SortOrder,ExportBundleID',
                `john-kevan,carolyn-kevan,5 km,Best Age Grade,00:25:20,78.0%,28/03/2026,Northern Counties Womens Relay,Official,00:18:08,3:37.6,5:50.1,101,${bundleId}`,
                `john-kevan,carolyn-kevan,5 km,Fastest Time,00:23:27,77.8%,16/11/2019,Northern Masters 5k Championships,Official,00:18:11,3:38.2,5:51.1,102,${bundleId}`
            ];
            await fs.writeFile(comparisonFile, `${rows.join('\r\n')}\r\n`);
        }
    },
    // Absolute records are a fixed Men/Women by supported-distance matrix, so a
    // dropped, duplicated, misfiled, or reordered record is a defect the Records
    // page cannot show. Each case below breaks exactly one of those rules.
    {
        name: 'absolute record row missing from the matrix',
        expected: 'Missing the Men 10 Mile absolute record row.',
        mutate: async root => {
            const lines = await readAbsoluteRecords(root);
            lines.splice(3, 1);
            await writeAbsoluteRecords(root, lines);
            await setManifestRowCount(root, 'data/family/absolute_records.csv', lines.length - 1);
        }
    },
    {
        name: 'extra absolute record row',
        expected: 'Unexpected extra record row',
        mutate: async root => {
            const lines = await readAbsoluteRecords(root);
            lines.push(replaceCsvField(replaceCsvField(lines[10], 0, '160'), 2, "Women's bonus record"));
            await writeAbsoluteRecords(root, lines);
            await setManifestRowCount(root, 'data/family/absolute_records.csv', lines.length - 1);
        }
    },
    {
        name: 'duplicate absolute record distance',
        expected: 'Duplicate absolute record for Men 10 km',
        mutate: async root => {
            const lines = await readAbsoluteRecords(root);
            lines[5] = replaceCsvField(replaceCsvField(lines[5], 4, '10 km'), 5, '10 km');
            await writeAbsoluteRecords(root, lines);
        }
    },
    {
        name: 'unsupported absolute record distance',
        expected: 'Distance "Overall" must be one of: Marathon, Half Marathon, 10 Mile, 10 km, 5 km.',
        mutate: async root => {
            const lines = await readAbsoluteRecords(root);
            lines[1] = replaceCsvField(lines[1], 4, 'Overall');
            await writeAbsoluteRecords(root, lines);
        }
    },
    {
        name: 'invalid RecordGroup value',
        expected: 'RecordGroup "Mens" must be one of: Men, Women.',
        mutate: async root => {
            const lines = await readAbsoluteRecords(root);
            lines[1] = replaceCsvField(lines[1], 1, 'Mens');
            await writeAbsoluteRecords(root, lines);
        }
    },
    {
        name: 'RecordGroup disagreeing with Sex',
        expected: 'RecordGroup "Women" must match Sex "Men".',
        mutate: async root => {
            const lines = await readAbsoluteRecords(root);
            lines[1] = replaceCsvField(lines[1], 1, 'Women');
            await writeAbsoluteRecords(root, lines);
        }
    },
    {
        name: 'absolute records exported out of contracted order',
        expected: 'Expected the Men Marathon record here, found "Men Half Marathon".',
        mutate: async root => {
            const lines = await readAbsoluteRecords(root);
            [lines[1], lines[2]] = [lines[2], lines[1]];
            await writeAbsoluteRecords(root, lines);
        }
    },
    {
        name: 'non-increasing absolute record SortOrder',
        expected: "SortOrder 5 must be greater than the previous row's 10.",
        mutate: async root => {
            const lines = await readAbsoluteRecords(root);
            lines[2] = replaceCsvField(lines[2], 0, '5');
            await writeAbsoluteRecords(root, lines);
        }
    },
    {
        name: 'duplicate absolute record SortOrder',
        expected: 'Duplicate SortOrder 10',
        mutate: async root => {
            const lines = await readAbsoluteRecords(root);
            lines[2] = replaceCsvField(lines[2], 0, '10');
            await writeAbsoluteRecords(root, lines);
        }
    },
    {
        name: 'absolute record ResultDistance for another distance',
        expected: 'ResultDistance "5 km" is not the same distance as Distance "Marathon".',
        mutate: async root => {
            const lines = await readAbsoluteRecords(root);
            lines[1] = replaceCsvField(lines[1], 5, '5 km');
            await writeAbsoluteRecords(root, lines);
        }
    },
    {
        name: 'duplicate absolute RecordTitle',
        expected: 'Duplicate RecordTitle "Men\'s Marathon record"',
        mutate: async root => {
            const lines = await readAbsoluteRecords(root);
            lines[2] = replaceCsvField(lines[2], 2, "Men's Marathon record");
            await writeAbsoluteRecords(root, lines);
        }
    },
    // "No eligible result" is a real exported state, not a defect. The matrix
    // rules above must not turn a legitimately vacant record into a failure.
    {
        name: 'vacant absolute record still validates',
        expectPass: true,
        mutate: async root => {
            const lines = await readAbsoluteRecords(root);
            let vacated = lines[5];

            vacated = replaceCsvField(vacated, 6, 'No eligible result');
            for (const fieldIndex of [7, 8, 9, 10, 12, 13, 14]) {
                vacated = replaceCsvField(vacated, fieldIndex, '');
            }

            lines[5] = vacated;
            await writeAbsoluteRecords(root, lines);
        }
    }
];

for (const testCase of cases) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'family-running-bundle-test-'));

    try {
        await fs.cp(sourceData, path.join(root, 'data'), { recursive: true });
        await testCase.mutate(root);
        const result = await runValidator(root);
        const output = `${result.stdout}\n${result.stderr}`;

        if (testCase.expectPass) {
            if (result.code !== 0) {
                throw new Error(`${testCase.name}: validator unexpectedly failed.\n${output}`);
            }
        } else {
            if (result.code === 0) {
                throw new Error(`${testCase.name}: validator unexpectedly passed.`);
            }
            if (!output.includes(testCase.expected)) {
                throw new Error(
                    `${testCase.name}: expected output containing "${testCase.expected}".\n${output}`
                );
            }
        }

        console.log(`PASS - ${testCase.name}`);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
}

console.log('Export bundle validation regression tests passed.');

function splitLines(text) {
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd().split('\n');
}

function replaceCsvField(line, index, value) {
    const fields = line.split(',');
    fields[index] = value;
    return fields.join(',');
}

function absoluteRecordsPath(root) {
    return path.join(root, 'data', 'family', 'absolute_records.csv');
}

async function readAbsoluteRecords(root) {
    return splitLines(await fs.readFile(absoluteRecordsPath(root), 'utf8'));
}

async function writeAbsoluteRecords(root, lines) {
    await fs.writeFile(absoluteRecordsPath(root), `${lines.join('\r\n')}\r\n`);
}

// Adding or removing a record row also changes the manifest's contracted row
// count, so keep them in step. Otherwise a matrix test would fail on the row
// count instead of the rule it exists to prove.
async function setManifestRowCount(root, relativePath, count) {
    const file = path.join(root, 'data', 'export_manifest.csv');
    const lines = splitLines(await fs.readFile(file, 'utf8'));
    const rowIndex = lines.findIndex(line => line.includes(`,${relativePath},`));

    if (rowIndex < 0) {
        throw new Error(`Could not find ${relativePath} in the export manifest.`);
    }

    lines[rowIndex] = lines[rowIndex].replace(/\d+$/, String(count));
    await fs.writeFile(file, `${lines.join('\r\n')}\r\n`);
}

function runValidator(validationRoot) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [validatorPath], {
            cwd: repoRoot,
            env: {
                ...process.env,
                CSV_VALIDATION_ROOT: validationRoot
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';

        child.stdout.on('data', chunk => {
            stdout += chunk;
        });
        child.stderr.on('data', chunk => {
            stderr += chunk;
        });
        child.on('error', reject);
        child.on('exit', code => resolve({ code, stdout, stderr }));
    });
}
