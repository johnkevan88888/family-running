#!/usr/bin/env node

// Reconcile a draft workbook personal-best export against what athlete.html
// actually renders today.
//
// Why this exists, and why it reads the page rather than the data:
//
// `docs/personal-best-export-proposal.md` plans to replace the two JavaScript
// selectors in `athlete.js` with a workbook-owned `data/personal_bests.csv`.
// Validating that export against `data/athlete_results.csv` proves it agrees
// with the source data. It does not establish what visibly changes on an
// athlete's profile, which is the thing a reader of that profile would notice.
// So this compares against rendered output: it drives the real page in the real
// browser and reads the Personal Bests cards out of the DOM.
//
// It deliberately does not reimplement the selection logic in Node. The defect
// being closed is that one concept has two selectors; a third one living in a
// reconciliation script would be the same mistake wearing a different hat.
//
// Two modes:
//
//   --export <path>        Compare a draft export against rendered output and
//                          report every difference. Exits non-zero if any.
//
//   --emit-current <path>  Write current rendered selections as a CSV in the
//                          proposed schema. This is a specimen of present
//                          behaviour for the workbook to replicate or knowingly
//                          supersede, and the fixture this script is tested
//                          against. It is NOT an export and must never be
//                          treated as one -- see the guard in
//                          isSafeEmitTarget.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStaticServer } from './serve-site.mjs';
import { findChromiumExecutable, loadPlaywright } from './browser-runtime.mjs';
import { parseCsv, sameOrDescendantPath } from './export-bundle-tools.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// These mirror `buildPersonalBests` in athlete.js: the five cards it renders, in
// the order it renders them, and the two columns and two blocks inside each.
// The canonical spellings are the ones the proposed export uses.
const SUPPORTED_DISTANCES = ['Marathon', 'Half Marathon', '10 Mile', '10 km', '5 km'];
const TIME_CLASSES = ['Official', 'Unofficial'];
const BENCHMARK_TYPES = ['Best Age Grade', 'Fastest Time'];

// Personal bests on the athlete page are all-time only. Settled decision 4 in
// the proposal carries the column anyway so a later Current period costs no
// second schema change, so anything else in this column is a contract error.
const EXPORT_PERIOD = 'All Time';

const EXPORT_COLUMNS = [
    'AthleteId', 'Distance', 'TimeClass', 'Period', 'BenchmarkType',
    'Time', 'AgeGrade', 'AgeGradeExact', 'Date', 'Event', 'SourceRow', 'SortOrder', 'ExportBundleID'
];

// Composite map key. A unit separator cannot occur in an athlete id, a
// distance, a result class, or a benchmark type, so the key stays
// unambiguous without escaping anything.
const KEY_SEPARATOR = '\u001F';

// A specimen file carries this instead of a bundle ID. If one is ever mistaken
// for a real export, bundle validation rejects it immediately rather than
// quietly accepting repository-generated rows as workbook-owned data.
const SPECIMEN_BUNDLE_ID = 'NOT-AN-EXPORT-RENDERED-SPECIMEN';

// Only runs the command line when invoked directly, so the comparison logic can
// be imported and tested without launching a browser. Same guard style as
// `scripts/validate-pr-release-path.mjs`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exit(await main(process.argv.slice(2)));
}

