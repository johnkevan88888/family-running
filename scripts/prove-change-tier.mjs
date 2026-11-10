// Proves a narrowed tier is not weaker than the full suite, by breaking things.
//
// A tier table is a claim that a smaller set of checks catches what the whole
// suite would catch for a given kind of change. That claim cannot be
// established by reading it. So this seeds nine real faults, one per parity
// guarantee that a repository mutation can reach, and for each one requires the
// tier the classifier selects to FAIL.
//
// The runner is asymmetric, which is what makes it affordable:
//
//   - Run the selected tier. If it fails, the tier caught the fault. Done, in
//     seconds, and no full suite was needed.
//   - If the tier PASSES, run the full suite. Either nothing catches the fault,
//     which is a coverage gap worth knowing, or the full suite catches what the
//     tier missed -- and then the tier is unsafe and this exits non-zero.
//
// The expensive path therefore runs only in the case worth half an hour.
//
// Safety. It mutates the working tree in place and restores it precisely. It
// refuses to touch a path that already has uncommitted changes, records exactly
// what it wrote, restores through git, and verifies the restoration before
// moving on. If a restoration cannot be verified it stops immediately rather
// than seeding a second fault on top of a dirty tree.
//
// A mutation that cannot find its target is a FAILURE, never a skip: a no-op
// mutation would otherwise "prove" that a tier catches a fault nobody seeded.
//
// If the run is KILLED mid-fault it cannot restore, and the seeded file is left
// modified in the working tree. `git status` shows it and `git checkout -- <the
// file>` undoes it; nothing is ever committed by this script. Check the tree
// after an interrupted run before trusting a later one, because the next run
// refuses to touch a path that is already modified and will report that fault
// as not-seeded.
//
// It publishes nothing, pushes nothing, and touches no private workbook.
//
//     node scripts/prove-change-tier.mjs            # every declared fault
//     node scripts/prove-change-tier.mjs 3 7        # only those faults
//     node scripts/prove-change-tier.mjs --dry-run  # seed and restore only

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessChangeTier, readRegisteredCheckCommands, readRegisteredChecks } from './classify-change-tier.mjs';
import { checksForTier } from './change-tiers.mjs';
import { environmentFor } from './check-lanes.mjs';
import { listDataCsvFiles, readCsvMetadata } from './validate-pr-release-path.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registeredChecks = readRegisteredChecks(repoRoot);

/**
 * Every file this run has written, and whether it created it.
 *
 * Two jobs. It lets a fault rewrite a file the synthetic refresh already wrote
 * -- without which the fault's own write would find its target "already
 * modified" and refuse, and every data fault would report as not-seeded. And it
 * is what restoration works from, so a builder that throws half way through
 * writing 73 files still has all 73 reverted: an earlier version restored only
 * the array it was handed, so a partial failure left the tree modified.
 *
 * A file this run did not write is still refused. That is somebody else's
 * uncommitted work, and this script does not gamble with it.
 */
const writtenThisRun = new Map();

// Read once, from the manifest, so every rewrite replaces the same token.
const currentBundleId = readFileSync(path.join(repoRoot, 'data', 'export_manifest.csv'), 'utf8')
    .split(/\r?\n/)[1]
    .split(',')[0];

/**
 * The nine faults. Each names the guarantee it attacks, the paths it changes --
 * which decide the tier, exactly as a real Pull Request would -- and a mutation
 * that must find its target.
 */
