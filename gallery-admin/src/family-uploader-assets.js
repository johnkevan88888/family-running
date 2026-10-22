import {privateFaceEditorPanel} from './private-gallery-face-assets.js';

export function familyUploaderDocument() {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>Add Family photos</title>
<link rel="stylesheet" href="/admin.css"><link rel="stylesheet" href="/private-face-editor.css?site=family"><link rel="stylesheet" href="/family-uploader.css?site=family"></head>
<body><header class="admin-header"><div><h1>Add Family photos</h1><p>Your photos, ready together for one review.</p></div><span class="protected-badge">Family · Owner access</span></header>
<main class="admin-main"><p id="family-status" class="app-status" role="status" aria-live="polite">Opening your Family library…</p>
<nav aria-label="Upload steps"><ol class="family-steps"><li><a href="#family-choose">1 Choose photos</a></li><li><a href="#family-details">2 Event and people</a></li><li><a href="#family-framing">3 Check thumbnails</a></li><li><a href="#family-review">4 Send for review</a></li></ol></nav>
<section class="admin-panel"><h2>Your saved batches</h2><div class="family-toolbar"><label class="form-field">Continue a batch<select id="family-drafts"><option value="">Choose a saved batch</option></select></label><button id="family-open" class="button button-secondary">Open batch</button><button id="family-new" class="button button-secondary">Start a new batch</button></div><p>Saved details survive signing in again. To adjust a retained photo after reopening, choose its matching local file; originals are never downloaded into this page.</p></section>
<section class="admin-panel" id="family-permission-panel"><h2>Family permission</h2><p id="family-permission-status"></p>
<div id="family-permission-setup"><p>Set this once: the people in your Family library permit private storage and website use until permission is withdrawn for an athlete or photo. Existing opt-outs still take priority. Sending a batch never publishes it.</p>
<label class="check-line"><input id="family-guardian-permission" type="checkbox"><span>This standing permission also includes guardian permission for children pictured.</span></label>
<button id="family-permission-save" class="button button-primary">Use standing Family permission</button></div></section>
<section class="admin-panel" id="family-choose"><h2>1 Choose photos</h2><p>Choose up to 20 JPEG or PNG photos, each up to 25 MiB. Photos stay on this device until you choose to save them privately.</p>
<label class="form-field">Add photos<input id="family-files" type="file" accept="image/jpeg,image/png" multiple></label>
<p id="family-count" role="status">No photos yet.</p><div id="family-cards" class="family-cards"></div></section>
<section class="admin-panel" id="family-details" hidden><h2>2 Event and people</h2><p id="family-selected"></p>
<label class="form-field">Find the event<input id="family-event-search" type="search" placeholder="Event, date or distance"></label>
<label class="form-field">Event<select id="family-event"><option value="">Choose the event</option></select></label>
<label class="form-field">Find a runner or other person<input id="family-athlete-search" type="search" placeholder="Type a name"></label>
<h3>Runners at this event</h3><p id="family-runners-note">Choose an event to see its runners. Each runner keeps their own distance.</p>
<div id="family-athletes" class="athlete-choices"></div><details id="family-other-people"><summary>Other people pictured</summary><div id="family-private-people" class="athlete-choices"></div><p>Tag supporters or anyone else pictured here, without assigning a race result. Private and excluded people remain available; opt-outs still block website use. Use the advanced library to add a new private-only person.</p></details>
<label class="form-field">Does this photo include anyone under 18?<select id="family-minors"><option value="">Choose an answer</option><option value="no">No</option><option value="yes">Yes</option></select></label>
<p>Include every person pictured. The face detector suggests framing; it does not identify people.</p>
<div class="family-toolbar"><button id="family-apply-details" class="button button-secondary">Use this event and people on other unsaved photos</button><button id="family-save-details" class="button button-secondary">Save details</button><button id="family-retain" class="button button-primary">Save photo privately and check thumbnails</button></div>
<p id="family-detail-note" role="status"></p>
<label class="form-field" id="family-reselect-label" hidden>Choose the matching local file to continue<input id="private-photo" type="file" accept="image/jpeg,image/png"></label></section>
<div id="family-framing" hidden>${privateFaceEditorPanel('family')}<p class="family-toolbar"><button id="family-next" class="button button-primary">Next photo</button><a href="#family-review">Check the batch and send for review</a></p></div>
<section class="admin-panel" id="family-review"><h2>4 Review your batch</h2><p id="family-ready">Finish each photo's event, people and thumbnail check first.</p><p><a href="#family-cards">Check the photos, people and events in this batch</a></p>
<p>Sending this batch confirms that the tags include everyone pictured. Each photo is checked against current permission and opt-outs. Review images are not listed on the website yet, but their review URLs are not private.</p>
<button id="family-submit" class="button button-primary" disabled>Send batch for review</button><button id="family-progress" class="button button-secondary">Check progress</button><div id="family-review-status" role="status" aria-live="polite"></div></section>
<details class="admin-panel"><summary>Privacy and advanced recovery</summary><p>These switches stop new public use. They do not delete originals or confirm removal of existing public copies; use the owner removal process and check its completed result.</p><button id="family-photo-hide" class="button button-secondary">Keep the selected photo off the website</button><button id="family-photo-allow" class="button button-secondary">Allow this photo for a fresh review</button><button id="family-permission-stop" class="button button-secondary">Stop standing website permission</button><p>For an athlete opt-out, restoration, original deletion or completed public removal:</p><a href="/private-gallery?site=family">Open advanced Family library</a></details>
</main><script src="/gallery-podium-framing.js?site=family" defer></script><script src="/private-face-editor.js?site=family" defer></script><script src="/family-uploader.js?site=family" defer></script></body></html>`;
}
export function familyUploaderStyles() {
    return `.family-steps{display:flex;flex-wrap:wrap;gap:10px 24px;list-style:none;padding:0;font-weight:700}.family-toolbar{display:flex;flex-wrap:wrap;align-items:end;gap:12px}.family-toolbar .form-field{flex:1;min-width:200px}.family-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:16px}.family-photo-card{border:2px solid #c7d5e3;border-radius:12px;padding:12px;min-width:0;background:#f7fafc}.family-photo-card[data-active=true]{border-color:#2467a5}.family-photo-card canvas{width:100%;height:150px;object-fit:contain;background:#e6edf3;border-radius:6px}.family-photo-card strong,.family-photo-card small{display:block;margin:8px 0;overflow-wrap:anywhere}.family-photo-card button{margin:4px 5px 0 0}.family-steps li{padding:6px 0}.family-cards:empty{display:none}#family-details[hidden],#family-framing[hidden]{display:none}#family-framing .important-check{display:none}#family-people-note{color:#234}.family-photo-card[data-ready=true]{border-color:#3c7651}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid #e98c16;outline-offset:3px}@media(max-width:520px){.family-cards{grid-template-columns:1fr 1fr;gap:8px}.family-photo-card{padding:8px}.family-photo-card canvas{height:110px}.family-toolbar button{width:100%}.family-steps{font-size:.9rem;gap:6px 12px}}`;
}
export function familyUploaderScript() {return `(${familyUploaderBrowser.toString()})();`;}

