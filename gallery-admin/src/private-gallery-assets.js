import { privateFaceEditorPanel } from './private-gallery-face-assets.js';

export function privateGalleryDocument(site) {
    if (!['family','everyone'].includes(site)) throw new TypeError('Invalid inherited Gallery area');
    const area = site === 'family' ? 'Family' : 'Everyone';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer"><title>Protected photo library</title><link rel="stylesheet" href="/admin.css"><link rel="stylesheet" href="/private-face-editor.css?site=${site}"></head>
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
<p id="private-asset-status" role="status" aria-live="polite"></p></section>
<section class="admin-panel"><h2>Retain an original privately</h2><p>Save complete tags first. Retention permission is separate from public-use consent. No original filename or private tags enter the website.</p>
<form id="private-upload-form"><label class="form-field">Photo original<input id="private-photo" type="file" accept="image/jpeg,image/png" required></label>
<label class="check-line important-check"><input id="private-retention" type="checkbox" required><span>All depicted people agree to private retention.</span></label>
<fieldset class="nested-fieldset"><legend>Does this photo include minors?</legend><div class="choice-row">
<label class="choice-card"><input id="private-upload-minors" name="private-upload-minors" type="radio" value="yes" required><span>Yes</span></label>
<label class="choice-card"><input id="private-upload-adults" name="private-upload-minors" type="radio" value="no" required><span>No</span></label></div></fieldset>
<label class="check-line"><input id="private-upload-guardian" type="checkbox"><span>Their guardians agree to private retention (required for minors only).</span></label>
<button class="button button-primary" type="submit">Upload original to protected storage</button></form>
<p id="private-upload-status" role="status" aria-live="polite">No original uploaded.</p></section>
${privateFaceEditorPanel(site)}
<section class="admin-panel"><h2>Fresh public-use consent</h2><p>Allow is not consent and does not publish. Every depicted person must be eligible. A saved consent reservation is not a review or publication.</p>
<form id="private-consent-form"><label class="form-field">Race<select id="private-race" required></select></label>
<label class="check-line"><input id="private-complete-tags" type="checkbox" required><span>The saved tags include every depicted person.</span></label>
<label class="check-line important-check"><input id="private-public-use" type="checkbox" required><span>All depicted people agree to this new public-use review.</span></label>
<fieldset class="nested-fieldset"><legend>Does this photo include minors?</legend><div class="choice-row">
<label class="choice-card"><input id="private-public-minors" name="private-public-minors" type="radio" value="yes" required><span>Yes</span></label>
<label class="choice-card"><input id="private-public-adults" name="private-public-minors" type="radio" value="no" required><span>No</span></label></div></fieldset>
<label class="check-line"><input id="private-public-guardian" type="checkbox"><span>Their guardians agree to this new public-use review (required for minors only).</span></label>
<button class="button button-primary" type="submit">Save fresh public consent</button></form>
<p id="private-review-status" role="status" aria-live="polite">Fresh consent is needed before requesting a protected review. Nothing publishes automatically.</p></section>
<section class="admin-panel"><h2>Protected jobs and recovery</h2><p>Jobs preserve the inherited area and saved photo. Request one here, then run its owner-approved GitHub workflow. Review stops at an unmerged PR. Publication preparation does not merge it.</p>
<form id="private-open-form"><label class="form-field">Open an existing private photo by its saved ID<input id="private-open-id" required autocomplete="off"></label><button class="button button-secondary" type="submit">Open saved photo</button></form>
<form id="private-job-form"><label class="form-field">Protected action<select id="private-job-action"><option value="review">Process a fresh consent attempt for review</option><option value="removal">Resume hiding/removal of all this photo's generations</option><option value="publication">Prepare the separate owner merge gate</option><option value="purge-inspect">Inspect terminal metadata purge — no deletion</option><option value="purge">Confirm terminal metadata purge</option></select></label>
<label class="form-field">Saved consent attempt (review or publication only)<select id="private-job-attempt"><option value="">Select a saved attempt</option></select></label>
<label class="form-field">Checked purge proof (terminal purge only)<input id="private-purge-proof" autocomplete="off" maxlength="64"></label>
<label class="check-line important-check"><input id="private-job-confirm" type="checkbox" required><span>I approve this exact protected action. Hide retains the original; deletion/consent withdrawal and purge are separate decisions.</span></label>
<button class="button button-primary" type="submit">Request protected job</button></form>
<button id="private-jobs-refresh" class="button button-secondary" type="button">Refresh saved jobs</button><div id="private-jobs" class="draft-list" role="status" aria-live="polite"></div>
<section aria-labelledby="private-batch-heading"><h3 id="private-batch-heading">One review for several photos</h3>
<p>Upload, tag, frame and save consent for each photo separately. Open each saved photo here, select its saved consent attempt above, then add it to this ordered selection. This selection is held in this tab only until you request the saved batch job. Reloading discards an unsubmitted selection, not saved photos or jobs.</p>
<button id="private-batch-add" class="button button-secondary" type="button">Add selected consent attempt to batch</button>
<p id="private-batch-selection-status" role="status" aria-live="polite">0 of 20 photos selected.</p><ol id="private-batch-selection" class="draft-list"></ol>
<form id="private-batch-form"><label class="check-line important-check"><input id="private-batch-confirm" type="checkbox" required><span>I approve one combined, unmerged review for this exact ordered selection. Each photo keeps its own consent and safety checks. Nothing publishes automatically.</span></label>
<button class="button button-primary" type="submit">Request combined review job</button></form>
<button id="private-batches-refresh" class="button button-secondary" type="button">Refresh saved batches</button><div id="private-batches" class="draft-list" role="status" aria-live="polite"></div></section>
<form id="private-delete-form"><h3>Separate terminal original removal</h3><label class="form-field">Reason<select id="private-delete-reason"><option value="owner-delete">Owner requests original deletion</option><option value="consent-withdrawal">Private retention consent withdrawn</option></select></label>
<label class="check-line important-check"><input id="private-delete-confirm" type="checkbox" required><span>I request irreversible original deletion, not reversible hiding. Public removal must finish first. This does not authorize metadata purge.</span></label><button class="button button-secondary" type="submit">Request terminal original removal</button></form>
<p>Rerun the original GitHub run to recover an active job. Its lock never expires automatically. Before merging, recheck this publication run; keep its lock until that same run confirms the merge or safely cancels it. No real-photo operation is approved by this local preparation.</p></section></main>
<script src="/gallery-podium-framing.js?site=${site}" defer></script><script src="/private-face-editor.js?site=${site}" defer></script><script src="/private-gallery.js" defer></script></body></html>`;
}

export function privateGalleryScript() {
    return String.raw`(() => {
    'use strict';
    const site = new URLSearchParams(location.search).get('site');
    const status = document.getElementById('private-status');
    let csrf, revision, catalog, busy = false, personRequest, assetRequest, attemptRequest, jobRequest, batchRequest, activeAssetId, privatePeople = [];
    // Selection is private to this page instance: no cross-owner/tab/area
    // browser storage and no copied consent, filenames or face information.
    const batchSelection = [];
    const batchPublicationRequests = new Map();
    const choices = document.getElementById('private-tag-choices');
    const framing = window.privateGalleryFaceFraming?.create({site,api,getContext:()=>({assetId:activeAssetId,people:privatePeople,busy})});
    document.getElementById('private-photo').addEventListener('change',event=>{ void framing?.selectFile(event.target.files[0]); });
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
        framing?.refreshControls();
        try { await callback(); } catch (error) {
            note(error.message);
            if (activeAssetId) document.getElementById('private-asset-status').textContent = 'Eligibility unavailable. Do not publish from an earlier result.';
        }
        finally { busy = false; controls.forEach(button => {if(!button.closest('#private-framing-panel')) button.disabled = false;}); framing?.refreshControls(); }
    }
    async function refresh() {
        const roster = await api('/api/browser/private-preferences');
        revision = roster.revision;
        privatePeople = roster.people;
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
    async function refreshJobs() {
        if (!activeAssetId) throw new Error('Save or open a private photo first.');
        const response = await api('/api/browser/private-assets/' + activeAssetId + '/archive-jobs');
        const select = document.getElementById('private-job-attempt'), selected = select.value;
        select.replaceChildren();
        const empty = document.createElement('option'); empty.value = ''; empty.textContent = 'Select a saved attempt'; select.append(empty);
        for (const attempt of response.attempts) if (!attempt.closed) {
            const option = document.createElement('option'); option.value = attempt.attemptId; option.textContent = attempt.attemptId; select.append(option);
        }
        select.value = selected;
        const list = document.getElementById('private-jobs'); list.replaceChildren();
        for (const job of response.jobs) {
            const card = document.createElement('div'); card.className = 'draft-card';
            const title = document.createElement('strong'); title.textContent = job.action + ' — ' + job.state;
            const id = document.createElement('span'); id.textContent = 'Workflow job ID: ' + job.jobId;
            const link = document.createElement('a'); link.textContent = job.runReference ? 'Open the original run to resume' : 'Open the protected workflow; enter this job ID';
            link.href = job.runReference || 'https://github.com/johnkevan88888/family-running/actions/workflows/' +
                (job.action.startsWith('purge') ? 'gallery-archive-purge.yml' : 'gallery-archive-job.yml');
            link.target = '_blank'; link.rel = 'noopener noreferrer'; card.append(title,id,link);
            if (job.result?.proofHash) { const proof = document.createElement('span'); proof.textContent = 'Checked purge proof: ' + job.result.proofHash; card.append(proof); }
            if (job.result?.reviewUrl) {const review = document.createElement('a'); review.textContent = 'Open the unmerged review'; review.href = job.result.reviewUrl; review.rel = 'noopener noreferrer'; card.append(review);}
            list.append(card);
        }
    }
    function renderBatchSelection() {
        const list = document.getElementById('private-batch-selection'); list.replaceChildren();
        document.getElementById('private-batch-selection-status').textContent = batchSelection.length + ' of 20 photos selected. Each consent attempt will be rechecked.';
        for (const [index,member] of batchSelection.entries()) {
            const row = document.createElement('li'); row.className = 'draft-card';
            const asset = document.createElement('strong'); asset.textContent = 'Photo ' + (index + 1) + ': ' + member.assetId;
            const attempt = document.createElement('span'); attempt.textContent = 'Saved consent: ' + member.attemptId;
            row.append(asset,attempt);
            for (const [label,move] of [['Move earlier',-1],['Move later',1],['Remove from selection',0]]) {
                if (move && (index + move < 0 || index + move >= batchSelection.length)) continue;
                const button = document.createElement('button'); button.type = 'button'; button.className = 'button button-secondary'; button.textContent = label;
                button.addEventListener('click',()=>action(async()=>{
                    if (move) [batchSelection[index],batchSelection[index + move]] = [batchSelection[index + move],batchSelection[index]];
                    else batchSelection.splice(index,1);
                    batchRequest = null; document.getElementById('private-batch-confirm').checked = false;
                    renderBatchSelection(); note('Unsubmitted selection changed. Saved photos, tags and consent were not changed.');
                }));
                row.append(button);
            }
            list.append(row);
        }
    }
    async function refreshBatches() {
        const result = await api('/api/browser/private-batches');
        const list = document.getElementById('private-batches'); list.replaceChildren();
        for (const job of result.batches) {
            const card = document.createElement('div'); card.className = 'draft-card';
            const title = document.createElement('strong'); title.textContent = 'Combined review — ' + (job.reviewUrl && job.state === 'running' ? 'review recorded; protected claim retained' : job.state);
            const id = document.createElement('span'); id.textContent = 'Workflow job ID: ' + job.jobId;
            const count = document.createElement('span'); count.textContent = job.attemptIds.length + ' photo(s) in this saved batch; processing and review checks remain required.';
            const link = document.createElement('a'); link.textContent = job.runReference ? 'Open the original run to resume' : 'Open the protected workflow; enter this job ID';
            link.href = job.runReference || 'https://github.com/johnkevan88888/family-running/actions/workflows/gallery-archive-job.yml';
            link.target = '_blank'; link.rel = 'noopener noreferrer'; card.append(title,id,count,link);
            if (job.reviewUrl || job.result?.reviewUrl) {
                const review = document.createElement('a'); review.textContent = 'Open the recorded combined review'; review.href = job.reviewUrl || job.result.reviewUrl;
                review.target = '_blank'; review.rel = 'noopener noreferrer'; card.append(review);
            }
            if (job.reviewUrl && job.state === 'running') {
                if (job.publicationRequested) {
                    const saved = document.createElement('p');
                    saved.textContent = 'Publication preparation requested for this exact review. Resume the original protected run before a separate owner merge; no merge has been performed here.';
                    card.append(saved);
                } else {
                    const label = document.createElement('label'); label.className = 'check-line important-check';
                    const confirmed = document.createElement('input'); confirmed.type = 'checkbox';
                    const text = document.createElement('span');
                    text.textContent = 'I approve preparing this exact batch for a separate owner merge. Every photo must still pass its own consent and safety checks. Nothing publishes automatically.';
                    label.append(confirmed,text);
                    const prepare = document.createElement('button'); prepare.type = 'button'; prepare.className = 'button button-secondary';
                    prepare.textContent = 'Prepare batch for separate owner merge';
                    prepare.addEventListener('click',()=>action(async()=>{
                        if (!confirmed.checked) throw new Error('Confirm preparation of this exact saved review first.');
                        if (!batchPublicationRequests.has(job.jobId)) batchPublicationRequests.set(job.jobId,uuid());
                        await api('/api/browser/private-batches/' + job.jobId + '/publication',{idempotencyKey:batchPublicationRequests.get(job.jobId)});
                        await refreshBatches();
                        note('Exact batch publication preparation request saved. Resume the original protected run for fresh checks. This does not merge or publish the review.');
                    }));
                    card.append(label,prepare);
                }
            }
            list.append(card);
        }
    }
    document.getElementById('private-batch-add').addEventListener('click',()=>action(async()=>{
        const attemptId = document.getElementById('private-job-attempt').value;
        if (!activeAssetId || !attemptId) throw new Error('Open a saved photo and select its saved consent attempt first.');
        if (batchSelection.length >= 20) throw new Error('A combined review accepts at most 20 photos.');
        if (batchSelection.some(member=>member.assetId === activeAssetId || member.attemptId === attemptId)) throw new Error('This photo is already selected. Remove it first to change its consent attempt.');
        const current = await api('/api/browser/private-assets/' + activeAssetId + '/archive-jobs');
        if (!current.attempts.some(attempt=>attempt.attemptId === attemptId && !attempt.closed)) throw new Error('This saved attempt is unavailable. Refresh the photo before continuing.');
        batchSelection.push({assetId:activeAssetId,attemptId}); batchRequest = null;
        document.getElementById('private-batch-confirm').checked = false; renderBatchSelection();
        note('Saved attempt selected for the batch. Consent is not extended and no processing has run.');
    }));
    document.getElementById('private-batch-form').addEventListener('submit',event=>{
        event.preventDefault(); action(async()=>{
            if (!document.getElementById('private-batch-confirm').checked || batchSelection.length < 1 || batchSelection.length > 20) throw new Error('Select 1 to 20 photos and confirm this exact combined review.');
            const attemptIds = batchSelection.map(member=>member.attemptId), fingerprint = JSON.stringify(attemptIds);
            if (!batchRequest || batchRequest.fingerprint !== fingerprint) batchRequest = {fingerprint,key:uuid()};
            await api('/api/browser/private-batches',{attemptIds,idempotencyKey:batchRequest.key});
            await refreshBatches();
            batchSelection.splice(0); batchRequest = null; document.getElementById('private-batch-confirm').checked = false; renderBatchSelection();
            note('Combined review job saved. Open its protected workflow and enter its job ID. It stops at one unmerged PR; nothing has run or published yet.');
        });
    });
    document.getElementById('private-batches-refresh').addEventListener('click',()=>action(refreshBatches));
    document.getElementById('private-open-form').addEventListener('submit',event=>{
        event.preventDefault(); action(async()=>{
            const id = document.getElementById('private-open-id').value.trim();
            await api('/api/browser/private-assets/' + id);
            activeAssetId = id; jobRequest = null; await framing?.setAsset(); await refreshEligibility(); await refreshJobs(); note('Saved private photo opened. No media or permission changed.');
        });
    });
    document.getElementById('private-jobs-refresh').addEventListener('click',()=>action(refreshJobs));
    document.getElementById('private-delete-form').addEventListener('submit',event=>{
        event.preventDefault(); action(async()=>{
            if (!activeAssetId || !document.getElementById('private-delete-confirm').checked) throw new Error('Open the exact photo and confirm terminal deletion.');
            try {await api('/api/browser/private-assets/' + activeAssetId + '/archive-deletion',{reason:document.getElementById('private-delete-reason').value});}
            catch { /* The terminal block may have committed before cleanup became pending. */ }
            const current = await api('/api/browser/private-assets/' + activeAssetId + '/archive-intake');
            if (!['deletion-pending','private-original-deleted'].includes(current.state)) throw new Error('Terminal request not confirmed. Refresh before retrying.');
            document.getElementById('private-delete-confirm').checked = false;
            await refreshJobs(); note(current.state === 'deletion-pending' ? 'Terminal block saved. Request a removal job to finish public removal before original deletion.' : 'Private original deletion confirmed. Metadata purge is a separate checked action.');
        });
    });
    document.getElementById('private-job-form').addEventListener('submit',event=>{
        event.preventDefault(); action(async()=>{
            if (!activeAssetId || !document.getElementById('private-job-confirm').checked) throw new Error('Open the exact photo and confirm this action.');
            const requested = document.getElementById('private-job-action').value;
            const data = {action:requested};
            if (['review','publication'].includes(requested)) data.attemptId = document.getElementById('private-job-attempt').value;
            if (requested === 'purge') data.expectedProofHash = document.getElementById('private-purge-proof').value.trim();
            const fingerprint = JSON.stringify([activeAssetId,data]);
            if (!jobRequest || jobRequest.fingerprint !== fingerprint) jobRequest = {fingerprint,key:uuid(),purgeKey:requested === 'purge' ? uuid() : null};
            await api('/api/browser/private-assets/' + activeAssetId + '/archive-jobs',{...data,idempotencyKey:jobRequest.key,
                ...(requested === 'purge' ? {purgeKey:jobRequest.purgeKey} : {})});
            await refreshJobs(); document.getElementById('private-job-confirm').checked = false; jobRequest = null;
            note('Protected job requested. Open its workflow and approve the protected environment. Nothing has run or published yet.');
        });
    });
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
            await framing?.setAsset();
            await refreshEligibility();
            await refreshJobs(); note('Complete private tags retained. Intake and protected-job preparation are available locally. Nothing published.');
        });
    });
    document.getElementById('private-upload-form').addEventListener('submit',event=>{
        event.preventDefault(); action(async()=>{
            if (!activeAssetId) throw new Error('Save complete private tags first.');
            const file = document.getElementById('private-photo').files[0];
            const format = document.getElementById('private-format').value;
            const expectedType = format === 'jpg' ? 'image/jpeg' : 'image/png';
            const extension = file?.name.split('.').pop().toLowerCase();
            if (!file || file.size < 1 || file.size > 26214400 || file.type !== expectedType ||
                !(format === 'jpg' ? ['jpg','jpeg'].includes(extension) : extension === 'png')) throw new Error('Choose a matching JPEG or PNG up to 25 MiB.');
            const containsMinors = document.getElementById('private-upload-minors').checked;
            const guardianApprovalConfirmed = document.getElementById('private-upload-guardian').checked;
            if (containsMinors !== guardianApprovalConfirmed) throw new Error('Check the matching minor and guardian retention answers.');
            const bytes = await file.arrayBuffer();
            const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
            const current = await api('/api/browser/private-assets/' + activeAssetId + '/archive-intake');
            const admission = await api('/api/browser/private-assets/' + activeAssetId + '/archive-intake',{byteCount:file.size,sha256,
                declaredMimeType:expectedType,rosterRevision:revision,tagVersion:current.tagVersion,
                privateRetentionConfirmed:document.getElementById('private-retention').checked,containsMinors,guardianApprovalConfirmed});
            const response = admission.state === 'quarantined' ? {ok:true} : await fetch('/api/browser/private-assets/' + activeAssetId + '/archive-original?site=' + site,{
                method:'PUT',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/octet-stream','X-CSRF-Token':csrf},body:bytes});
            if (!response.ok) throw new Error('Upload stopped. Keep this asset and retry; do not reserve another original.');
            const checked = await api('/api/browser/private-assets/' + activeAssetId + '/archive-intake');
            if (checked.state !== 'quarantined') throw new Error('Original receipt unavailable. Refresh before continuing.');
            document.getElementById('private-upload-form').reset();
            await framing?.retained();
            document.getElementById('private-upload-status').textContent = 'Original retained privately. This is not decoding, stripping or public-use approval.';
            note('Private original verified. Nothing published.');
        });
    });
    document.getElementById('private-consent-form').addEventListener('submit',event=>{
        event.preventDefault(); action(async()=>{
            if (!activeAssetId) throw new Error('Save complete private tags first.');
            const current = await api('/api/browser/private-assets/' + activeAssetId + '/archive-intake');
            const eligibility = await api('/api/browser/private-assets/' + activeAssetId + '/eligibility');
            const framingVersion = await framing?.beforeConsent();
            const data = {tagVersion:current.tagVersion,eligibilityRevision:eligibility.revision,sourceRevision:catalog.sourceRevision,
                ...(Number.isSafeInteger(framingVersion) ? {framingVersion} : {}),
                suppressionRevision:catalog.suppressionRevision,raceIndex:Number(document.getElementById('private-race').value),
                completeTagsConfirmed:document.getElementById('private-complete-tags').checked,
                publicUseConfirmed:document.getElementById('private-public-use').checked,
                containsMinors:document.getElementById('private-public-minors').checked,
                guardianApprovalConfirmed:document.getElementById('private-public-guardian').checked};
            if (!attemptRequest || JSON.stringify(attemptRequest.data) !== JSON.stringify(data)) attemptRequest = {key:uuid(),data};
            const result = await api('/api/browser/private-assets/' + activeAssetId + '/archive-attempt',{idempotencyKey:attemptRequest.key,...data});
            document.getElementById('private-review-status').textContent = 'Saved ' + result.attemptId + '. Request its protected review job below. No review or publication completed.';
            await refreshJobs(); document.getElementById('private-job-attempt').value = result.attemptId;
            document.getElementById('private-consent-form').reset(); attemptRequest = null;
            note('Fresh public-use consent saved separately. Nothing published.');
        });
    });
    action(async()=>{
        if (!['family','everyone'].includes(site) || location.search !== '?site=' + site) throw new Error('Invalid inherited area.');
        csrf = (await api('/api/browser/session')).csrfToken;
        catalog = await api('/api/browser/catalog');
        const races = document.getElementById('private-race');
        catalog.sites[site].races.forEach((race,index)=>{
            const option = document.createElement('option'); option.value = String(index);
            option.textContent = race.raceDate + ' — ' + race.raceEvent + ' — ' + race.raceDistance; races.append(option);
        });
        const select = document.getElementById('private-person-public');
        for (const person of catalog.sites[site].roster) {
            const option = document.createElement('option'); option.value = person.athleteId; option.textContent = person.participant; select.append(option);
        }
        await refresh(); note('Protected intake, consent and owner job preparation ready. Workflows require separate owner approval; nothing publishes automatically.');
    });
})();`;
}
