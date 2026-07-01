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
            lines[0] = lines[0].replace(',pace_per_mile', '');
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
    }
];

for (const testCase of cases) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'family-running-bundle-test-'));

    try {
        await fs.cp(sourceData, path.join(root, 'data'), { recursive: true });
        await testCase.mutate(root);
        const result = await runValidator(root);
        const output = `${result.stdout}\n${result.stderr}`;

        if (result.code === 0) {
            throw new Error(`${testCase.name}: validator unexpectedly passed.`);
        }
        if (!output.includes(testCase.expected)) {
            throw new Error(
                `${testCase.name}: expected output containing "${testCase.expected}".\n${output}`
            );
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
