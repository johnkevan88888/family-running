import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { refreshRoutineDataBranch, finishRefreshReview, validateRefreshState, verifyFreshReviewEvidence }
    from '../scripts/data-update-refresh.mjs';
import { confirmReviewedMerge, findGit, saveUpdateStateFile, validateUpdateState }
    from '../scripts/simple-data-update.mjs';

const gitExecutable = findGit();
const repository = 'johnkevan88888/family-running';
const branch = 'data/refresh-20261020-110000';
const roots = [];
let cases = 0;
function command(cwd, args, accepted = [0]) {
    const result = spawnSync(gitExecutable, args, {
        cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024
    });
    assert(!result.error, result.error?.message);
    assert(accepted.includes(result.status), `${args.join(' ')}: ${result.stderr}`);
    return result;
}
function fixture({ advance = { 'gallery-data/family.json': 'new photo metadata\n' }, legacy = false } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'running-data-refresh-'));
    roots.push(root);
    const work = path.join(root, 'work');
    const remote = path.join(root, 'remote.git');
    fs.mkdirSync(work);
    const git = (...args) => command(work, args).stdout.trim();
    command(root, ['init', '--bare', '--quiet', remote]);
    git('init', '--quiet', '--initial-branch=main');
    git('config', 'user.name', 'Synthetic Updater Test');
    git('config', 'user.email', 'updater@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.autocrlf', 'false');
    git('config', 'core.hooksPath', path.join(root, 'no-hooks'));
    const write = (file, text) => {
        fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
        fs.writeFileSync(path.join(work, file), text);
    };
    for (const [file, text] of Object.entries({
        'data/export_manifest.csv': 'old manifest\n', 'data/family/siteinfo.csv': 'old family\n',
        'data/everyone/siteinfo.csv': 'old everyone\n',
        'gallery-admin/generated/catalog-snapshot.js': 'old catalogue\n',
        'gallery-data/family.json': 'old photo metadata\n',
        'gallery-data/hidden-athlete-ids.json': '[]\n',
        'docs/active-work.md': 'base notes\n', 'site.css': 'old style\n',
        'scripts/workbook-export-contract.json': 'contract v1\n',
        'scripts/simple-data-update.mjs': 'updater v1\n',
        'package.json': '{}\n'
    })) write(file, text);
    git('add', '.'); git('commit', '--quiet', '-m', 'Synthetic base');
    const base = git('rev-parse', 'HEAD');
    git('remote', 'add', 'origin', remote);
    git('push', '--quiet', 'origin', 'main');
    git('switch', '--quiet', '-c', branch);
    for (const file of ['data/export_manifest.csv','data/family/siteinfo.csv',
        'data/everyone/siteinfo.csv','gallery-admin/generated/catalog-snapshot.js']) write(file, `new ${file}\n`);
    git('add', '.'); git('commit', '--quiet', '-m', 'Synthetic data update');
    const head = git('rev-parse', 'HEAD');
    git('push', '--quiet', 'origin', branch);
    const statePath = path.join(root, 'state.json');
    const state = {
        version: 1, phase: 'checked', branch, commitSha: head,
        ...(legacy ? {} : { baseCommitSha: base }),
        pullRequestUrl: `https://github.com/${repository}/pull/999`,
        pullRequestTitle: '[skip netlify] Synthetic data refresh',
        productionApprovedAt: '2026-10-20T12:00:00.000Z',
        stagedRoot: path.join(root, 'retained-export'), promotionRoot: path.join(root, 'retained-backup'),
        checkedAt: '2026-10-20T12:01:00.000Z', checkRunUrl: 'old-check'
    };
    fs.mkdirSync(state.stagedRoot); fs.mkdirSync(state.promotionRoot);
    const disk = () => JSON.parse(fs.readFileSync(statePath));
    const counters = { tests: 0, pushes: 0, saves: 0, merges: 0 };
    const controls = {};
    const persistState = current => {
        validateUpdateState(current);
        counters.saves += 1;
        fs.writeFileSync(statePath, JSON.stringify(current));
        controls.onSave?.(current);
    };
    persistState(state);
    counters.saves = 0;
    const remoteSha = ref => git('--git-dir', remote, 'rev-parse', `refs/heads/${ref}`);
    const readMain = () => ({ ref: 'refs/heads/main', object: { type: 'commit', sha: remoteSha('main') } });
    const readPullRequest = saved => {
        const pr = {
            html_url: saved.pullRequestUrl, title: saved.pullRequestTitle,
            state: 'open', merged: false, draft: false, auto_merge: null,
            base: { ref: 'main', repo: { full_name: repository } },
            head: { ref: branch, sha: remoteSha(branch), repo: { full_name: repository } }
        };
        controls.modifyPr?.(pr);
        return pr;
    };
    const advanceMain = files => {
        git('switch', '--quiet', 'main');
        for (const [file,text] of Object.entries(files)) write(file,text);
        git('add', '.'); git('commit', '--quiet', '-m', 'Synthetic main advancement');
        git('push', '--quiet', 'origin', 'main');
        git('switch', '--quiet', branch);
    };
    if (advance) advanceMain(advance);
    const run = (saved = disk()) => refreshRoutineDataBranch({
        state: saved,
        runGit: (args, options) => {
            if (args[0] === 'remote' && args[1] === 'get-url') {
                return { status: 0, stdout: controls.origin || `https://github.com/${repository}.git` };
            }
            if (args[0] === 'merge-tree' && controls.conflict) return { status: 1, stdout: 'synthetic conflict' };
            assert(!args.some(arg => ['reset','stash','clean'].includes(arg) || /^--force/.test(arg)),
                'No force, reset, stash or clean command is allowed.');
            const result = command(work, args, options.acceptedStatuses || [0]);
            if (args[0] === 'push') {
                counters.pushes += 1;
                controls.afterPush?.();
            }
            if (args.includes('merge') && args.includes('--no-ff')) {
                counters.merges += 1;
                controls.afterMerge?.();
            }
            return result;
        },
        readMain, readPullRequest, persistState,
        runTests: () => { counters.tests += 1; controls.test?.(); },
        validateReleasePath: ({ baseCommitSha, headCommitSha }) => {
            // Real Git diff, fake tiny CSV contract. Production calls the full
            // repository classifier, which requires all 72 CSVs and catalogue.
            const paths = git('diff','--name-only',baseCommitSha,headCommitSha).split('\n');
            assert(paths.every(file => file.startsWith('data/') || file === 'gallery-admin/generated/catalog-snapshot.js' || file === 'docs/active-work.md'));
        },
        now: () => '2026-10-20T12:02:00.000Z', logger: () => {}
    });
    return { root, work, remote, statePath, state, base, head, git, write, run, disk,
        counters, controls, remoteSha, advanceMain, persistState, readMain };
}
function test(name, run) { run(); cases += 1; console.log(`PASS - ${name}`); }
async function asyncTest(name, run) { await run(); cases += 1; console.log(`PASS - ${name}`); }

