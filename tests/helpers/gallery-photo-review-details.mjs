import assert from 'node:assert/strict';

// Test-only assertions shared by the real-candidate smoke check and synthetic
// layout regressions. Expectations come from the manifest/export, never the DOM.
export async function assertPhotoReviewDetails(container, item, results, formatDate, label) {
    const perRunner = Object.hasOwn(item, 'raceResults');
    const formatDistance = distance => distance === 'H. Mar' ? 'Half Marathon' : distance;
    const date = formatDate(item.raceDate);
    const raceLabel = perRunner ? date : `${formatDistance(item.raceDistance)} · ${date}`;
    assert.equal(await container.locator('.gallery-card-meta').first().innerText(), raceLabel,
        `${label}: exact race label`);
    assert.deepEqual(await container.locator('h4').allTextContents(), results.map(result => result.name),
        `${label}: exact athlete names/order`);
    const fields = results.map(result => result.otherPerson
        ? [['Pictured', 'Other person — no race result assigned']]
        : [
            ...(perRunner ? [['Distance', result.distance ? formatDistance(result.distance) : 'Unavailable']] : []),
            ['Time', result.time], ['AG', result.ageGrade], ['Age at race', result.age]
        ]);
    assert.deepEqual(await container.locator('dt').allTextContents(), fields.flatMap(rows => rows.map(([name]) => name)),
        `${label}: exact field labels/order`);
    assert.deepEqual(await container.locator('dd').allTextContents(), fields.flatMap(rows => rows.map(([, value]) => value)),
        `${label}: exported details only`);
    const people = container.locator('.gallery-photo-athlete');
    assert.equal(await people.count(), results.length, `${label}: one detail section per pictured athlete`);
    for (let at = 0; at < results.length; at++) {
        assert.deepEqual(await people.nth(at).locator('dt').allTextContents(), fields[at].map(([name]) => name),
            `${label}: field labels stay with athlete ${at + 1}`);
        assert.deepEqual(await people.nth(at).locator('dd').allTextContents(), fields[at].map(([, value]) => value),
            `${label}: result fields stay with athlete ${at + 1}`);
    }
}
