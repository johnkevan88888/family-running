(function () {
    const state = {
        rows: [],
        athletes: [],
        distances: [],
        timeTouched: false
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
            const rows = csvRowsToObjects(await fetchCSV(`data/${site}/age_grade_calculator.csv`));
            window.ageGradeContract.validateRows(rows);
            state.rows = rows;
            state.athletes = uniqueAthletes(rows);
            state.distances = uniqueDistances(rows);

            if (!state.athletes.length || !state.distances.length) {
                throw new Error('No exported calculator choices are available.');
            }

            populateSelect(
                elements.athlete,
                state.athletes.map(athlete => ({ value: athlete.id, label: athlete.name }))
            );
            populateSelect(
                elements.distance,
                state.distances.map(distance => ({ value: distance, label: distance }))
            );
            bindControls();
            elements.time.disabled = false;
            elements.athlete.disabled = false;
            elements.distance.disabled = false;
            elements.contractStatus.textContent = 'Checked against the workbook calculation contract.';
            renderResult();
        } catch (error) {
            disableCalculator(error);
            console.error('Unable to load the age-grade calculator.', error);
        }
    }

    function captureElements() {
        elements.form = document.getElementById('age-grade-controls');
        elements.athlete = document.getElementById('age-grade-athlete');
        elements.distance = document.getElementById('age-grade-distance');
        elements.time = document.getElementById('age-grade-time');
        elements.timeError = document.getElementById('age-grade-time-error');
        elements.percentage = document.getElementById('age-grade-percentage');
        elements.resultDetail = document.getElementById('age-grade-result-detail');
        elements.result = document.getElementById('age-grade-result');
        elements.contractStatus = document.getElementById('age-grade-contract-status');

        elements.athlete.disabled = true;
        elements.distance.disabled = true;
        elements.time.disabled = true;
    }

    function bindControls() {
        elements.athlete.addEventListener('change', renderResult);
        elements.distance.addEventListener('change', renderResult);
        elements.time.addEventListener('input', renderResult);
        elements.time.addEventListener('blur', () => {
            state.timeTouched = true;
            const parsed = parseDuration(elements.time.value);
            if (parsed.valid) elements.time.value = formatDuration(parsed.seconds, parsed.hasTenths);
            renderResult();
        });
        elements.form.addEventListener('submit', event => {
            event.preventDefault();
            state.timeTouched = true;
            const parsed = parseDuration(elements.time.value);
            if (parsed.valid) elements.time.value = formatDuration(parsed.seconds, parsed.hasTenths);
            renderResult();
        });
    }

    function renderResult() {
        const parsed = parseDuration(elements.time.value);
        const row = selectedRow();

        elements.time.setAttribute('aria-invalid', String(state.timeTouched && !parsed.valid && !parsed.empty));
        elements.timeError.textContent = state.timeTouched && !parsed.valid && !parsed.empty
            ? 'Enter MM:SS, H:MM:SS, or compact digits such as 2430 or 14530.5.'
            : '';

        if (parsed.empty) {
            renderPlaceholder('Enter a race time to calculate your result.');
            return;
        }
        if (!parsed.valid || !row) {
            renderPlaceholder(parsed.valid
                ? 'This athlete and distance are unavailable in the workbook export.'
                : 'Finish entering a valid race time.');
            return;
        }

        const ageGrade = window.ageGradeContract.calculate(row.AgeGradedStandardSeconds, parsed.seconds);
        const athlete = state.athletes.find(item => item.id === row.AthleteId);
        elements.percentage.textContent = formatPercentage(ageGrade);
        elements.resultDetail.textContent = `${athlete?.name || row.Participant}'s ${formatDuration(parsed.seconds, parsed.hasTenths)} ${row.Distance} result.`;
        elements.result.dataset.state = 'calculated';
    }

    function renderPlaceholder(message) {
        elements.percentage.textContent = '—';
        elements.resultDetail.textContent = message;
        elements.result.dataset.state = 'empty';
    }

    function disableCalculator(error) {
        elements.athlete.disabled = true;
        elements.distance.disabled = true;
        elements.time.disabled = true;
        elements.percentage.textContent = 'Unavailable';
        elements.resultDetail.textContent = 'The calculator has been stopped because its workbook data could not be verified.';
        elements.result.dataset.state = 'error';
        elements.contractStatus.textContent = error?.message || 'Workbook calculation contract unavailable.';
    }

    function selectedRow() {
        return state.rows.find(row =>
            row.AthleteId === elements.athlete.value &&
            row.Distance === elements.distance.value
        );
    }

    function uniqueAthletes(rows) {
        const seen = new Set();
        return rows.reduce((athletes, row) => {
            if (!row.AthleteId || seen.has(row.AthleteId)) return athletes;
            seen.add(row.AthleteId);
            athletes.push({ id: row.AthleteId, name: row.Participant || row.AthleteId });
            return athletes;
        }, []);
    }

    function uniqueDistances(rows) {
        return [...new Set(
            [...rows]
                .sort((a, b) => Number(a.SortOrder) - Number(b.SortOrder))
                .map(row => row.Distance)
                .filter(Boolean)
        )];
    }

    function parseDuration(value) {
        const text = String(value || '').trim();
        if (!text) return { empty: true, valid: false, seconds: 0 };

        const compactMatch = text.match(/^(\d{3,6})(?:\.(\d))?$/);
        const colonMatch = text.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?(?:\.(\d))?$/);
        let parts;
        let tenths = 0;

        if (compactMatch) {
            const digits = compactMatch[1];
            tenths = Number(compactMatch[2] || 0);
            parts = digits.length <= 4
                ? [digits.slice(0, -2), digits.slice(-2)]
                : [digits.slice(0, -4), digits.slice(-4, -2), digits.slice(-2)];
        } else if (colonMatch) {
            tenths = Number(colonMatch[4] || 0);
            parts = colonMatch[3] === undefined
                ? [colonMatch[1], colonMatch[2]]
                : [colonMatch[1], colonMatch[2], colonMatch[3]];
        } else {
            return { empty: false, valid: false, seconds: 0 };
        }

        const numbers = parts.map(Number);
        if (numbers.some(number => !Number.isInteger(number) || number < 0)) {
            return { empty: false, valid: false, seconds: 0 };
        }

        const hasHours = numbers.length === 3;
        const hours = hasHours ? numbers[0] : 0;
        const minutes = hasHours ? numbers[1] : numbers[0];
        const seconds = numbers[numbers.length - 1];
        if (seconds > 59 || (hasHours && minutes > 59)) {
            return { empty: false, valid: false, seconds: 0 };
        }

        const totalSeconds = (hours * 3600) + (minutes * 60) + seconds + (tenths / 10);
        return {
            empty: false,
            hasTenths: tenths > 0 || /\.0$/.test(text),
            valid: totalSeconds > 0,
            seconds: totalSeconds
        };
    }

    function formatDuration(totalSeconds, showTenths = false) {
        const totalTenths = Math.round(totalSeconds * 10);
        const hours = Math.floor(totalTenths / 36000);
        const minutes = Math.floor((totalTenths % 36000) / 600);
        const seconds = Math.floor((totalTenths % 600) / 10);
        const tenths = totalTenths % 10;
        const secondsText = `${String(seconds).padStart(2, '0')}${showTenths ? `.${tenths}` : ''}`;
        return hours > 0
            ? `${hours}:${String(minutes).padStart(2, '0')}:${secondsText}`
            : `${minutes}:${secondsText}`;
    }

    function formatPercentage(score) {
        return new Intl.NumberFormat(undefined, {
            style: 'percent',
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }).format(score);
    }

    function populateSelect(select, options) {
        select.replaceChildren(...options.map(option => new Option(option.label, option.value)));
    }

    function selectedSite() {
        return new URLSearchParams(window.location.search).get('site') === 'everyone'
            ? 'everyone'
            : 'family';
    }
})();