export async function main(argv) {
    const options = parseArguments(argv);

    if (options.help) {
        printUsage();
        return 0;
    }

    if (!options.exportPath && !options.emitPath) {
        printUsage();
        console.error('\nNothing to do: pass --export <path> to compare, or --emit-current <path> to write a specimen.');
        return 2;
    }

    if (options.emitPath && !await isSafeEmitTarget(options.emitPath)) {
        return 2;
    }

    const athletes = await readAthletes();
    const modes = options.site ? [options.site] : ['family', 'everyone'];

    console.log(`Reading rendered personal bests for ${athletes.length} athletes across ${modes.join(' and ')}.`);

    const rendered = await readRenderedPersonalBests(athletes, modes);

    if (rendered.pageProblems.length > 0) {
        console.error('\nThe page reported errors while rendering. The comparison below cannot be trusted:');
        for (const problem of rendered.pageProblems) {
            console.error(`  - ${problem}`);
        }
    }

    // Personal bests come from shared `data/athlete_results.csv`, so a profile
    // should select the same benchmarks whichever mode it was reached through.
    // That is the premise behind exporting this file as `shared` rather than
    // per-site, so it is worth checking rather than assuming.
    const modeDisagreements = findModeDisagreements(rendered.byMode, modes);

    if (modeDisagreements.length > 0) {
        console.error(`\nRendered personal bests differ between site modes in ${modeDisagreements.length} place(s).`);
        console.error('This contradicts the shared-scope premise in the export proposal:');
        for (const line of modeDisagreements.slice(0, 20)) {
            console.error(`  - ${line}`);
        }
    }

    const renderedSelections = rendered.byMode.get(modes[0]);

    if (options.emitPath) {
        await writeSpecimen(options.emitPath, renderedSelections);
    }

    let comparison = null;

    if (options.exportPath) {
        comparison = compareExportAgainstRendered(
            await readExport(options.exportPath),
            renderedSelections
        );
        reportComparison(comparison, options.exportPath);
    }

    if (options.jsonPath) {
        await fs.writeFile(options.jsonPath, `${JSON.stringify({
            exportPath: options.exportPath || null,
            modes,
            athletes: athletes.length,
            modeDisagreements,
            pageProblems: rendered.pageProblems,
            comparison
        }, null, 2)}\n`, 'utf8');
        console.log(`\nMachine-readable report written to ${path.relative(repoRoot, options.jsonPath)}.`);
    }

    const failed = rendered.pageProblems.length > 0
        || modeDisagreements.length > 0
        || Boolean(comparison && !comparison.clean);

    return failed ? 1 : 0;
}

function parseArguments(argv) {
    const parsed = { help: false, exportPath: null, emitPath: null, site: null, jsonPath: null };

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        const takeValue = () => {
            const value = argv[index + 1];
            if (!value || value.startsWith('--')) {
                throw new Error(`${argument} needs a value.`);
            }
            index += 1;
            return value;
        };

        switch (argument) {
            case '--help':
            case '-h':
                parsed.help = true;
                break;
            case '--export':
                parsed.exportPath = path.resolve(takeValue());
                break;
            case '--emit-current':
                parsed.emitPath = path.resolve(takeValue());
                break;
            case '--json':
                parsed.jsonPath = path.resolve(takeValue());
                break;
            case '--site': {
                const value = takeValue();
                if (value !== 'family' && value !== 'everyone') {
                    throw new Error('--site must be family or everyone.');
                }
                parsed.site = value;
                break;
            }
            default:
                throw new Error(`Unrecognised argument: ${argument}`);
        }
    }

    return parsed;
}

function printUsage() {
    console.log(`Reconcile a draft personal-best export against rendered athlete pages.

  node scripts/reconcile-personal-bests.mjs --export <path/to/personal_bests.csv>
  node scripts/reconcile-personal-bests.mjs --emit-current <path/to/specimen.csv>

Options:
  --export <path>        Draft export to compare against rendered output.
  --emit-current <path>  Write current rendered selections in the proposed
                         schema. Refuses to write anywhere inside data/.
  --site <mode>          Check one mode only. Default checks family and
                         everyone and reports any disagreement between them.
  --json <path>          Also write a machine-readable report.

Exits 1 if the export and the page disagree, if the two modes disagree, or if
the page errored while rendering.`);
}

