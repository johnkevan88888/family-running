import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const policyModule = await import('../gallery-media-policy.js');
const policy = policyModule.default || policyModule;

const sentinels = Object.freeze({
    fileName: 'PRIVATE-FAMILY-FINISH-SENTINEL.jpg',
    path: 'C:\\private\\family\\PRIVATE-FAMILY-FINISH-SENTINEL.jpg',
    gps: '+40.7484-073.9857/',
    deviceSerial: 'PRIVATE-DEVICE-SERIAL-SENTINEL',
    chapter: 'PRIVATE-CHAPTER-SENTINEL',
    owner: 'PRIVATE-OWNER-SENTINEL',
    consent: 'PRIVATE-CONSENT-SENTINEL',
    token: 'PRIVATE-TOKEN-SENTINEL',
    signedUrl: 'https://private.invalid/object?signature=PRIVATE-SIGNED-URL-SENTINEL',
    objectKey: 'private/originals/PRIVATE-OBJECT-KEY-SENTINEL'
});
const allSentinelValues = Object.freeze(Object.values(sentinels));

const hostilePhotoProbe = buildHostilePhotoProbe();
const hostileVideoProbe = buildHostileVideoProbe();
const embeddedScannerSentinels = Object.freeze([
    sentinels.gps,
    sentinels.deviceSerial,
    sentinels.fileName,
    sentinels.chapter
]);
const hostilePhotoBytes = buildSyntheticMetadataBytes('jpeg', embeddedScannerSentinels);
const hostileVideoBytes = buildSyntheticMetadataBytes('quicktime', embeddedScannerSentinels);

assert.deepEqual(policy.validateMetadataProbe(hostilePhotoProbe), []);
assert.deepEqual(policy.validateMetadataProbe(hostileVideoProbe), []);

assert.equal(policy.classifyMetadataPath('EXIF.GPS.GPSLatitude'), 'location');
assert.equal(
    policy.classifyMetadataPath('QuickTime.Keys.com.apple.quicktime.location.ISO6709'),
    'location'
);
assert.equal(policy.classifyMetadataPath('EXIF.IFD0.Make'), 'device');
assert.equal(policy.classifyMetadataPath('QuickTime.Keys.DeviceModelName'), 'device');
assert.equal(policy.classifyMetadataPath('EXIF.IFD0.Orientation'), 'orientation');
assert.equal(policy.classifyMetadataPath('QuickTime.Track1.Rotation'), 'orientation');
assert.equal(policy.classifyMetadataPath('QuickTime.UserData.ChapterList'), 'chapter');
assert.equal(policy.classifyMetadataPath('File.SourceFile'), 'source-name');
assert.equal(policy.classifyMetadataPath('QuickTime.MediaDataSize'), 'other');

const photoSourceAssessment = policy.assessMetadataProbe(
    hostilePhotoProbe,
    policy.stages.source
);

assert.equal(photoSourceAssessment.valid, true);
assert.equal(photoSourceAssessment.probeValid, true);
assert.equal(photoSourceAssessment.requiresSanitization, true);
assert.deepEqual(
    photoSourceAssessment.findings.map(finding => finding.category),
    [
        'location',
        'location',
        'device',
        'device',
        'device',
        'source-name',
        'chapter',
        'orientation'
    ]
);
assert.deepEqual(photoSourceAssessment.problems, []);
assertAssessmentRedactsValues(photoSourceAssessment, hostilePhotoProbe);

const photoDerivativeAssessment = policy.assessMetadataProbe(
    hostilePhotoProbe,
    policy.stages.publicDerivative
);

assert.equal(photoDerivativeAssessment.valid, false);
assert.equal(photoDerivativeAssessment.probeValid, true);
assert.equal(photoDerivativeAssessment.problems.length, hostilePhotoProbe.metadata.length);
assert.match(photoDerivativeAssessment.problems.join('\n'), /retains location metadata/);
assert.match(photoDerivativeAssessment.problems.join('\n'), /retains device metadata/);
assert.match(photoDerivativeAssessment.problems.join('\n'), /retains orientation metadata/);
assertAssessmentRedactsValues(photoDerivativeAssessment, hostilePhotoProbe);

const videoSourceAssessment = policy.assessMetadataProbe(
    hostileVideoProbe,
    policy.stages.source
);

