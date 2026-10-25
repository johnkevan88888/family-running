import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findGit, parseUpdateArguments } from './simple-data-update.mjs';
import {
    readUpdateWorkspaceContext, requirePhysicalDirectory, updateHomeVariable, workspacePaths
} from './data-update-context.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateRelativePath = 'test-artifacts/simple-data-update/latest.json';
const lockRelativePath = 'test-artifacts/data-update-launcher.lock';

export function createCommandRunner(git) {
    return (root, args, { executable = git, inherit = false, env = process.env } = {}) => {
        const result = spawnSync(executable, args, {
            cwd: root, env, encoding: 'utf8', windowsHide: true,
            stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
            maxBuffer: 100 * 1024 * 1024
        });
        if (result.error || result.status !== 0) {
            throw new Error(`Data updater command failed (${args[0]}): ${result.error?.message ||
                result.stderr?.trim() || `exit ${result.status ?? result.signal}`}`);
        }
        return result.stdout || '';
    };
}

export function findUpdateHome(root, run) {
    const common = path.resolve(run(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
    requirePhysicalDirectory(common);
    if (path.basename(common) !== '.git') throw new Error('The updater requires a normal primary Git checkout.');
    const homeRoot = path.dirname(common);
    requirePhysicalDirectory(homeRoot);
    const actual = run(homeRoot, ['rev-parse', '--show-toplevel']).trim();
    if (path.resolve(actual).toLowerCase() !== path.resolve(homeRoot).toLowerCase()) {
        throw new Error('Could not verify the primary updater checkout.');
    }
    return homeRoot;
}

export function acquireUpdateLock(homeRoot) {
    const lockPath = path.join(homeRoot, lockRelativePath);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    requirePhysicalDirectory(path.dirname(lockPath));
    const identity = JSON.stringify({ pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString() });
    try {
        fs.writeFileSync(lockPath, identity, { flag: 'wx' });
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        throw new Error('Another data-updater invocation holds the workspace lock. ' +
            `Finish that run first. If its window was forcibly closed, retain ${lockPath} ` +
            'and ask for recovery after checking that no updater or Excel export is still running.');
    }
    return () => {
        if (fs.readFileSync(lockPath, 'utf8') !== identity) {
            throw new Error('The updater lock changed; it was retained for inspection.');
        }
        fs.unlinkSync(lockPath);
    };
}

export function ensureUpdateWorkspace(homeRoot, run, { resume = false } = {}) {
    requirePhysicalDirectory(homeRoot);
    const { workspaceRoot, markerPath } = workspacePaths(homeRoot);
    const env = { ...process.env, [updateHomeVariable]: homeRoot };
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    requirePhysicalDirectory(path.dirname(markerPath));
    if (!fs.existsSync(markerPath)) {
        if (resume) throw new Error('No saved isolated update exists to resume.');
        if (fs.existsSync(workspaceRoot)) throw new Error('The updater workspace already exists without its ownership record; it was left untouched.');
        fs.writeFileSync(markerPath, JSON.stringify({ version: 1, homeRoot, workspaceRoot }, null, 2) + '\n', { flag: 'wx' });
    }
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (marker.version !== 1 || marker.homeRoot !== homeRoot || marker.workspaceRoot !== workspaceRoot) {
        throw new Error('The saved updater workspace identity is invalid.');
    }
    if (!fs.existsSync(workspaceRoot)) {
        if (resume) throw new Error('The saved updater workspace is missing; no replacement was created.');
        run(homeRoot, ['fetch', '--no-tags', 'origin', 'main']);
        const base = run(homeRoot, ['rev-parse', 'FETCH_HEAD']).trim();
        requireSha(base);
        run(homeRoot, ['worktree', 'add', '--detach', workspaceRoot, base]);
    }
    readUpdateWorkspaceContext(workspaceRoot, env);
    const savedState = fs.existsSync(path.join(workspaceRoot, stateRelativePath));
    if (resume) {
        if (!savedState) throw new Error('No saved data update exists. Start normally without --resume.');
    } else {
        if (savedState) throw new Error('A data update is already saved. Run update-website-data.cmd --resume.');
        const status = run(workspaceRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
        if (status.trim()) throw new Error(`The updater's own workspace has unfinished changes: ${workspaceRoot}. They were retained; unrelated edits in your normal folder are allowed.`);
        const branch = run(workspaceRoot, ['branch', '--show-current']).trim();
        if (branch) throw new Error(`The updater workspace is on unexpected branch ${branch}; it was left untouched.`);
        run(workspaceRoot, ['fetch', '--no-tags', 'origin', 'main']);
        const base = run(workspaceRoot, ['rev-parse', 'FETCH_HEAD']).trim();
        requireSha(base);
        run(workspaceRoot, ['switch', '--detach', base]);
    }
    // Do not run an older engine that would try to switch or update shared main.
    const engine = fs.readFileSync(path.join(workspaceRoot, 'scripts/simple-data-update.mjs'), 'utf8');
    if (!engine.includes('ISOLATED_DATA_UPDATE_ENGINE_VERSION = 1')) {
        throw new Error('The isolated updater is not yet available on main. Release this tooling change before starting a new isolated update.');
    }
    return { workspaceRoot, env };
}

export function runIsolatedUpdate({ root = sourceRoot, argv = process.argv.slice(2), run,
    callerCwd = process.cwd(), installDependencies = installWorkspaceDependencies,
    execute = executeEngine, log = console.log }) {
    const options = parseUpdateArguments(argv);
    if (options.help) return execute(root, argv, process.env, run);
    if (process.env[updateHomeVariable] !== undefined) {
        throw new Error('Run the normal launcher from outside the updater workspace.');
    }
    const homeRoot = findUpdateHome(root, run);
    const releaseLock = acquireUpdateLock(homeRoot);
    try {
        const legacyState = fs.existsSync(path.join(homeRoot, stateRelativePath));
        const { workspaceRoot } = workspacePaths(homeRoot);
        const isolatedState = fs.existsSync(path.join(workspaceRoot, stateRelativePath));
        if (legacyState) {
            if (isolatedState) throw new Error('Both legacy and isolated updates exist. Neither was changed; reconcile the saved updates first.');
            if (!options.resume) throw new Error('An earlier data update is saved in the original folder. Finish it with --resume before starting an isolated update.');
            log('Resuming the earlier update in its original folder. New updates will use an isolated workspace.');
            return execute(homeRoot, argv, process.env, run);
        }
        const workspace = ensureUpdateWorkspace(homeRoot, run, options);
        log(`Data update workspace: ${workspace.workspaceRoot}`);
        log('Your normal folder, its branch, and its pending edits stay in place.');
        installDependencies(workspace.workspaceRoot, run);
        // Resolve a caller-supplied relative workbook path before changing cwd.
        const childArguments = argv.slice();
        const workbookIndex = childArguments.indexOf('--workbook');
        if (workbookIndex !== -1) childArguments[workbookIndex + 1] = path.resolve(callerCwd, options.workbookPath);
        return execute(workspace.workspaceRoot, childArguments, workspace.env, run);
    } finally {
        releaseLock();
    }
}

export function workspaceDependencyCommand({ platform = process.platform, env = process.env,
    exists = fs.existsSync, nodeExecutable = process.execPath } = {}) {
    const args = ['install', '--frozen-lockfile', '--ignore-scripts'];
    const suppliedCli = env.npm_execpath;
    if (suppliedCli && /^pnpm\.(?:cjs|mjs|js)$/.test(path.basename(suppliedCli)) && exists(suppliedCli)) {
        return { executable: nodeExecutable, args: [suppliedCli, ...args], env };
    }
    // The desktop launcher intentionally does not require pnpm on Explorer's
    // PATH. Use the same bundled CLI as Codex's pnpm.cmd fallback, without shell
    // interpolation of the user's home path.
    const bundledCli = env.USERPROFILE && path.join(env.USERPROFILE, '.cache', 'codex-runtimes',
        'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs');
    if (platform === 'win32' && bundledCli && exists(bundledCli)) {
        return { executable: nodeExecutable, args: [bundledCli, ...args],
            env: { ...env, pnpm_config_pm_on_fail: 'ignore' } };
    }
    return { executable: platform === 'win32' ? 'cmd.exe' : 'pnpm',
        args: platform === 'win32' ? ['/d', '/c', 'pnpm', ...args] : args, env };
}

function installWorkspaceDependencies(root, run) {
    console.log('Preparing the updater dependencies from its exact lockfile...');
    const command = workspaceDependencyCommand();
    run(root, command.args, { executable: command.executable, env: command.env, inherit: true });
}

function executeEngine(root, argv, env, run) {
    return run(root, [path.join(root, 'scripts/simple-data-update.mjs'), ...argv], {
        executable: process.execPath, inherit: true, env
    });
}

function requireSha(sha) {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('The fetched production commit is invalid.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        if (process.platform !== 'win32' && !parseUpdateArguments(process.argv.slice(2)).help) {
            throw new Error('The guided workbook update currently requires Windows and Microsoft Excel.');
        }
        runIsolatedUpdate({ run: createCommandRunner(findGit()) });
    } catch (error) {
        console.error(`\nSimple data update stopped: ${error.message}`);
        process.exitCode = 1;
    }
}
