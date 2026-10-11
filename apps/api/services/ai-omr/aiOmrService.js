const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Jimp = require('jimp');
const { getAiOmrConfig, validateAiOmrConfig } = require('./config');
const { parseImageInput, loadImage, hashImage, preparePageImage } = require('./imagePreparation');
const { buildCropsForStrategy, activeQuestionNumbers, cropQuestionRange, buildTopFieldCrop } = require('./sectionCropper');
const { decodeQrFromImage, layoutIdFromQrData } = require('./qrDecode');
const { GeminiProvider, AiOmrProviderError } = require('./providers/geminiProvider');
const { OllamaProvider } = require('./providers/ollamaProvider');
const { verifyQuestionRecords } = require('./verification');
const {
    validateOmrResult,
    validateTopFieldsResult,
    answerVectorFromRecords,
    summarizeQuestionStates,
    benchmarkAgainstGroundTruth
} = require('./resultValidator');

const inFlightScans = new Map();

function safeId(value) {
    return String(value || '')
        .trim()
        .replace(/[^a-z0-9_-]+/gi, '_')
        .slice(0, 80);
}

function idempotencyKey({ requestId, imageHash, layoutId, strategy, verify }) {
    if (requestId) return safeId(requestId);
    return crypto
        .createHash('sha256')
        .update([imageHash, layoutId || '', strategy || '', verify ? 'verify' : 'noverify'].join('|'))
        .digest('hex');
}

async function oncePerScan(key, work) {
    if (inFlightScans.has(key)) {
        return inFlightScans.get(key);
    }
    const promise = Promise.resolve().then(work).finally(() => {
        inFlightScans.delete(key);
    });
    inFlightScans.set(key, promise);
    return promise;
}

function createProvider(config) {
    if (config.provider === 'gemini') {
        return new GeminiProvider(config);
    }
    if (config.provider === 'ollama') {
        return new OllamaProvider(config);
    }
    throw new AiOmrProviderError('AI_OMR_PROVIDER_UNSUPPORTED', 'Unsupported AI OMR provider.');
}

function normalizeStrategy(value, config) {
    const raw = String(value || '').trim().toLowerCase();
    if (['whole', 'whole_sheet', 'sheet'].includes(raw)) return 'whole_sheet';
    if (['10', 'section_10', 'ten'].includes(raw)) return 'section_10';
    if (['20', 'section_20', 'twenty', 'sections'].includes(raw)) return 'section_20';
    const configured = Number(config.sectionSize) === 10 ? 'section_10' : 'section_20';
    return configured;
}

function effectiveStrategy(config = {}, requestedStrategy = null) {
    const profile = String(config.strategy || 'auto').trim().toLowerCase();
    if (profile === 'fast') return 'section_20';
    if (profile === 'high_accuracy') return 'section_10';
    if (profile === 'custom') return normalizeStrategy(requestedStrategy, config);
    return normalizeStrategy(requestedStrategy || 'section_20', { ...config, sectionSize: 20 });
}

function shouldVerify(config = {}, explicitVerify = null) {
    const mode = String(config.verificationMode || 'uncertain').trim().toLowerCase();
    if (mode === 'disabled') return false;
    if (mode === 'always') return true;
    if (typeof explicitVerify === 'boolean') return explicitVerify;
    return true;
}

function imageOptionsForDetail(detail, strategy) {
    const normalized = String(detail || 'medium').trim().toLowerCase();
    if (normalized === 'low') {
        return { maxWidth: strategy === 'whole_sheet' ? 1800 : 1400, quality: 82 };
    }
    if (normalized === 'high') {
        return { maxWidth: strategy === 'whole_sheet' ? 2600 : 2200, quality: 92 };
    }
    return { maxWidth: strategy === 'whole_sheet' ? 2200 : 1800, quality: 88 };
}

function emptyTokenUsage() {
    return { inputTokens: null, outputTokens: null, totalTokens: null, thoughtsTokens: null };
}

function addUsageTotals(total, usage = {}) {
    for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'thoughtsTokens']) {
        const value = Number(usage[key]);
        if (!Number.isFinite(value)) continue;
        total[key] = Number(total[key] || 0) + value;
    }
    return total;
}