assert.equal(videoSourceAssessment.valid, true);
assert.equal(videoSourceAssessment.requiresSanitization, true);
assert.deepEqual(
    videoSourceAssessment.findings.map(finding => finding.category),
    [
        'location',
        'location',
        'device',
        'device',
        'device',
        'source-name',
        'chapter',
        'orientation',
        'other',
        'chapter',
        'chapter'
    ]
);
assertAssessmentRedactsValues(videoSourceAssessment, hostileVideoProbe);

const videoDerivativeAssessment = policy.assessMetadataProbe(
    hostileVideoProbe,
    policy.stages.publicDerivative
);

assert.equal(videoDerivativeAssessment.valid, false);
assert.equal(
    videoDerivativeAssessment.problems.length,
    hostileVideoProbe.metadata.length + hostileVideoProbe.chapters.length
);
assert.match(videoDerivativeAssessment.problems.join('\n'), /retains chapter metadata/);
assert.match(videoDerivativeAssessment.problems.join('\n'), /retains source-name metadata/);
assertAssessmentRedactsValues(videoDerivativeAssessment, hostileVideoProbe);

// The hostile normalized probes stay bound to the exact synthetic objects that
// carried their private metadata. Integrity is necessary, but it does not make
// a metadata-bearing object eligible to become a public derivative.
const hostileScannerFixtures = [
    {
        label: 'photo',
        format: 'jpeg',
        bytes: hostilePhotoBytes,
        probe: hostilePhotoProbe
    },
    {
        label: 'video',
        format: 'quicktime',
        bytes: hostileVideoBytes,
        probe: hostileVideoProbe
    }
];

for (const fixture of hostileScannerFixtures) {
    const fixtureText = new TextDecoder().decode(fixture.bytes);
    for (const sentinel of embeddedScannerSentinels) {
        assert.equal(
            fixtureText.includes(sentinel),
            true,
            `${fixture.label} byte fixture did not contain an expected synthetic sentinel.`
        );
    }

    assert.equal(policy.detectAllowedFileType(fixture.bytes), fixture.format);

    const expectation = {
        sha256: sha256Hex(fixture.bytes),
        byteLength: fixture.bytes.byteLength,
        scannerName: 'exiftool',
        scannerVersion: '13.40',
        resultKind: 'metadata'
    };
    const envelope = makeScanEnvelope(expectation, fixture.probe);

    assert.equal(envelope.subject.sha256, sha256Hex(fixture.bytes));
    assert.equal(envelope.subject.byteLength, fixture.bytes.byteLength);

    const integrityAssessment = policy.assessScanEnvelope(envelope, expectation);
    assert.equal(
        integrityAssessment.valid,
        true,
        `${fixture.label} scanner envelope failed exact object binding.`
    );
    assertNoSentinels(integrityAssessment);

    const publicAssessment = policy.assessMetadataProbe(
        envelope.result,
        policy.stages.publicDerivative
    );
    assert.equal(
        publicAssessment.valid,
        false,
        `${fixture.label} metadata-bearing object was accepted as a public derivative.`
    );
    assertNoSentinels(publicAssessment);
}

for (const mediaType of ['photo', 'video']) {
    const cleanDerivative = makeProbe(mediaType);
    const assessment = policy.assessMetadataProbe(
        cleanDerivative,
        policy.stages.publicDerivative
    );

    assert.equal(assessment.valid, true);
    assert.equal(assessment.probeValid, true);
    assert.equal(assessment.requiresSanitization, false);
    assert.deepEqual(assessment.findings, []);
    assert.deepEqual(assessment.problems, []);
}

const unknownMetadataProbe = makeProbe('photo', [
    metadata('Vendor.Private.UnrecognizedTag', 'synthetic private value')
]);
const unknownDerivativeAssessment = policy.assessMetadataProbe(
    unknownMetadataProbe,
    policy.stages.publicDerivative
);

assert.equal(unknownDerivativeAssessment.valid, false);
assert.deepEqual(
    unknownDerivativeAssessment.findings.map(finding => finding.category),
    ['other']
);
assert.match(unknownDerivativeAssessment.problems.join('\n'), /retains other metadata/);
assertAssessmentRedactsValues(unknownDerivativeAssessment, unknownMetadataProbe);

