import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const validatorPath = path.join(repoRoot, 'scripts', 'validate-csv.mjs');
const sourceData = path.join(repoRoot, 'data');
const officialNewsHeaders = [
    'SortOrder',
    'SourceRow',
    'AthleteID',
    'AthleteName',
    'ResultDate',
    'Distance',
    'Time',
    'AgeGrade',
    'AgeGradeExact',
    'Event',
    'TimeClass',
    'MilestoneType',
    'PreviousBestTime',
    'TimeImprovementSeconds',
    'TimeImprovement',
    'PreviousBestAgeGrade',
    'PreviousBestAgeGradeExact',
    'AgeGradeImprovementExact',
    'AgeGradeImprovement',
    'CurrentDistanceRankBefore',
    'CurrentDistanceRankAfter',
    'CurrentDistanceRankedAthleteCountAfter',
    'CurrentDistancePlacesGained',
    'CurrentDistanceMedalEntry',
    'CurrentDistanceMedalBefore',
    'CurrentDistanceMedalAfter',
    'CurrentDistanceDisplacedAthleteID',
    'CurrentDistanceDisplacedAthleteName',
    'CurrentDistanceDisplacedMedalBefore',
    'CurrentDistanceDisplacedMedalAfter',
    'CurrentOverallRankBefore',
    'CurrentOverallRankAfter',
    'CurrentOverallRankedAthleteCountAfter',
    'CurrentOverallPlacesGained',
    'CurrentOverallMedalEntry',
    'CurrentOverallMedalBefore',
    'CurrentOverallMedalAfter',
    'CurrentOverallDisplacedAthleteID',
    'CurrentOverallDisplacedAthleteName',
    'CurrentOverallDisplacedMedalBefore',
    'CurrentOverallDisplacedMedalAfter',
    'AllTimeDistanceRankBefore',
    'AllTimeDistanceRankAfter',
    'AllTimeDistanceRankedAthleteCountAfter',
    'AllTimeDistancePlacesGained',
    'AllTimeDistanceMedalEntry',
    'AllTimeDistanceMedalBefore',
    'AllTimeDistanceMedalAfter',
    'AllTimeDistanceDisplacedAthleteID',
    'AllTimeDistanceDisplacedAthleteName',
    'AllTimeDistanceDisplacedMedalBefore',
    'AllTimeDistanceDisplacedMedalAfter',
    'AllTimeOverallRankBefore',
    'AllTimeOverallRankAfter',
    'AllTimeOverallRankedAthleteCountAfter',
    'AllTimeOverallPlacesGained',
    'AllTimeOverallMedalEntry',
    'AllTimeOverallMedalBefore',
    'AllTimeOverallMedalAfter',
    'AllTimeOverallDisplacedAthleteID',
    'AllTimeOverallDisplacedAthleteName',
    'AllTimeOverallDisplacedMedalBefore',
    'AllTimeOverallDisplacedMedalAfter',
    'ExportBundleID'
];
const officialNewsColumn = new Map(officialNewsHeaders.map((header, index) => [header, index]));
const officialNewsRankContextPrefixes = [
    'CurrentDistance',
    'CurrentOverall',
    'AllTimeDistance',
    'AllTimeOverall'
];
const officialNewsMedalContextFixtures = [
    {
        label: 'Current Distance',
        prefix: 'CurrentDistance',
        medal: 'Bronze',
        wrongMedal: 'Gold',
        before: '4',
        after: '3',
        gain: '1'
    },
    {
        label: 'Current Overall',
        prefix: 'CurrentOverall',
        medal: 'Silver',
        wrongMedal: 'Gold',
        before: '4',
        after: '2',
        gain: '2'
    },
    {
        label: 'All-Time Distance',
        prefix: 'AllTimeDistance',
        medal: 'Bronze',
        wrongMedal: 'Silver',
        before: '4',
        after: '3',
        gain: '1'
    },
    {
        label: 'All-Time Overall',
        prefix: 'AllTimeOverall',
        medal: 'Gold',
        wrongMedal: 'Bronze',
        before: '4',
        after: '1',
        gain: '3'
    }
];
const officialNewsMedalContextCases = officialNewsMedalContextFixtures.flatMap(context => [
    {
        name: `official result News rejects a missing ${context.label} medal entry`,
        expected:
            `${context.prefix}MedalEntry must be "${context.medal}" because the result ` +
            `entered a medal position at Rank ${context.after}.`,
        mutate: async root => {
            await configureOfficialNewsMedalCrossing(root, context, '');
        }
    },
    {
        name: `official result News rejects a wrong ${context.label} medal entry`,
        expected:
            `${context.prefix}MedalEntry must be "${context.medal}" because the result ` +
            `entered a medal position at Rank ${context.after}.`,
        mutate: async root => {
            await configureOfficialNewsMedalCrossing(root, context, context.wrongMedal);
        }
    },
    {
        name: `official result News rejects an extraneous ${context.label} medal entry`,
        expected: `${context.prefix}MedalEntry must be blank because the result did not enter a new medal position.`,
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'everyone', 1, `${context.prefix}MedalEntry`, context.medal);
        }
    }
]);
const officialNewsMedalSnapshotContextCases = officialNewsMedalContextFixtures.flatMap(context => [
    {
        name: `official result News rejects a missing ${context.label} after-medal snapshot`,
        expected:
            `${context.prefix}MedalAfter must be "${context.medal}" because ` +
            `${context.prefix}RankAfter is Rank ${context.after}.`,
        mutate: async root => {
            await configureOfficialNewsMedalCrossing(root, context, context.medal);
            await mutateOfficialNewsRow(root, 'everyone', 3, `${context.prefix}MedalAfter`, '');
        }
    },
    {
        name: `official result News rejects a wrong ${context.label} after-medal snapshot`,
        expected:
            `${context.prefix}MedalAfter must be "${context.medal}" because ` +
            `${context.prefix}RankAfter is Rank ${context.after}.`,
        mutate: async root => {
            await configureOfficialNewsMedalCrossing(root, context, context.medal);
            await mutateOfficialNewsRow(root, 'everyone', 3, `${context.prefix}MedalAfter`, context.wrongMedal);
        }
    }
]);
const officialNewsOneMileMedalCases = [
    'CurrentDistanceRankedAthleteCountAfter',
    'CurrentDistanceMedalEntry',
    'CurrentDistanceMedalBefore',
    'CurrentDistanceMedalAfter',
    'CurrentDistanceDisplacedAthleteID',
    'CurrentDistanceDisplacedAthleteName',
    'CurrentDistanceDisplacedMedalBefore',
    'CurrentDistanceDisplacedMedalAfter',
    'AllTimeDistanceMedalEntry',
    'AllTimeDistanceRankedAthleteCountAfter',
    'AllTimeDistanceMedalBefore',
    'AllTimeDistanceMedalAfter',
    'AllTimeDistanceDisplacedAthleteID',
    'AllTimeDistanceDisplacedAthleteName',
    'AllTimeDistanceDisplacedMedalBefore',
    'AllTimeDistanceDisplacedMedalAfter'
].map(field => ({
    name: `1 Mile News row cannot carry ${field}`,
    expected: `${field} must be blank because 1 Mile has no dedicated Official distance leaderboard.`,
    mutate: async root => {
        await mutateOfficialNewsRow(root, 'everyone', 4, field, 'Gold');
    }
}));

