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
    const isOverallCrown = normalizeHeader(row.award).includes('overall');
    const winningDistance = row.distance || row.displaydistance || '';
    const details = [
        row.resulttype,
        row.race
    ].filter(Boolean).map(escapeHTML).join(' / ');
    const dateEvent = [
        row.event ? `&#128205; ${escapeHTML(row.event)}` : '',
        row.date ? `&#128197; ${escapeHTML(row.date)}` : ''
    ].filter(Boolean).join(' &nbsp; ');

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

function csvRowsToObjects(rows) {
    const headers = (rows[0] || []).map(header => String(header).trim());

    return rows.slice(1)
        .filter(row => row.some(cell => cell !== ''))
        .map(row => Object.fromEntries(headers.map((header, index) => [header, row[index] || ''])));
}

async function buildOverview() {
    const container = document.getElementById('overview-highlights');
    const statsContainer = document.getElementById('overview-stats');
    if (!container) return;

    const metadata = csvRowsToObjects(await fetchCSV(`${dataPath}/webtables.csv`));
    const distanceOrder = ['Overall', 'Marathon', 'Half Marathon', '10 Mile', '10 km', '5 km'];
    const currentOfficialTables = metadata
        .filter(row =>
            String(row.Enabled || '').toUpperCase() === 'TRUE' &&
            row.TimeClass === 'Official' &&
            /^Current Official /i.test(row.DisplayTitle || '')
        )
        .sort((a, b) =>
            distanceOrder.indexOf(formatHallOfFameDistance(a.DisplayDistance)) -
            distanceOrder.indexOf(formatHallOfFameDistance(b.DisplayDistance))
        );

    const highlights = await Promise.all(currentOfficialTables.map(async table => {
        const rows = csvRowsToObjects(await fetchCSV(`${dataPath}/${table.FileName}`));
        const champion = rows[0] || {};

        return {
            table,
            champion
        };
    }));
    const awardedCount = highlights.filter(({ champion }) =>
        champion.Participant && !isNoResultParticipant(champion.Participant)
    ).length;
    const openCount = Math.max(0, highlights.length - awardedCount);

    if (statsContainer) {
        statsContainer.innerHTML = `
            <div class="overview-stat">
                <strong>${awardedCount}</strong>
                <span>current official champions</span>
            </div>
            <div class="overview-stat">
                <strong>${openCount}</strong>
                <span>open official crowns</span>
            </div>
            <div class="overview-stat">
                <strong>${highlights.length}</strong>
                <span>championship distances</span>
            </div>
        `;
    }

    container.innerHTML = `
        <div class="overview-card-grid">
            ${highlights.map(renderOverviewHighlight).join('')}
        </div>
    `;
}

function renderOverviewHighlight({ table, champion }) {
    const participant = champion.Participant || 'No eligible results';
    const isNoResult = isNoResultParticipant(participant);
    const athleteId = champion['Athlete ID'] || champion.AthleteID || '';
    const participantHtml = athleteId && !isNoResult
        ? athleteLink(athleteId, escapeHTML(participant))
        : escapeHTML(participant);
    const score = champion['Age Graded Score'] || champion.AgeGrade || '';
    const event = champion.SexAgeEvent || champion.Distance || '';

    return `
        <article class="overview-highlight-card${isNoResult ? ' no-result' : ''}">
            <div class="overview-highlight-distance">${escapeHTML(formatHallOfFameDistance(table.DisplayDistance))}</div>
            <h3>${participantHtml}</h3>
            ${isNoResult ? `
                <p class="overview-highlight-empty">No eligible official result has been exported for this current championship.</p>
            ` : `
                <dl class="overview-highlight-facts">
                    ${champion.Time ? `<div><dt>Time</dt><dd>${escapeHTML(champion.Time)}</dd></div>` : ''}
                    ${score ? `<div><dt>Age grade</dt><dd>${escapeHTML(score)}</dd></div>` : ''}
                    ${event ? `<div><dt>Event</dt><dd>${escapeHTML(event)}</dd></div>` : ''}
                </dl>
                ${champion['Age Graded Category'] ? `
                    <div class="overview-highlight-standard">${escapeHTML(champion['Age Graded Category'])}</div>
                ` : ''}
            `}
        </article>
    `;
}

