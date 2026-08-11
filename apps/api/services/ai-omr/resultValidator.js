const {
    ALLOWED_OPTIONS,
    ALLOWED_STATES,
    TOP_FIELD_NAMES,
    TOP_FIELD_OPTIONS
} = require('./schemas/omrResultSchema');

function uniqueOptions(values) {
    const seen = new Set();
    const output = [];
    for (const value of Array.isArray(values) ? values : []) {
        const option = String(value || '').trim().toUpperCase();
        if (ALLOWED_OPTIONS.includes(option) && !seen.has(option)) {
            seen.add(option);
            output.push(option);
        }
    }
    return output;
}

function uniqueTopOptions(values) {
    const seen = new Set();
    const output = [];
    for (const value of Array.isArray(values) ? values : []) {
        const option = String(value || '').trim();
        if (TOP_FIELD_OPTIONS.includes(option) && !seen.has(option)) {
            seen.add(option);
            output.push(option);
        }
    }
    return output;
}

function normalizeQuestionRecord(record) {
    const question = Number.parseInt(String(record?.question ?? ''), 10);
    const state = String(record?.state || '').trim().toLowerCase();
    const answerRaw = record?.answer === null || record?.answer === undefined
        ? null
        : String(record.answer).trim().toUpperCase();
    const answer = answerRaw === '' ? null : answerRaw;
    const confidence = Number(record?.confidence);
    return {
        question,
        state,
        answer,
        markedOptions: uniqueOptions(record?.markedOptions),
        confidence
    };
}

function validateQuestionConsistency(record) {
    const errors = [];
    if (!Number.isInteger(record.question) || record.question <= 0) {
        errors.push('question must be a positive integer');
    }
    if (!ALLOWED_STATES.includes(record.state)) {
        errors.push(`state must be one of ${ALLOWED_STATES.join(', ')}`);
    }
    if (record.answer !== null && !ALLOWED_OPTIONS.includes(record.answer)) {
        errors.push('answer must be A, B, C, D, or null');
    }
    if (!Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1) {
        errors.push('confidence must be between 0 and 1');
    }

    if (record.state === 'selected') {
        if (record.markedOptions.length !== 1) {
            errors.push('selected requires exactly one marked option');
        }
        if (!record.answer || record.answer !== record.markedOptions[0]) {
            errors.push('selected answer must match the single marked option');
        }
    } else if (record.state === 'blank') {
        if (record.answer !== null) errors.push('blank answer must be null');
        if (record.markedOptions.length !== 0) errors.push('blank must not contain marked options');
    } else if (record.state === 'multiple') {
        if (record.answer !== null) errors.push('multiple answer must be null');
        if (record.markedOptions.length < 2) errors.push('multiple requires at least two marked options');
    } else if (record.state === 'uncertain') {
        if (record.answer !== null) errors.push('uncertain answer must be null');
    }

    return errors;
}

function validateOmrResult(payload, requestedQuestions) {
    const expected = new Set((requestedQuestions || []).map((q) => Number(q)));
    const errors = [];
    if (!payload || !Array.isArray(payload.questions)) {
        return { valid: false, questions: [], errors: ['response must contain a questions array'] };
    }

    const byQuestion = new Map();
    for (const raw of payload.questions) {
        const record = normalizeQuestionRecord(raw);
        const recordErrors = validateQuestionConsistency(record);
        if (!expected.has(record.question)) {
            recordErrors.push('unexpected question number');
        }
        if (byQuestion.has(record.question)) {
            recordErrors.push('duplicate question number');
        }
        if (recordErrors.length > 0) {
            errors.push(`Q${Number.isInteger(record.question) ? record.question : '?'}: ${recordErrors.join('; ')}`);
            continue;
        }
        byQuestion.set(record.question, record);
    }

    for (const question of expected) {
        if (!byQuestion.has(question)) {
            errors.push(`Q${question}: missing question result`);
        }
    }

    return {
        valid: errors.length === 0,
        questions: Array.from(byQuestion.values()).sort((a, b) => a.question - b.question),
        errors
    };
}

function normalizeTopFieldRecord(record) {
    const field = String(record?.field || '').trim();
    const state = String(record?.state || '').trim().toLowerCase();
    const rawValue = record?.value === null || record?.value === undefined
        ? null
        : String(record.value).trim();
    const value = rawValue === '' ? null : rawValue;
    const confidence = Number(record?.confidence);
    return {
        field,
        state,
        value,
        markedOptions: uniqueTopOptions(record?.markedOptions),
        confidence
    };
}

function validateTopFieldConsistency(record, allowedOptions = []) {
    const errors = [];
    if (!TOP_FIELD_NAMES.includes(record.field)) {
        errors.push(`field must be one of ${TOP_FIELD_NAMES.join(', ')}`);
    }
    if (!ALLOWED_STATES.includes(record.state)) {
        errors.push(`state must be one of ${ALLOWED_STATES.join(', ')}`);
    }
    const valueOptions = record.field === 'equityGroup'
        ? [...allowedOptions, 'None']
        : allowedOptions;
    if (record.value !== null && !valueOptions.includes(record.value)) {
        errors.push('value is not allowed for this field');
    }
    for (const option of record.markedOptions) {
        if (!allowedOptions.includes(option)) {
            errors.push(`marked option ${option} is not allowed for this field`);
        }
    }
    if (!Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1) {
        errors.push('confidence must be between 0 and 1');
    }

    if (record.state === 'selected') {
        if (record.markedOptions.length !== 1) {
            errors.push('selected requires exactly one marked option');
        }
        if (!record.value || record.value !== record.markedOptions[0]) {
            errors.push('selected value must match the single marked option');
        }
    } else if (record.state === 'blank') {
        if (record.markedOptions.length !== 0) errors.push('blank must not contain marked options');
        if (record.field === 'equityGroup') {
            if (record.value !== null && record.value !== 'None') errors.push('blank equityGroup value must be None or null');
        } else if (record.value !== null) {
            errors.push('blank value must be null');
        }
    } else if (record.state === 'multiple') {
        if (record.value !== null) errors.push('multiple value must be null');
        if (record.markedOptions.length < 2) errors.push('multiple requires at least two marked options');
    } else if (record.state === 'uncertain') {
        if (record.value !== null) errors.push('uncertain value must be null');
    }

    return errors;
}

