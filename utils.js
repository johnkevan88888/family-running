const csvCache = new Map();
const athleteLinkSites = new Set(['family', 'everyone']);

window.dateDisplay = (function () {
    const monthNames = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
    ];

    function parse(value) {
        if (value instanceof Date) {
            return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
        }

        const text = String(value || '').trim();
        if (!text) return null;

        const exportedDate = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (exportedDate) {
            return checkedLocalDate(
                Number(exportedDate[3]),
                Number(exportedDate[2]),
                Number(exportedDate[1])
            );
        }

        const isoDate = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (isoDate) {
            return checkedLocalDate(
                Number(isoDate[1]),
                Number(isoDate[2]),
                Number(isoDate[3])
            );
        }

        const parsed = new Date(text);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    function checkedLocalDate(year, month, day) {
        const parsed = new Date(year, month - 1, day);

        if (
            parsed.getFullYear() !== year ||
            parsed.getMonth() !== month - 1 ||
            parsed.getDate() !== day
        ) {
            return null;
        }

        return parsed;
    }

    function format(value) {
        const date = parse(value);
        if (!date) return String(value || '');

        return `${date.getDate()} ${monthNames[date.getMonth()]} ${date.getFullYear()}`;
    }

    function formatDateTime(value) {
        const date = parse(value);
        if (!date) return String(value || '');

        const time = date.toLocaleTimeString(undefined, {
            hour: 'numeric',
            minute: '2-digit'
        });

        return `${format(date)}, ${time}`;
    }

    function subtractMonths(value, months) {
        const date = parse(value);
        if (!date || !Number.isInteger(months)) return null;

        const originalDay = date.getDate();
        const result = new Date(date.getTime());
        result.setDate(1);
        result.setMonth(result.getMonth() - months);
        result.setDate(Math.min(originalDay, daysInMonth(result.getFullYear(), result.getMonth())));

        return result;
    }

    function daysInMonth(year, monthIndex) {
        return new Date(year, monthIndex + 1, 0).getDate();
    }

    return {
        format,
        formatDateTime,
        parse,
        subtractMonths
    };
})();

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
        const timeHTML = `<span class="result-time">${escapeHTML(time)}</span>`;
        const pacesHTML = renderPacesForTime(time, ...distanceCandidates);

        if (!pacesHTML) {
            return escapeHTML(time);
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
            escapeHTML(perKm),
            escapeHTML(perMile),
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
            // `Response.text()` strips a UTF-8 byte order mark, but a CSV read
            // through another path may still carry one.
            const csvText = text.replace(/^\uFEFF/, '');

            if (!csvText.trim()) {
                return [];
            }

            try {
                return parseCSV(csvText);
            } catch (error) {
                throw new Error(`${file}: ${error.message}`);
            }
        });

    csvCache.set(file, promise);
    return promise;
}

// Parses the whole document rather than one line at a time, matching
// `parseCsv` in scripts/validate-csv.mjs field for field. Splitting on line
// breaks first cannot be correct: a quoted field is allowed to contain a
// newline, so the browser would silently see two malformed rows where the
// repository validator sees one valid one, and the exported value would render
// wrongly on a file that passed every release check.
function parseCSV(text) {
    const rows = [];
    let row = [];
    let value = '';
    let insideQuotes = false;

    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        const next = text[index + 1];

        if (character === '"') {
            if (insideQuotes && next === '"') {
                value += '"';
                index += 1;
            } else {
                insideQuotes = !insideQuotes;
            }
            continue;
        }

        if (character === ',' && !insideQuotes) {
            row.push(value.trim());
            value = '';
            continue;
        }

        if ((character === '\r' || character === '\n') && !insideQuotes) {
            row.push(value.trim());
            rows.push(row);
            row = [];
            value = '';

            if (character === '\r' && next === '\n') {
                index += 1;
            }
            continue;
        }

        value += character;
    }

    // Fail rather than guess. An unbalanced quote means every field after it is
    // wrong, and a rejected load leaves a readable error on the page instead of
    // mangled championship data.
    if (insideQuotes) {
        throw new Error('CSV contains an unclosed quoted field.');
    }

    if (value.length || row.length) {
        row.push(value.trim());
        rows.push(row);
    }

    return rows.filter((candidate, index) =>
        !(index === rows.length - 1 && candidate.length === 1 && candidate[0] === '')
    );
}

function csvRowsToObjects(rows) {
    const headers = (rows[0] || []).map(header => String(header).trim());

    return rows.slice(1)
        .filter(row => row.some(cell => cell !== ''))
        .map(row => Object.fromEntries(
            headers.map((header, index) => [header, row[index] || ''])
        ));
}

// Shared by every renderer. `?? ''` rather than `|| ''` so a numeric 0 renders
// as "0" instead of disappearing.
function escapeHTML(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Call sites pass raw exported values. Escaping lives here so no caller can
// forget it and no caller double-escapes.
function athleteLink(id, name) {
    const href = window.siteNavigation?.athleteHref
        ? window.siteNavigation.athleteHref(id)
        : fallbackAthleteHref(id);

    return `<a href="${escapeHTML(href)}">${escapeHTML(name)}</a>`;
}

function fallbackAthleteHref(id) {
    const params = new URLSearchParams(window.location.search);
    const requestedSite = String(params.get('site') || '').toLowerCase();
    const site = athleteLinkSites.has(requestedSite) ? requestedSite : 'family';

    return `athlete.html?id=${encodeURIComponent(id)}&site=${site}`;
}
