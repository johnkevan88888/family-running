import { picoSource, cascadeBase64, detectorLicense } from '../generated/private-face-detector.js';

export function privateFaceWorkerScript() {
    return `/*\n${detectorLicense.replaceAll('*/','* /')}\n*/\nconst module = {exports:{}};\n${picoSource}\n(${detectionWorker.toString()})(${JSON.stringify(cascadeBase64)});`;
}

function detectionWorker(cascade) {
    'use strict';
    const bytes = Uint8Array.from(atob(cascade), character => character.charCodeAt(0));
    const classify = pico.unpack_cascade(bytes);
    self.onmessage = event => {
        try {
            const { id, width, height, pixels } = event.data || {};
            if (!Number.isSafeInteger(id) || !Number.isInteger(width) || !Number.isInteger(height)
                || width < 1 || height < 1 || width > 1024 || height > 1024 || !(pixels instanceof Uint8ClampedArray)
                || pixels.length !== width * height * 4) throw new Error('Invalid bounded image');
            const gray = new Uint8Array(width * height);
            for (let index = 0; index < gray.length; index += 1) {
                const offset = index * 4;
                gray[index] = Math.round((pixels[offset] * 2 + pixels[offset + 1] * 7 + pixels[offset + 2]) / 10);
            }
            const detections = pico.run_cascade({ pixels: gray, nrows: height, ncols: width, ldim: width }, classify,
                { shiftfactor: 0.1, minsize: 28, maxsize: Math.min(width, height), scalefactor: 1.1 });
            const clusters = pico.cluster_detections(detections, 0.2);
            const faces = clusters.filter(face => face[3] > 5).sort((a, b) => b[3] - a[3]).slice(0, 32).map(face => ({
                x: face[1] / width * 100, y: face[0] / height * 100,
                width: face[2] / width * 100, height: face[2] / height * 100
            }));
            self.postMessage({ id, faces });
        } catch { self.postMessage({ id: event.data?.id, error: true, faces: [] }); }
    };
}

export function privateFaceEditorPanel(site) {
    return `<section class="admin-panel" id="private-framing-panel"><h2>Championship face framing</h2>
<p>When you choose a local photo above, this browser looks for possible faces. It does not identify anybody or change tags or consent. Assign a suggested face to a saved person, or click the picture and adjust it yourself.</p>
<p id="private-framing-status" role="status" aria-live="polite">Choose the matching local JPEG or PNG to preview. Reopening a saved photo does not read its protected original.</p>
<div id="private-framing-workspace" hidden><label class="form-field">Saved pictured person<select id="private-framing-person"></select></label>
<p id="private-face-detection" role="status" aria-live="polite"></p><div id="private-face-candidates" class="face-candidates"></div>
<div class="private-framing-grid"><div class="private-framing-source"><canvas id="private-framing-image" role="img" aria-label="Local photo: click the face of the selected person"></canvas><span id="private-framing-marker" hidden aria-hidden="true"></span></div>
<div><div class="private-framing-previews"><figure><div class="private-framing-preview private-framing-desktop"><canvas aria-label="Desktop championship preview"></canvas></div><figcaption>Desktop shape</figcaption></figure><figure><div class="private-framing-preview private-framing-mobile"><canvas aria-label="Mobile championship preview"></canvas></div><figcaption>Mobile shape</figcaption></figure></div>
<label class="form-field">Horizontal position <output id="private-framing-x-value">50%</output><input id="private-framing-x" type="range" min="0" max="100" step="0.1" value="50"></label>
<label class="form-field">Vertical position <output id="private-framing-y-value">50%</output><input id="private-framing-y" type="range" min="0" max="100" step="0.1" value="50"></label>
<label class="form-field">Zoom <output id="private-framing-zoom-value">2×</output><input id="private-framing-zoom" type="range" min="1" max="8" step="0.05" value="2"></label>
<button class="button button-secondary" id="private-framing-reset" type="button">Use whole photo for this person</button></div></div>
<label class="check-line important-check"><input id="private-framing-confirm" type="checkbox"><span>I checked each chosen person’s framing. These settings do not confirm complete tags, public-use consent or publication.</span></label>
<button class="button button-primary" id="private-framing-save" type="button" disabled>Save checked framing privately</button>
<p>Save the original privately first. Only checked position and zoom numbers are retained; detected face boxes and image pixels are not saved. A failure or missed face leaves manual adjustment available. <strong>Nothing publishes automatically.</strong></p></div></section>`;
}

