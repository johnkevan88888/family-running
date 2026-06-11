const params = new URLSearchParams(window.location.search);
const site = params.get('site') || 'family';
const dataPath = `data/${site}`;

async function buildHallOfFame() {
    const rows = await fetchCSV(`${dataPath}/halloffame.csv`);

    if (!rows.length) {
        document.getElementById('hall-of-fame').innerHTML = '';
        return;
    }

    const headers = rows[0].map(h => String(h).trim());
    const normalizedHeaders = headers.map(normalizeHeader);

    const data = rows
        .slice(1)
        .filter(row => row.some(cell => cell !== ''))
        .map(row => hofRowToObject(headers, normalizedHeaders, row))
        .sort((a, b) => Number(a.sortorder || 999) - Number(b.sortorder || 999));

    const groups = [
        {
            key: 'champions',
            title: 'Champions',
            rows: data.filter(row => hofGroup(row) === 'champions')
        },
        {
            key: 'records',
            title: 'Record Book',
            rows: data.filter(row => hofGroup(row) === 'records')
        },
        {
            key: 'history',
            title: 'Historical Achievements',
            rows: data.filter(row => hofGroup(row) === 'history')
        }
    ].filter(group => group.rows.length);

    const html = groups.map(group => `
        <section class="hof-group hof-group-${group.key}">
            <h3>${group.title}</h3>
            <div class="hall-of-fame">
                ${group.rows.map(renderHallOfFameCard).join('')}
            </div>
        </section>
    `).join('');

    document.getElementById('hall-of-fame').innerHTML = html;
}