function isNoResultParticipant(participant) {
    const value = String(participant || '').toLowerCase();

    return value.includes('no eligible') || value.includes('vacant');
}

async function buildOverviewStats() {
    const container = document.getElementById('overview-dashboard');
    if (!container) return;

    const [athleteRows, siteAthleteIds] = await Promise.all([
        fetchCSV('data/athlete_results.csv').then(csvRowsToObjects),
        loadSiteAthleteIds()
    ]);
    const scopedRows = athleteRows
        .filter(row => row.AthleteID && siteAthleteIds.has(cleanAthleteId(row.AthleteID)))
        .map(row => ({
            ...row,
            parsedDate: parseExportedDate(row.Date)
        }))
        .filter(row => row.parsedDate);
    const latestYear = scopedRows.length
        ? Math.max(...scopedRows.map(row => row.parsedDate.getFullYear()))
        : new Date().getFullYear();
    const rowsThisYear = scopedRows.filter(row => row.parsedDate.getFullYear() === latestYear);
    const athletes = new Map();

    for (const row of scopedRows) {
        if (!athletes.has(row.AthleteID)) {
            athletes.set(row.AthleteID, row.Participant || row.AthleteID);
        }
    }

    const officialThisYear = rowsThisYear.filter(row =>
        String(row.TimeClass || '').toLowerCase() === 'official'
    );
    const latestResult = scopedRows
        .slice()
        .sort(compareResultDateDescending)[0];
    const mostActive = [...countRowsByAthlete(rowsThisYear).entries()]
        .sort((a, b) => b[1].count - a[1].count || a[1].name.localeCompare(b[1].name))
        .slice(0, 5);
    const recentResults = scopedRows
        .slice()
        .sort(compareResultDateDescending)
        .slice(0, 8);

    container.classList.add('overview-dashboard');
    container.innerHTML = `
        <div class="overview-stat-grid">
            ${renderOverviewStat(athletes.size, 'total athletes')}
            ${renderOverviewStat(rowsThisYear.length, `recorded results in ${latestYear}`)}
            ${renderOverviewStat(officialThisYear.length, `official results in ${latestYear}`)}
            ${renderOverviewStat(latestResult ? formatExportedDate(latestResult.parsedDate) : '-', 'latest recorded result')}
        </div>
        <section class="overview-panel" aria-labelledby="most-active-title">
            <h3 id="most-active-title">Most runs recorded in ${latestYear}</h3>
            ${renderMostActiveList(mostActive)}
        </section>
        <section class="overview-panel" aria-labelledby="recent-results-title">
            <h3 id="recent-results-title">Most recent exported results</h3>
            ${renderRecentResults(recentResults)}
        </section>
    `;
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
        return '<p class="description">No exported results are available for this year.</p>';
    }

    return `
        <ol class="overview-list">
            ${rows.map(([athleteId, entry]) => `
                <li>
                    <span>${athleteLink(athleteId, escapeHTML(entry.name))}</span>
                    <span class="overview-list-count">${entry.count} ${entry.count === 1 ? 'run' : 'runs'}</span>
                </li>
            `).join('')}
        </ol>
    `;
}

