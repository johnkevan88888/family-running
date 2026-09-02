const publicMessages = Object.freeze({
    'invalid-request': 'The Gallery photo processing request is invalid.',
    'source-rejected': 'The source photo did not match its recorded checksum.',
    'input-rejected': 'The source photo did not pass the input contract.',
    'decoder-rejected': 'The pinned image decoder rejected the source photo.',
    'toolchain-unavailable': 'The pinned Gallery media toolchain is unavailable.',
    'metadata-scan-failed': 'The metadata inspection did not complete safely.',
    'derivative-rejected': 'A generated derivative did not pass the publication contract.',
    'processing-failed': 'Gallery photo processing failed.',
    'cleanup-failed': 'The isolated Gallery processing workspace could not be removed.'
});

export class GalleryMediaProcessingError extends Error {
    constructor(code) {
        const message = publicMessages[code] || publicMessages['processing-failed'];
        super(message);
        this.name = 'GalleryMediaProcessingError';
        this.code = Object.hasOwn(publicMessages, code) ? code : 'processing-failed';
    }
}

export function processingError(code) {
    return new GalleryMediaProcessingError(code);
}

export function sanitizeProcessingError(error, fallbackCode = 'processing-failed') {
    return error instanceof GalleryMediaProcessingError
        ? error
        : processingError(fallbackCode);
}
