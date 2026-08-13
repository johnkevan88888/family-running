// Tests the comparison logic in `scripts/reconcile-personal-bests.mjs` without
// launching a browser.
//
// The harness itself is only useful if it reports a real disagreement between a
// draft export and the page. Proving it agrees with a self-consistent fixture is
// half the job; these cases exist so that a harness which silently reports
// "no differences" for everything cannot pass.

import {
    compareExportAgainstRendered,
    findModeDisagreements,
    selectionKey,
    summariseSelection,
    toCsvValue
} from '../scripts/reconcile-personal-bests.mjs';

const failures = [];

runComparisonTests();
runModeComparisonTests();
runCsvQuotingTests();

if (failures.length) {
    console.error('Personal-best reconciliation tests failed:');
    for (const failure of failures) {
        console.error(`- ${failure}`);
    }
    process.exit(1);
}

console.log('Personal-best reconciliation tests passed.');

function runComparisonTests() {
    const rendered = renderedFixture();

    check(
        'an export matching rendered output reports no differences',
        () => {
            const result = compareExportAgainstRendered(exportFixture(), rendered);
            assert(result.clean, 'expected a clean comparison');
            assertEqual(result.counts.agree, 2, 'agree count');
        }
    );

    check(
        'a different selected time is reported as a difference, not agreement',
        () => {
            const exported = exportFixture();
            exported.rows[0].Time = '00:19:59';

            const result = compareExportAgainstRendered(exported, rendered);
            assert(!result.clean, 'expected a dirty comparison');
            assertEqual(result.counts.differ, 1, 'differ count');
            assert(
                result.differ[0].differences.some(line => line.includes('00:19:59')),
                'expected the differing time to be reported'
            );
        }
    );

    check(
        'a benchmark the page shows but the export omits is reported',
        () => {
            const exported = exportFixture();
            exported.rows = [exported.rows[0]];

            const result = compareExportAgainstRendered(exported, rendered);
            assertEqual(result.counts.missingFromExport, 1, 'missing-from-export count');
        }
    );

    check(
        'a benchmark the export carries for an empty card is reported',
        () => {
            const exported = exportFixture();
            exported.rows.push(exportRow({
                AthleteId: 'runner-one',
                Distance: 'Marathon',
                BenchmarkType: 'Fastest Time',
                Time: '03:00:00',
                AgeGrade: '70.0%',
                Event: 'Invented Race'
            }));

            const result = compareExportAgainstRendered(exported, rendered);
            assertEqual(result.counts.absentFromPage, 1, 'absent-from-page count');
        }
    );

    check(
        'a row whose key matches no card at all is reported rather than ignored',
        () => {
            const exported = exportFixture();
            exported.rows.push(exportRow({
                AthleteId: 'nobody-at-all',
                Distance: '5 km',
                BenchmarkType: 'Fastest Time',
                Time: '00:20:00',
                AgeGrade: '65.0%',
                Event: 'Invented Race'
            }));

            const result = compareExportAgainstRendered(exported, rendered);
            assertEqual(result.counts.absentFromPage, 1, 'absent-from-page count');
            assert(
                result.absentFromPage[0].note?.includes('no corresponding card'),
                'expected the missing-card note'
            );
        }
    );

    check(
        'a duplicate key is a schema problem rather than a silent overwrite',
        () => {
            const exported = exportFixture();
            exported.rows.push({ ...exported.rows[0], __line: 99 });

            const result = compareExportAgainstRendered(exported, rendered);
            assert(!result.clean, 'expected a dirty comparison');
            assert(
                result.schemaProblems.some(problem => problem.startsWith('Duplicate row')),
                'expected a duplicate-row problem'
            );
        }
    );

    check(
        'a Period other than All Time is a schema problem',
        () => {
            const exported = exportFixture();
            exported.rows[0].Period = 'Current';

            const result = compareExportAgainstRendered(exported, rendered);
            assert(
                result.schemaProblems.some(problem => problem.includes('Period is "Current"')),
                'expected a Period problem'
            );
        }
    );

    check(
        'unsupported vocabulary is a schema problem',
        () => {
            const exported = exportFixture();
            exported.rows[0].Distance = '1 Mile';
            exported.rows[1].BenchmarkType = 'Longest Run';

            const result = compareExportAgainstRendered(exported, rendered);
            assert(
                result.schemaProblems.some(problem => problem.includes('unsupported Distance')),
                'expected an unsupported-distance problem'
            );
            assert(
                result.schemaProblems.some(problem => problem.includes('unsupported BenchmarkType')),
                'expected an unsupported-benchmark problem'
            );
        }
    );

    check(
        'a missing or unexpected column is a schema problem',
        () => {
            const exported = exportFixture();
            exported.missing = ['SourceRow'];
            exported.unexpected = ['Nickname'];

            const result = compareExportAgainstRendered(exported, rendered);
            assert(
                result.schemaProblems.some(problem => problem === 'Missing column: SourceRow'),
                'expected a missing-column problem'
            );
            assert(
                result.schemaProblems.some(problem => problem === 'Unexpected column: Nickname'),
                'expected an unexpected-column problem'
            );
        }
    );
}

