async function fetchCSV(file) {
    const response = await fetch(file);
    const text = await response.text();

    return text
        .trim()
        .split('\n')
        .map(parseCSVRow);
}

function parseCSVRow(row) {
    const result = [];
    let current = '';
    let insideQuotes = false;

    for (let i = 0; i < row.length; i++) {
        const char = row[i];

        if (char === '"') {
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
    const params = new URLSearchParams(window.location.search);
    const site = params.get('site') || 'family';

    return `<a href="athlete.html?id=${id}&site=${site}">${name}</a>`;
}