const cases = [
    {
        name: 'valid official result News exports',
        expectPass: true,
        mutate: async () => {}
    },
    {
        name: 'header-only official result News exports',
        expectPass: true,
        mutate: async root => {
            for (const mode of ['family', 'everyone']) {
                await writeOfficialNews(root, mode, [officialNewsHeaders]);
                await setManifestRowCount(root, `data/${mode}/official_result_news.csv`, 0);
            }
        }
    },
    {
        name: 'required official result News manifest path missing',
        expected: 'Missing required manifest path "data/family/official_result_news.csv".',
        mutate: async root => {
            await fs.rm(officialNewsPath(root, 'family'));
            const manifestFile = path.join(root, 'data', 'export_manifest.csv');
            const lines = splitLines(await fs.readFile(manifestFile, 'utf8'))
                .filter(line => !line.includes(',data/family/official_result_news.csv,'));
            await fs.writeFile(manifestFile, `${lines.join('\r\n')}\r\n`);
        }
    },
    {
        name: 'incomplete Official leaderboard matrix',
        expected: 'Official leaderboard matrix requires exactly one webtables.csv row for "5km-current-official-family.csv", found 0.',
        mutate: async root => {
            const file = path.join(root, 'data', 'family', 'webtables.csv');
            const lines = splitLines(await fs.readFile(file, 'utf8'))
                .filter(line => !line.includes(',5km-current-official-family.csv,'));
            await fs.writeFile(file, `${lines.join('\r\n')}\r\n`);
            await setManifestRowCount(root, 'data/family/webtables.csv', lines.length - 1);
        }
    },
    {
        name: 'Official leaderboard matrix rejects a non-Official populated row',
        expected: 'Official leaderboard matrix row must have Time Class "Official", found "All".',
        mutate: async root => {
            const file = path.join(root, 'data', 'family', '5km-current-official-family.csv');
            const lines = splitLines(await fs.readFile(file, 'utf8'));
            lines[1] = replaceCsvField(lines[1], 3, 'All');
            await fs.writeFile(file, `${lines.join('\r\n')}\r\n`);
        }
    },
    {
        name: 'official result News header out of order',
        expected: 'Header must exactly match:',
        mutate: async root => {
            const rows = await readOfficialNews(root, 'family');
            [rows[0][7], rows[0][8]] = [rows[0][8], rows[0][7]];
            await writeOfficialNews(root, 'family', rows);
        }
    },
    {
        name: 'unofficial row in official result News',
        expected: 'TimeClass "Unofficial" does not match the Official Result News contract value "Official".',
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'family', 1, 'TimeClass', 'Unofficial');
        }
    },
    {
        name: 'official result News SortOrder gap',
        expected: 'SortOrder 3 is out of sequence: file row 2 must be SortOrder 2.',
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'family', 2, 'SortOrder', '3');
        }
    },
    {
        name: 'official result News source performance mismatch',
        expected: 'Displayed source performance must match exactly one Official row in data/athlete_results.csv; found 0.',
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'family', 1, 'Event', 'Not the exported event');
        }
    },
    {
        name: 'subsecond News time must round to the public source time',
        expected: 'Displayed source performance must match exactly one Official row in data/athlete_results.csv; found 0.',
        mutate: async root => {
            await mutateOfficialNewsMatchingRow(
                root,
                'everyone',
                row => row.AthleteID === 'jess-graham-kevan',
                'Time',
                '00:11:18.6'
            );
        }
    },
    {
        name: '1 Mile News row has no dedicated distance rank',
        expected: 'CurrentDistanceRankAfter must be blank because 1 Mile has no dedicated Official distance leaderboard.',
        mutate: async root => {
            await mutateOfficialNewsMatchingRow(
                root,
                'everyone',
                row => row.AthleteID === 'jess-graham-kevan',
                'CurrentDistanceRankAfter',
                '1'
            );
        }
    },
    {
        name: 'official result News requires a post-result ranked-athlete count',
        expected: 'CurrentDistanceRankedAthleteCountAfter is required.',
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'everyone', 1, 'CurrentDistanceRankedAthleteCountAfter', '');
        }
    },
    {
        name: 'official result News rejects a non-integer post-result ranked-athlete count',
        expected: 'CurrentDistanceRankedAthleteCountAfter "twelve" must be a non-negative integer.',
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'everyone', 1, 'CurrentDistanceRankedAthleteCountAfter', 'twelve');
        }
    },
    {
        name: 'official result News rejects a zero post-result ranked-athlete count',
        expected: 'CurrentDistanceRankedAthleteCountAfter "0" must be an integer of at least 1.',
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'everyone', 1, 'CurrentDistanceRankedAthleteCountAfter', '0');
        }
    },
    {
        name: 'official result News rejects a post-result ranked-athlete count below the after rank',
        expected: 'CurrentDistanceRankedAthleteCountAfter 2 must be at least CurrentDistanceRankAfter 3.',
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'everyone', 1, 'CurrentDistanceRankedAthleteCountAfter', '2');
        }
    },
    {
        name: 'official result News accepts a ranked-athlete count above the competition rank',
        expectPass: true,
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'everyone', 1, 'CurrentDistanceRankedAthleteCountAfter', '4');
        }
    },
    {
        name: 'official result News exact age grade does not round to display',
        expected: 'AgeGradeExact "52.86%" does not round to AgeGrade "52.8%" at one decimal place.',
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'family', 1, 'AgeGradeExact', '52.86%');
        }
    },
    {
        name: 'first official result contains invented previous value',
        expected: 'PreviousBestTime must be blank for MilestoneType "First Official Result".',
        mutate: async root => {
            const rows = await readOfficialNews(root, 'family');
            await mutateOfficialNewsRow(
                root,
                'family',
                rows.length - 1,
                'PreviousBestTime',
                '00:30:00'
            );
        }
    },
    {
        name: 'official result News raw-time delta mismatch',
        expected: 'TimeImprovementSeconds 25 must equal PreviousBestTime minus Time (26).',
        mutate: async root => {
            await mutateOfficialNewsMatchingRow(
                root,
                'family',
                row => row.ResultDate === '31/08/2019',
                'TimeImprovementSeconds',
                '25'
            );
        }
    },
    {
        name: 'official result News tiny age-grade improvement rendered as zero',
        expected: 'AgeGradeImprovement "+0.00 pp" must be "+<0.01 pp"',
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'everyone', 1, 'AgeGradeImprovement', '+0.00 pp');
        }
    },
    {
        name: 'official result News rank gain mismatch',
        expected: 'AllTimeOverallPlacesGained 0 must equal AllTimeOverallRankBefore minus AllTimeOverallRankAfter (1).',
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'everyone', 1, 'AllTimeOverallPlacesGained', '0');
        }
    },
    {
        name: 'official result News supports independent multi-context medal entries',
        expectPass: true,
        mutate: async root => {
            const changes = [
                ['CurrentOverallRankAfter', '2'],
                ['CurrentOverallMedalEntry', 'Silver'],
                ['CurrentOverallMedalAfter', 'Silver'],
                ['AllTimeOverallRankBefore', '4'],
                ['AllTimeOverallRankAfter', '1'],
                ['AllTimeOverallPlacesGained', '3'],
                ['AllTimeOverallMedalEntry', 'Gold'],
                ['AllTimeOverallMedalAfter', 'Gold']
            ];

            for (const [field, value] of changes) {
                await mutateOfficialNewsRow(root, 'everyone', 4, field, value);
            }
        }
    },
    // The News row carries the workbook's competition rank, not a leaderboard
    // row offset. A tied Rank 2 therefore follows the same direct Silver rule;
    // the repository neither detects nor breaks the tie.
    {
        name: 'competition Rank 2 maps directly to a Silver medal entry',
        expectPass: true,
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'everyone', 4, 'CurrentOverallRankAfter', '2');
            await mutateOfficialNewsRow(root, 'everyone', 4, 'CurrentOverallMedalEntry', 'Silver');
            await mutateOfficialNewsRow(root, 'everyone', 4, 'CurrentOverallMedalAfter', 'Silver');
        }
    },
    {
        name: 'moving from Bronze to Silver preserves snapshots without a new medal entry',
        expectPass: true,
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'everyone', 1, 'CurrentDistanceRankAfter', '2');
            await mutateOfficialNewsRow(root, 'everyone', 1, 'CurrentDistancePlacesGained', '1');
            await mutateOfficialNewsRow(root, 'everyone', 1, 'CurrentDistanceMedalAfter', 'Silver');
        }
    },
    {
        name: 'moving from Silver to Gold preserves snapshots without a new medal entry',
        expectPass: true,
        mutate: async root => {
            await configureOfficialNewsMedalSnapshot(root, 'CurrentDistance', {
                before: '2',
                after: '1',
                gain: '1',
                medalEntry: '',
                medalBefore: 'Silver',
                medalAfter: 'Gold'
            });
        }
    },
    {
        name: 'official result News supports a complete Gold-to-Silver displaced-athlete snapshot',
        expectPass: true,
        mutate: async root => {
            await configureOfficialNewsMedalSnapshot(root, 'CurrentDistance', {
                before: '2',
                after: '1',
                gain: '1',
                medalEntry: '',
                medalBefore: 'Silver',
                medalAfter: 'Gold'
            });
            await configureOfficialNewsDisplacement(root, 'everyone', 3, 'CurrentDistance', {
                athleteId: 'ben-graham-kevan',
                athleteName: 'Ben Graham-Kevan',
                medalBefore: 'Gold',
                medalAfter: 'Silver'
            });
        }
    },
    {
        name: 'official result News supports a complete Silver-to-Bronze displaced-athlete snapshot',
        expectPass: true,
        mutate: async root => {
            await configureOfficialNewsMedalSnapshot(root, 'CurrentDistance', {
                before: '3',
                after: '2',
                gain: '1',
                medalEntry: '',
                medalBefore: 'Bronze',
                medalAfter: 'Silver'
            });
            await configureOfficialNewsDisplacement(root, 'everyone', 3, 'CurrentDistance', {
                athleteId: 'ben-graham-kevan',
                athleteName: 'Ben Graham-Kevan',
                medalBefore: 'Silver',
                medalAfter: 'Bronze'
            });
        }
    },
    {
        name: 'official result News rejects a partial displaced-athlete snapshot',
        expected:
            'CurrentDistanceDisplacedAthleteID, CurrentDistanceDisplacedAthleteName, ' +
            'CurrentDistanceDisplacedMedalBefore, CurrentDistanceDisplacedMedalAfter ' +
            'must be either all blank or all populated.',
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'everyone', 2, 'CurrentDistanceDisplacedAthleteName', '');
        }
    },
    {
        name: 'official result News rejects a displaced-athlete snapshot on a retained medal position',
        expected:
            'CurrentDistanceDisplacedAthleteID, CurrentDistanceDisplacedAthleteName, ' +
            'CurrentDistanceDisplacedMedalBefore, CurrentDistanceDisplacedMedalAfter ' +
            'must be blank unless the focal athlete moves into a different medal position.',
        mutate: async root => {
            await configureOfficialNewsDisplacement(root, 'everyone', 1, 'CurrentDistance', {
                athleteId: 'ben-graham-kevan',
                athleteName: 'Ben Graham-Kevan',
                medalBefore: 'Bronze',
                medalAfter: 'No medal'
            });
        }
    },
    {
        name: 'official result News rejects a displaced athlete outside the selected site mode',
        expected: 'CurrentDistanceDisplacedAthleteID "jim-chambers" is not eligible for the family site mode.',
        mutate: async root => {
            await configureOfficialNewsMedalSnapshot(
                root,
                'CurrentDistance',
                {
                    before: '2',
                    after: '1',
                    gain: '1',
                    medalEntry: '',
                    medalBefore: 'Silver',
                    medalAfter: 'Gold'
                },
                { mode: 'family', dataRowNumber: 1 }
            );
            await configureOfficialNewsDisplacement(root, 'family', 1, 'CurrentDistance', {
                athleteId: 'jim-chambers',
                athleteName: 'Jim Chambers',
                medalBefore: 'Gold',
                medalAfter: 'Silver'
            });
        }
    },
    {
        name: 'official result News rejects a displaced athlete with a mismatched public name',
        expected:
            'CurrentDistanceDisplacedAthleteID and CurrentDistanceDisplacedAthleteName must match ' +
            'one athlete identity in data/athlete_results.csv.',
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'everyone', 2, 'CurrentDistanceDisplacedAthleteName', 'Jim Chambers');
        }
    },
    {
        name: 'official result News rejects an unknown displaced athlete ID',
        expected:
            'CurrentDistanceDisplacedAthleteID "not-a-real-athlete" does not exist in data/athlete_results.csv.',
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'everyone', 2, 'CurrentDistanceDisplacedAthleteID', 'not-a-real-athlete');
        }
    },
    {
        name: 'official result News rejects the focal athlete as the displaced athlete',
        expected: 'CurrentDistanceDisplacedAthleteID must identify a different athlete from AthleteID.',
        mutate: async root => {
            await configureOfficialNewsDisplacement(root, 'everyone', 2, 'CurrentDistance', {
                athleteId: 'jim-chambers',
                athleteName: 'Jim Chambers',
                medalBefore: 'Bronze',
                medalAfter: 'No medal'
            });
        }
    },
    {
        name: 'official result News rejects a displaced medal that does not match the focal MedalAfter',
        expected:
            'CurrentDistanceDisplacedMedalBefore must be "Bronze" because it is the focal athlete\'s MedalAfter.',
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'everyone', 2, 'CurrentDistanceDisplacedMedalBefore', 'Gold');
        }
    },
    {
        name: 'official result News rejects an unsupported displaced before-medal label',
        expected:
            'CurrentDistanceDisplacedMedalBefore "Platinum" must be one of: Gold, Silver, Bronze.',
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'everyone', 2, 'CurrentDistanceDisplacedMedalBefore', 'Platinum');
        }
    },
    {
        name: 'official result News rejects an unsupported displaced after-medal label',
        expected:
            'CurrentDistanceDisplacedMedalAfter "Platinum" must be one of: Gold, Silver, Bronze, No medal.',
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'everyone', 2, 'CurrentDistanceDisplacedMedalAfter', 'Platinum');
        }
    },
    {
        name: 'official result News rejects a displaced medal successor that skips the required chain',
        expected:
            'CurrentDistanceDisplacedMedalAfter must be "No medal" after ' +
            'CurrentDistanceDisplacedMedalBefore "Bronze".',
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'everyone', 2, 'CurrentDistanceDisplacedMedalAfter', 'Silver');
        }
    },
    {
        name: 'retained Bronze medal position carries matching snapshots',
        expectPass: true,
        mutate: async root => {
            await configureOfficialNewsMedalSnapshot(root, 'CurrentDistance', {
                before: '3',
                after: '3',
                gain: '0',
                medalEntry: '',
                medalBefore: 'Bronze',
                medalAfter: 'Bronze'
            });
        }
    },
    {
        name: 'official result News rejects a missing prior-medal snapshot for a retained podium rank',
        expected: 'CurrentDistanceMedalBefore must be "Bronze" because CurrentDistanceRankBefore is Rank 3.',
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'everyone', 1, 'CurrentDistanceMedalBefore', '');
        }
    },
    {
        name: 'official result News rejects an unsupported medal-after snapshot',
        expected: 'CurrentDistanceMedalAfter "Platinum" must be blank or one of: Gold, Silver, Bronze.',
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'everyone', 1, 'CurrentDistanceMedalAfter', 'Platinum');
        }
    },
    {
        name: 'official result News rejects a medal snapshot for a non-medal rank',
        expected: 'AllTimeDistanceMedalAfter must be blank because AllTimeDistanceRankAfter 6 is not a medal position.',
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'everyone', 1, 'AllTimeDistanceMedalAfter', 'Bronze');
        }
    },
    ...officialNewsMedalContextCases,
    ...officialNewsMedalSnapshotContextCases,
    {
        name: 'official result News rejects an unsupported medal entry',
        expected: 'CurrentDistanceMedalEntry "Platinum" must be blank or one of: Gold, Silver, Bronze.',
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'everyone', 2, 'CurrentDistanceMedalEntry', 'Platinum');
        }
    },
    ...officialNewsOneMileMedalCases,
    {
        name: 'official result News duplicate SourceRow',
        expected: 'Duplicate SourceRow 54.',
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'family', 2, 'SourceRow', '54');
        }
    },
    {
        name: 'official result News previous exact best breaks the exported chain',
        expected: 'PreviousBestAgeGradeExact "66.996%" does not match the prior exported exact best.',
        mutate: async root => {
            const changes = [
                ['PreviousBestAgeGradeExact', '66.996%'],
                ['AgeGradeImprovementExact', '0.005%'],
                ['AgeGradeImprovement', '+0.01 pp']
            ];
            for (const [field, value] of changes) {
                await mutateOfficialNewsRow(root, 'everyone', 1, field, value);
            }
        }
    },
    {
        name: 'official result News time delta exceeds thousandth precision',
        expected: 'TimeImprovementSeconds "7.1000" must be a non-negative decimal with at most 3 places.',
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'everyone', 3, 'TimeImprovementSeconds', '7.1000');
        }
    },
    {
        name: 'exact age-grade improvement rounds half-up at a binary-hostile boundary',
        expectPass: true,
        mutate: async root => {
            const newsChanges = [
                ['07/10/2017', 'AgeGrade', '51.3%'],
                ['07/10/2017', 'AgeGradeExact', '51.31%'],
                ['14/10/2017', 'AgeGrade', '53.4%'],
                ['14/10/2017', 'AgeGradeExact', '53.445%'],
                ['14/10/2017', 'PreviousBestAgeGrade', '51.3%'],
                ['14/10/2017', 'PreviousBestAgeGradeExact', '51.31%'],
                ['14/10/2017', 'AgeGradeImprovementExact', '2.135%'],
                ['14/10/2017', 'AgeGradeImprovement', '+2.14 pp'],
                ['11/11/2017', 'PreviousBestAgeGrade', '53.4%'],
                ['11/11/2017', 'PreviousBestAgeGradeExact', '53.445%'],
                ['11/11/2017', 'AgeGradeImprovementExact', '0.455%'],
                ['11/11/2017', 'AgeGradeImprovement', '+0.46 pp']
            ];

            for (const mode of ['family', 'everyone']) {
                for (const [resultDate, field, value] of newsChanges) {
                    await mutateOfficialNewsMatchingRow(
                        root,
                        mode,
                        row => row.AthleteID === 'ben-graham-kevan' && row.ResultDate === resultDate,
                        field,
                        value
                    );
                }
            }

            for (const [date, ageGrade] of [
                ['07/10/2017', '51.3%'],
                ['14/10/2017', '53.4%']
            ]) {
                await mutateBundleCsvMatchingRow(
                    root,
                    'data/athlete_results.csv',
                    row => row.AthleteID === 'ben-graham-kevan' && row.Date === date,
                    'AgeGrade',
                    ageGrade
                );
            }
        }
    },
    {
        name: 'exact age-grade arithmetic rejects a near-equal decimal',
        expected: 'AgeGradeImprovementExact "0.0040000005%" must equal AgeGradeExact minus PreviousBestAgeGradeExact.',
        mutate: async root => {
            await mutateOfficialNewsRow(
                root,
                'everyone',
                1,
                'AgeGradeImprovementExact',
                '0.0040000005%'
            );
        }
    },
    {
        name: 'numerically equivalent prior raw-time precision is accepted',
        expectPass: true,
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'family', 1, 'PreviousBestTime', '00:25:17.000');
        }
    },
    {
        name: 'cross-mode rank differences remain site-specific',
        expectPass: true,
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'family', 1, 'CurrentDistanceRankAfter', '3');
            await mutateOfficialNewsRow(root, 'family', 1, 'CurrentDistanceMedalEntry', 'Bronze');
            await mutateOfficialNewsRow(root, 'family', 1, 'CurrentDistanceMedalAfter', 'Bronze');
        }
    },
    {
        name: 'cross-mode ranked-athlete counts remain site-specific',
        expectPass: true,
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'family', 1, 'CurrentDistanceRankedAthleteCountAfter', '13');
        }
    },
    {
        name: 'cross-mode source row mismatch',
        expected: 'Cross-mode SourceRow disagrees for data/athlete_results.csv row',
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'family', 1, 'SourceRow', '55');
        }
    },
    {
        name: 'Family milestone missing from Everyone News',
        expected: 'Family News source at data/athlete_results.csv row',
        mutate: async root => {
            await removeOfficialNewsMatchingRow(
                root,
                'everyone',
                row => row.AthleteID === 'ben-graham-kevan' && row.ResultDate === '31/08/2019'
            );
        }
    },
    {
        name: 'duplicate News rows for one public source result',
        expected: 'Duplicate News rows match data/athlete_results.csv row',
        mutate: async root => {
            for (const [field, value] of [
                ['ResultDate', '31/08/2019'],
                ['Time', '00:24:51'],
                ['AgeGrade', '52.8%'],
                ['AgeGradeExact', '52.8%']
            ]) {
                await mutateOfficialNewsRow(root, 'family', 2, field, value);
            }
        }
    },
    {
        name: 'quoted comma quote and multiline source Event validates',
        expectPass: true,
        mutate: async root => {
            const event = 'Worcester, "Riverside"\nSecond line';
            for (const mode of ['family', 'everyone']) {
                await mutateOfficialNewsMatchingRow(
                    root,
                    mode,
                    row => row.AthleteID === 'ben-graham-kevan' && row.ResultDate === '07/10/2017',
                    'Event',
                    event
                );
            }
            await mutateBundleCsvMatchingRow(
                root,
                'data/athlete_results.csv',
                row => row.AthleteID === 'ben-graham-kevan' && row.Date === '07/10/2017',
                'Event',
                event
            );
        }
    },
    {
        name: 'unsupported News distance',
        expected: 'Distance "3 km" must be one of:',
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'family', 1, 'Distance', '3 km');
        }
    },
    {
        name: 'unsupported News milestone type',
        expected: 'MilestoneType "Personal Best" must be one of:',
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'family', 1, 'MilestoneType', 'Personal Best');
        }
    },
    {
        name: 'same-day News source chronology is reversed',
        expected: 'Rows on the same ResultDate must be in descending authoritative SourceRow order.',
        mutate: async root => {
            await mutateOfficialNewsMatchingRow(
                root,
                'everyone',
                row => row.AthleteID === 'jess-graham-kevan',
                'SourceRow',
                '85'
            );
        }
    },
    {
        name: 'zero exact age-grade improvement',
        expected: 'AgeGradeImprovementExact "0%" must be positive.',
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'everyone', 1, 'AgeGradeImprovementExact', '0%');
        }
    },
    {
        name: 'negative raw-time improvement',
        expected: 'TimeImprovementSeconds "-1" must be a non-negative decimal with at most 3 places.',
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'family', 1, 'TimeImprovementSeconds', '-1');
        }
    },
    {
        name: 'partial News rank triplet',
        expected: 'CurrentDistanceRankAfter is required because the complete Official leaderboard matrix is required.',
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'everyone', 1, 'CurrentDistanceRankAfter', '');
        }
    },
    {
        name: 'News athlete is in the wrong site mode',
        expected: 'AthleteID "jim-chambers" is not eligible for the family site mode.',
        mutate: async root => {
            await mutateOfficialNewsRow(root, 'family', 1, 'AthleteID', 'jim-chambers');
        }
    },
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
        name: 'mismatched age-grade calculator formula contract',
        expected: 'data/family/age_grade_calculator.csv:2: CalculationContractSignature "changed-contract" does not match website contract value',
        mutate: async root => {
            const file = path.join(root, 'data', 'family', 'age_grade_calculator.csv');
            const lines = splitLines(await fs.readFile(file, 'utf8'));
            lines[1] = replaceCsvField(lines[1], 7, 'changed-contract');
            await fs.writeFile(file, `${lines.join('\r\n')}\r\n`);
        }
    },
    {
        name: 'incorrect age-grade calculator conformance value',
        expected: 'data/everyone/age_grade_calculator.csv:2: ValidationAgeGrade does not match the website calculation',
        mutate: async root => {
            const file = path.join(root, 'data', 'everyone', 'age_grade_calculator.csv');
            const lines = splitLines(await fs.readFile(file, 'utf8'));
            lines[1] = replaceCsvField(lines[1], 5, '0.999999999999999');
            await fs.writeFile(file, `${lines.join('\r\n')}\r\n`);
        }
    },
    {
        name: 'missing age-grade pace field',
        expected: 'data/family/age_grade_standards.csv:1: Missing required header "pace_per_mile"',
        mutate: async root => {
            const file = path.join(root, 'data', 'family', 'age_grade_standards.csv');
            const lines = splitLines(await fs.readFile(file, 'utf8'));
            const paceColumnIndex = lines[0].split(',').indexOf('pace_per_mile');

            if (paceColumnIndex < 0) {
                throw new Error('Could not find pace_per_mile in the age-grade standards fixture.');
            }

            for (let index = 0; index < lines.length; index += 1) {
                const fields = lines[index].split(',');
                fields.splice(paceColumnIndex, 1);
                lines[index] = fields.join(',');
            }

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
    },
    {
        name: 'malformed athlete-comparison target pace',
        expected: 'RequiredPacePerKm "3:37" must use m:ss.s',
        mutate: async root => {
            const manifestFile = path.join(root, 'data', 'export_manifest.csv');
            const manifestLines = splitLines(await fs.readFile(manifestFile, 'utf8'));
            const [bundleId, exportedAt, schemaVersion] = manifestLines[1].split(',');
            manifestLines.push(
                `${bundleId},${exportedAt},${schemaVersion},family,data/family/athlete_comparison_targets.csv,2`
            );
            await fs.writeFile(manifestFile, `${manifestLines.join('\r\n')}\r\n`);

            const comparisonFile = path.join(root, 'data', 'family', 'athlete_comparison_targets.csv');
            const rows = [
                'ChallengerAthleteId,StandardAthleteId,Distance,BenchmarkType,StandardTime,StandardAgeGrade,StandardDate,StandardEvent,StandardTimeClass,RequiredTimeToBeat,RequiredPacePerKm,RequiredPacePerMile,SortOrder,ExportBundleID',
                `john-kevan,carolyn-kevan,5 km,Best Age Grade,00:25:20,78.0%,28/03/2026,Northern Counties Womens Relay,Official,00:18:08,3:37,5:50.1,101,${bundleId}`,
                `john-kevan,carolyn-kevan,5 km,Fastest Time,00:23:27,77.8%,16/11/2019,Northern Masters 5k Championships,Official,00:18:11,3:38.2,5:51.1,102,${bundleId}`
            ];
            await fs.writeFile(comparisonFile, `${rows.join('\r\n')}\r\n`);
        }
    },
    {
        name: 'incomplete athlete-comparison pair matrix',
        expected: 'is missing the Best Age Grade benchmark',
        mutate: async root => {
            const manifestFile = path.join(root, 'data', 'export_manifest.csv');
            const manifestLines = splitLines(await fs.readFile(manifestFile, 'utf8'));
            const [bundleId, exportedAt, schemaVersion] = manifestLines[1].split(',');
            manifestLines.push(
                `${bundleId},${exportedAt},${schemaVersion},family,data/family/athlete_comparison_targets.csv,2`
            );
            await fs.writeFile(manifestFile, `${manifestLines.join('\r\n')}\r\n`);

            const comparisonFile = path.join(root, 'data', 'family', 'athlete_comparison_targets.csv');
            const rows = [
                'ChallengerAthleteId,StandardAthleteId,Distance,BenchmarkType,StandardTime,StandardAgeGrade,StandardDate,StandardEvent,StandardTimeClass,RequiredTimeToBeat,RequiredPacePerKm,RequiredPacePerMile,SortOrder,ExportBundleID',
                `john-kevan,carolyn-kevan,5 km,Best Age Grade,00:25:20,78.0%,28/03/2026,Northern Counties Womens Relay,Official,00:18:08,3:37.6,5:50.1,101,${bundleId}`,
                `john-kevan,carolyn-kevan,5 km,Fastest Time,00:23:27,77.8%,16/11/2019,Northern Masters 5k Championships,Official,00:18:11,3:38.2,5:51.1,102,${bundleId}`
            ];
            await fs.writeFile(comparisonFile, `${rows.join('\r\n')}\r\n`);
        }
    },
    // A workbook status marker on the participant renames the athlete's key in
    // every exported table at once, so the bundle stays internally consistent
    // and every reference check still resolves. Mutating one athlete across the
    // whole bundle is the only mutation that reproduces that, and the guard has
    // to fail on it anyway.
    {
        name: 'workbook marker leaked into the athlete key',
        expected: 'AthleteID "*john-kevan" must be lowercase letters and digits separated by single hyphens.',
        mutate: async root => {
            for (const file of await listBundleCsvFiles(root)) {
                const text = await fs.readFile(file, 'utf8');

                if (!text.includes('john-kevan')) {
                    continue;
                }

                await fs.writeFile(file, text.replace(/\bjohn-kevan\b/g, '*john-kevan'));
            }
        }
    },
    // Removing a participant from a leaderboard after the ranking was computed
    // leaves a hole in the standings. Nothing else reads Rank closely enough to
    // notice one below third place, which is exactly where a deactivated
    // participant would usually leave it.
    {
        name: 'rank gap left by removing a ranked row',
        expected: 'Rank 6 is out of sequence: standings row 5 must be Rank 5',
        mutate: async root => {
            const leaderboard = path.join(root, 'data', 'family', 'overall-alltime-all-family.csv');
            const lines = splitLines(await fs.readFile(leaderboard, 'utf8'));
            const rowIndex = lines.findIndex(line => line.startsWith('5,'));

            if (rowIndex < 0) {
                throw new Error('Could not find the Rank 5 standings row.');
            }

            lines.splice(rowIndex, 1);
            await fs.writeFile(leaderboard, `${lines.join('\r\n')}\r\n`);

            // Correct the manifest too, so the row count is not what fails and
            // the case proves the rank check specifically.
            const manifestFile = path.join(root, 'data', 'export_manifest.csv');
            const manifestLines = splitLines(await fs.readFile(manifestFile, 'utf8'));
            const manifestIndex = manifestLines.findIndex(
                line => line.includes(',data/family/overall-alltime-all-family.csv,')
            );

            if (manifestIndex < 0) {
                throw new Error('Could not find the leaderboard manifest row.');
            }

            manifestLines[manifestIndex] = manifestLines[manifestIndex]
                .replace(/(\d+)$/, value => String(Number(value) - 1));
            await fs.writeFile(manifestFile, `${manifestLines.join('\r\n')}\r\n`);
        }
    },
    // A tie is not a gap. Competition ranking repeats the position and then
    // skips, so this has to pass, or the guard would forbid the workbook
    // recording two athletes level on age grade.
    {
        name: 'tied ranks are accepted rather than read as a gap',
        expectPass: true,
        mutate: async root => {
            const leaderboard = path.join(root, 'data', 'family', 'overall-alltime-all-family.csv');
            const lines = splitLines(await fs.readFile(leaderboard, 'utf8'));
            const rowIndex = lines.findIndex(line => line.startsWith('5,'));

            if (rowIndex < 0) {
                throw new Error('Could not find the Rank 5 standings row.');
            }

            // 1, 2, 3, 4, 4, 6 -- the fifth row ties with the fourth, and the
            // sixth keeps the position its offset implies.
            lines[rowIndex] = replaceCsvField(lines[rowIndex], 0, '4');
            await fs.writeFile(leaderboard, `${lines.join('\r\n')}\r\n`);
        }
    },
    // Absolute records are a fixed Men/Women by supported-distance matrix, so a
    // dropped, duplicated, misfiled, or reordered record is a defect the Records
    // page cannot show. Each case below breaks exactly one of those rules.
    {
        name: 'absolute record row missing from the matrix',
        expected: 'Missing the Men 10 Mile absolute record row.',
        mutate: async root => {
            const lines = await readAbsoluteRecords(root);
            lines.splice(3, 1);
            await writeAbsoluteRecords(root, lines);
            await setManifestRowCount(root, 'data/family/absolute_records.csv', lines.length - 1);
        }
    },
    {
        name: 'extra absolute record row',
        expected: 'Unexpected extra record row',
        mutate: async root => {
            const lines = await readAbsoluteRecords(root);
            lines.push(replaceCsvField(replaceCsvField(lines[10], 0, '160'), 2, "Women's bonus record"));
            await writeAbsoluteRecords(root, lines);
            await setManifestRowCount(root, 'data/family/absolute_records.csv', lines.length - 1);
        }
    },
    {
        name: 'duplicate absolute record distance',
        expected: 'Duplicate absolute record for Men 10 km',
        mutate: async root => {
            const lines = await readAbsoluteRecords(root);
            lines[5] = replaceCsvField(replaceCsvField(lines[5], 4, '10 km'), 5, '10 km');
            await writeAbsoluteRecords(root, lines);
        }
    },
    {
        name: 'unsupported absolute record distance',
        expected: 'Distance "Overall" must be one of: Marathon, Half Marathon, 10 Mile, 10 km, 5 km.',
        mutate: async root => {
            const lines = await readAbsoluteRecords(root);
            lines[1] = replaceCsvField(lines[1], 4, 'Overall');
            await writeAbsoluteRecords(root, lines);
        }
    },
    {
        name: 'invalid RecordGroup value',
        expected: 'RecordGroup "Mens" must be one of: Men, Women.',
        mutate: async root => {
            const lines = await readAbsoluteRecords(root);
            lines[1] = replaceCsvField(lines[1], 1, 'Mens');
            await writeAbsoluteRecords(root, lines);
        }
    },
    {
        name: 'RecordGroup disagreeing with Sex',
        expected: 'RecordGroup "Women" must match Sex "Men".',
        mutate: async root => {
            const lines = await readAbsoluteRecords(root);
            lines[1] = replaceCsvField(lines[1], 1, 'Women');
            await writeAbsoluteRecords(root, lines);
        }
    },
    {
        name: 'absolute records exported out of contracted order',
        expected: 'Expected the Men Marathon record here, found "Men Half Marathon".',
        mutate: async root => {
            const lines = await readAbsoluteRecords(root);
            [lines[1], lines[2]] = [lines[2], lines[1]];
            await writeAbsoluteRecords(root, lines);
        }
    },
    {
        name: 'non-increasing absolute record SortOrder',
        expected: "SortOrder 5 must be greater than the previous row's 10.",
        mutate: async root => {
            const lines = await readAbsoluteRecords(root);
            lines[2] = replaceCsvField(lines[2], 0, '5');
            await writeAbsoluteRecords(root, lines);
        }
    },
    {
        name: 'duplicate absolute record SortOrder',
        expected: 'Duplicate SortOrder 10',
        mutate: async root => {
            const lines = await readAbsoluteRecords(root);
            lines[2] = replaceCsvField(lines[2], 0, '10');
            await writeAbsoluteRecords(root, lines);
        }
    },
    {
        name: 'absolute record ResultDistance for another distance',
        expected: 'ResultDistance "5 km" is not the same distance as Distance "Marathon".',
        mutate: async root => {
            const lines = await readAbsoluteRecords(root);
            lines[1] = replaceCsvField(lines[1], 5, '5 km');
            await writeAbsoluteRecords(root, lines);
        }
    },
    {
        name: 'duplicate absolute RecordTitle',
        expected: 'Duplicate RecordTitle "Men\'s Marathon record"',
        mutate: async root => {
            const lines = await readAbsoluteRecords(root);
            lines[2] = replaceCsvField(lines[2], 2, "Men's Marathon record");
            await writeAbsoluteRecords(root, lines);
        }
    },
    // "No eligible result" is a real exported state, not a defect. The matrix
    // rules above must not turn a legitimately vacant record into a failure.
    {
        name: 'vacant absolute record still validates',
        expectPass: true,
        mutate: async root => {
            const lines = await readAbsoluteRecords(root);
            let vacated = lines[5];

            vacated = replaceCsvField(vacated, 6, 'No eligible result');
            for (const fieldIndex of [7, 8, 9, 10, 12, 13, 14]) {
                vacated = replaceCsvField(vacated, fieldIndex, '');
            }

            lines[5] = vacated;
            await writeAbsoluteRecords(root, lines);
        }
    }
];

