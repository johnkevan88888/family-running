const params = new URLSearchParams(window.location.search);
const athleteId = params.get('id');

const site = params.get('site') || 'family';

function updateBackLink() {
    const backLink = document.querySelector('.back-link');

    if (!backLink) return;

    backLink.href = `index.html?site=${site}`;
}

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


function buildProgressionChart(results) {
    const canvas = document.getElementById('age-grade-chart');

    if (!canvas) return;

    if (typeof Chart === 'undefined') {
        document.getElementById('progression').innerHTML = '<p>Progression chart could not be loaded.</p>';
        return;
    }

    const chartResults = results
        .filter(row => row.Date && row.AgeGrade)
        .sort((a, b) => parseDate(a.Date) - parseDate(b.Date));

    if (chartResults.length === 0) {
        document.getElementById('progression').innerHTML = '<p>No progression data found.</p>';
        return;
    }

    const officialResults = chartResults.filter(row =>
        clean(row.TimeClass) === 'official'
    );

    const unofficialResults = chartResults.filter(row =>
        clean(row.TimeClass) === 'unofficial');

const ageGrades = chartResults.map(r =>
    ageGradeToNumber(r.AgeGrade)
);

const minAgeGrade = Math.min(...ageGrades);
const maxAgeGrade = Math.max(...ageGrades);

const yMin = Math.floor((minAgeGrade - 2) / 5) * 5;
const yMax = Math.ceil((maxAgeGrade + 2) / 5) * 5;

const padding = Math.max(
    1,
    (maxAgeGrade - minAgeGrade) * 0.1
);
    
    new Chart(canvas, {
        type: 'line',
        data: {
            datasets: [
                {
                    label: 'Official Age Grade %',
                    data: officialResults.map(row => ({
                        x: parseDate(row.Date),
                        y: ageGradeToNumber(row.AgeGrade)
                    })),
                    borderColor: '#2b5c88',
                    backgroundColor: '#2b5c88',
                    pointRadius: 5,
                    pointHoverRadius: 8,
                    borderWidth: 2,
                    tension: 0,
spanGaps: true
                },
                {
                    label: 'Unofficial Age Grade %',
                    data: unofficialResults.map(row => ({
                        x: parseDate(row.Date),
                        y: ageGradeToNumber(row.AgeGrade)
                    })),
                    borderColor: '#999999',
                    backgroundColor: '#999999',
                    pointRadius: 5,
                    pointHoverRadius: 8,
                    borderWidth: 2,
                    borderDash: [6, 4],
                    tension: 0,
spanGaps: true
                }
            ]
        },
        options: {
            responsive: true,
            parsing: false,
            plugins: {
                tooltip: {
                    callbacks: {
                        afterLabel: function(context) {
                            const datasetLabel = context.dataset.label;
                            const sourceResults =
    context.dataset.label === 'Official Age Grade %'
        ? officialResults
        : unofficialResults;

                            const row = sourceResults[context.dataIndex];

                            return [
                                `Event: ${row.Event}`,
                                `Distance: ${row.Distance}`,
                                `Time: ${row.Time}`,
                                `Class: ${row.TimeClass}`
                            ];
                        }
                    }
                }
            },
            scales: {
                y: {
                    min: yMin,
                    max: yMax,
                    ticks: {
                        stepSize: 5,
                        callback: function(value) {
                            return value + '%';
                        }
                    },
                    title: {
                        display: true,
                        text: 'Age Grade %'
                    }
                },
                x: {
                    type: 'time',
                    min: chartResults[0].Date ? parseDate(chartResults[0].Date) : undefined,
                    max: chartResults[chartResults.length - 1].Date ? parseDate(chartResults[chartResults.length - 1].Date) : undefined,
                    time: {
                        unit: 'year',
                        tooltipFormat: 'dd MMM yyyy',
                        displayFormats: {
                            year: 'yyyy'
                        }
                    },
                    ticks: {
                        source: 'auto',
                        autoSkip: true,
                        maxRotation: 0
                    },
                    title: {
                        display: true,
                        text: 'Date'
                    }
                }
            }
        }
    });
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

async function buildOfficialMedals() {
    const section = document.getElementById('official-medals-section');
    const container = document.getElementById('official-medals');

    if (!section || !container) return;

    const rows = await fetchCSV(`data/${site}/official_medals.csv`);

    if (!rows.length) return;

    const medals = csvRowsToObjects(rows)
        .filter(row => clean(row.AthleteId) === clean(athleteId))
        .sort((a, b) => Number(a.SortOrder || 9999) - Number(b.SortOrder || 9999));

    if (medals.length === 0) {
        section.classList.add('hidden');
        container.innerHTML = '';
        return;
    }

    section.classList.remove('hidden');
    container.innerHTML = `
        <div class="official-medal-grid">
            ${medals.map(renderOfficialMedal).join('')}
        </div>
    `;
}

async function buildCrownStandards() {
    const section = document.getElementById('crown-standards-section');
    const container = document.getElementById('crown-standards');

    if (!section || !container) return;

    try {
        const rows = await fetchCSV(`data/${site}/crown_standards.csv`);

        if (!rows.length) {
            hideCrownStandards(section, container);
            return;
        }

        const standards = csvRowsToObjects(rows)
            .filter(isRenderableCrownStandard)
            .sort((a, b) => Number(a.SortOrder || 9999) - Number(b.SortOrder || 9999));

        if (standards.length === 0) {
            hideCrownStandards(section, container);
            return;
        }

        section.classList.remove('hidden');
        container.innerHTML = `
            <div class="crown-standards-grid">
                ${standards.map(renderCrownStandard).join('')}
            </div>
        `;
    } catch (error) {
        hideCrownStandards(section, container);
    }
}

function hideCrownStandards(section, container) {
    section.classList.add('hidden');
    container.innerHTML = '';
}

function isRenderableCrownStandard(standard) {
    const status = clean(standard.Status);

    return clean(standard.AthleteId) === clean(athleteId) &&
        status !== 'no standard' &&
        Boolean(standard.Distance) &&
        Boolean(standard.Period) &&
        Boolean(standard.RequiredTimeToTake);
}

function renderCrownStandard(standard) {
    const status = standard.Status || 'Chasing';
    const statusClass = crownStandardStatusClass(status);
    const periodClass = crownStandardPeriodClass(standard.Period);
    const isHeld = clean(status) === 'held';
    const holderName = standard.CrownHolderName || 'Championship Vacant';
    const periodLabel = clean(standard.Period) === 'all time'
        ? 'All-Time'
        : standard.Period;
    const holderLabel = isHeld
        ? `You hold the ${periodLabel} crown`
        : `${periodLabel} crown holder`;
    const crownDistance = standard.CrownDistance || standard.CrownEvent || standard.Distance || '';
    const showCrownDistance = crownDistance &&
        (clean(standard.Distance) === 'overall' || clean(crownDistance) !== clean(standard.Distance));
    const crownFacts = [
        `${standard.Distance} crown`,
        showCrownDistance ? `Winning distance: ${crownDistance}` : '',
        standard.CrownAgeGrade ? `Age grade: ${standard.CrownAgeGrade}` : ''
    ].filter(Boolean);
    const gap = !isHeld && standard.GapToPB
        ? `<div class="crown-standard-gap">PB gap: ${escapeHTML(standard.GapToPB)}</div>`
        : '';
    const pb = !isHeld && standard.AthletePB
        ? `<div class="crown-standard-meta">PB: ${escapeHTML(standard.AthletePB)}</div>`
        : '';

    return `
        <article class="crown-standard-card ${statusClass} ${periodClass}">
            <div class="crown-standard-header">
                <div class="crown-standard-holder">
                    <div class="crown-standard-holder-label">${escapeHTML(holderLabel)}</div>
                    <div class="crown-standard-holder-name">${escapeHTML(holderName)}</div>
                </div>
                <span class="crown-standard-status">${escapeHTML(status)}${isHeld ? ' &#129351;' : ''}</span>
            </div>
            <div class="crown-standard-award">
                <span class="crown-standard-distance">${escapeHTML(standard.Distance)}</span>
                <span class="crown-standard-period">${escapeHTML(standard.Period)}</span>
            </div>
            <div class="crown-standard-facts">
                ${crownFacts.map(fact => `<span>${escapeHTML(fact)}</span>`).join('')}
            </div>
            <div class="crown-standard-time">
                ${escapeHTML(standard.RequiredTimeToTake)}
                <span>${isHeld ? 'benchmark to stay ahead' : 'required to take crown'}</span>
            </div>
            ${pb}
            ${gap}
        </article>
    `;
}

function crownStandardStatusClass(status) {
    const value = clean(status).replace(/[^a-z0-9]+/g, '-');

    return value || 'chasing';
}

function crownStandardPeriodClass(period) {
    const value = clean(period).replace(/[^a-z0-9]+/g, '-');

    return value ? `period-${value}` : '';
}

function csvRowsToObjects(rows) {
    const headers = rows[0].map(header => String(header).trim());

    return rows.slice(1)
        .filter(row => row.some(cell => cell !== ''))
        .map(row => {
            const obj = {};

            headers.forEach((header, index) => {
                obj[header] = row[index] || '';
            });

            return obj;
        });
}

function renderOfficialMedal(medal) {
    const medalName = medal.Medal || '';
    const medalClass = clean(medalName);
    const metric = [medal.Time, medal.AgeGrade].filter(Boolean).join(' · ');
    const event = [medal.EventDate, medal.EventName].filter(Boolean).join(' · ');
    const context = [medal.Distance, medal.Period].filter(Boolean).join(' · ');

    return `
        <article class="official-medal ${medalClass}">
            <div class="official-medal-icon">${medalIcon(medalName)}</div>
            <div class="official-medal-content">
                <div class="official-medal-title">${escapeHTML(medal.AwardTitle)}</div>
                <div class="official-medal-context">${escapeHTML(context)}</div>
                ${metric ? `<div class="official-medal-metric">${escapeHTML(metric)}</div>` : ''}
                ${event ? `<div class="official-medal-event">${escapeHTML(event)}</div>` : ''}
            </div>
        </article>
    `;
}

function medalIcon(medal) {
    const value = clean(medal);

    if (value === 'gold') return '&#129351;';
    if (value === 'silver') return '&#129352;';
    if (value === 'bronze') return '&#129353;';

    return '&#127941;';
}

function escapeHTML(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function runWhenIdle(callback) {
    if ('requestIdleCallback' in window) {
        requestIdleCallback(callback, { timeout: 1500 });
        return;
    }

    setTimeout(callback, 0);
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
	updateBackLink();
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
        document.getElementById('official-medals-section').classList.add('hidden');
        document.getElementById('official-medals').innerHTML = '';
        document.getElementById('crown-standards-section').classList.add('hidden');
        document.getElementById('crown-standards').innerHTML = '';
        document.getElementById('recent-results').innerHTML = '';
        document.getElementById('all-results').innerHTML = '<p>No results found for this athlete.</p>';
        return;
    }

    document.getElementById('athlete-name').innerText = athleteResults[0].Participant;

    buildPersonalBests(athleteResults);
    await buildOfficialMedals();
    await buildCrownStandards();
    buildRecentResults(athleteResults);
    document.getElementById('all-results').innerHTML = '<p>Loading full results...</p>';

    runWhenIdle(() => {
        buildProgressionChart(athleteResults);
    });

    runWhenIdle(() => {
        document.getElementById('all-results').innerHTML = renderTable(athleteResults);
    });
}

buildAthletePage();
