import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { buildGalleryAdminCatalog } from '../build-gallery-admin-catalog.mjs';
import { repoRoot } from '../export-bundle-tools.mjs';
import { prepareGalleryManifestCandidate } from './candidate-manifest.mjs';
import { createOrReconcileGalleryReview } from './github-review-client.mjs';
import { processGalleryPhoto } from './processor.mjs';

const draftIdPattern = /^draft_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const runIdPattern = /^run_[a-f0-9]{12}4[a-f0-9]{3}[89ab][a-f0-9]{15}$/;
const commitShaPattern = /^[a-f0-9]{40}$/i;
const sha256Pattern = /^[a-f0-9]{64}$/;
const serviceKeys = Object.freeze(['origin', 'clientId', 'clientSecret']);
const optionKeys = Object.freeze([
    'draftId',
    'expectedBaseSha',
    'githubToken',
    'processing',
    'promotion',
    'fetchImpl',
    'root',
    'processPhoto',
    'createReview'
]);

/**
 * Turn one already-approved private photo draft into one unmerged Gallery PR.
 * The only owner-controlled publication input is draftId. All destination,
 * event, distance, athlete, consent, and exclusion facts come from D1 through
 * the two protected service origins.
 */
export async function runPhotoReviewBridge(options) {
    validateOptions(options);
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const processPhoto = options.processPhoto || processGalleryPhoto;
    const createReview = options.createReview || createOrReconcileGalleryReview;
    const root = path.resolve(options.root || repoRoot);
    const processingClient = serviceClient(options.processing, fetchImpl);
    const promotionClient = serviceClient(options.promotion, fetchImpl);
    const draftPath = encodeURIComponent(options.draftId);

    const eligibility = await processingClient.json(
        'GET',
        `/api/service/drafts/${draftPath}/photo-processing-eligibility`
    );
    assertEligibility(eligibility, options.draftId);

    const startKey = operationKey('photo-start', options.draftId, eligibility.stateVersion);
    const run = await processingClient.json(
        'POST',
        `/api/service/drafts/${draftPath}/processing-runs`,
        {
            expectedStateVersion: eligibility.stateVersion,
            idempotencyKey: startKey
        }
    );
    assertProcessingRun(run, options.draftId);

    let processed;
    try {
        const sourceResponse = await processingClient.raw('GET', run.source.downloadPath);
        if (sourceResponse.headers.get('Content-Length') !== String(run.source.byteLength)) {
            throw new Error('The private-photo response length does not match its bound evidence.');
        }
        const sourceBytes = Buffer.from(await sourceResponse.arrayBuffer());
        assertSourceResponse(sourceResponse, sourceBytes, run.source);
        processed = await processPhoto({
            sourceBytes,
            fileExtension: run.source.fileExtension,
            declaredMimeType: run.source.declaredMimeType,
            expectedSha256: run.source.sha256,
            draftBinding: {
                site: run.site,
                draftId: options.draftId,
                processingRunId: run.processingRunId
            }
        });
        assertProcessedPhoto(processed, run, options.draftId);

        for (const derivative of processed.derivatives) {
            const bytes = Buffer.from(await derivative.payload.arrayBuffer());
            await processingClient.raw(
                'PUT',
                `/api/service/processing-runs/${encodeURIComponent(run.processingRunId)}` +
                    `/derivatives/${encodeURIComponent(derivative.storageRole)}`,
                bytes,
                {
                    'Content-Type': 'image/webp',
                    'Content-Length': String(bytes.byteLength),
                    'X-Gallery-Content-SHA256': derivative.sha256,
                    'Idempotency-Key': operationKey(
                        `photo-${derivative.storageRole}`,
                        options.draftId,
                        run.stateVersion
                    )
                }
            );
        }
    } catch (error) {
        await failAndCleanProcessing(processingClient, run, options.draftId, error);
        throw error;
    }

    const staged = await processingClient.json(
        'POST',
        `/api/service/processing-runs/${encodeURIComponent(run.processingRunId)}/result`,
        stagedResult(run, processed, options.draftId)
    );
    if (staged?.status !== 'staged' || staged.stateVersion !== run.stateVersion) {
        throw new Error('The processing service did not confirm the exact staged photo run.');
    }

    const promoted = await promotionClient.json(
        'POST',
        `/api/service/drafts/${draftPath}/photo-promotions`,
        {
            expectedStateVersion: staged.stateVersion,
            idempotencyKey: operationKey(
                'photo-promotion',
                options.draftId,
                staged.stateVersion
            )
        }
    );
    const candidateBeforeReview = exactCandidate(promoted?.candidate);
    const candidateRead = await promotionClient.json(
        'GET',
        `/api/service/drafts/${draftPath}/photo-candidate`
    );
    const currentCandidate = exactCandidate(candidateRead?.candidate);
    assertSameCandidate(candidateBeforeReview, currentCandidate);

    const manifestsBySite = await readCurrentManifests(root);
    const catalogSnapshot = await buildGalleryAdminCatalog(root);
    const candidateResult = prepareGalleryManifestCandidate(currentCandidate, {
        catalogSnapshot,
        manifestsBySite,
        replayReceipt: null
    });
    if (!candidateResult.changed) {
        throw new Error('The approved Gallery photo is already present on current main.');
    }

    const review = await createReview(candidateResult, {
        expectedBaseSha: options.expectedBaseSha,
        token: options.githubToken,
        fetchImpl
    });

    // A consent withdrawal or new exclusion may land while GitHub is creating
    // the branch and PR. Re-read the complete D1/R2 candidate evidence and do
    // not report success if it changed. The PR remains unmerged for owner review.
    const candidateAfterReview = exactCandidate((await promotionClient.json(
        'GET',
        `/api/service/drafts/${draftPath}/photo-candidate`
    ))?.candidate);
    assertSameCandidate(currentCandidate, candidateAfterReview);

    return Object.freeze({
        schemaVersion: '1.0',
        draftId: options.draftId,
        itemId: candidateResult.itemId,
        targetRelativePath: candidateResult.targetRelativePath,
        manifestSha256: candidateResult.manifestSha256,
        pullRequest: review.pullRequest
    });
}