function normalizeHeader(header) {
    return String(header).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function hofRowToObject(headers, normalizedHeaders, row) {
    const result = {};

    headers.forEach((header, index) => {
        result[normalizedHeaders[index]] = row[index] || '';
    });

    result.award = result.award || '';
    result.participant = result.participant || '';
    result.athleteid = result.athleteid || '';
    result.cardtype = result.cardtype || inferHallOfFameCardType(result.award);
    result.group = result.group || inferHallOfFameGroup(result.cardtype, result.award);
    result.primarymetriclabel = result.primarymetriclabel || defaultPrimaryMetricLabel(result);
    result.primarymetric = result.primarymetric || defaultPrimaryMetric(result);
    result.secondarymetriclabel = result.secondarymetriclabel || defaultSecondaryMetricLabel(result);
    result.secondarymetric = result.secondarymetric || defaultSecondaryMetric(result);
    result.agegradedcategory = result.agegradedcategory || result.category || '';

    return result;
}

function inferHallOfFameCardType(award) {
    const value = award.toLowerCase();

    if (value.includes('current')) return 'champion';
    if (value.includes('all time')) return 'legend';
    if (value.includes('fastest')) return 'speed';
    if (value.includes('record')) return 'record';

    return 'record';
}

function inferHallOfFameGroup(cardType, award) {
    const value = `${cardType} ${award}`.toLowerCase();

    if (value.includes('champion')) return 'champions';
    if (value.includes('history') || value.includes('standing') || value.includes('legend')) return 'history';

    return 'records';
}

function hofGroup(row) {
    const group = row.group.toLowerCase().trim();

    if (['champion', 'champions'].includes(group)) return 'champions';
    if (['history', 'historical', 'legacy'].includes(group)) return 'history';
    if (['record', 'records', 'record book'].includes(group)) return 'records';

    return inferHallOfFameGroup(row.cardtype, row.award);
}

function defaultPrimaryMetricLabel(row) {
    if (row.time) return 'Time';
    if (row.agegrade) return 'Age grade';
    return '';
}

function defaultPrimaryMetric(row) {
    return row.time || row.agegrade || '';
}

function defaultSecondaryMetricLabel(row) {
    if (row.time && row.agegrade) return 'Age grade';
    return '';
}

function defaultSecondaryMetric(row) {
    if (row.time && row.agegrade) return row.agegrade;
    return '';
}

function renderHallOfFameCard(row) {
    const cardType = row.cardtype.toLowerCase().trim() || 'record';
    const participantName = row.participant || 'Championship Vacant';
    const isVacant = participantName.toLowerCase().includes('vacant');
    const participant = row.athleteid && !isVacant
        ? athleteLink(row.athleteid.trim(), escapeHTML(participantName))
        : escapeHTML(participantName);
    const cardClasses = ['hof-card', cardType, isVacant ? 'vacant' : ''].filter(Boolean).join(' ');
    const badge = hallOfFameBadge(cardType, isVacant);
    const ageGradedCategory = row.agegradedcategory || '';
    const standardClass = ageGradedCategory
        ? ` standard-${normalizeHeader(ageGradedCategory)}`
        : '';
    const details = [
        row.distance,
        row.resulttype,
        row.race
    ].filter(Boolean).map(escapeHTML).join(' / ');
    const dateEvent = [row.event, row.date].filter(Boolean).map(escapeHTML).join(' / ');

    if (isVacant) {
        return `
            <article class="${cardClasses}">
                <div class="hof-honours">
                    <div class="hof-badge">${badge}</div>
                    <div class="hof-standard standard-vacant">${standardBadgeContent('Open')}</div>
                </div>
                <div class="hof-award">${escapeHTML(row.award)}</div>
                <div class="hof-name">Championship Vacant</div>
                <div class="hof-primary">
                    <span>Result</span>
                    No qualifier
                </div>
                <div class="hof-detail">No qualifying official performance recorded</div>
            </article>
        `;
    }

    return `
        <article class="${cardClasses}">
            <div class="hof-honours">
                <div class="hof-badge">${badge}</div>
                ${ageGradedCategory ? `<div class="hof-standard${standardClass}">${standardBadgeContent(ageGradedCategory)}</div>` : ''}
            </div>
            <div class="hof-award">${escapeHTML(row.award)}</div>
            <div class="hof-name">${participant}</div>
            ${row.primarymetric ? `
                <div class="hof-primary">
                    ${row.primarymetriclabel ? `<span>${escapeHTML(row.primarymetriclabel)}</span>` : ''}
                    ${escapeHTML(row.primarymetric)}
                </div>
            ` : ''}
            ${row.secondarymetric ? `
                <div class="hof-secondary">
                    ${row.secondarymetriclabel ? `<span>${escapeHTML(row.secondarymetriclabel)}</span>` : ''}
                    ${escapeHTML(row.secondarymetric)}
                </div>
            ` : ''}
            ${details ? `<div class="hof-detail">${details}</div>` : ''}
            ${dateEvent ? `<div class="hof-meta">${dateEvent}</div>` : ''}
        </article>
    `;
}

function standardBadgeContent(category) {
    const icon = ageGradedCategoryIcon(category);

    return `${icon ? `<span class="standard-icon">${icon}</span>` : ''}<span>${escapeHTML(category)}</span>`;
}

function ageGradedCategoryIcon(category) {
    const value = normalizeHeader(category);

    const icons = {
        recreational: '&#128994;',
        club: '&#129353;',
        localcompetitive: '&#129352;',
        regionalclass: '&#129351;',
        nationalclass: '&#127963;',
        worldclass: '&#127757;',
        open: '&#9671;'
    };

    return icons[value] || '';
}

function hallOfFameBadge(cardType, isVacant) {
    if (isVacant) return '&#127941;';

    const badges = {
        champion: '&#129351;',
        legend: '&#127942;',
        record: '&#127941;',
        speed: '&#9201;',
        improvement: '&#8593;',
        finish: '&#8644;',
        pb: 'PB',
        history: '&#8987;'
    };

    return badges[cardType] || '&#9733;';
}

function escapeHTML(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

async function loadSiteInfo() {
    const rows = await fetchCSV(`${dataPath}/siteinfo.csv`);

    const lastUpdatedRow = rows.find(row => row[0] === 'LastUpdatedUTC');
    const publishedFromRow = rows.find(row => row[0] === 'PublishedFrom');
    const siteVersionRow = rows.find(row => row[0] === 'SiteVersion');
    const siteNameRow = rows.find(row => row[0] === 'SiteName');

    if (siteNameRow) {
        document.getElementById('site-title').innerText =
            siteNameRow[1];
    }

    if (lastUpdatedRow) {
        const utcDate = new Date(lastUpdatedRow[1]);

        const localTime = utcDate.toLocaleString(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short'
        });

        const publishedFrom = publishedFromRow ? publishedFromRow[1] : 'Unknown';
        const siteVersion = siteVersionRow ? ` / ${siteVersionRow[1]}` : '';

        document.getElementById('last-updated').innerHTML =
            `Last Updated: ${localTime}<br>
             Published from: ${publishedFrom}${siteVersion}`;
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

            if (row[0] === '1' && cell === row[0]) cell = '<span class="medal">&#129351;</span>';
            if (row[0] === '2' && cell === row[0]) cell = '<span class="medal">&#129352;</span>';
            if (row[0] === '3' && cell === row[0]) cell = '<span class="medal">&#129353;</span>';

            const category = String(cell).toLowerCase();

            if (category === 'recreational') cell = '<span class="recreational">Recreational</span>';
            if (category === 'club') cell = '<span class="club">Club</span>';
            if (category === 'local competitive') cell = '<span class="local">Local Competitive</span>';
            if (category === 'regional class') cell = '<span class="regional">Regional Class</span>';
            if (category === 'national class') cell = '<span class="national">National Class</span>';
            if (category === 'world class') cell = '<span class="world">World Class</span>';

            html += `<td>${cell}</td>`;
        });

        html += '</tr>';
    });

    html += '</table>';
    return html;
}

