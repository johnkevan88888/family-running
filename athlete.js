const params = new URLSearchParams(window.location.search);
const athleteId = params.get('id');

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

    const athleteResults = results.filter(row => row.AthleteID === athleteId);

    if (athleteResults.length === 0) {
        document.getElementById('athlete-name').innerText = 'Athlete not found';
        document.getElementById('all-results').innerHTML = '<p>No results found for this athlete.</p>';
        return;
    }

    document.getElementById('athlete-name').innerText = athleteResults[0].Participant;

    document.getElementById('all-results').innerHTML = renderTable(athleteResults);
}

buildAthletePage();