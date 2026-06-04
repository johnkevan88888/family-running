async function loadCSV(file, elementId) {

    const response = await fetch(file);
    const text = await response.text();

    const rows = text.trim().split('\n').map(row => row.split(','));

    let html = '<table border="1" cellpadding="6" cellspacing="0">';

    rows.forEach((row, index) => {

        html += '<tr>';

        row.forEach(cell => {

            cell = cell.replace(/"/g, '').trim();

            if (index === 0) {

                html += `<th>${cell}</th>`;

            } else {

                // Medal icons for top 3

if (row[0] === '1' && cell === row[0]) {
    cell = '<span class="medal">🥇</span>';
}

if (row[0] === '2' && cell === row[0]) {
    cell = '<span class="medal">🥈</span>';
}

if (row[0] === '3' && cell === row[0]) {
    cell = '<span class="medal">🥉</span>';
}

                // Age Grade Category badges

                const category = cell.toLowerCase();

               if (category === 'club') {
    cell = '<span class="club">🥉 Club</span>';
}

if (category === 'local competitive') {
    cell = '<span class="local">🥈 Local Competitive</span>';
}

if (category === 'regional class') {
    cell = '<span class="regional">🥇 Regional Class</span>';
}

                if (category === 'national class') {
                    cell = '<span class="national">National Class</span>';
                }

                if (category === 'international class') {
                    cell = '<span class="international">International Class</span>';
                }

                html += `<td>${cell}</td>`;
            }

        });

        html += '</tr>';

    });

    html += '</table>';

    document.getElementById(elementId).innerHTML = html;
}

loadCSV('data/current.csv', 'current');
loadCSV('data/alltime.csv', 'alltime');