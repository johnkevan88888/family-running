import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const revision = 'a643c73948306bd77b6d893fbd45fd88911a5d84';
const sources = Object.freeze({
    'pico.js': '4f06b61fb5ddbed90d444a92ff3577c362ae50cbbaa6ecf5a749054550ca2d68',
    'facefinder.bin': 'd8014993e7298c7b1865d1f8b855d6dbf4ec5c808bf879e2091ab6837abf90cd'
});
const output = new URL('../gallery-admin/generated/private-face-detector.js', import.meta.url);
const license = new URL('../gallery-admin/vendor/face-detector/LICENSE', import.meta.url);
const bundleSha = '22877b89abbb0d459c02e4f58492f007fc5bafd14f45f368c6c9430efefbf190';
const licenseSha = '19884e79ae8d9b5a0e0d7f06a8e27bbf7d6f299a9a2bdb1b64a03c8f527b66e2';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function pinnedBytes(url, maximum, expected) {
    const stat=await lstat(url);
    if(!stat.isFile() || stat.isSymbolicLink() || stat.size>maximum) throw new Error('Unverified detector file shape.');
    const bytes=await readFile(url);
    if(bytes.length>maximum || digest(bytes)!==expected) throw new Error('Unverified detector file hash.');
    return bytes;
}
const notice = (await pinnedBytes(license,8192,licenseSha)).toString('utf8');
const check = process.argv.slice(2).join(' ') === '--check';
if (process.argv.length > 2 && !check) throw new Error('Usage: node scripts/sync-private-face-detector.mjs [--check]');

if (check) {
    // Never import or evaluate the generated module during verification. The
    // complete canonical-LF file pins its license, source, cascade and exports;
    // appending arbitrary executable code must fail before any execution.
    await pinnedBytes(output,512*1024,bundleSha);
    console.log('Pinned private face detector bundle and full MIT license hashes passed without executing generated code.');
} else {
    const downloaded = {};
    for (const name of Object.keys(sources)) {
        const uri = `https://api.github.com/repos/ringcentral/picojs/contents/${name}?ref=${revision}`;
        let value;
        if (process.platform === 'win32') {
            // Use the operating system HTTP transport on Windows. This reads
            // public pinned source only and never uses GitHub account tokens.
            const command = `$value = Invoke-RestMethod -Uri '${uri}' -Headers @{ 'User-Agent'='Family-Running-local-development' }; $value | ConvertTo-Json -Compress`;
            const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { maxBuffer: 1024 * 1024, timeout: 30000, windowsHide: true });
            value = JSON.parse(stdout);
        } else {
            const response = await fetch(uri, { headers: { 'User-Agent':'Family-Running-local-development' }, redirect:'error', signal:AbortSignal.timeout(30000) });
            if (!response.ok) throw new Error('Pinned detector source download failed.');
            const chunks=[];let size=0;
            for await(const chunk of response.body) {
                size+=chunk.byteLength;
                if(size>1024*1024) throw new Error('Pinned detector source response exceeded its bound.');
                chunks.push(chunk);
            }
            value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        }
        if (value.encoding !== 'base64' || typeof value.content !== 'string' || value.size > 256 * 1024) throw new Error('Unexpected pinned source response.');
        const bytes = Buffer.from(value.content, 'base64');
        if (bytes.length !== value.size || createHash('sha256').update(bytes).digest('hex') !== sources[name]) throw new Error(`Pinned detector source hash failed: ${name}`);
        downloaded[name] = bytes;
    }
    const module = `// Generated only by scripts/sync-private-face-detector.mjs; never edit manually.\n// Upstream: https://github.com/ringcentral/picojs/tree/${revision}\n/*\n${notice.replaceAll('*/','* /')}\n*/\nexport const detectorLicense = ${JSON.stringify(notice)};\nexport const picoSource = ${JSON.stringify(downloaded['pico.js'].toString('utf8'))};\nexport const cascadeBase64 = ${JSON.stringify(downloaded['facefinder.bin'].toString('base64'))};\n`;
    if(digest(Buffer.from(module))!==bundleSha) throw new Error('Generated detector differs from the reviewed canonical bundle.');
    await writeFile(output, module);
    console.log(`Pinned private detector bundle generated: ${fileURLToPath(output)} (${Buffer.byteLength(module)} bytes).`);
}