async function buildAiInputPreview(crops = []) {
    const previewCrops = crops.slice(0, 12);
    if (previewCrops.length === 0) return null;
    try {
        const images = [];
        for (const crop of previewCrops) {
            const image = await Jimp.read(crop.buffer);
            image.resize(360, Jimp.AUTO);
            images.push({ image, crop });
        }
        const gap = 16;
        const labelHeight = 28;
        const cols = Math.min(2, images.length);
        const rows = Math.ceil(images.length / cols);
        const cellWidth = Math.max(...images.map((item) => item.image.bitmap.width)) + gap;
        const cellHeight = Math.max(...images.map((item) => item.image.bitmap.height)) + labelHeight + gap;
        const sheet = new Jimp(cols * cellWidth + gap, rows * cellHeight + gap, 0xffffffff);
        const font = await Jimp.loadFont(Jimp.FONT_SANS_16_BLACK);
        images.forEach((item, index) => {
            const col = index % cols;
            const row = Math.floor(index / cols);
            const x = gap + col * cellWidth;
            const y = gap + row * cellHeight;
            const label = item.crop.label
                || (item.crop.questions?.length
                    ? `Q${item.crop.questions[0]}-${item.crop.questions[item.crop.questions.length - 1]}`
                    : 'AI Input');
            sheet.print(font, x, y, label);
            sheet.blit(item.image, x, y + labelHeight);
        });
        const buffer = await sheet.quality(85).getBufferAsync(Jimp.MIME_JPEG);
        return `data:${Jimp.MIME_JPEG};base64,${buffer.toString('base64')}`;
    } catch (_error) {
        return null;
    }
}

function normalizeGroundTruth(input) {
    if (!input) return null;
    if (Array.isArray(input)) return input;
    if (typeof input === 'object') {
        const max = Math.max(...Object.keys(input).map((key) => Number.parseInt(key, 10)).filter(Number.isFinite), 0);
        return Array.from({ length: max }, (_unused, index) => input[index + 1] || '');
    }
    return null;
}

async function runSectionWithValidation(provider, crop, requestedQuestions, retries = 1) {
    let lastValidation = null;
    let lastResponse = null;
    let apiCalls = 0;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        const response = await provider.generateOmrResult({
            imageBuffer: crop.buffer,
            mimeType: crop.mimeType,
            questions: requestedQuestions,
            subjects: crop.subjects,
            questionMappings: crop.questionMappings
        });
        apiCalls += Number(response.attempts) || 1;
        const validation = validateOmrResult(response.payload, requestedQuestions);
        lastResponse = response;
        lastValidation = validation;
        if (validation.valid) {
            return { validation, response, attempts: attempt + 1, apiCalls };
        }
    }

    const errors = lastValidation?.errors || ['invalid AI response'];
    const error = new AiOmrProviderError('AI_OMR_INVALID_RESPONSE', 'AI scanner returned an invalid structured response.', errors);
    error.response = lastResponse;
    throw error;
}

function markSource(records, source) {
    return records.map((record) => ({
        ...record,
        source
    }));
}

function isRecoverableAiResponseError(error) {
    const code = String(error?.code || '');
    return [
        'AI_OMR_EMPTY_RESPONSE',
        'AI_OMR_MALFORMED_RESPONSE',
        'AI_OMR_INVALID_RESPONSE'
    ].includes(code);
}

function uncertainRecordsForQuestions(questions = [], source, reviewStatus = 'ai_section_invalid_response') {
    return questions.map((question) => ({
        question: Number(question),
        state: 'uncertain',
        answer: null,
        markedOptions: [],
        confidence: 0,
        source,
        needsReview: true,
        reviewStatus
    }));
}

function isAuthenticationOrAvailabilityError(error) {
    const code = String(error?.code || '');
    return [
        'AI_OMR_AUTH_FAILED',
        'AI_OMR_RATE_LIMITED',
        'AI_OMR_TIMEOUT',
        'AI_OMR_PROVIDER_UNAVAILABLE',
        'AI_OMR_PROVIDER_ERROR'
    ].includes(code);
}