assert.match(
    policy.validateMetadataProbe({
        ...makeProbe('photo'),
        privateOriginalPath: 'private/example.jpg'
    }).join('\n'),
    /unsupported field/
);
assert.match(
    policy.validateMetadataProbe({
        ...makeProbe('photo'),
        metadata: [{ path: 'EXIF.GPS.GPSLatitude', value: { degrees: 40 } }]
    }).join('\n'),
    /value must be null, boolean, a finite number, or text/
);
assert.match(
    policy.validateMetadataProbe({
        ...makeProbe('photo'),
        metadata: [{ path: 'EXIF.GPS.\nGPSLatitude', value: 'synthetic' }]
    }).join('\n'),
    /path must be non-empty text/
);
assert.match(
    policy.validateMetadataProbe({
        ...makeProbe('photo'),
        chapters: [chapter(0, 0, 1, 'Synthetic chapter')]
    }).join('\n'),
    /photo metadata probe cannot contain chapters/
);
assert.match(
    policy.validateMetadataProbe({
        ...makeProbe('video'),
        chapters: [chapter(0, 2, 1, 'Backwards')]
    }).join('\n'),
    /endTimeSeconds must not be earlier/
);

const malformedAssessment = policy.assessMetadataProbe(
    { schemaVersion: '1.0', mediaType: 'video', metadata: 'not-an-array', chapters: [] },
    policy.stages.publicDerivative
);

assert.equal(malformedAssessment.valid, false);
assert.equal(malformedAssessment.probeValid, false);
assert.equal(malformedAssessment.requiresSanitization, true);
assert.deepEqual(malformedAssessment.findings, []);
assert.match(malformedAssessment.problems.join('\n'), /metadata must be an array/);

const unsupportedStageAssessment = policy.assessMetadataProbe(
    makeProbe('photo'),
    'published-ish'
);

assert.equal(unsupportedStageAssessment.valid, false);
assert.equal(unsupportedStageAssessment.probeValid, false);
assert.equal(unsupportedStageAssessment.requiresSanitization, true);
assert.equal(unsupportedStageAssessment.stage, null);
assert.match(unsupportedStageAssessment.problems.join('\n'), /assessment stage must be/);
assert.equal(JSON.stringify(unsupportedStageAssessment).includes('published-ish'), false);

// A scan envelope is trusted only when its object digest, object length, pinned
// scanner identity, successful completion, and complete output all agree.
const scanBytes = buildSyntheticBytes('jpeg');
const scanExpectation = {
    sha256: sha256Hex(scanBytes),
    byteLength: scanBytes.byteLength,
    scannerName: 'exiftool',
    scannerVersion: '13.40',
    resultKind: 'metadata'
};
const privateSentinelProbe = makeProbe(
    'video',
    [
        metadata('QuickTime.Keys.LocationISO6709', sentinels.gps),
        metadata('QuickTime.Keys.DeviceSerialNumber', sentinels.deviceSerial),
        metadata('File.OriginalFileName', sentinels.fileName),
        metadata('File.SourceFile', sentinels.path),
        metadata(`Private.${sentinels.owner}`, sentinels.owner),
        metadata('Private.Consent', sentinels.consent),
        metadata('Private.Token', sentinels.token),
        metadata('Private.SignedUrl', sentinels.signedUrl),
        metadata('Private.ObjectKey', sentinels.objectKey)
    ],
    [chapter(0, 0, 1, sentinels.chapter)]
);
const trustedEnvelope = makeScanEnvelope(scanExpectation, privateSentinelProbe);

const privateMetadataAssessment = policy.assessMetadataProbe(
    privateSentinelProbe,
    policy.stages.publicDerivative
);
assert.equal(privateMetadataAssessment.valid, false);
assertNoSentinels(privateMetadataAssessment);

assert.deepEqual(policy.validateScanEnvelope(trustedEnvelope), []);
const trustedScanAssessment = policy.assessScanEnvelope(trustedEnvelope, scanExpectation);
assert.equal(trustedScanAssessment.valid, true);
assert.deepEqual(trustedScanAssessment.problems, []);
assertNoSentinels(trustedScanAssessment);

const scanFailureCases = [
    {
        label: 'hash mismatch',
        envelope: withNested(trustedEnvelope, 'subject', { sha256: '0'.repeat(64) }),
        expected: /SHA-256 does not match/
    },
    {
        label: 'length mismatch',
        envelope: withNested(trustedEnvelope, 'subject', { byteLength: scanBytes.byteLength + 1 }),
        expected: /byte length does not match/
    },
    {
        label: 'scanner mismatch',
        envelope: withNested(trustedEnvelope, 'scanner', { name: 'different-scanner' }),
        expected: /scanner identity does not match/
    },
    {
        label: 'scanner version mismatch',
        envelope: withNested(trustedEnvelope, 'scanner', { version: '99.0' }),
        expected: /scanner identity does not match/
    },
    {
        label: 'incomplete scan',
        envelope: withNested(trustedEnvelope, 'status', { completed: false }),
        expected: /did not report a completed scan/
    },
    {
        label: 'truncated scan',
        envelope: withNested(trustedEnvelope, 'status', { truncated: true }),
        expected: /reported truncated output/
    },
    {
        label: 'tool failure',
        envelope: withNested(trustedEnvelope, 'status', { exitCode: 2 }),
        expected: /reported a tool failure/
    }
];

