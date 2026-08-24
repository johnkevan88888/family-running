(function () {
    const params = new URLSearchParams(window.location.search);
    const requestedSite = params.get('site');
    const selectedSite = window.siteNavigation?.selectedSite
        ? window.siteNavigation.selectedSite()
        : (requestedSite === 'everyone' ? 'everyone' : 'family');
    const newsPath = `data/${selectedSite}/official_result_news.csv`;
    const newsPageSize = 12;
    const distanceDisplayOrder = [
        'Marathon',
        'Half Marathon',
        '10 Mile',
        '10 km',
        '5 km',
        '1 Mile'
    ];
    let allEntries = [];
    let visibleEntryCount = newsPageSize;

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
    const medalEntryPresentations = {
        Gold: {
            className: 'gold',
            icon: '&#129351;'
        },
        Silver: {
            className: 'silver',
            icon: '&#129352;'
        },
        Bronze: {
            className: 'bronze',
            icon: '&#129353;'
        }
    };
    const displacedMedalAfterValues = new Set([
        'Silver',
        'Bronze',
        'No medal'
    ]);
    const displacedMedalTransitions = new Map([
        ['Gold', 'Silver'],
        ['Silver', 'Bronze'],
        ['Bronze', 'No medal']
    ]);
    const publicAthleteIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    const medalEntryContexts = [
        ['CurrentDistance', 'CurrentDistanceMedalEntry'],
        ['CurrentOverall', 'CurrentOverallMedalEntry'],
        ['AllTimeDistance', 'AllTimeDistanceMedalEntry'],
        ['AllTimeOverall', 'AllTimeOverallMedalEntry']
    ];

    async function buildOfficialResultNews() {
        const elements = getNewsElements();
        if (Object.values(elements).some(element => !element)) return;

        try {
            const rows = await fetchCSV(newsPath);
            const entries = csvRowsToObjects(rows);

            if (!entries.length) {
                allEntries = [];
                elements.container.innerHTML = '';
                hideNewsControls(elements);
                showStatus(
                    elements.status,
                    'No official result milestones have been exported.',
                    'empty'
                );
                elements.container.dataset.rendered = 'true';
                return;
            }

            allEntries = entries;
            visibleEntryCount = newsPageSize;
            populateNewsFilters(elements, entries);
            bindNewsControls(elements);
            elements.controls.hidden = false;
            elements.status.hidden = true;
            renderFilteredNews(elements);
        } catch (error) {
            allEntries = [];
            elements.container.innerHTML = '';
            hideNewsControls(elements);
            showStatus(
                elements.status,
                'Official result milestones are unavailable right now.',
                'error'
            );
            elements.container.dataset.rendered = 'true';
        }
    }

    function getNewsElements() {
        return {
            container: document.getElementById('official-result-news'),
            status: document.getElementById('official-news-status'),
            controls: document.getElementById('official-news-controls'),
            athleteFilter: document.getElementById('news-athlete-filter'),
            yearFilter: document.getElementById('news-year-filter'),
            distanceFilter: document.getElementById('news-distance-filter'),
            resetFilters: document.getElementById('news-reset-filters'),
            resultSummary: document.getElementById('news-result-summary'),
            showOlder: document.getElementById('news-show-older')
        };
    }

    function populateNewsFilters(elements, entries) {
        const athletes = new Map();
        const years = new Set();
        const distances = new Set();

        for (const entry of entries) {
            if (!athletes.has(entry.AthleteID)) {
                athletes.set(entry.AthleteID, entry.AthleteName);
            }

            const year = resultYear(entry.ResultDate);
            if (year) years.add(year);
            if (entry.Distance) distances.add(entry.Distance);
        }

        populateNewsSelect(
            elements.athleteFilter,
            'All athletes',
            [...athletes].map(([value, label]) => ({ value, label })).sort((left, right) =>
                left.label.localeCompare(right.label) || left.value.localeCompare(right.value)
            )
        );
        populateNewsSelect(
            elements.yearFilter,
            'All years',
            [...years]
                .sort((left, right) => Number(right) - Number(left))
                .map(year => ({ value: year, label: year }))
        );
        populateNewsSelect(
            elements.distanceFilter,
            'All distances',
            [...distances]
                .sort((left, right) => {
                    const leftIndex = distanceDisplayOrder.indexOf(left);
                    const rightIndex = distanceDisplayOrder.indexOf(right);
                    const safeLeftIndex = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
                    const safeRightIndex = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;
                    return safeLeftIndex - safeRightIndex || left.localeCompare(right);
                })
                .map(distance => ({ value: distance, label: distance }))
        );
    }

    function populateNewsSelect(select, defaultLabel, options) {
        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = defaultLabel;
        const optionElements = options.map(option => {
            const element = document.createElement('option');
            element.value = option.value;
            element.textContent = option.label;
            return element;
        });

        select.replaceChildren(defaultOption, ...optionElements);
    }

    function bindNewsControls(elements) {
        for (const filter of [
            elements.athleteFilter,
            elements.yearFilter,
            elements.distanceFilter
        ]) {
            filter.addEventListener('change', () => {
                visibleEntryCount = newsPageSize;
                renderFilteredNews(elements);
            });
        }

        elements.resetFilters.addEventListener('click', () => {
            elements.athleteFilter.value = '';
            elements.yearFilter.value = '';
            elements.distanceFilter.value = '';
            visibleEntryCount = newsPageSize;
            renderFilteredNews(elements);
            elements.athleteFilter.focus();
        });

        elements.showOlder.addEventListener('click', () => {
            const previouslyVisible = Math.min(
                visibleEntryCount,
                filteredNewsEntries(elements).length
            );
            visibleEntryCount += newsPageSize;
            renderFilteredNews(elements);

            const firstNewEntry = elements.container
                .querySelectorAll('.news-timeline-item')[previouslyVisible];
            firstNewEntry?.querySelector('h3 a')?.focus();
        });
    }

    function renderFilteredNews(elements) {
        const filteredEntries = filteredNewsEntries(elements);
        const visibleEntries = filteredEntries.slice(0, visibleEntryCount);
        const filtersActive = hasActiveNewsFilters(elements);

        if (!filteredEntries.length) {
            elements.container.innerHTML = `
                <div class="news-filter-empty">
                    No official result milestones match these filters.
                </div>
            `;
            elements.resultSummary.textContent = 'No matching milestones.';
        } else {
            // Filtering and batching retain the workbook's authoritative order.
            // The browser only selects which exported rows are visible.
            elements.container.innerHTML = `
                <ol class="news-timeline" role="list">
                    ${visibleEntries.map(renderNewsEntry).join('')}
                </ol>
            `;
            elements.resultSummary.textContent = filtersActive
                ? `Showing ${visibleEntries.length} of ${filteredEntries.length} matching milestones.`
                : `Showing ${visibleEntries.length} of ${filteredEntries.length} milestones.`;
        }

        elements.resetFilters.disabled = !filtersActive;
        updateShowOlderButton(elements.showOlder, filteredEntries.length - visibleEntries.length);
        elements.container.dataset.rendered = 'true';
    }

    function filteredNewsEntries(elements) {
        const athleteId = elements.athleteFilter.value;
        const year = elements.yearFilter.value;
        const distance = elements.distanceFilter.value;

        return allEntries.filter(entry =>
            (!athleteId || entry.AthleteID === athleteId) &&
            (!year || resultYear(entry.ResultDate) === year) &&
            (!distance || entry.Distance === distance)
        );
    }

    function hasActiveNewsFilters(elements) {
        return Boolean(
            elements.athleteFilter.value ||
            elements.yearFilter.value ||
            elements.distanceFilter.value
        );
    }

    function updateShowOlderButton(button, remainingCount) {
        if (remainingCount <= 0) {
            button.hidden = true;
            return;
        }

        const nextCount = Math.min(newsPageSize, remainingCount);
        button.textContent = `Show ${nextCount} older ${nextCount === 1 ? 'milestone' : 'milestones'}`;
        button.hidden = false;
    }

    function hideNewsControls(elements) {
        elements.controls.hidden = true;
        elements.showOlder.hidden = true;
        elements.resultSummary.textContent = '';
    }

    function resultYear(value) {
        const match = String(value || '').trim().match(/(\d{4})$/);
        return match ? match[1] : '';
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
        const milestoneDetails = renderMilestoneDetails(row, presentation);
        const hasMedalEntry = medalEntryContexts.some(([rankKey, medalField]) =>
            medalEntryPresentation(row[medalField]) &&
            isCompleteRankMovement(
                row[`${rankKey}RankBefore`],
                row[`${rankKey}RankAfter`],
                row[`${rankKey}PlacesGained`]
            )
        );
        const movement = currentMovement || allTimeMovement
            ? `
                <section class="news-rank-section news-flow-stage news-flow-ranks" aria-labelledby="news-ranks-${index}">
                    <div class="news-rank-heading">
                        <h4 id="news-ranks-${index}">Championship movement</h4>
                        ${hasMedalEntry ? `
                            <div class="news-medal-callout">
                                <span class="news-medal-callout-icon" aria-hidden="true">&#10024;</span>
                                <strong>Medal breakthrough!</strong>
                                <span>Entered a medal-winning position</span>
                            </div>
                        ` : ''}
                    </div>
                    <div class="news-rank-periods">
                        ${currentMovement}
                        ${allTimeMovement}
                    </div>
                </section>
            `
            : '';

        return `
            <li class="news-timeline-item">
                <article class="news-card news-card-${presentation.className}${hasMedalEntry ? ' news-card-medal-entry' : ''}">
                    <div class="news-flow">
                        <section class="news-flow-stage news-flow-result" aria-label="Official result">
                            <header class="news-card-header">
                                <div class="news-card-heading">
                                    <div class="news-date">${escapeHTML(formatNewsDate(row.ResultDate))}</div>
                                    <h3>${athlete}</h3>
                                    <div class="news-result-context">
                                        <strong>${escapeHTML(row.Distance)}</strong>
                                        ${row.Event ? `<span>${escapeHTML(row.Event)}</span>` : ''}
                                    </div>
                                </div>
                                <div class="news-milestone-badge">
                                    <span class="news-milestone-icon" aria-hidden="true">${presentation.icon}</span>
                                    ${escapeHTML(row.MilestoneType)}
                                </div>
                            </header>

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
                        </section>

                        <span class="news-flow-arrow news-flow-arrow-improvement" aria-hidden="true">&#8594;</span>
                        <section class="news-flow-stage news-flow-improvement" aria-label="Milestone details">
                            ${milestoneDetails}
                        </section>
                        ${movement ? `
                            <span class="news-flow-arrow news-flow-arrow-ranks" aria-hidden="true">&#8594;</span>
                            ${movement}
                        ` : ''}
                    </div>
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
            row[`${periodKey}DistancePlacesGained`],
            row[`${periodKey}DistanceMedalEntry`],
            row[`${periodKey}DistanceMedalBefore`],
            row[`${periodKey}DistanceMedalAfter`],
            row.AthleteID,
            row[`${periodKey}DistanceDisplacedAthleteID`],
            row[`${periodKey}DistanceDisplacedAthleteName`],
            row[`${periodKey}DistanceDisplacedMedalBefore`],
            row[`${periodKey}DistanceDisplacedMedalAfter`],
            `${periodKey.toLowerCase()}-distance`
        );
        const overallMovement = renderRankMovement(
            'Overall',
            row[`${periodKey}OverallRankBefore`],
            row[`${periodKey}OverallRankAfter`],
            row[`${periodKey}OverallPlacesGained`],
            row[`${periodKey}OverallMedalEntry`],
            row[`${periodKey}OverallMedalBefore`],
            row[`${periodKey}OverallMedalAfter`],
            row.AthleteID,
            row[`${periodKey}OverallDisplacedAthleteID`],
            row[`${periodKey}OverallDisplacedAthleteName`],
            row[`${periodKey}OverallDisplacedMedalBefore`],
            row[`${periodKey}OverallDisplacedMedalAfter`],
            `${periodKey.toLowerCase()}-overall`
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

    function renderRankMovement(
        label,
        before,
        after,
        placesGained,
        medalEntry,
        medalBefore,
        medalAfter,
        focalAthleteId,
        displacedAthleteId,
        displacedAthleteName,
        displacedMedalBefore,
        displacedMedalAfter,
        contextKey
    ) {
        const rankBefore = String(before || '').trim();
        const rankAfter = String(after || '').trim();
        const gained = String(placesGained || '').trim();
        const medalPresentation = medalEntryPresentation(medalEntry);

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

        const hasMedalEntry = Boolean(
            medalPresentation && isCompleteRankMovement(rankBefore, rankAfter, gained)
        );
        const medalBadge = hasMedalEntry
            ? `
                <span class="news-medal-entry-badge news-medal-entry-${medalPresentation.className}">
                    <span class="news-medal-entry-icon" aria-hidden="true">${medalPresentation.icon}</span>
                    <span>New ${escapeHTML(medalEntry)} medal position</span>
                </span>
            `
            : '';
        const medalPosition = !hasMedalEntry && isCompleteRankMovement(rankBefore, rankAfter, gained)
            ? renderMedalPositionSnapshot(medalBefore, medalAfter)
            : '';
        const medalDisplacement = isCompleteRankMovement(rankBefore, rankAfter, gained)
            ? renderMedalDisplacement({
                focalAthleteId,
                focalMedalAfter: medalAfter,
                displacedAthleteId,
                displacedAthleteName,
                displacedMedalBefore,
                displacedMedalAfter
            })
            : '';

        return `
            <div class="news-rank-row${hasMedalEntry ? ` news-rank-row-medal-entry news-rank-row-medal-${medalPresentation.className}` : ''}"
                 data-news-rank-context="${escapeHTML(contextKey)}">
                <dt>${escapeHTML(label)}</dt>
                <dd>
                    <span class="news-rank-positions">${positions}</span>
                    ${change ? `<span class="news-rank-change">${change}</span>` : ''}
                    ${medalBadge}
                    ${medalPosition}
                    ${medalDisplacement}
                </dd>
            </div>
        `;
    }

    function renderMedalDisplacement({
        focalAthleteId,
        focalMedalAfter,
        displacedAthleteId,
        displacedAthleteName,
        displacedMedalBefore,
        displacedMedalAfter
    }) {
        const focalId = String(focalAthleteId || '').trim();
        const focalAfter = String(focalMedalAfter || '').trim();
        const athleteId = String(displacedAthleteId || '').trim();
        const athleteName = String(displacedAthleteName || '').trim();
        const medalBefore = String(displacedMedalBefore || '').trim();
        const medalAfter = String(displacedMedalAfter || '').trim();

        // Displacement is an optional, workbook-owned attribution. A blank
        // source export (including an intentionally omitted identity) stays
        // blank, and a partial or malformed context never becomes a guessed
        // attribution in the browser.
        if (
            !publicAthleteIdPattern.test(focalId) ||
            !medalEntryPresentation(focalAfter) ||
            !publicAthleteIdPattern.test(athleteId) ||
            !athleteName ||
            !medalEntryPresentation(medalBefore) ||
            !displacedMedalAfterValues.has(medalAfter) ||
            displacedMedalTransitions.get(medalBefore) !== medalAfter ||
            focalAfter !== medalBefore ||
            athleteId === focalId
        ) {
            return '';
        }

        const athlete = athleteLink(athleteId, athleteName);

        return `
            <span class="news-medal-displacement">
                <span class="news-medal-displacement-label">Medal change:</span>
                <span>${escapeHTML(medalBefore)} taken from</span>
                ${athlete}
                <span class="news-medal-displacement-separator" aria-hidden="true">&mdash;</span>
                <span>${escapeHTML(athleteName)}:</span>
                <span>${escapeHTML(medalBefore)}</span>
                <span class="news-medal-displacement-arrow" aria-hidden="true">&#8594;</span>
                <span class="news-medal-displacement-transition">to</span>
                <span>${escapeHTML(medalAfter)}</span>
            </span>
        `;
    }

    function renderMedalPositionSnapshot(before, after) {
        const beforeText = String(before || '').trim();
        const afterText = String(after || '').trim();
        const beforePresentation = medalEntryPresentation(beforeText);
        const afterPresentation = medalEntryPresentation(afterText);

        // Snapshot values are workbook-owned fields. Do not manufacture a
        // medal label from the rank numbers if an invalid or partial export
        // reaches the browser.
        if (!beforePresentation || !afterPresentation) {
            return '';
        }

        if (beforeText === afterText) {
            return `
                <span class="news-medal-position-badge news-medal-position-${afterPresentation.className}">
                    <span class="news-medal-position-label">Medal position:</span>
                    <span>${escapeHTML(afterText)} medal position retained</span>
                </span>
            `;
        }

        return `
            <span class="news-medal-position-badge news-medal-position-${afterPresentation.className}">
                <span class="news-medal-position-label">Medal position:</span>
                <span>${escapeHTML(beforeText)}</span>
                <span class="news-medal-position-arrow" aria-hidden="true">&#8594;</span>
                <span class="news-medal-position-transition">to</span>
                <span>${escapeHTML(afterText)}</span>
            </span>
        `;
    }

    function medalEntryPresentation(value) {
        return Object.prototype.hasOwnProperty.call(medalEntryPresentations, value)
            ? medalEntryPresentations[value]
            : null;
    }

    function isCompleteRankMovement(before, after, placesGained) {
        const rankBefore = String(before || '').trim();
        const rankAfter = String(after || '').trim();
        const gained = String(placesGained || '').trim();

        return Boolean(
            (!rankBefore && rankAfter && !gained) ||
            (rankBefore && rankAfter && gained)
        );
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
