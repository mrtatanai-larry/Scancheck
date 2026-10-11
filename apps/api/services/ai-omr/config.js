function booleanFromEnv(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function numberFromEnv(value, fallback, min = 0) {
    const parsed = Number.parseInt(String(value || ''), 10);
    if (!Number.isFinite(parsed) || parsed < min) return fallback;
    return parsed;
}

const GEMINI_OMR_MODELS = [
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-flash-latest',
    'gemini-flash-lite-latest'
];

// Wire values are uppercase per the generateContent ThinkingLevel enum.
const THINKING_LEVELS = ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'];

// Output-token headroom reserved for thinking tokens. maxOutputTokens is a hard
// cutoff on thinking + output combined, so a budget sized only for the JSON body
// can truncate mid-response (finishReason MAX_TOKENS) and waste the call.
const THINKING_HEADROOM_TOKENS = 2048;

function supportsThinkingLevel(model) {
    // thinkingLevel is rejected outright by pre-Gemini-3 models. The -latest
    // aliases always track a current release, so they are treated as supported.
    return String(model || '').startsWith('gemini-3')
        || String(model || '').includes('gemini-flash-latest');
}

const DEFAULT_PROMPT_VERSION = 'omr-prompt-v1';

function normalizeStrategyName(value) {
    const strategy = String(value || '').trim().toLowerCase();
    if (['fast', 'high_accuracy', 'custom'].includes(strategy)) return strategy;
    return 'auto';
}

function normalizeImageDetail(value) {
    const detail = String(value || '').trim().toLowerCase();
    if (['low', 'high'].includes(detail)) return detail;
    return 'medium';
}

function normalizeVerificationMode(value) {
    const mode = String(value || '').trim().toLowerCase();
    if (['always', 'disabled'].includes(mode)) return mode;
    return 'uncertain';
}

function normalizeThinkingLevel(value) {
    const level = String(value || '').trim().toUpperCase();
    return THINKING_LEVELS.includes(level) ? level : 'MEDIUM';
}

// A section where most questions read "blank" is the signature of a misaligned
// or truncated crop, not of a student who skipped the page. Those blanks get
// flagged for review instead of being reported as a clean scan.
function normalizeBlankReviewRate(value) {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) return 0.5;
    return Math.max(0, Math.min(1, parsed));
}

// Contiguous blanks anchored to a section edge mean the crop cut off rows.
function normalizeBlankRunThreshold(value) {
    const parsed = Number.parseInt(String(value || ''), 10);
    if (!Number.isFinite(parsed) || parsed < 2) return 5;
    return parsed;
}

function normalizeGeminiModel(value) {
    const model = String(value || '').trim();
    return GEMINI_OMR_MODELS.includes(model) ? model : 'gemini-3.6-flash';
}

function getAiOmrConfig(env = process.env) {
    return {
        enabled: booleanFromEnv(env.AI_OMR_ENABLED, true),
        provider: 'gemini',
        model: normalizeGeminiModel(env.AI_OMR_MODEL || 'gemini-3.6-flash'),
        apiKey: String(env.GEMINI_API_KEY || '').trim(),
        timeoutMs: numberFromEnv(env.AI_OMR_TIMEOUT_MS, 30000, 1000),
        maxRetries: numberFromEnv(env.AI_OMR_MAX_RETRIES, 2, 0),
        sectionSize: numberFromEnv(env.AI_OMR_SECTION_SIZE, 20, 1),
        confidenceThreshold: Number.parseFloat(env.AI_OMR_CONFIDENCE_THRESHOLD || '0.75'),
        strategy: normalizeStrategyName(env.AI_OMR_STRATEGY || 'auto'),
        imageDetail: normalizeImageDetail(env.AI_OMR_IMAGE_DETAIL || 'medium'),
        verificationMode: normalizeVerificationMode(env.AI_OMR_VERIFICATION_MODE || 'uncertain'),
        thinkingLevel: normalizeThinkingLevel(env.AI_OMR_THINKING_LEVEL || 'MEDIUM'),
        blankReviewRate: normalizeBlankReviewRate(env.AI_OMR_BLANK_REVIEW_RATE),
        blankRunThreshold: normalizeBlankRunThreshold(env.AI_OMR_BLANK_RUN_THRESHOLD),
        promptVersion: String(env.AI_OMR_PROMPT_VERSION || DEFAULT_PROMPT_VERSION).trim() || DEFAULT_PROMPT_VERSION
    };
}

function validateAiOmrConfig(config) {
    if (config.provider !== 'gemini') {
        return { valid: false, code: 'AI_OMR_PROVIDER_UNSUPPORTED', message: 'Unsupported AI OMR provider.' };
    }
    if (!config.apiKey) {
        return { valid: false, code: 'AI_OMR_MISSING_API_KEY', message: 'AI scanner unavailable: missing Gemini API key.' };
    }
    if (!config.model) {
        return { valid: false, code: 'AI_OMR_MISSING_MODEL', message: 'AI scanner unavailable: missing model.' };
    }
    return { valid: true };
}

module.exports = {
    getAiOmrConfig,
    validateAiOmrConfig,
    normalizeGeminiModel,
    normalizeStrategyName,
    normalizeImageDetail,
    normalizeVerificationMode,
    normalizeThinkingLevel,
    normalizeBlankReviewRate,
    normalizeBlankRunThreshold,
    supportsThinkingLevel,
    THINKING_HEADROOM_TOKENS,
    THINKING_LEVELS,
    DEFAULT_PROMPT_VERSION,
    GEMINI_OMR_MODELS
};