for (const testCase of cases) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'family-running-bundle-test-'));

    try {
        await fs.cp(sourceData, path.join(root, 'data'), { recursive: true });
        await installValidOfficialNewsExports(root);
        await testCase.mutate(root);
        const result = await runValidator(root);
        const output = `${result.stdout}\n${result.stderr}`;

        if (testCase.expectPass) {
            if (result.code !== 0) {
                throw new Error(`${testCase.name}: validator unexpectedly failed.\n${output}`);
            }
        } else {
            if (result.code === 0) {
                throw new Error(`${testCase.name}: validator unexpectedly passed.`);
            }
            if (!output.includes(testCase.expected)) {
                throw new Error(
                    `${testCase.name}: expected output containing "${testCase.expected}".\n${output}`
                );
            }
        }

        console.log(`PASS - ${testCase.name}`);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
}

console.log('Export bundle validation regression tests passed.');

async function installValidOfficialNewsExports(root) {
    const manifestFile = path.join(root, 'data', 'export_manifest.csv');
    const manifestLines = splitLines(await fs.readFile(manifestFile, 'utf8'));
    const [bundleId, exportedAt, schemaVersion] = manifestLines[1].split(',');

    for (const mode of ['family', 'everyone']) {
        const fixtureRows = validOfficialNewsRows(bundleId, mode);
        await writeOfficialNews(root, mode, [officialNewsHeaders, ...fixtureRows]);

        const relativePath = `data/${mode}/official_result_news.csv`;
        const manifestRow = `${bundleId},${exportedAt},${schemaVersion},${mode},${relativePath},${fixtureRows.length}`;
        const rowIndex = manifestLines.findIndex(line => line.includes(`,${relativePath},`));

        if (rowIndex >= 0) {
            manifestLines[rowIndex] = manifestRow;
        } else {
            manifestLines.push(manifestRow);
        }
    }

    await fs.writeFile(manifestFile, `${manifestLines.join('\r\n')}\r\n`);
}