async function runTopFieldsRead(provider, crop) {
    if (!crop || typeof provider.generateTopFieldsResult !== 'function') {
        return {
            fields: {},
            metrics: {
                status: 'not_available',
                apiCalls: 0,
                providerLatencyMs: 0,
                tokenUsage: emptyTokenUsage()
            }
        };
    }
    const response = await provider.generateTopFieldsResult({
        imageBuffer: crop.buffer,
        mimeType: crop.mimeType,
        fields: crop.fields
    });
    const validation = validateTopFieldsResult(response.payload, crop.fields);
    if (!validation.valid) {
        const error = new AiOmrProviderError('AI_OMR_TOP_FIELDS_INVALID_RESPONSE', 'AI scanner returned invalid top-field data.', validation.errors);
        error.response = response;
        throw error;
    }
    return {
        fields: validation.byField,
        metrics: {
            status: 'ok',
            fields: validation.fields,
            crop: crop.crop,
            apiCalls: Number(response.attempts) || 1,
            providerLatencyMs: Number(response.latencyMs) || 0,
            tokenUsage: response.usage || emptyTokenUsage()
        }
    };
}

function unreadableRecordCount(records = [], confidenceThreshold = 0.75) {
    return records.filter((record) => {
        const state = String(record?.state || '').toLowerCase();
        const confidence = Number(record?.confidence);
        return state === 'uncertain'
            || (state === 'blank' && (!Number.isFinite(confidence) || confidence < confidenceThreshold));
    }).length;
}

function blankRecordCount(records = []) {
    return records.filter((record) => String(record?.state || '').toLowerCase() === 'blank').length;
}

// A crop that is clipped or misaligned reports "blank" for the rows it never
// contained, and those blanks arrive as a CONTIGUOUS block anchored at one end
// of the section. A student who skips questions produces scattered blanks, so
// an edge-anchored run is a far stronger misalignment signal than raw density.
function boundaryBlankRun(records = []) {
    const isBlank = (record) => String(record?.state || '').toLowerCase() === 'blank';
    let leading = 0;
    for (const record of records) {
        if (!isBlank(record)) break;
        leading += 1;
    }
    let trailing = 0;
    for (let index = records.length - 1; index >= 0; index -= 1) {
        if (!isBlank(records[index])) break;
        trailing += 1;
    }
    return Math.max(leading, trailing);
}

// A crop that is misaligned or clipped reports "blank" for the rows it never
// contained, often with high confidence. That is indistinguishable from a
// genuine blank page by confidence alone, so detect it structurally instead.
function blankRateExceeds(records = [], blankReviewRate = 0.5, blankRunThreshold = 5) {
    const runThreshold = Number(blankRunThreshold);
    if (Number.isFinite(runThreshold) && runThreshold > 0
        && boundaryBlankRun(records) >= runThreshold) {
        return true;
    }
    const threshold = Number(blankReviewRate);
    if (!records.length || !Number.isFinite(threshold) || threshold <= 0) return false;
    return blankRecordCount(records) / records.length >= threshold;
}

function markBlankAnomaly(records = [], blankReviewRate = 0.5, blankRunThreshold = 5, reviewStatus = 'blank_density_anomaly') {
    if (!blankRateExceeds(records, blankReviewRate, blankRunThreshold)) return records;
    return records.map((record) => {
        if (String(record?.state || '').toLowerCase() !== 'blank') return record;
        return {
            ...record,
            needsReview: true,
            reviewStatus
        };
    });
}

function shouldRetrySectionRead(records = [], requestedQuestions = [], confidenceThreshold = 0.75, blankReviewRate = 0.5, blankRunThreshold = 5) {
    const expected = Math.max(1, requestedQuestions.length || records.length || 1);
    if (blankRateExceeds(records, blankReviewRate, blankRunThreshold)) return true;
    const unreadable = unreadableRecordCount(records, confidenceThreshold);
    return expected >= 10 && unreadable >= Math.max(5, Math.ceil(expected * 0.30));
}

