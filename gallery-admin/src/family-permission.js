// Shared SQL-only permission reader. No storage, GitHub or publication capability.
export async function requireFamilyPermission(env, ownerHash, site, version, containsMinors) {
    if (site !== 'family' || !Number.isSafeInteger(version) || version < 1 || typeof containsMinors !== 'boolean') {
        throw new Error('Standing permission unavailable');
    }
    const row = await env.DB.prepare('SELECT * FROM family_gallery_current_permission WHERE owner_hash=?1')
        .bind(ownerHash).first();
    if (!row || row.version !== version || row.active !== 1 || containsMinors && row.guardians !== 1) {
        throw new Error('Standing permission changed');
    }
    return row;
}

export function standingPermissionReplayInput(row) {
    return row.standing_permission_version == null ? {} : {standingPermissionVersion: row.standing_permission_version};
}
