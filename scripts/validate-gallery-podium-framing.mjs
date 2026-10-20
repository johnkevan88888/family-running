import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import framing from '../gallery-podium-framing.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const relativePath = 'gallery-podium-framing.json';
const maxBytes = 512 * 1024;

// Inert digests deliberately need no corresponding manifest item: withdrawing
// a photo must remain a one-file manifest change, not a crop-config transaction.
export async function validateGalleryPodiumFramingTree(root = repoRoot) {
    const fullPath = path.join(root, relativePath);
    try {
        const stat = await fs.lstat(fullPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
            return [`${relativePath}: must be a regular JSON file no larger than ${maxBytes} bytes.`];
        }
        const documentValue = JSON.parse(await fs.readFile(fullPath, 'utf8'));
        return framing.validateDocument(documentValue).map(problem => `${relativePath}: ${problem}`);
    } catch (error) {
        return [`${relativePath}: could not read valid JSON (${error.message}).`];
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.length > 3) {
        console.error('Usage: node scripts/validate-gallery-podium-framing.mjs [root]');
        process.exitCode = 1;
    } else {
        const problems = await validateGalleryPodiumFramingTree(process.argv[2] || repoRoot);
        if (problems.length) {
            console.error('Gallery podium framing validation failed:');
            problems.forEach(problem => console.error(`- ${problem}`));
            process.exitCode = 1;
        } else {
            console.log('Gallery podium framing validation passed.');
        }
    }
}