function preferSectionRecords(candidateRecords, currentRecords, confidenceThreshold = 0.75, blankReviewRate = 0.5) {
    const candidateUnreadable = unreadableRecordCount(candidateRecords, confidenceThreshold);
    const currentUnreadable = unreadableRecordCount(currentRecords, confidenceThreshold);
    if (candidateUnreadable < currentUnreadable) return true;
    if (candidateUnreadable > currentUnreadable) return false;

    // A retry that recovers actual marks is better even when both passes look
    // equally "readable", which is the common outcome of a re-cropped section.
    const candidateBlanks = blankRecordCount(candidateRecords);
    const currentBlanks = blankRecordCount(currentRecords);
    if (candidateBlanks < currentBlanks) return true;
    if (candidateBlanks > currentBlanks) return false;

    const candidateSelected = candidateRecords.filter((record) => record.state === 'selected').length;
    const currentSelected = currentRecords.filter((record) => record.state === 'selected').length;
    return candidateSelected > currentSelected;
}

function scanStatusFromRecords(records, expectedCount) {
    const needsReview = records.filter((record) => record.needsReview || record.state === 'uncertain');
    if (records.length !== expectedCount) return 'REVIEW';
    if (needsReview.length > 0) return 'REVIEW';
    return 'NORMAL';
}

function sanitizedPersistencePayload(result) {
    return {
        requestId: result.requestId,
        createdAt: result.createdAt,
        scanMode: result.scanMode,
        provider: result.provider,
        model: result.model,
        layoutId: result.layoutId,
        strategy: result.strategy,
        success: result.success,
        status: result.status,
        answers: result.answers,
        questions: result.questions,
        needsReview: result.needsReview,
        topFields: result.topFields || {},
        metrics: result.metrics,
        benchmark: result.benchmark || null,
        barcodeStatus: result.barcodeStatus || null,
        barcodeData: result.barcodeData || null
    };
}

function persistRun(result, runtimePaths) {
    if (!runtimePaths?.dataDir) return null;
    const outputDir = path.join(runtimePaths.dataDir, 'ai-omr', 'results');
    fs.mkdirSync(outputDir, { recursive: true });
    const fileName = `${safeId(result.requestId || Date.now())}.json`;
    const outputPath = path.join(outputDir, fileName);
    fs.writeFileSync(outputPath, JSON.stringify(sanitizedPersistencePayload(result), null, 2), 'utf8');
    return outputPath;
}

async function identifyLayout({ imageBuffer, suppliedLayoutId }) {
    const qr = await decodeQrFromImage(imageBuffer);
    if (suppliedLayoutId) {
        return {
            layoutId: suppliedLayoutId,
            qr: qr.success
                ? qr
                : { ...(qr || {}), success: false, status: 'layout_supplied_qr_not_found', barcodeData: null }
        };
    }
    const layoutId = qr.success ? layoutIdFromQrData(qr.barcodeData || {}) : null;
    return { layoutId, qr };
}