for (const testCase of scanFailureCases) {
    const assessment = policy.assessScanEnvelope(testCase.envelope, scanExpectation);
    assert.equal(assessment.valid, false, `${testCase.label} was accepted.`);
    assert.match(assessment.problems.join('\n'), testCase.expected);
    assertNoSentinels(assessment);
}

const malformedEnvelope = {
    ...trustedEnvelope,
    result: null,
    [sentinels.owner]: sentinels.token
};
const malformedEnvelopeAssessment = policy.assessScanEnvelope(
    malformedEnvelope,
    scanExpectation
);
assert.equal(malformedEnvelopeAssessment.valid, false);
assert.equal(malformedEnvelopeAssessment.envelopeValid, false);
assert.match(malformedEnvelopeAssessment.problems.join('\n'), /unsupported field/);
assert.match(malformedEnvelopeAssessment.problems.join('\n'), /result must be a JSON object/);
assertNoSentinels(malformedEnvelopeAssessment);

const malformedResultAssessment = policy.assessScanEnvelope(
    { ...trustedEnvelope, result: {} },
    scanExpectation
);
assert.equal(malformedResultAssessment.valid, false);
assert.equal(malformedResultAssessment.envelopeValid, false);
assert.match(malformedResultAssessment.problems.join('\n'), /declared result kind/);
assertNoSentinels(malformedResultAssessment);

const resultKindMismatchAssessment = policy.assessScanEnvelope(
    trustedEnvelope,
    { ...scanExpectation, resultKind: 'input-file' }
);
assert.equal(resultKindMismatchAssessment.valid, false);
assert.match(resultKindMismatchAssessment.problems.join('\n'), /result kind does not match/);
assertNoSentinels(resultKindMismatchAssessment);

const privateScannerEnvelope = withNested(trustedEnvelope, 'scanner', {
    name: sentinels.owner
});
const privateScannerAssessment = policy.assessScanEnvelope(
    privateScannerEnvelope,
    scanExpectation
);
assert.equal(privateScannerAssessment.valid, false);
assertNoSentinels(privateScannerAssessment);

// Input admission uses the decoded type, declared MIME type, base-name
// extension, byte signature, decoder status, and conservative limits together.
const acceptedInputCases = [
    ['jpeg', sentinels.fileName, 'image/jpeg'],
    ['png', 'synthetic.png', 'image/png'],
    ['webp', 'synthetic.webp', 'image/webp'],
    ['heif', 'synthetic.heic', 'image/heic'],
    ['mp4', 'synthetic.mp4', 'video/mp4'],
    ['quicktime', 'synthetic.mov', 'video/quicktime'],
    ['webm', 'synthetic.webm', 'video/webm']
];

for (const [format, fileName, mimeType] of acceptedInputCases) {
    const bytes = buildSyntheticBytes(format);
    const inputProbe = makeInputProbe(format, fileName, mimeType, bytes.byteLength);
    const assessment = policy.assessInputFile(inputProbe, bytes);

    assert.equal(assessment.valid, true, `${format} fixture was rejected: ${assessment.problems}`);
    assert.equal(assessment.acceptedFormat, format);
    assert.equal(policy.detectAllowedFileType(bytes), format);
    assertNoSentinels(assessment);
}

assert.equal(policy.inputLimits.photo.maximumBytes, 25 * 1024 * 1024);
assert.equal(policy.inputLimits.photo.maximumPixels, 50 * 1000 * 1000);
assert.equal(policy.inputLimits.video.maximumBytes, 500 * 1024 * 1024);
assert.equal(policy.inputLimits.video.maximumDurationSeconds, 600);

const jpegBytes = buildSyntheticBytes('jpeg');
const validJpegProbe = makeInputProbe(
    'jpeg',
    sentinels.fileName,
    'image/jpeg',
    jpegBytes.byteLength
);
assert.equal(
    policy.assessInputFile(
        { ...validJpegProbe, width: 10000, height: 5000 },
        jpegBytes
    ).valid,
    true,
    'The exact 50-megapixel photo boundary was rejected.'
);

