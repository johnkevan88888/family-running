(function () {
    const validSites = new Set(['family', 'everyone']);
    const pageFiles = {
        championships: 'index.html',
        news: 'news.html',
        'hall-of-fame': 'hall-of-fame.html',
        records: 'records.html',
        'head-to-head': 'calculator.html',
        calculator: 'age-grade-calculator.html',
        overview: 'overview.html'
    };
    const pageLabels = {
        championships: 'Championships',
        news: 'News',
        'hall-of-fame': 'Hall of Fame',
        records: 'Records',
        'head-to-head': 'Head to Head',
        calculator: 'Calculator',
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
        if (filename === 'news.html') return 'news';
        if (filename === 'overview.html') return 'overview';
        if (filename === 'hall-of-fame.html') return 'hall-of-fame';
        if (filename === 'records.html') return 'records';
        if (filename === 'calculator.html') return 'head-to-head';
        if (filename === 'age-grade-calculator.html') return 'calculator';
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
                const isAthleteBackLink = page === 'athlete' && key === 'championships';
                const label = isAthleteBackLink
                    ? '<span aria-hidden="true">&#8592;</span> Back to Championships'
                    : pageLabels[key];
                return `
                    <a
                        class="site-nav-link${isAthleteBackLink ? ' back-link' : ''}${active ? ' active' : ''}"
                        href="${pageHref(key, site)}"
                        ${active ? 'aria-current="page"' : ''}>
                        ${label}
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
                <div class="site-meta" id="last-updated" aria-live="polite">
                    <div class="site-meta-item">Loading championship data...</div>
                </div>
            </div>
            <div class="site-navigation-panel">
                <nav class="site-nav" aria-label="Primary pages">
                    ${navItems}
                </nav>
                <div class="site-header-tools">
                    <div class="site-pace-control pace-unit-control" role="group" aria-label="Pace display unit">
                        <span class="pace-unit-label">Pace</span>
                        <div class="pace-unit-options">
                            <button type="button" data-pace-unit="km" aria-label="Show pace per kilometre" aria-pressed="true">/km</button>
                            <button type="button" data-pace-unit="mi" aria-label="Show pace per mile" aria-pressed="false">/mi</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        updateModeAwareLinks();
        window.paceDisplay?.initialize(document);
        loadSiteMetadata();
    }

    function updateModeAwareLinks() {
        document.querySelectorAll('[data-site-page]').forEach(link => {
            const page = link.dataset.sitePage;
            link.href = pageHref(page);
        });
    }

    // Each page's <title> is static, so it named one site mode whatever the
    // visitor selected: an Everyone-mode tab read "Family Running
    // Championships" while the header correctly showed the exported name. Only
    // the site-name portion is replaced, so each page keeps its own prefix and
    // the tab agrees with the header. Repeat application is harmless.
    //
    // The athlete page is skipped deliberately: its title is "Name | Athlete
    // Profile", which names no site mode and is already correct.
    function applyExportedSiteNameToDocumentTitle(siteName) {
        if (currentPage() === 'athlete') {
            return;
        }

        const separator = ' | ';
        const separatorIndex = document.title.lastIndexOf(separator);

        document.title = separatorIndex >= 0
            ? `${document.title.slice(0, separatorIndex)}${separator}${siteName}`
            : siteName;
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

            if (siteName) {
                applyExportedSiteNameToDocumentTitle(siteName);
            }

            if (!meta || !lastUpdated) {
                return;
            }

            const localTime = window.dateDisplay?.formatDateTime(lastUpdated) || lastUpdated;

            meta.innerHTML =
                `<div class="site-meta-item">
                    <span class="site-meta-icon" aria-hidden="true">&#128197;</span>
                    <span><strong>Updated</strong> ${escapeHTML(localTime)}</span>
                 </div>`;
        } catch (error) {
            if (meta) {
                meta.innerHTML = '<div class="site-meta-item">Championship data unavailable.</div>';
            }
        }
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