function runModeComparisonTests() {
    check(
        'identical modes report no disagreement',
        () => {
            const byMode = new Map([
                ['family', renderedFixture()],
                ['everyone', renderedFixture()]
            ]);

            assertEqual(findModeDisagreements(byMode, ['family', 'everyone']).length, 0, 'disagreement count');
        }
    );

    check(
        'a mode selecting a different performance is reported',
        () => {
            const everyone = renderedFixture();
            const key = selectionKey('runner-one', '5 km', 'Official', 'Fastest Time');
            everyone.set(key, { ...everyone.get(key), time: '00:21:11' });

            const byMode = new Map([['family', renderedFixture()], ['everyone', everyone]]);
            const disagreements = findModeDisagreements(byMode, ['family', 'everyone']);

            assertEqual(disagreements.length, 1, 'disagreement count');
            assert(disagreements[0].includes('00:21:11'), 'expected the differing time in the message');
        }
    );

    check(
        'a benchmark present in one mode and empty in the other is reported',
        () => {
            const everyone = renderedFixture();
            const key = selectionKey('runner-one', '5 km', 'Official', 'Fastest Time');
            everyone.set(key, { empty: true });

            const byMode = new Map([['family', renderedFixture()], ['everyone', everyone]]);
            const disagreements = findModeDisagreements(byMode, ['family', 'everyone']);

            assertEqual(disagreements.length, 1, 'disagreement count');
            assert(disagreements[0].includes('no value'), 'expected the empty state in the message');
        }
    );

    check(
        'a single mode cannot disagree with itself',
        () => {
            const byMode = new Map([['family', renderedFixture()]]);
            assertEqual(findModeDisagreements(byMode, ['family']).length, 0, 'disagreement count');
        }
    );

    check(
        'an absent selection summarises as no value rather than throwing',
        () => {
            assertEqual(summariseSelection(undefined), 'no value', 'summary of a missing selection');
        }
    );
}

function runCsvQuotingTests() {
    check(
        'values containing a comma, quote, or newline are quoted',
        () => {
            assertEqual(toCsvValue('Worcester Parkrun'), 'Worcester Parkrun', 'plain value');
            assertEqual(toCsvValue('Race, The Second'), '"Race, The Second"', 'comma value');
            assertEqual(toCsvValue('The "Big" One'), '"The ""Big"" One"', 'quoted value');
            assertEqual(toCsvValue('One\nTwo'), '"One\nTwo"', 'newline value');
            assertEqual(toCsvValue(null), '', 'null value');
        }
    );
}

// One athlete with a 5 km card carrying both benchmarks, and a Marathon card
// that renders empty. That combination covers the two states the comparison has
// to tell apart: a selection to compare, and a deliberate absence.
function renderedFixture() {
    const selections = new Map();

    const add = (distance, timeClass, benchmarkType, selection) => {
        selections.set(
            selectionKey('runner-one', distance, timeClass, benchmarkType),
            { athleteId: 'runner-one', athleteName: 'Runner One', distance, timeClass, benchmarkType, ...selection }
        );
    };

    add('5 km', 'Official', 'Best Age Grade', {
        empty: false,
        time: '00:25:17',
        ageGrade: '53.9%',
        displayDate: '7 June 2026',
        event: 'Worcester Parkrun'
    });
    add('5 km', 'Official', 'Fastest Time', {
        empty: false,
        time: '00:24:51',
        ageGrade: '52.8%',
        displayDate: '2 May 2026',
        event: 'Worcester Parkrun'
    });
    add('Marathon', 'Official', 'Best Age Grade', { empty: true });
    add('Marathon', 'Official', 'Fastest Time', { empty: true });

    return selections;
}

function exportFixture() {
    return {
        header: [],
        missing: [],
        unexpected: [],
        rows: [
            exportRow({
                AthleteId: 'runner-one',
                Distance: '5 km',
                BenchmarkType: 'Best Age Grade',
                Time: '00:25:17',
                AgeGrade: '53.9%',
                Event: 'Worcester Parkrun',
                __line: 2
            }),
            exportRow({
                AthleteId: 'runner-one',
                Distance: '5 km',
                BenchmarkType: 'Fastest Time',
                Time: '00:24:51',
                AgeGrade: '52.8%',
                Event: 'Worcester Parkrun',
                __line: 3
            })
        ]
    };
}

function exportRow(overrides) {
    return {
        __line: 2,
        AthleteId: '',
        Distance: '',
        TimeClass: 'Official',
        Period: 'All Time',
        BenchmarkType: '',
        Time: '',
        AgeGrade: '',
        Date: '',
        Event: '',
        SourceRow: '',
        SortOrder: '1',
        ExportBundleID: 'TEST',
        ...overrides
    };
}

function check(description, body) {
    try {
        body();
        console.log(`PASS - ${description}`);
    } catch (error) {
        failures.push(`${description}: ${error.message}`);
        console.error(`FAIL - ${description}: ${error.message}`);
    }
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function assertEqual(actual, expected, label) {
    if (actual !== expected) {
        throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}
