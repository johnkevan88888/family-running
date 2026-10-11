const requirements=Object.freeze([
    Object.freeze({bucketName:'family-running-gallery-originals-dev',prefix:'private-archive/v1/'}),
    Object.freeze({bucketName:'family-running-gallery-staging-dev',prefix:'derivative-staging/v2/'}),
    Object.freeze({bucketName:'family-running-gallery-approved-dev',prefix:'media/v2/'})
]);
// Read-only validation of complete policies fetched separately by an authorised
// operator. This neither constructs a policy replacement nor calls Cloudflare.
// An abort rule is eventual orphan containment, NOT writer closure or host proof.
export function validateArchiveMultipartContainment(policies) {
    const failures=[];
    for(const {bucketName,prefix} of requirements) {
        const rules=policies?.[bucketName]?.rules;
        if(!Array.isArray(rules) || rules.length>1000 || rules.some(rule=>!rule || typeof rule.id!=='string' ||
            typeof rule.enabled!=='boolean' || typeof rule.conditions?.prefix!=='string' ||
            Object.keys(rule).some(key=>!['id','enabled','conditions','abortMultipartUploadsTransition','deleteObjectsTransition','storageClassTransitions'].includes(key))) ||
            new Set(rules.map(rule=>rule.id)).size!==rules.length) {failures.push(`${bucketName}: unavailable policy`);continue;}
        const exact=rules.filter(rule=>rule.enabled===true && rule.conditions?.prefix===prefix &&
            rule.abortMultipartUploadsTransition?.condition?.type==='Age' && rule.abortMultipartUploadsTransition.condition.maxAge===86400);
        if(exact.length!==1) failures.push(`${bucketName}: exact 24-hour abort rule required for ${prefix}`);
        for(const rule of rules) {
            const affected=rule.conditions?.prefix;
            if(rule.enabled!==true || typeof affected!=='string' || !(prefix.startsWith(affected)||affected.startsWith(prefix))) continue;
            if(Object.hasOwn(rule,'deleteObjectsTransition') || Object.hasOwn(rule,'storageClassTransitions'))
                failures.push(`${bucketName}: overlapping object-changing lifecycle rule`);
        }
    }
    return {ok:failures.length===0,failures,synchronousCleanupProof:false,publicHostAbsenceProof:false};
}
