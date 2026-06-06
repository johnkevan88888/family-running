async function fetchCSV(file) {
    const response = await fetch(file);
    const text = await response.text();

    return text
        .trim()
        .split('\n')
        .map(row => row.split(',').map(cell => cell.replace(/"/g, '').trim()));
}

function renderTable(rows) {
    let html = '<table>';

    rows.forEach((row, index) => {
        html += '<tr>';

        row.forEach(cell => {
            if (index === 0) {
                html += `<th>${cell}</th>`;
            } else {
                if (row[0] === '1' && cell === row[0]) cell = '<span class="medal">🥇</span>';
                if (row[0] === '2' && cell === row[0]) cell = '<span class="medal">🥈</span>';
                if (row[0] === '3' && cell === row[0]) cell = '<span class="medal">🥉</span>';

                const category = cell.toLowerCase();

                if (category === 'recreational') cell = '<span class="recreational">🟢 Recreational</span>';
                if (category === 'club') cell = '<span class="club">🥉 Club</span>';
                if (category === 'local competitive') cell = '<span class="local">🥈 Local Competitive</span>';
                if (category === 'regional class') cell = '<span class="regional">🥇 Regional Class</span>';
                if (category === 'national class') cell = '<span class="national">🏛️ National Class</span>';
                if (category === 'international class') cell = '<span class="international">🌍 International Class</span>';

                html += `<td>${cell}</td>`;
            }
        });

        html += '</tr>';
    });

    html += '</table>';
    return html;
}

async function buildLeaderboards() {
    const metadata = await fetchCSV('data/webtables.csv');
    const headers = metadata[0];
    const rows = metadata.slice(1);

    const sortIndex = headers.indexOf('SortOrder');
    const titleIndex = headers.indexOf('DisplayTitle');
    const descIndex = headers.indexOf('DisplayDescription');
    const fileIndex = headers.indexOf('FileName');
    const enabledIndex = headers.indexOf('Enabled');

    rows.sort((a, b) => Number(a[sortIndex]) - Number(b[sortIndex]));

    let pageHtml = '';

    for (const row of rows) {
        if (row[enabledIndex].toUpperCase() !== 'TRUE') continue;

        const title = row[titleIndex];
        const description = row[descIndex];
        const fileName = row[fileIndex];

        const tableRows = await fetchCSV(`data/${fileName}`);

        pageHtml += `
            <section class="leaderboard-section">
                <h2>🏆 ${title}</h2>
                <p class="description">${description}</p>
                ${renderTable(tableRows)}
            </section>
        `;
    }

    document.getElementById('leaderboards').innerHTML = pageHtml;
}

async function loadSiteInfo() {
    const rows = await fetchCSV('data/siteinfo.csv');
    const lastUpdatedRow = rows.find(row => row[0] === 'Last Updated');

    if (lastUpdatedRow) {
        document.getElementById('last-updated').innerText =
            `Last Updated: ${lastUpdatedRow[1]}`;
    }
}

buildLeaderboards();
loadSiteInfo();