function validOfficialNewsRows(bundleId, mode) {
    const rows = [
        officialNewsRow({
            SortOrder: '1',
            SourceRow: '163',
            AthleteID: 'jim-chambers',
            AthleteName: 'Jim Chambers',
            ResultDate: '15/08/2026',
            Distance: '5 km',
            Time: '00:26:01',
            AgeGrade: '67.0%',
            AgeGradeExact: '67.001%',
            Event: 'Kingston Parkrun',
            TimeClass: 'Official',
            MilestoneType: 'Age Grade PB',
            PreviousBestAgeGrade: '67.0%',
            PreviousBestAgeGradeExact: '66.997%',
            AgeGradeImprovementExact: '0.004%',
            AgeGradeImprovement: '+<0.01 pp',
            CurrentDistanceRankBefore: '3',
            CurrentDistanceRankAfter: '3',
            CurrentDistancePlacesGained: '0',
            CurrentDistanceMedalBefore: 'Bronze',
            CurrentDistanceMedalAfter: 'Bronze',
            CurrentOverallRankBefore: '5',
            CurrentOverallRankAfter: '5',
            CurrentOverallPlacesGained: '0',
            AllTimeDistanceRankBefore: '7',
            AllTimeDistanceRankAfter: '6',
            AllTimeDistancePlacesGained: '1',
            AllTimeOverallRankBefore: '9',
            AllTimeOverallRankAfter: '8',
            AllTimeOverallPlacesGained: '1',
            ExportBundleID: bundleId
        }),
        officialNewsRow({
            SortOrder: '2',
            SourceRow: '151',
            AthleteID: 'jim-chambers',
            AthleteName: 'Jim Chambers',
            ResultDate: '01/08/2026',
            Distance: '5 km',
            Time: '00:26:01',
            AgeGrade: '67.0%',
            AgeGradeExact: '66.997%',
            Event: 'Derry City Parkrun',
            TimeClass: 'Official',
            MilestoneType: 'Age Grade PB',
            PreviousBestAgeGrade: '66.8%',
            PreviousBestAgeGradeExact: '66.76%',
            AgeGradeImprovementExact: '0.237%',
            AgeGradeImprovement: '+0.24 pp',
            CurrentDistanceRankBefore: '4',
            CurrentDistanceRankAfter: '3',
            CurrentDistancePlacesGained: '1',
            CurrentDistanceMedalEntry: 'Bronze',
            CurrentDistanceMedalAfter: 'Bronze',
            CurrentDistanceDisplacedAthleteID: 'ben-graham-kevan',
            CurrentDistanceDisplacedAthleteName: 'Ben Graham-Kevan',
            CurrentDistanceDisplacedMedalBefore: 'Bronze',
            CurrentDistanceDisplacedMedalAfter: 'No medal',
            CurrentOverallRankBefore: '6',
            CurrentOverallRankAfter: '5',
            CurrentOverallPlacesGained: '1',
            AllTimeDistanceRankBefore: '8',
            AllTimeDistanceRankAfter: '7',
            AllTimeDistancePlacesGained: '1',
            AllTimeOverallRankBefore: '10',
            AllTimeOverallRankAfter: '9',
            AllTimeOverallPlacesGained: '1',
            ExportBundleID: bundleId
        }),
        officialNewsRow({
            SortOrder: '3',
            SourceRow: '112',
            AthleteID: 'jim-chambers',
            AthleteName: 'Jim Chambers',
            ResultDate: '23/02/2026',
            Distance: '5 km',
            Time: '00:25:47.1',
            AgeGrade: '66.8%',
            AgeGradeExact: '66.76%',
            Event: 'Strabane Triathlon Club Lifford 5k',
            TimeClass: 'Official',
            MilestoneType: 'Age Grade + Raw-Time PB',
            PreviousBestTime: '00:25:54.2',
            TimeImprovementSeconds: '7.1',
            TimeImprovement: '00:00:07.1',
            PreviousBestAgeGrade: '66.5%',
            PreviousBestAgeGradeExact: '66.51%',
            AgeGradeImprovementExact: '0.25%',
            AgeGradeImprovement: '+0.25 pp',
            CurrentDistanceRankBefore: '5',
            CurrentDistanceRankAfter: '4',
            CurrentDistancePlacesGained: '1',
            CurrentOverallRankBefore: '7',
            CurrentOverallRankAfter: '6',
            CurrentOverallPlacesGained: '1',
            AllTimeDistanceRankBefore: '9',
            AllTimeDistanceRankAfter: '8',
            AllTimeDistancePlacesGained: '1',
            AllTimeOverallRankBefore: '11',
            AllTimeOverallRankAfter: '10',
            AllTimeOverallPlacesGained: '1',
            ExportBundleID: bundleId
        }),
        officialNewsRow({
            SortOrder: '4',
            SourceRow: '91',
            AthleteID: 'jess-graham-kevan',
            AthleteName: 'Jess Graham-Kevan',
            ResultDate: '13/09/2025',
            Distance: '1 Mile',
            Time: '00:11:18.2',
            AgeGrade: '46.3%',
            AgeGradeExact: '46.31%',
            Event: 'Worcester Half',
            TimeClass: 'Official',
            MilestoneType: 'First Official Result',
            CurrentOverallRankAfter: '12',
            AllTimeOverallRankAfter: '15',
            ExportBundleID: bundleId
        }),
        officialNewsRow({
            SortOrder: '5',
            SourceRow: '86',
            AthleteID: 'jim-chambers',
            AthleteName: 'Jim Chambers',
            ResultDate: '13/09/2025',
            Distance: '5 km',
            Time: '00:25:54.2',
            AgeGrade: '66.5%',
            AgeGradeExact: '66.51%',
            Event: 'Derry City Parkrun',
            TimeClass: 'Official',
            MilestoneType: 'First Official Result',
            CurrentDistanceRankAfter: '5',
            CurrentOverallRankBefore: '8',
            CurrentOverallRankAfter: '7',
            CurrentOverallPlacesGained: '1',
            AllTimeDistanceRankAfter: '9',
            AllTimeOverallRankBefore: '12',
            AllTimeOverallRankAfter: '11',
            AllTimeOverallPlacesGained: '1',
            ExportBundleID: bundleId
        }),
        officialNewsRow({
            SortOrder: '6',
            SourceRow: '54',
            AthleteID: 'ben-graham-kevan',
            AthleteName: 'Ben Graham-Kevan',
            ResultDate: '31/08/2019',
            Distance: '5 km',
            Time: '00:24:51',
            AgeGrade: '52.8%',
            AgeGradeExact: '52.8%',
            Event: 'Worcester Parkrun',
            TimeClass: 'Official',
            MilestoneType: 'Raw-Time PB',
            PreviousBestTime: '00:25:17',
            TimeImprovementSeconds: '26',
            TimeImprovement: '00:00:26',
            CurrentDistanceRankAfter: '4',
            CurrentOverallRankAfter: '7',
            AllTimeDistanceRankBefore: '8',
            AllTimeDistanceRankAfter: '8',
            AllTimeDistancePlacesGained: '0',
            AllTimeOverallRankBefore: '10',
            AllTimeOverallRankAfter: '10',
            AllTimeOverallPlacesGained: '0',
            ExportBundleID: bundleId
        }),
        officialNewsRow({
            SortOrder: '7',
            SourceRow: '32',
            AthleteID: 'ben-graham-kevan',
            AthleteName: 'Ben Graham-Kevan',
            ResultDate: '11/11/2017',
            Distance: '5 km',
            Time: '00:25:17',
            AgeGrade: '53.9%',
            AgeGradeExact: '53.90%',
            Event: 'Worcester Parkrun',
            TimeClass: 'Official',
            MilestoneType: 'Age Grade + Raw-Time PB',
            PreviousBestTime: '00:26:32',
            TimeImprovementSeconds: '75',
            TimeImprovement: '00:01:15',
            PreviousBestAgeGrade: '51.3%',
            PreviousBestAgeGradeExact: '51.31%',
            AgeGradeImprovementExact: '2.59%',
            AgeGradeImprovement: '+2.59 pp',
            CurrentDistanceRankBefore: '6',
            CurrentDistanceRankAfter: '5',
            CurrentDistancePlacesGained: '1',
            CurrentOverallRankBefore: '9',
            CurrentOverallRankAfter: '8',
            CurrentOverallPlacesGained: '1',
            AllTimeDistanceRankBefore: '6',
            AllTimeDistanceRankAfter: '5',
            AllTimeDistancePlacesGained: '1',
            AllTimeOverallRankBefore: '9',
            AllTimeOverallRankAfter: '8',
            AllTimeOverallPlacesGained: '1',
            ExportBundleID: bundleId
        }),
        officialNewsRow({
            SortOrder: '8',
            SourceRow: '30',
            AthleteID: 'ben-graham-kevan',
            AthleteName: 'Ben Graham-Kevan',
            ResultDate: '14/10/2017',
            Distance: '5 km',
            Time: '00:26:32',
            AgeGrade: '51.3%',
            AgeGradeExact: '51.31%',
            Event: 'Worcester Parkrun',
            TimeClass: 'Official',
            MilestoneType: 'Age Grade + Raw-Time PB',
            PreviousBestTime: '00:26:42',
            TimeImprovementSeconds: '10',
            TimeImprovement: '00:00:10',
            PreviousBestAgeGrade: '51.0%',
            PreviousBestAgeGradeExact: '51.01%',
            AgeGradeImprovementExact: '0.30%',
            AgeGradeImprovement: '+0.30 pp',
            CurrentDistanceRankBefore: '7',
            CurrentDistanceRankAfter: '6',
            CurrentDistancePlacesGained: '1',
            CurrentOverallRankBefore: '10',
            CurrentOverallRankAfter: '9',
            CurrentOverallPlacesGained: '1',
            AllTimeDistanceRankBefore: '7',
            AllTimeDistanceRankAfter: '6',
            AllTimeDistancePlacesGained: '1',
            AllTimeOverallRankBefore: '10',
            AllTimeOverallRankAfter: '9',
            AllTimeOverallPlacesGained: '1',
            ExportBundleID: bundleId
        }),
        officialNewsRow({
            SortOrder: '9',
            SourceRow: '29',
            AthleteID: 'ben-graham-kevan',
            AthleteName: 'Ben Graham-Kevan',
            ResultDate: '07/10/2017',
            Distance: '5 km',
            Time: '00:26:42',
            AgeGrade: '51.0%',
            AgeGradeExact: '51.01%',
            Event: 'Worcester Parkrun',
            TimeClass: 'Official',
            MilestoneType: 'First Official Result',
            CurrentDistanceRankAfter: '7',
            CurrentOverallRankAfter: '10',
            AllTimeDistanceRankAfter: '7',
            AllTimeOverallRankAfter: '10',
            ExportBundleID: bundleId
        })
    ];

    if (mode === 'family') {
        return rows
            .filter(row => row[officialNewsColumn.get('AthleteID')] === 'ben-graham-kevan')
            .map((row, index) => {
                const siteRow = [...row];
                siteRow[officialNewsColumn.get('SortOrder')] = String(index + 1);
                return siteRow;
            });
    }

    return rows;
}

