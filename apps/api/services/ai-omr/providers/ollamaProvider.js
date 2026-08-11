const { omrResultSchema } = require('../schemas/omrResultSchema');
const { buildSectionPrompt, buildVerificationPrompt } = require('../prompts');
const { AiOmrProviderError } = require('./geminiProvider');

function normalizeOllamaBaseUrl(value) {
    const raw = String(value || 'http://localhost:11434').trim().replace(/\/+$/, '');
    return raw.endsWith('/api') ? raw.slice(0, -4) : raw;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error) {
    const code = String(error?.code || '');
    return ['AI_OMR_RATE_LIMITED', 'AI_OMR_TIMEOUT', 'AI_OMR_PROVIDER_UNAVAILABLE'].includes(code);
}

function sanitizeOllamaError(error) {
    if (error instanceof AiOmrProviderError) return error;
    const message = String(error?.message || error || '');
    if (/timeout|deadline|aborted/i.test(message)) {
        return new AiOmrProviderError('AI_OMR_TIMEOUT', 'AI scanner timed out.');
    }
    if (/fetch failed|econnrefused|enotfound|unavailable|503/i.test(message)) {
        return new AiOmrProviderError('AI_OMR_PROVIDER_UNAVAILABLE', 'Ollama scanner provider unavailable.');
    }
    if (/unauthorized|forbidden|api key|apikey|invalid.*key|401|403/i.test(message)) {
        return new AiOmrProviderError('AI_OMR_AUTH_FAILED', 'AI scanner authentication failed.');
    }
    if (/quota|rate|429/i.test(message)) {
        return new AiOmrProviderError('AI_OMR_RATE_LIMITED', 'AI scanner quota or rate limit exceeded.');
    }
    return new AiOmrProviderError('AI_OMR_PROVIDER_ERROR', 'Ollama scanner provider request failed.');
}

function parseOllamaJson(responseJson) {
    const text = String(responseJson?.response || '').trim();
    if (!text) {
        throw new AiOmrProviderError('AI_OMR_EMPTY_RESPONSE', 'AI scanner returned an empty response.', {
            doneReason: responseJson?.done_reason || null
        });
    }
    try {
        return JSON.parse(text);
    } catch (_error) {
        throw new AiOmrProviderError('AI_OMR_MALFORMED_RESPONSE', 'AI scanner returned malformed JSON.', {
            textPreview: text.slice(0, 1000),
            textLength: text.length,
            doneReason: responseJson?.done_reason || null
        });
    }
}

async function postJsonWithTimeout(url, body, headers, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal
        });
        const text = await response.text();
        let payload = null;
        try {
            payload = text ? JSON.parse(text) : null;
        } catch (_error) {
            payload = null;
        }
        if (!response.ok) {
            throw new AiOmrProviderError(
                response.status === 404 ? 'AI_OMR_MODEL_NOT_FOUND' : 'AI_OMR_PROVIDER_ERROR',
                payload?.error || `Ollama request failed with HTTP ${response.status}.`,
                { status: response.status, bodyPreview: text.slice(0, 1000) }
            );
        }
        return payload;
    } finally {
        clearTimeout(timer);
    }
}

class OllamaProvider {
    constructor(config) {
        this.config = config;
        this.baseUrl = normalizeOllamaBaseUrl(config.baseUrl);
    }

    async generateOmrResult({ imageBuffer, questions, subjects = [], questionMappings = [], verificationQuestion = null }) {
        const prompt = verificationQuestion
            ? buildVerificationPrompt(verificationQuestion, {
                instructionPrompt: this.config.instructionPrompt,
                questionMappings
            })
            : buildSectionPrompt(questions, {
                subjects,
                questionMappings,
                instructionPrompt: this.config.instructionPrompt
            });

        const request = {
            model: this.config.model,
            prompt,
            images: [imageBuffer.toString('base64')],
            stream: false,
            format: omrResultSchema,
            options: {
                temperature: 0,
                top_p: 0.1,
                num_predict: Math.max(4096, (questions?.length || 1) * 220)
            }
        };

        const headers = { 'Content-Type': 'application/json' };
        if (this.config.apiKey) {
            headers.Authorization = `Bearer ${this.config.apiKey}`;
        }

        let lastError = null;
        const attempts = Math.max(1, Number(this.config.maxRetries || 0) + 1);
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            const startedAt = Date.now();
            try {
                const response = await postJsonWithTimeout(
                    `${this.baseUrl}/api/generate`,
                    request,
                    headers,
                    Number(this.config.timeoutMs) || 30000
                );
                return {
                    payload: parseOllamaJson(response),
                    latencyMs: Date.now() - startedAt,
                    attempts: attempt,
                    prompt
                };
            } catch (error) {
                lastError = sanitizeOllamaError(error);
                if (attempt >= attempts || !isRetryableError(lastError)) {
                    throw lastError;
                }
                await sleep(250 * attempt);
            }
        }
        throw lastError || new AiOmrProviderError('AI_OMR_PROVIDER_ERROR', 'Ollama scanner provider request failed.');
    }
}

module.exports = {
    OllamaProvider
};
