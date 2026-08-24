(function () {
    const filterTypes = [
        ['all', 'All moments'],
        ['photo', 'Photos'],
        ['video', 'Videos']
    ];
    let galleryItems = [];
    let activeFilter = 'all';
    let previouslyFocusedElement = null;

    function selectedSite() {
        return window.siteNavigation?.selectedSite?.() || 'family';
    }

    async function initializeGallery() {
        const grid = document.getElementById('gallery-grid');
        const highlights = document.querySelectorAll('[data-gallery-highlights]');
        if (!grid && !highlights.length) {
            return;
        }

        wireViewer();

        try {
            const [galleryResponse, suppressionResponse] = await Promise.all([
                fetch(`gallery-data/${selectedSite()}.json`, { cache: 'no-store' }),
                fetch('gallery-data/hidden-athlete-ids.json', { cache: 'no-store' })
            ]);
            if (!galleryResponse.ok || !suppressionResponse.ok) {
                throw new Error('Gallery data request failed.');
            }

            const [data, suppressionData] = await Promise.all([
                galleryResponse.json(),
                suppressionResponse.json()
            ]);
            const contract = window.galleryContract;
            const problems = contract
                ? [
                    ...contract.validateGalleryDocument(data),
                    ...contract.validateGallerySuppressionDocument(suppressionData)
                ]
                : [
                'Gallery contract is unavailable.'
                ];

            if (problems.length) {
                throw new Error('Gallery data did not match its contract.');
            }

            galleryItems = contract.filterSuppressedGalleryItems(data.items, suppressionData);
            if (grid) {
                renderGallery();
            }
            renderHighlights();
            decorateAthletePhotos(document);
        } catch {
            if (grid) {
                renderStatus(
                    'The gallery is temporarily unavailable. Championship results and records are unaffected.',
                    'error'
                );
            }
        }
    }

    function renderGallery() {
        if (!galleryItems.length) {
            renderStatus(
                'The gallery is ready for its first approved race moment. Photographs and videos will appear here after they have been reviewed for publication.',
                'empty'
            );
            return;
        }

        renderFilters();
        renderFilteredItems();
    }

    function renderFilters() {
        const filters = document.getElementById('gallery-filters');
        if (!filters) {
            return;
        }

        filters.replaceChildren();
        filters.hidden = false;

        for (const [type, label] of filterTypes) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'gallery-filter';
            button.dataset.galleryFilter = type;
            button.setAttribute('aria-pressed', String(type === activeFilter));
            button.textContent = label;
            button.addEventListener('click', () => {
                activeFilter = type;
                filters.querySelectorAll('[data-gallery-filter]').forEach(candidate => {
                    candidate.setAttribute(
                        'aria-pressed',
                        String(candidate.dataset.galleryFilter === activeFilter)
                    );
                });
                renderFilteredItems();
            });
            filters.append(button);
        }
    }

    function renderFilteredItems() {
        const grid = document.getElementById('gallery-grid');
        if (!grid) {
            return;
        }
        const items = activeFilter === 'all'
            ? galleryItems
            : galleryItems.filter(item => item.type === activeFilter);

        document.getElementById('gallery-status')?.setAttribute('hidden', '');
        grid.replaceChildren(...items.map(createGalleryCard));
    }

    function createGalleryCard(item) {
        const article = document.createElement('article');
        article.className = 'gallery-card';
        article.dataset.galleryType = item.type;
        article.id = `moment-${item.id}`;

        const opener = document.createElement('button');
        opener.type = 'button';
        opener.className = 'gallery-card-open';
        opener.setAttribute('aria-label', `Open ${item.type}: ${item.title}`);
        opener.addEventListener('click', () => openViewer(item, opener));

        const image = document.createElement('img');
        image.className = 'gallery-card-image';
        image.src = item.thumbnailUrl;
        image.alt = item.alt;
        image.loading = 'lazy';
        image.decoding = 'async';
        image.referrerPolicy = 'no-referrer';

        const type = document.createElement('span');
        type.className = `gallery-card-type ${item.type}`;
        type.textContent = item.type;

        opener.append(image, type);

        const copy = document.createElement('div');
        copy.className = 'gallery-card-copy';

        const event = document.createElement('p');
        event.className = 'gallery-card-event';
        event.textContent = item.raceEvent;

        const title = document.createElement('h3');
        title.className = 'gallery-card-title';
        title.textContent = item.title;

        copy.append(event, title);

        if (item.caption) {
            const caption = document.createElement('p');
            caption.className = 'gallery-card-caption';
            caption.textContent = item.caption;
            copy.append(caption);
        }

        const date = document.createElement('p');
        date.className = 'gallery-card-meta';
        const formattedDate = window.dateDisplay?.format?.(item.raceDate) || item.raceDate;
        date.textContent = `${formatRaceDistance(item.raceDistance)} · ${formattedDate}`;
        copy.append(date);

        article.append(opener, copy);
        return article;
    }

    function renderHighlights() {
        document.querySelectorAll('[data-gallery-highlights]').forEach(section => {
            const athleteId = section.hasAttribute('data-gallery-athlete')
                ? new URLSearchParams(window.location.search).get('id') || ''
                : '';
            const candidates = athleteId
                ? galleryItems.filter(item => item.athleteIds.includes(athleteId))
                : galleryItems.filter(item => item.featured);
            const requestedLimit = Number.parseInt(section.dataset.galleryLimit || '3', 10);
            const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
                ? requestedLimit
                : 3;
            const items = candidates.slice(0, limit);
            const grid = section.querySelector('[data-gallery-highlight-grid]');

            if (!grid || !items.length) {
                section.hidden = true;
                return;
            }

            grid.replaceChildren(...items.map(createHighlightCard));
            section.hidden = false;
        });
    }

    function decorateAthletePhotos(root = document) {
        root.querySelectorAll('[data-gallery-athlete-photo]').forEach(container => {
            const athleteId = String(container.dataset.galleryAthletePhoto || '').trim();
            const candidates = galleryItems.filter(item => item.athleteIds.includes(athleteId));
            const item = candidates.find(candidate => candidate.type === 'photo') || candidates[0];

            if (!item || container.dataset.galleryMediaId === item.id) {
                return;
            }

            const image = document.createElement('img');
            image.src = item.thumbnailUrl;
            image.alt = item.alt;
            image.loading = 'lazy';
            image.decoding = 'async';
            image.referrerPolicy = 'no-referrer';

            container.replaceChildren(image);
            container.removeAttribute('role');
            container.removeAttribute('aria-label');
            container.dataset.galleryMediaId = item.id;
            container.classList.add('has-gallery-media');
        });
    }

    function createHighlightCard(item) {
        const link = document.createElement('a');
        const galleryHref = window.siteNavigation?.pageHref?.('gallery') ||
            `gallery.html?site=${encodeURIComponent(selectedSite())}`;
        link.className = 'race-moment-card';
        link.href = `${galleryHref}#moment-${encodeURIComponent(item.id)}`;
        link.setAttribute('aria-label', `View ${item.title} in the Gallery`);

        const image = document.createElement('img');
        image.src = item.thumbnailUrl;
        image.alt = item.alt;
        image.loading = 'lazy';
        image.decoding = 'async';
        image.referrerPolicy = 'no-referrer';

        const overlay = document.createElement('span');
        overlay.className = 'race-moment-card-copy';

        const event = document.createElement('span');
        event.className = 'race-moment-card-event';
        event.textContent = item.raceEvent;

        const title = document.createElement('strong');
        title.textContent = item.title;

        const type = document.createElement('span');
        type.className = 'race-moment-card-type';
        type.textContent = item.type === 'video' ? '\u25B6 Video' : 'Photo';

        overlay.append(event, title, type);
        link.append(image, overlay);
        return link;
    }

    function renderStatus(message, kind) {
        const status = document.getElementById('gallery-status');
        const grid = document.getElementById('gallery-grid');
        const filters = document.getElementById('gallery-filters');

        if (status) {
            status.hidden = false;
            status.className = `gallery-status is-${kind}`;
            status.replaceChildren();

            const marker = document.createElement('span');
            marker.className = 'gallery-status-pulse';
            marker.setAttribute('aria-hidden', 'true');
            status.append(marker, document.createTextNode(message));
        }

        grid?.replaceChildren();
        if (filters) {
            filters.hidden = true;
        }
    }

    function wireViewer() {
        const viewer = document.getElementById('gallery-viewer');
        const close = viewer?.querySelector('.gallery-viewer-close');
        if (!viewer || !close) {
            return;
        }

        close.addEventListener('click', () => viewer.close());
        viewer.addEventListener('click', event => {
            if (event.target === viewer) {
                viewer.close();
            }
        });
        viewer.addEventListener('close', () => {
            const video = viewer.querySelector('video');
            video?.pause();
            previouslyFocusedElement?.focus();
            previouslyFocusedElement = null;
        });
    }

    function openViewer(item, opener) {
        const viewer = document.getElementById('gallery-viewer');
        const title = document.getElementById('gallery-viewer-title');
        const media = document.getElementById('gallery-viewer-media');
        const copy = document.getElementById('gallery-viewer-copy');
        if (!viewer || !title || !media || !copy) {
            return;
        }

        previouslyFocusedElement = opener;
        title.textContent = item.title;
        media.replaceChildren(createViewerMedia(item));
        copy.replaceChildren();

        if (item.caption) {
            const caption = document.createElement('p');
            caption.textContent = item.caption;
            copy.append(caption);
        }

        const meta = document.createElement('p');
        const date = window.dateDisplay?.format?.(item.raceDate) || item.raceDate;
        meta.textContent = `${formatRaceLabel(item)} · ${date}`;
        copy.append(meta);

        if (typeof viewer.showModal === 'function') {
            viewer.showModal();
        } else {
            window.open(item.sourceUrl, '_blank', 'noopener,noreferrer');
        }
    }

    function createViewerMedia(item) {
        if (item.type === 'video') {
            const video = document.createElement('video');
            video.src = item.sourceUrl;
            video.poster = item.thumbnailUrl;
            video.controls = true;
            video.preload = 'metadata';
            video.setAttribute('aria-label', item.alt);
            video.setAttribute('referrerpolicy', 'no-referrer');
            return video;
        }

        const image = document.createElement('img');
        image.src = item.sourceUrl;
        image.alt = item.alt;
        image.decoding = 'async';
        image.referrerPolicy = 'no-referrer';
        return image;
    }

    function formatRaceLabel(item) {
        return `${item.raceEvent} · ${formatRaceDistance(item.raceDistance)}`;
    }

    function formatRaceDistance(value) {
        return value === 'H. Mar' ? 'Half Marathon' : value;
    }

    window.galleryPresentation = Object.freeze({ decorateAthletePhotos });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeGallery, { once: true });
    } else {
        initializeGallery();
    }
})();