const faults = [
    {
        number: 1,
        tier: 'data',
        guarantee: 'Export bundle integrity',
        name: 'a dropped CSV row',
        apply: () => {
            const file = firstUnquotedManifestCsvWithRows();
            const lines = readLines(file);

            // One row removed, so the manifest's DataRowCount no longer matches
            // the file it describes.
            return [write(file, [...lines.slice(0, lines.length - 1)])];
        }
    },
    {
        number: 2,
        tier: 'data',
        guarantee: 'Export bundle integrity',
        name: 'a mismatched ExportBundleID',
        apply: () => {
            // One file disagrees with the rest of the bundle and the manifest.
            // A token replacement, so a CSV with quoted fields is untouched
            // apart from the identifier itself.
            // The identifier this file carries RIGHT NOW, which on top of the
            // synthetic refresh is the synthetic one, not the committed one.
            // Reading the committed identifier here made this the one fault
            // that could not be seeded once a base was introduced.
            const file = firstUnquotedManifestCsvWithRows();
            const text = readFileSync(path.join(repoRoot, file), 'utf8');
            const carried = manifestBundleId();

            if (!text.includes(carried)) {
                throw new Error(`${file} does not carry the bundle identifier the manifest does`);
            }

            return [write(file, text.split(carried).join('20260101T000000000Z-DEADBEEF'), { raw: true })];
        }
    },
    {
        number: 3,
        tier: 'data',
        guarantee: 'Export bundle integrity',
        name: 'a published file missing from the manifest',
        apply: () => {
            const manifest = requireUnquoted('data/export_manifest.csv');
            const lines = readLines(manifest);

            // The second data row is dropped, so a CSV that exists and is
            // published is no longer listed.
            return [write(manifest, [lines[0], ...lines.slice(2)])];
        }
    },
    {
        number: 4,
        tier: 'data',
        guarantee: 'Mode separation',
        name: "Family data in Everyone's export",
        apply: () => {
            const pair = firstSharedLeaderboardName();

            requireUnquoted(`data/everyone/${pair.everyone}`);
            requireUnquoted(`data/family/${pair.family}`);
            const everyone = `data/everyone/${pair.everyone}`;
            const family = readLines(`data/family/${pair.family}`);
            const target = readLines(everyone);

            // The Everyone file keeps its own header and takes Family's rows.
            return [write(everyone, [target[0], ...family.slice(1)])];
        }
    },
    {
        number: 5,
        tier: 'data',
        guarantee: 'News time precision',
        name: 'a News time with a precision the contract forbids',
        apply: () => {
            // The News export carries six quoted fields containing commas, so
            // the cell is reached textually rather than by position. The
            // contract is HH:MM:SS[.fff]; a single fractional digit is neither,
            // so a reader cannot tell whether precision was lost.
            //
            // No News time currently has milliseconds, so the rounding variant
            // of this fault is not seedable against today's data -- which also
            // means the millisecond-preservation rule is unexercised by it.
            const file = 'data/family/official_result_news.csv';
            const text = readFileSync(path.join(repoRoot, file), 'utf8');
            const match = text.match(/,(\d{2}:\d{2}:\d{2}),/);

            if (!match) {
                throw new Error(`${file} has no HH:MM:SS value to break`);
            }

            return [write(file, text.replace(match[0], `,${match[1]}.5,`), { raw: true })];
        }
    },
    {
        number: 6,
        tier: 'data',
        guarantee: 'Age-grade calculator conformance',
        name: 'a calculator conformance mismatch',
        apply: () => {
            const file = requireUnquoted('data/family/age_grade_calculator.csv');
            const lines = readLines(file);
            const header = lines[0].split(',');
            const column = header.indexOf('ValidationAgeGrade');

            if (column === -1) {
                throw new Error(`${file} has no ValidationAgeGrade column`);
            }

            const cells = lines[1].split(',');

            // The workbook's own conformance value, changed. The browser and
            // the repository must both refuse to calculate.
            cells[column] = '0.999999999999999';

            return [write(file, [lines[0], cells.join(','), ...lines.slice(2)])];
        }
    },
    {
        number: 7,
        tier: 'runtime',
        guarantee: 'Every exported value reaching markup is escaped',
        name: 'an unescaped exported value in markup',
        apply: () => {
            const file = 'leaderboard.js';
            const source = readFileSync(path.join(repoRoot, file), 'utf8');
            const match = source.match(/escapeHTML\(([A-Za-z0-9_.[\]'"` ]+?)\)/);

            if (!match) {
                throw new Error(`${file} has no escapeHTML call to remove`);
            }

            return [write(file, source.replace(match[0], match[1]), { raw: true })];
        }
    },
    {
        number: 8,
        tier: 'gallery-editorial',
        guarantee: 'Gallery suppression fails closed',
        name: "a suppressed athlete's photo shown by a broken contract filter",
        apply: () => {
            const setup = suppressTaggedAthlete();
            const file = 'gallery-contract.js';
            const source = readFileSync(path.join(repoRoot, file), 'utf8');
            const marker = 'function filterSuppressedGalleryItems(items, suppressionDocument) {';

            if (!source.includes(marker)) {
                throw new Error(`${file} no longer declares filterSuppressedGalleryItems`);
            }

            // The filter returns everything it was given. Every surface that
            // consumes it -- the Gallery page, the championship podium
            // decoration, the Race moments panels -- then shows the suppressed
            // athlete's photo.
            return [...setup, write(file, source.replace(marker, `${marker}\n        return items;`), { raw: true })];
        }
    },
    {
        number: 10,
        tier: 'runtime',
        guarantee: 'Gallery suppression fails closed',
        name: "a suppressed athlete's photo shown by a discarded filter result",
        apply: () => {
            const setup = suppressTaggedAthlete();
            const file = 'gallery.js';
            const source = readFileSync(path.join(repoRoot, file), 'utf8');
            const marker = 'galleryItems = visibleItems;';

            if (!source.includes(marker)) {
                throw new Error(`${file} no longer assigns the filtered items`);
            }

            // The filter runs correctly and its result is thrown away. A
            // one-token slip, and the contract's own unit test cannot see it.
            //
            // There is no third site: suppression is applied once, at this
            // line, and the podium decoration reads the filtered list rather
            // than re-reading the manifest. That is the right architecture, and
            // it is why a single defect here exposes every surface at once.
            return [...setup, write(file, source.replace(marker, 'galleryItems = data.items;'), { raw: true })];
        }
    },
    {
        number: 9,
        tier: 'data',
        guarantee: 'The published artifact contains only allowlisted files',
        name: 'a stray file in the artifact',
        apply: () => {
            // `data/` is copied whole, and published `data/` must be exactly the
            // manifest plus the paths it lists. An unlisted file there reaches
            // the public web.
            const file = 'data/stray-change-tier-proof.csv';

            return [write(file, 'Stray,Column\n1,2\n', { raw: true, created: true })];
        }
    }
];

// `--dry-run` seeds each fault, reports what it changed, and restores, without
// running any check. It is how you confirm every mutation still finds its
// target after the data moves on -- a mutation that silently no-ops would
// otherwise "prove" that a tier catches a fault nobody seeded.
const dryRun = process.argv.includes('--dry-run');
const requested = process.argv.slice(2).filter(argument => !argument.startsWith('--'));
const selected = requested.length > 0
    ? faults.filter(fault => requested.includes(String(fault.number)))
    : faults;

if (selected.length === 0) {
    console.error(`No matching fault numbers. Declared faults: ${faults.map(fault => fault.number).join(', ')}.`);
    process.exit(1);
}

const results = [];
let unsafe = false;

// -- The control: a synthetic refresh with no fault in it -----------------
//
// A data fault has to be judged the way it would really arrive. One mutated CSV
// is not a refresh -- it is `incomplete-bundle`, which classifies as `full` --
// so judging the data tier against a single-file diff would prove nothing about
// the data tier. Each data fault is therefore applied on top of a complete
// synthetic refresh: one new consistent ExportBundleID across all 72 CSVs and
// the manifest, plus the regenerated catalogue.
//
// The base runs first with no fault in it. If it does not classify as the data
// tier, or does not PASS it, every later result is meaningless: a fault
// "caught" by a tier that already fails on clean data has been caught by
// nothing.

const dataFaults = selected.filter(fault => fault.tier === 'data');
let baseUsable = false;

if (dataFaults.length > 0) {
    console.log('\n=== Control: a complete synthetic refresh, no fault ===');

    let base = [];

    try {
        base = buildSyntheticRefresh();
    } catch (failure) {
        console.error(`  could not build the base: ${failure.message}`);
        unsafe = true;
        // Whatever it wrote before throwing comes back, which is the reason
        // restoration is driven by `writtenThisRun` and not by `base`.
        restoreAll();
    }

    if (base.length > 0) {
        const verdict = classify(base);

        console.log(`  ${base.length} files changed; classifies as ${verdict.tier}` +
            `${verdict.reason ? `/${verdict.reason}` : ''}`);

        if (verdict.tier !== 'data') {
            console.error('  BASE INVALID: a complete synthetic refresh must classify as the data tier.');
            unsafe = true;
        } else if (dryRun) {
            console.log('  base classifies as data; checks not run under --dry-run.');
            baseUsable = true;
        } else {
            const run = runChecks(checksForTier('data', registeredChecks));

            if (run.failed.length > 0) {
                console.error(`  BASE INVALID: the data tier fails on a clean synthetic refresh (${run.failed.join(', ')}).`);
                unsafe = true;
            } else {
                console.log('  base classifies as data and passes the data tier.');
                baseUsable = true;
            }
        }

        restoreAll();
    }

    results.push({
        number: 0,
        name: 'control: clean synthetic refresh',
        tier: 'data',
        outcome: baseUsable ? 'base-valid' : 'base-invalid'
    });
}

for (const fault of selected) {
    console.log(`\n=== Fault ${fault.number}: ${fault.name} (${fault.guarantee}) ===`);

    const onBase = fault.tier === 'data';

    if (onBase && !baseUsable) {
        console.error('  skipped: the synthetic refresh base is not valid, so a data fault proves nothing.');
        results.push({ ...fault, outcome: 'base-invalid' });
        unsafe = true;
        continue;
    }

    let written = [];

    try {
        if (onBase) {
            written = buildSyntheticRefresh();
        }

        const faultEntries = fault.apply();

        written = [...written.filter(entry => !faultEntries.some(seeded => seeded.file === entry.file)), ...faultEntries];
    } catch (failure) {
        console.error(`  could not seed: ${failure.message}`);
        results.push({ ...fault, outcome: 'not-seeded', detail: failure.message });
        unsafe = true;
        restoreAll();
        continue;
    }

    console.log(`  fault seeded${onBase ? ' on top of a complete refresh' : ''}; ${written.length} file(s) changed`);

    if (dryRun) {
        const verdict = classify(written);

        console.log(`  classifies as ${verdict.tier}${verdict.reason ? `/${verdict.reason}` : ''}; checks not run`);
        results.push({ ...fault, outcome: 'seeded' });
        restoreAll();
        continue;
    }

    // The classifier is in the loop: the tier comes from the diff, exactly as it
    // would on a real Pull Request.
    const verdict = classify(written);
    const tierChecks = checksForTier(verdict.tier, registeredChecks) || registeredChecks;

    console.log(`  classifies as ${verdict.tier}${verdict.reason ? `/${verdict.reason}` : ''} — ${tierChecks.length} checks`);

    if (onBase && verdict.tier !== 'data') {
        // Reported, never overridden. A data fault that does not present as a
        // refresh is a fact about the fault, not a licence to run a tier the
        // classifier did not choose.
        console.log('  NOTE: this data fault does not present as a complete refresh, so it routes to the full suite.');
    }

    const tierRun = runChecks(tierChecks);

    if (tierRun.failed.length > 0) {
        console.log(`  CAUGHT by ${verdict.tier}: ${tierRun.failed.join(', ')}`);
        results.push({ ...fault, outcome: 'caught', routedTo: verdict.tier, by: tierRun.failed, checks: tierChecks.length });
        restoreAll();
        continue;
    }

    if (verdict.tier === 'full') {
        // The full suite is what ran, because that is what the classifier chose.
        console.log('  nothing caught it, and the full suite is what ran: a coverage gap.');
        results.push({ ...fault, outcome: 'undetected', routedTo: 'full' });
        restoreAll();
        continue;
    }

    console.log('  tier passed; running the full suite to find out whether anything catches it');

    const fullRun = runChecks(registeredChecks);

    if (fullRun.failed.length > 0) {
        console.error(`  TIER UNSAFE: the full suite caught it (${fullRun.failed.join(', ')}) and ${verdict.tier} did not.`);
        results.push({ ...fault, outcome: 'tier-unsafe', routedTo: verdict.tier, by: fullRun.failed });
        unsafe = true;
    } else {
        console.log('  nothing caught it: a coverage gap, not a tier fault.');
        results.push({ ...fault, outcome: 'undetected', routedTo: verdict.tier });
    }

    restoreAll();
}

console.log('\n=== Summary ===');
for (const result of results) {
    const by = result.by ? ` by ${result.by.join(', ')}` : '';

    // The tier it ROUTED to, not the tier declared responsible for its class.
    // Printing the declaration made fault 9 read as `[data]` when the
    // classifier had sent it to the full suite, which is the opposite of what
    // this run is meant to show.
    const routed = result.routedTo ? ` routed to ${result.routedTo}` : '';

    console.log(`${result.number}. ${result.name} — ${result.outcome}${routed}${by}`);
}

if (dryRun) {
    console.log(`
Dry run: ${results.filter(result => result.outcome === 'seeded').length} of ${results.length} faults seeded and restored.`);
    process.exit(unsafe ? 1 : 0);
}

const caught = results.filter(result => result.outcome === 'caught').length;
const undetected = results.filter(result => result.outcome === 'undetected');

console.log(`\n${caught} of ${results.length} caught by the selected tier.`);

if (undetected.length > 0) {
    console.log(`${undetected.length} undetected by any check: ${undetected.map(result => result.name).join('; ')}.`);
}

process.exit(unsafe ? 1 : 0);

// -- mechanics ------------------------------------------------------------

function classify(written) {
    const changedEntries = written.map(entry => ({ status: entry.created ? 'A' : 'M', path: entry.file }));
    const files = changedEntries.map(entry => entry.path);
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();

    // `readCsvMetadata(head, head, ...)` compares the head commit against
    // itself, so it reports every file as present at both ends with an
    // unchanged header -- including one this run has just created, which does
    // not exist in git at all. Left uncorrected it told the classifier that a
    // brand-new CSV was part of a complete refresh, and the stray-file fault
    // routed to the data tier when a real Pull Request would have seen
    // `existsAtBase: false` and routed it to the full suite. The harness has to
    // state the truth about its own mutations.
    const metadata = readCsvMetadata(head, head, files);

    for (const entry of written) {
        if (entry.created && metadata.has(entry.file)) {
            metadata.set(entry.file, { ...metadata.get(entry.file), existsAtBase: false });
        }
    }

    return assessChangeTier({
        changedEntries,
        csvMetadata: metadata,
        expectedDataCsvFiles: listDataCsvFiles(head),
        registeredChecks
    });
}

function runChecks(checks) {
    const failed = [];
    const commandFor = new Map(readRegisteredCheckCommands(repoRoot).map(command => [command.script, command.args]));

    for (const check of checks) {
        const result = spawnSync(process.execPath, commandFor.get(check) || [check], {
            cwd: repoRoot,
            env: { ...process.env, ...environmentFor(check) },
            stdio: 'ignore',
            windowsHide: true
        });

        if (result.status !== 0) {
            failed.push(check);
            // The question is whether this set catches the fault, which the
            // first failure answers. Running the remaining checks would add
            // names to a list nobody needs and hours to the run: a full suite
            // that fails on its third check would otherwise still pay for the
            // other hundred and twelve.
            break;
        }
    }

    return { failed };
}

function readLines(file) {
    const text = readFileSync(path.join(repoRoot, file), 'utf8');
    const lines = text.split(/\r?\n/);

    // A trailing newline leaves an empty final element; drop it so row
    // arithmetic is about rows.
    return lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
}

function write(file, content, options = {}) {
    const absolute = path.join(repoRoot, file);

    if (!options.created) {
        requireClean(file);
    } else if (existsSync(absolute)) {
        throw new Error(`${file} already exists; the proof will not overwrite it`);
    }

    const text = options.raw ? content : `${content.join('\r\n')}\r\n`;

    writeFileSync(absolute, text);
    writtenThisRun.set(file, { created: Boolean(options.created) });

    return { file, created: Boolean(options.created) };
}

function requireClean(file) {
    if (writtenThisRun.has(file)) {
        return;
    }

    const status = execFileSync('git', ['status', '--porcelain', '--', file], { cwd: repoRoot, encoding: 'utf8' }).trim();

    if (status) {
        throw new Error(`${file} already has uncommitted changes; the proof will not modify or restore it`);
    }
}

/**
 * Reverts everything this run has written, whatever stage it got to.
 *
 * Driven by `writtenThisRun` rather than by a caller's list, so a seeding step
 * that throws part way through still has every file it touched reverted. Each
 * one is verified afterwards, and an unverifiable restoration stops the run
 * rather than seeding a second fault onto a dirty tree.
 */
function restoreAll() {
    for (const [file, entry] of [...writtenThisRun]) {
        const absolute = path.join(repoRoot, file);

        if (entry.created) {
            rmSync(absolute, { force: true });
        } else {
            execFileSync('git', ['checkout', '--', file], { cwd: repoRoot });
        }

        writtenThisRun.delete(file);

        const status = execFileSync('git', ['status', '--porcelain', '--', file], { cwd: repoRoot, encoding: 'utf8' }).trim();

        if (status) {
            console.error(`\nSTOPPING: ${file} did not restore cleanly (${status}). Fix the working tree before continuing.`);
            process.exit(2);
        }
    }
}

function firstManifestCsvWithRows() {
    for (const row of readLines('data/export_manifest.csv').slice(1)) {
        const cells = row.split(',');
        const relativePath = cells[4];
        const rowCount = Number(cells[5]);

        if (relativePath && rowCount > 1 && existsSync(path.join(repoRoot, relativePath))) {
            return relativePath;
        }
    }

    throw new Error('no manifest-listed CSV with rows');
}

function firstSharedLeaderboardName() {
    const everyoneFiles = listDataCsvFiles(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim())
        .filter(file => file.startsWith('data/everyone/'));

    for (const file of everyoneFiles) {
        const name = path.basename(file);
        const familyName = name.replace('-everyone', '-family');

        if (familyName !== name && existsSync(path.join(repoRoot, 'data', 'family', familyName))) {
            return { everyone: name, family: familyName };
        }
    }

    throw new Error('no leaderboard exported in both modes');
}

/**
 * A complete synthetic refresh: one new ExportBundleID written across all 72
 * public CSVs -- the manifest among them -- with the catalogue regenerated.
 *
 * This is the change the data tier exists for, so it is what a data fault must
 * be judged against. It changes no header and adds no file, so it satisfies the
 * lightweight-refresh predicate for the same reasons a real promoted export
 * does.
 */
function buildSyntheticRefresh() {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    const bundleId = syntheticBundleId();
    const written = [];

    // `listDataCsvFiles` already includes `data/export_manifest.csv`: the
    // bundle is 72 public CSVs OF WHICH the manifest is one, not 72 plus a
    // manifest. Rewriting it separately after the loop looked for an identifier
    // the loop had just replaced, and the base failed to build at all.
    for (const file of listDataCsvFiles(head)) {
        written.push(rewriteBundleId(file, bundleId));
    }

    // Regenerated by the builder itself: a hand-written catalogue would not be
    // the thing `--check` verifies.
    const catalogue = 'gallery-admin/generated/catalog-snapshot.js';

    requireClean(catalogue);
    execFileSync(process.execPath, ['scripts/build-gallery-admin-catalog.mjs'], { cwd: repoRoot, stdio: 'ignore' });
    writtenThisRun.set(catalogue, { created: false });
    written.push({ file: catalogue, created: false });

    return written;
}

/** The ExportBundleID the manifest carries at this moment. */
function manifestBundleId() {
    return readLines('data/export_manifest.csv')[1].split(',')[0];
}

function syntheticBundleId() {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('.', '');

    return `${stamp}-C0DE7157`;
}

function rewriteBundleId(file, bundleId) {
    // A textual replacement of the whole token, never a cell edit.
    // `data/athlete_results.csv` holds eleven quoted fields that contain
    // commas, so splitting a row on commas corrupts it -- the hazard AGENTS.md
    // names, and a corrupted CSV would mean the proof measured corruption
    // instead of the fault it claims to seed. The ExportBundleID is a
    // distinctive token, so replacing it leaves quoting, commas and newlines
    // exactly as they were.
    const absolute = path.join(repoRoot, file);
    const text = readFileSync(absolute, 'utf8');

    if (!text.includes(currentBundleId)) {
        throw new Error(`${file} does not carry the current ExportBundleID`);
    }

    return write(file, text.split(currentBundleId).join(bundleId), { raw: true });
}

/**
 * Refuses a file that contains a quote character.
 *
 * Used by the faults that edit a row or a cell by position. Those are only safe
 * on a CSV with no quoted fields, because a quoted field may contain a comma or
 * a newline. Failing here is correct: a fault that silently corrupts its target
 * is worse than a fault that cannot be seeded.
 */
function requireUnquoted(file) {
    if (readFileSync(path.join(repoRoot, file), 'utf8').includes('"')) {
        throw new Error(`${file} contains quoted fields, so this fault cannot edit it by position`);
    }

    return file;
}

/** The first manifest-listed CSV with rows and no quoted fields. */
function firstUnquotedManifestCsvWithRows() {
    for (const row of readLines('data/export_manifest.csv').slice(1)) {
        const cells = row.split(',');
        const relativePath = cells[4];

        if (!relativePath || Number(cells[5]) <= 1 || !existsSync(path.join(repoRoot, relativePath))) {
            continue;
        }
        if (!readFileSync(path.join(repoRoot, relativePath), 'utf8').includes('"')) {
            return relativePath;
        }
    }

    throw new Error('no manifest-listed CSV with rows and no quoted fields');
}

/**
 * Suppresses an athlete who is tagged on a published photo, and leaves the
 * generated catalogue current.
 *
 * The catalogue is regenerated on purpose. `build-gallery-admin-catalog
 * --check` notices a stale catalogue, and in an earlier version of this fault
 * that is what caught it -- incidentally, and not because anything had noticed
 * a suppressed athlete's photo being shown. Keeping the catalogue current
 * removes that accident, so the question asked is the real one: does any check
 * catch the photo appearing?
 */
function suppressTaggedAthlete() {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'gallery-data', 'family.json'), 'utf8'));
    const tagged = manifest.items.find(item => item.type === 'photo' && item.athleteIds?.length);

    if (!tagged) {
        throw new Error('gallery-data/family.json has no tagged photo to suppress against');
    }

    const file = 'gallery-data/hidden-athlete-ids.json';
    const suppression = JSON.parse(readFileSync(path.join(repoRoot, file), 'utf8'));

    if (suppression.hiddenAthleteIds.includes(tagged.athleteIds[0])) {
        throw new Error(`${tagged.athleteIds[0]} is already suppressed, so this seeds nothing`);
    }

    suppression.hiddenAthleteIds = [...suppression.hiddenAthleteIds, tagged.athleteIds[0]];

    const written = [write(file, `${JSON.stringify(suppression, null, 2)}\n`, { raw: true })];
    const catalogue = 'gallery-admin/generated/catalog-snapshot.js';

    requireClean(catalogue);
    execFileSync(process.execPath, ['scripts/build-gallery-admin-catalog.mjs'], { cwd: repoRoot, stdio: 'ignore' });
    writtenThisRun.set(catalogue, { created: false });
    written.push({ file: catalogue, created: false });

    return written;
}