function officialNewsRow(values) {
    const row = { ...values };

    // These are fixed source-export values for the synthetic valid fixture,
    // not a ranking calculation. Individual cases below mutate the counts to
    // prove the validator's closed post-result-count contract.
    for (const prefix of officialNewsRankContextPrefixes) {
        const rankAfterField = `${prefix}RankAfter`;
        const countAfterField = `${prefix}RankedAthleteCountAfter`;

        if (!Object.prototype.hasOwnProperty.call(row, countAfterField) && String(row[rankAfterField] || '').trim()) {
            row[countAfterField] = '20';
        }
    }

    return officialNewsHeaders
        .map(header => String(row[header] ?? ''));
}

function csvCell(value) {
    const text = String(value);
    return /[",\r\n]/.test(text)
        ? `"${text.replace(/"/g, '""')}"`
        : text;
}

function officialNewsPath(root, mode) {
    return path.join(root, 'data', mode, 'official_result_news.csv');
}

async function readOfficialNews(root, mode) {
    return parseCsvDocument(await fs.readFile(officialNewsPath(root, mode), 'utf8'));
}

async function writeOfficialNews(root, mode, rows) {
    await fs.writeFile(
        officialNewsPath(root, mode),
        `${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`
    );
}

async function mutateOfficialNewsRow(root, mode, dataRowNumber, field, value) {
    const rows = await readOfficialNews(root, mode);
    const columnIndex = officialNewsColumn.get(field);

    if (columnIndex === undefined) {
        throw new Error(`Unknown Official News field ${field}.`);
    }
    if (!rows[dataRowNumber]) {
        throw new Error(`Official News fixture has no data row ${dataRowNumber}.`);
    }

    rows[dataRowNumber][columnIndex] = String(value);
    await writeOfficialNews(root, mode, rows);
}

async function configureOfficialNewsMedalCrossing(root, context, medalEntry) {
    await configureOfficialNewsMedalSnapshot(root, context.prefix, {
        before: context.before,
        after: context.after,
        gain: context.gain,
        medalEntry,
        medalBefore: '',
        medalAfter: context.medal
    });
}

async function configureOfficialNewsMedalSnapshot(root, prefix, {
    before,
    after,
    gain,
    medalEntry,
    medalBefore,
    medalAfter
}, {
    mode = 'everyone',
    dataRowNumber = 3
} = {}) {
    const changes = [
        [`${prefix}RankBefore`, before],
        [`${prefix}RankAfter`, after],
        [`${prefix}PlacesGained`, gain],
        [`${prefix}MedalEntry`, medalEntry],
        [`${prefix}MedalBefore`, medalBefore],
        [`${prefix}MedalAfter`, medalAfter]
    ];

    for (const [field, value] of changes) {
        await mutateOfficialNewsRow(root, mode, dataRowNumber, field, value);
    }
}

async function configureOfficialNewsDisplacement(root, mode, dataRowNumber, prefix, {
    athleteId,
    athleteName,
    medalBefore,
    medalAfter
}) {
    const changes = [
        [`${prefix}DisplacedAthleteID`, athleteId],
        [`${prefix}DisplacedAthleteName`, athleteName],
        [`${prefix}DisplacedMedalBefore`, medalBefore],
        [`${prefix}DisplacedMedalAfter`, medalAfter]
    ];

    for (const [field, value] of changes) {
        await mutateOfficialNewsRow(root, mode, dataRowNumber, field, value);
    }
}

async function mutateOfficialNewsMatchingRow(root, mode, predicate, field, value) {
    const rows = await readOfficialNews(root, mode);
    const headers = rows[0];
    const rowIndex = rows.findIndex((row, index) =>
        index > 0 && predicate(csvRowObject(headers, row))
    );

    if (rowIndex < 0) {
        throw new Error(`Could not find matching ${mode} Official News fixture row.`);
    }

    const columnIndex = officialNewsColumn.get(field);
    rows[rowIndex][columnIndex] = String(value);
    await writeOfficialNews(root, mode, rows);
}

async function removeOfficialNewsMatchingRow(root, mode, predicate) {
    const rows = await readOfficialNews(root, mode);
    const headers = rows[0];
    const matchingIndexes = rows
        .map((row, index) => ({ index, record: csvRowObject(headers, row) }))
        .filter(({ index, record }) => index > 0 && predicate(record))
        .map(({ index }) => index);

    if (matchingIndexes.length !== 1) {
        throw new Error(
            `Expected exactly one removable ${mode} Official News row, found ${matchingIndexes.length}.`
        );
    }

    rows.splice(matchingIndexes[0], 1);
    for (let index = 1; index < rows.length; index += 1) {
        rows[index][officialNewsColumn.get('SortOrder')] = String(index);
    }

    await writeOfficialNews(root, mode, rows);
    await setManifestRowCount(root, `data/${mode}/official_result_news.csv`, rows.length - 1);
}

async function mutateBundleCsvMatchingRow(root, relativePath, predicate, field, value) {
    const file = path.join(root, ...relativePath.split('/'));
    const rows = parseCsvDocument(await fs.readFile(file, 'utf8'));
    const headers = rows[0];
    const columnIndex = headers.indexOf(field);
    const matchingIndexes = rows
        .map((row, index) => ({ index, record: csvRowObject(headers, row) }))
        .filter(({ index, record }) => index > 0 && predicate(record))
        .map(({ index }) => index);

    if (columnIndex < 0) {
        throw new Error(`${relativePath} has no field ${field}.`);
    }
    if (matchingIndexes.length !== 1) {
        throw new Error(
            `Expected one ${relativePath} fixture row for ${field}, found ${matchingIndexes.length}.`
        );
    }

    rows[matchingIndexes[0]][columnIndex] = String(value);
    await fs.writeFile(
        file,
        `${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`
    );
}

function csvRowObject(headers, row) {
    return Object.fromEntries(headers.map((header, index) => [header, row[index] ?? '']));
}

function parseCsvDocument(text) {
    const rows = [];
    let row = [];
    let value = '';
    let insideQuotes = false;

    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        const next = text[index + 1];

        if (character === '"') {
            if (insideQuotes && next === '"') {
                value += '"';
                index += 1;
            } else {
                insideQuotes = !insideQuotes;
            }
            continue;
        }

        if (character === ',' && !insideQuotes) {
            row.push(value.trim());
            value = '';
            continue;
        }

        if ((character === '\r' || character === '\n') && !insideQuotes) {
            row.push(value.trim());
            rows.push(row);
            row = [];
            value = '';

            if (character === '\r' && next === '\n') {
                index += 1;
            }
            continue;
        }

        value += character;
    }

    if (insideQuotes) {
        throw new Error('Unclosed quoted CSV field in test fixture.');
    }

    if (value.length || row.length) {
        row.push(value.trim());
        rows.push(row);
    }

    return rows.filter((candidate, index) =>
        !(index === rows.length - 1 && candidate.length === 1 && candidate[0] === '')
    );
}

