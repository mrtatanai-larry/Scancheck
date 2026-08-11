const { GoogleGenAI } = require('@google/genai');
const { omrResultSchema, topFieldsResultSchema } = require('../schemas/omrResultSchema');
const { buildSectionPrompt, buildVerificationPrompt, buildTopFieldsPrompt } = require('../prompts');

class AiOmrProviderError extends Error {
    constructor(code, message, details = null) {
        super(message);
        this.name = 'AiOmrProviderError';
        this.code = code;
        this.details = details;
    }
}

function sanitizeProviderError(error) {
    const message = String(error?.message || error || '');
    if (/api key|apikey|permission|unauthenticated|invalid.*key/i.test(message)) {
        return new AiOmrProviderError('AI_OMR_AUTH_FAILED', 'AI scanner authentication failed.');
    }
    if (/quota|rate|resource_exhausted|429/i.test(message)) {
        return new AiOmrProviderError('AI_OMR_RATE_LIMITED', 'AI scanner quota or rate limit exceeded.');
    }
    if (/timeout|deadline|aborted/i.test(message)) {
        return new AiOmrProviderError('AI_OMR_TIMEOUT', 'AI scanner timed out.');
    }
    if (/unavailable|503|temporar/i.test(message)) {
        return new AiOmrProviderError('AI_OMR_PROVIDER_UNAVAILABLE', 'AI scanner provider unavailable.');
    }
    return new AiOmrProviderError('AI_OMR_PROVIDER_ERROR', 'AI scanner provider request failed.');
}

function isRetryableError(error) {
    const code = String(error?.code || '');
    return ['AI_OMR_RATE_LIMITED', 'AI_OMR_TIMEOUT', 'AI_OMR_PROVIDER_UNAVAILABLE'].includes(code);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs) {
    let timer = null;
    const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new AiOmrProviderError('AI_OMR_TIMEOUT', 'AI scanner timed out.')), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

function responseText(response) {
    if (typeof response?.text === 'string') return response.text;
    if (typeof response?.text === 'function') return response.text();
    const parts = response?.candidates?.[0]?.content?.parts || [];
    const text = parts.map((part) => part.text || '').join('');
    return text || '';
}

function responseDebug(response) {
    const text = responseText(response);
    const candidate = response?.candidates?.[0] || {};
    return {
        textPreview: String(text || '').slice(0, 1000),
        textLength: String(text || '').length,
        finishReason: candidate.finishReason || null,
        blockReason: response?.promptFeedback?.blockReason || null,
        partTypes: (candidate.content?.parts || []).map((part) => Object.keys(part).filter((key) => part[key] !== undefined))
    };
}

function parseStructuredJson(response) {
    const text = responseText(response).trim();
    if (!text) {
        throw new AiOmrProviderError('AI_OMR_EMPTY_RESPONSE', 'AI scanner returned an empty response.', responseDebug(response));
    }
    try {
        return JSON.parse(text);
    } catch (_error) {
        throw new AiOmrProviderError('AI_OMR_MALFORMED_RESPONSE', 'AI scanner returned malformed JSON.', responseDebug(response));
    }
}

function extractUsageMetadata(response) {
    const usage = response?.usageMetadata || response?.usage_metadata || {};
    const inputTokens = Number(usage.promptTokenCount ?? usage.prompt_token_count);
    const outputTokens = Number(usage.candidatesTokenCount ?? usage.candidates_token_count);
    const totalTokens = Number(usage.totalTokenCount ?? usage.total_token_count);
    return {
        inputTokens: Number.isFinite(inputTokens) ? inputTokens : null,
        outputTokens: Number.isFinite(outputTokens) ? outputTokens : null,
        totalTokens: Number.isFinite(totalTokens) ? totalTokens : null
    };
}

class GeminiProvider {
    constructor(config) {
        this.config = config;
        this.client = new GoogleGenAI({ apiKey: config.apiKey });
    }

