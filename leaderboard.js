const params = new URLSearchParams(window.location.search);
const site = window.siteNavigation?.selectedSite
    ? window.siteNavigation.selectedSite()
    : (params.get('site') || 'family');
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
    refreshPaceDisplay();
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
        ? athleteLink(row.athleteid.trim(), participantName)
        : escapeHTML(participantName);
    const cardClasses = ['hof-card', cardType, isVacant ? 'vacant' : ''].filter(Boolean).join(' ');
    const badge = hallOfFameBadge(cardType, isVacant);
    const ageGradedCategory = row.agegradedcategory || '';
    const standardClass = ageGradedCategory
        ? ` standard-${normalizeHeader(ageGradedCategory)}`
        : '';
    const isOverallCrown = normalizeHeader(row.award).includes('overall');
    const winningDistance = row.distance || row.displaydistance || '';
    const details = [
        row.resulttype,
        row.race
    ].filter(Boolean).map(escapeHTML).join(' / ');
    const dateEvent = [
        row.event ? `&#128205; ${escapeHTML(row.event)}` : '',
        row.date ? `&#128197; ${escapeHTML(formatExportedDate(row.date))}` : ''
    ].filter(Boolean).join(' &nbsp; ');
    const primaryMetric = row.primarymetric
        ? renderHallOfFameMetric(row.primarymetriclabel, row.primarymetric, row)
        : '';
    const secondaryMetric = row.secondarymetric
        ? renderHallOfFameMetric(row.secondarymetriclabel, row.secondarymetric, row)
        : '';

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
                    <span class="metric-label">Result</span>
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
            ${primaryMetric ? `
                <div class="hof-primary">
                    ${row.primarymetriclabel ? `<span class="metric-label">${escapeHTML(row.primarymetriclabel)}</span>` : ''}
                    ${primaryMetric}
                </div>
            ` : ''}
            ${secondaryMetric ? `
                <div class="hof-secondary">
                    ${row.secondarymetriclabel ? `<span class="metric-label">${escapeHTML(row.secondarymetriclabel)}</span>` : ''}
                    ${secondaryMetric}
                </div>
            ` : ''}
            ${row.ageclass ? `
                <div class="hof-age-class">
                    <span>Age class</span>
                    <strong>${escapeHTML(row.ageclass)}</strong>
                </div>
            ` : ''}
            ${isOverallCrown && winningDistance ? `
                <div class="hof-winning-distance">
                    <span>Won over</span>
                    <strong>${escapeHTML(formatHallOfFameDistance(winningDistance))}</strong>
                </div>
            ` : ''}
            ${details ? `<div class="hof-detail">${details}</div>` : ''}
            ${dateEvent ? `<div class="hof-meta">${dateEvent}</div>` : ''}
        </article>
    `;
}

function formatHallOfFameDistance(distance) {
    return String(distance || '')
        .replace(/^H\. Mar$/i, 'Half Marathon')
        .replace(/^10km$/i, '10 km')
        .replace(/^5km$/i, '5 km');
}

function renderHallOfFameMetric(label, value, row) {
    const isTimeMetric = normalizeHeader(label || '') === 'time' ||
        (row.time && value === row.time);

    return isTimeMetric
        ? renderTimeWithPace(value, row.distance, row.displaydistance)
        : escapeHTML(value);
}

function renderTimeWithPace(time, ...distanceCandidates) {
    return window.paceDisplay?.renderTimeWithPace(time, ...distanceCandidates) ||
        escapeHTML(time);
}

function refreshPaceDisplay() {
    window.paceDisplay?.initialize(document);
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

async function buildOverviewStats() {
    const container = document.getElementById('overview-dashboard');
    if (!container) return;

    const [athleteRows, siteAthleteIds, siteInfoRows] = await Promise.all([
        fetchCSV('data/athlete_results.csv').then(csvRowsToObjects),
        loadSiteAthleteIds(),
        fetchCSV(`${dataPath}/siteinfo.csv`)
    ]);
    const officialRows = athleteRows
        .filter(row => row.AthleteID && siteAthleteIds.has(cleanAthleteId(row.AthleteID)))
        .filter(row => String(row.TimeClass || '').toLowerCase() === 'official')
        .map(row => ({
            ...row,
            parsedDate: parseExportedDate(row.Date)
        }))
        .filter(row => row.parsedDate);
    const latestResult = officialRows
        .slice()
        .sort(compareResultDateDescending)[0];
    const publishedAt = siteInfoRows.find(row => row[0] === 'LastUpdatedUTC')?.[1] || '';
    const publishedDate = parseExportedDate(String(publishedAt).split('T')[0]);
    const windowEnd = publishedDate || latestResult?.parsedDate || new Date();
    const twelveMonthStart = window.dateDisplay.subtractMonths(windowEnd, 12);
    const sixMonthStart = window.dateDisplay.subtractMonths(windowEnd, 6);
    const rowsLastTwelveMonths = officialRows.filter(row =>
        row.parsedDate >= twelveMonthStart && row.parsedDate <= windowEnd
    );
    const rowsLastSixMonths = officialRows.filter(row =>
        row.parsedDate >= sixMonthStart && row.parsedDate <= windowEnd
    );
    const athletes = new Map();
    const athletesLastTwelveMonths = new Set();

    for (const row of officialRows) {
        if (!athletes.has(row.AthleteID)) {
            athletes.set(row.AthleteID, row.Participant || row.AthleteID);
        }
    }

    for (const row of rowsLastTwelveMonths) {
        athletesLastTwelveMonths.add(row.AthleteID);
    }

    const mostActive = [...countRowsByAthlete(rowsLastTwelveMonths).entries()]
        .sort((a, b) => b[1].count - a[1].count || a[1].name.localeCompare(b[1].name));
    const recentResults = rowsLastSixMonths
        .slice()
        .sort(compareResultDateDescending);

    container.classList.add('overview-dashboard');
    container.innerHTML = `
        <div class="overview-stat-grid">
            ${renderOverviewStat(athletes.size, 'athletes with official results')}
            ${renderOverviewStat(rowsLastTwelveMonths.length, 'official results in the last 12 months')}
            ${renderOverviewStat(athletesLastTwelveMonths.size, 'official athletes in the last 12 months')}
            ${renderOverviewStat(latestResult ? formatExportedDate(latestResult.parsedDate) : '-', 'latest official result')}
        </div>
        <section class="overview-panel" aria-labelledby="most-active-title">
            <h3 id="most-active-title">Most official runs recorded in the last 12 months</h3>
            ${renderMostActiveList(mostActive)}
        </section>
        <section class="overview-panel" aria-labelledby="recent-results-title">
            <h3 id="recent-results-title">Most recent official results from the last six months</h3>
            ${renderRecentResults(recentResults)}
        </section>
    `;
    refreshPaceDisplay();
}

async function loadSiteAthleteIds() {
    const ids = new Set();

    try {
        const standardsRows = csvRowsToObjects(await fetchCSV(`${dataPath}/age_grade_standards.csv`));
        for (const row of standardsRows) {
            const id = cleanAthleteId(row.AthleteId || row.AthleteID || row['Athlete ID']);
            if (id) ids.add(id);
        }
    } catch (error) {
        // Fall back to the shared athlete file below if the site-specific export is unavailable.
    }

    if (!ids.size && site === 'everyone') {
        const athleteRows = csvRowsToObjects(await fetchCSV('data/athlete_results.csv'));
        for (const row of athleteRows) {
            const id = cleanAthleteId(row.AthleteID);
            if (id) ids.add(id);
        }
    }

    return ids;
}

function renderOverviewStat(value, label) {
    return `
        <article class="overview-stat-card">
            <strong>${escapeHTML(value)}</strong>
            <span>${escapeHTML(label)}</span>
        </article>
    `;
}

function renderMostActiveList(rows) {
    if (!rows.length) {
        return '<p class="description">No exported official results are available for the last 12 months.</p>';
    }

    return `
        <ol class="overview-list">
            ${rows.map(([athleteId, entry]) => `
                <li>
                    <span>${athleteLink(athleteId, entry.name)}</span>
                    <span class="overview-list-count">${entry.count} ${entry.count === 1 ? 'run' : 'runs'}</span>
                </li>
            `).join('')}
        </ol>
    `;
}

function renderRecentResults(rows) {
    if (!rows.length) {
        return '<p class="description">No exported official recent results are available.</p>';
    }

    return `
        <div class="overview-result-list" id="overview-recent-results">
            ${rows.map(row => {
                const resultDetails = [
                    row.Distance ? escapeHTML(row.Distance) : '',
                    row.Time ? renderTimeWithPace(row.Time, row.Distance) : '',
                    row.AgeGrade ? escapeHTML(row.AgeGrade) : '',
                    row.TimeClass ? escapeHTML(row.TimeClass) : ''
                ].filter(Boolean).join(' &middot; ');

                return `
                    <article class="overview-result-card">
                        <div>${athleteLink(row.AthleteID, row.Participant || row.AthleteID)}</div>
                        <div class="overview-result-meta">
                            ${escapeHTML(formatExportedDate(row.parsedDate))}
                            ${row.Event ? ` &middot; ${escapeHTML(row.Event)}` : ''}
                        </div>
                        <div class="overview-result-detail">
                            ${resultDetails}
                        </div>
                    </article>
                `;
            }).join('')}
        </div>
    `;
}

function countRowsByAthlete(rows) {
    const counts = new Map();

    for (const row of rows) {
        const id = cleanAthleteId(row.AthleteID);
        if (!id) continue;

        const current = counts.get(id) || {
            count: 0,
            name: row.Participant || id
        };

        current.count += 1;
        current.name = current.name || row.Participant || id;
        counts.set(id, current);
    }

    return counts;
}

function compareResultDateDescending(a, b) {
    return b.parsedDate - a.parsedDate || String(a.Participant || '').localeCompare(String(b.Participant || ''));
}

function parseExportedDate(value) {
    return window.dateDisplay?.parse(value) || null;
}

function formatExportedDate(value) {
    return window.dateDisplay?.format(value) || String(value || '');
}

function cleanAthleteId(value) {
    return String(value || '').trim().toLowerCase();
}

async function buildCrownHistory() {
    const container = document.getElementById('crown-history');
    const [rows, athleteResultRows] = await Promise.all([
        fetchCSV(`${dataPath}/crown_history.csv`),
        fetchCSV('data/athlete_results.csv').catch(() => [])
    ]);
    const headers = rows[0] || [];
    const normalizedHeaders = headers.map(normalizeHeader);
    const athleteResults = athleteResultRows.length
        ? csvRowsToObjects(athleteResultRows)
        : [];
    const exportedRows = rows
        .slice(1)
        .filter(row => row.some(cell => cell !== ''))
        .map(row => enrichCrownHistoryRow(crownHistoryRowToObject(normalizedHeaders, row), athleteResults));
    const crownOrder = ['Overall', 'Marathon', 'Half Marathon', '10 Mile', '10 km', '5 km'];
    const groups = crownOrder
        .map(distance => ({
            distance,
            rows: exportedRows.filter(row => row.distance === distance)
        }))
        .filter(group => group.rows.length);

    if (!groups.length) {
        container.innerHTML =
            '<p class="crown-history-empty">No All-Time Official crown progression has been exported.</p>';
        container.dataset.rendered = 'true';
        return;
    }

    const defaultGroupIndex = Math.max(0, groups.findIndex(group => group.distance === 'Overall'));

    container.innerHTML = `
        <div class="crown-history-groups">
            ${groups.map((group, index) =>
                renderCrownHistoryGroup(group, index, index === defaultGroupIndex)
            ).join('')}
        </div>
    `;
    container.dataset.rendered = 'true';
    refreshPaceDisplay();
}

function crownHistoryRowToObject(normalizedHeaders, row) {
    const result = {};

    normalizedHeaders.forEach((header, index) => {
        result[header] = row[index] || '';
    });

    return result;
}

function enrichCrownHistoryRow(row, athleteResults) {
    row.resultdistance = resolveCrownHistoryResultDistance(
        athleteResults,
        row.athleteid,
        row.time,
        row.effectivedate,
        row.event
    ) || row.distance;
    row.previousresultdistance = resolveCrownHistoryResultDistance(
        athleteResults,
        row.previousathleteid,
        row.previoustime
    ) || row.distance;

    return row;
}

function resolveCrownHistoryResultDistance(athleteResults, athleteId, time, date = '', event = '') {
    if (!athleteId || !time) return '';

    const matches = athleteResults.filter(result =>
        cleanAthleteId(result.AthleteID) === cleanAthleteId(athleteId) &&
        result.Time === time
    );

    if (!matches.length) return '';

    const exactMatch = matches.find(result =>
        (!date || result.Date === date) &&
        (!event || result.Event === event)
    );

    return (exactMatch || matches[0]).Distance || '';
}

function renderCrownHistoryGroup(group, index, expanded) {
    const contentId = `crown-history-content-${index}`;
    const transitionLabel = group.rows.length === 1 ? '1 transition' : `${group.rows.length} transitions`;

    return `
        <section class="crown-history-group" data-distance="${escapeHTML(group.distance)}">
            <button
                class="crown-history-toggle"
                type="button"
                aria-expanded="${expanded}"
                aria-controls="${contentId}"
                onclick="toggleCrownHistory(this)">
                <span class="crown-history-toggle-label">
                    <span class="crown-history-symbol" aria-hidden="true">${expanded ? '[-]' : '[+]'}</span>
                    <span class="crown-history-distance">${escapeHTML(group.distance)}</span>
                </span>
                <span class="crown-history-count">${transitionLabel}</span>
            </button>
            <div
                class="crown-history-content"
                id="${contentId}"
                ${expanded ? '' : 'hidden'}>
                <ol class="crown-history-timeline">
                    ${group.rows.map(renderCrownHistoryEntry).join('')}
                </ol>
            </div>
        </section>
    `;
}

function renderCrownHistoryEntry(row) {
    const holder = crownHistoryAthlete(row.athleteid, row.athletename);
    const performance = [
        row.time ? `<span><strong>Time:</strong> ${renderTimeWithPace(row.time, row.resultdistance, row.distance)}</span>` : '',
        row.agegrade ? `<span><strong>Age grade:</strong> ${escapeHTML(row.agegrade)}</span>` : ''
    ].filter(Boolean).join('');
    const previousDetails = crownHistoryPreviousHolder(row);

    return `
        <li
            class="crown-history-item"
            data-effective-date="${escapeHTML(row.effectivedate)}"
            data-athlete-id="${escapeHTML(row.athleteid)}">
            <div class="crown-history-date">${escapeHTML(formatExportedDate(row.effectivedate))}</div>
            <article class="crown-history-card">
                <h4 class="crown-history-holder">${holder}</h4>
                ${performance ? `<div class="crown-history-performance">${performance}</div>` : ''}
                ${row.event ? `<div class="crown-history-event"><strong>Event:</strong> ${escapeHTML(row.event)}</div>` : ''}
                ${previousDetails}
                <div class="crown-history-reason">${escapeHTML(row.changereason)}</div>
            </article>
        </li>
    `;
}

function crownHistoryPreviousHolder(row) {
    const details = [];

    if (row.previousathletename) {
        details.push(
            `<strong>Previous holder:</strong> ${crownHistoryAthlete(row.previousathleteid, row.previousathletename)}`
        );
    } else if (row.previousathleteid) {
        details.push(
            `<strong>Previous holder ID:</strong> ${crownHistoryAthlete(row.previousathleteid, row.previousathleteid)}`
        );
    }

    if (row.previoustime) {
        details.push(`<strong>Time:</strong> ${renderTimeWithPace(row.previoustime, row.previousresultdistance, row.distance)}`);
    }

    if (row.previousagegrade) {
        details.push(`<strong>Age grade:</strong> ${escapeHTML(row.previousagegrade)}`);
    }

    return details.length
        ? `<div class="crown-history-previous">${details.join(' &nbsp; ')}</div>`
        : '';
}

function crownHistoryAthlete(athleteId, athleteName) {
    return athleteId
        ? athleteLink(athleteId, athleteName)
        : escapeHTML(athleteName);
}

function toggleCrownHistory(button) {
    const contentId = button.getAttribute('aria-controls');
    const content = document.getElementById(contentId);
    const expanded = button.getAttribute('aria-expanded') === 'true';

    button.setAttribute('aria-expanded', String(!expanded));
    content.hidden = expanded;
    button.querySelector('.crown-history-symbol').textContent = expanded ? '[+]' : '[-]';
}

function renderLeaderboardTable(rows) {
    const headers = rows[0].map(h => String(h).trim());

    const athleteIdIndex = headers.findIndex(h =>
        h.toLowerCase().replace(/\s+/g, '') === 'athleteid'
    );

    const participantIndex = headers.findIndex(h =>
        h.toLowerCase().trim() === 'participant'
    );

    const rankIndex = headers.findIndex(h =>
        h.toLowerCase().trim() === 'rank'
    );

    // A Map, not an object literal, so an exported value like "constructor"
    // cannot resolve through Object.prototype.
    const medals = new Map([
        ['1', '&#129351;'],
        ['2', '&#129352;'],
        ['3', '&#129353;']
    ]);

    let html = '<table>';

    rows.forEach((row, rowIndex) => {
        html += '<tr>';
        const rowObject = Object.fromEntries(headers.map((header, index) => [header, row[index] || '']));

        headers.forEach((header, cellIndex) => {
            if (cellIndex === athleteIdIndex || header === 'ExportBundleID') {
                return;
            }

            if (rowIndex === 0) {
                html += `<th>${escapeHTML(header)}</th>`;
                return;
            }

            const value = row[cellIndex] || '';
            const normalizedHeader = header.toLowerCase().replace(/\s+/g, '');
            let cell = escapeHTML(value);

            if (
                cellIndex === participantIndex &&
                athleteIdIndex >= 0 &&
                row[athleteIdIndex]
            ) {
                cell = athleteLink(row[athleteIdIndex], value);
            }

            // Both helpers take the raw exported value: renderTimeWithPace
            // escapes internally, and formatExportedDate is escaped after
            // formatting. Passing the already-escaped cell would double-escape.
            if (normalizedHeader === 'time') {
                cell = renderTimeWithPace(
                    value,
                    rowObject.SexAgeEvent,
                    rowObject.Distance,
                    rowObject.DisplayDistance
                );
            }

            if (['date', 'eventdate', 'effectivedate', 'standarddate'].includes(normalizedHeader)) {
                cell = escapeHTML(formatExportedDate(value));
            }

            // Match on the rank column itself, so an unrelated column that
            // happens to hold "1" is never replaced by a medal.
            if (cellIndex === rankIndex && medals.has(value)) {
                cell = `<span class="medal">${medals.get(value)}</span>`;
            }

            const category = value.toLowerCase();

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
                <h4>${escapeHTML(row.title)}</h4>
                <p class="description">${escapeHTML(row.description)}</p>
                ${renderLeaderboardTable(tableRows)}
            </section>
        `;
    }));

    container.innerHTML = sections.join('');
    group.loaded = true;
    refreshPaceDisplay();
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

            // group.distance is the exported DisplayDistance value from
            // webtables.csv. It reaches the page as markup, so it is escaped
            // here for the same reason every other exported value is.
            pageHtml += `
                <button class="distance-toggle" onclick="toggleSection(this)">
                    ${arrow} ${escapeHTML(group.distance)}
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

// A rejected export load must leave a readable message rather than a section
// stuck on its placeholder text forever.
function startSection(containerId, build, errorMessage) {
    const container = document.getElementById(containerId);

    if (!container) {
        return;
    }

    build().catch(error => {
        console.error(`Section "${containerId}" failed to render:`, error);
        container.innerHTML =
            `<p class="load-error" role="alert">${escapeHTML(errorMessage)}</p>`;
    });
}

startSection(
    'overview-dashboard',
    buildOverviewStats,
    'Result statistics could not be loaded. Please refresh to try again.'
);
startSection(
    'hall-of-fame',
    buildHallOfFame,
    'Hall of Fame data could not be loaded. Please refresh to try again.'
);
startSection(
    'crown-history',
    buildCrownHistory,
    'Crown progression could not be loaded. Please refresh to try again.'
);
startSection(
    'leaderboards',
    buildLeaderboards,
    'Championship standings could not be loaded. Please refresh to try again.'
);
