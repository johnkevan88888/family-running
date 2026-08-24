(function (root, factory) {
    const contract = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = contract;
    }

    root.galleryContract = contract;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const schemaVersion = '1.0';
    const itemTypes = new Set(['photo', 'video']);
    const athleteIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    const itemIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    const allowedSuppressionKeys = new Set(['schemaVersion', 'hiddenAthleteIds']);
    const allowedKeys = new Set([
        'id',
        'type',
        'title',
        'caption',
        'alt',
        'raceDate',
        'raceEvent',
        'raceDistance',
        'sourceUrl',
        'thumbnailUrl',
        'featured',
        'athleteIds'
    ]);

    function validateGalleryDocument(documentValue) {
        const problems = [];

        if (!isPlainObject(documentValue)) {
            return ['Gallery data must be a JSON object.'];
        }

        if (documentValue.schemaVersion !== schemaVersion) {
            problems.push(`schemaVersion must be exactly "${schemaVersion}".`);
        }

        if (!Array.isArray(documentValue.items)) {
            problems.push('items must be an array.');
            return problems;
        }

        const seenIds = new Set();

        documentValue.items.forEach((item, index) => {
            const label = `items[${index}]`;

            if (!isPlainObject(item)) {
                problems.push(`${label} must be an object.`);
                return;
            }

            for (const key of Object.keys(item)) {
                if (!allowedKeys.has(key)) {
                    problems.push(`${label} contains unsupported field "${key}".`);
                }
            }

            if (!itemIdPattern.test(stringValue(item.id))) {
                problems.push(`${label}.id must be a lowercase URL-safe identifier.`);
            } else if (seenIds.has(item.id)) {
                problems.push(`${label}.id duplicates "${item.id}".`);
            } else {
                seenIds.add(item.id);
            }

            if (!itemTypes.has(item.type)) {
                problems.push(`${label}.type must be "photo" or "video".`);
            }

            for (const field of ['title', 'alt', 'raceEvent', 'raceDistance']) {
                if (!hasShortText(item[field], field === 'title' ? 120 : 300)) {
                    problems.push(`${label}.${field} must be non-empty text.`);
                }
            }

            if (typeof item.caption !== 'string' || item.caption.length > 600) {
                problems.push(`${label}.caption must be text no longer than 600 characters.`);
            }

            if (!isIsoDate(item.raceDate)) {
                problems.push(`${label}.raceDate must be a real date in YYYY-MM-DD format.`);
            }

            for (const field of ['sourceUrl', 'thumbnailUrl']) {
                if (!isSafeMediaUrl(item[field])) {
                    problems.push(`${label}.${field} must be an absolute HTTPS URL without credentials.`);
                }
            }

            if (typeof item.featured !== 'boolean') {
                problems.push(`${label}.featured must be true or false.`);
            }

            if (!Array.isArray(item.athleteIds)) {
                problems.push(`${label}.athleteIds must be an array.`);
            } else {
                const seenAthletes = new Set();
                item.athleteIds.forEach((athleteId, athleteIndex) => {
                    if (!athleteIdPattern.test(stringValue(athleteId))) {
                        problems.push(`${label}.athleteIds[${athleteIndex}] is not a valid athlete ID.`);
                    } else if (seenAthletes.has(athleteId)) {
                        problems.push(`${label}.athleteIds duplicates "${athleteId}".`);
                    } else {
                        seenAthletes.add(athleteId);
                    }
                });
            }
        });

        return problems;
    }

    function validateGallerySuppressionDocument(documentValue) {
        const problems = [];

        if (!isPlainObject(documentValue)) {
            return ['Gallery suppression data must be a JSON object.'];
        }

        for (const key of Object.keys(documentValue)) {
            if (!allowedSuppressionKeys.has(key)) {
                problems.push(`Gallery suppression data contains unsupported field "${key}".`);
            }
        }

        if (documentValue.schemaVersion !== schemaVersion) {
            problems.push(`schemaVersion must be exactly "${schemaVersion}".`);
        }

        if (!Array.isArray(documentValue.hiddenAthleteIds)) {
            problems.push('hiddenAthleteIds must be an array.');
            return problems;
        }

        const seenAthletes = new Set();
        documentValue.hiddenAthleteIds.forEach((athleteId, index) => {
            if (!athleteIdPattern.test(stringValue(athleteId))) {
                problems.push(`hiddenAthleteIds[${index}] is not a valid athlete ID.`);
            } else if (seenAthletes.has(athleteId)) {
                problems.push(`hiddenAthleteIds duplicates "${athleteId}".`);
            } else {
                seenAthletes.add(athleteId);
            }
        });

        return problems;
    }

    function filterSuppressedGalleryItems(items, suppressionDocument) {
        const hiddenAthleteIds = new Set(suppressionDocument.hiddenAthleteIds);

        return items.filter(item =>
            !item.athleteIds.some(athleteId => hiddenAthleteIds.has(athleteId))
        );
    }

    function isSafeMediaUrl(value) {
        if (typeof value !== 'string' || value.length > 2048) {
            return false;
        }

        try {
            const url = new URL(value);
            return url.protocol === 'https:' && !url.username && !url.password;
        } catch {
            return false;
        }
    }

    function hasShortText(value, maximumLength) {
        return typeof value === 'string' && value.trim().length > 0 && value.length <= maximumLength;
    }

    function isIsoDate(value) {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
            return false;
        }

        const date = new Date(`${value}T00:00:00Z`);
        return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
    }

    function isPlainObject(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    function stringValue(value) {
        return typeof value === 'string' ? value : '';
    }

    return {
        schemaVersion,
        filterSuppressedGalleryItems,
        validateGalleryDocument,
        validateGallerySuppressionDocument
    };
});
