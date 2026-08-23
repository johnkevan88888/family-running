(function () {
    const params = new URLSearchParams(window.location.search);
    const requestedSite = params.get('site');
    const selectedSite = window.siteNavigation?.selectedSite
        ? window.siteNavigation.selectedSite()
        : (requestedSite === 'everyone' ? 'everyone' : 'family');
    const newsPath = `data/${selectedSite}/official_result_news.csv`;

    const milestonePresentations = {
        'First Official Result': {
            className: 'first-result',
            icon: '&#9733;',
            showAgeGradeImprovement: false,
            showTimeImprovement: false
        },
        'Age Grade PB': {
            className: 'age-grade-pb',
            icon: '&#8593;',
            showAgeGradeImprovement: true,
            showTimeImprovement: false
        },
        'Raw-Time PB': {
            className: 'raw-time-pb',
            icon: '&#8593;',
            showAgeGradeImprovement: false,
            showTimeImprovement: true
        },
        'Age Grade + Raw-Time PB': {
            className: 'combined-pb',
            icon: '&#8593;',
            showAgeGradeImprovement: true,
            showTimeImprovement: true
        }
    };

    async function buildOfficialResultNews() {
        const container = document.getElementById('official-result-news');
        const status = document.getElementById('official-news-status');
        if (!container || !status) return;

        try {
            const rows = await fetchCSV(newsPath);
            const entries = csvRowsToObjects(rows);

            if (!entries.length) {
                container.innerHTML = '';
                showStatus(status, 'No official result milestones have been exported.', 'empty');
                container.dataset.rendered = 'true';
                return;
            }

            // The workbook exports newest first in authoritative SortOrder.
            // Rendering the array as received preserves that order exactly.
            container.innerHTML = `
                <ol class="news-timeline" role="list">
                    ${entries.map(renderNewsEntry).join('')}
                </ol>
            `;
            status.hidden = true;
            container.dataset.rendered = 'true';
        } catch (error) {
            container.innerHTML = '';
            showStatus(
                status,
                'Official result milestones are unavailable right now.',
                'error'
            );
            container.dataset.rendered = 'true';
        }
    }

    function renderNewsEntry(row, index) {
        const presentation = milestonePresentations[row.MilestoneType] || {
            className: 'milestone',
            icon: '&#8226;',
            showAgeGradeImprovement: false,
            showTimeImprovement: false
        };
        const athlete = athleteLink(row.AthleteID, row.AthleteName);
        const currentMovement = renderRankPeriod(row, 'Current', index);
        const allTimeMovement = renderRankPeriod(row, 'AllTime', index);
        const movement = currentMovement || allTimeMovement
            ? `
                <section class="news-rank-section" aria-labelledby="news-ranks-${index}">
                    <h4 id="news-ranks-${index}">Championship movement</h4>
                    <div class="news-rank-periods">
                        ${currentMovement}
                        ${allTimeMovement}
                    </div>
                </section>
            `
            : '';

        return `
            <li class="news-timeline-item">
                <article class="news-card news-card-${presentation.className}">
                    <header class="news-card-header">
                        <div>
                            <div class="news-date">${escapeHTML(formatNewsDate(row.ResultDate))}</div>
                            <h3>${athlete}</h3>
                        </div>
                        <div class="news-milestone-badge">
                            <span class="news-milestone-icon" aria-hidden="true">${presentation.icon}</span>
                            ${escapeHTML(row.MilestoneType)}
                        </div>
                    </header>

                    <div class="news-result-context">
                        <strong>${escapeHTML(row.Distance)}</strong>
                        ${row.Event ? `<span>${escapeHTML(row.Event)}</span>` : ''}
                    </div>

                    <dl class="news-result-metrics">
                        <div>
                            <dt>Official time</dt>
                            <dd>${escapeHTML(row.Time)}</dd>
                        </div>
                        <div>
                            <dt>Age grade</dt>
                            <dd>${escapeHTML(row.AgeGrade)}</dd>
                        </div>
                    </dl>

                    ${renderMilestoneDetails(row, presentation)}
                    ${movement}
                </article>
            </li>
        `;
    }

    function renderMilestoneDetails(row, presentation) {
        if (row.MilestoneType === 'First Official Result') {
            return `
                <div class="news-baseline-note">
                    Established the first official age-grade and raw-time baselines
                    for this athlete and distance.
                </div>
            `;
        }

        const details = [];

        if (presentation.showAgeGradeImprovement) {
            details.push(`
                <div class="news-improvement news-improvement-age-grade">
                    <h4>Age-grade personal best</h4>
                    <div class="news-improvement-values">
                        <span><small>Previous</small>${escapeHTML(row.PreviousBestAgeGrade)}</span>
                        <span aria-hidden="true">&#8594;</span>
                        <strong><small>New</small>${escapeHTML(row.AgeGrade)}</strong>
                    </div>
                    <div class="news-improvement-change">
                        ${escapeHTML(row.AgeGradeImprovement)}
                    </div>
                </div>
            `);
        }

        if (presentation.showTimeImprovement) {
            details.push(`
                <div class="news-improvement news-improvement-time">
                    <h4>Raw-time personal best</h4>
                    <div class="news-improvement-values">
                        <span><small>Previous</small>${escapeHTML(row.PreviousBestTime)}</span>
                        <span aria-hidden="true">&#8594;</span>
                        <strong><small>New</small>${escapeHTML(row.Time)}</strong>
                    </div>
                    <div class="news-improvement-change">
                        ${escapeHTML(row.TimeImprovement)} faster
                    </div>
                </div>
            `);
        }

        return details.length
            ? `<div class="news-improvements">${details.join('')}</div>`
            : '';
    }

    function renderRankPeriod(row, periodKey, entryIndex) {
        const label = periodKey === 'Current' ? 'Current' : 'All Time';
        const distanceMovement = renderRankMovement(
            'Distance',
            row[`${periodKey}DistanceRankBefore`],
            row[`${periodKey}DistanceRankAfter`],
            row[`${periodKey}DistancePlacesGained`]
        );
        const overallMovement = renderRankMovement(
            'Overall',
            row[`${periodKey}OverallRankBefore`],
            row[`${periodKey}OverallRankAfter`],
            row[`${periodKey}OverallPlacesGained`]
        );

        if (!distanceMovement && !overallMovement) {
            return '';
        }

        return `
            <section class="news-rank-period" aria-labelledby="news-${periodKey.toLowerCase()}-${entryIndex}">
                <h5 id="news-${periodKey.toLowerCase()}-${entryIndex}">${label}</h5>
                <dl class="news-rank-list">
                    ${distanceMovement}
                    ${overallMovement}
                </dl>
            </section>
        `;
    }

    function renderRankMovement(label, before, after, placesGained) {
        const rankBefore = String(before || '').trim();
        const rankAfter = String(after || '').trim();
        const gained = String(placesGained || '').trim();

        if (!rankBefore && !rankAfter && !gained) {
            return '';
        }

        let positions;
        let change;

        if (!rankBefore && rankAfter && !gained) {
            positions = `Unranked to #${escapeHTML(rankAfter)}`;
            change = 'Entered the table';
        } else if (rankBefore && rankAfter && gained) {
            positions = `#${escapeHTML(rankBefore)} to #${escapeHTML(rankAfter)}`;
            change = gained === '0'
                ? 'No rank change'
                : `Up ${escapeHTML(gained)} ${gained === '1' ? 'place' : 'places'}`;
        } else {
            // Published bundles are validated before release. If an invalid
            // partial triplet reaches the page, display no invented movement.
            positions = 'Movement unavailable';
            change = '';
        }

        return `
            <div class="news-rank-row">
                <dt>${escapeHTML(label)}</dt>
                <dd>
                    <span class="news-rank-positions">${positions}</span>
                    ${change ? `<span class="news-rank-change">${change}</span>` : ''}
                </dd>
            </div>
        `;
    }

    function formatNewsDate(value) {
        return window.dateDisplay?.format(value) || String(value || '');
    }

    function showStatus(status, message, state) {
        status.className = `news-status news-status-${state}`;
        status.textContent = message;
        status.hidden = false;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', buildOfficialResultNews, { once: true });
    } else {
        buildOfficialResultNews();
    }
})();