function serviceClient(configuration, fetchImpl) {
    const origin = normalizeOrigin(configuration.origin);
    const accessHeaders = {
        'CF-Access-Client-Id': configuration.clientId,
        'CF-Access-Client-Secret': configuration.clientSecret
    };
    return {
        async raw(method, requestPath, body = undefined, extraHeaders = {}) {
            const response = await fetchImpl(`${origin}${requestPath}`, {
                method,
                headers: { ...accessHeaders, ...extraHeaders },
                body,
                redirect: 'error'
            });
            if (!(response instanceof Response) || !response.ok) {
                throw new Error(`Protected Gallery service request failed with status ${response?.status || 503}.`);
            }
            return response;
        },
        async json(method, requestPath, body = undefined) {
            let payload;
            const headers = {};
            if (body !== undefined) {
                payload = JSON.stringify(body);
                headers['Content-Type'] = 'application/json';
                headers['Content-Length'] = String(Buffer.byteLength(payload));
            }
            const response = await this.raw(method, requestPath, payload, headers);
            if (response.headers.get('Content-Type')?.split(';')[0] !== 'application/json') {
                throw new Error('Protected Gallery service returned a non-JSON response.');
            }
            return response.json();
        }
    };
}

async function failAndCleanProcessing(client, run, draftId, error) {
    const allowedCodes = new Set([
        'cleanup-failed',
        'derivative-rejected',
        'invalid-media',
        'metadata-scan-failed',
        'processing-failed',
        'source-rejected',
        'toolchain-unavailable'
    ]);
    const errorCode = allowedCodes.has(error?.code) ? error.code : 'processing-failed';
    try {
        const failed = await client.json(
            'POST',
            `/api/service/processing-runs/${encodeURIComponent(run.processingRunId)}/result`,
            {
                outcome: 'failed',
                expectedStateVersion: run.stateVersion,
                idempotencyKey: operationKey('photo-failed', draftId, run.stateVersion),
                errorCode
            }
        );
        if (failed?.state === 'processing-failed' && Number.isSafeInteger(failed.stateVersion)) {
            await client.json(
                'POST',
                `/api/service/processing-runs/${encodeURIComponent(run.processingRunId)}/cleanup`,
                {
                    expectedStateVersion: failed.stateVersion,
                    idempotencyKey: operationKey('photo-cleanup', draftId, failed.stateVersion)
                }
            );
        }
    } catch {
        // Preserve the original safe processing failure. Server-side retention
        // and retry evidence remain authoritative if cleanup could not finish.
    }
}

function stagedResult(run, processed, draftId) {
    return {
        outcome: 'staged',
        expectedStateVersion: run.stateVersion,
        idempotencyKey: operationKey('photo-staged', draftId, run.stateVersion),
        source: {
            sha256: processed.source.sha256,
            byteLength: processed.source.byteLength,
            detectedFormat: processed.source.detectedFormat
        },
        toolchain: { ...processed.toolchain },
        derivatives: processed.derivatives.map(derivative => ({
            role: derivative.storageRole,
            sha256: derivative.sha256,
            byteLength: derivative.byteLength,
            width: derivative.width,
            height: derivative.height,
            durationMilliseconds: null,
            metadataEntryCount: derivative.metadataEntryCount,
            metadataFindingCategories: []
        }))
    };
}

async function readCurrentManifests(root) {
    const values = {};
    for (const site of ['family', 'everyone']) {
        const text = await fs.readFile(path.join(root, 'gallery-data', `${site}.json`), 'utf8');
        values[site] = JSON.parse(text);
    }
    return values;
}

