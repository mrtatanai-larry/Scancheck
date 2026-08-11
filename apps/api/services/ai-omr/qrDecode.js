const Jimp = require('jimp');
const jsQR = require('jsqr');

function parseQrPayload(text) {
    const raw = String(text || '').trim();
    if (!raw) return {};
    let decoded = raw;
    try {
        decoded = decodeURIComponent(raw);
    } catch (_err) {
        decoded = raw;
    }
    if (decoded !== raw) {
        try {
            const parsed = JSON.parse(decoded);
            if (parsed && typeof parsed === 'object') return parsed;
        } catch (_err) {
            // fall through to query-style parsing below
        }
    }
    try {
        const parsed = JSON.parse(decoded);
        return parsed && typeof parsed === 'object' ? parsed : { raw: decoded };
    } catch (_err) {
        const params = new URLSearchParams(decoded.includes('?') ? decoded.split('?').pop() : decoded);
        const data = { raw: decoded };
        for (const [key, value] of params.entries()) {
            data[key] = value;
        }
        return data;
    }
}

function decodeQrFromJimpImage(image, status) {
    const bitmap = image.bitmap;
    const rgba = new Uint8ClampedArray(
        bitmap.data.buffer,
        bitmap.data.byteOffset,
        bitmap.data.byteLength
    );
    const code = jsQR(rgba, bitmap.width, bitmap.height, { inversionAttempts: 'attemptBoth' });
    if (!code?.data) return null;
    return {
        success: true,
        status,
        text: code.data,
        barcodeData: parseQrPayload(code.data),
        location: code.location || null
    };
}

function safeCrop(image, x, y, width, height) {
    const cropX = Math.max(0, Math.round(x));
    const cropY = Math.max(0, Math.round(y));
    const cropW = Math.max(1, Math.min(Math.round(width), image.bitmap.width - cropX));
    const cropH = Math.max(1, Math.min(Math.round(height), image.bitmap.height - cropY));
    if (cropW <= 1 || cropH <= 1) return null;
    return image.clone().crop(cropX, cropY, cropW, cropH);
}

function buildQrDecodeCandidates(image) {
    const width = image.bitmap.width;
    const height = image.bitmap.height;
    const candidates = [
        { status: 'qr_success', create: () => image },
        { status: 'qr_success_enhanced', create: () => image.clone().greyscale().contrast(0.35).normalize() }
    ];

    for (const [label, cropConfig] of [
        ['top_right_wide', [width * 0.52, 0, width * 0.46, height * 0.36]],
        ['top_right_tight', [width * 0.60, height * 0.04, width * 0.36, height * 0.28]],
        ['upper_half', [0, 0, width, height * 0.46]]
    ]) {
        const cropFactory = () => safeCrop(image, ...cropConfig);
        candidates.push({ status: `qr_success_${label}`, create: cropFactory });
        candidates.push({
            status: `qr_success_${label}_enhanced`,
            create: () => {
                const crop = cropFactory();
                return crop ? crop.greyscale().contrast(0.45).normalize() : null;
            }
        });
        candidates.push({
            status: `qr_success_${label}_scaled`,
            create: () => {
                const crop = cropFactory();
                if (!crop) return null;
                const scale = Math.min(3, Math.max(1.5, 1200 / Math.max(crop.bitmap.width, crop.bitmap.height)));
                return crop
                    .resize(Math.round(crop.bitmap.width * scale), Jimp.AUTO)
                    .greyscale()
                    .contrast(0.45)
                    .normalize();
            }
        });
    }

    return candidates;
}

async function decodeQrFromImage(imageBuffer) {
    const image = await Jimp.read(imageBuffer);
    const candidates = buildQrDecodeCandidates(image);
    const attempts = [];
    for (const candidate of candidates) {
        attempts.push(candidate.status);
        const candidateImage = candidate.create();
        if (!candidateImage) continue;
        const decoded = decodeQrFromJimpImage(candidateImage, candidate.status);
        if (decoded) {
            return {
                ...decoded,
                attempts
            };
        }
    }
    return { success: false, status: 'qr_not_found', barcodeData: null };
}

function layoutIdFromQrData(data = {}) {
    return data.examId
        || data.exam_id
        || data.layoutId
        || data.layout_id
        || data.quizId
        || data.quiz_id
        || null;
}

module.exports = {
    decodeQrFromImage,
    layoutIdFromQrData
};
