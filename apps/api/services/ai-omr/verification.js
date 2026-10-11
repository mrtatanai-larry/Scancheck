const { cropSingleQuestion } = require('./sectionCropper');
const {
    validateOmrResult,
    needsVerification,
    mergeVerificationResult
} = require('./resultValidator');

function keepPrimaryWhenVerificationUnavailable(record, confidenceThreshold, reviewStatus) {
    const review = needsVerification(record, confidenceThreshold);
    // Preserve flags raised earlier (e.g. blank_density_anomaly). A confident
    // "blank" still needs surfacing when the section looked mis-cropped.
    const alreadyFlagged = record.needsReview === true;
    return {
        ...record,
        needsReview: review || alreadyFlagged,
        reviewStatus: review ? reviewStatus : record.reviewStatus
    };
}

async function verifyQuestionRecords({
    provider,
    image,
    layout,
    records,
    confidenceThreshold,
    cropOptions
}) {
    const output = [];
    const verificationMetrics = {
        requested: 0,
        agreed: 0,
        disagreed: 0,
        unavailable: 0,
        apiCalls: 0,
        latencyMs: 0,
        tokenUsage: {
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
            thoughtsTokens: null
        }
    };

    for (const record of records) {
        if (!needsVerification(record, confidenceThreshold)) {
            output.push({ ...record, needsReview: record.needsReview === true });
            continue;
        }

        verificationMetrics.requested += 1;
        try {
            const crop = await cropSingleQuestion(image, layout, record.question, cropOptions);
            const response = await provider.generateOmrResult({
                imageBuffer: crop.buffer,
                mimeType: crop.mimeType,
                questions: [record.question],
                subjects: crop.subjects,
                questionMappings: crop.questionMappings,
                verificationQuestion: record.question
            });
            verificationMetrics.apiCalls += Number(response.attempts) || 1;
            verificationMetrics.latencyMs += response.latencyMs || 0;
            for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'thoughtsTokens']) {
                const value = Number(response.usage?.[key]);
                if (Number.isFinite(value)) {
                    verificationMetrics.tokenUsage[key] = Number(verificationMetrics.tokenUsage[key] || 0) + value;
                }
            }
            const validation = validateOmrResult(response.payload, [record.question]);
            if (!validation.valid || validation.questions.length !== 1) {
                verificationMetrics.unavailable += 1;
                output.push(keepPrimaryWhenVerificationUnavailable(record, confidenceThreshold, 'verification_invalid_response'));
                continue;
            }
            const merged = mergeVerificationResult(record, validation.questions[0]);
            if (record.needsReview === true) {
                merged.needsReview = true;
                merged.reviewStatus = record.reviewStatus || merged.reviewStatus;
            }
            if (merged.reviewStatus === 'ai_pass_disagreement') {
                verificationMetrics.disagreed += 1;
            } else {
                verificationMetrics.agreed += 1;
            }
            output.push(merged);
        } catch (_error) {
            verificationMetrics.unavailable += 1;
            output.push(keepPrimaryWhenVerificationUnavailable(record, confidenceThreshold, 'verification_failed'));
        }
    }

    return { records: output, metrics: verificationMetrics };
}

module.exports = {
    verifyQuestionRecords
};
