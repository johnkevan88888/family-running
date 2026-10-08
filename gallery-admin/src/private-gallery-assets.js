export function privateGalleryDocument(site) {
    if (!['family','everyone'].includes(site)) throw new TypeError('Invalid inherited Gallery area');
    const area = site === 'family' ? 'Family' : 'Everyone';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer"><title>Protected photo library</title><link rel="stylesheet" href="/admin.css"></head>
<body><header class="admin-header"><h1>Protected photo library</h1><span class="protected-badge">Owner access protected</span></header>
<main class="admin-main"><p><a href="/?site=${site}">Back to photo review</a></p>
<div class="fixed-area"><span>Inherited Gallery area</span><strong>${area}</strong><small>No destination selector. Complete tags remain in protected storage.</small></div>
<p id="private-status" class="app-status" role="status" aria-live="polite">Loading protected people…</p>
<section class="admin-panel"><h2>People pictured</h2><p>People do not need public results to be tagged. New people start hidden.</p>
<form id="private-person-form"><label class="form-field">Private display name<input id="private-person-name" maxlength="200" required autocomplete="off"></label>
<label class="form-field">Optional existing public athlete<select id="private-person-public"><option value="">Keep identity private</option></select></label>
<button class="button button-secondary" type="submit">Add private person</button></form>
<div id="private-people" class="draft-list"></div></section>
<section class="admin-panel"><h2>Reserve complete photo tags</h2><p>Choose every depicted person. This saves private tags only; it does not upload or publish a photograph.</p>
<form id="private-asset-form"><div id="private-tag-choices" class="athlete-choices"></div>
<label class="form-field">Original photo format<select id="private-format"><option value="jpg">JPEG</option><option value="png">PNG</option></select></label>
<button class="button button-primary" type="submit">Save private tags</button></form>
<p id="private-asset-status" role="status" aria-live="polite"></p></section></main>
<script src="/private-gallery.js" defer></script></body></html>`;
}

export function privateGalleryScript() {
    return String.raw`(() => {
    'use strict';
    const site = new URLSearchParams(location.search).get('site');
    const status = document.getElementById('private-status');
    let csrf, revision, busy = false, personRequest, assetRequest, activeAssetId;
    const choices = document.getElementById('private-tag-choices');
    const uuid = () => {
        if (typeof crypto.randomUUID !== 'function') throw new Error('Secure identifiers unavailable.');
        return crypto.randomUUID();
    };
    async function api(path, body) {
        const response = await fetch(path + '?site=' + site, {method:body ? 'POST' : 'GET',
            credentials:'same-origin',cache:'no-store',headers:body ? {'Content-Type':'application/json','X-CSRF-Token':csrf} : {},
            body:body ? JSON.stringify(body) : undefined});
        const result = await response.json();
        if (!response.ok) throw new Error('Request stopped. Refresh the protected library before continuing.');
        return result;
    }
    function note(text) { status.textContent = text; }
    async function action(callback) {
        if (busy) return;
        busy = true;
        note('Checking protected changes…');
        if (activeAssetId) document.getElementById('private-asset-status').textContent = 'Refreshing complete-tag eligibility…';
        const controls = [...document.querySelectorAll('button')];
        controls.forEach(button => button.disabled = true);
        try { await callback(); } catch (error) {
            note(error.message);
            if (activeAssetId) document.getElementById('private-asset-status').textContent = 'Eligibility unavailable. Do not publish from an earlier result.';
        }
        finally { busy = false; controls.forEach(button => button.disabled = false); }
    }
    async function refresh() {
        const roster = await api('/api/browser/private-preferences');
        revision = roster.revision;
        const selected = new Set([...choices.querySelectorAll('input:checked')].map(input=>input.value));
        choices.replaceChildren();
        const list = document.getElementById('private-people'); list.replaceChildren();
        for (const person of roster.people) {
            const preference = person;
            const label = document.createElement('label'); label.className = 'athlete-option';
            const check = document.createElement('input'); check.type = 'checkbox'; check.value = person.personId; check.checked = selected.has(person.personId);
            const name = document.createElement('span'); name.textContent = person.displayName;
            label.append(check,name); choices.append(label);
            const card = document.createElement('div'); card.className = 'draft-card';
            const heading = document.createElement('strong'); heading.textContent = person.displayName;
            const detail = document.createElement('span'); detail.textContent = preference.preference === 'hidden' ? 'Hidden preference — complete private tags retained' : 'Allowed preference — fresh consent and review still required';
            const button = document.createElement('button'); button.type = 'button'; button.className = 'button button-secondary';
            button.textContent = preference.preference === 'hidden' ? 'Allow for a fresh review' : 'Set hidden preference';
            button.addEventListener('click',()=>action(async()=>{
                await api('/api/browser/private-people/' + person.personId + '/visibility', {
                    expectedVersion:preference.version,idempotencyKey:uuid(),preference:preference.preference === 'hidden' ? 'allowed' : 'hidden'});
                await refresh(); note('Preference saved privately. Public removal or publication is not completed by this action.');
            }));
            card.append(heading,detail,button); list.append(card);
        }
        if (activeAssetId) await refreshEligibility();
    }
    async function refreshEligibility() {
        const eligibility = await api('/api/browser/private-assets/' + activeAssetId + '/eligibility');
        document.getElementById('private-asset-status').textContent = 'Saved ' + activeAssetId + '. ' +
            (eligibility.visibilityEligible ? 'Visibility preferences allow a fresh consent check.' : 'At least one depicted person blocks publication.');
    }
    document.getElementById('private-person-form').addEventListener('submit',event=>{
        event.preventDefault(); action(async()=>{
            const name = document.getElementById('private-person-name').value.trim();
            const publicId = document.getElementById('private-person-public').value || null;
            const data = [revision,name,publicId];
            if (!personRequest || JSON.stringify(personRequest.data) !== JSON.stringify(data)) personRequest = {key:uuid(),data};
            await api('/api/browser/private-people',{idempotencyKey:personRequest.key,rosterRevision:revision,displayName:name,publicAthleteId:publicId});
            personRequest = null; document.getElementById('private-person-form').reset();
            await refresh(); note('Private person saved, initially hidden. No public identity was created.');
        });
    });
    document.getElementById('private-asset-form').addEventListener('submit',event=>{
        event.preventDefault(); action(async()=>{
            const personIds = [...choices.querySelectorAll('input:checked')].map(input=>input.value);
            const originalFormat = document.getElementById('private-format').value;
            const data = [revision,personIds,originalFormat];
            if (!assetRequest || JSON.stringify(assetRequest.data) !== JSON.stringify(data)) assetRequest = {key:uuid(),data};
            const result = await api('/api/browser/private-assets',{idempotencyKey:assetRequest.key,rosterRevision:revision,personIds,originalFormat});
            activeAssetId = result.asset.assetId;
            await refreshEligibility();
            note('Complete private tags retained. Photo intake and publication remain disabled in this preparation.');
        });
    });
    action(async()=>{
        if (!['family','everyone'].includes(site) || location.search !== '?site=' + site) throw new Error('Invalid inherited area.');
        csrf = (await api('/api/browser/session')).csrfToken;
        const catalog = await api('/api/browser/catalog');
        const select = document.getElementById('private-person-public');
        for (const person of catalog.sites[site].roster) {
            const option = document.createElement('option'); option.value = person.athleteId; option.textContent = person.participant; select.append(option);
        }
        await refresh(); note('Protected tagging controls ready. No photo upload or publication is enabled yet.');
    });
})();`;
}
