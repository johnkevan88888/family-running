(function () {
    const productionHost = 'johnkevan88888.github.io';
    const productionPathPrefix = '/family-running';
    const validSites = new Set(['family', 'everyone']);
    const currentPath = window.location.pathname;
    const isProductionSite = window.location.hostname === productionHost
        && (currentPath === productionPathPrefix || currentPath.startsWith(`${productionPathPrefix}/`));

    if (!isProductionSite) {
        return;
    }

    window.goatcounter = {
        path: function () {
            const params = new URLSearchParams(window.location.search);
            const requestedSite = String(params.get('site') || '').toLowerCase();
            const site = validSites.has(requestedSite) ? requestedSite : 'family';
            const analyticsParams = new URLSearchParams({ site });
            const normalizedPath = currentPath === productionPathPrefix
                ? `${productionPathPrefix}/`
                : currentPath;

            if (normalizedPath.endsWith('/athlete.html')) {
                const athleteId = params.get('id');
                if (athleteId) {
                    analyticsParams.set('id', athleteId);
                }
            }

            return `${normalizedPath}?${analyticsParams.toString()}`;
        }
    };

    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://gc.zgo.at/count.v4.js';
    script.dataset.goatcounter = 'https://familyrunning.goatcounter.com/count';
    script.crossOrigin = 'anonymous';
    script.integrity = 'sha384-nRw6qfbWyLha9LhsOtSb2YJDyZdKvvCFh0fJYlkquSFjUxp9FVNugbfy8q1jdxI+';
    document.head.appendChild(script);
})();
