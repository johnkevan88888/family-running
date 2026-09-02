import {
    assertPinnedExifTool,
    assertPinnedSharp,
    closeExifTool,
    configurePinnedSharp,
    createPinnedExifTool,
    galleryMediaToolchain
} from './gallery-media/toolchain.mjs';
import { sanitizeProcessingError } from './gallery-media/errors.mjs';

const args = process.argv.slice(2);

if (args.length === 1 && args[0] === '--check-photo-toolchain') {
    let exiftool;
    try {
        configurePinnedSharp();
        const sharpEvidence = assertPinnedSharp();
        exiftool = createPinnedExifTool();
        const exiftoolEvidence = await assertPinnedExifTool(exiftool);
        process.stdout.write(`${JSON.stringify({
            status: 'ok',
            scope: galleryMediaToolchain.scope,
            photo: {
                sharp: sharpEvidence.scannerVersion,
                libvips: sharpEvidence.libvipsVersion,
                webp: sharpEvidence.webpVersion,
                png: sharpEvidence.pngVersion,
                exiftool: exiftoolEvidence.scannerVersion
            },
            video: {
                enabled: false,
                reason: 'reviewed-runner-not-installed'
            }
        })}\n`);
    } catch (error) {
        const safeError = sanitizeProcessingError(error, 'toolchain-unavailable');
        process.stderr.write(`${safeError.message}\n`);
        process.exitCode = 1;
    } finally {
        if (exiftool) {
            try {
                await closeExifTool(exiftool);
            } catch {
                process.stderr.write('The pinned Gallery media toolchain could not shut down safely.\n');
                process.exitCode = 1;
            }
        }
    }
} else {
    const helpRequested = args.length === 1 && args[0] === '--help';
    const output =
        'Usage: node scripts/process-gallery-media.mjs --check-photo-toolchain\n' +
        'The reviewed module accepts bound JPEG and PNG photo bytes; video processing remains disabled.\n';
    if (helpRequested) {
        process.stdout.write(output);
    } else {
        process.stderr.write(output);
        process.exitCode = 2;
    }
}
