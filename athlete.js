const params = new URLSearchParams(window.location.search);
const athleteId = params.get('id');

function parseDate(dateStr) {
    const [day, month, year] = dateStr.split('/');
    return new Date(year, month - 1, day);
}

function timeToSeconds(time) {
    const parts = time.split(':').map(Number);

    if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }

    if (parts.length === 2) {
        return parts[0] * 60 + parts[1];
    }

    return Number.MAX_SAFE_INTEGER;
}

function renderTable(rows) {
    if (rows.length === 0) {
        return '<p>No results found.</p>';
    }

    let html = '<table border="1" cellpadding="8" cellspacing="0">';
    html += `
        <tr>
            <th>Date</th>
            <th>Distance</th>
            <th>Time</th>
            <th>Age Grade</th>
            <th>Event</th>
            <th>Time Class</th>
        </tr>
    `;

    rows.forEach(row => {
        html += `
            <tr>
                <td>${row.Date}</td>
                <td>${row.Distance}</td>
                <td>${row.Time}</td>
                <td>${row.AgeGrade}</td>
                <td>${row.Event}</td>
                <td>${row.TimeClass}</td>
            </tr>
        `;
    });

    html += '</table>';
    return html;
}

function distanceMatches(rowDistance, allowedDistances) {
    return allowedDistances
        .map(normaliseDistance)
        .includes(normaliseDistance(rowDistance));
}

function buildPersonalBests(results) {
    const distances = [
    { label: 'Marathon', values: ['Marathon'] },
    { label: 'Half Marathon', values: ['Half Marathon', 'H. Mar', 'H Mar', 'HMar', 'Half Mar'] },
    { label: '10 km', values: ['10 km', '10km'] },
    { label: '5 km', values: ['5 km', '5km'] }
];
    const pbContainer = document.getElementById('personal-bests');

    let html = '<div class="pb-card-grid">';

    distances.forEach(distanceConfig => {
    const distance = distanceConfig.label;
    const distanceValues = distanceConfig.values;

    const officialTimePB = getFastestResult(results, distanceValues, 'Official');
    const unofficialTimePB = getFastestResult(results, distanceValues, 'Unofficial');
    const officialAgeGradePB = getBestAgeGradeResult(results, distanceValues, 'Official');
    const unofficialAgeGradePB = getBestAgeGradeResult(results, distanceValues, 'Unofficial');

        html += `
            <div class="pb-card">
                <div class="pb-card-title">${distance}</div>

                <div class="pb-columns">
                    <div class="pb-column official">
                        <div class="pb-column-title">Official</div>
                        ${formatPBBlock('Best Age Grade', officialAgeGradePB, true)}
                        ${formatPBBlock('Fastest Time', officialTimePB, false)}
                    </div>

                    <div class="pb-column unofficial">
                        <div class="pb-column-title">Unofficial</div>
                        ${formatPBBlock('Best Age Grade', unofficialAgeGradePB, true)}
                        ${formatPBBlock('Fastest Time', unofficialTimePB, false)}
                    </div>
                </div>
            </div>
        `;
    });

    html += '</div>';

    pbContainer.innerHTML = html;
}


function getFastestResult(results, distances, timeClass) {
    const matching = results.filter(row =>
        distanceMatches(row.Distance, distances) &&
        clean(row.TimeClass) === clean(timeClass)
    );

    if (matching.length === 0) return null;

    return matching.sort((a, b) =>
        timeToSeconds(a.Time) - timeToSeconds(b.Time)
    )[0];
}

function getBestAgeGradeResult(results, distances, timeClass) {
    const matching = results.filter(row =>
        distanceMatches(row.Distance, distances) &&
        clean(row.TimeClass) === clean(timeClass)
    );

    if (matching.length === 0) return null;

    return matching.sort((a, b) =>
        ageGradeToNumber(b.AgeGrade) - ageGradeToNumber(a.AgeGrade)
    )[0];
}


function ageGradeToNumber(ageGrade) {
    return Number(String(ageGrade).replace('%', '').trim()) || 0;
}

function clean(value) {
    return String(value || '')
        .trim()
        .toLowerCase();
}

function normaliseDistance(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\./g, '')
        .replace(/\s+/g, '');
}

function formatPBBlock(label, result, isAgeGrade) {
    if (!result) {
        return `
            <div class="pb-block empty">
                <div class="pb-label">${label}</div>
                <div class="pb-value">-</div>
            </div>
        `;
    }

    const mainValue = isAgeGrade ? result.AgeGrade : result.Time;
    const secondaryValue = isAgeGrade ? result.Time : result.AgeGrade;

    return `
        <div class="pb-block">
            <div class="pb-label">${label}</div>
            <div class="pb-value">${mainValue}</div>
            <div class="pb-sub">${secondaryValue}</div>
        </div>
    `;
}

function formatPB(result) {
    if (!result) {
        return '-';
    }

    return `
        <strong>${result.Time}</strong><br>
        <span>${result.Event}</span><br>
        <span>${result.Date}</span>
    `;
}

function buildRecentResults(results) {
    const recentContainer = document.getElementById('recent-results');

    const today = new Date();
    const twelveMonthsAgo = new Date(today);
    twelveMonthsAgo.setFullYear(today.getFullYear() - 1);

    const recent = results.filter(row =>
        parseDate(row.Date) >= twelveMonthsAgo
    );

    recentContainer.innerHTML = renderTable(recent);
}

async function buildAthletePage() {
    const rows = await fetchCSV('data/athlete_results.csv');
    const headers = rows[0];
    const data = rows.slice(1);

    const results = data.map(row => {
        const obj = {};
        headers.forEach((header, index) => {
            obj[header] = row[index] || '';
        });
        return obj;
    });

    const athleteResults = results
        .filter(row => row.AthleteID === athleteId)
        .sort((a, b) => parseDate(b.Date) - parseDate(a.Date));

    if (athleteResults.length === 0) {
        document.getElementById('athlete-name').innerText = 'Athlete not found';
        document.getElementById('personal-bests').innerHTML = '';
        document.getElementById('recent-results').innerHTML = '';
        document.getElementById('all-results').innerHTML = '<p>No results found for this athlete.</p>';
        return;
    }

    document.getElementById('athlete-name').innerText = athleteResults[0].Participant;

    buildPersonalBests(athleteResults);
    buildRecentResults(athleteResults);

    document.getElementById('all-results').innerHTML = renderTable(athleteResults);
}

buildAthletePage();