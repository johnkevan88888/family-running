(function () {
    'use strict';
    const token = new URLSearchParams(location.hash.slice(1)).get('token');
    const status = document.getElementById('status');
    const selector = document.getElementById('photo-person');
    const workspace = document.getElementById('workspace');
    const source = document.getElementById('full-photo');
    const marker = document.getElementById('focal-marker');
    const save = document.getElementById('save');
    const controls = { x: document.getElementById('position-x'), y: document.getElementById('position-y'), zoom: document.getElementById('zoom') };
    const previews = [...document.querySelectorAll('.preview')];
    let state;
    let pairs = [];
    let selectedIndex = -1;
    let frame = null;
    let dirty = false;
    let busy = false;

    function message(text, error = false) {
        status.textContent = text;
        status.dataset.error = String(error);
    }

    function canDiscard() {
        return !dirty || window.confirm('Discard the unsaved framing changes?');
    }

    async function request(route, body) {
        const response = await fetch(route, {
            method: body ? 'POST' : 'GET',
            cache: 'no-store',
            credentials: 'omit',
            redirect: 'error',
            headers: { 'x-gallery-framing-token': token || '', ...(body ? { 'content-type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {})
        });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || 'The local operation was refused.');
        return value;
    }

    function setBusy(value) {
        busy = value;
        selector.disabled = busy || !pairs.length;
        document.getElementById('refresh').disabled = busy;
        document.getElementById('reset').disabled = busy || !pairs.length;
        Object.values(controls).forEach(control => { control.disabled = busy || !pairs.length; });
        save.disabled = busy || !dirty || !source.naturalWidth;
    }

    function clearImages() {
        source.removeAttribute('src');
        previews.forEach(preview => preview.querySelector('img').removeAttribute('src'));
        workspace.hidden = true;
    }

    function selectPair(index) {
        selectedIndex = index;
        const pair = pairs[index];
        clearImages();
        dirty = false;
        frame = pair.athlete.frame ? { ...pair.athlete.frame } : null;
        controls.x.value = frame?.x ?? 50;
        controls.y.value = frame?.y ?? 50;
        controls.zoom.value = frame?.zoom ?? 2.5;
        document.getElementById('photo-caption').textContent = `${pair.photo.raceEvent} · ${pair.photo.raceDate} · Athlete ID: ${pair.athlete.id}`;
        source.alt = `${pair.photo.title} — choose the face of ${pair.athlete.id}`;
        workspace.hidden = false;
        // Only the already-public, validated manifest URL is ever loaded.
        source.src = pair.photo.sourceUrl;
        previews.forEach(preview => { preview.querySelector('img').src = pair.photo.sourceUrl; });
        render();
        setBusy(false);
    }

    function installState(value, preserve = null) {
        state = value;
        pairs = value.photos.flatMap(photo => photo.athletes.map(athlete => ({ photo, athlete })));
        selector.replaceChildren();
        if (!pairs.length) {
            selector.add(new Option('No eligible tagged public photos', ''));
            clearImages();
            selectedIndex = -1;
            dirty = false;
            setBusy(false);
            return;
        }
        pairs.forEach((pair, index) => selector.add(new Option(`${pair.photo.raceEvent} · ${pair.photo.raceDate} · ${pair.athlete.id} · ${pair.photo.id}`, String(index))));
        const found = preserve ? pairs.findIndex(pair => pair.photo.id === preserve.photo.id && pair.athlete.id === preserve.athlete.id) : 0;
        selector.value = String(found < 0 ? 0 : found);
        selectPair(Number(selector.value));
    }

    function render() {
        for (const [key, control] of Object.entries(controls)) {
            document.getElementById(`value-${key}`).textContent = `${Number(control.value)}${key === 'zoom' ? '×' : '%'}`;
        }
        marker.hidden = frame === null;
        if (frame) {
            marker.style.left = `${frame.x}%`;
            marker.style.top = `${frame.y}%`;
        }
        document.getElementById('mode-note').textContent = frame === null
            ? 'Whole photo: no manual framing. Click the face to start.'
            : `${dirty ? 'Unsaved' : 'Saved'} manual framing · position ${frame.x.toFixed(1)}%, ${frame.y.toFixed(1)}% · zoom ${frame.zoom.toFixed(2)}×`;
        if (!workspace.hidden && source.naturalWidth && source.naturalHeight) {
            previews.forEach(preview => {
                const box = preview.getBoundingClientRect();
                if (!(box.width > 0 && box.height > 0)) return;
                const geometry = window.galleryPodiumFraming.layout(frame, source.naturalWidth, source.naturalHeight, box.width, box.height);
                const image = preview.querySelector('img');
                Object.entries(geometry).forEach(([name, value]) => { image.style[name] = `${value}px`; });
            });
        }
        save.disabled = busy || !dirty || !source.naturalWidth;
    }

    async function load() {
        setBusy(true);
        clearImages();
        message('Checking Gallery, suppression and local framing files…');
        try {
            installState(await request('/state'));
            message(pairs.length ? `Ready: ${state.site} public photos. Changes stay local until a separately approved site release.` : 'No eligible tagged public photos. Suppressed photos and videos are never loaded.');
        } catch (error) {
            pairs = [];
            dirty = false;
            clearImages();
            message(`${error.message} No photo was loaded.`, true);
            setBusy(false);
        }
    }

    source.addEventListener('load', render);
    source.addEventListener('error', () => { message('The already-public photograph could not load. No framing can be saved until it loads.', true); save.disabled = true; });
    source.addEventListener('click', event => {
        if (busy || !source.naturalWidth) return;
        const box = source.getBoundingClientRect();
        const bounded = number => Math.round(Math.min(100, Math.max(0, number)) * 10) / 10;
        controls.x.value = bounded((event.clientX - box.left) / box.width * 100);
        controls.y.value = bounded((event.clientY - box.top) / box.height * 100);
        updateFrame();
    });
    function updateFrame() {
        frame = Object.fromEntries(Object.entries(controls).map(([key, control]) => [key, Number(control.value)]));
        dirty = true;
        render();
    }
    Object.values(controls).forEach(control => control.addEventListener('input', updateFrame));
    document.getElementById('reset').addEventListener('click', () => { frame = null; dirty = true; render(); });
    selector.addEventListener('change', () => {
        if (!canDiscard()) { selector.value = String(selectedIndex); return; }
        selectPair(Number(selector.value));
        message('Selected photo/person. Only that pair’s framing will change.');
    });
    document.getElementById('refresh').addEventListener('click', () => { if (canDiscard()) load(); });
    save.addEventListener('click', async () => {
        if (busy || !dirty || !pairs[selectedIndex]) return;
        const selected = pairs[selectedIndex];
        setBusy(true);
        message('Saving only the selected framing coordinates…');
        try {
            const next = await request('/save', { revision: state.revision, itemId: selected.photo.id, athleteId: selected.athlete.id, frame });
            dirty = false;
            installState(next, selected);
            message('Saved locally. No photo bytes, consent, tags or public site were changed.');
        } catch (error) {
            message(`${error.message} No automatic retry was attempted. Refresh local files before trying again.`, true);
            setBusy(false);
        }
    });
    window.addEventListener('resize', render);
    window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
    if (!token || !/^[a-f0-9]{64}$/.test(token) || !window.galleryPodiumFraming) {
        message('Use the complete local link printed by the framing command. No photo was loaded.', true);
        setBusy(true);
        return;
    }
    load();
})();
