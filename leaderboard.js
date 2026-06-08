const params = new URLSearchParams(window.location.search);
const site = params.get('site') || 'family';
const dataPath = `data/${site}`;

async function buildHallOfFame() {
    const rows = await fetchCSV(`${dataPath}/halloffame.csv`);

    const headers = rows[0].map(h => String(h).trim());

    const awardIndex = headers.findIndex(h => h.toLowerCase() === 'award');
    const participantIndex = headers.findIndex(h => h.toLowerCase() === 'participant');
    const distanceIndex = headers.findIndex(h => h.toLowerCase() === 'distance');
    const timeIndex = headers.findIndex(h => h.toLowerCase() === 'time');
    const ageGradeIndex = headers.findIndex(h => h.toLowerCase() === 'agegrade');
    const dateIndex = headers.findIndex(h => h.toLowerCase() === 'date');
    const eventIndex = headers.findIndex(h => h.toLowerCase() === 'event');
    const athleteIdIndex = headers.findIndex(h =>
        h.toLowerCase().replace(/\s+/g, '') === 'athleteid'
    );

    const data = rows.slice(1).filter(row => row.some(cell => cell !== ''));

    let html = '<div class="hall-of-fame">';

    data.forEach(row => {
        const award = row[awardIndex] || '';
        const participantName = row[participantIndex] || 'Championship Vacant';
        const distance = row[distanceIndex] || '';
        const time = row[timeIndex] || '';
        const ageGrade = row[ageGradeIndex] || '';
        const date = row[dateIndex] || '';
        const event = row[eventIndex] || '';
        const athleteId = athleteIdIndex >= 0 ? row[athleteIdIndex] || '' : '';

        const isVacant = participantName.toLowerCase().includes('vacant');

        const participant = athleteId && !isVacant
            ? athleteLink(athleteId.trim(), participantName)
            : participantName;

        let cardClass = 'hof-card record';

        if (award.toLowerCase().includes('current')) {
            cardClass = 'hof-card champion';
        } else if (award.toLowerCase().includes('all time')) {
            cardClass = 'hof-card legend';
        }

        if (isVacant) {
            html += `
                <div class="${cardClass} vacant">
                    <div class="hof-medal">🏅</div>
                    <div class="hof-award">${award}</div>
                    <div class="hof-name">Championship Vacant</div>
                    <div class="hof-detail">No qualifying official performance recorded</div>
                </div>
            `;
            return;
        }

        html += `
            <div class="${cardClass}">
                <div class="hof-medal">🥇</div>
                <div class="hof-award">${award}</div>
                <div class="hof-name">${participant}</div>
                <div class="hof-grade">${ageGrade}</div>
                <div class="hof-distance">${distance}</div>
                <div class="hof-time">${time}</div>
                <div class="hof-meta">
                    📅 ${date} • 📍 ${event}
                </div>
            </div>
        `;
    });

    html += '</div>';

    document.getElementById('hall-of-fame').innerHTML = html;
}


async function loadSiteInfo() {
    const rows = await fetchCSV(`${dataPath}/siteinfo.csv`);

    const lastUpdatedRow = rows.find(row => row[0] === 'LastUpdatedUTC');
    const publishedFromRow = rows.find(row => row[0] === 'PublishedFrom');
    const siteVersionRow = rows.find(row => row[0] === 'SiteVersion');
    const siteNameRow = rows.find(row => row[0] === 'SiteName');

    if (siteNameRow) {
        document.getElementById('site-title').innerText =
            `🏆 ${siteNameRow[1]}`;
    }

    if (lastUpdatedRow) {
        const utcDate = new Date(lastUpdatedRow[1]);

        const localTime = utcDate.toLocaleString(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short'
        });

        const publishedFrom = publishedFromRow ? publishedFromRow[1] : 'Unknown';
        const siteVersion = siteVersionRow ? ` • ${siteVersionRow[1]}` : '';

        document.getElementById('last-updated').innerHTML =
            `🏁 Last Updated: ${localTime}<br>
             📍 Published from: ${publishedFrom}${siteVersion}`;
    }
}