try {
    test('disjoint main refresh preserves all data and pushes only after tests', () => {
        const f = fixture();
        const main = f.remoteSha('main');
        f.controls.test = () => {
            assert.equal(f.remoteSha(branch), f.head, 'Untested commit must remain local.');
            assert.equal(f.disk().phase, 'refreshing');
        };
        const result = f.run();
        const refreshed = result.state.commitSha;
        assert.equal(result.refreshed, true);
        assert.equal(result.state.phase, 'published');
        assert.equal(result.state.refreshReviewRequired, true);
        assert.equal(result.state.baseCommitSha, main);
        assert.equal(result.state.checkRunUrl, undefined);
        assert.equal(result.state.checkedAt, undefined);
        assert.equal(f.remoteSha(branch), refreshed);
        assert.equal(f.git('show','-s','--format=%P',refreshed), `${f.head} ${main}`);
        assert.equal(f.git('diff', '--name-only', f.head, refreshed, '--','data','gallery-admin/generated/catalog-snapshot.js'), '');
        assert.equal(f.counters.tests, 1);
        assert.equal(f.counters.pushes, 1);
        assert.equal(fs.existsSync(f.state.stagedRoot), true);
        assert.equal(fs.existsSync(f.state.promotionRoot), true);
    });
    test('unchanged main performs no refresh, tests, push or state write', () => {
        const f = fixture({ advance: null });
        assert.equal(f.run().refreshed, false);
        assert.deepEqual(f.counters, { tests: 0, pushes: 0, saves: 0, merges: 0 });
    });
    test('legacy single-parent saved updates recover without hand-editing state', () => {
        const f = fixture({ legacy: true });
        assert.equal(f.run().state.baseCommitSha, f.remoteSha('main'));
    });
    for (const file of ['data/family/siteinfo.csv','data/new.csv','DATA/alias.csv',
        'gallery-admin/generated/catalog-snapshot.js','gallery-data/hidden-athlete-ids.json',
        'scripts/workbook-export-contract.json','scripts/simple-data-update.mjs',
        'scripts/data-update.mjs','scripts/data-update-context.mjs','scripts/run-workbook-staged-export.ps1',
        'scripts/published-site-entries.mjs','package.json','.gitattributes']) {
        test(`main change to ${file} is retained for separate review`, () => {
            const f = fixture({ advance: { [file]: 'unsafe change\n' } });
            assert.throws(() => f.run(), /Main changed data, export\/tool contracts/);
            assert.equal(f.git('rev-parse', 'HEAD'), f.head);
            assert.equal(f.remoteSha(branch), f.head);
            assert.equal(f.counters.saves, 0);
        });
    }
    test('local modifications are retained without reset, stash or journal changes', () => {
        const f = fixture(); f.write('site.css', 'owner edits\n');
        assert.throws(() => f.run(), /clean working tree/);
        assert.equal(fs.readFileSync(path.join(f.work,'site.css'),'utf8'), 'owner edits\n');
        assert.equal(f.disk().phase, 'checked');
        assert.equal(f.counters.pushes, 0);
    });
    test('untracked local files also stop automatic refresh', () => {
        const f = fixture(); f.write('owner-notes.txt','retain\n');
        assert.throws(() => f.run(), /clean working tree/);
        assert.equal(f.counters.saves, 0);
    });
    test('merge conflicts are detected before changing the branch or journal', () => {
        const f = fixture(); f.controls.conflict = true;
        assert.throws(() => f.run(), /cannot be integrated cleanly/);
        assert.equal(f.git('status','--porcelain'), '');
        assert.equal(f.git('rev-parse','HEAD'), f.head);
        assert.equal(f.counters.saves, 0);
    });
    test('failed tests retain an unpushed journal and resume the same local commit', () => {
        const f = fixture(); f.controls.test = () => { throw new Error('Synthetic tests failed'); };
        assert.throws(() => f.run(), /Synthetic tests failed/);
        const pending = f.disk();
        assert.equal(pending.phase, 'refreshing');
        assert.equal(pending.commitSha, f.head);
        assert.equal(pending.refresh.testedAt, null);
        assert.equal(f.remoteSha(branch), f.head);
        delete f.controls.test;
        const result = f.run();
        assert.equal(result.state.commitSha, pending.refresh.commitSha);
        assert.equal(f.counters.tests, 2);
        assert.equal(f.counters.merges, 1);
    });
    test('interruption after local merge is adopted only by exact parents and predicted tree', () => {
        const f = fixture();
        f.controls.afterMerge = () => { throw new Error('Synthetic interruption after merge'); };
        assert.throws(() => f.run(), /Synthetic interruption/);
        const resultHead = f.git('rev-parse','HEAD');
        assert.equal(f.disk().refresh.commitSha, null);
        delete f.controls.afterMerge;
        assert.equal(f.run().state.commitSha, resultHead);
        assert.equal(f.counters.merges, 1);
    });
    test('lost push reply resumes without a second push or repeated passed local tests', () => {
        const f = fixture();
        f.controls.afterPush = () => { throw new Error('Synthetic lost push reply'); };
        assert.throws(() => f.run(), /Synthetic lost push reply/);
        assert.equal(f.disk().phase, 'refreshing');
        const pushed = f.remoteSha(branch);
        assert.equal(f.disk().refresh.commitSha, pushed);
        delete f.controls.afterPush;
        assert.equal(f.run().state.commitSha, pushed);
        assert.equal(f.counters.tests, 1);
        assert.equal(f.counters.pushes, 1);
    });
    test('local commit movement during tests cannot be pushed', () => {
        const f = fixture();
        f.controls.test = () => { f.write('site.css','unexpected\n'); f.git('add','.'); f.git('commit','--quiet','-m','Unexpected local commit'); };
        assert.throws(() => f.run(), /changed identity or tree/);
        assert.equal(f.remoteSha(branch), f.head);
        assert.equal(f.counters.pushes, 0);
        assert.throws(() => f.run(), /local branch moved unexpectedly/);
    });
    test('a corrupted predicted tree cannot authorize recovery or a push', () => {
        const f = fixture();
        f.controls.test = () => { throw new Error('Stop before push'); };
        assert.throws(() => f.run(), /Stop before push/);
        const corrupted = f.disk();
        corrupted.refresh.treeSha = 'f'.repeat(40);
        fs.writeFileSync(f.statePath, JSON.stringify(corrupted));
        delete f.controls.test;
        assert.throws(() => f.run(), /plan no longer matches/);
        assert.equal(f.remoteSha(branch), f.head);
        assert.equal(f.counters.pushes, 0);
    });
    test('a concurrent remote commit is never overwritten', () => {
        const f = fixture();
        f.controls.test = () => {
            const extra = command(f.work, ['commit-tree', `${f.head}^{tree}`, '-p', f.head, '-m', 'Synthetic competing remote commit']).stdout.trim();
            f.git('push', '--quiet', 'origin', `${extra}:refs/heads/${branch}`);
        };
        assert.throws(() => f.run(), /exact published data Pull Request/);
        assert.equal(f.counters.pushes, 0);
    });
    test('main moving backwards is refused', () => {
        const f = fixture();
        const earlier = command(f.work, ['commit-tree', `${f.base}^{tree}`, '-m', 'Synthetic unrelated main']).stdout.trim();
        f.git('push', '--quiet', 'origin', `${earlier}:refs/heads/synthetic-unrelated-main`);
        f.git('--git-dir',f.remote,'update-ref','refs/heads/main',earlier);
        assert.throws(() => f.run(), /rewritten or moved backwards/);
        assert.equal(f.counters.pushes, 0);
    });
    for (const [name, change] of [
        ['wrong PR', pr => { pr.html_url += '0'; }],
        ['wrong head', pr => { pr.head.sha = 'f'.repeat(40); }],
        ['foreign head repository', pr => { pr.head.repo.full_name = 'other/repo'; }],
        ['wrong base', pr => { pr.base.ref = 'other'; }],
        ['draft PR', pr => { pr.draft = true; }],
        ['changed title', pr => { pr.title += ' changed'; }],
        ['closed PR', pr => { pr.state = 'closed'; }],
        ['automatic merge enabled', pr => { pr.auto_merge = {}; }]
    ]) test(name, () => {
        const f = fixture(); f.controls.modifyPr = change;
        assert.throws(() => f.run(), /Automatic data refresh refused/);
        assert.equal(f.counters.saves, 0);
        assert.equal(f.counters.pushes, 0);
    });
    test('missing PUBLISH authority cannot refresh a branch', () => {
        const f = fixture(); delete f.state.productionApprovedAt;
        assert.throws(() => f.run(f.state), /PUBLISH approval/);
        assert.equal(f.counters.pushes, 0);
    });
    test('wrong origin is refused without exposing or changing its URL', () => {
        const f = fixture(); f.controls.origin = 'https://example.invalid/other';
        assert.throws(() => f.run(), /origin must identify the fixed/);
        assert.equal(f.counters.saves, 0);
    });
    test('a further main change gets another tested refresh on the next resume', () => {
        const f = fixture();
        f.controls.test = () => { delete f.controls.test; f.advanceMain({ 'site.css': 'new main style\n' }); };
        const first = f.run().state.commitSha;
        const second = f.run().state.commitSha;
        assert.notEqual(first, second);
        assert.equal(f.counters.tests, 2);
        assert.equal(f.counters.pushes, 2);
        assert.equal(f.disk().refreshReviewRequired, true);
    });
    await asyncTest('fresh checks and review are mandatory even with a stale approve-merge flag', async () => {
        const f = fixture(); const state = f.run().state;
        let merges = 0, reviews = 0, checks = 0;
        const result = await finishRefreshReview(state, {
            approveMerge: true, merge: () => { merges += 1; },
            waitForChecks: async current => { checks += 1; return { ...current, phase: 'checked', checkRunUrl: 'fresh-exact-head' }; },
            verifyEvidence: current => { assert.equal(current.checkRunUrl,'fresh-exact-head'); },
            showReview: current => { reviews += 1; assert.equal(current.checkRunUrl, 'fresh-exact-head'); assert.equal(current.refreshReviewRequired, true); },
            persistState: f.persistState
        });
        assert.equal(result.stop, true);
        assert.equal(result.state.phase, 'checked');
        assert.equal(f.disk().refreshReviewRequired, undefined);
        assert.equal(merges, 0); assert.equal(reviews, 1); assert.equal(checks, 1);
    });
    await asyncTest('failed fresh CI preserves the mandatory-review marker across restart', async () => {
        const f = fixture(); const state = f.run().state;
        await assert.rejects(finishRefreshReview(state, {
            waitForChecks: async () => { throw new Error('Fresh CI failed'); },
            showReview: () => assert.fail('No successful review checkpoint exists yet'),
            persistState: f.persistState
        }), /Fresh CI failed/);
        assert.equal(f.disk().refreshReviewRequired, true);
        assert.equal(f.disk().phase, 'published');
    });
    await asyncTest('restart after successful CI still stops to present the new review', async () => {
        const state = { phase:'checked', commitSha:'b'.repeat(40), refreshReviewRequired:true };
        let shown = 0, recorded;
        const result = await finishRefreshReview(state, {
            waitForChecks: () => assert.fail('Already completed checks must not be substituted'),
            verifyEvidence: current => { assert.equal(current.commitSha,state.commitSha); },
            showReview: current => { shown += 1; assert.equal(current.refreshReviewRequired,true); },
            persistState: current => { recorded = structuredClone(current); }
        });
        assert.equal(result.stop,true); assert.equal(shown,1);
        assert.equal(recorded.phase,'checked');
        assert.equal(recorded.refreshReviewRequired,undefined);
    });
    test('malformed and misplaced recovery metadata fails closed', () => {
        assert.throws(() => validateRefreshState({ phase:'refreshing' }), /journal/);
        assert.throws(() => validateRefreshState({ phase:'checked', refresh:{} }), /outside/);
        assert.throws(() => validateRefreshState({ phase:'merged', refreshReviewRequired:true }), /unfinished/);
        assert.throws(() => validateRefreshState({ phase:'checked', baseCommitSha:'wrong' }), /base is invalid/);
    });
    test('only a successful exact-head PR run with fresh screenshots can clear review', () => {
        const state = { commitSha:'a'.repeat(40),
            checkRunUrl:`https://github.com/${repository}/actions/runs/123/job/456` };
        const make = () => ({
            run:{ id:123, head_sha:state.commitSha, event:'pull_request', status:'completed', conclusion:'success' },
            artifacts:{ total_count:1, artifacts:[{ id:9, name:'responsive-screenshots-123', expired:false, size_in_bytes:100 }] }
        });
        const verify = evidence => verifyFreshReviewEvidence(state, endpoint => endpoint.includes('/artifacts') ? evidence.artifacts : evidence.run);
        assert.deepEqual(verify(make()),{runId:123});
        for (const modify of [
            evidence => { evidence.run.head_sha = 'b'.repeat(40); },
            evidence => { evidence.run.status = 'in_progress'; },
            evidence => { evidence.run.event = 'workflow_dispatch'; },
            evidence => { evidence.run.conclusion = 'failure'; },
            evidence => { evidence.artifacts.total_count = 2; },
            evidence => { evidence.artifacts.artifacts[0].expired = true; },
            evidence => { evidence.artifacts.artifacts[0].size_in_bytes = 0; },
            evidence => { evidence.artifacts.artifacts[0].name = 'old-screenshots'; }
        ]) { const evidence = make(); modify(evidence); assert.throws(() => verify(evidence), /Automatic data refresh refused/); }
        assert.throws(() => verifyFreshReviewEvidence({ ...state, checkRunUrl:'https://example.invalid/run/123' },
            () => assert.fail('Unrecognized runs must not be requested')), /recognized screenshot run/);
    });
    test('a failed atomic state replacement preserves the complete previous record', () => {
        const f = fixture({ advance: null });
        const original = fs.readFileSync(f.statePath);
        const newer = { ...f.state, checkedAt:'2026-10-20T13:00:00.000Z' };
        assert.throws(() => saveUpdateStateFile(f.statePath, newer, {
            ...fs, renameSync: () => { throw new Error('Synthetic interrupted rename'); }
        }), /Synthetic interrupted rename/);
        assert(fs.readFileSync(f.statePath).equals(original));
        assert.equal(fs.readdirSync(f.root).filter(file => file.endsWith('.tmp')).length, 0);
        saveUpdateStateFile(f.statePath, newer);
        assert.deepEqual(f.disk(), newer);
    });
    for (const stopAt of [1, 2, 3]) {
        await asyncTest(`MERGE orchestration stops for refresh at boundary ${stopAt}`, async () => {
            const state = { phase:'checked', branch, commitSha:'a'.repeat(40),
                pullRequestUrl:`https://github.com/${repository}/pull/999`,
                pullRequestTitle:'[skip netlify] Synthetic data refresh' };
            let prepares = 0, merges = 0, prompts = 0;
            const result = await confirmReviewedMerge(state, {}, { approveMerge:true }, {
                prepareReview: async current => {
                    prepares += 1;
                    return prepares === stopAt
                        ? { state:{ ...current, commitSha:'b'.repeat(40) }, stop:true }
                        : { state:current, stop:false };
                },
                inspect: current => ({ url:current.pullRequestUrl, title:current.pullRequestTitle,
                    state:'OPEN', baseRefName:'main', headRefName:branch, headRefOid:current.commitSha,
                    statusCheckRollup:[{ name:'Test static site', conclusion:'SUCCESS' }] }),
                confirm: async () => { prompts += 1; return true; },
                merge: () => { merges += 1; throw new Error('Main moved during final policy check'); }
            });
            assert.equal(result.phase, 'checked');
            assert.equal(result.commitSha, 'b'.repeat(40));
            assert.equal(prompts, 0, 'The supplied old approval flag cannot authorize the refreshed head.');
            assert.equal(merges, stopAt === 3 ? 1 : 0);
            assert.equal(prepares, stopAt);
        });
    }
    await asyncTest('a declined MERGE response leaves the update open', async () => {
        const state = { phase:'checked', branch, commitSha:'a'.repeat(40),
            pullRequestUrl:`https://github.com/${repository}/pull/999`,
            pullRequestTitle:'[skip netlify] Synthetic data refresh' };
        let merges = 0, prepares = 0;
        const result = await confirmReviewedMerge(state, {}, {}, {
            prepareReview: async current => { prepares += 1; return { state:current, stop:false }; },
            inspect: current => ({ url:current.pullRequestUrl, title:current.pullRequestTitle,
                state:'OPEN', baseRefName:'main', headRefName:branch, headRefOid:current.commitSha,
                statusCheckRollup:[{ name:'Test static site', conclusion:'SUCCESS' }] }),
            confirm: async word => { assert.equal(word,'MERGE'); return false; },
            merge: () => { merges += 1; }
        });
        assert.equal(result.phase,'checked'); assert.equal(merges,0); assert.equal(prepares,1);
    });
    await asyncTest('a stable reviewed head merges only after fresh identity checks and explicit approval', async () => {
        const state = { phase:'checked', branch, commitSha:'a'.repeat(40),
            pullRequestUrl:`https://github.com/${repository}/pull/999`,
            pullRequestTitle:'[skip netlify] Synthetic data refresh' };
        const calls = [];
        const result = await confirmReviewedMerge(state, {}, {}, {
            prepareReview: async current => { calls.push('prepare'); return { state:current, stop:false }; },
            inspect: current => {
                calls.push('inspect');
                return { url:current.pullRequestUrl, title:current.pullRequestTitle,
                    state:'OPEN', baseRefName:'main', headRefName:branch, headRefOid:current.commitSha,
                    statusCheckRollup:[{ name:'Test static site', conclusion:'SUCCESS' }] };
            },
            confirm: async word => { assert.equal(word,'MERGE'); calls.push('approve'); return true; },
            merge: current => { calls.push('merge'); return { ...current, phase:'merged' }; }
        });
        assert.equal(result.phase,'merged');
        assert.deepEqual(calls,['prepare','inspect','approve','prepare','inspect','merge']);
    });
} finally {
    const parent = fs.realpathSync(os.tmpdir());
    for (const root of roots) {
        const target = fs.realpathSync(root);
        assert.equal(path.dirname(target), parent);
        assert.match(path.basename(target), /^running-data-refresh-/);
        fs.rmSync(target, { recursive:true, force:true });
    }
}
console.log(`Automatic data refresh tests passed (${cases} cases; real disposable Git repositories, fake GitHub and test runner).`);
