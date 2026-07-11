const csvCache = new Map();

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