export function privateFaceEditorStylesheet() {
    return `.private-framing-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:20px;align-items:start}.private-framing-source{position:relative;line-height:0;max-width:100%;justify-self:start}.private-framing-source>canvas{display:block;width:auto;max-width:100%;height:auto;max-height:60vh;cursor:crosshair}.private-framing-source>span{position:absolute;width:26px;height:26px;border:3px solid white;box-shadow:0 0 0 2px #123;border-radius:50%;transform:translate(-50%,-50%);pointer-events:none}.private-framing-previews{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:15px}.private-framing-previews figure{margin:0 0 10px;max-width:100%}.private-framing-previews figcaption{font-size:.8rem;margin-top:4px}.private-framing-preview{overflow:hidden;background:#183d5b}.private-framing-desktop{width:240px;max-width:100%;aspect-ratio:300/230}.private-framing-mobile{width:100px;height:103px}.private-framing-preview canvas{display:block;width:100%;height:100%}.face-candidates{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}.private-framing-grid input[type=range]{width:100%}@media(max-width:740px){.private-framing-grid{grid-template-columns:minmax(0,1fr)}}`;
}

export function privateFaceEditorScript() {
    return `(${faceEditorBrowser.toString()})();`;
}

function faceEditorBrowser() {
    'use strict';
    // No identity model, camera, upload, public URL, third-party fetch or storage.
    window.privateGalleryFaceFraming = Object.freeze({ create });
    function create({ site, api, getContext }) {
        const byId = id => document.getElementById(id);
        const panel = byId('private-framing-panel');
        const workspace = byId('private-framing-workspace');
        const canvas = byId('private-framing-image');
        const person = byId('private-framing-person');
        const confirm = byId('private-framing-confirm');
        const save = byId('private-framing-save');
        const marker = byId('private-framing-marker');
        const status = byId('private-framing-status');
        const detectionStatus = byId('private-face-detection');
        const candidates = byId('private-face-candidates');
        const controls = Object.fromEntries(['x', 'y', 'zoom'].map(key => [key, byId(`private-framing-${key}`)]));
        let selection = 0, worker, workerTimer, bitmap, originalWidth, originalHeight, localSha, activeAsset;
        let current, frames = {}, frame = null, dirty = false, saving = false, pendingSave, people = [], detectedFaces = [], localChoiceUnsafe=false;
        const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
        function note(text) { status.textContent = text; }
        function stopWorker() { clearTimeout(workerTimer); if (worker) worker.terminate(); worker = null; }
        function clearLocal() {
            selection += 1; stopWorker(); bitmap?.close(); bitmap = null; localSha = null;
            canvas.width = canvas.height = 1; workspace.hidden = true; candidates.replaceChildren();
            confirm.checked = false; frames = {}; frame = null; dirty = false; pendingSave = null; detectedFaces = []; localChoiceUnsafe=false; updateSave();
        }
        function controlsBusy() {return saving || getContext().busy===true;}
        function canSave() {return !controlsBusy() && Boolean(bitmap && current && current.sourceSha256===localSha && confirm.checked && dirty && !localChoiceUnsafe);}
        function updateSave() {
            save.disabled=!canSave();
            const disabled=controlsBusy() || !bitmap || !people.length;
            person.disabled=disabled;confirm.disabled=disabled;
            for(const control of Object.values(controls)) control.disabled=disabled;
            byId('private-framing-reset').disabled=disabled;
            for(const button of candidates.querySelectorAll('button')) button.disabled=disabled;
        }
        async function refreshAsset(clear = false) {
            const context = getContext();
            if (clear || activeAsset !== context.assetId) clearLocal();
            activeAsset = context.assetId;
            const requestSelection=selection;
            current = null;
            people = [];
            person.replaceChildren();
            if (!activeAsset) { note('Save complete private tags, then choose the local photo.'); return; }
            const selected = activeAsset;
            let assetResult;
            try {assetResult=await api('/api/browser/private-assets/'+selected);}
            catch(error) {if(selected!==activeAsset || requestSelection!==selection) return;throw error;}
            if (selected !== activeAsset || requestSelection!==selection) return;
            const asset = assetResult.asset;
            people = asset.personIds.map(id => ({ id, name: context.people.find(value => value.personId === id)?.displayName || 'Saved private person' }));
            for (const saved of people) { const option = document.createElement('option'); option.value = saved.id; option.textContent = saved.name; person.append(option); }
            let snapshot;
            try { snapshot = await api('/api/browser/private-assets/' + selected + '/framing'); }
            catch { if(selected===activeAsset && requestSelection===selection) note('Preview locally now; retain the matching original before saving checked framing.'); }
            if (selected !== activeAsset || requestSelection!==selection) return;
            current=snapshot || null;
            if (!dirty) frames = current?.frames ? structuredClone(current.frames) : {};
            choosePerson(); updateSave();
        }
        function choosePerson() {
            frame = frames[person.value] ? { ...frames[person.value] } : null;
            controls.x.value = frame?.x ?? 50; controls.y.value = frame?.y ?? 50; controls.zoom.value = frame?.zoom ?? 2;
            confirm.checked = false; render();updateSave();
        }
        function changed(next) {
            if (controlsBusy()) return;
            if (!person.value || !people.some(value => value.id === person.value)) return;
            frame = next;
            if (next) frames[person.value] = next; else delete frames[person.value];
            dirty = true; pendingSave = null; confirm.checked = false; render(); updateSave();
        }
        function render() {
            for (const [key, control] of Object.entries(controls)) byId(`private-framing-${key}-value`).textContent = Number(control.value) + (key === 'zoom' ? '×' : '%');
            marker.hidden = !frame;
            if (frame) {
                const imageBox=canvas.getBoundingClientRect(),parentBox=canvas.parentElement.getBoundingClientRect();
                marker.style.left=(imageBox.left-parentBox.left+imageBox.width*frame.x/100)+'px';
                marker.style.top=(imageBox.top-parentBox.top+imageBox.height*frame.y/100)+'px';
            }
            if (!bitmap || workspace.hidden) return;
            const original = canvas.getContext('2d');
            original.clearRect(0,0,canvas.width,canvas.height);original.drawImage(bitmap,0,0);
            original.strokeStyle='#ffd300';original.lineWidth=Math.max(2,canvas.width/250);original.font=`bold ${Math.max(16,canvas.width/32)}px system-ui`;
            detectedFaces.forEach((face,index)=>{
                const x=(face.x-face.width/2)/100*canvas.width,y=(face.y-face.height/2)/100*canvas.height;
                original.strokeRect(x,y,face.width/100*canvas.width,face.height/100*canvas.height);
                original.fillStyle='#18324c';original.fillRect(x,Math.max(0,y-30),36,30);original.fillStyle='#fff';original.fillText(String(index+1),x+6,Math.max(24,y-6));
            });
            for (const preview of panel.querySelectorAll('.private-framing-preview')) {
                const image = preview.querySelector('canvas');
                const box = preview.getBoundingClientRect();
                if (!box.width || !box.height) continue;
                image.width = Math.round(box.width); image.height = Math.round(box.height);
                const ctx = image.getContext('2d'); ctx.clearRect(0, 0, image.width, image.height);
                const geometry = window.galleryPodiumFraming.layout(frame, bitmap.width, bitmap.height, image.width, image.height);
                ctx.drawImage(bitmap, geometry.left, geometry.top, geometry.width, geometry.height);
            }
        }
        function detect(id) {
            stopWorker();
            detectionStatus.textContent = 'Looking for possible faces on this device…';
            try {
                worker = new Worker('/private-face-worker.js?site=' + site);
                workerTimer = setTimeout(() => {
                    if (id !== selection) return;
                    stopWorker(); detectionStatus.textContent = 'Automatic detection timed out. Click the face or use the position controls.';
                }, 5000);
                worker.onerror = () => {
                    if (id !== selection) return;
                    stopWorker(); detectionStatus.textContent = 'Automatic detection is unavailable. Click the face or adjust it manually.';
                };
                worker.onmessage = event => {
                    if (id !== selection || event.data?.id !== id) return;
                    stopWorker(); candidates.replaceChildren();
                    const faces = event.data.faces;
                    if (event.data.error || !Array.isArray(faces) || faces.length > 32) { detectionStatus.textContent = 'Automatic detection failed. Manual framing is still available.'; return; }
                    detectedFaces=[];
                    faces.forEach((face, index) => {
                        if (!['x','y','width','height'].every(key => typeof face[key] === 'number' && Number.isFinite(face[key]) && face[key] >= 0 && face[key] <= 100)) return;
                        detectedFaces.push(face);
                        const button = document.createElement('button'); button.type = 'button'; button.className = 'button button-secondary'; button.textContent = 'Suggested face ' + (index + 1);
                        button.addEventListener('click', () => {
                            if(controlsBusy()) return;
                            if (!person.value) { note('Choose a saved pictured person first. The detector does not identify people.'); return; }
                            const next = { x: Math.round(clamp(face.x,0,100)*10)/10, y: Math.round(clamp(face.y,0,100)*10)/10,
                                zoom: Math.round(clamp(65 / Math.max(1,face.width),1,8)*20)/20 };
                            for (const key of Object.keys(controls)) controls[key].value = next[key];
                            changed(next); note('Suggestion assigned only to the selected person. Adjust it and explicitly confirm before saving.');
                        }); candidates.append(button);
                    });
                    render();updateSave();
                    detectionStatus.textContent = candidates.childElementCount ? 'Possible faces found. Select a person, then the correct suggestion. Check every result yourself.' : 'No face was found. Click the face or use the position controls; detection never proves complete tags.';
                };
                const pixels = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0,0,canvas.width,canvas.height).data;
                worker.postMessage({id,width:canvas.width,height:canvas.height,pixels}, [pixels.buffer]);
            } catch { stopWorker(); detectionStatus.textContent = 'Automatic detection is unavailable. Click the face or adjust it manually.'; }
        }
        async function selectFile(file) {
            clearLocal();
            localChoiceUnsafe=true;
            const id = selection;
            try {
                if (!(file instanceof File) || !['image/jpeg','image/png'].includes(file.type) || file.size < 1 || file.size > 26214400) throw new Error('Choose a JPEG or PNG up to 25 MiB.');
                note('Decoding the local photo with its saved orientation…');
                const bytes = await file.arrayBuffer();
                const header = imageHeader(new Uint8Array(bytes));
                if (!header.width || !header.height || header.width * header.height > 50000000) throw new Error('The local image dimensions exceed the photo policy.');
                const width = header.orientation >= 5 ? header.height : header.width;
                const height = header.orientation >= 5 ? header.width : header.height;
                const scale = Math.min(1,1024 / Math.max(width,height));
                const decode = createImageBitmap(file, { imageOrientation:'from-image', resizeWidth:Math.max(1,Math.round(width*scale)), resizeHeight:Math.max(1,Math.round(height*scale)), resizeQuality:'high' });
                let timer, expired = false;
                decode.then(value => { if (expired || id !== selection) value.close(); }).catch(()=>{});
                const decoded = await Promise.race([decode, new Promise((_,reject) => { timer=setTimeout(()=>{expired=true;reject(new Error('Local image decoding timed out.'));},5000); })]).finally(()=>clearTimeout(timer));
                if (id !== selection) { decoded.close(); return; }
                const digest = await crypto.subtle.digest('SHA-256',bytes);
                if (id !== selection) { decoded.close(); return; }
                bitmap = decoded; localSha = Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');
                originalWidth = width; originalHeight = height;
                canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.getContext('2d').drawImage(bitmap,0,0);
                workspace.hidden = false;
                await refreshAsset();
                if (id !== selection) return;
                localChoiceUnsafe=!current || current.sourceSha256!==localSha;
                note(current && current.sourceSha256 !== localSha ? 'This local file does not match the saved original. Framing cannot be saved.' : 'Local preview ready. Suggested faces are not identities or consent. Retain the matching original before saving.');
                render(); detect(id); updateSave();
            } catch (error) { if (id === selection) { clearLocal(); localChoiceUnsafe=true; note(error.message + ' Upload and consent remain separate.'); } }
        }
        person.addEventListener('change', choosePerson);
        for (const control of Object.values(controls)) control.addEventListener('input', () => changed(Object.fromEntries(Object.entries(controls).map(([key,value]) => [key,Number(value.value)]))));
        canvas.addEventListener('click', event => {
            if (!bitmap || controlsBusy()) return;
            const box=canvas.getBoundingClientRect(); controls.x.value=Math.round(clamp((event.clientX-box.left)/box.width*100,0,100)*10)/10;
            controls.y.value=Math.round(clamp((event.clientY-box.top)/box.height*100,0,100)*10)/10;
            changed(Object.fromEntries(Object.entries(controls).map(([key,value])=>[key,Number(value.value)])));
        });
        byId('private-framing-reset').addEventListener('click',()=>changed(null));
        confirm.addEventListener('change',updateSave);
        save.addEventListener('click', async()=>{
            if (!canSave()) return;
            const selected = selection, selectedAsset = activeAsset;
            saving=true; updateSave();
            try {
                const input={expectedVersion:current.version,tagVersion:current.tagVersion,sourceSha256:localSha,orientation:'exif-transposed-v1',imageWidth:originalWidth,imageHeight:originalHeight,frames:structuredClone(frames),confirmed:true};
                const fingerprint=JSON.stringify(input);
                const samePending=pendingSave?.fingerprint===fingerprint;
                const before=await api('/api/browser/private-assets/'+selectedAsset+'/framing');
                if (selected!==selection || selectedAsset!==activeAsset) return;
                if (before.tagVersion!==input.tagVersion || before.sourceSha256!==localSha ||
                    (before.version!==input.expectedVersion && !(samePending && before.version===input.expectedVersion+1))) throw new Error('The saved photo or tags changed. Reload before saving.');
                // An explicit retry reuses the exact idempotency key/body after
                // an uncertain response. Only the server can confirm that write;
                // seeing a newer version is never treated as our own success.
                if (!samePending) pendingSave={fingerprint,key:crypto.randomUUID()};
                const result=await api('/api/browser/private-assets/'+selectedAsset+'/framing',{idempotencyKey:pendingSave.key,...input});
                if (selected!==selection || selectedAsset!==activeAsset) return;
                current=result;
                frames=structuredClone(current.frames); dirty=false; pendingSave=null; confirm.checked=false;
                note('Checked framing saved privately. Tags, consent, original photo and publication were not changed.');
            } catch (error) { if(selected===selection && selectedAsset===activeAsset) note(error.message+' No automatic save retry was attempted.'); }
            finally { saving=false; updateSave(); }
        });
        window.addEventListener('resize',render);
        return Object.freeze({
            selectFile,
            async setAsset() { const asset=getContext().assetId;byId('private-photo').value='';const pending=refreshAsset(true),id=selection;await pending;if(id===selection && asset===activeAsset) note('Saved photo metadata loaded. Select the matching local file to adjust framing; no original was read.'); },
            async retained() { const asset=getContext().assetId,id=selection;await refreshAsset();if(id!==selection || asset!==activeAsset) return;localChoiceUnsafe=Boolean(bitmap && (!current || current.sourceSha256!==localSha));note('Original retained. You may now check and save the matching local framing.'); updateSave(); },
            async beforeConsent() {
                if (dirty) throw new Error('Save or discard the unchecked framing before fresh public consent.');
                if(localChoiceUnsafe) throw new Error('The local selection is not verified against the retained original. Choose the matching file or reopen the exact saved photo before consent.');
                const context=getContext();
                const snapshot=await api('/api/browser/private-assets/'+context.assetId+'/framing');
                if (snapshot.stale) throw new Error('Tags changed. Select the matching file and check a new framing before consent.');
                return snapshot.version;
            },
            clear:clearLocal,
            refreshControls:updateSave
        });
    }
    function imageHeader(bytes) {
        const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
        function readOrientation(start,end) {
            if(start+8>end) return 1;
            const le=view.getUint16(start)===0x4949;
            if((!le && view.getUint16(start)!==0x4d4d) || view.getUint16(start+2,le)!==42) return 1;
            const ifd=start+view.getUint32(start+4,le);
            if(ifd<start || ifd+2>end) return 1;
            const count=view.getUint16(ifd,le);
            for(let index=0;index<count;index++) {const entry=ifd+2+index*12;if(entry+12>end) break;
                if(view.getUint16(entry,le)===274 && view.getUint16(entry+2,le)===3 && view.getUint32(entry+4,le)===1) {const value=view.getUint16(entry+8,le);if(value>=1&&value<=8) return value;}
            }
            return 1;
        }
        if (bytes.length>=24 && view.getUint32(0)===0x89504e47 && view.getUint32(4)===0x0d0a1a0a) {
            let orientation=1,offset=8;
            while(offset+12<=bytes.length) {
                const length=view.getUint32(offset),end=offset+8+length;
                if(end+4>bytes.length) throw new Error('Malformed PNG segment.');
                if(view.getUint32(offset+4)===0x65584966) orientation=readOrientation(offset+8,end);
                if(view.getUint32(offset+4)===0x49444154) break;
                offset=end+4;
            }
            return {width:view.getUint32(16),height:view.getUint32(20),orientation};
        }
        if (bytes.length<4 || bytes[0]!==255 || bytes[1]!==216) throw new Error('The local photo format could not be decoded.');
        let offset=2,width,height,orientation=1;
        while(offset+4<=bytes.length) {
            if(bytes[offset++]!==255) throw new Error('Malformed JPEG header.');
            while(bytes[offset]===255) offset++;
            const marker=bytes[offset++];
            if(marker===0xda || marker===0xd9) break;
            if(marker===1 || marker>=0xd0 && marker<=0xd7) continue;
            const length=view.getUint16(offset); if(length<2 || offset+length>bytes.length) throw new Error('Malformed JPEG segment.');
            if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {if(length<7) throw new Error('Malformed JPEG size.');height=view.getUint16(offset+3);width=view.getUint16(offset+5);}
            if(marker===0xe1 && length>=16 && view.getUint32(offset+2)===0x45786966 && view.getUint16(offset+6)===0) {
                orientation=readOrientation(offset+8,offset+length);
            }
            offset+=length;
        }
        return {width,height,orientation};
    }
}