function validateOptions(options) {
    if (!plainObject(options) || Object.keys(options).some(key => !optionKeys.includes(key))) {
        throw new Error('The photo review bridge options are invalid.');
    }
    if (
        !draftIdPattern.test(options.draftId || '') ||
        !commitShaPattern.test(options.expectedBaseSha || '') ||
        typeof options.githubToken !== 'string' ||
        options.githubToken.length < 1 ||
        typeof (options.fetchImpl || globalThis.fetch) !== 'function' ||
        (options.processPhoto !== undefined && typeof options.processPhoto !== 'function') ||
        (options.createReview !== undefined && typeof options.createReview !== 'function')
    ) {
        throw new Error('The photo review bridge configuration is invalid.');
    }
    validateService(options.processing);
    validateService(options.promotion);
}

function validateService(value) {
    if (
        !plainObject(value) ||
        Object.keys(value).sort().join(',') !== [...serviceKeys].sort().join(',') ||
        normalizeOrigin(value.origin) === null ||
        !safeSecret(value.clientId) ||
        !safeSecret(value.clientSecret)
    ) {
        throw new Error('A protected Gallery service configuration is invalid.');
    }
}

function normalizeOrigin(value) {
    try {
        const url = new URL(value);
        return typeof value === 'string' && value === url.origin && url.protocol === 'https:'
            ? url.origin
            : null;
    } catch {
        return null;
    }
}

function safeSecret(value) {
    return typeof value === 'string' && value.length >= 1 && value.length <= 4096 &&
        !/[\u0000-\u001f\u007f]/.test(value);
}

function assertEligibility(value, draftId) {
    if (
        !plainObject(value) ||
        value.schemaVersion !== '1.0' ||
        value.draftId !== draftId ||
        value.state !== 'approved-for-processing' ||
        !Number.isSafeInteger(value.stateVersion) ||
        value.stateVersion < 0
    ) throw new Error('The processing service did not return current photo eligibility.');
}

function assertProcessingRun(run, draftId) {
    if (
        !plainObject(run) ||
        run.scope !== 'photo-processing-v1' ||
        !['family', 'everyone'].includes(run.site) ||
        run.mediaType !== 'photo' ||
        run.state !== 'processing' ||
        !Number.isSafeInteger(run.stateVersion) ||
        !runIdPattern.test(run.processingRunId || '') ||
        !plainObject(run.source) ||
        !sha256Pattern.test(run.source.sha256 || '') ||
        !Number.isSafeInteger(run.source.byteLength) ||
        run.source.byteLength < 1 ||
        run.source.byteLength > 25 * 1024 * 1024 ||
        !['jpg', 'png'].includes(run.source.fileExtension) ||
        !['image/jpeg', 'image/png'].includes(run.source.declaredMimeType) ||
        run.source.declaredMimeType !==
            (run.source.fileExtension === 'jpg' ? 'image/jpeg' : 'image/png') ||
        run.source.downloadPath !==
            `/api/service/processing-runs/${run.processingRunId}/original`
    ) throw new Error(`The processing service returned an invalid run for ${draftId}.`);
}

function assertSourceResponse(response, bytes, source) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (
        response.headers.get('Cache-Control') !== 'no-store' ||
        response.headers.get('Content-Length') !== String(source.byteLength) ||
        response.headers.get('X-Gallery-Content-SHA256') !== source.sha256 ||
        response.headers.get('Content-Type') !== source.declaredMimeType ||
        bytes.byteLength !== source.byteLength ||
        digest !== source.sha256
    ) throw new Error('The downloaded private photo did not match its bound upload evidence.');
}

function assertProcessedPhoto(processed, run, draftId) {
    const roles = processed?.derivatives?.map(value => value.storageRole).sort();
    if (
        processed?.scope !== 'photo-processing-v1' ||
        processed?.draftId !== draftId ||
        processed?.inheritedSite !== run.site ||
        processed?.processingRunId !== run.processingRunId ||
        processed?.source?.sha256 !== run.source.sha256 ||
        JSON.stringify(roles) !== JSON.stringify(['photo-display', 'photo-thumbnail'])
    ) throw new Error('The pinned processor did not return the exact bound photo derivatives.');
}

function exactCandidate(candidate) {
    if (!plainObject(candidate) || candidate.schemaVersion !== '1.0') {
        throw new Error('The promotion service did not return a valid photo candidate.');
    }
    return candidate;
}

function assertSameCandidate(left, right) {
    if (JSON.stringify(left) !== JSON.stringify(right)) {
        throw new Error('The Gallery candidate changed during review generation.');
    }
}

function operationKey(label, draftId, stateVersion) {
    return `${label}-${createHash('sha256')
        .update(`${label}:${draftId}:${stateVersion}`)
        .digest('hex')
        .slice(0, 32)}`;
}

function plainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
        (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
