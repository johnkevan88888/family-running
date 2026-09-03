const repositoryOwner = 'johnkevan88888';
const repositoryName = 'family-running';
const repositoryFullName = `${repositoryOwner}/${repositoryName}`;
const baseRef = 'main';
const mainRulesetId = 18119142;
const apiOrigin = 'https://api.github.com';
const repositoryApiPath = `/repos/${repositoryFullName}`;
const apiVersion = '2022-11-28';
const commitShaPattern = /^[a-f0-9]{40}$/i;
const policyDenialMessages = new Set([
    'Repository rule violations found',
    'Protected branch update failed'
]);
const protectedRefValidationMessage = 'Validation Failed';
const protectedRefErrorMessages = new Set([
    'Cannot update this protected ref',
    'Cannot update this protected ref.'
]);

/**
 * Prove, before any media service is contacted, that this exact short-lived
 * App token is subject to the owner-only main update restriction.
 *
 * The PATCH deliberately supplies main's current SHA, so even an unexpected
 * success cannot change branch contents. Success is nevertheless rejected:
 * only a rules-owned denial plus an unchanged ref is acceptable. Because a PR
 * merge updates the same protected ref, the same restriction also removes the
 * App's merge capability while leaving candidate-branch and PR creation intact.
 */
export async function verifyGalleryReviewBoundary(options) {
    requireExactKeys(options, ['expectedBaseSha', 'token', 'fetchImpl']);
    const expectedBaseSha = validateCommitSha(options.expectedBaseSha, 'expectedBaseSha');
    const token = validateToken(options.token);
    const fetchImpl = validateFetch(options.fetchImpl);

    const before = await requestJson(fetchImpl, token, 'GET', '/git/ref/heads/main');
    assertMainRef(before, expectedBaseSha);

    const rules = await requestJson(
        fetchImpl,
        token,
        'GET',
        '/rules/branches/main?per_page=100'
    );
    assertRequiredRules(rules);

    const denial = await requestRaw(
        fetchImpl,
        token,
        'PATCH',
        '/git/refs/heads/main',
        { sha: expectedBaseSha, force: false }
    );
    await assertRuleOwnedDenial(denial);

    const after = await requestJson(fetchImpl, token, 'GET', '/git/ref/heads/main');
    assertMainRef(after, expectedBaseSha);

    return Object.freeze({
        schemaVersion: '1.0',
        repository: repositoryFullName,
        baseRef,
        baseSha: expectedBaseSha,
        rulesetId: mainRulesetId,
        directMainUpdateDenied: true,
        mergeDeniedByUpdateRestriction: true,
        mainRefUnchanged: true
    });
}

async function requestJson(fetchImpl, token, method, relativePath) {
    const response = await requestRaw(fetchImpl, token, method, relativePath);
    if (!response.ok) {
        throw new Error(`Gallery review permission ${method} failed with status ${response.status}.`);
    }
    try {
        return await response.json();
    } catch {
        throw new Error(`Gallery review permission ${method} returned invalid JSON.`);
    }
}

async function requestRaw(fetchImpl, token, method, relativePath, body) {
    let response;
    try {
        response = await fetchImpl(`${apiOrigin}${repositoryApiPath}${relativePath}`, {
            method,
            redirect: 'error',
            headers: {
                Accept: 'application/vnd.github+json',
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'family-running-gallery-review-boundary',
                'X-GitHub-Api-Version': apiVersion
            },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
    } catch {
        throw new Error(`Gallery review permission ${method} did not return a response.`);
    }
    if (!response || !Number.isSafeInteger(response.status)) {
        throw new Error(`Gallery review permission ${method} returned an invalid response.`);
    }
    return response;
}

function assertMainRef(value, expectedBaseSha) {
    if (
        !isPlainObject(value) ||
        value.ref !== 'refs/heads/main' ||
        value.object?.type !== 'commit' ||
        validateCommitSha(value.object?.sha, 'main ref SHA') !== expectedBaseSha
    ) {
        throw new Error('Gallery review permission proof found a changed or malformed main ref.');
    }
}

function assertRequiredRules(value) {
    if (!Array.isArray(value)) {
        throw new Error('Gallery review permission proof did not receive the active main rules.');
    }
    // GitHub labels this setting "Restrict updates" in the ruleset UI, but
    // the effective branch-rules API represents it with the stable type
    // value `update`.
    const requiredTypes = ['update', 'pull_request', 'required_status_checks'];
    for (const type of requiredTypes) {
        const matches = value.filter(rule =>
            isPlainObject(rule) &&
            rule.type === type &&
            rule.ruleset_id === mainRulesetId &&
            rule.ruleset_source_type === 'Repository' &&
            rule.ruleset_source === repositoryFullName
        );
        if (matches.length !== 1) {
            throw new Error(`Gallery review permission proof requires one exact ${type} main rule.`);
        }
    }
}

async function assertRuleOwnedDenial(response) {
    if (response.ok) {
        throw new Error('Gallery review App unexpectedly accepted a main ref update.');
    }
    if (response.status !== 403 && response.status !== 422) {
        throw new Error(
            `Gallery review main-update probe failed for an unrecognized reason (${response.status}).`
        );
    }

    let value;
    try {
        value = await response.json();
    } catch {
        throw new Error('Gallery review main-update denial returned invalid JSON.');
    }
    if (!isAcceptedRuleOwnedDenial(value)) {
        throw new Error('Gallery review main-update denial was not an accepted rules-owned denial.');
    }
}

function isAcceptedRuleOwnedDenial(value) {
    if (!isPlainObject(value)) {
        return false;
    }
    if (policyDenialMessages.has(value.message)) {
        return true;
    }
    if (
        value.message !== protectedRefValidationMessage ||
        !Array.isArray(value.errors) ||
        value.errors.length !== 1
    ) {
        return false;
    }
    const [error] = value.errors;
    return (
        isPlainObject(error) &&
        error.resource === 'Reference' &&
        error.code === 'protected' &&
        protectedRefErrorMessages.has(error.message)
    );
}

function validateCommitSha(value, label) {
    if (typeof value !== 'string' || !commitShaPattern.test(value)) {
        throw new Error(`Gallery review permission ${label} must be a 40-character Git commit SHA.`);
    }
    return value.toLowerCase();
}

function validateToken(value) {
    if (
        typeof value !== 'string' ||
        value.length < 16 ||
        value.length > 1024 ||
        /[\u0000-\u001f\u007f\s]/.test(value)
    ) {
        throw new Error('A short-lived GitHub App installation token is required.');
    }
    return value;
}

function validateFetch(value) {
    if (typeof value !== 'function') {
        throw new Error('An injected GitHub HTTPS fetch implementation is required.');
    }
    return value;
}

function requireExactKeys(value, expectedKeys) {
    if (!isPlainObject(value)) {
        throw new Error('Gallery review permission options must be a JSON object.');
    }
    const actual = Object.keys(value).sort();
    const expected = [...expectedKeys].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Gallery review permission options must contain exactly: ${expected.join(', ')}.`);
    }
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
