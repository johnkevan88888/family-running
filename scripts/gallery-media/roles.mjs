const POLICY_ROLE_PATTERN = /^(photo-display|photo-thumbnail|video-playback|video-poster)$/;

export const POLICY_TO_STORAGE_ROLE = Object.freeze({
    'photo-display': 'photo-display',
    'photo-thumbnail': 'photo-thumbnail',
    'video-playback': 'video',
    'video-poster': 'video-poster'
});

export const REQUIRED_POLICY_ROLES = Object.freeze({
    photo: Object.freeze(['photo-display', 'photo-thumbnail']),
    video: Object.freeze(['video-playback', 'video-poster'])
});

export function storageRoleForPolicyRole(policyRole) {
    if (
        typeof policyRole !== 'string' ||
        !POLICY_ROLE_PATTERN.test(policyRole) ||
        !Object.hasOwn(POLICY_TO_STORAGE_ROLE, policyRole)
    ) {
        throw new TypeError('Unsupported Gallery derivative role.');
    }

    return POLICY_TO_STORAGE_ROLE[policyRole];
}

export function requiredPolicyRolesForMediaType(mediaType) {
    const roles = typeof mediaType === 'string' && Object.hasOwn(REQUIRED_POLICY_ROLES, mediaType)
        ? REQUIRED_POLICY_ROLES[mediaType]
        : null;

    if (!roles) {
        throw new TypeError('Unsupported Gallery media type.');
    }

    return roles;
}
