import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
    assertExactTrackedCsvSet,
    compareBundles,
    normalizePnpmPathArgument,
    parseCliArguments,
    repoRoot,
    resolveStagedRoot,
    runCsvValidator
} from './export-bundle-tools.mjs';

try {
    const options = parseCliArguments(process.argv.slice(2));
    const stagedRoot = resolveStagedRoot(
        normalizePnpmPathArgument(options.get('staged'))
    );

    if (!options.has('approve')) {
        throw new Error(
            'Promotion requires --approve after validation and human review.'
        );
    }

    assertExactTrackedCsvSet(stagedRoot);
    requireCleanTrackedData();

    const validation = runCsvValidator(stagedRoot);

    if (validation.status !== 0) {
        process.stderr.write(validation.stdout || '');
        process.stderr.write(validation.stderr || '');
        throw new Error('Promotion refused because the staged bundle is invalid.');
    }

    const comparison = compareBundles(stagedRoot);

    if (
        comparison.meaningfulDifferences.length > 0 &&
        !options.has('approve-differences')
    ) {
        throw new Error(
            'Meaningful differences require review and --approve-differences.'
        );
    }

    promoteDataDirectory(stagedRoot);
} catch (error) {
    console.error(`Staged export promotion failed: ${error.message}`);
    process.exit(1);
}

function requireCleanTrackedData() {
    const result = spawnSync(
        findGit(),
        ['status', '--porcelain', '--', 'data'],
        {
            cwd: repoRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe']
        }
    );

    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(result.stderr.trim() || 'Could not inspect tracked data status.');
    }
    if (result.stdout.trim()) {
        throw new Error('Tracked data has local changes; promotion is unsafe.');
    }
}

function findGit() {
    const runtimeGit = process.env.USERPROFILE
        ? path.join(
            process.env.USERPROFILE,
            '.cache',
            'codex-runtimes',
            'codex-primary-runtime',
            'dependencies',
            'native',
            'git',
            'cmd',
            'git.exe'
        )
        : '';
    const candidates = [
        process.env.GIT_BIN,
        'git',
        'C:\\Program Files\\Git\\cmd\\git.exe',
        runtimeGit
    ].filter(Boolean);

    for (const candidate of candidates) {
        const result = spawnSync(candidate, ['--version'], {
            cwd: repoRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        });

        if (!result.error && result.status === 0) {
            return candidate;
        }
    }

    throw new Error('Git is required to verify that tracked data is clean.');
}

function promoteDataDirectory(stagedRoot) {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
    const operationRoot = path.join(
        repoRoot,
        'test-artifacts',
        'workbook-export-promotion',
        stamp
    );
    const candidateRoot = path.join(operationRoot, 'candidate');
    const candidateData = path.join(candidateRoot, 'data');
    const backupData = path.join(operationRoot, 'previous-data');
    const trackedData = path.join(repoRoot, 'data');
    let movedTrackedData = false;

    fs.mkdirSync(candidateRoot, { recursive: true });
    fs.cpSync(path.join(stagedRoot, 'data'), candidateData, { recursive: true });

    const candidateValidation = runCsvValidator(candidateRoot);

    if (candidateValidation.status !== 0) {
        throw new Error('The isolated promotion candidate failed validation.');
    }

    try {
        fs.renameSync(trackedData, backupData);
        movedTrackedData = true;
        fs.renameSync(candidateData, trackedData);
    } catch (error) {
        if (movedTrackedData && !fs.existsSync(trackedData) && fs.existsSync(backupData)) {
            fs.renameSync(backupData, trackedData);
        }
        throw error;
    }

    console.log(`Validated staged bundle promoted to ${trackedData}`);
    console.log(`Previous tracked data retained locally at ${backupData}`);
}
