import {sha256Hex} from './media-byte-verification.js';

export const archiveRetirementHash=(kind,value)=>sha256Hex(new TextEncoder().encode(`private-gallery-${kind}:${value}`));
export async function assertArchiveIdentityAvailable(env,kind,value) {
    const hash=await archiveRetirementHash(kind,value);
    const queries={
        asset:'SELECT 1 FROM private_archive_purge_receipts WHERE asset_id_hash=?1',
        reservation:'SELECT 1 FROM private_archive_purge_receipts WHERE reservation_key_hash=?1',
        generation:'SELECT 1 FROM private_gallery_retired_generations WHERE generation_hash=?1',
        item:'SELECT 1 FROM private_gallery_retired_generations WHERE item_hash=?1',
        key:'SELECT 1 FROM private_gallery_retired_keys WHERE key_hash=?1'
    };
    if(!Object.hasOwn(queries,kind)) throw new Error('Unavailable');
    const result=await env.DB.prepare(`${queries[kind]} LIMIT 1`).bind(hash).all();
    if(result?.success!==true || !Array.isArray(result.results) || result.results.length) throw new Error('Retired or unavailable');
}