// The specimen describes what the browser does today. It is repository-derived,
// so letting it land in data/ would create exactly the second source of truth
// this whole exercise exists to remove.
export async function isSafeEmitTarget(target) {
    const dataRoot = path.join(repoRoot, 'data');

    if (sameOrDescendantPath(target, dataRoot)) {
        console.error(`Refusing to write a rendered specimen inside data/: ${target}`);
        console.error('That directory is workbook-owned export territory. Write to test-artifacts/ or outside the repository.');
        return false;
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    return true;
}

async function readAthletes() {
    const csvPath = path.join(repoRoot, 'data', 'athlete_results.csv');
    const rows = parseCsv(await fs.readFile(csvPath, 'utf8')).filter(row => row.some(value => value.trim() !== ''));
    const header = rows.shift().map(value => value.trim());
    const idIndex = header.indexOf('AthleteID');
    const nameIndex = header.indexOf('Participant');

    if (idIndex === -1) {
        throw new Error('data/athlete_results.csv has no AthleteID column.');
    }

    const seen = new Map();

    for (const row of rows) {
        const id = (row[idIndex] || '').trim();
        if (id && !seen.has(id)) {
            seen.set(id, (row[nameIndex] || '').trim());
        }
    }

    return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.id.localeCompare(b.id));
}

async function readRenderedPersonalBests(athleteList, modeList) {
    const { chromium } = loadPlaywright();
    const preview = await createStaticServer({ root: repoRoot, port: 0, silent: true });
    const byMode = new Map();
    const pageProblems = [];
    let browser;

    try {
        browser = await chromium.launch({
            headless: true,
            executablePath: findChromiumExecutable(),
            args: ['--disable-dev-shm-usage']
        });

        for (const mode of modeList) {
            const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
            const page = await context.newPage();

            page.on('pageerror', error => pageProblems.push(`${mode}: uncaught page error: ${error.message}`));
            page.on('console', message => {
                if (message.type() === 'error') {
                    pageProblems.push(`${mode}: console error: ${message.text()}`);
                }
            });

            const selections = new Map();

            for (const athlete of athleteList) {
                const url = `${preview.baseUrl}/athlete.html?id=${encodeURIComponent(athlete.id)}&site=${mode}`;
                await page.goto(url, { waitUntil: 'domcontentloaded' });

                // Either the cards rendered or the page decided the athlete does
                // not exist. Waiting only for cards would hang on the second case
                // and hide it as a timeout rather than reporting it.
                await page.waitForFunction(() => {
                    const container = document.getElementById('personal-bests');
                    const name = document.getElementById('athlete-name');
                    return Boolean(container?.querySelector('.pb-card'))
                        || name?.innerText === 'Athlete not found';
                }, null, { timeout: 20000 });

                const scraped = await page.evaluate(scrapePersonalBests);

                if (scraped.notFound) {
                    pageProblems.push(`${mode}: athlete.html reported "Athlete not found" for ${athlete.id}, which has rows in athlete_results.csv.`);
                    continue;
                }

                for (const block of scraped.blocks) {
                    selections.set(
                        selectionKey(athlete.id, block.distance, block.timeClass, block.benchmarkType),
                        { athleteId: athlete.id, athleteName: athlete.name, ...block }
                    );
                }
            }

            byMode.set(mode, selections);
            await context.close();
        }
    } finally {
        if (browser) {
            await browser.close();
        }

        await preview.close();
    }

    return { byMode, pageProblems };
}