const boundaryMp4Bytes = buildSyntheticBytes('mp4');
assert.equal(
    policy.assessInputFile(
        {
            ...makeInputProbe(
                'mp4',
                'synthetic.mp4',
                'video/mp4',
                boundaryMp4Bytes.byteLength
            ),
            durationSeconds: 600
        },
        boundaryMp4Bytes
    ).valid,
    true,
    'The exact ten-minute video boundary was rejected.'
);
const inputFailureCases = [
    {
        label: 'private path instead of base name',
        probe: { ...validJpegProbe, fileName: sentinels.path },
        bytes: jpegBytes,
        expected: /plain base name/
    },
    {
        label: 'misleading extension',
        probe: { ...validJpegProbe, fileName: 'synthetic.png' },
        bytes: jpegBytes,
        expected: /extension does not match/
    },
    {
        label: 'double extension',
        probe: { ...validJpegProbe, fileName: 'synthetic.jpg.exe' },
        bytes: jpegBytes,
        expected: /extension does not match/
    },
    {
        label: 'MIME mismatch',
        probe: { ...validJpegProbe, declaredMimeType: 'image/png' },
        bytes: jpegBytes,
        expected: /MIME type does not match/
    },
    {
        label: 'detector and magic mismatch',
        probe: { ...validJpegProbe, detectedFormat: 'png', fileName: 'synthetic.png', declaredMimeType: 'image/png' },
        bytes: jpegBytes,
        expected: /signature does not match/
    },
    {
        label: 'selected type mismatch',
        probe: { ...validJpegProbe, mediaType: 'video', durationSeconds: 1 },
        bytes: jpegBytes,
        expected: /selected media type/
    },
    {
        label: 'incomplete inspection',
        probe: { ...validJpegProbe, inspectionCompleted: false },
        bytes: jpegBytes,
        expected: /inspection did not complete/
    },
    {
        label: 'corrupt input',
        probe: { ...validJpegProbe, corrupt: true },
        bytes: jpegBytes,
        expected: /corrupt or malformed/
    },
    {
        label: 'byte length mismatch',
        probe: { ...validJpegProbe, byteLength: jpegBytes.byteLength + 1 },
        bytes: jpegBytes,
        expected: /byte length does not match/
    },
    {
        label: 'byte limit',
        probe: {
            ...validJpegProbe,
            byteLength: policy.inputLimits.photo.maximumBytes + 1
        },
        bytes: jpegBytes,
        expected: /exceeds the byte limit/
    },
    {
        label: 'pixel limit',
        probe: { ...validJpegProbe, width: 10000, height: 5001 },
        bytes: jpegBytes,
        expected: /exceeds the pixel limit/
    }
];

const mp4Bytes = buildSyntheticBytes('mp4');
inputFailureCases.push({
    label: 'duration limit',
    probe: {
        ...makeInputProbe('mp4', 'synthetic.mp4', 'video/mp4', mp4Bytes.byteLength),
        durationSeconds: policy.inputLimits.video.maximumDurationSeconds + 0.001
    },
    bytes: mp4Bytes,
    expected: /exceeds the duration limit/
});

const unknownBytes = new TextEncoder().encode(
    `<svg data-owner="${sentinels.owner}"><script>${sentinels.token}</script></svg>`
);
inputFailureCases.push({
    label: 'unknown executable markup',
    probe: {
        ...makeInputProbe('jpeg', 'synthetic.svg', 'image/svg+xml', unknownBytes.byteLength),
        detectedFormat: 'svg'
    },
    bytes: unknownBytes,
    expected: /unsupported or unknown/
});

for (const testCase of inputFailureCases) {
    const assessment = policy.assessInputFile(testCase.probe, testCase.bytes);
    assert.equal(assessment.valid, false, `${testCase.label} was accepted.`);
    assert.equal(assessment.acceptedMediaType, null);
    assert.equal(assessment.acceptedFormat, null);
    assert.match(assessment.problems.join('\n'), testCase.expected);
    assertNoSentinels(assessment);
}

