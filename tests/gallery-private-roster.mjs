import assert from 'node:assert/strict';
import {selectPrivateGalleryPeople, resolvePrivateGalleryTags} from '../gallery-admin/src/private-gallery-roster.js';

const id = n => `person_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const revision = `sha256:${'a'.repeat(64)}`;
const catalogue = {schemaVersion:'private-gallery-roster-v1', revision, people:[
    {personId:id(1),displayName:'Synthetic Runner',sites:['family','everyone'],publicAthleteId:'synthetic-runner'},
    {personId:id(2),displayName:'Synthetic Runner',sites:['family'],publicAthleteId:null},
    {personId:id(3),displayName:'Synthetic Spectator',sites:['everyone'],publicAthleteId:null}
]};
const original = structuredClone(catalogue);
assert.deepEqual(selectPrivateGalleryPeople(catalogue,'family').people.map(p=>p.personId),[id(1),id(2)]);
assert.deepEqual(selectPrivateGalleryPeople(catalogue,'everyone').people.map(p=>p.personId),[id(1),id(3)]);
const tags = resolvePrivateGalleryTags(catalogue,'family',[id(2),id(1)],revision);
assert.equal(tags[0].publicAthleteId,null,'non-public athlete must remain tagged');
assert.deepEqual(tags.map(p=>p.personId),[id(2),id(1)],'duplicate names never merge identities');
assert.ok(Object.isFrozen(tags) && tags.every(Object.isFrozen));
assert.deepEqual(catalogue,original,'selection must not mutate authoritative records');
for (const invalid of [[id(3)],[id(1),id(1)],[],['synthetic-runner'],[id(99)],[null]]) {
    assert.throws(()=>resolvePrivateGalleryTags(catalogue,'family',invalid,revision));
}
assert.throws(()=>resolvePrivateGalleryTags(catalogue,'family',[id(1)],`sha256:${'b'.repeat(64)}`),/Stale/);
assert.throws(()=>selectPrivateGalleryPeople(catalogue,'elsewhere'));
const mutations = [
    c=>c.people.push({...c.people[0]}),
    c=>c.people[1].publicAthleteId='synthetic-runner',
    c=>c.people[1].sites.push('family'),
    c=>c.people[1].sites=['unknown'],
    c=>c.people[1].sites=[],
    c=>c.people[1].displayName=' ',
    c=>c.people[1].displayName='Name\nPrivate',
    c=>c.people[1].personId='private-name-slug',
    c=>c.people[1].publicAthleteId=undefined,
    c=>c.people[1].dateOfBirth='2000-01-01',
    c=>c.revision='stale',
    c=>c.revision=[revision],
    c=>c.schemaVersion='1.0',
    c=>c.extra='not permitted'
];
for(const mutate of mutations){const copy=structuredClone(catalogue);mutate(copy);assert.throws(()=>selectPrivateGalleryPeople(copy,'family'));}
assert.throws(()=>selectPrivateGalleryPeople(null,'family'));
assert.deepEqual(selectPrivateGalleryPeople({...catalogue,people:[]},'family').people,[]);
console.log('Private roster contract passed: both inherited areas, non-public athletes, exact IDs, immutable complete tags, stale/unknown/duplicate rejection. No storage, consent, publication or API integration exercised.');
