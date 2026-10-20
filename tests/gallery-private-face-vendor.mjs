import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, copyFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const artifacts=path.join(root,'test-artifacts');await mkdir(artifacts,{recursive:true});
const fixture=await mkdtemp(path.join(artifacts,'private-face-vendor-'));
for(const folder of ['scripts','gallery-admin/generated','gallery-admin/vendor/face-detector']) await mkdir(path.join(fixture,folder),{recursive:true});
const script='scripts/sync-private-face-detector.mjs',bundle='gallery-admin/generated/private-face-detector.js',license='gallery-admin/vendor/face-detector/LICENSE';
for(const name of [script,bundle,license]) await copyFile(path.join(root,name),path.join(fixture,name));
const run=()=>promisify(execFile)(process.execPath,[path.join(fixture,script),'--check'],{cwd:fixture,timeout:10000,windowsHide:true});
assert.match((await run()).stdout,/without executing generated code/);
const bytes=await readFile(path.join(fixture,bundle));
for(const mutation of [Buffer.concat([bytes,Buffer.from('\nthrow new Error("UNTRUSTED_GENERATED_CODE_EXECUTED");\n')]),Buffer.from(bytes.toString().replace('The MIT License','LICENSE REMOVED')),Buffer.from(bytes.toString().replace('export const cascadeBase64 = "','export const cascadeBase64 = "AAAA'))]) {
    await writeFile(path.join(fixture,bundle),mutation);
    await assert.rejects(run(),error=>{assert.match(error.stderr,/Unverified detector file hash/);assert(!error.stderr.includes('UNTRUSTED_GENERATED_CODE_EXECUTED\n'));return true;});
}
await writeFile(path.join(fixture,bundle),bytes);
const notice=await readFile(path.join(fixture,license));
await writeFile(path.join(fixture,license),notice.toString().replace('Copyright','Removed copyright'));
await assert.rejects(run(),error=>{assert.match(error.stderr,/Unverified detector file hash/);return true;});
await writeFile(path.join(fixture,license),notice);
assert.match((await run()).stdout,/hashes passed/);
console.log('Private detector vendoring: exact bundle/license pins reject extra executable code, changed model and removed notices before evaluation.');