// Technical output probes prove the transform produced the pinned public
// profile rather than merely trusting a successful command exit.
const displayExpectation = makeTechnicalExpectation('photo-display', {
    width: 1600,
    height: 1200,
    sourceWidth: 4000,
    sourceHeight: 3000
});
const displayProbe = makeTechnicalProbe('photo-display', {
    width: 1600,
    height: 1200,
    streams: [{ type: 'image', codec: 'webp' }]
});
assert.equal(
    policy.assessDerivativeTechnicalProbe(displayProbe, displayExpectation).valid,
    true
);

const thumbnailExpectation = makeTechnicalExpectation('photo-thumbnail', {
    width: 480,
    height: 360,
    sourceWidth: 4000,
    sourceHeight: 3000
});
const thumbnailProbe = makeTechnicalProbe('photo-thumbnail', {
    width: 480,
    height: 360,
    streams: [{ type: 'image', codec: 'webp' }]
});
assert.equal(
    policy.assessDerivativeTechnicalProbe(thumbnailProbe, thumbnailExpectation).valid,
    true
);

const posterExpectation = makeTechnicalExpectation('video-poster', {
    width: 720,
    height: 405,
    sourceWidth: 1920,
    sourceHeight: 1080
});
const posterProbe = makeTechnicalProbe('video-poster', {
    width: 720,
    height: 405,
    streams: [{ type: 'image', codec: 'webp' }]
});
assert.equal(
    policy.assessDerivativeTechnicalProbe(posterProbe, posterExpectation).valid,
    true
);

const videoExpectation = makeTechnicalExpectation('video-playback', {
    width: 1920,
    height: 1080,
    sourceWidth: 3840,
    sourceHeight: 2160,
    sourceDurationSeconds: 60,
    durationToleranceSeconds: 0.05,
    audioExpected: true
});
const videoProbe = makeTechnicalProbe('video-playback', {
    width: 1920,
    height: 1080,
    durationSeconds: 60.02,
    fastStart: true,
    streams: [
        { type: 'video', codec: 'h264' },
        { type: 'audio', codec: 'aac' }
    ]
});
const videoTechnicalAssessment = policy.assessDerivativeTechnicalProbe(
    videoProbe,
    videoExpectation
);
assert.equal(videoTechnicalAssessment.valid, true, videoTechnicalAssessment.problems.join('\n'));

const technicalScanExpectation = {
    sha256: sha256Hex(mp4Bytes),
    byteLength: mp4Bytes.byteLength,
    scannerName: 'ffprobe',
    scannerVersion: '8.0.1',
    resultKind: 'technical-derivative'
};
const technicalScanEnvelope = makeScanEnvelope(
    technicalScanExpectation,
    videoProbe
);
assert.equal(
    policy.assessScanEnvelope(technicalScanEnvelope, technicalScanExpectation).valid,
    true
);

const portraitExpectation = makeTechnicalExpectation('video-playback', {
    width: 1080,
    height: 1920,
    sourceWidth: 2160,
    sourceHeight: 3840,
    sourceDurationSeconds: 10,
    durationToleranceSeconds: 0.05,
    audioExpected: false
});
const portraitProbe = makeTechnicalProbe('video-playback', {
    width: 1080,
    height: 1920,
    durationSeconds: 10,
    fastStart: true,
    streams: [{ type: 'video', codec: 'h264' }]
});
assert.equal(
    policy.assessDerivativeTechnicalProbe(portraitProbe, portraitExpectation).valid,
    true
);

const technicalFailureCases = [
    {
        label: 'wrong container',
        probe: { ...videoProbe, container: 'quicktime' },
        expected: /container does not match/
    },
    {
        label: 'wrong video codec',
        probe: { ...videoProbe, streams: [{ type: 'video', codec: 'hevc' }, { type: 'audio', codec: 'aac' }] },
        expected: /visual codec does not match/
    },
    {
        label: 'wrong audio codec',
        probe: { ...videoProbe, streams: [{ type: 'video', codec: 'h264' }, { type: 'audio', codec: 'mp3' }] },
        expected: /audio codec does not match/
    },
    {
        label: 'unexpected subtitle stream',
        probe: { ...videoProbe, streams: [...videoProbe.streams, { type: 'subtitle', codec: 'webvtt' }] },
        expected: /unexpected stream type/
    },
    {
        label: 'duplicate visual stream',
        probe: { ...videoProbe, streams: [...videoProbe.streams, { type: 'video', codec: 'h264' }] },
        expected: /exactly one expected visual stream/
    },
    {
        label: 'wrong dimensions',
        probe: { ...videoProbe, width: 1280, height: 720 },
        expected: /dimensions do not match/
    },
    {
        label: 'wrong duration',
        probe: { ...videoProbe, durationSeconds: 59 },
        expected: /duration differs/
    },
    {
        label: 'missing fast start',
        probe: { ...videoProbe, fastStart: false },
        expected: /does not report fast-start/
    }
];

