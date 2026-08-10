const csvCache = new Map();
const athleteLinkSites = new Set(['family', 'everyone']);

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
