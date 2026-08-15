const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const Jimp = require('jimp');

const DATA_URL_RE = /^data:([A-Za-z0-9.+/-]+);base64,(.+)$/;

function parseImageInput(input) {
    if (Buffer.isBuffer(input)) {
        return { buffer: input, mimeType: 'image/jpeg', source: 'buffer' };
    }

    const value = String(input || '').trim();
    if (!value) {
        throw new Error('Image data is required');
    }

    const match = value.match(DATA_URL_RE);
    if (!match) {
        throw new Error('Image data must be a base64 data URL');
    }

    return {
        buffer: Buffer.from(match[2], 'base64'),
        mimeType: match[1],
        source: 'data_url'
    };
}

async function loadImage(imageBuffer) {
    if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
        throw new Error('Invalid image buffer');
    }
    return Jimp.read(imageBuffer);
}

function hashImage(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function clampRect(rect, width, height) {
    const x = Math.max(0, Math.min(width - 1, Math.floor(rect.x)));
    const y = Math.max(0, Math.min(height - 1, Math.floor(rect.y)));
    const right = Math.max(x + 1, Math.min(width, Math.ceil(rect.x + rect.width)));
    const bottom = Math.max(y + 1, Math.min(height, Math.ceil(rect.y + rect.height)));
    return { x, y, width: right - x, height: bottom - y };
}

async function cropToJpeg(image, rect, options = {}) {
    const crop = clampRect(rect, image.bitmap.width, image.bitmap.height);
    const clone = image.clone().crop(crop.x, crop.y, crop.width, crop.height);
    const maxWidth = Number(options.maxWidth) || 1800;
    if (clone.bitmap.width > maxWidth) {
        clone.resize(maxWidth, Jimp.AUTO);
    }
    const quality = Number(options.quality) || 88;
    const buffer = await clone.quality(Math.max(1, Math.min(100, quality))).getBufferAsync(Jimp.MIME_JPEG);
    return {
        buffer,
        mimeType: Jimp.MIME_JPEG,
        crop,
        width: clone.bitmap.width,
        height: clone.bitmap.height
    };
}

async function imageToJpeg(image, options = {}) {
    const maxWidth = Number(options.maxWidth) || 2200;
    const clone = image.clone();
    if (clone.bitmap.width > maxWidth) {
        clone.resize(maxWidth, Jimp.AUTO);
    }
    const quality = Number(options.quality) || 88;
    const buffer = await clone.quality(Math.max(1, Math.min(100, quality))).getBufferAsync(Jimp.MIME_JPEG);
    return {
        buffer,
        mimeType: Jimp.MIME_JPEG,
        crop: { x: 0, y: 0, width: image.bitmap.width, height: image.bitmap.height },
        width: clone.bitmap.width,
        height: clone.bitmap.height
    };
}

function getPythonCommand(runtimePaths = {}) {
    if (process.env.SCANCHECK_PYTHON && isUsablePythonCommand(process.env.SCANCHECK_PYTHON)) {
        return process.env.SCANCHECK_PYTHON;
    }

    const repoRoot = runtimePaths.repoRoot || process.cwd();
    const localCandidates = [
        path.join(repoRoot, '.venv', 'bin', 'python'),
        path.join(repoRoot, '.venv', 'Scripts', 'python.exe')
    ];
    for (const candidate of localCandidates) {
        if (isUsablePythonCommand(candidate)) return candidate;
    }
    return process.platform === 'win32' ? 'python' : 'python3';
}

function isUsablePythonCommand(commandPath) {
    if (!commandPath) return false;

    if (!path.isAbsolute(commandPath)) {
        return true;
    }

    try {
        fs.accessSync(commandPath, fs.constants.F_OK | fs.constants.X_OK);
        return true;
    } catch (_error) {
        return false;
    }
}

function preparePageImage(imageBuffer, layout = {}, runtimePaths = {}) {
    const sheetWidth = Math.round(Number(layout.sheetSize?.width) || Number(layout.sheet_size?.width) || 0);
    const sheetHeight = Math.round(Number(layout.sheetSize?.height) || Number(layout.sheet_size?.height) || 0);
    if (!sheetWidth || !sheetHeight) {
        return Promise.resolve({
            buffer: imageBuffer,
            mimeType: 'image/jpeg',
            mode: 'original_no_sheet_size',
            usedWorker: false
        });
    }

    const workerPath = path.join(__dirname, 'pagePrepWorker.py');
    const anchors = layout.registrationAnchors || layout.registration_anchors || {};
    const anchorArg = JSON.stringify(anchors);
    return new Promise((resolve) => {
        const child = spawn(getPythonCommand(runtimePaths), [workerPath, String(sheetWidth), String(sheetHeight), anchorArg], {
            cwd: runtimePaths.repoRoot || process.cwd(),
            stdio: ['pipe', 'pipe', 'pipe']
        });

        const stdout = [];
        let stderr = '';
        child.stdout.on('data', (chunk) => stdout.push(chunk));
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        child.on('error', () => {
            resolve({ buffer: imageBuffer, mimeType: 'image/jpeg', mode: 'original_page_prep_error', usedWorker: false });
        });
        child.stdin.on('error', () => {
            // The worker may exit early if OpenCV is unavailable or the image is invalid.
        });
        child.on('close', (code) => {
            if (code !== 0 || stdout.length === 0) {
                resolve({ buffer: imageBuffer, mimeType: 'image/jpeg', mode: 'original_page_prep_failed', usedWorker: false });
                return;
            }
            let metadata = {};
            try {
                metadata = JSON.parse(stderr.trim().split('\n').filter(Boolean).pop() || '{}');
            } catch (_error) {
                metadata = {};
            }
            resolve({
                buffer: Buffer.concat(stdout),
                mimeType: Jimp.MIME_JPEG,
                mode: metadata.mode || 'document_quad',
                quad: metadata.quad || null,
                anchorRefinement: metadata.anchorRefinement || null,
                width: metadata.width || sheetWidth,
                height: metadata.height || sheetHeight,
                usedWorker: true
            });
        });
        child.stdin.end(imageBuffer);
    });
}

module.exports = {
    parseImageInput,
    loadImage,
    hashImage,
    cropToJpeg,
    imageToJpeg,
    preparePageImage
};
