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

function buildPersonalBests(results) {
    const distances = ['Marathon', 'Half Marathon', '10 km', '5 km'];
    const pbContainer = document.getElementById('personal-bests');

    let html = '';

    distances.forEach(distance => {
        const matching = results.filter(row => row.Distance === distance);

        if (matching.length === 0) {
            html += `
                <div>
                    <h3>${distance}</h3>
                    <p>-</p>
                </div>
            `;
            return;
        }

        const fastest = matching.sort((a, b) =>
            timeToSeconds(a.Time) - timeToSeconds(b.Time)
        )[0];

        html += `
            <div>
                <h3>${distance}</h3>
                <p>${fastest.Time}</p>
                <p>${fastest.Event}</p>
                <p>${fastest.Date}</p>
            </div>
        `;
    });

    pbContainer.innerHTML = html;
}

function buildRecentResults(results) {
    const recent = results.slice(0, 10);
    const recentContainer = document.getElementById('recent-results');

    let html = `
        <table border="1" cellpadding="8" cellspacing="0">
            <tr>
                <th>Date</th>
                <th>Distance</th>
                <th>Time</th>
                <th>Event</th>
            </tr>
    `;

    recent.forEach(row => {
        html += `
            <tr>
                <td>${row.Date}</td>
                <td>${row.Distance}</td>
                <td>${row.Time}</td>
                <td>${row.Event}</td>
            </tr>
        `;
    });

    html += '</table>';

    recentContainer.innerHTML = html;
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