function familyUploaderBrowser() {
    'use strict';
    const $=id=>document.getElementById(id),site='family',files=new Map(),previews=new Map(),athleteKeys=new Map();
    let csrf,catalog,permission,people=[],draft=null,selected=null,busy=false,pendingSave=null,newKey=null,permissionKey=null,detailsDirty=false;
    const uuid=()=>crypto.randomUUID();
    const note=text=>{$('family-status').textContent=text;};
    const active=()=>draft?.photos.find(photo=>photo.photoId===selected);
    const framing=window.privateGalleryFaceFraming.create({site,api,getContext:()=>({assetId:active()?.assetId,people,busy}),
        suggestSingleFace:true,confirmOnSave:true,onSaved:async()=>{await reloadDraft();render();note('Thumbnail views saved. Choose the next photo, or send the ready batch.');}});
    $('private-framing-save').textContent='Use these thumbnail views';
    $('private-framing-panel').querySelector('h2').textContent='3 Check thumbnails';
    $('private-framing-panel').querySelector('p').textContent='Check the desktop and mobile views. With one person and one detected face, a framing is suggested automatically. For groups, select the person and the correct face, then adjust if needed.';
    $('private-framing-workspace').lastElementChild.textContent='Only your checked position and zoom are saved with this photo. You can always adjust a missed face manually. Nothing is published automatically.';
    async function api(path,body,method) {
        const response=await fetch(path+'?site=family',{method:method||(body?'POST':'GET'),credentials:'same-origin',cache:'no-store',
            headers:body?{'Content-Type':'application/json','X-CSRF-Token':csrf}:{},body:body?JSON.stringify(body):undefined});
        let result;try{result=await response.json();}catch{throw new Error('The saved state could not be checked. Your local choices have been kept.');}
        if(!response.ok) {
            const message=response.status===403?'Sign in again, then open this saved batch. Local-only files will need to be selected again.':
                result.error==='family-duplicate-photo'?'That photo is already in this batch.':
                result.error==='family-runner-distance-needed'?'Choose a distance for each selected runner before saving the photo privately.':
                response.status===409?'This photo, permission or saved batch changed. Check the saved batch before continuing; no duplicate was submitted.':
                response.status===422?'Check the event, people and file details for this photo.':'The save could not be confirmed. Retry the same action; your local choices have been kept.';
            throw new Error(message);
        }
        return result;
    }
    async function action(callback) {
        if(busy)return;busy=true;setBusy();
        try{await callback();}catch(error){note(error.message);}finally{busy=false;if(catalog)render();else setBusy();}
    }
    function setBusy() {
        for(const control of document.querySelectorAll('button,input,select')) if(!control.closest('#private-framing-panel')) control.disabled=busy;
        if(active()?.reserved || draft?.state!=='editing') {
            for(const control of document.querySelectorAll('#family-athletes input,#family-athletes select,#family-private-people input,#family-event,#family-minors')) control.disabled=true;
        }
        $('family-submit').disabled=busy||!permission?.active||!draft||!['editing','submitting'].includes(draft.state)||detailsDirty||!draft.photos.length||draft.photos.some(p=>!p.retained||!p.framingVersion||p.deleted||p.preference==='hidden'||p.peopleBlocked);
        $('family-photo-hide').disabled=busy||!active()?.assetId||active()?.preference==='hidden';
        $('family-photo-allow').disabled=busy||!permission?.active||active()?.preference!=='hidden';
        $('family-permission-stop').disabled=busy||!permission?.active;
        $('family-next').disabled=busy||!draft?.photos.some(p=>p.photoId!==selected&&!p.framingVersion);
        framing.refreshControls();
    }
    async function refreshPeople() {people=(await api('/api/browser/private-preferences')).people;}
    async function refreshList() {
        const data=await api('/api/browser/family-drafts');$('family-drafts').replaceChildren(new Option('Choose a saved batch',''));
        for(const [index,item] of data.drafts.entries()) $('family-drafts').add(new Option(`${item.count} photo(s) · ${item.state==='editing'?'Draft':'Sent for review'} · ${item.createdAt.slice(0,10)} · ${index+1}`,item.id));
        if(draft)$('family-drafts').value=draft.id;
    }
    async function reloadDraft() {if(draft)draft=(await api('/api/browser/family-drafts/'+draft.id)).draft;}
    async function ensureDraft() {
        if(draft)return;
        newKey ||= uuid();draft=(await api('/api/browser/family-drafts',{idempotencyKey:newKey})).draft;newKey=null;await refreshList();
    }
    function plainPhoto(photo) {return {photoId:photo.photoId,originalFormat:photo.originalFormat,byteCount:photo.byteCount,
        sha256:photo.sha256,personIds:photo.personIds,raceIndex:photo.raceIndex,containsMinors:photo.containsMinors,
        sourceRevision:photo.sourceRevision??catalog.sourceRevision,
        ...(Object.hasOwn(photo,'runnerResults')?{runnerResults:photo.runnerResults}:{})};}
    async function saveDetails() {
        await ensureDraft();
        const photos=draft.photos.map(plainPhoto),fingerprint=JSON.stringify([draft.id,draft.version,photos]);
        if(!pendingSave||pendingSave.fingerprint!==fingerprint)pendingSave={fingerprint,input:{expectedVersion:draft.version,idempotencyKey:uuid(),photos}};
        const saved=await api('/api/browser/family-drafts/'+draft.id,pendingSave.input);
        draft=saved.draft;pendingSave=null;detailsDirty=false;await refreshList();render();
    }
    function events() {
        const photo=active(),choice=photo?.sourceRevision&&photo.sourceRevision!==catalog.sourceRevision?null:photo?.raceIndex,search=$('family-event-search').value.trim().toLowerCase();
        $('family-event').replaceChildren(new Option('Choose the event',''));
        const groups=new Map();
        catalog.sites.family.races.forEach((race,index)=>{
            const key=JSON.stringify([race.raceDate,race.raceEvent]);
            if(!groups.has(key))groups.set(key,{race,indices:[],distances:[]});
            groups.get(key).indices.push(index);groups.get(key).distances.push(race.raceDistance);
        });
        groups.forEach(({race,indices,distances})=>{
            const label=[race.raceDate,race.raceEvent,distances.join(' / ')].join(' · ');
            const index=indices.includes(choice)?choice:indices[0];
            if(!search||label.toLowerCase().includes(search)||indices.includes(choice))$('family-event').add(new Option(label,String(index)));
        });$('family-event').value=choice==null?'':String(choice);
    }
    function runnerChoices(athleteId,photo=active()) {
        if(photo?.sourceRevision&&photo.sourceRevision!==catalog.sourceRevision)return [];
        const race=catalog.sites.family.races[photo?.raceIndex];
        if(!race)return [];
        return catalog.sites.family.races.map((r,index)=>({race:r,index})).filter(({race:r})=>
            r.raceDate===race.raceDate && r.raceEvent===race.raceEvent && catalog.sites.family.results.some(result=>
                result.athleteId===athleteId && result.raceDate===r.raceDate && result.raceEvent===r.raceEvent && result.raceDistance===r.raceDistance));
    }
    function runnerResults(photo=active()) {
        if(Object.hasOwn(photo,'runnerResults'))return photo.runnerResults;
        // Display a legacy card without rewriting its saved bytes. Convert only
        // when the owner explicitly edits its people or event before retention.
        return photo.personIds.flatMap(personId=>{
            const person=people.find(p=>p.personId===personId);
            return runnerChoices(person?.publicAthleteId,photo).some(r=>r.index===photo.raceIndex)?[{personId,raceIndex:photo.raceIndex}]:[];
        });
    }
    function personOption(person,label,parent,athleteId,choices=null) {
        const line=document.createElement('label');line.className='athlete-option';
        const runner=person&&runnerResults().find(result=>result.personId===person.personId);
        const check=document.createElement('input');check.type='checkbox';check.checked=Boolean(person&&active()?.personIds.includes(person.personId)&&(choices?runner:!runner));
        check.disabled=busy||Boolean(active()?.reserved)||draft?.state!=='editing';
        const text=document.createElement('span');text.textContent=label+(choices?.length===1?' — '+choices[0].race.raceDistance:'')+(person?.preference==='hidden'?' — kept off website':'');line.append(check,text);parent.append(line);
        if(choices?.length>1&&runner){
            const field=document.createElement('label');field.className='form-field';field.textContent='Distance for '+label;
            const select=document.createElement('select');select.setAttribute('aria-label','Distance for '+label);select.add(new Option('Choose their distance',''));
            for(const choice of choices)select.add(new Option(choice.race.raceDistance,String(choice.index)));
            select.value=runner?.raceIndex==null?'':String(runner.raceIndex);select.disabled=busy||Boolean(active()?.reserved)||!runner;
            select.addEventListener('change',()=>action(async()=>{
                const photo=active();photo.runnerResults=runnerResults().map(result=>result.personId===person.personId?
                    {...result,raceIndex:select.value===''?null:Number(select.value)}:result);
                detailsDirty=true;await saveDetails();note('Runner distance saved.');
            }));field.append(select);parent.append(field);
        }
        check.addEventListener('change',()=>action(async()=>{
            let match=person;
            if(check.checked&&!match) {
                if(!permission?.active)throw new Error('Set the Family permission once before selecting athletes.');
                if(!athleteKeys.has(athleteId))athleteKeys.set(athleteId,uuid());
                match=await api('/api/browser/family-athletes',{athleteId,idempotencyKey:athleteKeys.get(athleteId),permissionVersion:permission.version});
                await refreshPeople();
            }
            if(!match)return;
            const photo=active();photo.runnerResults=runnerResults().filter(result=>result.personId!==match.personId);
            if(check.checked&&choices)photo.runnerResults.push({personId:match.personId,raceIndex:choices.length===1?choices[0].index:null});
            photo.personIds=check.checked?[...new Set([...photo.personIds,match.personId])]:photo.personIds.filter(id=>id!==match.personId);
            detailsDirty=true;await saveDetails();note('People saved with this photo. Include everyone pictured.');
        }));
    }
    function renderPeople() {
        $('family-athletes').replaceChildren();$('family-private-people').replaceChildren();
        const search=$('family-athlete-search').value.toLowerCase();
        $('family-runners-note').textContent=active()?.raceIndex==null?'Choose an event to see its runners.':'Only athletes with an exported result at this event and date appear below. Choose a distance if more than one is listed.';
        for(const athlete of catalog.sites.family.roster) if(athlete.participant.toLowerCase().includes(search)) {
            const person=people.find(p=>p.publicAthleteId===athlete.athleteId),choices=runnerChoices(athlete.athleteId);
            if(choices.length)personOption(person,athlete.participant,$('family-athletes'),athlete.athleteId,choices);
            personOption(person,athlete.participant,$('family-private-people'),athlete.athleteId);
        }
        // A private tag must not disappear merely because its public athlete
        // was excluded from today's export. Existing opt-outs still block review.
        for(const person of people.filter(p=>!catalog.sites.family.roster.some(a=>a.athleteId===p.publicAthleteId) && p.displayName.toLowerCase().includes(search)))personOption(person,person.displayName,$('family-private-people'));
    }
    function render() {
        $('family-cards').replaceChildren();const photos=draft?.photos||[];
        $('family-count').textContent=photos.length?`${photos.length} of 20 photos in this batch`:'No photos yet.';
        for(const [index,photo] of photos.entries()) {
            const card=document.createElement('article');card.className='family-photo-card';card.dataset.active=String(photo.photoId===selected);card.dataset.ready=String(Boolean(photo.framingVersion&&!photo.deleted&&!photo.peopleBlocked&&photo.preference!=='hidden'));
            const canvas=document.createElement('canvas');canvas.width=240;canvas.height=160;canvas.setAttribute('role','img');canvas.setAttribute('aria-label',`Photo ${index+1} preview`);
            const preview=previews.get(photo.photoId);if(preview){const ratio=Math.min(canvas.width/preview.width,canvas.height/preview.height);canvas.getContext('2d').drawImage(preview,(240-preview.width*ratio)/2,(160-preview.height*ratio)/2,preview.width*ratio,preview.height*ratio);}
            const title=document.createElement('strong');title.textContent=`Photo ${index+1}`;
            const names=document.createElement('small');names.textContent=photo.personIds.map(id=>{
                const name=people.find(p=>p.personId===id)?.displayName||'Saved person',result=runnerResults(photo).find(r=>r.personId===id);
                return name+' — '+(result?(photo.sourceRevision&&photo.sourceRevision!==catalog.sourceRevision?'saved distance — recheck catalogue':catalog.sites.family.races[result.raceIndex]?.raceDistance||'choose distance'):'other person');
            }).join(', ')||'Choose the people';
            const race=document.createElement('small');race.textContent=photo.race?[photo.race.raceDate,photo.race.raceEvent].join(' · '):'Choose the event';
            const state=document.createElement('small');state.textContent=photo.deleted?'Blocked — original removal requested':photo.preference==='hidden'||photo.peopleBlocked?'Private only — a photo or athlete opt-out applies':photo.framingVersion?'Thumbnail views saved':photo.retained?'Saved privately — check thumbnails':files.has(photo.photoId)?'Only on this device — details saved':'Details saved — choose the local file';
            const edit=document.createElement('button');edit.className='button button-secondary';edit.textContent='Check photo '+(index+1);edit.addEventListener('click',()=>action(()=>openPhoto(photo.photoId)));
            card.append(canvas,title,names,race,state,edit);
            if(!photo.reserved&&draft.state==='editing') {const remove=document.createElement('button');remove.className='button button-secondary';remove.textContent='Remove';remove.addEventListener('click',()=>action(async()=>{
                draft.photos=draft.photos.filter(p=>p.photoId!==photo.photoId);files.delete(photo.photoId);previews.delete(photo.photoId);if(selected===photo.photoId){selected=null;framing.clear();}
                detailsDirty=true;await saveDetails();note('Removed from this draft. No stored original was deleted.');}));card.append(remove);}
            $('family-cards').append(card);
        }
        const photo=active();$('family-details').hidden=!photo;$('family-reselect-label').hidden=!photo||files.has(photo.photoId);
        if(photo){$('family-selected').textContent='Photo '+(photos.indexOf(photo)+1);events();renderPeople();$('family-minors').value=photo.containsMinors==null?'':photo.containsMinors?'yes':'no';
            $('family-detail-note').textContent=photo.sourceRevision&&photo.sourceRevision!==catalog.sourceRevision?'The results catalogue changed. Saved details are kept; reselect the event and runners for an unsaved photo. Retained photos need the advanced recovery route.':photo.reserved?'These saved source and people details are fixed. Advanced corrections preserve the original history.':'Details are saved automatically; saving the original is a separate action.';}
        const ready=photos.filter(p=>p.retained&&p.framingVersion&&!p.deleted&&p.preference!=='hidden'&&!p.peopleBlocked).length;
        $('family-ready').textContent=`${ready} of ${photos.length} photos ready. Nothing is published automatically.`;
        $('family-submit').textContent=draft?.state==='submitting'?'Resume this review request':`Send ${photos.length||''} photo${photos.length===1?'':'s'} for review`;setBusy();
    }
    async function openPhoto(id) {
        if(framing.hasUnsavedChanges())throw new Error('Save the current thumbnail views before switching photos.');
        if(detailsDirty)await saveDetails();selected=id;framing.clear();render();
        const photo=active();$('family-framing').hidden=!photo?.assetId;
        if(photo?.assetId){await framing.setAsset();if(files.has(id)){await framing.selectFile(files.get(id));
            if(photo.retained)$('private-framing-status').textContent='Original saved privately. Check the suggested framing in both thumbnail views, then save your choice.';}}
        if(photo?.retained)note('Original already saved privately. Check the thumbnail views, then continue.');
        (photo?.retained?$('family-framing'):$('family-details')).scrollIntoView({block:'start'});
    }
    async function rememberFile(photoId,file,info) {
        const mime=info.originalFormat==='jpg'?'image/jpeg':'image/png';
        files.set(photoId,file.type===mime?file:new File([file],'photo.'+info.originalFormat,{type:mime}));
        const scale=Math.min(1,240/Math.max(info.width,info.height));
        let expired=false,timer;
        const decode=createImageBitmap(file,{imageOrientation:'from-image',resizeWidth:Math.max(1,Math.round(info.width*scale)),resizeHeight:Math.max(1,Math.round(info.height*scale))})
            .then(value=>{if(expired){value.close();throw new Error('Preview timed out.');}return value;});
        let image;
        try{image=await Promise.race([decode,new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(new Error('Preview timed out. Try a smaller photo.'));},5000);})]);}
        finally{clearTimeout(timer);}
        const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;canvas.getContext('2d').drawImage(image,0,0);image.close();previews.set(photoId,canvas);
    }
    $('family-files').addEventListener('change',event=>action(async()=>{
        await ensureDraft();if(draft.state!=='editing')throw new Error('Start a new batch to add more photos.');
        const errors=[];
        for(const file of event.target.files){
            try{if(draft.photos.length>=20)throw new Error('A batch can contain up to 20 photos.');
                const info=await window.privateGalleryFaceFraming.inspectFile(file);
                if(draft.photos.some(p=>p.sha256===info.sha256))throw new Error('A duplicate photo was skipped.');
                const photoId=uuid();await rememberFile(photoId,file,info);
                draft.photos.push({photoId,originalFormat:info.originalFormat,byteCount:info.byteCount,sha256:info.sha256,personIds:[],raceIndex:null,containsMinors:null,runnerResults:[]});
                selected ||= photoId;detailsDirty=true;
            }catch(error){errors.push(error.message);}
        }
        await saveDetails();event.target.value='';note(errors.length?errors.join(' ')+' Valid selections were kept.':'Photo details saved. Choose the event and people next; image files are still only on this device.');
    }));
    $('family-event-search').addEventListener('input',events);$('family-athlete-search').addEventListener('input',renderPeople);
    for(const id of ['family-event','family-minors'])$(id).addEventListener('change',()=>action(async()=>{
        if(active()?.reserved)throw new Error('This photo is already retained. Use the advanced correction route to change its saved details.');
        const photo=active(),raceIndex=$('family-event').value===''?null:Number($('family-event').value),changed=photo.raceIndex!==raceIndex||Boolean(photo.sourceRevision&&photo.sourceRevision!==catalog.sourceRevision);
        if(changed)photo.runnerResults=[]; // Keep every person tag; never carry a result into another event.
        if(id==='family-event')photo.sourceRevision=catalog.sourceRevision;
        photo.raceIndex=raceIndex;photo.containsMinors=$('family-minors').value===''?null:$('family-minors').value==='yes';
        detailsDirty=true;await saveDetails();note('Photo details saved.');
        if(changed&&photo.personIds.length){$('family-other-people').open=true;note('Event saved. Existing people are kept under Other people pictured. Tick the runners for this event to assign their distances.');}
    }));
    $('family-save-details').addEventListener('click',()=>action(async()=>{await saveDetails();note('Photo details saved.');}));
    $('family-apply-details').addEventListener('click',()=>action(async()=>{
        const source=active();if(!source)throw new Error('Choose a photo first.');
        for(const photo of draft.photos)if(!photo.reserved){photo.personIds=[...source.personIds];photo.raceIndex=source.raceIndex;photo.runnerResults=runnerResults(source).map(result=>({...result}));photo.sourceRevision=source.sourceRevision??catalog.sourceRevision;}
        detailsDirty=true;await saveDetails();note('Event and people copied to unsaved photos. Check each picture and its under-18 answer.');
    }));
    $('family-retain').addEventListener('click',()=>action(async()=>{
        if(!active())throw new Error('Choose a photo first.');if(detailsDirty)await saveDetails();
        if(!permission?.active)throw new Error('Set the Family permission once before saving photos.');
        const photo=active(),file=files.get(photo.photoId);if(!file&&!photo.retained)throw new Error('Choose the matching local file first.');
        note('Checking people and saving this photo privately…');
        draft=(await api('/api/browser/family-drafts/'+draft.id+'/prepare',{photoId:photo.photoId,permissionVersion:permission.version})).draft;
        if(!active().retained){
            const response=await fetch('/api/browser/private-assets/'+active().assetId+'/archive-original?site=family',{
                method:'PUT',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/octet-stream','X-CSRF-Token':csrf},body:file});
            if(!response.ok)throw new Error('The upload could not be confirmed. Retry this same photo; a retained original will not be uploaded twice.');
        }
        await reloadDraft();render();await openPhoto(selected);note('Saved privately. Check the desktop and mobile thumbnails below, then choose “Use these thumbnail views”.');
    }));
    $('private-photo').addEventListener('change',event=>action(async()=>{
        const file=event.target.files[0],info=await window.privateGalleryFaceFraming.inspectFile(file),photo=active();
        if(!photo||photo.sha256!==info.sha256||photo.byteCount!==info.byteCount)throw new Error('This is not the matching saved photo. Nothing was changed.');
        await rememberFile(photo.photoId,file,info);await openPhoto(photo.photoId);note('Matching local photo selected. The original was not downloaded or uploaded again.');
    }));
    $('family-permission-save').addEventListener('click',()=>action(async()=>{
        permissionKey ||= uuid();permission=await api('/api/browser/family-permission',{expectedVersion:permission.version,idempotencyKey:permissionKey,active:true,guardians:$('family-guardian-permission').checked});
        permissionKey=null;renderPermission();note('Standing Family permission saved. Athlete and photo opt-outs still take priority.');
    }));
    function renderPermission(){ $('family-permission-status').textContent=permission.active?'Standing permission is active until withdrawn. No repeated consent form is needed.':'Set your Family permission once before retaining or reviewing photos.';$('family-permission-setup').hidden=permission.active;}
    function leaveBatch(){
        if(framing.hasUnsavedChanges())throw new Error('Save the current thumbnail views before leaving this batch.');
        if(draft?.photos.some(p=>files.has(p.photoId)&&!p.retained)&&!window.confirm('Your details are saved, but some photos are still only on this device. You will need to choose those files again. Leave this batch?'))return false;
        files.clear();previews.clear();return true;
    }
    $('family-new').addEventListener('click',()=>action(async()=>{if(detailsDirty)await saveDetails();if(!leaveBatch())return;draft=null;selected=null;framing.clear();$('family-review-status').replaceChildren();$('family-framing').hidden=true;await ensureDraft();render();note('New saved Family batch ready. Choose photos.');}));
    $('family-open').addEventListener('click',()=>action(async()=>{
        const id=$('family-drafts').value;if(!id)throw new Error('Choose a saved batch first.');if(detailsDirty)await saveDetails();
        if(!leaveBatch())return;
        draft=(await api('/api/browser/family-drafts/'+id)).draft;selected=draft.photos[0]?.photoId??null;framing.clear();$('family-review-status').replaceChildren();$('family-framing').hidden=true;
        await refreshPeople();render();note('Saved batch opened. Local files are needed only for uploads or thumbnail adjustments, not to send already-checked photos.');
    }));
    async function progress(){
        if(!draft)throw new Error('Open a saved batch first.');
        const result=await api('/api/browser/family-drafts/'+draft.id+'/progress'),job=result.job;
        let message='This batch is still a draft.',history=false;
        if(job){
            if(job.state==='removed'){message='Review closed and checked removal recorded. Originals remain private unless separately deleted.';history=true;}
            else if(job.state==='publication-observed'){message='Separate owner publication has been recorded. Live website verification remains a separate check.';history=true;}
            else if(!['queued','running'].includes(job.state)){message='This review needs owner attention. Check its saved processing record before taking another action.';history=true;}
            else if(job.reviewUrl)message='Review ready — not published.';
            else if(job.runReference)message='Preparing the combined review. Nothing is published.';
            else if(['unknown','admitted'].includes(result.dispatchState))message='Checking whether processing started. Do not submit a replacement; the saved request is preserved.';
            else if(result.dispatchState==='owner-start-required')message='Batch saved. Automatic processing is not configured; the owner can start the existing protected review job from the advanced library.';
            else message='Review requested. Waiting for the owner’s protected processing approval.';
        }
        $('family-review-status').replaceChildren();const text=document.createElement('p');
        text.textContent=message+' Last checked '+new Date().toLocaleTimeString()+'.';$('family-review-status').append(text);
        if(job&&result.dispatchState==='acknowledged'&&!job.reviewUrl&&!history){const approval=document.createElement('a');approval.textContent='Open owner processing approvals';approval.href='https://github.com/johnkevan88888/family-running/actions/workflows/gallery-archive-job.yml';approval.rel='noopener noreferrer';$('family-review-status').append(approval);}
        if(job?.reviewUrl){const link=document.createElement('a');link.textContent=history?'Open review history':'Open the combined review';link.href=job.reviewUrl;link.rel='noopener noreferrer';$('family-review-status').append(link);}
    }
    $('family-progress').addEventListener('click',()=>action(progress));
    $('family-next').addEventListener('click',()=>action(async()=>{
        const next=draft?.photos.find(p=>p.photoId!==selected&&!p.framingVersion);if(next)await openPhoto(next.photoId);
    }));
    $('family-photo-hide').addEventListener('click',()=>action(async()=>{
        const photo=active();if(!photo?.assetId)throw new Error('Save the photo privately first.');
        await api('/api/browser/family-photo-permission',{assetId:photo.assetId,expectedVersion:photo.preferenceVersion,idempotencyKey:uuid(),preference:'hidden'});
        await reloadDraft();render();note('New public use is blocked for this photo. If review or public copies exist, complete the removal process in the advanced library; removal has not been verified here.');
    }));
    $('family-permission-stop').addEventListener('click',()=>action(async()=>{
        permission=await api('/api/browser/family-permission',{expectedVersion:permission.version,idempotencyKey:uuid(),active:false,guardians:false});
        renderPermission();note('Standing permission stopped. Pending reviews based on it cannot proceed. Existing public copies need the checked removal process; originals are retained, not purged.');
    }));
    $('family-photo-allow').addEventListener('click',()=>action(async()=>{
        const photo=active();if(!photo?.assetId||!permission?.active)throw new Error('Current Family permission is required.');
        await api('/api/browser/family-photo-permission',{assetId:photo.assetId,expectedVersion:photo.preferenceVersion,idempotencyKey:uuid(),preference:'allowed'});
        await reloadDraft();render();note('The photo exception is lifted for a fresh review. Old reviews and retired URLs stay closed. Finish any earlier removal, then use advanced recovery for a new review; nothing has been republished.');
    }));
    $('family-submit').addEventListener('click',()=>action(async()=>{
        if(detailsDirty)await saveDetails();if(active()?.assetId&&files.has(selected))await framing.beforeConsent();note('Checking every photo and preparing one review request…');
        draft=(await api('/api/browser/family-drafts/'+draft.id+'/submit',{expectedVersion:draft.version,permissionVersion:permission.version,completeTagsConfirmed:true})).draft;
        await refreshList();render();await progress();note('Batch saved for one combined review. No photo has been published.');
    }));
    window.addEventListener('beforeunload',event=>{if(detailsDirty||framing.hasUnsavedChanges()||draft?.photos.some(p=>files.has(p.photoId)&&!p.retained)){event.preventDefault();event.returnValue='';}});
    void action(async()=>{csrf=(await api('/api/browser/session')).csrfToken;catalog=await api('/api/browser/catalog');permission=await api('/api/browser/family-permission');await refreshPeople();await refreshList();renderPermission();render();note('Family library ready. Choose photos or continue a saved batch.');});
}