async function runAiOmrScan(options = {}) {
    const config = { ...getAiOmrConfig(), ...(options.config || {}) };
    const configValidation = validateAiOmrConfig(config);
    if (!configValidation.valid) {
        throw new AiOmrProviderError(configValidation.code, configValidation.message);
    }

    const imagePayload = Buffer.isBuffer(options.imageBuffer)
        ? { buffer: options.imageBuffer, mimeType: options.mimeType || 'image/jpeg' }
        : parseImageInput(options.image);
    const imageHash = hashImage(imagePayload.buffer);
    const strategy = effectiveStrategy(config, options.strategy);
    const suppliedLayoutId = options.layoutId || options.examId || options.exam_id || null;
    const layoutIdentity = await identifyLayout({
        imageBuffer: imagePayload.buffer,
        suppliedLayoutId
    });

    if (!layoutIdentity.layoutId) {
        throw new AiOmrProviderError('AI_OMR_LAYOUT_IDENTIFICATION_FAILED', 'Layout identification failed. QR could not be decoded and no layoutId was supplied.');
    }
    if (!options.layout || typeof options.layout !== 'object') {
        throw new AiOmrProviderError('AI_OMR_LAYOUT_NOT_FOUND', 'Generated layout was not found.');
    }

    const verifyLowConfidence = shouldVerify(config, typeof options.verifyLowConfidence === 'boolean' ? options.verifyLowConfidence : null);
    const requestId = idempotencyKey({
        requestId: options.requestId,
        imageHash,
        layoutId: layoutIdentity.layoutId,
        strategy,
        verify: verifyLowConfidence
    });

    return oncePerScan(requestId, async () => {
        const startedAt = Date.now();
        const preparedImage = options.preparePage === false
            ? { buffer: imagePayload.buffer, mimeType: imagePayload.mimeType, mode: 'original_disabled', usedWorker: false }
            : await preparePageImage(imagePayload.buffer, options.layout, options.runtimePaths);
        const image = await loadImage(preparedImage.buffer);
        const provider = createProvider(config);
        const expectedQuestions = activeQuestionNumbers(options.layout);
        const imageDetailOptions = imageOptionsForDetail(config.imageDetail, strategy);
        const topFieldCrop = await buildTopFieldCrop(image, options.layout, {
            maxWidth: Math.max(Number(imageDetailOptions.maxWidth || 1800), 1800),
            quality: Math.max(Number(imageDetailOptions.quality || 88), 90)
        });
        const crops = await buildCropsForStrategy(image, options.layout, strategy, {
            sectionSize: config.sectionSize,
            ...imageDetailOptions
        });
        const aiInputPreview = await buildAiInputPreview(topFieldCrop ? [topFieldCrop, ...crops] : crops);

        const records = [];
        const sections = [];
        let apiCallCount = 0;
        let providerLatencyMs = 0;
        const tokenUsage = emptyTokenUsage();
        let topFields = {};
        let topFieldMetrics = topFieldCrop
            ? { status: 'not_run', apiCalls: 0, providerLatencyMs: 0, tokenUsage: emptyTokenUsage() }
            : { status: 'not_available', apiCalls: 0, providerLatencyMs: 0, tokenUsage: emptyTokenUsage() };

        if (topFieldCrop) {
            try {
                const topRead = await runTopFieldsRead(provider, topFieldCrop);
                topFields = topRead.fields;
                topFieldMetrics = topRead.metrics;
                apiCallCount += topFieldMetrics.apiCalls || 0;
                providerLatencyMs += topFieldMetrics.providerLatencyMs || 0;
                addUsageTotals(tokenUsage, topFieldMetrics.tokenUsage);
            } catch (error) {
                if (isAuthenticationOrAvailabilityError(error)) {
                    throw error;
                }
                topFieldMetrics = {
                    status: 'unreadable',
                    errorCode: error?.code || 'AI_OMR_TOP_FIELDS_UNREADABLE',
                    apiCalls: Number(error?.response?.attempts) || 1,
                    providerLatencyMs: Number(error?.response?.latencyMs) || 0,
                    tokenUsage: error?.response?.usage || emptyTokenUsage()
                };
                apiCallCount += topFieldMetrics.apiCalls || 0;
                providerLatencyMs += topFieldMetrics.providerLatencyMs || 0;
                addUsageTotals(tokenUsage, topFieldMetrics.tokenUsage);
            }
        }

        for (let index = 0; index < crops.length; index += 1) {
            const crop = crops[index];
            const sectionId = `${strategy}_${index + 1}`;
            const sectionStarted = Date.now();
            if (crop.unresolved) {
                // No layout geometry for these questions, so no crop could be
                // built. Never report them as blank; they were never examined.
                records.push(...uncertainRecordsForQuestions(crop.questions, sectionId, 'crop_bounds_unresolved'));
                sections.push({
                    sectionId,
                    cropKind: crop.cropKind,
                    questions: crop.questions,
                    subjects: [],
                    crop: null,
                    latencyMs: Date.now() - sectionStarted,
                    providerLatencyMs: 0,
                    attempts: 0,
                    status: 'review',
                    errorCode: 'AI_OMR_CROP_BOUNDS_UNRESOLVED'
                });
                continue;
            }
            try {
                let section = await runSectionWithValidation(provider, crop, crop.questions, 1);
                let sectionApiCalls = section.apiCalls || 1;
                let sectionProviderLatencyMs = section.response.latencyMs || 0;
                const sectionTokenUsage = emptyTokenUsage();
                addUsageTotals(sectionTokenUsage, section.response.usage);
                let chosenCrop = crop;
                let chosenRecords = section.validation.questions;
                let retryInfo = null;
                if (shouldRetrySectionRead(chosenRecords, crop.questions, config.confidenceThreshold, config.blankReviewRate, config.blankRunThreshold)) {
                    try {
                        const widerCrop = await cropQuestionRange(image, options.layout, crop.questions, {
                            ...imageDetailOptions,
                            sectionSize: config.sectionSize,
                            quality: Math.max(Number(imageDetailOptions.quality || 88), 92),
                            maxWidth: Math.max(Number(imageDetailOptions.maxWidth || 1800), 2200),
                            margin: { x: 76, y: 52 }
                        });
                        const retrySection = await runSectionWithValidation(provider, widerCrop, crop.questions, 1);
                        retryInfo = {
                            reason: blankRateExceeds(chosenRecords, config.blankReviewRate, config.blankRunThreshold)
                                ? 'blank_density_anomaly'
                                : 'many_unreadable_records',
                            status: preferSectionRecords(retrySection.validation.questions, chosenRecords, config.confidenceThreshold, config.blankReviewRate) ? 'used' : 'kept_initial',
                            initialUnreadable: unreadableRecordCount(chosenRecords, config.confidenceThreshold),
                            retryUnreadable: unreadableRecordCount(retrySection.validation.questions, config.confidenceThreshold),
                            initialBlanks: blankRecordCount(chosenRecords),
                            retryBlanks: blankRecordCount(retrySection.validation.questions)
                        };
                        sectionApiCalls += retrySection.apiCalls || 1;
                        sectionProviderLatencyMs += retrySection.response.latencyMs || 0;
                        addUsageTotals(sectionTokenUsage, retrySection.response.usage);
                        if (retryInfo.status === 'used') {
                            section = retrySection;
                            chosenCrop = widerCrop;
                            chosenRecords = retrySection.validation.questions;
                        }
                    } catch (retryError) {
                        retryInfo = {
                            reason: 'many_unreadable_records',
                            status: 'failed',
                            errorCode: retryError?.code || 'AI_OMR_RETRY_FAILED'
                        };
                    }
                }
                apiCallCount += sectionApiCalls;
                providerLatencyMs += sectionProviderLatencyMs;
                addUsageTotals(tokenUsage, sectionTokenUsage);
                const finalRecords = markBlankAnomaly(chosenRecords, config.blankReviewRate, config.blankRunThreshold);
                const sectionHasBlankAnomaly = finalRecords.some((record) => record.reviewStatus === 'blank_density_anomaly');
                records.push(...markSource(finalRecords, sectionId));
                sections.push({
                    sectionId,
                    cropKind: chosenCrop.cropKind,
                    questions: crop.questions,
                    subjects: chosenCrop.subjects || [],
                    crop: chosenCrop.crop,
                    latencyMs: Date.now() - sectionStarted,
                    providerLatencyMs: sectionProviderLatencyMs,
                    attempts: section.attempts,
                    status: sectionHasBlankAnomaly ? 'review' : 'ok',
                    blanks: blankRecordCount(finalRecords),
                    blankRate: finalRecords.length ? blankRecordCount(finalRecords) / finalRecords.length : 0,
                    retry: retryInfo
                });
            } catch (error) {
                if (!isRecoverableAiResponseError(error)) {
                    throw error;
                }
                records.push(...uncertainRecordsForQuestions(crop.questions, sectionId, String(error.code || 'AI_OMR_INVALID_RESPONSE').toLowerCase()));
                sections.push({
                    sectionId,
                    cropKind: crop.cropKind,
                    questions: crop.questions,
                    subjects: crop.subjects || [],
                    crop: crop.crop,
                    latencyMs: Date.now() - sectionStarted,
                    providerLatencyMs: 0,
                    attempts: Math.max(1, Number(config.maxRetries || 0) + 1),
                    status: 'review',
                    errorCode: error.code || 'AI_OMR_INVALID_RESPONSE'
                });
            }
        }

        let finalRecords = records.sort((a, b) => a.question - b.question);
        const registrationTrusted = preparedImage.registrationTrusted === true;
        const registrationReason = preparedImage.registrationFailureReason || 'unverified';
        if (!registrationTrusted) {
            // The sheet was warped without verified alignment, so crop rects may
            // be offset. Never report a clean scan in that case.
            finalRecords = finalRecords.map((record) => ({
                ...record,
                needsReview: true,
                reviewStatus: record.reviewStatus || `registration_untrusted:${registrationReason}`
            }));
        }
        let verificationMetrics = null;
        if (verifyLowConfidence) {
            const verification = await verifyQuestionRecords({
                provider,
                image,
                layout: options.layout,
                records: finalRecords,
                confidenceThreshold: config.confidenceThreshold,
                cropOptions: { quality: 90 }
            });
            finalRecords = verification.records.sort((a, b) => a.question - b.question);
            verificationMetrics = verification.metrics;
            apiCallCount += verification.metrics.apiCalls;
            providerLatencyMs += verification.metrics.latencyMs;
            addUsageTotals(tokenUsage, verification.metrics.tokenUsage);
        } else {
            finalRecords = finalRecords.map((record) => ({
                ...record,
                needsReview: record.state === 'uncertain' || record.needsReview === true
            }));
        }

        const answers = answerVectorFromRecords(finalRecords, Math.max(...expectedQuestions));
        const stateCounts = summarizeQuestionStates(finalRecords);
        const missing = expectedQuestions.filter((question) => !finalRecords.some((record) => record.question === question));
        const needsReview = finalRecords
            .filter((record) => record.needsReview || record.state === 'uncertain')
            .map((record) => record.question);
        const benchmark = benchmarkAgainstGroundTruth(finalRecords, normalizeGroundTruth(options.groundTruthAnswers) || []);

        const result = {
            success: true,
            createdAt: new Date().toISOString(),
            requestId,
            scanMode: 'ai_vision',
            provider: config.provider,
            model: config.model,
            layoutId: layoutIdentity.layoutId,
            barcodeStatus: layoutIdentity.qr?.status || null,
            barcodeData: layoutIdentity.qr?.barcodeData || null,
            strategy,
            imageDetail: config.imageDetail || 'medium',
            verificationMode: config.verificationMode || 'uncertain',
            thinkingLevel: config.thinkingLevel || 'LOW',
            promptVersion: config.promptVersion || 'omr-prompt-v1',
            status: scanStatusFromRecords(finalRecords, expectedQuestions.length),
            answers,
            questions: finalRecords,
            needsReview,
            topFields,
            metrics: {
                totalQuestions: expectedQuestions.length,
                returnedQuestions: finalRecords.length,
                missingQuestions: missing,
                stateCounts,
                cropCount: crops.length + (topFieldCrop ? 1 : 0),
                apiCallCount,
                latencyMs: Date.now() - startedAt,
                providerLatencyMs,
                tokenUsage,
                imageHash,
                pagePreparation: {
                    mode: preparedImage.mode,
                    usedWorker: preparedImage.usedWorker,
                    registrationTrusted: preparedImage.registrationTrusted === true,
                    registrationFailureReason: preparedImage.registrationFailureReason || null,
                    quad: preparedImage.quad || null,
                    anchorRefinement: preparedImage.anchorRefinement || null,
                    sourceAnchorAlignment: preparedImage.sourceAnchorAlignment || null,
                    width: preparedImage.width || image.bitmap.width,
                    height: preparedImage.height || image.bitmap.height
                },
                imageWidth: image.bitmap.width,
                imageHeight: image.bitmap.height,
                sections,
                topFields: topFieldMetrics,
                verification: verificationMetrics,
                aiInputPreview
            },
            benchmark: benchmark.totalQuestions > 0 ? benchmark : null
        };

        result.persistencePath = persistRun(result, options.runtimePaths);
        return result;
    });
}

async function runAiOmrBenchmark(options = {}) {
    const strategies = options.strategies || ['whole_sheet', 'section_20', 'section_10', 'section_20_verify'];
    const runs = [];
    for (const strategyName of strategies) {
        const verifyLowConfidence = strategyName.endsWith('_verify');
        const strategy = verifyLowConfidence ? strategyName.replace('_verify', '') : strategyName;
        for (let run = 1; run <= (Number(options.repeat) || 1); run += 1) {
            runs.push(await runAiOmrScan({
                ...options,
                strategy,
                verifyLowConfidence,
                requestId: options.requestId ? `${options.requestId}_${strategyName}_${run}` : undefined
            }));
        }
    }
    return { runs };
}

module.exports = {
    runAiOmrScan,
    runAiOmrBenchmark,
    identifyLayout
};
