import { PROCESSING_REHEARSAL_HEADER } from './processing-worker.js';

export const PROCESSING_REHEARSAL_FIXTURE = Object.freeze({
    publicItemId: 'synthetic-phase-d-race-rehearsal',
    siteModesJson: '["family"]',
    raceDate: '2026-08-22',
    raceEvent: 'Budapest Park, Toronto - Parkrun',
    raceDistance: '5 km',
    athleteIdsJson: '["john-kevan"]',
    originalSha256:
        '6768c0fdd5f22b6eed7425d141a4b69da531ccfa68d9f59ca9388d656f0b81ff'
});
export const PROCESSING_REHEARSAL_PUBLIC_ITEM_ID =
    PROCESSING_REHEARSAL_FIXTURE.publicItemId;
const MODE_ROUTES = Object.freeze({
    'after-upload-part': Object.freeze({
        kind: 'derivative',
        method: 'PUT',
        role: 'photo-display'
    }),
    'after-complete': Object.freeze({
        kind: 'derivative',
        method: 'PUT',
        role: 'photo-display'
    }),
    'after-abort': Object.freeze({ kind: 'cleanup', method: 'POST' }),
    'after-delete': Object.freeze({ kind: 'cleanup', method: 'POST' })
});

export const PROCESSING_REHEARSAL_MODES = Object.freeze(Object.keys(MODE_ROUTES));

export async function prepareProcessingRehearsalRequest({ env, request, route }) {
    const mode = request.headers.get(PROCESSING_REHEARSAL_HEADER);
    const expectedRoute = MODE_ROUTES[mode];
    if (
        !expectedRoute ||
        route?.kind !== expectedRoute.kind ||
        request.method !== expectedRoute.method ||
        typeof route.processingRunId !== 'string' ||
        expectedRoute.role !== undefined && route.role !== expectedRoute.role
    ) {
        return failure(403);
    }

    let evidence;
    try {
        evidence = await queryFirst(env.DB, `
            SELECT
                upload.synthetic_only_confirmed AS syntheticOnlyConfirmed,
                draft.public_item_id AS publicItemId,
                draft.site_modes_json AS siteModesJson,
                draft.race_date AS raceDate,
                draft.race_event AS raceEvent,
                draft.race_distance AS raceDistance,
                draft.athlete_ids_json AS athleteIdsJson,
                draft.original_sha256 AS originalSha256,
                draft.media_type AS draftMediaType,
                run.media_type AS runMediaType
            FROM draft_processing_runs AS run
            JOIN gallery_drafts AS draft
              ON draft.draft_id = run.draft_id
            JOIN draft_upload_sessions AS upload
              ON upload.upload_session_id = run.upload_session_id
             AND upload.draft_id = run.draft_id
            WHERE run.processing_run_id = ?1
        `, route.processingRunId);
    } catch {
        return failure(503);
    }
    if (
        evidence?.syntheticOnlyConfirmed !== 1 ||
        evidence.publicItemId !== PROCESSING_REHEARSAL_FIXTURE.publicItemId ||
        evidence.siteModesJson !== PROCESSING_REHEARSAL_FIXTURE.siteModesJson ||
        evidence.raceDate !== PROCESSING_REHEARSAL_FIXTURE.raceDate ||
        evidence.raceEvent !== PROCESSING_REHEARSAL_FIXTURE.raceEvent ||
        evidence.raceDistance !== PROCESSING_REHEARSAL_FIXTURE.raceDistance ||
        evidence.athleteIdsJson !== PROCESSING_REHEARSAL_FIXTURE.athleteIdsJson ||
        evidence.originalSha256 !== PROCESSING_REHEARSAL_FIXTURE.originalSha256 ||
        evidence.draftMediaType !== 'photo' ||
        evidence.runMediaType !== 'photo'
    ) {
        return failure(403);
    }

    let strippedRequest;
    try {
        const headers = new Headers(request.headers);
        headers.delete(PROCESSING_REHEARSAL_HEADER);
        strippedRequest = new Request(request, { headers });
    } catch {
        return failure(503);
    }

    const fault = createProcessingRehearsalFault(env.DERIVATIVE_STAGING, mode);
    return Object.freeze({
        ok: true,
        status: 200,
        request: strippedRequest,
        env: Object.freeze({
            DB: env.DB,
            PRIVATE_ORIGINALS: env.PRIVATE_ORIGINALS,
            DERIVATIVE_STAGING: fault.bucket,
            PROCESSOR_IDENTITIES: env.PROCESSOR_IDENTITIES,
            PROCESSING_ORIGIN: env.PROCESSING_ORIGIN
        }),
        shouldInterruptProviderRecovery: fault.shouldInterruptProviderRecovery
    });
}

export function createProcessingRehearsalFault(bucket, mode) {
    if (!MODE_ROUTES[mode]) {
        throw new TypeError('Unsupported processing rehearsal mode.');
    }
    const lostResponses = new WeakSet();
    let injected = false;

    async function call(operation, receiver, method, args) {
        const result = await Reflect.apply(method, receiver, args);
        if (!injected && mode === `after-${operation}`) {
            injected = true;
            const error = new Error('The rehearsal provider response was unavailable.');
            error.name = 'ProcessingRehearsalResponseLost';
            lostResponses.add(error);
            throw error;
        }
        return result;
    }

    const rehearsalBucket = Object.freeze({
        head(...args) {
            return Reflect.apply(bucket.head, bucket, args);
        },
        get(...args) {
            return Reflect.apply(bucket.get, bucket, args);
        },
        delete(...args) {
            return call('delete', bucket, bucket.delete, args);
        },
        list(...args) {
            return Reflect.apply(bucket.list, bucket, args);
        },
        createMultipartUpload(...args) {
            return Reflect.apply(bucket.createMultipartUpload, bucket, args);
        },
        resumeMultipartUpload(...args) {
            const multipart = Reflect.apply(
                bucket.resumeMultipartUpload,
                bucket,
                args
            );
            return wrapMultipart(multipart, call);
        }
    });

    return Object.freeze({
        bucket: rehearsalBucket,
        shouldInterruptProviderRecovery(error, operation) {
            return mode === 'after-complete' &&
                operation === 'complete' &&
                lostResponses.has(error);
        }
    });
}

function wrapMultipart(multipart, call) {
    if (!multipart || typeof multipart !== 'object') {
        return multipart;
    }
    return Object.freeze({
        key: multipart.key,
        uploadId: multipart.uploadId,
        uploadPart(...args) {
            return call('upload-part', multipart, multipart.uploadPart, args);
        },
        complete(...args) {
            return call('complete', multipart, multipart.complete, args);
        },
        abort(...args) {
            return call('abort', multipart, multipart.abort, args);
        }
    });
}

async function queryFirst(database, sql, ...bindings) {
    const statement = database.prepare(sql).bind(...bindings);
    if (typeof statement.first === 'function') {
        return statement.first();
    }
    const result = await statement.all();
    return Array.isArray(result?.results) ? result.results[0] ?? null : null;
}

function failure(status) {
    return Object.freeze({ ok: false, status });
}
