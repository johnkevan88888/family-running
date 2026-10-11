import '../../gallery-upload-contract.js';
import {loadPrivateGalleryRoster} from './private-gallery-roster-service.js';
import {hashIdentity} from './session.js';
import {sha256Hex} from './media-byte-verification.js';
import {PUBLIC_HOST_VERIFIER_SQL} from './public-host-verifier-service.js';
import {MEDIA_BINDING_WITNESS_KEY,MEDIA_BINDING_WITNESS_SHA256,MEDIA_BINDING_WITNESS_SIZE,
    MEDIA_BINDING_WITNESS_CONTENT_TYPE,MEDIA_DELIVERY_CONTRACT_VALUE} from './media-delivery-contract.js';

const mint=Symbol('request-local archive authority');
const attempts=/^attempt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const purposes=Object.freeze({
    processing:Object.freeze(['read','admit','source','staging','close','remove-staging']),
    promotion:Object.freeze(['read','approved','candidate','close','remove-approved']),
    verifier:Object.freeze(['read','verify']),
    finalizer:Object.freeze(['read','finalize','purge'])
});
const digest=value=>sha256Hex(new TextEncoder().encode(value));

// No request state is kept globally. Each authenticated request owns its scope;
// plain/serialized objects cannot become scopes and no browser identity is made.
class ArchiveServiceAuthority {
    #site; #attempt; #owner; #purpose; #identity; #origin; #version;
    constructor(token,env,site,attempt,owner,purpose) {
        if(token!==mint) throw new Error('Unavailable');
        this.#site=site;this.#attempt=attempt;this.#owner=owner;this.#purpose=purpose;
        this.#identity=env.ARCHIVE_SERVICE_IDENTITY;
        this.#origin=env.APPROVED_MEDIA_ORIGIN;this.#version=env.EXPECTED_MEDIA_VERSION;
        Object.freeze(this);
    }
    owner(env,site,attempt,operation) {
        if(this.#site!==site || this.#attempt!==attempt || !purposes[this.#purpose].includes(operation) ||
            env.ARCHIVE_SERVICE_IDENTITY!==this.#identity || env.APPROVED_MEDIA_ORIGIN!==this.#origin ||
            env.EXPECTED_MEDIA_VERSION!==this.#version) throw new Error('Unavailable');
        return this.#owner;
    }
    tier(env,site,attempt) {
        this.owner(env,site,attempt,'read');
        if(this.#purpose==='processing') return 'staging';
        if(this.#purpose==='promotion') return 'approved';
        throw new Error('Unavailable');
    }
}

export function isArchiveServiceAuthority(identity) {return identity instanceof ArchiveServiceAuthority;}
export function archiveServiceTier(identity,env,site,attempt) {
    return identity instanceof ArchiveServiceAuthority?identity.tier(env,site,attempt):null;
}
export async function archiveOperationOwner(env,identity,site,attempt,operation='read') {
    if(identity instanceof ArchiveServiceAuthority) {
        const owner=identity.owner(env,site,attempt,operation);
        await readArchiveMediaEpoch(env); // Mandatory on every service operation, never a ledger fallback.
        return owner;
    }
    if(identity?.type!=='browser') throw new Error('Unavailable');
    return hashIdentity(identity);
}

// Called only by an HTTP adapter AFTER Worker-level Access authentication. The
// exact single service identity is still checked here, independently of the route.
export async function issueArchiveServiceAuthority(env,verifiedIdentity,site,attempt,purpose) {
    if(!Object.hasOwn(purposes,purpose) || !['family','everyone'].includes(site) || !attempts.test(attempt||'') ||
        verifiedIdentity?.type!=='service' || !/^[0-9a-f]{32}\.access$/.test(verifiedIdentity.subject||'') ||
        env.ARCHIVE_SERVICE_IDENTITY!==`subject:${verifiedIdentity.subject}`) throw new Error('Unavailable');
    await readArchiveMediaEpoch(env);
    const row=await env.DB.prepare(`SELECT a.owner_identity_hash FROM private_gallery_attempts a
        JOIN private_gallery_assets s ON s.asset_id=a.asset_id AND s.site_mode=a.site_mode
            AND s.owner_identity_hash=a.owner_identity_hash WHERE a.attempt_id=?1 AND a.site_mode=?2`)
        .bind(attempt,site).first();
    if(!/^[0-9a-f]{64}$/.test(row?.owner_identity_hash||'')) throw new Error('Unavailable');
    return new ArchiveServiceAuthority(mint,env,site,attempt,row.owner_identity_hash,purpose);
}

// Finalization consumes an existing owner request, never creates one. Its
// authority names an asset rather than a processing attempt and has no source,
// writer, promotion or public-consent operation.
export async function issueArchiveFinalizerAuthority(env,verifiedIdentity,site,asset) {
    if(!['family','everyone'].includes(site) || !/^asset_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(asset||'') ||
        verifiedIdentity?.type!=='service' || !/^[0-9a-f]{32}\.access$/.test(verifiedIdentity.subject||'') ||
        env.ARCHIVE_SERVICE_IDENTITY!==`subject:${verifiedIdentity.subject}`) throw new Error('Unavailable');
    await readArchiveMediaEpoch(env);
    const row=await env.DB.prepare(`SELECT a.owner_identity_hash FROM private_gallery_assets a
        JOIN private_archive_deletion_requests d ON d.asset_id=a.asset_id AND d.actor_identity_hash=a.owner_identity_hash
        WHERE a.asset_id=?1 AND a.site_mode=?2`).bind(asset,site).first();
    if(!/^[0-9a-f]{64}$/.test(row?.owner_identity_hash||'')) throw new Error('Unavailable');
    return new ArchiveServiceAuthority(mint,env,site,asset,row.owner_identity_hash,'finalizer');
}

export async function recheckArchiveServiceConsent(env,row,catalog) {
    const {document,generation}=await loadPrivateGalleryRoster(env,row.site_mode);
    if(!document || generation!==row.roster_generation || catalog?.exportBundleId!==row.export_bundle_id ||
        catalog?.sourceRevision!==row.source_revision || catalog?.suppressionRevision!==row.suppression_revision ||
        row.complete_tags_confirmed!==1 || row.public_use_confirmed!==1 || ![0,1].includes(row.contains_minors) ||
        row.guardian_approval_confirmed!==row.contains_minors || !await env.DB.prepare(
            'SELECT 1 FROM private_gallery_current_attempt_permissions WHERE attempt_id=?1').bind(row.attempt_id).first()) throw new Error('Changed');
    const race={raceDate:row.race_date,raceEvent:row.race_event,raceDistance:row.race_distance};
    const consentRevision=`consent_${row.idempotency_key}`;
    const view={schemaVersion:'1.0',draftId:`draft_${row.idempotency_key}`,state:'draft',stateVersion:0,siteModes:[row.site_mode],
        exportBundleId:row.export_bundle_id,sourceRevision:row.source_revision,suppressionRevision:row.suppression_revision,
        itemRevision:`item_${row.idempotency_key}`,manifestItem:null,withdrawalEvidence:null,
        itemInput:{id:row.public_item_id,type:'photo',title:'Photo',caption:'',alt:'Photo',...race,featured:false,
            athleteIds:JSON.parse(row.public_athlete_ids_json)},
        consent:{publicUseConfirmed:true,containsMinors:Boolean(row.contains_minors),
            guardianApprovalConfirmed:Boolean(row.guardian_approval_confirmed),revision:consentRevision}};
    if(globalThis.galleryUploadContract.validateGalleryUploadApproval(view,{consentRevision,
        suppressionDocument:catalog.suppressionDocument,suppressionRevision:catalog.suppressionRevision,pendingHiddenAthleteIds:[],
        siteCatalogs:{[row.site_mode]:catalog.sites?.[row.site_mode]?.catalog}}).length) throw new Error('Changed');
}

// Same mandatory configured origin/version/witness checks as the original 0023
// lifecycle. Neither service scopes nor cleanup can make any field optional.
export async function readArchiveMediaEpoch(env) {
    const e=await env.DB.prepare(PUBLIC_HOST_VERIFIER_SQL.readCurrentEpoch).first();
    const origin=env.APPROVED_MEDIA_ORIGIN;
    if(!e || typeof origin!=='string' || !/^https:\/\/[a-z0-9.-]+$/.test(origin) ||
        e.approvedOrigin!==origin || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(env.EXPECTED_MEDIA_VERSION||'') ||
        e.approvedOriginHash!==await digest(`approved-media-origin:${origin}`) ||
        e.deliveryContractHash!==await digest(`approved-media-contract:${MEDIA_DELIVERY_CONTRACT_VALUE}`) ||
        e.deliveryVersionHash!==await digest(`approved-media-version:${env.EXPECTED_MEDIA_VERSION}`) ||
        e.witnessObjectKeyHash!==await digest(`approved-object-key:${MEDIA_BINDING_WITNESS_KEY}`) ||
        e.witnessSha256!==MEDIA_BINDING_WITNESS_SHA256 || e.witnessByteCount!==MEDIA_BINDING_WITNESS_SIZE ||
        e.witnessContentType!==MEDIA_BINDING_WITNESS_CONTENT_TYPE) throw new Error('Epoch unavailable');
    return e;
}
