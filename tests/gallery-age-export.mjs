import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../scripts/export-bundle-tools.mjs';
import { buildGalleryAdminCatalog } from '../scripts/build-gallery-admin-catalog.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(await fs.readFile(path.join(root,'scripts/workbook-export-contract.json'),'utf8'));
const files = [];
async function scan(folder) {
    for (const entry of await fs.readdir(folder,{withFileTypes:true})) {
        const file = path.join(folder,entry.name);
        if (entry.isDirectory()) await scan(file); else if (file.endsWith('.csv')) files.push(file);
    }
}
await scan(path.join(root,'data'));
const descriptor = [`${contract.schemaDescriptorPrefix}\n`];
for (const file of files.sort()) {
    const header = (await fs.readFile(file,'utf8')).replace(/^\uFEFF/,'').split(/\r\n|\n|\r/,1)[0];
    if (path.basename(file) === 'athlete_results.csv') {
        assert.equal(header,'AthleteID,Participant,Date,Distance,Time,AgeGrade,Event,TimeClass,AgeAtRace,ExportBundleID');
    }
    descriptor.push(`${path.relative(root,file).split(path.sep).join('/')}\n${header}\n`);
}
assert.equal(files.length,contract.publicCsvCount);
assert.equal(createHash('sha256').update(descriptor.join('')).digest('hex').toUpperCase(),contract.schemaFingerprintSha256);
const fixture = await fs.mkdtemp(path.join(os.tmpdir(),'gallery-age-export-'));
try {
    await fs.cp(path.join(root,'data'),path.join(fixture,'data'),{recursive:true});
    await fs.cp(path.join(root,'gallery-data'),path.join(fixture,'gallery-data'),{recursive:true});
    const resultPath = path.join(fixture,'data/athlete_results.csv');
    const rows = parseCsv(await fs.readFile(resultPath,'utf8'));
    const ageColumn = rows[0].indexOf('AgeAtRace');
    assert.equal(ageColumn,8);
    const csv = () => rows.map(row => row.map(value => `"${value.replaceAll('"','""')}"`).join(',')).join('\r\n')+'\r\n';
    await fs.writeFile(resultPath,csv());
    const run = () => spawnSync(process.execPath,[path.join(root,'scripts/validate-csv.mjs')],
        {encoding:'utf8',env:{...process.env,CSV_VALIDATION_ROOT:fixture}});
    let result = run(); assert.equal(result.status,0,result.stdout+result.stderr);
    await buildGalleryAdminCatalog(fixture);
    for (const age of ['', 'M46','46.5','131']) {
        rows[1][ageColumn] = age; await fs.writeFile(resultPath,csv());
        result = run(); assert.notEqual(result.status,0);
        assert.match(result.stdout+result.stderr,/AgeAtRace/);
        await assert.rejects(buildGalleryAdminCatalog(fixture),/AgeAtRace/);
    }
} finally { await fs.rm(fixture,{recursive:true,force:true}); }
console.log('Gallery age schema passed: active full-bundle fingerprint, valid ages, malformed ages rejected by CSV and catalogue validation.');
