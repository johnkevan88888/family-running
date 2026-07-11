(function () {
    const validSites = new Set(['family', 'everyone']);
    const pageFiles = {
        championships: 'index.html',
        'hall-of-fame': 'hall-of-fame.html',
        overview: 'overview.html'
    };
    const pageLabels = {
        championships: 'Championships',
        'hall-of-fame': 'Hall of Fame',
        overview: 'Overview'
    };

    function selectedSite() {
        const params = new URLSearchParams(window.location.search);
        const requestedSite = String(params.get('site') || '').toLowerCase();

        return validSites.has(requestedSite) ? requestedSite : 'family';
    }

    function currentPage() {
        const explicitPage = document.body?.dataset?.page;

        if (explicitPage) {
            return explicitPage;
        }

        const filename = window.location.pathname.split('/').pop() || 'index.html';

        if (filename === 'championships.html') return 'championships';
        if (filename === 'overview.html') return 'overview';
        if (filename === 'hall-of-fame.html') return 'hall-of-fame';
        if (filename === 'athlete.html') return 'athlete';

        return 'championships';
    }

    function pageHref(page, site = selectedSite()) {
        const params = new URLSearchParams();
        params.set('site', validSites.has(site) ? site : 'family');

        if (page === 'athlete') {
            const athleteId = new URLSearchParams(window.location.search).get('id');
            if (athleteId) {
                params.set('id', athleteId);
            }

            return `athlete.html?${params.toString()}`;
        }

        const file = pageFiles[page] || pageFiles.overview;
        return `${file}?${params.toString()}`;
    }

    function athleteHref(id, site = selectedSite()) {
        const params = new URLSearchParams();
        params.set('id', id);
        params.set('site', validSites.has(site) ? site : 'family');

        return `athlete.html?${params.toString()}`;
    }

    function renderNavigation() {
        const mount = document.querySelector('[data-site-header]');
        if (!mount) {
            updateModeAwareLinks();
            return;
        }

        const site = selectedSite();
        const page = currentPage();
        const modeLabel = site === 'everyone' ? 'Everyone' : 'Family';
        const navItems = Object.entries(pageFiles)
            .map(([key]) => {
                const active = key === page;
                return `
                    <a
                        class="site-nav-link${active ? ' active' : ''}"
                        href="${pageHref(key, site)}"
                        ${active ? 'aria-current="page"' : ''}>
                        ${pageLabels[key]}
                    </a>
                `;
            })
            .join('');

        mount.classList.add('site-header');
        mount.innerHTML = `
            <div class="site-header-main">
                <div class="site-brand">
                    <a class="site-title-link" href="${pageHref('championships', site)}">
                        <h1 id="site-title">Family Running Championships</h1>
                    </a>
                    <div class="subtitle">
                        <span id="site-mode-label">${modeLabel} site</span>
                        <span aria-hidden="true"> &middot; </span>
                        <span>Age-Graded Rankings Across Generations</span>
                    </div>
                </div>
                <div class="site-navigation-panel">
                    <nav class="site-nav" aria-label="Primary pages">
                        ${navItems}
                    </nav>
                    <div class="site-mode-badge" aria-label="Current site">${modeLabel}</div>
                </div>
            </div>
            <div class="site-meta" id="last-updated" aria-live="polite">
                <div class="site-meta-item">Loading championship data...</div>
            </div>
        `;

        updateModeAwareLinks();
        loadSiteMetadata();
    }

    function updateModeAwareLinks() {
        document.querySelectorAll('[data-site-page]').forEach(link => {
            const page = link.dataset.sitePage;
            link.href = pageHref(page);
        });
    }

    async function loadSiteMetadata() {
        if (typeof fetchCSV !== 'function') {
            return;
        }

        const meta = document.getElementById('last-updated');
        const title = document.getElementById('site-title');
        if (!meta && !title) {
            return;
        }

        try {
            const rows = await fetchCSV(`data/${selectedSite()}/siteinfo.csv`);
            const setting = name => rows.find(row => row[0] === name)?.[1] || '';
            const siteName = setting('SiteName');
            const lastUpdated = setting('LastUpdatedUTC');

            if (title && siteName) {
                title.innerText = siteName;
            }

            if (!meta || !lastUpdated) {
                return;
            }

            const localTime = new Date(lastUpdated).toLocaleString(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short'
            });

            meta.innerHTML =
                `<div class="site-meta-item">
                    <span class="site-meta-icon" aria-hidden="true">&#128197;</span>
                    <span><strong>Updated</strong> ${escapeAttribute(localTime)}</span>
                 </div>`;
        } catch (error) {
            if (meta) {
                meta.innerHTML = '<div class="site-meta-item">Championship data unavailable.</div>';
            }
        }
    }

    function escapeAttribute(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    window.siteNavigation = {
        athleteHref,
        currentPage,
        loadSiteMetadata,
        pageHref,
        selectedSite,
        updateModeAwareLinks
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', renderNavigation, { once: true });
    } else {
        renderNavigation();
    }
})();