function validateTopFieldsResult(payload, expectedGroups = []) {
    const errors = [];
    const expected = new Map((expectedGroups || []).map((group) => [
        group.field,
        Array.isArray(group.options) ? group.options : []
    ]));
    if (!payload || !Array.isArray(payload.fields)) {
        return { valid: false, fields: [], byField: {}, errors: ['response must contain a fields array'] };
    }

    const byField = new Map();
    for (const raw of payload.fields) {
        const record = normalizeTopFieldRecord(raw);
        const allowedOptions = expected.get(record.field) || [];
        const recordErrors = validateTopFieldConsistency(record, allowedOptions);
        if (!expected.has(record.field)) {
            recordErrors.push('unexpected field');
        }
        if (byField.has(record.field)) {
            recordErrors.push('duplicate field');
        }
        if (recordErrors.length > 0) {
            errors.push(`${record.field || '?'}: ${recordErrors.join('; ')}`);
            continue;
        }

        const displayValue = record.state === 'multiple'
            ? 'Multiple'
            : record.state === 'uncertain'
                ? 'Uncertain'
                : record.state === 'blank' && record.field === 'equityGroup'
                    ? 'None'
                    : record.value;
        byField.set(record.field, {
            ...record,
            value: displayValue,
            rawValue: record.value,
            invalid: record.state === 'multiple' || record.state === 'uncertain',
            needsReview: false
        });
    }

    for (const field of expected.keys()) {
        if (!byField.has(field)) {
            errors.push(`${field}: missing field result`);
        }
    }

    const fields = Array.from(byField.values());
    const byFieldObject = {};
    for (const field of fields) {
        byFieldObject[field.field] = field;
    }
    return {
        valid: errors.length === 0,
        fields,
        byField: byFieldObject,
        errors
    };
}

function needsVerification(record, threshold = 0.75) {
    if (!record) return true;
    if (record.state === 'uncertain') return true;
    return Number(record.confidence) < threshold;
}

function recordsAgree(a, b) {
    if (!a || !b) return false;
    return a.state === b.state
        && a.answer === b.answer
        && JSON.stringify(a.markedOptions) === JSON.stringify(b.markedOptions);
}

function mergeVerificationResult(primary, verification) {
    if (!verification) {
        return { ...primary, needsReview: needsVerification(primary), reviewStatus: needsVerification(primary) ? 'verification_unavailable' : primary.reviewStatus };
    }
    if (recordsAgree(primary, verification)) {
        return {
            ...primary,
            confidence: Math.max(Number(primary.confidence) || 0, Number(verification.confidence) || 0),
            verification,
            needsReview: primary.state === 'uncertain'
        };
    }
    return {
        question: primary.question,
        state: 'uncertain',
        answer: null,
        markedOptions: [],
        confidence: Math.min(Number(primary.confidence) || 0, Number(verification.confidence) || 0),
        verification,
        needsReview: true,
        reviewStatus: 'ai_pass_disagreement'
    };
}

function summarizeQuestionStates(records) {
    const counts = { selected: 0, blank: 0, multiple: 0, uncertain: 0 };
    for (const record of records || []) {
        if (counts[record.state] !== undefined) counts[record.state] += 1;
    }
    return counts;
}

function answerVectorFromRecords(records, totalQuestions) {
    const answers = new Array(totalQuestions).fill('');
    for (const record of records || []) {
        if (record.state === 'selected' && record.answer) {
            answers[record.question - 1] = record.answer;
        } else if (record.state === 'multiple') {
            answers[record.question - 1] = 'MULTIPLE';
        }
    }
    return answers;
}

function benchmarkAgainstGroundTruth(records, groundTruthAnswers = []) {
    const byQuestion = new Map((records || []).map((record) => [record.question, record]));
    let correct = 0;
    let wrong = 0;
    let falseBlanks = 0;
    let falseMultiples = 0;
    let uncertain = 0;
    let missing = 0;

    groundTruthAnswers.forEach((expectedRaw, index) => {
        const question = index + 1;
        const expected = String(expectedRaw || '').trim().toUpperCase();
        if (!expected) return;
        const actual = byQuestion.get(question);
        if (!actual) {
            missing += 1;
        } else if (actual.state === 'uncertain') {
            uncertain += 1;
        } else if (actual.state === 'blank') {
            falseBlanks += 1;
        } else if (actual.state === 'multiple') {
            falseMultiples += 1;
        } else if (actual.answer === expected) {
            correct += 1;
        } else {
            wrong += 1;
        }
    });

    const total = correct + wrong + falseBlanks + falseMultiples + uncertain + missing;
    return {
        totalQuestions: total,
        correctAnswerRecognition: correct,
        wrongAnswerRecognition: wrong,
        falseBlanks,
        falseMultiples,
        uncertain,
        missing,
        exactQuestionAccuracy: total ? correct / total : null,
        perfectSheetResult: total > 0 && correct === total
    };
}

module.exports = {
    validateOmrResult,
    validateTopFieldsResult,
    needsVerification,
    mergeVerificationResult,
    answerVectorFromRecords,
    summarizeQuestionStates,
    benchmarkAgainstGroundTruth
};
