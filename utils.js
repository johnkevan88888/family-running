const csvCache = new Map();

window.paceDisplay = (function () {
    const storageKey = 'family-running.age-grade-pace-unit';
    const defaultUnit = 'km';
    const validUnits = new Set(['km', 'mi']);
    const milesPerKm = 0.6213711922;

    const distances = new Map([
        ['5km', { label: '5 km', kilometres: 5 }],
        ['10km', { label: '10 km', kilometres: 10 }],
        ['10mile', { label: '10 Mile', kilometres: 16.09344 }],
        ['10miles', { label: '10 Mile', kilometres: 16.09344 }],
        ['10mi', { label: '10 Mile', kilometres: 16.09344 }],
        ['hmar', { label: 'Half Marathon', kilometres: 21.0975 }],
        ['halfmarathon', { label: 'Half Marathon', kilometres: 21.0975 }],
        ['halfmar', { label: 'Half Marathon', kilometres: 21.0975 }],
        ['marathon', { label: 'Marathon', kilometres: 42.195 }]
    ]);

    function initialize(root = document) {
        root.querySelectorAll('.pace-unit-options button[data-pace-unit]').forEach(button => {
            if (button.dataset.paceControlBound === 'true') return;

            button.addEventListener('click', () => {
                setUnit(button.dataset.paceUnit, true);
            });
            button.dataset.paceControlBound = 'true';
        });

        setUnit(readStoredUnit(), false);
    }

    function setUnit(unit, persist) {
        const selectedUnit = validUnits.has(unit) ? unit : defaultUnit;

        document.documentElement.dataset.paceUnit = selectedUnit;

        document.querySelectorAll('.pace-unit-options button[data-pace-unit]').forEach(button => {
            button.setAttribute('aria-pressed', String(button.dataset.paceUnit === selectedUnit));
        });

        document.querySelectorAll('.pace-display[data-pace-display-unit]').forEach(pace => {
            pace.hidden = pace.dataset.paceDisplayUnit !== selectedUnit;
        });

        if (!persist) return;

        try {
            window.localStorage.setItem(storageKey, selectedUnit);
        } catch (error) {
            // The selected unit still applies for this page when storage is unavailable.
        }
    }

    function readStoredUnit() {
        try {
            const storedUnit = window.localStorage.getItem(storageKey);
            return validUnits.has(storedUnit) ? storedUnit : defaultUnit;
        } catch (error) {
            return defaultUnit;
        }
    }

    function renderTimeWithPace(time, ...distanceCandidates) {
        const timeHTML = `<span class="result-time">${escapePaceHTML(time)}</span>`;
        const pacesHTML = renderPacesForTime(time, ...distanceCandidates);

        if (!pacesHTML) {
            return escapePaceHTML(time);
        }

        return `
            <span class="time-with-pace">
                ${timeHTML}
                <span class="result-pace" aria-label="pace">${pacesHTML}</span>
            </span>
        `;
    }

    function renderPacesForTime(time, ...distanceCandidates) {
        const seconds = parseTimeToSeconds(time);
        const distance = resolveDistance(...distanceCandidates);

        if (seconds === null || !distance) {
            return '';
        }

        return renderPaceValues(
            formatPace(seconds / distance.kilometres),
            formatPace(seconds / (distance.kilometres * milesPerKm))
        );
    }

    function renderExportedPaces(perKm, perMile, className = '') {
        if (!perKm || !perMile) return '';

        return renderPaceValues(
            escapePaceHTML(perKm),
            escapePaceHTML(perMile),
            className
        );
    }

    function formatTimeWithPaceText(time, ...distanceCandidates) {
        const seconds = parseTimeToSeconds(time);
        const distance = resolveDistance(...distanceCandidates);

        if (seconds === null || !distance) {
            return String(time || '');
        }

        const selectedUnit = readStoredUnit();
        const pace = selectedUnit === 'mi'
            ? formatPace(seconds / (distance.kilometres * milesPerKm))
            : formatPace(seconds / distance.kilometres);

        return `${time} (${pace} /${selectedUnit})`;
    }

    function renderPaceValues(perKm, perMile, className = '') {
        const selectedUnit = readStoredUnit();
        const classes = ['pace-display', className].filter(Boolean).join(' ');

        return `
            <span class="${classes}" data-pace-display-unit="km"${selectedUnit === 'km' ? '' : ' hidden'}>${perKm} /km</span>
            <span class="${classes}" data-pace-display-unit="mi"${selectedUnit === 'mi' ? '' : ' hidden'}>${perMile} /mi</span>
        `;
    }

    function resolveDistance(...candidates) {
        for (const candidate of candidates) {
            const distance = parseDistance(candidate);
            if (distance) return distance;
        }

        return null;
    }

    function parseDistance(value) {
        const rawValue = String(value || '').trim();
        if (!rawValue) return null;

        const candidates = rawValue.includes('|')
            ? [rawValue.split('|').pop(), rawValue]
            : [rawValue];

        for (const candidate of candidates) {
            const normalized = candidate
                .toLowerCase()
                .replace(/\./g, '')
                .replace(/&nbsp;/g, ' ')
                .replace(/\s+/g, '')
                .replace(/-/g, '');

            if (distances.has(normalized)) {
                return distances.get(normalized);
            }

            const kmMatch = normalized.match(/^(\d+(?:\.\d+)?)km$/);
            if (kmMatch) {
                return {
                    label: `${kmMatch[1]} km`,
                    kilometres: Number(kmMatch[1])
                };
            }

            const mileMatch = normalized.match(/^(\d+(?:\.\d+)?)(?:mile|miles|mi)$/);
            if (mileMatch) {
                return {
                    label: `${mileMatch[1]} Mile`,
                    kilometres: Number(mileMatch[1]) / milesPerKm
                };
            }
        }

        return null;
    }

    function parseTimeToSeconds(value) {
        const parts = String(value || '').trim().split(':').map(Number);

        if (parts.length < 2 || parts.length > 3 || parts.some(part => !Number.isFinite(part))) {
            return null;
        }

        const [hours, minutes, seconds] = parts.length === 3
            ? parts
            : [0, parts[0], parts[1]];

        return (hours * 3600) + (minutes * 60) + seconds;
    }

    function formatPace(secondsPerUnit) {
        if (!Number.isFinite(secondsPerUnit) || secondsPerUnit <= 0) {
            return '';
        }

        const roundedSeconds = Math.round(secondsPerUnit);
        const minutes = Math.floor(roundedSeconds / 60);
        const seconds = roundedSeconds % 60;

        return `${minutes}:${String(seconds).padStart(2, '0')}`;
    }

    function escapePaceHTML(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    return {
        formatTimeWithPaceText,
        initialize,
        renderExportedPaces,
        renderTimeWithPace,
        setUnit
    };
})();

async function fetchCSV(file) {
    if (csvCache.has(file)) {
        return csvCache.get(file);
    }

    const promise = fetch(file)
        .then(response => {
            if (!response.ok) {
                throw new Error(`Failed to load ${file}: ${response.status}`);
            }

            return response.text();
        })
        .then(text => {
            const trimmed = text.trim();

            if (!trimmed) {
                return [];
            }

            return trimmed
                .split(/\r?\n/)
                .map(parseCSVRow);
        });

    csvCache.set(file, promise);
    return promise;
}

function parseCSVRow(row) {
    const result = [];
    let current = '';
    let insideQuotes = false;

    for (let i = 0; i < row.length; i++) {
        const char = row[i];

        if (char === '"' && insideQuotes && row[i + 1] === '"') {
            current += '"';
            i += 1;
        } else if (char === '"') {
            insideQuotes = !insideQuotes;
        } else if (char === ',' && !insideQuotes) {
            result.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }

    result.push(current.trim());
    return result;
}

function athleteLink(id, name) {
    if (window.siteNavigation?.athleteHref) {
        return `<a href="${window.siteNavigation.athleteHref(id)}">${name}</a>`;
    }

    const params = new URLSearchParams(window.location.search);
    const site = params.get('site') || 'family';

    return `<a href="athlete.html?id=${encodeURIComponent(id)}&site=${encodeURIComponent(site)}">${name}</a>`;
}