    async generateOmrResult({ imageBuffer, mimeType, questions, subjects = [], questionMappings = [], verificationQuestion = null }) {
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
            contents: [
                {
                    role: 'user',
                    parts: [
                        {
                            inlineData: {
                                mimeType,
                                data: imageBuffer.toString('base64')
                            }
                        },
                        { text: prompt }
                    ]
                }
            ],
            config: {
                temperature: 0,
                topP: 0.1,
                candidateCount: 1,
                maxOutputTokens: Math.max(4096, (questions?.length || 1) * 220),
                responseMimeType: 'application/json',
                responseJsonSchema: omrResultSchema
            }
        };

        let lastError = null;
        const attempts = Math.max(1, Number(this.config.maxRetries || 0) + 1);
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            const startedAt = Date.now();
            try {
                const response = await withTimeout(
                    this.client.models.generateContent(request),
                    this.config.timeoutMs
                );
                return {
                    payload: parseStructuredJson(response),
                    latencyMs: Date.now() - startedAt,
                    attempts: attempt,
                    prompt,
                    usage: extractUsageMetadata(response)
                };
            } catch (error) {
                lastError = error instanceof AiOmrProviderError ? error : sanitizeProviderError(error);
                if (attempt >= attempts || !isRetryableError(lastError)) {
                    throw lastError;
                }
                await sleep(250 * attempt);
            }
        }
        throw lastError || new AiOmrProviderError('AI_OMR_PROVIDER_ERROR', 'AI scanner provider request failed.');
    }

    async generateTopFieldsResult({ imageBuffer, mimeType, fields = [] }) {
        const prompt = buildTopFieldsPrompt(fields, {
            instructionPrompt: this.config.instructionPrompt
        });

        const request = {
            model: this.config.model,
            contents: [
                {
                    role: 'user',
                    parts: [
                        {
                            inlineData: {
                                mimeType,
                                data: imageBuffer.toString('base64')
                            }
                        },
                        { text: prompt }
                    ]
                }
            ],
            config: {
                temperature: 0,
                topP: 0.1,
                candidateCount: 1,
                maxOutputTokens: 2048,
                responseMimeType: 'application/json',
                responseJsonSchema: topFieldsResultSchema
            }
        };

        let lastError = null;
        const attempts = Math.max(1, Number(this.config.maxRetries || 0) + 1);
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            const startedAt = Date.now();
            try {
                const response = await withTimeout(
                    this.client.models.generateContent(request),
                    this.config.timeoutMs
                );
                return {
                    payload: parseStructuredJson(response),
                    latencyMs: Date.now() - startedAt,
                    attempts: attempt,
                    prompt,
                    usage: extractUsageMetadata(response)
                };
            } catch (error) {
                lastError = error instanceof AiOmrProviderError ? error : sanitizeProviderError(error);
                if (attempt >= attempts || !isRetryableError(lastError)) {
                    throw lastError;
                }
                await sleep(250 * attempt);
            }
        }
        throw lastError || new AiOmrProviderError('AI_OMR_PROVIDER_ERROR', 'AI scanner provider request failed.');
    }

    async testConnection() {
        const startedAt = Date.now();
        try {
            const response = await withTimeout(
                this.client.models.generateContent({
                    model: this.config.model,
                    contents: [{ role: 'user', parts: [{ text: 'Return the single word OK.' }] }],
                    config: {
                        temperature: 0,
                        maxOutputTokens: 8
                    }
                }),
                this.config.timeoutMs
            );
            return {
                success: true,
                latencyMs: Date.now() - startedAt,
                usage: extractUsageMetadata(response)
            };
        } catch (error) {
            throw error instanceof AiOmrProviderError ? error : sanitizeProviderError(error);
        }
    }
}

module.exports = {
    GeminiProvider,
    AiOmrProviderError,
    sanitizeProviderError
};
