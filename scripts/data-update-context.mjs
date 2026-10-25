import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const updateHomeVariable = 'FAMILY_RUNNING_DATA_UPDATE_HOME';
export const workspaceRelativePath = 'test-artifacts/data-update-workspace';
export const workspaceMarkerRelativePath = 'test-artifacts/data-update-workspace.json';

export function workspacePaths(homeRoot) {
    return {
        workspaceRoot: path.join(homeRoot, workspaceRelativePath),
        markerPath: path.join(homeRoot, workspaceMarkerRelativePath)
    };
}

// An environment variable cannot turn an arbitrary directory into an export or
// cleanup target. Require the exact managed worktree, its primary checkout and
// Git's reciprocal registration before sharing the workbook's staging parent.
export function readUpdateWorkspaceContext(repoRoot, env = process.env) {
    const homeRoot = env[updateHomeVariable];
    if (homeRoot === undefined) return null;
    requirePhysicalDirectory(homeRoot);
    requirePhysicalDirectory(repoRoot);
    const { workspaceRoot, markerPath } = workspacePaths(homeRoot);
    if (!samePath(repoRoot, workspaceRoot)) fail('The updater is outside its recorded workspace.');
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (marker.version !== 1 || marker.homeRoot !== homeRoot || marker.workspaceRoot !== workspaceRoot) {
        fail('The updater workspace record does not match this checkout.');
    }
    const common = path.join(homeRoot, '.git');
    requirePhysicalDirectory(common);
    const gitFile = path.join(workspaceRoot, '.git');
    if (!fs.lstatSync(gitFile).isFile()) fail('The updater must be a linked Git worktree.');
    const match = /^gitdir: (.+)\r?\n?$/.exec(fs.readFileSync(gitFile, 'utf8'));
    if (!match) fail('The updater Git registration is invalid.');
    const gitDirectory = path.resolve(workspaceRoot, match[1].trim());
    requirePhysicalDirectory(gitDirectory);
    if (!samePath(path.dirname(gitDirectory), path.join(common, 'worktrees')) ||
        !samePath(path.resolve(gitDirectory, fs.readFileSync(path.join(gitDirectory, 'commondir'), 'utf8').trim()), common) ||
        !samePath(path.resolve(gitDirectory, fs.readFileSync(path.join(gitDirectory, 'gitdir'), 'utf8').trim()), gitFile)) {
        fail('The updater belongs to a different Git repository or registration.');
    }
    return { homeRoot, workspaceRoot, markerPath };
}

export function requirePhysicalDirectory(directory) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) ||
        directory !== directory.trim() || !samePath(path.resolve(directory), directory) ||
        /(^|[\\/])\.{1,2}([\\/]|$)/.test(directory)) {
        fail('A canonical absolute directory is required.');
    }
    if (!fs.lstatSync(directory).isDirectory() ||
        !samePath(fs.realpathSync(directory), directory)) {
        fail('Updater directories cannot be symbolic links or junctions.');
    }
    return directory;
}

function samePath(a, b) {
    const normalize = value => process.platform === 'win32' ? value.toLowerCase().replaceAll('\\', '/') : value;
    return normalize(a) === normalize(b);
}

function fail(message) { throw new Error(`Data-update isolation refused: ${message}`); }

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    try {
        const context = readUpdateWorkspaceContext(repoRoot);
        if (!context) fail('No isolated workspace context was supplied.');
        console.log(context.homeRoot);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