function renderTable(rows) {
    const headers = rows[0].map(h => String(h).trim());

    const athleteIdIndex = headers.findIndex(h =>
        h.toLowerCase().replace(/\s+/g, '') === 'athleteid'
    );

    const participantIndex = headers.findIndex(h =>
        h.toLowerCase().trim() === 'participant'
    );

    let html = '<table>';

    rows.forEach((row, rowIndex) => {
        html += '<tr>';

        headers.forEach((header, cellIndex) => {
            if (cellIndex === athleteIdIndex) {
                return;
            }

            if (rowIndex === 0) {
                html += `<th>${header}</th>`;
                return;
            }

            let cell = row[cellIndex] || '';

            if (
                cellIndex === participantIndex &&
                athleteIdIndex >= 0 &&
                row[athleteIdIndex]
            ) {
                cell = athleteLink(row[athleteIdIndex], cell);
            }

            if (row[0] === '1' && cell === row[0]) cell = '<span class="medal">🥇</span>';
            if (row[0] === '2' && cell === row[0]) cell = '<span class="medal">🥈</span>';
            if (row[0] === '3' && cell === row[0]) cell = '<span class="medal">🥉</span>';

            const category = String(cell).toLowerCase();

            if (category === 'recreational') cell = '<span class="recreational">🟢 Recreational</span>';
            if (category === 'club') cell = '<span class="club">🥉 Club</span>';
            if (category === 'local competitive') cell = '<span class="local">🥈 Local Competitive</span>';
            if (category === 'regional class') cell = '<span class="regional">🥇 Regional Class</span>';
            if (category === 'national class') cell = '<span class="national">🏛️ National Class</span>';
            if (category === 'world class') cell = '<span class="world">🌍 World Class</span>';

            html += `<td>${cell}</td>`;
        });

        html += '</tr>';
    });

    html += '</table>';
    return html;
}

function toggleSection(button) {
    const content = button.nextElementSibling;

    if (content.style.display === 'none') {
        content.style.display = 'block';
        button.innerText = button.innerText.replace('▶', '▼');
    } else {
        content.style.display = 'none';
        button.innerText = button.innerText.replace('▼', '▶');
    }
}

async function buildLeaderboards() {
    const metadata = await fetchCSV(`${dataPath}/webtables.csv`);
    const headers = metadata[0];
    const rows = metadata.slice(1);

    const sortIndex = headers.indexOf('SortOrder');
    const timeClassIndex = headers.indexOf('TimeClass');
    const distanceIndex = headers.indexOf('DisplayDistance');
    const titleIndex = headers.indexOf('DisplayTitle');
    const descIndex = headers.indexOf('DisplayDescription');
    const fileIndex = headers.indexOf('FileName');
    const enabledIndex = headers.indexOf('Enabled');

    const enabledRows = rows
        .filter(row => row[enabledIndex].toUpperCase() === 'TRUE')
        .sort((a, b) => Number(a[sortIndex]) - Number(b[sortIndex]));

    const sections = [];

    enabledRows.forEach(row => {
        const timeClass = timeClassIndex >= 0 ? row[timeClassIndex] : 'All';
        const sectionKey = timeClass === 'Official' ? 'Official' : 'All';

        let section = sections.find(s => s.key === sectionKey);

        if (!section) {
            section = {
                key: sectionKey,
                title: sectionKey === 'Official'
                    ? '🏆 Official Championships'
                    : '📊 All Results Championships',
                groups: []
            };

            sections.push(section);
        }

        const distance = distanceIndex >= 0 ? row[distanceIndex] : 'Overall';

        let group = section.groups.find(g => g.distance === distance);

        if (!group) {
            group = {
                distance: distance,
                rows: []
            };

            section.groups.push(group);
        }

        group.rows.push(row);
    });

    let pageHtml = '';

    for (const section of sections) {
        pageHtml += `
            <section class="timeclass-section">
                <h2 class="distance-title">${section.title}</h2>
        `;

        for (const group of section.groups) {
            const isDefaultOpen =
                section.key === 'Official' &&
                group.distance === 'Overall';

            const arrow = isDefaultOpen ? '▼' : '▶';
            const displayStyle = isDefaultOpen ? 'block' : 'none';

            pageHtml += `
                <button class="distance-toggle" onclick="toggleSection(this)">
                    ${arrow} ${group.distance}
                </button>
                <div class="distance-content" style="display:${displayStyle};">
            `;

            for (const row of group.rows) {
                const title = row[titleIndex];
                const description = row[descIndex];
                const fileName = row[fileIndex];

                const tableRows = await fetchCSV(`${dataPath}/${fileName}`);

                pageHtml += `
                    <section class="leaderboard-section">
                        <h4>${title}</h4>
                        <p class="description">${description}</p>
                        ${renderTable(tableRows)}
                    </section>
                `;
            }

            pageHtml += `</div>`;
        }

        pageHtml += `</section>`;
    }

    document.getElementById('leaderboards').innerHTML = pageHtml;
}
buildHallOfFame();
buildLeaderboards();
loadSiteInfo();