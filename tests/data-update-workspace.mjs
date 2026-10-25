import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
    acquireUpdateLock, createCommandRunner, ensureUpdateWorkspace, findUpdateHome, runIsolatedUpdate,
    workspaceDependencyCommand
} from '../scripts/data-update.mjs';
import {
    readUpdateWorkspaceContext, requirePhysicalDirectory, updateHomeVariable, workspacePaths
} from '../scripts/data-update-context.mjs';
import { completedUpdateCheckoutArguments, findGit, requireIsolatedPreparationBase } from '../scripts/simple-data-update.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'data-update-isolation-')));
const git = findGit();
const run = createCommandRunner(git);
let passed = 0;
const priorContext = process.env[updateHomeVariable];
delete process.env[updateHomeVariable];
const write = (root, file, value) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), value);
};
function fixture() {
    const root = fs.mkdtempSync(path.join(tempRoot, 'repo-'));
    run(root, ['init', '-b', 'main']);
    run(root, ['config', 'user.email', 'synthetic@example.invalid']);
    run(root, ['config', 'user.name', 'Synthetic updater test']);
    run(root, ['config', 'core.autocrlf', 'false']);
    write(root, '.gitignore', 'test-artifacts/\nnode_modules/\n');
    write(root, 'docs/notes.md', 'released notes\n');
    write(root, 'page.js', 'released source\n');
    write(root, 'data/public.csv', 'released,data\n');
    write(root, 'scripts/simple-data-update.mjs', 'export const ISOLATED_DATA_UPDATE_ENGINE_VERSION = 1;\n');
    fs.copyFileSync(path.join(sourceRoot, 'scripts/data-update-context.mjs'), path.join(root, 'scripts/data-update-context.mjs'));
    for (const file of ['export-bundle-tools.mjs', 'run-workbook-staged-export.ps1']) {
        fs.copyFileSync(path.join(sourceRoot, 'scripts', file), path.join(root, 'scripts', file));
    }
    run(root, ['add', '.']);
    run(root, ['commit', '-m', 'Synthetic release']);
    // A separate bare origin proves fetch/switch use released data, not edits.
    const remote = root + '-origin.git';
    run(root, ['clone', '--bare', root, remote]);
    run(root, ['remote', 'add', 'origin', remote]);
    return root;
}
function snapshot(root) {
    return {
        branch: run(root, ['branch', '--show-current']), head: run(root, ['rev-parse', 'HEAD']),
        status: run(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
        index: run(root, ['diff', '--cached', '--binary']), diff: run(root, ['diff', '--binary']),
        files: Object.fromEntries(['docs/notes.md', 'page.js', 'data/public.csv', 'untracked.txt']
            .filter(file => fs.existsSync(path.join(root, file)))
            .map(file => [file, fs.readFileSync(path.join(root, file)).toString('base64')]))
    };
}
function test(name, body) {
    body(); passed++; console.log(`PASS ${name}`);
}
function workspace(root, options) { return ensureUpdateWorkspace(root, run, options); }
function state(root) { return path.join(root, 'test-artifacts/simple-data-update/latest.json'); }
function saveState(root, value = { phase: 'prepared' }) { write(root, 'test-artifacts/simple-data-update/latest.json', JSON.stringify(value)); }
const noInstall = () => {};

try {
    test('main movement during dependency setup stops before workbook access and requires fresh code', () => {
        assert.doesNotThrow(() => requireIsolatedPreparationBase('a'.repeat(40), 'a'.repeat(40), true));
        assert.throws(() => requireIsolatedPreparationBase('a'.repeat(40), 'b'.repeat(40), true), /No workbook was opened/);
        assert.doesNotThrow(() => requireIsolatedPreparationBase('a'.repeat(40), 'b'.repeat(40), false));
    });
    test('desktop dependency setup works without pnpm on PATH and keeps the frozen lock', () => {
        const command = workspaceDependencyCommand({ platform: 'win32',
            env: { USERPROFILE: 'C:\\User With Spaces' }, exists: () => true, nodeExecutable: 'node-test' });
        assert.equal(command.executable, 'node-test');
        assert.match(command.args[0], /pnpm[\\/]bin[\\/]pnpm\.mjs$/);
        assert.deepEqual(command.args.slice(1), ['install', '--frozen-lockfile', '--ignore-scripts']);
        const fallback = workspaceDependencyCommand({ platform: 'win32', env: {}, exists: () => false });
        assert.deepEqual(fallback.args, ['/d', '/c', 'pnpm', 'install', '--frozen-lockfile', '--ignore-scripts']);
    });
    test('dirty documents, source, data, staged edits and untracked files stay byte-identical', () => {
        const root = fixture();
        write(root, 'docs/notes.md', 'pending notes\n');
        run(root, ['add', 'docs/notes.md']);
        write(root, 'docs/notes.md', 'staged plus unstaged notes\n');
        write(root, 'page.js', 'unfinished source\n');
        write(root, 'data/public.csv', 'unapproved,data\n');
        write(root, 'untracked.txt', 'keep me\n');
        const before = snapshot(root);
        let calls = 0;
        runIsolatedUpdate({ root, argv: ['--prepare-only'], run, installDependencies: noInstall, log: () => {},
            execute: (child, argv, env) => {
                calls++;
                assert.notEqual(child, root);
                assert.deepEqual(argv, ['--prepare-only']);
                assert.equal(fs.readFileSync(path.join(child, 'docs/notes.md'), 'utf8'), 'released notes\n');
                assert.equal(fs.readFileSync(path.join(child, 'page.js'), 'utf8'), 'released source\n');
                assert.equal(fs.readFileSync(path.join(child, 'data/public.csv'), 'utf8'), 'released,data\n');
                assert.equal(fs.existsSync(path.join(child, 'untracked.txt')), false);
                assert.equal(run(child, ['status', '--porcelain']).trim(), '');
                assert.equal(readUpdateWorkspaceContext(child, env).homeRoot, root);
            }
        });
        assert.equal(calls, 1);
        assert.deepEqual(snapshot(root), before);
    });
    test('launch from another worktree resolves primary home without changing either branch', () => {
        const root = fixture();
        const other = root + '-feature';
        run(root, ['worktree', 'add', '-b', 'feature', other, 'HEAD']);
        write(other, 'page.js', 'feature in progress');
        assert.equal(findUpdateHome(other, run), root);
        const before = snapshot(other);
        runIsolatedUpdate({ root: other, argv: [], run, installDependencies: noInstall, execute: () => {}, log: () => {} });
        assert.deepEqual(snapshot(other), before);
        assert.equal(run(root, ['branch', '--show-current']).trim(), 'main');
    });
    test('unresolved source merge in the primary checkout remains untouched', () => {
        const root = fixture();
        run(root, ['switch', '-c', 'unfinished-feature']); write(root, 'page.js', 'feature\n');
        run(root, ['add', 'page.js']); run(root, ['commit', '-m', 'Feature edit']);
        run(root, ['switch', 'main']); write(root, 'page.js', 'main edit\n');
        run(root, ['add', 'page.js']); run(root, ['commit', '-m', 'Conflicting edit']);
        assert.throws(() => run(root, ['merge', 'unfinished-feature']), /failed/);
        const before = snapshot(root); const mergeHead = fs.readFileSync(path.join(root, '.git/MERGE_HEAD'));
        runIsolatedUpdate({ root, argv: [], run, installDependencies: noInstall, execute: () => {}, log: () => {} });
        assert.deepEqual(snapshot(root), before);
        assert.deepEqual(fs.readFileSync(path.join(root, '.git/MERGE_HEAD')), mergeHead);
    });
    test('new main is used even when main checkout has overlapping pending notes', () => {
        const root = fixture();
        const first = workspace(root);
        const old = run(first.workspaceRoot, ['rev-parse', 'HEAD']);
        write(root, 'docs/notes.md', 'new released notes\n');
        run(root, ['add', 'docs/notes.md']); run(root, ['commit', '-m', 'New release']); run(root, ['push', 'origin', 'main']);
        write(root, 'docs/notes.md', 'keep my unfinished notes\n');
        const before = snapshot(root);
        const next = workspace(root);
        assert.notEqual(run(next.workspaceRoot, ['rev-parse', 'HEAD']), old);
        assert.equal(fs.readFileSync(path.join(next.workspaceRoot, 'docs/notes.md'), 'utf8'), 'new released notes\n');
        assert.deepEqual(snapshot(root), before);
    });
    test('resume preserves exact state, promoted files and branch; fresh run refuses overlap', () => {
        const root = fixture(); const { workspaceRoot: child } = workspace(root);
        run(child, ['switch', '-c', 'data/refresh-20261025-150000']);
        write(child, 'data/public.csv', 'promoted,data\n'); saveState(child, { phase: 'promoted', exact: 'bundle' });
        const before = snapshot(child); const saved = fs.readFileSync(state(child));
        assert.throws(() => workspace(root), /already saved/);
        let called = false;
        runIsolatedUpdate({ root, argv: ['--resume'], run, installDependencies: noInstall, log: () => {},
            execute: (actual, argv) => { called = true; assert.equal(actual, child); assert.deepEqual(argv, ['--resume']); }
        });
        assert(called); assert.deepEqual(snapshot(child), before); assert.deepEqual(fs.readFileSync(state(child)), saved);
    });
    test('legacy resume stays in original checkout and never installs or opens another update', () => {
        const root = fixture(); saveState(root); write(root, 'data/public.csv', 'legacy promoted data');
        const before = snapshot(root); let called = false;
        assert.throws(() => runIsolatedUpdate({ root, argv: [], run, execute: () => assert.fail(), installDependencies: () => assert.fail() }), /earlier data update/);
        runIsolatedUpdate({ root, argv: ['--resume'], run, installDependencies: () => assert.fail(), log: () => {},
            execute: (child, argv, env) => { called = true; assert.equal(child, root); assert.equal(env[updateHomeVariable], undefined); }
        });
        assert(called); assert.deepEqual(snapshot(root), before);
        assert.equal(fs.existsSync(workspacePaths(root).workspaceRoot), false);
    });
    test('dual legacy/isolated state refuses without executing either', () => {
        const root = fixture(); const { workspaceRoot: child } = workspace(root); saveState(child); saveState(root);
        assert.throws(() => runIsolatedUpdate({ root, argv: ['--resume'], run, execute: () => assert.fail(), installDependencies: noInstall }), /Both legacy and isolated/);
    });
    test('a missing resume never creates a replacement workspace', () => {
        const root = fixture(); assert.throws(() => workspace(root, { resume: true }), /No saved isolated/);
        assert.equal(fs.existsSync(workspacePaths(root).workspaceRoot), false);
        workspace(root); assert.throws(() => workspace(root, { resume: true }), /without --resume/);
    });
    test('unfinished worker edits, staged files and untracked files remain blockers', () => {
        for (const kind of ['tracked', 'staged', 'untracked']) {
            const root = fixture(); const { workspaceRoot: child } = workspace(root);
            write(child, kind === 'untracked' ? 'untracked.txt' : 'page.js', 'unexpected changes');
            if (kind === 'staged') run(child, ['add', 'page.js']);
            const before = snapshot(child);
            assert.throws(() => workspace(root), /own workspace has unfinished/);
            assert.deepEqual(snapshot(child), before);
        }
    });
    test('unexpected worker branch is not detached or deleted', () => {
        const root = fixture(); const { workspaceRoot: child } = workspace(root);
        run(child, ['switch', '-c', 'someone-elses-work']);
        assert.throws(() => workspace(root), /unexpected branch/);
        assert.equal(run(child, ['branch', '--show-current']).trim(), 'someone-elses-work');
    });
    test('pre-existing directory and modified ownership record are refused', () => {
        const root = fixture(); const paths = workspacePaths(root); fs.mkdirSync(paths.workspaceRoot, { recursive: true });
        write(paths.workspaceRoot, 'keep.txt', 'preserve');
        assert.throws(() => workspace(root), /without its ownership/);
        assert.equal(fs.readFileSync(path.join(paths.workspaceRoot, 'keep.txt'), 'utf8'), 'preserve');
        const next = fixture(); workspace(next); const marker = workspacePaths(next).markerPath;
        fs.writeFileSync(marker, JSON.stringify({ version: 1, homeRoot: root, workspaceRoot: paths.workspaceRoot }));
        assert.throws(() => workspace(next), /identity is invalid/);
    });
    test('context rejects absent, wrong, relative, traversal and cross-repository homes', () => {
        const root = fixture(); const { workspaceRoot: child, env } = workspace(root);
        assert.equal(readUpdateWorkspaceContext(child, {}), null);
        for (const home of ['', '.', path.join(root, 'docs'), root + path.sep + '..' + path.sep + path.basename(root), fixture()]) {
            assert.throws(() => readUpdateWorkspaceContext(child, { [updateHomeVariable]: home }));
        }
        assert.throws(() => readUpdateWorkspaceContext(root, env), /outside its recorded/);
    });
    test('physical directory gate rejects directory junctions', () => {
        const root = fixture(); const link = root + '-link';
        fs.symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
        assert.throws(() => requirePhysicalDirectory(link), /symbolic links or junctions/);
    });
    test('reciprocal Git registration is required', () => {
        const root = fixture(); const { workspaceRoot: child, env } = workspace(root);
        const gitdir = fs.readFileSync(path.join(child, '.git'), 'utf8').trim().slice(8);
        const back = path.join(gitdir, 'gitdir'); const original = fs.readFileSync(back);
        fs.writeFileSync(back, path.join(root, '.git'));
        assert.throws(() => readUpdateWorkspaceContext(child, env), /different Git repository or registration/);
        fs.writeFileSync(back, original);
    });
    test('context command used by PowerShell returns only the canonical export home', () => {
        const root = fixture(); const { workspaceRoot: child, env } = workspace(root);
        const result = spawnSync(process.execPath, [path.join(child, 'scripts/data-update-context.mjs')], { env, encoding: 'utf8', windowsHide: true });
        assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), root);
    });
    test('isolated staged-path gate uses only the primary workbook staging parent', () => {
        const root = fixture(); const { workspaceRoot: child, env } = workspace(root);
        const staged = path.join(root, 'test-artifacts/workbook-export-staging/run-synthetic');
        write(staged, 'data/export_manifest.csv', 'synthetic manifest\n');
        const localStaged = path.join(child, 'test-artifacts/workbook-export-staging/run-wrong');
        write(localStaged, 'data/export_manifest.csv', 'synthetic manifest\n');
        const script = `import assert from 'node:assert/strict';
            import { stagingParent, resolveStagedRoot } from './scripts/export-bundle-tools.mjs';
            assert.equal(stagingParent, ${JSON.stringify(path.dirname(staged))});
            assert.equal(resolveStagedRoot(${JSON.stringify(staged)}), ${JSON.stringify(staged)});
            assert.throws(() => resolveStagedRoot(${JSON.stringify(localStaged)}), /immediate child/);`;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: child, env, encoding: 'utf8', windowsHide: true });
        assert.equal(result.status, 0, result.stderr);
    });
    if (process.platform === 'win32') test('PowerShell verifies isolated context before the nonexistent fictional workbook check', () => {
        const root = fixture(); const { workspaceRoot: child, env } = workspace(root);
        const fictionalWorkbook = path.join(tempRoot, 'nonexistent-fictional-workbook.xlsm');
        assert.equal(fs.existsSync(fictionalWorkbook), false);
        const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(child, 'scripts/run-workbook-staged-export.ps1'),
            '-NodeExecutable', process.execPath, '-WorkbookPath', fictionalWorkbook,
            '-ExpectedContractSignature', 'synthetic-signature', '-PreflightOnly'];
        const validContext = spawnSync('powershell.exe', args, { cwd: child, env, encoding: 'utf8', windowsHide: true });
        assert.notEqual(validContext.status, 0);
        assert.match(validContext.stderr, /Private workbook not found/);
        const invalidContext = spawnSync('powershell.exe', args, { cwd: child,
            env: { ...env, [updateHomeVariable]: tempRoot }, encoding: 'utf8', windowsHide: true });
        assert.notEqual(invalidContext.status, 0);
        assert.match(invalidContext.stderr, /context could not be verified/);
        assert.doesNotMatch(invalidContext.stderr, /Private workbook not found/);
    });
    test('relative explicit workbook argument remains relative to the caller', () => {
        const root = fixture(); let called = false;
        runIsolatedUpdate({ root, callerCwd: root, argv: ['--prepare-only', '--workbook', '../fictional.xlsm'], run, installDependencies: noInstall, log: () => {},
            execute: (child, argv) => { called = true; assert.equal(argv[2], path.resolve(root, '../fictional.xlsm')); }
        }); assert(called);
    });
    test('dependency or engine failure retains workspace and releases launcher lock', () => {
        for (const step of ['install', 'execute']) {
            const root = fixture(); const before = snapshot(root);
            assert.throws(() => runIsolatedUpdate({ root, argv: [], run, log: () => {},
                installDependencies: () => { if (step === 'install') throw new Error('synthetic install failure'); },
                execute: child => { saveState(child); throw new Error('synthetic engine failure'); }
            }), /synthetic/);
            assert.deepEqual(snapshot(root), before);
            assert.equal(fs.existsSync(workspacePaths(root).workspaceRoot), true);
            const release = acquireUpdateLock(root); release();
        }
    });
    test('another invocation cannot acquire the same lock or disturb its contents', () => {
        const root = fixture(); const release = acquireUpdateLock(root);
        assert.throws(() => acquireUpdateLock(root), /Another data-updater/); release();
        acquireUpdateLock(root)();
    });
    test('engine capability mismatch stops before dependency installation or export', () => {
        const root = fixture(); write(root, 'scripts/simple-data-update.mjs', 'old engine\n');
        run(root, ['add', '.']); run(root, ['commit', '-m', 'Old engine fixture']); run(root, ['push', 'origin', 'main']);
        assert.throws(() => runIsolatedUpdate({ root, argv: [], run, installDependencies: () => assert.fail(), execute: () => assert.fail() }), /not yet available on main/);
    });
    test('completed/no-change worker checkout leaves primary main and edits untouched', () => {
        for (const phase of ['no-changes', 'production-verified']) {
            const root = fixture(); const { workspaceRoot: child } = workspace(root);
            const base = run(child, ['rev-parse', 'HEAD']).trim();
            run(child, ['switch', '-c', 'data/refresh-20261025-150000']);
            const before = snapshot(root);
            const commands = completedUpdateCheckoutArguments({ phase, baseCommitSha: base, mergeCommitSha: base }, { isolated: true, currentBranch: 'data/refresh-20261025-150000' });
            for (const command of commands) run(child, command);
            assert.equal(run(child, ['branch', '--show-current']).trim(), '');
            assert.deepEqual(snapshot(root), before);
        }
        assert.deepEqual(completedUpdateCheckoutArguments({}, { isolated: false, currentBranch: 'data/refresh-test' }), [['switch', 'main'], ['merge', '--ff-only', 'origin/main']]);
        assert.throws(() => completedUpdateCheckoutArguments({ phase: 'production-verified' }, { isolated: true }), /commit is invalid/);
    });
    console.log(`Isolated data-update workspace tests passed: ${passed} cases.`);
} finally {
    if (priorContext === undefined) delete process.env[updateHomeVariable];
    else process.env[updateHomeVariable] = priorContext;
    // Every fixture was created under this unique temp directory. Do not follow
    // test junctions when removing their links.
    assert(path.basename(tempRoot).startsWith('data-update-isolation-'));
    fs.rmSync(tempRoot, { recursive: true, force: true });
}