// Runs in the page. Reads the markup `buildPersonalBests` and `formatPBBlock`
// produce. The time sits inside `.result-time` when the pace module rendered a
// pace alongside it, so reading that span gets the exact exported time back
// without having to unpick the pace text.
function scrapePersonalBests() {
    if (document.getElementById('athlete-name')?.innerText === 'Athlete not found') {
        return { notFound: true, blocks: [] };
    }

    const PIN = '\u{1F4CD}';
    const CALENDAR = '\u{1F4C5}';
    const blocks = [];

    for (const card of document.querySelectorAll('#personal-bests .pb-card')) {
        const distance = card.querySelector('.pb-card-title')?.textContent.trim() || '';

        for (const column of card.querySelectorAll('.pb-column')) {
            const timeClass = column.classList.contains('official')
                ? 'Official'
                : column.classList.contains('unofficial') ? 'Unofficial' : '';

            for (const block of column.querySelectorAll('.pb-block')) {
                const benchmarkType = block.querySelector('.pb-label')?.textContent.trim() || '';
                const valueElement = block.querySelector('.pb-value');
                const subElement = block.querySelector('.pb-sub');
                const empty = block.classList.contains('empty')
                    || !subElement
                    || valueElement?.textContent.trim() === '-';

                if (empty) {
                    blocks.push({ distance, timeClass, benchmarkType, empty: true });
                    continue;
                }

                const isAgeGrade = benchmarkType === 'Best Age Grade';
                const ageGradeElement = isAgeGrade ? valueElement : subElement;
                const timeElement = isAgeGrade ? subElement : valueElement;
                const timeSpan = timeElement?.querySelector('.result-time');

                let event = '';
                let date = '';

                for (const meta of block.querySelectorAll('.pb-meta')) {
                    const text = meta.textContent || '';
                    if (text.includes(PIN)) {
                        event = text.replaceAll(PIN, '').trim();
                    } else if (text.includes(CALENDAR)) {
                        date = text.replaceAll(CALENDAR, '').trim();
                    }
                }

                blocks.push({
                    distance,
                    timeClass,
                    benchmarkType,
                    empty: false,
                    time: (timeSpan ? timeSpan.textContent : timeElement?.textContent || '').trim(),
                    ageGrade: (ageGradeElement?.textContent || '').trim(),
                    displayDate: date,
                    event
                });
            }
        }
    }

    return { notFound: false, blocks };
}

export function selectionKey(athleteId, distance, timeClass, benchmarkType) {
    return [athleteId, distance, timeClass, benchmarkType].join(KEY_SEPARATOR);
}

export function describeKey(key) {
    const [athleteId, distance, timeClass, benchmarkType] = key.split(KEY_SEPARATOR);
    return `${athleteId} / ${distance} / ${timeClass} / ${benchmarkType}`;
}

export function findModeDisagreements(byMode, modeList) {
    if (modeList.length < 2) {
        return [];
    }

    const [first, ...rest] = modeList;
    const baseline = byMode.get(first);
    const disagreements = [];

    for (const mode of rest) {
        const other = byMode.get(mode);
        const keys = new Set([...baseline.keys(), ...other.keys()]);

        for (const key of keys) {
            const left = baseline.get(key);
            const right = other.get(key);
            const leftSummary = summariseSelection(left);
            const rightSummary = summariseSelection(right);

            if (leftSummary !== rightSummary) {
                disagreements.push(`${describeKey(key)}: ${first} shows ${leftSummary}, ${mode} shows ${rightSummary}`);
            }
        }
    }

    return disagreements;
}

export function summariseSelection(selection) {
    if (!selection || selection.empty) {
        return 'no value';
    }

    return `${selection.time} / ${selection.ageGrade} / ${selection.displayDate} / ${selection.event}`;
}

async function readExport(exportPath) {
    const rows = parseCsv(await fs.readFile(exportPath, 'utf8')).filter(row => row.some(value => value.trim() !== ''));

    if (rows.length === 0) {
        throw new Error(`${exportPath} is empty.`);
    }

    const header = rows.shift().map(value => value.trim());
    const missing = EXPORT_COLUMNS.filter(column => !header.includes(column));
    const unexpected = header.filter(column => !EXPORT_COLUMNS.includes(column));

    return {
        header,
        missing,
        unexpected,
        rows: rows.map((row, index) => {
            const record = { __line: index + 2 };
            header.forEach((column, columnIndex) => {
                record[column] = (row[columnIndex] || '').trim();
            });
            return record;
        })
    };
}