function renderRecentResults(rows) {
    if (!rows.length) {
        return '<p class="description">No exported recent results are available.</p>';
    }

    return `
        <div class="overview-result-list" id="overview-recent-results">
            ${rows.map(row => `
                <article class="overview-result-card">
                    <div>${athleteLink(row.AthleteID, escapeHTML(row.Participant || row.AthleteID))}</div>
                    <div class="overview-result-meta">
                        ${escapeHTML(formatExportedDate(row.parsedDate))}
                        ${row.Event ? ` &middot; ${escapeHTML(row.Event)}` : ''}
                    </div>
                    <div class="overview-result-detail">
                        ${escapeHTML(row.Distance || '')}
                        ${row.Time ? ` &middot; ${escapeHTML(row.Time)}` : ''}
                        ${row.AgeGrade ? ` &middot; ${escapeHTML(row.AgeGrade)}` : ''}
                        ${row.TimeClass ? ` &middot; ${escapeHTML(row.TimeClass)}` : ''}
                    </div>
                </article>
            `).join('')}
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
    const parts = String(value || '').split('/').map(Number);
    if (parts.length !== 3 || parts.some(part => !Number.isFinite(part))) {
        return null;
    }

    const [day, month, year] = parts;
    return new Date(year, month - 1, day);
}

function formatExportedDate(date) {
    return date.toLocaleDateString(undefined, {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
    });
}

function cleanAthleteId(value) {
    return String(value || '').trim().toLowerCase();
}

async function buildCrownHistory() {
    const container = document.getElementById('crown-history');
    const rows = await fetchCSV(`${dataPath}/crown_history.csv`);
    const headers = rows[0] || [];
    const normalizedHeaders = headers.map(normalizeHeader);
    const exportedRows = rows
        .slice(1)
        .filter(row => row.some(cell => cell !== ''))
        .map(row => crownHistoryRowToObject(normalizedHeaders, row));
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
}

function crownHistoryRowToObject(normalizedHeaders, row) {
    const result = {};

    normalizedHeaders.forEach((header, index) => {
        result[header] = row[index] || '';
    });

    return result;
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
        row.time ? `<span><strong>Time:</strong> ${escapeHTML(row.time)}</span>` : '',
        row.agegrade ? `<span><strong>Age grade:</strong> ${escapeHTML(row.agegrade)}</span>` : ''
    ].filter(Boolean).join('');
    const previousDetails = crownHistoryPreviousHolder(row);

    return `
        <li
            class="crown-history-item"
            data-effective-date="${escapeHTML(row.effectivedate)}"
            data-athlete-id="${escapeHTML(row.athleteid)}">
            <div class="crown-history-date">${escapeHTML(row.effectivedate)}</div>
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
        details.push(`<strong>Time:</strong> ${escapeHTML(row.previoustime)}`);
    }

    if (row.previousagegrade) {
        details.push(`<strong>Age grade:</strong> ${escapeHTML(row.previousagegrade)}`);
    }

    return details.length
        ? `<div class="crown-history-previous">${details.join(' &nbsp; ')}</div>`
        : '';
}

function crownHistoryAthlete(athleteId, athleteName) {
    const name = escapeHTML(athleteName);

    return athleteId
        ? athleteLink(athleteId, name)
        : name;
}

function toggleCrownHistory(button) {
    const contentId = button.getAttribute('aria-controls');
    const content = document.getElementById(contentId);
    const expanded = button.getAttribute('aria-expanded') === 'true';

    button.setAttribute('aria-expanded', String(!expanded));
    content.hidden = expanded;
    button.querySelector('.crown-history-symbol').textContent = expanded ? '[+]' : '[-]';
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
        const siteVersion = siteVersionRow ? siteVersionRow[1] : '';

        document.getElementById('last-updated').innerHTML =
            `<div class="site-meta-item">
                <span class="site-meta-icon" aria-hidden="true">&#128197;</span>
                <span><strong>Updated</strong> ${escapeHTML(localTime)}</span>
             </div>
             <div class="site-meta-item">
                <span class="site-meta-icon" aria-hidden="true">&#128205;</span>
                <span><strong>Published from</strong> ${escapeHTML(publishedFrom)}</span>
             </div>
             ${siteVersion ? `<div class="site-meta-item">
                <span class="site-meta-icon" aria-hidden="true">&#9432;</span>
                <span><strong>Website version</strong> <span class="site-version">${escapeHTML(siteVersion)}</span></span>
             </div>` : ''}`;
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
            if (cellIndex === athleteIdIndex || header === 'ExportBundleID') {
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

if (document.getElementById('overview-highlights')) {
    buildOverview();
}

if (document.getElementById('overview-dashboard')) {
    buildOverviewStats();
}

if (document.getElementById('hall-of-fame')) {
    buildHallOfFame();
}

if (document.getElementById('crown-history')) {
    buildCrownHistory();
}

if (document.getElementById('leaderboards')) {
    buildLeaderboards();
}

loadSiteInfo();
