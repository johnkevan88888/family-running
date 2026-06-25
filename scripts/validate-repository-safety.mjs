import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const trackedFiles = listTrackedFiles();
const problems = [];

for (const file of trackedFiles) {
    const normalized = file.replace(/\\/g, '/');
    const basename = path.basename(normalized);
    const lowerName = basename.toLowerCase();
    const lowerPath = normalized.toLowerCase();

    if (/\.(xlsm|xlsx|xls|xlsb)$/i.test(basename)) {
        problems.push(`${file}: tracked Excel workbook file is not allowed`);
    }

    if (basename.startsWith('~$')) {
        problems.push(`${file}: tracked Excel temporary file is not allowed`);
    }

    if (isCredentialLikeFile(lowerName, lowerPath)) {
        problems.push(`${file}: tracked credential-like file is not allowed`);
    }

    if (isWorkbookBackupLikeFile(lowerName, lowerPath)) {
        problems.push(`${file}: tracked private workbook backup-like file is not allowed`);
    }
}

if (problems.length) {
    console.error('Repository safety validation failed:');
    for (const problem of problems) {
        console.error(`- ${problem}`);
    }
    process.exit(1);
}

console.log(`Repository safety validation passed (${trackedFiles.length} tracked files checked).`);

function listTrackedFiles() {
    const git = findGit();

    if (!git) {
        console.error('Repository safety validation could not find Git. Install Git or set GIT_BIN to the Git executable.');
        process.exit(1);
    }

    try {
        const output = execFileSync(git, ['ls-files', '-z'], {
            cwd: repoRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe']
        });

        return output.split('\0').filter(Boolean);
    } catch (error) {
        console.error('Repository safety validation could not list tracked files with Git.');
        console.error(String(error.stderr || error.message || error));
        process.exit(1);
    }
}

function findGit() {
    const candidates = [
        process.env.GIT_BIN,
        'git',
        'C:\\Program Files\\Git\\cmd\\git.exe',
        'C:\\Program Files\\Git\\bin\\git.exe',
        'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
        process.env.USERPROFILE
            ? path.join(process.env.USERPROFILE, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'native', 'git', 'cmd', 'git.exe')
            : '',
        ...githubDesktopGitCandidates()
    ].filter(Boolean);

    for (const candidate of candidates) {
        try {
            execFileSync(candidate, ['--version'], {
                cwd: repoRoot,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            });
            return candidate;
        } catch {
            // Try the next candidate.
        }
    }

    return null;
}

function githubDesktopGitCandidates() {
    if (os.platform() !== 'win32' || !process.env.LOCALAPPDATA) {
        return [];
    }

    const desktopRoot = path.join(process.env.LOCALAPPDATA, 'GitHubDesktop');

    try {
        return fs.readdirSync(desktopRoot)
            .filter(entry => entry.startsWith('app-'))
            .map(entry => path.join(desktopRoot, entry, 'resources', 'app', 'git', 'cmd', 'git.exe'));
    } catch {
        return [];
    }
}

function isCredentialLikeFile(lowerName, lowerPath) {
    return [
        lowerName === '.env',
        /^\.env\.(local|production|prod|private|secret)$/.test(lowerName),
        /(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/.test(lowerPath),
        /\.(pem|key|p12|pfx)$/i.test(lowerName),
        lowerName === 'credentials.json',
        /^client_secret.*\.json$/.test(lowerName),
        /^service[-_]?account.*\.json$/.test(lowerName),
        /^secrets?\./.test(lowerName),
        /password/.test(lowerName),
        /private[-_]?key/.test(lowerName)
    ].some(Boolean);
}

function isWorkbookBackupLikeFile(lowerName, lowerPath) {
    const backupExtension = /\.(bak|backup|old|tmp|zip|7z|rar)$/i.test(lowerName);
    const workbookWords = /(workbook|spreadsheet|excel|family[-_ ]?running|championship|results)/.test(lowerPath);
    const backupWords = /(backup|copy|private|local|source[-_ ]?of[-_ ]?truth)/.test(lowerPath);

    return backupExtension && workbookWords && backupWords;
}