const leaderboardGroups = new Map();

async function toggleSection(button) {
    const content = button.nextElementSibling;

    if (content.style.display === 'none') {
        content.style.display = 'block';
        button.innerText = button.innerText.replace('[+]', '[-]');
        await renderLeaderboardGroup(content.dataset.groupId);
    } else {
        content.style.display = 'none';
        button.innerText = button.innerText.replace('[-]', '[+]');
    }
}

async function renderLeaderboardGroup(groupId) {
    const group = leaderboardGroups.get(groupId);

    if (!group || group.loaded) return;

    const container = document.querySelector(`[data-group-id="${groupId}"]`);
    if (!container) return;

    container.innerHTML = '<p class="description">Loading...</p>';

    const sections = await Promise.all(group.rows.map(async row => {
        const tableRows = await fetchCSV(`${dataPath}/${row.fileName}`);

        return `
            <section class="leaderboard-section">
                <h4>${row.title}</h4>
                <p class="description">${row.description}</p>
                ${renderTable(tableRows)}
            </section>
        `;
    }));

    container.innerHTML = sections.join('');
    group.loaded = true;
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
                    ? 'Official Championships'
                    : 'All Results Championships',
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

    leaderboardGroups.clear();
    let pageHtml = '';
    let groupCounter = 0;

    for (const section of sections) {
        pageHtml += `
            <section class="timeclass-section">
                <h2 class="distance-title">${section.title}</h2>
        `;

        for (const group of section.groups) {
            const isDefaultOpen =
                section.key === 'Official' &&
                group.distance === 'Overall';

            const arrow = isDefaultOpen ? '[-]' : '[+]';
            const displayStyle = isDefaultOpen ? 'block' : 'none';
            const groupId = `leaderboard-group-${groupCounter++}`;
            const renderRows = group.rows.map(row => ({
                title: row[titleIndex],
                description: row[descIndex],
                fileName: row[fileIndex]
            }));

            leaderboardGroups.set(groupId, {
                rows: renderRows,
                loaded: false
            });

            pageHtml += `
                <button class="distance-toggle" onclick="toggleSection(this)">
                    ${arrow} ${group.distance}
                </button>
                <div class="distance-content" data-group-id="${groupId}" style="display:${displayStyle};">
            `;

            pageHtml += `</div>`;
        }

        pageHtml += `</section>`;
    }

    document.getElementById('leaderboards').innerHTML = pageHtml;

    const defaultGroup = document.querySelector('.distance-content[style*="block"]');
    if (defaultGroup) {
        await renderLeaderboardGroup(defaultGroup.dataset.groupId);
    }
}

buildHallOfFame();
buildLeaderboards();
loadSiteInfo();
