const recordsParams = new URLSearchParams(window.location.search);
const recordsSite = window.siteNavigation?.selectedSite
    ? window.siteNavigation.selectedSite()
    : (recordsParams.get('site') || 'family');
const recordsDataPath = `data/${recordsSite}`;
const absoluteRecordsPath = `${recordsDataPath}/absolute_records.csv`;

const absoluteRecordDistanceOrder = new Map([
    ['overall', 10],
    ['marathon', 20],
    ['halfmarathon', 30],
    ['10mile', 40],
    ['10km', 50],
    ['5km', 60]
]);

async function buildAbsoluteRecords() {
    const container = document.getElementById('absolute-records');
    if (!container) return;

    try {
        const exportAvailable = await manifestIncludesPath(absoluteRecordsPath);

        if (!exportAvailable) {
            renderAbsoluteRecordsEmpty(container);
            return;
        }

        const rows = await fetchCSV(absoluteRecordsPath);
        const records = recordsRowsToObjects(rows)
            .filter(row => row.hasDisplayValue)
            .sort(compareAbsoluteRecordRows);

        if (!records.length) {
            renderAbsoluteRecordsEmpty(container);
            return;
        }

        const groups = groupAbsoluteRecords(records);
        container.innerHTML = `
            <div class="absolute-records-groups">
                ${groups.map(renderAbsoluteRecordGroup).join('')}
            </div>
        `;
        container.dataset.rendered = 'true';
        refreshRecordsPaceDisplay();
    } catch (error) {
        container.innerHTML = '<p class="absolute-records-empty">Absolute records are unavailable.</p>';
        container.dataset.rendered = 'true';
    }
}

async function manifestIncludesPath(relativePath) {
    const rows = await fetchCSV('data/export_manifest.csv');
    const headers = rows[0] || [];
    const pathIndex = headers.indexOf('RelativePath');

    if (pathIndex < 0) {
        return false;
    }

    const expectedPath = normalizeManifestPath(relativePath);

    return rows
        .slice(1)
        .some(row => normalizeManifestPath(row[pathIndex]) === expectedPath);
}

function normalizeManifestPath(value) {
    return String(value || '').trim().replace(/\\/g, '/');
}

function recordsRowsToObjects(rows) {
    const headers = (rows[0] || []).map(header => String(header).trim());
    const normalizedHeaders = headers.map(normalizeRecordHeader);

    return rows
        .slice(1)
        .filter(row => row.some(cell => cell !== ''))
        .map((row, index) => absoluteRecordRowToObject(normalizedHeaders, row, index));
}

function absoluteRecordRowToObject(normalizedHeaders, row, index) {
    const source = {};

    normalizedHeaders.forEach((header, columnIndex) => {
        source[header] = row[columnIndex] || '';
    });

    const distance = pickRecordField(source, ['distance', 'displaydistance']);
    const resultDistance = pickRecordField(source, ['resultdistance', 'racedistance', 'eventdistance']) || distance;
    const record = {
        sortOrder: pickRecordField(source, ['sortorder', 'displayorder', 'order']),
        group: pickRecordField(source, ['recordgroup', 'group', 'scope', 'recordscope', 'period']) || 'All-Time Official',
        title: pickRecordField(source, ['recordtitle', 'title', 'award']),
        distance,
        resultDistance,
        participant: pickRecordField(source, ['participant', 'athletename', 'holdername']),
        athleteId: pickRecordField(source, ['athleteid', 'athlete']),
        time: pickRecordField(source, ['time', 'recordtime']),
        timeClass: pickRecordField(source, ['timeclass', 'resulttype']),
        date: pickRecordField(source, ['date', 'eventdate', 'effectivedate']),
        event: pickRecordField(source, ['event', 'eventname', 'race']),
        ageClass: pickRecordField(source, ['ageclass', 'sexage']) || ageClassFromSexAgeEvent(source.sexageevent),
        ageGrade: pickRecordField(source, ['agegrade', 'agegradedscore']),
        note: pickRecordField(source, ['note', 'notes', 'description']),
        exportIndex: index
    };

    record.title = record.title || `${record.distance || 'Absolute'} record`;
    record.hasDisplayValue = Boolean(record.participant || record.time || record.distance || record.title);

    return record;
}

function pickRecordField(source, aliases) {
    for (const alias of aliases) {
        const value = source[normalizeRecordHeader(alias)];
        if (value) return value;
    }

    return '';
}