export function compareExportAgainstRendered(exported, renderedSelections) {
    const schemaProblems = [];

    for (const column of exported.missing) {
        schemaProblems.push(`Missing column: ${column}`);
    }
    for (const column of exported.unexpected) {
        schemaProblems.push(`Unexpected column: ${column}`);
    }

    const byKey = new Map();
    const agree = [];
    const differ = [];
    const missingFromExport = [];
    const absentFromPage = [];

    for (const row of exported.rows) {
        const key = selectionKey(row.AthleteId, row.Distance, row.TimeClass, row.BenchmarkType);

        if (byKey.has(key)) {
            schemaProblems.push(`Duplicate row for ${describeKey(key)} (lines ${byKey.get(key).__line} and ${row.__line})`);
            continue;
        }

        byKey.set(key, row);

        if (!SUPPORTED_DISTANCES.includes(row.Distance)) {
            schemaProblems.push(`Line ${row.__line}: unsupported Distance "${row.Distance}"`);
        }
        if (!TIME_CLASSES.includes(row.TimeClass)) {
            schemaProblems.push(`Line ${row.__line}: unsupported TimeClass "${row.TimeClass}"`);
        }
        if (!BENCHMARK_TYPES.includes(row.BenchmarkType)) {
            schemaProblems.push(`Line ${row.__line}: unsupported BenchmarkType "${row.BenchmarkType}"`);
        }
        if (row.Period !== EXPORT_PERIOD) {
            schemaProblems.push(`Line ${row.__line}: Period is "${row.Period}", expected "${EXPORT_PERIOD}"`);
        }

        // Settled decision 1 breaks ties on the unrounded age grade, so the two
        // columns disagreeing means the number that decided a tie is not the
        // number the page shows. Checked only when present: whether the column
        // is populated at all belongs to CSV validation, which owns the export
        // schema. The page cannot confirm this either way, which is exactly why
        // the export has to carry it.
        if (row.AgeGradeExact && !roundsToOneDecimal(row.AgeGradeExact, row.AgeGrade)) {
            schemaProblems.push(
                `Line ${row.__line}: AgeGradeExact "${row.AgeGradeExact}" does not round to AgeGrade "${row.AgeGrade}"`
            );
        }
    }

    for (const [key, selection] of renderedSelections) {
        const row = byKey.get(key);

        if (selection.empty) {
            if (row) {
                absentFromPage.push({
                    key: describeKey(key),
                    exported: `${row.Time} / ${row.AgeGrade} / ${row.Date} / ${row.Event}`
                });
            }
            continue;
        }

        if (!row) {
            missingFromExport.push({ key: describeKey(key), rendered: summariseSelection(selection) });
            continue;
        }

        const differences = [];

        if (row.Time !== selection.time) {
            differences.push(`Time: export "${row.Time}", page "${selection.time}"`);
        }
        if (row.AgeGrade !== selection.ageGrade) {
            differences.push(`AgeGrade: export "${row.AgeGrade}", page "${selection.ageGrade}"`);
        }
        if (row.Event !== selection.event) {
            differences.push(`Event: export "${row.Event}", page "${selection.event}"`);
        }

        if (differences.length > 0) {
            differ.push({ key: describeKey(key), differences });
        } else {
            agree.push(describeKey(key));
        }
    }

    // Rows whose key never appeared on any card at all: an athlete the page does
    // not render, or a distance/class/benchmark combination outside the five
    // cards. These are separate from "the card was empty".
    for (const [key, row] of byKey) {
        if (!renderedSelections.has(key)) {
            absentFromPage.push({
                key: describeKey(key),
                exported: `${row.Time} / ${row.AgeGrade} / ${row.Date} / ${row.Event}`,
                note: 'no corresponding card on the page'
            });
        }
    }

    return {
        clean: schemaProblems.length === 0
            && differ.length === 0
            && missingFromExport.length === 0
            && absentFromPage.length === 0,
        counts: {
            agree: agree.length,
            differ: differ.length,
            missingFromExport: missingFromExport.length,
            absentFromPage: absentFromPage.length,
            schemaProblems: schemaProblems.length
        },
        schemaProblems,
        differ,
        missingFromExport,
        absentFromPage
    };
}

