(function () {
    const state = {
        athletes: [],
        comparisonTargets: [],
        comparisonExportAvailable: false,
        comparisonPeriods: [],
        selectedComparisonPeriod: '',
        defaultRivalry: null
    };

    const elements = {};

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }

    async function initialize() {
        captureElements();

        try {
            const site = window.siteNavigation?.selectedSite?.() || selectedSite();
            const comparisonPath = `data/${site}/athlete_comparison_targets.csv`;
            const currentChampionshipPath = `data/${site}/overall-current-official-${site}.csv`;
            const [standardsRows, athleteRows, manifestRows, currentChampionshipRows] = await Promise.all([
                fetchCSV(`data/${site}/age_grade_standards.csv`),
                fetchCSV('data/athlete_results.csv'),
                fetchCSV('data/export_manifest.csv'),
                fetchCSV(currentChampionshipPath)
            ]);

            const standards = rowsToObjects(standardsRows);
            const athleteResults = rowsToObjects(athleteRows);
            const manifest = rowsToObjects(manifestRows);
            state.athletes = buildAthletes(standards, athleteResults);
            state.defaultRivalry = closestCurrentRivalry(rowsToObjects(currentChampionshipRows));
            state.comparisonExportAvailable = manifest.some(row => row.RelativePath === comparisonPath);

            if (state.comparisonExportAvailable) {
                state.comparisonTargets = rowsToObjects(await fetchCSV(comparisonPath));
                state.comparisonPeriods = availableComparisonPeriods(state.comparisonTargets);
                state.selectedComparisonPeriod = state.comparisonPeriods.includes('Current')
                    ? 'Current'
                    : state.comparisonPeriods[0] || '';
            }

            if (!standards.length || !state.athletes.length) {
                throw new Error('No exported athletes are available for comparison.');
            }

            populateControls();
            bindControls();
            renderComparisonResults();
            window.paceDisplay?.initialize(document);
        } catch (error) {
            renderLoadError();
            console.error('Unable to load the age-grade calculator.', error);
        }
    }

    function captureElements() {
        elements.comparisonAthleteA = document.getElementById('comparison-athlete-a');
        elements.comparisonAthleteB = document.getElementById('comparison-athlete-b');
        elements.comparisonPeriodControl = document.getElementById('comparison-period-control');
        elements.comparisonPeriodOptions = document.getElementById('comparison-period-options');
        elements.comparisonPeriodNote = document.getElementById('comparison-period-note');
        elements.comparisonSummary = document.getElementById('comparison-summary');
        elements.comparisonResults = document.getElementById('comparison-results');
    }

    function populateControls() {
        const athleteOptions = state.athletes.map(athlete => ({
            value: athlete.id,
            label: athlete.name
        }));
        populateSelect(elements.comparisonAthleteA, athleteOptions);
        populateSelect(elements.comparisonAthleteB, athleteOptions);
        elements.comparisonAthleteA.value = state.defaultRivalry?.challengerId || state.athletes[0].id;
        elements.comparisonAthleteB.value = state.defaultRivalry?.standardId
            || state.athletes.find(athlete => athlete.id !== elements.comparisonAthleteA.value)?.id
            || state.athletes[0].id;
        populateComparisonPeriods();
    }

    function bindControls() {
        elements.comparisonAthleteA.addEventListener('change', () => {
            keepComparisonAthletesDifferent(elements.comparisonAthleteA);
            renderComparisonResults();
        });
        elements.comparisonAthleteB.addEventListener('change', () => {
            keepComparisonAthletesDifferent(elements.comparisonAthleteB);
            renderComparisonResults();
        });
        elements.comparisonPeriodOptions.addEventListener('change', event => {
            if (event.target.name !== 'comparison-period') return;
            state.selectedComparisonPeriod = event.target.value;
            renderComparisonResults();
        });
    }

    function renderComparisonResults() {
        const challenger = athleteById(elements.comparisonAthleteA.value);
        const standard = athleteById(elements.comparisonAthleteB.value);
        const rows = state.comparisonTargets
            .filter(row =>
                row.ChallengerAthleteId === challenger?.id &&
                row.StandardAthleteId === standard?.id &&
                comparisonPeriod(row) === state.selectedComparisonPeriod
            )
            .sort((a, b) => Number(a.SortOrder) - Number(b.SortOrder));

        const periodDetail = state.selectedComparisonPeriod === 'Current'
            ? 'Showing current standards from the last 12 months.'
            : 'Showing all-time standards.';

        elements.comparisonSummary.replaceChildren(
            summaryContent(
                `${challenger?.name || 'Challenger'} challenges ${standard?.name || 'The Standard'}`,
                `${periodDetail} Beat ${standard?.name || 'the standard athlete'}'s exported marks, with official results first and unofficial results below.`
            )
        );

        if (!state.comparisonExportAvailable) {
            elements.comparisonResults.replaceChildren(
                emptyMessage('Head-to-head targets are not available in this championship update yet.')
            );
            elements.comparisonResults.dataset.rendered = 'true';
            return;
        }

        if (!rows.length) {
            elements.comparisonResults.replaceChildren(
                emptyMessage('No exported head-to-head standards match this pairing.')
            );
            elements.comparisonResults.dataset.rendered = 'true';
            return;
        }

        const resultSections = [
            comparisonClassSection('Official', rows, challenger, standard),
            comparisonClassSection('Unofficial', rows, challenger, standard)
        ];
        const sections = document.createElement('div');
        sections.className = 'comparison-result-sections';
        sections.append(...resultSections);
        elements.comparisonResults.replaceChildren(sections);
        elements.comparisonResults.dataset.rendered = 'true';
        window.paceDisplay?.initialize(document);
    }

    function comparisonClassSection(timeClass, rows, challenger, standard) {
        const classKey = timeClass.toLowerCase();
        const classRows = rows.filter(row =>
            String(row.StandardTimeClass || '').trim().toLowerCase() === classKey
        );
        const section = document.createElement('section');
        section.className = `comparison-class-section comparison-class-${classKey}`;
        section.dataset.timeClass = classKey;

        const heading = document.createElement('div');
        heading.className = 'comparison-class-heading';
        const title = document.createElement('h3');
        title.textContent = `${timeClass} results`;
        const count = document.createElement('span');
        const displayedCount = mergedBenchmarkCount(classRows);
        count.textContent = `${displayedCount} ${displayedCount === 1 ? 'standard' : 'standards'}`;
        heading.append(title, count);
        section.append(heading);

        if (!classRows.length) {
            section.append(emptyMessage(`No ${classKey} standards are available for this pairing.`));
            return section;
        }

        const cards = groupByDistance(classRows).map(group =>
            comparisonDistanceCard(group.distance, group.rows, challenger, standard)
        );
        const grid = document.createElement('div');
        grid.className = 'comparison-distance-grid';
        grid.append(...cards);
        section.append(grid);
        return section;
    }

    function comparisonDistanceCard(distance, rows, challenger, standard) {
        const benchmarkGroups = mergeEquivalentBenchmarks(rows);
        const card = document.createElement('article');
        card.className = 'comparison-distance-card';
        const header = document.createElement('div');
        header.className = 'comparison-distance-header';
        const title = document.createElement('h3');
        title.textContent = distance;
        const count = document.createElement('span');
        count.textContent = `${benchmarkGroups.length} ${benchmarkGroups.length === 1 ? 'standard' : 'standards'}`;
        header.append(title, count);
        card.append(header, ...benchmarkGroups.map(group => comparisonBenchmark(group, challenger, standard)));
        return card;
    }

    function comparisonBenchmark(rows, challenger, standard) {
        const row = rows[0];
        const benchmark = document.createElement('div');
        benchmark.className = 'comparison-benchmark';

        const types = document.createElement('div');
        types.className = 'comparison-benchmark-types';
        for (const benchmarkRow of rows) {
            const type = document.createElement('span');
            type.className = `comparison-benchmark-type ${benchmarkClass(benchmarkRow.BenchmarkType)}`;
            type.textContent = benchmarkRow.BenchmarkType;
            types.append(type);
        }

        const standardResult = document.createElement('div');
        standardResult.className = 'comparison-result-side standard-result-side';
        const standardLabel = document.createElement('span');
        standardLabel.className = 'comparison-side-label';
        standardLabel.textContent = `${standard.name}'s performance`;
        const standardMetrics = document.createElement('div');
        standardMetrics.className = 'comparison-standard-metrics';
        const standardTime = document.createElement('strong');
        standardTime.className = 'comparison-standard-time';
        standardTime.textContent = row.StandardTime;
        const standardAgeGrade = document.createElement('span');
        standardAgeGrade.className = 'comparison-standard-age-grade';
        standardAgeGrade.textContent = `${row.StandardAgeGrade} age grade`;
        standardMetrics.append(standardTime, standardAgeGrade);
        const standardDetail = document.createElement('span');
        standardDetail.className = 'comparison-standard-detail';
        standardDetail.textContent = [formatComparisonDate(row.StandardDate), row.StandardEvent, row.StandardTimeClass]
            .filter(Boolean)
            .join(' · ');
        standardResult.append(standardLabel, standardMetrics, standardDetail);

        const direction = document.createElement('span');
        direction.className = 'comparison-direction';
        direction.setAttribute('aria-hidden', 'true');
        direction.textContent = '→';

        const targetResult = document.createElement('div');
        targetResult.className = 'comparison-result-side challenger-result-side';
        const targetLabel = document.createElement('span');
        targetLabel.className = 'comparison-side-label';
        targetLabel.textContent = `${challenger.name} must run`;
        const targetTime = document.createElement('strong');
        targetTime.className = 'comparison-target-time';
        targetTime.textContent = row.RequiredTimeToBeat;
        const qualifier = document.createElement('span');
        qualifier.className = 'comparison-target-qualifier';
        qualifier.textContent = 'or faster';
        targetResult.append(targetLabel, targetTime, qualifier, exportedComparisonPace(row));

        benchmark.append(types, standardResult, direction, targetResult);
        return benchmark;
    }

    function mergeEquivalentBenchmarks(rows) {
        const groups = [];
        const groupsByPerformance = new Map();

        for (const row of rows) {
            const key = JSON.stringify([
                row.StandardTime,
                row.StandardAgeGrade,
                row.StandardDate,
                row.StandardEvent,
                row.StandardTimeClass,
                row.RequiredTimeToBeat,
                row.RequiredPacePerKm,
                row.RequiredPacePerMile
            ]);

            if (!groupsByPerformance.has(key)) {
                const group = [];
                groupsByPerformance.set(key, group);
                groups.push(group);
            }
            groupsByPerformance.get(key).push(row);
        }

        return groups;
    }

    function mergedBenchmarkCount(rows) {
        return groupByDistance(rows)
            .reduce((total, group) => total + mergeEquivalentBenchmarks(group.rows).length, 0);
    }

    function exportedComparisonPace(row) {
        const pace = document.createElement('span');
        pace.className = 'calculator-pace comparison-target-pace';
        pace.innerHTML = window.paceDisplay?.renderExportedPaces(
            row.RequiredPacePerKm,
            row.RequiredPacePerMile,
            'calculator-pace-value'
        ) || '';
        return pace;
    }

    function groupByDistance(rows) {
        const groups = [];
        const byDistance = new Map();
        for (const row of rows) {
            if (!byDistance.has(row.Distance)) {
                const group = { distance: row.Distance, rows: [] };
                byDistance.set(row.Distance, group);
                groups.push(group);
            }
            byDistance.get(row.Distance).rows.push(row);
        }
        return groups;
    }

    function keepComparisonAthletesDifferent(changedSelect) {
        if (elements.comparisonAthleteA.value !== elements.comparisonAthleteB.value) return;

        const replacement = state.athletes.find(athlete => athlete.id !== changedSelect.value);
        if (!replacement) return;

        if (changedSelect === elements.comparisonAthleteA) {
            elements.comparisonAthleteB.value = replacement.id;
        } else {
            elements.comparisonAthleteA.value = replacement.id;
        }
    }

    function populateComparisonPeriods() {
        elements.comparisonPeriodControl.hidden = !state.comparisonExportAvailable || !state.comparisonPeriods.length;
        elements.comparisonPeriodNote.textContent = state.comparisonPeriods.includes('Current')
            ? 'Current covers performances from the last 12 months.'
            : 'Current standards are not included in this championship update yet.';
        elements.comparisonPeriodOptions.replaceChildren(...state.comparisonPeriods.map(period => {
            const label = document.createElement('label');
            const input = document.createElement('input');
            const text = document.createElement('span');
            input.type = 'radio';
            input.name = 'comparison-period';
            input.value = period;
            input.checked = period === state.selectedComparisonPeriod;
            text.textContent = period === 'Current' ? 'Current' : 'All time';
            label.append(input, text);
            return label;
        }));
    }

    function availableComparisonPeriods(rows) {
        const available = new Set(rows.map(comparisonPeriod));
        return ['Current', 'All Time'].filter(period => available.has(period));
    }

    function comparisonPeriod(row) {
        return String(row.Period || '').trim().toLowerCase() === 'current'
            ? 'Current'
            : 'All Time';
    }

    function summaryContent(title, detail) {
        const fragment = document.createDocumentFragment();
        const titleElement = document.createElement('strong');
        titleElement.textContent = title;
        const detailElement = document.createElement('span');
        detailElement.textContent = detail;
        fragment.append(titleElement, detailElement);
        return fragment;
    }

    function emptyMessage(message) {
        const element = document.createElement('p');
        element.className = 'calculator-empty';
        element.textContent = message;
        return element;
    }

    function formatComparisonDate(value) {
        return window.dateDisplay?.format(value) || String(value || '');
    }

    function renderLoadError() {
        const message = 'The exported athlete comparisons are unavailable right now. Please try again later.';
        elements.comparisonSummary.replaceChildren();
        elements.comparisonResults.replaceChildren(emptyMessage(message));
        elements.comparisonResults.dataset.rendered = 'true';
    }

    function buildAthletes(standards, results) {
        const namesById = new Map();
        for (const row of results) {
            if (row.AthleteID && row.Participant && !namesById.has(row.AthleteID)) {
                namesById.set(row.AthleteID, row.Participant);
            }
        }

        const seen = new Set();
        const athletes = [];
        for (const row of standards) {
            if (!row.AthleteId || seen.has(row.AthleteId)) continue;
            seen.add(row.AthleteId);
            athletes.push({
                id: row.AthleteId,
                name: namesById.get(row.AthleteId) || row.AthleteId
            });
        }
        return athletes;
    }

    function closestCurrentRivalry(rows) {
        const availableAthletes = new Set(state.athletes.map(athlete => athlete.id));
        const contenders = rows
            .map(row => ({
                athleteId: row['Athlete ID'],
                rank: Number(row.Rank),
                ageGrade: Number(String(row['Age Graded Score'] || '').replace('%', ''))
            }))
            .filter(contender =>
                availableAthletes.has(contender.athleteId) &&
                Number.isFinite(contender.rank) &&
                contender.rank >= 1 &&
                contender.rank <= 5 &&
                Number.isFinite(contender.ageGrade)
            )
            .sort((a, b) => a.rank - b.rank);

        let closest = null;
        for (let higherIndex = 0; higherIndex < contenders.length; higherIndex += 1) {
            for (let lowerIndex = higherIndex + 1; lowerIndex < contenders.length; lowerIndex += 1) {
                const higher = contenders[higherIndex];
                const lower = contenders[lowerIndex];
                const gap = Math.abs(higher.ageGrade - lower.ageGrade);
                if (!closest || gap < closest.gap || (gap === closest.gap && higher.rank < closest.standardRank)) {
                    closest = {
                        challengerId: lower.athleteId,
                        standardId: higher.athleteId,
                        standardRank: higher.rank,
                        gap
                    };
                }
            }
        }

        return closest;
    }

    function populateSelect(select, options) {
        select.replaceChildren(...options.map(option => new Option(option.label, option.value)));
    }

    function rowsToObjects(rows) {
        const headers = rows[0] || [];
        return rows.slice(1)
            .filter(row => row.some(value => value !== ''))
            .map(row => Object.fromEntries(headers.map((header, index) => [header, row[index] || ''])));
    }

    function athleteById(id) {
        return state.athletes.find(athlete => athlete.id === id);
    }

    function benchmarkClass(value) {
        return `benchmark-${String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '')}`;
    }

    function selectedSite() {
        const requested = new URLSearchParams(window.location.search).get('site');
        return requested === 'everyone' ? 'everyone' : 'family';
    }
})();
