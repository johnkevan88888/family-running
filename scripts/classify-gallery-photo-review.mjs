// This selects regression scope, not consent or permission to publish. The
// protected processing/publication jobs remain the authorities for those facts.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import galleryContract from '../gallery-contract.js';
import { parseV2PhotoDerivativeKey } from '../gallery-admin/src/photo-generation-keys.js';

const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const paths = ['gallery-data/family.json', 'gallery-data/everyone.json'];
const suppressionPath = 'gallery-data/hidden-athlete-ids.json';
const origin = 'https://family-running-gallery-media-dev.family-running.workers.dev';
const shaPattern = /^[a-f0-9]{40}$/;
const photoIdPattern = /^photo-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const maximumBytes = 1024 * 1024;
const maximumNewPhotos = 20;
const full = reason => ({ suite: 'full', reason });

function readDocument(text) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > maximumBytes) throw new Error('bounded JSON required');
    const document = JSON.parse(text);
    // Reject duplicate keys, noncanonical encodings and unexpected root data.
    if (text !== JSON.stringify(document, null, 2) + '\n') throw new Error('canonical JSON required');
    return document;
}

function galleryDocument(text) {
    const document = readDocument(text);
    if (Object.keys(document).sort().join('|') !== 'items|schemaVersion' ||
            galleryContract.validateGalleryDocument(document).length) throw new Error('valid public manifest required');
    return document;
}

function derivative(urlText, role) {
    const url = new URL(urlText);
    const key = parseV2PhotoDerivativeKey(url.pathname.slice(1));
    if (url.origin !== origin || url.username || url.password || url.search || url.hash ||
            url.href !== urlText || urlText !== `${origin}/${url.pathname.slice(1)}` || key?.role !== role) {
        throw new Error('canonical approved generation URL required');
    }
    return key;
}

export function assessPhotoOnlyDiff({ changedEntries, baseText, headText, otherText, suppressionText }) {
    if (!Array.isArray(changedEntries) || changedEntries.length !== 1 ||
            changedEntries[0]?.status !== 'M' || !paths.includes(changedEntries[0]?.path)) {
        return full('not-one-existing-gallery-manifest');
    }
    try {
        const base = galleryDocument(baseText), head = galleryDocument(headText), other = galleryDocument(otherText);
        const suppression = readDocument(suppressionText);
        if (galleryContract.validateGallerySuppressionDocument(suppression).length) return full('invalid-suppression');
        const added = head.items.length - base.items.length;
        if (added < 1 || added > maximumNewPhotos ||
                !isDeepStrictEqual(head.items.slice(0, base.items.length), base.items)) return full('not-bounded-append-only-additions');
        const seen = [...base.items, ...other.items];
        for (const item of head.items.slice(base.items.length)) {
            if (item.type !== 'photo' || !photoIdPattern.test(item.id) || !item.athleteIds.length ||
                    item.athleteIds.some(id => suppression.hiddenAthleteIds.includes(id))) return full('ineligible-new-photo');
            const display = derivative(item.sourceUrl, 'photo-display');
            const thumbnail = derivative(item.thumbnailUrl, 'photo-thumbnail');
            if (display.generationId !== thumbnail.generationId || display.sha256 === thumbnail.sha256) return full('invalid-photo-pair');
            for (const old of seen) {
                if (old.id === item.id || [old.sourceUrl, old.thumbnailUrl].some(url => {
                    if (url === item.sourceUrl || url === item.thumbnailUrl) return true;
                    // No reuse within the batch, old items or the other area.
                    const key = parseV2PhotoDerivativeKey(new URL(url).pathname.slice(1));
                    return key?.generationId === display.generationId;
                })) return full('existing-or-cross-area-media-reuse');
            }
            seen.push(item);
        }
        return { suite: 'photo-only', reason: 'bounded-new-public-photos-only' };
    } catch {
        return full('invalid-or-unsupported-photo-manifest');
    }
}

export function classifyPhotoReview({ root = rootPath, eventName, baseSha, headSha, checkoutSha }) {
    if (eventName !== 'pull_request') return full('not-a-pull-request');
    if (![baseSha, headSha, checkoutSha].every(value => typeof value === 'string' && shaPattern.test(value)) ||
            baseSha === headSha) return full('missing-or-invalid-exact-refs');
    const git = args => execFileSync('git', ['-c', `safe.directory=${path.resolve(root)}`, ...args], {
        cwd: root, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * maximumBytes, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
        if (git(['rev-parse', 'HEAD']).trim() !== checkoutSha ||
                git(['merge-base', baseSha, headSha]).trim() !== baseSha ||
                git(['rev-parse', `${checkoutSha}^{tree}`]).trim() !== git(['rev-parse', `${headSha}^{tree}`]).trim()) {
            return full('stale-base-or-unmatched-checkout');
        }
        if (checkoutSha !== headSha &&
                git(['show', '-s', '--format=%P', checkoutSha]).trim() !== `${baseSha} ${headSha}`) return full('unmatched-test-merge');
        // A dirty tracked checkout cannot borrow eligibility from committed data.
        if (git(['status', '--porcelain=v1', '--untracked-files=all']).trim()) return full('dirty-checkout');
        const fields = git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', baseSha, headSha]).split('\0');
        if (fields.at(-1) !== '') return full('invalid-diff');
        fields.pop();
        if (fields.length !== 2) return full('not-one-existing-gallery-manifest');
        const changedEntries = [{ status: fields[0], path: fields[1] }];
        if (fields[0] !== 'M' || !paths.includes(fields[1])) return full('not-one-existing-gallery-manifest');
        const target = fields[1], other = paths.find(value => value !== target);
        const blob = (sha, name) => {
            const tree = git(['ls-tree', '-z', sha, '--', name]);
            if (!new RegExp(`^100644 blob [a-f0-9]{40}\\t${name.replaceAll('.', '\\.')}\\0$`).test(tree)) {
                throw new Error('regular committed file required');
            }
            const size = Number(git(['cat-file', '-s', `${sha}:${name}`]).trim());
            if (!Number.isSafeInteger(size) || size < 1 || size > maximumBytes) throw new Error('bounded committed file required');
            const bytes = execFileSync('git', ['-c', `safe.directory=${path.resolve(root)}`, 'show', `${sha}:${name}`], {
                cwd: root, timeout: 15000, maxBuffer: maximumBytes, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
            });
            return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        };
        return assessPhotoOnlyDiff({ changedEntries, baseText: blob(baseSha, target), headText: blob(headSha, target),
            otherText: blob(headSha, other), suppressionText: blob(headSha, suppressionPath) });
    } catch {
        return full('unverifiable-git-evidence');
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.length !== 2) throw new Error('This classifier accepts no override arguments.');
    const assessment = classifyPhotoReview({ eventName: process.env.GITHUB_EVENT_NAME, baseSha: process.env.PR_BASE_SHA,
        headSha: process.env.PR_HEAD_SHA, checkoutSha: process.env.GITHUB_SHA });
    console.log(`Regression suite: ${assessment.suite} (${assessment.reason}).`);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `suite=${assessment.suite}\n`);
}