for (const testCase of technicalFailureCases) {
    const assessment = policy.assessDerivativeTechnicalProbe(
        testCase.probe,
        videoExpectation
    );
    assert.equal(assessment.valid, false, `${testCase.label} was accepted.`);
    assert.match(assessment.problems.join('\n'), testCase.expected);
    assertNoSentinels(assessment);
}

const privateCodecProbe = {
    ...videoProbe,
    streams: [
        { type: 'video', codec: sentinels.token },
        { type: 'audio', codec: 'aac' }
    ],
    [sentinels.objectKey]: sentinels.signedUrl
};
const privateCodecAssessment = policy.assessDerivativeTechnicalProbe(
    privateCodecProbe,
    videoExpectation
);
assert.equal(privateCodecAssessment.valid, false);
assert.match(privateCodecAssessment.problems.join('\n'), /unsupported field/);
assertNoSentinels(privateCodecAssessment);

const consoleOutput = captureConsole(() => {
    policy.assessMetadataProbe(privateSentinelProbe, policy.stages.publicDerivative);
    policy.assessScanEnvelope(malformedEnvelope, scanExpectation);
    policy.assessInputFile({ ...validJpegProbe, fileName: sentinels.path }, jpegBytes);
    policy.assessDerivativeTechnicalProbe(privateCodecProbe, videoExpectation);
});
assertNoSentinels(consoleOutput);
assert.deepEqual(consoleOutput, []);

console.log('Gallery media metadata policy tests passed.');

function buildHostilePhotoProbe() {
    return makeProbe('photo', [
        metadata('EXIF.GPS.GPSLatitude', sentinels.gps),
        metadata('EXIF.GPS.GPSLongitude', '73 deg 59 min 8.400 sec W'),
        metadata('EXIF.IFD0.Make', 'Synthetic Camera Company'),
        metadata('EXIF.IFD0.Model', 'Synthetic Pocket Camera 1'),
        metadata('EXIF.ExifIFD.BodySerialNumber', sentinels.deviceSerial),
        metadata('File.OriginalFileName', sentinels.fileName),
        metadata('XMP.EmbeddedChapterMarker', sentinels.chapter),
        metadata('EXIF.IFD0.Orientation', 6)
    ]);
}

function buildHostileVideoProbe() {
    return makeProbe(
        'video',
        [
            metadata('QuickTime.Keys.com.apple.quicktime.location.ISO6709', sentinels.gps),
            metadata('QuickTime.UserData.GPSCoordinates', '40.7484 -73.9857'),
            metadata('QuickTime.Keys.Make', 'Synthetic Phone Company'),
            metadata('QuickTime.Keys.Model', 'Synthetic Phone 1'),
            metadata('QuickTime.Keys.DeviceSerialNumber', sentinels.deviceSerial),
            metadata('QuickTime.UserData.OriginalFileName', sentinels.fileName),
            metadata('QuickTime.UserData.ChapterList', 'Home; Finish line'),
            metadata('QuickTime.Track1.Rotation', 90),
            metadata('QuickTime.UserData.Comment', '</script><script>alert("synthetic")</script>')
        ],
        [chapter(0, 0, 3.5, sentinels.chapter), chapter(1, 3.5, 8.25, 'Finish line')]
    );
}

function makeProbe(mediaType, metadataEntries = [], chapterEntries = []) {
    return {
        schemaVersion: '1.0',
        mediaType,
        metadata: metadataEntries,
        chapters: chapterEntries
    };
}

function metadata(path, value) {
    return { path, value };
}

function chapter(index, startTimeSeconds, endTimeSeconds, title) {
    return { index, startTimeSeconds, endTimeSeconds, title };
}

function makeScanEnvelope(expectation, result) {
    return {
        schemaVersion: '1.0',
        resultKind: expectation.resultKind,
        subject: {
            sha256: expectation.sha256,
            byteLength: expectation.byteLength
        },
        scanner: {
            name: expectation.scannerName,
            version: expectation.scannerVersion
        },
        status: {
            completed: true,
            truncated: false,
            exitCode: 0
        },
        result
    };
}

function withNested(value, key, changes) {
    return {
        ...value,
        [key]: {
            ...value[key],
            ...changes
        }
    };
}

