import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateArchiveMultipartContainment} from '../scripts/gallery-media/archive-containment.mjs';
const requirement=JSON.parse(await readFile(new URL('../gallery-admin/archive-media-lifecycle.required.json',import.meta.url),'utf8'));
assert.equal(Object.hasOwn(requirement,'rules'),false,'A requirements fragment must never be a replacement policy');
assert.equal(requirement.evidenceBoundary.permitsPolicyReplacement,false);
const policies=Object.fromEntries(requirement.requirements.map(({bucketName,prefix,abortAfterSeconds})=>[bucketName,{rules:[{
    id:`fictional-${prefix.replaceAll('/','-')}`,enabled:true,conditions:{prefix},abortMultipartUploadsTransition:{condition:{type:'Age',maxAge:abortAfterSeconds}}
}]}]));
assert.equal(validateArchiveMultipartContainment(policies).ok,true);
assert.equal(validateArchiveMultipartContainment(policies).publicHostAbsenceProof,false);
for(const {bucketName} of requirement.requirements) {
    for(const modify of [rule=>rule.enabled=false,rule=>rule.conditions.prefix='media/v1/',rule=>rule.abortMultipartUploadsTransition.condition.maxAge=86401,
        rule=>rule.deleteObjectsTransition={condition:{type:'Age',maxAge:2592000}}]) {
        const bad=structuredClone(policies);modify(bad[bucketName].rules[0]);assert.equal(validateArchiveMultipartContainment(bad).ok,false);
    }
    const overlapping=structuredClone(policies);overlapping[bucketName].rules.push({id:'broad-expiry',enabled:true,conditions:{prefix:''},deleteObjectsTransition:{condition:{type:'Age',maxAge:2592000}}});
    assert.equal(validateArchiveMultipartContainment(overlapping).ok,false);
}
assert.equal(validateArchiveMultipartContainment({}).ok,false);
const unknown=structuredClone(policies);unknown[requirement.requirements[0].bucketName].rules.push({id:'unknown',enabled:true,conditions:{prefix:''},futureTransition:{}});
assert.equal(validateArchiveMultipartContainment(unknown).ok,false,'Unrecognised policy shape fails closed');
console.log('Archive prefix-specific multipart containment requirements pass; no policy mutation, synchronous cleanup or host-absence claim.');
