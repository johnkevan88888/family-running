(function (root, factory) {
    const contract = factory(root);

    if (typeof module === 'object' && module.exports) {
        module.exports = contract;
    }

    root.galleryUploadContract = contract;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    const schemaVersion = '1.0';
    const siteModes = Object.freeze(['family', 'everyone']);
    const states = Object.freeze([
        'draft',
        'uploading',
        'private-review',
        'approved-for-processing',
        'processing',
        'candidate-public',
        'pr-open',
        'published',
        'rejected',
        'withdrawal-pending',
        'withdrawn',
        'processing-failed'
    ]);
    const candidateStates = new Set(['candidate-public', 'pr-open', 'published']);
    const approvalGateStates = new Set(['approved-for-processing', 'processing']);
    const publicationGateStates = new Set(['pr-open', 'published']);
    const publicationEligibleStates = new Set(['candidate-public', 'pr-open']);
    const requiredDraftKeys = Object.freeze([
        'schemaVersion',
        'draftId',
        'state',
        'stateVersion',
        'siteModes',
        'exportBundleId',
        'sourceRevision',
        'suppressionRevision',
        'itemRevision',
        'itemInput',
        'manifestItem',
        'consent',
        'withdrawalEvidence'
    ]);
    const allowedDraftKeys = new Set(requiredDraftKeys);
    const allowedItemInputKeys = new Set([
        'id',
        'type',
        'title',
        'caption',
        'alt',
        'raceDate',
        'raceEvent',
        'raceDistance',
        'featured',
        'athleteIds'
    ]);
    const allowedManifestItemKeys = new Set([
        ...allowedItemInputKeys,
        'sourceUrl',
        'thumbnailUrl'
    ]);
    const allowedGalleryDocumentKeys = new Set(['schemaVersion', 'items']);
    const allowedSuppressionDocumentKeys = new Set(['schemaVersion', 'hiddenAthleteIds']);
    const allowedSiteCatalogKeys = new Set([
        'exportBundleId',
        'sourceRevision',
        'races',
        'athleteIds'
    ]);
    const allowedRaceKeys = new Set(['raceDate', 'raceEvent', 'raceDistance']);
    const allowedConsentKeys = new Set([
        'publicUseConfirmed',
        'containsMinors',
        'guardianApprovalConfirmed',
        'revision'
    ]);
    const allowedTransitionRequestKeys = new Set([
        'toState',
        'expectedStateVersion',
        'idempotencyKey',
        'payloadFingerprint'
    ]);
    const allowedIdempotencyRecordKeys = new Set([
        'schemaVersion',
        'draftId',
        'idempotencyKey',
        'payloadFingerprint',
        'fromState',
        'toState',
        'expectedStateVersion',
        'resultStateVersion'
    ]);
    const allowedDerivativeKeys = new Set([
        'draftId',
        'itemRevision',
        'consentRevision',
        'exportBundleId',
        'sourceRevision',
        'suppressionRevision',
        'sourceUrl',
        'thumbnailUrl'
    ]);
    const derivativeUrlFields = Object.freeze(['sourceUrl', 'thumbnailUrl']);
    const allowedWithdrawalEvidenceKeys = new Set([
        'removalKind',
        'hostDeletionConfirmed',
        'privateOriginalDeletionConfirmed',
        'evidenceRevision'
    ]);
    const removalKinds = new Set([
        'editorial-removal',
        'athlete-exclusion',
        'consent-withdrawal'
    ]);
    const allowedExclusionRevisionKeys = new Set([
        'expectedSuppressionRevision',
        'currentSuppressionRevision',
        'expectedManifestRevisions',
        'currentManifestRevisions',
        'approvedDerivativeOrigin',
        'knownAthleteIds'
    ]);
    const allowedManifestSites = new Set(siteModes);
    const allowedRosterEntryKeys = new Set(['athleteId', 'participant']);
    const allowedResultEntryKeys = new Set([
        'athleteId',
        'raceDate',
        'raceEvent',
        'raceDistance'
    ]);
    const allowedSiteModeSelections = new Set([
        'family',
        'everyone'
    ]);
    const stateTransitions = Object.freeze({
        draft: Object.freeze(['uploading', 'withdrawal-pending']),
        uploading: Object.freeze(['private-review', 'withdrawal-pending']),
        'private-review': Object.freeze([
            'approved-for-processing',
            'rejected',
            'withdrawal-pending'
        ]),
        'approved-for-processing': Object.freeze([
            'private-review',
            'processing',
            'withdrawal-pending'
        ]),
        processing: Object.freeze([
            'candidate-public',
            'processing-failed',
            'withdrawal-pending'
        ]),
        'processing-failed': Object.freeze([
            'approved-for-processing',
            'withdrawal-pending'
        ]),
        'candidate-public': Object.freeze([
            'private-review',
            'pr-open',
            'withdrawal-pending'
        ]),
        'pr-open': Object.freeze([
            'candidate-public',
            'published',
            'withdrawal-pending'
        ]),
        published: Object.freeze(['withdrawal-pending']),
        rejected: Object.freeze(['draft', 'withdrawal-pending']),
        'withdrawal-pending': Object.freeze(['withdrawn']),
        withdrawn: Object.freeze([])
    });
    const placeholderSourceUrl = 'https://contract.invalid/source';
    const placeholderThumbnailUrl = 'https://contract.invalid/thumbnail';
    const revisionPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
    const draftIdPattern = /^[A-Za-z0-9_-]{20,128}$/;
    const idempotencyKeyPattern = /^[A-Za-z0-9_-]{16,128}$/;
    const payloadFingerprintPattern = /^[a-f0-9]{64}$/;
    const contentHashPattern = '[a-f0-9]{64}';
    const photoSourcePathPattern = new RegExp(`^/media/v1/${contentHashPattern}/display\\.webp$`);
    const photoThumbnailPathPattern = new RegExp(`^/media/v1/${contentHashPattern}/thumbnail\\.webp$`);
    const videoSourcePathPattern = new RegExp(`^/media/v1/${contentHashPattern}/video\\.mp4$`);
    const videoThumbnailPathPattern = new RegExp(`^/media/v1/${contentHashPattern}/poster\\.webp$`);

    function validateGalleryUploadDraft(draft) {
        const problems = [];

        if (!isPlainObject(draft)) {
            return ['Gallery upload draft must be a JSON object.'];
        }

        rejectUnsupportedKeys(draft, allowedDraftKeys, 'Gallery upload draft', problems);
        requireKeys(draft, requiredDraftKeys, 'Gallery upload draft', problems);

        if (draft.schemaVersion !== schemaVersion) {
            problems.push(`Gallery upload draft schemaVersion must be exactly "${schemaVersion}".`);
        }

        if (!draftIdPattern.test(stringValue(draft.draftId))) {
            problems.push(
                'Gallery upload draft draftId must be an opaque URL-safe identifier between 20 and 128 characters.'
            );
        }

        if (!states.includes(draft.state)) {
            problems.push(`Gallery upload draft state must be one of: ${states.join(', ')}.`);
        }

        if (!Number.isSafeInteger(draft.stateVersion) || draft.stateVersion < 0) {
            problems.push('Gallery upload draft stateVersion must be a non-negative safe integer.');
        }

        validateRevision(draft.exportBundleId, 'exportBundleId', problems);
        validateRevision(draft.sourceRevision, 'sourceRevision', problems);
        validateRevision(draft.suppressionRevision, 'suppressionRevision', problems);
        validateRevision(draft.itemRevision, 'itemRevision', problems);
        validateSiteModeSelection(draft.siteModes, problems);
        validateConsent(draft.consent, problems);
        validateItemInput(draft.itemInput, problems);
        validateManifestCandidate(draft.itemInput, draft.manifestItem, problems);
        validateWithdrawalEvidence(draft.withdrawalEvidence, draft.state, problems);

        if (candidateStates.has(draft.state) && draft.manifestItem === null) {
            problems.push(
                `Gallery upload state "${draft.state}" requires a complete public manifest item.`
            );
        }

        return problems;
    }

    function validateGalleryUploadApproval(draft, context) {
        const problems = validateGalleryUploadDraft(draft);
        if (problems.length) {
            return problems;
        }

        applyConsentGates(draft.consent, context?.consentRevision, problems);
        validateSuppressionGate(
            draft,
            context?.suppressionDocument,
            context?.suppressionRevision,
            context?.pendingHiddenAthleteIds,
            problems
        );
        validateSiteCatalogs(draft, context?.siteCatalogs, problems);

        return problems;
    }

    function createProcessingDispatch(draft, context) {
        if (!isPlainObject(draft) || draft.state !== 'approved-for-processing') {
            return null;
        }

        const problems = validateGalleryUploadApproval(draft, context);
        if (problems.length) {
            return null;
        }

        return deepFreeze({ draftId: draft.draftId });
    }

    function validateGalleryUploadCandidate(draft, context) {
        const problems = validateGalleryUploadApproval(draft, context);
        if (problems.length) {
            return problems;
        }

        if (draft.manifestItem === null) {
            problems.push('A complete public manifest item is required before candidate publication.');
            return problems;
        }

        validateApprovedDerivatives(draft, context, problems);
        return problems;
    }

    function validateGalleryUploadPublication(draft, context) {
        const problems = validateGalleryUploadCandidate(draft, context);
        if (problems.length) {
            return problems;
        }

        if (!publicationEligibleStates.has(draft.state)) {
            problems.push(
                'Gallery upload publication requires state "candidate-public" or "pr-open".'
            );
        }

        return problems;
    }

    function validateTransitionRequest(request) {
        const problems = [];
        if (!isPlainObject(request)) {
            return ['Gallery upload transition request must be a JSON object.'];
        }

        rejectUnsupportedKeys(
            request,
            allowedTransitionRequestKeys,
            'Gallery upload transition request',
            problems
        );
        requireKeys(
            request,
            [...allowedTransitionRequestKeys],
            'Gallery upload transition request',
            problems
        );

        if (!states.includes(request.toState)) {
            problems.push(`Gallery upload target state must be one of: ${states.join(', ')}.`);
        }

        if (
            !Number.isSafeInteger(request.expectedStateVersion) ||
            request.expectedStateVersion < 0
        ) {
            problems.push(
                'Gallery upload transition expectedStateVersion must be a non-negative safe integer.'
            );
        }

        if (!idempotencyKeyPattern.test(stringValue(request.idempotencyKey))) {
            problems.push(
                'Gallery upload transition idempotencyKey must be 16 to 128 URL-safe characters.'
            );
        }

        if (!payloadFingerprintPattern.test(stringValue(request.payloadFingerprint))) {
            problems.push(
                'Gallery upload transition payloadFingerprint must be a lowercase SHA-256 hex value.'
            );
        }

        return problems;
    }

    function canTransitionGalleryUpload(fromState, toState) {
        return states.includes(fromState) &&
            states.includes(toState) &&
            stateTransitions[fromState].includes(toState);
    }

    function transitionGalleryUpload(draft, request, context = {}) {
        const draftProblems = validateGalleryUploadDraft(draft);
        const requestProblems = validateTransitionRequest(request);
        if (draftProblems.length || requestProblems.length) {
            return transitionFailure(draft, [...draftProblems, ...requestProblems]);
        }

        const replay = assessIdempotencyReplay(draft, request, context.idempotencyRecord);
        if (replay) {
            return replay;
        }

        if (request.expectedStateVersion !== draft.stateVersion) {
            return transitionFailure(draft, [
                `Gallery upload transition is stale: expected stateVersion ${request.expectedStateVersion}, current stateVersion is ${draft.stateVersion}.`
            ]);
        }

        if (!canTransitionGalleryUpload(draft.state, request.toState)) {
            return transitionFailure(draft, [
                `Gallery upload cannot transition from "${draft.state}" to "${request.toState}".`
            ]);
        }

        const gateProblems = approvalGateStates.has(request.toState)
            ? validateGalleryUploadApproval(draft, context)
            : request.toState === 'candidate-public'
                ? validateGalleryUploadCandidate(draft, context)
                : publicationGateStates.has(request.toState)
                    ? validateGalleryUploadPublication(draft, context)
                    : request.toState === 'withdrawn'
                        ? validateWithdrawalTransition(context.withdrawalEvidence)
                        : [];
        if (gateProblems.length) {
            return transitionFailure(draft, gateProblems);
        }

        const nextDraft = deepClone(draft);
        nextDraft.state = request.toState;
        nextDraft.stateVersion = draft.stateVersion + 1;
        if (request.toState === 'withdrawn') {
            nextDraft.withdrawalEvidence = deepClone(context.withdrawalEvidence);
        }

        const idempotencyRecord = deepFreeze({
            schemaVersion,
            draftId: draft.draftId,
            idempotencyKey: request.idempotencyKey,
            payloadFingerprint: request.payloadFingerprint,
            fromState: draft.state,
            toState: request.toState,
            expectedStateVersion: request.expectedStateVersion,
            resultStateVersion: nextDraft.stateVersion
        });

        return Object.freeze({
            ok: true,
            changed: true,
            draft: deepFreeze(nextDraft),
            idempotencyRecord,
            problems: Object.freeze([])
        });
    }

    function createPublicManifestItems(draft, context) {
        const problems = validateGalleryUploadPublication(draft, context);
        if (problems.length) {
            return deepFreeze({
                ok: false,
                itemsBySite: {},
                problems
            });
        }

        const itemsBySite = {};
        for (const siteMode of draft.siteModes) {
            itemsBySite[siteMode] = deepClone(draft.manifestItem);
        }

        return deepFreeze({
            ok: true,
            itemsBySite,
            problems: []
        });
    }

    function planAthleteSuppression(
        athleteId,
        suppressionDocument,
        manifestsBySite,
        revisionContext
    ) {
        const problems = [];
        const galleryContract = publicGalleryContract();
        if (!galleryContract) {
            return suppressionPlanFailure(['The public Gallery contract is unavailable.']);
        }

        validateExclusionRevisions(revisionContext, problems);

        const candidateSuppression = {
            schemaVersion: galleryContract.schemaVersion,
            hiddenAthleteIds: [athleteId]
        };
        for (const problem of galleryContract.validateGallerySuppressionDocument(
            candidateSuppression
        )) {
            problems.push(`Gallery athlete exclusion: ${problem}`);
        }

        if (
            Array.isArray(revisionContext?.knownAthleteIds) &&
            !revisionContext.knownAthleteIds.includes(athleteId)
        ) {
            problems.push('Gallery athlete exclusion athlete ID is not in the current known roster.');
        }

        validateSuppressionDocumentSafely(
            suppressionDocument,
            galleryContract,
            'Gallery suppression data',
            problems
        );

        if (!isPlainObject(manifestsBySite)) {
            problems.push('Gallery athlete exclusion requires Family and Everyone manifests.');
            return suppressionPlanFailure(problems);
        }

        if (Object.keys(manifestsBySite).some(key => !allowedManifestSites.has(key))) {
            problems.push('Gallery athlete exclusion contains unsupported site modes.');
        }

        for (const siteMode of siteModes) {
            const manifest = manifestsBySite[siteMode];
            if (!isPlainObject(manifest)) {
                problems.push(`Gallery athlete exclusion requires the "${siteMode}" manifest.`);
                continue;
            }

            validateGalleryDocumentSafely(
                manifest,
                galleryContract,
                `Gallery athlete exclusion ${siteMode} manifest`,
                problems
            );
        }

        if (problems.length) {
            return suppressionPlanFailure(problems);
        }

        const familyItemsById = new Map(
            manifestsBySite.family.items.map(item => [item.id, item])
        );
        const everyoneItemsById = new Map(
            manifestsBySite.everyone.items.map(item => [item.id, item])
        );
        for (const [id, familyItem] of familyItemsById) {
            if (
                everyoneItemsById.has(id) &&
                JSON.stringify(familyItem) !== JSON.stringify(everyoneItemsById.get(id))
            ) {
                problems.push(
                    `Gallery athlete exclusion found shared item "${id}" with different content.`
                );
            }
        }

        if (problems.length) {
            return suppressionPlanFailure(problems);
        }

        const takedownById = new Map();
        for (const siteMode of siteModes) {
            for (const item of manifestsBySite[siteMode].items) {
                if (!item.athleteIds.includes(athleteId)) {
                    continue;
                }

                const existing = takedownById.get(item.id);
                if (existing) {
                    existing.siteModes.push(siteMode);
                    continue;
                }

                takedownById.set(item.id, {
                    item,
                    siteModes: [siteMode]
                });
            }
        }

        const affectedIds = new Set(takedownById.keys());
        const approvedOrigin = normalizeApprovedOrigin(revisionContext.approvedDerivativeOrigin);
        for (const { item } of takedownById.values()) {
            validateDerivativeUrl(
                item.sourceUrl,
                approvedOrigin,
                item.type,
                'sourceUrl',
                problems
            );
            validateDerivativeUrl(
                item.thumbnailUrl,
                approvedOrigin,
                item.type,
                'thumbnailUrl',
                problems
            );
        }

        if (problems.length) {
            return suppressionPlanFailure(problems);
        }

        const allUrlReferences = new Map();
        for (const siteMode of siteModes) {
            for (const item of manifestsBySite[siteMode].items) {
                for (const role of ['sourceUrl', 'thumbnailUrl']) {
                    const references = allUrlReferences.get(item[role]) || [];
                    references.push({ id: item.id, role, siteMode });
                    allUrlReferences.set(item[role], references);
                }
            }
        }

        const ownedObjectUrls = [];
        const seenOwnedObjectUrls = new Set();
        for (const { item } of takedownById.values()) {
            for (const role of ['sourceUrl', 'thumbnailUrl']) {
                const url = item[role];
                const unaffectedReferences = (allUrlReferences.get(url) || [])
                    .filter(reference => !affectedIds.has(reference.id));
                if (unaffectedReferences.length) {
                    problems.push(
                        `Gallery athlete exclusion cannot delete ${role} for "${item.id}" because the URL is reused by unaffected item "${unaffectedReferences[0].id}".`
                    );
                } else if (!seenOwnedObjectUrls.has(url)) {
                    seenOwnedObjectUrls.add(url);
                    ownedObjectUrls.push(url);
                }
            }
        }

        if (problems.length) {
            return suppressionPlanFailure(problems);
        }

        const hiddenAthleteIds = suppressionDocument.hiddenAthleteIds.includes(athleteId)
            ? [...suppressionDocument.hiddenAthleteIds]
            : [...suppressionDocument.hiddenAthleteIds, athleteId];
        const takedownItems = [...takedownById.values()].map(({ item, siteModes: modes }) => ({
            id: item.id,
            sourceUrl: item.sourceUrl,
            thumbnailUrl: item.thumbnailUrl,
            siteModes: modes
        }));
        const correctedManifests = Object.fromEntries(siteModes.map(siteMode => [
            siteMode,
            {
                schemaVersion: manifestsBySite[siteMode].schemaVersion,
                items: manifestsBySite[siteMode].items
                    .filter(item => !affectedIds.has(item.id))
                    .map(deepClone)
            }
        ]));

        return deepFreeze({
            ok: true,
            suppressionDocument: {
                schemaVersion: galleryContract.schemaVersion,
                hiddenAthleteIds
            },
            basisRevisions: {
                suppressionRevision: revisionContext.currentSuppressionRevision,
                manifestRevisions: deepClone(revisionContext.currentManifestRevisions)
            },
            correctedManifests,
            takedownItems,
            ownedObjectUrls,
            problems: []
        });
    }

    function buildAthleteTagChoices(selectedRace, roster, resultEntries) {
        const problems = [];
        if (!isRaceTuple(selectedRace)) {
            problems.push('Gallery athlete choices require an exact race date, event, and distance.');
        } else {
            rejectUnsupportedKeys(
                selectedRace,
                allowedRaceKeys,
                'Gallery athlete choices selected race',
                problems
            );
            requireKeys(
                selectedRace,
                [...allowedRaceKeys],
                'Gallery athlete choices selected race',
                problems
            );
        }

        if (!Array.isArray(roster)) {
            problems.push('Gallery athlete choices roster must be an array.');
        }

        if (!Array.isArray(resultEntries)) {
            problems.push('Gallery athlete choices resultEntries must be an array.');
        }

        if (problems.length) {
            return tagChoiceFailure(problems);
        }

        const seenAthleteIds = new Set();
        roster.forEach((entry, index) => {
            const label = `Gallery athlete choices roster[${index}]`;
            if (!isPlainObject(entry)) {
                problems.push(`${label} must be an object.`);
                return;
            }
            rejectUnsupportedKeys(entry, allowedRosterEntryKeys, label, problems);
            if (!athleteIdPattern(entry.athleteId)) {
                problems.push(`${label}.athleteId must be a public URL-safe athlete ID.`);
            } else if (seenAthleteIds.has(entry.athleteId)) {
                problems.push(`${label}.athleteId duplicates "${entry.athleteId}".`);
            } else {
                seenAthleteIds.add(entry.athleteId);
            }
            if (!isBoundedPublicText(entry.participant, 300)) {
                problems.push(`${label}.participant must be non-empty public display text.`);
            }
        });

        const runners = new Set();
        resultEntries.forEach((entry, index) => {
            const label = `Gallery athlete choices resultEntries[${index}]`;
            if (!isPlainObject(entry)) {
                problems.push(`${label} must be an object.`);
                return;
            }
            rejectUnsupportedKeys(entry, allowedResultEntryKeys, label, problems);
            requireKeys(entry, [...allowedResultEntryKeys], label, problems);
            if (!athleteIdPattern(entry.athleteId)) {
                problems.push(`${label}.athleteId must be a public URL-safe athlete ID.`);
                return;
            }
            if (!isRaceTuple(entry)) {
                problems.push(`${label} must contain a valid race date, event, and distance.`);
                return;
            }
            if (!seenAthleteIds.has(entry.athleteId)) {
                problems.push(`${label}.athleteId is not in the selected site roster.`);
                return;
            }
            if (sameRace(entry, selectedRace)) {
                runners.add(entry.athleteId);
            }
        });

        if (problems.length) {
            return tagChoiceFailure(problems);
        }

        const choices = [
            ...roster.filter(entry => runners.has(entry.athleteId)),
            ...roster.filter(entry => !runners.has(entry.athleteId))
        ].map(entry => ({
            athleteId: entry.athleteId,
            participant: entry.participant,
            ranSelectedRace: runners.has(entry.athleteId)
        }));

        return deepFreeze({ ok: true, choices, problems: [] });
    }

    function validateAthleteTagSelection(selectedAthleteIds, choices) {
        const problems = [];
        if (!Array.isArray(selectedAthleteIds)) {
            return ['Gallery athlete tag selection must be an array of public athlete IDs.'];
        }
        if (!Array.isArray(choices)) {
            return ['Gallery athlete tag choices must be an array.'];
        }

        const availableIds = new Set(choices.map(choice => choice?.athleteId));
        const seen = new Set();
        selectedAthleteIds.forEach((athleteId, index) => {
            if (!athleteIdPattern(athleteId)) {
                problems.push(
                    `Gallery athlete tag selection[${index}] must be a public athlete ID, not free-text identity.`
                );
            } else if (!availableIds.has(athleteId)) {
                problems.push(`Gallery athlete tag selection[${index}] is not an available athlete ID.`);
            } else if (seen.has(athleteId)) {
                problems.push(`Gallery athlete tag selection duplicates "${athleteId}".`);
            } else {
                seen.add(athleteId);
            }
        });

        return problems;
    }

    function validateSiteModeSelection(value, problems) {
        if (!Array.isArray(value)) {
            problems.push('Gallery upload draft siteModes must be an array.');
            return;
        }

        if (!allowedSiteModeSelections.has(value.join('|'))) {
            problems.push(
                'Gallery upload draft siteModes must be exactly ["family"] or ["everyone"] (one site mode).'
            );
        }
    }

    function validateRevision(value, field, problems) {
        if (!revisionPattern.test(stringValue(value))) {
            problems.push(
                `Gallery upload draft ${field} must be a non-empty safe revision identifier no longer than 200 characters.`
            );
        }
    }

    function validateConsent(value, problems) {
        if (!isPlainObject(value)) {
            problems.push('Gallery upload draft consent must be a JSON object.');
            return;
        }

        rejectUnsupportedKeys(value, allowedConsentKeys, 'Gallery upload draft consent', problems);
        requireKeys(value, [...allowedConsentKeys], 'Gallery upload draft consent', problems);

        for (const field of [
            'publicUseConfirmed',
            'containsMinors',
            'guardianApprovalConfirmed'
        ]) {
            if (typeof value[field] !== 'boolean') {
                problems.push(`Gallery upload draft consent.${field} must be true or false.`);
            }
        }

        if (!revisionPattern.test(stringValue(value.revision))) {
            problems.push('Gallery upload draft consent.revision must be a safe revision identifier.');
        }
    }

    function validateItemInput(value, problems) {
        if (!isPlainObject(value)) {
            problems.push('Gallery upload draft itemInput must be a JSON object.');
            return;
        }

        rejectUnsupportedKeys(
            value,
            allowedItemInputKeys,
            'Gallery upload draft itemInput',
            problems
        );

        const galleryContract = publicGalleryContract();
        if (!galleryContract) {
            problems.push('The public Gallery manifest contract is unavailable.');
            return;
        }

        for (const problem of galleryContract.validateGalleryDocument({
            schemaVersion: galleryContract.schemaVersion,
            items: [{
                ...pickAllowedKeys(value, allowedItemInputKeys),
                sourceUrl: placeholderSourceUrl,
                thumbnailUrl: placeholderThumbnailUrl
            }]
        })) {
            problems.push(`Gallery upload draft itemInput: ${problem}`);
        }
    }

    function validateManifestCandidate(itemInput, manifestItem, problems) {
        if (manifestItem === null) {
            return;
        }

        if (!isPlainObject(manifestItem)) {
            problems.push('Gallery upload draft manifestItem must be null or a JSON object.');
            return;
        }

        rejectUnsupportedKeys(
            manifestItem,
            allowedManifestItemKeys,
            'Gallery upload draft manifestItem',
            problems
        );

        const galleryContract = publicGalleryContract();
        if (!galleryContract) {
            problems.push('The public Gallery manifest contract is unavailable.');
            return;
        }

        for (const problem of galleryContract.validateGalleryDocument({
            schemaVersion: galleryContract.schemaVersion,
            items: [pickAllowedKeys(manifestItem, allowedManifestItemKeys)]
        })) {
            problems.push(`Gallery upload draft manifestItem: ${problem}`);
        }

        if (!isPlainObject(itemInput)) {
            return;
        }

        for (const field of allowedItemInputKeys) {
            if (JSON.stringify(manifestItem[field]) !== JSON.stringify(itemInput[field])) {
                problems.push(
                    `Gallery upload draft manifestItem.${field} must exactly match itemInput.${field}.`
                );
            }
        }
    }

    function validateWithdrawalEvidence(value, state, problems) {
        if (state !== 'withdrawn') {
            if (value !== null) {
                problems.push('Gallery upload withdrawalEvidence must be null before withdrawal completes.');
            }
            return;
        }

        for (const problem of validateWithdrawalTransition(value)) {
            problems.push(problem);
        }
    }

    function validateWithdrawalTransition(value) {
        const problems = [];
        if (!isPlainObject(value)) {
            return ['Verified host-deletion evidence is required before state "withdrawn".'];
        }

        rejectUnsupportedKeys(
            value,
            allowedWithdrawalEvidenceKeys,
            'Gallery upload withdrawal evidence',
            problems
        );
        requireKeys(
            value,
            [...allowedWithdrawalEvidenceKeys],
            'Gallery upload withdrawal evidence',
            problems
        );

        if (!removalKinds.has(value.removalKind)) {
            problems.push(
                'Gallery upload withdrawal evidence removalKind must be "editorial-removal", "athlete-exclusion", or "consent-withdrawal".'
            );
        }

        // This is an absence check, not a claim that an object necessarily
        // existed. `true` means the owned media host was checked and no public
        // derivative remains, including the valid zero-object pre-public case.
        if (value.hostDeletionConfirmed !== true) {
            problems.push('Gallery upload withdrawal evidence must confirm no hosted derivative remains.');
        }

        if (typeof value.privateOriginalDeletionConfirmed !== 'boolean') {
            problems.push(
                'Gallery upload withdrawal evidence must record whether the private original was deleted.'
            );
        }

        if (
            value.removalKind === 'consent-withdrawal' &&
            value.privateOriginalDeletionConfirmed !== true
        ) {
            problems.push(
                'Consent withdrawal requires confirmed deletion of both hosted derivatives and the private original.'
            );
        }

        if (!revisionPattern.test(stringValue(value.evidenceRevision))) {
            problems.push('Gallery upload withdrawal evidence must include a safe evidenceRevision.');
        }

        return problems;
    }

    function applyConsentGates(consent, currentConsentRevision, problems) {
        if (consent.publicUseConfirmed !== true) {
            problems.push('Public use must be confirmed before processing or publication.');
        }

        if (consent.containsMinors === true && consent.guardianApprovalConfirmed !== true) {
            problems.push('Guardian approval must be confirmed when the media contains minors.');
        }

        if (currentConsentRevision !== consent.revision) {
            problems.push('Gallery upload consent revision is stale.');
        }
    }

    function validateSuppressionGate(
        draft,
        suppressionDocument,
        currentRevision,
        pendingHiddenAthleteIds,
        problems
    ) {
        if (currentRevision !== draft.suppressionRevision) {
            problems.push('Gallery upload suppression revision is stale.');
        }

        const galleryContract = publicGalleryContract();
        if (!galleryContract) {
            problems.push('The public Gallery suppression contract is unavailable.');
            return;
        }

        const suppressionProblemsBefore = problems.length;
        validateSuppressionDocumentSafely(
            suppressionDocument,
            galleryContract,
            'Gallery upload suppression data',
            problems
        );
        validateAthleteIdList(
            pendingHiddenAthleteIds,
            galleryContract,
            'Gallery upload pending suppression data',
            problems
        );
        if (problems.length !== suppressionProblemsBefore) {
            return;
        }

        const hiddenAthleteIds = new Set([
            ...suppressionDocument.hiddenAthleteIds,
            ...pendingHiddenAthleteIds
        ]);
        const blockedAthleteIds = draft.itemInput.athleteIds.filter(athleteId =>
            hiddenAthleteIds.has(athleteId)
        );

        if (blockedAthleteIds.length) {
            problems.push(
                `Gallery upload is blocked by person-tag suppression for: ${blockedAthleteIds.join(', ')}.`
            );
        }
    }

    function validateSiteCatalogs(draft, siteCatalogs, problems) {
        if (!isPlainObject(siteCatalogs)) {
            problems.push('Gallery upload site catalogs are required before processing or publication.');
            return;
        }

        if (Object.keys(siteCatalogs).some(key => !allowedManifestSites.has(key))) {
            problems.push('Gallery upload site catalogs contain unsupported site modes.');
        }

        for (const siteMode of draft.siteModes) {
            const catalog = siteCatalogs[siteMode];
            if (!isPlainObject(catalog)) {
                problems.push(`Gallery upload site catalog for "${siteMode}" is required.`);
                continue;
            }

            rejectUnsupportedKeys(
                catalog,
                allowedSiteCatalogKeys,
                `Gallery upload site catalog for "${siteMode}"`,
                problems
            );
            requireKeys(
                catalog,
                [...allowedSiteCatalogKeys],
                `Gallery upload site catalog for "${siteMode}"`,
                problems
            );

            if (catalog.exportBundleId !== draft.exportBundleId) {
                problems.push(`Gallery upload export bundle is stale for site mode "${siteMode}".`);
            }

            if (catalog.sourceRevision !== draft.sourceRevision) {
                problems.push(`Gallery upload source revision is stale for site mode "${siteMode}".`);
            }

            if (!Array.isArray(catalog.races)) {
                problems.push(`Gallery upload site catalog for "${siteMode}" must contain a races array.`);
            } else {
                const seenRaces = new Set();
                catalog.races.forEach((race, index) => {
                    const label = `Gallery upload site catalog for "${siteMode}" race[${index}]`;
                    if (!isPlainObject(race)) {
                        problems.push(`${label} must be an exact race tuple.`);
                        return;
                    }

                    rejectUnsupportedKeys(race, allowedRaceKeys, label, problems);
                    requireKeys(race, [...allowedRaceKeys], label, problems);
                    if (!isRaceTuple(race)) {
                        problems.push(`${label} must contain a valid race date, event, and distance.`);
                        return;
                    }

                    const raceKey = raceTupleKey(race);
                    if (seenRaces.has(raceKey)) {
                        problems.push(
                            `Gallery upload site catalog for "${siteMode}" contains duplicate race tuples.`
                        );
                    } else {
                        seenRaces.add(raceKey);
                    }
                });

                if (!catalog.races.some(race => sameRace(race, draft.itemInput))) {
                    problems.push(
                        `Gallery upload race is not available in the "${siteMode}" site catalog.`
                    );
                }
            }

            if (!Array.isArray(catalog.athleteIds)) {
                problems.push(
                    `Gallery upload site catalog for "${siteMode}" must contain an athleteIds array.`
                );
                continue;
            }

            const availableAthleteIds = new Set();
            catalog.athleteIds.forEach((athleteId, index) => {
                if (!athleteIdPattern(athleteId)) {
                    problems.push(
                        `Gallery upload site catalog for "${siteMode}" athleteIds[${index}] is not a valid public athlete ID.`
                    );
                } else if (availableAthleteIds.has(athleteId)) {
                    problems.push(
                        `Gallery upload site catalog for "${siteMode}" contains duplicate athlete IDs.`
                    );
                } else {
                    availableAthleteIds.add(athleteId);
                }
            });
            for (const athleteId of draft.itemInput.athleteIds) {
                if (!availableAthleteIds.has(athleteId)) {
                    problems.push(
                        `Gallery upload athlete "${athleteId}" is not available in the "${siteMode}" site catalog.`
                    );
                }
            }
        }
    }

    function validateApprovedDerivatives(draft, context, problems) {
        const approvedOrigin = normalizeApprovedOrigin(context?.approvedDerivativeOrigin);
        if (!approvedOrigin) {
            problems.push('Gallery upload requires one exact HTTPS approved-derivative origin.');
            return;
        }

        const approvedDerivatives = context?.approvedDerivatives;
        if (!isPlainObject(approvedDerivatives)) {
            problems.push('Processor-approved derivative URLs are required.');
            return;
        }

        rejectUnsupportedKeys(
            approvedDerivatives,
            allowedDerivativeKeys,
            'Processor-approved derivatives',
            problems
        );
        requireKeys(
            approvedDerivatives,
            [...allowedDerivativeKeys],
            'Processor-approved derivatives',
            problems
        );

        const evidenceBindings = {
            draftId: draft.draftId,
            itemRevision: draft.itemRevision,
            consentRevision: draft.consent.revision,
            exportBundleId: draft.exportBundleId,
            sourceRevision: draft.sourceRevision,
            suppressionRevision: draft.suppressionRevision
        };
        for (const [field, expectedValue] of Object.entries(evidenceBindings)) {
            if (approvedDerivatives[field] !== expectedValue) {
                problems.push('Processor-approved derivative evidence is stale for this draft.');
            }
        }

        for (const field of derivativeUrlFields) {
            if (approvedDerivatives[field] !== draft.manifestItem[field]) {
                problems.push(
                    `Gallery upload manifestItem.${field} must exactly match the processor-approved URL.`
                );
            }
        }

        validateDerivativeUrl(
            approvedDerivatives.sourceUrl,
            approvedOrigin,
            draft.itemInput.type,
            'sourceUrl',
            problems
        );
        validateDerivativeUrl(
            approvedDerivatives.thumbnailUrl,
            approvedOrigin,
            draft.itemInput.type,
            'thumbnailUrl',
            problems
        );

        if (approvedDerivatives.sourceUrl === approvedDerivatives.thumbnailUrl) {
            problems.push('Gallery upload sourceUrl and thumbnailUrl must be different derivatives.');
        }
    }

    function validateDerivativeUrl(value, approvedOrigin, mediaType, role, problems) {
        let url;
        try {
            url = new URL(value);
        } catch {
            problems.push(`Processor-approved ${role} must be an absolute HTTPS URL.`);
            return;
        }

        if (
            url.protocol !== 'https:' ||
            url.username ||
            url.password ||
            url.origin !== approvedOrigin
        ) {
            problems.push(`Processor-approved ${role} must use the exact approved origin.`);
        }

        if (url.search || url.hash) {
            problems.push(`Processor-approved ${role} must not contain a query or fragment.`);
        }

        const pathPattern = mediaType === 'photo'
            ? role === 'sourceUrl' ? photoSourcePathPattern : photoThumbnailPathPattern
            : role === 'sourceUrl' ? videoSourcePathPattern : videoThumbnailPathPattern;
        if (!pathPattern.test(url.pathname)) {
            problems.push(`Processor-approved ${role} does not match the immutable media key grammar.`);
        }
    }

    function normalizeApprovedOrigin(value) {
        if (typeof value !== 'string') {
            return '';
        }

        try {
            const url = new URL(value);
            return url.protocol === 'https:' &&
                !url.username &&
                !url.password &&
                !url.search &&
                !url.hash &&
                url.pathname === '/' &&
                value === url.origin
                ? url.origin
                : '';
        } catch {
            return '';
        }
    }

    function assessIdempotencyReplay(draft, request, record) {
        if (record === undefined || record === null) {
            return null;
        }

        const recordProblems = validateIdempotencyRecord(record);
        if (recordProblems.length) {
            return transitionFailure(draft, recordProblems);
        }

        if (record.idempotencyKey !== request.idempotencyKey) {
            return transitionFailure(draft, [
                'Gallery upload idempotency record does not match the requested key.'
            ]);
        }

        if (record.draftId !== draft.draftId) {
            return transitionFailure(draft, [
                'Gallery upload idempotency record does not match the current draft.'
            ]);
        }

        if (
            record.payloadFingerprint !== request.payloadFingerprint ||
            record.toState !== request.toState ||
            record.expectedStateVersion !== request.expectedStateVersion
        ) {
            return transitionFailure(draft, [
                'Gallery upload idempotency key was already used with a different payload.'
            ]);
        }

        if (
            record.resultStateVersion !== draft.stateVersion ||
            record.toState !== draft.state
        ) {
            return transitionFailure(draft, [
                'Gallery upload idempotency replay no longer matches the current state.'
            ]);
        }

        return Object.freeze({
            ok: true,
            changed: false,
            draft,
            idempotencyRecord: deepFreeze(deepClone(record)),
            problems: Object.freeze([])
        });
    }

    function validateIdempotencyRecord(record) {
        const problems = [];
        if (!isPlainObject(record)) {
            return ['Gallery upload idempotency record must be a JSON object.'];
        }

        rejectUnsupportedKeys(
            record,
            allowedIdempotencyRecordKeys,
            'Gallery upload idempotency record',
            problems
        );
        requireKeys(
            record,
            [...allowedIdempotencyRecordKeys],
            'Gallery upload idempotency record',
            problems
        );

        if (record.schemaVersion !== schemaVersion) {
            problems.push(`Gallery upload idempotency record schemaVersion must be "${schemaVersion}".`);
        }
        if (!draftIdPattern.test(stringValue(record.draftId))) {
            problems.push('Gallery upload idempotency record has an invalid draftId.');
        }
        if (!idempotencyKeyPattern.test(stringValue(record.idempotencyKey))) {
            problems.push('Gallery upload idempotency record has an invalid idempotencyKey.');
        }
        if (!payloadFingerprintPattern.test(stringValue(record.payloadFingerprint))) {
            problems.push('Gallery upload idempotency record has an invalid payloadFingerprint.');
        }
        if (!states.includes(record.fromState) || !states.includes(record.toState)) {
            problems.push('Gallery upload idempotency record has an invalid state.');
        } else if (!canTransitionGalleryUpload(record.fromState, record.toState)) {
            problems.push('Gallery upload idempotency record has an invalid state transition.');
        }
        if (
            !Number.isSafeInteger(record.expectedStateVersion) ||
            record.expectedStateVersion < 0
        ) {
            problems.push('Gallery upload idempotency record has an invalid expectedStateVersion.');
        }
        if (!Number.isSafeInteger(record.resultStateVersion) || record.resultStateVersion < 1) {
            problems.push('Gallery upload idempotency record has an invalid resultStateVersion.');
        } else if (
            Number.isSafeInteger(record.expectedStateVersion) &&
            record.resultStateVersion !== record.expectedStateVersion + 1
        ) {
            problems.push(
                'Gallery upload idempotency record resultStateVersion must advance exactly once.'
            );
        }

        return problems;
    }

    function validateSuppressionDocumentSafely(
        value,
        galleryContract,
        label,
        problems
    ) {
        if (!isPlainObject(value)) {
            problems.push(`${label} must be a JSON object.`);
            return;
        }

        rejectUnsupportedKeys(value, allowedSuppressionDocumentKeys, label, problems);
        const candidate = pickAllowedKeys(value, allowedSuppressionDocumentKeys);
        for (const problem of galleryContract.validateGallerySuppressionDocument(candidate)) {
            problems.push(`${label}: ${problem}`);
        }
    }

    function validateAthleteIdList(value, galleryContract, label, problems) {
        const candidate = {
            schemaVersion: galleryContract.schemaVersion,
            hiddenAthleteIds: value
        };
        for (const problem of galleryContract.validateGallerySuppressionDocument(candidate)) {
            problems.push(`${label}: ${problem}`);
        }
    }

    function validateGalleryDocumentSafely(value, galleryContract, label, problems) {
        if (!isPlainObject(value)) {
            problems.push(`${label} must be a JSON object.`);
            return;
        }

        rejectUnsupportedKeys(value, allowedGalleryDocumentKeys, label, problems);
        let items = value.items;
        if (Array.isArray(items)) {
            items = items.map((item, index) => {
                if (!isPlainObject(item)) {
                    return item;
                }
                rejectUnsupportedKeys(
                    item,
                    allowedManifestItemKeys,
                    `${label} item[${index}]`,
                    problems
                );
                return pickAllowedKeys(item, allowedManifestItemKeys);
            });
        }

        const candidate = {
            schemaVersion: value.schemaVersion,
            items
        };
        for (const problem of galleryContract.validateGalleryDocument(candidate)) {
            problems.push(`${label}: ${problem}`);
        }
    }

    function publicGalleryContract() {
        const contract = root.galleryContract;
        return contract &&
            typeof contract.validateGalleryDocument === 'function' &&
            typeof contract.validateGallerySuppressionDocument === 'function'
            ? contract
            : null;
    }

    function sameRace(race, item) {
        return isPlainObject(race) &&
            race.raceDate === item.raceDate &&
            race.raceEvent === item.raceEvent &&
            race.raceDistance === item.raceDistance;
    }

    function isRaceTuple(value) {
        return isPlainObject(value) &&
            typeof value.raceDate === 'string' &&
            typeof value.raceEvent === 'string' &&
            typeof value.raceDistance === 'string' &&
            isRealIsoDate(value.raceDate) &&
            isBoundedPublicText(value.raceEvent, 300) &&
            isBoundedPublicText(value.raceDistance, 300);
    }

    function raceTupleKey(value) {
        return JSON.stringify([value.raceDate, value.raceEvent, value.raceDistance]);
    }

    function isRealIsoDate(value) {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
            return false;
        }

        const date = new Date(`${value}T00:00:00Z`);
        return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
    }

    function athleteIdPattern(value) {
        return typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
    }

    function isBoundedPublicText(value, maximumLength) {
        return typeof value === 'string' &&
            value.trim().length > 0 &&
            value.length <= maximumLength;
    }

    function validateExclusionRevisions(value, problems) {
        if (!isPlainObject(value)) {
            problems.push('Gallery athlete exclusion requires current revision evidence.');
            return;
        }

        rejectUnsupportedKeys(
            value,
            allowedExclusionRevisionKeys,
            'Gallery athlete exclusion revision evidence',
            problems
        );

        if (!normalizeApprovedOrigin(value.approvedDerivativeOrigin)) {
            problems.push('Gallery athlete exclusion requires one exact HTTPS approved-derivative origin.');
        }

        validateKnownAthleteIds(value.knownAthleteIds, problems);

        for (const field of ['expectedSuppressionRevision', 'currentSuppressionRevision']) {
            if (!revisionPattern.test(stringValue(value[field]))) {
                problems.push(`Gallery athlete exclusion ${field} must be a safe revision identifier.`);
            }
        }

        if (value.expectedSuppressionRevision !== value.currentSuppressionRevision) {
            problems.push('Gallery athlete exclusion suppression revision is stale.');
        }

        for (const field of ['expectedManifestRevisions', 'currentManifestRevisions']) {
            if (!isPlainObject(value[field])) {
                problems.push(`Gallery athlete exclusion ${field} must contain both site modes.`);
                continue;
            }

            if (Object.keys(value[field]).some(key => !allowedManifestSites.has(key))) {
                problems.push(`Gallery athlete exclusion ${field} contains unsupported site modes.`);
            }

            for (const siteMode of siteModes) {
                if (!revisionPattern.test(stringValue(value[field][siteMode]))) {
                    problems.push(
                        `Gallery athlete exclusion ${field}.${siteMode} must be a safe revision identifier.`
                    );
                }
            }
        }

        if (
            isPlainObject(value.expectedManifestRevisions) &&
            isPlainObject(value.currentManifestRevisions)
        ) {
            for (const siteMode of siteModes) {
                if (
                    value.expectedManifestRevisions[siteMode] !==
                    value.currentManifestRevisions[siteMode]
                ) {
                    problems.push(
                        `Gallery athlete exclusion manifest revision is stale for site mode "${siteMode}".`
                    );
                }
            }
        }
    }

    function validateKnownAthleteIds(value, problems) {
        if (!Array.isArray(value)) {
            problems.push('Gallery athlete exclusion knownAthleteIds must be a current public roster array.');
            return;
        }

        const seen = new Set();
        value.forEach((athleteId, index) => {
            if (!athleteIdPattern(athleteId)) {
                problems.push(
                    `Gallery athlete exclusion knownAthleteIds[${index}] is not a valid athlete ID.`
                );
            } else if (seen.has(athleteId)) {
                problems.push('Gallery athlete exclusion knownAthleteIds contains duplicate IDs.');
            } else {
                seen.add(athleteId);
            }
        });
    }

    function suppressionPlanFailure(problems) {
        return deepFreeze({
            ok: false,
            suppressionDocument: null,
            basisRevisions: null,
            correctedManifests: null,
            takedownItems: [],
            ownedObjectUrls: [],
            problems
        });
    }

    function tagChoiceFailure(problems) {
        return deepFreeze({ ok: false, choices: [], problems });
    }

    function transitionFailure(draft, problems) {
        return Object.freeze({
            ok: false,
            changed: false,
            draft,
            idempotencyRecord: null,
            problems: Object.freeze([...problems])
        });
    }

    function rejectUnsupportedKeys(value, allowedKeys, label, problems) {
        if (Object.keys(value).some(key => !allowedKeys.has(key))) {
            problems.push(`${label} contains unsupported fields.`);
        }
    }

    function requireKeys(value, requiredKeys, label, problems) {
        for (const key of requiredKeys) {
            if (!Object.prototype.hasOwnProperty.call(value, key)) {
                problems.push(`${label} is missing required field "${key}".`);
            }
        }
    }

    function pickAllowedKeys(value, allowedKeys) {
        const picked = {};
        for (const key of allowedKeys) {
            if (Object.prototype.hasOwnProperty.call(value, key)) {
                picked[key] = value[key];
            }
        }
        return picked;
    }

    function deepClone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function deepFreeze(value, seen = new Set()) {
        if (value === null || typeof value !== 'object' || seen.has(value)) {
            return value;
        }

        seen.add(value);
        for (const child of Object.values(value)) {
            deepFreeze(child, seen);
        }
        return Object.freeze(value);
    }

    function stringValue(value) {
        return typeof value === 'string' ? value : '';
    }

    function isPlainObject(value) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            return false;
        }

        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    return Object.freeze({
        schemaVersion,
        siteModes,
        states,
        stateTransitions,
        buildAthleteTagChoices,
        canTransitionGalleryUpload,
        createProcessingDispatch,
        createPublicManifestItems,
        planAthleteSuppression,
        transitionGalleryUpload,
        validateAthleteTagSelection,
        validateGalleryUploadApproval,
        validateGalleryUploadCandidate,
        validateGalleryUploadDraft,
        validateGalleryUploadPublication,
        validateTransitionRequest
    });
});
