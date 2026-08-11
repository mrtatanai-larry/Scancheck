#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const runtimePaths = require('../config/paths');
const { runAiOmrBenchmark, identifyLayout } = require('../services/ai-omr/aiOmrService');

function argValue(name) {
    const index = process.argv.indexOf(name);
    if (index === -1 || index + 1 >= process.argv.length) return null;
    return process.argv[index + 1];
}

function readGroundTruth(filePath) {
    if (!filePath) return null;
    const parsed = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
    if (Array.isArray(parsed)) return parsed;
    return parsed.answers || parsed.groundTruthAnswers || parsed.ground_truth_answers || null;
}

async function main() {
    const imagePath = argValue('--image');
    if (!imagePath) {
        throw new Error('Usage: node apps/api/scripts/benchmark-ai-omr.js --image path/to/sheet.jpg [--layout-id EX...] [--ground-truth answers.json] [--repeat 3]');
    }

    const imageBuffer = fs.readFileSync(path.resolve(imagePath));
    const suppliedLayoutId = argValue('--layout-id');
    const identity = await identifyLayout({ imageBuffer, suppliedLayoutId });
    if (!identity.layoutId) {
        throw new Error('Layout identification failed. Supply --layout-id or use an image with a readable QR code.');
    }

    const layoutPath = path.join(runtimePaths.omrLayoutsDir, `${identity.layoutId}.json`);
    if (!fs.existsSync(layoutPath)) {
        throw new Error(`Layout not found: ${layoutPath}`);
    }

    const result = await runAiOmrBenchmark({
        imageBuffer,
        mimeType: imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg',
        layoutId: identity.layoutId,
        layout: JSON.parse(fs.readFileSync(layoutPath, 'utf8')),
        groundTruthAnswers: readGroundTruth(argValue('--ground-truth')),
        repeat: Number(argValue('--repeat')) || 3,
        runtimePaths
    });

    const summary = result.runs.map((run) => ({
        requestId: run.requestId,
        strategy: run.strategy,
        status: run.status,
        apiCallCount: run.metrics.apiCallCount,
        latencyMs: run.metrics.latencyMs,
        selected: run.metrics.stateCounts.selected,
        blank: run.metrics.stateCounts.blank,
        multiple: run.metrics.stateCounts.multiple,
        uncertain: run.metrics.stateCounts.uncertain,
        accuracy: run.benchmark?.exactQuestionAccuracy ?? null,
        correct: run.benchmark?.correctAnswerRecognition ?? null,
        wrong: run.benchmark?.wrongAnswerRecognition ?? null,
        falseBlanks: run.benchmark?.falseBlanks ?? null,
        falseMultiples: run.benchmark?.falseMultiples ?? null
    }));

    console.log(JSON.stringify({ success: true, layoutId: identity.layoutId, summary }, null, 2));
}

main().catch((error) => {
    console.error(JSON.stringify({
        success: false,
        error: error.message,
        code: error.code || 'AI_OMR_BENCHMARK_FAILED'
    }, null, 2));
    process.exit(1);
});