function reportComparison(comparison, exportPath) {
    console.log(`\nCompared ${path.relative(repoRoot, exportPath)} against rendered output.\n`);
    console.log(`  agree                ${comparison.counts.agree}`);
    console.log(`  differ               ${comparison.counts.differ}`);
    console.log(`  missing from export  ${comparison.counts.missingFromExport}`);
    console.log(`  absent from page     ${comparison.counts.absentFromPage}`);
    console.log(`  schema problems      ${comparison.counts.schemaProblems}`);

    if (comparison.schemaProblems.length > 0) {
        console.error('\nSchema problems:');
        for (const problem of comparison.schemaProblems) {
            console.error(`  - ${problem}`);
        }
    }

    if (comparison.differ.length > 0) {
        console.error('\nThe export and the page select different performances:');
        for (const entry of comparison.differ) {
            console.error(`  - ${entry.key}`);
            for (const difference of entry.differences) {
                console.error(`      ${difference}`);
            }
        }
    }

    if (comparison.missingFromExport.length > 0) {
        console.error('\nThe page shows a benchmark the export does not carry:');
        for (const entry of comparison.missingFromExport) {
            console.error(`  - ${entry.key}: page shows ${entry.rendered}`);
        }
    }

    if (comparison.absentFromPage.length > 0) {
        console.error('\nThe export carries a benchmark the page does not show:');
        for (const entry of comparison.absentFromPage) {
            console.error(`  - ${entry.key}: export has ${entry.exported}${entry.note ? ` (${entry.note})` : ''}`);
        }
    }

    if (comparison.clean) {
        console.log('\nNo differences. The export selects exactly what the page renders today.');
    } else {
        console.error('\nEvery difference above is a decision: a workbook defect, or a deliberate supersede.');
        console.error('Neither should be discovered after the page starts reading the export.');
    }
}

async function writeSpecimen(target, renderedSelections) {
    const lines = [EXPORT_COLUMNS.join(',')];
    const sortOrderByAthlete = new Map();

    // Ordered the way the cards render, so the specimen reads in the same
    // sequence a person sees on the profile.
    for (const [key, selection] of [...renderedSelections].sort(compareSelectionOrder)) {
        if (selection.empty) {
            continue;
        }

        const [athleteId, distance, timeClass, benchmarkType] = key.split(KEY_SEPARATOR);
        const nextSortOrder = (sortOrderByAthlete.get(athleteId) || 0) + 1;
        sortOrderByAthlete.set(athleteId, nextSortOrder);

        lines.push([
            athleteId,
            distance,
            timeClass,
            EXPORT_PERIOD,
            benchmarkType,
            selection.time,
            selection.ageGrade,
            // AgeGradeExact and Date are both left empty, for the same reason.
            // The page shows an age grade rounded to one decimal place and a
            // formatted date; neither underlying value is recoverable from the
            // DOM. The workbook owns both, and copying the rounded age grade
            // here would fabricate a precision that does not exist.
            '',
            '',
            selection.event,
            '',
            String(nextSortOrder),
            SPECIMEN_BUNDLE_ID
        ].map(toCsvValue).join(','));
    }

    await fs.writeFile(target, `${lines.join('\n')}\n`, 'utf8');

    console.log(`\nWrote ${lines.length - 1} rendered selections to ${path.relative(repoRoot, target)}.`);
    console.log(`Its ExportBundleID is ${SPECIMEN_BUNDLE_ID}. This is a specimen of current browser behaviour,`);
    console.log('not an export. Do not place it in data/ or list it in a manifest.');
}

function compareSelectionOrder([leftKey], [rightKey]) {
    const left = leftKey.split(KEY_SEPARATOR);
    const right = rightKey.split(KEY_SEPARATOR);

    return left[0].localeCompare(right[0])
        || SUPPORTED_DISTANCES.indexOf(left[1]) - SUPPORTED_DISTANCES.indexOf(right[1])
        || TIME_CLASSES.indexOf(left[2]) - TIME_CLASSES.indexOf(right[2])
        || BENCHMARK_TYPES.indexOf(left[3]) - BENCHMARK_TYPES.indexOf(right[3]);
}

export function roundsToOneDecimal(exact, displayed) {
    const exactNumber = Number(String(exact).replace('%', '').trim());
    const displayedNumber = Number(String(displayed).replace('%', '').trim());

    if (!Number.isFinite(exactNumber) || !Number.isFinite(displayedNumber)) {
        return false;
    }

    return Math.abs(Math.round(exactNumber * 10) / 10 - displayedNumber) < 1e-9;
}

export function toCsvValue(value) {
    const text = String(value ?? '');

    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