function splitLines(text) {
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd().split('\n');
}

function replaceCsvField(line, index, value) {
    const fields = line.split(',');
    fields[index] = value;
    return fields.join(',');
}

async function listBundleCsvFiles(root) {
    const entries = await fs.readdir(path.join(root, 'data'), {
        recursive: true,
        withFileTypes: true
    });

    return entries
        .filter(entry => entry.isFile() && entry.name.endsWith('.csv'))
        .map(entry => path.join(entry.parentPath || entry.path, entry.name));
}

function absoluteRecordsPath(root) {
    return path.join(root, 'data', 'family', 'absolute_records.csv');
}

async function readAbsoluteRecords(root) {
    return splitLines(await fs.readFile(absoluteRecordsPath(root), 'utf8'));
}

async function writeAbsoluteRecords(root, lines) {
    await fs.writeFile(absoluteRecordsPath(root), `${lines.join('\r\n')}\r\n`);
}

// Adding or removing a record row also changes the manifest's contracted row
// count, so keep them in step. Otherwise a matrix test would fail on the row
// count instead of the rule it exists to prove.
async function setManifestRowCount(root, relativePath, count) {
    const file = path.join(root, 'data', 'export_manifest.csv');
    const lines = splitLines(await fs.readFile(file, 'utf8'));
    const rowIndex = lines.findIndex(line => line.includes(`,${relativePath},`));

    if (rowIndex < 0) {
        throw new Error(`Could not find ${relativePath} in the export manifest.`);
    }

    lines[rowIndex] = lines[rowIndex].replace(/\d+$/, String(count));
    await fs.writeFile(file, `${lines.join('\r\n')}\r\n`);
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