function normalizeRecordHeader(header) {
    return String(header || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function ageClassFromSexAgeEvent(value) {
    return String(value || '').split('|')[0] || '';
}

function compareAbsoluteRecordRows(a, b) {
    const sortA = exportedRecordSortValue(a);
    const sortB = exportedRecordSortValue(b);

    if (sortA !== null && sortB !== null && sortA !== sortB) {
        return sortA - sortB;
    }

    if (sortA !== null) return -1;
    if (sortB !== null) return 1;

    const distanceOrderDifference = distanceSortValue(a.distance) - distanceSortValue(b.distance);
    if (distanceOrderDifference !== 0) return distanceOrderDifference;

    return a.exportIndex - b.exportIndex;
}

function exportedRecordSortValue(record) {
    const value = Number(record.sortOrder);
    return Number.isFinite(value) ? value : null;
}

function distanceSortValue(distance) {
    return absoluteRecordDistanceOrder.get(canonicalRecordDistanceKey(distance)) || 999;
}

function canonicalRecordDistanceKey(value) {
    const key = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\./g, '')
        .replace(/\s+/g, '');

    if (['hmar', 'halfmar', 'halfmarathon'].includes(key)) {
        return 'halfmarathon';
    }

    if (['10m', '10mi', '10mile'].includes(key)) {
        return '10mile';
    }

    return key;
}

function groupAbsoluteRecords(records) {
    const groups = [];

    for (const record of records) {
        let group = groups.find(candidate => candidate.title === record.group);

        if (!group) {
            group = {
                title: record.group,
                records: []
            };
            groups.push(group);
        }

        group.records.push(record);
    }

    return groups;
}

function renderAbsoluteRecordGroup(group) {
    return `
        <section class="absolute-records-group">
            <h3>${escapeRecordHTML(group.title)}</h3>
            <div class="absolute-record-grid">
                ${group.records.map(renderAbsoluteRecordCard).join('')}
            </div>
        </section>
    `;
}

function renderAbsoluteRecordCard(record) {
    const empty = isEmptyAbsoluteRecord(record);
    const participant = record.athleteId && !empty
        ? athleteLink(record.athleteId, escapeRecordHTML(record.participant))
        : escapeRecordHTML(record.participant || 'No eligible result');
    const facts = [
        record.timeClass ? `<span>${escapeRecordHTML(record.timeClass)}</span>` : '',
        record.date ? `<span>${escapeRecordHTML(record.date)}</span>` : '',
        record.event ? `<span>${escapeRecordHTML(record.event)}</span>` : ''
    ].filter(Boolean).join('');
    const details = [
        record.ageClass ? `<div><dt>Age class</dt><dd>${escapeRecordHTML(record.ageClass)}</dd></div>` : '',
        record.ageGrade ? `<div><dt>Age grade</dt><dd>${escapeRecordHTML(record.ageGrade)}</dd></div>` : '',
        record.note ? `<div><dt>Note</dt><dd>${escapeRecordHTML(record.note)}</dd></div>` : ''
    ].filter(Boolean).join('');

    return `
        <article class="absolute-record-card${empty ? ' empty' : ''}">
            <div class="absolute-record-distance">${escapeRecordHTML(record.distance || 'Record')}</div>
            <h4>${escapeRecordHTML(record.title)}</h4>
            <div class="absolute-record-time">
                ${empty ? '-' : renderRecordTimeWithPace(record.time, record.resultDistance, record.distance)}
            </div>
            <div class="absolute-record-holder">${participant}</div>
            ${facts ? `<div class="absolute-record-facts">${facts}</div>` : ''}
            ${details ? `<dl class="absolute-record-details">${details}</dl>` : ''}
        </article>
    `;
}

function isEmptyAbsoluteRecord(record) {
    const participant = String(record.participant || '').toLowerCase();

    return !record.time ||
        participant.includes('vacant') ||
        participant.includes('no eligible');
}

function renderAbsoluteRecordsEmpty(container) {
    container.innerHTML = '<p class="absolute-records-empty">No absolute records have been exported yet.</p>';
    container.dataset.rendered = 'true';
}

function renderRecordTimeWithPace(time, ...distanceCandidates) {
    return window.paceDisplay?.renderTimeWithPace(time, ...distanceCandidates) ||
        escapeRecordHTML(time);
}

function refreshRecordsPaceDisplay() {
    window.paceDisplay?.initialize(document);
}

function escapeRecordHTML(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

buildAbsoluteRecords();
