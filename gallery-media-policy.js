(function (root, factory) {
    const policy = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = policy;
    }

    root.galleryMediaPolicy = policy;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // This contract consumes normalized scanner output rather than media bytes.
    // A later processor can adapt ExifTool/ffprobe output into this deliberately
    // small shape and use the same assessment before and after sanitization.
    const schemaVersion = '1.0';
    const sourceStage = 'source';
    const publicDerivativeStage = 'public-derivative';
    const mediaTypes = new Set(['photo', 'video']);
    const stages = new Set([sourceStage, publicDerivativeStage]);
    const allowedProbeKeys = new Set([
        'schemaVersion',
        'mediaType',
        'metadata',
        'chapters'
    ]);
    const allowedMetadataKeys = new Set(['path', 'value']);
    const allowedChapterKeys = new Set([
        'index',
        'startTimeSeconds',
        'endTimeSeconds',
        'title'
    ]);
    const maximumMetadataEntries = 1000;
    const maximumChapters = 200;
    const maximumPathLength = 240;
    const maximumTextValueLength = 4096;
    const maximumChapterTitleLength = 300;
    const sha256Pattern = /^[a-f0-9]{64}$/;
    const scannerTokenPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/;
    const allowedScanEnvelopeKeys = new Set([
        'schemaVersion',
        'resultKind',
        'subject',
        'scanner',
        'status',
        'result'
    ]);
    const allowedScanSubjectKeys = new Set(['sha256', 'byteLength']);
    const allowedScannerKeys = new Set(['name', 'version']);
    const allowedScanStatusKeys = new Set([
        'completed',
        'truncated',
        'exitCode'
    ]);
    const allowedScanExpectationKeys = new Set([
        'sha256',
        'byteLength',
        'scannerName',
        'scannerVersion',
        'resultKind'
    ]);
    const scanResultKinds = new Set([
        'metadata',
        'input-file',
        'technical-derivative'
    ]);
    const allowedInputFileKeys = new Set([
        'schemaVersion',
        'fileName',
        'declaredMimeType',
        'mediaType',
        'detectedFormat',
        'byteLength',
        'width',
        'height',
        'durationSeconds',
        'inspectionCompleted',
        'corrupt'
    ]);
    const allowedTechnicalProbeKeys = new Set([
        'schemaVersion',
        'role',
        'container',
        'width',
        'height',
        'durationSeconds',
        'fastStart',
        'streams'
    ]);
    const allowedTechnicalStreamKeys = new Set(['type', 'codec']);
    const allowedTechnicalExpectationKeys = new Set([
        'role',
        'width',
        'height',
        'sourceWidth',
        'sourceHeight',
        'sourceDurationSeconds',
        'durationToleranceSeconds',
        'audioExpected'
    ]);

    const categories = Object.freeze({
        location: 'location',
        device: 'device',
        orientation: 'orientation',
        chapter: 'chapter',
        sourceName: 'source-name',
        other: 'other'
    });

    const inputLimits = deepFreeze({
        photo: {
            maximumBytes: 25 * 1024 * 1024,
            maximumPixels: 50 * 1000 * 1000,
            maximumDurationSeconds: null
        },
        video: {
            maximumBytes: 500 * 1024 * 1024,
            maximumPixels: 50 * 1000 * 1000,
            maximumDurationSeconds: 10 * 60
        }
    });

    const inputFormats = deepFreeze({
        jpeg: {
            mediaType: 'photo',
            mimeTypes: ['image/jpeg'],
            extensions: ['jpg', 'jpeg']
        },
        png: {
            mediaType: 'photo',
            mimeTypes: ['image/png'],
            extensions: ['png']
        },
        webp: {
            mediaType: 'photo',
            mimeTypes: ['image/webp'],
            extensions: ['webp']
        },
        heif: {
            mediaType: 'photo',
            mimeTypes: ['image/heic', 'image/heif'],
            extensions: ['heic', 'heif']
        },
        mp4: {
            mediaType: 'video',
            mimeTypes: ['video/mp4'],
            extensions: ['mp4']
        },
        quicktime: {
            mediaType: 'video',
            mimeTypes: ['video/quicktime'],
            extensions: ['mov']
        },
        webm: {
            mediaType: 'video',
            mimeTypes: ['video/webm'],
            extensions: ['webm']
        }
    });

    const derivativeRoles = deepFreeze({
        photoDisplay: 'photo-display',
        photoThumbnail: 'photo-thumbnail',
        videoPlayback: 'video-playback',
        videoPoster: 'video-poster'
    });

    const derivativeProfiles = deepFreeze({
        'photo-display': {
            mediaType: 'photo',
            container: 'webp',
            streamType: 'image',
            visualCodec: 'webp',
            maximumLongEdge: 1600,
            requiresFastStart: false
        },
        'photo-thumbnail': {
            mediaType: 'photo',
            container: 'webp',
            streamType: 'image',
            visualCodec: 'webp',
            maximumLongEdge: 480,
            requiresFastStart: false
        },
        'video-playback': {
            mediaType: 'video',
            container: 'mp4',
            streamType: 'video',
            visualCodec: 'h264',
            audioCodec: 'aac',
            maximumLongEdge: 1920,
            maximumShortEdge: 1080,
            requiresFastStart: true
        },
        'video-poster': {
            mediaType: 'photo',
            container: 'webp',
            streamType: 'image',
            visualCodec: 'webp',
            maximumLongEdge: 720,
            requiresFastStart: false
        }
    });

    function validateMetadataProbe(probe) {
        const problems = [];

        if (!isPlainObject(probe)) {
            return ['Metadata probe must be a JSON object.'];
        }

        for (const key of Object.keys(probe)) {
            if (!allowedProbeKeys.has(key)) {
                problems.push('Metadata probe contains an unsupported field.');
            }
        }

        if (probe.schemaVersion !== schemaVersion) {
            problems.push(`Metadata probe schemaVersion must be exactly "${schemaVersion}".`);
        }

        if (!mediaTypes.has(probe.mediaType)) {
            problems.push('Metadata probe mediaType must be "photo" or "video".');
        }

        if (!Array.isArray(probe.metadata)) {
            problems.push('Metadata probe metadata must be an array.');
        } else if (probe.metadata.length > maximumMetadataEntries) {
            problems.push(
                `Metadata probe metadata must contain no more than ${maximumMetadataEntries} entries.`
            );
        } else {
            probe.metadata.forEach((entry, index) => {
                validateMetadataEntry(entry, index, problems);
            });
        }

        if (!Array.isArray(probe.chapters)) {
            problems.push('Metadata probe chapters must be an array.');
        } else if (probe.chapters.length > maximumChapters) {
            problems.push(
                `Metadata probe chapters must contain no more than ${maximumChapters} entries.`
            );
        } else {
            probe.chapters.forEach((chapter, index) => {
                validateChapter(chapter, index, problems);
            });

            if (probe.mediaType === 'photo' && probe.chapters.length > 0) {
                problems.push('A photo metadata probe cannot contain chapters.');
            }
        }

        return problems;
    }

    function assessMetadataProbe(probe, stage = sourceStage) {
        if (!stages.has(stage)) {
            return Object.freeze({
                stage: null,
                valid: false,
                probeValid: false,
                requiresSanitization: true,
                findings: Object.freeze([]),
                problems: Object.freeze([
                    `Metadata assessment stage must be "${sourceStage}" or "${publicDerivativeStage}".`
                ])
            });
        }

        const shapeProblems = validateMetadataProbe(probe);
        if (shapeProblems.length > 0) {
            return Object.freeze({
                stage,
                valid: false,
                probeValid: false,
                requiresSanitization: true,
                findings: Object.freeze([]),
                problems: Object.freeze([...shapeProblems])
            });
        }

        const findings = [];

        probe.metadata.forEach((entry, index) => {
            findings.push(Object.freeze({
                kind: 'metadata',
                category: classifyMetadataPath(entry.path),
                index
            }));
        });

        probe.chapters.forEach((chapter, index) => {
            findings.push(Object.freeze({
                kind: 'chapter',
                category: categories.chapter,
                index
            }));
        });

        const problems = [];
        if (stage === publicDerivativeStage) {
            for (const finding of findings) {
                if (finding.kind === 'chapter') {
                    problems.push(
                        `Public derivative retains chapter metadata at chapters[${finding.index}].`
                    );
                } else {
                    problems.push(
                        `Public derivative retains ${finding.category} metadata at metadata[${finding.index}].`
                    );
                }
            }
        }

        return Object.freeze({
            stage,
            valid: problems.length === 0,
            probeValid: true,
            requiresSanitization: findings.length > 0,
            findings: Object.freeze(findings),
            problems: Object.freeze(problems)
        });
    }

    function classifyMetadataPath(path) {
        const normalized = normalizeMetadataPath(path);

        if (/(gps|geotag|latitude|longitude|location|iso6709|coordinates?)/.test(normalized)) {
            return categories.location;
        }

        if (/(orientation|rotation|rotate|displaymatrix|matrixstructure)/.test(normalized)) {
            return categories.orientation;
        }

        if (/chapter/.test(normalized)) {
            return categories.chapter;
        }

        if (/(sourcefile|sourcename|originalfilename|filename)/.test(normalized)) {
            return categories.sourceName;
        }

        if (/(device|camera|lens|make|model|serial|software|firmware)/.test(normalized)) {
            return categories.device;
        }

        return categories.other;
    }

    function validateScanEnvelope(envelope) {
        const problems = [];

        if (!isPlainObject(envelope)) {
            return ['Scan envelope must be a JSON object.'];
        }

        rejectUnsupportedKeys(envelope, allowedScanEnvelopeKeys, 'Scan envelope', problems);

        if (envelope.schemaVersion !== schemaVersion) {
            problems.push(`Scan envelope schemaVersion must be exactly "${schemaVersion}".`);
        }

        if (!scanResultKinds.has(envelope.resultKind)) {
            problems.push('Scan envelope resultKind is unsupported.');
        }

        validateScanSubject(envelope.subject, problems);
        validateScannerIdentity(envelope.scanner, problems);
        validateScanStatus(envelope.status, problems);

        if (!isPlainObject(envelope.result)) {
            problems.push('Scan envelope result must be a JSON object.');
        } else if (scanResultKinds.has(envelope.resultKind)) {
            const resultProblems = envelope.resultKind === 'metadata'
                ? validateMetadataProbe(envelope.result)
                : envelope.resultKind === 'input-file'
                    ? validateInputFileProbe(envelope.result)
                    : validateDerivativeTechnicalProbe(envelope.result);

            if (resultProblems.length > 0) {
                problems.push('Scan envelope result does not match its declared result kind.');
            }
        }

        return problems;
    }

    function assessScanEnvelope(envelope, expectation) {
        const envelopeProblems = validateScanEnvelope(envelope);
        const expectationProblems = validateScanExpectation(expectation);

        if (envelopeProblems.length > 0 || expectationProblems.length > 0) {
            return Object.freeze({
                valid: false,
                envelopeValid: envelopeProblems.length === 0,
                expectationValid: expectationProblems.length === 0,
                problems: Object.freeze([...envelopeProblems, ...expectationProblems])
            });
        }

        const problems = [];

        if (
            envelope.scanner.name !== expectation.scannerName ||
            envelope.scanner.version !== expectation.scannerVersion
        ) {
            problems.push('Scan envelope scanner identity does not match the pinned scanner.');
        }

        if (envelope.resultKind !== expectation.resultKind) {
            problems.push('Scan envelope result kind does not match the expected scan contract.');
        }

        if (envelope.subject.sha256 !== expectation.sha256) {
            problems.push('Scan envelope SHA-256 does not match the expected object digest.');
        }

        if (envelope.subject.byteLength !== expectation.byteLength) {
            problems.push('Scan envelope byte length does not match the expected object length.');
        }

        if (envelope.status.completed !== true) {
            problems.push('Scanner did not report a completed scan.');
        }

        if (envelope.status.truncated !== false) {
            problems.push('Scanner reported truncated output.');
        }

        if (envelope.status.exitCode !== 0) {
            problems.push('Scanner reported a tool failure.');
        }

        return Object.freeze({
            valid: problems.length === 0,
            envelopeValid: true,
            expectationValid: true,
            problems: Object.freeze(problems)
        });
    }

    function validateInputFileProbe(probe) {
        const problems = [];

        if (!isPlainObject(probe)) {
            return ['Input file probe must be a JSON object.'];
        }

        rejectUnsupportedKeys(probe, allowedInputFileKeys, 'Input file probe', problems);

        if (probe.schemaVersion !== schemaVersion) {
            problems.push(`Input file probe schemaVersion must be exactly "${schemaVersion}".`);
        }

        if (!isSafeBaseName(probe.fileName)) {
            problems.push('Input file name must be a plain base name no longer than 255 characters.');
        }

        if (!isLowercaseMimeType(probe.declaredMimeType)) {
            problems.push('Input file declared MIME type must be a lowercase type/subtype value.');
        }

        if (!mediaTypes.has(probe.mediaType)) {
            problems.push('Input file mediaType must be "photo" or "video".');
        }

        if (!isPolicyToken(probe.detectedFormat)) {
            problems.push('Input file detectedFormat must be a bounded policy token.');
        }

        if (!Number.isSafeInteger(probe.byteLength) || probe.byteLength <= 0) {
            problems.push('Input file byteLength must be a positive safe integer.');
        }

        if (!Number.isSafeInteger(probe.width) || probe.width <= 0) {
            problems.push('Input file width must be a positive safe integer.');
        }

        if (!Number.isSafeInteger(probe.height) || probe.height <= 0) {
            problems.push('Input file height must be a positive safe integer.');
        }

        if (probe.mediaType === 'photo' && probe.durationSeconds !== null) {
            problems.push('Photo input durationSeconds must be null.');
        }

        if (probe.mediaType === 'video' && !isPositiveFiniteNumber(probe.durationSeconds)) {
            problems.push('Video input durationSeconds must be a positive finite number.');
        }

        if (typeof probe.inspectionCompleted !== 'boolean') {
            problems.push('Input file inspectionCompleted must be a boolean.');
        }

        if (typeof probe.corrupt !== 'boolean') {
            problems.push('Input file corrupt must be a boolean.');
        }

        return problems;
    }

    function assessInputFile(probe, bytes) {
        const probeProblems = validateInputFileProbe(probe);
        const byteView = toUint8Array(bytes);

        if (probeProblems.length > 0 || !byteView) {
            return Object.freeze({
                valid: false,
                acceptedMediaType: null,
                acceptedFormat: null,
                problems: Object.freeze([
                    ...probeProblems,
                    ...(!byteView ? ['Input file bytes must be an ArrayBuffer or byte array.'] : [])
                ])
            });
        }

        const problems = [];
        const format = inputFormats[probe.detectedFormat];
        const extension = fileExtension(probe.fileName);
        const signatureFormat = detectAllowedFileType(bytes);

        if (probe.inspectionCompleted !== true) {
            problems.push('Input file inspection did not complete.');
        }

        if (probe.corrupt !== false) {
            problems.push('Input file decoder reported corrupt or malformed media.');
        }

        if (!format) {
            problems.push('Input file detected type is unsupported or unknown.');
        } else {
            if (format.mediaType !== probe.mediaType) {
                problems.push('Input file detected type does not match its selected media type.');
            }

            if (!format.mimeTypes.includes(probe.declaredMimeType)) {
                problems.push('Input file declared MIME type does not match its detected type.');
            }

            if (!format.extensions.includes(extension)) {
                problems.push('Input file extension does not match its detected type.');
            }

            const limits = inputLimits[format.mediaType];
            if (
                probe.byteLength > limits.maximumBytes ||
                byteView.byteLength > limits.maximumBytes
            ) {
                problems.push('Input file exceeds the byte limit for its media type.');
            }

            const pixels = probe.width * probe.height;
            if (!Number.isSafeInteger(pixels) || pixels > limits.maximumPixels) {
                problems.push('Input file exceeds the pixel limit for its media type.');
            }

            if (
                format.mediaType === 'video' &&
                probe.durationSeconds > limits.maximumDurationSeconds
            ) {
                problems.push('Input video exceeds the duration limit.');
            }
        }

        if (byteView.byteLength !== probe.byteLength) {
            problems.push('Input file byte length does not match the inspected object.');
        }

        if (!signatureFormat) {
            problems.push('Input file signature is unsupported or unknown.');
        } else if (signatureFormat !== probe.detectedFormat) {
            problems.push('Input file signature does not match the detected type.');
        }

        return Object.freeze({
            valid: problems.length === 0,
            acceptedMediaType: problems.length === 0 ? format.mediaType : null,
            acceptedFormat: problems.length === 0 ? probe.detectedFormat : null,
            problems: Object.freeze(problems)
        });
    }

    function detectAllowedFileType(bytes) {
        const view = toUint8Array(bytes);
        if (!view) {
            return null;
        }

        if (startsWithBytes(view, [0xFF, 0xD8, 0xFF])) {
            return 'jpeg';
        }

        if (startsWithBytes(view, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) {
            return 'png';
        }

        if (readAscii(view, 0, 4) === 'RIFF' && readAscii(view, 8, 4) === 'WEBP') {
            return 'webp';
        }

        if (readAscii(view, 4, 4) === 'ftyp') {
            const brand = readAscii(view, 8, 4);

            if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) {
                return 'heif';
            }

            if (brand === 'qt  ') {
                return 'quicktime';
            }

            if (['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'dash', 'M4V '].includes(brand)) {
                return 'mp4';
            }
        }

        if (
            startsWithBytes(view, [0x1A, 0x45, 0xDF, 0xA3]) &&
            readAscii(view, 0, Math.min(view.byteLength, 64)).toLowerCase().includes('webm')
        ) {
            return 'webm';
        }

        return null;
    }

    function validateDerivativeTechnicalProbe(probe) {
        const problems = [];

        if (!isPlainObject(probe)) {
            return ['Derivative technical probe must be a JSON object.'];
        }

        rejectUnsupportedKeys(
            probe,
            allowedTechnicalProbeKeys,
            'Derivative technical probe',
            problems
        );

        if (probe.schemaVersion !== schemaVersion) {
            problems.push(
                `Derivative technical probe schemaVersion must be exactly "${schemaVersion}".`
            );
        }

        if (!Object.hasOwn(derivativeProfiles, probe.role)) {
            problems.push('Derivative technical probe role is unsupported.');
        }

        if (!isPolicyToken(probe.container)) {
            problems.push('Derivative technical probe container must be a bounded policy token.');
        }

        if (!Number.isSafeInteger(probe.width) || probe.width <= 0) {
            problems.push('Derivative technical probe width must be a positive safe integer.');
        }

        if (!Number.isSafeInteger(probe.height) || probe.height <= 0) {
            problems.push('Derivative technical probe height must be a positive safe integer.');
        }

        if (probe.durationSeconds !== null && !isPositiveFiniteNumber(probe.durationSeconds)) {
            problems.push(
                'Derivative technical probe durationSeconds must be null or a positive finite number.'
            );
        }

        if (typeof probe.fastStart !== 'boolean') {
            problems.push('Derivative technical probe fastStart must be a boolean.');
        }

        if (!Array.isArray(probe.streams) || probe.streams.length === 0 || probe.streams.length > 8) {
            problems.push('Derivative technical probe streams must contain between one and eight entries.');
        } else {
            probe.streams.forEach((stream, index) => {
                validateTechnicalStream(stream, index, problems);
            });
        }

        return problems;
    }

    function assessDerivativeTechnicalProbe(probe, expectation) {
        const probeProblems = validateDerivativeTechnicalProbe(probe);
        const expectationProblems = validateTechnicalExpectation(expectation);

        if (probeProblems.length > 0 || expectationProblems.length > 0) {
            return Object.freeze({
                valid: false,
                probeValid: probeProblems.length === 0,
                expectationValid: expectationProblems.length === 0,
                problems: Object.freeze([...probeProblems, ...expectationProblems])
            });
        }

        const profile = derivativeProfiles[expectation.role];
        const problems = [];

        if (probe.role !== expectation.role) {
            problems.push('Derivative role does not match the expected profile.');
        }

        if (probe.container !== profile.container) {
            problems.push('Derivative container does not match the expected profile.');
        }

        if (probe.width !== expectation.width || probe.height !== expectation.height) {
            problems.push('Derivative dimensions do not match the expected dimensions.');
        }

        if (probe.width > expectation.sourceWidth || probe.height > expectation.sourceHeight) {
            problems.push('Derivative dimensions upscale the oriented source.');
        }

        if (
            profile.maximumLongEdge &&
            Math.max(probe.width, probe.height) > profile.maximumLongEdge
        ) {
            problems.push('Derivative dimensions exceed the profile long-edge limit.');
        }

        if (
            profile.maximumShortEdge &&
            (
                Math.max(probe.width, probe.height) > profile.maximumLongEdge ||
                Math.min(probe.width, probe.height) > profile.maximumShortEdge
            )
        ) {
            problems.push('Derivative dimensions exceed the video profile limit.');
        }

        const visualStreams = probe.streams.filter(stream => stream.type === profile.streamType);
        const audioStreams = probe.streams.filter(stream => stream.type === 'audio');
        const expectedStreamTypes = new Set([profile.streamType]);
        if (profile.mediaType === 'video') {
            expectedStreamTypes.add('audio');
        }
        const unexpectedStreams = probe.streams.filter(
            stream => !expectedStreamTypes.has(stream.type)
        );

        if (visualStreams.length !== 1) {
            problems.push('Derivative must contain exactly one expected visual stream.');
        } else if (visualStreams[0].codec !== profile.visualCodec) {
            problems.push('Derivative visual codec does not match the expected profile.');
        }

        if (profile.mediaType === 'video') {
            const expectedAudioCount = expectation.audioExpected ? 1 : 0;
            if (audioStreams.length !== expectedAudioCount) {
                problems.push('Derivative audio stream count does not match the expected profile.');
            } else if (
                expectation.audioExpected &&
                audioStreams[0].codec !== profile.audioCodec
            ) {
                problems.push('Derivative audio codec does not match the expected profile.');
            }

            if (!isPositiveFiniteNumber(probe.durationSeconds)) {
                problems.push('Video derivative must report a positive duration.');
            } else if (
                Math.abs(probe.durationSeconds - expectation.sourceDurationSeconds) >
                expectation.durationToleranceSeconds
            ) {
                problems.push('Video derivative duration differs from the expected source duration.');
            }

            if (probe.fastStart !== true) {
                problems.push('Video derivative does not report fast-start layout.');
            }
        } else {
            if (audioStreams.length > 0) {
                problems.push('Image derivative contains an unexpected audio stream.');
            }
            if (probe.durationSeconds !== null) {
                problems.push('Image derivative durationSeconds must be null.');
            }
            if (probe.fastStart !== false) {
                problems.push('Image derivative fastStart must be false.');
            }
        }

        if (unexpectedStreams.length > 0) {
            problems.push('Derivative contains an unexpected stream type.');
        }

        return Object.freeze({
            valid: problems.length === 0,
            probeValid: true,
            expectationValid: true,
            problems: Object.freeze(problems)
        });
    }

    function validateMetadataEntry(entry, index, problems) {
        const label = `Metadata probe metadata[${index}]`;

        if (!isPlainObject(entry)) {
            problems.push(`${label} must be an object.`);
            return;
        }

        for (const key of Object.keys(entry)) {
            if (!allowedMetadataKeys.has(key)) {
                problems.push(`${label} contains an unsupported field.`);
            }
        }

        if (!isBoundedText(entry.path, maximumPathLength)) {
            problems.push(`${label}.path must be non-empty text no longer than ${maximumPathLength} characters.`);
        }

        if (!isMetadataValue(entry.value)) {
            problems.push(
                `${label}.value must be null, boolean, a finite number, or text no longer than ${maximumTextValueLength} characters.`
            );
        }
    }

    function validateChapter(chapter, index, problems) {
        const label = `Metadata probe chapters[${index}]`;

        if (!isPlainObject(chapter)) {
            problems.push(`${label} must be an object.`);
            return;
        }

        for (const key of Object.keys(chapter)) {
            if (!allowedChapterKeys.has(key)) {
                problems.push(`${label} contains an unsupported field.`);
            }
        }

        if (!Number.isSafeInteger(chapter.index) || chapter.index < 0) {
            problems.push(`${label}.index must be a non-negative integer.`);
        }

        if (!isNonNegativeFiniteNumber(chapter.startTimeSeconds)) {
            problems.push(`${label}.startTimeSeconds must be a non-negative finite number.`);
        }

        if (!isNonNegativeFiniteNumber(chapter.endTimeSeconds)) {
            problems.push(`${label}.endTimeSeconds must be a non-negative finite number.`);
        } else if (
            isNonNegativeFiniteNumber(chapter.startTimeSeconds) &&
            chapter.endTimeSeconds < chapter.startTimeSeconds
        ) {
            problems.push(`${label}.endTimeSeconds must not be earlier than startTimeSeconds.`);
        }

        if (
            typeof chapter.title !== 'string' ||
            chapter.title.length > maximumChapterTitleLength ||
            containsControlCharacter(chapter.title)
        ) {
            problems.push(
                `${label}.title must be text no longer than ${maximumChapterTitleLength} characters without control characters.`
            );
        }
    }

    function validateScanSubject(subject, problems) {
        if (!isPlainObject(subject)) {
            problems.push('Scan envelope subject must be an object.');
            return;
        }

        rejectUnsupportedKeys(subject, allowedScanSubjectKeys, 'Scan envelope subject', problems);

        if (typeof subject.sha256 !== 'string' || !sha256Pattern.test(subject.sha256)) {
            problems.push('Scan envelope subject SHA-256 must be 64 lowercase hexadecimal characters.');
        }

        if (!Number.isSafeInteger(subject.byteLength) || subject.byteLength <= 0) {
            problems.push('Scan envelope subject byteLength must be a positive safe integer.');
        }
    }

    function validateScannerIdentity(scanner, problems) {
        if (!isPlainObject(scanner)) {
            problems.push('Scan envelope scanner must be an object.');
            return;
        }

        rejectUnsupportedKeys(scanner, allowedScannerKeys, 'Scan envelope scanner', problems);

        if (typeof scanner.name !== 'string' || !scannerTokenPattern.test(scanner.name)) {
            problems.push('Scan envelope scanner name must be a bounded scanner token.');
        }

        if (typeof scanner.version !== 'string' || !scannerTokenPattern.test(scanner.version)) {
            problems.push('Scan envelope scanner version must be a bounded scanner token.');
        }
    }

    function validateScanStatus(status, problems) {
        if (!isPlainObject(status)) {
            problems.push('Scan envelope status must be an object.');
            return;
        }

        rejectUnsupportedKeys(status, allowedScanStatusKeys, 'Scan envelope status', problems);

        if (typeof status.completed !== 'boolean') {
            problems.push('Scan envelope status completed must be a boolean.');
        }

        if (typeof status.truncated !== 'boolean') {
            problems.push('Scan envelope status truncated must be a boolean.');
        }

        if (!Number.isSafeInteger(status.exitCode)) {
            problems.push('Scan envelope status exitCode must be a safe integer.');
        }
    }

    function validateScanExpectation(expectation) {
        const problems = [];

        if (!isPlainObject(expectation)) {
            return ['Scan expectation must be a JSON object.'];
        }

        rejectUnsupportedKeys(
            expectation,
            allowedScanExpectationKeys,
            'Scan expectation',
            problems
        );

        if (typeof expectation.sha256 !== 'string' || !sha256Pattern.test(expectation.sha256)) {
            problems.push('Scan expectation SHA-256 must be 64 lowercase hexadecimal characters.');
        }

        if (!Number.isSafeInteger(expectation.byteLength) || expectation.byteLength <= 0) {
            problems.push('Scan expectation byteLength must be a positive safe integer.');
        }

        if (
            typeof expectation.scannerName !== 'string' ||
            !scannerTokenPattern.test(expectation.scannerName)
        ) {
            problems.push('Scan expectation scannerName must be a bounded scanner token.');
        }

        if (
            typeof expectation.scannerVersion !== 'string' ||
            !scannerTokenPattern.test(expectation.scannerVersion)
        ) {
            problems.push('Scan expectation scannerVersion must be a bounded scanner token.');
        }

        if (!scanResultKinds.has(expectation.resultKind)) {
            problems.push('Scan expectation resultKind is unsupported.');
        }

        return problems;
    }

    function validateTechnicalStream(stream, index, problems) {
        const label = `Derivative technical probe streams[${index}]`;

        if (!isPlainObject(stream)) {
            problems.push(`${label} must be an object.`);
            return;
        }

        rejectUnsupportedKeys(stream, allowedTechnicalStreamKeys, label, problems);

        if (!isPolicyToken(stream.type)) {
            problems.push(`${label}.type must be a bounded policy token.`);
        }

        if (!isPolicyToken(stream.codec)) {
            problems.push(`${label}.codec must be a bounded policy token.`);
        }
    }

    function validateTechnicalExpectation(expectation) {
        const problems = [];

        if (!isPlainObject(expectation)) {
            return ['Derivative technical expectation must be a JSON object.'];
        }

        rejectUnsupportedKeys(
            expectation,
            allowedTechnicalExpectationKeys,
            'Derivative technical expectation',
            problems
        );

        if (!Object.hasOwn(derivativeProfiles, expectation.role)) {
            problems.push('Derivative technical expectation role is unsupported.');
            return problems;
        }

        for (const field of ['width', 'height', 'sourceWidth', 'sourceHeight']) {
            if (!Number.isSafeInteger(expectation[field]) || expectation[field] <= 0) {
                problems.push(`Derivative technical expectation ${field} must be a positive safe integer.`);
            }
        }

        const profile = derivativeProfiles[expectation.role];
        if (profile.mediaType === 'video') {
            if (!isPositiveFiniteNumber(expectation.sourceDurationSeconds)) {
                problems.push(
                    'Video derivative expectation sourceDurationSeconds must be a positive finite number.'
                );
            }
        } else if (expectation.sourceDurationSeconds !== null) {
            problems.push('Image derivative expectation sourceDurationSeconds must be null.');
        }

        if (
            !isNonNegativeFiniteNumber(expectation.durationToleranceSeconds) ||
            expectation.durationToleranceSeconds > 1
        ) {
            problems.push(
                'Derivative durationToleranceSeconds must be between zero and one second.'
            );
        }

        if (typeof expectation.audioExpected !== 'boolean') {
            problems.push('Derivative technical expectation audioExpected must be a boolean.');
        } else if (profile.mediaType !== 'video' && expectation.audioExpected) {
            problems.push('Image derivative expectation cannot require audio.');
        }

        if (
            profile.maximumLongEdge &&
            Math.max(expectation.width, expectation.height) > profile.maximumLongEdge
        ) {
            problems.push('Derivative expected dimensions exceed the profile long-edge limit.');
        }

        if (
            profile.maximumShortEdge &&
            (
                Math.max(expectation.width, expectation.height) > profile.maximumLongEdge ||
                Math.min(expectation.width, expectation.height) > profile.maximumShortEdge
            )
        ) {
            problems.push('Derivative expected dimensions exceed the video profile limit.');
        }

        if (
            Number.isSafeInteger(expectation.width) &&
            Number.isSafeInteger(expectation.sourceWidth) &&
            expectation.width > expectation.sourceWidth
        ) {
            problems.push('Derivative expected width cannot upscale the oriented source.');
        }

        if (
            Number.isSafeInteger(expectation.height) &&
            Number.isSafeInteger(expectation.sourceHeight) &&
            expectation.height > expectation.sourceHeight
        ) {
            problems.push('Derivative expected height cannot upscale the oriented source.');
        }

        return problems;
    }

    function rejectUnsupportedKeys(value, allowedKeys, label, problems) {
        for (const key of Object.keys(value)) {
            if (!allowedKeys.has(key)) {
                problems.push(`${label} contains an unsupported field.`);
            }
        }
    }

    function isSafeBaseName(value) {
        return isBoundedText(value, 255) &&
            value !== '.' &&
            value !== '..' &&
            !value.includes('/') &&
            !value.includes('\\') &&
            !/[<>:"|?*]/.test(value) &&
            fileExtension(value) !== '';
    }

    function isLowercaseMimeType(value) {
        return typeof value === 'string' &&
            /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(value);
    }

    function isPolicyToken(value) {
        return typeof value === 'string' && /^[a-z0-9][a-z0-9._+-]{0,79}$/.test(value);
    }

    function fileExtension(fileName) {
        if (typeof fileName !== 'string') {
            return '';
        }

        const dotIndex = fileName.lastIndexOf('.');
        if (dotIndex <= 0 || dotIndex === fileName.length - 1) {
            return '';
        }

        return fileName.slice(dotIndex + 1).toLowerCase();
    }

    function toUint8Array(value) {
        if (value instanceof ArrayBuffer) {
            return new Uint8Array(value);
        }

        if (ArrayBuffer.isView(value)) {
            return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        }

        return null;
    }

    function startsWithBytes(view, expected) {
        if (view.byteLength < expected.length) {
            return false;
        }

        return expected.every((value, index) => view[index] === value);
    }

    function readAscii(view, offset, length) {
        if (offset < 0 || length < 0 || offset + length > view.byteLength) {
            return '';
        }

        let result = '';
        for (let index = offset; index < offset + length; index += 1) {
            result += String.fromCharCode(view[index]);
        }
        return result;
    }

    function deepFreeze(value) {
        if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
            return value;
        }

        Object.freeze(value);
        Object.values(value).forEach(deepFreeze);
        return value;
    }

    function normalizeMetadataPath(value) {
        return typeof value === 'string'
            ? value.toLowerCase().replace(/[^a-z0-9]+/g, '')
            : '';
    }

    function isMetadataValue(value) {
        return value === null ||
            typeof value === 'boolean' ||
            (typeof value === 'number' && Number.isFinite(value)) ||
            (
                typeof value === 'string' &&
                value.length <= maximumTextValueLength &&
                !containsControlCharacter(value)
            );
    }

    function isBoundedText(value, maximumLength) {
        return typeof value === 'string' &&
            value.trim().length > 0 &&
            value.length <= maximumLength &&
            !containsControlCharacter(value);
    }

    function containsControlCharacter(value) {
        return /[\u0000-\u001F\u007F]/.test(value);
    }

    function isNonNegativeFiniteNumber(value) {
        return typeof value === 'number' && Number.isFinite(value) && value >= 0;
    }

    function isPositiveFiniteNumber(value) {
        return typeof value === 'number' && Number.isFinite(value) && value > 0;
    }

    function isPlainObject(value) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            return false;
        }

        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    return Object.freeze({
        schemaVersion,
        stages: Object.freeze({
            source: sourceStage,
            publicDerivative: publicDerivativeStage
        }),
        categories,
        inputLimits,
        inputFormats,
        derivativeRoles,
        derivativeProfiles,
        validateMetadataProbe,
        assessMetadataProbe,
        classifyMetadataPath,
        validateScanEnvelope,
        assessScanEnvelope,
        validateInputFileProbe,
        assessInputFile,
        detectAllowedFileType,
        validateDerivativeTechnicalProbe,
        assessDerivativeTechnicalProbe
    });
});
