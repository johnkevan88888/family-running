// Has the change tier earned promotion yet?
//
// The classifier runs in shadow: the full suite is required on every Pull
// Request, and a second advisory job reports what a narrowed run would have
// been. The claim being tested is that the narrowed run reaches the same
// verdict as the whole suite. This reads the Actions history and says how far
// along that evidence is.
//
// The exit criterion, agreed before any of this was built:
//
//   - 20 Pull Requests where the advisory tier's result and the required job's
//     result agree,
//   - including at least 3 real data refreshes classified as the data tier,
//   - plus the nine-fault proof green.
//
// This script covers the first two. The third is
// `scripts/prove-change-tier.mjs`.
//
// READ-ONLY. It calls `gh` to list workflow runs and read logs, and it writes
// nothing, merges nothing and triggers nothing. A disagreement it reports is
// evidence to look at, never an instruction to act.
//
//     node scripts/collect-tier-agreement.mjs
//     node scripts/collect-tier-agreement.mjs --limit 80

import { execFileSync } from 'node:child_process';

const requiredAgreements = 20;
const requiredRefreshes = 3;
const summaryPattern = /CHANGE_TIER_SUMMARY ([^\r\n]+)/;
const limitFlag = process.argv.indexOf('--limit');
const limit = limitFlag === -1 ? 50 : Number(process.argv[limitFlag + 1]);

if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    console.error('--limit must be a whole number between 1 and 200.');
    process.exit(1);
}

const runs = JSON.parse(gh([
    'run', 'list',
    '--workflow', 'pr-checks.yml',
    '--event', 'pull_request',
    '--limit', String(limit),
    '--json', 'databaseId,headSha,conclusion,status,number,displayTitle'
]));
const completed = runs.filter(run => run.status === 'completed');

console.log(`Read ${runs.length} pull_request runs of pr-checks.yml; ${completed.length} completed.`);

const observations = [];

for (const run of completed) {
    // The two jobs in one run: the required suite and the advisory tier.
    let jobs;

    try {
        jobs = JSON.parse(gh(['api', `repos/{owner}/{repo}/actions/runs/${run.databaseId}/jobs`])).jobs || [];
    } catch {
        continue;
    }

    const required = jobs.find(job => job.name === 'Test static site');
    const advisory = jobs.find(job => job.name === 'Change tier (advisory)');

    // A run from before the advisory job existed says nothing about agreement.
    if (!required || !advisory) {
        continue;
    }

    let summary = null;

    try {
        const log = gh(['api', `repos/{owner}/{repo}/actions/jobs/${advisory.id}/logs`]);
        const match = summaryPattern.exec(log);

        if (match) {
            summary = Object.fromEntries(match[1].trim().split(/\s+/)
                .map(pair => pair.split('='))
                .filter(pair => pair.length === 2));
        }
    } catch {
        summary = null;
    }

    observations.push({
        run: run.databaseId,
        headSha: run.headSha,
        requiredConclusion: required.conclusion,
        advisoryConclusion: advisory.conclusion,
        summary
    });
}

const usable = observations.filter(observation => observation.summary);

console.log(`${usable.length} run(s) carry a CHANGE_TIER_SUMMARY line.`);

const agreements = [];
const disagreements = [];
const refreshes = [];

for (const observation of usable) {
    const { summary } = observation;
    const requiredPassed = observation.requiredConclusion === 'success';
    // `not-run` means the tier narrowed nothing, so there is no narrowed verdict
    // to compare. Those runs count as agreeing only in the trivial sense, so
    // they are reported separately rather than inflating the count.
    const tierPassed = summary.result === 'pass';

    if (summary.result === 'not-run') {
        continue;
    }
    if (summary.data_refresh === 'true' && summary.tier === 'data') {
        refreshes.push(observation);
    }
    if (requiredPassed === tierPassed) {
        agreements.push(observation);
    } else {
        disagreements.push(observation);
    }
}

const notNarrowed = usable.filter(observation => observation.summary.result === 'not-run').length;

console.log(`\n${notNarrowed} run(s) narrowed nothing (tier full), so they carry no narrowed verdict to compare.`);
console.log(`${agreements.length} of ${requiredAgreements} agreeing narrowed runs.`);
console.log(`${refreshes.length} of ${requiredRefreshes} real data refreshes classified as the data tier.`);

if (disagreements.length > 0) {
    // The one result that matters. A tier that PASSES where the required suite
    // FAILS is the tier table being wrong, and is the whole reason for shadow
    // mode.
    console.log(`\n${disagreements.length} DISAGREEMENT(S):`);

    for (const observation of disagreements) {
        const direction = observation.requiredConclusion !== 'success'
            ? 'tier passed where the full suite failed — the tier table is missing a check'
            : 'tier failed where the full suite passed — look at the narrowed run';

        console.log(`- run ${observation.run} on ${observation.headSha.slice(0, 9)}: ` +
            `tier=${observation.summary.tier} tier_result=${observation.summary.result} ` +
            `required=${observation.requiredConclusion} — ${direction}`);
    }
}

const met = disagreements.length === 0 &&
    agreements.length >= requiredAgreements &&
    refreshes.length >= requiredRefreshes;

console.log(`\nExit criterion ${met ? 'MET' : 'not met'} on this evidence` +
    `${met ? '; the nine-fault proof must also be green' : ''}.`);

// Reporting only: a count that is not yet 20 is not a failure of anything.
process.exit(0);

function gh(args) {
    return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