function sha256Hex(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

function buildSyntheticBytes(format) {
    const bytes = new Uint8Array(64);

    if (format === 'jpeg') {
        bytes.set([0xFF, 0xD8, 0xFF, 0xE0], 0);
    } else if (format === 'png') {
        bytes.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], 0);
    } else if (format === 'webp') {
        writeAscii(bytes, 0, 'RIFF');
        writeAscii(bytes, 8, 'WEBP');
    } else if (format === 'heif') {
        writeAscii(bytes, 4, 'ftyp');
        writeAscii(bytes, 8, 'heic');
    } else if (format === 'mp4') {
        writeAscii(bytes, 4, 'ftyp');
        writeAscii(bytes, 8, 'isom');
    } else if (format === 'quicktime') {
        writeAscii(bytes, 4, 'ftyp');
        writeAscii(bytes, 8, 'qt  ');
    } else if (format === 'webm') {
        bytes.set([0x1A, 0x45, 0xDF, 0xA3], 0);
        writeAscii(bytes, 12, 'webm');
    } else {
        throw new Error('Unsupported synthetic format requested by the test.');
    }

    return bytes;
}

function buildSyntheticMetadataBytes(format, values) {
    const header = buildSyntheticBytes(format);
    const payload = new TextEncoder().encode(
        `SYNTHETIC-METADATA\0${values.join('\0')}\0`
    );
    const bytes = new Uint8Array(header.byteLength + payload.byteLength);

    bytes.set(header, 0);
    bytes.set(payload, header.byteLength);
    return bytes;
}

function writeAscii(bytes, offset, value) {
    for (let index = 0; index < value.length; index += 1) {
        bytes[offset + index] = value.charCodeAt(index);
    }
}

function makeInputProbe(format, fileName, declaredMimeType, byteLength) {
    const mediaType = policy.inputFormats[format]?.mediaType || 'photo';

    return {
        schemaVersion: '1.0',
        fileName,
        declaredMimeType,
        mediaType,
        detectedFormat: format,
        byteLength,
        width: mediaType === 'video' ? 1920 : 1000,
        height: mediaType === 'video' ? 1080 : 800,
        durationSeconds: mediaType === 'video' ? 30 : null,
        inspectionCompleted: true,
        corrupt: false
    };
}

function makeTechnicalExpectation(role, overrides = {}) {
    return {
        role,
        width: 100,
        height: 100,
        sourceWidth: 100,
        sourceHeight: 100,
        sourceDurationSeconds: role === 'video-playback' ? 10 : null,
        durationToleranceSeconds: role === 'video-playback' ? 0.05 : 0,
        audioExpected: false,
        ...overrides
    };
}

function makeTechnicalProbe(role, overrides = {}) {
    const profile = policy.derivativeProfiles[role];

    return {
        schemaVersion: '1.0',
        role,
        container: profile.container,
        width: 100,
        height: 100,
        durationSeconds: role === 'video-playback' ? 10 : null,
        fastStart: role === 'video-playback',
        streams: [{ type: profile.streamType, codec: profile.visualCodec }],
        ...overrides
    };
}

function captureConsole(callback) {
    const methods = ['debug', 'error', 'info', 'log', 'warn'];
    const originals = new Map();
    const output = [];

    for (const method of methods) {
        originals.set(method, console[method]);
        console[method] = (...values) => {
            output.push(values.map(value => {
                if (typeof value === 'string') {
                    return value;
                }

                try {
                    return JSON.stringify(value);
                } catch {
                    return String(value);
                }
            }).join(' '));
        };
    }

    try {
        callback();
    } finally {
        for (const method of methods) {
            console[method] = originals.get(method);
        }
    }

    return output;
}

function assertNoSentinels(value) {
    const serialized = JSON.stringify(value);

    for (const sentinel of allSentinelValues) {
        assert.equal(
            serialized.includes(sentinel),
            false,
            `Policy output leaked a synthetic private sentinel.`
        );
    }
}

function assertAssessmentRedactsValues(assessment, probe) {
    const serialized = JSON.stringify(assessment);
    const privateValues = [
        ...probe.metadata.map(entry => entry.value),
        ...probe.chapters.map(entry => entry.title)
    ];

    for (const value of privateValues) {
        if (typeof value === 'string' && value) {
            assert.equal(
                serialized.includes(value),
                false,
                `Assessment output leaked synthetic private metadata value "${value}".`
            );
        }
    }
}
